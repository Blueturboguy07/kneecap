/**
 * kneecap M1 spike harness — hidden diagnostics screen.
 *
 * THROWAWAY (plan M1). Entry point: `apps/mobile/spike.html`, a second Vite
 * page bundled alongside the product's `index.html` into the same `www/`
 * output but never linked from product UI — see `docs/SPIKE-GUIDE.md` for
 * exactly how a human reaches this screen on a built app (a `kneecap-spike://`
 * deep link, checked once the app has finished its one-time first-run
 * screen).
 *
 * Six tests, each independently runnable, plus "Run all" and a JSON
 * export/share action. Nothing here decides pass/kill — `thresholds.ts` data
 * only colors badges; the founder reads the exported JSON against plan M1's
 * table and makes the call plan §7 describes.
 */
import { getNativeBridge } from "@kneecap/native-bridge";
import { M1_THRESHOLDS } from "./thresholds";
import { buildExport, recordResult, setEnvironment, shareResults } from "./results-store";
import { runBackendFrameTimeAndMemoryWatermark } from "./tests/backend-frametime";
import { runScrubLatency } from "./tests/scrub-latency";
import { runNativeExport } from "./tests/native-export";
import { runTranscription } from "./tests/transcription";
import { runOpfsStorage } from "./tests/opfs-storage";
import type {
	AnyTestResult,
	BackendFrameTimeResult,
	MemoryWatermarkResult,
	NativeExportResult,
	OpfsStorageResult,
	ScrubLatencyResult,
	TranscriptionResult,
} from "./types";

type CardId =
	| "backend-frametime"
	| "memory-watermark"
	| "scrub-latency"
	| "native-export"
	| "transcription"
	| "opfs-storage";

const CARD_ORDER: { id: CardId; title: string; thresholdKey: keyof typeof M1_THRESHOLDS | null }[] = [
	{ id: "backend-frametime", title: "1. Compositor backend + frame time", thresholdKey: "backendFrameTime" },
	{ id: "memory-watermark", title: "6. Peak webview RSS watermark", thresholdKey: "peakRss" },
	{ id: "scrub-latency", title: "2. Scrub latency (proxy vs full)", thresholdKey: "scrubLatency" },
	{ id: "native-export", title: "3. Native hardware export (crossfade + text)", thresholdKey: "nativeExport" },
	{ id: "transcription", title: "4. whisper.cpp tiny word timings", thresholdKey: "whisperTiny" },
	{ id: "opfs-storage", title: "5. OPFS 200MB write/read", thresholdKey: "opfsWrite" },
];

const statusEls = new Map<CardId, HTMLElement>();
const outputEls = new Map<CardId, HTMLElement>();

