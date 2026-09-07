/**
 * Dead-space detection — the analysis behind the timeline's "Cut gaps" verb
 * (founder, 2026-08-25: "when i select a clip i can cut all deadspace
 * without speech or any significant audio … it should be cut up like how a
 * human would cut it up and the clips that it makes should be concatenated
 * but not connected").
 *
 * Two layers, deliberately separated, because they fail differently:
 *
 *  1. MEASUREMENT (`FrameFeatureExtractor` + the gate in `detectDeadSpace`)
 *     — where is anyone TALKING. Short-time features on 20 ms frames at a
 *     10 ms hop, the standard speech-VAD framing: RMS in dBFS, RMS of the
 *     300-3400 Hz speech band, a zero-crossing rate, and a voicing
 *     confidence from the peak normalized autocorrelation.
 *
 *  2. EDITORIAL (`applyEditorialRules`) — where would a PERSON cut. The
 *     measurement's raw boundaries are not cut points: a human leaves air
 *     before a first syllable, a longer beat after a last one, never cuts a
 *     200 ms breath between words, and never leaves a 3-frame sliver.
 *
 * Design notes on the measurement, since the naive versions of this feature
 * all fail the same three ways:
 *
 *  - RMS, NOT PEAK. A single mouse click or a table bump is a peak; gating
 *    on peaks opens the gate on transients and keeps dead air. The repo's
 *    cached `SourceWaveformSummary` is peak-per-128-samples — great for
 *    DRAWING a waveform, wrong for gating one, which is why this module
 *    computes its own features instead of reusing it.
 *
 *  - AN ADAPTIVE THRESHOLD, NOT A FIXED dBFS. A hardcoded "-40 dBFS is
 *    silence" never fires on a quiet phone recording and fires constantly
 *    in a loud room. The noise floor is MEASURED as a low percentile of the
 *    frame energies and the gate is set a margin above it, so the same
 *    button behaves the same way on a whisper and on a shout.
 *
 *  - HYSTERESIS AND HANGOVER, NOT A BARE COMPARISON. One threshold chatters
 *    at the boundary and shreds a clip into dozens of pieces mid-word. The
 *    gate here is a Schmitt trigger (open high, close low) with a release
 *    tail, the same shape as a hardware noise gate.
 *
 *  - SPEECH, NOT SOUND. This is the one the first version got wrong
 *    (founder, 2026-08-27: "it needs to work for speech specifically, i
 *    think its counting any gap in noise"). Gating on wideband level makes
 *    every sound in the room "significant audio", so a pause containing
 *    traffic, a fan, handling noise or someone off-mic never reads as a gap
 *    at all — and a pause with something in it is the normal case, not the
 *    exotic one. Two independent tests fix it, because either alone is
 *    fooled: the band filter removes what is not in speech's frequency
 *    range, and voicing removes what is not periodic. Rumble passes the
 *    second and fails the first; hiss passes the first and fails the second.
 *
 * And one more, which is what actually separates this from a noise gate:
 * unvoiced fricatives (the /s/ in "yes", the /f/ in "off") sit 15-25 dB
 * below the vowels around them but carry a very high zero-crossing rate.
 * Energy alone deletes them and you get clipped, lisping word endings — the
 * single most audible artifact of automated silence removal. `zcr` exists
 * so `rescueFricatives` can walk a boundary back outward while the signal
 * still looks like broadband noise, the same idea as the endpoint extension
 * in classic Rabiner-Sambur endpointing.
 *
 * This file is pure and DOM-free on purpose: everything here is testable
 * against synthesised buffers, and `analyzeSourceDeadSpace` (media/
 * dead-space-analysis.ts) owns the decoding that isn't.
 */

/** Floor for the dB conversion: digital silence would otherwise be -Inf. */
export const SILENCE_DB_FLOOR = -100;

/**
 * At or below this, the signal is ABSENT — a muted stretch, a padded head,
 * a gap between packets — not a quiet room.
 *
 * The distinction matters because the noise floor is what the gate is
 * measured against. Found live on a real 32 s screen recording
 * (2026-08-25): it contained a stretch of exact digital zeros, the floor
 * estimate came back -100 dBFS, the gate landed at -92, every breath of
 * room tone in the file counted as "significant audio", and the clip was
 * reported as having nothing to cut. Room tone is what the threshold has to
 * clear; true silence is just something to cut, and it must not be allowed
 * to define the floor.
 */
const ABSENT_SIGNAL_DB = SILENCE_DB_FLOOR + 10;

export const DEFAULT_FRAME_MS = 20;
export const DEFAULT_HOP_MS = 10;

export interface FrameFeatures {
	/** Per-frame RMS in dBFS, clamped at `SILENCE_DB_FLOOR`. */
	rmsDb: Float32Array;
	/**
	 * Per-frame RMS in dBFS of the SPEECH BAND only (see `SPEECH_BAND_LOW_HZ`
	 * / `SPEECH_BAND_HIGH_HZ`). This, not `rmsDb`, is what the gate measures.
	 */
	bandRmsDb: Float32Array;
	/**
	 * Per-frame voicing confidence in 0..1: the peak normalized
	 * autocorrelation over the plausible-F0 lag range. Voiced speech runs
	 * 0.5-0.95; room tone, fans, traffic and handling noise sit well under
	 * 0.3 no matter how loud they are.
	 */
	voicing: Float32Array;
	/** Per-frame zero-crossing rate as crossings-per-sample (0..1). */
	zcr: Float32Array;
	sampleRate: number;
	frameSec: number;
	hopSec: number;
	/** Mono samples consumed, i.e. the true source duration in samples. */
	sampleCount: number;
}

/**
 * The gate measures this band, not the full spectrum.
 *
 * Gating on full-band RMS makes the feature a NOISE gate: every sound in the
 * room is "significant audio", so a pause with a fan, a passing car, an air
 * conditioner, wind, a hand moving on the phone, or mains hum in it never
 * reads as a gap at all. That is a different question from the one the
 * button asks, which is "is anyone talking here".
 *
 * 300-3400 Hz is the classic telephony speech band: it holds F0 for most
 * adult voices plus the first two formants, which is where speech
 * intelligibility lives. Rumble, handling noise, HVAC and hum sit below it;
 * hiss, clicks and most room ambience have their energy spread far outside
 * it. Band-limiting first is the cheapest large win available here, and it
 * is the first stage of essentially every real voice-activity detector.
 */
export const SPEECH_BAND_LOW_HZ = 300;
export const SPEECH_BAND_HIGH_HZ = 3400;

