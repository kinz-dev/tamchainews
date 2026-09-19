// Remembers what you have already listened to, in the browser's IndexedDB.
//
// Two halves, kept apart on purpose: the ID scheme and the state arithmetic are
// pure and unit-tested; the storage underneath is a thin wrapper that falls back
// to memory when IndexedDB is unavailable (private windows, blocked site data),
// so a page that cannot persist still works for the session.

const DB_NAME = 'tamchainews';
const DB_VERSION = 2;
const STORE = 'listened';
const PLAYBACK = 'playback';       // one row: where you were when you stopped
const PLAYBACK_KEY = 'current';

/** A checkpoint older than this is stale enough that resuming would confuse. */
export const RESUME_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** Anything past this much of the way through counts as heard. */
export const DONE_RATIO = 0.95;

/**
 * Stable IDs for the listenable things on the page.
 *
 * A task's ID carries `finishedAt`: the same scheduled prompt re-runs with new
 * text, and the new run has not been heard just because the old one was.
 */
export const idFor = {
  digestHighlights: (checkId) => `digest:${checkId}:highlights`,
  digestTopic: (checkId, topic) => `digest:${checkId}:topic:${topic}`,
  digestChannel: (checkId, channel) => `digest:${checkId}:channel:${channel}`,
  task: (taskId, finishedAt) => `task:${taskId}:${finishedAt || 0}`,
  daily: (day) => `daily:${day}`,
};

/** A record the store can hold. `segment` is the last one actually spoken. */
export function makeRecord({ id, title = '', segment = 0, total = 0, done = false, at = Date.now() }) {
  return { id, title, segment, total, done, at };
}

export function stateOf(record) {
  if (!record) return 'new';
  if (record.done) return 'listened';
  return record.segment > 0 ? 'partial' : 'new';
}

/** 0–1 through the item; a finished one is always 1. */
export function ratioOf(record) {
  if (!record) return 0;
  if (record.done) return 1;
  if (!record.total) return 0;
  return Math.min(1, (record.segment + 1) / record.total);
}

export function percentOf(record) {
  return Math.round(ratioOf(record) * 100);
}

/**
 * Fold a playback position into the stored record.
 *
 * Progress only ever moves forward: re-listening from the top should not undo
 * the fact that you have heard the whole thing, and scrubbing backwards mid-way
 * should not lose the furthest point reached.
 */
export function advance(previous, { segment, total, title }) {
  const furthest = Math.max(previous?.segment || 0, segment);
  const done = (previous?.done || false) || (total > 0 && (segment + 1) / total >= DONE_RATIO);
  return makeRecord({
    id: previous?.id,
    title: title || previous?.title || '',
    segment: furthest,
    total: total || previous?.total || 0,
    done,
    at: Date.now(),
  });
}

/**
 * The listen IDs a shaped digest is answerable for.
 *
 * The highlights and the topic blocks, but not the channels underneath them:
 * playing a topic marks its channels heard, and hearing every channel marks
 * the topic, so the topic level already speaks for both. Counting the channels
 * as well would leave a digest looking unheard after it had been read end to
 * end through its topic blocks.
 */
export function digestListenIds(shaped) {
  const ids = [];
  if (shaped.highlights) ids.push(idFor.digestHighlights(shaped.id));
  for (const group of shaped.topics || []) ids.push(idFor.digestTopic(shaped.id, group.topic));
  return ids;
}

/** Is any of this still unheard? Part-heard counts: you have not finished it. */
export function anyUnheard(ids = [], records = new Map()) {
  return ids.some((id) => stateOf(records.get(id)) !== 'listened');
}

/** Counts for the read-out: how much of what is on screen has been heard. */
export function tally(ids, records) {
  let listened = 0;
  let partial = 0;
  for (const id of ids) {
    const state = stateOf(records.get(id));
    if (state === 'listened') listened += 1;
    else if (state === 'partial') partial += 1;
  }
  return { total: ids.length, listened, partial, unheard: ids.length - listened - partial };
}

/**
 * The checkpoint carries the spoken text, not just a key.
 *
 * Resuming then needs nothing from the network: the digest it came from may be
 * on another page of upstream's archive by the time you come back, and a
 * scheduled task may have re-run and replaced its output entirely.
 */
export function makeCheckpoint({ id, title = '', subtitle = '', text, segment = 0, total = 0, route = '' }) {
  return { key: PLAYBACK_KEY, id, title, subtitle, text, segment, total, route, at: Date.now() };
}

