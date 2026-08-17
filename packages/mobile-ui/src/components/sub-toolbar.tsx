import { ToolbarRow, type ToolbarItemDef } from "./toolbar-row";

export type { ToolbarItemDef };

interface SubToolbarProps {
	items: ToolbarItemDef[];
	activeId?: string | null;
	onSelect?: (id: string) => void;
	className?: string;
}

/**
 * The clip-selected contextual toolbar — corpus 04 §4: item set varies by
 * selected object type (video/audio/text/sticker, see §4.1-4.3), and
 * whether it *replaces* or *sits above/extends* the primary bar is itself
 * unresolved ("Storyblocks: 'swipe to the left on the toolbar at the bottom
 * of your screen until you find the Reverse button' suggests it may be a
 * horizontally scrollable extension of the same bar rather than a full
 * replacement, at least in some builds" — [NEEDS-CAPTURE], plan M6a).
 * Ships as a visually-identical sibling to BottomToolbar (shorter height)
 * so either resolution is a layout change, not a rebuild.
 */
export function SubToolbar({ items, activeId, onSelect, className }: SubToolbarProps) {
	return (
		<ToolbarRow
			items={items}
			activeId={activeId}
			onSelect={onSelect}
			variant="contextual"
			className={className}
			aria-label="Clip tools"
		/>
	);
}
