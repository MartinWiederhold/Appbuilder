#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# macOS Terminal öffnen und den Live-Run starten
osascript <<APPLESCRIPT
tell application "Terminal"
  activate
  do script "cd \"${ROOT}\" && ./scripts/run_live_flutter.sh"
end tell
APPLESCRIPT
