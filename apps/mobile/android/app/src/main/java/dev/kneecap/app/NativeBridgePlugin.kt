package dev.kneecap.app

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONObject
import dev.kneecap.app.edl.EdlParseException
import dev.kneecap.app.edl.EdlParser
import dev.kneecap.app.export.Media3Exporter
import dev.kneecap.app.export.PrerenderedOverlay
import dev.kneecap.app.export.ticksToUs
import dev.kneecap.app.media.MediaImporter
import dev.kneecap.app.media.MediaPickerIntents
import dev.kneecap.app.media.MediaProbe
import dev.kneecap.app.media.ProxyTranscoder
import dev.kneecap.app.media.ThumbnailStripGenerator
import dev.kneecap.app.stt.WhisperTranscriber
import java.io.File
import java.io.IOException
import java.util.UUID

/**
 * kneecap M3 (`getDeviceInfo`) + M4 (`pickMedia`/`generateProxy`/
 * `generateThumbnails`) + M9 (`exportProject`/`exportCancel`) — the native
 * half of `NativeBridge`
 * (`packages/native-bridge/src/{types,capacitor-bridge}.ts`). Ported from
 * Java to Kotlin in M4 (see `apps/mobile/android/build.gradle`'s Kotlin
 * toolchain addition) — the media pipeline is materially easier to express
 * correctly in Kotlin (sealed `ProxyTranscoder.Event`, data classes for
 * probed/imported media, null-safety on every `content://` round trip) than
 * repeating M3's Java style would have been.
 *
 * Deliberate architecture note (corpus 08 §6): this app never renders an
 * `<input type="file">` in the WebView, so `WebChromeClient
 * .onShowFileChooser()` — the mechanism 08 §6 documents as the standard fix
 * for "WebView doesn't wire file inputs to the Photo Picker" — is not
 * needed here. `pickMedia` is called directly from JS via this plugin
 * method and launches the native picker itself
 * (`MediaPickerIntents.buildLibraryPickIntent`). Same underlying problem
 * (native must own the picker), one layer earlier in the stack.
 *
 * `generateProxy`/`generateThumbnails` are async but Capacitor
 * `PluginCall`s resolve once — `generateProxy` therefore resolves
 * immediately with `{assetId}` once the transcode has *started*, and
 * streams `ProxyProgress` updates via `notifyListeners("proxyProgress",
 * ...)`; the TS side's `AsyncGenerator<ProxyProgress>`
 * (`capacitor-bridge.ts`) is what turns that event stream back into pulled
 * values. `generateThumbnails` is fast enough (a handful of JPEGs) that it
 * stays a plain resolve-when-done call.
 */
@CapacitorPlugin(
	name = "NativeBridge",
	permissions = [Permission(strings = [Manifest.permission.CAMERA], alias = "camera")],
)
class NativeBridgePlugin : Plugin() {

	/** Bridges `MediaPickerIntents.buildCameraCaptureIntent`'s output across
	 * the permission-request and/or activity-result round trip — Capacitor
	 * re-delivers the ORIGINAL `PluginCall` (same `kinds`/`source` params) to
	 * both `@PermissionCallback` and `@ActivityCallback` methods, but the
	 * `FileProvider` output URI is generated only once, here, so it must be
	 * stashed rather than recomputed. */
	private var pendingCameraCapture: MediaPickerIntents.CameraCapture? = null

	/** The `exportId` of the one in-flight export, or null when idle. See
	 * `exportProject`'s doc comment: `Media3Exporter` is single-export-by
	 * -design, so this is a single field rather than the iOS side's
	 * `activeExportHandles` map, but the JS-facing wire contract (every
	 * `exportProgress` event carries the caller's id) is identical on both
	 * platforms. */
	private var activeExportId: String? = null

	/** Native preview-audio router — iOS-only for now: the webview-silence
	 *  bug is device-verified on iOS, while Android WebView WebAudio is
	 *  expected functional (untested on hardware). Android reports
	 *  available:false so the JS AudioManager keeps its WebAudio path. */
	@PluginMethod
	fun audioStart(call: PluginCall) {
		call.reject("native preview audio not implemented on android", "UNSUPPORTED")
	}

	@PluginMethod
	fun audioStop(call: PluginCall) {
		call.resolve(JSObject())
	}

