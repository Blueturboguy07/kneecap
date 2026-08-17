#!/usr/bin/env bash
# kneecap M3 — builds the iOS app for the Simulator, unsigned.
#
# CODE_SIGNING_ALLOWED=NO matches the top-level engineering rule for this
# project: local signing is flaky from agent sessions; real signing happens
# in CI (see ../../.github/workflows/mobile-ci.yml, which runs this exact
# sequence). This script is the same commands the M3 session ran locally,
# kept here so a future session/CI doesn't have to re-derive them.
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$MOBILE_DIR"

echo "==> bun run build (Vite -> www/)"
bun run build

echo "==> cap sync ios"
bunx cap sync ios

echo "==> xcodebuild (Debug, iphonesimulator, CODE_SIGNING_ALLOWED=NO)"
xcodebuild \
	-project ios/App/App.xcodeproj \
	-scheme App \
	-configuration Debug \
	-sdk iphonesimulator \
	-destination 'generic/platform=iOS Simulator' \
	CODE_SIGNING_ALLOWED=NO \
	build
