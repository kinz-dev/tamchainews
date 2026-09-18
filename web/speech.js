// Turns a digest's Markdown into blocks of speakable segments.
//
// Two jobs that pull in opposite directions: the page wants the structure kept
// (headings, bullets) while the speech engine wants short, marker-free chunks.
// So blocks carry the structure and each block holds the segments that make it up.

const MAX_SEGMENT_CHARS = 90;  // ~20s of speech: long enough to read naturally, short enough to dodge Chrome's utterance cut-off
const SENTENCE_END = /(?<=[。！？])/;
const CLAUSE_END = /(?<=[，、；：])/;

// Only the substitutions that measurably help zh-HK voices. Latin names are left
// alone — the neural voices handle them better than any transliteration would.
export const PRONUNCIATION = [
  // "[12]" is a citation marker: on screen it is a link to the article, out
  // loud it is noise. Dropping it here rather than before segmentation keeps
  // `text` and `speak` two views of the same sentence, so the page can light
  // up the sentence being read.
  [/\s*\[\d{1,3}\]/g, ''],
  // The digests gloss acronyms as "聯邦儲備局（Fed）". The gloss is for readers;
  // spoken, it doubles every term up, so drop a parenthetical that is only Latin.
  [/(?<=[\u4e00-\u9fff》」』\uff09)])\s*[（(]\s*[A-Za-z][A-Za-z0-9.&'\- ]{0,19}\s*[）)]/g, ''],
  // "3.75%至4%" → "百分之3.75至百分之4"; Chinese puts the marker before the number.
  [/(\d+(?:\.\d+)?)\s*%/g, '百分之$1'],
  [/\bFOMC\b/g, '聯邦公開市場委員會'],
  [/\bFed\b/g, '聯儲局'],
  [/\bGDP\b/g, 'G D P'],
  [/\bAI\b/g, 'A I'],
  [/\bUS\$?\s*(\d)/g, '$1'],
  [/\$\s*(\d+(?:\.\d+)?)\s*(萬億|億|萬|千)?/g, (_, n, unit) => `${n}${unit || ''}美元`],
  [/\s*[·•]\s*/g, '，'],
];

// The reader's own corrections, layered over the table above. Tickers, English
// company names and 人名 are exactly what the built-in list refuses to guess at,
// and exactly what comes out as noise every morning — so they are worth a place
// the reader can edit rather than a patch to this file.
let userLexicon = [];

/**
 * Parse one rule per line, `說法=讀音`. A line starting with `#` is a note.
 *
 * Deliberately not regular expressions. The rules are typed into a text box by
 * someone who wants NVDA read properly, not a pattern language to get wrong, and
 * a stray `(` should not be able to silence the whole lexicon.
 */
export function parseLexicon(source = '') {
  const rules = [];
  for (const line of String(source).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at < 1) continue;
    const from = trimmed.slice(0, at).trim();
    const to = trimmed.slice(at + 1).trim();
    if (from) rules.push([from, to]);
  }
  // Longest first, so `US GDP` is not eaten by a rule for `GDP`.
  return rules.sort((a, b) => b[0].length - a[0].length);
}

export function setUserLexicon(rules) { userLexicon = rules || []; }

const ESCAPE = /[.*+?^${}()|[\]\\]/g;

function lexiconPattern(term) {
  const body = term.replace(ESCAPE, '\\$&');
  // A word boundary only means anything either side of Latin text; against 漢字
  // \b never matches, which would make a Chinese rule silently do nothing.
  const head = /^[A-Za-z0-9]/.test(term) ? '\\b' : '';
  const tail = /[A-Za-z0-9]$/.test(term) ? '\\b' : '';
  return new RegExp(`${head}${body}${tail}`, 'g');
}

export function normalizeForSpeech(text) {
  let out = text;
  // The reader's rules run first, so a correction wins over a built-in guess.
  for (const [from, to] of userLexicon) out = out.replace(lexiconPattern(from), to);
  for (const [pattern, replacement] of PRONUNCIATION) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, ' ').trim();
}

