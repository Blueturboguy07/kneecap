/**
 * kneecap M3 shell harness.
 *
 * NOT the CapCut UI (that is M6-M8, and doesn't exist yet). NOT the M2-item-6
 * Vite SPA bundle of the real editor either — that item is still open (see
 * the M3 handoff), and this file deliberately does not import
 * `@kneecap/editor-core` because doing so pulls in the real `opencut-wasm`
 * bindgen package through a real bundler for the first time in this repo's
 * history, which is unverified (plan M1's job, not M3's).
 *
 * What this file DOES prove, honestly: the bundle loads with zero network
 * requests from a Capacitor-packaged static build, and the NativeBridge seam
 * (`@kneecap/native-bridge`) resolves and round-trips through whichever
 * implementation is live — the web fallback here in a browser, or the real
 * Capacitor bridge (and its native `NativeBridgePlugin`) on device.
 *
 * No `@capacitor/*` import here — that is exactly what the bridge-import
 * gate (scripts/invariants.sh + the no-restricted-imports ESLint rule) exists
 * to prevent. Platform info comes from `bridge.platform` instead.
 */
import { getNativeBridge } from "@kneecap/native-bridge";
import type { DeviceCapabilities } from "@kneecap/native-bridge";

function render({
	platform,
	capabilitiesText,
	isError,
}: {
	platform: string;
	capabilitiesText: string;
	isError: boolean;
}) {
	const app = document.getElementById("app");
	if (!app) return;
	app.innerHTML = `
		<span class="badge">M3 shell harness — not the editor UI</span>
		<h1>kneecap</h1>
		<div class="card">
			<h2>Platform</h2>
			<pre>${platform}</pre>
		</div>
		<div class="card">
			<h2>NativeBridge.capabilities()</h2>
			<pre class="${isError ? "error" : ""}">${capabilitiesText}</pre>
			<button id="refresh" type="button" style="margin-top: 12px;">Refresh capabilities</button>
		</div>
	`;
	document.getElementById("refresh")?.addEventListener("click", main);
}

function formatCapabilities(caps: DeviceCapabilities): string {
	return JSON.stringify(caps, null, 2);
}

async function main() {
	const bridge = await getNativeBridge();
	try {
		const caps = await bridge.capabilities();
		render({
			platform: bridge.platform,
			capabilitiesText: formatCapabilities(caps),
			isError: false,
		});
	} catch (err) {
		// Expected on the Capacitor bridge until the native NativeBridgePlugin
		// is actually registered on-device (Xcode/Gradle build, not `bun test`)
		// — see the M3 handoff for exactly what has and hasn't been verified.
		render({
			platform: bridge.platform,
			capabilitiesText:
				err instanceof Error ? err.message : "unknown capabilities() error",
			isError: true,
		});
	}
}

main();