/**
 * Plausible fundamental-frequency range for the voicing search, in Hz.
 *
 * Deliberately narrower at the bottom than the 85 Hz a bass male voice can
 * reach: the analysis window is one 20 ms frame, and a lag longer than half
 * the frame has too little overlap left to correlate honestly. This costs
 * nothing in practice because voicing DETECTION is not F0 ESTIMATION — a
 * harmonic-rich 90 Hz voice still puts a strong autocorrelation peak at its
 * second harmonic, which is inside this range. We only need to know that the
 * frame is periodic, not what note it is.
 */
const VOICING_MIN_F0_HZ = 100;
const VOICING_MAX_F0_HZ = 400;

/** Target rate for the decimated voicing search. */
const VOICING_TARGET_RATE_HZ = 8000;

/**
 * Width, in frames, of the median filter applied to the voicing DECISION
 * before the gate sees it. At a 10 ms hop this is 70 ms: a frame counts as
 * voiced only if at least four of the seven frames around it are.
 *
 * Noise correlates by accident. Not often, but a stretch of hiss throws an
 * isolated frame over the voicing threshold every few hundred milliseconds,
 * and a single spike is enough to re-open the gate and restart the hangover
 * — so a pause full of noise never accumulates the consecutive quiet frames
 * it needs to close, and the gap is never found. That failure is invisible
 * in the voicing numbers themselves, which look mostly correct.
 *
 * Real voicing is not like that: vowels run from about 50 ms to several
 * hundred, so genuine speech clears a four-of-seven vote comfortably while
 * isolated accidents do not. Demanding duration is what turns a frame-level
 * measurement into a usable decision.
 *
 * Seven is the narrowest width that holds on the noise-filled-pause case;
 * nine and eleven were measured and change nothing, so this keeps the
 * shortest window that works rather than the widest that also does.
 */
const VOICING_MEDIAN_FRAMES = 7;

/**
 * Below this band level a frame is too quiet to be worth correlating, and
 * the autocorrelation of near-silence is numerically meaningless anyway.
 * Skipping them is also most of the voicing search's speed.
 */
const VOICING_MIN_LEVEL_DB = -75;

interface BiquadCoefficients {
	b0: number;
	b1: number;
	b2: number;
	a1: number;
	a2: number;
}

/**
 * One RBJ-cookbook biquad section, 12 dB/octave.
 *
 * Two of these (a high-pass and a low-pass) bracket the speech band. A
 * one-pole pair would be 10 lines shorter and 6 dB/octave, which leaves
 * 60 Hz hum only ~14 dB down inside a band that starts at 300 Hz — not
 * enough to stop a hum from holding the gate open, which is the entire
 * point of filtering here.
 */
function makeLowpass({
	sampleRate,
	cutoffHz,
}: {
	sampleRate: number;
	cutoffHz: number;
}): BiquadCoefficients {
	const w0 = (2 * Math.PI * Math.min(cutoffHz, sampleRate * 0.45)) / sampleRate;
	const cos = Math.cos(w0);
	const alpha = Math.sin(w0) / Math.SQRT2;
	const a0 = 1 + alpha;
	return {
		b0: ((1 - cos) / 2) / a0,
		b1: (1 - cos) / a0,
		b2: ((1 - cos) / 2) / a0,
		a1: (-2 * cos) / a0,
		a2: (1 - alpha) / a0,
	};
}

function makeHighpass({
	sampleRate,
	cutoffHz,
}: {
	sampleRate: number;
	cutoffHz: number;
}): BiquadCoefficients {
	const w0 = (2 * Math.PI * Math.min(cutoffHz, sampleRate * 0.45)) / sampleRate;
	const cos = Math.cos(w0);
	const alpha = Math.sin(w0) / Math.SQRT2;
	const a0 = 1 + alpha;
	return {
		b0: ((1 + cos) / 2) / a0,
		b1: (-(1 + cos)) / a0,
		b2: ((1 + cos) / 2) / a0,
		a1: (-2 * cos) / a0,
		a2: (1 - alpha) / a0,
	};
}

/** Direct-form-I state for one biquad section. */
class BiquadState {
	private x1 = 0;
	private x2 = 0;
	private y1 = 0;
	private y2 = 0;
	constructor(private readonly c: BiquadCoefficients) {}
	step(x: number): number {
		const { b0, b1, b2, a1, a2 } = this.c;
		const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
		this.x2 = this.x1;
		this.x1 = x;
		this.y2 = this.y1;
		this.y1 = y;
		return y;
	}
}

/**
 * Peak normalized autocorrelation of one frame over the F0 lag range — the
 * voicing confidence.
 *
 * Normalized (divided by the energy of both windows) rather than raw, so the
 * result is a correlation in -1..1 that means the same thing at any volume.
 * A raw autocorrelation peak is proportional to loudness, which would just
 * reintroduce the energy gate under a different name.
 *
 * Voiced speech is periodic and scores high. Room tone, fans, air, traffic,
 * paper and handling noise are aperiodic and score low however loud they
 * are — which is exactly the discrimination an energy gate cannot make.
 */
export function frameVoicing({
	samples,
	start,
	length,
	minLag,
	maxLag,
}: {
	samples: Float32Array;
	start: number;
	length: number;
	minLag: number;
	maxLag: number;
}): number {
	const usableMaxLag = Math.min(maxLag, Math.floor(length / 2));
	if (usableMaxLag < minLag) return 0;

	// Scan one lag either side of the range so the first and last candidate
	// lag can still be tested for being a local maximum.
	const from = Math.max(1, minLag - 1);
	const to = Math.min(Math.floor(length / 2), usableMaxLag + 1);
	let best = 0;
	let prev2 = 0;
	let prev1 = 0;
	for (let lag = from; lag <= to; lag++) {
		const n = length - lag;
		let dot = 0;
		let energyA = 0;
		let energyB = 0;
		for (let i = 0; i < n; i++) {
			const a = samples[start + i];
			const b = samples[start + i + lag];
			dot += a * b;
			energyA += a * a;
			energyB += b * b;
		}
		const denom = Math.sqrt(energyA * energyB);
		const score = denom > 0 ? dot / denom : 0;
		// Only a LOCAL MAXIMUM counts, and only inside the F0 range.
		//
		// Taking the plain maximum over the range is the version that looks
		// obviously right and is wrong: for any smooth or narrowband signal
		// the autocorrelation just decays from lag 0, so the largest value in
		// the range is always at its left edge and every low-frequency
		// rumble, every band-limited hiss, scores as confidently "voiced".
		// A genuinely periodic signal is different in kind, not degree — it
		// comes BACK UP at its period. Requiring the turn is what separates
		// "this repeats" from "this changes slowly".
		const lagOfPrev1 = lag - 1;
		if (
			lagOfPrev1 >= minLag &&
			lagOfPrev1 <= usableMaxLag &&
			prev1 > prev2 &&
			prev1 >= score &&
			prev1 > best
		) {
			best = prev1;
		}
		prev2 = prev1;
		prev1 = score;
	}
	return best;
}

