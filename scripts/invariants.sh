#!/usr/bin/env bash
# invariants.sh — THE merge gate for kneecap (plan M0 / §8.0).
#
# Runs, in order: build -> typecheck (apps/web) -> typecheck+headless gate
# (packages/editor-core) -> typecheck (packages/native-bridge,
# apps/mobile — M3) -> lint -> unit tests -> offline-audit ->
# bridge-import gate -> mouse-event gate. Exits non-zero (and prints
# exactly what regressed) the moment any of them fails.
#
#   bash scripts/invariants.sh
#
# Every step below is either fully strict (fails on ANY problem) or, where
# this snapshot already carries pre-existing, documented debt that fixing
# is genuinely out of scope for a hygiene/CI pass, held to a **regression
# gate**: it must not get WORSE than a hardcoded baseline captured on
# 2026-08-17, and any IMPROVEMENT is silently accepted (lowering a
# baseline number here is always safe; the check never asks you to match
# it exactly). This mirrors the pattern scripts/offline-audit.mjs already
# uses for its one known gap (see KNOWN_VENDOR_ML_RUNTIME_SIGNATURES
# there) — flag debt loudly and gate against it getting worse, rather than
# either silently laundering it or blocking unrelated work on fixing it.
#
# Two gates are intentionally NOT strict yet and say so loudly every run:
#   - bridge-import gate: fully strict (plan §2.4: "no editor UI file
#     imports a Capacitor or Tauri symbol"). Now genuinely exercised —
#     apps/mobile and packages/native-bridge both exist as of M3, and
#     packages/native-bridge/src/{capacitor-bridge,index}.ts DO import
#     @capacitor/core, which is exactly why that one directory is excluded
#     from the scan below rather than the gate being vacuously green.
#   - mouse-event gate: NOT strict — apps/web/src/timeline's controllers
#     are still mouse-only (pre-M5; see plan M5 "Rewrite six mouse-only
#     controllers to Pointer Events"). It reports the current count as a
#     non-blocking warning. Flip STRICT_MOUSE_EVENT_GATE to 1 once M5's
#     pointer-event rewrite lands.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WEB_DIR="$REPO_ROOT/apps/web"
RUNNER="bun"
command -v bun >/dev/null 2>&1 || RUNNER="node"

# ---------------------------------------------------------------------------
# Documented baselines. Every number here has a one-line reason and was
# measured directly against this exact commit — see the handoff note in
# the M0-part-2 task for how each was verified (git stash / git checkout
# origin/main comparison). If you touch code that legitimately changes one
# of these, update the number AND the reason in the same commit.
# ---------------------------------------------------------------------------

# Was 2 (two test files passed a raw `number` where the branded
# `MediaTime` tick type is expected). M2 fixed both while extracting them
# into packages/editor-core, because the extracted package type-checks
# standalone and those were the only two errors standing in the way. This
# is now a hard zero for BOTH programs — do not raise it back.
BASELINE_TYPECHECK_ERRORS=0

# Pre-existing across ~40 largely-unexercised feature directories (see M0
# part-2 handoff). Verified via `git checkout origin/main -- .` +
# `bun run lint:web`: origin/main's own baseline is 112 errors / 21
# warnings — the number below is what's left AFTER this fork's network-
# surface-removal commits (which deleted some of the offending files
# incidentally), i.e. this is already an improvement over the pre-session
# baseline, not a new regression being tolerated.
#
# M2 note: the lint scope below now covers apps/web/src AND
# packages/editor-core, because ~365 engine files moved into the package.
# Scanning only apps/web/src after the move would have shown a fake
# "improvement" to 68 — the errors did not go away, they changed address.
# Re-measured across both scopes post-move: 108 errors, exactly the
# pre-move number, with the per-rule breakdown matching one-for-one
# (no-unsafe-type-assertion 83 = 43 web + 40 core, etc.).
BASELINE_LINT_ERRORS=108

