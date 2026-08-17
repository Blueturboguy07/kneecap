import { cn } from "../lib/cn";

export interface TabDef {
	id: string;
	label: string;
}

interface TabBarProps {
	tabs: TabDef[];
	activeId: string;
	onSelect: (id: string) => void;
	className?: string;
}

/**
 * Horizontally-scrollable tab row with a cyan underline on the active tab.
 * Directly measured (corpus 06 §2.2, high-medium confidence) and
 * independently re-confirmed this session by reading
 * iphone_shots/zoom_tabs_ip1.png and zoom_tabs_ip5.png at native
 * resolution: active tab = white/#F5F5F5 text at weight ~600 with a solid
 * cyan (#00CAE0) underline bar; inactive tabs = secondary gray (#8B8A90)
 * at weight ~400, no underline. This is the single best-evidenced pattern
 * in this whole kit.
 */
export function TabBar({ tabs, activeId, onSelect, className }: TabBarProps) {
	return (
		<div className={cn("cc-tabbar", className)} role="tablist">
			{tabs.map((tab) => {
				const active = tab.id === activeId;
				return (
					<button
						key={tab.id}
						type="button"
						role="tab"
						aria-selected={active}
						className={cn("cc-tabbar__tab", active && "cc-tabbar__tab--active")}
						onClick={() => onSelect(tab.id)}
					>
						{tab.label}
						{active && <span className="cc-tabbar__underline" aria-hidden="true" />}
					</button>
				);
			})}
		</div>
	);
}