function stripInline(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')  // links/images → their label
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

/** Split one block of prose into chunks short enough for a single utterance. */
export function splitSentences(text, maxChars = MAX_SEGMENT_CHARS) {
  const out = [];
  for (const sentence of text.split(SENTENCE_END)) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (trimmed.length <= maxChars) {
      out.push(trimmed);
      continue;
    }
    // Long sentence: fall back to clause boundaries, then to a hard cut.
    let buffer = '';
    for (const clause of trimmed.split(CLAUSE_END)) {
      if (buffer && buffer.length + clause.length > maxChars) {
        out.push(buffer.trim());
        buffer = '';
      }
      if (clause.length > maxChars) {
        for (let i = 0; i < clause.length; i += maxChars) out.push(clause.slice(i, i + maxChars).trim());
        continue;
      }
      buffer += clause;
    }
    if (buffer.trim()) out.push(buffer.trim());
  }
  return out;
}

function classify(line) {
  let match = line.match(/^(#{1,6})\s+(.*)$/);
  if (match) return { kind: `h${Math.min(match[1].length, 3)}`, indent: 0, text: match[2] };
  match = line.match(/^(\s*)[*+-]\s+(.*)$/);
  if (match) return { kind: 'li', indent: Math.min(Math.floor(match[1].length / 2), 2), text: match[2] };
  return { kind: 'p', indent: 0, text: line };
}

/**
 * Markdown → [{kind, indent, segments:[{text, speak}]}].
 * `text` is what the page shows, `speak` is what the voice says.
 */
export function toBlocks(markdown, { maxChars = MAX_SEGMENT_CHARS } = {}) {
  const blocks = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = stripInline(paragraph.join(' '));
    paragraph = [];
    if (text) blocks.push(makeBlock('p', 0, text, maxChars));
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    const { kind, indent, text } = classify(line);
    if (kind === 'p') {
      paragraph.push(line.trim());
      continue;
    }
    flushParagraph();
    const clean = stripInline(text);
    if (clean) blocks.push(makeBlock(kind, indent, clean, maxChars));
  }
  flushParagraph();
  return blocks;
}

/**
 * Tag each piece `quote` or `body`, carrying the quote state across the split.
 *
 * Sentences break on 。！？, which falls inside a quotation as happily as
 * outside it — so a piece can begin in the middle of someone speaking, with no
 * 「 of its own to show for it. Walking the pieces in order and keeping the
 * depth is the only way the second half of a quote knows what it is.
 *
 * A piece counts as a quote when most of it is inside one, not merely when it
 * touches one: a sentence that ends by opening a quotation is still narration.
 */
export function tagQuotes(pieces) {
  let depth = 0;
  return pieces.map((piece) => {
    let inside = 0;
    for (const char of piece) {
      if (char === '「' || char === '『') { depth += 1; continue; }
      if (char === '」' || char === '』') { depth = Math.max(0, depth - 1); continue; }
      if (depth > 0) inside += 1;
    }
    const letters = [...piece].filter((c) => !'「」『』'.includes(c)).length;
    return { text: piece, role: letters && inside / letters > 0.5 ? 'quote' : 'body' };
  });
}

function makeBlock(kind, indent, text, maxChars) {
  const pieces = kind.startsWith('h') ? [text] : splitSentences(text, maxChars);
  return {
    kind,
    indent,
    segments: tagQuotes(pieces).map(({ text: piece, role }) => ({
      text: piece,
      role,
      speak: normalizeForSpeech(piece),
    })),
  };
}

/** Flatten blocks into the playback queue, numbering segments globally. */
export function toSegments(blocks) {
  const segments = [];
  blocks.forEach((block, blockIndex) => {
    block.segments.forEach((segment) => {
      segments.push({
        index: segments.length,
        blockIndex,
        kind: block.kind,
        // 'quote' or 'body' — the player reads quoted material in the second
        // voice, which is what makes a digest sound like two people rather
        // than one person reading a transcript aloud.
        role: segment.role || 'body',
        text: segment.text,
        speak: segment.speak,
        // speechSynthesis has no SSML, so pacing has to come from real gaps.
        pauseAfter: block.kind.startsWith('h') ? 550 : block.kind === 'li' ? 220 : 320,
      });
    });
  });
  return segments;
}

export function prepare(markdown, options) {
  const blocks = toBlocks(markdown, options);
  return { blocks, segments: toSegments(blocks) };
}

/**
 * Rough seconds per segment, used for the progress read-out.
 *
 * The gaps scale with the rate too — the player shortens them by the same
 * factor (`_gap` divides by rate), and at 2× the pauses are a big enough share
 * of the total that leaving them fixed overstates the running time.
 */
export function estimateSeconds(segments, rate = 1, charsPerSecond = 4.5) {
  return segments.reduce(
    (total, segment) =>
      total + segment.speak.length / (charsPerSecond * rate) + segment.pauseAfter / 1000 / rate,
    0,
  );
}
