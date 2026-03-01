#!/usr/bin/env bash
set -euo pipefail

# Sends "r" to the frontmost Terminal window (Flutter run must be focused)
osascript <<'APPLESCRIPT'
tell application "Terminal"
  activate
  delay 0.1
  tell application "System Events"
    keystroke "r"
    keystroke return
  end tell
end tell
APPLESCRIPT

echo "Hot reload triggered (osascript)"
exit 0
