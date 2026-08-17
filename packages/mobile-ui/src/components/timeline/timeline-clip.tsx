import { useCallback, useRef, useState } from "react";
import type { TimelineClipVM } from "../../timeline/types";
import { pixelsToTime, timeToPixels } from "../../timeline/time-scale";
import {
	thumbnailSlotIntervalSec,
	visibleThumbnailSlots,
} from "../../timeline/virtualization";
import { resolveSnap, type SnapTarget } from "../../timeline/snapping";
import { hapticTick } from "../../timeline/haptics";
import { FilmstripThumbnail } from "./filmstrip-thumbnail";
import { AudioWaveformMini } from "./audio-waveform-mini";

export const MIN_CLIP_DURATION_SEC = 0.2;
const TARGET_THUMB_WIDTH_PX = 44;
const TRACK_HEIGHT_PX = 48; // matches --cc-track-height; kept in sync by src/__tests__ (visual, not enforced by types)

export type TrimEdge = "start" | "end";

interface TimelineClipProps {
	clip: TimelineClipVM;
	effectiveStartSec: number;
	effectiveDurationSec: number;
	pixelsPerSecond: number;
	viewStartSec: number;
	viewEndSec: number;
	isSelected: boolean;
	onSelect: (params: { clipId: string }) => void;
	onTrimPreview: (params: { clipId: string; edge: TrimEdge; boundarySec: number }) => void;
	onTrimCommit: (params: { clipId: string; edge: TrimEdge; boundarySec: number }) => void;
	minStartBoundSec: number;
	maxEndBoundSec: number;
	snapTargets: readonly SnapTarget[];
	snapThresholdSec: number;
	onKeyframeTap?: (params: { clipId: string; keyframeId: string }) => void;
}

