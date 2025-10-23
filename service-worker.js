// service-worker.js (v6.5.4 with Range support)
const PRECACHE = 'idle-lightning-precache-v6.5.4';
const RUNTIME  = 'idle-lightning-runtime-v6.5.4';

// できればここは最小限（index と見た目に必要な最低限）
// JS は SWR で配信するのでプリキャッシュしない方が更新が入りやすい
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './style.css?v=ultra-v6-clean',
  './assets/images/spirit.png',
  './assets/images/bg.png',
  './manifest.webmanifest',
];

// （任意）オフラインでも確実に鳴らしたいならプリキャッシュ
// ただしファイルが大きい場合は外してもOK
const MEDIA_ASSETS = [
  './assets/audio/bgm_day.mp3',
  './assets/audio/bgm_night.mp3',
  './assets/audio/attack.mp3',
  // 必要なら：
  './assets/audio/success.mp3',
  './assets/audio/failed.mp3',
  './assets/audio/upg.mp3',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PRECACHE);
    await cache.addAll([...PRECACHE_ASSETS, ...MEDIA_ASSETS]);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k === PRECACHE || k === RUNTIME) ? null : caches.delete(k)));
    await self.clients.claim();
  })());
});

// ---- Range 対応（Safari 対策のキモ） ----
async function respondRange(request) {
  const rangeHeader = request.headers.get('range'); // e.g. "bytes=0-"
  if (!rangeHeader) return null;

  // 同一 URL のキャッシュ/ネットから取得
  const cache = await caches.open(PRECACHE);
  let res = await cache.match(request);
  if (!res) {
    const net = await fetch(request).catch(() => null);
    if (!net) return null;
    // 成功したらキャッシュしておく
    if (net.ok) cache.put(request, net.clone());
    res = net;
  }
  if (!res || !res.ok) return res;

  const buff = await res.arrayBuffer();
  const size = buff.byteLength;

  const m = /bytes=(\d+)-(\d+)?/.exec(rangeHeader);
  if (!m) return new Response(buff, res); // パース失敗時はそのまま

  const start = Number(m[1]);
  const end   = m[2] ? Number(m[2]) : size - 1;
  const chunk = buff.slice(start, end + 1);

  return new Response(chunk, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': `${chunk.byteLength}`,
      'Content-Type': res.headers.get('Content-Type') || inferContentType(request.url),
      'Cache-Control': 'public, max-age=31536000, immutable',
    }
  });
}

function inferContentType(url) {
  if (url.endsWith('.mp3')) return 'audio/mpeg';
  if (url.endsWith('.m4a') || url.endsWith('.aac')) return 'audio/aac';
  if (url.endsWith('.ogg')) return 'audio/ogg';
  return 'application/octet-stream';
}

// ---- フェッチ戦略 ----
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) Range リクエストは最優先で処理（Safari の音切れ対策）
  if (req.headers.has('range')) {
    event.respondWith((async () => await respondRange(req) || fetch(req))());
    return;
  }

  // 2) ナビゲーションはネット優先 → キャッシュフォールバック（オフライン用）
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const net = await fetch(req, { cache: 'no-store' });
        // オフライン時に使えるよう index を更新
        const cache = await caches.open(PRECACHE);
        cache.put('./index.html', net.clone());
        return net;
      } catch {
        const cache = await caches.open(PRECACHE);
        return (await cache.match('./index.html')) || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // 3) メディア（音/画像/フォント）はキャッシュ優先（オフライン強化）
  const dest = req.destination; // 'audio' | 'image' | 'style' | 'script' など
  if (dest === 'audio' || dest === 'image' || dest === 'font') {
    event.respondWith((async () => {
      const cache = await caches.open(PRECACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      const net = await fetch(req).catch(() => null);
      if (net && net.ok) cache.put(req, net.clone());
      return net || new Response('', { status: 504 });
    })());
    return;
  }

  // 4) JS/CSS は stale-while-revalidate（=表示は速く、裏で更新）
  if (dest === 'script' || dest === 'style') {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME);
      const cached = await cache.match(req);
      const netPromise = fetch(req).then(res => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      // 先にキャッシュがあれば返す、無ければネット
      return cached || (await netPromise) || new Response('', { status: 504 });
    })());
    return;
  }

  // 5) その他はネット優先 → キャッシュ
  event.respondWith((async () => {
    try {
      const net = await fetch(req);
      const cache = await caches.open(RUNTIME);
      if (net && net.ok) cache.put(req, net.clone());
      return net;
    } catch {
      const cache = await caches.open(RUNTIME);
      const cached = await cache.match(req);
      return cached || new Response('', { status: 504 });
    }
  })());
});