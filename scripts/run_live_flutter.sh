#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECTS="$ROOT/workspace/projects"
STATE="$ROOT/.flutter_live"
mkdir -p "$STATE"

# If already running → do nothing
if [ -f "$STATE/pid" ]; then
  PID=$(cat "$STATE/pid")
  if ps -p "$PID" >/dev/null 2>&1; then
    echo "⚠️ Flutter already running (PID=$PID)"
    exit 0
  fi
fi

LATEST_PROJECT="$(ls -td "$PROJECTS"/*/ | head -n 1)"
cd "$LATEST_PROJECT"

# Fresh fifo
rm -f "$STATE/stdin"
mkfifo "$STATE/stdin"

(
  flutter run -d macos < "$STATE/stdin"
) &
PID=$!
echo "$PID" > "$STATE/pid"

echo "✅ Flutter live started (PID=$PID)"
