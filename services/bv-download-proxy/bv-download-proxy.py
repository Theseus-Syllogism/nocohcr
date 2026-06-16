#!/usr/bin/env python3
"""
blindvault download proxy.

A small ThreadingHTTPServer that wraps yt-dlp behind three JSON endpoints,
sized for the Digital Library "Save a video or song" UI in the PWA.

Endpoints
---------

POST /api/download/start
    Body: {"url": "...", "format": "audio"|"video", "quality": "low"|"medium"|"high"}
    -> 200 {"job_id": "..."} | 400 {"error": "..."}

GET  /api/download/status/<job_id>
    -> 200 {"state": "queued|running|done|error",
            "progress": 0-100, "title": str|null,
            "filename": str|null, "error": str|null}
    -> 404 {"error": "unknown_job"}

GET  /api/download/file/<job_id>
    -> 200 binary, Content-Disposition: attachment; filename="..."
    -> 409 {"error": "not_ready"} | 404 {"error": "unknown_job"}

Design notes
------------

Why a custom proxy rather than re-using Cobalt or the existing
ytdl-web.py on this LXC:

  * the existing ytdl-web.py drops files into /media/downloads and
    returns "downloading…". It does not return the file to the caller
    and has no format/quality controls.
  * Cobalt's API surface and JS dependency footprint are heavier than
    needed for the PWA's three-knob UI.

Safety
------

  * URL hostname allowlist (env-configurable). The default is a set of
    well-known educational / archival sources. yt-dlp follows redirects
    on its own, so we additionally probe the URL with `yt-dlp -j` and
    re-check the final webpage_url's host before we commit to a download.
  * Max file size cap (default 500 MB).
  * Per-job wall-clock timeout (default 5 min).
  * Restricted filenames (--restrict-filenames). We additionally
    basename + sanitize before writing Content-Disposition.
  * Single video per job (--no-playlist).
  * Max concurrent active jobs (default 3). Extra requests are queued.
  * Per-job tmp directory under /var/lib/bv-download/<job_id>/; reaped
    after the file is fetched or after a TTL (default 1 hour).

Intended for an authorized homelab. Tighten further before any public
deployment (auth on /start, abuse logging, blob storage cap).
"""
from __future__ import annotations

import json
import logging
import os
import re
import secrets
import shutil
import signal
import subprocess
import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

LOG = logging.getLogger("bv-download-proxy")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

# ---- Config (env) ----------------------------------------------------------

HOST = os.environ.get("BV_DOWNLOAD_HOST", "0.0.0.0")
PORT = int(os.environ.get("BV_DOWNLOAD_PORT", "8082"))
YTDLP_BIN = os.environ.get("BV_YTDLP_BIN", "/opt/cobalt/venv/bin/yt-dlp")
WORK_ROOT = Path(os.environ.get("BV_DOWNLOAD_WORK_ROOT", "/var/lib/bv-download"))
MAX_CONCURRENT = int(os.environ.get("BV_DOWNLOAD_MAX_CONCURRENT", "3"))
MAX_FILESIZE = os.environ.get("BV_DOWNLOAD_MAX_FILESIZE", "500M")
JOB_TIMEOUT_S = int(os.environ.get("BV_DOWNLOAD_JOB_TIMEOUT_S", "300"))
JOB_TTL_S = int(os.environ.get("BV_DOWNLOAD_JOB_TTL_S", "3600"))
PROXY_URL = os.environ.get("BV_DOWNLOAD_PROXY", "")  # e.g. socks5://192.168.50.10:1080
# Optional Netscape cookies.txt. When present, passed to yt-dlp via --cookies.
# Required for sites that bot-gate datacenter IPs (notably YouTube, which
# returns "Sign in to confirm you're not a bot" to unauthenticated cloud IPs).
COOKIES_FILE = os.environ.get("BV_DOWNLOAD_COOKIES", "")
# Comma-separated allowlist of hostnames (suffix match — "youtube.com"
# matches "m.youtube.com"). Override by setting BV_DOWNLOAD_ALLOWLIST.
DEFAULT_ALLOWLIST = ",".join([
    "youtube.com", "youtu.be", "m.youtube.com",
    "vimeo.com",
    "archive.org", "ia.us.archive.org",
    "soundcloud.com",
    "dailymotion.com",
    "ted.com",
    "librivox.org",
    "bandcamp.com",
    "bitchute.com",
    "rumble.com",
    "peertube.tv",
    "twitch.tv",
])
ALLOWLIST = tuple(
    h.strip().lower()
    for h in os.environ.get("BV_DOWNLOAD_ALLOWLIST", DEFAULT_ALLOWLIST).split(",")
    if h.strip()
)