	@PluginMethod
	fun audioLevel(call: PluginCall) {
		val ret = JSObject()
		ret.put("rms", 0.0)
		call.resolve(ret)
	}

	/** Native tone bisector — parity with iOS playTestTone (see the iOS
	 *  pluginMethods comment). */
	@PluginMethod
	fun playTestTone(call: PluginCall) {
		Thread {
			try {
				val tone = android.media.ToneGenerator(android.media.AudioManager.STREAM_MUSIC, 80)
				tone.startTone(android.media.ToneGenerator.TONE_DTMF_1, 800)
				Thread.sleep(900)
				tone.release()
			} catch (_: Exception) {
				// Best effort — the bisector's answer is audible or not.
			}
		}.start()
		val ret = JSObject()
		ret.put("ok", true)
		call.resolve(ret)
	}

	/** The media-custody root, so the webview persists container-RELATIVE
	 *  media paths. On iOS the data-container UUID rotates every
	 *  update/reinstall, killing persisted absolute paths; Android's data
	 *  dir is stable, but the same relative scheme keeps the two platforms'
	 *  persistence identical. Root here = `noBackupFilesDir`, the parent of
	 *  MediaImporter/ProxyTranscoder/ThumbnailStripGenerator's subdirs. */
	@PluginMethod
	fun getMediaRoot(call: PluginCall) {
		val result = JSObject()
		result.put("root", context.noBackupFilesDir.absolutePath)
		call.resolve(result)
	}

	@PluginMethod
	fun getDeviceInfo(call: PluginCall) {
		val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
		val memoryInfo = ActivityManager.MemoryInfo()
		var ramTierMb = 0L
		activityManager?.getMemoryInfo(memoryInfo)
		if (activityManager != null) {
			ramTierMb = memoryInfo.totalMem / (1024 * 1024)
		}

		val result = JSObject()
		result.put("osVersion", Build.VERSION.RELEASE)
		result.put("deviceModel", "${Build.MANUFACTURER} ${Build.MODEL}")
		result.put("ramTierMb", ramTierMb)
		call.resolve(result)
	}

	// -- pickMedia --------------------------------------------------------

	@PluginMethod
	fun pickMedia(call: PluginCall) {
		val kinds = readKinds(call)
		val allowMultiple = call.getBoolean("allowMultiple", false) ?: false
		val source = call.getString("source", "library")

		// Blind test round 2: a bundled sound (the Audio panel's list) is a
		// file of the app's web assets. It goes into the same media custody
		// as a picked file, so the preview and the export read it.
		if (source == "bundled") {
			importBundledAsync(call)
			return
		}

		if (source == "camera") {
			val kind = if (kinds.contains("video")) "video" else "image"
			if (getPermissionState("camera") != PermissionState.GRANTED) {
				requestPermissionForAlias("camera", call, "cameraPermissionCallback")
				return
			}
			launchCameraCapture(call, kind)
			return
		}

		val intent = MediaPickerIntents.buildLibraryPickIntent(
			context.packageManager,
			kinds,
			allowMultiple,
		)
		startActivityForResult(call, intent, "handleLibraryPickResult")
	}

	private fun readKinds(call: PluginCall): List<String> {
		return try {
			call.getArray("kinds")?.toList<String>() ?: listOf("video")
		} catch (_: org.json.JSONException) {
			listOf("video")
		}
	}

	@PermissionCallback
	private fun cameraPermissionCallback(call: PluginCall) {
		if (getPermissionState("camera") == PermissionState.GRANTED) {
			val kinds = readKinds(call)
			val kind = if (kinds.contains("video")) "video" else "image"
			launchCameraCapture(call, kind)
		} else {
			call.reject("Camera permission denied", "PERMISSION_DENIED")
		}
	}

	private fun launchCameraCapture(call: PluginCall, kind: String) {
		val capture = MediaPickerIntents.buildCameraCaptureIntent(context, kind)
		pendingCameraCapture = capture
		startActivityForResult(call, capture.intent, "handleCameraCaptureResult")
	}

