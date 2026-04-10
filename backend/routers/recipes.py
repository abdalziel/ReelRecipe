from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import Recipe, Ingredient, RecipeIngredient

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
