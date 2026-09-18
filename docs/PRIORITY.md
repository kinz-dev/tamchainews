# 優先次序 · Priority

Every idea in `IDEAS.md`, scored and ranked. `AUTH ON /api/tts` is gone from the
list because it shipped in #8.

**Effort** is the S/M/L/XL from `IDEAS.md`, costed `S=1, M=3, L=8, XL=20`, and it
is the half of this worth trusting — it comes from the shape of the code.

**Value** is 1–5 and it is *my* judgement, not yours. It rests on four
assumptions about how this gets used, listed at the bottom. **Correcting one of
those reorders the table far more usefully than arguing with an individual
score**, so read those first and tell me which are wrong.

| Value | |
|---|---|
| **5** | changes how you use it, every day |
| **4** | daily improvement, or opens a context you do not have |
| **3** | real, occasional |
| **2** | narrow, or delight without function |
| **1** | fun, no functional gain |

---

## The honest warning about ranking by ratio

Sorted by value ÷ effort, the top eleven are all **S** and not one of them
changes what this app *is*. You could ship every one and still be re-listening to
a mostly-unchanged summary for twelve minutes each morning.

So the list is in two parts, and they are not competing: **the cheap wins are a
day, not a plan.** Take them because they are nearly free, then go at the two
fives.

---

## Tier 1 · The free wins — one day, all of them

Eleven S items at value 3 or better. Ranked, but honestly the top four are the
ones that matter and the rest are the same afternoon.

| | Idea | Value | Why |
|---|---|---|---|
| 1 | **Prefer browser voices** | 4 | Cuts most server traffic; localService logic is already there |
| 2 | **讀音表 pronunciation lexicon** | 4 | Tickers and acronyms are mangled every single day |
| 3 | **Pre-warm the cache** | 4 | Kills the 2s stall on the first ▶ — friction you meet daily |
| 4 | **Feed health alerting** | 4 | A source dying quietly makes the whole app lie to you |
| 5 | **Two-voice reading** | 3 | Cheapest real change to how it sounds |
| 6 | **Per-topic voice and speed** | 3 | Finance and transcripts want different settings, permanently |
| 7 | **訊源分佈** | 3 | Shows which channels are dead weight — actionable upstream |
| 8 | **Boredom signal** | 3 | Implicit taste with no settings page to maintain |
| 9 | **Archive export** | 3 | The archive is the moat; insurance against losing it |

**Total cost: 11 points ≈ one focused day.** The first four are the ones to do
even if you stop there.

---

## Tier 2 · The two that earn a real day each

| Idea | Effort | Value | |
|---|---|---|---|
| **「今日有咩唔同」** | M | 5 | 12 min of re-reading becomes 2 min of news. Daily. The one. |
| **Podcast feed** | M | 5 | CarPlay, offline, position sync — a whole context, for free |

These are the only two scored 5, and they are worth more than the whole of
Tier 1 combined. One makes the content better; the other makes it reach you.

---

## Tier 3 · Worth doing, not cheap

Value 4 at M or L. Real gains that cost a day or more each.

| Idea | Effort | Value | |
|---|---|---|---|
| **早晨 / 夜晚簡報** | M | 4 | A fixed-length cut of what you have NOT heard |
| **/api/stream.mp3** | M | 4 | Any dumb speaker becomes a client |
| **Offline pack** | M | 4 | The MTR has no signal and you are on it |
| **Code-switch detection** | M | 4 | English spans mangled by a zh-HK voice, every finance digest |
| **提要之提要 weekly** | M | 4 | The catch-up after a week away; uses the archive upstream lacks |
| **Azure client back-end** | M | 4 | Removes the structural risk instead of relocating it |
| **時間線 story threading** | L | 4 | Fourteen beats become one spine — the archive's real prize |
| **Ask the digest** | L | 4 | Hands-free follow-ups; needs a grounding story |

---

## Tier 4 · Fine, someday

Value 3 at M or L — genuine, but every one of them costs more than all of
Tier 1 and returns less.

