import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeForSpeech,
  parseLexicon,
  setUserLexicon,
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

test('the estimate scales the gaps too, the way the player does', () => {
  // The player shortens each pause by the rate (_gap divides by it), so a 2x
  // estimate should be half the 1x one — not half the speech plus full pauses.
  const { segments } = prepare('一句話。'.repeat(20));
  const single = estimateSeconds(segments, 1);
  for (const rate of [1.75, 2]) {
    assert.ok(
      Math.abs(estimateSeconds(segments, rate) - single / rate) < 1e-9,
      `rate ${rate} should be exactly 1/${rate} of the 1x estimate`,
    );
  }
});

test('empty input yields nothing to play', () => {
  assert.deepEqual(prepare('   \n\n  ').segments, []);
});

test('citations are shown but not spoken, so screen and voice stay in step', () => {
  const { segments } = prepare('眾議院通過法案 [1]，加州簽署新法 [23]。');
  const [only] = segments;
  // What the page prints keeps the markers, which are links to the articles...
  assert.match(only.text, /\[1\]/);
  assert.match(only.text, /\[23\]/);
  // ...while the voice never reads them out.
  assert.doesNotMatch(only.speak, /\[\d+\]/);
  assert.equal(only.speak, '眾議院通過法案，加州簽署新法。');
});


// ---------------------------------------------------------------- user lexicon

test('lexicon rules are one per line, with notes and rubbish ignored', () => {
  assert.deepEqual(
    parseLexicon('# 我的讀音\nNVDA=英偉達\n\n  恒指 = 恆生指數  \nno equals\n=empty key'),
    [['NVDA', '英偉達'], ['恒指', '恆生指數']],
  );
});

test('longer rules sort first so a short one cannot eat them', () => {
  assert.deepEqual(parseLexicon('GDP=甲\nUS GDP=乙').map(([k]) => k), ['US GDP', 'GDP']);
});

test('a reader rule beats the built-in table', () => {
  setUserLexicon(parseLexicon('Fed=美聯儲'));
  assert.equal(normalizeForSpeech('Fed 宣布加息'), '美聯儲 宣布加息');
  setUserLexicon([]);
  assert.equal(normalizeForSpeech('Fed 宣布加息'), '聯儲局 宣布加息');
});

test('a Latin rule respects word boundaries', () => {
  setUserLexicon(parseLexicon('AI=人工智能'));
  assert.equal(normalizeForSpeech('AI 晶片'), '人工智能 晶片');
  assert.equal(normalizeForSpeech('SAID 一句'), 'SAID 一句');   // not S人工智能D
  setUserLexicon([]);
});

test('a Chinese rule applies although \\b would never match it', () => {
  setUserLexicon(parseLexicon('恒指=恆生指數'));
  assert.equal(normalizeForSpeech('恒指升穿'), '恆生指數升穿');
  setUserLexicon([]);
});

test('regex metacharacters in a rule are literal, not a pattern', () => {
  setUserLexicon(parseLexicon('S&P 500=標普五百'));
  assert.equal(normalizeForSpeech('S&P 500 創新高'), '標普五百 創新高');
  setUserLexicon(parseLexicon('a.c=X'));
  assert.equal(normalizeForSpeech('abc'), 'abc');   // '.' is not "any character"
  setUserLexicon([]);
});

test('citations are still dropped with a lexicon loaded', () => {
  setUserLexicon(parseLexicon('NVDA=英偉達'));
  assert.equal(normalizeForSpeech('NVDA 領先[12]'), '英偉達 領先');
  setUserLexicon([]);
});