/** Whether a checkpoint is worth offering again. */
export function isResumable(checkpoint, now = Date.now()) {
  if (!checkpoint || !checkpoint.text || !checkpoint.id) return false;
  if (!(checkpoint.total > 0)) return false;
  if (!(checkpoint.segment > 0)) return false;                // the top is not a resume point
  if (checkpoint.segment >= checkpoint.total) return false;   // it ended; nothing to resume
  return now - (checkpoint.at || 0) <= RESUME_MAX_AGE_MS;
}

/** The day out of a `daily:YYYY-MM-DD` id, or '' for any other kind. */
export function parseDailyId(id = '') {
  return String(id).startsWith('daily:') ? String(id).slice('daily:'.length) : '';
}

/**
 * Where to drop the needle for `id`.
 *
 * The checkpoint is the exact place playback stopped, so it wins when it is for
 * this item. Otherwise fall back to the furthest point the listened record
 * knows about — that still beats starting over. A finished item starts again
 * from the top, because there is nothing left to resume.
 *
 * `total` is how many sentences are queued up *now*. A position is an index
 * into a particular queue, and the daily view has three of them — 快讀, 提要 and
 * 全文 are different lengths of the same day under one id. Sentence 30 of the
 * full read is not sentence 30 of the 提要, so a stored position from a queue
 * of another length is not translated, it is dropped: starting a short read at
 * the top costs a minute, and resuming it in the wrong place costs the rest.
 */
export function resumePoint(checkpoint, record, id, { now = Date.now(), total = 0 } = {}) {
  const fits = (entry) => !total || !entry.total || entry.total === total;
  if (checkpoint && checkpoint.id === id && isResumable(checkpoint, now) && fits(checkpoint)) {
    return checkpoint.segment;
  }
  if (record && !record.done && record.segment > 0 && fits(record)) return record.segment;
  return 0;
}

/**
 * What sort of thing an id names.
 *
 * It matters for chaining: a topic's clip is its channels read end to end, so
 * following a channel with the topic that contains it would say the same words
 * twice. Chaining therefore stays at the granularity it started at.
 */
export function kindOf(id = '') {
  const text = String(id);
  if (text.startsWith('daily:')) return 'daily';
  if (text.startsWith('task:')) return 'task';
  // The infix markers are checked first: a channel called "highlights" ends the
  // same way a digest's highlights id does.
  if (text.includes(':channel:')) return 'channel';
  if (text.includes(':topic:')) return 'topic';
  if (text.endsWith(':highlights')) return 'highlights';
  return '';
}

/**
 * The clips auto-play moves between.
 *
 * A topic's clip is its channels read end to end, so it is not a destination:
 * chaining into it would repeat words its channels already said. It stays a
 * button you can press deliberately, and playing it marks those channels heard.
 * Everything else is content in its own right.
 */
const LEAF_KINDS = new Set(['highlights', 'channel', 'task', 'daily']);

export function isLeaf(id) {
  return LEAF_KINDS.has(kindOf(id));
}

/**
 * The next thing to play after `currentId`: the next clip down the page that
 * carries content of its own and has not been heard, whatever kind it is, or
 * null when the page has nothing left.
 *
 * `playables` is in the order the page renders them, so "next" means next down
 * the page — across topics, across digests, to the end.
 */
export function nextPlayable(playables, currentId, records = new Map()) {
  const at = playables.findIndex((item) => item.id === currentId);
  if (at < 0) return null;
  for (let i = at + 1; i < playables.length; i += 1) {
    const item = playables[i];
    if (!isLeaf(item.id)) continue;
    if (stateOf(records.get(item.id)) === 'listened') continue;
    return item;
  }
  return null;
}

/** The clips that make up `parentId` — a topic's channels. */
export function containedBy(playables, parentId) {
  return playables.filter((item) => item.parentId === parentId);
}

/** Has every clip inside `parentId` been heard? False when it contains nothing. */
export function allContainedHeard(playables, parentId, records = new Map()) {
  const inside = containedBy(playables, parentId);
  return inside.length > 0 && inside.every((item) => stateOf(records.get(item.id)) === 'listened');
}

// ------------------------------------------------------------------ storage

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      // Runs for a fresh database and for an upgrade from v1, which had only
      // the listened store; create whatever is missing rather than assuming.
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PLAYBACK)) db.createObjectStore(PLAYBACK, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('open failed'));
    request.onblocked = () => reject(new Error('blocked'));
  });
}

/**
 * The listened-to set.
 *
 * Reads go through an in-memory mirror so rendering stays synchronous; writes
 * go to both. `persistent` says whether anything actually reached disk, which
 * the UI uses to admit when history will not survive a reload.
 */
