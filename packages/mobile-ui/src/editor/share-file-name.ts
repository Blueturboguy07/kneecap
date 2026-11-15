/**
 * The file name the system share sheet shows for an exported video
 * (1.0.7, blind test round 3: the share sheet showed the export's raw id).
 *
 * "publik kneecap <project name>.<extension>", with only safe characters:
 * letters and digits of any language, spaces, "-", "_" and "( )". Any other
 * character becomes a space; runs of spaces become one; the project name is
 * cut at 60 characters. No project name gives "publik kneecap.<extension>".
 * The native side (NativeBridgePlugin+Export.swift, NativeBridgePlugin.kt)
 * cleans the name again before it uses it.
 */
const PREFIX = "publik kneecap";
const MAX_PROJECT_NAME = 60;

export function shareFileName({
	projectName,
	extension,
}: {
	projectName: string | null | undefined;
	extension: string;
}): string {
	const safeExtension = extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "mp4";
	const cleaned = (projectName ?? "")
		.normalize("NFC")
		.replace(/[^\p{L}\p{N} _()-]/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_PROJECT_NAME)
		.trim();
	const base = cleaned ? `${PREFIX} ${cleaned}` : PREFIX;
	return `${base}.${safeExtension}`;
}
