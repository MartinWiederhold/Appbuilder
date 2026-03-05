#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECTS="$ROOT/workspace/projects"
STATE="$ROOT/.flutter_live"
mkdir -p "$STATE"

LATEST_PROJECT="$(ls -td "$PROJECTS"/*/ 2>/dev/null | head -n 1 || true)"
if [ -z "$LATEST_PROJECT" ]; then
  echo "❌ No Flutter project found under $PROJECTS"
  exit 1
fi

cd "$LATEST_PROJECT"

# kill old flutter (if any)
if [ -f "$STATE/pid" ]; then
  OLD_PID="$(cat "$STATE/pid" || true)"
  if [ -n "$OLD_PID" ] && ps -p "$OLD_PID" >/dev/null 2>&1; then
    kill "$OLD_PID" || true
  fi
fi

rm -f "$STATE/stdin" "$STATE/flutter.log" || true
mkfifo "$STATE/stdin"
: > "$STATE/flutter.log"

(
  flutter run -d macos < "$STATE/stdin" >> "$STATE/flutter.log" 2>&1
) &
PID=$!
echo "$PID" > "$STATE/pid"

echo "✅ Flutter live started (PID=$PID) in $LATEST_PROJECT"
echo "📄 Log: $STATE/flutter.log"
echo "👉 Tail log: tail -f $STATE/flutter.log"
