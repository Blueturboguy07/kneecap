# Install kneecap on Android (sideload)

**Status: DRAFT.** This is the repo-hosted source for the Android
install guide referenced in `docs/publik-listing.md` and
`docs/RELEASING.md`. It is **not published anywhere yet** — kneecap's
publik listing does not exist yet. Screenshots below are placeholders;
the primary toolbar / timeline / export sheet described in "What you'll
see" don't exist in the app yet (that's plan milestones M6–M9, not yet
built as of this draft) — this guide documents the *intended* v1
install flow so distribution tooling isn't blocked on UI work landing
first. Re-verify every step against a real release APK before
publishing.

kneecap has **no Play Store listing** — this is a deliberate choice
(plan M13, ratified 2026-08-17), not a temporary state. Installing it
means downloading the APK directly from GitHub Releases and allowing
your phone to install it. This is exactly how F-Droid apps, most
emulators, and countless legitimate open-source Android apps are
installed — "sideloading" sounds scarier than it is.

## Before you start

- An Android phone or tablet, Android 10 (API 29) or newer.
- About 200MB of free storage for the app itself, plus room for your
  video projects.
- No Google account, no sign-in, no network connection required after
  the download — kneecap is fully offline once installed.

## Step 1 — Download the APK

1. On your phone, open a browser and go to kneecap's GitHub Releases
   page: `github.com/Blueturboguy07/kneecap/releases`.
2. Find the latest release (top of the list, tagged like `v0.1.0`).
3. Under **Assets**, tap the file ending in `-android.apk` (for
   example `kneecap-v0.1.0-android.apk`).
4. Your phone downloads it to the **Downloads** folder/app.

*(Optional but recommended: also tap `SHA256SUMS.txt` in the same
release and compare the hash against the APK you downloaded, using any
checksum app — this confirms the file wasn't corrupted or tampered
with in transit. Every release is built and signed by the project's own
GitHub Actions workflow — see `docs/RELEASING.md`.)*

## Step 2 — Allow this one install

Android blocks installs from outside the Play Store by default. You'll
turn this on **once, for this one file** — not as a permanent
device-wide setting.

1. Open your **Downloads** app and tap the APK you just downloaded.
2. Android shows a prompt: *"For your security, your phone is not
   allowed to install unknown apps from this source."*
3. Tap **Settings** on that prompt.
4. Toggle **Allow from this source** on for your Files/Downloads app.
5. Go back — the install prompt reappears.

(Exact wording varies slightly by Android version and phone
manufacturer — Samsung, Pixel, and others each skin this dialog a
little differently. The underlying setting is always **Settings →
Apps → [the app you opened the APK with] → Install unknown apps**.)

## Step 3 — Install

1. Tap **Install**.
2. Android may show a Play Protect scan ("this app isn't Play
   Protect certified") — this is expected for any app outside the
   Store, including kneecap. Tap **Install anyway** if prompted.
3. Wait for the install to finish, then tap **Open**.

## Step 4 — First launch

The first screen you see is kneecap's native first-run screen (not a
web page — it loads before anything else does), explaining:

- kneecap needs access to your **Photos & Videos** to import clips
  onto the timeline.
- Everything — editing, effects, export — runs **locally on your
  phone**. kneecap never uploads your media anywhere.

Tap **Get Started**. You'll pick videos from your library the same way
any Android photo picker works — kneecap never sees your whole photo
library, only what you explicitly choose (Android's Photo Picker,
plan M4).

## Updating later

kneecap doesn't auto-update (there's no store to push updates through).
When a new release comes out, repeat Steps 1–3 with the new APK —
Android will offer to **update** rather than install a second copy, as
long as it's signed with the same release key (which it always will
be, from this project's own release pipeline — see
`docs/RELEASING.md`).

## Uninstalling

Same as any app: long-press the icon → **Uninstall**, or **Settings →
Apps → kneecap → Uninstall**. No account to delete, no cloud data to
clean up — there isn't any.

## Troubleshooting

- **"App not installed" error.** Usually means a previous kneecap
  install was signed with a different key (e.g., you had a debug build
  installed from a source build). Uninstall the old one first, then
  install the release APK.
- **Play Protect keeps blocking it.** Play Protect's warning for
  unknown-source apps is informational, not a real detection — you can
  proceed. If you'd rather verify independently, check the APK's SHA-256
  against `SHA256SUMS.txt` in the release (Step 1).
- **"Photo access" doesn't show any videos.** Make sure you selected
  videos (not just photos) in the system picker sheet — tap the picker
  again and switch its filter/tab if your launcher's picker defaults to
  photos.

---

*kneecap is an independent, community-built project. It is not
affiliated with, endorsed by, or sponsored by Google, Android, OpenCut,
OpenCut-app, or any other company or product. See `docs/DECISIONS.md`
for the full attribution posture.*
