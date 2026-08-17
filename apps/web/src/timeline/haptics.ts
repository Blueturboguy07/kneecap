/**
 * Timeline haptic feedback — plan M5 exit criterion: "Snap events fire
 * haptics on both platforms."
 *
 * HONEST SCOPE: this is the one web-observable haptic path available to
 * code running inside a webview, `navigator.vibrate()`. It is real and
 * testable in this session (Chrome/Android WebView implement the Vibration
 * API), but it is NOT the full answer plan §2.4's "native owns hardware"
 * split calls for:
 *   - Android System WebView: `navigator.vibrate()` works — Chromium has
 *     implemented the Vibration API since M18 (2014).
 *   - iOS WKWebView: WebKit has NEVER implemented the Vibration API (no
 *     `navigator.vibrate` at all — it's `undefined`, not a no-op stub), so
 *     this degrades to a genuine no-op on iOS regardless of device
 *     capability. A real haptic tick on iOS requires a native call
 *     (`UIImpactFeedbackGenerator` via a Capacitor Haptics-style bridge
 *     method), which is NOT implemented here — `packages/native-bridge`'s
 *     `NativeBridge` interface (plan §2.4) has no haptics method yet, and
 *     wiring one through Swift/Kotlin is out of this milestone's scope.
 *     Tracked as a gap in the M5 handoff, not silently claimed as done.
 *
 * `tick()` is intentionally synchronous, side-effect-only, and never throws
 * — every call site in the timeline controllers is a hot gesture-handling
 * path and must not have its control flow depend on haptic availability.
 */

const SNAP_TICK_MS = 10;

export function hapticTick(): void {
	if (typeof navigator === "undefined") return;
	const vibrate = navigator.vibrate?.bind(navigator);
	if (!vibrate) return;
	try {
		vibrate(SNAP_TICK_MS);
	} catch {
		// Some browsers throw if called outside a user-gesture task or with
		// vibration disabled at the OS level — never let a haptic miss break
		// the gesture it was decorating.
	}
}
