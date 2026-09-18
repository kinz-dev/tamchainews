// UI wiring: route → fetch → render, plus the speak buttons that hand any
// block of text to the player.
//
// Rendering is done with createElement throughout rather than innerHTML: the
// upstream text is other people's HTML-shaped content (headlines, summaries),
// and it reaches the page as text nodes only.

import { prepare, estimateSeconds } from './speech.js';
import {
  Player, WebSpeechBackend, ServerTtsBackend,
  loadVoices, rankVoices, installVoiceHint, speechStopsInBackground, clips,
} from './player.js';
import {
  shapeDigest, splitRefs, feedHealth, healthSummary, topicCounts, recentlyAdded,
  hostOf, relativeTime, clockTime, formatClock,
  parseRoute, buildRoute, routeToParams, RANGES,
} from './feed.js';
import {
  ListenStore, idFor, stateOf, percentOf, tally, isResumable, resumePoint, parseDailyId,
  nextPlayable, kindOf, containedBy, allContainedHeard, digestListenIds, anyUnheard,
} from './listened.js';

const $ = (id) => document.getElementById(id);

const els = {
  banner: $('banner'),
  rail: $('rail'), railToggle: $('rail-toggle'), railScrim: $('rail-scrim'),
  topicList: $('topic-list'), channelList: $('channel-list'),
  channelFilter: $('channel-filter'), channelCount: $('channel-count'),
  rangeSelect: $('range-select'), datePick: $('date-pick'), dateClear: $('date-clear'),
  listenTally: $('listen-tally'), hideListened: $('hide-listened'),
  autoplayNext: $('autoplay-next'),
  clearListened: $('clear-listened'), listenNote: $('listen-note'),
  topicNew: $('topic-new'),
  crumbs: $('crumbs'), statusStrip: $('status-strip'), view: $('view'),
  pager: $('pager'), pagePrev: $('page-prev'), pageNext: $('page-next'), pageLabel: $('page-label'),
  playerbar: $('playerbar'), nowTitle: $('now-title'), nowSub: $('now-sub'),
  voiceSelect: $('voice-select'), rateSelect: $('rate-select'), refresh: $('refresh'),
  prev: $('prev'), toggle: $('toggle'), next: $('next'), stop: $('stop'),
  progress: $('progress'), progressLabel: $('progress-label'),
};

const state = {
  route: parseRoute(location.hash),
  recentIds: [],        // listen keys of everything added in the last 4 hours
  feed: null,           // last /api/feed payload
  daily: null,          // last /api/daily payload
  config: null,
  voices: [],
  serverVoices: [],
  activeSource: null,   // the element whose text is currently loaded in the player
  activeId: '',         // ...and its listened-to key
  activeText: '',       // the text behind it, so a checkpoint can replay it
  activeTitle: '',
  activeSubtitle: '',
  currentDay: null,
  segments: [],
  listens: null,        // ListenStore
  highlighted: null,    // {container, original} while a block carries sentence spans
  onScreen: [],         // ids rendered by the current view, for the tally
  playables: [],        // the same, in page order and carrying their text: the play queue
  resumed: false,       // restored from a checkpoint and not yet played
  touched: false,       // has the user actually driven the player this session?
};

const settings = {
  rate: Number(localStorage.getItem('tamchai.rate')) || 1,
  voiceId: localStorage.getItem('tamchai.voice') || '',
  autoplayNext: localStorage.getItem('tamchai.autoplayNext') === '1',
  hideListened: localStorage.getItem('tamchai.hideListened') === '1',
};

// ------------------------------------------------------------------ player

const player = new Player({
  onSegment: (index, segment) => {
    markActiveSegment(index);
    updateProgress(index, segment);
    recordProgress(index);
  },
  onStatus: (status) => {
    if (status === 'playing') {
      state.resumed = false;
      state.touched = true;
      publishNowPlaying();
    }
    setPlaybackState(status);
    els.toggle.textContent = status === 'playing' ? '⏸' : '▶';
    if (state.activeSource) {
      state.activeSource.setAttribute('aria-pressed', String(status === 'playing'));
    }
    if (status === 'idle') clearActiveSegment();
  },
  onFinish: () => {
    els.progressLabel.textContent = '播放完畢';
    if (state.activeId) {
      state.listens.set(state.activeId, { done: true, title: els.nowTitle.textContent });
      settleContainment(state.activeId);
      refreshListenMarks();
    }
    if (settings.autoplayNext) playNextUnheard();
  },
  onError: (error) => showBanner(`播放失敗：${error.message}`, true),
});

// ------------------------------------------------------- lock screen

// What the phone shows while the screen is off, and the buttons it offers
// there. Only the served voice puts anything on an <audio> element for iOS to
// hang this on; with the browser's voice the controls simply never appear,
// which is the honest outcome — there is nothing there to control.
const ARTWORK = [
  { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
  { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
];

function publishNowPlaying() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: state.activeTitle || '朗讀中',
    artist: state.activeSubtitle || '譚仔新聞',
    album: '譚仔新聞',
    artwork: ARTWORK,
  });
}

function setPlaybackState(status) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState =
    status === 'playing' ? 'playing' : status === 'paused' ? 'paused' : 'none';
}

if ('mediaSession' in navigator) {
  const actions = {
    play: () => { if (player.status !== 'playing') player.toggle(); },
    pause: () => player.pause(),
    previoustrack: () => { userDrives(); player.prev(); },
    nexttrack: () => { userDrives(); player.next(); },
    stop: () => { checkpoint(); player.stop(); },
  };
  for (const [action, handler] of Object.entries(actions)) {
    // Safari rejects actions it has no button for; that is not our problem.
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported */ }
  }
}

// iOS hands out playback permission one element at a time and only from a real
// tap. Spend the first tap of the session on both halves of the clip pair, so
// that the hand-off in the middle of an article — where there is no gesture to
// ask with, and a refusal ends the reading — has nothing left to ask for.
for (const event of ['pointerdown', 'keydown']) {
  document.addEventListener(event, () => clips.unlock(), { capture: true });
}

/** Speak an arbitrary run of text, tracked against the button that asked for it. */
function speakText(text, { title = '', subtitle = '', button = null, id = '' } = {}) {
  const { segments } = prepare(text);
  if (!segments.length) return;

  // A topic clip is several channel blocks read end to end, so no single block
  // on the page matches it; everything else lights up as it is read.
  const block = kindOf(id) === 'topic'
    ? null
    : button?.closest('.channel-block, .task, .highlights')?.querySelector('.clip-body');

  if (state.activeSource && state.activeSource !== button) {
    state.activeSource.setAttribute('aria-pressed', 'false');
  }
  state.resumed = false;
  state.touched = true;
  state.activeSource = button;
  state.activeId = id;
  state.activeText = text;
  state.activeTitle = title || '朗讀中';
  state.activeSubtitle = subtitle;
  state.segments = segments;

  els.playerbar.hidden = false;
  els.nowTitle.textContent = state.activeTitle;
  els.nowSub.textContent = subtitle;

  beginHighlighting(block, segments);
  player.load(segments, chooseBackend());
  player.setRate(settings.rate);
  player.play(0);
}

