package dev.kneecap.app.export

import dev.kneecap.app.edl.EdlAnimationChannel
import dev.kneecap.app.edl.EdlParser
import dev.kneecap.app.edl.EdlTransform
import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Round 47 — the Kotlin keyframe evaluator against the engine-generated
 * parity fixture (`packages/editor-core/src/animation/__tests__/fixtures/
 * keyframe-eval-parity.json`): the TS `getScalarChannelValueAtTime` at 160+
 * sample ticks across linear / hold / bezier (default + explicit + clamped
 * handles) / extrapolation / out-of-order channels. Same contract the Swift
 * port is held to in `verify-export-pipeline`. Pure JVM, like the other
 * tests in this directory.
 */
class KeyframeEvaluatorTest {

    private fun locateFixture(): File {
        val rel = "packages/editor-core/src/animation/__tests__/fixtures/keyframe-eval-parity.json"
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val candidate = File(dir, rel)
            if (candidate.isFile) return candidate
            dir = dir.parentFile
        }
        throw AssertionError("keyframe parity fixture not found above ${System.getProperty("user.dir")} — regenerate with packages/editor-core's generate-keyframe-parity-fixture script")
    }

    private fun loadFixture(): Triple<List<EdlAnimationChannel>, List<JSONObject>, Double> {
        val root = JSONObject(locateFixture().readText())
        val channelsJson = root.getJSONArray("channels")
        val channels = (0 until channelsJson.length()).map { EdlParser.parseAnimationChannel(channelsJson.getJSONObject(it)) }
        val samplesJson = root.getJSONArray("samples")
        val samples = (0 until samplesJson.length()).map { samplesJson.getJSONObject(it) }
        return Triple(channels, samples, root.getDouble("tolerance"))
    }

    @Test
    fun `matches the TS engine on every parity sample`() {
        val (channels, samples, tolerance) = loadFixture()
        assertTrue("fixture should carry a real spread of samples, got ${samples.size}", samples.size >= 100)
        var worst = 0.0
        for (sample in samples) {
            val channel = channels[sample.getInt("channel")]
            val tick = sample.getLong("timeTicks")
            val expected = sample.getDouble("expected")
            val actual = KeyframeEvaluator.value(channel, tick, Double.NaN)
            val delta = Math.abs(actual - expected)
            worst = maxOf(worst, delta)
            assertTrue(
                "channel ${sample.getInt("channel")} (${channel.propertyPath}) @ $tick: Kotlin $actual vs engine $expected",
                delta <= tolerance,
            )
        }
        println("keyframe parity: ${samples.size} samples, worst |delta| = $worst")
    }

    @Test
    fun `fixture covers hold linear bezier and both extrapolations`() {
        val (channels, _, _) = loadFixture()
        val interpolations = channels.flatMap { c -> c.keyframes.map { it.interpolation } }.toSet()
        assertEquals(setOf("linear", "hold", "bezier"), interpolations)
        assertTrue(channels.any { it.extrapolationBefore == "linear" && it.extrapolationAfter == "linear" })
        assertTrue(channels.any { c -> c.keyframes.any { (it.rightHandle?.dv ?: 0.0) != 0.0 } })
    }

    @Test
    fun `localTicks maps composition time to clamped clip-local ticks`() {
        val tps = 120_000L
        // Item starts at 2.0s; a frame at 2.5s is local 0.5s = 60000 ticks.
        assertEquals(60_000L, KeyframeEvaluator.localTicks(2_500_000, 2_000_000, tps, 480_000))
        // Before the item: clamp to 0. Past its end: clamp to duration.
        assertEquals(0L, KeyframeEvaluator.localTicks(1_000_000, 2_000_000, tps, 480_000))
        assertEquals(480_000L, KeyframeEvaluator.localTicks(9_000_000, 2_000_000, tps, 480_000))
    }

    @Test
    fun `resolveTransform keeps base values for un-keyed paths`() {
        val (channels, _, _) = loadFixture()
        val positionX = channels.first { it.propertyPath == "transform.positionX" }
        val base = EdlTransform(positionX = 7.0, positionY = -9.0, scaleX = 1.5, scaleY = 1.5, rotateDegrees = 12.0)
        val resolved = KeyframeEvaluator.resolveTransform(base, mapOf("transform.positionX" to positionX), 4000)
        assertEquals(200.0, resolved.positionX, 1e-9) // fixture channel 0: 200 at tick 4000
        assertEquals(-9.0, resolved.positionY, 0.0)
        assertEquals(1.5, resolved.scaleX, 0.0)
        assertEquals(12.0, resolved.rotateDegrees, 0.0)
        assertEquals(0.5, KeyframeEvaluator.resolveOpacity(0.5, emptyMap(), 123), 0.0)
    }
}
