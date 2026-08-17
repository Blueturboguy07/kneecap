/**
 * @kneecap/native-bridge — the ONLY package that knows what shell kneecap is
 * running on (plan §2.4).
 *
 * Usage from a UI host (editor or harness):
 *
 *   import { getNativeBridge } from "@kneecap/native-bridge";
 *   const bridge = await getNativeBridge();
 *   const caps = await bridge.capabilities();
 *
 * No editor UI file may import `./web-fallback`, `./capacitor-bridge`,
 * `@capacitor/*`, or `@tauri-apps/*` directly — only this module's
 * `getNativeBridge()`. Enforced by `scripts/invariants.sh`'s bridge-import
 * gate and the `no-restricted-imports` ESLint rule.
 */
export * from "./types";

import type { NativeBridge } from "./types";

let cached: NativeBridge | null = null;

/**
 * Selects the web-fallback or Capacitor implementation at runtime, based on
 * `Capacitor.isNativePlatform()`. The Capacitor SDK itself detects "native or
 * plain browser" safely either way, so this is the one place that check
 * happens — callers never branch on platform themselves.
 */
export async function getNativeBridge(): Promise<NativeBridge> {
	if (cached) return cached;

	let isNative = false;
	try {
		const { Capacitor } = await import("@capacitor/core");
		isNative = Capacitor.isNativePlatform();
	} catch {
		// @capacitor/core isn't installed in this host (e.g. a plain web dev
		// harness) — fall through to the web fallback.
		isNative = false;
	}

	cached = isNative
		? (await import("./capacitor-bridge")).createCapacitorBridge()
		: (await import("./web-fallback")).createWebFallbackBridge();

	return cached;
}

/** Test-only: clears the memoized bridge so a fresh `getNativeBridge()` call
 * re-selects. */
export function _resetNativeBridgeForTests(): void {
	cached = null;
}