function chooseBackend() {
  const id = settings.voiceId;
  if (id.startsWith('server:')) {
    const voiceId = id.slice('server:'.length);
    const voice = state.serverVoices.find((v) => v.id === voiceId);
    if (voice) return new ServerTtsBackend(voice.id, voice.name);
  }
  if (id.startsWith('web:')) {
    const voice = state.voices.find((v) => `web:${v.voiceURI}` === id);
    if (voice) return new WebSpeechBackend(voice);
  }
  const ranked = rankVoices(state.voices);
  if (ranked.length) return new WebSpeechBackend(ranked[0].voice);
  if (state.serverVoices.length) {
    return new ServerTtsBackend(state.serverVoices[0].id, state.serverVoices[0].name);
  }
  return new WebSpeechBackend(null);
}

// -------------------------------------------------------------- rendering

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function link(href, text, className) {
  const a = el('a', className, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/**
 * The control that hands a block of text to the player.
 *
 * Whether it has been heard is shown by `listenMark`, pinned to the corner of
 * the block itself rather than sitting in this row — next to 朗讀 it read as a
 * second button instead of a status.
 */
function speakButton(text, { title, subtitle, id = '', parentId = '' } = {}) {
  const button = el('button', 'speak', '▶ 朗讀');
  button.type = 'button';
  button.setAttribute('aria-pressed', 'false');
  if (id) {
    button.dataset.speakId = id;
    // Rendered in page order, so this doubles as the running order.
    state.playables.push({ id, text, title, subtitle, parentId });
  }
  button.addEventListener('click', () => {
    if (state.activeSource === button && player.status === 'playing') return player.pause();
    if (state.activeSource === button && player.status === 'paused') return player.resume();
    speakText(text, { title, subtitle, button, id });
  });
  return button;
}

/**
 * The read/unread marker that overlays a block's top-right corner: a hollow
 * ring when untouched, the percentage while part-heard, a filled tick when
 * done. Clicking it marks the block either way by hand.
 *
 * The caller appends it to the block, which must be `position: relative`.
 */
function listenMark(id, title = '') {
  const mark = el('button', 'listen-mark');
  mark.type = 'button';
  mark.dataset.listenId = id;
  mark.addEventListener('click', (event) => {
    event.stopPropagation();
    const heard = state.listens.stateOf(id) === 'listened';
    state.listens.set(id, { done: !heard, title });
    refreshListenMarks();
  });
  state.onScreen.push(id);
  paintBadge(mark);
  return mark;
}

/** Put the current state on one mark, and on the block it belongs to. */
function paintBadge(mark) {
  const id = mark.dataset.listenId;
  const record = state.listens?.get(id);
  const listenState = stateOf(record);
  const percent = percentOf(record);

  mark.dataset.state = listenState;
  mark.textContent = listenState === 'listened' ? '✓' : listenState === 'partial' ? `${percent}%` : '';
  mark.setAttribute('aria-label', listenState === 'listened' ? '已聽 — 撳一下標記為未聽' : '標記為已聽');
  mark.title = listenState === 'listened'
    ? '已聽完 — 撳一下標記為未聽'
    : listenState === 'partial'
      ? `聽咗 ${percent}% — 撳一下標記為已聽`
      : '未聽 — 撳一下標記為已聽';

  const block = mark.closest('.channel-block, .highlights, .task, .topic-group');
  if (block) block.classList.toggle('is-listened', listenState === 'listened');
}

/** Repaint every badge on screen, then the tally and the filter. */
function refreshListenMarks() {
  for (const mark of document.querySelectorAll('.listen-mark')) paintBadge(mark);
  for (const card of document.querySelectorAll('.day-card[data-listen-id]')) {
    const listenState = state.listens.stateOf(card.dataset.listenId);
    card.dataset.state = listenState;
    const tick = card.querySelector('.tick');
    if (tick) tick.textContent = listenState === 'listened' ? '✓' : listenState === 'partial' ? '◐' : '';
  }
  applyListenFilter();
  renderListenTally();
  refreshNewBadge();
}

/** 只顯示未聽: hide the channel blocks whose summary has been heard. */
function applyListenFilter() {
  const hide = settings.hideListened;
  for (const block of document.querySelectorAll('.channel-block')) {
    block.hidden = hide && block.classList.contains('is-listened');
  }
  // A topic whose channels are all hidden should not leave a stray header.
  for (const group of document.querySelectorAll('.topic-group')) {
    const blocks = [...group.querySelectorAll('.channel-block')];
    group.hidden = hide && blocks.length > 0 && blocks.every((b) => b.hidden);
  }
  for (const digest of document.querySelectorAll('.digest')) {
    const groups = [...digest.querySelectorAll('.topic-group')];
    const emptied = groups.length > 0 && groups.every((g) => g.hidden);
    digest.hidden = hide && emptied && digest.classList.contains('is-listened');
  }
}

// ------------------------------------------------------------- what's new

// The 新 badge answers one question: has anything arrived in the last four
// hours that you have not heard yet?
//
// Deliberately not measured against what is on screen. /api/feed narrows to
// the current topic, channel, date and page, and an answer that changed
// because you happened to be reading one topic would be worthless — so it is
// measured against the unfiltered newest page, which is where the last four
// hours live whatever the rail is filtered to.
const RECENT_TTL_MS = 60_000;
let recentFetchedAt = 0;

function isUnfiltered({ topic, channel, date, last, page }) {
  return !topic && !channel && !date && !last && page === 1;
}

async function trackRecent({ force = false } = {}) {
  let digests = null;
  if (isUnfiltered(state.route) && state.feed?.digests) {
    digests = state.feed.digests;                      // load() just fetched exactly this
  } else if (force || Date.now() - recentFetchedAt > RECENT_TTL_MS) {
    // Stale beats wrong: a failed fetch leaves the previous answer standing
    // rather than clearing a badge that may well still be earned.
    try { digests = (await fetchJson('/api/feed')).digests || []; } catch { digests = null; }
  }
  if (digests) {
    recentFetchedAt = Date.now();
    state.recentIds = recentlyAdded(digests)
      .flatMap((digest) => digestListenIds(shapeDigest(digest)));
  }
  refreshNewBadge();
}

/** Repaint from what is already known — no network, so it can run per segment. */
function refreshNewBadge() {
  if (!els.topicNew) return;
  els.topicNew.hidden = !anyUnheard(state.recentIds, state.listens?.records);
}

function renderListenTally() {
  if (!els.listenTally) return;
  const counts = tally(state.onScreen, state.listens.records);
  els.listenTally.textContent = counts.total
    ? `已聽 ${counts.listened}/${counts.total}`
    : '';
  els.listenTally.hidden = !counts.total;
}

/**
 * Keep a topic and its channels honest about each other.
 *
 * Hearing a topic read out is hearing every channel in it, and hearing every
 * channel in a topic leaves nothing of the topic unheard. Without this the two
 * disagree, and auto-play would read the same words twice.
 */
function settleContainment(id) {
  const kind = kindOf(id);

  if (kind === 'topic') {
    for (const child of containedBy(state.playables, id)) {
      state.listens.set(child.id, { done: true, title: child.title });
    }
    return;
  }

  const parentId = state.playables.find((item) => item.id === id)?.parentId;
  if (parentId && allContainedHeard(state.playables, parentId, state.listens.records)) {
    state.listens.set(parentId, { done: true });
  }
}

/**
 * Roll on to the next clip that has not been heard, and keep playing.
 *
 * It runs to the end of the page, across topics and across digests. Topic clips
 * are not destinations — they repeat their channels — but everything else is
 * fair game. The daily view chains days through selectDay, which owns the
 * reader.
 */
function playNextUnheard() {
  if (state.route.view === 'daily') return playAdjacentDay();

  const next = nextPlayable(state.playables, state.activeId, state.listens.records);
  if (!next) {
    showBanner('呢版嘅未聽內容已經播完。', false, { seconds: 5 });
    return;
  }

  const button = document.querySelector(`.speak[data-speak-id="${CSS.escape(next.id)}"]`);
  speakText(next.text, {
    title: next.title,
    subtitle: next.subtitle,
    button,
    id: next.id,
  });
  button?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** The user just drove the player: it is live now, not a restored position. */
function userDrives() {
  state.touched = true;
  state.resumed = false;
}

/** Fold the playing position into the store, at most once per segment. */
function recordProgress(index) {
  if (!state.activeId || !state.segments.length) return;
  state.listens.advance(state.activeId, {
    segment: index,
    total: state.segments.length,
    title: els.nowTitle.textContent,
  });
  checkpoint(index);
  if (index % 4 === 0) refreshListenMarks();       // cheap enough, but not every sentence
}

/**
 * Save where playback has reached, so a reload can pick it up.
 *
 * Written once per sentence while playing, and again whenever the page is about
 * to lose us — pausing, hiding the tab, or navigating away — because the last
 * sentence heard is otherwise lost between checkpoints.
 */
function checkpoint(index = player.index) {
  if (!state.activeId || !state.activeText || !state.segments.length) return;
  // Opening a view loads a day at sentence 0 on its own; saving that would
  // erase the position the last session left behind.
  if (!state.touched) return;
  state.listens.savePlayback({
    id: state.activeId,
    title: state.activeTitle,
    subtitle: state.activeSubtitle,
    text: state.activeText,
    segment: index,
    total: state.segments.length,
    route: location.hash,
  });
}

/**
 * Put the player back where it was, without playing: browsers block audio that
 * no one asked for, and resuming into sound on load would be rude anyway.
 */
function restorePlayback(checkpointed) {
  const { segments } = prepare(checkpointed.text);
  if (!segments.length) return;
  endHighlighting();

  state.activeId = checkpointed.id;
  state.activeText = checkpointed.text;
  state.activeTitle = checkpointed.title;
  state.activeSubtitle = checkpointed.subtitle;
  state.segments = segments;

  els.playerbar.hidden = false;
  els.nowTitle.textContent = checkpointed.title || '上次播放';
  els.nowSub.textContent = checkpointed.subtitle;

  // Set before seek(): seek drives onSegment -> updateProgress, which is what
  // renders the label, so the flag has to be true by the time it runs.
  state.resumed = true;
  player.load(segments, chooseBackend());
  player.setRate(settings.rate);
  player.seek(Math.min(checkpointed.segment, segments.length - 1));
}

/**
 * Minimal Markdown → DOM for the highlight and task bodies: headings, lists,
 * paragraphs, links and bold. Enough for what upstream emits, and it never
 * takes the text through innerHTML.
 */
function renderMarkdown(markdown, container) {
  let list = null;
  const flushList = () => { list = null; };

  for (const raw of String(markdown).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flushList(); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = Math.min(heading[1].length, 3);
      container.appendChild(withInline(el(`h${level}`), heading[2]));
      continue;
    }

    const bullet = line.match(/^[*+-]\s+(.*)$/) || line.match(/^\d+[.)]\s+(.*)$/);
    if (bullet) {
      if (!list) { list = el('ul'); container.appendChild(list); }
      list.appendChild(withInline(el('li'), bullet[1]));
      continue;
    }

    flushList();
    container.appendChild(withInline(el('p'), line));
  }
  return container;
}

const INLINE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;

/** Inline Markdown (links, bold, code) into an existing element, as nodes. */
function withInline(node, text) {
  let cursor = 0;
  for (const match of String(text).matchAll(INLINE)) {
    if (match.index > cursor) node.appendChild(document.createTextNode(text.slice(cursor, match.index)));
    if (match[1]) node.appendChild(link(match[2], match[1]));
    else if (match[3]) node.appendChild(el('strong', null, match[3]));
    else if (match[4]) node.appendChild(el('code', null, match[4]));
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) node.appendChild(document.createTextNode(text.slice(cursor)));
  return node;
}

/** Prose with its "[n]" citations turned into links to the cited item. */
function renderSummary(text, items) {
  const p = el('p', 'summary clip-body');
  for (const part of splitRefs(text, items)) {
    if (part.type === 'text') p.appendChild(document.createTextNode(part.value));
    else p.appendChild(link(part.item.link || part.item.url, `[${part.value}]`, 'ref-link'));
  }
  return p;
}

function renderRefs(items) {
  const box = el('details', 'refs-box');
  box.appendChild(el('summary', null, `${items.length} 條來源`));
  const ol = el('ul', 'refs');
  for (const item of items) {
    const li = el('li');
    li.appendChild(el('span', 'num', `${item.ref}.`));
    const body = el('div');
    const title = el('div', 'title');
    title.appendChild(link(item.url, item.title || '(無標題)'));
    body.appendChild(title);

    const meta = el('div', 'meta');
    const bits = [];
    if (item.author) bits.push(item.author);
    if (item.created_utc) bits.push(relativeTime(item.created_utc));
    meta.appendChild(document.createTextNode(bits.join(' · ')));
    if (item.link) {
      const host = hostOf(item.link);
      if (host) {
        meta.appendChild(document.createTextNode(bits.length ? ' · ' : ''));
        meta.appendChild(link(item.link, host));
      }
    }
    body.appendChild(meta);
    li.appendChild(body);
    ol.appendChild(li);
  }
  box.appendChild(ol);
  return box;
}

function renderDigest(digest) {
  const shaped = shapeDigest(digest);
  const article = el('article', 'digest');

  const head = el('div', 'digest-head');
  head.appendChild(el('span', 'digest-when', clockTime(shaped.checkedAt)));
  head.appendChild(el('span', 'digest-ago', relativeTime(shaped.checkedAt)));
  head.appendChild(el('span', 'digest-stats', `${shaped.posts} 篇 · ${shaped.refs} 引用`));
  article.appendChild(head);

  if (shaped.highlights) {
    const box = el('div', 'highlights');
    const bar = el('div', 'topic-head');
    bar.appendChild(el('h3', null, '重點'));
    bar.appendChild(speakButton(shaped.highlights, {
      title: `重點 · ${clockTime(shaped.checkedAt)}`,
      subtitle: `${shaped.posts} 篇文章`,
      id: idFor.digestHighlights(shaped.id),
    }));
    box.appendChild(bar);
    box.appendChild(renderMarkdown(shaped.highlights, el('div', 'clip-body')));
    box.appendChild(listenMark(idFor.digestHighlights(shaped.id), '重點'));
    article.appendChild(box);
  }

  for (const group of shaped.topics) {
    const section = el('section', 'topic-group');
    const head2 = el('div', 'topic-head');
    const h3 = el('h3');
    h3.appendChild(topicLink(group.topic));
    head2.appendChild(h3);
    head2.appendChild(el('span', 'n', `${group.channels.length} 個頻道 · ${group.posts} 篇`));

    const spoken = group.channels.map((c) => `${c.channel}。${c.summary}`).join('\n\n');
    if (spoken.trim()) {
      head2.appendChild(speakButton(spoken, {
        title: group.topic,
        subtitle: clockTime(shaped.checkedAt),
        id: idFor.digestTopic(shaped.id, group.topic),
      }));
    }
    section.appendChild(head2);
    section.appendChild(listenMark(idFor.digestTopic(shaped.id, group.topic), group.topic));

    for (const channel of group.channels) {
      const block = el('div', 'channel-block');
      const chead = el('div', 'channel-head');
      const name = el('span', 'channel-name');
      name.appendChild(channelLink(channel.channel));
      chead.appendChild(name);
      if (channel.summary) {
        chead.appendChild(speakButton(channel.summary, {
          title: channel.channel,
          subtitle: group.topic,
          id: idFor.digestChannel(shaped.id, channel.channel),
          parentId: idFor.digestTopic(shaped.id, group.topic),
        }));
      }
      block.appendChild(chead);
      if (channel.summary) block.appendChild(renderSummary(channel.summary, channel.items));
      if (channel.items.length) block.appendChild(renderRefs(channel.items));
      block.appendChild(listenMark(idFor.digestChannel(shaped.id, channel.channel), channel.channel));
      section.appendChild(block);
    }
    article.appendChild(section);
  }
  return article;
}

function topicLink(topic) {
  const a = el('a', null, topic);
  a.href = buildRoute({ view: 'digests', topic });
  return a;
}

function channelLink(channel) {
  const a = el('a', null, channel);
  a.href = buildRoute({ view: 'digests', channel });
  return a;
}

// ------------------------------------------------------------------ views

async function renderDigestsView() {
  const payload = state.feed;
  const digests = payload?.digests || [];
  // Some topics have no digests at all — their content is scheduled reports
  // (Transcript is entirely that). Rendering only digests left those topics
  // looking empty while upstream plainly had something to show.
  const filtered = Boolean(state.route.topic || state.route.channel);
  const tasks = filtered ? (payload?.tasks || []) : [];

  els.view.replaceChildren();

  if (!digests.length && !tasks.length) {
    els.view.appendChild(el('p', 'placeholder', '呢個篩選未有內容。'));
    hidePager();
    return;
  }

  for (const digest of digests) els.view.appendChild(renderDigest(digest));

  if (tasks.length) {
    const heading = el('h3', 'stream-heading', `定時報告（${tasks.length}）`);
    els.view.appendChild(heading);
    for (const task of tasks) els.view.appendChild(renderTask(task));
  }

  const page = payload.page || {};
  if (digests.length) renderPager(page.number || 1, page.pages || 1);
  else hidePager();
}

/**
 * One scheduled report. Shared by the 定時報告 view and the digest stream,
 * because a topic's content can live in either place.
 */
function renderTask(task) {
  const card = el('article', 'task');
  const listenId = idFor.task(task.task_id || task.id, task.finished_at);
  const title = task.prompt || '定時報告';
  const when = relativeTime(task.finished_at || task.started_at);

  const head = el('div', 'task-head');
  head.appendChild(el('span', 'task-name', title));
  head.appendChild(el('span', 'badge ' + (task.status === 'ok' ? 'ok' : 'bad'), task.status || '?'));
  if (task.schedule) head.appendChild(el('span', 'task-sched', task.schedule));
  head.appendChild(el('span', 'task-when', when));
  if (task.output) {
    head.appendChild(speakButton(task.output, { title, subtitle: when, id: listenId }));
  }
  card.appendChild(head);

  if (task.output) card.appendChild(renderMarkdown(task.output, el('div', 'task-body clip-body')));
  if (task.error) card.appendChild(el('p', 'task-error', task.error));
  if (task.output) card.appendChild(listenMark(listenId, title));
  return card;
}

function renderTasksView() {
  const tasks = state.feed?.tasks || [];
  els.view.replaceChildren();
  if (!tasks.length) {
    els.view.appendChild(el('p', 'placeholder', '未有定時報告。'));
    return;
  }
  for (const task of tasks) els.view.appendChild(renderTask(task));
  hidePager();
}

/** A feed's badge: never-fetched is not the same as broken. */
function feedStateOf(feed) {
  if (feed.ok) return ['ok', '正常'];
  const untried = !(Number(feed.fetch_seq) || 0) && !feed.last_ok && !feed.last_error;
  return untried ? ['', '未抓取'] : ['bad', '失敗'];
}

function renderSourcesView() {
  const feeds = state.feed?.feeds || [];
  els.view.replaceChildren();
  if (!feeds.length) {
    els.view.appendChild(el('p', 'placeholder', '未有訊源資料。'));
    return;
  }
  const table = el('table', 'source-table');
  const thead = el('thead');
  const hrow = el('tr');
  for (const label of ['訊源', '狀態', '最後更新', '抓取次數']) hrow.appendChild(el('th', null, label));
  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const feed of feeds) {
    const tr = el('tr');
    tr.appendChild(el('td', null, feed.name || ''));
    const status = el('td');
    const [cls, word] = feedStateOf(feed);
    status.appendChild(el('span', `badge ${cls}`, word));
    if (feed.last_error) status.appendChild(el('div', 'err', feed.last_error));
    tr.appendChild(status);
    tr.appendChild(el('td', null, feed.last_ok ? relativeTime(feed.last_ok) : '—'));
    tr.appendChild(el('td', null, String(feed.fetch_seq ?? '')));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  els.view.appendChild(table);
  hidePager();
}

function renderDailyView() {
  const days = state.daily?.days || [];
  els.view.replaceChildren();
  if (!days.length) {
    els.view.appendChild(el('p', 'placeholder', '未有每日總覽。'));
    return;
  }

  const grid = el('div', 'day-grid');
  for (const day of days) {
    const card = el('button', 'day-card');
    card.dataset.listenId = idFor.daily(day.day);
    const line = el('span', 'day-line');
    line.appendChild(el('span', 'd', day.day));
    line.appendChild(el('span', 'tick', ''));
    card.appendChild(line);
    card.appendChild(el('span', 'h', day.headline || ''));
    const time = el('span', 't');
    time.dataset.seconds = String(day.est_seconds);
    time.textContent = `${day.chars} 字 · 約 ${formatClock(day.est_seconds / settings.rate)}`;
    card.appendChild(time);
    card.setAttribute('aria-current', String(state.currentDay?.day === day.day));
    card.addEventListener('click', () => selectDay(day.day, { autoplay: true }));
    state.onScreen.push(card.dataset.listenId);
    grid.appendChild(card);
  }
  els.view.appendChild(grid);

  const body = el('article', 'reader-body');
  body.id = 'reader-body';
  els.view.appendChild(body);

  // Reopen on the day the checkpoint was in, if it is still in the list.
  const saved = state.listens.playback;
  const savedDay = isResumable(saved) ? parseDailyId(saved.id) : '';
  const opening = state.currentDay?.day
    || (days.some((d) => d.day === savedDay) ? savedDay : '')
    || days[0].day;
  selectDay(opening, { resume: !state.currentDay });
  hidePager();
}

/** Render one day's digest as clickable sentences, the way the reader always worked. */
function selectDay(dayId, { autoplay = false, resume = false } = {}) {
  endHighlighting();
  const day = (state.daily?.days || []).find((d) => d.day === dayId);
  if (!day) return;
  state.currentDay = day;

  const body = $('reader-body');
  if (!body) return;
  const { blocks, segments } = prepare(day.text);
  state.segments = segments;
  body.replaceChildren();

  let index = 0;
  blocks.forEach((block) => {
    const tag = block.kind.startsWith('h') ? block.kind : block.kind === 'li' ? 'li' : 'p';
    const node = el(tag);
    block.segments.forEach((segment) => {
      const span = el('span', 'seg', segment.text);
      span.dataset.index = String(index);
      span.addEventListener('click', () => {
        userDrives();
        player.seek(Number(span.dataset.index));
      });
      node.appendChild(span);
      node.appendChild(document.createTextNode(' '));
      index += 1;
    });
    body.appendChild(node);
  });

  for (const card of els.view.querySelectorAll('.day-card')) {
    card.setAttribute('aria-current', String(card.dataset.listenId === idFor.daily(dayId)));
  }

  els.playerbar.hidden = false;
  els.nowTitle.textContent = day.headline || day.day;
  els.nowSub.textContent = `${day.day} · ${day.chars} 字`;
  state.activeSource = null;
  state.activeId = idFor.daily(day.day);
  state.activeText = day.text;
  state.activeTitle = day.headline || day.day;
  state.activeSubtitle = `${day.day} · ${day.chars} 字`;

  player.load(segments, chooseBackend());
  player.setRate(settings.rate);

  // Picking a day by hand starts it; coming back to one you were part way
  // through picks up where you stopped.
  const at = resume
    ? Math.min(resumePoint(state.listens.playback, state.listens.get(state.activeId), state.activeId),
               segments.length - 1)
    : 0;
  state.resumed = resume && at > 0;
  if (autoplay) player.play(at);
  else if (at > 0) player.seek(at);
  else updateProgress(0, segments[0]);
}

function playAdjacentDay() {
  const days = state.daily?.days || [];
  const at = days.findIndex((d) => d.day === state.currentDay?.day);
  const following = days
    .slice(at + 1)
    .find((day) => state.listens.stateOf(idFor.daily(day.day)) !== 'listened');
  if (following) selectDay(following.day, { autoplay: true });
  else showBanner('未聽嘅每日總覽已經播完。', false, { seconds: 5 });
}

// ----------------------------------------------------------------- chrome

function renderDateControls() {
  if (!els.rangeSelect.options.length) {
    for (const { value, label } of RANGES) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      els.rangeSelect.appendChild(option);
    }
  }
  els.rangeSelect.value = state.route.last;
  // A chosen date names one day, so the range has nothing left to widen.
  els.rangeSelect.disabled = Boolean(state.route.date);
  els.datePick.value = state.route.date;
  els.dateClear.hidden = !state.route.date;
}

