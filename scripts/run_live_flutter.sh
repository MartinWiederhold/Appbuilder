#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECTS="$ROOT/workspace/projects"
STATE_DIR="$ROOT/.live_preview"
PID_FILE="$STATE_DIR/flutter.pid"
LOG_FILE="$STATE_DIR/flutter.log"
CMD_FILE="$STATE_DIR/flutter.cmd"

mkdir -p "$STATE_DIR"

LATEST_PROJECT="$(ls -td "$PROJECTS"/*/ 2>/dev/null | head -n 1 || true)"
if [ -z "${LATEST_PROJECT:-}" ]; then
  echo "❌ No Flutter project found in workspace/projects"
  exit 1
fi

echo "🚀 Live preview project:"
echo "   $LATEST_PROJECT"
echo "📄 Log: $LOG_FILE"

# If running already -> request HOT RELOAD
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" || true)"
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "🔥 Flutter already running (pid=$OLD_PID) -> HOT RELOAD"
    echo "r" >> "$CMD_FILE"
    exit 0
  fi
fi

# fresh start
rm -f "$PID_FILE"
: > "$LOG_FILE"
: > "$CMD_FILE"

cd "$LATEST_PROJECT"
flutter pub get >/dev/null

echo "▶️ Starting flutter run -d macos (PTY)..."

(
  tail -n 0 -f "$CMD_FILE" | \
  script -q -F /dev/null flutter run -d macos
) > "$LOG_FILE" 2>&1 &

NEW_PID="$!"
echo "$NEW_PID" > "$PID_FILE"
echo "✅ Started (pid=$NEW_PID)"
