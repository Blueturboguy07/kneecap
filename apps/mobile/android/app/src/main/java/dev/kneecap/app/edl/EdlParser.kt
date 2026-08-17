package dev.kneecap.app.edl

import org.json.JSONArray
import org.json.JSONObject

/**
 * `Edl` JSON -> Kotlin, for `NativeBridgePlugin.exportProject`. Deliberately
 * pure `org.json` + plain Kotlin — no Android framework types touched here,
 * so `EdlParserTest` runs as a plain JVM unit test (see
 * `app/src/test/java/.../edl/EdlParserTest.kt`), same posture as M4's
 * `MediaMathTest`.
 *
 * Every `*Ticks` field is read with `getLong`, never `getDouble` — plan
 * §2.2/§2.3 rule 1 ("no floats cross the bridge") is a parse-time invariant
 * here, not just a TS-side convention. A malformed EDL (wrong type, missing
 * field) throws `EdlParseException` with a field path in the message rather
 * than a bare `JSONException`, so a bad export request fails loud and
 * specific instead of a generic native-side crash.
 */
class EdlParseException(message: String) : Exception(message)

object EdlParser {
    fun parse(root: JSONObject): Edl {
        return try {
            parseUnsafe(root)
        } catch (e: EdlParseException) {
            throw e
        } catch (e: Exception) {
            throw EdlParseException("EDL parse failed: ${e.message}")
        }
    }

    private fun parseUnsafe(root: JSONObject): Edl {
        val meta = parseMeta(root.getJSONObject("meta"))
        val assets = root.getJSONArray("assets").map(::parseAsset)
        val tracks = root.getJSONArray("tracks").map(::parseTrack)
        val transitions = root.getJSONArray("transitions").map(::parseTransition)
        val overlays = root.getJSONArray("overlays").map(::parseOverlay)
        val output = parseOutput(root.getJSONObject("output"))
        return Edl(meta, assets, tracks, transitions, overlays, output)
    }

    private fun parseMeta(o: JSONObject): EdlMeta {
        val canvas = o.getJSONObject("canvas")
        return EdlMeta(
            edlVersion = o.getInt("edlVersion"),
            generator = o.getString("generator"),
            ticksPerSecond = o.getLong("ticksPerSecond"),
            frameRate = parseRational(o.getJSONObject("frameRate")),
            canvasWidth = canvas.getInt("width"),
            canvasHeight = canvas.getInt("height"),
            projectId = o.getString("projectId"),
            projectName = o.getString("projectName"),
            sceneId = o.getString("sceneId"),
            sceneName = o.getString("sceneName"),
            durationTicks = o.getLong("durationTicks"),
        )
    }

    private fun parseRational(o: JSONObject): EdlRational =
        EdlRational(o.getLong("numerator"), o.getLong("denominator"))

    private fun parseAsset(o: JSONObject): EdlAsset =
        EdlAsset(
            assetId = o.getString("assetId"),
            kind = parseAssetKind(o.getString("kind")),
            name = o.getString("name"),
            sourceUri = o.optStringOrNull("sourceUri"),
            codec = o.optStringOrNull("codec"),
            width = o.optIntOrNull("width"),
            height = o.optIntOrNull("height"),
            durationTicks = o.optLongOrNull("durationTicks"),
            rotationDegrees = o.getInt("rotationDegrees"),
            hasAudio = o.getBoolean("hasAudio"),
        )

    private fun parseAssetKind(raw: String): EdlAssetKind = when (raw) {
        "video" -> EdlAssetKind.VIDEO
        "image" -> EdlAssetKind.IMAGE
        "audio" -> EdlAssetKind.AUDIO
        else -> throw EdlParseException("unknown asset kind '$raw'")
    }

    private fun parseTrack(o: JSONObject): EdlTrack =
        EdlTrack(
            trackId = o.getString("trackId"),
            kind = parseTrackKind(o.getString("kind")),
            trackType = parseTrackType(o.getString("trackType")),
            name = o.getString("name"),
            zIndex = o.optIntOrNull("zIndex"),
            muted = o.getBoolean("muted"),
            hidden = o.getBoolean("hidden"),
            clips = o.getJSONArray("clips").map(::parseClip),
        )

    private fun parseTrackKind(raw: String): EdlTrackKind = when (raw) {
        "main" -> EdlTrackKind.MAIN
        "overlay" -> EdlTrackKind.OVERLAY
        "audio" -> EdlTrackKind.AUDIO
        else -> throw EdlParseException("unknown track kind '$raw'")
    }

