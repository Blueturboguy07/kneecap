import { AddMediaAssetCommand } from "@/commands/media/add-media-asset";
import type { EditorCore } from "@/core";
import { toast } from "@/core/notifications";
import { relativeMediaPathFromPlaybackUrl } from "@/media/native-paths";
import type { MediaAsset, MediaType } from "@/media/types";

/**
 * kneecap M4 — wires the editor's import flow to a `NativeBridge`
 * (plan M4 key task 6: "Wire MediaManager + media/processing.ts to consume
 * native-probed metadata instead of the mediabunny Input/BlobSource probe
 * path").
 *
 * Deliberately does NOT import `@kneecap/native-bridge`: that package
 * already depends on `@kneecap/editor-core` (`capacitor-bridge.ts` imports
 * `Edl` from `./edl`), so importing it back here would make the two
 * packages circular. `NativeMediaSource` below is a small structural
 * subset of `NativeBridge` instead — the REAL bridge
 * (`(await getNativeBridge())`) satisfies it with no adapter needed
 * (TypeScript structural typing), exactly the same "host supplies a
 * resolver shaped like an interface the engine defines" pattern
 * `EdlAssetResolver` already uses (`edl/build.ts`).
 */

export interface NativeFrameRate {
	numerator: number;
	denominator: number;
}

/** Structural subset of `@kneecap/native-bridge`'s `MediaHandle`. */
export interface NativeMediaHandle {
	id: string;
	uri: string;
	kind: MediaType;
	fileName: string;
	sizeBytes: number;
	durationMicros: number;
	width: number;
	height: number;
	hasAudio: boolean;
	codec: string;
	frameRate: NativeFrameRate | null;
}

/** Structural subset of `@kneecap/native-bridge`'s `ProxyProgress`. */
export interface NativeProxyProgress {
	assetId: string;
	stage: "queued" | "transcoding" | "done" | "error";
	fraction: number;
	proxyUri?: string;
	proxyWidth?: number;
	proxyHeight?: number;
	thumbnailUris?: string[];
	error?: string;
}

/** Structural subset of `@kneecap/native-bridge`'s `NativeBridge`. */
export interface NativeMediaSource {
	pickMedia(opts: {
		kinds: MediaType[];
		allowMultiple: boolean;
	}): Promise<NativeMediaHandle[]>;
	generateProxy(params: {
		handle: NativeMediaHandle;
		spec: { targetHeight: number; shortGop: boolean };
	}): AsyncGenerator<NativeProxyProgress>;
	toPlaybackUri(nativeUri: string): string;
	/** See `@kneecap/native-bridge` `NativeBridge.getMediaRoot` — null on
	 *  web or when the native build predates the method. */
	getMediaRoot(): Promise<string | null>;
}

const MIME_BY_KIND: Record<MediaType, string> = {
	video: "video/mp4",
	audio: "audio/mp4",
	image: "image/jpeg",
};

/**
 * A zero-byte placeholder. `MediaAsset.file: File` is a pre-existing,
 * repo-wide type requirement (`services/renderer/scene-builder.ts`,
 * `media/audio.ts`, `core/managers/audio-manager.ts` all read
 * `mediaAsset.file` for preview compositing/waveform decode via
 * mediabunny's `BlobSource`) that THIS function does not — and, scoped to
 * plan M4, should not — satisfy with real bytes: doing so would mean
 * fetching the whole source file into the JS heap on import, exactly the
 * jetsam vector M4's own exit criterion forbids ("peak JS heap delta during
 * import of a 2GB source file is under 20MB").
 *
 * The render/audio pipeline handles this stub via
 * `media/playable-source.ts` (the plan §2.6 `BlobSource`-to-`UrlSource`
 * swap, closed 2026-08-19 after on-device playback surfaced the gap):
 * every decode path prefers real `file` bytes and falls back to streaming
 * `mediaAsset.url` (the proxy's playback URI below) when the file is this
 * zero-byte stub. Any NEW code that reads `mediaAsset.file` directly must
 * go through `createPlayableSource`/`readPlayableBytes` instead.
 */
function stubFile({
	fileName,
	kind,
}: {
	fileName: string;
	kind: MediaType;
}): File {
	return new File([], fileName, { type: MIME_BY_KIND[kind] });
}

/**
 * Builds the `Omit<MediaAsset, "id">` `AddMediaAssetCommand` wants, from a
 * native probe + its finished proxy. Throws if `proxy.stage !== "done"` —
 * callers (`importMediaFromNative` below) are expected to have already
 * routed `"error"` proxies to failure handling before reaching here.
 */
