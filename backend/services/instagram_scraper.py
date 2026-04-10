"""
Bulk import service — logs into Instagram, scrapes saved posts/collections,
filters for video reels, and runs each through the recipe extraction pipeline.

Progress is tracked in a simple in-memory store (single-user app).
"""
import asyncio
import os
import time
import tempfile
import shutil
from pathlib import Path
from typing import Optional
from datetime import datetime

import instaloader
from sqlalchemy.orm import Session

from config import settings
from models import Recipe, Ingredient, RecipeIngredient
from services.recipe_extractor import extract_recipe_from_reel, NoRecipeFoundError
from services.video_processor import transcribe_audio

# ── In-memory job tracker ──────────────────────────────────────────────────

_current_job: dict = {
    "status": "idle",       # idle | running | awaiting_2fa | done | error
    "total": 0,
    "processed": 0,
    "imported": 0,
    "skipped": 0,
    "failed": 0,
    "current": "",
    "log": [],
    "started_at": None,
    "finished_at": None,
}

# 2FA state — holds the pending loader and an asyncio Event to resume the task
_2fa_event: Optional[asyncio.Event] = None
_2fa_code: Optional[str] = None
_2fa_loader: Optional[object] = None  # instaloader.Instaloader instance


def get_job_status() -> dict:
    return dict(_current_job)


async def submit_2fa_code(code: str):
    """Called by the router when the user submits their authenticator code."""
    global _2fa_code, _2fa_event
    if _current_job["status"] != "awaiting_2fa" or _2fa_event is None:
        raise ValueError("No 2FA login is pending")
    _2fa_code = code.strip()
    _2fa_event.set()


def _reset_job(total: int):
    _current_job.update({
        "status": "running",
        "total": total,
        "processed": 0,
        "imported": 0,
        "skipped": 0,
        "failed": 0,
        "current": "",
        "log": [],
        "started_at": datetime.utcnow().isoformat(),
        "finished_at": None,
    })


def _log(msg: str):
    _current_job["log"].append(f"[{datetime.utcnow().strftime('%H:%M:%S')}] {msg}")
    # Keep last 200 log lines
    if len(_current_job["log"]) > 200:
        _current_job["log"] = _current_job["log"][-200:]


# ── Instaloader helpers ────────────────────────────────────────────────────

def _make_loader(session_file: Optional[str] = None) -> instaloader.Instaloader:
    return instaloader.Instaloader(
        download_videos=True,
        download_video_thumbnails=True,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        compress_json=False,
        quiet=True,
        dirname_pattern="/tmp/insta/{shortcode}",
    )


def _login_attempt(username: str, password: str):
    """
    Attempt login. Returns (loader, needs_2fa).
    The loader is always returned so its 2FA session state is preserved.
    """
    loader = _make_loader()
    try:
        loader.login(username, password)
        return loader, False
    except instaloader.exceptions.TwoFactorAuthRequiredException:
        # Return the loader — it holds the half-authenticated context needed
        # to complete 2FA. Do NOT create a new loader for two_factor_login.
        return loader, True


def _get_saved_posts(loader: instaloader.Instaloader):
    """Yield all saved posts. Requires login."""
    yield from loader.get_saved_posts()


def _get_collection_posts(loader: instaloader.Instaloader, username: str, collection_url: str):
    """
    Yield posts from a specific saved collection.
    URL format: https://www.instagram.com/{username}/saved/{collection-name}/
    Matches the collection by slugified name.
    """
    import re
    match = re.search(r'/saved/([^/?#]+)/?', collection_url)
    if not match:
        raise ValueError(f"Cannot parse collection name from URL: {collection_url}")

    collection_slug = match.group(1).lower().replace('-', ' ').replace('_', ' ')

    profile = instaloader.Profile.from_username(loader.context, username)

    if not hasattr(profile, 'get_saved_collections'):
        raise ValueError(
            "This instaloader version does not support named collections. "
            "Run: pip install -U instaloader"
        )

    for collection in profile.get_saved_collections():
        coll_name = collection.name.lower().replace('-', ' ').replace('_', ' ')
        if coll_name == collection_slug:
            yield from collection.get_posts()
            return

    raise ValueError(
        f"Collection '{match.group(1)}' not found in your saved collections. "
        "Check that the URL matches an existing collection name."
    )


def _is_video_post(post: instaloader.Post) -> bool:
    return post.is_video or post.typename in ("GraphVideo", "XDTGraphVideo")


def _already_imported(source_url: str, db: Session) -> bool:
    return db.query(Recipe).filter(Recipe.source_url == source_url).first() is not None


# ── Main bulk import pipeline ──────────────────────────────────────────────

