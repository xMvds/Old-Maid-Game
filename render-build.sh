#!/usr/bin/env bash
set -euo pipefail

echo "Render build: Old Maid V2.4"
echo "Checking vendored node_modules..."
if [ -d "node_modules" ] && [ -f "node_modules/express/package.json" ] && [ -f "node_modules/socket.io/package.json" ]; then
  echo "OK: node_modules present. Skipping dependency install."
  exit 0
fi

echo "node_modules missing (unexpected). Installing with corepack+yarn as fallback..."
corepack enable >/dev/null 2>&1 || true
yarn --version >/dev/null 2>&1 || corepack prepare yarn@1.22.22 --activate
yarn install --production --silent
