"""
Aggregates ingredients from a set of recipes into a deduplicated, categorized shopping list.
Handles unit normalization, quantity merging, and purchasable display formatting.
"""
from collections import defaultdict
from typing import List, Optional

from sqlalchemy.orm import Session

from models import Recipe, ShoppingList, ShoppingListItem, Ingredient


CATEGORY_ORDER = ["produce", "protein", "dairy", "pantry", "frozen", "spice", "beverage", "other"]

# Produce items measured in small volume units → estimate purchasable count
# key: substring match on ingredient name
# value: (tsp_per_unit, singular_unit, plural_unit)
PRODUCE_COUNT_MAP = {
    "garlic":  (3,  "clove",        "cloves"),
    "ginger":  (6,  "knob",         "knobs"),
    "onion":   (48, "onion",        "onions"),    # ~1 cup diced = 1 onion, 1 cup = 48 tsp
    "shallot": (12, "shallot",      "shallots"),
    "tomato":  (48, "tomato",       "tomatoes"),
    "lemon":   (9,  "lemon",        "lemons"),    # ~3 tbsp juice per lemon
    "lime":    (6,  "lime",         "limes"),
    "orange":  (12, "orange",       "oranges"),
    "jalapeño":(12, "jalapeño",     "jalapeños"),
    "jalapeno":(12, "jalapeño",     "jalapeños"),
    "chili":   (12, "chili",        "chilies"),
    "scallion":(3,  "scallion",     "scallions"),
    "cilantro":(3,  "bunch",        "bunches of cilantro"),
    "parsley": (3,  "bunch",        "bunches of parsley"),
    "basil":   (3,  "bunch",        "bunches of basil"),
}


def _to_tsp(qty: float, unit: str) -> float:
    """Normalize a quantity to teaspoons."""
    u = unit.lower().strip()
    if u in ("tbsp", "tablespoon", "tablespoons"):
        return qty * 3
    if u in ("cup", "cups"):
        return qty * 48
    # Already tsp or unknown small unit
    return qty


def _format_display(name: str, qty: float, unit: str, category: str) -> str:
    """Format a shopping list item in a purchasable, human-friendly way."""
    unit_lower = (unit or "").lower().strip()
    is_small = unit_lower in {"tsp", "teaspoon", "teaspoons",
                               "tbsp", "tablespoon", "tablespoons"}

    # ── Spices: just the name, no quantity ────────────────────────────────
    if category == "spice":
        return name.capitalize()

    # ── Produce in small measures: estimate a countable unit ──────────────
    if category == "produce" and is_small:
        tsp_total = _to_tsp(qty, unit_lower)
        name_lower = name.lower()
        for key, (tsp_per, singular, plural) in PRODUCE_COUNT_MAP.items():
            if key in name_lower:
                count = max(1, round(tsp_total / tsp_per))
                label = singular if count == 1 else plural
                return f"{count} {label}"
        # Unknown produce in small measure — just list the name
        return name.capitalize()

    # ── Pantry items in small measures: just the name ─────────────────────
    if category == "pantry" and is_small:
        return name.capitalize()

    # ── Standard display with quantity ────────────────────────────────────
    if qty and qty > 0:
        qty_str = str(int(qty)) if qty == int(qty) else f"{qty:.1f}"
        return f"{qty_str} {unit} {name}".strip() if unit else f"{qty_str} {name}"

    return name.capitalize()


def merge_ingredients(recipe_ids: List[int], servings_map: dict, db: Session) -> dict:
    """
    Given a list of recipe IDs and a servings map {recipe_id: servings},
    aggregate all ingredients, merging duplicates by name.
    Returns: {ingredient_name: {quantity, unit, display_text, category}}
    """
    merged: dict = defaultdict(lambda: {"quantity": 0, "unit": "", "category": "other"})

    for recipe_id in recipe_ids:
        recipe = db.query(Recipe).filter(Recipe.id == recipe_id).first()
        if not recipe:
            continue
        multiplier = servings_map.get(recipe_id, 1)

        for ri in recipe.recipe_ingredients:
            ing = ri.ingredient
            key = ing.name.lower().strip()
            qty = (ri.quantity or 0) * multiplier

            merged[key]["category"] = ing.category or "other"
            # Keep the first unit seen
            if not merged[key]["unit"] and ri.unit:
                merged[key]["unit"] = ri.unit
            merged[key]["quantity"] += qty

    result = {}
    for name, data in merged.items():
        qty = data["quantity"]
        unit = data["unit"]
        display = _format_display(name, qty if qty > 0 else 0, unit, data["category"])
        result[name] = {
            "quantity": qty if qty > 0 else None,
            "unit": unit or None,
            "display_text": display,
            "category": data["category"],
        }

    return result


def create_shopping_list_from_recipes(
    recipe_ids: List[int],
    servings_map: dict,
    meal_plan_id: Optional[int],
    name: str,
    grocery_run: int,
    db: Session,
) -> ShoppingList:
    """Build and persist a ShoppingList from the merged ingredient set."""
    merged = merge_ingredients(recipe_ids, servings_map, db)

    shopping_list = ShoppingList(
        meal_plan_id=meal_plan_id,
        name=name,
        grocery_run=grocery_run,
    )
    db.add(shopping_list)
    db.flush()

    for ing_name, data in merged.items():
        ingredient = db.query(Ingredient).filter(Ingredient.name == ing_name).first()
        if not ingredient:
            ingredient = Ingredient(name=ing_name, category=data["category"])
            db.add(ingredient)
            db.flush()

        item = ShoppingListItem(
            shopping_list_id=shopping_list.id,
            ingredient_id=ingredient.id,
            quantity=data["quantity"],
            unit=data["unit"],
            display_text=data["display_text"],
            category=data["category"],
        )
        db.add(item)

    db.commit()
    db.refresh(shopping_list)
    return shopping_list


def group_items_by_category(shopping_list: ShoppingList) -> dict:
    """Return items grouped by category, in the standard store aisle order."""
    groups: dict = defaultdict(list)
    for item in shopping_list.items:
        groups[item.category or "other"].append(item)
    return {cat: groups[cat] for cat in CATEGORY_ORDER if cat in groups}
