// 実行例: NODE_PATH に Playwright の場所を指定し node tests/browser-smoke.cjs
// ブラウザは一時プロファイル、データはテスト専用の localhost 内だけで使用する。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

async function main() {
  const root = path.resolve(__dirname, '..');
  const files = new Set(['index.html', 'app.js', 'enhancements.js', 'tools.js', 'install.js', 'styles.css', 'vendor/qrcode.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png']);
  const server = http.createServer((request, response) => {
    const file = new URL(request.url, 'http://localhost').pathname.slice(1) || 'index.html';
    if (!files.has(file)) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.webmanifest') ? 'application/manifest+json' : file.endsWith('.png') ? 'image/png' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8');
    fs.createReadStream(path.join(root, file)).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    const edge = process.env.DAYFLOW_BROWSER_PATH || path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
    browser = await chromium.launch({ headless: true, ...(fs.existsSync(edge) ? { executablePath: edge } : {}) });
    const context = await browser.newContext({ timezoneId: 'Asia/Tokyo', viewport: { width: 1440, height: 1050 }, serviceWorkers: 'block' });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const localFiles = pathToFileURL(root + path.sep).href;
    // 外部通信を切った状態でも、同梱したライブラリでQRが動作することを検証する。
    await context.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith(localFiles) ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    assert.equal(await page.locator('nav [aria-current="page"]').textContent(), 'HOME');
    assert.equal(await page.locator('#quickAddInput').count(), 1, 'ホームにダッシュボードを表示する');
    assert.equal(await page.locator('#installBanner').isVisible(), true);
    assert.ok((await page.locator('#installBanner').boundingBox()).y < (await page.locator('.header').boundingBox()).y, 'インストール案内がヘッダーより上に表示される');
    assert.equal(await page.locator('.install-icon').evaluate(image => image.naturalWidth), 192);
    const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel="manifest"]').href)).json());
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.some(icon => icon.sizes === '512x512'));
    await page.locator('#installButton').click();
    assert.equal(await page.locator('#installHelpClose').isVisible(), true);
    await page.locator('#installHelpClose').click();

    const phone = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await phone.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const phonePage = await phone.newPage();
    await phonePage.goto(origin);
    assert.equal(await phonePage.locator('#installBanner').isVisible(), true);
    assert.equal(await phonePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.DAYFLOW_SCREENSHOTS) {
      fs.mkdirSync(process.env.DAYFLOW_SCREENSHOTS, { recursive: true });
      await phonePage.screenshot({ path: path.join(process.env.DAYFLOW_SCREENSHOTS, 'install-mobile.png'), fullPage: true });
    }
    await phonePage.locator('#installButton').click();
    assert.match(await phonePage.locator('[role="dialog"]').innerText(), /ホーム画面に追加/);
    assert.match(await phonePage.locator('[role="dialog"]').innerText(), /バックアップ/);
    await phonePage.locator('#installHelpClose').click();
    await phonePage.evaluate(() => {
      window.installPromptCalls = 0;
      const installEvent = new Event('beforeinstallprompt', { cancelable: true });
      installEvent.prompt = async () => { window.installPromptCalls++; };
      installEvent.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(installEvent);
    });
    await phonePage.locator('#installButton').click();
    assert.equal(await phonePage.evaluate(() => window.installPromptCalls), 1);
    await phonePage.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    assert.equal(await phonePage.locator('#installBanner').isVisible(), false);
    await phone.close();

    await page.locator('nav [data-page="calendar"]').click();
    await page.locator('#eventDate').fill('2028-02-29');
    await page.locator('#eventDate').dispatchEvent('change');
    await page.locator('#eventTime').fill('09:30');
    await page.locator('#eventTitle').fill('打ち合わせ <重要>');
    await page.locator('#eventForm button[type="submit"]').click();
    assert.equal(await page.locator('h1').innerText(), '2028年 2月');
    await page.locator('[data-event-edit]').first().click();
    await page.locator('#editEventTitle').fill('打ち合わせを変更');
    await page.locator('#editEventForm button[type="submit"]').click();
    assert.match(await page.locator('.calendar-event').first().innerText(), /打ち合わせを変更/);
    await page.locator('#eventDate').fill('2028-02-28');
    await page.locator('#eventDate').dispatchEvent('change');
    await page.locator('#eventEndDate').fill('2028-03-02');
    await page.locator('#eventTime').fill('');
    await page.locator('#eventTitle').fill('連休の予定');
    await page.locator('#eventForm button[type="submit"]').click();
    const period = await page.evaluate(() => JSON.parse(localStorage.getItem('dayflow-v2')).events.find(event => event.title === '連休の予定'));
    assert.equal(period.date, '2028-02-28');
    assert.equal(period.endDate, '2028-03-02');
    assert.equal(await page.locator(`.calendar [data-event-edit="${period.id}"]`).count(), 2, '2月28日・閏日の両方に表示する');
    await page.locator('#nextMonth').click();
    assert.equal(await page.locator(`.calendar [data-event-edit="${period.id}"]`).count(), 2, '3月1日・終了日の両方に表示する');
    assert.equal(await page.locator(`.month-agenda-row [data-event-edit="${period.id}"]`).count(), 1, '月の一覧では期間予定を重複させない');
    await page.locator('[data-calendar-day="2028-03-01"]').click();
    assert.match(await page.locator('[aria-labelledby="selectedDayHeading"]').innerText(), /連休の予定/);
    await page.locator(`.calendar [data-event-edit="${period.id}"]`).first().click();
    await page.locator('#editEventEndDate').fill('2028-03-03');
    await page.locator('#editEventForm button[type="submit"]').click();
    await page.locator('#nextMonth').click();
    assert.equal(await page.locator(`.calendar [data-event-edit="${period.id}"]`).count(), 3);
    await page.locator('[data-calendar-day="2028-03-01"]').click();
    const contrast = await page.locator('.calendar-event').first().evaluate(element => {
      const luminance = color => {
        const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4); });
        return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
      };
      const style = getComputedStyle(element), a = luminance(style.color), b = luminance(style.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    assert.ok(contrast >= 4.5, '予定の文字と背景に十分な明度差がある');
    if (process.env.DAYFLOW_SCREENSHOTS) {
      fs.mkdirSync(process.env.DAYFLOW_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.DAYFLOW_SCREENSHOTS, 'calendar-range-desktop.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const calendarBounds = await page.locator('.calendar').boundingBox();
    assert.ok(calendarBounds.width <= 360, 'スマホでも7日分が横スクロールなしで見渡せる');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.DAYFLOW_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.DAYFLOW_SCREENSHOTS, 'calendar-range-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.reload();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('dayflow-v2')));
    assert.equal(stored.events[0].title, '打ち合わせを変更');
    assert.equal(stored.events.find(event => event.id === period.id).endDate, '2028-03-03', '期間を再読み込み後も保持する');
    await page.locator('nav [data-page="calendar"]').click();
    await page.evaluate(() => { month = new Date(2026, 0, 31, 12); render(); });
    await page.locator('#nextMonth').click();
    assert.equal(await page.locator('h1').innerText(), '2026年 2月');

    await page.locator('nav [data-page="tasks"]').click();
    const originalStorage = await page.evaluate(() => localStorage.getItem('dayflow-v2'));
    const alert = page.waitForEvent('dialog').then(dialog => dialog.accept());
    await page.locator('#importData').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ tasks: [{ title: '壊れたデータ', subtasks: {} }], events: [], notes: [] })) });
    await alert;
    assert.equal(await page.evaluate(() => localStorage.getItem('dayflow-v2')), originalStorage);
    const backup = { tasks: [{ id: 'month-end', title: '月末の確認', due: '2028-01-31', repeat: 'monthly' }], events: stored.events, notes: [] };
    await page.locator('#importData').setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    assert.equal(await page.locator('[role="dialog"]').isVisible(), true);
    assert.equal(await page.evaluate(() => localStorage.getItem('dayflow-v2')), originalStorage, '確認前はデータを置き換えない');
    await page.locator('#confirmImport').click();
    await page.locator('[data-toggle="month-end"]').check();
    for (let index = 0; index < 4; index++) {
      await page.locator('[data-toggle="month-end"]').uncheck();
      await page.locator('[data-toggle="month-end"]').check();
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dayflow-v2')).tasks.length), 1, '完了チェックでタスクを増やさない');
    }
    await page.reload();
    await page.locator('nav [data-page="tasks"]').click();
    const monthly = await page.evaluate(() => JSON.parse(localStorage.getItem('dayflow-v2')).tasks[0]);
    assert.equal(monthly.id, 'month-end');
    assert.equal(monthly.done, true);
    assert.equal(monthly.nextOccurrenceOn, '2028-02-29');
    assert.equal(monthly.repeatAnchorDay, 31);

    await page.locator('[data-edit="month-end"]').click();
    await page.locator('#editTitle').fill('編集中のタイトル');
    await page.locator('#editNote').fill('保存前のメモ');
    await page.locator('#newSubtask').fill('下書きの項目');
    await page.locator('#addSubtask').click();
    assert.equal(await page.locator('#editTitle').inputValue(), '編集中のタイトル');
    assert.equal(await page.locator('#editNote').inputValue(), '保存前のメモ');
    await page.locator('#cancelEdit').click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dayflow-v2')).tasks[0].subtasks.length), 0);
    await page.locator('[data-edit="month-end"]').click();
    await page.locator('#editNote').fill('保存するメモ');
    await page.locator('#newSubtask').fill('保存する項目');
    await page.locator('#newSubtask').press('Enter');
    await page.locator('#saveEdit').click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dayflow-v2')).tasks[0].subtasks[0].title), '保存する項目');
    await page.locator('#sort').selectOption('name');
    await page.locator('[data-toggle="month-end"]').uncheck();
    assert.equal(await page.locator('#sort').inputValue(), 'name');
    for (const repeat of ['none', 'daily', 'weekly']) {
      await page.locator('#taskInput').fill(`追加したタスク ${repeat}`);
      await page.locator('#taskRepeat').selectOption(repeat);
      await page.locator('#taskForm button[type="submit"]').click();
      const currentTasks = await page.evaluate(() => JSON.parse(localStorage.getItem('dayflow-v2')).tasks);
      const toggle = page.locator(`[data-toggle="${currentTasks[0].id}"]`);
      for (let index = 0; index < 3; index++) {
        await toggle.check();
        await toggle.uncheck();
      }
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('dayflow-v2')).tasks.length), currentTasks.length);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'タスク画面が横にはみ出さない');
    await page.locator('[data-edit="month-end"]').click();
    const dialogBounds = await page.locator('[role="dialog"]').boundingBox();
    assert.ok(dialogBounds.y >= 0 && dialogBounds.y + dialogBounds.height <= 844, '編集画面がスマートフォンの高さに収まる');
    if (process.env.DAYFLOW_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.DAYFLOW_SCREENSHOTS, 'task-edit-mobile.png'), fullPage: true });
    await page.locator('#cancelEdit').click();
    await page.setViewportSize({ width: 1440, height: 1050 });

    await page.locator('nav [data-page="tools"]').click();
    await page.locator('[data-tool="qr"]').click();
    assert.equal(await page.locator('#qrCanvas').isVisible(), true);
    assert.equal(await page.locator('#qrPlaceholder').isVisible(), false);
    const payload = '  日本語🙂\n空白と改行  ';
    await page.locator('#qrText').fill(payload);
    assert.equal(await page.locator('#downloadQr').isDisabled(), true);
    await page.locator('#generateQr').click();
    assert.equal(await page.locator('#downloadQr').isEnabled(), true);
    assert.equal(await page.locator('#qrCanvas').getAttribute('width'), '280');
    assert.match(await page.locator('#qrCharacterCount').innerText(), /文字 · \d+バイト/);
    await page.locator('#qrText').dispatchEvent('compositionstart');
    assert.equal(await page.locator('#downloadQr').isDisabled(), true);
    await page.locator('#qrText').dispatchEvent('compositionend');
    await page.locator('#generateQr').click();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#downloadQr').click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'dayflow-qr.png');
    const png = fs.readFileSync(await download.path());
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    await page.locator('#qrText').fill('あ'.repeat(800));
    await page.locator('#generateQr').click();
    assert.equal(await page.locator('#downloadQr').isDisabled(), true);
    assert.match(await page.locator('#qrPlaceholder').innerText(), /長すぎます/);
    await page.locator('#qrLevel').selectOption('L');
    assert.equal(await page.locator('#downloadQr').isEnabled(), true);
    await page.locator('#qrText').fill(payload);
    await page.locator('#generateQr').click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'QR画面が横にはみ出さない');
    if (process.env.DAYFLOW_SCREENSHOTS) {
      fs.mkdirSync(process.env.DAYFLOW_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.DAYFLOW_SCREENSHOTS, 'qr-mobile.png'), fullPage: true });
    }
    await page.locator('#resetQr').click();
    assert.equal(await page.locator('#qrCanvas').isVisible(), false);
    assert.equal(await page.locator('#qrPlaceholder').isVisible(), true);

    await page.locator('nav [data-page="calendar"]').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'カレンダーはパネル内でスクロールする');
    if (process.env.DAYFLOW_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.DAYFLOW_SCREENSHOTS, 'calendar-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1050 });
    if (process.env.DAYFLOW_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.DAYFLOW_SCREENSHOTS, 'calendar-desktop.png'), fullPage: true });

    await page.locator('nav [data-page="focus"]').click();
    await page.clock.install();
    await page.locator('#focusTask').fill('ページ外で集中');
    await page.locator('[data-duration="5"]').click();
    await page.locator('#timerStart').click();
    await page.locator('nav [data-page="home"]').click();
    await page.clock.fastForward(5 * 60 * 1000);
    await page.locator('nav [data-page="focus"]').click();
    assert.match(await page.locator('.sessions').innerText(), /5分 · ページ外で集中/);
    const filePage = await context.newPage();
    filePage.on('pageerror', error => errors.push(error.message));
    await filePage.goto(pathToFileURL(path.join(root, 'index.html')).href);
    await filePage.locator('nav [data-page="tools"]').click();
    await filePage.locator('[data-tool="qr"]').click();
    assert.equal(await filePage.locator('#qrCanvas').isVisible(), true, 'index.htmlを直接開いてもQRを生成できる');
    assert.deepEqual(errors, []);
    console.log('ブラウザ確認成功: 複数日の予定・月またぎ・閏日・編集保存・配色コントラスト・スマホ7列、インストール案内、タスク増殖防止、日本語QR、ページ外タイマー。');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
