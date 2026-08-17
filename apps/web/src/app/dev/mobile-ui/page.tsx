"use client";

import { useState } from "react";
import "@kneecap/mobile-ui/tokens.css";
import "@kneecap/mobile-ui/components.css";
import {
	AiSparkleIcon,
	BottomToolbar,
	ChipRow,
	ChromaKeyIcon,
	CcSlider,
	ExportButton,
	FreezeFrameIcon,
	KeyframeDiamondIcon,
	PanelSheet,
	ProgressOverlay,
	RippleDeleteIcon,
	SegmentedControl,
	SheetHeader,
	SpeedRampIcon,
	SubToolbar,
	TabBar,
	ThumbnailGrid,
	type ToolbarItemDef,
} from "@kneecap/mobile-ui";
import {
	AudioLines,
	Captions,
	Layers,
	Scissors,
	SlidersHorizontal,
	Sparkles,
	Sticker,
	Type,
	Wand2,
} from "lucide-react";

// Corpus 04 §3: item SET is well-evidenced, left-to-right ORDER is
// [NEEDS-CAPTURE]. This is the canonical superset order assembled by
// cross-referencing all conflicting sources — a starting point for M8,
// not a claimed-verified order.
const PRIMARY_TOOLBAR_ITEMS: ToolbarItemDef[] = [
	{ id: "edit", label: "Edit", icon: Scissors },
	{ id: "audio", label: "Audio", icon: AudioLines },
	{ id: "text", label: "Text", icon: Type },
	{ id: "stickers", label: "Stickers", icon: Sticker },
	{ id: "effects", label: "Effects", icon: Sparkles },
	{ id: "overlay", label: "Overlay", icon: Layers },
	{ id: "filters", label: "Filters", icon: Wand2 },
	{ id: "adjust", label: "Adjust", icon: SlidersHorizontal },
	{ id: "captions", label: "Captions", icon: Captions },
];

const CONTEXTUAL_TOOLBAR_ITEMS: ToolbarItemDef[] = [
	{ id: "split", label: "Split", icon: Scissors },
	{ id: "speedramp", label: "Speed", icon: SpeedRampIcon },
	{ id: "keyframe", label: "Keyframe", icon: KeyframeDiamondIcon },
	{ id: "chroma", label: "Chroma Key", icon: ChromaKeyIcon },
	{ id: "freeze", label: "Freeze", icon: FreezeFrameIcon },
	{ id: "ripple", label: "Ripple Del.", icon: RippleDeleteIcon },
];

const EFFECTS_TABS = [
	{ id: "trending", label: "Trending" },
	{ id: "pro", label: "Pro" },
	{ id: "opening", label: "Opening & Closing" },
	{ id: "nightclub", label: "Nightclub" },
	{ id: "lens", label: "Lens" },
];

const TEXT_TEMPLATE_CHIPS = [
	{ id: "trending", label: "Trending" },
	{ id: "title", label: "Title" },
	{ id: "social", label: "Social media" },
	{ id: "vlog", label: "Vlog" },
];

const EFFECT_THUMBS = Array.from({ length: 8 }, (_, i) => ({
	id: `fx-${i}`,
	needsDownload: i % 3 !== 1,
	badge: i % 4 === 1 ? ("pro" as const) : null,
}));

const ASPECT_SEGMENTS = [
	{ id: "9:16", label: "9:16" },
	{ id: "16:9", label: "16:9" },
	{ id: "1:1", label: "1:1" },
	{ id: "4:5", label: "4:5" },
];

/**
 * M6 dev harness — renders every packages/mobile-ui component inside a
 * 390x844 phone frame (plan M6 exit criterion: "renders in the harness...
 * at 320pt-430pt widths with no horizontal overflow"). Not a production
 * route; visual QA only. Reachable at /dev/mobile-ui.
 */
