/**
 * M8 Audio panel — plan M8 item 3 "Audio": "The Freesound proxy
 * (`app/api/sounds/search`) is cut — it is a network dependency and
 * violates local-first. Ship a small bundled local sound set instead."
 *
 * This is that bundled set. Each entry is a short procedurally-synthesized
 * sine-wave tone, encoded as a 16-bit PCM WAV and embedded as a `data:`
 * URI at module load — genuinely zero network, works fully offline, and
 * needs no binary asset files checked into the repo. This is NOT a clone of
 * any CapCut sound (CapCut's actual bundled library is not reproducible
 * from public research) — it is placeholder-quality local content that
 * proves the real mechanism: `AudioElement` with `sourceType: "library"`
 * and a `sourceUrl` that resolves without ever touching the network.
 *
 * Swapping these for real CC0/OFL sound files later (per plan §8.4's
 * "small CC0/OFL starter pack") is a content task, not an architecture
 * change — `LocalSound.sourceUrl` can point at a bundled static asset path
 * exactly as easily as a data URI.
 */

const SAMPLE_RATE = 8000;
const BASE64_CHARS =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64({ bytes }: { bytes: Uint8Array }): string {
	let result = "";
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i];
		const b1 = bytes[i + 1];
		const b2 = bytes[i + 2];
		const hasB1 = i + 1 < bytes.length;
		const hasB2 = i + 2 < bytes.length;

		result += BASE64_CHARS[b0 >> 2];
		result += BASE64_CHARS[((b0 & 0x03) << 4) | (hasB1 ? b1 >> 4 : 0)];
		result += hasB1 ? BASE64_CHARS[((b1 & 0x0f) << 2) | (hasB2 ? b2 >> 6 : 0)] : "=";
		result += hasB2 ? BASE64_CHARS[b2 & 0x3f] : "=";
	}
	return result;
}

function writeString({ view, offset, text }: { view: DataView; offset: number; text: string }): void {
	for (let i = 0; i < text.length; i++) {
		view.setUint8(offset + i, text.charCodeAt(i));
	}
}

/**
 * Synthesizes a mono 16-bit PCM WAV: a sine tone with a linear
 * fade-in/fade-out envelope (avoids a click at the clip boundaries) at the
 * given frequency and duration, returned as a `data:audio/wav;base64,...`
 * URI. Deterministic — same inputs always produce the same bytes.
 */
export function synthesizeToneWavDataUri({
	frequencyHz,
	durationSeconds,
}: {
	frequencyHz: number;
	durationSeconds: number;
}): string {
	const sampleCount = Math.round(SAMPLE_RATE * durationSeconds);
	const dataSize = sampleCount * 2; // 16-bit mono
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);

	writeString({ view, offset: 0, text: "RIFF" });
	view.setUint32(4, 36 + dataSize, true);
	writeString({ view, offset: 8, text: "WAVE" });
	writeString({ view, offset: 12, text: "fmt " });
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, SAMPLE_RATE, true);
	view.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	writeString({ view, offset: 36, text: "data" });
	view.setUint32(40, dataSize, true);

	const fadeSamples = Math.min(sampleCount / 4, SAMPLE_RATE * 0.05);
	for (let i = 0; i < sampleCount; i++) {
		const t = i / SAMPLE_RATE;
		let envelope = 1;
		if (i < fadeSamples) envelope = i / fadeSamples;
		else if (i > sampleCount - fadeSamples) envelope = (sampleCount - i) / fadeSamples;
		const sample = Math.sin(2 * Math.PI * frequencyHz * t) * envelope * 0.6;
		const clamped = Math.max(-1, Math.min(1, sample));
		view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
	}

	const base64 = bytesToBase64({ bytes: new Uint8Array(buffer) });
	return `data:audio/wav;base64,${base64}`;
}

export interface LocalSound {
	id: string;
	name: string;
	category: string;
	durationSeconds: number;
	sourceUrl: string;
}

const TONE_SPECS: Array<{
	id: string;
	name: string;
	category: string;
	frequencyHz: number;
	durationSeconds: number;
}> = [
	{ id: "local-chime", name: "Soft Chime", category: "Notification", frequencyHz: 880, durationSeconds: 1.2 },
	{ id: "local-pulse", name: "Deep Pulse", category: "Beat", frequencyHz: 110, durationSeconds: 1.5 },
	{ id: "local-ping", name: "Bright Ping", category: "Notification", frequencyHz: 1320, durationSeconds: 0.8 },
	{ id: "local-hum", name: "Warm Hum", category: "Ambient", frequencyHz: 220, durationSeconds: 2.0 },
];

let cachedSounds: LocalSound[] | null = null;

/** Lazily synthesized so importing this module never does eager work. */
export function getLocalSounds(): LocalSound[] {
	if (cachedSounds) return cachedSounds;
	cachedSounds = TONE_SPECS.map((spec) => ({
		id: spec.id,
		name: spec.name,
		category: spec.category,
		durationSeconds: spec.durationSeconds,
		sourceUrl: synthesizeToneWavDataUri({
			frequencyHz: spec.frequencyHz,
			durationSeconds: spec.durationSeconds,
		}),
	}));
	return cachedSounds;
}
