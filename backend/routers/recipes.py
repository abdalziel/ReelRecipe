import os
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy.orm import Session

from config import settings
from database import get_db
from models import Recipe, Ingredient, RecipeIngredient, RecipeRating
from services.auth import Scope, get_scope, get_recipe_or_404, require_user
from services import r2_storage

_ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic"}
_MAX_IMAGE_BYTES = 20 * 1024 * 1024

router = APIRouter(prefix="/api/recipes", tags=["recipes"])


@router.get("")
def list_recipes(
    meal_type: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    scope: Scope = Depends(get_scope),
    db: Session = Depends(get_db),
):
    q = scope.filter_recipes(db.query(Recipe))
    if meal_type:
        q = q.filter(Recipe.meal_type == meal_type)
    if search:
        q = q.filter(Recipe.title.ilike(f"%{search}%"))
    recipes = q.order_by(Recipe.created_at.desc()).all()
    ratings = _get_user_ratings(scope, db)
    return [_serialize_recipe(r, ratings.get(r.id)) for r in recipes]


@router.get("/{recipe_id}")
def get_recipe(
    recipe_id: int,
    scope: Scope = Depends(get_scope),
    db: Session = Depends(get_db),
):
    r = get_recipe_or_404(recipe_id, scope, db)
    ratings = _get_user_ratings(scope, db)
    return _serialize_recipe(r, ratings.get(r.id))


class RecipeUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    servings: Optional[int] = None
    meal_type: Optional[str] = None
    tags: Optional[List[str]] = None
    steps: Optional[List[str]] = None
    prep_time_minutes: Optional[int] = None
    cook_time_minutes: Optional[int] = None
    calories: Optional[float] = None
    protein_g: Optional[float] = None
    carbs_g: Optional[float] = None
    fat_g: Optional[float] = None


@router.patch("/{recipe_id}")
def update_recipe(
    recipe_id: int,
    update: RecipeUpdate,
    scope: Scope = Depends(get_scope),
    db: Session = Depends(get_db),
):
    recipe = get_recipe_or_404(recipe_id, scope, db)
    for field, value in update.model_dump(exclude_none=True).items():
        setattr(recipe, field, value)
    db.commit()
    db.refresh(recipe)
    ratings = _get_user_ratings(scope, db)
    return _serialize_recipe(recipe, ratings.get(recipe.id))


@router.patch("/{recipe_id}/thumbnail")
async def update_thumbnail(
    recipe_id: int,
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None),
    scope: Scope = Depends(get_scope),
    db: Session = Depends(get_db),
):
    """Replace the cover photo. Accepts either a file upload or a URL."""
    recipe = get_recipe_or_404(recipe_id, scope, db)

    if file and file.filename:
        content_type = (file.content_type or "").lower()
        if content_type not in _ALLOWED_IMAGE_TYPES:
            raise HTTPException(status_code=400, detail=f"Unsupported file type '{content_type}'.")
        data = await file.read()
        if len(data) > _MAX_IMAGE_BYTES:
            raise HTTPException(status_code=400, detail="Image must be under 20 MB.")

        ext = os.path.splitext(file.filename)[1] or ".jpg"
        filename = f"recipe_{recipe_id}_cover{ext}"

        thumb_url = await r2_storage.upload_bytes(data, filename, content_type or "image/jpeg")
        if not thumb_url:
            thumb_dir = os.path.join(settings.upload_dir, "thumbnails")
            os.makedirs(thumb_dir, exist_ok=True)
            dest = os.path.join(thumb_dir, filename)
            with open(dest, "wb") as f_out:
                f_out.write(data)
            thumb_url = f"/uploads/thumbnails/{filename}"

        recipe.thumbnail_url = thumb_url

    elif url:
        # If this is a local preview path (from thumbnail/from-reel), upload to R2
        if url.startswith("/uploads/"):
            rel = url[len("/uploads/"):]
            local_path = os.path.join(settings.upload_dir, rel)
            if os.path.exists(local_path):
                r2_url = await r2_storage.upload_local_file(local_path)
                url = r2_url or url
        recipe.thumbnail_url = url

    else:
        raise HTTPException(status_code=400, detail="Provide either a file or a URL.")

    db.commit()
    db.refresh(recipe)
    return {"thumbnail_url": recipe.thumbnail_url}


