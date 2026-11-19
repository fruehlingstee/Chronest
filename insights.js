// ダッシュボード・クイック追加・検索・統計・タイムラインで使う「計算だけ」をまとめたファイル。
// 画面には触れないので、tests/insights.test.cjs で単体テストできる。schedule.js の後に読み込む。

// ---- クイック追加（自然文の解析） ----
// 例: 「明日15時 会議」→予定 / 「金曜までにレポート」→タスク / 「11/20〜11/23 旅行」→期間の予定
const QUICK_WEEKDAYS = '日月火水木金土';

function quickKey(date) {
  return scheduleLocalKey(date);
}

function quickDate(year, month, day) {
  const key = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return scheduleIsKey(key) ? key : '';
}

// 文章から最初に現れる日付表現を探す。anchored が true のときは先頭だけを調べる（期間の終わり用）。
function quickFindDate(text, now, anchored, after = '') {
  const today = quickKey(now);
  const year = now.getFullYear(), month = now.getMonth() + 1;
  const weekday = now.getDay();
  const patterns = [
    [/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/, m => quickDate(+m[1], +m[2], +m[3])],
    [/(\d{1,2})[/月](\d{1,2})日?/, m => {
      // 年を書かない日付は、今日より前なら来年とみなす（期間の終わりは開始日より前なら来年）。
      const key = quickDate(year, +m[1], +m[2]);
      return key && key < (after || today) ? quickDate(year + 1, +m[1], +m[2]) : key;
    }],
    [/(今日|きょう|明日|あした|あす|明後日|あさって)/, m => scheduleAddDays(today, /今日|きょう/.test(m[1]) ? 0 : /明後日|あさって/.test(m[1]) ? 2 : 1)],
    [/(\d+)日後/, m => scheduleAddDays(today, +m[1])],
    [/(再来週|来週|今週)?の?([日月火水木金土])曜日?/, m => {
      const target = QUICK_WEEKDAYS.indexOf(m[2]);
      if (!m[1]) return scheduleAddDays(today, (target - weekday + 7) % 7); // 今日以降で最初のその曜日
      const weekStart = scheduleAddDays(today, -weekday + (m[1] === '来週' ? 7 : m[1] === '再来週' ? 14 : 0));
      return scheduleAddDays(weekStart, target);
    }],
    [/(\d{1,2})日(?![後間])/, m => {
      // 日だけの指定は今月、過ぎていれば来月（期間の終わりは開始日の月から数える）。
      const base = after ? scheduleUtcDate(after) : null;
      const y = base ? base.getUTCFullYear() : year, mo = base ? base.getUTCMonth() + 1 : month;
      const key = quickDate(y, mo, +m[1]);
      if (key && key >= (after || today)) return key;
      return mo === 12 ? quickDate(y + 1, 1, +m[1]) : quickDate(y, mo + 1, +m[1]);
    }]
  ];
  let best = null;
  for (const [pattern, convert] of patterns) {
    const regex = anchored ? new RegExp('^' + pattern.source) : pattern;
    const match = text.match(regex);
    if (!match) continue;
    const key = convert(match);
    if (!key) continue;
    if (!best || match.index < best.index || (match.index === best.index && match[0].length > best.length)) best = { key, index: match.index, length: match[0].length };
  }
  return best;
}

function quickFindTime(text) {
  const match = text.match(/(午前|午後|朝|夜|AM|PM)?\s*(\d{1,2})(?::(\d{2})|時(?!間)(?:(\d{1,2})分|(半))?)/i);
  if (!match) return null;
  let hour = +match[2];
  const minute = match[3] !== undefined ? +match[3] : match[4] !== undefined ? +match[4] : match[5] ? 30 : 0;
  if (/午後|夜|PM/i.test(match[1] || '') && hour < 12) hour += 12;
  if (/午前|AM/i.test(match[1] || '') && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, index: match.index, length: match[0].length };
}

function quickCut(text, index, length) {
  return text.slice(0, index) + ' ' + text.slice(index + length);
}

