package dev.kneecap.app.export

import androidx.media3.common.C
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.SpeedParameters
import androidx.media3.common.util.Size
import androidx.media3.effect.AlphaScale
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.StaticOverlaySettings
import androidx.media3.transformer.Composition
import com.google.common.collect.ImmutableList
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
 * inconsistent"): masks, keyframes on anything but `transform.*`/`opacity`
 * (round 47 made those real — `KeyframeEvaluator`), and any non-empty
 * `EdlClip.effects` (generic filter mapping is out of scope for this pass —
 * see the M9 handoff). An asset with `sourceUri == null` is also a hard
 * error: it means M4's media-custody import never ran for that asset, which
 * is a producer bug the exporter should surface immediately, not paper over.
 */
object EdlToComposition {
    fun buildComposition(
        edl: Edl,
        /** Preview-rendered text/caption images (round 37). When non-empty
         *  these REPLACE `EdlTextOverlay`, so the exported overlay layer is
         *  the editor's own drawing rather than a second implementation of
         *  it — see `PrerenderedOverlay`. */
        overlayFrames: List<PrerenderedOverlay.Frame> = emptyList(),
    ): Composition {
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

        // Whole frames per second; a still is emitted at the project's own
        // rate so its frames line up with the video clips around it.
        val outputFrameRate = Math.round(
            edl.output.fps.numerator.toDouble() / edl.output.fps.denominator.toDouble(),
        ).toInt().coerceAtLeast(1)

        val sequences = mutableListOf<EditedMediaItemSequence>()
        // The project runs to the LAST thing on any track, which is routinely
        // a caption or title that outlives the final video clip.
        val mainEndTicks = mainClips.maxOf { it.startTicks + it.durationTicks }
        val projectEndTicks = maxOf(edl.meta.durationTicks, mainEndTicks)
        val transitionWindows = mutableMapOf<Int, TransitionAlphaMath.Window>()
        val overlaySettingsByIndex = mutableMapOf<Int, StaticOverlaySettings>()
        val animatedOverlayAlphaByIndex = mutableMapOf<Int, CrossfadeCompositorSettings.AnimatedOverlayAlpha>()

        // -- index 0: base sequence, hard-cut, always opaque -----------------
        // DECLARED track types, not inferred. media3 1.11.0 replaced the
        // (now-deprecated) experimentalSetForce{Audio,Video}Track flags with
        // this constructor, and declaring them is what lets a sequence contain
        // a leading gap, an item with no audio (a still), or an item with no
        // video (a music clip) — media3 synthesizes silence/blank frames for
        // the declared-but-absent track instead of failing. Leaving it to be
        // inferred is what produced, in order on the emulator: the gap
        // exception, then a released-audio-input crash at 54%.
        var baseSeqBuilder = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_VIDEO))
        for (clip in mainClips) {
            baseSeqBuilder = baseSeqBuilder.addItem(
                buildEditedMediaItem(
                    clip = clip,
                    asset = requireAsset(edl, clip),
                    us = ::us,
                    ticksPerSecond = tps,
                    canvasWidth = edl.meta.canvasWidth,
                    canvasHeight = edl.meta.canvasHeight,
                    frameRate = outputFrameRate,
                    outputWidth = edl.output.resolutionWidth,
                    outputHeight = edl.output.resolutionHeight,
                    // Video only — the main track's audio rides its own
                    // sequence (see "audio sequences" below).
                    removeAudio = true,
                ),
            )
        }
        // Black tail. Without it the video stream simply STOPS at the last
        // main clip while the overlays (and the audio) run on — an export
        // whose captions ran past the final clip lost them entirely, and the
        // file ended up with a 9s video track under a 11.9s audio track. A gap
        // in a video-declared sequence is exactly the blank-frame filler iOS
        // gets from its pacer lane.
        if (mainEndTicks < projectEndTicks) {
            baseSeqBuilder = baseSeqBuilder.addGap(us(projectEndTicks - mainEndTicks))
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
                ticksPerSecond = tps,
                // The head plays the incoming clip's first `d` ticks starting
                // at the window, so that is its keyframe-local zero.
                itemStartTicks = windowStartTicks,
                canvasWidth = edl.meta.canvasWidth,
                canvasHeight = edl.meta.canvasHeight,
                frameRate = outputFrameRate,
                // Audio is a hard cut under a video cross-fade — Media3 has
                // no mixer-gain-ramp API to crossfade audio the same way
                // (see TransitionAlphaMath's doc comment); the base
                // sequence's own copy of `incomingClip` already carries its
                // audio starting exactly at `windowEndUs`, so including audio
                // here too would double it up during the transition window.
                removeAudio = true,
            )
            // A sequence whose FIRST item is a gap has no track to infer its
            // format from, so Media3 throws "If the first item in the sequence
            // is a Gap, then forceAudioTrack or forceVideoTrack flag must be
            // set". This sequence is video-only (`removeAudio = true` above),
            // so the video track is the one to force — and ONLY when a gap is
            // actually emitted: forcing a track that the items already supply
            // makes Media3 generate silence/blank frames alongside the real
            // samples, which fails later inside the graph rather than here.
            val overlaySeqBuilder = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_VIDEO))
            if (windowStartUs > 0) {
                overlaySeqBuilder.addGap(windowStartUs)
            }
            val overlaySeq = overlaySeqBuilder
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
                val animated = KeyframeEvaluator.hasVisualAnimations(clip)
                val item = buildEditedMediaItem(
                    clip = clip,
                    asset = asset,
                    us = ::us,
                    ticksPerSecond = tps,
                    canvasWidth = edl.meta.canvasWidth,
                    canvasHeight = edl.meta.canvasHeight,
                    frameRate = outputFrameRate,
                    outputWidth = edl.output.resolutionWidth,
                    outputHeight = edl.output.resolutionHeight,
                    removeAudio = true, // PiP/overlay visual layers are silent in v1.
                    // A keyframed PiP clip gets its per-frame alpha from the
                    // compositor (it composites over video, so real alpha is
                    // needed); the item itself carries no opacity effect.
                    applyOpacity = !animated,
                )
                // Gap-first sequence, video-only — same rule as the
                // transition sequence above.
                val seqBuilder = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_VIDEO))
                if (clip.startTicks > 0) {
                    seqBuilder.addGap(us(clip.startTicks))
                }
                val seq = seqBuilder
                    .addItem(item)
                    .build()
                sequences.add(seq)
                if (animated) {
                    // Round 47: geometry (position/scale/rotation, keyframed)
                    // is applied ONCE, by the item's animated
                    // `EdlTransformEffect`; the compositor only supplies the
                    // evaluated alpha. NOTE the static path below applies
                    // scale/rotation here AND (when non-identity) in the item
                    // effect — that pre-existing double application is left
                    // as-is for static clips and needs the emulator golden
                    // frame to settle; animated clips deliberately do not
                    // inherit it.
                    animatedOverlayAlphaByIndex[nextIndex] =
                        CrossfadeCompositorSettings.AnimatedOverlayAlpha(clip, us(clip.startTicks), tps)
                } else {
                    overlaySettingsByIndex[nextIndex] = StaticOverlaySettings.Builder()
                        .setAlphaScale(clip.opacity.toFloat())
                        .setScale(clip.transform.scaleX.toFloat(), clip.transform.scaleY.toFloat())
                        .setRotationDegrees(clip.transform.rotateDegrees.toFloat())
                        .build()
                }
                nextIndex++
            }
        }

        // -- audio sequences ---------------------------------------------------
        // ALL audio — the main track's own clip audio included — travels in
        // dedicated audio-only sequences, gap-padded across the project's full
        // length. The base sequence above is video-only for a reason: a
        // sequence that declares an audio track but contains an item with no
        // audio (a still, which is normal on a main track) had its audio input
        // released the moment that item started, while the previous item's
        // renderer was still feeding it — media3 then failed the whole export
        // with a bare "Asset loader error" at exactly the video->image
        // boundary (reproduced on the emulator at ~50% of a 6s-video +
        // 6s-image timeline). Splitting audio out means every audio sequence
        // holds audio for its entire length, and silence is expressed as a gap
        // (which media3 fills), not as a silent item.
        /** The clips of one audio-only sequence: audible, in time order. */
        fun audibleClips(clips: List<EdlClip>, trackMuted: Boolean): List<EdlClip> =
            clips
                .filter { clip ->
                    !trackMuted && !clip.muted && edl.output.includeAudio &&
                        requireAsset(edl, clip).kind != EdlAssetKind.IMAGE
                }
                .sortedBy { it.startTicks }

        // The summed mix is limited by `LimitingAudioMixer` (installed on the
        // Transformer), so nothing here needs to reserve headroom.
        val audioSources = buildList {
            add(audibleClips(mainClips, mainTrack.muted))
            for (track in edl.tracks.filter { it.kind == EdlTrackKind.AUDIO }) {
                add(audibleClips(track.clips, track.muted))
            }
        }.filter { it.isNotEmpty() }

        fun addAudioSequence(audible: List<EdlClip>) {
            var seqBuilder = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_AUDIO))
            var cursorTicks = 0L
            for (clip in audible) {
                if (clip.startTicks > cursorTicks) {
                    seqBuilder = seqBuilder.addGap(us(clip.startTicks - cursorTicks))
                }
                seqBuilder = seqBuilder.addItem(
                    buildEditedMediaItem(
                        clip = clip,
                        asset = requireAsset(edl, clip),
                        us = ::us,
                        ticksPerSecond = tps,
                        canvasWidth = edl.meta.canvasWidth,
                        canvasHeight = edl.meta.canvasHeight,
                        frameRate = outputFrameRate,
                        outputWidth = edl.output.resolutionWidth,
                        outputHeight = edl.output.resolutionHeight,
                        removeAudio = false,
                        removeVideo = true,
                    ),
                )
                cursorTicks = clip.startTicks + clip.durationTicks
            }
            // Trailing silence: a music clip is routinely shorter than the
            // video under it, and a sequence that just ENDS is torn down while
            // the composition still runs — the same released-input failure.
            if (cursorTicks < projectEndTicks) {
                seqBuilder = seqBuilder.addGap(us(projectEndTicks - cursorTicks))
            }
            sequences.add(seqBuilder.build())
        }

        for (source in audioSources) addAudioSequence(source)

        // -- text/caption overlays: one composition-level OverlayEffect -----
        // Preview-rendered frames win when supplied; the native Spannable
        // renderer below stays as the fallback for callers that send none.
        val textOverlays: List<androidx.media3.effect.TextureOverlay> =
            if (overlayFrames.isNotEmpty()) {
                listOf(PrerenderedOverlay(overlayFrames))
            } else edl.overlays
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
            compositionVideoEffects.add(OverlayEffect(ImmutableList.copyOf(textOverlays)))
        }

        val compositorSettings = CrossfadeCompositorSettings(
            windowsByInputIndex = transitionWindows,
            overlayTrackSettingsByInputIndex = overlaySettingsByIndex,
            animatedOverlayAlphaByInputIndex = animatedOverlayAlphaByIndex,
            outputSize = Size(edl.output.resolutionWidth, edl.output.resolutionHeight),
        )

        // `nextIndex` ended as the count of VIDEO-producing sequences (index 0
        // is the base track; each cross-fade window and each PiP overlay clip
        // added one more). Media3 builds a SingleInputVideoGraph when there is
        // only one of them, and that graph throws
        // "SingleInputVideoGraph does not use VideoCompositor, and therefore
        // cannot apply VideoCompositorSettings" from its constructor — so a
        // plain project with no transition and no overlay clip could never
        // export at all (caught on the emulator; the audio-only sequences
        // appended after this counter do not make the graph multi-input).
        val builder = Composition.Builder(sequences)
        if (nextIndex > 1) {
            builder.setVideoCompositorSettings(compositorSettings)
        }
        return builder
            .setEffects(
                Effects(
                    emptyList(),
                    compositionVideoEffects,
                ),
            )
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
        ticksPerSecond: Long,
        canvasWidth: Int,
        canvasHeight: Int,
        removeAudio: Boolean,
        removeVideo: Boolean = false,
        frameRate: Int = 30,
        outputWidth: Int = 0,
        outputHeight: Int = 0,
        /** Composition-time start of this item = keyframe-local tick 0.
         *  Every sequence is gap-padded from 0, so it is the clip's own
         *  startTicks except for a transition head (see the caller). */
        itemStartTicks: Long = clip.startTicks,
        /** False when the compositor owns this item's opacity (animated PiP). */
        applyOpacity: Boolean = true,
    ): EditedMediaItem {
        if (clip.hasMasks) {
            throw ExportUnsupportedException(
                "clip ${clip.clipId} has masks; masks are explicitly post-v1 for native export (plan §2.3 rule 4)",
            )
        }
        val unsupportedKeyframes = KeyframeEvaluator.unsupportedAnimationPaths(clip)
        if (unsupportedKeyframes.isNotEmpty()) {
            throw ExportUnsupportedException(
                "clip ${clip.clipId} has keyframes on ${unsupportedKeyframes.joinToString()}; native export " +
                    "supports keyframes on transform.* and opacity only (round 47)",
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
        if (isImage) {
            // A still has no track of its own to decode, so media3 asks the
            // MediaItem how long to synthesize one for. Without this the image
            // asset loader reports no output track and the export dies partway
            // with "The asset loader has no audio or video track to output" —
            // reported only as a generic "Asset loader error" (this is the one
            // that survived three earlier fixes on the emulator). The
            // EditedMediaItem's own `setDurationUs` below is NOT a substitute;
            // both are required, and `setFrameRate` tells it how many frames
            // to emit across that span.
            mediaItemBuilder.setImageDurationMs(us(clip.durationTicks) / 1_000)
        } else {
            mediaItemBuilder.setClippingConfiguration(
                MediaItem.ClippingConfiguration.Builder()
                    .setStartPositionUs(us(clip.sourceStartTicks))
                    .setEndPositionUs(us(clip.sourceEndTicks))
                    .build(),
            )
        }

        val videoEffects = mutableListOf<Effect>()
        val itemStartUs = us(itemStartTicks)
        val animated = KeyframeEvaluator.hasVisualAnimations(clip)
        if (animated || !EdlTransformEffect.isIdentity(clip.transform)) {
            videoEffects.add(EdlTransformEffect(clip, canvasWidth, canvasHeight, itemStartUs, ticksPerSecond))
        }
        if (applyOpacity) {
            if (KeyframeEvaluator.hasOpacityAnimation(clip)) {
                // Round 47: per-frame opacity over the black base — see the class doc.
                videoEffects.add(AnimatedOpacityRgbMatrix(clip, itemStartUs, ticksPerSecond))
            } else if (clip.opacity != 1.0) {
                videoEffects.add(AlphaScale(clip.opacity.toFloat()))
            }
        }

        // Normalize every visual item to the export resolution HERE, per
        // item, not only through the composition-level Presentation: media3
        // pulls a trailing composition Presentation out of the effect chain to
        // size the encoder, so it runs AFTER the composition's OverlayEffect.
        // That left the preview-rendered overlays compositing onto
        // proxy-sized frames and coming out magnified and edge-cropped in the
        // exported file, while being pixel-correct in the preview. With this,
        // frames reaching the overlay stage are already at output size and the
        // overlay is a true 1:1 blit.
        if (!removeVideo && outputWidth > 0 && outputHeight > 0) {
            videoEffects.add(
                Presentation.createForWidthAndHeight(
                    outputWidth,
                    outputHeight,
                    Presentation.LAYOUT_SCALE_TO_FIT,
                ),
            )
        }

        val builder = EditedMediaItem.Builder(mediaItemBuilder.build())
            .setRemoveAudio(removeAudio || !asset.hasAudio)
            .setRemoveVideo(removeVideo)
            // Per-clip volume. Parsed since M9 but never applied on Android —
            // the slider was a no-op in every Android export until now.
            .setEffects(
                Effects(
                    if (removeAudio) {
                        emptyList()
                    } else {
                        listOf(ClipGainAudioProcessor(clip.volumeDb))
                    },
                    videoEffects,
                ),
            )

        if (isImage) {
            builder.setDurationUs(us(clip.durationTicks))
            builder.setFrameRate(frameRate)
        }
        if (clip.speed.numerator != clip.speed.denominator) {
            builder.setSpeed(
                SpeedParameters(ConstantSpeedProvider(clip.speed.toDouble().toFloat()), clip.maintainPitch),
            )
        }
        return builder.build()
    }
}
