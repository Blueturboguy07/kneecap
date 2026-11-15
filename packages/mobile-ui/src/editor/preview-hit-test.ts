/**
 * Preview hit-testing (round 18, founder: "it should just be able to be
 * moved from on top of the preview area") — which visual element is under a
 * touch point at the current playhead, TOPMOST first, so the preview
 * gesture layer can grab clips directly with no prior selection.
 *
 * Geometry mirrors the renderer's `computeVisualTransform`
 * (frame-descriptor.ts): contain-fit x clip scale, centered + position
 * offset, rotation — evaluated here as point-in-rotated-rect against the
 * BASE params transform (keyframed transform animations are ignored for
 * hit-testing; grabbing an animating clip snaps it to its base transform
 * on drag anyway, same trade the web handles make).
 *
 * Paint order (scene-builder.ts): tracks render `[...overlay, main]
 * .reverse()` bottom->top, so overlay[0] is TOPMOST — hit order here is
 * overlay[0..n], then main. Text/caption elements are not hit-testable
 * (their bounds come from measured text layout, unavailable here) — the
 * gesture layer keeps the selection-based fallback for those.
 */
import type { EditorCore, MediaAsset } from "@kneecap/editor-core";
import type { MediaTime } from "@kneecap/editor-core";
import type {
	ElementRef,
	SceneTracks,
	TimelineElement,
	TimelineTrack,
} from "@kneecap/editor-core/timeline";

// Deliberately dependency-free (type-only imports above): pulling
// editor-core's `/rendering` or `/graphics` modules loads the wasm binary
// transitively (animation -> wasm/media-time -> opencut-wasm), which cannot
// initialize under `bun test` — same constraint and same answer as
// timeline/transitions.ts. The two mirrored pieces below are stable public
// contracts, referenced to their canonical definitions:

/** Mirror of graphics/types.ts DEFAULT_GRAPHIC_SOURCE_SIZE. */
const GRAPHIC_SOURCE_SIZE = 512;

/** Mirror of rendering/index.ts `buildTransformFromParams` — same param
 *  keys, same fallbacks. */
function transformFromParams(params: TimelineElement["params"]) {
	const num = (key: string, fallback: number) => {
		const value = params[key];
		return typeof value === "number" && Number.isFinite(value) ? value : fallback;
	};
	return {
		scaleX: num("transform.scaleX", 1),
		scaleY: num("transform.scaleY", 1),
		position: { x: num("transform.positionX", 0), y: num("transform.positionY", 0) },
		rotate: num("transform.rotate", 0),
	};
}

export interface PreviewHit {
	ref: ElementRef;
	element: TimelineElement;
}

function sourceSizeFor({
	element,
	mediaById,
}: {
	element: TimelineElement;
	mediaById: Map<string, MediaAsset>;
}): { width: number; height: number } | null {
	if (element.type === "video" || element.type === "image") {
		const asset = mediaById.get(element.mediaId);
		if (!asset?.width || !asset?.height) return null;
		return { width: asset.width, height: asset.height };
	}
	if (element.type === "sticker") {
		if (!element.intrinsicWidth || !element.intrinsicHeight) return null;
		return { width: element.intrinsicWidth, height: element.intrinsicHeight };
	}
	if (element.type === "graphic") {
		return { width: GRAPHIC_SOURCE_SIZE, height: GRAPHIC_SOURCE_SIZE };
	}
	return null; // text/caption: not hit-testable here
}

/** Point-in-element test in canvas coordinates, mirroring
 *  computeVisualTransform's quad. */
