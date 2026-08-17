import type { NextConfig } from "next";
import { withContentCollections } from "@content-collections/next";

const nextConfig: NextConfig = {
	compiler: {
		removeConsole: process.env.NODE_ENV === "production",
	},
	reactStrictMode: true,
	productionBrowserSourceMaps: true,
	output: "standalone",
	// kneecap M6: @kneecap/mobile-ui ships raw .ts/.tsx source (same
	// "exports": "./src/index.ts" pattern as packages/editor-core), resolved
	// here as a real bun workspace dependency (unlike editor-core, which
	// apps/web reaches via a tsconfig path alias instead — see
	// apps/web/tsconfig.json's comment on why the two packages differ).
	// Next excludes node_modules — symlinked workspace packages included —
	// from its default transform pipeline, so without this the raw TSX
	// would fail to build the moment anything actually imports it.
	//
	// kneecap M8: mobile-ui now depends on @kneecap/editor-core directly
	// (packages/mobile-ui/package.json) so its panels can call real engine
	// commands — a second, independent path to the same engine apps/web's
	// OWN code reaches via the `@/*` tsconfig alias above. Node resolves
	// mobile-ui's import through the node_modules symlink
	// (node_modules/@kneecap/editor-core -> ../../packages/editor-core), so
	// it needs the same raw-source transpile treatment as mobile-ui itself.
	transpilePackages: ["@kneecap/mobile-ui", "@kneecap/editor-core"],
	images: {
		remotePatterns: [
			{
				protocol: "https",
				hostname: "plus.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "lh3.googleusercontent.com",
			},
			{
				protocol: "https",
				hostname: "avatars.githubusercontent.com",
			},
			{
				protocol: "https",
				hostname: "api.iconify.design",
			},
			{
				protocol: "https",
				hostname: "api.simplesvg.com",
			},
			{
				protocol: "https",
				hostname: "api.unisvg.com",
			},
		],
	},
};

// Kneecap: withBotId (Vercel Bot Protection, calls out to a remote
// detection service on every protected route) was removed as a network
// dependency. @content-collections/next only reads local markdown at
// build time (src/lib/changelog/entries/*.md) — no network — so it stays.
export default withContentCollections(nextConfig);
