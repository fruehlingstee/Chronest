const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function taskHarness({ date = '2026-11-19T12:00:00', tasks = [] } = {}) {
  const scopes = new Map();
  const timers = [];
  let clock = new Date(date).getTime();
  let saved = '';
  let saves = 0;
  let uuid = 0;
  const unescape = value => String(value).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const allNodes = () => [...scopes.values()].flat();
  function matches(node, selector) {
    if (selector.startsWith('#')) return node.id === selector.slice(1);
    if (selector.startsWith('.')) return node.classes.includes(selector.slice(1));
    const attribute = selector.match(/^\[data-([a-z-]+)(?:="([^"]*)")?\]$/);
    if (!attribute) return false;
    const name = attribute[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return name in node.dataset && (attribute[2] === undefined || node.dataset[name] === attribute[2]);
  }
  function installMarkup(html, scope) {
    for (const old of scopes.get(scope) || []) old.isConnected = false;
    const entries = [];
    scopes.set(scope, entries);
    for (const match of html.matchAll(/<(input|form|button|select|textarea|div|section)\b([^>]*)>/g)) {
      const [tag, name, attributes] = match;
      const node = {
        id: attributes.match(/\bid="([^"]*)"/)?.[1] || '', classes: (attributes.match(/\bclass="([^"]*)"/)?.[1] || '').split(' '),
        dataset: {}, value: unescape(attributes.match(/\bvalue="([^"]*)"/)?.[1] || ''),
        checked: /\bchecked\b/.test(attributes), hidden: false, disabled: false, isConnected: true,
        validationMessage: '', textContent: '',
        focus() {}, setAttribute() {}, addEventListener(event, callback) { this['on' + event] = callback; },
        setCustomValidity(message) { this.validationMessage = message; },
        reportValidity() { return allNodes().every(entry => !entry.validationMessage); },
        checkValidity() { return this.reportValidity(); }
      };
      for (const attribute of attributes.matchAll(/\bdata-([a-z-]+)="([^"]*)"/g)) {
        node.dataset[attribute[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = unescape(attribute[2]);
      }
      if (name === 'select') {
        const body = html.slice(match.index + tag.length).split('</select>')[0];
        const options = [...body.matchAll(/<option\b([^>]*)>/g)];
        const selected = options.find(option => /\bselected\b/.test(option[1])) || options[0];
        node.value = selected?.[1].match(/\bvalue="([^"]*)"/)?.[1] || '';
      }
      if (name === 'textarea') node.value = unescape(html.slice(match.index + tag.length).split('</textarea>')[0]);
      Object.defineProperty(node, 'innerHTML', {
        get() { return this.html || ''; },
        set(markup) { this.html = markup; installMarkup(markup, this.id || scope + '-children'); }
      });
      entries.push(node);
    }
  }
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const context = {
    Date: ClockDate, console, page: 'tasks', month: new ClockDate(), filter: 'all', query: '',
    crypto: { randomUUID: () => 'task-test-' + ++uuid },
    data: { tasks: tasks.map(task => ({ id: 'base', title: 'タスク', due: '', priority: 'medium', note: '', done: false, created: new ClockDate().toISOString(), repeat: 'none', subtasks: [], reminderAt: '', notified: false, completedOn: '', ...task })), events: [], notes: [], sessions: [] },
    bind() {},
    save() { saves++; saved = JSON.stringify(context.data); },
    setInterval(callback) { timers.push(callback); }, window: {},
    dayKey: value => `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`,
    esc: value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]),
    document: {
      querySelector: selector => allNodes().find(node => matches(node, selector)) || null,
      querySelectorAll: selector => allNodes().filter(node => selector.split(',').some(part => matches(node, part.trim())))
    },
    modal(html) { installMarkup(html, 'modal'); },
    closeModal() { installMarkup('', 'modal'); },
    confirmDelete(message, accept) { context.acceptDelete = accept; },
    render() {
      scopes.delete('taskList');
      context.html = context.tasks();
      installMarkup(context.html, 'main');
      context.bind();
    }
  };
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  vm.runInNewContext(appSource.slice(appSource.indexOf('function isDateKey('), appSource.indexOf('function normalizeData(')), context);
  const source = fs.readFileSync(path.join(__dirname, '..', 'enhancements.js'), 'utf8');
  const exposed = source.replace(/\}\)\(\);\s*$/, 'globalThis.taskTest={nextDate,spawnRepeat,resetDailyTasks};})();');
  vm.runInNewContext(exposed, context, { filename: 'enhancements.js' });
  return {
    context,
    node: selector => context.document.querySelector(selector),
    data: () => context.data,
    saved: () => saved,
    saves: () => saves,
    advance(ms) { clock += ms; timers.forEach(callback => callback()); },
    input(selector, value) {
      const field = this.node(selector);
      field.value = value;
      field.oninput?.({ target: field });
      this.node('#taskForm')?.oninput?.({ target: field });
    },
    submitAdd() { this.node('#taskForm').onsubmit({ preventDefault() {} }); },
    saveEditor() {
      const form = this.node('#taskEditForm');
      if (form?.onsubmit) form.onsubmit({ preventDefault() {} });
      else this.node('#saveEdit').onclick();
    },
    toggle(id, checked) { const input = this.node(`[data-toggle="${id}"]`); input.checked = checked; input.onchange(); }
  };
}

