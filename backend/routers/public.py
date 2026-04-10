"""
GET  /api/public/recipes           — browse / search public library
POST /api/public/recipes/{id}/save — save a public recipe to personal library
"""
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.orm import Session

from database import get_db
from models import Recipe, Ingredient, RecipeIngredient
from services.public_library import search, get_all, get_by_id
from services.duplicate_detector import find_duplicate

router = APIRouter(prefix="/api/public", tags=["public"])


@router.get("/recipes")
async def browse_public(q: str = "", meal_type: str = ""):
    results = await search(q=q, meal_type=meal_type)
    return {"recipes": results, "count": len(results)}


@router.post("/recipes/{pub_id}/save")
async def save_to_library(pub_id: str, db: Session = Depends(get_db)):
    """
    Copy a public recipe into the user's personal library.
    Returns 409 with the usual corny message if it's already saved.
    """
    pub_recipe = await get_by_id(pub_id)
    if not pub_recipe:
        raise HTTPException(status_code=404, detail="Public recipe not found.")

    ing_names = [i.get("name", "") for i in pub_recipe.get("ingredients", [])]
    dup = find_duplicate(pub_recipe["title"], ing_names, db)
    if dup:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Looks like you were so hungry you wanted it twice! "
                f"\"{dup.title}\" is already in your library."
            ),
        )

    recipe = Recipe(
        title=pub_recipe["title"],
        description=pub_recipe.get("description"),
        source_url=None,
        source_type="public_library",
        thumbnail_url=pub_recipe.get("thumbnail_url"),
        servings=pub_recipe.get("servings", 2),
        prep_time_minutes=pub_recipe.get("prep_time_minutes"),
        cook_time_minutes=pub_recipe.get("cook_time_minutes"),
        cuisine=pub_recipe.get("cuisine"),
        meal_type=pub_recipe.get("meal_type"),
        tags=pub_recipe.get("tags", []),
        steps=pub_recipe.get("steps", []),
        calories=pub_recipe.get("calories"),
        protein_g=pub_recipe.get("protein_g"),
        carbs_g=pub_recipe.get("carbs_g"),
        fat_g=pub_recipe.get("fat_g"),
    )
    db.add(recipe)
    db.flush()

    for ing_data in pub_recipe.get("ingredients", []):
        name = (ing_data.get("name") or "").lower().strip()
        if not name:
            continue
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
    return {"message": f"\"{recipe.title}\" added to your library!", "recipe_id": recipe.id}
