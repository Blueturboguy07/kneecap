import type { PointerEvent as ReactPointerEvent } from "react";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";
import { hapticTick } from "@/timeline/haptics";
import {
	addMediaTime,
	maxMediaTime,
	type MediaTime,
	mediaTime,
	minMediaTime,
	subMediaTime,
	TICKS_PER_SECOND,
} from "@/wasm";
import {
	computeGroupResize,
	type GroupResizeMember,
	type GroupResizeResult,
	type GroupResizeUpdate,
	type ResizeSide,
} from "@/timeline/group-resize";
import {
	buildTimelineSnapPoints,
	getTimelineSnapThresholdInTicks,
	resolveTimelineSnap,
	type SnapPoint,
} from "@/timeline/snapping";
import { getElementEdgeSnapPoints } from "@/timeline/element-snap-source";
import { getPlayheadSnapPoints } from "@/timeline/playhead-snap-source";
import { getAnimationKeyframeSnapPointsForTimeline } from "@/timeline/animation-snap-points";
import {
	isRetimableElement,
	type SceneTracks,
	type TimelineElement,
	type TimelineTrack,
} from "@/timeline";
import type { ElementRef } from "@/timeline/types";
import type { FrameRate } from "opencut-wasm";

// --- Session ---

interface ResizeSession {
	kind: "active";
	side: ResizeSide;
	startX: number;
	fps: FrameRate;
	members: GroupResizeMember[];
	result: GroupResizeResult | null;
	pointerId: number;
	captureTarget: Element;
}

type Session = { kind: "idle" } | ResizeSession;

// --- Config ---

export interface ResizeConfig {
	zoomLevel: number;
	snappingEnabled: boolean;
	isShiftHeld: () => boolean;
	getSceneTracks: () => SceneTracks;
	getCurrentPlayheadTime: () => MediaTime;
	getActiveProjectFps: () => FrameRate | null;
	selectedElements: ElementRef[];
	discardPreview: () => void;
	previewElements: (updates: GroupResizeUpdate[]) => void;
	commitElements: (updates: GroupResizeUpdate[]) => void;
	onSnapPointChange?: (snapPoint: SnapPoint | null) => void;
}

export interface ResizeConfigRef {
	readonly current: ResizeConfig;
}

// --- Pure helpers ---

export function buildResizeMembers({
	tracks,
	selectedElements,
}: {
	tracks: SceneTracks;
	selectedElements: ElementRef[];
}): GroupResizeMember[] {
	const selectedElementIds = new Set(
		selectedElements.map((el) => el.elementId),
	);
	const trackMap = new Map(
		[...tracks.overlay, tracks.main, ...tracks.audio].map((track) => [
			track.id,
			track,
		]),
	);

	return selectedElements.flatMap(({ trackId, elementId }) => {
		const track = trackMap.get(trackId);
		const element = track?.elements.find((el) => el.id === elementId);
		if (!track || !element) return [];

		const otherElements = track.elements.filter(
			(el) => !selectedElementIds.has(el.id),
		);
		const leftNeighborBound = otherElements
			.filter(
				(el) =>
					addMediaTime({ a: el.startTime, b: el.duration }) <=
					element.startTime,
			)
			.reduce<MediaTime | null>((bound, el) => {
				const elementEnd = addMediaTime({
					a: el.startTime,
					b: el.duration,
				});
				return bound === null
					? elementEnd
					: maxMediaTime({ a: bound, b: elementEnd });
			}, null);
		const rightNeighborBound = otherElements
			.filter(
				(el) =>
					el.startTime >= addMediaTime({ a: element.startTime, b: element.duration }),
			)
			.reduce<MediaTime | null>(
				(bound, el) =>
					bound === null
						? el.startTime
						: minMediaTime({ a: bound, b: el.startTime }),
				null,
			);

		return [
			{
				trackId,
				elementId,
				startTime: element.startTime,
				duration: element.duration,
				trimStart: element.trimStart,
				trimEnd: element.trimEnd,
				sourceDuration: element.sourceDuration,
				retime: isRetimableElement(element) ? element.retime : undefined,
				leftNeighborBound,
				rightNeighborBound,
			},
		];
	});
}

function hasResizeChanges({
	members,
	result,
}: {
	members: GroupResizeMember[];
	result: GroupResizeResult;
}): boolean {
	return result.updates.some((update) => {
		const member = members.find((m) => m.elementId === update.elementId);
		return (
			member?.trimStart !== update.patch.trimStart ||
			member?.trimEnd !== update.patch.trimEnd ||
			member?.startTime !== update.patch.startTime ||
			member?.duration !== update.patch.duration
		);
	});
}

// --- Controller ---

export class ResizeController {
	private session: Session = { kind: "idle" };
	private lastTickedSnapTime: MediaTime | null = null;
	private readonly subscribers = new Set<() => void>();
	private readonly configRef: ResizeConfigRef;

	constructor(deps: { configRef: ResizeConfigRef }) {
		this.configRef = deps.configRef;
		this.onResizeStart = this.onResizeStart.bind(this);
		this.handlePointerMove = this.handlePointerMove.bind(this);
		this.handlePointerUp = this.handlePointerUp.bind(this);
		this.handlePointerCancel = this.handlePointerCancel.bind(this);
	}

	private get config(): ResizeConfig {
		return this.configRef.current;
	}

	get isResizing(): boolean {
		return this.session.kind === "active";
	}

	subscribe(fn: () => void): () => void {
		this.subscribers.add(fn);
		return () => this.subscribers.delete(fn);
	}

	cancel(): void {
		this.config.discardPreview();
		this.finishSession();
	}

	destroy(): void {
		this.deactivate();
		this.subscribers.clear();
	}

