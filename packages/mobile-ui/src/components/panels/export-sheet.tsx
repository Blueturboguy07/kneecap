import { useRef, useState } from "react";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { SegmentedControl } from "../segmented-control";
import { ProgressOverlay } from "../progress-overlay";
import type { EditorCore } from "@kneecap/editor-core";
import { buildEdl, type Edl } from "@kneecap/editor-core/edl";
import type { ExportFormat, ExportQuality } from "@kneecap/editor-core/export";
import { getNativeBridge, type ExportProgress, type NativeBridge } from "@kneecap/native-bridge";
import {
	renderOverlayFrames,
	type OverlayFrame,
} from "@kneecap/editor-core/export/overlay-frames";
import {
	buildNativeEdlAssetResolver, setProjectFps, setProjectResolution, toEdlMediaAssets } from "../../editor/actions";
import { shareFileName } from "../../editor/share-file-name";
import type { SceneTracks } from "@kneecap/editor-core/timeline";
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

/** The export progress label in plain words (blind test round 2): never the raw stage
 *  name, which is a developer word such as "muxing". */
const EXPORT_STAGE_WORDS: Record<ExportProgress["stage"], string> = {
	preparing: "getting ready",
	encoding: "making the video",
	muxing: "saving the video",
	done: "done",
	error: "stopped",
};

/** True when a visible graphic track has a visible sticker or graphic
 *  element (1.0.7). Only the preview-drawn overlay frames carry them into
 *  the video. */
function hasVisibleStickersOrGraphics(tracks: SceneTracks): boolean {
	return tracks.overlay.some(
		(track) =>
			track.type === "graphic" &&
			!track.hidden &&
			track.elements.some((element) => !element.hidden),
	);
}

/** The Photos save after "done" (1.0.5, blind test round 2): "saving" while
 *  the permission prompt and the save run, then the real result. */
type PhotosSaveState = "saving" | "saved" | "denied" | "failed";

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
 * The developer button "Preview EDL output" is gone (App Store rule 2.1,
 * completeness): it only printed the EDL's resolution and fps. The EDL
 * tests in packages/editor-core cover that check.
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
 * quality) keeps working exactly as before.
 */
