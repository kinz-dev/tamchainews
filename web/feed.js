// Shapes the upstream monitor's JSON into what the page renders.
//
// Upstream hands back one flat `sections` array per digest, keyed by channel,
// with the topic repeated on every row. The page wants the opposite: topics as
// the spine, channels nested under them. Everything here is pure so the
// reshaping can be tested without a browser or a live upstream.

/** Upstream marks citations as "[3]" inside prose; items carry the matching `ref`. */
const REF_MARKER = /\[(\d{1,3})\]/g;

/** Digest → {id, checkedAt, posts, refs, topics: [{topic, channels: [...]}]}. */
export function shapeDigest(digest) {
  const sections = digest.sections || [];
  return {
    id: String(digest.check_id ?? ''),
    kind: digest.kind || 'channels',
    checkedAt: Number(digest.checked_at) || 0,
    posts: Number(digest.posts) || 0,
    refs: Number(digest.refs) || 0,
    highlights: (digest.highlights || []).join('\n\n'),
    topics: groupByTopic(sections),
  };
}

/**
 * Flat sections → topics, each holding its channels. Order of first appearance
 * is kept on both levels: upstream already sorts by relevance, and resorting
 * alphabetically would throw that away.
 */
export function groupByTopic(sections) {
  const topics = new Map();
  for (const section of sections) {
    const name = section.topic || '其他';
    if (!topics.has(name)) topics.set(name, { topic: name, channels: [], posts: 0 });
    const group = topics.get(name);
    const items = section.items || [];
    group.channels.push({
      channel: section.channel || '',
      summary: section.summary || '',
      items,
    });
    group.posts += items.length;
  }
  return [...topics.values()];
}

/**
 * Split prose on its "[n]" citations so the caller can render the markers as
 * links without ever putting upstream text through innerHTML.
 * Returns [{type: 'text'|'ref', value, item?}].
 */
export function splitRefs(text, items = []) {
  const byRef = new Map(items.map((item) => [Number(item.ref), item]));
  const parts = [];
  let cursor = 0;
  for (const match of text.matchAll(REF_MARKER)) {
    const ref = Number(match[1]);
    if (!byRef.has(ref)) continue;                     // a bracket that isn't a citation
    if (match.index > cursor) parts.push({ type: 'text', value: text.slice(cursor, match.index) });
    parts.push({ type: 'ref', value: String(ref), item: byRef.get(ref) });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ type: 'text', value: text.slice(cursor) });
  return parts;
}


/**
 * Which feeds are unhealthy, for the status strip.
 *
 * `ok: false` covers two different states that deserve different words: a feed
 * that has tried and failed, and one upstream has only just been given and has
 * not fetched yet — no attempts, no success, no error. Calling the second one
 * "失敗" sends you hunting for a breakage that isn't there.
 */
export function feedHealth(feeds = []) {
  const problems = feeds.filter((feed) => feed.ok === false).map((feed) => {
    const attempts = Number(feed.fetch_seq) || 0;
    const pending = !attempts && !feed.last_ok && !feed.last_error;
    return {
      name: feed.name || '(未命名)',
      state: pending ? 'pending' : 'failing',
      error: feed.last_error || '',
      lastOk: feed.last_ok || 0,
      errorAt: feed.error_at || 0,
      attempts,
    };
  });
  return {
    total: feeds.length,
    ok: feeds.length - problems.length,
    problems,
    failing: problems.filter((p) => p.state === 'failing'),
    pending: problems.filter((p) => p.state === 'pending'),
  };
}

/** One line summarising feed health, for the status strip. */
const DARK_AFTER_HOURS = 12;

/**
 * Feeds that have gone quiet without going wrong.
 *
 * `feedHealth` only knows about feeds upstream has marked `ok: false`. A feed
 * that last succeeded two days ago and has not been tried since is `ok: true`
 * and invisible — and that is the failure that matters, because nothing on the
 * page says so. The digests simply stop mentioning a source and the silence
 * reads as "nothing happened" rather than "nobody looked".
 */
export function darkFeeds(feeds = [], now = Date.now(), hours = DARK_AFTER_HOURS) {
  const cutoff = now / 1000 - hours * 3600;
  return feeds
    .filter((feed) => feed.ok !== false)
    .map((feed) => ({
      name: feed.name || '(未命名)',
      lastOk: Number(feed.last_ok) || 0,
      hours: (now / 1000 - (Number(feed.last_ok) || 0)) / 3600,
    }))
    // A feed that has never succeeded is `pending`, which feedHealth already
    // reports; counting it dark too would say the same thing twice.
    .filter((feed) => feed.lastOk > 0 && feed.lastOk < cutoff)
    .sort((a, b) => a.lastOk - b.lastOk);
}

export function darkSummary(dark, hours = DARK_AFTER_HOURS) {
  if (!dark.length) return '';
  if (dark.length === 1) return `${dark[0].name} 已經 ${Math.floor(dark[0].hours)} 小時無新內容`;
  return `${dark.length} 個訊源超過 ${hours} 小時無新內容`;
}