function renderRail() {
  renderDateControls();
  const payload = state.feed || {};
  const topics = topicCounts(payload.topics || [], payload.channel_topics || {});
  els.topicList.replaceChildren();
  for (const { topic, channels } of topics) {
    const li = el('li');
    const a = el('a');
    a.href = buildRoute({ view: 'digests', topic });
    a.appendChild(document.createTextNode(topic));
    if (channels) a.appendChild(el('span', 'n', String(channels)));
    if (state.route.topic === topic) a.setAttribute('aria-current', 'page');
    li.appendChild(a);
    els.topicList.appendChild(li);
  }

  const channels = payload.channels || [];
  els.channelCount.textContent = channels.length ? `(${channels.length})` : '';
  renderChannelList(channels, els.channelFilter.value);

  for (const node of document.querySelectorAll('.view-link')) {
    if (node.dataset.view === state.route.view) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  }
}

function renderChannelList(channels, filter) {
  const needle = filter.trim().toLowerCase();
  els.channelList.replaceChildren();
  for (const channel of channels) {
    if (needle && !channel.toLowerCase().includes(needle)) continue;
    const li = el('li');
    const a = el('a', null, channel);
    a.href = buildRoute({ view: 'digests', channel });
    if (state.route.channel === channel) a.setAttribute('aria-current', 'page');
    li.appendChild(a);
    els.channelList.appendChild(li);
  }
}

