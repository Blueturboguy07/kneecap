package dev.kneecap.app.stt;

/**
 * kneecap M10 — JNI surface for whisper.cpp on Android, plan M10 item 3
 * ("Android: whisper.cpp via JNI, examples/whisper.android is the
 * reference").
 *
 * NOT the same surface as upstream's own {@code examples/whisper.android}
 * (`lib/src/main/java/com/whispercpp/whisper/LibWhisper.kt` +
 * `lib/src/main/jni/whisper/jni.c`, both read directly from a local
 * whisper.cpp checkout while writing this file) — that reference app only
 * exposes SEGMENT-level text and `t0`/`t1` (`getTextSegmentCount`,
 * `getTextSegment`, `getTextSegmentT0/T1`), because its own use case
 * (live dictation demo) never needed word-level timing. kneecap's captions
 * feature needs per-TOKEN text, `t0`/`t1`, `t_dtw`, and decode probability
 * (plan M10 item 4's smoothing pass consumes exactly these four fields —
 * see `RawWordTiming` in packages/native-bridge/src/caption-smoothing.ts,
 * which this class's return shapes are deliberately kept parallel to), so
 * this JNI surface adds the token-level accessors the upstream example
 * doesn't have, alongside a `dtw` flag on `fullTranscribe` to opt into
 * `whisper_full_params.dtw_token_timestamps` (see `WhisperContext.h` for
 * the intended C++ side of this — not yet written this session, see the
 * package-level handoff note in `NativeBridgePlugin.java`).
 *
 * STATUS: this class compiles cleanly under `javac`/gradle today — `native`
 * method declarations don't require the implementation (a `.so`) to be
 * present at compile time, only at the first ACTUAL call, where a missing
 * library throws `UnsatisfiedLinkError`. No `libkneecap_whisper.so` is
 * built or bundled yet (that requires vendoring whisper.cpp's C/C++
 * sources under `android/app/src/main/cpp/` — see the header comment atop
 * the sibling `kneecap_whisper_jni.cpp`, which implements this class's
 * methods against the real whisper.h C API but is not yet in the build —
 * and wiring an `externalNativeBuild { cmake {...} }` block into
 * `app/build.gradle`, deliberately NOT done in this
 * session: getting that build green requires the NDK cross-compilation
 * toolchain and is a real, separate build-pipeline effort, not a
 * risk worth taking against the existing green M3 Android CI build without
 * a dedicated verification pass). Calling any method below today throws.
 */
final class WhisperJNI {

	private WhisperJNI() {}

	private static boolean libraryLoaded = false;

	static synchronized void ensureLibraryLoaded() {
		if (libraryLoaded) return;
		// Deliberately NOT in a static initializer: a static initializer
		// would throw the moment this class is first REFERENCED (e.g. by
		// the class loader resolving NativeBridgePlugin's imports), which
		// would take down plugin registration for every OTHER NativeBridge
		// method too. Loading lazily, only when a transcribe call actually
		// happens, means M3's already-working getDeviceInfo() round trip
		// stays completely unaffected by M10's missing .so.
		System.loadLibrary("kneecap_whisper");
		libraryLoaded = true;
	}

	/**
	 * DTW is configured at CONTEXT-INIT time in the real whisper.h C API —
	 * `whisper_context_params.dtw_token_timestamps` /
	 * `.dtw_aheads_preset`, read directly off `/opt/homebrew/include/whisper.h`
	 * while writing this (NOT a per-{@code whisper_full()}-call option, a
	 * detail easy to get backwards without checking the header — this
	 * class did, on a first pass). `whisper_init_from_file_with_params` is
	 * the actual entry point on the C++ side.
	 *
	 * @param aheadsPreset one of `whisper_alignment_heads_preset`'s ordinal
	 *     values (`include/whisper.h`) — `WHISPER_AHEADS_TINY_EN` for the
	 *     "tiny" model, `WHISPER_AHEADS_BASE_EN` for "base" (kneecap v1
	 *     ships English-only models; see `download-whisper-model.sh`).
	 *     Kept as a plain `int` ordinal rather than redeclaring the whole
	 *     enum in Java — the JNI C++ side is the one place that needs the
	 *     real enum, and it already has it via `whisper.h`.
	 *
	 * REAL GOTCHA, discovered running `whisper-cli` locally, not documented
	 * in the corpus: whisper.cpp 1.9.2 SILENTLY disables DTW when flash
	 * attention is on, logging only `dtw_token_timestamps is not supported
	 * with flash_attn - disabling` — no error, just quietly-wrong output
	 * (every `t_dtw` comes back -1). The C++ side of `initContext` MUST set
	 * `whisper_context_params.flash_attn = false` whenever `dtw` is true,
	 * or every "DTW-enabled" transcription on-device would silently
	 * degrade to coarse-only timestamps with no signal that it happened.
	 */
	static native long initContext(String modelPath, boolean dtw, int aheadsPreset);

	static native void freeContext(long contextPtr);

	/**
	 * Runs `whisper_full()` synchronously on the calling thread — callers
	 * MUST invoke this off the main thread (see
	 * `NativeBridgePlugin.transcribe()`'s executor). `audioData` must
	 * already be 16kHz mono float32 PCM (whisper.cpp's own hard
	 * requirement; kneecap M10 does not implement that decode/resample
	 * step yet — see `NativeBridgePlugin.java`).
	 */
	static native void fullTranscribe(long contextPtr, int numThreads, float[] audioData);

	static native int getSegmentCount(long contextPtr);

	/** Centiseconds, per whisper.cpp's own `t0`/`t1` unit — converted to
	 * microseconds in {@code WhisperTranscriber}, never here (this class is
	 * a thin, unit-preserving wrapper over the C API, on purpose: the unit
	 * conversion belongs in exactly one place). */
	static native long getSegmentT0(long contextPtr, int segmentIndex);

	static native long getSegmentT1(long contextPtr, int segmentIndex);

	static native String getSegmentText(long contextPtr, int segmentIndex);

	static native int getSegmentTokenCount(long contextPtr, int segmentIndex);

	static native String getTokenText(long contextPtr, int segmentIndex, int tokenIndex);

	static native long getTokenT0(long contextPtr, int segmentIndex, int tokenIndex);

	static native long getTokenT1(long contextPtr, int segmentIndex, int tokenIndex);

	/** Centiseconds, or -1 when whisper.cpp did not compute a DTW estimate
	 * for this token (its own sentinel, per `include/whisper.h`'s
	 * `whisper_token_data.t_dtw` doc comment). */
	static native long getTokenDtw(long contextPtr, int segmentIndex, int tokenIndex);

	static native float getTokenProbability(long contextPtr, int segmentIndex, int tokenIndex);
}
