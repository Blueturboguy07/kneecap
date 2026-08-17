/**
 * Word-timestamp smoothing — plan M10 item 4, corpus `12` §1/§7.
 *
 * "Ship a smoothing pass — this is mandatory, not optional." whisper.cpp's
 * own author documents `--dtw` output as "an estimate of the moment the
 * model decided to output a certain token," not necessarily when it actually
 * occurred in the audio; punctuation "frequently misaligns"; some segments
 * are "completely inaccurate"; and the C++ port lacks OpenAI's own post-DTW
 * corrections (reference Python impl applies extra smoothing the port never
 * ported). Verified firsthand against real whisper.cpp 1.9.2 output on this
 * machine (`whisper-cli -dtw base.en -nfa`, bundled `jfk.wav` sample,
 * `ggml-base.en.bin`) — see `__tests__/fixtures/jfk-dtw-raw.ts` and its
 * header comment for exact provenance and the two concrete defects that run
 * exhibited (a punctuation token whose `t_dtw` collapsed onto the *previous*
 * word's `t_dtw` to the millisecond, and a DTW start that lands inside the
 * *next* token's own coarse window).
 *
 * SOURCE-VERIFIED DESIGN NOTE (not just corpus-derived): whisper.cpp's own
 * `whisper_full_get_token_data()` returns TWO independent timing signals per
 * token, confirmed by reading `src/whisper.cpp` (the DTW backtrace, ~line
 * 9120: `int64_t timestamp = (time_index * 2) + seek; // Each index on DTW
 * result = 20mS audio` — i.e. `t_dtw` is centiseconds, `ms = t_dtw * 10`) and
 * `examples/cli/cli.cpp`'s own karaoke (`-owts`) renderer, which — tellingly
 * — drives its word-highlight video timing off `token.t0`/`token.t1` (the
 * classic decoder-timestamp-token mechanism, coarser but monotonic and
 * segment-bounded by construction) and treats `t_dtw` as a separate,
 * finer-grained *refinement* signal, not the sole source of truth. This
 * module follows that same precedent deliberately: `coarseStartMicros`/
 * `coarseEndMicros` (from `t0`/`t1`) are the reliable envelope; `dtwStartMicros`
 * (from `t_dtw`, when whisper.cpp computed it) refines the start *within*
 * that envelope when it's trustworthy, and is discarded in favor of the
 * coarse value otherwise. This is a stronger, more defensible baseline than
 * trusting raw `t_dtw` outright — which is exactly what the plan's
 * "mandatory smoothing pass" line is asking for.
 *
 * The four required behaviors (plan M10 item 4), each a distinct pipeline
 * stage below:
 *   1. clamp implausible gaps           -> `clampImplausibleGaps`
 *   2. monotonically enforce ordering   -> `enforceMonotonicity`
 *   3. snap punctuation to the          -> `mergePunctuation`
 *      preceding word's end
 *   4. interpolate outliers against     -> `interpolateOutliers`
 *      segment bounds
 */

/** One decoded token as a real native plugin would read it off
 * `whisper_full_get_token_data(ctx, i_segment, i_token)` after filtering out
 * non-text tokens (`id >= whisper_token_eot(ctx)`, whisper.cpp's own rule —
 * see `cli.cpp`'s karaoke renderer). Units: integer microseconds, matching
 * this package's unit discipline for every native-precision timestamp
 * (`MediaHandle.durationMicros`, `TranscriptSegment.startMicros`) — the
 * seconds/centiseconds->ticks boundary is never crossed here; that is
 * editor-core's job alone (see `types.ts`'s header comment). */
