package dev.kneecap.app.export

import androidx.media3.effect.RgbMatrix
import dev.kneecap.app.edl.EdlClip

/**
 * Round 47 — a keyframed `opacity` for a clip that composites over the
 * canvas background (the base sequence), as a per-frame RGB scale.
 *
 * Why RGB and not alpha: media3's built-in `AlphaScale` is a constant, and
 * its RGB-matrix shader preserves the input alpha — there is no built-in
 * time-varying alpha effect for a single item. But the base sequence's
 * frames land over kneecap's canvas background, which the Android exporter
 * renders as BLACK (its gaps are black frames), and over black `alpha *
 * colour` and `colour * alpha` are the same picture. So scaling RGB by the
 * evaluated opacity reproduces the preview's fade exactly for main-track
 * clips. Picture-in-picture clips composite over other video, where alpha
 * genuinely matters — those get their per-frame alpha from the compositor
 * (`CrossfadeCompositorSettings.AnimatedOverlayAlpha`) instead.
 *
 * Same time base assumption as `EdlTransformEffect` (composition time).
 */
class AnimatedOpacityRgbMatrix(
    private val clip: EdlClip,
    private val itemStartUs: Long,
    private val ticksPerSecond: Long,
) : RgbMatrix {
    private val channels = KeyframeEvaluator.visualChannels(clip)

    override fun getMatrix(presentationTimeUs: Long, useHdr: Boolean): FloatArray {
        val localTicks = KeyframeEvaluator.localTicks(
            presentationTimeUs = presentationTimeUs,
            itemStartUs = itemStartUs,
            ticksPerSecond = ticksPerSecond,
            durationTicks = clip.durationTicks,
        )
        val o = KeyframeEvaluator.resolveOpacity(clip.opacity, channels, localTicks).coerceIn(0.0, 1.0).toFloat()
        // 4x4, diagonal — layout-agnostic (media3 reads it column-major).
        return floatArrayOf(
            o, 0f, 0f, 0f,
            0f, o, 0f, 0f,
            0f, 0f, o, 0f,
            0f, 0f, 0f, 1f,
        )
    }
}
