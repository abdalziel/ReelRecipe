#!/bin/bash

# ─── ReelRecipe Launcher ────────────────────────────────────────────────────
# Double-click this file in Finder to start the ReelRecipe backend server.
# Your phone must be on the same Wi-Fi network as this Mac.
# ────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:/opt/homebrew/bin:$PATH"

clear
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "        🍴 ReelRecipe — Starting Up"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Check Python venv ──────────────────────────────────────────────────────
# Rebuild venv if missing, broken, or has stale absolute paths (e.g. after rename)
VENV_OK=false
if [ -f "$BACKEND_DIR/venv/bin/activate" ]; then
  # Resolve the python symlink and check the actual binary exists
  PYTHON_BIN=$(readlink -f "$BACKEND_DIR/venv/bin/python3" 2>/dev/null)
  if [ -n "$PYTHON_BIN" ] && [ -x "$PYTHON_BIN" ]; then
    VENV_OK=true
  fi
fi

if [ "$VENV_OK" = false ]; then
  echo "⚙️  Setting up Python environment..."
  rm -rf "$BACKEND_DIR/venv"
  cd "$BACKEND_DIR"
  python3 -m venv venv
  source venv/bin/activate
  pip install --upgrade pip setuptools --quiet
  pip install -r requirements.txt --quiet
  echo "✅ Environment ready."
  echo ""
else
  source "$BACKEND_DIR/venv/bin/activate"
fi

# ── Check .env ─────────────────────────────────────────────────────────────
if grep -q "your_anthropic_api_key_here" "$BACKEND_DIR/.env" 2>/dev/null; then
  echo "⚠️  Missing API key!"
  echo ""
  echo "   Open this file and fill in your Anthropic API key:"
  echo "   $BACKEND_DIR/.env"
  echo ""
  echo "   Then re-run this launcher."
  echo ""
  read -p "Press Enter to exit..."
  exit 1
fi

# ── Get local IP for phone connection ─────────────────────────────────────
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "localhost")

echo "✅ Environment OK"
echo ""

# ── Start Cloudflare Tunnel (if configured) ────────────────────────────────
TUNNEL_CONFIG="$SCRIPT_DIR/cloudflared.yml"
TUNNEL_ACTIVE=false
if command -v cloudflared &>/dev/null && [ -f "$TUNNEL_CONFIG" ] && ! grep -q "YOUR_TUNNEL_ID" "$TUNNEL_CONFIG"; then
  echo "🌐 Starting Cloudflare Tunnel..."
  cloudflared tunnel --config "$TUNNEL_CONFIG" run &>/tmp/reelrecipe-tunnel.log &
  TUNNEL_PID=$!
  sleep 2
  TUNNEL_ACTIVE=true
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Backend API:  http://localhost:8000"
echo " Phone URL:    http://$LOCAL_IP:8000"
echo " API Docs:     http://localhost:8000/docs"
if [ "$TUNNEL_ACTIVE" = true ]; then
echo " Public URL:   https://reelrecipe.ai"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " Make sure your mobile .env points to:"
echo " EXPO_PUBLIC_API_URL=http://$LOCAL_IP:8000"
echo ""
echo " Press Ctrl+C to stop the server."
echo ""

# Open Safari after a short delay so the server is ready
(sleep 2 && open -a Safari "http://localhost:8000") &

cd "$BACKEND_DIR"
"$BACKEND_DIR/venv/bin/uvicorn" main:app --host 0.0.0.0 --port 8000
