from datetime import datetime
from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, ForeignKey, Text
from sqlalchemy.orm import relationship

from database import Base


class ShoppingList(Base):
    __tablename__ = "shopping_lists"

    id = Column(Integer, primary_key=True, index=True)
    meal_plan_id = Column(Integer, ForeignKey("meal_plans.id"), nullable=True)
    name = Column(String(200), nullable=False, default="Shopping List")
    grocery_run = Column(Integer, default=1)  # 1 = first run of week, 2 = second, etc.
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    meal_plan = relationship("MealPlan", back_populates="shopping_lists")
    items = relationship(
        "ShoppingListItem", back_populates="shopping_list", cascade="all, delete-orphan"
    )


class ShoppingListItem(Base):
    __tablename__ = "shopping_list_items"

    id = Column(Integer, primary_key=True, index=True)
    shopping_list_id = Column(Integer, ForeignKey("shopping_lists.id"), nullable=False)
    ingredient_id = Column(Integer, ForeignKey("ingredients.id"), nullable=False)
    quantity = Column(Float, nullable=True)
    unit = Column(String(50), nullable=True)
    display_text = Column(String(300), nullable=False)  # "2 lbs chicken breast"
    category = Column(String(100), nullable=True)  # for grouping in UI
    is_checked = Column(Boolean, default=False)

    shopping_list = relationship("ShoppingList", back_populates="items")
    ingredient = relationship("Ingredient", back_populates="shopping_list_items")
