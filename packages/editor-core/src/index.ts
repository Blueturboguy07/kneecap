/**
 * `@kneecap/editor-core` — the headless editing engine.
 *
 * Framework-agnostic by construction: nothing under `src/` imports React, Next,
 * a state library, or a component/icon package. See `scripts/check-headless.mjs`
 * and this package's own `tsconfig.json` (which maps `@/*` to this src only, so
 * a standalone `tsc --noEmit` is a structural proof of self-containment).
 *
 * This barrel is a deliberately thin front door for the surfaces a host (web
 * dev harness, mobile WebView bundle, native shell) actually needs. Deep imports
 * remain available through the `./*` export condition — the barrel exists to
 * name the contract, not to hide the tree.
 *
 * The React `useSyncExternalStore` bridge lives at `@kneecap/editor-core/react`.
 */

// --- The engine ------------------------------------------------------------
export { EditorCore } from "./core";
export {
	setNotifier,
	resetNotifier,
	toast,
	type Notification,
	type NotificationLevel,
	type NotificationOptions,
	type Notifier,
} from "./core/notifications";

// --- Time: integer ticks + rational frame rates, never float seconds -------
export {
	TICKS_PER_SECOND,
	ZERO_MEDIA_TIME,
	mediaTime,
	roundMediaTime,
	mediaTimeFromSeconds,
	mediaTimeToSeconds,
	addMediaTime,
	subMediaTime,
	type MediaTime,
} from "./wasm";

// --- Project graph types ---------------------------------------------------
export type {
	TProject,
	TProjectMetadata,
	TProjectSettings,
	TCanvasSize,
	TBackground,
} from "./project/types";
export type {
	TScene,
	SceneTracks,
	TimelineTrack,
	TimelineElement,
	VideoTrack,
	AudioTrack,
	OverlayTrack,
	Bookmark,
} from "./timeline/types";

// --- The EDL bridge contract (plan §2.3) — FROZEN at v1 --------------------
export * from "./edl";

// --- Media import (plan M4) -------------------------------------------------
export type { MediaAsset, MediaType } from "./media/types";
export {
	importMediaFromNative,
	buildMediaAssetFromNativeImport,
	type NativeMediaSource,
	type NativeMediaHandle,
	type NativeProxyProgress,
	type NativeFrameRate,
	type ImportMediaFromNativeParams,
	type ImportMediaFromNativeResult,
	type NativeImportFailure,
} from "./media/native-import";
