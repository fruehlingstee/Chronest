const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function calendarHarness({ date = '2026-01-31T12:00:00', events = [], tasks = [] } = {}) {
  const nodes = new Map();
  let buttons = [];
  const unescape = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const node = (value = '') => ({
    value, dataset: {}, validationMessage: '',
    setCustomValidity(message) { this.validationMessage = message; },
    reportValidity() { return [...nodes.values()].every(item => !item.validationMessage); },
    focus() {}, setAttribute() {}
  });
  function installMarkup(html) {
    for (const tag of html.matchAll(/<(?:input|form|button|div)\b[^>]*>/g)) {
      const id = tag[0].match(/\bid="([^"]+)"/);
      if (id) nodes.set('#' + id[1], node(unescape(tag[0].match(/\bvalue="([^"]*)"/)?.[1] || '')));
    }
    buttons = [...html.matchAll(/<button\b[^>]*>/g)].map(match => {
      const item = node();
      for (const attribute of match[0].matchAll(/\bdata-([a-z-]+)="([^"]*)"/g)) {
        const name = attribute[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        item.dataset[name] = unescape(attribute[2]);
      }
      return item;
    });
  }
  const context = {
    Date, console, page: 'calendar', month: new Date(date),
    data: { tasks, events, notes: [], sessions: [] },
    bind() {}, save() {}, closeModal() {},
    setInterval() {}, window: {},
    dayKey: value => `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`,
    esc: value => String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]),
    document: {
      querySelector(selector) {
        if (selector.startsWith('[data-')) {
          const [, attribute, value] = selector.match(/^\[data-([a-z-]+)="([^"]+)"\]$/);
          const key = attribute.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
          return buttons.find(item => item.dataset[key] === value);
        }
        if (!nodes.has(selector)) nodes.set(selector, node());
        return nodes.get(selector);
      },
      querySelectorAll(selector) {
        const names = [...selector.matchAll(/\[data-([a-z-]+)\]/g)].map(match => match[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()));
        return buttons.filter(item => names.some(name => name in item.dataset));
      }
    },
    modal(html) { installMarkup(html); },
    confirmDelete(message, accept) { context.deleteMessage = message; context.acceptDelete = accept; },
    render() {
      context.html = context.calendar();
      installMarkup(context.html);
      context.bind();
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'enhancements.js'), 'utf8').replace(/\r\n/g, '\n');
  const exposed = source.replace('  resetDailyTasks();\n  render();', `  globalThis.calendarTest = { parseCalendarDate, calendarDateKey, compareEvents, editCalendarEvent, getState: () => ({ selectedDay, eventDraft }) };\n  resetDailyTasks();\n  render();`);
  assert.notEqual(exposed, source, 'カレンダーのテスト用関数を公開できること');
  vm.runInNewContext(exposed, context);
  return { context, nodes, submit: () => nodes.get('#eventForm').onsubmit({ preventDefault() {} }) };
}

test('31日からの前月・翌月移動と年越しで月を飛ばさない', () => {
  const { context, nodes } = calendarHarness();
  nodes.get('#nextMonth').onclick();
  assert.equal(context.month.getMonth(), 1);
  assert.equal(context.month.getDate(), 1);
  assert.match(context.html, /2026年 2月/);
  nodes.get('#prevMonth').onclick();
  nodes.get('#prevMonth').onclick();
  assert.equal(context.month.getFullYear(), 2025);
  assert.equal(context.month.getMonth(), 11);
});

