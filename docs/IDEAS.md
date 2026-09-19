# 諗頭簿 · Ideas

Everything on the table, from the obvious to the daft. Nothing here is a
commitment — `ROADMAP.md` is where things go once they have a date.

Each entry carries a rough size, judged against the grain of this codebase:

| | |
|---|---|
| **S** | an afternoon — a pure function in `web/`, a test, some CSS |
| **M** | a day or two — a new route in `server.py`, or a new view |
| **L** | a week — new storage, a background job, or a second process |
| **XL** | a project in its own right |

And a note on what it leans on, because the good ideas here are the ones that
fall out of what already exists: the segment list from `speech.js`, the heard-state
arithmetic in `listened.js`, the day archive under `data/archive/`, the two
voice back-ends in `player.js`.

---

## 廣播 · Turn it into an actual radio station

The app is already a player. It is one short step from being a station.

| | | |
|---|---|---|
| **連續播放電台** | One endless stream instead of a page: unheard clips stitched end to end, a station ident between topics. Open the tab and it just talks. | M |
| **`/api/stream.mp3`** | Server-side concatenation of the unheard queue into one MP3. Works in the car, on a dumb Bluetooth speaker, on a Sonos — anywhere that can open a URL and nowhere near a browser. | M |
| **Podcast feed** | `/api/podcast.xml`, one episode per day, rendered overnight from the archive. Apple Podcasts becomes the client; CarPlay, chapters and playback position come free. | M |
| **早晨簡報 / 夜晚簡報** | A four-minute cut at 07:30 and a ten-minute one at 22:00, assembled from what you have *not* heard rather than from what is newest. | M |
| **AirPlay / Chromecast** | 朗讀 throws itself at the kitchen speaker. Browser-side for Chromecast; AirPlay needs the server MP3 path. | M |
| **Sleep timer · 定時鬧鐘** | Fade out after 20 minutes. Wake to the finance digest instead of a beep. | S |
| **Two-voice reading** | HiuGaai reads the anchor lines, WanLung reads the quotes. The segment list already knows which is which — alternate the voice per segment and it sounds like a newsroom. | S |
| **Jingle and bed** | A sting under the intro, ducking when speech starts. It is a station now; act like one. | S |

## 聲音 · The voice layer has room

| | | |
|---|---|---|
| **Per-topic voice and speed** | Finance at 1.3× in WanLung, transcripts at 0.95× in HiuMaan. Stored beside the topic filter, restored when you land on it. | S |
| **讀音表 · pronunciation lexicon** | A user-editable dictionary for tickers, English acronyms, place names and 人名, applied in the speech layer where citations are already dropped — so the printed sentence and the spoken one stay two views of the same string. | S |
| **Code-switch detection** | Route English spans to an English voice mid-sentence instead of letting a zh-HK voice mangle them. Splits a segment; the highlighting already handles one sentence becoming several spans. | M |
| **Pre-warm the cache** | Synthesise tomorrow's digest the moment upstream's cron lands, so the first press of ▶ is instant rather than a two-second stall. The page already arms a timer for `next_check_at` + 45s — this rides on it. | S |
| **Offline pack** | 「下載今日」 bakes the segments into Cache Storage. The whole thing then works on the MTR with no signal. | M |
| **Speed ramp** | Start a clip at 1.0× and drift to 1.25× over twenty seconds. The ear adapts and does not notice. | S |
| **Local Piper / Kokoro** | A third back-end so `/api/tts` survives with no outbound internet. Same interface as `edge-tts`. | L |

## 理解 · Make the archive smarter than a list

Upstream keeps three days. You keep everything. That is the moat, and almost
nothing in the app uses it yet.

| | | |
|---|---|---|
| ~~**「今日有咩唔同？」**~~ | ~~Diff today's summary against yesterday's and read only what moved.~~ **Measured and dropped** — upstream regenerates the daily summary rather than editing it, so two days share no wording even on the same story. See Day 2 in `ROADMAP.md`. The version that would work needs story clustering or a model, and is 時間線 below. | M |
| **讀幾多 · 快讀 / 提要 / 全文** | **Shipped** in its place: three lengths of the same day, cut from the digest's own structure. 快讀 is the 【本報訊】 lead upstream already writes — 1:02–1:25 against a full read of 11–14 minutes. | S |
| **時間線 · story threading** | Cluster digests across days into a running story: 「美聯儲減息」 as one spine with fourteen beats, not fourteen unrelated summaries. | L |
| **Entity pages** | Click 恒生指數 or a person's name and get every mention across the archive, playable end to end. | M |
| **Contradiction flags** | When two channels on a topic say opposite things, mark it 🔀 and read both. | L |
| **訊源分佈** | A small bar per topic showing which channels are actually driving the summary — and which ones never contribute anything. | S |
| **Semantic search** | Embeddings in SQLite over the whole archive: 「讀晒六月以嚟關於關稅嘅嘢」. | L |
| **提要之提要** | A weekly and a monthly super-digest, generated from the archive rather than from upstream. | M |
| **Forgotten-story nudge** | 「你六月聽咗呢單嘢三段,而家有新進展。補返?(90 秒)」 | M |

