from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import ShoppingList, ShoppingListItem, MealPlan
from services.shopping_list import (
    create_shopping_list_from_recipes,
    group_items_by_category,
)

router = APIRouter(prefix="/api/shopping-lists", tags=["shopping-lists"])


class GenerateFromPlanRequest(BaseModel):
    meal_plan_id: int
    name: str = "Weekly Shopping List"
    grocery_runs: int = 1  # Split into N grocery runs


class GenerateFromRecipesRequest(BaseModel):
    recipe_ids: List[int]
    servings_map: Optional[dict] = None  # {recipe_id: servings}
    name: str = "Shopping List"


class ToggleItemRequest(BaseModel):
    is_checked: bool


@router.get("")
def list_shopping_lists(db: Session = Depends(get_db)):
    lists = db.query(ShoppingList).order_by(ShoppingList.created_at.desc()).all()
    return [_serialize_list(lst, db) for lst in lists]


@router.get("/{list_id}")
def get_shopping_list(list_id: int, db: Session = Depends(get_db)):
    lst = db.query(ShoppingList).filter(ShoppingList.id == list_id).first()
    if not lst:
        raise HTTPException(status_code=404, detail="Shopping list not found")
    return _serialize_list(lst, db)


@router.post("/generate-from-plan")
def generate_from_plan(
    payload: GenerateFromPlanRequest, db: Session = Depends(get_db)
):
    """Generate shopping list(s) from a meal plan, optionally split into N grocery runs."""
    plan = db.query(MealPlan).filter(MealPlan.id == payload.meal_plan_id).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Meal plan not found")

    entries = plan.entries
    if not entries:
        raise HTTPException(status_code=422, detail="Meal plan has no entries")

    # Build recipe_ids and servings_map
    recipe_ids = list({e.recipe_id for e in entries})
    servings_map = {}
    for entry in entries:
        servings_map[entry.recipe_id] = (
            servings_map.get(entry.recipe_id, 0) + entry.servings
        )

    if payload.grocery_runs == 1:
        lst = create_shopping_list_from_recipes(
            recipe_ids=recipe_ids,
            servings_map=servings_map,
            meal_plan_id=payload.meal_plan_id,
            name=payload.name,
            grocery_run=1,
            db=db,
        )
        return [_serialize_list(lst, db)]
    else:
        # Split by days: first half Mon-Wed/Thu, second half Thu/Fri-Sun
        half = len(recipe_ids) // 2
        results = []
        for run_idx, ids_chunk in enumerate([recipe_ids[:half], recipe_ids[half:]], 1):
            chunk_servings = {rid: servings_map[rid] for rid in ids_chunk if rid in servings_map}
            lst = create_shopping_list_from_recipes(
                recipe_ids=ids_chunk,
                servings_map=chunk_servings,
                meal_plan_id=payload.meal_plan_id,
                name=f"{payload.name} — Run {run_idx}",
                grocery_run=run_idx,
                db=db,
            )
            results.append(_serialize_list(lst, db))
        return results


@router.post("/generate-from-recipes")
def generate_from_recipes(
    payload: GenerateFromRecipesRequest, db: Session = Depends(get_db)
):
    """Generate a shopping list from an arbitrary set of recipe IDs."""
    servings_map = payload.servings_map or {rid: 1 for rid in payload.recipe_ids}
    lst = create_shopping_list_from_recipes(
        recipe_ids=payload.recipe_ids,
        servings_map={int(k): v for k, v in servings_map.items()},
        meal_plan_id=None,
        name=payload.name,
        grocery_run=1,
        db=db,
    )
    return _serialize_list(lst, db)


@router.patch("/{list_id}/items/{item_id}/toggle")
def toggle_item(
    list_id: int,
    item_id: int,
    payload: ToggleItemRequest,
    db: Session = Depends(get_db),
):
    item = db.query(ShoppingListItem).filter(
        ShoppingListItem.id == item_id,
        ShoppingListItem.shopping_list_id == list_id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    item.is_checked = payload.is_checked
    db.commit()
    return {"id": item.id, "is_checked": item.is_checked}


@router.delete("/{list_id}", status_code=204)
def delete_shopping_list(list_id: int, db: Session = Depends(get_db)):
    lst = db.query(ShoppingList).filter(ShoppingList.id == list_id).first()
    if not lst:
        raise HTTPException(status_code=404, detail="Shopping list not found")
    db.delete(lst)
    db.commit()


def _serialize_list(lst: ShoppingList, db: Session) -> dict:
    # Group items by category
    from collections import defaultdict
    from services.shopping_list import CATEGORY_ORDER

    groups: dict = defaultdict(list)
    for item in lst.items:
        groups[item.category or "other"].append({
            "id": item.id,
            "display_text": item.display_text,
            "quantity": item.quantity,
            "unit": item.unit,
            "category": item.category,
            "is_checked": item.is_checked,
            "ingredient_name": item.ingredient.name,
        })

    grouped = {cat: groups[cat] for cat in CATEGORY_ORDER if cat in groups}

    return {
        "id": lst.id,
        "name": lst.name,
        "grocery_run": lst.grocery_run,
        "meal_plan_id": lst.meal_plan_id,
        "items_by_category": grouped,
        "total_items": len(lst.items),
        "checked_count": sum(1 for i in lst.items if i.is_checked),
        "created_at": lst.created_at.isoformat(),
    }
