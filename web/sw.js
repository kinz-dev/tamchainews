// The offline half of the PWA. Nothing here runs on the box.
//
// The MTR is the case: a home-screen app that cannot open in a tunnel is a
// bookmark. Apple Podcasts downloads for you; a PWA does not, unless something
// like this asks it to.
//
// **Network first for anything that is code.** The obvious shape for a service
// worker is cache-first, and it is the wrong one here. `server.py` and `web/`
// are baked into the image, and the README already warns that a restart without
// `--build` serves the old files and "looks exactly like a change that did not
// work". A cache-first worker would do the same thing to the person using it,
// on a machine with no rebuild to run. So the shell is fetched when there is a
// network and served from the cache only when there is not: online you always
// have today's code, offline you have yesterday's rather than nothing.
//
// **Cache first for audio**, because a rendered clip for a given day, voice and
// rate never changes — and because the whole point is not to fetch it.

const VERSION = 'v1';
const SHELL = `tamchai-shell-${VERSION}`;
const DATA = `tamchai-data-${VERSION}`;
const AUDIO = 'tamchai-audio';          // unversioned: clips outlive a deploy

const SHELL_FILES = [
  './', 'style.css', 'app.js', 'feed.js', 'speech.js', 'cut.js',
  'player.js', 'listened.js', 'azure.js', 'brief.js',
  'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'favicon.ico',
];

// Answered from the network when there is one, from the cache when there is not.
const LIVE_DATA = ['/api/daily', '/api/feed', '/api/config', '/api/episodes'];

// Never changes once made, so it is only ever fetched once.
const AUDIO_PATHS = ['/api/tts', '/api/episode.mp3', '/api/week.mp3'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      // One at a time and forgiving: a single 404 in this list would otherwise
      // fail the whole install and leave the app with no worker at all.
      .then((cache) => Promise.allSettled(SHELL_FILES.map((file) => cache.add(file))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name.startsWith('tamchai-') && name !== SHELL
                            && name !== DATA && name !== AUDIO)
             .map((name) => caches.delete(name)),
      ))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const response = await fetch(request);
  // Only a complete, successful answer is worth keeping: a 206 from a Range
  // request is a slice of a file, and storing it as the file would serve that
  // slice back as the whole thing.
  if (response.ok && response.status === 200) cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (offline) {
    const hit = await cache.match(request, { ignoreVary: true });
    if (hit) return hit;
    throw offline;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;     // Azure and friends: untouched

  if (AUDIO_PATHS.some((path) => url.pathname === path)) {
    // A Range request is the podcast case and belongs on the network: it is a
    // seek into a file, not a download of one.
    if (request.headers.get('Range')) return;
    event.respondWith(cacheFirst(request, AUDIO));
    return;
  }
  if (LIVE_DATA.includes(url.pathname)) {
    event.respondWith(networkFirst(request, DATA));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;        // the rest is live or nothing

  // Any address in this app is the same document — the view lives in the hash —
  // so an offline navigation to a path that was never cached under its own name
  // is still answerable with the one page there is.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL).catch(async () => {
      const cache = await caches.open(SHELL);
      return await cache.match('./') || Response.error();
    }));
    return;
  }
  event.respondWith(networkFirst(request, SHELL));
});

/**
 * Pull a day's clips into the cache, reporting as it goes.
 *
 * Sequential on purpose. These are synthesis requests reaching Microsoft
 * through the box, and a hundred of them at once is exactly the burst Day 0
 * went to the trouble of bounding — the same reason the nightly render paces
 * itself. A held day is worth a minute of trickle.
 */
async function cacheUrls(urls, client) {
  const audio = await caches.open(AUDIO);
  const data = await caches.open(DATA);
  let held = 0;
  let failed = 0;
  for (const [at, url] of urls.entries()) {
    // The day's *text* is as much of the pack as its audio: a held day whose
    // list never loads is a page that opens to "載入失敗" in the tunnel. That
    // is what the first version of this did, because the only fetch of
    // /api/daily happens at boot — before a freshly installed worker has taken
    // over — so it was never in the cache to fall back to.
    const cache = AUDIO_PATHS.some((path) => new URL(url, self.location.origin).pathname === path)
      ? audio : data;
    try {
      if (await cache.match(url, { ignoreVary: true })) {
        held += 1;
      } else {
        const response = await fetch(url);
        if (!response.ok) throw new Error(String(response.status));
        await cache.put(url, response.clone());
        held += 1;
      }
    } catch {
      failed += 1;
    }
    client?.postMessage({ type: 'cache-progress', done: at + 1, total: urls.length, held, failed });
  }
  client?.postMessage({ type: 'cache-done', held, failed, total: urls.length });
}

self.addEventListener('message', (event) => {
  const message = event.data || {};
  if (message.type === 'cache-urls' && Array.isArray(message.urls)) {
    event.waitUntil(cacheUrls(message.urls, event.source));
  }
  if (message.type === 'drop-audio') {
    event.waitUntil(caches.delete(AUDIO).then(() => {
      event.source?.postMessage({ type: 'cache-dropped' });
    }));
  }
});