/**
 * Streaming feature extractor: push decoded mono chunks in any sizes, get
 * frames out at `finish()`.
 *
 * Streaming rather than "decode the whole clip to a Float32Array, then
 * analyse" is not a style preference — a 10-minute 48 kHz clip is 115 MB of
 * float samples in the JS heap, which is the jetsam vector `media/
 * playable-source.ts` already documents for this app. Features are four
 * float arrays at ~100 frames per second (1.6 KB/s), so a 10-minute clip
 * costs under 1 MB no matter how long it runs — measured at 937 KB for 600
 * seconds, against 115 MB for the samples themselves.
 */
export class FrameFeatureExtractor {
	private readonly frameSamples: number;
	private readonly hopSamples: number;
	private readonly sampleRate: number;
	private buffer: Float32Array;
	/**
	 * The speech-band-filtered signal, index-for-index with `buffer`. Kept as
	 * a parallel array rather than refiltered per frame because frames
	 * overlap: the biquads are stateful, so a frame cannot re-run them over
	 * samples an earlier frame already consumed.
	 */
	private bandBuffer: Float32Array;
	private length = 0;
	private cursor = 0;
	private sampleCount = 0;
	private readonly rmsDb: number[] = [];
	private readonly bandRmsDb: number[] = [];
	private readonly voicing: number[] = [];
	private readonly zcr: number[] = [];
	private readonly bandHighpass: BiquadState;
	private readonly bandHighpass2: BiquadState;
	private readonly bandLowpass: BiquadState;
	/** Decimation factor and lag bounds for the voicing autocorrelation. */
	private readonly decimation: number;
	private readonly voicingMinLag: number;
	private readonly voicingMaxLag: number;
	/** Scratch for one decimated frame; reused so the search allocates nothing. */
	private readonly decimated: Float32Array;
	/** One-pole DC-blocker state, carried across pushes — see `push`. */
	private dcPrevIn = 0;
	private dcPrevOut = 0;

	constructor({
		sampleRate,
		frameMs = DEFAULT_FRAME_MS,
		hopMs = DEFAULT_HOP_MS,
	}: {
		sampleRate: number;
		frameMs?: number;
		hopMs?: number;
	}) {
		if (!(sampleRate > 0)) {
			throw new Error(`FrameFeatureExtractor: bad sampleRate ${sampleRate}`);
		}
		this.sampleRate = sampleRate;
		this.frameSamples = Math.max(2, Math.round((sampleRate * frameMs) / 1000));
		this.hopSamples = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
		this.buffer = new Float32Array(this.frameSamples * 4);
		this.bandBuffer = new Float32Array(this.frameSamples * 4);
		// TWO cascaded high-pass sections, 24 dB/octave, not one.
		//
		// The bottom edge is the one that has to be steep. Rumble — HVAC,
		// traffic, a hand on the phone — is both the loudest non-speech thing
		// in a typical recording and the closest to the band edge, and after
		// only 12 dB/octave enough of it survives at 300 Hz to sit above the
		// gate. Worse, what survives is NARROWBAND, and narrowband noise is
		// quasi-periodic: it passes the voicing test too, because over a 20 ms
		// window it genuinely does repeat. Neither the level test nor the
		// periodicity test can reject it downstream, so it has to be removed
		// here. The extra section is five multiplies per sample.
		this.bandHighpass = new BiquadState(
			makeHighpass({ sampleRate, cutoffHz: SPEECH_BAND_LOW_HZ }),
		);
		this.bandHighpass2 = new BiquadState(
			makeHighpass({ sampleRate, cutoffHz: SPEECH_BAND_LOW_HZ }),
		);
		this.bandLowpass = new BiquadState(
			makeLowpass({ sampleRate, cutoffHz: SPEECH_BAND_HIGH_HZ }),
		);
		// The band-limited signal carries nothing above SPEECH_BAND_HIGH_HZ, so
		// the low-pass IS the anti-alias filter and plain decimation is safe.
		// Correlating at ~8 kHz instead of 48 kHz is a 6x cut in the only part
		// of this file whose cost grows with lag range.
		this.decimation = Math.max(1, Math.floor(sampleRate / VOICING_TARGET_RATE_HZ));
		const decimatedRate = sampleRate / this.decimation;
		this.voicingMinLag = Math.max(2, Math.floor(decimatedRate / VOICING_MAX_F0_HZ));
		this.voicingMaxLag = Math.max(
			this.voicingMinLag + 1,
			Math.ceil(decimatedRate / VOICING_MIN_F0_HZ),
		);
		this.decimated = new Float32Array(
			Math.ceil(this.frameSamples / this.decimation) + 1,
		);
	}

	/**
	 * Feed one decoded chunk of MONO samples.
	 *
	 * A one-pole DC blocker runs first (`y[n] = x[n] - x[n-1] + R*y[n-1]`).
	 * Phone and USB-mic captures routinely carry a DC offset of a few
	 * hundredths full-scale; left in, it raises the measured RMS of true
	 * silence (so the noise floor lands too high) and pins the signal to one
	 * side of zero (so the zero-crossing rate reads ~0 and the fricative
	 * rescue below never fires). Removing it is two multiplies per sample.
	 */
	push({ samples }: { samples: Float32Array }): void {
		if (samples.length === 0) return;
		this.ensureCapacity({ extra: samples.length });
		const buffer = this.buffer;
		const bandBuffer = this.bandBuffer;
		const highpass = this.bandHighpass;
		const highpass2 = this.bandHighpass2;
		const lowpass = this.bandLowpass;
		let write = this.length;
		let prevIn = this.dcPrevIn;
		let prevOut = this.dcPrevOut;
		for (let i = 0; i < samples.length; i++) {
			const x = samples[i];
			const y = x - prevIn + 0.995 * prevOut;
			prevIn = x;
			prevOut = y;
			buffer[write] = y;
			bandBuffer[write] = lowpass.step(highpass2.step(highpass.step(y)));
			write++;
		}
		this.dcPrevIn = prevIn;
		this.dcPrevOut = prevOut;
		this.length = write;
		this.sampleCount += samples.length;
		this.drainFrames();
	}

