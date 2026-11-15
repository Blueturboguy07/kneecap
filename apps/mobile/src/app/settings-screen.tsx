/**
 * Settings: the publik account and usage counting (src/publik/publik.ts).
 *
 * Rows, in both gate modes (PUBLIK_GATE_MODE, vite.config.ts):
 *  - signed out (optional mode): "Sign in with publik". It opens the publik
 *    sign-in page in the in-app browser; the app checks every 3 s and when it
 *    comes back to the front.
 *  - signed in: who is signed in, and "Sign out". In required mode the gate
 *    then shows at once, over the app (gate-ui.ts, showGateAfterSignOut).
 *    The status ("publik is not reachable now") is checked again when the
 *    app comes back to the front and when the network changes (publik.ts,
 *    refreshStatusOnChange).
 *  - "Delete account" (signed in only): deletes the publik data on this
 *    phone, then opens publik's bare delete-account page in the in-app
 *    browser (App Store guideline 5.1.1(v)). Signed out, there is no account
 *    to delete, so the row is not there.
 *  - "Count app use": the usage-counting switch (consent.json).
 *  - "Help and support": publik's bare support page in the in-app browser.
 *  - "Privacy policy": publik's bare privacy page in the in-app browser (App
 *    Store guideline 5.1.1(i)).
 *  - "Licenses": the third-party software and its licenses (licenses-screen.tsx).
 *
 * The publik pages that open here are publik's in-app pages: no site menu,
 * footer, prices or plan links (publik.ts: SUPPORT_URL, PRIVACY_URL and
 * DELETE_ACCOUNT_URL).
 *
 * Sign out and Delete account act on this phone first (the key file goes,
 * usage counting stops); revoking the key at publik is best effort with a
 * short time limit (publik.ts, forget), so they finish without a network.
 */
import { getPublikHost } from "@kneecap/native-bridge/publik-host";
import { useEffect, useRef, useState } from "react";
import { LicensesScreen } from "./licenses-screen";
import { showGateAfterSignOut } from "../publik/gate-ui";
import {
	APP_VERSION,
	DELETE_ACCOUNT_URL,
	deletePublikData,
	getStatus,
	onStatus,
	PRIVACY_URL,
	type PublikStatus,
	refreshStatusOnChange,
	setUsageCounting,
	signIn,
	signOut,
	SUPPORT_URL,
	usageCounting,
} from "../publik/publik";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Resolves when the app is in front again (the in-app browser closed). */
function backInFront(): Promise<void> {
	return new Promise((resolve) => {
		const off = getPublikHost().onForeground(() => {
			off();
			resolve();
		});
	});
}

