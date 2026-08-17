/**
 * One filmstrip frame slot. If the clip carries a real per-frame URI
 * (`clip.thumbnails[slotSec]` — populated once a consumer wires plan M4's
 * native thumbnail-strip generation) it's rendered directly; otherwise this
 * draws a deterministic placeholder swatch (a hue-shifted gradient keyed on
 * the clip's own `colorHue` + the slot's time) so the filmstrip still reads
 * as "many distinct frames" for layout/virtualization/interaction testing
 * without pretending to be real video content. NOT a claim that this is
 * what CapCut's or this app's real filmstrip will look like — see
 * timeline/types.ts's `TimelineClipVM.thumbnails` doc comment.
 */
export function FilmstripThumbnail({
	widthPx,
	realUri,
	colorHue,
	slotSec,
}: {
	widthPx: number;
	realUri?: string;
	colorHue: number;
	slotSec: number;
}) {
	if (realUri) {
		return (
			<div
				className="cc-timeline__clip-thumbnail"
				style={{ width: widthPx, backgroundImage: `url(${realUri})` }}
			/>
		);
	}

	const hue = (colorHue + slotSec * 11) % 360;
	return (
		<div
			className="cc-timeline__clip-thumbnail"
			style={{
				width: widthPx,
				background: `linear-gradient(180deg, hsl(${hue} 35% 32%) 0%, hsl(${hue} 30% 20%) 100%)`,
			}}
			aria-hidden="true"
		/>
	);
}
