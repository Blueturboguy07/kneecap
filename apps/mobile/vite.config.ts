import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type CSSOptions, defineConfig, type Plugin } from "vite";
import wasm from "vite-plugin-wasm";

const editorCoreSrc = fileURLToPath(
	new URL("../../packages/editor-core/src", import.meta.url),
);

/**
 * The build settings, all read from the build's environment:
 *
 * PUBLIK_GATE_MODE = required | optional (default: required).
 *   required: "Sign in with publik" is the first screen and there is no way
 *   past it (src/publik/publik.ts, ensureSignedIn).
 *   optional: the editor opens without sign-in; "Sign in with publik" is a
 *   row in Settings, and usage counting starts only after a sign-in.
 *   This is the ONE place the mode is set. CI builds both
 *   (.github/workflows/mobile-ci.yml).
 *
 * KNEECAP_DEBUG_TOOLS = 1 (default: off).
 *   Puts the developer tools in the bundle: the #/diagnostics and #/autotest
 *   routes (src/main.ts), spike.html and the spike test videos
 *   (public/spike-assets). A store or release build never sets it, so those
 *   are not in the app (App Store guideline 2.5.19). `bun run dev` always has
 *   them; `bun run build:debug-tools` makes a build with them.
 *
 * PUBLIK_APP_TOKEN = pat_... (CI: the repo secret). A store build (`vite
 *   build` without KNEECAP_DEBUG_TOOLS) FAILS without it: such an app could
 *   never sign in. PUBLIK_ALLOW_NO_TOKEN=1 turns the check off, only for a
 *   fork's pull-request CI (no secrets there). The value is never printed.
 *
 * PUBLIK_TEST_HOOKS = 1 (default: off). The launch setting
 *   PUBLIK_API_BASE_URL may then name any server (CI live tests). Without it,
 *   only a server on this computer or local network (src/publik/publik.ts,
 *   testBaseUrl).
 *
 * APP_STORE_BUILD = 1 (default: off). A build that goes to people: the App
 *   Store build and every release build (release.yml). The build FAILS
 *   (storeBuildProblems) unless:
 *   - PUBLIK_GATE_MODE is required (the optional mode is a CI test artifact
 *     only, founder decision Nov 14 2026);
 *   - PUBLIK_TEST_HOOKS is off (APP_STORE_BUILD and PUBLIK_TEST_HOOKS are
 *     never both on), KNEECAP_DEBUG_TOOLS is off, PUBLIK_ALLOW_NO_TOKEN is off;
 *   - the app token comes only from the CI secret: the build runs in GitHub
 *     Actions, and no .env file in apps/mobile or the repo root sets
 *     PUBLIK_APP_TOKEN (Bun loads those files into the environment, so a
 *     token in such a file would reach the bundle).
 *   The bundle carries the marker "publik-build:store" (src/main.ts); the
 *   iOS "Debug-only items" build phase and the Android release check read it.
 */
const GATE_MODE = (process.env.PUBLIK_GATE_MODE ?? "").trim() || "required";
if (GATE_MODE !== "required" && GATE_MODE !== "optional") {
	throw new Error(`PUBLIK_GATE_MODE must be "required" or "optional", not "${GATE_MODE}".`);
}
const STORE_BUILD = process.env.APP_STORE_BUILD === "1";
const TEST_HOOKS = process.env.PUBLIK_TEST_HOOKS === "1";

/** The .env files (apps/mobile and the repo root) that set PUBLIK_APP_TOKEN. Names only; a value is never read out. */
function envFilesWithToken(): string[] {
	const found: string[] = [];
	for (const dir of [fileURLToPath(new URL(".", import.meta.url)), fileURLToPath(new URL("../..", import.meta.url))]) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			if (!name.startsWith(".env")) continue;
			let text = "";
			try {
				text = readFileSync(`${dir}/${name}`, "utf8");
			} catch {
				continue;
			}
			if (/^\s*(export\s+)?PUBLIK_APP_TOKEN\s*=/m.test(text)) found.push(`${dir}/${name}`);
		}
	}
	return found;
}

