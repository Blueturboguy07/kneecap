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
         "GPU context not initialized", and exactly 1 project; the new
         project gets a text before it closes (1.0.7: the app deletes a
         project with no elements when the editor closes);
      B. the preview is one colour when empty, then shows a text element,
         then the photo, and the photo clip on the timeline shows the photo
         (pixel checks on the screenshots);
      D. every Stickers tab shows its images (no broken image), a sticker
         tile adds a sticker, a bundled sound adds an audio clip whose file
         loads (the app undoes both before C). 1.0.8 (MEDIUM 3): the
         sticker from the sheet is 20-40% of the frame width;
      C. the main export (1 photo 0-3 s + 1 text 0-5 s + a flag sticker
         0-5 s + a shape sticker 1-4 s, rotated 30 degrees, opacity 0.6;
         1080p, 30 fps, High) makes a file with a video track that lasts as
         long as the timeline (the latest end over all tracks, +-0.15 s),
         and the export sheet ends with "Saved to Photos" and "Share"
         (1.0.6: no "Open Photos"). 1.0.7 (blind test round 3: stickers
         were in the preview but in no frame of the video): a baseline
         export with the same settings (text at opacity 0, no stickers) is
         compared with the main export at 0.5, 2 and 4.5 s, in the regions
         the app logs in canvas pixels (scaled to the file's size): the
         flag, its colours, the shape in and out of its window, its opacity
         and rotation, the text, and control regions where nothing is drawn
         (they must match).
         1.0.8 (blind test round 4, HIGH 1: the resolution buttons changed
         the canvas, so at 720p every sticker and text sat 1.5x farther from
         the centre): the resolution buttons keep the canvas size; the
         preview does not move when "720p" and "1080p" are tapped; each
         export has the size of its button and the canvas aspect; the flag,
         the shape and the text are at the same place (a fraction of the
         frame, within 0.02) at 720p, at 1080p and in the preview, in 16:9
         and again in 9:16 (through the Aspect ratio sheet: 1080x1920);
      E. launch 3, a new project: the video imports through the native
         proxy and shows in the preview; Captions "Generate" gives captions
         or a plain message; Split, Duplicate, Delete and Mute work; Import
         audio works; the export has a video track, a sound track that is
         not silent, and the timeline's length. 1.0.8 (LOW 4): with the clip
         selected, the timeline's scroll area ends above the clip-tools bar.

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
import sqlite3
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
# Phase 2 has the stickers and five 5 s exports (software encode on a
# simulator; run 43719800179: 173 s and 87 s for the two 1080p exports, launch
# 2 took 314 s; with the three 1.0.8 exports about 650 s). The runner speed
# varies a lot: run 43751037832 took about 690 s for launch 2 on its second
# attempt, but on its first attempt each 1080p export took about 330 s and
# launch 2 needed more than 1200 s (the old limit stopped it during its last
# export, so test C was "not measured"). 2400 s is about twice that slow run.
# The limit only stops a launch that hangs; it checks nothing.
# Phase 3 has the video proxy, captions and the video export.
PHASE_LIMIT_S = {1: 420, 2: 2400, 3: 1200}
EXPORT_LENGTH_TOLERANCE_S = 0.15
# The file name of each export in the output folder, by its tag
# (autotest.tsx CiExportOptions.tag). The runner copies a file as soon as
# the app reports it: the app prunes old exports before each new one.
EXPORT_COPY_NAMES = {
    "baseline": "export-baseline.mp4",
    "main": "export.mp4",
    "pos169-720": "export-169-720p.mp4",
    "pos916-1080": "export-916-1080p.mp4",
    "pos916-720": "export-916-720p.mp4",
    "sweep": "export-sweep.mp4",
}
# Test C, 1.0.8: the same frame at every export size. Positions are fractions
# of the frame (0-1). The tool finds each element's centre with a colour mask
# in a search box the app logs (C POS TARGET).
POS_TOLERANCE = 0.02  # a centre may differ this much (fraction of the frame width or height)
POS_ASPECTS = ("16:9", "9:16")
POS_RESOLUTIONS = ("1080p", "720p")
POS_SHORT_SIDE = {"480p": 480, "720p": 720, "1080p": 1080, "4K": 2160}
# The screenshot pairs of "the preview does not move": (after, before, words).
SHIFT_PAIRS = (
    ("shift169-720", "pos169-t2", "16:9, 1080p to 720p"),
    ("shift169-1080", "shift169-720", "16:9, 720p to 1080p"),
    ("shift916-720", "pos916-t2", "9:16, 1080p to 720p"),
)
SHIFT_CHANGED_MAX = 0.01  # at most this part of the preview area changes (largest channel difference > 48)
SHIFT_MEAN_DIFF_MAX = 4.0  # and its mean difference (0-255) is at most this
SHIFT_RECT_TOLERANCE = 1.0  # the preview rect may move this much (CSS px)
ASPECT_916_EXPECTED = (1080, 1920)  # 9:16 from a 1080-class canvas
# Test D, 1.0.8: a sticker from the sheet is about 30% of the frame width.
STICKER_WIDTH_BAND = (0.20, 0.40)
# Test E, 1.0.8: the visible scroll area may reach this far under the clip-tools bar (px).
CLIP_TOOLS_OVERLAP_MAX = 0.5
# Test C, stickers in the export (1.0.7). The tool compares the main export
# with the baseline export in each region the app logs (C REGION lines);
# "changed" is the part of the region's pixels whose largest channel
# difference is more than 48 of 255 levels.
STICKER_SAMPLE_TIMES = (0.5, 2.0, 4.5)  # used when the C LAYOUT line has no samples=
STICKER_PRESENT_MIN = {"background": 0.30, "photo": 0.15}  # a sticker on screen: its inner box changes this much
STICKER_ABSENT_MAX = 0.05  # a sticker off screen: its box changes at most this much
TEXT_PRESENT_MIN = 0.03  # the glyphs cover only a part of the text box
CONTROL_CHANGED_MAX = 0.02  # a control region (nothing drawn) changes at most this much...
CONTROL_MEAN_DIFF_MAX = 6.0  # ...and its mean difference (0-255) is at most this (encoder noise only)
ROTATION_CORNER_MAX = 0.20  # the corners of the unrotated square stay background when the rotation is drawn
# The white shape at opacity 0.6 moves the pixels under it this part of the
# way to white: (main luma - baseline luma) / (1 - baseline luma). It is 0.60
# with an sRGB blend, about 0.80 with a linear blend over black. Opaque
# (opacity lost) is about 1.0; no shape is about 0.
OPACITY_LUMA_BAND = (0.40, 0.88)
OPACITY_UNDER_MAX = 0.10  # over the background: the baseline under the shape must be black (luma / 255)
OPACITY_PHOTO_UNDER_MAX = 0.80  # over the photo: the baseline must leave room to move toward white
FLAG_ID = "flags:UA"  # autotest.tsx CI_FLAG: blue top half, yellow bottom half
# The plain words the Captions sheet may show (CAPTION_MESSAGES in
# packages/mobile-ui/src/editor/captions-actions.ts).
CAPTION_MESSAGES = (
    "Add a video clip with sound first. Captions come from the sound of your clips.",
    "Your clips have no sound. Add a video clip with sound to make captions.",
    "Captions could not read the sound of your clips. Try again.",
    "No speech was detected anywhere on the timeline.",
    "Speech recognition is off for publik kneecap. Turn it on in Settings to make captions.",
    # 1.0.8 (LOW 8): the iOS fallback engine needs on-device recognition; a
    # simulator with no on-device speech model shows this.
    "Captions need speech recognition on this phone, and this phone does not have it.",
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
# Test C: one region the app logs, in output pixels (autotest.tsx ciStickerExport).
REGION = re.compile(
    r"^C REGION name=(\S+) box=([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+) on=(never|[\d.]+-[\d.]+)(.*)$"
)
STICKER_LINE = re.compile(r"^C STICKER name=(\w+) id=(\S+) via=(\S+) start=([\d.]+) end=([\d.]+)(.*)$")
# Test C, 1.0.8 (autotest.tsx ciPositionChecks).
POS_LAYOUT = re.compile(r"^C POS LAYOUT aspect=(\S+) canvas=(\d+)x(\d+) mode=(\S+) .*?exports=(\S+) shots=(\S+)")
POS_TARGET = re.compile(
    r"^C POS TARGET aspect=(\S+) name=(\w+) mask=(\w+) center=([-\d.]+),([-\d.]+) "
    r"search=([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+) times=(\S+)"
)
PREVIEW_LINE = re.compile(r"^C PREVIEW name=([a-z0-9-]+) aspect=(\S+)(?: base=([a-z0-9-]+))? t=([\d.]+) canvas=(\d+)x(\d+)(.*)$")
RESOLUTION_LINE = re.compile(r"^C RESOLUTION aspect=(\S+) pick=(\S+) via=(\S+) canvas=(\d+)x(\d+)->(\d+)x(\d+)(.*)$")
ASPECT_LINE = re.compile(r"^C ASPECT pick=(\S+) via=(\S+) canvas=(\d+)x(\d+)->(\d+)x(\d+) expected=(\d+)x(\d+)")
EXPORT_SIZE_LINE = re.compile(r"^EXPORT size edl=(\d+)x(\d+) canvas=(\d+)x(\d+) exportShortSide=(\S+) expected=(\d+)x(\d+)")


def say(message):
    print(f"editor test: {message}", flush=True)


def run(args, check=True, timeout=300):
    done = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and done.returncode != 0:
        raise RuntimeError(f"{' '.join(args)} failed ({done.returncode}): {done.stderr.strip()[:800]}")
    return done.stdout


def export_size(canvas, short):
    """getExportSize (@kneecap/editor-core/edl, 1.0.8): the export short side
    and the canvas aspect, even sides. (w, h)."""
    cw, ch = canvas

    def even(v):
        return max(2, int(math.floor(v / 2 + 0.5)) * 2)

    return (even(short * cw / ch), short) if cw >= ch else (short, even(short * ch / cw))


def time_tag(seconds):
    """2 -> "t2", 4.5 -> "t45" (autotest.tsx ciTimeTag)."""
    return "t" + f"{seconds:g}".replace(".", "")


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
        self.export_tag = {}  # phase -> the tag of the export that runs now (EXPORT BEGIN)
        self.kept_exports = {}  # (phase, tag) -> the copy made when the app reported the file
        self.export_info = {}  # (phase, tag) -> (video-check facts or None, problem or None)
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
        self.grant_speech()

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

    def grant_speech(self):
        """Captions use Apple Speech: SFSpeechRecognizer.requestAuthorization
        (NativeBridgePlugin+Transcribe.swift) shows a system alert that the
        test cannot tap (run 43697933341: test E waited 300 s under it).
        simctl privacy has no speech service, so the runner writes the grant
        into the simulator's TCC database: a copy of the photos-add row that
        simctl wrote, with the speech service. The simulator is shut down
        for the write and booted again, so tccd reads the new row."""
        db = Path.home() / "Library" / "Developer" / "CoreSimulator" / "Devices" / self.udid / "data" / "Library" / "TCC" / "TCC.db"
        service = "kTCCServiceSpeechRecognition"
        try:
            run(["xcrun", "simctl", "shutdown", self.udid], check=False)
            con = sqlite3.connect(str(db))
            try:
                cols = [row[1] for row in con.execute("PRAGMA table_info(access)")]
                row = con.execute("SELECT * FROM access WHERE service = ? AND client = ?",
                                  ("kTCCServicePhotosAdd", BUNDLE)).fetchone()
                if row is not None:
                    values = dict(zip(cols, row))
                    values["service"] = service
                    values["last_modified"] = int(time.time())
                else:
                    values = {"service": service, "client": BUNDLE, "client_type": 0, "auth_value": 2,
                              "auth_reason": 2, "auth_version": 1, "flags": 0, "last_modified": int(time.time())}
                    values = {k: v for k, v in values.items() if k in cols}
                names = ", ".join(values)
                marks = ", ".join("?" for _ in values)
                con.execute(f"INSERT OR REPLACE INTO access ({names}) VALUES ({marks})", list(values.values()))
                con.commit()
                check = con.execute("SELECT auth_value FROM access WHERE service = ? AND client = ?",
                                    (service, BUNDLE)).fetchone()
            finally:
                con.close()
            say(f"speech recognition permission: written to TCC.db (auth_value={check[0] if check else 'none'}, "
                f"copied from photos-add: {row is not None})")
        except Exception as error:  # the captions check then shows the alert in its screenshot
            say(f"speech recognition permission: NOT written ({error})")
        finally:
            run(["xcrun", "simctl", "boot", self.udid], check=False)
            run(["xcrun", "simctl", "bootstatus", self.udid, "-b"], timeout=900)

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
                    elif text.startswith("EXPORT BEGIN "):
                        tag = re.search(r"\btag=(\S+)", text)
                        self.export_tag[phase] = tag.group(1) if tag else None
                    elif text.startswith("EXPORT DONE"):
                        self.keep_export(phase, self.export_tag.get(phase), text)
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

    def keep_export(self, phase, tag, text):
        """Copies an exported file as soon as the app reports it. Launch 2 has
        two exports, and the app prunes old exports before each new one."""
        if " path=" not in text:
            return
        source = Path(urllib.parse.unquote(text.split(" path=", 1)[1].strip()))
        target = self.out / EXPORT_COPY_NAMES.get(tag or "", f"export-launch{phase}-{tag or 'untagged'}.mp4")
        try:
            if source.exists():
                shutil.copyfile(source, target)
                self.kept_exports[(phase, tag)] = target
        except OSError as error:
            say(f"could not copy the export {source}: {error}")

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

    def tagged(self, phase, tag=None):
        """The lines of one export: from its "EXPORT BEGIN tag=<tag>" line to
        the next EXPORT BEGIN line of the launch. All lines of the launch when
        tag is None."""
        if tag is None:
            return [text for p, text in self.events if p == phase]
        found, inside = [], False
        for p, text in self.events:
            if p != phase:
                continue
            if text.startswith("EXPORT BEGIN "):
                m = re.search(r"\btag=(\S+)", text)
                inside = bool(m) and m.group(1) == tag
            if inside:
                found.append(text)
        return found

    def last(self, prefix, phase=None, tag=None):
        """The text of the last line with this prefix (in the export with this tag), or None."""
        if tag is not None:
            found = [text for text in self.tagged(phase, tag) if text.startswith(prefix)]
            return found[-1] if found else None
        found = self.texts(prefix, phase)
        return found[-1][1] if found else None

    def json_line(self, prefix, phase=None, tag=None):
        """The JSON object after the prefix of the last such line, or None."""
        text = self.last(prefix, phase, tag)
        if text is None:
            return None
        try:
            value = json.loads(text[len(prefix):].strip())
        except ValueError:
            return {"_unreadable": text[:200]}
        return value if isinstance(value, dict) else {"_unreadable": text[:200]}

    def timeline_end(self, phase, tag=None):
        """The latest end over all tracks that the app logged before its export."""
        text = self.last("TIMELINE ", phase, tag)
        m = re.match(r"TIMELINE end=([\d.]+)", text or "")
        return (float(m.group(1)), text) if m else (None, text)

    def last_export_tag(self, phase):
        """The tag of the last EXPORT BEGIN line of a launch, or None."""
        tags = [re.search(r"\btag=(\S+)", text) for text in self.tagged(phase) if text.startswith("EXPORT BEGIN ")]
        return tags[-1].group(1) if tags and tags[-1] else None

    def export_movie(self, phase, copy_name, tag=None):
        """The exported file of a launch (the export with this tag), checked
        by the measuring tool. Returns (facts or None, problem text or None).
        The answer is kept, so a second call does not measure again."""
        if (phase, tag) not in self.export_info:
            self.export_info[(phase, tag)] = self._export_movie(phase, copy_name, tag)
        return self.export_info[(phase, tag)]

    def _export_movie(self, phase, copy_name, tag):
        text = self.last("EXPORT DONE", phase, tag)
        failed = self.last("EXPORT FAIL", phase, tag)
        if failed and not text:
            return None, failed[:300]
        if not text:
            return None, "the app logged no export result"
        if "via=direct" in text:
            print(f"::warning title=editor test::launch {phase}: the export sheet was not found, "
                  f"the test used the direct export call (export {tag})", flush=True)
        copy = self.out / copy_name
        kept = self.kept_exports.get((phase, tag))
        if kept and kept.exists():
            if kept != copy:
                shutil.copyfile(kept, copy)
        else:
            logged = urllib.parse.unquote(text.split(" path=", 1)[1].strip()) if " path=" in text else ""
            movie = Path(logged) if logged else None
            # The newest file in Exports/ is only right for the last export of a
            # launch (1.0.8: launch 2 has five exports; "main" is the second).
            newest_ok = tag is None or tag == self.last_export_tag(phase)
            if (not movie or not movie.exists()) and newest_ok:
                found = sorted((self.root / "Exports").glob("*.mp4"), key=lambda p: p.stat().st_mtime)
                movie = found[-1] if found else None
            if not movie or not movie.exists():
                return None, f"no file at {logged or '(no path)'}" + (" and none in Exports/" if newest_ok else "")
            shutil.copyfile(movie, copy)
        out = run([str(self.tool), "video-check", str(copy)], check=False, timeout=300)
        try:
            info = json.loads(out)
        except ValueError:
            info = {"error": out.strip()[:200] or "no answer"}
        info["kilobytes"] = copy.stat().st_size // 1024
        (self.out / f"{copy.stem}-metrics.json").write_text(json.dumps(info, indent=2))
        return info, None

    def edl_size(self, phase, tag):
        """The size the exporter was asked for: the EDL output resolution in
        the "EXPORT start" line of the export with this tag. (w, h) or None."""
        start = self.last("EXPORT start", phase, tag) or ""
        m = re.search(r'"resolution":\{"width":(\d+),"height":(\d+)\}', start)
        return (int(m.group(1)), int(m.group(2))) if m else None

    @staticmethod
    def movie_size(info):
        """The video track's size from video-check. (w, h) or None."""
        size = (info or {}).get("naturalSize")
        try:
            w, h = int(round(abs(float(size[0])))), int(round(abs(float(size[1]))))
        except (TypeError, ValueError, IndexError):
            return None
        return (w, h) if w > 0 and h > 0 else None

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

        # 1.0.7: the app deletes a project with no elements when the editor
        # closes, so the new project gets a text before it closes (else the
        # reopens by name have no card to open).
        content = self.last("CONTENT n=1 ", 1)
        self.record("A", "the new project gets a text before the editor closes", bool(content and content.startswith("CONTENT n=1 PASS")),
                    (content or "no CONTENT line (did open 1 fail?)")[:240])

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
            self.judge_positions()
            return
        info, error = self.export_movie(2, EXPORT_COPY_NAMES["main"], tag="main")
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
            end, line = self.timeline_end(2, "main")
            if end is None:
                self.record("C", "export lasts as long as the timeline", False, f"no TIMELINE line ({line or 'none'})")
            else:
                self.record("C", "export lasts as long as the timeline", abs(duration - end) <= EXPORT_LENGTH_TOLERANCE_S,
                            f"file {duration:.2f} s, timeline end {end:.2f} s (latest end over all tracks: "
                            f"{line.split(' tracks=', 1)[-1].split(' ', 1)[0]}), allowed difference "
                            f"{EXPORT_LENGTH_TOLERANCE_S:.2f} s")
        self.judge_export_sheet()
        self.judge_stickers()
        self.judge_positions()
        stop = self.problems({"C"}, {"crash", "driver"})
        if stop:
            self.record("C", "no crash during the export", False, "; ".join(stop[:3]))

    def judge_export_sheet(self):
        """Blind test 1.0.5: a good export ends with "Saved to Photos" and the
        button "Share" (Photos add permission granted before launch); a failed
        export keeps "Export failed. Try again.". 1.0.6: no "Open Photos"
        button (no public iOS API opens the Photos app; guideline 2.5.1)."""
        sheet = self.json_line("EXPORT SHEET", 2, "main")
        name = 'export sheet ends with "Saved to Photos" and "Share", no "Open Photos"'
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
        ok = bool(sheet.get("saved")) and "share" in folded and "open photos" not in folded
        if not ok and "could not save" in (" ".join(notes) + " " + str(sheet.get("text", ""))).casefold():
            detail = f"the save to Photos failed (photos-add grant?); {detail}"
        self.record("C", name, ok, detail)

    # ----- C: stickers in the export (1.0.7)

    STICKER_CHECKS = (
        "control regions match the baseline (the comparison is sound)",
        "text is in the exported video",
        "flag sticker is in the exported video",
        "flag sticker has its own colours (blue over yellow)",
        "shape sticker is in the exported video, only in its time window",
        "shape sticker opacity is in the exported video",
        "shape sticker rotation is in the exported video",
    )

    def sticker_regions(self):
        """The C REGION lines of launch 2: name -> {box, on (start, end) or None, attributes}."""
        regions = {}
        for _, text in self.texts("C REGION ", 2):
            m = REGION.match(text)
            if not m:
                continue
            attrs = dict(re.findall(r"(\w+)=(\S+)", m.group(7)))
            on = None if m.group(6) == "never" else tuple(float(v) for v in m.group(6).split("-"))
            regions[m.group(1)] = {**attrs, "box": [float(m.group(i)) for i in range(2, 6)], "on": on}
        return regions

    def judge_stickers(self):
        """Blind test round 3 (HIGH): a star and a flag were in the preview and
        on the Home card but in no frame of the exported video. The main
        export is compared with a baseline export (same settings, text at
        opacity 0, no stickers) in the regions the app logged."""
        base_name = "sticker test: baseline export (same settings, text hidden, no stickers)"
        layout = self.last("C LAYOUT ", 2)
        regions = self.sticker_regions()
        stickers = {}
        for _, text in self.texts("C STICKER ", 2):
            m = STICKER_LINE.match(text)
            if m:
                stickers[m.group(1)] = {"id": m.group(2), "via": m.group(3), "start": float(m.group(4)),
                                        "end": float(m.group(5)), "text": text}
        for name, sticker in stickers.items():
            if sticker["via"] != "ui":
                print(f"::warning title=editor test C::the {name} sticker was not found in the Stickers sheet, "
                      f"the test inserted it directly: {sticker['text'][:200]}", flush=True)
        for text in [t for _, t in self.texts("C STICKER", 2) if " FAIL " in t][:3]:
            print(f"::warning title=editor test C::{text[:200]}", flush=True)

        base_info, base_error = self.export_movie(2, EXPORT_COPY_NAMES["baseline"], tag="baseline")
        main_path = self.out / EXPORT_COPY_NAMES["main"]
        blocked = []
        if base_error:
            blocked.append(f"no baseline export ({base_error})")
        if not main_path.exists():
            blocked.append("no main export file")
        if not layout or not regions:
            blocked.append("the app logged no C LAYOUT and C REGION lines")
        if blocked:
            self.record("C", base_name, False, "; ".join(blocked))
            for check in self.STICKER_CHECKS:
                self.record("C", check, False, "not measured: " + "; ".join(blocked))
            return

        samples = re.search(r"samples=([\d.,]+)", layout)
        times = [float(v) for v in samples.group(1).split(",") if v] if samples else list(STICKER_SAMPLE_TIMES)
        canvas = re.search(r"canvas=(\d+)x(\d+)", layout)
        canvas = [int(canvas.group(1)), int(canvas.group(2))] if canvas else None
        # 1.0.8: the regions are in canvas pixels; the file has the export
        # size (getExportSize: the export short side, the canvas aspect). One
        # output pixel = one canvas pixel x (file width / canvas width).
        main_info, _ = self.export_movie(2, EXPORT_COPY_NAMES["main"], tag="main")
        file_size = self.movie_size(main_info)
        edl = self.edl_size(2, "main")
        size_problems = []
        sx = sy = 1.0
        if not canvas:
            size_problems.append("no canvas in the C LAYOUT line")
        elif not file_size:
            size_problems.append("the size of the main export is not known")
        else:
            sx, sy = file_size[0] / canvas[0], file_size[1] / canvas[1]
            if abs(sx - sy) > 0.01 * max(sx, sy):
                size_problems.append(f"the file {file_size[0]}x{file_size[1]} does not have the canvas aspect "
                                     f"{canvas[0]}x{canvas[1]} (scale {sx:.3f} x {sy:.3f})")
        if not edl:
            size_problems.append("no EDL size in the main EXPORT start line")
        elif file_size and file_size != edl:
            size_problems.append(f"the file is {file_size[0]}x{file_size[1]}, the EDL asked for {edl[0]}x{edl[1]}")

        def scaled(box):
            return [box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy]

        spec = {"times": times, "regions": [{"name": n, "box": scaled(r["box"])} for n, r in regions.items()]}
        spec_path = self.out / "sticker-regions-spec.json"
        spec_path.write_text(json.dumps(spec, indent=2))
        out = run([str(self.tool), "frame-regions", str(self.out / EXPORT_COPY_NAMES["baseline"]), str(main_path),
                   str(spec_path), str(self.out / "sticker-frames")], check=False, timeout=300)
        try:
            measured = json.loads(out)
        except ValueError:
            measured = {"error": out.strip()[:300] or "no answer"}
        (self.out / "sticker-regions-metrics.json").write_text(json.dumps(measured, indent=2))

        # The baseline itself: same size and length as the main export, the
        # size the app laid the regions out in, and its own overlay frames.
        problems = []
        base_facts = measured.get("baseline") or {}
        main_facts = measured.get("main") or {}
        if "error" in measured:
            problems.append(f"frame-regions: {measured['error']}")
        if base_facts.get("size") != main_facts.get("size"):
            problems.append(f"sizes differ: baseline {base_facts.get('size')}, main {main_facts.get('size')}")
        problems += size_problems
        base_s = float(base_facts.get("durationSeconds") or -1)
        main_s = float(main_facts.get("durationSeconds") or -1)
        if abs(base_s - main_s) > 0.05:
            problems.append(f"lengths differ: baseline {base_s:.2f} s, main {main_s:.2f} s")
        frame_errors = [f"{f.get('time')} s: {f['error']}" for f in measured.get("frames", []) if "error" in f]
        problems += frame_errors[:2]
        start = self.last("EXPORT start", 2, "baseline") or ""
        overlay = re.search(r"overlayFrames=(\d+)", start)
        if overlay and int(overlay.group(1)) == 0:
            print("::warning title=editor test C::the baseline export had no overlay frames: its text went "
                  "through the native fallback, not renderOverlayFrames", flush=True)
        self.record("C", base_name, not problems,
                    f"{base_s:.2f} s, {base_facts.get('size')}, overlay frames "
                    f"{overlay.group(1) if overlay else '?'}; main {main_s:.2f} s; {layout[len('C LAYOUT '):][:160]}; "
                    f"regions scaled x{sx:.3f} (file / canvas)"
                    + (f"; {'; '.join(problems)}" if problems else ""))

        frames = {round(float(f.get("time", -1)), 3): f for f in measured.get("frames", [])}

        def metric(name, t):
            return ((frames.get(round(t, 3)) or {}).get("regions") or {}).get(name)

        def on_at(region, t):
            on = region.get("on")
            return bool(on) and on[0] + 0.01 <= t < on[1] - 0.01

        def show(name, t):
            m = metric(name, t)
            if not m or "changed" not in m:
                return f"{t:g} s: not measured"
            return f"{t:g} s: {m['changed']:.0%} changed (mean diff {m['meanDiff']:.0f})"

        def luma(rgb):
            return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 if rgb else 0.0

        for t in times:
            say("C regions at {:g} s: ".format(t) + ", ".join(
                f"{n} {metric(n, t)['changed']:.0%}" if metric(n, t) and "changed" in metric(n, t) else f"{n} -"
                for n in regions))

        # 1. Controls: nothing is drawn there, so main = baseline up to encoder noise.
        controls = [n for n in regions if n.startswith("control")]
        bad, parts = [], []
        for n in controls:
            values = [metric(n, t) for t in times]
            if any(not v or "changed" not in v for v in values):
                bad.append(f"{n} not measured")
                continue
            worst_changed = max(v["changed"] for v in values)
            worst_mean = max(v["meanDiff"] for v in values)
            parts.append(f"{n} at most {worst_changed:.1%} changed, mean diff {worst_mean:.1f}")
            if worst_changed > CONTROL_CHANGED_MAX or worst_mean > CONTROL_MEAN_DIFF_MAX:
                bad.append(n)
        self.record("C", self.STICKER_CHECKS[0], bool(controls) and not bad,
                    ("; ".join(parts) or "no control region") + f" (allowed {CONTROL_CHANGED_MAX:.0%} changed, "
                    f"mean diff {CONTROL_MEAN_DIFF_MAX:.0f})" + (f"; FAILED: {', '.join(bad)}" if bad else ""))

        # 2-5. Presence: on screen in its window, the same as the baseline outside it.
        def presence(region_name, minimum):
            region = regions.get(region_name)
            if not region:
                return False, f"the app logged no region '{region_name}'"
            on_times = [t for t in times if on_at(region, t)]
            off_times = [t for t in times if not on_at(region, t)]
            ok = bool(on_times)
            for t in on_times:
                m = metric(region_name, t)
                ok = ok and bool(m) and m.get("changed", 0) >= minimum
            for t in off_times:
                m = metric(region_name, t)
                ok = ok and bool(m) and m.get("changed", 1) <= STICKER_ABSENT_MAX
            detail = (f"on {region['on'][0]:.2f}-{region['on'][1]:.2f} s: " if region.get("on") else "") + "; ".join(
                [show(region_name, t) + " (want >= {:.0%})".format(minimum) for t in on_times]
                + [show(region_name, t) + " (want <= {:.0%}, not on screen)".format(STICKER_ABSENT_MAX) for t in off_times])
            return ok, detail

        ok, detail = presence("text", TEXT_PRESENT_MIN)
        self.record("C", self.STICKER_CHECKS[1], ok, detail)

        flag = stickers.get("flag", {})
        flag_region = regions.get("flag", {})
        ok, detail = presence("flag", STICKER_PRESENT_MIN.get(flag_region.get("over"), 0.30))
        self.record("C", self.STICKER_CHECKS[2], ok,
                    f"{flag.get('id', 'no C STICKER line')} via {flag.get('via', '?')}, over the "
                    f"{flag_region.get('over', '?')}; {detail}")

        # Flag colours: the top box blue, the bottom box yellow, while it is on screen.
        top, bottom = regions.get("flag-top"), regions.get("flag-bottom")
        if flag.get("id", FLAG_ID) != FLAG_ID or not top or not bottom:
            self.record("C", self.STICKER_CHECKS[3], False,
                        f"cannot check: flag {flag.get('id', '?')}, regions top={bool(top)} bottom={bool(bottom)}")
        else:
            ok, parts = True, []
            on_times = [t for t in times if on_at(top, t)]
            for t in on_times:
                mt, mb = metric("flag-top", t), metric("flag-bottom", t)
                if not mt or not mb or "main" not in mt or "main" not in mb:
                    ok = False
                    parts.append(f"{t:g} s: not measured")
                    continue
                r, g, b = mt["main"]
                blue = b >= 120 and b - r >= 70 and b - g >= 30
                r2, g2, b2 = mb["main"]
                yellow = r2 >= 160 and g2 >= 130 and r2 - b2 >= 90 and g2 - b2 >= 70
                ok = ok and blue and yellow
                parts.append(f"{t:g} s: top rgb({r:.0f},{g:.0f},{b:.0f}) {'blue' if blue else 'NOT blue'}, "
                             f"bottom rgb({r2:.0f},{g2:.0f},{b2:.0f}) {'yellow' if yellow else 'NOT yellow'}")
            self.record("C", self.STICKER_CHECKS[3], ok and bool(on_times), "; ".join(parts) or "no sample time in the flag's window")

        shape = stickers.get("shape", {})
        shape_region = regions.get("shape", {})
        shape_min = STICKER_PRESENT_MIN.get(shape_region.get("over"), 0.30)
        ok, detail = presence("shape", shape_min)
        self.record("C", self.STICKER_CHECKS[4], ok,
                    f"{shape.get('id', 'no C STICKER line')} via {shape.get('via', '?')}, over the "
                    f"{shape_region.get('over', '?')}; {detail}")

        # 6. Opacity: the white shape must be partly see-through. The share is
        # how far the shape moves the baseline pixels toward white.
        shape_on = [t for t in times if shape_region and on_at(shape_region, t)]
        opacity = float(shape_region.get("opacity", "1") or 1)
        if not shape_region or opacity >= 0.99:
            self.record("C", self.STICKER_CHECKS[5], False, "no shape region with an opacity below 1")
        else:
            over = shape_region.get("over")
            under_max = OPACITY_UNDER_MAX if over == "background" else OPACITY_PHOTO_UNDER_MAX
            ok, parts = bool(shape_on), []
            for t in shape_on:
                m = metric("shape", t)
                if not m or "main" not in m or "base" not in m:
                    ok = False
                    parts.append(f"{t:g} s: not measured")
                    continue
                value, under = luma(m["main"]), luma(m["base"])
                share = (value - under) / (1 - under) if under < 1 else 0.0
                ok = ok and under <= under_max and OPACITY_LUMA_BAND[0] <= share <= OPACITY_LUMA_BAND[1]
                parts.append(f"{t:g} s: luma {value:.2f} over {under:.2f} (baseline, want <= {under_max:.2f}) "
                             f"= {share:.2f} of the way to white")
            self.record("C", self.STICKER_CHECKS[5], ok,
                        f"opacity {opacity:g}, over the {over}: " + ("; ".join(parts) or "no sample time in the shape's window")
                        + f" (want {OPACITY_LUMA_BAND[0]:.2f}-{OPACITY_LUMA_BAND[1]:.2f}: 0.60 with an sRGB blend, "
                        f"about 0.80 with a linear blend over black; opaque is about 1.0, no shape about 0)")

        # 7. Rotation: the corners of the UNROTATED square stay background.
        corners = sorted(n for n in regions if n.startswith("shape-corner-"))
        if not corners:
            self.record("C", self.STICKER_CHECKS[6], False, "the app logged no shape-corner regions")
        else:
            ok, parts = bool(shape_on), []
            for t in shape_on:
                m = metric("shape", t)
                present = bool(m) and m.get("changed", 0) >= shape_min
                worst = max((metric(n, t) or {}).get("changed", 1.0) for n in corners)
                ok = ok and present and worst <= ROTATION_CORNER_MAX
                parts.append(f"{t:g} s: shape {'present' if present else 'MISSING'}, corners of the unrotated "
                             f"square at most {worst:.0%} changed")
            self.record("C", self.STICKER_CHECKS[6], ok,
                        f"rotate {shape_region.get('rotate', '?')}: " + ("; ".join(parts) or "no sample time in the shape's window")
                        + f" (want the shape present and the corners <= {ROTATION_CORNER_MAX:.0%})")

    # ----- C: the same frame at every export size (1.0.8)

    # The exports whose size is checked, and the aspect of their canvas.
    EXPORT_SIZE_TAGS = (("main", "16:9"), ("pos169-720", "16:9"), ("pos916-1080", "9:16"), ("pos916-720", "9:16"))
    POS_ELEMENTS = ("flag", "shape", "text")

    def position_lines(self):
        """The 1.0.8 lines of launch 2 (autotest.tsx ciPositionChecks).
        Returns (layouts, targets, missing, previews):
          layouts[aspect] = {canvas, mode, exports {res: tag}, shots {t: name}}
          targets[aspect][name] = {mask, center, search (canvas px), times}
          missing[aspect][name or "*"] = why the app logged no target
          previews[shot name] = {aspect, base, t, canvas, rect, text}"""
        layouts, targets, missing, previews = {}, {}, {}, {}
        for _, text in self.texts("C POS ", 2):
            m = POS_LAYOUT.match(text)
            if m:
                exports = dict(part.split(":", 1) for part in m.group(5).split(",") if ":" in part)
                shots = {}
                for part in m.group(6).split(","):
                    if ":" in part:
                        t, shot = part.split(":", 1)
                        shots[float(t)] = shot
                layouts[m.group(1)] = {"canvas": (int(m.group(2)), int(m.group(3))), "mode": m.group(4),
                                       "exports": exports, "shots": shots}
                continue
            m = POS_TARGET.match(text)
            if m:
                times = [] if m.group(10) == "none" else [float(v) for v in m.group(10).split(",") if v]
                targets.setdefault(m.group(1), {})[m.group(2)] = {
                    "mask": m.group(3), "center": (float(m.group(4)), float(m.group(5))),
                    "search": [float(m.group(i)) for i in range(6, 10)], "times": times}
                continue
            m = re.match(r"C POS TARGET aspect=(\S+) (?:name=(\w+) )?none (.*)$", text)
            if m:
                missing.setdefault(m.group(1), {})[m.group(2) or "*"] = m.group(3)[:160]
        for _, text in self.texts("C PREVIEW ", 2):
            m = PREVIEW_LINE.match(text)
            if not m:
                continue
            rect = re.search(r"\brect=(none|[-\d.]+,[-\d.]+,[-\d.]+,[-\d.]+)", m.group(7))
            # 1.0.8 draws a selection box and handles over the preview; the
            # driver clears the selection and counts what is still drawn.
            selected = re.search(r"\bselected=(\d+)", m.group(7))
            handles = re.search(r"\bhandles=(\d+)", m.group(7))
            previews[m.group(1)] = {
                "aspect": m.group(2), "base": m.group(3), "t": float(m.group(4)),
                "canvas": (int(m.group(5)), int(m.group(6))),
                "rect": None if not rect or rect.group(1) == "none" else [float(v) for v in rect.group(1).split(",")],
                "selected": int(selected.group(1)) if selected else 0,
                "handles": int(handles.group(1)) if handles else 0,
            }
        return layouts, targets, missing, previews

    def judge_positions(self):
        """Blind test round 4 (HIGH 1): the export sheet's 720p button made
        the canvas 1280x720, and every sticker and text kept its position in
        canvas pixels, so it sat 1.5x farther from the centre (in the preview
        and in the video). 1.0.8: the buttons set the export short side only;
        the export has that short side and the canvas aspect; one output
        pixel = one canvas pixel x (file width / canvas width)."""
        layouts, targets, missing, previews = self.position_lines()
        error = self.last("C POS ERROR", 2)
        why = f"the app logged: {error[:200]}" if error else "the app logged no C POS lines (did test C stop early?)"
        self.judge_resolution_canvas(layouts, why)
        self.judge_preview_shift(previews, why)
        self.judge_export_sizes(layouts)
        self.judge_aspect(layouts, why)
        self.judge_centres(layouts, targets, missing, previews, why)

    def judge_resolution_canvas(self, layouts, why):
        name = "the export sheet's resolution buttons keep the canvas size"
        picks = [m for m in (RESOLUTION_LINE.match(t) for _, t in self.texts("C RESOLUTION ", 2)) if m]
        if not picks:
            self.record("C", name, False, f"not measured: no C RESOLUTION line ({why})")
            return
        ok, parts = True, []
        for m in picks:
            before, after = (int(m.group(4)), int(m.group(5))), (int(m.group(6)), int(m.group(7)))
            export = re.search(r"\bexport=(\S+)", m.group(8))
            part = f"{m.group(1)} {m.group(2)}: canvas {before[0]}x{before[1]} -> {after[0]}x{after[1]}"
            if before != after:
                ok = False
                part += " CHANGED"
            if export:
                part += f", export size {export.group(1)}"
            if m.group(3) != "ui":
                ok = False
                part += " (not measured: the button was not found, the test set the export size directly)"
            parts.append(part)
        absent = [p for p in ("720p", "1080p") if p not in {m.group(2) for m in picks}]
        if absent:
            ok = False
            parts.append(f"not measured: no pick of {', '.join(absent)}")
        # The canvas when each 1.0.8 export ran (its own resolution tap) is the canvas of its aspect.
        for tag, aspect in self.EXPORT_SIZE_TAGS[1:]:
            m = EXPORT_SIZE_LINE.match(self.last("EXPORT size", 2, tag) or "")
            want = (layouts.get(aspect) or {}).get("canvas")
            if m and want:
                got = (int(m.group(3)), int(m.group(4)))
                ok = ok and got == want
                parts.append(f"export {tag}: canvas {got[0]}x{got[1]}"
                             + ("" if got == want else f" CHANGED (the {aspect} canvas is {want[0]}x{want[1]})"))
        self.record("C", name, ok, "; ".join(parts))

    def judge_preview_shift(self, previews, why):
        """The same preview before and after a resolution tap: the same
        canvas, the same preview rect, the same pixels (same playhead time,
        no sheet, no selection)."""
        metrics = {}
        for after, before, words in SHIFT_PAIRS:
            name = f"the preview does not move when the resolution changes ({words})"
            a, b = previews.get(after), previews.get(before)
            sa, sb = self.shots.get(after), self.shots.get(before)
            absent = [n for n, line, shot in ((before, b, sb), (after, a, sa))
                      if not line or not shot or not shot["rect"] or not shot["path"].exists()]
            if absent:
                self.record("C", name, False, f"not measured: no C PREVIEW line or no screenshot with a preview "
                                              f"area for {', '.join(absent)} ({why})")
                continue
            problems = []
            if a["canvas"] != b["canvas"]:
                problems.append("the canvas changed")
            if abs(a["t"] - b["t"]) > 0.001:
                problems.append(f"not measured: different playhead times {b['t']:g} s and {a['t']:g} s")
            if sa["viewport"] != sb["viewport"]:
                problems.append(f"not measured: different viewports {sb['viewport']} and {sa['viewport']}")
            for shot_name, line in ((before, b), (after, a)):
                if line["selected"] or line["handles"]:
                    problems.append(f"not measured: {shot_name} showed a selection (selected={line['selected']}, "
                                    f"handles={line['handles']})")
            moved = max(abs(x - y) for x, y in zip(sa["rect"], sb["rect"]))
            if moved > SHIFT_RECT_TOLERANCE:
                problems.append(f"the preview rect moved {moved:.1f} px")
            out = run([str(self.tool), "image-diff", str(sb["path"]), str(sa["path"]),
                       *[str(v) for v in sa["rect"]], *[str(v) for v in sa["viewport"]]], check=False, timeout=120)
            try:
                diff = json.loads(out)
            except ValueError:
                diff = {"error": out.strip()[:200] or "no answer"}
            metrics[after] = {"base": before, **diff}
            if "error" in diff:
                problems.append(f"not measured: image-diff: {diff['error']}")
                pixels = "no pixel comparison"
            else:
                pixels = f"{diff['changed']:.2%} of the preview changed, mean diff {diff['meanDiff']:.1f}"
                if diff["changed"] > SHIFT_CHANGED_MAX or diff["meanDiff"] > SHIFT_MEAN_DIFF_MAX:
                    bounds = diff.get("changedBounds")
                    problems.append("the picture moved" + (
                        f" (changed area x {bounds[0]:.2f}-{bounds[2]:.2f}, y {bounds[1]:.2f}-{bounds[3]:.2f} of the preview)"
                        if bounds else ""))

            def box(r):
                return ",".join(f"{v:.1f}" for v in r)

            detail = (f"{before} -> {after} at {a['t']:g} s: canvas {b['canvas'][0]}x{b['canvas'][1]} -> "
                      f"{a['canvas'][0]}x{a['canvas'][1]}, rect {box(sb['rect'])} -> {box(sa['rect'])}, {pixels} "
                      f"(allowed: the same canvas, the rect within {SHIFT_RECT_TOLERANCE:g} px, "
                      f"<= {SHIFT_CHANGED_MAX:.0%} changed, mean diff <= {SHIFT_MEAN_DIFF_MAX:g})")
            self.record("C", name, not problems, detail + (f"; {'; '.join(problems)}" if problems else ""))
        (self.out / "preview-shift-metrics.json").write_text(json.dumps(metrics, indent=2))

    def judge_export_sizes(self, layouts):
        """Each export: the file = the EDL size, its short side = the button,
        its aspect = the canvas aspect (getExportSize)."""
        c_layout = re.search(r"canvas=(\d+)x(\d+)", self.last("C LAYOUT ", 2) or "")
        for tag, aspect in self.EXPORT_SIZE_TAGS:
            name = f"export {tag} has the size of its resolution button and the canvas aspect"
            begin = re.search(r"\bresolution=(\S+)", self.last("EXPORT BEGIN", 2, tag) or "")
            res = begin.group(1) if begin else "?"
            info, error = self.export_movie(2, EXPORT_COPY_NAMES[tag], tag)
            if error:
                self.record("C", name, False, f"not measured: {error}")
                continue
            file_size = self.movie_size(info)
            edl = self.edl_size(2, tag)
            canvas = (layouts.get(aspect) or {}).get("canvas")
            if not canvas and tag == "main" and c_layout:
                canvas = (int(c_layout.group(1)), int(c_layout.group(2)))
            short = POS_SHORT_SIDE.get(res)
            absent = [what for what, value in (("the file size", file_size), ("the EDL size (EXPORT start)", edl),
                                               (f"the {aspect} canvas (C POS LAYOUT)", canvas),
                                               (f"the button (EXPORT BEGIN resolution={res})", short)) if not value]
            if absent:
                self.record("C", name, False, f"not measured: no {', no '.join(absent)}")
                continue
            want = export_size(canvas, short)
            app = EXPORT_SIZE_LINE.match(self.last("EXPORT size", 2, tag) or "")
            problems = []
            if file_size != edl:
                problems.append("the file is not the EDL size")
            if min(file_size) != short:
                problems.append(f"the short side is {min(file_size)}, not {short}")
            if abs(file_size[0] - want[0]) > 2 or abs(file_size[1] - want[1]) > 2:
                problems.append(f"not the canvas aspect (want {want[0]}x{want[1]})")
            self.record("C", name, not problems,
                        f"button {res}: file {file_size[0]}x{file_size[1]}, EDL {edl[0]}x{edl[1]}, canvas "
                        f"{canvas[0]}x{canvas[1]}; want {want[0]}x{want[1]} (short side {short}, the canvas aspect)"
                        + (f"; the app's export size {app.group(6)}x{app.group(7)}" if app else "")
                        + (f"; {'; '.join(problems)}" if problems else ""))

    def judge_aspect(self, layouts, why):
        name = "the Aspect ratio sheet's 9:16 keeps the canvas short side (1080x1920)"
        m = ASPECT_LINE.match(self.last("C ASPECT ", 2) or "")
        if not m:
            self.record("C", name, False, f"not measured: no C ASPECT line ({why})")
            return
        before, after = (int(m.group(3)), int(m.group(4))), (int(m.group(5)), int(m.group(6)))
        expected = (int(m.group(7)), int(m.group(8)))
        problems = []
        if m.group(2) != "ui":
            problems.append("not measured: the Aspect ratio sheet or its 9:16 button was not found, "
                            "the test set the canvas directly")
        if after != expected or after != ASPECT_916_EXPECTED:
            problems.append(f"want {expected[0]}x{expected[1]} (the short side {min(before)} kept)"
                            + ("" if expected == ASPECT_916_EXPECTED else
                               f"; this test expects {ASPECT_916_EXPECTED[0]}x{ASPECT_916_EXPECTED[1]}"))
        layout = (layouts.get("9:16") or {}).get("canvas")
        if layout and layout != after:
            problems.append(f"the 9:16 layout canvas is {layout[0]}x{layout[1]}")
        self.record("C", name, not problems,
                    f"via={m.group(2)}: canvas {before[0]}x{before[1]} -> {after[0]}x{after[1]}"
                    + (f"; {'; '.join(problems)}" if problems else ""))

    def judge_centres(self, layouts, targets, missing, previews, why):
        """Per aspect: the centre of the flag, the shape and the text (a
        fraction of the frame) in the 1080p file, the 720p file and the
        preview screenshot, at the same times. The tool looks for each one
        with a colour mask in the search box the app logged."""
        names = {aspect: (f"{aspect}: the flag, the shape and the text are at the same place at 720p and at 1080p",
                          f"{aspect}: the flag, the shape and the text are at the same place in the exports and in the preview")
                 for aspect in POS_ASPECTS}
        items, plans, blocked = [], {}, {}
        for aspect in POS_ASPECTS:
            key = "pos" + aspect.replace(":", "")
            layout = layouts.get(aspect)
            if not layout:
                blocked[aspect] = f"no C POS LAYOUT line for {aspect} ({why})"
                continue
            if "*" in missing.get(aspect, {}):
                blocked[aspect] = f"no search boxes: {missing[aspect]['*']}"
                continue
            W, H = layout["canvas"]
            found_targets = targets.get(aspect, {})
            movies = {}
            for res in POS_RESOLUTIONS:
                tag = layout["exports"].get(res)
                if tag not in EXPORT_COPY_NAMES:
                    movies[res] = (None, f"no {res} export in the C POS LAYOUT line")
                    continue
                info, error = self.export_movie(2, EXPORT_COPY_NAMES[tag], tag)
                movies[res] = (None, error) if error else (self.out / EXPORT_COPY_NAMES[tag], None)
            times = sorted({t for target in found_targets.values() for t in target["times"]})
            for t in times:
                here = [{"name": n, "mask": target["mask"],
                         "box": [target["search"][0] / W, target["search"][1] / H,
                                 target["search"][2] / W, target["search"][3] / H]}
                        for n, target in found_targets.items() if t in target["times"]]
                for res in POS_RESOLUTIONS:
                    if movies[res][0]:
                        items.append({"id": f"{key}-{res}-{time_tag(t)}", "movie": str(movies[res][0]), "time": t,
                                      "targets": here})
                shot_name = layout["shots"].get(t)
                shot = self.shots.get(shot_name) if shot_name else None
                if shot and shot["rect"] and shot["path"].exists():
                    items.append({"id": shot_name, "image": str(shot["path"]), "rect": shot["rect"],
                                  "viewport": shot["viewport"], "targets": here})
            plans[aspect] = {"key": key, "canvas": (W, H), "targets": found_targets, "movies": movies,
                             "shots": layout["shots"]}

        measured, tool_error = {}, None
        if items:
            spec_path = self.out / "position-spec.json"
            spec_path.write_text(json.dumps({"items": items}, indent=2))
            out = run([str(self.tool), "find-centres", str(spec_path), str(self.out / "position-frames")],
                      check=False, timeout=600)
            try:
                answer = json.loads(out)
            except ValueError:
                answer = {"error": out.strip()[:300] or "no answer"}
            (self.out / "position-metrics.json").write_text(json.dumps(answer, indent=2))
            tool_error = answer.get("error")
            measured = {item.get("id"): item for item in answer.get("items", []) if isinstance(item, dict)}

        for aspect in POS_ASPECTS:
            same_name, preview_name = names[aspect]
            reason = blocked.get(aspect) or (f"find-centres: {tool_error}" if tool_error else None)
            if reason:
                self.record("C", same_name, False, f"not measured: {reason}")
                self.record("C", preview_name, False, f"not measured: {reason}")
                continue
            plan = plans[aspect]
            W, H = plan["canvas"]

            def centre(item_id, target_name, problem=None):
                """((cx, cy) or None, text)."""
                if problem:
                    return None, f"not measured ({problem[:80]})"
                item = measured.get(item_id)
                if not item:
                    return None, "not measured"
                if "error" in item:
                    return None, f"not measured ({str(item['error'])[:80]})"
                r = (item.get("targets") or {}).get(target_name) or {}
                if "error" in r:
                    return None, f"not measured ({str(r['error'])[:80]})"
                if not r.get("found"):
                    return None, f"NOT FOUND ({r.get('pixels', 0)} px, want {r.get('minimum', '?')})"
                return (r["cx"], r["cy"]), f"{r['cx']:.3f},{r['cy']:.3f}" + (" edge" if r.get("touchesEdge") else "")

            def apart(c1, c2):
                return max(abs(c1[0] - c2[0]), abs(c1[1] - c2[1]))

            same_ok = prev_ok = True
            same_parts, prev_parts = [], []
            for target_name in self.POS_ELEMENTS:
                target = plan["targets"].get(target_name)
                if not target or not target["times"]:
                    text = (f"{target_name}: not measured ("
                            + (missing.get(aspect, {}).get(target_name) or
                               ("no C POS TARGET line" if not target else "no sample time while it is on screen")) + ")")
                    same_ok = prev_ok = False
                    same_parts.append(text)
                    prev_parts.append(text)
                    continue
                app = (target["center"][0] / W, target["center"][1] / H)
                for t in target["times"]:
                    tag_t = time_tag(t)
                    got = {res: centre(f"{plan['key']}-{res}-{tag_t}", target_name, plan["movies"][res][1])
                           for res in POS_RESOLUTIONS}
                    shot_name = plan["shots"].get(t)
                    line = previews.get(shot_name) or {}
                    problem = None if shot_name in measured else f"no screenshot {shot_name or '(none planned)'}"
                    if line.get("selected") or line.get("handles"):
                        problem = f"{shot_name} showed a selection (handles={line.get('handles')})"
                    got["preview"] = centre(shot_name, target_name, problem)
                    c1080, c720, cprev = got["1080p"][0], got["720p"][0], got["preview"][0]
                    part = (f"{target_name} {t:g} s: 1080p {got['1080p'][1]}, 720p {got['720p'][1]}")
                    if c1080 and c720:
                        d = apart(c1080, c720)
                        same_ok = same_ok and d <= POS_TOLERANCE
                        part += f", apart {d:.3f}"
                    else:
                        same_ok = False
                    same_parts.append(part + f" (app {app[0]:.3f},{app[1]:.3f})")
                    part = f"{target_name} {t:g} s: preview {got['preview'][1]}"
                    if not cprev:
                        prev_ok = False
                    else:
                        for res, c in (("1080p", c1080), ("720p", c720)):
                            if c:
                                d = apart(cprev, c)
                                prev_ok = prev_ok and d <= POS_TOLERANCE
                                part += f", {res} apart {d:.3f}"
                            else:
                                prev_ok = False
                                part += f", {res} {got[res][1]}"
                    prev_parts.append(part)
            rule = f" (a fraction of the frame; allowed {POS_TOLERANCE:g} on each axis)"
            self.record("C", same_name, same_ok, "; ".join(same_parts) + rule)
            self.record("C", preview_name, prev_ok, "; ".join(prev_parts) + rule)

    def judge_d(self):
        """Stickers (every tab, every image), one sticker, one bundled sound."""
        if self.texts("D SKIP"):
            self.record("D", "stickers and bundled sound", False, "the editor did not open")
            self.judge_sticker_size()
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
        self.judge_sticker_size()
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

    def judge_sticker_size(self):
        """1.0.8 (blind test round 4, MEDIUM 3): a sticker from the sheet
        comes in at about 30% of the frame width (1.0.7: the full frame)."""
        name = "a sticker from the Stickers sheet is about 30% of the frame width"
        line = self.last("STICKER-SIZE", 2)
        m = re.search(r"\bwidthFraction=([\d.]+)", line or "")
        if not m:
            self.record("D", name, False, f"not measured: {(line or 'no STICKER-SIZE line')[:200]}")
            return
        share = float(m.group(1))
        low, high = STICKER_WIDTH_BAND
        self.record("D", name, low <= share <= high,
                    f"{share:.1%} of the canvas width (want {low:.0%}-{high:.0%}); {line[len('STICKER-SIZE '):][:220]}")

    def judge_clip_tools(self):
        """1.0.8 (blind test round 4, LOW 4): with a clip selected, the
        clip-tools bar shows; the visible part of the timeline's scroll area
        must end above it (1.0.7: the rows went under the bar)."""
        name = "with a clip selected, the timeline scroll area ends above the clip-tools bar"
        line = self.last("LAYOUT clip-tools", 3)
        m = re.search(r"\boverlap=([-\d.]+)", line or "")
        if not m:
            self.record("E", name, False,
                        f"not measured: {(line or 'no LAYOUT clip-tools line (the split did not run?)')[:200]}")
            return
        overlap = float(m.group(1))
        self.record("E", name, overlap <= CLIP_TOOLS_OVERLAP_MAX,
                    f"{overlap:.1f} px of the visible scroll area is under the bar (allowed {CLIP_TOOLS_OVERLAP_MAX:g}); "
                    f"{line[len('LAYOUT clip-tools '):][:220]}")

    def judge_e(self):
        """Launch 3: the video sweep in a new project, then the clip-tools layout."""
        self.judge_sweep()
        self.judge_clip_tools()

    def judge_sweep(self):
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
        info, error = self.export_movie(3, EXPORT_COPY_NAMES["sweep"], tag="sweep")
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
        end, line = self.timeline_end(3, "sweep")
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
