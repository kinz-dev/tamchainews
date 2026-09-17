#!/usr/bin/env python3
"""tamchainews sidecar.

Serves the reader UI and proxies the upstream "Daily Summary" JSON feed from the
same origin, which is what makes the feed reachable from a browser at all: the
upstream sends no CORS headers, speaks plain HTTP and lives on a tailnet name.

Also exposes /api/tts, which synthesises Cantonese audio on demand (edge-tts)
for devices whose browser has no zh-HK voice.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import mimetypes
import re
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

UPSTREAM = "http://sesame.tailb2a681.ts.net:8081/?topics=Daily+Summary&output=json"
FEED_TTL = 600.0          # upstream refreshes every 3h; this only shields it from hammering
UPSTREAM_TIMEOUT = 30.0
CHARS_PER_SECOND = 4.5    # measured against zh-HK neural voices at rate 1.0

TTS_VOICES = [
    {"id": "zh-HK-HiuGaaiNeural", "name": "曉佳（女）", "gender": "Female"},
    {"id": "zh-HK-HiuMaanNeural", "name": "曉曼（女）", "gender": "Female"},
    {"id": "zh-HK-WanLungNeural", "name": "雲龍（男）", "gender": "Male"},
]
TTS_CACHE_MAX_BYTES = 64 * 1024 * 1024
TTS_MAX_CHARS = 400

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"


# --------------------------------------------------------------------------- feed


def headline_of(text: str) -> str:
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("# "):
            return line[2:].strip()
        if line:
            return re.sub(r"[#*]", "", line)[:60].strip()
    return ""


def normalise_day(entry: dict) -> dict | None:
    text = (entry.get("text") or "").strip()
    day = entry.get("day") or ""
    if not text or not day or entry.get("status") != "ok":
        return None
    return {
        "day": day,
        "headline": headline_of(text),
        "text": text,
        "language": entry.get("language") or "",
        "generated_at": entry.get("finished_at") or entry.get("started_at") or 0,
        "chars": len(text),
        "est_seconds": round(len(text) / CHARS_PER_SECOND),
    }


class FeedCache:
    """TTL cache over the upstream feed, serving stale data when upstream fails."""

    def __init__(self, upstream: str, archive_dir: Path | None):
        self._upstream = upstream
        self._archive_dir = archive_dir
        self._lock = threading.Lock()
        self._days: list[dict] = []
        self._fetched_at = 0.0
        self._error: str | None = None

    def get(self, force: bool = False) -> dict:
        with self._lock:
            fresh = time.time() - self._fetched_at < FEED_TTL
            if self._days and fresh and not force:
                return self._payload(cached=True)
            try:
                days = self._fetch()
            except Exception as exc:                      # upstream down → serve what we have
                self._error = f"{type(exc).__name__}: {exc}"
                if not self._days:
                    self._days = self._read_archive()
                return self._payload(cached=True)
            self._error = None
            self._fetched_at = time.time()
            self._write_archive(days)
            merged = {d["day"]: d for d in self._read_archive()}
            merged.update({d["day"]: d for d in days})
            self._days = sorted(merged.values(), key=lambda d: d["day"], reverse=True)
            return self._payload(cached=False)

    def _payload(self, cached: bool) -> dict:
        return {
            "days": self._days,
            "fetched_at": self._fetched_at,
            "cached": cached,
            "upstream_error": self._error,
            "tts_voices": TTS_VOICES if tts_available() else [],
        }

    def _fetch(self) -> list[dict]:
        req = urllib.request.Request(self._upstream, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
        days = [normalise_day(e) for e in raw.get("daily") or []]
        return sorted((d for d in days if d), key=lambda d: d["day"], reverse=True)

    # The upstream keeps only ~3 days, so archiving is what gives the reader a history.
    def _write_archive(self, days: list[dict]) -> None:
        if not self._archive_dir:
            return
        self._archive_dir.mkdir(parents=True, exist_ok=True)
        for day in days:
            path = self._archive_dir / f"{day['day']}.json"
            payload = json.dumps(day, ensure_ascii=False, indent=1)
            if path.exists() and path.read_text(encoding="utf-8") == payload:
                continue
            path.write_text(payload, encoding="utf-8")

    def _read_archive(self) -> list[dict]:
        if not self._archive_dir or not self._archive_dir.is_dir():
            return []
        out = []
        for path in sorted(self._archive_dir.glob("*.json"), reverse=True):
            try:
                out.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
        return out


# ---------------------------------------------------------------------------- tts


def tts_available() -> bool:
    try:
        import edge_tts  # noqa: F401
    except ImportError:
        return False
    return True


class TtsCache:
    """LRU of synthesised MP3 segments, with one synth in flight per key."""

    def __init__(self, max_bytes: int = TTS_CACHE_MAX_BYTES):
        self._max_bytes = max_bytes
        self._items: OrderedDict[str, bytes] = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()
        self._inflight: dict[str, threading.Lock] = {}

    def get(self, text: str, voice: str, rate: str) -> bytes:
        key = hashlib.sha1(f"{voice}|{rate}|{text}".encode("utf-8")).hexdigest()
        with self._lock:
            if key in self._items:
                self._items.move_to_end(key)
                return self._items[key]
            gate = self._inflight.setdefault(key, threading.Lock())
        with gate:
            with self._lock:
                if key in self._items:
                    self._items.move_to_end(key)
                    return self._items[key]
            audio = synthesise(text, voice, rate)
            with self._lock:
                self._items[key] = audio
                self._bytes += len(audio)
                while self._bytes > self._max_bytes and len(self._items) > 1:
                    _, evicted = self._items.popitem(last=False)
                    self._bytes -= len(evicted)
                self._inflight.pop(key, None)
            return audio


def synthesise(text: str, voice: str, rate: str) -> bytes:
    import edge_tts

    async def run() -> bytes:
        buf = bytearray()
        async for chunk in edge_tts.Communicate(text, voice, rate=rate).stream():
            if chunk["type"] == "audio":
                buf.extend(chunk["data"])
        return bytes(buf)

    return asyncio.run(run())


# ------------------------------------------------------------------------ handler


class Handler(BaseHTTPRequestHandler):
    server_version = "tamchainews/1.0"
    protocol_version = "HTTP/1.1"

    feed: FeedCache
    tts: TtsCache

    def do_GET(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        query = parse_qs(url.query)
        try:
            if url.path == "/api/daily":
                self._api_daily(query)
            elif url.path == "/api/tts":
                self._api_tts(query)
            elif url.path == "/api/health":
                self._send_json({"ok": True, "tts": tts_available()})
            else:
                self._static(url.path)
        except BrokenPipeError:
            pass
        except Exception as exc:                          # never take the server down
            self._send_json({"error": f"{type(exc).__name__}: {exc}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def _api_daily(self, query: dict) -> None:
        payload = self.feed.get(force=query.get("refresh", ["0"])[0] == "1")
        self._send_json(payload, cache="no-store")

    def _api_tts(self, query: dict) -> None:
        text = (query.get("text") or [""])[0].strip()
        voice = (query.get("voice") or [TTS_VOICES[0]["id"]])[0]
        # A literal "+" in a query string decodes to a space, so "+10%" arrives as " 10%".
        rate = (query.get("rate") or ["+0%"])[0].strip()
        if rate and rate[0].isdigit():
            rate = f"+{rate}"
        if not text:
            return self._send_json({"error": "missing text"}, HTTPStatus.BAD_REQUEST)
        if len(text) > TTS_MAX_CHARS:
            return self._send_json({"error": "text too long"}, HTTPStatus.BAD_REQUEST)
        if voice not in {v["id"] for v in TTS_VOICES}:
            return self._send_json({"error": "unknown voice"}, HTTPStatus.BAD_REQUEST)
        if not re.fullmatch(r"[+-]\d{1,3}%", rate):
            return self._send_json({"error": "bad rate"}, HTTPStatus.BAD_REQUEST)
        if not tts_available():
            return self._send_json({"error": "edge-tts not installed"}, HTTPStatus.SERVICE_UNAVAILABLE)
        audio = self.tts.get(text, voice, rate)
        self._send_bytes(audio, "audio/mpeg", cache="public, max-age=86400")

    def _static(self, path: str) -> None:
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (WEB_ROOT / rel).resolve()
        if not target.is_file() or WEB_ROOT not in target.parents:
            return self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/manifest+json"):
            ctype += "; charset=utf-8"
        self._send_bytes(target.read_bytes(), ctype, cache="no-cache")

    def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK, cache: str = "no-store") -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(body, "application/json; charset=utf-8", status, cache)

    def _send_bytes(self, body: bytes, ctype: str, status: HTTPStatus = HTTPStatus.OK, cache: str = "no-store") -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} {fmt % args}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="tamchainews reader sidecar")
    parser.add_argument("--port", type=int, default=8082)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--upstream", default=UPSTREAM)
    parser.add_argument("--archive", default=str(ROOT / "data" / "archive"),
                        help="directory for day snapshots; empty string disables")
    args = parser.parse_args()

    Handler.feed = FeedCache(args.upstream, Path(args.archive) if args.archive else None)
    Handler.tts = TtsCache()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"tamchainews on http://{args.host}:{args.port}  upstream={args.upstream}  "
          f"tts={'edge-tts' if tts_available() else 'unavailable'}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)


if __name__ == "__main__":
    main()
