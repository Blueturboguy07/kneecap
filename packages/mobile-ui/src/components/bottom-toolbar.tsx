import { ToolbarRow, type ToolbarItemDef } from "./toolbar-row";

export type { ToolbarItemDef };

interface BottomToolbarProps {
	items: ToolbarItemDef[];
	activeId?: string | null;
	onSelect?: (id: string) => void;
	className?: string;
}

/**
 * The primary bottom toolbar (no clip selected) — corpus 04 §3: item SET is
 * triangulated across 6+ sources (Edit, Audio, Text, Stickers, Overlay,
 * Effects, Filters, Adjust, Captions) but the true left-to-right ORDER is
 * explicitly [NEEDS-CAPTURE] ("no single source ... shows the complete,
 * unambiguous, current left-to-right order"). This component takes `items`
 * as a prop rather than hardcoding an order for exactly that reason — the
 * plan's own M8 task 2 requires order to stay "configurable."
 */
export function BottomToolbar({ items, activeId, onSelect, className }: BottomToolbarProps) {
	return (
		<ToolbarRow
			items={items}
			activeId={activeId}
			onSelect={onSelect}
			variant="primary"
			className={className}
			aria-label="Editor tools"
		/>
	);
}
