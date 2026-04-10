# RecipeReel — Setup Guide

## Prerequisites

- Python 3.11+
- Node.js 18+
- ffmpeg (`brew install ffmpeg`)
- Expo Go app on your iPhone/Android

---

## Backend Setup

```bash
cd backend

# Create virtualenv
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Add your API keys to .env
# ANTHROPIC_API_KEY = your Claude API key
# OPENAI_API_KEY = your OpenAI API key (for Whisper transcription)

# Start the API server
uvicorn main:app --reload --port 8000
```

API docs available at: http://localhost:8000/docs

---

## Mobile Setup

```bash
cd mobile

# Install dependencies
npm install

# Set your backend URL
# Edit .env → EXPO_PUBLIC_API_URL
# - Simulator: http://localhost:8000
# - Physical device: http://<your-machine-local-ip>:8000

# Start Expo
npx expo start
```

Scan the QR code with Expo Go on your phone.

---

## How to Use

### 1. Import a Reel
1. Open Instagram → find a cooking reel
2. Tap Share → Copy Link
3. In RecipeReel → "Add Reel" tab → paste URL → Import

### 2. Meal Planner
- Tap "+" on any day/meal slot to add a recipe manually
- Or tap **AI Align** (after setting a diet plan) to auto-fill the week

### 3. Shopping List
- From the Meal Planner, tap **Generate Shopping List**
- Check off items as you shop

### 4. Diet Goals
- Tap "Diet Goals" tab
- Type your goals naturally, or upload a PDF plan
- Claude analyzes it and extracts calorie/macro targets per meal

---

## Architecture

```
RecipeReel/
├── backend/          # FastAPI + SQLite
│   ├── main.py
│   ├── models/       # SQLAlchemy models
│   ├── routers/      # API endpoints
│   └── services/     # AI, video processing, shopping logic
└── mobile/           # Expo React Native
    └── app/
        ├── (tabs)/   # Main navigation tabs
        └── recipe/   # Recipe detail screen
```