	@ActivityCallback
	private fun handleLibraryPickResult(call: PluginCall, result: ActivityResult) {
		if (result.resultCode != Activity.RESULT_OK) {
			call.reject("User cancelled media selection", "USER_CANCELLED")
			return
		}
		val data = result.data
		val uris = mutableListOf<Uri>()
		val clipData = data?.clipData
		if (clipData != null) {
			for (i in 0 until clipData.itemCount) {
				uris.add(clipData.getItemAt(i).uri)
			}
		} else {
			data?.data?.let { uris.add(it) }
		}
		if (uris.isEmpty()) {
			call.reject("No media selected", "USER_CANCELLED")
			return
		}
		importAndProbeAsync(call, uris)
	}

	@ActivityCallback
	private fun handleCameraCaptureResult(call: PluginCall, result: ActivityResult) {
		val capture = pendingCameraCapture
		pendingCameraCapture = null
		if (result.resultCode != Activity.RESULT_OK || capture == null) {
			call.reject("Camera capture cancelled", "USER_CANCELLED")
			return
		}
		importAndProbeAsync(call, listOf(capture.outputUri))
	}

	/** Copy-then-probe touches disk I/O and `MediaMetadataRetriever`/
	 * `MediaExtractor` — real work, kept off Capacitor's calling thread (which
	 * is itself already a background thread, but `startActivityForResult`'s
	 * callback is documented as running on the main thread, so this still
	 * matters). */
	private fun importAndProbeAsync(call: PluginCall, uris: List<Uri>) {
		Thread {
			val handles = JSArray()
			// Per-item isolation + pickProgress events, matching iOS: one
			// failing item must neither lose the batch (the old behavior
			// here) nor vanish silently (the old iOS behavior) — and the
			// copy of a cloud-backed picker item is real wall-clock work
			// the UI needs to show (2026-08-19).
			for ((index, uri) in uris.withIndex()) {
				emitPickProgress(index, uris.size, "loading", 0.0, null)
				try {
					val imported = MediaImporter.importInto(context, uri)
					try {
						val probed = MediaProbe.probe(imported.file, imported.mimeType)
						handles.put(mediaHandleToJson(imported, probed))
						emitPickProgress(index, uris.size, "loaded", 1.0, null)
					} catch (e: Exception) {
						MediaImporter.delete(imported.file)
						throw e
					}
				} catch (e: Exception) {
					emitPickProgress(index, uris.size, "error", 1.0, e.message ?: "media import failed")
				}
			}
			val result = JSObject()
			result.put("handles", handles)
			call.resolve(result)
		}.start()
	}

	/** `pickMedia({source: "bundled", bundledPath: "sounds/<name>.wav"})`:
	 * copies `public/<bundledPath>` (the web bundle in the APK assets) into
	 * media custody and resolves it as a one-handle pick. No picker opens. */
	private fun importBundledAsync(call: PluginCall) {
		val path = call.getString("bundledPath")
		if (path == null || !Regex("^sounds/[a-z0-9-]+\\.(wav|m4a)$").matches(path)) {
			call.reject("pickMedia source=bundled needs bundledPath sounds/<name>.wav", "IO_ERROR")
			return
		}
		Thread {
			try {
				val imported = MediaImporter.importAsset(context, "public/$path")
				try {
					val probed = MediaProbe.probe(imported.file, imported.mimeType)
					val handles = JSArray()
					handles.put(mediaHandleToJson(imported, probed))
					val result = JSObject()
					result.put("handles", handles)
					call.resolve(result)
				} catch (e: Exception) {
					MediaImporter.delete(imported.file)
					throw e
				}
			} catch (e: Exception) {
				call.reject(e.message ?: "bundled media import failed", "IO_ERROR")
			}
		}.start()
	}

	private fun emitPickProgress(index: Int, total: Int, stage: String, fraction: Double, error: String?) {
		val payload = JSObject()
		payload.put("index", index)
		payload.put("total", total)
		payload.put("stage", stage)
		payload.put("fraction", fraction)
		if (error != null) payload.put("error", error)
		notifyListeners("pickProgress", payload)
	}

