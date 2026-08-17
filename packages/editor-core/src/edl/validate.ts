import { rationalToNumber, scaleTicks } from "./rational";
import {
	EDL_VERSION,
	type Edl,
	type EdlClip,
	type EdlTrack,
} from "./types";

/**
 * `validateEdl()` — plan §2.3 rule 2: the preview renderer and the native
 * exporters must be provable to read the same graph, so the same checker runs
 * on both sides of the bridge.
 *
 * It is a CHECKER, not a parser: it takes an already-parsed document and
 * reports everything wrong with it, rather than throwing on the first problem.
 * A native mapper that finds an error here should refuse the export; a warning
 * means "v1 cannot represent this faithfully" and the host decides.
 */

export interface EdlValidationIssue {
	/** JSON-pointer-ish path to the offending value, e.g. "tracks[2].clips[0]". */
	path: string;
	message: string;
}

export interface EdlValidationResult {
	ok: boolean;
	errors: EdlValidationIssue[];
	warnings: EdlValidationIssue[];
}

export interface ValidateEdlOptions {
	/**
	 * Strict mode is what a NATIVE EXPORTER should use. It additionally requires
	 * that every asset referenced by a media clip has a real `sourceUri` — a
	 * document that is structurally perfect but has `sourceUri: null` everywhere
	 * is fine for the preview renderer and useless to AVFoundation/Media3.
	 */
	strict?: boolean;
}

/** Effects a v1 native mapper is expected to implement (plan §2.3 rule 4). */
export const EDL_V1_SUPPORTED_EFFECT_TYPES: readonly string[] = [
	"brightness",
	"contrast",
	"saturation",
	"exposure",
	"temperature",
	"tint",
	"hue",
	"vibrance",
	"gamma",
	"sharpen",
	"vignette",
	"grayscale",
	"sepia",
	"invert",
];

