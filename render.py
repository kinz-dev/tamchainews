"""Renders an archived day into one MP3, so the archive can leave the browser.

The reader synthesises a sentence at a time, on demand, because that is what a
page being read along with needs. A podcast needs the opposite: one file per
day, finished before you wake up, that a car or a phone can download whole.

**Why concatenation is enough.** edge-tts returns constant-bitrate 48 kbps,
24 kHz mono MP3 in 144-byte frames with no ID3 header on either end — measured,
not assumed. So joining two clips is joining two byte strings, the result plays
as one, and **duration is bytes ÷ 6000 exactly**. Every offset this module
records is a byte count that converts to a timestamp by division, which is what
makes chapters and the 快讀 cut exact rather than approximate.

**Why a block at a time, and not a sentence.** `speech.js` splits to ~90
characters because a browser utterance falls over past that. Nothing here has
that limit, and a whole paragraph read in one request keeps the prosody that
sentence-by-sentence synthesis throws away — the voice carries a clause across a
comma instead of restarting at every full stop. It also cuts the number of calls
out to Microsoft by a factor of five.

**The duplication, stated plainly.** The pronunciation rules and the shape of a
cut exist here *and* in `web/speech.js` / `web/cut.js`, because the page is
JavaScript and this is Python and there is no third place to put them. They are
pinned from both sides: `tests/test_render.py` and `tests/speech.test.js` assert
the same table of cases, so a rule changed in one language and not the other
fails a suite rather than quietly reading the news differently out loud.
"""

from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path

# CBR 48 kbps: one second of audio is exactly this many bytes. Measured against
# the stream edge-tts actually returns, and checked by a test, because every
# timestamp in a feed is derived from it.
BYTES_PER_SECOND = 6000

# One MP3 frame at 24 kHz / 48 kbps carries 576 samples in 144 bytes.
FRAME_BYTES = 144


def seconds_of(byte_count: int) -> float:
    return byte_count / BYTES_PER_SECOND


# --------------------------------------------------------------- 讀法
# Mirrors PRONUNCIATION in web/speech.js. Same order, same effect; only the
# substitution syntax differs. tests/test_render.py pins both.

# `\b` does not mean the same thing in the two languages, and the difference is
# audible. JavaScript's word characters are ASCII, so 「本地生產總值GDP」 has a
# boundary before the G and the page says "G D P". Python's are Unicode, 漢字
# included, so there is no boundary there and the renderer would have said
# "GDP" — the page and the podcast reading the same sentence differently. These
# spell out the ASCII rule the page is really using.
def _latin(term: str, *, tail: bool = True) -> str:
    return rf"(?<![A-Za-z0-9]){term}" + (r"(?![A-Za-z0-9])" if tail else "")


PRONUNCIATION: list[tuple[re.Pattern, str]] = [
    # "[12]" is a citation marker: a link on screen, noise out loud.
    (re.compile(r"\s*\[\d{1,3}\]"), ""),
    # The digests gloss acronyms as "聯邦儲備局（Fed）". Spoken, the gloss doubles
    # every term up, so a parenthetical that is only Latin goes.
    (re.compile(r"(?<=[一-鿿》」』）)])\s*[（(]\s*[A-Za-z][A-Za-z0-9.&'\- ]{0,19}\s*[）)]"), ""),
    # "3.75%" → "百分之3.75": Chinese puts the marker before the number.
    (re.compile(r"(\d+(?:\.\d+)?)\s*%"), r"百分之\1"),
    (re.compile(_latin("FOMC")), "聯邦公開市場委員會"),
    (re.compile(_latin("Fed")), "聯儲局"),
    (re.compile(_latin("GDP")), "G D P"),
    (re.compile(_latin("AI")), "A I"),
    (re.compile(_latin(r"US\$?\s*(\d)", tail=False)), r"\1"),
    (re.compile(r"\$\s*(\d+(?:\.\d+)?)\s*(萬億|億|萬|千)?"), r"\1\2美元"),
    (re.compile(r"\s*[·•]\s*"), "，"),
]

_INLINE = [
    (re.compile(r"!?\[([^\]]*)\]\([^)]*\)"), r"\1"),   # links/images → their label
    (re.compile(r"\*\*([^*]+)\*\*"), r"\1"),
    (re.compile(r"(?<!\*)\*(?!\*)([^*]+)\*(?!\*)"), r"\1"),
    (re.compile(r"`([^`]+)`"), r"\1"),
]