# `bun test` at repo root. Was 191 pass / 8 fail; M2 moved it to 250/3 and
# these numbers are the new floor/ceiling. (215 -> 250 is the EDL v1 suite,
# packages/editor-core/src/edl/__tests__/edl.test.ts, 35 tests.)
#
# What changed: cause (a) of the old failures was `opencut-wasm`'s published
# bindgen glue throwing `wasm.__wbindgen_start is not a function` under Bun,
# which aborted whole test files at import time — because `TICKS_PER_SECOND`
# is evaluated at module scope, that made most of the engine untestable.
# bunfig.toml now preloads a faithful pure-TS stand-in
# (packages/editor-core/src/test-support/wasm-stub.ts), so those files run:
# 199 tests collected became 218.
#
# The 3 remaining failures are pre-existing defects in inherited code that
# the abort had been HIDING, not regressions — all three are in
# packages/editor-core/src/masks/__tests__/snap.test.ts:
#   1. "snaps uniform scale handle for box masks" — snap returns an extra
#      vertical line at -100 that the test does not expect.
#   2. "snaps text mask movement using intrinsic text bounds" — needs a real
#      2D canvas for text measurement; Bun has no DOM.
#   3. "splits a segment into two segments at the insertion point" — bezier
#      handles come back +-0.1 instead of 0.
# None are time/tick related and none are in M2's scope. Fixing them is
# tracked work for whoever next touches masks (post-v1 per plan §2.3 rule 4).
BASELINE_TEST_PASS_MIN=250
BASELINE_TEST_FAIL_MAX=3

STRICT_MOUSE_EVENT_GATE="${STRICT_MOUSE_EVENT_GATE:-0}"

FAILED=0
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }
info() { printf '  \033[2m..\033[0m    %s\n' "$1"; }

if [ ! -d "$REPO_ROOT/node_modules" ]; then
	echo "invariants.sh: node_modules not found — run \`bun install\` first." >&2
	exit 2
fi

# ---------------------------------------------------------------------------
# 1. Build (apps/web). Also the prerequisite that lets offline-audit scan
#    the compiled bundle, not just source — see step 5.
# ---------------------------------------------------------------------------
step "build (apps/web)"
if (cd "$WEB_DIR" && bun run build) >/tmp/kneecap-invariants-build.log 2>&1; then
	pass "bun run build"
else
	fail "bun run build — see /tmp/kneecap-invariants-build.log"
	tail -n 40 /tmp/kneecap-invariants-build.log
fi

# ---------------------------------------------------------------------------
# 2. Typecheck. Regression-gated against BASELINE_TYPECHECK_ERRORS.
# ---------------------------------------------------------------------------
step "typecheck (tsc --noEmit)"
TSC_OUT="$(cd "$WEB_DIR" && bunx tsc --noEmit 2>&1)"
TSC_ERROR_COUNT="$(printf '%s\n' "$TSC_OUT" | grep -c ': error TS' || true)"
if [ "$TSC_ERROR_COUNT" -le "$BASELINE_TYPECHECK_ERRORS" ]; then
	if [ "$TSC_ERROR_COUNT" -gt 0 ]; then
		pass "$TSC_ERROR_COUNT error(s), within the documented baseline of $BASELINE_TYPECHECK_ERRORS (pre-existing MediaTime branded-type gaps in two test files)"
	else
		pass "0 errors"
	fi
else
	fail "$TSC_ERROR_COUNT error(s) — exceeds the documented baseline of $BASELINE_TYPECHECK_ERRORS"
	printf '%s\n' "$TSC_OUT"
fi

# ---------------------------------------------------------------------------
# 2b. Headless engine gate (plan M2). TWO checks, both FULLY STRICT:
#
#   (a) `tsc --noEmit` inside packages/editor-core, whose tsconfig maps
#       `@/*` to its OWN src only. This is the structural proof that the
#       engine is self-contained: if any engine file still reaches back
#       into apps/web, the specifier cannot resolve and this fails. It is
#       not a heuristic and cannot be worked around by renaming an import.
#   (b) scripts/check-headless.mjs — the readable per-file scan that names
#       the offending line for react/next/zustand/sonner/icon/server
#       imports, JSX under src/, and relative paths escaping the package.
#
# No grandfathering: the package was extracted clean and must stay clean.
# ---------------------------------------------------------------------------
CORE_DIR="$REPO_ROOT/packages/editor-core"
if [ -d "$CORE_DIR" ]; then
	step "typecheck (packages/editor-core, standalone)"
	CORE_TSC_OUT="$(cd "$CORE_DIR" && bunx tsc --project tsconfig.json --noEmit 2>&1)"
	CORE_TSC_ERRORS="$(printf '%s\n' "$CORE_TSC_OUT" | grep -c ': error TS' || true)"
	if [ "$CORE_TSC_ERRORS" -eq 0 ]; then
		pass "0 errors — engine resolves entirely within packages/editor-core"
	else
		fail "$CORE_TSC_ERRORS error(s) in the standalone engine type-check (must be 0)"
		printf '%s\n' "$CORE_TSC_OUT" | head -n 40
	fi

	step "headless gate (no UI framework in packages/editor-core/src)"
	if HEADLESS_OUT="$(bun "$REPO_ROOT/scripts/check-headless.mjs" 2>&1)"; then
		pass "$HEADLESS_OUT"
	else
		fail "check-headless.mjs reported violation(s):"
		printf '%s\n' "$HEADLESS_OUT"
	fi
