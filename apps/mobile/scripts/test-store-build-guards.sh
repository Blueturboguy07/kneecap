#!/usr/bin/env bash
# Proves that a store build (APP_STORE_BUILD=1, vite.config.ts) cannot be made
# in the wrong way. CI runs it (.github/workflows/mobile-ci.yml).
#
#   bash scripts/test-store-build-guards.sh web     # after `bun install`, in GitHub Actions
#   bash scripts/test-store-build-guards.sh xcode   # macOS: the iOS "Debug-only items" build phase
#
# web: `bun run build` must FAIL with the reason when
#   - APP_STORE_BUILD and PUBLIK_TEST_HOOKS are both on;
#   - APP_STORE_BUILD=1 with PUBLIK_GATE_MODE=optional (a CI test artifact only);
#   - APP_STORE_BUILD=1 and a .env file sets PUBLIK_APP_TOKEN (the token comes
#     only from the CI secret, never from a file);
#   - APP_STORE_BUILD=1 outside GitHub Actions.
#   It fails at the config step, before any bundling. The fake token below is
#   not a real token.
# xcode: the build phase script, read out of project.pbxproj, must FAIL for a
#   store build with PUBLIK_TEST_HOOKS, for a Debug store build and for a web
#   bundle that is not a store build, and must pass a real store setup.
set -euo pipefail
cd "$(dirname "$0")/.."

part="${1:?usage: test-store-build-guards.sh <web|xcode>}"
fail=0
bad() { echo "::error::$*"; fail=1; }

expect_build_fail() { # <name> <text the error must have> <env assignments...>
	local name="$1" want="$2"
	shift 2
	local out
	if out="$(env "$@" bun run build 2>&1)"; then
		bad "$name: the build did not fail"
	elif grep -qF -- "$want" <<<"$out"; then
		echo "ok: $name"
	else
		bad "$name: the build failed, but not with \"$want\""
		grep -E "APP_STORE_BUILD|Error" <<<"$out" | grep -v pat_ | head -5 || true
	fi
}

case "$part" in
web)
	[ "${GITHUB_ACTIONS:-}" = "true" ] || { echo "::error::run this in GitHub Actions" >&2; exit 2; }
	# Valid store settings, then one wrong setting per case.
	base=(APP_STORE_BUILD=1 PUBLIK_GATE_MODE=required PUBLIK_APP_TOKEN=pat_storeguardtest PUBLIK_ALLOW_NO_TOKEN= KNEECAP_DEBUG_TOOLS= PUBLIK_TEST_HOOKS=)
	expect_build_fail "APP_STORE_BUILD + PUBLIK_TEST_HOOKS" "APP_STORE_BUILD and PUBLIK_TEST_HOOKS are both on" "${base[@]}" PUBLIK_TEST_HOOKS=1
	expect_build_fail "APP_STORE_BUILD + optional gate" "needs PUBLIK_GATE_MODE=required" "${base[@]}" PUBLIK_GATE_MODE=optional
	expect_build_fail "APP_STORE_BUILD + debug tools" "a store build has no developer tools" "${base[@]}" KNEECAP_DEBUG_TOOLS=1
	expect_build_fail "APP_STORE_BUILD outside GitHub Actions" "runs only in GitHub Actions" "${base[@]}" GITHUB_ACTIONS=
	envfile=.env.production.local
	[ ! -e "$envfile" ] || { echo "::error::$envfile is there already" >&2; exit 2; }
	trap 'rm -f "$envfile"' EXIT
	printf 'PUBLIK_APP_TOKEN=pat_storeguardtest\n' >"$envfile"
	expect_build_fail "APP_STORE_BUILD + token in a .env file" "these files set PUBLIK_APP_TOKEN" "${base[@]}"
	rm -f "$envfile"
	;;
xcode)
	PBX=ios/App/App.xcodeproj/project.pbxproj
	work="$(mktemp -d)"
	trap 'rm -rf "$work"' EXIT
	plutil -convert json -o - "$PBX" | python3 -I -c '
import json, sys
objects = json.load(sys.stdin)["objects"]
phase = [o for o in objects.values() if o.get("isa") == "PBXShellScriptBuildPhase" and o.get("name") == "Debug-only items"]
assert len(phase) == 1, "no Debug-only items phase"
sys.stdout.write(phase[0]["shellScript"])
' >"$work/phase.sh"
	mkdir -p "$work/App.app/public/assets"
	/usr/libexec/PlistBuddy -c "Add :CFBundleName string App" "$work/App.app/Info.plist" >/dev/null
	bundle() { printf 'a="publik-build:%s";b="publik-gate-mode:%s";' "$1" "$2" >"$work/App.app/public/assets/main-test.js"; }
	phase() { # <configuration> <swift conditions>
		env -i PATH=/usr/bin:/bin CONFIGURATION="$1" APP_STORE_BUILD=1 SWIFT_ACTIVE_COMPILATION_CONDITIONS="$2" \
			TARGET_BUILD_DIR="$work" INFOPLIST_PATH=App.app/Info.plist UNLOCALIZED_RESOURCES_FOLDER_PATH=App.app /bin/sh "$work/phase.sh" 2>&1
	}
	expect_phase_fail() { # <name> <text> <configuration> <swift conditions>
		local out
		if out="$(phase "$3" "$4")"; then bad "$1: the phase did not fail"
		elif grep -qF -- "$2" <<<"$out"; then echo "ok: $1"
		else bad "$1: the phase failed, but not with \"$2\": $out"; fi
	}
	bundle store required
	expect_phase_fail "Xcode: APP_STORE_BUILD + PUBLIK_TEST_HOOKS" "APP_STORE_BUILD and PUBLIK_TEST_HOOKS are both on" Release PUBLIK_TEST_HOOKS
	expect_phase_fail "Xcode: APP_STORE_BUILD in Debug" "is a Release build, not Debug" Debug DEBUG
	bundle test-hooks required
	expect_phase_fail "Xcode: a test-hooks web bundle" "the web bundle is not a store build" Release ""
	bundle store optional
	expect_phase_fail "Xcode: an optional-gate web bundle" "needs the web bundle with the gate required" Release ""
	bundle store required
	if out="$(phase Release "")"; then echo "ok: Xcode: a real store setup passes"; else bad "Xcode: a real store setup failed: $out"; fi
	;;
*) echo "usage: test-store-build-guards.sh <web|xcode>" >&2; exit 2 ;;
esac

if [ "$fail" -eq 0 ]; then echo "store build guards OK ($part)"; fi
exit "$fail"
