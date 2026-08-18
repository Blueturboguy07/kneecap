import {
	Captions,
	Contrast,
	FileText,
	LayoutTemplate,
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
 * M8 primary toolbar — order MEASURED from the founder's live-CapCut capture
 * session (2026-08-18, docs/capcut-reference/capture-editor-toolbar-start.png
 * + capture-editor-toolbar-scrolled.png, two overlapping scroll positions of
 * the same bar). This closes the corpus 04 §3 [NEEDS-CAPTURE] on ordering:
 * Edit / Audio / Text / Effects / Overlay / Captions / Filters / Adjust /
 * Stickers / Transcript / Aspect ratio / Background / Template. Every
 * pre-capture "canonical superset" guess is superseded by this.
 *
 * Transcript and Template open a "not in kneecap yet" sheet (deliberate,
 * visible response — v1 scope per docs/DECISIONS.md); Aspect ratio and
 * Background are real panels over the engine's project settings.
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
	{ id: "transcript", label: "Transcript", icon: FileText },
	{ id: "ratio", label: "Aspect ratio", icon: Square },
	{ id: "background", label: "Background", icon: PaintBucket },
	{ id: "template", label: "Template", icon: LayoutTemplate },
];

export type PrimaryToolId = (typeof PRIMARY_TOOLBAR_ITEMS)[number]["id"];