test('subtask edits retain every entered parent field and commit together only on Save', () => {
  const harness = taskHarness({ tasks: [{ id: 'original', title: '変更前', subtasks: [{ id: 'sub-1', title: '既存の子', done: false }] }] });
  harness.context.editTask('original');
  harness.node('#editTitle').value = '  変更後  ';
  harness.node('#editNote').value = '入力中のメモ';
  harness.node('#editPriority').value = 'high';
  harness.node('#editDue').value = '2026-12-01';
  harness.node('#editReminder').value = '2026-11-20T10:30';
  harness.node('#newSubtask').value = '新しい子';
  harness.node('#addSubtask').onclick({ preventDefault() {} });
  assert.equal(harness.node('#editTitle').value, '  変更後  ');
  assert.equal(harness.node('#editNote').value, '入力中のメモ');
  assert.equal(harness.node('#editPriority').value, 'high');
  assert.equal(harness.node('#editDue').value, '2026-12-01');
  assert.equal(harness.node('#editReminder').value, '2026-11-20T10:30');
  assert.equal(harness.data().tasks[0].subtasks.length, 1, '保存前は親dataを変更しない');
  const toggle = harness.node('[data-sub-toggle="sub-1"]');
  toggle.checked = true;
  toggle.onchange();
  assert.equal(harness.node('#editTitle').value, '  変更後  ');
  harness.saveEditor();
  assert.equal(harness.data().tasks[0].title, '変更後');
  assert.equal(harness.data().tasks[0].note, '入力中のメモ');
  assert.equal(harness.data().tasks[0].subtasks.length, 2);
  assert.equal(harness.data().tasks[0].subtasks[0].done, true);
  assert.equal(JSON.parse(harness.saved()).tasks[0].title, '変更後');
});

test('Cancel discards added, checked and removed subtasks without saving', () => {
  const harness = taskHarness({ tasks: [{ id: 'original', subtasks: [{ id: 'sub-1', title: '元の子', done: false }, { id: 'sub-2', title: '削除を取り消す子', done: false }] }] });
  const before = JSON.stringify(harness.data());
  const saves = harness.saves();
  harness.context.editTask('original');
  harness.node('#newSubtask').value = 'キャンセルする子';
  harness.node('#addSubtask').onclick({ preventDefault() {} });
  const toggle = harness.node('[data-sub-toggle="sub-1"]');
  toggle.checked = true;
  toggle.onchange();
  harness.node('[data-sub-remove="sub-2"]').onclick({ preventDefault() {} });
  harness.node('#cancelEdit').onclick();
  assert.equal(JSON.stringify(harness.data()), before);
  assert.equal(harness.saves(), saves);
});

test('editing only a title retains the recurrence reservation and anchor after reload', () => {
  const harness = taskHarness({ tasks: [{ id: 'monthly', title: '変更前', repeat: 'monthly', due: '2026-10-31', done: true, completedOn: '2026-11-19', nextOccurrenceOn: '2026-11-30', repeatAnchorDay: 31, repeatRetired: false }] });
  harness.context.editTask('monthly');
  harness.node('#editTitle').value = '変更後';
  harness.saveEditor();
  assert.equal(harness.data().tasks[0].title, '変更後');
  assert.equal(harness.data().tasks[0].nextOccurrenceOn, '2026-11-30');
  assert.equal(harness.data().tasks[0].repeatAnchorDay, 31);
  assert.equal(harness.data().tasks[0].done, true);
  const reloaded = taskHarness({ tasks: JSON.parse(harness.saved()).tasks });
  assert.equal(reloaded.data().tasks[0].id, 'monthly');
  assert.equal(reloaded.data().tasks[0].nextOccurrenceOn, '2026-11-30');
  assert.equal(reloaded.data().tasks[0].repeatAnchorDay, 31);
  assert.equal(reloaded.data().tasks.length, 1);
});