def normalise_for_speech(text: str) -> str:
    out = text
    for pattern, replacement in PRONUNCIATION:
        out = pattern.sub(replacement, out)
    return re.sub(r"\s+", " ", out).strip()


def strip_inline(text: str) -> str:
    out = text
    for pattern, replacement in _INLINE:
        out = pattern.sub(replacement, out)
    return out.strip()


# --------------------------------------------------------------- 分段

_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_BULLET = re.compile(r"^(\s*)[*+-]\s+(.*)$")


def blocks_of(markdown: str) -> list[dict]:
    """Markdown → [{kind, text, speak}], one entry per heading, paragraph or bullet.

    The same block structure `speech.js` builds, stopping short of its sentence
    split: a paragraph stays whole so the voice can read it as one.
    """
    blocks: list[dict] = []
    paragraph: list[str] = []

    def flush() -> None:
        nonlocal paragraph
        if not paragraph:
            return
        text = strip_inline(" ".join(paragraph))
        paragraph = []
        if text:
            blocks.append(_block("p", text))

    for raw in markdown.splitlines():
        line = raw.rstrip()
        if not line.strip():
            flush()
            continue
        heading = _HEADING.match(line)
        if heading:
            flush()
            text = strip_inline(heading.group(2))
            if text:
                blocks.append(_block(f"h{min(len(heading.group(1)), 3)}", text))
            continue
        bullet = _BULLET.match(line)
        if bullet:
            flush()
            text = strip_inline(bullet.group(2))
            if text:
                blocks.append(_block("li", text))
            continue
        paragraph.append(line.strip())
    flush()
    return blocks


def _block(kind: str, text: str) -> dict:
    speak = normalise_for_speech(text)
    # A heading ends without punctuation, so the voice runs straight on into the
    # paragraph under it. The page spends 550ms of silence there; a file cannot,
    # so the full stop it never shows is what buys the pause.
    if kind.startswith("h") and speak and speak[-1] not in "。！？，、；：.!?":
        speak += "。"
    return {"kind": kind, "text": text, "speak": speak}


# --------------------------------------------------------------- 剪裁
# Mirrors web/cut.js. Only the cuts that fall on a block boundary live here:
# 提要 takes the first *sentence* of a paragraph, which a block-level render
# cannot slice, so the feed offers 快讀 and 全文 and says so.

_OUTLOOK_HEADING = re.compile(r"^.{0,4}市場情緒展望$")
_TRAILING_PAREN = re.compile(r"[（(][^）)]*[）)]\s*$")

CUTS = ("quick", "full")


def lead_end(blocks: list[dict]) -> int:
    """Where the lead ends: the first heading under the title."""
    for i in range(1, len(blocks)):
        if blocks[i]["kind"].startswith("h"):
            return i
    return len(blocks)


def outlook_range(blocks: list[dict]) -> tuple[int, int] | None:
    """The market-outlook tail: its heading, and everything under it."""
    for i in range(1, len(blocks)):
        block = blocks[i]
        kind = block["kind"]
        if not kind.startswith("h") or kind == "h1":
            continue
        bare = _TRAILING_PAREN.sub("", block["text"].strip()).strip()
        if not _OUTLOOK_HEADING.fullmatch(bare):
            continue
        to = len(blocks)
        for j in range(i + 1, len(blocks)):
            other = blocks[j]["kind"]
            if other.startswith("h") and other <= kind:
                to = j
                break
        return i, to
    return None


def kept_blocks(blocks: list[dict], cut: str = "full", skip_outlook: bool = False) -> list[int]:
    """Which block indices a cut reads, in order."""
    limit = lead_end(blocks) if cut == "quick" else len(blocks)
    tail = outlook_range(blocks) if skip_outlook else None
    keep = []
    for i in range(min(limit, len(blocks))):
        if tail and tail[0] <= i < tail[1]:
            continue
        keep.append(i)
    return keep


# --------------------------------------------------------------- 出街


