const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function calendarHarness({ date = '2026-01-31T12:00:00', events = [], tasks = [], notificationPermission } = {}) {
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
    // 選択欄は selected の付いた選択肢（無ければ先頭）を値にする。実際のブラウザと同じ決まり方。
    for (const select of html.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
      const options = [...select[2].matchAll(/<option value="([^"]*)"([^>]*)>/g)];
      const chosen = options.find(option => /\bselected\b/.test(option[2])) || options[0];
      nodes.set('#' + select[1], node(unescape(chosen ? chosen[1] : '')));
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
  // 通知の許可状態を指定したときだけ、ブラウザの通知機能の代わりを用意し、表示した通知を記録する。
  if (notificationPermission) {
    const Notification = {
      permission: notificationPermission,
      requestPermission() { context.permissionRequests = (context.permissionRequests || 0) + 1; return Promise.resolve(context.permissionAnswer || 'denied'); }
    };
    context.window = { Notification };
    context.Notification = Notification;
  }
  context.notifications = [];
  context.showAppNotification = (body, tag) => context.notifications.push({ body, tag });
  const source = fs.readFileSync(path.join(__dirname, '..', 'enhancements.js'), 'utf8').replace(/\r\n/g, '\n');
  const exposed = source.replace('  resetDailyTasks();\n  render();', `  globalThis.calendarTest = { parseCalendarDate, calendarDateKey, editCalendarEvent, checkReminders, getState: () => ({ selectedDay, eventDraft }) };\n  resetDailyTasks();\n  render();`);
  assert.notEqual(exposed, source, 'カレンダーのテスト用関数を公開できること');
  // 予定の日付計算（schedule.js）を先に読み込む。ブラウザでの読み込み順と同じ。
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'schedule.js'), 'utf8'), context);
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

test('スマホ幅でヘッダーの日付を隠すCSSが、カレンダーの今日のセルまで隠さない', () => {
  // 今日のセルにも today クラスが付くため、`.today` だけを隠すとスマホで今日が消え、以降の日付が1列ずれる。
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const hiddenSelectors = [...css.matchAll(/(?:^|[{}])\s*([^{}@]+)\{[^}]*display:none/g)].flatMap(match => match[1].split(',').map(selector => selector.trim()));
  assert.ok(hiddenSelectors.includes('.header .today'));
  assert.ok(!hiddenSelectors.some(selector => /(^|\s)\.today$/.test(selector) && !selector.startsWith('.header')), hiddenSelectors.join(' | '));
});

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

function selectedAgenda(html) {
  return html.split('aria-labelledby="selectedDayHeading"')[1].split('</section>')[0];
}

test('毎週の予定を作成すると各週に表示され、月一覧では1件にまとまる', () => {
  const { context, nodes, submit } = calendarHarness({ date: '2026-11-19T12:00:00' });
  nodes.get('#eventDate').value = '2026-11-03';
  nodes.get('#eventEndDate').value = '';
  nodes.get('#eventRepeat').value = 'weekly';
  nodes.get('#eventTitle').value = '週次ミーティング';
  nodes.get('#eventTime').value = '10:00';
  submit();
  assert.equal(context.data.events.length, 1);
  const event = context.data.events[0];
  assert.equal(event.repeat, 'weekly');
  assert.equal(event.repeatUntil, '');
  for (const day of ['03', '10', '17', '24']) assert.match(calendarDay(context.html, '2026-11-' + day), new RegExp(`data-event-edit="${event.id}" data-event-date="2026-11-${day}"`));
  for (const day of ['02', '04', '11']) assert.doesNotMatch(calendarDay(context.html, '2026-11-' + day), new RegExp(`data-event-edit="${event.id}"`));
  const agenda = monthAgenda(context.html);
  assert.equal((agenda.match(new RegExp(`data-event-edit="${event.id}"`, 'g')) || []).length, 1);
  assert.match(agenda, /毎週火曜/);
  assert.match(agenda, /この月4回/);
  assert.equal(nodes.get('#eventRepeat').value, 'none', '追加後は繰り返しを初期値に戻す');
  nodes.get('#nextMonth').onclick();
  for (const day of ['01', '08', '15', '22', '29']) assert.match(calendarDay(context.html, '2026-12-' + day), new RegExp(`data-event-edit="${event.id}"`));
});