// 解析結果: { kind: 'task' | 'event', title, date, endDate, time, priority } または { error }
function parseQuickInput(input, now) {
  // 日時の読み取りに使う全角の数字と記号（：／－～！）だけを半角にする。タイトルの全角括弧などは書いたまま残す。
  let text = String(input || '').replace(/[０-９：／－～！]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xFEE0)).trim();
  if (!text) return { error: '内容を入力してください。' };
  let kind = '';
  // 種類を表す言葉。「までに」「締切」はタスク、「予定」は予定。
  if (/(タスク|TODO|やること|までに|締め?切り?|〆切)/i.test(text)) kind = 'task';
  if (/予定/.test(text)) kind = kind || 'event';
  text = text.replace(/(タスク|TODO|やること|(?<=\S)の予定|予定:?)/gi, ' ').replace(/(締め?切り?|〆切)/g, ' ');
  let priority = 'medium';
  if (/(重要|至急|!{1,})/.test(text)) { priority = 'high'; text = text.replace(/(重要|至急|!+)/g, ' '); }

  let date = '', endDate = '';
  const first = quickFindDate(text, now, false);
  if (first) {
    date = first.key;
    let rest = text.slice(first.index + first.length);
    const separator = rest.match(/^\s*(〜|~|から|-|ー|－)\s*/);
    if (separator) {
      const second = quickFindDate(rest.slice(separator[0].length), now, true, date);
      if (second && second.key >= date) {
        endDate = second.key;
        rest = rest.slice(separator[0].length + second.index + second.length);
        text = text.slice(0, first.index) + ' ' + rest;
      } else text = quickCut(text, first.index, first.length);
    } else text = quickCut(text, first.index, first.length);
  }
  const time = quickFindTime(text);
  let endTime = '';
  if (time) {
    // 「15時〜16時半」「10:00-11:30」のような時間帯なら、終わりの時刻も読み取る。
    const after = text.slice(time.index + time.length);
    const separator = after.match(/^\s*(〜|~|から|-|ー|－)\s*/);
    const second = separator ? quickFindTime(after.slice(separator[0].length)) : null;
    if (second && second.index === 0) {
      endTime = second.time;
      text = text.slice(0, time.index) + ' ' + after.slice(separator[0].length + second.length);
    } else text = quickCut(text, time.index, time.length);
  }

  if (!kind) kind = time || endDate ? 'event' : 'task';
  if (kind === 'event' && !date) date = quickKey(now);
  const title = text.replace(/(までに|まで)/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(に|は|の|で|、|,)\s*/, '').replace(/\s*(に|は|の|で|、|,)$/, '').trim();
  if (!title) return { error: 'タイトルを入力してください。' };
  const startTime = time ? time.time : '';
  // 同じ日の予定で終わりが始まり以前なら、終了時刻は使わない。
  if (endTime && (!endDate || endDate === date) && endTime <= startTime) endTime = '';
  return { kind, title: title.slice(0, 120), date, endDate: endDate || date, time: startTime, endTime, priority };
}

// 解析結果を「予定 · 11/20 15:00 · 会議」のような短い説明にする。
function describeQuickInput(result) {
  if (result.error) return result.error;
  const day = key => key ? `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}` : '';
  const when = result.kind === 'event'
    ? [result.endDate !== result.date ? `${day(result.date)}〜${day(result.endDate)}` : day(result.date), result.time ? (result.endTime ? `${result.time}–${result.endTime}` : result.time) : '終日'].join(' ')
    : [result.date ? `期限 ${day(result.date)}` : '期限なし', result.time ? `通知 ${result.time}` : '', result.priority === 'high' ? '優先度 高' : ''].filter(Boolean).join(' ');
  return `${result.kind === 'event' ? '予定' : 'タスク'} · ${when} · ${result.title}`;
}

// ---- 全体検索 ----
function searchNormalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase();
}

