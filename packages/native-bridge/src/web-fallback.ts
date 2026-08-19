/**
 * Web fallback — plan §2.4 / M3: "a web-fallback implementation so the
 * editor still runs in a plain browser." This is what `apps/mobile`'s harness
 * (and any future `apps/web-dev`) gets when `Capacitor.isNativePlatform()` is
 * false. It is deliberately honest about what a browser cannot do: there is
 * no hardware transcode, no native export, no on-device STT model runtime
 * here. Those four bridges collapse to "pick a file with `<input>`" plus
 * feature-detected capabilities; everything else throws a typed
 * `NativeBridgeError` naming the real (native) implementation's milestone.
 */

import { detectGpuBackend } from "./gpu-detect";
import { probeCodecs } from "./codec-detect";
import {
	DEV_FIXTURE_MEDIA_URI,
	DEV_SAMPLE_TRANSCRIPT_SEGMENTS,
} from "./dev-fixtures/sample-transcript";
import type {
	DeviceCapabilities,
	ExportProgress,
	MediaHandle,
	MediaKind,
	NativeBridge,
	PickMediaOptions,
	ProxyProgress,
	ProxySpec,
	ThumbnailStrip,
	ThumbnailStripSpec,
	TranscribeOptions,
	TranscriptSegment,
} from "./types";
import { NativeBridgeError } from "./types";
import type { Edl } from "@kneecap/editor-core/edl";

/** Pure and unit-tested: MIME type -> MediaKind, the one bit of `pickMedia`
 * that does not require a DOM to exercise. */
export function inferMediaKind(mimeType: string): MediaKind {
	if (mimeType.startsWith("video/")) return "video";
	if (mimeType.startsWith("audio/")) return "audio";
	return "image";
}

const ACCEPT_BY_KIND: Record<MediaKind, string> = {
	video: "video/*",
	audio: "audio/*",
	image: "image/*",
};

/** Probes a picked File for dimensions/duration using a throwaway media
 * element. DOM-only; not exercised by `bun test` (no DOM there) — see the M3
 * handoff note on this gap. */
async function probeFile({
	file,
	id,
}: {
	file: File;
	id: string;
}): Promise<MediaHandle> {
	const kind = inferMediaKind(file.type);
	const objectUrl = URL.createObjectURL(file);

	const base: Omit<
		MediaHandle,
		"width" | "height" | "durationMicros" | "hasAudio"
	> = {
		id,
		uri: objectUrl,
		kind,
		fileName: file.name,
		sizeBytes: file.size,
		rotationDegrees: 0,
		codec: file.type || "unknown",
		frameRate: null,
	};

	if (kind === "image") {
		const dims = await new Promise<{ width: number; height: number }>(
			(resolve, reject) => {
				const img = new Image();
				img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
				img.onerror = () => reject(new Error(`could not decode image ${file.name}`));
				img.src = objectUrl;
			},
		);
		return { ...base, ...dims, durationMicros: 0, hasAudio: false };
	}

	const el = document.createElement(kind === "video" ? "video" : "audio");
	el.preload = "metadata";
	const meta = await new Promise<{
		width: number;
		height: number;
		durationMicros: number;
		hasAudio: boolean;
	}>((resolve, reject) => {
		el.onloadedmetadata = () => {
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- `el` was created as "video" when kind==="video"; `videoWidth`/`videoHeight` are only read in that branch below.
			const videoEl = el as HTMLVideoElement;
			resolve({
				width: kind === "video" ? videoEl.videoWidth : 0,
				height: kind === "video" ? videoEl.videoHeight : 0,
				// `duration` is float seconds in the DOM API; round to an integer
				// microsecond count immediately so no float survives past this line.
				durationMicros: Number.isFinite(el.duration)
					? Math.round(el.duration * 1_000_000)
					: 0,
				hasAudio: true,
			});
		};
		el.onerror = () => reject(new Error(`could not probe ${file.name}`));
		el.src = objectUrl;
	});

	return { ...base, ...meta };
}

/** Triggers a hidden `<input type="file">` and resolves with the user's
 * selection, or `[]` on cancel. DOM-only. */
