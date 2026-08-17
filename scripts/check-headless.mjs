#!/usr/bin/env bun
/**
 * check-headless.mjs — the import gate for `@kneecap/editor-core` (plan M2).
 *
 * Plan M2 exit criterion:
 *   "`packages/editor-core` has zero imports of `next`, `next/*`,
 *    `react-dom/server`, `drizzle`, `pg`, `better-auth`. Enforced by a CI grep
 *    gate."
 *
 * This is that gate, widened to the whole UI-framework surface (React itself,
 * the component/state/icon libraries, and the Cloudflare/Next server adapters),
 * because the failure mode M2 is guarding against is not "someone typed
 * `import next`" — it is the quiet kind that actually happened in this repo: a
 * barrel file re-exporting one .tsx component, which dragged react + zustand +
 * six UI components into EditorCore's transitive closure without a single
 * obviously-wrong import line.
 *
 * TWO GATES, and the second is the load-bearing one:
 *
 *   1. This script — a fast, readable, per-file scan. Catches the direct
 *      import and names the offending line.
 *   2. `bunx tsc --noEmit` inside packages/editor-core, whose tsconfig maps
 *      `@/*` to its OWN src only. If any engine file still reaches back into
 *      apps/web, that specifier cannot resolve and the type-check fails. That
 *      is a whole-graph structural proof, not a pattern match, and
 *      scripts/invariants.sh runs it as a separate strict step.
 *
 * WHAT IS DELIBERATELY ALLOWED:
 *   - DOM APIs and lib.dom types. The engine runs inside a WKWebView / Android
 *     WebView and legitimately uses Canvas, OffscreenCanvas, WebCodecs,
 *     IndexedDB, File/Blob, WebGL/WebGPU. "Headless" here means no UI
 *     FRAMEWORK, not no browser platform. (Plan §2.2: the webview owns the
 *     render tree and preview compositing.)
 *   - `packages/editor-core/react/` — the useSyncExternalStore bridge, ported
 *     verbatim per plan M2 item 3. It is the single React-aware file and lives
 *     outside src/ precisely so this gate can be absolute about src/.
 *
 * Usage:  bun scripts/check-headless.mjs
 * Exit:   0 clean, 1 violations found.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const PKG = path.join(REPO_ROOT, "packages/editor-core");
const SRC = path.join(PKG, "src");
const REACT_DIR = path.join(PKG, "react");

/**
 * Bare specifiers banned from packages/editor-core/src.
 * Each entry matches the specifier exactly or as a `<name>/...` prefix.
 */
const BANNED_EXACT_OR_PREFIX = [
	// --- UI framework (the whole point) ---
	"react",
	"react-dom",
	"next",
	"next-themes",
	// --- Named explicitly in the plan M2 exit criterion ---
	"drizzle-orm",
	"drizzle-kit",
	"pg",
	"better-auth",
	// --- Server / deploy adapters: a headless engine must not know about these
	"@opennextjs/cloudflare",
	"wrangler",
	// --- Component, state, icon and animation libraries -------------------
	"@radix-ui",
	"radix-ui",
	"lucide-react",
	"@hugeicons/react",
	"@hugeicons/core-free-icons",
	"class-variance-authority",
	"tailwind-merge",
	"tailwindcss",
	"clsx",
	"cmdk",
	"motion",
	"framer-motion",
	"sonner",
	"zustand",
	"@hello-pangea/dnd",
	"react-window",
	"react-hook-form",
	"react-day-picker",
	"react-icons",
	"react-markdown",
	"react-resizable-panels",
	"embla-carousel-react",
	"input-otp",
	"wavesurfer.js",
	"use-deep-compare-effect",
];

/** Allowed in packages/editor-core/react only. */
const REACT_DIR_ALLOWED = new Set(["react"]);

