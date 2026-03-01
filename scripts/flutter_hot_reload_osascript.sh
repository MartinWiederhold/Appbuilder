#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.flutter_live"

if [ ! -f "$STATE/terminal_window_id" ]; then
  echo "No terminal_window_id. Start flutter via scripts/run_live_flutter.sh first."
  exit 1
fi

WIN_ID="$(cat "$STATE/terminal_window_id")"

osascript <<APPLESCRIPT
tell application "Terminal"
  activate
  set targetWindow to (first window whose id is ${WIN_ID})
  set frontmost of targetWindow to true
end tell
tell application "System Events"
  keystroke "r"
  keystroke return
end tell
APPLESCRIPT

echo "Hot reload triggered (target window)"
exit 0
