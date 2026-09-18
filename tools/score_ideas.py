"""Scores every idea in IDEAS.md for value and effort, and writes PRIORITY.md.

The ranking is derived from the table below, never typed by hand, so the
tiers cannot drift from the scores. Change a number here and re-run:

    python3 tools/score_ideas.py

Effort is the S/M/L/XL from IDEAS.md. Value is a judgement, and the
assumptions it rests on are spelled out at the foot of PRIORITY.md.
"""

# value 1-5, effort S/M/L/XL. One line per idea; the ranking is derived, not typed.
COST = {"S": 1, "M": 3, "L": 8, "XL": 20}
# (name, theme, effort, value, why this value)
IDEAS = [
 ("Prefer browser voices",      "聲音", "S", 4, "Cuts most server traffic; localService logic is already there"),
 ("讀音表 pronunciation lexicon","聲音", "S", 4, "Tickers and acronyms are mangled every single day"),
 ("Pre-warm the cache",         "聲音", "S", 4, "Kills the 2s stall on the first ▶ — friction you meet daily"),
 ("Feed health alerting",       "平台", "S", 4, "A source dying quietly makes the whole app lie to you"),
 ("Two-voice reading",          "廣播", "S", 3, "Cheapest real change to how it sounds"),
 ("Per-topic voice and speed",  "聲音", "S", 3, "Finance and transcripts want different settings, permanently"),
 ("訊源分佈",                    "理解", "S", 3, "Shows which channels are dead weight — actionable upstream"),
 ("Boredom signal",             "收聽", "S", 3, "Implicit taste with no settings page to maintain"),
 ("Archive export",             "平台", "S", 3, "The archive is the moat; insurance against losing it"),
 ("Sleep timer 定時鬧鐘",        "廣播", "S", 2, "Narrow, but nearly free"),
 ("Speed ramp",                 "聲音", "S", 2, "Subtle; you stop noticing it working"),
 ("Attention heatmap",          "收聽", "S", 2, "Diagnostic, not a feature you use"),
 ("Share a clip",               "互動", "S", 2, "Rare on a single-listener app"),
 ("E-ink dashboard",            "形態", "S", 2, "Needs a wall screen you may not have"),
 ("Email digest",               "形態", "S", 2, "Superseded by the podcast for most uses"),
 ("Time-travel skin",           "平台", "S", 2, "Occasional; the date filter already works"),
 ("Jingle and bed",             "廣播", "S", 1, "Pure texture"),
 ("Dream mode",                 "最野", "S", 1, "No evidence it does anything"),

 ("「今日有咩唔同」",             "理解", "M", 5, "12 min of re-reading becomes 2 min of news. Daily. The one."),
 ("Podcast feed",               "廣播", "M", 5, "CarPlay, offline, position sync — a whole context, for free"),
 ("早晨 / 夜晚簡報",              "廣播", "M", 4, "A fixed-length cut of what you have NOT heard"),
 ("/api/stream.mp3",            "廣播", "M", 4, "Any dumb speaker becomes a client"),
 ("Offline pack",               "聲音", "M", 4, "The MTR has no signal and you are on it"),
 ("Code-switch detection",      "聲音", "M", 4, "English spans mangled by a zh-HK voice, every finance digest"),
 ("提要之提要 weekly",            "理解", "M", 4, "The catch-up after a week away; uses the archive upstream lacks"),
 ("Azure client back-end",      "聲音", "M", 4, "Removes the structural risk instead of relocating it"),
 ("Entity pages",               "理解", "M", 3, "Occasional, but the archive makes it cheap"),
 ("Forgotten-story nudge",      "理解", "M", 3, "Good when it fires; fires rarely"),
 ("Voice commands",             "互動", "M", 3, "Hands-free matters in the contexts this app is for"),
 ("Bookmark by voice",          "互動", "M", 3, "Capture without stopping"),
 ("Telegram voice note",        "形態", "M", 3, "Distribution to people who will never install a PWA"),
 ("Trigger upstream's cron",    "平台", "M", 3, "Makes ↻ mean 'go look now' instead of 'ask again'"),
 ("AirPlay / Chromecast",       "廣播", "M", 3, "Largely covered once stream.mp3 exists"),
 ("連續播放電台",                "廣播", "M", 3, "Auto-play already does most of this"),
 ("收聽統計",                    "收聽", "M", 2, "Fun once a year"),
 ("「聽過但唔記得」",             "收聽", "M", 2, "Spaced repetition for news is unproven"),
 ("Annotate a sentence",        "互動", "M", 2, "You are listening, not studying"),
 ("Multi-upstream",             "平台", "M", 2, "There is one upstream"),
 ("報紙檔 broadsheet",           "最野", "M", 2, "Lovely, occasional"),
 ("譚仔圖靈測試",                "最野", "M", 2, "Trust calibration, as a game"),
 ("Terminal client",            "形態", "M", 1, "You already have the browser open"),

 ("時間線 story threading",      "理解", "L", 4, "Fourteen beats become one spine — the archive's real prize"),
 ("Ask the digest",             "互動", "L", 4, "Hands-free follow-ups; needs a grounding story"),
 ("Local Piper / Kokoro",       "聲音", "L", 3, "Insurance. Worth 5 the morning edge-tts breaks"),
 ("Semantic search",            "理解", "L", 3, "Occasional, powerful when it lands"),
 ("Contradiction flags",        "理解", "L", 3, "Rare but high-signal"),
 ("Cross-device resume",        "收聽", "L", 3, "Breaks the local-only principle deliberately"),
 ("Chat with the archive",      "互動", "L", 3, "Overlaps Ask the digest"),
 ("Bring your own feed",        "平台", "L", 3, "Widens the app past one upstream"),
 ("AI 主播對談",                 "最野", "L", 3, "High delight, unclear daily pull"),
 ("Apple Watch complication",   "形態", "L", 2, "Nice, narrow"),
 ("Live Activity",              "形態", "L", 2, "Nice, narrow"),
 ("Lock-screen widget",         "形態", "L", 2, "Nice, narrow"),
 ("Karaoke 字幕 video",          "最野", "L", 2, "Only if you want to publish"),
 ("Local summarisation",        "平台", "L", 2, "Big job; upstream already summarises"),
]

