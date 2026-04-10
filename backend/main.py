import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from database import Base, engine
from routers import reels, recipes, meal_plan, shopping_list, diet, instagram

# Create DB tables
Base.metadata.create_all(bind=engine)

# Ensure directories exist
os.makedirs("./uploads/thumbnails", exist_ok=True)
os.makedirs("./static", exist_ok=True)

app = FastAPI(
    title="ReelRecipe API",
    description="Instagram reel → recipe → meal plan → shopping list",
    version="1.0.0",
    docs_url="/api-docs",   # move Swagger to /api-docs, free up / for dashboard
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve uploaded thumbnails
app.mount("/uploads", StaticFiles(directory="./uploads"), name="uploads")

# Serve dashboard static assets
app.mount("/static", StaticFiles(directory="./static"), name="static")

# Routers
app.include_router(reels.router)
app.include_router(recipes.router)
app.include_router(meal_plan.router)
app.include_router(shopping_list.router)
app.include_router(diet.router)
app.include_router(instagram.router)


@app.get("/", include_in_schema=False)
def dashboard():
    return FileResponse("./static/index.html")


@app.get("/health")
def health():
    return {"status": "ok", "version": "1.0.0"}
