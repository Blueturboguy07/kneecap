/**
 * Blind test round 4 (1.0.7, App Store simulator build): HIGH 1.
 *
 *   Changing the export resolution moved the stickers. Placed at 1080p; at
 *   720p both stickers sat about 1.5x farther from the centre, in the
 *   preview AND in the 720p video. Back at 1080p they returned.
 *
 *   Cause: positions are canvas pixels from the canvas centre
 *   (transform.positionX/Y), and sizes are relative (a scale over a
 *   contain-fit of the canvas; the text font follows the canvas height). The
 *   export sheet wrote the export resolution into the canvas size, so at
 *   720p the sizes shrank with the canvas but the pixel offsets did not.
 *
 *   Fix (1.0.8): the canvas is the layout space only. The export sheet sets
 *   `exportShortSide`; the canvas and the preview do not change. The export
 *   draws the same layout at the export size with one scale factor per axis:
 *   the EDL builder scales positions and position keyframes to output pixels
 *   (and sends the output size as meta.canvas, the case both native
 *   exporters place correctly), and the overlay frames (text, captions,
 *   stickers, graphics) are laid out on the canvas and drawn through one
 *   scale transform. The Aspect ratio sheet keeps the canvas short side.
 *
 * The pixels at 720p and 1080p, and the preview, are proven in the iOS CI job
 * (ios-sim-editor-test.py, test C). Run: bun test apps/mobile/test
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildEdl, type Edl, type EdlClip } from "../../../packages/editor-core/src/edl";
import { getExportScale, getExportSize } from "../../../packages/editor-core/src/edl/export-size";
import {
	buildFixtureMediaAssets,
	buildFixtureProject,
	buildFixtureScene,
	fixtureAssetResolver,
	FIXTURE_OUTPUT,
} from "../../../packages/editor-core/src/edl/__tests__/fixture";

const REPO = join(import.meta.dir, "../../..");

/** The code of a file without its comments. */
function codeOf(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function raw(rel: string): string {
	const path = join(REPO, rel);
	expect(existsSync(path)).toBe(true);
	return readFileSync(path, "utf8");
}

function code(rel: string): string {
	return codeOf(raw(rel));
}

function between(text: string, start: string, end: string): string {
	const from = text.indexOf(start);
	expect(from).toBeGreaterThanOrEqual(0);
	const to = text.indexOf(end, from + start.length);
	expect(to).toBeGreaterThan(from);
	return text.slice(from, to);
}

const OVERLAY = "packages/editor-core/src/export/overlay-frames.ts";
const BUILD = "packages/editor-core/src/edl/build.ts";
const SHEET = "packages/mobile-ui/src/components/panels/export-sheet.tsx";
const ACTIONS = "packages/mobile-ui/src/editor/actions.ts";
const SHELL = "packages/mobile-ui/src/components/editor/editor-shell.tsx";
const IOS = "apps/mobile/ios/App/App/NativeExport";
const ANDROID = "apps/mobile/android/app/src/main/java/dev/kneecap/app/export";

describe("HIGH 1: the export size is its own setting, and the canvas stays", () => {
	const settings = (width: number, height: number, exportShortSide?: number) => ({
		canvasSize: { width, height },
		exportShortSide,
	});

	it("getExportSize keeps the canvas aspect at the chosen short side", () => {
		expect(getExportSize({ settings: settings(1920, 1080) })).toEqual({ width: 1920, height: 1080 });
		expect(getExportSize({ settings: settings(1920, 1080, 1080) })).toEqual({ width: 1920, height: 1080 });
		expect(getExportSize({ settings: settings(1920, 1080, 720) })).toEqual({ width: 1280, height: 720 });
		expect(getExportSize({ settings: settings(1920, 1080, 2160) })).toEqual({ width: 3840, height: 2160 });
		expect(getExportSize({ settings: settings(1080, 1920, 720) })).toEqual({ width: 720, height: 1280 });
		expect(getExportSize({ settings: settings(1080, 1350, 720) })).toEqual({ width: 720, height: 900 });
		expect(getExportSize({ settings: settings(1280, 720, 1080) })).toEqual({ width: 1920, height: 1080 });
		// A value that is not usable gives the canvas.
		expect(getExportSize({ settings: settings(1920, 1080, Number.NaN) })).toEqual({ width: 1920, height: 1080 });
		expect(getExportSize({ settings: settings(1920, 1080, 0) })).toEqual({ width: 1920, height: 1080 });
	});

	it("getExportScale is output pixels per canvas pixel", () => {
		expect(getExportScale({ canvasSize: { width: 1920, height: 1080 }, outputSize: { width: 1280, height: 720 } })).toEqual({
			x: 2 / 3,
			y: 2 / 3,
		});
		expect(getExportScale({ canvasSize: { width: 1920, height: 1080 }, outputSize: { width: 1920, height: 1080 } })).toEqual({ x: 1, y: 1 });
		expect(getExportScale({ canvasSize: { width: 0, height: 1080 }, outputSize: { width: 1280, height: 720 } })).toEqual({ x: 1, y: 1 });
	});

	it("the export sheet sets the export size, never the canvas", () => {
		const sheet = code(SHEET);
		const apply = between(sheet, "const applyResolution = ", "const applyFps = ");
		expect(apply).toContain("setExportResolution({ editor, shortSide: preset.height });");
		expect(apply).not.toContain("setProjectResolution");
		expect(apply).not.toContain("canvasSize");
		expect(sheet).not.toContain("setProjectResolution");
		// The sheet opens on the export size, not on the canvas size.
		expect(sheet).toContain("const exportSize = getExportSize({ settings: project.settings });");
		const actions = code(ACTIONS);
		const setExport = between(actions, "export function setExportResolution(", "\n}\n");
		expect(setExport).toContain("new UpdateProjectSettingsCommand({ exportShortSide: shortSide })");
		expect(setExport).not.toContain("canvasSize");
		expect(code("packages/editor-core/src/project/types.ts")).toContain("exportShortSide?: number;");
	});

	it("the export gets the export size, and the overlay frames lay out on the canvas", () => {
		const sheet = code(SHEET);
		const build = between(sheet, "const buildCurrentEdl = ", "const saveExportToPhotos = ");
		expect(build).toContain("resolution: getExportSize({ settings: current.settings }),");
		const overlay = between(sheet, "overlayFrames = await renderOverlayFrames({", "});");
		expect(overlay).toContain("width: edl.output.resolution.width,");
		expect(overlay).toContain("layoutSize: editor.project.getActive().settings.canvasSize,");
	});

	it("the top-bar chip shows the export size; the Aspect ratio sheet keeps the canvas short side", () => {
		const shell = code(SHELL);
		expect(shell).toContain("resolutionLabel={resolutionLabelFor(getExportSize({ settings }))}");
		expect(shell).not.toContain("resolutionLabelFor(settings.canvasSize)");
		expect(shell).toContain("onClick={() => setProjectAspectRatio({ editor, ratio: { width: preset.width, height: preset.height } })}");
		expect(shell).not.toContain("setProjectResolution");
		const actions = code(ACTIONS);
		const aspect = between(actions, "export function setProjectAspectRatio(", "\n}\n");
		expect(aspect).toContain("canvasSizeForAspect({ shortSide: Math.min(width, height), ratio })");
	});

	it("an aspect ratio at a 1080 short side gives the same canvas sizes as before", () => {
		// actions.ts imports the whole editor; the pure helper is checked by its source and by a copy of its math.
		const actions = code(ACTIONS);
		const helper = between(actions, "export function canvasSizeForAspect(", "\n}\n");
		expect(helper).toContain("ratio.width >= ratio.height");
		const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
		const forAspect = (shortSide: number, w: number, h: number) =>
			w >= h ? { width: even((shortSide * w) / h), height: shortSide } : { width: shortSide, height: even((shortSide * h) / w) };
		expect(forAspect(1080, 1080, 1920)).toEqual({ width: 1080, height: 1920 });
		expect(forAspect(1080, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
		expect(forAspect(1080, 1080, 1080)).toEqual({ width: 1080, height: 1080 });
		expect(forAspect(1080, 1080, 1350)).toEqual({ width: 1080, height: 1350 });
		expect(forAspect(720, 1920, 1080)).toEqual({ width: 1280, height: 720 });
	});
});

describe("HIGH 1: the EDL goes out in output pixels", () => {
	/** The fixture (canvas 1080x1920), with a text at (300, -200) and a
	 *  bezier keyframe channel on transform.positionX. */
	function scene() {
		const s = buildFixtureScene();
		const text = s.tracks.overlay[0].elements[0] as {
			params: Record<string, unknown>;
			animations?: Record<string, unknown>;
		};
		text.params["transform.positionX"] = 300;
		text.animations = {
			...(text.animations ?? {}),
			"transform.positionX": {
				keys: [
					{ id: "px-1", time: 0, value: 300, segmentToNext: "bezier", tangentMode: "free", rightHandle: { dt: 1000, dv: 90 } },
					{ id: "px-2", time: 60_000, value: -150, segmentToNext: "linear", tangentMode: "free", leftHandle: { dt: -1000, dv: -30 } },
				],
				extrapolation: { before: "hold", after: "hold" },
			},
		};
		return s;
	}

	function edlAt(resolution?: { width: number; height: number }): Edl {
		return buildEdl({
			project: buildFixtureProject(),
			scene: scene() as never,
			mediaAssets: buildFixtureMediaAssets(),
			output: { ...FIXTURE_OUTPUT, ...(resolution ? { resolution } : {}) },
			resolveAsset: fixtureAssetResolver,
		});
	}

	const textClip = (edl: Edl): EdlClip => {
		const clip = edl.tracks.flatMap((t) => t.clips).find((c) => c.kind === "text");
		expect(clip).toBeDefined();
		return clip as EdlClip;
	};

	it("at the canvas size nothing changes (canvas pixels, meta.canvas = canvas)", () => {
		const edl = edlAt();
		expect(edl.meta.canvas).toEqual({ width: 1080, height: 1920 });
		expect(edl.output.resolution).toEqual({ width: 1080, height: 1920 });
		const clip = textClip(edl);
		expect(clip.transform.positionX).toBe(300);
		expect(clip.transform.positionY).toBe(-200);
		// An explicit resolution equal to the canvas gives the same document.
		expect(JSON.stringify(edlAt({ width: 1080, height: 1920 }))).toBe(JSON.stringify(edl));
	});

	it("at 720p every position is scaled by 720/1080, so its place in the frame is the same", () => {
		const full = edlAt();
		const small = edlAt({ width: 720, height: 1280 });
		const k = 720 / 1080;
		expect(small.output.resolution).toEqual({ width: 720, height: 1280 });
		// Both native exporters place against meta.canvas = the output size.
		expect(small.meta.canvas).toEqual({ width: 720, height: 1280 });
		const a = textClip(full);
		const b = textClip(small);
		expect(b.transform.positionX).toBeCloseTo(300 * k, 9);
		expect(b.transform.positionY).toBeCloseTo(-200 * k, 9);
		// The same fraction of the frame from the centre.
		expect(b.transform.positionX / small.meta.canvas.width).toBeCloseTo(a.transform.positionX / full.meta.canvas.width, 9);
		expect(b.transform.positionY / small.meta.canvas.height).toBeCloseTo(a.transform.positionY / full.meta.canvas.height, 9);
		// Sizes, rotation and opacity have no pixel unit: unchanged.
		expect(b.transform.scaleX).toBe(a.transform.scaleX);
		expect(b.transform.scaleY).toBe(a.transform.scaleY);
		expect(b.transform.rotateDegrees).toBe(a.transform.rotateDegrees);
		expect(b.opacity).toBe(a.opacity);
		// The params copy says the same as the transform.
		expect(b.params["transform.positionX"]).toBeCloseTo(300 * k, 9);
		expect(b.params["transform.positionY"]).toBeCloseTo(-200 * k, 9);
		expect(b.params.fontSize).toBe(a.params.fontSize);
	});

	it("position keyframes and their bezier handles scale too; other channels do not", () => {
		const k = 720 / 1080;
		const small = textClip(edlAt({ width: 720, height: 1280 }));
		const full = textClip(edlAt());
		const px = small.animations.find((c) => c.propertyPath === "transform.positionX");
		expect(px).toBeDefined();
		expect(px?.keyframes.map((key) => key.value)).toEqual([300 * k, -150 * k]);
		expect(px?.keyframes[0].rightHandle).toEqual({ dtTicks: 1000, dv: 90 * k });
		expect(px?.keyframes[1].leftHandle).toEqual({ dtTicks: -1000, dv: -30 * k });
		const opacitySmall = small.animations.find((c) => c.propertyPath === "opacity");
		const opacityFull = full.animations.find((c) => c.propertyPath === "opacity");
		expect(opacitySmall).toEqual(opacityFull);
	});

	it("the builder scales positions only through one factor per axis", () => {
		const build = code(BUILD);
		expect(build).toContain("const spatial = getExportScale({");
		expect(build).toContain("const canvas = isIdentityScale(spatial) ? projectCanvas : outputResolution;");
		expect(build).toContain('if (propertyPath === "transform.positionX") return spatial.x;');
		expect(build).toContain('if (propertyPath === "transform.positionY") return spatial.y;');
	});
});

describe("HIGH 1: the overlay frames lay out on the canvas and draw at the export size", () => {
	it("resolve and layout use the canvas; one scale transform maps it to the output", () => {
		const overlay = code(OVERLAY);
		expect(overlay).toContain("const layout = layoutSize ?? canvasSize;");
		expect(overlay).toContain("const drawScale = getExportScale({ canvasSize: layout, outputSize: canvasSize });");
		const renderer = between(overlay, "const renderer = new CanvasRenderer({", "});");
		expect(renderer).toContain("width: layout.width,");
		expect(renderer).toContain("height: layout.height,");
		const scene = between(overlay, "const tree = buildScene({", "});");
		expect(scene).toContain("canvasSize: layout,");
		const draw = between(overlay, "if (hash !== \"\") {", "pngBase64 = await toPngBase64");
		expect(draw).toContain("surface.ctx.clearRect(0, 0, canvasSize.width, canvasSize.height);");
		expect(draw).toContain("surface.ctx.setTransform(drawScale.x, 0, 0, drawScale.y, 0, 0);");
		expect(draw.indexOf("setTransform(drawScale.x")).toBeLessThan(draw.indexOf("drawOverlayNode("));
	});

	it("no drawing code resets the transform or uses a pixel blur the transform would not scale", () => {
		for (const rel of [
			OVERLAY,
			"packages/editor-core/src/services/renderer/nodes/text-node.ts",
			"packages/editor-core/src/services/renderer/nodes/caption-node.ts",
			"packages/editor-core/src/text/primitives.ts",
		]) {
			const src = code(rel).replace(/surface\.ctx\.setTransform\([^)]*\);/g, "");
			expect(src).not.toMatch(/\bsetTransform\(|resetTransform\(|shadowBlur|\.filter\s*=/);
		}
	});
});

describe("HIGH 1: both native exporters place positions in the size the EDL names", () => {
	it("iOS adds positions to the output render size; Android divides by meta.canvas", () => {
		expect(code(`${IOS}/TransitionCompositor.swift`)).toContain("let centerX = renderSize.width / 2 + CGFloat(placement.transform.positionX)");
		expect(code(`${IOS}/VideoCompositionBuilder.swift`)).toContain("width: edl.output.resolution.width,");
		const effect = code(`${ANDROID}/EdlTransformEffect.kt`);
		expect(effect).toContain("(2.0 * transform.positionX / canvasWidth)");
		expect(code(`${ANDROID}/EdlToComposition.kt`)).toContain("canvasWidth = edl.meta.canvasWidth,");
		// So the builder must send output pixels with meta.canvas = output (checked above).
	});
});

describe("1.0.8: one version everywhere", () => {
	it("iOS, Android and the publik gate say 1.0.8, build 10", () => {
		const pbx = raw("apps/mobile/ios/App/App.xcodeproj/project.pbxproj");
		expect([...pbx.matchAll(/MARKETING_VERSION = ([0-9.]+);/g)].map((m) => m[1])).toEqual(["1.0.8", "1.0.8"]);
		expect([...pbx.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => m[1])).toEqual(["10", "10"]);
		const gradle = raw("apps/mobile/android/app/build.gradle");
		expect(/versionCode (\d+)/.exec(gradle)?.[1]).toBe("10");
		expect(/versionName "([^"]+)"/.exec(gradle)?.[1]).toBe("1.0.8");
		expect(raw("apps/mobile/src/publik/publik.ts")).toContain('export const APP_VERSION = "1.0.8";');
	});
});
