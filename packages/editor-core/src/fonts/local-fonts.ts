import type { FontAtlas } from "@/fonts/types";
import { SYSTEM_FONTS } from "@/fonts/system-fonts";

/**
 * Fonts bundled locally (self-hosted @font-face in `local-fonts.css`,
 * files under /public/fonts/local). Selecting one of these never touches
 * the network.
 *
 * The picker's atlas (`/fonts/font-atlas.json`, same-origin static asset,
 * also no network) still lists ~1900 families for browsing/preview, but
 * only families in this set can actually be *applied* offline today.
 * Anything else fails closed in `loadFullFont` below: it resolves without
 * loading anything and the editor falls back to the system font. Curating
 * a broader locally-bundled OFL set is scoped to a later milestone
 * (plan M8, "Text" panel — "bundle a curated OFL font set locally").
 */
const LOCAL_FONTS = new Set<string>(["Inter"]);

/** M8 Text panel's font picker reads this rather than re-declaring its own
 *  list — see the header above for why it's still just `["Inter"]`. */
export function getLocallyAvailableFonts(): string[] {
	return Array.from(LOCAL_FONTS);
}

const FONT_ATLAS_PATH = "/fonts/font-atlas.json";
const FONT_CHUNK_PATH_PREFIX = "/fonts/font-chunk-";

const fullLoaded = new Set<string>();

let cachedAtlas: FontAtlas | null = null;
let atlasFetchPromise: Promise<FontAtlas | null> | null = null;

export function getCachedFontAtlas(): FontAtlas | null {
	return cachedAtlas;
}

export function clearFontAtlasCache(): void {
	cachedAtlas = null;
	atlasFetchPromise = null;
	fullLoaded.clear();
}

/** Loads the (same-origin, static) font-picker preview atlas. No external network request. */
export function loadFontAtlas(): Promise<FontAtlas | null> {
	if (cachedAtlas) return Promise.resolve(cachedAtlas);
	if (atlasFetchPromise) return atlasFetchPromise;

	atlasFetchPromise = fetch(FONT_ATLAS_PATH)
		.then(async (response) => {
			if (!response.ok) return null;
			const data: FontAtlas = await response.json();
			cachedAtlas = data;
			preloadChunkImages({ atlas: data });
			return data;
		})
		.catch(() => null);

	return atlasFetchPromise;
}

function preloadChunkImages({ atlas }: { atlas: FontAtlas }): void {
	const maxChunk = Math.max(
		...Object.values(atlas.fonts).map((entry) => entry.ch),
	);
	for (let i = 0; i <= maxChunk; i++) {
		// hint browser to preload the (same-origin) chunk image without blocking
		const img = new Image();
		img.src = `${FONT_CHUNK_PATH_PREFIX}${i}.avif`;
	}
}

/**
 * Ensures `family` is ready to render. For a locally-bundled family this
 * waits on the already-local @font-face; for anything else it resolves
 * as a no-op (never fetched, nothing to wait for) and the caller falls
 * back to the system font. Never makes a network request. Never rejects.
 */
export async function loadFullFont({
	family,
	weights = [400, 700],
}: {
	family: string;
	weights?: number[];
}): Promise<void> {
	if (fullLoaded.has(family)) return;
	if (!LOCAL_FONTS.has(family)) return;

	await Promise.all(
		weights.map((weight) =>
			document.fonts
				.load(`${weight} 16px "${family.replace(/"/g, '\\"')}"`)
				.catch(() => undefined),
		),
	);
	fullLoaded.add(family);
}

export async function loadFonts({
	families,
}: {
	families: string[];
}): Promise<void> {
	const nonSystemFonts = families.filter(
		(family) => !SYSTEM_FONTS.has(family),
	);
	await Promise.all(nonSystemFonts.map((family) => loadFullFont({ family })));
}