	finish(): FrameFeatures {
		return {
			rmsDb: Float32Array.from(this.rmsDb),
			bandRmsDb: Float32Array.from(this.bandRmsDb),
			voicing: Float32Array.from(this.voicing),
			zcr: Float32Array.from(this.zcr),
			sampleRate: this.sampleRate,
			frameSec: this.frameSamples / this.sampleRate,
			hopSec: this.hopSamples / this.sampleRate,
			sampleCount: this.sampleCount,
		};
	}

	private ensureCapacity({ extra }: { extra: number }): void {
		// `bandBuffer` is index-for-index with `buffer` and must be compacted
		// and grown in exactly the same steps, or the band level and the
		// wideband level would be read from different parts of the signal.
		if (this.cursor > 0) {
			this.buffer.copyWithin(0, this.cursor, this.length);
			this.bandBuffer.copyWithin(0, this.cursor, this.length);
			this.length -= this.cursor;
			this.cursor = 0;
		}
		const needed = this.length + extra;
		if (needed <= this.buffer.length) return;
		const size = Math.max(needed, this.buffer.length * 2);
		const grown = new Float32Array(size);
		grown.set(this.buffer.subarray(0, this.length));
		this.buffer = grown;
		const grownBand = new Float32Array(size);
		grownBand.set(this.bandBuffer.subarray(0, this.length));
		this.bandBuffer = grownBand;
	}

	private drainFrames(): void {
		const { buffer, bandBuffer, frameSamples, hopSamples } = this;
		while (this.length - this.cursor >= frameSamples) {
			const start = this.cursor;
			const end = start + frameSamples;
			let sumSquares = 0;
			let bandSumSquares = 0;
			let crossings = 0;
			let prev = buffer[start];
			for (let i = start; i < end; i++) {
				const value = buffer[i];
				const band = bandBuffer[i];
				sumSquares += value * value;
				bandSumSquares += band * band;
				// Strict sign change only: a run of exact zeros (digital
				// silence) must NOT read as a crossing on every sample, or
				// silence would look like the noisiest thing in the file.
				if ((value > 0 && prev < 0) || (value < 0 && prev > 0)) {
					crossings++;
				}
				if (value !== 0) prev = value;
			}
			const rms = Math.sqrt(sumSquares / frameSamples);
			this.rmsDb.push(
				rms > 0 ? Math.max(SILENCE_DB_FLOOR, 20 * Math.log10(rms)) : SILENCE_DB_FLOOR,
			);
			const bandRms = Math.sqrt(bandSumSquares / frameSamples);
			const bandDb =
				bandRms > 0
					? Math.max(SILENCE_DB_FLOOR, 20 * Math.log10(bandRms))
					: SILENCE_DB_FLOOR;
			this.bandRmsDb.push(bandDb);
			this.voicing.push(
				bandDb <= VOICING_MIN_LEVEL_DB
					? 0
					: this.measureVoicing({ start, end }),
			);
			this.zcr.push(crossings / frameSamples);
			this.cursor += hopSamples;
		}
	}

	/**
	 * Voicing for one frame, measured on the band-limited signal decimated to
	 * ~8 kHz.
	 *
	 * The correlation runs over the frame's OWN samples with no lookahead, so
	 * nothing here depends on data the extractor has not received yet. That
	 * is what keeps the streaming contract intact and keeps frame emission
	 * identical whether the caller pushes the file in one chunk or in 997-
	 * sample dribbles.
	 */
	private measureVoicing({ start, end }: { start: number; end: number }): number {
		const { bandBuffer, decimation, decimated } = this;
		let count = 0;
		for (let i = start; i < end && count < decimated.length; i += decimation) {
			decimated[count++] = bandBuffer[i];
		}
		return frameVoicing({
			samples: decimated,
			start: 0,
			length: count,
			minLag: this.voicingMinLag,
			maxLag: this.voicingMaxLag,
		});
	}
}

/** Mixes an `AudioBuffer`-shaped channel set down to one mono chunk. */
export function downmixToMono({
	channels,
	length,
}: {
	channels: Float32Array[];
	length: number;
}): Float32Array {
	if (channels.length === 1) return channels[0].subarray(0, length);
	const mono = new Float32Array(length);
	for (const channel of channels) {
		for (let i = 0; i < length; i++) mono[i] += channel[i] ?? 0;
	}
	const scale = 1 / channels.length;
	for (let i = 0; i < length; i++) mono[i] *= scale;
	return mono;
}

// ------------------------------- detection ---------------------------------

