// Playback engine. The player owns the queue and the pacing; a backend owns
// nothing but "say this one segment and tell me when you're done". That seam is
// what lets the same UI drive the browser's voice or the server's Cantonese one.

const KEEPALIVE_MS = 9000;

// 50ms of 8-bit silence. Only ever played to spend a user's tap on an element
// that has nothing else to play yet; see ClipPair.unlock().
const SILENT_CLIP = 'data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

/** Off-screen, or off under a test runner that has no document at all. */
function isHidden() {
  return typeof document !== 'undefined' && document.hidden === true;
}

/**
 * iOS suspends speechSynthesis the moment the screen locks or the tab goes to
 * the background, and offers nothing to ask it otherwise. A served clip plays
 * on an <audio> element, which iOS does keep running — so on these devices the
 * server voice is the only one that can read on past a dark screen.
 */
export function speechStopsInBackground(
  userAgent = navigator.userAgent,
  platform = navigator.platform,
  touchPoints = navigator.maxTouchPoints,
) {
  return /iPhone|iPad|iPod/.test(userAgent)
    || (platform === 'MacIntel' && touchPoints > 1);   // iPadOS reports as a Mac
}

/**
 * Two <audio> elements, played turn about, shared by every backend that wants
 * them.
 *
 * Both halves of that are deliberate. Turn about, because the hand-off between
 * clips is the moment a locked iPhone stops the reading: once a clip ends and
 * nothing is playing, the page is suspended within moments, and an element that
 * still has to go to the network for its bytes will not get there. Parking the
 * next clip on the other element one step ahead makes the hand-off a `play()`
 * on something already in hand.
 *
 * Shared, because iOS grants playback permission per element and only from a
 * real tap. Changing voice builds a new backend, and elements minted with it
 * would arrive unlocked — so the pair outlives the backends that borrow it.
 */
class ClipPair {
  constructor() {
    this.elements = null;
    this.cursor = 0;
  }

  _build() {
    if (this.elements) return this.elements;
    this.elements = [new Audio(), new Audio()];
    for (const audio of this.elements) {
      audio.preload = 'auto';
      audio.clip = null;
      audio.unlocked = false;
    }
    return this.elements;
  }

  get all() { return this._build(); }

  get current() { return this._build()[this.cursor]; }

  get spare() { return this._build()[1 - this.cursor]; }

  swap() { this.cursor = 1 - this.cursor; }

  /**
   * Spend a tap on both elements while we have one. The first hand-off in the
   * middle of an article is exactly where a refusal cannot be recovered from —
   * there is no gesture there to ask with.
   */
  unlock() {
    for (const audio of this.all) {
      if (audio.unlocked || !audio.paused) continue;
      audio.unlocked = true;
      audio.src = SILENT_CLIP;
      audio.clip = null;
      const started = audio.play();
      if (started?.then) {
        started.then(() => audio.pause(), () => { audio.unlocked = false; });
      }
    }
  }
}

export const clips = new ClipPair();

export class WebSpeechBackend {
  static get supported() {
    return typeof speechSynthesis !== 'undefined';
  }

  constructor(voice) {
    this.voice = voice;
    this.id = `web:${voice?.voiceURI || ''}`;
    this.label = voice ? voice.name : '瀏覽器語音';
    this.background = !speechStopsInBackground();
    this._keepalive = null;
  }

  speak(segment, { rate }) {
    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(segment.speak);
      if (this.voice) {
        utterance.voice = this.voice;
        utterance.lang = this.voice.lang;
      }
      utterance.rate = rate;
      utterance.onend = () => {
        this._stopKeepalive();
        resolve();
      };
      utterance.onerror = (event) => {
        this._stopKeepalive();
        // "interrupted"/"canceled" are our own cancel() landing; not real failures.
        if (event.error === 'interrupted' || event.error === 'canceled') resolve();
        else reject(new Error(event.error || 'speech failed'));
      };
      speechSynthesis.speak(utterance);
      this._startKeepalive();
    });
  }

  // Chrome drops long utterances after ~15s of speaking; a pause/resume pair on a
  // timer keeps the queue alive. Harmless on engines that don't need it.
  _startKeepalive() {
    this._stopKeepalive();
    this._keepalive = setInterval(() => {
      if (speechSynthesis.speaking && !speechSynthesis.paused) {
        speechSynthesis.pause();
        speechSynthesis.resume();
      }
    }, KEEPALIVE_MS);
  }

  _stopKeepalive() {
    if (this._keepalive) clearInterval(this._keepalive);
    this._keepalive = null;
  }

  cancel() {
    this._stopKeepalive();
    speechSynthesis.cancel();
  }

  pause() {
    speechSynthesis.pause();
    return speechSynthesis.paused === true;
  }

  resume() {
    speechSynthesis.resume();
  }

  prefetch() {}

  dispose() {
    this.cancel();
  }
}

