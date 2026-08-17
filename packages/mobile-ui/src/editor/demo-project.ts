/**
 * M8 dev-harness bootstrap. Builds a REAL `EditorCore` project (persisted
 * through `storageService`/IndexedDB, same path the desktop editor uses —
 * `editor.project.createNewProject`) with a handful of REAL elements
 * inserted through the REAL command pipeline (`InsertElementCommand`, the
 * same class the desktop assets panel calls), not hand-built state.
 *
 * Scope note: no video/image element is created here. Both require a real
 * decoded `MediaAsset` (`MediaManager.addMediaAsset`), which is import-flow
 * work (plan M4), out of scope for M8 (panels/toolbars/export sheet). Every
 * panel this milestone builds (Filters/Adjust/Effects/Overlay's
 * opacity+blendMode) operates on `VisualElement`, which text/sticker/graphic
 * elements satisfy identically to video/image — the exact same command
 * path (`AddClipEffectCommand`, `UpdateElementsCommand`, ...) runs either
 * way, so exercising it against a text/sticker/graphic element is a
 * genuine, non-simulated proof of the wiring, not a lesser stand-in.
 */
import { EditorCore, mediaTimeFromSeconds, ZERO_MEDIA_TIME } from "@kneecap/editor-core";
import { InsertElementCommand } from "@kneecap/editor-core/commands";
import {
	buildTextElement,
	buildLibraryAudioElement,
	buildStickerElement,
	buildGraphicElement,
} from "@kneecap/editor-core/timeline";
import { getLocalSounds } from "@kneecap/editor-core/sounds/local-sounds";
import { browseCategory } from "@kneecap/editor-core/stickers";
import { registerDefaultGraphics } from "@kneecap/editor-core/graphics";

export interface DemoProjectRefs {
	projectId: string;
	textElement: { trackId: string; elementId: string } | null;
	audioElement: { trackId: string; elementId: string } | null;
	stickerElement: { trackId: string; elementId: string } | null;
	overlayElement: { trackId: string; elementId: string } | null;
}

let bootstrapped: Promise<DemoProjectRefs> | null = null;

/** Idempotent within a session — repeated calls return the same in-flight
 *  or already-resolved bootstrap rather than creating a second project. */
export function bootstrapDemoProject(): Promise<DemoProjectRefs> {
	if (!bootstrapped) {
		bootstrapped = runBootstrap();
	}
	return bootstrapped;
}

async function runBootstrap(): Promise<DemoProjectRefs> {
	const editor = EditorCore.getInstance();
	const projectId = await editor.project.createNewProject({
		name: "M8 panel harness",
	});

	const refs: DemoProjectRefs = {
		projectId,
		textElement: null,
		audioElement: null,
		stickerElement: null,
		overlayElement: null,
	};

	// --- Text element (visual, effects-capable, full param set) -----------
	const textCreate = buildTextElement({
		raw: {
			params: {
				content: "kneecap",
				fontSize: 64,
				color: "#f5f5f5",
			},
		},
		startTime: ZERO_MEDIA_TIME,
	});
	const textCommand = new InsertElementCommand({
		element: textCreate,
		placement: { mode: "auto", trackType: "text" },
	});
	editor.command.execute({ command: textCommand });
	const textTrackId = textCommand.getTrackId();
	if (textTrackId) {
		refs.textElement = { trackId: textTrackId, elementId: textCommand.getElementId() };
	}

	// --- Audio element (retimable: speed/volume/reverse/split targets) ----
	const [firstSound] = getLocalSounds();
	if (firstSound) {
		const audioCreate = buildLibraryAudioElement({
			sourceUrl: firstSound.sourceUrl,
			name: firstSound.name,
			duration: mediaTimeFromSeconds({ seconds: firstSound.durationSeconds }),
			startTime: ZERO_MEDIA_TIME,
		});
		const audioCommand = new InsertElementCommand({
			element: audioCreate,
			placement: { mode: "auto", trackType: "audio" },
		});
		editor.command.execute({ command: audioCommand });
		const audioTrackId = audioCommand.getTrackId();
		if (audioTrackId) {
			refs.audioElement = { trackId: audioTrackId, elementId: audioCommand.getElementId() };
		}
	}

	// --- Sticker element (real stickersRegistry: shapes provider) ---------
	try {
		const browsed = await browseCategory({ category: "shapes" });
		const firstSticker = browsed.sections[0]?.items[0];
		if (firstSticker) {
			const stickerCreate = buildStickerElement({
				stickerId: firstSticker.id,
				startTime: ZERO_MEDIA_TIME,
			});
			const stickerCommand = new InsertElementCommand({
				element: stickerCreate,
				placement: { mode: "auto", trackType: "graphic" },
			});
			editor.command.execute({ command: stickerCommand });
			const stickerTrackId = stickerCommand.getTrackId();
			if (stickerTrackId) {
				refs.stickerElement = { trackId: stickerTrackId, elementId: stickerCommand.getElementId() };
			}
		}
	} catch {
		// Sticker provider lookup is not load-bearing for the rest of the
		// harness — the Stickers panel itself still browses/inserts live.
	}

	// --- Overlay graphic (opacity + blend mode live on a SECOND track) ----
	registerDefaultGraphics();
	const overlayCreate = buildGraphicElement({
		definitionId: "rectangle",
		name: "Overlay shape",
		startTime: ZERO_MEDIA_TIME,
		params: { "transform.scaleX": 0.4, "transform.scaleY": 0.4, opacity: 0.8 },
	});
	const overlayCommand = new InsertElementCommand({
		element: overlayCreate,
		placement: { mode: "auto", trackType: "graphic" },
	});
	editor.command.execute({ command: overlayCommand });
	const overlayTrackId = overlayCommand.getTrackId();
	if (overlayTrackId) {
		refs.overlayElement = { trackId: overlayTrackId, elementId: overlayCommand.getElementId() };
	}

	return refs;
}

export function resetDemoProjectBootstrap(): void {
	bootstrapped = null;
}
