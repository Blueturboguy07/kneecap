/**
 * Blind test round 4 (1.0.7, iPhone 17 Pro simulator): the editor UI fixes in 1.0.8
 * (items 2, 3a, 3b, 4, 9 and 10b). The static checks read the shipped files with the
 * comments taken out. The pure checks run the new geometry (preview-geometry.ts), the tap
 * rule (tap-slop.ts) and the effect preview (effect-previews.ts), and the item 4 check
 * computes the timeline height from the CSS values. Each check fails on the 1.0.7 source.
 *
 * Run: bun test apps/mobile/test
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../../..");

/** The code of a file without its comments (block comments, JSX comments and line comments). */
function codeOf(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}
function raw(path: string): string {
	return readFileSync(join(REPO, path), "utf8");
}
function code(path: string): string {
	return codeOf(raw(path));
}
/** The CSS of a file without its comments. */
function css(path: string): string {
	return raw(path).replace(/\/\*[\s\S]*?\*\//g, "");
}
/** The declarations of every rule whose selector list has exactly `selector`, in file order. */
function lastRule(sheet: string, selector: string): string {
	const blocks = [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) =>
		m[1]!.split(",").map((s) => s.trim()).includes(selector),
	);
	return blocks.map((m) => m[2]).join("\n");
}
/** The value of the last `prop` declaration in `rules` (the one that wins), or null. */
function lastValue(rules: string, prop: string): string | null {
	const values = [...rules.matchAll(new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+);`, "g"))].map((m) =>
		m[1]!.replace(/\s+/g, " ").trim(),
	);
	return values.length ? values[values.length - 1]! : null;
}
/** The value of a custom property in tokens.css, in px. */
function tokenPx(name: string): number {
	const match = new RegExp(`${name}:\\s*([0-9.]+)px;`).exec(raw("packages/mobile-ui/src/tokens.css"));
	expect(match).not.toBeNull();
	return Number(match![1]);
}
/** The body of the first `const <name> = ` / `function <name>(` in `source`, up to `end`. */
function sliceFrom(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	expect(from).toBeGreaterThanOrEqual(0);
	const to = source.indexOf(end, from + start.length);
	expect(to).toBeGreaterThan(from);
	return source.slice(from, to);
}

const SHEET = css("packages/mobile-ui/src/components.css");
const PREVIEW = code("packages/mobile-ui/src/components/editor/preview-renderer.tsx");
const GEOMETRY_PATH = "packages/mobile-ui/src/editor/preview-geometry.ts";

interface Bounds {
	cx: number;
	cy: number;
	width: number;
	height: number;
	rotation: number;
}
interface Painted {
	trackId: string;
	elementId: string;
	isCaption: boolean;
	bounds: Bounds;
}
type Geometry = {
	pointInBounds: (a: { bounds: Bounds; x: number; y: number }) => boolean;
	topmostElementAt: (a: { bottomToTop: Painted[]; x: number; y: number }) => Painted | null;
	clientToCanvas: (a: {
		clientX: number;
		clientY: number;
		rect: { left: number; top: number; width: number; height: number };
		canvasWidth: number;
		canvasHeight: number;
	}) => { x: number; y: number } | null;
	stickerSourceSize: (a: { stickerId: string; intrinsicWidth?: number; intrinsicHeight?: number }) => {
		width: number;
		height: number;
		known: boolean;
	};
	newStickerScale: (a: { canvasWidth: number; canvasHeight: number; sourceWidth: number; sourceHeight: number }) => number;
	elementHasHandles: (a: { element: { type: string }; isMainTrack: boolean }) => boolean;
	HANDLE_CORNERS: readonly string[];
	selectionHandleLayout: (a: { bounds: Bounds; canvasWidth: number; canvasHeight: number; rotateOffset: number }) => {
		corners: { corner: string; x: number; y: number }[];
		rotate: { x: number; y: number; side: "top" | "bottom" };
	};
	cornerResizeFactor: (a: {
		center: { x: number; y: number };
		start: { x: number; y: number };
		current: { x: number; y: number };
		startWidth: number;
		startHeight: number;
		minSizePx?: number;
	}) => number;
	handleRotation: (a: {
		center: { x: number; y: number };
		start: { x: number; y: number };
		current: { x: number; y: number };
		startRotation: number;
	}) => number;
};
const geometry = async () => (await import(join(REPO, GEOMETRY_PATH))) as Geometry;

/** The drawn width of a source on the canvas: source x contain-fit x scale (computeVisualTransform). */
function drawnSize({
	canvas,
	source,
	scale,
}: {
	canvas: { width: number; height: number };
	source: { width: number; height: number };
	scale: number;
}) {
	const contain = Math.min(canvas.width / source.width, canvas.height / source.height);
	return { width: source.width * contain * scale, height: source.height * contain * scale };
}

describe("item 2: a preview drag moves the element under the finger", () => {
	it("the touch picks the top-most element: later overlay tracks under earlier ones, captions on top of all", async () => {
		const { topmostElementAt } = await geometry();
		const full = { cx: 540, cy: 960, width: 1080, height: 1920, rotation: 0 };
		// The order of editor-core getVisibleElementsWithBounds: main, overlay[n-1] ... overlay[0].
		const bottomToTop: Painted[] = [
			{ trackId: "main", elementId: "video", isCaption: false, bounds: full },
			{ trackId: "captions", elementId: "caption", isCaption: true, bounds: { cx: 540, cy: 1500, width: 800, height: 120, rotation: 0 } },
			{ trackId: "stickers", elementId: "flag", isCaption: false, bounds: { cx: 540, cy: 900, width: 324, height: 243, rotation: 0 } },
			{ trackId: "text", elementId: "title", isCaption: false, bounds: { cx: 540, cy: 960, width: 600, height: 100, rotation: 0 } },
		];
		// The text (the later element) is over the flag where they meet.
		expect(topmostElementAt({ bottomToTop, x: 540, y: 960 })?.elementId).toBe("title");
		// On the flag only: the flag, not the selected text (the 1.0.7 bug).
		expect(topmostElementAt({ bottomToTop, x: 540, y: 820 })?.elementId).toBe("flag");
		// A caption draws on top of all, even though its track comes first.
		const withSticker = [...bottomToTop, { trackId: "s2", elementId: "star", isCaption: false, bounds: { cx: 540, cy: 1500, width: 200, height: 200, rotation: 0 } }];
		expect(topmostElementAt({ bottomToTop: withSticker, x: 540, y: 1500 })?.elementId).toBe("caption");
		// Only the main video there.
		expect(topmostElementAt({ bottomToTop, x: 100, y: 100 })?.elementId).toBe("video");
		// Empty canvas: nothing.
		expect(topmostElementAt({ bottomToTop: bottomToTop.slice(1), x: 100, y: 100 })).toBeNull();
	});

	it("the hit test follows rotation, flips and the mount size", async () => {
		const { pointInBounds, clientToCanvas } = await geometry();
		const bar = { cx: 500, cy: 500, width: 400, height: 40, rotation: 90 };
		expect(pointInBounds({ bounds: bar, x: 500, y: 680 })).toBe(true);
		expect(pointInBounds({ bounds: bar, x: 680, y: 500 })).toBe(false);
		expect(pointInBounds({ bounds: { ...bar, rotation: 0, width: -400 }, x: 680, y: 500 })).toBe(true);
		// A 196 x 348.6 CSS px mount on a 1080 x 1920 canvas.
		const rect = { left: 103, top: 72, width: 196, height: 348.5 };
		const at = clientToCanvas({ clientX: 103 + 98, clientY: 72 + 348.5 / 4, rect, canvasWidth: 1080, canvasHeight: 1920 });
		expect(at!.x).toBeCloseTo(540, 6);
		expect(at!.y).toBeCloseTo(480, 6);
		expect(clientToCanvas({ clientX: 0, clientY: 0, rect: { ...rect, width: 0 }, canvasWidth: 1080, canvasHeight: 1920 })).toBeNull();
	});

	it("onPointerDown picks and selects the element under the finger before the selection-gated fallback", () => {
		expect(PREVIEW).toContain('import { getVisibleElementsWithBounds } from "@kneecap/editor-core/preview/element-bounds";');
		expect(raw("packages/editor-core/package.json")).toContain('"./preview/element-bounds": "./src/preview/element-bounds.ts"');
		const pick = sliceFrom(PREVIEW, "const pickElementAt = ", "const selectionIsManipulable");
		expect(pick).toContain("clientToCanvas({ clientX: point.x, clientY: point.y, rect, canvasWidth, canvasHeight })");
		expect(pick).toMatch(/topmostElementAt\(\{\s*bottomToTop: painted\.map\(\(item\) => \(\{ \.\.\.item, isCaption: item\.element\.type === "caption" \}\)\),/);
		const down = sliceFrom(PREVIEW, "const onPointerDown = ", "\treturn {\n");
		const picked = down.indexOf("const picked = pickElementAt(point);");
		const fallback = down.indexOf("if (selectionIsManipulable && selectedRef && selectedElement) {");
		expect(picked).toBeGreaterThan(0);
		expect(fallback).toBeGreaterThan(picked);
		const pickedBranch = down.slice(picked, fallback);
		expect(pickedBranch).toContain("selectElement({ editor, ref: picked.ref });");
		expect(pickedBranch).toMatch(/openSession\(\{\s*pointers: new Map\(\[\[event\.pointerId, point\]\]\),\s*element: picked\.element,\s*target: picked\.ref,/);
		// A second finger joins the pinch of the open session (unchanged).
		expect(down).toMatch(/existing\.pointers\.set\(event\.pointerId, point\);\s*reanchor\(existing\);/);
	});
});

describe("item 3a: a new sticker comes in centred, about 30% of the frame width", () => {
	it("the scale gives 30% of the frame width on portrait, landscape and square frames", async () => {
		const { newStickerScale, stickerSourceSize } = await geometry();
		const flag = stickerSourceSize({ stickerId: "flags:AL" });
		expect(flag).toEqual({ width: 640, height: 480, known: true });
		for (const canvas of [
			{ width: 1080, height: 1920 },
			{ width: 1920, height: 1080 },
			{ width: 1080, height: 1080 },
			{ width: 720, height: 1280 },
		]) {
			const scale = newStickerScale({ canvasWidth: canvas.width, canvasHeight: canvas.height, sourceWidth: 640, sourceHeight: 480 });
			const drawn = drawnSize({ canvas, source: flag, scale });
			expect(drawn.width / canvas.width).toBeCloseTo(0.3, 3);
		}
		// A square shape on a 9:16 frame: 30% of the width.
		const shape = stickerSourceSize({ stickerId: "shapes:star" });
		expect(shape).toEqual({ width: 512, height: 512, known: true });
		const portrait = { width: 1080, height: 1920 };
		const shapeScale = newStickerScale({ canvasWidth: 1080, canvasHeight: 1920, sourceWidth: 512, sourceHeight: 512 });
		expect(drawnSize({ canvas: portrait, source: shape, scale: shapeScale }).width).toBeCloseTo(324, 0);
		// On a 16:9 frame a square stays inside half of the frame height.
		const landscape = { width: 1920, height: 1080 };
		const wide = newStickerScale({ canvasWidth: 1920, canvasHeight: 1080, sourceWidth: 512, sourceHeight: 512 });
		expect(drawnSize({ canvas: landscape, source: shape, scale: wide }).height).toBeLessThanOrEqual(540 + 0.01);
	});

	it("a natural size of 0 or unknown falls back to 4:3 for flags and 1:1 for shapes", async () => {
		const { newStickerScale, stickerSourceSize } = await geometry();
		expect(stickerSourceSize({ stickerId: "flags:JP", intrinsicWidth: 0, intrinsicHeight: 0 })).toEqual({ width: 640, height: 480, known: true });
		expect(stickerSourceSize({ stickerId: "shapes:heart", intrinsicWidth: Number.NaN, intrinsicHeight: 10 })).toEqual({ width: 512, height: 512, known: true });
		expect(stickerSourceSize({ stickerId: "flags:JP", intrinsicWidth: 300, intrinsicHeight: 200 })).toEqual({ width: 300, height: 200, known: true });
		expect(stickerSourceSize({ stickerId: "emoji:smile" }).known).toBe(false);
		// A source size of 0 gives the square scale, never Infinity or NaN.
		const square = newStickerScale({ canvasWidth: 1080, canvasHeight: 1920, sourceWidth: 512, sourceHeight: 512 });
		expect(newStickerScale({ canvasWidth: 1080, canvasHeight: 1920, sourceWidth: 0, sourceHeight: 0 })).toBe(square);
		expect(Number.isFinite(square) && square > 0).toBe(true);
	});

	it("insertStickerElement centres the sticker and sets that scale (and the bundled source size)", () => {
		const actions = code("packages/mobile-ui/src/editor/actions.ts");
		const body = sliceFrom(actions, "export function insertStickerElement(", "\n}\n");
		expect(body).toContain("const source = stickerSourceSize({ stickerId });");
		expect(body).toContain("editor.project.getActive().settings.canvasSize");
		expect(body).toContain("newStickerScale({ canvasWidth, canvasHeight, sourceWidth: source.width, sourceHeight: source.height })");
		expect(body).toContain("source.known ? { intrinsicWidth: source.width, intrinsicHeight: source.height } : {}");
		expect(body).toMatch(/"transform\.positionX": 0,\s*"transform\.positionY": 0,\s*"transform\.scaleX": scale,\s*"transform\.scaleY": scale,/);
		// The params are set before the insert command takes the element.
		expect(body.indexOf('"transform.scaleY": scale')).toBeLessThan(body.indexOf("new InsertElementCommand("));
	});
});

describe("item 3b: corner handles (uniform resize about the centre) and a rotate handle", () => {
	it("stickers, shapes, text and picture-in-picture clips get handles; main media and captions do not", async () => {
		const { elementHasHandles } = await geometry();
		for (const type of ["sticker", "graphic", "text"]) expect(elementHasHandles({ element: { type }, isMainTrack: false })).toBe(true);
		expect(elementHasHandles({ element: { type: "video" }, isMainTrack: false })).toBe(true);
		expect(elementHasHandles({ element: { type: "image" }, isMainTrack: false })).toBe(true);
		expect(elementHasHandles({ element: { type: "video" }, isMainTrack: true })).toBe(false);
		expect(elementHasHandles({ element: { type: "caption" }, isMainTrack: false })).toBe(false);
	});

	it("the handles sit on the rotated corners, and the rotate handle stays on the canvas", async () => {
		const { selectionHandleLayout, HANDLE_CORNERS } = await geometry();
		expect([...HANDLE_CORNERS]).toEqual(["top-left", "top-right", "bottom-right", "bottom-left"]);
		const bounds = { cx: 540, cy: 960, width: 400, height: 200, rotation: 90 };
		const layout = selectionHandleLayout({ bounds, canvasWidth: 1080, canvasHeight: 1920, rotateOffset: 160 });
		const at = Object.fromEntries(layout.corners.map((c) => [c.corner, c]));
		// Turned 90° clockwise: the top-left corner goes to the top-right of the centre.
		expect(at["top-left"]!.x).toBeCloseTo(640, 6);
		expect(at["top-left"]!.y).toBeCloseTo(760, 6);
		expect(at["bottom-right"]!.x).toBeCloseTo(440, 6);
		expect(at["bottom-right"]!.y).toBeCloseTo(1160, 6);
		// The rotate handle is out from the middle of the (turned) top edge: to the right.
		expect(layout.rotate.side).toBe("top");
		expect(layout.rotate.x).toBeCloseTo(540 + 100 + 160, 6);
		expect(layout.rotate.y).toBeCloseTo(960, 6);
		// An element at the top of the frame: the rotate handle goes below it.
		const high = selectionHandleLayout({ bounds: { cx: 540, cy: 120, width: 400, height: 200, rotation: 0 }, canvasWidth: 1080, canvasHeight: 1920, rotateOffset: 160 });
		expect(high.rotate.side).toBe("bottom");
		expect(high.rotate.y).toBeCloseTo(120 + 100 + 160, 6);
	});

	it("a corner drag scales by the distance ratio from the centre, with a smallest size", async () => {
		const { cornerResizeFactor } = await geometry();
		const center = { x: 200, y: 400 };
		const start = { x: 260, y: 320 };
		// Twice as far from the centre (any direction): twice the size.
		expect(cornerResizeFactor({ center, start, current: { x: 320, y: 240 }, startWidth: 120, startHeight: 160 })).toBeCloseTo(2, 6);
		expect(cornerResizeFactor({ center, start, current: { x: 230, y: 360 }, startWidth: 120, startHeight: 160 })).toBeCloseTo(0.5, 6);
		// Through the centre: never below the smallest size (24 px on a 120 px short side).
		expect(cornerResizeFactor({ center, start, current: center, startWidth: 120, startHeight: 160, minSizePx: 24 })).toBeCloseTo(0.2, 6);
		// A start on the centre: no change.
		expect(cornerResizeFactor({ center, start: center, current: { x: 400, y: 400 }, startWidth: 120, startHeight: 160 })).toBe(1);
	});

	it("a rotate drag adds the turn about the centre, with no jump across the left side", async () => {
		const { handleRotation } = await geometry();
		const center = { x: 0, y: 0 };
		// From straight up to the right: +90° (clockwise on the screen, y down).
		expect(handleRotation({ center, start: { x: 0, y: -100 }, current: { x: 100, y: 0 }, startRotation: 15 })).toBe(105);
		expect(handleRotation({ center, start: { x: 0, y: -100 }, current: { x: -100, y: 0 }, startRotation: 0 })).toBe(-90);
		// Across the left side (from just above to just below the left): a small turn.
		expect(handleRotation({ center, start: { x: -100, y: -1 }, current: { x: -100, y: 1 }, startRotation: 0 })).toBeCloseTo(-1.15, 2);
	});

	it("the preview draws the selection box, four corner handles and one rotate handle, turned with the element", () => {
		const render = sliceFrom(PREVIEW, "function PreviewSelectionHandles(", "const ROTATE_HANDLE_OFFSET_CSS_PX = 30;");
		expect(render).toContain('className="cc-preview-selection"');
		expect(render).toContain("className={`cc-preview-handle cc-preview-handle--resize cc-preview-handle--${corner}`}");
		expect(render).toContain("data-handle={corner}");
		expect(render).toContain("className={`cc-preview-handle cc-preview-handle--rotate cc-preview-handle--rotate-${selection.layout.rotate.side}`}");
		expect(render).toContain('data-handle="rotate"');
		expect(render).toContain('beginHandleGesture({ event, kind: "resize", bounds: selection.bounds })');
		expect(render).toContain('beginHandleGesture({ event, kind: "rotate", bounds: selection.bounds })');
		expect(PREVIEW).toContain("transform: `translate(-50%, -50%) rotate(${rotation}deg)`,");
		expect(PREVIEW).toContain("elementHasHandles({ element: selectedElement, isMainTrack: tracks.main.id === selectedRef.trackId })");
		// Only the overlay follows the playhead (one re-render per playback tick), and only while it shows.
		expect(render).toContain("useCurrentTimeSeconds();");
		expect(sliceFrom(PREVIEW, "function PreviewRendererInner(", "function PreviewSelectionHandles(")).not.toContain("useCurrentTimeSeconds");
		expect(PREVIEW).toMatch(/\{showHandles && selectedRef && \(\s*<PreviewSelectionHandles/);
	});

	it("each handle is a touch target of at least 44 x 44 pt over the preview", () => {
		const handle = lastRule(SHEET, ".cc-preview-handle");
		expect(lastValue(handle, "width")).toBe("var(--cc-touch-target-ios)");
		expect(lastValue(handle, "height")).toBe("var(--cc-touch-target-ios)");
		expect(tokenPx("--cc-touch-target-ios")).toBeGreaterThanOrEqual(44);
		expect(lastValue(handle, "position")).toBe("absolute");
		expect(lastValue(handle, "touch-action")).toBe("none");
		// Over the snap guides (z-index 2) and the selection box.
		expect(Number(lastValue(handle, "z-index"))).toBeGreaterThan(Number(lastValue(lastRule(SHEET, ".cc-preview-selection"), "z-index")));
		expect(lastValue(lastRule(SHEET, ".cc-preview-selection"), "pointer-events")).toBe("none");
	});

	it("a handle drag is one gesture session: a preview per frame and one commit (one undo step); pinch stays", () => {
		// The gesture hook is the last function of the file.
		expect(PREVIEW.indexOf("function usePreviewTransformGesture(")).toBeGreaterThan(0);
		const hook = PREVIEW.slice(PREVIEW.indexOf("function usePreviewTransformGesture("));
		const begin = sliceFrom(hook, "beginHandleGesture: (", "onPointerMove:");
		expect(begin).toContain("event.stopPropagation();");
		expect(begin).toMatch(/openSession\(\{[\s\S]*?mode: kind,[\s\S]*?handle: \{/);
		expect(begin).toContain("mount.setPointerCapture(event.pointerId);");
		// The only writes of the gesture: previewElements per frame, commitPreview once at the end.
		expect(hook).not.toMatch(/command\.execute|updateElements\(|editor\.timeline\.update/);
		expect(hook.match(/editor\.timeline\.commitPreview\(\)/g)?.length).toBe(1);
		// Resize keeps the position and scales both axes by one factor; rotate writes only the rotation.
		expect(hook).toMatch(/scaleX: session\.anchorScaleX \* factor,\s*scaleY: session\.anchorScaleY \* factor,/);
		expect(hook).toMatch(/session\.mode === "rotate"\s*\?\s*\{ "transform\.rotate": current\.rotate \}/);
		expect(hook).toContain("values: { ...t.baseValues, ...transformPatch },");
		// Pinch: the distance ratio of two fingers, as before.
		expect(hook).toContain("distance / session.startDistance");
	});
});

describe("item 4: with a clip selected, every track row shows above the clip-tools bar", () => {
	it("a tap on the empty timeline clears the selection; a drag keeps it", async () => {
		const { isPastTapSlop, TAP_SLOP_PX } = (await import(join(REPO, "packages/mobile-ui/src/timeline/tap-slop.ts"))) as {
			isPastTapSlop: (a: { tap: { x: number; y: number }; event: { clientX: number; clientY: number }; slopPx?: number }) => boolean;
			TAP_SLOP_PX: number;
		};
		expect(TAP_SLOP_PX).toBe(8);
		expect(isPastTapSlop({ tap: { x: 100, y: 100 }, event: { clientX: 104, clientY: 105 } })).toBe(false);
		expect(isPastTapSlop({ tap: { x: 100, y: 100 }, event: { clientX: 100, clientY: 140 } })).toBe(true);

		const view = code("packages/mobile-ui/src/components/timeline/timeline-view.tsx");
		const content = sliceFrom(view, 'className="cc-timeline__content"', "<TimelineRuler");
		// The touch-down only notes the tap; the deselect is on the up-event of the same pointer, inside the slop.
		expect(sliceFrom(content, "onPointerDown={", "onPointerMove={")).not.toContain("setSelectedClipId(null)");
		const up = sliceFrom(content, "onPointerUp={", "onPointerCancel={");
		expect(up).toMatch(/if \(!tap \|\| tap\.pointerId !== event\.pointerId \|\| isPastTapSlop\(\{ tap, event \}\)\) return;\s*setSelectedClipId\(null\);\s*onClearSelection\?\.\(\);/);
		expect(content).toContain("onPointerDownCapture={() => {");
		// A scroll of the timeline is not a tap.
		expect(view).toMatch(/isProgrammaticScrollRef\.current = false;\s*return;\s*\}\s*clearTapRef\.current = null;/);
	});

	it("the timeline gives CSS its track count, and CSS computes the height of the whole stack", () => {
		const view = code("packages/mobile-ui/src/components/timeline/timeline-view.tsx");
		expect(view).toContain('"--cc-timeline-track-count": project.tracks.length,');
		expect(view).toContain('"--cc-timeline-extra-height": showAddAudio && onAddAudio ? "var(--cc-timeline-add-audio-height)" : "0px",');
		expect(view).toMatch(/className=\{`cc-timeline\$\{reorderSession \? " cc-timeline--reordering" : ""\}`\}\s*style=\{stackStyle\}/);
		// The parts of the stack, from the CSS.
		expect(lastValue(lastRule(SHEET, ".cc-timeline"), "padding-top")).toBe("var(--cc-timecode-row-height, 20px)");
		expect(lastValue(lastRule(SHEET, ".cc-timeline__ruler"), "border-bottom")).toMatch(/^1px solid /);
		expect(lastValue(lastRule(SHEET, ".cc-timeline__track-row"), "border-bottom")).toMatch(/^1px solid /);
		const addAudio = lastRule(SHEET, ".cc-timeline__add-audio");
		expect(lastValue(addAudio, "height")).toBe("34px");
		expect(lastValue(addAudio, "margin-top")).toBe("8px");
		expect(lastValue(lastRule(SHEET, ".cc-timeline"), "--cc-timeline-add-audio-height")).toBe("calc(34px + 8px)");
	});

	it("on an iPhone 17 Pro, 4 and 5 track rows fit fully above the bar (they were cut by 9 and 58 px)", () => {
		const timelineRule = lastRule(SHEET, ".cc-timeline");
		const stackFormula = lastValue(timelineRule, "--cc-timeline-stack-height");
		expect(stackFormula).not.toBeNull();
		const timecodeRow = 20;
		const ruler = tokenPx("--cc-ruler-height");
		const track = tokenPx("--cc-track-height");
		/** Evaluates the CSS calc() of the stack height for `tracks` rows (no "+ Add audio"). */
		const stackHeight = (tracks: number) => {
			const expression = stackFormula!
				.replace(/var\(--cc-timecode-row-height, 20px\)/g, `${timecodeRow}px`)
				.replace(/var\(--cc-ruler-height\)/g, `${ruler}px`)
				.replace(/var\(--cc-track-height\)/g, `${track}px`)
				.replace(/var\(--cc-timeline-track-count, 0\)/g, String(tracks))
				.replace(/var\(--cc-timeline-extra-height, 0px\)/g, "0px")
				.replace(/^calc/, "")
				.replace(/px/g, "");
			expect(expression).toMatch(/^[\d\s.+*()]+$/);
			return Number(new Function(`return (${expression});`)());
		};
		// The real stack: time row + ruler (+1 px border) + rows (+1 px border each).
		expect(stackHeight(4)).toBe(timecodeRow + ruler + 1 + 4 * (track + 1));
		expect(stackHeight(5)).toBe(270 + timecodeRow);

		// The rules while the bar shows.
		expect(lastValue(lastRule(SHEET, ".cc-editor-shell--clip-tools .cc-editor-shell__timeline"), "min-height")).toBe("auto");
		const clipTimeline = lastRule(SHEET, ".cc-editor-shell--clip-tools .cc-timeline");
		const minMatch = /^min\(var\(--cc-timeline-stack-height\), (\d+)vh\)$/.exec(lastValue(clipTimeline, "min-height") ?? "");
		expect(minMatch).not.toBeNull();
		const capVh = Number(minMatch![1]);
		expect(lastValue(clipTimeline, "max-height")).toBe(`${capVh}vh`);

		// iPhone 17 Pro: the 874 pt screen; 778 pt between the safe areas. The flex layout of
		// round 3 (timeline 1 : preview 1.5 of the free height, basis 2/3 of the bar while it
		// shows) gave the timeline 233.4 px with the bar (the headless-Chrome probe value).
		const screen = 874;
		const flexHeight = 233.4;
		for (const tracks of [4, 5]) {
			const rowsHeight = ruler + 1 + tracks * (track + 1);
			// 1.0.7: the scroll area under the time row was shorter than the rows.
			expect(flexHeight - 1 - timecodeRow).toBeLessThan(rowsHeight);
			// 1.0.8: the timeline is at least the stack height (under the cap), so the scroll area holds every row.
			const timeline = Math.max(flexHeight - 1, Math.min(stackHeight(tracks), (capVh / 100) * screen));
			expect(timeline - timecodeRow).toBeGreaterThanOrEqual(rowsHeight);
		}
		// The cap leaves the preview room: a 7-track stack still fits under it on that screen.
		expect(stackHeight(7)).toBeLessThanOrEqual((capVh / 100) * screen);
		// The bar stays in the flex column under the timeline (round 3, item 8).
		expect(lastValue(lastRule(SHEET, ".cc-toolbar--contextual"), "position")).toBeNull();
	});
});

describe("item 9: the Effects Blur tile shows a real preview image", () => {
	it("the Blur tile image is a sample scene under a Gaussian blur", async () => {
		const { effectPreviewImage, BLUR_PREVIEW_STD_DEVIATION } = (await import(
			join(REPO, "packages/mobile-ui/src/editor/effect-previews.ts")
		)) as { effectPreviewImage: (a: { effectType: string }) => string | undefined; BLUR_PREVIEW_STD_DEVIATION: number };
		const url = effectPreviewImage({ effectType: "blur" });
		expect(url).toBeDefined();
		const prefix = "data:image/svg+xml;charset=utf-8,";
		expect(url!.startsWith(prefix)).toBe(true);
		const svg = decodeURIComponent(url!.slice(prefix.length));
		expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 96 96"/);
		const std = /<filter id="blur"[^>]*><feGaussianBlur stdDeviation="([0-9.]+)"\/><\/filter>/.exec(svg);
		expect(std).not.toBeNull();
		expect(Number(std![1])).toBe(BLUR_PREVIEW_STD_DEVIATION);
		expect(Number(std![1])).toBeGreaterThan(0);
		// The filter is on the scene, and the scene has shapes (not one flat colour).
		const scene = /<g filter="url\(#blur\)">([\s\S]*)<\/g>/.exec(svg)?.[1] ?? "";
		expect((scene.match(/<(rect|circle|path)\b/g) ?? []).length).toBeGreaterThanOrEqual(5);
		expect(new Set(scene.match(/fill="#[0-9a-f]{6}"/g)).size).toBeGreaterThanOrEqual(4);
		// No tile image for an effect with no preview yet (the tile stays as before).
		expect(effectPreviewImage({ effectType: "not-an-effect" })).toBeUndefined();
	});

	it("the Effects panel gives each tile its preview, and the app allows data: images", () => {
		const panel = code("packages/mobile-ui/src/components/panels/effects-panel.tsx");
		expect(panel).toContain('import { effectPreviewImage } from "../../editor/effect-previews";');
		expect(panel).toMatch(/items=\{catalog\.map\(\(def\) => \(\{\s*id: def\.type,\s*label: def\.name,\s*imageSrc: effectPreviewImage\(\{ effectType: def\.type \}\),\s*\}\)\)\}/);
		expect(code("packages/editor-core/src/effects/definitions/blur.ts")).toMatch(/type: "blur",\s*name: "Blur",/);
		expect(code("packages/mobile-ui/src/components/thumbnail-grid.tsx")).toContain('{item.imageSrc && <img src={item.imageSrc} alt="" />}');
		expect(raw("apps/mobile/index.html")).toMatch(/img-src 'self' data:/);
	});
});

describe("item 10b: the Effects toolbar icon is neutral", () => {
	it("the Effects item uses the lucide Blend icon, not Sparkles", () => {
		const defs = code("packages/mobile-ui/src/components/editor/toolbar-defs.ts");
		expect(defs).toContain('{ id: "effects", label: "Effects", icon: Blend },');
		expect(defs).toMatch(/import \{[^}]*\bBlend\b[^}]*\} from "lucide-react"/);
		expect(defs).not.toMatch(/Sparkle|Wand|Magic/);
		// No other primary item uses Blend.
		expect(defs.match(/icon: Blend\b/g)?.length).toBe(1);
		// The typecheck step proves that the installed lucide-react has the icon.
		// (A read of node_modules here depends on the package manager's layout.)
	});
});
