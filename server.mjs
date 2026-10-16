import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.YAP_TYPER_DATA_DIR || join(root, 'data');
const port = Number(process.env.PORT || 4173);
const publicFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

await mkdir(dataDir, { recursive: true });

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
  const path = sessionPath(session.id);
  const temp = `${path}.${randomUUID()}.tmp`;
  session.updatedAt = new Date().toISOString();
  await writeFile(temp, `${JSON.stringify(session, null, 2)}\n`);
  await rename(temp, path);
}

async function read(id) {
  try {
    const session = JSON.parse(await readFile(sessionPath(id), 'utf8'));
    if (settle(session)) await save(session);
    return session;
  } catch (error) {
    if (error.code === 'ENOENT') fail(404, 'Session not found.');
    throw error;
  }
}

function finishTasks(session, at = new Date().toISOString()) {
  session.tasks = session.todoDraft.split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(text => ({ id: randomUUID(), text, done: false }));
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
      await save(session);
      return send(res, 201, session);
    }
  }

  if (parts.length >= 3 && parts[1] === 'sessions') {
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
      return send(res, 200, session);
    }

    if (parts[3] === 'tasks' && parts.length === 5 && req.method === 'PATCH') {
      if (phase(session) !== 'checklist') fail(409, 'The checklist is not ready yet.');
      const { done } = await bodyJson(req);
      if (typeof done !== 'boolean') fail(400, 'Invalid task state.');
      const task = session.tasks.find(item => item.id === parts[4]);
      if (!task) fail(404, 'Task not found.');
      task.done = done;
      await save(session);
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

server.listen(port, '127.0.0.1', () => {
  console.log(`Yap Typer is open at http://127.0.0.1:${port}`);
  console.log(`Session files: ${dataDir}`);
});
