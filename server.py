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
import datetime
import hashlib
import hmac
import json
import mimetypes
import os
import re
import threading
import time
import ipaddress
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

    # /api/tts reaches Microsoft on this box's behalf, so an open one spends
    # this box's reputation. Empty token = no check, which is right on a
    # loopback-only bind and wrong the moment `tailscale funnel` is involved.
    "tts_token": "",
    "tts_burst_chars": 20000,   # a listener's opening run, uninterrupted
    "tts_chars_per_hour": 60000,  # ~3.7x continuous listening at 4.5 chars/sec

    # Azure Speech: the documented door to the same zh-HK voices. With a key
    # set, the browser is handed a 10-minute token and talks to Azure itself,
    # so the quota it burns is the token's and never this box's reputation.
    "azure_key": "",
    "azure_region": "",
}

# config.json key -> environment variable that overrides it.
ENV_KEYS = {
    "base_url": "TAMCHAI_BASE_URL",
    "feed_ttl": "TAMCHAI_FEED_TTL",
    "upstream_timeout": "TAMCHAI_UPSTREAM_TIMEOUT",
    "host": "TAMCHAI_HOST",
    "port": "TAMCHAI_PORT",
    "tts_token": "TAMCHAI_TTS_TOKEN",
    "azure_key": "TAMCHAI_AZURE_KEY",
    "azure_region": "TAMCHAI_AZURE_REGION",
}

TTS_VOICES = [
    {"id": "zh-HK-HiuGaaiNeural", "name": "曉佳（女）", "gender": "Female"},
    {"id": "zh-HK-HiuMaanNeural", "name": "曉曼（女）", "gender": "Female"},
    {"id": "zh-HK-WanLungNeural", "name": "雲龍（男）", "gender": "Male"},
]
TTS_CACHE_MAX_BYTES = 64 * 1024 * 1024
TTS_MAX_CHARS = 400

# Networks that reach this server without crossing anything public: loopback,
# and the ranges Tailscale hands out. A caller from here is the owner, so the
# token and the budget are both skipped.
TRUSTED_NETS = tuple(ipaddress.ip_network(n) for n in (
    "127.0.0.0/8", "::1/128",
    "100.64.0.0/10",          # tailnet IPv4 (CGNAT)
    "fd7a:115c:a1e0::/48",    # tailnet IPv6
))

# How many distinct clients the budget tracks. Past this the oldest is dropped
# — which hands a fresh budget to whoever is evicted, so the cap has to be high
# enough that reaching it means a botnet, against which a per-IP limit was
# never the defence anyway.
BUDGET_MAX_CLIENTS = 4096

AZURE_TOKEN_TTL = 540.0       # Azure issues 10-minute tokens; renew at 9

# The cache key is built from query parameters the caller chooses, so the set of
# possible keys is unbounded: ?page=1, ?page=2, ?page=99999 are three entries.
# The UI only ever asks for about a hundred distinct queries (topics, channels,
# pages), so a cap well above that costs nothing in normal use and stops an
# outside caller growing the process without limit.
FEED_CACHE_MAX_ENTRIES = 128

# Upstream query parameters the browser is allowed to pass through. Anything
# else is dropped rather than forwarded, so /api/feed can't be used to probe
# the upstream with arbitrary arguments.
FEED_PARAMS = ("topics", "channel", "page", "date", "last")

# How far back to ask for: upstream answers for one day unless told otherwise,
# and widens the whole response — digests, tasks and daily alike — in a single
# request. `date` names one day instead and wins over it.
FEED_LAST_PATTERN = re.compile(r"\d{1,2}[dh]")
FEED_DATE_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}")


def days_in(last: str) -> int:
    """How many days `last` covers: "3d" -> 3, "8h" -> 1, anything else -> 0."""
    if not FEED_LAST_PATTERN.fullmatch(last or ""):
        return 0
    return int(last[:-1]) if last.endswith("d") else 1


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
    for key in ("feed_ttl", "upstream_timeout", "chars_per_second",
                "tts_burst_chars", "tts_chars_per_hour"):
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

    def daily(self, force: bool = False, window: dict | None = None) -> dict:
        window = window or {}
        requested_date = window.get("date", "")
        requested_days = days_in(window.get("last", ""))
        raw = self.fetch({"topics": "Daily Summary", **window}, force=force)
        meta = raw.get("_meta", {})
        cps = self._config["chars_per_second"]
        days = [normalise_day(e, cps) for e in raw.get("daily") or []]
        days = sorted((d for d in days if d), key=lambda d: d["day"], reverse=True)

        if days:
            self._write_archive(days)
        merged = {d["day"]: d for d in self._read_archive()}
        merged.update({d["day"]: d for d in days})

        # The archive is a supplement, not an override. Left unfiltered it hands
        # back every day ever seen, which would make both the picker and the
        # range meaningless — one date would still answer with all of them, and
        # a wider range would look identical to a narrower one.
        if requested_date:
            merged = {day: entry for day, entry in merged.items() if day == requested_date}
        elif requested_days and merged:
            newest = max(merged)
            cutoff = (datetime.date.fromisoformat(newest)
                      - datetime.timedelta(days=requested_days - 1)).isoformat()
            merged = {day: entry for day, entry in merged.items() if day >= cutoff}
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