	private fun mediaHandleToJson(imported: MediaImporter.ImportedFile, probed: MediaProbe.ProbedMedia): JSObject {
		val json = JSObject()
		json.put("id", UUID.randomUUID().toString())
		// A native app-sandbox file path, never a blob: URL — the exact
		// contract `MediaHandle.uri` documents (packages/native-bridge/src/
		// types.ts).
		json.put("uri", Uri.fromFile(imported.file).toString())
		json.put("kind", probed.kind)
		json.put("fileName", imported.fileName)
		json.put("sizeBytes", imported.sizeBytes)
		json.put("durationMicros", probed.durationMicros)
		json.put("width", probed.width)
		json.put("height", probed.height)
		json.put("rotationDegrees", probed.rotationDegrees)
		json.put("hasAudio", probed.hasAudio)
		json.put("codec", probed.codec)
		val frameRate = probed.frameRate
		if (frameRate != null) {
			val frameRateJson = JSObject()
			frameRateJson.put("numerator", frameRate.numerator)
			frameRateJson.put("denominator", frameRate.denominator)
			json.put("frameRate", frameRateJson)
		} else {
			json.put("frameRate", JSONObject.NULL)
		}
		return json
	}

	// -- generateProxy ------------------------------------------------------

	@PluginMethod
	fun generateProxy(call: PluginCall) {
		val handleObj = call.getObject("handle")
		val specObj = call.getObject("spec")
		if (handleObj == null || specObj == null) {
			call.reject("generateProxy requires {handle, spec}", "IO_ERROR")
			return
		}
		val assetId = handleObj.getString("id")
		val uriString = handleObj.getString("uri")
		if (assetId == null || uriString == null) {
			call.reject("handle.id and handle.uri are required", "IO_ERROR")
			return
		}
		val sourceFile = fileFromNativeUri(uriString)
		if (sourceFile == null) {
			call.reject("handle.uri must be a native file:// handle", "UNSUPPORTED")
			return
		}
		// Same guard as iOS: this is a VIDEO transcoder (Media3 Transformer);
		// stills never come through here — the JS orchestration uses the
		// source as the proxy for kind=="image" (2026-08-19).
		if (handleObj.getString("kind") == "image") {
			call.reject("generateProxy is video-only; image assets use their source as the proxy", "UNSUPPORTED")
			return
		}
		val targetShortEdgePx = specObj.optInt("targetHeight", 540)
		val shortGop = specObj.optBoolean("shortGop", true)

		// Resolves the KICKOFF call now; the transcode itself streams via
		// `proxyProgress` events — see this class's doc comment.
		val ack = JSObject()
		ack.put("assetId", assetId)
		call.resolve(ack)

		ProxyTranscoder.start(
			context = context,
			assetId = assetId,
			sourceFile = sourceFile,
			targetShortEdgePx = targetShortEdgePx,
			shortGop = shortGop,
		) { event -> notifyListeners("proxyProgress", proxyEventToJson(assetId, event)) }
	}

	private fun proxyEventToJson(assetId: String, event: ProxyTranscoder.Event): JSObject {
		val payload = JSObject()
		payload.put("assetId", assetId)
		when (event) {
			is ProxyTranscoder.Event.Progress -> {
				payload.put("stage", "transcoding")
				payload.put("fraction", event.fraction.toDouble())
			}
			is ProxyTranscoder.Event.Done -> {
				payload.put("stage", "done")
				payload.put("fraction", 1.0)
				payload.put("proxyUri", Uri.fromFile(event.outputFile).toString())
			}
			is ProxyTranscoder.Event.Error -> {
				payload.put("stage", "error")
				payload.put("fraction", 1.0)
				payload.put("error", event.message)
			}
		}
		return payload
	}

	// -- generateThumbnails -------------------------------------------------

	@PluginMethod
	fun generateThumbnails(call: PluginCall) {
		val handleObj = call.getObject("handle")
		val specObj = call.getObject("spec")
		if (handleObj == null || specObj == null) {
			call.reject("generateThumbnails requires {handle, spec}", "IO_ERROR")
			return
		}
		val assetId = handleObj.getString("id")
		val uriString = handleObj.getString("uri")
		if (assetId == null || uriString == null) {
			call.reject("handle.id and handle.uri are required", "IO_ERROR")
			return
		}
		val sourceFile = fileFromNativeUri(uriString)
		if (sourceFile == null) {
			call.reject("handle.uri must be a native file:// handle", "UNSUPPORTED")
			return
		}
		val durationMicros = handleObj.optLong("durationMicros", 0L)
		val count = specObj.optInt("count", 10)
		val maxEdgePx = specObj.optInt("maxEdgePx", 200)

		Thread {
			try {
				val thumbnails = ThumbnailStripGenerator.generate(
					context = context,
					assetId = assetId,
					file = sourceFile,
					durationMicros = durationMicros,
					count = count,
					maxEdgePx = maxEdgePx,
				)
				val uris = JSArray()
				val timestamps = JSArray()
				for (thumbnail in thumbnails) {
					uris.put(Uri.fromFile(File(thumbnail.filePath)).toString())
					timestamps.put(thumbnail.timestampMicros)
				}
				val result = JSObject()
				result.put("assetId", assetId)
				result.put("uris", uris)
				result.put("timestampsMicros", timestamps)
				call.resolve(result)
			} catch (e: Exception) {
				call.reject(e.message ?: "thumbnail generation failed", "IO_ERROR")
			}
		}.start()
	}

