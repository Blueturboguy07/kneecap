import { Copy, Maximize2, Pause, Play, Redo2, Undo2 } from "lucide-react";
import { CC_ICON_STROKE } from "../../tokens";
import { cn } from "../../lib/cn";

interface PlaybackBarProps {
	isPlaying: boolean;
	onPlayPause: () => void;
	onUndo?: () => void;
	onRedo?: () => void;
	canUndo?: boolean;
	canRedo?: boolean;
	className?: string;
}

/**
 * CapCut-parity playback row, MEASURED from the founder capture
 * (docs/capcut-reference/capture-editor-toolbar-start.png): fullscreen
 * expand on the left, the play/pause triangle centered, and on the right
 * the compare-with-original toggle (icon + tiny "OFF" tag) then undo/redo.
 * The timecode readout ("00:00 / 00:34") is NOT here — CapCut renders it
 * pinned top-left of the timeline area (see TimelineView's timecode
 * overlay), which is where this kit moved it in the same pass.
 *
 * Fullscreen and compare are parity chrome: the real bar has them, but
 * fullscreen-preview and view-original need features outside v1 scope —
 * tracked in docs/STATUS.md, deliberately inert rather than fake-wired.
 */
export function PlaybackBar({
	isPlaying,
	onPlayPause,
	onUndo,
	onRedo,
	canUndo,
	canRedo,
	className,
}: PlaybackBarProps) {
	return (
		<div className={cn("cc-playbackbar", className)}>
			<span className="cc-topbar__icon-btn cc-topbar__icon-btn--chrome" aria-hidden="true">
				<Maximize2 size={19} strokeWidth={CC_ICON_STROKE} />
			</span>
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
				<span className="cc-topbar__icon-btn cc-topbar__icon-btn--chrome cc-playbackbar__compare" aria-hidden="true">
					<Copy size={18} strokeWidth={CC_ICON_STROKE} />
					<span className="cc-playbackbar__compare-tag">OFF</span>
				</span>
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
