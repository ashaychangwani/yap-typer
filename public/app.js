const $ = selector => document.querySelector(selector);
const ui = {
  today: $('#today-label'), list: $('#session-list'), empty: $('#empty-view'), session: $('#session-view'),
  download: $('#download-button'), eyebrow: $('#stage-eyebrow'), title: $('#stage-title'),
  description: $('#stage-description'), timer: $('#timer-value'), timerLabel: $('#timer-label'),
  timerNote: $('#timer-note'), timerCard: $('.timer-card'), dumpStage: $('#dump-stage'),
  dump: $('#dump-input'), dumpStatus: $('#dump-status'), todoStage: $('#todo-stage'),
  todo: $('#todo-input'), todoStatus: $('#todo-status'), checklistStage: $('#checklist-stage'),
  tasks: $('#task-list'), progress: $('#task-progress'), dialog: $('#settings-dialog'),
  dumpMinutes: $('#dump-minutes'), todoMinutes: $('#todo-minutes'), toast: $('#toast'),
};

let active = null;
let acceptedDump = '';
let dumpPending = null;
let todoPending = null;
let dumpPromise = null;
let todoPromise = null;
let refreshing = false;
let toastTimeout;
let taskPromise = Promise.resolve();

ui.today.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not save.');
  return data;
}

function notify(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => ui.toast.classList.remove('show'), 4000);
}

function stage(session) {
  if (!session.dumpFinishedAt) return 'dump';
  if (!session.todoFinishedAt) return 'todo';
  return 'checklist';
}

function remaining(end) {
  return Math.max(0, Date.parse(end) - Date.now());
}

