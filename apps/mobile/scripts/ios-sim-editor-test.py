#!/usr/bin/env python3
"""Editor test on an iOS simulator (mobile-ci.yml, job "iOS (simulator, unsigned)").

The app under test is a Debug simulator build of the TEST web bundle
(KNEECAP_DEBUG_TOOLS=1, gate required). Its half of the test is the editor CI
mode in src/autotest.tsx. This script:
  - starts a fake publik server on 127.0.0.1 for the sign-in gate (the Debug
    launch setting PUBLIK_API_BASE_URL); it never talks to publikhq.com;
  - installs the app fresh, plants a photo and the test flags in its data
    container, and launches it twice (a relaunch between the phases);
  - takes a simulator screenshot for every SHOT line, then writes the ack file;
  - judges three tests and exits 1 when one fails:
      A. the editor opens 5 times (new, reopen, reopen, relaunch, reopen,
         reopen) with no crash screen, no uncaught error, no
         "GPU context not initialized", and exactly 1 project;
      B. the preview is one colour when empty, then shows a text element,
         then the photo, and the photo clip on the timeline shows the photo
         (pixel checks on the screenshots);
      C. the export (1 photo + 1 text, 1080p, 30 fps, High) makes a file
         with duration > 0 and a video track (AVFoundation on this Mac).

  python3 scripts/ios-sim-editor-test.py <App.app> <output folder>

Exit 0: all tests pass. 1: a test failed. 2: the test could not run.
"""
import json
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
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BUNDLE = "dev.kneecap.app"
SCRIPTS = Path(__file__).resolve().parent
FAKE_KEY = "pk_live_editorci"
PHOTO_NAME = "ci-photo.jpg"
START_LIMIT_S = 240  # first launch: boot + gate + app start
PHASE_LIMIT_S = {1: 420, 2: 1200}  # phase 2 includes the export (software encode on a simulator)

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
        # The export also saves to Photos: no permission alert over the app.
        for service in ("photos-add", "photos"):
            run(["xcrun", "simctl", "privacy", self.udid, "grant", service, BUNDLE], check=False)

        data = Path(run(["xcrun", "simctl", "get_app_container", self.udid, BUNDLE, "data"]).strip())
        self.root = data / "Library" / "Application Support" / "kneecap"
        (self.root / "Media").mkdir(parents=True, exist_ok=True)
        photo = make_photo(self.out)
        shutil.copyfile(photo, self.root / "Media" / PHOTO_NAME)
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

    def set_phase_flag(self, phase):
        for p in (1, 2):
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
        for phase in (1, 2):
            self.set_phase_flag(phase)
            say(f"launch {phase} of 2")
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
            if not ended:
                return False
        return True

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

    def texts(self, prefix):
        return [(phase, text) for phase, text in self.events if text.startswith(prefix)]

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
            if not m:
                continue
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

        gpu = self.problems({"boot", "A", "B", "C"}, {"gpu"}) + [f"app log: {line}" for line in self.raw_gpu]
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
        lines = self.texts("EXPORT DONE") + self.texts("EXPORT FAIL")
        if not lines:
            self.record("C", "export makes a playable file", False, "the app logged no export result")
            return
        text = lines[-1][1]
        if "via=direct" in text:
            print("::warning title=editor test C::the export sheet was not found, the test used the direct export call", flush=True)
        if text.startswith("EXPORT FAIL"):
            self.record("C", "export makes a playable file", False, text[:300])
            return
        logged = urllib.parse.unquote(text.split(" path=", 1)[1].strip()) if " path=" in text else ""
        movie = Path(logged) if logged else None
        if not movie or not movie.exists():
            found = sorted((self.root / "Exports").glob("*.mp4"), key=lambda p: p.stat().st_mtime)
            movie = found[-1] if found else None
        if not movie:
            self.record("C", "export makes a playable file", False, f"no file at {logged or '(no path)'} and none in Exports/")
            return
        copy = self.out / "export.mp4"
        shutil.copyfile(movie, copy)
        out = run([str(self.tool), "video-check", str(copy)], check=False, timeout=300)
        try:
            info = json.loads(out)
        except ValueError:
            info = {"error": out.strip()[:200] or "no answer"}
        (self.out / "export-metrics.json").write_text(json.dumps(info, indent=2))
        duration = info.get("durationSeconds", -1) or -1
        tracks = info.get("videoTracks", 0)
        ok = duration > 0 and tracks >= 1 and "error" not in info
        size = info.get("naturalSize", ["?", "?"])
        self.record("C", "export makes a playable file", ok,
                    f"{duration:.2f} s, {tracks} video track(s), {size[0]}x{size[1]} at "
                    f"{info.get('nominalFrameRate', 0):.0f} fps, {copy.stat().st_size // 1024} KB"
                    + (f"; {info['error']}" if "error" in info else ""))
        frame = info.get("frame")
        if ok and frame and frame.get("offFraction", 0) < 0.05:
            print("::warning title=editor test C::the exported frame at 0.5 s is almost one colour "
                  "(the photo may be missing from the export)", flush=True)
        stop = self.problems({"C"}, {"crash", "driver"})
        if stop:
            self.record("C", "no crash during the export", False, "; ".join(stop[:3]))

    def finish(self, drove):
        (self.out / "publik-fake-server.log").write_text("\n".join(SERVER_LOG) + "\n")
        (self.out / "events.txt").write_text("\n".join(f"launch {p}: {t}" for p, t in self.events) + "\n")
        for note in self.notes:
            say(note)
            print(f"::error title=editor test::{note}", flush=True)
        self.judge_a()
        self.judge_b()
        self.judge_c()
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
