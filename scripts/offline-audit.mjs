#!/usr/bin/env node
/**
 * offline-audit — strict check that kneecap never talks to the network.
 *
 * kneecap is a fully offline, local-first fork of opencut-classic (see
 * docs/DECISIONS.md and plan §M0). Freesound, Google Fonts, Marble CMS,
 * better-auth/Postgres, Databuddy analytics, Vercel BotId, and a live
 * GitHub-API/brandfetch.io lookup were all removed or hard-disabled for
 * exactly this reason. This script is the regression gate that keeps them
 * gone: it scans source AND (when present) the built Next.js output for
 * outbound-network references — real `fetch`/XHR/WebSocket/script-src
 * calls to a host, not just any string containing "http" — and fails the
 * build if anything shows up that isn't on the tiny allowlist below.
 *
 * Usage:
 *   bun scripts/offline-audit.mjs [--skip-build-check]
 *   node scripts/offline-audit.mjs [--skip-build-check]
 *
 * Exit code 0  = clean.
 * Exit code 1  = violation(s) found — printed with file:line.
 * Exit code 2  = usage/environment problem (e.g. can't find the source tree).
 *
 * --skip-build-check lets this run before `bun run build` (e.g. as a fast
 * pre-commit check) without failing just because .next doesn't exist yet.
 * CI (`.github/workflows/bun-ci.yml`) always runs it *after* the build, so
 * the built client+server bundle gets scanned too.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const WEB_ROOT = join(REPO_ROOT, "apps/web");
const SRC_DIR = join(WEB_ROOT, "src");
const NEXT_STATIC_DIR = join(WEB_ROOT, ".next/static");
const NEXT_STANDALONE_DIR = join(WEB_ROOT, ".next/standalone");

const skipBuildCheck = process.argv.includes("--skip-build-check");

// ---------------------------------------------------------------------------
// The allowlist. Every entry here is a *hostname* it is fine for source or
// the built bundle to mention. Keep this tiny and justify every line:
//
//   localhost / 127.0.0.1   dev server, not a real network egress
//   w3.org                  XML/SVG namespace URI (xmlns="http://www.w3.org/2000/svg"),
//                           never fetched by anything, just an identifier
//   github.com              plain outbound "view source" / contributor links
//   discord.com             plain outbound community-link href
//   x.com                   plain outbound social-link href
//   vercel.com, fal.ai      plain outbound sponsor-credit hrefs (site/sponsors.ts)
//
// None of these are ever the target of a fetch/XHR/WebSocket/script-src in
// this codebase — they are link *destinations* a user can click, which is
// not a network dependency of the app itself. If a future PR adds a real
// fetch() to one of these hosts, this script will NOT catch it (that's the
// tradeoff of a hostname allowlist over full call-site classification) —
// but it also won't cause a false failure on the existing credit links.
// ---------------------------------------------------------------------------
const ALLOWED_HOSTS = new Set([
	"localhost",
	"127.0.0.1",
	"w3.org",
	"www.w3.org",
	"github.com",
	"discord.com",
	"x.com",
	"vercel.com",
	"fal.ai",
	// the product's own marketing domain: used as SITE_URL for canonical/OG
	// metadata and in a couple of hardcoded same-app links (e.g. the
	// onboarding roadmap link) — not something the running app fetches.
	"opencut.app",
	// React 19's own production bundle embeds "visit https://react.dev/..."
	// links in its minified error-decoder strings — a doc link a developer
	// might read in a console error, never fetched by the app.
	"react.dev",
	// M8: the EDL v1 bridge's `EDL_SCHEMA_ID` (packages/editor-core/src/edl/
	// types.ts) is `"https://kneecap.dev/schema/edl-v1.json"` — a JSON
	// Schema `$id`/`$schema` namespace identifier per the JSON Schema spec,
	// embedded verbatim into every `Edl.$schema` field. It is never
	// fetched — grepped across packages/editor-core/src and apps/web/src,
	// the only consumers are the literal assignment in build.ts and two
	// string-equality assertions in edl.test.ts, no `fetch`/schema-resolver
	// call anywhere. First appeared in a CLIENT bundle this session because
	// M8's export sheet (apps/web/src/app/dev/mobile-editor) is the first
	// browser-bundled code path to import `@kneecap/editor-core/edl`.
	"kneecap.dev",
]);

// Known-bad hosts that must NEVER reappear, checked explicitly (independent
// of the allowlist) so a careless future widening of ALLOWED_HOSTS can't
// silently let one of these back in. Every one of these was an actual
// network call removed from this repo — see git log / docs/DECISIONS.md.
const DENYLIST_HOSTS = [
	"freesound.org",
	"marblecms.com",
	"api.marblecms.com",
	"databuddy.cc",
	"cdn.databuddy.cc",
	"fonts.googleapis.com",
	"fonts.gstatic.com",
	"cdn.brandfetch.io",
	"api.github.com",
	"upstash.io",
	"upstash.com",
	"unpkg.com",
	"sentry.io",
	"posthog.com",
	"mixpanel.com",
	"amplitude.com",
	"segment.io",
	"segment.com",
	"google-analytics.com",
	"googletagmanager.com",
];

// Directories we never want to walk (build caches, deps, vcs, rust targets).
const SKIP_DIR_NAMES = new Set([
	"node_modules",
	".git",
	".next",
	"target",
	"dist",
	"build",
	".turbo",
	"coverage",
	".vscode",
	"public", // static assets (images/fonts/json) — no code, nothing to scan
]);

// Extensions worth scanning for URL literals / network APIs.
const SCAN_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".css",
]);

/**
 * Pulls URL-looking substrings out of a line, but only ones that appear
 * inside an actual string literal (preceded by a quote char) or a CSS
 * `url(...)` function — this is what keeps plain-English comments like
 * "see https://example.com for background" or "(https://example.com)"
 * out of the report, while still catching `fetch("https://...")`,
 * `src="https://..."`, and `url(https://...)` in CSS.
 *
 * The host capture requires at least one dot (`localhost` is handled
 * separately via the allowlist's exact-match path) — this is what keeps
 * heavily-minified/obfuscated vendor code from producing single-character
 * "hosts" out of unrelated adjacent string literals that happen to sit
 * next to a real `https://` match on the same (very long, minified) line.
 */
