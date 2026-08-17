package dev.kneecap.app.export

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
