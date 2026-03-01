#!/usr/bin/env bash
set -e

# Repo root (parent of scripts/)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROJECTS="$ROOT/workspace/projects"

# Nimm das zuletzt geänderte Projekt
LATEST_PROJECT="$(ls -td "$PROJECTS"/*/ | head -n 1)"

if [ -z "$LATEST_PROJECT" ]; then
  echo "❌ No Flutter project found in workspace/projects"
  exit 1
fi

echo "# Starting Flutter live preview for:"
echo "  $LATEST_PROJECT"

cd "$LATEST_PROJECT"
flutter pub get
flutter run -d macos
