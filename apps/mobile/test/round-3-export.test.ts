/**
 * Blind test round 3 (1.0.7): the export items.
 *
 *   HIGH 1. Stickers were in no frame of the exported video. Cause: the
 *           preview-drawn overlay frames (`renderOverlayFrames`) drew only
 *           text and captions, and both native exporters composite only
 *           those frames over the video. Now the frames also draw stickers
 *           (flags, shapes) and graphics with the preview's own placement.
 *           On Android a sticker also stopped the export: the
 *           picture-in-picture loop asked a sticker clip for a media asset.
 *           The pixels are proven in the iOS CI job (ios-sim-editor-test.py,
 *           test C); the Android skip by the JVM test StickerExportTest.
 *   LOW 5.  The share sheet showed the export's raw id as the file name.
 *           Now "publik kneecap <project name>.mp4", safe characters only.
 *
 * These checks read the shipped files with the comments taken out.
 * Run: bun test apps/mobile/test
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shareFileName } from "../../../packages/mobile-ui/src/editor/share-file-name";

const REPO = join(import.meta.dir, "../../..");

/** The code of a file without its comments (block comments, JSX comments and line comments). */
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
const DESCRIPTOR = "packages/editor-core/src/services/renderer/compositor/frame-descriptor.ts";
const SHEET = "packages/mobile-ui/src/components/panels/export-sheet.tsx";
const IOS = "apps/mobile/ios/App/App";
const ANDROID_MAIN = "apps/mobile/android/app/src/main/java/dev/kneecap/app";
const ANDROID_TEST = "apps/mobile/android/app/src/test/java/dev/kneecap/app";

describe("HIGH 1: the overlay frames draw stickers and graphics", () => {
	const overlay = code(OVERLAY);

	it("resolves the graphic tracks with the text and caption tracks", () => {
		const filter = between(overlay, "overlay: tracks.overlay.filter(", "audio: [],");
		for (const type of ['"text"', '"caption"', '"graphic"']) {
			expect(filter).toContain(`track.type === ${type}`);
		}
	});

	it("collects sticker and graphic nodes in the same depth-first walk as text", () => {
		const collect = between(overlay, "function collectOverlayNodes(", "return out;");
		for (const kind of ["TextNode", "CaptionNode", "StickerNode", "GraphicNode"]) {
			expect(collect).toContain(`node instanceof ${kind}`);
		}
	});

	it("draws them with the preview's own placement and opacity", () => {
		const draw = between(overlay, "function drawOverlayNode(", "\n}\n");
		expect(draw).toContain("node instanceof StickerNode || node instanceof GraphicNode");
		expect(draw).toContain("drawTransformedCanvas({");
		expect(draw).toContain("transform: computeVisualTransform({");
		expect(draw).toContain("ctx.globalAlpha = Math.min(1, Math.max(0, visual.resolved.opacity));");
		expect(overlay).toContain('from "@/services/renderer/compositor/frame-descriptor"');
		const descriptor = code(DESCRIPTOR);
		expect(descriptor).toContain("export function computeVisualTransform(");
		expect(descriptor).toContain("export function drawTransformedCanvas(");
	});

	it("passes the export-size renderer to every draw", () => {
		expect(overlay).toContain("drawOverlayNode({ node, ctx: surface.ctx, renderer })");
	});

	it("hashes a sticker by what changes its pixels, not by its local time", () => {
		const hash = between(overlay, "function overlayHash(", "async function toPngBase64(");
		const sticker = between(hash, "if (node instanceof StickerNode || node instanceof GraphicNode) {", "return {\n\t\t\t\tp:");
		expect(sticker).not.toContain("localTime");
		expect(sticker).not.toContain("r: node.resolved");
		for (const key of ["id:", "t: visual?.resolved.transform", "o: visual?.resolved.opacity", "w: visual?.sourceWidth", "h: visual?.sourceHeight"]) {
			expect(sticker).toContain(key);
		}
	});

	it("the export stops with the plain message when a sticker cannot be drawn", () => {
		const sheet = code(SHEET);
		expect(sheet).toContain("function hasVisibleStickersOrGraphics(tracks: SceneTracks): boolean");
		const helper = between(sheet, "function hasVisibleStickersOrGraphics(", "\n}\n");
		expect(helper).toContain('track.type === "graphic"');
		expect(helper).toContain("!track.hidden");
		expect(helper).toContain("!element.hidden");
		const prerender = between(sheet, "overlayFrames = await renderOverlayFrames({", "const generator = bridge.exportProject({ edl, overlayFrames });");
		const caught = between(prerender, "} catch (error) {", 'console.warn("overlay prerender failed');
		expect(caught).toMatch(/if \(hasVisibleStickersOrGraphics\(editor\.scenes\.getActiveScene\(\)\.tracks\)\) \{\s*failExport\(error\);\s*return;\s*\}/);
		expect(prerender).toMatch(/overlayFrames\.length === 0 &&\s*hasVisibleStickersOrGraphics\(editor\.scenes\.getActiveScene\(\)\.tracks\)/);
	});
});

