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
 */
export function resumePoint(checkpoint, record, id, now = Date.now()) {
  if (checkpoint && checkpoint.id === id && isResumable(checkpoint, now)) {
    return checkpoint.segment;
  }
  if (record && !record.done && record.segment > 0) return record.segment;
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
 * The next thing to play after `currentId`: the following clip of the same kind
 * that has not been heard yet, or null at the end of the run.
 *
 * `playables` is in the order the page renders them, so "next" means next down
 * the page.
 */
export function nextPlayable(playables, currentId, records = new Map()) {
  const at = playables.findIndex((item) => item.id === currentId);
  if (at < 0) return null;
  const kind = kindOf(currentId);
  for (let i = at + 1; i < playables.length; i += 1) {
    const item = playables[i];
    if (kindOf(item.id) !== kind) continue;
    if (stateOf(records.get(item.id)) === 'listened') continue;
    return item;
  }
  return null;
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
