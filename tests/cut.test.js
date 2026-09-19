import assert from 'node:assert/strict';
import test from 'node:test';
import { prepare, estimateSeconds } from '../web/speech.js';
import {
  CUTS, isCut, nextCut, labelOf, leadEnd, outlookRange, planCut, cutDurations,
  outlookSeconds, textOf,
} from '../web/cut.js';

// The shape of a real 每日總覽, shortened: 標題, a 【本報訊】 lead of several
// sentences, topic sections of two paragraphs each, then the 市場情緒展望 tail
// whose four markets repeat their four labels every single day. `data/` is not
// in the repository, so the fixture carries the shape rather than the day.
const DIGEST = [
  '# 聯儲局三年來首次加息 華為晶片提前發布挑戰 Nvidia',
  '',
  '**【本報訊】** 美國聯邦儲備局於週四宣布將基準利率上調25個基點。與此同時，華為在上海發布新一代 AI 晶片。全球金融市場因聯儲局鷹派立場而波動。',
  '',
  '## 全球宏觀經濟與貨幣政策',
  '',
  '美國聯儲局在主席領導下一致通過加息。聯儲局暗示未來仍有加息空間。納斯達克指數反而抽升。',
  '',
  '英國方面，英倫銀行維持基準利率不變。英國8月通脹率升至3.1%。',
  '',
  '## 科技產業動態',
  '',
  '華為宣布將訓練晶片發布時間提前九個月。性能預計翻倍。',
  '',
  '## 市場情緒展望',
  '',
  '基於當前資訊，對未來數週市場情緒的展望如下：',
  '',
  '* 股票市場',
  '* 方向：震盪偏多。',
  '* 信心水平：中',
  '* 外匯市場',
  '* 方向：美元強勢。',
  '* 信心水平：高',
].join('\n');

const { blocks } = prepare(DIGEST);
const sentences = (plan) => plan.segments.length;
const allSentences = blocks.reduce((n, b) => n + b.segments.length, 0);

test('the lead is the title and everything above the first sub-heading', () => {
  assert.equal(leadEnd(blocks), 2);
  assert.match(textOf(blocks[0]), /聯儲局三年來首次加息/);
  assert.match(textOf(blocks[1]), /^【本報訊】/);
});

test('a digest with no sub-headings has no lead to separate, so 快讀 reads it all', () => {
  const flat = prepare('# 標題\n\n一句。兩句。三句。').blocks;
  assert.equal(leadEnd(flat), flat.length);
  const plan = planCut(flat, { cut: 'quick' });
  assert.equal(plan.dropped.sentences, 0, 'nothing to cut is not the same as cutting nothing');
  assert.equal(sentences(plan), flat.reduce((n, b) => n + b.segments.length, 0));
});

test('快讀 keeps the whole lead and nothing under it', () => {
  const plan = planCut(blocks, { cut: 'quick' });
  assert.deepEqual(plan.blocks.map(textOf), [textOf(blocks[0]), textOf(blocks[1])]);
  // Upstream writes the lead as a real summary, so 快讀 is several sentences.
  assert.ok(sentences(plan) >= 3, 'the lead is a paragraph, not a headline');
  assert.equal(plan.dropped.sentences, allSentences - sentences(plan));
});

test('提要 keeps the lead, every heading, and one sentence under each', () => {
  const plan = planCut(blocks, { cut: 'gist' });
  const kept = plan.blocks.map(textOf);
  assert.ok(kept.includes('全球宏觀經濟與貨幣政策'));
  assert.ok(kept.includes('科技產業動態'));
  // The first paragraph of a section is trimmed to its opening sentence...
  assert.ok(kept.some((text) => text === '美國聯儲局在主席領導下一致通過加息。'));
  // ...and the section's *second* paragraph is not read at all.
  assert.ok(!kept.some((text) => text.startsWith('英國方面')));
  assert.ok(sentences(plan) > sentences(planCut(blocks, { cut: 'quick' })));
  assert.ok(sentences(plan) < allSentences);
});

test('全文 is the read the app always had', () => {
  const plan = planCut(blocks, { cut: 'full' });
  assert.equal(sentences(plan), allSentences);
  assert.equal(plan.dropped.sentences, 0);
  assert.equal(plan.pieces.filter((piece) => piece.type === 'gap').length, 0);
});

test('an unknown cut reads everything rather than nothing', () => {
  const plan = planCut(blocks, { cut: 'ultra-brief' });
  assert.equal(plan.cut, 'full');
  assert.equal(sentences(plan), allSentences);
});

test('every dropped sentence is admitted to in a gap', () => {
  for (const cut of ['quick', 'gist']) {
    const plan = planCut(blocks, { cut });
    const owned = plan.pieces
      .filter((piece) => piece.type === 'gap')
      .reduce((total, gap) => total + gap.sentences, 0);
    assert.equal(owned, plan.dropped.sentences, `${cut} loses count of what it skipped`);
    assert.equal(owned + sentences(plan), allSentences, `${cut} does not add up`);
  }
});

