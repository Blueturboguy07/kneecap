/**
 * Blind test round 2 (1.0.5): the two export items that a source check can
 * prove. The editor test in the iOS CI job (scripts/ios-sim-editor-test.py)
 * proves the export on a simulator; verify-export-pipeline (Swift, run by
 * hand on a Mac) and the Android JVM test EdlTimelineEndTest prove the
 * timeline end with real numbers. These checks read the shipped files with
 * the comments taken out.
 *
 *   Item 2: the end of an export. The sheet awaits a real Photos save
 *           (add-only access, asked at the save) and shows "Saved to
 *           Photos" with Open Photos and Share, or "Could not save to
 *           Photos." with one plain sentence and Share.
 *   Item 3: the export is as long as the timeline. A text, sticker or
 *           overlay that runs past the last media clip is in the video, over
 *           the canvas colour; a project with only text exports.
 *
 * Run: bun test apps/mobile/test
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
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
/** The text from `start` up to (not including) the next `end` after it. */
function between(text: string, start: string, end: string): string {
	const from = text.indexOf(start);
	expect(from).toBeGreaterThanOrEqual(0);
	const to = text.indexOf(end, from + start.length);
	expect(to).toBeGreaterThan(from);
	return text.slice(from, to);
}

const IOS = "apps/mobile/ios/App/App";
const ANDROID = "apps/mobile/android/app/src";

describe("item 2: the end of an export (iOS)", () => {
	const exportSwift = code(`${IOS}/NativeBridgePlugin+Export.swift`);

	it("no fire-and-forget Photos save after done", () => {
		expect(exportSwift).not.toContain("saveToPhotosLibraryBestEffort");
		// From the "done" event to the catch of the export task: no Task and no Photos call.
		const afterDone = between(exportSwift, 'stage: "done"', "} catch {");
		expect(afterDone).not.toContain("Task {");
		expect(afterDone).not.toContain("PHPhotoLibrary");
	});

	it("saveToPhotos asks for add-only access at the save, awaits it and answers saved, denied or failed", () => {
		const save = exportSwift.slice(exportSwift.indexOf("static func saveVideoToPhotos("));
		expect(save).toContain("PHPhotoLibrary.authorizationStatus(for: .addOnly)");
		expect(save).toContain("PHPhotoLibrary.requestAuthorization(for: .addOnly)");
		expect(save).toMatch(/try await PHPhotoLibrary\.shared\(\)\.performChanges/);
		expect(save).toContain("creationRequestForAssetFromVideo(atFileURL:");
		const method = between(exportSwift, "@objc func saveToPhotos(", "@objc func shareFile(");
		expect(method).toContain("await Self.saveVideoToPhotos(");
		expect(method).toContain('call.resolve(["saved": true])');
		expect(method).toContain('call.resolve(["saved": false, "reason": "denied"])');
		expect(method).toContain('call.resolve(["saved": false, "reason": "failed"])');
	});

	it("shareFile and openPhotos exist and take only a finished export", () => {
		expect(exportSwift).toContain("UIActivityViewController(activityItems: [fileURL]");
		expect(exportSwift).toContain('URL(string: "photos-redirect://")');
		expect(exportSwift).toContain('exportedFileURL(call, method: "saveToPhotos")');
		expect(exportSwift).toContain('exportedFileURL(call, method: "shareFile")');
		expect(between(exportSwift, "private func exportedFileURL(", "\n    }\n")).toContain("MediaSandbox.exportsDirectory()");
	});

	it("the three methods are registered, and Info.plist has the add-only Photos text", () => {
		const plugin = code(`${IOS}/NativeBridgePlugin.swift`);
		for (const name of ["saveToPhotos", "shareFile", "openPhotos"]) {
			expect(plugin).toContain(`CAPPluginMethod(name: "${name}", returnType: CAPPluginReturnPromise)`);
		}
		expect(raw(`${IOS}/Info.plist`)).toMatch(/<key>NSPhotoLibraryAddUsageDescription<\/key>\s*<string>[^<]+<\/string>/);
	});
});

describe("item 2: the end of an export (Android)", () => {
	const plugin = code(`${ANDROID}/main/java/dev/kneecap/app/NativeBridgePlugin.kt`);

	it("saveToPhotos copies the video into MediaStore and answers saved or failed", () => {
		const save = between(plugin, "fun saveToPhotos(", "fun shareFile(");
		expect(save).toContain("MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)");
		expect(save).toContain("MediaStore.MediaColumns.IS_PENDING");
		expect(save).toContain('result.put("saved", true)');
		expect(save).toContain('result.put("reason", "failed")');
	});

	it("shareFile and openPhotos are plugin methods", () => {
		expect(plugin).toMatch(/@PluginMethod\s+fun saveToPhotos\(call: PluginCall\)/);
		expect(plugin).toMatch(/@PluginMethod\s+fun shareFile\(call: PluginCall\)/);
		expect(plugin).toMatch(/@PluginMethod\s+fun openPhotos\(call: PluginCall\)/);
		expect(plugin).toContain('FileProvider.getUriForFile(context, "${context.packageName}.fileprovider"');
		expect(plugin).toContain("Intent.ACTION_SEND");
	});
});

