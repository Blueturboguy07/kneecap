/**
 * Writes the Audio panel's bundled sounds as files of the mobile app's web
 * folder: `apps/mobile/public/<bundledPath>` (`sounds/<id>.wav`).
 *
 * The bytes come from the same synthesis as editor-core
 * `sounds/local-sounds.ts` (the `data:` URI there), so the files and the
 * data URIs stay equal. `apps/mobile/test/round-2-assets.test.ts` checks
 * that each committed file is present and has the expected WAV header.
 *
 * Run from the repo root: `bun apps/mobile/scripts/generate-bundled-sounds.ts`
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLocalSounds } from "../../../packages/editor-core/src/sounds/local-sounds";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const PREFIX = "data:audio/wav;base64,";

for (const sound of getLocalSounds()) {
	if (!sound.sourceUrl.startsWith(PREFIX)) {
		throw new Error(`${sound.id}: not a WAV data URI`);
	}
	const bytes = Buffer.from(sound.sourceUrl.slice(PREFIX.length), "base64");
	const out = join(PUBLIC_DIR, sound.bundledPath);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, bytes);
	console.log(`${sound.bundledPath}: ${bytes.length} bytes`);
}