function el(tag: string, className?: string, text?: string): HTMLElement {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function setStatus(id: CardId, label: string, kind: "idle" | "running" | "done" | "error") {
	const node = statusEls.get(id);
	if (!node) return;
	node.textContent = label;
	node.className = `status status-${kind}`;
}

function setOutput(id: CardId, value: unknown) {
	const node = outputEls.get(id);
	if (!node) return;
	node.textContent = JSON.stringify(value, null, 2);
}

function buildCard({
	id,
	title,
	thresholdKey,
	onRun,
}: {
	id: CardId;
	title: string;
	thresholdKey: keyof typeof M1_THRESHOLDS | null;
	onRun: () => Promise<void>;
}): HTMLElement {
	const card = el("section", "card");
	const header = el("div", "card-header");
	header.appendChild(el("h2", undefined, title));
	const status = el("span", "status status-idle", "idle");
	statusEls.set(id, status);
	header.appendChild(status);
	card.appendChild(header);

	if (thresholdKey) {
		const t = M1_THRESHOLDS[thresholdKey];
		const thresholdRow = el(
			"p",
			"threshold",
			`pass ${t.pass} · investigate ${t.investigate} · kill ${t.killSignal}`,
		);
		card.appendChild(thresholdRow);
	}

	const button = el("button", undefined, "Run") as HTMLButtonElement;
	button.type = "button";
	button.addEventListener("click", () => {
		void (async () => {
			button.disabled = true;
			setStatus(id, "running…", "running");
			try {
				await onRun();
				setStatus(id, "done", "done");
			} catch (err) {
				setStatus(id, "error", "error");
				setOutput(id, { error: err instanceof Error ? err.message : String(err) });
			} finally {
				button.disabled = false;
			}
		})();
	});
	card.appendChild(button);

	const output = el("pre", "output", "(not run yet)");
	outputEls.set(id, output);
	card.appendChild(output);

	return card;
}

async function runAndRecordBackendFrameTime() {
	const { backendFrameTime, memoryWatermark } = await runBackendFrameTimeAndMemoryWatermark();
	recordResult(backendFrameTime as BackendFrameTimeResult);
	recordResult(memoryWatermark as MemoryWatermarkResult);
	setOutput("backend-frametime", backendFrameTime);
	setOutput("memory-watermark", memoryWatermark);
	setStatus("memory-watermark", memoryWatermark.error ? "error" : "done", memoryWatermark.error ? "error" : "done");
}

async function runAndRecord<T extends AnyTestResult>({
	id,
	run,
}: {
	id: CardId;
	run: () => Promise<T>;
}) {
	const result = await run();
	recordResult(result);
	setOutput(id, result);
}

async function runAll() {
	// Sequential, not Promise.all: several of these (backend-frametime,
	// scrub-latency) are deliberately heavy and their timings would pollute
	// each other if run concurrently.
	await runAndRecordBackendFrameTime();
	await runAndRecord<ScrubLatencyResult>({ id: "scrub-latency", run: runScrubLatency });
	await runAndRecord<NativeExportResult>({ id: "native-export", run: runNativeExport });
	await runAndRecord<TranscriptionResult>({ id: "transcription", run: runTranscription });
	await runAndRecord<OpfsStorageResult>({ id: "opfs-storage", run: runOpfsStorage });
}

async function initEnvironment() {
	const bridge = await getNativeBridge();
	try {
		const caps = await bridge.capabilities();
		setEnvironment({
			platform: caps.platform,
			userAgent: navigator.userAgent,
			deviceModel: caps.deviceModel,
			osVersion: caps.osVersion,
			ramTierMb: caps.ramTierMb,
			timestampIso: new Date().toISOString(),
		});
		return caps;
	} catch (err) {
		setEnvironment({
			platform: bridge.platform,
			userAgent: navigator.userAgent,
			deviceModel: null,
			osVersion: null,
			ramTierMb: null,
			timestampIso: new Date().toISOString(),
		});
		return { error: err instanceof Error ? err.message : "capabilities() failed" };
	}
}

async function main() {
	const app = document.getElementById("app");
	if (!app) return;
	app.innerHTML = "";

	app.appendChild(el("span", "badge", "M1 SPIKE HARNESS — throwaway, not the product UI"));
	app.appendChild(el("h1", undefined, "kneecap spike"));

	// Automation/CI hook: `spike.html?autorun=1` runs all tests immediately
	// and marks completion on `document.title` + a dedicated DOM node, so a
	// screenshot or a headless-browser text read is enough to confirm the
	// harness executed — no UI-automation tooling required. Deliberately
	// placed above-the-fold (before the Environment card and everything
	// else) so a single screenshot with no scrolling shows every test's
	// full result — this is what agent sessions verifying this harness
	// without UI-automation tooling read from; see docs/SPIKE-GUIDE.md's
	// "verifying without a founder" section. Not how a human founder runs
	// this — that's the "Run all 6 tests" button and the
	// kneecap-spike:// deep link.
	if (new URLSearchParams(location.search).get("autorun") === "1") {
		const autorunStatus = el("p", "export-status", "autorun: running…");
		autorunStatus.id = "autorun-status";
		app.appendChild(autorunStatus);
		const summary = el("pre", "output autorun-summary") as HTMLPreElement;
		summary.id = "autorun-summary";
		app.appendChild(summary);
		void initEnvironment(); // populates results-store's environment for buildExport(), UI not shown in autorun mode
		void runAll().then(
			() => {
				autorunStatus.textContent = "autorun: complete";
				document.title = "kneecap spike — autorun complete";
				summary.textContent = JSON.stringify(buildExport(), null, 2);
				autoScrollForScreenshotVerification();
			},
			(err) => {
				autorunStatus.textContent = `autorun: error — ${err instanceof Error ? err.message : String(err)}`;
				document.title = "kneecap spike — autorun error";
				summary.textContent = JSON.stringify(buildExport(), null, 2);
				autoScrollForScreenshotVerification();
			},
		);
		// Autorun mode is a single-screenshot-readable dump, not the
		// interactive card UI — see this block's header comment.
		return;
	}

	const envCard = el("section", "card");
	envCard.appendChild(el("h2", undefined, "Environment"));
	const envOutput = el("pre", "output", "loading…");
	envCard.appendChild(envOutput);
	app.appendChild(envCard);

	void initEnvironment().then((caps) => {
		envOutput.textContent = JSON.stringify(caps, null, 2);
	});

	const actions = el("div", "actions");
	const runAllBtn = el("button", "primary", "Run all 6 tests") as HTMLButtonElement;
	runAllBtn.type = "button";
	runAllBtn.addEventListener("click", () => {
		void (async () => {
			runAllBtn.disabled = true;
			runAllBtn.textContent = "Running…";
			try {
				await runAll();
			} finally {
				runAllBtn.disabled = false;
				runAllBtn.textContent = "Run all 6 tests";
			}
		})();
	});
	actions.appendChild(runAllBtn);

	const exportBtn = el("button", "secondary", "Export / share results JSON") as HTMLButtonElement;
	exportBtn.type = "button";
	const exportStatus = el("span", "export-status", "");
	exportBtn.addEventListener("click", () => {
		void (async () => {
			const { method } = await shareResults();
			exportStatus.textContent =
				method === "share"
					? "Shared via system share sheet."
					: method === "clipboard"
						? "Copied JSON to clipboard."
						: "Share/clipboard unavailable — see raw JSON below.";
			if (method === "manual") {
				rawJsonOutput.textContent = JSON.stringify(buildExport(), null, 2);
				rawJsonOutput.hidden = false;
			}
		})();
	});
	actions.appendChild(exportBtn);
	actions.appendChild(exportStatus);
	app.appendChild(actions);

	const rawJsonOutput = el("pre", "output raw-json") as HTMLPreElement;
	rawJsonOutput.hidden = true;
	app.appendChild(rawJsonOutput);

	for (const { id, title, thresholdKey } of CARD_ORDER) {
		let onRun: () => Promise<void>;
		switch (id) {
			case "backend-frametime":
				onRun = runAndRecordBackendFrameTime;
				break;
			case "memory-watermark":
				onRun = async () => {
					setOutput(
						"memory-watermark",
						"Run via test 1 (\"Run\" above samples memory during the same load) — run all, or run test 1 first.",
					);
				};
				break;
			case "scrub-latency":
				onRun = () => runAndRecord<ScrubLatencyResult>({ id, run: runScrubLatency });
				break;
			case "native-export":
				onRun = () => runAndRecord<NativeExportResult>({ id, run: runNativeExport });
				break;
			case "transcription":
				onRun = () => runAndRecord<TranscriptionResult>({ id, run: runTranscription });
				break;
			case "opfs-storage":
				onRun = () => runAndRecord<OpfsStorageResult>({ id, run: runOpfsStorage });
				break;
		}
		app.appendChild(buildCard({ id, title, thresholdKey, onRun }));
	}
}

/**
 * Slow, steady auto-scroll (no touch input) purely so a sequence of
 * timed screenshots — taken by a session with no UI-automation/tap
 * capability — can page through the full autorun summary. Real founders
 * scroll normally; this only runs in `?autorun=1` mode.
 */
function autoScrollForScreenshotVerification() {
	const stepPx = 500;
	const intervalMs = 1500;
	const timer = setInterval(() => {
		const atBottom = window.scrollY + window.innerHeight >= document.body.scrollHeight - 4;
		if (atBottom) {
			clearInterval(timer);
			return;
		}
		window.scrollBy({ top: stepPx, behavior: "instant" as ScrollBehavior });
	}, intervalMs);
}

void main();
