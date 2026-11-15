/**
 * Spawn transform for a duplicated visual element (round 19). Duplicate
 * stacks the copy on a NEW overlay track at the SAME time — with identical
 * params it renders pixel-for-pixel on top of the original, i.e. the
 * founder-reported "preview isn't even doing pic in pic": the copy WAS
 * there, just invisible. The common mobile-editor overlay-add answer: the copy lands
 * visibly as picture-in-picture — video/image at half its current scale,
 * everything nudged off-center — so it is immediately seen and grabbable
 * by the preview's direct-manipulation gesture.
 *
 * Pure and dependency-free (params in, params out) so it unit-tests
 * without the wasm runtime, same constraint as timeline/transitions.ts.
 */
import type { ParamValues } from "@/params";

/** Fraction of the canvas's short side the copy is nudged by. */
const PIP_NUDGE_FRACTION = 0.06;
/** Scale multiplier for full-frame media duplicates (video/image). */
const PIP_MEDIA_SCALE = 0.5;

export function pipSpawnParams({
	params,
	elementType,
	canvasWidth,
	canvasHeight,
}: {
	params: ParamValues;
	elementType: string;
	canvasWidth: number;
	canvasHeight: number;
}): ParamValues {
	const num = (key: string, fallback: number) => {
		const value = params[key];
		return typeof value === "number" && Number.isFinite(value) ? value : fallback;
	};

	const nudge = Math.min(canvasWidth, canvasHeight) * PIP_NUDGE_FRACTION;
	const next: ParamValues = {
		...params,
		"transform.positionX": num("transform.positionX", 0) + nudge,
		"transform.positionY": num("transform.positionY", 0) - nudge,
	};

	// Full-frame media would still cover most of the original at a nudge
	// alone — halve it so the stack reads as PiP at a glance. Sign is
	// preserved (a flipped clip stays flipped).
	if (elementType === "video" || elementType === "image") {
		next["transform.scaleX"] = num("transform.scaleX", 1) * PIP_MEDIA_SCALE;
		next["transform.scaleY"] = num("transform.scaleY", 1) * PIP_MEDIA_SCALE;
	}
	return next;
}