export function healthSummary(health) {
  const bits = [];
  if (health.failing.length) bits.push(`${health.failing.length} 個訊源失敗`);
  if (health.pending.length) bits.push(`${health.pending.length} 個訊源未抓取`);
  return bits.length ? bits.join('·') : `${health.ok} 個訊源正常`;
}

/** Topic chips, with the channel count upstream reports for each. */
/**
 * How much of a topic each channel actually contributes.
 *
 * The rail lists every channel equally, which makes a feed that writes two
 * lines a week look like one that writes the whole topic. Share is measured in
 * characters of summary, because that is what you spend time listening to.
 */
export function channelShare(sections = []) {
  const bytes = new Map();
  for (const section of sections) {
    const name = section.channel || section.name || '(未命名)';
    const size = (section.summary || section.text || '').length;
    bytes.set(name, (bytes.get(name) || 0) + size);
  }
  const total = [...bytes.values()].reduce((sum, n) => sum + n, 0);
  return [...bytes.entries()]
    .map(([name, chars]) => ({ name, chars, share: total ? chars / total : 0 }))
    .sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name));
}

export function topicCounts(topics = [], channelTopics = {}) {
  const counts = new Map();
  for (const topic of Object.values(channelTopics)) {
    for (const name of String(topic).split(',').map((t) => t.trim())) {
      if (name) counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return topics.map((topic) => ({ topic, channels: counts.get(topic) || 0 }));
}

/** How long a digest counts as newly arrived. */
export const NEW_WINDOW_MS = 4 * 3600 * 1000;

/**
 * The digests upstream added within the window.
 *
 * Judged on `checked_at`, which is when the digest landed. The articles inside
 * carry their own `created_utc` and are routinely days older — upstream
 * summarises a running window rather than only what broke since the last check
 * — so going by those would call a digest minutes old stale. It is also the
 * only reading that composes with what has been heard, which is recorded per
 * digest block and not per article.
 */
export function recentlyAdded(digests = [], { now = Date.now(), windowMs = NEW_WINDOW_MS } = {}) {
  return digests.filter((digest) => {
    const at = Number(digest.checked_at) || 0;
    return at > 0 && now - at * 1000 <= windowMs;
  });
}

const HOST_LABEL = /^www\./;

/** "news.ycombinator.com" from a URL, for the source line under a headline. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(HOST_LABEL, '');
  } catch {
    return '';
  }
}

/** Upstream timestamps are epoch seconds; the page wants "3 小時前". */
export function relativeTime(epochSeconds, now = Date.now()) {
  if (!epochSeconds) return '';
  const seconds = Math.round(now / 1000 - epochSeconds);
  if (seconds < 90) return '啱啱';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 日前`;
  return new Date(epochSeconds * 1000).toLocaleDateString('zh-HK');
}

/** Absolute clock time, for the digest headers. */
export function clockTime(epochSeconds) {
  if (!epochSeconds) return '';
  return new Date(epochSeconds * 1000).toLocaleString('zh-HK', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function formatClock(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The page's own URL state: which view, which filter, which page.
 * Kept in the hash so a filtered view is linkable and the back button works.
 */
/** How far back to ask for. '' is upstream's own default of one day. */
export const RANGES = [
  { value: '', label: '今日' },
  { value: '3d', label: '3 天' },
  { value: '5d', label: '5 天' },
];

const RANGE_VALUES = new Set(RANGES.map((r) => r.value));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseRoute(hash = '') {
  const raw = String(hash).replace(/^#\/?/, '');
  const [view = 'digests', queryString = ''] = raw.split('?');
  const query = new URLSearchParams(queryString);
  const known = ['digests', 'daily', 'tasks', 'sources'];
  const last = query.get('last') || '';
  const date = query.get('date') || '';
  return {
    view: known.includes(view) ? view : 'digests',
    topic: query.get('topic') || '',
    channel: query.get('channel') || '',
    page: Math.max(1, Number(query.get('page')) || 1),
    last: RANGE_VALUES.has(last) ? last : '',
    date: ISO_DATE.test(date) ? date : '',
  };
}

export function buildRoute({ view = 'digests', topic = '', channel = '', page = 1,
                             last = '', date = '' } = {}) {
  const query = new URLSearchParams();
  if (topic) query.set('topic', topic);
  if (channel) query.set('channel', channel);
  if (page > 1) query.set('page', String(page));
  if (last) query.set('last', last);
  if (date) query.set('date', date);
  const suffix = query.toString();
  return `#/${view}${suffix ? `?${suffix}` : ''}`;
}

/**
 * Route → the params /api/feed forwards upstream.
 *
 * `date` names one day and upstream lets it win over `last`, so sending both
 * would quietly ignore the range; only one goes.
 */
export function routeToParams({ topic, channel, page, last, date } = {}) {
  const params = new URLSearchParams();
  if (topic) params.set('topics', topic);
  if (channel) params.set('channel', channel);
  if (page && page > 1) params.set('page', String(page));
  if (date) params.set('date', date);
  else if (last) params.set('last', last);
  return params;
}