@router.post("/{recipe_id}/thumbnail/from-reel")
async def thumbnail_from_reel(
    recipe_id: int,
    scope: Scope = Depends(get_scope),
    db: Session = Depends(get_db),
):
    """
    Download the reel at lowest quality, extract frames at 45% and 95% duration,
    and return preview URLs. The caller confirms which frame to keep.
    """
    import asyncio, tempfile, subprocess, yt_dlp
    from pathlib import Path

    recipe = get_recipe_or_404(recipe_id, scope, db)
    if not recipe.source_url:
        raise HTTPException(status_code=422, detail="No source URL for this recipe.")

    thumb_dir = os.path.join(settings.upload_dir, "thumbnails")
    os.makedirs(thumb_dir, exist_ok=True)

    with tempfile.TemporaryDirectory(dir=settings.upload_dir) as tmp:
        outtmpl = os.path.join(tmp, "%(id)s.%(ext)s")
        _cookies = os.path.expanduser(
            "~/Documents/Claude/ReelRecipe/Cookies/www.instagram.com_cookies.txt"
        )
        ydl_opts = {
            "outtmpl": outtmpl,
            "format": "worst[ext=mp4]/worst",
            "quiet": True,
            "no_warnings": True,
            "http_headers": {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                "Referer": "https://www.instagram.com/",
            },
            **({"cookiefile": _cookies} if os.path.exists(_cookies) else {}),
        }

        def _download():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(recipe.source_url, download=True)
                return info.get("id", "reel"), info.get("duration") or 0

        loop = asyncio.get_event_loop()
        try:
            video_id, duration = await loop.run_in_executor(None, _download)
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Could not download reel: {e}")

        video_path = None
        from pathlib import Path as _Path
        for f in _Path(tmp).iterdir():
            if f.suffix.lower() in (".mp4", ".webm", ".mkv", ".mov"):
                video_path = str(f)
                break
        if not video_path:
            raise HTTPException(status_code=422, detail="No video file found after download.")

        def _extract_frame_at(pct, out_path):
            seek = max(1, (duration or 12) * pct)
            result = subprocess.run(
                ["ffmpeg", "-ss", str(seek), "-i", video_path,
                 "-vframes", "1", "-q:v", "2", out_path, "-y", "-loglevel", "quiet"],
                capture_output=True,
            )
            return result.returncode == 0 and os.path.exists(out_path)

        f45 = os.path.join(thumb_dir, f"preview_{recipe_id}_45.jpg")
        f95 = os.path.join(thumb_dir, f"preview_{recipe_id}_95.jpg")

        ok45, ok95 = await asyncio.gather(
            loop.run_in_executor(None, _extract_frame_at, 0.45, f45),
            loop.run_in_executor(None, _extract_frame_at, 0.95, f95),
        )
        if not ok45 and not ok95:
            raise HTTPException(status_code=422, detail="Could not extract frames from video.")

    return {
        "preview_45": f"/uploads/thumbnails/preview_{recipe_id}_45.jpg" if ok45 else None,
        "preview_95": f"/uploads/thumbnails/preview_{recipe_id}_95.jpg" if ok95 else None,
    }


@router.delete("/{recipe_id}", status_code=204)
def delete_recipe(
    recipe_id: int,
    scope: Scope = Depends(get_scope),
    db: Session = Depends(get_db),
):
    recipe = get_recipe_or_404(recipe_id, scope, db)
    db.delete(recipe)
    db.commit()


def _get_user_ratings(scope: Scope, db: Session) -> dict:
    if not scope.user:
        return {}
    rows = db.query(RecipeRating).filter(RecipeRating.user_id == scope.user.id).all()
    return {r.recipe_id: r.rating for r in rows}


class RateBody(BaseModel):
    rating: str  # dislike | like | love


@router.post("/{recipe_id}/rate")
def rate_recipe(
    recipe_id: int,
    body: RateBody,
    scope: Scope = Depends(get_scope),
    db: Session = Depends(get_db),
):
    if not scope.user:
        raise HTTPException(status_code=401, detail="Sign in to rate recipes.")
    if body.rating not in {"dislike", "like", "love"}:
        raise HTTPException(status_code=400, detail="rating must be dislike, like, or love")
    get_recipe_or_404(recipe_id, scope, db)
    user_id = scope.user.id
    existing = db.query(RecipeRating).filter(
        RecipeRating.user_id == user_id,
        RecipeRating.recipe_id == recipe_id,
    ).first()
    if existing:
        existing.rating = body.rating
    else:
        db.add(RecipeRating(user_id=user_id, recipe_id=recipe_id, rating=body.rating))
    db.commit()
    return {"user_rating": body.rating}


@router.delete("/{recipe_id}/rate", status_code=204)
def unrate_recipe(
    recipe_id: int,
    scope: Scope = Depends(get_scope),
    db: Session = Depends(get_db),
):
    if not scope.user:
        raise HTTPException(status_code=401, detail="Sign in to rate recipes.")
    existing = db.query(RecipeRating).filter(
        RecipeRating.user_id == scope.user.id,
        RecipeRating.recipe_id == recipe_id,
    ).first()
    if existing:
        db.delete(existing)
        db.commit()


def _serialize_recipe(recipe: Recipe, user_rating: Optional[str] = None) -> dict:
    return {
        "id": recipe.id,
        "title": recipe.title,
        "description": recipe.description,
        "source_url": recipe.source_url,
        "source_type": recipe.source_type,
        "thumbnail_url": recipe.thumbnail_url,
        "servings": recipe.servings,
        "prep_time_minutes": recipe.prep_time_minutes,
        "cook_time_minutes": recipe.cook_time_minutes,
        "cuisine": recipe.cuisine,
        "meal_type": recipe.meal_type,
        "tags": recipe.tags or [],
        "steps": recipe.steps or [],
        "macros_per_serving": {
            "calories": recipe.calories,
            "protein_g": recipe.protein_g,
            "carbs_g": recipe.carbs_g,
            "fat_g": recipe.fat_g,
        },
        "ingredients": [
            {
                "id": ri.id,
                "name": ri.ingredient.name,
                "quantity": ri.quantity,
                "unit": ri.unit,
                "notes": ri.notes,
                "raw_text": ri.raw_text,
                "category": ri.ingredient.category,
            }
            for ri in recipe.recipe_ingredients
        ],
        "user_rating": user_rating,
        "created_at": recipe.created_at.isoformat(),
        "updated_at": recipe.updated_at.isoformat(),
    }
