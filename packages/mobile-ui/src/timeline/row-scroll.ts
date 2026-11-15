/**
 * Blind test round 3, item 8: with a clip selected, the lower part of the audio track was
 * cut by the bottom edge of the timeline, just above the clip-tools bar. When a clip is
 * selected, TimelineView scrolls the timeline VERTICALLY so that the whole track row of
 * the clip is in view. (The horizontal scroll is the playhead time, so it does not move.)
 *
 * Returns the scrollTop that shows the whole row, or null when the row is in view
 * already or the scroll cannot move. All values are px. `rowTop` and `rowBottom` are in
 * content coordinates (0 = the top of the scroll content); `topInset` is the part at the
 * top of the view that the sticky ruler covers.
 */
export function scrollTopToShowRow({
	scrollTop,
	viewHeight,
	contentHeight,
	rowTop,
	rowBottom,
	topInset = 0,
}: {
	scrollTop: number;
	viewHeight: number;
	contentHeight: number;
	rowTop: number;
	rowBottom: number;
	topInset?: number;
}): number | null {
	const maxScrollTop = Math.max(0, contentHeight - viewHeight);
	let target = scrollTop;
	// The bottom of the row is below the view: scroll down to it.
	if (rowBottom > target + viewHeight) target = rowBottom - viewHeight;
	// The top of the row is under the ruler or above the view: scroll up to it.
	if (rowTop - topInset < target) target = rowTop - topInset;
	target = Math.min(maxScrollTop, Math.max(0, target));
	return Math.abs(target - scrollTop) < 0.5 ? null : target;
}