/** Why this APP_STORE_BUILD may not be made (empty: it may). */
function storeBuildProblems(command: string, debugTools: boolean): string[] {
	const problems: string[] = [];
	if (command !== "build") problems.push("APP_STORE_BUILD=1 is for `vite build` only.");
	if (GATE_MODE !== "required") {
		problems.push(`APP_STORE_BUILD=1 needs PUBLIK_GATE_MODE=required, not "${GATE_MODE}". The optional gate is a CI test artifact only.`);
	}
	if (TEST_HOOKS) problems.push("APP_STORE_BUILD and PUBLIK_TEST_HOOKS are both on. A store build must not have the publik test hooks.");
	if (debugTools) problems.push("APP_STORE_BUILD=1 with KNEECAP_DEBUG_TOOLS=1: a store build has no developer tools.");
	if (process.env.PUBLIK_ALLOW_NO_TOKEN === "1") problems.push("APP_STORE_BUILD=1 with PUBLIK_ALLOW_NO_TOKEN=1: a store build needs the app token.");
	if (process.env.GITHUB_ACTIONS !== "true") {
		problems.push("APP_STORE_BUILD=1 runs only in GitHub Actions: the app token comes only from the repo secret PUBLIK_APP_TOKEN.");
	}
	const files = envFilesWithToken();
	if (files.length) {
		problems.push(`APP_STORE_BUILD=1, but these files set PUBLIK_APP_TOKEN: ${files.join(", ")}. The token comes only from the CI secret.`);
	}
	return problems;
}

type PostcssOptions = Exclude<NonNullable<CSSOptions["postcss"]>, string>;
type PostcssPlugin = NonNullable<PostcssOptions["plugins"]>[number];

/**
 * Removes CSS comments from the bundle (license comments, `/*! ... *\/`,
 * stay). The source CSS keeps its design notes, which name the reference
 * app; the shipped app must not carry them. JS comments never reach the
 * bundle (esbuild drops them).
 */
const stripCssComments: PostcssPlugin = {
	postcssPlugin: "kneecap-strip-css-comments",
	Once(root) {
		root.walkComments((comment) => {
			if (!comment.text.startsWith("!")) comment.remove();
		});
	},
};

/** A build without KNEECAP_DEBUG_TOOLS: delete the spike test videos that public/ copies into www/. */
function dropDebugAssets(outDir: string): Plugin {
	return {
		name: "kneecap-drop-debug-assets",
		apply: "build",
		closeBundle() {
			rmSync(fileURLToPath(new URL(`${outDir}/spike-assets`, import.meta.url)), {
				recursive: true,
				force: true,
			});
		},
	};
}

/**
 * kneecap M3 (+ M1 spike, see apps/mobile/src/spike/) — builds
 * apps/mobile/src into apps/mobile/www, the static bundle Capacitor packages
 * into both native apps (plan M3 item 2: bundled locally, never loaded from
 * a dev server or a remote URL at runtime).
 *
 * Two pages, one bundle: `index.html` (M3's product placeholder — untouched
 * by the M1 spike) and `spike.html` (the M1 spike's hidden diagnostics
 * screen). Both ship in the same www/ output and therefore the same native
 * app binary; `spike.html` is reachable only via the deep link documented in
 * docs/SPIKE-GUIDE.md, never linked from index.html.
 *
 * `wasm()`: `opencut-wasm` is wasm-bindgen's `--target bundler` output
 * (`import * as wasm from "./opencut_wasm_bg.wasm"` inside its own glue —
 * see that package's opencut_wasm.js), which is the "ESM WebAssembly
 * integration" proposal Vite does not implement natively. `vite-plugin-wasm`
 * is the standard bridge for exactly this wasm-bindgen output shape.
 * `build.target: "esnext"` (below) is what lets the transformed module keep
 * its native top-level `await` instead of Vite trying to downlevel-compile
 * it away — deliberately NOT using the companion `vite-plugin-top-level-await`
 * transform plugin: it crashed at the rendering-chunks stage against this
 * repo's resolved `@swc/core@1.16.0` ("missing field `type`", an
 * AST-version mismatch inside that plugin's own SWC round-trip), and it is
 * unnecessary anyway — this app's platform floors (iOS 17 WKWebView, Android
 * minSdk 29 System WebView, both plan §2.5) are years past every engine's
 * native top-level-await support (Safari 15/2021, Chrome 89/2021), so
 * `esnext` alone is sufficient here.
 *
 * Verified necessary directly in this repo: no prior bundler config anywhere
 * (Next.js's webpack config included) ever solved this —
 * `packages/editor-core/src/services/renderer/compositor/wasm-compositor.ts`
 * has never actually been exercised through a real bundler before the M1
 * spike (see that file's and apps/mobile/src/legacy-harness.ts's own
 * comments).
 *
 * `esbuild.jsx`/`jsxImportSource` (structural-gap fixer pass — this app now
 * mounts `@kneecap/mobile-ui`'s real `EditorShell`, its first host outside
 * apps/web's Next.js dev route): this repo's own `src/**\/*.ts` files never
 * use JSX (see main.ts/legacy-harness.ts's plain-DOM style), but
 * `@kneecap/mobile-ui`'s `.tsx` source ships UNCOMPILED — its package.json
 * `exports` point straight at `./src/*.tsx` — and Vite bundles that source
 * directly, the same way it already bundles `@kneecap/editor-core`'s source
 * (see the `resolve.alias` comment above). Those files use TS's `"jsx":
 * "react-jsx"` automatic-runtime convention (no `import React` in scope —
 * see e.g. editor-shell.tsx), so this app's OWN bundler needs to agree, or
 * the emitted `jsx(...)` calls reference an import that was never added. No
 * `@vitejs/plugin-react` needed for that alone: this app has no Fast Refresh
 * requirement (it only ever runs through `vite build` into a packaged
 * Capacitor shell, never a live dev server a device points at — see the
 * `server.hostname` comment on `capacitor.config.ts`), and esbuild's own
 * `jsx`/`jsxImportSource` transform options, forwarded here, are sufficient
 * for a one-shot build.
 */
