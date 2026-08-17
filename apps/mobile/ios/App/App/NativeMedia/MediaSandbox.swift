import Foundation

/// kneecap M4 item 1: "Copy or reference-resolve into the app sandbox;
/// exclude from iCloud backup." Path layout + backup-exclusion helpers,
/// shared by the import, proxy, and thumbnail steps.
///
/// Platform-agnostic for the same reason as `MediaProbe.swift` — see its
/// header comment. `FileManager`'s `.applicationSupportDirectory` and
/// `URLResourceValues.isExcludedFromBackupKey` both resolve on macOS too
/// (a no-op there, since macOS's Time Machine model doesn't share iOS's
/// per-file backup-exclusion flag), which is what lets
/// `verify-media-pipeline` exercise the real copy-and-exclude code path on
/// the host Mac.
public enum MediaSandbox {
	/// `Application Support/kneecap/` — never `Documents/` (user-visible via
	/// Files app / iTunes file sharing, wrong custody model for re-derivable
	/// imported media) and never `tmp/` (can be purged by the OS at any time).
	public static func rootDirectory() throws -> URL {
		let base = try FileManager.default.url(
			for: .applicationSupportDirectory,
			in: .userDomainMask,
			appropriateFor: nil,
			create: true
		)
		let dir = base.appendingPathComponent("kneecap", isDirectory: true)
		try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		return dir
	}

	public static func mediaDirectory() throws -> URL {
		try subdirectory("Media")
	}

	public static func proxyDirectory() throws -> URL {
		try subdirectory("Proxies")
	}

	public static func thumbnailDirectory(assetId: String) throws -> URL {
		let dir = try subdirectory("Thumbnails").appendingPathComponent(assetId, isDirectory: true)
		try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		return dir
	}

	private static func subdirectory(_ name: String) throws -> URL {
		let dir = try rootDirectory().appendingPathComponent(name, isDirectory: true)
		try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		return dir
	}

	/// Imported media is re-derivable from the user's photo library (or, for
	/// generated proxies/thumbnails, from the imported original) — not
	/// first-party data worth an iCloud/iTunes backup, and video is exactly
	/// the kind of payload that makes backups slow/expensive if included.
	public static func excludeFromBackup(_ url: URL) {
		var mutableURL = url
		var values = URLResourceValues()
		values.isExcludedFromBackup = true
		try? mutableURL.setResourceValues(values)
	}

	/// Copies `sourceURL` into sandboxed media custody under a UUID-derived
	/// name (never the original filename — avoids collisions and strips any
	/// PII a user-chosen filename might carry), excluded from backup.
	@discardableResult
	public static func copyIntoMediaCustody(
		sourceURL: URL,
		assetId: String,
		fileExtension: String
	) throws -> URL {
		let dir = try mediaDirectory()
		let dest = dir.appendingPathComponent("\(assetId).\(fileExtension)")
		if FileManager.default.fileExists(atPath: dest.path) {
			try FileManager.default.removeItem(at: dest)
		}
		try FileManager.default.copyItem(at: sourceURL, to: dest)
		excludeFromBackup(dest)
		return dest
	}

	public static func proxyURL(assetId: String) throws -> URL {
		try proxyDirectory().appendingPathComponent("\(assetId).mp4")
	}
}
