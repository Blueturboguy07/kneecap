/**
 * Haptic tick on snap / long-press-lift (plan M7 item 5, corpus 05 §3b:
 * "CapCut doesn't offer a built-in option to turn off haptic feedback").
 *
 * Same honestly-scoped limitation as apps/web/src/timeline/haptics.ts (M5,
 * commit 50bd2a9f), duplicated rather than imported because this package
 * cannot depend on apps/web (see tsconfig.json header):
 * `navigator.vibrate()` fires on Android WebView; it is a documented no-op
 * on iOS WKWebView (the Vibration API was never implemented in WebKit).
 * Real cross-platform haptics need a `NativeBridge` call
 * (packages/native-bridge) — not added by this milestone.
 */
export function hapticTick(): void {
	if (typeof navigator === "undefined") return;
	const vibrate = navigator.vibrate?.bind(navigator);
	if (!vibrate) return;
	try {
		vibrate(10);
	} catch {
		// Some browsers throw if called outside a user gesture; a missed
		// haptic is not worth surfacing an error for.
	}
}
