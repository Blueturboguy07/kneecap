/**
 * Blind test round 3 (1.0.6, iPhone 17 Pro simulator, iOS 26.2): the small UI fixes in
 * 1.0.7 (items 2, 3, 4, 7, 8, 9 and 10). These checks read the shipped files with the
 * comments taken out. The item 8 check computes the editor's flex layout from the CSS
 * values, and the item 10 checks run the real close rule (src/app/close-project.ts)
 * with a fake editor. Each check fails on the 1.0.6 source.
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
/** The value of a custom property in tokens.css, in px. */
function tokenPx(name: string): number {
	const match = new RegExp(`${name}:\\s*([0-9.]+)px;`).exec(raw("packages/mobile-ui/src/tokens.css"));
	expect(match).not.toBeNull();
	return Number(match![1]);
}

const SHEET = css("packages/mobile-ui/src/components.css");
const APP_CSS = css("apps/mobile/src/app/app-root.css");
const APP_ROOT = code("apps/mobile/src/app/app-root.tsx");
const SHELL = code("packages/mobile-ui/src/components/editor/editor-shell.tsx");
const STICKERS = code("packages/mobile-ui/src/components/panels/stickers-panel.tsx");

describe("item 2: Settings > Licenses scrolls to the last license", () => {
	it("the license list is a direct child of the scroll box, and no direct child of the scroll box can shrink", () => {
		const screen = code("apps/mobile/src/app/licenses-screen.tsx");
		// The list (overflow: hidden, so its minimum flex height is 0) sits right in the scroll box.
		expect(screen).toMatch(/<div className="kc-settings__body">[\s\S]*?\{entries \? \(\s*<div className="kc-settings__group">/);
		expect(lastValue(lastRule(APP_CSS, ".kc-settings__group"), "overflow")).toBe("hidden");
		// The fix: the children keep their full height, so the scroll box has content to scroll.
		expect(lastValue(lastRule(APP_CSS, ".kc-settings__body > *"), "flex-shrink")).toBe("0");
	});

	it("the scroll box has a fixed height in the screen, scrolls on the y axis, and has iOS momentum scroll", () => {
		const screen = lastRule(APP_CSS, ".kc-settings");
		expect(lastValue(screen, "height")).toBe("100dvh");
		expect(lastValue(screen, "overflow")).toBe("hidden");
		const body = lastRule(APP_CSS, ".kc-settings__body");
		expect(lastValue(body, "overflow-y")).toBe("auto");
		expect(lastValue(body, "min-height")).toBe("0");
		expect(lastValue(body, "-webkit-overflow-scrolling")).toBe("touch");
		expect(lastValue(body, "touch-action")).toBe("pan-y");
		// Nothing in the app blocks the touch scroll (no touchmove handler, no touch-action: none on the screen).
		expect(code("apps/mobile/src/app/settings-screen.tsx")).not.toMatch(/touchmove|preventDefault/);
		expect(code("apps/mobile/src/app/licenses-screen.tsx")).not.toMatch(/touchmove|preventDefault/);
	});
});

describe("item 3: the top-bar chip shows the resolution that the export sheet sets", () => {
	it("the shell subscribes to the project settings and the chip reads them", () => {
		const hooks = code("packages/mobile-ui/src/editor/use-live-editor.ts");
		expect(hooks).toMatch(
			/export function useProjectSettings\(\): TProjectSettings \| null \{\s*return useEditor\(\(editor\) => editor\.project\.getActiveOrNull\(\)\?\.settings \?\? null\);/,
		);
		// A hook: called before the shell's early "Loading the project…" return.
		const call = SHELL.indexOf("const projectSettings = useProjectSettings();");
		expect(call).toBeGreaterThan(0);
		expect(call).toBeLessThan(SHELL.indexOf("if (!ready) {"));
		expect(SHELL).toContain("const settings = projectSettings ?? project.settings;");
		expect(SHELL).toContain("resolutionLabel={resolutionLabelFor(settings.canvasSize)}");
		expect(SHELL).not.toContain("resolutionLabelFor(project.settings.canvasSize)");
		expect(SHELL).toContain("canvasWidth={settings.canvasSize.width}");
	});

	it("a settings change gives a new settings object, and a selector hook re-renders on a project change", () => {
		// The selector result changes: the command makes a new settings object.
		const command = code("packages/editor-core/src/commands/project/update-project-settings.ts");
		expect(command).toContain("settings: { ...activeProject.settings, ...this.updates },");
		expect(command).toContain("editor.project.setActiveProject({ project: updatedProject });");
		// A selector hook listens to the project manager; a bare useEditor() listens to nothing.
		const useEditor = code("packages/editor-core/react/use-editor.ts");
		expect(useEditor).toContain("editor.project.subscribe(onChange),");
		expect(useEditor).toContain("selector ? subscribeAll : subscribeNone,");
		// The export sheet writes the resolution through setProjectResolution -> UpdateProjectSettingsCommand.
		expect(code("packages/mobile-ui/src/components/panels/export-sheet.tsx")).toContain("setProjectResolution({ editor, canvasSize });");
		// The chip label for the 720p canvas that the export sheet sets on a 9:16 project.
		const fn = SHELL.slice(SHELL.indexOf("function resolutionLabelFor("), SHELL.indexOf("const RATIO_PRESETS"));
		const js = new Bun.Transpiler({ loader: "ts" }).transformSync(fn);
		const label = new Function(`${js}\nreturn resolutionLabelFor;`)() as (size: { width: number; height: number }) => string;
		expect(label({ width: 720, height: 1280 })).toBe("720p");
		expect(label({ width: 1080, height: 1920 })).toBe("1080p");
		expect(code("packages/mobile-ui/src/editor/use-live-editor.ts")).toContain("export function useProjectSettings()");
	});
});

describe("item 4: a flag clip has the country name, a shape clip the shape name", () => {
	it("the Stickers panel passes the tile name to insertStickerElement", () => {
		expect(STICKERS).toContain("const name = items.find((item) => item.id === stickerId)?.name;");
		expect(STICKERS).toContain("insertStickerElement({ editor, stickerId, name })");
		// The tile name is the provider's item name.
		expect(STICKERS).toContain("label: item.name");
	});

	it("insertStickerElement gives the name to buildStickerElement, which uses it before the id", () => {
		const actions = code("packages/mobile-ui/src/editor/actions.ts");
		const fn = actions.slice(actions.indexOf("export function insertStickerElement("));
		const body = fn.slice(0, fn.indexOf("\n}\n"));
		expect(body).toMatch(/name\?: string;/);
		expect(body).toMatch(/buildStickerElement\(\{ stickerId, name: displayName, startTime:/);
		expect(code("packages/editor-core/src/timeline/element-utils.ts")).toContain("name: name ?? stickerNameFromId,");
	});

	it("the flag item for AL is named Albania; the shape items are named Square, Star, ...", async () => {
		const { COUNTRIES } = (await import(join(REPO, "packages/editor-core/src/stickers/providers/countries-data.ts"))) as {
			COUNTRIES: Array<{ code: string; name: string }>;
		};
		expect(COUNTRIES.find((c) => c.code === "AL")?.name).toBe("Albania");
		expect(code("packages/editor-core/src/stickers/providers/flags.ts")).toMatch(/provider: FLAGS_PROVIDER_ID,\s*name: country\.name,/);
		expect(code("packages/editor-core/src/stickers/providers/shapes.ts")).toMatch(/provider: SHAPES_PROVIDER_ID,\s*name: preset\.name,/);
		// Without the panel's name, the id "flags:AL" gives the clip name "AL" (the 1.0.6 bug).
		expect(STICKERS).toMatch(/insertStickerElement\(\{ editor, stickerId, name \}\)/);
	});
});

describe("item 7: the Captions panel uses plain words and no wand icon", () => {
	const panel = code("packages/mobile-ui/src/components/panels/captions-panel.tsx");

	it("the note is plain: short sentences, no developer words", () => {
		const note = /<p className="cc-panel-note">\s*([^<{]+?)\s*<\/p>/.exec(panel)?.[1] ?? "";
		expect(note).toBe("Captions come from the speech in your clips. Speech recognition runs on this phone.");
		for (const sentence of note.split(/(?<=\.)\s+/)) expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(20);
		expect(panel).not.toMatch(/zero\s+network|zero\s+cloud|trims\s+respected|voiceover|transcribes/i);
	});

	it("the Generate button has a neutral captions icon; no wand or sparkle icon in the panel", () => {
		expect(panel).toContain('import { Captions } from "lucide-react";');
		expect(panel).toContain('<Captions className="cc-panel-cta__icon" size={18} aria-hidden="true" />');
		expect(panel).not.toMatch(/Wand|Sparkle|Magic|Stars\b/);
		// The icon is in the installed lucide-react: the main toolbar uses it already.
		expect(code("packages/mobile-ui/src/components/editor/toolbar-defs.ts")).toMatch(/import \{[^}]*\bCaptions\b[^}]*\} from "lucide-react"/);
	});
});

describe("item 8: with a clip selected, the clip-tools bar covers no track", () => {
	it("the shell marks the clip-tools state with the same condition that shows the bar", () => {
		expect(SHELL).toContain("const showClipTools = Boolean(selectedRef && selectedElement);");
		expect(SHELL).toContain('showClipTools && "cc-editor-shell--clip-tools",');
		expect(SHELL).toMatch(/\{showClipTools && selectedRef && selectedElement && \(\s*<SubToolbar/);
	});

	it("the timeline keeps its height when the bar shows, and ends above the bar", () => {
		/** "grow shrink basis" of `flex` (basis 0 or px), from the last rule of `selector`. */
		const flexOf = (selector: string) => {
			const [grow, shrink, basis] = (lastValue(lastRule(SHEET, selector), "flex") ?? "").split(/\s+/);
			return { grow: Number(grow), shrink: Number(shrink), basis: Number.parseFloat(basis ?? "") };
		};
		const preview = flexOf(".cc-preview-stage");
		const timeline = flexOf(".cc-editor-shell__timeline");
		expect(preview).toEqual({ grow: 1.5, shrink: 1, basis: 0 });
		expect(timeline).toEqual({ grow: 1, shrink: 1, basis: 0 });
		const bar = tokenPx("--cc-subtoolbar-height");
		expect(lastValue(lastRule(SHEET, ".cc-toolbar--contextual"), "height")).toBe("var(--cc-subtoolbar-height)");
		// The flex-basis of the timeline while the bar shows.
		const basisValue = lastValue(lastRule(SHEET, ".cc-editor-shell--clip-tools .cc-editor-shell__timeline"), "flex-basis");
		const basisMatch = /^calc\(var\(--cc-subtoolbar-height\) \* (\d+) \/ (\d+)\)$/.exec(basisValue ?? "");
		expect(basisMatch).not.toBeNull();
		const clipToolsBasis = (bar * Number(basisMatch![1])) / Number(basisMatch![2]);
		// Flex layout of the shell column: the free height F is shared by flex-grow.
		const timelineHeight = (free: number, basis: number) =>
			basis + ((free - basis - preview.basis) * timeline.grow) / (timeline.grow + preview.grow);
		for (const free of [420, 546, 640]) {
			const without = timelineHeight(free, timeline.basis);
			const withBar = timelineHeight(free - bar, clipToolsBasis);
			expect(Math.abs(withBar - without)).toBeLessThan(0.01);
			expect(withBar).toBeGreaterThanOrEqual(150);
		}
		// The bar is in the shell's flex column (not over it): the timeline ends above it.
		expect(lastValue(lastRule(SHEET, ".cc-toolbar"), "position")).toBeNull();
		expect(lastValue(lastRule(SHEET, ".cc-toolbar--contextual"), "position")).toBeNull();
		expect(lastValue(lastRule(SHEET, ".cc-editor-shell"), "flex-direction")).toBe("column");
	});

	it("a selected clip's track row scrolls fully into view (the round 3 audio track case)", async () => {
		const { scrollTopToShowRow } = (await import(join(REPO, "packages/mobile-ui/src/timeline/row-scroll.ts"))) as {
			scrollTopToShowRow: (args: {
				scrollTop: number;
				viewHeight: number;
				contentHeight: number;
				rowTop: number;
				rowBottom: number;
				topInset?: number;
			}) => number | null;
		};
		// Shot E14 (iPhone 17 Pro): a 196 px scroll view; ruler 24 px, then main, sticker,
		// text and audio rows of 49 px. The selected audio row (171 to 220) was cut at 196.
		const view = { viewHeight: 196, contentHeight: 220, topInset: 24 };
		expect(scrollTopToShowRow({ ...view, scrollTop: 0, rowTop: 171, rowBottom: 220 })).toBe(24);
		// A row in view: no scroll.
		expect(scrollTopToShowRow({ ...view, scrollTop: 0, rowTop: 24, rowBottom: 73 })).toBeNull();
		expect(scrollTopToShowRow({ ...view, scrollTop: 24, rowTop: 171, rowBottom: 220 })).toBeNull();
		// The main row under the sticky ruler after a scroll: back up.
		expect(scrollTopToShowRow({ ...view, scrollTop: 24, rowTop: 24, rowBottom: 73 })).toBe(0);
		// Never past the end of the content (a rounded content height).
		expect(scrollTopToShowRow({ ...view, contentHeight: 219.6, scrollTop: 0, rowTop: 171, rowBottom: 220 })).toBeCloseTo(23.6, 5);
	});

	it("the timeline runs the row scroll when the selection changes, as a vertical scroll that is not a seek", () => {
		const view = code("packages/mobile-ui/src/components/timeline/timeline-view.tsx");
		expect(view).toContain('import { scrollTopToShowRow } from "../../timeline/row-scroll";');
		const start = view.indexOf("if (!node || !selectedClipId) return;");
		expect(start).toBeGreaterThan(0);
		const effect = view.slice(start, view.indexOf("}, [selectedClipId, scrollRef]);"));
		expect(effect).toContain('.querySelector<HTMLElement>(".cc-timeline__clip--selected")');
		expect(effect).toContain('?.closest<HTMLElement>(".cc-timeline__track-row");');
		expect(effect).toMatch(/if \(target === null\) return;\s*isProgrammaticScrollRef\.current = true;\s*node\.scrollTop = target;\s*$/);
		expect(effect).not.toContain("scrollLeft");
		// handleScroll skips a programmatic scroll (no seek).
		expect(view).toMatch(/const handleScroll = useCallback\(\(\) => \{\s*if \(isProgrammaticScrollRef\.current\) \{\s*isProgrammaticScrollRef\.current = false;\s*return;/);
	});
});

describe("item 9: Stickers > Shapes labels are readable", () => {
	it("the sticker grid has its own class, and its labels have a dark strip", () => {
		expect(STICKERS).toMatch(/<ThumbnailGrid\s+className="cc-thumbgrid--stickers"/);
		expect(code("packages/mobile-ui/src/components/thumbnail-grid.tsx")).toContain('className={cn("cc-thumbgrid", className)}');
		const background = lastValue(lastRule(SHEET, ".cc-thumbgrid--stickers .cc-thumb__label"), "background") ?? "";
		const alpha = /^rgb\(0 0 0 \/ (\d+)%\)$/.exec(background);
		expect(alpha).not.toBeNull();
		// The label colour (--cc-text-primary) on the strip over a WHITE tile: at least 4.5:1.
		const text = /--cc-text-primary:\s*#([0-9a-f]{6});/i.exec(raw("packages/mobile-ui/src/tokens.css"))![1]!;
		const luminance = (rgb: number[]) =>
			rgb
				.map((c) => c / 255)
				.map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
				.reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
		const textRgb = [0, 2, 4].map((i) => Number.parseInt(text.slice(i, i + 2), 16));
		const stripOnWhite = 255 * (1 - Number(alpha![1]) / 100);
		const ratio = (luminance(textRgb) + 0.05) / (luminance([stripOnWhite, stripOnWhite, stripOnWhite]) + 0.05);
		expect(ratio).toBeGreaterThanOrEqual(4.5);
		// The tile images do not change.
		expect(lastValue(lastRule(SHEET, ".cc-thumb img"), "object-fit")).toBe("cover");
	});
});

describe("item 10: a project that never got content is deleted on close; a project with content gets its thumbnail", () => {
	type Track = { elements: unknown[] };
	type Scene = { tracks: { main: Track; overlay: Track[]; audio: Track[] } };
	const scene = (main: number, overlay: number[] = [], audio: number[] = []): Scene => ({
		tracks: {
			main: { elements: Array(main).fill({}) },
			overlay: overlay.map((n) => ({ elements: Array(n).fill({}) })),
			audio: audio.map((n) => ({ elements: Array(n).fill({}) })),
		},
	});

	/** A fake editor with the parts close-project.ts uses; `calls` records each call in order. */
	function fakeEditor({ scenes, prepareExit }: { scenes: Scene[]; prepareExit?: () => Promise<void> }) {
		const calls: string[] = [];
		let saved = [{ id: "p1" }, { id: "p2" }];
		let active: { metadata: { id: string } } | null = { metadata: { id: "p1" } };
		const editor = {
			project: {
				getActiveOrNull: () => active,
				getSavedProjects: () => saved,
				deleteProjects: async ({ ids }: { ids: string[] }) => {
					calls.push(`delete:${ids.join(",")}`);
					saved = saved.filter((p) => !ids.includes(p.id));
					active = null;
				},
				prepareExit: () => {
					calls.push("prepareExit");
					return prepareExit ? prepareExit() : Promise.resolve();
				},
				saveCurrentProject: async () => {
					calls.push("save");
				},
			},
			scenes: { getScenes: () => scenes },
			save: {
				flush: async () => {
					calls.push("flush");
				},
				getIsDirty: () => false,
			},
		};
		return { editor, calls, saved: () => saved };
	}

	async function closeModule() {
		return (await import(join(REPO, "apps/mobile/src/app/close-project.ts"))) as {
			closeEditorProject: (args: {
				editor: unknown;
				afterError?: boolean;
				hadContentAtOpen?: boolean;
				thumbnailLimitMs?: number;
			}) => Promise<string>;
			projectHasElements: (args: { editor: unknown }) => boolean | null;
			waitForCloseWork: (args?: { limitMs?: number }) => Promise<void>;
		};
	}

	it("projectHasElements looks at every track of every scene", async () => {
		const { projectHasElements } = await closeModule();
		const has = (scenes: Scene[]) => projectHasElements({ editor: { scenes: { getScenes: () => scenes } } });
		expect(has([scene(0)])).toBe(false);
		expect(has([scene(0, [0], [0, 0])])).toBe(false);
		expect(has([scene(1)])).toBe(true);
		expect(has([scene(0, [1])])).toBe(true);
		expect(has([scene(0, [], [0, 1])])).toBe(true);
		expect(has([scene(0), scene(0, [], [1])])).toBe(true);
		// No scenes: not known, so the project is kept.
		expect(has([])).toBeNull();
	});

	it("an empty project: saves settle, then the project is deleted; no thumbnail", async () => {
		const { closeEditorProject } = await closeModule();
		const fake = fakeEditor({ scenes: [scene(0, [0], [0])] });
		expect(await closeEditorProject({ editor: fake.editor })).toBe("deleted");
		expect(fake.calls).toEqual(["flush", "delete:p1"]);
		expect(fake.saved().map((p) => p.id)).toEqual(["p2"]);
		// After an editor error the rule is the same.
		const afterError = fakeEditor({ scenes: [scene(0)] });
		expect(await closeEditorProject({ editor: afterError.editor, afterError: true })).toBe("deleted");
		expect(afterError.calls).toEqual(["flush", "delete:p1"]);
	});

	it("a project with content: thumbnail (prepareExit), then save; never deleted", async () => {
		const { closeEditorProject } = await closeModule();
		for (const scenes of [[scene(1)], [scene(0, [], [1])], [scene(0), scene(0, [2])], []]) {
			const fake = fakeEditor({ scenes });
			expect(await closeEditorProject({ editor: fake.editor })).toBe("kept");
			expect(fake.calls).toEqual(["prepareExit", "save"]);
		}
		// After an editor error: kept, and no frame render.
		const afterError = fakeEditor({ scenes: [scene(1)] });
		expect(await closeEditorProject({ editor: afterError.editor, afterError: true })).toBe("kept");
		expect(afterError.calls).toEqual([]);
	});

	it("a project that had content when the editor opened is never deleted, even when it is empty now", async () => {
		const { closeEditorProject } = await closeModule();
		const emptied = fakeEditor({ scenes: [scene(0, [0], [0])] });
		expect(await closeEditorProject({ editor: emptied.editor, hadContentAtOpen: true })).toBe("kept");
		expect(emptied.calls).toEqual(["prepareExit", "save"]);
		expect(emptied.saved().map((p) => p.id)).toEqual(["p1", "p2"]);
		const afterError = fakeEditor({ scenes: [scene(0)] });
		expect(await closeEditorProject({ editor: afterError.editor, afterError: true, hadContentAtOpen: true })).toBe("kept");
		expect(afterError.calls).toEqual([]);
	});

	it("app-root records the content state when the editor opens and passes it to the rule", () => {
		const open = APP_ROOT.slice(APP_ROOT.indexOf("onOpenEditor={() => {"), APP_ROOT.indexOf("onOpenSettings="));
		expect(open).toContain("hadContentAtOpenRef.current = projectHasElements({ editor: EditorCore.getInstance() }) !== false;");
		expect(APP_ROOT).toContain("const hadContentAtOpenRef = useRef(true);");
	});

	it("a thumbnail that does not end does not keep the user in the editor; Home waits for it before a new task", async () => {
		const { closeEditorProject, waitForCloseWork } = await closeModule();
		let finish: () => void = () => {};
		const fake = fakeEditor({ scenes: [scene(1)], prepareExit: () => new Promise<void>((resolve) => (finish = resolve)) });
		const started = Date.now();
		expect(await closeEditorProject({ editor: fake.editor, thumbnailLimitMs: 30 })).toBe("kept");
		expect(Date.now() - started).toBeLessThan(1000);
		expect(fake.calls).toEqual(["prepareExit", "save"]);
		let waited = false;
		const home = waitForCloseWork({ limitMs: 5000 }).then(() => (waited = true));
		await Bun.sleep(20);
		expect(waited).toBe(false);
		finish();
		await home;
		expect(waited).toBe(true);
	});

	it("every way out of the editor runs the rule; Home shows after it", () => {
		expect(APP_ROOT).toContain('import { closeEditorProject, projectHasElements, waitForCloseWork } from "./close-project";');
		const leave = APP_ROOT.slice(APP_ROOT.indexOf("const leaveEditor = "), APP_ROOT.indexOf('if (screen.name === "editor")'));
		expect(leave).toMatch(
			/closeEditorProject\(\{ editor: EditorCore\.getInstance\(\), afterError, hadContentAtOpen \}\)\.finally\(\(\) => \{[\s\S]*setScreen\(\{ name: "home" \}\);/,
		);
		// The "Close project" button (EditorShell onBack): the editor leaves the screen at once, then the rule runs.
		const onBack = APP_ROOT.slice(APP_ROOT.indexOf("onBack={() => {"), APP_ROOT.indexOf("</EditorErrorGuard>"));
		expect(onBack).toMatch(/flushSync\(\(\) => setScreen\(\{ name: "closing" \}\)\);\s*leaveEditor\(\{ afterError: false \}\);/);
		// The editor error guard.
		const onError = APP_ROOT.slice(APP_ROOT.indexOf("onError={(error) => {"), APP_ROOT.indexOf("<EditorShell"));
		expect(onError).toContain("leaveEditor({ afterError: true });");
		// No other close path: no fire-and-forget save, no old new-project-only delete.
		expect(APP_ROOT).not.toContain("saveCurrentProject()");
		expect(APP_ROOT).not.toContain("discardEmptyNewProject");
		expect(code("packages/mobile-ui/src/components/editor/top-bar.tsx")).toMatch(/onClick=\{onClose\} aria-label="Close project"/);
		expect(SHELL).toContain("onClose={onBack}");
		// The closing screen is not Home: the CI test waits for .kc-home, which shows after the rule ran.
		const closing = APP_ROOT.slice(APP_ROOT.indexOf('if (screen.name === "closing")'), APP_ROOT.indexOf('if (screen.name === "settings")'));
		expect(closing).toContain('className="kc-closing"');
		expect(closing).not.toMatch(/className="[^"]*\bkc-home\b[^_]/);
		// Home waits for a late thumbnail before it opens, makes or deletes a project.
		const run = APP_ROOT.slice(APP_ROOT.indexOf("const run = async ("), APP_ROOT.indexOf("return (", APP_ROOT.indexOf("const run = async (")));
		expect(run.indexOf("await waitForCloseWork();")).toBeGreaterThan(0);
		expect(run.indexOf("await waitForCloseWork();")).toBeLessThan(run.indexOf("await task();"));
	});

	it("a card without a thumbnail, or with one that does not load, shows the neutral placeholder", () => {
		const card = APP_ROOT.slice(APP_ROOT.indexOf("function ProjectCard("), APP_ROOT.indexOf("function formatDuration("));
		expect(card).toContain("const showThumbnail = Boolean(thumbnail) && failedThumbnail !== thumbnail;");
		expect(card).toContain("onError={() => setFailedThumbnail(thumbnail ?? null)}");
		expect(card).toMatch(/\{showThumbnail \? \([\s\S]*?\) : \(\s*<span className="kc-home__thumb kc-home__thumb--empty" aria-hidden="true">\s*<svg/);
		// The placeholder is a grey tile with a video icon in the middle, not an empty box.
		const empty = lastRule(APP_CSS, ".kc-home__thumb--empty");
		expect(lastValue(empty, "display")).toBe("flex");
		expect(lastValue(empty, "background")).toBe("var(--cc-surface-raised, #262626)");
		// The thumbnail is the frame at 0:00 (editor-core prepareExit), saved at once.
		const manager = code("packages/editor-core/src/core/managers/project-manager.ts");
		const exit = manager.slice(manager.indexOf("async prepareExit("), manager.indexOf("getFilteredAndSortedProjects("));
		expect(exit).toContain("const didUpdateThumbnail = await this.updateThumbnailFromTimeline();");
		expect(exit).toContain("await this.editor.save.flush();");
	});
});
