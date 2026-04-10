from datetime import datetime
from sqlalchemy import Column, Integer, String, Float, DateTime, Text, JSON, Boolean
from sqlalchemy.orm import relationship

from database import Base


class DietPlan(Base):
    __tablename__ = "diet_plans"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False, default="My Diet Plan")
    is_active = Column(Boolean, default=True)

    # Source
    source_type = Column(String(50), default="text")  # text | pdf | typed
    raw_content = Column(Text, nullable=True)  # original text/description

    # Parsed daily targets
    daily_calories = Column(Float, nullable=True)
    daily_protein_g = Column(Float, nullable=True)
    daily_carbs_g = Column(Float, nullable=True)
    daily_fat_g = Column(Float, nullable=True)

    # Per-meal targets (JSON: {breakfast: {calories, protein}, lunch: {...}, ...})
    meal_targets = Column(JSON, nullable=True)

    # Diet type / notes
    diet_type = Column(String(200), nullable=True)  # e.g. "high protein", "keto", "Mediterranean"
    restrictions = Column(JSON, default=list)  # ["gluten-free", "no dairy", ...]
    goals = Column(Text, nullable=True)  # Claude's summary of the goals
    analysis = Column(Text, nullable=True)  # Full Claude analysis

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
