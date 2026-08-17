"use client";

import "@kneecap/mobile-ui/tokens.css";
import "@kneecap/mobile-ui/components.css";
import { EditorShell } from "@kneecap/mobile-ui";

/**
 * M8 dev harness — panels/toolbars/export sheet, driven by a REAL
 * `EditorCore` instance (`bootstrapDemoProject` inside `EditorShell`),
 * not mock data. Reachable at /dev/mobile-editor. Not a production route —
 * visual + interaction QA for this milestone, same status as
 * /dev/mobile-timeline (M7) and /dev/mobile-ui (M6).
 *
 * Every control in the primary toolbar / contextual toolbar / panels /
 * export sheet writes through a real `@kneecap/editor-core` command (see
 * `packages/mobile-ui/src/editor/actions.ts`) — this page exists to prove
 * that in a real browser, not to simulate it.
 */
export default function MobileEditorHarnessPage() {
	return (
		<div
			style={{
				minHeight: "100vh",
				background: "#0b0b0b",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: 16,
				padding: 24,
				fontFamily: "system-ui, sans-serif",
				color: "#ddd",
			}}
		>
			<div style={{ maxWidth: 600, fontSize: 13, lineHeight: 1.5 }}>
				<h1 style={{ fontSize: 18, marginBottom: 4 }}>@kneecap/mobile-ui — M8 panels/toolbars/export harness</h1>
				<p style={{ opacity: 0.7 }}>
					Boots a real `EditorCore` project with a text, sticker, graphic-overlay, and library-audio element
					already inserted (see demo-project.ts). Tap the bottom toolbar to open each panel; tap the inserted
					elements&apos; row in the Edit panel after selecting one from Text/Stickers/Audio. Every slider/toggle/
					button mutates real engine state — nothing here is mock data.
				</p>
			</div>
			<div
				style={{
					width: 390,
					height: 700,
					borderRadius: 16,
					overflow: "hidden",
					boxShadow: "0 0 0 1px rgba(255,255,255,0.08)",
				}}
			>
				<EditorShell />
			</div>
		</div>
	);
}
