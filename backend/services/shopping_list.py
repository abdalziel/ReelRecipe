"""
Aggregates ingredients from a set of recipes into a deduplicated, categorized shopping list.
Handles unit normalization, quantity merging, and purchasable display formatting.
Claude is used as a post-processing step to convert cooking quantities into
real store-purchase recommendations (e.g. "3 cups cottage cheese" → "2 tubs (16 oz)").
"""
import json
from collections import defaultdict
from typing import List, Optional

from anthropic import AsyncAnthropic
from sqlalchemy.orm import Session

from config import settings
from models import Recipe, ShoppingList, ShoppingListItem, Ingredient

_claude = AsyncAnthropic(api_key=settings.anthropic_api_key)

_STORE_UNIT_PROMPT = """\
You are a grocery shopping assistant. Below is a list of ingredients with their \
aggregated cooking quantities (summed across multiple recipes). Convert each one \
to what a shopper should actually put in their cart at a grocery store.

Rules:
- NEVER suggest fractional packages (no "0.5 cans", "half a pumpkin", "0.3 bags")
- Always round UP to the nearest whole purchasable unit
- For spices, seasonings, oils, and condiments: just the ingredient name, no quantity
- For produce sold by the piece: use count ("3 lemons", "1 pumpkin", "2 heads garlic")
- For dairy: use standard container sizes (e.g. "1 tub (16 oz) cottage cheese", \
"1 block (8 oz) cream cheese", "2 sticks butter", "1 qt milk")
- For proteins: use weight or count as sold ("1.5 lbs chicken breast", "1 dozen eggs")
- For canned/packaged goods: use can or bag count ("2 cans (15 oz) chickpeas")
- For fresh herbs sold in bunches: "1 bunch parsley"
- If a quantity is tiny (< 2 tbsp of a pantry staple): just the name, no quantity

Ingredients (name → quantity + unit):
{ingredients}

Return ONLY a JSON array. Each element: {{"name": "<ingredient name>", "store_text": "<what to buy>"}}
No explanation, no markdown, just the JSON array.
"""


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


async def _apply_store_units(merged: dict) -> dict:
    """
    Call Claude to replace display_text with store-purchase recommendations.
    Falls back silently to the original display_text if the call fails.
    """
    lines = []
    for name, data in merged.items():
        qty = data["quantity"]
        unit = data["unit"] or ""
        if qty and qty > 0:
            lines.append(f"{name}: {qty:.2g} {unit}".strip())
        else:
            lines.append(name)

    try:
        resp = await _claude.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1024,
            messages=[{
                "role": "user",
                "content": _STORE_UNIT_PROMPT.format(ingredients="\n".join(lines)),
            }],
        )
        raw = resp.content[0].text.strip()
        # Strip markdown fences if present
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        items = json.loads(raw)
        store_map = {item["name"].lower().strip(): item["store_text"] for item in items}
        for name in merged:
            text = store_map.get(name.lower().strip())
            if text:
                merged[name]["display_text"] = text
    except Exception:
        pass  # Keep original display_text on any failure

    return merged


async def create_shopping_list_from_recipes(
    recipe_ids: List[int],
    servings_map: dict,
    meal_plan_id: Optional[int],
    name: str,
    grocery_run: int,
    db: Session,
) -> ShoppingList:
    """Build and persist a ShoppingList from the merged ingredient set."""
    merged = merge_ingredients(recipe_ids, servings_map, db)
    merged = await _apply_store_units(merged)

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


async def add_recipes_to_list(
    shopping_list: ShoppingList,
    recipe_ids: List[int],
    servings_map: dict,
    db: Session,
) -> ShoppingList:
    """
    Merge new recipes into an existing shopping list.
    Existing item quantities are combined with the new amounts;
    truly new ingredients are appended. Claude re-evaluates display
    text for every item that changed so store units stay accurate.
    """
    # Build a lookup of existing items keyed by ingredient name
    existing: dict = {
        item.ingredient.name.lower().strip(): item
        for item in shopping_list.items
    }

    # Aggregate the incoming recipes
    new_merged = merge_ingredients(recipe_ids, servings_map, db)

    # Combine: add new quantities on top of existing quantities
    combined: dict = {}
    for name, item in existing.items():
        combined[name] = {
            "quantity": item.quantity or 0,
            "unit": item.unit or "",
            "display_text": item.display_text,
            "category": item.category or "other",
        }
    for name, data in new_merged.items():
        if name in combined:
            combined[name]["quantity"] = (combined[name]["quantity"] or 0) + (data["quantity"] or 0)
        else:
            combined[name] = data

    # Re-run Claude on the full combined set
    combined = await _apply_store_units(combined)

    # Persist: update existing rows, insert new ones
    for name, data in combined.items():
        ingredient = db.query(Ingredient).filter(Ingredient.name == name).first()
        if not ingredient:
            ingredient = Ingredient(name=name, category=data["category"])
            db.add(ingredient)
            db.flush()

        if name in existing:
            item = existing[name]
            item.quantity = data["quantity"]
            item.display_text = data["display_text"]
        else:
            db.add(ShoppingListItem(
                shopping_list_id=shopping_list.id,
                ingredient_id=ingredient.id,
                quantity=data["quantity"],
                unit=data["unit"],
                display_text=data["display_text"],
                category=data["category"],
            ))

    db.commit()
    db.refresh(shopping_list)
    return shopping_list


def group_items_by_category(shopping_list: ShoppingList) -> dict:
    """Return items grouped by category, in the standard store aisle order."""
    groups: dict = defaultdict(list)
    for item in shopping_list.items:
        groups[item.category or "other"].append(item)
    return {cat: groups[cat] for cat in CATEGORY_ORDER if cat in groups}