const VIEW_TITLES = { digests: '摘要', daily: '每日總覽', tasks: '定時報告', sources: '訊源狀態' };

function renderCrumbs() {
  els.crumbs.replaceChildren();
  const { view, topic, channel } = state.route;
  let title = VIEW_TITLES[view] || '摘要';
  if (topic) title = topic;
  if (channel) title = channel;
  els.crumbs.appendChild(el('h2', null, title));
  if (topic || channel) {
    const clear = el('a', 'clear', '× 清除篩選');
    clear.href = buildRoute({ view });
    els.crumbs.appendChild(clear);
  }
}

function renderStatusStrip() {
  const payload = state.feed || {};
  const meta = payload._meta || {};
  els.statusStrip.replaceChildren();

  const health = feedHealth(payload.feeds || []);
  els.statusStrip.appendChild(healthChip(health));

  if (payload.last_check_at) {
    const span = el('span', null, `上游上次檢查 ${relativeTime(payload.last_check_at)}`);
    span.title = new Date(payload.last_check_at * 1000).toLocaleString('zh-HK');
    els.statusStrip.appendChild(span);
  }
  if (payload.next_check_at) {
    const at = new Date(payload.next_check_at * 1000)
      .toLocaleTimeString('zh-HK', { hour: '2-digit', minute: '2-digit' });
    const span = el('span', null, `下次 ${at}${countdown(payload.next_check_at)}`);
    span.title = payload.check_schedule
      ? `上游自己嘅排程：${payload.check_schedule}。佢唔接受即時觸發，到時會自動攞新內容。`
      : '上游自己嘅排程。';
    els.statusStrip.appendChild(span);
  }
  if (payload.checking) {
    els.statusStrip.appendChild(el('span', 'checking', '上游檢查緊…'));
  }
  if (meta.cached) els.statusStrip.appendChild(el('span', null, '（快取）'));
  if (meta.base_url) els.statusStrip.appendChild(link(meta.base_url, '上游', null));
  if (meta.upstream_error) showBanner(`上游錯誤：${meta.upstream_error}`, true);
}

