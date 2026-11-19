const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ブラウザや追加パッケージなしで、保存処理と時計の実際の振る舞いを確認する。
function createApp({ stored, blockedStorage = false, failWrites = false } = {}) {
  const storage = new Map(stored === undefined ? [] : [['dayflow-v2', stored]]);
  const nodes = new Map();
  const timers = new Map();
  let clock = new Date('2026-11-19T12:00:00+09:00').getTime();
  let timerId = 0;
  let durationButtons = [];
  const element = () => ({ value: '', textContent: '', hidden: false, focus() {}, setAttribute() {} });
  const root = element();
  Object.defineProperty(root, 'innerHTML', {
    get() { return this.markup || ''; },
    set(markup) {
      this.markup = markup;
      for (const key of nodes.keys()) if (key !== '#app' && key !== '#modal-root') nodes.delete(key);
      durationButtons = [];
      for (const [, attributes] of markup.matchAll(/<[a-z]+\b([^>]*)>/gi)) {
        const id = attributes.match(/\bid="([^"]*)"/);
        const node = element();
        node.value = attributes.match(/\bvalue="([^"]*)"/)?.[1] || '';
        if (id) nodes.set('#' + id[1], node);
        const duration = attributes.match(/\bdata-duration="([^"]*)"/);
        if (duration) { node.dataset = { duration: duration[1] }; durationButtons.push(node); }
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
    document: {
      querySelector: selector => nodes.get(selector) || null,
      querySelectorAll: selector => selector === '[data-duration]' ? durationButtons : []
    },
    localStorage: {
      getItem(key) { if (blockedStorage) throw new Error('blocked'); return storage.get(key) ?? null; },
      setItem(key, value) { if (blockedStorage || failWrites) throw new Error('quota'); storage.set(key, value); }
    },
    setInterval(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearInterval(id) { timers.delete(id); }
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8'), context, { filename: 'app.js' });
  return {
    run: code => vm.runInContext(code, context),
    node: selector => nodes.get(selector),
    advance(ms) { clock += ms; for (const { callback } of [...timers.values()]) callback(); },
    storage, timers,
    durationButton(minutes) { return durationButtons.find(button => button.dataset.duration === String(minutes)); }
  };
}

test('strict backup validation rejects malformed records before changing current data', () => {
  const app = createApp();
  app.run("data.tasks.push({id:1,title:'現在のタスク'})");
  for (const incoming of [
    { tasks: [{}], events: [], notes: [] },
    { tasks: [{ title: 'タスク', subtasks: {} }], events: [], notes: [] },
    { tasks: [{ title: 'タスク', completedOn: '2026-02-30' }], events: [], notes: [] },
    { tasks: [{ title: 'タスク', nextOccurrenceOn: '2026-02-30' }], events: [], notes: [] },
    { tasks: [{ title: 'タスク', repeatAnchorDay: 32 }], events: [], notes: [] },
    { tasks: [{ title: 'タスク', repeatRetired: 'true' }], events: [], notes: [] },
    { tasks: [], events: [{ title: '予定', date: '2026-02-30' }], notes: [] },
    { tasks: [], events: [{ title: '予定', date: '2026-11-19', time: '24:00' }], notes: [] },
    { tasks: [], events: [], notes: [], sessions: {} },
    { tasks: [], events: [], notes: [], bookmarks: [{ url: 'javascript:alert(1)' }] }
  ]) {
    assert.throws(() => app.run(`normalizeData(${JSON.stringify(incoming)}, {strict:true})`));
    assert.equal(app.run('data.tasks[0].title'), '現在のタスク');
  }
});

test('date validation handles leap days and supported year boundaries', () => {
  const app = createApp();
  assert.equal(app.run("isDateKey('2028-02-29')"), true);
  assert.equal(app.run("isDateKey('2026-02-29')"), false);
  assert.equal(app.run("isDateKey('0000-01-01')"), false);
  assert.equal(app.run("isDateKey('0001-01-01')"), true);
  assert.equal(app.run("dayKey(new Date('0001-01-01T12:00:00'))"), '0001-01-01');
});

test('valid legacy backup receives defaults and does not mutate its source', () => {
  const app = createApp();
  const result = JSON.parse(app.run(`JSON.stringify(normalizeData({tasks:[{title:'毎日の仕事',repeat:'daily',completedOn:'2026-11-18'}],events:[{title:'終日予定',date:'2028-02-29'}],notes:[]},{strict:true}))`));
  assert.equal(result.tasks[0].priority, 'medium');
  assert.equal(result.tasks[0].repeat, 'daily');
  assert.equal(result.tasks[0].completedOn, '2026-11-18');
  assert.deepEqual(result.tasks[0].subtasks, []);
  assert.equal(result.events[0].time, '');
  assert.deepEqual(result.sessions, []);
  app.run("var incoming={tasks:[{title:'原本'}],events:[],notes:[]}; var normalized=normalizeData(incoming,{strict:true}); normalized.tasks[0].title='変更後';");
  assert.equal(app.run('incoming.tasks[0].title'), '原本');
});

test('recurrence schedule and month-end anchor survive storage and backup normalization', () => {
  const original = JSON.stringify({ tasks: [
    { id: 'monthly', title: '月末の仕事', repeat: 'monthly', due: '2026-02-28', done: true, completedOn: '2026-02-28', repeatAnchorDay: 31, nextOccurrenceOn: '2026-03-31', repeatRetired: false },
    { id: 'retired', title: '旧版の履歴', repeat: 'daily', done: true, repeatRetired: true }
  ], events: [], notes: [] });
  const app = createApp({ stored: original });
  assert.equal(app.run('data.tasks[0].repeatAnchorDay'), 31);
  assert.equal(app.run('data.tasks[0].nextOccurrenceOn'), '2026-03-31');
  assert.equal(app.run('data.tasks[1].repeatRetired'), true);
  app.run('save()');
  const reloaded = createApp({ stored: app.storage.get('dayflow-v2') });
  assert.equal(reloaded.run('data.tasks[0].repeatAnchorDay'), 31);
  assert.equal(reloaded.run('data.tasks[0].nextOccurrenceOn'), '2026-03-31');
  assert.equal(reloaded.run('data.tasks[1].repeatRetired'), true);
});

test('duplicate task and subtask IDs are made unique without dropping records', () => {
  const app = createApp();
  const result = JSON.parse(app.run(`JSON.stringify(normalizeData({tasks:[
    {id:'duplicate',title:'一つ目',subtasks:[{id:'sub',title:'子1'},{id:'sub',title:'子2'},{id:'sub',title:'子3'}]},
    {id:'duplicate',title:'二つ目'}
  ],events:[],notes:[]},{strict:true}))`));
  assert.equal(result.tasks.length, 2);
  assert.equal(new Set(result.tasks.map(task => String(task.id))).size, 2);
  assert.equal(result.tasks[0].subtasks.length, 3);
  assert.equal(new Set(result.tasks[0].subtasks.map(task => String(task.id))).size, 3);
  assert.deepEqual(result.tasks[0].subtasks.map(task => task.title), ['子1', '子2', '子3']);
});

test('malformed JSON is retained for recovery before replacing the active storage key', () => {
  const original = '{invalid json';
  const app = createApp({ stored: original });
  assert.equal(app.run('data.tasks.length'), 0);
  assert.equal(app.storage.get('dayflow-v2'), original);
  assert.equal(app.run('save()'), true);
  const recovery = [...app.storage.entries()].find(([key]) => key.startsWith('dayflow-v2-recovery-'));
  assert.equal(recovery[1], original);
  assert.deepEqual(JSON.parse(app.storage.get('dayflow-v2')).tasks, []);
});

test('failed recovery write keeps the original storage intact', () => {
  const original = '{invalid json';
  const app = createApp({ stored: original, failWrites: true });
  assert.equal(app.run('save()'), false);
  assert.equal(app.storage.get('dayflow-v2'), original);
  assert.match(app.run('storageWarning'), /保存できません/);
});

test('structurally damaged JSON is backed up while valid records remain available', () => {
  const original = JSON.stringify({ tasks: [{ title: '有効なタスク' }, { title: 123 }], events: [], notes: [] });
  const app = createApp({ stored: original });
  assert.equal(app.run('data.tasks.length'), 1);
  assert.equal(app.run('data.tasks[0].title'), '有効なタスク');
  assert.equal(app.run('save()'), true);
  const recovery = [...app.storage.entries()].find(([key]) => key.startsWith('dayflow-v2-recovery-'));
  assert.equal(recovery[1], original);
  assert.equal(JSON.parse(app.storage.get('dayflow-v2')).tasks.length, 1);
});

test('unavailable browser storage does not prevent startup or in-memory edits', () => {
  const app = createApp({ blockedStorage: true });
  assert.equal(app.run('data.notes.length'), 0);
  app.run("data.notes.push({id:1,body:'メモ'})");
  assert.equal(app.run('save()'), false);
  assert.equal(app.run('data.notes[0].body'), 'メモ');
});

test('focus timer finishes once after navigating away and a delayed browser tick', () => {
  const app = createApp();
  app.run("page='focus'; render()");
  app.node('#focusTask').oninput({ target: { value: '  QR修正  ' } });
  app.node('#timerStart').onclick();
  app.run("page='home'; render()");
  assert.equal(app.node('#timer'), undefined);
  app.advance(26 * 60 * 1000);
  assert.equal(app.run('timer'), 0);
  assert.equal(app.run('interval'), null);
  assert.equal(app.run('data.sessions.length'), 1);
  assert.equal(app.run('data.sessions[0].minutes'), 25);
  assert.equal(app.run('data.sessions[0].task'), 'QR修正');
  app.advance(60000);
  assert.equal(app.run('data.sessions.length'), 1);
  assert.equal(JSON.parse(app.storage.get('dayflow-v2')).sessions.length, 1);
});

test('focus pause and resume use remaining time and retain the task name', () => {
  const app = createApp();
  app.run("page='focus'; render()");
  app.node('#focusTask').oninput({ target: { value: '読書' } });
  app.node('#timerStart').onclick();
  app.advance(10000);
  app.node('#timerStart').onclick();
  assert.equal(app.run('timer'), 1490);
  assert.equal(app.run('interval'), null);
  app.advance(60000);
  assert.equal(app.run('timer'), 1490);
  app.node('#timerStart').onclick();
  app.advance(1490 * 1000);
  assert.equal(app.run('data.sessions.length'), 1);
  assert.equal(app.run('data.sessions[0].task'), '読書');
});

test('reset restores the selected focus duration and cancels the active timer', () => {
  const app = createApp();
  app.run("page='focus'; render()");
  app.durationButton(50).onclick();
  app.node('#timerStart').onclick();
  app.advance(15000);
  app.node('#timerReset').onclick();
  assert.equal(app.run('timer'), 3000);
  assert.equal(app.run('interval'), null);
  assert.equal(app.timers.size, 0);
  assert.equal(app.run('data.sessions.length'), 0);
});
