#!/usr/bin/env python3
"""Make public/licenses/third-party-licenses.json: the third-party software in
kneecap and its license texts. Settings > Licenses shows it.

Run after `bun install`, when a dependency is added, removed or updated:

    python3 apps/mobile/scripts/generate-licenses.py

It reads the license files from the installed node_modules (the JS that the
web bundle includes) and from this repo (the fonts). The native libraries
(Capacitor iOS/Android, AndroidX, Media3, Kotlin) have fixed entries below.
"""
import json
import re
from pathlib import Path

MOBILE = Path(__file__).resolve().parent.parent
REPO = MOBILE.parent.parent
OUT = MOBILE / "public" / "licenses" / "third-party-licenses.json"
SEARCH = [MOBILE / "node_modules", REPO / "packages" / "editor-core" / "node_modules",
          REPO / "packages" / "mobile-ui" / "node_modules", REPO / "node_modules"]

# The packages whose code is in the app (dependencies of apps/mobile and packages/*).
JS = [
    ("react", "https://github.com/facebook/react"),
    ("react-dom", "https://github.com/facebook/react"),
    ("@capacitor/core", "https://github.com/ionic-team/capacitor"),
    ("@capacitor/ios", "https://github.com/ionic-team/capacitor"),
    ("@capacitor/android", "https://github.com/ionic-team/capacitor"),
    ("radix-ui", "https://github.com/radix-ui/primitives"),
    ("lucide-react", "https://github.com/lucide-icons/lucide"),
    ("class-variance-authority", "https://github.com/joe-bell/cva"),
    ("clsx", "https://github.com/lukeed/clsx"),
    ("tailwind-merge", "https://github.com/dcastil/tailwind-merge"),
    ("culori", "https://github.com/Evercoder/culori"),
    ("eventemitter3", "https://github.com/primus/eventemitter3"),
    ("mediabunny", "https://github.com/Vanilagy/mediabunny"),
    ("soundtouchjs", "https://github.com/cutterbl/SoundTouchJS"),
]

NOTES = {
    "soundtouchjs": (
        "SoundTouchJS is based on the SoundTouch Audio Processing Library by Olli Parviainen; "
        "JavaScript port by Ryan Berdeen and Jakub Fiala; package by Steve 'Cutter' Blades. "
        "kneecap uses version {version} without changes. The app includes the library's code "
        "unminified. Get the complete source of this version at "
        "https://github.com/cutterbl/SoundTouchJS (tag v{version}) or from the npm package "
        "soundtouchjs@{version}. You may replace the library with a changed version under the "
        "terms of the GNU Lesser General Public License 2.1 below."
    ),
    "mediabunny": "kneecap uses version {version} without changes. Source: https://github.com/Vanilagy/mediabunny.",
}


def package_dir(name: str) -> Path:
    for base in SEARCH:
        if (base / name / "package.json").is_file():
            return (base / name).resolve()
    raise SystemExit(f"{name} is not installed. Run bun install first.")


def license_text(folder: Path) -> str:
    for f in sorted(folder.iterdir()):
        if re.match(r"(?i)^(licen[cs]e|copying)(\.(md|txt))?$", f.name):
            return f.read_text(encoding="utf-8").strip()
    raise SystemExit(f"no license file in {folder}")


def main() -> None:
    entries = []
    apache = None
    for name, source in JS:
        folder = package_dir(name)
        meta = json.loads((folder / "package.json").read_text(encoding="utf-8"))
        text = license_text(folder)
        if meta.get("license") == "Apache-2.0":
            apache = text
        note = NOTES.get(name, "").format(version=meta["version"])
        entries.append({"name": name, "version": meta["version"], "license": meta.get("license", ""),
                        "source": source, "note": note, "text": text})

    opencut = (REPO / "LICENSE").read_text(encoding="utf-8").strip()
    entries.append({"name": "OpenCut (kneecap is built on it; opencut-wasm)", "version": "", "license": "MIT",
                    "source": "https://github.com/OpenCut-app/OpenCut", "note": "", "text": opencut})

    android = "Copyright The Android Open Source Project\n\n" + (apache or "")
    entries.append({"name": "AndroidX (appcompat, core, activity, coordinatorlayout, core-splashscreen) and Media3",
                    "version": "", "license": "Apache-2.0", "source": "https://android.googlesource.com/platform/frameworks/support",
                    "note": "Android app only.", "text": android})
    entries.append({"name": "Kotlin standard library", "version": "", "license": "Apache-2.0",
                    "source": "https://github.com/JetBrains/kotlin", "note": "Android app only.",
                    "text": "Copyright 2010-2026 JetBrains s.r.o. and Kotlin Programming Language contributors.\n\n" + (apache or "")})

    ofl = (MOBILE / "public" / "fonts" / "local" / "OFL-AlbertSans.txt").read_text(encoding="utf-8").strip()
    entries.append({"name": "Albert Sans (font)", "version": "", "license": "OFL-1.1",
                    "source": "https://github.com/usted/Albert-Sans", "note": "", "text": ofl})
    inter = re.sub(r"^Copyright[^\n]*", "Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)", ofl, count=1)
    entries.append({"name": "Inter (font)", "version": "", "license": "OFL-1.1",
                    "source": "https://github.com/rsms/inter", "note": "", "text": inter})

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"generatedBy": "apps/mobile/scripts/generate-licenses.py", "entries": entries},
                              ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(REPO)} ({len(entries)} entries, {OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
