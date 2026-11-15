#!/usr/bin/env python3
"""Editor test on an iOS simulator (mobile-ci.yml, job "iOS (simulator, unsigned)").

The app under test is a Debug simulator build of the TEST web bundle
(KNEECAP_DEBUG_TOOLS=1, gate required). Its half of the test is the editor CI
mode in src/autotest.tsx. This script:
  - starts a fake publik server on 127.0.0.1 for the sign-in gate (the Debug
    launch setting PUBLIK_API_BASE_URL); it never talks to publikhq.com;
  - installs the app fresh, plants a photo, a test video (H.264 + AAC tone,
    made here with AVAssetWriter), a test audio file (AAC tone, afconvert)
    and the test flags in its data container, grants the Photos "add"
    permission, and launches it three times (a relaunch between the phases);
  - takes a simulator screenshot for every SHOT line, then writes the ack file;
  - judges five tests and exits 1 when one fails:
      A. the editor opens 5 times (new, reopen, reopen, relaunch, reopen,
         reopen) with no crash screen, no uncaught error, no
         "GPU context not initialized", and exactly 1 project;
      B. the preview is one colour when empty, then shows a text element,
         then the photo, and the photo clip on the timeline shows the photo
         (pixel checks on the screenshots);
      D. every Stickers tab shows its images (no broken image), a sticker
         tile adds a sticker, a bundled sound adds an audio clip whose file
         loads (the app undoes both before C);
      C. the export (1 photo 0-3 s + 1 text 0-5 s, 1080p, 30 fps, High)
         makes a file with a video track that lasts as long as the timeline
         (the latest end over all tracks, +-0.15 s), and the export sheet
         ends with "Saved to Photos", "Open Photos" and "Share";
      E. launch 3, a new project: the video imports through the native
         proxy and shows in the preview; Captions "Generate" gives captions
         or a plain message; Split, Duplicate, Delete and Mute work; Import
         audio works; the export has a video track, a sound track that is
         not silent, and the timeline's length.

  python3 scripts/ios-sim-editor-test.py <App.app> <output folder>

Exit 0: all tests pass. 1: a test failed. 2: the test could not run.
"""
import array
import json
import math
import os
import platform
import plistlib
import pty
import queue
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
import wave
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BUNDLE = "dev.kneecap.app"
SCRIPTS = Path(__file__).resolve().parent
FAKE_KEY = "pk_live_editorci"
PHOTO_NAME = "ci-photo.jpg"
VIDEO_NAME = "ci-video.mp4"  # autotest.tsx CI_VIDEO
VIDEO_SECONDS = 4  # autotest.tsx CI_VIDEO_SECONDS
AUDIO_NAME = "ci-audio.m4a"  # autotest.tsx CI_AUDIO
AUDIO_SECONDS = 3  # autotest.tsx CI_AUDIO_SECONDS
PHASES = (1, 2, 3)
START_LIMIT_S = 240  # first launch: boot + gate + app start
# Phase 2 has the stickers and the 5 s export (software encode on a simulator);
# phase 3 has the video proxy, captions and the video export.
PHASE_LIMIT_S = {1: 420, 2: 1200, 3: 1200}
EXPORT_LENGTH_TOLERANCE_S = 0.15
# The plain words the Captions sheet may show (CAPTION_MESSAGES in
# packages/mobile-ui/src/editor/captions-actions.ts).
CAPTION_MESSAGES = (
    "Add a video clip with sound first. Captions come from the sound of your clips.",
    "Your clips have no sound. Add a video clip with sound to make captions.",
    "Captions could not read the sound of your clips. Try again.",
    "No speech was detected anywhere on the timeline.",
)
# Developer words that must never reach a person: a path, a fixture, a stack.
DEV_WORDS = re.compile(
    r"/[\w.-]+/|\bpath\b|fixture|native|error:|undefined|file://|_capacitor_|\bat \S+:\d+|\.(?:js|ts|tsx|swift):\d+",
    re.I,
)

EVENT = re.compile(r"\[editor-ci\] (.*)$")
SHOT = re.compile(
    r"^SHOT name=([a-z0-9-]+) rect=(none|[-\d.]+,[-\d.]+,[-\d.]+,[-\d.]+) viewport=(\d+)x(\d+)"
)
GPU_TEXT = re.compile(r"GPU context not initialized", re.I)
CRASH_TEXT = re.compile(r"kneecap crashed|publik kneecap stopped|kneecap editor failed", re.I)
# App log lines worth showing in the CI log (the export's tracks, the preview backend).
NATIVE_INFO = re.compile(r"\[kneecap-export\]|preview renderer:")


def say(message):
    print(f"editor test: {message}", flush=True)


def run(args, check=True, timeout=300):
    done = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and done.returncode != 0:
        raise RuntimeError(f"{' '.join(args)} failed ({done.returncode}): {done.stderr.strip()[:800]}")
    return done.stdout


# ---------------------------------------------------------------- fake publik

SERVER_LOG = []