export interface DeadSpaceOptions {
	/**
	 * A RAW silence shorter than this is RHYTHM, not dead air, and is left
	 * alone. This is the single knob that decides whether the result sounds
	 * human or breathless.
	 *
	 * "Raw" is load-bearing: it is the gap as it exists in the recording, not
	 * what survives padding. See `applyEditorialRules` for why that
	 * distinction cost this feature every cut it should have made.
	 *
	 * The floor is not a taste call. Silent intervals under ~200 ms are not
	 * consciously perceived as pauses at all -- they are articulatory and
	 * segmental timing, and 200 ms is the threshold at which listeners start
	 * hearing a break in the speech flow (it is also the standard cutoff in
	 * the L2-fluency literature, where a 200 ms gate best predicted perceived
	 * fluency). Cutting below that removes nothing anyone can hear and buys
	 * only clipped consonants, which is why `hangoverSec` independently makes
	 * 200 ms the shortest gap the gate can even resolve.
	 *
	 * Short-form is the reason the default sits ON that floor rather than
	 * comfortably above it. Editorial practice for TikTok/Reels wants a cut
	 * every 1.5-3 s and treats a half-second of dead air as enough to break
	 * the scroll -- so on this surface the perceptual floor and the useful
	 * setting are the same number.
	 */
	minSilenceSec: number;
	/** Room tone kept before a kept region's first sound. */
	padInSec: number;
	/**
	 * Room tone kept after a kept region's last sound. Deliberately LONGER
	 * than `padInSec`: speech decays into breath and a hard truncation on a
	 * word's tail reads as a dropout, while a late entry reads as a normal
	 * edit. Same asymmetry a person uses cutting by hand.
	 */
	padOutSec: number;
	/** Kept regions shorter than this are dropped rather than emitted. */
	minKeepSec: number;
	/**
	 * Air left inside each REMOVED gap. 0 closes gaps completely (what "cut
	 * all dead space" asks for); raise it to "tighten" instead of "remove".
	 */
	keepGapSec: number;
	/** How far above the measured noise floor the gate sits. */
	thresholdMarginDb: number;
	/** Schmitt-trigger half-width: open at +this, close at -this. */
	hysteresisDb: number;
	/** How long the gate stays open after the level drops (unvoiced tails). */
	hangoverSec: number;
	/** Below this floor-to-speech spread, refuse rather than guess. */
	minDynamicRangeDb: number;
	/**
	 * The gate never sits further than this below the loud material.
	 *
	 * Phone and screen recordings run noise suppression, so their pauses are
	 * pushed to near-digital-silence and the measured floor comes back around
	 * -90 dBFS. Threshold-from-floor then lands near -80, where every trace
	 * of breath counts as "significant audio" and no gap is ever cut (found
	 * live on three real recordings, 2026-08-25). Dead space is relative to
	 * how loud the content is: 45 dB under the voice is silence by any
	 * standard, and nothing a listener would miss lives below it.
	 */
	maxRangeBelowSpeechDb: number;
	/** Refuse when the plan would keep less than this fraction of the clip. */
	minKeptFraction: number;
	/** Refuse when the plan would emit more pieces than this. */
	maxSegments: number;
	/**
	 * Voicing confidence (0..1) at or above which a frame counts as speech.
	 *
	 * Unlike every dB threshold in this file this one is NOT adaptive, and
	 * does not need to be: normalized autocorrelation is already scale-free,
	 * so 0.45 means the same thing on a whisper and a shout. Voiced speech
	 * sits well above it, aperiodic noise well below.
	 */
	voicingThreshold: number;
	/**
	 * If fewer than this fraction of the loud frames are voiced, voicing is
	 * not describing this recording and gating on it is turned OFF for the
	 * clip (falling back to band-limited energy alone).
	 *
	 * The escape hatch matters more than the feature: whispered speech, heavy
	 * pitch processing, a sung or vocoded track, or a language sample this
	 * simple autocorrelation just handles badly would otherwise score voiced
	 * almost nowhere, every frame would read as non-speech, and the button
	 * would propose deleting the entire clip. Degrading to the older, dumber
	 * behaviour is a far better failure than confidently cutting everything.
	 */
	minVoicedFraction: number;
	/** Fricative rescue fires while ZCR exceeds the quiet-frame ZCR by this. */
	zcrRescueRatio: number;
	/** Hard cap on how far the fricative rescue may extend one boundary. */
	zcrRescueMaxSec: number;
}

export const DEFAULT_DEAD_SPACE_OPTIONS: DeadSpaceOptions = {
	minSilenceSec: 0.2,
	padInSec: 0.03,
	padOutSec: 0.09,
	minKeepSec: 0.12,
	keepGapSec: 0,
	thresholdMarginDb: 8,
	hysteresisDb: 3,
	hangoverSec: 0.2,
	minDynamicRangeDb: 8,
	maxRangeBelowSpeechDb: 45,
	minKeptFraction: 0.1,
	maxSegments: 200,
	voicingThreshold: 0.45,
	minVoicedFraction: 0.15,
	zcrRescueRatio: 1.6,
	zcrRescueMaxSec: 0.12,
};

export interface TimeSpanSec {
	startSec: number;
	endSec: number;
}

/**
 * Why a clip was left untouched. Every one of these is a REFUSAL, not an
 * error: the button did its job by declining, and the UI says so instead of
 * silently shredding footage.
 */
export type DeadSpaceRefusal =
	/** No decodable audio, or the whole window is digital silence. */
	| "no-audio"
	/** Floor and speech are too close — constant music, noise, or a room
	 *  loud enough that nothing here is a "quiet part". */
	| "no-dynamic-range"
	/** Real speech, real silence, but no gap long enough to be worth a cut. */
	| "nothing-to-cut"
	/** The plan kept almost nothing — a misdetection, not an edit. */
	| "would-remove-everything"
	/** More pieces than any human would make; the gate was chattering. */
	| "too-fragmented";

export interface DeadSpaceAnalysis {
	/** Kept regions in SOURCE seconds, ascending, non-overlapping. */
	segments: TimeSpanSec[];
	noiseFloorDb: number;
	speechDb: number;
	thresholdDb: number;
	openDb: number;
	closeDb: number;
	windowSec: number;
	keptSec: number;
	removedSec: number;
	/** Non-null means nothing should be changed. `segments` is then empty. */
	refusal: DeadSpaceRefusal | null;
}

function percentile({
	sorted,
	fraction,
}: {
	sorted: Float32Array | number[];
	fraction: number;
}): number {
	const n = sorted.length;
	if (n === 0) return Number.NaN;
	const index = Math.min(n - 1, Math.max(0, Math.round(fraction * (n - 1))));
	return sorted[index];
}

function refuse({
	reason,
	windowSec,
	noiseFloorDb,
	speechDb,
	thresholdDb,
	openDb,
	closeDb,
}: {
	reason: DeadSpaceRefusal;
	windowSec: number;
	noiseFloorDb: number;
	speechDb: number;
	thresholdDb: number;
	openDb: number;
	closeDb: number;
}): DeadSpaceAnalysis {
	return {
		segments: [],
		noiseFloorDb,
		speechDb,
		thresholdDb,
		openDb,
		closeDb,
		windowSec,
		keptSec: 0,
		removedSec: 0,
		refusal: reason,
	};
}

/**
 * Runs the gate over `features`, restricted to `window` (a trimmed clip
 * measures its OWN visible window — a noise floor taken from material the
 * clip doesn't show would set the threshold for footage nobody sees).
 *
 * Returned spans are in absolute SOURCE seconds, the same coordinate space
 * as `TimelineElement.trimStart`.
 */
