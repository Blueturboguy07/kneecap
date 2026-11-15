/**
 * App Store review (rule 2.1, completeness), 1.0.4: the store app shows no
 * control that does nothing and no "not in the app yet" text. These checks
 * read the source of the screens that ship (packages/mobile-ui components
 * and apps/mobile/src/app), with the comments taken out. They also check
 * that the Licenses screen data names soundtouchjs (LGPL-2.1) with its
 * source link and full license text.
 *
 * Run: bun test apps/mobile/test
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../../..");
const SHIPPED_DIRS = ["packages/mobile-ui/src/components", "apps/mobile/src/app"];

/** The code of a file without its comments (block comments, JSX comments and line comments). */
function codeOf(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function shippedFiles(): Array<{ path: string; code: string }> {
	const files: Array<{ path: string; code: string }> = [];
	for (const dir of SHIPPED_DIRS) {
		for (const name of readdirSync(join(REPO, dir), { recursive: true }) as string[]) {
			if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name) || name.includes("__tests__")) continue;
			const path = `${dir}/${name}`;
			files.push({ path, code: codeOf(readFileSync(join(REPO, path), "utf8")) });
		}
	}
	return files;
}

function read(path: string): string {
	return codeOf(readFileSync(join(REPO, path), "utf8"));
}

describe("App Store rule 2.1: no control that does nothing, no placeholder text", () => {
	it("no shipped screen has a 'not yet' or 'coming soon' text, or the removed controls", () => {
		const banned = [
			/isn(?:'|’|&apos;)t in publik kneecap/i,
			/aren(?:'|’|&apos;)t in publik kneecap/i,
			/coming soon/i,
			/not (?:built|implemented|available) yet/i,
			/implemented yet/i,
			/AI clipper/i,
			/Preview EDL/i,
			/cc-timeline__helper-chip/,
			/cc-topbar__icon-btn--chrome/,
			/cc-playbackbar__compare/,
		];
		const hits = shippedFiles().flatMap(({ path, code }) =>
			banned.filter((re) => re.test(code)).map((re) => `${path}: ${re}`),
		);
		expect(hits).toEqual([]);
	});

	it("the main toolbar has no Transcript or Template item", () => {
		const defs = read("packages/mobile-ui/src/components/editor/toolbar-defs.ts");
		expect(defs).not.toContain('id: "transcript"');
		expect(defs).not.toContain('id: "template"');
		const shell = read("packages/mobile-ui/src/components/editor/editor-shell.tsx");
		expect(shell).not.toContain('"transcript"');
		expect(shell).not.toContain('"template"');
	});

	it("the Edit panel has no Reverse switch and the Captions panel has no Language choice (neither reached the video)", () => {
		expect(read("packages/mobile-ui/src/components/panels/edit-panel.tsx")).not.toMatch(/label="Reverse"/);
		const captions = read("packages/mobile-ui/src/components/panels/captions-panel.tsx");
		expect(captions).not.toMatch(/Caption language|label: "Spanish"/);
	});

	it("the Export sheet has only real controls: resolution, frame rate, quality, Export video and the result buttons", () => {
		const sheet = read("packages/mobile-ui/src/components/panels/export-sheet.tsx");
		// 1.0.5 (blind test round 2): after an export the result block adds
		// exactly two buttons, Open Photos and Share. Each button has a handler.
		const buttons = [...sheet.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((m) => m[0]);
		const labels = buttons.map((button) => />\s*([^<>{}]+?)\s*<\/button>$/.exec(button)?.[1] ?? button);
		expect([...labels].sort()).toEqual(["Export video", "Open Photos", "Share"]);
		for (const button of buttons) expect(button).toContain("onClick={");
	});
});

describe("Settings > Licenses: the LGPL library soundtouchjs", () => {
	it("is in the list with its license, its source link and the full LGPL-2.1 text", () => {
		const data = JSON.parse(readFileSync(join(REPO, "apps/mobile/public/licenses/third-party-licenses.json"), "utf8")) as {
			entries: Array<{ name: string; version: string; license: string; source: string; note: string; text: string }>;
		};
		const entry = data.entries.find((e) => e.name === "soundtouchjs");
		expect(entry).toBeDefined();
		expect(entry!.license).toBe("LGPL-2.1");
		expect(entry!.source).toBe("https://github.com/cutterbl/SoundTouchJS");
		expect(entry!.note).toContain(`soundtouchjs@${entry!.version}`);
		expect(entry!.text).toContain("GNU LESSER GENERAL PUBLIC LICENSE");
		expect(entry!.text).toContain("Version 2.1");
	});
});
