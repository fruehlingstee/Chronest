const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// schedule.js と insights.js を読み込み、画面に依存しない計算だけを確かめる。
function load() {
  const context = vm.createContext({});
  for (const file of ['schedule.js', 'insights.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
  return new Proxy({}, { get: (_, name) => vm.runInContext(name, context) });
}
// vm 内で作られた値を、こちら側の普通のオブジェクトに直して比べる。
const plain = value => JSON.parse(JSON.stringify(value));
const thursday = new Date(2026, 10, 19, 12, 0); // 2026-11-19（木）

test('時刻つきの文は予定、日付だけや「までに」はタスクとして解析する', () => {
  const insights = load();
  const parse = text => plain(insights.parseQuickInput(text, thursday));
  assert.deepEqual(parse('明日15時 会議'), { kind: 'event', title: '会議', date: '2026-11-20', endDate: '2026-11-20', time: '15:00', priority: 'medium' });
  assert.deepEqual(parse('金曜までにレポート'), { kind: 'task', title: 'レポート', date: '2026-11-20', endDate: '2026-11-20', time: '', priority: 'medium' });
  assert.equal(parse('10:30 歯医者').date, '2026-11-19', '日付が無い予定は今日');
  assert.equal(parse('午後3時半 打ち合わせ').time, '15:30');
  assert.equal(parse('牛乳を買う').kind, 'task');
  assert.equal(parse('牛乳を買う').date, '');
  assert.equal(parse('重要 申込書を出す').priority, 'high');
  assert.equal(parse('明日 9時 提出物 タスク').kind, 'task', '「タスク」と書けば時刻があってもタスク');
});

test('月日・曜日・来週・N日後・期間を解析し、過ぎた日付は次の年や月にする', () => {
  const insights = load();
  const parse = text => plain(insights.parseQuickInput(text, thursday));
  assert.equal(parse('11/25 10:00 面談').date, '2026-11-25');
  assert.equal(parse('1/5 初詣の予定').date, '2027-01-05');
  assert.equal(parse('2027年2月3日 旅行の予定').date, '2027-02-03');
  assert.equal(parse('木曜 ゴミ出し').date, '2026-11-19', '今日と同じ曜日は今日');
  assert.equal(parse('来週月曜 9時 朝礼').date, '2026-11-23');
  assert.equal(parse('3日後 返却').date, '2026-11-22');
  assert.equal(parse('5日 支払い').date, '2026-12-05', '過ぎた日は来月');
  const trip = parse('11/20〜11/23 旅行');
  assert.deepEqual([trip.kind, trip.date, trip.endDate, trip.title], ['event', '2026-11-20', '2026-11-23', '旅行']);
  const shortRange = parse('28日〜2日 帰省');
  assert.deepEqual([shortRange.date, shortRange.endDate], ['2026-11-28', '2026-12-02']);
});

test('「3時間」「3日間」は時刻や日付と見なさず、空のタイトルは受け付けない', () => {
  const insights = load();
  const study = plain(insights.parseQuickInput('3時間勉強する', thursday));
  assert.deepEqual([study.kind, study.time, study.title], ['task', '', '3時間勉強する']);
  assert.equal(plain(insights.parseQuickInput('3日間の研修', thursday)).date, '');
  assert.ok(insights.parseQuickInput('明日 15時', thursday).error);
  assert.ok(insights.parseQuickInput('   ', thursday).error);
  assert.equal(insights.describeQuickInput(insights.parseQuickInput('明日15時 会議', thursday)), '予定 · 11/20 15:00 · 会議');
  const wide = plain(insights.parseQuickInput('１１／２５　１０：３０　打ち合わせ（Ａ社）', thursday));
  assert.deepEqual([wide.date, wide.time, wide.title], ['2026-11-25', '10:30', '打ち合わせ（Ａ社）'], '全角の日時は読み取り、タイトルは書いたまま残す');
});

test('全体検索は種類ごとに、全角半角や大文字小文字を区別せずすべての語を含むものを返す', () => {
  const insights = load();
  const source = {
    tasks: [{ id: 1, title: 'レポート提出', note: '第3章', subtasks: [{ title: '参考文献' }] }, { id: 2, title: '買い物' }],
    events: [{ id: 'e', title: 'レポート発表会' }],
    notes: [{ id: 'n', body: 'ＡＢＣ社のレポート' }],
    bookmarks: [{ id: 'b', title: '資料', url: 'https://example.com/report', tags: ['レポート'] }]
  };
  const result = plain(insights.searchAll(source, 'レポート'));
  assert.deepEqual([result.tasks.length, result.events.length, result.notes.length, result.bookmarks.length, result.total], [1, 1, 1, 1, 4]);
  assert.equal(plain(insights.searchAll(source, 'abc')).notes.length, 1);
  assert.equal(plain(insights.searchAll(source, '参考文献')).tasks[0].id, 1, 'サブタスクも検索する');
  assert.equal(plain(insights.searchAll(source, 'レポート 第3章')).total, 1, 'すべての語を含むものだけ');
  assert.equal(plain(insights.searchAll(source, '  ')).total, 0);
});

test('集中時間の集計・連続日数・タスク達成率を計算する', () => {
  const insights = load();
  const sessions = [
    { date: '2026-11-19', minutes: 25 }, { date: '2026-11-18', minutes: 50 }, { date: '2026-11-18', minutes: 25 },
    { date: '2026-11-17', minutes: 5 }, { date: '2026-11-10', minutes: 100 }
  ];
  const focus = plain(insights.focusSummary(sessions, thursday));
  assert.deepEqual([focus.today, focus.week, focus.total, focus.streak], [25, 105, 205, 3]);
  assert.equal(focus.days.length, 7);
  assert.deepEqual(focus.days.at(-1), { date: '2026-11-19', minutes: 25 });
  assert.equal(plain(insights.focusSummary(sessions.slice(1), thursday)).streak, 2, '今日まだ記録が無ければ昨日から数える');
  const tasks = plain(insights.taskSummary([
    { done: true, completedOn: '2026-11-18' }, { done: true, completedOn: '2026-10-01' },
    { done: false, due: '2026-11-01' }, { done: false, due: '2026-12-01' }
  ], thursday));
  assert.deepEqual(tasks, { total: 4, done: 2, open: 2, overdue: 1, rate: 50, completedThisWeek: 1 });
  assert.equal(plain(insights.taskSummary([], thursday)).rate, 0);
});

test('ヒートマップは日曜始まりの週で並び、集中時間に応じた濃さと未来の日を示す', () => {
  const insights = load();
  const map = plain(insights.focusHeatmap([{ date: '2026-11-19', minutes: 120 }, { date: '2026-11-16', minutes: 30 }, { date: '2026-11-15', minutes: 10 }], thursday, 2));
  assert.equal(map.length, 2);
  assert.equal(map[0][0].date, '2026-11-08');
  assert.equal(map[1][0].date, '2026-11-15');
  assert.deepEqual(map[1].slice(0, 5).map(cell => cell.level), [1, 2, 0, 0, 4]);
  assert.deepEqual(map[1].map(cell => cell.future), [false, false, false, false, false, true, true]);
});

test('タイムラインの表示日と、時刻つき予定の配置・重なり・終日の段を計算する', () => {
  const insights = load();
  assert.deepEqual(plain(insights.timelineDays('week', '2026-11-19')), ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21']);
  assert.deepEqual(plain(insights.timelineDays('3day', '2026-11-30')), ['2026-11-30', '2026-12-01', '2026-12-02']);
  assert.deepEqual(plain(insights.timelineDays('day', '2026-11-19')), ['2026-11-19']);
  const events = [
    { id: 'a', title: '朝会', date: '2026-11-19', endDate: '2026-11-19', time: '09:00' },
    { id: 'b', title: '面談', date: '2026-11-19', endDate: '2026-11-19', time: '09:30' },
    { id: 'c', title: '昼', date: '2026-11-19', endDate: '2026-11-19', time: '12:00' },
    { id: 'd', title: '出張', date: '2026-11-18', endDate: '2026-11-20', time: '08:00' },
    { id: 'e', title: '終日', date: '2026-11-19', endDate: '2026-11-19', time: '' },
    { id: 'f', title: '毎週', date: '2026-11-12', endDate: '2026-11-12', time: '18:00', repeat: 'weekly', repeatUntil: '', exceptions: [] }
  ];
  const layout = plain(insights.timelineLayout(events, [{ id: 't', title: '期限', due: '2026-11-19', done: false }, { id: 'x', title: '完了済み', due: '2026-11-19', done: true }], '2026-11-19'));
  assert.deepEqual(layout.timed.map(item => [item.event.id, item.start, item.lane, item.lanes]), [['a', 540, 0, 2], ['b', 570, 1, 2], ['c', 720, 0, 1], ['f', 1080, 0, 1]]);
  assert.deepEqual(layout.allDay.map(item => [item.event.id, item.phase]), [['d', 'middle'], ['e', 'single']]);
  assert.deepEqual(layout.tasks.map(task => task.id), ['t']);
});
