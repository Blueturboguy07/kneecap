package dev.kneecap.app.export

import dev.kneecap.app.edl.EdlClip

/**
 * Which overlay clips the exporter decodes as picture-in-picture layers
 * (1.0.7, blind test round 3).
 *
 * Only video and image clips have a media asset to decode. Sticker and
 * graphic clips (Stickers > Flags, Stickers > Shapes) sit on overlay
 * "graphic" tracks too, but they have no asset: the export sheet draws them
 * into the preview-rendered overlay frames (`PrerenderedOverlay`), the same
 * way it draws text and captions. Until 1.0.7 the PiP loop in
 * `EdlToComposition` sent them to `requireAsset`, so any project with a
 * sticker failed to export ("clip … has no assetId").
 */
internal object OverlayClips {
    fun isPipMediaClip(clip: EdlClip): Boolean = clip.kind == "video" || clip.kind == "image"
}
