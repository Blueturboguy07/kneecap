import type { TCanvasSize } from "@/project/types";

export const DEFAULT_CANVAS_PRESETS: TCanvasSize[] = [
	{ width: 1920, height: 1080 },
	{ width: 1080, height: 1920 },
	{ width: 1080, height: 1080 },
	{ width: 1440, height: 1080 },
];

export const DEFAULT_CANVAS_SIZE: TCanvasSize = { width: 1920, height: 1080 };

/**
 * Mobile-editor-style "original" aspect adoption: the FIRST visual asset imported
 * into a factory-default project decides the canvas aspect ratio, so a
 * portrait phone video gets a portrait canvas instead of being letterboxed
 * into the 1920x1080 default (and exports fill the frame instead of floating
 * in black — the preview/export both render the canvas, so the canvas IS the
 * output shape).
 *
 * Returns the canvas size to adopt, or null when nothing should change:
 *   - the user already made a canvas choice (mode !== "preset", or the size
 *     differs from the untouched factory default) — user intent always wins;
 *   - visual media already existed before this import — the project's aspect
 *     is established by the first visual asset only;
 *   - the imported batch has no video/image with usable dimensions.
 *
 * The adopted size preserves the asset's exact aspect, normalized to the
 * 1080p class (short side 1080, long side capped at 1920 for extreme
 * aspects) with even dimensions — encoder-friendly, and bounded so preview
 * rendering cost does not scale with source resolution (a 4K import must not
 * quadruple every preview frame; export picks its own resolution multiplier
 * in the export sheet).
 */
export function getAdoptedCanvasSizeForImportedMedia({
	currentSize,
	currentMode,
	hadVisualMediaBefore,
	importedAssets,
}: {
	currentSize: TCanvasSize;
	currentMode: "preset" | "custom" | undefined;
	hadVisualMediaBefore: boolean;
	importedAssets: Array<{
		type: string;
		width?: number;
		height?: number;
		/** True ORIGINAL dimensions — `width`/`height` are the preview
		 *  PROXY's for native imports. Adoption must size from the source
		 *  class: reading proxy dims made the "never upscale" guard pin a
		 *  4K import's canvas (and so every export) to 540p (the grainy-
		 *  export bug, 2026-08-22). */
		sourceWidth?: number;
		sourceHeight?: number;
	}>;
}): TCanvasSize | null {
	if (hadVisualMediaBefore) return null;
	if (currentMode !== undefined && currentMode !== "preset") return null;
	if (
		currentSize.width !== DEFAULT_CANVAS_SIZE.width ||
		currentSize.height !== DEFAULT_CANVAS_SIZE.height
	) {
		return null;
	}

	const first = importedAssets.find(
		(asset) =>
			(asset.type === "video" || asset.type === "image") &&
			((asset.sourceWidth ?? asset.width ?? 0) > 0) &&
			((asset.sourceHeight ?? asset.height ?? 0) > 0),
	);
	if (!first) return null;

	// Source dims when known (native imports store PROXY dims in
	// width/height); proxy/true dims share the aspect either way, but the
	// "never upscale" guard below needs the SOURCE's resolution class.
	const sourceWidth = (first.sourceWidth ?? first.width) as number;
	const sourceHeight = (first.sourceHeight ?? first.height) as number;

	const adopted = normalizeAdoptedCanvasSize({
		width: sourceWidth,
		height: sourceHeight,
	});
	if (
		adopted.width === currentSize.width &&
		adopted.height === currentSize.height
	) {
		return null; // already exactly the default shape — nothing to do
	}
	return adopted;
}

/**
 * The canonical "canvas from a source's dimensions" rule, shared by every
 * canvas-adoption path (this module's first-import adoption AND
 * InsertElementCommand's first-visual-element adoption — which used to
 * copy `asset.width×height` RAW, i.e. the 540p PROXY dims on mobile, so
 * every project's canvas and therefore every export was proxy-resolution;
 * the grainy-export root cause, 2026-08-22): preserve the aspect exactly,
 * normalize the short side to 1080 (never upscale a smaller source), cap
 * the long side at 1920 for extreme aspects, keep dimensions even.
 */
export function normalizeAdoptedCanvasSize({
	width,
	height,
}: {
	width: number;
	height: number;
}): TCanvasSize {
	const shortSide = Math.min(width, height);
	let scale = Math.min(1, 1080 / shortSide);
	const longSide = Math.max(width, height) * scale;
	if (longSide > 1920) {
		scale *= 1920 / longSide;
	}
	const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
	return { width: even(width * scale), height: even(height * scale) };
}