let ttsToken = '';

/** The shared secret for /api/tts, if this install wants one. */
export function setTtsToken(token) { ttsToken = token || ''; }

export class ServerTtsBackend {
  constructor(voiceId, label) {
    this.voiceId = voiceId;
    this.id = `server:${voiceId}`;
    this.label = label;
    this.background = true;   // an <audio> element survives a locked screen
    this._prefetched = new Set();
  }

  url(segment, rate) {
    const percent = Math.round((rate - 1) * 100);
    const sign = percent >= 0 ? '+' : '-';
    const params = new URLSearchParams({
      text: segment.speak,
      voice: this.voiceId,
      rate: `${sign}${Math.abs(percent)}%`,
    });
    // An <audio> element cannot send a header, so the token travels in the
    // query string or not at all. It is the same string either way; what keeps
    // it off a stranger's screen is that the server never hands it out.
    if (ttsToken) params.set('token', ttsToken);
    return `/api/tts?${params}`;
  }

  speak(segment, { rate }) {
    return new Promise((resolve, reject) => {
      const url = this.url(segment, rate);
      // prefetch() parked this clip on the spare a step ago; playing it where
      // it already sits costs no network round trip, which is what carries the
      // hand-off across a screen that has just gone dark.
      if (clips.spare.clip === url) clips.swap();
      const audio = clips.current;
      const cleanup = () => {
        audio.onended = null;
        audio.onerror = null;
      };
      audio.onended = () => {
        cleanup();
        resolve();
      };
      audio.onerror = () => {
        cleanup();
        // A cancel() clears src, which also fires onerror; that isn't a failure.
        if (!audio.src || audio.src.endsWith('#cancelled')) resolve();
        else reject(new Error('伺服器語音載入失敗'));
      };
      if (audio.clip !== url) {
        audio.clip = url;
        audio.src = url;
      } else if (audio.currentTime) {
        // Already played once — rewind, but only when it has loaded far enough
        // to have a timeline to seek on.
        try { audio.currentTime = 0; } catch { /* not seekable yet; starts at 0 anyway */ }
      }
      audio.play().catch(reject);
    });
  }

  // Warm the server's LRU and the HTTP cache one segment ahead, and park the
  // clip on the spare element so the next hand-off needs nothing but play().
  // iOS often declines to preload and waits for that play(), which is why the
  // fetch stays: it is what actually guarantees the bytes are local by then.
  prefetch(segment, { rate }) {
    if (!segment) return;
    const url = this.url(segment, rate);
    const spare = clips.spare;
    if (spare.clip !== url) {
      spare.onended = null;
      spare.onerror = null;
      spare.clip = url;
      spare.src = url;
      spare.load();
    }
    if (this._prefetched.has(url)) return;
    this._prefetched.add(url);
    if (this._prefetched.size > 40) this._prefetched.clear();
    fetch(url).catch(() => this._prefetched.delete(url));
  }

  cancel() {
    for (const audio of clips.all) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.clip = null;
      audio.load();
    }
  }

  pause() {
    clips.current.pause();
    return true;
  }

  resume() {
    clips.current.play().catch(() => {});
  }

  dispose() {
    this.cancel();
  }
}

export class Player {
  constructor({ onSegment, onStatus, onFinish, onError } = {}) {
    this.segments = [];
    this.backend = null;
    this.rate = 1;
    this.index = 0;
    this.status = 'idle';          // idle | playing | paused
    this._generation = 0;
    this._resumeGate = null;
    this._nativePause = true;
    this.onSegment = onSegment || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onFinish = onFinish || (() => {});
    this.onError = onError || (() => {});
  }

  load(segments, backend) {
    this.stop();
    this.segments = segments;
    this.setBackend(backend);
    this.index = 0;
  }

  setBackend(backend) {
    if (this.backend && this.backend !== backend) this.backend.dispose();
    this.backend = backend;
  }

  setRate(rate) {
    this.rate = rate;
    if (this.status === 'playing') this.play(this.index);   // restart segment at the new rate
  }

  play(index = this.index) {
    this.index = Math.max(0, Math.min(index, this.segments.length - 1));
    this._cancelCurrent();
    this._setStatus('playing');
    this._run(++this._generation);
  }

  toggle() {
    if (this.status === 'playing') this.pause();
    else if (this.status === 'paused') this.resume();
    else this.play(this.index);
  }

  pause() {
    if (this.status !== 'playing') return;
    this._nativePause = this.backend.pause();
    if (!this._nativePause) this.backend.cancel();   // engine can't pause: replay on resume
    this._setStatus('paused');
  }

  resume() {
    if (this.status !== 'paused') return;
    if (this._nativePause) {
      this.backend.resume();
      this._setStatus('playing');
      if (this._resumeGate) {
        const release = this._resumeGate;
        this._resumeGate = null;
        release();
      }
    } else {
      this.play(this.index);
    }
  }

