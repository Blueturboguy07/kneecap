import { BlobSource, UrlSource, type Source } from "mediabunny";

/**
 * The render/audio pipeline's single answer to "where are this asset's
 * bytes?" — the BlobSource→UrlSource swap plan §2.6 prescribes.
 *
 * Two asset populations coexist (`media/native-import.ts` `stubFile`):
 *  - web/harness imports carry real bytes in `MediaAsset.file`;
 *  - native imports carry a deliberate ZERO-BYTE stub `file` (loading a
 *    multi-GB source into the JS heap is the jetsam vector M4 forbids) and
 *    the playable bytes live behind `MediaAsset.url` — the 540p proxy
 *    served by Capacitor's local scheme, which honors Range requests, so
 *    `UrlSource` streams it without ever holding the whole file in JS.
 *
 * Feeding the stub to `BlobSource` is not a soft failure: mediabunny
 * re-parses the empty blob on EVERY frame the preview requests (found live
 * on the founder's iPhone, 2026-08-19 — playback clock advanced over a
 * black canvas while the console filled with parse errors).
 */
export function createPlayableSource({
	file,
	url,
}: {
	file: File | null;
	url: string | null;
}): Source {
	if (file && file.size > 0) {
		return new BlobSource(file);
	}
	if (url) {
		return new UrlSource(url, {
			// mediabunny's default policy retries same-origin failures FOREVER
			// (exponential backoff, only gives up on suspected CORS). Against
			// a local Capacitor-scheme URL a failure is deterministic — a bad
			// path today is a bad path on attempt 40 — and the infinite loop
			// kept the sink init pending so VideoCache's failed-sink cache and
			// error toast never engaged (observed live: endless "Retrying
			// failed fetch" console spam, founder's iPhone 2026-08-19). Three
			// quick attempts, then fail loudly.
			getRetryDelay: (previousAttempts) =>
				previousAttempts >= 3 ? null : 0.2 * previousAttempts,
		});
	}
	throw new Error(
		"Media asset has neither in-memory bytes nor a playable URL",
	);
}

/**
 * Whole-file byte read with the same file-else-url preference, for the
 * decode paths that genuinely need a full buffer (`decodeAudioData`).
 * Audio-kind assets only — never hand this a video source.
 */
export async function readPlayableBytes({
	file,
	url,
}: {
	file: File | null;
	url: string | null;
}): Promise<ArrayBuffer> {
	if (file && file.size > 0) {
		return file.arrayBuffer();
	}
	if (url) {
		const response = await fetch(url);
		// Capacitor's iOS scheme handler serves media files with a statusless
		// URLResponse — `status` is 0 and `ok` is false while the bytes are
		// perfectly good (seam-verified 2026-08-19: status=0, full length).
		// Only a real HTTP error status is a failure.
		if (!response.ok && response.status !== 0) {
			throw new Error(`Fetching media bytes failed: HTTP ${response.status}`);
		}
		return response.arrayBuffer();
	}
	throw new Error(
		"Media asset has neither in-memory bytes nor a playable URL",
	);
}
