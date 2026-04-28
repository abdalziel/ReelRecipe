"""
Content-based recipe duplicate detection.
Compares title similarity and ingredient overlap rather than source URL,
so the same recipe imported from two different sources is caught.
"""
import difflib
import re
from typing import Optional

from sqlalchemy.orm import Session

from models import Recipe


def _norm(text: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace."""
    text = text.lower()
    text = re.sub(r"[^\w\s]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def find_duplicate(
    title: str,
    ingredient_names: list,
    db: Session,
    base_query=None,
) -> Optional[Recipe]:
    """
    Return an existing Recipe that is semantically the same as the given
    title + ingredient list, or None if no duplicate is found.

    Duplicate criteria (either condition triggers a match):
      1. Title similarity >= 82%
      2. Title similarity >= 50% AND ingredient name overlap >= 60%

    Pass base_query to scope the search (e.g. scope.filter_recipes(db.query(Recipe))).
    """
    norm_title = _norm(title)
    new_ings = {_norm(n) for n in ingredient_names if n.strip()}

    for recipe in (base_query or db.query(Recipe)).all():
        title_sim = difflib.SequenceMatcher(
            None, norm_title, _norm(recipe.title)
        ).ratio()

        if title_sim >= 0.82:
            return recipe

        if title_sim >= 0.50 and new_ings:
            existing_ings = {
                _norm(ri.ingredient.name)
                for ri in recipe.recipe_ingredients
            }
            if existing_ings:
                overlap = len(new_ings & existing_ings) / max(
                    len(new_ings), len(existing_ings)
                )
                if overlap >= 0.60:
                    return recipe

    return None
