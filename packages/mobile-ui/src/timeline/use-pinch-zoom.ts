import { useCallback, useRef } from "react";

/**
 * Two-pointer pinch tracking, Pointer Events only (invariants.sh's
 * STRICT_MOUSE_EVENT_GATE scans this package for raw mouse-event listeners
 * — see M5 commit 50bd2a9f). Reports a multiplicative zoom `factor` per
 * move (new distance / previous distance) rather than an absolute zoom
 * level, so the caller (timeline-view.tsx) can apply it as
 * `setZoom((z) => clampZoom({ zoom: z * factor }))` the same way the
 * existing desktop `zoom-controller.ts` composes pinch deltas.
 */
export function usePinchZoom({
	onZoomFactor,
}: {
	onZoomFactor: (factor: number) => void;
}) {
	const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
	const lastDistanceRef = useRef<number | null>(null);

	const distanceBetween = (points: { x: number; y: number }[]): number => {
		const [a, b] = points;
		return Math.hypot(a.x - b.x, a.y - b.y);
	};

	const onPointerDown = useCallback((event: React.PointerEvent) => {
		pointersRef.current.set(event.pointerId, {
			x: event.clientX,
			y: event.clientY,
		});
		if (pointersRef.current.size === 2) {
			lastDistanceRef.current = distanceBetween([...pointersRef.current.values()]);
		}
	}, []);

	const onPointerMove = useCallback(
		(event: React.PointerEvent) => {
			if (!pointersRef.current.has(event.pointerId)) return;
			pointersRef.current.set(event.pointerId, {
				x: event.clientX,
				y: event.clientY,
			});
			if (pointersRef.current.size !== 2) return;

			const distance = distanceBetween([...pointersRef.current.values()]);
			const previous = lastDistanceRef.current;
			if (previous && previous > 0) {
				onZoomFactor(distance / previous);
			}
			lastDistanceRef.current = distance;
		},
		[onZoomFactor],
	);

	const onPointerEnd = useCallback((event: React.PointerEvent) => {
		pointersRef.current.delete(event.pointerId);
		if (pointersRef.current.size < 2) {
			lastDistanceRef.current = null;
		}
	}, []);

	return {
		onPointerDown,
		onPointerMove,
		onPointerEnd,
	};
}
