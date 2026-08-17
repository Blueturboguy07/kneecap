import type { ReactNode } from "react";
import { Bookmark, Check, Search, X } from "lucide-react";
import { CC_ICON_STROKE } from "../tokens";
import { cn } from "../lib/cn";
import { TabBar, type TabDef } from "./tab-bar";

interface SheetHeaderProps {
	/** Search row — matches iphone_shots/ip_7.jpg's Effects sheet: a search
	 *  input with a placeholder-as-suggestion pattern ("People are
	 *  searching Zoom lens") plus a checkmark confirm button. Omit for
	 *  sheets that don't have one (corpus doesn't confirm every sheet has
	 *  search — e.g. Filters is only "likely present," corpus 04 §3.7). */
	searchPlaceholder?: string;
	onSearchChange?: (value: string) => void;
	onConfirm?: () => void;
	/** Close (X) — matches iphone_shots/ip_1.jpg's Captions style sheet.
	 *  Whether a given sheet gets a checkmark, an X, both, or neither is
	 *  itself [NEEDS-CAPTURE] (the two real screenshots evidence one each,
	 *  never both together in the same frame) — both are wired here as
	 *  independent optional props so a consumer can match whichever a
	 *  future capture confirms per sheet type. */
	onClose?: () => void;
	/** Bookmark/saved shortcut — seen to the left of the tab row in
	 *  ip_7.jpg's Effects sheet. */
	showBookmark?: boolean;
	onBookmarkClick?: () => void;
	tabs?: TabDef[];
	activeTabId?: string;
	onTabSelect?: (id: string) => void;
	className?: string;
	children?: ReactNode;
}

export function SheetHeader({
	searchPlaceholder,
	onSearchChange,
	onConfirm,
	onClose,
	showBookmark,
	onBookmarkClick,
	tabs,
	activeTabId,
	onTabSelect,
	className,
	children,
}: SheetHeaderProps) {
	const hasSearchRow = searchPlaceholder !== undefined || onConfirm;
	return (
		<div className={cn("cc-sheet-header-group", className)}>
			{hasSearchRow && (
				<div className="cc-sheet-header">
					{searchPlaceholder !== undefined && (
						<label className="cc-sheet-header__search">
							<Search
								size={18}
								strokeWidth={CC_ICON_STROKE}
								color="var(--cc-text-secondary)"
								aria-hidden="true"
							/>
							<input
								type="text"
								placeholder={searchPlaceholder}
								onChange={(e) => onSearchChange?.(e.target.value)}
							/>
						</label>
					)}
					{onConfirm && (
						<button
							type="button"
							className="cc-sheet-header__icon-btn"
							onClick={onConfirm}
							aria-label="Confirm"
						>
							<Check size={22} strokeWidth={CC_ICON_STROKE} />
						</button>
					)}
				</div>
			)}
			{tabs && tabs.length > 0 && (
				<div className="cc-sheet-header" style={{ paddingTop: 0 }}>
					{showBookmark && (
						<button
							type="button"
							className="cc-sheet-header__icon-btn"
							onClick={onBookmarkClick}
							aria-label="Saved"
							style={{ width: "auto", flexShrink: 0 }}
						>
							<Bookmark size={18} strokeWidth={CC_ICON_STROKE} />
						</button>
					)}
					<TabBar
						tabs={tabs}
						activeId={activeTabId ?? tabs[0].id}
						onSelect={(id) => onTabSelect?.(id)}
						className="cc-sheet-header__tabbar"
					/>
					{onClose && (
						<button
							type="button"
							className="cc-sheet-header__icon-btn"
							onClick={onClose}
							aria-label="Close"
							style={{ width: "auto", flexShrink: 0 }}
						>
							<X size={22} strokeWidth={CC_ICON_STROKE} />
						</button>
					)}
				</div>
			)}
			{children}
		</div>
	);
}
