import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import type { TimelineProjectVM } from "../../timeline/types";
import {
	clampTime,
	clampZoom,
	pixelsPerSecondForZoom,
	pixelsToTime,
	timeToPixels,
} from "../../timeline/time-scale";
import { usePinchZoom } from "../../timeline/use-pinch-zoom";
import { useElementSize } from "../../timeline/use-element-size";
import { buildSnapTargets } from "../../timeline/snapping";
import { hapticTick } from "../../timeline/haptics";
import { TimelineRuler } from "./timeline-ruler";
import { TimelinePlayhead } from "./timeline-playhead";
import { TimelineTrackRow, type TrimPreview } from "./timeline-track-row";
import { TransitionSheet } from "./transition-sheet";
import type { TrimEdge } from "./timeline-clip";

const SNAP_THRESHOLD_PX = 8;
const VIEW_OVERSCAN_SEC = 3;
const DEFAULT_TRANSITION_DURATION_SEC = 0.5;

export interface TimelineViewHandle {
	/** Imperative seek — the harness's "play" simulation drives this rather
	 *  than a controlled prop, so the scroll<->time sync logic below only
	 *  has ONE write path to reason about (see the component's own header
	 *  comment) instead of fighting a parent-driven prop on every frame. */
	seek: (params: { timeSec: number }) => void;
}

interface Transition {
	kind: string;
	durationSec: number;
}

/**
 * The CapCut-mobile timeline surface (plan M7). Architecture notes live in
 * components.css's "Timeline (M7)" header — the short version: ONE
 * scrollable element is both the time axis and the track stack;
 * `scrollLeft` is kept synced to `currentTimeSec` so the fixed, centered
 * `TimelinePlayhead` always shows the right time, and the sync is written
 * from exactly one place (`syncScrollToTime`) with a re-entrancy guard so
 * the native `scroll` event (user scrubbing) and our own programmatic sets
 * (seek/zoom) can't fight each other.
 *
 * Live editor-core wiring (mapping a real project into `TimelineProjectVM`)
 * is NOT done — see this file's consumer,
 * apps/web/src/app/dev/mobile-timeline/page.tsx, and the M7 handoff notes.
 */
