/**
 * kneecap M3 shell harness, extended in M4 with an import-flow proof.
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
 * M4 addition: an "Import media" card that drives the real
 * pickMedia -> generateProxy -> generateThumbnails pipeline end to end
 * through `NativeBridge`, the same call sequence the M6-M8 CapCut timeline
 * UI will eventually make from its own import flow. This is still harness
 * code, not that UI — it renders raw JSON, not a filmstrip — but the calls
 * themselves are the real ones.
 *
 * No `@capacitor/*` import here — that is exactly what the bridge-import
 * gate (scripts/invariants.sh + the no-restricted-imports ESLint rule) exists
 * to prevent. Platform info comes from `bridge.platform` instead.
 */
import { getNativeBridge } from "@kneecap/native-bridge";
import type {
	DeviceCapabilities,
	MediaHandle,
	NativeBridge,
} from "@kneecap/native-bridge";

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
		<span class="badge">M3/M4 shell harness — not the editor UI</span>
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
		<div class="card">
			<h2>M4 — Import media</h2>
			<p style="margin: 0 0 12px; font-size: 13px; color: var(--text-secondary);">
				pickMedia() -&gt; generateProxy() -&gt; generateThumbnails(), the real
				NativeBridge calls the M6-M8 timeline UI will eventually make from its
				own import flow.
			</p>
			<button id="import" type="button">Import from library</button>
			<pre id="import-log" style="margin-top: 12px;"></pre>
		</div>
	`;
	document.getElementById("refresh")?.addEventListener("click", main);
	document.getElementById("import")?.addEventListener("click", () => {
		void runImportFlow();
	});
}

function importLog(): HTMLElement | null {
	return document.getElementById("import-log");
}

function appendImportLog(line: string) {
	const el = importLog();
	if (!el) return;
	el.textContent = `${el.textContent ?? ""}${el.textContent ? "\n" : ""}${line}`;
}

/**
 * The real M4 pipeline, driven from a button tap: native picker ->
 * native custody + probe -> native proxy transcode (progress streamed via
 * `proxyProgress` events, consumed here as an async generator) -> native
 * thumbnail strip. Every call goes through `NativeBridge` — nothing here
 * touches `@capacitor/*` directly (bridge-import gate).
 */
async function runImportFlow() {
	const el = importLog();
	if (el) el.textContent = "";
	const bridge = await getNativeBridge();

	let handles: MediaHandle[];
	try {
		appendImportLog("pickMedia({ kinds: [video], allowMultiple: false })...");
		handles = await bridge.pickMedia({ kinds: ["video"], allowMultiple: false });
	} catch (err) {
		appendImportLog(
			`pickMedia failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}

	if (handles.length === 0) {
		appendImportLog("pickMedia resolved with 0 handles (cancelled, or web fallback with no <input> result).");
		return;
	}

	for (const handle of handles) {
		appendImportLog(`imported: ${JSON.stringify(handle, null, 2)}`);
		await runProxyGeneration(bridge, handle);
		await runThumbnailGeneration(bridge, handle);
	}
}

async function runProxyGeneration(bridge: NativeBridge, handle: MediaHandle) {
	try {
		for await (const progress of bridge.generateProxy({
			handle,
			spec: { targetHeight: 540, shortGop: true },
		})) {
			appendImportLog(`proxy [${handle.id}]: ${JSON.stringify(progress)}`);
		}
	} catch (err) {
		appendImportLog(
			`generateProxy failed [${handle.id}]: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

async function runThumbnailGeneration(bridge: NativeBridge, handle: MediaHandle) {
	try {
		const strip = await bridge.generateThumbnails({
			handle,
			spec: { count: 8, maxEdgePx: 200 },
		});
		appendImportLog(`thumbnails [${handle.id}]: ${JSON.stringify(strip)}`);
	} catch (err) {
		appendImportLog(
			`generateThumbnails failed [${handle.id}]: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
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
