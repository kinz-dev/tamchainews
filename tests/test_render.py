"""Day 3: turning an archived day into one file a car can play.

The arithmetic here is load-bearing in a way the reader's never was. On screen a
duration is a hint under a button; in a feed it is an enclosure length a client
may truncate on, and a chapter mark that lands in the wrong paragraph. So the
byte↔second conversion, the block offsets and the cut slicing are all pinned.

SHARED_SPEECH_CASES is the same table as `tests/speech.test.js` asserts against
`normalizeForSpeech`. The rules live in two languages because the page is
JavaScript and the renderer is Python; changing one and not the other now fails
a suite instead of quietly reading the news differently out loud.
"""

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from render import (  # noqa: E402
    BYTES_PER_SECOND, FRAME_BYTES, Renderer, blocks_of, clock, iso_week,
    kept_blocks, lead_end, normalise_for_speech, outlook_range, podcast_xml,
    rfc2822, seconds_of, week_bounds, weekly_xml,
)

# (input, spoken) — mirrored in tests/speech.test.js
SHARED_SPEECH_CASES = [
    ("上調至3.75%至4%", "上調至百分之3.75至百分之4"),
    ("美國聯邦儲備局（Fed）宣布", "美國聯邦儲備局宣布"),
    ("股票市場（Equities）", "股票市場"),
    ("Fed 主席表示", "聯儲局 主席表示"),
    ("FOMC 一致通過", "聯邦公開市場委員會 一致通過"),
    ("《五年規劃（2026—2030）》", "《五年規劃（2026—2030）》"),
    ("估值達$1.2萬億", "估值達1.2萬億美元"),
    ("見報道 [12] 所述", "見報道 所述"),
    ("AI 監管", "A I 監管"),
    ("本地生產總值GDP增長", "本地生產總值G D P增長"),
    ("甲 · 乙", "甲，乙"),
]

DIGEST = "\n".join([
    "# 聯儲局三年來首次加息 華為晶片提前發布",
    "",
    "**【本報訊】** 美國聯邦儲備局（Fed）宣布加息25個基點至3.75%至4%。華為發布新一代AI晶片。",
    "",
    "## 全球宏觀經濟",
    "",
    "美國聯儲局一致通過加息。納斯達克指數抽升1.7%。",
    "",
    "## 市場情緒展望",
    "",
    "* 股票市場",
    "* 方向：震盪偏多。",
])


class TestSpeechParity(unittest.TestCase):
    def test_the_shared_table(self):
        for source, spoken in SHARED_SPEECH_CASES:
            self.assertEqual(normalise_for_speech(source), spoken, source)

    def test_markdown_emphasis_is_stripped_before_speaking(self):
        blocks = blocks_of("**【本報訊】** 消息指出。")
        self.assertEqual(blocks[0]["text"], "【本報訊】 消息指出。")
        self.assertNotIn("*", blocks[0]["speak"])

    def test_a_link_reads_as_its_label(self):
        blocks = blocks_of("見 [報道](https://example.com/x) 全文。")
        self.assertEqual(blocks[0]["text"], "見 報道 全文。")


class TestBlocks(unittest.TestCase):
    def setUp(self):
        self.blocks = blocks_of(DIGEST)

    def test_headings_paragraphs_and_bullets_each_become_one_block(self):
        self.assertEqual([b["kind"] for b in self.blocks],
                         ["h1", "p", "h2", "p", "h2", "li", "li"])

    def test_a_paragraph_stays_whole_so_the_voice_can_carry_it(self):
        paragraph = self.blocks[1]
        self.assertIn("。", paragraph["text"][:-1], "this fixture needs a multi-sentence lead")
        self.assertEqual(paragraph["text"].count("。"), paragraph["speak"].count("。"),
                         "the block is read as one, not split into sentences")

    def test_a_heading_gains_the_full_stop_it_never_shows(self):
        heading = self.blocks[0]
        self.assertFalse(heading["text"].endswith("。"))
        self.assertTrue(heading["speak"].endswith("。"), "a heading with no pause runs into the news")

    def test_a_heading_that_already_ends_in_punctuation_is_left_alone(self):
        self.assertTrue(blocks_of("# 加息了嗎？")[0]["speak"].endswith("？"))
        self.assertNotIn("。", blocks_of("# 加息了嗎？")[0]["speak"])

    def test_blank_and_decorative_lines_produce_nothing(self):
        self.assertEqual(blocks_of(""), [])
        self.assertEqual(blocks_of("\n\n   \n"), [])


