// ダッシュボード（ホーム）・タイムライン表示・統計ページの画面。
// 計算は insights.js / schedule.js に任せ、ここでは表示と操作だけを扱う。
// 既存の画面関数（home・calendar・bind）を包む形で機能を足すため、最後に読み込む。
(function () {
  const todayKey = () => dayKey(new Date());
  const shortDate = key => `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`;
  const weekdayName = key => '日月火水木金土'[scheduleUtcDate(key).getUTCDay()];
  const newId = prefix => globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  // 表示の好み（タイムラインの表示形式）は端末ごとの小さな設定として保存する。保存できなくても動く。
  const readPreference = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; } };
  const writePreference = (key, value) => { try { localStorage.setItem(key, value); } catch (_) { /* 保存できなくても表示は切り替える。 */ } };

  let quickText = '', quickNotice = '', searchQuery = '';
  let calendarView = TIMELINE_VIEWS.some(([value]) => value === readPreference('dayflow-calendar-view', 'month')) ? readPreference('dayflow-calendar-view', 'month') : 'month';

  function openCalendarDay(key) {
    page = 'calendar';
    if (globalThis.dayflowCalendar) globalThis.dayflowCalendar.select(key); else render();
  }

  // ---- ダッシュボード ----
  function todayTasks(today) {
    const rank = { high: 0, medium: 1, low: 2 };
    // 期限切れ・今日が期限 → 優先度 → 期限の近い順 に並べ、上位を表示する。
    return data.tasks.filter(task => !task.done).sort((a, b) => {
      const urgentA = a.due && a.due <= today ? 0 : 1, urgentB = b.due && b.due <= today ? 0 : 1;
      return urgentA - urgentB || (rank[a.priority] ?? 1) - (rank[b.priority] ?? 1) || (a.due || '9999').localeCompare(b.due || '9999');
    });
  }

  function searchResultsMarkup() {
    if (!searchQuery.trim()) return '';
    const result = searchAll(data, searchQuery);
    if (!result.total) return '<div class="empty">一致するものはありません</div>';
    const group = (label, items, row) => items.length ? `<div class="search-group"><h4>${label} <span>${items.length}</span></h4>${items.map(row).join('')}</div>` : '';
    return group('タスク', result.tasks, task => `<button type="button" class="search-row" data-search-task="${esc(task.id)}"><span class="${task.done ? 'struck' : ''}">${esc(task.title)}</span><small>${task.done ? '完了' : task.due ? '期限 ' + esc(task.due) : '期限なし'}</small></button>`) +
      group('予定', result.events, event => `<button type="button" class="search-row" data-search-event="${esc(event.date)}"><span><span class="event-swatch event-color-${eventColor(event, { start: event.date, end: eventEndKey(event) })}" aria-hidden="true"></span>${esc(event.title)}</span><small>${esc(event.date)}${eventRepeat(event) !== 'none' ? ' · ↻ ' + esc(eventRepeatLabel(event)) : ''}</small></button>`) +
      group('メモ', result.notes, note => `<button type="button" class="search-row" data-search-note="${esc(note.id)}"><span>${esc(note.body.slice(0, 80))}</span><small>メモ</small></button>`) +
      group('ブックマーク', result.bookmarks, mark => `<a class="search-row" href="${esc(mark.url)}" target="_blank" rel="noopener noreferrer"><span>${esc(mark.title || mark.url)}</span><small>${esc(mark.url)}</small></a>`);
  }

  home = function () {
    const now = new Date(), today = todayKey();
    const focus = focusSummary(data.sessions, now);
    const tasksInfo = taskSummary(data.tasks, now);
    const openTasks = todayTasks(today);
    const events = data.events.map(event => ({ event, occurrence: eventOccurrenceOn(event, today) })).filter(item => item.occurrence)
      .sort((a, b) => a.occurrence.start.localeCompare(b.occurrence.start) || (a.event.time || '').localeCompare(b.event.time || '') || a.event.title.localeCompare(b.event.title, 'ja'));
    const todaySessions = data.sessions.filter(session => session.date === today);
    const preview = quickText.trim() ? describeQuickInput(parseQuickInput(quickText, now)) : '例: 「明日15時 会議」「金曜までにレポート」「11/20〜11/23 旅行」';
    const dueLabel = task => !task.due ? '' : task.due < today ? `<span class="red">期限切れ ${esc(shortDate(task.due))}</span>` : task.due === today ? '<span class="due-today">今日まで</span>' : `<span>期限 ${esc(shortDate(task.due))}</span>`;
    return `<main class="page dashboard">
      <div class="page-head dashboard-head"><div><p class="kicker">TODAY</p><h1 class="title">${esc(jp(now))}</h1></div></div>
      <section class="panel quick-panel">
        <form class="quick-add" id="quickAddForm"><input class="input" id="quickAddInput" maxlength="200" autocomplete="off" aria-label="タスクや予定を文章で追加" aria-describedby="quickAddPreview" placeholder="タスクや予定を文章で追加" value="${esc(quickText)}"><button class="button" type="submit">追加</button></form>
        <p class="quick-preview" id="quickAddPreview" aria-live="polite">${esc(preview)}</p>
        <p class="task-notice" id="quickAddNotice" role="status" ${quickNotice ? '' : 'hidden'}>${esc(quickNotice)}</p>
        <div class="global-search"><input class="input" id="globalSearch" type="search" autocomplete="off" aria-label="タスク・予定・メモ・ブックマークを検索" placeholder="⌕ タスク・予定・メモ・ブックマークを検索" value="${esc(searchQuery)}"><div id="globalSearchResults" class="search-results" aria-live="polite">${searchResultsMarkup()}</div></div>
      </section>
      <section class="stats dashboard-stats">
        <div class="stat"><b>${tasksInfo.open}</b><span>未完了タスク${tasksInfo.overdue ? ` · <em class="red">期限切れ ${tasksInfo.overdue}</em>` : ''}</span></div>
        <div class="stat"><b>${events.length}</b><span>今日の予定</span></div>
        <div class="stat"><b>${focus.today}<small>分</small></b><span>今日の集中</span></div>
        <div class="stat"><b>${focus.streak}<small>日</small></b><span>連続で集中</span></div>
      </section>
      <section class="dashboard-grid">
        <div class="panel"><h3>やること</h3>
          ${openTasks.slice(0, 6).map(task => `<div class="dash-row"><input class="check" type="checkbox" data-dash-toggle="${esc(task.id)}" aria-label="${esc(task.title)}を完了にする"><span class="dash-copy"><span class="dash-title">${esc(task.title)}</span><small class="meta">${dueLabel(task)}${task.priority === 'high' ? '<span>優先度 高</span>' : ''}</small></span><button type="button" class="ghost" data-focus-task="${esc(task.id)}" aria-label="${esc(task.title)}に集中する">集中</button></div>`).join('') || '<div class="empty">未完了のタスクはありません</div>'}
          ${openTasks.length > 6 ? `<button type="button" class="ghost dash-more" data-page="tasks">ほか${openTasks.length - 6}件をタスク画面で見る</button>` : ''}
        </div>
        <div class="panel"><h3>今日の予定</h3>
          ${events.map(({ event, occurrence }) => `<button type="button" class="dash-row dash-event" data-dash-event="${esc(today)}"><time>${esc(eventTimeLabel(event, today))}</time><span class="dash-copy"><span class="dash-title"><span class="event-swatch event-color-${eventColor(event, occurrence)}" aria-hidden="true"></span>${esc(event.title)}</span>${eventRepeat(event) !== 'none' ? `<small class="meta">↻ ${esc(eventRepeatLabel(event))}</small>` : ''}</span></button>`).join('') || '<div class="empty">今日の予定はありません</div>'}
        </div>
        <div class="panel"><h3>集中</h3>
          <p class="dash-focus-total"><b>${focus.today}</b>分 <span>· ${todaySessions.length}回 · 7日間 ${focus.week}分</span></p>
          ${todaySessions.slice(0, 4).map(session => `<div class="session">✓ ${session.minutes}分 · ${esc(session.task || '名称なし')}</div>`).join('') || '<div class="empty">今日はまだ集中していません</div>'}
          <button type="button" class="button dash-focus-start" data-page="focus">集中を始める</button>
        </div>
      </section>
    </main>`;
  };

  function drawSearchResults() {
    const box = document.querySelector('#globalSearchResults');
    if (!box) return;
    box.innerHTML = searchResultsMarkup();
    bindSearchResults();
  }

  function bindSearchResults() {
    document.querySelectorAll('[data-search-task]').forEach(button => button.onclick = () => editTask(button.dataset.searchTask));
    document.querySelectorAll('[data-search-event]').forEach(button => button.onclick = () => openCalendarDay(button.dataset.searchEvent));
    document.querySelectorAll('[data-search-note]').forEach(button => button.onclick = () => { page = 'notes'; render(); });
  }

  // 文章を解析し、予定またはタスクとして登録する。登録できたら true。
  function addFromQuickText(text) {
    const result = parseQuickInput(text, new Date());
    if (result.error) { quickNotice = result.error; return false; }
    if (result.kind === 'event') {
      data.events.push({ id: newId('event'), title: result.title, date: result.date, endDate: result.endDate, time: result.time, repeat: 'none', repeatUntil: '', exceptions: [], reminder: null, remindedStart: '', color: '' });
      quickNotice = `予定「${result.title}」を${shortDate(result.date)}${result.endDate !== result.date ? '〜' + shortDate(result.endDate) : ''}に追加しました。`;
    } else {
      data.tasks.unshift({
        id: newId('task'), title: result.title, priority: result.priority, due: result.date, note: '', done: false,
        created: new Date().toISOString(), repeat: 'none', subtasks: [],
        reminderAt: result.date && result.time ? `${result.date}T${result.time}` : '', notified: false, completedOn: ''
      });
      quickNotice = `タスク「${result.title}」を追加しました。`;
    }
    save();
    return true;
  }

  function bindDashboard() {
    const form = document.querySelector('#quickAddForm');
    const input = document.querySelector('#quickAddInput');
    if (!form || !input) return;
    input.oninput = () => {
      quickText = input.value;
      const preview = document.querySelector('#quickAddPreview');
      if (preview) preview.textContent = quickText.trim() ? describeQuickInput(parseQuickInput(quickText, new Date())) : '';
    };
    form.onsubmit = event => {
      event.preventDefault();
      quickText = input.value;
      const snapshot = snapshotData();
      const added = addFromQuickText(quickText);
      // 追加できたときは、完了の知らせを「元に戻す」と一緒に下のお知らせで出す（解析が意図と違えばすぐ取り消せる）。
      const message = quickNotice;
      if (added) { quickText = ''; quickNotice = ''; }
      render();
      if (added) offerUndo(message, snapshot);
      document.querySelector('#quickAddInput')?.focus();
    };
    const search = document.querySelector('#globalSearch');
    if (search) search.oninput = () => { searchQuery = search.value; drawSearchResults(); };
    bindSearchResults();
    document.querySelectorAll('[data-dash-toggle]').forEach(box => box.onchange = () => {
      const task = data.tasks.find(item => String(item.id) === box.dataset.dashToggle);
      if (!task) return;
      const snapshot = snapshotData();
      if (globalThis.dayflowTasks) globalThis.dayflowTasks.setCompleted(task, box.checked); else task.done = box.checked;
      quickNotice = '';
      save(); render();
      offerUndo(`「${task.title}」を完了にしました。`, snapshot);
    });
    document.querySelectorAll('[data-focus-task]').forEach(button => button.onclick = () => startFocusTask(button.dataset.focusTask));
    document.querySelectorAll('[data-dash-event]').forEach(button => button.onclick = () => openCalendarDay(button.dataset.dashEvent));
  }

  // ---- タイムライン（1日・3日・週） ----
  const HOUR_HEIGHT = 44;

  function timelineMarkup() {
    const today = todayKey();
    const selected = globalThis.dayflowCalendar ? globalThis.dayflowCalendar.selectedDay() : today;
    const days = timelineDays(calendarView, selected);
    const step = calendarView === 'week' ? 7 : calendarView === '3day' ? 3 : 1;
    const prev = scheduleAddDays(selected, -step), next = scheduleAddDays(selected, step);
    const layouts = days.map(key => ({ key, ...timelineLayout(data.events, data.tasks, key) }));
    const label = days.length === 1 ? `${days[0]}（${weekdayName(days[0])}）` : `${days[0]} 〜 ${days[days.length - 1]}`;
    const phaseLabel = { single: '', start: '開始', middle: '期間中', end: '終了' };
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    return `<section class="panel timeline-panel" aria-label="${esc(label)}のタイムライン" style="--days:${days.length};--hour:${HOUR_HEIGHT}px">
      <div class="timeline-nav">${prev ? `<button type="button" class="ghost" data-calendar-select="${prev}" aria-label="前の期間">←</button>` : '<span></span>'}<strong>${esc(label)}</strong>${next ? `<button type="button" class="ghost" data-calendar-select="${next}" aria-label="次の期間">→</button>` : '<span></span>'}</div>
      <div class="timeline-head"><span></span>${days.map(key => `<button type="button" class="timeline-day ${key === today ? 'is-today' : ''} ${key === selected ? 'is-selected' : ''}" data-calendar-select="${key}" aria-label="${key}を選ぶ"><small>${weekdayName(key)}</small>${Number(key.slice(8, 10))}</button>`).join('')}</div>
      <div class="timeline-allday"><span class="timeline-label">終日</span>${layouts.map(day => `<div class="timeline-allday-cell">${day.allDay.map(({ event, occurrence, phase }) => `<button type="button" class="timeline-chip event-color-${eventColor(event, occurrence)}" data-event-edit="${esc(event.id)}" data-event-date="${esc(occurrence.start)}" title="${esc(event.title)}">${phase === 'single' ? '' : `<span class="event-phase">${phaseLabel[phase]}</span>`}${esc(event.title)}</button>`).join('')}${day.tasks.map(task => `<button type="button" class="timeline-chip task-chip" data-calendar-task="${esc(task.id)}" title="期限 ${esc(task.title)}">期限 ${esc(task.title)}</button>`).join('')}</div>`).join('')}</div>
      <div class="timeline-scroll" id="timelineScroll">
        <div class="timeline-grid">
          <div class="timeline-hours" aria-hidden="true">${Array.from({ length: 24 }, (_, hour) => `<span style="top:${hour * HOUR_HEIGHT}px">${hour}:00</span>`).join('')}</div>
          ${layouts.map(day => `<div class="timeline-column ${day.key === today ? 'is-today' : ''}" aria-label="${day.key}の時刻つき予定">
            ${day.timed.map(item => `<button type="button" class="timeline-event event-color-${eventColor(item.event, item.occurrence)}" data-event-edit="${esc(item.event.id)}" data-event-date="${esc(item.occurrence.start)}" style="top:${item.start / 60 * HOUR_HEIGHT}px;left:calc(${item.lane} * 100% / ${item.lanes});width:calc(100% / ${item.lanes})" title="${esc(item.event.time)} ${esc(item.event.title)}"><time>${esc(item.event.time)}</time> ${esc(item.event.title)}</button>`).join('')}
            ${day.key === today ? `<span class="timeline-now" style="top:${nowMinutes / 60 * HOUR_HEIGHT}px" aria-hidden="true"></span>` : ''}
          </div>`).join('')}
        </div>
      </div>
      <p class="timeline-hint">時刻つきの予定は1時間の枠で表示します。予定を押すと編集できます。</p>
    </section>`;
  }

  const baseCalendar = calendar;
  calendar = function () {
    const html = baseCalendar();
    const toggle = `<div class="calendar-views filters" role="group" aria-label="カレンダーの表示">${TIMELINE_VIEWS.map(([value, label]) => `<button type="button" class="filter ${calendarView === value ? 'active' : ''}" data-calendar-view="${value}" aria-pressed="${calendarView === value}">${label}</button>`).join('')}</div>`;
    const start = html.indexOf('<section class="panel calendar-panel"');
    if (start < 0) return html;
    const end = html.indexOf('</section>', start) + '</section>'.length;
    // 月表示はそのまま、それ以外は月のマス目の代わりにタイムラインを表示する。
    return html.slice(0, start) + toggle + (calendarView === 'month' ? html.slice(start, end) : timelineMarkup()) + html.slice(end);
  };

  // ---- 統計 ----
  stats = function () {
    const now = new Date();
    const focus = focusSummary(data.sessions, now);
    const tasksInfo = taskSummary(data.tasks, now);
    const heatmap = focusHeatmap(data.sessions, now, 12);
    const maxDay = Math.max(30, ...focus.days.map(day => day.minutes));
    const byTask = [...focusMinutesByTask(data.sessions)].map(([id, minutes]) => ({ task: data.tasks.find(task => String(task.id) === id), minutes }))
      .filter(item => item.task).sort((a, b) => b.minutes - a.minutes).slice(0, 5);
    const activeDays = heatmap.flat().filter(cell => cell.minutes > 0).length;
    return `<main class="page stats-page">
      <div class="page-head"><h1 class="title">統計</h1></div>
      <section class="stats">
        <div class="stat"><b>${focus.today}<small>分</small></b><span>今日の集中</span></div>
        <div class="stat"><b>${focus.week}<small>分</small></b><span>直近7日間の集中</span></div>
        <div class="stat"><b>${focus.streak}<small>日</small></b><span>連続で集中</span></div>
        <div class="stat"><b>${tasksInfo.rate}<small>%</small></b><span>タスク達成率（${tasksInfo.done}/${tasksInfo.total}）</span></div>
      </section>
      <section class="stats-grid">
        <div class="panel"><h3>直近7日間の集中</h3>
          <div class="focus-bars" role="img" aria-label="直近7日間の集中時間: ${focus.days.map(day => `${shortDate(day.date)} ${day.minutes}分`).join('、')}">
            ${focus.days.map(day => `<div class="focus-bar"><span class="focus-bar-value">${day.minutes || ''}</span><span class="focus-bar-fill" style="height:${Math.round(day.minutes / maxDay * 100)}%"></span><small>${weekdayName(day.date)}</small></div>`).join('')}
          </div>
        </div>
        <div class="panel"><h3>タスク</h3>
          <div class="task-meter" role="img" aria-label="達成率 ${tasksInfo.rate}%"><span style="width:${tasksInfo.rate}%"></span></div>
          <dl class="stats-list"><div><dt>完了</dt><dd>${tasksInfo.done}</dd></div><div><dt>未完了</dt><dd>${tasksInfo.open}</dd></div><div><dt>期限切れ</dt><dd class="${tasksInfo.overdue ? 'red' : ''}">${tasksInfo.overdue}</dd></div><div><dt>今週完了</dt><dd>${tasksInfo.completedThisWeek}</dd></div></dl>
        </div>
      </section>
      <section class="panel heatmap-panel"><h3>集中ヒートマップ <small>直近12週間 · ${activeDays}日 · 合計${focus.total}分</small></h3>
        <div class="heatmap" role="img" aria-label="直近12週間のうち${activeDays}日に集中しました">
          <div class="heatmap-days" aria-hidden="true">${'日月火水木金土'.split('').map(day => `<span>${day}</span>`).join('')}</div>
          ${heatmap.map(week => `<div class="heatmap-week">${week.map(cell => `<span class="heat heat-${cell.future ? 'future' : cell.level}" title="${cell.date} · ${cell.minutes}分"></span>`).join('')}</div>`).join('')}
        </div>
        <div class="heatmap-legend" aria-hidden="true">少ない ${[0, 1, 2, 3, 4].map(level => `<span class="heat heat-${level}"></span>`).join('')} 多い</div>
      </section>
      <section class="panel"><h3>集中したタスク</h3>
        ${byTask.map(({ task, minutes }) => `<div class="dash-row"><span class="dash-copy"><span class="dash-title ${task.done ? 'struck' : ''}">${esc(task.title)}</span></span><b class="stats-minutes">${minutes}分</b></div>`).join('') || '<div class="empty">タスクを選んで集中すると、ここにタスクごとの時間が表示されます</div>'}
      </section>
    </main>`;
  };

  // ---- 操作の登録 ----
  const baseBind = bind;
  bind = function () {
    baseBind();
    if (page === 'home') bindDashboard();
    if (page === 'calendar') {
      document.querySelectorAll('[data-calendar-view]').forEach(button => button.onclick = () => {
        calendarView = button.dataset.calendarView;
        writePreference('dayflow-calendar-view', calendarView);
        render();
        document.querySelector(`[data-calendar-view="${calendarView}"]`)?.focus();
      });
      // タイムラインは、最初の予定（無ければ朝7時）の少し前が見える位置から表示する。
      const scroller = document.querySelector('#timelineScroll');
      if (scroller) {
        const selected = globalThis.dayflowCalendar ? globalThis.dayflowCalendar.selectedDay() : todayKey();
        const starts = timelineDays(calendarView, selected).flatMap(key => timelineLayout(data.events, [], key).timed.map(item => item.start));
        scroller.scrollTop = Math.max(0, (starts.length ? Math.min(...starts) : 7 * 60) / 60 - 1) * HOUR_HEIGHT;
      }
    }
  };

  render();
})();
