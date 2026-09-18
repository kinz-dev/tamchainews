# 路線圖 · Roadmap

The next few days, in order. Everything here is drawn from `IDEAS.md`; the rest
of that page stays parked until something on this one ships.

Every idea is scored for value and effort in **`PRIORITY.md`**; this page is
what that ranking says to actually do, in order.

The ordering rule: **what changes the experience per hour of work**, with a bias
toward the grain of this codebase — a pure function in `web/` with a test beside
it is cheap, a new route in `server.py` costs a rebuild, and anything that needs
new storage or a second process is a different kind of day.

| Day | Theme | Why it is here |
|---|---|---|
| ~~**0**~~ | ~~鎖門 · Close the door~~ | **Done.** Token, per-caller budget, and the forwarded-address trap that made both meaningful. |
| ~~**1**~~ | ~~好聽啲 · Make it sound better~~ | **Done.** All nine Tier 1 items, plus a voice-selection bug that scoring had pointed at backwards. |
| **2** | 今日有咩唔同 · The delta read | The one feature that turns a re-read into news. |
| **3** | 出街 · Get it off the laptop | A podcast feed reaches the car, the kitchen and everyone who will never install a PWA. |
| **4** | 食晒佢 · Finish what Day 3 starts | The rest of the value-4 items, three of which ride Day 3's render pipeline. |

---

## Day 0 · 鎖門 — ✅ done

**Auth and a rate limit on `/api/tts`.** — S

`tailscale funnel` publishes the page and the synthesiser together, and the
README says plainly that there is no authentication in front of either.

`/api/tts` is a **proxy, not a synthesiser** — `edge-tts` reaches Edge's Read
Aloud websocket at `speech.platform.bing.com`, carrying a hardcoded trusted
client token and a `Sec-MS-GEC` header its `drm.py` computes from clock skew.
It is a reverse-engineered consumer endpoint, not a documented API. So the cost
of leaving it open is not bandwidth: it is that somebody else's abuse gets **this
box's IP** rate-limited or blocked by Microsoft, with nobody to appeal to. 朗讀
would simply stop working one morning.

Shipped:

- `tts_token`, checked with `hmac.compare_digest`, accepted as a header or — because
  `<audio src>` can carry nothing else — as a query key.
- `CharBudget`: a per-caller budget in **characters**, since characters are what
  Microsoft meters. 60,000/hour against a 20,000 burst. A cache hit is never
  charged, so the budget measures exactly what leaves the box.
- Loopback and the tailnet skip both.
- `/api/speech-token`, dormant until `azure_key` and `azure_region` are set.

**The bit that made it real:** `serve` and `funnel` proxy to loopback, so the
socket says 127.0.0.1 for the entire public internet — the first cut exempted
every outside caller as "the owner". `client_ip()` reads `X-Forwarded-For` only
when the peer is itself loopback; from anyone else it is a header the caller
writes, and trusting it would hand a stranger the tailnet's exemption.

**Verified** against a live server: loopback passes untouched; a forwarded
stranger gets 401 without the token, 200 with it, then 429 and a `Retry-After`
once the budget is spent; a second address is unaffected; a repeat of
already-synthesised text is free. 15 unit tests in `tests/test_server.py`.

**What it is not.** The page is still unauthenticated, and a token in a query
string is a token in a server log. Anyone who can load a funnelled page can read
its `localStorage`. The token stops drive-by use of the endpoint; the thing that
actually bounds a public URL is the budget, which needs no secret at all.

---

## Day 1 · 好聽啲 — ✅ done

All nine Tier 1 items, not the four that were scheduled — the value-3 five were
each an afternoon and none of them fought the others.

**1. 用返瀏覽器把聲** — the item was scored on a misreading, and the real defect
was the opposite of the one written down. `player.js` already preferred a
browser voice; what it did *not* check was whether that voice speaks Cantonese.
`rankVoices` admits zh-TW and plain zh so that something reads when nothing
better exists, and merely being in the list won — so a device with only Mandarin
voices read Cantonese aloud in Mandarin, fluently, rather than spending a round
trip on a zh-HK server voice. `chooseVoiceId` now requires score 3.