    private fun parseTrackType(raw: String): EdlTrackType = when (raw) {
        "video" -> EdlTrackType.VIDEO
        "text" -> EdlTrackType.TEXT
        "audio" -> EdlTrackType.AUDIO
        "graphic" -> EdlTrackType.GRAPHIC
        "effect" -> EdlTrackType.EFFECT
        else -> throw EdlParseException("unknown track type '$raw'")
    }

    private fun parseClip(o: JSONObject): EdlClip {
        val transformObj = o.getJSONObject("transform")
        val masks = o.optJSONArray("masks")
        val animations = o.optJSONArray("animations")
        return EdlClip(
            clipId = o.getString("clipId"),
            kind = o.getString("kind"),
            assetId = o.optStringOrNull("assetId"),
            name = o.getString("name"),
            startTicks = o.getLong("startTicks"),
            durationTicks = o.getLong("durationTicks"),
            sourceStartTicks = o.getLong("sourceStartTicks"),
            sourceEndTicks = o.getLong("sourceEndTicks"),
            speed = parseRational(o.getJSONObject("speed")),
            maintainPitch = o.getBoolean("maintainPitch"),
            volumeDb = o.getDouble("volumeDb"),
            muted = o.getBoolean("muted"),
            hidden = o.getBoolean("hidden"),
            transform = EdlTransform(
                positionX = transformObj.getDouble("positionX"),
                positionY = transformObj.getDouble("positionY"),
                scaleX = transformObj.getDouble("scaleX"),
                scaleY = transformObj.getDouble("scaleY"),
                rotateDegrees = transformObj.getDouble("rotateDegrees"),
            ),
            opacity = o.getDouble("opacity"),
            effects = (o.optJSONArray("effects") ?: JSONArray()).map(::parseEffect),
            hasMasks = masks != null && masks.length() > 0,
            hasAnimations = animations != null && animations.length() > 0,
            params = jsonObjectToMap(o.optJSONObject("params") ?: JSONObject()),
        )
    }

    private fun parseEffect(o: JSONObject): EdlEffect =
        EdlEffect(
            effectId = o.getString("effectId"),
            type = o.getString("type"),
            enabled = o.getBoolean("enabled"),
            params = jsonObjectToMap(o.optJSONObject("params") ?: JSONObject()),
        )

    private fun parseTransition(o: JSONObject): EdlTransition =
        EdlTransition(
            transitionId = o.getString("transitionId"),
            afterClipId = o.getString("afterClipId"),
            kind = o.getString("kind"),
            durationTicks = o.getLong("durationTicks"),
        )

    private fun parseOverlay(o: JSONObject): EdlOverlay =
        EdlOverlay(
            overlayId = o.getString("overlayId"),
            kind = parseOverlayKind(o.getString("kind")),
            trackId = o.getString("trackId"),
            clipId = o.getString("clipId"),
            zIndex = o.getInt("zIndex"),
            startTicks = o.getLong("startTicks"),
            durationTicks = o.getLong("durationTicks"),
        )

    private fun parseOverlayKind(raw: String): EdlOverlayKind = when (raw) {
        "text" -> EdlOverlayKind.TEXT
        "sticker" -> EdlOverlayKind.STICKER
        "graphic" -> EdlOverlayKind.GRAPHIC
        "caption" -> EdlOverlayKind.CAPTION
        else -> throw EdlParseException("unknown overlay kind '$raw'")
    }

    private fun parseOutput(o: JSONObject): EdlOutput =
        EdlOutput(
            container = o.getString("container"),
            videoCodec = o.getString("videoCodec"),
            audioCodec = o.getString("audioCodec"),
            bitrate = o.getInt("bitrate"),
            fps = parseRational(o.getJSONObject("fps")),
            resolutionWidth = o.getJSONObject("resolution").getInt("width"),
            resolutionHeight = o.getJSONObject("resolution").getInt("height"),
            includeAudio = o.getBoolean("includeAudio"),
        )

    private fun jsonObjectToMap(o: JSONObject): Map<String, Any?> {
        val map = LinkedHashMap<String, Any?>()
        val keys = o.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            map[key] = if (o.isNull(key)) null else o.get(key)
        }
        return map
    }

    private fun <T> JSONArray.map(transform: (JSONObject) -> T): List<T> =
        (0 until length()).map { transform(getJSONObject(it)) }

    private fun JSONObject.optStringOrNull(key: String): String? =
        if (has(key) && !isNull(key)) getString(key) else null

    private fun JSONObject.optIntOrNull(key: String): Int? =
        if (has(key) && !isNull(key)) getInt(key) else null

    private fun JSONObject.optLongOrNull(key: String): Long? =
        if (has(key) && !isNull(key)) getLong(key) else null
}