# ------------------------------------------------------------------- who is calling


def client_ip(peer: str, forwarded: str | None) -> str:
    """The address to hold responsible.

    `tailscale serve` and `funnel` proxy to loopback, so the socket says
    127.0.0.1 for the whole public internet — which would make every outside
    caller look like the owner. They also set X-Forwarded-For, so when the peer
    is loopback that header is the better answer.

    It is only better *because* the peer is loopback. Taken from any other peer
    it is a header the caller writes themselves, and trusting it would let
    anyone spend someone else's budget.
    """
    if forwarded and is_trusted(peer):
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    return peer


def is_trusted(addr: str) -> bool:
    """True for loopback and the tailnet — no token, no budget."""
    try:
        ip = ipaddress.ip_address(addr.strip().strip("[]").split("%")[0])
    except ValueError:
        return False
    return any(ip in net for net in TRUSTED_NETS)


class CharBudget:
    """Per-client budget for characters sent onward to Microsoft.

    Characters, not requests, because characters are what the far end meters.
    A continuous listener spends about 16k an hour at 4.5 chars/sec, so the
    default hourly figure leaves room for several devices and a pre-fetch or
    two while still bounding what one stranger can spend.
    """

    def __init__(self, burst: float, per_hour: float, max_clients: int = BUDGET_MAX_CLIENTS):
        self._burst = float(burst)
        self._per_second = float(per_hour) / 3600.0
        self._max_clients = max_clients
        self._clients: OrderedDict[str, tuple[float, float]] = OrderedDict()
        self._lock = threading.Lock()

    def charge(self, who: str, chars: int, now: float | None = None) -> float:
        """Seconds the caller must wait. 0 means the charge went through."""
        now = time.monotonic() if now is None else now
        with self._lock:
            left, seen = self._clients.get(who, (self._burst, now))
            left = min(self._burst, left + (now - seen) * self._per_second)
            short = chars - left
            if short > 0:
                self._clients[who] = (left, now)
                self._clients.move_to_end(who)
                return short / self._per_second if self._per_second else float("inf")
            self._clients[who] = (left - chars, now)
            self._clients.move_to_end(who)
            while len(self._clients) > self._max_clients:
                self._clients.popitem(last=False)
            return 0.0


