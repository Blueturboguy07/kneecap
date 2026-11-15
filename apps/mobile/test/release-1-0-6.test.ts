/**
 * 1.0.6, before the next blind test. Source checks for the three items:
 *
 *   1. No private API (App Store guideline 2.5.1). The app never names the
 *      private Photos URL scheme or a Settings app scheme, and nothing opens
 *      the Photos app: after an export the sheet says "Saved to Photos" and
 *      has one action, "Share". CI also greps every built iOS app for these
 *      schemes (scripts/check-ios-app.sh, run by mobile-ci.yml).
 *   2. Captions on iOS 26: the SpeechAnalyzer engine follows Apple's asset
 *      steps (device support, supported locale, reserve the locale, then
 *      download and install), the old engine stays as the fallback, and the
 *      panel keeps its plain message when both fail. Info.plist has a true
 *      speech recognition text and no microphone or camera text.
 *   3. flag-icons (MIT) is in docs/THIRD_PARTY_NOTICES.md, and the sheet
 *      header's Close and Saved (bookmark) buttons are at least 44 pt.
 *
 * These checks read the shipped files with the comments taken out.
 *
 * Run: bun test apps/mobile/test
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

const TEXT_FILE = /\.(ts|tsx|js|mjs|cjs|swift|kt|java|xml|plist|json|html|css|svg|txt|strings|xcprivacy)$/;

/** Every text file under `dir` (repo-relative), without tests and node_modules. */
function textFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (rel: string) => {
		for (const name of readdirSync(join(REPO, rel))) {
			if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
			const child = `${rel}/${name}`;
			if (statSync(join(REPO, child)).isDirectory()) walk(child);
			else if (TEXT_FILE.test(name)) out.push(child);
		}
	};
	walk(dir);
	return out;
}

const APP_SOURCES = [
	"apps/mobile/src",
	"apps/mobile/public",
	"apps/mobile/ios/App/App",
	"apps/mobile/android/app/src/main",
	"packages/mobile-ui/src",
	"packages/native-bridge/src",
];