export interface RawWordTiming {
	/** Decoded text for this token, exactly as whisper.cpp emitted it
	 * (leading space included, e.g. `" Americans"`, `","`). */
	text: string;
	/** From `token.t0` — the classic per-token timestamp. Always present,
	 * always `<= coarseEndMicros`, and non-decreasing across a segment's
	 * tokens by construction (whisper.cpp guarantees this; it is not
	 * re-derived here). */
	coarseStartMicros: number;
	/** From `token.t1`. */
	coarseEndMicros: number;
	/** From `token.t_dtw`, converted to microseconds, or `null` when
	 * whisper.cpp reports its `-1` "not computed" sentinel (special tokens,
	 * or DTW simply disabled/unavailable for this run). */
	dtwStartMicros: number | null;
	/** Token decode probability (`token.p`), or `null` when the native side
	 * has no confidence signal for this timing source. */
	confidence: number | null;
}

export interface SmoothedWord {
	text: string;
	startMicros: number;
	endMicros: number;
	confidence: number | null;
}

export interface SmoothingStats {
	inputTokens: number;
	/** Punctuation-only tokens whose own (unreliable) timestamp was
	 * discarded and glued textually onto the preceding word instead. */
	punctuationMerged: number;
	/** Raw DTW starts rejected because they fell outside the segment
	 * envelope (segment-bounds is the outermost sanity check, applied
	 * before the ordering pass even runs). */
	dtwRejectedOutOfSegment: number;
	/** Words whose start had to be pulled forward to preserve non-decreasing
	 * order against the previous word's end. */
	monotonicityFixed: number;
	/** Inter-word gaps compressed because they exceeded
	 * `MAX_PLAUSIBLE_GAP_MICROS`. */
	gapsClamped: number;
	/** Words whose resolved duration exceeded `MAX_WORD_DURATION_MICROS` and
	 * were re-timed by interpolating against their nearest good neighbors
	 * (or the segment bounds, at either edge). */
	outliersInterpolated: number;
}

export interface SmoothingResult {
	words: SmoothedWord[];
	stats: SmoothingStats;
}

/** A token is punctuation-only if, once whitespace is trimmed, every
 * remaining character is a sentence/clause mark. Deliberately narrow: an
 * emoji or a word like "Mr." keeps its letters and is NOT treated as
 * punctuation-only (only "." alone would be). */
const PUNCTUATION_ONLY_RE = /^[,.!?;:…]+$/;

function isPunctuationOnly(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.length > 0 && PUNCTUATION_ONLY_RE.test(trimmed);
}

/** A spoken word rarely takes less than this to say; used as a floor so a
 * degenerate zero/negative-duration word (e.g. two tokens resolving to the
 * same instant, as the real captured "you" / "," collision in the fixture
 * does) still renders as a visible caption span. */
export const MIN_WORD_DURATION_MICROS = 40_000; // 40ms

/** A single word spanning longer than this is far more likely a DTW/coarse
 * misalignment than genuine slow speech — the exact "some segments are
 * completely inaccurate" failure mode the corpus warns about. Triggers
 * interpolation rather than being trusted at face value. */
export const MAX_WORD_DURATION_MICROS = 2_500_000; // 2.5s

/** Within a single whisper.cpp segment (already pause-bounded by whisper's
 * own VAD/segmenting — if there were a genuine multi-second silence here,
 * whisper would ordinarily have cut a new segment at it), a gap this long
 * between two adjacent words reads as a DTW artifact, not real silence. */
export const MAX_PLAUSIBLE_GAP_MICROS = 1_200_000; // 1.2s

interface WorkingWord {
	text: string;
	start: number;
	end: number;
	confidence: number | null;
	/** Carried through so `interpolateOutliers` can weight multi-outlier
	 * spans by text length rather than splitting evenly. */
	sourceLength: number;
}

/**
 * The full pipeline. Operates on ONE whisper.cpp segment's tokens at a time
 * (segment bounds are the outermost clamp — see module header) — a native
 * plugin calling this once per `whisper_full_n_segments()` entry, exactly
 * mirroring how whisper.cpp itself scopes a DTW backtrace to one segment.
 */