	// -- exportProject --------------------------------------------------------

	/**
	 * M9 (plan §M9, corpus `08` §8, `10` §2.1/§2.2): `edl` -> a Media3
	 * `Composition` (`EdlToComposition`) -> `Transformer.start`
	 * (`Media3Exporter`). Same "resolve on kickoff, stream the rest as
	 * events" shape as `generateProxy` above — see that method's doc
	 * comment — because `ExportProgress` (like `ProxyProgress`) is
	 * inherently a stream, not a single return value.
	 *
	 * The JS-side `Edl` object is already all-JSON-safe (plan §2.2: "nothing
	 * crosses the bridge except JSON control messages") and, unlike
	 * `MediaHandle`, is producer-generated and `validateEdl()`-checked
	 * before it ever reaches here — `EdlParser` still re-validates every
	 * field's shape (never trusts a cross-language JSON payload blindly),
	 * but there is no separate "wire type" the way `capacitor-bridge.ts`
	 * needed for `MediaHandle`.
	 */
	/**
	 * `exportId` (merge note, capacitor-bridge.ts): the unified JS<->native
	 * export contract routes every `exportProgress` event by the id the JS
	 * caller minted, because `capacitor-bridge.ts`'s generator filters on
	 * it. `Media3Exporter` is single-export-at-a-time by design (its own doc
	 * comment), so this class simply remembers the one live id and stamps it
	 * onto each event rather than keeping a map the way the iOS side's
	 * `activeExportHandles` does.
	 */
	@PluginMethod
	fun exportProject(call: PluginCall) {
		val exportId = call.getString("exportId")
		if (exportId == null) {
			call.reject("exportProject requires exportId", "IO_ERROR")
			return
		}
		val edlObj = call.getObject("edl")
		if (edlObj == null) {
			call.reject("exportProject requires {edl}", "IO_ERROR")
			return
		}
		val edl = try {
			EdlParser.parse(edlObj)
		} catch (e: EdlParseException) {
			call.reject(e.message ?: "invalid EDL", "IO_ERROR")
			return
		}

		val outputDir = File(context.noBackupFilesDir, "exports")
		if (!outputDir.exists()) outputDir.mkdirs()
		val extension = if (edl.output.container == "webm") "webm" else "mp4"
		val outputFile = File(outputDir, "export-${UUID.randomUUID()}.$extension")

		activeExportId = exportId

		val ack = JSObject()
		ack.put("started", true)
		ack.put("exportId", exportId)
		call.resolve(ack)

		// PRERENDERED OVERLAYS (round 37): full-frame text/caption images the
		// PREVIEW rendered with its own drawing code. Compositing these
		// removes `EdlTextOverlay` — a second, drifting implementation of the
		// editor's text rendering — from the export path. A frame that fails
		// to decode is skipped rather than failing the export.
		val overlayFrames = mutableListOf<PrerenderedOverlay.Frame>()
		call.getArray("overlayFrames")?.let { array ->
			for (index in 0 until array.length()) {
				val entry = array.optJSONObject(index) ?: continue
				val base64 = entry.optString("pngBase64", "")
				val startTicks = entry.optLong("startTicks", -1)
				val endTicks = entry.optLong("endTicks", -1)
				if (base64.isEmpty() || endTicks <= startTicks) continue
				val bytes = try {
					android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
				} catch (error: IllegalArgumentException) {
					null
				} ?: continue
				var bitmap = android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
					?: continue
				// Normalize to the export resolution. The preview renders its
				// overlay canvas at the device pixel ratio, so these PNGs
				// routinely arrive at 2x the project canvas, and media3 draws a
				// BitmapOverlay at the bitmap's OWN pixel size — which put
				// double-size, edge-cropped captions in the exported file even
				// though the frames themselves were pixel-correct.
				val targetWidth = edl.output.resolutionWidth
				val targetHeight = edl.output.resolutionHeight
				if (targetWidth > 0 && targetHeight > 0 &&
					(bitmap.width != targetWidth || bitmap.height != targetHeight)
				) {
					bitmap = android.graphics.Bitmap.createScaledBitmap(
						bitmap, targetWidth, targetHeight, /* filter= */ true,
					)
				}
				overlayFrames.add(
					PrerenderedOverlay.Frame(
						startUs = ticksToUs(startTicks, edl.meta.ticksPerSecond),
						endUs = ticksToUs(endTicks, edl.meta.ticksPerSecond),
						bitmap = bitmap,
					),
				)
			}
		}

		android.util.Log.i(
			"kneecap-export",
			"overlay frames decoded=${overlayFrames.size} " +
				"target=${edl.output.resolutionWidth}x${edl.output.resolutionHeight}",
		)

		Media3Exporter.start(
			context = context,
			edl = edl,
			outputFile = outputFile,
			overlayFrames = overlayFrames,
		) { event ->
			notifyListeners("exportProgress", exportEventToJson(exportId, event))
		}
	}

