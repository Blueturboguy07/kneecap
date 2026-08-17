package dev.kneecap.app.media

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import java.io.File
import java.io.FileOutputStream

/**
 * kneecap M4 item 5 (plan): "Thumbnail strip generation natively ...
 * served from the local server — do NOT decode filmstrip frames in JS."
 *
 * Extracts `count` frames evenly spaced across the clip's duration via
 * `MediaMetadataRetriever.getFrameAtTime`, downscales each to at most
 * [maxEdgePx] on its long edge (filmstrip thumbnails, not full frames —
 * M7 renders these at zoom-appropriate density, not full resolution), and
 * writes them as JPEGs under app-private storage. Returns native `file://`
 * paths — never a blob: URL, matching every other native-custody handle in
 * this bridge (`docs/EDL.md` §6).
 */
object ThumbnailStripGenerator {
	private const val THUMBNAIL_SUBDIR = "thumbnails"
	private const val JPEG_QUALITY = 80

	data class Thumbnail(val filePath: String, val timestampMicros: Long)

	private fun thumbnailDir(context: Context, assetId: String): File {
		val dir = File(File(context.noBackupFilesDir, THUMBNAIL_SUBDIR), assetId)
		if (!dir.exists()) dir.mkdirs()
		return dir
	}

	private fun downscale(bitmap: Bitmap, maxEdgePx: Int): Bitmap {
		val longEdge = maxOf(bitmap.width, bitmap.height)
		if (longEdge <= maxEdgePx || longEdge == 0) return bitmap
		val scale = maxEdgePx.toFloat() / longEdge
		val targetWidth = (bitmap.width * scale).toInt().coerceAtLeast(1)
		val targetHeight = (bitmap.height * scale).toInt().coerceAtLeast(1)
		return Bitmap.createScaledBitmap(bitmap, targetWidth, targetHeight, true)
	}

	/**
	 * @param durationMicros the source clip's probed duration (from
	 *   `MediaProbe`) — reused here rather than re-probed, so this function
	 *   stays a pure "given a File and a duration, produce N frames" step.
	 */
	fun generate(
		context: Context,
		assetId: String,
		file: File,
		durationMicros: Long,
		count: Int,
		maxEdgePx: Int,
	): List<Thumbnail> {
		if (count <= 0 || durationMicros <= 0) return emptyList()

		val retriever = MediaMetadataRetriever()
		val results = mutableListOf<Thumbnail>()
		try {
			retriever.setDataSource(file.absolutePath)
			val dir = thumbnailDir(context, assetId)

			// Evenly spaced across the clip, inset by half a step so the first
			// and last thumbnails aren't exactly at frame 0 / EOF (both are
			// disproportionately likely to be a black/transitional frame).
			val step = durationMicros / count
			for (i in 0 until count) {
				val timestampMicros = (step * i) + (step / 2)
				val frame = retriever.getFrameAtTime(
					timestampMicros,
					MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
				) ?: continue

				val scaled = downscale(frame, maxEdgePx)
				val outFile = File(dir, "$i.jpg")
				FileOutputStream(outFile).use { out ->
					scaled.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
				}
				if (scaled !== frame) scaled.recycle()
				frame.recycle()

				results.add(Thumbnail(filePath = outFile.absolutePath, timestampMicros = timestampMicros))
			}
		} finally {
			retriever.release()
		}
		return results
	}
}
