#!/bin/bash
# render.sh — Chrome headless renderer for the DeepSeek Harness architecture diagram.
#
# Writes arch-en.png and arch-zh.png (3072×1160, ~600 KB each) to the given output
# directory. Default is <repo>/assets/, which is where the README image references
# resolve.
#
# Usage:
#   bash render.sh                    # writes to <repo>/assets/
#   bash render.sh /some/other/dir    # writes there instead
#
# Env overrides:
#   CHROME=/path/to/Chrome       # non-standard Chrome location
#   PORT=<n>                     # override the local http.server port

set -e

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
OUT_DIR="${1:-$REPO_ROOT/assets}"
BIND_PORT="${PORT:-0}"   # 0 → kernel picks a free port
SERVER_LOG="$(mktemp -t dsh-arch-diagram-server.XXXXXX.log)"

# Locate a Chrome / Chromium binary. Honour $CHROME if set; otherwise probe
# common per-platform paths so `bash render.sh` works on macOS + Linux out
# of the box.
if [ -z "$CHROME" ]; then
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v google-chrome 2>/dev/null || true)" \
    "$(command -v google-chrome-stable 2>/dev/null || true)" \
    "$(command -v chromium 2>/dev/null || true)" \
    "$(command -v chromium-browser 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      CHROME="$candidate"; break
    fi
  done
fi

if [ -z "$CHROME" ] || [ ! -x "$CHROME" ]; then
  echo "No Chrome / Chromium binary found." >&2
  echo "Tried: macOS default, google-chrome, google-chrome-stable, chromium, chromium-browser." >&2
  echo "Set CHROME=/path/to/binary and rerun." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

python3 -u -m http.server "$BIND_PORT" --bind 127.0.0.1 --directory "$SKILL_DIR" \
  >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null; rm -f "$SERVER_LOG"; }
trap cleanup EXIT INT TERM

# Discover the actual bound port from Python's own startup line
# ("Serving HTTP on 127.0.0.1 port <N> ..."). Works whether the kernel
# picked it or PORT was set explicitly; no external `lsof` needed.
PORT=""
for _ in $(seq 1 40); do
  PORT=$(awk '/Serving HTTP on/ {print $6; exit}' "$SERVER_LOG" 2>/dev/null || true)
  [ -n "$PORT" ] && break
  # Bail early if the server died (e.g. explicit PORT already in use).
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.05
done
if [ -z "$PORT" ]; then
  echo "Failed to detect local server port. Server log:" >&2
  cat "$SERVER_LOG" >&2 || true
  exit 1
fi

# Chrome/Chromium refuses to run as root without --no-sandbox. Rendering
# a local static HTML doc under a headless browser doesn't need Chrome's
# own sandbox, so passing the flag when EUID is 0 makes the script work
# in Codex/CI container environments that default to root.
CHROME_EXTRA_ARGS=()
if [ "$(id -u)" = "0" ]; then
  CHROME_EXTRA_ARGS+=(--no-sandbox)
fi

for lang in en zh; do
  out="$OUT_DIR/arch-$lang.png"
  "$CHROME" \
    "${CHROME_EXTRA_ARGS[@]}" \
    --headless=new \
    --disable-gpu \
    --hide-scrollbars \
    --force-device-scale-factor=2 \
    --window-size=1820,580 \
    --virtual-time-budget=8000 \
    --screenshot="$out" \
    "http://127.0.0.1:$PORT/harness-arch-$lang.html" \
    2>/dev/null
  size=$(du -h "$out" | awk '{print $1}')
  echo "[$lang] wrote $out ($size)"
done
