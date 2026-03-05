#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="$ROOT/.flutter_live"
FIFO="$STATE/stdin"

if [ ! -p "$FIFO" ]; then
  echo "❌ No FIFO found at $FIFO (start live flutter first)"
  exit 1
fi

# send "r" to flutter run stdin
printf "r\n" > "$FIFO"
echo "✅ Hot reload triggered (fifo)"