const STATE_LABEL = { failing: '失敗', pending: '未抓取' };
const STATE_HINT = {
  failing: '上次抓取失敗。',
  pending: '上游剛加入此訊源，尚未抓取過 —— 並非故障，等下次檢查即可。',
};

/**
 * The health read-out. With nothing wrong it is plain text; with a problem it
 * becomes a button that hovers a summary and clicks open the detail.
 */
function healthChip(health) {
  const label = healthSummary(health);
  const bad = health.failing.length > 0;

  if (!health.problems.length) {
    const span = el('span');
    span.appendChild(el('span', 'dot'));
    span.appendChild(document.createTextNode(label));
    return span;
  }

  const wrap = el('span', 'health');
  const button = el('button', 'health-toggle');
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');
  button.title = health.problems
    .map((p) => `${p.name} — ${STATE_LABEL[p.state]}${p.error ? `：${p.error}` : ''}`)
    .join('\n');
  button.appendChild(el('span', 'dot' + (bad ? ' bad' : ' warn')));
  button.appendChild(document.createTextNode(label));
  button.appendChild(el('span', 'caret', '▸'));

  const panel = el('div', 'health-panel');
  panel.hidden = true;
  for (const problem of health.problems) {
    const row = el('div', 'health-item');

    const head = el('div', 'health-item-head');
    head.appendChild(el('span', 'health-name', problem.name));
    head.appendChild(el('span', `badge ${problem.state === 'failing' ? 'bad' : ''}`,
      STATE_LABEL[problem.state]));
    row.appendChild(head);

    row.appendChild(el('p', 'health-hint', STATE_HINT[problem.state]));
    if (problem.error) row.appendChild(el('p', 'health-error', problem.error));

    const facts = [
      `抓取次數 ${problem.attempts}`,
      problem.lastOk ? `最後成功 ${relativeTime(problem.lastOk)}` : '從未成功抓取',
    ];
    if (problem.errorAt) facts.push(`出錯 ${relativeTime(problem.errorAt)}`);
    row.appendChild(el('p', 'health-facts', facts.join(' · ')));
    panel.appendChild(row);
  }

  const more = el('a', 'health-more', '查看全部訊源 →');
  more.href = buildRoute({ view: 'sources' });
  panel.appendChild(more);

  button.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.lastChild.textContent = open ? '▾' : '▸';
  });

  wrap.appendChild(button);
  wrap.appendChild(panel);
  return wrap;
}