export default defineConfig(({ command }) => {
	const debugTools = command === "serve" || process.env.KNEECAP_DEBUG_TOOLS === "1";
	if (STORE_BUILD) {
		const problems = storeBuildProblems(command, debugTools);
		if (problems.length) throw new Error(`This APP_STORE_BUILD cannot be made:\n- ${problems.join("\n- ")}`);
	}
	const appToken = process.env.PUBLIK_APP_TOKEN?.trim() ?? "";
	if (command === "build" && !debugTools && !appToken.startsWith("pat_") && process.env.PUBLIK_ALLOW_NO_TOKEN !== "1") {
		throw new Error(
			"PUBLIK_APP_TOKEN is not set, or it does not start with pat_. A store build without it cannot sign in. " +
				"Set PUBLIK_APP_TOKEN (CI: the repo secret). Only a fork's pull-request CI may set PUBLIK_ALLOW_NO_TOKEN=1.",
		);
	}
	return {
		root: __dirname,
		plugins: debugTools ? [wasm()] : [wasm(), dropDebugAssets("www")],
		css: {
			postcss: { plugins: [stripCssComments] },
		},
		// Sign in with publik (src/publik/publik.ts): the publik app token
		// (`pat_`) comes from PUBLIK_APP_TOKEN in the build's environment (CI
		// passes the repo secret of that name). It is public by design: it only
		// mints capped install keys for this app. A build without it shows
		// "This build has no publik app token." at the gate.
		define: {
			__PUBLIK_APP_TOKEN__: JSON.stringify(appToken),
			__PUBLIK_GATE_MODE__: JSON.stringify(GATE_MODE),
			__PUBLIK_GATE_MARKER__: JSON.stringify(`publik-gate-mode:${GATE_MODE}`),
			__PUBLIK_TEST_HOOKS__: JSON.stringify(TEST_HOOKS),
			// "publik-build:store" (APP_STORE_BUILD=1), "publik-build:test-hooks"
			// (PUBLIK_TEST_HOOKS=1) or "publik-build:plain" (src/main.ts). The iOS
			// build phase, the Android release check and scripts/check-web-bundle.sh read it.
			__PUBLIK_BUILD_MARKER__: JSON.stringify(`publik-build:${STORE_BUILD ? "store" : TEST_HOOKS ? "test-hooks" : "plain"}`),
			__KNEECAP_DEBUG_TOOLS__: JSON.stringify(debugTools),
		},
		esbuild: {
			jsx: "automatic",
			jsxImportSource: "react",
		},
		resolve: {
			// Mirrors apps/web/tsconfig.json's "@/*" mapping: packages/editor-core's
			// OWN source uses this alias internally (its tsconfig.json maps "@/*"
			// to "./src/*" for a standalone `tsc --noEmit` self-containment proof —
			// see that package's index.ts header), so any host bundling
			// editor-core's source directly (as this app does, and as apps/web
			// does) must resolve the same alias.
			alias: {
				"@": editorCoreSrc,
			},
		},
		build: {
			outDir: "www",
			emptyOutDir: true,
			target: "esnext",
			// Keep this readable in `git diff`-adjacent debugging for now; revisit
			// once this harness is replaced by the real M2-item-6 SPA bundle.
			minify: false,
			rollupOptions: {
				// spike.html (the M1 spike's diagnostics screen) is a developer
				// tool: only a KNEECAP_DEBUG_TOOLS build has it.
				input: debugTools
					? ({ main: "index.html", spike: "spike.html" } as Record<string, string>)
					: ({ main: "index.html" } as Record<string, string>),
			},
		},
		worker: {
			format: "es",
			plugins: () => [wasm()],
		},
		optimizeDeps: {
			// wasm-bindgen bundler-target output must not be pre-bundled by esbuild
			// (it doesn't understand the `.wasm` ESM import either) — same
			// exclusion vite-plugin-wasm's own docs recommend.
			exclude: ["opencut-wasm"],
		},
		server: {
			// `bun run dev` here is a plain browser preview of the harness only —
			// never something a packaged app points at (plan M3 item 2).
			port: 5183,
		},
	};
});
