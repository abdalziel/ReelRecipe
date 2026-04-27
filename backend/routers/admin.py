"""
GET /api/admin/stats — full app metrics, admin-only
"""
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends
from sqlalchemy import func, case, or_
from sqlalchemy.orm import Session

from database import get_db
from models import User, Membership, Recipe
from services.auth import require_admin
from services.public_library import get_all as get_public_recipes

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/stats")
async def get_stats(
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    now = datetime.now(timezone.utc).replace(tzinfo=None)  # naive UTC to match DB columns
    cutoff_7d  = now - timedelta(days=7)
    cutoff_30d = now - timedelta(days=30)

    # ── Users ──────────────────────────────────────────────────────────────
    total_users = db.query(func.count(User.id)).scalar() or 0

    users_7d  = db.query(func.count(User.id)).filter(User.created_at >= cutoff_7d).scalar()  or 0
    users_30d = db.query(func.count(User.id)).filter(User.created_at >= cutoff_30d).scalar() or 0

    # Users who have at least one recipe
    active_users = (
        db.query(func.count(func.distinct(Recipe.user_id)))
        .filter(Recipe.user_id.isnot(None))
        .scalar() or 0
    )

    # Plan breakdown
    plan_rows = (
        db.query(Membership.plan, func.count(Membership.id))
        .group_by(Membership.plan)
        .all()
    )
    by_plan = {row[0]: row[1] for row in plan_rows}

    # ── Recipes ────────────────────────────────────────────────────────────
    total_recipes = db.query(func.count(Recipe.id)).scalar() or 0

    recipes_7d  = db.query(func.count(Recipe.id)).filter(Recipe.created_at >= cutoff_7d).scalar()  or 0
    recipes_30d = db.query(func.count(Recipe.id)).filter(Recipe.created_at >= cutoff_30d).scalar() or 0

    recipes_with_thumb = (
        db.query(func.count(Recipe.id))
        .filter(Recipe.thumbnail_url.isnot(None))
        .scalar() or 0
    )

    # Anonymous vs authenticated
    auth_recipes = (
        db.query(func.count(Recipe.id))
        .filter(Recipe.user_id.isnot(None))
        .scalar() or 0
    )
    anon_recipes = total_recipes - auth_recipes

    # By source type
    source_rows = (
        db.query(Recipe.source_type, func.count(Recipe.id))
        .group_by(Recipe.source_type)
        .all()
    )
    by_source = {(row[0] or "unknown"): row[1] for row in source_rows}

    # By meal type (top 6)
    meal_rows = (
        db.query(Recipe.meal_type, func.count(Recipe.id))
        .filter(Recipe.meal_type.isnot(None))
        .group_by(Recipe.meal_type)
        .order_by(func.count(Recipe.id).desc())
        .limit(6)
        .all()
    )
    by_meal_type = {row[0]: row[1] for row in meal_rows}

    # Top cuisines (top 8)
    cuisine_rows = (
        db.query(Recipe.cuisine, func.count(Recipe.id))
        .filter(Recipe.cuisine.isnot(None))
        .group_by(Recipe.cuisine)
        .order_by(func.count(Recipe.id).desc())
        .limit(8)
        .all()
    )
    top_cuisines = [{"name": row[0], "count": row[1]} for row in cuisine_rows]

    # Average recipes per authenticated user
    avg_per_user = round(auth_recipes / active_users, 1) if active_users else 0

    # ── Public library ─────────────────────────────────────────────────────
    try:
        public = await get_public_recipes()
        public_count = len(public)
    except Exception:
        public_count = 0

    # ── Recent signups (last 10) ───────────────────────────────────────────
    recent_users = (
        db.query(User.email, User.name, User.created_at)
        .order_by(User.created_at.desc())
        .limit(10)
        .all()
    )
    recent_signups = [
        {
            "email": row.email,
            "name": row.name,
            "joined": row.created_at.isoformat(),
        }
        for row in recent_users
    ]

    # ── Recent recipes (last 10) ───────────────────────────────────────────
    recent_recipe_rows = (
        db.query(Recipe.title, Recipe.source_type, Recipe.created_at)
        .order_by(Recipe.created_at.desc())
        .limit(10)
        .all()
    )
    recent_recipes = [
        {
            "title": row.title,
            "source": row.source_type,
            "added": row.created_at.isoformat(),
        }
        for row in recent_recipe_rows
    ]

    return {
        "users": {
            "total": total_users,
            "active": active_users,
            "new_7d": users_7d,
            "new_30d": users_30d,
            "by_plan": by_plan,
        },
        "recipes": {
            "total": total_recipes,
            "new_7d": recipes_7d,
            "new_30d": recipes_30d,
            "with_thumbnail": recipes_with_thumb,
            "auth_owned": auth_recipes,
            "anon_owned": anon_recipes,
            "avg_per_active_user": avg_per_user,
            "by_source": by_source,
            "by_meal_type": by_meal_type,
            "top_cuisines": top_cuisines,
        },
        "public_library": {
            "total": public_count,
        },
        "recent_signups": recent_signups,
        "recent_recipes": recent_recipes,
        "generated_at": now.isoformat(),
    }
