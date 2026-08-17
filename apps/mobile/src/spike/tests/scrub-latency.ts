/**
 * Test 2 (plan M1 item 2): scrub latency (seek → composited frame on screen)
 * against a natively-generated short-GOP proxy AND a long-GOP "full-res"
 * clip, so the proxy's value is measured, not assumed (plan Amendment 4).
 *
 * "Composited frame on screen" is simplified here to "decoded + drawn to a
 * visible <canvas>" via mediabunny's `CanvasSink.getCanvas(timestamp)` —
 * the real product's scrub path additionally round-trips through the wasm
 * compositor (Test 1's subject), but mediabunny's decode-to-seek latency is
 * the dominant, proxy-sensitive term the plan's Amendment 4 argument is
 * about (long-GOP random-access decode cost) and isolating it here keeps
 * this test's failure mode legible on its own.
 *
 * The two source files are bundled at `apps/mobile/spike-assets/` (see
 * `scripts/generate-spike-assets.sh` — committed as small generated MP4s,
 * not regenerated at build time, so the harness has zero build-time ffmpeg
 * dependency). `proxy.mp4`: 540p, `-g 1` (near-all-intra / short-GOP).
 * `full.mp4`: 1080p, `-g 250` (long-GOP, typical H.264 default-ish
 * structure) — see that script for the exact ffmpeg invocation.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import type { ScrubLatencyResult, ScrubLatencySample } from "../types";

const SCATTERED_TIMESTAMPS_SEC = [0.5, 2.5, 5.0, 7.5, 9.5];

async function measureOne(url: string): Promise<{
	samples: ScrubLatencySample[];
	p50Ms: number | null;
	maxMs: number | null;
}> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
	}
	const blob = await response.blob();
	const file = new File([blob], url.split("/").pop() ?? "clip.mp4", {
		type: "video/mp4",
	});

	const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
	try {
		const videoTrack = await input.getPrimaryVideoTrack();
		if (!videoTrack) throw new Error(`${url}: no video track`);

		const sink = new CanvasSink(videoTrack, { poolSize: 3, fit: "contain" });

		const samples: ScrubLatencySample[] = [];
		for (const timestampSec of SCATTERED_TIMESTAMPS_SEC) {
			const start = performance.now();
			const wrapped = await sink.getCanvas(timestampSec);
			const latencyMs = performance.now() - start;
			if (!wrapped) {
				throw new Error(`${url}: no frame at t=${timestampSec}s (clip shorter than expected?)`);
			}
			samples.push({ timestampSec, latencyMs });
		}

		const sorted = [...samples.map((s) => s.latencyMs)].sort((a, b) => a - b);
		return {
			samples,
			p50Ms: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : null,
			maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : null,
		};
	} finally {
		input.dispose();
	}
}

export async function runScrubLatency(): Promise<ScrubLatencyResult> {
	let proxy: ScrubLatencyResult["proxy"] = null;
	let full: ScrubLatencyResult["full"] = null;
	let error: string | null = null;

	try {
		proxy = await measureOne("./spike-assets/proxy.mp4");
	} catch (err) {
		error = `proxy.mp4: ${err instanceof Error ? err.message : "unknown error"}`;
	}

	try {
		full = await measureOne("./spike-assets/full.mp4");
	} catch (err) {
		const fullError = `full.mp4: ${err instanceof Error ? err.message : "unknown error"}`;
		error = error ? `${error}; ${fullError}` : fullError;
	}

	return { testId: "scrub-latency", proxy, full, error };
}
