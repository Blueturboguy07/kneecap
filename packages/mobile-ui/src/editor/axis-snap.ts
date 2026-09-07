/**
 * Centre-axis snapping for preview drags.
 *
 * `transform.positionX/Y` are an OFFSET FROM THE CANVAS CENTRE in canvas
 * units (`frame-descriptor.ts`: `centerX = renderer.width / 2 +
 * position.x`), so "snap to the central axes" is literally "snap the value
 * to 0" on each axis independently. There is no geometry to compute, which
 * is why this module is 60 lines of decision and no maths.
 *
 * Three properties make snapping feel like a physical detent rather than a
 * glitch, and all three are easy to leave out:
 *
 *  1. HYSTERESIS. Capture and release are DIFFERENT distances. With one
 *     threshold, a finger held near the boundary flickers the element in
 *     and out of the snap every frame, because the position that snapping
 *     produces is itself inside the capture zone. Two thresholds — grab
 *     close, let go far — is the same Schmitt trigger the audio gate uses
 *     for exactly the same reason. Release is ~2.3x capture here: enough
 *     that escaping is a deliberate movement, not so much that the element
 *     feels stuck to a wall.
 *
 *  2. PER-AXIS INDEPENDENCE. X and Y snap separately. This is what "drag
 *     ALONG the axis" means: once the element is on the vertical centre
 *     line, sliding a finger up and down changes only Y, and X stays
 *     pinned at 0 because its own perpendicular distance never grew. Snap
 *     the pair as a single 2D point and the element pops off the line the
 *     moment you move along it — the opposite of what is wanted.
 *
 *  3. THE ELEMENT LEAVES THE FINGER. While snapped, the element sits at 0
 *     while the finger is somewhere up to `release` away. That divergence
 *     IS the feedback: it is what makes the detent visible, and trying to
 *     keep the element under the finger at all times is what makes snapping
 *     feel like drift instead.
 *
 * On thresholds: tldraw snaps at 8 screen px (mouse). Touch needs more,
 * because a fingertip contact patch is several millimetres wide and the
 * reported point wanders inside it. 12 CSS px capture is roughly that
 * wander, and it is deliberately kept SMALL rather than generous — a wide
 * capture zone is the "action at a distance" failure that makes it
 * impossible to park something just slightly off centre, which is the main
 * complaint against naive snapping. Small capture + firm hold is the
 * combination that reads as helpful instead of pushy.
 *
 * Thresholds are in CSS PIXELS and converted by the caller, so the snap
 * feels identical no matter how large the preview is drawn or what
 * resolution the project is.
 */

/** Distance within which an unsnapped axis is captured, in CSS pixels. */
export const SNAP_CAPTURE_PX = 12;

/** Distance beyond which a snapped axis is released, in CSS pixels. */
export const SNAP_RELEASE_PX = 28;

export interface AxisSnapFlags {
	x: boolean;
	y: boolean;
}

export const NO_SNAP: AxisSnapFlags = { x: false, y: false };

/**
 * One axis of the Schmitt trigger.
 *
 * `capture` and `release` are in the same units as `value` — canvas units
 * at the call site, CSS pixels in the tests. Passing `release < capture`
 * would reintroduce the flicker this exists to prevent, so it is clamped
 * rather than trusted.
 */
export function snapAxisValue({
	value,
	wasSnapped,
	capture,
	release,
}: {
	value: number;
	wasSnapped: boolean;
	capture: number;
	release: number;
}): { value: number; snapped: boolean } {
	const hold = Math.max(capture, release);
	const distance = Math.abs(value);
	if (wasSnapped) {
		return distance > hold
			? { value, snapped: false }
			: { value: 0, snapped: true };
	}
	return distance <= capture ? { value: 0, snapped: true } : { value, snapped: false };
}

/**
 * Snap a preview position to the canvas's centre axes.
 *
 * `capture`/`release` are in CANVAS UNITS: the caller scales the CSS-pixel
 * constants above by however many canvas units one CSS pixel currently
 * covers.
 */
export function snapToCenterAxes({
	x,
	y,
	wasSnapped,
	capture,
	release,
}: {
	x: number;
	y: number;
	wasSnapped: AxisSnapFlags;
	capture: number;
	release: number;
}): { x: number; y: number; snapped: AxisSnapFlags } {
	const snappedX = snapAxisValue({
		value: x,
		wasSnapped: wasSnapped.x,
		capture,
		release,
	});
	const snappedY = snapAxisValue({
		value: y,
		wasSnapped: wasSnapped.y,
		capture,
		release,
	});
	return {
		x: snappedX.value,
		y: snappedY.value,
		snapped: { x: snappedX.snapped, y: snappedY.snapped },
	};
}

/**
 * A short tick when an axis first grabs, so the detent is felt and not only
 * seen.
 *
 * `navigator.vibrate` is Android-only — WKWebView does not implement it, so
 * iOS gets the guide line alone until `@capacitor/haptics` is added. Doing
 * nothing on iOS is the correct degradation: the visual guide is the
 * primary feedback on both platforms, and this is the bonus.
 */
export function pulseSnapHaptic(): void {
	if (typeof navigator === "undefined") return;
	const vibrate = (navigator as Navigator & { vibrate?: (p: number) => boolean })
		.vibrate;
	if (typeof vibrate !== "function") return;
	try {
		vibrate.call(navigator, 8);
	} catch {
		// A vibration is never worth breaking a drag over.
	}
}
