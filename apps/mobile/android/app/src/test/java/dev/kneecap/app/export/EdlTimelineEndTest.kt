package dev.kneecap.app.export

import dev.kneecap.app.edl.Edl
import dev.kneecap.app.edl.EdlClip
import dev.kneecap.app.edl.EdlMeta
import dev.kneecap.app.edl.EdlOutput
import dev.kneecap.app.edl.EdlOverlay
import dev.kneecap.app.edl.EdlOverlayKind
import dev.kneecap.app.edl.EdlRational
import dev.kneecap.app.edl.EdlTrack
import dev.kneecap.app.edl.EdlTrackKind
import dev.kneecap.app.edl.EdlTrackType
import dev.kneecap.app.edl.EdlTransform
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * `timelineEndTicks` — where the exported video ends (blind test round 2,
 * 1.0.5: a title that ran past the last video clip was cut off on iOS).
 * Plain JVM test, no Android framework: it builds the `Edl` data classes
 * directly.
 */
class EdlTimelineEndTest {
    private val tps = 120_000L

    private fun seconds(s: Double): Long = Math.round(s * tps)

    private fun clip(id: String, kind: String, start: Long, duration: Long) = EdlClip(
        clipId = id,
        kind = kind,
        assetId = if (kind == "video" || kind == "image") "asset-1" else null,
        name = id,
        startTicks = start,
        durationTicks = duration,
        sourceStartTicks = 0L,
        sourceEndTicks = duration,
        speed = EdlRational(1L, 1L),
        maintainPitch = false,
        volumeDb = 0.0,
        muted = false,
        hidden = false,
        transform = EdlTransform(0.0, 0.0, 1.0, 1.0, 0.0),
        opacity = 1.0,
        effects = emptyList(),
        hasMasks = false,
        animations = emptyList(),
        params = emptyMap(),
    )

    private fun track(id: String, kind: EdlTrackKind, type: EdlTrackType, clips: List<EdlClip>) = EdlTrack(
        trackId = id,
        kind = kind,
        trackType = type,
        name = id,
        zIndex = null,
        muted = false,
        hidden = false,
        clips = clips,
    )

    private fun edl(metaDuration: Long, tracks: List<EdlTrack>, overlays: List<EdlOverlay> = emptyList()) = Edl(
        meta = EdlMeta(
            edlVersion = 1,
            generator = "kneecap-test",
            ticksPerSecond = tps,
            frameRate = EdlRational(30L, 1L),
            canvasWidth = 1080,
            canvasHeight = 1920,
            projectId = "proj-1",
            projectName = "Test",
            sceneId = "scene-1",
            sceneName = "Scene 1",
            durationTicks = metaDuration,
        ),
        assets = emptyList(),
        tracks = tracks,
        transitions = emptyList(),
        overlays = overlays,
        output = EdlOutput(
            container = "mp4",
            videoCodec = "avc1",
            audioCodec = "mp4a",
            bitrate = 8_000_000,
            fps = EdlRational(30L, 1L),
            resolutionWidth = 1080,
            resolutionHeight = 1920,
            includeAudio = true,
        ),
    )

    private val mainThreeSeconds = track(
        "track-main", EdlTrackKind.MAIN, EdlTrackType.VIDEO,
        listOf(clip("clip-a", "video", 0L, seconds(3.0))),
    )

    @Test
    fun `a text clip that outlives the last video clip sets the end`() {
        val text = track(
            "track-text", EdlTrackKind.OVERLAY, EdlTrackType.TEXT,
            listOf(clip("clip-title", "text", seconds(0.5), seconds(4.5))),
        )
        // A stale meta value (3 s) must not cut the 5 s title short.
        assertEquals(seconds(5.0), timelineEndTicks(edl(seconds(3.0), listOf(mainThreeSeconds, text))))
    }

    @Test
    fun `an overlay entry that ends later than every clip sets the end`() {
        val overlay = EdlOverlay(
            overlayId = "o-1",
            kind = EdlOverlayKind.STICKER,
            trackId = "track-sticker",
            clipId = "clip-sticker",
            zIndex = 0,
            startTicks = seconds(2.0),
            durationTicks = seconds(4.0),
        )
        assertEquals(seconds(6.0), timelineEndTicks(edl(0L, listOf(mainThreeSeconds), listOf(overlay))))
    }

    @Test
    fun `a project with only text ends where the text ends`() {
        val text = track(
            "track-text", EdlTrackKind.OVERLAY, EdlTrackType.TEXT,
            listOf(clip("clip-title", "text", 0L, seconds(2.5))),
        )
        assertEquals(seconds(2.5), timelineEndTicks(edl(0L, listOf(text))))
    }

    @Test
    fun `meta duration still wins when it is the latest end`() {
        assertEquals(seconds(4.0), timelineEndTicks(edl(seconds(4.0), listOf(mainThreeSeconds))))
    }

    @Test
    fun `zero-length clips add nothing`() {
        val empty = track(
            "track-text", EdlTrackKind.OVERLAY, EdlTrackType.TEXT,
            listOf(clip("clip-empty", "text", seconds(9.0), 0L)),
        )
        assertEquals(seconds(3.0), timelineEndTicks(edl(0L, listOf(mainThreeSeconds, empty))))
    }
}
