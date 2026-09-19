# 譚仔新聞 · 粵語新聞台

A Cantonese reading room for the sesame newsfeed monitor: browse every topic,
channel and digest it publishes, and have any of it read aloud.

![reader](docs/screenshot.png)

## Run

```sh
./run.sh                      # first run creates .venv and installs edge-tts
```

Host, port and — above all — the upstream address live in `config.json`:

```json
{
  "base_url": "http://sesame.tailb2a681.ts.net:8081",
  "host": "127.0.0.1",
  "port": 8082
}
```

`base_url` is the only place any upstream address appears. Change it there and
every route follows. Each key can be overridden without editing the file:

| | |
|---|---|
| CLI | `./run.sh --base-url http://elsewhere:8081 --port 9000` |
| Environment | `TAMCHAI_BASE_URL=http://elsewhere:8081 ./run.sh` |

Precedence is CLI → environment → `config.json` → built-in defaults.

Then open <http://localhost:8082/>. On a phone, "add to home screen" installs it
as a PWA. To reach it from elsewhere on the tailnet, or from the public internet,
put `tailscale serve` or `tailscale funnel` in front of it:

```sh
tailscale serve  --bg --https=443 http://127.0.0.1:8082   # tailnet only
tailscale funnel --bg 8082                                # public internet
```

Funnel publishes the page to anyone with the URL, and `/api/tts` along with it
— so before funnelling anything, read **Who may synthesise** below and set a
token. The page itself is unauthenticated either way; what the token protects is
the synthesiser behind it.

## Docker

```sh
docker compose up -d          # http://127.0.0.1:8082/
```

The image carries `server.py`, `render.py`, `web/` and `edge-tts`, and nothing else — no
tests, no docs, no virtualenv. It runs as a non-root user and answers a
healthcheck on `/api/health`.

Point it at a different upstream without rebuilding:

```yaml
environment:
  TAMCHAI_BASE_URL: "http://elsewhere:8081"
```

`config.json` binds to loopback, which is right on a laptop and useless in a
container — so the image sets `TAMCHAI_HOST=0.0.0.0` and compose publishes the
port back onto `127.0.0.1` only. Put `tailscale serve`/`funnel` in front of
that rather than opening the port to the LAN.

The day archive and the rendered episodes live in the `tamchai-data` volume and
survive the container being replaced; they are the only state the app has. Text
is kept for ever, audio for `podcast_keep_days`.

`server.py` and `web/` are baked into the image, so **editing them needs a
rebuild** — `docker compose up -d --build`. A plain `restart` keeps serving the
old files, which looks exactly like a change that did not work.

Memory is capped at 256 MB. The app sits at ~36 MiB idle and ~56 MiB after
heavy browsing; the audio cache is bounded at 64 MB and the feed cache at 128
entries, so the limit turns a runaway into a restart rather than host pressure.

**A tailnet upstream works from inside the container** — Docker Desktop resolves
MagicDNS names and routes to the tailnet through the host, so
`sesame.tailb2a681.ts.net:8081` is reachable with no extra networking.

To keep it running without Docker:

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

### How far back

Upstream answers for one day unless told otherwise. The rail's **日期** section
sets that for every view at once, and it lives in the URL like the other
filters, so `#/digests?last=5d` is a link:

| Control | |
|---|---|
| **範圍** — 今日 / 3 天 / 5 天 | `last=3d`, in one upstream request |
| **指定日期** | `date=2026-09-16`, one named day |

A chosen date wins over the range upstream-side, so the app sends only the date
and greys the range out rather than letting it be silently ignored.

`last` widens the digest stream — the same query goes from 35 to 115 digests
across 1, 3 and 5 days, paginated as usual — but upstream returns the same
scheduled reports whichever range is asked for. `date` narrows both.

每日總覽 is the one view with its own history: the archive holds days upstream
has dropped, so the range filters that list rather than just fetching more.

### Views

| | |
|---|---|
| **摘要** | The digest stream, grouped topic → channel → summary, with each cited article behind a fold. Filter by topic or channel from the rail; paginate through the archive. A filtered view also lists the scheduled reports that match — some topics (Transcript) have no digests at all and live entirely there. |
| **每日總覽** | The Daily Summary reader: pick a day, pick how much of it to read, follow along sentence by sentence, chain into the next day. |
| **定時報告** | Scheduled prompt outputs (the finance digest and friends), rendered from Markdown. |
| **訊源狀態** | Every feed's health, last fetch and last error. |