export function buildMediaAssetFromNativeImport({
	handle,
	proxy,
	toPlaybackUri,
	mediaRoot = null,
}: {
	handle: NativeMediaHandle;
	proxy: NativeProxyProgress;
	toPlaybackUri: (nativeUri: string) => string;
	/** Custody root from `NativeMediaSource.getMediaRoot()`; enables
	 *  container-relative persistence (media/native-paths.ts). */
	mediaRoot?: string | null;
}): Omit<MediaAsset, "id"> {
	if (proxy.stage !== "done" || !proxy.proxyUri) {
		throw new Error(
			`buildMediaAssetFromNativeImport requires a "done" proxy with a proxyUri (got stage="${proxy.stage}", asset ${handle.id})`,
		);
	}

	const fps = handle.frameRate
		? handle.frameRate.numerator / handle.frameRate.denominator
		: undefined;

	const url = toPlaybackUri(proxy.proxyUri);
	const thumbnailUrl = proxy.thumbnailUris?.[0]
		? toPlaybackUri(proxy.thumbnailUris[0])
		: undefined;

	return {
		name: handle.fileName,
		type: handle.kind,
		file: stubFile({ fileName: handle.fileName, kind: handle.kind }),
		url,
		// Prefer the proxy's OWN (downscaled) dimensions when known — that's
		// what the webview will actually be compositing against — falling
		// back to the source probe for kinds/cases with no proxy resize
		// (e.g. an image import, which has no video proxy at all).
		width: proxy.proxyWidth ?? handle.width,
		height: proxy.proxyHeight ?? handle.height,
		duration: handle.durationMicros / 1_000_000,
		fps,
		hasAudio: handle.hasAudio,
		// Only the strip's first frame — `MediaAssetData` has one
		// `thumbnailUrl` slot, not an array. The rest of `proxy.thumbnailUris`
		// (the actual filmstrip) has no storage home yet; that's M7's
		// timeline UI to build, not this import path's job to invent.
		thumbnailUrl,
		// Container-relative persistence identities (media/native-paths.ts):
		// the ONLY forms that survive an iOS app update's container-UUID
		// rotation. Absent when the native build has no getMediaRoot or the
		// file lives outside the custody root.
		nativeRelativePath: relativeMediaPathFromPlaybackUrl({
			url,
			root: mediaRoot,
		}),
		thumbnailNativeRelativePath: relativeMediaPathFromPlaybackUrl({
			url: thumbnailUrl,
			root: mediaRoot,
		}),
	};
}

/**
 * One tick of import progress, shaped for a UI that shows a single
 * overall indicator: `index`/`total` locate the asset currently being
 * proxied, `fraction` is that asset's own 0..1 transcode progress
 * (mirrors `NativeProxyProgress.fraction`).
 */
export interface NativeImportProgress {
	index: number;
	total: number;
	fileName: string;
	stage: NativeProxyProgress["stage"];
	fraction: number;
}

export interface ImportMediaFromNativeParams {
	editor: EditorCore;
	projectId: string;
	source: NativeMediaSource;
	kinds: MediaType[];
	allowMultiple: boolean;
	/** Plan Amendment 4 default: 540p short edge, short-GOP on. */
	proxySpec?: { targetHeight: number; shortGop: boolean };
	/**
	 * Fires as soon as the picker resolves and then on every native proxy
	 * progress event. Without a consumer the import runs seconds of native
	 * transcode with zero UI acknowledgement — the "nothing happens after I
	 * pick a video" report from the founder's device (2026-08-19).
	 */
	onProgress?: (progress: NativeImportProgress) => void;
}

export interface NativeImportFailure {
	handle: NativeMediaHandle;
	error: string;
}

export interface ImportMediaFromNativeResult {
	imported: MediaAsset[];
	failed: NativeImportFailure[];
}

/**
 * The end-to-end M4 import flow: pick → (per asset) generate proxy →
 * construct + commit a `MediaAsset`. Plan M4 item 7's import-failure UX
 * (unsupported codec, proxy-generation failure) is handled per-asset — one
 * bad clip in a multi-select doesn't abort the rest, matching
 * `MediaPickerCoordinator.importOne`'s same one-bad-item-doesn't-lose-the-
 * batch policy on the native side.
 */
export async function importMediaFromNative({
	editor,
	projectId,
	source,
	kinds,
	allowMultiple,
	proxySpec = { targetHeight: 540, shortGop: true },
	onProgress,
}: ImportMediaFromNativeParams): Promise<ImportMediaFromNativeResult> {
	const handles = await source.pickMedia({ kinds, allowMultiple });

	// One root lookup per import batch; null (web / old native build) just
	// disables relative-path persistence, it never blocks the import.
	const mediaRoot = await source.getMediaRoot().catch(() => null);

	const imported: MediaAsset[] = [];
	const failed: NativeImportFailure[] = [];

	for (const [index, handle] of handles.entries()) {
		// Announce the asset before its first native event arrives — the gap
		// between picker dismissal and the first "transcoding" event is
		// exactly where the UI used to look dead.
		onProgress?.({
			index,
			total: handles.length,
			fileName: handle.fileName,
			stage: "queued",
			fraction: 0,
		});
		let finalProxy: NativeProxyProgress | null = null;
		try {
			for await (const progress of source.generateProxy({
				handle,
				spec: proxySpec,
			})) {
				onProgress?.({
					index,
					total: handles.length,
					fileName: handle.fileName,
					stage: progress.stage,
					fraction: progress.fraction,
				});
				if (progress.stage === "done" || progress.stage === "error") {
					finalProxy = progress;
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failed.push({ handle, error: message });
			toast.error({
				message: `Couldn't process "${handle.fileName}"`,
				description: message,
			});
			continue;
		}

		if (!finalProxy || finalProxy.stage === "error") {
			const message = finalProxy?.error ?? "proxy generation produced no result";
			failed.push({ handle, error: message });
			toast.error({
				message: `Couldn't process "${handle.fileName}"`,
				description: message,
			});
			continue;
		}

		const assetInput = buildMediaAssetFromNativeImport({
			handle,
			proxy: finalProxy,
			toPlaybackUri: source.toPlaybackUri,
			mediaRoot,
		});

		const command = new AddMediaAssetCommand({ projectId, asset: assetInput });
		editor.command.execute({ command });

		const createdId = command.getAssetId();
		const created = editor.media
			.getAssets()
			.find((asset) => asset.id === createdId);
		if (created) {
			imported.push(created);
		}
	}

	return { imported, failed };
}
