/**
 * Blind test round 1 (1.0.3, iPhone 17 Pro simulator, iOS 26.2): the fixes in
 * 1.0.4 that a source check can prove. The editor test in the iOS CI job
 * (scripts/ios-sim-editor-test.py, autotest.tsx) proves the editor, preview
 * and export items on a simulator; publik-gate.test.ts proves the sign-in
 * sheet item. These checks read the shipped files with the comments taken out.
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
/** The declarations of the LAST rule whose selector list is exactly `selector`. */
function lastRule(sheet: string, selector: string): string {
	const blocks = [...sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) =>
		m[1]!.split(",").map((s) => s.trim()).includes(selector),
	);
	return blocks.map((m) => m[2]).join("\n");
}

describe("item 6 and 12: the crash screen", () => {
	const screen = code("apps/mobile/src/app/crash-screen.tsx");

	it("has the full app name, a plain message, Try again and Report (the support page)", () => {
		expect(screen).toContain('"publik kneecap stopped working"');
		expect(screen).toContain('data-kneecap-crash="1"');
		expect(screen).toContain('className="kc-crash"');
		expect(screen).toMatch(/>\s*Try again\s*</);
		expect(screen).toMatch(/>\s*Report\s*</);
		expect(screen).toMatch(/openUrl\(\{ url: SUPPORT_URL \}\)/);
	});

	it("never shows the error, a stack trace or a file path", () => {
		expect(screen).not.toMatch(/<pre\b/);
		expect(screen).not.toMatch(/\{[^}]*(stack|componentStack|message|error)[^}]*\}\s*<\//);
		expect(screen).not.toContain("kc-crash__detail");
		const root = code("apps/mobile/src/app/app-root.tsx");
		expect(root).toMatch(/import \{[^}]*\bCrashBoundary\b[^}]*\} from "\.\/crash-screen"/);
		expect(root).not.toContain("kneecap crashed");
		expect(root).not.toContain("kc-crash__detail");
		expect(root).not.toMatch(/class CrashBoundary/);
	});

	it("the boot error screen shows the details only in a debug build", () => {
		const main = code("apps/mobile/src/main.ts");
		const fn = main.slice(main.indexOf("function showBootError"), main.indexOf('window.addEventListener("unhandledrejection"'));
		expect(fn).toContain('"publik kneecap stopped working"');
		expect(fn).toContain('dataset.kneecapCrash = "1"');
		expect(fn).toContain("SUPPORT_URL");
		expect(fn.match(/err\.stack/g)?.length).toBe(1);
		// The only err.stack is inside the debug-build block (the block ends at "\n\t}").
		const debugBlock = fn.indexOf("if (__KNEECAP_DEBUG_TOOLS__) {");
		const stack = fn.indexOf("err.stack");
		expect(debugBlock).toBeGreaterThan(0);
		expect(stack).toBeGreaterThan(debugBlock);
		expect(fn.slice(debugBlock, stack)).not.toContain("\n\t}");
		expect(fn).not.toContain("failed to start");
	});

	it("the iOS permission prompts say publik kneecap", () => {
		const plist = raw("apps/mobile/ios/App/App/Info.plist");
		const usage = [...plist.matchAll(/<key>NS\w+UsageDescription<\/key>\s*<string>([^<]*)<\/string>/g)].map((m) => m[1]!);
		expect(usage.length).toBeGreaterThan(0);
		for (const text of usage) expect(text.startsWith("publik kneecap ")).toBe(true);
	});
});

describe("item 5: captions use the person's clips only", () => {
	const actions = code("packages/mobile-ui/src/editor/captions-actions.ts");

	it("Generate never falls back to the developer sample clip", () => {
		const generate = actions.slice(actions.indexOf("export async function generateCaptions("));
		const body = generate.slice(0, generate.indexOf("\n}\n"));
		expect(body).not.toContain("generateCaptionsFromSampleClip");
		expect(body).not.toContain("DEV_FIXTURE");
	});

	it("the error texts are plain: no file name, path or fixture", () => {
		const block = actions.slice(actions.indexOf("export const CAPTION_MESSAGES"), actions.indexOf("} as const"));
		const texts = [...block.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]!);
		expect(texts.length).toBe(6);
		for (const text of texts) expect(text).not.toMatch(/fixture|\/|\\|native|harness|\$\{/i);
		expect(actions).toContain("throw new Error(CAPTION_MESSAGES.noClip)");
		expect(actions).toContain("throw new Error(CAPTION_MESSAGES.noAudio)");
		expect(actions).toContain("throw new Error(CAPTION_MESSAGES.unreadable)");
		// Round 2: a speech permission denial says so (not "could not read").
		expect(actions).toContain("throw new Error(CAPTION_MESSAGES.permission)");
		expect(actions).toMatch(/error\.code === "PERMISSION_DENIED"\) permissionDenied = true/);
		expect(actions).not.toMatch(/Transcription failed: \$\{/);
		expect(actions).toContain("asset.hasAudio === false");
	});
});

