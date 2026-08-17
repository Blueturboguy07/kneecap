package dev.kneecap.app.media

import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import java.io.File

/**
 * kneecap M4 (plan M4 item 1) — probes a copied-into-custody local file for
 * exactly the fields `MediaHandle` needs
 * (`packages/native-bridge/src/types.ts`). Runs entirely against the local
 * `File` produced by `MediaImporter`, never the original `content://` URI —
 * so probing works identically whether the source was the Photo Picker, SAF,
 * or the camera intent.
 *
 * `MediaMetadataRetriever` supplies duration/rotation/has-audio (simple,
 * well-covered API); `MediaExtractor` supplies the codec MIME type and frame
 * rate, which `MediaMetadataRetriever` either lacks or reports unreliably
 * (`METADATA_KEY_CAPTURE_FRAMERATE` is the *capture* rate, not always the
 * container's encoded rate, and is frequently absent). No
 * `androidx.media3.exoplayer` dependency — both classes are plain
 * `android.media`, already on every device at minSdk 29.
 */
object MediaProbe {

	data class ProbedMedia(
		val kind: String,
		val durationMicros: Long,
		val width: Int,
		val height: Int,
		val rotationDegrees: Int,
		val hasAudio: Boolean,
		val codec: String,
		val frameRate: Rational?,
	)

	/** Finds the first track whose MIME type starts with [prefix] ("video/" or
	 * "audio/"), or null if the container has none. */
	private fun findTrackFormat(extractor: MediaExtractor, prefix: String): MediaFormat? {
		for (i in 0 until extractor.trackCount) {
			val format = extractor.getTrackFormat(i)
			val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
			if (mime.startsWith(prefix)) return format
		}
		return null
	}

	private fun readFloat(format: MediaFormat, key: String): Float? {
		if (!format.containsKey(key)) return null
		return try {
			format.getFloat(key)
		} catch (_: Exception) {
			// Some encoders write KEY_FRAME_RATE as an Integer, not a Float;
			// MediaFormat has no type-agnostic getter, so fall back explicitly.
			try {
				format.getInteger(key).toFloat()
			} catch (_: Exception) {
				null
			}
		}
	}

	fun probe(file: File, mimeTypeHint: String?): ProbedMedia {
		val retriever = MediaMetadataRetriever()
		val extractor = MediaExtractor()
		try {
			retriever.setDataSource(file.absolutePath)
			extractor.setDataSource(file.absolutePath)

			val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
				?.toLongOrNull() ?: 0L
			val rawWidth = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
				?.toIntOrNull() ?: 0
			val rawHeight = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
				?.toIntOrNull() ?: 0
			val rawRotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
				?.toIntOrNull() ?: 0
			val hasAudio = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes"
			val mimeType = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE)
				?: mimeTypeHint

			val kind = inferKindFromMime(mimeType)

			var codec = "unknown"
			var frameRate: Rational? = null
			var width = rawWidth
			var height = rawHeight

			val videoFormat = findTrackFormat(extractor, "video/")
			if (videoFormat != null) {
				codec = videoFormat.getString(MediaFormat.KEY_MIME) ?: codec
				readFloat(videoFormat, MediaFormat.KEY_FRAME_RATE)?.let {
					frameRate = frameRateToRational(it)
				}
				if (width == 0 && videoFormat.containsKey(MediaFormat.KEY_WIDTH)) {
					width = videoFormat.getInteger(MediaFormat.KEY_WIDTH)
				}
				if (height == 0 && videoFormat.containsKey(MediaFormat.KEY_HEIGHT)) {
					height = videoFormat.getInteger(MediaFormat.KEY_HEIGHT)
				}
			} else if (kind == "audio") {
				val audioFormat = findTrackFormat(extractor, "audio/")
				codec = audioFormat?.getString(MediaFormat.KEY_MIME) ?: codec
			}

			return ProbedMedia(
				kind = kind,
				durationMicros = durationMs * 1000L,
				width = width,
				height = height,
				rotationDegrees = normalizeRotationDegrees(rawRotation),
				hasAudio = hasAudio || (kind == "audio"),
				codec = codec,
				frameRate = frameRate,
			)
		} finally {
			retriever.release()
			extractor.release()
		}
	}
}
// Kotlin's stdlib already provides String.toLongOrNull()/toIntOrNull() —
// used directly above, no local redeclaration needed.
