// service-worker.js
const CACHE_NAME = 'idle-lightning-v6.53';
const ASSETS = [
  './',
  './index.html',
  './style.css?v=ultra-v6-clean',
  './assets/js/game.js?v=6.5-pwa-audiokit',
  './assets/js/enemy-db.js?v=1',
  './assets/js/exp.js?v=proto-01',
  './assets/js/status.js?v=proto-02',
  './assets/images/spirit.png',
  './assets/images/bg.png',
  './assets/audio/bgm_day.mp3',
  './assets/audio/bgm_night.mp3',
  './assets/audio/attack.mp3',
  // 使うなら:
  './assets/audio/success.mp3',
  './assets/audio/failed.mp3',
  './assets/audio/upg.mp3',
  './manifest.webmanifest'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(ASSETS);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => k === CACHE_NAME ? null : caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // 音声/JS/CSS/画像はキャッシュ優先、その他はネット優先→フォールバック
  if (/\.(mp3|m4a|ogg|wav|aac|js|css|png|jpg|jpeg|gif|webp|svg)$/i.test(new URL(req.url).pathname)) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) return cached;
      const res = await fetch(req).catch(()=>null);
      if (res && res.ok) cache.put(req, res.clone());
      return res || new Response('', { status: 504 });
    })());
  }
});