describe("1.0.6 item 1: no private URL scheme, nothing opens the Photos app", () => {
	it("no app source file names photos-redirect, prefs: or App-Prefs:, or has an openPhotos method", () => {
		const hits: string[] = [];
		let files = 0;
		for (const dir of APP_SOURCES) {
			for (const file of textFiles(dir)) {
				files += 1;
				const text = raw(file);
				if (/photos-redirect|prefs:/i.test(text)) hits.push(`${file}: private URL scheme`);
				if (/openPhotos/.test(text)) hits.push(`${file}: openPhotos`);
			}
		}
		expect(files).toBeGreaterThan(100);
		expect(hits).toEqual([]);
	});

	it("after a save the export sheet has one action, Share", () => {
		const sheet = code("packages/mobile-ui/src/components/panels/export-sheet.tsx");
		expect(sheet).toContain('<p className="cc-export-result__title">Saved to Photos</p>');
		const actions = between(sheet, '<div className="cc-export-result__actions">', "</div>");
		expect([...actions.matchAll(/<button\b/g)].length).toBe(1);
		expect(actions).toMatch(/onClick=\{handleShare\}\s*>\s*Share\s*</);
		expect(sheet).not.toContain("Open Photos");
	});

	it("CI greps every built iOS app for the private schemes", () => {
		const check = raw("apps/mobile/scripts/check-ios-app.sh").replace(/^\s*#.*$/gm, "");
		expect(check).toContain(`grep -rliaE 'photos-redirect|prefs:' "$APP"`);
		const ci = raw(".github/workflows/mobile-ci.yml");
		// The Release (iphoneos) store build check and the ios-sim-app-store app.
		expect(ci).toContain("bash ../../scripts/check-ios-app.sh DerivedData/Build/Products/Release-iphoneos/App.app Release");
		expect(between(ci, "APP=DerivedData/Build/Products/Release-iphonesimulator/App.app", "codesign --force")).toContain(
			'bash ../../scripts/check-ios-app.sh "$APP" Release',
		);
	});
});

describe("1.0.6 item 2: captions on iOS 26", () => {
	const swift = code("apps/mobile/ios/App/App/NativeMedia/AppleSpeechTranscriber.swift");

	it("SpeechAnalyzer: device support, supported locale, reserve, then download, then analyze", () => {
		const engine = between(swift, "static func recognizeWithSpeechAnalyzer(", "static func reserveAssetLocale(");
		const steps = [
			"guard SpeechTranscriber.isAvailable else",
			"await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeId))",
			"try await reserveAssetLocale(locale)",
			"try await AssetInventory.assetInstallationRequest(supporting: [transcriber])",
			"try await installRequest.downloadAndInstall()",
			"SpeechAnalyzer(modules: [transcriber])",
		];
		const at = steps.map((step) => engine.indexOf(step));
		for (const [i, index] of at.entries()) expect({ step: steps[i], index }).not.toMatchObject({ index: -1 });
		expect([...at].sort((a, b) => a - b)).toEqual(at);
		const reserve = between(swift, "static func reserveAssetLocale(", "static func recognizeWithBufferRequest(");
		expect(reserve).toContain("await AssetInventory.reservedLocales");
		expect(reserve).toContain("AssetInventory.maximumReservedLocales");
		expect(reserve).toContain("try await AssetInventory.reserve(locale: locale)");
	});

	it("the new engine is iOS 26 only, and the old engine is the fallback", () => {
		expect(swift).toMatch(/@available\(iOS 26\.0, macOS 26\.0, \*\)\s+static func recognizeWithSpeechAnalyzer\(/);
		expect(swift).toMatch(/@available\(iOS 26\.0, macOS 26\.0, \*\)\s+static func reserveAssetLocale\(/);
		const recognize = between(swift, "static func recognize(", "static func recognizeWithSpeechAnalyzer(");
		expect(recognize).toContain("if #available(iOS 26.0, macOS 26.0, *) {");
		expect(between(recognize, "} catch {", "} else {")).toContain("recognizeWithBufferRequest(url: url, localeId: localeId, completion: completion)");
	});

	it("when every clip fails, the panel shows the plain message (no developer text)", () => {
		const actions = code("packages/mobile-ui/src/editor/captions-actions.ts");
		expect(actions).toContain('unreadable: "Captions could not read the sound of your clips. Try again."');
		expect(actions).toMatch(/failures\.length === jobs\.length && failures\.length > 0\) \{\s*throw new Error\(CAPTION_MESSAGES\.unreadable\);/);
	});

	it("Info.plist: a true speech recognition text, and no microphone or camera text", () => {
		const plist = raw("apps/mobile/ios/App/App/Info.plist").replace(/<!--[\s\S]*?-->/g, "");
		const speech = /<key>NSSpeechRecognitionUsageDescription<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? "";
		expect(speech).toContain("on this phone");
		expect(speech).toContain("captions");
		expect(plist).not.toContain("NSMicrophoneUsageDescription");
		expect(plist).not.toContain("NSCameraUsageDescription");
	});
});

describe("1.0.6 item 3: notices and 44 pt buttons", () => {
	it("docs/THIRD_PARTY_NOTICES.md lists flag-icons under MIT", () => {
		const notices = raw("docs/THIRD_PARTY_NOTICES.md");
		const block = between(notices, "### flag-icons", "## NPM / Bun dependencies");
		expect(block).toContain("**License:** MIT");
		expect(block).toContain("lipis/flag-icons");
		expect(block).toContain("Panayiotis Lipiridis");
		expect(block).toContain("apps/mobile/public/flags/LICENSE-flag-icons.txt");
	});

	it("the sheet header's Close and Saved buttons are at least 44 x 44 pt", () => {
		const css = raw("packages/mobile-ui/src/components.css").replace(/\/\*[\s\S]*?\*\//g, "");
		const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) =>
			m[1]!.split(",").map((s) => s.trim()).includes(".cc-sheet-header__icon-btn"),
		);
		const body = rules.map((m) => m[2]).join("\n");
		expect(body).toContain("min-width: var(--cc-touch-target-ios);");
		expect(body).toContain("min-height: var(--cc-touch-target-ios);");
		expect(raw("packages/mobile-ui/src/tokens.css")).toContain("--cc-touch-target-ios: 44px;");
		const header = code("packages/mobile-ui/src/components/sheet-header.tsx");
		for (const label of ["Close", "Saved"]) {
			expect(header).toMatch(new RegExp(`className="cc-sheet-header__icon-btn"[^>]*aria-label="${label}"`));
		}
	});

	it("the version is the same everywhere", () => {
		const pbx = raw("apps/mobile/ios/App/App.xcodeproj/project.pbxproj");
		const marketing = [...pbx.matchAll(/MARKETING_VERSION = ([0-9.]+);/g)].map((m) => m[1]);
		expect(new Set(marketing).size).toBe(1);
		const gradle = raw("apps/mobile/android/app/build.gradle");
		const appVersion = /export const APP_VERSION = "([0-9.]+)";/.exec(raw("apps/mobile/src/publik/publik.ts"))?.[1];
		expect(/versionName "([0-9.]+)"/.exec(gradle)?.[1]).toBe(marketing[0]);
		expect(appVersion).toBe(marketing[0]);
		const build = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => m[1]);
		expect(new Set(build).size).toBe(1);
		expect(/versionCode (\d+)/.exec(gradle)?.[1]).toBe(build[0]);
	});
});
