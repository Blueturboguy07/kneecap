package dev.kneecap.app.edl

/**
 * EDL v1 — the Kotlin mirror of the frozen bridge contract
 * (`packages/editor-core/src/edl/types.ts`, plan §2.3). M9 (this file's
 * consumer is `export/EdlToComposition.kt`).
 *
 * THE ONE RULE THAT MATTERS (plan §2.2 / §2.3 rule 1, restated here because
 * it is the single easiest thing for a native mapper to get wrong): every
 * time value is an INTEGER TICK COUNT — `Long`, never `Double` — and every
 * rate is a rational pair of integers. `EdlParser` enforces this by reading
 * every `*Ticks` field with `JSONObject.getLong`, never `getDouble`; there is
 * no float-seconds conversion anywhere in this package.
 *
 * Deliberately NOT a 1:1 Kotlin data-class port of every TS field — v1's
 * exit criteria for M9 is filters/transform/opacity/crossfade+wipe-slide
 * transitions/text+sticker overlays/speed (plan §2.3 rule 4), so fields the
 * mapper does not yet consume (masks, keyframe animation curves) are parsed
 * only far enough to detect their presence (`EdlClip.hasMasks`,
 * `EdlClip.hasAnimations`) so `EdlToComposition` can refuse an export that
 * needs them rather than silently dropping them — same posture
 * `validateEdl()` takes on the TS side.
 */

data class EdlRational(val numerator: Long, val denominator: Long) {
    init {
        require(denominator > 0) { "EdlRational.denominator must be > 0, got $denominator" }
    }

    /** Only ever used for logging/estimation — never for a value that
     * crosses back into ticks. */
    fun toDouble(): Double = numerator.toDouble() / denominator.toDouble()
}

data class EdlMeta(
    val edlVersion: Int,
    val generator: String,
    val ticksPerSecond: Long,
    val frameRate: EdlRational,
    val canvasWidth: Int,
    val canvasHeight: Int,
    val projectId: String,
    val projectName: String,
    val sceneId: String,
    val sceneName: String,
    val durationTicks: Long,
)

enum class EdlAssetKind { VIDEO, IMAGE, AUDIO }

data class EdlAsset(
    val assetId: String,
    val kind: EdlAssetKind,
    val name: String,
    /** Native file handle. `null` until M4 wires media custody for this
     * asset — an export referencing a null `sourceUri` is a hard error,
     * not a skip (see `EdlToComposition`). */
    val sourceUri: String?,
    val codec: String?,
    val width: Int?,
    val height: Int?,
    val durationTicks: Long?,
    val rotationDegrees: Int,
    val hasAudio: Boolean,
)

enum class EdlTrackKind { MAIN, OVERLAY, AUDIO }
enum class EdlTrackType { VIDEO, TEXT, AUDIO, GRAPHIC, EFFECT }

data class EdlTransform(
    val positionX: Double,
    val positionY: Double,
    val scaleX: Double,
    val scaleY: Double,
    val rotateDegrees: Double,
)

data class EdlClip(
    val clipId: String,
    val kind: String,
    val assetId: String?,
    val name: String,
    val startTicks: Long,
    val durationTicks: Long,
    val sourceStartTicks: Long,
    val sourceEndTicks: Long,
    val speed: EdlRational,
    val maintainPitch: Boolean,
    val volumeDb: Double,
    val muted: Boolean,
    val hidden: Boolean,
    val transform: EdlTransform,
    val opacity: Double,
    val effects: List<EdlEffect>,
    val hasMasks: Boolean,
    val hasAnimations: Boolean,
    val params: Map<String, Any?>,
)

data class EdlEffect(
    val effectId: String,
    val type: String,
    val enabled: Boolean,
    val params: Map<String, Any?>,
)

data class EdlTrack(
    val trackId: String,
    val kind: EdlTrackKind,
    val trackType: EdlTrackType,
    val name: String,
    val zIndex: Int?,
    val muted: Boolean,
    val hidden: Boolean,
    val clips: List<EdlClip>,
)

/**
 * `kind` is carried as a raw string (not an enum) deliberately: v1's
 * producer status for `transitions[]` is "always `[]`" (`types.ts`'s own
 * doc comment) so no real project has ever emitted a value here yet.
 * `TransitionKind.from(raw)` below is where the v1-supported-vs-unsupported
 * line actually gets drawn, one call site, rather than an enum forcing that
 * decision into the parser.
 */
data class EdlTransition(
    val transitionId: String,
    val afterClipId: String,
    val kind: String,
    val durationTicks: Long,
)

enum class EdlOverlayKind { TEXT, STICKER, GRAPHIC, CAPTION }

data class EdlOverlay(
    val overlayId: String,
    val kind: EdlOverlayKind,
    val trackId: String,
    val clipId: String,
    val zIndex: Int,
    val startTicks: Long,
    val durationTicks: Long,
)

data class EdlOutput(
    val container: String,
    val videoCodec: String,
    val audioCodec: String,
    val bitrate: Int,
    val fps: EdlRational,
    val resolutionWidth: Int,
    val resolutionHeight: Int,
    val includeAudio: Boolean,
)

data class Edl(
    val meta: EdlMeta,
    val assets: List<EdlAsset>,
    val tracks: List<EdlTrack>,
    val transitions: List<EdlTransition>,
    val overlays: List<EdlOverlay>,
    val output: EdlOutput,
) {
    fun assetById(id: String): EdlAsset? = assets.firstOrNull { it.assetId == id }

    /** The single `kind == MAIN` track, per plan §2.3's `tracks[]` shape
     * ("main | overlay[] | audio[]") and §2.3 rule on `transitions[]`
     * ("main track only, per CapCut"). `EdlToComposition` treats more than
     * one as a hard error rather than guessing which one is real. */
    fun mainTrack(): EdlTrack? = tracks.firstOrNull { it.kind == EdlTrackKind.MAIN }
}
