#!/usr/bin/env bash
# Checks a store build of the web bundle (apps/mobile/www), after
# `bun run build` and before `cap sync`. CI runs it on every build
# (.github/workflows/mobile-ci.yml). It fails when:
#   - a developer tool is in the bundle: spike.html, spike-assets/, or the
#     #/diagnostics, #/autotest or spike chunks (vite.config.ts,
#     KNEECAP_DEBUG_TOOLS; App Store guideline 2.5.19);
#   - the word "capcut" (any case) is in any file (no other app's name in
#     the app; guidelines 4.1 and 5.2);
#   - a build-time constant was not replaced;
#   - the gate mode is not the one asked for (PUBLIK_GATE_MODE): the bundle
#     must have exactly one marker "publik-gate-mode:<mode>" (src/main.ts);
#   - no publik app token (pat_) is in the bundle. PUBLIK_ALLOW_NO_TOKEN=1
#     (a fork's pull-request CI only) makes this a warning;
#   - the bundle does not have exactly one build marker "publik-build:<kind>"
#     (src/main.ts, vite.config.ts). With the third argument "store" (a
#     bundle for the App Store or a release, APP_STORE_BUILD=1) the kind must
#     be "store": no test hooks, gate required, token from the CI secret.
# It prints file names only, never file contents (the bundle holds the
# publik app token).
#
#   bash scripts/check-web-bundle.sh www required [store]
set -euo pipefail

WWW="${1:?usage: check-web-bundle.sh <www dir> <required|optional> [store]}"
MODE="${2:?usage: check-web-bundle.sh <www dir> <required|optional> [store]}"
KIND="${3:-}"
case "$MODE" in required | optional) ;; *) echo "::error::the gate mode must be required or optional, not \"$MODE\"" >&2; exit 2 ;; esac
case "$KIND" in "" | store) ;; *) echo "::error::the third argument must be store or nothing, not \"$KIND\"" >&2; exit 2 ;; esac
if [ "$KIND" = "store" ] && [ "$MODE" != "required" ]; then echo "::error::a store bundle has the gate required, not $MODE" >&2; exit 2; fi

fail=0
bad() { echo "::error::$*"; fail=1; }

[ -f "$WWW/index.html" ] || { echo "::error::$WWW/index.html not found. Run 'bun run build' first." >&2; exit 1; }

for item in spike.html spike-assets; do
	if [ -e "$WWW/$item" ]; then bad "developer tool in the web bundle: $item"; fi
done
if ls "$WWW/assets" | grep -E '^(legacy-harness|autotest|spike)-'; then
	bad "developer-tool chunks in $WWW/assets (listed above)"
fi

if grep -rlia capcut "$WWW"; then
	bad "the word CapCut is in the files listed above"
fi

if grep -rlE '__(PUBLIK_APP_TOKEN|PUBLIK_GATE_MODE|PUBLIK_GATE_MARKER|PUBLIK_BUILD_MARKER|PUBLIK_TEST_HOOKS|KNEECAP_DEBUG_TOOLS)__' "$WWW/assets"; then
	bad "a build-time constant was not replaced in the files listed above"
fi

# src/main.ts sets document.documentElement.dataset.publikGateMode to the
# build's marker (vite.config.ts, __PUBLIK_GATE_MARKER__).
markers="$(grep -rhoE 'publik-gate-mode:[a-z]+' "$WWW/assets" | sort -u | tr '\n' ' ' | sed 's/ $//' || true)"
case "$markers" in
	"publik-gate-mode:$MODE") echo "gate mode: $MODE" ;;
	"") bad "no gate-mode marker (publik-gate-mode:...) in the bundle" ;;
	*) bad "the bundle's gate-mode marker is \"$markers\", not publik-gate-mode:$MODE" ;;
esac

# src/main.ts sets document.documentElement.dataset.publikBuild to the build
# marker (vite.config.ts, __PUBLIK_BUILD_MARKER__): store, test-hooks or plain.
build="$(grep -rhoE 'publik-build:[a-z-]+' "$WWW/assets" | sort -u | tr '\n' ' ' | sed 's/ $//' || true)"
case "$build" in
	publik-build:store | publik-build:test-hooks | publik-build:plain) echo "build: ${build#publik-build:}" ;;
	"") bad "no build marker (publik-build:...) in the bundle" ;;
	*) bad "the bundle's build marker is \"$build\", not exactly one of publik-build:store|test-hooks|plain" ;;
esac
if [ "$KIND" = "store" ] && [ "$build" != "publik-build:store" ]; then
	bad "a store bundle must be built with APP_STORE_BUILD=1 (marker publik-build:store), not \"$build\""
fi

# The publik app token: only whether it is there; the value is never printed.
if ! grep -rqE 'pat_[A-Za-z0-9_-]{8,}' "$WWW/assets"; then
	if [ "${PUBLIK_ALLOW_NO_TOKEN:-}" = "1" ]; then
		echo "::warning::no publik app token in the bundle (PUBLIK_ALLOW_NO_TOKEN=1: a fork's pull request)"
	else
		bad "no publik app token (pat_...) in the bundle: set PUBLIK_APP_TOKEN for the build"
	fi
fi

if [ "$fail" -eq 0 ]; then echo "web bundle OK: no developer tools, no other app's name, gate mode $MODE, ${build#publik-build:} build"; fi
exit "$fail"
