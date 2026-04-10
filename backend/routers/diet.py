import os
import tempfile
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import DietPlan
from services.diet_analyzer import analyze_diet_plan, extract_text_from_pdf

router = APIRouter(prefix="/api/diet", tags=["diet"])


class DietDescriptionRequest(BaseModel):
    description: str
    name: str = "My Diet Plan"


@router.get("")
def list_diet_plans(db: Session = Depends(get_db)):
    plans = db.query(DietPlan).order_by(DietPlan.created_at.desc()).all()
    return [_serialize(p) for p in plans]


@router.get("/active")
def get_active_diet_plan(db: Session = Depends(get_db)):
    plan = db.query(DietPlan).filter(DietPlan.is_active == True).first()
    if not plan:
        raise HTTPException(status_code=404, detail="No active diet plan")
    return _serialize(plan)


@router.post("/from-text")
async def create_from_text(payload: DietDescriptionRequest, db: Session = Depends(get_db)):
    """Create a diet plan from a plain text description or typed goals."""
    analysis = await analyze_diet_plan(payload.description)
    return _save_diet_plan(payload.name, "text", payload.description, analysis, db)


@router.post("/from-pdf")
async def create_from_pdf(
    file: UploadFile = File(...),
    name: str = Form("My Diet Plan"),
    db: Session = Depends(get_db),
):
    """Upload a PDF diet plan and extract structured targets."""
    if not file.filename.endswith(".pdf"):
        raise HTTPException(status_code=422, detail="Only PDF files are accepted")

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    try:
        text = extract_text_from_pdf(tmp_path)
        if not text.strip():
            raise HTTPException(status_code=422, detail="Could not extract text from PDF")
        analysis = await analyze_diet_plan(text)
        return _save_diet_plan(name, "pdf", text, analysis, db)
    finally:
        os.unlink(tmp_path)


@router.patch("/{plan_id}/activate")
def activate_diet_plan(plan_id: int, db: Session = Depends(get_db)):
    """Set a diet plan as active (deactivates others)."""
    plan = db.query(DietPlan).filter(DietPlan.id == plan_id).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Diet plan not found")
    db.query(DietPlan).update({"is_active": False})
    plan.is_active = True
    db.commit()
    db.refresh(plan)
    return _serialize(plan)


@router.delete("/{plan_id}", status_code=204)
def delete_diet_plan(plan_id: int, db: Session = Depends(get_db)):
    plan = db.query(DietPlan).filter(DietPlan.id == plan_id).first()
    if not plan:
        raise HTTPException(status_code=404, detail="Diet plan not found")
    db.delete(plan)
    db.commit()


def _save_diet_plan(name: str, source_type: str, raw_content: str, analysis: dict, db: Session) -> dict:
    # Deactivate previous plans
    db.query(DietPlan).update({"is_active": False})

    plan = DietPlan(
        name=name,
        is_active=True,
        source_type=source_type,
        raw_content=raw_content,
        daily_calories=analysis.get("daily_calories"),
        daily_protein_g=analysis.get("daily_protein_g"),
        daily_carbs_g=analysis.get("daily_carbs_g"),
        daily_fat_g=analysis.get("daily_fat_g"),
        meal_targets=analysis.get("meal_targets"),
        diet_type=analysis.get("diet_type"),
        restrictions=analysis.get("restrictions", []),
        goals=analysis.get("goals"),
        analysis=analysis.get("analysis"),
    )
    db.add(plan)
    db.commit()
    db.refresh(plan)
    return _serialize(plan)


def _serialize(plan: DietPlan) -> dict:
    return {
        "id": plan.id,
        "name": plan.name,
        "is_active": plan.is_active,
        "source_type": plan.source_type,
        "diet_type": plan.diet_type,
        "daily_targets": {
            "calories": plan.daily_calories,
            "protein_g": plan.daily_protein_g,
            "carbs_g": plan.daily_carbs_g,
            "fat_g": plan.daily_fat_g,
        },
        "meal_targets": plan.meal_targets,
        "restrictions": plan.restrictions or [],
        "goals": plan.goals,
        "analysis": plan.analysis,
        "created_at": plan.created_at.isoformat(),
    }
