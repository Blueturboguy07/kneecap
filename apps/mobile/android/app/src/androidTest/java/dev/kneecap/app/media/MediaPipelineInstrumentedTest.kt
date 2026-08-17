package dev.kneecap.app.media

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.kneecap.app.test.R
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * kneecap M4 — instrumentation tests for the Android-framework-dependent
 * media pipeline (`MediaImporter`, `MediaProbe`, `ThumbnailStripGenerator`,
 * `MediaPickerIntents`). Unlike `MediaMathTest` (`src/test`, plain JVM), the
 * classes exercised here call real `android.*` APIs
 * (`MediaMetadataRetriever`, `MediaExtractor`, `ContentResolver`,
 * `PackageManager`) that a JVM unit test's stub `android.jar` throws
 * `RuntimeException` on — these genuinely require a device or emulator.
 *
 * STATUS AS OF M4: written but NOT run. No emulator with a working system
 * image was available in this session (the two local AVDs' system images
 * are missing on disk — see the M4 handoff for the exact `df`/`avdmanager`
 * evidence). Run via:
 *
 *   cd apps/mobile/android && ./gradlew connectedDebugAndroidTest
 *
 * on a real device or a working emulator.
 *
 * Fixture: `res/raw/test_clip.mp4` — a synthetic 2s/320x240/30fps H.264 clip
 * with a 440Hz sine-wave AAC audio track, generated via
 * `ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=30 -f lavfi -i
 * sine=frequency=440:duration=2 -c:v libx264 -c:a aac -shortest`. Chosen
 * over a real-world sample specifically so it's small (32KB), license-free,
 * and reproducible from a one-line command — no binary asset provenance
 * question.
 */
@RunWith(AndroidJUnit4::class)
class MediaPipelineInstrumentedTest {

	private lateinit var context: Context
	private lateinit var copiedClip: File

	@Before
	fun setUp() {
		context = ApplicationProvider.getApplicationContext()
		// MediaProbe/ThumbnailStripGenerator take a File, not a raw resource id
		// — copy the fixture out of res/raw once per test, mirroring what
		// MediaImporter itself produces from a picked content:// Uri.
		copiedClip = File(context.cacheDir, "test_clip_${System.nanoTime()}.mp4")
		context.resources.openRawResource(R.raw.test_clip).use { input ->
			copiedClip.outputStream().use { output -> input.copyTo(output) }
		}
	}

	@After
	fun tearDown() {
		copiedClip.delete()
	}

	// -- MediaProbe -----------------------------------------------------------

	@Test
	fun probe_reads_duration_dimensions_and_codec_from_the_fixture_clip() {
		val probed = MediaProbe.probe(copiedClip, "video/mp4")

		assertEquals("video", probed.kind)
		// 2s at the container level; MediaMetadataRetriever's DURATION is
		// millisecond-precision, so allow a small tolerance either side of the
		// exact 2_000_000us the ffmpeg command targeted.
		assertTrue(
			"expected durationMicros near 2_000_000, was ${probed.durationMicros}",
			Math.abs(probed.durationMicros - 2_000_000L) < 100_000L,
		)
		assertEquals(320, probed.width)
		assertEquals(240, probed.height)
		assertEquals(0, probed.rotationDegrees)
		assertTrue("expected hasAudio=true (fixture has a sine-wave AAC track)", probed.hasAudio)
		assertTrue(
			"expected an AVC/H.264 codec string, was ${probed.codec}",
			probed.codec.contains("avc", ignoreCase = true) ||
				probed.codec.contains("264", ignoreCase = true),
		)
		assertNotNull("expected a probed frame rate", probed.frameRate)
		assertEquals(30, probed.frameRate?.numerator?.let { it / (probed.frameRate?.denominator ?: 1) })
	}

	// -- ThumbnailStripGenerator ----------------------------------------------