// How many times a topic must be skipped before the app says anything.
export const BORED_AFTER = 3;

/**
 * Topics skipped repeatedly without being finished.
 *
 * Taste, inferred rather than asked for. Stopping a clip early is the one
 * signal the reader gives without being prompted, and three in a row on the
 * same topic is a preference — but only a *streak* counts, so one dull morning
 * about a topic you otherwise want does not demote it.
 */
export function boredTopics(skips = {}, threshold = BORED_AFTER) {
  return Object.entries(skips)
    .filter(([, streak]) => streak >= threshold)
    .map(([topic]) => topic)
    .sort();
}

/** A skip lengthens the streak; finishing anything on the topic clears it. */
export function noteSkip(skips = {}, topic, finished = false) {
  if (!topic) return skips;
  const next = { ...skips };
  if (finished) delete next[topic];
  else next[topic] = (next[topic] || 0) + 1;
  return next;
}

/**
 * The voice and rate to open a topic with.
 *
 * Finance wants a brisk WanLung and a transcript wants a slow HiuMaan, and
 * that preference is stable — so it is worth storing per topic rather than
 * being reset by hand twice a day.
 */
export function prefsForTopic(prefs = {}, topic, fallback = {}) {
  const saved = (topic && prefs[topic]) || {};
  return {
    voiceId: saved.voiceId || fallback.voiceId || '',
    rate: saved.rate || fallback.rate || 1,
  };
}

export function rememberTopicPrefs(prefs = {}, topic, { voiceId, rate }) {
  if (!topic) return prefs;
  return { ...prefs, [topic]: { voiceId, rate } };
}

export class ListenStore {
  constructor() {
    this.records = new Map();
    this.playback = null;        // the restored checkpoint, if there was one
    this.persistent = false;
    this._db = null;
  }

  /** Never rejects: a store that cannot persist is still a usable store. */
  static async open() {
    const store = new ListenStore();
    try {
      store._db = await openDb();
      store.persistent = true;
      await store._load();
      store.playback = await store._loadPlayback();
    } catch {
      store.persistent = false;
    }
    return store;
  }

  _load() {
    return new Promise((resolve) => {
      let request;
      try {
        request = this._db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      } catch {
        resolve();
        return;
      }
      request.onsuccess = () => {
        for (const record of request.result || []) this.records.set(record.id, record);
        resolve();
      };
      request.onerror = () => resolve();
    });
  }

  _loadPlayback() {
    return new Promise((resolve) => {
      let request;
      try {
        request = this._db.transaction(PLAYBACK, 'readonly').objectStore(PLAYBACK).get(PLAYBACK_KEY);
      } catch {
        resolve(null);
        return;
      }
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  }

  /** Checkpoint where playback has reached. Cheap enough to call per sentence. */
  savePlayback(fields) {
    const checkpoint = makeCheckpoint(fields);
    this.playback = checkpoint;
    if (this._db) {
      try {
        this._db.transaction(PLAYBACK, 'readwrite').objectStore(PLAYBACK).put(checkpoint);
      } catch {
        this.persistent = false;
      }
    }
    return checkpoint;
  }

  clearPlayback() {
    this.playback = null;
    if (this._db) {
      try {
        this._db.transaction(PLAYBACK, 'readwrite').objectStore(PLAYBACK).delete(PLAYBACK_KEY);
      } catch {
        this.persistent = false;
      }
    }
  }

  get(id) {
    return this.records.get(id);
  }

  stateOf(id) {
    return stateOf(this.records.get(id));
  }

  /** Move an item forward to `segment` of `total`, returning the new record. */
  advance(id, { segment, total, title }) {
    const record = advance(this.records.get(id) || makeRecord({ id }), { segment, total, title });
    record.id = id;
    return this._write(record);
  }

  /** Force an item to heard or unheard, for the manual toggle. */
  set(id, { done, title = '' }) {
    const previous = this.records.get(id);
    const record = makeRecord({
      id,
      title: title || previous?.title || '',
      segment: done ? (previous?.total ? previous.total - 1 : previous?.segment || 0) : 0,
      total: previous?.total || 0,
      done,
    });
    return this._write(record);
  }

  _write(record) {
    this.records.set(record.id, record);
    if (this._db) {
      try {
        this._db.transaction(STORE, 'readwrite').objectStore(STORE).put(record);
      } catch {
        this.persistent = false;      // quota, or the store went away under us
      }
    }
    return record;
  }

  clear() {
    this.records.clear();
    this.clearPlayback();
    if (this._db) {
      try {
        this._db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
      } catch {
        this.persistent = false;
      }
    }
  }
}