test('繰り返しの終了日を過ぎた回と開始日より前は表示しない', () => {
  const events = [{ id: 'until', date: '2026-11-05', endDate: '2026-11-05', title: '期間限定', time: '', repeat: 'daily', repeatUntil: '2026-11-07', exceptions: [] }];
  const { context } = calendarHarness({ date: '2026-11-19T12:00:00', events });
  for (const day of ['05', '06', '07']) assert.match(calendarDay(context.html, '2026-11-' + day), /data-event-edit="until"/);
  for (const day of ['04', '08']) assert.doesNotMatch(calendarDay(context.html, '2026-11-' + day), /data-event-edit="until"/);
});

test('繰り返し予定は選んだ回だけ削除でき、ほかの回は残る', () => {
  const events = [{ id: 'weekly', date: '2026-11-03', endDate: '2026-11-03', title: '授業', time: '09:00', repeat: 'weekly', repeatUntil: '', exceptions: [] }];
  const { context, nodes } = calendarHarness({ date: '2026-11-19T12:00:00', events });
  context.calendarTest.editCalendarEvent('weekly', '2026-11-10');
  assert.ok(nodes.get('#deleteEventOccurrence'), 'この回だけ削除のボタンがある');
  nodes.get('#deleteEventOccurrence').onclick();
  assert.match(context.deleteMessage, /2026-11-10 の回だけ/);
  assert.deepEqual(context.data.events[0].exceptions, [], '確認前は消さない');
  context.acceptDelete();
  assert.deepEqual([...context.data.events[0].exceptions], ['2026-11-10']);
  assert.doesNotMatch(calendarDay(context.html, '2026-11-10'), /data-event-edit="weekly"/);
  assert.match(calendarDay(context.html, '2026-11-17'), /data-event-edit="weekly"/);
  assert.equal(context.calendarTest.getState().selectedDay, '2026-11-10');
  // カレンダー上の回のボタンから開くと、その回の日付が編集画面に渡る。
  context.document.querySelector('[data-event-edit="weekly"]').onclick();
  nodes.get('#deleteCalendarEvent').onclick();
  assert.match(context.deleteMessage, /すべての回/);
  context.acceptDelete();
  assert.equal(context.data.events.length, 0);
});

test('繰り返さない予定の編集画面には「この回だけ削除」を出さない', () => {
  const { context, nodes } = calendarHarness({ events: [{ id: 'single', date: '2026-01-31', endDate: '2026-01-31', title: '単発', time: '' }] });
  nodes.delete('#deleteEventOccurrence');
  context.calendarTest.editCalendarEvent('single', '2026-01-31');
  assert.equal(nodes.has('#deleteEventOccurrence'), false);
  nodes.get('#deleteCalendarEvent').onclick();
  assert.equal(context.deleteMessage, 'この予定を完全に削除しますか？');
});

test('次の回と重なる長さの繰り返しや、開始日より前の繰り返し終了日は保存しない', () => {
  const { context, nodes, submit } = calendarHarness({ date: '2026-11-19T12:00:00' });
  nodes.get('#eventDate').value = '2026-11-02';
  nodes.get('#eventEndDate').value = '2026-11-09';
  nodes.get('#eventRepeat').value = 'weekly';
  nodes.get('#eventTitle').value = '長すぎる週次予定';
  submit();
  assert.equal(context.data.events.length, 0);
  assert.equal(nodes.get('#eventEndDate').validationMessage, '毎週繰り返す予定は7日以内にしてください。');
  nodes.get('#eventEndDate').value = '2026-11-08';
  nodes.get('#eventRepeatUntil').value = '2026-11-01';
  submit();
  assert.equal(context.data.events.length, 0);
  assert.equal(nodes.get('#eventRepeatUntil').validationMessage, '繰り返しの終了日は開始日以降にしてください。');
  nodes.get('#eventRepeatUntil').value = '2026-12-31';
  submit();
  assert.equal(context.data.events.length, 1);
  assert.equal(context.data.events[0].endDate, '2026-11-08');
  assert.equal(context.data.events[0].repeatUntil, '2026-12-31');
});

