import { prepare, estimateSeconds } from './speech.js';
import { Player, WebSpeechBackend, ServerTtsBackend, rankVoices, loadVoices, installVoiceHint } from './player.js';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const STORE_KEY = 'tamchainews.settings.v1';

const dom = {
  banner: document.getElementById('banner'),
  dayList: document.getElementById('day-list'),
  readerMeta: document.getElementById('reader-meta'),
  readerBody: document.getElementById('reader-body'),
  voiceSelect: document.getElementById('voice-select'),
  rateSelect: document.getElementById('rate-select'),
  autoplayNext: document.getElementById('autoplay-next'),
  refresh: document.getElementById('refresh'),
  prev: document.getElementById('prev'),
  next: document.getElementById('next'),
  stop: document.getElementById('stop'),
  toggle: document.getElementById('toggle'),
  progress: document.getElementById('progress'),
  progressFill: document.querySelector('#progress span'),
  progressLabel: document.getElementById('progress-label'),
};

const settings = loadSettings();
const state = {
  days: [],
  ttsVoices: [],
  browserVoices: [],
  current: null,      // { day, blocks, segments, spans }
  wakeLock: null,
};

const player = new Player({
  onSegment: handleSegment,
  onStatus: handleStatus,
  onFinish: handleFinish,
  onError: (error) => showBanner(`播放失敗：${error.message}`, { error: true }),
});

// ------------------------------------------------------------------ settings

function loadSettings() {
  const defaults = { voiceId: null, rate: 1, autoplayNext: false, positions: {}, dismissed: {} };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode: settings just don't persist */
  }
}

// ---------------------------------------------------------------------- data

