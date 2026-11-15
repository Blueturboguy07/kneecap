/**
 * Blind test round 2 (1.0.4, iPhone 17 Pro simulator, iOS 26): the small UI fixes in
 * 1.0.5 that a source check can prove (items 4 to 8, and the clip Mute toggle in the Edit
 * sheet that the CI test uses to prove Mute on a video clip). The editor test in the iOS CI job
 * (autotest.tsx) proves items on a simulator. These checks read the shipped files with
 * the comments taken out; the item 5 check also runs the real keyboard code with a fake
 * window.
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
	const values = [...rules.matchAll(new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+);`, "g"))].map((m) => m[1]!.trim());
	return values.length ? values[values.length - 1]! : null;
}
/** The largest px size that `prop` gets in `rules` (the 44 pt token counts as 44). */
function maxPx(rules: string, prop: string): number {
	const values = [...rules.matchAll(new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+);`, "g"))].map((m) => m[1]!.trim());
	const px = values.map((v) => (/^var\(--cc-touch-target-ios(, 44px)?\)$/.test(v) ? 44 : Number.parseFloat(v)));
	return px.length ? Math.max(...px) : 0;
}
function zIndex(sheet: string, selector: string): number {
	return Number(lastValue(lastRule(sheet, selector), "z-index"));
}

const SHEET = css("packages/mobile-ui/src/components.css");
const APP_CSS = css("apps/mobile/src/app/app-root.css");
const APP_ROOT = code("apps/mobile/src/app/app-root.tsx");

describe("item 4: no keyframe diamond covers a ruler label", () => {
	it("the opaque part of the keyframe control is only the time-label row above the ruler", () => {
		expect(lastRule(SHEET, ".cc-timeline")).toMatch(/padding-top:\s*var\(--cc-timecode-row-height/);
		const control = lastRule(SHEET, ".cc-timeline__keyframe-control");
		expect(lastValue(control, "top")).toBe("0");
		expect(lastValue(control, "height")).toBe("var(--cc-timecode-row-height, 20px)");
		expect(lastValue(control, "overflow")).toBeNull();
	});

	it("each keyframe button keeps a 44 x 44 pt box; the part over the ruler is transparent padding", () => {
		const base = lastRule(SHEET, ".cc-keyframe-control__btn");
		expect(maxPx(base, "min-width")).toBeGreaterThanOrEqual(44);
		expect(maxPx(base, "min-height")).toBeGreaterThanOrEqual(44);
		expect(lastValue(base, "background")).toBe("transparent");
		expect(lastValue(base, "border")).toBe("0");
		const btn = lastRule(SHEET, ".cc-timeline__keyframe-control .cc-keyframe-control__btn");
		expect(lastValue(btn, "box-sizing")).toBe("border-box");
		// 44 - 20: the icons sit in the top 20 px (the time-label row), the rest is padding.
		expect(lastValue(btn, "padding-bottom")).toBe(
			"calc(var(--cc-touch-target-ios, 44px) - var(--cc-timecode-row-height, 20px))",
		);
		expect(btn).not.toMatch(/(^|[;\s])(min-height|height|background):/);
	});

	it("a clip's diamonds go under the sticky ruler; the playhead and the time row stay above it", () => {
		const ruler = zIndex(SHEET, ".cc-timeline__ruler");
		expect(ruler).toBeGreaterThan(zIndex(SHEET, ".cc-timeline__keyframe-diamond"));
		expect(ruler).toBeGreaterThan(zIndex(SHEET, ".cc-timeline__transition-square"));
		expect(ruler).toBeLessThan(zIndex(SHEET, ".cc-timeline__playhead"));
		expect(ruler).toBeLessThan(zIndex(SHEET, ".cc-timeline__keyframe-control"));
		expect(ruler).toBeLessThan(zIndex(SHEET, ".cc-timeline__timecode"));
	});
});

describe("item 5: with the keyboard open, nothing goes under the status bar", () => {
	it("the app starts the keyboard watch before the first render", () => {
		const mount = APP_ROOT.slice(APP_ROOT.indexOf("export function mountApp("));
		const watch = mount.indexOf("keepPageAtTopWithKeyboard();");
		expect(watch).toBeGreaterThan(0);
		expect(watch).toBeLessThan(mount.indexOf("createRoot(container)"));
	});

	it("the open sheet sits on the keyboard and stays below the status bar", () => {
		const sheet = lastRule(SHEET, ':root[data-cc-keyboard="open"] .cc-sheet');
		expect(lastValue(sheet, "bottom")).toBe("var(--cc-keyboard-inset, 0px)");
		const maxHeight = lastValue(sheet, "max-height") ?? "";
		expect(maxHeight).toContain("var(--cc-keyboard-inset, 0px)");
		expect(maxHeight).toContain("env(safe-area-inset-top, 0px)");
		// The shell keeps its status-bar padding: the top bar starts below the status bar.
		expect(lastRule(SHEET, ".cc-editor-shell")).toMatch(/padding-top:\s*env\(safe-area-inset-top/);
	});

	/** Runs the real keepPageAtTopWithKeyboard from app-root.tsx with a fake window. */
	function fakeScreen() {
		const start = APP_ROOT.indexOf("const KEYBOARD_MIN_PX");
		const end = APP_ROOT.indexOf("export function mountApp(");
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		const source = APP_ROOT.slice(start, end).replace("function keepPageAtTopWithKeyboard(): void", "function keepPageAtTopWithKeyboard()");
		const listeners: Array<() => void> = [];
		const viewport = {
			height: 874,
			offsetTop: 0,
			scale: 1,
			addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
		};
		const styles = new Map<string, string>();
		const root = {
			clientHeight: 874,
			dataset: {} as Record<string, string | undefined>,
			style: { setProperty: (name: string, value: string) => styles.set(name, value) },
		};
		const scrolls: Array<[number, number]> = [];
		const win = {
			visualViewport: viewport,
			scrollY: 0,
			scrollTo: (x: number, y: number): void => {
				scrolls.push([x, y]);
				win.scrollY = y;
				viewport.offsetTop = 0;
			},
			addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
		};
		const run = new Function("window", "document", `${source}\nkeepPageAtTopWithKeyboard();`);
		run(win, { documentElement: root });
		const fire = () => listeners.forEach((fn) => fn());
		return { viewport, root, styles, scrolls, win, fire };
	}

	it("keyboard open: the page goes back to the top and the sheet gets the keyboard height", () => {
		const screen = fakeScreen();
		expect(screen.styles.get("--cc-keyboard-inset")).toBe("0px");
		expect(screen.root.dataset.ccKeyboard).toBeUndefined();
		// iOS shows a 380 pt keyboard and pushes the page up by 300 pt.
		screen.viewport.height = 494;
		screen.viewport.offsetTop = 300;
		screen.fire();
		expect(screen.styles.get("--cc-keyboard-inset")).toBe("380px");
		expect(screen.root.dataset.ccKeyboard).toBe("open");
		expect(screen.scrolls).toEqual([[0, 0]]);
		expect(screen.viewport.offsetTop).toBe(0);
		// Keyboard closed: everything as before.
		screen.viewport.height = 874;
		screen.fire();
		expect(screen.styles.get("--cc-keyboard-inset")).toBe("0px");
		expect(screen.root.dataset.ccKeyboard).toBeUndefined();
		expect(screen.scrolls.length).toBe(1);
	});

	it("a small accessory bar or a pinch zoom is not a keyboard", () => {
		const screen = fakeScreen();
		screen.viewport.height = 874 - 55;
		screen.fire();
		expect(screen.styles.get("--cc-keyboard-inset")).toBe("0px");
		expect(screen.root.dataset.ccKeyboard).toBeUndefined();
		screen.viewport.scale = 2;
		screen.viewport.height = 437;
		screen.viewport.offsetTop = 200;
		screen.fire();
		expect(screen.root.dataset.ccKeyboard).toBeUndefined();
		expect(screen.scrolls.length).toBe(0);
	});
});

describe("item 6: the export progress overlay is opaque", () => {
	it("nothing under the overlay shows through", () => {
		const overlay = lastRule(SHEET, ".cc-progress-overlay");
		const background = lastValue(overlay, "background") ?? "";
		expect(background).toBe("var(--cc-bg-base, #000000)");
		// The token is an opaque colour (#rrggbb, no alpha).
		expect(raw("packages/mobile-ui/src/tokens.css")).toMatch(/--cc-bg-base:\s*#[0-9a-fA-F]{6};/);
		expect(lastValue(overlay, "position")).toBe("fixed");
		expect(lastValue(overlay, "inset")).toBe("0");
		expect(overlay).toMatch(/padding:\s*env\(safe-area-inset-top/);
	});

	it("the overlay and its Cancel button are above the export sheet and every editor control", () => {
		const overlay = zIndex(SHEET, ".cc-progress-overlay");
		for (const selector of [".cc-sheet", ".cc-sheet-scrim", ".cc-chrome-error", ".cc-timeline__keyframe-control", ".cc-timeline__playhead"]) {
			expect(overlay).toBeGreaterThan(zIndex(SHEET, selector));
		}
		const component = code("packages/mobile-ui/src/components/progress-overlay.tsx");
		expect(component).toMatch(/className="cc-progress-overlay__cancel"/);
		expect(maxPx(lastRule(SHEET, ".cc-progress-overlay__cancel"), "min-height")).toBeGreaterThanOrEqual(44);
	});

	it("the stage words are plain: the label never shows the raw stage name such as muxing", () => {
		const sheet = code("packages/mobile-ui/src/components/panels/export-sheet.tsx");
		expect(sheet).not.toMatch(/label=\{`Exporting — \$\{progress\.stage\}`\}/);
		const block = sheet.slice(sheet.indexOf("const EXPORT_STAGE_WORDS"), sheet.indexOf("};", sheet.indexOf("const EXPORT_STAGE_WORDS")));
		const words = [...block.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]!);
		expect(words.length).toBe(5);
		for (const word of words) expect(word).not.toMatch(/mux|encod|render|transcod|pipeline/i);
		expect(sheet).toContain("EXPORT_STAGE_WORDS[progress.stage]");
	});
});

describe("item 7: home shows no 'No projects yet' while the list loads", () => {
	it("the empty text shows only after the first load finished with zero projects", () => {
		expect(APP_ROOT).toContain("const listLoaded = useEditor((e) => e.project.getIsInitialized());");
		const loading = APP_ROOT.indexOf("projects.length === 0 && !listLoaded ? (");
		const empty = APP_ROOT.indexOf('<p className="kc-home__empty">');
		expect(loading).toBeGreaterThan(0);
		expect(empty).toBeGreaterThan(loading);
		// The loading element has no text.
		expect(APP_ROOT).toMatch(/<div className="kc-home__loading" role="progressbar" aria-label="Loading projects" \/>/);
	});

	it("the engine marks the list as loaded only when loadAllProjects ends", () => {
		const manager = code("packages/editor-core/src/core/managers/project-manager.ts");
		expect(manager).toMatch(/getIsInitialized\(\): boolean \{\s*return this\.isInitialized;/);
		const load = manager.slice(manager.indexOf("async loadAllProjects("), manager.indexOf("async deleteProjects("));
		expect(load).toContain("this.isInitialized = true;");
		expect(manager.match(/this\.isInitialized = true;/g)?.length).toBe(load.match(/this\.isInitialized = true;/g)?.length);
	});

	it("the loading state is quiet: a small ring that shows only after 0.4 s", () => {
		expect(lastRule(APP_CSS, ".kc-home__loading")).toMatch(/flex:\s*1/);
		const ring = lastRule(APP_CSS, ".kc-home__loading::before");
		expect(ring).toMatch(/content:\s*""/);
		expect(ring).toMatch(/kc-home-loading-in 0\.2s ease 0\.4s both/);
	});
});

describe("item 8: aspect-ratio buttons of at least 44 x 44 pt", () => {
	it("every ratio button (9:16, 16:9, 1:1, 4:5, 3:4) is at least 44 pt wide and high", () => {
		const item = lastRule(SHEET, ".cc-ratio-grid__item");
		expect(maxPx(item, "min-width")).toBeGreaterThanOrEqual(44);
		expect(maxPx(item, "min-height")).toBeGreaterThanOrEqual(44);
		expect(lastValue(item, "box-sizing")).toBe("border-box");
		const shell = code("packages/mobile-ui/src/components/editor/editor-shell.tsx");
		for (const ratio of ["9:16", "16:9", "1:1", "4:5", "3:4"]) expect(shell).toContain(`label: "${ratio}"`);
		expect(shell).toMatch(/className=\{cn\("cc-ratio-grid__item"/);
	});

	it("the colour swatches in the same grid stay 44 x 44 pt", () => {
		const swatch = lastRule(SHEET, ".cc-swatch");
		expect(lastValue(swatch, "width")).toBe("var(--cc-touch-target-ios)");
		expect(lastValue(swatch, "height")).toBe("var(--cc-touch-target-ios)");
	});
});

describe("Mute on a video or audio clip (Edit sheet)", () => {
	it("the Edit sheet has a Mute toggle for a video or audio clip, on when params.muted is true", () => {
		const panel = code("packages/mobile-ui/src/components/panels/edit-panel.tsx");
		expect(panel).toContain("const muted = element.params.muted === true;");
		const block = panel.slice(panel.indexOf("{isRetimable && ("), panel.indexOf("</PanelSheet>"));
		expect(block).toContain('<ToggleRow label="Mute" active={muted} onToggle={() => onSetMuted(!muted)} />');
		expect(panel).toMatch(/onSetMuted: \(muted: boolean\) => void;/);
		expect(panel).toContain('const RETIMABLE_TYPES = new Set(["video", "audio"]);');
		// The CI test finds the row by its text "Mute"; aria-pressed tells on from off.
		const toggle = code("packages/mobile-ui/src/components/editor/param-row.tsx");
		expect(toggle).toMatch(/aria-pressed=\{active\}/);
		expect(toggle).toMatch(/<span>\{label\}<\/span>/);
	});

	it("the toggle writes params.muted with the same undoable command as Volume", () => {
		const shell = code("packages/mobile-ui/src/components/editor/editor-shell.tsx");
		expect(shell).toContain('onSetVolume={(db) => setElementParam({ editor, ref: selectedRef, key: "volume", value: db })}');
		expect(shell).toContain('onSetMuted={(muted) => setElementParam({ editor, ref: selectedRef, key: "muted", value: muted })}');
		const actions = code("packages/mobile-ui/src/editor/actions.ts");
		const setParam = actions.slice(actions.indexOf("export function setElementParam("));
		expect(setParam.slice(0, setParam.indexOf("\n}\n"))).toMatch(/editor\.command\.execute\(\{\s*command: new UpdateElementsCommand\(/);
		const registry = code("packages/editor-core/src/params/registry.ts");
		expect(registry).toMatch(/key: "muted",\s*label: "Muted",\s*type: "boolean",\s*default: false,/);
	});

	it("preview audio leaves a muted clip out (WebAudio and the native iOS mix)", () => {
		expect(code("packages/editor-core/src/timeline/audio-state.ts")).toMatch(
			/function isElementMuted\([\s\S]*?return element\.params\.muted === true;/,
		);
		expect(code("packages/editor-core/src/media/audio.ts")).toContain(
			"const muted = isTrackMuted || isElementMuted({ element });",
		);
		const manager = code("packages/editor-core/src/core/managers/audio-manager.ts");
		const native = manager.slice(manager.indexOf("private async tryStartNativeRoute("), manager.indexOf("async getOutputLevel("));
		expect(native).toContain("if (clip.muted) continue;");
		const webAudio = manager.slice(manager.indexOf("private scheduleUpcomingClips("));
		expect(webAudio.slice(0, webAudio.indexOf("\n\t}\n"))).toContain("if (clip.muted) continue;");
		// A param change during playback rebuilds the schedule (and stops the native mix first).
		expect(manager).toContain("this.editor.timeline.subscribe(this.handleTimelineChange)");
	});

	it("export leaves a muted clip out: the EDL carries it, iOS and Android read it", () => {
		expect(code("packages/editor-core/src/edl/build.ts")).toContain(
			'muted: readBooleanParam({ element, key: "muted", fallback: false }),',
		);
		expect(raw("apps/mobile/ios/App/App/NativeExport/CompositionBuilder.swift")).toMatch(/if let audioTrack, !clip\.muted \{/);
		expect(raw("apps/mobile/android/app/src/main/java/dev/kneecap/app/edl/EdlParser.kt")).toContain('muted = o.getBoolean("muted"),');
		expect(raw("apps/mobile/android/app/src/main/java/dev/kneecap/app/export/EdlToComposition.kt")).toMatch(
			/!trackMuted && !clip\.muted && edl\.output\.includeAudio/,
		);
	});
});
