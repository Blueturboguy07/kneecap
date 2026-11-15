import { BaseNode } from "./base-node";
import type { TextElement } from "@/timeline";
import type { EffectPass } from "@/effects/types";
import type { BlendMode, Transform } from "@/rendering";
import { drawMeasuredTextLayout, strokeMeasuredTextLayout } from "@/text/primitives";
import type { MeasuredTextElement } from "@/text/measure-element";

export type TextNodeParams = TextElement & {
	transform: Transform;
	opacity: number;
	blendMode?: BlendMode;
	canvasCenter: { x: number; y: number };
	canvasHeight: number;
	textBaseline?: CanvasTextBaseline;
};

export interface ResolvedTextNodeState {
	transform: Transform;
	opacity: number;
	textColor: string;
	backgroundColor: string;
	/** Text border (round 31). `strokeWidth` is in FONT-SIZE units — the
	 *  draw scales it by scaledFontSize/fontSize so the border keeps the
	 *  same weight relative to the glyphs at every canvas size. 0 = off. */
	strokeColor: string;
	strokeWidth: number;
	effectPasses: EffectPass[][];
	measuredText: MeasuredTextElement;
}

export class TextNode extends BaseNode<TextNodeParams, ResolvedTextNodeState> {}

export function renderTextToContext({
	node,
	ctx,
}: {
	node: TextNode;
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}): void {
	const resolved = node.resolved;
	if (!resolved) {
		return;
	}

	const x = resolved.transform.position.x + node.params.canvasCenter.x;
	const y = resolved.transform.position.y + node.params.canvasCenter.y;
	const baseline = node.params.textBaseline ?? "middle";

	ctx.save();
	ctx.translate(x, y);
	ctx.scale(resolved.transform.scaleX, resolved.transform.scaleY);
	if (resolved.transform.rotate) {
		ctx.rotate((resolved.transform.rotate * Math.PI) / 180);
	}

	if (resolved.strokeWidth > 0) {
		// Border under the fill (the common stroke+fill model). strokeWidth is a
		// PERCENT of the font size — the unit CoreText's kCTStrokeWidth uses
		// in the export, so preview and export agree at any canvas size.
		const layout = resolved.measuredText;
		strokeMeasuredTextLayout({
			ctx,
			layout,
			strokeColor: resolved.strokeColor,
			strokeWidth: (resolved.strokeWidth / 100) * layout.scaledFontSize,
			textBaseline: baseline,
		});
	}

	drawMeasuredTextLayout({
		ctx,
		layout: resolved.measuredText,
		textColor: resolved.textColor,
		background: resolved.measuredText.resolvedBackground,
		backgroundColor: resolved.backgroundColor,
		textBaseline: baseline,
	});

	ctx.restore();
}