function clock(ms) {
  const seconds = Math.ceil(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function updateSession(session) {
  if (!active || session.id !== active.id) return;
  const oldStage = stage(active);
  active = session;
  if (stage(active) !== oldStage) {
    renderSession(true);
    loadHistory();
  }
  tick();
}

function renderSession(focus = false) {
  ui.empty.hidden = Boolean(active);
  ui.session.hidden = !active;
  ui.download.hidden = !active;
  if (!active) return;

  const current = stage(active);
  ui.dumpStage.hidden = current !== 'dump';
  ui.todoStage.hidden = current !== 'todo';
  ui.checklistStage.hidden = current !== 'checklist';
  ui.dump.value = active.dumpText;
  acceptedDump = active.dumpText;
  ui.todo.value = active.todoDraft;

  if (current === 'dump') {
    ui.eyebrow.textContent = 'STEP 01 / 02 · BRAIN DUMP';
    ui.title.textContent = 'Let it all out.';
    ui.description.textContent = 'Write whatever is on your mind. Keep moving forward; typos and unfinished thoughts are welcome.';
    ui.dumpStatus.textContent = 'Your words save as you type.';
    if (focus) ui.dump.focus();
  } else if (current === 'todo') {
    ui.eyebrow.textContent = 'STEP 02 / 02 · TASK LIST';
    ui.title.textContent = 'Pick what matters.';
    ui.description.textContent = 'Write the tasks for this work session, one per line. You can edit them until the timer ends.';
    ui.todoStatus.textContent = 'Your list saves as you type.';
    if (focus) ui.todo.focus();
  } else {
    ui.eyebrow.textContent = 'YOUR WORK SESSION';
    ui.title.textContent = 'One thing at a time.';
    ui.description.textContent = 'Your thoughts are out of your head. Work through this list at your own pace.';
    renderTasks();
  }
  tick();
  loadHistory();
}

function renderTasks() {
  ui.tasks.replaceChildren();
  const tasks = active.tasks;
  const done = tasks.filter(task => task.done).length;
  ui.progress.textContent = `${done} of ${tasks.length} done`;
  if (!tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'no-tasks';
    empty.textContent = 'No tasks written for this session. Take a breath, then begin.';
    ui.tasks.append(empty);
    return;
  }
  for (const task of tasks) {
    const label = document.createElement('label');
    label.className = `task-item${task.done ? ' done' : ''}`;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = task.done;
    box.setAttribute('aria-label', `Mark ${task.text} complete`);
    const text = document.createElement('span');
    text.textContent = task.text;
    label.append(box, text);
    box.addEventListener('change', () => {
      const wanted = box.checked;
      label.classList.toggle('done', wanted);
      box.disabled = true;
      const id = active.id;
      taskPromise = taskPromise.then(async () => {
        const result = await api(`/sessions/${id}/tasks/${task.id}`, { method: 'PATCH', body: { done: wanted } });
        if (active?.id === id) {
          active = result;
          renderTasks();
          loadHistory();
        }
      }).catch(error => {
        notify(error.message);
        box.disabled = false;
        box.checked = !wanted;
        label.classList.toggle('done', !wanted);
      });
    });
    ui.tasks.append(label);
  }
}

function tick() {
  if (!active) return;
  const current = stage(active);
  ui.timerCard.classList.toggle('finished', current === 'checklist');
  if (current === 'checklist') {
    ui.timerLabel.textContent = 'Ready to work';
    ui.timer.textContent = '✓';
    ui.timerNote.textContent = 'At your own pace';
    return;
  }
  const isDump = current === 'dump';
  const start = isDump ? active.dumpStartedAt : active.todoStartedAt;
  const end = isDump ? active.dumpEndsAt : active.todoEndsAt;
  const length = isDump ? active.dumpMinutes : active.todoMinutes;
  const left = start ? remaining(end) : length * 60_000;
  ui.timerLabel.textContent = isDump ? 'Brain dump' : 'Task list';
  ui.timer.textContent = clock(left);
  ui.timerNote.textContent = start ? 'Time remaining' : 'Starts when you type';
  (isDump ? ui.dump : ui.todo).disabled = Boolean(start && left === 0);
  if (start && left === 0 && !refreshing) refreshAfterDeadline();
}

async function refreshAfterDeadline() {
  if (!active || refreshing) return;
  refreshing = true;
  const id = active.id;
  try {
    await flushWrites();
    const session = await api(`/sessions/${id}`);
    if (active?.id === id) updateSession(session);
  } catch (error) {
    notify(error.message);
  } finally {
    refreshing = false;
  }
}

function queueDump(text) {
  dumpPending = text;
  if (dumpPromise) return;
  const id = active.id;
  dumpPromise = (async () => {
    while (dumpPending !== null) {
      const next = dumpPending;
      dumpPending = null;
      const session = await api(`/sessions/${id}/dump`, { method: 'PATCH', body: { text: next } });
      if (active?.id === id) updateSession(session);
    }
  })().catch(error => {
    ui.dumpStatus.textContent = `Save issue: ${error.message}`;
    notify(error.message);
  }).finally(() => {
    dumpPromise = null;
    if (dumpPending !== null && active?.id === id) queueDump(dumpPending);
  });
}

function queueTodo(text) {
  todoPending = text;
  if (todoPromise) return;
  const id = active.id;
  todoPromise = (async () => {
    while (todoPending !== null) {
      const next = todoPending;
      todoPending = null;
      const session = await api(`/sessions/${id}/todo`, { method: 'PATCH', body: { text: next } });
      if (active?.id === id) updateSession(session);
    }
  })().catch(error => {
    ui.todoStatus.textContent = `Save issue: ${error.message}`;
    notify(error.message);
  }).finally(() => {
    todoPromise = null;
    if (todoPending !== null && active?.id === id) queueTodo(todoPending);
  });
}

async function flushWrites() {
  while (dumpPromise || todoPromise) {
    await Promise.all([dumpPromise, todoPromise].filter(Boolean));
  }
}

function recordDump() {
  const candidate = ui.dump.value;
  if (!candidate.startsWith(acceptedDump)) {
    ui.dump.value = acceptedDump;
    ui.dump.setSelectionRange(acceptedDump.length, acceptedDump.length);
    return;
  }
  if (candidate === acceptedDump) return;
  acceptedDump = candidate;
  ui.dump.setSelectionRange(candidate.length, candidate.length);
  if (!active.dumpStartedAt) {
    active.dumpStartedAt = new Date().toISOString();
    active.dumpEndsAt = new Date(Date.parse(active.dumpStartedAt) + active.dumpMinutes * 60_000).toISOString();
  }
  queueDump(candidate);
  tick();
}

ui.dump.addEventListener('beforeinput', event => {
  if (event.inputType.startsWith('delete') || event.inputType.startsWith('history')) {
    event.preventDefault();
    return;
  }
  if (event.inputType.startsWith('insert') && ui.dump.selectionStart !== ui.dump.value.length) {
    ui.dump.setSelectionRange(ui.dump.value.length, ui.dump.value.length);
  }
});
ui.dump.addEventListener('keydown', event => {
  if (event.key === 'Backspace' || event.key === 'Delete' || ((event.metaKey || event.ctrlKey) && ['z', 'x'].includes(event.key.toLowerCase()))) event.preventDefault();
});
ui.dump.addEventListener('paste', event => {
  event.preventDefault();
  if (ui.dump.disabled) return;
  const text = event.clipboardData.getData('text/plain');
  if (!text) return;
  ui.dump.value = acceptedDump + text;
  recordDump();
});
ui.dump.addEventListener('drop', event => event.preventDefault());
ui.dump.addEventListener('input', recordDump);
ui.dump.addEventListener('click', () => ui.dump.setSelectionRange(ui.dump.value.length, ui.dump.value.length));
ui.dump.addEventListener('focus', () => ui.dump.setSelectionRange(ui.dump.value.length, ui.dump.value.length));

ui.todo.addEventListener('input', () => {
  if (!active.todoStartedAt && ui.todo.value.length) {
    active.todoStartedAt = new Date().toISOString();
    active.todoEndsAt = new Date(Date.parse(active.todoStartedAt) + active.todoMinutes * 60_000).toISOString();
  }
  queueTodo(ui.todo.value);
  tick();
});

$('#finish-todo').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await flushWrites();
    const session = await api(`/sessions/${active.id}/finish-todo`, { method: 'POST' });
    updateSession(session);
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});

