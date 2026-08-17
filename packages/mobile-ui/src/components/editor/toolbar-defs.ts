import { Captions, Contrast, Layers, Music, Scissors, Sliders, Sparkles, Sticker, Type } from "lucide-react";
import type { ToolbarItemDef } from "../toolbar-row";

/**
 * M8 primary toolbar item set — corpus `04` §3: item SET triangulated
 * across 6+ sources, ORDER explicitly [NEEDS-CAPTURE] ("no single source
 * ... shows the complete, unambiguous, current left-to-right order").
 * This is corpus 04's OWN cross-referenced "canonical superset" order
 * (§3, the paragraph right after the conflict table): "Edit / Audio /
 * Text / Stickers / Effects / Overlay / Filter / Adjust / Captions" — not
 * any single source's order (all three individually-cited source orders
 * disagree with each other and with this one). Exported as a plain array,
 * matching `BottomToolbar`'s own doc comment that order must stay
 * "configurable" pending the M6a founder capture session.
 */
export const PRIMARY_TOOLBAR_ITEMS: ToolbarItemDef[] = [
	{ id: "edit", label: "Edit", icon: Scissors },
	{ id: "audio", label: "Audio", icon: Music },
	{ id: "text", label: "Text", icon: Type },
	{ id: "stickers", label: "Stickers", icon: Sticker },
	{ id: "effects", label: "Effects", icon: Sparkles },
	{ id: "overlay", label: "Overlay", icon: Layers },
	{ id: "filters", label: "Filters", icon: Sliders },
	{ id: "adjust", label: "Adjust", icon: Contrast },
	{ id: "captions", label: "Captions", icon: Captions },
];

export type PrimaryToolId = (typeof PRIMARY_TOOLBAR_ITEMS)[number]["id"];
