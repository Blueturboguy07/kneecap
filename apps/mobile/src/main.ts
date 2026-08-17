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
// Type-only — erased at build time by every bundler in this repo (esbuild/
// Vite), so this does NOT pull in the real opencut-wasm bindgen package the
// way a value import from `@kneecap/editor-core` would (see this file's own
// top doc comment on why that's still avoided for anything that runs at
// runtime).
import type { Edl } from "@kneecap/editor-core/edl";

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
		<div class="card">
			<h2>M9 — Export project</h2>
			<p style="margin: 0 0 12px; font-size: 13px; color: var(--text-secondary);">
				exportProject(edl), the real NativeBridge call the M8 export sheet
				will eventually make. Builds a hand-authored 2-clip crossfade +
				text-overlay EDL from whatever you imported above (M1's spike
				shape) and drives it through EdlToComposition -&gt; Media3Exporter on
				Android. Import at least one clip first.
			</p>
			<button id="export" type="button">Export demo project</button>
			<pre id="export-log" style="margin-top: 12px;"></pre>
		</div>
	`;
	document.getElementById("refresh")?.addEventListener("click", main);
	document.getElementById("import")?.addEventListener("click", () => {
		void runImportFlow();
	});
	document.getElementById("export")?.addEventListener("click", () => {
		void runExportFlow();
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

/** Fed by `runImportFlow` — the M9 export card below reuses whatever was
 * actually imported, the same way the real M6-M8 timeline UI would export
 * clips a user actually picked, rather than a synthetic asset id. */
let lastImportedHandles: MediaHandle[] = [];

function exportLog(): HTMLElement | null {
	return document.getElementById("export-log");
}

function appendExportLog(line: string) {
	const el = exportLog();
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
	lastImportedHandles = handles;
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

/**
 * A hand-authored 2-clip crossfade + text-overlay EDL — exactly the shape
 * plan M1's spike test and M9's golden-frame harness
 * (`ExportGoldenFrameInstrumentedTest.kt`) both describe — built from
 * whichever real `MediaHandle`(s) the M4 card above actually imported.
 *
 * DELIBERATELY NOT how the real M6-M8 UI will build an EDL: that path is
 * `buildEdl(project)` in `@kneecap/editor-core/edl`, which is the ONE
 * place the seconds/microseconds -> ticks boundary is allowed to be crossed
 * (see `packages/native-bridge/src/types.ts`'s `MediaHandle` doc comment —
 * "editor-core is the only place that turns it into `durationTicks`... goes
 * through the WASM helper, never a bare multiply"). This function is harness
 * code with no `TProject`/`TScene` to feed that real pipeline, so it picks a
 * fixed, simple clip length instead of converting `handle.durationMicros`
 * itself — an approximation acceptable ONLY because this button exists to
 * prove the native М9 call sequence works, not to demonstrate a
 * spec-faithful producer.
 */
function buildDemoEdl(handles: MediaHandle[]): Edl {
	const ticksPerSecond = 120_000;
	const oneSecondTicks = ticksPerSecond;
	const transitionTicks = ticksPerSecond / 5; // 200ms crossfade.
	const clipLengthTicks = (handle: MediaHandle) =>
		Math.min(oneSecondTicks, Math.floor((handle.durationMicros / 1_000_000) * ticksPerSecond) || oneSecondTicks);

	const handleA = handles[0];
	const handleB = handles[1] ?? handles[0];
	if (!handleA) {
		throw new Error("buildDemoEdl requires at least one imported handle");
	}
	const lengthA = clipLengthTicks(handleA);
	const lengthB = clipLengthTicks(handleB);

	const identityTransform = { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1, rotateDegrees: 0 };

	return {
		$schema: "https://kneecap.dev/schema/edl-v1.json",
		meta: {
			edlVersion: 1,
			generator: "kneecap-mobile-harness-demo",
			ticksPerSecond,
			frameRate: { numerator: 30, denominator: 1 },
			canvas: { width: handleA.width || 1080, height: handleA.height || 1920 },
			background: { type: "color", color: "#000000" },
			projectId: "demo-export",
			projectName: "M9 export demo",
			sceneId: "scene-1",
			sceneName: "Scene 1",
			durationTicks: lengthA + lengthB,
		},
		assets: [handleA, handleB]
			.filter((h, i, arr) => arr.findIndex((x) => x.id === h.id) === i)
			.map((h) => ({
				assetId: h.id,
				kind: h.kind === "audio" ? "audio" : h.kind === "image" ? "image" : "video",
				name: h.fileName,
				sourceUri: h.uri,
				proxyUri: null,
				codec: h.codec,
				width: h.width || null,
				height: h.height || null,
				durationTicks: Math.floor((h.durationMicros / 1_000_000) * ticksPerSecond),
				rotationDegrees: h.rotationDegrees,
				hasAudio: h.hasAudio,
			})),
		tracks: [
			{
				trackId: "track-main",
				kind: "main",
				trackType: "video",
				name: "Main",
				zIndex: 0,
				muted: false,
				hidden: false,
				clips: [
					{
						clipId: "clip-a",
						kind: "video",
						assetId: handleA.id,
						name: handleA.fileName,
						startTicks: 0,
						durationTicks: lengthA,
						sourceStartTicks: 0,
						sourceEndTicks: lengthA,
						trimEndTicks: 0,
						speed: { numerator: 1, denominator: 1 },
						maintainPitch: false,
						volumeDb: 0,
						muted: false,
						hidden: false,
						transform: identityTransform,
						opacity: 1,
						blendMode: "normal",
						effects: [],
						masks: [],
						animations: [],
						params: {},
					},
					{
						clipId: "clip-b",
						kind: "video",
						assetId: handleB.id,
						name: handleB.fileName,
						startTicks: lengthA,
						durationTicks: lengthB,
						sourceStartTicks: 0,
						sourceEndTicks: lengthB,
						trimEndTicks: 0,
						speed: { numerator: 1, denominator: 1 },
						maintainPitch: false,
						volumeDb: 0,
						muted: false,
						hidden: false,
						transform: identityTransform,
						opacity: 1,
						blendMode: "normal",
						effects: [],
						masks: [],
						animations: [],
						params: {},
					},
				],
			},
			{
				trackId: "track-text",
				kind: "overlay",
				trackType: "text",
				name: "Text",
				zIndex: 1,
				muted: false,
				hidden: false,
				clips: [
					{
						clipId: "clip-title",
						kind: "text",
						assetId: null,
						name: "Title",
						startTicks: 0,
						durationTicks: lengthA + lengthB,
						sourceStartTicks: 0,
						sourceEndTicks: 0,
						trimEndTicks: 0,
						speed: { numerator: 1, denominator: 1 },
						maintainPitch: false,
						volumeDb: 0,
						muted: false,
						hidden: false,
						transform: { ...identityTransform, positionY: -200 },
						opacity: 1,
						blendMode: "normal",
						effects: [],
						masks: [],
						animations: [],
						params: { content: "kneecap", fontSize: 48, color: "#00CAE0" },
					},
				],
			},
		],
		transitions: [
			{
				transitionId: "t-1",
				afterClipId: "clip-a",
				kind: "crossfade",
				durationTicks: Math.min(transitionTicks, lengthA, lengthB),
			},
		],
		overlays: [
			{
				overlayId: "o-1",
				kind: "text",
				trackId: "track-text",
				clipId: "clip-title",
				zIndex: 0,
				startTicks: 0,
				durationTicks: lengthA + lengthB,
			},
		],
		output: {
			container: "mp4",
			videoCodec: "avc1",
			audioCodec: "mp4a",
			bitrate: 8_000_000,
			fps: { numerator: 30, denominator: 1 },
			resolution: { width: handleA.width || 1080, height: handleA.height || 1920 },
			includeAudio: true,
		},
	};
}

async function runExportFlow() {
	const el = exportLog();
	if (el) el.textContent = "";
	if (lastImportedHandles.length === 0) {
		appendExportLog("import at least one clip above first.");
		return;
	}
	const bridge = await getNativeBridge();
	let edl: Edl;
	try {
		edl = buildDemoEdl(lastImportedHandles);
	} catch (err) {
		appendExportLog(`buildDemoEdl failed: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	appendExportLog("exportProject(edl) — 2-clip crossfade + text-overlay demo EDL...");
	try {
		for await (const progress of bridge.exportProject({ edl })) {
			appendExportLog(`export: ${JSON.stringify(progress)}`);
		}
	} catch (err) {
		appendExportLog(
			`exportProject failed: ${err instanceof Error ? err.message : String(err)}`,
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
