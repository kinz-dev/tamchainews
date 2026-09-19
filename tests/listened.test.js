import assert from 'node:assert/strict';
import test from 'node:test';
import {
  idFor, makeRecord, stateOf, ratioOf, percentOf, advance, tally, DONE_RATIO,
  makeCheckpoint, isResumable, RESUME_MAX_AGE_MS, resumePoint, parseDailyId,
  kindOf, nextPlayable, isLeaf, containedBy, allContainedHeard,
  digestListenIds, anyUnheard,
  boredTopics, noteSkip, prefsForTopic, rememberTopicPrefs, BORED_AFTER,
} from '../web/listened.js';

test('ids are stable and distinguish the thing being listened to', () => {
  assert.equal(idFor.digestHighlights(75), 'digest:75:highlights');
  assert.equal(idFor.digestTopic(75, 'AI'), 'digest:75:topic:AI');
  assert.equal(idFor.digestChannel(75, 'r/technology'), 'digest:75:channel:r/technology');
  assert.equal(idFor.daily('2026-09-16'), 'daily:2026-09-16');
  // Two channels in the same digest must not collide.
  assert.notEqual(idFor.digestChannel(75, 'a'), idFor.digestChannel(75, 'b'));
  // Nor the same channel across digests.
  assert.notEqual(idFor.digestChannel(75, 'a'), idFor.digestChannel(76, 'a'));
});

test('a re-run of a scheduled task is a different item', () => {
  assert.notEqual(idFor.task('983ec834e7dc', 1789664993), idFor.task('983ec834e7dc', 1789751393));
  assert.equal(idFor.task('abc'), 'task:abc:0');
});

test('stateOf reads the three states', () => {
  assert.equal(stateOf(undefined), 'new');
  assert.equal(stateOf(makeRecord({ id: 'x' })), 'new');
  assert.equal(stateOf(makeRecord({ id: 'x', segment: 3, total: 10 })), 'partial');
  assert.equal(stateOf(makeRecord({ id: 'x', done: true })), 'listened');
});

test('ratio counts the segment just spoken, and a finished item is always whole', () => {
  assert.equal(ratioOf(makeRecord({ id: 'x', segment: 4, total: 10 })), 0.5);
  assert.equal(percentOf(makeRecord({ id: 'x', segment: 4, total: 10 })), 50);
  assert.equal(ratioOf(makeRecord({ id: 'x', done: true, segment: 0, total: 0 })), 1);
  assert.equal(ratioOf(undefined), 0);
  assert.equal(ratioOf(makeRecord({ id: 'x', segment: 5, total: 0 })), 0);
});

test('advance marks done once past the threshold', () => {
  const total = 20;
  const nearly = advance(undefined, { segment: Math.floor(total * DONE_RATIO) - 2, total });
  assert.equal(nearly.done, false);
  const finished = advance(nearly, { segment: total - 1, total });
  assert.equal(finished.done, true);
});

test('advance never moves progress backwards', () => {
  const far = advance(undefined, { segment: 12, total: 20 });
  const rewound = advance(far, { segment: 2, total: 20 });
  assert.equal(rewound.segment, 12, 'scrubbing back keeps the furthest point');
});

test('re-listening to a finished item does not un-finish it', () => {
  const done = advance(undefined, { segment: 19, total: 20 });
  assert.equal(done.done, true);
  const again = advance(done, { segment: 0, total: 20 });
  assert.equal(again.done, true);
});

test('advance keeps the title once it has one', () => {
  const first = advance(undefined, { segment: 1, total: 10, title: 'r/technology' });
  const later = advance(first, { segment: 2, total: 10, title: '' });
  assert.equal(later.title, 'r/technology');
});

test('tally splits what is on screen three ways', () => {
  const records = new Map([
    ['a', makeRecord({ id: 'a', done: true })],
    ['b', makeRecord({ id: 'b', segment: 2, total: 10 })],
  ]);
  assert.deepEqual(tally(['a', 'b', 'c'], records), {
    total: 3, listened: 1, partial: 1, unheard: 1,
  });
  assert.deepEqual(tally([], records), { total: 0, listened: 0, partial: 0, unheard: 0 });
});

