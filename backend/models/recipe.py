from datetime import datetime
from sqlalchemy import Column, Integer, String, Text, Float, DateTime, ForeignKey, JSON
from sqlalchemy.orm import relationship

from database import Base


class Recipe(Base):
    __tablename__ = "recipes"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    source_url = Column(String(500), nullable=True)
    source_type = Column(String(50), default="instagram_reel")  # instagram_reel | upload
    thumbnail_url = Column(String(500), nullable=True)
    transcript = Column(Text, nullable=True)

    # Recipe details
    servings = Column(Integer, default=2)
    prep_time_minutes = Column(Integer, nullable=True)
    cook_time_minutes = Column(Integer, nullable=True)
    cuisine = Column(String(100), nullable=True)
    meal_type = Column(String(50), nullable=True)  # breakfast | lunch | dinner | snack
    tags = Column(JSON, default=list)

    # Steps stored as JSON array of strings
    steps = Column(JSON, default=list)

    # Macros per serving (estimated by Claude)
    calories = Column(Float, nullable=True)
    protein_g = Column(Float, nullable=True)
    carbs_g = Column(Float, nullable=True)
    fat_g = Column(Float, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    recipe_ingredients = relationship(
        "RecipeIngredient", back_populates="recipe", cascade="all, delete-orphan"
    )
    meal_plan_entries = relationship("MealPlanEntry", back_populates="recipe")


class Ingredient(Base):
    __tablename__ = "ingredients"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(200), nullable=False, unique=True, index=True)
    category = Column(String(100), nullable=True)  # produce | protein | dairy | pantry | frozen | spice

    recipe_ingredients = relationship("RecipeIngredient", back_populates="ingredient")
    shopping_list_items = relationship("ShoppingListItem", back_populates="ingredient")


class RecipeIngredient(Base):
    __tablename__ = "recipe_ingredients"

    id = Column(Integer, primary_key=True, index=True)
    recipe_id = Column(Integer, ForeignKey("recipes.id"), nullable=False)
    ingredient_id = Column(Integer, ForeignKey("ingredients.id"), nullable=False)
    quantity = Column(Float, nullable=True)
    unit = Column(String(50), nullable=True)
    notes = Column(String(200), nullable=True)  # "finely diced", "to taste", etc.
    raw_text = Column(String(300), nullable=True)  # Original extracted text

    recipe = relationship("Recipe", back_populates="recipe_ingredients")
    ingredient = relationship("Ingredient", back_populates="recipe_ingredients")
