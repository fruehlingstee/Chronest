// DAYFLOW の Service Worker（ブラウザとネットの間に入り、通信を中継する仕組み）。
// 方針は「ネット優先、つながらないときは保存済みのファイル」。
//  - オンラインでは毎回サーバーに更新を確認するので、古い画面が残りにくい（変更が無ければ短い応答で済む）。
//  - オフラインや、4秒以上応答が無いときは、前回保存したファイルで画面を開く。
// アプリのファイルを追加したら APP_FILES にも追加する（tests/sw.test.cjs が漏れを検出する）。
const CACHE_NAME = 'dayflow-shell-v1';
const APP_FILES = [
  './', './index.html', './styles.css', './schedule.js', './app.js', './enhancements.js', './tools.js', './install.js',
  './vendor/qrcode.js', './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];
const NETWORK_TIMEOUT_MS = 4000;
const START_PAGE = new URL('./', self.location).href;

self.addEventListener('install', event => {
  // cache: 'reload' で、ブラウザの一時保存ではなくサーバーから最新を取り直して保存する。
  event.waitUntil(caches.open(CACHE_NAME)
    .then(cache => cache.addAll(APP_FILES.map(file => new Request(file, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  // 以前の版の保存領域を消し、開いている画面もすぐにこの Service Worker の管理下に置く。
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith('dayflow-') && key !== CACHE_NAME).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  // Googleフォントなど外部のファイルは中継せず、ブラウザの通常の動きに任せる。
  if (new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(event));
});

// ?v=… が違うだけの同じファイルを何重にも保存しないよう、保存用のキーからクエリを除く。
function cacheKey(url) {
  const copy = new URL(url);
  copy.search = '';
  copy.hash = '';
  return copy.href;
}

async function networkFirst(event) {
  const { request } = event;
  const cache = await caches.open(CACHE_NAME);
  const key = cacheKey(request.url);
  const cached = await cache.match(key) || (request.mode === 'navigate' ? await cache.match(START_PAGE) : undefined);
  // ページ移動の要求は作り直せない決まりなのでそのまま送る。それ以外は毎回サーバーへ更新を確認する。
  const network = (request.mode === 'navigate' ? fetch(request) : fetch(new Request(request, { cache: 'no-cache' })))
    .then(async response => {
      if (response.ok && response.type === 'basic') {
        try { await cache.put(key, response.clone()); } catch (_) { /* 保存できなくても画面は表示する。 */ }
      }
      return response;
    });
  // 保存済みのファイルを先に返した場合も、裏で続いている取得と保存を最後まで終わらせる。
  event.waitUntil(network.catch(() => {}));
  if (!cached) return network;
  // サーバーの不調（500番台など）やオフラインのときは保存済みのファイルを使う。転送の指示はそのまま返す。
  const fresh = network.then(response => response.ok || response.type === 'opaqueredirect' || response.status === 404 ? response : cached, () => cached);
  const slow = new Promise(resolve => setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS));
  return Promise.race([fresh, slow]);
}

// 通知を押したら、開いているDAYFLOWを前面に出す。開いていなければ新しく開く。
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
    const existing = windows.find(client => client.url.startsWith(self.registration.scope));
    return existing ? existing.focus() : self.clients.openWindow(self.registration.scope);
  }));
});
