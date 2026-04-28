"""
POST /api/auth/register        — create account, return tokens
POST /api/auth/login           — email + password, return tokens
POST /api/auth/refresh         — refresh token → new access token
GET  /api/auth/me              — current user profile + membership
POST /api/auth/claim-anonymous — migrate anonymous (client_id) recipes to the account
"""
import os
import uuid
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File
from pydantic import BaseModel, EmailStr
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from database import get_db
from models import User, Membership, Recipe
from services.auth import (
    hash_password,
    verify_password,
    create_access_token,
    create_refresh_token,
    get_user_id_from_refresh,
    require_user,
    get_scope,
    Scope,
    DUMMY_HASH,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])
limiter = Limiter(key_func=get_remote_address)


# ── Schemas ────────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    name: Optional[str] = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class ClaimRequest(BaseModel):
    client_id: str


class UpdateProfileRequest(BaseModel):
    name: Optional[str] = None
    email: Optional[EmailStr] = None


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


# ── Helpers ────────────────────────────────────────────────────────────────

def _token_response(user: User) -> dict:
    return {
        "access_token": create_access_token(user.id, user.email),
        "refresh_token": create_refresh_token(user.id),
        "token_type": "bearer",
        "user": _serialize_user(user),
    }


def _serialize_user(user: User) -> dict:
    m = user.membership
    return {
        "id": user.id,
        "email": user.email,
        "name": user.name,
        "is_admin": user.is_admin,
        "avatar_url": user.avatar_url,
        "plan": m.plan if m else "free",
        "status": m.status if m else "active",
        "created_at": user.created_at.isoformat(),
    }


def _ensure_membership(user: User, db: Session) -> None:
    """Create a free membership for the user if one doesn't exist."""
    if not user.membership:
        db.add(Membership(user_id=user.id, plan="free", status="active"))
        db.commit()


