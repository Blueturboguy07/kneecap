/**
 * Reads a `CaptionElement`'s `params` bag into a typed style struct. One
 * place that knows the caption param keys (`params/registry.ts`'s
 * `captionElementParams`) so the renderer node, `preview/element-bounds.ts`,
 * and any future style-panel UI never hand-roll their own param reads and
 * drift from each other or from the registry's defaults.
 */
import type { CaptionElement } from "@/timeline/types";
import type { CaptionAnimationStyle, CaptionPosition } from "@/captions/styles";

export interface ResolvedCaptionStyle {
	fontFamily: string;
	fontSize: number;
	fontWeight: "normal" | "bold";
	color: string;
	highlightColor: string;
	strokeColor: string;
	strokeWidth: number;
	backgroundEnabled: boolean;
	backgroundColor: string;
	activeWordBackgroundEnabled: boolean;
	activeWordBackgroundColor: string;
	position: CaptionPosition;
	uppercase: boolean;
	animationStyle: CaptionAnimationStyle;
}

function readString({
	params,
	key,
	fallback,
}: {
	params: CaptionElement["params"];
	key: string;
	fallback: string;
}): string {
	const value = params[key];
	return typeof value === "string" ? value : fallback;
}

function readNumber({
	params,
	key,
	fallback,
}: {
	params: CaptionElement["params"];
	key: string;
	fallback: number;
}): number {
	const value = params[key];
	return typeof value === "number" ? value : fallback;
}

function readBoolean({
	params,
	key,
	fallback,
}: {
	params: CaptionElement["params"];
	key: string;
	fallback: boolean;
}): boolean {
	const value = params[key];
	return typeof value === "boolean" ? value : fallback;
}

export function resolveCaptionStyle({
	element,
}: {
	element: CaptionElement;
}): ResolvedCaptionStyle {
	const { params } = element;
	const fontWeightRaw = params.fontWeight;
	const positionRaw = params.position;
	const animationStyleRaw = params.animationStyle;

	return {
		fontFamily: readString({ params, key: "fontFamily", fallback: "Arial" }),
		fontSize: readNumber({ params, key: "fontSize", fallback: 22 }),
		fontWeight: fontWeightRaw === "bold" ? "bold" : "normal",
		color: readString({ params, key: "color", fallback: "#ffffff" }),
		highlightColor: readString({ params, key: "highlightColor", fallback: "#FFDE59" }),
		strokeColor: readString({ params, key: "strokeColor", fallback: "#000000" }),
		strokeWidth: readNumber({ params, key: "strokeWidth", fallback: 6 }),
		backgroundEnabled: readBoolean({ params, key: "background.enabled", fallback: false }),
		backgroundColor: readString({ params, key: "background.color", fallback: "#000000" }),
		activeWordBackgroundEnabled: readBoolean({
			params,
			key: "activeWordBackground.enabled",
			fallback: false,
		}),
		activeWordBackgroundColor: readString({
			params,
			key: "activeWordBackground.color",
			fallback: "#FFDE59",
		}),
		position:
			positionRaw === "top" || positionRaw === "center" || positionRaw === "bottom"
				? positionRaw
				: "bottom",
		uppercase: readBoolean({ params, key: "uppercase", fallback: false }),
		animationStyle:
			animationStyleRaw === "karaoke" ||
			animationStyleRaw === "pop" ||
			animationStyleRaw === "none"
				? animationStyleRaw
				: "karaoke",
	};
}
