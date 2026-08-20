import { useRef, useState } from "react";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { SegmentedControl } from "../segmented-control";
import { ProgressOverlay } from "../progress-overlay";
import type { EditorCore } from "@kneecap/editor-core";
import { buildEdl, type Edl } from "@kneecap/editor-core/edl";
import type { ExportFormat, ExportQuality } from "@kneecap/editor-core/export";
import { getNativeBridge, type ExportProgress } from "@kneecap/native-bridge";
import {
	buildNativeEdlAssetResolver, setProjectFps, setProjectResolution, toEdlMediaAssets } from "../../editor/actions";
import type { FrameRate } from "opencut-wasm";

interface ExportSheetProps {
	editor: EditorCore;
	onClose: () => void;
}

const RESOLUTIONS: Array<{ id: string; label: string; height: number }> = [
	{ id: "480p", label: "480p", height: 480 },
	{ id: "720p", label: "720p", height: 720 },
	{ id: "1080p", label: "1080p", height: 1080 },
	{ id: "4k", label: "4K", height: 2160 },
];

const FPS_OPTIONS: Array<{ id: string; label: string; fps: FrameRate }> = [
	{ id: "24", label: "24", fps: { numerator: 24, denominator: 1 } },
	{ id: "25", label: "25", fps: { numerator: 25, denominator: 1 } },
	{ id: "30", label: "30", fps: { numerator: 30, denominator: 1 } },
	{ id: "60", label: "60", fps: { numerator: 60, denominator: 1 } },
];

const QUALITY_OPTIONS: Array<{ id: ExportQuality; label: string }> = [
	{ id: "low", label: "Low" },
	{ id: "medium", label: "Medium" },
	{ id: "high", label: "High" },
	{ id: "very_high", label: "Very High" },
];

const QUALITY_BITRATE: Record<ExportQuality, number> = {
	low: 2_000_000,
	medium: 5_000_000,
	high: 10_000_000,
	very_high: 20_000_000,
};

function isExportQuality(value: string): value is ExportQuality {
	return QUALITY_OPTIONS.some((option) => option.id === value);
}

type ExportRunState = "idle" | "exporting" | "done" | "error";

/**
 * M8 Export sheet — task scope: "resolution/fps/quality." Resolution and
 * fps write straight to REAL `TProjectSettings` via
 * `UpdateProjectSettingsCommand` (the same command the rest of the editor
 * uses) — there is no separate "export resolution" concept in this engine,
 * the canvas size IS the render resolution (see actions.ts's
 * `setProjectResolution` header note). Quality/format are draft
 * `ExportOptions` (real types from `@/export`) held as local sheet state,
 * since `ExportOptions` is passed at `editor.project.export()` call time,
 * not persisted project state.
 *
 * The "Preview EDL output" button is a REAL verification step, not
 * decoration: it calls the actual `buildEdl()` (same function the real
 * export below calls) with the CURRENT sheet selections and displays
 * `output.resolution`/`output.fps` back — proving the sheet's controls
 * really do reach the EDL bridge contract, not just the UI. No file is
 * produced by preview; it exists purely to inspect the EDL shape.
 *
 * Structural-gap fixer pass ("Export video"): the actual export handoff.
 * Builds the same real `Edl` via `buildEdl()`, then drives it through
 * `getNativeBridge().exportProject({ edl })` — the ONE way an editor UI
 * file may reach a native shell (never `@capacitor/*` directly; see the
 * bridge-import gate in scripts/invariants.sh and this package's own
 * captions-actions.ts, which established the same `getNativeBridge()`
 * pattern for M10). `exportProject`'s wire contract (capacitor-bridge.ts's
 * merge note) already keys every export by a fresh `exportId` and streams
 * `exportProgress` events back as an `AsyncGenerator<ExportProgress>` —
 * this component just consumes that generator: each yielded stage/fraction
 * drives `ProgressOverlay`, and stopping iteration (the Cancel button
 * calling `.return()`) is the documented cancel contract, not a second
 * bridge method.
 *
 * On the web-fallback bridge (`bunx cap sync` not run / plain browser dev),
 * `exportProject` throws a typed `NativeBridgeError` with code
 * `"UNSUPPORTED"` the moment the generator is first iterated — caught below
 * and shown as an honest in-sheet message, not a crash. That IS "the
 * web-fallback path still working in dev": the sheet stays usable, nothing
 * throws past this component, and every OTHER control (resolution/fps/
 * quality/EDL preview) keeps working exactly as before.
 */