	/** Not part of the `NativeBridge` TS interface (that abstraction expresses
	 * cancellation as the JS caller simply stopping iteration of the
	 * `AsyncGenerator<ExportProgress>` `exportProject` returns) — this is the
	 * plugin-private method `capacitor-bridge.ts`'s generator adapter calls
	 * from its `finally` block so stopping iteration actually stops the
	 * native encoder too, not just the JS-side listener.
	 *
	 * Named `exportCancel` (not `cancelExport`) and taking an `exportId` to
	 * match the iOS plugin's method exactly — one wire contract, one TS call
	 * site. A mismatched id is a deliberate no-op rather than an error: the
	 * only way to get one is a cancel racing a just-finished export, which
	 * `Media3Exporter.cancel()` already treats as a no-op anyway. */
	@PluginMethod
	fun exportCancel(call: PluginCall) {
		val exportId = call.getString("exportId")
		if (exportId == null) {
			call.reject("exportCancel requires exportId", "IO_ERROR")
			return
		}
		if (activeExportId == null || activeExportId == exportId) {
			Media3Exporter.cancel()
			activeExportId = null
		}
		val ack = JSObject()
		ack.put("accepted", true)
		call.resolve(ack)
	}

	private fun exportEventToJson(exportId: String, event: Media3Exporter.Event): JSObject {
		val payload = JSObject()
		payload.put("exportId", exportId)
		when (event) {
			is Media3Exporter.Event.Progress -> {
				payload.put("stage", "encoding")
				payload.put("fraction", event.fraction.toDouble())
			}
			is Media3Exporter.Event.Done -> {
				payload.put("stage", "done")
				payload.put("fraction", 1.0)
				payload.put("outputUri", Uri.fromFile(event.outputFile).toString())
				// Terminal — a later `exportCancel` for this id must not tear
				// down whatever export started after it.
				if (activeExportId == exportId) activeExportId = null
			}
			is Media3Exporter.Event.Error -> {
				payload.put("stage", "error")
				payload.put("fraction", 1.0)
				payload.put("error", event.message)
				if (activeExportId == exportId) activeExportId = null
			}
		}
		return payload
	}

	// -- the export result block (1.0.5) -----------------------------------
	//
	// Blind test round 2: the export sheet now shows the real end of an
	// export. After "done" it calls `saveToPhotos` and shows "Saving to
	// Photos…" until it answers, then "Saved to Photos" with Open Photos and
	// Share, or "Could not save to Photos." with Share. Same wire contract as
	// iOS (NativeBridgePlugin+Export.swift): `{uri}` is the finished export's
	// raw path (or its `file://` URI).

	/** The Gallery item the last `saveToPhotos` made, for `openPhotos`.
	 *  Written on the save thread, read on the plugin thread. */
	@Volatile
	private var lastSavedVideoUri: Uri? = null

