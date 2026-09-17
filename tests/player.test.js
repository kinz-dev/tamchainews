import assert from 'node:assert/strict';
import test from 'node:test';
import { Player, rankVoices, installVoiceHint } from '../web/player.js';
import { prepare } from '../web/speech.js';

/** Stands in for a speech engine: records what it was asked to say. */
class StubBackend {
  constructor({ failOn = null } = {}) {
    this.spoken = [];
    this.prefetched = [];
    this.cancels = 0;
    this.nativePause = true;
    this.paused = false;
    this._failOn = failOn;
    this._pending = null;
  }

  speak(segment) {
    this.spoken.push(segment.speak);
    if (this._failOn === segment.speak) return Promise.reject(new Error('boom'));
    return new Promise((resolve) => {
      this._pending = resolve;
    });
  }

  /** Let the segment currently being "spoken" finish. */
  finishSegment() {
    const resolve = this._pending;
    this._pending = null;
    if (resolve) resolve();
  }

  prefetch(segment) { if (segment) this.prefetched.push(segment.speak); }
  cancel() { this.cancels += 1; this._pending = null; }
  pause() { this.paused = true; return this.nativePause; }
  resume() { this.paused = false; }
  dispose() { this.cancel(); }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Wait for a condition the player reaches asynchronously (it paces with timers). */
async function until(condition, label, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function makePlayer(markdown, backendOptions) {
  const { segments } = prepare(markdown);
  const events = { segments: [], statuses: [], finished: 0, errors: [] };
  const player = new Player({
    onSegment: (index) => events.segments.push(index),
    onStatus: (status) => events.statuses.push(status),
    onFinish: () => { events.finished += 1; },
    onError: (error) => events.errors.push(error.message),
  });
  const backend = new StubBackend(backendOptions);
  player.load(segments, backend);
  return { player, backend, events, segments };
}

test('playback walks the queue in order and reports finishing', async () => {
  const { player, backend, events, segments } = makePlayer('一。二。三。');
  assert.equal(segments.length, 3);
  player.rate = 100;                      // collapse the inter-segment gaps
  player.play(0);
  for (let i = 0; i < segments.length; i += 1) {
    await until(() => backend.spoken.length === i + 1, `segment ${i} to start`);
    backend.finishSegment();
  }
  await until(() => events.finished === 1, 'playback to finish');
  assert.deepEqual(backend.spoken, ['一。', '二。', '三。']);
  assert.equal(events.finished, 1);
  assert.equal(player.status, 'idle');
  assert.equal(player.index, 0, 'finishing rewinds for the next play');
});

test('the next segment is prefetched while the current one plays', async () => {
  const { player, backend } = makePlayer('一。二。三。');
  player.play(0);
  await tick();
  assert.deepEqual(backend.prefetched, ['二。']);
});

test('pause holds the queue and resume continues from the same segment', async () => {
  const { player, backend } = makePlayer('一。二。三。');
  player.play(0);
  await tick();
  player.pause();
  assert.equal(player.status, 'paused');
  assert.equal(backend.paused, true);
  assert.equal(backend.cancels, 1, 'only the load() cancel; a native pause keeps the utterance');
  player.resume();
  assert.equal(player.status, 'playing');
  assert.deepEqual(backend.spoken, ['一。']);
});

test('an engine that cannot pause replays the segment on resume', async () => {
  const { player, backend } = makePlayer('一。二。三。');
  backend.nativePause = false;
  player.play(0);
  await tick();
  player.pause();
  assert.ok(backend.cancels >= 2, 'the un-pausable engine is cancelled instead');
  player.resume();
  await tick();
  assert.deepEqual(backend.spoken, ['一。', '一。']);
});

test('seeking restarts at the chosen segment while playing', async () => {
  const { player, backend } = makePlayer('一。二。三。');
  player.play(0);
  await tick();
  player.seek(2);
  await tick();
  assert.deepEqual(backend.spoken, ['一。', '三。']);
  assert.equal(player.index, 2);
});

test('seeking while idle moves the highlight without speaking', async () => {
  const { player, backend, events } = makePlayer('一。二。三。');
  player.seek(1);
  await tick();
  assert.deepEqual(backend.spoken, []);
  assert.equal(events.segments.at(-1), 1);
});

test('next past the end stops rather than running off the queue', async () => {
  const { player } = makePlayer('一。二。');
  player.seek(1);
  player.next();
  assert.equal(player.status, 'idle');
});

test('prev clamps at the first segment', async () => {
  const { player } = makePlayer('一。二。');
  player.prev();
  assert.equal(player.index, 0);
});

test('a backend failure surfaces once and halts playback', async () => {
  const { player, events } = makePlayer('一。二。', { failOn: '一。' });
  player.play(0);
  await tick();
  await tick();
  assert.deepEqual(events.errors, ['boom']);
  assert.equal(player.status, 'idle');
});

test('stop cancels the in-flight segment and a stale one cannot resume it', async () => {
  const { player, backend } = makePlayer('一。二。三。');
  player.play(0);
  await tick();
  const cancelsBefore = backend.cancels;
  player.stop();
  assert.equal(backend.cancels, cancelsBefore + 1);
  backend.finishSegment();               // the abandoned run must not advance
  await tick();
  await tick();
  assert.deepEqual(backend.spoken, ['一。']);
});

test('voices are ranked Cantonese first and non-Chinese dropped', () => {
  const ranked = rankVoices([
    { name: 'Alex', lang: 'en-US', voiceURI: 'a' },
    { name: 'Google 國語（臺灣）', lang: 'zh-TW', voiceURI: 'b' },
    { name: 'Sinji', lang: 'zh-HK', voiceURI: 'c' },
    { name: 'Google 普通话', lang: 'zh-CN', voiceURI: 'd' },
  ]);
  assert.deepEqual(ranked.map((entry) => entry.voice.voiceURI), ['c', 'b', 'd']);
});

test('a Cantonese voice is recognised from its name when the lang tag is vague', () => {
  const ranked = rankVoices([{ name: 'Google 粤語（香港）', lang: 'zh', voiceURI: 'x' }]);
  assert.equal(ranked[0].score, 3);
});

test('an on-device Cantonese voice outranks a cloud one', () => {
  const ranked = rankVoices([
    { name: 'Google 粤語（香港）', lang: 'zh-HK', voiceURI: 'cloud', localService: false },
    { name: 'Sinji', lang: 'zh-HK', voiceURI: 'sinji', localService: true },
  ]);
  assert.deepEqual(ranked.map((entry) => entry.voice.voiceURI), ['sinji', 'cloud']);
  assert.deepEqual(ranked.map((entry) => entry.local), [true, false]);
});

test('being on-device never beats actually speaking Cantonese', () => {
  const ranked = rankVoices([
    { name: 'Google 粤語（香港）', lang: 'zh-HK', voiceURI: 'yue-cloud', localService: false },
    { name: '聆小美', lang: 'zh-TW', voiceURI: 'cmn-local', localService: true },
  ]);
  assert.equal(ranked[0].voice.voiceURI, 'yue-cloud');
});

test('an engine that omits localService is treated as on-device', () => {
  const ranked = rankVoices([{ name: 'Cantonese', lang: 'zh-HK', voiceURI: 'x' }]);
  assert.equal(ranked[0].local, true);
});

test('the install hint is tailored to the platform', () => {
  assert.match(installVoiceHint('… (Macintosh; Intel Mac OS X 10_15_7) Safari', 'MacIntel'), /輔助功能/);
  assert.match(installVoiceHint('… (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari', 'iPhone'), /輔助功能/);
  assert.match(installVoiceHint('… (Linux; Android 14) Chrome', 'Linux armv8l'), /文字轉語音/);
  assert.match(installVoiceHint('… (X11; Linux x86_64; rv:130.0) Gecko Firefox/130.0', 'Linux x86_64'), /speech-dispatcher/);
  assert.equal(installVoiceHint('… (X11; Linux x86_64) Chrome/140', 'Linux x86_64'), '');
});
