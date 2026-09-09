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
import { buildSnapTargets, resolveSnap } from "../../timeline/snapping";
import { hapticTick } from "../../timeline/haptics";
import { TimelineRuler } from "./timeline-ruler";
import { TimelinePlayhead } from "./timeline-playhead";
import {
	TimelineTrackRow,
	REORDER_STEP_PX,
	type MovePreview,
	type ReorderState,
	type TrimPreview,
} from "./timeline-track-row";
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

export interface Transition {
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
	/** Fixer pass (M7 mount into M8's EditorShell): fires alongside the
	 *  existing local `selectedClipId` highlight state, so a live caller can
	 *  drive the REAL `editor.selection` (see
	 *  `use-timeline-project-vm.ts`'s `TimelineClipVM.id`/`.trackId`, which
	 *  are the real element/track ids, not synthetic mock ids) — this is
	 *  what makes tapping a clip here select the same element the Edit
	 *  panel/preview/other panels already read from `useSelectedElement()`. */
	onSelectClip?: (params: { clipId: string; trackId: string }) => void;
	/** CapCut-parity chrome (founder capture 2026-08-18,
	 *  docs/capcut-reference/capture-editor-toolbar-start.png). All optional
	 *  so the M7 dev harness renders the bare surface unchanged. */
	/** "00:00 / 00:34" readout pinned top-left over the ruler. */
	currentTimeLabel?: string;
	/** Playback-follow inputs: while `isPlaying`, the strip scrolls so the
	 *  fixed centered playhead tracks `playbackTimeSec` (the engine clock).
	 *  See the follow effect below. */
	playbackTimeSec?: number;
	isPlaying?: boolean;
	/** The white "+" square after the main track's last clip (add media). */
	onAddClip?: () => void;
	/** The "+ Add audio" strip below the main track; hidden when the project
	 *  already has an audio track. */
	onAddAudio?: () => void;
	showAddAudio?: boolean;
	/** The small ♪ / T quick-add squares left of time 0. */
	onQuickAddAudio?: () => void;
	onQuickAddText?: () => void;
	/** Helper chips left of the main track's first clip (Mute clip audio /
	 *  AI clipper / Cover in CapCut). */
	leadingChips?: React.ReactNode;
	/** ENGINE-BACKED selection (round 18): when provided (the live shell),
	 *  the strip highlight follows it — a clip grabbed directly on the
	 *  preview highlights here too. Local tap state remains the fallback
	 *  for the dev harness. */
	selectedClipId?: string | null;
	/** Fired when the strip background is tapped (deselect). The live shell
	 *  clears the engine selection here; the harness's local state clears
	 *  either way. */
	onClearSelection?: () => void;
	/** ENGINE-BACKED transitions (round 17): when provided, the squares and
	 *  the sheet read from here and every edit goes through
	 *  `onTransitionCommit` (the shell turns it into an undoable
	 *  TransitionsSnapshotCommand). When absent (the M7 dev harness), the
	 *  original local view-model state still applies so the bare surface
	 *  keeps working. Keyed by the clip the transition FOLLOWS. */
	transitions?: Record<string, Transition>;
	onTransitionCommit?: (params: {
		afterClipId: string;
		kind: string;
		durationSec: number;
		applyToAll: boolean;
	}) => void;
	/** ENGINE-BACKED trim commit (the M7-completion wiring the old no-op
	 *  `handleTrimCommit` comment promised): fired once per finished handle
	 *  drag with the FINAL previewed boundary. The live shell turns it into
	 *  editor-core's resize math + an undoable UpdateElementsCommand; absent
	 *  (the dev harness) the preview still rubber-bands back, as before. */
	onTrimClip?: (params: {
		clipId: string;
		trackId: string;
		edge: TrimEdge;
		boundarySec: number;
	}) => void;
	/** Fired on EVERY trim-preview tick so the shell can scrub the preview
	 *  to the frame under the dragged edge (engine preview overlay + seek;
	 *  see scrubElementTrim). Same params as onTrimClip. */
	onTrimScrub?: (params: {
		clipId: string;
		trackId: string;
		edge: TrimEdge;
		boundarySec: number;
	}) => void;
	/** Round 47: a diamond drawn on a clip was tapped — the shell seeks the
	 *  playhead onto that keyframe (`TimelineKeyframeVM.timeTicks`). */
	onKeyframeTap?: (params: { clipId: string; trackId: string; keyframeId: string }) => void;
	/** Round 47: the keyframe diamond + ‹ › control, pinned top-right of the
	 *  timeline area (the timecode's mirror). Rendered by the shell only
	 *  while a visual clip is selected. */
	keyframeControl?: React.ReactNode;
	/** ENGINE-BACKED move commit: fired once per finished clip-body drag
	 *  with the snapped/clamped start time the preview last showed. */
	onMoveClip?: (params: {
		clipId: string;
		trackId: string;
		startSec: number;
	}) => void;
	/** CapCut hold-to-reorder commit: long-press lifts a MAIN-track clip,
	 *  every clip collapses to a uniform tile, the drop slot decides the
	 *  new order. Fired once per finished reorder drag with the full tile
	 *  order; the shell re-butts the track to it in one undoable command. */
	onReorderMainTrack?: (params: {
		trackId: string;
		orderedClipIds: string[];
	}) => void;
}>(function TimelineView(
	{
		project,
		onTimeChange,
		onZoomChange,
		onSelectClip,
		currentTimeLabel,
		playbackTimeSec,
		isPlaying,
		onAddClip,
		onAddAudio,
		showAddAudio,
		onQuickAddAudio,
		onQuickAddText,
		leadingChips,
		selectedClipId: selectedClipIdProp,
		onClearSelection,
		transitions: transitionsProp,
		onTransitionCommit,
		onTrimClip,
		onTrimScrub,
		onMoveClip,
		onReorderMainTrack,
		onKeyframeTap,
		keyframeControl,
	},
	ref,
) {
	const { ref: scrollRef, width: viewportWidthPx } = useElementSize<HTMLDivElement>();
	const [zoom, setZoom] = useState(1);
	const [currentTimeSec, setCurrentTimeSec] = useState(0);
	const [localSelectedClipId, setSelectedClipId] = useState<string | null>(null);
	const selectedClipId =
		selectedClipIdProp !== undefined ? selectedClipIdProp : localSelectedClipId;
	const [trimPreview, setTrimPreview] = useState<TrimPreview | null>(null);
	const [movePreview, setMovePreview] = useState<MovePreview | null>(null);
	const movePreviewRef = useRef<MovePreview | null>(null);
	const moveWasSnappedRef = useRef(false);
	/** Hold-to-reorder session. dragXPx is content-space (same origin as
	 *  clip lefts: 0 = time 0, i.e. past the leading gutter). */
	const [reorderSession, setReorderSession] = useState<{
		trackId: string;
		clipId: string;
		pointerId: number;
		dragXPx: number;
		/** Tile-strip anchor — see ReorderState.baseXPx. Frozen at mode
		 *  start (the strip can't scroll during the drag; we own the touch). */
		baseXPx: number;
	} | null>(null);
	const reorderSessionRef = useRef<typeof reorderSession>(null);
	const [snapIndicatorSec, setSnapIndicatorSec] = useState<number | null>(null);
	const [localTransitions, setLocalTransitions] = useState<Record<string, Transition>>({});
	// Engine-backed when the shell provides them; local view-model otherwise
	// (dev harness). All reads below go through `transitions`.
	const transitions = transitionsProp ?? localTransitions;
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
			const target = Math.max(0, timeToPixels({ timeSec, pixelsPerSecond }));
			// No-op sets must not arm the programmatic-scroll flag: a set that
			// doesn't move scrollLeft fires no scroll event, so the flag would
			// stay armed and silently swallow the user's NEXT real scroll
			// (frequent under per-frame playback-follow, where sub-pixel time
			// steps round to the same scrollLeft).
			if (Math.abs(node.scrollLeft - target) < 0.5) return;
			isProgrammaticScrollRef.current = true;
			node.scrollLeft = target;
		},
		[pixelsPerSecond, scrollRef],
	);

	// Re-anchor whenever zoom changes (pinch) or the viewport first measures,
	// so the same time stays under the fixed centered playhead.
	useEffect(() => {
		syncScrollToTime(currentTimeSec);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally NOT depending on currentTimeSec: user scrubbing (native scroll -> setCurrentTimeSec) must not trigger a re-sync that would fight the scroll it just produced. Only zoom/viewport changes and imperative seek() re-anchor.
	}, [pixelsPerSecond, viewportWidthPx]);

	// Playback-follow: while the engine clock is running, the strip tracks it
	// (CapCut's fixed-center-playhead model — the STRIP moves, the playhead
	// doesn't). This is the reverse binding of scrub (scroll -> time); it was
	// never wired in the touch rebuild, so the timecode ticked while the
	// timeline sat frozen (founder's iPhone, 2026-08-19). Engine-driven sets
	// go through syncScrollToTime's programmatic flag, so they don't echo
	// back through handleScroll as a seek; a user scrub DURING playback still
	// wins — it lands a real seek, and the next follow tick continues from
	// the sought time.
	useEffect(() => {
		if (!isPlaying || playbackTimeSec == null) return;
		setCurrentTimeSec(playbackTimeSec);
		syncScrollToTime(playbackTimeSec);
	}, [isPlaying, playbackTimeSec, syncScrollToTime]);

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
		(params: {
			clipId: string;
			trackId: string;
			edge: TrimEdge;
			boundarySec: number;
		}) => {
			setTrimPreview(params);
			const target = snapTargets.find(
				(t) => Math.abs(t.timeSec - params.boundarySec) < 1e-6,
			);
			setSnapIndicatorSec(target ? target.timeSec : null);
			// Live scrub: the shell seeks the PREVIEW to the frame under the
			// dragged edge (CapCut behavior — you see what you're cutting to).
			onTrimScrub?.(params);
		},
		[snapTargets, onTrimScrub],
	);

	const handleTrimCommit = useCallback(
		(params: {
			clipId: string;
			trackId: string;
			edge: TrimEdge;
			boundarySec: number;
		}) => {
			setTrimPreview(null);
			setSnapIndicatorSec(null);
			// The M7-completion wiring: the live shell commits through
			// editor-core's resize math (see `onTrimClip`'s doc comment); the
			// dev harness omits the prop and keeps the old rubber-band-back.
			onTrimClip?.(params);
		},
		[onTrimClip],
	);

	/** Snap + clamp a raw clip-body drag candidate, publish the preview.
	 *  Both of the dragged clip's edges compete for the nearest snap target
	 *  (its OWN edges are excluded from the target set — a clip must not
	 *  snap to itself). Non-main tracks clamp into the gap between the
	 *  clip's original neighbors (free-position tracks don't overlap); the
	 *  main track drags freely — its commit re-butts the whole track. */
	const handleMovePreview = useCallback(
		(params: { clipId: string; trackId: string; candidateStartSec: number }) => {
			const track = project.tracks.find((t) => t.id === params.trackId);
			const clipIndex = track?.clips.findIndex((c) => c.id === params.clipId) ?? -1;
			const clip = clipIndex >= 0 ? track?.clips[clipIndex] : undefined;
			if (!track || !clip) return;

			let candidate = Math.max(0, params.candidateStartSec);
			if (track.kind !== "main") {
				const prev = track.clips[clipIndex - 1];
				const next = track.clips[clipIndex + 1];
				const lower = prev ? prev.startSec + prev.durationSec : 0;
				const upper = next
					? next.startSec - clip.durationSec
					: Number.POSITIVE_INFINITY;
				candidate = Math.min(Math.max(candidate, lower), Math.max(lower, upper));
			}

			const edges: number[] = [];
			for (const t of project.tracks) {
				for (const c of t.clips) {
					if (c.id === params.clipId) continue;
					edges.push(c.startSec, c.startSec + c.durationSec);
				}
			}
			const targets = buildSnapTargets({
				clipEdgesSec: edges,
				playheadSec: currentTimeSec,
				durationSec: project.durationSec,
			});
			const startSnap = resolveSnap({
				candidateSec: candidate,
				targets,
				thresholdSec: snapThresholdSec,
			});
			const endSnap = resolveSnap({
				candidateSec: candidate + clip.durationSec,
				targets,
				thresholdSec: snapThresholdSec,
			});
			let resolvedStartSec = candidate;
			let snappedTargetSec: number | null = null;
			const startDistance = startSnap.target
				? Math.abs(startSnap.snappedSec - candidate)
				: Number.POSITIVE_INFINITY;
			const endDistance = endSnap.target
				? Math.abs(endSnap.snappedSec - (candidate + clip.durationSec))
				: Number.POSITIVE_INFINITY;
			if (startDistance <= endDistance && startSnap.target) {
				resolvedStartSec = startSnap.snappedSec;
				snappedTargetSec = startSnap.target.timeSec;
			} else if (endSnap.target) {
				resolvedStartSec = endSnap.snappedSec - clip.durationSec;
				snappedTargetSec = endSnap.target.timeSec;
			}
			resolvedStartSec = Math.max(0, resolvedStartSec);

			if (snappedTargetSec !== null && !moveWasSnappedRef.current) hapticTick();
			moveWasSnappedRef.current = snappedTargetSec !== null;
			setSnapIndicatorSec(snappedTargetSec);
			const preview = { clipId: params.clipId, startSec: resolvedStartSec };
			movePreviewRef.current = preview;
			setMovePreview(preview);
		},
		[project.tracks, project.durationSec, currentTimeSec, snapThresholdSec],
	);

	const handleMoveEnd = useCallback(
		(params: { clipId: string; trackId: string }) => {
			const preview = movePreviewRef.current;
			movePreviewRef.current = null;
			moveWasSnappedRef.current = false;
			setMovePreview(null);
			setSnapIndicatorSec(null);
			if (preview && preview.clipId === params.clipId) {
				onMoveClip?.({
					clipId: params.clipId,
					trackId: params.trackId,
					startSec: preview.startSec,
				});
			}
		},
		[onMoveClip],
	);

	/** Manual strip pan (clip bodies have touch-action:none — see
	 *  timeline-clip.tsx onPanBy): move the scroll node opposite the finger
	 *  delta; the resulting native scroll event runs the normal
	 *  scroll→time seek path. */
	const handlePanBy = useCallback(
		({ deltaPx }: { deltaPx: number }) => {
			const node = scrollRef.current;
			if (!node) return;
			node.scrollLeft -= deltaPx;
		},
		[scrollRef],
	);

	/** clientX → content-space px (0 = time 0, past the leading gutter). */
	const contentXFromClient = useCallback(
		(clientX: number): number => {
			const node = scrollRef.current;
			if (!node) return 0;
			const rect = node.getBoundingClientRect();
			return node.scrollLeft + (clientX - rect.left) - edgePaddingPx;
		},
		[scrollRef, edgePaddingPx],
	);

	// Kept in sync for the window-listener effect below (the listeners
	// outlive any single render's closure).
	reorderSessionRef.current = reorderSession;
	const projectRef = useRef(project);
	projectRef.current = project;

	const reorderInsertionIndex = useCallback(
		(session: { trackId: string; dragXPx: number; baseXPx: number }): number => {
			const track = projectRef.current.tracks.find((t) => t.id === session.trackId);
			const count = track?.clips.length ?? 0;
			if (count === 0) return 0;
			return Math.min(
				count - 1,
				Math.max(0, Math.round((session.dragXPx - session.baseXPx) / REORDER_STEP_PX)),
			);
		},
		[],
	);

	const handleLongPress = useCallback(
		(params: {
			clipId: string;
			trackId: string;
			pointerId: number;
			clientX: number;
		}) => {
			if (!onReorderMainTrack) return;
			const track = project.tracks.find((t) => t.id === params.trackId);
			if (!track || track.kind !== "main" || track.clips.length < 2) return;
			hapticTick();
			// The hold supersedes any in-flight trim/move preview state.
			setTrimPreview(null);
			setMovePreview(null);
			movePreviewRef.current = null;
			setSnapIndicatorSec(null);
			// Anchor the tile strip to the viewport's left edge (content-space):
			// tiles must appear where the user is LOOKING, not at time 0.
			const node = scrollRef.current;
			const baseXPx = node ? node.scrollLeft - edgePaddingPx + 16 : 0;
			setReorderSession({
				trackId: params.trackId,
				clipId: params.clipId,
				pointerId: params.pointerId,
				dragXPx: contentXFromClient(params.clientX),
				baseXPx,
			});
		},
		[onReorderMainTrack, project.tracks, contentXFromClient, scrollRef, edgePaddingPx],
	);

	// The reordering row swaps to tile rendering, unmounting the clip
	// element the hold started on — so the drag lives on WINDOW listeners
	// for the mode's whole lifetime (element capture would die with the
	// unmount). pointerup commits, pointercancel abandons.
	useEffect(() => {
		if (!reorderSession) return;
		const onMove = (event: PointerEvent) => {
			const session = reorderSessionRef.current;
			if (!session || event.pointerId !== session.pointerId) return;
			const dragXPx = contentXFromClient(event.clientX);
			setReorderSession((prev) => (prev ? { ...prev, dragXPx } : prev));
		};
		const finish = (commit: boolean) => {
			const session = reorderSessionRef.current;
			setReorderSession(null);
			if (!commit || !session) return;
			const track = projectRef.current.tracks.find((t) => t.id === session.trackId);
			if (!track) return;
			const ordered = [...track.clips].sort((a, b) => a.startSec - b.startSec);
			const others = ordered
				.filter((c) => c.id !== session.clipId)
				.map((c) => c.id);
			const index = reorderInsertionIndex(session);
			others.splice(index, 0, session.clipId);
			hapticTick();
			onReorderMainTrack?.({ trackId: session.trackId, orderedClipIds: others });
		};
		const onUp = (event: PointerEvent) => {
			const session = reorderSessionRef.current;
			if (!session || event.pointerId !== session.pointerId) return;
			finish(true);
		};
		const onCancel = (event: PointerEvent) => {
			const session = reorderSessionRef.current;
			if (!session || event.pointerId !== session.pointerId) return;
			finish(false);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onCancel);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onCancel);
		};
	}, [
		reorderSession !== null,
		contentXFromClient,
		reorderInsertionIndex,
		onReorderMainTrack,
	]);

	const mainTrack = project.tracks.find((t) => t.kind === "main");
	const mainTrackEndPx = mainTrack
		? timeToPixels({
				timeSec: mainTrack.clips.reduce(
					(end, clip) => Math.max(end, clip.startSec + clip.durationSec),
					0,
				),
				pixelsPerSecond,
			})
		: 0;
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
		<div
			className={`cc-timeline${reorderSession ? " cc-timeline--reordering" : ""}`}
			style={{ height: "100%" }}
		>
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
					onPointerDown={() => {
						setSelectedClipId(null);
						onClearSelection?.();
					}}
				>
					<TimelineRuler durationSec={project.durationSec} pixelsPerSecond={pixelsPerSecond} />
					{leadingChips && (
						<div
							className="cc-timeline__leading-chips"
							style={{ width: Math.max(0, edgePaddingPx - 8) }}
						>
							{leadingChips}
						</div>
					)}
					{onAddClip && (
						<button
							type="button"
							className="cc-timeline__add-clip"
							style={{ left: edgePaddingPx + mainTrackEndPx + 8 }}
							onPointerDown={(event) => event.stopPropagation()}
							onClick={onAddClip}
							aria-label="Add clip"
						>
							+
						</button>
					)}
					{(onQuickAddAudio || onQuickAddText) && (
						<div
							className="cc-timeline__quick-add"
							style={{ width: Math.max(0, edgePaddingPx - 8) }}
						>
							{onQuickAddAudio && (
								<button
									type="button"
									className="cc-timeline__quick-add-btn"
									onPointerDown={(event) => event.stopPropagation()}
									onClick={onQuickAddAudio}
									aria-label="Add audio"
								>
									♪
								</button>
							)}
							{onQuickAddText && (
								<button
									type="button"
									className="cc-timeline__quick-add-btn"
									onPointerDown={(event) => event.stopPropagation()}
									onClick={onQuickAddText}
									aria-label="Add text"
								>
									T
								</button>
							)}
						</div>
					)}
					{project.tracks.map((track) => (
						<TimelineTrackRow
							key={track.id}
							track={track}
							pixelsPerSecond={pixelsPerSecond}
							viewStartSec={viewStartSec - VIEW_OVERSCAN_SEC}
							viewEndSec={viewEndSec + VIEW_OVERSCAN_SEC}
							durationSec={project.durationSec}
							selectedClipId={selectedClipId}
							onSelectClip={({ clipId }) => {
								setSelectedClipId(clipId);
								onSelectClip?.({ clipId, trackId: track.id });
							}}
							trimPreview={trimPreview}
							onTrimPreview={handleTrimPreview}
							onTrimCommit={handleTrimCommit}
							movePreview={movePreview}
							onMovePreview={onMoveClip ? handleMovePreview : undefined}
							onMoveEnd={onMoveClip ? handleMoveEnd : undefined}
							onLongPress={
								onReorderMainTrack && track.kind === "main" ? handleLongPress : undefined
							}
							onPanBy={handlePanBy}
							reorder={
								reorderSession && reorderSession.trackId === track.id
									? ({
											draggedClipId: reorderSession.clipId,
											insertionIndex: reorderInsertionIndex(reorderSession),
											dragXPx: reorderSession.dragXPx,
											baseXPx: reorderSession.baseXPx,
										} satisfies ReorderState)
									: null
							}
							snapTargets={snapTargets}
							snapThresholdSec={snapThresholdSec}
							onKeyframeTap={
								onKeyframeTap
									? ({ clipId, keyframeId }) => onKeyframeTap({ clipId, trackId: track.id, keyframeId })
									: undefined
							}
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
					{showAddAudio && onAddAudio && (
						<button
							type="button"
							className="cc-timeline__add-audio"
							style={{ width: Math.max(mainTrackEndPx, (viewportWidthPx || 320) * 0.88) }}
							onPointerDown={(event) => event.stopPropagation()}
							onClick={onAddAudio}
						>
							<span className="cc-timeline__add-audio-plus">+</span> Add audio
						</button>
					)}
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
			{currentTimeLabel && <div className="cc-timeline__timecode">{currentTimeLabel}</div>}
			{keyframeControl && <div className="cc-timeline__keyframe-control">{keyframeControl}</div>}

			{openTransitionNeighbors && openTransitionAfterClipId && (
				<TransitionSheet
					afterClipId={openTransitionAfterClipId}
					initialKind={transitions[openTransitionAfterClipId]?.kind}
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
						if (onTransitionCommit) {
							onTransitionCommit({ afterClipId, kind, durationSec, applyToAll });
						} else {
							setLocalTransitions((prev) => {
								const applyOne = (
									next: Record<string, Transition>,
									id: string,
								) => {
									if (kind === "none") delete next[id];
									else next[id] = { kind, durationSec };
								};
								const next = { ...prev };
								if (!applyToAll || !mainTrack) {
									applyOne(next, afterClipId);
									return next;
								}
								for (let i = 0; i < mainTrack.clips.length - 1; i++) {
									applyOne(next, mainTrack.clips[i].id);
								}
								return next;
							});
						}
						setOpenTransitionAfterClipId(null);
					}}
					onClose={() => setOpenTransitionAfterClipId(null)}
				/>
			)}
		</div>
	);
});