rows = [(n, t, e, v, COST[e], v / COST[e], w) for n, t, e, v, w in IDEAS]
rows.sort(key=lambda r: (-r[5], r[4], -r[3]))
print(f"{len(rows)} ideas scored\n")
for i, (n, t, e, v, c, ratio, w) in enumerate(rows[:14], 1):
    print(f"{i:>2}. {n:<28} {t}  {e}({c})  value {v}  ratio {ratio:.2f}")
print()
TIERS = [
    ("1 free wins    (S,  value>=3)", lambda r: r[3] >= 3 and r[2] == "S"),
    ("2 the fives    (     value==5)", lambda r: r[3] == 5),
    ("3 worth a day  (M+, value==4)", lambda r: r[3] == 4 and r[2] != "S"),
    ("4 someday      (M+, value==3)", lambda r: r[3] == 3 and r[2] != "S"),
    ("5 for fun      (S,  value<3)",  lambda r: r[3] < 3 and r[2] == "S"),
    ("6 not worth it (M,  value<3)",  lambda r: r[3] < 3 and r[2] == "M"),
    ("7 don't        (L+, value<3)",  lambda r: r[3] < 3 and r[2] in ("L", "XL")),
]
placed = 0
for label, test in TIERS:
    hits = [r[0] for r in rows if test(r)]
    placed += len(hits)
    print(f"  tier {label}: {len(hits):>2}")
# every idea must land in exactly one tier, or the document quietly loses some
assert placed == len(rows), f"{len(rows) - placed} ideas fell through the tiers"
print(f"  {placed}/{len(rows)} placed")

# ---------------------------------------------------------------- generate doc
out = []
w = out.append
w("""# 優先次序 · Priority

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
|---|---|---|---|""")

rows_s = [r for r in rows if r[3] >= 3 and r[2] == "S"]
for i, (n, t, e, v, c, ratio, why) in enumerate(rows_s, 1):
    w(f"| {i} | **{n}** | {v} | {why} |")

w("""
**Total cost: 11 points ≈ one focused day.** The first four are the ones to do
even if you stop there.

---

## Tier 2 · The two that earn a real day each

| Idea | Effort | Value | |
|---|---|---|---|""")
for n, t, e, v, c, ratio, why in [r for r in rows if r[3] == 5]:
    w(f"| **{n}** | {e} | {v} | {why} |")

w("""
These are the only two scored 5, and they are worth more than the whole of
Tier 1 combined. One makes the content better; the other makes it reach you.

---

## Tier 3 · Worth doing, not cheap

Value 4 at M or L. Real gains that cost a day or more each.

| Idea | Effort | Value | |
|---|---|---|---|""")
for n, t, e, v, c, ratio, why in [r for r in rows if r[3] == 4 and r[2] != "S"]:
    w(f"| **{n}** | {e} | {v} | {why} |")

w("""
---

## Tier 4 · Fine, someday

Value 3 at M or L — genuine, but every one of them costs more than all of
Tier 1 and returns less.

| Idea | Effort | |
|---|---|---|""")
for n, t, e, v, c, ratio, why in [r for r in rows if r[3] == 3 and r[2] != "S"]:
    w(f"| {n} | {e} | {why} |")

w("""
---

## Tier 5 · Cheap enough to do for fun

Value 2 or less at S. No case for them beyond enjoying them, which is a real
reason on a personal project — just not one to schedule.

""" + " · ".join(f"**{r[0]}**" for r in rows if r[3] < 3 and r[2] == "S"))

w("""
## Tier 6 · Not worth the day

Value under 3 at M. Each is a day's work for something narrow — the tier most
likely to be picked up by accident because none of them sound expensive.

| Idea | |
|---|---|""")
for n, t, e, v, c, ratio, why in [r for r in rows if r[3] < 3 and r[2] == "M"]:
    w(f"| {n} | {why} |")

w("""
## Tier 7 · Don't

Value under 3 at L or more. Each costs eight points or worse to deliver
something narrow.

""" + " · ".join(f"**{r[0]}**" for r in rows if r[3] < 3 and r[2] in ("L", "XL")))

w("""
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
""")

from pathlib import Path
Path("docs/PRIORITY.md").write_text("\n".join(out) + "\n")
print("wrote docs/PRIORITY.md")
