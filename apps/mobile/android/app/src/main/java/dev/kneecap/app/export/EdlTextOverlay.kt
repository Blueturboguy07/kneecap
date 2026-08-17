package dev.kneecap.app.export

import android.graphics.Color
import android.text.SpannableString
import android.text.Spanned
import android.text.style.AbsoluteSizeSpan
import android.text.style.ForegroundColorSpan
import androidx.media3.common.OverlaySettings
import androidx.media3.effect.StaticOverlaySettings
import androidx.media3.effect.TextOverlay
import dev.kneecap.app.edl.EdlClip

/**
 * One `EdlOverlay(kind = text | caption)` -> one time-gated Media3
 * `TextOverlay`. All such overlays across the whole EDL are collected into a
 * SINGLE composition-level `OverlayEffect` (see
 * `EdlToComposition.buildComposition`) — `overlays[]` is a flat, already
 * z-ordered list per the EDL contract (`types.ts`'s doc comment on
 * `EdlOverlay`: "a flat, z-ordered index... `OverlayEffect` applies a
 * FIFO-ordered list of overlays per frame", matching `08` §8's own
 * description almost verbatim), so no per-track sequence juggling is needed
 * the way video/graphic overlay tracks need (those use
 * `CrossfadeCompositorSettings` instead, because they carry real video
 * frames, not just a bitmap).
 *
 * `getText` returns an EMPTY string outside `[startUs, endUs)` — this is
 * the actual time-gating mechanism; `OverlayEffect` has no notion of "this
 * overlay is inactive right now" beyond "draws an empty/invisible frame."
 *
 * Position (`getOverlaySettings`) shares `EdlTransformEffect`'s pixel
 * ->normalized mapping and the SAME unverified-convention caveat — see that
 * class's doc comment. `StaticOverlaySettings`'s anchors are `[0,1]`
 * fractions of the frame, not the `[-1,1]` NDC `EdlTransformEffect` uses, so
 * the conversion here is `0.5 + offset/dimension`, not `2*offset/dimension`.
 */
class EdlTextOverlay(
    private val clip: EdlClip,
    private val startUs: Long,
    private val endUs: Long,
    canvasWidth: Int,
    canvasHeight: Int,
) : TextOverlay() {
    private val content: String = (clip.params["content"] as? String).orEmpty()
    private val fontSizePx: Int = ((clip.params["fontSize"] as? Number)?.toInt() ?: DEFAULT_TEXT_SIZE_PX)
    private val textColor: Int = parseColorOrDefault(clip.params["color"] as? String)

    private val overlaySettings: OverlaySettings = run {
        val anchorX = if (canvasWidth > 0) (0.5 + clip.transform.positionX / canvasWidth).toFloat() else 0.5f
        val anchorY = if (canvasHeight > 0) (0.5 - clip.transform.positionY / canvasHeight).toFloat() else 0.5f
        StaticOverlaySettings.Builder()
            .setAlphaScale(clip.opacity.toFloat())
            .setBackgroundFrameAnchor(anchorX, anchorY)
            .setOverlayFrameAnchor(0.5f, 0.5f)
            .setScale(clip.transform.scaleX.toFloat(), clip.transform.scaleY.toFloat())
            .setRotationDegrees(clip.transform.rotateDegrees.toFloat())
            .build()
    }

    override fun getText(presentationTimeUs: Long): SpannableString {
        if (presentationTimeUs < startUs || presentationTimeUs >= endUs || content.isEmpty()) {
            return SpannableString("")
        }
        val spannable = SpannableString(content)
        spannable.setSpan(ForegroundColorSpan(textColor), 0, content.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        spannable.setSpan(AbsoluteSizeSpan(fontSizePx), 0, content.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        return spannable
    }

    override fun getOverlaySettings(presentationTimeUs: Long): OverlaySettings = overlaySettings

    companion object {
        private const val DEFAULT_TEXT_SIZE_PX = 48

        private fun parseColorOrDefault(hex: String?): Int {
            if (hex.isNullOrBlank()) return Color.WHITE
            return try {
                Color.parseColor(hex)
            } catch (_: IllegalArgumentException) {
                Color.WHITE
            }
        }
    }
}
