const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const scope = 'https://example.test/dayflow/';

// ブラウザの Response の代わり。type: 'basic' は「同じサイトからの通常の応答」を表す。
function response(body, { status = 200, type = 'basic' } = {}) {
  return { body, status, type, ok: status >= 200 && status < 300, clone() { return response(body, { status, type }); } };
}

// Service Worker が使うブラウザ機能（保存領域・通信・画面一覧）を、テスト用の簡単な代わりで用意する。
function serviceWorkerHarness({ network = () => Promise.resolve(response('network')) } = {}) {
  const listeners = {};
  const stores = new Map();
  const fetches = [];
  const keyOf = key => typeof key === 'string' ? key : key.url;
  const caches = {
    async open(name) {
      if (!stores.has(name)) {
        const entries = new Map();
        stores.set(name, {
          entries,
          async match(key) { return entries.get(keyOf(key)); },
          async put(key, value) { entries.set(keyOf(key), value); },
          async addAll(requests) { for (const request of requests) entries.set(request.url, await context.fetch(request)); }
        });
      }
      return stores.get(name);
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); }
  };
  class Request {
    constructor(input, init = {}) {
      this.url = typeof input === 'string' ? new URL(input, scope + 'sw.js').href : input.url;
      this.method = input.method || 'GET';
      this.mode = input.mode || 'cors';
      this.cache = init.cache || input.cache || 'default';
    }
  }
  const windows = [];
  const context = vm.createContext({
    URL, Promise, console, Request, caches,
    setTimeout: callback => setTimeout(callback, 0),
    fetch(request) { fetches.push(request); return network(request); },
    self: {
      location: new URL(scope + 'sw.js'),
      registration: { scope },
      addEventListener(type, listener) { listeners[type] = listener; },
      skipWaiting: async () => { context.skipped = true; },
      clients: {
        claim: async () => { context.claimed = true; },
        matchAll: async () => windows,
        openWindow: async url => { context.opened = url; }
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), context, { filename: 'sw.js' });
  // イベントを発生させ、respondWith / waitUntil に渡された処理を記録する。
  async function dispatch(type, init = {}) {
    const waits = [];
    const event = { ...init, waitUntil(promise) { waits.push(promise); }, respondWith(promise) { event.responded = promise; } };
    listeners[type](event);
    // 失敗した応答もテストで確かめられるよう、例外ではなく { error } として返す。
    const result = event.responded === undefined ? undefined : await Promise.resolve(event.responded).then(value => value, error => ({ error }));
    return { event, waits, response: result, settle: () => Promise.all(waits) };
  }
  const request = (file, mode = 'cors', method = 'GET') => ({ url: new URL(file, scope).href, mode, method });
  return { context, stores, fetches, windows, dispatch, request, store: () => stores.get('dayflow-shell-v1') };
}

const appFiles = () => vm.runInNewContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8') + '\nAPP_FILES', {
  self: { location: new URL(scope + 'sw.js'), addEventListener() {} }, URL
});

test('オフライン用のファイル一覧は実在し、画面が読み込むファイルを漏れなく含む', () => {
  const files = [...appFiles()];
  for (const file of files) {
    if (file === './') continue;
    assert.ok(fs.existsSync(path.join(root, file)), '存在するファイル: ' + file);
  }
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  const referenced = [...html.matchAll(/(?:src|href)="(\.\/[^"?]+)/g)].map(match => match[1]).concat(manifest.icons.map(icon => icon.src));
  for (const file of referenced) assert.ok(files.includes(file), 'オフライン用に保存するファイル: ' + file);
});

test('インストール時にアプリのファイルを最新で保存し、有効化で古い保存領域だけを消す', async () => {
  const harness = serviceWorkerHarness();
  const install = await harness.dispatch('install');
  await install.settle();
  assert.equal(harness.store().entries.size, appFiles().length);
  assert.ok(harness.fetches.every(request => request.cache === 'reload'), 'ブラウザの一時保存ではなくサーバーから取り直す');
  assert.equal(harness.context.skipped, true);
  await harness.context.caches.open('dayflow-shell-v0');
  await harness.context.caches.open('other-app');
  const activate = await harness.dispatch('activate');
  await activate.settle();
  assert.deepEqual([...harness.stores.keys()].sort(), ['dayflow-shell-v1', 'other-app']);
  assert.equal(harness.context.claimed, true);
});

