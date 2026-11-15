/**
 * Blind test round 2 (store build, iOS simulator, network on): "Editor >
 * Stickers > Flags: every flag tile is a broken-image '?'". The flags
 * provider loads /flags/<code>.svg, and those files were only in
 * apps/web/public. Vite copies apps/mobile/public into www/, the web bundle
 * of both native apps, so every same-origin asset the mobile editor loads
 * must be there. These checks read the repo files only (no build):
 *
 *   - a flag file for each country code in countries-data.ts, and no
 *     flag file that the Flags tab cannot show;
 *   - each same-origin asset path in the shipped code ("/fonts/...",
 *     "/flags", "/licenses/...") is in apps/mobile/public;
 *   - the font atlas's chunk images are all there;
 *   - each sticker tab has bundled items (flags: files; shapes: drawn
 *     data: URLs) and no tab is listed for an empty provider (logos);
 *   - each bundled sound of the Audio panel is a WAV file in
 *     apps/mobile/public/sounds, and the panel inserts it through the
 *     native import (media custody, a media asset), not as a data: clip;
 *   - Settings > Licenses names flag-icons (MIT) with its full text;
 *   - the CSP lets the app show its own images and data: images.
 *
 * Run: bun test apps/mobile/test
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../../..");
const PUBLIC = "apps/mobile/public";

function read(path: string): string {
	return readFileSync(join(REPO, path), "utf8");
}

/** The code of a file without its comments (block comments, JSX comments and line comments). */
function codeOf(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function isFile(path: string): boolean {
	const full = join(REPO, path);
	return existsSync(full) && statSync(full).isFile() && statSync(full).size > 0;
}

function filesUnder(dir: string): string[] {
	return (readdirSync(join(REPO, dir), { recursive: true }) as string[]).map((name) => `${dir}/${name}`);
}

/** The source files that go into the mobile web bundle: the editor UI, the engine (no tests) and the app screens. Developer tools (spike, autotest, legacy harness) are not in a store build. */
function shippedSources(): Array<{ path: string; code: string }> {
	const files = [
		...filesUnder("packages/mobile-ui/src"),
		...filesUnder("packages/editor-core/src"),
		...filesUnder("apps/mobile/src/app"),
		...filesUnder("apps/mobile/src/publik"),
		"apps/mobile/src/main.ts",
	];
	return files
		.filter((path) => /\.(ts|tsx|css)$/.test(path))
		.filter((path) => !/\.test\.tsx?$/.test(path) && !path.includes("__tests__") && !path.includes("test-support"))
		.map((path) => ({ path, code: codeOf(read(path)) }));
}

/** The country codes the Flags tab shows. */
function countryCodes(): string[] {
	const data = read("packages/editor-core/src/stickers/providers/countries-data.ts");
	return [...data.matchAll(/"code":\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** The keys of STICKER_CATEGORIES (the sticker tabs, plus "all"), without the commented-out ones. */
function stickerTabs(): string[] {
	const code = codeOf(read("packages/editor-core/src/stickers/categories.ts"));
	return [...code.matchAll(/^\s*([A-Za-z]\w*)\s*:\s*"/gm)].map((m) => m[1]);
}

describe("round 2: the Flags sticker tab shows bundled images", () => {
	const flags = codeOf(read("packages/editor-core/src/stickers/providers/flags.ts"));

	it("the flags provider loads /flags/<code>.svg from the app itself", () => {
		expect(/DEFAULT_FLAGS_BASE_URL\s*=\s*"\/flags"/.test(flags)).toBe(true);
		expect(flags.includes("toLowerCase()")).toBe(true);
		expect(flags.includes(".svg`")).toBe(true);
		expect(flags.match(/["'`]https?:\/\/[^"'`]*/g) ?? []).toEqual([]);
	});

	it("each country code has its flag in apps/mobile/public/flags", () => {
		const codes = countryCodes();
		expect(codes.length).toBeGreaterThan(200);
		const missing = codes.filter((code) => !isFile(`${PUBLIC}/flags/${code.toLowerCase()}.svg`));
		expect(missing).toEqual([]);
	});

	it("each flag file is a plain SVG image: no script, no outside link, no embedded image", () => {
		const bad: string[] = [];
		for (const code of countryCodes()) {
			const path = `${PUBLIC}/flags/${code.toLowerCase()}.svg`;
			if (!isFile(path)) continue;
			const svg = read(path);
			if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(svg)) bad.push(`${path}: does not start with <svg`);
			if (!/viewBox="0 0 640 480"/.test(svg)) bad.push(`${path}: no 640x480 viewBox`);
			if (/<script|<foreignObject|<image[\s>]/i.test(svg)) bad.push(`${path}: script, foreignObject or image`);
			if (/(?:xlink:)?href\s*=\s*"(?!#)/i.test(svg)) bad.push(`${path}: a link outside the file`);
		}
		expect(bad).toEqual([]);
	});

	it("apps/mobile/public/flags has no flag that the Flags tab cannot show", () => {
		const wanted = new Set(countryCodes().map((code) => `${code.toLowerCase()}.svg`));
		const extra = readdirSync(join(REPO, PUBLIC, "flags")).filter((name) => name.endsWith(".svg") && !wanted.has(name));
		expect(extra).toEqual([]);
	});
});

describe("round 2: every sticker tab has bundled items", () => {
	it("the tabs are only the ones this test checks (flags, shapes)", () => {
		// A new tab needs its own check here: bundled files or drawn data: URLs.
		expect(stickerTabs().filter((tab) => tab !== "all").sort()).toEqual(["flags", "shapes"]);
	});

	it("the shapes tab draws its previews (data: URLs), it loads no file", () => {
		const shapes = codeOf(read("packages/editor-core/src/stickers/providers/shapes.ts"));
		expect(shapes.includes("buildGraphicPreviewUrl(")).toBe(true);
		expect(shapes.match(/["'`](?:\/[A-Za-z]|https?:\/\/)[^"'`]*/g) ?? []).toEqual([]);
		const graphics = codeOf(read("packages/editor-core/src/graphics/index.ts"));
		expect(graphics.includes('canvas.toDataURL("image/png")')).toBe(true);
		expect(graphics.includes("data:image/svg+xml")).toBe(true);
	});

	it("the logos provider has no items, so there is no Logos tab", () => {
		const logos = codeOf(read("packages/editor-core/src/stickers/providers/logos.ts"));
		expect(logos.includes("return EMPTY_BROWSE_RESULT")).toBe(true);
		expect(stickerTabs()).not.toContain("logos");
	});

	it("the Stickers panel shows only the tabs that have items", () => {
		const panel = codeOf(read("packages/mobile-ui/src/components/panels/stickers-panel.tsx"));
		expect(/CATEGORIES\.filter\(\(c\) => \(itemsByCategory\?\.\[c\]\?\.length \?\? 0\) > 0\)/.test(panel)).toBe(true);
		expect(panel.includes("chips={categories.map(")).toBe(true);
	});
});

describe("round 2: every same-origin asset of the mobile editor is in the app", () => {
	// The top-level names of the web app's and the mobile app's public folders: a
	// string that starts with "/<one of them>" is a same-origin asset path.
	const assetRoots = new Set(
		["apps/web/public", PUBLIC].flatMap((dir) => readdirSync(join(REPO, dir))).filter((name) => name !== "spike-assets"),
	);
	const pathRe = /["'`(]\s*(\/([\w.-]+)(?:\/[\w.-]*)*)/g;

	it("each asset path in the shipped code is a file, a folder with files, or a file-name prefix in apps/mobile/public", () => {
		const problems: string[] = [];
		let seen = 0;
		for (const { path, code } of shippedSources()) {
			for (const match of code.matchAll(pathRe)) {
				const [, assetPath, root] = match;
				if (!assetRoots.has(root)) continue;
				seen++;
				const local = `${PUBLIC}${assetPath}`;
				const full = join(REPO, local);
				if (/\.[A-Za-z0-9]+$/.test(assetPath)) {
					if (!isFile(local)) problems.push(`${path}: ${assetPath} is not in ${PUBLIC}`);
				} else if (existsSync(full) && statSync(full).isDirectory()) {
					if (readdirSync(full).length === 0) problems.push(`${path}: ${local} is empty`);
				} else {
					const slash = local.lastIndexOf("/");
					const dir = join(REPO, local.slice(0, slash));
					const prefix = local.slice(slash + 1);
					if (!existsSync(dir) || !readdirSync(dir).some((name) => name.startsWith(prefix))) {
						problems.push(`${path}: no file ${local}*`);
					}
				}
			}
		}
		expect(problems).toEqual([]);
		// /flags, /fonts/font-atlas.json, /fonts/font-chunk-, two Albert Sans files, /licenses/...
		expect(seen).toBeGreaterThanOrEqual(6);
	});

	it("each font-atlas chunk image is in apps/mobile/public/fonts", () => {
		const atlas = JSON.parse(read(`${PUBLIC}/fonts/font-atlas.json`)) as { fonts: Record<string, { ch: number }> };
		const maxChunk = Math.max(...Object.values(atlas.fonts).map((font) => font.ch));
		const missing: string[] = [];
		for (let i = 0; i <= maxChunk; i++) {
			if (!isFile(`${PUBLIC}/fonts/font-chunk-${i}.png`)) missing.push(`font-chunk-${i}.png`);
		}
		expect(missing).toEqual([]);
	});

	it("the sticker, sound and panel code names no remote address", () => {
		const remote = /["'`(]\s*https?:\/\/(?!www\.w3\.org\/)/;
		const hits = shippedSources()
			.filter(({ path }) =>
				/^packages\/editor-core\/src\/(stickers|sounds|graphics|fonts)\/|^packages\/mobile-ui\/src\/components\//.test(path),
			)
			.filter(({ code }) => remote.test(code))
			.map(({ path }) => path);
		expect(hits).toEqual([]);
	});

	it("the CSP lets the app show its own images and data: images (shape previews)", () => {
		const html = read("apps/mobile/index.html");
		const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
		const imgSrc = csp
			.split(";")
			.map((part) => part.trim())
			.find((part) => part.startsWith("img-src "));
		expect(imgSrc).toBeDefined();
		const sources = (imgSrc ?? "").split(/\s+/);
		expect(sources).toContain("'self'");
		expect(sources).toContain("data:");
		expect(sources.filter((s) => s.startsWith("http:"))).toEqual([]);
	});
});

describe("round 2: the bundled sounds are media files that reach the preview and the export", () => {
	// A data: clip has no media asset: the native preview mix has no file for it,
	// the iOS export drops it and the Android export fails on it. So each sound is
	// also a file of the app, and the Audio panel imports that file like a Files pick.
	const SAMPLE_RATE = 8000;
	const NATIVE_PATH_RE = "^sounds/[a-z0-9-]+\\\\.(wav|m4a)$";

	/** TONE_SPECS of sounds/local-sounds.ts. */
	function toneSpecs(): Array<{ id: string; frequencyHz: number; durationSeconds: number }> {
		const code = codeOf(read("packages/editor-core/src/sounds/local-sounds.ts"));
		return [...code.matchAll(/\{\s*id:\s*"([^"]+)"[^}]*?frequencyHz:\s*([\d.]+),\s*durationSeconds:\s*([\d.]+)\s*\}/g)].map((m) => ({
			id: m[1],
			frequencyHz: Number(m[2]),
			durationSeconds: Number(m[3]),
		}));
	}

	/** The body of `export async function insertLocalSound` in mobile-ui actions.ts. */
	function insertLocalSoundCode(): string {
		const code = codeOf(read("packages/mobile-ui/src/editor/actions.ts"));
		const start = code.indexOf("export async function insertLocalSound(");
		if (start < 0) return "";
		const next = code.indexOf("\nexport ", start + 1);
		return code.slice(start, next < 0 ? undefined : next);
	}

	it("each sound has its WAV file in apps/mobile/public/sounds, with the same samples as the synthesis", () => {
		const specs = toneSpecs();
		expect(specs.map((s) => s.id)).toEqual(["local-chime", "local-pulse", "local-ping", "local-hum"]);
		const problems: string[] = [];
		for (const spec of specs) {
			const path = `${PUBLIC}/sounds/${spec.id}.wav`;
			if (!isFile(path)) {
				problems.push(`${path}: missing`);
				continue;
			}
			const bytes = readFileSync(join(REPO, path));
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			const text = (offset: number) => bytes.subarray(offset, offset + 4).toString("latin1");
			const sampleCount = Math.round(SAMPLE_RATE * spec.durationSeconds);
			const header = {
				riff: text(0),
				wave: text(8),
				fmt: text(12),
				pcm: view.getUint16(20, true),
				channels: view.getUint16(22, true),
				rate: view.getUint32(24, true),
				bits: view.getUint16(34, true),
				data: text(36),
				dataSize: view.getUint32(40, true),
				fileSize: bytes.length,
			};
			const want = { riff: "RIFF", wave: "WAVE", fmt: "fmt ", pcm: 1, channels: 1, rate: SAMPLE_RATE, bits: 16, data: "data", dataSize: sampleCount * 2, fileSize: 44 + sampleCount * 2 };
			if (JSON.stringify(header) !== JSON.stringify(want)) {
				problems.push(`${path}: header ${JSON.stringify(header)}`);
				continue;
			}
			// The same sine tone and fade as synthesizeToneWavDataUri: the file and the data URI stay equal.
			const fadeSamples = Math.min(sampleCount / 4, SAMPLE_RATE * 0.05);
			for (let i = 0; i < sampleCount; i++) {
				let envelope = 1;
				if (i < fadeSamples) envelope = i / fadeSamples;
				else if (i > sampleCount - fadeSamples) envelope = (sampleCount - i) / fadeSamples;
				const sample = Math.sin(2 * Math.PI * spec.frequencyHz * (i / SAMPLE_RATE)) * envelope * 0.6;
				const expected = Math.round(Math.max(-1, Math.min(1, sample)) * 32767);
				if (view.getInt16(44 + i * 2, true) !== expected) {
					problems.push(`${path}: sample ${i} differs (run apps/mobile/scripts/generate-bundled-sounds.ts)`);
					break;
				}
			}
		}
		const wanted = new Set(specs.map((s) => `${s.id}.wav`));
		const extra = readdirSync(join(REPO, PUBLIC, "sounds")).filter((name) => !wanted.has(name));
		expect({ problems, extra }).toEqual({ problems: [], extra: [] });
	});

	it("each sound names its file, and the native code accepts that path", () => {
		const sounds = codeOf(read("packages/editor-core/src/sounds/local-sounds.ts"));
		expect(sounds.includes("bundledPath: `sounds/${spec.id}.wav`")).toBe(true);
		const nativeRe = new RegExp(NATIVE_PATH_RE.replaceAll("\\\\", "\\"));
		expect(toneSpecs().filter((s) => !nativeRe.test(`sounds/${s.id}.wav`))).toEqual([]);
		const script = read("apps/mobile/scripts/generate-bundled-sounds.ts");
		expect([script.includes("getLocalSounds()"), script.includes("sound.bundledPath")]).toEqual([true, true]);
	});

	it("the Audio panel lists the sounds and inserts each one by its file", () => {
		const panel = codeOf(read("packages/mobile-ui/src/components/panels/audio-panel.tsx"));
		expect({
			list: panel.includes("getLocalSounds()"),
			insert: panel.includes("insertLocalSound("),
			byFile: panel.includes("bundledPath: sound.bundledPath"),
			files: panel.includes("importAndPlaceAudio("),
			dataUri: panel.includes("sourceUrl"),
		}).toEqual({ list: true, insert: true, byFile: true, files: true, dataUri: false });
	});

	it("insertLocalSound uses the native import of a Files pick, not a data: clip", () => {
		const insert = insertLocalSoundCode();
		expect({
			bundled: insert.includes('source: "bundled"'),
			path: insert.includes("bundledPath"),
			nativeImport: insert.includes("importMediaFromNative("),
			mediaClip: insert.includes("buildElementFromMedia(") && insert.includes("mediaId: asset.id"),
			libraryClip: insert.includes("buildLibraryAudioElement"),
			dataUri: insert.includes("sourceUrl"),
		}).toEqual({ bundled: true, path: true, nativeImport: true, mediaClip: true, libraryClip: false, dataUri: false });
	});

	it("the bridge sends source \"bundled\" and bundledPath to native; the web fallback fetches the file", () => {
		const types = codeOf(read("packages/native-bridge/src/types.ts"));
		const capacitor = codeOf(read("packages/native-bridge/src/capacitor-bridge.ts"));
		const web = codeOf(read("packages/native-bridge/src/web-fallback.ts"));
		expect({
			source: types.includes('source?: "library" | "camera" | "bundled";'),
			pathOption: types.includes("bundledPath?: string;"),
			passed: capacitor.includes("bundledPath: opts.bundledPath"),
			web: web.includes('opts.source === "bundled"') && web.includes("fetchBundledFile(opts.bundledPath)"),
		}).toEqual({ source: true, pathOption: true, passed: true, web: true });
	});

	it("iOS copies the file from App.app/public into media custody like a Files pick", () => {
		const swift = read("apps/mobile/ios/App/App/NativeBridgePlugin+Media.swift");
		expect({
			branch: swift.includes('if call.getString("source") == "bundled" {'),
			check: swift.includes(`path.range(of: "${NATIVE_PATH_RE}", options: .regularExpression)`),
			bundle: swift.includes('Bundle.main.url(forResource: "public", withExtension: nil)'),
			sameImport: swift.includes("await AudioDocumentPickerCoordinator.importAudio(from: sourceURL)"),
			filesImport: swift.includes("await AudioDocumentPickerCoordinator.importAudio(from: url)"),
		}).toEqual({ branch: true, check: true, bundle: true, sameImport: true, filesImport: true });
	});

	it("Android copies the file from the APK assets (public/) into media custody like a picked file", () => {
		const kotlin = read("apps/mobile/android/app/src/main/java/dev/kneecap/app/NativeBridgePlugin.kt");
		const importer = read("apps/mobile/android/app/src/main/java/dev/kneecap/app/media/MediaImporter.kt");
		expect({
			branch: kotlin.includes('if (source == "bundled") {'),
			check: kotlin.includes(`Regex("${NATIVE_PATH_RE}").matches(path)`),
			asset: kotlin.includes('MediaImporter.importAsset(context, "public/$path")'),
			probe: kotlin.includes("MediaProbe.probe(imported.file, imported.mimeType)"),
			copy: importer.includes("context.assets.open(assetPath)") && importer.includes("File(mediaDir(context),"),
		}).toEqual({ branch: true, check: true, asset: true, probe: true, copy: true });
	});
});

describe("round 2: Settings > Licenses names the flag images", () => {
	const data = JSON.parse(read(`${PUBLIC}/licenses/third-party-licenses.json`)) as {
		entries: Array<{ name: string; version: string; license: string; source: string; note: string; text: string }>;
	};
	const entry = data.entries.find((e) => e.name.startsWith("flag-icons"));

	it("has a flag-icons entry, MIT, with its source and full license text", () => {
		expect(entry).toBeDefined();
		expect(entry?.license).toBe("MIT");
		expect(entry?.version).toBe("7.5.0");
		expect(entry?.source).toBe("https://github.com/lipis/flag-icons");
		expect(entry?.text).toContain("Copyright (c) 2013 Panayiotis Lipiridis");
		expect(entry?.text).toContain(
			"The above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.",
		);
		expect(entry?.text).toBe(read(`${PUBLIC}/flags/LICENSE-flag-icons.txt`).trim());
	});

	it("the license script makes the same entry", () => {
		const script = read("apps/mobile/scripts/generate-licenses.py");
		expect(script.includes('"public" / "flags" / "LICENSE-flag-icons.txt"')).toBe(true);
		expect(script.includes('"name": "flag-icons (flag stickers)", "version": "7.5.0", "license": "MIT"')).toBe(true);
		expect(entry?.name).toBe("flag-icons (flag stickers)");
	});
});