async function loadDays({ force = false } = {}) {
  dom.refresh.disabled = true;
  try {
    const response = await fetch(`/api/daily${force ? '?refresh=1' : ''}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.days = payload.days || [];
    state.ttsVoices = payload.tts_voices || [];
    renderDays();
    buildVoiceOptions();
    if (payload.upstream_error) {
      showBanner(`新聞來源連線失敗，顯示快取內容（${payload.upstream_error}）`, { error: true });
    } else {
      hideBanner();
      announceVoiceFallback();
    }
    if (state.days.length) selectDay(state.current?.day?.day || state.days[0].day);
    else dom.readerBody.innerHTML = '<p class="placeholder">沒有可用的每日摘要。</p>';
  } catch (error) {
    showBanner(`載入新聞失敗：${error.message}`, { error: true });
  } finally {
    dom.refresh.disabled = false;
  }
}

// -------------------------------------------------------------------- render

function renderDays() {
  dom.dayList.innerHTML = '';
  for (const day of state.days) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'day-card';
    button.dataset.day = day.day;
    button.innerHTML = `
      <div class="date"><span>${formatDate(day.day)}</span><span class="weekday">${weekday(day.day)}</span></div>
      <div class="headline">${escapeHtml(day.headline)}</div>
      <div class="len">約 ${Math.round(day.est_seconds / 60)} 分鐘 · ${day.chars} 字</div>`;
    button.addEventListener('click', () => selectDay(day.day, { autoplay: true }));
    item.appendChild(button);
    dom.dayList.appendChild(item);
  }
}

function selectDay(dayId, { autoplay = false, fromStart = false } = {}) {
  const day = state.days.find((d) => d.day === dayId);
  if (!day) return;

  const { blocks, segments } = prepare(day.text);
  dom.readerBody.innerHTML = '';
  const spans = [];
  let segmentIndex = 0;

  for (const block of blocks) {
    const element = document.createElement(block.kind.startsWith('h') ? block.kind : 'p');
    if (block.kind === 'li') element.className = `li indent-${block.indent}`;
    for (const segment of block.segments) {
      const span = document.createElement('span');
      span.className = 'seg';
      span.dataset.index = String(segmentIndex);
      span.textContent = segment.text;
      span.addEventListener('click', () => player.seek(Number(span.dataset.index)));
      element.appendChild(span);   // no separator: CJK prose doesn't space its sentences
      spans.push(span);
      segmentIndex += 1;
    }
    dom.readerBody.appendChild(element);
  }

  state.current = { day, blocks, segments, spans };
  dom.readerMeta.textContent =
    `${formatDate(day.day)}（${weekday(day.day)}） · ${segments.length} 句 · ` +
    `約 ${formatClock(estimateSeconds(segments, settings.rate))}`;
  for (const button of dom.dayList.querySelectorAll('.day-card')) {
    button.setAttribute('aria-current', String(button.dataset.day === dayId));
  }

  player.load(segments, makeBackend());
  player.rate = settings.rate;
  const resumeAt = fromStart ? 0 : settings.positions[day.day] || 0;
  player.index = Math.min(resumeAt, segments.length - 1);
  handleSegment(player.index, segments[player.index]);
  updateMediaSession(day);
  if (autoplay) player.play(player.index);
  else updateProgress();
}

// ------------------------------------------------------------------- voices

function buildVoiceOptions() {
  dom.voiceSelect.innerHTML = '';
  const cantonese = rankVoices(state.browserVoices);

  if (cantonese.length) {
    const group = document.createElement('optgroup');
    group.label = '瀏覽器語音';
    for (const { voice, score, local } of cantonese) {
      const option = document.createElement('option');
      option.value = `web:${voice.voiceURI}`;
      option.textContent =
        `${voice.name} · ${score === 3 ? '粵語' : voice.lang} · ${local ? '裝置內' : '雲端'}`;
      group.appendChild(option);
    }
    dom.voiceSelect.appendChild(group);
  }

  if (state.ttsVoices.length) {
    const group = document.createElement('optgroup');
    group.label = '伺服器語音（粵語）';
    for (const voice of state.ttsVoices) {
      const option = document.createElement('option');
      option.value = `server:${voice.id}`;
      option.textContent = `${voice.name} · 粵語`;
      group.appendChild(option);
    }
    dom.voiceSelect.appendChild(group);
  }

  if (!dom.voiceSelect.options.length) {
    dom.voiceSelect.innerHTML = '<option value="">沒有可用語音</option>';
    return;
  }

  const wanted = settings.voiceId && [...dom.voiceSelect.options].some((o) => o.value === settings.voiceId)
    ? settings.voiceId
    : defaultVoiceId(cantonese);
  dom.voiceSelect.value = wanted;
  settings.voiceId = wanted;
  saveSettings();
}

// The whole point of the server fallback: pick a real Cantonese voice if the
// browser has one, otherwise reach for the server's rather than a Mandarin one.
// rankVoices already puts an on-device Cantonese voice (Sinji) ahead of a cloud
// one (Google 粤語), so taking the first match prefers offline synthesis.
function defaultVoiceId(rankedBrowserVoices) {
  const nativeCantonese = rankedBrowserVoices.find((entry) => entry.score === 3);
  if (nativeCantonese) return `web:${nativeCantonese.voice.voiceURI}`;
  if (state.ttsVoices.length) return `server:${state.ttsVoices[0].id}`;
  return dom.voiceSelect.options[0]?.value || '';
}

function announceVoiceFallback() {
  const selected = settings.voiceId || '';
  const ranked = rankVoices(state.browserVoices);
  if (selected.startsWith('server:')) {
    if (!ranked.some((entry) => entry.score === 3)) {
      showBanner(`本機瀏覽器沒有粵語語音，已自動改用伺服器粵語語音。${installVoiceHint()}`,
        { id: 'no-cantonese-voice' });
    }
  } else if (selected.startsWith('web:')) {
    const voice = findBrowserVoice(selected);
    const entry = ranked.find((item) => item.voice === voice);
    if (entry && entry.score < 3) {
      showBanner(`目前使用「${voice.name}」（${voice.lang}），並非粵語語音，發音會是國語。${installVoiceHint()}`,
        { error: true });
    } else if (entry && !entry.local) {
      showBanner(`「${voice.name}」是雲端語音，朗讀時文字會傳送至語音供應商。${installVoiceHint()}`,
        { id: `cloud-voice:${voice.voiceURI}` });
    }
  }
}

function findBrowserVoice(voiceId) {
  const uri = voiceId.slice('web:'.length);
  return state.browserVoices.find((voice) => voice.voiceURI === uri) || null;
}

function makeBackend() {
  const voiceId = settings.voiceId || '';
  if (voiceId.startsWith('server:')) {
    const id = voiceId.slice('server:'.length);
    const voice = state.ttsVoices.find((v) => v.id === id);
    return new ServerTtsBackend(id, voice?.name || id);
  }
  if (voiceId.startsWith('web:') && WebSpeechBackend.supported) {
    return new WebSpeechBackend(findBrowserVoice(voiceId));
  }
  return new WebSpeechBackend(null);
}

// ----------------------------------------------------------------- playback

function handleSegment(index, segment) {
  const current = state.current;
  if (!current) return;
  current.spans.forEach((span, i) => {
    span.classList.toggle('active', i === index);
    span.classList.toggle('done', i < index);
  });
  const active = current.spans[index];
  if (active && player.status === 'playing') {
    active.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  settings.positions[current.day.day] = index;
  saveSettings();
  updateProgress(segment);
}

function handleStatus(status) {
  dom.toggle.textContent = status === 'playing' ? '⏸' : '▶';
  if (status === 'playing') requestWakeLock();
  else releaseWakeLock();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = status === 'playing' ? 'playing' : 'paused';
  }
  updateProgress();
}

function handleFinish() {
  const current = state.current;
  if (!current) return;
  settings.positions[current.day.day] = 0;
  saveSettings();
  if (!settings.autoplayNext) {
    updateProgress();
    return;
  }
  const position = state.days.findIndex((d) => d.day === current.day.day);
  const following = state.days[position + 1];
  if (following) selectDay(following.day, { autoplay: true, fromStart: true });
  else showBanner('已讀完所有每日摘要。');
}

function updateProgress(segment) {
  const current = state.current;
  if (!current) return;
  const total = current.segments.length;
  const index = player.index;
  const done = estimateSeconds(current.segments.slice(0, index), settings.rate);
  const all = estimateSeconds(current.segments, settings.rate);
  dom.progressFill.style.width = `${total ? ((index + (player.status === 'playing' ? 1 : 0)) / total) * 100 : 0}%`;
  dom.progress.setAttribute('aria-valuenow', String(Math.round((index / Math.max(total, 1)) * 100)));
  const label = player.status === 'idle' && index === 0 ? '未開始' : `句 ${index + 1}/${total}`;
  dom.progressLabel.textContent =
    `${label} · ${formatClock(done)} / ${formatClock(all)} · ${voiceLabel()}` +
    (segment ? ` · ${segment.text.slice(0, 28)}` : '');
}

function voiceLabel() {
  const option = dom.voiceSelect.selectedOptions[0];
  return option ? option.textContent.split(' · ')[0] : '無語音';
}

// ------------------------------------------------------------------ chrome

function updateMediaSession(day) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: day.headline,
    artist: `譚仔新聞 · ${formatDate(day.day)}`,
    album: '粵語日報',
  });
  navigator.mediaSession.setActionHandler('play', () => player.toggle());
  navigator.mediaSession.setActionHandler('pause', () => player.pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => player.prev());
  navigator.mediaSession.setActionHandler('nexttrack', () => player.next());
}

async function requestWakeLock() {
  if (state.wakeLock || !('wakeLock' in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch {
    /* denied or unsupported; playback still works */
  }
}

function releaseWakeLock() {
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
}

/**
 * `id` marks a notice the user can dismiss for good — a standing fact about their
 * setup, not an error. Without it the banner always shows.
 */
function showBanner(message, { error = false, id = null } = {}) {
  if (id && settings.dismissed[id]) return;
  dom.banner.textContent = message;
  dom.banner.classList.toggle('error', error);
  if (id) {
    const close = document.createElement('button');
    close.className = 'banner-close';
    close.textContent = '✕';
    close.title = '不再顯示';
    close.addEventListener('click', () => {
      settings.dismissed[id] = true;
      saveSettings();
      hideBanner();
    });
    dom.banner.appendChild(close);
  }
  dom.banner.hidden = false;
}

function hideBanner() {
  dom.banner.hidden = true;
}

// ------------------------------------------------------------------ helpers

function formatDate(day) {
  const [, month, date] = day.split('-');
  return `${Number(month)}月${Number(date)}日`;
}

function weekday(day) {
  return `週${WEEKDAYS[new Date(`${day}T12:00:00`).getDay()]}`;
}

function formatClock(seconds) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// -------------------------------------------------------------------- wiring

dom.toggle.addEventListener('click', () => player.toggle());
dom.prev.addEventListener('click', () => player.prev());
dom.next.addEventListener('click', () => player.next());
dom.stop.addEventListener('click', () => player.stop());
dom.refresh.addEventListener('click', () => loadDays({ force: true }));

dom.progress.addEventListener('click', (event) => {
  const current = state.current;
  if (!current) return;
  const bounds = dom.progress.getBoundingClientRect();
  const ratio = (event.clientX - bounds.left) / bounds.width;
  player.seek(Math.floor(ratio * current.segments.length));
});

dom.voiceSelect.addEventListener('change', () => {
  settings.voiceId = dom.voiceSelect.value;
  saveSettings();
  const wasPlaying = player.status === 'playing';
  player.stop();
  player.setBackend(makeBackend());
  hideBanner();
  announceVoiceFallback();
  if (wasPlaying) player.play(player.index);
  else updateProgress();
});

dom.rateSelect.addEventListener('change', () => {
  settings.rate = Number(dom.rateSelect.value);
  saveSettings();
  player.setRate(settings.rate);
  updateProgress();
});

dom.autoplayNext.addEventListener('change', () => {
  settings.autoplayNext = dom.autoplayNext.checked;
  saveSettings();
});

document.addEventListener('keydown', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('select, input, textarea')) return;
  // Space on a focused button is that button's own activation; don't fire twice.
  if (event.key === ' ' && target?.closest('button')) return;
  const actions = {
    ' ': () => player.toggle(),
    ArrowRight: () => player.next(),
    ArrowLeft: () => player.prev(),
    Escape: () => player.stop(),
  };
  const action = actions[event.key];
  if (!action) return;
  event.preventDefault();
  action();
});

// Browsers suspend speechSynthesis when the tab is hidden; reflect that in the UI.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && player.status === 'playing' && settings.voiceId?.startsWith('web:')) player.pause();
});

async function main() {
  dom.rateSelect.value = String(settings.rate);
  dom.autoplayNext.checked = settings.autoplayNext;
  state.browserVoices = await loadVoices();
  await loadDays();
}

main();