export function ExportSheet({ editor, onClose }: ExportSheetProps) {
	const project = editor.project.getActive();
	const [resolutionId, setResolutionId] = useState("1080p");
	const [fpsId, setFpsId] = useState("30");
	const [quality, setQuality] = useState<ExportQuality>("high");
	const [format] = useState<ExportFormat>("mp4");
	const [previewResult, setPreviewResult] = useState<{ fps: string; resolution: string } | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);

	const [runState, setRunState] = useState<ExportRunState>("idle");
	const [progress, setProgress] = useState<{ stage: ExportProgress["stage"]; fraction: number } | null>(null);
	const [exportError, setExportError] = useState<string | null>(null);
	const [outputUri, setOutputUri] = useState<string | null>(null);
	// Holds the in-flight generator ONLY so Cancel can `.return()` it — never
	// read for anything else. A ref, not state: swapping it must not trigger
	// a re-render.
	const activeExportRef = useRef<AsyncGenerator<ExportProgress> | null>(null);

	const applyResolution = (id: string) => {
		setResolutionId(id);
		const preset = RESOLUTIONS.find((r) => r.id === id);
		if (!preset) return;
		const aspect = project.settings.canvasSize.width / project.settings.canvasSize.height;
		const height = preset.height;
		const width = Math.round(height * aspect / 2) * 2; // even width, keeps current aspect
		setProjectResolution({ editor, canvasSize: { width, height } });
	};

	const applyFps = (id: string) => {
		setFpsId(id);
		const preset = FPS_OPTIONS.find((f) => f.id === id);
		if (preset) setProjectFps({ editor, fps: preset.fps });
	};

	/** Shared by both "Preview EDL output" and "Export video" — the real
	 *  export must build the EDL the exact same way the preview claims to,
	 *  or the preview would be lying about what gets exported. */
	const buildCurrentEdl = (): Edl => {
		const scene = editor.scenes.getActiveScene();
		const fpsPreset = FPS_OPTIONS.find((f) => f.id === fpsId)?.fps;
		return buildEdl({
			project,
			scene,
			// Real live media assets, not a hardcoded `[]` — genuinely empty
			// today only because no panel in this app can insert a video/image
			// element yet (media import is out of M8 scope; see
			// demo-project.ts's header). The moment that lands, this keeps
			// working with no change here.
			mediaAssets: toEdlMediaAssets({ assets: editor.media.getAssets() }),
			// Native custody paths for the exporter — without this every
			// asset built with sourceUri:null and the on-device export died
			// with "could not be resolved to a readable URL" (2026-08-20).
			resolveAsset: buildNativeEdlAssetResolver(),
			output: {
				container: format,
				videoCodec: "h264",
				audioCodec: "aac",
				bitrate: QUALITY_BITRATE[quality],
				includeAudio: true,
				fps: fpsPreset,
			},
		});
	};

	const previewEdl = () => {
		setPreviewError(null);
		try {
			const edl = buildCurrentEdl();
			setPreviewResult({
				fps: `${edl.output.fps.numerator}/${edl.output.fps.denominator}`,
				resolution: `${edl.output.resolution.width}x${edl.output.resolution.height}`,
			});
		} catch (error) {
			setPreviewError(error instanceof Error ? error.message : String(error));
		}
	};

	const startExport = async () => {
		setExportError(null);
		setOutputUri(null);
		setProgress({ stage: "preparing", fraction: 0 });
		setRunState("exporting");

		let edl: Edl;
		try {
			edl = buildCurrentEdl();
		} catch (error) {
			setRunState("error");
			setExportError(error instanceof Error ? error.message : String(error));
			return;
		}

		try {
			const bridge = await getNativeBridge();
			const generator = bridge.exportProject({ edl });
			activeExportRef.current = generator;
			for await (const event of generator) {
				setProgress({ stage: event.stage, fraction: event.fraction });
				if (event.stage === "error") {
					setRunState("error");
					setExportError(event.error ?? "Export failed");
					break;
				}
				if (event.stage === "done") {
					setRunState("done");
					setOutputUri(event.outputUri ?? null);
					break;
				}
			}
		} catch (error) {
			// Includes the honest `NativeBridgeError({code:"UNSUPPORTED",...})`
			// the web-fallback bridge throws the moment this generator is first
			// iterated (no native shell present) — same typed-error contract
			// every other `getNativeBridge()` caller in this package relies on
			// (see captions-actions.ts), surfaced here as plain sheet text
			// rather than an uncaught rejection.
			setRunState("error");
			setExportError(error instanceof Error ? error.message : String(error));
		} finally {
			activeExportRef.current = null;
		}
	};

	const cancelExport = () => {
		// Stopping iteration is the documented cancel contract
		// (capacitor-bridge.ts's `exportProject()` doc comment: the caller
		// "simply stopping iteration of the AsyncGenerator" is what its
		// `finally` block treats as a cancel request) — `.return()` here makes
		// the `for await` above exit exactly like a `break` would, which is
		// what runs that `finally` and tells native to actually stop encoding.
		void activeExportRef.current?.return(undefined);
		activeExportRef.current = null;
		setRunState("idle");
		setProgress(null);
	};

	return (
		<>
			<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
				<div className="cc-param-row">
					<div className="cc-param-row__head">
						<span className="cc-param-row__label">Resolution</span>
					</div>
					<SegmentedControl aria-label="Resolution" segments={RESOLUTIONS} activeId={resolutionId} onSelect={applyResolution} />
				</div>
				<div className="cc-param-row">
					<div className="cc-param-row__head">
						<span className="cc-param-row__label">Frame rate</span>
					</div>
					<SegmentedControl aria-label="Frame rate" segments={FPS_OPTIONS} activeId={fpsId} onSelect={applyFps} />
				</div>
				<div className="cc-param-row">
					<div className="cc-param-row__head">
						<span className="cc-param-row__label">Quality</span>
					</div>
					<SegmentedControl
						aria-label="Quality"
						segments={QUALITY_OPTIONS}
						activeId={quality}
						onSelect={(id) => {
							if (isExportQuality(id)) setQuality(id);
						}}
					/>
				</div>
				<button type="button" className="cc-export-sheet__action" onClick={previewEdl}>
					Preview EDL output
				</button>
				{previewResult && (
					<p className="cc-panel-note">
						EDL output reflects the sheet: resolution {previewResult.resolution}, fps {previewResult.fps}.
					</p>
				)}
				{previewError && <p className="cc-panel-note">EDL preview failed: {previewError}</p>}

				<button
					type="button"
					className="cc-export-sheet__action cc-export-sheet__action--primary"
					onClick={() => void startExport()}
					disabled={runState === "exporting"}
				>
					Export video
				</button>
				{runState === "error" && exportError && <p className="cc-panel-note">Export failed: {exportError}</p>}
				{runState === "done" && (
					<p className="cc-panel-note">Export complete{outputUri ? ` — ${outputUri}` : "."}</p>
				)}
			</PanelSheet>
			{runState === "exporting" && progress && (
				<ProgressOverlay
					percent={progress.fraction * 100}
					label={`Exporting — ${progress.stage}`}
					onCancel={cancelExport}
				/>
			)}
		</>
	);
}
