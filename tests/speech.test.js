import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeForSpeech,
  prepare,
  splitSentences,
  toBlocks,
  toSegments,
  estimateSeconds,
} from '../web/speech.js';

test('headings, paragraphs and nested bullets keep their structure', () => {
  const blocks = toBlocks([
    '# 頭條標題',
    '',
    '第一段。第二段內容。',
    '',
    '## 分節標題',
    '',
    '*   **股票市場**',
    '    *   **方向**：下行壓力較大。',
  ].join('\n'));

  assert.deepEqual(blocks.map((b) => [b.kind, b.indent]), [
    ['h1', 0], ['p', 0], ['h2', 0], ['li', 0], ['li', 2],
  ]);
  assert.equal(blocks[3].segments[0].text, '股票市場');
  assert.equal(blocks[4].segments[0].text, '方向：下行壓力較大。');
});

test('consecutive lines join into one paragraph, blank lines break it', () => {
  const blocks = toBlocks('一行。\n二行。\n\n另一段。');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].segments.length, 2);
});

test('inline markdown is stripped from the displayed text', () => {
  const blocks = toBlocks('**粗體**與*斜體*與`程式碼`與[連結](http://x)。');
  assert.equal(blocks[0].segments[0].text, '粗體與斜體與程式碼與連結。');
});

test('sentences split on Chinese full stops', () => {
  assert.deepEqual(splitSentences('甲。乙！丙？'), ['甲。', '乙！', '丙？']);
});

test('an over-long sentence is broken at clause boundaries', () => {
  const long = `${'甲'.repeat(50)}，${'乙'.repeat(50)}，${'丙'.repeat(50)}。`;
  const parts = splitSentences(long, 90);
  assert.ok(parts.length >= 2);
  for (const part of parts) assert.ok(part.length <= 90, `segment too long: ${part.length}`);
  assert.equal(parts.join('').replace(/\s/g, ''), long.replace(/\s/g, ''));
});

test('a clause longer than the cap is hard-cut rather than dropped', () => {
  const parts = splitSentences('甲'.repeat(250), 90);
  assert.equal(parts.join(''), '甲'.repeat(250));
  for (const part of parts) assert.ok(part.length <= 90);
});

test('percentages are spoken the Chinese way, on both ends of a range', () => {
  assert.equal(normalizeForSpeech('上調至3.75%至4%'), '上調至百分之3.75至百分之4');
});

test('a Latin gloss in brackets is dropped from speech but kept on screen', () => {
  assert.equal(normalizeForSpeech('美國聯邦儲備局（Fed）宣布'), '美國聯邦儲備局宣布');
  assert.equal(normalizeForSpeech('股票市場（Equities）'), '股票市場');
  const blocks = toBlocks('美國聯邦儲備局（Fed）宣布。');
  assert.equal(blocks[0].segments[0].text, '美國聯邦儲備局（Fed）宣布。');
});

test('a bare acronym is still expanded', () => {
  assert.equal(normalizeForSpeech('Fed 主席表示'), '聯儲局 主席表示');
  assert.equal(normalizeForSpeech('FOMC 一致通過'), '聯邦公開市場委員會 一致通過');
});

test('non-Latin brackets survive', () => {
  assert.equal(normalizeForSpeech('《五年規劃（2026—2030）》'), '《五年規劃（2026—2030）》');
});

test('dollar amounts get a spoken currency unit', () => {
  assert.equal(normalizeForSpeech('估值達$1.2萬億'), '估值達1.2萬億美元');
});

test('segments are numbered globally and carry a pause', () => {
  const segments = toSegments(toBlocks('# 標題\n\n一句。兩句。'));
  assert.deepEqual(segments.map((s) => s.index), [0, 1, 2]);
  assert.deepEqual(segments.map((s) => s.blockIndex), [0, 1, 1]);
  assert.ok(segments[0].pauseAfter > segments[1].pauseAfter);
});

test('prepare keeps blocks and segments in step', () => {
  const { blocks, segments } = prepare('# 標題\n\n一句。兩句。\n\n*  項目。');
  assert.equal(segments.length, blocks.reduce((n, b) => n + b.segments.length, 0));
});

test('estimated duration scales down with a faster rate', () => {
  const { segments } = prepare('一句話。'.repeat(20));
  assert.ok(estimateSeconds(segments, 2) < estimateSeconds(segments, 1));
});

test('empty input yields nothing to play', () => {
  assert.deepEqual(prepare('   \n\n  ').segments, []);
});