class Renderer:
    """Turns archived days into `<day>.mp3` + `<day>.json` under `audio/`.

    One day at a time, newest missing first, paced between blocks: this reaches
    the same reverse-engineered Microsoft endpoint `/api/tts` does, and the point
    of Day 0's budget was that nothing here should spend the box's standing in a
    burst. A day is roughly twenty requests, once.
    """

    def __init__(self, archive_dir: Path | None, audio_dir: Path | None,
                 synthesise, voice: str, rate: str = "+0%",
                 keep_days: int = 30, pause: float = 0.4):
        self._archive_dir = archive_dir
        self._audio_dir = audio_dir
        self._synthesise = synthesise
        self.voice = voice
        self.rate = rate
        self.keep_days = keep_days
        self._pause = pause

    @property
    def ready(self) -> bool:
        return bool(self._archive_dir and self._audio_dir and self.voice)

    # -- what exists ---------------------------------------------------

    def manifest(self, day: str) -> dict | None:
        if not self._audio_dir:
            return None
        path = self._audio_dir / f"{day}.json"
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def audio_path(self, day: str) -> Path | None:
        if not self._audio_dir:
            return None
        path = self._audio_dir / f"{day}.mp3"
        return path if path.is_file() else None

    def episodes(self) -> list[dict]:
        """Every rendered day, newest first."""
        if not self._audio_dir or not self._audio_dir.is_dir():
            return []
        out = []
        for path in sorted(self._audio_dir.glob("*.json"), reverse=True):
            entry = self.manifest(path.stem)
            if entry and self.audio_path(path.stem):
                out.append(entry)
        return out

    # -- slicing -------------------------------------------------------

    def slice_for(self, manifest: dict, cut: str = "full", skip_outlook: bool = False) -> list[tuple[int, int]]:
        """Byte ranges of the blocks a cut reads.

        Adjacent blocks are merged into one range, so 全文 is a single read of
        the whole file and 快讀 is a single read of its first few seconds —
        the cuts cost no reassembly at all in the common cases.
        """
        blocks = manifest.get("blocks") or []
        keep = kept_blocks(blocks, cut, skip_outlook)
        ranges: list[list[int]] = []
        for i in keep:
            block = blocks[i]
            start, end = block["offset"], block["offset"] + block["bytes"]
            if ranges and ranges[-1][1] == start:
                ranges[-1][1] = end
            else:
                ranges.append([start, end])
        return [(a, b) for a, b in ranges]

    def audio_for(self, day: str, cut: str = "full", skip_outlook: bool = False) -> bytes | None:
        manifest = self.manifest(day)
        path = self.audio_path(day)
        if not manifest or not path:
            return None
        ranges = self.slice_for(manifest, cut, skip_outlook)
        if not ranges:
            return b""
        data = path.read_bytes()
        if len(ranges) == 1 and ranges[0] == (0, len(data)):
            return data
        return b"".join(data[a:b] for a, b in ranges)

    def chapters_for(self, day: str) -> list[dict]:
        """Podcasting 2.0 chapters: one per heading, at its own timestamp."""
        manifest = self.manifest(day)
        if not manifest:
            return []
        out = []
        for block in manifest.get("blocks") or []:
            if block["kind"] in ("h1", "h2"):
                out.append({"startTime": round(seconds_of(block["offset"]), 3),
                            "title": block["text"]})
        return out

    # -- rendering -----------------------------------------------------

    def pending(self, days: list[dict]) -> list[dict]:
        """Archived days with no audio, or whose text has changed since it was made."""
        out = []
        for day in days:
            existing = self.manifest(day["day"])
            if existing and existing.get("source") == _digest_of(day.get("text", "")) \
                    and self.audio_path(day["day"]):
                continue
            out.append(day)
        return out

    def render(self, day: dict) -> dict:
        """Synthesise one day, block by block, and write the pair of files."""
        blocks = blocks_of(day.get("text") or "")
        audio = bytearray()
        rendered = []
        for block in blocks:
            if not block["speak"]:
                continue
            clip = self._synthesise(block["speak"], self.voice, self.rate)
            rendered.append({
                "kind": block["kind"],
                "text": block["text"],
                "offset": len(audio),
                "bytes": len(clip),
                "seconds": round(seconds_of(len(clip)), 3),
            })
            audio.extend(clip)
            if self._pause:
                time.sleep(self._pause)

        manifest = {
            "day": day["day"],
            "headline": day.get("headline") or day["day"],
            "source": _digest_of(day.get("text", "")),
            "voice": self.voice,
            "rate": self.rate,
            "bytes": len(audio),
            "seconds": round(seconds_of(len(audio)), 3),
            "generated_at": day.get("generated_at") or 0,
            "rendered_at": int(time.time()),
            "blocks": rendered,
        }
        self._audio_dir.mkdir(parents=True, exist_ok=True)
        (self._audio_dir / f"{day['day']}.mp3").write_bytes(bytes(audio))
        (self._audio_dir / f"{day['day']}.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
        return manifest

    def sweep(self) -> int:
        """Drop the oldest audio past `keep_days`. Text is kept for ever; audio is not.

        A day of audio is ~4 MB against ~4 KB of text, so the archive stays
        walkable-away-with at a thousandth of the disk — and an episode nobody
        downloaded in a month can always be rendered again from the text.
        """
        if not self._audio_dir or not self._audio_dir.is_dir():
            return 0
        days = sorted((p.stem for p in self._audio_dir.glob("*.mp3")), reverse=True)
        dropped = 0
        for day in days[self.keep_days:]:
            for suffix in (".mp3", ".json"):
                try:
                    (self._audio_dir / f"{day}{suffix}").unlink()
                except OSError:
                    continue
            dropped += 1
        return dropped


def _digest_of(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:16]


# --------------------------------------------------------------- RSS

_RFC2822 = "%a, %d %b %Y %H:%M:%S +0000"


def rfc2822(epoch: float) -> str:
    return time.strftime(_RFC2822, time.gmtime(epoch))


def clock(seconds: float) -> str:
    total = int(round(seconds))
    return f"{total // 3600:d}:{total // 60 % 60:02d}:{total % 60:02d}"


def _xml(text: str) -> str:
    return (str(text).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def podcast_xml(episodes: list[dict], base: str, *, cut: str = "full",
                skip_outlook: bool = False, title: str = "譚仔新聞",
                slices=None) -> str:
    """One episode per rendered day, newest first.

    `slices` gives each episode's byte length under this cut — an enclosure that
    lies about its length is one a client may truncate or refuse, and the whole
    point of the cut is that the number is real.
    """
    query = []
    if cut != "full":
        query.append(f"cut={cut}")
    if skip_outlook:
        query.append("skip=outlook")
    suffix = ("&" + "&".join(query)) if query else ""
    label = {"quick": "快讀", "full": "全文"}.get(cut, cut)

    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"'
           ' xmlns:podcast="https://podcastindex.org/namespace/1.0"'
           ' xmlns:atom="http://www.w3.org/2005/Atom">',
           "<channel>",
           f"<title>{_xml(title)}{'' if cut == 'full' else ' · ' + label}</title>",
           f"<link>{_xml(base)}/</link>",
           "<language>zh-HK</language>",
           "<itunes:author>譚仔新聞</itunes:author>",
           "<itunes:explicit>false</itunes:explicit>",
           f"<description>{_xml('每日新聞總覽，粵語朗讀。' + ('' if cut == 'full' else '快讀版：標題同導語。'))}</description>",
           f'<atom:link href="{_xml(base)}/api/podcast.xml{"?" + "&amp;".join(query) if query else ""}"'
           ' rel="self" type="application/rss+xml"/>']

    for episode in episodes:
        day = episode["day"]
        length = (slices or {}).get(day, episode["bytes"])
        seconds = seconds_of(length)
        published = episode.get("generated_at") or episode.get("rendered_at") or 0
        link = f"{base}/api/episode.mp3?day={day}{suffix}"
        out += [
            "<item>",
            f"<title>{_xml(day)} {_xml(episode.get('headline') or '')}</title>",
            f"<guid isPermaLink=\"false\">tamchai-{_xml(day)}-{_xml(cut)}{'-nooutlook' if skip_outlook else ''}</guid>",
            f"<pubDate>{rfc2822(published)}</pubDate>",
            f'<enclosure url="{_xml(link)}" length="{length}" type="audio/mpeg"/>',
            f"<itunes:duration>{clock(seconds)}</itunes:duration>",
            f"<description>{_xml(episode.get('headline') or day)}</description>",
        ]
        if cut == "full" and not skip_outlook:
            out.append(f'<podcast:chapters url="{_xml(base)}/api/chapters.json?day={day}"'
                       ' type="application/json+chapters"/>')
        out.append("</item>")

    out += ["</channel>", "</rss>"]
    return "\n".join(out) + "\n"
