/**
 * Fixed, centered playhead (corpus 05 §1a). Positioned entirely by CSS
 * (`.cc-timeline__playhead`, `left: 50%`) — it never moves horizontally;
 * timeline-view.tsx moves the SCROLL CONTENT instead so the time under this
 * line stays `currentTimeSec`. See components.css's header comment on this
 * component tree for why that's the opposite of apps/web/src/timeline's
 * desktop model (moving playhead, fixed content).
 */
export function TimelinePlayhead() {
	return <div className="cc-timeline__playhead" aria-hidden="true" />;
}
