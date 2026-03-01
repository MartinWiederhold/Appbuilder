#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECTS="$ROOT/workspace/projects"
STATE="$ROOT/.flutter_live"
mkdir -p "$STATE"

LATEST_PROJECT="$(ls -td "$PROJECTS"/*/ | head -n 1)"
if [ -z "${LATEST_PROJECT:-}" ]; then
  echo "No Flutter project found"
  exit 1
fi

# Remember which Terminal window is running Flutter
osascript -e 'tell application "Terminal" to id of front window' > "$STATE/terminal_window_id" || true

# Kill old session if exists
if [ -f "$STATE/pid" ]; then
  OLD_PID="$(cat "$STATE/pid" || true)"
  if [ -n "${OLD_PID:-}" ] && ps -p "$OLD_PID" >/dev/null 2>&1; then
    kill "$OLD_PID" || true
    sleep 0.2
  fi
fi

cd "$LATEST_PROJECT"

# Start flutter in THIS terminal (no fifo)
flutter run -d macos