/** "（約 23 分鐘後）", or nothing once it is due. */
function countdown(epochSeconds) {
  const minutes = Math.round((epochSeconds * 1000 - Date.now()) / 60000);
  if (minutes <= 0) return '';
  if (minutes < 60) return `（約 ${minutes} 分鐘後）`;
  return `（約 ${Math.round(minutes / 60)} 小時後）`;
}

function renderPager(number, pages) {
  if (pages <= 1) return hidePager();
  els.pager.hidden = false;
  els.pageLabel.textContent = `第 ${number} / ${pages} 頁`;
  els.pagePrev.disabled = number <= 1;
  els.pageNext.disabled = number >= pages;
}

function hidePager() { els.pager.hidden = true; }

let bannerTimer = null;

function showBanner(message, isError = false, { seconds = 0 } = {}) {
  clearTimeout(bannerTimer);
  els.banner.textContent = message;
  els.banner.className = 'banner' + (isError ? ' error' : '');
  els.banner.hidden = false;
  if (seconds) bannerTimer = setTimeout(hideBanner, seconds * 1000);
}

function hideBanner() { els.banner.hidden = true; }

// --------------------------------------------------------------- progress

/**
 * Wrap each spoken sentence of `container` in its own span, so the one being
 * read can be highlighted.
 *
 * The prose is already rendered — with citation links, bold, headings — and all
 * of that has to survive, so rather than re-rendering from the segments this
 * walks the text nodes and splits them at the sentence boundaries. A sentence
 * that straddles a link becomes several spans sharing an index; highlighting
 * lights them all.
 *
 * Returns false when the text could not be aligned, in which case the block is
 * left exactly as it was.
 */
function wrapSegments(container, segments) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const chars = [];                       // every non-space character, and where it lives
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue;
    for (let i = 0; i < value.length; i += 1) {
      if (!/\s/.test(value[i])) chars.push({ node, offset: i, c: value[i] });
    }
  }
  if (!chars.length) return false;

  // Locate each sentence in that stream, scanning forward so repeated wording
  // matches the occurrence that belongs to this sentence.
  const found = [];
  let cursor = 0;
  for (const segment of segments) {
    const needle = segment.text.replace(/\s+/g, '');
    if (!needle) continue;
    let start = -1;
    for (let at = cursor; at + needle.length <= chars.length; at += 1) {
      let ok = true;
      for (let k = 0; k < needle.length; k += 1) {
        if (chars[at + k].c !== needle[k]) { ok = false; break; }
      }
      if (ok) { start = at; break; }
    }
    if (start < 0) continue;
    found.push({ index: segment.index, from: start, to: start + needle.length - 1 });
    cursor = start + needle.length;
  }
  if (!found.length) return false;

  // Split per text node, latest first so earlier offsets stay valid.
  const pieces = [];
  for (const { index, from, to } of found) {
    let runNode = chars[from].node;
    let runStart = chars[from].offset;
    let runEnd = chars[from].offset;
    for (let i = from + 1; i <= to; i += 1) {
      if (chars[i].node === runNode) {
        runEnd = chars[i].offset;
      } else {
        pieces.push({ index, node: runNode, start: runStart, end: runEnd });
        runNode = chars[i].node;
        runStart = chars[i].offset;
        runEnd = chars[i].offset;
      }
    }
    pieces.push({ index, node: runNode, start: runStart, end: runEnd });
  }

  for (const piece of pieces.reverse()) {
    const node = piece.node;
    if (!node.parentNode) continue;
    const tail = node.splitText(piece.start);
    tail.splitText(piece.end - piece.start + 1);
    const span = el('span', 'seg');
    span.dataset.index = String(piece.index);
    tail.parentNode.insertBefore(span, tail);
    span.appendChild(tail);
  }
  return true;
}

