import { timeToPixels } from "../../timeline/time-scale";

/**
 * The small square between two adjacent main-track clips (plan M7 item 6,
 * corpus 05 §5 — direct quote from capcut.com/help/transitions-in-capcut:
 * "Tap the small white square icon between the clips"). Only ever rendered
 * for the `main` track (corpus 05 §5: overlay-track cuts don't get this
 * treatment) at the exact boundary between two clips.
 */
export function TransitionSquare({
	afterClipId,
	atSec,
	pixelsPerSecond,
	applied,
	onTap,
}: {
	afterClipId: string;
	atSec: number;
	pixelsPerSecond: number;
	applied: boolean;
	onTap: (params: { afterClipId: string }) => void;
}) {
	const leftPx = timeToPixels({ timeSec: atSec, pixelsPerSecond });
	return (
		<button
			type="button"
			className={`cc-timeline__transition-square${applied ? " cc-timeline__transition-square--applied" : ""}`}
			style={{ left: leftPx }}
			aria-label={applied ? "Edit transition" : "Add transition"}
			onPointerDown={(event) => {
				event.stopPropagation();
				onTap({ afterClipId });
			}}
		/>
	);
}
