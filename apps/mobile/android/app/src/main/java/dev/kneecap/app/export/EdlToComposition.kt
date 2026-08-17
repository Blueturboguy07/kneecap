package dev.kneecap.app.export

import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.SpeedParameters
import androidx.media3.common.util.Size
import androidx.media3.effect.AlphaScale
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.StaticOverlaySettings
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import dev.kneecap.app.edl.Edl
import dev.kneecap.app.edl.EdlAsset
import dev.kneecap.app.edl.EdlAssetKind
import dev.kneecap.app.edl.EdlClip
import dev.kneecap.app.edl.EdlOverlayKind
import dev.kneecap.app.edl.EdlTrackKind
import dev.kneecap.app.edl.EdlTrackType

/**
 * EDL v1 -> Media3 `Composition` (plan M9). THE deliverable of the
 * "build the cross-fade compositor first" risk item (plan risk #4,
 * `08` §8): see `TransitionAlphaMath`/`CrossfadeCompositorSettings` for the
 * mechanism this class wires up.
 *
 * Sequence-index layout of the returned `Composition` (also documented on
 * `CrossfadeCompositorSettings`):
 *   0                    -> base sequence: every main-track video/image clip,
 *                           hard-cut, in order. Always fully opaque.
 *   1..transitions.size  -> one short overlay sequence per CROSS-FADE
 *                           transition (non-crossfade `EdlTransition.kind`s
 *                           degrade to a hard cut, i.e. contribute NO
 *                           sequence — plan §2.3 rule 3/4).
 *   next..               -> one sequence per clip on an `overlay` track of
 *                           `trackType` video/graphic (PiP-style layers).
 *   last N                -> one sequence per `audio`-kind track
 *                           (video removed on every item).
 *
 * Text/caption overlays do NOT get their own sequence — they are collected
 * into a single composition-level `OverlayEffect` (see `EdlTextOverlay`).
 *
 * WHAT THIS CLASS DELIBERATELY REFUSES (throws `ExportUnsupportedException`
 * rather than silently degrading — plan §2.3 rule 3's "cut, don't ship
 * inconsistent"): masks, keyframe animations, and any non-empty
 * `EdlClip.effects` (generic filter mapping is out of scope for this pass —
 * see the M9 handoff). An asset with `sourceUri == null` is also a hard
 * error: it means M4's media-custody import never ran for that asset, which
 * is a producer bug the exporter should surface immediately, not paper over.
 */
