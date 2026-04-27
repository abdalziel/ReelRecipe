"""
JWT-based authentication utilities and FastAPI dependencies.

Tokens:
  access  — 1 hour,  sent as Authorization: Bearer <token>
  refresh — 30 days, stored client-side, used to get a new access token

Scope dependency:
  get_scope() returns a Scope object that routers use to filter recipes
  to the authenticated user (user_id) or anonymous visitor (client_id).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional, TYPE_CHECKING

from fastapi import Depends, Header, HTTPException
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import or_
from sqlalchemy.orm import Session

from config import settings
from database import get_db

if TYPE_CHECKING:
    from models import User, Recipe

_PWD = CryptContext(schemes=["bcrypt"], deprecated="auto")
_ALGORITHM = "HS256"
_ACCESS_EXPIRE = timedelta(hours=1)
_REFRESH_EXPIRE = timedelta(days=30)

# Pre-computed hash used as a stand-in when the user doesn't exist, so the
# bcrypt work factor is always paid and timing doesn't reveal account existence.
DUMMY_HASH = _PWD.hash("__dummy__")


# ── Password helpers ───────────────────────────────────────────────────────

def hash_password(password: str) -> str:
    return _PWD.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return _PWD.verify(plain, hashed)


# ── Token creation ─────────────────────────────────────────────────────────

def _make_token(payload: dict, expires: timedelta) -> str:
    data = {**payload, "exp": datetime.now(timezone.utc) + expires}
    return jwt.encode(data, settings.jwt_secret, algorithm=_ALGORITHM)


def create_access_token(user_id: int, email: str) -> str:
    return _make_token({"sub": str(user_id), "email": email, "type": "access"}, _ACCESS_EXPIRE)


def create_refresh_token(user_id: int) -> str:
    return _make_token({"sub": str(user_id), "type": "refresh"}, _REFRESH_EXPIRE)


# ── Token validation ───────────────────────────────────────────────────────

def _decode(token: str) -> dict:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[_ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token.")


def get_user_from_token(token: str, db: Session) -> "User":
    from models import User
    payload = _decode(token)
    if payload.get("type") != "access":
        raise HTTPException(status_code=401, detail="Invalid token type.")
    user = db.query(User).filter(User.id == int(payload["sub"])).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="Account not found.")
    return user


def get_user_id_from_refresh(token: str) -> int:
    payload = _decode(token)
    if payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid token type.")
    return int(payload["sub"])


# ── FastAPI dependencies ───────────────────────────────────────────────────

def get_optional_user(
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> Optional["User"]:
    """Resolves the caller to a User if a valid Bearer token is present, otherwise None."""
    if authorization and authorization.startswith("Bearer "):
        try:
            return get_user_from_token(authorization[7:], db)
        except HTTPException:
            pass
    return None


def require_user(user: Optional["User"] = Depends(get_optional_user)) -> "User":
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required.")
    return user


def require_admin(user: "User" = Depends(require_user)) -> "User":
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin access required.")
    return user


# ── Scope: unified owner filter for recipe queries ─────────────────────────

class Scope:
    """
    Encapsulates the caller's identity — either an authenticated User or an
    anonymous client UUID.  Routers use `.filter_recipes(q)` to scope queries
    without caring which form of identity was provided.
    """

    def __init__(self, user: Optional["User"], client_id: Optional[str]):
        self.user = user
        self.client_id = client_id

    @property
    def user_id(self) -> Optional[int]:
        return self.user.id if self.user else None

    def is_authenticated(self) -> bool:
        return self.user is not None

    def recipe_owner_kwargs(self) -> dict:
        """Keyword args to set ownership when creating a new Recipe."""
        if self.user:
            return {"user_id": self.user.id}
        return {"client_id": self.client_id}

    def filter_recipes(self, q):
        """Apply a WHERE clause to a Recipe query matching this scope."""
        from models import Recipe
        if self.user:
            return q.filter(Recipe.user_id == self.user.id)
        elif self.client_id:
            # Anonymous: own rows plus any legacy NULL-client_id rows
            return q.filter(
                or_(Recipe.client_id == self.client_id, Recipe.client_id.is_(None))
            )
        return q

    def owns_recipe(self, recipe: "Recipe") -> bool:
        """Check ownership without a DB query (useful for single-record endpoints)."""
        if self.user:
            return recipe.user_id == self.user.id
        if self.client_id:
            return recipe.client_id == self.client_id or recipe.client_id is None
        return recipe.client_id is None and recipe.user_id is None


def get_scope(
    user: Optional["User"] = Depends(get_optional_user),
    x_client_id: Optional[str] = Header(None, alias="X-Client-ID"),
) -> Scope:
    return Scope(user, x_client_id)


def get_recipe_or_404(recipe_id: int, scope: Scope, db: Session) -> "Recipe":
    from models import Recipe
    q = db.query(Recipe).filter(Recipe.id == recipe_id)
    recipe = scope.filter_recipes(q).first()
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found.")
    return recipe
