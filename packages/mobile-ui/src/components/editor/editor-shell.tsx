import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { isVisualElement, type VisualElement } from "@kneecap/editor-core/timeline";
import { TopBar } from "./top-bar";
import { PlaybackBar } from "./playback-bar";
import { PreviewStage } from "./preview-stage";
import { BottomToolbar } from "../bottom-toolbar";
import { SubToolbar, type ToolbarItemDef } from "../sub-toolbar";
import { PRIMARY_TOOLBAR_ITEMS, type PrimaryToolId } from "./toolbar-defs";
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
	seekToStart,
	seekToEnd,
} from "../../editor/actions";
import { Scissors } from "lucide-react";

type SheetId = PrimaryToolId | "export";

interface EditorShellProps {
	className?: string;
}

const CONTEXTUAL_ITEMS: ToolbarItemDef[] = [{ id: "edit", label: "Edit", icon: Scissors }];

const VISUAL_ONLY_SHEETS = new Set<SheetId>(["effects", "filters", "adjust"]);

/**
 * M8 editor chrome — composes the top bar, preview placeholder, playback
 * controls, primary + contextual toolbars, and every v1 panel/export sheet
 * into one mountable component. This is what the M8 dev harness page
 * renders; it is also the shape a real mobile screen route would compose
 * (same components, same wiring), not harness-only scaffolding.
 */
export function EditorShell({ className }: EditorShellProps) {
	const editor = useLiveEditor();
	const [ready, setReady] = useState(false);
	const [activeSheet, setActiveSheet] = useState<SheetId | null>(null);

	useEffect(() => {
		bootstrapDemoProject().then(() => setReady(true));
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
				title={project.metadata.name}
				onUndo={() => editor.command.undo()}
				onRedo={() => editor.command.redo()}
				canUndo={editor.command.canUndo()}
				canRedo={editor.command.canRedo()}
				onExport={() => setActiveSheet("export")}
			/>
			<PreviewStage
				canvasWidth={project.settings.canvasSize.width}
				canvasHeight={project.settings.canvasSize.height}
				backgroundColor={backgroundColor}
			>
				{selectedElement?.type === "text" && (
					<span
						style={{
							color: typeof selectedElement.params.color === "string" ? selectedElement.params.color : "#fff",
							fontSize: 20,
							fontWeight: selectedElement.params.fontWeight === "bold" ? 700 : 400,
							fontStyle: selectedElement.params.fontStyle === "italic" ? "italic" : "normal",
						}}
					>
						{typeof selectedElement.params.content === "string" ? selectedElement.params.content : ""}
					</span>
				)}
			</PreviewStage>
			<PlaybackBar
				isPlaying={isPlaying}
				currentTimeSeconds={currentTimeSeconds}
				durationSeconds={durationSeconds}
				onPlayPause={() => togglePlayback({ editor })}
				onSkipToStart={() => seekToStart({ editor })}
				onSkipToEnd={() => seekToEnd({ editor })}
			/>

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

			{activeSheet === "captions" && <CaptionsPanel onClose={closeSheet} />}

			{activeSheet === "export" && <ExportSheet editor={editor} onClose={closeSheet} />}
		</div>
	);
}

function PanelSelectPrompt({ onClose }: { onClose: () => void }) {
	return (
		<div className="cc-sheet-scrim" onClick={onClose} aria-hidden="true">
			<p className="cc-panel-note">Select a text, sticker, or overlay element first.</p>
		</div>
	);
}
