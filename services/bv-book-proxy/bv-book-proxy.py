#!/usr/bin/env python3
"""
bv-book-proxy — libgen.li search + file-download + save-to-library proxy.

Endpoints
---------
POST /api/books/search
  Body: { q?, title?, authors?, year_min?, year_max?, page? }
  -> { results: [...], source, truncated, page, cached? }

GET  /api/books/file/<md5>?format=<ext>
  -> streams the file (PDF/EPUB/…) with Content-Disposition

POST /api/books/save-to-library
  Body: { md5, title?, authors?, ext? }
  -> downloads the file into the Kavita library folder + triggers a scan
  -> { saved: true, filename }

The proxy streams libgen bytes directly; for save-to-library it writes the
file into the Kavita library volume and asks Kavita to (re)scan.
"""

from __future__ import annotations

import html as _html
import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

HOST = os.environ.get("BV_BOOKS_HOST", "127.0.0.1")
PORT = int(os.environ.get("BV_BOOKS_PORT", "8083"))
PAGE_SIZE = int(os.environ.get("BV_BOOKS_PAGE_SIZE", "25"))
FETCH_COUNT = int(os.environ.get("BV_BOOKS_FETCH_COUNT", "100"))  # libgen res=
CACHE_TTL = int(os.environ.get("BV_BOOKS_CACHE_TTL", "300"))      # 5 min

# Save-to-library config
LIBRARY_DIR = os.environ.get("BV_BOOKS_LIBRARY_DIR", "")          # e.g. /opt/kavita/library/books
KAVITA_URL = os.environ.get("BV_KAVITA_URL", "").rstrip("/")      # e.g. http://127.0.0.1:5000
KAVITA_API_KEY = os.environ.get("BV_KAVITA_API_KEY", "")
KAVITA_LIBRARY_ID = os.environ.get("BV_KAVITA_LIBRARY_ID", "1")
MAX_SAVE_BYTES = int(os.environ.get("BV_BOOKS_MAX_SAVE_BYTES", str(200 * 1024 * 1024)))
EBOOK_CONVERT = os.environ.get("BV_EBOOK_CONVERT", "/usr/bin/ebook-convert")
EBOOK_CONVERT_TIMEOUT = int(os.environ.get("BV_EBOOK_CONVERT_TIMEOUT", "240"))

LIBGEN_BASE = "https://libgen.li"
UA = "Mozilla/5.0 (compatible; bv-book-proxy/1.1)"
TIMEOUT = 25

# Topics: l=non-fiction, f=fiction, c=comics (exclude m=magazines, a=articles,
# s=standards — those are the periodicals/journals that pollute results).
# Columns: t=title, a=author (NOT y=year — a bare "1984" must not match the
# year field). objects: f=files, e=editions (editions carry title/author).
_SEARCH_QS = [
    ("res", str(FETCH_COUNT)),
    ("view", "simple"),
    ("columns[]", "t"), ("columns[]", "a"),
    ("objects[]", "f"), ("objects[]", "e"),
    ("topics[]", "l"), ("topics[]", "f"), ("topics[]", "c"),
]

BOOK_FORMATS = {"epub", "pdf", "mobi", "azw3", "azw", "djvu", "fb2", "cbz", "cbr"}
# Ebook formats we normalize to a clean EPUB via Calibre `ebook-convert` (this
# also fixes the libgen epubs that Kavita's reader otherwise rejects).
CONVERT_TO_EPUB = {"epub", "mobi", "azw3", "azw", "fb2", "lit", "prc", "pdb"}
# Formats Kavita reads directly — copied through unchanged.
PASSTHROUGH_FORMATS = {"pdf", "cbz", "cbr", "cb7", "cbt"}
# Everything we accept for save-to-library (button shown only for these).
KAVITA_FORMATS = CONVERT_TO_EPUB | PASSTHROUGH_FORMATS
_PERIODICAL = re.compile(
    r"newsletter|bi-monthly|bimonthly|magazine|bulletin|proceedings|gazette"
    r"|quarterly|journal of|annual report|conference|symposium",
    re.I,
)

_cache_lock = threading.Lock()
# query_key -> (timestamp, full_reranked_results)
_cache: dict[str, tuple[float, list[dict]]] = {}

# ---------------------------------------------------------------------------
# libgen.li helpers
# ---------------------------------------------------------------------------

def _get(url: str, timeout: int = TIMEOUT) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _td_text(td_html: str) -> str:
    return _html.unescape(re.sub(r"<[^>]+>", " ", td_html)).strip()


