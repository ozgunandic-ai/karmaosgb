/* KARMA OSGB — çevrimdışı önbellek (yalnızca uygulama dosyaları; API/veri istekleri önbelleğe alınmaz) */
var SURUM = 'karma-osgb-v2';
var DOSYALAR = ['./', './index.html', './manifest.webmanifest', './apple-touch-icon.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SURUM).then(function (c) { return c.addAll(DOSYALAR); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (k) {
    return Promise.all(k.filter(function (x) { return x !== SURUM; }).map(function (x) { return caches.delete(x); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var r = e.request;
  if (r.method !== 'GET') return;
  var u = new URL(r.url);
  if (u.origin !== location.origin) return;
  if (u.pathname.indexOf('/api/') === 0) return;      // veri API'si asla önbelleğe alınmaz (özel veri)           // GitHub API, harici siteler vb. doğrudan ağa gider
  // Önce ağ (her zaman güncel sürüm), ağ yoksa önbellek
  e.respondWith(fetch(r).then(function (res) {
    if (res && res.ok) { var kopya = res.clone(); caches.open(SURUM).then(function (c) { c.put(r, kopya); }); }
    return res;
  }).catch(function () {
    return caches.match(r).then(function (m) { return m || caches.match('./index.html'); });
  }));
});
