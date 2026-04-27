import os
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from sqlalchemy import inspect, text

from config import settings
from database import Base, engine, SessionLocal
from routers import reels, recipes, meal_plan, shopping_list, diet, instagram, public, auth, admin

limiter = Limiter(key_func=get_remote_address)
auth.router.limiter = limiter

# Create DB tables (no-op for tables that already exist)
Base.metadata.create_all(bind=engine)

# ── Schema migrations ─────────────────────────────────────────────────────
# Add columns that may be missing from older deployments.

_insp = inspect(engine)

# recipes table
if "recipes" in _insp.get_table_names():
    _existing = {c["name"] for c in _insp.get_columns("recipes")}
    for _col, _type in {"client_id": "VARCHAR(64)", "user_id": "INTEGER"}.items():
        if _col not in _existing:
            with engine.connect() as _c:
                _c.execute(text(f"ALTER TABLE recipes ADD COLUMN {_col} {_type}"))
                _c.commit()
            try:
                with engine.connect() as _c:
                    _c.execute(text(
                        f"CREATE INDEX IF NOT EXISTS ix_recipes_{_col} ON recipes ({_col})"
                    ))
                    _c.commit()
            except Exception:
                pass

# users table
if "users" in _insp.get_table_names():
    _existing = {c["name"] for c in _insp.get_columns("users")}
    if "is_admin" not in _existing:
        with engine.connect() as _c:
            _c.execute(text("ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0"))
            _c.commit()

# ── Promote admin account on startup ─────────────────────────────────────
# If ADMIN_EMAIL is set and the account exists, ensure is_admin = True.

if settings.admin_email:
    try:
        import sys
        from models import User, Membership
        with SessionLocal() as _db:
            _admin = _db.query(User).filter(
                User.email.ilike(settings.admin_email.strip())
            ).first()
            if _admin:
                _admin.is_admin = True
                if _admin.membership:
                    _admin.membership.plan = "pro"
                    _admin.membership.status = "active"
                else:
                    _db.add(Membership(user_id=_admin.id, plan="pro", status="active"))
                _db.commit()
                print(f"[startup] Admin promoted: {_admin.email}", file=sys.stderr)
            else:
                print(f"[startup] Admin account not found: {settings.admin_email}", file=sys.stderr)
    except Exception as _e:
        import sys
        print(f"[startup] Admin promotion error: {_e}", file=sys.stderr)

# ── App setup ─────────────────────────────────────────────────────────────

os.makedirs(os.path.join(settings.upload_dir, "thumbnails"), exist_ok=True)
os.makedirs("./static", exist_ok=True)

app = FastAPI(
    title="ReelRecipe API",
    description="Instagram reel → recipe → meal plan → shopping list",
    version="1.0.0",
    docs_url="/api-docs",
    redoc_url=None,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/uploads", StaticFiles(directory=settings.upload_dir), name="uploads")
app.mount("/static",  StaticFiles(directory="./static"),          name="static")

app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(reels.router)
app.include_router(recipes.router)
app.include_router(meal_plan.router)
app.include_router(shopping_list.router)
app.include_router(diet.router)
app.include_router(instagram.router)
app.include_router(public.router)


@app.get("/", include_in_schema=False)
def dashboard():
    return FileResponse("./static/index.html")


@app.get("/health")
def health():
    return {"status": "ok", "version": "1.0.0"}
