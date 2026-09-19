# tamchainews — Cantonese daily-news reader

A web app that fetches the "Daily Summary" digests from the sesame news feed and
reads them aloud in Cantonese.

## 1. Findings from the live feed

Endpoint: `http://sesame.tailb2a681.ts.net:8081/?topics=Daily+Summary&output=json`

| Observation | Value | Consequence |
|---|---|---|
| Response | 200, `application/json`, ~40 KB | one request gets everything |
| Payload shape | `daily[]` = `{day, due_at, started_at, finished_at, status, text, error, language, channels}` | `text` is the digest |
| `text` format | Markdown, `# H1` headline + `## H2` sections + `**bold**` + `*` bullets | needs md→speakable-text conversion |
| `language` | `Traditional Chinese (Hong Kong)` | matches zh-HK TTS |
| Retention | 3 days (`2026-09-14/15/16`); `page.pages = 1`; `size`/`page` params ignored for `daily` | no pagination needed; archive locally if history wanted |
| Size | 2 968 / 3 012 / 3 780 chars → **~11–14 min of speech per day**, 64–85 sentences | must chunk; can't be one utterance |
| **CORS** | **no `Access-Control-Allow-Origin` header** | a page on any *other* origin cannot `fetch()` it |
| Scheme/host | plain `http://` on a `*.ts.net` tailnet name | HTTPS page → mixed-content block; unreachable off-tailnet |
| Server | Python `BaseHTTP/0.6`, `Cache-Control: no-store`, HTTP/1.0 | single-threaded; don't hammer it |
| Refresh cadence | `check_schedule: 10 */3 * * *` (every 3 h) | poll at most every ~15 min |

### The two hard constraints
1. **No CORS + plain HTTP + tailnet-only** ⇒ the UI must be served from the *same origin* as the
   feed (or from something with host permissions, i.e. a browser extension). A static page on
   GitHub Pages / Vercel cannot work.
2. **Cantonese voice availability** is the real risk, not the code:

| Platform | zh-HK voice via Web Speech API |
|---|---|
| iOS / macOS Safari | ✅ `Sinji` (zh-HK) — good |
| Android Chrome | ✅ Google 粵語 (zh-HK) — good |
| Edge on Windows | ✅ `HiuGaai` / `HiuMaan` Neural (zh-HK) — best |
| **Chrome on this Linux box** | ✅ `Google 粤語（香港）` — Chrome ships its own network voices, independent of the system |
| **Firefox on this Linux box** | ❌ it uses speech-dispatcher, which here exposes only espeak-ng: `cmn` (Mandarin), **no `yue`** |

Corrected after testing the real page: the system check (`spd-say -L`) showed no Cantonese, but
Chrome does not go through speech-dispatcher for its own voices, so the browser path works on this
desktop too. Firefox on Linux is the case that still needs the server voice — as does any device
whose only Chinese voice is Mandarin.

Note that Chrome's voice name uses the **simplified** 粤, not 粵; matching only the traditional
form silently misgrades it.

## 2. Architecture

```
   sesame box                      this machine (100.69.22.4)
  ┌──────────────┐  tailnet     ┌──────────────────────────────────┐
  │ :8081 feed   │◀────────────▶│ :8082 tamchainews sidecar        │
  │  (JSON)      │ server-side  │   ├── GET /          → SPA       │
  └──────────────┘ fetch, no    │   ├── GET /api/daily → cached    │
                   CORS issue   │   └── GET /api/tts   → edge-tts  │
                                └──────────────────────────────────┘
                    │ http over tailnet
                    ▼
         Browser (phone / laptop / desktop)
         ├── day list + reader UI
         ├── md → speech segments
         └── SpeechSynthesis  ──or──  <audio> from /api/tts
```

Same-origin sidecar kills CORS, mixed content and tailnet reachability in one move, and adds a
cache in front of a single-threaded upstream. It stays lightweight: one Python-3 file
(`ThreadingHTTPServer`, stdlib only apart from `edge-tts`). **Decided: it runs on this machine**,
not on the sesame box — so the reader is available to any tailnet device while this box is up.

### Components