export function detectDeadSpace({
	features,
	window,
	options = DEFAULT_DEAD_SPACE_OPTIONS,
}: {
	features: FrameFeatures;
	window?: TimeSpanSec;
	options?: DeadSpaceOptions;
}): DeadSpaceAnalysis {
	const { rmsDb, bandRmsDb, voicing, zcr, hopSec, frameSec } = features;
	const sourceSec = features.sampleCount / features.sampleRate;
	const windowStart = Math.max(0, window?.startSec ?? 0);
	const windowEnd = Math.min(sourceSec, window?.endSec ?? sourceSec);
	const windowSec = Math.max(0, windowEnd - windowStart);
	const empty = {
		windowSec,
		noiseFloorDb: SILENCE_DB_FLOOR,
		speechDb: SILENCE_DB_FLOOR,
		thresholdDb: SILENCE_DB_FLOOR,
		openDb: SILENCE_DB_FLOOR,
		closeDb: SILENCE_DB_FLOOR,
	};
	if (rmsDb.length === 0 || windowSec <= 0) {
		return refuse({ reason: "no-audio", ...empty });
	}

	const firstFrame = Math.max(0, Math.floor(windowStart / hopSec));
	const lastFrame = Math.min(
		rmsDb.length - 1,
		Math.ceil((windowEnd - frameSec) / hopSec),
	);
	if (lastFrame < firstFrame) {
		return refuse({ reason: "no-audio", ...empty });
	}

	// Everything from here measures the SPEECH BAND, not the full spectrum:
	// the floor, the speech level, the threshold and the gate. A pause with a
	// fan or a passing car in it is quiet in this band even though it is not
	// quiet in the file, which is the only reason it can ever be recognised
	// as a gap. `rmsDb` stays in FrameFeatures for callers that want the real
	// wideband level, but nothing in the decision below reads it.
	const levels = bandRmsDb.slice(firstFrame, lastFrame + 1);
	const sorted = Float32Array.from(levels).sort();
	const speechDb = percentile({ sorted, fraction: 0.95 });
	// The floor is measured over PRESENT signal only — see ABSENT_SIGNAL_DB.
	const present = Float32Array.from(levels.filter((db) => db > ABSENT_SIGNAL_DB)).sort();
	const noiseFloorDb =
		present.length === 0
			? SILENCE_DB_FLOOR
			: Math.min(
					percentile({ sorted: present, fraction: 0.1 }),
					quietestWindowDb({
						rmsDb: bandRmsDb,
						firstFrame,
						lastFrame,
						windowFrames: Math.max(1, Math.round(0.1 / hopSec)),
					}),
				);

	if (speechDb <= SILENCE_DB_FLOOR + 1) {
		return refuse({ reason: "no-audio", ...empty, noiseFloorDb, speechDb });
	}
	if (speechDb - noiseFloorDb < options.minDynamicRangeDb) {
		return refuse({
			reason: "no-dynamic-range",
			...empty,
			noiseFloorDb,
			speechDb,
		});
	}

	// The gate sits a margin above the measured floor — but bounded from BOTH
	// sides against the loud material. Never within 6 dB of it (a compressed
	// recording keeps more rather than losing quiet speech), and never more
	// than `maxRangeBelowSpeechDb` under it (a noise-suppressed recording
	// gets a gate that can actually fire).
	const thresholdDb = Math.min(
		Math.max(
			noiseFloorDb + options.thresholdMarginDb,
			speechDb - options.maxRangeBelowSpeechDb,
		),
		speechDb - 6,
	);
	const openDb = thresholdDb + options.hysteresisDb;
	const closeDb = thresholdDb - options.hysteresisDb;

	const smoothedVoiced = medianFilterVoicing({
		voicing,
		firstFrame,
		lastFrame,
		threshold: options.voicingThreshold,
		width: VOICING_MEDIAN_FRAMES,
	});

	// Is voicing actually describing this recording? Measured over the frames
	// loud enough to be content: if hardly any of them are voiced, the
	// autocorrelation is not finding speech here (whisper, heavy processing,
	// song) and gating on it would propose deleting the clip. Fall back to
	// band-limited energy rather than confidently cutting everything.
	let loudFrames = 0;
	let voicedLoudFrames = 0;
	for (let i = firstFrame; i <= lastFrame; i++) {
		if (bandRmsDb[i] < openDb) continue;
		loudFrames++;
		if (smoothedVoiced[i] === 1) voicedLoudFrames++;
	}
	const voicedFraction = loudFrames === 0 ? 0 : voicedLoudFrames / loudFrames;
	const useVoicing =
		loudFrames > 0 && voicedFraction >= options.minVoicedFraction;

	const voiced: Uint8Array | null = useVoicing ? smoothedVoiced : null;

	const raw = runGate({
		rmsDb: bandRmsDb,
		voiced,
		firstFrame,
		lastFrame,
		openDb,
		closeDb,
		hangoverFrames: Math.max(0, Math.round(options.hangoverSec / hopSec)),
	});

	const rescued = rescueFricatives({
		spans: raw,
		zcr,
		// Band levels, because `thresholdDb` is a band threshold — comparing a
		// wideband level against it would rescue on room noise.
		rmsDb: bandRmsDb,
		firstFrame,
		lastFrame,
		thresholdDb,
		ratio: options.zcrRescueRatio,
		maxFrames: Math.max(0, Math.round(options.zcrRescueMaxSec / hopSec)),
	});

	const segments = applyEditorialRules({
		spans: rescued.map(({ startFrame, endFrame }) => ({
			startSec: startFrame * hopSec,
			// A frame covers [i*hop, i*hop + frameSec): the last frame's
			// content runs to its END, not to its start.
			endSec: endFrame * hopSec + frameSec,
		})),
		windowStart,
		windowEnd,
		options,
	});

	if (segments.length === 0) {
		return refuse({
			reason: "would-remove-everything",
			...empty,
			noiseFloorDb,
			speechDb,
			thresholdDb,
			openDb,
			closeDb,
		});
	}
	if (segments.length > options.maxSegments) {
		return refuse({
			reason: "too-fragmented",
			...empty,
			noiseFloorDb,
			speechDb,
			thresholdDb,
			openDb,
			closeDb,
		});
	}

	const keptSec = segments.reduce(
		(sum, span) => sum + (span.endSec - span.startSec),
		0,
	);
	const removedSec = Math.max(0, windowSec - keptSec);

	if (keptSec / windowSec < options.minKeptFraction) {
		return refuse({
			reason: "would-remove-everything",
			...empty,
			noiseFloorDb,
			speechDb,
			thresholdDb,
			openDb,
			closeDb,
		});
	}
	// One piece that spans the whole window is not an edit — the clip is
	// already tight. Say so rather than replacing it with a copy of itself.
	//
	// The bar is what ONE cuttable pause nets after padding, not
	// `minSilenceSec` itself (which this compared against until 2026-08-27).
	// Those are different quantities: a clip whose only dead air is a single
	// gap right at the threshold removes `minSilenceSec - padIn - padOut`,
	// which is by construction less than `minSilenceSec` — so the guard
	// rejected the very edit the threshold had just approved, and re-imposed
	// the padding-inflated floor that the merge rule no longer had.
	if (removedSec < cuttableGapSec(options)) {
		return refuse({
			reason: "nothing-to-cut",
			...empty,
			noiseFloorDb,
			speechDb,
			thresholdDb,
			openDb,
			closeDb,
		});
	}

	return {
		segments,
		noiseFloorDb,
		speechDb,
		thresholdDb,
		openDb,
		closeDb,
		windowSec,
		keptSec,
		removedSec,
		refusal: null,
	};
}

