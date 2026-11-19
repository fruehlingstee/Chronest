const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const iphoneSafari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ipadDesktopSafari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const androidChrome = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
    removeEventListener(type, listener) { listeners.set(type, (listeners.get(type) || []).filter(item => item !== listener)); },
    emit(type, event = {}) {
      const input = { type, target: this, currentTarget: this, preventDefault() {}, ...event };
      return Promise.all([...(listeners.get(type) || []), ...(this['on' + type] ? [this['on' + type]] : [])].map(listener => listener.call(this, input)));
    }
  };
}

function installHarness({ userAgent = androidChrome, touchPoints = 0, standalone = false, iosStandalone = false, session = new Map(), blockedStorage = false, readyState = 'complete' } = {}) {
  const windowEvents = eventTarget();
  const documentEvents = eventTarget();
  const media = { ...eventTarget(), matches: standalone };
  const nodes = new Map();
  for (const id of ['installBanner', 'installButton', 'installDismiss', 'installStatus', 'installHelpClose']) {
    nodes.set(id, {
      ...eventTarget(), id, hidden: false, disabled: false, textContent: '', innerHTML: '',
      setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
      classList: { add() {}, remove() {}, toggle() {} }, focus() {}
    });
  }
  let modalHtml = '';
  let closed = 0;
  const context = vm.createContext({
    ...windowEvents, console,
    navigator: { userAgent, maxTouchPoints: touchPoints, standalone: iosStandalone, platform: userAgent.includes('Macintosh') ? 'MacIntel' : '' },
    location: { protocol: 'https:', href: 'https://example.com/dayflow/' }, isSecureContext: true,
    matchMedia: () => media,
    sessionStorage: {
      getItem(key) { if (blockedStorage) throw new Error('storage unavailable'); return session.get(key) ?? null; },
      setItem(key, value) { if (blockedStorage) throw new Error('storage unavailable'); session.set(key, value); },
      removeItem(key) { if (blockedStorage) throw new Error('storage unavailable'); session.delete(key); }
    },
    document: {
      ...documentEvents, readyState, referrer: '',
      querySelector: selector => nodes.get(selector.replace(/^#/, '')) || null,
      getElementById: id => nodes.get(id) || null
    },
    modal(html) { modalHtml = html; }, closeModal() { closed++; },
    setTimeout(callback) { callback(); return 1; }, clearTimeout() {}
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'install.js'), 'utf8'), context, { filename: 'install.js' });
  return {
    context, session, media,
    node: id => nodes.get(id),
    emit: (type, event) => windowEvents.emit.call(context, type, event),
    emitDocument: (type, event) => documentEvents.emit.call(context.document, type, event),
    click: id => nodes.get(id).emit('click'),
    modal: () => modalHtml,
    closed: () => closed
  };
}

test('native install prompt is captured, invoked once, and appinstalled hides the banner', async () => {
  const harness = installHarness();
  let prevented = 0;
  let prompted = 0;
  await harness.emit('beforeinstallprompt', {
    preventDefault() { prevented++; },
    async prompt() { prompted++; },
    userChoice: Promise.resolve({ outcome: 'accepted' })
  });
  assert.equal(prevented, 1);
  assert.equal(harness.node('installBanner').hidden, false);
  const installation = harness.click('installButton');
  assert.equal(prompted, 1, 'クリック中のユーザー操作が有効なうちにpromptを呼ぶ');
  await installation;
  assert.equal(prompted, 1);
  assert.equal(harness.node('installBanner').hidden, true, 'native受理後は案内を閉じる');
  await harness.emit('appinstalled');
  assert.equal(harness.node('installBanner').hidden, true);
});

test('rapid repeated clicks cannot open the native prompt twice', async () => {
  const harness = installHarness();
  let prompted = 0;
  let choose;
  await harness.emit('beforeinstallprompt', {
    async prompt() { prompted++; },
    userChoice: new Promise(resolve => { choose = resolve; })
  });
  const first = harness.click('installButton');
  const second = harness.click('installButton');
  await Promise.resolve();
  assert.equal(prompted, 1);
  choose({ outcome: 'dismissed' });
  await Promise.all([first, second]);
  assert.equal(harness.node('installButton').disabled, false);
  assert.equal(harness.node('installBanner').hidden, false);
});

test('a native install event arriving before DOM readiness is retained for the button', async () => {
  const harness = installHarness({ readyState: 'loading' });
  let prompted = 0;
  await harness.emit('beforeinstallprompt', {
    async prompt() { prompted++; },
    userChoice: Promise.resolve({ outcome: 'dismissed' })
  });
  harness.context.document.readyState = 'interactive';
  await harness.emitDocument('DOMContentLoaded');
  await harness.click('installButton');
  assert.equal(prompted, 1);
});

test('a failed native prompt releases the button and falls back to installation help', async () => {
  const harness = installHarness();
  let prompted = 0;
  await harness.emit('beforeinstallprompt', {
    prompt() { prompted++; throw new Error('prompt unavailable'); },
    userChoice: Promise.resolve({ outcome: 'dismissed' })
  });
  await harness.click('installButton');
  assert.equal(prompted, 1);
  assert.equal(harness.node('installButton').disabled, false);
  await harness.click('installButton');
  assert.equal(prompted, 1, '消費したnative eventを再使用しない');
  assert.match(harness.modal(), /インストール|ホーム画面に追加/);
});

test('iPhone Safari without a native prompt receives Home Screen instructions', async () => {
  const harness = installHarness({ userAgent: iphoneSafari, touchPoints: 5 });
  await harness.click('installButton');
  assert.match(harness.modal(), /共有/);
  assert.match(harness.modal(), /ホーム画面に追加/);
  await harness.click('installHelpClose');
  assert.equal(harness.closed(), 1);
});

test('desktop-style iPad Safari with touch receives iOS installation instructions', async () => {
  const harness = installHarness({ userAgent: ipadDesktopSafari, touchPoints: 5 });
  await harness.click('installButton');
  assert.match(harness.modal(), /共有/);
  assert.match(harness.modal(), /ホーム画面に追加/);
});

test('Android without a native prompt receives browser menu installation instructions', async () => {
  const harness = installHarness();
  await harness.click('installButton');
  assert.match(harness.modal(), /メニュー/);
  assert.match(harness.modal(), /インストール|ホーム画面に追加/);
});

for (const options of [{ standalone: true }, { iosStandalone: true }]) {
  test('installed standalone mode hides the installation banner: ' + JSON.stringify(options), async () => {
    const harness = installHarness(options);
    assert.equal(harness.node('installBanner').hidden, true);
    await harness.emit('beforeinstallprompt', { prompt() {}, userChoice: Promise.resolve({ outcome: 'accepted' }) });
    assert.equal(harness.node('installBanner').hidden, true);
  });
}

test('dismissing the banner is retained for the current browser session', async () => {
  const session = new Map();
  const first = installHarness({ session });
  await first.click('installDismiss');
  assert.equal(first.node('installBanner').hidden, true);
  assert.ok(session.get('dayflow-install-dismissed'));
  const reloaded = installHarness({ session });
  assert.equal(reloaded.node('installBanner').hidden, true);
});

test('blocked session storage allows instructions and dismissing without exceptions', async () => {
  const harness = installHarness({ userAgent: iphoneSafari, touchPoints: 5, blockedStorage: true });
  await harness.click('installButton');
  assert.match(harness.modal(), /ホーム画面に追加/);
  await harness.click('installDismiss');
  assert.equal(harness.node('installBanner').hidden, true);
});
