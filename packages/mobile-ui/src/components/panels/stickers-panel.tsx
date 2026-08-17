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

/**
 * M8 Stickers panel — corpus 04 §3.4: "categories rendered as tabs... tap a
 * sticker -> lands on canvas." Backed by the real `stickersRegistry`
 * (already-bundled `shapes`/`flags` providers, zero network) via
 * `browseCategory`. Not every category CapCut's own marketing copy names
 * (Emoji/GIF/Love/Funny) is bundled locally — only `flags` and `shapes`
 * are real providers in this engine today; the chip row reflects exactly
 * what's registered, not an aspirational CapCut category list.
 */
export function StickersPanel({ editor, onClose, onInserted }: StickersPanelProps) {
	const [activeCategory, setActiveCategory] = useState<StickerCategory>(CATEGORIES[0] ?? "shapes");
	const [items, setItems] = useState<StickerItem[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		browseCategory({ category: activeCategory })
			.then((result) => {
				if (cancelled) return;
				setItems(result.sections.flatMap((s) => s.items));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [activeCategory]);

	return (
		<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
			<ChipRow
				chips={CATEGORIES.map((c) => ({ id: c, label: STICKER_CATEGORIES[c] }))}
				activeIds={[activeCategory]}
				onSelect={(id) => {
					if (!isStickerCategory(id) || id === activeCategory) return;
					setLoading(true);
					setActiveCategory(id);
				}}
			/>
			{loading && <p className="cc-panel-note">Loading…</p>}
			{!loading && items.length === 0 && <p className="cc-panel-note">No stickers in this category.</p>}
			{!loading && items.length > 0 && (
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