/**
 * Noise floor as the quietest sustained stretch, not just a low percentile.
 *
 * A percentile alone assumes the clip HAS a decent fraction of silence in
 * it: on a take that is 95 % talking with one short pause, the 10th
 * percentile lands inside the speech, the measured "floor" comes out only a
 * few dB under the voice, and the whole clip gets written off as having no
 * dynamic range — the exact case that made this function necessary. Taking
 * the minimum mean over a sliding ~100 ms window (the min-statistics idea
 * from speech enhancement) finds the room tone however little of it there
 * is, while still being long enough that one dropped frame can't define it.
 *
 * The caller takes the LOWER of this and the percentile, because a lower
 * floor means a lower gate, which means keeping more.
 */
function quietestWindowDb({
	rmsDb,
	firstFrame,
	lastFrame,
	windowFrames,
}: {
	rmsDb: Float32Array;
	firstFrame: number;
	lastFrame: number;
	windowFrames: number;
}): number {
	const available = lastFrame - firstFrame + 1;
	if (available <= 0) return Number.POSITIVE_INFINITY;
	const width = Math.min(windowFrames, available);
	let sum = 0;
	for (let i = firstFrame; i < firstFrame + width; i++) sum += rmsDb[i];
	let quietest = Number.POSITIVE_INFINITY;
	const consider = ({ mean }: { mean: number }): void => {
		// Windows sitting in absent signal describe nothing about the room.
		if (mean > ABSENT_SIGNAL_DB && mean < quietest) quietest = mean;
	};
	consider({ mean: sum / width });
	for (let i = firstFrame + width; i <= lastFrame; i++) {
		sum += rmsDb[i] - rmsDb[i - width];
		consider({ mean: sum / width });
	}
	return quietest;
}

interface FrameSpan {
	startFrame: number;
	endFrame: number;
}

/**
 * The Schmitt-triggered gate with a release tail.
 *
 * Open needs one frame at or above `openDb` AND, when voicing is being used,
 * evidence that the frame is actually voice. Close needs `hangoverFrames`
 * CONSECUTIVE frames that are either below `closeDb` or not speech — and the
 * span then ends where the quiet started, not where the hangover expired, so
 * the tail is a detection delay rather than extra material. Anything between
 * the two thresholds holds the current state, which is what stops the
 * boundary chatter that turns a single sentence into fourteen clips.
 *
 * Sustained non-speech — a fan, traffic, a room, a hand on the phone — never
 * opens this gate however loud it is, which is the whole difference between
 * it and a noise gate.
 *
 * Unvoiced speech is NOT handled here, and deliberately so. The obvious fix
 * for clipped word endings is to let high-ZCR frames hold an open gate, on
 * the theory that they can only extend a region voiced speech already
 * started. That is wrong by exactly one property: broadband noise has a
 * fricative's zero-crossing rate, so against a bottom-heavy room tone a full
 * second of hiss in a pause reads as one very long /s/ and holds the gate
 * open for all of it — reintroducing the bug this whole layer exists to fix.
 * The fricative extension belongs in `rescueFricatives`, AFTER the gate,
 * where `zcrRescueMaxSec` caps it at the length a fricative can actually be.
 */
function runGate({
	rmsDb,
	voiced,
	firstFrame,
	lastFrame,
	openDb,
	closeDb,
	hangoverFrames,
}: {
	rmsDb: Float32Array;
	/** Frames that may OPEN the gate: voiced. Null gates on level alone. */
	voiced: Uint8Array | null;

	firstFrame: number;
	lastFrame: number;
	openDb: number;
	closeDb: number;
	hangoverFrames: number;
}): FrameSpan[] {
	const spans: FrameSpan[] = [];
	let open = false;
	let startFrame = 0;
	let quietSince = -1;

	for (let i = firstFrame; i <= lastFrame; i++) {
		const level = rmsDb[i];
		const isSpeech = voiced === null || voiced[i] === 1;
		if (!open) {
			if (level >= openDb && isSpeech) {
				open = true;
				startFrame = i;
				quietSince = -1;
			}
			continue;
		}
		if (level < closeDb || !isSpeech) {
			if (quietSince < 0) quietSince = i;
			if (i - quietSince >= hangoverFrames) {
				spans.push({ startFrame, endFrame: Math.max(startFrame, quietSince - 1) });
				open = false;
				quietSince = -1;
			}
		} else if (level >= openDb) {
			quietSince = -1;
		}
	}
	if (open) {
		spans.push({ startFrame, endFrame: lastFrame });
	}
	return spans;
}

/**
 * Walks each boundary outward while the signal still looks like broadband
 * noise rather than room tone.
 *
 * `/s/`, `/f/`, `/sh/` and stop bursts run 15-25 dB under the vowels beside
 * them, so the energy gate closes on top of them and you lose the end of
 * "yes" and the start of "stop". They are, however, the highest-ZCR content
 * in speech, and room tone is not — so extending a boundary while ZCR stays
 * well above the quiet-frame median recovers them without opening the gate
 * on silence. Capped by `maxFrames` so a hissy recording can't extend a
 * boundary indefinitely, and only ever applied ADJACENT to a region the
 * energy gate already accepted.
 */
/**
 * Turns the per-frame voicing confidence into a per-frame voiced/unvoiced
 * DECISION, median-filtered over `width` frames so that a decision has to be
 * supported by its neighbours. See `VOICING_MEDIAN_FRAMES`.
 */
function medianFilterVoicing({
	voicing,
	firstFrame,
	lastFrame,
	threshold,
	width,
}: {
	voicing: Float32Array;
	firstFrame: number;
	lastFrame: number;
	threshold: number;
	width: number;
}): Uint8Array {
	const raw = new Uint8Array(voicing.length);
	for (let i = firstFrame; i <= lastFrame; i++) {
		raw[i] = voicing[i] >= threshold ? 1 : 0;
	}
	const half = Math.max(0, Math.floor(width / 2));
	if (half === 0) return raw;
	const out = new Uint8Array(voicing.length);
	for (let i = firstFrame; i <= lastFrame; i++) {
		let votes = 0;
		let counted = 0;
		for (let k = i - half; k <= i + half; k++) {
			if (k < firstFrame || k > lastFrame) continue;
			counted++;
			votes += raw[k];
		}
		out[i] = votes * 2 > counted ? 1 : 0;
	}
	return out;
}