describe("item 7 and 10: nothing under the status bar or the home indicator, nothing wider than the screen", () => {
	const sheet = css("packages/mobile-ui/src/components.css");

	it("the 'Select ... first' hint sits above the toolbar, inside the safe area", () => {
		const hint = lastRule(sheet, ".cc-sheet-scrim > .cc-panel-note");
		expect(hint).toMatch(/position:\s*absolute/);
		expect(hint).toMatch(/bottom:\s*calc\(env\(safe-area-inset-bottom/);
		expect(hint).not.toMatch(/\btop:/);
	});

	it("a bottom sheet keeps its last button above the home indicator", () => {
		expect(lastRule(sheet, ".cc-sheet__body")).toMatch(/padding-bottom:\s*calc\([^;]*env\(safe-area-inset-bottom/);
	});

	it("the text field fits the screen and the time label has its own row above the ruler", () => {
		const input = lastRule(sheet, ".cc-text-content-input");
		expect(input).toMatch(/box-sizing:\s*border-box/);
		expect(input).toMatch(/max-width:\s*100%/);
		expect(lastRule(sheet, ".cc-timeline")).toMatch(/padding-top:\s*var\(--cc-timecode-row-height/);
		expect(lastRule(sheet, ".cc-timeline__timecode")).toMatch(/top:\s*0;/);
	});
});

describe("item 8: a black launch", () => {
	it("the launch screen, the web view and the first page are black", () => {
		const launch = raw("apps/mobile/ios/App/App/Base.lproj/LaunchScreen.storyboard");
		expect(launch).not.toContain("systemBackgroundColor");
		expect(launch).toMatch(/key="backgroundColor" white="0(\.0)?" alpha="1"/);
		expect(code("apps/mobile/capacitor.config.ts")).toContain('backgroundColor: "#000000"');
		const scene = raw("apps/mobile/ios/App/App/SceneDelegate.swift");
		expect(scene).toContain("webView?.isOpaque = false");
		expect(scene).toContain("webView?.backgroundColor = .black");
		expect(raw("apps/mobile/index.html")).toMatch(/background:\s*#000/);
	});
});

describe("item 9: tap targets of at least 44 pt", () => {
	const sheet = css("packages/mobile-ui/src/components.css");
	const app = css("apps/mobile/src/app/app-root.css");
	const minOf = (rules: string, prop: "min-height" | "min-width" | "height" | "width"): number => {
		const values = [...rules.matchAll(new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+);`, "g"))].map((m) => m[1]!.trim());
		const px = values.map((v) => (v === "var(--cc-touch-target-ios)" ? 44 : Number.parseFloat(v)));
		return px.length ? Math.max(...px) : 0;
	};

	it("Close, Undo, Redo, fullscreen, Export and the colour swatches", () => {
		for (const selector of [".cc-topbar__icon-btn", ".cc-keyframe-control__btn", ".cc-timeline__quick-add-btn"]) {
			const rules = lastRule(sheet, selector);
			expect(minOf(rules, "min-height")).toBeGreaterThanOrEqual(44);
			expect(minOf(rules, "min-width")).toBeGreaterThanOrEqual(44);
		}
		for (const selector of [".cc-export-btn", ".cc-playbackbar__play", ".cc-export-sheet__action", ".cc-chip", ".cc-segmented__option"]) {
			expect(minOf(lastRule(sheet, selector), "min-height")).toBeGreaterThanOrEqual(44);
		}
		const swatch = lastRule(sheet, ".cc-swatch");
		expect(swatch).toMatch(/width:\s*var\(--cc-touch-target-ios\)[\s\S]*height:\s*var\(--cc-touch-target-ios\)/);
	});

	it("Settings, New project, Back and the project menu", () => {
		expect(minOf(lastRule(app, ".kc-home__new"), "min-height")).toBeGreaterThanOrEqual(44);
		expect(minOf(lastRule(app, ".kc-home__settings"), "min-height")).toBeGreaterThanOrEqual(44);
		expect(minOf(lastRule(app, ".kc-settings__back"), "height")).toBeGreaterThanOrEqual(44);
		expect(minOf(lastRule(app, ".kc-settings__back"), "width")).toBeGreaterThanOrEqual(44);
		expect(minOf(lastRule(app, ".kc-home__more"), "height")).toBeGreaterThanOrEqual(44);
		expect(minOf(lastRule(app, ".kc-crash__button"), "min-height")).toBeGreaterThanOrEqual(44);
	});
});

describe("item 11: a photo clip shows the photo on the timeline", () => {
	const clip = code("packages/mobile-ui/src/components/timeline/timeline-clip.tsx");

	it("the clip gets the photo, and each filmstrip slot takes the clip's height", () => {
		expect(code("packages/mobile-ui/src/editor/use-timeline-project-vm.ts")).toContain("posterUri: photoPosterUri(");
		const strip = clip.slice(clip.indexOf("function ClipFilmstrip("));
		// A slot with no height makes its frame (height 100%) 0 px tall.
		expect(strip).toMatch(/position: "absolute",\s*left: timeToPixels\([^)]*\),\s*top: 0,\s*bottom: 0,/);
	});

	it("only a clip with a real image draws a filmstrip (no made-up frames)", () => {
		expect(clip).toMatch(/\(clip\.posterUri \|\| clip\.thumbnails\) && \(\s*<ClipFilmstrip/);
	});
});

describe("the export sheet uses plain words", () => {
	const sheet = code("packages/mobile-ui/src/components/panels/export-sheet.tsx");
	// The JSX the sheet renders (the last `return (` of the component).
	const view = sheet.slice(sheet.lastIndexOf("return ("));
	const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	/** The text is the whole content of one element (a title, a note or a button). */
	const shows = (text: string) => new RegExp(`>\\s*${escapeRe(text)}\\s*<`);

	it("shows no file path and no error text", () => {
		expect(sheet).toContain('<p className="cc-panel-note">Export failed. Try again.</p>');
		// 1.0.5 (blind test round 2): the result block replaced "Export complete.".
		// 1.0.6: no "Open Photos" button (guideline 2.5.1); Share stays.
		for (const text of ["Saved to Photos", "Could not save to Photos.", "Share"]) {
			expect(view).toMatch(shows(text));
		}
		expect(view).not.toMatch(shows("Open Photos"));
		expect(view).toMatch(/>Photos access is off[^<]*Settings\.</);
		expect(sheet).not.toContain("Export complete.");
		// The video's path goes back to the bridge only; the sheet never renders it.
		expect(view).not.toMatch(/\b(outputUri|exportedUriRef|uri)\b/);
		expect(sheet).not.toMatch(/Export failed: \{/);
	});
});

describe("item 13 and 14: phone words, and no Delete account when signed out", () => {
	it("the sign-in screens say Tap and this screen, never Click or this window", () => {
		for (const path of ["apps/mobile/src/publik/publik.ts", "apps/mobile/src/publik/gate-ui.ts", "apps/mobile/src/app/settings-screen.tsx"]) {
			const text = code(path).replace(/addEventListener\("click"/g, "");
			expect(text).not.toMatch(/"[^"]*\bClick\b[^"]*"/);
			expect(text).not.toMatch(/this window/i);
		}
		expect(code("apps/mobile/src/publik/publik.ts")).toContain("Tap Sign in with publik");
	});

	it("Settings shows Delete account only to a signed-in person", () => {
		const settings = code("apps/mobile/src/app/settings-screen.tsx");
		const at = settings.indexOf("Delete account");
		expect(at).toBeGreaterThan(0);
		const before = settings.slice(0, at);
		const guard = before.lastIndexOf("{account ? (");
		expect(guard).toBeGreaterThan(0);
		expect(before.slice(guard)).not.toMatch(/\)\s*:\s*null\s*\}/);
	});
});