// 空白で区切った語をすべて含むものを探す（AND検索）。各種類20件まで。
function searchAll(source, query, limit = 20) {
  const words = searchNormalize(query).split(/\s+/).filter(Boolean);
  const empty = { tasks: [], events: [], notes: [], bookmarks: [], total: 0 };
  if (!words.length) return empty;
  const hit = text => { const target = searchNormalize(text); return words.every(word => target.includes(word)); };
  const result = {
    tasks: (source.tasks || []).filter(task => hit([task.title, task.note, ...(task.subtasks || []).map(sub => sub.title)].join(' '))).slice(0, limit),
    events: (source.events || []).filter(event => hit(event.title)).slice(0, limit),
    notes: (source.notes || []).filter(note => hit(note.body)).slice(0, limit),
    bookmarks: (source.bookmarks || []).filter(mark => hit([mark.title, mark.url, ...(mark.tags || [])].join(' '))).slice(0, limit)
  };
  result.total = result.tasks.length + result.events.length + result.notes.length + result.bookmarks.length;
  return result;
}

// ---- 統計 ----
function focusMinutesByDay(sessions) {
  const totals = new Map();
  for (const session of sessions || []) totals.set(session.date, (totals.get(session.date) || 0) + session.minutes);
  return totals;
}

function focusSummary(sessions, now) {
  const totals = focusMinutesByDay(sessions);
  const today = quickKey(now);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = scheduleAddDays(today, index - 6);
    return { date, minutes: totals.get(date) || 0 };
  });
  // 連続日数: 今日まだ記録が無ければ昨日から数える（今日の途中で0日にならないように）。
  let streak = 0;
  let cursor = totals.get(today) ? today : scheduleAddDays(today, -1);
  while (cursor && totals.get(cursor)) { streak++; cursor = scheduleAddDays(cursor, -1); }
  return {
    today: totals.get(today) || 0,
    week: days.reduce((sum, day) => sum + day.minutes, 0),
    total: [...totals.values()].reduce((sum, minutes) => sum + minutes, 0),
    days, streak
  };
}

function taskSummary(tasks, now, completions = []) {
  const today = quickKey(now), weekStart = scheduleAddDays(today, -6);
  const list = tasks || [];
  const done = list.filter(task => task.done).length;
  // 完了の履歴があればそれで数える（繰り返しタスクの完了も含められる）。無い旧データは今の完了状態で数える。
  const completedThisWeek = completions.length
    ? completions.filter(entry => entry.date >= weekStart && entry.date <= today).length
    : list.filter(task => task.done && task.completedOn && task.completedOn >= weekStart && task.completedOn <= today).length;
  return {
    total: list.length, done, open: list.length - done,
    overdue: list.filter(task => !task.done && task.due && task.due < today).length,
    rate: list.length ? Math.round(done / list.length * 100) : 0,
    completedThisWeek
  };
}

// 完了の履歴から、直近7日間の日ごとの完了数・連続日数・直近30日でよく完了したタスクを求める。
function completionSummary(completions, now) {
  const today = quickKey(now);
  const counts = new Map();
  for (const entry of completions || []) counts.set(entry.date, (counts.get(entry.date) || 0) + 1);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = scheduleAddDays(today, index - 6);
    return { date, count: counts.get(date) || 0 };
  });
  let streak = 0;
  let cursor = counts.get(today) ? today : scheduleAddDays(today, -1);
  while (cursor && counts.get(cursor)) { streak++; cursor = scheduleAddDays(cursor, -1); }
  const monthStart = scheduleAddDays(today, -29);
  const byTask = new Map();
  for (const entry of completions || []) {
    if (entry.date < monthStart || entry.date > today) continue;
    const key = entry.taskId !== '' ? 'id:' + entry.taskId : 'title:' + entry.title;
    const item = byTask.get(key) || { taskId: entry.taskId, title: entry.title, count: 0, last: '' };
    item.count++;
    if (entry.date >= item.last) { item.last = entry.date; item.title = entry.title; }
    byTask.set(key, item);
  }
  return {
    today: counts.get(today) || 0,
    week: days.reduce((sum, day) => sum + day.count, 0),
    days, streak,
    topTasks: [...byTask.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last)).slice(0, 5)
  };
}

