'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const { readConfig, createAdapter, createMcpServer, startStdio, MAX_BYTES } = require('../cloud/ai/mcp.cjs');

const id = 'a'.repeat(32);
const apiKey = 'b'.repeat(64);
const token = 'c'.repeat(64);
const env = { SCHEDULE_API_URL: 'https://example.app.workbuddy.host', SCHEDULE_PROJECT_ID: id, SCHEDULE_API_KEY: apiKey };
const record = { id, revision: 4, project: { tasks: [], groups: [], flags: [], meta: { title: 'Demo' } } };
const session = { token, displayName: 'AI助手', expiresAt: '2099-01-01T00:00:00Z' };
const defs = [
  { name: 'project.get', description: 'Read a schedule', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'task.update', description: 'Update a task', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false } },
  { name: 'presence.list', description: 'Read collaborators', inputSchema: { type: 'object' }, requiresAuth: true, annotations: { readOnlyHint: true } },
  { name: 'session.revoke', description: 'Revoke this session', inputSchema: { type: 'object' }, 'x-requiresRevision': false, annotations: { readOnlyHint: false } }
];
const catalog = { version: '2', tools: defs };
const ok = data => ({ ok: true, data });
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
function harness(handler, options = {}) {
  const calls = [];
  const adapter = createAdapter({
    env, ...options,
    fetchImpl: async (url, init) => {
      const call = { url, ...init, body: init.body ? JSON.parse(init.body) : null };
      calls.push(call);
      const custom = await handler?.(call);
      if (custom) return custom;
      if (url.endsWith('/api/tools')) return response(catalog);
      if (url.endsWith('/sessions/external')) return response(ok(session));
      return response(ok(record));
    }
  });
  return { adapter, calls };
}
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const initialize = (version = '2025-11-25') => request(0, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } });

test('successful session revocation clears the cache before a subsequent authorized operation', async () => {
  const { adapter, calls } = harness();
  await adapter.call('session.revoke', {});
  await adapter.call('presence.list', {});
  assert.equal(calls.filter(c => c.url.endsWith('/sessions/external')).length, 2);
});

test('a denied session invalidates the cache only for a subsequent caller-directed operation', async () => {
  let executions = 0;
  const { adapter, calls } = harness(c => {
    if (c.url.endsWith('/api/tools/call') && executions++ === 0) {
      return response({ ok: false, error: { code: 'SESSION_EXPIRED', message: 'Expired' } }, 401);
    }
  });
  const first = await adapter.call('task.update', { expectedRevision: 4 });
  assert.equal(first.ok, false);
  assert.equal(calls.filter(c => c.url.endsWith('/sessions/external')).length, 1);
  const second = await adapter.call('task.update', { expectedRevision: 4 });
  assert.equal(second.ok, true);
  assert.equal(calls.filter(c => c.url.endsWith('/sessions/external')).length, 2);
  assert.equal(executions, 2);
});

async function ready(adapter) {
  const server = createMcpServer({ adapter });
  await server.handle(initialize());
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return server;
}

test('configuration fixes a project and permits only safe origins', () => {
  assert.equal(readConfig(env).origin, env.SCHEDULE_API_URL);
  assert.equal(readConfig({ ...env, SCHEDULE_API_URL: 'http://127.0.0.1:3000' }).origin, 'http://127.0.0.1:3000');
  assert.equal(readConfig({ ...env, SCHEDULE_API_URL: 'http://[::1]:3000' }).origin, 'http://[::1]:3000');
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/api', 'https://example.com/?key=abc', 'https://example.com/#abc', 'file:///tmp/a']) {
    assert.throws(() => readConfig({ ...env, SCHEDULE_API_URL: url }), /SCHEDULE_API_URL/);
  }
  assert.throws(() => readConfig({}), /SCHEDULE_API_URL/);
  assert.throws(() => readConfig({ ...env, SCHEDULE_PROJECT_ID: 'bad' }), /SCHEDULE_PROJECT_ID/);
  assert.throws(() => readConfig({ ...env, SCHEDULE_API_KEY: 'bad' }), /SCHEDULE_API_KEY/);
  assert.throws(() => readConfig({ ...env, SCHEDULE_DISPLAY_NAME: '   ' }), /SCHEDULE_DISPLAY_NAME/);
  assert.equal(readConfig({ ...env, SCHEDULE_API_KEY: '' }).apiKey, '');
});

