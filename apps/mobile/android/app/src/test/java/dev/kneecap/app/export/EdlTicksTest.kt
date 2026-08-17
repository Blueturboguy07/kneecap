package dev.kneecap.app.export

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** `ticksToUs` — the one function that crosses the tick/microsecond boundary
 * (plan §2.2/§2.3 rule 1). */
class EdlTicksTest {
    @Test
    fun `converts a whole second at the real editor-core ticksPerSecond`() {
        // 120000 ticks/sec (packages/editor-core's TICKS_PER_SECOND) -> 1s = 1_000_000us.
        assertEquals(1_000_000L, ticksToUs(120_000L, 120_000L))
    }

    @Test
    fun `converts a half second exactly, no rounding drift`() {
        assertEquals(500_000L, ticksToUs(60_000L, 120_000L))
    }

    @Test
    fun `zero ticks is zero microseconds`() {
        assertEquals(0L, ticksToUs(0L, 120_000L))
    }

    @Test
    fun `rejects a non-positive ticksPerSecond`() {
        assertThrows(IllegalArgumentException::class.java) { ticksToUs(1000L, 0L) }
        assertThrows(IllegalArgumentException::class.java) { ticksToUs(1000L, -1L) }
    }
}
