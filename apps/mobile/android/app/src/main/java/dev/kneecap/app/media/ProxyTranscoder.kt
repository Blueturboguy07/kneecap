package dev.kneecap.app.media

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import java.io.File
import java.util.UUID

/**
 * kneecap M4 item 4 / Plan Amendment 4 (corpus 08 §8, 10 §2.2-2.4) — the
 * native short-GOP preview-proxy transcode. Downscales to
 * `ProxySpec.targetHeight` (short edge — see the field's doc comment in
 * `packages/native-bridge/src/types.ts`) with a short keyframe interval so
 * the webview's `mediabunny CanvasSink` gets fast random-access seeks
 * without ever touching the full-resolution source.
 *
 * Uses `Transformer.start(EditedMediaItem, String)` — the single-item
 * overload, not a multi-track `Composition` — because a proxy is a 1:1
 * transcode of one source asset; `Composition`/`EditedMediaItemSequence`
 * are for M9's multi-clip EDL export, a different (later) call site.
 *
 * `Transformer` requires construction and every subsequent call
 * (`start`, `getProgress`, `cancel`) to happen on the same `Looper` thread
 * (its "application thread" — see `Transformer.Builder#setLooper`, unset
 * default is the calling thread's own looper). Capacitor dispatches
 * `@PluginMethod` calls on a background thread with no `Looper` prepared, so
 * every entry point here explicitly hops to the main `Looper` via
 * `Handler(Looper.getMainLooper())` rather than relying on the caller's
 * thread having one.
 */
object ProxyTranscoder {
	private const val PROXY_SUBDIR = "proxies"
	private const val PROGRESS_POLL_INTERVAL_MS = 250L

	sealed interface Event {
		data class Progress(val fraction: Float) : Event
		data class Done(val outputFile: File) : Event
		data class Error(val message: String) : Event
	}

	/**
	 * Starts the transcode and invokes [onEvent] (on the main thread) for each
	 * progress tick and for the terminal `Done`/`Error`. Fire-and-forget by
	 * design — see `NativeBridgePlugin.generateProxy`'s doc comment for why
	 * this shape (native events, not a suspend/blocking call) is what a
	 * Capacitor plugin needs to back the TS side's `AsyncGenerator<
	 * ProxyProgress>`.
	 */
	fun start(
		context: Context,
		assetId: String,
		sourceFile: File,
		targetShortEdgePx: Int,
		shortGop: Boolean,
		onEvent: (Event) -> Unit,
	) {
		val mainHandler = Handler(Looper.getMainLooper())
		mainHandler.post {
			try {
				startOnMainThread(
					context = context,
					assetId = assetId,
					sourceFile = sourceFile,
					targetShortEdgePx = targetShortEdgePx,
					shortGop = shortGop,
					mainHandler = mainHandler,
					onEvent = onEvent,
				)
			} catch (e: Exception) {
				onEvent(Event.Error(e.message ?: "proxy transcode failed to start"))
			}
		}
	}

	private fun proxyDir(context: Context): File {
		val dir = File(context.noBackupFilesDir, PROXY_SUBDIR)
		if (!dir.exists()) dir.mkdirs()
		return dir
	}

	private fun startOnMainThread(
		context: Context,
		assetId: String,
		sourceFile: File,
		targetShortEdgePx: Int,
		shortGop: Boolean,
		mainHandler: Handler,
		onEvent: (Event) -> Unit,
	) {
		val outputFile = File(proxyDir(context), "$assetId-${UUID.randomUUID()}.mp4")

		val videoEncoderSettings = VideoEncoderSettings.Builder()
			.setiFrameIntervalSeconds(iFrameIntervalSecondsFor(shortGop))
			.build()
		val encoderFactory = DefaultEncoderFactory.Builder(context)
			.setRequestedVideoEncoderSettings(videoEncoderSettings)
			// Device/format-specific hardware encoder failures are a documented
			// Media3 reality (corpus 08 §8, androidx/media#2751) — fall back to a
			// supported configuration rather than hard-failing the import.
			.setEnableFallback(true)
			.build()

		val editedMediaItem = EditedMediaItem.Builder(MediaItem.fromUri(sourceFile.toURI().toString()))
			.setEffects(
				Effects(
					/* audioProcessors = */ emptyList(),
					/* videoEffects = */ listOf(Presentation.createForShortSide(targetShortEdgePx)),
				),
			)
			.build()

		val transformer = Transformer.Builder(context)
			.setVideoMimeType(MimeTypes.VIDEO_H264)
			.setEncoderFactory(encoderFactory)
			.addListener(object : Transformer.Listener {
				override fun onCompleted(composition: Composition, exportResult: ExportResult) {
					onEvent(Event.Done(outputFile))
				}

				override fun onError(
					composition: Composition,
					exportResult: ExportResult,
					exportException: ExportException,
				) {
					onEvent(Event.Error(exportException.message ?: "proxy transcode failed"))
				}
			})
			.build()

		transformer.start(editedMediaItem, outputFile.absolutePath)
		pollProgress(transformer, mainHandler, onEvent)
	}

	private fun pollProgress(
		transformer: Transformer,
		mainHandler: Handler,
		onEvent: (Event) -> Unit,
	) {
		val holder = ProgressHolder()
		val state = transformer.getProgress(holder)
		if (state == Transformer.PROGRESS_STATE_AVAILABLE) {
			onEvent(Event.Progress(holder.progress / 100f))
		}
		if (state == Transformer.PROGRESS_STATE_NOT_STARTED) {
			// Terminal from Transformer's own perspective (completed, cancelled,
			// or errored) — the Done/Error event already fired via the Listener
			// above, so stop polling rather than emitting a spurious extra tick.
			return
		}
		mainHandler.postDelayed(
			{ pollProgress(transformer, mainHandler, onEvent) },
			PROGRESS_POLL_INTERVAL_MS,
		)
	}
}