test('initialize negotiates pinned versions, requires initialized notification, and permits ping', async () => {
  for (const version of ['2025-11-25', '2025-06-18', '2024-11-05', '2099-01-01']) {
    const server = createMcpServer({ adapter: harness().adapter });
    assert.deepEqual((await server.handle(request(5, 'ping'))).result, {});
    assert.equal((await server.handle(request(1, 'tools/list'))).error.code, -32002);
    const init = await server.handle(initialize(version));
    assert.equal(init.result.protocolVersion, version === '2099-01-01' ? '2025-11-25' : version);
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    assert.equal((await server.handle(request(2, 'tools/list'))).error.code, -32002);
    assert.equal((await server.handle(initialize())).error.code, -32600);
    assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.equal((await server.handle(request(3, 'tools/list'))).result.tools.length, 4);
  }
});

test('catalog adds revision only to versioned writes and does not expose adapter-only fields', async () => {
  const { adapter } = harness();
  const tools = await adapter.list();
  const update = tools.find(t => t.name === 'task.update');
  assert.deepEqual(update.inputSchema.required, ['id', 'expectedRevision']);
  assert.equal(update.inputSchema.properties.expectedRevision.minimum, 1);
  assert.equal(tools[0].inputSchema.properties.expectedRevision, undefined);
  assert.equal(tools[3].inputSchema.properties, undefined);
  assert.equal(tools[2].requiresAuth, undefined);
  assert.equal(tools[1].requiresRevision, undefined);
  assert.deepEqual(defs[1].inputSchema.required, ['id']);
});

test('anonymous public reads never login and bind the configured board', async () => {
  const { adapter, calls } = harness(null, { env: { ...env, SCHEDULE_API_KEY: '' } });
  assert.deepEqual(await adapter.call('project.get', {}), ok(record));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, env.SCHEDULE_API_URL + '/api/tools/call');
  assert.deepEqual(calls[1].body, { name: 'project.get', arguments: {}, projectId: id });
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(calls[1].redirect, 'error');
  const denied = await adapter.call('task.update', { id: 'task1', expectedRevision: 4 }).catch(error => error);
  assert.equal(denied.code, 'API_KEY_REQUIRED');
  assert.equal(calls.length, 2);
  assert.equal((await adapter.call('project.get', { projectId: 'd'.repeat(32) })).error.code, 'INVALID_ARGUMENTS');
});

test('writes lazily authenticate, reuse token, and lift revision out of business arguments', async () => {
  const { adapter, calls } = harness();
  await adapter.call('task.update', { id: 'task1', expectedRevision: 4 });
  await adapter.call('task.update', { id: 'task1', expectedRevision: 5 });
  assert.equal(calls.filter(c => c.url.endsWith('/sessions/external')).length, 1);
  assert.deepEqual(calls[1].body, { apiKey, displayName: 'AI助手' });
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.deepEqual(calls[2].body, { name: 'task.update', arguments: { id: 'task1' }, projectId: id, expectedRevision: 4 });
  assert.equal(calls[2].headers.Authorization, 'Bearer ' + token);
});

test('authorized read and revision-free session tools authenticate without revision', async () => {
  const { adapter, calls } = harness();
  await adapter.call('presence.list', {});
  await adapter.call('session.revoke', {});
  assert.equal(calls[2].headers.Authorization, 'Bearer ' + token);
  assert.equal(calls[2].body.expectedRevision, undefined);
  assert.equal(calls[3].body.expectedRevision, undefined);
});

test('expired token refreshes before a new write, never after its failure', async () => {
  let clock = Date.parse('2026-01-01T00:00:00Z');
  let logins = 0;
  const { adapter, calls } = harness(call => {
    if (call.url.endsWith('/sessions/external')) {
      logins++;
      return response(ok({ ...session, expiresAt: new Date(clock + 60000).toISOString() }));
    }
  }, { now: () => clock });
  await adapter.call('task.update', { expectedRevision: 4 });
  clock += 60001;
  await adapter.call('task.update', { expectedRevision: 5 });
  assert.equal(logins, 2);
  assert.equal(calls.filter(c => c.url.endsWith('/api/tools/call')).length, 2);
});

test('missing/invalid revision blocks writes before login or execution', async () => {
  const { adapter, calls } = harness();
  for (const expectedRevision of [undefined, 0, -1, 1.2, '4', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await adapter.call('task.update', { expectedRevision })).error.code, 'INVALID_REVISION');
  }
  assert.equal(calls.length, 1);
});

