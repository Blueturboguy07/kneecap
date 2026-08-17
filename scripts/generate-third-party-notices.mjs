#!/usr/bin/env node
/**
 * generate-third-party-notices — walks the resolved dependency tree in
 * bun.lock (the authoritative post-prune graph — NOT node_modules, which
 * can carry stale directories from packages removed by an earlier `bun
 * install` and not yet pruned by a fresh one) and emits a license summary
 * as a Markdown fragment.
 *
 * This covers the npm/Bun (JS/TS) dependency tree only. Rust crates
 * (rust/crates/*, rust/wasm) are a separate ecosystem with their own
 * license metadata (`cargo metadata` / Cargo.lock); auditing that tree
 * needs `cargo` on PATH and is tracked as a follow-up rather than done
 * here (see the note this script prints at the end, and docs/DECISIONS.md).
 *
 * Usage:
 *   bun scripts/generate-third-party-notices.mjs > /tmp/npm-notices.md
 *   node scripts/generate-third-party-notices.mjs
 *
 * Re-run whenever bun.lock changes materially (new/removed/upgraded
 * dependency) and paste the output back into
 * docs/THIRD_PARTY_NOTICES.md's "## NPM / Bun dependencies" section.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const LOCK_PATH = join(REPO_ROOT, "bun.lock");
const NODE_MODULES = join(REPO_ROOT, "node_modules");
const BUN_STORE = join(NODE_MODULES, ".bun");

function parseBunLock(text) {
	// bun.lock is JSON5-ish (allows trailing commas before } or ]).
	// This lockfile has no strings that contain a literal ",}" or ",]"
	// sequence (checked), so a scoped strip is safe here.
	const stripped = text.replace(/,(\s*[}\]])/g, "$1");
	return JSON.parse(stripped);
}

/**
 * Bun's isolated node-linker flattens a scoped package like
 * "@radix-ui/react-dialog@1.1.15" into a store directory named
 * "@radix-ui+react-dialog@1.1.15+<contentHash>" — the trailing "+hash"
 * disambiguates multiple dependency-graph instances of the exact same
 * name@version and is NOT derivable from bun.lock, so store dirs are
 * looked up by prefix against a directory listing taken once up front
 * (see buildStoreIndex), rather than joined as an exact path.
 */
function storeDirPrefixFor(name, version) {
	return `${name.replace(/\//g, "+")}@${version}`;
}

/** @type {Map<string, string> | null} */
let storeIndex = null;
function buildStoreIndex() {
	if (storeIndex) return storeIndex;
	storeIndex = new Map();
	if (!existsSync(BUN_STORE)) return storeIndex;
	for (const entry of readdirSync(BUN_STORE, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		// Strip a trailing "+<hex>" content-hash suffix, if present, back to
		// the plain "name@version" prefix used as the lookup key. Only the
		// first match wins per prefix — all instances of the same
		// name@version carry the same package.json/license regardless of
		// which dependency-graph copy you land on, so this is safe.
		const key = entry.name.replace(/\+[0-9a-f]+$/i, "");
		if (!storeIndex.has(key)) storeIndex.set(key, entry.name);
	}
	return storeIndex;
}

function readLicense(name, version) {
	const index = buildStoreIndex();
	const storeDirName = index.get(storeDirPrefixFor(name, version));
	const candidates = [
		storeDirName
			? join(BUN_STORE, storeDirName, "node_modules", name, "package.json")
			: null,
		join(NODE_MODULES, name, "package.json"),
	].filter(Boolean);
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		try {
			const pkg = JSON.parse(readFileSync(candidate, "utf8"));
			if (typeof pkg.license === "string" && pkg.license.length > 0) {
				return pkg.license;
			}
			if (pkg.license && typeof pkg.license === "object" && pkg.license.type) {
				return pkg.license.type; // legacy { type, url } shape
			}
			if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
				return pkg.licenses.map((l) => l.type).join(" OR ");
			}
			return "UNKNOWN (no license field in package.json)";
		} catch {
			return "UNKNOWN (unreadable package.json)";
		}
	}
	return "UNKNOWN (package.json not found on disk — run `bun install`)";
}

/**
 * bun.lock's "packages" object keys are hoisting/nesting paths (e.g. a
 * transitive dep pinned under a specific parent shows up as
 * "@aws-crypto/sha1-browser/@smithy/util-utf8"), NOT necessarily the real
 * package name. The real "<name>@<version>" always lives in tuple[0]
 * regardless of nesting, so that — not the object key — is the source of
 * truth. Handles scoped names (leading "@", second "@" is the version
 * separator) and unscoped names (first "@" is the separator).
 */
function parseNameVersion(resolvedSpec) {
	const searchFrom = resolvedSpec.startsWith("@") ? 1 : 0;
	const idx = resolvedSpec.indexOf("@", searchFrom);
	if (idx === -1) return { name: resolvedSpec, version: "unknown" };
	return { name: resolvedSpec.slice(0, idx), version: resolvedSpec.slice(idx + 1) };
}

