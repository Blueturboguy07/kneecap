package dev.kneecap.app.export

import dev.kneecap.app.edl.Edl

/**
 * The one function that crosses `EdlMeta.ticksPerSecond`-relative ticks into
 * Media3's microsecond (`Us`) time base. Integer math only — plan §2.2/§2.3
 * rule 1 ("no floats cross the bridge") extends one hop further here: ticks
 * come in as `Long`, microseconds go out as `Long`, and the only place a
 * fraction could sneak in (`ticks * 1_000_000 / ticksPerSecond`) is exact
 * integer division, not a `Double` cast.
 */
fun ticksToUs(ticks: Long, ticksPerSecond: Long): Long {
    require(ticksPerSecond > 0) { "ticksPerSecond must be > 0, got $ticksPerSecond" }
    return Math.multiplyExact(ticks, 1_000_000L) / ticksPerSecond
}

/** Thrown for any EDL construct M9's mapper does not (yet) support — masks,
 * keyframe animations, generic filter effects, a transition kind other than
 * cross-fade, an asset with no native `sourceUri`. Plan §2.3 rule 3's
 * "cut, don't ship inconsistent" posture, made into a hard failure rather
 * than a silent drop: `Media3Exporter` surfaces this as an honest
 * `ExportProgress(stage = "error")` rather than exporting a file that
 * doesn't match the preview. */
class ExportUnsupportedException(message: String) : Exception(message)

/**
 * Where the exported video ends: the LATEST end of anything on the
 * timeline — every clip on every track (text, sticker and caption tails
 * included) and every `overlays[]` entry — and never before
 * `meta.durationTicks`. Blind test round 2 (1.0.5) found the iOS export
 * stopping at the last main clip while a title ran on; this is the same
 * rule made explicit (and unit-tested, `EdlTimelineEndTest`) on Android,
 * where `EdlToComposition` pads the base sequence with a blank gap up to
 * it. Zero-length entries add nothing.
 */
fun timelineEndTicks(edl: Edl): Long {
    var end = maxOf(edl.meta.durationTicks, 0L)
    for (track in edl.tracks) {
        for (clip in track.clips) {
            if (clip.durationTicks > 0) end = maxOf(end, clip.startTicks + clip.durationTicks)
        }
    }
    for (overlay in edl.overlays) {
        if (overlay.durationTicks > 0) end = maxOf(end, overlay.startTicks + overlay.durationTicks)
    }
    return end
}