**2. 讀音表** — `parseLexicon` takes `寫法=讀法`, one per line, deliberately not
regular expressions: a stray `(` should not be able to silence the lot. Reader
rules run before the built-in table, so a correction beats a guess. Latin terms
get word boundaries; 漢字 do not, because `\b` never matches against them and the
rule would silently do nothing.

**3. 訊源死咗要出聲** — `darkFeeds` finds feeds that went quiet *without* going
wrong. `feedHealth` only ever knew about `ok: false`; a feed that last succeeded
two days ago is `ok: true` and invisible, and that is the failure that matters,
because the digests simply stop mentioning it and silence reads as "nothing
happened".

**4. 預熱** — the first two segments of the next unheard clip, fetched when
upstream lands. Two bugs found by running it rather than by reading it: the
first version walked `state.onScreen`, which holds id *strings*, so it was a
silent no-op; the second borrowed `player.backend`, which does not exist until
something has played — precisely the case pre-warming is for. It builds its own
backend now, and does nothing at all on a browser voice, which synthesises
locally.

**5. 兩把聲** — `tagQuotes` carries quote depth *across* the sentence split, so
the second half of a quotation still knows what it is. A piece counts as a quote
when most of it is inside one, not merely when it touches one.

**6. 每個類別記住把聲** — changing the picker while a topic is open sets it for
that topic, which is nearly always what was meant.

**7. 訊源分佈** — a share bar behind each channel in the rail, measured in
characters of summary. On the live feed, Hacker News writes 54% of Technology
and Guardian Technology 4%.

**8. Boredom signal** — three stops in a row on one topic, and the app offers to
skip it in auto-play. Finishing anything clears the streak. It only ever offers.

**9. Archive export** — `/api/archive.tar.gz`, every archived day in one gzipped
tar. The archive is the only thing here upstream does not also have, so being
able to walk away with it matters more than anything built on top of it.

## Day 2 · 今日有咩唔同

**The delta read.** — M · *the one to get right*

Diff today's channel summary against yesterday's on the same topic, and read
only what moved. Today the app re-reads a mostly-unchanged summary and calls it
news; this makes the difference the content.

The archive under `data/archive/` already holds yesterday. The diff is
sentence-level over the segment list `speech.js` produces, which means it is a
pure function with a test beside it — the same shape as `feed.js` and
`listened.js`. **No model needed for v1**; similarity over sentences is enough
to tell a reworded line from a new one.

- `web/delta.js` — `delta(todaySegments, yesterdaySegments) → [{segment, state}]`, `state` ∈ `new | changed | same`.
- A per-block toggle 「只讀新嘢」, and a 🆕 badge on blocks that actually moved.
- Unchanged blocks collapse to a line: 「同尋日一樣」.
- Auto-play in delta mode skips a block whose every sentence is `same`.

**Done when** a day with three genuinely new stories reads back in under two
minutes instead of eleven, and a day with nothing new says so out loud and stops.

**Watch for:** the boundary case where upstream rewrites the whole summary
without changing its meaning. If everything comes back `changed`, the feature is
worthless — so the test suite needs a fixture from two real consecutive archive
days, not a synthetic one.

---

## Day 3 · 出街

**1. `/api/podcast.xml`** — M

One episode per day, built from the archive, so Apple Podcasts becomes a client
and CarPlay comes free. Needs the audio rendered ahead of time rather than on
demand, which is the real work: a nightly pass that synthesises the day's
segments, concatenates them, and writes one MP3 beside the day's JSON.

- The archive volume grows. Cap it — keep 30 days of audio, all days of text.
- Chapter marks per topic, if the concatenation step is tracking offsets anyway.
- The feed is a static file once written; serve it from `_static`.

*Done when* the URL subscribes cleanly in Apple Podcasts and Pocket Casts, and
yesterday's episode is there before breakfast.

**2. Azure Speech, client-direct** — M · *the server half is already in*

`/api/speech-token` exists and mints a ten-minute token; what is left is the
browser half — a third back-end in `player.js` beside `WebSpeechBackend` and
`ServerTtsBackend`, talking to Azure itself. Needs a real key and region to
build against, because whether the REST endpoint answers a browser directly or
wants the Speech SDK is not something worth guessing at.

This is the topology that was asked for and edge-tts cannot express: abuse
spends the token's own quota, not this box's standing. It also makes the Day 0
budget a courtesy rather than a defence.