class FakePublik(BaseHTTPRequestHandler):
    """The answers apps/mobile/test/publik-gate.test.ts uses: a claimed account."""

    def _send(self, status, body=None):
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        SERVER_LOG.append(f"{time.strftime('%H:%M:%S')} {self.command} {self.path} -> {status}")

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        body = self._body()
        if path == "/api/v1/installs":
            if not str(body.get("app_token", "")).startswith("pat_"):
                return self._send(401, {"error": {"type": "invalid_app_token", "message": "This app token is not valid."}})
            base = f"http://127.0.0.1:{self.server.server_address[1]}"
            return self._send(201, {
                "key": FAKE_KEY,
                "install_id": body.get("install_id") or str(uuid.uuid4()),
                "claim_url": f"{base}/claim/editor-ci",
                "claim_state": "anonymous",
            })
        if path in ("/api/v1/telemetry", "/api/v1/installs/revoke"):
            return self._send(204)
        return self._send(404, {"error": {"type": "not_found", "message": "Not found."}})

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/v1/wallet":
            if self.headers.get("Authorization") != f"Bearer {FAKE_KEY}":
                return self._send(401, {"error": {"type": "invalid_key", "message": "This key is not valid."}})
            base = f"http://127.0.0.1:{self.server.server_address[1]}"
            return self._send(200, {
                "claim_state": "claimed",
                "account": {"handle": "editor-ci"},
                "plan": {"kind": "none", "label": None},
                "balance_micros": 0,
                "claim_url": None,
                "top_up_url": f"{base}/wallet",
                "linked_at": None,
            })
        return self._send(404, {"error": {"type": "not_found", "message": "Not found."}})

    def log_message(self, *args):  # the requests go to SERVER_LOG instead
        pass


# ---------------------------------------------------------------- the photo

def write_png(path, width, height, rows):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + row for row in rows)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
    Path(path).write_bytes(png)