	onResizeStart({
		event,
		element,
		track,
		side,
	}: {
		event: ReactPointerEvent;
		element: TimelineElement;
		track: TimelineTrack;
		side: ResizeSide;
	}): void {
		event.stopPropagation();
		event.preventDefault();

		// UI should prevent this, but be explicit: a new resize start
		// means the previous one is abandoned, not silently replaced.
		if (this.session.kind === "active") this.cancel();

		const fps = this.config.getActiveProjectFps();
		if (!fps) return;

		const ref = { trackId: track.id, elementId: element.id };
		const activeSelection = this.config.selectedElements.some(
			(el) => el.trackId === track.id && el.elementId === element.id,
		)
			? this.config.selectedElements
			: [ref];

		const members = buildResizeMembers({
			tracks: this.config.getSceneTracks(),
			selectedElements: activeSelection,
		});
		if (members.length === 0) return;

		this.config.discardPreview();

		// Trim handles are small, unambiguous targets — unlike a clip body,
		// touching one is never confusable with "scroll the track stack", so
		// (unlike element-interaction's clip-body drag) touch gets no
		// long-press gate here: the drag starts immediately, same as mouse.
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			// Best-effort; document-level listeners still work without capture.
		}

		this.session = {
			kind: "active",
			side,
			startX: event.clientX,
			fps,
			members,
			result: null,
			pointerId: event.pointerId,
			captureTarget: event.currentTarget,
		};
		this.activate();
		this.notify();
	}

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

	private releaseCapture(): void {
		if (this.session.kind !== "active") return;
		try {
			this.session.captureTarget.releasePointerCapture(this.session.pointerId);
		} catch {
			// Already released (e.g. element unmounted mid-drag) — fine.
		}
	}

	private notify(): void {
		for (const fn of this.subscribers) fn();
	}

	private finishSession(): void {
		this.releaseCapture();
		this.session = { kind: "idle" };
		this.deactivate();
		this.lastTickedSnapTime = null;
		this.config.onSnapPointChange?.(null);
		this.notify();
	}

	/** Same "tick once per newly-acquired snap point" rule as
	 * element-interaction-controller's notifySnap. */
	private notifySnap(snapPoint: SnapPoint | null): void {
		if (snapPoint && snapPoint.time !== this.lastTickedSnapTime) {
			hapticTick();
		}
		this.lastTickedSnapTime = snapPoint?.time ?? null;
		this.config.onSnapPointChange?.(snapPoint);
	}

	private snappedDelta({
		session,
		rawDeltaTime,
	}: {
		session: ResizeSession;
		rawDeltaTime: MediaTime;
	}): MediaTime {
		const { snappingEnabled, isShiftHeld, zoomLevel } = this.config;

		if (!snappingEnabled || isShiftHeld()) {
			this.notifySnap(null);
			return rawDeltaTime;
		}

		const tracks = this.config.getSceneTracks();
		const playheadTime = this.config.getCurrentPlayheadTime();
		const excludeElementIds = new Set(session.members.map((m) => m.elementId));

		const snapPoints = buildTimelineSnapPoints({
			sources: [
				() => getElementEdgeSnapPoints({ tracks, excludeElementIds }),
				() => getPlayheadSnapPoints({ playheadTime }),
				() =>
					getAnimationKeyframeSnapPointsForTimeline({
						tracks,
						excludeElementIds,
					}),
			],
		});
		const maxSnapDistance = getTimelineSnapThresholdInTicks({ zoomLevel });

		let closestSnapPoint: SnapPoint | null = null;
		let closestSnapDistance = Infinity;
		let deltaTime = rawDeltaTime;

		for (const member of session.members) {
			const baseEdgeTime =
				session.side === "left"
					? member.startTime
					: addMediaTime({ a: member.startTime, b: member.duration });
			const snapResult = resolveTimelineSnap({
				targetTime: addMediaTime({ a: baseEdgeTime, b: rawDeltaTime }),
				snapPoints,
				maxSnapDistance,
			});
			if (
				snapResult.snapPoint &&
				snapResult.snapDistance < closestSnapDistance
			) {
				closestSnapDistance = snapResult.snapDistance;
				closestSnapPoint = snapResult.snapPoint;
				deltaTime = subMediaTime({ a: snapResult.snappedTime, b: baseEdgeTime });
			}
		}

		this.notifySnap(closestSnapPoint);
		return deltaTime;
	}

	private handlePointerMove(event: PointerEvent): void {
		if (this.session.kind !== "active") return;
		if (event.pointerId !== this.session.pointerId) return;
		const session = this.session;
		const { clientX } = event;

		const rawDeltaTime = mediaTime({
			ticks: Math.round(
				((clientX - session.startX) /
					(BASE_TIMELINE_PIXELS_PER_SECOND * this.config.zoomLevel)) *
					TICKS_PER_SECOND,
			),
		});
		const deltaTime = this.snappedDelta({ session, rawDeltaTime });
		const result = computeGroupResize({
			members: session.members,
			side: session.side,
			deltaTime,
			fps: session.fps,
		});

		session.result = result;
		this.config.previewElements(result.updates);
	}

	private handlePointerCancel(event: PointerEvent): void {
		if (this.session.kind !== "active") return;
		if (event.pointerId !== this.session.pointerId) return;
		this.cancel();
	}

	private handlePointerUp(event: PointerEvent): void {
		if (this.session.kind !== "active") return;
		if (event.pointerId !== this.session.pointerId) return;
		const session = this.session;

		this.config.discardPreview();

		if (
			session.result &&
			hasResizeChanges({ members: session.members, result: session.result })
		) {
			this.config.commitElements(session.result.updates);
		}

		this.finishSession();
	}
}
