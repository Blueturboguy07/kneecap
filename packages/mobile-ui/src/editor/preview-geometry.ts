/**
 * Blind test round 4 (1.0.8), items 2 and 3: the pure geometry of the preview gestures.
 *
 * - Item 2: which element is under a touch. The order is the order in which the preview
 *   draws (scene-builder.ts `buildScene`): the main track at the bottom, then the overlay
 *   tracks from the last one to overlay[0], and caption tracks on top of all. In a track,
 *   a later element draws on top.
 * - Item 3a: the scale of a new sticker, so that it comes in at about 30% of the frame
 *   width.
 * - Item 3b: the corner handles and the rotate handle of the selected element, and the
 *   scale and rotation that a handle drag gives.
 *
 * All values are canvas pixels with the origin at the top-left of the canvas. An element
 * position is still `transform.positionX/Y` from the canvas centre, and its size is still
 * the element scale over the contain-fit of its source (frame-descriptor.ts
 * `computeVisualTransform`). This file only reads those units.
 *
 * Only type imports: a runtime import of editor-core loads the wasm module, which cannot
 * start under `bun test` (the same rule as preview-hit-test.ts).
 */
import type { SceneTracks, TimelineElement, TimelineTrack } from "@kneecap/editor-core/timeline";

/** The shape of editor-core's `ElementBounds` (preview/element-bounds.ts): the centre, the
 *  drawn width and height, and the rotation in degrees (clockwise on the screen). */
export interface PreviewBounds {
	cx: number;
	cy: number;
	width: number;
	height: number;
	rotation: number;
}

export interface PreviewPoint {
	x: number;
	y: number;
}

// ------------------------------------------------------------- item 2: pick --

/** True when the point is in the rotated rectangle of the bounds. A negative width or
 *  height (a flipped element) is the same rectangle. */
export function pointInBounds({ bounds, x, y }: { bounds: PreviewBounds; x: number; y: number }): boolean {
	const halfWidth = Math.abs(bounds.width) / 2;
	const halfHeight = Math.abs(bounds.height) / 2;
	if (!(halfWidth > 0) || !(halfHeight > 0)) return false;
	const theta = (bounds.rotation * Math.PI) / 180;
	const dx = x - bounds.cx;
	const dy = y - bounds.cy;
	// Inverse of the rotation in element-bounds.ts getCornerPosition.
	const localX = dx * Math.cos(theta) + dy * Math.sin(theta);
	const localY = -dx * Math.sin(theta) + dy * Math.cos(theta);
	return Math.abs(localX) <= halfWidth && Math.abs(localY) <= halfHeight;
}

/** One element that the preview draws, with its bounds. */
export interface PaintedElement {
	trackId: string;
	elementId: string;
	/** True for a caption: the preview draws caption tracks on top of all other tracks. */
	isCaption: boolean;
	bounds: PreviewBounds;
}

/**
 * The elements from the top-most to the bottom-most. `bottomToTop` is in the order of
 * editor-core `getVisibleElementsWithBounds` (main track first, then overlay[n-1] ...
 * overlay[0]; in a track, by start time). The captions move to the top, in the same
 * order, as `buildScene` does with caption tracks.
 */
export function paintOrderTopFirst<T extends PaintedElement>(bottomToTop: readonly T[]): T[] {
	const others = bottomToTop.filter((item) => !item.isCaption);
	const captions = bottomToTop.filter((item) => item.isCaption);
	return [...others, ...captions].reverse();
}

/** The top-most element under the point, or null when the point is on empty canvas. */
export function topmostElementAt<T extends PaintedElement>({
	bottomToTop,
	x,
	y,
}: {
	bottomToTop: readonly T[];
	x: number;
	y: number;
}): T | null {
	for (const item of paintOrderTopFirst(bottomToTop)) {
		if (pointInBounds({ bounds: item.bounds, x, y })) return item;
	}
	return null;
}

/** A touch point on the preview mount (CSS px, client coordinates) in canvas pixels. */
export function clientToCanvas({
	clientX,
	clientY,
	rect,
	canvasWidth,
	canvasHeight,
}: {
	clientX: number;
	clientY: number;
	rect: { left: number; top: number; width: number; height: number };
	canvasWidth: number;
	canvasHeight: number;
}): PreviewPoint | null {
	if (!(rect.width > 0) || !(rect.height > 0)) return null;
	return {
		x: ((clientX - rect.left) * canvasWidth) / rect.width,
		y: ((clientY - rect.top) * canvasHeight) / rect.height,
	};
}

// ----------------------------------------------------- item 3a: new stickers --

/** The source size of the bundled flag images: every flag-icons SVG in
 *  apps/mobile/public/flags has viewBox="0 0 640 480" (round-2-assets.test.ts). */
export const FLAG_STICKER_SOURCE = { width: 640, height: 480 } as const;
/** The source size of a shape tile: editor-core draws it on a square canvas of
 *  DEFAULT_GRAPHIC_SOURCE_SIZE (512) px (graphics `buildGraphicPreviewUrl`). */
