# 譚仔新聞 · 粵語日報

Reads the sesame feed's **Daily Summary** digests aloud in Cantonese, in the browser.

![reader](docs/screenshot.png)

## Run

```sh
./run.sh --port 8082          # first run creates .venv and installs edge-tts
```

Then open <http://localhost:8082/> — or, from any other device on the tailnet,
`http://100.69.22.4:8082/`. On a phone, "add to home screen" installs it as a PWA.

To keep it running:

```sh
cp tamchainews.service ~/.config/systemd/user/
systemctl --user enable --now tamchainews
```

## How it works

The upstream feed sends no CORS headers, speaks plain HTTP and lives on a tailnet
name, so no browser page hosted anywhere else can read it. `server.py` fixes that by
serving the UI and the feed from **one origin**, caching the feed for 10 minutes in
front of a single-threaded upstream, and archiving each day under `data/archive/`
(upstream keeps only three days).

The page turns each digest's Markdown into short spoken segments and plays them one
at a time, which gives sentence-level seek, resume-where-you-left-off, and a progress
bar — and sidesteps Chrome's habit of truncating long utterances.

### Voices

Two interchangeable back-ends, chosen automatically and overridable from the picker:

| | |
|---|---|
| **Browser** (`SpeechSynthesis`) | Used when a zh-HK voice exists: Safari's *Sinji*, Chrome's *Google 粤語（香港）*, Edge's *HiuGaai* / *HiuMaan*. The server is not involved at all. |
| **Server** (`/api/tts`) | `edge-tts` synthesises `zh-HK-HiuGaai/HiuMaan/WanLung` **on demand**, one segment at a time, cached in a 64 MB LRU. Nothing is pre-converted. Needs outbound internet. |

Selection goes by `localService`, not by platform: **an on-device Cantonese voice wins
over a cloud one**, so a Mac or iPhone picks Sinji and reads offline, while Chrome — whose
Google voices all report `localService: false` and send the text to Google — is labelled
*雲端* in the picker. Being on-device never outranks actually speaking Cantonese.

If the browser has no Cantonese voice at all, the server voice is picked instead, and the
banner explains where to install one on that platform.

### Controls

`空白鍵` play/pause · `←` `→` previous/next sentence · `Esc` stop · click any sentence
to jump there · click the progress bar to scrub · **連續播放下一日** chains the days.

## API

| Route | |
|---|---|
| `GET /api/daily` | `{days: [{day, headline, text, chars, est_seconds, …}], cached, upstream_error, tts_voices}`; `?refresh=1` bypasses the cache |
| `GET /api/tts` | `?text=&voice=&rate=±N%` → `audio/mpeg` |
| `GET /api/health` | `{ok, tts}` |

## Layout

```
server.py             sidecar: feed proxy + cache + archive + on-demand TTS
web/speech.js         Markdown → speakable segments (pure, unit-tested)
web/player.js         playback queue + the two voice back-ends
web/app.js            UI wiring
tests/                node --test  ·  npm test
docs/ARCHITECTURE.md  the design and the constraints behind it
```

## Test

```sh
npm test
```
