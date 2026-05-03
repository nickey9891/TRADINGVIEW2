#!/usr/bin/env bash
# Launch TradingView Desktop with CDP enabled for the tradingview-mcp server.
# If Desktop is not installed, falls back to launching TradingView web in Chromium.

CDP_PORT=9222

# ── 1. Try TradingView Desktop ──────────────────────────────────────────────
TV_PATHS=(
  "/opt/TradingView/tradingview"
  "/opt/TradingView/TradingView"
  "$HOME/.local/share/TradingView/TradingView"
  "/usr/bin/tradingview"
  "/snap/tradingview/current/tradingview"
  "/Applications/TradingView.app/Contents/MacOS/TradingView"
)

for p in "${TV_PATHS[@]}"; do
  if [ -x "$p" ]; then
    echo "[+] Launching TradingView Desktop: $p"
    "$p" "--remote-debugging-port=$CDP_PORT" &
    sleep 5
    if curl -s "http://localhost:$CDP_PORT/json/version" >/dev/null 2>&1; then
      echo "[+] TradingView running on CDP port $CDP_PORT"
      exit 0
    fi
  fi
done

# ── 2. Fall back to Chromium + TradingView web ───────────────────────────────
CHROMIUM_PATHS=(
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
  "/usr/bin/chromium"
  "/usr/bin/chromium-browser"
  "/usr/bin/google-chrome"
  "/usr/local/bin/chromium"
)

CHROMIUM=""
for p in "${CHROMIUM_PATHS[@]}"; do
  if [ -n "$p" ] && [ -x "$p" ]; then
    CHROMIUM="$p"
    break
  fi
done

if [ -z "$CHROMIUM" ]; then
  echo "[-] Neither TradingView Desktop nor Chromium found."
  echo "    Install TradingView Desktop from https://www.tradingview.com/desktop/"
  echo "    or install Chromium: apt-get install chromium-browser"
  exit 1
fi

# Start a virtual display if no DISPLAY is set
if [ -z "$DISPLAY" ]; then
  if command -v Xvfb >/dev/null 2>&1; then
    echo "[+] Starting Xvfb virtual display on :99"
    Xvfb :99 -screen 0 1920x1080x24 -ac &
    sleep 2
    export DISPLAY=:99
  fi
fi

# Import sandbox CA cert if present (for TLS-inspecting proxies)
ANTHROPIC_CA="/tmp/anthropic-ca.pem"
if [ ! -f "$ANTHROPIC_CA" ]; then
  openssl s_client -connect www.tradingview.com:443 -showcerts 2>/dev/null | \
    awk 'BEGIN{n=0} /BEGIN CERT/{n++} n==2,/END CERT/{print}' > "$ANTHROPIC_CA" 2>/dev/null || true
fi

PROFILE_DIR="/tmp/tv-chrome-profile"
mkdir -p "$PROFILE_DIR"
if [ -f "$ANTHROPIC_CA" ] && command -v certutil >/dev/null 2>&1; then
  certutil -N --empty-password -d "sql:$PROFILE_DIR" 2>/dev/null || true
  certutil -A -d "sql:$PROFILE_DIR" -n "AnthropicProxy" -t "CT,," -i "$ANTHROPIC_CA" 2>/dev/null || true
fi

echo "[+] Launching Chromium with TradingView web on CDP port $CDP_PORT"
DISPLAY="$DISPLAY" "$CHROMIUM" \
  "--remote-debugging-port=$CDP_PORT" \
  --remote-debugging-address=127.0.0.1 \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --ignore-certificate-errors \
  "--user-data-dir=$PROFILE_DIR" \
  --app=https://www.tradingview.com/chart/ \
  >/tmp/chrome-tv.log 2>&1 &

echo "[+] Waiting for CDP..."
for i in $(seq 1 15); do
  sleep 2
  if curl -s "http://localhost:$CDP_PORT/json/version" >/dev/null 2>&1; then
    echo "[+] CDP ready on port $CDP_PORT"
    echo "[+] TradingView is loading — use tv_health_check to verify"
    exit 0
  fi
done

echo "[-] CDP did not respond after 30s. Check /tmp/chrome-tv.log"
exit 1
