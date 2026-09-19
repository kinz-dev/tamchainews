// Azure Speech, spoken to directly by the browser.
//
// The reader's server voice is `edge-tts`, which reaches a *reverse-engineered*
// consumer endpoint at Microsoft carrying a hardcoded client token. It works,
// and it has no account behind it — so the cost of anyone abusing it is that
// this box's address stops being served one morning, with nobody to appeal to.
// Azure is the same voices through the front door: metered, rotatable, and
// answerable to a key.
//
// Two ways to hold that key, and they are not the same trade:
//
//   **server** — `azure_key` sits in config.json, `/api/speech-token` mints a
//   ten-minute token, and the key never leaves the box. Best where the box is
//   yours and the browsers are many.
//
//   **key** — this browser holds the key itself, in localStorage, and spends
//   its own quota. Nothing has to be configured on the box, and one device can
//   use Azure while another does not. But a subscription key is a *billable*
//   credential in a page's storage, so this is worth choosing deliberately:
//   anyone who can run script on this origin can spend it, and it does not
//   expire the way a token does. Rotate it in the Azure portal, not here.
//
// In key mode the key goes on the request directly rather than minting a token
// first. A token exists to avoid exposing the key — which buys nothing once the
// browser is the thing holding it.

/** The zh-HK neural voices, which are the same ones edge-tts reaches. */
export const AZURE_VOICES = [
  { id: 'zh-HK-HiuGaaiNeural', name: '曉佳（女）' },
  { id: 'zh-HK-HiuMaanNeural', name: '曉曼（女）' },
  { id: 'zh-HK-WanLungNeural', name: '雲龍（男）' },
];

// Same format the podcast renderer writes, so a clip sounds identical however
// it was made: CBR 48 kbps, 24 kHz mono MP3.
export const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

const REGION = /^[a-z0-9-]{2,40}$/;

/** Region names are lowercase words like `eastasia`; anything else is a typo. */
export function isRegion(region) {
  return REGION.test(String(region || '').trim());
}

export function ttsEndpoint(region) {
  return `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
}

export function tokenEndpoint(region) {
  return `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
}

function xml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Azure takes a signed percentage: 1 → "+0%", 1.5 → "+50%", 0.8 → "-20%". */
export function ratePercent(rate = 1) {
  const percent = Math.round((Number(rate) || 1) * 100) - 100;
  return `${percent >= 0 ? '+' : '-'}${Math.abs(percent)}%`;
}

/**
 * One utterance of SSML.
 *
 * The text is escaped rather than trusted: it is upstream's prose, it reaches
 * here through a reader-editable 讀音 table, and an unescaped `&` would turn a
 * sentence into a 400 from Azure — which on a page reading itself aloud looks
 * like the voice silently failing on one sentence in a hundred.
 */
export function ssmlFor(text, { voice, rate = 1, lang = 'zh-HK' } = {}) {
  return '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
    + `xml:lang="${xml(lang)}">`
    + `<voice name="${xml(voice)}">`
    + `<prosody rate="${xml(ratePercent(rate))}">${xml(text)}</prosody>`
    + '</voice></speak>';
}

/**
 * A browser's claim on Azure: where to send, and what to send with it.
 *
 * `mode` is 'server' (ask this box for a ten-minute token) or 'key' (this
 * browser holds the subscription key). Both answer the same two questions, so
 * the back-end that uses it does not care which one it got.
 */
export class AzureAccess {
  constructor({ mode = 'server', key = '', region = '', fetchImpl, now } = {}) {
    this.mode = mode;
    this.key = key;
    this.region = region;
    this._fetch = fetchImpl || ((...args) => fetch(...args));
    this._now = now || (() => Date.now());
    this._token = '';
    this._expires = 0;
  }

  static fromSettings({ azureKey = '', azureRegion = '' } = {}, serverHasKey = false, options = {}) {
    if (azureKey && isRegion(azureRegion)) {
      return new AzureAccess({ mode: 'key', key: azureKey, region: azureRegion.trim(), ...options });
    }
    return serverHasKey ? new AzureAccess({ mode: 'server', ...options }) : null;
  }

  /** Renew a minute early: a token that expires mid-sentence is a dead clip. */
  async _serverToken() {
    if (this._token && this._now() < this._expires - 60000) return this._token;
    const response = await this._fetch('/api/speech-token', { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      throw new Error(`/api/speech-token: ${response.status}`);
    }
    const body = await response.json();
    if (!body.token) throw new Error(body.error || 'no token');
    this._token = body.token;
    this.region = body.region || this.region;
    this._expires = this._now() + (Number(body.expires_in) || 540) * 1000;
    return this._token;
  }

  async headers() {
    if (this.mode === 'key') {
      return { 'Ocp-Apim-Subscription-Key': this.key };
    }
    return { Authorization: `Bearer ${await this._serverToken()}` };
  }

  /**
   * Synthesise one string, or throw something a person can act on.
   *
   * The failures worth telling apart are all of them: a browser reports a CORS
   * refusal as an opaque `TypeError`, indistinguishable from the network being
   * down, and *whether Azure answers a browser at all* is the one thing about
   * this integration nobody can check without a key. So the message says which
   * it looked like rather than "failed".
   */
  async speak(text, { voice, rate = 1 } = {}) {
    if (!isRegion(this.region) && this.mode === 'key') {
      throw new Error('Azure region 格式唔啱');
    }
    const headers = await this.headers();
    let response;
    try {
      response = await this._fetch(ttsEndpoint(this.region), {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
        },
        body: ssmlFor(text, { voice, rate }),
      });
    } catch (cause) {
      throw new Error('連唔到 Azure — 可能係 CORS 或者網絡問題', { cause });
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(this.mode === 'key' ? 'Azure key 或 region 唔啱' : 'Azure 拒絕咗個 token');
    }
    if (!response.ok) {
      throw new Error(`Azure ${response.status}`);
    }
    return response.arrayBuffer();
  }
}
