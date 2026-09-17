// Playback engine. The player owns the queue and the pacing; a backend owns
// nothing but "say this one segment and tell me when you're done". That seam is
// what lets the same UI drive the browser's voice or the server's Cantonese one.

const KEEPALIVE_MS = 9000;

export class WebSpeechBackend {
  static get supported() {
    return typeof speechSynthesis !== 'undefined';
  }

  constructor(voice) {
    this.voice = voice;
    this.id = `web:${voice?.voiceURI || ''}`;
    this.label = voice ? voice.name : '瀏覽器語音';
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

export class ServerTtsBackend {
  constructor(voiceId, label) {
    this.voiceId = voiceId;
    this.id = `server:${voiceId}`;
    this.label = label;
    this.audio = new Audio();
    this.audio.preload = 'auto';
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
    return `/api/tts?${params}`;
  }

  speak(segment, { rate }) {
    return new Promise((resolve, reject) => {
      const audio = this.audio;
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
      audio.src = this.url(segment, rate);
      audio.play().catch(reject);
    });
  }

  // Warm the server's LRU (and the browser cache) one segment ahead.
  prefetch(segment, { rate }) {
    if (!segment) return;
    const url = this.url(segment, rate);
    if (this._prefetched.has(url)) return;
    this._prefetched.add(url);
    if (this._prefetched.size > 40) this._prefetched.clear();
    fetch(url).catch(() => this._prefetched.delete(url));
  }

  cancel() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  pause() {
    this.audio.pause();
    return true;
  }

  resume() {
    this.audio.play().catch(() => {});
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
      this.backend.prefetch(this.segments[this.index + 1], { rate: this.rate });
      try {
        await this.backend.speak(segment, { rate: this.rate });
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
    await new Promise((resolve) => setTimeout(resolve, ms / this.rate));
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
