import { ArrowDown } from "lucide-react";
import { CC_ICON_STROKE } from "../tokens";
import { cn } from "../lib/cn";

export interface ThumbnailDef {
	id: string;
	label?: string;
	imageSrc?: string;
	/** Not yet cached locally — corpus 06 §4/04 §3.6: grid tiles in
	 *  ip_7.jpg carry a download-arrow badge for un-downloaded effects. */
	needsDownload?: boolean;
	/** Corpus 04 §3.3/3.6: gem/diamond badge marks Pro-gated presets.
	 *  kneecap has no paid tier — this prop exists so the visual language
	 *  can be reused for "bundled" vs "not-yet-bundled" or simply omitted
	 *  by a consumer that doesn't need a monetization badge at all. */
	badge?: "pro" | null;
}

interface ThumbnailGridProps {
	items: ThumbnailDef[];
	selectedId?: string | null;
	onSelect?: (id: string) => void;
	columns?: number;
	className?: string;
}

/**
 * Matches iphone_shots/ip_7.jpg (Effects) and ip_1.jpg (Caption styles)
 * exactly: 4-column grid, generously-rounded tiles, top-left download-arrow
 * badge, top-right Pro-gem badge, selected tile gets a light outline ring
 * (same convention corpus 04 §2.1 documents for selected timeline clips —
 * "Clip selection state: white border per CapCut" — reused here for visual
 * consistency across the kit).
 */
export function ThumbnailGrid({
	items,
	selectedId,
	onSelect,
	columns = 4,
	className,
}: ThumbnailGridProps) {
	return (
		<div
			className={cn("cc-thumbgrid", className)}
			style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}
		>
			{items.map((item) => {
				const selected = item.id === selectedId;
				return (
					<button
						key={item.id}
						type="button"
						className={cn("cc-thumb", selected && "cc-thumb--selected")}
						onClick={() => onSelect?.(item.id)}
						aria-pressed={selected}
					>
						{/* Plain <img>, deliberately: this package has no Next.js
						    dependency (it also ships to the plain-Vite apps/mobile
						    shell), so next/image is not available here. */}
						{item.imageSrc && <img src={item.imageSrc} alt="" />}
						{item.needsDownload && (
							<span className="cc-thumb__badge cc-thumb__badge--download" aria-hidden="true">
								<ArrowDown size={11} strokeWidth={CC_ICON_STROKE} />
							</span>
						)}
						{item.badge === "pro" && (
							<span className="cc-thumb__badge cc-thumb__badge--pro" aria-label="Premium">
								◆
							</span>
						)}
						{item.label && <span className="cc-thumb__label">{item.label}</span>}
					</button>
				);
			})}
		</div>
	);
}