Anything with text carries a **朗讀** button — highlights, a topic's channels, one
channel's summary, a whole task report — and hands it to the same player.

The sentence being read is lit up wherever it is on the page, and clicking any
sentence jumps there. The prose is already rendered by then, with its citation
links and bold, so rather than re-rendering it from the segments the page walks
the text nodes and splits them at the sentence boundaries; a sentence that
straddles a link becomes several spans sharing an index. A topic clip is the
one exception — it is several channel blocks read end to end, so no single block
on the page corresponds to it.

Citations are dropped in the speech layer rather than before segmentation, which
is what keeps the printed sentence and the spoken one two views of the same
string: `[12]` stays a link on screen and is never read aloud.

### 讀幾多 · How much of a day to read

A full daily summary is twelve to sixteen minutes, and most mornings that is
more than the time there is. The reader offers three lengths of the same day,
each priced at your current speed:

| | | |
|---|---|---|
| **快讀** | ~1:30 | The 標題 and the 【本報訊】 lead — everything above the first sub-heading |
| **提要** | ~3:00 | That, plus every heading and the first sentence under it |
| **全文** | ~13:00 | The whole thing, as it always was |

Those are estimates, and they now land within about 3% of the audio the podcast
renderer produces — because the renderer is what corrected them. The reader had
been assuming 4.5 characters a second since the beginning; two rendered days put
it at **3.75 spoken characters a second**, so every duration the app showed was a
tenth to a fifth short of the truth.

The lead is not a truncation: upstream writes it as a summary of the whole day,
so 快讀 is the two-minute version of the digest that already existed and was
never offered separately. Nothing is generated or shortened here — the cut only
chooses which of the day's own sentences to read.

**略過市場情緒展望** drops the closing outlook section, which costs another one
to three minutes. Its shape repeats daily — four markets, each with 方向 /
驅動因素 / 風險 / 信心水平 — while its numbers do change, so it is offered and
priced rather than removed.

Every skipped run leaves a line saying how many sentences went with it, and
opens on a tap: a shortened read that hides its own edges is one you cannot
trust to have told you everything. The default is 全文, and the shorter reads
are mentioned once, in a banner, rather than applied to your morning unasked.

A position is an index into a particular queue, and one day now has three of
different lengths under one id — so a stopping point recorded against one length
is dropped rather than translated when you resume at another.

### 出街 · The podcast feed

Every archived day is rendered once, overnight, into a single MP3 — so anything
that can subscribe to a podcast becomes a client, and CarPlay comes free:

```
http://<this box>/api/podcast.xml              # 全文, with chapters
http://<this box>/api/podcast.xml?cut=quick    # 快讀 — just the lead
http://<this box>/api/podcast.xml?skip=outlook # without 市場情緒展望
```

The rail's **🎧 複製 podcast 網址** copies the address at whatever length you are
currently reading — a podcast client wants a URL typed into it, and following
the link in a browser only ever shows you XML.

**How a day becomes a file.** edge-tts returns constant-bitrate 48 kbps, 24 kHz
mono MP3 in 144-byte frames with no header on either end, so joining clips is
joining byte strings and **duration is bytes ÷ 6000 exactly**. The renderer
synthesises a *block* at a time — a whole paragraph in one request, which keeps
the prosody sentence-by-sentence synthesis throws away — and records each
block's byte offset. Everything else falls out of those offsets:

| | |
|---|---|
| **Chapters** | one per heading, at its own timestamp, as a Podcasting 2.0 `chapters.json` |
| **快讀** | the lead is the first blocks, so the cut is a byte *prefix* — no second render |
| **略過市場情緒展望** | drops a run of blocks out of the middle, still on frame boundaries |
| **`Range`** | served, so a client can resume a half-finished download |

Apple Podcasts reads chapters from ID3 frames rather than the JSON file, so
chapter marks show up in Pocket Casts and not in Apple's client yet.

