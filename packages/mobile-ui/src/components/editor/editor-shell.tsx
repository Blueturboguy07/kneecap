import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { isVisualElement, type VisualElement } from "@kneecap/editor-core/timeline";
import { TopBar } from "./top-bar";
import { PlaybackBar } from "./playback-bar";
import { PreviewStage } from "./preview-stage";
import { PreviewRenderer } from "./preview-renderer";
import { BottomToolbar } from "../bottom-toolbar";
import { SubToolbar, type ToolbarItemDef } from "../sub-toolbar";
import { PRIMARY_TOOLBAR_ITEMS, type PrimaryToolId } from "./toolbar-defs";
import { TimelineView } from "../timeline/timeline-view";
import { EditPanel } from "../panels/edit-panel";
import { AudioPanel } from "../panels/audio-panel";
import { TextPanel } from "../panels/text-panel";
import { StickersPanel } from "../panels/stickers-panel";
import { OverlayPanel } from "../panels/overlay-panel";
import { EffectsPanel } from "../panels/effects-panel";
import { FiltersPanel } from "../panels/filters-panel";
import { AdjustPanel } from "../panels/adjust-panel";
import { CaptionsPanel } from "../panels/captions-panel";
import { ExportSheet } from "../panels/export-sheet";
import {
	useLiveEditor,
	useSelectedElement,
	useCurrentTimeSeconds,
	useIsPlaying,
	useProjectDurationSeconds,
} from "../../editor/use-live-editor";
import { bootstrapDemoProject } from "../../editor/demo-project";
import { useTimelineProjectVM } from "../../editor/use-timeline-project-vm";
import {
	splitAtPlayhead,
	deleteSelected,
	duplicateSelected,
	setRetime,
	setElementParam,
	toggleReversed,
	selectElement,
	insertTextElement,
	insertOverlayShape,
	togglePlayback,
	seekToSeconds,
	importAndPlaceMedia,
	setProjectResolution,
	setProjectBackground,
} from "../../editor/actions";
import { Scissors, VolumeX, WandSparkles, ImagePlus } from "lucide-react";
import { CC_ICON_STROKE } from "../../tokens";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { ProgressOverlay } from "../progress-overlay";

type SheetId = PrimaryToolId | "export";

interface EditorShellProps {
	className?: string;
	/** Back (top-left arrow) tap handler — `TopBar` has always rendered that
	 *  arrow, but nothing here ever wired it to anything (dead button; the
	 *  M8 dev harness page never needed a "back" destination). Optional and
	 *  undefined by default so the dev harness's existing bare `<EditorShell
	 *  />` keeps behaving exactly as before. The real app (apps/mobile)
	 *  passes its own "back to project list" callback. */
	onBack?: () => void;
	/** Runs once on mount, before the shell renders live editor chrome —
	 *  defaults to the M8 dev-harness demo project (`bootstrapDemoProject`,
	 *  text/sticker/graphic/library-audio elements pre-inserted) so every
	 *  existing caller of bare `<EditorShell />` (the `/dev/mobile-editor`
	 *  page) keeps working unchanged. The real app already creates or loads
	 *  a REAL project via `ProjectManager` (`editor.project.createNewProject`
	 *  / `.loadProject`) before ever mounting this component, so it passes a
	 *  no-op here instead — bootstrapping the demo project on top of an
	 *  already-active real one would be wrong, not just redundant. */
	bootstrap?: () => Promise<unknown>;
}

const CONTEXTUAL_ITEMS: ToolbarItemDef[] = [{ id: "edit", label: "Edit", icon: Scissors }];

const VISUAL_ONLY_SHEETS = new Set<SheetId>(["effects", "filters", "adjust"]);

