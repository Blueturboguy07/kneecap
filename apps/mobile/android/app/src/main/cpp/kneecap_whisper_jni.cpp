// kneecap M10 — JNI glue implementing dev.kneecap.app.stt.WhisperJNI's
// native methods against the real whisper.cpp C API.
//
// STATUS: written and reviewed against whisper.h (verified locally against
// whisper.cpp 1.9.2's actual header, `/opt/homebrew/include/whisper.h`, and
// against a full source clone of ggml-org/whisper.cpp while writing this —
// not guessed). NOT compiled this session and NOT wired into the Gradle
// build (no `externalNativeBuild { cmake {...} }` block was added to
// app/build.gradle, deliberately — see WhisperJNI.java's class doc comment
// for why). Getting this file building requires:
//   1. Vendoring whisper.cpp's source (`ggml/`, `src/`, `include/`) under
//      this app module, or referencing it via CMake FetchContent pinned to
//      a commit — NOT via `git submodule` per this project's stated
//      preference for owning its dependency tree (plan risk #6).
//   2. A CMakeLists.txt (sibling of this file, not yet written) building
//      `libkneecap_whisper.so` for at least arm64-v8a (Android's dominant
//      real-device ABI; armeabi-v7a/x86_64 are a follow-up).
//   3. `externalNativeBuild { cmake { path "src/main/cpp/CMakeLists.txt" }
//      }` added to app/build.gradle.
// This is real, non-trivial NDK cross-compilation work — correctly out of
// scope for "part 1" per this task's own instructions.

#include <jni.h>
#include <string>
#include <vector>

#include "whisper.h"