/**
 * The zero-crossing rate above which a frame looks like broadband
 * high-frequency energy — a fricative or a stop burst — rather than room
 * tone.
 *
 * Measured from the quiet frames of THIS recording, because the noise
 * character differs wildly between a treated room and a phone in a cafe.
 * Returns null when the recording has no quiet frames to measure from.
 *
 * Shared by the gate's hold rule and by `rescueFricatives` so that the two
 * cannot disagree about what a fricative is — they are the same judgement
 * made at two different moments.
 */
function quietZcrGate({
	zcr,
	rmsDb,
	firstFrame,
	lastFrame,
	thresholdDb,
	ratio,
}: {
	zcr: Float32Array;
	rmsDb: Float32Array;
	firstFrame: number;
	lastFrame: number;
	thresholdDb: number;
	ratio: number;
}): number | null {
	const quiet: number[] = [];
	for (let i = firstFrame; i <= lastFrame; i++) {
		if (rmsDb[i] < thresholdDb) quiet.push(zcr[i]);
	}
	if (quiet.length === 0) return null;
	quiet.sort((a, b) => a - b);
	const quietZcr = percentile({ sorted: quiet, fraction: 0.5 });
	// A dead-quiet floor gives a ~0 median, which would make ANY frame
	// "1.6x the floor". Require a real, absolute amount of high-frequency
	// activity too before extending.
	return Math.max(quietZcr * ratio, 0.05);
}

function rescueFricatives({
	spans,
	zcr,
	rmsDb,
	firstFrame,
	lastFrame,
	thresholdDb,
	ratio,
	maxFrames,
}: {
	spans: FrameSpan[];
	zcr: Float32Array;
	rmsDb: Float32Array;
	firstFrame: number;
	lastFrame: number;
	thresholdDb: number;
	ratio: number;
	maxFrames: number;
}): FrameSpan[] {
	if (spans.length === 0 || maxFrames === 0) return spans;

	const zcrGate = quietZcrGate({
		zcr,
		rmsDb,
		firstFrame,
		lastFrame,
		thresholdDb,
		ratio,
	});
	if (zcrGate === null) return spans;

	return spans.map(({ startFrame, endFrame }) => {
		let start = startFrame;
		for (let n = 0; n < maxFrames && start - 1 >= firstFrame; n++) {
			if (zcr[start - 1] <= zcrGate) break;
			start--;
		}
		let end = endFrame;
		for (let n = 0; n < maxFrames && end + 1 <= lastFrame; n++) {
			if (zcr[end + 1] <= zcrGate) break;
			end++;
		}
		return { startFrame: start, endFrame: end };
	});
}

/**
 * The human layer. Takes detected sound regions and turns them into the
 * cuts an editor would actually make.
 *
 * Order matters: pad FIRST, then merge. Merging on the padded spans is what
 * makes "don't cut short pauses" and "don't leave overlapping pieces" the
 * same rule — after padding, two regions separated by less than a cuttable
 * gap simply become one region.
 *
 * What that order does NOT license is comparing the padded gap directly
 * against `minSilenceSec`, which is a RAW silence duration. See the merge
 * threshold below.
 */
/**
 * The smallest gap that can survive padding, i.e. what a cuttable pause is
 * worth in removed seconds.
 *
 * `minSilenceSec` is specified in RAW silence, but padding gives `padInSec +
 * padOutSec` of it back, so a raw gap at exactly the threshold nets only this
 * much. Both the merge rule and the "nothing to cut" guard have to reason in
 * the same units or they disagree about what counts as an edit — and the one
 * with the higher effective floor silently wins.
 *
 * Clamped above zero so that padding wider than `minSilenceSec` still merges
 * overlapping spans instead of emitting pieces that overlap.
 */
export function cuttableGapSec(options: DeadSpaceOptions): number {
	return Math.max(
		1e-6,
		options.minSilenceSec - options.padInSec - options.padOutSec,
	);
}

export function applyEditorialRules({
	spans,
	windowStart,
	windowEnd,
	options,
}: {
	spans: TimeSpanSec[];
	windowStart: number;
	windowEnd: number;
	options: DeadSpaceOptions;
}): TimeSpanSec[] {
	const padded = spans
		.map(({ startSec, endSec }) => ({
			startSec: Math.max(windowStart, startSec - options.padInSec),
			endSec: Math.min(windowEnd, endSec + options.padOutSec),
		}))
		.filter((span) => span.endSec > span.startSec)
		.sort((a, b) => a.startSec - b.startSec);

	// Padding has already been added by this point, so a raw gap of G shows up
	// here as G - padIn - padOut. `minSilenceSec` is specified in RAW silence
	// (what a listener actually hears), so the padding has to come back out of
	// the comparison before it means anything.
	//
	// Comparing the PADDED gap against `minSilenceSec` — what this did until
	// 2026-08-27 — silently made the real floor minSilenceSec + padIn +
	// padOut. At the shipped defaults that was 0.35 + 0.08 + 0.18 = 0.61 s,
	// measured at 0.70 s once frame quantization and the gate's hangover delay
	// were counted. Every pause under two thirds of a second came back
	// "nothing to cut", which on short-form footage is essentially all of
	// them: the feature refused the exact edits it exists to make.
	//
	// Clamped above zero so overlapping spans (a negative gap) always merge —
	// otherwise a padIn + padOut wider than minSilenceSec would emit pieces
	// that overlap each other.
	const mergeGapSec = cuttableGapSec(options);
	const merged: TimeSpanSec[] = [];
	for (const span of padded) {
		const last = merged[merged.length - 1];
		if (last && span.startSec - last.endSec < mergeGapSec) {
			last.endSec = Math.max(last.endSec, span.endSec);
			continue;
		}
		merged.push({ ...span });
	}

	// "Tighten" mode: hand back part of each removed gap instead of all of
	// it. Inert at the default 0.
	if (options.keepGapSec > 0 && merged.length > 1) {
		const half = options.keepGapSec / 2;
		for (let i = 0; i < merged.length - 1; i++) {
			const gap = merged[i + 1].startSec - merged[i].endSec;
			const give = Math.min(half, Math.max(0, gap / 2 - 0.001));
			merged[i].endSec += give;
			merged[i + 1].startSec -= give;
		}
	}

	return merged.filter(
		(span) => span.endSec - span.startSec >= options.minKeepSec,
	);
}
