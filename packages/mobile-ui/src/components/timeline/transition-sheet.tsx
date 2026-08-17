import { useState } from "react";
import { Check } from "lucide-react";
import { CC_ICON_STROKE } from "../../tokens";
import { PanelSheet } from "../panel-sheet";
import { CcSlider } from "../slider";
import { SegmentedControl } from "../segmented-control";
import { formatClipDuration } from "./timeline-clip";

const TRANSITION_KINDS = [
	{ id: "fade", label: "Fade" },
	{ id: "slide", label: "Slide" },
	{ id: "zoom", label: "Zoom" },
];

/**
 * The transition picker sheet (plan M7 item 6). Duration slider is bounded
 * by `maxDurationSec` (available trim room on both neighbors — computed by
 * the caller, timeline-view.tsx, from the two adjacent clips' durations,
 * per corpus 05 §5 direct quote: "very short clips can limit how much
 * duration is available"). "Apply to all" is scoped to the main track only
 * (corpus 05 §5's own caveat: "cuts on separate tracks and overlay clips
 * may not change").
 *
 * IMPORTANT HONESTY NOTE: `onConfirm` updates only this component tree's
 * own local view-model state (see timeline-view.tsx's `transitions` state).
 * `packages/editor-core/src/edl/types.ts`'s `EdlTransition` producer status
 * is explicitly frozen at "always []" (that file's own comment: "the
 * inherited engine has no transition model") — so a transition applied
 * here is NOT yet visible in `buildEdl()` output or in the actual preview
 * renderer. Wiring a real transition data model into editor-core is a
 * separate, not-yet-scoped piece of work; this sheet is real, tested UI
 * with nothing real underneath it yet.
 */
export function TransitionSheet({
	afterClipId,
	initialDurationSec,
	maxDurationSec,
	onConfirm,
	onClose,
}: {
	afterClipId: string;
	initialDurationSec: number;
	maxDurationSec: number;
	onConfirm: (params: {
		afterClipId: string;
		kind: string;
		durationSec: number;
		applyToAll: boolean;
	}) => void;
	onClose: () => void;
}) {
	const [kind, setKind] = useState(TRANSITION_KINDS[0].id);
	const [durationSec, setDurationSec] = useState(
		Math.min(initialDurationSec, maxDurationSec),
	);
	const [applyToAll, setApplyToAll] = useState(false);

	return (
		<PanelSheet onScrimClick={onClose}>
			<div className="cc-sheet-header-group">
				<div className="cc-sheet-header">
					<span style={{ flex: 1, fontSize: "var(--cc-text-title)" }}>
						Transition
					</span>
					<button
						type="button"
						className="cc-sheet-header__icon-btn"
						aria-label="Confirm transition"
						onClick={() =>
							onConfirm({ afterClipId, kind, durationSec, applyToAll })
						}
					>
						<Check size={22} strokeWidth={CC_ICON_STROKE} />
					</button>
				</div>
			</div>
			<div style={{ display: "flex", gap: "var(--cc-space-3)", padding: "0 var(--cc-space-4)" }}>
				<SegmentedControl
					segments={TRANSITION_KINDS}
					activeId={kind}
					onSelect={setKind}
					aria-label="Transition style"
				/>
			</div>
			<div style={{ padding: "var(--cc-space-4)", display: "flex", flexDirection: "column", gap: "var(--cc-space-2)" }}>
				<span style={{ fontSize: "var(--cc-text-label)", color: "var(--cc-text-secondary)" }}>
					Duration — {formatClipDuration({ durationSec })}
				</span>
				<CcSlider
					value={durationSec}
					min={0.1}
					max={Math.max(0.1, maxDurationSec)}
					step={0.1}
					onChange={setDurationSec}
					aria-label="Transition duration"
				/>
			</div>
			<div style={{ padding: "0 var(--cc-space-4) var(--cc-space-4)" }}>
				<SegmentedControl
					segments={[
						{ id: "this", label: "This transition" },
						{ id: "all", label: "Apply to all" },
					]}
					activeId={applyToAll ? "all" : "this"}
					onSelect={(id) => setApplyToAll(id === "all")}
					aria-label="Apply scope"
				/>
			</div>
		</PanelSheet>
	);
}
