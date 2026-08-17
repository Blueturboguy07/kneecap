package dev.kneecap.app.media

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * kneecap M4 — plain JVM unit tests (no Robolectric, no emulator) for the
 * android-framework-free helpers in `MediaMath.kt`. Run via
 * `./gradlew testDebugUnitTest`.
 */
class MediaMathTest {

	// -- normalizeRotationDegrees -----------------------------------------

	@Test
	fun `normalizeRotationDegrees passes through the four valid values`() {
		assertEquals(0, normalizeRotationDegrees(0))
		assertEquals(90, normalizeRotationDegrees(90))
		assertEquals(180, normalizeRotationDegrees(180))
		assertEquals(270, normalizeRotationDegrees(270))
	}

	@Test
	fun `normalizeRotationDegrees wraps 360 and negative values`() {
		assertEquals(0, normalizeRotationDegrees(360))
		assertEquals(270, normalizeRotationDegrees(-90))
		assertEquals(90, normalizeRotationDegrees(450))
	}

	@Test
	fun `normalizeRotationDegrees rounds an off-quadrant quirk to the nearest 90`() {
		assertEquals(90, normalizeRotationDegrees(95))
		assertEquals(0, normalizeRotationDegrees(5))
		assertEquals(0, normalizeRotationDegrees(-5))
	}

	// -- frameRateToRational -------------------------------------------------

	@Test
	fun `frameRateToRational snaps known NTSC rates to exact rationals`() {
		assertEquals(Rational(30000, 1001), frameRateToRational(29.97f))
		assertEquals(Rational(24000, 1001), frameRateToRational(23.976f))
		assertEquals(Rational(60000, 1001), frameRateToRational(59.94f))
	}

	@Test
	fun `frameRateToRational snaps known whole rates exactly`() {
		assertEquals(Rational(30, 1), frameRateToRational(30f))
		assertEquals(Rational(24, 1), frameRateToRational(24f))
		assertEquals(Rational(25, 1), frameRateToRational(25f))
	}

	@Test
	fun `frameRateToRational falls back to a fixed-precision rational for unknown rates`() {
		assertEquals(Rational(48000, 1000), frameRateToRational(48f))
		assertEquals(Rational(15000, 1000), frameRateToRational(15f))
	}

	@Test
	fun `frameRateToRational rejects non-finite or non-positive input`() {
		assertNull(frameRateToRational(0f))
		assertNull(frameRateToRational(-1f))
		assertNull(frameRateToRational(Float.NaN))
		assertNull(frameRateToRational(Float.POSITIVE_INFINITY))
	}

	// -- iFrameIntervalSecondsFor ---------------------------------------------

	@Test
	fun `iFrameIntervalSecondsFor is short for shortGop and longer otherwise`() {
		val short = iFrameIntervalSecondsFor(true)
		val normal = iFrameIntervalSecondsFor(false)
		assertEquals(1.0f, short)
		assertEquals(2.0f, normal)
		assert(short < normal)
	}

	// -- mimeTypesFor / inferKindFromMime -------------------------------------

	@Test
	fun `mimeTypesFor maps each kind to its wildcard mime prefix`() {
		assertArrayEquals(arrayOf("video/*"), mimeTypesFor(listOf("video")))
		assertArrayEquals(
			arrayOf("video/*", "image/*"),
			mimeTypesFor(listOf("video", "image")),
		)
	}

	@Test
	fun `mimeTypesFor de-duplicates and falls back to a wildcard for unknown kinds`() {
		assertArrayEquals(
			arrayOf("video/*"),
			mimeTypesFor(listOf("video", "video")),
		)
		assertArrayEquals(arrayOf("*/*"), mimeTypesFor(emptyList()))
		assertArrayEquals(arrayOf("*/*"), mimeTypesFor(listOf("nonsense")))
	}

	@Test
	fun `inferKindFromMime round-trips the three MediaKind prefixes`() {
		assertEquals("video", inferKindFromMime("video/mp4"))
		assertEquals("audio", inferKindFromMime("audio/mpeg"))
		assertEquals("image", inferKindFromMime("image/jpeg"))
	}

	@Test
	fun `inferKindFromMime defaults to video for null or unrecognized mime`() {
		assertEquals("video", inferKindFromMime(null))
		assertEquals("video", inferKindFromMime("application/octet-stream"))
	}
}
