"""
Recipe import endpoints:

  POST /api/reels/process        — Instagram reel URL
  POST /api/reels/import-web     — Any recipe website URL
  POST /api/reels/scan-page      — Scan a page for recipe links (returns list for picker)
  POST /api/reels/import-photo   — Upload a photo of a recipe card / cookbook page
"""
import asyncio
import os
from fastapi import APIRouter, HTTPException, Depends, File, UploadFile, Form
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import Recipe, Ingredient, RecipeIngredient
from services.video_processor import process_reel_url
from services.recipe_extractor import (
    extract_recipe_from_reel,
    extract_recipe_from_web,
    extract_recipe_from_image,
    NoRecipeFoundError,
)
from services.web_scraper import get_recipe_content, find_recipes_on_page
from services.duplicate_detector import find_duplicate
from services.public_library import publish as publish_to_public

router = APIRouter(prefix="/api/reels", tags=["reels"])

_ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic"}
_MAX_IMAGE_BYTES = 20 * 1024 * 1024  # 20 MB


# ── Shared helpers ─────────────────────────────────────────────────────────

def _duplicate_error(existing: Recipe) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail=(
            f"Looks like you were so hungry you wanted it twice! "
            f"\"{existing.title}\" is already in your library."
        ),
    )


def _persist_recipe(recipe_data: dict, source_url: str, source_type: str,
                    thumb_url: str | None, transcript: str | None,
                    db: Session) -> Recipe:
    """Save a Claude-extracted recipe dict to the database."""
    recipe = Recipe(
        title=recipe_data["title"],
        description=recipe_data.get("description"),
        source_url=source_url,
        source_type=source_type,
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
        db.add(RecipeIngredient(
            recipe_id=recipe.id,
            ingredient_id=ingredient.id,
            quantity=ing_data.get("quantity"),
            unit=ing_data.get("unit"),
            notes=ing_data.get("notes"),
            raw_text=ing_data.get("raw_text"),
        ))

    db.commit()
    db.refresh(recipe)
    return recipe


def _auto_publish(recipe: Recipe):
    """Fire-and-forget publish to the public library. Never blocks or raises."""
    asyncio.create_task(publish_to_public({
        "title": recipe.title,
        "description": recipe.description,
        "cuisine": recipe.cuisine,
        "meal_type": recipe.meal_type,
        "tags": recipe.tags or [],
        "thumbnail_url": recipe.thumbnail_url,
        "servings": recipe.servings,
        "prep_time_minutes": recipe.prep_time_minutes,
        "cook_time_minutes": recipe.cook_time_minutes,
        "calories": recipe.calories,
        "protein_g": recipe.protein_g,
        "carbs_g": recipe.carbs_g,
        "fat_g": recipe.fat_g,
        "ingredients": [
            {"name": ri.ingredient.name, "quantity": ri.quantity,
             "unit": ri.unit, "category": ri.ingredient.category}
            for ri in recipe.recipe_ingredients
        ],
        "steps": recipe.steps or [],
    }))


# ── 1. Instagram reel ──────────────────────────────────────────────────────

class ReelSubmission(BaseModel):
    url: str


@router.post("/process")
async def process_reel(submission: ReelSubmission, db: Session = Depends(get_db)):
    os.makedirs("./uploads", exist_ok=True)

    # Download + transcribe first (we need the recipe content to do a content check)
    try:
        video_data = await process_reel_url(submission.url)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to process reel: {str(e)}")

    # Extract recipe
    try:
        recipe_data = await extract_recipe_from_reel(
            title=video_data["title"],
            transcript=video_data.get("transcript"),
            description=video_data.get("description"),
        )
    except NoRecipeFoundError as e:
        raise HTTPException(
            status_code=422,
            detail=f"No recipe could be found for this reel \"{video_data['title']}\". "
                   "Try a reel that shows cooking instructions or ingredients."
        )
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to extract recipe: {str(e)}")

    # Content-based duplicate check (catches same recipe from different URLs)
    ingredient_names = [i["name"] for i in recipe_data.get("ingredients", [])]
    dup = find_duplicate(recipe_data["title"], ingredient_names, db)
    if dup:
        raise _duplicate_error(dup)

    raw_thumb = video_data.get("thumbnail_path")
    thumb_url = f"/uploads/thumbnails/{os.path.basename(raw_thumb)}" if raw_thumb else None

    recipe = _persist_recipe(
        recipe_data, submission.url, "instagram_reel",
        thumb_url, video_data.get("transcript"), db
    )
    _auto_publish(recipe)
    return _serialize_recipe(recipe)


# ── 2. Web recipe URL ──────────────────────────────────────────────────────

class WebRecipeRequest(BaseModel):
    url: str


@router.post("/import-web")
async def import_web_recipe(payload: WebRecipeRequest, db: Session = Depends(get_db)):
    """Import a recipe from any recipe website URL."""
    try:
        content = await get_recipe_content(payload.url)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Could not fetch that page: {str(e)}")

    try:
        recipe_data = await extract_recipe_from_web(
            title=content["title"],
            ingredients=content["ingredients"],
            instructions=content["instructions"],
        )
    except NoRecipeFoundError:
        raise HTTPException(
            status_code=422,
            detail="No recipe could be found on that page. Make sure the URL links directly to a recipe."
        )
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to extract recipe: {str(e)}")

    ingredient_names = [i["name"] for i in recipe_data.get("ingredients", [])]
    dup = find_duplicate(recipe_data["title"], ingredient_names, db)
    if dup:
        raise _duplicate_error(dup)

    recipe = _persist_recipe(
        recipe_data, payload.url, "web_recipe",
        content.get("image"), None, db
    )
    return _serialize_recipe(recipe)


# ── 3. Page scanner ────────────────────────────────────────────────────────

class ScanPageRequest(BaseModel):
    url: str


@router.post("/scan-page")
async def scan_recipe_page(payload: ScanPageRequest):
    """
    Scan a web page for recipe links.
    Returns [{"url": str, "title": str}] for the frontend picker.
    """
    try:
        recipes = await find_recipes_on_page(payload.url)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Could not scan that page: {str(e)}")

    if not recipes:
        raise HTTPException(
            status_code=404,
            detail="No recipe links found on that page. Try a recipe index, search results page, or blog archive."
        )
    return {"recipes": recipes}


# ── 4. Photo import ────────────────────────────────────────────────────────

@router.post("/import-photo")
async def import_photo_recipe(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Import a recipe from a photo of a recipe card or cookbook page."""
    content_type = (file.content_type or "").lower()
    if content_type not in _ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{content_type}'. Upload a JPEG, PNG, or WebP image."
        )

    image_bytes = await file.read()
    if len(image_bytes) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="Image must be under 20 MB.")

    try:
        recipe_data = await extract_recipe_from_image(image_bytes, content_type)
    except NoRecipeFoundError:
        raise HTTPException(
            status_code=422,
            detail="No recipe could be found in this image. Make sure the photo clearly shows a recipe with ingredients and instructions."
        )
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to extract recipe: {str(e)}")

    ingredient_names = [i["name"] for i in recipe_data.get("ingredients", [])]
    dup = find_duplicate(recipe_data["title"], ingredient_names, db)
    if dup:
        raise _duplicate_error(dup)

    recipe = _persist_recipe(recipe_data, None, "photo", None, None, db)
    return _serialize_recipe(recipe)


# ── Serializer ─────────────────────────────────────────────────────────────

def _serialize_recipe(recipe: Recipe) -> dict:
    return {
        "id": recipe.id,
        "title": recipe.title,
        "description": recipe.description,
        "source_url": recipe.source_url,
        "source_type": getattr(recipe, "source_type", None),
        "thumbnail_url": recipe.thumbnail_url,
        "servings": recipe.servings,
        "prep_time_minutes": recipe.prep_time_minutes,
        "cook_time_minutes": recipe.cook_time_minutes,
        "cuisine": recipe.cuisine,
        "meal_type": recipe.meal_type,
        "tags": recipe.tags,
        "steps": recipe.steps,
        "macros_per_serving": {
            "calories": recipe.calories,
            "protein_g": recipe.protein_g,
            "carbs_g": recipe.carbs_g,
            "fat_g": recipe.fat_g,
        },
        "ingredients": [
            {
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
    }