export function smoothWordTimings({
	tokens,
	segmentStartMicros,
	segmentEndMicros,
}: {
	tokens: RawWordTiming[];
	segmentStartMicros: number;
	segmentEndMicros: number;
}): SmoothingResult {
	const stats: SmoothingStats = {
		inputTokens: tokens.length,
		punctuationMerged: 0,
		dtwRejectedOutOfSegment: 0,
		monotonicityFixed: 0,
		gapsClamped: 0,
		outliersInterpolated: 0,
	};

	const nonEmpty = tokens.filter((t) => t.text.trim().length > 0);

	// --- Stage 0: resolve each token's provisional (start, end), clamped to
	// the segment envelope. This is the "interpolate outliers against
	// segment bounds" rule's outer half: nothing downstream is ever allowed
	// to reference a time outside [segmentStartMicros, segmentEndMicros].
	const resolved = nonEmpty.map((t) => {
		let start = t.dtwStartMicros ?? t.coarseStartMicros;
		if (start < segmentStartMicros || start > segmentEndMicros) {
			if (t.dtwStartMicros !== null) stats.dtwRejectedOutOfSegment++;
			start = clamp({
				value: t.coarseStartMicros,
				min: segmentStartMicros,
				max: segmentEndMicros,
			});
		}
		const end = clamp({
			value: Math.max(t.coarseEndMicros, start),
			min: segmentStartMicros,
			max: segmentEndMicros,
		});
		return {
			text: t.text,
			start,
			end,
			confidence: t.confidence,
		};
	});

	// --- Stage 1 (plan rule 3): snap punctuation to the preceding word's
	// end. The punctuation token's OWN timestamp is discarded outright, not
	// blended — it is exactly the signal the corpus calls out as least
	// trustworthy ("punctuation frequently misaligns... appears long after
	// its actual occurrence"). Text is glued with no separating space.
	const merged: WorkingWord[] = [];
	for (const w of resolved) {
		if (isPunctuationOnly(w.text) && merged.length > 0) {
			const prev = merged[merged.length - 1];
			prev.text += w.text.trim();
			stats.punctuationMerged++;
			continue;
		}
		merged.push({
			text: w.text,
			start: w.start,
			end: w.end,
			confidence: w.confidence,
			sourceLength: w.text.trim().length || 1,
		});
	}

	// --- Stage 2 (plan rule 2): monotonically enforce ordering. Walk
	// left-to-right with a running cursor; nothing may start before the
	// previous word ended, and every word gets at least
	// MIN_WORD_DURATION_MICROS.
	let cursor = segmentStartMicros;
	for (const w of merged) {
		const original = w.start;
		w.start = Math.max(w.start, cursor);
		if (w.start !== original) stats.monotonicityFixed++;
		w.end = Math.max(w.end, w.start + MIN_WORD_DURATION_MICROS);
		cursor = w.end;
	}

	// --- Stage 3 (plan rule 1): clamp implausible gaps. A pass over real
	// (already non-overlapping) gaps, not artifacts of stage 2's own
	// forward-pull. Re-run again after stage 4 below, since interpolation
	// can itself open a new trailing gap it doesn't know about.
	clampGaps({ words: merged, stats });

	// --- Stage 4 (plan rule 4): interpolate outliers against segment
	// bounds. Find maximal runs of implausibly-long words and re-time each
	// to a NATURAL estimated duration (proportional to text length, at a
	// fixed assumed speaking pace) rather than stretching it to fill
	// whatever span happens to be available — filling the full span would
	// just relocate the "implausibly long" problem instead of fixing it
	// when the two surrounding good neighbors are themselves far apart.
	let i = 0;
	while (i < merged.length) {
		if (merged[i].end - merged[i].start <= MAX_WORD_DURATION_MICROS) {
			i++;
			continue;
		}
		let j = i;
		while (
			j < merged.length &&
			merged[j].end - merged[j].start > MAX_WORD_DURATION_MICROS
		) {
			j++;
		}
		const spanStart = i > 0 ? merged[i - 1].end : segmentStartMicros;
		const spanEnd = j < merged.length ? merged[j].start : segmentEndMicros;
		const run = merged.slice(i, j);
		// ~70 microseconds-of-audio per character is a rough, deliberately
		// simple stand-in for natural speaking pace (~150-170 wpm at ~5
		// chars/word) — good enough for "not implausible," which is all
		// this rule needs to guarantee. Always clamped into
		// [MIN_WORD_DURATION_MICROS, MAX_WORD_DURATION_MICROS] per word, so
		// a single re-timed word can never itself become a new outlier.
		const estimated = run.map((w) =>
			clamp({
				value: w.sourceLength * 70_000,
				min: MIN_WORD_DURATION_MICROS,
				max: MAX_WORD_DURATION_MICROS,
			}),
		);
		const totalEstimated = estimated.reduce((sum, d) => sum + d, 0) || 1;
		const availableSpan = Math.max(
			spanEnd - spanStart,
			MIN_WORD_DURATION_MICROS * run.length,
		);
		// Only ever compress (never stretch a word beyond its natural
		// estimate just because extra space happens to be available —
		// that extra space becomes a legitimate gap instead, handled by
		// the gap-clamp re-pass below).
		const scale = totalEstimated > availableSpan ? availableSpan / totalEstimated : 1;
		let t = spanStart;
		for (let k = 0; k < run.length; k++) {
			const d = estimated[k] * scale;
			run[k].start = t;
			run[k].end = t + d;
			t = run[k].end;
			stats.outliersInterpolated++;
		}
		i = j;
	}

	// --- Stage 5: final safety net. Re-assert monotonicity (interpolation
	// resolves each run against a snapshot of its neighbors, which could in
	// principle leave a millisecond-scale seam between adjacent runs) and
	// re-clamp gaps (interpolation can leave a large trailing gap before
	// the next good word when a run's natural duration is much shorter
	// than the span it was given). Unconditional rather than argued safe.
	cursor = segmentStartMicros;
	for (const w of merged) {
		w.start = Math.max(w.start, cursor);
		w.end = Math.max(w.end, w.start + MIN_WORD_DURATION_MICROS);
		cursor = w.end;
	}
	clampGaps({ words: merged, stats });

	return {
		words: merged.map((w) => ({
			text: w.text,
			startMicros: w.start,
			endMicros: w.end,
			confidence: w.confidence,
		})),
		stats,
	};
}

