#!/usr/bin/env bash
# Checks a built kneecap App.app against the App Store items in the plan
# (CI: .github/workflows/mobile-ci.yml):
#   - iPhone only (UIDeviceFamily [1]), arm64 in UIRequiredDeviceCapabilities;
#   - ITSAppUsesNonExemptEncryption false (the app has no encryption of its own);
#   - no camera or microphone usage strings (the app never asks for them);
#   - the Photos add-only and speech recognition usage strings are there
#     (the app asks for both);
#   - PrivacyInfo.xcprivacy is in the app and is a valid plist;
#   - no "capcut" (any case) in any file of the app;
#   - no private URL scheme in any file of the app (App Store guideline
#     2.5.1, only public APIs): "photos-redirect" (opens Photos), "prefs:"
#     and "App-Prefs:" (open pages of the Settings app). The public way to
#     open this app's own Settings page is
#     UIApplication.openSettingsURLString; its text is in UIKit, not in
#     the app, so this check does not see it;
#   - Release: no developer tools (spike.html, spike-assets, Fixtures, the
#     kneecap-spike URL scheme) and no NSAllowsLocalNetworking. Debug: the
#     kneecap-spike URL scheme and NSAllowsLocalNetworking are there (the
#     "Debug-only items" build phase adds them).
#
#   bash scripts/check-ios-app.sh <path/to/App.app> <Debug|Release>
set -euo pipefail

APP="${1:?usage: check-ios-app.sh <App.app> <Debug|Release>}"
CONFIG="${2:?usage: check-ios-app.sh <App.app> <Debug|Release>}"
PLIST="$APP/Info.plist"

fail=0
bad() { echo "::error::$*"; fail=1; }
json() { plutil -extract "$1" json -o - "$PLIST" 2>/dev/null || echo "(missing)"; }

[ -f "$PLIST" ] || { echo "::error::$PLIST not found" >&2; exit 1; }

family="$(json UIDeviceFamily)"
[ "$family" = "[1]" ] || bad "UIDeviceFamily is $family, not [1] (iPhone only)"
caps="$(json UIRequiredDeviceCapabilities)"
[ "$caps" = '["arm64"]' ] || bad "UIRequiredDeviceCapabilities is $caps, not [\"arm64\"]"
encryption="$(plutil -extract ITSAppUsesNonExemptEncryption raw -o - "$PLIST" 2>/dev/null || echo "(missing)")"
[ "$encryption" = "false" ] || bad "ITSAppUsesNonExemptEncryption is $encryption, not false"
for key in NSCameraUsageDescription NSMicrophoneUsageDescription; do
	if plutil -extract "$key" raw -o - "$PLIST" >/dev/null 2>&1; then bad "$key is in Info.plist, but the app never asks for it"; fi
done
# The app asks for these two: Photos add-only (save an export) and speech
# recognition (on-device captions). Each needs its text in Info.plist.
for key in NSPhotoLibraryAddUsageDescription NSSpeechRecognitionUsageDescription; do
	text="$(plutil -extract "$key" raw -o - "$PLIST" 2>/dev/null || true)"
	[ -n "$text" ] || bad "$key is not in Info.plist, but the app asks for it"
done

if [ -f "$APP/PrivacyInfo.xcprivacy" ]; then
	plutil -lint "$APP/PrivacyInfo.xcprivacy" >/dev/null || bad "PrivacyInfo.xcprivacy is not a valid plist"
else
	bad "PrivacyInfo.xcprivacy is not in the app"
fi

if grep -rlia capcut "$APP"; then bad "the word CapCut is in the files listed above"; fi

# Private URL schemes (guideline 2.5.1). Case-insensitive, every file
# (binary, frameworks, web bundle); "prefs:" also finds "App-Prefs:".
if grep -rliaE 'photos-redirect|prefs:' "$APP"; then
	bad "a private URL scheme (photos-redirect, prefs: or App-Prefs:) is in the files listed above"
fi

has_spike_scheme() { /usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" "$PLIST" 2>/dev/null | grep -q kneecap-spike; }
has_local_networking() { /usr/libexec/PlistBuddy -c "Print :NSAppTransportSecurity:NSAllowsLocalNetworking" "$PLIST" 2>/dev/null | grep -q true; }
if [ "$CONFIG" = "Release" ]; then
	for item in public/spike.html public/spike-assets Fixtures; do
		if [ -e "$APP/$item" ]; then bad "developer tool in a Release app: $item"; fi
	done
	if has_spike_scheme; then bad "a Release app has the kneecap-spike URL scheme"; fi
	if has_local_networking; then bad "a Release app has NSAllowsLocalNetworking (a test hook)"; fi
else
	has_spike_scheme || bad "a Debug app has no kneecap-spike URL scheme (the Debug-only items build phase did not run)"
	has_local_networking || bad "a Debug app has no NSAllowsLocalNetworking (the Debug-only items build phase did not run)"
fi

if [ "$fail" -eq 0 ]; then echo "iOS app OK ($CONFIG): iPhone only, arm64, no encryption, no camera/mic strings, privacy manifest, no other app's name, no private URL scheme"; fi
exit "$fail"
