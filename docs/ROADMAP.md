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
| ~~**2**~~ | ~~今日有咩唔同~~ → 讀幾多 · Three lengths | **Done.** The delta read died on real data; the digest's own lead turns twelve minutes into one. |
| ~~**3**~~ | ~~出街 · Get it off the laptop~~ | **Done.** The podcast feed, and Azure client-direct with the key held wherever you want it. stream.mp3 slips to Day 4. |
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

## Day 2 · 讀幾多 — ✅ done

**Three lengths of the same day.** — S · *arrived at from the other side*

The day was scheduled as **今日有咩唔同**, the delta read: diff today's summary
against yesterday's and read only what moved. That turned out to rest on an
assumption the archive disproves, and the warning written into this page is what
caught it — *the test suite needs a fixture from two real consecutive archive
days, not a synthetic one.* Given real days, it does not survive.

**Upstream regenerates the daily summary every morning; it does not edit it.**
Two consecutive days share almost no wording even where they cover the same
story, so there is nothing to subtract. Measured over four archived days, three
ways:

| method | result |
|---|---|
| sentence similarity, the v1 written above | 65 of 74 sentences come back `new` |
| IDF-weighted block matching | cuts **2–4%** of the runtime |
| rare-term novelty against yesterday's whole text | cuts **0–2%** |

What little does match is the 市場情緒展望 scaffolding — 「信心水平：中」 and the
like — because the short repeated lines are the only repeated lines. A paragraph
retelling yesterday's Fed decision in fresh words scores **0.20**, *below* a
genuinely new paragraph at 0.51. There is no threshold in there because there is
no signal to threshold, and shipping one would have been a 🆕 badge that lit up
at random. The idea is struck from `IDEAS.md`; the version that would work wants
story clustering or a model, which is 時間線, already parked.

The same measurements found the two minutes somewhere else. **The digest already
contains its own short version, written by upstream, every day:**

| | 09-14 | 09-15 | 09-16 | 09-17 | 09-18 |
|---|---|---|---|---|---|
| 全文 | 15:09 | 12:42 | 14:05 | 12:58 | 16:08 |
| 提要 | 2:54 | 3:19 | 3:22 | 2:45 | 3:00 |
| 快讀 | **1:33** | **1:30** | **1:14** | **1:29** | **1:43** |

*(These are the corrected figures. As first written they were a fifth shorter:
Day 3 rendered two of these days as audio and measured the reader's
characters-per-second assumption to be wrong, which moved every number on this
page. 09-17 and 09-18 are now measured rather than estimated.)*

So the twelve minutes become one by structure rather than by comparison — which
also works on a day with no yesterday, and has nothing in it to drift.

Shipped, in `web/cut.js`:

- **快讀** — the 標題 and the 【本報訊】 lead, which is upstream's own summary of
  the whole day. Everything above the first sub-heading; a digest with no
  sub-headings has no lead to separate, and reads in full rather than empty.
- **提要** — that, plus every heading and the first sentence under each.
- **全文** — the read the app always had.
- **略過市場情緒展望**, priced at 1:33–2:43. Its *shape* repeats daily — four
  markets, each with 方向 / 驅動因素 / 風險 / 信心水平 — but its numbers do change,
  so it is offered and costed rather than taken away.
- Every skipped run says how many sentences it was and opens on a tap. A
  shortened read that hides its own edges is one you cannot trust to have told
  you everything.

**The bit that only running it found:** matching the outlook heading on 「市場情緒」
skipped the wrong section entirely on the very first live day. 2026-09-18 leads
with 「全球宏觀經濟：聯儲局與日銀同步緊縮，**市場情緒**兩極」 — the words are there,
describing the news rather than naming a section of outlook, and fifteen
sentences of actual news went quietly missing. It now matches the heading's whole
title, and fails closed: an unrecognised variant costs two minutes of listening,
where the other way round loses the news.

**Also:** a position is an index into a particular queue, and one day now has
three of different lengths under one id. `resumePoint` takes the queue length and
drops a position recorded against another — sentence 40 of the full read is not a
shorter way of saying sentence 40 of the 快讀, it is off the end of it.

**What it is not.** The default is still 全文: nobody's morning gets quietly cut
to a minute, so the feature is invisible until the banner mentions it once.
Finishing 快讀 marks the day heard — you chose that length, and the day card
saying otherwise would be arguing with you.

---

## Day 3 · 出街

**1. `/api/podcast.xml`** — ✅ done

