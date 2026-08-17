package dev.kneecap.app.export

import android.content.Context
import android.media.MediaCodecInfo
import android.os.Handler
import android.os.Looper
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EncoderSelector
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import dev.kneecap.app.edl.Edl
import dev.kneecap.app.media.MediaProbe
import java.io.File

/**
 * EDL -> hardware-encoded MP4 (plan M9 "Both" items 5-7): progress +
 * cancellation, a defensive hardware->software retry on `ExportException`
 * (`08` §8's documented device-specific `ExportException`/MediaCodec
 * failures, `androidx/media#1504`/`#2751`), and an output-integrity
 * re-probe before declaring success. Structurally mirrors M4's
 * `ProxyTranscoder` (same main-`Looper` requirement — see that file's doc
 * comment — same sealed-`Event`-callback shape) but drives a multi-sequence
 * `Composition` (`EdlToComposition`) through `Transformer.start(Composition,
 * String)` instead of a single-item transcode.
 *
 * Single-export-at-a-time by design (matches `packages/native-bridge/src/
 * types.ts`'s `ExportProgress`, which — unlike `ProxyProgress` — carries no
 * id to disambiguate concurrent exports): `activeTransformer`/
 * `activeMainHandler` are object-level state, not per-call. A second
 * `start()` while one is already running throws rather than silently
 * clobbering the first.
 */
object Media3Exporter {
    private const val PROGRESS_POLL_INTERVAL_MS = 250L

    /** Software-codec name prefixes on Android's `MediaCodecList` — the
     * standard signature (no dedicated `isSoftwareOnly()` API existed before
     * API 29's `MediaCodecInfo.isSoftwareOnly()`, which IS available at our
     * `minSdk` 29 floor and is what `SoftwareOnlyEncoderSelector` actually
     * uses below; the name-prefix comment is kept only as a human-readable
     * cross-check). */
    private class SoftwareOnlyEncoderSelector : EncoderSelector {
        override fun selectEncoderInfos(mimeType: String): com.google.common.collect.ImmutableList<MediaCodecInfo> {
            val all = EncoderSelector.DEFAULT.selectEncoderInfos(mimeType)
            val softwareOnly = all.filter { it.isSoftwareOnly }
            return com.google.common.collect.ImmutableList.copyOf(
                softwareOnly.ifEmpty { all }, // no software encoder for this mime: fall back to the default list
            )
        }
    }

    sealed interface Event {
        data class Progress(val fraction: Float) : Event
        data class Done(val outputFile: File, val durationMs: Long, val fileSizeBytes: Long) : Event
        data class Error(val message: String) : Event
    }

    private var activeTransformer: Transformer? = null
    private var activeMainHandler: Handler? = null

    fun start(context: Context, edl: Edl, outputFile: File, onEvent: (Event) -> Unit) {
        val mainHandler = Handler(Looper.getMainLooper())
        mainHandler.post {
            if (activeTransformer != null) {
                onEvent(Event.Error("an export is already in progress"))
                return@post
            }
            try {
                val composition = EdlToComposition.buildComposition(edl)
                runExport(
                    context = context,
                    composition = composition,
                    outputFile = outputFile,
                    mainHandler = mainHandler,
                    useSoftwareEncoder = false,
                    onEvent = onEvent,
                )
            } catch (e: ExportUnsupportedException) {
                onEvent(Event.Error(e.message ?: "EDL has an unsupported construct for native export"))
            } catch (e: Exception) {
                onEvent(Event.Error(e.message ?: "export failed to start"))
            }
        }
    }

    /** Best-effort: posts to the export's own main handler if one is
     * recorded. A no-op if nothing is running — matches
     * `Transformer.cancel()`'s own "safe to call even if not exporting"
     * contract. */
    fun cancel() {
        val handler = activeMainHandler ?: return
        handler.post {
            activeTransformer?.cancel()
            activeTransformer = null
            activeMainHandler = null
        }
    }

