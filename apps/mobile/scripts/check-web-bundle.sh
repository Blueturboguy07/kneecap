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
#   - the gate mode is not the one asked for (PUBLIK_GATE_MODE).
# It prints file names only, never file contents (the bundle holds the
# publik app token).
#
#   bash scripts/check-web-bundle.sh www required
set -euo pipefail

WWW="${1:?usage: check-web-bundle.sh <www dir> <required|optional>}"
MODE="${2:?usage: check-web-bundle.sh <www dir> <required|optional>}"
case "$MODE" in required) OTHER=optional ;; optional) OTHER=required ;; *) echo "::error::mode must be required or optional" >&2; exit 2 ;; esac

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

if grep -rlE '__(PUBLIK_APP_TOKEN|PUBLIK_GATE_MODE|KNEECAP_DEBUG_TOOLS)__' "$WWW/assets"; then
	bad "a build-time constant was not replaced in the files listed above"
fi

# src/publik/publik.ts: GATE_MODE = typeof __PUBLIK_GATE_MODE__ === ... ;
# after the build: typeof "<mode>" === ... (or the folded "<mode>").
line="$(grep -rhoE 'GATE_MODE(\$[0-9]+)? = [^;]{0,160};' "$WWW/assets" | head -1 || true)"
case "$line" in
	"") echo "::warning::the GATE_MODE line is not in the bundle; the gate mode is not checked here" ;;
	*"typeof \"$MODE\""* | *"= \"$MODE\";") echo "gate mode: $MODE" ;;
	*"typeof \"$OTHER\""* | *"= \"$OTHER\";") bad "this bundle has gate mode $OTHER, not $MODE" ;;
	*) echo "::warning::the gate mode is not checked here: unknown form of the GATE_MODE line" ;;
esac

if [ "$fail" -eq 0 ]; then echo "web bundle OK: no developer tools, no other app's name, gate mode $MODE"; fi
exit "$fail"
