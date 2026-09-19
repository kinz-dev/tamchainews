import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AZURE_VOICES, AzureAccess, OUTPUT_FORMAT, isRegion, ratePercent, ssmlFor,
  tokenEndpoint, ttsEndpoint,
} from '../web/azure.js';

test('a region is a lowercase word, and a typo is caught before it is sent', () => {
  for (const good of ['eastasia', 'southeastasia', 'westus2', 'uk-south']) {
    assert.ok(isRegion(good), good);
  }
  for (const bad of ['', '  ', 'East Asia', 'eastasia/', 'https://eastasia', undefined, null]) {
    assert.ok(!isRegion(bad), String(bad));
  }
});

test('the endpoints are the documented ones, per region', () => {
  assert.equal(ttsEndpoint('eastasia'),
               'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(tokenEndpoint('eastasia'),
               'https://eastasia.api.cognitive.microsoft.com/sts/v1.0/issueToken');
});

test('rate becomes the signed percentage Azure expects', () => {
  assert.equal(ratePercent(1), '+0%');
  assert.equal(ratePercent(1.5), '+50%');
  assert.equal(ratePercent(0.8), '-20%');
  assert.equal(ratePercent(2), '+100%');
  assert.equal(ratePercent(undefined), '+0%');
});

test('the text is escaped, so a stray & is a word and not a 400', () => {
  const ssml = ssmlFor('AT&T 同 <b> 同 "引號"', { voice: 'zh-HK-HiuGaaiNeural' });
  assert.ok(ssml.includes('AT&amp;T'));
  assert.ok(ssml.includes('&lt;b&gt;'));
  assert.ok(!/<b>/.test(ssml));
  // One <voice> open and one close: escaping must not have broken the envelope.
  assert.equal(ssml.match(/<voice /g).length, 1);
  assert.ok(ssml.startsWith('<speak version="1.0"'));
  assert.ok(ssml.endsWith('</voice></speak>'));
});

test('the voice and the rate land in the envelope', () => {
  const ssml = ssmlFor('一句', { voice: 'zh-HK-WanLungNeural', rate: 1.25 });
  assert.ok(ssml.includes('name="zh-HK-WanLungNeural"'));
  assert.ok(ssml.includes('rate="+25%"'));
  assert.ok(ssml.includes('xml:lang="zh-HK"'));
});

/** A fetch that records what it was asked and answers what it was told to. */
function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (typeof next === 'function') return next(url, init);
    return next;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const ok = (body) => ({
  ok: true, status: 200,
  json: async () => body,
  arrayBuffer: async () => new ArrayBuffer(64),
});

test('server mode asks this box for a token and sends it as a bearer', async () => {
  const fetchImpl = fakeFetch([ok({ token: 'T1', region: 'eastasia', expires_in: 540 }),
                               ok({})]);
  const access = new AzureAccess({ mode: 'server', fetchImpl });
  await access.speak('一句', { voice: AZURE_VOICES[0].id });

  assert.equal(fetchImpl.calls[0].url, '/api/speech-token');
  const synth = fetchImpl.calls[1];
  assert.equal(synth.url, ttsEndpoint('eastasia'), 'the region comes from the token response');
  assert.equal(synth.init.headers.Authorization, 'Bearer T1');
  assert.equal(synth.init.headers['X-Microsoft-OutputFormat'], OUTPUT_FORMAT);
  assert.equal(synth.init.headers['Content-Type'], 'application/ssml+xml');
  assert.ok(!('Ocp-Apim-Subscription-Key' in synth.init.headers), 'the key never reaches here');
});