export const SHAPE_STICKER_SOURCE = { width: 512, height: 512 } as const;
/** Width of a new sticker, as a fraction of the frame width. */
export const NEW_STICKER_WIDTH_FRACTION = 0.3;
/** A new sticker is never taller than this fraction of the frame height (a square shape on
 *  a 16:9 frame would otherwise fill more than half of the height). */
export const NEW_STICKER_MAX_HEIGHT_FRACTION = 0.5;

/**
 * The source size of a sticker. `known` is true when the size is the real size of the
 * image (the element's own intrinsic size, or a bundled flag or shape). Other providers get
 * a safe square, `known: false`: the renderer then keeps the image's natural size.
 */
export function stickerSourceSize({
	stickerId,
	intrinsicWidth,
	intrinsicHeight,
}: {
	stickerId: string;
	intrinsicWidth?: number;
	intrinsicHeight?: number;
}): { width: number; height: number; known: boolean } {
	if (
		typeof intrinsicWidth === "number" &&
		typeof intrinsicHeight === "number" &&
		intrinsicWidth > 0 &&
		intrinsicHeight > 0 &&
		Number.isFinite(intrinsicWidth) &&
		Number.isFinite(intrinsicHeight)
	) {
		return { width: intrinsicWidth, height: intrinsicHeight, known: true };
	}
	const provider = stickerId.slice(0, Math.max(0, stickerId.indexOf(":"))).trim().toLowerCase();
	if (provider === "flags") return { ...FLAG_STICKER_SOURCE, known: true };
	if (provider === "shapes") return { ...SHAPE_STICKER_SOURCE, known: true };
	return { ...SHAPE_STICKER_SOURCE, known: false };
}

/**
 * The uniform `transform.scaleX/Y` that gives a new sticker a drawn width of
 * `widthFraction` of the frame width (no more than `maxHeightFraction` of the frame height).
 * The drawn size is source x contain-fit x scale (computeVisualTransform). A source size of
 * 0, below 0 or not finite (an SVG that reports no natural size) uses a square.
 */
export function newStickerScale({
	canvasWidth,
	canvasHeight,
	sourceWidth,
	sourceHeight,
	widthFraction = NEW_STICKER_WIDTH_FRACTION,
	maxHeightFraction = NEW_STICKER_MAX_HEIGHT_FRACTION,
}: {
	canvasWidth: number;
	canvasHeight: number;
	sourceWidth: number;
	sourceHeight: number;
	widthFraction?: number;
	maxHeightFraction?: number;
}): number {
	if (!(canvasWidth > 0) || !(canvasHeight > 0)) return 1;
	const valid = sourceWidth > 0 && sourceHeight > 0 && Number.isFinite(sourceWidth) && Number.isFinite(sourceHeight);
	const width = valid ? sourceWidth : 1;
	const height = valid ? sourceHeight : 1;
	const contain = Math.min(canvasWidth / width, canvasHeight / height);
	const fitWidth = width * contain;
	const fitHeight = height * contain;
	const scale = Math.min((widthFraction * canvasWidth) / fitWidth, (maxHeightFraction * canvasHeight) / fitHeight);
	return Math.round(scale * 10000) / 10000;
}

/**
 * The scene tracks with the bundled source size on each flag or shape sticker that has no
 * intrinsic size (stickers added before 1.0.8). The renderer draws such a sticker at its
 * image's natural size (640 x 480 or 512 x 512), but editor-core's element-bounds.ts uses a
 * 200 x 200 square for it; with this copy the hit test and the handles match the drawing.
 * Tracks and elements that need no change are the same objects.
 */
export function withStickerSourceSizes({ tracks }: { tracks: SceneTracks }): SceneTracks {
	const fix = <T extends TimelineTrack>(track: T): T => {
		let changed = false;
		const elements = track.elements.map((element) => {
			if (element.type !== "sticker" || (element.intrinsicWidth && element.intrinsicHeight)) return element;
			const source = stickerSourceSize({ stickerId: element.stickerId });
			if (!source.known) return element;
			changed = true;
			return { ...element, intrinsicWidth: source.width, intrinsicHeight: source.height };
		});
		return changed ? ({ ...track, elements } as T) : track;
	};
	const main = fix(tracks.main);
	const overlay = tracks.overlay.map(fix);
	if (main === tracks.main && overlay.every((track, index) => track === tracks.overlay[index])) return tracks;
	return { ...tracks, main, overlay };
}

/** The scene tracks with one element only (the selected one), so that the bounds of the
 *  selection do not measure every text on each frame. */
export function tracksWithOnlyElement({
	tracks,
	trackId,
	elementId,
}: {
	tracks: SceneTracks;
	trackId: string;
	elementId: string;
}): SceneTracks {
	const keep = <T extends TimelineTrack>(track: T): T =>
		({
			...track,
			elements: track.id === trackId ? track.elements.filter((element) => element.id === elementId) : [],
		}) as T;
	return {
		...tracks,
		main: keep(tracks.main),
		overlay: tracks.overlay.map(keep),
		audio: [],
	};
}

