// 予定（カレンダー）の日付計算をまとめたファイル。
// 画面表示や保存には触れない「計算だけ」を置き、app.js・enhancements.js・テストから共通で使う。
// 日付は 'YYYY-MM-DD' 形式の文字列（日付キー）で扱う。文字列のまま大小比較すると日付順になるため。

const EVENT_REPEAT_OPTIONS = [['none', '繰り返しなし'], ['daily', '毎日'], ['weekly', '毎週'], ['monthly', '毎月'], ['yearly', '毎年']];
// 繰り返す予定の1回分が、次の回と重ならずに続けられる最大日数（開始日を0日目と数える）。
const EVENT_REPEAT_MAX_SPAN = { none: Infinity, daily: 0, weekly: 6, monthly: 27, yearly: 364 };

// 日付キーをUTCのDateに変換する。UTCで計算すると、夏時間の切り替えで1日が23時間になる地域でもずれない。
// Date.UTC(1, 0, 1) は1901年と解釈されるため、setUTCFullYear で年を直接設定する。
function scheduleUtcDate(key) {
  const date = new Date(0);
  date.setUTCFullYear(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
  return date;
}

function scheduleKeyFromUtc(date) {
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) return '';
  return `${String(year).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

// days日後（マイナスなら前）の日付キー。0001年〜9999年の外に出る場合は '' を返す。
function scheduleAddDays(key, days) {
  const date = scheduleUtcDate(key);
  date.setUTCDate(date.getUTCDate() + days);
  return scheduleKeyFromUtc(date);
}

// from から to までの日数（同じ日なら0）。
function scheduleDayDiff(from, to) {
  return Math.round((scheduleUtcDate(to).getTime() - scheduleUtcDate(from).getTime()) / 86400000);
}

function scheduleIsKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && scheduleKeyFromUtc(scheduleUtcDate(value)) === value;
}

function eventRepeat(event) {
  return Object.prototype.hasOwnProperty.call(EVENT_REPEAT_MAX_SPAN, event.repeat) ? event.repeat : 'none';
}

// 1回分の最終日。終了日が無い・開始日より前のときは開始日と同じ（1日だけの予定）。
function eventEndKey(event) {
  return scheduleIsKey(event.endDate) && event.endDate >= event.date ? event.endDate : event.date;
}

// 1回分が何日続くか（1日だけなら0）。
function eventSpan(event) {
  return scheduleDayDiff(event.date, eventEndKey(event));
}

// key の日に、この予定の「回」が始まるかどうか。
function eventStartsOn(event, key) {
  if (!key || key < event.date) return false;
  const repeat = eventRepeat(event);
  if (repeat === 'none') return key === event.date;
  if (event.repeatUntil && key > event.repeatUntil) return false;
  if (Array.isArray(event.exceptions) && event.exceptions.includes(key)) return false;
  if (repeat === 'daily') return true;
  if (repeat === 'weekly') return scheduleDayDiff(event.date, key) % 7 === 0;
  // 毎月31日のように、その月に存在しない日の回は飛ばす（多くのカレンダーアプリと同じ扱い）。
  if (repeat === 'monthly') return key.slice(8) === event.date.slice(8);
  return key.slice(5) === event.date.slice(5);
}

// key の日に重なる回を { start, end } で返す。無ければ null。
function eventOccurrenceOn(event, key) {
  if (eventRepeat(event) === 'none') {
    return event.date <= key && key <= eventEndKey(event) ? { start: event.date, end: eventEndKey(event) } : null;
  }
  // 期間の予定は、数日前に始まった回が今日まで続いている場合もあるため、期間の日数分さかのぼって調べる。
  const span = eventSpan(event);
  for (let offset = 0; offset <= span; offset++) {
    const start = offset ? scheduleAddDays(key, -offset) : key;
    if (start && eventStartsOn(event, start)) return { start, end: scheduleAddDays(start, span) || '9999-12-31' };
  }
  return null;
}

// from〜to の範囲に1日でも重なる回を、開始日の順に返す。
function eventOccurrencesBetween(event, from, to) {
  if (eventRepeat(event) === 'none') {
    return event.date <= to && eventEndKey(event) >= from ? [{ start: event.date, end: eventEndKey(event) }] : [];
  }
  const span = eventSpan(event), result = [];
  let key = scheduleAddDays(from, -span) || '0001-01-01';
  if (key < event.date) key = event.date;
  for (; key && key <= to; key = scheduleAddDays(key, 1)) {
    if (eventStartsOn(event, key)) result.push({ start: key, end: scheduleAddDays(key, span) || '9999-12-31' });
  }
  return result;
}

// 回の中で key が何日目にあたるか（single: 1日だけ / start: 初日 / middle: 途中 / end: 最終日）。
function occurrencePhase(occurrence, key) {
  if (occurrence.start === occurrence.end) return 'single';
  return key === occurrence.start ? 'start' : key === occurrence.end ? 'end' : 'middle';
}

// 「毎週火曜（2027-03-31まで）」のような説明。繰り返さない予定は ''。
function eventRepeatLabel(event) {
  const repeat = eventRepeat(event);
  if (repeat === 'none') return '';
  const month = Number(event.date.slice(5, 7)), day = Number(event.date.slice(8, 10));
  const label = repeat === 'daily' ? '毎日' :
    repeat === 'weekly' ? `毎週${'日月火水木金土'[scheduleUtcDate(event.date).getUTCDay()]}曜` :
    repeat === 'monthly' ? `毎月${day}日` : `毎年${month}月${day}日`;
  return event.repeatUntil ? `${label}（${event.repeatUntil}まで）` : label;
}

// 繰り返しの種類に対して期間が長すぎる場合のメッセージ。問題なければ ''。
function eventRepeatSpanError(repeat, span) {
  const max = EVENT_REPEAT_MAX_SPAN[repeat];
  if (max === undefined || span <= max) return '';
  const name = EVENT_REPEAT_OPTIONS.find(([value]) => value === repeat)[1];
  return `${name}繰り返す予定は${max + 1}日以内にしてください。`;
}
