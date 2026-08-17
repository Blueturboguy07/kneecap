package dev.kneecap.app.stt;

import android.content.Context;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.json.JSONException;

/**
 * kneecap M10 — the native-plugin-facing entry point for
 * `NativeBridge.transcribe()`. Produces exactly the wire shape
 * `packages/native-bridge/src/capacitor-bridge.ts` expects
 * (`NativeTranscribeResult` there): a list of segments, each carrying its
 * own start/end/text plus a `tokens` array shaped like `RawWordTiming`
 * (`caption-smoothing.ts`) — `coarseStartMicros`/`coarseEndMicros` from
 * whisper.cpp's `t0`/`t1`, `dtwStartMicros` from `t_dtw` (or `null` for its
 * `-1` sentinel), `confidence` from the token's decode probability. The
 * mandatory smoothing pass itself runs entirely on the TS side
 * (`mapNativeTranscribeResult()` in `capacitor-bridge.ts`) — this class's
 * only job is producing honest raw numbers for it to smooth.
 *
 * HONEST STATUS (see also `WhisperJNI`'s class doc comment): this class is
 * real, reviewed Java, but two things stand between it and an actual
 * on-device transcription today:
 *
 *   1. No `libkneecap_whisper.so` is built/bundled — `WhisperJNI`'s native
 *      calls throw `UnsatisfiedLinkError`.
 *   2. `decodeToMono16kFloat()` below is NOT implemented — turning an
 *      arbitrary native-custody audio/video URI into 16kHz mono float32
 *      PCM (whisper.cpp's hard input requirement) needs a real
 *      MediaExtractor/MediaCodec decode+resample pipeline. That is
 *      legitimately its own unit of work, and overlaps with M4's media
 *      pipeline (which will already own audio-track extraction for proxy
 *      generation) — implementing it twice, differently, here would be
 *      wasted work. Throws `UnsupportedOperationException` naming this
 *      reason rather than silently returning empty/fake audio.
 *
 * `transcribe()` therefore always throws today. That is the correct,
 * honest state for M10 part 1 — see the plan's own explicit allowance for
 * "simulator/device runs may be partial" and this class's own tests (none
 * yet: exercising this requires either a real `.so` + real audio, or a
 * device/emulator run, neither available in the session that wrote this).
 */
public final class WhisperTranscriber {

	private WhisperTranscriber() {}

	public static final class NotYetWiredException extends RuntimeException {
		public NotYetWiredException(String message) {
			super(message);
		}
	}

	/**
	 * @param context     Android context, used to resolve the bundled model
	 *                    asset path (`assets/models/ggml-{modelSize}.en.bin`,
	 *                    populated at build time by
	 *                    `scripts/download-whisper-model.sh` — see that
	 *                    script and `assets/models/README.md`).
	 * @param audioUri    native-custody handle to the source clip's audio
	 *                    (matches `MediaHandle.uri` — never a `blob:` URL).
	 * @param modelSize   "tiny" or "base" (`TranscribeOptions.modelSize`);
	 *                    resolves to the bundled `.en` asset — kneecap v1
	 *                    ships English-only models (see
	 *                    `download-whisper-model.sh`'s header comment).
	 * @param languageHint reserved for a future non-English model; unused
	 *                    while only `.en` models are bundled.
	 */
	public static JSObject transcribe(
			Context context, String audioUri, String modelSize, String languageHint)
			throws JSONException {
		String modelAssetPath = "models/ggml-" + modelSize + ".en.bin";
		if (!modelAssetExists(context, modelAssetPath)) {
			throw new NotYetWiredException(
					"Bundled model asset '"
							+ modelAssetPath
							+ "' not found. Run scripts/download-whisper-model.sh at build time"
							+ " (see apps/mobile/android/app/src/main/assets/models/README.md).");
		}

		// The two real gaps this class's doc comment describes. Both throw
		// before reaching WhisperJNI, so a missing .so is never the FIRST
		// error a caller sees — the audio-decode gap is more informative
		// and is fixed first regardless of library-loading status.
		float[] pcm16kMono = decodeToMono16kFloat(context, audioUri);

		WhisperJNI.ensureLibraryLoaded();
		// WHISPER_AHEADS_TINY_EN = 3, WHISPER_AHEADS_BASE_EN = 5 — ordinals
		// of `enum whisper_alignment_heads_preset` in `include/whisper.h`,
		// read directly off that header while writing this (see
		// WhisperJNI.initContext's doc comment for why an int ordinal
		// crosses the JNI boundary instead of redeclaring the enum here).
		int aheadsPreset = "base".equals(modelSize) ? 5 : 3;
		long ctx =
				WhisperJNI.initContext(
						resolveAbsoluteModelPath(context, modelAssetPath), /* dtw= */ true, aheadsPreset);
		if (ctx == 0) {
			throw new IllegalStateException("whisper_init failed for model " + modelAssetPath);
		}
		try {
			WhisperJNI.fullTranscribe(ctx, preferredThreadCount(), pcm16kMono);
			return buildResult(ctx);
		} finally {
			WhisperJNI.freeContext(ctx);
		}
	}