function clamp({
	value,
	min,
	max,
}: {
	value: number;
	min: number;
	max: number;
}): number {
	return Math.min(Math.max(value, min), max);
}

/** Shared by stage 3 and stage 5: compress any gap between adjacent words
 * that exceeds `MAX_PLAUSIBLE_GAP_MICROS` down to the ceiling by
 * TRANSLATING the later word earlier (start and end shift by the same
 * amount). Deliberately a translation, not a one-sided pull on `start`
 * alone: shifting only `start` would inflate that word's own duration by
 * the exact size of the excess gap, which can spuriously push a
 * perfectly normal word over `MAX_WORD_DURATION_MICROS` and hand it to the
 * outlier-interpolation stage for no reason — a real bug caught by this
 * module's own gap-clamp test. Mutates `words` in place. */
function clampGaps({
	words,
	stats,
}: {
	words: WorkingWord[];
	stats: SmoothingStats;
}): void {
	for (let i = 1; i < words.length; i++) {
		const gap = words[i].start - words[i - 1].end;
		if (gap > MAX_PLAUSIBLE_GAP_MICROS) {
			const shift = gap - MAX_PLAUSIBLE_GAP_MICROS;
			words[i].start -= shift;
			words[i].end -= shift;
			stats.gapsClamped++;
		}
	}
}

/** Diagnostic-only helper (not part of the pipeline): counts monotonicity
 * violations in a raw, unsorted DTW-start sequence — used by the fixture
 * test to report a real "defects before smoothing" number rather than an
 * assertion with no baseline. */
export function countMonotonicityViolations(
	startsMicros: readonly (number | null)[],
): number {
	let violations = 0;
	let last: number | null = null;
	for (const s of startsMicros) {
		if (s === null) continue;
		if (last !== null && s <= last) violations++;
		last = s;
	}
	return violations;
}
