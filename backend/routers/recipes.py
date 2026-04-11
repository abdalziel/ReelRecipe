import os
import shutil
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy.orm import Session

from config import settings
from database import get_db
from models import Recipe, Ingredient, RecipeIngredient

_ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic"}
_MAX_IMAGE_BYTES = 20 * 1024 * 1024

router = APIRouter(prefix="/api/recipes", tags=["recipes"])


@router.get("")
def list_recipes(
    meal_type: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    q = db.query(Recipe)
    if meal_type:
        q = q.filter(Recipe.meal_type == meal_type)
    if search:
        q = q.filter(Recipe.title.ilike(f"%{search}%"))
    recipes = q.order_by(Recipe.created_at.desc()).all()
    return [_serialize_recipe(r) for r in recipes]


@router.get("/{recipe_id}")
def get_recipe(recipe_id: int, db: Session = Depends(get_db)):
    recipe = db.query(Recipe).filter(Recipe.id == recipe_id).first()
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")
    return _serialize_recipe(recipe)


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
def update_recipe(recipe_id: int, update: RecipeUpdate, db: Session = Depends(get_db)):
    recipe = db.query(Recipe).filter(Recipe.id == recipe_id).first()
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")
    for field, value in update.model_dump(exclude_none=True).items():
        setattr(recipe, field, value)
    db.commit()
    db.refresh(recipe)
    return _serialize_recipe(recipe)


@router.patch("/{recipe_id}/thumbnail")
async def update_thumbnail(
    recipe_id: int,
    file: Optional[UploadFile] = File(None),
    url: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    """Replace the cover photo. Accepts either a file upload or a URL."""
    recipe = db.query(Recipe).filter(Recipe.id == recipe_id).first()
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")

    if file and file.filename:
        content_type = (file.content_type or "").lower()
        if content_type not in _ALLOWED_IMAGE_TYPES:
            raise HTTPException(status_code=400, detail=f"Unsupported file type '{content_type}'.")
        data = await file.read()
        if len(data) > _MAX_IMAGE_BYTES:
            raise HTTPException(status_code=400, detail="Image must be under 20 MB.")
        thumb_dir = os.path.join(settings.upload_dir, "thumbnails")
        os.makedirs(thumb_dir, exist_ok=True)
        ext = os.path.splitext(file.filename)[1] or ".jpg"
        filename = f"recipe_{recipe_id}_cover{ext}"
        dest = os.path.join(thumb_dir, filename)
        with open(dest, "wb") as f_out:
            f_out.write(data)
        recipe.thumbnail_url = f"/uploads/thumbnails/{filename}"
    elif url:
        recipe.thumbnail_url = url
    else:
        raise HTTPException(status_code=400, detail="Provide either a file or a URL.")

    db.commit()
    db.refresh(recipe)
    return {"thumbnail_url": recipe.thumbnail_url}


@router.post("/{recipe_id}/thumbnail/from-reel")
async def thumbnail_from_reel(recipe_id: int, db: Session = Depends(get_db)):
    """Re-extract the cover photo from the original reel source using yt-dlp thumbnail-only mode."""
    import asyncio, tempfile, yt_dlp
    from pathlib import Path

    recipe = db.query(Recipe).filter(Recipe.id == recipe_id).first()
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")
    if not recipe.source_url:
        raise HTTPException(status_code=422, detail="No source URL for this recipe.")

    thumb_dir = os.path.join(settings.upload_dir, "thumbnails")
    os.makedirs(thumb_dir, exist_ok=True)

    with tempfile.TemporaryDirectory(dir=settings.upload_dir) as tmp:
        outtmpl = os.path.join(tmp, "%(id)s.%(ext)s")
        ydl_opts = {
            "outtmpl": outtmpl,
            "skip_download": True,
            "writethumbnail": True,
            "quiet": True,
            "no_warnings": True,
        }

        def _fetch():
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(recipe.source_url, download=True)
                return info.get("id", "thumb")

        loop = asyncio.get_event_loop()
        try:
            video_id = await loop.run_in_executor(None, _fetch)
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Could not fetch reel thumbnail: {e}")

        # Find the downloaded thumbnail
        src = None
        for f in Path(tmp).iterdir():
            if f.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"):
                src = f
                break
        if not src:
            raise HTTPException(status_code=422, detail="No thumbnail found in reel.")

        filename = f"recipe_{recipe_id}_reel{src.suffix}"
        dest = os.path.join(thumb_dir, filename)
        shutil.copy2(str(src), dest)

    recipe.thumbnail_url = f"/uploads/thumbnails/{filename}"
    db.commit()
    db.refresh(recipe)
    return {"thumbnail_url": recipe.thumbnail_url}


@router.delete("/{recipe_id}", status_code=204)
def delete_recipe(recipe_id: int, db: Session = Depends(get_db)):
    recipe = db.query(Recipe).filter(Recipe.id == recipe_id).first()
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")
    db.delete(recipe)
    db.commit()


def _serialize_recipe(recipe: Recipe) -> dict:
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
        "created_at": recipe.created_at.isoformat(),
        "updated_at": recipe.updated_at.isoformat(),
    }