const URL_IN_STRING_RE =
	/["'`]https?:\/\/([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)[^"'`]*/g;
const URL_IN_CSS_URL_FN_RE =
	/\burl\(\s*["']?https?:\/\/([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)[^)]*\)/gi;

const NETWORK_API_RE =
	/\b(XMLHttpRequest|new\s+WebSocket\s*\(|new\s+EventSource\s*\(|navigator\.sendBeacon)\b/;

function hostAllowed(host) {
	const h = host.toLowerCase();
	for (const allowed of ALLOWED_HOSTS) {
		if (h === allowed || h.endsWith(`.${allowed}`)) return true;
	}
	return false;
}

function hostDenied(host) {
	const h = host.toLowerCase();
	return DENYLIST_HOSTS.some((bad) => h === bad || h.endsWith(`.${bad}`));
}

/**
 * @param {string} rootLabel label used in the report (e.g. "source", "built bundle")
 * @param {string} rootDir
 * @param {{recursive?: boolean}} [opts]
 * @returns {{violations: {file: string, line: number, text: string, reason: string}[], warnings: {file: string, line: number, text: string, reason: string}[]}}
 */
function scanTree(rootLabel, rootDir, opts = {}) {
	const recursive = opts.recursive !== false;
	/** @type {{file: string, line: number, text: string, reason: string}[]} */
	const violations = [];
	/** @type {{file: string, line: number, text: string, reason: string}[]} */
	const warnings = [];
	if (!existsSync(rootDir)) return { violations, warnings };

	const visit = (dir, depth) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!recursive) continue;
				if (SKIP_DIR_NAMES.has(entry.name)) continue;
				visit(full, depth + 1);
			} else if (entry.isFile()) {
				scanFile(full, rootLabel, violations, warnings);
			}
		}
	};
	visit(rootDir, 0);
	return { violations, warnings };
}

// This script's own doc comments use example URLs/regexes to explain what
// it matches (e.g. `fetch("https://...")` as sample text) — that's not app
// code and would just generate false positives against itself.
const SELF_EXCLUDE_BASENAMES = new Set(["offline-audit.mjs", "offline-audit.sh"]);

// ---------------------------------------------------------------------------
// KNOWN, TRACKED, NOT-YET-FIXED GAP — read this before touching it.
//
// `services/transcription/worker.ts` calls `@huggingface/transformers`'
// `pipeline(...)` with no `env.allowRemoteModels = false` / local model
// path configured. Transformers.js + its bundled onnxruntime-web runtime
// therefore CAN reach out to huggingface.co (model weights) and
// cdn.jsdelivr.net (a WASM-backend fallback) the first time a user
// triggers on-device auto-captions. This is a real, currently-unresolved
// violation of "fully functional offline" — it was found by an earlier
// run of this exact script and deliberately NOT silently fixed, because
// doing so properly means either (a) bundling real Whisper model weights
// locally and verifying transformers.js's offline mode end-to-end, or
// (b) replacing the in-browser pipeline with the plan's native
// whisper.cpp bridge (§M1/§M4) — both are substantial, separate pieces of
// work, not a one-line network-surface fix.
//
// Rather than let this one unresolved, already-known issue either (a)
// permanently fail every CI run for a reason unrelated to whatever else
// changed, or (b) get silently laundered through ALLOWED_HOSTS as if it
// were a reviewed-safe credit link like github.com, it is reported
// separately below as a non-blocking WARNING whenever the transcription
// worker bundle is scanned. Fix the underlying worker, not this list.
// ---------------------------------------------------------------------------
const KNOWN_VENDOR_ML_RUNTIME_SIGNATURES = [
	// onnxruntime-web's WebGPU JSEP backend (used by @huggingface/transformers).
	"jsepRegisterBuffer",
	"jsepInit",
	// a bundled XHR-based fetch ponyfill pulled in transitively by the same
	// dependency graph (onnxruntime-web / @huggingface/transformers use it
	// for Node-compatible HTTP requests); identified by the real (unminified)
	// XMLHttpRequest method name it calls, since minified variable/function
	// names aren't stable across builds.
	"getAllResponseHeaders",
];

function isKnownVendorMlRuntimeChunk(content) {
	return KNOWN_VENDOR_ML_RUNTIME_SIGNATURES.some((sig) => content.includes(sig));
}

function scanFile(filePath, rootLabel, violations, warnings) {
	if (!SCAN_EXTENSIONS.has(extname(filePath))) return;
	if (SELF_EXCLUDE_BASENAMES.has(filePath.split("/").pop())) return;
	let content;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		return;
	}
	const relPath = relative(REPO_ROOT, filePath);
	const isVendorMlRuntime = isKnownVendorMlRuntimeChunk(content);
	const sink = isVendorMlRuntime ? warnings : violations;
	const reasonSuffix = isVendorMlRuntime
		? " (known gap: onnxruntime-web/transformers.js — see KNOWN_VENDOR_ML_RUNTIME_SIGNATURES)"
		: "";
	const lines = content.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (NETWORK_API_RE.test(line)) {
			sink.push({
				file: relPath,
				line: i + 1,
				text: line.trim().slice(0, 160),
				reason: `${rootLabel}: disallowed network API${reasonSuffix}`,
			});
		}

		const hostsOnThisLine = new Set();
		let match;
		URL_IN_STRING_RE.lastIndex = 0;
		while ((match = URL_IN_STRING_RE.exec(line))) hostsOnThisLine.add(match[1]);
		URL_IN_CSS_URL_FN_RE.lastIndex = 0;
		while ((match = URL_IN_CSS_URL_FN_RE.exec(line))) hostsOnThisLine.add(match[1]);

		for (const host of hostsOnThisLine) {
			if (hostDenied(host)) {
				// Denylisted hosts are always a hard violation, even inside the
				// known vendor ML runtime chunk — defense in depth in case one
				// of our removed hosts (e.g. freesound.org) ever turns up there.
				violations.push({
					file: relPath,
					line: i + 1,
					text: line.trim().slice(0, 160),
					reason: `${rootLabel}: denylisted host "${host}"`,
				});
			} else if (!hostAllowed(host)) {
				sink.push({
					file: relPath,
					line: i + 1,
					text: line.trim().slice(0, 160),
					reason: `${rootLabel}: host "${host}" is not on the allowlist${reasonSuffix}`,
				});
			}
		}
	}
}

