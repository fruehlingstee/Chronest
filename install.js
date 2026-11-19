(function () {
  'use strict';

  const dismissKey = 'dayflow-install-dismissed';
  let deferredPrompt = null;
  let prompting = false;
  let installed = false;
  let accepted = false;
  let dismissed = false;
  let statusMessage = '';
  let banner, installButton, dismissButton, status;
  let displayMode = null;

  try { dismissed = sessionStorage.getItem(dismissKey) === '1'; } catch (_) { /* 保存できなくても、この画面では閉じられる。 */ }
  try { displayMode = window.matchMedia('(display-mode: standalone)'); } catch (_) { /* 非対応のブラウザでは手動案内を使う。 */ }

  function isStandalone() {
    return Boolean(displayMode?.matches || navigator.standalone === true);
  }

  function updateBanner() {
    if (!banner || !installButton || !status) return;
    banner.hidden = dismissed || installed || accepted || isStandalone();
    installButton.disabled = prompting;
    installButton.textContent = prompting ? '確認中…' : deferredPrompt ? 'インストール' : '追加方法を見る';
    installButton.setAttribute('aria-busy', String(prompting));
    status.textContent = statusMessage;
    status.hidden = !statusMessage;
  }

  function installationHelp() {
    const ua = navigator.userAgent || '';
    const appleMobile = /iPad|iPhone|iPod/i.test(ua) || (/Macintosh|MacIntel/i.test(ua + ' ' + (navigator.platform || '')) && navigator.maxTouchPoints > 1);
    const android = /Android/i.test(ua);
    const inApp = /FBAN|FBAV|Instagram|\bLine\/|Twitter|MicroMessenger|GSA\/|TikTok|Snapchat|\bwv\b/i.test(ua) ||
      (appleMobile && /AppleWebKit/i.test(ua) && !/Safari\//i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua));
    const edge = /Edg(?:e|A|iOS)?\//i.test(ua);
    const chrome = /Chrome\/|Chromium\/|CriOS\//i.test(ua);
    const safari = /Safari\//i.test(ua) && !chrome && !edge && !/FxiOS|OPR\//i.test(ua);
    let title, steps;

    if (inApp) {
      title = 'ブラウザで開いて追加';
      const browser = appleMobile ? 'Safari' : android ? 'Chrome' : 'Chrome または Edge';
      steps = `<p>この画面はアプリ内ブラウザで開かれている可能性があります。</p>
        <ol><li>アプリのメニューから「${browser}で開く」または「ブラウザで開く」を選びます。</li><li>項目がない場合は、このページのURLをコピーして${browser}で開きます。</li><li>開いたページの「追加方法を見る」から、ホーム画面への追加手順を確認します。</li></ol>`;
    } else if (appleMobile) {
      title = 'iPhone・iPad のホーム画面に追加';
      steps = `<ol><li>ブラウザの「共有」ボタンをタップします。Safariではページメニュー内にある場合もあります。</li><li>「ホーム画面に追加」を選びます。</li><li>「Webアプリとして開く」が表示されたらオンにして、「追加」をタップします。</li></ol>
        <p>項目が見つからない場合は、Safariでこのページを開いてお試しください。</p>`;
    } else if (android) {
      title = 'Android のホーム画面に追加';
      steps = `<ol><li>Chromeでこのページを開き、右上の「︙」メニューをタップします。</li><li>「ホーム画面に追加」「アプリをインストール」「インストールしてショートカットを作成」などの項目を選びます。</li><li>画面の案内に従って「追加」または「インストール」をタップします。</li></ol>`;
    } else if (safari && /Macintosh|MacIntel/i.test(ua + ' ' + (navigator.platform || ''))) {
      title = 'Mac の Dock に追加';
      steps = '<ol><li>Safariの「ファイル」メニューを開きます。</li><li>「Dockに追加」を選び、内容を確認して追加します。</li></ol><p>項目がない場合は、ChromeまたはEdgeでこのページを開いてお試しください。</p>';
    } else if (edge) {
      title = 'Edge にアプリとして追加';
      steps = '<ol><li>アドレスバーのインストールアイコンを選びます。</li><li>アイコンがない場合は、右上の「…」メニューから「アプリ」（または「その他のツール」→「アプリ」）を開きます。</li><li>「このサイトをアプリとしてインストール」を選びます。</li></ol>';
    } else if (chrome) {
      title = 'Chrome にアプリとして追加';
      steps = '<ol><li>アドレスバーのインストールアイコンを選びます。</li><li>アイコンがない場合は、右上の「︙」メニューから「キャスト、保存、共有」→「ページをアプリとしてインストール」を選びます。</li><li>画面の案内に従ってインストールします。</li></ol>';
    } else {
      title = 'ホーム画面・デスクトップに追加';
      steps = '<p>ChromeまたはEdgeでこのページを開き、アドレスバーのインストールアイコン、またはブラウザのメニューからアプリとして追加できます。</p><p>iPhone・iPadでは「共有」→「ホーム画面に追加」を選んでください。</p>';
    }

    if (appleMobile) steps += '<p class="install-help-note">タスクなどのデータがある場合は、先に「TASKS」→「バックアップ」で保存し、追加したアプリの「復元」から読み込んでください。</p>';
    if (window.location?.protocol === 'file:') steps = '<p>公開されたページのURLをブラウザで開いてから追加してください。</p>' + steps;
    return `<h2>${title}</h2><div class="install-help">${steps}</div><div class="modal-actions"><button class="button" id="installHelpClose" type="button">閉じる</button></div>`;
  }

  function showHelp() {
    if (typeof modal !== 'function' || typeof closeModal !== 'function') {
      statusMessage = 'ブラウザの共有・メニューから「ホーム画面に追加」または「アプリをインストール」を選んでください。';
      updateBanner();
      return;
    }
    modal(installationHelp());
    const closeButton = document.querySelector('#installHelpClose');
    if (closeButton) closeButton.onclick = closeModal;
  }

  async function requestInstall() {
    if (prompting || dismissed || installed || accepted || isStandalone()) return;
    if (!deferredPrompt) {
      showHelp();
      return;
    }

    const promptEvent = deferredPrompt;
    deferredPrompt = null;
    prompting = true;
    statusMessage = 'ブラウザのインストール画面で確認してください。';
    updateBanner();
    try {
      // ユーザー操作の呼び出し中に実行し、同じイベントは再利用しない。
      let choice = await promptEvent.prompt();
      if (!choice?.outcome && promptEvent.userChoice) choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') {
        accepted = true;
        statusMessage = 'インストールを受け付けました。追加したアイコンから開けます。';
      } else {
        statusMessage = 'インストールをキャンセルしました。「追加方法を見る」からもう一度手順を確認できます。';
      }
    } catch (_) {
      statusMessage = 'インストール画面を開けませんでした。「追加方法を見る」からブラウザでの追加手順を確認してください。';
    } finally {
      prompting = false;
      updateBanner();
    }
  }

  // DOMの準備前に届いても、インストール用イベントを取りこぼさない。
  window.addEventListener('beforeinstallprompt', event => {
    if (typeof event.prompt !== 'function') return;
    event.preventDefault();
    deferredPrompt = event;
    accepted = false;
    statusMessage = 'インストールの準備ができました。';
    updateBanner();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferredPrompt = null;
    statusMessage = '';
    updateBanner();
  });
  window.addEventListener('pageshow', updateBanner);
  if (displayMode?.addEventListener) displayMode.addEventListener('change', updateBanner);
  else if (displayMode?.addListener) displayMode.addListener(updateBanner);

  function initialize() {
    banner = document.querySelector('#installBanner');
    installButton = document.querySelector('#installButton');
    dismissButton = document.querySelector('#installDismiss');
    status = document.querySelector('#installStatus');
    if (!banner || !installButton || !dismissButton || !status) return;
    installButton.onclick = requestInstall;
    dismissButton.onclick = () => {
      dismissed = true;
      try { sessionStorage.setItem(dismissKey, '1'); } catch (_) { /* 保存制限があっても現在の表示は閉じる。 */ }
      updateBanner();
    };
    updateBanner();
  }

  // オフラインでも開けるよう Service Worker（sw.js）を登録する。
  // ファイルを直接開いた場合（file:）は使えないので、http/https のときだけ登録する。
  function registerServiceWorker() {
    try {
      if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
      navigator.serviceWorker.register('./sw.js').catch(() => { /* 登録できなくても、オンラインでは通常どおり使える。 */ });
    } catch (_) { /* 非対応の環境では何もしない。 */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
  else initialize();
  // 画面の表示を優先し、読み込みが終わってから登録する。
  if (document.readyState === 'complete') registerServiceWorker();
  else window.addEventListener('load', registerServiceWorker, { once: true });
})();
