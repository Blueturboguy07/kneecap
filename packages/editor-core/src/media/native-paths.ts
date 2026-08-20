/**
 * Container-relative media path resolution.
 *
 * iOS rotates the app data-container UUID on every app update/reinstall,
 * so a persisted ABSOLUTE media path (or any URL embedding one) dies with
 * the next install — found live 2026-08-19: after an Xcode reinstall every
 * saved project's playback broke because `MediaAssetData.url` pointed into
 * the previous container. The durable identity of a native media file is
 * therefore its path RELATIVE to the media-custody root
 * (`NativeBridge.getMediaRoot()`), re-anchored to the CURRENT root at
 * every load.
 *
 * editor-core stays headless and cannot import `@kneecap/native-bridge`
 * (circular — see media/native-import.ts's header), so the host registers
 * the current root + its URI converter here at boot (same host-supplies-
 * a-resolver pattern as `EdlAssetResolver`). Until registration, or on
 * platforms with no stable native filesystem (web), resolution returns
 * null and callers fall back to whatever absolute URL was persisted.
 */

/** The `/_capacitor_file_` marker Capacitor's convertFileSrc embeds; the
 *  raw filesystem path follows it verbatim (no percent-encoding). */
const CAPACITOR_FILE_MARKER = "/_capacitor_file_";

let resolvePath: ((relativePath: string) => string) | null = null;
let registeredRoot: string | null = null;

export function registerNativeMediaPathResolver({
	root,
	toPlaybackUri,
}: {
	root: string;
	toPlaybackUri: (nativeUri: string) => string;
}): void {
	const cleanRoot = root.replace(/\/+$/, "");
	registeredRoot = cleanRoot;
	resolvePath = (relativePath) => toPlaybackUri(`${cleanRoot}/${relativePath}`);
}

/** Current-container playback URL for a persisted relative path, or null
 *  when no resolver is registered yet. */
export function resolveNativeMediaPath(relativePath: string): string | null {
	return resolvePath ? resolvePath(relativePath) : null;
}

/**
 * Derives the custody-root-relative path from a CONVERTED playback URL
 * (`capacitor://…/_capacitor_file_/<raw path>` on iOS,
 * `https://…/_capacitor_file_/<raw path>` on Android). Returns undefined
 * when the URL is not a Capacitor file URL (web blob:) or the raw path
 * lives outside `root` — callers then persist nothing and the asset keeps
 * absolute-URL behavior.
 */
export function relativeMediaPathFromPlaybackUrl({
	url,
	root,
}: {
	url: string | undefined;
	root: string | null;
}): string | undefined {
	if (!url || !root) return undefined;
	const markerIndex = url.indexOf(CAPACITOR_FILE_MARKER);
	if (markerIndex === -1) return undefined;
	const rawPath = url.slice(markerIndex + CAPACITOR_FILE_MARKER.length);
	const cleanRoot = root.replace(/\/+$/, "");
	if (!rawPath.startsWith(`${cleanRoot}/`)) return undefined;
	return rawPath.slice(cleanRoot.length + 1);
}

/**
 * Best-effort salvage for URLs persisted BEFORE relative-path support
 * (2026-08-19 round 3): those embed the previous install's container UUID,
 * but iOS MIGRATES `Application Support` content across container
 * rotations — the files still exist under the new UUID, so re-anchoring
 * the root-relative suffix of the stale URL recovers them. The custody
 * roots have fixed basenames ("kneecap" from iOS MediaSandbox,
 * "no_backup" from Android's noBackupFilesDir), which is what makes the
 * suffix extraction unambiguous. Returns the salvaged RELATIVE path, or
 * undefined when the URL has no recognizable custody segment (e.g. web
 * blob: URLs).
 */
const LEGACY_ROOT_BASENAMES = ["kneecap", "no_backup"];

export function salvageRelativeMediaPathFromStaleUrl(
	url: string,
): string | undefined {
	const markerIndex = url.indexOf(CAPACITOR_FILE_MARKER);
	if (markerIndex === -1) return undefined;
	const rawPath = url.slice(markerIndex + CAPACITOR_FILE_MARKER.length);
	for (const basename of LEGACY_ROOT_BASENAMES) {
		const segment = `/${basename}/`;
		const segmentIndex = rawPath.indexOf(segment);
		if (segmentIndex !== -1) {
			return rawPath.slice(segmentIndex + segment.length);
		}
	}
	return undefined;
}

/** Relativizes a RAW native filesystem path against the custody root
 *  (the raw-path sibling of `relativeMediaPathFromPlaybackUrl`). */
export function relativeMediaPathFromRawPath({
	path,
	root,
}: {
	path: string | undefined;
	root: string | null;
}): string | undefined {
	if (!path || !root) return undefined;
	const cleanRoot = root.replace(/\/+$/, "");
	return path.startsWith(`${cleanRoot}/`)
		? path.slice(cleanRoot.length + 1)
		: undefined;
}

/** Re-anchors a persisted relative path to the CURRENT custody root as a
 *  RAW absolute path (for native consumers — the export pipeline), unlike
 *  `resolveNativeMediaPath` which returns a webview playback URL. */
export function resolveNativeMediaRawPath(relativePath: string): string | null {
	if (!registeredRoot) return null;
	return `${registeredRoot}/${relativePath}`;
}

/** Test hook: clears registration so suites don't leak state. */
export function __resetNativeMediaPathResolverForTests(): void {
	resolvePath = null;
	registeredRoot = null;
}

/** Exposed for diagnostics/logging only. */
export function getRegisteredNativeMediaRoot(): string | null {
	return registeredRoot;
}
