#!/usr/bin/env bash
set -euo pipefail

echo "Node: $(node -v)"
echo "npm : $(npm -v)"

# Make npm more stable on ephemeral CI filesystems
npm config set fund false
npm config set audit false
npm config set update-notifier false
npm config set cache /tmp/.npm

# npm ci has been flaky on some Render builders; install is more robust here
npm install --omit=dev --no-audit --no-fund
