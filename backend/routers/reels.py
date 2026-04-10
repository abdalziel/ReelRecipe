"""
POST /api/reels/process  — submit a reel URL, get back a recipe
"""
import os
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, HttpUrl
from sqlalchemy.orm import Session

from database import get_db
from models import Recipe, Ingredient, RecipeIngredient
from services.video_processor import process_reel_url
from services.recipe_extractor import extract_recipe_from_reel, NoRecipeFoundError

router = APIRouter(prefix="/api/reels", tags=["reels"])


class ReelSubmission(BaseModel):
    url: str


@router.post("/process")
async def process_reel(submission: ReelSubmission, db: Session = Depends(get_db)):
    """
    Download a reel, transcribe it, extract the recipe, and save to DB.
    Returns the created recipe.
    """
    os.makedirs("./uploads", exist_ok=True)

    # Check for duplicate before downloading
    existing = db.query(Recipe).filter(Recipe.source_url == submission.url).first()
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"Looks like you were so hungry you wanted it twice! \"{existing.title}\" is already in your library."
        )

    # Step 1: Download + transcribe
    try:
        video_data = await process_reel_url(submission.url)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to process reel: {str(e)}")

    # Step 2: Extract recipe via Claude
    try:
        recipe_data = await extract_recipe_from_reel(
            title=video_data["title"],
            transcript=video_data.get("transcript"),
            description=video_data.get("description"),
        )
    except NoRecipeFoundError as e:
        raise HTTPException(
            status_code=422,
            detail=f"No recipe could be found for this reel \"{video_data['title']}\". Try a reel that shows cooking instructions or ingredients."
        )
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to extract recipe: {str(e)}")

    # Step 3: Persist recipe
    # Convert local thumbnail path to a server-relative URL
    raw_thumb = video_data.get("thumbnail_path")
    if raw_thumb:
        thumb_filename = os.path.basename(raw_thumb)
        thumb_url = f"/uploads/thumbnails/{thumb_filename}"
    else:
        thumb_url = None

    recipe = Recipe(
        title=recipe_data["title"],
        description=recipe_data.get("description"),
        source_url=submission.url,
        source_type="instagram_reel",
        thumbnail_url=thumb_url,
        transcript=video_data.get("transcript"),
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

    # Step 4: Persist ingredients
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
    db.refresh(recipe)
    return _serialize_recipe(recipe)


def _serialize_recipe(recipe: Recipe) -> dict:
    return {
        "id": recipe.id,
        "title": recipe.title,
        "description": recipe.description,
        "source_url": recipe.source_url,
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
