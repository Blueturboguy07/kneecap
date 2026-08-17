#!/usr/bin/env bash
# kneecap M1 spike — regenerates the small test-fixture videos this harness
# ships with. Committed as binaries (apps/mobile/spike-assets/,
# apps/mobile/android/app/src/main/assets/spike/) so the harness has zero
# build-time ffmpeg dependency; re-run this only if you need to change them.
#
# Requires ffmpeg with libx264 (not required to have libfreetype/drawtext —
# this script deliberately avoids it, see below).
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v ffmpeg >/dev/null 2>&1 || {
	echo "ffmpeg not found — install via 'brew install ffmpeg'." >&2
	exit 1
}

# --- Test 2 fixtures: apps/mobile/public/spike-assets/{proxy,full}.mp4 -----
# `public/` is Vite's default `publicDir` — everything under it is copied
# verbatim into `www/` at build time, so these end up at
# `www/spike-assets/{proxy,full}.mp4`, fetchable from spike.html at
# `./spike-assets/proxy.mp4` (scrub-latency.ts). Fetched over the webview's
# local server (not bundled as a native asset) — mediabunny needs a
# File/Blob, and these are plain static web assets, same as spike.html
# itself.
#
# proxy.mp4: 540p, `-g 1` — near-all-intra / short-GOP, simulating a
# natively-generated preview proxy (plan Amendment 4).
# full.mp4: 1080p, `-g 250` — long-GOP, simulating the untouched source clip.
# Verified via `ffprobe -skip_frame nokey`: proxy.mp4 has 360/360 keyframes
# (every frame), full.mp4 has 2/360 (true long-GOP) — the GOP difference
# Test 2 is measuring is real, not just a filename.
#
# No `drawtext` burn-in: this repo's ffmpeg build has no libfreetype
# (`No such filter: 'drawtext'`, verified directly) — plain testsrc2 pattern
# only, which is sufficient (the test measures decode/seek latency, not
# frame content).
ASSETS_DIR="$MOBILE_DIR/public/spike-assets"
mkdir -p "$ASSETS_DIR"

ffmpeg -y -f lavfi -i "testsrc2=size=960x540:rate=30:duration=12" \
	-c:v libx264 -preset veryfast -g 1 -keyint_min 1 -sc_threshold 0 -crf 28 -pix_fmt yuv420p \
	-movflags +faststart \
	"$ASSETS_DIR/proxy.mp4"

ffmpeg -y -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=12" \
	-c:v libx264 -preset veryfast -g 250 -keyint_min 250 -sc_threshold 0 -crf 20 -pix_fmt yuv420p \
	-movflags +faststart \
	"$ASSETS_DIR/full.mp4"

# --- Test 3 fixtures (Android only): android/.../assets/spike/{clip-a,clip-b}.mp4
# iOS generates its Test 3 source clips ON-DEVICE at run time instead (see
# SpikeDiagnosticsPlugin.swift) specifically to avoid hand-editing
# App.xcodeproj/project.pbxproj's explicit (non-file-system-synchronized)
# file-reference list for a throwaway spike fixture. Android's asset system
# needs no project-file changes to add a file to `assets/` — bundling is the
# lower-risk choice on that platform, hence the asymmetry.
ANDROID_ASSETS_DIR="$MOBILE_DIR/android/app/src/main/assets/spike"
mkdir -p "$ANDROID_ASSETS_DIR"

ffmpeg -y -f lavfi -i "color=c=red:size=1280x720:rate=30:duration=3" \
	-f lavfi -i "sine=frequency=440:duration=3" \
	-c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest \
	-movflags +faststart \
	"$ANDROID_ASSETS_DIR/clip-a.mp4"

ffmpeg -y -f lavfi -i "color=c=blue:size=1280x720:rate=30:duration=3" \
	-f lavfi -i "sine=frequency=880:duration=3" \
	-c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest \
	-movflags +faststart \
	"$ANDROID_ASSETS_DIR/clip-b.mp4"

echo "Done. Regenerated:"
echo "  $ASSETS_DIR/proxy.mp4"
echo "  $ASSETS_DIR/full.mp4"
echo "  $ANDROID_ASSETS_DIR/clip-a.mp4"
echo "  $ANDROID_ASSETS_DIR/clip-b.mp4"
