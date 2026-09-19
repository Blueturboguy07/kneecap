#!/usr/bin/env bash
# Runs inside reactivecircus/android-emulator-runner once the emulator is
# booted and `adb` is already targeting it.
#
# Reproduces exactly what both reporters describe: install the debug APK
# the guide's own steps produce, then open it (a cold launch of the
# LAUNCHER activity — the app has never run on this device before, so there
# is no cache to have "gone stale"). A FATAL EXCEPTION for our process in
# logcat, or the launcher activity's task disappearing from
# `dumpsys activity activities` within a few seconds, is the bug PRESENT.
set -uo pipefail

PKG="dev.kneecap.app"
APK="apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"

echo "=== adb devices ==="
adb devices -l

echo "=== installing ${APK} ==="
adb install -r "$APK"

echo "=== clearing logcat ==="
adb logcat -c

echo "=== cold launch via LAUNCHER, same as tapping the app icon ==="
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1

echo "=== waiting for the app to either settle or die ==="
sleep 8

echo "=== dumpsys activity activities (looking for ${PKG}) ==="
DUMP="$(adb shell dumpsys activity activities 2>&1)"
echo "$DUMP" | grep -i "$PKG" || echo "(no ${PKG} activity found in the activity stack)"

echo "=== logcat since launch, filtered on AndroidRuntime + our package ==="
LOG="$(adb logcat -d)"
CRASH_LINES="$(echo "$LOG" | grep -E "FATAL EXCEPTION|AndroidRuntime" -A 40 | grep -B2 -A 40 "$PKG" || true)"
echo "$CRASH_LINES"

ACTIVITY_ALIVE=0
echo "$DUMP" | grep -qi "$PKG" && ACTIVITY_ALIVE=1

CRASH_SEEN=0
if echo "$LOG" | grep -q "FATAL EXCEPTION"; then
  if echo "$LOG" | grep -B5 "FATAL EXCEPTION" | grep -q "$PKG"; then
    CRASH_SEEN=1
  fi
fi
# Also treat a process-died line naming our package as a crash signal, in
# case the FATAL EXCEPTION banner itself scrolled out of the -d buffer.
echo "$LOG" | grep -qE "Process $PKG .*has died|Force finishing activity.*$PKG" && CRASH_SEEN=1

echo "=== verdict ==="
echo "activity alive after 8s: $ACTIVITY_ALIVE"
echo "crash signal seen for ${PKG}: $CRASH_SEEN"

if [ "$CRASH_SEEN" = "1" ] || [ "$ACTIVITY_ALIVE" = "0" ]; then
  echo "BUGFIX_LAB_PRESENT"
  exit 1
else
  echo "BUGFIX_LAB_ABSENT"
  exit 0
fi