function formatTimecode(seconds: number): string {
	const clamped = Math.max(0, seconds);
	const mm = Math.floor(clamped / 60);
	const ss = Math.floor(clamped % 60);
	return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** CapCut's top-bar pill reads "AI UHD" when AI-upscaled export is armed;
 *  kneecap has no upscaler, so the pill honestly shows the project's real
 *  export resolution class and opens the export sheet where it's changed. */
function resolutionLabelFor({ width, height }: { width: number; height: number }): string {
	const shortEdge = Math.min(width, height);
	if (shortEdge >= 2160) return "4K";
	if (shortEdge >= 1440) return "2K";
	if (shortEdge >= 1080) return "1080p";
	if (shortEdge >= 720) return "720p";
	return `${shortEdge}p`;
}

const RATIO_PRESETS: { label: string; width: number; height: number }[] = [
	{ label: "9:16", width: 1080, height: 1920 },
	{ label: "16:9", width: 1920, height: 1080 },
	{ label: "1:1", width: 1080, height: 1080 },
	{ label: "4:5", width: 1080, height: 1350 },
	{ label: "3:4", width: 1080, height: 1440 },
];

const BACKGROUND_PRESETS = ["#000000", "#FFFFFF", "#101010", "#1E3A5F", "#4A1942", "#0F3D2E", "#5C1A1A"];

/**
 * M8 editor chrome — composes the top bar, preview placeholder, playback
 * controls, M7's timeline surface, primary + contextual toolbars, and every
 * v1 panel/export sheet into one mountable component. This is what the M8
 * dev harness page renders; it is also the shape a real mobile screen route
 * would compose (same components, same wiring), not harness-only
 * scaffolding.
 *
 * Fixer pass: `TimelineView` (M7) is now mounted here, fed by
 * `useTimelineProjectVM()` — a live mapping of the real `EditorCore` scene
 * graph, not `mock-data.ts`'s synthetic stress project. This is the first
 * place in the repo where a real project's timeline, panels/export chrome,
 * and preview all compose together. Scrubbing the real timeline calls
 * `editor.playback.seek()` through `seekToSeconds`. Trim/reorder gestures
 * inside `TimelineView` still do not write back to editor-core commands —
 * that gap was already disclosed in timeline-view.tsx's own
 * `handleTrimCommit` comment and is unrelated to the mounting gap this pass
 * closes; it needs its own follow-up wiring pass.
 *
 * Structural-gap fixer pass (kneecap "close the mobile shipping gap"): this
 * is now ALSO what `apps/mobile` mounts as the real app's editor screen, not
 * only the dev harness — see `bootstrap`/`onBack` above for the two knobs
 * that made that possible without forking the component.
 */
export function EditorShell({ className, onBack, bootstrap }: EditorShellProps) {
	const editor = useLiveEditor();
	const [ready, setReady] = useState(false);
	const [activeSheet, setActiveSheet] = useState<SheetId | null>(null);
	/** Transient error strip for chrome-level actions that have no panel of
	 *  their own to show failure in (the timeline's "+" import button —
	 *  panels like Export/Captions render their own error states). A failed
	 *  bridge call must degrade to a message, never an unhandled rejection:
	 *  on the founder's iPhone a dead pickMedia call surfaced as a
	 *  whole-app death screen (2026-08-18). */
	const [chromeError, setChromeError] = useState<string | null>(null);
	/** Non-null while the "+" import flow is in flight — from the tap that
	 *  opens the picker until every picked asset's native proxy transcode
	 *  lands (or the picker is cancelled). Drives the same ProgressOverlay
	 *  the export sheet uses; without it the seconds of native transcode
	 *  after picking looked like a dead button (founder's device,
	 *  2026-08-19). */
	const [importProgress, setImportProgress] = useState<{
		percent: number;
		label: string;
	} | null>(null);
	const timelineProject = useTimelineProjectVM();

	const reportChromeError = (error: unknown) => {
		setChromeError(error instanceof Error ? error.message : String(error));
	};

	useEffect(() => {
		(bootstrap ?? bootstrapDemoProject)().then(() => setReady(true));
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `bootstrap`/`bootstrapDemoProject` are meant to run exactly once per mount (the demo bootstrap is itself idempotent via its own module-level cache — see demo-project.ts — and re-running a real caller's bootstrap on every render would be wrong, not just wasteful); depending on `bootstrap` would re-run this whenever a caller passes a fresh closure identity, which apps/mobile's own memoized `NOOP_BOOTSTRAP` avoids but nothing enforces.
	}, []);

	const [selectedRef, selectedElement] = useSelectedElement();
	const currentTimeSeconds = useCurrentTimeSeconds();
	const durationSeconds = useProjectDurationSeconds();
	const isPlaying = useIsPlaying();

	if (!ready) {
		return (
			<div className={cn("cc-editor-shell", className)} data-kneecap-theme="capcut-mobile">
				<p className="cc-panel-note">Loading demo project…</p>
			</div>
		);
	}

	const project = editor.project.getActive();
	const background = project.settings.background;
	const backgroundColor = background.type === "color" ? background.color : "#000000";
	const visualElement: VisualElement | null =
		selectedElement && isVisualElement(selectedElement) ? selectedElement : null;

	const closeSheet = () => setActiveSheet(null);

	return (
		<div className={cn("cc-editor-shell", className)} data-kneecap-theme="capcut-mobile">
			<TopBar
				onClose={onBack}
				resolutionLabel={resolutionLabelFor(project.settings.canvasSize)}
				onOpenExportSettings={() => setActiveSheet("export")}
				onExport={() => setActiveSheet("export")}
			/>
			<PreviewStage
				canvasWidth={project.settings.canvasSize.width}
				canvasHeight={project.settings.canvasSize.height}
				backgroundColor={backgroundColor}
			>
				{/* Real frame rendering (CanvasRenderer -> wgpu compositor) —
				    replaces the chrome-only text-span placeholder; the renderer
				    draws text/sticker/overlay/video elements with their actual
				    params (opacity/blendMode included), so the span's partial
				    re-implementation of that is gone with it. */}
				<PreviewRenderer />
			</PreviewStage>
			<PlaybackBar
				isPlaying={isPlaying}
				onPlayPause={() => togglePlayback({ editor })}
				onUndo={() => editor.command.undo()}
				onRedo={() => editor.command.redo()}
				canUndo={editor.command.canUndo()}
				canRedo={editor.command.canRedo()}
			/>

			{timelineProject && (
				<div className="cc-editor-shell__timeline">
					<TimelineView
						project={timelineProject}
						onTimeChange={({ timeSec }) => seekToSeconds({ editor, seconds: timeSec })}
						onSelectClip={({ clipId, trackId }) =>
							selectElement({ editor, ref: { trackId, elementId: clipId } })
						}
						currentTimeLabel={`${formatTimecode(currentTimeSeconds)} / ${formatTimecode(durationSeconds)}`}
						playbackTimeSec={currentTimeSeconds}
						isPlaying={isPlaying}
						onAddClip={() => {
							if (importProgress) return; // one import at a time
							setChromeError(null);
							// Indeterminate 0% while the OS picker is up; the picker
							// sheet covers it, and a cancelled pick clears it in
							// `finally` (pickMedia resolves to an empty handle list).
							setImportProgress({ percent: 0, label: "Choosing media…" });
							importAndPlaceMedia({
								editor,
								onProgress: (p) => {
									const overall =
										((p.index + Math.min(1, Math.max(0, p.fraction))) /
											Math.max(1, p.total)) *
										100;
									// "picking" = post-pick load/copy, which for
									// iCloud-stored originals is a real download —
									// name it, or minutes of it read as a hang.
									const label =
										p.stage === "picking"
											? `Preparing media ${p.index + 1} of ${p.total}…`
											: p.total > 1
												? `Importing ${p.index + 1} of ${p.total}…`
												: `Importing ${p.fileName}…`;
									setImportProgress({
										percent: Math.round(overall),
										label,
									});
								},
							})
								.catch(reportChromeError)
								.finally(() => setImportProgress(null));
						}}
						showAddAudio={!timelineProject.tracks.some((t) => t.kind === "audio")}
						onAddAudio={() => setActiveSheet("audio")}
						onQuickAddAudio={() => setActiveSheet("audio")}
						onQuickAddText={() => setActiveSheet("text")}
						leadingChips={
							<>
								{/* CapCut's main-track helper chips (capture 2026-08-18).
								    Mute-clip-audio and AI-clipper/Cover need per-clip audio
								    state and features outside v1 — parity chrome, tracked in
								    docs/STATUS.md, inert rather than fake-wired. */}
								<span className="cc-timeline__helper-chip" aria-hidden="true">
									<VolumeX size={18} strokeWidth={CC_ICON_STROKE} />
									<span>
										Mute clip
										<br />
										audio
									</span>
								</span>
								<span className="cc-timeline__helper-chip cc-timeline__helper-chip--card" aria-hidden="true">
									<span className="cc-timeline__helper-badge">New</span>
									<WandSparkles size={18} strokeWidth={CC_ICON_STROKE} />
									<span>AI clipper</span>
								</span>
								<span className="cc-timeline__helper-chip cc-timeline__helper-chip--card" aria-hidden="true">
									<ImagePlus size={18} strokeWidth={CC_ICON_STROKE} />
									<span>Cover</span>
								</span>
							</>
						}
					/>
				</div>
			)}

			{chromeError && (
				<button type="button" className="cc-chrome-error" onClick={() => setChromeError(null)}>
					{chromeError}
				</button>
			)}

			{importProgress && (
				<ProgressOverlay percent={importProgress.percent} label={importProgress.label} />
			)}

			{selectedRef && selectedElement && (
				<SubToolbar items={CONTEXTUAL_ITEMS} activeId={activeSheet} onSelect={(id) => setActiveSheet(id as SheetId)} />
			)}

			<BottomToolbar items={PRIMARY_TOOLBAR_ITEMS} activeId={activeSheet} onSelect={(id) => setActiveSheet(id as SheetId)} />

			{activeSheet === "edit" && selectedRef && selectedElement && (
				<EditPanel
					elementRef={selectedRef}
					element={selectedElement}
					onClose={closeSheet}
					onSplit={() => splitAtPlayhead({ editor, ref: selectedRef })}
					onDelete={() => {
						deleteSelected({ editor, refs: [selectedRef] });
						closeSheet();
					}}
					onDuplicate={() => duplicateSelected({ editor, refs: [selectedRef] })}
					onSetSpeed={({ rate, maintainPitch }) => setRetime({ editor, ref: selectedRef, rate, maintainPitch })}
					onSetVolume={(db) => setElementParam({ editor, ref: selectedRef, key: "volume", value: db })}
					onToggleReverse={() => toggleReversed({ editor, ref: selectedRef })}
				/>
			)}

			{activeSheet === "audio" && (
				<AudioPanel editor={editor} onClose={closeSheet} onInserted={(ref) => selectElement({ editor, ref })} />
			)}

			{activeSheet === "text" && (
				<TextPanel
					editor={editor}
					elementRef={selectedElement?.type === "text" ? selectedRef : null}
					element={selectedElement?.type === "text" ? selectedElement : null}
					onClose={closeSheet}
					onAddText={() => {
						const ref = insertTextElement({ editor, content: "New text" });
						if (ref) selectElement({ editor, ref });
					}}
				/>
			)}

			{activeSheet === "stickers" && (
				<StickersPanel editor={editor} onClose={closeSheet} onInserted={(ref) => selectElement({ editor, ref })} />
			)}

			{activeSheet === "overlay" && (
				<OverlayPanel
					editor={editor}
					elementRef={selectedRef}
					element={visualElement}
					onClose={closeSheet}
					onAddOverlay={() => {
						const ref = insertOverlayShape({ editor });
						if (ref) selectElement({ editor, ref });
					}}
				/>
			)}

			{activeSheet === "effects" && selectedRef && visualElement && (
				<EffectsPanel editor={editor} elementRef={selectedRef} element={visualElement} onClose={closeSheet} />
			)}

			{activeSheet === "filters" && selectedRef && visualElement && (
				<FiltersPanel editor={editor} elementRef={selectedRef} element={visualElement} onClose={closeSheet} />
			)}

			{activeSheet === "adjust" && selectedRef && visualElement && (
				<AdjustPanel editor={editor} elementRef={selectedRef} element={visualElement} onClose={closeSheet} />
			)}

			{activeSheet && VISUAL_ONLY_SHEETS.has(activeSheet) && !visualElement && (
				<PanelSelectPrompt onClose={closeSheet} />
			)}

			{/* Fixer pass: the Edit sheet had no fallback when opened with
			    nothing selected — unlike VISUAL_ONLY_SHEETS above, it rendered
			    a totally empty sheet body (reproduced live: opening Edit with
			    no selection showed no content and no prompt). The bottom
			    toolbar's Edit item is reachable at any time regardless of
			    selection (it isn't gated the way the contextual SubToolbar's
			    own "Edit" chip is, which only renders when something is
			    selected), so this state IS reachable in the real UI, not just
			    hypothetically. */}
			{activeSheet === "edit" && !(selectedRef && selectedElement) && (
				<PanelSelectPrompt onClose={closeSheet} message="Select an element on the timeline first." />
			)}

			{activeSheet === "captions" && (
				<CaptionsPanel editor={editor} onClose={closeSheet} onInserted={(ref) => selectElement({ editor, ref })} />
			)}

			{activeSheet === "ratio" && (
				<PanelSheet onScrimClick={closeSheet} header={<SheetHeader onClose={closeSheet} />}>
					<p className="cc-sheet-title">Aspect ratio</p>
					<div className="cc-ratio-grid">
						{RATIO_PRESETS.map((preset) => {
							const active =
								project.settings.canvasSize.width === preset.width &&
								project.settings.canvasSize.height === preset.height;
							return (
								<button
									key={preset.label}
									type="button"
									className={cn("cc-ratio-grid__item", active && "cc-ratio-grid__item--active")}
									onClick={() => setProjectResolution({ editor, canvasSize: { width: preset.width, height: preset.height } })}
								>
									<span
										className="cc-ratio-grid__shape"
										style={{ aspectRatio: `${preset.width} / ${preset.height}` }}
									/>
									{preset.label}
								</button>
							);
						})}
					</div>
				</PanelSheet>
			)}

			{activeSheet === "background" && (
				<PanelSheet onScrimClick={closeSheet} header={<SheetHeader onClose={closeSheet} />}>
					<p className="cc-sheet-title">Background</p>
					<div className="cc-ratio-grid">
						{BACKGROUND_PRESETS.map((color) => (
							<button
								key={color}
								type="button"
								className={cn(
									"cc-swatch",
									backgroundColor.toLowerCase() === color.toLowerCase() && "cc-swatch--active",
								)}
								style={{ background: color }}
								onClick={() => setProjectBackground({ editor, color })}
								aria-label={`Background ${color}`}
							/>
						))}
					</div>
				</PanelSheet>
			)}

			{(activeSheet === "transcript" || activeSheet === "template") && (
				<PanelSheet onScrimClick={closeSheet} header={<SheetHeader onClose={closeSheet} />}>
					<p className="cc-sheet-title">{activeSheet === "transcript" ? "Transcript" : "Template"}</p>
					<p className="cc-panel-note">
						{activeSheet === "transcript"
							? "Transcript editing isn't in kneecap yet — use Captions for on-device auto-captions."
							: "Templates aren't in kneecap yet."}
					</p>
				</PanelSheet>
			)}

			{activeSheet === "export" && <ExportSheet editor={editor} onClose={closeSheet} />}
		</div>
	);
}

function PanelSelectPrompt({ onClose, message }: { onClose: () => void; message?: string }) {
	return (
		<div className="cc-sheet-scrim" onClick={onClose} aria-hidden="true">
			<p className="cc-panel-note">{message ?? "Select a text, sticker, or overlay element first."}</p>
		</div>
	);
}
