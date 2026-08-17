import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

const editorCoreSrc = fileURLToPath(
	new URL("../../packages/editor-core/src", import.meta.url),
);

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
 * spike (see that file's and apps/mobile/src/main.ts's own comments).
 */
export default defineConfig({
	root: __dirname,
	plugins: [wasm()],
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
			input: {
				main: "index.html",
				spike: "spike.html",
			},
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
});