**提要 has no feed.** It takes the first *sentence* of a paragraph, and a
block-level render has nothing to slice there. The app says so rather than
quietly handing over a different length.

**What it costs.** About twenty requests per day rendered, a few seconds apart;
one day is roughly 100 seconds of synthesis and 4–6 MB. Audio is swept past
`podcast_keep_days` (30), while the text archive is kept for ever — a day of
audio is a thousand times the size of the day, and an episode nobody downloaded
in a month can always be rendered again from the text. Set `podcast_voice` to
`""` to switch the whole pass off; already-rendered days keep serving.

The feed hands out absolute URLs, which a podcast client resolves from wherever
it is rather than from this box, so it names the host from the `Host` header —
right behind `tailscale serve`, and overridable with `public_url` for anything
that rewrites it. Like the page itself, the feed and the episodes are
unauthenticated: they are already-rendered bytes, so no request to them reaches
Microsoft or spends the budget.

### What you have already heard

Playback position is kept in the browser's **IndexedDB**, per item, so the page
knows what you have been through:

Each block carries a marker pinned to its top-right corner:

| Marker | |
|---|---|
| **○** hollow ring | not started |
| **45%** amber | part-heard — the furthest point you reached |
| **✓** green | finished (past 95%, or marked by hand) |

The marker is always there, so there is one place to look and one place to
click: pressing it marks the block heard without listening, or puts a finished
one back to unheard. A heard block also mutes its text, without hiding it.

### Playing on

With **播完自動播下一則** on, finishing a clip rolls straight into the next one
down the page that you have not heard, and keeps going until the page runs out.

The run crosses topics and digests and keeps going to the end of the page.
Part-heard clips are still fair game; only finished ones are skipped. 每日總覽
chains days the same way, skipping days already heard.

A topic's clip is its channels read end to end, so it is never a destination —
landing on it would repeat what its channels just said. It stays a button you
can press deliberately, and pressing it marks those channels heard; equally, a
topic counts as heard once all of its channels are. Without that bookkeeping
the two disagree and the run says the same thing twice. The rail carries a running **已聽 n/m** for
what is on screen, a **只顯示未聽** filter that folds away channels you are done
with, and **清除收聽紀錄** to wipe the lot.

Progress only ever moves forward — scrubbing backwards mid-item keeps the
furthest point, and replaying something finished does not un-finish it. A
scheduled task's ID carries its `finished_at`, so tomorrow's run of the same
prompt is a new item rather than one you have already heard.

### Resuming

Playback is checkpointed to IndexedDB once per sentence, and again whenever the
page is about to lose you — pausing, stopping, hiding the tab, or navigating
away (`pagehide`, which is the one mobile Safari reliably fires). Reopen the
page and the player bar comes back where you left it: 「⏸ 上次聽到第 4/8 句 — 撳
▶ 繼續」. It never resumes into sound on its own — browsers block that, and it
would be rude anyway.

The daily reader resumes too: reopening 每日總覽 lands on the day you were part
way through, at the sentence you stopped on. A checkpoint is only written once
you have actually driven the player — opening a view parks it at the first
sentence on its own, and saving that would erase the position you left.

The checkpoint stores the **spoken text**, not just a key, so resuming needs
nothing from the network: the digest may have moved to another page of
upstream's archive by then, and a scheduled task may have re-run and replaced
its output. A checkpoint older than seven days, or one that had already reached
the end, is not offered.

History lives only in that browser, on that device — it is never sent to the
server. If the browser refuses to store it (a private window, blocked site data)
the page says so in the rail and keeps the history for the session only.

The view, filter and page live in the URL hash, so `#/digests?topic=AI&page=2` is a
link you can send someone, and the back button behaves.

### Who may synthesise

`/api/tts` is a **proxy, not a synthesiser**. `edge-tts` reaches Edge's Read
Aloud websocket at `speech.platform.bing.com`, carrying a hardcoded trusted
client token and a `Sec-MS-GEC` header computed from clock skew — an endpoint
reverse-engineered from the browser, with no account behind it. There is no bill
to run up. What an open endpoint spends is **this box's standing** with a
service that has nobody to appeal to: somebody else's abuse, and 朗讀 simply
stops working one morning.

