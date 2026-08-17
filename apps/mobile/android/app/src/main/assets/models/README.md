# Bundled whisper.cpp models (not committed)

Plan M10: on-device captions must work offline from first launch, so the
GGML model weights ship IN the app bundle — but they are 74–142MB of binary
data with their own (MIT, from `openai/whisper`) license, so they are fetched
at **build time**, never committed to this repo.

Run before building:

```sh
apps/mobile/scripts/download-whisper-model.sh tiny.en --platform android
# and/or, for the quality option (plan M10 item 1, RAM-tier gated):
apps/mobile/scripts/download-whisper-model.sh base.en --platform android
```

This populates `ggml-tiny.en.bin` / `ggml-base.en.bin` directly in this
directory, where `dev.kneecap.app.stt.WhisperTranscriber` expects them
(`assets/models/ggml-{modelSize}.en.bin`). Both are `.gitignore`d
(`app/src/main/assets/models/*.bin` in `apps/mobile/android/.gitignore`).