test('a trimmed block reports its own tail as a gap after it, not before', () => {
  const plan = planCut(blocks, { cut: 'gist' });
  const at = plan.pieces.findIndex(
    (piece) => piece.type === 'block' && textOf(piece.block) === '美國聯儲局在主席領導下一致通過加息。',
  );
  assert.ok(at > 0);
  assert.equal(plan.pieces[at + 1].type, 'gap', 'the rest of the paragraph is behind this sentence');
});

test('the playback queue is renumbered from zero so the page can index it', () => {
  const plan = planCut(blocks, { cut: 'gist' });
  plan.segments.forEach((segment, i) => assert.equal(segment.index, i));
  assert.ok(plan.segments.every((segment) => segment.speak.length > 0));
});

test('the outlook tail runs from its heading to the end of the section', () => {
  const range = outlookRange(blocks);
  assert.ok(range);
  assert.equal(textOf(blocks[range.from]), '市場情緒展望');
  assert.equal(range.to, blocks.length);
  assert.ok(outlookSeconds(blocks) > 0);
});

test('the outlook heading is matched on the part of it that does not move', () => {
  for (const heading of ['市場情緒展望', '近期市場情緒展望', '近市市場情緒展望（未來數週）']) {
    const sample = prepare(`# 標題\n\n導語一句。\n\n## ${heading}\n\n* 方向：偏強\n`).blocks;
    assert.ok(outlookRange(sample), `${heading} should be recognised`);
  }
});

test('a news heading that merely talks about market sentiment is not the outlook', () => {
  // 2026-09-18, live: the lead section is headed like this, and matching the
  // phrase rather than the title skipped fifteen sentences of actual news.
  const newsy = [
    '全球宏觀經濟：聯儲局與日銀同步緊縮，市場情緒兩極',
    '市場情緒展望轉差 投資者離場',
    '美股造好 帶動市場情緒',
  ];
  for (const heading of newsy) {
    const sample = prepare(`# 標題\n\n導語一句。\n\n## ${heading}\n\n新聞一句。新聞兩句。`).blocks;
    assert.equal(outlookRange(sample), null, `${heading} is news, not the outlook`);
    assert.equal(
      planCut(sample, { cut: 'full', skipOutlook: true }).dropped.sentences, 0,
      'skipping the outlook must never eat a news section',
    );
  }
});

test('a section after the outlook survives skipping it', () => {
  const sample = prepare([
    '# 標題', '', '導語。', '',
    '## 市場情緒展望', '', '* 方向：偏強', '',
    '## 之後仲有嘢', '', '尾聲一句。',
  ].join('\n')).blocks;
  const range = outlookRange(sample);
  assert.equal(textOf(sample[range.to]), '之後仲有嘢');
  const plan = planCut(sample, { cut: 'full', skipOutlook: true });
  assert.ok(plan.blocks.map(textOf).includes('尾聲一句。'));
  assert.ok(!plan.blocks.map(textOf).includes('方向：偏強'));
});

test('a digest with no outlook section has none to skip', () => {
  const sample = prepare('# 標題\n\n導語。\n\n## 新聞\n\n一句。').blocks;
  assert.equal(outlookRange(sample), null);
  assert.equal(outlookSeconds(sample), 0);
  assert.deepEqual(
    planCut(sample, { cut: 'full', skipOutlook: true }).blocks.map(textOf),
    planCut(sample, { cut: 'full' }).blocks.map(textOf),
  );
});

test('skipping the outlook shortens every cut that reached it', () => {
  const full = planCut(blocks, { cut: 'full' });
  const trimmed = planCut(blocks, { cut: 'full', skipOutlook: true });
  assert.ok(sentences(trimmed) < sentences(full));
  // 快讀 never reaches the outlook, so the toggle cannot change it.
  assert.equal(
    sentences(planCut(blocks, { cut: 'quick', skipOutlook: true })),
    sentences(planCut(blocks, { cut: 'quick' })),
  );
});

test('the picker prices all three cuts, shortest first, at the reader own rate', () => {
  const durations = cutDurations(blocks, { rate: 1 });
  assert.deepEqual(durations.map((d) => d.id), CUTS.map((c) => c.id));
  assert.ok(durations[0].seconds < durations[1].seconds);
  assert.ok(durations[1].seconds < durations[2].seconds);
  const faster = cutDurations(blocks, { rate: 2 });
  assert.ok(faster[2].seconds < durations[2].seconds, 'a faster voice is a shorter read');
  assert.equal(
    Math.round(durations[2].seconds),
    Math.round(estimateSeconds(planCut(blocks, { cut: 'full' }).segments, 1)),
    'the label and the queue must be the same read',
  );
});

test('the cut ladder knows what comes next, and where it ends', () => {
  assert.equal(nextCut('quick').id, 'gist');
  assert.equal(nextCut('gist').id, 'full');
  assert.equal(nextCut('full'), null);
  assert.equal(nextCut('nonsense'), null);
  assert.equal(labelOf('quick'), '快讀');
  assert.ok(isCut('gist'));
  assert.ok(!isCut('gist '));
});

test('an empty digest plans to nothing without throwing', () => {
  const plan = planCut([], { cut: 'gist' });
  assert.deepEqual(plan.pieces, []);
  assert.equal(plan.segments.length, 0);
  assert.equal(plan.dropped.sentences, 0);
  assert.deepEqual(cutDurations([]).map((d) => d.seconds), [0, 0, 0]);
});