One episode per archived day, rendered ahead of time by a pass in the container,
so anything that subscribes to a podcast is now a client.

**The measurement the whole design rests on.** edge-tts returns constant-bitrate
48 kbps, 24 kHz mono MP3 in 144-byte frames with no ID3 header on either end —
checked against the stream rather than assumed, and confirmed by `afinfo`
against a file built by joining three clips: 1,597 packets, 38.328s, exactly the
sum of its parts. So concatenation is byte concatenation, and **duration is
bytes ÷ 6000 exactly**. Every offset the renderer records is a byte count that
becomes a timestamp by division, and that is what makes the rest cheap:

| | |
|---|---|
| Chapters | one per heading, at its own timestamp |
| 快讀 | the lead is the first blocks, so the cut is a byte *prefix* — no second render |
| 略過市場情緒展望 | a run dropped from the middle, still on frame boundaries |
| `Range` | served, so a client can resume a half-finished download |

Verified against the live 2026-09-18 episode: the feed advertises 5,810,112
bytes and `0:16:08`; the file is 5,810,112 bytes and 968.352s. 快讀 is 103.008s,
and chapter two starts at 103.008s.

**A block at a time, not a sentence.** `speech.js` splits to ~90 characters
because a browser utterance falls over past that; nothing in a file does. A
whole paragraph in one request keeps the prosody that sentence-by-sentence
synthesis throws away, and costs a fifth of the requests. The price is that
提要 — which takes the first *sentence* of a paragraph — has nothing to slice on,
so the feed offers 快讀 and 全文 and the page says so rather than quietly handing
over a different length.

**The duplication, admitted.** The pronunciation rules and the shape of a cut
now exist in `render.py` as well as `web/speech.js` and `web/cut.js`, because
the page is JavaScript and the renderer is Python. Both sides pin the same table
of cases, and it caught a real one on the first run: `\b` is ASCII in JavaScript
and Unicode in Python, so 「本地生產總值GDP」 has a word boundary in one and not
the other — the page would have said "G D P" and the podcast "GDP".

**And it corrected the reader.** The app had assumed 4.5 characters a second
since the beginning. Two rendered days measure **3.75 spoken characters a
second**, so every duration it has ever shown was a tenth to a fifth short —
including the 讀幾多 picker from Day 2, whose entire argument is that its three
numbers are real. Both constants are now measured, the estimate lands within 3%
of rendered audio, and a test pins it to a real recording.

*Still open:* Apple Podcasts reads chapters from ID3 frames rather than the
Podcasting 2.0 JSON, so chapter marks work in Pocket Casts and not in Apple's
client. Writing ID3 CHAP frames is a contained job for another day.

**2. Azure Speech, client-direct** — ✅ done

`/api/speech-token` had been waiting for a browser half since Day 0. It has one:
`AzureTtsBackend` in `player.js`, fed by `AzureAccess` in `web/azure.js`.

**The unknown that had been blocking it is answered, and it did not need a key.**
Whether the REST endpoint answers a browser at all, or wants the Speech SDK, was
written here as not worth guessing at — so it was measured instead. A `POST` to
`https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1` carrying
`Ocp-Apim-Subscription-Key` and `X-Microsoft-OutputFormat` clears its CORS
preflight and returns a response script can read: the live service answered
**401** to a deliberately wrong key rather than refusing the origin. A readable
401 is the whole answer — the preflight passed and the response carried
`Access-Control-Allow-Origin`. **No Speech SDK.**

**Two places to keep the key, because they are different trades.** The box can
hold it (`azure_key` in config.json, `/api/speech-token` mints a ten-minute
token, the key never leaves) or this browser can (the rail's Azure 語音 section,
localStorage, its own quota, nothing configured on the box). In browser mode the
key goes on the request directly: a token exists to avoid exposing the key,
which buys nothing once the browser is the thing holding it.

Said plainly in the README rather than buried: a subscription key is a
**billable** credential, and a page's storage is a weaker place for it than the
box's config — anything that can run script on this origin can read it, and
unlike a token it does not expire.

**Azure never becomes the voice on its own.** It appears in the 語音 picker once
there is a key to use, and choosing it is the whole opt-in — so one install can
read through the browser's voice on one device, this box's edge-tts on another,
and an Azure account on a third.

**測試** synthesises one word and reports exactly what came back, because a
browser hands script an opaque `TypeError` for a blocked cross-origin request
and that is indistinguishable from the network being down. A refused key, a
refused token, a CORS problem and a plain HTTP status are four different
sentences.

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
