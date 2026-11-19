(function () {
  const oldBind = bind;
  const todayKey = () => dayKey(new Date());
  const repeatLabel = { none: '', daily: '毎日', weekly: '毎週', monthly: '毎月' };
  let taskSort = 'created';
  let taskDraft = { title: '', priority: 'medium', due: '', repeat: 'none' };
  let taskNotice = '';

  function rememberTaskDraft() {
    taskDraft = {
      title: document.querySelector('#taskInput').value,
      priority: document.querySelector('#taskPriority').value,
      due: document.querySelector('#taskDue').value,
      repeat: document.querySelector('#taskRepeat').value
    };
  }

  data.tasks = data.tasks.map(task => ({
    ...task,
    repeat: task.repeat || 'none',
    subtasks: Array.isArray(task.subtasks) ? task.subtasks : [],
    reminderAt: task.reminderAt || '',
    notified: Boolean(task.notified),
    completedOn: task.completedOn || ''
  }));
  save();

  let taskIdSequence = 0;
  const issuedTaskIds = new Set();

  function newTaskId() {
    const occupied = new Set(data.tasks.flatMap(task => [String(task.id), ...task.subtasks.map(subtask => String(subtask.id))]));
    let id = globalThis.crypto?.randomUUID?.();
    if (!id || occupied.has(String(id)) || issuedTaskIds.has(String(id))) {
      do { id = `task-${Date.now().toString(36)}-${(++taskIdSequence).toString(36)}-${Math.random().toString(36).slice(2)}`; }
      while (occupied.has(id) || issuedTaskIds.has(id));
    }
    issuedTaskIds.add(String(id));
    return id;
  }

  function repeatAnchorDay(task) {
    let current = task, anchor = null;
    const visited = new Set();
    while (current && !visited.has(String(current.id))) {
      visited.add(String(current.id));
      if (Number.isInteger(current.repeatAnchorDay) && current.repeatAnchorDay >= 1 && current.repeatAnchorDay <= 31) return current.repeatAnchorDay;
      const due = parseCalendarDate(current.due);
      if (due) anchor = due.getDate();
      current = current.repeatParent === undefined ? null : data.tasks.find(item => String(item.id) === String(current.repeatParent) && item !== current && item.repeat === 'monthly');
    }
    return anchor || (parseCalendarDate(task.completedOn) || new Date()).getDate();
  }

  function nextDate(task, referenceKey = todayKey()) {
    const reference = parseCalendarDate(referenceKey) || parseCalendarDate(todayKey());
    const base = parseCalendarDate(task.due) || new Date(reference.getTime());
    if (task.repeat === 'daily') {
      base.setTime(reference.getTime());
      base.setDate(base.getDate() + 1);
    } else if (task.repeat === 'weekly') {
      const elapsedDays = Math.floor((Date.parse(dayKey(reference) + 'T00:00:00Z') - Date.parse(dayKey(base) + 'T00:00:00Z')) / 86400000);
      base.setDate(base.getDate() + Math.max(1, Math.floor(elapsedDays / 7) + 1) * 7);
    } else if (task.repeat === 'monthly') {
      const anchor = repeatAnchorDay(task);
      const elapsedMonths = (reference.getFullYear() - base.getFullYear()) * 12 + reference.getMonth() - base.getMonth();
      base.setDate(1);
      base.setMonth(base.getMonth() + Math.max(1, elapsedMonths));
      const setAnchor = () => {
        const end = new Date(base.getTime());
        end.setMonth(end.getMonth() + 1, 0);
        base.setDate(Math.min(anchor, end.getDate()));
      };
      setAnchor();
      if (base <= reference) {
        base.setDate(1);
        base.setMonth(base.getMonth() + 1);
        setAnchor();
      }
    } else return '';
    return base.getFullYear() >= 1 && base.getFullYear() <= 9999 ? dayKey(base) : '';
  }

  function retireRepeatAncestors() {
    const parents = new Set(data.tasks.filter(task => task.repeatParent !== undefined && String(task.repeatParent) !== String(task.id)).map(task => String(task.repeatParent)));
    let changed = false;
    data.tasks.forEach(task => {
      if (!parents.has(String(task.id)) || task.repeatRetired) return;
      // 旧版で作られた次回タスクの祖先は、履歴のまま保持する。
      task.repeatRetired = true;
      task.nextOccurrenceOn = '';
      changed = true;
    });
    return changed;
  }

  function setTaskCompleted(task, done) {
    if (!task || task.done === Boolean(done)) return;
    retireRepeatAncestors();
    task.done = Boolean(done);
    task.completedOn = task.done ? todayKey() : '';
    if (task.repeat === 'monthly') task.repeatAnchorDay = repeatAnchorDay(task);
    task.nextOccurrenceOn = task.done && !task.repeatRetired ? nextDate(task) : '';
  }

  // 旧呼び出しからもタスクが増えないよう、同じ行の次回だけを予約する。
  function spawnRepeat(task) {
    if (!task || !task.done) return;
    retireRepeatAncestors();
    if (task.repeat === 'monthly') task.repeatAnchorDay = repeatAnchorDay(task);
    task.nextOccurrenceOn = !task.repeatRetired ? nextDate(task, task.completedOn || todayKey()) : '';
  }

  function resetDailyTasks() {
    const key = todayKey();
    let changed = retireRepeatAncestors();
    data.tasks.forEach(task => {
      if (!['daily', 'weekly', 'monthly'].includes(task.repeat) || !task.done || task.repeatRetired) return;
      if (task.repeat === 'monthly' && !task.repeatAnchorDay) {
        task.repeatAnchorDay = repeatAnchorDay(task);
        changed = true;
      }
      if (!parseCalendarDate(task.nextOccurrenceOn)) {
        const completedOn = parseCalendarDate(task.completedOn) ? task.completedOn : parseCalendarDate(task.due) ? task.due : key;
        task.completedOn = completedOn;
        task.nextOccurrenceOn = nextDate(task, completedOn);
        changed = true;
      }
      if (!task.nextOccurrenceOn || task.nextOccurrenceOn > key) return;

      const scheduled = task.nextOccurrenceOn;
      const previousDue = task.due || task.completedOn || scheduled;
      const nextDue = task.repeat === 'daily' ? (task.due && task.due > key ? task.due : key) : scheduled;
      if (task.reminderAt) {
        const reminder = new Date(task.reminderAt);
        const offset = Math.round((Date.parse(nextDue + 'T00:00:00Z') - Date.parse(previousDue + 'T00:00:00Z')) / 86400000);
        if (Number.isFinite(reminder.getTime()) && Number.isFinite(offset)) {
          reminder.setDate(reminder.getDate() + offset);
          task.reminderAt = `${dayKey(reminder)}T${task.reminderAt.slice(11)}`;
        }
      }
      task.done = false;
      task.completedOn = '';
      task.nextOccurrenceOn = '';
      task.notified = false;
      task.subtasks = task.subtasks.map(subtask => ({ ...subtask, done: false }));
      if (task.due || task.repeat !== 'daily') task.due = nextDue;
      changed = true;
    });
    if (changed) save();
    return changed;
  }

  tasks = function () {
    const total = data.tasks.length;
    const done = data.tasks.filter(task => task.done).length;
    const overdue = data.tasks.filter(task => !task.done && task.due && task.due < todayKey()).length;
    return `<main class="page tasks-page">
      <div class="page-head">
        <h1 class="title">タスク</h1>
        <div class="toolbar compact">
          <button class="button dim" id="enableNotifications">通知</button>
          <button class="button dim" id="exportData">バックアップ</button>
          <label class="button dim file-button">復元<input id="importData" type="file" accept="application/json"></label>
        </div>
      </div>
      <section class="stats">
        <div class="stat"><b>${total}</b><span>合計</span></div>
        <div class="stat"><b>${total - done}</b><span>未完了</span></div>
        <div class="stat"><b>${done}</b><span>完了</span></div>
        <div class="stat"><b class="${overdue ? 'red' : ''}">${overdue}</b><span>期限超過</span></div>
      </section>
      <p class="task-notice" role="status" ${taskNotice ? '' : 'hidden'}>${esc(taskNotice)}</p>
      <form class="toolbar" id="taskForm">
        <input class="input" id="taskInput" required maxlength="120" placeholder="新しいタスク" aria-label="タスク名" value="${esc(taskDraft.title)}">
        <select class="select" id="taskPriority" aria-label="優先度">${[['high','高'],['medium','中'],['low','低']].map(([value,label]) => `<option value="${value}" ${taskDraft.priority === value ? 'selected' : ''}>優先度 ${label}</option>`).join('')}</select>
        <input class="select" id="taskDue" type="date" min="0001-01-01" max="9999-12-31" aria-label="期限日" value="${esc(taskDraft.due)}">
        <select class="select" id="taskRepeat" aria-label="繰り返し">${[['none','繰り返しなし'],['daily','毎日'],['weekly','毎週'],['monthly','毎月']].map(([value,label]) => `<option value="${value}" ${taskDraft.repeat === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <button class="button" type="submit">追加</button>
      </form>
      <p class="tool-hint">繰り返すタスクは、次回日に同じタスクが未完了へ戻ります。</p>
      <div class="toolbar">
        <input class="input" id="search" value="${esc(query)}" placeholder="タスク・メモを検索" aria-label="タスクを検索">
        <select class="select" id="sort" aria-label="並び順">${[['created','追加順'],['due','期限順'],['priority','優先度順'],['name','名前順']].map(([value,label]) => `<option value="${value}" ${taskSort === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <button type="button" class="ghost" id="resetTaskFilters">検索・絞り込みを解除</button>
      </div>
      <div class="filters">
        ${[['all','すべて'],['open','未完了'],['done','完了'],['overdue','期限超過'],['repeat','繰り返し']].map(item => `<button class="filter ${filter === item[0] ? 'active' : ''}" data-filter="${item[0]}">${item[1]}</button>`).join('')}
      </div>
      <section class="panel task-panel" id="taskList"></section>
    </main>`;
  };

  getTasks = function () {
    const rank = { high: 0, medium: 1, low: 2 };
    const sort = document.querySelector('#sort')?.value || 'created';
    return data.tasks.filter(task => {
      const matches = filter === 'all' ||
        filter === 'open' && !task.done ||
        filter === 'done' && task.done ||
        filter === 'overdue' && !task.done && task.due && task.due < todayKey() ||
        filter === 'repeat' && task.repeat !== 'none';
      return matches && (task.title + ' ' + (task.note || '') + ' ' + task.subtasks.map(sub => sub.title).join(' ')).toLowerCase().includes(query.trim().toLowerCase());
    }).sort((a, b) => sort === 'name' ? a.title.localeCompare(b.title, 'ja') :
      sort === 'priority' ? rank[a.priority] - rank[b.priority] :
      sort === 'due' ? (a.due || '9999-99-99').localeCompare(b.due || '9999-99-99') :
      new Date(b.created) - new Date(a.created));
  };

  drawTasks = function () {
    const list = document.querySelector('#taskList');
    const tasks = getTasks();
    list.innerHTML = tasks.length ? tasks.map(task => {
      const subDone = task.subtasks.filter(sub => sub.done).length;
      const meta = [
        `<span class="tag">● ${task.priority === 'high' ? '高' : task.priority === 'medium' ? '中' : '低'}</span>`,
        task.due ? `<span class="${!task.done && task.due < todayKey() ? 'red' : ''}">${task.due}${!task.done && task.due < todayKey() ? ' · 期限超過' : ''}</span>` : '',
        task.repeat !== 'none' ? `<span>↻ ${repeatLabel[task.repeat]}</span>` : '',
        task.subtasks.length ? `<span>☑ ${subDone}/${task.subtasks.length}</span>` : '',
        task.reminderAt ? '<span>通知あり</span>' : '',
        task.note ? '<span>メモあり</span>' : '',
        task.done && task.nextOccurrenceOn ? `<span>次回 ${esc(task.nextOccurrenceOn)}</span>` : ''
      ].filter(Boolean).join('');
      return `<article class="task ${task.done ? 'done' : ''}">
        <input class="check" type="checkbox" data-toggle="${esc(task.id)}" ${task.done ? 'checked' : ''} aria-label="${esc(task.title)}を${task.done ? '未完了に戻す' : '完了にする'}">
        <div><div class="task-title">${esc(task.title)}</div><div class="meta">${meta}</div></div>
        <div class="task-actions"><button type="button" data-edit="${esc(task.id)}" aria-label="${esc(task.title)}を編集">編集</button></div>
      </article>`;
    }).join('') : '<div class="empty">条件に一致するタスクはありません</div>';

    document.querySelectorAll('[data-toggle]').forEach(input => input.onchange = () => {
      const task = data.tasks.find(item => String(item.id) === input.dataset.toggle);
      if (!task) return;
      setTaskCompleted(task, input.checked);
      taskNotice = '';
      save();
      render();
    });
    document.querySelectorAll('[data-edit]').forEach(button => button.onclick = () => editTask(button.dataset.edit));
  };

  editTask = function (id) {
    const task = data.tasks.find(item => String(item.id) === String(id));
    if (!task) return;
    // サブタスクも下書きに含め、保存するまで元のタスクを変更しない。
    const draft = { ...task, subtasks: task.subtasks.map(sub => ({ ...sub })) };
    const initial = { due: task.due, reminderAt: task.reminderAt };
    let subtasksChanged = false;
    let newSubtask = '';
    const readDraft = () => {
      draft.title = document.querySelector('#editTitle').value;
      draft.priority = document.querySelector('#editPriority').value;
      draft.due = document.querySelector('#editDue').value;
      draft.repeat = document.querySelector('#editRepeat').value;
      draft.reminderAt = document.querySelector('#editReminder').value;
      draft.note = document.querySelector('#editNote').value;
      newSubtask = document.querySelector('#newSubtask').value;
    };
    const drawEditor = () => {
      const subtasks = draft.subtasks.map(sub => `<div class="subtask-row">
        <input type="checkbox" data-sub-toggle="${esc(sub.id)}" ${sub.done ? 'checked' : ''} aria-label="${esc(sub.title)}を完了にする">
        <span class="${sub.done ? 'struck' : ''}">${esc(sub.title)}</span>
        <button type="button" class="ghost" data-sub-remove="${esc(sub.id)}" aria-label="${esc(sub.title)}を削除">×</button>
      </div>`).join('') || '<div class="subtask-empty">サブタスクはありません</div>';
      modal(`<h2>タスクを編集</h2><form id="taskEditForm">
        <label for="editTitle">タスク名</label><input class="input" id="editTitle" required maxlength="120" value="${esc(draft.title)}">
        <div class="modal-grid">
          <div><label for="editPriority">優先度</label><select class="select" id="editPriority"><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></div>
          <div><label for="editDue">期限</label><input class="input" id="editDue" type="date" min="0001-01-01" max="9999-12-31" value="${esc(draft.due || '')}"></div>
          <div><label for="editRepeat">繰り返し</label><select class="select" id="editRepeat"><option value="none">なし</option><option value="daily">毎日</option><option value="weekly">毎週</option><option value="monthly">毎月</option></select></div>
          <div><label for="editReminder">通知日時</label><input class="input" id="editReminder" type="datetime-local" min="0001-01-01T00:00" max="9999-12-31T23:59" value="${esc(draft.reminderAt || '')}"></div>
        </div>
        <label for="editNote">メモ</label><textarea id="editNote" rows="3">${esc(draft.note || '')}</textarea>
        <label>サブタスク</label><div class="subtasks">${subtasks}</div>
        <div class="toolbar bottomless"><input class="input" id="newSubtask" maxlength="120" aria-label="新しいサブタスク" placeholder="サブタスク" value="${esc(newSubtask)}"><button type="button" class="button dim" id="addSubtask">追加</button></div>
        <div class="modal-actions"><button type="button" class="button dim" id="cancelEdit">キャンセル</button><button type="submit" class="button" id="saveEdit">保存</button></div>
      </form><div class="danger-zone"><p>次の確認画面で削除を確定します。</p><button type="button" class="button danger" id="askDelete">削除へ進む</button></div>`);
      document.querySelector('#editPriority').value = draft.priority;
      document.querySelector('#editRepeat').value = draft.repeat;
      document.querySelector('#cancelEdit').onclick = closeModal;
      const form = document.querySelector('#taskEditForm');
      const titleInput = document.querySelector('#editTitle');
      const dueInput = document.querySelector('#editDue');
      const reminderInput = document.querySelector('#editReminder');
      [titleInput, dueInput, reminderInput].forEach(input => input.oninput = () => input.setCustomValidity(''));
      form.onsubmit = event => {
        event.preventDefault();
        readDraft();
        titleInput.setCustomValidity(draft.title.trim() ? '' : 'タスク名を入力してください。');
        dueInput.setCustomValidity(!draft.due || isDateKey(draft.due) ? '' : '正しい期限日を入力してください。');
        const reminderValid = !draft.reminderAt || (/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(draft.reminderAt) && isDateKey(draft.reminderAt.slice(0, 10)));
        reminderInput.setCustomValidity(reminderValid ? '' : '正しい通知日時を入力してください。');
        if (!form.reportValidity()) return;
        // 編集中に次回分へ切り替わっても、完了状態や未編集の日時を巻き戻さない。
        const updates = {
          title: draft.title.trim(), priority: draft.priority, repeat: draft.repeat, note: draft.note,
          due: draft.due === initial.due ? task.due : draft.due,
          reminderAt: draft.reminderAt === initial.reminderAt ? task.reminderAt : draft.reminderAt,
          subtasks: subtasksChanged ? draft.subtasks : task.subtasks
        };
        const scheduleChanged = updates.due !== task.due || updates.repeat !== task.repeat;
        if (updates.reminderAt !== task.reminderAt) updates.notified = false;
        if (scheduleChanged) {
          updates.repeatAnchorDay = updates.repeat === 'monthly' ? new Date((updates.due || todayKey()) + 'T12:00:00').getDate() : undefined;
          updates.repeatRetired = false;
          updates.nextOccurrenceOn = task.done && updates.repeat !== 'none' ? nextDate({ ...task, ...updates }) : '';
        }
        Object.assign(task, updates);
        taskNotice = '変更を保存しました。';
        save(); closeModal(); render();
      };
      const addSubtask = () => {
        readDraft();
        if (!newSubtask.trim()) return;
        draft.subtasks.push({ id: newTaskId(), title: newSubtask.trim(), done: false });
        subtasksChanged = true;
        newSubtask = '';
        drawEditor();
        document.querySelector('#newSubtask').focus();
      };
      document.querySelector('#addSubtask').onclick = addSubtask;
      document.querySelector('#newSubtask').onkeydown = event => {
        if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addSubtask(); }
      };
      document.querySelectorAll('[data-sub-toggle]').forEach(input => input.onchange = () => {
        readDraft();
        const sub = draft.subtasks.find(item => String(item.id) === input.dataset.subToggle);
        if (sub) { sub.done = input.checked; subtasksChanged = true; }
        drawEditor();
      });
      document.querySelectorAll('[data-sub-remove]').forEach(button => button.onclick = () => {
        readDraft();
        draft.subtasks = draft.subtasks.filter(sub => String(sub.id) !== button.dataset.subRemove);
        subtasksChanged = true;
        drawEditor();
      });
      document.querySelector('#askDelete').onclick = () => confirmDelete('このタスクを完全に削除しますか？', () => {
        data.tasks = data.tasks.filter(item => String(item.id) !== String(task.id));
        taskNotice = 'タスクを削除しました。';
        save(); closeModal(); render();
      });
    };
    drawEditor();
  };

  let selectedDay = todayKey();
  let eventDraft = { date: selectedDay, time: '', title: '' };

  function parseCalendarDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(value + 'T12:00:00');
    if (!Number.isFinite(date.getTime()) || date.getFullYear() < 1 || date.getFullYear() > 9999) return null;
    return calendarDateKey(date) === value ? date : null;
  }

  function calendarDateKey(date) {
    return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function compareEvents(a, b) {
    return a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '') || a.title.localeCompare(b.title, 'ja');
  }

  function rememberEventDraft() {
    eventDraft = {
      date: document.querySelector('#eventDate').value,
      time: document.querySelector('#eventTime').value,
      title: document.querySelector('#eventTitle').value
    };
  }

  function selectCalendarDay(key, focusDay = false) {
    const date = parseCalendarDate(key);
    if (!date) return;
    selectedDay = key;
    eventDraft.date = key;
    month = new Date(date.getTime());
    month.setDate(1);
    render();
    if (focusDay) document.querySelector(`[data-calendar-day="${key}"]`)?.focus();
  }

  function validateEventForm(form, titleInput, dateInput, timeInput) {
    titleInput.setCustomValidity(titleInput.value.trim() ? '' : '予定のタイトルを入力してください。');
    dateInput.setCustomValidity(parseCalendarDate(dateInput.value) ? '' : '正しい日付を入力してください。');
    timeInput.setCustomValidity(!timeInput.value || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(timeInput.value) ? '' : '正しい時刻を入力してください。');
    return form.reportValidity();
  }

  function editCalendarEvent(id) {
    const item = data.events.find(event => String(event.id) === String(id));
    if (!item) return;
    modal(`<h2 id="eventEditHeading">予定を編集</h2>
      <form id="editEventForm">
        <label for="editEventTitle">タイトル</label><input class="input" id="editEventTitle" maxlength="120" required value="${esc(item.title)}">
        <div class="modal-grid">
          <div><label for="editEventDate">日付</label><input class="input" id="editEventDate" type="date" min="0001-01-01" max="9999-12-31" required value="${esc(item.date)}"></div>
          <div><label for="editEventTime">時刻（空欄は終日）</label><input class="input" id="editEventTime" type="time" value="${esc(item.time || '')}"></div>
        </div>
        <div class="modal-actions"><button class="button dim" type="button" id="cancelEventEdit">キャンセル</button><button class="button" type="submit">保存</button></div>
      </form>
      <div class="danger-zone"><p>次の確認画面で削除を確定します。</p><button class="button danger" id="deleteCalendarEvent">削除へ進む</button></div>`);
    const form = document.querySelector('#editEventForm');
    const titleInput = document.querySelector('#editEventTitle');
    const dateInput = document.querySelector('#editEventDate');
    const timeInput = document.querySelector('#editEventTime');
    [titleInput, dateInput, timeInput].forEach(input => input.oninput = () => input.setCustomValidity(''));
    document.querySelector('#cancelEventEdit').onclick = closeModal;
    form.onsubmit = event => {
      event.preventDefault();
      if (!validateEventForm(form, titleInput, dateInput, timeInput)) return;
      item.title = titleInput.value.trim();
      item.date = dateInput.value;
      item.time = timeInput.value;
      save();
      closeModal();
      selectCalendarDay(item.date);
    };
    document.querySelector('#deleteCalendarEvent').onclick = () => confirmDelete('この予定を完全に削除しますか？', () => {
      data.events = data.events.filter(event => event !== item);
      save(); closeModal(); render();
    });
    titleInput.focus();
  }

  calendar = function () {
    const year = month.getFullYear(), currentMonth = month.getMonth();
    const monthKey = `${String(year).padStart(4, '0')}-${String(currentMonth + 1).padStart(2, '0')}`;
    if (!selectedDay.startsWith(monthKey + '-')) {
      selectedDay = monthKey + '-01';
      eventDraft.date = selectedDay;
    }
    const first = parseCalendarDate(monthKey + '-01');
    const end = new Date(first.getTime());
    end.setMonth(end.getMonth() + 1, 0);
    const start = first.getDay(), days = end.getDate();
    const events = data.events.slice().sort(compareEvents);
    const monthEvents = events.filter(event => event.date.startsWith(monthKey + '-'));
    const dueTasks = data.tasks.filter(task => !task.done && (task.due || '').startsWith(monthKey + '-'));
    const selectedEvents = events.filter(event => event.date === selectedDay);
    const selectedTasks = dueTasks.filter(task => task.due === selectedDay);
    const cells = ['日','月','火','水','木','金','土'].map(day => `<div class="dayname">${day}</div>`);
    for (let index = 0; index < start; index++) cells.push('<div class="day day-outside" aria-hidden="true"></div>');
    for (let day = 1; day <= days; day++) {
      const key = `${monthKey}-${String(day).padStart(2, '0')}`;
      const dayEvents = monthEvents.filter(event => event.date === key);
      const dayTasks = dueTasks.filter(task => task.due === key);
      cells.push(`<div class="day ${key === todayKey() ? 'today' : ''} ${key === selectedDay ? 'selected-day' : ''}">
        <button type="button" class="calendar-date" data-calendar-day="${key}" aria-label="${year}年${currentMonth + 1}月${day}日、予定${dayEvents.length}件、タスク期限${dayTasks.length}件" aria-pressed="${key === selectedDay}" ${key === todayKey() ? 'aria-current="date"' : ''}>${day}</button>
        ${dayEvents.map(event => `<button type="button" class="event calendar-event" data-event-edit="${esc(event.id)}" title="${esc(event.time || '終日')} ${esc(event.title)}" aria-label="${esc(event.title)}を編集">${esc(event.time || '終日')} ${esc(event.title)}</button>`).join('')}
        ${dayTasks.map(task => `<button type="button" class="event task-event calendar-event" data-calendar-task="${esc(task.id)}" title="期限 ${esc(task.title)}" aria-label="タスク ${esc(task.title)}を編集">期限 ${esc(task.title)}</button>`).join('')}
      </div>`);
    }
    for (let index = (start + days) % 7; index > 0 && index < 7; index++) cells.push('<div class="day day-outside" aria-hidden="true"></div>');
    return `<main class="page calendar-page">
      <div class="page-head"><h1 class="title" aria-live="polite">${year}年 ${currentMonth + 1}月</h1><div class="calendar-navigation"><button class="ghost" id="prevMonth" aria-label="前の月" ${year === 1 && currentMonth === 0 ? 'disabled' : ''}>←</button><button class="ghost" id="todayMonth">今日</button><button class="ghost" id="nextMonth" aria-label="次の月" ${year === 9999 && currentMonth === 11 ? 'disabled' : ''}>→</button></div></div>
      <form class="toolbar calendar-form" id="eventForm">
        <div class="field"><label for="eventDate">日付</label><input class="select" id="eventDate" type="date" min="0001-01-01" max="9999-12-31" value="${esc(eventDraft.date)}" required></div>
        <div class="field"><label for="eventTime">時刻（空欄は終日）</label><input class="select" id="eventTime" type="time" value="${esc(eventDraft.time)}"></div>
        <div class="field calendar-title-field"><label for="eventTitle">タイトル</label><input class="input" id="eventTitle" maxlength="120" required placeholder="新しい予定" value="${esc(eventDraft.title)}"></div>
        <button class="button" type="submit">予定を追加</button>
      </form>
      <section class="panel calendar-panel" aria-label="${year}年${currentMonth + 1}月のカレンダー"><div class="calendar">${cells.join('')}</div></section>
      <section class="panel calendar-agenda" aria-labelledby="selectedDayHeading"><h3 id="selectedDayHeading">${esc(selectedDay)} の予定</h3>
        ${selectedEvents.map(event => `<div class="agenda-row"><time>${esc(event.time || '終日')}</time><span>${esc(event.title)}</span><button class="ghost" data-event-edit="${esc(event.id)}" aria-label="${esc(event.title)}を編集">編集</button></div>`).join('')}
        ${selectedTasks.map(task => `<div class="agenda-row"><time class="tag">期限</time><span>${esc(task.title)}</span><button class="ghost" data-calendar-task="${esc(task.id)}" aria-label="タスク ${esc(task.title)}を編集">タスクを編集</button></div>`).join('')}
        ${selectedEvents.length || selectedTasks.length ? '' : '<div class="empty">この日の予定・タスク期限はありません</div>'}
      </section>
      <section class="panel calendar-agenda" aria-labelledby="monthAgendaHeading"><h3 id="monthAgendaHeading">この月の予定 · ${monthEvents.length}件</h3>
        ${monthEvents.map(event => `<div class="agenda-row month-agenda-row"><button class="ghost agenda-date" data-calendar-select="${esc(event.date)}">${esc(event.date.slice(5))}</button><time>${esc(event.time || '終日')}</time><span>${esc(event.title)}</span><button class="ghost" data-event-edit="${esc(event.id)}" aria-label="${esc(event.title)}を編集">編集</button></div>`).join('') || '<div class="empty">この月の予定はありません</div>'}
      </section>
    </main>`;
  };

  function exportData() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `dayflow-${todayKey()}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const incoming = JSON.parse(String(reader.result));
        const restored = normalizeData(incoming, { strict: true });
        restored.tasks.forEach(task => { task.notified = false; });
        modal(`<h2>バックアップを復元</h2><p>現在のデータを選択したバックアップで置き換えます。</p><div class="modal-actions"><button class="button dim" id="cancelImport">キャンセル</button><button class="button" id="confirmImport">復元する</button></div>`);
        document.querySelector('#cancelImport').onclick = closeModal;
        document.querySelector('#confirmImport').onclick = () => {
          data = restored;
          resetDailyTasks();
          save(); closeModal(); render();
        };
      } catch {
        alert('Dayflowのバックアップファイルではありません。');
      }
    };
    reader.onerror = () => alert('バックアップファイルを読み込めませんでした。');
    reader.readAsText(file);
  }

  function enableNotifications() {
    if (!('Notification' in window)) return alert('このブラウザは通知に対応していません。');
    Notification.requestPermission().then(permission => alert(permission === 'granted' ? '通知を有効にしました。' : '通知は許可されませんでした。'));
  }

  function checkReminders() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    let changed = false;
    data.tasks.forEach(task => {
      if (!task.done && task.reminderAt && !task.notified && new Date(task.reminderAt).getTime() <= Date.now()) {
        new Notification('Dayflow', { body: task.title });
        task.notified = true;
        changed = true;
      }
    });
    if (changed) save();
  }

  bind = function () {
    if (page !== 'tasks' && page !== 'calendar') oldBind();
    if (page === 'tasks') {
      const form = document.querySelector('#taskForm');
      const taskInput = document.querySelector('#taskInput');
      const taskDue = document.querySelector('#taskDue');
      ['#taskInput', '#taskPriority', '#taskDue', '#taskRepeat'].forEach(selector => {
        const input = document.querySelector(selector);
        input.oninput = () => { input.setCustomValidity(''); rememberTaskDraft(); };
        input.onchange = () => { input.setCustomValidity(''); rememberTaskDraft(); };
      });
      form.onsubmit = event => {
        event.preventDefault();
        rememberTaskDraft();
        const title = taskDraft.title.trim();
        taskInput.setCustomValidity(title ? '' : 'タスク名を入力してください。');
        taskDue.setCustomValidity(!taskDraft.due || isDateKey(taskDraft.due) ? '' : '正しい期限日を入力してください。');
        if (!form.reportValidity()) return;
        data.tasks.unshift({
          id: newTaskId(), title, priority: taskDraft.priority,
          due: taskDraft.due, note: '', done: false,
          created: new Date().toISOString(), repeat: taskDraft.repeat,
          ...(taskDraft.repeat === 'monthly' ? { repeatAnchorDay: new Date((taskDraft.due || todayKey()) + 'T12:00:00').getDate() } : {}),
          subtasks: [], reminderAt: '', notified: false, completedOn: ''
        });
        // 登録したタスクが検索や完了フィルターで隠れないようにする。
        filter = 'all'; query = '';
        taskDraft = { ...taskDraft, title: '' };
        taskNotice = 'タスクを追加しました。';
        save(); render();
        document.querySelector('#taskInput').focus();
      };
      document.querySelector('#enableNotifications').onclick = enableNotifications;
      document.querySelector('#exportData').onclick = exportData;
      document.querySelector('#importData').onchange = event => {
        if (event.target.files[0]) importData(event.target.files[0]);
        event.target.value = '';
      };
      document.querySelector('#search').oninput = event => { query = event.target.value; drawTasks(); };
      document.querySelector('#sort').onchange = event => { taskSort = event.target.value; drawTasks(); };
      document.querySelector('#resetTaskFilters').onclick = () => { query = ''; filter = 'all'; render(); };
      document.querySelectorAll('[data-filter]').forEach(button => button.onclick = () => { filter = button.dataset.filter; render(); });
      drawTasks();
    }
    if (page === 'calendar') {
      const moveMonth = offset => {
        rememberEventDraft();
        // 先に1日に戻すと、31日からの移動でも翌月を飛び越さない。
        const next = new Date(month.getTime());
        next.setDate(1);
        next.setMonth(next.getMonth() + offset);
        if (next.getFullYear() < 1 || next.getFullYear() > 9999) return;
        selectCalendarDay(calendarDateKey(next));
        document.querySelector(offset < 0 ? '#prevMonth' : '#nextMonth').focus();
      };
      document.querySelector('#prevMonth').onclick = () => moveMonth(-1);
      document.querySelector('#nextMonth').onclick = () => moveMonth(1);
      document.querySelector('#todayMonth').onclick = () => {
        rememberEventDraft();
        selectCalendarDay(todayKey(), true);
      };
      document.querySelectorAll('[data-calendar-day], [data-calendar-select]').forEach(button => {
        button.onclick = () => {
          rememberEventDraft();
          selectCalendarDay(button.dataset.calendarDay || button.dataset.calendarSelect, true);
        };
      });
      document.querySelectorAll('[data-calendar-day]').forEach(button => {
        button.onkeydown = event => {
          const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
          if (!(event.key in offsets)) return;
          event.preventDefault();
          const next = parseCalendarDate(button.dataset.calendarDay);
          next.setDate(next.getDate() + offsets[event.key]);
          rememberEventDraft();
          selectCalendarDay(calendarDateKey(next), true);
        };
      });
      document.querySelectorAll('[data-event-edit]').forEach(button => button.onclick = () => {
        rememberEventDraft();
        editCalendarEvent(button.dataset.eventEdit);
      });
      document.querySelectorAll('[data-calendar-task]').forEach(button => button.onclick = () => {
        rememberEventDraft();
        editTask(button.dataset.calendarTask);
      });
      const form = document.querySelector('#eventForm');
      const titleInput = document.querySelector('#eventTitle');
      const dateInput = document.querySelector('#eventDate');
      const timeInput = document.querySelector('#eventTime');
      [titleInput, dateInput, timeInput].forEach(input => input.oninput = () => {
        input.setCustomValidity('');
        rememberEventDraft();
      });
      dateInput.onchange = () => {
        rememberEventDraft();
        if (parseCalendarDate(dateInput.value)) selectCalendarDay(dateInput.value);
      };
      document.querySelector('#eventForm').onsubmit = event => {
        event.preventDefault();
        if (!validateEventForm(form, titleInput, dateInput, timeInput)) return;
        const date = dateInput.value;
        data.events.push({
          id: globalThis.crypto?.randomUUID?.() || `event-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          date, time: timeInput.value, title: titleInput.value.trim()
        });
        eventDraft = { date, time: '', title: '' };
        save();
        selectCalendarDay(date);
        document.querySelector('#eventTitle').focus();
      };
    }
  };

  resetDailyTasks();
  render();
  checkReminders();
  setInterval(() => {
    if (resetDailyTasks()) render();
    checkReminders();
  }, 30000);
})();
