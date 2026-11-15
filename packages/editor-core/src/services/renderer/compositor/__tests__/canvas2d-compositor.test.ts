import { describe, expect, test } from "bun:test";
import {
	CANVAS2D_BLEND_OPERATIONS,
	Canvas2dCompositor,
	type Canvas2dSurface,
} from "../canvas2d-compositor";
import type {
	FrameDescriptor,
	FrameItemDescriptor,
	QuadTransformDescriptor,
	TextureUploadDescriptor,
} from "../types";

type Call = {
	op: string;
	args: unknown[];
	alpha: number;
	composite: string;
	fill: string;
};

type FakeSurface = Canvas2dSurface & { calls: Call[]; label: string };

/** A 2D context that records what it is asked to draw. */
function fakeSurface({
	width,
	height,
	label,
}: {
	width: number;
	height: number;
	label: string;
}): FakeSurface {
	const calls: Call[] = [];
	let state = { globalAlpha: 1, globalCompositeOperation: "source-over", fillStyle: "" };
	const stack: (typeof state)[] = [];
	const record =
		(op: string) =>
		(...args: unknown[]) => {
			calls.push({
				op,
				args,
				alpha: state.globalAlpha,
				composite: state.globalCompositeOperation,
				fill: state.fillStyle,
			});
		};
	const context = {
		get globalAlpha() {
			return state.globalAlpha;
		},
		set globalAlpha(value: number) {
			state.globalAlpha = value;
		},
		get globalCompositeOperation() {
			return state.globalCompositeOperation;
		},
		set globalCompositeOperation(value: string) {
			state.globalCompositeOperation = value;
		},
		get fillStyle() {
			return state.fillStyle;
		},
		set fillStyle(value: string) {
			state.fillStyle = value;
		},
		save: () => {
			stack.push({ ...state });
		},
		restore: () => {
			state = stack.pop() ?? state;
		},
		setTransform: record("setTransform"),
		clearRect: record("clearRect"),
		fillRect: record("fillRect"),
		translate: record("translate"),
		rotate: record("rotate"),
		scale: record("scale"),
		drawImage: record("drawImage"),
	};
	return {
		canvas: { width, height, label } as unknown as Canvas2dSurface["canvas"],
		context: context as unknown as Canvas2dSurface["context"],
		calls,
		label,
	};
}

function fullCanvas(width: number, height: number): QuadTransformDescriptor {
	return {
		centerX: width / 2,
		centerY: height / 2,
		width,
		height,
		rotationDegrees: 0,
		flipX: false,
		flipY: false,
	};
}

function layer(
	overrides: Partial<Extract<FrameItemDescriptor, { type: "layer" }>> & { textureId: string },
): FrameItemDescriptor {
	return {
		type: "layer",
		transform: fullCanvas(100, 50),
		opacity: 1,
		blendMode: "normal",
		effectPassGroups: [],
		mask: null,
		...overrides,
	};
}

function setup() {
	const created: FakeSurface[] = [];
	const compositor = new Canvas2dCompositor({
		createSurface: ({ width, height }) => {
			const surface = fakeSurface({ width, height, label: `surface-${created.length}` });
			created.push(surface);
			return surface;
		},
	});
	const target = fakeSurface({ width: 100, height: 50, label: "target" });
	return { compositor, created, target };
}

const photo = { label: "photo" } as unknown as CanvasImageSource;

