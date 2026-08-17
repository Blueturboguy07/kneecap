import { useEffect, useRef } from "react";

const BAR_WIDTH = 2;
const BAR_GAP = 1;
const BAR_STEP = BAR_WIDTH + BAR_GAP;

/**
 * Amplitude waveform for an audio clip — corpus 05 §8 resolves the
 * "flat line vs. real amplitude shape" ambiguity in the source material
 * toward "there is a rendered waveform of some kind" (Medium-High) and
 * flags the exact shape as [NEEDS HANDS-ON VERIFICATION]; this renders a
 * real up/down amplitude shape (the standard mobile-editor convention,
 * and what every non-hedged source implies), not a flat line.
 *
 * `peaks` is a plain 0..1 amplitude array (the full clip's peaks, already
 * resolved) — this package has no real waveform-cache wiring
 * (packages/editor-core/src/services/waveform-cache exists and
 * apps/web/src/timeline/components/audio-waveform.tsx already consumes it
 * for the desktop timeline; a live integration would resample that same
 * cache into this prop rather than duplicating its async-decode logic
 * here, which is out of scope for this package per its no-apps/web-import
 * rule). The dev harness feeds this synthetic peaks from
 * timeline/mock-data.ts.
 */
export function AudioWaveformMini({
	peaks,
	widthPx,
	heightPx,
}: {
	peaks: number[];
	widthPx: number;
	heightPx: number;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || widthPx <= 0 || heightPx <= 0) return;
		const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
		canvas.width = Math.max(1, Math.round(widthPx * dpr));
		canvas.height = Math.max(1, Math.round(heightPx * dpr));
		const ctx = canvas.getContext("2d");
		if (!ctx || peaks.length === 0) return;

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, widthPx, heightPx);
		// A dimmed accent tone (canvas can't read CSS custom properties
		// directly) — visually a lighter, desaturated cyan, distinct enough
		// from --cc-accent's own full-saturation use elsewhere on the clip.
		ctx.fillStyle = "#7fd8e2";

		const barCount = Math.max(1, Math.floor(widthPx / BAR_STEP));
		const mid = heightPx / 2;
		for (let i = 0; i < barCount; i++) {
			const progress = i / barCount;
			const rawIndex = progress * (peaks.length - 1);
			const lo = Math.floor(rawIndex);
			const hi = Math.min(peaks.length - 1, lo + 1);
			const amplitude = peaks[lo] + (peaks[hi] - peaks[lo]) * (rawIndex - lo);
			const barHeight = Math.max(1, amplitude * heightPx * 0.9);
			ctx.fillRect(i * BAR_STEP, mid - barHeight / 2, BAR_WIDTH, barHeight);
		}
	}, [peaks, widthPx, heightPx]);

	return (
		<canvas
			ref={canvasRef}
			className="cc-timeline__waveform"
			style={{ width: widthPx, height: heightPx }}
			aria-hidden="true"
		/>
	);
}
