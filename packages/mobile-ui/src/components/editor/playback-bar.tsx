import { Maximize2, Minimize2, Pause, Play, Redo2, Undo2 } from "lucide-react";
import { CC_ICON_STROKE } from "../../tokens";
import { cn } from "../../lib/cn";

interface PlaybackBarProps {
	isPlaying: boolean;
	onPlayPause: () => void;
	onUndo?: () => void;
	onRedo?: () => void;
	canUndo?: boolean;
	canRedo?: boolean;
	/** True while the preview is expanded to fill the editor. */
	isPreviewFullscreen?: boolean;
	onToggleFullscreen?: () => void;
	className?: string;
}

/**
 * Playback row, measured from a reference capture (not kept in the
 * repo): fullscreen
 * expand on the left, the play/pause triangle centered, and on the right
 * undo/redo.
 * The timecode readout ("00:00 / 00:34") is NOT here — the reference editor renders it
 * pinned top-left of the timeline area (see TimelineView's timecode
 * overlay), which is where this kit moved it in the same pass.
 *
 * Fullscreen is REAL as of 2026-08-27 (founder: "fullscreen button doesnt
 * actually fullscreen the preview lol"). It was `<span aria-hidden>` parity
 * chrome — deliberately inert rather than fake-wired, which is the right
 * call for an unimplemented control but reads as a broken button once
 * someone taps it.
 *
 * The compare-with-original icon is gone (App Store rule 2.1, completeness):
 * it did nothing.
 */
export function PlaybackBar({
	isPlaying,
	onPlayPause,
	onUndo,
	onRedo,
	canUndo,
	canRedo,
	isPreviewFullscreen = false,
	onToggleFullscreen,
	className,
}: PlaybackBarProps) {
	return (
		<div className={cn("cc-playbackbar", className)}>
			<button
				type="button"
				className="cc-topbar__icon-btn"
				onClick={onToggleFullscreen}
				aria-pressed={isPreviewFullscreen}
				aria-label={isPreviewFullscreen ? "Exit fullscreen preview" : "Fullscreen preview"}
			>
				{isPreviewFullscreen ? (
					<Minimize2 size={19} strokeWidth={CC_ICON_STROKE} />
				) : (
					<Maximize2 size={19} strokeWidth={CC_ICON_STROKE} />
				)}
			</button>
			<button
				type="button"
				className="cc-playbackbar__play"
				onClick={onPlayPause}
				aria-label={isPlaying ? "Pause" : "Play"}
			>
				{isPlaying ? (
					<Pause size={26} strokeWidth={CC_ICON_STROKE} />
				) : (
					<Play size={26} strokeWidth={CC_ICON_STROKE} />
				)}
			</button>
			<div className="cc-playbackbar__right">
				<button
					type="button"
					className="cc-topbar__icon-btn"
					onClick={onUndo}
					disabled={!canUndo}
					aria-label="Undo"
				>
					<Undo2 size={20} strokeWidth={CC_ICON_STROKE} />
				</button>
				<button
					type="button"
					className="cc-topbar__icon-btn"
					onClick={onRedo}
					disabled={!canRedo}
					aria-label="Redo"
				>
					<Redo2 size={20} strokeWidth={CC_ICON_STROKE} />
				</button>
			</div>
		</div>
	);
}