class TestCuts(unittest.TestCase):
    def setUp(self):
        self.blocks = blocks_of(DIGEST)

    def test_the_lead_is_the_title_and_what_sits_above_the_first_heading(self):
        self.assertEqual(lead_end(self.blocks), 2)
        self.assertEqual(kept_blocks(self.blocks, "quick"), [0, 1])

    def test_a_digest_with_no_headings_has_no_lead_to_separate(self):
        flat = blocks_of("# 標題\n\n一句。")
        self.assertEqual(lead_end(flat), len(flat))
        self.assertEqual(kept_blocks(flat, "quick"), [0, 1])

    def test_the_outlook_tail_runs_to_the_end_of_its_section(self):
        self.assertEqual(outlook_range(self.blocks), (4, 7))
        self.assertEqual(kept_blocks(self.blocks, "full", skip_outlook=True), [0, 1, 2, 3])

    def test_a_news_heading_about_market_sentiment_is_not_the_outlook(self):
        # The live 2026-09-18 digest leads with exactly this shape.
        newsy = blocks_of("# 標題\n\n導語。\n\n## 全球宏觀經濟：聯儲局與日銀同步緊縮，市場情緒兩極\n\n新聞一句。")
        self.assertIsNone(outlook_range(newsy))
        self.assertEqual(kept_blocks(newsy, "full", skip_outlook=True), list(range(len(newsy))))

    def test_the_outlook_heading_is_matched_through_its_qualifier(self):
        for heading in ("市場情緒展望", "近期市場情緒展望", "近市市場情緒展望（未來數週）"):
            blocks = blocks_of(f"# 標題\n\n導語。\n\n## {heading}\n\n* 方向：偏強")
            self.assertIsNotNone(outlook_range(blocks), heading)


class TestDuration(unittest.TestCase):
    def test_a_second_of_audio_is_a_fixed_number_of_bytes(self):
        # 48 kbps CBR, 24 kHz mono: measured against what edge-tts returns, and
        # every timestamp in the feed is this division.
        self.assertEqual(BYTES_PER_SECOND, 6000)
        self.assertEqual(seconds_of(6000), 1.0)
        self.assertEqual(seconds_of(229968), 38.328)     # the probe file, per afinfo

    def test_a_frame_is_a_whole_number_of_bytes(self):
        self.assertEqual(FRAME_BYTES * 1597, 229968)
        self.assertAlmostEqual(FRAME_BYTES / BYTES_PER_SECOND, 0.024)

    def test_clock_reads_as_hours_minutes_seconds(self):
        self.assertEqual(clock(0), "0:00:00")
        self.assertEqual(clock(75.4), "0:01:15")
        self.assertEqual(clock(3725), "1:02:05")

    def test_pubdate_is_rfc2822_in_utc(self):
        self.assertEqual(rfc2822(0), "Thu, 01 Jan 1970 00:00:00 +0000")


class FakeTts:
    """Stands in for edge-tts: one frame per spoken character, which keeps the
    arithmetic checkable without sending anything to Microsoft."""

    def __init__(self):
        self.calls = []

    def __call__(self, text, voice, rate):
        self.calls.append((text, voice, rate))
        return bytes([0xFF]) * (FRAME_BYTES * max(1, len(text)))