test('saving a title after a midnight recurrence reset does not restore stale completion or dates', () => {
  const harness = taskHarness({ tasks: [{
    id: 'daily', title: '変更前', repeat: 'daily', due: '2026-11-19', done: true,
    completedOn: '2026-11-19', nextOccurrenceOn: '2026-11-20',
    reminderAt: '2026-11-19T10:30', notified: true,
    subtasks: [{ id: 'daily-subtask', title: '毎日の子', done: true }]
  }] });
  harness.context.editTask('daily');
  harness.node('#editTitle').value = '日付を跨いで変更';
  harness.advance(24 * 60 * 60 * 1000);
  assert.equal(harness.data().tasks[0].done, false);
  harness.saveEditor();
  const task = harness.data().tasks[0];
  assert.equal(harness.data().tasks.length, 1);
  assert.equal(task.id, 'daily');
  assert.equal(task.title, '日付を跨いで変更');
  assert.equal(task.done, false);
  assert.equal(task.completedOn, '');
  assert.equal(task.nextOccurrenceOn, '');
  assert.equal(task.due, '2026-11-20');
  assert.equal(task.reminderAt, '2026-11-20T10:30');
  assert.equal(task.notified, false);
  assert.equal(task.subtasks[0].done, false);
  const stored = JSON.parse(harness.saved()).tasks[0];
  assert.equal(stored.done, false);
  assert.equal(stored.due, '2026-11-20');
  assert.equal(stored.subtasks[0].done, false);
});

test('task creation uses distinct IDs even when the clock does not advance', () => {
  const harness = taskHarness();
  for (const title of ['一つ目', '二つ目']) {
    harness.node('#taskInput').value = title;
    harness.submitAdd();
  }
  assert.equal(harness.data().tasks.length, 2);
  assert.notEqual(harness.data().tasks[0].id, harness.data().tasks[1].id);
});

test('new-task draft survives filtering, and a successful addition clears its title', () => {
  const harness = taskHarness();
  harness.input('#taskInput', '入力途中のタスク');
  harness.input('#taskPriority', 'high');
  harness.input('#taskDue', '2026-12-05');
  harness.input('#taskRepeat', 'weekly');
  harness.node('[data-filter="open"]').onclick();
  assert.equal(harness.node('#taskInput').value, '入力途中のタスク');
  assert.equal(harness.node('#taskPriority').value, 'high');
  assert.equal(harness.node('#taskDue').value, '2026-12-05');
  assert.equal(harness.node('#taskRepeat').value, 'weekly');
  harness.submitAdd();
  assert.equal(harness.data().tasks.length, 1);
  assert.equal(harness.data().tasks[0].repeat, 'weekly');
  assert.equal(harness.data().tasks[0].due, '2026-12-05');
  assert.equal(harness.node('#taskInput').value, '');
});

test('whitespace-only task titles are rejected without adding or saving a record', () => {
  const harness = taskHarness();
  const saves = harness.saves();
  harness.input('#taskInput', '   ');
  harness.submitAdd();
  assert.equal(harness.data().tasks.length, 0);
  assert.equal(harness.saves(), saves);
});

test('chosen task sort survives completion and filter changes', () => {
  const harness = taskHarness({ tasks: [{ id: 'z', title: 'Z' }, { id: 'a', title: 'A' }] });
  harness.node('#sort').value = 'name';
  harness.node('#sort').onchange({ target: harness.node('#sort') });
  assert.equal(harness.context.getTasks()[0].title, 'A');
  harness.toggle('a', true);
  assert.equal(harness.node('#sort').value, 'name');
  harness.node('[data-filter="open"]').onclick();
  assert.equal(harness.node('#sort').value, 'name');
  harness.node('[data-filter="all"]').onclick();
  assert.equal(harness.context.getTasks()[0].title, 'A');
});

test('daily completion remains done today and resets with its subtasks after midnight', () => {
  const harness = taskHarness({ tasks: [{ id: 'daily', repeat: 'daily', due: '2026-11-19', subtasks: [{ id: 's', title: '子', done: true }] }] });
  harness.toggle('daily', true);
  assert.equal(harness.data().tasks.length, 1);
  harness.advance(1000);
  assert.equal(harness.data().tasks[0].done, true);
  harness.advance(24 * 60 * 60 * 1000);
  assert.equal(harness.data().tasks.length, 1);
  assert.equal(harness.data().tasks[0].done, false);
  assert.equal(harness.data().tasks[0].subtasks[0].done, false);
  assert.equal(harness.data().tasks[0].due, '2026-11-20');
});

for (const repeat of ['none', 'daily', 'weekly', 'monthly']) {
  test(`${repeat}: repeatedly checking and undoing completion never increases task count`, () => {
    const harness = taskHarness({ tasks: [{ id: 'same-task', title: '増えないタスク', repeat, due: '2026-11-19' }] });
    for (let count = 0; count < 4; count++) {
      harness.toggle('same-task', true);
      assert.equal(harness.data().tasks.length, 1, '完了チェックでタスクを作らない');
      assert.equal(harness.data().tasks[0].id, 'same-task');
      assert.equal(harness.data().tasks[0].done, true);
      harness.toggle('same-task', false);
      assert.equal(harness.data().tasks.length, 1);
      assert.equal(harness.data().tasks[0].done, false);
    }
  });
}