def make_photo(out_dir):
    """A 1200x1600 portrait 'photo': red, green, blue and yellow quarters, each a
    checkerboard with white, so the preview check can find all four colours."""
    width, height, square = 1200, 1600, 100
    colours = {(0, 0): (220, 30, 30), (1, 0): (30, 180, 60), (0, 1): (30, 60, 220), (1, 1): (240, 210, 30)}
    white = bytes((255, 255, 255)) * square
    rows = []
    for y in range(height):
        row = bytearray()
        for bx in range(width // square):
            colour = colours[(int(bx * square >= width // 2), int(y >= height // 2))]
            if (bx + y // square) % 2 == 0:
                row += bytes(colour) * square
            else:
                row += white
        rows.append(bytes(row))
    png = out_dir / "ci-photo.png"
    jpg = out_dir / PHOTO_NAME
    write_png(png, width, height, rows)
    run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "90", str(png), "--out", str(jpg)])
    png.unlink()
    return jpg


def write_wav(path, frequency, seconds, amplitude=0.5, rate=44100):
    """A mono 16-bit sine tone."""
    count = int(seconds * rate)
    peak = amplitude * 32767
    samples = array.array("h", (int(peak * math.sin(2 * math.pi * frequency * i / rate)) for i in range(count)))
    if sys.byteorder == "big":
        samples.byteswap()
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(samples.tobytes())


def make_video(out_dir, tool):
    """The test video: 4 s H.264 1280x720 at 30 fps, red, green, blue and yellow
    quarters (the photo's colours) and a moving white bar, with a 440 Hz AAC
    tone. Returns (path, video-check facts)."""
    tone = out_dir / "ci-video-tone.wav"
    write_wav(tone, 440, VIDEO_SECONDS)
    movie = out_dir / VIDEO_NAME
    out = run([str(tool), "make-video", str(movie), str(tone), str(VIDEO_SECONDS)], check=False, timeout=300)
    tone.unlink(missing_ok=True)
    if not movie.exists():
        raise RuntimeError(f"make-video made no file: {out.strip()[:300]}")
    try:
        info = json.loads(run([str(tool), "video-check", str(movie)], check=False, timeout=120))
    except ValueError:
        info = {}
    return movie, info


def make_audio(out_dir):
    """The test audio file for "Import audio": a 3 s 660 Hz tone as AAC (.m4a)."""
    tone = out_dir / "ci-audio.wav"
    write_wav(tone, 660, AUDIO_SECONDS)
    m4a = out_dir / AUDIO_NAME
    run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "128000", str(tone), str(m4a)], timeout=120)
    tone.unlink(missing_ok=True)
    return m4a


# ---------------------------------------------------------------- simulator

def runtime_version(key):
    tail = key.split("iOS", 1)[-1]
    return tuple(int(n) for n in re.findall(r"\d+", tail))


def pick_device():
    """The newest iOS runtime; a booted iPhone first (the self-test's), else iPhone 17 Pro, else the first iPhone."""
    devices = json.loads(run(["xcrun", "simctl", "list", "devices", "available", "-j"]))["devices"]
    for runtime in sorted((r for r in devices if "iOS" in r), key=runtime_version, reverse=True):
        phones = [d for d in devices[runtime] if d["name"].startswith("iPhone")]
        if not phones:
            continue
        for pick in (
            [d for d in phones if d.get("state") == "Booted"],
            [d for d in phones if d["name"] == "iPhone 17 Pro"],
            phones,
        ):
            if pick:
                return pick[0]["udid"], pick[0]["name"], runtime.rsplit(".", 1)[-1]
    raise RuntimeError("no iPhone simulator")


class AppRun:
    """One launch with `simctl launch --console-pty` inside a pseudo-terminal,
    so the app's console arrives line by line."""

    def __init__(self, udid, port, log_path):
        env = dict(os.environ)
        env["SIMCTL_CHILD_PUBLIK_API_BASE_URL"] = f"http://127.0.0.1:{port}/api/v1"
        env["SIMCTL_CHILD_DO_NOT_TRACK"] = "1"
        master, slave = pty.openpty()
        self.proc = subprocess.Popen(
            # The argument pair is read by UserDefaults: it skips the native first-run screen.
            ["xcrun", "simctl", "launch", "--console-pty", "--terminate-running-process", udid, BUNDLE,
             "-kneecap.hasCompletedFirstRun", "YES"],
            stdin=slave, stdout=slave, stderr=slave, env=env, close_fds=True,
        )
        os.close(slave)
        self.master = master
        self.lines = queue.Queue()
        self.log_path = log_path
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        pending = b""
        with open(self.log_path, "ab") as log:
            while True:
                try:
                    chunk = os.read(self.master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                log.write(chunk)
                log.flush()
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    self.lines.put(line.decode("utf-8", "replace").rstrip("\r"))
        if pending:
            self.lines.put(pending.decode("utf-8", "replace").rstrip("\r"))
        self.lines.put(None)

    def stop(self, udid):
        run(["xcrun", "simctl", "terminate", udid, BUNDLE], check=False)
        try:
            self.proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        try:
            os.close(self.master)
        except OSError:
            pass


# ---------------------------------------------------------------- the test

class EditorTest:
    def __init__(self, app, out):
        self.app = Path(app).resolve()
        self.out = Path(out).resolve()
        self.shots_dir = self.out / "screenshots"
        self.events = []  # (phase, text)
        self.raw_gpu = []  # app console lines with the GPU error text
        self.raw_crash = []
        self.shots = {}  # name -> {"path", "rect", "viewport"}
        self.notes = []  # why the run stopped early
        self.results = []  # (test, name, passed, detail)
        self.fixture_problems = []  # the test video or audio could not be made
        self.udid = None
        self.root = None

    # ----- setup

    def setup(self):
        if not (self.app / "Info.plist").exists():
            raise RuntimeError(f"no app at {self.app}")
        if self.out.exists():
            shutil.rmtree(self.out)
        self.shots_dir.mkdir(parents=True)

        self.tool = self.out / "editor-ci-tool"
        say("compiling the measuring tool (Swift, macOS)")
        # macOS 13: AVAsset.load and AVAssetImageGenerator.image(at:).
        run(["xcrun", "--sdk", "macosx", "swiftc", "-O", "-target", f"{platform.machine()}-apple-macos13.0",
             "-o", str(self.tool), str(SCRIPTS / "ios-sim-editor-tool.swift")], timeout=600)

        self.udid, name, runtime = pick_device()
        say(f"simulator: {name} ({runtime}) {self.udid}")
        run(["xcrun", "simctl", "boot", self.udid], check=False)
        run(["xcrun", "simctl", "bootstatus", self.udid, "-b"], timeout=900)

        # A fresh install: no projects, no publik key from an earlier step.
        run(["xcrun", "simctl", "terminate", self.udid, BUNDLE], check=False)
        run(["xcrun", "simctl", "uninstall", self.udid, BUNDLE], check=False)
        run(["xcrun", "simctl", "install", self.udid, str(self.app)])
        self.grant_photos()

        data = Path(run(["xcrun", "simctl", "get_app_container", self.udid, BUNDLE, "data"]).strip())
        self.root = data / "Library" / "Application Support" / "kneecap"
        media = self.root / "Media"
        media.mkdir(parents=True, exist_ok=True)
        photo = make_photo(self.out)
        shutil.copyfile(photo, media / PHOTO_NAME)
        self.plant_video_and_audio(media)
        (self.root / "autotest.flag").write_text("editor-ci\n")
        # Also skip the first-run screen through the preferences file.
        prefs = data / "Library" / "Preferences"
        prefs.mkdir(parents=True, exist_ok=True)
        with open(prefs / f"{BUNDLE}.plist", "wb") as f:
            plistlib.dump({"kneecap.hasCompletedFirstRun": True}, f)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakePublik)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_address[1]
        say(f"fake publik server: http://127.0.0.1:{self.port}/api/v1")

    def grant_photos(self):
        """The export saves to Photos with the "add only" permission
        (PHPhotoLibrary.requestAuthorization(for: .addOnly) in
        NativeBridgePlugin+Export.swift): simctl's service "photos-add".
        Granted before the first launch, so no permission alert covers the
        app and the sheet can show "Saved to Photos"."""
        results = []
        for service in ("photos-add", "photos"):
            try:
                done = subprocess.run(["xcrun", "simctl", "privacy", self.udid, "grant", service, BUNDLE],
                                      capture_output=True, text=True, timeout=60)
                results.append((service, done.returncode, (done.stderr or done.stdout).strip()[:200]))
            except subprocess.TimeoutExpired:
                results.append((service, -1, "timed out"))
        say("Photos permission: " + "; ".join(
            f"{service} {'granted' if code == 0 else f'NOT granted ({code}: {text})'}" for service, code, text in results))
        if results[0][1] != 0:
            listing = subprocess.run(["xcrun", "simctl", "help", "privacy"], capture_output=True, text=True, timeout=60)
            say("simctl privacy help: " + " ".join((listing.stdout or listing.stderr).split())[:800])

    def plant_video_and_audio(self, media):
        """The test video (made with the measuring tool) and the test audio
        file (afconvert). A failure here fails test E, not the whole run."""
        try:
            movie, info = make_video(self.out, self.tool)
            shutil.copyfile(movie, media / VIDEO_NAME)
            sound = info.get("audio") or {}
            say(f"test video: {float(info.get('durationSeconds') or -1):.2f} s, {info.get('videoTracks', 0)} video and "
                f"{info.get('audioTracks', 0)} audio track(s), {movie.stat().st_size // 1024} KB, "
                f"tone peak {float(sound.get('peak') or 0):.2f} rms {float(sound.get('rms') or 0):.3f}")
            if info.get("videoTracks", 0) < 1 or info.get("audioTracks", 0) < 1 or float(sound.get("rms") or 0) < 0.05:
                self.fixture_problems.append(f"the test video is not right: {json.dumps(info)[:300]}")
        except Exception as error:
            self.fixture_problems.append(f"the test video could not be made: {error}")
        try:
            audio = make_audio(self.out)
            shutil.copyfile(audio, media / AUDIO_NAME)
            say(f"test audio: {audio.name}, {audio.stat().st_size // 1024} KB")
        except Exception as error:
            self.fixture_problems.append(f"the test audio could not be made: {error}")
        for problem in self.fixture_problems:
            say(problem)

    def set_phase_flag(self, phase):
        for p in PHASES:
            flag = self.root / f"editor-ci-phase{p}.flag"
            if p == phase:
                flag.write_text(f"phase {phase}\n")
            elif flag.exists():
                flag.unlink()

    def screenshot(self, name):
        path = self.shots_dir / f"{name}.png"
        run(["xcrun", "simctl", "io", self.udid, "screenshot", "--type=png", str(path)], check=False, timeout=60)
        return path

    # ----- drive

    def drive(self):
        """Three launches. A launch that never STARTs stops the run; a launch
        that starts but does not END still lets the next launch run."""
        all_ended = True
        for phase in PHASES:
            self.set_phase_flag(phase)
            say(f"launch {phase} of {len(PHASES)}")
            app = AppRun(self.udid, self.port, self.out / f"app-launch{phase}.log")
            started = ended = False
            begin = time.time()
            while not ended:
                try:
                    line = app.lines.get(timeout=1.0)
                except queue.Empty:
                    line = ""
                if line is None:
                    self.notes.append(f"launch {phase}: the app stopped before the test ended")
                    self.collect_crash_reports(begin)
                    break
                match = EVENT.search(line) if line else None
                if match:
                    text = match.group(1).strip()
                    self.events.append((phase, text))
                    print(f"  app: {text}"[:500], flush=True)
                    if text.startswith("START"):
                        started = True
                    elif text.startswith("SHOT "):
                        self.on_shot(text)
                    elif text.startswith("END"):
                        ended = True
                elif line:
                    if GPU_TEXT.search(line):
                        self.raw_gpu.append(line.strip()[:300])
                    if CRASH_TEXT.search(line):
                        self.raw_crash.append(line.strip()[:300])
                    if NATIVE_INFO.search(line):
                        print(f"  app log: {line.strip()}"[:300], flush=True)
                waited = time.time() - begin
                if not started and waited > START_LIMIT_S:
                    self.notes.append(
                        f"launch {phase}: no START line in {START_LIMIT_S} s (the gate or the app start failed; "
                        "see screenshots/no-start-*.png and publik-fake-server.log)")
                    self.screenshot(f"no-start-{phase}")
                    break
                if waited > PHASE_LIMIT_S[phase]:
                    self.notes.append(f"launch {phase}: no END line in {PHASE_LIMIT_S[phase]} s")
                    self.screenshot(f"timeout-{phase}")
                    break
            app.stop(self.udid)
            if not started:
                return False
            if not ended:
                all_ended = False
        return all_ended

    def collect_crash_reports(self, since):
        """Copies the host crash reports of the app (simulator apps write them to
        ~/Library/Logs/DiagnosticReports) into the artifact, and prints the
        exception and the first frames of the crashed thread."""
        time.sleep(5)  # the report is written a moment after the process ends
        folder = Path.home() / "Library" / "Logs" / "DiagnosticReports"
        found = []
        for report in sorted(folder.glob("*.ips")) if folder.exists() else []:
            try:
                if report.stat().st_mtime < since - 5:
                    continue
                text = report.read_text(errors="replace")
            except OSError:
                continue
            if "dev.kneecap.app" not in text and '"App"' not in text:
                continue
            target = self.out / f"crash-{report.name}"
            target.write_text(text)
            found.append(target)
            try:
                body = json.loads(text.split("\n", 1)[1])
                exc = body.get("exception", {})
                say(f"crash report {report.name}: {exc.get('type')} {exc.get('signal')} {body.get('termination', {}).get('indicator', '')}")
                threads = body.get("threads", [])
                images = body.get("usedImages", [])
                for thread in threads:
                    if not thread.get("triggered"):
                        continue
                    for frame in thread.get("frames", [])[:20]:
                        image = images[frame.get("imageIndex", 0)].get("name", "?") if images else "?"
                        say(f"  {image} {frame.get('symbol', '?')} +{frame.get('symbolLocation', 0)}")
                reasons = body.get("asi") or body.get("lastExceptionBacktrace")
                if reasons:
                    say(f"  asi/last exception: {json.dumps(reasons)[:1500]}")
            except Exception as error:  # a report in another format: the file is in the artifact
                say(f"crash report {report.name}: saved ({error})")
        if not found:
            say("no crash report for the app in ~/Library/Logs/DiagnosticReports")

    def on_shot(self, text):
        match = SHOT.match(text)
        if not match:
            return  # a "SHOT name=... NOACK" line
        name = match.group(1)
        path = self.screenshot(name)
        rect = None if match.group(2) == "none" else [float(v) for v in match.group(2).split(",")]
        self.shots[name] = {"path": path, "rect": rect, "viewport": [int(match.group(3)), int(match.group(4))]}
        (self.root / f"ci-ack-{name}").write_text("ok\n")

    # ----- judge

    def record(self, test, name, passed, detail):
        self.results.append((test, name, passed, detail))
        say(f"{test} {name}: {'PASS' if passed else 'FAIL'} ({detail})")
        if not passed:
            print(f"::error title=editor test {test}::{name}: {detail}", flush=True)

    def texts(self, prefix, phase=None):
        return [(p, text) for p, text in self.events if text.startswith(prefix) and phase in (None, p)]

    def last(self, prefix, phase=None):
        """The text of the last line with this prefix, or None."""
        found = self.texts(prefix, phase)
        return found[-1][1] if found else None

    def json_line(self, prefix, phase=None):
        """The JSON object after the prefix of the last such line, or None."""
        text = self.last(prefix, phase)
        if text is None:
            return None
        try:
            value = json.loads(text[len(prefix):].strip())
        except ValueError:
            return {"_unreadable": text[:200]}
        return value if isinstance(value, dict) else {"_unreadable": text[:200]}

    def timeline_end(self, phase):
        """The latest end over all tracks that the app logged before its export."""
        text = self.last("TIMELINE ", phase)
        m = re.match(r"TIMELINE end=([\d.]+)", text or "")
        return (float(m.group(1)), text) if m else (None, text)

    def export_movie(self, phase, copy_name):
        """The exported file of a launch, checked by the measuring tool.
        Returns (facts or None, problem text or None)."""
        text = self.last("EXPORT DONE", phase)
        failed = self.last("EXPORT FAIL", phase)
        if failed and not text:
            return None, failed[:300]
        if not text:
            return None, "the app logged no export result"
        if "via=direct" in text:
            print(f"::warning title=editor test::launch {phase}: the export sheet was not found, "
                  "the test used the direct export call", flush=True)
        logged = urllib.parse.unquote(text.split(" path=", 1)[1].strip()) if " path=" in text else ""
        movie = Path(logged) if logged else None
        if not movie or not movie.exists():
            found = sorted((self.root / "Exports").glob("*.mp4"), key=lambda p: p.stat().st_mtime)
            movie = found[-1] if found else None
        if not movie:
            return None, f"no file at {logged or '(no path)'} and none in Exports/"
        copy = self.out / copy_name
        shutil.copyfile(movie, copy)
        out = run([str(self.tool), "video-check", str(copy)], check=False, timeout=300)
        try:
            info = json.loads(out)
        except ValueError:
            info = {"error": out.strip()[:200] or "no answer"}
        info["kilobytes"] = copy.stat().st_size // 1024
        (self.out / f"{copy.stem}-metrics.json").write_text(json.dumps(info, indent=2))
        return info, None

    def problems(self, steps, kinds):
        found = []
        for _, text in self.texts("PROBLEM "):
            m = re.match(r"PROBLEM step=(\S+) kind=(\S+) (.*)", text)
            if m and m.group(1) in steps and m.group(2) in kinds:
                found.append(f"{m.group(2)}: {m.group(3)[:200]}")
        return found

    def judge_a(self):
        opens = {}
        for _, text in self.texts("OPEN "):
            m = re.match(r"OPEN n=(\d+) kind=(\w+)( extra=1)? (PASS|FAIL)\s*(.*)", text)
            if not m or m.group(3):
                continue
            n = int(m.group(1))
            if m.group(4) == "FAIL" or n not in opens:
                opens[n] = (m.group(4), m.group(5)[:200])
        failed = [f"open {n}: {opens[n][1] if n in opens else 'never ran'}"
                  for n in range(1, 6) if opens.get(n, ("FAIL",))[0] != "PASS"]
        passed_count = 5 - len(failed)
        self.record("A", "editor opens 5 times in a row", not failed,
                    f"{passed_count}/5 opened" + (f"; {'; '.join(failed)}" if failed else ""))

        bad_counts = []
        for phase, text in self.texts("PROJECTS "):
            m = re.match(r"PROJECTS when=(\S+) count=(\d+)", text)
            if not m or phase == 3:
                continue  # launch 3 makes its own project on purpose (test E checks its count)
            want = 0 if (phase == 1 and m.group(1) == "start") else 1
            if m.group(1).startswith("before-open-"):
                continue  # only for the extra opens
            if int(m.group(2)) != want:
                bad_counts.append(f"launch {phase} {m.group(1)}: {m.group(2)} projects, want {want}")
        self.record("A", "no extra project after an open", not bad_counts,
                    "; ".join(bad_counts) if bad_counts else "1 project the whole time")

        crash = self.problems({"boot", "A"}, {"uncaught", "unhandled-rejection", "crash", "driver"})
        crash += [f"app log: {line}" for line in self.raw_crash]
        self.record("A", "no crash screen or uncaught error", not crash, "; ".join(crash[:3]) if crash else "none")

        gpu = self.problems({"boot", "A", "B", "C", "D", "E"}, {"gpu"}) + [f"app log: {line}" for line in self.raw_gpu]
        self.record("A", 'no "GPU context not initialized"', not gpu, "; ".join(gpu[:3]) if gpu else "none")

    def measure(self, name, rect=None):
        shot = self.shots.get(name)
        rect = rect or (shot["rect"] if shot else None)
        if not shot or not rect or not shot["path"].exists():
            return None, f"no screenshot '{name}' with a preview area"
        x, y, w, h = rect
        vw, vh = shot["viewport"]
        out = run([str(self.tool), "image-stats", str(shot["path"]), str(x), str(y), str(w), str(h), str(vw), str(vh)],
                  check=False, timeout=120)
        try:
            return json.loads(out), None
        except ValueError:
            return None, f"could not measure '{name}'"

    def judge_b(self):
        if self.texts("B SKIP"):
            self.record("B", "preview shows text and photo", False, "the editor did not open")
            return
        metrics = {}
        for name in ("empty", "text", "photo"):
            stats, error = self.measure(name)
            metrics[name] = stats
            if error:
                self.record("B", f"screenshot {name}", False, error)
        (self.out / "preview-metrics.json").write_text(json.dumps(metrics, indent=2))
        empty, text, photo = metrics["empty"], metrics["text"], metrics["photo"]
        if empty:
            off = empty["offFraction"]
            self.record("B", "empty preview is one colour (the preview area is right)", off <= 0.003,
                        f"{off:.2%} of the preview is not the main colour")
        text_line = next((t for _, t in self.texts("TEXT ")), "TEXT (no line)")
        if text:
            base = empty["offFraction"] if empty else 0.0
            off = text["offFraction"]
            ok = off >= max(0.004, 3 * base) and text_line.startswith("TEXT PASS")
            self.record("B", "preview draws the text element", ok,
                        f"{off:.2%} of the preview differs from the background (empty: {base:.2%}); {text_line[:120]}")
        import_line = next((t for _, t in self.texts("IMPORT ")), "IMPORT (no line)")
        if photo:
            colours = photo.get("colours", {})
            found = [c for c in ("red", "green", "blue", "yellow") if colours.get(c, 0) >= 0.005]
            ok = len(found) >= 3 and photo["offFraction"] >= 0.15 and import_line.startswith("IMPORT PASS")
            self.record("B", "preview draws the photo", ok,
                        f"photo colours found {len(found)}/4 ({', '.join(found) or 'none'}), "
                        f"{photo['offFraction']:.1%} not background, luma spread {photo['lumaStd']:.0f}; {import_line[:160]}")
        elif not import_line.startswith("IMPORT PASS"):
            self.record("B", "photo import", False, import_line[:200])
        self.judge_clip()
        stop = self.problems({"B"}, {"crash", "driver"})
        if stop:
            self.record("B", "no crash during the preview checks", False, "; ".join(stop[:3]))
        for warning in self.problems({"B"}, {"uncaught", "unhandled-rejection", "render"})[:3]:
            print(f"::warning title=editor test B::{warning}", flush=True)
        for via in [t for _, t in self.texts("TEXT ") + self.texts("IMPORT ") if "via=direct" in t]:
            print(f"::warning title=editor test B::the UI control was not found, the test used the direct call: {via[:160]}", flush=True)

    def judge_clip(self):
        """Blind test item 11: the photo clip on the timeline shows the photo."""
        line = next((t for _, t in self.texts("CLIP ")), "CLIP (no line)")
        m = re.match(r"CLIP kind=image thumbs=(\d+) thumbHeight=([\d.]+) clipHeight=([\d.]+) image=(\S+) "
                     r"rect=([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)", line)
        if not m:
            self.record("B", "timeline photo clip shows the photo", False, line[:200])
            return
        thumbs, slot_h, clip_h, image = int(m.group(1)), float(m.group(2)), float(m.group(3)), m.group(4)
        rect = [float(m.group(i)) for i in range(5, 9)]
        found = []
        stats, error = self.measure("photo", rect) if rect[2] > 0 and rect[3] > 0 else (None, "the clip is off screen")
        if stats:
            colours = stats.get("colours", {})
            found = [c for c in ("red", "green", "blue", "yellow") if colours.get(c, 0) >= 0.005]
        ok = thumbs > 0 and clip_h > 0 and slot_h >= 0.8 * clip_h and re.fullmatch(r"\d+x\d+", image) and len(found) >= 2
        self.record("B", "timeline photo clip shows the photo", bool(ok),
                    f"{thumbs} slot(s), slot height {slot_h:.0f} of {clip_h:.0f} pt, image {image}, "
                    f"photo colours in the clip {len(found)}/4 ({', '.join(found) or 'none'})"
                    + (f"; {error}" if error else ""))

    def judge_c(self):
        if self.texts("C SKIP"):
            self.record("C", "export makes a playable file", False, "the editor did not open")
            return
        info, error = self.export_movie(2, "export.mp4")
        if error:
            self.record("C", "export makes a playable file", False, error)
        else:
            duration = float(info.get("durationSeconds", -1) or -1)
            tracks = info.get("videoTracks", 0)
            ok = duration > 0 and tracks >= 1 and "error" not in info
            size = info.get("naturalSize", ["?", "?"])
            self.record("C", "export makes a playable file", ok,
                        f"{duration:.2f} s, {tracks} video track(s), {size[0]}x{size[1]} at "
                        f"{info.get('nominalFrameRate', 0):.0f} fps, {info.get('kilobytes', 0)} KB"
                        + (f"; {info['error']}" if "error" in info else ""))
            frame = info.get("frame")
            if ok and frame and frame.get("offFraction", 0) < 0.05:
                print("::warning title=editor test C::the exported frame at 0.5 s is almost one colour "
                      "(the photo may be missing from the export)", flush=True)
            # Blind test 1.0.5: photo 0-3 s + text 0-5 s exported 3.00 s.
            end, line = self.timeline_end(2)
            if end is None:
                self.record("C", "export lasts as long as the timeline", False, f"no TIMELINE line ({line or 'none'})")
            else:
                self.record("C", "export lasts as long as the timeline", abs(duration - end) <= EXPORT_LENGTH_TOLERANCE_S,
                            f"file {duration:.2f} s, timeline end {end:.2f} s (latest end over all tracks: "
                            f"{line.split(' tracks=', 1)[-1].split(' ', 1)[0]}), allowed difference "
                            f"{EXPORT_LENGTH_TOLERANCE_S:.2f} s")
        self.judge_export_sheet()
        stop = self.problems({"C"}, {"crash", "driver"})
        if stop:
            self.record("C", "no crash during the export", False, "; ".join(stop[:3]))

    def judge_export_sheet(self):
        """Blind test 1.0.5: a good export ends with "Saved to Photos" and the
        buttons "Open Photos" and "Share" (Photos add permission granted
        before launch); a failed export keeps "Export failed. Try again."."""
        sheet = self.json_line("EXPORT SHEET", 2)
        name = 'export sheet ends with "Saved to Photos", "Open Photos" and "Share"'
        if sheet is None:
            self.record("C", name, False, "the app logged no EXPORT SHEET line (no export through the sheet)")
            return
        if "_unreadable" in sheet:
            self.record("C", name, False, f"could not read: {sheet['_unreadable']}")
            return
        buttons = [str(b).strip() for b in sheet.get("buttons", [])]
        notes = [str(n) for n in sheet.get("notes", [])]
        folded = {b.casefold() for b in buttons}
        detail = f"notes {json.dumps(notes)[:200]}; buttons {json.dumps(buttons)[:300]}"
        if sheet.get("failed"):
            self.record("C", "a failed export shows the plain message", True, 'the sheet says "Export failed. Try again."')
            self.record("C", name, False, f"the export failed; {detail}")
            return
        ok = bool(sheet.get("saved")) and "open photos" in folded and "share" in folded
        if not ok and "could not save" in (" ".join(notes) + " " + str(sheet.get("text", ""))).casefold():
            detail = f"the save to Photos failed (photos-add grant?); {detail}"
        self.record("C", name, ok, detail)

    def judge_d(self):
        """Stickers (every tab, every image), one sticker, one bundled sound."""
        if self.texts("D SKIP"):
            self.record("D", "stickers and bundled sound", False, "the editor did not open")
            return
        tabs = []
        for _, text in self.texts("STICKERS tab=", 2):
            m = re.match(r'STICKERS tab=(".*?") state=(\S+) tiles=(\d+) images=(\d+) ok=(\d+) broken=(\d+) '
                         r"blank=(\d+) timeout=(\d+)(?: first=(\S+))?", text)
            if m:
                tabs.append((json.loads(m.group(1)), m.group(2), int(m.group(3)), int(m.group(4)), int(m.group(5)),
                             int(m.group(6)), int(m.group(7)), int(m.group(8)), m.group(9)))
        failed_open = self.last("STICKERS FAIL", 2)
        if failed_open or not tabs:
            self.record("D", "every sticker tab shows its images", False, failed_open or "the app logged no sticker tab")
        else:
            bad = [t for t in tabs if t[3] == 0 or t[4] != t[3]]
            parts = []
            for label, state, tiles, images, ok, broken, blank, timeout, first in tabs:
                part = f"{label} {ok}/{images} images load"
                if images == 0:
                    part = f"{label} has no images ({tiles} tiles, {state})"
                elif ok != images:
                    part += f" ({broken} broken, {blank} blank, {timeout} timed out; first {first})"
                parts.append(part)
            self.record("D", "every sticker tab shows its images", not bad, f"{len(tabs)} tab(s): " + "; ".join(parts))
        sticker = self.last("STICKER ", 2)
        self.record("D", "a sticker tile adds a sticker to the timeline", bool(sticker and sticker.startswith("STICKER PASS")),
                    (sticker or "no STICKER line")[:240])
        sound = self.last("SOUND ", 2)
        self.record("D", "a bundled sound adds an audio clip and its file loads",
                    bool(sound and sound.startswith("SOUND PASS")), (sound or "no SOUND line")[:300])
        cleanup = self.last("CLEANUP ", 2)
        if cleanup and not cleanup.startswith("CLEANUP PASS"):
            print(f"::warning title=editor test D::the sticker and sound were not undone before C: {cleanup[:200]}", flush=True)
        stop = self.problems({"D"}, {"crash", "driver"})
        if stop:
            self.record("D", "no crash during the sticker and sound checks", False, "; ".join(stop[:3]))
        for warning in self.problems({"D"}, {"uncaught", "unhandled-rejection", "render"})[:3]:
            print(f"::warning title=editor test D::{warning}", flush=True)

    def judge_e(self):
        """Launch 3: the video sweep in a new project."""
        if self.fixture_problems:
            self.record("E", "test video and audio files", False, "; ".join(self.fixture_problems)[:400])
        if not any(p == 3 for p, _ in self.events):
            self.record("E", "video sweep", False, "launch 3 logged nothing")
            return
        skip = self.last("E SKIP", 3)
        if skip and not self.texts("VIDEO-IMPORT", 3):
            self.record("E", "video sweep", False, skip)
            return

        counts = {}
        for _, text in self.texts("PROJECTS ", 3):
            m = re.match(r"PROJECTS when=(\S+) count=(\d+)", text)
            if m:
                counts[m.group(1)] = int(m.group(2))
        if "sweep-start" in counts and "sweep-end" in counts:
            self.record("E", "the new project adds exactly one project", counts["sweep-end"] == counts["sweep-start"] + 1,
                        f"{counts['sweep-start']} before, {counts['sweep-end']} after")
        else:
            self.record("E", "the new project adds exactly one project", False, f"PROJECTS lines: {counts}")

        imported = self.last("VIDEO-IMPORT", 3) or "no VIDEO-IMPORT line"
        self.record("E", "video import through the native proxy", imported.startswith("VIDEO-IMPORT PASS"), imported[:300])
        if not imported.startswith("VIDEO-IMPORT PASS"):
            return

        stats, error = self.measure("video")
        if stats:
            colours = stats.get("colours", {})
            found = [c for c in ("red", "green", "blue", "yellow") if colours.get(c, 0) >= 0.005]
            self.record("E", "preview draws the video", len(found) >= 3 and stats["offFraction"] >= 0.15,
                        f"video colours found {len(found)}/4 ({', '.join(found) or 'none'}), "
                        f"{stats['offFraction']:.1%} not the main colour, luma spread {stats['lumaStd']:.0f}")
        else:
            self.record("E", "preview draws the video", False, error)
        (self.out / "video-preview-metrics.json").write_text(json.dumps(stats, indent=2))

        self.judge_captions()

        for op in ("split", "duplicate", "delete", "mute"):
            line = self.last(f"EDIT op={op} ", 3)
            self.record("E", f"{op} on the video clip", bool(line and re.match(rf"EDIT op={op} PASS", line)),
                        (line or f"no EDIT op={op} line")[:300])

        audio = self.last("AUDIO-IMPORT", 3) or "no AUDIO-IMPORT line"
        self.record("E", "import audio from Files", audio.startswith("AUDIO-IMPORT PASS"), audio[:300])

        self.judge_sweep_export()
        stop = self.problems({"E"}, {"crash", "driver"})
        if stop:
            self.record("E", "no crash during the video sweep", False, "; ".join(stop[:3]))
        for warning in self.problems({"E"}, {"uncaught", "unhandled-rejection", "render"})[:3]:
            print(f"::warning title=editor test E::{warning}", flush=True)

    def judge_captions(self):
        """Captions "Generate" gives captions or one of the plain messages, and
        never a developer word (a path, "fixture", "native", "Error:", a stack)."""
        name = "captions give captions or a plain message"
        line = self.last("CAPTIONS ", 3)
        if line is None or line.startswith("CAPTIONS FAIL"):
            self.record("E", name, False, (line or "no CAPTIONS line")[:300])
            return
        result = self.json_line("CAPTIONS ", 3)
        if "_unreadable" in result:
            self.record("E", name, False, f"could not read: {result['_unreadable']}")
            return
        state = result.get("state")
        captions = int(result.get("captions") or 0)
        message = str(result.get("message") or "").strip()
        dev = DEV_WORDS.search(message)
        plain = message == "" or message in CAPTION_MESSAGES
        ok = state != "timeout" and not dev and plain and (captions > 0 or message in CAPTION_MESSAGES)
        detail = (f"{state} after {int(result.get('ms') or 0) / 1000:.0f} s, {captions} caption(s), "
                  f"message {json.dumps(message)[:200]}")
        if captions > 0:
            detail += f', words "{str(result.get("words") or "")[:60]}"'
        if dev:
            detail += f'; developer words: "{dev.group(0)}"'
        elif message and not plain:
            detail += "; not one of the plain messages"
        self.record("E", name, ok, detail)

    def judge_sweep_export(self):
        """The export with video and sound: a video track, a sound track that
        is not silent, the picture, and the timeline's length."""
        name = "export has the video, its sound and the timeline length"
        info, error = self.export_movie(3, "export-sweep.mp4")
        if error:
            self.record("E", name, False, error)
            return
        duration = float(info.get("durationSeconds", -1) or -1)
        video_tracks = info.get("videoTracks", 0)
        audio_tracks = info.get("audioTracks", 0)
        sound = info.get("audio") or {}
        peak = float(sound.get("peak") or 0)
        rms = float(sound.get("rms") or 0)
        frame = info.get("frame") or {}
        colours = frame.get("colours", {})
        found = [c for c in ("red", "green", "blue", "yellow") if colours.get(c, 0) >= 0.005]
        end, line = self.timeline_end(3)
        problems = []
        if "error" in info:
            problems.append(info["error"])
        if video_tracks < 1:
            problems.append("no video track")
        if audio_tracks < 1:
            problems.append("no audio track")
        elif peak < 0.02 or rms < 0.005:
            problems.append("the sound is silent")
        if "error" in sound:
            problems.append(f"sound read: {sound['error']}")
        if len(found) < 2:
            problems.append("the exported frame does not show the video's colours")
        if end is None:
            problems.append("no TIMELINE line")
        elif abs(duration - end) > EXPORT_LENGTH_TOLERANCE_S:
            problems.append(f"{duration:.2f} s is not the timeline end {end:.2f} s")
        self.record("E", name, not problems,
                    f"{duration:.2f} s (timeline end {end if end is None else f'{end:.2f}'} s), {video_tracks} video and "
                    f"{audio_tracks} audio track(s), sound peak {peak:.2f} rms {rms:.3f} audible "
                    f"{float(sound.get('audibleFraction') or 0):.0%}, frame colours {len(found)}/4, "
                    f"{info.get('kilobytes', 0)} KB" + (f"; {'; '.join(problems)}" if problems else ""))

    def finish(self, drove):
        (self.out / "publik-fake-server.log").write_text("\n".join(SERVER_LOG) + "\n")
        (self.out / "events.txt").write_text("\n".join(f"launch {p}: {t}" for p, t in self.events) + "\n")
        for note in self.notes:
            say(note)
            print(f"::error title=editor test::{note}", flush=True)
        self.judge_a()
        self.judge_b()
        self.judge_d()
        self.judge_c()
        self.judge_e()
        passed = drove and all(r[2] for r in self.results)
        lines = [f"{t} {n}: {'PASS' if p else 'FAIL'} ({d})" for t, n, p, d in self.results]
        lines.append(f"RESULT: {'PASS' if passed else 'FAIL'}")
        (self.out / "summary.txt").write_text("\n".join(self.notes + lines) + "\n")
        summary = os.environ.get("GITHUB_STEP_SUMMARY")
        if summary:
            with open(summary, "a") as f:
                f.write("### iOS editor test\n\n| Test | Check | Result | Details |\n|---|---|---|---|\n")
                for t, n, p, d in self.results:
                    f.write(f"| {t} | {n} | {'PASS' if p else 'FAIL'} | {d.replace('|', '/')[:300]} |\n")
                for note in self.notes:
                    f.write(f"| - | run | FAIL | {note.replace('|', '/')} |\n")
                f.write("\n")
        say(f"RESULT: {'PASS' if passed else 'FAIL'} (screenshots and logs: artifact ios-sim-editor-test)")
        return 0 if passed else 1


def main():
    if len(sys.argv) != 3:
        print("usage: ios-sim-editor-test.py <App.app> <output folder>", file=sys.stderr)
        return 2
    test = EditorTest(sys.argv[1], sys.argv[2])
    try:
        test.setup()
    except Exception as error:  # the test could not start: say why
        print(f"::error title=editor test::could not start: {error}", flush=True)
        return 2
    try:
        drove = test.drive()
    except Exception as error:  # still write the logs and the summary
        test.notes.append(f"the test driver stopped: {error!r}")
        drove = False
    finally:
        test.server.shutdown()
    return test.finish(drove)


if __name__ == "__main__":
    sys.exit(main())
