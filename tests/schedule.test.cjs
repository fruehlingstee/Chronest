const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// schedule.js を単体で読み込み、画面に依存しない日付計算だけを確かめる。
function loadSchedule(now = '2026-11-19T12:00:00') {
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return new Date(now).getTime(); }
  }
  const context = vm.createContext({ Date: ClockDate });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'schedule.js'), 'utf8'), context, { filename: 'schedule.js' });
  return new Proxy({}, { get: (_, name) => vm.runInContext(name, context) });
}

// vm内で作られた配列は別の実行環境の Array になるため、Array.from でこちら側の配列に変換して比べる。
const starts = (schedule, event, from, to) => Array.from(schedule.eventOccurrencesBetween(event, from, to), occurrence => occurrence.start);

test('日付の加算と差分は月末・閏年・年の範囲外を正しく扱う', () => {
  const schedule = loadSchedule();
  assert.equal(schedule.scheduleAddDays('2028-02-28', 1), '2028-02-29');
  assert.equal(schedule.scheduleAddDays('2026-12-31', 1), '2027-01-01');
  assert.equal(schedule.scheduleAddDays('0001-01-01', -1), '');
  assert.equal(schedule.scheduleAddDays('9999-12-31', 1), '');
  assert.equal(schedule.scheduleAddDays('0001-03-01', -1), '0001-02-28');
  assert.equal(schedule.scheduleDayDiff('2026-11-20', '2026-11-23'), 3);
  assert.equal(schedule.scheduleDayDiff('2027-01-02', '2026-12-31'), -2);
});

test('毎週の予定は開始日以降の同じ曜日だけに現れる', () => {
  const schedule = loadSchedule();
  const event = { date: '2026-11-03', endDate: '2026-11-03', repeat: 'weekly', repeatUntil: '', exceptions: [] };
  assert.deepEqual(starts(schedule, event, '2026-10-01', '2026-12-31'), ['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24', '2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29']);
  assert.equal(schedule.eventOccurrenceOn(event, '2026-11-11'), null);
  assert.equal(schedule.eventRepeatLabel(event), '毎週火曜');
});