test('a checkpoint carries the text, so resuming needs no network', () => {
  const cp = makeCheckpoint({ id: 'daily:2026-09-16', title: '聯儲局加息', text: '第一句。第二句。', segment: 3, total: 40 });
  assert.equal(cp.key, 'current');
  assert.equal(cp.text, '第一句。第二句。');
  assert.equal(cp.segment, 3);
  assert.ok(cp.at > 0);
});

test('isResumable rejects the checkpoints that are not worth offering', () => {
  const base = { id: 'x', text: '一句。', segment: 3, total: 40, at: Date.now() };
  assert.equal(isResumable({ ...base }), true);
  assert.equal(isResumable(null), false, 'nothing saved');
  assert.equal(isResumable({ ...base, text: '' }), false, 'no text to replay');
  assert.equal(isResumable({ ...base, id: '' }), false, 'nothing to attribute it to');
  assert.equal(isResumable({ ...base, total: 0 }), false, 'no length');
  // Opening a page parks the player at the top; that is not somewhere to return to,
  // and treating it as one is how a real position got overwritten.
  assert.equal(isResumable({ ...base, segment: 0 }), false, 'the very start');
  assert.equal(isResumable({ ...base, segment: 40 }), false, 'it already finished');
  assert.equal(isResumable({ ...base, at: Date.now() - RESUME_MAX_AGE_MS - 1 }), false, 'too old');
  assert.equal(isResumable({ ...base, at: Date.now() - RESUME_MAX_AGE_MS + 1000 }), true, 'just inside the window');
});

test('parseDailyId pulls the day out, and ignores other kinds', () => {
  assert.equal(parseDailyId('daily:2026-09-16'), '2026-09-16');
  assert.equal(parseDailyId('digest:75:channel:r/technology'), '');
  assert.equal(parseDailyId(''), '');
  assert.equal(parseDailyId(undefined), '');
});

test('resumePoint prefers the checkpoint for this item', () => {
  const cp = { id: 'daily:2026-09-16', text: '一。', segment: 12, total: 69, at: Date.now() };
  const rec = makeRecord({ id: 'daily:2026-09-16', segment: 40, total: 69 });
  assert.equal(resumePoint(cp, rec, 'daily:2026-09-16'), 12, 'exact stopping point wins');
});

test('resumePoint falls back to the furthest point when the checkpoint is elsewhere', () => {
  const cp = { id: 'daily:2026-09-15', text: '一。', segment: 12, total: 69, at: Date.now() };
  const rec = makeRecord({ id: 'daily:2026-09-16', segment: 40, total: 69 });
  assert.equal(resumePoint(cp, rec, 'daily:2026-09-16'), 40);
});

test('resumePoint starts a finished item over, and copes with nothing stored', () => {
  const done = makeRecord({ id: 'x', segment: 60, total: 69, done: true });
  assert.equal(resumePoint(null, done, 'x'), 0, 'nothing left to resume');
  assert.equal(resumePoint(null, undefined, 'x'), 0);
  assert.equal(resumePoint(null, makeRecord({ id: 'x' }), 'x'), 0);
});

test('resumePoint ignores a checkpoint that has gone stale', () => {
  const stale = { id: 'x', text: '一。', segment: 12, total: 69, at: Date.now() - RESUME_MAX_AGE_MS - 1 };
  assert.equal(resumePoint(stale, undefined, 'x'), 0);
});

test('resumePoint drops a position recorded against a queue of another length', () => {
  const cp = { id: 'daily:2026-09-16', text: '一。', segment: 40, total: 69, at: Date.now() };
  const rec = makeRecord({ id: 'daily:2026-09-16', segment: 40, total: 69 });
  // The same day read at 快讀 is fourteen sentences, not sixty-nine: index 40
  // is not a shorter way of saying the same place, it is off the end of it.
  assert.equal(resumePoint(cp, rec, 'daily:2026-09-16', { total: 14 }), 0);
  assert.equal(resumePoint(cp, rec, 'daily:2026-09-16', { total: 69 }), 40, 'same queue, same place');
  assert.equal(resumePoint(cp, rec, 'daily:2026-09-16'), 40, 'no length given, nothing to check against');
});

test('resumePoint still resumes a record that never stored a length', () => {
  const rec = makeRecord({ id: 'x', segment: 9 });
  assert.equal(rec.total, 0);
  assert.equal(resumePoint(null, rec, 'x', { total: 14 }), 9, 'an old record is not a wrong one');
});