test('閏年・存在しない日付・日付範囲を検証する', () => {
  const { context } = calendarHarness({ date: '2028-02-01T12:00:00' });
  const parse = context.calendarTest.parseCalendarDate;
  assert.ok(parse('2028-02-29'));
  for (const invalid of ['2026-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '10000-01-01', '2026-1-1', '']) {
    assert.equal(parse(invalid), null, invalid);
  }
  assert.ok(parse('0001-01-01'));
  assert.ok(parse('9999-12-31'));
  assert.match(context.html, /data-calendar-day="2028-02-29"/);
  assert.doesNotMatch(context.html, /data-calendar-day="2028-02-30"/);
});

test('予定を終日・時刻順に表示し、元の保存順は変更しない', () => {
  const events = [
    { id: 1, date: '2026-01-31', time: '15:00', title: '午後の予定' },
    { id: 2, date: '2026-01-31', time: '', title: '終日の予定' },
    { id: 3, date: '2026-01-31', time: '09:00', title: '朝の予定' }
  ];
  const { context } = calendarHarness({ events });
  assert.ok(context.html.indexOf('終日 終日の予定') < context.html.indexOf('09:00 朝の予定'));
  assert.ok(context.html.indexOf('09:00 朝の予定') < context.html.indexOf('15:00 午後の予定'));
  assert.deepEqual(events.map(event => event.id), [1, 2, 3]);
});

test('空白タイトルを拒否し、予定追加後は登録日が表示される', () => {
  const { context, nodes, submit } = calendarHarness();
  nodes.get('#eventDate').value = '2026-03-15';
  nodes.get('#eventTitle').value = '   ';
  submit();
  assert.equal(context.data.events.length, 0);
  nodes.get('#eventTitle').value = '  春の予定  ';
  submit();
  assert.equal(context.data.events.length, 1);
  assert.equal(context.data.events[0].title, '春の予定');
  assert.equal(context.data.events[0].date, '2026-03-15');
  assert.equal(context.calendarTest.getState().selectedDay, '2026-03-15');
  assert.match(context.html, /2026年 3月/);
  assert.equal(nodes.get('#eventTitle').value, '');
});

test('予定の編集・日付移動・確認後の削除が保存される', () => {
  const { context, nodes } = calendarHarness({ events: [{ id: 1, date: '2026-01-31', time: '', title: '変更前' }] });
  context.calendarTest.editCalendarEvent('1');
  nodes.get('#editEventTitle').value = '  変更後  ';
  nodes.get('#editEventDate').value = '2026-02-28';
  nodes.get('#editEventTime').value = '10:30';
  nodes.get('#editEventForm').onsubmit({ preventDefault() {} });
  assert.equal(context.data.events[0].title, '変更後');
  assert.equal(context.data.events[0].time, '10:30');
  assert.equal(context.calendarTest.getState().selectedDay, '2026-02-28');
  context.calendarTest.editCalendarEvent(1);
  nodes.get('#deleteCalendarEvent').onclick();
  assert.equal(context.data.events.length, 1, '確認前は消さない');
  context.acceptDelete();
  assert.equal(context.data.events.length, 0);
});

test('月移動で入力中のタイトルと時刻を保持する', () => {
  const { context, nodes } = calendarHarness();
  nodes.get('#eventTitle').value = '入力途中';
  nodes.get('#eventTime').value = '14:30';
  nodes.get('#nextMonth').onclick();
  assert.equal(nodes.get('#eventTitle').value, '入力途中');
  assert.equal(nodes.get('#eventTime').value, '14:30');
  assert.equal(nodes.get('#eventDate').value, '2026-02-01');
  assert.equal(context.calendarTest.getState().selectedDay, '2026-02-01');
});

test('矢印キーで月境界の日付へ移動する', () => {
  const { context } = calendarHarness();
  const button = context.document.querySelector('[data-calendar-day="2026-01-31"]');
  let prevented = false;
  button.onkeydown({ key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.equal(context.calendarTest.getState().selectedDay, '2026-02-01');
});

test('予定名はHTMLとして解釈されない', () => {
  const { context } = calendarHarness({ events: [{ id: 'a"b', date: '2026-01-31', time: '', title: '<img src=x onerror=alert(1)>' }] });
  assert.doesNotMatch(context.html, /<img src=x/);
  assert.match(context.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(context.html, /data-event-edit="a&quot;b"/);
});
