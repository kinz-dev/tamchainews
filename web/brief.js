// 簡報 — a fixed length of what you have *not* heard.
//
// "Newest" is what every feed gives you, and it re-reads what you sat through
// yesterday. This picks by heard-state instead: the unheard days, newest first,
// each contributing its 【本報訊】 lead, until the minutes are used up.
//
// **Why this is in the browser and not in the nightly render.** The roadmap had
// it as a file rendered at 07:30 — "Day 3's render pass already walks the
// segments; this picks a different set and stops at a length". It cannot. What
// you have heard lives in this browser's IndexedDB and nowhere else; the box is
// never told, because being told would need accounts, which are parked on
// purpose. A file rendered on the box can only ever know what is *newest*,
// which is the thing this feature exists not to do.
//
// So the scheduled-file half of the idea is the podcast, which already reaches
// you without the page being open, and the heard-aware half is here, where the
// only copy of that knowledge is.
//
// **Why only days you have not started.** A day you are part-way through is a
// day whose lead you have already heard — playback starts at the top. Including
// it would read you the same two paragraphs again, which is the complaint.

import { planCut } from './cut.js';

export const BRIEFS = [
  { id: 'morning', label: '簡報', seconds: 240 },
  { id: 'evening', label: '長簡報', seconds: 600 },
];

/**
 * Build a briefing, or explain why it is short.
 *
 * Everything it needs from the rest of the app is injected — the blocks for a
 * day, the heard-state of a day, and how long a run of segments takes — so this
 * stays a pure function with a test beside it, the same shape as `cut.js` and
 * `feed.js`.
 *
 * Whole leads only: a lead is about ninety seconds, so a four-minute budget
 * takes the smallest set that *reaches* four minutes rather than the largest
 * that fits under it. Coming up a minute short of the time you asked for is
 * worse than running half a minute over, and the caller is told the real total
 * either way rather than the one that was asked for.
 */
export function briefing(days = [], {
  seconds = 240, stateFor, blocksFor, estimate,
} = {}) {
  const parts = [];
  let total = 0;
  let skipped = 0;

  for (const day of days) {
    if (total >= seconds) break;
    const state = stateFor(day);
    if (state !== 'new') {
      skipped += 1;
      continue;
    }
    const blocks = blocksFor(day);
    if (!blocks?.length) continue;
    const lead = planCut(blocks, { cut: 'quick' });
    if (!lead.segments.length) continue;
    const length = estimate(lead.segments);
    parts.push({
      day,
      segments: lead.segments,
      seconds: length,
      // What the whole day would be, so finishing this part can be recorded as
      // the real fraction of that day it is rather than as a day completed.
      dayTotal: planCut(blocks, { cut: 'full' }).segments.length,
    });
    total += length;
  }

  return {
    parts,
    seconds: total,
    wanted: seconds,
    // Told apart on purpose: nothing new at all is good news, and not enough
    // new is a different sentence.
    empty: parts.length === 0,
    short: parts.length > 0 && total < seconds,
    skipped,
  };
}

/**
 * The parts flattened into one queue, renumbered, each segment knowing its day.
 *
 * The player takes a flat list and an index; carrying `briefDay` on the segment
 * is what lets progress be written back to the right day as the briefing runs
 * through it.
 */
export function briefQueue(brief) {
  const queue = [];
  for (const part of brief.parts || []) {
    part.segments.forEach((segment, at) => {
      queue.push({
        ...segment,
        index: queue.length,
        briefDay: part.day,
        briefAt: at,
        briefTotal: part.dayTotal,
      });
    });
  }
  return queue;
}

/** 「3 日 · 4:32」 — what this briefing actually is, not what was asked for. */
export function describeBrief(brief, formatClock) {
  if (brief.empty) return '';
  return `${brief.parts.length} 日 · ${formatClock(brief.seconds)}`;
}
