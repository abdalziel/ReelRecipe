"""
Federated public recipe library stored as JSON in a GitHub repository.

Storage layout (ReelRecipe-Public repo):
  recipes.json  →  {"recipes": [...], "updated_at": "..."}

Reads are cached in memory (5-minute TTL) to avoid hammering the GitHub API.
Writes (publish) require GITHUB_TOKEN in .env with repo scope.
Duplicate detection against the public library is silent — no error raised.
"""
import base64
import difflib
import hashlib
import json
import re
import time
from datetime import datetime, timezone
from typing import Optional

import httpx

from config import settings

_GITHUB_API = "https://api.github.com"
_REPO = getattr(settings, "github_public_repo", "abdalziel/ReelRecipe-Public")
_FILE = "recipes.json"

# In-memory cache
_cache: dict = {"recipes": None, "sha": "", "fetched_at": 0.0}
_CACHE_TTL = 300  # seconds


# ── Helpers ────────────────────────────────────────────────────────────────

def _norm(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[^\w\s]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def _auth_headers() -> dict:
    h = {"Accept": "application/vnd.github.v3+json", "X-GitHub-Api-Version": "2022-11-28"}
    token = getattr(settings, "github_token", None)
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _find_public_duplicate(title: str, ingredient_names: list, recipes: list) -> Optional[dict]:
    norm_title = _norm(title)
    new_ings = {_norm(n) for n in ingredient_names if n.strip()}

    for recipe in recipes:
        title_sim = difflib.SequenceMatcher(
            None, norm_title, _norm(recipe.get("title", ""))
        ).ratio()
        if title_sim >= 0.82:
            return recipe
        if title_sim >= 0.50 and new_ings:
            existing_ings = {_norm(i.get("name", "")) for i in recipe.get("ingredients", [])}
            if existing_ings:
                overlap = len(new_ings & existing_ings) / max(len(new_ings), len(existing_ings))
                if overlap >= 0.60:
                    return recipe
    return None


# ── GitHub I/O ─────────────────────────────────────────────────────────────

async def _fetch_from_github() -> tuple[list, str]:
    """Returns (recipes_list, file_sha). Returns empty list on 404."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{_GITHUB_API}/repos/{_REPO}/contents/{_FILE}",
            headers=_auth_headers(),
        )
        if r.status_code == 404:
            return [], ""
        r.raise_for_status()
        data = r.json()
        content = base64.b64decode(data["content"]).decode("utf-8")
        parsed = json.loads(content)
        return parsed.get("recipes", []), data.get("sha", "")


async def _write_to_github(recipes: list, sha: str, commit_msg: str) -> None:
    payload = json.dumps(
        {"recipes": recipes, "updated_at": datetime.now(timezone.utc).isoformat()},
        indent=2,
    )
    encoded = base64.b64encode(payload.encode()).decode()
    body: dict = {"message": commit_msg, "content": encoded}
    if sha:
        body["sha"] = sha

    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.put(
            f"{_GITHUB_API}/repos/{_REPO}/contents/{_FILE}",
            headers=_auth_headers(),
            json=body,
        )
        r.raise_for_status()


# ── Public API ─────────────────────────────────────────────────────────────

async def get_all(force: bool = False) -> list:
    """Return cached public recipe list, refreshing from GitHub if stale."""
    now = time.time()
    if not force and _cache["recipes"] is not None and (now - _cache["fetched_at"]) < _CACHE_TTL:
        return _cache["recipes"]
    try:
        recipes, sha = await _fetch_from_github()
        _cache["recipes"] = recipes
        _cache["sha"] = sha
        _cache["fetched_at"] = now
    except Exception:
        pass  # Return stale cache on error rather than crashing
    return _cache["recipes"] or []


async def search(q: str = "", meal_type: str = "", limit: int = 80) -> list:
    all_recipes = await get_all()
    q_lower = q.lower().strip()
    results = []
    for r in all_recipes:
        if meal_type and r.get("meal_type") != meal_type:
            continue
        if q_lower:
            haystack = (
                r.get("title", "") + " " +
                r.get("cuisine", "") + " " +
                " ".join(r.get("tags", []))
            ).lower()
            if q_lower not in haystack:
                continue
        results.append(r)
    return results[:limit]


async def get_by_id(pub_id: str) -> Optional[dict]:
    all_recipes = await get_all()
    return next((r for r in all_recipes if r.get("id") == pub_id), None)


async def publish(recipe_data: dict) -> bool:
    """
    Add a recipe to the public library.
    Returns True if published, False if silently skipped (duplicate or no token).
    Never raises — failures are swallowed so they don't affect the user's import.
    """
    token = getattr(settings, "github_token", None)
    if not token:
        return False

    try:
        existing, sha = await _fetch_from_github()

        # Deduplicate against public library — silent skip
        ing_names = [i.get("name", "") for i in recipe_data.get("ingredients", [])]
        if _find_public_duplicate(recipe_data.get("title", ""), ing_names, existing):
            return False

        # Build minimal public record (no source URLs, no personal identifiers)
        title = recipe_data.get("title", "")
        pub_id = hashlib.md5(title.lower().encode()).hexdigest()[:12]

        record = {
            "id": pub_id,
            "title": title,
            "description": recipe_data.get("description"),
            "cuisine": recipe_data.get("cuisine"),
            "meal_type": recipe_data.get("meal_type"),
            "tags": recipe_data.get("tags", []),
            "thumbnail_url": recipe_data.get("thumbnail_url"),
            "servings": recipe_data.get("servings"),
            "prep_time_minutes": recipe_data.get("prep_time_minutes"),
            "cook_time_minutes": recipe_data.get("cook_time_minutes"),
            "calories": recipe_data.get("calories"),
            "protein_g": recipe_data.get("protein_g"),
            "carbs_g": recipe_data.get("carbs_g"),
            "fat_g": recipe_data.get("fat_g"),
            "ingredients": recipe_data.get("ingredients", []),
            "steps": recipe_data.get("steps", []),
            "added_at": datetime.now(timezone.utc).isoformat(),
        }

        existing.append(record)
        await _write_to_github(existing, sha, f"Add recipe: {title}")
        _cache["recipes"] = None  # Invalidate cache
        return True

    except Exception:
        return False  # Silent failure — never block user's import