export function pointInElement({
	element,
	mediaById,
	canvasWidth,
	canvasHeight,
	x,
	y,
	fallbackToFullFrame = true,
}: {
	element: TimelineElement;
	mediaById: Map<string, MediaAsset>;
	canvasWidth: number;
	canvasHeight: number;
	x: number;
	y: number;
	/** When true, an element whose source dimensions can't be resolved
	 *  (asset record without probe data, sticker without intrinsic dims)
	 *  tests against a full-frame quad instead of becoming untouchable.
	 *  `hitTestPreview` runs a PRECISE pass first with this off — caught
	 *  live in the web harness: a dimension-less sticker's full-frame
	 *  fallback quad stole every touch from the precisely-bounded elements
	 *  underneath it. */
	fallbackToFullFrame?: boolean;
}): boolean {
	let source = sourceSizeFor({ element, mediaById });
	if (
		!source &&
		fallbackToFullFrame &&
		(element.type === "video" ||
			element.type === "image" ||
			element.type === "sticker" ||
			element.type === "graphic")
	) {
		source = { width: canvasWidth, height: canvasHeight };
	}
	if (!source) return false;

	const transform = transformFromParams(element.params);
	const contain = Math.min(
		canvasWidth / source.width,
		canvasHeight / source.height,
	);
	const halfWidth = Math.abs(source.width * contain * transform.scaleX) / 2;
	const halfHeight = Math.abs(source.height * contain * transform.scaleY) / 2;
	if (halfWidth <= 0 || halfHeight <= 0) return false;

	const centerX = canvasWidth / 2 + transform.position.x;
	const centerY = canvasHeight / 2 + transform.position.y;

	// Rotate the point into the element's local frame (screen-space CW
	// rotation -> inverse rotate the point).
	const theta = (-transform.rotate * Math.PI) / 180;
	const dx = x - centerX;
	const dy = y - centerY;
	const localX = dx * Math.cos(theta) - dy * Math.sin(theta);
	const localY = dx * Math.sin(theta) + dy * Math.cos(theta);

	return Math.abs(localX) <= halfWidth && Math.abs(localY) <= halfHeight;
}

function elementActiveAt({
	element,
	timeTicks,
}: {
	element: TimelineElement;
	timeTicks: MediaTime;
}): boolean {
	if ("hidden" in element && element.hidden) return false;
	return (
		timeTicks >= element.startTime &&
		timeTicks < element.startTime + element.duration
	);
}

/**
 * Topmost visual element under (x, y) canvas coords at `timeTicks`, run
 * against the RENDER tracks (transition-derived timing == what is on
 * screen). The returned ref targets the nominal element (same ids), which
 * is what commands operate on. When the point is inside the currently
 * SELECTED element, that wins over anything stacked on top — a selected
 * clip must stay grabbable (common mobile-editor behavior).
 */
export function hitTestPreview({
	editor,
	x,
	y,
	timeTicks,
	canvasWidth,
	canvasHeight,
}: {
	editor: EditorCore;
	x: number;
	y: number;
	timeTicks: MediaTime;
	canvasWidth: number;
	canvasHeight: number;
}): PreviewHit | null {
	const tracks: SceneTracks | null =
		editor.timeline.getRenderTracks() ??
		editor.scenes.getActiveSceneOrNull()?.tracks ??
		null;
	if (!tracks) return null;

	const mediaById = new Map(
		editor.media.getAssets().map((asset) => [asset.id, asset]),
	);

	const test = (element: TimelineElement, fallbackToFullFrame: boolean) =>
		elementActiveAt({ element, timeTicks }) &&
		pointInElement({ element, mediaById, canvasWidth, canvasHeight, x, y, fallbackToFullFrame });

	// Selected element first: it stays grabbable under overlapping clips
	// (fallback allowed — a selected element may always be grabbed).
	const selected = editor.selection.getSelectedElements()[0];
	if (selected) {
		const track = findTrack({ tracks, trackId: selected.trackId });
		const element = track?.elements.find((el) => el.id === selected.elementId);
		if (element && test(element, true)) {
			return { ref: selected, element };
		}
	}

	// Topmost-first: overlay[0] paints last (see header), then down to main.
	// TWO passes: precise quads only, then (if nothing claimed the touch)
	// fallback full-frame quads for dimension-less elements — so a clip
	// with missing metadata stays grabbable without stealing touches from
	// precisely-bounded elements beneath it.
	const hitOrder: TimelineTrack[] = [...tracks.overlay, tracks.main];
	for (const fallbackToFullFrame of [false, true]) {
		for (const track of hitOrder) {
			if ("hidden" in track && track.hidden) continue;
			// Later elements within a track paint later; test them first.
			for (let i = track.elements.length - 1; i >= 0; i--) {
				const element = track.elements[i];
				if (test(element, fallbackToFullFrame)) {
					return { ref: { trackId: track.id, elementId: element.id }, element };
				}
			}
		}
	}
	return null;
}

function findTrack({
	tracks,
	trackId,
}: {
	tracks: SceneTracks;
	trackId: string;
}): TimelineTrack | null {
	if (tracks.main.id === trackId) return tracks.main;
	return (
		tracks.overlay.find((track) => track.id === trackId) ??
		tracks.audio.find((track) => track.id === trackId) ??
		null
	);
}