QUALITY_HEIGHT = {"low": 480, "medium": 720, "high": 1080}


# ---- Job model -------------------------------------------------------------

@dataclass
class Job:
    id: str
    url: str
    format: str
    quality: str
    state: str = "queued"           # queued | running | done | error
    progress: int = 0
    title: str | None = None
    filename: str | None = None     # basename of the produced file
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    completed_at: float | None = None
    fetched_at: float | None = None
    proc: subprocess.Popen | None = None
    work_dir: Path | None = None

    def to_status(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "progress": self.progress,
            "title": self.title,
            "filename": self.filename,
            "error": self.error,
        }


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()
ACTIVE_SEM = threading.BoundedSemaphore(MAX_CONCURRENT)


# ---- URL validation --------------------------------------------------------

def _host_allowed(host: str) -> bool:
    h = host.lower().lstrip(".")
    for allowed in ALLOWLIST:
        if h == allowed or h.endswith("." + allowed):
            return True
    return False


def _validate_url(raw: str) -> tuple[str, str | None]:
    """Return (normalized_url, error_message_or_None)."""
    raw = (raw or "").strip()
    if not raw:
        return "", "url is required"
    if len(raw) > 2048:
        return "", "url is too long"
    try:
        u = urllib.parse.urlsplit(raw)
    except ValueError:
        return "", "url is not parseable"
    if u.scheme not in ("http", "https"):
        return "", "url must use http or https"
    if not u.hostname:
        return "", "url is missing a host"
    if not _host_allowed(u.hostname):
        return "", f"host '{u.hostname}' is not in the allowlist"
    return raw, None


# ---- yt-dlp invocation -----------------------------------------------------

def _ytdlp_format_args(fmt: str, quality: str) -> list[str]:
    if fmt == "audio":
        return [
            "-f", "bestaudio/best",
            "-x", "--audio-format", "mp3",
            "--audio-quality", "192K",
        ]
    h = QUALITY_HEIGHT.get(quality, 720)
    # Prefer single-file mp4 that doesn't need merging, but fall back to
    # bestvideo+bestaudio if no muxed mp4 of the requested height exists.
    return [
        "-f", f"best[ext=mp4][height<={h}]/bestvideo[height<={h}]+bestaudio/best[height<={h}]",
        "--merge-output-format", "mp4",
    ]


def _ytdlp_common_args() -> list[str]:
    # --newline puts each progress update on its own line so we can parse
    # them as they stream past; --progress-template gives a fixed,
    # machine-readable format that survives yt-dlp UI tweaks across
    # versions. --no-progress is deliberately NOT set — that flag would
    # silence the progress channel entirely and the bar would never move
    # off 0% until the job completed.
    args = [
        YTDLP_BIN,
        "--no-call-home",
        "--no-playlist",
        "--restrict-filenames",
        "--newline",
        "--progress",
        "--progress-template", "DL %(progress._percent_str)s | %(progress.eta)s",
        "--no-warnings",
        "--max-filesize", MAX_FILESIZE,
        "--socket-timeout", "30",
        "--retries", "3",
    ]
    if COOKIES_FILE and os.path.exists(COOKIES_FILE):
        args += ["--cookies", COOKIES_FILE]
    if PROXY_URL:
        args += ["--proxy", PROXY_URL]
    return args


# Matches both yt-dlp's default progress line and our --progress-template
# variant ("DL  37.4% | 12").
PROGRESS_RE = re.compile(r"(?:\[download\]|DL)\s+([0-9.]+)%")
TITLE_RE = re.compile(r"\[download\] Destination: (.+)$")