export function SettingsScreen({ onBack }: { onBack: () => void }) {
	const [status, setStatus] = useState<PublikStatus>(getStatus);
	const [usage, setUsage] = useState<{ on: boolean; locked: boolean } | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [page, setPage] = useState<"settings" | "licenses">("settings");
	const signInAbort = useRef<AbortController | null>(null);

	useEffect(() => {
		const off = onStatus(setStatus);
		setStatus(getStatus());
		usageCounting().then(setUsage, () => setUsage(null));
		// Blind test 1.0.7, item 6: "publik is not reachable now" stayed after the network came back.
		const stopRefresh = refreshStatusOnChange();
		return () => {
			off();
			stopRefresh();
			signInAbort.current?.abort();
		};
	}, []);

	const startSignIn = async () => {
		if (busy) return;
		const abort = new AbortController();
		signInAbort.current = abort;
		setBusy(true);
		setNote("Opening publik…");
		try {
			const result = await signIn({
				signal: abort.signal,
				onWaiting: () => setNote("Waiting for you to sign in on the publik page."),
			});
			if (result === "signed_in") setNote(null);
			if (result === "timeout") setNote("No sign-in after 10 minutes. Tap Sign in with publik to try again.");
			if (result === "cancelled") setNote(null);
		} catch (err) {
			setNote(messageOf(err));
		} finally {
			if (signInAbort.current === abort) signInAbort.current = null;
			setBusy(false);
		}
	};

	const doSignOut = async () => {
		if (busy) return;
		const question =
			status.mode === "required"
				? "Sign out of publik? publik kneecap needs a publik sign-in, so it shows Sign in with publik next."
				: "Sign out of publik? publik kneecap keeps working. Usage counting stops.";
		if (!window.confirm(question)) return;
		setBusy(true);
		setNote("Signing out…");
		try {
			await signOut();
			// Blind test 1.0.7, item 5: the gate shows at once, over the app. Before, the app loaded again
			// and showed a blank "Loading…" for 2-3 s.
			if (status.mode === "required") void showGateAfterSignOut();
			setNote(null);
		} catch (err) {
			setNote(messageOf(err));
		} finally {
			setBusy(false);
		}
	};

	const doDeleteAccount = async () => {
		if (busy) return;
		const question =
			"Delete your publik account?\n\n" +
			"This deletes the account for every publik app, not only publik kneecap. Your projects and videos on this phone stay.\n\n" +
			"publik kneecap now deletes its publik data on this phone. Then the publik page opens, where you confirm the deletion.";
		if (!window.confirm(question)) return;
		setBusy(true);
		setNote("Deleting your publik data on this phone…");
		try {
			await deletePublikData();
			await getPublikHost().openUrl({ url: DELETE_ACCOUNT_URL });
			setNote("Confirm the deletion on the publik page.");
			if (status.mode === "required") {
				// The gate shows when the person closes the publik page.
				await backInFront();
				window.location.reload();
				return;
			}
		} catch (err) {
			setNote(messageOf(err));
		} finally {
			setBusy(false);
		}
	};

	const toggleUsage = async (on: boolean) => {
		setUsage((u) => (u ? { ...u, on } : u));
		try {
			await setUsageCounting(on);
		} catch (err) {
			setNote(messageOf(err));
			usageCounting().then(setUsage, () => setUsage(null));
		}
	};

	const account = status.signedIn
		? `${status.handle ? `Signed in as @${status.handle}` : "Signed in to publik"}${status.offline ? ". publik is not reachable now." : ""}`
		: null;

	if (page === "licenses") return <LicensesScreen onBack={() => setPage("settings")} />;

	return (
		<div className="kc-settings" data-kneecap-theme="kneecap-mobile">
			<header className="kc-settings__header">
				<button type="button" className="kc-settings__back" aria-label="Back" onClick={onBack}>
					‹
				</button>
				<h1>Settings</h1>
			</header>
			<div className="kc-settings__body">
				<section className="kc-settings__section" aria-labelledby="kc-settings-publik">
					<h2 id="kc-settings-publik">publik account</h2>
					<div className="kc-settings__group">
						{account ? (
							<>
								<p className="kc-settings__row kc-settings__row--text">{account}</p>
								<button
									type="button"
									className="kc-settings__row"
									disabled={busy}
									onClick={() => void doSignOut()}
								>
									Sign out
								</button>
							</>
						) : (
							<button
								type="button"
								className="kc-settings__row kc-settings__row--primary"
								disabled={busy || status.checking}
								onClick={() => void startSignIn()}
							>
								{status.checking ? "Checking your sign-in…" : "Sign in with publik"}
							</button>
						)}
						{account ? (
							<button
								type="button"
								className="kc-settings__row kc-settings__row--danger"
								disabled={busy}
								onClick={() => void doDeleteAccount()}
							>
								Delete account
							</button>
						) : null}
					</div>
					<p className="kc-settings__note" role="status">
						{note ?? ""}
					</p>
					<p className="kc-settings__hint">
						{status.mode === "optional"
							? "Sign-in is optional. publik kneecap works without an account."
							: "publik kneecap uses your publik account."}
					</p>
				</section>
				<section className="kc-settings__section" aria-labelledby="kc-settings-usage">
					<h2 id="kc-settings-usage">Usage counting</h2>
					<div className="kc-settings__group">
						<label className="kc-settings__row kc-settings__row--switch">
							<span>Count app use</span>
							<input
								type="checkbox"
								role="switch"
								checked={usage?.on ?? false}
								disabled={usage === null || usage.locked}
								onChange={(event) => void toggleUsage(event.target.checked)}
							/>
						</label>
					</div>
					<p className="kc-settings__hint">
						When you are signed in, publik kneecap tells publik when the app opens, and every 30 minutes while it stays
						open. It sends no videos, photos or project data.
					</p>
				</section>
				<section className="kc-settings__section" aria-labelledby="kc-settings-about">
					<h2 id="kc-settings-about">About</h2>
					<div className="kc-settings__group">
						<p className="kc-settings__row kc-settings__row--text">publik kneecap {APP_VERSION}</p>
						<button
							type="button"
							className="kc-settings__row"
							onClick={() => void getPublikHost().openUrl({ url: SUPPORT_URL }).catch(() => {})}
						>
							<span>Help and support</span>
							<span aria-hidden="true">›</span>
						</button>
						<button
							type="button"
							className="kc-settings__row"
							onClick={() => void getPublikHost().openUrl({ url: PRIVACY_URL }).catch(() => {})}
						>
							<span>Privacy policy</span>
							<span aria-hidden="true">›</span>
						</button>
						<button type="button" className="kc-settings__row" onClick={() => setPage("licenses")}>
							<span>Licenses</span>
							<span aria-hidden="true">›</span>
						</button>
					</div>
				</section>
			</div>
		</div>
	);
}
