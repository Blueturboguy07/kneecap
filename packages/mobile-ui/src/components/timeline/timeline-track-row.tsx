import { useMemo } from "react";
import type { TimelineTrackVM } from "../../timeline/types";
import { visibleClipIndices } from "../../timeline/virtualization";
import type { SnapTarget } from "../../timeline/snapping";
import { TimelineClip, MIN_CLIP_DURATION_SEC, type TrimEdge } from "./timeline-clip";
import { TransitionSquare } from "./transition-square";

const CLIP_OVERSCAN_SEC = 5;

export interface TrimPreview {
	clipId: string;
	edge: TrimEdge;
	boundarySec: number;
}

export function TimelineTrackRow({
	track,
	pixelsPerSecond,
	viewStartSec,
	viewEndSec,
	durationSec,
	selectedClipId,
	onSelectClip,
	trimPreview,
	onTrimPreview,
	onTrimCommit,
	snapTargets,
	snapThresholdSec,
	onKeyframeTap,
	transitionAfterClipIds,
	onTransitionTap,
}: {
	track: TimelineTrackVM;
	pixelsPerSecond: number;
	viewStartSec: number;
	viewEndSec: number;
	durationSec: number;
	selectedClipId: string | null;
	onSelectClip: (params: { clipId: string }) => void;
	trimPreview: TrimPreview | null;
	onTrimPreview: (params: { clipId: string; edge: TrimEdge; boundarySec: number }) => void;
	onTrimCommit: (params: { clipId: string; edge: TrimEdge; boundarySec: number }) => void;
	snapTargets: readonly SnapTarget[];
	snapThresholdSec: number;
	onKeyframeTap?: (params: { clipId: string; keyframeId: string }) => void;
	/** Which afterClipId gaps already have an applied transition — main track only. */
	transitionAfterClipIds?: ReadonlySet<string>;
	onTransitionTap?: (params: { afterClipId: string }) => void;
}) {
	const { startIndex, endIndex } = useMemo(
		() =>
			visibleClipIndices({
				clips: track.clips,
				viewStartSec,
				viewEndSec,
				overscanSec: CLIP_OVERSCAN_SEC,
			}),
		[track.clips, viewStartSec, viewEndSec],
	);

	const visibleClips = endIndex >= startIndex ? track.clips.slice(startIndex, endIndex + 1) : [];

	return (
		<div className={`cc-timeline__track-row cc-timeline__track-row--${track.kind}`}>
			{visibleClips.map((clip, offset) => {
				const index = startIndex + offset;
				const prevClip = track.clips[index - 1];
				const nextClip = track.clips[index + 1];
				const minStartBoundSec = prevClip
					? prevClip.startSec + prevClip.durationSec
					: 0;
				const maxEndBoundSec = nextClip ? nextClip.startSec : durationSec;

				const hasPreview = trimPreview?.clipId === clip.id;
				let effectiveStartSec = clip.startSec;
				let effectiveDurationSec = clip.durationSec;
				if (hasPreview && trimPreview) {
					if (trimPreview.edge === "start") {
						const clampedStart = Math.min(
							trimPreview.boundarySec,
							clip.startSec + clip.durationSec - MIN_CLIP_DURATION_SEC,
						);
						effectiveDurationSec = clip.startSec + clip.durationSec - clampedStart;
						effectiveStartSec = clampedStart;
					} else {
						effectiveDurationSec = Math.max(
							MIN_CLIP_DURATION_SEC,
							trimPreview.boundarySec - clip.startSec,
						);
					}
				}

				return (
					<TimelineClip
						key={clip.id}
						clip={clip}
						effectiveStartSec={effectiveStartSec}
						effectiveDurationSec={effectiveDurationSec}
						pixelsPerSecond={pixelsPerSecond}
						viewStartSec={viewStartSec}
						viewEndSec={viewEndSec}
						isSelected={clip.id === selectedClipId}
						onSelect={onSelectClip}
						onTrimPreview={onTrimPreview}
						onTrimCommit={onTrimCommit}
						minStartBoundSec={minStartBoundSec}
						maxEndBoundSec={maxEndBoundSec}
						snapTargets={snapTargets}
						snapThresholdSec={snapThresholdSec}
						onKeyframeTap={onKeyframeTap}
					/>
				);
			})}
			{track.kind === "main" &&
				onTransitionTap &&
				visibleClips.slice(0, -1).map((clip, offset) => {
					const index = startIndex + offset;
					const next = track.clips[index + 1];
					if (!next) return null;
					const atSec = clip.startSec + clip.durationSec;
					return (
						<TransitionSquare
							key={`transition-${clip.id}`}
							afterClipId={clip.id}
							atSec={atSec}
							pixelsPerSecond={pixelsPerSecond}
							applied={transitionAfterClipIds?.has(clip.id) ?? false}
							onTap={onTransitionTap}
						/>
					);
				})}
		</div>
	);
}
