/**
 * Settings > Licenses: the third-party software in kneecap and its license
 * texts. The list is public/licenses/third-party-licenses.json, made by
 * scripts/generate-licenses.py from the installed packages; it ships in the
 * app, so this screen works offline.
 */
import { getPublikHost } from "@kneecap/native-bridge/publik-host";
import { useEffect, useState } from "react";

const LICENSES_PATH = "/licenses/third-party-licenses.json";

interface LicenseEntry {
	name: string;
	version: string;
	license: string;
	source: string;
	note: string;
	text: string;
}

function isEntry(value: unknown): value is LicenseEntry {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return ["name", "version", "license", "source", "note", "text"].every((key) => typeof v[key] === "string");
}

async function loadLicenses(): Promise<LicenseEntry[]> {
	const res = await fetch(LICENSES_PATH);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data: unknown = await res.json();
	const entries = (data as { entries?: unknown })?.entries;
	if (!Array.isArray(entries)) throw new Error("no entries");
	return entries.filter(isEntry);
}

export function LicensesScreen({ onBack }: { onBack: () => void }) {
	const [entries, setEntries] = useState<LicenseEntry[] | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let live = true;
		loadLicenses().then(
			(list) => {
				if (live) setEntries(list);
			},
			() => {
				if (live) setFailed(true);
			},
		);
		return () => {
			live = false;
		};
	}, []);

	return (
		<div className="kc-settings" data-kneecap-theme="kneecap-mobile">
			<header className="kc-settings__header">
				<button type="button" className="kc-settings__back" aria-label="Back" onClick={onBack}>
					‹
				</button>
				<h1>Licenses</h1>
			</header>
			<div className="kc-settings__body">
				<p className="kc-settings__hint">
					kneecap uses this third-party software. Tap a name to read its license.
				</p>
				{failed ? <p className="kc-settings__note">The license list did not load. Go back and try again.</p> : null}
				{entries === null && !failed ? <p className="kc-settings__note">Loading…</p> : null}
				{entries ? (
					<div className="kc-settings__group">
						{entries.map((entry) => (
							<details key={entry.name} className="kc-licenses__item">
								<summary className="kc-settings__row">
									<span>
										{entry.name}
										{entry.version ? ` ${entry.version}` : ""}
									</span>
									<span className="kc-licenses__kind">{entry.license}</span>
								</summary>
								<div className="kc-licenses__body">
									{entry.note ? <p className="kc-settings__hint">{entry.note}</p> : null}
									{entry.source ? (
										<button
											type="button"
											className="kc-licenses__source"
											onClick={() => void getPublikHost().openUrl({ url: entry.source }).catch(() => {})}
										>
											Source: {entry.source}
										</button>
									) : null}
									<pre className="kc-licenses__text">{entry.text}</pre>
								</div>
							</details>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}
