#!/usr/bin/env bash
# setup.md step 6: installs a built simulator App.app, starts it with
# PUBLIK_SELF_TEST=1, and waits for the line `publik self-test: ok kneecap
# <version>`. The app prints it after a real GET /wallet answers, then
# exits. SIMCTL_CHILD_* sets the app's environment. Only that one line is
# printed here: the app's own log is never shown.
#
#   bash scripts/ios-sim-self-test.sh <path/to/App.app>
set -euo pipefail

APP="${1:?usage: ios-sim-self-test.sh <App.app>}"
UDID="$(xcrun simctl list devices available -j | python3 -c '
import json, sys
devices = json.load(sys.stdin)["devices"]
for runtime in sorted(devices, reverse=True):
    if "iOS" in runtime:
        for d in devices[runtime]:
            if d["name"].startswith("iPhone"):
                print(d["udid"]); sys.exit(0)
sys.exit("no iPhone simulator")')"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b > /dev/null
xcrun simctl terminate "$UDID" dev.kneecap.app 2>/dev/null || true
xcrun simctl install "$UDID" "$APP"
OUT="$(mktemp)"
ERR="$(mktemp)"
SIMCTL_CHILD_PUBLIK_SELF_TEST=1 SIMCTL_CHILD_DO_NOT_TRACK=1 xcrun simctl launch \
	--stdout="$OUT" --stderr="$ERR" "$UDID" dev.kneecap.app > /dev/null
for _ in $(seq 1 90); do grep -q "publik self-test:" "$OUT" && break; sleep 2; done
LINE="$(grep -m1 -o "publik self-test: .*" "$OUT" || true)"
rm -f "$OUT" "$ERR"
echo "${LINE:-publik self-test: no line in 180 s}"
case "$LINE" in "publik self-test: ok kneecap "*) ;; *) exit 1 ;; esac
