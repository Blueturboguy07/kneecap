/**
 * Settings > Licenses shows the parts that ship in THIS app (blind test 1.0.7,
 * item 10a: the iOS app listed AndroidX and Kotlin). One list file ships in
 * both apps (public/licenses/third-party-licenses.json, made by
 * scripts/generate-licenses.py). That script marks the native parts:
 *  - "@capacitor/ios": the iOS app only;
 *  - "@capacitor/android", and the entries with the note "Android app only."
 *    (AndroidX and Media3, the Kotlin standard library): the Android app only.
 * Every other entry is a shared web part: both apps have it.
 * The web preview (a plain browser) shows all entries.
 */
export type LicensePlatform = "ios" | "android" | "web";

/** The app that has this part: "ios", "android", or null for a shared part (both apps). */
export function licenseApp(entry: { name: string; note: string }): "ios" | "android" | null {
	if (entry.name === "@capacitor/ios" || /\biOS app only\b/.test(entry.note)) return "ios";
	if (entry.name === "@capacitor/android" || /\bAndroid app only\b/.test(entry.note)) return "android";
	return null;
}

/** The entries that ship in the app on `platform`, in list order. "web": all of them. */
export function licensesFor<T extends { name: string; note: string }>(entries: T[], platform: LicensePlatform): T[] {
	if (platform === "web") return entries;
	return entries.filter((entry) => {
		const app = licenseApp(entry);
		return app === null || app === platform;
	});
}
