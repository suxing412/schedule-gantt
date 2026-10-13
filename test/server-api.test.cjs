'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server.js');

const SESSION_SECRET = 'api-test-session-secret-32-bytes-minimum';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function project(changes = {}) {
  return { tasks: [{ id: 'task-a', name: '第一项任务', s: '2026-10-09', e: '2026-10-12' }], ...changes };
}
function memoryStore() {
  const records = new Map();
  return {
    records,
    async get(id) { return clone(records.get(id)); },
    async create(record) {
      if (records.has(record.id)) return false;
      records.set(record.id, clone(record));
      return true;
    },
    async compareAndSwap(id, revision, next) {
      if (records.get(id)?.revision !== revision) return false;
      records.set(id, clone(next));
      return true;
    }
  };
}
async function harness(t, options = {}) {
  const store = options.store || memoryStore();
  const server = await createServer({ sessionSecret: SESSION_SECRET, storageDriver: 'file', ...options, store });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  async function request(route, options = {}) {
    const { json, ...init } = options;
    if (json !== undefined) {
      init.body = JSON.stringify(json);
      init.headers = { 'Content-Type': 'application/json', ...init.headers };
    }
    const response = await fetch(base + route, init);
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = undefined; }
    return { status: response.status, headers: response.headers, data, raw };
  }
  async function create(changes = {}) {
    const response = await request('/api/projects', { method: 'POST', json: {
      displayName: '策划甲', editCode: '1234', project: project(), ...changes
    } });
    assert.equal(response.status, 201, response.raw);
    return response.data;
  }
  async function login(id, changes = {}) {
    return request('/api/projects/' + id + '/session', { method: 'POST', json: {
      displayName: '程序乙', editCode: '1234', ...changes
    } });
  }
  async function put(record, nextProject, changes = {}) {
    return request('/api/projects/' + record.id, { method: 'PUT', headers: {
      Authorization: 'Bearer ' + record.session.token
    }, json: { baseRevision: record.revision, project: nextProject, ...changes } });
  }
  return { store, server, base, request, create, login, put };
}
function noSecrets(value) {
  const raw = JSON.stringify(value);
  assert.doesNotMatch(raw, /editCodeHash|scrypt\$|sessionSecret|\"editCode\"|\"token\"/);
}

test('two anonymous clients share a public project, while editors identify their changes', async t => {
  const api = await harness(t);
  const created = await api.create();
  assert.match(created.id, /^[a-f0-9]{32}$/);
  assert.equal(created.revision, 1);
  assert.equal(created.updatedBy, '策划甲');
  assert.equal(created.session.displayName, '策划甲');
  assert.ok(created.session.token);
  assert.ok(Date.parse(created.createdAt));
  const [readerA, readerB] = await Promise.all([
    api.request('/api/projects/' + created.id), api.request('/api/projects/' + created.id)
  ]);
  assert.equal(readerA.status, 200);
  assert.deepEqual(readerB.data, readerA.data);
  assert.equal(readerA.data.project.tasks[0].pid, null);
  assert.equal(readerA.data.project.tasks[0].pct, 0);
  assert.deepEqual(readerA.data.project.tasks[0].deps, []);
  noSecrets(readerA.data);
  const signedIn = await api.login(created.id);
  assert.equal(signedIn.status, 200, signedIn.raw);
  assert.equal(signedIn.data.displayName, '程序乙');
  const changed = project({ tasks: [{ ...project().tasks[0], name: '程序修改后的任务' }] });
  const saved = await api.put({ ...created, session: signedIn.data }, changed);
  assert.equal(saved.status, 200, saved.raw);
  assert.equal(saved.data.revision, 2);
  assert.equal(saved.data.updatedBy, '程序乙');
  noSecrets(saved.data);
  const refreshed = await api.request('/api/projects/' + created.id);
  assert.equal(refreshed.data.project.tasks[0].name, '程序修改后的任务');
  assert.equal(refreshed.data.revision, 2);
  assert.equal(api.store.records.get(created.id).editCode, undefined);
  assert.match(api.store.records.get(created.id).editCodeHash, /^scrypt\$/);
});

test('anonymous reads do not authorize writes and wrong edit codes do not issue sessions', async t => {
  const api = await harness(t), created = await api.create();
  const forbidden = await api.request('/api/projects/' + created.id, {
    method: 'PUT', json: { baseRevision: 1, project: project({ tasks: [] }) }
  });
  assert.equal(forbidden.status, 401);
  assert.equal((await api.login(created.id, { editCode: '0000' })).status, 401);
  assert.equal((await api.request('/api/projects/' + created.id)).data.revision, 1);
  noSecrets(forbidden.data);
});

test('invalid edit codes and missing display names are rejected before storing a project', async t => {
  const api = await harness(t);
  for (const changes of [{ editCode: '123' }, { editCode: '12345' }, { editCode: 'abcd' },
    { editCode: 1234 }, { displayName: '' }, { displayName: '   ' }]) {
    const response = await api.request('/api/projects', { method: 'POST', json: {
      displayName: '策划甲', editCode: '1234', project: project(), ...changes
    } });
    assert.equal(response.status, 400, response.raw);
  }
  assert.equal(api.store.records.size, 0);
});

test('incorrect codes are rate limited and the login window expires', async t => {
  let clock = Date.now();
  const api = await harness(t, { now: () => clock,
    rateLimits: { login: { limit: 2, windowMs: 1000 } } });
  const created = await api.create();
  assert.equal((await api.login(created.id, { editCode: '0000' })).status, 401);
  assert.equal((await api.login(created.id, { editCode: '0001' })).status, 401);
  const limited = await api.login(created.id);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  clock += 1001;
  assert.equal((await api.login(created.id)).status, 200);
});

test('expired, tampered and another board\'s session cannot edit', async t => {
  let clock = Date.now();
  const api = await harness(t, { now: () => clock, sessionTtlMs: 1000 });
  const boardA = await api.create(), boardB = await api.create();
  const token = boardA.session.token;
  const parts = token.split('.');
  const index = Math.floor(parts[parts.length - 1].length / 2);
  const signature = parts[parts.length - 1];
  parts[parts.length - 1] = signature.slice(0, index) +
    (signature[index] === 'A' ? 'B' : 'A') + signature.slice(index + 1);
  assert.equal((await api.put({ ...boardA, session: { token: parts.join('.') } }, project())).status, 401);
  assert.equal((await api.put({ ...boardB, session: boardA.session }, project())).status, 401);
  clock += 1001;
  assert.equal((await api.put(boardA, project())).status, 401);
  assert.equal(api.store.records.get(boardA.id).revision, 1);
  assert.equal(api.store.records.get(boardB.id).revision, 1);
});

test('shared records normalize business data and remove each client\'s layout and folds', async t => {
  const api = await harness(t);
  const input = project({ tasks: [{ id: 'old', name: '旧格式任务', start: '2026-10-09',
    end: '2026-10-12', assignee: '小王', group: '玩法策划GD', collapsed: true,
    customValues: { cf_hours: 16 } }], meta: {
      title: '十月版本', cols: { name: 360, person: 80 }, lw: 800, leftWidth: 800,
      paneAuto: false, layoutVersion: 2, nameAutoWidth: true,
      columnOrder: ['name', 'cf_hours', 'person'], hiddenColumns: ['pct'], defView: 'week',
      customFields: [{ id: 'cf_hours', name: '预计工时（小时）', type: 'number' }],
      roleColors: { '策划': '#abc' }
    } });
  const created = await api.create({ project: input });
  const stored = api.store.records.get(created.id).project;
  for (const p of [created.project, stored, (await api.request('/api/projects/' + created.id)).data.project]) {
    const task = p.tasks[0];
    assert.equal(task.s, '2026-10-09');
    assert.equal(task.e, '2026-10-12');
    assert.equal(task.who, '小王');
    assert.equal(task.grp, '策划');
    assert.equal(task.customValues.cf_hours, 16);
    assert.equal(p.meta.title, '十月版本');
    assert.equal(p.meta.customFields[0].name, '预计工时（小时）');
    assert.equal(p.meta.roleColors['策划'], '#aabbcc');
    for (const key of ['cols', 'lw', 'leftWidth', 'paneAuto', 'layoutVersion', 'nameAutoWidth',
      'columnOrder', 'hiddenColumns', 'defView']) assert.equal(Object.hasOwn(p.meta, key), false, key);
    assert.equal(Object.hasOwn(task, 'fold'), false);
    assert.equal(Object.hasOwn(task, 'collapsed'), false);
  }
});

test('unsafe or invalid project data cannot create a board or replace cloud data', async t => {
  const api = await harness(t), created = await api.create();
  const malicious = JSON.parse('{"tasks":[{"id":"task-a","name":"bad","s":"2026-10-09","e":"2026-10-12"}],"meta":{"__proto__":{"polluted":true}}}');
  const badInputs = [malicious,
    project({ tasks: [project().tasks[0], project().tasks[0]] }),
    project({ groups: [{ name: '策划', color: 'url(javascript:alert(1))' }] }),
    project({ tasks: [{ ...project().tasks[0], pid: 'missing-parent' }] })];
  for (const input of badInputs) {
    assert.equal((await api.put(created, input)).status, 400);
    const failedCreate = await api.request('/api/projects', { method: 'POST', json: {
      displayName: '策划甲', editCode: '1234', project: input
    } });
    assert.equal(failedCreate.status, 400, failedCreate.raw);
  }
  const unchanged = await api.request('/api/projects/' + created.id);
  assert.equal(unchanged.data.revision, 1);
  assert.equal(unchanged.data.project.tasks[0].name, '第一项任务');
  assert.equal(api.store.records.size, 1);
  assert.equal({}.polluted, undefined);
});

test('stale revisions return the latest public record without overwriting its project', async t => {
  const api = await harness(t), created = await api.create();
  const first = await api.put(created, project({ tasks: [{ ...project().tasks[0], name: '已保存的修改' }] }));
  assert.equal(first.status, 200);
  const stale = await api.put(created, project({ tasks: [] }));
  assert.equal(stale.status, 409, stale.raw);
  assert.deepEqual(stale.data.latest, first.data);
  noSecrets(stale.data);
  const current = await api.request('/api/projects/' + created.id);
  assert.deepEqual(current.data, first.data);
});

test('concurrent saves from the same base revision commit exactly once', async t => {
  const api = await harness(t), created = await api.create();
  const changes = ['编辑甲', '编辑乙'].map(name => project({ tasks: [{ ...project().tasks[0], name }] }));
  const results = await Promise.all(changes.map(change => api.put(created, change)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const committed = results.find(r => r.status === 200), conflict = results.find(r => r.status === 409);
  assert.equal(committed.data.revision, 2);
  assert.deepEqual(conflict.data.latest, committed.data);
  assert.deepEqual((await api.request('/api/projects/' + created.id)).data, committed.data);
});

test('invalid revision values are rejected and missing projects return public 404s', async t => {
  const api = await harness(t), created = await api.create();
  for (const baseRevision of [0, -1, '1', 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.equal((await api.put(created, project(), { baseRevision })).status, 400);
  }
  for (const id of ['missing', 'a'.repeat(32), '../server.js', 'a'.repeat(33)]) {
    const response = await api.request('/api/projects/' + id);
    assert.equal(response.status, 404);
    noSecrets(response.data);
  }
  assert.equal(api.store.records.get(created.id).revision, 1);
});

const rawHttp = require('node:http');
async function rawRequest(base, route, options = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = rawHttp.request({ hostname: url.hostname, port: url.port, path: route,
      method: options.method || 'GET', headers: options.headers || {} }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(raw); } catch { data = undefined; }
        resolve({ status: response.statusCode, headers: response.headers, raw, data });
      });
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
function staticFixture(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-server-api-test-'));
  assert.equal(path.dirname(rootDir), path.resolve(os.tmpdir()));
  assert.match(path.basename(rootDir), /^schedule-server-api-test-/);
  fs.mkdirSync(path.join(rootDir, 'frontend', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.git'));
  fs.writeFileSync(path.join(rootDir, 'index.html'),
    '<!doctype html><html><head><title>排期</title></head><body><script src="frontend/assets/app.js"></script></body></html>');
  fs.writeFileSync(path.join(rootDir, 'project-validation.js'), 'window.validationFixture=true;');
  fs.writeFileSync(path.join(rootDir, 'frontend', 'assets', 'app.js'), 'window.assetFixture=true;');
  fs.writeFileSync(path.join(rootDir, 'server.js'), 'PRIVATE_SOURCE_MARKER');
  fs.writeFileSync(path.join(rootDir, 'package.json'), 'PRIVATE_PACKAGE_MARKER');
  fs.writeFileSync(path.join(rootDir, '.git', 'config'), 'PRIVATE_GIT_MARKER');
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

test('the shared entry page receives runtime configuration and serves public assets and health', async t => {
  const api = await harness(t, { rootDir: staticFixture(t) });
  const health = await api.request('/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(health.data, { ok: true, mode: 'shared', storage: 'file' });
  const runtime = await api.request('/runtime-config.js');
  assert.equal(runtime.status, 200);
  assert.match(runtime.raw, /window\.SCHEDULE_RUNTIME=/);
  assert.match(runtime.raw, /"mode":"shared"/);
  assert.match(runtime.headers.get('content-type'), /javascript/);
  noSecrets(runtime.raw);
  for (const route of ['/', '/index.html', '/p/' + 'a'.repeat(32)]) {
    const page = await api.request(route);
    assert.equal(page.status, 200);
    assert.match(page.raw, /<base href="\/">/);
    assert.match(page.raw, /<script src="\/runtime-config\.js"><\/script>/);
    assert.ok(page.raw.indexOf('/runtime-config.js') < page.raw.indexOf('frontend/assets/app.js'));
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  }
  assert.equal((await api.request('/project-validation.js')).status, 200);
  assert.match((await api.request('/frontend/assets/app.js')).raw, /assetFixture/);
  const head = await api.request('/p/' + 'b'.repeat(32), { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.raw, '');
  assert.ok(Number(head.headers.get('content-length')) > 0);
});

test('the static whitelist never exposes source files, hidden files, directories or traversal', async t => {
  const api = await harness(t, { rootDir: staticFixture(t) });
  for (const route of ['/server.js', '/package.json', '/.git/config', '/frontend/assets/', '/p/invalid']) {
    const response = await rawRequest(api.base, route);
    assert.equal(response.status, 404, route + ': ' + response.raw);
    assert.doesNotMatch(response.raw, /PRIVATE_[A-Z]+_MARKER|assetFixture/);
  }
  // Send the raw request path: WHATWG URL clients normalize dot segments before sending them.
  for (const route of ['/frontend/assets/../../server.js', '/frontend/assets/%2e%2e%2f%2e%2e%2fserver.js',
    '/frontend/assets/%5c..%5cserver.js', '/frontend/assets/%00app.js', '/frontend/assets/%zz',
    '//server.js']) {
    const response = await rawRequest(api.base, route);
    assert.equal(response.status, 400, route + ': ' + response.raw);
    assert.doesNotMatch(response.raw, /PRIVATE_[A-Z]+_MARKER/);
  }
});

test('foreign origins cannot create, authenticate or write, while the configured origin is allowed', async t => {
  const api = await harness(t, { allowedOrigins: ['https://team.example'] });
  const json = { displayName: '策划甲', editCode: '1234', project: project() };
  const foreign = { Origin: 'https://other.example' };
  const deniedCreate = await api.request('/api/projects', { method: 'POST', headers: foreign, json });
  assert.equal(deniedCreate.status, 403);
  assert.equal(api.store.records.size, 0);
  const allowed = await api.request('/api/projects', { method: 'POST',
    headers: { Origin: 'https://team.example' }, json });
  assert.equal(allowed.status, 201, allowed.raw);
  const board = allowed.data;
  assert.equal((await api.request('/api/projects/' + board.id + '/session', {
    method: 'POST', headers: foreign, json
  })).status, 403);
  assert.equal((await api.request('/api/projects/' + board.id, { method: 'PUT',
    headers: { ...foreign, Authorization: 'Bearer ' + board.session.token },
    json: { baseRevision: 1, project: project({ tasks: [] }) }
  })).status, 403);
  assert.equal((await api.request('/api/projects', { method: 'POST',
    headers: { Origin: 'https://team.example', 'Sec-Fetch-Site': 'cross-site' }, json
  })).status, 403);
  assert.equal((await api.request('/api/projects/' + board.id)).data.revision, 1);
});

test('same-origin browser requests work without an explicit origin allowlist', async t => {
  const api = await harness(t);
  const response = await api.request('/api/projects', { method: 'POST', headers: { Origin: api.base },
    json: { displayName: '策划甲', editCode: '1234', project: project() } });
  assert.equal(response.status, 201, response.raw);
});

test('JSON content type, syntax and both declared and streamed body sizes are enforced', async t => {
  const api = await harness(t, { maxBodyBytes: 256 });
  const body = JSON.stringify({ displayName: '策划甲', editCode: '1234', project: project() });
  const wrongType = await api.request('/api/projects', { method: 'POST',
    headers: { 'Content-Type': 'text/plain' }, body });
  assert.equal(wrongType.status, 415);
  const malformed = await api.request('/api/projects', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: '{broken-json' });
  assert.equal(malformed.status, 400);
  const tooLarge = JSON.stringify({ padding: 'x'.repeat(300) });
  const declared = await api.request('/api/projects', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: tooLarge });
  assert.equal(declared.status, 413);
  const streamed = await rawRequest(api.base, '/api/projects', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: tooLarge });
  assert.equal(streamed.status, 413);
  assert.equal(api.store.records.size, 0);
});

test('unknown projects cannot fill the login buckets needed by a real project', async t => {
  const api = await harness(t, { rateLimits: { login: { limit: 5, windowMs: 900000, maxKeys: 2 } } });
  const board = await api.create();
  assert.equal((await api.login('1'.repeat(32))).status, 404);
  assert.equal((await api.login('2'.repeat(32))).status, 404);
  assert.equal((await api.login(board.id)).status, 200);
});

test('production refuses missing cloud storage or signing configuration', async () => {
  await assert.rejects(createServer({ env: { NODE_ENV: 'production' } }), /STORAGE_DRIVER=external/);
  await assert.rejects(createServer({ env: { NODE_ENV: 'production', STORAGE_DRIVER: 'external',
    SESSION_SECRET } }), /STORAGE_ADAPTER_MODULE/);
  await assert.rejects(createServer({ env: { NODE_ENV: 'production', STORAGE_DRIVER: 'external',
    STORAGE_ADAPTER_MODULE: path.join(__dirname, 'missing-cloud-adapter.cjs') } }), /SESSION_SECRET/);
  await assert.rejects(createServer({ env: { NODE_ENV: 'production', STORAGE_DRIVER: 'external',
    STORAGE_ADAPTER_MODULE: path.join(__dirname, 'missing-cloud-adapter.cjs'), SESSION_SECRET: 'short' } }), /SESSION_SECRET/);
});