test('conflicts and expired-session responses are never automatically retried', async () => {
  for (const [status, code] of [[409, 'CONFLICT'], [401, 'SESSION_EXPIRED'], [200, 'UNAUTHORIZED']]) {
    const body = { ok: false, error: { code, message: 'expected' }, latest: record };
    const { adapter, calls } = harness(c => c.url.endsWith('/api/tools/call') ? response(body, status) : null);
    assert.deepEqual(await adapter.call('task.update', { expectedRevision: 4 }), body);
    assert.equal(calls.filter(c => c.url.endsWith('/api/tools/call')).length, 1);
    assert.equal(calls.filter(c => c.url.endsWith('/sessions/external')).length, 1);
  }
});

test('authentication errors do not execute the tool and credentials are redacted from MCP responses', async () => {
  const { adapter, calls } = harness(c => c.url.endsWith('/sessions/external') ?
    response({ ok: false, error: { code: 'INVALID_API_KEY', message: apiKey } }, 401) : null);
  const server = await ready(adapter);
  const result = await server.handle(request(1, 'tools/call', { name: 'task.update', arguments: { expectedRevision: 4 } }));
  assert.equal(result.result.isError, true);
  assert.equal(JSON.stringify(result).includes(apiKey), false);
  assert.equal(calls.length, 2);
});

test('malformed sessions, catalogs, API results and oversized responses fail closed', async () => {
  const badCatalog = harness(c => c.url.endsWith('/api/tools') ? response({ version: '2', tools: [defs[0], defs[0]] }) : null);
  await assert.rejects(badCatalog.adapter.list(), /invalid or duplicate/);
  const badSession = harness(c => c.url.endsWith('/sessions/external') ? response(ok({ ...session, token: 'bad' })) : null);
  await assert.rejects(badSession.adapter.call('task.update', { expectedRevision: 1 }), /invalid or expired/);
  const badResult = harness(c => c.url.endsWith('/api/tools/call') ? response({ data: record }) : null);
  await assert.rejects(badResult.adapter.call('project.get', {}), /invalid result/);
  const bigHeader = harness(c => c.url.endsWith('/api/tools') ? response(catalog, 200, { 'Content-Length': String(MAX_BYTES + 1) }) : null);
  await assert.rejects(bigHeader.adapter.list(), /10 MiB/);
  const bigBody = harness(c => c.url.endsWith('/api/tools/call') ? response(ok('x'.repeat(MAX_BYTES + 1))) : null);
  await assert.rejects(bigBody.adapter.call('project.get', {}), /10 MiB/);
});

test('oversized requests are rejected without making an HTTP mutation', async () => {
  const { adapter, calls } = harness();
  await assert.rejects(adapter.call('task.update', { expectedRevision: 4, text: 'x'.repeat(MAX_BYTES) }), /request exceeds/);
  assert.equal(calls.filter(c => c.url.endsWith('/api/tools/call')).length, 0);
});

test('network failures and timeouts return execution errors without leaking details or repeating a write', async () => {
  const { adapter, calls } = harness(c => {
    if (c.url.endsWith('/api/tools/call')) throw new Error('private details ' + apiKey);
  });
  const server = await ready(adapter);
  const result = await server.handle(request(1, 'tools/call', { name: 'task.update', arguments: { expectedRevision: 4 } }));
  assert.equal(result.result.isError, true);
  assert.equal(JSON.parse(result.result.content[0].text).error.code, 'NETWORK_ERROR');
  assert.equal(JSON.stringify(result).includes('private details'), false);
  assert.equal(calls.filter(c => c.url.endsWith('/api/tools/call')).length, 1);

  const hanging = harness(c => c.url.endsWith('/api/tools/call') ? new Promise((resolve, reject) => {
    c.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) : null, { timeoutMs: 10 });
  const timer = setTimeout(() => {}, 100);
  try { await assert.rejects(hanging.adapter.call('project.get', {}), error => error.code === 'TIMEOUT'); }
  finally { clearTimeout(timer); }
});

test('MCP protocol errors, execution errors, and notifications have distinct behavior', async () => {
  const { adapter, calls } = harness();
  const server = await ready(adapter);
  assert.equal((await server.handle([])).error.code, -32600);
  assert.equal((await server.handle(request(null, 'ping'))).error.code, -32600);
  assert.equal((await server.handle(request(1, 'unknown'))).error.code, -32601);
  assert.equal((await server.handle(request(2, 'tools/list', { cursor: 'x' }))).error.code, -32602);
  assert.equal((await server.handle(request(3, 'tools/call', { name: 'not-a-tool' }))).error.code, -32602);
  assert.equal((await server.handle(request(4, 'tools/call', { name: 'project.get', arguments: [] }))).error.code, -32602);
  const invalidRevision = await server.handle(request(5, 'tools/call', { name: 'task.update', arguments: {} }));
  assert.equal(invalidRevision.result.isError, true);
  assert.equal(JSON.parse(invalidRevision.result.content[0].text).error.code, 'INVALID_REVISION');
  const before = calls.length;
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'task.update', arguments: { expectedRevision: 4 } } }), null);
  assert.equal(calls.length, before);
});

