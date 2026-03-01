#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECTS="$ROOT/workspace/projects"
LATEST_PROJECT="$(ls -td "$PROJECTS"/*/ | head -n 1)"

if [ -z "$LATEST_PROJECT" ]; then
  echo "❌ No Flutter project found in workspace/projects"
  exit 1
fi

PIDFILE="$ROOT/workspace/flutter_run.pid"
LOGFILE="$ROOT/workspace/flutter_run.log"

cd "$LATEST_PROJECT"
flutter pub get

# Stop existing run if alive
if [ -f "$PIDFILE" ]; then
  OLD_PID="$(cat "$PIDFILE" || true)"
  if [ -n "$OLD_PID" ] && ps -p "$OLD_PID" >/dev/null 2>&1; then
    echo "# Stopping previous flutter run (pid=$OLD_PID)"
    kill "$OLD_PID" || true
    sleep 1
  fi
fi

echo "# Starting persistent flutter run..."
nohup flutter run -d macos > "$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"

echo "# Running (pid=$(cat "$PIDFILE"))"
echo "# Logs: tail -f $LOGFILE"
