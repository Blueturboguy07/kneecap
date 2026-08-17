#!/usr/bin/env bash
# kneecap M12/M13 — builds an UNSIGNED iOS device build and packages it
# as a plain .ipa, for direct distribution (GitHub Releases).
#
# There is no App Store / TestFlight path (plan M13 operative section,
# ratified 2026-08-17: no app-store release on either platform) and no
# CI-held Apple signing identity (local/CI signing from an agent session
# is explicitly out of scope per this project's engineering rules — real
# device installs are the END USER's job, via one of the two paths in
# docs/guides/ios-xcode-build.md, or by re-signing this .ipa with
# AltStore/SideStore's free-Apple-ID flow). This script only produces
# the unsigned artifact; it does not sign, notarize, or upload anything.
#
# CODE_SIGNING_ALLOWED=NO / CODE_SIGNING_REQUIRED=NO / CODE_SIGN_IDENTITY=""
# together are what let `xcodebuild` produce a real `-sdk iphoneos`
# (device, not Simulator) .app without any signing identity or
# provisioning profile present on the build machine.
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$MOBILE_DIR"

BUILD_DIR="${IOS_UNSIGNED_BUILD_DIR:-$(mktemp -d)}"
OUT_DIR="${IOS_UNSIGNED_OUT_DIR:-$MOBILE_DIR/release-artifacts}"
REF_NAME="${IOS_RELEASE_REF_NAME:-dev}"

echo "==> bun run build (Vite -> www/)"
bun run build

echo "==> cap sync ios"
bunx cap sync ios

echo "==> xcodebuild (Release, iphoneos device, unsigned) -> $BUILD_DIR"
xcodebuild \
	-project ios/App/App.xcodeproj \
	-scheme App \
	-configuration Release \
	-sdk iphoneos \
	-destination 'generic/platform=iOS' \
	-derivedDataPath "$BUILD_DIR" \
	CODE_SIGNING_ALLOWED=NO \
	CODE_SIGNING_REQUIRED=NO \
	CODE_SIGN_IDENTITY="" \
	build

APP_PATH="$(find "$BUILD_DIR/Build/Products" -maxdepth 2 -iname 'App.app' -print -quit)"
if [ -z "$APP_PATH" ]; then
	echo "error: App.app not found under $BUILD_DIR/Build/Products" >&2
	exit 1
fi

echo "==> packaging unsigned .ipa from $APP_PATH"
PACKAGE_DIR="$(mktemp -d)"
mkdir -p "$PACKAGE_DIR/Payload"
cp -R "$APP_PATH" "$PACKAGE_DIR/Payload/"

mkdir -p "$OUT_DIR"
IPA_PATH="$OUT_DIR/kneecap-${REF_NAME}-ios-unsigned.ipa"
(cd "$PACKAGE_DIR" && zip -qry "$IPA_PATH" Payload)

echo "==> unsigned ipa at: $IPA_PATH"
