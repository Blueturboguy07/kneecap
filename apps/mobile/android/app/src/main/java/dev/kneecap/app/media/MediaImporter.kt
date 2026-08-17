package dev.kneecap.app.media

import android.content.Context
import android.net.Uri
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/**
 * kneecap M4 (plan M4 item 1/2; corpus 08 §5/§6) — copies a picked/captured
 * media URI into app-private custody so kneecap owns the bytes independent
 * of the source app's lifecycle (the Photo Picker's `content://` grant is
 * only reliably readable for the life of the returning call — see the doc
 * comment on `NativeBridgePlugin.handlePickResult`), and so later native
 * export (plan M9) has a stable file it can open directly.
 *
 * Uses `context.noBackupFilesDir` — Android's analog to iOS's "exclude from
 * iCloud backup" (plan M4 item 1's iOS instruction) — NOT `filesDir`, so
 * multi-gigabyte source video never rides along in an Auto Backup/Backup
 * Agent snapshot.
 *
 * Stream-copies via a bounded buffer; the source bytes pass through this
 * process's native heap only, one 64KB chunk at a time. This file has no
 * involvement with the WebView's JS heap at all, which is the actual
 * "media bytes never enter the JS heap" invariant (plan §2.2) — nothing
 * here could violate it even by accident, since there is no JS runtime on
 * this side of the bridge.
 */
object MediaImporter {
	private const val MEDIA_SUBDIR = "media"
	private const val COPY_BUFFER_BYTES = 64 * 1024

	data class ImportedFile(
		val file: File,
		val fileName: String,
		val sizeBytes: Long,
		val mimeType: String?,
	)

	private fun mediaDir(context: Context): File {
		val dir = File(context.noBackupFilesDir, MEDIA_SUBDIR)
		if (!dir.exists()) dir.mkdirs()
		return dir
	}

	/** Best-effort display name from the content resolver's OpenableColumns,
	 * falling back to the URI's last path segment. Never throws. */
	private fun resolveDisplayName(context: Context, uri: Uri): String? {
		return try {
			context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
				val nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
				if (nameIndex >= 0 && cursor.moveToFirst()) cursor.getString(nameIndex) else null
			}
		} catch (_: Exception) {
			null
		} ?: uri.lastPathSegment
	}

	private fun extensionFor(mimeType: String?, fallbackName: String?): String {
		val fromMime = mimeType?.let { MimeTypeMap.getSingleton().getExtensionFromMimeType(it) }
		if (!fromMime.isNullOrBlank()) return fromMime
		val fromName = fallbackName?.substringAfterLast('.', "")
		if (!fromName.isNullOrBlank() && fromName.length <= 5) return fromName
		return "bin"
	}

	/**
	 * Copies [sourceUri]'s bytes into `noBackupFilesDir/media/<uuid>.<ext>`
	 * and returns the destination file. Throws on I/O failure — callers
	 * (`NativeBridgePlugin`) map that to `NativeBridgeError({code:
	 * "IO_ERROR"})`.
	 */
	fun importInto(context: Context, sourceUri: Uri): ImportedFile {
		val resolver = context.contentResolver
		val mimeType = resolver.getType(sourceUri)
		val displayName = resolveDisplayName(context, sourceUri)
		val ext = extensionFor(mimeType, displayName)
		val destFile = File(mediaDir(context), "${UUID.randomUUID()}.$ext")

		val input = resolver.openInputStream(sourceUri)
			?: throw IllegalStateException("contentResolver.openInputStream returned null for $sourceUri")

		var totalBytes = 0L
		input.use { inStream ->
			FileOutputStream(destFile).use { outStream ->
				val buffer = ByteArray(COPY_BUFFER_BYTES)
				while (true) {
					val read = inStream.read(buffer)
					if (read == -1) break
					outStream.write(buffer, 0, read)
					totalBytes += read
				}
				outStream.flush()
			}
		}

		return ImportedFile(
			file = destFile,
			fileName = displayName ?: destFile.name,
			sizeBytes = totalBytes,
			mimeType = mimeType,
		)
	}

	/** Deletes a previously-imported file (e.g. when probing fails after the
	 * copy succeeded, so we don't leak an orphaned file in app storage). */
	fun delete(file: File) {
		try {
			file.delete()
		} catch (_: Exception) {
			// Best-effort cleanup; a leaked temp file is not worth surfacing an
			// error over the one we're already reporting.
		}
	}
}