else
	step "headless gate"
	info "packages/editor-core not found — skipped (pre-M2 tree?)"
fi

# ---------------------------------------------------------------------------
# 2c. Typecheck packages/native-bridge and apps/mobile standalone (plan M3).
#    Same pattern as 2b: each package's own tsconfig.json two-candidate `@/*`
#    path (own src first, editor-core src second — see the comment in
#    packages/native-bridge/tsconfig.json) is what lets `tsc --noEmit` here
#    resolve the transitive `@kneecap/editor-core/edl` import without
#    depending on a built .d.ts anywhere. FULLY STRICT: both are new in M3,
#    nothing to grandfather.
# ---------------------------------------------------------------------------
NATIVE_BRIDGE_DIR="$REPO_ROOT/packages/native-bridge"
if [ -d "$NATIVE_BRIDGE_DIR" ]; then
	step "typecheck (packages/native-bridge, standalone)"
	NB_TSC_OUT="$(cd "$NATIVE_BRIDGE_DIR" && bunx tsc --project tsconfig.json --noEmit 2>&1)"
	NB_TSC_ERRORS="$(printf '%s\n' "$NB_TSC_OUT" | grep -c ': error TS' || true)"
	if [ "$NB_TSC_ERRORS" -eq 0 ]; then
		pass "0 errors"
	else
		fail "$NB_TSC_ERRORS error(s) in packages/native-bridge (must be 0)"
		printf '%s\n' "$NB_TSC_OUT" | head -n 40
	fi
fi

MOBILE_DIR="$REPO_ROOT/apps/mobile"
if [ -d "$MOBILE_DIR/src" ]; then
	step "typecheck (apps/mobile, standalone — M3 shell harness)"
	MOBILE_TSC_OUT="$(cd "$MOBILE_DIR" && bunx tsc --project tsconfig.json --noEmit 2>&1)"
	MOBILE_TSC_ERRORS="$(printf '%s\n' "$MOBILE_TSC_OUT" | grep -c ': error TS' || true)"
	if [ "$MOBILE_TSC_ERRORS" -eq 0 ]; then
		pass "0 errors"
	else
		fail "$MOBILE_TSC_ERRORS error(s) in apps/mobile (must be 0)"
		printf '%s\n' "$MOBILE_TSC_OUT" | head -n 40
	fi
fi

# ---------------------------------------------------------------------------
# 3. Lint. Regression-gated against BASELINE_LINT_ERRORS (warnings are
#    reported but never block — matches plain `eslint`'s own default
#    exit-code semantics of failing on errors, not warnings).
# ---------------------------------------------------------------------------
step "lint (eslint apps/web/src + packages/editor-core + packages/native-bridge + apps/mobile/src)"
LINT_SCOPES=("$REPO_ROOT/apps/web/src")
[ -d "$REPO_ROOT/packages/editor-core/src" ] && LINT_SCOPES+=("$REPO_ROOT/packages/editor-core/src")
[ -d "$REPO_ROOT/packages/editor-core/react" ] && LINT_SCOPES+=("$REPO_ROOT/packages/editor-core/react")
[ -d "$REPO_ROOT/packages/native-bridge/src" ] && LINT_SCOPES+=("$REPO_ROOT/packages/native-bridge/src")
[ -d "$REPO_ROOT/apps/mobile/src" ] && LINT_SCOPES+=("$REPO_ROOT/apps/mobile/src")
LINT_JSON="$(bunx eslint "${LINT_SCOPES[@]}" --ext .ts,.tsx -f json 2>/dev/null)"
LINT_COUNTS="$("$RUNNER" -e '
	let data = "";
	process.stdin.on("data", (d) => { data += d; });
	process.stdin.on("end", () => {
		let results = [];
		try { results = JSON.parse(data); } catch { results = []; }
		let errors = 0, warnings = 0;
		for (const r of results) { errors += r.errorCount; warnings += r.warningCount; }
		console.log(errors + " " + warnings);
	});