function isInt(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

class Issues {
	readonly errors: EdlValidationIssue[] = [];
	readonly warnings: EdlValidationIssue[] = [];

	error({ path, message }: EdlValidationIssue): void {
		this.errors.push({ path, message });
	}

	warn({ path, message }: EdlValidationIssue): void {
		this.warnings.push({ path, message });
	}

	/** The workhorse: assert an integer tick count. */
	ticks({
		path,
		value,
		allowNegative = false,
	}: {
		path: string;
		value: unknown;
		allowNegative?: boolean;
	}): void {
		if (!isInt(value)) {
			this.error({
				path,
				message: `expected an integer tick count, got ${JSON.stringify(value)}. EDL carries integer ticks only — never float seconds (plan §2.3 rule 1).`,
			});
			return;
		}
		if (!allowNegative && value < 0) {
			this.error({ path, message: `tick count must be >= 0, got ${value}` });
		}
	}

	rational({ path, value }: { path: string; value: unknown }): void {
		if (
			typeof value !== "object" ||
			value === null ||
			!("numerator" in value) ||
			!("denominator" in value)
		) {
			this.error({ path, message: "expected {numerator, denominator}" });
			return;
		}
		const r: { numerator: unknown; denominator: unknown } = value;
		if (!isInt(r.numerator) || !isInt(r.denominator)) {
			this.error({
				path,
				message: `rational must be a pair of integers, got ${JSON.stringify(r)}. A float rate here is a drift bug in every long export.`,
			});
			return;
		}
		if (r.denominator <= 0) {
			this.error({ path, message: `denominator must be > 0, got ${r.denominator}` });
		}
		if (r.numerator <= 0) {
			this.error({ path, message: `numerator must be > 0, got ${r.numerator}` });
		}
	}
}

function validateClip({
	clip,
	path,
	issues,
	assetIds,
	strict,
	assetsWithUri,
}: {
	clip: EdlClip;
	path: string;
	issues: Issues;
	assetIds: Set<string>;
	strict: boolean;
	assetsWithUri: Set<string>;
}): void {
	if (!clip.clipId) issues.error({ path: `${path}.clipId`, message: "required" });

	issues.ticks({ path: `${path}.startTicks`, value: clip.startTicks });
	issues.ticks({ path: `${path}.durationTicks`, value: clip.durationTicks });
	issues.ticks({ path: `${path}.sourceStartTicks`, value: clip.sourceStartTicks });
	issues.ticks({ path: `${path}.sourceEndTicks`, value: clip.sourceEndTicks });
	issues.ticks({ path: `${path}.trimEndTicks`, value: clip.trimEndTicks });
	issues.rational({ path: `${path}.speed`, value: clip.speed });

	if (isInt(clip.durationTicks) && clip.durationTicks <= 0) {
		issues.error({
			path: `${path}.durationTicks`,
			message: `a clip must occupy at least one tick, got ${clip.durationTicks}`,
		});
	}

	// The invariant that keeps preview and export on the same frame: the source
	// span must be exactly `durationTicks * speed`, in the same rounding mode the
	// engine used. One tick of slack absorbs the engine's own rounding.
	if (
		isInt(clip.durationTicks) &&
		isInt(clip.sourceStartTicks) &&
		isInt(clip.sourceEndTicks) &&
		isInt(clip.speed?.numerator) &&
		isInt(clip.speed?.denominator) &&
		clip.speed.denominator > 0
	) {
		const expected =
			clip.sourceStartTicks +
			scaleTicks({ ticks: clip.durationTicks, rate: clip.speed });
		if (Math.abs(expected - clip.sourceEndTicks) > 1) {
			issues.error({
				path: `${path}.sourceEndTicks`,
				message:
					`inconsistent with durationTicks x speed: expected ~${expected}, got ${clip.sourceEndTicks}. ` +
					"Preview and native export would read different source frames.",
			});
		}
	}

	const needsAsset =
		clip.kind === "video" || clip.kind === "image" || clip.kind === "audio";
	if (needsAsset) {
		if (!clip.assetId) {
			issues.error({
				path: `${path}.assetId`,
				message: `a "${clip.kind}" clip must reference an asset`,
			});
		} else if (!assetIds.has(clip.assetId)) {
			issues.error({
				path: `${path}.assetId`,
				message: `references unknown asset "${clip.assetId}"`,
			});
		} else if (strict && !assetsWithUri.has(clip.assetId)) {
			issues.error({
				path: `${path}.assetId`,
				message:
					`asset "${clip.assetId}" has no sourceUri. A native exporter needs a real ` +
					"file handle — wire buildEdl's resolveAsset hook (plan §2.6, M4 media custody).",
			});
		}
	} else if (clip.assetId) {
		issues.warn({
			path: `${path}.assetId`,
			message: `a "${clip.kind}" clip carries an assetId; generated content should not reference source media`,
		});
	}

	if (!isFiniteNumber(clip.opacity) || clip.opacity < 0 || clip.opacity > 1) {
		issues.error({
			path: `${path}.opacity`,
			message: `expected 0..1, got ${JSON.stringify(clip.opacity)}`,
		});
	}

	for (const [i, effect] of clip.effects.entries()) {
		if (!EDL_V1_SUPPORTED_EFFECT_TYPES.includes(effect.type)) {
			issues.warn({
				path: `${path}.effects[${i}]`,
				message:
					`effect "${effect.type}" is not on the v1 native list. Plan §2.3 rule 3 requires a ` +
					"golden-frame test per effect; anything that cannot pass is cut from v1 rather than shipped inconsistent.",
			});
		}
	}

	if (clip.masks.length > 0) {
		issues.warn({
			path: `${path}.masks`,
			message:
				`${clip.masks.length} mask(s) present. Masks are explicitly post-v1 for native export ` +
				"(plan §2.3 rule 4); a v1 mapper should refuse rather than silently drop them.",
		});
	}

	for (const [ci, channel] of clip.animations.entries()) {
		for (const [ki, key] of channel.keyframes.entries()) {
			issues.ticks({
				path: `${path}.animations[${ci}].keyframes[${ki}].timeTicks`,
				value: key.timeTicks,
			});
			if (key.leftHandle) {
				issues.ticks({
					path: `${path}.animations[${ci}].keyframes[${ki}].leftHandle.dtTicks`,
					value: key.leftHandle.dtTicks,
					allowNegative: true,
				});
			}
			if (key.rightHandle) {
				issues.ticks({
					path: `${path}.animations[${ci}].keyframes[${ki}].rightHandle.dtTicks`,
					value: key.rightHandle.dtTicks,
					allowNegative: true,
				});
			}
		}
	}
}

export function validateEdl({
	edl,
	options = {},
}: {
	edl: Edl;
	options?: ValidateEdlOptions;
}): EdlValidationResult {
	const strict = options.strict === true;
	const issues = new Issues();

	// --- meta ---------------------------------------------------------------
	if (edl?.meta?.edlVersion !== EDL_VERSION) {
		issues.error({
			path: "meta.edlVersion",
			message: `unsupported EDL version ${JSON.stringify(edl?.meta?.edlVersion)}; this build understands v${EDL_VERSION}`,
		});
		// Everything below assumes v1 field names, so stop here.
		return { ok: false, errors: issues.errors, warnings: issues.warnings };
	}

	if (!isInt(edl.meta.ticksPerSecond) || edl.meta.ticksPerSecond <= 0) {
		issues.error({
			path: "meta.ticksPerSecond",
			message: `expected a positive integer, got ${JSON.stringify(edl.meta.ticksPerSecond)}`,
		});
	}
	issues.rational({ path: "meta.frameRate", value: edl.meta.frameRate });
	issues.ticks({ path: "meta.durationTicks", value: edl.meta.durationTicks });

	if (
		!isInt(edl.meta.canvas?.width) ||
		!isInt(edl.meta.canvas?.height) ||
		edl.meta.canvas.width <= 0 ||
		edl.meta.canvas.height <= 0
	) {
		issues.error({
			path: "meta.canvas",
			message: `expected positive integer width/height, got ${JSON.stringify(edl.meta.canvas)}`,
		});
	}

	// --- assets -------------------------------------------------------------
	const assetIds = new Set<string>();
	const assetsWithUri = new Set<string>();
	for (const [i, asset] of (edl.assets ?? []).entries()) {
		if (assetIds.has(asset.assetId)) {
			issues.error({
				path: `assets[${i}].assetId`,
				message: `duplicate asset id "${asset.assetId}"`,
			});
		}
		assetIds.add(asset.assetId);

		if (asset.durationTicks !== null) {
			issues.ticks({ path: `assets[${i}].durationTicks`, value: asset.durationTicks });
		}
		if (asset.sourceUri) {
			if (asset.sourceUri.startsWith("blob:")) {
				issues.error({
					path: `assets[${i}].sourceUri`,
					message:
						'a blob: URL is meaningless to a native exporter. Media stays in the native sandbox and crosses the bridge as a URI, never as bytes (plan §2.2).',
				});
			} else {
				assetsWithUri.add(asset.assetId);
			}
		}
		if (![0, 90, 180, 270].includes(asset.rotationDegrees)) {
			issues.error({
				path: `assets[${i}].rotationDegrees`,
				message: `expected 0/90/180/270, got ${JSON.stringify(asset.rotationDegrees)}`,
			});
		}
	}

	// --- tracks -------------------------------------------------------------
	const trackIds = new Set<string>();
	const clipIndex = new Map<string, { track: EdlTrack; clip: EdlClip }>();
	const zIndices: number[] = [];
	let mainTrackCount = 0;

	for (const [ti, track] of (edl.tracks ?? []).entries()) {
		const path = `tracks[${ti}]`;
		if (trackIds.has(track.trackId)) {
			issues.error({ path: `${path}.trackId`, message: `duplicate track id "${track.trackId}"` });
		}
		trackIds.add(track.trackId);

		if (track.kind === "main") mainTrackCount++;

		if (track.kind === "audio") {
			if (track.zIndex !== null) {
				issues.error({
					path: `${path}.zIndex`,
					message: "audio tracks are not composited and must carry zIndex: null",
				});
			}
		} else if (!isInt(track.zIndex)) {
			issues.error({
				path: `${path}.zIndex`,
				message: `composited tracks need an integer zIndex, got ${JSON.stringify(track.zIndex)}`,
			});
		} else {
			zIndices.push(track.zIndex);
		}

		for (const [ci, clip] of track.clips.entries()) {
			if (clipIndex.has(clip.clipId)) {
				issues.error({
					path: `${path}.clips[${ci}].clipId`,
					message: `duplicate clip id "${clip.clipId}"`,
				});
			}
			clipIndex.set(clip.clipId, { track, clip });
			validateClip({
				clip,
				path: `${path}.clips[${ci}]`,
				issues,
				assetIds,
				strict,
				assetsWithUri,
			});
		}
	}

	if (mainTrackCount !== 1) {
		issues.error({
			path: "tracks",
			message: `expected exactly one track with kind "main", found ${mainTrackCount}`,
		});
	}

	// z-order must be a dense 0..n-1 permutation, so "paint in ascending zIndex"
	// is unambiguous for a mapper.
	const sortedZ = [...zIndices].sort((a, b) => a - b);
	for (let i = 0; i < sortedZ.length; i++) {
		if (sortedZ[i] !== i) {
			issues.error({
				path: "tracks[].zIndex",
				message: `composited zIndex values must be a dense 0..${sortedZ.length - 1} range, got [${sortedZ.join(", ")}]`,
			});
			break;
		}
	}

	// --- overlays: derived view, must agree with tracks ---------------------
	for (const [i, overlay] of (edl.overlays ?? []).entries()) {
		const found = clipIndex.get(overlay.clipId);
		if (!found) {
			issues.error({
				path: `overlays[${i}].clipId`,
				message: `references unknown clip "${overlay.clipId}"; overlays[] is a derived view of tracks[]`,
			});
			continue;
		}
		if (found.track.trackId !== overlay.trackId) {
			issues.error({
				path: `overlays[${i}].trackId`,
				message: `says "${overlay.trackId}" but clip "${overlay.clipId}" lives on "${found.track.trackId}"`,
			});
		}
		if (
			overlay.startTicks !== found.clip.startTicks ||
			overlay.durationTicks !== found.clip.durationTicks
		) {
			issues.error({
				path: `overlays[${i}]`,
				message:
					`timing disagrees with tracks[]: overlay ${overlay.startTicks}+${overlay.durationTicks} ` +
					`vs clip ${found.clip.startTicks}+${found.clip.durationTicks}`,
			});
		}
		if (overlay.zIndex !== found.track.zIndex) {
			issues.error({
				path: `overlays[${i}].zIndex`,
				message: `says ${overlay.zIndex} but its track has zIndex ${found.track.zIndex}`,
			});
		}
	}

	// --- transitions --------------------------------------------------------
	const mainTrack = (edl.tracks ?? []).find((t) => t.kind === "main");
	for (const [i, transition] of (edl.transitions ?? []).entries()) {
		issues.ticks({
			path: `transitions[${i}].durationTicks`,
			value: transition.durationTicks,
		});
		const found = clipIndex.get(transition.afterClipId);
		if (!found) {
			issues.error({
				path: `transitions[${i}].afterClipId`,
				message: `references unknown clip "${transition.afterClipId}"`,
			});
		} else if (!mainTrack || found.track.trackId !== mainTrack.trackId) {
			issues.error({
				path: `transitions[${i}].afterClipId`,
				message:
					"transitions are main-track only in v1 (matching CapCut), but this clip is on an overlay/audio track",
			});
		}
	}

	// --- output -------------------------------------------------------------
	issues.rational({ path: "output.fps", value: edl.output?.fps });
	if (!isInt(edl.output?.bitrate) || edl.output.bitrate <= 0) {
		issues.error({
			path: "output.bitrate",
			message: `expected a positive integer bits-per-second, got ${JSON.stringify(edl.output?.bitrate)}`,
		});
	}
	if (edl.output?.container !== "mp4" && edl.output?.container !== "webm") {
		issues.error({
			path: "output.container",
			message: `expected "mp4" or "webm", got ${JSON.stringify(edl.output?.container)}`,
		});
	}
	if (
		edl.meta.edlVersion === EDL_VERSION &&
		edl.output?.fps &&
		isInt(edl.output.fps.numerator) &&
		isInt(edl.output.fps.denominator) &&
		edl.output.fps.denominator > 0 &&
		rationalToNumber(edl.output.fps) > 240
	) {
		issues.warn({
			path: "output.fps",
			message: `${rationalToNumber(edl.output.fps)} fps is above anything a phone encoder will accept`,
		});
	}

	return {
		ok: issues.errors.length === 0,
		errors: issues.errors,
		warnings: issues.warnings,
	};
}

/** Convenience for call sites that just want to fail loudly. */
export function assertValidEdl({
	edl,
	options,
}: {
	edl: Edl;
	options?: ValidateEdlOptions;
}): void {
	const result = validateEdl({ edl, options });
	if (result.ok) return;
	const detail = result.errors
		.map((issue) => `  ${issue.path}: ${issue.message}`)
		.join("\n");
	throw new Error(`Invalid EDL v1:\n${detail}`);
}