test('a token is reused until it is nearly up, then minted again', async () => {
  let clock = 1_000_000;
  const fetchImpl = fakeFetch([
    ok({ token: 'T1', region: 'eastasia', expires_in: 540 }), ok({}),
    ok({}),
    ok({ token: 'T2', region: 'eastasia', expires_in: 540 }), ok({}),
  ]);
  const access = new AzureAccess({ mode: 'server', fetchImpl, now: () => clock });
  await access.speak('一', { voice: 'v' });
  clock += 100_000;                       // well inside the ten minutes
  await access.speak('二', { voice: 'v' });
  assert.equal(fetchImpl.calls.filter((c) => c.url === '/api/speech-token').length, 1);

  clock += 400_000;                       // past the renew-a-minute-early mark
  await access.speak('三', { voice: 'v' });
  const minted = fetchImpl.calls.filter((c) => c.url === '/api/speech-token');
  assert.equal(minted.length, 2, 'a token that expires mid-sentence is a dead clip');
  assert.equal(fetchImpl.calls.at(-1).init.headers.Authorization, 'Bearer T2');
});

test('key mode sends the key itself, because a token would protect nothing', async () => {
  const fetchImpl = fakeFetch([ok({})]);
  const access = new AzureAccess({ mode: 'key', key: 'SECRET', region: 'eastasia', fetchImpl });
  await access.speak('一句', { voice: AZURE_VOICES[0].id });

  assert.equal(fetchImpl.calls.length, 1, 'no token round trip');
  const headers = fetchImpl.calls[0].init.headers;
  assert.equal(headers['Ocp-Apim-Subscription-Key'], 'SECRET');
  assert.ok(!('Authorization' in headers));
});

test('a CORS refusal is reported as one, not as a shrug', async () => {
  // A browser hands script an opaque TypeError for a blocked cross-origin
  // request — identical to the network being down, which is exactly why the
  // message has to name both possibilities.
  const fetchImpl = fakeFetch([() => { throw new TypeError('Failed to fetch'); }]);
  const access = new AzureAccess({ mode: 'key', key: 'K', region: 'eastasia', fetchImpl });
  await assert.rejects(() => access.speak('一', { voice: 'v' }), /CORS|網絡/);
});

test('a rejected credential says which credential it was', async () => {
  const denied = { ok: false, status: 401, json: async () => ({}), arrayBuffer: async () => null };
  const byKey = new AzureAccess({ mode: 'key', key: 'K', region: 'eastasia',
                                  fetchImpl: fakeFetch([denied]) });
  await assert.rejects(() => byKey.speak('一', { voice: 'v' }), /key/);

  const byToken = new AzureAccess({ mode: 'server',
                                    fetchImpl: fakeFetch([ok({ token: 'T', region: 'eastasia' }), denied]) });
  await assert.rejects(() => byToken.speak('一', { voice: 'v' }), /token/);
});

test('a bad region is refused before anything is sent', async () => {
  const fetchImpl = fakeFetch([]);
  const access = new AzureAccess({ mode: 'key', key: 'K', region: 'East Asia', fetchImpl });
  await assert.rejects(() => access.speak('一', { voice: 'v' }), /region/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a server with no token at all is an error, not an empty bearer', async () => {
  const fetchImpl = fakeFetch([ok({ error: 'azure not configured' })]);
  const access = new AzureAccess({ mode: 'server', fetchImpl });
  await assert.rejects(() => access.speak('一', { voice: 'v' }), /azure not configured/);
});

test('this browser own key wins over the box, and neither means no Azure', () => {
  const held = AzureAccess.fromSettings({ azureKey: 'K', azureRegion: 'eastasia' }, true);
  assert.equal(held.mode, 'key', 'a key typed in here is the one the person chose');
  assert.equal(held.region, 'eastasia');

  assert.equal(AzureAccess.fromSettings({}, true).mode, 'server');
  assert.equal(AzureAccess.fromSettings({}, false), null);
  // Half-filled is not configured: a key with no region cannot address anything.
  assert.equal(AzureAccess.fromSettings({ azureKey: 'K' }, false), null);
  assert.equal(AzureAccess.fromSettings({ azureKey: 'K', azureRegion: 'bad region' }, false), null);
});