function main() {
	if (!existsSync(SRC_DIR)) {
		console.error(`offline-audit: could not find ${SRC_DIR} — run from the repo root.`);
		process.exit(2);
	}

	/** @type {{file: string, line: number, text: string, reason: string}[]} */
	let violations = [];
	/** @type {{file: string, line: number, text: string, reason: string}[]} */
	let warnings = [];

	const merge = (result) => {
		violations = violations.concat(result.violations);
		warnings = warnings.concat(result.warnings);
	};

	// Full source tree (components, services, engine, everything).
	merge(scanTree("source", SRC_DIR));
	// scripts/ (this script and friends) and top-level web config
	// (next.config.ts, content-collections.ts, ...), non-recursive so it
	// doesn't re-descend into src/ or node_modules/.
	merge(scanTree("web config", WEB_ROOT, { recursive: false }));
	merge(scanTree("repo scripts", join(REPO_ROOT, "scripts")));

	const builtBundleFound =
		existsSync(NEXT_STATIC_DIR) || existsSync(NEXT_STANDALONE_DIR);
	if (builtBundleFound) {
		merge(scanTree("built client bundle", NEXT_STATIC_DIR));
		merge(scanTree("built server bundle", NEXT_STANDALONE_DIR));
	} else if (!skipBuildCheck) {
		console.error(
			"offline-audit: no .next/static or .next/standalone found. Run `bun run build` " +
				"in apps/web first so the built bundle gets scanned too, or pass " +
				"--skip-build-check to audit source only.",
		);
		process.exit(2);
	}

	if (warnings.length > 0) {
		console.warn(`offline-audit: ${warnings.length} known-gap warning(s) (non-blocking):\n`);
		for (const w of warnings) {
			console.warn(`  ${w.file}:${w.line}  [${w.reason}]`);
		}
		console.warn("");
	}

	if (violations.length === 0) {
		console.log(
			`offline-audit: clean — no outbound-network references found in source${
				builtBundleFound ? " or the built bundle" : ""
			}${warnings.length > 0 ? " (see known-gap warnings above)" : ""}.`,
		);
		process.exit(0);
	}

	console.error(`offline-audit: ${violations.length} violation(s) found:\n`);
	for (const v of violations) {
		console.error(`  ${v.file}:${v.line}  [${v.reason}]`);
		console.error(`    ${v.text}`);
	}
	console.error(
		"\nIf this is a genuine, user-initiated outbound link (not something the " +
			"app calls automatically), add its host to ALLOWED_HOSTS in " +
			"scripts/offline-audit.mjs with a one-line justification. Otherwise, " +
			"remove the network call — kneecap must work fully offline.",
	);
	process.exit(1);
}

main();