Two controls, and they answer different questions:

| | |
|---|---|
| **`tts_token`** | *May you synthesise at all.* Empty means no check — right for a loopback bind, wrong the moment `funnel` is involved. The browser keeps it in `localStorage`; `/api/config` reports only *whether* one is wanted, never what it is, so loading the page is not the same as being allowed to use it. |
| **`tts_chars_per_hour`** | *How much.* A per-caller budget in characters, because characters are what the far end meters. Defaults to 60,000/hour against a 20,000 burst — about 3.7× continuous listening, which is generous for a person and bounded for a stranger. |

Both are skipped for loopback and the tailnet (`100.64.0.0/10`,
`fd7a:115c:a1e0::/48`), so nothing changes on the laptop or over `tailscale
serve`.

**A cache hit is never charged.** The budget meters what leaves this box, and a
hit sends nothing — which also means a stranger feeding it fresh text, every
piece of which is a miss by construction, pays for all of it.

Two separate questions, and conflating them is how this went wrong once
already. *May this caller skip the controls* is loopback and the tailnet. *May I
believe this peer's `X-Forwarded-For`* is a question about the hop — loopback and
the Docker bridge ranges, because `serve`, `funnel` and Docker all replace the
socket address with a local one and set the header instead. Taken from anywhere
else the header is the caller's own writing, and believing it would let a
stranger claim the tailnet.

Everything on that second list has to be unreachable from outside the host.
Compose publishes to `127.0.0.1` only, which is what makes the bridge ranges safe
to list — **a container opened to the LAN would let a neighbour forge the
header**, which is one more reason not to.

In the container with nothing in front of it, there is no header and every
caller is the bridge gateway, so they share one budget and none of them are
exempt. Putting `tailscale serve` in front is what restores per-caller
accounting, because it supplies the header.

A token in a query string is a token in a server log, and `<audio src>` can
carry nothing else. It is a gate on the synthesiser, not a secret worth much:
the real bound on a public URL is the budget, which needs no secret at all.

#### Azure

With `azure_key` and `azure_region` set, `/api/speech-token` mints a ten-minute
Azure token and the browser talks to Azure **directly**. `zh-HK-HiuGaai`,
`HiuMaan` and `WanLung` are Azure's own voices — the same ones `edge-tts`
reaches through the undocumented door. The difference is an account: a
documented quota, a key that can be rotated, and abuse that spends the token's
allowance instead of this box's reputation.

The key never leaves the server.

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

That last sentence was aspirational until `chooseVoiceId` enforced it. The
ranking admits zh-TW and plain zh so that *something* reads when nothing better
exists — and merely being in the list used to win, so a device with only
Mandarin voices read Cantonese aloud in Mandarin rather than spending a round
trip on the server's zh-HK voice. A browser voice now wins only when it is
genuinely Cantonese; anything less is a last resort taken when there is no
server voice at all.

### 讀音

The built-in table handles what measurably helps every zh-HK voice. Everything
else — tickers, English company names, 人名 — goes in the rail's 讀音 box, one
`寫法=讀法` per line, `#` for a note:

```
NVDA=輝達
恒指=恆生指數
```

Not regular expressions, deliberately: these are typed by someone who wants a
ticker read properly, not a pattern language to get wrong, and a stray `(`
should not be able to silence the whole lexicon. Reader rules run *before* the
built-in table, so a correction beats a guess. The rules live in this browser.

### 兩把聲

Quoted material is read in the second server voice. `tagQuotes` carries the
quote depth across the sentence split — 。 falls inside a quotation as happily
as outside it, so the second half of a quote has no 「 of its own and would
otherwise lose the thread. A browser voice, which cannot switch, reads
everything in one and nothing breaks.

If the browser has no Cantonese voice at all, the server voice is picked instead, and the
banner explains where to install one on that platform.

### Controls

`空白鍵` play/pause · `←` `→` previous/next sentence · `Esc` stop · click any sentence
to jump there · click the progress bar to scrub · **播完自動播下一則** chains
through everything unheard.

## API