test('kindOf tells the granularities apart', () => {
  assert.equal(kindOf('digest:75:highlights'), 'highlights');
  assert.equal(kindOf('digest:75:topic:AI'), 'topic');
  assert.equal(kindOf('digest:75:channel:r/technology'), 'channel');
  assert.equal(kindOf('task:abc:123'), 'task');
  assert.equal(kindOf('daily:2026-09-16'), 'daily');
  assert.equal(kindOf('something-else'), '');
  // A channel literally named "highlights" must not be mistaken for the section.
  assert.equal(kindOf('digest:75:channel:highlights'), 'channel');
  assert.equal(kindOf('digest:75:topic:highlights'), 'topic');
});

test('nextPlayable skips what has been heard', () => {
  const playables = [
    { id: 'digest:75:channel:a' },
    { id: 'digest:75:channel:b' },
    { id: 'digest:75:channel:c' },
  ];
  const records = new Map([['digest:75:channel:b', makeRecord({ id: 'digest:75:channel:b', done: true })]]);
  assert.equal(nextPlayable(playables, 'digest:75:channel:a', records).id, 'digest:75:channel:c');
});

test('nextPlayable crosses kinds, so a run does not stop at a group boundary', () => {
  const playables = [
    { id: 'digest:75:channel:b' },
    { id: 'digest:74:highlights' },
    { id: 'digest:74:channel:a' },
    { id: 'task:t:1' },
  ];
  // Last channel of one digest -> the next digest's highlights, not a dead end.
  assert.equal(nextPlayable(playables, 'digest:75:channel:b', new Map()).id, 'digest:74:highlights');
  assert.equal(nextPlayable(playables, 'digest:74:channel:a', new Map()).id, 'task:t:1');
});

test('nextPlayable never chains into a topic clip', () => {
  // A topic clip is its channels read end to end; landing on it would repeat
  // what the channels just said.
  const playables = [
    { id: 'digest:75:channel:a' },
    { id: 'digest:75:topic:UK' },
    { id: 'digest:75:channel:b', parentId: 'digest:75:topic:UK' },
  ];
  assert.equal(nextPlayable(playables, 'digest:75:channel:a', new Map()).id, 'digest:75:channel:b');
  assert.equal(isLeaf('digest:75:topic:UK'), false);
  assert.equal(isLeaf('digest:75:channel:b'), true);
  assert.equal(isLeaf('digest:75:highlights'), true);
  assert.equal(isLeaf('task:t:1'), true);
  assert.equal(isLeaf('daily:2026-09-16'), true);
});

test('a topic counts as heard once all of its channels are', () => {
  const playables = [
    { id: 'digest:75:channel:a', parentId: 'digest:75:topic:UK' },
    { id: 'digest:75:channel:b', parentId: 'digest:75:topic:UK' },
  ];
  const records = new Map([['digest:75:channel:a', makeRecord({ id: 'digest:75:channel:a', done: true })]]);
  assert.equal(containedBy(playables, 'digest:75:topic:UK').length, 2);
  assert.equal(allContainedHeard(playables, 'digest:75:topic:UK', records), false);
  records.set('digest:75:channel:b', makeRecord({ id: 'digest:75:channel:b', done: true }));
  assert.equal(allContainedHeard(playables, 'digest:75:topic:UK', records), true);
  // An empty topic is not "all heard" — there was nothing to hear.
  assert.equal(allContainedHeard(playables, 'digest:75:topic:NONE', records), false);
});

test('nextPlayable returns null only when nothing unheard is left', () => {
  const playables = [{ id: 'digest:75:channel:a' }, { id: 'digest:75:channel:b' }];
  const allHeard = new Map(playables.map((p) => [p.id, makeRecord({ id: p.id, done: true })]));
  assert.equal(nextPlayable(playables, 'digest:75:channel:a', allHeard), null);
  assert.equal(nextPlayable(playables, 'digest:75:channel:b', new Map()), null);
  assert.equal(nextPlayable(playables, 'not-on-this-page', new Map()), null);
});

test('nextPlayable treats part-heard as still to play', () => {
  const playables = [{ id: 'digest:75:channel:a' }, { id: 'digest:75:channel:b' }];
  const partial = new Map([['digest:75:channel:b', makeRecord({ id: 'digest:75:channel:b', segment: 3, total: 10 })]]);
  assert.equal(nextPlayable(playables, 'digest:75:channel:a', partial).id, 'digest:75:channel:b');
});