test('MCP cancellation aborts pending requests and ping remains responsive', async () => {
  let called;
  const started = new Promise(resolve => { called = resolve; });
  const { adapter } = harness(c => c.url.endsWith('/api/tools/call') ? new Promise((resolve, reject) => {
    called();
    c.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) : null);
  const server = await ready(adapter);
  const call = server.handle(request(7, 'tools/call', { name: 'project.get' }));
  await started;
  assert.deepEqual((await server.handle(request(8, 'ping'))).result, {});
  assert.equal((await server.handle(request(7, 'tools/list'))).error.code, -32600);
  await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
  const done = await call;
  assert.equal(JSON.parse(done.result.content[0].text).error.code, 'CANCELLED');
});

test('stdio frames fragmented UTF-8 and emits only newline-delimited protocol JSON', async () => {
  const input = new PassThrough(), output = new PassThrough(), stderr = new PassThrough();
  let text = '', errors = '';
  output.on('data', chunk => { text += chunk; });
  stderr.on('data', chunk => { errors += chunk; });
  const running = startStdio({ input, output, errorOutput: stderr, adapter: harness().adapter });
  const wire = Buffer.from(JSON.stringify(initialize()) + '\n' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n' +
    JSON.stringify(request('中文', 'tools/list')) + '\nnot-json\n' + JSON.stringify(request(4, 'ping')) + '\n');
  for (let i = 0; i < wire.length; i += 7) input.write(wire.subarray(i, i + 7));
  await new Promise(resolve => setTimeout(resolve, 20));
  const messages = text.trim().split('\n').map(JSON.parse);
  assert.equal(messages.length, 4);
  assert.equal(messages.find(m => m.id === '中文').result.tools.length, 4);
  assert.equal(messages.find(m => m.error)?.error.code, -32700);
  assert.equal(errors, '');
  running.close(); input.end();
});

test('CLI exits with a clear configuration error on stderr and no protocol pollution', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '../cloud/ai/mcp.cjs')], {
    env: { ...process.env, SCHEDULE_API_URL: '', SCHEDULE_PROJECT_ID: '', SCHEDULE_API_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /SCHEDULE_API_URL/);
});

test('real child stdio process reaches a loopback HTTP API and keeps login secrets out of tool results', async t => {
  const seen = [];
  const service = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
      seen.push({ url: req.url, authorization: req.headers.authorization, body });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/tools' ? catalog : req.url.endsWith('/sessions/external') ? ok(session) : ok(record)));
    });
  });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => service.close(resolve)));
  const child = spawn(process.execPath, [path.join(__dirname, '../cloud/ai/mcp.cjs')], {
    env: { ...process.env, ...env, SCHEDULE_API_URL: 'http://127.0.0.1:' + service.address().port }, stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  const replies = new Map(), waiters = new Map();
  let buffered = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const value = JSON.parse(buffered.slice(0, newline)); buffered = buffered.slice(newline + 1);
      replies.set(value.id, value); waiters.get(value.id)?.(value);
    }
  });
  const send = message => {
    child.stdin.write(JSON.stringify(message) + '\n');
    if (!Object.hasOwn(message, 'id')) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Child did not respond')), 3000);
      waiters.set(message.id, value => { clearTimeout(timer); resolve(value); });
      if (replies.has(message.id)) { clearTimeout(timer); resolve(replies.get(message.id)); }
    });
  };
  await send(initialize());
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const data = await send(request(1, 'tools/call', { name: 'task.update', arguments: { id: 'task1', expectedRevision: 4 } }));
  assert.equal(data.result.isError, false);
  assert.equal(JSON.parse(data.result.content[0].text).data.revision, 4);
  assert.equal(JSON.stringify(data).includes(token), false);
  assert.equal(seen.length, 3);
  assert.equal(seen[2].authorization, 'Bearer ' + token);
  assert.equal(seen[2].body.expectedRevision, 4);
  assert.equal(stderr, '');
  child.stdin.end();
});
