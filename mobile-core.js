(function mobileCore() {
  'use strict';
  const pad = number => String(number).padStart(2, '0');
  function dateKey(date) {
    return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
  function validDate(y, m, d) {
    if (!(y >= 100 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
    const value = new Date(y, m - 1, d, 12);
    return value.getFullYear() === y && value.getMonth() + 1 === m && value.getDate() === d ? dateKey(value) : '';
  }
  function addDays(key, offset) {
    const date = new Date(`${key}T12:00:00`);
    if (Number.isNaN(date.getTime())) return '';
    date.setDate(date.getDate() + offset);
    return date.getFullYear() >= 100 && date.getFullYear() <= 9999 ? dateKey(date) : '';
  }
  function parseQuickText(input, now = new Date()) {
    const raw = String(input ?? '').trim();
    let title = raw, date = '', time = '';
    const base = dateKey(now);
    const explicit = title.match(/\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}\/\d{1,2}/);
    if (explicit) {
      const parts = explicit[0].split(/[/-]/).map(Number);
      if (parts.length === 3) {
        date = validDate(parts[0], parts[1], parts[2]);
      } else {
        date = validDate(now.getFullYear(), parts[0], parts[1]);
        if (date && date < base) date = validDate(now.getFullYear() + 1, parts[0], parts[1]);
      }
      if (date) title = title.replace(explicit[0], ' ');
    }
    if (!date) {
      const relative = title.match(/明後日|あさって|明日|今日|本日/);
      if (relative) {
        const steps = /明後日|あさって/.test(relative[0]) ? 2 : relative[0] === '明日' ? 1 : 0;
        date = addDays(base, steps);
        title = title.replace(relative[0], ' ');
      }
    }
    const clock = title.match(/(午前|午後)?([01]?\d|2[0-3])(?::([0-5]\d)|時(半|[0-5]?\d分?)?)/);
    if (clock) {
      let hour = Number(clock[2]);
      const minute = clock[3] !== undefined ? Number(clock[3]) : clock[4] === '半' ? 30 : clock[4] ? Number(clock[4].replace('分', '')) : 0;
      if ((!clock[1] || hour <= 12) && hour < 24 && minute < 60) {
        if (clock[1] === '午後' && hour < 12) hour += 12;
        if (clock[1] === '午前' && hour === 12) hour = 0;
        time = `${pad(hour)}:${pad(minute)}`;
        title = title.replace(clock[0], ' ');
      }
    }
    // 時刻のみ指定されたタスク/予定は「今日」を基準にする。
    if (!date && time) date = base;
    title = title.replace(/^[\s、,:：にでの]+/, '').replace(/[\s、]+$/, '').replace(/\s{2,}/g, ' ').trim();
    return { title, date, time };
  }
  function dailyMetrics(data, endKey, count) {
    const days = Array.from({ length: count }, (_, i) => {
      const date = addDays(endKey, i - count + 1);
      return { date, completed: 0, minutes: 0 };
    });
    const byDate = new Map(days.map(day => [day.date, day]));
    (data.activity || []).forEach(item => {
      const row = byDate.get(item.date);
      if (row) row.completed += 1;
    });
    (data.sessions || []).forEach(item => {
      const row = byDate.get(item.date);
      if (row) row.minutes += item.minutes;
    });
    return days;
  }
  function streak(days) {
    let index = days.length - 1, count = 0;
    if (index >= 0 && days[index].completed === 0 && days[index].minutes === 0) index--;
    for (; index >= 0; index--) {
      if (!days[index].completed && !days[index].minutes) break;
      count++;
    }
    return count;
  }
  const api = { dateKey, addDays, validDate, parseQuickText, dailyMetrics, streak };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalThis.DayflowMobileCore = api;
})();
