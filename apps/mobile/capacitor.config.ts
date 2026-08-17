import type { CapacitorConfig } from "@capacitor/cli";

/**
 * kneecap M3 — Capacitor 8 shell config.
 *
 * appId/appName are the "original name" plan §8.2 requires (never CapCut-
 * adjacent). `webDir: "www"` is the LOCALLY BUNDLED static build the app
 * ships — plan M3 item 2: "No remote loading of the editor bundle: Apple
 * 2.5.2 forbids downloading code that changes app functionality." `www/` is
 * produced by `bun run build` (Vite) from `src/`; nothing in this config
 * points at a dev server or a remote URL.
 *
 * `server.hostname` matches plan M3 item 3's literal wording — "Android
 * System WebView via WebViewAssetLoader over
 * https://appassets.androidplatform.net so we get a proper secure-context
 * origin, not file://". Capacitor's own Android bridge already serves local
 * assets through androidx's WebViewAssetLoader by default (over
 * https://localhost, also a secure context, also not file://); this just
 * makes the hostname match the plan's cited value exactly rather than rely
 * on Capacitor's default being "close enough."
 *
 * iOS needs no equivalent override: Capacitor's WKWebView integration
 * already satisfies Apple 2.5.6 (WKWebView, not the deprecated UIWebView) and
 * already avoids file:// by construction — there is no bundled iOS analogue
 * to appassets.androidplatform.net to opt into.
 */
const config: CapacitorConfig = {
	appId: "dev.kneecap.app",
	appName: "kneecap",
	webDir: "www",
	android: {
		allowMixedContent: false,
	},
	server: {
		hostname: "appassets.androidplatform.net",
		androidScheme: "https",
		// No `url` field: that is exactly the "remote loading" plan M3 item 2
		// forbids. If this ever gets set to a remote URL, the app would be
		// loading code over the network — an offline-first-directive violation,
		// not just an App Review risk.
	},
};

export default config;
