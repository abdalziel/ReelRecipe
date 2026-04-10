from datetime import datetime, date
from sqlalchemy import Column, Integer, String, Date, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship

from database import Base


class MealPlan(Base):
    __tablename__ = "meal_plans"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False, default="Weekly Meal Plan")
    week_start = Column(Date, nullable=False)  # Monday of the week
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    entries = relationship(
        "MealPlanEntry", back_populates="meal_plan", cascade="all, delete-orphan"
    )
    shopping_lists = relationship("ShoppingList", back_populates="meal_plan")


class MealPlanEntry(Base):
    __tablename__ = "meal_plan_entries"

    id = Column(Integer, primary_key=True, index=True)
    meal_plan_id = Column(Integer, ForeignKey("meal_plans.id"), nullable=False)
    recipe_id = Column(Integer, ForeignKey("recipes.id"), nullable=False)
    day_of_week = Column(Integer, nullable=False)  # 0=Monday ... 6=Sunday
    meal_slot = Column(String(20), nullable=False)  # breakfast | lunch | dinner | snack
    servings = Column(Integer, default=1)

    meal_plan = relationship("MealPlan", back_populates="entries")
    recipe = relationship("Recipe", back_populates="meal_plan_entries")
