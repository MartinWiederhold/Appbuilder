#!/usr/bin/env bash
set -euo pipefail

STATE="$(cd "$(dirname "$0")/.." && pwd)/.flutter_live"

if [ ! -f "$STATE/pid" ]; then
  echo "No running Flutter session"
  exit 1
fi

# If fifo is missing, treat as not running
if [ ! -p "$STATE/stdin" ]; then
  echo "No stdin fifo"
  exit 1
fi

# Write hot reload command
echo "r" > "$STATE/stdin"

echo "Hot reload triggered"
exit 0
