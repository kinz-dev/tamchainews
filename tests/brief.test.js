import assert from 'node:assert/strict';
import test from 'node:test';
import { prepare, estimateSeconds } from '../web/speech.js';
import { briefing, briefQueue, describeBrief, BRIEFS } from '../web/brief.js';

// A day shaped like a real one: a short 標題 + 【本報訊】 lead, then sections
// several times its length. The lead is what a briefing takes.
const dayText = (n) => [
  `# 第 ${n} 日頭條`,
  '',
  `**【本報訊】** 第 ${n} 日導語一句。導語第二句。導語第三句。`,
  '',
  '## 分節',
  '',
  '正文一句。'.repeat(1) + '正文二句。'.repeat(20),
].join('\n');

const days = [4, 3, 2, 1].map((n) => ({ day: `2026-09-0${n}`, text: dayText(n) }));

const blocksFor = (day) => prepare(day.text).blocks;
const estimate = (segments) => estimateSeconds(segments, 1);

/** Everything unheard unless named. */
function states(heard = {}) {
  return (day) => heard[day.day] || 'new';
}

test('a briefing takes the leads of days you have not started, newest first', () => {
  const brief = briefing(days, { seconds: 240, stateFor: states(), blocksFor, estimate });
  assert.ok(brief.parts.length >= 2);
  assert.deepEqual(brief.parts.map((p) => p.day.day).slice(0, 2), ['2026-09-04', '2026-09-03']);
  for (const part of brief.parts) {
    const text = part.segments.map((s) => s.text).join('');
    assert.ok(text.includes('【本報訊】'), 'a part is that day lead');
    assert.ok(!text.includes('正文二句'), 'and not its body');
  }
});

test('it reaches the length asked for rather than stopping short of it', () => {
  // A budget the fixture can actually reach: four leads run about 45s, so 25
  // is inside the material and the rule is what is being tested, not the
  // archive running out. (That case is 'short', below.)
  const brief = briefing(days, { seconds: 25, stateFor: states(), blocksFor, estimate });
  assert.ok(brief.seconds >= 25, 'the smallest set that reaches the budget');
  assert.ok(!brief.short);
  // ...and never more than one lead past it.
  const withoutLast = brief.seconds - brief.parts.at(-1).seconds;
  assert.ok(withoutLast < 25, 'one lead past the line at most');
  assert.ok(brief.parts.length < days.length, 'it stopped once it had enough');
});

test('a day already finished is not read to you again', () => {
  const brief = briefing(days, {
    seconds: 600,
    stateFor: states({ '2026-09-04': 'listened', '2026-09-03': 'listened' }),
    blocksFor,
    estimate,
  });
  assert.deepEqual(brief.parts.map((p) => p.day.day), ['2026-09-02', '2026-09-01']);
  assert.equal(brief.skipped, 2);
});

test('a day you are part way through is one whose lead you have heard', () => {
  // Playback starts at the top, so "partial" means the lead is behind you.
  // Including it would read the same two paragraphs again, which is the
  // complaint this feature exists to answer.
  const brief = briefing(days, {
    seconds: 600,
    stateFor: states({ '2026-09-04': 'partial' }),
    blocksFor,
    estimate,
  });
  assert.ok(!brief.parts.some((p) => p.day.day === '2026-09-04'));
});

test('nothing new and not enough new are different sentences', () => {
  const all = Object.fromEntries(days.map((d) => [d.day, 'listened']));
  const nothing = briefing(days, { seconds: 240, stateFor: states(all), blocksFor, estimate });
  assert.ok(nothing.empty);
  assert.ok(!nothing.short, 'empty is not "short"; it is good news');
  assert.equal(nothing.seconds, 0);

  const notEnough = briefing(days.slice(0, 1), { seconds: 3600, stateFor: states(), blocksFor, estimate });
  assert.ok(!notEnough.empty);
  assert.ok(notEnough.short, 'there was material, just not the minutes asked for');
  assert.ok(notEnough.seconds < 3600);
});

test('the queue is flat, renumbered, and each segment knows its day', () => {
  const brief = briefing(days, { seconds: 240, stateFor: states(), blocksFor, estimate });
  const queue = briefQueue(brief);
  assert.equal(queue.length, brief.parts.reduce((n, p) => n + p.segments.length, 0));
  queue.forEach((segment, i) => assert.equal(segment.index, i));

  const first = brief.parts[0];
  assert.equal(queue[0].briefDay, first.day);
  assert.equal(queue[0].briefAt, 0);
  // The day total is the whole day, not the lead: finishing a part records the
  // fraction of that day it really is, not a day completed.
  assert.ok(queue[0].briefTotal > first.segments.length);

  const second = queue.find((s) => s.briefDay !== first.day);
  assert.equal(second.briefAt, 0, 'each day part starts its own count again');
});

test('an empty archive briefs nothing without throwing', () => {
  const brief = briefing([], { seconds: 240, stateFor: states(), blocksFor, estimate });
  assert.ok(brief.empty);
  assert.deepEqual(briefQueue(brief), []);
  assert.equal(describeBrief(brief, () => '0:00'), '');
});

test('a day with no text contributes nothing rather than an empty part', () => {
  const broken = [{ day: '2026-09-09', text: '' }, ...days];
  const brief = briefing(broken, { seconds: 120, stateFor: states(), blocksFor, estimate });
  assert.ok(brief.parts.every((p) => p.segments.length > 0));
  assert.ok(!brief.parts.some((p) => p.day.day === '2026-09-09'));
});

test('the two lengths on offer are a morning and an evening', () => {
  assert.deepEqual(BRIEFS.map((b) => b.seconds), [240, 600]);
  const brief = briefing(days, { seconds: 240, stateFor: states(), blocksFor, estimate });
  assert.match(describeBrief(brief, (s) => `${Math.round(s)}s`), /^\d+ 日 · \d+s$/);
});
