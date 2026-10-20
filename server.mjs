import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.YAP_TYPER_DATA_DIR || join(root, 'data');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const publicFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

await mkdir(dataDir, { recursive: true });
const temporarySessions = new Map();
const todosPath = join(dataDir, 'todos.json');
let todos = [];
let todoWrite = Promise.resolve();

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

async function bodyJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) fail(413, 'Request is too large.');
  }
  try {
    return JSON.parse(raw || '{}');
  } catch {
    fail(400, 'Invalid JSON.');
  }
}

function sessionPath(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) fail(400, 'Invalid session ID.');
  return join(dataDir, `${id}.json`);
}

async function save(session) {
  session.updatedAt = new Date().toISOString();
  const hasContent = Boolean(session.dumpText.trim() || session.todoDraft.trim() || session.tasks.length);
  if (!hasContent) {
    temporarySessions.set(session.id, session);
    return;
  }
  const path = sessionPath(session.id);
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(session, null, 2)}\n`);
  await rename(temp, path);
  temporarySessions.delete(session.id);
}

async function persistTodos() {
  const temp = `${todosPath}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(todos, null, 2)}\n`);
  await rename(temp, todosPath);
}

async function changeTodos(change) {
  const operation = todoWrite.then(async () => {
    const before = structuredClone(todos);
    try {
      const result = await change();
      await persistTodos();
      return result;
    } catch (error) {
      todos = before;
      throw error;
    }
  });
  todoWrite = operation.catch(() => {});
  return operation;
}

function todoFromTask(task, session) {
  return {
    id: task.id,
    text: task.text,
    done: Boolean(task.done),
    notes: task.notes || '',
    updatedAt: task.updatedAt || session.updatedAt || session.createdAt,
    sessionId: session.id,
  };
}

try {
  todos = JSON.parse(await readFile(todosPath, 'utf8'));
  if (!Array.isArray(todos)) throw new Error('Invalid Todo data.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const names = (await readdir(dataDir)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
  for (const name of names) {
    const session = JSON.parse(await readFile(join(dataDir, name), 'utf8'));
    for (const task of session.tasks || []) todos.push(todoFromTask(task, session));
  }
  await persistTodos();
}

async function read(id) {
  try {
    const session = JSON.parse(await readFile(sessionPath(id), 'utf8'));
    if (settle(session)) {
      await save(session);
      await changeTodos(() => {
        for (const task of session.tasks) {
          if (!todos.some(item => item.id === task.id)) todos.push(todoFromTask(task, session));
        }
      });
    }
    return session;
  } catch (error) {
    if (error.code === 'ENOENT') {
      const temporary = temporarySessions.get(id);
      if (temporary) {
        if (settle(temporary)) {
          await save(temporary);
          await changeTodos(() => {
            for (const task of temporary.tasks) {
              if (!todos.some(item => item.id === task.id)) todos.push(todoFromTask(task, temporary));
            }
          });
        }
        return temporary;
      }
      fail(404, 'Session not found.');
    }
    throw error;
  }
}

function finishTasks(session, at = new Date().toISOString()) {
  session.tasks = session.todoDraft.split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(text => ({ id: randomUUID(), text, done: false, updatedAt: at }));
  session.todoFinishedAt = at;
}

function settle(session) {
  let changed = false;
  const now = Date.now();
  if (session.dumpStartedAt && !session.dumpFinishedAt && now >= Date.parse(session.dumpEndsAt)) {
    session.dumpFinishedAt = session.dumpEndsAt;
    changed = true;
  }
  if (session.todoStartedAt && !session.todoFinishedAt && now >= Date.parse(session.todoEndsAt)) {
    finishTasks(session, session.todoEndsAt);
    changed = true;
  }
  return changed;
}

function phase(session) {
  if (!session.dumpFinishedAt) return 'dump';
  if (!session.todoFinishedAt) return 'todo';
  return 'checklist';
}

function minutes(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 60) fail(400, 'Timer must be 1–60 minutes.');
  return number;
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 2 && parts[1] === 'todos') {
    if (req.method === 'GET') {
      await todoWrite;
      return send(res, 200, todos.map((todo, index) => ({ todo, index }))
        .sort((a, b) => b.todo.updatedAt.localeCompare(a.todo.updatedAt) || b.index - a.index)
        .map(({ todo }) => todo));
    }
    if (req.method === 'POST') {
      const { text, notes = '' } = await bodyJson(req);
      if (typeof text !== 'string' || !text.trim() || text.trim().length > 500 || /[\r\n]/.test(text)) fail(400, 'Enter one task, up to 500 characters.');
      if (typeof notes !== 'string' || notes.length > 100_000) fail(400, 'Notes must be 100,000 characters or fewer.');
      const todo = { id: randomUUID(), text: text.trim(), done: false, notes, updatedAt: new Date().toISOString(), sessionId: null };
      await changeTodos(() => todos.push(todo));
      return send(res, 201, todo);
    }
  }

  if (parts.length === 3 && parts[1] === 'todos') {
    if (req.method === 'PATCH') {
      const body = await bodyJson(req);
      if (body.done !== undefined && typeof body.done !== 'boolean') fail(400, 'Invalid task state.');
      if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > 100_000)) fail(400, 'Notes must be 100,000 characters or fewer.');
      if (body.text !== undefined && (typeof body.text !== 'string' || !body.text.trim() || body.text.trim().length > 500 || /[\r\n]/.test(body.text))) fail(400, 'Enter one task, up to 500 characters.');
      if (!['done', 'notes', 'text'].some(key => body[key] !== undefined)) fail(400, 'No changes provided.');
      const todo = await changeTodos(() => {
        const item = todos.find(entry => entry.id === parts[2]);
        if (!item) fail(404, 'Task not found.');
        let changed = false;
        for (const key of ['done', 'notes', 'text']) {
          const value = key === 'text' && body[key] !== undefined ? body[key].trim() : body[key];
          if (value !== undefined && item[key] !== value) {
            item[key] = value;
            changed = true;
          }
        }
        if (changed) item.updatedAt = new Date().toISOString();
        if (changed) {
          todos.splice(todos.indexOf(item), 1);
          todos.push(item);
        }
        return { ...item };
      });
      if (todo.sessionId) {
        try {
          const session = await read(todo.sessionId);
          const task = session.tasks.find(item => item.id === todo.id);
          if (task) {
            task.text = todo.text;
            task.done = todo.done;
            task.updatedAt = todo.updatedAt;
            await save(session);
          }
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
      return send(res, 200, todo);
    }
    if (req.method === 'DELETE') {
      await changeTodos(() => {
        const index = todos.findIndex(item => item.id === parts[2]);
        if (index < 0) fail(404, 'Task not found.');
        todos.splice(index, 1);
      });
      return send(res, 200, { deleted: true });
    }
  }
  if (parts.length === 2 && parts[1] === 'sessions') {
    if (req.method === 'GET') {
      const names = (await readdir(dataDir)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
      const sessions = await Promise.all(names.map(name => read(name.slice(0, -5))));
      sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return send(res, 200, sessions.map(session => ({
        id: session.id,
        createdAt: session.createdAt,
        phase: phase(session),
        taskCount: session.tasks.length,
        doneCount: session.tasks.filter(task => task.done).length,
      })));
    }
    if (req.method === 'POST') {
      const body = await bodyJson(req);
      const now = new Date().toISOString();
      const session = {
        id: randomUUID(), createdAt: now, updatedAt: now,
        dumpMinutes: minutes(body.dumpMinutes), todoMinutes: minutes(body.todoMinutes),
        dumpStartedAt: null, dumpEndsAt: null, dumpFinishedAt: null, dumpText: '',
        todoStartedAt: null, todoEndsAt: null, todoFinishedAt: null,
        todoDraft: '', tasks: [],
      };
      temporarySessions.set(session.id, session);
      return send(res, 201, session);
    }
  }

  if (parts.length >= 3 && parts[1] === 'sessions') {
    if (parts.length === 3 && req.method === 'DELETE') {
      const path = sessionPath(parts[2]);
      temporarySessions.delete(parts[2]);
      await rm(path, { force: true });
      return send(res, 200, { deleted: true });
    }
    const session = await read(parts[2]);
    if (parts.length === 3 && req.method === 'GET') return send(res, 200, session);

    if (parts[3] === 'dump' && parts.length === 4 && req.method === 'PATCH') {
      if (phase(session) !== 'dump') fail(409, 'Dump time has ended.');
      const { text } = await bodyJson(req);
      if (typeof text !== 'string' || text.length > 1_000_000 || !text.startsWith(session.dumpText)) {
        fail(409, 'The dump can only grow.');
      }
      if (text.length > session.dumpText.length) {
        if (!session.dumpStartedAt) {
          session.dumpStartedAt = new Date().toISOString();
          session.dumpEndsAt = new Date(Date.parse(session.dumpStartedAt) + session.dumpMinutes * 60_000).toISOString();
        }
        session.dumpText = text;
        await save(session);
      }
      return send(res, 200, session);
    }

    if (parts[3] === 'todo' && parts.length === 4 && req.method === 'PATCH') {
      if (phase(session) !== 'todo') fail(409, 'List writing time has ended.');
      const { text } = await bodyJson(req);
      if (typeof text !== 'string' || text.length > 100_000) fail(400, 'Invalid task list.');
      if (text !== session.todoDraft) {
        if (!session.todoStartedAt && text.length) {
          session.todoStartedAt = new Date().toISOString();
          session.todoEndsAt = new Date(Date.parse(session.todoStartedAt) + session.todoMinutes * 60_000).toISOString();
        }
        session.todoDraft = text;
        await save(session);
      }
      return send(res, 200, session);
    }

    if (parts[3] === 'finish-todo' && parts.length === 4 && req.method === 'POST') {
      if (phase(session) !== 'todo') fail(409, 'List writing is unavailable.');
      finishTasks(session);
      await save(session);
      await changeTodos(() => todos.push(...session.tasks.map(task => todoFromTask(task, session))));
      return send(res, 200, session);
    }

    if (parts[3] === 'tasks' && parts.length === 4 && req.method === 'POST') {
      if (phase(session) !== 'checklist') fail(409, 'The checklist is not ready yet.');
      const { text } = await bodyJson(req);
      if (typeof text !== 'string' || !text.trim() || text.trim().length > 500 || /[\r\n]/.test(text)) {
        fail(400, 'Enter one task, up to 500 characters.');
      }
      session.tasks.push({ id: randomUUID(), text: text.trim(), done: false, updatedAt: new Date().toISOString() });
      await save(session);
      await changeTodos(() => todos.push(todoFromTask(session.tasks.at(-1), session)));
      return send(res, 201, session);
    }

    if (parts[3] === 'tasks' && parts.length === 5 && req.method === 'PATCH') {
      if (phase(session) !== 'checklist') fail(409, 'The checklist is not ready yet.');
      const { done } = await bodyJson(req);
      if (typeof done !== 'boolean') fail(400, 'Invalid task state.');
      const task = session.tasks.find(item => item.id === parts[4]);
      if (!task) fail(404, 'Task not found.');
      task.done = done;
      task.updatedAt = new Date().toISOString();
      await save(session);
      await changeTodos(() => {
        const todo = todos.find(item => item.id === task.id);
        if (todo) {
          todo.done = done;
          todo.updatedAt = task.updatedAt;
          todos.splice(todos.indexOf(todo), 1);
          todos.push(todo);
        }
      });
      return send(res, 200, session);
    }
  }
  fail(404, 'Not found.');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' || !publicFiles[url.pathname]) return send(res, 404, 'Not found.', 'text/plain; charset=utf-8');
    const [filename, type] = publicFiles[url.pathname];
    return send(res, 200, await readFile(join(root, 'public', filename), 'utf8'), type);
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error(error);
    send(res, status, { error: status === 500 ? 'Something went wrong.' : error.message });
  }
});

server.listen(port, host, () => {
  console.log(`Yap Typer is listening at http://${host}:${port}`);
  console.log(`Session files: ${dataDir}`);
});
