"""
Parses diet plan content (text, PDF, or natural language description)
and uses Claude to extract structured macro/meal targets.
"""
import json
from typing import Optional

import pdfplumber
from anthropic import AsyncAnthropic

from config import settings

claude = AsyncAnthropic(api_key=settings.anthropic_api_key)

DIET_ANALYSIS_PROMPT = """You are a nutrition and diet expert. Analyze the following diet plan or goals description and extract structured nutritional targets.

Diet Plan Content:
{content}

Return a JSON object with EXACTLY this structure:
{{
  "diet_type": "high protein / keto / Mediterranean / etc.",
  "daily_calories": 2200,
  "daily_protein_g": 180,
  "daily_carbs_g": 200,
  "daily_fat_g": 70,
  "restrictions": ["gluten-free", "no dairy"],
  "goals": "Brief summary of the person's goals",
  "meal_targets": {{
    "breakfast": {{
      "calories": 400,
      "protein_g": 35,
      "carbs_g": 40,
      "fat_g": 12
    }},
    "lunch": {{
      "calories": 600,
      "protein_g": 50,
      "carbs_g": 60,
      "fat_g": 18
    }},
    "dinner": {{
      "calories": 700,
      "protein_g": 55,
      "carbs_g": 65,
      "fat_g": 22
    }},
    "snack": {{
      "calories": 250,
      "protein_g": 20,
      "carbs_g": 20,
      "fat_g": 8
    }}
  }},
  "analysis": "Detailed analysis of the diet plan, goals, and how meals should be structured"
}}

Rules:
- Infer values intelligently if not explicitly stated
- Distribute daily totals across meals in a sensible way if per-meal targets aren't given
- restrictions is an array of strings (empty array if none)
- Return ONLY the JSON object, no other text
"""

MEAL_ALIGNMENT_PROMPT = """You are a nutrition expert and meal planner. Given a user's diet plan and a list of available recipes with their macros, suggest an optimized weekly meal plan that meets the diet goals.

Diet Plan:
{diet_plan}

Available Recipes:
{recipes}

Current Week Start: {week_start}

Return a JSON array of meal plan entries:
[
  {{
    "day_of_week": 0,
    "meal_slot": "breakfast",
    "recipe_id": 12,
    "servings": 1,
    "reason": "High protein, fits breakfast macro targets"
  }}
]

Rules:
- day_of_week: 0=Monday, 1=Tuesday, ..., 6=Sunday
- meal_slot: breakfast, lunch, dinner, or snack
- Try to cover 7 days with all 3 main meals + 1-2 snacks per day
- Group recipes with overlapping ingredients on consecutive days to minimize waste
- Match macros as closely as possible to targets per meal
- Only use recipe_ids from the provided list
- Prioritize variety across the week
- Return ONLY the JSON array, no other text
"""


async def analyze_diet_plan(content: str) -> dict:
    """Parse free-form diet plan text/description into structured targets."""
    message = await claude.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        messages=[
            {
                "role": "user",
                "content": DIET_ANALYSIS_PROMPT.format(content=content),
            }
        ],
    )
    raw = message.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw.strip())


async def suggest_meal_plan(diet_plan: dict, recipes: list, week_start: str) -> list:
    """Use Claude to suggest an optimized weekly meal plan."""
    recipes_summary = json.dumps(
        [
            {
                "id": r["id"],
                "title": r["title"],
                "meal_type": r["meal_type"],
                "macros_per_serving": {
                    "calories": r.get("calories"),
                    "protein_g": r.get("protein_g"),
                    "carbs_g": r.get("carbs_g"),
                    "fat_g": r.get("fat_g"),
                },
                "tags": r.get("tags", []),
            }
            for r in recipes
        ],
        indent=2,
    )

    message = await claude.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4096,
        messages=[
            {
                "role": "user",
                "content": MEAL_ALIGNMENT_PROMPT.format(
                    diet_plan=json.dumps(diet_plan, indent=2),
                    recipes=recipes_summary,
                    week_start=week_start,
                ),
            }
        ],
    )
    raw = message.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return json.loads(raw.strip())


def extract_text_from_pdf(file_path: str) -> str:
    """Extract plain text from a PDF file using pdfplumber."""
    text_parts = []
    with pdfplumber.open(file_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text()
            if text:
                text_parts.append(text)
    return "\n".join(text_parts)