// 直近 weeks 週ぶんの集中時間を、日曜始まりの週ごとの列にする。level は色の濃さ（0〜4）。
function focusHeatmap(sessions, now, weeks = 12) {
  const totals = focusMinutesByDay(sessions);
  const today = quickKey(now);
  const firstSunday = scheduleAddDays(today, -now.getDay() - (weeks - 1) * 7);
  const level = minutes => minutes <= 0 ? 0 : minutes < 25 ? 1 : minutes < 50 ? 2 : minutes < 100 ? 3 : 4;
  return Array.from({ length: weeks }, (_, week) => Array.from({ length: 7 }, (_, day) => {
    const date = scheduleAddDays(firstSunday, week * 7 + day);
    const minutes = totals.get(date) || 0;
    return { date, minutes, level: level(minutes), future: date > today };
  }));
}

// タスクごとの集中時間（タスクと連携した記録だけ）。
function focusMinutesByTask(sessions) {
  const totals = new Map();
  for (const session of sessions || []) {
    if (session.taskId === undefined || session.taskId === '') continue;
    totals.set(String(session.taskId), (totals.get(String(session.taskId)) || 0) + session.minutes);
  }
  return totals;
}

// ---- タイムライン ----
const TIMELINE_VIEWS = [['month', '月'], ['week', '週'], ['3day', '3日'], ['day', '1日']];

function timelineDays(view, selected) {
  if (view === 'day') return [selected];
  if (view === '3day') return [0, 1, 2].map(offset => scheduleAddDays(selected, offset)).filter(Boolean);
  const sunday = scheduleAddDays(selected, -scheduleUtcDate(selected).getUTCDay()) || selected;
  return Array.from({ length: 7 }, (_, offset) => scheduleAddDays(sunday, offset)).filter(Boolean);
}

// 1日分の並べ方。時刻のある回は時間軸に置き、終日・期間の途中・タスクの期限は上の段に並べる。
// 終了時刻の無い予定は1時間の枠で描く。期間の予定は初日を開始〜24時、最終日を0時〜終了時刻で描く。重なる予定は横に並べる。
function timelineLayout(events, tasks, key) {
  const allDay = [], timed = [];
  for (const event of events || []) {
    const occurrence = eventOccurrenceOn(event, key);
    if (!occurrence) continue;
    const phase = occurrencePhase(occurrence, key);
    const startMinutes = event.time ? scheduleMinutes(event.time) : 0;
    if (event.time && phase === 'single') {
      timed.push({ event, occurrence, phase, start: startMinutes, end: event.endTime ? scheduleMinutes(event.endTime) : Math.min(startMinutes + 60, 24 * 60) });
    } else if (event.time && phase === 'start') {
      timed.push({ event, occurrence, phase, start: startMinutes, end: 24 * 60 });
    } else if (event.endTime && phase === 'end') {
      timed.push({ event, occurrence, phase, start: 0, end: scheduleMinutes(event.endTime) });
    } else allDay.push({ event, occurrence, phase });
  }
  timed.sort((a, b) => a.start - b.start || a.event.title.localeCompare(b.event.title, 'ja'));
  const laneEnds = [];
  for (const item of timed) {
    let lane = laneEnds.findIndex(end => end <= item.start);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = Math.max(item.end, item.start + 15);
    item.lane = lane;
  }
  // 重なっている塊ごとに列数をそろえる（重ならない予定は全幅で表示する）。
  const overlaps = (a, b) => a.start < Math.max(b.end, b.start + 15) && b.start < Math.max(a.end, a.start + 15);
  for (const item of timed) item.lanes = Math.max(...timed.filter(other => overlaps(item, other)).map(other => other.lane)) + 1;
  allDay.sort((a, b) => a.occurrence.start.localeCompare(b.occurrence.start) || a.event.title.localeCompare(b.event.title, 'ja'));
  const due = (tasks || []).filter(task => !task.done && task.due === key);
  return { allDay, timed, tasks: due };
}
