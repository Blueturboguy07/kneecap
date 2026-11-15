import type { SceneTracks, TimelineElement } from "@kneecap/editor-core/timeline";

const KIND_LABELS: Partial<Record<TimelineElement["type"], string>> = {
	video: "Video",
	image: "Photo",
	audio: "Audio",
};

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** True for a file name that a machine made (it holds a UUID, or it is a
 *  long run of hex digits). Such a name means nothing to a person.
 *  "IMG_0042.HEIC" and "beach.png" are real names and stay. */
export function isMachineFileName(name: string): boolean {
	const base = name.trim().replace(/\.[a-z0-9]{1,5}$/i, "");
	if (base === "") return true;
	if (UUID_PATTERN.test(base)) return true;
	return /^[0-9a-f_-]{8,}$/i.test(base) && /\d/.test(base);
}

/**
 * Display names for media clips whose file name a machine made: "Video 1",
 * "Photo 2", "Audio 1". The number counts the clips of that kind in timeline
 * order (main track, then overlay tracks, then audio tracks; by start time in
 * a track). Clips with a real name keep it and are not in the map.
 */
export function friendlyClipNames({ tracks }: { tracks: SceneTracks }): Map<string, string> {
	const names = new Map<string, string>();
	const counts = new Map<string, number>();
	for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
		const elements = [...track.elements].sort((a, b) => a.startTime - b.startTime);
		for (const element of elements) {
			const label = KIND_LABELS[element.type];
			if (!label) continue;
			const count = (counts.get(label) ?? 0) + 1;
			counts.set(label, count);
			if (isMachineFileName(element.name)) names.set(element.id, `${label} ${count}`);
		}
	}
	return names;
}
