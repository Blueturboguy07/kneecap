import type { BlendMode } from "@/rendering";
import { createCanvasSurface } from "../canvas-utils";
import type {
	FrameDescriptor,
	QuadTransformDescriptor,
	RenderedTextureDescriptor,
	TextureUploadDescriptor,
} from "./types";

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A canvas and its 2D context. An OffscreenCanvas in the app; a fake in tests. */
export type Canvas2dSurface = {
	canvas: CanvasImageSource & { width: number; height: number };
	context: Context2D;
};

export type CreateCanvas2dSurface = (size: {
	width: number;
	height: number;
}) => Canvas2dSurface;

/** Canvas 2D names for the engine's blend modes. */
export const CANVAS2D_BLEND_OPERATIONS: Record<BlendMode, GlobalCompositeOperation> = {
	normal: "source-over",
	darken: "darken",
	multiply: "multiply",
	"color-burn": "color-burn",
	lighten: "lighten",
	screen: "screen",
	"plus-lighter": "lighter",
	"color-dodge": "color-dodge",
	overlay: "overlay",
	"soft-light": "soft-light",
	"hard-light": "hard-light",
	difference: "difference",
	exclusion: "exclusion",
	hue: "hue",
	saturation: "saturation",
	color: "color",
	luminosity: "luminosity",
};

type RenderedEntry = { surface: Canvas2dSurface; contentHash: string };

/**
 * Draws a frame descriptor with plain Canvas 2D. The renderer uses it when
 * the GPU is not available, so photos, text, stickers and video frames still
 * show. It draws each layer with its transform, opacity, blend mode and mask.
 * GPU effect passes, scene effects and mask feather are skipped.
 */
export class Canvas2dCompositor {
	private readonly createSurface: CreateCanvas2dSurface;
	private rendered = new Map<string, RenderedEntry>();
	private layerSurface: Canvas2dSurface | null = null;

	constructor({
		createSurface = createCanvasSurface,
	}: { createSurface?: CreateCanvas2dSurface } = {}) {
		this.createSurface = createSurface;
	}

	render({
		context,
		frame,
		textures,
	}: {
		context: Context2D;
		frame: FrameDescriptor;
		textures: TextureUploadDescriptor[];
	}): void {
		const sources = this.syncTextures(textures);
		const { width, height } = frame;

		context.save();
		context.setTransform(1, 0, 0, 1, 0, 0);
		context.globalAlpha = 1;
		context.globalCompositeOperation = "source-over";
		context.clearRect(0, 0, width, height);
		context.fillStyle = clearColorToCss(frame.clear.color);
		context.fillRect(0, 0, width, height);

		for (const item of frame.items) {
			// Scene effects need the GPU.
			if (item.type !== "layer") continue;
			const source = sources.get(item.textureId);
			if (!source) continue;
			const mask = item.mask ? sources.get(item.mask.textureId) : undefined;

			context.globalAlpha = clampOpacity(item.opacity);
			context.globalCompositeOperation =
				CANVAS2D_BLEND_OPERATIONS[item.blendMode] ?? "source-over";
			if (item.mask && mask) {
				const masked = this.drawMaskedLayer({
					source,
					transform: item.transform,
					mask,
					inverted: item.mask.inverted,
					width,
					height,
				});
				context.drawImage(masked, 0, 0, width, height);
			} else {
				drawQuad({ context, source, transform: item.transform });
			}
		}
		context.restore();
	}

	private syncTextures(
		textures: TextureUploadDescriptor[],
	): Map<string, CanvasImageSource> {
		const sources = new Map<string, CanvasImageSource>();
		const liveRenderedIds = new Set<string>();
		for (const texture of textures) {
			if (texture.kind === "external") {
				sources.set(texture.id, texture.source);
				continue;
			}
			liveRenderedIds.add(texture.id);
			sources.set(texture.id, this.syncRenderedTexture(texture).surface.canvas);
		}
		for (const id of [...this.rendered.keys()]) {
			if (!liveRenderedIds.has(id)) this.rendered.delete(id);
		}
		return sources;
	}

	/** Redraws a rendered texture only when its content hash or size changed. */
	private syncRenderedTexture(texture: RenderedTextureDescriptor): RenderedEntry {
		const previous = this.rendered.get(texture.id);
		const sameSize =
			previous !== undefined &&
			previous.surface.canvas.width === texture.width &&
			previous.surface.canvas.height === texture.height;
		if (previous && sameSize && previous.contentHash === texture.contentHash) {
			return previous;
		}

		const surface =
			previous && sameSize
				? previous.surface
				: this.createSurface({ width: texture.width, height: texture.height });
		const ctx = surface.context;
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, texture.width, texture.height);
		texture.draw(ctx);
		ctx.restore();

		const entry: RenderedEntry = { surface, contentHash: texture.contentHash };
		this.rendered.set(texture.id, entry);
		return entry;
	}

	/** Draws one layer into a canvas-size scratch canvas and cuts it with the
	 *  mask (the mask textures are canvas-size, in canvas coordinates). */
	private drawMaskedLayer({
		source,
		transform,
		mask,
		inverted,
		width,
		height,
	}: {
		source: CanvasImageSource;
		transform: QuadTransformDescriptor;
		mask: CanvasImageSource;
		inverted: boolean;
		width: number;
		height: number;
	}): CanvasImageSource {
		let layer = this.layerSurface;
		if (!layer || layer.canvas.width !== width || layer.canvas.height !== height) {
			layer = this.createSurface({ width, height });
			this.layerSurface = layer;
		}
		const ctx = layer.context;
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = "source-over";
		ctx.clearRect(0, 0, width, height);
		drawQuad({ context: ctx, source, transform });
		ctx.globalCompositeOperation = inverted ? "destination-out" : "destination-in";
		ctx.drawImage(mask, 0, 0, width, height);
		ctx.restore();
		return layer.canvas;
	}
}

/** Same quad placement as the GPU compositor: centre, size, rotation, flips. */
function drawQuad({
	context,
	source,
	transform,
}: {
	context: Context2D;
	source: CanvasImageSource;
	transform: QuadTransformDescriptor;
}): void {
	const x = transform.centerX - transform.width / 2;
	const y = transform.centerY - transform.height / 2;
	const flipX = transform.flipX ? -1 : 1;
	const flipY = transform.flipY ? -1 : 1;
	context.save();
	if (transform.rotationDegrees !== 0 || flipX !== 1 || flipY !== 1) {
		context.translate(transform.centerX, transform.centerY);
		context.rotate((transform.rotationDegrees * Math.PI) / 180);
		context.scale(flipX, flipY);
		context.translate(-transform.centerX, -transform.centerY);
	}
	context.drawImage(source, x, y, transform.width, transform.height);
	context.restore();
}

function clampOpacity(opacity: number): number {
	return Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
}

function clearColorToCss([r, g, b, a]: [number, number, number, number]): string {
	const channel = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255);
	return `rgba(${channel(r)}, ${channel(g)}, ${channel(b)}, ${Math.min(1, Math.max(0, a))})`;
}
