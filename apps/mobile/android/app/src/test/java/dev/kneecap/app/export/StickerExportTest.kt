package dev.kneecap.app.export

import dev.kneecap.app.edl.EdlClip
import dev.kneecap.app.edl.EdlRational
import dev.kneecap.app.edl.EdlTransform
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 1.0.7 (blind test round 3): stickers were in no frame of an exported
 * video. On Android a sticker clip also made the export fail, because the
 * picture-in-picture loop asked it for a media asset. Plain JVM test.
 */
class StickerExportTest {
    private fun clip(kind: String) = EdlClip(
        clipId = "c-$kind",
        kind = kind,
        assetId = if (kind == "video" || kind == "image") "asset-1" else null,
        name = kind,
        startTicks = 0L,
        durationTicks = 120_000L,
        sourceStartTicks = 0L,
        sourceEndTicks = 120_000L,
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

    @Test
    fun stickerAndGraphicClipsAreNotPictureInPictureMedia() {
        assertFalse(OverlayClips.isPipMediaClip(clip("sticker")))
        assertFalse(OverlayClips.isPipMediaClip(clip("graphic")))
        assertFalse(OverlayClips.isPipMediaClip(clip("text")))
        assertFalse(OverlayClips.isPipMediaClip(clip("caption")))
    }

    @Test
    fun videoAndImageClipsArePictureInPictureMedia() {
        assertTrue(OverlayClips.isPipMediaClip(clip("video")))
        assertTrue(OverlayClips.isPipMediaClip(clip("image")))
    }

    @Test
    fun shareFileNameIsReadableAndSafe() {
        assertEquals("publik kneecap My trip.mp4", ShareFileName.safe("publik kneecap My trip.mp4", "mp4"))
        assertEquals("publik kneecap Été 2026.mp4", ShareFileName.safe("publik kneecap Été/2026:*?", "mp4"))
        assertEquals("a b c.webm", ShareFileName.safe("a<b>|c", "webm"))
        assertNull(ShareFileName.safe(null, "mp4"))
        assertNull(ShareFileName.safe("  /:*  ", "mp4"))
        assertEquals(80 + ".mp4".length, ShareFileName.safe("x".repeat(200), "mp4")!!.length)
    }
}
