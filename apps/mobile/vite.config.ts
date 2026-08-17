import { defineConfig } from "vite";

/**
 * kneecap M3 — builds apps/mobile/src into apps/mobile/www, the static
 * bundle Capacitor packages into both native apps (plan M3 item 2: bundled
 * locally, never loaded from a dev server or a remote URL at runtime).
 */
export default defineConfig({
	root: __dirname,
	build: {
		outDir: "www",
		emptyOutDir: true,
		// Keep this readable in `git diff`-adjacent debugging for now; revisit
		// once this harness is replaced by the real M2-item-6 SPA bundle.
		minify: false,
	},
	server: {
		// `bun run dev` here is a plain browser preview of the harness only —
		// never something a packaged app points at (plan M3 item 2).
		port: 5183,
	},
});