class AzureToken:
    """A short-lived Azure Speech token, minted here so the key never ships.

    The browser gets ten minutes of access and talks to Azure directly; the
    quota it spends is Azure's, metered against a key we can rotate, instead of
    this box's standing with an endpoint that has no account behind it at all.
    """

    def __init__(self, key: str, region: str):
        self.key, self.region = key, region
        self._token, self._minted = "", 0.0
        self._lock = threading.Lock()

    @property
    def configured(self) -> bool:
        return bool(self.key and self.region)

    def get(self) -> tuple[str, float]:
        """`(token, seconds_left)`, minting a new one only once it is nearly up."""
        with self._lock:
            age = time.monotonic() - self._minted
            if self._token and age < AZURE_TOKEN_TTL:
                return self._token, AZURE_TOKEN_TTL - age
            request = urllib.request.Request(
                f"https://{self.region}.api.cognitive.microsoft.com/sts/v1.0/issueToken",
                data=b"",
                headers={"Ocp-Apim-Subscription-Key": self.key, "Content-Length": "0"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=10) as response:
                self._token = response.read().decode("utf-8")
            self._minted = time.monotonic()
            return self._token, AZURE_TOKEN_TTL


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

    @staticmethod
    def _key(text: str, voice: str, rate: str) -> str:
        return hashlib.sha1(f"{voice}|{rate}|{text}".encode("utf-8")).hexdigest()

    def has(self, text: str, voice: str, rate: str) -> bool:
        """Already synthesised, so serving it costs nothing outbound."""
        with self._lock:
            return self._key(text, voice, rate) in self._items

    def get(self, text: str, voice: str, rate: str) -> bytes:
        key = self._key(text, voice, rate)
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
    budget: CharBudget
    azure: AzureToken
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
            elif url.path == "/api/speech-token":
                self._api_speech_token(query)
            elif url.path == "/api/config":
                self._send_json({
                    "base_url": self.config["base_url"],
                    "feed_ttl": self.config["feed_ttl"],
                    "chars_per_second": self.config["chars_per_second"],
                    "tts": tts_available(),
                    "tts_voices": TTS_VOICES if tts_available() else [],
                    # Whether a token is wanted, never the token itself: this
                    # response is readable by anyone who can load the page.
                    "tts_token_required": bool(self.config["tts_token"]),
                    "tts_trusted": is_trusted(self._who()),
                    "azure": self.azure.configured,
                })
            elif url.path == "/api/health":
                self._send_json({"ok": True, "tts": tts_available()})
            else:
                self._static(url.path)
        except BrokenPipeError:
            pass
        except Exception as exc:                          # never take the server down
            self._send_json({"error": f"{type(exc).__name__}: {exc}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    @staticmethod
    def _window_of(query: dict) -> dict:
        """The `last`/`date` pair, dropped unless they are the shape upstream expects."""
        window = {}
        last = (query.get("last") or [""])[0].strip()
        if FEED_LAST_PATTERN.fullmatch(last):
            window["last"] = last
        date = (query.get("date") or [""])[0].strip()
        if FEED_DATE_PATTERN.fullmatch(date):
            window["date"] = date
        return window

    def _api_feed(self, query: dict) -> None:
        params = {name: query[name][0] for name in FEED_PARAMS
                  if query.get(name) and name not in ("date", "last")}
        params.update(self._window_of(query))
        force = query.get("refresh", ["0"])[0] == "1"
        self._send_json(self.upstream.fetch(params, force=force), cache="no-store")

    def _api_daily(self, query: dict) -> None:
        force = query.get("refresh", ["0"])[0] == "1"
        self._send_json(self.upstream.daily(force=force, window=self._window_of(query)),
                        cache="no-store")

    def _who(self) -> str:
        return client_ip(self.client_address[0], self.headers.get("X-Forwarded-For"))

    def _denied(self, query: dict) -> str | None:
        """The reason this caller may not synthesise, or None."""
        wanted = self.config["tts_token"]
        if not wanted or is_trusted(self._who()):
            return None
        # <audio src> cannot carry a header, so the query string has to be
        # allowed to carry the token; the header is offered for anything else.
        given = self.headers.get("X-Tamchai-Token") or (query.get("token") or [""])[0]
        return None if hmac.compare_digest(given, wanted) else "bad token"

    def _api_speech_token(self, query: dict) -> None:
        if (why := self._denied(query)) is not None:
            return self._send_json({"error": why}, HTTPStatus.UNAUTHORIZED)
        if not self.azure.configured:
            return self._send_json({"error": "azure not configured"},
                                   HTTPStatus.SERVICE_UNAVAILABLE)
        try:
            token, expires_in = self.azure.get()
        except (urllib.error.URLError, OSError) as exc:
            return self._send_json({"error": f"azure: {exc}"}, HTTPStatus.BAD_GATEWAY)
        self._send_json({"token": token, "region": self.azure.region,
                         "expires_in": round(expires_in)})

    def _api_tts(self, query: dict) -> None:
        if (why := self._denied(query)) is not None:
            return self._send_json({"error": why}, HTTPStatus.UNAUTHORIZED)
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
        # A cache hit goes out free: the budget meters what leaves this box for
        # Microsoft, and a hit sends nothing. It also means repeating yourself
        # is cheap while a stranger feeding it fresh text — every one of which
        # is a miss by construction — pays for all of it.
        if not (is_trusted(self._who()) or self.tts.has(text, voice, rate)):
            if wait := self.budget.charge(self._who(), len(text)):
                self.send_response(HTTPStatus.TOO_MANY_REQUESTS)
                self.send_header("Retry-After", str(max(1, round(wait))))
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
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
    Handler.budget = CharBudget(config["tts_burst_chars"], config["tts_chars_per_hour"])
    Handler.azure = AzureToken(config["azure_key"], config["azure_region"])
    if not config["tts_token"] and config["host"] not in ("127.0.0.1", "::1", "localhost"):
        print("warning: /api/tts has no token and is not bound to loopback — "
              "set tts_token if anything but the tailnet can reach it", flush=True)
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
