#!/usr/bin/env bash
# Checks a built kneecap APK (CI: .github/workflows/mobile-ci.yml):
#   release: no developer tools (the spike clips, spike.html, spike-assets,
#            SpikeDiagnosticsPlugin, the kneecap-spike deep link), no CAMERA
#            or RECORD_AUDIO permission, no "capcut" (any case) in any file.
#   debug:   the developer tools are there (src/debug), so the spike guide
#            still works on a debug build.
#
#   bash scripts/check-android-apk.sh <app.apk> <debug|release>
set -euo pipefail

APK="${1:?usage: check-android-apk.sh <app.apk> <debug|release>}"
KIND="${2:?usage: check-android-apk.sh <app.apk> <debug|release>}"
SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
AAPT2="$(find "$SDK_ROOT/build-tools" -maxdepth 2 -name aapt2 -print -quit 2>/dev/null || true)"
[ -n "$AAPT2" ] || { echo "::error::aapt2 not found under $SDK_ROOT/build-tools" >&2; exit 1; }
[ -f "$APK" ] || { echo "::error::$APK not found" >&2; exit 1; }

fail=0
bad() { echo "::error::$*"; fail=1; }

OUT="$(mktemp -d)"
unzip -q "$APK" -d "$OUT"
MANIFEST="$("$AAPT2" dump xmltree --file AndroidManifest.xml "$APK")"
spike_link() { printf '%s\n' "$MANIFEST" | grep -q '"kneecap-spike"'; }
spike_clips() { [ -e "$OUT/assets/spike/clip-a.mp4" ]; }
spike_plugin() { grep -aq 'dev/kneecap/app/SpikeDiagnosticsPlugin' "$OUT"/classes*.dex; }

if [ "$KIND" = "release" ]; then
	spike_link && bad "a release APK has the kneecap-spike deep link"
	spike_clips && bad "a release APK has the spike test clips (assets/spike)"
	spike_plugin && bad "a release APK has SpikeDiagnosticsPlugin"
	for item in assets/public/spike.html assets/public/spike-assets; do
		if [ -e "$OUT/$item" ]; then bad "developer tool in a release APK: $item"; fi
	done
	for perm in CAMERA RECORD_AUDIO; do
		if printf '%s\n' "$MANIFEST" | grep -q "\"android.permission.$perm\""; then bad "a release APK asks for android.permission.$perm"; fi
	done
	if grep -rlia capcut "$OUT"; then bad "the word CapCut is in the files listed above"; fi
else
	spike_link || bad "a debug APK has no kneecap-spike deep link (src/debug/AndroidManifest.xml)"
	spike_clips || bad "a debug APK has no spike test clips (src/debug/assets/spike)"
	spike_plugin || bad "a debug APK has no SpikeDiagnosticsPlugin (src/debug/java)"
fi

rm -rf "$OUT"
if [ "$fail" -eq 0 ]; then echo "APK OK ($KIND)"; fi
exit "$fail"
