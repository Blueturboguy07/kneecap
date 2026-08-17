# Releasing kneecap

kneecap ships **direct-distribution only** — no App Store, no Play Store
(plan `~/.claude/plans/opencut-mobile-port.md` §8.0 item 5, ratified
2026-08-17; see `docs/DECISIONS.md`). Every release is a GitHub Release
attached to a `v*.*.*` tag, built by
[`.github/workflows/release.yml`](../.github/workflows/release.yml):

- **Android:** a signed release APK, installable directly (sideload).
- **iOS:** an unsigned `.ipa` — there is no CI-held Apple signing
  identity and no store review. See `docs/guides/ios-xcode-build.md` for
  the two ways a real iPhone actually gets this app installed.

This document covers (1) the one-time Android keystore setup a human
does locally, outside of any agent session, and (2) how to cut a
release once that's done. **Nothing in this document or in the release
workflow generates, stores, or embeds secret material in the repo.**
The keystore lives only in your local machine and in GitHub's encrypted
repo secrets store.

---

## 1. One-time setup: the Android release keystore

Do this once, on your own machine, **not** inside an agent session (the
project's engineering rules explicitly keep agent sessions away from
real signing — see the top-level directives this plan operates under).

### 1a. Generate a keystore

```sh
keytool -genkeypair \
  -v \
  -storetype PKCS12 \
  -keystore kneecap-release.keystore \
  -alias kneecap \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000
```

`keytool` will prompt for a store password, a key password, and your
name/org details (these become the certificate's DN — they can be
anything; they are not user-facing). **Write the store password and key
password down somewhere durable** (a password manager) — if the
keystore or its passwords are ever lost, every future release becomes a
*new, different signing identity*, and Android treats an update signed
with a different key as a different app (users would have to uninstall
and reinstall to get updates). Back up `kneecap-release.keystore`
itself the same way.

### 1b. Base64-encode it, for the repo secret

```sh
base64 -i kneecap-release.keystore | tr -d '\n' > kneecap-release.keystore.b64
```

### 1c. Add four repo secrets

Using the [`gh` CLI](https://cli.github.com/) (or the GitHub web UI
under **Settings → Secrets and variables → Actions**):

```sh
gh secret set ANDROID_KEYSTORE_BASE64   --repo Blueturboguy07/kneecap < kneecap-release.keystore.b64
gh secret set ANDROID_KEYSTORE_PASSWORD --repo Blueturboguy07/kneecap   # paste when prompted
gh secret set ANDROID_KEY_ALIAS         --repo Blueturboguy07/kneecap   # "kneecap", if you used the command above
gh secret set ANDROID_KEY_PASSWORD      --repo Blueturboguy07/kneecap   # paste when prompted
```

Then **delete the local `.keystore.b64` file** (keep only the raw
`.keystore` file, backed up privately — the base64 copy has no purpose
once it's in the secret store):

```sh
rm kneecap-release.keystore.b64
```

### 1d. What the workflow does with these

`.github/workflows/release.yml`'s `android-release` job decodes
`ANDROID_KEYSTORE_BASE64` back to a file at runtime, points four
environment variables at it
(`KNEECAP_RELEASE_KEYSTORE{,_PASSWORD}` / `KNEECAP_RELEASE_KEY_{ALIAS,PASSWORD}`),
and runs `./gradlew assembleRelease`.
`apps/mobile/android/app/build.gradle` reads those same four env vars to
build a `signingConfigs.release` block — see the comment at the top of
that file. If the env vars are absent (any build that isn't this
workflow), the `release` build type simply has no signing config and
`assembleRelease` still succeeds, producing an **unsigned** APK. That's
intentional: `bun run android:build:release` (or the underlying
`apps/mobile/scripts/build-android-release.sh`) is always safe to run
locally without the secrets — it just won't be signed, and (verified
directly, running both variants of this exact build locally)
**Android's own tooling also renames the output file** in that case:
`app/build/outputs/apk/release/app-release.apk` when a signing config
was applied, vs. `.../app-release-unsigned.apk` when it wasn't. The
build script above reports whichever one it actually finds.

No iOS secret setup is needed. There is deliberately no CI-held Apple
signing identity for this project (see the "iOS — the honest cost of
no-store" note in plan M13, and `docs/guides/ios-xcode-build.md`).

---

## 2. Cutting a release

Once the keystore secrets exist:

1. Update version numbers (`apps/mobile/android/app/build.gradle`
   `versionCode`/`versionName`; `apps/mobile/ios/App/App.xcodeproj`
   `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`) in a normal commit on
   `main`, and make sure `scripts/invariants.sh` is green on that
   commit.
2. Tag it and push the tag:

   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```

3. `.github/workflows/release.yml` runs automatically:
   - `invariants` — the same full gate as every push to `main`
     (`.github/workflows/bun-ci.yml`, called via `workflow_call`), on
     all three OSes. The rest of the workflow does not start until this
     is green.
   - `android-release` and `ios-release` run in parallel, each building
     its artifact.
   - `publish-release` downloads both, writes a `SHA256SUMS.txt`, and
     creates a GitHub Release on the tag with all three files attached.
4. Once the release is live, update the publik listing (see
   `docs/publik-listing.md`) and the two install guides in
   `docs/guides/` if the flow changed, and re-pin per the usual publik
   ritual.

### Fast rollback

If a release turns out to be broken: delete the GitHub Release and its
tag (`gh release delete vX.Y.Z --cleanup-tag`), and re-point the publik
listing at the last-known-good tag. This is the same "pull the release
asset + repin the guide" ritual used elsewhere — see plan M13 item 5.

---

## 3. Status of this workflow

**The GitHub Actions workflow itself has not had a real run yet** — no
tag has been pushed. What *has* been verified directly, locally, in
this session, against the real Android toolchain (SDK platform 36 /
build-tools 36.0.0, JDK):

- `./gradlew assembleRelease` with `KNEECAP_RELEASE_KEYSTORE*` env vars
  pointed at a throwaway local test keystore (never committed, deleted
  after) **succeeds and produces a genuinely signed APK** —
  `apksigner verify --print-certs` confirmed the output APK's signer
  certificate matches the test keystore's.
- The same build **without** those env vars set also succeeds (doesn't
  break local/CI-without-secrets builds), producing an unsigned APK
  under a different filename (`app-release-unsigned.apk` — see §2's
  note above; `apksigner verify` correctly reports no signature on it).

What has **not** been run in this session: the GitHub Actions workflow
itself (job graph, the `workflow_call` gate, artifact hand-off between
`android-release`/`ios-release` and `publish-release`, `gh release
create`), and the iOS unsigned-`.ipa` packaging step (needs a real
device-SDK Xcode build, not exercised this session — see the M12
handoff for what was and wasn't run there). Verify the full workflow
end to end against a real tag (a `v0.0.0-test`-style tag against a
disposable release is a reasonable first check) before relying on it
for a real release.
