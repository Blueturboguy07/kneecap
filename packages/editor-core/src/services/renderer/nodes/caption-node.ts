import { BaseNode } from "./base-node";
import type { CaptionElement, CaptionWord } from "@/timeline";
import type { EffectPass } from "@/effects/types";
import type { BlendMode, Transform } from "@/rendering";
import type { ResolvedCaptionStyle } from "@/captions/resolve-style";
import {
	CAPTION_POSITION_Y_FRACTION,
	measureCaptionLine,
	type CaptionMeasureContext,
	type MeasuredCaptionLine,
} from "@/captions/layout";

export type CaptionNodeParams = CaptionElement & {
	transform: Transform;
	opacity: number;
	blendMode?: BlendMode;
	canvasCenter: { x: number; y: number };
	canvasWidth: number;
	canvasHeight: number;
};

export interface ResolvedCaptionNodeState {
	/** Already includes the position-preset (top/center/bottom) baseline
	 * offset — see `resolveCaptionNode` in `../resolve.ts`. The render
	 * function below never re-derives it. */
	transform: Transform;
	opacity: number;
	style: ResolvedCaptionStyle;
	effectPasses: EffectPass[][];
	/** `null` when no word is visible at the current local time (e.g. the
	 * clip is trimmed to a span with no words in it). */
	line: MeasuredCaptionLine | null;
}

export class CaptionNode extends BaseNode<CaptionNodeParams, ResolvedCaptionNodeState> {}

function drawBackgroundPill({
	ctx,
	x,
	y,
	width,
	height,
	color,
	paddingX,
	paddingY,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	x: number;
	y: number;
	width: number;
	height: number;
	color: string;
	paddingX: number;
	paddingY: number;
}): void {
	const w = width + paddingX * 2;
	const h = height + paddingY * 2;
	const radius = Math.min(w, h) * 0.2;
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.roundRect(x - w / 2, y - h / 2, w, h, radius);
	ctx.fill();
}

export function renderCaptionToContext({
	node,
	ctx,
}: {
	node: CaptionNode;
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}): void {
	const resolved = node.resolved;
	if (!resolved || !resolved.line || resolved.line.words.length === 0) {
		return;
	}

	const { style, line } = resolved;
	const x = resolved.transform.position.x + node.params.canvasCenter.x;
	const y = resolved.transform.position.y + node.params.canvasCenter.y;

	ctx.save();
	ctx.globalAlpha = resolved.opacity;
	ctx.translate(x, y);
	ctx.scale(resolved.transform.scaleX, resolved.transform.scaleY);
	if (resolved.transform.rotate) {
		ctx.rotate((resolved.transform.rotate * Math.PI) / 180);
	}
	ctx.font = line.fontString;
	ctx.textAlign = "left";
	ctx.textBaseline = "middle";
	ctx.lineJoin = "round";
	ctx.lineCap = "round";

	const startX = -line.totalWidth / 2;

	if (style.backgroundEnabled) {
		drawBackgroundPill({
			ctx,
			x: 0,
			y: 0,
			width: line.totalWidth,
			height: line.totalHeight,
			color: style.backgroundColor,
			paddingX: line.scaledFontSize * 0.4,
			paddingY: line.scaledFontSize * 0.25,
		});
	}

	if (style.activeWordBackgroundEnabled) {
		const activeWord = line.words.find((w) => w.active);
		if (activeWord) {
			drawBackgroundPill({
				ctx,
				x: startX + activeWord.x + activeWord.width / 2,
				y: 0,
				width: activeWord.width,
				height: line.totalHeight * 0.75,
				color: style.activeWordBackgroundColor,
				paddingX: line.scaledFontSize * 0.22,
				paddingY: line.scaledFontSize * 0.12,
			});
		}
	}

	for (const word of line.words) {
		const wordX = startX + word.x;
		const fillColor = word.active ? style.highlightColor : style.color;

		if (style.strokeWidth > 0) {
			ctx.strokeStyle = style.strokeColor;
			ctx.lineWidth = style.strokeWidth;
			ctx.strokeText(word.text, wordX, 0);
		}

		ctx.fillStyle = fillColor;
		ctx.fillText(word.text, wordX, 0);
	}

	ctx.restore();
}

/** Exported for `preview/element-bounds.ts`, which needs the same baseline
 * math without duplicating it. */
export function captionPositionBaselineY({
	position,
	canvasHeight,
}: {
	position: ResolvedCaptionStyle["position"];
	canvasHeight: number;
}): number {
	return canvasHeight * CAPTION_POSITION_Y_FRACTION[position];
}

/** Exported so `resolve.ts` and `element-bounds.ts` share one measurement
 * call shape. */
export function measureVisibleCaptionLine({
	visibleWords,
	activeVisibleIndex,
	style,
	canvasHeight,
	ctx,
}: {
	visibleWords: CaptionWord[];
	activeVisibleIndex: number | null;
	style: ResolvedCaptionStyle;
	canvasHeight: number;
	ctx: CaptionMeasureContext;
}): MeasuredCaptionLine | null {
	if (visibleWords.length === 0) return null;
	return measureCaptionLine({
		words: visibleWords,
		activeIndex: activeVisibleIndex,
		uppercase: style.uppercase,
		fontFamily: style.fontFamily,
		fontSize: style.fontSize,
		fontWeight: style.fontWeight,
		canvasHeight,
		ctx,
	});
}
