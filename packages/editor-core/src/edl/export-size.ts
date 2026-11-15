/**
 * The export size of a project, and the one scale factor from the canvas to
 * it (1.0.8, blind test round 4, HIGH 1).
 *
 * Until 1.0.8 the mobile export sheet wrote the export resolution into the
 * project's `canvasSize`. Positions are canvas pixels from the canvas centre
 * (`transform.positionX/Y`), so at 720p every sticker and text sat 1.5x
 * farther from the centre than at 1080p, in the preview and in the video.
 *
 * Now the canvas is the layout space only. It does not change with the export
 * resolution, so the preview does not change either. The export draws the
 * same layout at the export size: every spatial value is multiplied by
 * `getExportScale` (one factor per axis; the export keeps the canvas aspect,
 * so the two factors differ only by the even-pixel rounding).
 */
import type { TCanvasSize, TProjectSettings } from "@/project/types";

/** Video encoders need even dimensions. */
function even(value: number): number {
	return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * The size of the exported video. `exportShortSide` is the short side
 * ("1080p" is 1920x1080 on a landscape canvas and 1080x1920 on a portrait
 * one). Without it, or when it equals the canvas short side, the export size
 * is the canvas size.
 */
export function getExportSize({
	settings,
}: {
	settings: Pick<TProjectSettings, "canvasSize" | "exportShortSide">;
}): TCanvasSize {
	const { width, height } = settings.canvasSize;
	const shortSide = settings.exportShortSide;
	if (
		typeof shortSide !== "number" ||
		!Number.isFinite(shortSide) ||
		shortSide <= 0 ||
		!(width > 0) ||
		!(height > 0)
	) {
		return { width, height };
	}
	const short = Math.round(shortSide);
	if (short === Math.min(width, height)) return { width, height };
	const aspect = width / height;
	return aspect >= 1
		? { width: even(short * aspect), height: short }
		: { width: short, height: even(short / aspect) };
}

/** Output pixels per canvas pixel, per axis. `{ x: 1, y: 1 }` when the
 *  output is the canvas size (or a size is not usable). */
export function getExportScale({
	canvasSize,
	outputSize,
}: {
	canvasSize: TCanvasSize;
	outputSize: TCanvasSize;
}): { x: number; y: number } {
	const ok = (v: number) => Number.isFinite(v) && v > 0;
	if (
		!ok(canvasSize.width) ||
		!ok(canvasSize.height) ||
		!ok(outputSize.width) ||
		!ok(outputSize.height)
	) {
		return { x: 1, y: 1 };
	}
	return {
		x: outputSize.width / canvasSize.width,
		y: outputSize.height / canvasSize.height,
	};
}