// ------------------------------------------------------------ what's new

const SHAPED = {
  id: '92',
  highlights: '重點內容',
  topics: [
    { topic: 'Science', channels: [{ channel: 'Physics World', summary: '一' }] },
    { topic: 'Sport', channels: [{ channel: 'BBC Sport', summary: '二' }] },
  ],
};

test('a digest answers for its highlights and topics, not its channels', () => {
  // Channels roll up: playing a topic marks them heard and hearing them all
  // marks the topic, so counting both would keep a fully-heard digest lit.
  assert.deepEqual(digestListenIds(SHAPED), [
    'digest:92:highlights',
    'digest:92:topic:Science',
    'digest:92:topic:Sport',
  ]);
});

test('a digest with no highlights contributes only its topics', () => {
  assert.deepEqual(digestListenIds({ id: '7', highlights: '', topics: [{ topic: 'AI', channels: [] }] }),
                   ['digest:7:topic:AI']);
  assert.deepEqual(digestListenIds({ id: '7', highlights: '' }), []);
});

test('the badge clears only once every recent block is finished', () => {
  const ids = digestListenIds(SHAPED);
  const records = new Map();
  assert.equal(anyUnheard(ids, records), true, 'nothing heard yet');

  for (const id of ids) records.set(id, makeRecord({ id, done: true }));
  assert.equal(anyUnheard(ids, records), false, 'all heard');

  // Part-heard is not heard: you have not finished it, so it still counts.
  records.set('digest:92:topic:Sport', makeRecord({ id: 'digest:92:topic:Sport', segment: 3, total: 10 }));
  assert.equal(anyUnheard(ids, records), true);
});

test('nothing recent means nothing to flag', () => {
  assert.equal(anyUnheard([], new Map()), false);
  assert.equal(anyUnheard(), false);
});


// -------------------------------------------------------------- boredom signal

test('a topic skipped three times running is boring', () => {
  let skips = {};
  for (let i = 0; i < BORED_AFTER; i += 1) skips = noteSkip(skips, 'AI');
  assert.deepEqual(boredTopics(skips), ['AI']);
});

test('two skips are not enough', () => {
  const skips = noteSkip(noteSkip({}, 'AI'), 'AI');
  assert.deepEqual(boredTopics(skips), []);
});

test('finishing one clears the streak', () => {
  // Otherwise a topic you mostly want gets demoted by one dull morning.
  let skips = {};
  for (let i = 0; i < BORED_AFTER; i += 1) skips = noteSkip(skips, 'AI');
  skips = noteSkip(skips, 'AI', true);
  assert.deepEqual(boredTopics(skips), []);
});

test('topics are counted apart', () => {
  let skips = {};
  for (let i = 0; i < BORED_AFTER; i += 1) skips = noteSkip(skips, 'AI');
  skips = noteSkip(skips, '財經');
  assert.deepEqual(boredTopics(skips), ['AI']);
});

test('noteSkip does not mutate what it was given', () => {
  const before = { AI: 1 };
  noteSkip(before, 'AI');
  assert.deepEqual(before, { AI: 1 });
});

test('a skip with no topic changes nothing', () => {
  assert.deepEqual(noteSkip({ AI: 1 }, ''), { AI: 1 });
});

// ------------------------------------------------------------ per-topic voice

test('a topic falls back to the global voice until it has its own', () => {
  const fallback = { voiceId: 'web:Sinji', rate: 1 };
  assert.deepEqual(prefsForTopic({}, '財經', fallback), fallback);
});

test('a remembered topic keeps its own voice and rate', () => {
  const prefs = rememberTopicPrefs({}, '財經', { voiceId: 'server:WanLung', rate: 1.3 });
  assert.deepEqual(
    prefsForTopic(prefs, '財經', { voiceId: 'web:Sinji', rate: 1 }),
    { voiceId: 'server:WanLung', rate: 1.3 },
  );
});

test('one topic does not borrow another topic settings', () => {
  const prefs = rememberTopicPrefs({}, '財經', { voiceId: 'server:WanLung', rate: 1.3 });
  assert.equal(prefsForTopic(prefs, 'AI', { voiceId: 'web:Sinji', rate: 1 }).rate, 1);
});
