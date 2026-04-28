from datetime import datetime
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, UniqueConstraint
from database import Base


class RecipeRating(Base):
    __tablename__ = "recipe_ratings"

    id         = Column(Integer, primary_key=True)
    user_id    = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    recipe_id  = Column(Integer, ForeignKey("recipes.id"), nullable=False, index=True)
    rating     = Column(String(10), nullable=False)  # dislike | like | love
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (UniqueConstraint("user_id", "recipe_id", name="uq_user_recipe_rating"),)
