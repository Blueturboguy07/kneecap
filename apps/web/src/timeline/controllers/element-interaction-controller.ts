import type {
	MouseEvent as ReactMouseEvent,
	PointerEvent as ReactPointerEvent,
} from "react";
import {
	buildMoveGroup,
	resolveGroupMove,
	snapGroupEdges,
	type GroupMoveResult,
	type MoveGroup,
} from "@/timeline/group-move";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import {
	maxMediaTime,
	type MediaTime,
	mediaTime,
	roundFrameTime,
	subMediaTime,
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
} from "@/wasm";
import { TIMELINE_DRAG_THRESHOLD_PX } from "@/timeline/components/interaction";
import type { FrameRate } from "opencut-wasm";
import { computeDropTarget } from "@/timeline/components/drop-target";
import { getMouseTimeFromClientX } from "@/timeline/drag-utils";
import { generateUUID } from "@/utils/id";
import { hapticTick } from "@/timeline/haptics";
import type { SnapPoint } from "@/timeline/snapping";
import type {
	DropTarget,
	ElementRef,
	ElementDragView,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@/timeline";

const MOUSE_BUTTON_RIGHT = 2;

// CapCut mobile's documented model (corpus 05 §2c): touching a clip's body
// doesn't immediately drag it — the clip must "lift" under a long-press
// before a reorder-drag begins. This disambiguates "drag to reorder" from
// "scroll the track stack vertically", which a touch-and-immediately-move
// would otherwise be ambiguous with. A real mouse has no such ambiguity
// (there is no competing scroll gesture bound to the primary button), so
// desktop keeps the original immediate-drag-past-threshold behavior.
const TOUCH_LONG_PRESS_MS = 350;
// If the pointer travels further than this before the long-press timer
// fires, treat it as a scroll/flick, not a lift-to-reorder attempt.
const TOUCH_LONG_PRESS_CANCEL_SLOP_PX = 10;

// --- Config ---

export interface ViewportAdapter {
	getZoomLevel: () => number;
	getTracksScrollEl: () => HTMLDivElement | null;
	getTracksContainerEl: () => HTMLDivElement | null;
	getHeaderEl: () => HTMLElement | null;
}

export interface InputAdapter {
	isShiftHeld: () => boolean;
}

export interface SceneReader {
	getTracks: () => SceneTracks;
	getActiveFps: () => FrameRate | null;
}

export interface ElementSelectionApi {
	getSelected: () => readonly ElementRef[];
	isSelected: (ref: ElementRef) => boolean;
	select: (ref: ElementRef) => void;
	handleClick: (args: ElementRef & { isMultiKey: boolean }) => void;
	clearKeyframeSelection: () => void;
}

export interface PlaybackReader {
	getCurrentTime: () => MediaTime;
}

export interface TimelineOps {
	moveElements: (args: Pick<GroupMoveResult, "moves" | "createTracks">) => void;
}

export interface SnapConfig {
	isEnabled: () => boolean;
	onChange?: (snapPoint: SnapPoint | null) => void;
}

export interface ElementInteractionDeps {
	viewport: ViewportAdapter;
	input: InputAdapter;
	scene: SceneReader;
	selection: ElementSelectionApi;
	playback: PlaybackReader;
	timeline: TimelineOps;
	snap: SnapConfig;
}

export interface ElementInteractionDepsRef {
	readonly current: ElementInteractionDeps;
}

// --- Session ---

type Point = { readonly x: number; readonly y: number };

interface MousedownSnapshot {
	readonly origin: Point;
	readonly elementId: string;
	readonly trackId: string;
	readonly startElementTime: MediaTime;
	readonly clickOffsetTime: MediaTime;
	readonly selectedElements: readonly ElementRef[];
	readonly pointerId: number;
	readonly captureTarget: Element;
	// Touch/pen pointers must clear the long-press gate (see
	// TOUCH_LONG_PRESS_MS) before a drag can begin; mouse never gates.
	readonly requiresLongPress: boolean;
}

interface DragProgress {
	moveGroup: MoveGroup;
	// Pre-minted per member so the identity of any "new track" created by
	// this drag stays stable across pointermove-driven drop-target recomputes.
	// `resolveGroupMoveForDrop` runs every pointermove and emits a
	// `createTracks[]` carrying these IDs; downstream consumers (snap
	// indicator, drop-line, commit path) see the same entity every frame
	// instead of a churning UUID.
	reservedNewTrackIds: readonly string[];
	currentTime: MediaTime;
	currentMouseX: number;
	currentMouseY: number;
	groupMoveResult: GroupMoveResult | null;
	dropTarget: DropTarget | null;
}

type Session =
	| { kind: "idle" }
	| { kind: "pending"; mousedown: MousedownSnapshot }
	| { kind: "dragging"; mousedown: MousedownSnapshot; drag: DragProgress };

const IDLE_VIEW: ElementDragView = { kind: "idle" };

// --- Pure helpers ---

function pixelToClickOffsetTime({
	clientX,
	elementRect,
	zoomLevel,
}: {
	clientX: number;
	elementRect: DOMRect;
	zoomLevel: number;
}): MediaTime {
	const clickOffsetX = clientX - elementRect.left;
	const seconds = clickOffsetX / (BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel);
	return mediaTime({ ticks: Math.round(seconds * TICKS_PER_SECOND) });
}

function verticalDirection({
	startMouseY,
	currentMouseY,
}: {
	startMouseY: number;
	currentMouseY: number;
}): "up" | "down" | null {
	if (currentMouseY < startMouseY) return "up";
	if (currentMouseY > startMouseY) return "down";
	return null;
}

function orderedTracks(sceneTracks: SceneTracks): TimelineTrack[] {
	return [...sceneTracks.overlay, sceneTracks.main, ...sceneTracks.audio];
}

function movedPastDragThreshold({
	current,
	origin,
}: {
	current: Point;
	origin: Point;
}): boolean {
	return (
		Math.abs(current.x - origin.x) > TIMELINE_DRAG_THRESHOLD_PX ||
		Math.abs(current.y - origin.y) > TIMELINE_DRAG_THRESHOLD_PX
	);
}

function frameSnappedMouseTime({
	clientX,
	scrollContainer,
	zoomLevel,
	clickOffsetTime,
	fps,
}: {
	clientX: number;
	scrollContainer: HTMLDivElement;
	zoomLevel: number;
	clickOffsetTime: MediaTime;
	fps: FrameRate;
}): MediaTime {
	const mouseTime = getMouseTimeFromClientX({
		clientX,
		containerRect: scrollContainer.getBoundingClientRect(),
		zoomLevel,
		scrollLeft: scrollContainer.scrollLeft,
	});
	const adjusted = maxMediaTime({
		a: ZERO_MEDIA_TIME,
		b: subMediaTime({ a: mouseTime, b: clickOffsetTime }),
	});
	return roundFrameTime({ time: adjusted, fps });
}

function resolveDropTarget({
	clientX,
	clientY,
	elementId,
	trackId,
	tracks,
	viewport,
	zoomLevel,
	snappedTime,
	verticalDragDirection,
}: {
	clientX: number;
	clientY: number;
	elementId: string;
	trackId: string;
	tracks: SceneTracks;
	viewport: ViewportAdapter;
	zoomLevel: number;
	snappedTime: MediaTime;
	verticalDragDirection: "up" | "down" | null;
}): DropTarget | null {
	const containerRect = viewport
		.getTracksContainerEl()
		?.getBoundingClientRect();
	const scrollContainer = viewport.getTracksScrollEl();
	if (!containerRect || !scrollContainer) return null;

	const sourceTrack = orderedTracks(tracks).find(({ id }) => id === trackId);
	const movingElement = sourceTrack?.elements.find(
		({ id }) => id === elementId,
	);
	if (!movingElement) return null;

	const scrollRect = scrollContainer.getBoundingClientRect();
	const headerHeight =
		viewport.getHeaderEl()?.getBoundingClientRect().height ?? 0;

	return computeDropTarget({
		elementType: movingElement.type,
		mouseX: clientX - scrollRect.left + scrollContainer.scrollLeft,
		mouseY: clientY - scrollRect.top + scrollContainer.scrollTop - headerHeight,
		tracks,
		playheadTime: snappedTime,
		isExternalDrop: false,
		elementDuration: movingElement.duration,
		pixelsPerSecond: BASE_TIMELINE_PIXELS_PER_SECOND,
		zoomLevel,
		startTimeOverride: snappedTime,
		excludeElementId: movingElement.id,
		verticalDragDirection,
	});
}

function resolveGroupMoveForDrop({
	group,
	tracks,
	anchorStartTime,
	dropTarget,
	reservedNewTrackIds,
}: {
	group: MoveGroup;
	tracks: SceneTracks;
	anchorStartTime: MediaTime;
	dropTarget: DropTarget;
	reservedNewTrackIds: readonly string[];
}): GroupMoveResult | null {
	const newTracksFallback = () =>
		resolveGroupMove({
			group,
			tracks,
			anchorStartTime,
			target: {
				kind: "newTracks",
				anchorInsertIndex: dropTarget.trackIndex,
				newTrackIds: [...reservedNewTrackIds],
			},
		});

	if (dropTarget.isNewTrack) return newTracksFallback();

	const targetTrack = orderedTracks(tracks)[dropTarget.trackIndex];
	if (!targetTrack) return null;

	return (
		resolveGroupMove({
			group,
			tracks,
			anchorStartTime,
			target: { kind: "existingTrack", anchorTargetTrackId: targetTrack.id },
		}) ?? newTracksFallback()
	);
}

// --- Controller ---

export class ElementInteractionController {
	private session: Session = { kind: "idle" };
	// True once the active gesture crossed the drag threshold. Read by
	// onElementClick, which fires after pointerup — by which point the session
	// has already returned to idle, so the "was this a drag?" answer must
	// outlive the session. Reset on the next pointerdown.
	private lastGestureWasDrag = false;
	// Set once a touch/pen long-press clears TOUCH_LONG_PRESS_MS without
	// exceeding the cancel-slop. Mouse pointers are armed immediately.
	private longPressArmed = false;
	private longPressTimer: ReturnType<typeof setTimeout> | null = null;
	// Identity of the last snap point we already ticked for — so a haptic
	// fires once per NEW snap acquisition, not on every frame the drag
	// happens to still be resting on the same snap point.
	private lastTickedSnapTime: MediaTime | null = null;

	private readonly subscribers = new Set<() => void>();
	private readonly depsRef: ElementInteractionDepsRef;

	constructor(args: { depsRef: ElementInteractionDepsRef }) {
		this.depsRef = args.depsRef;
	}

	private get deps(): ElementInteractionDeps {
		return this.depsRef.current;
	}

	get view(): ElementDragView {
		if (this.session.kind !== "dragging") return IDLE_VIEW;
		const { mousedown, drag } = this.session;
		const memberTimeOffsets = new Map<string, MediaTime>();
		for (const member of drag.moveGroup.members) {
			memberTimeOffsets.set(member.elementId, member.timeOffset);
		}
		return {
			kind: "dragging",
			anchorElementId: mousedown.elementId,
			trackId: mousedown.trackId,
			memberTimeOffsets,
			startMouseX: mousedown.origin.x,
			startMouseY: mousedown.origin.y,
			startElementTime: mousedown.startElementTime,
			clickOffsetTime: mousedown.clickOffsetTime,
			currentTime: drag.currentTime,
			currentMouseX: drag.currentMouseX,
			currentMouseY: drag.currentMouseY,
			dropTarget: drag.dropTarget,
		};
	}

	get isActive(): boolean {
		return this.session.kind !== "idle";
	}

	subscribe(fn: () => void): () => void {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	cancel = (): void => {
		this.lastGestureWasDrag = false;
		this.clearLongPressTimer();
		this.finishSession();
	};

	destroy(): void {
		this.cancel();
		this.subscribers.clear();
	}

	onElementMouseDown = ({
		event,
		element,
		track,
	}: {
		event: ReactPointerEvent;
		element: TimelineElement;
		track: TimelineTrack;
	}): void => {
		// Right-click must not stopPropagation — ContextMenu needs the bubble.
		if (event.button === MOUSE_BUTTON_RIGHT) {
			const ref = { trackId: track.id, elementId: element.id };
			if (!this.deps.selection.isSelected(ref)) {
				this.deps.selection.handleClick({ ...ref, isMultiKey: false });
			}
			return;
		}

		// A second finger touching down mid-gesture must not perturb an
		// already-armed session.
		if (this.session.kind !== "idle") return;

		event.stopPropagation();
		this.lastGestureWasDrag = false;

		const ref = { trackId: track.id, elementId: element.id };

		if (event.metaKey || event.ctrlKey || event.shiftKey) {
			this.deps.selection.handleClick({ ...ref, isMultiKey: true });
		}

		const selectedElements = this.deps.selection.isSelected(ref)
			? this.deps.selection.getSelected()
			: [ref];

		const isTouchLike = event.pointerType !== "mouse";
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			// Safari sometimes throws on setPointerCapture for already-released
			// pointers; the document-level listeners below still work without it.
		}

		this.session = {
			kind: "pending",
			mousedown: {
				origin: { x: event.clientX, y: event.clientY },
				elementId: element.id,
				trackId: track.id,
				startElementTime: element.startTime,
				clickOffsetTime: pixelToClickOffsetTime({
					clientX: event.clientX,
					elementRect: event.currentTarget.getBoundingClientRect(),
					zoomLevel: this.deps.viewport.getZoomLevel(),
				}),
				selectedElements,
				pointerId: event.pointerId,
				captureTarget: event.currentTarget,
				requiresLongPress: isTouchLike,
			},
		};
		this.longPressArmed = !isTouchLike;
		if (isTouchLike) {
			this.longPressTimer = setTimeout(() => {
				this.longPressTimer = null;
				if (this.session.kind !== "pending") return;
				this.longPressArmed = true;
				hapticTick();
				this.notify();
			}, TOUCH_LONG_PRESS_MS);
		}
		this.activate();
		this.notify();
	};

	// Wired to onClick (a genuine click/tap, fired after pointerup), not
	// onPointerDown — so this one stays a MouseEvent, unlike
	// onElementMouseDown above.
	onElementClick = ({
		event,
		element,
		track,
	}: {
		event: ReactMouseEvent;
		element: TimelineElement;
		track: TimelineTrack;
	}): void => {
		event.stopPropagation();

		if (this.lastGestureWasDrag) {
			this.lastGestureWasDrag = false;
			return;
		}

		if (event.metaKey || event.ctrlKey || event.shiftKey) return;

		const ref = { trackId: track.id, elementId: element.id };
		if (
			!this.deps.selection.isSelected(ref) ||
			this.deps.selection.getSelected().length > 1
		) {
			this.deps.selection.select(ref);
			return;
		}

		this.deps.selection.clearKeyframeSelection();
	};

	private activate(): void {
		document.addEventListener("pointermove", this.handlePointerMove);
		document.addEventListener("pointerup", this.handlePointerUp);
		document.addEventListener("pointercancel", this.handlePointerCancel);
	}

	private deactivate(): void {
		document.removeEventListener("pointermove", this.handlePointerMove);
		document.removeEventListener("pointerup", this.handlePointerUp);
		document.removeEventListener("pointercancel", this.handlePointerCancel);
	}

	private clearLongPressTimer(): void {
		if (this.longPressTimer === null) return;
		clearTimeout(this.longPressTimer);
		this.longPressTimer = null;
	}

	private releaseCapture(): void {
		const target =
			this.session.kind === "idle" ? null : this.session.mousedown.captureTarget;
		const pointerId =
			this.session.kind === "idle" ? null : this.session.mousedown.pointerId;
		if (target === null || pointerId === null) return;
		try {
			if ("releasePointerCapture" in target) {
				(target as Element).releasePointerCapture(pointerId);
			}
		} catch {
			// Capture may already have been released by the browser (e.g. the
			// element was removed from the DOM mid-drag) — nothing to clean up.
		}
	}

	private notify(): void {
		for (const fn of this.subscribers) fn();
	}

	/** Forwards a snap-change to the caller and ticks haptics once per new
	 * (non-null) snap point acquired — not continuously while held. */
	private notifySnap(snapPoint: SnapPoint | null): void {
		if (snapPoint && snapPoint.time !== this.lastTickedSnapTime) {
			hapticTick();
		}
		this.lastTickedSnapTime = snapPoint?.time ?? null;
		this.deps.snap.onChange?.(snapPoint);
	}

	private finishSession(): void {
		this.lastTickedSnapTime = null;
		this.clearLongPressTimer();
		this.releaseCapture();
		this.session = { kind: "idle" };
		this.deactivate();
		this.deps.snap.onChange?.(null);
		this.notify();
	}

	private snapResult({
		frameSnappedTime,
		group,
	}: {
		frameSnappedTime: MediaTime;
		group: MoveGroup;
	}): { snappedTime: MediaTime; snapPoint: SnapPoint | null } {
		const { snap, input, scene, viewport, playback } = this.deps;

		if (!snap.isEnabled() || input.isShiftHeld()) {
			return { snappedTime: frameSnappedTime, snapPoint: null };
		}

		const result = snapGroupEdges({
			group,
			anchorStartTime: frameSnappedTime,
			tracks: scene.getTracks(),
			playheadTime: playback.getCurrentTime(),
			zoomLevel: viewport.getZoomLevel(),
		});

		return {
			snappedTime: result.snappedAnchorStartTime,
			snapPoint: result.snapPoint,
		};
	}

	private updateDropTarget({
		clientX,
		clientY,
		mousedown,
		drag,
		snappedTime,
	}: {
		clientX: number;
		clientY: number;
		mousedown: MousedownSnapshot;
		drag: DragProgress;
		snappedTime: MediaTime;
	}): void {
		const { scene, viewport } = this.deps;
		const tracks = scene.getTracks();
		const zoomLevel = viewport.getZoomLevel();

		const anchorDropTarget = resolveDropTarget({
			clientX,
			clientY,
			elementId: mousedown.elementId,
			trackId: mousedown.trackId,
			tracks,
			viewport,
			zoomLevel,
			snappedTime,
			verticalDragDirection: verticalDirection({
				startMouseY: mousedown.origin.y,
				currentMouseY: clientY,
			}),
		});

		const nextGroupMoveResult = anchorDropTarget
			? resolveGroupMoveForDrop({
					group: drag.moveGroup,
					tracks,
					anchorStartTime: snappedTime,
					dropTarget: anchorDropTarget,
					reservedNewTrackIds: drag.reservedNewTrackIds,
				})
			: null;

		drag.groupMoveResult = nextGroupMoveResult;
		drag.dropTarget =
			anchorDropTarget && (anchorDropTarget.isNewTrack || !nextGroupMoveResult)
				? { ...anchorDropTarget, isNewTrack: true }
				: null;
	}

	private handlePointerMove = (event: PointerEvent): void => {
		const { clientX, clientY } = event;
		const scrollContainer = this.deps.viewport.getTracksScrollEl();
		if (!scrollContainer) return;

		if (this.session.kind === "pending") {
			if (event.pointerId !== this.session.mousedown.pointerId) return;

			// A touch/pen gesture still waiting on its long-press timer: only
			// cancel if it travels past the slop (a scroll/flick, not a lift).
			// Once armed, it falls through to beginDragFromPending like mouse.
			if (
				this.session.mousedown.requiresLongPress &&
				!this.longPressArmed
			) {
				if (
					Math.abs(clientX - this.session.mousedown.origin.x) >
						TOUCH_LONG_PRESS_CANCEL_SLOP_PX ||
					Math.abs(clientY - this.session.mousedown.origin.y) >
						TOUCH_LONG_PRESS_CANCEL_SLOP_PX
				) {
					// Let the gesture fall through as a scroll — this session never
					// became a drag, so there's nothing to commit.
					this.lastGestureWasDrag = false;
					this.finishSession();
				}
				return;
			}

			this.beginDragFromPending({
				mousedown: this.session.mousedown,
				clientX,
				clientY,
				scrollContainer,
			});
			return;
		}

		if (this.session.kind === "dragging") {
			if (event.pointerId !== this.session.mousedown.pointerId) return;
			this.updateActiveDrag({
				mousedown: this.session.mousedown,
				drag: this.session.drag,
				clientX,
				clientY,
				scrollContainer,
			});
		}
	};

	private beginDragFromPending({
		mousedown,
		clientX,
		clientY,
		scrollContainer,
	}: {
		mousedown: MousedownSnapshot;
		clientX: number;
		clientY: number;
		scrollContainer: HTMLDivElement;
	}): void {
		if (
			!movedPastDragThreshold({
				current: { x: clientX, y: clientY },
				origin: mousedown.origin,
			})
		) {
			return;
		}

		const fps = this.deps.scene.getActiveFps();
		if (!fps) return;

		const moveGroup = buildMoveGroup({
			anchorRef: {
				trackId: mousedown.trackId,
				elementId: mousedown.elementId,
			},
			selectedElements: [...mousedown.selectedElements],
			tracks: this.deps.scene.getTracks(),
		});
		if (!moveGroup) return;

		const zoomLevel = this.deps.viewport.getZoomLevel();
		const frameSnappedTime = frameSnappedMouseTime({
			clientX,
			scrollContainer,
			zoomLevel,
			clickOffsetTime: mousedown.clickOffsetTime,
			fps,
		});
		const { snappedTime, snapPoint } = this.snapResult({
			frameSnappedTime,
			group: moveGroup,
		});

		// Ensure the anchor is selected before we render the drag — covers the
		// case where the selection store hasn't committed the mousedown-time
		// selection click yet.
		const anchorRef = {
			trackId: mousedown.trackId,
			elementId: mousedown.elementId,
		};
		if (!this.deps.selection.isSelected(anchorRef)) {
			this.deps.selection.select(anchorRef);
		}

		const drag: DragProgress = {
			moveGroup,
			reservedNewTrackIds: moveGroup.members.map(() => generateUUID()),
			currentTime: snappedTime,
			currentMouseX: clientX,
			currentMouseY: clientY,
			groupMoveResult: null,
			dropTarget: null,
		};

		this.session = { kind: "dragging", mousedown, drag };
		this.lastGestureWasDrag = true;

		this.updateDropTarget({
			clientX,
			clientY,
			mousedown,
			drag,
			snappedTime,
		});

		this.notifySnap(snapPoint);
		this.notify();
	}

	private updateActiveDrag({
		mousedown,
		drag,
		clientX,
		clientY,
		scrollContainer,
	}: {
		mousedown: MousedownSnapshot;
		drag: DragProgress;
		clientX: number;
		clientY: number;
		scrollContainer: HTMLDivElement;
	}): void {
		const fps = this.deps.scene.getActiveFps();
		if (!fps) return;

		const frameSnappedTime = frameSnappedMouseTime({
			clientX,
			scrollContainer,
			zoomLevel: this.deps.viewport.getZoomLevel(),
			clickOffsetTime: mousedown.clickOffsetTime,
			fps,
		});
		const { snappedTime, snapPoint } = this.snapResult({
			frameSnappedTime,
			group: drag.moveGroup,
		});

		drag.currentTime = snappedTime;
		drag.currentMouseX = clientX;
		drag.currentMouseY = clientY;

		this.updateDropTarget({
			clientX,
			clientY,
			mousedown,
			drag,
			snappedTime,
		});

		this.notifySnap(snapPoint);
		this.notify();
	}

	private handlePointerUp = (event: PointerEvent): void => {
		if (this.session.kind === "idle") return;
		if (event.pointerId !== this.session.mousedown.pointerId) return;
		const { clientX, clientY } = event;

		if (this.session.kind === "pending") {
			this.finishSession();
			return;
		}

		const { mousedown, drag } = this.session;

		// If the drag returned within the click threshold of its origin, treat
		// this as a cancel rather than a commit — the user dragged then put the
		// element back.
		if (
			!movedPastDragThreshold({
				current: { x: clientX, y: clientY },
				origin: mousedown.origin,
			})
		) {
			this.lastGestureWasDrag = false;
			this.finishSession();
			return;
		}

		const { moveGroup, groupMoveResult } = drag;
		if (!groupMoveResult) {
			this.finishSession();
			return;
		}

		const didMove = groupMoveResult.moves.some((move) => {
			const member = moveGroup.members.find(
				(m) => m.elementId === move.elementId,
			);
			const originalStartTime =
				mousedown.startElementTime + (member?.timeOffset ?? 0);
			return (
				member?.trackId !== move.targetTrackId ||
				originalStartTime !== move.newStartTime
			);
		});

		if (didMove || groupMoveResult.createTracks.length > 0) {
			this.deps.timeline.moveElements({
				moves: groupMoveResult.moves,
				createTracks: groupMoveResult.createTracks,
			});
		}

		this.finishSession();
	};

	// Fires when the OS/browser interrupts a touch mid-gesture (e.g. an
	// incoming call, or the browser deciding it's actually a page scroll).
	// Always a cancel, never a commit — unlike pointerup, there is no "did
	// the user mean to drop this here" question to ask.
	private handlePointerCancel = (event: PointerEvent): void => {
		if (this.session.kind === "idle") return;
		if (event.pointerId !== this.session.mousedown.pointerId) return;
		this.lastGestureWasDrag = false;
		this.finishSession();
	};
}