/**
 * Put sentence spans on the block that is playing, remembering the untouched
 * markup so it can be handed back when playback moves on.
 */
function beginHighlighting(container, segments) {
  endHighlighting();
  if (!container || !segments.length) return;
  const original = [...container.childNodes].map((node) => node.cloneNode(true));
  if (!wrapSegments(container, segments)) return;
  state.highlighted = { container, original };
  for (const span of container.querySelectorAll('.seg')) {
    span.addEventListener('click', () => {
      userDrives();
      player.seek(Number(span.dataset.index));
    });
  }
}

function endHighlighting() {
  const held = state.highlighted;
  state.highlighted = null;
  if (!held || !held.container.isConnected) return;
  held.container.replaceChildren(...held.original.map((node) => node.cloneNode(true)));
}

/** Light the sentence being spoken, wherever on the page it is. */
function markActiveSegment(index) {
  const scope = state.highlighted?.container || document;
  for (const node of document.querySelectorAll('.seg.active')) node.classList.remove('active');
  const nodes = scope.querySelectorAll(`.seg[data-index="${index}"]`);
  nodes.forEach((node) => node.classList.add('active'));
  if (nodes.length) nodes[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function clearActiveSegment() {
  for (const node of document.querySelectorAll('.seg.active')) node.classList.remove('active');
}

function updateProgress(index) {
  const segments = state.segments;
  if (!segments.length) return;
  const done = estimateSeconds(segments.slice(0, index), settings.rate);
  const all = estimateSeconds(segments, settings.rate);
  const percent = all ? Math.min(100, (done / all) * 100) : 0;
  els.progress.firstElementChild.style.width = `${percent}%`;
  els.progress.setAttribute('aria-valuenow', String(Math.round(percent)));
  els.progressLabel.textContent = state.resumed
    ? `⏸ 上次聽到第 ${index + 1}/${segments.length} 句 — 撳 ▶ 繼續`
    : `${formatClock(done)} / ${formatClock(all)} · 第 ${index + 1}/${segments.length} 句`;
}

// ------------------------------------------------------------------ voices

async function setupVoices() {
  state.voices = await loadVoices();
  state.serverVoices = state.config?.tts_voices || [];

  els.voiceSelect.replaceChildren();
  const ranked = rankVoices(state.voices);
  if (ranked.length) {
    const group = document.createElement('optgroup');
    group.label = '瀏覽器';
    for (const { voice, local } of ranked) {
      const option = document.createElement('option');
      option.value = `web:${voice.voiceURI}`;
      // Whichever way it falls, say it where the choice is made: on iOS every
      // browser voice dies with the screen, and that matters more than where
      // the synthesis happens.
      const caveat = speechStopsInBackground() ? '（鎖屏會停）' : (local ? '' : '（雲端）');
      option.textContent = `${voice.name}${caveat}`;
      group.appendChild(option);
    }
    els.voiceSelect.appendChild(group);
  }
  if (state.serverVoices.length) {
    const group = document.createElement('optgroup');
    group.label = '伺服器';
    for (const voice of state.serverVoices) {
      const option = document.createElement('option');
      option.value = `server:${voice.id}`;
      option.textContent = voice.name;
      group.appendChild(option);
    }
    els.voiceSelect.appendChild(group);
  }

  if (!settings.voiceId) {
    // An on-device Cantonese voice wins — except where it cannot outlive a
    // locked screen. There the server's voice is worth a round trip on the
    // first clip, because it is the only one that reads to the end.
    const serveInstead = state.serverVoices.length
      && (!ranked.length || speechStopsInBackground());
    settings.voiceId = serveInstead
      ? `server:${state.serverVoices[0].id}`
      : (ranked.length ? `web:${ranked[0].voice.voiceURI}` : '');
  }
  els.voiceSelect.value = settings.voiceId;
  if (els.voiceSelect.value !== settings.voiceId && els.voiceSelect.options.length) {
    settings.voiceId = els.voiceSelect.options[0].value;
    els.voiceSelect.value = settings.voiceId;
  }

  if (!ranked.length && !state.serverVoices.length) {
    const hint = installVoiceHint();
    showBanner(`此裝置未有粵語語音。${hint}`);
  }
}

// -------------------------------------------------------------------- data

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

async function load({ force = false } = {}) {
  const { view } = state.route;
  state.onScreen = [];
  state.playables = [];
  els.view.replaceChildren(el('p', 'placeholder', '載入中…'));
  try {
    if (view === 'daily') {
      const dailyParams = routeToParams(state.route);
      dailyParams.delete('topics');
      dailyParams.delete('channel');
      dailyParams.delete('page');
      if (force) dailyParams.set('refresh', '1');
      const dailyQuery = dailyParams.toString();
      state.daily = await fetchJson(`/api/daily${dailyQuery ? `?${dailyQuery}` : ''}`);
      // The rail, the status strip and the "has upstream checked since?" test
      // all read the full feed, so a refresh here has to renew that too — not
      // just the day list.
      if (!state.feed || force) {
        const railParams = routeToParams(state.route);
        if (force) railParams.set('refresh', '1');
        const railQuery = railParams.toString();
        state.feed = await fetchJson(`/api/feed${railQuery ? `?${railQuery}` : ''}`);
      }
    } else {
      const params = routeToParams(state.route);
      if (force) params.set('refresh', '1');
      const query = params.toString();
      state.feed = await fetchJson(`/api/feed${query ? `?${query}` : ''}`);
    }
    hideBanner();
  } catch (error) {
    showBanner(`載入失敗：${error.message}`, true);
    els.view.replaceChildren(el('p', 'placeholder', '載入失敗。'));
    return;
  }

  renderRail();
  renderCrumbs();
  renderStatusStrip();

  if (view === 'daily') renderDailyView();
  else if (view === 'tasks') renderTasksView();
  else if (view === 'sources') renderSourcesView();
  else await renderDigestsView();

  refreshListenMarks();
  await trackRecent({ force });
  scheduleUpstreamPoll();
}

// ------------------------------------------------------------------ events

function onRouteChange() {
  state.route = parseRoute(location.hash);
  closeRail();
  load();
}

window.addEventListener('hashchange', onRouteChange);

els.refresh.addEventListener('click', () => refreshNow());

/**
 * Re-ask upstream now, skipping our cache.
 *
 * This cannot make upstream go and poll its own feeds — that runs on its cron
 * (`check_schedule`) and it exposes no trigger — so the honest feedback is
 * whether its last check has moved since we looked.
 */
async function refreshNow({ auto = false } = {}) {
  if (els.refresh.classList.contains('busy')) return;
  const before = state.feed?.last_check_at || 0;

  els.refresh.classList.add('busy');
  els.refresh.disabled = true;
  if (!auto) showBanner('重新抓取緊…');

  try {
    await load({ force: true });
  } finally {
    els.refresh.classList.remove('busy');
    els.refresh.disabled = false;
  }

  const after = state.feed?.last_check_at || 0;
  if (after > before) {
    showBanner(`上游已更新 — 檢查於 ${clockTime(after)}`, false, { seconds: 6 });
  } else if (!auto) {
    const next = state.feed?.next_check_at;
    showBanner(
      `上游未有新內容。上游下次檢查：${next ? clockTime(next) : '未知'}`,
      false, { seconds: 6 },
    );
  } else {
    hideBanner();
  }
  scheduleUpstreamPoll();
}

/**
 * Upstream checks on a cron, so the useful automation is to come back for the
 * result a moment after it is due rather than to poll blindly.
 */
let upstreamPoll = null;

function scheduleUpstreamPoll() {
  clearTimeout(upstreamPoll);
  const next = state.feed?.next_check_at;
  if (!next) return;
  const delay = next * 1000 + 45_000 - Date.now();   // a beat after it is due
  if (delay <= 0 || delay > 6 * 3600 * 1000) return;
  upstreamPoll = setTimeout(() => refreshNow({ auto: true }), delay);
}

// Coming back to a tab that was left open past the check time should not show
// stale news while a timer that the browser throttled catches up.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const next = state.feed?.next_check_at;
  if (next && Date.now() > next * 1000 + 45_000) refreshNow({ auto: true });
});