| Idea | Effort | |
|---|---|---|
| Entity pages | M | Occasional, but the archive makes it cheap |
| Forgotten-story nudge | M | Good when it fires; fires rarely |
| Voice commands | M | Hands-free matters in the contexts this app is for |
| Bookmark by voice | M | Capture without stopping |
| Telegram voice note | M | Distribution to people who will never install a PWA |
| Trigger upstream's cron | M | Makes ↻ mean 'go look now' instead of 'ask again' |
| AirPlay / Chromecast | M | Largely covered once stream.mp3 exists |
| 連續播放電台 | M | Auto-play already does most of this |
| Local Piper / Kokoro | L | Insurance. Worth 5 the morning edge-tts breaks |
| Semantic search | L | Occasional, powerful when it lands |
| Contradiction flags | L | Rare but high-signal |
| Cross-device resume | L | Breaks the local-only principle deliberately |
| Chat with the archive | L | Overlaps Ask the digest |
| Bring your own feed | L | Widens the app past one upstream |
| AI 主播對談 | L | High delight, unclear daily pull |

---

## Tier 5 · Cheap enough to do for fun

Value 2 or less at S. No case for them beyond enjoying them, which is a real
reason on a personal project — just not one to schedule.

**Sleep timer 定時鬧鐘** · **Speed ramp** · **Attention heatmap** · **Share a clip** · **E-ink dashboard** · **Email digest** · **Time-travel skin** · **Jingle and bed** · **Dream mode**

## Tier 6 · Not worth the day

Value under 3 at M. Each is a day's work for something narrow — the tier most
likely to be picked up by accident because none of them sound expensive.

| Idea | |
|---|---|
| 收聽統計 | Fun once a year |
| 「聽過但唔記得」 | Spaced repetition for news is unproven |
| Annotate a sentence | You are listening, not studying |
| Multi-upstream | There is one upstream |
| 報紙檔 broadsheet | Lovely, occasional |
| 譚仔圖靈測試 | Trust calibration, as a game |
| Terminal client | You already have the browser open |

## Tier 7 · Don't

Value under 3 at L or more. Each costs eight points or worse to deliver
something narrow.

**Apple Watch complication** · **Live Activity** · **Lock-screen widget** · **Karaoke 字幕 video** · **Local summarisation**

---

## The four assumptions the value column rests on

Argue with these, not with the scores.

1. **You listen daily, mostly passively.** The whole app is built around
   auto-play, resume and heard-state, so this is nearly certain — and it is why
   anything that shaves the daily twelve minutes scores 5, and anything you use
   once a year scores 2. *If listening is actually a few times a week,* 提要之提要
   and the weekly catch-up rise sharply and the delta read falls.
2. **There is a hands-busy context — a commute, a kitchen, a walk.** This is the
   shakiest one, and it is doing the most work: it is the entire case for the
   podcast feed at 5, and for 早晨簡報, stream.mp3, AirPlay and voice commands
   above it. *If you only ever listen at a desk,* the whole 廣播 group drops by
   two and Tier 1 plus the delta read becomes the whole plan.
3. **You are the only real listener; family is a maybe.** Keeps Telegram, email
   and multi-upstream low, and is why "share a clip" scores 2. *If you want
   family on this,* the Telegram voice note and the podcast both jump.
4. **The archive is the point.** You keep everything; upstream keeps three days.
   This lifts the delta read, 提要之提要, threading and archive export. It is
   well supported by the code — the archive exists and almost nothing reads it.

## What this changes in the roadmap

Day 1 was picked before any of this was scored, and two of its four are only
value 3. Swapping them for the two value-4 items that were not in it:

| Day 1, was | Day 1, now |
|---|---|
| Two-voice reading (3) | **Prefer browser voices (4)** |
| 讀音表 lexicon (4) | 讀音表 lexicon (4) |
| Per-topic voice and speed (3) | **Feed health alerting (4)** |
| Pre-warm the cache (4) | Pre-warm the cache (4) |

Two-voice and per-topic are not dropped — they are the next two in Tier 1, and
all six fit a day if it goes well. Days 2, 3 and 4 survive scoring unchanged.

