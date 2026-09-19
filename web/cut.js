// 一日新聞，三個長度。One day's digest, cut to the time you actually have.
//
// This is Day 2 — 「今日有咩唔同」 — arrived at from the other side. The plan was
// to diff today's summary against yesterday's and read only what moved. The
// archive says that cannot work: upstream *regenerates* the daily summary every
// morning rather than editing it, so two consecutive days share almost no
// wording even where they cover the same story. Measured over the four archived
// days, 65 of 74 sentences come back "new" on sentence similarity; the best
// block-level matching saves 2–4% of the runtime, and all of that saving is the
// 市場情緒展望 scaffolding — 「信心水平：中」 and the like — because the short
// repeated lines are the only repeated lines. A paragraph retelling yesterday's
// Fed decision in fresh words scores *below* a genuinely new one. There is no
// threshold in there; there is no signal to threshold.
//
// What the same measurements did find is that the digest already contains its
// own short version, every day, written by upstream: the title plus the
// 【本報訊】 lead paragraph runs 1:02–1:18 against a full read of 10:39–12:42.
// So the twelve minutes become two by structure rather than by comparison —
// which also works on a day with no yesterday, and has nothing in it to drift.

import { toSegments, estimateSeconds } from './speech.js';

/** The three lengths, shortest first. `full` is what the reader always did. */
export const CUTS = [
  { id: 'quick', label: '快讀', hint: '標題同導語' },
  { id: 'gist', label: '提要', hint: '每節第一句' },
  { id: 'full', label: '全文', hint: '成篇讀晒' },
];

const CUT_IDS = CUTS.map((cut) => cut.id);

export function isCut(id) { return CUT_IDS.includes(id); }

/** The cut one step longer than this one, for 「撳提要聽多啲」. */
export function nextCut(id) {
  const at = CUT_IDS.indexOf(id);
  return at >= 0 && at < CUT_IDS.length - 1 ? CUTS[at + 1] : null;
}

export function labelOf(id) {
  return CUTS.find((cut) => cut.id === id)?.label || '';
}

const isHeading = (block) => Boolean(block) && block.kind.startsWith('h');

/** A block's text, joined back up — headings are one segment, prose is many. */
export function textOf(block) {
  return (block?.segments || []).map((segment) => segment.text).join('');
}

/**
 * Where the lead ends: the first heading under the title.
 *
 * Everything above it is 標題 + 【本報訊】, which is upstream's own summary of
 * the whole day and the reason 快讀 needs no cleverness. A digest with no
 * sub-headings at all has no lead to separate, and this answers with its
 * length — 快讀 then reads the lot, which is honest: there is nothing to cut.
 */
export function leadEnd(blocks = []) {
  for (let i = 1; i < blocks.length; i += 1) if (isHeading(blocks[i])) return i;
  return blocks.length;
}

// The outlook section is titled 「市場情緒展望」, 「近期市場情緒展望」 or
// 「近市市場情緒展望（未來數週）」 depending on the day, so a heading is matched on
// the part that does not move, with room for the qualifier that does.
//
// It has to be the heading's whole title and not a phrase inside it. Matching
// 「市場情緒」 alone was enough to make 2026-09-18 skip its lead news section,
// which is headed 「全球宏觀經濟：聯儲局與日銀同步緊縮，市場情緒兩極」 — the words
// are there, describing the news rather than naming a section of outlook. This
// fails closed: an unrecognised variant means the toggle does not appear, which
// costs two minutes of listening, where the other way round loses the news.
const OUTLOOK_HEADING = /^.{0,4}市場情緒展望$/;

function isOutlookHeading(text) {
  return OUTLOOK_HEADING.test(text.trim().replace(/[（(][^）)]*[）)]\s*$/, '').trim());
}

/**
 * The market-outlook tail: a heading, and everything under it.
 *
 * It is the one part of the digest whose *shape* repeats daily — four markets,
 * each with 方向 / 驅動因素 / 風險 / 信心水平 — and it runs 12–25% of the read.
 * The words inside it do change with the numbers, so this is offered as a
 * choice rather than taken away: it is skippable, not stale.
 *
 * Bounded by the next heading at the same level or above, not by the end of the
 * document, so a day that puts something after the outlook keeps it.
 */
