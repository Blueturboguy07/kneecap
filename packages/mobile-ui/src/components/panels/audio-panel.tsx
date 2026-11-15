import { FolderOpen, Music } from "lucide-react";
import { CC_ICON_STROKE } from "../../tokens";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import type { EditorCore } from "@kneecap/editor-core";
import { getLocalSounds } from "@kneecap/editor-core/sounds/local-sounds";
import { importAndPlaceAudio, insertLocalSound } from "../../editor/actions";
import { useState } from "react";

interface AudioPanelProps {
	editor: EditorCore;
	onClose: () => void;
	onInserted: (ref: { trackId: string; elementId: string }) => void;
}

/**
 * M8 Audio panel — plan M8 item 3: "The Freesound proxy... is cut... Ship
 * a small bundled local sound set instead." Lists `getLocalSounds()`
 * (real, zero-network, procedurally-synthesized WAV sounds — see
 * `sounds/local-sounds.ts`). Blind test round 2: each sound is a file of the
 * app (`public/sounds/<id>.wav`) and goes through the SAME native import as
 * "Import audio from Files", so the preview and the export play it.
 * Per-clip volume/speed/reverse for an inserted
 * sound are the SAME retimable controls the Edit panel exposes once the
 * clip is selected — not duplicated here.
 */
export function AudioPanel({ editor, onClose, onInserted }: AudioPanelProps) {
	const sounds = getLocalSounds();
	const [importing, setImporting] = useState(false);
	const [importError, setImportError] = useState<string | null>(null);
	return (
		<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
			{/* Round 22 (founder): Files-picker audio import onto the audio
			    track. Native shells open the real document picker; the web
			    harness's fallback bridge reports its own honest error. */}
			<button
				type="button"
				className="cc-panel-actions__btn"
				disabled={importing}
				onClick={() => {
					setImporting(true);
					setImportError(null);
					importAndPlaceAudio({ editor })
						.then((count) => {
							if (count > 0) onClose();
						})
						.catch((error: unknown) =>
							setImportError(error instanceof Error ? error.message : String(error)),
						)
						.finally(() => setImporting(false));
				}}
			>
				<FolderOpen size={20} strokeWidth={CC_ICON_STROKE} />
				<span>{importing ? "Importing…" : "Import audio from Files"}</span>
			</button>
			{importError && <p className="cc-panel-note">{importError}</p>}
			<p className="cc-panel-note">Bundled local sounds — they work offline.</p>
			<div className="cc-panel-actions">
				{sounds.map((sound) => (
					<button
						key={sound.id}
						type="button"
						className="cc-panel-actions__btn"
						disabled={importing}
						onClick={() => {
							setImporting(true);
							setImportError(null);
							insertLocalSound({
								editor,
								bundledPath: sound.bundledPath,
								name: sound.name,
								durationSeconds: sound.durationSeconds,
							})
								.then((ref) => {
									if (ref) onInserted(ref);
								})
								.catch((error: unknown) =>
									setImportError(error instanceof Error ? error.message : String(error)),
								)
								.finally(() => setImporting(false));
						}}
					>
						<Music size={20} strokeWidth={CC_ICON_STROKE} />
						<span>{sound.name}</span>
					</button>
				))}
			</div>
		</PanelSheet>
	);
}
