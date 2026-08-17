package dev.kneecap.app.media

/**
 * kneecap M4 — pure, Android-framework-free helpers for the native media
 * pipeline (plan M4; corpus 08 §6/§8). Deliberately isolated from
 * `android.*` imports so they run under a plain JVM unit test
 * (`./gradlew testDebugUnitTest`) with no emulator/Robolectric — unlike the
 * rest of `media/`, which touches `MediaMetadataRetriever`, `Intent`,
 * `ContentResolver`, etc. and can only be exercised via instrumentation
 * tests (`src/androidTest`) on a real device/emulator.
 */

/** Mirrors `EdlRational` in `packages/editor-core/src/edl/types.ts`
 * (`numerator`/`denominator`, both integers) — the shape a probed
 * `MediaHandle.frameRate` must serialize as. This is a NATIVE-side
 * `MediaHandle` concept (see `packages/native-bridge/src/types.ts`'s doc
 * comment: a native probe reports plain integers, never editor-core ticks),
 * but the two-integer rational discipline is shared. */
data class Rational(val numerator: Int, val denominator: Int)

/**
 * Android's `MediaMetadataRetriever`/`MediaFormat` report rotation as one of
 * {0, 90, 180, 270}, but device/container quirks occasionally surface other
 * values (negative, 360, or a raw degrees value that isn't a multiple of
 * 90). Normalize defensively so `MediaHandle.rotationDegrees` — typed as the
 * literal union `0 | 90 | 180 | 270` on the TS side — is never violated by a
 * native payload.
 */
fun normalizeRotationDegrees(raw: Int): Int {
	val mod = ((raw % 360) + 360) % 360
	// Round to the nearest multiple of 90 rather than silently truncating, so
	// an off-by-a-few-degrees container quirk still lands on a valid value
	// instead of always rounding down to the wrong quadrant.
	val rounded = (Math.round(mod / 90.0) * 90).toInt() % 360
	return rounded
}

/**
 * A short table of exact NTSC/film rationals, checked first because a naive
 * `round(fps * 1000)/1000` on a retriever-reported `29.97` or `23.976`
 * (themselves already float-rounded by the OS) can drift off the *exact*
 * broadcast rational (30000/1001, 24000/1001) by enough to matter once this
 * value crosses the EDL bridge as a rational frame rate (plan §2.2). Falls
 * back to a fixed-precision `fpsMilli/1000` rational for anything else.
 */
private val KNOWN_RATIONALS: List<Pair<Float, Rational>> = listOf(
	23.976f to Rational(24000, 1001),
	24f to Rational(24, 1),
	25f to Rational(25, 1),
	29.97f to Rational(30000, 1001),
	30f to Rational(30, 1),
	50f to Rational(50, 1),
	59.94f to Rational(60000, 1001),
	60f to Rational(60, 1),
)

private const val KNOWN_RATIONAL_TOLERANCE = 0.02f

fun frameRateToRational(fps: Float): Rational? {
	if (!fps.isFinite() || fps <= 0f) return null
	for ((known, rational) in KNOWN_RATIONALS) {
		if (Math.abs(fps - known) < KNOWN_RATIONAL_TOLERANCE) return rational
	}
	return Rational(Math.round(fps * 1000), 1000)
}

/**
 * Plan Amendment 4 / M4 item 4: "short-GOP/near-all-intra structure for
 * scrub-friendly random access." `shortGop=true` asks for a keyframe roughly
 * every second (still real inter-frame compression, unlike literal
 * all-intra, but short enough that a seek is at most ~1s of decode from the
 * nearest keyframe); `false` keeps the encoder's normal GOP for cases where
 * proxy generation is used for something other than scrub-latency-critical
 * preview.
 */
fun iFrameIntervalSecondsFor(shortGop: Boolean): Float = if (shortGop) 1.0f else 2.0f

/** `PickMediaOptions.kinds` (`"video" | "audio" | "image"`) -> the MIME
 * prefixes used to build both the Photo Picker's `EXTRA_MIME_TYPE`/
 * `ACTION_PICK_IMAGES` filter and the SAF `ACTION_OPEN_DOCUMENT` fallback's
 * `EXTRA_MIME_TYPES`. */
fun mimeTypesFor(kinds: List<String>): Array<String> {
	val prefixes = kinds.mapNotNull {
		when (it) {
			"video" -> "video/*"
			"audio" -> "audio/*"
			"image" -> "image/*"
			else -> null
		}
	}
	return if (prefixes.isEmpty()) arrayOf("*/*") else prefixes.distinct().toTypedArray()
}

/** The inverse mapping, used when probing a returned URI to fill in
 * `MediaHandle.kind` from its resolved MIME type. */
fun inferKindFromMime(mime: String?): String = when {
	mime == null -> "video"
	mime.startsWith("video/") -> "video"
	mime.startsWith("audio/") -> "audio"
	mime.startsWith("image/") -> "image"
	else -> "video"
}