	private static JSObject buildResult(long ctx) throws JSONException {
		JSObject result = new JSObject();
		JSArray segments = new JSArray();
		int segmentCount = WhisperJNI.getSegmentCount(ctx);
		for (int s = 0; s < segmentCount; s++) {
			JSObject segment = new JSObject();
			segment.put("startMicros", WhisperJNI.getSegmentT0(ctx, s) * 10_000L);
			segment.put("endMicros", WhisperJNI.getSegmentT1(ctx, s) * 10_000L);
			segment.put("text", WhisperJNI.getSegmentText(ctx, s));
			segment.put("confidence", JSObject.NULL);

			JSArray tokens = new JSArray();
			int tokenCount = WhisperJNI.getSegmentTokenCount(ctx, s);
			for (int t = 0; t < tokenCount; t++) {
				JSObject token = new JSObject();
				token.put("text", WhisperJNI.getTokenText(ctx, s, t));
				token.put("coarseStartMicros", WhisperJNI.getTokenT0(ctx, s, t) * 10_000L);
				token.put("coarseEndMicros", WhisperJNI.getTokenT1(ctx, s, t) * 10_000L);
				long dtw = WhisperJNI.getTokenDtw(ctx, s, t);
				token.put("dtwStartMicros", dtw == -1 ? JSObject.NULL : dtw * 10_000L);
				token.put("confidence", WhisperJNI.getTokenProbability(ctx, s, t));
				tokens.put(token);
			}
			segment.put("tokens", tokens);
			segments.put(segment);
		}
		result.put("segments", segments);
		return result;
	}

	private static boolean modelAssetExists(Context context, String assetPath) {
		try (java.io.InputStream unused = context.getAssets().open(assetPath)) {
			return true;
		} catch (java.io.IOException e) {
			return false;
		}
	}

	private static String resolveAbsoluteModelPath(Context context, String assetPath) {
		// whisper.cpp's `whisper_init_from_file` needs a real filesystem
		// path, not an APK asset stream — the actual implementation copies
		// the asset to `context.getFilesDir()` once (cached across calls)
		// before calling into WhisperJNI. Not implemented in this session;
		// see class doc comment — `transcribe()` never reaches this call in
		// practice today because `decodeToMono16kFloat` throws first.
		throw new NotYetWiredException(
				"resolveAbsoluteModelPath: asset-to-filesystem-cache copy not implemented yet (M10 follow-up).");
	}

	/**
	 * See class doc comment, gap #2. Deliberately throws with a specific,
	 * actionable message instead of returning a zero-filled or truncated
	 * buffer — a caller silently getting back "silence" would be a much
	 * worse failure mode than a clear, immediate exception.
	 */
	private static float[] decodeToMono16kFloat(Context context, String audioUri) {
		throw new NotYetWiredException(
				"Audio decode to 16kHz mono float32 PCM is not implemented yet (M10 follow-up;"
						+ " overlaps with M4's media pipeline — see WhisperTranscriber's class doc"
						+ " comment). audioUri="
						+ audioUri);
	}

	private static int preferredThreadCount() {
		// Matches examples/whisper.android's own WhisperCpuConfig heuristic
		// (leave one core free for the OS/UI thread), without importing
		// that reference project — this is a two-line equivalent, not
		// worth a dependency.
		int cores = Runtime.getRuntime().availableProcessors();
		return Math.max(1, cores - 1);
	}
}
