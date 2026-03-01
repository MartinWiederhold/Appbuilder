#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.flutter_live"

WIN_ID=""
if [ -f "$STATE/terminal_window_id" ]; then
  WIN_ID="$(cat "$STATE/terminal_window_id" || true)"
fi

# Try to focus recorded window; if it fails, just use front window.
osascript <<APPLESCRIPT
tell application "Terminal"
  activate
  if "${WIN_ID}" is not "" then
    try
      set targetWindow to (first window whose id is ${WIN_ID})
      set frontmost of targetWindow to true
    on error
      -- fallback: keep current front window
    end try
  end if
end tell
tell application "System Events"
  keystroke "r"
  keystroke return
end tell
APPLESCRIPT

echo "Hot reload triggered (osascript)"
exit 0
