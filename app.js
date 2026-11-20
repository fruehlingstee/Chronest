const store='dayflow-v2';
let storageWarning='', recoveryRecord=null;

function isDateKey(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T12:00:00');
  return Number.isFinite(date.getTime()) && date.getFullYear() === Number(value.slice(0, 4)) && date.getMonth() + 1 === Number(value.slice(5, 7)) && date.getDate() === Number(value.slice(8, 10));
}

// 日付計算は schedule.js（先に読み込む）の共通関数を使う。繰り返し予定の各回にも対応する。
function eventOccursOn(event, key) {
  return Boolean(eventOccurrenceOn(event, key));
}

function eventTimeLabel(event, key) {
  const occurrence = eventOccurrenceOn(event, key);
  if (!occurrence || occurrence.start === occurrence.end) return eventTimeRange(event);
  if (key === occurrence.start) return event.time ? `開始 ${event.time}` : '開始日';
  if (key === occurrence.end) return event.endTime ? `〜${event.endTime}` : '最終日';
  return '期間中';
}

function normalizeData(input, options = {}) {
  const strict = Boolean(options.strict);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(input)) throw new Error('バックアップの形式が正しくありません。');
  const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
  const date = value => isDateKey(value) ? value : '';
  const time = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : '';
  let idSequence = 0;
  const freshId = () => globalThis.crypto?.randomUUID?.() || `record-${Date.now().toString(36)}-${(++idSequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
  const id = value => (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && /^[\w.-]+$/.test(value)) ? value : freshId();
  const created = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : new Date().toISOString();
  const optionalString = (item, key) => item[key] === undefined || item[key] === null || typeof item[key] === 'string';
  function collection(key, required, valid, normalize) {
    const list = input[key];
    if (!Array.isArray(list)) {
      if (strict && (required || list !== undefined)) throw new Error(key + ' の形式が正しくありません。');
      return [];
    }
    const seen = new Set();
    return list.reduce((result, item) => {
      if (!object(item) || !valid(item)) {
        if (strict) throw new Error(key + ' に不正なデータがあります。');
        return result;
      }
      const normalized = normalize(item);
      if ('id' in normalized) {
        while (seen.has(String(normalized.id))) normalized.id = freshId();
        seen.add(String(normalized.id));
      }
      result.push(normalized);
      return result;
    }, []);
  }
  const titleValid = item => typeof item.title === 'string' && Boolean(item.title.trim());
  const optionalDateValid = (item, key) => item[key] === undefined || item[key] === '' || isDateKey(item[key]);
  const knownRepeat = value => Object.prototype.hasOwnProperty.call(EVENT_REPEAT_MAX_SPAN, value);
  // 繰り返し予定の項目を検証する。項目が無い旧データは「繰り返しなし」として通す。
  const eventRepeatValid = item => {
    if (item.repeat !== undefined && !knownRepeat(item.repeat)) return false;
    const end = isDateKey(item.endDate) && item.endDate >= item.date ? item.endDate : item.date;
    return !eventRepeatSpanError(item.repeat || 'none', scheduleDayDiff(item.date, end)) &&
      (item.repeatUntil === undefined || item.repeatUntil === '' || (isDateKey(item.repeatUntil) && item.repeatUntil >= item.date)) &&
      (item.exceptions === undefined || (Array.isArray(item.exceptions) && item.exceptions.every(isDateKey)));
  };
  // 通知は「何分前か」の整数。null（JSONで保存した「通知なし」）も受け付ける。
  const reminderValid = item => (item.reminder === undefined || item.reminder === null || item.reminder === '' || eventReminderMinutes(item) !== null) &&
    optionalDateValid(item, 'remindedStart');
  const normalizeSubtasks = items => {
    const seen = new Set();
    return (Array.isArray(items) ? items : []).filter(sub => object(sub) && titleValid(sub)).map(sub => {
      let subId = id(sub.id);
      while (seen.has(String(subId))) subId = freshId();
      seen.add(String(subId));
      return { id: subId, title: sub.title, done: Boolean(sub.done) };
    });
  };
  const bookmarkUrl = value => {
    try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.href : ''; } catch (_) { return ''; }
  };
  return {
    tasks: collection('tasks', true, item => titleValid(item) && (!strict || (
      optionalString(item, 'note') && optionalDateValid(item, 'due') && optionalDateValid(item, 'completedOn') && optionalDateValid(item, 'nextOccurrenceOn') &&
      (item.repeatAnchorDay === undefined || (Number.isInteger(item.repeatAnchorDay) && item.repeatAnchorDay >= 1 && item.repeatAnchorDay <= 31)) &&
      (item.repeatRetired === undefined || typeof item.repeatRetired === 'boolean') &&
      (item.subtasks === undefined || (Array.isArray(item.subtasks) && item.subtasks.every(sub => object(sub) && titleValid(sub)))) &&
      (item.reminderAt === undefined || item.reminderAt === '' || (typeof item.reminderAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(item.reminderAt) && isDateKey(item.reminderAt.slice(0, 10)) && Boolean(time(item.reminderAt.slice(11))))))) , item => ({
      id: id(item.id), title: item.title, priority: ['high','medium','low'].includes(item.priority) ? item.priority : 'medium',
      due: date(item.due), note: text(item.note), done: Boolean(item.done), created: created(item.created),
      repeat: ['daily','weekly','monthly'].includes(item.repeat) ? item.repeat : 'none',
      ...(Number.isInteger(item.repeatAnchorDay) && item.repeatAnchorDay >= 1 && item.repeatAnchorDay <= 31 ? { repeatAnchorDay: item.repeatAnchorDay } : {}),
      nextOccurrenceOn: date(item.nextOccurrenceOn), repeatRetired: Boolean(item.repeatRetired),
      ...(item.repeatParent !== undefined ? { repeatParent: id(item.repeatParent) } : {}),
      subtasks: normalizeSubtasks(item.subtasks),
      reminderAt: typeof item.reminderAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(item.reminderAt) && isDateKey(item.reminderAt.slice(0, 10)) && time(item.reminderAt.slice(11)) ? item.reminderAt : '',
      notified: Boolean(item.notified), completedOn: date(item.completedOn)
    })),
    events: collection('events', true, item => titleValid(item) && isDateKey(item.date) && (!strict || (
      (item.endDate === undefined || item.endDate === '' || (isDateKey(item.endDate) && item.endDate >= item.date)) &&
      (item.time === undefined || item.time === '' || Boolean(time(item.time))) &&
      (item.endTime === undefined || item.endTime === '' || (Boolean(time(item.endTime)) && !eventEndTimeError({ ...item, time: time(item.time), endDate: isDateKey(item.endDate) && item.endDate >= item.date ? item.endDate : item.date }))) &&
      eventRepeatValid(item) && reminderValid(item) &&
      (item.color === undefined || item.color === '' || Boolean(eventColorChoice(item.color))) &&
      optionalString(item, 'location') && optionalString(item, 'note')
    )), item => {
      const endDate = isDateKey(item.endDate) && item.endDate >= item.date ? item.endDate : item.date;
      let repeat = knownRepeat(item.repeat) ? item.repeat : 'none';
      // 次の回と重なるほど長い繰り返しは、復旧時は繰り返しを外して1回分の予定として残す。
      if (eventRepeatSpanError(repeat, scheduleDayDiff(item.date, endDate))) repeat = 'none';
      return {
        id: id(item.id), title: item.title, date: item.date, endDate, time: time(item.time),
        // 開始時刻が無い・開始より前の終了時刻は、復旧時は外す。
        endTime: time(item.endTime) && !eventEndTimeError({ date: item.date, endDate, time: time(item.time), endTime: time(item.endTime) }) ? time(item.endTime) : '',
        repeat,
        repeatUntil: repeat !== 'none' && isDateKey(item.repeatUntil) && item.repeatUntil >= item.date ? item.repeatUntil : '',
        exceptions: repeat !== 'none' && Array.isArray(item.exceptions) ? [...new Set(item.exceptions.filter(isDateKey))].sort() : [],
        reminder: eventReminderMinutes(item), remindedStart: date(item.remindedStart),
        color: eventColorChoice(item.color),
        location: text(item.location).slice(0, EVENT_LOCATION_MAX), note: text(item.note).slice(0, EVENT_NOTE_MAX)
      };
    }),
    notes: collection('notes', true, item => typeof item.body === 'string', item => ({ id: id(item.id), body: item.body, pinned: Boolean(item.pinned), created: created(item.created), ...(typeof item.updated === 'string' && Number.isFinite(Date.parse(item.updated)) ? { updated: item.updated } : {}) })),
    sessions: collection('sessions', false, item => isDateKey(item.date) && typeof item.minutes === 'number' && Number.isFinite(item.minutes) && item.minutes > 0 && (!strict || optionalString(item, 'task')), item => ({ date: item.date, minutes: item.minutes, task: text(item.task), taskId: (typeof item.taskId === 'number' && Number.isFinite(item.taskId)) || (typeof item.taskId === 'string' && /^[\w.-]+$/.test(item.taskId)) ? item.taskId : '' })),
    completions: collection('completions', false, item => isDateKey(item.date) && (!strict || optionalString(item, 'title')), item => ({
      taskId: (typeof item.taskId === 'number' && Number.isFinite(item.taskId)) || (typeof item.taskId === 'string' && /^[\w.-]+$/.test(item.taskId)) ? item.taskId : '',
      title: text(item.title), date: item.date
    })).slice(-5000),
    bookmarks: collection('bookmarks', false, item => typeof item.url === 'string' && Boolean(bookmarkUrl(item.url)) && (!strict || (optionalString(item, 'title') && (item.tags === undefined || (Array.isArray(item.tags) && item.tags.every(tag => typeof tag === 'string'))))), item => ({ id: id(item.id), title: text(item.title), url: bookmarkUrl(item.url), tags: (Array.isArray(item.tags) ? item.tags : []).filter(tag => typeof tag === 'string'), created: created(item.created) })),
    calculatorHistory: collection('calculatorHistory', false, item => typeof item.expression === 'string' && typeof item.result === 'string', item => ({ expression: item.expression, result: item.result })).slice(0, 10)
  };
}

function loadData() {
  let raw, parsed;
  try {
    raw = localStorage.getItem(store) || localStorage.getItem('dayflow-data');
    if (!raw) return normalizeData({});
    parsed = JSON.parse(raw);
    return normalizeData(parsed, { strict: true });
  } catch (_) {
    if (raw) recoveryRecord = { key: store + '-recovery-' + Date.now(), raw };
    storageWarning = '保存データを読み込めませんでした。元のデータは復旧用に保持します。バックアップからの復元も利用できます。';
    try { return normalizeData(parsed || {}); } catch (_) { return normalizeData({}); }
  }
}

let data=loadData();
let page='home',month=new Date(),filter='all',query='',timer=1500,interval=null;
const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function save() {
  try {
    if (recoveryRecord) {
      localStorage.setItem(recoveryRecord.key, recoveryRecord.raw);
      recoveryRecord = null;
    }
    localStorage.setItem(store, JSON.stringify(data));
    saveCount++;
    return true;
  } catch (_) {
    storageWarning = 'データを端末に保存できません。空き容量やブラウザの設定を確認し、バックアップを保存してください。';
    const notice = document.querySelector('#storageNotice');
    if (notice) { notice.hidden = false; notice.textContent = storageWarning; }
    return false;
  }
}
// 通知を表示する。Service Worker があればそちらで表示する（Androidでは new Notification が使えないため）。
function showAppNotification(body, tag = '') {
  const options = { body, tag, icon: 'icons/icon-192.png' };
  const fallback = () => {
    try { new Notification('Chronest', options); } catch (_) { /* 表示できなくても、通知済みの記録は続ける。 */ }
  };
  try {
    const worker = typeof navigator !== 'undefined' ? navigator.serviceWorker : null;
    if (worker && typeof worker.getRegistration === 'function') {
      worker.getRegistration().then(registration => registration ? registration.showNotification('Chronest', options) : fallback()).catch(fallback);
      return;
    }
  } catch (_) { /* Service Worker を確認できない環境では通常の通知を使う。 */ }
  fallback();
}
const dayKey=d=>`${String(d.getFullYear()).padStart(4,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`, jp=d=>new Intl.DateTimeFormat('ja-JP',{month:'long',day:'numeric',weekday:'short'}).format(d);
function shell(content){return `<div class="app"><header class="header"><div class="brand"><b>▸</b> Chronest</div><nav class="nav" aria-label="メインナビゲーション">${[['home','HOME'],['tasks','TASKS'],['calendar','CALENDAR'],['notes','NOTES'],['focus','FOCUS'],['stats','STATS'],['tools','TOOLS']].map(x=>`<button class="${page===x[0]?'active':''}" data-page="${x[0]}" ${page===x[0]?'aria-current="page"':''}>${x[1]}</button>`).join('')}</nav><div class="today">${jp(new Date())}</div></header><p id="storageNotice" role="status" ${storageWarning?'':'hidden'}>${esc(storageWarning)}</p>${content}</div>`}
// 統計ページは pages.js が上書きする。読み込めなかった場合はホームを表示する。
function stats(){return home()}
function render(){let c=page==='home'?home():page==='tasks'?tasks():page==='calendar'?calendar():page==='notes'?notes():page==='tools'?toolbox():page==='stats'?stats():focus();$('#app').innerHTML=shell(c);document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>{page=b.dataset.page;render()});bind()}
function home(){let open=data.tasks.filter(t=>!t.done), today=dayKey(new Date()), events=data.events.filter(e=>eventOccursOn(e,today));return `<main class="page"><div class="page-head"><div><p class="kicker">PERSONAL COMMAND CENTER</p><h1 class="sr-only">HOME</h1></div></div><section class="grid">${[['tasks','01','✓','タスク',open.length+' 件の未完了'],['calendar','02','▦','カレンダー',events.length?'今日の予定 '+events.length+' 件':'予定を追加'],['notes','03','✦','クイックメモ','思いつきを残す'],['focus','04','◷','集中','好きな時間でポモドーロ'],['tools','05','⌘','便利ツール','4つの道具をひとつに']].map(x=>`<button class="card" data-page="${x[0]}"><span class="n">${x[1]}</span><span class="ico">${x[2]}</span><strong>${x[3]}</strong><span>${x[4]}</span></button>`).join('')}</section><section class="two-col" style="margin-top:14px"><div class="panel"><h3>NEXT TASK</h3>${open.slice(0,4).map(t=>`<div class="quick">${esc(t.title)}${t.due?` <span class="tag">· ${t.due}</span>`:''}</div>`).join('')||'<div class="empty">次のタスクはありません</div>'}</div><div class="panel"><h3>TODAY</h3>${events.map(e=>`<div class="quick">${esc(eventTimeLabel(e,today))} · ${esc(e.title)}</div>`).join('')||'<div class="empty">予定はありません</div>'}</div></section></main>`}
function tasks(){const total=data.tasks.length,done=data.tasks.filter(t=>t.done).length,over=data.tasks.filter(t=>!t.done&&t.due&&t.due<dayKey(new Date())).length;return `<main class="page"><div class="page-head"><div><p class="kicker">01 / TASKS</p><h1 class="title">タスク</h1></div></div><section class="stats"><div class="stat"><b>${total}</b><span>合計</span></div><div class="stat"><b>${total-done}</b><span>未完了</span></div><div class="stat"><b>${done}</b><span>完了</span></div><div class="stat"><b style="color:${over?'var(--red)':'var(--text)'}">${over}</b><span>期限超過</span></div></section><form class="toolbar" id="addTask"><input class="input" id="taskName" required maxlength="120" placeholder="新しいタスクを入力…"><select class="select" id="taskPriority"><option value="high">● 高</option><option value="medium" selected>● 中</option><option value="low">● 低</option></select><input class="select" id="taskDue" type="date"><button class="button">追加</button></form><div class="toolbar"><input class="input" id="search" value="${esc(query)}" placeholder="⌕ タスク・メモを検索"><select class="select" id="sort"><option value="created">追加順</option><option value="due">期限日順</option><option value="priority">優先度順</option><option value="name">名前順</option></select></div><div class="filters">${[['all','すべて'],['open','未完了'],['done','完了済み'],['overdue','期限超過']].map(x=>`<button class="filter ${filter===x[0]?'active':''}" data-filter="${x[0]}">${x[1]}</button>`).join('')}</div><section class="panel" style="border-top:0;border-radius:0 0 6px 6px" id="taskList"></section></main>`}
function getTasks(){let a=data.tasks.filter(t=>(filter==='all'||filter==='open'&&!t.done||filter==='done'&&t.done||filter==='overdue'&&!t.done&&t.due&&t.due<dayKey(new Date()))&&((t.title+t.note).toLowerCase().includes(query.toLowerCase())));let s=$('#sort')?.value||'created', rank={high:0,medium:1,low:2};return a.sort((a,b)=>s==='name'?a.title.localeCompare(b.title,'ja'):s==='priority'?rank[a.priority]-rank[b.priority]:s==='due'?(a.due||'9999').localeCompare(b.due||'9999'):new Date(b.created)-new Date(a.created))}
function drawTasks(){let a=getTasks();$('#taskList').innerHTML=a.length?a.map(t=>`<article class="task ${t.done?'done':''}"><input class="check" type="checkbox" data-toggle="${t.id}" ${t.done?'checked':''} aria-label="完了"><div><div class="task-title">${esc(t.title)}</div><div class="meta"><span class="tag">● ${t.priority==='high'?'高':t.priority==='medium'?'中':'低'}</span>${t.due?`<span>${t.due}${!t.done&&t.due<dayKey(new Date())?' · 期限超過':''}</span>`:''}${t.note?`<span>▹ メモあり</span>`:''}</div></div><div class="task-actions"><button data-edit="${t.id}">編集</button></div></article>`).join(''):'<div class="empty">条件に一致するタスクはありません</div>';document.querySelectorAll('[data-toggle]').forEach(x=>x.onchange=()=>{let t=data.tasks.find(t=>t.id==x.dataset.toggle);t.done=x.checked;save();render()});document.querySelectorAll('[data-edit]').forEach(x=>x.onclick=()=>editTask(x.dataset.edit))}
function calendar(){let y=month.getFullYear(),m=month.getMonth(),first=new Date(y,m,1),start=first.getDay(),max=new Date(y,m+1,0).getDate(),cells=['日','月','火','水','木','金','土'].map(d=>`<div class="dayname">${d}</div>`);for(let i=0;i<start;i++)cells.push('<div class="day"></div>');for(let d=1;d<=max;d++){let k=`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;cells.push(`<div class="day ${k===dayKey(new Date())?'today':''}"><b>${d}</b>${data.events.filter(e=>eventOccursOn(e,k)).map(e=>`<div class="event" title="${esc(e.title)}">${esc(eventTimeLabel(e,k))} ${esc(e.title)}</div>`).join('')}</div>`)}return `<main class="page"><div class="page-head"><div><p class="kicker">02 / CALENDAR</p><h1 class="title">${y}年 ${m+1}月</h1></div><div><button class="ghost" data-prev>← 前月</button><button class="ghost" data-next>次月 →</button></div></div><form class="toolbar" id="addEvent"><input class="select" id="eventDate" type="date" value="${dayKey(new Date())}" required><input class="select" id="eventTime" type="time"><input class="input" id="eventTitle" required placeholder="予定のタイトル"><button class="button">予定を追加</button></form><section class="panel" style="padding:0;overflow:auto"><div class="calendar">${cells.join('')}</div></section><section class="panel" style="margin-top:14px"><h3>予定を管理</h3>${data.events.sort((a,b)=>a.date.localeCompare(b.date)).map(e=>`<div class="quick">${e.date} ${e.time||'終日'} · ${esc(e.title)} <button class="ghost" data-event-delete="${e.id}">削除</button></div>`).join('')||'<div class="empty">予定はまだありません</div>'}</section></main>`}
// ---- 元に戻す ----
// 完了・削除などの直前にデータの写しを取り、操作後に「元に戻す」を数秒間表示する。
// 写しを取った後に別の変更が保存されていたら（集中の記録など）、その変更を消さないよう戻さない。
let saveCount = 0, undoState = null, undoTimer = null;
const UNDO_SECONDS = 8;
function snapshotData() { return JSON.stringify(data); }
function offerUndo(message, snapshot) {
  undoState = { message, snapshot, saveCount };
  showUndoToast();
}
function showUndoToast() {
  const root = $('#toastRoot');
  if (!root) return;
  if (typeof clearTimeout === 'function') clearTimeout(undoTimer);
  if (!undoState) { root.innerHTML = ''; return; }
  root.innerHTML = `<div class="toast" role="status"><span>${esc(undoState.message)}</span><button class="button dim" id="undoButton" type="button">元に戻す</button></div>`;
  const button = $('#undoButton');
  if (button) button.onclick = undoLastAction;
  if (typeof setTimeout === 'function') undoTimer = setTimeout(() => { undoState = null; showUndoToast(); }, UNDO_SECONDS * 1000);
}
function undoLastAction() {
  const state = undoState;
  undoState = null;
  if (state && state.saveCount === saveCount) {
    data = normalizeData(JSON.parse(state.snapshot));
    save();
    render();
  }
  showUndoToast();
}