describe("item 2: the bridge", () => {
	it("types.ts declares saveToPhotos, shareFile and openPhotos", () => {
		const types = code("packages/native-bridge/src/types.ts");
		expect(types).toContain('export type SaveToPhotosFailure = "denied" | "failed";');
		expect(types).toMatch(/export interface SaveToPhotosResult \{\s*saved: boolean;\s*reason\?: SaveToPhotosFailure;\s*\}/);
		expect(types).toContain("saveToPhotos(params: { uri: string }): Promise<SaveToPhotosResult>;");
		expect(types).toContain("shareFile(params: { uri: string }): Promise<void>;");
		expect(types).toContain("openPhotos(): Promise<void>;");
	});

	it("the Capacitor bridge sends a native path, and the web fallback fails cleanly", () => {
		const capacitor = code("packages/native-bridge/src/capacitor-bridge.ts");
		for (const name of ["saveToPhotos", "shareFile", "openPhotos"]) {
			expect(capacitor).toMatch(new RegExp(`async ${name}\\(`));
		}
		expect(capacitor).toContain("nativeFilePathFromUri(");
		const web = code("packages/native-bridge/src/web-fallback.ts");
		expect(between(web, "async saveToPhotos(", "async shareFile(")).toContain('return { saved: false, reason: "failed" };');
		expect(between(web, "async shareFile(", "async openPhotos(")).toContain('code: "UNSUPPORTED"');
	});
});

describe("item 2: the export sheet", () => {
	const sheet = code("packages/mobile-ui/src/components/panels/export-sheet.tsx");

	it("saves after done and awaits the answer", () => {
		const done = between(sheet, 'if (event.stage === "done") {', "break;");
		expect(done).toContain("saveExportToPhotos({ bridge, uri: event.outputUri, run })");
		expect(sheet).toContain("const result = await bridge.saveToPhotos({ uri });");
		expect(sheet).toContain("await bridge.shareFile({ uri });");
		expect(sheet).toContain("await bridge.openPhotos();");
	});

	it("shows the result block with the exact words and classes", () => {
		expect(sheet).toContain('className="cc-export-result"');
		expect(sheet).toContain("data-kneecap-export-result={photosSave}");
		expect(sheet).toContain('<p className="cc-export-result__title">Saved to Photos</p>');
		expect(sheet).toContain('<p className="cc-export-result__title">Could not save to Photos.</p>');
		expect(sheet).toMatch(/<p className="cc-export-result__detail">Photos access is off[^<]*Settings\.<\/p>/);
		expect(sheet).toMatch(/className="cc-export-sheet__action cc-export-result__action"\s+onClick=\{handleOpenPhotos\}\s*>\s*Open Photos\s*</);
		expect(sheet).toMatch(/className="cc-export-sheet__action cc-export-result__action"\s+onClick=\{handleShare\}\s*>\s*Share\s*</);
		expect(sheet).toContain('<p className="cc-panel-note">Export failed. Try again.</p>');
		expect(sheet).not.toContain("Export complete.");
	});

	it("Open Photos shows only after a save, and Share is there after a denial or a failed save", () => {
		const actions = between(sheet, '<div className="cc-export-result__actions">', "</div>");
		expect(actions).toMatch(/photosSave === "saved" && \(\s*<button[\s\S]*?Open Photos/);
		expect(actions).toMatch(/canShare && \(\s*<button[\s\S]*?Share/);
		expect(sheet).toMatch(/photosSave !== "saving" && \(\s*<div className="cc-export-result__actions">/);
	});

	it("the CSS block is the last block of components.css", () => {
		const css = raw("packages/mobile-ui/src/components.css");
		const block = css.slice(css.lastIndexOf("/* 1.0.5: export result */"));
		expect(block.length).toBeGreaterThan(30);
		for (const selector of [".cc-export-result {", ".cc-export-result__title {", ".cc-export-result__detail {", ".cc-export-result__actions {", ".cc-export-result__action {"]) {
			expect(block).toContain(selector);
		}
	});
});

describe("item 3: the export is as long as the timeline", () => {
	it("iOS: the duration takes every clip and overlay end, not only the main track", () => {
		const builder = code(`${IOS}/NativeExport/CompositionBuilder.swift`);
		expect(builder).toContain("let totalDurationTicks = max(mainEndTicks, compositionEndTicks, timelineEndTicks)");
		const helper = builder.slice(builder.indexOf("static func timelineEndTicks("));
		expect(helper).toContain("placements.map(\\.insertEndTicks).max()");
		expect(helper).toMatch(/for track in edl\.tracks where track\.kind != "main"/);
		expect(helper).toMatch(/for overlay in edl\.overlays/);
		// The pacer lane covers the whole timeline, so the tail frames are real
		// frames (the canvas colour under the text), not a short file.
		expect(builder).toMatch(/CMTimeMaximum\(lanesEnd, clipsEnd\)/);
	});

	it("iOS: a project with only text exports (no main clip needed)", () => {
		const video = code(`${IOS}/NativeExport/VideoCompositionBuilder.swift`);
		const guard = video.slice(video.indexOf("guard built."), video.indexOf("else {", video.indexOf("guard built.")));
		expect(guard).toContain("built.totalDurationTicks > 0");
		expect(guard).not.toContain("mainPlacements");
	});

	it("iOS: verify-export-pipeline has the text-tail and text-only checks", () => {
		const harness = code("apps/mobile/ios/verify-export-pipeline/main.swift");
		expect(harness).toContain("CompositionBuilder.timelineEndTicks(");
		expect(harness).toMatch(/== 14\. /);
	});

	it("Android: the base sequence runs to the latest clip or overlay end", () => {
		const ticks = code(`${ANDROID}/main/java/dev/kneecap/app/export/EdlTicks.kt`);
		expect(ticks).toContain("fun timelineEndTicks(edl: Edl): Long");
		expect(ticks).toMatch(/for \(overlay in edl\.overlays\)/);
		const composition = code(`${ANDROID}/main/java/dev/kneecap/app/export/EdlToComposition.kt`);
		expect(composition).toContain("val projectEndTicks = maxOf(timelineEndTicks(edl), mainEndTicks)");
		expect(existsSync(join(REPO, `${ANDROID}/test/java/dev/kneecap/app/export/EdlTimelineEndTest.kt`))).toBe(true);
	});
});