*Done when* a browser with no Cantonese voice reads aloud without `/api/tts`
being touched at all.

**3. `/api/stream.mp3`** — M · *value 4* · *if the day has room*

The unheard queue, concatenated on the fly. Anything that can open a URL — a
Sonos, a car, a dumb speaker — becomes a client. Shares the concatenation code
with the podcast, which is why it belongs beside it; if it slips, it slips to
the front of Day 4 rather than into the parked list.

---

## Day 4 · 食晒佢

The 譚仔 day is gone — the noodle-shop metaphor was a costume on features that
did not need one, and the whole group is out of `IDEAS.md`. What replaces it is
the rest of Tier 3, chosen because three of the four ride the nightly render
Day 3 has just built.

**1. 早晨 / 夜晚簡報** — M · *value 4*

A four-minute cut at 07:30 and a ten-minute one at 22:00, assembled from what
you have **not** heard rather than from what is newest. Day 3's render pass
already walks the segments and concatenates them; this picks a different set and
stops at a length.

The distinction is the whole point: "newest" is what every feed gives you, and
it re-reads things you sat through yesterday. `listened.js` knows better.

*Done when* 07:30 produces a four-minute file that contains nothing you have
already finished, and says so when there is not four minutes of new material.

**2. 提要之提要 · The weekly** — M · *value 4*

A weekly and a monthly super-digest built from the archive rather than from
upstream — which can only be done here, because upstream keeps three days and
you keep everything.

This is the catch-up after a week away, and it is the second feature after the
delta read to treat the archive as an asset rather than a backup.

*Done when* a Sunday file summarises the week in under ten minutes, drawn from
`data/archive/` with no upstream call at all.

**3. Offline pack** — M · *value 4*

「下載今日」 bakes the day's segments into Cache Storage so the PWA works with no
signal. The MTR is the case, and it is the one place the podcast feed does not
already cover — Apple Podcasts downloads for you, a home-screen PWA does not.

*Done when* aeroplane mode still reads the day, and the rail says how much is
held.

**4. Code-switch detection** — M · *value 4* · *if the day has room*

Route English spans to an English voice mid-sentence instead of letting a zh-HK
voice mangle them. It splits a segment, which the highlighting already handles —
one sentence becoming several spans is the citation case from day one.

Every finance digest is full of tickers and English company names, so this is
the last of the value-4 items and not the least of them.

## Parked

Good, and not this week — each needs storage, a background process, or a model,
and any one of them would eat all four days.

| | |
|---|---|
| 時間線 · story threading | Wants clustering across the whole archive. |
| Semantic search | Wants embeddings and a SQLite index. |
| Ask the digest | Wants a model in the loop and a grounding story for citations. |
| AI 主播對談 | Wants Day 3's audio pipeline finished first. |
| Cross-device resume | Wants accounts, which this app has deliberately never had. |
| Local Piper / Kokoro | Wants a second process and a model file in the image — but it is the only entry here that makes the server path actually local, and the only insurance against Microsoft closing the door. |

### Not doing: a bigger TTS cache

Raised and rejected, so it does not get raised again. The cache key is
`sha1(voice|rate|text)`, so a caller sending fresh text misses **by
construction** — hit rate against abuse is zero at any size, and a bigger LRU
would only churn harder. For real traffic it is already ample: 每日總覽 measures
3,310 chars/day ≈ 4.4 MB of 48 kbps mono, so 64 MB is about fifteen days' worth
and evicts nothing that matters. Meanwhile the container is capped at 256 MB
against a process that reaches ~56 MiB, and Day 1's per-topic voice and rate
multiply the key space rather than shrink it.

The useful version is a **disk-backed** store, not a bigger memory one: a year
of daily summaries is 1.6 GB, it survives the rebuilds that editing `web/`
forces, and it is the same pre-rendered audio Day 3's podcast feed needs. It is
folded into Day 3 rather than standing alone.

## 記住

- `server.py` and `web/` are baked into the image. Editing them needs
  `docker compose up -d --build` — a plain restart keeps serving the old files
  and looks exactly like a change that did not work.
- `npm test` before each commit. The pure modules are pure for a reason; keep
  new logic in `web/*.js` where a test can reach it.
- Memory is capped at 256 MB. Day 3 adds pre-rendered audio — it belongs on
  disk, not in the LRU.