def _maybe_promote_admin(user: User, db: Session) -> None:
    """If this user's email matches ADMIN_EMAIL, ensure they have is_admin=True and plan=pro."""
    from config import settings as _s
    if not _s.admin_email:
        return
    if user.email.lower() != _s.admin_email.strip().lower():
        return
    changed = False
    if not user.is_admin:
        user.is_admin = True
        changed = True
    m = user.membership
    if m:
        if m.plan != "pro":
            m.plan = "pro"
            m.status = "active"
            changed = True
    else:
        db.add(Membership(user_id=user.id, plan="pro", status="active"))
        changed = True
    if changed:
        db.commit()
        db.refresh(user)


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.post("/register")
@limiter.limit("5/minute")
def register(request: Request, payload: RegisterRequest, db: Session = Depends(get_db)):
    if len(payload.password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    if db.query(User).filter(User.email == payload.email).first():
        raise HTTPException(status_code=409, detail="An account with that email already exists.")

    from config import settings as _s
    is_admin = bool(_s.admin_email and payload.email.lower() == _s.admin_email.strip().lower())
    user = User(
        email=payload.email,
        name=payload.name or payload.email.split("@")[0],
        password_hash=hash_password(payload.password),
        is_admin=is_admin,
    )
    db.add(user)
    db.flush()
    db.add(Membership(user_id=user.id, plan="pro" if is_admin else "free", status="active"))
    db.commit()
    db.refresh(user)
    return _token_response(user)


@router.post("/login")
@limiter.limit("10/minute")
def login(request: Request, payload: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == payload.email).first()
    # Always run bcrypt to prevent user-enumeration via timing differences.
    password_ok = verify_password(payload.password, user.password_hash if user and user.password_hash else DUMMY_HASH)
    if not user or not password_ok:
        raise HTTPException(status_code=401, detail="Incorrect email or password.")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is disabled.")
    _ensure_membership(user, db)
    _maybe_promote_admin(user, db)
    return _token_response(user)


@router.post("/refresh")
def refresh_token(payload: RefreshRequest, db: Session = Depends(get_db)):
    user_id = get_user_id_from_refresh(payload.refresh_token)
    user = db.query(User).filter(User.id == user_id, User.is_active == True).first()
    if not user:
        raise HTTPException(status_code=401, detail="Account not found.")
    _ensure_membership(user, db)
    return {
        "access_token": create_access_token(user.id, user.email),
        "token_type": "bearer",
    }


@router.get("/me")
def get_me(user: User = Depends(require_user), db: Session = Depends(get_db)):
    # Re-fetch via our session so _maybe_promote_admin can commit changes to the same session
    fresh = db.query(User).filter(User.id == user.id).first()
    if fresh:
        _maybe_promote_admin(fresh, db)
        return _serialize_user(fresh)
    return _serialize_user(user)


@router.patch("/me")
def update_me(
    payload: UpdateProfileRequest,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    fresh = db.query(User).filter(User.id == user.id).first()
    if payload.name is not None:
        stripped = payload.name.strip()
        if stripped:
            fresh.name = stripped
    if payload.email is not None and payload.email != fresh.email:
        if db.query(User).filter(User.email == payload.email, User.id != fresh.id).first():
            raise HTTPException(status_code=409, detail="That email is already in use.")
        fresh.email = payload.email
    db.commit()
    db.refresh(fresh)
    return _serialize_user(fresh)


@router.post("/change-password")
def change_password(
    payload: ChangePasswordRequest,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    fresh = db.query(User).filter(User.id == user.id).first()
    if not fresh.password_hash or not verify_password(payload.current_password, fresh.password_hash):
        raise HTTPException(status_code=401, detail="Current password is incorrect.")
    if len(payload.new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters.")
    fresh.password_hash = hash_password(payload.new_password)
    db.commit()
    return {"message": "Password changed successfully."}


@router.post("/avatar")
async def upload_avatar(
    file: UploadFile = File(...),
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    from config import settings as _s
    allowed = {"image/jpeg", "image/jpg", "image/png", "image/webp"}
    if file.content_type not in allowed:
        raise HTTPException(status_code=400, detail="Only JPEG, PNG, or WebP images are allowed.")
    data = await file.read()
    if len(data) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Avatar must be under 5 MB.")

    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in (file.filename or "") else "jpg"
    avatars_dir = os.path.join(_s.upload_dir, "avatars")
    os.makedirs(avatars_dir, exist_ok=True)
    filename = f"{user.id}_{uuid.uuid4().hex[:8]}.{ext}"
    path = os.path.join(avatars_dir, filename)
    with open(path, "wb") as f:
        f.write(data)

    fresh = db.query(User).filter(User.id == user.id).first()
    fresh.avatar_url = f"/uploads/avatars/{filename}"
    db.commit()
    db.refresh(fresh)
    return _serialize_user(fresh)


@router.post("/claim-admin")
def claim_admin(user: User = Depends(require_user), db: Session = Depends(get_db)):
    """Self-promote to admin if the caller's email matches ADMIN_EMAIL."""
    from config import settings as _s
    if not _s.admin_email:
        raise HTTPException(status_code=403, detail="No admin email configured on this server.")
    fresh = db.query(User).filter(User.id == user.id).first()
    if fresh.email.lower() != _s.admin_email.strip().lower():
        raise HTTPException(status_code=403, detail="Your email does not match the configured admin email.")
    fresh.is_admin = True
    m = fresh.membership
    if m:
        m.plan = "pro"
        m.status = "active"
    else:
        db.add(Membership(user_id=fresh.id, plan="pro", status="active"))
    db.commit()
    db.refresh(fresh)
    return _serialize_user(fresh)


@router.post("/claim-anonymous")
def claim_anonymous(
    payload: ClaimRequest,
    user: User = Depends(require_user),
    db: Session = Depends(get_db),
):
    """
    Migrate all anonymous recipes (matched by client_id) to this account.
    Called automatically after login/register when the user had a local library.
    """
    updated = (
        db.query(Recipe)
        .filter(Recipe.client_id == payload.client_id, Recipe.user_id.is_(None))
        .update({"user_id": user.id, "client_id": None}, synchronize_session=False)
    )
    db.commit()
    return {"claimed": updated}
