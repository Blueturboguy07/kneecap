/**
 * @kneecap/mobile-ui — CapCut-mobile-pixel-fidelity design tokens +
 * component kit (plan M6, B1 full-fidelity track). Import "./tokens.css"
 * and "./components.css" once (e.g. in the app's root layout or a preview
 * harness) and scope any subtree that should render in this theme with
 * `data-kneecap-theme="capcut-mobile"`.
 */

export { ToolbarRow, type ToolbarItemDef } from "./components/toolbar-row";
export { BottomToolbar } from "./components/bottom-toolbar";
export { SubToolbar } from "./components/sub-toolbar";
export { TabBar, type TabDef } from "./components/tab-bar";
export { PanelSheet } from "./components/panel-sheet";
export { SheetHeader } from "./components/sheet-header";
export { ChipRow, type ChipDef } from "./components/chip-row";
export { ThumbnailGrid, type ThumbnailDef } from "./components/thumbnail-grid";
export { CcSlider } from "./components/slider";
export { SegmentedControl, type SegmentDef } from "./components/segmented-control";
export { ExportButton } from "./components/export-button";
export { ProgressOverlay } from "./components/progress-overlay";

export {
	KeyframeDiamondIcon,
	ChromaKeyIcon,
	SpeedRampIcon,
	RippleDeleteIcon,
	FreezeFrameIcon,
	AiSparkleIcon,
	type CcIconProps,
} from "./icons";

export { CC_ICON_STROKE, ccColor, CONTRAST_PAIRS, type CcColorToken } from "./tokens";
export { cn } from "./lib/cn";
