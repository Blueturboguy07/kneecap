import { describe, expect, test } from "bun:test";
import { nativeFilePathFromUri } from "../native-file-path";

describe("nativeFilePathFromUri (1.0.5: the export result block hands native the file)", () => {
	test("takes the raw path back out of an iOS or Android playback URL, spaces and all", () => {
		expect(
			nativeFilePathFromUri(
				"capacitor://localhost/_capacitor_file_/var/mobile/Containers/Data/Application/A1/Library/Application Support/kneecap/Exports/e1.mp4",
			),
		).toBe("/var/mobile/Containers/Data/Application/A1/Library/Application Support/kneecap/Exports/e1.mp4");
		expect(
			nativeFilePathFromUri("https://localhost/_capacitor_file_/data/user/0/dev.kneecap.app/no_backup/exports/export-1.mp4"),
		).toBe("/data/user/0/dev.kneecap.app/no_backup/exports/export-1.mp4");
	});

	test("passes a raw path or a file:// URL through unchanged (both natives accept them)", () => {
		expect(nativeFilePathFromUri("/var/mobile/x/Exports/e1.mp4")).toBe("/var/mobile/x/Exports/e1.mp4");
		expect(nativeFilePathFromUri("file:///data/user/0/dev.kneecap.app/no_backup/exports/e.mp4")).toBe(
			"file:///data/user/0/dev.kneecap.app/no_backup/exports/e.mp4",
		);
	});
});
