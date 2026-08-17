package dev.kneecap.app.export

import androidx.media3.common.OverlaySettings
import androidx.media3.common.VideoCompositorSettings
import androidx.media3.common.util.Size
import androidx.media3.effect.StaticOverlaySettings

/**
 * The Media3 half of the cross-fade compositor (plan M9 risk #4). Thin by
 * design: all the actual math lives in framework-free `TransitionAlphaMath`
 * (unit-tested); this class's only job is adapting that math to the two
 * methods `androidx.media3.common.VideoCompositorSettings` requires, and
 * that adaptation cannot itself run outside a real `Transformer`/GL export
 * pass — there is no way to unit-test "does Media3 actually call
 * `getOverlaySettings` with the presentation timestamps this class assumes"
 * without hardware. See M9 handoff for exactly what is and isn't verified.
 *
 * `inputIndex` contract, set by `EdlToComposition.buildComposition`:
 *   0                -> the base sequence (every main-track clip, hard-cut).
 *                        Always fully opaque; `windowsByInputIndex` never
 *                        has an entry for 0.
 *   1..transitions.size -> one short overlay sequence per `EdlTransition`,
 *                        each holding only the transition-duration-long head
 *                        of the incoming clip. `windowsByInputIndex[i]` is
 *                        that sequence's `TransitionAlphaMath.Window`.
 *   >transitions.size  -> overlay/graphic tracks (PiP-style), driven by a
 *                        clip's static `transform`/`opacity`, not a
 *                        transition ramp — see
 *                        `overlayTrackSettingsByInputIndex`.
 */
class CrossfadeCompositorSettings(
    private val windowsByInputIndex: Map<Int, TransitionAlphaMath.Window>,
    private val overlayTrackSettingsByInputIndex: Map<Int, StaticOverlaySettings> = emptyMap(),
    private val outputSize: Size,
) : VideoCompositorSettings {

    override fun getOutputSize(inputSizes: MutableList<Size>): Size = outputSize

    override fun getOverlaySettings(inputIndex: Int, presentationTimeUs: Long): OverlaySettings {
        val window = windowsByInputIndex[inputIndex]
        if (window != null) {
            val alpha = TransitionAlphaMath.alphaAt(window, presentationTimeUs)
            return StaticOverlaySettings.Builder().setAlphaScale(alpha).build()
        }
        overlayTrackSettingsByInputIndex[inputIndex]?.let { return it }
        // Input 0 (the base sequence) and any unrecognized index: fully
        // opaque, untransformed — `OverlaySettings`'s own documented
        // defaults (`DEFAULT_ALPHA_SCALE` etc.), which is also what
        // `VideoCompositorSettings.DEFAULT` returns for every input.
        return StaticOverlaySettings.Builder().build()
    }
}