// --------------------------------------------------------- item 3b: handles --

export type HandleCorner = "top-left" | "top-right" | "bottom-right" | "bottom-left";
export const HANDLE_CORNERS: readonly HandleCorner[] = ["top-left", "top-right", "bottom-right", "bottom-left"];

/**
 * True when the selected element gets resize and rotate handles in the preview: a sticker,
 * a shape (graphic), a text, or a picture-in-picture clip (a video or image on an overlay
 * track). The main-track media and captions have no handles (captions move as one; pinch
 * still works on all of them).
 */
export function elementHasHandles({
	element,
	isMainTrack,
}: {
	element: Pick<TimelineElement, "type">;
	isMainTrack: boolean;
}): boolean {
	switch (element.type) {
		case "sticker":
		case "graphic":
		case "text":
			return true;
		case "video":
		case "image":
			return !isMainTrack;
		default:
			return false;
	}
}

/** A point of the element's own frame (origin at its centre, before rotation) on the
 *  canvas. */
function toCanvas({ bounds, localX, localY }: { bounds: PreviewBounds; localX: number; localY: number }): PreviewPoint {
	const theta = (bounds.rotation * Math.PI) / 180;
	const cos = Math.cos(theta);
	const sin = Math.sin(theta);
	return {
		x: bounds.cx + localX * cos - localY * sin,
		y: bounds.cy + localX * sin + localY * cos,
	};
}

export interface HandleLayout {
	corners: { corner: HandleCorner; x: number; y: number }[];
	rotate: { x: number; y: number; side: "top" | "bottom" };
}

/**
 * The canvas positions of the four corner handles and of the rotate handle. The corners
 * are the corners of the rotated element. The rotate handle is `rotateOffset` canvas px
 * out from the middle of the top edge; when that point is not on the canvas (the element
 * is at the top of the frame), it goes below the bottom edge, so that a person can reach it.
 */
export function selectionHandleLayout({
	bounds,
	canvasWidth,
	canvasHeight,
	rotateOffset,
}: {
	bounds: PreviewBounds;
	canvasWidth: number;
	canvasHeight: number;
	rotateOffset: number;
}): HandleLayout {
	const halfWidth = Math.abs(bounds.width) / 2;
	const halfHeight = Math.abs(bounds.height) / 2;
	const corners = HANDLE_CORNERS.map((corner) => {
		const localX = corner === "top-left" || corner === "bottom-left" ? -halfWidth : halfWidth;
		const localY = corner === "top-left" || corner === "top-right" ? -halfHeight : halfHeight;
		return { corner, ...toCanvas({ bounds, localX, localY }) };
	});
	const top = toCanvas({ bounds, localX: 0, localY: -(halfHeight + rotateOffset) });
	const onCanvas = top.x >= 0 && top.x <= canvasWidth && top.y >= 0 && top.y <= canvasHeight;
	const rotate = onCanvas
		? { ...top, side: "top" as const }
		: { ...toCanvas({ bounds, localX: 0, localY: halfHeight + rotateOffset }), side: "bottom" as const };
	return { corners, rotate };
}

/** Smallest drawn side (canvas px) that a corner drag can make. */
export const MIN_HANDLE_SIZE_PX = 16;

/**
 * Uniform resize about the centre: the factor is the finger's distance from the element
 * centre now over that distance when the drag started. The factor never makes the
 * shorter drawn side smaller than `minSizePx`.
 */
export function cornerResizeFactor({
	center,
	start,
	current,
	startWidth,
	startHeight,
	minSizePx = MIN_HANDLE_SIZE_PX,
}: {
	center: PreviewPoint;
	start: PreviewPoint;
	current: PreviewPoint;
	startWidth: number;
	startHeight: number;
	minSizePx?: number;
}): number {
	const startDistance = Math.hypot(start.x - center.x, start.y - center.y);
	if (!(startDistance > 1)) return 1;
	const factor = Math.hypot(current.x - center.x, current.y - center.y) / startDistance;
	const shortSide = Math.min(Math.abs(startWidth), Math.abs(startHeight));
	const minFactor = shortSide > 0 ? Math.min(1, minSizePx / shortSide) : 0;
	return Math.max(minFactor, factor);
}

/**
 * The rotation (degrees, clockwise on the screen) after a rotate-handle drag: the start
 * rotation plus the angle that the finger turned about the element centre. The turn is
 * taken in (-180, 180], so the element never jumps when the finger crosses the left side.
 */
export function handleRotation({
	center,
	start,
	current,
	startRotation,
}: {
	center: PreviewPoint;
	start: PreviewPoint;
	current: PreviewPoint;
	startRotation: number;
}): number {
	const from = Math.atan2(start.y - center.y, start.x - center.x);
	const to = Math.atan2(current.y - center.y, current.x - center.x);
	let turn = ((to - from) * 180) / Math.PI;
	while (turn > 180) turn -= 360;
	while (turn <= -180) turn += 360;
	return Math.round((startRotation + turn) * 100) / 100;
}
