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

export function normalizeForSpeech(text) {
  let out = text;
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

function makeBlock(kind, indent, text, maxChars) {
  const pieces = kind.startsWith('h') ? [text] : splitSentences(text, maxChars);
  return {
    kind,
    indent,
    segments: pieces.map((piece) => ({ text: piece, speak: normalizeForSpeech(piece) })),
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