export function TimelineClip({
	clip,
	effectiveStartSec,
	effectiveDurationSec,
	pixelsPerSecond,
	viewStartSec,
	viewEndSec,
	isSelected,
	onSelect,
	onTrimPreview,
	onTrimCommit,
	minStartBoundSec,
	maxEndBoundSec,
	snapTargets,
	snapThresholdSec,
	onKeyframeTap,
}: TimelineClipProps) {
	const [trimEdge, setTrimEdge] = useState<TrimEdge | null>(null);
	const dragRef = useRef<{
		edge: TrimEdge;
		pointerId: number;
		startClientX: number;
		originalBoundarySec: number;
		wasSnapped: boolean;
	} | null>(null);

	const leftPx = timeToPixels({ timeSec: effectiveStartSec, pixelsPerSecond });
	const widthPx = Math.max(
		1,
		timeToPixels({ timeSec: effectiveDurationSec, pixelsPerSecond }),
	);

	const handleClipPointerDown = useCallback(
		(event: React.PointerEvent) => {
			event.stopPropagation();
			onSelect({ clipId: clip.id });
		},
		[clip.id, onSelect],
	);

	const beginTrim = useCallback(
		(edge: TrimEdge) => (event: React.PointerEvent) => {
			event.stopPropagation();
			// Capture is best-effort: it keeps pointermove events routed to this
			// handle even once the finger/cursor drags outside its (deliberately
			// small) hit area. It must NOT gate the rest of this handler —
			// `setPointerCapture` throws `NotFoundError` for a pointerId the
			// browser doesn't consider "active" (observed directly this session
			// testing via both a real Chrome mouse drag and a dispatched
			// PointerEvent — either can hit this depending on how the input was
			// produced); an uncaught throw here used to abort every line below
			// it, silently disabling trim entirely. Confirmed fixed: re-tested
			// the same drag afterward and the clip's start/width updated live.
			try {
				event.currentTarget.setPointerCapture(event.pointerId);
			} catch {
				// Fall through — onPointerMove is still bound to this element and
				// will keep working as long as the pointer stays over it.
			}
			onSelect({ clipId: clip.id });
			setTrimEdge(edge);
			dragRef.current = {
				edge,
				pointerId: event.pointerId,
				startClientX: event.clientX,
				originalBoundarySec:
					edge === "start" ? effectiveStartSec : effectiveStartSec + effectiveDurationSec,
				wasSnapped: false,
			};
		},
		[clip.id, effectiveStartSec, effectiveDurationSec, onSelect],
	);

	const onTrimPointerMove = useCallback(
		(event: React.PointerEvent) => {
			const drag = dragRef.current;
			if (!drag || drag.pointerId !== event.pointerId) return;

			const deltaPx = event.clientX - drag.startClientX;
			const deltaSec = pixelsToTime({ px: deltaPx, pixelsPerSecond });
			const rawCandidate = drag.originalBoundarySec + deltaSec;

			const lowerBound =
				drag.edge === "start" ? minStartBoundSec : effectiveStartSec + MIN_CLIP_DURATION_SEC;
			const upperBound =
				drag.edge === "start"
					? effectiveStartSec + effectiveDurationSec - MIN_CLIP_DURATION_SEC
					: maxEndBoundSec;
			const clamped = Math.min(upperBound, Math.max(lowerBound, rawCandidate));

			const { snappedSec, target } = resolveSnap({
				candidateSec: clamped,
				targets: snapTargets,
				thresholdSec: snapThresholdSec,
			});

			if (target && !drag.wasSnapped) hapticTick();
			drag.wasSnapped = target !== null;

			onTrimPreview({ clipId: clip.id, edge: drag.edge, boundarySec: snappedSec });
		},
		[
			clip.id,
			pixelsPerSecond,
			minStartBoundSec,
			maxEndBoundSec,
			effectiveStartSec,
			effectiveDurationSec,
			snapTargets,
			snapThresholdSec,
			onTrimPreview,
		],
	);

	const onTrimPointerEnd = useCallback(
		(event: React.PointerEvent) => {
			const drag = dragRef.current;
			if (!drag || drag.pointerId !== event.pointerId) return;
			// Re-derive the final boundary from the same math as the last move
			// (the caller already applied the live preview; commit re-fires
			// with the same value it last previewed via onTrimPreview, so we
			// just signal "done" here by echoing effective* which the parent
			// has already updated to the previewed value).
			const boundarySec =
				drag.edge === "start" ? effectiveStartSec : effectiveStartSec + effectiveDurationSec;
			onTrimCommit({ clipId: clip.id, edge: drag.edge, boundarySec });
			dragRef.current = null;
			setTrimEdge(null);
		},
		[clip.id, effectiveStartSec, effectiveDurationSec, onTrimCommit],
	);

	const durationLabel = formatClipDuration({ durationSec: effectiveDurationSec });

	return (
		<div
			className={`cc-timeline__clip${isSelected ? " cc-timeline__clip--selected" : ""}`}
			style={{ left: leftPx, width: widthPx }}
			onPointerDown={handleClipPointerDown}
			role="button"
			tabIndex={0}
			aria-label={`${clip.name}, ${durationLabel}${isSelected ? ", selected" : ""}`}
			aria-pressed={isSelected}
		>
			{(clip.kind === "video" || clip.kind === "image") && (
				<ClipFilmstrip
					clip={clip}
					widthPx={widthPx}
					pixelsPerSecond={pixelsPerSecond}
					viewStartSec={viewStartSec}
					viewEndSec={viewEndSec}
					effectiveStartSec={effectiveStartSec}
					effectiveDurationSec={effectiveDurationSec}
				/>
			)}
			{clip.kind === "audio" && clip.waveformPeaks && (
				<AudioWaveformMini
					peaks={clip.waveformPeaks}
					widthPx={widthPx}
					heightPx={TRACK_HEIGHT_PX - 4}
				/>
			)}
			<span className="cc-timeline__clip-label">{clip.name}</span>
			{isSelected && trimEdge && (
				<span
					className="cc-timeline__trim-readout"
					style={{ left: trimEdge === "start" ? 0 : widthPx }}
				>
					{durationLabel}
				</span>
			)}
			{clip.keyframes?.map((kf) => {
				const kfLeftPx = timeToPixels({ timeSec: kf.timeSec, pixelsPerSecond });
				if (kfLeftPx < 0 || kfLeftPx > widthPx) return null;
				return (
					<button
						type="button"
						key={kf.id}
						className="cc-timeline__keyframe-diamond"
						style={{ left: kfLeftPx }}
						aria-label={`Keyframe at ${kf.timeSec.toFixed(2)}s`}
						onPointerDown={(event) => {
							event.stopPropagation();
							onKeyframeTap?.({ clipId: clip.id, keyframeId: kf.id });
						}}
					/>
				);
			})}
			{isSelected && (
				<>
					<div
						className="cc-timeline__clip-handle cc-timeline__clip-handle--start"
						onPointerDown={beginTrim("start")}
						onPointerMove={onTrimPointerMove}
						onPointerUp={onTrimPointerEnd}
						onPointerCancel={onTrimPointerEnd}
						role="slider"
						aria-label="Trim clip start"
						aria-valuenow={effectiveStartSec}
						tabIndex={0}
					>
						<div className="cc-timeline__clip-handle-grip" />
					</div>
					<div
						className="cc-timeline__clip-handle cc-timeline__clip-handle--end"
						onPointerDown={beginTrim("end")}
						onPointerMove={onTrimPointerMove}
						onPointerUp={onTrimPointerEnd}
						onPointerCancel={onTrimPointerEnd}
						role="slider"
						aria-label="Trim clip end"
						aria-valuenow={effectiveStartSec + effectiveDurationSec}
						tabIndex={0}
					>
						<div className="cc-timeline__clip-handle-grip" />
					</div>
				</>
			)}
		</div>
	);
}

