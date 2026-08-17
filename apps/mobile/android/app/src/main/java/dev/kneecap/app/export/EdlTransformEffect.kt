package dev.kneecap.app.export

import android.graphics.Matrix
import androidx.media3.effect.MatrixTransformation
import dev.kneecap.app.edl.EdlTransform

/**
 * `EdlClip.transform` -> a per-frame GL matrix, via Media3's documented
 * `MatrixTransformation` extension point (plan M9 iOS-side analogue:
 * `AVVideoCompositionLayerInstruction`'s opacity/transform ramps).
 *
 * UNVERIFIED CONVENTION — flagged explicitly per task instructions ("be
 * explicit about what needs hardware"): `positionX`/`positionY` are canvas
 * PIXEL offsets from center, Y-down (confirmed from the producer:
 * `services/renderer/compositor/frame-descriptor.ts`: `centerY = height/2 +
 * position.y`). Media3's `MatrixTransformation.getMatrix` matrix is applied
 * in GL normalized device coordinates (`[-1, 1]`), Y-up. The pixel->NDC
 * scale (`2 * offset / canvasDimension`) and the Y-flip
 * (`-transform.positionY`) below are the mathematically obvious mapping
 * between those two conventions, but neither Media3's exact NDC convention
 * for a `MatrixTransformation` nor the resulting on-screen position has been
 * confirmed by rendering an actual frame — there is no device/emulator in
 * this session to do that with. Per plan §2.3 rule 3, this effect must pass
 * (or be cut by) the golden-frame parity gate once a device is available;
 * until then it is applied only to clips whose transform is non-identity
 * (`EdlToComposition.buildEditedMediaItem`), so the common case (no
 * transform) never depends on this class at all.
 */
class EdlTransformEffect(
    private val transform: EdlTransform,
    private val canvasWidth: Int,
    private val canvasHeight: Int,
) : MatrixTransformation {
    override fun getMatrix(presentationTimeUs: Long): Matrix {
        val matrix = Matrix()
        val ndcX = if (canvasWidth > 0) (2.0 * transform.positionX / canvasWidth).toFloat() else 0f
        val ndcY = if (canvasHeight > 0) (-2.0 * transform.positionY / canvasHeight).toFloat() else 0f
        matrix.postScale(transform.scaleX.toFloat(), transform.scaleY.toFloat())
        matrix.postRotate(-transform.rotateDegrees.toFloat())
        matrix.postTranslate(ndcX, ndcY)
        return matrix
    }

    companion object {
        fun isIdentity(transform: EdlTransform): Boolean =
            transform.positionX == 0.0 &&
                transform.positionY == 0.0 &&
                transform.scaleX == 1.0 &&
                transform.scaleY == 1.0 &&
                transform.rotateDegrees == 0.0
    }
}