**`server.py`** (~150 lines, stdlib only)
- `GET /api/daily` → fetch upstream, keep `status == "ok"` entries, return
  `[{day, headline, text, generated_at, chars, est_seconds}]`. In-memory TTL cache (10 min) +
  stale-on-error fallback. Optional `data/archive/YYYY-MM-DD.json` write-through so days survive
  past the 3-day upstream retention.
- Static file serving for the SPA.
- `--port`, `--upstream`, `--archive` flags; runs under `systemd --user`.

**`speech.js`** — markdown → speech segments (pure, unit-testable)
- Parse the tiny md subset: `#`/`##` headings, `**bold**`, `*` bullets, `：` label lines.
- Strip markers, keep structure: each heading and each sentence becomes a segment; split on
  `。！？；` and newlines, hard-cap ~120 chars.
- Per-segment `pauseAfter` (longer after a heading/section) since SSML isn't available.
- Pronunciation dictionary (small, data-driven): `Fed → 聯儲局`, `%` → `百分之…`, `0.7 → 零點七`,
  `FOMC`, `AI`, `$1.2萬億` etc. Latin/digits are where zh-HK TTS sounds worst.
- Output: `[{id, kind: heading|para|bullet, text, speak, charStart, charEnd}]` — `charStart/End`
  anchor the on-screen highlight.

**`render.py`** — one archived day → one MP3 (pure enough to unit-test; the synth is injected)
- `blocks_of(markdown)` → heading/paragraph/bullet blocks, `speak` normalised. No sentence
  split: a paragraph goes to the voice whole, which keeps prosody and cuts requests 5×.
- `Renderer.render(day)` synthesises block by block, concatenates, and writes
  `audio/<day>.mp3` + `<day>.json` — the manifest carrying each block's byte offset.
- edge-tts returns CBR 48 kbps / 24 kHz mono in 144-byte frames with no ID3 on either end,
  so **duration = bytes ÷ 6000** and joining clips is joining bytes. Chapters, the 快讀
  prefix and the outlook skip are all slices of those offsets; nothing is re-synthesised.
- `podcast_xml()` builds the feed; each item advertises the length of *its* cut.
- The pronunciation rules and the cut shape are mirrored from `speech.js`/`cut.js`, pinned
  from both sides by the same table of cases in `tests/`.

**`cut.js`** — one day at three lengths (pure, unit-testable)
- `planCut(blocks, {cut, skipOutlook})` → the pieces to render, the queue to play, and a
  count of what was left out. `快讀` is the 標題 and the 【本報訊】 lead — everything above the
  first sub-heading; `提要` adds every heading and the first sentence under it; `全文` is
  everything.
- Cuts the digest's own structure rather than comparing days: upstream regenerates the daily
  summary each morning, so there is no diff to take (`ROADMAP.md`, Day 2).
- The outlook tail is found by the heading's whole title, not by the phrase 「市場情緒」
  inside it, and fails closed — an unrecognised variant means the toggle is absent, never
  that a news section is skipped.

**`azure.js`** — Azure Speech spoken to by the browser (pure, unit-testable)
- `ssmlFor(text, {voice, rate})` escapes the prose into an SSML envelope; `ratePercent`
  turns 1.25 into `+25%`. An unescaped `&` is a 400 from Azure, which reads on a page
  reading itself aloud as one sentence in a hundred silently failing.
- `AzureAccess` answers *where to send* and *what to send with it* in two modes: `server`
  (ask `/api/speech-token` for a ten-minute token, renewed a minute early) or `key` (this
  browser holds the subscription key and sends it directly — a token would protect nothing
  once the browser is the thing holding the key).
- The REST endpoint answers a cross-origin `POST`, verified against the live service, so no
  Speech SDK is needed. Failures are told apart by hand because a browser reports a CORS
  refusal as an opaque `TypeError`.

**`player.js`** — playback engine behind one interface
`play(fromSegment) / pause() / resume() / stop() / next() / prev() / seekTo(i)`, emitting
`onSegmentStart / onEnd / onError`. Two swappable back-ends:
- `AzureTtsBackend` — fetches the bytes and plays them from a blob URL, because an
  `<audio src>` can carry no `Authorization` header. Bounded cache of object URLs, revoked
  on dispose; still plays through the shared clip pair, since iOS grants playback per
  element whoever made the audio.