test('毎月31日・毎年2月29日は、その日が無い月や年を飛ばす', () => {
  const schedule = loadSchedule();
  const monthly = { date: '2026-01-31', endDate: '2026-01-31', repeat: 'monthly', repeatUntil: '', exceptions: [] };
  assert.deepEqual(starts(schedule, monthly, '2026-01-01', '2026-08-31'), ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31', '2026-08-31']);
  const yearly = { date: '2028-02-29', endDate: '2028-02-29', repeat: 'yearly', repeatUntil: '', exceptions: [] };
  assert.deepEqual(starts(schedule, yearly, '2028-01-01', '2036-12-31'), ['2028-02-29', '2032-02-29', '2036-02-29']);
  assert.equal(schedule.eventRepeatLabel(yearly), '毎年2月29日');
});

test('繰り返しの終了日は含み、「この回だけ削除」した日は表示しない', () => {
  const schedule = loadSchedule();
  const event = { date: '2026-11-02', endDate: '2026-11-02', repeat: 'daily', repeatUntil: '2026-11-06', exceptions: ['2026-11-04'] };
  assert.deepEqual(starts(schedule, event, '2026-11-01', '2026-11-30'), ['2026-11-02', '2026-11-03', '2026-11-05', '2026-11-06']);
  assert.equal(schedule.eventRepeatLabel(event), '毎日（2026-11-06まで）');
});

test('期間つきの繰り返しは、各回の初日・途中・最終日を判別し月を跨いでも続く', () => {
  const schedule = loadSchedule();
  const event = { date: '2026-11-27', endDate: '2026-11-29', repeat: 'weekly', repeatUntil: '', exceptions: [] };
  const occurrence = schedule.eventOccurrenceOn(event, '2026-12-06');
  assert.deepEqual({ ...occurrence }, { start: '2026-12-04', end: '2026-12-06' });
  assert.equal(schedule.occurrencePhase(occurrence, '2026-12-04'), 'start');
  assert.equal(schedule.occurrencePhase(occurrence, '2026-12-05'), 'middle');
  assert.equal(schedule.occurrencePhase(occurrence, '2026-12-06'), 'end');
  assert.equal(schedule.eventOccurrenceOn(event, '2026-12-03'), null);
  // 11月27日開始の回は11月29日まで続くため、範囲の初日（11月29日）に重なる回として含める。
  assert.deepEqual(starts(schedule, event, '2026-11-29', '2026-12-05'), ['2026-11-27', '2026-12-04']);
});

test('繰り返さない旧予定は従来どおり期間の中だけに現れる', () => {
  const schedule = loadSchedule();
  const legacy = { date: '2026-11-20', endDate: '2026-11-23' };
  assert.deepEqual({ ...schedule.eventOccurrenceOn(legacy, '2026-11-22') }, { start: '2026-11-20', end: '2026-11-23' });
  assert.equal(schedule.eventOccurrenceOn(legacy, '2026-11-24'), null);
  assert.equal(schedule.eventRepeatLabel(legacy), '');
  assert.deepEqual(starts(schedule, { date: '2026-11-20' }, '2026-11-01', '2026-11-30'), ['2026-11-20']);
});

test('時刻つきの予定は指定した分前から1時間以内だけ通知対象になる', () => {
  const schedule = loadSchedule();
  const event = { date: '2026-11-20', endDate: '2026-11-20', time: '10:00', reminder: 30, remindedStart: '' };
  const at = value => schedule.eventReminderDue(event, new Date(value));
  assert.equal(at('2026-11-20T09:29:00'), '');
  assert.equal(at('2026-11-20T09:30:00'), '2026-11-20');
  assert.equal(at('2026-11-20T10:29:00'), '2026-11-20');
  assert.equal(at('2026-11-20T10:30:00'), '', '1時間を過ぎた古い通知はまとめて出さない');
  assert.equal(schedule.eventReminderDue({ ...event, reminder: null }, new Date('2026-11-20T09:45:00')), '');
  assert.equal(schedule.eventReminderDue({ ...event, remindedStart: '2026-11-20' }, new Date('2026-11-20T09:45:00')), '', '通知済みの回は出さない');
});

test('繰り返し予定は通知済みの次の回から改めて通知する', () => {
  const schedule = loadSchedule();
  const event = { date: '2026-11-03', endDate: '2026-11-03', time: '09:00', repeat: 'weekly', repeatUntil: '', exceptions: ['2026-11-17'], reminder: 10, remindedStart: '2026-11-03' };
  assert.equal(schedule.eventReminderDue(event, new Date('2026-11-03T08:55:00')), '');
  assert.equal(schedule.eventReminderDue(event, new Date('2026-11-10T08:50:00')), '2026-11-10');
  assert.equal(schedule.eventReminderDue({ ...event, remindedStart: '2026-11-10' }, new Date('2026-11-17T08:50:00')), '', '削除した回は通知しない');
  assert.equal(schedule.eventReminderDue({ ...event, remindedStart: '2026-11-10' }, new Date('2026-11-24T08:50:00')), '2026-11-24');
});

test('終日の予定は当日9:00を基準にし、前日や深夜0時をまたぐ通知も扱う', () => {
  const schedule = loadSchedule();
  const allDay = { date: '2026-11-20', endDate: '2026-11-22', time: '', reminder: 1440, remindedStart: '' };
  assert.equal(schedule.eventReminderDue(allDay, new Date('2026-11-19T08:59:00')), '');
  assert.equal(schedule.eventReminderDue(allDay, new Date('2026-11-19T09:00:00')), '2026-11-20');
  assert.equal(schedule.eventReminderLabel(allDay), '前日9:00');
  assert.equal(schedule.eventReminderLabel({ ...allDay, reminder: 0 }), '当日9:00');
  assert.equal(schedule.eventReminderLabel({ ...allDay, reminder: 30 }), '当日8:30');
  const midnight = { date: '2026-11-21', endDate: '2026-11-21', time: '00:10', reminder: 30, remindedStart: '' };
  assert.equal(schedule.eventReminderDue(midnight, new Date('2026-11-20T23:40:00')), '2026-11-21');
  assert.equal(schedule.eventReminderLabel(midnight), '30分前');
  assert.equal(schedule.eventReminderLabel({ ...midnight, reminder: 1440 }), '1日前');
});

test('予定の色は選んだ色を優先し、自動なら回の長さで青か緑にする', () => {
  const schedule = loadSchedule();
  assert.equal(schedule.eventColor({ color: 'purple' }, { start: '2026-11-20', end: '2026-11-20' }), 'purple');
  assert.equal(schedule.eventColor({ color: '' }, { start: '2026-11-20', end: '2026-11-20' }), 'blue');
  assert.equal(schedule.eventColor({}, { start: '2026-11-20', end: '2026-11-22' }), 'green');
  assert.equal(schedule.eventColor({ color: 'red' }, { start: '2026-11-20', end: '2026-11-20' }), 'blue', '一覧に無い色は自動扱い');
  assert.equal(schedule.eventColorChoice('constructor'), '', 'オブジェクトの組み込み名を色として受け付けない');
});

test('次の回と重なる長さの繰り返しを検出する', () => {
  const schedule = loadSchedule();
  assert.equal(schedule.eventRepeatSpanError('none', 400), '');
  assert.equal(schedule.eventRepeatSpanError('daily', 0), '');
  assert.equal(schedule.eventRepeatSpanError('daily', 1), '毎日繰り返す予定は1日以内にしてください。');
  assert.equal(schedule.eventRepeatSpanError('weekly', 6), '');
  assert.equal(schedule.eventRepeatSpanError('weekly', 7), '毎週繰り返す予定は7日以内にしてください。');
  assert.equal(schedule.eventRepeatSpanError('monthly', 28), '毎月繰り返す予定は28日以内にしてください。');
  assert.equal(schedule.eventRepeatSpanError('yearly', 365), '毎年繰り返す予定は365日以内にしてください。');
});

test('終了時刻の表記と、開始時刻との前後関係を確かめる', () => {
  const schedule = loadSchedule();
  assert.equal(schedule.eventTimeRange({ time: '10:00', endTime: '11:30' }), '10:00–11:30');
  assert.equal(schedule.eventTimeRange({ time: '10:00', endTime: '' }), '10:00');
  assert.equal(schedule.eventTimeRange({ time: '' }), '終日');
  assert.equal(schedule.eventEndTimeError({ date: '2026-11-20', endDate: '2026-11-20', time: '10:00', endTime: '11:00' }), '');
  assert.equal(schedule.eventEndTimeError({ date: '2026-11-20', endDate: '2026-11-20', time: '10:00', endTime: '10:00' }), '終了時刻は開始時刻より後にしてください。');
  assert.equal(schedule.eventEndTimeError({ date: '2026-11-20', endDate: '2026-11-21', time: '22:00', endTime: '07:00' }), '', '翌日以降に終わる予定は朝の時刻でもよい');
  assert.equal(schedule.eventEndTimeError({ date: '2026-11-20', endDate: '2026-11-20', time: '', endTime: '11:00' }), '終了時刻は開始時刻と一緒に入力してください。');
});
