package dev.kneecap.app.export

/**
 * The file name the share sheet shows for an exported video (1.0.7, blind
 * test round 3: it showed the export's raw id). The export sheet sends
 * "publik kneecap <project name>.mp4"; this cleans it again, the same rule
 * as iOS (`NativeBridgePlugin+Export.swift`, `safeShareFileName`): letters
 * and digits of any language, spaces, "-", "_" and "( )"; any other
 * character becomes a space; at most 80 characters; the export's own
 * extension. Null when nothing is left (the caller keeps the export's name).
 */
internal object ShareFileName {
    fun safe(requested: String?, extension: String): String? {
        var name = requested?.trim().orEmpty()
        if (name.isEmpty()) return null
        val ext = extension.ifEmpty { "mp4" }
        if (name.lowercase().endsWith("." + ext.lowercase())) {
            name = name.dropLast(ext.length + 1)
        }
        val cleaned = buildString {
            for (ch in name) {
                append(if (ch.isLetterOrDigit() || ch == ' ' || ch == '-' || ch == '_' || ch == '(' || ch == ')') ch else ' ')
            }
        }.split(' ').filter { it.isNotEmpty() }.joinToString(" ")
        val short = cleaned.take(80).trim()
        return if (short.isEmpty()) null else "$short.$ext"
    }
}
