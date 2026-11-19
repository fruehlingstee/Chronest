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
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [date])); }
    static now() { return new Date(date).getTime(); }
  }
  const context = {
    Date: ClockDate, console, page: 'calendar', month: new ClockDate(),
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

function calendarDay(html, date) {
  const start = html.indexOf(`data-calendar-day="${date}"`);
  assert.notEqual(start, -1, 'カレンダーに対象日があること: ' + date);
  const nextDay = html.indexOf('data-calendar-day="', start + 1);
  const sectionEnd = html.indexOf('</section>', start);
  return html.slice(start, nextDay < 0 ? sectionEnd : Math.min(nextDay, sectionEnd));
}

function monthAgenda(html) {
  return html.split('aria-labelledby="monthAgendaHeading"')[1].split('</section>')[0];
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
  assert.ok(context.html.indexOf('data-event-edit="2"') < context.html.indexOf('data-event-edit="3"'));
  assert.ok(context.html.indexOf('data-event-edit="3"') < context.html.indexOf('data-event-edit="1"'));
  assert.deepEqual(events.map(event => event.id), [1, 2, 3]);
});

test('空白タイトルを拒否し、予定追加後は登録日が表示される', () => {
  const { context, nodes, submit } = calendarHarness();
  nodes.get('#eventDate').value = '2026-03-15';
  nodes.get('#eventEndDate').value = '';
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
  nodes.get('#editEventEndDate').value = '';
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
  const { context, nodes } = calendarHarness({ events: [{ id: 'a"b', date: '2026-01-31', endDate: '2026-02-02', time: '', title: '<img src=x onerror=alert(1)>' }] });
  assert.doesNotMatch(context.html, /<img src=x/);
  assert.match(context.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(context.html, /data-event-edit="a&quot;b"/);
  nodes.get('#nextMonth').onclick();
  assert.doesNotMatch(context.html, /<img src=x/);
  assert.match(context.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('20日から23日の予定を1件として保存し、初日・中日・末日へ表示する', () => {
  const { context, nodes, submit } = calendarHarness({ date: '2026-11-20T12:00:00' });
  nodes.get('#eventDate').value = '2026-11-20';
  nodes.get('#eventEndDate').value = '2026-11-23';
  nodes.get('#eventTime').value = '09:30';
  nodes.get('#eventTitle').value = '  4日間の予定  ';
  submit();
  assert.equal(context.data.events.length, 1);
  const event = context.data.events[0];
  assert.equal(event.date, '2026-11-20');
  assert.equal(event.endDate, '2026-11-23');
  assert.equal(event.title, '4日間の予定');
  const id = event.id;
  for (const [day, phase] of [['20', 'start'], ['21', 'middle'], ['22', 'middle'], ['23', 'end']]) {
    const cell = calendarDay(context.html, '2026-11-' + day);
    assert.match(cell, new RegExp(`data-event-edit="${id}"`));
    assert.match(cell, new RegExp('event-range-' + phase));
    assert.match(cell, /event-phase/);
  }
  for (const day of ['19', '24']) assert.doesNotMatch(calendarDay(context.html, '2026-11-' + day), new RegExp(`data-event-edit="${id}"`));
  assert.equal((monthAgenda(context.html).match(new RegExp(`data-event-edit="${id}"`, 'g')) || []).length, 1);
  assert.match(monthAgenda(context.html), /event-range-label/);
});

test('期間の編集と終了日の省略を同じ予定へ保存できる', () => {
  const { context, nodes } = calendarHarness({ date: '2026-11-20T12:00:00', events: [{ id: 'range', date: '2026-11-20', endDate: '2026-11-23', title: '期間の編集', time: '' }] });
  context.calendarTest.editCalendarEvent('range');
  assert.equal(nodes.get('#editEventEndDate').value, '2026-11-23');
  nodes.get('#editEventDate').value = '2026-12-30';
  nodes.get('#editEventEndDate').value = '2027-01-02';
  nodes.get('#editEventForm').onsubmit({ preventDefault() {} });
  assert.equal(context.data.events.length, 1);
  assert.equal(context.data.events[0].id, 'range');
  assert.equal(context.data.events[0].date, '2026-12-30');
  assert.equal(context.data.events[0].endDate, '2027-01-02');
  context.calendarTest.editCalendarEvent('range');
  nodes.get('#editEventEndDate').value = '';
  nodes.get('#editEventForm').onsubmit({ preventDefault() {} });
  assert.equal(context.data.events[0].endDate, '2026-12-30');
  assert.match(calendarDay(context.html, '2026-12-30'), /event-range-single/);
});

test('作成と編集で終了日が開始日より前になる期間を保存しない', () => {
  const { context, nodes, submit } = calendarHarness({ date: '2026-11-20T12:00:00' });
  nodes.get('#eventDate').value = '2026-11-20';
  nodes.get('#eventEndDate').value = '2026-11-19';
  nodes.get('#eventTitle').value = '逆転した予定';
  submit();
  assert.equal(context.data.events.length, 0);
  assert.ok(nodes.get('#eventEndDate').validationMessage);
  nodes.get('#eventEndDate').value = '2026-11-23';
  submit();
  const event = context.data.events[0];
  context.calendarTest.editCalendarEvent(event.id);
  nodes.get('#editEventEndDate').value = '2026-11-19';
  nodes.get('#editEventForm').onsubmit({ preventDefault() {} });
  assert.equal(event.endDate, '2026-11-23');
  assert.ok(nodes.get('#editEventEndDate').validationMessage);
});

test('月を跨ぐ予定は両月へ表示し、月一覧は1件のまま当月内を選択する', () => {
  const { context, nodes } = calendarHarness({ events: [{ id: 'range', date: '2026-01-30', endDate: '2026-02-02', title: '月跨ぎ', time: '14:00' }] });
  assert.match(calendarDay(context.html, '2026-01-30'), /event-range-start/);
  assert.match(calendarDay(context.html, '2026-01-31'), /event-range-middle/);
  nodes.get('#nextMonth').onclick();
  assert.match(calendarDay(context.html, '2026-02-01'), /event-range-middle/);
  assert.match(calendarDay(context.html, '2026-02-02'), /event-range-end/);
  const agenda = monthAgenda(context.html);
  assert.equal((agenda.match(/data-event-edit="range"/g) || []).length, 1);
  assert.match(agenda, /data-calendar-select="2026-02-01"/);
  context.document.querySelector('[data-calendar-select="2026-02-01"]').onclick();
  assert.equal(context.month.getMonth(), 1);
  assert.equal(context.calendarTest.getState().selectedDay, '2026-02-01');
});

test('年を跨ぐ期間も開始・途中・終了を正しく判別する', () => {
  const { context, nodes } = calendarHarness({ date: '2026-12-31T12:00:00', events: [{ id: 'year', date: '2026-12-31', endDate: '2027-01-02', title: '年越し', time: '' }] });
  assert.match(calendarDay(context.html, '2026-12-31'), /event-range-start/);
  nodes.get('#nextMonth').onclick();
  assert.match(calendarDay(context.html, '2027-01-01'), /event-range-middle/);
  assert.match(calendarDay(context.html, '2027-01-02'), /event-range-end/);
  assert.equal((monthAgenda(context.html).match(/data-event-edit="year"/g) || []).length, 1);
});

test('閏日を含む期間を日付の欠落なく表示する', () => {
  const { context, nodes } = calendarHarness({ date: '2028-02-28T12:00:00', events: [{ id: 'leap', date: '2028-02-28', endDate: '2028-03-01', title: '閏年の期間', time: '' }] });
  assert.match(calendarDay(context.html, '2028-02-28'), /event-range-start/);
  assert.match(calendarDay(context.html, '2028-02-29'), /event-range-middle/);
  nodes.get('#nextMonth').onclick();
  assert.match(calendarDay(context.html, '2028-03-01'), /event-range-end/);
});

test('旧予定と空欄の終了日は単日として表示・保存する', () => {
  const { context, nodes, submit } = calendarHarness({ events: [{ id: 'legacy', date: '2026-01-31', title: '旧予定', time: '' }] });
  assert.match(calendarDay(context.html, '2026-01-31'), /event-range-single/);
  nodes.get('#eventDate').value = '2026-01-25';
  nodes.get('#eventEndDate').value = '';
  nodes.get('#eventTitle').value = '単日の予定';
  submit();
  const event = context.data.events.find(item => item.title === '単日の予定');
  assert.equal(event.endDate, '2026-01-25');
});

test('月移動と日付選択で入力中の期間の日数を保持する', () => {
  const { context, nodes } = calendarHarness();
  nodes.get('#eventDate').value = '2026-01-31';
  nodes.get('#eventEndDate').value = '2026-02-03';
  nodes.get('#eventTitle').value = '入力中の連続予定';
  nodes.get('#eventTime').value = '13:45';
  nodes.get('#nextMonth').onclick();
  assert.equal(nodes.get('#eventDate').value, '2026-02-01');
  assert.equal(nodes.get('#eventEndDate').value, '2026-02-04');
  context.document.querySelector('[data-calendar-day="2026-02-10"]').onclick();
  assert.equal(nodes.get('#eventDate').value, '2026-02-10');
  assert.equal(nodes.get('#eventEndDate').value, '2026-02-13');
  assert.equal(nodes.get('#eventTitle').value, '入力中の連続予定');
  assert.equal(nodes.get('#eventTime').value, '13:45');
});

test('開始日の入力イベントで作成・編集の終了日も同じ日数だけ移動する', () => {
  const { context, nodes, submit } = calendarHarness();
  nodes.get('#eventEndDate').value = '2026-02-03';
  nodes.get('#eventEndDate').oninput();
  nodes.get('#eventTitle').value = '期間を移動する';
  nodes.get('#eventTitle').oninput();
  const startInput = nodes.get('#eventDate');
  startInput.value = '2026-02-10';
  startInput.oninput();
  assert.equal(nodes.get('#eventEndDate').value, '2026-02-13');
  assert.equal(nodes.get('#eventEndDate').min, '2026-02-10');
  startInput.onchange();
  assert.equal(nodes.get('#eventDate').value, '2026-02-10');
  assert.equal(nodes.get('#eventEndDate').value, '2026-02-13');
  submit();
  const event = context.data.events[0];
  context.calendarTest.editCalendarEvent(event.id);
  const editStart = nodes.get('#editEventDate');
  editStart.value = '2026-03-01';
  editStart.oninput();
  assert.equal(nodes.get('#editEventEndDate').value, '2026-03-04');
  assert.equal(nodes.get('#editEventEndDate').min, '2026-03-01');
  nodes.get('#editEventForm').onsubmit({ preventDefault() {} });
  assert.equal(event.date, '2026-03-01');
  assert.equal(event.endDate, '2026-03-04');
  assert.equal(context.data.events.length, 1);
});

test('日付セルの表示上限を超えた予定も選択日の一覧で全件確認できる', () => {
  const events = Array.from({ length: 5 }, (_, index) => ({ id: 'event-' + index, date: '2026-01-31', endDate: '2026-01-31', title: '予定' + index, time: '' }));
  const { context } = calendarHarness({ events });
  const cell = calendarDay(context.html, '2026-01-31');
  assert.equal((cell.match(/data-event-edit=/g) || []).length, 3);
  assert.match(cell, /calendar-more/);
  context.document.querySelector('[data-calendar-select="2026-01-31"]').onclick();
  const agenda = context.html.split('aria-labelledby="selectedDayHeading"')[1].split('</section>')[0];
  assert.equal((agenda.match(/data-event-edit=/g) || []).length, 5);
});