## 收聽 · The heard-state model deserves more

`listened.js` already knows more about your habits than anything else here.

| | | |
|---|---|---|
| **收聽統計** | 今年聽咗 41 小時, top topics, longest streak, the clip replayed six times. A Wrapped, for news. | M |
| **Boredom signal** | Skip a topic three times running and the app offers to demote it in the auto-play order. Implicit taste, no settings page. | S |
| **Attention heatmap** | Where in a clip you stop. Tells you which summaries are too long — and that is a fact worth sending upstream. | S |
| **Cross-device resume** | The phone picks up where the laptop stopped. History is deliberately local today; this is the version that breaks that, so it stays opt-in and signed. | L |
| **「聽過但唔記得」** | Spaced repetition: a twenty-second recap of something heard a fortnight ago, dropped into the auto-play run. | M |

## 互動 · Stop being read-only

| | | |
|---|---|---|
| **Ask the digest** | A mic button: 「點解會咁?」 — answered aloud in the same voice, grounded in that digest's cited articles. Hands stay on the wheel. | L |
| **Voice commands** | 「跳過」「重播」「慢啲」「講多啲呢個」 while playing. | M |
| **Bookmark by voice** | Say 「記低」 mid-clip and the sentence lands in a 稍後再睇 list with its citation intact. | M |
| **Annotate a sentence** | Long-press any span, leave a note, export the lot as Markdown. | M |
| **Share a clip** | A link that opens at sentence 7 *and* plays it. An actual shareable thirty-second news quote. The URL hash already carries view, filter and page — this is one more key. | S |
| **Chat with the archive** | In Cantonese, with citations clickable back into the digests. | L |

## 形態 · Other surfaces

| | | |
|---|---|---|
| **Telegram / Signal bot** | The morning brief as a voice note. Zero-friction distribution to people who would never install a PWA. | M |
| **Apple Watch complication** | 未聽 n. Tap to play through AirPods. | L |
| **Live Activity** | The current sentence in the Dynamic Island. | L |
| **Terminal client** | `tamchai`, a TUI. The API is already clean enough that this is mostly rendering. | M |
| **E-ink dashboard** | A low-refresh page for a wall-mounted screen: today's headlines, feed health, the countdown to the next upstream check. | S |
| **Lock-screen widget** | 今日三條. | L |
| **Email digest** | With the audio attached. | S |

## 平台 · Infrastructure

| | | |
|---|---|---|
| **Multi-upstream** | `base_url` is one string today. Let it be a list, colour-coded by origin. | M |
| **Bring your own feed** | Paste an RSS URL; it gets summarised into the same topic → channel → summary shape and joins the stream. | L |
| **Local summarisation** | An on-box model, so the whole pipeline runs with no cloud at all. | L |
| **Trigger upstream's cron** | Upstream exposes no such endpoint and `admin` is false for us, so ↻ can only ever fetch its *latest*. A tiny companion agent on the sesame box that does expose one would make ↻ mean 「而家去睇」. | M |
| **Feed health alerting** | 訊源狀態 already knows. Make it push when a source has been dark for twelve hours. | S |
| **Archive export** | One command, a tarball of every day as Markdown and JSON, so what you have collected outlives the app. | S |
| ~~**Auth on `/api/tts`**~~ ✅ | Funnel publishes the page *and* the synthesiser to anyone with the URL. A token and a rate limit are what stand between that and a stranger's TTS farm. | S |
| **Time-travel skin** | `#/digests?date=2026-03-04` already works. Add a skin that shows only what was known *then* — no hindsight, no later corrections. | S |

## 最野 · The daft end

| | | |
|---|---|---|
| **AI 主播對談** | Two voices *discuss* the day's digests, generated nightly from the archive. Cantonese talk radio with no humans in it. | L |
| **報紙檔** | Render the day as a broadsheet front page — proper Cantonese typography, printable, for the fridge. | M |
| **Karaoke 字幕** | The sentence highlighting you already have, burned into a vertical video with the audio. A news short, auto-published. | L |
| **Dream mode** | The day's digest at 0.6× with reverb, while you sleep. No evidence it works. Ship it anyway. | S |
| **譚仔圖靈測試** | A daily quiz: two summaries, one real, one hallucinated. Keeps you honest about how much you trust the pipeline. | M |