def _parse_size(s: str) -> int | None:
    s = s.strip()
    m = re.match(r"([\d.]+)\s*(kb|mb|gb|b)?", s, re.I)
    if not m:
        return None
    try:
        val = float(m.group(1))
        unit = (m.group(2) or "b").lower()
        mult = {"b": 1, "kb": 1024, "mb": 1024**2, "gb": 1024**3}.get(unit, 1)
        return int(val * mult)
    except (ValueError, TypeError):
        return None


def _parse_year(cell: str) -> int | None:
    """Extract the (latest) plausible 4-digit year from a messy cell like
    '1984 January 1', '1984;2014', or '2004'."""
    years = [int(y) for y in re.findall(r"\b(1\d{3}|20\d{2})\b", cell)]
    years = [y for y in years if 1000 <= y <= 2100]
    return max(years) if years else None


def _parse_pages(cell: str) -> int | None:
    """First integer in a cell like '9 / 9' or '372'."""
    m = re.search(r"\d+", cell)
    if not m:
        return None
    try:
        n = int(m.group(0))
        return n if n > 0 else None
    except ValueError:
        return None


def _relevance(b: dict, query: str) -> int:
    """Rank: exact/prefix title match dominates; periodicals demoted; English
    and real book formats nudged up. Higher = more relevant."""
    s = 0
    t = (b["title"] or "").lower().strip()
    q = query.lower().strip()
    author = " ".join(b["authors"]).lower()
    if q:
        if t == q:
            s += 1000
        elif t.startswith(q):
            s += 300
        elif q in t:
            s += 80
        for tok in [x for x in re.split(r"\s+", q) if len(x) >= 2]:
            if tok in t:
                s += 40
            if tok in author:
                s += 20
    if _PERIODICAL.search(b["title"] or "") or _PERIODICAL.search(author):
        s -= 500
    if (b["language"] or "").lower() == "english":
        s += 30
    if (b["format"] or "") in BOOK_FORMATS:
        s += 10
    if b["year"]:
        s += 1
    if len(b["title"] or "") > 90:
        s -= 20
    return s


def _search_libgen(params: dict[str, Any]) -> list[dict]:
    """Fetch + parse + rerank the FULL result set for a query (one libgen hit)."""
    qs = list(_SEARCH_QS)
    if params.get("q"):
        req = params["q"]
    elif params.get("title") or params.get("authors"):
        req = " ".join(p for p in (params.get("title"), params.get("authors")) if p)
    else:
        return []
    qs.append(("req", req))
    url = f"{LIBGEN_BASE}/index.php?" + urllib.parse.urlencode(qs)

    html_text = _get(url).decode("utf-8", errors="replace")
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", html_text, re.S | re.I)
    data_rows = [r for r in rows if "/file.php?id=" in r and "/ads.php?md5=" in r]

    results: list[dict] = []
    seen: set[str] = set()
    for row in data_rows:
        md5_m = re.search(r"/ads\.php\?md5=([a-fA-F0-9]{32})", row, re.I)
        if not md5_m:
            continue
        md5 = md5_m.group(1).lower()
        if md5 in seen:
            continue
        seen.add(md5)
        tds = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S | re.I)
        if len(tds) < 8:
            continue

        # Title: the <a href="edition.php?..."> text is the clean title; the
        # leading <b> is a series/publisher label, so prefer the edition link.
        tm = re.search(r'href="edition\.php\?[^"]*"[^>]*>([^<]+)', tds[0], re.I)
        title = (_html.unescape(tm.group(1)).strip() if tm else _td_text(tds[0])) or "(unknown title)"

        author_raw = _td_text(tds[1])
        authors = [a.strip() for a in re.split(r"[;]", author_raw) if a.strip()]

        results.append({
            "id": md5,
            "title": title,
            "authors": authors,
            "year": _parse_year(_td_text(tds[3])),
            "language": _td_text(tds[4]) or None,
            "publisher": _td_text(tds[2]) or None,
            "pages": _parse_pages(_td_text(tds[5])),
            "format": (_td_text(tds[7]).lower() or "unknown"),
            "size_bytes": _parse_size(_td_text(tds[6])),
            "source": "libgen.li",
            "cover_url": None,
        })

    # Year filters (libgen doesn't apply them server-side for this query shape)
    ymin = _to_int(params.get("year_min"))
    ymax = _to_int(params.get("year_max"))
    if ymin is not None:
        results = [r for r in results if r["year"] is None or r["year"] >= ymin]
    if ymax is not None:
        results = [r for r in results if r["year"] is None or r["year"] <= ymax]

    # Rerank for relevance.
    rank_q = params.get("q") or " ".join(
        p for p in (params.get("title"), params.get("authors")) if p
    )
    results.sort(key=lambda b: _relevance(b, rank_q), reverse=True)
    return results


def _to_int(v: Any) -> int | None:
    try:
        return int(v)
    except (ValueError, TypeError):
        return None