test('weekly task stays completed until its next due day, then reopens with the same ID', () => {
  const harness = taskHarness({ tasks: [{ id: 'weekly', repeat: 'weekly', due: '2026-11-19' }] });
  harness.toggle('weekly', true);
  assert.equal(harness.data().tasks[0].nextOccurrenceOn, '2026-11-26');
  harness.advance(6 * 24 * 60 * 60 * 1000);
  assert.equal(harness.data().tasks.length, 1);
  assert.equal(harness.data().tasks[0].done, true);
  harness.advance(24 * 60 * 60 * 1000);
  assert.equal(harness.data().tasks.length, 1);
  assert.equal(harness.data().tasks[0].id, 'weekly');
  assert.equal(harness.data().tasks[0].done, false);
  assert.equal(harness.data().tasks[0].due, '2026-11-26');
});

test('monthly tasks keep their month-end anchor through February without multiplying', () => {
  const harness = taskHarness({ date: '2026-01-31T12:00:00', tasks: [{ id: 'monthly', repeat: 'monthly', due: '2026-01-31' }] });
  harness.toggle('monthly', true);
  assert.equal(harness.data().tasks[0].nextOccurrenceOn, '2026-02-28');
  harness.advance(27 * 24 * 60 * 60 * 1000);
  assert.equal(harness.data().tasks[0].done, true);
  harness.advance(24 * 60 * 60 * 1000);
  assert.equal(harness.data().tasks[0].done, false);
  assert.equal(harness.data().tasks[0].due, '2026-02-28');
  harness.toggle('monthly', true);
  assert.equal(harness.data().tasks[0].nextOccurrenceOn, '2026-03-31');
  assert.equal(harness.data().tasks.length, 1);
  assert.equal(harness.data().tasks[0].id, 'monthly');
});

test('overdue weekly completion advances the recurrence beyond today', () => {
  const harness = taskHarness({ tasks: [{ id: 'overdue', repeat: 'weekly', due: '2026-11-01' }] });
  harness.toggle('overdue', true);
  assert.equal(harness.data().tasks.length, 1);
  assert.equal(harness.data().tasks[0].nextOccurrenceOn, '2026-11-22');
});

test('daily reset moves the reminder date and re-arms the notification', () => {
  const harness = taskHarness({ tasks: [{ id: 'daily', repeat: 'daily', due: '2026-11-19', reminderAt: '2026-11-19T10:30', notified: true }] });
  harness.toggle('daily', true);
  harness.advance(24 * 60 * 60 * 1000);
  assert.equal(harness.data().tasks[0].reminderAt, '2026-11-20T10:30');
  assert.equal(harness.data().tasks[0].notified, false);
});

test('legacy generated chains retain completed history and reopen only their active leaf', () => {
  const harness = taskHarness({ tasks: [
    { id: 'parent', repeat: 'daily', due: '2026-11-18', completedOn: '2026-11-18', done: true },
    { id: 'leaf', repeatParent: 'parent', repeat: 'daily', due: '2026-11-18', completedOn: '2026-11-18', done: true }
  ] });
  const parent = harness.data().tasks.find(task => task.id === 'parent');
  const leaf = harness.data().tasks.find(task => task.id === 'leaf');
  assert.equal(harness.data().tasks.length, 2);
  assert.equal(parent.done, true);
  assert.equal(parent.repeatRetired, true);
  assert.equal(leaf.done, false);
  assert.equal(leaf.due, '2026-11-19');
  harness.advance(24 * 60 * 60 * 1000);
  assert.equal(parent.done, true);
  assert.equal(harness.data().tasks.length, 2);
});

test('完了の履歴を残し、同じ日のチェックの付け外しでは回数が増えず、繰り返しタスクは毎回記録する', () => {
  const harness = taskHarness({ tasks: [{ id: 'daily', title: '日課', repeat: 'daily', due: '2026-11-19' }] });
  harness.toggle('daily', true);
  harness.toggle('daily', false);
  harness.toggle('daily', true);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.data().completions)), [{ taskId: 'daily', title: '日課', date: '2026-11-19' }]);
  harness.advance(24 * 60 * 60 * 1000);
  assert.equal(harness.data().tasks[0].done, false, '翌日には未完了に戻る');
  harness.toggle('daily', true);
  assert.deepEqual(Array.from(harness.data().completions, entry => entry.date), ['2026-11-19', '2026-11-20'], '前日の記録は残したまま、今日の完了を追加する');
});
