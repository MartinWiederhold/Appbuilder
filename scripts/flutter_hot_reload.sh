#!/usr/bin/env bash
set -e

STATE="$(cd "$(dirname "$0")/.." && pwd)/.flutter_live"

if [ ! -f "$STATE/pid" ]; then
  echo "❌ No running Flutter session"
  exit 1
fi

echo "r" > "$STATE/stdin"
echo "🔁 Hot reload triggered"
