from datetime import date, timedelta
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import MealPlan, MealPlanEntry, Recipe, DietPlan
from services.diet_analyzer import suggest_meal_plan

router = APIRouter(prefix="/api/meal-plan", tags=["meal-plan"])


class MealPlanCreate(BaseModel):
    name: str = "Weekly Meal Plan"
    week_start: date  # ISO date string, should be a Monday


class MealPlanEntryCreate(BaseModel):
    recipe_id: int
    day_of_week: int  # 0-6
    meal_slot: str    # breakfast | lunch | dinner | snack
    servings: int = 1


class MealPlanEntryUpdate(BaseModel):
    recipe_id: Optional[int] = None
    day_of_week: Optional[int] = None
    meal_slot: Optional[str] = None
    servings: Optional[int] = None


class AIAlignRequest(BaseModel):
    meal_plan_id: int
    diet_plan_id: int


@router.get("")
def list_meal_plans(db: Session = Depends(get_db)):
    plans = db.query(MealPlan).order_by(MealPlan.week_start.desc()).all()
    return [_serialize_plan(p) for p in plans]


@router.post("")
def create_meal_plan(payload: MealPlanCreate, db: Session = Depends(get_db)):
    plan = MealPlan(name=payload.name, week_start=payload.week_start)
    db.add(plan)
    db.commit()
    db.refresh(plan)
    return _serialize_plan(plan)


@router.get("/{plan_id}")
def get_meal_plan(plan_id: int, db: Session = Depends(get_db)):
    plan = db.query(MealPlan).filter(MealPlan.id == plan_id).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Meal plan not found")
    return _serialize_plan(plan)


@router.delete("/{plan_id}", status_code=204)
def delete_meal_plan(plan_id: int, db: Session = Depends(get_db)):
    plan = db.query(MealPlan).filter(MealPlan.id == plan_id).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Meal plan not found")
    db.delete(plan)
    db.commit()


@router.post("/{plan_id}/entries")
def add_entry(plan_id: int, entry: MealPlanEntryCreate, db: Session = Depends(get_db)):
    plan = db.query(MealPlan).filter(MealPlan.id == plan_id).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Meal plan not found")
    recipe = db.query(Recipe).filter(Recipe.id == entry.recipe_id).first()
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")

    new_entry = MealPlanEntry(
        meal_plan_id=plan_id,
        recipe_id=entry.recipe_id,
        day_of_week=entry.day_of_week,
        meal_slot=entry.meal_slot,
        servings=entry.servings,
    )
    db.add(new_entry)
    db.commit()
    db.refresh(new_entry)
    return _serialize_entry(new_entry)


@router.patch("/{plan_id}/entries/{entry_id}")
def update_entry(
    plan_id: int,
    entry_id: int,
    update: MealPlanEntryUpdate,
    db: Session = Depends(get_db),
):
    entry = db.query(MealPlanEntry).filter(
        MealPlanEntry.id == entry_id, MealPlanEntry.meal_plan_id == plan_id
    ).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")
    for field, value in update.model_dump(exclude_none=True).items():
        setattr(entry, field, value)
    db.commit()
    db.refresh(entry)
    return _serialize_entry(entry)


@router.delete("/{plan_id}/entries/{entry_id}", status_code=204)
def remove_entry(plan_id: int, entry_id: int, db: Session = Depends(get_db)):
    entry = db.query(MealPlanEntry).filter(
        MealPlanEntry.id == entry_id, MealPlanEntry.meal_plan_id == plan_id
    ).first()
    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")
    db.delete(entry)
    db.commit()


@router.post("/ai-align")
async def ai_align_meal_plan(payload: AIAlignRequest, db: Session = Depends(get_db)):
    """Use Claude to populate a meal plan based on the active diet plan and saved recipes."""
    plan = db.query(MealPlan).filter(MealPlan.id == payload.meal_plan_id).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Meal plan not found")

    diet = db.query(DietPlan).filter(DietPlan.id == payload.diet_plan_id).first()
    if not diet:
        raise HTTPException(status_code=404, detail="Diet plan not found")

    # Get all recipes
    recipes = db.query(Recipe).all()
    if not recipes:
        raise HTTPException(status_code=422, detail="No recipes saved yet")

    recipes_data = [
        {
            "id": r.id,
            "title": r.title,
            "meal_type": r.meal_type,
            "calories": r.calories,
            "protein_g": r.protein_g,
            "carbs_g": r.carbs_g,
            "fat_g": r.fat_g,
            "tags": r.tags or [],
        }
        for r in recipes
    ]

    diet_data = {
        "diet_type": diet.diet_type,
        "daily_calories": diet.daily_calories,
        "daily_protein_g": diet.daily_protein_g,
        "daily_carbs_g": diet.daily_carbs_g,
        "daily_fat_g": diet.daily_fat_g,
        "meal_targets": diet.meal_targets,
        "restrictions": diet.restrictions,
        "goals": diet.goals,
    }

    suggestions = await suggest_meal_plan(
        diet_plan=diet_data,
        recipes=recipes_data,
        week_start=str(plan.week_start),
    )

    # Clear existing entries and replace with AI suggestions
    db.query(MealPlanEntry).filter(MealPlanEntry.meal_plan_id == plan.id).delete()
    for s in suggestions:
        entry = MealPlanEntry(
            meal_plan_id=plan.id,
            recipe_id=s["recipe_id"],
            day_of_week=s["day_of_week"],
            meal_slot=s["meal_slot"],
            servings=s.get("servings", 1),
        )
        db.add(entry)
    db.commit()
    db.refresh(plan)
    return _serialize_plan(plan)


def _serialize_entry(entry: MealPlanEntry) -> dict:
    recipe = entry.recipe
    return {
        "id": entry.id,
        "day_of_week": entry.day_of_week,
        "meal_slot": entry.meal_slot,
        "servings": entry.servings,
        "recipe": {
            "id": recipe.id,
            "title": recipe.title,
            "meal_type": recipe.meal_type,
            "thumbnail_url": recipe.thumbnail_url,
            "macros_per_serving": {
                "calories": recipe.calories,
                "protein_g": recipe.protein_g,
                "carbs_g": recipe.carbs_g,
                "fat_g": recipe.fat_g,
            },
        },
    }


def _serialize_plan(plan: MealPlan) -> dict:
    DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    entries_by_day: dict = {i: {"day": DAY_NAMES[i], "meals": {}} for i in range(7)}
    for entry in plan.entries:
        day = entry.day_of_week
        slot = entry.meal_slot
        if slot not in entries_by_day[day]["meals"]:
            entries_by_day[day]["meals"][slot] = []
        entries_by_day[day]["meals"][slot].append(_serialize_entry(entry))

    return {
        "id": plan.id,
        "name": plan.name,
        "week_start": plan.week_start.isoformat(),
        "calendar": list(entries_by_day.values()),
        "created_at": plan.created_at.isoformat(),
    }
