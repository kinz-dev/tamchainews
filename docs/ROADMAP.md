# 路線圖 · Roadmap

The next few days, in order. Everything here is drawn from `IDEAS.md`; the rest
of that page stays parked until something on this one ships.

The ordering rule: **what changes the experience per hour of work**, with a bias
toward the grain of this codebase — a pure function in `web/` with a test beside
it is cheap, a new route in `server.py` costs a rebuild, and anything that needs
new storage or a second process is a different kind of day.

| Day | Theme | Why it is here |
|---|---|---|
| **0** | 鎖門 · Close the door | One-line risk. Do it first if the funnel is ever on. |
| **1** | 好聽啲 · Make it sound better | Four small changes in `web/`, all audible within a minute of opening the page. |
| **2** | 今日有咩唔同 · The delta read | The one feature that turns a re-read into news. |
| **3** | 出街 · Get it off the laptop | A podcast feed reaches the car, the kitchen and everyone who will never install a PWA. |
| **4** | 譚仔 · Lean into the name | Cheap, distinctive, and the spice slider is a real density control. |

---

## Day 0 · 鎖門

**Auth and a rate limit on `/api/tts`.** — S

`tailscale funnel` publishes the page and the synthesiser together, and the
README says plainly that there is no authentication in front of either. A
stranger with the URL has a free Cantonese TTS farm that bills its outbound
traffic to this box.

- A shared token in `config.json`, sent as a header or a query key, checked in `_api_tts`.
- A per-IP token bucket — a dict and a timestamp, nothing more.
- Loopback and tailnet ranges exempt, so nothing changes on the laptop.

**Done when** the funnel URL answers `/api/tts` with 401 and the tailnet one still speaks.

Skip this day entirely if the funnel is off and staying off — but then say so in
the README, because "no auth" and "not exposed" are two different claims.

---

## Day 1 · 好聽啲

Four changes, none of them deeper than `web/`, all audible.

**1. 兩把聲 · Two-voice reading** — S

Alternate the voice per segment: HiuGaai for the anchor lines, WanLung for
quoted material. `speech.js` already emits the segment list and already knows a
quote when it strips one; tag each segment with a role and let `player.js`
choose the voice from the tag.

*Done when* a digest with quotes reads back in two voices, and a browser voice
that cannot switch falls back to one without breaking.

**2. 讀音表 · Pronunciation lexicon** — S

A small JSON map applied in the speech layer, in the same place citations are
dropped — so the printed sentence and the spoken one stay two views of one
string. Seed it with the tickers and acronyms that currently come out as noise.

*Done when* `NVDA` reads as letters, a unit test covers the substitution, and
the `[12]` on screen is still a link.

**3. 每個類別記住把聲** — S

Voice and rate stored per topic, restored when you land on that filter. The
filter is already in the URL; this is a small map in `localStorage` keyed the
same way.

*Done when* finance opens at 1.3× WanLung and transcripts at 0.95× HiuMaan,
without touching the picker.

**4. 預熱 · Pre-warm the cache** — S

The page already arms a timer for `next_check_at` + 45s. When that fires and
upstream has something new, quietly fetch the first two segments of the top
digest so the first ▶ is instant.

*Done when* the first press after an upstream refresh starts without the
two-second stall — and when nothing is fetched if the tab is hidden.

---

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

**2. `/api/stream.mp3`** — M · *only if Day 3 has room*

The unheard queue, concatenated on the fly. Anything that can open a URL — a
Sonos, a car, a dumb speaker — becomes a client. Shares the concatenation code
with the podcast, which is why it goes the same day or not at all.

---

## Day 4 · 譚仔

Cheap, distinctive, and one of them is a real feature wearing a joke.

**1. 辣度** — M

A spice slider from 小辣 to 十小辣: headlines only at one end, everything with
citations read aloud at the other. It is a content-density control that needs no
explaining, and it composes with the delta read from Day 2 — 小辣 plus 只讀新嘢
is a sixty-second morning.

**2. 麵種** — S

Presets bundling topic filter, voice, speed and 辣度. 「今日嗌米線」 = your usual.
One button, one URL hash.

**3. 個碗會裝滿** — S

`icon.svg` is generated from geometry and `tools/make_icons.py` redraws it. Let
the bowl fill as the day's queue is worked through, and steam when something
lands unheard — the flag for new arrivals already exists, this gives it a face.

**4. 譚仔收據** — S

End of day, a receipt: what you listened to, itemised, minutes as prices, a fake
total at the bottom. Printable. Sillier and more memorable than a stats page,
and it is just a render over `listened.js`.

---

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
| Local Piper / Kokoro | Wants a second process and a model file in the image. |

## 記住

- `server.py` and `web/` are baked into the image. Editing them needs
  `docker compose up -d --build` — a plain restart keeps serving the old files
  and looks exactly like a change that did not work.
- `npm test` before each commit. The pure modules are pure for a reason; keep
  new logic in `web/*.js` where a test can reach it.
- Memory is capped at 256 MB. Day 3 adds pre-rendered audio — it belongs on
  disk, not in the LRU.
