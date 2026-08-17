import {
	CircleIcon,
	DiamondIcon,
	FavouriteIcon,
	MinusSignIcon,
	PanelRightDashedIcon,
	PenToolAddIcon,
	SquareIcon,
	StarsIcon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import { masksRegistry, type MaskIconProps } from "@/masks/registry";
import type { MaskType } from "@/masks/types";

/**
 * Host-side icon pack for the built-in masks.
 *
 * kneecap M2: this file is deliberately OUTSIDE `@kneecap/editor-core`. The
 * engine registers icon-less mask definitions; a UI host binds presentation.
 * A native (non-web) host would ship its own equivalent and never load this.
 *
 * Must be called AFTER `registerDefaultMasks()` (i.e. after `EditorCore` has
 * been constructed) — `setIcon` no-ops on unregistered types.
 */
const DEFAULT_MASK_ICONS: Array<{ type: MaskType; icon: MaskIconProps }> = [
	{ type: "split", icon: { icon: PanelRightDashedIcon, strokeWidth: 1 } },
	{ type: "cinematic-bars", icon: { icon: MinusSignIcon } },
	{ type: "rectangle", icon: { icon: SquareIcon } },
	{ type: "ellipse", icon: { icon: CircleIcon } },
	{ type: "heart", icon: { icon: FavouriteIcon } },
	{ type: "diamond", icon: { icon: DiamondIcon } },
	{ type: "star", icon: { icon: StarsIcon } },
	{ type: "text", icon: { icon: TextFontIcon } },
	{ type: "freeform", icon: { icon: PenToolAddIcon } },
];

export function registerDefaultMaskIcons(): void {
	for (const { type, icon } of DEFAULT_MASK_ICONS) {
		masksRegistry.setIcon({ type, icon });
	}
}
