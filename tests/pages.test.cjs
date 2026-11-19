const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// app.js・insights.js・pages.js を簡易DOMで読み込み、ダッシュボード・統計・集中モードを確かめる。
function createPages({ now = '2026-11-19T12:00:00', stored } = {}) {
  const storage = new Map(stored ? [['dayflow-v2', JSON.stringify({ notes: [], sessions: [], bookmarks: [], ...stored })]] : []);
  const nodes = new Map();
  const timers = new Map();
  // 編集画面（modal）の中身も、入力欄を取り出せるよう同じ方法で読み取る（画面本体の入力欄は消さない）。
  const installModal = markup => {
    for (const [, attributes] of markup.matchAll(/<[a-z]+\b([^>]*)>/gi)) {
      const id = attributes.match(/\bid="([^"]*)"/);
      if (id) nodes.set('#' + id[1], element());
    }
    const textarea = markup.match(/<textarea id="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/);
    if (textarea) nodes.get('#' + textarea[1]).value = textarea[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  };
  let clock = new Date(now).getTime(), timerId = 0, uuid = 0;
  const element = () => ({ value: '', textContent: '', hidden: false, dataset: {}, focus() {}, setAttribute() {} });
  const root = element();
  Object.defineProperty(root, 'innerHTML', {
    get() { return this.markup || ''; },
    set(markup) {
      this.markup = markup;
      for (const key of nodes.keys()) if (key !== '#app' && key !== '#modal-root') nodes.delete(key);
      for (const [, attributes] of markup.matchAll(/<[a-z]+\b([^>]*)>/gi)) {
        const id = attributes.match(/\bid="([^"]*)"/);
        if (!id) continue;
        const node = element();
        node.value = (attributes.match(/\bvalue="([^"]*)"/)?.[1] || '').replace(/&amp;/g, '&');
        if (id[1] === 'globalSearchResults') {
          Object.defineProperty(node, 'innerHTML', { get() { return this.markup || ''; }, set(value) { this.markup = value; } });
        }
        nodes.set('#' + id[1], node);
      }
    }
  });
  nodes.set('#app', root);
  nodes.set('#modal-root', element());
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const context = vm.createContext({
    Date: ClockDate, URL, console,
    crypto: { randomUUID: () => 'id-' + ++uuid },
    document: { querySelector: selector => nodes.get(selector) || null, querySelectorAll: () => [] },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setInterval(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); }
  });
  context.window = context;
  for (const file of ['schedule.js', 'app.js', 'insights.js', 'pages.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
  // 実際の modal はブラウザのDOM操作を使うため、テストでは中身の読み取りだけを行う代わりに差し替える。
  context.installModal = installModal;
  vm.runInContext('modal = html => installModal(html); closeModal = () => {};', context);
  return {
    run: code => vm.runInContext(code, context),
    node: selector => nodes.get(selector),
    html: () => root.markup,
    advance(ms) { clock += ms; for (const callback of [...timers.values()]) callback(); },
    storage
  };
}

const submit = node => node.onsubmit({ preventDefault() {} });

test('ダッシュボードに今日やること・今日の予定・集中時間・件数をまとめて表示する', () => {
  const app = createPages({ stored: {
    tasks: [
      { id: 'later', title: '来月の準備', due: '2026-12-10', priority: 'high' },
      { id: 'overdue', title: '期限切れの書類', due: '2026-11-10' },
      { id: 'today', title: '今日の提出', due: '2026-11-19' },
      { id: 'done', title: '完了済み', done: true, completedOn: '2026-11-18' }
    ],
    events: [
      { id: 'weekly', title: '毎週の授業', date: '2026-11-05', endDate: '2026-11-05', time: '10:40', repeat: 'weekly' },
      { id: 'other', title: '別の日', date: '2026-11-20' }
    ],
    sessions: [{ date: '2026-11-19', minutes: 25, task: '読書' }, { date: '2026-11-18', minutes: 50, task: '' }]
  } });
  const html = app.html();
  assert.match(html, /aria-current="page">HOME</);
  assert.match(html, /data-page="stats"/, 'ナビゲーションに統計ページがある');
  const order = ['期限切れの書類', '今日の提出', '来月の準備'].map(title => html.indexOf(title));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), '期限切れ・今日 → 優先度の順');
  assert.doesNotMatch(html, /完了済み/);
  assert.match(html, /期限切れ 11\/10/);
  assert.match(html, /毎週の授業/);
  assert.doesNotMatch(html, /別の日/);
  assert.match(html, /<b>3<\/b><span>未完了タスク · <em class="red">期限切れ 1<\/em>/);
  assert.match(html, /<b>25<small>分<\/small><\/b><span>今日の集中/);
  assert.match(html, /<b>2<small>日<\/small><\/b><span>連続で集中/);
});