els.rateSelect.value = String(settings.rate);
els.rateSelect.addEventListener('change', () => {
  settings.rate = Number(els.rateSelect.value);
  localStorage.setItem('tamchai.rate', String(settings.rate));
  player.setRate(settings.rate);
  // setRate only restarts the segment while playing; when stopped the read-out
  // would otherwise keep quoting the old speed's running time.
  if (player.status !== 'playing') updateProgress(player.index);
  retimeDayCards();
});

/** Keep the day cards' "約 X" in step with the speed the player is quoting. */
function retimeDayCards() {
  for (const node of document.querySelectorAll('.day-card .t[data-seconds]')) {
    const [chars] = node.textContent.split(' · ');
    node.textContent = `${chars} · 約 ${formatClock(Number(node.dataset.seconds) / settings.rate)}`;
  }
}

els.voiceSelect.addEventListener('change', () => {
  settings.voiceId = els.voiceSelect.value;
  localStorage.setItem('tamchai.voice', settings.voiceId);
  player.setBackend(chooseBackend());
  if (settings.voiceId.startsWith('web:') && speechStopsInBackground()) {
    showBanner('瀏覽器語音熄咗螢幕就會停。想鎖住部機都繼續播，揀返「伺服器」嗰把。', false, { seconds: 8 });
  }
});

els.channelFilter.addEventListener('input', () => {
  renderChannelList(state.feed?.channels || [], els.channelFilter.value);
});

els.autoplayNext.addEventListener('change', () => {
  settings.autoplayNext = els.autoplayNext.checked;
  localStorage.setItem('tamchai.autoplayNext', settings.autoplayNext ? '1' : '0');
});

els.rangeSelect.addEventListener('change', () => {
  location.hash = buildRoute({ ...state.route, last: els.rangeSelect.value, page: 1 });
});

els.datePick.addEventListener('change', () => {
  location.hash = buildRoute({ ...state.route, date: els.datePick.value, page: 1 });
});

els.dateClear.addEventListener('click', () => {
  location.hash = buildRoute({ ...state.route, date: '', page: 1 });
});

els.hideListened.addEventListener('change', () => {
  settings.hideListened = els.hideListened.checked;
  localStorage.setItem('tamchai.hideListened', settings.hideListened ? '1' : '0');
  applyListenFilter();
});

els.clearListened.addEventListener('click', () => {
  state.listens.clear();
  refreshListenMarks();
});

els.toggle.addEventListener('click', () => { state.touched = true; player.toggle(); checkpoint(); });
els.prev.addEventListener('click', () => { userDrives(); player.prev(); });
els.next.addEventListener('click', () => { userDrives(); player.next(); });
els.stop.addEventListener('click', () => { state.touched = true; checkpoint(); player.stop(); });

els.progress.addEventListener('click', (event) => {
  const segments = state.segments;
  if (!segments.length) return;
  const box = els.progress.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
  userDrives();
  player.seek(Math.floor(ratio * segments.length));
});

els.pagePrev.addEventListener('click', () => {
  location.hash = buildRoute({ ...state.route, page: Math.max(1, state.route.page - 1) });
});
els.pageNext.addEventListener('click', () => {
  location.hash = buildRoute({ ...state.route, page: state.route.page + 1 });
});

function openRail() {
  els.rail.classList.add('open');
  els.railScrim.hidden = false;
  els.railToggle.setAttribute('aria-expanded', 'true');
}
function closeRail() {
  els.rail.classList.remove('open');
  els.railScrim.hidden = true;
  els.railToggle.setAttribute('aria-expanded', 'false');
}
els.railToggle.addEventListener('click', () => {
  if (els.rail.classList.contains('open')) closeRail();
  else openRail();
});
els.railScrim.addEventListener('click', closeRail);

// pagehide is the one that fires reliably on mobile Safari, where a tab can be
// discarded without ever seeing beforeunload.
for (const event of ['pagehide', 'beforeunload']) {
  window.addEventListener(event, () => checkpoint());
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') checkpoint();
});

document.addEventListener('keydown', (event) => {
  const tag = event.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (event.key === ' ') { event.preventDefault(); player.toggle(); }
  else if (event.key === 'ArrowLeft') player.prev();
  else if (event.key === 'ArrowRight') player.next();
  else if (event.key === 'Escape') player.stop();
});

// -------------------------------------------------------------------- boot

(async function start() {
  state.listens = await ListenStore.open();
  els.hideListened.checked = settings.hideListened;
  els.autoplayNext.checked = settings.autoplayNext;
  if (!state.listens.persistent) {
    els.listenNote.textContent = '此瀏覽器唔俾存資料，收聽紀錄淨係保留到今次。';
    els.listenNote.hidden = false;
  }

  try {
    state.config = await fetchJson('/api/config');
  } catch {
    state.config = { tts_voices: [] };
  }
  await setupVoices();
  if (!location.hash) location.hash = buildRoute({ view: 'digests' });
  state.route = parseRoute(location.hash);
  await load();

  // After the view is up, so the restored bar is not wiped by the first render.
  // The daily view resumes itself inside selectDay, which owns the reader.
  const saved = state.listens.playback;
  if (isResumable(saved) && state.route.view !== 'daily') restorePlayback(saved);
})();