' <<<"$LINT_JSON")"
LINT_ERRORS="$(echo "$LINT_COUNTS" | awk '{print $1}')"
LINT_WARNINGS="$(echo "$LINT_COUNTS" | awk '{print $2}')"
if [ "$LINT_ERRORS" -le "$BASELINE_LINT_ERRORS" ]; then
	pass "$LINT_ERRORS error(s), $LINT_WARNINGS warning(s) — within the documented baseline of $BASELINE_LINT_ERRORS errors"
else
	fail "$LINT_ERRORS error(s) — exceeds the documented baseline of $BASELINE_LINT_ERRORS"
	bun run lint:web || true
fi

# ---------------------------------------------------------------------------
# 4. Unit tests. Regression-gated: pass count must not drop below the
#    baseline and fail count must not exceed it (either direction of
#    improvement is accepted automatically).
# ---------------------------------------------------------------------------
step "unit tests (bun test)"
TEST_OUT="$(bun test 2>&1)"
# bun emits ANSI color codes even when stdout isn't a TTY (observed in this
# sandbox), which land BEFORE the digits on the summary lines (e.g.
# "\x1b[0m\x1b[32m 191 pass\x1b[0m") — strip them before parsing, otherwise
# a naive line-anchored grep silently matches nothing and TEST_PASS/FAIL
# fall back to their "assume the worst" defaults below.
TEST_OUT_PLAIN="$(printf '%s\n' "$TEST_OUT" | sed -E 's/\x1b\[[0-9;]*[a-zA-Z]//g')"
TEST_PASS="$(printf '%s\n' "$TEST_OUT_PLAIN" | grep -oE '[0-9]+ pass' | grep -oE '[0-9]+' | tail -1)"
TEST_FAIL="$(printf '%s\n' "$TEST_OUT_PLAIN" | grep -oE '[0-9]+ fail' | grep -oE '[0-9]+' | tail -1)"
TEST_PASS="${TEST_PASS:-0}"
TEST_FAIL="${TEST_FAIL:-999}"
if [ "$TEST_PASS" -ge "$BASELINE_TEST_PASS_MIN" ] && [ "$TEST_FAIL" -le "$BASELINE_TEST_FAIL_MAX" ]; then
	pass "$TEST_PASS pass / $TEST_FAIL fail — within baseline ($BASELINE_TEST_PASS_MIN+ pass, $BASELINE_TEST_FAIL_MAX max fail)"
else
	fail "$TEST_PASS pass / $TEST_FAIL fail — outside baseline ($BASELINE_TEST_PASS_MIN+ pass, $BASELINE_TEST_FAIL_MAX max fail)"
	printf '%s\n' "$TEST_OUT" | tail -n 60
fi

# ---------------------------------------------------------------------------
# 5. Offline audit. Fully strict — scripts/offline-audit.mjs already
#    encodes its own known-gap warnings (transformers.js/onnxruntime-web);
#    anything that shows up as a hard violation here is new and real.
# ---------------------------------------------------------------------------
step "offline audit"
if bash "$REPO_ROOT/scripts/offline-audit.sh"; then
	pass "no outbound-network violations"
else
	fail "offline-audit.sh reported violation(s) — see output above"
fi

