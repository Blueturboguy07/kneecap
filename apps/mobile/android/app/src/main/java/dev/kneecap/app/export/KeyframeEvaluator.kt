package dev.kneecap.app.export

import dev.kneecap.app.edl.EdlAnimationChannel
import dev.kneecap.app.edl.EdlClip
import dev.kneecap.app.edl.EdlTransform

/**
 * kneecap round 47 — keyframe EVALUATION for native export, a line-for-line
 * port of the engine's `animation/interpolation.ts` + `bezier.ts`
 * (`getScalarChannelValueAtTime`): sort keys, clamp handles to their
 * segment, hold / linear / bezier segments (default handles = a third of
 * the span when a key carries none), hold-or-linear edge extrapolation, and
 * the same 20-iteration bisection the preview uses to turn a time into a
 * bezier progress.
 *
 * Pure Kotlin, no Android types: `KeyframeEvaluatorTest` runs it on the JVM
 * against `packages/editor-core/src/animation/__tests__/fixtures/keyframe-
 * eval-parity.json`, the engine-generated contract the Swift port is held
 * to as well. Times are CLIP-LOCAL ticks (`EdlKeyframe.timeTicks`).
 */
object KeyframeEvaluator {
    /** The six paths one mobile "clip keyframe" writes. */
    val VISUAL_PROPERTY_PATHS: Set<String> = setOf(
        "transform.positionX", "transform.positionY",
        "transform.scaleX", "transform.scaleY",
        "transform.rotate", "opacity",
    )

    private const val BEZIER_SOLVE_ITERATIONS = 20

    /** A key with handles already clamped against its neighbours. */
    internal class Key(
        val time: Long,
        val value: Double,
        /** "linear" | "step" | "bezier" — the engine's `segmentToNext`. */
        val segment: String,
        var leftDt: Double?,
        var leftDv: Double?,
        var rightDt: Double?,
        var rightDv: Double?,
    )

    internal fun normalizedKeys(channel: EdlAnimationChannel): List<Key> {
        val keys = channel.keyframes
            .withIndex()
            // JS sort is stable: (time, original index).
            .sortedWith(compareBy({ it.value.timeTicks }, { it.index }))
            .map { (_, k) ->
                Key(
                    time = k.timeTicks,
                    value = k.value ?: Double.NaN,
                    segment = when (k.interpolation) {
                        "hold" -> "step"
                        "bezier" -> "bezier"
                        else -> "linear"
                    },
                    leftDt = k.leftHandle?.dtTicks?.toDouble(),
                    leftDv = k.leftHandle?.dv,
                    rightDt = k.rightHandle?.dtTicks?.toDouble(),
                    rightDv = k.rightHandle?.dv,
                )
            }
        for (i in keys.indices) {
            val leftDt = keys[i].leftDt
            if (i > 0 && leftDt != null) {
                val span = maxOf(1L, keys[i].time - keys[i - 1].time).toDouble()
                keys[i].leftDt = maxOf(-span, minOf(0.0, leftDt))
            } else {
                keys[i].leftDt = null
                keys[i].leftDv = null
            }
            val rightDt = keys[i].rightDt
            if (i + 1 < keys.size && rightDt != null) {
                val span = maxOf(1L, keys[i + 1].time - keys[i].time).toDouble()
                keys[i].rightDt = minOf(span, maxOf(0.0, rightDt))
            } else {
                keys[i].rightDt = null
                keys[i].rightDv = null
            }
        }
        return keys
    }

    internal fun bezierPoint(progress: Double, p0: Double, p1: Double, p2: Double, p3: Double): Double {
        val mt = 1 - progress
        return mt * mt * mt * p0 +
            3 * mt * mt * progress * p1 +
            3 * mt * progress * progress * p2 +
            progress * progress * progress * p3
    }

    private class Handles(val rightDt: Double, val rightDv: Double, val leftDt: Double, val leftDv: Double)

    /** `getDefaultRightHandle` / `getDefaultLeftHandle`: a third of the span. */
    private fun handles(left: Key, right: Key): Handles {
        val span = (right.time - left.time).toDouble()
        val valueDelta = right.value - left.value
        val rightDt = left.rightDt ?: (span / 3)
        val rightDv = if (left.rightDt != null) (left.rightDv ?: 0.0) else valueDelta / 3
        val leftDt = right.leftDt ?: (-span / 3)
        val leftDv = if (right.leftDt != null) (right.leftDv ?: 0.0) else -valueDelta / 3
        return Handles(rightDt, rightDv, leftDt, leftDv)
    }

