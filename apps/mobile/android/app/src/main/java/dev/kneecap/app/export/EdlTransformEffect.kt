package dev.kneecap.app.export

import android.graphics.Matrix
import android.util.Log
import androidx.media3.effect.MatrixTransformation
import dev.kneecap.app.edl.EdlClip
import dev.kneecap.app.edl.EdlTransform

/**
 * `EdlClip.transform` -> a per-frame GL matrix, via Media3's documented
 * `MatrixTransformation` extension point (plan M9 iOS-side analogue:
 * `AVVideoCompositionLayerInstruction`'s opacity/transform ramps).
 *
 * Round 47: `getMatrix` is called per FRAME with a presentation time, which
 * is exactly the hook a keyframed transform needs. A clip with keyframe
 * channels on `transform.*` resolves them through `KeyframeEvaluator` (the
 * engine's own interpolation, parity-tested) at the clip-local tick under
 * `presentationTimeUs`; a static clip returns its constant matrix as before.
 *
 * TIME BASE — STATED, NOT VERIFIED ON HARDWARE: `presentationTimeUs` is
 * treated as COMPOSITION time (media3 adds each item's sequence offset
 * before per-item effects see a frame — the same base the composition-
 * level `PrerenderedOverlay` timing relies on, which the emulator run
 * verified), so clip-local time is `presentationTimeUs - itemStartUs`.
 * If a device run shows item-relative timestamps instead, the fix is
 * `itemStartUs = 0` at the call sites; the first frame's numbers are
 * logged under `kneecap-export` precisely so that can be read off adb.
 *
 * UNVERIFIED CONVENTION (pre-existing, unchanged) — flagged explicitly per
 * task instructions ("be explicit about what needs hardware"):
 * `positionX`/`positionY` are canvas PIXEL offsets from center, Y-down
 * (confirmed from the producer: `services/renderer/compositor/frame-
 * descriptor.ts`: `centerY = height/2 + position.y`). Media3's
 * `MatrixTransformation.getMatrix` matrix is applied in GL normalized
 * device coordinates (`[-1, 1]`), Y-up. The pixel->NDC scale (`2 * offset /
 * canvasDimension`) and the Y-flip (`-transform.positionY`) below are the
 * mathematically obvious mapping between those two conventions, but
 * neither Media3's exact NDC convention for a `MatrixTransformation` nor the
 * resulting on-screen position has been confirmed by rendering an actual
 * frame. Per plan §2.3 rule 3, this effect must pass (or be cut by) the
 * golden-frame parity gate once a device is available; until then it is
 * applied only to clips whose transform is non-identity or keyframed
 * (`EdlToComposition.buildEditedMediaItem`), so the common case never
 * depends on this class at all.
 */
class EdlTransformEffect(
    private val clip: EdlClip,
    private val canvasWidth: Int,
    private val canvasHeight: Int,
    /** Composition-time start of this item, microseconds — local tick 0. */
    private val itemStartUs: Long,
    private val ticksPerSecond: Long,
) : MatrixTransformation {
    private val channels = KeyframeEvaluator.visualChannels(clip)

    @Volatile
    private var loggedFirstFrame = false

    override fun getMatrix(presentationTimeUs: Long): Matrix {
        val transform = if (channels.isEmpty()) {
            clip.transform
        } else {
            val localTicks = KeyframeEvaluator.localTicks(
                presentationTimeUs = presentationTimeUs,
                itemStartUs = itemStartUs,
                ticksPerSecond = ticksPerSecond,
                durationTicks = clip.durationTicks,
            )
            if (!loggedFirstFrame) {
                loggedFirstFrame = true
                Log.i(
                    TAG,
                    "keyframed transform ${clip.clipId}: first pts=${presentationTimeUs}us itemStart=${itemStartUs}us -> local $localTicks ticks",
                )
            }
            KeyframeEvaluator.resolveTransform(clip.transform, channels, localTicks)
        }
        return matrixFor(transform, canvasWidth, canvasHeight)
    }

    companion object {
        private const val TAG = "kneecap-export"

        fun isIdentity(transform: EdlTransform): Boolean =
            transform.positionX == 0.0 &&
                transform.positionY == 0.0 &&
                transform.scaleX == 1.0 &&
                transform.scaleY == 1.0 &&
                transform.rotateDegrees == 0.0

        fun matrixFor(transform: EdlTransform, canvasWidth: Int, canvasHeight: Int): Matrix {
            val matrix = Matrix()
            val ndcX = if (canvasWidth > 0) (2.0 * transform.positionX / canvasWidth).toFloat() else 0f
            val ndcY = if (canvasHeight > 0) (-2.0 * transform.positionY / canvasHeight).toFloat() else 0f
            matrix.postScale(transform.scaleX.toFloat(), transform.scaleY.toFloat())
            matrix.postRotate(-transform.rotateDegrees.toFloat())
            matrix.postTranslate(ndcX, ndcY)
            return matrix
        }
    }
}