test('繰り返し予定を編集すると全回に反映され、開始日を変えると「この回だけ削除」を解除する', () => {
  const events = [{ id: 'series', date: '2026-11-03', endDate: '2026-11-03', title: '変更前', time: '', repeat: 'weekly', repeatUntil: '', exceptions: ['2026-11-10'] }];
  const { context, nodes } = calendarHarness({ date: '2026-11-19T12:00:00', events });
  context.calendarTest.editCalendarEvent('series', '2026-11-17');
  nodes.get('#editEventTitle').value = '変更後';
  nodes.get('#editEventForm').onsubmit({ preventDefault() {} });
  assert.equal(context.data.events[0].title, '変更後');
  assert.deepEqual([...context.data.events[0].exceptions], ['2026-11-10'], 'タイトルだけの変更では残す');
  assert.equal(context.calendarTest.getState().selectedDay, '2026-11-17', '開いていた回の日付に留まる');
  context.calendarTest.editCalendarEvent('series', '2026-11-17');
  nodes.get('#editEventDate').value = '2026-11-04';
  nodes.get('#editEventEndDate').value = '2026-11-04';
  nodes.get('#editEventForm').onsubmit({ preventDefault() {} });
  assert.deepEqual([...context.data.events[0].exceptions], []);
  assert.match(calendarDay(context.html, '2026-11-11'), /data-event-edit="series"/);
  assert.equal(context.calendarTest.getState().selectedDay, '2026-11-18', '変更後の次の回へ移る');
  context.calendarTest.editCalendarEvent('series', '2026-11-18');
  nodes.get('#editEventRepeat').value = 'none';
  nodes.get('#editEventForm').onsubmit({ preventDefault() {} });
  assert.equal(context.data.events[0].repeat, 'none');
  assert.equal(context.data.events[0].repeatUntil, '');
  assert.doesNotMatch(calendarDay(context.html, '2026-11-11'), /data-event-edit="series"/);
});

