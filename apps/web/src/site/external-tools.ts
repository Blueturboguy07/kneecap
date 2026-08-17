export type ExternalTool = {
	name: string;
	description: string;
	url: string;
	icon: React.ElementType;
};

// Kneecap: the previous entries here (Marble CMS, Databuddy analytics)
// were both removed network dependencies — see offline-audit. Nothing
// currently integrates with a third-party service, so this list is empty.
export const EXTERNAL_TOOLS: ExternalTool[] = [];
