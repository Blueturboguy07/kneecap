import type { EdlRational } from "./types";

/**
 * Rational arithmetic for the EDL bridge.
 *
 * Everything crossing to native is integer ticks + rational rates (plan §2.3
 * rule 1). The engine's retime model, however, stores `RetimeConfig.rate` as a
 * plain float (`retime/rate.ts`, clamped to [0.01, 5]). This module is the one
 * place that conversion happens, and it happens exactly once, in `buildEdl`.
 */

/** Largest denominator we will produce. Keeps CMTime/Media3 arithmetic sane. */
export const MAX_RATIONAL_DENOMINATOR = 100_000;

function gcd({ a, b }: { a: number; b: number }): number {
	let x = Math.abs(a);
	let y = Math.abs(b);
	while (y !== 0) {
		const t = y;
		y = x % y;
		x = t;
	}
	return x;
}

export function reduceRational({
	numerator,
	denominator,
}: EdlRational): EdlRational {
	if (denominator === 0) {
		throw new Error("reduceRational: denominator must not be zero");
	}
	const sign = denominator < 0 ? -1 : 1;
	const n = numerator * sign;
	const d = denominator * sign;
	const divisor = gcd({ a: n, b: d }) || 1;
	return { numerator: n / divisor, denominator: d / divisor };
}

export function rationalToNumber({
	numerator,
	denominator,
}: EdlRational): number {
	return numerator / denominator;
}

/**
 * Best rational approximation of a positive float, via the continued-fraction
 * (Stern-Brocot) expansion, bounded by `maxDenominator`.
 *
 * Exact for every speed preset the UI can produce (0.25, 0.5, 1, 1.5, 2, 3, 5)
 * and for the common frame rates (23.976 → 24000/1001, 29.97 → 30000/1001).
 * For a value dragged to something irrational-ish it lands within
 * 1/maxDenominator², which at 100 000 is far below one tick at 120 000 tps.
 */
export function rationalFromNumber({
	value,
	maxDenominator = MAX_RATIONAL_DENOMINATOR,
}: {
	value: number;
	maxDenominator?: number;
}): EdlRational {
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(
			`rationalFromNumber: expected a finite positive value, got ${value}`,
		);
	}
	if (Number.isInteger(value)) {
		return { numerator: value, denominator: 1 };
	}

	// Continued fraction expansion with the classic h/k recurrence.
	let h1 = 1;
	let h0 = 0;
	let k1 = 0;
	let k0 = 1;
	let x = value;

	for (let i = 0; i < 64; i++) {
		const a = Math.floor(x);
		const h2 = a * h1 + h0;
		const k2 = a * k1 + k0;
		if (k2 > maxDenominator) break;
		h0 = h1;
		h1 = h2;
		k0 = k1;
		k1 = k2;
		const frac = x - a;
		if (frac === 0) break;
		x = 1 / frac;
	}

	if (k1 <= 0) {
		return { numerator: Math.round(value * maxDenominator), denominator: maxDenominator };
	}
	return reduceRational({ numerator: h1, denominator: k1 });
}

/**
 * `ticks × rational`, rounded half away from zero to an integer tick count.
 *
 * The rounding rule matches `roundMediaTime` in `wasm/media-time.ts` (and Rust's
 * `.round()`), so a value computed here and a value computed by the engine land
 * on the same tick rather than differing by one.
 */
export function scaleTicks({
	ticks,
	rate,
}: {
	ticks: number;
	rate: EdlRational;
}): number {
	const exact = (ticks * rate.numerator) / rate.denominator;
	const magnitude = Math.round(Math.abs(exact));
	if (magnitude === 0) return 0;
	return exact < 0 ? -magnitude : magnitude;
}
