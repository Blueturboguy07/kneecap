#!/usr/bin/env bash
# offline-audit.sh — CI/local entrypoint for scripts/offline-audit.mjs.
#
# Runs the strict no-outbound-network check against source and (if it's
# been built) the compiled Next.js bundle. See offline-audit.mjs for the
# allowlist and what counts as a violation.
#
#   scripts/offline-audit.sh                  # full check (wants apps/web/.next to exist)
#   scripts/offline-audit.sh --skip-build-check  # source-only, fast, no build needed
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if command -v bun >/dev/null 2>&1; then
	exec bun "$REPO_ROOT/scripts/offline-audit.mjs" "$@"
elif command -v node >/dev/null 2>&1; then
	exec node "$REPO_ROOT/scripts/offline-audit.mjs" "$@"
else
	echo "offline-audit.sh: neither bun nor node is on PATH" >&2
	exit 2
fi
