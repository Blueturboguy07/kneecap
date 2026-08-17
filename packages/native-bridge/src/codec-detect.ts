/**
 * Codec matrix detection via WebCodecs `isConfigSupported`, wrapped defensively.
 *
 * Plan M1 exit criteria calls this out by name: "`VideoEncoder.isConfigSupported`
 * throws a native `TypeError` on iOS Safari instead of returning
 * `{supported:false}`" (mediabunny#456). A naive caller crashes the whole
 * capabilities probe on iOS. `safeIsConfigSupported` is the one place that
 * defensiveness lives so every caller gets it for free.
 */

export type CodecDirection = "decode" | "encode";

interface MinimalCodecConfig {
	codec: string;
}

interface MinimalConfigSupport {
	supported?: boolean;
}

interface MinimalCodecStatic {
	isConfigSupported: (
		config: MinimalCodecConfig,
	) => Promise<MinimalConfigSupport>;
}

function codecStatic(direction: CodecDirection): MinimalCodecStatic | null {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- `globalThis` has no `VideoDecoder`/`VideoEncoder` typing without lib.dom's experimental WebCodecs lib; this narrows to the two optional fields this module reads.
	const g = globalThis as unknown as {
		VideoDecoder?: MinimalCodecStatic;
		VideoEncoder?: MinimalCodecStatic;
	};
	const ctor = direction === "decode" ? g.VideoDecoder : g.VideoEncoder;
	return ctor ?? null;
}

/** Never throws. Returns false for any unsupported, absent-API, or throwing case. */
export async function safeIsConfigSupported({
	direction,
	config,
}: {
	direction: CodecDirection;
	config: MinimalCodecConfig;
}): Promise<boolean> {
	const api = codecStatic(direction);
	if (!api) return false;
	try {
		const result = await api.isConfigSupported(config);
		return result.supported === true;
	} catch {
		// mediabunny#456: iOS Safari throws a native TypeError here instead of
		// resolving {supported:false}. Treat any throw as "not supported."
		return false;
	}
}

/**
 * The small, defensible codec set relevant to v1 export (plan §2.3 rule 4 /
 * M8's export sheet: H.264 default, HEVC where hardware-supported). Not an
 * exhaustive matrix — just enough to answer "can this device plausibly do
 * hardware HEVC" for the export-sheet codec picker.
 */
const PROBE_CODECS: Record<CodecDirection, { id: string; codec: string }[]> =
	{
		decode: [
			{ id: "h264", codec: "avc1.42001f" },
			{ id: "hevc", codec: "hvc1.1.6.L93.B0" },
			{ id: "vp9", codec: "vp09.00.10.08" },
			{ id: "av1", codec: "av01.0.04M.08" },
		],
		encode: [
			{ id: "h264", codec: "avc1.42001f" },
			{ id: "hevc", codec: "hvc1.1.6.L93.B0" },
		],
	};

export async function probeCodecs(): Promise<{
	decode: string[];
	encode: string[];
}> {
	const decode: string[] = [];
	const encode: string[] = [];
	for (const { id, codec } of PROBE_CODECS.decode) {
		if (await safeIsConfigSupported({ direction: "decode", config: { codec } }))
			decode.push(id);
	}
	for (const { id, codec } of PROBE_CODECS.encode) {
		if (await safeIsConfigSupported({ direction: "encode", config: { codec } }))
			encode.push(id);
	}
	return { decode, encode };
}