def _download_url(md5: str) -> str | None:
    url = f"{LIBGEN_BASE}/ads.php?md5={md5}"
    try:
        html_text = _get(url, timeout=15).decode("utf-8", errors="replace")
        m = re.search(
            r'href="((?:https?://[^"]*)?get\.php\?md5=[a-fA-F0-9]{32}&key=[A-Za-z0-9_-]+)"',
            html_text, re.I,
        )
        if not m:
            return None
        dl = m.group(1)
        if dl.startswith("/"):
            dl = LIBGEN_BASE + dl
        elif not dl.startswith("http"):
            dl = LIBGEN_BASE + "/" + dl
        return dl
    except Exception:
        return None


def _open_download(md5: str, timeout: int = 120):
    """Open the libgen file stream, retrying on transient 5xx/timeout. Each
    attempt re-scrapes ads.php for a fresh one-time key (keys are single-use)."""
    last = "download unavailable"
    for _ in range(3):
        dl = _download_url(md5)
        if not dl:
            last = "couldn't find download link"
            time.sleep(1.2)
            continue
        try:
            req = urllib.request.Request(dl, headers={"User-Agent": UA})
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            last = f"libgen mirror returned {e.code}"
            if e.code in (500, 502, 503, 504):
                time.sleep(1.5)
                continue
            raise RuntimeError(last)
        except Exception as e:  # noqa: BLE001
            last = str(e)
            time.sleep(1.5)
            continue
    raise RuntimeError(last)


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

def _cache_key(params: dict) -> str:
    return json.dumps(
        {k: (params.get(k) or "") for k in ("q", "title", "authors", "year_min", "year_max")},
        sort_keys=True,
    )


def _full_results(params: dict) -> tuple[list[dict], bool]:
    """Return (full_reranked_list, was_cached)."""
    key = _cache_key(params)
    with _cache_lock:
        entry = _cache.get(key)
        if entry and (time.time() - entry[0]) < CACHE_TTL:
            return entry[1], True
        _cache.pop(key, None)
    results = _search_libgen(params)
    with _cache_lock:
        if len(_cache) > 200:
            for k, _ in sorted(_cache.items(), key=lambda x: x[1][0])[:50]:
                _cache.pop(k, None)
        _cache[key] = (time.time(), results)
    return results, False


# ---------------------------------------------------------------------------
# Save to library
# ---------------------------------------------------------------------------

def _safe_filename(name: str) -> str:
    # Strip catalogue annotations that wreck Kavita's filename parser:
    # "(auteur.)", "(trans.)", "[1984-]", "[retail]", commas/semicolons, and
    # any path-unsafe characters.
    name = re.sub(r"\([^)]*\)", " ", name)
    name = re.sub(r"\[[^\]]*\]", " ", name)
    name = re.sub(r"[\\/:*?\"<>|,;]+", " ", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name[:150] or "book"


def _save_to_library(md5: str, title: str, authors: list[str], ext: str) -> tuple[bool, str]:
    if not LIBRARY_DIR:
        raise RuntimeError("library not configured")

    ext = re.sub(r"[^a-z0-9]", "", (ext or "").lower()) or "bin"
    # First author only (cleaned) + title — keeps the name short and Kavita-safe.
    stem_parts = []
    if authors:
        stem_parts.append(authors[0])
    stem_parts.append(title or md5)
    stem = _safe_filename(" - ".join(p for p in stem_parts if p))
    # Kavita reliably indexes one book per folder, so file into a per-book dir.
    book_dir = os.path.join(LIBRARY_DIR, stem)
    os.makedirs(book_dir, exist_ok=True)

    # 1) Download the original into a hidden work file inside the book dir.
    work = os.path.join(book_dir, f".dl-{md5}.{ext}")
    written = 0
    with _open_download(md5, timeout=120) as upstream, open(work, "wb") as fh:
        while True:
            chunk = upstream.read(65536)
            if not chunk:
                break
            written += len(chunk)
            if written > MAX_SAVE_BYTES:
                fh.close()
                os.remove(work)
                raise RuntimeError("file too large")
            fh.write(chunk)

    # 2) Normalize ebooks to a clean EPUB (Kavita reads these reliably; raw
    #    libgen epubs it often rejects). PDFs/comics are copied through as-is.
    if ext in CONVERT_TO_EPUB:
        dest = os.path.join(book_dir, f"{stem}.epub")
        try:
            subprocess.run(
                [EBOOK_CONVERT, work, dest],
                timeout=EBOOK_CONVERT_TIMEOUT, check=True,
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            )
            os.remove(work)
            filename = f"{stem}.epub"
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError) as e:
            # Conversion failed. If the source was already epub, keep it as-is
            # (Kavita may still read it); otherwise we can't index it.
            if ext == "epub":
                dest = os.path.join(book_dir, f"{stem}.epub")
                os.replace(work, dest)
                filename = f"{stem}.epub"
            else:
                if os.path.exists(work):
                    os.remove(work)
                raise RuntimeError(f"couldn't convert .{ext} to epub")
    else:  # passthrough (pdf/cbz/cbr/…)
        dest = os.path.join(book_dir, f"{stem}.{ext}")
        os.replace(work, dest)
        filename = f"{stem}.{ext}"

    try:
        os.chmod(dest, 0o644)
    except OSError:
        pass

    _trigger_kavita_scan()
    return True, filename


