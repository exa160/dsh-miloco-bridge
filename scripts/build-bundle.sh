#!/usr/bin/env bash
# Build an installable DSH bundle (.tgz) into dist/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

printf '\033[36m▸\033[0m running tests\n'
npm test --silent

printf '\033[36m▸\033[0m cleaning python caches\n'
find . -name __pycache__ -type d -prune -exec rm -rf {} +

printf '\033[36m▸\033[0m packing\n'
mkdir -p dist
npm pack --pack-destination dist --silent
BUNDLE="$(ls -1t dist/dsh-miloco-bridge-*.tgz | head -1)"

printf '\033[36m▸\033[0m verifying bundle contents\n'
LIST="$(tar -tzf "$BUNDLE")"
for required in \
  package/package.json \
  package/cordis.patch.yml \
  package/lib/index.js \
  package/lib/tools-entry.js \
  package/lib/client.js \
  package/adapter/dsh_adapter.py; do
  if ! printf '%s\n' "$LIST" | grep -qx "$required"; then
    echo "missing $required" >&2
    exit 1
  fi
done
SKILLS="$(printf '%s\n' "$LIST" | grep -c '/SKILL.md$')"
[ "$SKILLS" = "18" ] || { echo "expected 18 skills, got $SKILLS" >&2; exit 1; }
if printf '%s\n' "$LIST" | grep -qE '(^|/)test/|node_modules|__pycache__|\.pyc$|\.env$'; then
  echo "bundle contains test/node_modules/__pycache__/.env" >&2
  exit 1
fi

printf '\033[32m✓\033[0m %s\n' "$BUNDLE"
printf '  install: dsh plugin --profile web add "file:%s"\n' "$BUNDLE"