test('オンラインでは毎回サーバーに確認して最新を返し、?v= を除いた名前で保存する', async () => {
  const harness = serviceWorkerHarness({ network: () => Promise.resolve(response('新しいapp.js')) });
  const { response: result, settle } = await harness.dispatch('fetch', { request: harness.request('app.js?v=2') });
  await settle();
  assert.equal(result.body, '新しいapp.js');
  assert.equal(harness.fetches[0].cache, 'no-cache');
  assert.equal((await harness.store().match(scope + 'app.js')).body, '新しいapp.js');
  assert.equal(harness.store().entries.has(scope + 'app.js?v=2'), false);
});

test('オフラインでは保存済みのファイルを返し、ページの移動は最初の画面で開く', async () => {
  const harness = serviceWorkerHarness({ network: () => Promise.reject(new TypeError('offline')) });
  const store = await harness.context.caches.open('dayflow-shell-v1');
  await store.put(scope + 'app.js', response('保存済みapp.js'));
  await store.put(scope, response('保存済みindex'));
  assert.equal((await harness.dispatch('fetch', { request: harness.request('app.js?v=3') })).response.body, '保存済みapp.js');
  assert.equal((await harness.dispatch('fetch', { request: harness.request('?source=pwa', 'navigate') })).response.body, '保存済みindex');
  assert.match(String((await harness.dispatch('fetch', { request: harness.request('missing.js') })).response.error), /offline/, '保存が無ければ通常の失敗にする');
});

test('サーバーの不調では保存済みを使い、存在しないファイルや転送はサーバーの答えを返す', async () => {
  let answer = response('', { status: 503 });
  const harness = serviceWorkerHarness({ network: () => Promise.resolve(answer) });
  const store = await harness.context.caches.open('dayflow-shell-v1');
  await store.put(scope + 'styles.css', response('保存済みcss'));
  assert.equal((await harness.dispatch('fetch', { request: harness.request('styles.css') })).response.body, '保存済みcss');
  answer = response('', { status: 404 });
  assert.equal((await harness.dispatch('fetch', { request: harness.request('styles.css') })).response.status, 404);
  answer = response('', { status: 0, type: 'opaqueredirect' });
  await store.put(scope, response('保存済みindex'));
  assert.equal((await harness.dispatch('fetch', { request: harness.request('', 'navigate') })).response.type, 'opaqueredirect');
});

test('応答が遅いときは保存済みを先に返し、届いた最新は裏で保存する', async () => {
  let deliver;
  const harness = serviceWorkerHarness({ network: () => new Promise(resolve => { deliver = resolve; }) });
  const store = await harness.context.caches.open('dayflow-shell-v1');
  await store.put(scope + 'tools.js', response('保存済みtools'));
  const result = await harness.dispatch('fetch', { request: harness.request('tools.js') });
  assert.equal(result.response.body, '保存済みtools');
  deliver(response('遅れて届いたtools'));
  await result.settle();
  assert.equal((await store.match(scope + 'tools.js')).body, '遅れて届いたtools');
});

test('外部サイトの通信と送信（GET以外）は中継しない', async () => {
  const harness = serviceWorkerHarness();
  assert.equal((await harness.dispatch('fetch', { request: { url: 'https://fonts.googleapis.com/css2', mode: 'cors', method: 'GET' } })).event.responded, undefined);
  assert.equal((await harness.dispatch('fetch', { request: harness.request('app.js', 'cors', 'POST') })).event.responded, undefined);
  assert.equal(harness.fetches.length, 0);
});

test('通知を押すと開いている画面を前面に出し、無ければ新しく開く', async () => {
  const harness = serviceWorkerHarness();
  let closed = 0, focused = 0;
  const notification = { close() { closed++; } };
  await (await harness.dispatch('notificationclick', { notification })).settle();
  assert.equal(harness.context.opened, scope);
  harness.windows.push({ url: scope + '#calendar', focus: async () => { focused++; } });
  await (await harness.dispatch('notificationclick', { notification })).settle();
  assert.equal(focused, 1);
  assert.equal(closed, 2);
});