	/** Adds the finished export to the Gallery (MediaStore, Movies/publik
	 *  kneecap). minSdk is 29, so with scoped storage an app inserts its own
	 *  media with no permission at all — there is no "denied" answer on
	 *  Android, only `{saved: true}` or `{saved: false, reason: "failed"}`.
	 *  Resolves when the copy is complete. */
	@PluginMethod
	fun saveToPhotos(call: PluginCall) {
		val file = exportedFile(call, "saveToPhotos") ?: return
		Thread {
			val result = JSObject()
			try {
				lastSavedVideoUri = insertIntoGallery(file)
				result.put("saved", true)
			} catch (e: Exception) {
				android.util.Log.w("kneecap-export", "save to Gallery failed", e)
				result.put("saved", false)
				result.put("reason", "failed")
			}
			call.resolve(result)
		}.start()
	}

	private fun insertIntoGallery(file: File): Uri {
		val resolver = context.contentResolver
		val pending = ContentValues().apply {
			put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
			put(MediaStore.MediaColumns.MIME_TYPE, videoMimeType(file))
			put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_MOVIES}/publik kneecap")
			put(MediaStore.MediaColumns.IS_PENDING, 1)
		}
		val collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
		val item = resolver.insert(collection, pending)
			?: throw IOException("MediaStore did not create the video entry")
		try {
			val output = resolver.openOutputStream(item)
				?: throw IOException("MediaStore gave no output stream")
			output.use { out -> file.inputStream().use { input -> input.copyTo(out) } }
			val published = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
			resolver.update(item, published, null, null)
			return item
		} catch (e: Exception) {
			// No half-written entry left in the Gallery.
			resolver.delete(item, null, null)
			throw e
		}
	}

	/** Opens the system share sheet (ACTION_SEND) for the finished export.
	 *  FileProvider serves only the dirs in res/xml/file_paths.xml (the cache
	 *  dir, not no_backup/exports), so the share goes through a copy in
	 *  cache/shared-exports; copies of older exports are deleted first.
	 *  Resolves once the chooser has started. */
	@PluginMethod
	fun shareFile(call: PluginCall) {
		val file = exportedFile(call, "shareFile") ?: return
		Thread {
			try {
				val shareDir = File(context.cacheDir, "shared-exports").apply { mkdirs() }
				shareDir.listFiles()?.filter { it.name != file.name }?.forEach { it.delete() }
				val copy = File(shareDir, file.name)
				if (!copy.isFile || copy.length() != file.length()) {
					file.copyTo(copy, overwrite = true)
				}
				val shareUri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", copy)
				val send = Intent(Intent.ACTION_SEND).apply {
					type = videoMimeType(file)
					putExtra(Intent.EXTRA_STREAM, shareUri)
					clipData = ClipData.newRawUri("", shareUri)
					addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
				}
				startExternalActivity(call, Intent.createChooser(send, null), "no app can share this video")
			} catch (e: Exception) {
				call.reject("shareFile failed: ${e.message}", "IO_ERROR")
			}
		}.start()
	}

	/** Opens the saved video in the Gallery / Photos app (ACTION_VIEW on the
	 *  MediaStore item), or the Gallery app itself when nothing was saved in
	 *  this session. */
	@PluginMethod
	fun openPhotos(call: PluginCall) {
		val saved = lastSavedVideoUri
		val intent = if (saved != null) {
			Intent(Intent.ACTION_VIEW).apply {
				setDataAndType(saved, "video/*")
				addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
			}
		} else {
			Intent.makeMainSelectorActivity(Intent.ACTION_MAIN, Intent.CATEGORY_APP_GALLERY)
		}
		startExternalActivity(call, intent, "no Gallery or Photos app")
	}

	/** Starts `intent` on the UI thread and resolves the call, or rejects it
	 *  with UNSUPPORTED when no app handles the intent. */
	private fun startExternalActivity(call: PluginCall, intent: Intent, noAppMessage: String) {
		val host = activity
		if (host == null) {
			call.reject("no activity to start from", "IO_ERROR")
			return
		}
		host.runOnUiThread {
			try {
				host.startActivity(intent)
				val ack = JSObject()
				ack.put("shown", true)
				call.resolve(ack)
			} catch (e: ActivityNotFoundException) {
				call.reject(noAppMessage, "UNSUPPORTED")
			}
		}
	}

	private fun videoMimeType(file: File): String =
		if (file.extension.equals("webm", ignoreCase = true)) "video/webm" else "video/mp4"

	/** The finished export a result-block call names, or null after
	 *  rejecting the call. Takes a raw path or a `file://` URI, and ONLY a
	 *  file in no_backup/exports (where `exportProject` writes): these calls
	 *  exist for the video the export sheet just made, not for any path the
	 *  web view sends. */
	private fun exportedFile(call: PluginCall, method: String): File? {
		val raw = call.getString("uri")
		if (raw.isNullOrEmpty()) {
			call.reject("$method requires uri", "IO_ERROR")
			return null
		}
		val (file, exportsDir) = try {
			Pair(
				fileFromNativeUri(raw)?.canonicalFile,
				File(context.noBackupFilesDir, "exports").canonicalFile,
			)
		} catch (e: IOException) {
			call.reject("$method: ${e.message}", "IO_ERROR")
			return null
		}
		if (file == null || file.parentFile != exportsDir) {
			call.reject("$method only takes a finished export", "UNSUPPORTED")
			return null
		}
		if (!file.isFile) {
			call.reject("$method: the exported video is no longer on this device", "IO_ERROR")
			return null
		}
		return file
	}

	// -- transcribe (M10) ---------------------------------------------------

	/**
	 * kneecap M10. Ported from the captions track's `NativeBridgePlugin.java`
	 * when that file was superseded by this Kotlin one (the M4 Java->Kotlin
	 * port and the M10 STT work happened on separate tracks and met at the
	 * merge) — same behavior, same `WhisperTranscriber` call, same error
	 * codes.
	 *
	 * Real plumbing, honestly incomplete native depth — see
	 * `dev.kneecap.app.stt.WhisperTranscriber`'s class doc comment for
	 * exactly what is and isn't wired yet. Runs off the main thread: even
	 * once the two gaps documented there are closed, `whisper_full()` is a
	 * synchronous, CPU-bound native call that must never block Capacitor's
	 * (UI-thread-adjacent) plugin call dispatch — plan M10 item 7, "Async
	 * job with progress. Never block the UI."
	 */
	@PluginMethod
	fun transcribe(call: PluginCall) {
		val audioUri = call.getString("audioUri")
		if (audioUri == null) {
			call.reject("audioUri is required", "IO_ERROR")
			return
		}
		val modelSize = call.getString("modelSize", "tiny") ?: "tiny"
		val languageHint = call.getString("languageHint")

		Thread {
			try {
				val result = WhisperTranscriber.transcribe(context, audioUri, modelSize, languageHint)
				call.resolve(result)
			} catch (e: WhisperTranscriber.NotYetWiredException) {
				call.reject(e.message, "NOT_IMPLEMENTED")
			} catch (e: Exception) {
				call.reject("transcribe failed: ${e.message}", "IO_ERROR", e)
			}
		}.start()
	}

	// -- shared -----------------------------------------------------------

	/** Every `MediaHandle.uri` this plugin ever hands to JS is a
	 * `Uri.fromFile(...)`-shaped `file://` path into app-private storage
	 * (see `mediaHandleToJson`) — so this is the one place that contract is
	 * decoded back into a `File` for a follow-up call (`generateProxy`/
	 * `generateThumbnails`). Any other scheme is rejected as `UNSUPPORTED`
	 * rather than guessed at. */
	/** `handle.uri` reaches native in TWO shapes and both are legitimate: this
	 *  plugin's own `pickMedia` emits `Uri.fromFile(...)` (`file:///data/...`),
	 *  while iOS emits — and the JS contract documents (types.ts) — a RAW
	 *  absolute path with no scheme, which is what iOS's
	 *  `URL(fileURLWithPath:)` consumes. Accepting only the scheme'd form made
	 *  every raw-path handle fail `generateProxy`/`generateThumbnails` with
	 *  UNSUPPORTED (caught on the emulator: video import died while image and
	 *  audio, which skip this path, sailed through). */
	private fun fileFromNativeUri(uriString: String): File? {
		if (uriString.startsWith("/")) return File(uriString)
		val uri = Uri.parse(uriString)
		if (uri.scheme != "file") return null
		val path = uri.path ?: return null
		return File(path)
	}
}
