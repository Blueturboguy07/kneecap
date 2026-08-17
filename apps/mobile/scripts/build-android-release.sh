#!/usr/bin/env bash
# kneecap M12/M13 — builds a SIGNED Android release APK, for direct
# distribution (GitHub Releases), via gradle.
#
# Requires four environment variables pointing at a real keystore — see
# docs/RELEASING.md for how to generate one (locally, once, outside any
# agent session) and where to store it as repo secrets. This script does
# not generate, fetch, or embed any secret material itself:
#   KNEECAP_RELEASE_KEYSTORE           — path to the .jks/.keystore file
#   KNEECAP_RELEASE_KEYSTORE_PASSWORD
#   KNEECAP_RELEASE_KEY_ALIAS
#   KNEECAP_RELEASE_KEY_PASSWORD
#
# Without those set, ../android/app/build.gradle falls back to an
# unsigned release build (see the comment at the top of that file) —
# this script still runs, it just won't produce an installable-without-
# resigning APK. .github/workflows/release.yml is the only place these
# four env vars are normally populated (from repo secrets, on a `v*` tag
# push).
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$MOBILE_DIR"

if [ -z "${KNEECAP_RELEASE_KEYSTORE:-}" ]; then
	echo "warning: KNEECAP_RELEASE_KEYSTORE is not set — this build will produce an UNSIGNED release APK. See docs/RELEASING.md." >&2
fi

echo "==> bun run build (Vite -> www/)"
bun run build

echo "==> cap sync android"
bunx cap sync android

echo "==> gradlew assembleRelease"
cd android
./gradlew assembleRelease --console=plain

# AGP names the output differently depending on whether a signingConfig
# was actually applied: app-release.apk when signed,
# app-release-unsigned.apk when not (verified directly — see
# docs/RELEASING.md §3). Report whichever one actually exists rather
# than assuming.
OUT_DIR="app/build/outputs/apk/release"
if [ -f "$OUT_DIR/app-release.apk" ]; then
	echo "==> signed APK at: apps/mobile/android/$OUT_DIR/app-release.apk"
elif [ -f "$OUT_DIR/app-release-unsigned.apk" ]; then
	echo "==> UNSIGNED APK at: apps/mobile/android/$OUT_DIR/app-release-unsigned.apk (KNEECAP_RELEASE_KEYSTORE was not set — see docs/RELEASING.md)"
else
	echo "warning: no APK found under apps/mobile/android/$OUT_DIR — check the gradle output above" >&2
fi
