#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

npm run syntax
node scripts/from-scratch-verify.js
npm test
npm run audit
echo "from-scratch verify complete"