extern "C" {

JNIEXPORT jlong JNICALL
Java_dev_kneecap_app_stt_WhisperJNI_initContext(
    JNIEnv *env, jclass /*clazz*/, jstring modelPath, jboolean dtw, jint aheadsPreset) {
    const char *path = env->GetStringUTFChars(modelPath, nullptr);

    struct whisper_context_params cparams = whisper_context_default_params();
    cparams.use_gpu = true; // harmless on devices without a usable GPU backend — whisper.cpp falls back to CPU itself.
    if (dtw) {
        // See WhisperJNI.java's doc comment: flash_attn MUST be off or DTW
        // silently produces t_dtw == -1 for every token with no error.
        cparams.flash_attn = false;
        cparams.dtw_token_timestamps = true;
        cparams.dtw_aheads_preset =
            static_cast<enum whisper_alignment_heads_preset>(aheadsPreset);
    }

    struct whisper_context *ctx = whisper_init_from_file_with_params(path, cparams);
    env->ReleaseStringUTFChars(modelPath, path);
    return reinterpret_cast<jlong>(ctx);
}

JNIEXPORT void JNICALL
Java_dev_kneecap_app_stt_WhisperJNI_freeContext(JNIEnv * /*env*/, jclass /*clazz*/, jlong ctxPtr) {
    if (ctxPtr == 0) return;
    whisper_free(reinterpret_cast<struct whisper_context *>(ctxPtr));
}

JNIEXPORT void JNICALL
Java_dev_kneecap_app_stt_WhisperJNI_fullTranscribe(
    JNIEnv *env, jclass /*clazz*/, jlong ctxPtr, jint numThreads, jfloatArray audioData) {
    auto *ctx = reinterpret_cast<struct whisper_context *>(ctxPtr);

    struct whisper_full_params wparams =
        whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    wparams.n_threads = numThreads;
    wparams.translate = false;
    wparams.print_progress = false;
    wparams.print_realtime = false;
    wparams.print_timestamps = false;
    // token_timestamps=true is required for whisper_full_get_token_data's
    // t0/t1 to be populated at all — DTW (if the context was initialized
    // with it) is an ADDITIONAL, separate signal on top of this, not a
    // replacement for it. See caption-smoothing.ts's module header for why
    // both are read.
    wparams.token_timestamps = true;

    jsize len = env->GetArrayLength(audioData);
    jfloat *samples = env->GetFloatArrayElements(audioData, nullptr);
    whisper_full(ctx, wparams, samples, len);
    env->ReleaseFloatArrayElements(audioData, samples, JNI_ABORT);
}

JNIEXPORT jint JNICALL
Java_dev_kneecap_app_stt_WhisperJNI_getSegmentCount(JNIEnv * /*env*/, jclass /*clazz*/, jlong ctxPtr) {
    return whisper_full_n_segments(reinterpret_cast<struct whisper_context *>(ctxPtr));
}

JNIEXPORT jlong JNICALL
Java_dev_kneecap_app_stt_WhisperJNI_getSegmentT0(
    JNIEnv * /*env*/, jclass /*clazz*/, jlong ctxPtr, jint segmentIndex) {
    return whisper_full_get_segment_t0(
        reinterpret_cast<struct whisper_context *>(ctxPtr), segmentIndex);
}

JNIEXPORT jlong JNICALL
Java_dev_kneecap_app_stt_WhisperJNI_getSegmentT1(
    JNIEnv * /*env*/, jclass /*clazz*/, jlong ctxPtr, jint segmentIndex) {
    return whisper_full_get_segment_t1(
        reinterpret_cast<struct whisper_context *>(ctxPtr), segmentIndex);
}

JNIEXPORT jstring JNICALL
Java_dev_kneecap_app_stt_WhisperJNI_getSegmentText(
    JNIEnv *env, jclass /*clazz*/, jlong ctxPtr, jint segmentIndex) {
    const char *text = whisper_full_get_segment_text(
        reinterpret_cast<struct whisper_context *>(ctxPtr), segmentIndex);
    return env->NewStringUTF(text);
}

JNIEXPORT jint JNICALL
Java_dev_kneecap_app_stt_WhisperJNI_getSegmentTokenCount(
    JNIEnv * /*env*/, jclass /*clazz*/, jlong ctxPtr, jint segmentIndex) {
    return whisper_full_n_tokens(
        reinterpret_cast<struct whisper_context *>(ctxPtr), segmentIndex);
}

// Non-text tokens (id >= whisper_token_eot) are skipped by returning an
// empty string — mirrors examples/cli/cli.cpp's own filtering
// (`tokens[j].id >= whisper_token_eot(ctx)`). caption-smoothing.ts's
// `smoothWordTimings` already drops empty-text tokens defensively (see its
// module header), so this is belt-and-suspenders, not the only filter.
static bool isTextToken(struct whisper_context *ctx, whisper_token id) {
    return id < whisper_token_eot(ctx);
}

JNIEXPORT jstring JNICALL
Java_dev_kneecap_app_stt_WhisperJNI_getTokenText(
    JNIEnv *env, jclass /*clazz*/, jlong ctxPtr, jint segmentIndex, jint tokenIndex) {
    auto *ctx = reinterpret_cast<struct whisper_context *>(ctxPtr);
    whisper_token_data td = whisper_full_get_token_data(ctx, segmentIndex, tokenIndex);
    if (!isTextToken(ctx, td.id)) return env->NewStringUTF("");
    return env->NewStringUTF(whisper_full_get_token_text(ctx, segmentIndex, tokenIndex));
}

JNIEXPORT jlong JNICALL
Java_dev_kneecap_app_stt_WhisperJNI_getTokenT0(
    JNIEnv * /*env*/, jclass /*clazz*/, jlong ctxPtr, jint segmentIndex, jint tokenIndex) {
    auto *ctx = reinterpret_cast<struct whisper_context *>(ctxPtr);
    return whisper_full_get_token_data(ctx, segmentIndex, tokenIndex).t0;
}

JNIEXPORT jlong JNICALL
Java_dev_kneecap_app_stt_WhisperJNI_getTokenT1(
    JNIEnv * /*env*/, jclass /*clazz*/, jlong ctxPtr, jint segmentIndex, jint tokenIndex) {
    auto *ctx = reinterpret_cast<struct whisper_context *>(ctxPtr);
    return whisper_full_get_token_data(ctx, segmentIndex, tokenIndex).t1;
}

JNIEXPORT jlong JNICALL
Java_dev_kneecap_app_stt_WhisperJNI_getTokenDtw(
    JNIEnv * /*env*/, jclass /*clazz*/, jlong ctxPtr, jint segmentIndex, jint tokenIndex) {
    auto *ctx = reinterpret_cast<struct whisper_context *>(ctxPtr);
    // -1 is whisper.cpp's own "not computed" sentinel (include/whisper.h's
    // t_dtw doc comment) — passed straight through, converted to `null`
    // on the Java side (WhisperTranscriber.buildResult), never coerced to
    // 0 here (0 is a valid real timestamp).
    return whisper_full_get_token_data(ctx, segmentIndex, tokenIndex).t_dtw;
}

JNIEXPORT jfloat JNICALL
Java_dev_kneecap_app_stt_WhisperJNI_getTokenProbability(
    JNIEnv * /*env*/, jclass /*clazz*/, jlong ctxPtr, jint segmentIndex, jint tokenIndex) {
    auto *ctx = reinterpret_cast<struct whisper_context *>(ctxPtr);
    return whisper_full_get_token_data(ctx, segmentIndex, tokenIndex).p;
}

} // extern "C"