export function ExportSheet({ editor, onClose }: ExportSheetProps) {
	const project = editor.project.getActive();
	// The chip must reflect the ACTUAL output: buildEdl exports at the
	// project's canvasSize, so an untouched sheet showing a hardcoded
	// "1080p" while the canvas was (say) proxy-class 540p silently lied —
	// and that untouched default is exactly the grainy-export path
	// (2026-08-22). Resolution presets mean the canvas's SHORT side (the
	// "p" convention — a portrait 1080×1920 canvas is 1080p).
	const canvasShortSide = Math.min(
		project.settings.canvasSize.width,
		project.settings.canvasSize.height,
	);
	const [resolutionId, setResolutionId] = useState(() => {
		const nearest = [...RESOLUTIONS].sort(
			(a, b) =>
				Math.abs(a.height - canvasShortSide) - Math.abs(b.height - canvasShortSide),
		)[0];
		return nearest?.id ?? "1080p";
	});
	const [fpsId, setFpsId] = useState("30");
	const [quality, setQuality] = useState<ExportQuality>("high");
	const [format] = useState<ExportFormat>("mp4");

	const [runState, setRunState] = useState<ExportRunState>("idle");
	const [progress, setProgress] = useState<{ stage: ExportProgress["stage"]; fraction: number } | null>(null);
	// The result block after "done" (1.0.5): the Photos save state, whether a
	// video file is there to share, and a plain note when Share could not
	// open. 1.0.6: no button opens the Photos app. iOS has no public API for
	// that, and the private URL scheme breaks App Store guideline 2.5.1.
	const [photosSave, setPhotosSave] = useState<PhotosSaveState>("saving");
	const [canShare, setCanShare] = useState(false);
	const [actionNote, setActionNote] = useState<string | null>(null);
	// The finished video's `outputUri`, only ever handed back to the bridge
	// (saveToPhotos / shareFile) — never shown. A ref: it drives no render.
	const exportedUriRef = useRef<string | null>(null);
	// Each export run gets a number, so a slow Photos answer from an older
	// run cannot overwrite the result of a newer one.
	const exportRunRef = useRef(0);
	// The sheet shows plain words only: no file path and no error text. The
	// details go to the console.
	const failExport = (detail: unknown) => {
		console.error("export failed:", detail instanceof Error ? detail.message : detail);
		setRunState("error");
	};
	// Holds the in-flight generator ONLY so Cancel can `.return()` it — never
	// read for anything else. A ref, not state: swapping it must not trigger
	// a re-render.
	const activeExportRef = useRef<AsyncGenerator<ExportProgress> | null>(null);

	// Round 17's video/image-overlay export warning is GONE on purpose:
	// round 19 made the native exporter composite PiP overlay clips for real
	// (video via composition lanes, images as build-time stills — see
	// CompositionBuilder/VideoCompositionBuilder), so there is nothing left
	// to warn about in the media class.

	const applyResolution = (id: string) => {
		setResolutionId(id);
		const preset = RESOLUTIONS.find((r) => r.id === id);
		if (!preset) return;
		// preset.height is the SHORT side ("1080p" on a portrait canvas is
		// 1080×1920, not 608×1080 — the old height-is-vertical math DOWN-
		// graded every portrait project the moment the chip was tapped).
		const { width: cw, height: ch } = project.settings.canvasSize;
		const aspect = cw / ch;
		const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
		const shortSide = preset.height;
		const canvasSize =
			aspect >= 1
				? { width: even(shortSide * aspect), height: shortSide }
				: { width: shortSide, height: even(shortSide / aspect) };
		setProjectResolution({ editor, canvasSize });
	};

	const applyFps = (id: string) => {
		setFpsId(id);
		const preset = FPS_OPTIONS.find((f) => f.id === id);
		if (preset) setProjectFps({ editor, fps: preset.fps });
	};

	/** The EDL for "Export video", from the current sheet selections. */
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

	/**
	 * After "done": save the video to Photos and show the real result (1.0.5,
	 * blind test round 2 — "Export complete." in small grey text, with the
	 * Photos prompt only after it, read as unfinished). The native side asks
	 * for Photos access here, while the sheet says "Saving to Photos…".
	 * `saveToPhotos` never rejects; the catch is only a guard.
	 */
	const saveExportToPhotos = async ({
		bridge,
		uri,
		run,
	}: {
		bridge: NativeBridge;
		uri: string | undefined;
		run: number;
	}) => {
		exportedUriRef.current = uri ?? null;
		setCanShare(Boolean(uri));
		if (!uri) {
			setPhotosSave("failed");
			return;
		}
		let next: PhotosSaveState = "failed";
		try {
			const result = await bridge.saveToPhotos({ uri });
			next = result.saved ? "saved" : result.reason === "denied" ? "denied" : "failed";
		} catch (error) {
			console.error("save to Photos failed:", error instanceof Error ? error.message : error);
		}
		if (exportRunRef.current === run) setPhotosSave(next);
	};

	const shareVideo = async () => {
		const uri = exportedUriRef.current;
		if (!uri) return;
		setActionNote(null);
		try {
			const bridge = await getNativeBridge();
			// 1.0.7 (blind test round 3): the share sheet showed the export's
			// raw id. It now shows "publik kneecap <project name>.mp4".
			const fileName = shareFileName({
				projectName: editor.project.getActive().metadata.name,
				extension: format,
			});
			await bridge.shareFile({ uri, fileName });
		} catch (error) {
			console.error("share failed:", error instanceof Error ? error.message : error);
			setActionNote("Could not open Share.");
		}
	};

	const handleShare = () => {
		void shareVideo();
	};

	const startExport = async () => {
		const run = exportRunRef.current + 1;
		exportRunRef.current = run;
		exportedUriRef.current = null;
		setCanShare(false);
		setActionNote(null);
		setPhotosSave("saving");
		setProgress({ stage: "preparing", fraction: 0 });
		setRunState("exporting");

		let edl: Edl;
		try {
			edl = buildCurrentEdl();
		} catch (error) {
			failExport(error);
			return;
		}

		try {
			const bridge = await getNativeBridge();
			// Render text/captions with the PREVIEW's own code (round 37) and
			// hand the exporter the resulting images — one implementation of
			// the visual contract, so what you saw is what you get. A failure
			// here degrades to the native text path rather than blocking the
			// export.
			let overlayFrames: OverlayFrame[] = [];
			try {
				setProgress({ stage: "preparing", fraction: 0 });
				overlayFrames = await renderOverlayFrames({
					tracks: editor.scenes.getActiveScene().tracks,
					mediaAssets: editor.media.getAssets(),
					canvasSize: {
						width: edl.output.resolution.width,
						height: edl.output.resolution.height,
					},
					fps: edl.output.fps,
					durationTicks: edl.meta.durationTicks,
					ticksPerSecond: edl.meta.ticksPerSecond,
					onProgress: (fraction: number) =>
						setProgress({ stage: "preparing", fraction: fraction * 0.2 }),
				});
			} catch (error) {
				// The native text path can still draw text and captions, but
				// nothing native draws a sticker or a graphic (1.0.7, blind test
				// round 3). With one on the timeline, a video without it would
				// be wrong, so the export stops with the plain message.
				if (hasVisibleStickersOrGraphics(editor.scenes.getActiveScene().tracks)) {
					failExport(error);
					return;
				}
				console.warn("overlay prerender failed — native text path:", error);
			}
			// No frame at all (no 2D canvas in this web view) with a sticker on
			// the timeline: the same rule.
			if (
				overlayFrames.length === 0 &&
				hasVisibleStickersOrGraphics(editor.scenes.getActiveScene().tracks)
			) {
				failExport("the stickers could not be drawn for the export");
				return;
			}
			const generator = bridge.exportProject({ edl, overlayFrames });
			activeExportRef.current = generator;
			for await (const event of generator) {
				setProgress({ stage: event.stage, fraction: event.fraction });
				if (event.stage === "error") {
					failExport(event.error ?? "the exporter sent no error text");
					break;
				}
				if (event.stage === "done") {
					setRunState("done");
					void saveExportToPhotos({ bridge, uri: event.outputUri, run });
					break;
				}
			}
		} catch (error) {
			// Includes the honest `NativeBridgeError({code:"UNSUPPORTED",...})`
			// the web-fallback bridge throws the moment this generator is first
			// iterated (no native shell present) — same typed-error contract
			// every other `getNativeBridge()` caller in this package relies on
			// (see captions-actions.ts), surfaced here as the plain sheet
			// message rather than an uncaught rejection.
			failExport(error);
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
				<button
					type="button"
					className="cc-export-sheet__action cc-export-sheet__action--primary"
					onClick={() => void startExport()}
					disabled={runState === "exporting"}
				>
					Export video
				</button>
				{runState === "error" && <p className="cc-panel-note">Export failed. Try again.</p>}
				{runState === "done" && (
					<div
						className="cc-export-result"
						role="status"
						aria-live="polite"
						data-kneecap-export-result={photosSave}
					>
						{photosSave === "saving" && <p className="cc-export-result__title">Saving to Photos…</p>}
						{photosSave === "saved" && <p className="cc-export-result__title">Saved to Photos</p>}
						{(photosSave === "denied" || photosSave === "failed") && (
							<p className="cc-export-result__title">Could not save to Photos.</p>
						)}
						{photosSave === "denied" && (
							<p className="cc-export-result__detail">Photos access is off for publik kneecap, and you can turn it on in Settings.</p>
						)}
						{photosSave === "failed" && canShare && (
							<p className="cc-export-result__detail">You can still share the video.</p>
						)}
						{photosSave !== "saving" && (
							<div className="cc-export-result__actions">
								{canShare && (
									<button
										type="button"
										className="cc-export-sheet__action cc-export-result__action"
										onClick={handleShare}
									>
										Share
									</button>
								)}
							</div>
						)}
						{actionNote && <p className="cc-export-result__detail">{actionNote}</p>}
					</div>
				)}
			</PanelSheet>
			{runState === "exporting" && progress && (
				<ProgressOverlay
					percent={progress.fraction * 100}
					label={`Exporting — ${EXPORT_STAGE_WORDS[progress.stage]}`}
					onCancel={cancelExport}
				/>
			)}
		</>
	);
}
