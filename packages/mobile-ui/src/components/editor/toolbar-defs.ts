import {
	Captions,
	Contrast,
	Layers,
	Music,
	PaintBucket,
	Scissors,
	Sliders,
	Sparkles,
	Square,
	Sticker,
	Type,
} from "lucide-react";
import type { ToolbarItemDef } from "../toolbar-row";

/**
 * M8 primary toolbar — order measured from a reference capture session
 * (2026-08-18, not kept in the repo: two overlapping scroll positions of
 * the same bar). This closes the corpus 04 §3 [NEEDS-CAPTURE] on ordering:
 * Edit / Audio / Text / Effects / Overlay / Captions / Filters / Adjust /
 * Stickers / Aspect ratio / Background. Every pre-capture "canonical
 * superset" guess is superseded by this.
 *
 * Every item opens a real panel (App Store rule 2.1, completeness).
 * Transcript and Template are gone: they only opened a "not in publik
 * kneecap yet" sheet. Aspect ratio and Background are real panels over
 * the engine's project settings.
 */
export const PRIMARY_TOOLBAR_ITEMS: ToolbarItemDef[] = [
	{ id: "edit", label: "Edit", icon: Scissors },
	{ id: "audio", label: "Audio", icon: Music },
	{ id: "text", label: "Text", icon: Type },
	{ id: "effects", label: "Effects", icon: Sparkles },
	{ id: "overlay", label: "Overlay", icon: Layers },
	{ id: "captions", label: "Captions", icon: Captions },
	{ id: "filters", label: "Filters", icon: Sliders },
	{ id: "adjust", label: "Adjust", icon: Contrast },
	{ id: "stickers", label: "Stickers", icon: Sticker },
	{ id: "ratio", label: "Aspect ratio", icon: Square },
	{ id: "background", label: "Background", icon: PaintBucket },
];

export type PrimaryToolId = (typeof PRIMARY_TOOLBAR_ITEMS)[number]["id"];
