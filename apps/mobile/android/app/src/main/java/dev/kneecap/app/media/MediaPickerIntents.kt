package dev.kneecap.app.media

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.FileProvider
import java.io.File
import java.util.UUID

/**
 * kneecap M4 item 2 (corpus 08 §6): "`WebChromeClient.onShowFileChooser()`
 * override launching `ACTION_PICK_IMAGES` (Photo Picker) with SAF fallback."
 *
 * This repo's `NativeBridge.pickMedia()` is invoked directly from JS via the
 * Capacitor plugin call (`NativeBridgePlugin.pickMedia`), not through a
 * hidden `<input type="file">` DOM element — kneecap's mobile UI never
 * renders a file input at all (see `NativeBridgePlugin.kt`'s doc comment).
 * That sidesteps `onShowFileChooser` entirely rather than implementing it:
 * corpus 08 §6's own conclusion is "treat file import ... as a native-app
 * responsibility from day one, not a WebView responsibility" — calling the
 * native picker directly from the bridge method IS that, one layer earlier.
 * The *mechanism* 08 §6 warns about (Photo Picker isn't wired up
 * automatically) is what this file solves either way.
 */
object MediaPickerIntents {

	private const val DEFAULT_MULTI_PICK_LIMIT = 100

	/** True if `ACTION_PICK_IMAGES` resolves on this device — the modern
	 * Photo Picker, either OS-builtin (Android 13+) or backported via a
	 * Google Play system update (Android 11+). Where it doesn't resolve
	 * (older/non-Play devices), callers fall back to SAF. */
	fun isPhotoPickerAvailable(packageManager: PackageManager): Boolean {
		val probe = Intent(MediaStore.ACTION_PICK_IMAGES)
		return probe.resolveActivity(packageManager) != null
	}

	/** The modern Android Photo Picker. No `READ_MEDIA_*`/
	 * `READ_EXTERNAL_STORAGE` permission required — it runs out-of-process
	 * and grants only the specific items the user selects. */
	fun buildPhotoPickerIntent(kinds: List<String>, allowMultiple: Boolean): Intent {
		val intent = Intent(MediaStore.ACTION_PICK_IMAGES)
		val mimeTypes = mimeTypesFor(kinds)
		// ACTION_PICK_IMAGES only understands a single MIME filter (or none for
		// "everything the picker supports"); an editor's "video" filter is the
		// dominant case (plan M4's exit criteria are all video imports), so
		// prefer a single-type filter when exactly one kind was asked for and
		// leave the picker unfiltered (all photos+videos) otherwise — a picker
		// showing extra items the user then doesn't pick is a much smaller
		// papercut than a picker showing nothing because we AND'd two
		// mutually-exclusive MIME wildcards together.
		if (mimeTypes.size == 1) {
			intent.type = mimeTypes[0]
		}
		if (allowMultiple) {
			// MediaStore.getPickImagesMaxLimit() is an API 33+ framework method
			// (distinct from the picker *activity* itself, which can resolve as
			// far back as API 30 via the Play Services backport module) — an
			// SDK_INT gate, not a try/catch, because calling a method the
			// installed framework doesn't have throws NoSuchMethodError, which
			// is an Error, not an Exception, and would not be caught by a
			// `catch (_: Exception)`.
			val max = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
				MediaStore.getPickImagesMaxLimit()
			} else {
				DEFAULT_MULTI_PICK_LIMIT
			}
			intent.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, max)
		}
		return intent
	}

	/** SAF fallback for devices where the Photo Picker doesn't resolve.
	 * `ACTION_OPEN_DOCUMENT` (not `ACTION_GET_CONTENT`) so the returned URI
	 * supports `takePersistableUriPermission` if ever needed — though
	 * kneecap immediately copies bytes into app custody (`MediaImporter`)
	 * and doesn't rely on persisted grants. */
	fun buildSafFallbackIntent(kinds: List<String>, allowMultiple: Boolean): Intent {
		val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
		intent.addCategory(Intent.CATEGORY_OPENABLE)
		intent.type = "*/*"
		intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypesFor(kinds))
		intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple)
		return intent
	}

	/** Picks the Photo Picker when available, else the SAF fallback — plan M4
	 * item 2's exact instruction, resolved at call time per-device. */
	fun buildLibraryPickIntent(
		packageManager: PackageManager,
		kinds: List<String>,
		allowMultiple: Boolean,
	): Intent {
		return if (isPhotoPickerAvailable(packageManager)) {
			buildPhotoPickerIntent(kinds, allowMultiple)
		} else {
			buildSafFallbackIntent(kinds, allowMultiple)
		}
	}

	/**
	 * Plan M4 item 3: "`capture="camera"` is not honored by Android WebView
	 * by default — the host app must detect the attribute and build the
	 * camera Intent itself." kneecap detects it one layer earlier (
	 * `PickMediaOptions.source === "camera"` from the TS caller, never an
	 * HTML attribute — this app has no `<input>` at all, per the class doc
	 * comment above) but the underlying requirement — the host builds a real
	 * camera `Intent` — is the same. Returns the intent plus the output
	 * `content://` URI it was pointed at (via `FileProvider`, matching the
	 * `file_paths.xml`/`AndroidManifest` provider already declared for M3),
	 * since the camera app writes to that URI rather than returning a fresh
	 * one in the result `Intent`.
	 */
	fun buildCameraCaptureIntent(context: Context, kind: String): CameraCapture {
		val (action, extension) = if (kind == "video") {
			MediaStore.ACTION_VIDEO_CAPTURE to "mp4"
		} else {
			MediaStore.ACTION_IMAGE_CAPTURE to "jpg"
		}
		val captureDir = File(context.cacheDir, "camera-capture").apply { mkdirs() }
		val outputFile = File(captureDir, "${UUID.randomUUID()}.$extension")
		val outputUri = FileProvider.getUriForFile(
			context,
			"${context.packageName}.fileprovider",
			outputFile,
		)
		val intent = Intent(action).apply {
			putExtra(MediaStore.EXTRA_OUTPUT, outputUri)
			addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
			if (kind == "video") {
				// Plan M8's export sheet targets up to 1080p/4K; cap capture
				// quality at "high" (device-dependent, typically 1080p) rather
				// than leaving it unset (some OEM camera apps default to a
				// low-res "MMS-safe" profile for ACTION_VIDEO_CAPTURE).
				putExtra(MediaStore.EXTRA_VIDEO_QUALITY, 1)
			}
		}
		return CameraCapture(intent = intent, outputUri = outputUri, outputFile = outputFile)
	}

	data class CameraCapture(val intent: Intent, val outputUri: Uri, val outputFile: File)
}
