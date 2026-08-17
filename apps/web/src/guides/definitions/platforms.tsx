import type { GuideDefinition } from "@/guides/types";
import { TikTokLayout } from "./tiktok-layout";

// Kneecap: these were rendered via a remote logo CDN (brandfetch),
// a network dependency this offline-first editor
// cannot have (the guide picker lives in the editor itself, not just the
// marketing site). Replaced with a local, zero-network monogram badge.
// This also sidesteps tracing/reproducing third-party brand marks.
function PlatformLogo({
	label,
	className = "size-4",
}: {
	label: string;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={`inline-flex items-center justify-center rounded-full bg-muted text-muted-foreground font-semibold ${className}`}
			style={{ fontSize: "0.6em", lineHeight: 1 }}
		>
			{label.charAt(0).toUpperCase()}
		</span>
	);
}

function PlatformGuidePreview({ label }: { label: string }) {
	return <PlatformLogo label={label} />;
}

function platformGuide({
	id,
	label,
}: {
	id: string;
	label: string;
}): GuideDefinition {
	return {
		id,
		label,
		renderPreview: () => <PlatformGuidePreview label={label} />,
		renderTriggerIcon: () => <PlatformLogo label={label} />,
		renderOverlay: () => null,
	};
}

export const tiktokGuide: GuideDefinition = {
	...platformGuide({ id: "tiktok", label: "TikTok" }),
	renderOverlay: () => <TikTokLayout />,
};
export const igReelsGuide = platformGuide({ id: "ig-reels", label: "Reels" });
export const ytShortsGuide = platformGuide({
	id: "yt-shorts",
	label: "Shorts",
});
export const spotlightGuide = platformGuide({
	id: "spotlight",
	label: "Spotlight",
});
