import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { CC_ICON_STROKE } from "../../tokens";
import { cn } from "../../lib/cn";

interface PlaybackBarProps {
	isPlaying: boolean;
	currentTimeSeconds: number;
	durationSeconds: number;
	onPlayPause: () => void;
	onSkipToStart: () => void;
	onSkipToEnd: () => void;
	className?: string;
}

function formatTimecode({ seconds }: { seconds: number }): string {
	const clamped = Math.max(0, seconds);
	const mm = Math.floor(clamped / 60);
	const ss = Math.floor(clamped % 60);
	return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/**
 * Plan M8 item 1 editor chrome: "playback controls." Corpus 04 §2:
 * "⏮ ⏸/▶ ⏭   00:00 / 00:32" — desktop-screenshotted icon row
 * (SCREENSHOT-Desktop shot_2/3.png), mobile-specific pixel spacing itself
 * [NEEDS-CAPTURE] per 04 §2's own note, so this reuses the measured
 * tabular-figure timecode token (`--cc-tabular-nums`) and standard Lucide
 * transport icons rather than inventing unmeasured spacing.
 */
export function PlaybackBar({
	isPlaying,
	currentTimeSeconds,
	durationSeconds,
	onPlayPause,
	onSkipToStart,
	onSkipToEnd,
	className,
}: PlaybackBarProps) {
	return (
		<div className={cn("cc-playbackbar", className)}>
			<button type="button" className="cc-topbar__icon-btn" onClick={onSkipToStart} aria-label="Skip to start">
				<SkipBack size={18} strokeWidth={CC_ICON_STROKE} />
			</button>
			<button
				type="button"
				className="cc-topbar__icon-btn"
				onClick={onPlayPause}
				aria-label={isPlaying ? "Pause" : "Play"}
			>
				{isPlaying ? <Pause size={20} strokeWidth={CC_ICON_STROKE} /> : <Play size={20} strokeWidth={CC_ICON_STROKE} />}
			</button>
			<button type="button" className="cc-topbar__icon-btn" onClick={onSkipToEnd} aria-label="Skip to end">
				<SkipForward size={18} strokeWidth={CC_ICON_STROKE} />
			</button>
			<span className="cc-playbackbar__time">
				{formatTimecode({ seconds: currentTimeSeconds })} / {formatTimecode({ seconds: durationSeconds })}
			</span>
		</div>
	);
}