function openFilePicker({
	kinds,
	allowMultiple,
}: PickMediaOptions): Promise<File[]> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = kinds.map((k) => ACCEPT_BY_KIND[k]).join(",");
		input.multiple = allowMultiple;
		input.style.display = "none";

		let settled = false;
		const finish = (files: File[]) => {
			if (settled) return;
			settled = true;
			input.remove();
			resolve(files);
		};

		input.onchange = () => finish(input.files ? Array.from(input.files) : []);
		// A cancelled <input type=file> fires no event at all in most browsers;
		// `focus` on the window after the dialog closes is the closest portable
		// signal, given a short grace period for `onchange` to win the race.
		window.addEventListener(
			"focus",
			() => setTimeout(() => finish([]), 300),
			{ once: true },
		);

		document.body.appendChild(input);
		input.click();
	});
}

let nextHandleId = 0;

export function createWebFallbackBridge(): NativeBridge {
	return {
		platform: "web",

		// The web fallback's `uri`s are already `blob:` object URLs (see
		// `probeFile` below) — directly webview/browser-loadable already,
		// nothing to convert.
		toPlaybackUri: (nativeUri: string) => nativeUri,

		// No stable native filesystem — blob: URLs are session-scoped, so
		// relative-path persistence has nothing to anchor to here.
		getMediaRoot: async () => null,

		async pickMedia(opts) {
			const files = await openFilePicker(opts);
			const handles: MediaHandle[] = [];
			for (const file of files) {
				handles.push(
					await probeFile({ file, id: `web-${Date.now()}-${nextHandleId++}` }),
				);
			}
			return handles;
		},

		async *generateProxy({
			handle,
		}: {
			handle: MediaHandle;
			spec: ProxySpec;
		}): AsyncGenerator<ProxyProgress> {
			// No hardware transcode in a browser. The fallback's honest behavior
			// is "the proxy IS the source" — scrub performance degrades to
			// plan §M1's un-proxied numbers, which is the whole reason M4's
			// native proxy pipeline is a v1 requirement rather than an
			// optimization. This keeps the editor USABLE in a browser, not FAST.
			yield {
				assetId: handle.id,
				stage: "done",
				fraction: 1,
				proxyUri: handle.uri,
			};
		},

		async *exportProject(_params: { edl: Edl }): AsyncGenerator<ExportProgress> {
			throw new NativeBridgeError({
				code: "UNSUPPORTED",
				message:
					"Hardware export requires a native shell (plan M9: AVFoundation / Media3). Not available in the web-fallback bridge.",
			});
		},

		async *transcribe({
			handle,
		}: {
			handle: MediaHandle;
			opts: TranscribeOptions;
		}): AsyncGenerator<TranscriptSegment> {
			// The ONE recognized exception to "no STT in a browser": the dev
			// harness's own pre-transcribed sample, used to exercise
			// generate -> edit -> preview end to end without native STT. Any
			// other `MediaHandle` (a real user-picked file) still gets the
			// honest UNSUPPORTED error below — this is not a general in-webview
			// transcription path, see this file's header comment and
			// `dev-fixtures/sample-transcript.ts`'s.
			if (handle.uri === DEV_FIXTURE_MEDIA_URI) {
				for (const segment of DEV_SAMPLE_TRANSCRIPT_SEGMENTS) {
					yield segment;
				}
				return;
			}

			throw new NativeBridgeError({
				code: "UNSUPPORTED",
				message:
					"On-device speech-to-text requires a native shell (plan M10: whisper.cpp). Not available in the web-fallback bridge.",
			});
		},

		async generateThumbnails(_params: {
			handle: MediaHandle;
			spec: ThumbnailStripSpec;
		}): Promise<ThumbnailStrip> {
			// Deliberately UNSUPPORTED, not a `<canvas>`-based approximation:
			// plan M4 item 5's rule is "do NOT decode filmstrip frames in JS,"
			// full stop — that rule doesn't get relaxed just because this is the
			// fallback path. A native shell is required for thumbnails, same as
			// export and STT.
			throw new NativeBridgeError({
				code: "UNSUPPORTED",
				message:
					"Thumbnail strip generation requires a native shell (plan M4: MediaMetadataRetriever / AVAssetImageGenerator) — decoding filmstrip frames in JS is explicitly out of scope even as a fallback. Not available in the web-fallback bridge.",
			});
		},

		async capabilities(): Promise<DeviceCapabilities> {
			const [gpuBackend, codecs] = await Promise.all([
				detectGpuBackend(),
				probeCodecs(),
			]);
			return {
				platform: "web",
				osVersion:
					typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
				deviceModel: "browser",
				gpuBackend,
				ramTierMb: null,
				codecs,
				supportsNativeExport: false,
				supportsOnDeviceStt: false,
			};
		},
	};
}
