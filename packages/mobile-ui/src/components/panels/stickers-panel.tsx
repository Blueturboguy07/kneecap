import { useEffect, useState } from "react";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import { ChipRow } from "../chip-row";
import { ThumbnailGrid } from "../thumbnail-grid";
import type { EditorCore } from "@kneecap/editor-core";
import { browseCategory, type StickerCategory, type StickerItem } from "@kneecap/editor-core/stickers";
import { STICKER_CATEGORIES } from "@kneecap/editor-core/stickers/categories";
import { insertStickerElement } from "../../editor/actions";

interface StickersPanelProps {
	editor: EditorCore;
	onClose: () => void;
	onInserted: (elementId: { trackId: string; elementId: string }) => void;
}

function isStickerCategory(value: string): value is StickerCategory {
	return value in STICKER_CATEGORIES;
}

const CATEGORIES = Object.keys(STICKER_CATEGORIES)
	.filter(isStickerCategory)
	.filter((c) => c !== "all");

type ItemsByCategory = Partial<Record<StickerCategory, StickerItem[]>>;

/** The items of every category, read once when the panel opens. A category
 *  whose provider fails or has no items gets an empty list. */
async function loadAllCategories(): Promise<ItemsByCategory> {
	const entries = await Promise.all(
		CATEGORIES.map((category) =>
			browseCategory({ category }).then(
				(result) => [category, result.sections.flatMap((s) => s.items)] as const,
				() => [category, [] as StickerItem[]] as const,
			),
		),
	);
	return Object.fromEntries(entries) as ItemsByCategory;
}

/**
 * M8 Stickers panel — corpus 04 §3.4: "categories rendered as tabs... tap a
 * sticker -> lands on canvas." Backed by the real `stickersRegistry`
 * (bundled `shapes`/`flags` providers, zero network) via `browseCategory`.
 * Not every category the reference editor's marketing copy names
 * (Emoji/GIF/Love/Funny) is bundled locally — only `flags` and `shapes`
 * are real providers in this engine today; the chip row reflects exactly
 * what's registered, not an aspirational reference-editor category list.
 *
 * Blind test round 2: a tab with no items does not show (the panel reads
 * every category once, then shows only the ones with items). The flag
 * images are in apps/mobile/public/flags, so they are in the app
 * (apps/mobile/test/round-2-assets.test.ts).
 */
export function StickersPanel({ editor, onClose, onInserted }: StickersPanelProps) {
	const [itemsByCategory, setItemsByCategory] = useState<ItemsByCategory | null>(null);
	const [activeCategory, setActiveCategory] = useState<StickerCategory | null>(null);

	useEffect(() => {
		let cancelled = false;
		void loadAllCategories().then((loaded) => {
			if (!cancelled) setItemsByCategory(loaded);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	const categories = CATEGORIES.filter((c) => (itemsByCategory?.[c]?.length ?? 0) > 0);
	const current =
		activeCategory !== null && (categories as StickerCategory[]).includes(activeCategory)
			? activeCategory
			: (categories[0] ?? null);
	const items = current ? (itemsByCategory?.[current] ?? []) : [];

	return (
		<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
			{categories.length > 0 && (
				<ChipRow
					chips={categories.map((c) => ({ id: c, label: STICKER_CATEGORIES[c] }))}
					activeIds={current ? [current] : []}
					onSelect={(id) => {
						if (isStickerCategory(id)) setActiveCategory(id);
					}}
				/>
			)}
			{itemsByCategory === null && <p className="cc-panel-note">Loading…</p>}
			{itemsByCategory !== null && items.length === 0 && <p className="cc-panel-note">No stickers.</p>}
			{items.length > 0 && (
				<ThumbnailGrid
					items={items.map((item) => ({ id: item.id, imageSrc: item.previewUrl, label: item.name }))}
					onSelect={(stickerId) => {
						const ref = insertStickerElement({ editor, stickerId });
						if (ref) onInserted(ref);
					}}
				/>
			)}
		</PanelSheet>
	);
}
