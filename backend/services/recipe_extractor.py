"""
Uses Claude to extract structured recipe data from multiple source types:
  - Video transcript + description (Instagram reel)
  - Web page content (any recipe website)
  - Image (photo of a recipe card or cookbook page)
"""
import base64
import json
from typing import Optional

from anthropic import AsyncAnthropic

from config import settings

claude = AsyncAnthropic(api_key=settings.anthropic_api_key)


class NoRecipeFoundError(Exception):
    """Raised when the reel content does not contain a food recipe."""
    pass


RECIPE_EXTRACTION_PROMPT = """You are a culinary AI assistant. Extract a complete, structured recipe from the following content from an Instagram reel.

Video Title: {title}
Video Description: {description}
Transcript: {transcript}

First, determine if this content contains an actual food recipe (ingredients, steps, or clear cooking instructions). If it does NOT — for example it's about fitness, travel, fashion, comedy, or any non-food topic — return ONLY this exact JSON:
{{"is_recipe": false}}

If it IS a food recipe, return a JSON object with EXACTLY this structure:
{{
  "is_recipe": true,
  "title": "Recipe name",
  "description": "1-2 sentence description",
  "servings": 2,
  "prep_time_minutes": 10,
  "cook_time_minutes": 20,
  "cuisine": "Italian",
  "meal_type": "dinner",
  "tags": ["quick", "healthy", "pasta"],
  "steps": [
    "Step 1 description",
    "Step 2 description"
  ],
  "ingredients": [
    {{
      "raw_text": "2 cups all-purpose flour",
      "name": "all-purpose flour",
      "quantity": 2.0,
      "unit": "cups",
      "notes": null,
      "category": "pantry"
    }}
  ],
  "macros_per_serving": {{
    "calories": 450,
    "protein_g": 35,
    "carbs_g": 40,
    "fat_g": 12
  }}
}}

Rules:
- meal_type must be one of: breakfast, lunch, dinner, snack
- ingredient category must be one of: produce, protein, dairy, pantry, frozen, spice, beverage, other
- Estimate macros based on ingredients if not stated — be reasonably accurate
- If information is missing or unclear, make reasonable culinary assumptions
- Return ONLY the JSON object, no other text
"""


async def extract_recipe_from_reel(
    title: str,
    transcript: Optional[str],
    description: Optional[str] = "",
) -> dict:
    """Call Claude to extract a structured recipe from reel content.
    Raises NoRecipeFoundError if the content is not a food recipe.
    """
    prompt = RECIPE_EXTRACTION_PROMPT.format(
        title=title,
        description=description or "",
        transcript=transcript or "No transcript available.",
    )

    message = await claude.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = message.content[0].text.strip()

    # Strip markdown code fences if present
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    raw = raw.strip()

    data = json.loads(raw)

    if not data.get("is_recipe", True):
        raise NoRecipeFoundError(title)

    return data


_JSON_STRUCTURE = """{
  "is_recipe": true,
  "title": "Recipe name",
  "description": "1-2 sentence description",
  "servings": 2,
  "prep_time_minutes": 10,
  "cook_time_minutes": 20,
  "cuisine": "Italian",
  "meal_type": "dinner",
  "tags": ["quick", "healthy"],
  "steps": ["Step 1", "Step 2"],
  "ingredients": [
    {
      "raw_text": "2 cups all-purpose flour",
      "name": "all-purpose flour",
      "quantity": 2.0,
      "unit": "cups",
      "notes": null,
      "category": "pantry"
    }
  ],
  "macros_per_serving": {
    "calories": 450,
    "protein_g": 35,
    "carbs_g": 40,
    "fat_g": 12
  }
}"""

_RULES = """Rules:
- meal_type must be one of: breakfast, lunch, dinner, snack
- ingredient category must be one of: produce, protein, dairy, pantry, frozen, spice, beverage, other
- Estimate macros based on ingredients if not stated
- If information is missing, make reasonable culinary assumptions
- Return ONLY the JSON object, no other text"""

WEB_EXTRACTION_PROMPT = """You are a culinary AI assistant. Extract a complete, structured recipe from this web page content.

Title (from page): {title}
Ingredients found (may be raw strings): {ingredients}
Page content / instructions:
{instructions}

If this is NOT a food recipe, return ONLY: {{"is_recipe": false}}

Otherwise return:
{json_structure}

{rules}"""

IMAGE_EXTRACTION_PROMPT = """You are a culinary AI assistant. Extract the complete recipe from this image.
It may be a handwritten recipe card, a cookbook page, a printed recipe, or a screenshot.

If this image does NOT contain a food recipe, return ONLY: {{"is_recipe": false}}

Otherwise return:
{json_structure}

{rules}"""


async def extract_recipe_from_web(
    title: str,
    ingredients: list,
    instructions: str,
) -> dict:
    """
    Extract a structured recipe from web page content.
    Raises NoRecipeFoundError if the content is not a food recipe.
    """
    prompt = WEB_EXTRACTION_PROMPT.format(
        title=title or "(unknown)",
        ingredients="\n".join(f"- {i}" for i in ingredients) if ingredients else "(none — use instructions text)",
        instructions=instructions[:4000],
        json_structure=_JSON_STRUCTURE,
        rules=_RULES,
    )
    message = await claude.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )
    return _parse_response(message.content[0].text, title)


async def extract_recipe_from_image(image_bytes: bytes, media_type: str = "image/jpeg") -> dict:
    """
    Use Claude vision to extract a recipe from a photo of a recipe card or cookbook.
    Raises NoRecipeFoundError if the image does not contain a food recipe.
    """
    b64 = base64.standard_b64encode(image_bytes).decode("utf-8")
    message = await claude.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4096,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": media_type, "data": b64},
                },
                {
                    "type": "text",
                    "text": IMAGE_EXTRACTION_PROMPT.format(
                        json_structure=_JSON_STRUCTURE,
                        rules=_RULES,
                    ),
                },
            ],
        }],
    )
    return _parse_response(message.content[0].text, "photo import")


def _parse_response(raw: str, title_hint: str) -> dict:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    data = json.loads(raw.strip())
    if not data.get("is_recipe", True):
        raise NoRecipeFoundError(title_hint)
    return data


INGREDIENT_CATEGORIZATION_PROMPT = """Given this ingredient name, return ONLY the single best category from this list:
produce, protein, dairy, pantry, frozen, spice, beverage, other

Ingredient: {name}
Category:"""


async def categorize_ingredient(name: str) -> str:
    """Quick single-ingredient categorization via Claude."""
    message = await claude.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=10,
        messages=[
            {
                "role": "user",
                "content": INGREDIENT_CATEGORIZATION_PROMPT.format(name=name),
            }
        ],
    )
    result = message.content[0].text.strip().lower()
    valid = {"produce", "protein", "dairy", "pantry", "frozen", "spice", "beverage", "other"}
    return result if result in valid else "other"
