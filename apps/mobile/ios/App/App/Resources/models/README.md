# Bundled whisper.cpp models (not committed)

Same build-step download as the Android side — see the sibling README at
`apps/mobile/android/app/src/main/assets/models/README.md` for the full
rationale (offline-from-first-launch requires bundling; not committed
because these are 74–142MB binaries with their own license).

Run before building:

```sh
apps/mobile/scripts/download-whisper-model.sh tiny.en --platform ios
apps/mobile/scripts/download-whisper-model.sh base.en --platform ios
```

**iOS-specific gap, honestly flagged:** this directory is not yet added to
the Xcode project (`App.xcodeproj/project.pbxproj` has no reference to it).
The real whisper.cpp/whisper.swiftui reference app's own documented flow
adds bundled models "via Xcode" (dragging the file into the project so it
becomes a `PBXFileReference` + build-phase resource) — the same
one-real-manual-step-required pattern as this repo's other iOS build
gotchas (Core ML `.mlmodelc` codesigning, per plan M10 item 2). Not
automated in this session — see the M10 handoff for why.