async def run_bulk_import(
    username: str,
    password: str,
    db: Session,
    collection_url: Optional[str] = None,
    limit: Optional[int] = None,
):
    """
    Full bulk import pipeline. Runs as a background async task.
    Logs progress to _current_job.
    """
    if _current_job["status"] == "running":
        return  # Already running

    # Mark running immediately so the UI reflects it before login completes
    _current_job.update({
        "status": "running",
        "total": 0,
        "processed": 0,
        "imported": 0,
        "skipped": 0,
        "failed": 0,
        "current": "",
        "log": [],
        "started_at": datetime.utcnow().isoformat(),
        "finished_at": None,
    })

    loop = asyncio.get_running_loop()

    try:
        _log("Logging into Instagram…")

        # Login in thread executor (instaloader is sync)
        loader, needs_2fa = await loop.run_in_executor(None, _login_attempt, username, password)

        if needs_2fa:
            global _2fa_event, _2fa_code
            verified = False
            attempts = 0

            while not verified:
                attempts += 1
                _2fa_event = asyncio.Event()
                _2fa_code = None
                _current_job["status"] = "awaiting_2fa"
                if attempts == 1:
                    _log("📱 Two-factor authentication required — enter the 6-digit code sent to your phone.")
                else:
                    _log(f"📱 Incorrect code — try again (attempt {attempts}).")

                # Wait for user to submit code (5-minute timeout per attempt)
                try:
                    await asyncio.wait_for(_2fa_event.wait(), timeout=300)
                except asyncio.TimeoutError:
                    _current_job["status"] = "error"
                    _current_job["finished_at"] = datetime.utcnow().isoformat()
                    _log("❌ Timed out waiting for 2FA code (5 minutes)")
                    return

                # Try to verify the code
                try:
                    await loop.run_in_executor(None, loader.two_factor_login, _2fa_code)
                except Exception as e:
                    # Instaloader sometimes throws on response parsing even after
                    # a successful login — check is_logged_in to be sure
                    if loader.context.is_logged_in:
                        _log(f"⚠️ Minor error during 2FA response ({str(e)[:60]}) but login confirmed.")
                    else:
                        _log(f"❌ Code rejected: {str(e)[:80]} — request a new SMS code and try again.")
                        if attempts >= 3:
                            _current_job["status"] = "error"
                            _current_job["finished_at"] = datetime.utcnow().isoformat()
                            _log("❌ Too many failed attempts — please restart the import.")
                            return
                        continue  # loop back to awaiting_2fa

                verified = True

            _current_job["status"] = "running"
            _log("✅ 2FA verified — login successful")
        else:
            _log("✅ Login successful")

        # Gather posts first so we know the total
        if collection_url:
            _log(f"Fetching posts from collection: {collection_url}")
        else:
            _log("Fetching saved posts list… (this may take a moment)")

        def _collect_posts():
            posts = []
            if collection_url:
                post_iter = _get_collection_posts(loader, username, collection_url)
            else:
                post_iter = _get_saved_posts(loader)
            for post in post_iter:
                if _is_video_post(post):
                    posts.append(post)
                if limit and len(posts) >= limit:
                    break
                time.sleep(0.3)  # gentle rate limiting
            return posts

        posts = await loop.run_in_executor(None, _collect_posts)

        _reset_job(len(posts))
        _log(f"Found {len(posts)} video post(s) to process")

        if not posts:
            _current_job["status"] = "done"
            _current_job["finished_at"] = datetime.utcnow().isoformat()
            _log("No video posts found in saved items.")
            return

        for post in posts:
            shortcode = post.shortcode
            source_url = f"https://www.instagram.com/p/{shortcode}/"
            _current_job["current"] = post.title or shortcode

            # Skip already imported
            if _already_imported(source_url, db):
                _log(f"😋  Looks like you were so hungry you wanted it twice! {shortcode} is already in your library.")
                _current_job["skipped"] += 1
                _current_job["processed"] += 1
                continue

            _log(f"⬇️  Downloading: {shortcode}")

            try:
                # Download video + thumbnail to temp dir
                tmp_dir = tempfile.mkdtemp(dir=settings.upload_dir)

                def _download_post():
                    loader.dirname_pattern = tmp_dir + "/{shortcode}"
                    loader.download_post(post, target=Path(tmp_dir))

                await loop.run_in_executor(None, _download_post)

                # Find the video and thumbnail files
                video_path = None
                thumbnail_path = None
                audio_path = os.path.join(tmp_dir, f"{shortcode}_audio.mp3")

                for f in Path(tmp_dir).rglob("*"):
                    if f.suffix in (".mp4", ".webm") and video_path is None:
                        video_path = str(f)
                    if f.suffix in (".jpg", ".jpeg", ".png") and thumbnail_path is None:
                        thumbnail_path = str(f)

                if not video_path:
                    _log(f"⚠️  No video file found for {shortcode}, skipping")
                    _current_job["skipped"] += 1
                    _current_job["processed"] += 1
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                    continue

                # Extract audio with ffmpeg via yt-dlp approach
                _log(f"🎙  Transcribing: {shortcode}")
                import subprocess
                subprocess.run(
                    ["ffmpeg", "-i", video_path, "-vn", "-ar", "16000",
                     "-ac", "1", "-q:a", "0", audio_path, "-y"],
                    capture_output=True,
                    timeout=120,
                )

                transcript = await transcribe_audio(audio_path) if os.path.exists(audio_path) else None
                caption = post.caption or ""
                title = caption[:80] if caption else f"Instagram Reel {shortcode}"

                _log(f"🤖  Extracting recipe: {shortcode}")
                try:
                    recipe_data = await extract_recipe_from_reel(
                        title=title,
                        transcript=transcript,
                        description=caption,
                    )
                except NoRecipeFoundError:
                    _log(f"🚫  No recipe could be found for this reel \"{title}\". Skipping.")
                    _current_job["skipped"] += 1
                    _current_job["processed"] += 1
                    shutil.rmtree(tmp_dir, ignore_errors=True)
                    continue

                # Copy thumbnail to permanent storage
                thumb_url = None
                if thumbnail_path and os.path.exists(thumbnail_path):
                    thumb_dir = os.path.join(settings.upload_dir, "thumbnails")
                    os.makedirs(thumb_dir, exist_ok=True)
                    thumb_filename = f"{shortcode}{Path(thumbnail_path).suffix}"
                    shutil.copy2(thumbnail_path, os.path.join(thumb_dir, thumb_filename))
                    thumb_url = f"/uploads/thumbnails/{thumb_filename}"

                # Persist recipe
                recipe = Recipe(
                    title=recipe_data["title"],
                    description=recipe_data.get("description"),
                    source_url=source_url,
                    source_type="instagram_reel",
                    thumbnail_url=thumb_url,
                    transcript=transcript,
                    servings=recipe_data.get("servings", 2),
                    prep_time_minutes=recipe_data.get("prep_time_minutes"),
                    cook_time_minutes=recipe_data.get("cook_time_minutes"),
                    cuisine=recipe_data.get("cuisine"),
                    meal_type=recipe_data.get("meal_type"),
                    tags=recipe_data.get("tags", []),
                    steps=recipe_data.get("steps", []),
                    calories=recipe_data.get("macros_per_serving", {}).get("calories"),
                    protein_g=recipe_data.get("macros_per_serving", {}).get("protein_g"),
                    carbs_g=recipe_data.get("macros_per_serving", {}).get("carbs_g"),
                    fat_g=recipe_data.get("macros_per_serving", {}).get("fat_g"),
                )
                db.add(recipe)
                db.flush()

                for ing_data in recipe_data.get("ingredients", []):
                    name = ing_data["name"].lower().strip()
                    ingredient = db.query(Ingredient).filter(Ingredient.name == name).first()
                    if not ingredient:
                        ingredient = Ingredient(name=name, category=ing_data.get("category", "other"))
                        db.add(ingredient)
                        db.flush()
                    ri = RecipeIngredient(
                        recipe_id=recipe.id,
                        ingredient_id=ingredient.id,
                        quantity=ing_data.get("quantity"),
                        unit=ing_data.get("unit"),
                        notes=ing_data.get("notes"),
                        raw_text=ing_data.get("raw_text"),
                    )
                    db.add(ri)

                db.commit()
                _log(f"✅  Imported: {recipe_data['title']}")
                _current_job["imported"] += 1

            except Exception as e:
                db.rollback()
                _log(f"❌  Failed {shortcode}: {str(e)[:120]}")
                _current_job["failed"] += 1
            finally:
                shutil.rmtree(tmp_dir, ignore_errors=True)
                _current_job["processed"] += 1
                # Polite delay between posts
                await asyncio.sleep(2)

        _current_job["status"] = "done"
        _current_job["finished_at"] = datetime.utcnow().isoformat()
        _current_job["current"] = ""
        _log(
            f"🎉 Complete — {_current_job['imported']} imported, "
            f"{_current_job['skipped']} skipped, {_current_job['failed']} failed"
        )

    except instaloader.exceptions.BadCredentialsException:
        _current_job["status"] = "error"
        _current_job["finished_at"] = datetime.utcnow().isoformat()
        _log("❌ Login failed — check your Instagram username and password")
    except Exception as e:
        _current_job["status"] = "error"
        _current_job["finished_at"] = datetime.utcnow().isoformat()
        _log(f"❌ Unexpected error: {str(e)}")