    /** `solveBezierProgressForTime`: bisection on the TIME curve. */
    internal fun solveBezierProgress(time: Double, left: Key, right: Key): Double {
        var lower = 0.0
        var upper = 1.0
        val h = handles(left, right)
        val lt = left.time.toDouble()
        val rt = right.time.toDouble()
        repeat(BEZIER_SOLVE_ITERATIONS) {
            val mid = (lower + upper) / 2
            val estimate = bezierPoint(mid, lt, lt + h.rightDt, rt + h.leftDt, rt)
            if (estimate < time) lower = mid else upper = mid
        }
        return (lower + upper) / 2
    }

    private fun extrapolate(mode: String, edge: Key, neighbor: Key?, time: Double): Double {
        if (mode != "linear" || neighbor == null) return edge.value
        val span = (neighbor.time - edge.time).toDouble()
        if (span == 0.0) return edge.value
        return edge.value + ((time - edge.time.toDouble()) / span) * (neighbor.value - edge.value)
    }

    /** The channel's value at a clip-local tick — `getScalarChannelValueAtTime`. */
    fun value(channel: EdlAnimationChannel, tick: Long, fallback: Double): Double {
        val keys = normalizedKeys(channel)
        if (keys.isEmpty()) return fallback
        val first = keys.first()
        val last = keys.last()
        val time = tick.toDouble()
        if (tick <= first.time) {
            if (tick < first.time) {
                return extrapolate(channel.extrapolationBefore, first, keys.getOrNull(1), time)
            }
            return first.value
        }
        if (tick >= last.time) {
            if (tick > last.time) {
                return extrapolate(channel.extrapolationAfter, last, keys.getOrNull(keys.size - 2), time)
            }
            return last.value
        }
        for (i in 0 until keys.size - 1) {
            val left = keys[i]
            val right = keys[i + 1]
            if (tick == right.time) return right.value
            if (!(tick >= left.time && tick <= right.time)) continue
            if (left.segment == "step") return left.value
            val span = (right.time - left.time).toDouble()
            if (span == 0.0) return right.value
            val progress = ((time - left.time.toDouble()) / span).coerceIn(0.0, 1.0)
            if (left.segment == "linear") {
                return left.value + (right.value - left.value) * progress
            }
            val curveProgress = solveBezierProgress(time, left, right)
            val h = handles(left, right)
            return bezierPoint(
                curveProgress,
                left.value,
                left.value + h.rightDv,
                right.value + h.leftDv,
                right.value,
            )
        }
        return last.value
    }

    // ---- clip-level helpers ----

    /** Channels on the six visual paths, keyed by path. */
    fun visualChannels(clip: EdlClip): Map<String, EdlAnimationChannel> =
        clip.animations
            .filter { it.propertyPath in VISUAL_PROPERTY_PATHS && it.componentKey == null && it.keyframes.isNotEmpty() }
            .associateBy { it.propertyPath }

    fun hasVisualAnimations(clip: EdlClip): Boolean = visualChannels(clip).isNotEmpty()

    fun hasOpacityAnimation(clip: EdlClip): Boolean = visualChannels(clip).containsKey("opacity")

    /** Keyed paths this exporter cannot honour (volume, colours, effect
     *  params...) — `EdlToComposition` refuses rather than silently drops. */
    fun unsupportedAnimationPaths(clip: EdlClip): List<String> =
        clip.animations
            .filter { it.keyframes.isNotEmpty() && (it.propertyPath !in VISUAL_PROPERTY_PATHS || it.componentKey != null) }
            .map { if (it.componentKey != null) "${it.propertyPath}.${it.componentKey}" else it.propertyPath }
            .distinct()

    fun resolveTransform(base: EdlTransform, channels: Map<String, EdlAnimationChannel>, localTicks: Long): EdlTransform {
        fun v(path: String, fallback: Double): Double {
            val channel = channels[path] ?: return fallback
            return value(channel, localTicks, fallback)
        }
        return EdlTransform(
            positionX = v("transform.positionX", base.positionX),
            positionY = v("transform.positionY", base.positionY),
            scaleX = v("transform.scaleX", base.scaleX),
            scaleY = v("transform.scaleY", base.scaleY),
            rotateDegrees = v("transform.rotate", base.rotateDegrees),
        )
    }

    fun resolveOpacity(base: Double, channels: Map<String, EdlAnimationChannel>, localTicks: Long): Double {
        val channel = channels["opacity"] ?: return base
        return value(channel, localTicks, base)
    }

    /** Composition-time microseconds -> clip-local ticks, clamped to the
     *  clip like the preview's `getElementLocalTime`. */
    fun localTicks(presentationTimeUs: Long, itemStartUs: Long, ticksPerSecond: Long, durationTicks: Long): Long {
        val localUs = presentationTimeUs - itemStartUs
        val ticks = Math.round(localUs.toDouble() * ticksPerSecond.toDouble() / 1_000_000.0)
        return ticks.coerceIn(0L, maxOf(0L, durationTicks))
    }
}
