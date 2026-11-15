/**
 * Blind test round 4, HIGH 1: renderOverlayFrames RUNS with a recording
 * canvas in place of OffscreenCanvas (bun has no canvas). The text of the EDL
 * fixture (canvas 1080x1920, text at (0, -200)) is drawn for a 720x1280
 * export: the PNG is 720x1280, the base transform is 2/3, and the text is
 * laid out in canvas units (centre (540, 960) + position), the same numbers
 * the preview uses. Run: bun test apps/mobile/test
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { renderOverlayFrames } from "../../../packages/editor-core/src/export/overlay-frames";
import { buildFixtureScene } from "../../../packages/editor-core/src/edl/__tests__/fixture";

type Call = { op: string; args: unknown[] };

class RecordingContext {
	calls: Call[] = [];
	font = "10px sans-serif";
	textBaseline = "alphabetic";
	textAlign = "left";
	fillStyle: unknown = "#000";
	strokeStyle: unknown = "#000";
	lineWidth = 1;
	lineJoin = "miter";
	globalAlpha = 1;
	letterSpacing = "0px";
	globalCompositeOperation = "source-over";
	constructor(readonly canvas: RecordingCanvas) {}
	private rec(op: string, args: unknown[]) {
		this.calls.push({ op, args });
	}
	save() { this.rec("save", []); }
	restore() { this.rec("restore", []); }
	setTransform(...args: number[]) { this.rec("setTransform", args); }
	translate(...args: number[]) { this.rec("translate", args); }
	scale(...args: number[]) { this.rec("scale", args); }
	rotate(...args: number[]) { this.rec("rotate", args); }
	clearRect(...args: number[]) { this.rec("clearRect", args); }
	fillRect(...args: number[]) { this.rec("fillRect", args); }
	fillText(...args: unknown[]) { this.rec("fillText", args); }
	strokeText(...args: unknown[]) { this.rec("strokeText", args); }
	beginPath() {}
	closePath() {}
	moveTo() {}
	lineTo() {}
	arcTo() {}
	arc() {}
	quadraticCurveTo() {}
	bezierCurveTo() {}
	rect() {}
	roundRect() {}
	fill() { this.rec("fill", []); }
	stroke() {}
	clip() {}
	drawImage(...args: unknown[]) { this.rec("drawImage", args); }
	measureText(text: string) {
		const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10);
		return {
			width: text.length * size * 0.5,
			actualBoundingBoxAscent: size * 0.7,
			actualBoundingBoxDescent: size * 0.2,
			actualBoundingBoxLeft: 0,
			actualBoundingBoxRight: text.length * size * 0.5,
			fontBoundingBoxAscent: size * 0.8,
			fontBoundingBoxDescent: size * 0.2,
		};
	}
}

class RecordingCanvas {
	static all: RecordingCanvas[] = [];
	readonly ctx: RecordingContext;
	constructor(public width: number, public height: number) {
		this.ctx = new RecordingContext(this);
		RecordingCanvas.all.push(this);
	}
	getContext() {
		return this.ctx;
	}
	async convertToBlob() {
		return new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
	}
}

const saved = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
beforeAll(() => {
	(globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = RecordingCanvas;
});
afterAll(() => {
	(globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = saved;
});

describe("HIGH 1: the overlay frames run at the export size with the canvas layout", () => {
	it("a 720x1280 export of a 1080x1920 canvas draws the text in canvas units under a 2/3 transform", async () => {
		const scene = buildFixtureScene();
		const tracks = { ...scene.tracks, main: { ...scene.tracks.main, elements: [] } };
		const TPS = 120_000;
		const frames = await renderOverlayFrames({
			tracks: tracks as never,
			mediaAssets: [],
			canvasSize: { width: 720, height: 1280 },
			layoutSize: { width: 1080, height: 1920 },
			fps: { numerator: 2, denominator: 1 } as never,
			durationTicks: 1 * TPS,
			ticksPerSecond: TPS,
		});
		expect(frames.length).toBeGreaterThan(0);
		const surface = RecordingCanvas.all.find((c) => c.width === 720 && c.height === 1280);
		expect(surface).toBeDefined();
		const calls = surface?.ctx.calls ?? [];
		const firstScale = calls.findIndex((c) => c.op === "setTransform" && c.args[0] !== 1);
		expect(firstScale).toBeGreaterThanOrEqual(0);
		expect(calls[firstScale].args).toEqual([2 / 3, 0, 0, 2 / 3, 0, 0]);
		const clear = calls.findIndex((c) => c.op === "clearRect");
		expect(calls[clear].args).toEqual([0, 0, 720, 1280]);
		expect(clear).toBeLessThan(firstScale);
		// The text's own placement, in canvas units: centre (540, 960) + (0, -200).
		const move = calls.slice(firstScale).find((c) => c.op === "translate");
		expect(move?.args).toEqual([540, 760]);
		expect(calls.slice(firstScale).some((c) => c.op === "fillText" && c.args[0] === "kneecap")).toBe(true);
	});
});