class TestRenderer(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.audio = root / "audio"
        self.tts = FakeTts()
        self.renderer = Renderer(root / "archive", self.audio, self.tts,
                                 voice="zh-HK-HiuGaaiNeural", pause=0)
        self.day = {"day": "2026-09-18", "headline": "加息", "text": DIGEST,
                    "generated_at": 1789000000}

    def tearDown(self):
        self.tmp.cleanup()

    def test_rendering_writes_the_pair_and_offsets_tile_the_file(self):
        manifest = self.renderer.render(self.day)
        audio = (self.audio / "2026-09-18.mp3").read_bytes()
        self.assertEqual(len(audio), manifest["bytes"])
        self.assertEqual(manifest["seconds"], round(len(audio) / BYTES_PER_SECOND, 3))

        cursor = 0
        for block in manifest["blocks"]:
            self.assertEqual(block["offset"], cursor, "a gap or overlap would shift every chapter")
            cursor += block["bytes"]
        self.assertEqual(cursor, len(audio))

    def test_the_manifest_is_written_beside_the_audio_and_reads_back(self):
        self.renderer.render(self.day)
        stored = json.loads((self.audio / "2026-09-18.json").read_text(encoding="utf-8"))
        self.assertEqual(stored, self.renderer.manifest("2026-09-18"))
        self.assertEqual(stored["voice"], "zh-HK-HiuGaaiNeural")

    def test_what_is_synthesised_is_the_spoken_form_not_the_printed_one(self):
        self.renderer.render(self.day)
        spoken = [call[0] for call in self.tts.calls]
        self.assertTrue(any("百分之" in text for text in spoken))
        self.assertFalse(any("（Fed）" in text for text in spoken))

    def test_a_day_already_rendered_is_not_rendered_again(self):
        self.renderer.render(self.day)
        self.assertEqual(self.renderer.pending([self.day]), [])

    def test_a_day_whose_text_changed_is_rendered_again(self):
        self.renderer.render(self.day)
        edited = dict(self.day, text=DIGEST + "\n\n後續消息。")
        self.assertEqual(self.renderer.pending([edited]), [edited])

    def test_missing_audio_beside_a_manifest_counts_as_pending(self):
        self.renderer.render(self.day)
        (self.audio / "2026-09-18.mp3").unlink()
        self.assertEqual(self.renderer.pending([self.day]), [self.day])

    def test_the_full_cut_is_the_file_itself(self):
        manifest = self.renderer.render(self.day)
        self.assertEqual(self.renderer.slice_for(manifest), [(0, manifest["bytes"])])
        self.assertEqual(self.renderer.audio_for("2026-09-18"),
                         (self.audio / "2026-09-18.mp3").read_bytes())

    def test_the_quick_cut_is_a_prefix_of_it(self):
        manifest = self.renderer.render(self.day)
        ranges = self.renderer.slice_for(manifest, "quick")
        self.assertEqual(len(ranges), 1, "the lead is contiguous, so it is one read")
        self.assertEqual(ranges[0][0], 0)
        quick = self.renderer.audio_for("2026-09-18", "quick")
        self.assertEqual(quick, self.renderer.audio_for("2026-09-18")[:len(quick)])
        self.assertLess(len(quick), manifest["bytes"])

    def test_skipping_the_outlook_removes_a_run_from_the_middle_or_end(self):
        manifest = self.renderer.render(self.day)
        trimmed = self.renderer.audio_for("2026-09-18", "full", skip_outlook=True)
        self.assertLess(len(trimmed), manifest["bytes"])
        # Every byte still lands on a frame boundary, or the join would click.
        self.assertEqual(len(trimmed) % FRAME_BYTES, 0)

    def test_chapters_come_from_the_headings_at_their_own_timestamps(self):
        self.renderer.render(self.day)
        chapters = self.renderer.chapters_for("2026-09-18")
        self.assertEqual([c["title"] for c in chapters],
                         ["聯儲局三年來首次加息 華為晶片提前發布", "全球宏觀經濟", "市場情緒展望"])
        self.assertEqual(chapters[0]["startTime"], 0.0)
        self.assertEqual(chapters, sorted(chapters, key=lambda c: c["startTime"]))

    def test_nothing_rendered_yet_answers_empty_rather_than_failing(self):
        self.assertEqual(self.renderer.episodes(), [])
        self.assertIsNone(self.renderer.audio_for("2026-09-18"))
        self.assertEqual(self.renderer.chapters_for("2026-09-18"), [])

    def test_the_sweep_keeps_the_newest_and_drops_the_rest(self):
        for day in ("2026-09-14", "2026-09-15", "2026-09-16"):
            self.renderer.render(dict(self.day, day=day))
        self.renderer.keep_days = 2
        self.assertEqual(self.renderer.sweep(), 1)
        self.assertEqual([e["day"] for e in self.renderer.episodes()],
                         ["2026-09-16", "2026-09-15"])
        self.assertFalse((self.audio / "2026-09-14.json").exists(),
                         "a manifest without audio would advertise an episode that is gone")


# The short DIGEST above is all lead and no body, which is the opposite of a
# real day: measured across the archive, the 標題 and 【本報訊】 run about a tenth
# of the read. A week of leads being *much* shorter than a week of days is the
# whole claim, so the fixture it is checked against has to have those
# proportions.
LONG_DIGEST = "\n".join([
    "# 聯儲局加息 華為晶片提前發布",
    "",
    "**【本報訊】** 聯儲局宣布加息25個基點。華為發布新一代晶片。",
    "",
    "## 全球宏觀經濟",
    "",
    "美國聯儲局一致通過加息。" + "議息會議之後市場重新定價。" * 8,
    "",
    "英倫銀行維持利率不變。" + "分析師認為通脹仍然高企。" * 8,
    "",
    "## 科技產業",
    "",
    "華為提前發布訓練晶片。" + "性能預計翻倍並挑戰對手。" * 8,
    "",
    "長鑫存儲取代舊有供應商。" + "手機廠商開始大規模採用。" * 8,
])


class TestWeekly(unittest.TestCase):
    """The week is each day's lead, in order. No model, no summary of a summary:
    upstream already writes one summary of each day, and this is those."""

    def setUp(self):
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.audio = root / "audio"
        self.renderer = Renderer(root / "archive", self.audio, FakeTts(),
                                 voice="zh-HK-HiuGaaiNeural", pause=0)
        # 09-14 (Mon) … 09-18 (Fri) are one ISO week; 09-21 is the next Monday.
        for day in ("2026-09-14", "2026-09-16", "2026-09-18", "2026-09-21"):
            self.renderer.render({"day": day, "headline": f"頭條 {day}", "text": LONG_DIGEST,
                                  "generated_at": 1789000000})

    def tearDown(self):
        self.tmp.cleanup()

    def test_iso_weeks_group_the_days_and_never_split_a_new_year(self):
        self.assertEqual(iso_week("2026-09-14"), "2026-W38")
        self.assertEqual(iso_week("2026-09-20"), "2026-W38", "Sunday closes the week")
        self.assertEqual(iso_week("2026-09-21"), "2026-W39", "Monday opens the next")
        self.assertEqual(week_bounds("2026-W38"), ("2026-09-14", "2026-09-20"))

    def test_weeks_are_listed_newest_first_with_their_days_in_order(self):
        weeks = self.renderer.weeks()
        self.assertEqual([w["week"] for w in weeks], ["2026-W39", "2026-W38"])
        older = weeks[1]
        self.assertEqual(older["days"], ["2026-09-14", "2026-09-16", "2026-09-18"],
                         "a catch-up reads Monday forward, not newest first")
        self.assertEqual((older["from"], older["to"]), ("2026-09-14", "2026-09-18"))
        self.assertEqual((older["monday"], older["sunday"]), ("2026-09-14", "2026-09-20"))

    def test_a_week_is_its_days_leads_joined_and_nothing_else(self):
        week = next(w for w in self.renderer.weeks() if w["week"] == "2026-W38")
        audio = self.renderer.week_audio("2026-W38")
        self.assertEqual(len(audio), week["bytes"], "the advertised length is the real one")
        leads = [self.renderer.audio_for(day, "quick") for day in week["days"]]
        self.assertEqual(audio, b"".join(leads))
        self.assertEqual(len(audio) % FRAME_BYTES, 0, "a join off a frame would click")
        # Much shorter than the same days read in full — the whole point.
        full = sum(len(self.renderer.audio_for(day)) for day in week["days"])
        self.assertLess(len(audio), full / 2)

    def test_a_week_with_no_audio_is_not_advertised(self):
        self.assertIsNone(self.renderer.week_audio("2026-W01"))
        self.assertNotIn("2026-W01", [w["week"] for w in self.renderer.weeks()])

    def test_the_weekly_feed_is_valid_and_carries_real_lengths(self):
        import xml.etree.ElementTree as ET
        xml_text = weekly_xml(self.renderer.weeks(), "https://box.example")
        root = ET.fromstring(xml_text)
        items = root.findall("./channel/item")
        self.assertEqual(len(items), 2)
        first = items[0]
        self.assertIn("2026-W39", first.findtext("title"))
        week = self.renderer.weeks()[0]
        self.assertEqual(first.find("enclosure").get("length"), str(week["bytes"]))
        self.assertIn("week=2026-W39", first.find("enclosure").get("url"))

    def test_the_weekly_guid_differs_from_any_daily_one(self):
        # Both feeds may be subscribed at once, and the same audio under one
        # guid would have a client download it twice or skip it entirely.
        weekly = weekly_xml(self.renderer.weeks(), "https://box.example")
        daily = podcast_xml(self.renderer.episodes(), "https://box.example")
        weekly_ids = set(re.findall(r"<guid[^>]*>([^<]+)</guid>", weekly))
        daily_ids = set(re.findall(r"<guid[^>]*>([^<]+)</guid>", daily))
        self.assertTrue(weekly_ids)
        self.assertEqual(weekly_ids & daily_ids, set())

    def test_an_empty_archive_still_produces_a_valid_weekly_feed(self):
        import tempfile
        import xml.etree.ElementTree as ET
        with tempfile.TemporaryDirectory() as empty:
            bare = Renderer(Path(empty), Path(empty) / "audio", FakeTts(), voice="v")
            self.assertEqual(bare.weeks(), [])
            root = ET.fromstring(weekly_xml(bare.weeks(), "https://box.example"))
            self.assertEqual(root.findall("./channel/item"), [])


class TestFeed(unittest.TestCase):
    def setUp(self):
        self.episodes = [
            {"day": "2026-09-18", "headline": "加息 & 晶片", "bytes": 1200000,
             "seconds": 200.0, "generated_at": 1789000000, "rendered_at": 1789000900},
            {"day": "2026-09-17", "headline": "重新定價", "bytes": 600000,
             "seconds": 100.0, "generated_at": 1788913600, "rendered_at": 1788914500},
        ]

    def test_one_item_per_episode_newest_first(self):
        xml = podcast_xml(self.episodes, "https://box.example")
        self.assertEqual(xml.count("<item>"), 2)
        self.assertLess(xml.index("2026-09-18"), xml.index("2026-09-17"))
        self.assertTrue(xml.startswith('<?xml version="1.0" encoding="UTF-8"?>'))

    def test_the_enclosure_carries_the_real_length_and_duration(self):
        xml = podcast_xml(self.episodes, "https://box.example")
        self.assertIn('length="1200000"', xml)
        self.assertIn("<itunes:duration>0:03:20</itunes:duration>", xml)

    def test_a_cut_feed_advertises_the_cut_length_not_the_whole_day(self):
        xml = podcast_xml(self.episodes, "https://box.example", cut="quick",
                          slices={"2026-09-18": 300000, "2026-09-17": 150000})
        self.assertIn('length="300000"', xml)
        self.assertNotIn('length="1200000"', xml)
        self.assertIn("<itunes:duration>0:00:50</itunes:duration>", xml)
        self.assertIn("cut=quick", xml)

    def test_a_cut_feed_has_its_own_guids_so_both_can_be_subscribed_at_once(self):
        full = podcast_xml(self.episodes, "https://box.example")
        quick = podcast_xml(self.episodes, "https://box.example", cut="quick")
        self.assertIn("tamchai-2026-09-18-full", full)
        self.assertIn("tamchai-2026-09-18-quick", quick)

    def test_ampersands_in_a_headline_and_a_url_are_escaped(self):
        xml = podcast_xml(self.episodes, "https://box.example", cut="quick", skip_outlook=True)
        self.assertIn("加息 &amp; 晶片", xml)
        self.assertNotIn("&s", xml.replace("&amp;", ""), "a raw & would make this not XML")
        import xml.etree.ElementTree as ET
        ET.fromstring(xml)          # parses, or the feed is broken

    def test_chapters_are_offered_only_where_they_line_up(self):
        full = podcast_xml(self.episodes, "https://box.example")
        self.assertIn("podcast:chapters", full)
        # A cut moves every timestamp, so chapters measured against the whole
        # day would point into the wrong paragraph.
        self.assertNotIn("podcast:chapters", podcast_xml(self.episodes, "https://box.example", cut="quick"))

    def test_an_empty_archive_still_produces_a_valid_feed(self):
        import xml.etree.ElementTree as ET
        root = ET.fromstring(podcast_xml([], "https://box.example"))
        self.assertEqual(root.findall("./channel/item"), [])


if __name__ == "__main__":
    unittest.main()