const IMPORT_RE =
	/(?:^|\n)\s*(?:import|export)\s+(?:[^;'"]*?\sfrom\s+)?["']([^"']+)["']/g;
const DYNAMIC_RE = /import\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_RE = /require\(\s*["']([^"']+)["']\s*\)/g;

function walk(dir, out = []) {
	if (!fs.existsSync(dir)) return out;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) out.push(full);
	}
	return out;
}

function specifiersOf(text) {
	const found = [];
	for (const re of [IMPORT_RE, DYNAMIC_RE, REQUIRE_RE]) {
		re.lastIndex = 0;
		for (const m of text.matchAll(re)) found.push(m[1]);
	}
	return found;
}

function isBanned(spec) {
	return BANNED_EXACT_OR_PREFIX.some(
		(banned) => spec === banned || spec.startsWith(`${banned}/`),
	);
}

function lineOf(text, spec) {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].includes(`"${spec}"`) || lines[i].includes(`'${spec}'`)) {
			return { line: i + 1, text: lines[i].trim() };
		}
	}
	return { line: 0, text: "" };
}

const violations = [];

if (!fs.existsSync(SRC)) {
	console.error(
		`check-headless: ${path.relative(REPO_ROOT, SRC)} does not exist.`,
	);
	process.exit(1);
}

// --- Rule 1: no .tsx anywhere under src/ ------------------------------------
// JSX in the engine is the single clearest signal the boundary has been
// crossed, and it is how the pre-M2 leak manifested.
for (const file of walk(SRC)) {
	if (file.endsWith(".tsx") || file.endsWith(".jsx")) {
		violations.push({
			file: path.relative(REPO_ROOT, file),
			line: 0,
			reason: "JSX file inside the headless engine (src/ must be .ts only)",
			snippet: "",
		});
	}
}

// --- Rule 2: banned bare specifiers under src/ ------------------------------
for (const file of walk(SRC)) {
	const text = fs.readFileSync(file, "utf8");
	for (const spec of specifiersOf(text)) {
		if (spec.startsWith(".") || spec.startsWith("@/")) continue;
		if (!isBanned(spec)) continue;
		const { line, text: snippet } = lineOf(text, spec);
		violations.push({
			file: path.relative(REPO_ROOT, file),
			line,
			reason: `banned UI/server dependency "${spec}" in the headless engine`,
			snippet,
		});
	}
}

// --- Rule 3: no escaping the package via relative paths ---------------------
// `@/` escapes are already impossible (the package tsconfig maps it to its own
// src), but a literal `../../../apps/web/...` would slip past that.
for (const file of walk(PKG)) {
	const text = fs.readFileSync(file, "utf8");
	for (const spec of specifiersOf(text)) {
		if (!spec.startsWith(".")) continue;
		const resolved = path.resolve(path.dirname(file), spec);
		if (resolved.startsWith(PKG + path.sep)) continue;
		const { line, text: snippet } = lineOf(text, spec);
		violations.push({
			file: path.relative(REPO_ROOT, file),
			line,
			reason: `relative import escapes packages/editor-core ("${spec}")`,
			snippet,
		});
	}
}

// --- Rule 4: the react/ bridge may import react and nothing else framework-y
for (const file of walk(REACT_DIR)) {
	const text = fs.readFileSync(file, "utf8");
	for (const spec of specifiersOf(text)) {
		if (spec.startsWith(".") || spec.startsWith("@/")) continue;
		if (REACT_DIR_ALLOWED.has(spec)) continue;
		if (!isBanned(spec)) continue;
		const { line, text: snippet } = lineOf(text, spec);
		violations.push({
			file: path.relative(REPO_ROOT, file),
			line,
			reason: `packages/editor-core/react may only import "react" itself, not "${spec}"`,
			snippet,
		});
	}
}

const scanned = walk(PKG).length;

if (violations.length === 0) {
	console.log(
		`check-headless: clean — ${scanned} file(s) in packages/editor-core, ` +
			`0 UI-framework or server imports in src/.`,
	);
	process.exit(0);
}

console.error(
	`check-headless: ${violations.length} violation(s) in packages/editor-core:\n`,
);
for (const v of violations) {
	console.error(`  ${v.file}${v.line ? `:${v.line}` : ""}`);
	console.error(`    ${v.reason}`);
	if (v.snippet) console.error(`    > ${v.snippet}`);
	console.error("");
}
console.error(
	"The engine must stay framework-agnostic (plan M2). Move the UI-facing code\n" +
		"into apps/web (or a future packages/mobile-ui) and have the engine expose a\n" +
		"port the host installs — see core/notifications.ts and masksRegistry.setIcon()\n" +
		"for the two patterns already used here.",
);
process.exit(1);