// ---- メモ ----
let noteFilter = '';
function notesListMarkup() {
  const words = noteFilter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = [...data.notes.filter(note => note.pinned), ...data.notes.filter(note => !note.pinned)]
    .filter(note => words.every(word => note.body.toLowerCase().includes(word)));
  if (!list.length) return `<div class="empty">${data.notes.length ? '一致するメモはありません' : 'メモはまだありません'}</div>`;
  return list.map(note => `<article class="note ${note.pinned ? 'pinned' : ''}">${esc(note.body)}<small>${note.pinned ? '★ PINNED · ' : ''}${new Date(note.created).toLocaleDateString('ja-JP')}${note.updated ? ' · 編集済み' : ''} <button class="ghost" data-note-edit="${esc(note.id)}">編集</button> <button class="ghost" data-pin="${esc(note.id)}">${note.pinned ? 'ピン解除' : 'ピン留め'}</button> <button class="ghost" data-note-delete="${esc(note.id)}">削除</button></small></article>`).join('');
}
function notes() {
  return `<main class="page"><div class="page-head"><div><p class="kicker">03 / QUICK NOTES</p><h1 class="title">メモ</h1></div></div>
    <section class="panel"><textarea id="noteBody" rows="5" aria-label="新しいメモ" placeholder="いま考えていること…"></textarea><div class="toolbar" style="margin-bottom:0"><button class="button" id="saveNote">メモを保存</button><span class="subtitle">ピン留めしたメモは先頭に表示されます。</span></div></section>
    <div class="toolbar notes-filter"><input class="input" id="noteFilter" type="search" autocomplete="off" aria-label="メモを絞り込む" placeholder="⌕ メモを絞り込む" value="${esc(noteFilter)}"></div>
    <section class="notes" id="notesList">${notesListMarkup()}</section></main>`;
}
const findNote = id => data.notes.find(note => String(note.id) === String(id));
function editNote(id) {
  const note = findNote(id);
  if (!note) return;
  modal(`<h2>メモを編集</h2><form id="noteEditForm"><label for="editNoteBody">内容</label><textarea id="editNoteBody" rows="8">${esc(note.body)}</textarea>
    <div class="modal-actions"><button class="button dim" type="button" id="cancelNoteEdit">キャンセル</button><button class="button" type="submit">保存</button></div></form>`);
  const body = $('#editNoteBody');
  $('#cancelNoteEdit').onclick = closeModal;
  body.oninput = () => body.setCustomValidity && body.setCustomValidity('');
  $('#noteEditForm').onsubmit = event => {
    event.preventDefault();
    const value = body.value.trim();
    if (!value) {
      if (body.setCustomValidity) { body.setCustomValidity('メモの内容を入力してください。'); body.reportValidity(); }
      return;
    }
    if (value !== note.body) { note.body = value; note.updated = new Date().toISOString(); save(); }
    closeModal(); render();
  };
}
function bindNoteList() {
  document.querySelectorAll('[data-note-edit]').forEach(button => button.onclick = () => editNote(button.dataset.noteEdit));
  document.querySelectorAll('[data-pin]').forEach(button => button.onclick = () => {
    const note = findNote(button.dataset.pin);
    if (!note) return;
    note.pinned = !note.pinned; save(); render();
  });
  // 「元に戻す」で取り消せるので、メモの削除は確認画面を挟まずにすぐ行う。
  document.querySelectorAll('[data-note-delete]').forEach(button => button.onclick = () => {
    const snapshot = snapshotData();
    data.notes = data.notes.filter(note => String(note.id) !== button.dataset.noteDelete);
    save(); render();
    offerUndo('メモを削除しました。', snapshot);
  });
}
function bindNotes() {
  $('#saveNote').onclick = () => {
    const body = $('#noteBody').value.trim();
    if (!body) return;
    data.notes.unshift({ id: globalThis.crypto?.randomUUID?.() || `note-${Date.now()}`, body, pinned: false, created: new Date().toISOString() });
    save(); render();
  };
  const filterInput = $('#noteFilter');
  if (filterInput) filterInput.oninput = () => {
    noteFilter = filterInput.value;
    const list = $('#notesList');
    if (list) { list.innerHTML = notesListMarkup(); bindNoteList(); }
  };
  bindNoteList();
}
// 集中する時間（分）は自由に入力できる。前回の分数を覚えておき、次に開いたときもその時間から始める。
const FOCUS_MINUTES_KEY='dayflow-focus-minutes', FOCUS_MIN_MINUTES=1, FOCUS_MAX_MINUTES=180, FOCUS_DEFAULT_MINUTES=25;
// 入力された値を 1〜180 の整数（分）にそろえる。数字として読めなければ null を返す。
function normalizeFocusMinutes(value) {
  if (value === null || String(value).trim() === '') return null;
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes)) return null;
  return Math.min(FOCUS_MAX_MINUTES, Math.max(FOCUS_MIN_MINUTES, minutes));
}
function loadFocusMinutes() {
  try { return normalizeFocusMinutes(localStorage.getItem(FOCUS_MINUTES_KEY)) || FOCUS_DEFAULT_MINUTES; }
  catch (_) { return FOCUS_DEFAULT_MINUTES; }
}
let focusDuration=loadFocusMinutes()*60, focusTaskName='', focusEndAt=0, focusTaskId='', focusFinishedTaskId='';
timer=focusDuration;
const focusTask=id=>id===''?null:data.tasks.find(task=>String(task.id)===String(id))||null;
// タスク一覧やダッシュボードの「集中」ボタンから、そのタスクを選んだ状態で集中画面を開く。
function startFocusTask(id) {
  const task=focusTask(id);
  if (!task) return;
  if (interval===null) { focusTaskId=task.id; focusTaskName=task.title; focusFinishedTaskId=''; }
  page='focus';
  render();
}
const formatTimer=seconds=>`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
function focus() {
  if (interval !== null) timer = Math.max(0, Math.ceil((focusEndAt - Date.now()) / 1000));
  return `<main class="page"><section class="panel focus"><h1 class="sr-only">集中</h1>
    <div class="toolbar focus-task-picker" style="justify-content:center"><select class="select" id="focusTaskSelect" aria-label="集中するタスク" ${interval!==null?'disabled':''}><option value="">タスクを選ばずに集中</option>${data.tasks.filter(task=>!task.done||String(task.id)===String(focusTaskId)).map(task=>`<option value="${esc(task.id)}" ${String(task.id)===String(focusTaskId)?'selected':''}>${esc(task.title)}</option>`).join('')}</select><input class="input" style="max-width:340px" id="focusTask" maxlength="120" aria-label="集中する作業" value="${esc(focusTaskName)}" placeholder="何に集中しますか？"></div>
    ${focusTask(focusTaskId)?`<p class="focus-linked">このタスクの集中 合計 ${focusMinutesByTask(data.sessions).get(String(focusTaskId))||0}分</p>`:''}
    ${focusTask(focusFinishedTaskId)&&!focusTask(focusFinishedTaskId).done?`<div class="focus-finished" role="status"><span>お疲れさまでした。「${esc(focusTask(focusFinishedTaskId).title)}」は終わりましたか？</span><button class="button" id="focusCompleteTask">タスクを完了にする</button></div>`:''}
    <div class="timer" id="timer" role="timer" aria-label="残り時間">${formatTimer(timer)}</div>
    <div class="toolbar" style="justify-content:center"><label class="focus-minutes"><span>集中する時間</span><input class="input" type="number" id="focusMinutes" min="${FOCUS_MIN_MINUTES}" max="${FOCUS_MAX_MINUTES}" step="1" inputmode="numeric" value="${focusDuration/60}" ${interval!==null?'disabled':''}><span>分</span></label>
    <button class="button" id="timerStart">${interval!==null?'一時停止':timer>0&&timer<focusDuration?'再開':'開始'}</button><button class="button dim" id="timerReset">リセット</button></div>
    <div class="sessions"><h3>今日の集中記録</h3>${data.sessions.filter(session=>session.date===dayKey(new Date())).map(session=>`<div class="session">✓ ${session.minutes}分 · ${esc(session.task||'名称なし')}${focusTask(session.taskId)?' <span class="tag">タスク</span>':''}</div>`).join('')||'<div class="empty">まだ集中セッションはありません</div>'}</div>
  </section></main>`;
}
function updateFocusTimer() {
  if (interval === null) return;
  timer = Math.max(0, Math.ceil((focusEndAt - Date.now()) / 1000));
  const display = $('#timer');
  if (display) display.textContent = formatTimer(timer);
  if (timer > 0) return;
  clearInterval(interval);
  interval = null;
  data.sessions.unshift({date:dayKey(new Date(focusEndAt)),minutes:focusDuration/60,task:focusTaskName.trim(),taskId:focusTask(focusTaskId)?focusTaskId:''});
  focusFinishedTaskId=focusTask(focusTaskId)?focusTaskId:'';
  save();
  try {
    if ('Notification' in window && Notification.permission === 'granted') showAppNotification('集中セッションが完了しました。', 'focus');
  } catch (_) { /* 通知を表示できなくても集中記録は保存する。 */ }
  if (page === 'focus') render();
}
// 集中する時間を変える。計測中は変えない（入力欄も無効にしている）。一時停止中に変えた場合は新しい時間で最初から。
function setFocusMinutes(minutes) {
  if (interval !== null) return;
  focusDuration=minutes*60; timer=focusDuration; focusEndAt=0;
  try { localStorage.setItem(FOCUS_MINUTES_KEY, String(minutes)); } catch (_) { /* 保存できなくても今回の集中にはこの時間を使う。 */ }
  const display=$('#timer');
  if (display) display.textContent=formatTimer(timer);
  const startButton=$('#timerStart');
  if (startButton) startButton.textContent='開始';
}
function bindFocus() {
  $('#focusTask').oninput=event=>{
    focusTaskName=event.target.value;
    // タスク名と違う内容を書いたら、タスクとの連携を外す。
    if (focusTask(focusTaskId) && focusTaskName.trim()!==focusTask(focusTaskId).title) { focusTaskId=''; const select=$('#focusTaskSelect'); if (select) select.value=''; }
  };
  const taskSelect=$('#focusTaskSelect');
  if (taskSelect) taskSelect.onchange=()=>{ const task=focusTask(taskSelect.value); focusTaskId=task?task.id:''; focusTaskName=task?task.title:''; focusFinishedTaskId=''; render(); };
  const completeButton=$('#focusCompleteTask');
  if (completeButton) completeButton.onclick=()=>{
    const task=focusTask(focusFinishedTaskId);
    if (task) {
      const snapshot=snapshotData();
      // 繰り返しタスクの次回予約などはタスク画面と同じ処理に任せる。
      if (globalThis.dayflowTasks) globalThis.dayflowTasks.setCompleted(task,true); else { task.done=true; }
      save();
      focusFinishedTaskId=''; render();
      offerUndo(`「${task.title}」を完了にしました。`, snapshot);
      return;
    }
    focusFinishedTaskId=''; render();
  };
  const minutesInput=$('#focusMinutes');
  if (minutesInput) {
    // 入力のたびに画面を作り直すと入力欄からカーソルが外れるので、タイマーとボタンの表示だけを書き換える。
    minutesInput.oninput=()=>{
      const minutes=Number(minutesInput.value);
      // 入力途中（空欄・範囲外・小数）のあいだは前の時間のままにし、入力欄から離れたときにそろえる。
      if (Number.isInteger(minutes) && minutes>=FOCUS_MIN_MINUTES && minutes<=FOCUS_MAX_MINUTES) setFocusMinutes(minutes);
    };
    minutesInput.onchange=()=>{
      const minutes=normalizeFocusMinutes(minutesInput.value) || focusDuration/60;
      minutesInput.value=String(minutes);
      setFocusMinutes(minutes);
    };
  }
  $('#timerReset').onclick=()=>{clearInterval(interval);interval=null;timer=focusDuration;focusEndAt=0;render();};
  $('#timerStart').onclick=()=>{
    if (interval !== null) {
      updateFocusTimer();
      clearInterval(interval); interval=null; render();
      return;
    }
    if (timer <= 0) timer=focusDuration;
    focusEndAt=Date.now()+timer*1000;
    interval=setInterval(updateFocusTimer,250);
    render();
  };
}
let modalReturnFocus=null;
function modal(html) {
  const root=$('#modal-root');
  if (!root.firstElementChild) modalReturnFocus=document.activeElement;
  root.innerHTML=`<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true" tabindex="-1">${html}</div></div>`;
  const dialog=root.querySelector('.modal');
  const heading=dialog.querySelector('h2');
  if (heading) {heading.id='dialogTitle';dialog.setAttribute('aria-labelledby','dialogTitle');}
  root.querySelector('.modal-bg').onclick=event=>{if(event.target===event.currentTarget)closeModal();};
  const focusable=()=>Array.from(dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')).filter(element=>!element.hidden);
  root.onkeydown=event=>{
    if(event.key==='Escape'){event.preventDefault();closeModal();return;}
    if(event.key!=='Tab')return;
    const items=focusable(), first=items[0]||dialog, last=items[items.length-1]||dialog;
    if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog)){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===dialog)){event.preventDefault();first.focus();}
  };
  (focusable()[0]||dialog).focus();
}
function closeModal() {
  const root=$('#modal-root');root.innerHTML='';root.onkeydown=null;
  if(modalReturnFocus&&modalReturnFocus.isConnected)modalReturnFocus.focus();
  modalReturnFocus=null;
}
function editTask(id){let t=data.tasks.find(x=>x.id==id);modal(`<h2>タスクを編集</h2><label>タスク名</label><input class="input" id="editTitle" value="${esc(t.title)}"><label>優先度</label><select class="select" id="editPriority"><option value="high" ${t.priority==='high'?'selected':''}>高</option><option value="medium" ${t.priority==='medium'?'selected':''}>中</option><option value="low" ${t.priority==='low'?'selected':''}>低</option></select><label>期限日</label><input class="input" id="editDue" type="date" value="${t.due}"><label>メモ</label><textarea id="editNote" rows="4">${esc(t.note)}</textarea><div class="modal-actions"><button class="button dim" id="cancel">キャンセル</button><button class="button" id="saveEdit">保存</button></div><div class="danger-zone"><p>削除は確認画面へ進みます。ワンタップでは消えません。</p><button class="button danger" id="askDelete">このタスクを削除…</button></div>`);$('#cancel').onclick=closeModal;$('#saveEdit').onclick=()=>{t.title=$('#editTitle').value.trim()||t.title;t.priority=$('#editPriority').value;t.due=$('#editDue').value;t.note=$('#editNote').value;save();closeModal();render()};$('#askDelete').onclick=()=>confirmDelete('タスクを完全に削除しますか？',()=>{data.tasks=data.tasks.filter(x=>x.id!=id);save();closeModal();render()})}
function confirmDelete(msg,yes){modal(`<h2>削除の確認</h2><p class="subtitle">${msg}</p><div class="modal-actions"><button class="button dim" id="no">キャンセル</button><button class="button danger" id="yes">削除する</button></div>`);$('#no').onclick=closeModal;$('#yes').onclick=yes}
function bind(){if(page==='tasks'){$('#addTask').onsubmit=e=>{e.preventDefault();let title=$('#taskName').value.trim();if(!title)return;data.tasks.unshift({id:Date.now(),title,priority:$('#taskPriority').value,due:$('#taskDue').value,note:'',done:false,created:new Date().toISOString()});save();render()};$('#search').oninput=e=>{query=e.target.value;drawTasks()};$('#sort').onchange=drawTasks;document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;render()});drawTasks()}if(page==='calendar'){document.querySelector('[data-prev]').onclick=()=>{month.setMonth(month.getMonth()-1);render()};document.querySelector('[data-next]').onclick=()=>{month.setMonth(month.getMonth()+1);render()};$('#addEvent').onsubmit=e=>{e.preventDefault();data.events.push({id:Date.now(),date:$('#eventDate').value,time:$('#eventTime').value,title:$('#eventTitle').value});save();render()};document.querySelectorAll('[data-event-delete]').forEach(b=>b.onclick=()=>confirmDelete('この予定を削除しますか？',()=>{data.events=data.events.filter(e=>e.id!=b.dataset.eventDelete);save();closeModal();render()}))}if(page==='notes')bindNotes();if(page==='focus')bindFocus();}
render();
