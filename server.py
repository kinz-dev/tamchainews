#!/usr/bin/env python3
"""tamchainews sidecar.

Serves the reader UI and proxies the upstream newsfeed monitor from the same
origin, which is what makes the feed reachable from a browser at all: the
upstream sends no CORS headers, speaks plain HTTP and lives on a tailnet name.

Also exposes /api/tts, which synthesises Cantonese audio on demand (edge-tts)
for devices whose browser has no zh-HK voice.

Every upstream address derives from one `base_url`, set in config.json and
overridable by TAMCHAI_BASE_URL or --base-url.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import mimetypes
import os
import re
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
CONFIG_PATH = ROOT / "config.json"

# Fallbacks for every key config.json may set. The file is the source of truth;
# these only keep the server runnable if it is missing or half-filled.
DEFAULTS = {
    "base_url": "http://sesame.tailb2a681.ts.net:8081",
    "feed_ttl": 600.0,          # upstream refreshes every 2h; this only shields it from hammering
    "upstream_timeout": 30.0,
    "chars_per_second": 4.5,    # measured against zh-HK neural voices at rate 1.0
    "host": "127.0.0.1",
    "port": 8082,
}

# config.json key -> environment variable that overrides it.
ENV_KEYS = {
    "base_url": "TAMCHAI_BASE_URL",
    "feed_ttl": "TAMCHAI_FEED_TTL",
    "upstream_timeout": "TAMCHAI_UPSTREAM_TIMEOUT",
    "host": "TAMCHAI_HOST",
    "port": "TAMCHAI_PORT",
}

TTS_VOICES = [
    {"id": "zh-HK-HiuGaaiNeural", "name": "曉佳（女）", "gender": "Female"},
    {"id": "zh-HK-HiuMaanNeural", "name": "曉曼（女）", "gender": "Female"},
    {"id": "zh-HK-WanLungNeural", "name": "雲龍（男）", "gender": "Male"},
]
TTS_CACHE_MAX_BYTES = 64 * 1024 * 1024
TTS_MAX_CHARS = 400

# The cache key is built from query parameters the caller chooses, so the set of
# possible keys is unbounded: ?page=1, ?page=2, ?page=99999 are three entries.
# The UI only ever asks for about a hundred distinct queries (topics, channels,
# pages), so a cap well above that costs nothing in normal use and stops an
# outside caller growing the process without limit.
FEED_CACHE_MAX_ENTRIES = 128

# Upstream query parameters the browser is allowed to pass through. Anything
# else is dropped rather than forwarded, so /api/feed can't be used to probe
# the upstream with arbitrary arguments.
FEED_PARAMS = ("topics", "channel", "page", "date")


# -------------------------------------------------------------------------- config


def load_config(path: Path = CONFIG_PATH, overrides: dict | None = None) -> dict:
    """Merge, lowest priority first: DEFAULTS, config.json, environment, CLI."""
    config = dict(DEFAULTS)

    try:
        config.update(json.loads(path.read_text(encoding="utf-8")))
    except FileNotFoundError:
        pass
    except (OSError, json.JSONDecodeError) as exc:
        print(f"warning: ignoring {path.name}: {exc}", flush=True)

    for key, env in ENV_KEYS.items():
        value = os.environ.get(env)
        if value:
            config[key] = value

    for key, value in (overrides or {}).items():
        if value is not None:
            config[key] = value

    config["base_url"] = str(config["base_url"]).rstrip("/")
    for key in ("feed_ttl", "upstream_timeout", "chars_per_second"):
        config[key] = float(config[key])
    config["port"] = int(config["port"])
    return config


def upstream_url(base_url: str, params: dict | None = None) -> str:
    """Every upstream address is this one function; nothing else hardcodes a host."""
    query = {k: v for k, v in (params or {}).items() if v not in (None, "")}
    query["output"] = "json"
    return f"{base_url}/?{urlencode(query)}"


# --------------------------------------------------------------------------- feed


def headline_of(text: str) -> str:
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("# "):
            return line[2:].strip()
        if line:
            return re.sub(r"[#*]", "", line)[:60].strip()
    return ""


def normalise_day(entry: dict, chars_per_second: float) -> dict | None:
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
        "est_seconds": round(len(text) / chars_per_second),
    }


class Upstream:
    """TTL cache over upstream queries, serving stale data when upstream fails.

    One entry per distinct query, because the UI browses by topic, channel and
    page — and the upstream is single-threaded, so repeat views must not reach it.
    """

    def __init__(self, config: dict, archive_dir: Path | None,
                 max_entries: int = FEED_CACHE_MAX_ENTRIES):
        self._config = config
        self._archive_dir = archive_dir
        self._max_entries = max_entries
        self._lock = threading.Lock()
        # LRU, like the audio cache: least recently used falls off the front.
        self._entries: OrderedDict[str, dict] = OrderedDict()
        self._inflight: dict[str, threading.Lock] = {}

    # -- raw queries ------------------------------------------------------

    def fetch(self, params: dict, force: bool = False) -> dict:
        """Upstream payload for `params`, wrapped with cache/error metadata."""
        key = urlencode(sorted((k, str(v)) for k, v in params.items()))
        ttl = self._config["feed_ttl"]

        with self._lock:
            entry = self._entries.get(key)
            if entry and not force and time.time() - entry["fetched_at"] < ttl:
                self._entries.move_to_end(key)
                return self._wrap(entry, cached=True)
            gate = self._inflight.setdefault(key, threading.Lock())

        with gate:
            with self._lock:                      # another thread may have just filled it
                entry = self._entries.get(key)
                if entry and not force and time.time() - entry["fetched_at"] < ttl:
                    self._entries.move_to_end(key)
                    return self._wrap(entry, cached=True)
            try:
                payload = self._get(params)
                error = None
            except Exception as exc:              # upstream down → serve what we have
                payload, error = None, f"{type(exc).__name__}: {exc}"
            with self._lock:
                previous = self._entries.get(key)
                if payload is None and previous:
                    previous["error"] = error
                    self._entries.move_to_end(key)
                    result = self._wrap(previous, cached=True)
                else:
                    entry = {
                        "payload": payload if payload is not None else {},
                        "fetched_at": time.time() if payload is not None else 0.0,
                        "error": error,
                    }
                    self._entries[key] = entry
                    self._entries.move_to_end(key)
                    while len(self._entries) > self._max_entries:
                        self._entries.popitem(last=False)
                    result = self._wrap(entry, cached=False)
                self._inflight.pop(key, None)
            return result

    def _wrap(self, entry: dict, cached: bool) -> dict:
        payload = dict(entry["payload"])
        payload["_meta"] = {
            "cached": cached,
            "fetched_at": entry["fetched_at"],
            "upstream_error": entry["error"],
            "base_url": self._config["base_url"],
        }
        return payload

    def _get(self, params: dict) -> dict:
        url = upstream_url(self._config["base_url"], params)
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=self._config["upstream_timeout"]) as resp:
            return json.loads(resp.read().decode("utf-8"))

    # -- the Daily Summary view, which is archived ------------------------

    def daily(self, force: bool = False) -> dict:
        raw = self.fetch({"topics": "Daily Summary"}, force=force)
        meta = raw.get("_meta", {})
        cps = self._config["chars_per_second"]
        days = [normalise_day(e, cps) for e in raw.get("daily") or []]
        days = sorted((d for d in days if d), key=lambda d: d["day"], reverse=True)

        if days:
            self._write_archive(days)
        merged = {d["day"]: d for d in self._read_archive()}
        merged.update({d["day"]: d for d in days})
        return {
            "days": sorted(merged.values(), key=lambda d: d["day"], reverse=True),
            "fetched_at": meta.get("fetched_at", 0.0),
            "cached": meta.get("cached", False),
            "upstream_error": meta.get("upstream_error"),
            "tts_voices": TTS_VOICES if tts_available() else [],
        }

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
    server_version = "tamchainews/2.0"
    protocol_version = "HTTP/1.1"

    upstream: Upstream
    tts: TtsCache
    config: dict

    def do_GET(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        query = parse_qs(url.query)
        try:
            if url.path == "/api/feed":
                self._api_feed(query)
            elif url.path == "/api/daily":
                self._api_daily(query)
            elif url.path == "/api/tts":
                self._api_tts(query)
            elif url.path == "/api/config":
                self._send_json({
                    "base_url": self.config["base_url"],
                    "feed_ttl": self.config["feed_ttl"],
                    "chars_per_second": self.config["chars_per_second"],
                    "tts": tts_available(),
                    "tts_voices": TTS_VOICES if tts_available() else [],
                })
            elif url.path == "/api/health":
                self._send_json({"ok": True, "tts": tts_available()})
            else:
                self._static(url.path)
        except BrokenPipeError:
            pass
        except Exception as exc:                          # never take the server down
            self._send_json({"error": f"{type(exc).__name__}: {exc}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def _api_feed(self, query: dict) -> None:
        params = {name: query[name][0] for name in FEED_PARAMS if query.get(name)}
        force = query.get("refresh", ["0"])[0] == "1"
        self._send_json(self.upstream.fetch(params, force=force), cache="no-store")

    def _api_daily(self, query: dict) -> None:
        force = query.get("refresh", ["0"])[0] == "1"
        self._send_json(self.upstream.daily(force=force), cache="no-store")

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

        # "no-cache" alone tells the browser to revalidate, but with nothing to
        # revalidate against it may reuse its copy anyway — which serves an
        # edited file's old contents after a reload. An ETag gives it something
        # to ask about, and makes the answer cheap when nothing changed.
        stat = target.stat()
        etag = f'"{int(stat.st_mtime)}-{stat.st_size}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(HTTPStatus.NOT_MODIFIED)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/manifest+json"):
            ctype += "; charset=utf-8"
        self._send_bytes(target.read_bytes(), ctype, cache="no-cache", etag=etag)

    def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK, cache: str = "no-store") -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(body, "application/json; charset=utf-8", status, cache)

    def _send_bytes(self, body: bytes, ctype: str, status: HTTPStatus = HTTPStatus.OK,
                    cache: str = "no-store", etag: str | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        if etag:
            self.send_header("ETag", etag)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        print(f"{self.address_string()} {fmt % args}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="tamchainews reader sidecar")
    parser.add_argument("--port", type=int, help="overrides config.json")
    parser.add_argument("--host", help="overrides config.json")
    parser.add_argument("--base-url", dest="base_url",
                        help="upstream newsfeed monitor, e.g. http://host:8081 (overrides config.json)")
    parser.add_argument("--config", default=str(CONFIG_PATH), help="path to config.json")
    parser.add_argument("--archive", default=str(ROOT / "data" / "archive"),
                        help="directory for day snapshots; empty string disables")
    args = parser.parse_args()

    config = load_config(Path(args.config), {
        "base_url": args.base_url,
        "host": args.host,
        "port": args.port,
    })

    Handler.config = config
    Handler.upstream = Upstream(config, Path(args.archive) if args.archive else None)
    Handler.tts = TtsCache()
    httpd = ThreadingHTTPServer((config["host"], config["port"]), Handler)
    print(f"tamchainews on http://{config['host']}:{config['port']}  "
          f"upstream={config['base_url']}  "
          f"tts={'edge-tts' if tts_available() else 'unavailable'}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)


if __name__ == "__main__":
    main()
