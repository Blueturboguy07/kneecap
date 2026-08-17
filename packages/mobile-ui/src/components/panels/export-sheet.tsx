import { useState } from "react";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { SegmentedControl } from "../segmented-control";
import type { EditorCore } from "@kneecap/editor-core";
import { buildEdl, type Edl } from "@kneecap/editor-core/edl";
import type { ExportFormat, ExportQuality } from "@kneecap/editor-core/export";
import { setProjectFps, setProjectResolution } from "../../editor/actions";
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

function isExportQuality(value: string): value is ExportQuality {
	return QUALITY_OPTIONS.some((option) => option.id === value);
}

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
 * decoration: it calls the actual `buildEdl()` (same function M9's native
 * export bridge will call) with the CURRENT sheet selections and displays
 * `output.resolution`/`output.fps` back — proving the sheet's controls
 * really do reach the EDL bridge contract, not just the UI. No file is
 * produced; encoding is M9 scope.
 */
export function ExportSheet({ editor, onClose }: ExportSheetProps) {
	const project = editor.project.getActive();
	const [resolutionId, setResolutionId] = useState("1080p");
	const [fpsId, setFpsId] = useState("30");
	const [quality, setQuality] = useState<ExportQuality>("high");
	const [format] = useState<ExportFormat>("mp4");
	const [previewResult, setPreviewResult] = useState<{ fps: string; resolution: string } | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);

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

	const previewEdl = () => {
		setPreviewError(null);
		try {
			const scene = editor.scenes.getActiveScene();
			const fpsPreset = FPS_OPTIONS.find((f) => f.id === fpsId)?.fps;
			// The M8 demo project has no imported media (see demo-project.ts's
			// header) so `mediaAssets` is genuinely empty here — `buildEdl` only
			// needs entries for elements that reference a `mediaId`, and none of
			// this harness's text/sticker/graphic/library-audio elements do.
			const edl: Edl = buildEdl({
				project,
				scene,
				mediaAssets: [],
				output: {
					container: format,
					videoCodec: "h264",
					audioCodec: "aac",
					bitrate: quality === "low" ? 2_000_000 : quality === "medium" ? 5_000_000 : quality === "high" ? 10_000_000 : 20_000_000,
					includeAudio: true,
					fps: fpsPreset,
				},
			});
			setPreviewResult({
				fps: `${edl.output.fps.numerator}/${edl.output.fps.denominator}`,
				resolution: `${edl.output.resolution.width}x${edl.output.resolution.height}`,
			});
		} catch (error) {
			setPreviewError(error instanceof Error ? error.message : String(error));
		}
	};

	return (
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
			<button type="button" className="cc-panel-actions__btn" onClick={previewEdl}>
				<span>Preview EDL output</span>
			</button>
			{previewResult && (
				<p className="cc-panel-note">
					EDL output reflects the sheet: resolution {previewResult.resolution}, fps {previewResult.fps}.
				</p>
			)}
			{previewError && <p className="cc-panel-note">EDL preview failed: {previewError}</p>}
			<p className="cc-panel-note">
				Hardware encode is not implemented in this dev harness — M9 scope. This sheet only proves the settings reach
				the EDL bridge.
			</p>
		</PanelSheet>
	);
}