def _trigger_kavita_scan() -> None:
    if not KAVITA_URL or not KAVITA_API_KEY:
        return
    url = f"{KAVITA_URL}/api/Library/scan?libraryId={KAVITA_LIBRARY_ID}&force=false"
    req = urllib.request.Request(url, method="POST", headers={
        "x-api-key": KAVITA_API_KEY,
        "Content-Length": "0",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            r.read()
    except Exception:
        pass  # scan is best-effort; the file is already on disk


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass

    def _send_json(self, code: int, obj: Any) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, code: int, msg: str) -> None:
        self._send_json(code, {"error": msg})

    def _read_json(self) -> Any:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw)

    def do_POST(self) -> None:
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/books/search":
            self._handle_search()
        elif path == "/api/books/save-to-library":
            self._handle_save()
        else:
            self._send_error(404, "not found")

    def _handle_search(self) -> None:
        try:
            body = self._read_json()
        except json.JSONDecodeError:
            self._send_error(400, "invalid JSON")
            return
        q = (body.get("q") or "").strip()
        title = (body.get("title") or "").strip()
        authors = (body.get("authors") or "").strip()
        page = max(1, _to_int(body.get("page")) or 1)
        if not q and not title and not authors:
            self._send_error(400, "at least one of q, title, or authors is required")
            return
        params = {
            "q": q, "title": title, "authors": authors,
            "year_min": body.get("year_min"), "year_max": body.get("year_max"),
        }
        try:
            full, cached = _full_results(params)
        except Exception as e:
            self._send_error(502, f"upstream error: {e}")
            return
        start = (page - 1) * PAGE_SIZE
        page_items = full[start:start + PAGE_SIZE]
        self._send_json(200, {
            "results": page_items,
            "source": "libgen.li",
            "truncated": start + PAGE_SIZE < len(full),
            "page": page,
            "cached": cached,
        })

    def _handle_save(self) -> None:
        try:
            body = self._read_json()
        except json.JSONDecodeError:
            self._send_error(400, "invalid JSON")
            return
        md5 = (body.get("md5") or body.get("id") or "").strip().lower()
        if not re.fullmatch(r"[a-f0-9]{32}", md5):
            self._send_error(400, "valid md5 is required")
            return
        if not LIBRARY_DIR or not KAVITA_URL:
            self._send_error(501, "online library is not configured")
            return
        title = (body.get("title") or "").strip()
        authors = body.get("authors") or []
        if isinstance(authors, str):
            authors = [authors]
        ext = (body.get("ext") or body.get("format") or "epub").strip().lower()
        if ext not in KAVITA_FORMATS:
            self._send_error(415, f"the online library can't read .{ext} files (use EPUB or PDF)")
            return
        try:
            ok, filename = _save_to_library(md5, title, authors, ext)
        except Exception as e:
            self._send_error(502, f"save failed: {e}")
            return
        self._send_json(200, {"saved": ok, "filename": filename})

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        m = re.match(r"^/api/books/file/([a-fA-F0-9]{32})$", parsed.path)
        if not m:
            self._send_error(404, "not found")
            return
        md5 = m.group(1).lower()
        qs = urllib.parse.parse_qs(parsed.query)
        fmt = (qs.get("format") or ["pdf"])[0].lower()
        try:
            with _open_download(md5, timeout=60) as upstream:
                ct = upstream.headers.get("Content-Type") or "application/octet-stream"
                cl = upstream.headers.get("Content-Length") or ""
                cd = upstream.headers.get("Content-Disposition") or ""
                if not cd or "filename" not in cd.lower():
                    cd = f'attachment; filename="{md5}.{fmt}"'
                self.send_response(200)
                self.send_header("Content-Type", ct)
                if cl:
                    self.send_header("Content-Length", cl)
                self.send_header("Content-Disposition", cd)
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                while True:
                    data = upstream.read(65536)
                    if not data:
                        break
                    self.wfile.write(data)
        except Exception as e:
            try:
                self._send_error(502, f"download failed: {e}")
            except Exception:
                pass


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"bv-book-proxy listening on {HOST}:{PORT}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
