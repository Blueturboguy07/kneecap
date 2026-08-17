import { Music } from "lucide-react";
import { CC_ICON_STROKE } from "../../tokens";
import { PanelSheet } from "../panel-sheet";
import { SheetHeader } from "../sheet-header";
import type { EditorCore } from "@kneecap/editor-core";
import { getLocalSounds } from "@kneecap/editor-core/sounds/local-sounds";
import { insertLocalSound } from "../../editor/actions";

interface AudioPanelProps {
	editor: EditorCore;
	onClose: () => void;
	onInserted: (ref: { trackId: string; elementId: string }) => void;
}

/**
 * M8 Audio panel — plan M8 item 3: "The Freesound proxy... is cut... Ship
 * a small bundled local sound set instead." Lists `getLocalSounds()`
 * (real, zero-network, procedurally-synthesized WAV data URIs — see
 * `sounds/local-sounds.ts`). Per-clip volume/speed/reverse for an inserted
 * sound are the SAME retimable controls the Edit panel exposes once the
 * clip is selected — not duplicated here.
 */
export function AudioPanel({ editor, onClose, onInserted }: AudioPanelProps) {
	const sounds = getLocalSounds();
	return (
		<PanelSheet onScrimClick={onClose} header={<SheetHeader onClose={onClose} />}>
			<p className="cc-panel-note">Bundled local sounds — no network, no CapCut library clone.</p>
			<div className="cc-panel-actions">
				{sounds.map((sound) => (
					<button
						key={sound.id}
						type="button"
						className="cc-panel-actions__btn"
						onClick={() => {
							const ref = insertLocalSound({
								editor,
								sourceUrl: sound.sourceUrl,
								name: sound.name,
								durationSeconds: sound.durationSeconds,
							});
							if (ref) onInserted(ref);
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
