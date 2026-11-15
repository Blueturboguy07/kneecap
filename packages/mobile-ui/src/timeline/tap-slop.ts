/**
 * Blind test round 4, item 4: a touch on the empty timeline clears the selection only when
 * it is a tap. A touch that moves more than this many CSS px is a scroll or a scrub, and
 * the selected clip (and its clip-tools bar) stays.
 */
export const TAP_SLOP_PX = 8;

/** True when the pointer is more than `slopPx` from the point where the touch started. */
export function isPastTapSlop({
	tap,
	event,
	slopPx = TAP_SLOP_PX,
}: {
	tap: { x: number; y: number };
	event: { clientX: number; clientY: number };
	slopPx?: number;
}): boolean {
	return Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > slopPx;
}
