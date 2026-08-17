/**
 * A pure-TypeScript stand-in for the `opencut-wasm` functions the engine calls
 * at module scope, installed via `mock.module` for Bun tests.
 *
 * WHY THIS EXISTS
 * ---------------
 * `opencut-wasm`'s published bindgen glue does
 *
 *     import * as wasm from "./opencut_wasm_bg.wasm";
 *     wasm.__wbindgen_start();
 *
 * which throws `wasm.__wbindgen_start is not a function` under Bun's test
 * runtime. That is a property of the npm-published artifact, not of a local
 * `wasm-pack` build, and it is the root cause of this repo's long-standing 8
 * failing tests (scripts/invariants.sh documents them as
 * BASELINE_TEST_FAIL_MAX). It means ANY module that transitively reaches
 * `@/wasm` — which is most of the engine, because `TICKS_PER_SECOND` is
 * evaluated at import time — cannot currently be unit-tested at all.
 *
 * Importing this module FIRST in a test file fixes that for that file:
 *
 *     import "@/test-support/wasm-stub";   // must be the first import
 *     import { buildEdl } from "@/edl";
 *
 * ES modules evaluate dependencies in import order, so the mock is installed
 * before `wasm/media-time.ts` runs its top-level `TICKS_PER_SECOND()` call.
 *
 * FIDELITY
 * --------
 * These are ports of `rust/crates/time/src/media_time.rs`, not approximations:
 * the same 120 000 tick rate, the same half-away-from-zero rounding, the same
 * rational frame-rate arithmetic. Anything that cannot be reproduced faithfully
 * throws rather than returning a plausible-looking wrong number.
 *
 * This is a TEST SUPPORT module. It is never imported by engine code and never
 * reaches a shipped bundle. The right long-term fix is a local `wasm-pack`
 * build (plan M1 touches the wasm toolchain); until then this at least stops
 * "the wasm won't load in Bun" from meaning "the engine is untestable".
 */

import { mock } from "bun:test";

/**
 * 120 000 ticks/second — divides evenly into 24, 25, 30, 48, 50, 60, and into
 * the 1001-denominator drop-frame rates. Mirrors `TICKS_PER_SECOND` in the Rust
 * crate; asserted against the real value by the engine's own tests whenever the
 * wasm module can actually load.
 */
export const STUB_TICKS_PER_SECOND = 120_000;

interface FrameRateLike {
	numerator: number;
	denominator: number;
}

function roundHalfAwayFromZero(value: number): number {
	const magnitude = Math.round(Math.abs(value));
	if (magnitude === 0) return 0;
	return value < 0 ? -magnitude : magnitude;
}

/** Ticks per frame at a rational rate: ticksPerSecond * den / num. */
function ticksPerFrame({ rate }: { rate: FrameRateLike }): number {
	return (STUB_TICKS_PER_SECOND * rate.denominator) / rate.numerator;
}