test('クイック追加は文章を解析して予定・タスクを登録し、解析できない文は登録しない', () => {
  const app = createPages({ stored: { tasks: [], events: [] } });
  const input = app.node('#quickAddInput');
  input.value = '明日15時 会議';
  input.oninput();
  assert.equal(app.node('#quickAddPreview').textContent, '予定 · 11/20 15:00 · 会議', '入力中に解析結果を表示する');
  submit(app.node('#quickAddForm'));
  assert.equal(app.run('data.events.length'), 1);
  assert.equal(app.run('JSON.stringify([data.events[0].title, data.events[0].date, data.events[0].time, data.events[0].repeat])'), '["会議","2026-11-20","15:00","none"]');
  assert.equal(app.run('undoState.message'), '予定「会議」を11/20に追加しました。', '追加の知らせは「元に戻す」と一緒に出す');
  assert.equal(app.node('#quickAddInput').value, '', '登録後は入力欄を空にする');
  assert.ok(JSON.parse(app.storage.get('dayflow-v2')).events.length === 1, '端末に保存する');

  app.node('#quickAddInput').value = '金曜 9時 レポート提出 タスク 重要';
  submit(app.node('#quickAddForm'));
  assert.equal(app.run('JSON.stringify([data.tasks[0].title, data.tasks[0].due, data.tasks[0].reminderAt, data.tasks[0].priority])'), '["レポート提出","2026-11-20","2026-11-20T09:00","high"]');

  app.node('#quickAddInput').value = '明日 15時';
  submit(app.node('#quickAddForm'));
  assert.equal(app.run('data.events.length + data.tasks.length'), 2);
  assert.match(app.html(), /タイトルを入力してください/);
  assert.equal(app.node('#quickAddInput').value, '明日 15時', '登録できなかった文は残す');
});

test('全体検索はタスク・予定・メモ・ブックマークを種類ごとに表示する', () => {
  const app = createPages({ stored: {
    tasks: [{ id: 't', title: '旅行の準備' }], events: [{ id: 'e', title: '旅行', date: '2026-12-01' }],
    notes: [{ id: 'n', body: '旅行の持ち物メモ' }], bookmarks: [{ id: 'b', title: '旅行サイト', url: 'https://example.com/', tags: [] }]
  } });
  const search = app.node('#globalSearch');
  search.value = '旅行';
  search.oninput();
  const results = app.node('#globalSearchResults').innerHTML;
  for (const label of ['タスク', '予定', 'メモ', 'ブックマーク']) assert.match(results, new RegExp(`<h4>${label} <span>1</span>`));
  assert.match(results, /data-search-event="2026-12-01"/);
  assert.match(results, /href="https:\/\/example.com\/" target="_blank" rel="noopener noreferrer"/);
  search.value = '存在しない言葉';
  search.oninput();
  assert.match(app.node('#globalSearchResults').innerHTML, /一致するものはありません/);
});

test('統計ページに集中時間・達成率・12週間のヒートマップ・タスク別の集中時間を表示する', () => {
  const app = createPages({ stored: {
    tasks: [{ id: 'study', title: '試験勉強', done: false }, { id: 'x', title: '済み', done: true, completedOn: '2026-11-19' }],
    events: [],
    sessions: [{ date: '2026-11-19', minutes: 50, task: '試験勉強', taskId: 'study' }, { date: '2026-11-17', minutes: 25, task: '試験勉強', taskId: 'study' }, { date: '2026-11-01', minutes: 5, task: '' }]
  } });
  app.run("page='stats'; render()");
  const html = app.html();
  assert.match(html, /<b>50<small>分<\/small><\/b><span>今日の集中/);
  assert.match(html, /<b>75<small>分<\/small><\/b><span>直近7日間の集中/);
  assert.match(html, /<b>50<small>%<\/small><\/b><span>タスク達成率（1\/2）/);
  assert.equal((html.match(/class="heat heat-(?:\d|future)" title=/g) || []).length, 84, '12週間×7日');
  assert.match(html, /title="2026-11-19 · 50分"/);
  assert.match(html, /試験勉強<\/span><\/span><b class="stats-minutes">75分/);
});

