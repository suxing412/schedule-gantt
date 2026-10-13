'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {createToolHandler} = require('../cloud/ai/http.cjs');
const {operationDefinitions} = require('../cloud/ai/operations.cjs');
const ID = 'a'.repeat(32), TOKEN = 'b'.repeat(64), KEY = 'c'.repeat(64);
const project = {tasks: [{id: 't1', name: '任务', type: 'task', pid: null, s: '2026-10-12', e: '2026-10-16', pct: 0, who: '苏省', grp: '', phase: '', deps: [], customValues: {}}], groups: [], flags: [], meta: {title: '测试排期'}};
const record = (revision = 1) => ({id: ID, revision, project: structuredClone(project), createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z', updatedBy: '测试', source: 'human'});
const session = () => ({token: TOKEN, displayName: 'AI助手', expiresAt: '2026-10-13T00:00:00Z', source: 'external'});
const good = data => new Response(JSON.stringify({ok: true, data}), {status: 200, headers: {'content-type': 'application/json'}});
const bad = (code, extra = {}) => new Response(JSON.stringify({ok: false, error: {code, message: 'PRIVATE_ERROR_SECRET', ...(extra.retryAfter ? {retryAfter: extra.retryAfter} : {})}, ...extra}), {status: 200});
async function harness(t, handler = () => good(record()), options = {}) {
  const calls = [];
  const api = createToolHandler({endpoint: 'https://test.app.workbuddy.host', publishableKey: 'wbpk_test', fetchImpl: async (url, init) => {
    const call = {url, ...init, body: JSON.parse(init.body)}; calls.push(call);
    return handler(call);
  }, ...options});
  const server = http.createServer(async (req, res) => {
    if (!await api(req, res, new URL(req.url, 'http://local.invalid').pathname)) { res.statusCode = 418; res.end('not handled'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = async (path, data, extra = {}) => {
    const response = await fetch(base + path, {method: data === undefined ? 'GET' : 'POST', ...(data === undefined ? {} : {body: typeof data === 'string' ? data : JSON.stringify(data)}), ...extra, headers: {'content-type': 'application/json', ...extra.headers}});
    const text = await response.text(); let parsed;
    try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
    return {status: response.status, headers: response.headers, data: parsed, text};
  };
  const call = (name, args = {}, extra = {}) => request('/api/tools/call', {name, arguments: args, projectId: ID, ...extra});
  return {calls, request, call, base};
}

test('catalog and OpenAPI remain readable without cloud config; every shared mutation has schema and CAS metadata', async t => {
  const h = await harness(t, undefined, {endpoint: '', publishableKey: ''});
  const list = await h.request('/api/tools');
  assert.equal(list.status, 200); assert.equal(list.data.version, '2');
  const tools = list.data.tools;
  assert.equal(new Set(tools.map(d => d.name)).size, tools.length);
  for (const d of operationDefinitions) {
    const tool = tools.find(t => t.name === d.name);
    assert.deepEqual(tool.inputSchema, d.inputSchema); assert.equal(tool.annotations.readOnlyHint, false); assert.equal(tool['x-requiresRevision'], true);
  }
  assert.equal(tools.find(d => d.name === 'presence.list').requiresAuth, true);
  assert.equal(tools.find(d => d.name === 'presence.heartbeat')['x-requiresRevision'], false);
  assert.ok(!tools.some(d => /create_project|reset_api_key|api.key.reset/.test(d.name)));
  const spec = await h.request('/api/openapi.json');
  assert.equal(spec.data.openapi, '3.1.1');
  assert.equal(spec.data.paths['/api/projects'].post['x-credential'], 'human');
  const help = await h.request('/llms.txt'); assert.match(help.text, /expectedRevision/);
  const unconfigured = await h.request('/api/projects/' + ID);
  assert.equal(unconfigured.status, 503); assert.equal(unconfigured.data.error.code, 'CLOUD_CONFIG_MISSING'); assert.equal(h.calls.length, 0);
});

test('only documented API paths are handled; GET does not enumerate projects and unsupported methods have Allow', async t => {
  const h = await harness(t);
  assert.equal((await h.request('/')).status, 418);
  assert.equal((await h.request('/api/projects')).status, 404);
  assert.equal((await h.request('/api/nope')).status, 404);
  const wrong = await h.request('/api/tools', {});
  assert.equal(wrong.status, 405); assert.equal(wrong.headers.get('allow'), 'GET, HEAD');
  const options = await h.request('/api/tools/call', undefined, {method: 'OPTIONS', headers: {origin: 'https://evil.invalid'}});
  assert.equal(options.status, 405); assert.equal(options.headers.get('access-control-allow-origin'), null);
  assert.equal(h.calls.length, 0);
});

test('GET forwards exact RPC and publishable key only; returned private metadata is discarded', async t => {
  const h = await harness(t, () => good({...record(), edit_code_hash: 'PRIVATE_HASH', apiKey: 'PRIVATE_KEY', session: session()}));
  const result = await h.request('/api/projects/' + ID, undefined, {headers: {host: 'attacker.invalid', origin: 'https://attacker.invalid', authorization: 'Bearer ' + TOKEN}});
  assert.equal(result.status, 200);
  assert.equal(result.data.data.id, ID);
  assert.ok(!result.text.includes('PRIVATE_')); assert.ok(!result.text.includes(TOKEN));
  assert.equal(h.calls[0].url, 'https://test.app.workbuddy.host/.cloud/database/rest/rpc/schedule_get_project');
  assert.deepEqual(h.calls[0].body, {p_id: ID});
  assert.deepEqual(h.calls[0].headers, {'content-type': 'application/json', accept: 'application/json', 'x-wb-webapp-access-key': 'wbpk_test'});
  assert.equal(h.calls[0].redirect, 'error');
});

test('export is directly importable JSON and personal view state is removed', async t => {
  const current = record(); current.project.meta.cols = {name: 700}; current.project.tasks[0].fold = true;
  const h = await harness(t, () => good(current));
  const result = await h.request('/api/projects/' + ID + '/export');
  assert.equal(result.status, 200); assert.equal(result.data.meta.title, project.meta.title);
  assert.equal(result.data.ok, undefined); assert.equal(result.data.meta.cols, undefined); assert.equal(result.data.tasks[0].fold, undefined);
  assert.match(result.headers.get('content-disposition'), /attachment; filename="schedule-/);
});

test('external key exchange is the only AI login and sanitizes session', async t => {
  const h = await harness(t, () => good({...session(), api_key_hash: 'PRIVATE_HASH', internalId: 'PRIVATE_ID'}));
  const result = await h.request('/api/projects/' + ID + '/sessions/external', {apiKey: KEY, displayName: 'AI助手'});
  assert.equal(result.status, 200); assert.deepEqual(result.data.data, session());
  assert.deepEqual(h.calls[0].body, {p_id: ID, p_api_key: KEY, p_display_name: 'AI助手'});
  assert.match(h.calls[0].url, /schedule_unlock_external$/);
  assert.ok(!result.text.includes(KEY)); assert.ok(!result.text.includes('PRIVATE_'));
  assert.equal((await h.request('/api/projects/' + ID + '/sessions/external', {editCode: '1234'})).status, 400);
});

test('missing auth, missing revision, unknown names/args and invalid nested mutation types never reach RPC', async t => {
  const h = await harness(t);
  const data = {name: 'project.update', arguments: {patch: {title: 'next'}}, projectId: ID};
  assert.equal((await h.request('/api/tools/call', data)).status, 400);
  assert.equal((await h.request('/api/tools/call', {...data, expectedRevision: 1})).status, 401);
  assert.equal((await h.call('some.rpc', {})).status, 400);
  assert.equal((await h.call('task.update', {id: 't1', patch: {pct: '1'}}, {expectedRevision: 1})).status, 400);
  assert.equal((await h.call('task.list', {token: TOKEN})).status, 400);
  assert.equal((await h.call('task.list', {}, {expectedRevision: 1})).status, 400);
  assert.equal((await h.call('project.preview', {operations: [{name: 'project.update', arguments: {patch: {title: 'new'}, secret: true}}]})).status, 400);
  assert.equal(h.calls.length, 0);
});

test('mutations send the original expected revision and action to trusted RPC exactly once', async t => {
  const h = await harness(t, () => good({...record(2), changed: true, results: [{index: 0, name: 'project.update', affectedIds: []}], privateKey: 'SECRET'}));
  const action = {name: 'project.update', arguments: {patch: {title: 'next'}}, projectId: ID, expectedRevision: 1};
  const result = await h.request('/api/tools/call', action, {headers: {authorization: 'Bearer ' + TOKEN}});
  assert.equal(result.status, 200); assert.equal(result.data.data.record.revision, 2);
  assert.equal(result.data.data.changed, true); assert.equal(result.data.data.results.length, 1); assert.ok(!result.text.includes('SECRET'));
  assert.deepEqual(h.calls[0].body, {p_id: ID, p_token: TOKEN, p_expected_revision: 1, p_action: {name: action.name, arguments: action.arguments}});
  assert.equal(h.calls.length, 1);
});

test('HTTP 200 business conflict becomes HTTP 409, preserves sanitized latest, and never retries', async t => {
  const h = await harness(t, () => bad('REVISION_CONFLICT', {latest: {...record(5), editCodeHash: 'PRIVATE_HASH', token: TOKEN}}));
  const result = await h.request('/api/tools/call', {name: 'project.update', arguments: {patch: {title: 'next'}}, projectId: ID, expectedRevision: 1}, {headers: {authorization: 'Bearer ' + TOKEN}});
  assert.equal(result.status, 409); assert.equal(result.data.latest.revision, 5);
  assert.ok(!result.text.includes('PRIVATE_')); assert.ok(!result.text.includes(TOKEN)); assert.equal(h.calls.length, 1);
});

test('business errors retain safe HTTP statuses and retry hints without reflecting upstream SQL text', async t => {
  for (const [code, status] of [['INVALID_API_KEY', 401], ['SESSION_EXPIRED', 401], ['NOT_FOUND', 404], ['RATE_LIMITED', 429], ['VALIDATION_ERROR', 400]]) {
    const h = await harness(t, () => bad(code, {retryAfter: 8}));
    const result = await h.request('/api/projects/' + ID);
    assert.equal(result.status, status); assert.equal(result.data.error.code, code); assert.ok(!result.text.includes('PRIVATE_'));
    assert.equal(result.headers.get('retry-after'), '8');
  }
});

test('project.preview reads and applies canonical actions locally without a write', async t => {
  const h = await harness(t);
  const result = await h.call('project.preview', {operations: [{name: 'project.update', arguments: {patch: {title: '预览标题'}}}]});
  assert.equal(result.status, 200); assert.equal(result.data.data.baseRevision, 1);
  assert.equal(result.data.data.project.meta.title, '预览标题'); assert.equal(result.data.data.changed, true);
  assert.equal(h.calls.length, 1); assert.match(h.calls[0].url, /schedule_get_project$/);
  assert.equal(project.meta.title, '测试排期');
});

test('project.batch maps to one atomic action RPC and rejects nested or overlong batches', async t => {
  const h = await harness(t, () => good({...record(2), results: [], changed: true}));
  const operations = [{name: 'project.update', arguments: {patch: {title: '改名'}}}, {name: 'task.shift', arguments: {ids: ['t1'], days: 1}}];
  const result = await h.request('/api/tools/call', {name: 'project.batch', arguments: {operations}, projectId: ID, expectedRevision: 1}, {headers: {authorization: 'Bearer ' + TOKEN}});
  assert.equal(result.status, 200); assert.deepEqual(h.calls[0].body.p_action, {operations}); assert.equal(h.calls.length, 1);
  assert.equal((await h.call('project.preview', {operations: [{name: 'project.batch', arguments: {operations}}]})).status, 400);
  assert.equal((await h.call('project.preview', {operations: Array(101).fill(operations[0])})).status, 400);
});

test('all read tools can use anonymous public reads and return domain data', async t => {
  const h = await harness(t);
  const result = await h.call('task.list');
  assert.equal(result.status, 200); assert.equal(result.data.data.total, 1); assert.equal(result.data.data.items[0].id, 't1');
  assert.equal(h.calls[0].body.p_token, undefined);
  assert.equal((await h.call('task.get', {id: 'missing'})).status, 404);
});

test('presence requires a session even for reads; presence payload contains only public display fields', async t => {
  const presence = {members: [{displayName: 'AI助手', lastSeenAt: '2026-10-12T00:00:00Z', online: true, source: 'external', token: TOKEN, secret: KEY}], onlineThresholdSeconds: 60, sessions: [session()]};
  const h = await harness(t, () => good(presence));
  assert.equal((await h.call('presence.list')).status, 401); assert.equal(h.calls.length, 0);
  for (const name of ['presence.list', 'presence.heartbeat']) {
    const result = await h.request('/api/tools/call', {name, arguments: {}, projectId: ID}, {headers: {authorization: 'Bearer ' + TOKEN}});
    assert.equal(result.status, 200); assert.equal(result.data.data.members.length, 1);
    assert.ok(!result.text.includes(TOKEN)); assert.ok(!result.text.includes(KEY)); assert.equal(result.data.data.sessions, undefined);
  }
  assert.deepEqual(h.calls.map(c => c.url.split('/').pop()), ['schedule_list_presence', 'schedule_heartbeat']);
});

test('logout REST and session tool both revoke only the bearer session without requiring a revision', async t => {
  const h = await harness(t, () => good({revoked: true, leaked: KEY}));
  const first = await h.request('/api/projects/' + ID + '/session', undefined, {method: 'DELETE', headers: {authorization: 'Bearer ' + TOKEN}});
  assert.deepEqual(first.data.data, {revoked: true});
  const second = await h.request('/api/tools/call', {name: 'session.revoke', arguments: {}, projectId: ID}, {headers: {authorization: 'Bearer ' + TOKEN}});
  assert.deepEqual(second.data.data, {revoked: true}); assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[0].body, {p_id: ID, p_token: TOKEN});
});

test('explicit human create/reset REST endpoints validate PIN and return one-time API key without hashes', async t => {
  const h = await harness(t, call => call.url.endsWith('schedule_create_project') ? good({...record(), id: call.body.p_id, session: {...session(), source: 'human'}, apiKey: KEY, apiKeyHash: 'PRIVATE_HASH'}) : good({apiKey: KEY, hash: 'PRIVATE_HASH'}));
  const created = await h.request('/api/projects', {editCode: '0042', displayName: '创建人', project});
  assert.equal(created.status, 200); assert.match(created.data.data.id, /^[a-f0-9]{32}$/); assert.equal(created.data.data.apiKey, KEY); assert.ok(!created.text.includes('PRIVATE_HASH'));
  const reset = await h.request('/api/projects/' + ID + '/api-key/reset', {editCode: '0042'});
  assert.deepEqual(reset.data.data, {apiKey: KEY});
  assert.deepEqual(h.calls[1].body, {p_id: ID, p_edit_code: '0042'});
  assert.equal((await h.request('/api/projects/' + ID + '/api-key/reset', {editCode: 42})).status, 400);
});

test('prototype keys, unknown properties, URL secrets, browser cross-site writes and non-JSON bodies are rejected', async t => {
  const h = await harness(t);
  const polluted = '{"name":"task.list","arguments":{"__proto__":{"polluted":true}},"projectId":"' + ID + '"}';
  assert.equal((await h.request('/api/tools/call', polluted)).status, 400); assert.equal({}.polluted, undefined);
  assert.equal((await h.request('/api/tools/call', {name: 'task.list', arguments: {}, projectId: ID, endpoint: 'https://evil.invalid'})).status, 400);
  assert.equal((await h.request('/api/projects/' + ID + '?apiKey=' + KEY)).status, 400);
  assert.equal((await h.request('/api/tools/call', {}, {headers: {'sec-fetch-site': 'cross-site'}})).status, 403);
  assert.equal((await h.request('/api/tools/call', '{}', {headers: {'content-type': 'text/plain'}})).status, 415);
  assert.equal(h.calls.length, 0);
});

test('request bodies are bounded at 10 MiB before parsing', async t => {
  const h = await harness(t);
  const result = await h.request('/api/tools/call', '{"padding":"' + 'x'.repeat(10 * 1024 * 1024) + '"}');
  assert.equal(result.status, 413); assert.equal(h.calls.length, 0);
});

test('untrusted upstream record identity and malformed response cannot leak through successful status', async t => {
  for (const result of [good({...record(), id: 'd'.repeat(32)}), new Response('{"error":"SQL PRIVATE_HASH"}', {status: 200}), good({...record(), revision: '1'})]) {
    const h = await harness(t, () => result);
    const response = await h.request('/api/projects/' + ID);
    assert.equal(response.status, 503); assert.equal(response.data.error.code, 'UPSTREAM_INVALID_RESPONSE');
    assert.ok(!response.text.includes('PRIVATE_HASH'));
  }
});

test('network errors and timeouts never trigger automatic write retry and never expose credential-bearing errors', async t => {
  for (const mode of ['network', 'timeout']) {
    const h = await harness(t, async call => {
      if (mode === 'network') throw new Error('secret ' + KEY);
      await new Promise((resolve, reject) => call.signal.addEventListener('abort', () => reject(new Error('secret ' + KEY)), {once: true}));
    }, {timeoutMs: 20});
    const result = await h.request('/api/tools/call', {name: 'project.update', arguments: {patch: {title: 'next'}}, projectId: ID, expectedRevision: 1}, {headers: {authorization: 'Bearer ' + TOKEN}});
    assert.equal(result.status, 503); assert.equal(h.calls.length, 1); assert.ok(!result.text.includes(KEY));
    assert.equal(result.data.error.code, mode === 'network' ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_TIMEOUT');
  }
});

test('invalid or absent trusted endpoint cannot be replaced by Host or Origin', async t => {
  for (const endpoint of ['', 'http://evil.invalid', 'https://user:pass@example.test', 'https://example.test/?apiKey=secret', 'https://example.test/nested']) {
    const h = await harness(t, undefined, {endpoint});
    const result = await h.request('/api/projects/' + ID, undefined, {headers: {host: 'test.app.workbuddy.host', origin: 'https://test.app.workbuddy.host'}});
    assert.equal(result.status, 503); assert.equal(h.calls.length, 0);
  }
});

test('HEAD returns headers only, and tool schemas do not reveal runtime public key or tokens', async t => {
  const h = await harness(t);
  const result = await h.request('/api/tools', undefined, {method: 'HEAD'});
  assert.equal(result.status, 200); assert.equal(result.text, ''); assert.ok(Number(result.headers.get('content-length')) > 100);
  const spec = await h.request('/api/openapi.json');
  assert.ok(!spec.text.includes('wbpk_test')); assert.ok(!spec.text.includes(KEY)); assert.ok(!spec.text.includes(TOKEN));
});

test('expensive public analysis has an additional per-process request budget', async t => {
  const h = await harness(t);
  for (let n = 0; n < 20; n++) assert.equal((await h.call('project.analyze')).status, 200);
  const limited = await h.call('project.analyze');
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(h.calls.length, 20);
});

test('preview and analysis share the same budget and at most two heavy requests can be in flight', async t => {
  let ready; const twoStarted = new Promise(resolve => { ready = resolve; });
  const releases = [];
  const h = await harness(t, () => new Promise(resolve => {
    releases.push(() => resolve(good(record())));
    if (releases.length === 2) ready();
  }));
  const previewArgs = {operations: [{name: 'project.update', arguments: {patch: {title: 'preview'}}}]};
  const first = h.call('project.preview', previewArgs), second = h.call('project.analyze');
  await twoStarted;
  assert.equal((await h.request('/api/tools')).status, 200);
  const blocked = await h.call('project.preview', previewArgs);
  assert.equal(blocked.status, 429); assert.equal(h.calls.length, 2);
  releases.forEach(release => release());
  assert.equal((await first).status, 200); assert.equal((await second).status, 200);
});

test('batch errors retain only a bounded operation index, both for RPC and local preview', async t => {
  const h = await harness(t, () => bad('ITEM_NOT_FOUND', {operationIndex: 1, sql: 'PRIVATE_SQL'}));
  const result = await h.request('/api/tools/call', {name: 'task.remove', arguments: {ids: ['missing']}, projectId: ID, expectedRevision: 1}, {headers: {authorization: 'Bearer ' + TOKEN}});
  assert.equal(result.status, 404); assert.equal(result.data.operationIndex, 1); assert.ok(!result.text.includes('PRIVATE_'));
  const preview = await harness(t);
  const failed = await preview.call('project.preview', {operations: [{name: 'project.update', arguments: {patch: {title: 'x'}}}, {name: 'task.remove', arguments: {ids: ['missing']}}]});
  assert.equal(failed.status, 404); assert.equal(failed.data.operationIndex, 1);
});

test('action responses require explicit results and changed so clients never infer a successful write', async t => {
  const h = await harness(t, () => good(record(2)));
  const result = await h.request('/api/tools/call', {name: 'project.update', arguments: {patch: {title: 'next'}}, projectId: ID, expectedRevision: 1}, {headers: {authorization: 'Bearer ' + TOKEN}});
  assert.equal(result.status, 503); assert.equal(result.data.error.code, 'UPSTREAM_INVALID_RESPONSE');
});

test('OpenAPI describes action record wrapper and validates UTF-16 length consistently with project contract', async t => {
  const h = await harness(t);
  const spec = await h.request('/api/openapi.json');
  assert.deepEqual(spec.data.components.schemas.ActionResult.required, ['record', 'results', 'changed']);
  const nameTooLong = await h.request('/api/projects/' + ID + '/sessions/external', {apiKey: KEY, displayName: '😀'.repeat(33)});
  assert.equal(nameTooLong.status, 400); assert.equal(h.calls.length, 0);
});