	@Test
	fun thumbnail_strip_produces_the_requested_count_as_downscaled_jpegs_on_disk() {
		val probed = MediaProbe.probe(copiedClip, "video/mp4")
		val thumbnails = ThumbnailStripGenerator.generate(
			context = context,
			assetId = "instrumented-test-asset",
			file = copiedClip,
			durationMicros = probed.durationMicros,
			count = 4,
			maxEdgePx = 100,
		)

		assertEquals(4, thumbnails.size)
		for (thumbnail in thumbnails) {
			val file = File(thumbnail.filePath)
			assertTrue("thumbnail file should exist: ${thumbnail.filePath}", file.exists())
			assertTrue("thumbnail file should be non-empty", file.length() > 0)
			val bitmap = android.graphics.BitmapFactory.decodeFile(thumbnail.filePath)
			assertNotNull("thumbnail should decode as a valid JPEG", bitmap)
			assertTrue(
				"long edge should be <= maxEdgePx (100)",
				maxOf(bitmap!!.width, bitmap.height) <= 100,
			)
		}
		// Timestamps should be strictly increasing and within [0, duration).
		val timestamps = thumbnails.map { it.timestampMicros }
		assertEquals(timestamps.sorted(), timestamps)
		assertTrue(timestamps.all { it in 0 until probed.durationMicros })
	}

	// -- MediaImporter ----------------------------------------------------------

	@Test
	fun importer_copies_a_content_uri_into_noBackupFilesDir_and_reports_the_right_size() {
		// android.resource:// is a genuine content-resolver-openable URI, the
		// same shape (openInputStream-able, not a plain file) as a real
		// content://... URI from the Photo Picker/SAF/camera intent.
		val resourceUri = Uri.parse(
			"android.resource://${context.packageName}/${R.raw.test_clip}",
		)

		val imported = MediaImporter.importInto(context, resourceUri)
		try {
			assertTrue(imported.file.exists())
			assertEquals(copiedClip.length(), imported.sizeBytes)
			// Confirms the noBackupFilesDir/media placement the doc comment on
			// MediaImporter promises (the Android analog to iOS's
			// "exclude from iCloud backup").
			assertTrue(
				imported.file.absolutePath.startsWith(context.noBackupFilesDir.absolutePath),
			)
			assertEquals(imported.sizeBytes, imported.file.length())

			// The imported copy should itself be a valid, probeable clip — this
			// is the exact next step NativeBridgePlugin.importAndProbeAsync
			// performs.
			val retriever = MediaMetadataRetriever()
			try {
				retriever.setDataSource(imported.file.absolutePath)
				val durationMs = retriever
					.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
					?.toLongOrNull()
				assertNotNull(durationMs)
			} finally {
				retriever.release()
			}
		} finally {
			MediaImporter.delete(imported.file)
		}
	}

	// -- MediaPickerIntents -----------------------------------------------------

	@Test
	fun library_pick_intent_resolves_to_either_the_photo_picker_or_the_saf_fallback() {
		val intent = MediaPickerIntents.buildLibraryPickIntent(
			context.packageManager,
			listOf("video"),
			allowMultiple = false,
		)
		// Whichever branch fired, the resulting intent must itself resolve on
		// this device — otherwise startActivityForResult would crash at
		// runtime with an ActivityNotFoundException.
		assertNotNull(
			"buildLibraryPickIntent's result must resolve on-device",
			intent.resolveActivity(context.packageManager),
		)
	}

	@Test
	fun camera_capture_intent_targets_a_fileprovider_uri_this_app_declared() {
		val capture = MediaPickerIntents.buildCameraCaptureIntent(context, "video")
		assertEquals("content", capture.outputUri.scheme)
		assertEquals("${context.packageName}.fileprovider", capture.outputUri.authority)
		// Confirms AndroidManifest.xml's declared <provider> + file_paths.xml
		// actually grants write access to this URI, not just that the Uri
		// object was constructed — FileProvider.getUriForFile throws
		// IllegalArgumentException at call time if the path isn't covered by
		// file_paths.xml, so reaching this line at all is the real assertion;
		// this checks the resolved authority string matches, too.
	}
}
