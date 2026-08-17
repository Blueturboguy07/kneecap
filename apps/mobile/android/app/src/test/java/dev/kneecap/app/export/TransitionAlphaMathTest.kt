package dev.kneecap.app.export

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * The one part of the cross-fade compositor (plan M9 risk #4) that is fully
 * verifiable on a plain JVM — see `TransitionAlphaMath`'s doc comment for
 * why everything downstream of this math (the actual Media3
 * `VideoCompositorSettings` wiring) cannot be.
 */
class TransitionAlphaMathTest {

    @Test
    fun `alpha is 0 at window start`() {
        val window = TransitionAlphaMath.Window(startUs = 1_000_000, endUs = 1_500_000)
        assertEquals(0f, TransitionAlphaMath.alphaAt(window, 1_000_000), 0.0001f)
    }

    @Test
    fun `alpha is 1 at window end`() {
        val window = TransitionAlphaMath.Window(startUs = 1_000_000, endUs = 1_500_000)
        assertEquals(1f, TransitionAlphaMath.alphaAt(window, 1_500_000), 0.0001f)
    }

    @Test
    fun `alpha is linear at the midpoint`() {
        val window = TransitionAlphaMath.Window(startUs = 0, endUs = 1_000_000)
        assertEquals(0.5f, TransitionAlphaMath.alphaAt(window, 500_000), 0.0001f)
    }

    @Test
    fun `alpha is linear at an asymmetric point`() {
        // 300ms into a 1200ms window -> 25%.
        val window = TransitionAlphaMath.Window(startUs = 2_000_000, endUs = 3_200_000)
        assertEquals(0.25f, TransitionAlphaMath.alphaAt(window, 2_300_000), 0.0001f)
    }

    @Test
    fun `alpha clamps to 0 before the window (defensive against timestamp jitter)`() {
        val window = TransitionAlphaMath.Window(startUs = 1_000_000, endUs = 2_000_000)
        assertEquals(0f, TransitionAlphaMath.alphaAt(window, 999_000), 0.0001f)
    }

    @Test
    fun `alpha clamps to 1 after the window (defensive against timestamp jitter)`() {
        val window = TransitionAlphaMath.Window(startUs = 1_000_000, endUs = 2_000_000)
        assertEquals(1f, TransitionAlphaMath.alphaAt(window, 2_000_500), 0.0001f)
    }

    @Test
    fun `window requires endUs greater than startUs`() {
        assertThrows(IllegalArgumentException::class.java) {
            TransitionAlphaMath.Window(startUs = 1_000, endUs = 1_000)
        }
        assertThrows(IllegalArgumentException::class.java) {
            TransitionAlphaMath.Window(startUs = 2_000, endUs = 1_000)
        }
    }

    @Test
    fun `classify recognizes crossfade spellings`() {
        assertEquals(TransitionAlphaMath.TransitionKind.CROSSFADE, TransitionAlphaMath.classify("crossfade"))
        assertEquals(TransitionAlphaMath.TransitionKind.CROSSFADE, TransitionAlphaMath.classify("cross-fade"))
        assertEquals(TransitionAlphaMath.TransitionKind.CROSSFADE, TransitionAlphaMath.classify("cross_fade"))
        assertEquals(TransitionAlphaMath.TransitionKind.CROSSFADE, TransitionAlphaMath.classify("dissolve"))
        assertEquals(TransitionAlphaMath.TransitionKind.CROSSFADE, TransitionAlphaMath.classify("CrossFade"))
    }

    @Test
    fun `classify degrades unknown kinds to a hard cut, not a crash`() {
        assertEquals(TransitionAlphaMath.TransitionKind.UNSUPPORTED_HARD_CUT, TransitionAlphaMath.classify("wipe"))
        assertEquals(TransitionAlphaMath.TransitionKind.UNSUPPORTED_HARD_CUT, TransitionAlphaMath.classify("slide"))
        assertEquals(TransitionAlphaMath.TransitionKind.UNSUPPORTED_HARD_CUT, TransitionAlphaMath.classify(""))
        assertEquals(TransitionAlphaMath.TransitionKind.UNSUPPORTED_HARD_CUT, TransitionAlphaMath.classify("nonsense"))
    }
}