export default function MobileUiHarnessPage() {
	const [primaryActive, setPrimaryActive] = useState<string | null>("text");
	const [contextualActive, setContextualActive] = useState<string | null>(null);
	const [effectsTab, setEffectsTab] = useState("trending");
	const [captionsTab, setCaptionsTab] = useState("trending");
	const [chipActive, setChipActive] = useState<string[]>(["trending"]);
	const [selectedThumb, setSelectedThumb] = useState<string | null>("fx-5");
	const [sliderValue, setSliderValue] = useState(65);
	const [aspect, setAspect] = useState("9:16");
	const [sheetOpen, setSheetOpen] = useState<"effects" | "captions" | null>("effects");
	const [showProgress, setShowProgress] = useState(false);

	return (
		<div
			style={{
				minHeight: "100vh",
				background: "#0b0b0b",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: 24,
				padding: 24,
				fontFamily: "system-ui, sans-serif",
				color: "#ddd",
			}}
		>
			<div style={{ maxWidth: 390, fontSize: 13, lineHeight: 1.5 }}>
				<h1 style={{ fontSize: 18, marginBottom: 4 }}>@kneecap/mobile-ui — M6 harness</h1>
				<p style={{ opacity: 0.7 }}>
					390×844 phone frame. Every value carrying a [NEEDS-CAPTURE] tag in
					tokens.css is a provisional placeholder pending the plan M6a founder
					capture session — see that file&apos;s header for the full provenance
					of every token used below.
				</p>
			</div>

			{/* Phone frame — the harness itself is NOT part of the component kit,
			    just a fixed 390x844 CSS box to verify no horizontal overflow. */}
			<div
				data-kneecap-theme="capcut-mobile"
				style={{
					width: 390,
					height: 844,
					background: "var(--cc-bg-base)",
					borderRadius: 32,
					overflow: "hidden",
					position: "relative",
					display: "flex",
					flexDirection: "column",
					boxShadow: "0 0 0 1px rgba(255,255,255,0.08)",
				}}
			>
				{/* Top bar — corpus 04 §2 anatomy: "Back  [title]  Export" */}
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						padding: "12px 16px",
						flexShrink: 0,
					}}
				>
					<span style={{ fontSize: "var(--cc-text-body)", color: "var(--cc-text-secondary)" }}>
						Back
					</span>
					<ExportButton onClick={() => setShowProgress(true)}>Export</ExportButton>
				</div>

				{/* Preview canvas placeholder */}
				<div
					style={{
						flex: 1,
						minHeight: 0,
						margin: "0 16px",
						borderRadius: "var(--cc-radius-card)",
						background: "var(--cc-bg-panel)",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						color: "var(--cc-text-secondary)",
						fontSize: "var(--cc-text-body)",
					}}
				>
					Preview canvas
				</div>

				{/* Sub-toolbar — contextual, clip-selected */}
				<div style={{ padding: "12px 16px 0" }}>
					<SegmentedControl
						segments={ASPECT_SEGMENTS}
						activeId={aspect}
						onSelect={setAspect}
						aria-label="Aspect ratio"
					/>
				</div>
				<div style={{ padding: "12px 0 0" }}>
					<SubToolbar
						items={CONTEXTUAL_TOOLBAR_ITEMS}
						activeId={contextualActive}
						onSelect={setContextualActive}
					/>
				</div>

				{/* Slider demo */}
				<div style={{ padding: "4px 16px 0" }}>
					<CcSlider value={sliderValue} onChange={setSliderValue} aria-label="Filter intensity" />
				</div>

				{/* Primary bottom toolbar */}
				<BottomToolbar
					items={PRIMARY_TOOLBAR_ITEMS}
					activeId={primaryActive}
					onSelect={(id) => {
						setPrimaryActive(id);
						if (id === "effects") setSheetOpen("effects");
						if (id === "captions") setSheetOpen("captions");
					}}
				/>

				{/* Effects sheet — matches iphone_shots/ip_7.jpg: search + checkmark,
				    bookmark + tabs, 4-col thumbnail grid with download/pro badges. */}
				{sheetOpen === "effects" && (
					<div style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
						<PanelSheet
							onScrimClick={() => setSheetOpen(null)}
							header={
								<SheetHeader
									searchPlaceholder="People are searching Zoom lens"
									onConfirm={() => setSheetOpen(null)}
									showBookmark
									tabs={EFFECTS_TABS}
									activeTabId={effectsTab}
									onTabSelect={setEffectsTab}
								/>
							}
						>
							<ThumbnailGrid
								items={EFFECT_THUMBS}
								selectedId={selectedThumb}
								onSelect={setSelectedThumb}
							/>
						</PanelSheet>
					</div>
				)}

				{/* Captions style sheet — matches iphone_shots/ip_1.jpg: tabs + close
				    X, no search row, chip row for a second axis of filtering. */}
				{sheetOpen === "captions" && (
					<div style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
						<PanelSheet
							onScrimClick={() => setSheetOpen(null)}
							header={
								<SheetHeader
									tabs={EFFECTS_TABS.map((t) => ({ id: t.id, label: t.label }))}
									activeTabId={captionsTab}
									onTabSelect={setCaptionsTab}
									onClose={() => setSheetOpen(null)}
								/>
							}
						>
							<div style={{ marginBottom: 12 }}>
								<ChipRow
									chips={TEXT_TEMPLATE_CHIPS}
									activeIds={chipActive}
									onSelect={(id) => setChipActive([id])}
								/>
							</div>
							<ThumbnailGrid
								items={EFFECT_THUMBS.map((t) => ({ ...t, needsDownload: false }))}
								selectedId={null}
							/>
						</PanelSheet>
					</div>
				)}

				{showProgress && (
					<ProgressOverlay
						percent={42}
						label="Exporting..."
						onCancel={() => setShowProgress(false)}
					/>
				)}
			</div>

			{/* Static QA strip: tab bar + all 6 custom icons at a glance, outside
			    the phone frame so they're visible regardless of sheet state above. */}
			<div
				data-kneecap-theme="capcut-mobile"
				style={{
					width: 390,
					background: "var(--cc-bg-panel)",
					borderRadius: "var(--cc-radius-card)",
					padding: 16,
					display: "flex",
					flexDirection: "column",
					gap: 16,
				}}
			>
				<div>
					<p style={{ fontSize: 11, color: "var(--cc-text-secondary)", marginBottom: 6 }}>
						TabBar (measured — see tokens.css --cc-accent provenance)
					</p>
					<TabBar
						tabs={EFFECTS_TABS}
						activeId={effectsTab}
						onSelect={setEffectsTab}
					/>
				</div>
				<div>
					<p style={{ fontSize: 11, color: "var(--cc-text-secondary)", marginBottom: 6 }}>
						6 custom-drawn icons (plan M6c) — never traced from CapCut
					</p>
					<div style={{ display: "flex", gap: 16, color: "var(--cc-text-primary)" }}>
						<KeyframeDiamondIcon />
						<KeyframeDiamondIcon filled />
						<ChromaKeyIcon />
						<SpeedRampIcon />
						<RippleDeleteIcon />
						<FreezeFrameIcon />
						<AiSparkleIcon />
					</div>
				</div>
			</div>
		</div>
	);
}