- `WebSpeechBackend` — one `SpeechSynthesisUtterance` per segment, queue of 2 kept warm
  (Chrome truncates long utterances and drops the queue on pause; per-segment avoids both).
  Voice selection: `zh-HK` → `yue` → `zh-TW` → `zh-*`, ranked, user-overridable. Within a
  tier, `localService: true` wins, so Safari's on-device Sinji beats Chrome's cloud
  `Google 粤語（香港）` — a capability check, not platform sniffing. Platform detection is
  used for one thing only: telling the user where to install a voice when none exists.
- `AudioBackend` *(tier 3)* — `<audio src="/api/tts?day=…&seg=…">`, prefetch next segment.

**`app.js` / UI**

```
┌─ 譚仔新聞 ───────────────────────────  [voice ▾] [速度 1.0x] [⚙] ┐
│ ┌── days ──┐ ┌──────────── reader ───────────────────────────┐ │
│ │▸ 9月16日 │ │ # 聯儲局三年來首次加息 特首發表首份五年規劃      │ │
│ │  11 分鐘  │ │                                               │ │
│ │  9月15日 │ │ 【本報訊】美國聯邦儲備局…  ← current sentence  │ │
│ │  9月14日 │ │      highlighted, auto-scrolled               │ │
│ └──────────┘ └───────────────────────────────────────────────┘ │
│ ⏮  ⏯  ⏭   ▓▓▓▓▓░░░░░░░  段 12/64 · 2:15 / 11:03   ☑ 連續播放  │
└────────────────────────────────────────────────────────────────┘
```
- Click a day to read it; **連續播放** chains newest → oldest automatically.
- Click any sentence to jump there; space = play/pause, ←/→ = prev/next sentence.
- Voice picker lists detected voices with a warning banner when no Cantonese voice exists.
- `localStorage`: voice, rate, autoplay, last position per day (resume where you left off).
- Mobile: `wakeLock` during playback; large tap targets; installable as a PWA.

### Server TTS fallback (decided: enabled)
`edge-tts` (tiny Python lib, free, no key) streams `zh-HK-HiuGaaiNeural` / `zh-HK-WanLungNeural`
MP3 **on demand per segment** — nothing is pre-converted, audio is generated as you press play and
kept in a small LRU. This is what makes it work on this Linux desktop, and it also unlocks
MediaSession lock-screen controls and background playback on mobile, which `speechSynthesis`
cannot do. Cost: one dependency + outbound internet.

The client uses Web Speech when a Cantonese voice is present and falls back to `/api/tts`
otherwise; the user can force either from the voice picker.

## 3. Tech stack
- **Server**: Python 3 stdlib, single file, no build step, no framework.
- **Client**: vanilla ES modules, no bundler, no npm install. The markdown subset is small enough
  to render with ~40 lines rather than pulling in a library.
- **Tests**: `node --test` over `speech.js` (segmentation + dictionary) and `player.js` (queue,
  pause/resume, seek, failure handling) — the logic with real edge cases. Voice availability is
  reported in the app itself, by the picker and its banner.

## 4. Build order — all shipped
1. ✅ `server.py` + `/api/daily` with cache, normalisation and archiving.
2. ✅ `speech.js` segmentation + tests.
3. ✅ Static UI: day list, reader, sentence highlight.
4. ✅ `WebSpeechBackend`, player controls, keyboard shortcuts, autoplay chaining.
5. ✅ Persistence, voice picker, PWA manifest, wake lock.
6. ✅ `/api/tts` + `ServerTtsBackend` + MediaSession.
7. ✅ `run.sh`, `systemd --user` unit, README.

## 5. Open risks
- Upstream keeps only 3 days → enable the archive writer early if history matters.
- Upstream is single-threaded; the 10-min cache is what protects it.
- Sidecar runs on this desktop, so the phone can only reach it while this machine is up.
- Web Speech voice names/availability vary per device — never hard-code a voice name.
- iOS requires a user gesture to start speech and halts it when Safari is backgrounded; the
  server voice avoids this, since it plays through a real `<audio>` element.
- `/api/tts` takes ~2 s per cold segment and <1 ms once cached, so the one-segment-ahead prefetch
  is what keeps playback gapless.