test('入力途中の繰り返し設定は月を移動しても保持される', () => {
  const { context, nodes } = calendarHarness();
  nodes.get('#eventRepeat').value = 'monthly';
  nodes.get('#eventRepeat').onchange();
  nodes.get('#eventRepeatUntil').value = '2026-12-31';
  nodes.get('#eventRepeatUntil').oninput();
  nodes.get('#nextMonth').onclick();
  assert.equal(nodes.get('#eventRepeat').value, 'monthly');
  assert.equal(nodes.get('#eventRepeatUntil').value, '2026-12-31');
  assert.match(context.html, /<details class="calendar-options" id="eventOptions" open>/);
  assert.match(context.html, /calendar-options-summary">毎月</);
});

test('選択日の一覧では、前日から続く期間の回を先に、その後を時刻順に並べる', () => {
  const events = [
    { id: 'later', date: '2026-01-31', endDate: '2026-01-31', title: '午後', time: '15:00' },
    { id: 'weekly-range', date: '2026-01-23', endDate: '2026-01-24', title: '週末', time: '18:00', repeat: 'weekly', repeatUntil: '', exceptions: [] },
    { id: 'morning', date: '2026-01-31', endDate: '2026-01-31', title: '朝', time: '08:00' }
  ];
  const { context } = calendarHarness({ events });
  const agenda = selectedAgenda(context.html);
  const order = ['weekly-range', 'morning', 'later'].map(id => agenda.indexOf(`data-event-edit="${id}"`));
  assert.ok(order.every(index => index >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(agenda, /期間中|終了/);
});

test('通知つきの予定を作成すると通知設定を保存し、一覧に通知のタイミングを表示する', () => {
  const { context, nodes, submit } = calendarHarness({ date: '2026-11-19T12:00:00' });
  nodes.get('#eventDate').value = '2026-11-20';
  nodes.get('#eventEndDate').value = '';
  nodes.get('#eventTime').value = '10:00';
  nodes.get('#eventReminder').value = '30';
  nodes.get('#eventTitle').value = '面談';
  submit();
  const event = context.data.events[0];
  assert.equal(event.reminder, 30);
  assert.equal(event.remindedStart, '');
  assert.match(selectedAgenda(context.html), /通知 30分前/);
  assert.equal(nodes.get('#eventReminder').value, '', '追加後は通知を初期値に戻す');
  // このテスト環境には通知機能が無いので、届かないことを画面で知らせる。
  assert.match(context.html, /このブラウザは通知に対応していない/);
});

test('通知の許可済みなら、時刻になった回を1回だけ通知して記録する', () => {
  const events = [{ id: 'class', date: '2026-11-03', endDate: '2026-11-03', time: '10:00', title: '授業', repeat: 'weekly', repeatUntil: '', exceptions: [], reminder: 10, remindedStart: '' }];
  const { context } = calendarHarness({ date: '2026-11-10T09:52:00', events, notificationPermission: 'granted' });
  assert.equal(context.notifications.length, 1, '起動時の確認で通知する');
  assert.equal(context.notifications[0].body, '11/10 10:00 授業');
  assert.equal(context.notifications[0].tag, 'event-class-2026-11-10');
  assert.equal(context.data.events[0].remindedStart, '2026-11-10');
  context.calendarTest.checkReminders();
  assert.equal(context.notifications.length, 1, '同じ回は二度通知しない');
});

test('通知の許可前に通知つき予定を作ると許可を求め、断られたら画面で知らせる', async () => {
  const { context, nodes, submit } = calendarHarness({ date: '2026-11-19T12:00:00', notificationPermission: 'default' });
  nodes.get('#eventTitle').value = '確認';
  submit();
  assert.equal(context.permissionRequests, undefined, '通知なしの予定では許可を求めない');
  nodes.get('#eventReminder').value = '0';
  nodes.get('#eventTitle').value = '通知あり';
  submit();
  assert.equal(context.permissionRequests, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(context.html, /通知が許可されなかった/);
});

test('予定の日時や通知を変えると通知済みの記録を消し、タイトルだけなら残す', () => {
  const events = [{ id: 'meeting', date: '2026-11-20', endDate: '2026-11-20', time: '10:00', title: '会議', reminder: 30, remindedStart: '2026-11-20' }];
  const { context, nodes } = calendarHarness({ date: '2026-11-19T12:00:00', events, notificationPermission: 'granted' });
  context.calendarTest.editCalendarEvent('meeting');
  assert.equal(nodes.get('#editEventReminder').value, '30');
  nodes.get('#editEventTitle').value = '定例会議';
  nodes.get('#editEventForm').onsubmit({ preventDefault() {} });
  assert.equal(context.data.events[0].remindedStart, '2026-11-20');
  context.calendarTest.editCalendarEvent('meeting');
  nodes.get('#editEventReminder').value = '10';
  nodes.get('#editEventForm').onsubmit({ preventDefault() {} });
  assert.equal(context.data.events[0].reminder, 10);
  assert.equal(context.data.events[0].remindedStart, '');
  context.calendarTest.editCalendarEvent('meeting');
  nodes.get('#editEventReminder').value = '';
  nodes.get('#editEventForm').onsubmit({ preventDefault() {} });
  assert.equal(context.data.events[0].reminder, null);
});

test('色が自動の予定は1日を青・期間を緑で表示し、選んだ色は期間の全日と印・一覧に使う', () => {
  const events = [
    { id: 'auto-single', date: '2026-01-10', endDate: '2026-01-10', title: '単日', time: '' },
    { id: 'auto-range', date: '2026-01-12', endDate: '2026-01-13', title: '期間', time: '' },
    { id: 'purple-range', date: '2026-01-20', endDate: '2026-01-22', title: '紫の期間', time: '', color: 'purple' }
  ];
  const { context } = calendarHarness({ events });
  assert.match(calendarDay(context.html, '2026-01-10'), /colored-event event-color-blue[^"]*" data-event-edit="auto-single"/);
  assert.match(calendarDay(context.html, '2026-01-12'), /event-color-green[^"]*" data-event-edit="auto-range"/);
  for (const day of ['20', '21', '22']) {
    const cell = calendarDay(context.html, '2026-01-' + day);
    assert.match(cell, /event-color-purple[^"]*" data-event-edit="purple-range"/);
    assert.match(cell, /calendar-dot range-dot colored-dot event-color-purple/);
  }
  assert.match(monthAgenda(context.html), /event-swatch event-color-purple/);
});

test('作成・編集で選んだ色を保存し、入力中の色は見出しにも表示する', () => {
  const { context, nodes, submit } = calendarHarness();
  nodes.get('#eventColor').value = 'pink';
  nodes.get('#eventColor').onchange();
  nodes.get('#nextMonth').onclick();
  assert.equal(nodes.get('#eventColor').value, 'pink');
  assert.match(context.html, /calendar-options-summary">色 ピンク</);
  nodes.get('#eventTitle').value = 'ピンクの予定';
  submit();
  const event = context.data.events[0];
  assert.equal(event.color, 'pink');
  assert.equal(nodes.get('#eventColor').value, '', '追加後は自動に戻す');
  context.calendarTest.editCalendarEvent(event.id);
  assert.equal(nodes.get('#editEventColor').value, 'pink');
  nodes.get('#editEventColor').value = 'gray';
  nodes.get('#editEventForm').onsubmit({ preventDefault() {} });
  assert.equal(event.color, 'gray');
  assert.match(calendarDay(context.html, event.date), /event-color-gray/);
  context.calendarTest.editCalendarEvent(event.id);
  nodes.get('#editEventColor').value = 'unknown';
  nodes.get('#editEventForm').onsubmit({ preventDefault() {} });
  assert.equal(event.color, '', '一覧に無い色は自動として保存する');
});
