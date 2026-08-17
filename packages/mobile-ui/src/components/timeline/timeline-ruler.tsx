import { useMemo } from "react";
import { rulerTickIntervalSec, rulerTicks, formatRulerTimecode } from "../../timeline/ruler";
import { timeToPixels } from "../../timeline/time-scale";

export function TimelineRuler({
	durationSec,
	pixelsPerSecond,
}: {
	durationSec: number;
	pixelsPerSecond: number;
}) {
	const intervalSec = rulerTickIntervalSec({ pixelsPerSecond });
	const ticks = useMemo(
		() => rulerTicks({ durationSec, intervalSec }),
		[durationSec, intervalSec],
	);

	return (
		<div
			className="cc-timeline__ruler"
			style={{ width: timeToPixels({ timeSec: durationSec, pixelsPerSecond }) }}
			aria-hidden="true"
		>
			{ticks.map((tickSec) => {
				const leftPx = timeToPixels({ timeSec: tickSec, pixelsPerSecond });
				return (
					<div key={tickSec} className="cc-timeline__ruler-tick" style={{ left: leftPx }}>
						<span className="cc-timeline__ruler-label">
							{formatRulerTimecode({ timeSec: tickSec })}
						</span>
					</div>
				);
			})}
		</div>
	);
}
