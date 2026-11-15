/**
 * The raw native path behind a URL the bridge itself handed out (1.0.5).
 *
 * `exportProject`'s "done" event carries `outputUri` already converted for
 * the web view (`toPlaybackUri` in capacitor-bridge.ts:
 * `capacitor://localhost/_capacitor_file_/<raw path>` on iOS,
 * `https://localhost/_capacitor_file_/<raw path>` on Android). The export
 * sheet hands that same value back to `saveToPhotos`/`shareFile`, and the
 * native side needs the file, so this takes the raw path back out. Capacitor
 * puts the raw path after the marker verbatim (no percent-encoding), the
 * same rule `editor-core/media/native-paths.ts` relies on. Any other value
 * (a raw path, a `file://` URL) passes through unchanged; both natives
 * accept those.
 *
 * No imports, so `bun test` runs it without a Capacitor runtime.
 */
const CAPACITOR_FILE_MARKER = "/_capacitor_file_";

export function nativeFilePathFromUri(uri: string): string {
	const markerIndex = uri.indexOf(CAPACITOR_FILE_MARKER);
	return markerIndex === -1 ? uri : uri.slice(markerIndex + CAPACITOR_FILE_MARKER.length);
}
