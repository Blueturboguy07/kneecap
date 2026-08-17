# Install kneecap on iPhone (no App Store)

**Status: DRAFT.** Repo-hosted source for the iOS install guide
referenced in `docs/publik-listing.md` and `docs/RELEASING.md`. Not
published anywhere yet. Screenshots are placeholders and the two paths
below (Xcode-from-source, and the unsigned `.ipa`) have been reviewed
against the actual build scripts and CI workflow in this repo but have
**not** been walked end-to-end on a physical iPhone in this session —
verify against a real device before publishing.

kneecap has **no App Store listing** and never will under the current
plan (M13, ratified 2026-08-17). Apple doesn't allow installing an app
on a real iPhone without *some* form of Apple-issued signature — there
is no path around that, on any iPhone, from any developer. What you get
to choose is **how** that signature happens. Two ways, both free:

| | Path A — Build from source | Path B — Sideload the release `.ipa` |
|---|---|---|
| **You need** | A Mac, Xcode, a free Apple ID | An iPhone-side sideloading tool (AltStore or SideStore) + a computer to install it from |
| **What signs the app** | Xcode, using your free Apple ID's automatic personal-team signing | AltStore/SideStore, using the same free-Apple-ID mechanism, on your behalf |
| **Re-sign needed every** | 7 days (free Apple ID limit) | 7 days (same underlying limit) |
| **Best for** | Developers, anyone comfortable with Xcode | Anyone who wants the pre-built app without building it themselves |

Both paths hit the same Apple-imposed wall: a **free** Apple ID
certificate expires after **7 days**, at which point the app on your
phone stops opening until it's re-signed. This isn't a kneecap
limitation — it's true of every app installed this way, for every
developer, on every free Apple ID. A **paid** Apple Developer account
($99/yr) extends this to 1 year per signature, but nothing here requires
you to pay for one.

---

## Path A — Build from source via Xcode

### Before you start

- A Mac (Apple Silicon or Intel), running a recent macOS.
- [Xcode](https://apps.apple.com/us/app/xcode/id497799835), free from
  the Mac App Store (multi-GB download — do this on Wi-Fi).
- An Apple ID. A free, ordinary one — you do **not** need a paid Apple
  Developer Program membership.
- [`bun`](https://bun.sh) installed (`curl -fsSL https://bun.sh/install | bash`).
- An iPhone, and a cable (or the same Wi-Fi network, for wireless
  Xcode deployment) to connect it to the Mac.

### Steps

1. **Get the source.**
   ```sh
   git clone https://github.com/Blueturboguy07/kneecap.git
   cd kneecap
   ```
   (Or download a release source tag from the Releases page if you'd
   rather not use git.)

2. **Install dependencies and build the web bundle.**
   ```sh
   bun install
   cd apps/mobile
   bun run build
   bunx cap sync ios
   ```

3. **Open the Xcode project.**
   ```sh
   open ios/App/App.xcodeproj
   ```
   (There is no `.xcworkspace` — Capacitor 8's iOS template uses Swift
   Package Manager, not CocoaPods, so the plain `.xcodeproj` is correct.)

4. **Sign in with your Apple ID inside Xcode**, if you haven't already:
   Xcode menu → **Settings** (or **Preferences**) → **Accounts** → **+**
   → **Apple ID**. Sign in with any Apple ID — this is the same one you
   use for iCloud/the App Store, no special enrollment needed.

5. **Point the project at your personal team.** Click the **App**
   project in the file navigator → **App** target → **Signing &
   Capabilities** tab:
   - **Team:** select your name (shows as "*Your Name* (Personal Team)").
   - **Bundle Identifier:** change `dev.kneecap.app` to something with
     your own suffix (e.g. `dev.kneecap.app.yourname`) — a free
     personal-team signature must use an identifier Apple hasn't seen
     from a *different* team before, so a shared value can collide.
   - Leave **Automatically manage signing** checked. Xcode generates a
     free provisioning profile for your device automatically.

6. **Connect your iPhone** via cable (or set up wireless debugging:
   **Window → Devices and Simulators**, select your phone, check
   **Connect via network**). On the phone, tap **Trust This Computer**
   if prompted.

7. **Select your iPhone as the run destination** (top toolbar, next to
   the Stop button — it defaults to a Simulator; change it to your
   physical device) and press **⌘R** (or the ▶ Run button).

8. **First launch on the phone will refuse to open**, showing
   *"Untrusted Developer"*. This is expected — go to **Settings →
   General → VPN & Device Management**, tap your Apple ID under
   **Developer App**, and tap **Trust**.

9. Launch kneecap from the Home Screen. It should open straight to the
   native first-run screen.

### The 7-day limit, and what to do about it

Your free Apple ID's signature expires 7 days after signing. When it
does, kneecap will simply refuse to open again ("Unable to Verify App"
or similar). **Your projects and edits are not lost** — kneecap's
project data lives in the app's local storage, which persists across
a re-sign. To keep using the app: repeat step 7 (plug the phone back
into the same Mac, hit Run again) — Xcode re-signs and reinstalls in
place. Some people script this as a recurring weekly task; there's no
way to avoid it entirely without a paid Apple Developer account.

---

## Path B — Sideload the pre-built unsigned `.ipa`

If you don't want to build from source, every kneecap release also
publishes an **unsigned** `.ipa` on GitHub Releases (see
`docs/RELEASING.md`) — `kneecap-vX.Y.Z-ios-unsigned.ipa`. "Unsigned"
means it's built but has no Apple signature attached yet; a sideloading
tool applies one (using the same free-Apple-ID mechanism as Path A)
when it installs the app onto your phone.

1. Install [AltStore](https://altstore.io) or
   [SideStore](https://sidestore.io) — both are free, open-source
   sideloading tools built specifically for this free-Apple-ID re-sign
   flow. (EU users: Apple's DMA compliance also enables **AltStore
   PAL**, a variant that doesn't require a companion Mac/PC app running
   in the background — check altstore.io for current availability in
   your region.)
2. Follow that tool's own setup guide to link your Apple ID.
3. Download `kneecap-vX.Y.Z-ios-unsigned.ipa` from
   `github.com/Blueturboguy07/kneecap/releases` directly on your
   iPhone (or transfer it from a computer).
4. Open it with AltStore/SideStore (via the share sheet, or the "Add
   from file" action inside the app) — it signs and installs kneecap
   using your Apple ID, the same as Path A's Xcode flow.
5. Trust the developer certificate the first time you open kneecap,
   the same as step 8 above.

Same 7-day re-sign limit applies; AltStore/SideStore can typically
re-sign automatically in the background as long as their companion
app/service stays running and reachable, which is the main practical
difference from Path A.

---

## Why not TestFlight?

TestFlight installs still go through Apple's app review process for
the build being distributed — it isn't a review-free channel. Since
kneecap's plan is explicitly no-App-Store (plan M13), TestFlight is off
the table too; it would reintroduce exactly the review dependency the
no-store decision was made to avoid.

---

*kneecap is an independent, community-built project. It is not
affiliated with, endorsed by, or sponsored by Apple, OpenCut,
OpenCut-app, or any other company or product. See `docs/DECISIONS.md`
for the full attribution posture.*
