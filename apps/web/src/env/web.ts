import { z } from "zod";

// Kneecap: db/auth/CMS/analytics/sound-search env vars were removed along
// with the network features that used them (no Postgres, no better-auth,
// no Marble CMS, no Freesound proxy, no Upstash/Databuddy). This app must
// build and run fully offline with zero required secrets.
const webEnvSchema = z.object({
	// Node
	NODE_ENV: z.enum(["development", "production", "test"]),
	ANALYZE: z.string().optional(),
	NEXT_RUNTIME: z.enum(["nodejs", "edge"]).optional(),

	// Public
	NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
});

export type WebEnv = z.infer<typeof webEnvSchema>;

export const webEnv = webEnvSchema.parse(process.env);
