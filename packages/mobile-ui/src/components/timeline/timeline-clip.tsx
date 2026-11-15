import { useCallback, useEffect, useRef, useState } from "react";
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
/** Horizontal px a pointer must travel on a SELECTED clip's body before the
 *  gesture becomes a move-drag (below it, it's a tap → selection only). Keeps
 *  taps and the strip's native horizontal scroll working on unselected clips —
 *  the same selection-gating rule the preview gestures adopted (round 23). */
const MOVE_THRESHOLD_PX = 6;
/** Hold duration before a clip LIFTS into reorder mode (long-press).
 *  Movement past MOVE_THRESHOLD_PX before this fires cancels the hold. */
const LONG_PRESS_MS = 450;

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
	onTrimPreview: (params: {
		clipId: string;
		trackId: string;
		edge: TrimEdge;
		boundarySec: number;
	}) => void;
	onTrimCommit: (params: {
		clipId: string;
		trackId: string;
		edge: TrimEdge;
		boundarySec: number;
	}) => void;
	minStartBoundSec: number;
	maxEndBoundSec: number;
	snapTargets: readonly SnapTarget[];
	snapThresholdSec: number;
	onKeyframeTap?: (params: { clipId: string; keyframeId: string }) => void;
	/** Move-drag callbacks (selection-gated horizontal slide of the clip
	 *  body). The clip reports RAW candidate start times; the view owns
	 *  snapping/clamping and echoes the resolved position back through the
	 *  `effectiveStartSec` prop, then commits on `onMoveEnd`. */
	onMovePreview?: (params: { clipId: string; trackId: string; candidateStartSec: number }) => void;
	onMoveEnd?: (params: { clipId: string; trackId: string }) => void;
	/** Hold-to-reorder: fires once when the pointer has stayed put on
	 *  the clip body for LONG_PRESS_MS. The VIEW then owns the pointer via
	 *  window listeners (this element may unmount when the row switches to
	 *  reorder tiles), so no further events are reported here. */
	onLongPress?: (params: {
		clipId: string;
		trackId: string;
		pointerId: number;
		clientX: number;
	}) => void;
	/** Manual strip pan: clips carry touch-action:none (our handlers own
	 *  every touch), so a horizontal drag on an UNSELECTED clip pans the
	 *  scroll strip through this callback instead of native scrolling
	 *  (deltaPx = finger movement; the view applies it to scrollLeft). */
	onPanBy?: (params: { deltaPx: number }) => void;
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
	onMovePreview,
	onMoveEnd,
	onLongPress,
	onPanBy,
}: TimelineClipProps) {
	const [trimEdge, setTrimEdge] = useState<TrimEdge | null>(null);
	const dragRef = useRef<{
		edge: TrimEdge;
		pointerId: number;
		startClientX: number;
		originalBoundarySec: number;
		wasSnapped: boolean;
	} | null>(null);
	/** Move-drag session on the clip BODY. Armed on pointerdown of an
	 *  already-selected clip, promoted to a real drag only past
	 *  MOVE_THRESHOLD_PX so plain taps keep behaving as selection. */
	const moveRef = useRef<{
		pointerId: number;
		startClientX: number;
		originalStartSec: number;
		moving: boolean;
	} | null>(null);
	/** Long-press hold session (any clip body). Cancelled by movement past
	 *  MOVE_THRESHOLD_PX or by pointer end before LONG_PRESS_MS. */
	const pressRef = useRef<{
		pointerId: number;
		startClientX: number;
		timer: ReturnType<typeof setTimeout>;
	} | null>(null);
	/** Manual strip-pan session (UNSELECTED clip body drags). */
	const panRef = useRef<{
		pointerId: number;
		startClientX: number;
		lastClientX: number;
		panning: boolean;
	} | null>(null);
	useEffect(() => {
		return () => {
			if (pressRef.current) clearTimeout(pressRef.current.timer);
		};
	}, []);

	const leftPx = timeToPixels({ timeSec: effectiveStartSec, pixelsPerSecond });
	const widthPx = Math.max(
		1,
		timeToPixels({ timeSec: effectiveDurationSec, pixelsPerSecond }),
	);

	const cancelLongPress = useCallback(() => {
		if (pressRef.current) {
			clearTimeout(pressRef.current.timer);
			pressRef.current = null;
		}
	}, []);

	const handleClipPointerDown = useCallback(
		(event: React.PointerEvent) => {
			event.stopPropagation();
			if (onLongPress) {
				cancelLongPress();
				const pointerId = event.pointerId;
				const clientX = event.clientX;
				pressRef.current = {
					pointerId,
					startClientX: clientX,
					timer: setTimeout(() => {
						pressRef.current = null;
						// The hold wins over whatever else this touch armed —
						// the view owns the pointer from here (see onLongPress).
						moveRef.current = null;
						panRef.current = null;
						onLongPress({ clipId: clip.id, trackId: clip.trackId, pointerId, clientX });
					}, LONG_PRESS_MS),
				};
			}
			if (isSelected && onMovePreview) {
				// Second touch on a selected clip arms a move-drag; it only
				// becomes one after the movement threshold (see pointermove).
				moveRef.current = {
					pointerId: event.pointerId,
					startClientX: event.clientX,
					originalStartSec: effectiveStartSec,
					moving: false,
				};
			} else if (onPanBy) {
				// Unselected clip: a horizontal drag pans the strip manually
				// (clips have touch-action:none, so there's no native scroll
				// to fall back on — see onPanBy's doc comment).
				panRef.current = {
					pointerId: event.pointerId,
					startClientX: event.clientX,
					lastClientX: event.clientX,
					panning: false,
				};
			}
			onSelect({ clipId: clip.id });
		},
		[
			clip.id,
			clip.trackId,
			onSelect,
			isSelected,
			onMovePreview,
			onPanBy,
			onLongPress,
			cancelLongPress,
			effectiveStartSec,
		],
	);

	const handleClipPointerMove = useCallback(
		(event: React.PointerEvent) => {
			const press = pressRef.current;
			if (
				press &&
				press.pointerId === event.pointerId &&
				Math.abs(event.clientX - press.startClientX) >= MOVE_THRESHOLD_PX
			) {
				cancelLongPress();
			}

			const move = moveRef.current;
			if (move && move.pointerId === event.pointerId) {
				const deltaPx = event.clientX - move.startClientX;
				if (!move.moving) {
					if (Math.abs(deltaPx) < MOVE_THRESHOLD_PX) return;
					move.moving = true;
					// Same best-effort capture rule as beginTrim below: capture
					// keeps the drag alive outside the clip's bounds but must
					// never abort the gesture when the browser rejects the
					// pointerId.
					try {
						event.currentTarget.setPointerCapture(event.pointerId);
					} catch {
						// Handlers stay bound to this element; the drag still
						// works while the pointer remains over it.
					}
				}
				const candidateStartSec =
					move.originalStartSec + pixelsToTime({ px: deltaPx, pixelsPerSecond });
				onMovePreview?.({
					clipId: clip.id,
					trackId: clip.trackId,
					candidateStartSec,
				});
				return;
			}

			const pan = panRef.current;
			if (pan && pan.pointerId === event.pointerId) {
				if (!pan.panning) {
					if (Math.abs(event.clientX - pan.startClientX) < MOVE_THRESHOLD_PX) return;
					pan.panning = true;
					pan.lastClientX = event.clientX;
					try {
						event.currentTarget.setPointerCapture(event.pointerId);
					} catch {
						// Best-effort, same as above.
					}
					return;
				}
				onPanBy?.({ deltaPx: event.clientX - pan.lastClientX });
				pan.lastClientX = event.clientX;
			}
		},
		[clip.id, clip.trackId, pixelsPerSecond, onMovePreview, onPanBy, cancelLongPress],
	);

	const handleClipPointerEnd = useCallback(
		(event: React.PointerEvent) => {
			cancelLongPress();
			const pan = panRef.current;
			if (pan && pan.pointerId === event.pointerId) {
				panRef.current = null;
			}
			const move = moveRef.current;
			if (!move || move.pointerId !== event.pointerId) return;
			moveRef.current = null;
			if (move.moving) {
				onMoveEnd?.({ clipId: clip.id, trackId: clip.trackId });
			}
		},
		[clip.id, clip.trackId, onMoveEnd, cancelLongPress],
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

			onTrimPreview({
				clipId: clip.id,
				trackId: clip.trackId,
				edge: drag.edge,
				boundarySec: snappedSec,
			});
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
			onTrimCommit({
				clipId: clip.id,
				trackId: clip.trackId,
				edge: drag.edge,
				boundarySec,
			});
			dragRef.current = null;
			setTrimEdge(null);
		},
		[clip.id, clip.trackId, effectiveStartSec, effectiveDurationSec, onTrimCommit],
	);

	const durationLabel = formatClipDuration({ durationSec: effectiveDurationSec });

	return (
		<div
			className={`cc-timeline__clip cc-timeline__clip--${clip.kind}${isSelected ? " cc-timeline__clip--selected" : ""}`}
			style={{ left: leftPx, width: widthPx }}
			onPointerDown={handleClipPointerDown}
			onPointerMove={handleClipPointerMove}
			onPointerUp={handleClipPointerEnd}
			onPointerCancel={handleClipPointerEnd}
			role="button"
			tabIndex={0}
			aria-label={`${clip.name}, ${durationLabel}${isSelected ? ", selected" : ""}`}
			aria-pressed={isSelected}
		>
			{/* Only real images: a photo, or real video frames. A clip
			    without them keeps its plain colour (the placeholder
			    pattern never showed in the app, see ClipFilmstrip). */}
			{(clip.kind === "video" || clip.kind === "image") && (clip.posterUri || clip.thumbnails) && (
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
						// The slot takes the clip's height. Without top and
						// bottom, the slot has no height, and the frame inside
						// (height 100%) is 0 px tall: the 1.0.4 blind test saw
						// a photo clip without its photo.
						top: 0,
						bottom: 0,
					}}
				>
					<FilmstripThumbnail
						widthPx={slotWidthPx}
						realUri={clip.thumbnails?.[slotSec] ?? clip.posterUri}
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