export function outlookRange(blocks = []) {
  for (let i = 1; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (!isHeading(block) || block.kind === 'h1') continue;
    if (!isOutlookHeading(textOf(block))) continue;
    let to = blocks.length;
    for (let j = i + 1; j < blocks.length; j += 1) {
      if (isHeading(blocks[j]) && blocks[j].kind <= block.kind) { to = j; break; }
    }
    return { from: i, to };
  }
  return null;
}

/** How much of each block a cut takes: all of it, its opening sentence, or none. */
function decide(blocks, cut, lead) {
  return blocks.map((block, i) => {
    if (cut === 'full' || i < lead) return 'all';
    if (cut === 'quick') return 'none';
    if (isHeading(block)) return 'all';                     // 提要 keeps the spine
    return isHeading(blocks[i - 1]) ? 'first' : 'none';     // ...and one sentence under it
  });
}

/**
 * Cut `blocks` down to `cut`, and say what was left behind.
 *
 * `pieces` is the document in order: a `block` piece renders and is read, a
 * `gap` piece is the line that admits how many sentences went missing there.
 * The gaps are the point — a shortened read that hides its own edges is a read
 * you cannot trust to have told you everything.
 *
 * `segments` is the playback queue, renumbered from zero, so the page's
 * sentence spans and the player's index stay the same number as ever.
 */
export function planCut(blocks = [], { cut = 'full', skipOutlook = false } = {}) {
  const lead = leadEnd(blocks);
  const outlook = outlookRange(blocks);
  const taken = decide(blocks, isCut(cut) ? cut : 'full', lead);

  const pieces = [];
  const kept = [];
  let gapBlocks = 0;
  let gapSentences = 0;

  const flushGap = () => {
    if (!gapSentences) return;
    pieces.push({ type: 'gap', blocks: gapBlocks, sentences: gapSentences });
    gapBlocks = 0;
    gapSentences = 0;
  };

  blocks.forEach((block, i) => {
    const inOutlook = outlook && i >= outlook.from && i < outlook.to;
    const how = skipOutlook && inOutlook ? 'none' : taken[i];
    if (how === 'none') {
      gapBlocks += 1;
      gapSentences += block.segments.length;
      return;
    }
    flushGap();
    const shown = how === 'first' ? { ...block, segments: block.segments.slice(0, 1) } : block;
    pieces.push({ type: 'block', index: i, block: shown });
    kept.push(shown);
    // A trimmed block leaves its own tail behind, and the gap line for it
    // belongs after the sentence that was kept, not before it.
    if (how === 'first') {
      gapBlocks += 1;
      gapSentences += block.segments.length - 1;
    }
  });
  flushGap();

  const sentences = blocks.reduce((total, block) => total + block.segments.length, 0);
  const heard = kept.reduce((total, block) => total + block.segments.length, 0);
  return {
    cut: isCut(cut) ? cut : 'full',
    pieces,
    blocks: kept,
    segments: toSegments(kept),
    outlook,
    dropped: { blocks: blocks.length - kept.length, sentences: sentences - heard },
  };
}

/**
 * How long each cut would run, for the picker's labels.
 *
 * Every cut is planned in full rather than estimated from a share of the whole,
 * because the lead is a tenth of the sentences and nothing like a tenth of any
 * other measure — the point of the picker is that the three numbers are real.
 */
export function cutDurations(blocks = [], { rate = 1, skipOutlook = false, charsPerSecond } = {}) {
  return CUTS.map(({ id, label, hint }) => ({
    id,
    label,
    hint,
    seconds: estimateSeconds(planCut(blocks, { cut: id, skipOutlook }).segments, rate, charsPerSecond),
  }));
}

/** Seconds the outlook tail costs, so the toggle can price itself. */
export function outlookSeconds(blocks = [], rate = 1, charsPerSecond) {
  const range = outlookRange(blocks);
  if (!range) return 0;
  const tail = blocks.slice(range.from, range.to);
  return estimateSeconds(toSegments(tail), rate, charsPerSecond);
}