test('タスクを選んで集中すると記録にタスクを結び付け、終了後にそのタスクを完了にできる', () => {
  const app = createPages({ stored: { tasks: [{ id: 'essay', title: '作文' }, { id: 'other', title: '別のタスク' }], events: [] } });
  app.run("startFocusTask('essay')");
  assert.equal(app.run('page'), 'focus');
  assert.equal(app.node('#focusTask').value, '作文');
  assert.match(app.html(), /<option value="essay" selected>作文<\/option>/);
  assert.match(app.html(), /このタスクの集中 合計 0分/);
  app.run('focusDuration=60; timer=60');
  app.node('#timerStart').onclick();
  app.advance(61000);
  assert.equal(app.run('JSON.stringify([data.sessions[0].taskId, data.sessions[0].task, data.sessions[0].minutes])'), '["essay","作文",1]');
  assert.match(app.html(), /「作文」は終わりましたか？/);
  app.node('#focusCompleteTask').onclick();
  assert.equal(app.run("data.tasks.find(task => task.id === 'essay').done"), true);
  assert.doesNotMatch(app.html(), /は終わりましたか/);
});

test('集中する作業名を書き換えるとタスクとの連携を外し、旧形式の記録も読み込める', () => {
  const app = createPages({ stored: { tasks: [{ id: 'essay', title: '作文' }], events: [], sessions: [{ date: '2026-11-18', minutes: 25, task: '読書' }, { date: '2026-11-18', minutes: 25, task: 'x', taskId: '<bad>' }] } });
  assert.equal(app.run('data.sessions[0].taskId'), '');
  assert.equal(app.run('data.sessions[1].taskId'), '', '不正なIDは連携なしとして読み込む');
  app.run("startFocusTask('essay')");
  const input = app.node('#focusTask');
  input.value = '作文の下書き';
  input.oninput({ target: input });
  assert.equal(app.run('focusTaskId'), '');
});

test('メモは編集でき、絞り込み欄で本文から探せる', () => {
  const app = createPages({ stored: { tasks: [], events: [], notes: [
    { id: 'shop', body: '牛乳とパンを買う', pinned: false, created: '2026-11-18T09:00:00.000Z' },
    { id: 'idea', body: 'アプリの改善案', pinned: true, created: '2026-11-17T09:00:00.000Z' }
  ] } });
  app.run("page='notes'; render()");
  assert.match(app.html(), /data-note-edit="shop"/);
  app.run("editNote('shop')");
  assert.equal(app.node('#editNoteBody').value, '牛乳とパンを買う');
  app.node('#editNoteBody').value = '牛乳とパンと卵を買う';
  app.node('#noteEditForm').onsubmit({ preventDefault() {} });
  assert.equal(app.run("findNote('shop').body"), '牛乳とパンと卵を買う');
  assert.ok(app.run("findNote('shop').updated"), '編集日時を残す');
  assert.match(app.html(), /編集済み/);
  app.run("editNote('shop')");
  app.node('#editNoteBody').value = '   ';
  app.node('#noteEditForm').onsubmit({ preventDefault() {} });
  assert.equal(app.run("findNote('shop').body"), '牛乳とパンと卵を買う', '空にはしない');
  const filter = app.node('#noteFilter');
  filter.value = '卵';
  filter.oninput();
  const list = app.node('#notesList').innerHTML;
  assert.match(list, /牛乳とパンと卵を買う/);
  assert.doesNotMatch(list, /アプリの改善案/);
  filter.value = '存在しない';
  filter.oninput();
  assert.match(app.node('#notesList').innerHTML, /一致するメモはありません/);
});

test('「元に戻す」は直前の削除・完了・追加を取り消し、その後に別の変更が保存されていれば取り消さない', () => {
  const app = createPages({ stored: { tasks: [{ id: 'task', title: '片付け' }], events: [], notes: [{ id: 'memo', body: '消すメモ', pinned: false, created: '2026-11-18T09:00:00.000Z' }] } });
  // メモの削除（確認画面なしですぐ消え、取り消せる）
  app.run("var snapshot = snapshotData(); data.notes = []; save(); offerUndo('メモを削除しました。', snapshot)");
  app.run('undoLastAction()');
  assert.equal(app.run('data.notes.length'), 1);
  assert.equal(JSON.parse(app.storage.get('dayflow-v2')).notes.length, 1, '取り消した内容を保存する');
  assert.equal(app.run('undoState'), null);
  // クイック追加の取り消し
  app.node('#quickAddInput').value = '明日 打ち合わせの予定';
  submit(app.node('#quickAddForm'));
  assert.equal(app.run('data.events.length'), 1);
  app.run('undoLastAction()');
  assert.equal(app.run('data.events.length'), 0);
  // 取り消す前に別の変更が保存された場合は、その変更を消さない
  app.node('#quickAddInput').value = '明日 面談の予定';
  submit(app.node('#quickAddForm'));
  app.run("data.tasks[0].title = '片付け（変更）'; save()");
  app.run('undoLastAction()');
  assert.equal(app.run('data.events.length'), 1);
  assert.equal(app.run('data.tasks[0].title'), '片付け（変更）');
});