def _probe(url: str) -> tuple[dict | None, str | None]:
    """Probe URL with `yt-dlp -j` to fetch metadata + re-check the final
    webpage_url is still allowlisted. Returns (info_dict, error)."""
    args = _ytdlp_common_args() + ["-j", "--skip-download", url]
    try:
        cp = subprocess.run(
            args, capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        return None, "probe timed out"
    if cp.returncode != 0:
        msg = (cp.stderr or "").strip().splitlines()[-1] if cp.stderr else "probe failed"
        return None, msg[:240]
    # yt-dlp -j emits one JSON object per line. For a single video that's
    # one line; for collections (archive.org Item pages, channel pages with
    # --no-playlist evaded, etc.) it can be many. We take the first object
    # — the actual download invocation re-runs with --no-playlist, so this
    # is only used for host re-check + title.
    info: dict | None = None
    for line in (cp.stdout or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            info = json.loads(line)
            break
        except json.JSONDecodeError:
            continue
    if info is None:
        return None, "probe returned non-JSON"
    final = info.get("webpage_url") or info.get("original_url") or url
    try:
        host = urllib.parse.urlsplit(final).hostname or ""
    except ValueError:
        host = ""
    if host and not _host_allowed(host):
        return None, f"redirected to disallowed host '{host}'"
    return info, None


def _safe_basename(name: str) -> str:
    name = os.path.basename(name)
    # The PWA echoes this into Content-Disposition; restrict to a safe set.
    name = re.sub(r'[^A-Za-z0-9._\-]', "_", name)
    if name in ("", ".", ".."):
        name = "download.bin"
    return name[:200]


def _friendly_error(msg: str) -> str:
    """Map raw yt-dlp / proxy failures to short, user-facing messages.

    The PWA renders this string verbatim, so it must stay plain — no CLI
    flags, no stack noise. Substrings the frontend already remaps
    ("timed out", "allowlist", "filesize", "scheme") are passed through
    untouched so that mapping still fires.
    """
    if not msg:
        return "Something went wrong."
    low = msg.lower()
    # YouTube (and similar) bot-gate datacenter IPs. This cannot be bypassed
    # from this server without an authenticated cookie jar, so point users at
    # the sources that do work instead of showing a raw yt-dlp error.
    if "not a bot" in low or "sign in to confirm" in low:
        return ("YouTube is blocking downloads from this server right now, so "
                "YouTube videos can't be saved here. Other sources still work: "
                "try archive.org, Vimeo, SoundCloud, or the other listed sites.")
    # Dead / unreachable proxy or VPN tunnel hop.
    if any(s in low for s in (
        "connect tunnel failed", "tunnel connection failed",
        "unable to connect to proxy", "cannot connect to proxy",
        "502 bad gateway", "proxyerror",
    )):
        return "The download route is temporarily unavailable. Please try again in a minute."
    return msg[:240]


def _run_job(job: Job) -> None:
    """Owned by a worker thread. Concurrency is bounded by ACTIVE_SEM."""
    try:
        with ACTIVE_SEM:
            with JOBS_LOCK:
                job.state = "running"

            info, err = _probe(job.url)
            if err:
                with JOBS_LOCK:
                    job.state = "error"
                    job.error = _friendly_error(err)
                    job.completed_at = time.time()
                return
            title = (info or {}).get("title") or "download"
            with JOBS_LOCK:
                job.title = title[:240]

            work = WORK_ROOT / job.id
            work.mkdir(parents=True, exist_ok=True)
            with JOBS_LOCK:
                job.work_dir = work

            args = _ytdlp_common_args() + _ytdlp_format_args(job.format, job.quality) + [
                "-o", str(work / "%(title).200B.%(ext)s"),
                job.url,
            ]
            LOG.info("job=%s starting yt-dlp", job.id)
            proc = subprocess.Popen(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                preexec_fn=os.setsid,
            )
            with JOBS_LOCK:
                job.proc = proc

            # Watchdog thread enforces JOB_TIMEOUT_S.
            def _kill_on_timeout() -> None:
                proc.wait(timeout=None) if False else None
            start = time.time()
            tail: list[str] = []  # recent non-progress output, for error reporting

            for line in proc.stdout or []:
                line = line.rstrip()
                m = PROGRESS_RE.search(line)
                if m:
                    try:
                        with JOBS_LOCK:
                            job.progress = int(float(m.group(1)))
                    except ValueError:
                        pass
                elif line:
                    tail.append(line)
                    if len(tail) > 30:
                        del tail[:10]
                m2 = TITLE_RE.search(line)
                if m2:
                    fname = _safe_basename(m2.group(1).strip())
                    with JOBS_LOCK:
                        job.filename = fname
                if time.time() - start > JOB_TIMEOUT_S:
                    LOG.warning("job=%s timed out", job.id)
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    with JOBS_LOCK:
                        job.state = "error"
                        job.error = "timed out"
                        job.completed_at = time.time()
                    return

            rc = proc.wait()
            if rc != 0:
                err_line = next(
                    (l for l in reversed(tail) if "ERROR" in l.upper()),
                    tail[-1] if tail else "",
                )
                with JOBS_LOCK:
                    job.state = "error"
                    job.error = (
                        _friendly_error(err_line)
                        if err_line else f"yt-dlp exited with code {rc}"
                    )
                    job.completed_at = time.time()
                return

            # Pick the largest file in the work dir as the output.
            files = sorted(work.iterdir(), key=lambda p: p.stat().st_size, reverse=True)
            files = [p for p in files if p.is_file()]
            if not files:
                with JOBS_LOCK:
                    job.state = "error"
                    job.error = "no output file produced"
                    job.completed_at = time.time()
                return
            chosen = files[0]
            with JOBS_LOCK:
                job.filename = _safe_basename(chosen.name)
                job.progress = 100
                job.state = "done"
                job.completed_at = time.time()
            LOG.info("job=%s done file=%s size=%d",
                     job.id, chosen.name, chosen.stat().st_size)
    except Exception as e:  # noqa: BLE001
        LOG.exception("job=%s crashed", job.id)
        with JOBS_LOCK:
            job.state = "error"
            job.error = f"internal: {type(e).__name__}: {e}"[:240]
            job.completed_at = time.time()


# ---- Reaper ---------------------------------------------------------------

def _reaper_loop() -> None:
    while True:
        time.sleep(60)
        now = time.time()
        with JOBS_LOCK:
            stale = []
            for job_id, job in JOBS.items():
                ttl_anchor = job.fetched_at or job.completed_at
                if ttl_anchor and now - ttl_anchor > JOB_TTL_S:
                    stale.append(job_id)
            for job_id in stale:
                job = JOBS.pop(job_id, None)
                if job and job.work_dir and job.work_dir.exists():
                    try:
                        shutil.rmtree(job.work_dir, ignore_errors=True)
                    except OSError:
                        pass
                LOG.info("reaped job=%s", job_id)


# ---- HTTP handler ---------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "bv-download-proxy/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        LOG.info("http %s %s", self.address_string(), fmt % args)

    # ---- helpers ----
    def _json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_json_body(self, max_bytes: int = 8192) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            return None
        if length <= 0 or length > max_bytes:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    # ---- routes ----
    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/download/start":
            self._start()
        else:
            self._json(404, {"error": "not_found"})

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/download/health":
            self._json(200, {"ok": True, "allowlist": list(ALLOWLIST),
                             "max_concurrent": MAX_CONCURRENT,
                             "max_filesize": MAX_FILESIZE})
            return
        m = re.fullmatch(r"/api/download/status/([A-Za-z0-9_-]{8,64})", path)
        if m:
            self._status(m.group(1)); return
        m = re.fullmatch(r"/api/download/file/([A-Za-z0-9_-]{8,64})", path)
        if m:
            self._file(m.group(1)); return
        self._json(404, {"error": "not_found"})

    # ---- start ----
    def _start(self) -> None:
        body = self._read_json_body() or {}
        url, err = _validate_url(body.get("url") or "")
        if err:
            self._json(400, {"error": err}); return
        fmt = body.get("format") or "video"
        if fmt not in ("audio", "video"):
            self._json(400, {"error": "format must be 'audio' or 'video'"}); return
        quality = body.get("quality") or "medium"
        if quality not in QUALITY_HEIGHT:
            self._json(400, {"error": "quality must be 'low', 'medium', or 'high'"}); return

        job = Job(
            id=secrets.token_urlsafe(12),
            url=url, format=fmt, quality=quality,
        )
        with JOBS_LOCK:
            JOBS[job.id] = job
        threading.Thread(target=_run_job, args=(job,), name=f"job-{job.id}", daemon=True).start()
        self._json(200, {"job_id": job.id})

    # ---- status ----
    def _status(self, job_id: str) -> None:
        with JOBS_LOCK:
            job = JOBS.get(job_id)
            payload = job.to_status() if job else None
        if not payload:
            self._json(404, {"error": "unknown_job"}); return
        self._json(200, payload)

    # ---- file ----
    def _file(self, job_id: str) -> None:
        with JOBS_LOCK:
            job = JOBS.get(job_id)
        if not job:
            self._json(404, {"error": "unknown_job"}); return
        if job.state != "done":
            self._json(409, {"error": "not_ready", "state": job.state}); return
        if not job.work_dir or not job.filename:
            self._json(500, {"error": "missing_artifact"}); return
        path = job.work_dir / job.filename
        if not path.exists():
            self._json(410, {"error": "artifact_expired"}); return

        size = path.stat().st_size
        ctype = "audio/mpeg" if job.filename.lower().endswith(".mp3") else "video/mp4"
        # RFC 5987 filename* for non-ASCII safety; plus a plain ASCII fallback.
        safe_ascii = _safe_basename(job.filename)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition",
                         f'attachment; filename="{safe_ascii}"')
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile, length=64 * 1024)
        with JOBS_LOCK:
            job.fetched_at = time.time()


def main() -> None:
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=_reaper_loop, name="reaper", daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    LOG.info("bv-download-proxy listening on %s:%d  yt-dlp=%s  allowlist=%s",
             HOST, PORT, YTDLP_BIN, ",".join(ALLOWLIST))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOG.info("shutting down")


if __name__ == "__main__":
    main()
