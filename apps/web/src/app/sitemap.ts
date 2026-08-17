import { SITE_URL } from "@/site/brand";
import type { MetadataRoute } from "next";

// Kneecap: the blog (Marble CMS) was removed as a network dependency
// (see docs/DECISIONS.md / offline-audit) so post pages no longer exist.
export default function sitemap(): MetadataRoute.Sitemap {
	return [
		{
			url: SITE_URL,
			lastModified: new Date(),
			changeFrequency: "weekly",
			priority: 1,
		},
		{
			url: `${SITE_URL}/contributors`,
			lastModified: new Date(),
			changeFrequency: "daily",
			priority: 0.5,
		},
		{
			url: `${SITE_URL}/roadmap`,
			lastModified: new Date(),
			changeFrequency: "weekly",
			priority: 1,
		},
		{
			url: `${SITE_URL}/privacy`,
			lastModified: new Date(),
			changeFrequency: "monthly",
			priority: 0.5,
		},
		{
			url: `${SITE_URL}/terms`,
			lastModified: new Date(),
			changeFrequency: "monthly",
			priority: 0.5,
		},
		{
			url: `${SITE_URL}/why-not-capcut`,
			lastModified: new Date(),
			changeFrequency: "yearly",
			priority: 1,
		},
	];
}