async function loadHistory() {
  try {
    const sessions = await api('/sessions');
    ui.list.replaceChildren();
    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'sidebar-empty';
      empty.textContent = 'No sessions yet';
      ui.list.append(empty);
      return sessions;
    }
    for (const item of sessions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `session-link${item.id === active?.id ? ' active' : ''}`;
      const date = document.createElement('span');
      date.textContent = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(item.createdAt));
      const state = document.createElement('small');
      state.textContent = item.phase === 'checklist' ? `${item.doneCount}/${item.taskCount} done` : item.phase === 'todo' ? 'Tasks' : 'Writing';
      button.append(date, state);
      button.addEventListener('click', () => openSession(item.id));
      ui.list.append(button);
    }
    return sessions;
  } catch (error) {
    notify(error.message);
    return [];
  }
}

async function openSession(id) {
  try {
    await flushWrites();
    active = await api(`/sessions/${id}`);
    renderSession(false);
  } catch (error) {
    notify(error.message);
  }
}

function openSettings() {
  ui.dumpMinutes.value = localStorage.getItem('yap-typer-dump-minutes') || '2';
  ui.todoMinutes.value = localStorage.getItem('yap-typer-todo-minutes') || '1';
  ui.dialog.showModal();
  ui.dumpMinutes.focus();
}

$('#new-session').addEventListener('click', openSettings);
$('#empty-new').addEventListener('click', openSettings);
$('#close-dialog').addEventListener('click', () => ui.dialog.close());
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const dumpMinutes = Number(ui.dumpMinutes.value);
  const todoMinutes = Number(ui.todoMinutes.value);
  if (!Number.isInteger(dumpMinutes) || !Number.isInteger(todoMinutes) || dumpMinutes < 1 || todoMinutes < 1 || dumpMinutes > 60 || todoMinutes > 60) return;
  try {
    await flushWrites();
    const session = await api('/sessions', { method: 'POST', body: { dumpMinutes, todoMinutes } });
    localStorage.setItem('yap-typer-dump-minutes', String(dumpMinutes));
    localStorage.setItem('yap-typer-todo-minutes', String(todoMinutes));
    active = session;
    ui.dialog.close();
    renderSession(true);
  } catch (error) {
    notify(error.message);
  }
});

ui.download.addEventListener('click', async () => {
  try {
    await flushWrites();
    const session = await api(`/sessions/${active.id}`);
    const blob = new Blob([`${JSON.stringify(session, null, 2)}\n`], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `yap-typer-${session.createdAt.slice(0, 10)}-${session.id.slice(0, 8)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) {
    notify(error.message);
  }
});

setInterval(tick, 250);
const sessions = await loadHistory();
if (sessions.length) await openSession(sessions[0].id);
else renderSession();