function main() {
	if (!existsSync(LOCK_PATH)) {
		console.error("generate-third-party-notices: bun.lock not found at repo root.");
		process.exit(2);
	}
	if (!existsSync(BUN_STORE)) {
		console.error(
			"generate-third-party-notices: node_modules/.bun not found — run `bun install` first.",
		);
		process.exit(2);
	}

	const lock = parseBunLock(readFileSync(LOCK_PATH, "utf8"));
	const rawEntries = Object.entries(lock.packages ?? {});

	// This repo's own workspace packages (root "opencut" and "@opencut/web")
	// show up in bun.lock's package list too, with a "root:"/"workspace:..."
	// pseudo-version instead of a real resolved one — that's us, not a
	// third-party dependency, so it's excluded rather than reported UNKNOWN.
	const OWN_WORKSPACE_PACKAGES = new Set(["opencut", "@opencut/web"]);

	// Dedupe by resolved "name@version": the same package/version can appear
	// under many different nesting keys (see parseNameVersion's doc comment)
	// and must be counted/listed exactly once, not once per occurrence.
	/** @type {Map<string, {name: string, version: string}>} */
	const distinctPackages = new Map();
	for (const [, tuple] of rawEntries) {
		const resolvedSpec = Array.isArray(tuple) ? tuple[0] : null;
		if (typeof resolvedSpec !== "string") continue;
		const { name, version } = parseNameVersion(resolvedSpec);
		if (OWN_WORKSPACE_PACKAGES.has(name)) continue;
		distinctPackages.set(`${name}@${version}`, { name, version });
	}

	// Package-name families that ship one prebuilt native binary per
	// OS/arch as a *separate* npm package (only the matching one for the
	// host platform ever gets installed — everything else is expected to
	// have no package.json on disk here). Matched by name prefix rather
	// than a generic OS-substring regex because some real, single-platform
	// libraries happen to contain OS-like substrings in unrelated words.
	const PLATFORM_BINARY_FAMILY_PREFIXES = [
		"@esbuild/",
		"@turbo/",
		"@img/sharp",
		"@tailwindcss/oxide",
		"@napi-rs/",
		"@ast-grep/napi-",
		"@rollup/rollup-",
		"@cloudflare/workerd-",
		"@next/swc-",
		"lightningcss",
		"@emnapi/",
		"@tybys/",
	];
	function isPlatformBinaryFamily(name) {
		return PLATFORM_BINARY_FAMILY_PREFIXES.some((prefix) => name.startsWith(prefix));
	}

	/** @type {Map<string, {name: string, version: string}[]>} */
	const byLicense = new Map();
	let unresolved = 0;
	let platformOptional = 0;

	for (const { name, version } of distinctPackages.values()) {
		let license = readLicense(name, version);
		if (license.startsWith("UNKNOWN") && isPlatformBinaryFamily(name)) {
			// Optional platform-specific native binary for an OS/arch this
			// machine isn't (e.g. a linux-x64 binding on a darwin-arm64
			// dev box) — bun correctly never installs it here, so there is
			// nothing on disk to read a license from. Tracked separately so
			// it doesn't read as a real audit gap.
			license = "UNKNOWN (optional native binary, not installed for this platform)";
			platformOptional++;
		} else if (license.startsWith("UNKNOWN")) {
			unresolved++;
		}
		if (!byLicense.has(license)) byLicense.set(license, []);
		byLicense.get(license).push({ name, version });
	}

	const licenseKeys = [...byLicense.keys()].sort((a, b) => a.localeCompare(b));

	console.log("<!-- AUTO-GENERATED by scripts/generate-third-party-notices.mjs — do not hand-edit below this line. -->");
	console.log("");
	console.log(
		`_${distinctPackages.size} distinct npm/Bun packages (deduped from ${rawEntries.length} lockfile entries) across ${licenseKeys.length} license declarations, generated ${new Date().toISOString().slice(0, 10)} from \`bun.lock\`. ${platformOptional} are optional native binaries not installed on this platform (no local package.json to read). ${unresolved} have a genuinely unresolved license and need manual lookup._`,
	);
	console.log("");

	for (const license of licenseKeys) {
		const pkgs = byLicense.get(license).sort((a, b) => a.name.localeCompare(b.name));
		console.log(`<details><summary><strong>${license}</strong> (${pkgs.length} packages)</summary>`);
		console.log("");
		for (const p of pkgs) {
			console.log(`- \`${p.name}@${p.version}\``);
		}
		console.log("");
		console.log("</details>");
		console.log("");
	}

	console.error(
		`generate-third-party-notices: done. ${distinctPackages.size} distinct packages, ${licenseKeys.length} license groups, ${platformOptional} platform-optional, ${unresolved} genuinely unresolved.`,
	);
	if (unresolved > 0) {
		console.error(
			"generate-third-party-notices: UNKNOWN (non-platform-optional) entries need manual lookup before this doc can be called complete.",
		);
	}
}

main();
