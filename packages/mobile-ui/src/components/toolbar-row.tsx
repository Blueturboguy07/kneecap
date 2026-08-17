import type { ComponentType } from "react";
import type { CcIconProps } from "../icons/types";
import { CC_ICON_STROKE } from "../tokens";
import { cn } from "../lib/cn";

export interface ToolbarItemDef {
	id: string;
	label: string;
	/** Any lucide-react icon or one of this kit's custom icons — both take
	 *  the same {size, strokeWidth} shape. */
	icon: ComponentType<CcIconProps>;
	disabled?: boolean;
}

interface ToolbarRowProps {
	items: ToolbarItemDef[];
	activeId?: string | null;
	onSelect?: (id: string) => void;
	variant: "primary" | "contextual";
	className?: string;
	"aria-label": string;
}

/**
 * The shared scrollable icon+label row behind both BottomToolbar (primary,
 * no clip selected) and SubToolbar (contextual, clip-selected) — corpus 04
 * §4 flags whether the contextual bar *replaces* or *extends* the primary
 * one as [NEEDS-CAPTURE], so both are built from one visually-identical
 * primitive pending that capture, differing only in height today.
 */
export function ToolbarRow({
	items,
	activeId = null,
	onSelect,
	variant,
	className,
	...rest
}: ToolbarRowProps) {
	return (
		<div
			className={cn(
				"cc-toolbar",
				variant === "primary" ? "cc-toolbar--primary" : "cc-toolbar--contextual",
				className,
			)}
			role="toolbar"
			{...rest}
		>
			{items.map((item) => {
				const Icon = item.icon;
				const active = item.id === activeId;
				return (
					<button
						key={item.id}
						type="button"
						className={cn("cc-toolbar__item", active && "cc-toolbar__item--active")}
						disabled={item.disabled}
						aria-pressed={active}
						onClick={() => onSelect?.(item.id)}
					>
						{/* 24 mirrors --cc-icon-size-toolbar in tokens.css; kept as a
						    literal here because SVG width/height attributes need a
						    resolved number, not a CSS custom property. There is no
						    separate measured size for the contextual bar's icons, so
						    both variants share this one token. */}
						<Icon size={24} strokeWidth={CC_ICON_STROKE} />
						<span className="cc-toolbar__item-label">{item.label}</span>
					</button>
				);
			})}
		</div>
	);
}