| Route | |
|---|---|
| `GET /api/feed` | the upstream payload — digests, topics, channels, feeds, tasks — plus a `_meta` block. Forwards `topics`, `channel`, `page` and `date`; anything else is dropped |
| `GET /api/daily` | `{days: [{day, headline, text, chars, est_seconds, …}], cached, upstream_error, tts_voices}` |
| `GET /api/tts` | `?text=&voice=&rate=±N%` → `audio/mpeg`. `401` without the token, `429` with `Retry-After` once the budget is spent |
| `GET /api/speech-token` | a 10-minute Azure Speech token, so the browser can talk to Azure itself. `503` unless `azure_key` and `azure_region` are set |
| `GET /api/config` | `{base_url, feed_ttl, chars_per_second, tts, tts_voices, tts_token_required, tts_trusted, azure, archive, podcast}` |
| `GET /api/archive.tar.gz` | every archived day, gzipped. The archive is the one thing upstream does not also have |
| `GET /api/podcast.xml` | the feed: one episode per rendered day. `?cut=quick` for the lead only, `?skip=outlook` to leave off 市場情緒展望 |
| `GET /api/episode.mp3` | `?day=YYYY-MM-DD[&cut=quick][&skip=outlook]` → the day's audio, honouring `Range` |
| `GET /api/chapters.json` | Podcasting 2.0 chapters for a day, one per heading |
| `GET /api/episodes` | what has been rendered: `{episodes: [{day, headline, seconds, bytes, rendered_at}], voice, keep_days}` |
| `GET /api/health` | `{ok, tts}` |

`?refresh=1` bypasses the cache on `/api/feed` and `/api/daily`. Each distinct
query is cached separately, so browsing by topic never hammers the single-threaded
upstream — as an LRU of 128 entries, because the cache key comes from parameters
the caller chooses and `?page=1`, `?page=2`, `?page=99999` are three of them.

### Freshness

Two different clocks, and it is worth keeping them apart:

| | |
|---|---|
| **This server's cache** | 10 minutes (`feed_ttl`). The **↻** button skips it and re-asks upstream now. |
| **Upstream's own check** | its cron, `10 */2 * * *` — every two hours. Nothing here can trigger it: it exposes no such endpoint, and `admin` is false for us. |

So ↻ fetches upstream's *latest*, which is only new if upstream has checked
since. It says which happened — 「上游已更新」 or 「上游未有新內容」 — rather than
flashing a spinner and leaving you guessing.

Because the useful moment is right after upstream's cron runs, the page arms a
timer for `next_check_at` + 45s and refreshes itself then, and also re-checks
when you return to a tab that was left open past that time.

## Layout

```
Dockerfile            the image: python:3.13-slim + edge-tts, non-root
docker-compose.yml    the stack: loopback port, archive volume, base_url
config.json           base_url, the tts token and budget, and the rest of the knobs
server.py             sidecar: upstream proxy + per-query cache + archive + on-demand TTS
render.py             the nightly pass: one archived day -> one MP3 + its manifest
web/feed.js           upstream JSON → view models, routing (pure, unit-tested)
web/listened.js       listened-to state: IndexedDB + the pure state arithmetic
web/speech.js         Markdown → speakable segments (pure, unit-tested)
web/cut.js            one day at three lengths: 快讀 / 提要 / 全文 (pure, unit-tested)
web/player.js         playback queue + the two voice back-ends
web/app.js            UI wiring: router, four views, speak buttons
web/icon.svg          the app mark — a 譚仔 bowl broadcasting
tools/make_icons.py   redraws icon.svg into favicon.ico and the PNG sizes
tools/score_ideas.py  scores the ideas and regenerates docs/PRIORITY.md
tests/                node --test (web/) + unittest (server.py, render.py)  ·  npm test
docs/ARCHITECTURE.md  the design and the constraints behind it
docs/IDEAS.md         everything on the table, from the obvious to the daft
docs/PRIORITY.md      all of it scored for value and effort, and ranked
docs/ROADMAP.md       what is actually being built next, in order
```

### Icon

`web/icon.svg` is the master. The rasterised sizes browsers and iOS insist on
(`favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`) are
generated from the same geometry:

```sh
python3 tools/make_icons.py      # needs pillow
```

The `.ico` gets a single-wave variant of the mark — at 16px the second arc
closes up into a blob.

## Test

```sh
npm test
```