  stop() {
    this._generation++;
    this._cancelCurrent();
    this._setStatus('idle');
  }

  seek(index) {
    const wasPlaying = this.status === 'playing';
    this.index = Math.max(0, Math.min(index, this.segments.length - 1));
    if (wasPlaying) this.play(this.index);
    else this.onSegment(this.index, this.segments[this.index]);
  }

  next() {
    if (this.index >= this.segments.length - 1) return this.stop();
    this.seek(this.index + 1);
  }

  prev() {
    this.seek(this.index - 1);
  }

  _cancelCurrent() {
    if (this.backend) this.backend.cancel();
    this._resumeGate = null;
  }

  async _run(generation) {
    while (generation === this._generation && this.index < this.segments.length) {
      const segment = this.segments[this.index];
      this.onSegment(this.index, segment);
      // Claim this segment's clip before asking for the next one: the backend
      // parks the lookahead on whichever element is idle, so prefetching first
      // would overwrite the very clip we are about to play.
      const spoken = this.backend.speak(segment, { rate: this.rate });
      this.backend.prefetch(this.segments[this.index + 1], { rate: this.rate });
      try {
        await spoken;
      } catch (error) {
        if (generation !== this._generation) return;
        this._setStatus('idle');
        this.onError(error);
        return;
      }
      if (generation !== this._generation) return;
      await this._gap(segment.pauseAfter, generation);
      if (generation !== this._generation) return;
      this.index += 1;
    }
    if (generation !== this._generation) return;
    this._setStatus('idle');
    this.index = 0;
    this.onFinish();
  }

  async _gap(ms, generation) {
    // With the page hidden the pause between sentences buys nothing — nobody is
    // reading along — and it costs everything: a locked iPhone suspends the page
    // within moments of the audio falling silent, and this timer is precisely
    // the one that never comes back. Hand straight on to the next clip instead.
    const delay = isHidden() ? 0 : ms / this.rate;
    await new Promise((resolve) => setTimeout(resolve, delay));
    // Paused during the gap: hold here until resume() releases us.
    while (this.status === 'paused' && generation === this._generation) {
      await new Promise((resolve) => {
        this._resumeGate = resolve;
      });
    }
  }

  _setStatus(status) {
    this.status = status;
    this.onStatus(status, this.index);
  }
}

/**
 * Rank the browser's voices: Cantonese first, then other Chinese, then the rest.
 * Within a tier an on-device voice wins — Safari's Sinji synthesises locally and
 * works offline, while Chrome's "Google 粤語（香港）" ships the text to Google.
 * That distinction is `localService`, which beats sniffing the platform.
 */
export function rankVoices(voices) {
  const score = (voice) => {
    const lang = (voice.lang || '').replace('_', '-').toLowerCase();
    const name = voice.name || '';
    if (lang.startsWith('zh-hk') || lang.startsWith('yue')) return 3;
    if (/粵|粤|廣東話|广东话|cantonese|sinji|hiugaai|hiumaan|wanlung/i.test(name)) return 3;
    if (lang.startsWith('zh-tw') || lang.startsWith('zh-hant')) return 2;
    if (lang.startsWith('zh')) return 1;
    return 0;
  };
  return voices
    .map((voice) => ({
      voice,
      score: score(voice),
      // Engines that don't report it (Firefox/speech-dispatcher) are local anyway.
      local: voice.localService !== false,
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) =>
      b.score - a.score
      || Number(b.local) - Number(a.local)
      || a.voice.name.localeCompare(b.voice.name));
}

/**
 * Where to find a Cantonese voice on this device, when it hasn't got one.
 * The only place platform detection earns its keep: the instructions differ.
 */
export function installVoiceHint(userAgent = navigator.userAgent, platform = navigator.platform) {
  const isApple = /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(userAgent)
    || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);   // iPadOS reports as a Mac
  if (isApple) return '在「設定 → 輔助功能 → 朗讀內容 → 語音」加入「粵語（香港）」，即可離線朗讀。';
  if (/Android/.test(userAgent)) return '在「設定 → 系統 → 語言與輸入 → 文字轉語音」下載粵語語音資料，即可離線朗讀。';
  if (/Firefox/.test(userAgent)) return 'Firefox 使用系統語音；安裝粵語 speech-dispatcher 語音後便可離線朗讀。';
  return '';
}

/** speechSynthesis populates its voice list asynchronously on most engines. */
export function loadVoices(timeoutMs = 2000) {
  if (!WebSpeechBackend.supported) return Promise.resolve([]);
  const existing = speechSynthesis.getVoices();
  if (existing.length) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      speechSynthesis.onvoiceschanged = null;
      resolve(speechSynthesis.getVoices());
    };
    const timer = setTimeout(done, timeoutMs);
    speechSynthesis.onvoiceschanged = done;
  });
}