export const wasmStub = {
	TICKS_PER_SECOND: () => STUB_TICKS_PER_SECOND,

	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) =>
		roundHalfAwayFromZero(seconds * STUB_TICKS_PER_SECOND),

	mediaTimeToSeconds: ({ time }: { time: number }) =>
		time / STUB_TICKS_PER_SECOND,

	roundToFrame: ({ time, rate }: { time: number; rate: FrameRateLike }) => {
		const perFrame = ticksPerFrame({ rate });
		return roundHalfAwayFromZero(roundHalfAwayFromZero(time / perFrame) * perFrame);
	},

	lastFrameTime: ({
		duration,
		rate,
	}: {
		duration: number;
		rate: FrameRateLike;
	}) => {
		const perFrame = ticksPerFrame({ rate });
		if (duration <= 0) return 0;
		const lastFrameIndex = Math.max(0, Math.ceil(duration / perFrame) - 1);
		return roundHalfAwayFromZero(lastFrameIndex * perFrame);
	},

	snappedSeekTime: ({
		time,
		duration,
		rate,
	}: {
		time: number;
		duration: number;
		rate: FrameRateLike;
	}) => {
		const perFrame = ticksPerFrame({ rate });
		const snapped = roundHalfAwayFromZero(
			roundHalfAwayFromZero(time / perFrame) * perFrame,
		);
		return Math.max(0, Math.min(snapped, duration));
	},

	parseTimecode: () => {
		throw new Error(
			"wasm-stub: parseTimecode is not reimplemented. Test timecode parsing against the real wasm build, not this stub.",
		);
	},

	// --- Link-time-only stand-ins ------------------------------------------
	// Everything below exists ONLY so `mock.module("opencut-wasm", ...)`
	// satisfies ESM named-export linking for modules that `import` these
	// (GPU compositor, effects/masks) without necessarily ever CALLING them —
	// e.g. `packages/editor-core/src/services/renderer/compositor/wasm-compositor.ts`'s
	// top-level `import { uploadTexture } from "opencut-wasm"` fails to LINK
	// (not just fails when called) if the mock object is missing the name,
	// which blocked every test that transitively imports `EditorCore` (which
	// is most of the engine, since nothing gated the renderer stack behind a
	// lazy import). None of these reproduce real GPU/compositor behavior —
	// same "throw rather than return a plausible-looking wrong number" rule
	// as `parseTimecode` above. If a test actually needs one of these to DO
	// something, that is real GPU work; test it against the real wasm build
	// (plan M1), not this stub.
	initializeGpu: () => {
		throw new Error("wasm-stub: initializeGpu is not reimplemented.");
	},
	initCompositor: () => {
		throw new Error("wasm-stub: initCompositor is not reimplemented.");
	},
	resizeCompositor: () => {
		throw new Error("wasm-stub: resizeCompositor is not reimplemented.");
	},
	getCompositorCanvas: () => {
		throw new Error("wasm-stub: getCompositorCanvas is not reimplemented.");
	},
	uploadTexture: () => {
		throw new Error("wasm-stub: uploadTexture is not reimplemented.");
	},
	releaseTexture: () => {
		throw new Error("wasm-stub: releaseTexture is not reimplemented.");
	},
	renderFrame: () => {
		throw new Error("wasm-stub: renderFrame is not reimplemented.");
	},
	getLastFrameProfile: () => [],
	applyEffectPasses: () => {
		throw new Error("wasm-stub: applyEffectPasses is not reimplemented.");
	},
	applyMaskFeather: () => {
		throw new Error("wasm-stub: applyMaskFeather is not reimplemented.");
	},
	floorToFrame: () => {
		throw new Error("wasm-stub: floorToFrame is not reimplemented.");
	},
	isFrameAligned: () => {
		throw new Error("wasm-stub: isFrameAligned is not reimplemented.");
	},
	formatTimecode: () => {
		throw new Error("wasm-stub: formatTimecode is not reimplemented.");
	},
	guessTimecodeFormat: () => {
		throw new Error("wasm-stub: guessTimecodeFormat is not reimplemented.");
	},
	mediaTimeAdd: ({ a, b }: { a: number; b: number }) => a + b,
	mediaTimeSub: ({ a, b }: { a: number; b: number }) => a - b,
	mediaTimeMax: ({ a, b }: { a: number; b: number }) => Math.max(a, b),
	mediaTimeMin: ({ a, b }: { a: number; b: number }) => Math.min(a, b),
	mediaTimeClamp: ({
		time,
		min,
		max,
	}: {
		time: number;
		min: number;
		max: number;
	}) => Math.min(Math.max(time, min), max),
	mediaTimeFromFrame: () => {
		throw new Error("wasm-stub: mediaTimeFromFrame is not reimplemented.");
	},
	mediaTimeToFrame: () => {
		throw new Error("wasm-stub: mediaTimeToFrame is not reimplemented.");
	},
};

mock.module("opencut-wasm", () => wasmStub);
