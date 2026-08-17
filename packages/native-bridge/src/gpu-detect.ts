/**
 * GPU backend detection — the WebView-side half of `DeviceCapabilities`.
 *
 * Plan §1.1: WebGPU is preferred, WebGL2 is the guaranteed baseline. Plan M1
 * says the spike "must instrument which backend actually initialized on each
 * device tier and log it — silent backend selection is unacceptable." This
 * module is the reusable probe both `web-fallback.ts` and `capacitor-bridge.ts`
 * share, since GPU feature detection runs in the WebView's JS context on
 * every shell (web, iOS WKWebView, Android WebView alike) — there is nothing
 * shell-specific about it.
 *
 * NOTE: this checks for API *availability + adapter acquisition*, not which
 * backend `opencut-wasm`'s wgpu instance actually chose at runtime. That is a
 * stronger claim the WASM core itself must log (plan M1 item 1) once it is
 * wired up; this function is the fallback signal for `DeviceCapabilities`
 * when nothing from the compositor is available yet.
 */

export type GpuBackend = "webgpu" | "webgl2" | "unknown";

interface MinimalGpuNavigator {
	gpu?: { requestAdapter: () => Promise<unknown> };
}

export async function detectGpuBackend(): Promise<GpuBackend> {
	/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- `navigator` is typed too broadly (or absent) for lib.dom's `WebGpuNavigator` here; this narrows to the one field this module reads. */
	const nav: MinimalGpuNavigator | undefined =
		typeof navigator !== "undefined"
			? (navigator as unknown as MinimalGpuNavigator)
			: undefined;
	/* eslint-enable @typescript-eslint/no-unsafe-type-assertion */

	if (nav?.gpu) {
		try {
			const adapter = await nav.gpu.requestAdapter();
			if (adapter) return "webgpu";
		} catch {
			// Fall through to WebGL2.
		}
	}

	if (typeof document !== "undefined") {
		try {
			const canvas = document.createElement("canvas");
			const gl = canvas.getContext("webgl2");
			if (gl) return "webgl2";
		} catch {
			// Fall through to unknown.
		}
	}

	return "unknown";
}