# ---------------------------------------------------------------------------
# 6. Bridge-import gate (plan §2.4 / M3: "No editor UI file may import a
#    Capacitor or Tauri symbol"). FULLY STRICT: apps/mobile and
#    packages/native-bridge don't exist yet (that's M3), so today there is
#    truly nothing in this tree that should ever import either shell SDK —
#    zero grandfathering needed. This gate exists now, ahead of M3,
#    specifically so a future PR can never accidentally reach for
#    `@capacitor/*` or `@tauri-apps/*` directly from UI/editor code without
#    the CI run turning red the same day.
# ---------------------------------------------------------------------------
step "bridge-import gate (no shell SDK imports outside packages/native-bridge)"
BRIDGE_SCAN_DIRS=()
[ -d "$REPO_ROOT/apps/web/src" ] && BRIDGE_SCAN_DIRS+=("$REPO_ROOT/apps/web/src")
[ -d "$REPO_ROOT/apps/mobile/src" ] && BRIDGE_SCAN_DIRS+=("$REPO_ROOT/apps/mobile/src")
[ -d "$REPO_ROOT/packages" ] && while IFS= read -r -d '' pkg; do
	base="$(basename "$pkg")"
	[ "$base" = "native-bridge" ] && continue # the one package allowed to know
	BRIDGE_SCAN_DIRS+=("$pkg")
done < <(find "$REPO_ROOT/packages" -mindepth 1 -maxdepth 1 -type d -print0)

if [ "${#BRIDGE_SCAN_DIRS[@]}" -eq 0 ]; then
	pass "0 hits (nothing to scan yet — apps/web/src not found?)"
else
	BRIDGE_HITS="$(grep -rnE "from ['\"]@capacitor/|from ['\"]@tauri-apps/|require\(['\"]@capacitor/|require\(['\"]@tauri-apps/" \
		--include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
		"${BRIDGE_SCAN_DIRS[@]}" 2>/dev/null || true)"
	if [ -z "$BRIDGE_HITS" ]; then
		pass "0 hits across ${#BRIDGE_SCAN_DIRS[@]} scanned dir(s)"
	else
		fail "shell SDK imported outside packages/native-bridge:"
		printf '%s\n' "$BRIDGE_HITS"
	fi
fi

# ---------------------------------------------------------------------------
# 7. Mouse-event gate (plan M5 exit criterion: "Zero mousedown/mousemove/
#    mouseup listeners remain in packages/mobile-ui and the ported timeline
#    controllers"). NOT STRICT YET — pre-M5, apps/web/src/timeline's
#    controllers are still mouse-only by design (six controllers named
#    explicitly in plan M5 item 1). This step always reports the current
#    count and, by default, never fails the build on it. Set
#    STRICT_MOUSE_EVENT_GATE=1 to make it a hard gate (that's the flip M5
#    should do on landing the Pointer Events rewrite).
# ---------------------------------------------------------------------------
step "mouse-event gate (placeholder — strict from M5)"
MOUSE_SCAN_DIRS=("$REPO_ROOT/apps/web/src/timeline")
[ -d "$REPO_ROOT/packages/mobile-ui" ] && MOUSE_SCAN_DIRS+=("$REPO_ROOT/packages/mobile-ui")
MOUSE_HITS="$(grep -rnE "addEventListener\([\"']mouse(down|move|up)[\"']|onMouse(Down|Move|Up)=" \
	--include='*.ts' --include='*.tsx' \
	"${MOUSE_SCAN_DIRS[@]}" 2>/dev/null || true)"
MOUSE_HIT_COUNT="$(printf '%s\n' "$MOUSE_HITS" | grep -c . || true)"
if [ -z "$MOUSE_HITS" ]; then
	pass "0 raw mouse-event listeners in the timeline layer"
elif [ "$STRICT_MOUSE_EVENT_GATE" = "1" ]; then
	fail "$MOUSE_HIT_COUNT raw mouse-event listener(s) — gate is now STRICT (M5 landed) and this must be 0:"
	printf '%s\n' "$MOUSE_HITS"
else
	info "$MOUSE_HIT_COUNT raw mouse-event listener(s) found — NON-BLOCKING placeholder, expected pre-M5 (plan M5 rewrites these six controllers to Pointer Events). Not counted as pass or fail."
fi

# ---------------------------------------------------------------------------
step "summary"
if [ "$FAILED" -eq 0 ]; then
	printf '\n\033[32m\033[1minvariants: green.\033[0m\n'
	exit 0
else
	printf '\n\033[31m\033[1minvariants: FAILED — see above.\033[0m\n'
	exit 1
fi