describe("HIGH 1: Android skips sticker clips in the picture-in-picture loop", () => {
	it("a non-media overlay clip never reaches requireAsset", () => {
		const composition = code(`${ANDROID_MAIN}/export/EdlToComposition.kt`);
		const loop = between(composition, "for (track in overlayVisualTracks) {", "val animated =");
		const skip = loop.indexOf("if (!OverlayClips.isPipMediaClip(clip)) continue");
		expect(skip).toBeGreaterThan(0);
		expect(loop.indexOf("requireAsset(edl, clip)")).toBeGreaterThan(skip);
		const clips = code(`${ANDROID_MAIN}/export/OverlayClips.kt`);
		expect(clips).toContain('fun isPipMediaClip(clip: EdlClip): Boolean = clip.kind == "video" || clip.kind == "image"');
	});

	it("a JVM test covers sticker, graphic, text, caption, video and image clips", () => {
		const test = code(`${ANDROID_TEST}/export/StickerExportTest.kt`);
		for (const kind of ["sticker", "graphic", "text", "caption"]) {
			expect(test).toContain(`assertFalse(OverlayClips.isPipMediaClip(clip("${kind}")))`);
		}
		for (const kind of ["video", "image"]) {
			expect(test).toContain(`assertTrue(OverlayClips.isPipMediaClip(clip("${kind}")))`);
		}
	});
});

describe("LOW 5: the share sheet file name", () => {
	it("is publik kneecap plus the project name, with safe characters only", () => {
		expect(shareFileName({ projectName: "My trip", extension: "mp4" })).toBe("publik kneecap My trip.mp4");
		expect(shareFileName({ projectName: "  Été à Paris / 2026: day #1?  ", extension: "mp4" })).toBe(
			"publik kneecap Été à Paris 2026 day 1.mp4",
		);
		expect(shareFileName({ projectName: "a\\b<c>|d*e\"f", extension: "webm" })).toBe("publik kneecap a b c d e f.webm");
		expect(shareFileName({ projectName: "", extension: "mp4" })).toBe("publik kneecap.mp4");
		expect(shareFileName({ projectName: undefined, extension: "" })).toBe("publik kneecap.mp4");
		expect(shareFileName({ projectName: "../../etc", extension: "m/p4" })).toBe("publik kneecap etc.mp4");
		const long = shareFileName({ projectName: "x".repeat(300), extension: "mp4" });
		expect(long).toBe(`publik kneecap ${"x".repeat(60)}.mp4`);
	});

	it("the export sheet sends it with the share", () => {
		const sheet = code(SHEET);
		const share = between(sheet, "const fileName = shareFileName({", "await bridge.shareFile({ uri, fileName });");
		expect(share).toContain("projectName: editor.project.getActive().metadata.name");
		expect(share).toContain("extension: format");
	});

	it("the bridge passes it to native", () => {
		const bridge = code("packages/native-bridge/src/capacitor-bridge.ts");
		expect(bridge).toContain("shareFile(params: { uri: string; fileName?: string }): Promise<unknown>;");
		expect(between(bridge, "async shareFile({ uri, fileName }", "async ")).toContain("fileName");
	});

	it("iOS shares a copy with the clean name", () => {
		const swift = code(`${IOS}/NativeBridgePlugin+Export.swift`);
		const share = between(swift, "@objc func shareFile(", "UIActivityViewController(activityItems: [fileURL]");
		expect(share).toContain('let fileURL = Self.namedShareCopy(of: exportURL, fileName: call.getString("fileName"))');
		expect(swift).toContain("static func safeShareFileName(_ requested: String?, fileExtension: String) -> String?");
		expect(swift).toContain("static func namedShareCopy(of exportURL: URL, fileName: String?) -> URL");
	});

	it("Android shares a copy with the clean name", () => {
		const plugin = code(`${ANDROID_MAIN}/NativeBridgePlugin.kt`);
		const share = between(plugin, "fun shareFile(", "FileProvider.getUriForFile(");
		expect(share).toContain('ShareFileName.safe(call.getString("fileName"), file.extension)');
		expect(share).toContain("file.copyTo(copy, overwrite = true)");
		expect(code(`${ANDROID_TEST}/export/StickerExportTest.kt`)).toContain("fun shareFileNameIsReadableAndSafe()");
	});
});

describe("1.0.7 and later: one version everywhere", () => {
	// 1.0.8 pins its own number in round-4-export.test.ts. Here: the same
	// version and build in iOS, Android and the publik gate, at 1.0.7 or later.
	it("iOS, Android and the publik gate say the same version and build", () => {
		const pbx = raw("apps/mobile/ios/App/App.xcodeproj/project.pbxproj");
		const marketing = [...pbx.matchAll(/MARKETING_VERSION = ([0-9.]+);/g)].map((m) => m[1]);
		const builds = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => m[1]);
		expect(marketing.length).toBe(2);
		expect(new Set(marketing).size).toBe(1);
		expect(new Set(builds).size).toBe(1);
		expect(Number(builds[0])).toBeGreaterThanOrEqual(9);
		const gradle = raw("apps/mobile/android/app/build.gradle");
		expect(/versionCode (\d+)/.exec(gradle)?.[1]).toBe(builds[0]);
		expect(/versionName "([^"]+)"/.exec(gradle)?.[1]).toBe(marketing[0]);
		expect(raw("apps/mobile/src/publik/publik.ts")).toContain(`export const APP_VERSION = "${marketing[0]}";`);
	});
});
