#!/usr/bin/env bash
# kneecap M10 — build-step download of the bundled whisper.cpp GGML model.
#
# Plan M10 item 1: "Ship models in the app bundle so captions work offline
# from first launch," fetched at BUILD time, never committed to git (142MB+
# binary weights, and license-distinct from this repo's own MIT code — see
# THIRD_PARTY_NOTICES). This mirrors the exact pattern the (real,
# upstream) whisper.cpp repo itself uses for its own examples
# (`models/download-ggml-model.sh`) — same source, same URL shape — with
# two kneecap-specific additions: (1) it drops the file straight into BOTH
# platforms' bundle-asset locations in one invocation, since both need the
# identical weights, and (2) it verifies against a checksum this project
# captured directly (see PINNED_SHA256 below), as a MISMATCH WARNING, not
# a hard failure — Hugging Face is not a source this repo controls, and a
# legitimate re-upload of the same model is more likely than tampering, so
# treating a mismatch as fatal would just make CI flaky. A mismatch is
# printed loudly either way; nothing here silently accepts a corrupt file
# (short-read / non-2xx downloads are already `curl --fail`'d).
#
# Usage:
#   scripts/download-whisper-model.sh <tiny.en|base.en> [--platform ios|android|both]
#
# Verified for real in this repo's M10 session (2026-08-17): both models
# below were downloaded from the URLs used here and independently
# transcribed a sample clip with `whisper-cli` on this machine — see
# packages/native-bridge/src/__tests__/fixtures/jfk-dtw-raw.ts for the
# base.en capture this produced.
set -euo pipefail

MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MODEL="${1:-}"
PLATFORM="both"
if [ "${2:-}" = "--platform" ]; then
	PLATFORM="${3:-both}"
fi

if [ -z "$MODEL" ]; then
	echo "Usage: $0 <tiny.en|base.en> [--platform ios|android|both]" >&2
	echo "  tiny.en — plan M10's default bundled model (~75MiB disk, ~273MB peak RSS)" >&2
	echo "  base.en — plan M10's quality option, gated on DeviceCapabilities RAM tier (~142MiB disk, ~388MB peak RSS)" >&2
	exit 1
fi

case "$MODEL" in
	tiny.en|base.en) ;;
	*)
		echo "Unsupported model '$MODEL'. kneecap v1 only ships English models (plan M10 default: tiny.en; quality option: base.en)." >&2
		echo "whisper.cpp itself supports more (see upstream models/download-ggml-model.sh) — widen this case if a future milestone needs one." >&2
		exit 1
		;;
esac

SRC="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL}.bin"

# Captured directly on this machine by running `shasum -a 256` against a
# freshly downloaded copy of each file during the M10 session — NOT copied
# from an upstream manifest (whisper.cpp's own download script ships no
# checksums to verify against). Treated as a soft pin: see header comment.
case "$MODEL" in
	tiny.en) PINNED_SHA256="921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f" ;;
	base.en) PINNED_SHA256="a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002" ;;
esac

download_to() {
	local dest_dir="$1"
	mkdir -p "$dest_dir"
	local dest_file="$dest_dir/ggml-${MODEL}.bin"

	if [ -f "$dest_file" ]; then
		echo "==> $dest_file already exists, skipping download"
		return 0
	fi

	echo "==> Downloading ggml-${MODEL}.bin from $SRC"
	echo "    -> $dest_file"
	curl -L --fail --retry 5 --retry-delay 5 --retry-all-errors --retry-connrefused \
		-o "$dest_file.partial" "$SRC"
	mv "$dest_file.partial" "$dest_file"

	local actual_sha256
	actual_sha256="$(shasum -a 256 "$dest_file" | cut -d' ' -f1)"
	if [ "$actual_sha256" = "$PINNED_SHA256" ]; then
		echo "    sha256 OK ($actual_sha256)"
	else
		echo "    WARNING: sha256 mismatch for $dest_file" >&2
		echo "      expected (pinned $(date +%Y)-08-17 capture): $PINNED_SHA256" >&2
		echo "      actual:                                     $actual_sha256" >&2
		echo "      Not failing the build — see this script's header comment for why — but verify manually before shipping." >&2
	fi
}

if [ "$PLATFORM" = "android" ] || [ "$PLATFORM" = "both" ]; then
	download_to "$MOBILE_DIR/android/app/src/main/assets/models"
fi

if [ "$PLATFORM" = "ios" ] || [ "$PLATFORM" = "both" ]; then
	download_to "$MOBILE_DIR/ios/App/App/Resources/models"
fi

echo "==> Done."