export const TimelineView = forwardRef<TimelineViewHandle, {
	project: TimelineProjectVM;
	onTimeChange?: (params: { timeSec: number }) => void;
	onZoomChange?: (params: { zoom: number }) => void;
}>(function TimelineView({ project, onTimeChange, onZoomChange }, ref) {
	const { ref: scrollRef, width: viewportWidthPx } = useElementSize<HTMLDivElement>();
	const [zoom, setZoom] = useState(1);
	const [currentTimeSec, setCurrentTimeSec] = useState(0);
	const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
	const [trimPreview, setTrimPreview] = useState<TrimPreview | null>(null);
	const [snapIndicatorSec, setSnapIndicatorSec] = useState<number | null>(null);
	const [transitions, setTransitions] = useState<Record<string, Transition>>({});
	const [openTransitionAfterClipId, setOpenTransitionAfterClipId] = useState<
		string | null
	>(null);

	const isProgrammaticScrollRef = useRef(false);
	const pixelsPerSecond = pixelsPerSecondForZoom({ zoom });

	/**
	 * Half the viewport width, used as BOTH the leading/trailing gutter
	 * padding on `.cc-timeline__content` AND the playhead's fixed screen
	 * position. Without a gutter, `scrollLeft` can never go negative, so
	 * `timeToPixels(0) - centerPx` clamps to 0 and the view ends up
	 * centered on `centerPx`-worth of SECONDS in, not on time 0 — verified
	 * this exact bug in-browser this session (zoomed out with the harness's
	 * "seek to 0" state and found the playhead sitting over the ~30s ruler
	 * mark instead of 0:00). Padding both ends by `edgePaddingPx` means
	 * `scrollLeft === timeToPixels(currentTimeSec)` always holds exactly —
	 * see the derivation in this file's git history / PR description for
	 * why the padding cancels the center-offset term algebraically.
	 */
	const edgePaddingPx = (viewportWidthPx || 0) / 2;

	const syncScrollToTime = useCallback(
		(timeSec: number) => {
			const node = scrollRef.current;
			if (!node) return;
			isProgrammaticScrollRef.current = true;
			node.scrollLeft = Math.max(0, timeToPixels({ timeSec, pixelsPerSecond }));
		},
		[pixelsPerSecond, scrollRef],
	);

	// Re-anchor whenever zoom changes (pinch) or the viewport first measures,
	// so the same time stays under the fixed centered playhead.
	useEffect(() => {
		syncScrollToTime(currentTimeSec);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally NOT depending on currentTimeSec: user scrubbing (native scroll -> setCurrentTimeSec) must not trigger a re-sync that would fight the scroll it just produced. Only zoom/viewport changes and imperative seek() re-anchor.
	}, [pixelsPerSecond, viewportWidthPx]);

	useImperativeHandle(
		ref,
		() => ({
			seek: ({ timeSec }) => {
				const clamped = clampTime({ timeSec, durationSec: project.durationSec });
				setCurrentTimeSec(clamped);
				syncScrollToTime(clamped);
				onTimeChange?.({ timeSec: clamped });
			},
		}),
		[onTimeChange, project.durationSec, syncScrollToTime],
	);

	const handleScroll = useCallback(() => {
		if (isProgrammaticScrollRef.current) {
			isProgrammaticScrollRef.current = false;
			return;
		}
		const node = scrollRef.current;
		if (!node) return;
		const timeSec = clampTime({
			timeSec: pixelsToTime({ px: node.scrollLeft, pixelsPerSecond }),
			durationSec: project.durationSec,
		});
		setCurrentTimeSec(timeSec);
		onTimeChange?.({ timeSec });
	}, [onTimeChange, pixelsPerSecond, project.durationSec, scrollRef]);

	const applyZoomFactor = useCallback(
		(factor: number) => {
			// The updater passed to setState must stay pure — no side effects
			// (calling `onZoomChange` here was a real bug this session: React
			// logged "Cannot update a component while rendering a different
			// component" from inside this exact updater, confirmed via the
			// browser console during in-browser testing of rapid pinch/wheel
			// events). `onZoomChange` fires from the effect below instead,
			// keyed off the committed `zoom` value.
			setZoom((z) => clampZoom({ zoom: z * factor }));
		},
		[],
	);

	useEffect(() => {
		onZoomChange?.({ zoom });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- only fire on an actual zoom change, not every time the caller passes a new onZoomChange identity.
	}, [zoom]);

	const pinch = usePinchZoom({ onZoomFactor: applyZoomFactor });

	// ctrl/cmd + wheel zoom — the desktop-testing equivalent of pinch (same
	// modifier convention as apps/web/src/timeline's existing wheel-zoom
	// handler), since a real trackpad/mouse can't produce a 2-pointer touch
	// gesture. Also lets this component be exercised without a touchscreen.
	const handleWheel = useCallback(
		(event: React.WheelEvent) => {
			if (!event.ctrlKey && !event.metaKey) return;
			event.preventDefault();
			const factor = Math.exp(-event.deltaY / 300);
			applyZoomFactor(factor);
		},
		[applyZoomFactor],
	);

	const scrollLeft = scrollRef.current?.scrollLeft ?? 0;
	// Content-space -> time requires subtracting the leading gutter (see
	// `edgePaddingPx` above) — content-x 0 is blank padding, time 0 starts
	// at content-x `edgePaddingPx`.
	const viewStartSec = pixelsToTime({ px: scrollLeft - edgePaddingPx, pixelsPerSecond });
	const viewEndSec = pixelsToTime({
		px: scrollLeft + (viewportWidthPx || 0) - edgePaddingPx,
		pixelsPerSecond,
	});

	const allClipEdges = useMemo(() => {
		const edges: number[] = [];
		for (const track of project.tracks) {
			for (const clip of track.clips) {
				edges.push(clip.startSec, clip.startSec + clip.durationSec);
			}
		}
		return edges;
	}, [project.tracks]);

	const snapTargets = useMemo(
		() =>
			buildSnapTargets({
				clipEdgesSec: allClipEdges,
				playheadSec: currentTimeSec,
				durationSec: project.durationSec,
			}),
		[allClipEdges, currentTimeSec, project.durationSec],
	);
	const snapThresholdSec = pixelsToTime({ px: SNAP_THRESHOLD_PX, pixelsPerSecond });

	const handleTrimPreview = useCallback(
		(params: { clipId: string; edge: TrimEdge; boundarySec: number }) => {
			setTrimPreview(params);
			const target = snapTargets.find(
				(t) => Math.abs(t.timeSec - params.boundarySec) < 1e-6,
			);
			setSnapIndicatorSec(target ? target.timeSec : null);
		},
		[snapTargets],
	);

	const handleTrimCommit = useCallback(() => {
		setTrimPreview(null);
		setSnapIndicatorSec(null);
		// NOTE: this view-model layer does not persist trims back into
		// `project` — a live integration commits through editor-core's own
		// resize command (apps/web/src/timeline/controllers/resize-controller.ts
		// / packages/editor-core/src/commands/timeline) instead of mutating
		// this component's local state, which is why there's no
		// `onTrimCommit` prop threading a new value out of this component.
		// See M7 handoff notes.
	}, []);

	const mainTrack = project.tracks.find((t) => t.kind === "main");
	const openTransitionNeighbors = useMemo(() => {
		if (!openTransitionAfterClipId || !mainTrack) return null;
		const index = mainTrack.clips.findIndex((c) => c.id === openTransitionAfterClipId);
		const before = mainTrack.clips[index];
		const after = mainTrack.clips[index + 1];
		if (!before || !after) return null;
		return { before, after };
	}, [mainTrack, openTransitionAfterClipId]);

	const totalContentHeightPx =
		24 /* ruler, --cc-ruler-height */ + project.tracks.length * 48; /* --cc-track-height */

	return (
		<div className="cc-timeline" style={{ height: "100%" }}>
			<div
				ref={scrollRef}
				className="cc-timeline__scroll"
				onScroll={handleScroll}
				onWheel={handleWheel}
				onPointerDown={pinch.onPointerDown}
				onPointerMove={pinch.onPointerMove}
				onPointerUp={pinch.onPointerEnd}
				onPointerCancel={pinch.onPointerEnd}
			>
				<div
					className="cc-timeline__content"
					style={{
						width:
							timeToPixels({ timeSec: project.durationSec, pixelsPerSecond }) +
							edgePaddingPx * 2,
						paddingLeft: edgePaddingPx,
						paddingRight: edgePaddingPx,
						minHeight: totalContentHeightPx,
					}}
					onPointerDown={() => setSelectedClipId(null)}
				>
					<TimelineRuler durationSec={project.durationSec} pixelsPerSecond={pixelsPerSecond} />
					{project.tracks.map((track) => (
						<TimelineTrackRow
							key={track.id}
							track={track}
							pixelsPerSecond={pixelsPerSecond}
							viewStartSec={viewStartSec - VIEW_OVERSCAN_SEC}
							viewEndSec={viewEndSec + VIEW_OVERSCAN_SEC}
							durationSec={project.durationSec}
							selectedClipId={selectedClipId}
							onSelectClip={({ clipId }) => setSelectedClipId(clipId)}
							trimPreview={trimPreview}
							onTrimPreview={handleTrimPreview}
							onTrimCommit={handleTrimCommit}
							snapTargets={snapTargets}
							snapThresholdSec={snapThresholdSec}
							transitionAfterClipIds={
								track.kind === "main"
									? new Set(Object.keys(transitions))
									: undefined
							}
							onTransitionTap={
								track.kind === "main"
									? ({ afterClipId }) => setOpenTransitionAfterClipId(afterClipId)
									: undefined
							}
						/>
					))}
					{snapIndicatorSec !== null && (
						<div
							className="cc-timeline__snap-indicator"
							style={{
								left: timeToPixels({ timeSec: snapIndicatorSec, pixelsPerSecond }),
								height: totalContentHeightPx,
							}}
						/>
					)}
				</div>
			</div>
			<TimelinePlayhead />
			<div className="cc-timeline__zoom-readout">{Math.round(zoom * 100)}%</div>

			{openTransitionNeighbors && openTransitionAfterClipId && (
				<TransitionSheet
					afterClipId={openTransitionAfterClipId}
					initialDurationSec={
						transitions[openTransitionAfterClipId]?.durationSec ??
						DEFAULT_TRANSITION_DURATION_SEC
					}
					maxDurationSec={Math.min(
						openTransitionNeighbors.before.durationSec,
						openTransitionNeighbors.after.durationSec,
					)}
					onConfirm={({ afterClipId, kind, durationSec, applyToAll }) => {
						hapticTick();
						setTransitions((prev) => {
							if (!applyToAll || !mainTrack) {
								return { ...prev, [afterClipId]: { kind, durationSec } };
							}
							const next = { ...prev };
							for (let i = 0; i < mainTrack.clips.length - 1; i++) {
								next[mainTrack.clips[i].id] = { kind, durationSec };
							}
							return next;
						});
						setOpenTransitionAfterClipId(null);
					}}
					onClose={() => setOpenTransitionAfterClipId(null)}
				/>
			)}
		</div>
	);
});