describe("Canvas2dCompositor", () => {
	test("paints the clear colour, then each layer with its opacity and blend mode", () => {
		const { compositor, created, target } = setup();
		let backgroundDraws = 0;
		const textures: TextureUploadDescriptor[] = [
			{
				kind: "rendered",
				id: "bg",
				contentHash: "bg:1",
				width: 100,
				height: 50,
				draw: () => {
					backgroundDraws += 1;
				},
			},
			{ kind: "external", id: "photo", source: photo, width: 40, height: 20 },
		];
		const frame: FrameDescriptor = {
			width: 100,
			height: 50,
			clear: { color: [0, 0, 0, 1] },
			items: [
				layer({ textureId: "bg" }),
				layer({
					textureId: "photo",
					opacity: 0.5,
					blendMode: "multiply",
					transform: { ...fullCanvas(100, 50), width: 20, height: 10 },
				}),
			],
		};

		compositor.render({ context: target.context, frame, textures });

		const fill = target.calls.find((call) => call.op === "fillRect");
		expect(fill?.fill).toBe("rgba(0, 0, 0, 1)");
		expect(fill?.args).toEqual([0, 0, 100, 50]);

		const draws = target.calls.filter((call) => call.op === "drawImage");
		expect(draws).toHaveLength(2);
		expect(draws[0].args).toEqual([created[0].canvas, 0, 0, 100, 50]);
		expect(draws[0].alpha).toBe(1);
		expect(draws[0].composite).toBe("source-over");
		expect(draws[1].args).toEqual([photo, 40, 20, 20, 10]);
		expect(draws[1].alpha).toBe(0.5);
		expect(draws[1].composite).toBe("multiply");
		expect(backgroundDraws).toBe(1);
	});

	test("redraws a rendered texture only when its content hash changes", () => {
		const { compositor, target } = setup();
		let draws = 0;
		const texture = (hash: string): TextureUploadDescriptor => ({
			kind: "rendered",
			id: "text",
			contentHash: hash,
			width: 100,
			height: 50,
			draw: () => {
				draws += 1;
			},
		});
		const frame: FrameDescriptor = {
			width: 100,
			height: 50,
			clear: { color: [0, 0, 0, 1] },
			items: [layer({ textureId: "text" })],
		};

		compositor.render({ context: target.context, frame, textures: [texture("a")] });
		compositor.render({ context: target.context, frame, textures: [texture("a")] });
		expect(draws).toBe(1);
		compositor.render({ context: target.context, frame, textures: [texture("b")] });
		expect(draws).toBe(2);
	});

	test("cuts a masked layer with destination-in, or destination-out when inverted", () => {
		for (const inverted of [false, true]) {
			const { compositor, created, target } = setup();
			const maskSource = { label: "mask" } as unknown as CanvasImageSource;
			const frame: FrameDescriptor = {
				width: 100,
				height: 50,
				clear: { color: [0, 0, 0, 1] },
				items: [
					layer({
						textureId: "photo",
						mask: { textureId: "mask", feather: 0, inverted },
					}),
				],
			};
			compositor.render({
				context: target.context,
				frame,
				textures: [
					{ kind: "external", id: "photo", source: photo, width: 40, height: 20 },
					{ kind: "external", id: "mask", source: maskSource, width: 100, height: 50 },
				],
			});

			const scratch = created[0];
			const scratchDraws = scratch.calls.filter((call) => call.op === "drawImage");
			expect(scratchDraws[0].args[0]).toBe(photo);
			expect(scratchDraws[1].args[0]).toBe(maskSource);
			expect(scratchDraws[1].composite).toBe(inverted ? "destination-out" : "destination-in");

			const targetDraws = target.calls.filter((call) => call.op === "drawImage");
			expect(targetDraws).toHaveLength(1);
			expect(targetDraws[0].args[0]).toBe(scratch.canvas);
		}
	});

	test("skips scene effects and layers without a texture", () => {
		const { compositor, target } = setup();
		const frame: FrameDescriptor = {
			width: 100,
			height: 50,
			clear: { color: [0, 0, 0, 1] },
			items: [{ type: "sceneEffect", effectPassGroups: [] }, layer({ textureId: "missing" })],
		};
		compositor.render({ context: target.context, frame, textures: [] });
		expect(target.calls.filter((call) => call.op === "drawImage")).toHaveLength(0);
	});

	test("maps every blend mode to a Canvas 2D operation", () => {
		expect(CANVAS2D_BLEND_OPERATIONS.normal).toBe("source-over");
		expect(CANVAS2D_BLEND_OPERATIONS["plus-lighter"]).toBe("lighter");
		expect(CANVAS2D_BLEND_OPERATIONS.screen).toBe("screen");
	});
});