object EdlToComposition {
    fun buildComposition(edl: Edl): Composition {
        val tps = edl.meta.ticksPerSecond
        fun us(ticks: Long): Long = ticksToUs(ticks, tps)

        val mainTrack = edl.mainTrack()
            ?: throw ExportUnsupportedException("EDL has no main track")
        val mainClips = mainTrack.clips
            .filter { it.kind == "video" || it.kind == "image" }
            .sortedBy { it.startTicks }
        if (mainClips.isEmpty()) {
            throw ExportUnsupportedException("main track has no video/image clips")
        }

        val sequences = mutableListOf<EditedMediaItemSequence>()
        val transitionWindows = mutableMapOf<Int, TransitionAlphaMath.Window>()
        val overlaySettingsByIndex = mutableMapOf<Int, StaticOverlaySettings>()

        // -- index 0: base sequence, hard-cut, always opaque -----------------
        var baseSeqBuilder = EditedMediaItemSequence.Builder()
        for (clip in mainClips) {
            baseSeqBuilder = baseSeqBuilder.addItem(
                buildEditedMediaItem(
                    clip = clip,
                    asset = requireAsset(edl, clip),
                    us = ::us,
                    canvasWidth = edl.meta.canvasWidth,
                    canvasHeight = edl.meta.canvasHeight,
                    removeAudio = mainTrack.muted || clip.muted || !edl.output.includeAudio,
                ),
            )
        }
        sequences.add(baseSeqBuilder.build())

        // -- 1..N: one overlay sequence per cross-fade transition ------------
        var nextIndex = 1
        val clipsByStart = mainClips
        for (transition in edl.transitions) {
            if (TransitionAlphaMath.classify(transition.kind) != TransitionAlphaMath.TransitionKind.CROSSFADE) {
                // v1 scope cut (plan §2.3 rule 4): degrades to the base
                // sequence's own hard cut. Not an error — an unrecognized
                // transition kind on the main track is expected to become a
                // plain cut, same as "no transition specified."
                continue
            }
            val afterIdx = clipsByStart.indexOfFirst { it.clipId == transition.afterClipId }
            if (afterIdx < 0) {
                throw ExportUnsupportedException(
                    "transition ${transition.transitionId} references unknown afterClipId ${transition.afterClipId}",
                )
            }
            val afterClip = clipsByStart[afterIdx]
            val incomingClip = clipsByStart.getOrNull(afterIdx + 1)
                ?: throw ExportUnsupportedException(
                    "transition ${transition.transitionId} is after the last main-track clip; nothing to cross-fade into",
                )
            if (transition.durationTicks <= 0 ||
                transition.durationTicks > afterClip.durationTicks ||
                transition.durationTicks > incomingClip.durationTicks
            ) {
                throw ExportUnsupportedException(
                    "transition ${transition.transitionId} durationTicks=${transition.durationTicks} " +
                        "does not fit within both adjacent clips (${afterClip.clipId}=${afterClip.durationTicks}, " +
                        "${incomingClip.clipId}=${incomingClip.durationTicks})",
                )
            }

            val windowStartTicks = afterClip.startTicks + afterClip.durationTicks - transition.durationTicks
            val windowStartUs = us(windowStartTicks)
            val windowEndUs = us(afterClip.startTicks + afterClip.durationTicks)

            val headClip = incomingClip.copy(
                durationTicks = transition.durationTicks,
                sourceEndTicks = incomingClip.sourceStartTicks +
                    Math.round(transition.durationTicks * incomingClip.speed.toDouble()),
            )
            val overlayItem = buildEditedMediaItem(
                clip = headClip,
                asset = requireAsset(edl, headClip),
                us = ::us,
                canvasWidth = edl.meta.canvasWidth,
                canvasHeight = edl.meta.canvasHeight,
                // Audio is a hard cut under a video cross-fade — Media3 has
                // no mixer-gain-ramp API to crossfade audio the same way
                // (see TransitionAlphaMath's doc comment); the base
                // sequence's own copy of `incomingClip` already carries its
                // audio starting exactly at `windowEndUs`, so including audio
                // here too would double it up during the transition window.
                removeAudio = true,
            )
            val overlaySeq = EditedMediaItemSequence.Builder()
                .addGap(windowStartUs)
                .addItem(overlayItem)
                .build()
            sequences.add(overlaySeq)
            transitionWindows[nextIndex] = TransitionAlphaMath.Window(windowStartUs, windowEndUs)
            nextIndex++
        }

        // -- next..: overlay video/graphic tracks (PiP-style layers) ---------
        val overlayVisualTracks = edl.tracks.filter {
            it.kind == EdlTrackKind.OVERLAY &&
                (it.trackType == EdlTrackType.VIDEO || it.trackType == EdlTrackType.GRAPHIC)
        }
        for (track in overlayVisualTracks) {
            for (clip in track.clips.sortedBy { it.startTicks }) {
                val asset = requireAsset(edl, clip)
                val item = buildEditedMediaItem(
                    clip = clip,
                    asset = asset,
                    us = ::us,
                    canvasWidth = edl.meta.canvasWidth,
                    canvasHeight = edl.meta.canvasHeight,
                    removeAudio = true, // PiP/overlay visual layers are silent in v1.
                )
                val seq = EditedMediaItemSequence.Builder()
                    .addGap(us(clip.startTicks))
                    .addItem(item)
                    .build()
                sequences.add(seq)
                overlaySettingsByIndex[nextIndex] = StaticOverlaySettings.Builder()
                    .setAlphaScale(clip.opacity.toFloat())
                    .setScale(clip.transform.scaleX.toFloat(), clip.transform.scaleY.toFloat())
                    .setRotationDegrees(clip.transform.rotateDegrees.toFloat())
                    .build()
                nextIndex++
            }
        }

        // -- audio-only tracks -------------------------------------------------
        for (track in edl.tracks.filter { it.kind == EdlTrackKind.AUDIO }) {
            if (track.clips.isEmpty()) continue
            var seqBuilder = EditedMediaItemSequence.Builder()
            var cursorTicks = 0L
            for (clip in track.clips.sortedBy { it.startTicks }) {
                if (clip.startTicks > cursorTicks) {
                    seqBuilder = seqBuilder.addGap(us(clip.startTicks - cursorTicks))
                }
                seqBuilder = seqBuilder.addItem(
                    buildEditedMediaItem(
                        clip = clip,
                        asset = requireAsset(edl, clip),
                        us = ::us,
                        canvasWidth = edl.meta.canvasWidth,
                        canvasHeight = edl.meta.canvasHeight,
                        removeAudio = track.muted || clip.muted || !edl.output.includeAudio,
                        removeVideo = true,
                    ),
                )
                cursorTicks = clip.startTicks + clip.durationTicks
            }
            sequences.add(seqBuilder.build())
        }

        // -- text/caption overlays: one composition-level OverlayEffect -----
        val textOverlays = edl.overlays
            .filter { it.kind == EdlOverlayKind.TEXT || it.kind == EdlOverlayKind.CAPTION }
            .sortedBy { it.zIndex }
            .mapNotNull { overlay ->
                val clip = findClip(edl, overlay.trackId, overlay.clipId) ?: return@mapNotNull null
                EdlTextOverlay(
                    clip = clip,
                    startUs = us(overlay.startTicks),
                    endUs = us(overlay.startTicks + overlay.durationTicks),
                    canvasWidth = edl.meta.canvasWidth,
                    canvasHeight = edl.meta.canvasHeight,
                )
            }

        val compositionVideoEffects = mutableListOf<Effect>()
        if (edl.output.resolutionWidth > 0 && edl.output.resolutionHeight > 0) {
            compositionVideoEffects.add(
                Presentation.createForWidthAndHeight(
                    edl.output.resolutionWidth,
                    edl.output.resolutionHeight,
                    Presentation.LAYOUT_SCALE_TO_FIT,
                ),
            )
        }
        if (textOverlays.isNotEmpty()) {
            compositionVideoEffects.add(OverlayEffect(textOverlays))
        }

        val compositorSettings = CrossfadeCompositorSettings(
            windowsByInputIndex = transitionWindows,
            overlayTrackSettingsByInputIndex = overlaySettingsByIndex,
            outputSize = Size(edl.output.resolutionWidth, edl.output.resolutionHeight),
        )

        return Composition.Builder(sequences)
            .setVideoCompositorSettings(compositorSettings)
            .setEffects(Effects(emptyList(), compositionVideoEffects))
            .build()
    }