function ClipFilmstrip({
	clip,
	widthPx,
	pixelsPerSecond,
	viewStartSec,
	viewEndSec,
	effectiveStartSec,
	effectiveDurationSec,
}: {
	clip: TimelineClipVM;
	widthPx: number;
	pixelsPerSecond: number;
	viewStartSec: number;
	viewEndSec: number;
	effectiveStartSec: number;
	effectiveDurationSec: number;
}) {
	const slotIntervalSec = thumbnailSlotIntervalSec({
		pixelsPerSecond,
		targetThumbWidthPx: TARGET_THUMB_WIDTH_PX,
	});
	// Clip-relative visible window — only generate/render slots actually
	// on-screen (plan M7 item 8: virtualize thumbnail rendering).
	const clipVisibleStartSec = Math.max(0, viewStartSec - effectiveStartSec);
	const clipVisibleEndSec = Math.min(
		effectiveDurationSec,
		viewEndSec - effectiveStartSec,
	);
	const slots = visibleThumbnailSlots({
		clipDurationSec: effectiveDurationSec,
		slotIntervalSec,
		clipVisibleStartSec,
		clipVisibleEndSec,
	});
	const slotWidthPx = Math.max(
		1,
		timeToPixels({ timeSec: slotIntervalSec, pixelsPerSecond }),
	);

	return (
		<div className="cc-timeline__clip-thumbnails" style={{ width: widthPx }}>
			{slots.map((slotSec) => (
				<div
					key={slotSec}
					style={{
						position: "absolute",
						left: timeToPixels({ timeSec: slotSec, pixelsPerSecond }),
					}}
				>
					<FilmstripThumbnail
						widthPx={slotWidthPx}
						realUri={clip.thumbnails?.[slotSec]}
						colorHue={clip.colorHue}
						slotSec={slotSec}
					/>
				</div>
			))}
		</div>
	);
}

export function formatClipDuration({ durationSec }: { durationSec: number }): string {
	const clamped = Math.max(0, durationSec);
	const minutes = Math.floor(clamped / 60);
	const seconds = clamped % 60;
	if (minutes > 0) {
		return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
	}
	return `${seconds.toFixed(1)}s`;
}
