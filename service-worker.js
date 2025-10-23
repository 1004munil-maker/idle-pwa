// service-worker.js
const CACHE = 'idle-lightning-v5'; // バージョン上げて更新配信
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './assets/js/game.js',
  './assets/js/enemy-db.js',
  './assets/js/exp.js',
  './assets/js/status.js',
  // 画像
  './assets/images/spirit.png',
  './assets/images/bg.png',
  // ★ 音源を必ず入れる
  './assets/audio/bgm_day.mp3',
  './assets/audio/bgm_night.mp3',
  './assets/audio/attack.mp3',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // 音源はキャッシュ優先（再生の安定性重視）
  if (req.url.endsWith('.mp3')) {
    e.respondWith(
      caches.match(req).then(res => res || fetch(req).then(net => {
        const clone = net.clone();
        caches.open(CACHE).then(c => c.put(req, clone));
        return net;
      }))
    );
    return;
  }
  // それ以外はネット優先→失敗ならキャッシュ
  e.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});