    private fun runExport(
        context: Context,
        composition: Composition,
        outputFile: File,
        mainHandler: Handler,
        useSoftwareEncoder: Boolean,
        onEvent: (Event) -> Unit,
    ) {
        val encoderFactoryBuilder = DefaultEncoderFactory.Builder(context)
            // Device/format-specific hardware encoder failures are real
            // (plan M9 item 3, `08` §8) — let Media3's own fallback search a
            // supported configuration before this class's own
            // software-encoder retry kicks in.
            .setEnableFallback(true)
            .setEnableFormatFallback(true)
        if (useSoftwareEncoder) {
            encoderFactoryBuilder.setVideoEncoderSelector(SoftwareOnlyEncoderSelector())
        }

        val transformer = Transformer.Builder(context)
            .setEncoderFactory(encoderFactoryBuilder.build())
            .addListener(object : Transformer.Listener {
                override fun onCompleted(finishedComposition: Composition, exportResult: ExportResult) {
                    activeTransformer = null
                    activeMainHandler = null
                    verifyOutputAndReport(outputFile, exportResult, onEvent)
                }

                override fun onError(
                    finishedComposition: Composition,
                    exportResult: ExportResult,
                    exportException: ExportException,
                ) {
                    activeTransformer = null
                    activeMainHandler = null
                    if (!useSoftwareEncoder) {
                        // Retry tier 2 (plan M9 item 3): same Composition
                        // (already includes the Presentation
                        // normalization pass from `EdlToComposition`),
                        // forced onto a software encoder rather than
                        // whatever hardware codec just failed.
                        outputFile.delete()
                        runExport(
                            context = context,
                            composition = composition,
                            outputFile = outputFile,
                            mainHandler = mainHandler,
                            useSoftwareEncoder = true,
                            onEvent = onEvent,
                        )
                    } else {
                        outputFile.delete() // no partial file left behind — plan M9 exit criteria.
                        onEvent(Event.Error(exportException.message ?: "export failed on both hardware and software encoders"))
                    }
                }
            })
            .build()

        activeTransformer = transformer
        activeMainHandler = mainHandler
        transformer.start(composition, outputFile.absolutePath)
        pollProgress(transformer, mainHandler, onEvent)
    }

    /** Plan M9 item 7: "Output integrity check before declaring success...
     * silent corruption is a documented WebCodecs/Safari failure mode and
     * the same defensive posture applies here." Re-probes the file Media3
     * itself just wrote, independent of `ExportResult`'s self-reported
     * numbers, using the same `MediaProbe` M4 already uses for imports. */
    private fun verifyOutputAndReport(outputFile: File, exportResult: ExportResult, onEvent: (Event) -> Unit) {
        if (!outputFile.exists() || outputFile.length() == 0L) {
            onEvent(Event.Error("export reported success but output file is missing or empty"))
            return
        }
        try {
            // Probing doesn't need a mime hint here — MediaProbe's own
            // extractor-based fallback (see that file) handles it.
            MediaProbe.probe(outputFile, mimeTypeHint = null)
        } catch (e: Exception) {
            outputFile.delete()
            onEvent(Event.Error("export produced an unreadable/corrupt file: ${e.message}"))
            return
        }
        onEvent(Event.Done(outputFile, exportResult.approximateDurationMs, outputFile.length()))
    }

    private fun pollProgress(transformer: Transformer, mainHandler: Handler, onEvent: (Event) -> Unit) {
        val holder = ProgressHolder()
        val state = transformer.getProgress(holder)
        if (state == Transformer.PROGRESS_STATE_AVAILABLE) {
            onEvent(Event.Progress(holder.progress / 100f))
        }
        if (state == Transformer.PROGRESS_STATE_NOT_STARTED) {
            return // terminal; Done/Error already fired via the Listener.
        }
        mainHandler.postDelayed({ pollProgress(transformer, mainHandler, onEvent) }, PROGRESS_POLL_INTERVAL_MS)
    }
}