    private fun requireAsset(edl: Edl, clip: EdlClip): EdlAsset {
        val assetId = clip.assetId
            ?: throw ExportUnsupportedException("clip ${clip.clipId} has no assetId")
        val asset = edl.assetById(assetId)
            ?: throw ExportUnsupportedException("clip ${clip.clipId} references unknown assetId $assetId")
        if (asset.sourceUri == null) {
            throw ExportUnsupportedException(
                "asset ${asset.assetId} has no sourceUri — media import (M4) has not run for this asset",
            )
        }
        return asset
    }

    private fun findClip(edl: Edl, trackId: String, clipId: String): EdlClip? =
        edl.tracks.firstOrNull { it.trackId == trackId }
            ?.clips?.firstOrNull { it.clipId == clipId }

    private fun buildEditedMediaItem(
        clip: EdlClip,
        asset: EdlAsset,
        us: (Long) -> Long,
        canvasWidth: Int,
        canvasHeight: Int,
        removeAudio: Boolean,
        removeVideo: Boolean = false,
    ): EditedMediaItem {
        if (clip.hasMasks) {
            throw ExportUnsupportedException(
                "clip ${clip.clipId} has masks; masks are explicitly post-v1 for native export (plan §2.3 rule 4)",
            )
        }
        if (clip.hasAnimations) {
            throw ExportUnsupportedException(
                "clip ${clip.clipId} has keyframe animations; unsupported by this native export pass",
            )
        }
        if (clip.effects.isNotEmpty()) {
            throw ExportUnsupportedException(
                "clip ${clip.clipId} has ${clip.effects.size} filter effect(s); generic filter mapping is not " +
                    "implemented in this M9 pass (see handoff)",
            )
        }

        val sourceUri = requireNotNull(asset.sourceUri) // requireAsset() already guaranteed non-null.
        val isImage = clip.kind == "image" || asset.kind == EdlAssetKind.IMAGE

        val mediaItemBuilder = MediaItem.Builder().setUri(sourceUri)
        if (!isImage) {
            mediaItemBuilder.setClippingConfiguration(
                MediaItem.ClippingConfiguration.Builder()
                    .setStartPositionUs(us(clip.sourceStartTicks))
                    .setEndPositionUs(us(clip.sourceEndTicks))
                    .build(),
            )
        }

        val videoEffects = mutableListOf<Effect>()
        if (!EdlTransformEffect.isIdentity(clip.transform)) {
            videoEffects.add(EdlTransformEffect(clip.transform, canvasWidth, canvasHeight))
        }
        if (clip.opacity != 1.0) {
            videoEffects.add(AlphaScale(clip.opacity.toFloat()))
        }

        val builder = EditedMediaItem.Builder(mediaItemBuilder.build())
            .setRemoveAudio(removeAudio || !asset.hasAudio)
            .setRemoveVideo(removeVideo)
            .setEffects(Effects(emptyList(), videoEffects))

        if (isImage) {
            builder.setDurationUs(us(clip.durationTicks))
        }
        if (clip.speed.numerator != clip.speed.denominator) {
            builder.setSpeed(
                SpeedParameters(ConstantSpeedProvider(clip.speed.toDouble().toFloat()), clip.maintainPitch),
            )
        }
        return builder.build()
    }
}
