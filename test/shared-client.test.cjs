'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

const root = path.resolve(__dirname, '..');
const projectId = 'a'.repeat(32);
const otherProjectId = 'b'.repeat(32);
const clone = value => JSON.parse(JSON.stringify(value));

function project(name = 'shared task') {
  return {
    tasks: [{id: 't1', name, pid: null, type: 'task', s: '2026-10-10', e: '2026-10-12', pct: 0, who: '', grp: '策划', deps: [], fold: true, customValues: {cf_note: 'keep this'}}],
    groups: [{name: '策划', color: '#2f6fe8'}], flags: [],
    meta: {
      title: 'Shared project', lw: 640, cols: {name: 280, person: 104}, paneAuto: false,
      layoutVersion: 2, nameAutoWidth: false, columnOrder: ['name', 'person', 'cf_note'],
      hiddenColumns: ['grp', 'phase'], defView: 'month',
      customFields: [{id: 'cf_note', name: '备注', type: 'text'}],
    },
  };
}

function record(revision = 1, name = 'shared task', id = projectId) {
  return {id, revision, project: project(name), createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', updatedBy: 'Editor'};
}

function response(status, body) {
  return {ok: status >= 200 && status < 300, status, json: async () => clone(body), text: async () => JSON.stringify(body)};
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function storageArea(map = new Map()) {
  return {
    get length() { return map.size; }, key: index => [...map.keys()][index] || null,
    getItem: key => map.has(String(key)) ? map.get(String(key)) : null,
    setItem: (key, value) => map.set(String(key), String(value)),
    removeItem: key => map.delete(String(key)), clear: () => map.clear(), map,
  };
}

function element(id = '') {
  const classes = new Set(), attributes = new Map(), listeners = new Map();
  return {
    id, hidden: true, disabled: false, value: '', textContent: '', title: '', dataset: {}, children: [],
    style: {setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; }},
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle(name, force) { const enabled = force === undefined ? !classes.has(name) : force; if (enabled) classes.add(name); else classes.delete(name); return enabled; },
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: name => attributes.get(name) || null, removeAttribute: name => attributes.delete(name),
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(callback); },
    async dispatch(name,event={}) { for(const callback of listeners.get(name)||[])await callback({target:this,currentTarget:this,preventDefault(){},stopPropagation(){},stopImmediatePropagation(){},...event}); },
    removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
    focus() {}, click() {}, contains() { return false; }, closest() { return null; },
  };
}

function harness(options = {}) {
  const localStorage = storageArea(options.local), sessionStorage = storageArea(options.session);
  if (options.localFailure) localStorage.setItem = () => { throw Object.assign(new Error('Storage quota exceeded'), {name: 'QuotaExceededError'}); };
  const calls = [], applied = [], messages = [], events = new Map(), timers = new Map(), timerDelays = new Map(), nodes = new Map(), dispatched = [], downloads = [], blobs = [];
  let timerId = 0, sampleCalls = 0, renderCalls = 0, bindCalls = 0, shellBindCalls = 0;
  const location = new URL(options.url || `http://127.0.0.1:5173/p/${projectId}`);
  const doc = {
    body: element('body'), documentElement: element('html'), activeElement: null, hidden: false, visibilityState: 'visible',
    querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, element(selector)); return nodes.get(selector); },
    querySelectorAll() { return []; }, createElement: name => element(name), getElementById: id => doc.querySelector('#' + id),
    addEventListener(name, callback) { if (!events.has('document:' + name)) events.set('document:' + name, []); events.get('document:' + name).push(callback); },
  };
  if (options.markupMode) doc.documentElement.dataset.scheduleMode = options.markupMode;
  class BrowserURL extends URL {}
  BrowserURL.createObjectURL = blob => { blobs.push(blob); return 'blob:shared-client-test-' + blobs.length; };
  BrowserURL.revokeObjectURL = () => {};
  const addEventListener = (name, callback) => { if (!events.has(name)) events.set(name, []); events.get(name).push(callback); };
  const setTimer = (callback,delay) => { const id = ++timerId; timers.set(id, callback); timerDelays.set(id,delay); return id; };
  const window = {
    SCHEDULE_RUNTIME: options.runtimeMissing ? undefined : options.runtime || {mode: options.mode || 'shared'}, location,
    WorkBuddyTransport: options.transportFactory ? {create: options.transportFactory} : undefined,
    crypto: webcrypto,
    history: {replaceState(_state, _title, url) { location.href = new URL(url, location.href).href; }, pushState(_state, _title, url) { location.href = new URL(url, location.href).href; }},
    addEventListener, removeEventListener() {}, dispatchEvent(event) { dispatched.push(event); for (const callback of events.get(event.type) || []) callback(event); },
  };
  const context = vm.createContext({
    window, document: doc, location, history: window.history, localStorage, sessionStorage,
    URL: BrowserURL, URLSearchParams, TextEncoder, AbortController, console, Blob,
    navigator: {clipboard: {writeText: async () => {}}},
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    fetch: async (url, init = {}) => {
      const call = {url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined};
      calls.push(call);
      if (!options.fetch) throw new Error('Unexpected fetch: ' + call.method + ' ' + call.url);
      const result = await options.fetch(call, calls.length);
      return {...result, json: async () => vm.runInContext('JSON.parse(' + JSON.stringify(JSON.stringify(await result.json())) + ')', context)};
    },
    setTimeout: setTimer, clearTimeout: id => timers.delete(id), setInterval: setTimer, clearInterval: id => timers.delete(id),
    requestAnimationFrame: callback => setTimer(callback), cancelAnimationFrame: id => timers.delete(id),
    proj: null, GROUPS: [], dragging: false, saveT: null, hist: [], histI: -1, selId: null, selIds: new Set(), filterQ: '', filterGrp: null, filterPhase: null, zoom: 'week', workspaceStarted: true,
    $: selector => doc.querySelector(selector),
    sample() { sampleCalls++; return vm.runInContext('JSON.parse(' + JSON.stringify(JSON.stringify(project('sample'))) + ')', context); },
    applyProject(value) { context.proj = vm.runInContext('JSON.parse(' + JSON.stringify(JSON.stringify(value)) + ')', context); applied.push(clone(value)); return true; },
    render() { renderCalls++; }, ensureFill() {}, goToday() {}, applyColWidths() {}, applyPaneLayout() {}, updUndoBtns() {},
    bindUI() { bindCalls++; }, WorkspaceShell: {bind() { shellBindCalls++; }, prepareLayout() {}},
    ce(tag,cls,text) { const node = element(tag); if(cls)node.classList.add(...cls.split(' '));if(text!==undefined&&text!==null)node.textContent=text;node.click = () => downloads.push({download: node.download, href: node.href}); return node; },
    snap() { const state = JSON.stringify(context.proj); context.hist.push(state); context.histI = context.hist.length - 1; },
    anyOvlOpen: () => !!options.modal,
    toast: (...args) => messages.push(args), flash() {},
    getComputedStyle: () => ({getPropertyValue: () => '576px'}),
  });
  window.document = doc; window.localStorage = localStorage; window.sessionStorage = sessionStorage;
  vm.runInContext(fs.readFileSync(path.join(root, 'project-validation.js'), 'utf8'), context, {filename: 'project-validation.js'});
  if(options.sdkRpc){
    window.WorkBuddyCloud={createWorkBuddyCloud:()=>({database:{rpc:options.sdkRpc}})};
    vm.runInContext(fs.readFileSync(path.join(root,'frontend/scripts/cloud-transport.js'),'utf8'),context,{filename:'frontend/scripts/cloud-transport.js'});
  }
  let sharedSource=fs.readFileSync(path.join(root, 'frontend/scripts/shared.js'), 'utf8');
  // Test-only closure inspection verifies that transient create credentials are not retained.
  if(options.inspectRecord)sharedSource=sharedSource.replace('  function state(){','  window.__inspectSharedRecord=()=>record;\n  function state(){');
  vm.runInContext(sharedSource, context, {filename: 'frontend/scripts/shared.js'});
  const run = source => vm.runInContext(source, context, {timeout: 1000});
  const api = window.SharedWorkspace || run('SharedWorkspace');
  return {
    api, context, calls, applied, messages, events, timers, timerDelays, nodes, dispatched, downloads, blobs, localStorage, sessionStorage, location, options, run,
    state: () => clone(api.state()), json: expression => clone(run(expression)), value: value => run('JSON.parse(' + JSON.stringify(JSON.stringify(value)) + ')'),
    get sampleCalls() { return sampleCalls; }, get renderCalls() { return renderCalls; }, get bindCalls() { return bindCalls; }, get shellBindCalls() { return shellBindCalls; },
    async emit(name, event = {}) { for (const callback of events.get(name) || []) await callback(event); },
    loadPersistence() { vm.runInContext(fs.readFileSync(path.join(root, 'frontend/scripts/persistence.js'), 'utf8'), context, {filename: 'frontend/scripts/persistence.js'}); },
    loadInit() { vm.runInContext(fs.readFileSync(path.join(root, 'frontend/scripts/init.js'), 'utf8'), context, {filename: 'frontend/scripts/init.js'}); },
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const editorSession = () => ({token: 'c'.repeat(64), displayName: 'QA Editor', expiresAt: '2099-01-01T00:00:00.000Z'});
async function unlockBoard(f) {
  await f.api.load();
  await f.api.unlock(f.value({displayName: 'QA Editor', editCode: '1234'}));
  assert.equal(f.state().canEdit, true, 'valid code grants editing');
}

test('shared payload strips personal layout and folded rows without losing project fields', () => {
  const f = harness(), original = project();
  const result = clone(f.api.toSharedProject(f.value(original)));
  for (const key of ['cols', 'lw', 'paneAuto', 'layoutVersion', 'nameAutoWidth', 'columnOrder', 'hiddenColumns', 'defView']) {
    assert.equal(Object.hasOwn(result.meta, key), false, key + ' is personal');
  }
  assert.equal(Object.hasOwn(result.tasks[0], 'fold'), false);
  assert.equal(result.meta.title, original.meta.title);
  assert.deepEqual(result.meta.customFields, original.meta.customFields);
  assert.deepEqual(result.tasks[0].customValues, original.tasks[0].customValues);
  assert.equal(result.tasks[0].name, original.tasks[0].name);
  assert.equal(original.tasks[0].fold, true, 'input is not mutated');
  assert.equal(original.meta.lw, 640);
});

test('public board loads in read-only mode and refuses schedule writes', async () => {
  const f = harness({fetch: call => {
    assert.equal(call.method, 'GET');
    return response(200, record(7));
  }});
  await f.api.load();
  assert.equal(f.state().projectId, projectId);
  assert.equal(f.state().revision, 7);
  assert.equal(f.state().canEdit, false);
  assert.equal(f.context.proj.tasks[0].name, 'shared task');
  f.api.noteChange(f.value(project('unauthorized edit')));
  await f.api.save();
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal(f.api.requireEdit(), false);
});

test('HTTP failure leaves a shared board in error state without opening a sample or local project', async () => {
  const local = new Map([['schedule-data', JSON.stringify({project: project('private local data')})]]);
  const before = [...local];
  const f = harness({local, fetch: () => response(404, {error: 'Project not found'})});
  await f.api.load();
  assert.equal(f.context.proj, null);
  assert.equal(f.sampleCalls, 0);
  assert.ok(f.state().error);
  assert.equal(f.state().canEdit, false);
  assert.deepEqual([...local], before, 'unrelated local project is preserved');
});

test('network failure never silently falls back to a local or sample schedule', async () => {
  const f = harness({fetch: () => { throw new TypeError('Failed to fetch'); }});
  await f.api.load();
  assert.equal(f.context.proj, null);
  assert.equal(f.sampleCalls, 0);
  assert.ok(f.state().error);
  assert.equal(f.state().canEdit, false);
});

test('personal column and fold preferences persist without a project PUT', async () => {
  const f = harness({fetch: () => response(200, record())});
  await f.api.load();
  f.run('proj.meta.lw=812;proj.meta.cols={name:310};proj.tasks[0].fold=true');
  f.api.savePersonal(f.context.proj);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal(f.state().dirty, false);
  const remote = project('remote name');
  remote.meta.lw = 450; remote.tasks[0].fold = false;
  const merged = clone(f.api.mergePersonal(f.value(remote)));
  assert.equal(merged.meta.lw, 812);
  assert.equal(merged.meta.cols.name, 310);
  assert.equal(merged.tasks[0].fold, true);
  assert.equal(merged.tasks[0].name, 'remote name');
});

test('queued saves are serialized and use the acknowledged server revision', async () => {
  const first = deferred(), second = deferred();
  let puts = 0;
  const f = harness({fetch: call => {
    if (call.method === 'GET') return response(200, record(7));
    if (call.url.endsWith('/session')) return response(200, editorSession());
    if (call.method === 'PUT') return ++puts === 1 ? first.promise : second.promise;
    throw new Error('Unexpected request');
  }});
  await unlockBoard(f);
  f.context.proj = f.value(project('first committed edit'));
  f.api.noteChange(f.context.proj);
  const firstSave = f.api.save();
  await tick();
  assert.equal(f.state().saving, true);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);

  f.context.proj = f.value(project('latest committed edit'));
  f.api.noteChange(f.context.proj);
  const secondSave = f.api.save();
  await tick();
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1, 'second edit waits for the first response');

  first.resolve(response(200, record(18, 'first committed edit')));
  await tick();
  const requests = f.calls.filter(call => call.method === 'PUT');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.baseRevision, 7);
  assert.equal(requests[0].body.project.tasks[0].name, 'first committed edit');
  assert.equal(requests[1].body.baseRevision, 18, 'server revision is authoritative, including jumps');
  assert.equal(requests[1].body.project.tasks[0].name, 'latest committed edit');
  assert.equal(f.context.proj.tasks[0].name, 'latest committed edit', 'older response cannot replace a newer edit');
  assert.match(requests[0].headers.Authorization || requests[0].headers.authorization, /^Bearer /);

  second.resolve(response(200, record(19, 'latest committed edit')));
  await Promise.all([firstSave, secondSave]);
  assert.equal(f.state().revision, 19);
  assert.equal(f.state().dirty, false);
  assert.equal(f.state().saving, false);
});

test('autosave only uploads a committed snapshot and excludes an in-progress visual draft', async () => {
  let uploaded;
  const f = harness({fetch: call => {
    if (call.method === 'GET') return response(200, record());
    if (call.url.endsWith('/session')) return response(200, editorSession());
    uploaded = call.body.project;
    return response(200, {...record(2), project: uploaded});
  }});
  await unlockBoard(f);
  f.context.proj = f.value(project('committed'));
  f.api.noteChange(f.context.proj);
  f.context.proj.tasks[0].name = 'uncommitted drag preview';
  await f.api.save();
  assert.equal(uploaded.tasks[0].name, 'committed');
  assert.equal(Object.hasOwn(uploaded.tasks[0], 'fold'), false);
  assert.equal(Object.hasOwn(uploaded.meta, 'cols'), false);
});

test('revision conflict retains the local edit and its recoverable draft instead of overwriting either side', async () => {
  const f = harness({fetch: call => {
    if (call.method === 'GET') return response(200, record(5));
    if (call.url.endsWith('/session')) return response(200, editorSession());
    return response(409, {error: {code: 'REVISION_CONFLICT', message: 'The project was changed'}, latest: record(6, 'remote edit')});
  }});
  await unlockBoard(f);
  f.context.proj = f.value(project('my unsaved draft'));
  f.api.noteChange(f.context.proj);
  const saved = await f.api.save();
  assert.equal(saved.ok, false);
  assert.equal(f.state().dirty, true);
  assert.ok(f.state().conflict);
  assert.equal(f.state().conflict.revision, 6);
  assert.equal(f.context.proj.tasks[0].name, 'my unsaved draft');
  assert.equal(f.state().revision, 5, 'conflict must not pretend the draft is based on the new revision');
  assert.ok([...f.localStorage.map.values()].some(value => value.includes('my unsaved draft')), 'draft survives a reload');
  await f.api.save();
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1, 'conflict blocks blind resubmission');
});

test('edit tokens live only in session storage and remain isolated to their board', async () => {
  const local = new Map(), session = new Map();
  const fetch = call => call.url.endsWith('/session') ? response(200, editorSession()) : response(200, record(1, 'shared task', call.url.includes(otherProjectId) ? otherProjectId : projectId));
  const first = harness({local, session, fetch});
  await unlockBoard(first);
  const token = editorSession().token;
  assert.ok([...session.values()].some(value => value.includes(token)));
  assert.equal([...local.values()].some(value => value.includes(token) || value.includes('1234')), false);
  assert.equal(JSON.stringify(first.state()).includes(token), false, 'UI state does not expose the bearer token');

  const second = harness({local, session, fetch, url: `http://127.0.0.1:5173/p/${otherProjectId}`});
  await second.api.load();
  assert.equal(second.state().canEdit, false);
  assert.equal(second.calls.some(call => String(call.headers.Authorization || call.headers.authorization || '').includes(token)), false);

  const reopened = harness({local, session, fetch});
  await reopened.api.load();
  assert.equal(reopened.state().canEdit, true);
  await reopened.api.logout();
  assert.equal(reopened.state().canEdit, false);
  assert.equal([...session.values()].some(value => value.includes(token)), false);
});

test('idle remote refresh applies the server version and resets the undo history', async () => {
  let gets = 0;
  const f = harness({fetch: () => response(200, ++gets === 1 ? record(3) : record(8, 'remote update'))});
  await f.api.load();
  f.context.hist = ['old snapshot 1', 'old snapshot 2']; f.context.histI = 1;
  f.context.selId = 't1'; f.context.selIds = new Set(['t1']);
  const renders = f.renderCalls;
  assert.equal(await f.api.pollNow(), true);
  assert.equal(f.state().revision, 8);
  assert.equal(f.context.proj.tasks[0].name, 'remote update');
  assert.equal(f.context.hist.length, 1);
  assert.equal(f.context.histI, 0);
  assert.match(f.context.hist[0], /remote update/);
  assert.equal(f.context.selId, null);
  assert.equal(f.context.selIds.size, 0);
  assert.ok(f.renderCalls > renders);
  assert.equal(f.state().dirty, false);
});

test('poll does not apply a response when a local edit started while the GET was in flight', async () => {
  const remote = deferred();
  let gets = 0;
  const f = harness({fetch: call => {
    if (call.url.endsWith('/session')) return response(200, editorSession());
    return ++gets === 1 ? response(200, record(3)) : remote.promise;
  }});
  await unlockBoard(f);
  const polling = f.api.pollNow();
  await tick();
  f.context.proj = f.value(project('local edit during poll'));
  f.api.noteChange(f.context.proj);
  remote.resolve(response(200, record(4, 'remote edit during poll')));
  assert.equal(await polling, false);
  assert.equal(f.context.proj.tasks[0].name, 'local edit during poll');
  assert.equal(f.state().revision, 3);
  assert.equal(f.state().dirty, true);
});

for (const reason of ['dragging', 'dialog', 'hidden']) {
  test('poll waits while the workspace is ' + reason, async () => {
    const f = harness({fetch: () => response(200, record())});
    await f.api.load();
    if (reason === 'dragging') f.context.dragging = true;
    if (reason === 'dialog') f.options.modal = true;
    if (reason === 'hidden') f.context.document.hidden = true;
    const requests = f.calls.length;
    assert.equal(await f.api.pollNow(), false);
    assert.equal(f.calls.length, requests);
    assert.equal(f.state().revision, 1);
  });
}

test('poll waits for a dirty edit and for its in-flight save', async () => {
  const saved = deferred();
  const f = harness({fetch: call => {
    if (call.url.endsWith('/session')) return response(200, editorSession());
    if (call.method === 'PUT') return saved.promise;
    return response(200, record());
  }});
  await unlockBoard(f);
  f.context.proj = f.value(project('dirty edit')); f.api.noteChange(f.context.proj);
  let requests = f.calls.length;
  assert.equal(await f.api.pollNow(), false);
  assert.equal(f.calls.length, requests);
  const saving = f.api.save(); await tick();
  requests = f.calls.length;
  assert.equal(await f.api.pollNow(), false);
  assert.equal(f.calls.length, requests);
  saved.resolve(response(200, record(2, 'dirty edit'))); await saving;
});

test('a saved local draft is preserved across reload and never silently replaces the server board', async () => {
  const local = new Map(), session = new Map();
  const fetch = call => call.url.endsWith('/session') ? response(200, editorSession()) : response(200, record(5, 'server schedule'));
  const first = harness({local, session, fetch});
  await unlockBoard(first);
  first.context.proj = first.value(project('recoverable local draft'));
  first.api.noteChange(first.context.proj);
  const reopened = harness({local, session, fetch});
  await reopened.api.load();
  assert.equal(reopened.context.proj.tasks[0].name, 'server schedule');
  assert.equal(reopened.state().dirty, true);
  assert.equal(reopened.state().draftAvailable, true);
  assert.ok(reopened.state().conflict);
  assert.equal((await reopened.api.save()).ok, false);
  assert.equal(reopened.calls.some(call => call.method === 'PUT'), false);
  assert.ok([...local.values()].some(value => value.includes('recoverable local draft')));
  await reopened.api.loadLatest();
  assert.equal(reopened.state().dirty, false);
  assert.equal(reopened.state().conflict, null);
  assert.equal(reopened.state().draftAvailable, false);
  assert.equal([...local.values()].some(value => value.includes('recoverable local draft')), false);
});

test('unload warns about dirty shared edits and stays quiet after server acknowledgement', async () => {
  const f = harness({fetch: call => {
    if (call.url.endsWith('/session')) return response(200, editorSession());
    if (call.method === 'PUT') return response(200, record(2, 'dirty before unload'));
    return response(200, record());
  }});
  await unlockBoard(f);
  const initial = {preventDefault() { this.prevented = true; }};
  await f.emit('beforeunload', initial);
  assert.equal(initial.prevented, undefined);
  f.context.proj = f.value(project('dirty before unload')); f.api.noteChange(f.context.proj);
  const dirty = {preventDefault() { this.prevented = true; }};
  await f.emit('beforeunload', dirty);
  assert.equal(dirty.prevented, true);
  assert.equal(dirty.returnValue, '');
  await f.api.save();
  const clean = {preventDefault() { this.prevented = true; }};
  await f.emit('beforeunload', clean);
  assert.equal(clean.prevented, undefined);
});

test('expired authorization clears credentials but preserves the unsaved draft', async () => {
  const f = harness({fetch: call => {
    if (call.url.endsWith('/session')) return response(200, editorSession());
    if (call.method === 'PUT') return response(401, {error: {code: 'SESSION_EXPIRED', message: 'Unlock this board again'}});
    return response(200, record());
  }});
  await unlockBoard(f);
  f.context.proj = f.value(project('draft after session expiry')); f.api.noteChange(f.context.proj);
  assert.equal((await f.api.save()).ok, false);
  assert.equal(f.state().canEdit, false);
  assert.equal(f.state().dirty, true);
  assert.equal([...f.sessionStorage.map.values()].some(value => value.includes(editorSession().token)), false);
  assert.ok([...f.localStorage.map.values()].some(value => value.includes('draft after session expiry')));
  await f.api.save();
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
});

test('network save failure retains its base revision and draft for an explicit retry', async () => {
  let puts = 0;
  const f = harness({fetch: call => {
    if (call.url.endsWith('/session')) return response(200, editorSession());
    if (call.method === 'PUT') {
      if (++puts === 1) throw new TypeError('Failed to fetch');
      return response(200, record(10, 'retry me'));
    }
    return response(200, record(9));
  }});
  await unlockBoard(f);
  f.context.proj = f.value(project('retry me')); f.api.noteChange(f.context.proj);
  assert.equal((await f.api.save()).ok, false);
  assert.equal(f.state().revision, 9);
  assert.equal(f.state().dirty, true);
  assert.ok([...f.localStorage.map.values()].some(value => value.includes('retry me')));
  assert.equal((await f.api.retrySave()).ok, true);
  assert.deepEqual(f.calls.filter(call => call.method === 'PUT').map(call => call.body.baseRevision), [9, 9]);
  assert.equal(f.state().revision, 10);
  assert.equal(f.state().dirty, false);
  assert.equal([...f.localStorage.map.values()].some(value => value.includes('retry me')), false);
});

test('the production persistence entry points commit shared snapshots without replacing local desktop storage', async () => {
  const local = new Map([['schedule-data', JSON.stringify({private: 'untouched local project'})]]);
  const priorLocal = local.get('schedule-data');
  let uploaded;
  const f = harness({local, fetch: call => {
    if (call.url.endsWith('/session')) return response(200, editorSession());
    if (call.method === 'PUT') {
      uploaded = call.body.project;
      return response(200, {...record(2), project: uploaded});
    }
    return response(200, record());
  }});
  f.loadPersistence();
  await f.context.load();
  await f.api.unlock(f.value({displayName: 'QA Editor', editCode: '1234'}));
  f.run('proj.tasks[0].name="committed through schSave";schSave()');
  assert.equal(f.run('pendingDirty'), true);
  f.run('proj.tasks[0].name="temporary drag position"');
  assert.equal((await f.context.flushPendingSave()).ok, true);
  assert.equal(uploaded.tasks[0].name, 'committed through schSave');
  assert.equal(f.run('pendingDirty'), false);
  assert.equal(f.context.saveT, null);
  assert.equal(local.get('schedule-data'), priorLocal);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
});

test('the production save path keeps viewer layout changes personal and clean', async () => {
  const f = harness({fetch: () => response(200, record())});
  f.loadPersistence();
  await f.context.load();
  f.run('proj.meta.cols={name:360};proj.tasks[0].fold=true;schSave()');
  assert.equal(f.run('pendingDirty'), false);
  assert.equal((await f.context.doSave()).ok, true);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 0);
  assert.equal(f.localStorage.getItem('schedule-data'), null);
  const merged = clone(f.api.mergePersonal(f.value(project())));
  assert.equal(merged.meta.cols.name, 360);
  assert.equal(merged.tasks[0].fold, true);
});

test('production load does not inspect local project fallback after a shared server failure', async () => {
  const local = new Map([['schedule-data', JSON.stringify(project('local-only schedule'))]]);
  const f = harness({local, fetch: () => response(404, {error: {code: 'NOT_FOUND', message: 'Not found'}})});
  f.loadPersistence();
  await f.context.load();
  assert.equal(f.context.proj, null);
  assert.equal(f.sampleCalls, 0);
  assert.equal(f.state().screen, 'error');
  assert.equal(f.state().error.code, 'NOT_FOUND');
});

test('loading a response for a different project cannot cross the current board boundary', async () => {
  const f = harness({fetch: () => response(200, record(20, 'another board', otherProjectId))});
  await f.api.load();
  assert.equal(f.context.proj, null);
  assert.equal(f.state().projectId, projectId);
  assert.equal(f.state().screen, 'error');
  assert.equal(f.state().error.code, 'INVALID_RESPONSE');
});

test('local mode retains its existing persistence behavior and never calls the shared server', async () => {
  const local = new Map([['schedule-data', JSON.stringify(project('local schedule'))]]);
  const f = harness({mode: 'local', local});
  f.loadPersistence();
  await f.context.load();
  assert.equal(f.context.proj.tasks[0].name, 'local schedule');
  f.run('proj.tasks[0].name="local edited";schSave()');
  assert.equal((await f.context.flushPendingSave()).ok, true);
  assert.equal(JSON.parse(local.get('schedule-data')).project.tasks[0].name, 'local edited');
  assert.equal(f.calls.length, 0);
});

test('retrying a failed initial load starts the real workspace once without duplicating bindings', async () => {
  let gets = 0;
  const f = harness({fetch: () => ++gets === 1
    ? response(503, {error: {code: 'UNAVAILABLE', message: 'Try again'}})
    : response(200, record(4, 'recovered board'))});
  f.loadPersistence();
  f.loadInit();
  await tick();
  assert.equal(f.state().screen, 'error');
  assert.equal(f.run('workspaceStarted'), false);
  assert.equal(f.bindCalls, 0);
  assert.equal(f.sampleCalls, 0);

  assert.equal(await f.api.load(), true);
  assert.equal(f.context.proj.tasks[0].name, 'recovered board');
  assert.equal(f.run('workspaceStarted'), true);
  assert.equal(f.bindCalls, 1);
  assert.equal(f.shellBindCalls, 1);
  assert.ok(f.renderCalls > 0);

  await f.api.load();
  assert.equal(f.bindCalls, 1, 'retry must not bind duplicate task handlers');
  assert.equal(f.shellBindCalls, 1, 'navigation bindings stay idempotent');
});

test('the shared HTML mode prevents local fallback when the runtime script is unavailable', async () => {
  const local = new Map([['schedule-data', JSON.stringify(project('private local schedule'))]]);
  const original = local.get('schedule-data');
  const f = harness({runtimeMissing: true, markupMode: 'shared', local,
    fetch: () => response(404, {error: {code: 'NOT_FOUND', message: 'Shared board not found'}})});
  f.loadPersistence();
  f.loadInit();
  await tick();
  assert.equal(f.context.window.SCHEDULE_RUNTIME, undefined);
  assert.equal(f.api.enabled, true);
  assert.equal(f.calls.length, 1, 'bootstrap still attempts the shared server');
  assert.equal(f.state().screen, 'error');
  assert.equal(f.context.proj, null);
  assert.equal(f.sampleCalls, 0);
  assert.equal(f.bindCalls, 0);
  assert.equal(local.get('schedule-data'), original);
});

test('storage quota failure keeps an exportable in-memory draft and explicitly reports its limits', async () => {
  const f = harness({localFailure: true, fetch: call => {
    if (call.url.endsWith('/session')) return response(200, editorSession());
    if (call.method === 'PUT') throw new TypeError('Failed to fetch');
    return response(200, record());
  }});
  await unlockBoard(f);
  f.context.proj = f.value(project('only in this page'));
  assert.equal(f.api.noteChange(f.context.proj), true);
  let state = f.state();
  assert.equal(state.dirty, true);
  assert.equal(state.draftAvailable, true);
  assert.equal(state.draftPersisted, false);
  assert.equal(state.error.code, 'DRAFT_STORAGE_FAILED');
  assert.match(state.error.message, /当前页面/);
  assert.match(state.error.message, /刷新.*丢失/);
  assert.match(state.error.message, /导出草稿/);
  assert.equal(f.localStorage.map.size, 0);

  assert.equal(f.api.exportDraft(), true);
  assert.equal(f.downloads.length, 1);
  assert.match(f.downloads[0].download, /\.json$/);
  assert.equal(JSON.parse(await f.blobs[0].text()).tasks[0].name, 'only in this page');
  assert.equal(f.state().dirty, true, 'export does not claim server acknowledgement');

  assert.equal((await f.api.save()).ok, false);
  state = f.state();
  assert.equal(state.draftPersisted, false);
  assert.equal(state.dirty, true);
  assert.match(state.error.message, /当前页面/);
  assert.match(state.error.message, /刷新.*丢失/);
  assert.doesNotMatch(state.error.message, /已保存|保留在当前浏览器/);
});

test('poll waits for an active text control and rechecks focus after its response arrives', async () => {
  const pending = deferred();
  let gets = 0;
  const f = harness({fetch: () => ++gets === 1 ? response(200, record(1)) : pending.promise});
  await f.api.load();
  for (const active of [{tagName: 'INPUT'}, {tagName: 'TEXTAREA'}, {tagName: 'SELECT'}, {tagName: 'DIV', isContentEditable: true}]) {
    f.context.document.activeElement = active;
    assert.equal(await f.api.pollNow(), false);
    assert.equal(gets, 1);
  }
  f.context.document.activeElement = null;
  const polling = f.api.pollNow();
  await tick();
  assert.equal(gets, 2);
  f.context.document.activeElement = {tagName: 'INPUT'};
  pending.resolve(response(200, record(2, 'remote while typing')));
  assert.equal(await polling, false);
  assert.equal(f.state().revision, 1);
  assert.equal(f.context.proj.tasks[0].name, 'shared task');
});

test('an expired session emits viewer state before requesting another edit code', async () => {
  const f = harness({fetch: call => call.url.endsWith('/session') ? response(200, editorSession()) : response(200, record())});
  await unlockBoard(f);
  const before = f.dispatched.length;
  f.run('Date.now=()=>Date.parse("2100-01-01T00:00:00.000Z")');
  assert.equal(f.api.requireEdit('编辑任务'), false);
  const sent = f.dispatched.slice(before);
  assert.equal(sent[0].type, 'schedule:shared-state');
  assert.equal(sent[0].detail.role, 'viewer');
  assert.equal(sent[0].detail.canEdit, false);
  assert.equal(sent[0].detail.displayName, '');
  assert.equal(sent[1].type, 'schedule:request-unlock');
  assert.equal([...f.sessionStorage.map.values()].some(value => value.includes(editorSession().token)), false);
  assert.equal(f.state().canEdit, false);
});

test('a queued save clears an obsolete quota warning after the server acknowledges the latest edit', async () => {
  const first = deferred(), second = deferred();
  let puts = 0;
  const f = harness({localFailure: true, fetch: call => {
    if (call.url.endsWith('/session')) return response(200, editorSession());
    if (call.method === 'PUT') return ++puts === 1 ? first.promise : second.promise;
    return response(200, record(1));
  }});
  await unlockBoard(f);
  f.context.proj = f.value(project('edit A')); f.api.noteChange(f.context.proj);
  const saving = f.api.save(); await tick();
  assert.equal(puts, 1);

  f.context.proj = f.value(project('edit B')); f.api.noteChange(f.context.proj);
  assert.equal(f.state().error.code, 'DRAFT_STORAGE_FAILED');
  assert.equal(f.state().draftPersisted, false);
  first.resolve(response(200, record(2, 'edit A'))); await tick();
  assert.equal(puts, 2);
  assert.equal(f.state().dirty, true, 'the older acknowledgement does not mark edit B saved');
  assert.equal(f.calls.filter(call => call.method === 'PUT')[1].body.project.tasks[0].name, 'edit B');

  second.resolve(response(200, record(3, 'edit B')));
  assert.equal((await saving).ok, true);
  assert.equal(f.state().dirty, false);
  assert.equal(f.state().error, null, 'a local draft warning is obsolete once the latest edit is saved remotely');
  assert.equal(f.state().saveStatus, 'saved');
  assert.equal(f.state().draftAvailable, false);
  assert.equal(f.state().revision, 3);
});

test('invalid edits made during an in-flight save are preserved locally and never queued for upload', async () => {
  const first = deferred();
  const f = harness({fetch: call => {
    if (call.url.endsWith('/session')) return response(200, editorSession());
    if (call.method === 'PUT') return first.promise;
    return response(200, record(1));
  }});
  await unlockBoard(f);
  f.context.proj = f.value(project('valid outgoing edit')); f.api.noteChange(f.context.proj);
  const saving = f.api.save(); await tick();
  f.context.proj = f.value(project('invalid later edit'));
  f.context.proj.tasks[0].s = 'invalid-date';
  assert.equal(f.api.noteChange(f.context.proj), false);
  assert.equal(f.state().error.code, 'INVALID_PROJECT');

  first.resolve(response(200, record(2, 'valid outgoing edit')));
  assert.equal((await saving).ok, false);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal(f.context.proj.tasks[0].name, 'invalid later edit');
  assert.equal(f.state().revision, 2);
  assert.equal(f.state().dirty, true);
  assert.equal(f.state().error.code, 'INVALID_PROJECT');
  assert.equal(f.state().saveStatus, 'error');
  assert.equal((await f.api.retrySave()).ok, false);
  assert.equal(f.calls.filter(call => call.method === 'PUT').length, 1);
});

const cloudRuntime = (endpoint='https://cloud.example.test') => ({mode:'workbuddy',storage:'workbuddy',configured:true,cloud:{endpoint,publishableKey:'wbpk_public_test'}});
function cloudHarness(options={}) {
  const cloudCalls=[],initializations=[];
  const handlers={
    get:id=>record(1,'cloud task',id),
    create:input=>({...record(1,'',input.id),project:input.project,session:editorSession()}),
    unlock:()=>editorSession(),
    save:(id,input)=>({...record(input.baseRevision+1,'',id),project:input.project}),
    logout:()=>({ok:true}),
    ...options.handlers,
  };
  const transport=Object.fromEntries(Object.entries(handlers).map(([method,handler])=>[method,async(...args)=>{
    cloudCalls.push({method,args:clone(args)});return handler(...args);
  }]));
  const f=harness({...options,runtime:options.runtime||cloudRuntime(),transportFactory:config=>{
    initializations.push(clone(config));return transport;
  }});
  return Object.assign(f,{cloudCalls,initializations});
}

test('WorkBuddy creates a random board and shares it through RPC without using the Node API',async()=>{
  const f=cloudHarness({url:'https://schedule.example.test/'});
  await f.api.load();
  assert.equal(f.state().screen,'home');
  await f.api.create(f.value({title:'Cloud board',displayName:'QA Editor',editCode:'0123'}));
  const input=f.cloudCalls[0].args[0];
  assert.match(input.id,/^[a-f0-9]{32}$/);
  assert.equal(input.editCode,'0123');
  assert.equal(input.project.meta.title,'Cloud board');
  assert.equal(input.project.tasks.length,0);
  assert.equal(f.state().mode,'workbuddy');
  assert.equal(f.state().canEdit,true);
  assert.equal(f.state().shareURL,'https://schedule.example.test/p/'+input.id);
  assert.equal(f.location.pathname,'/p/'+input.id);
  assert.equal(f.calls.length,0);
  assert.equal(f.initializations.length,1);
  assert.ok([...f.sessionStorage.map.keys()].every(key=>key.startsWith('schedule-workbuddy:')));
  assert.equal([...f.localStorage.map.values()].some(value=>value.includes(editorSession().token)||value.includes('0123')),false);
});

test('WorkBuddy reads, unlocks, serializes saves, polls and loads latest through explicit transport methods',async()=>{
  let latest=record(4,'initial cloud');
  const first=deferred();let writes=0;
  const f=cloudHarness({handlers:{
    get:()=>latest,
    save:(_id,input)=>++writes===1?first.promise:{...record(input.baseRevision+1),project:input.project},
  }});
  await unlockBoard(f);
  assert.deepEqual(f.cloudCalls.find(call=>call.method==='unlock').args,[projectId,{displayName:'QA Editor',editCode:'1234'}]);
  f.context.proj=f.value(project('cloud edit one'));f.api.noteChange(f.context.proj);
  const saving=f.api.save();await tick();
  f.context.proj=f.value(project('cloud edit two'));f.api.noteChange(f.context.proj);
  first.resolve(record(5,'cloud edit one'));
  assert.equal((await saving).ok,true);
  const saves=f.cloudCalls.filter(call=>call.method==='save');
  assert.deepEqual(saves.map(call=>call.args[1].baseRevision),[4,5]);
  assert.ok(saves.every(call=>call.args[1].token===editorSession().token));
  assert.equal(f.state().revision,6);
  latest=record(7,'remote cloud');
  assert.equal(await f.api.pollNow(),true);
  assert.equal(f.context.proj.tasks[0].name,'remote cloud');
  latest=record(8,'latest cloud');await f.api.loadLatest();
  assert.equal(f.state().revision,8);
  assert.equal(f.calls.length,0);
});

test('WorkBuddy conflict preserves recoverable draft and refuses another blind save',async()=>{
  const f=cloudHarness({handlers:{save:()=>{throw Object.assign(new Error('Other editor saved'),{code:'REVISION_CONFLICT',status:409,latest:record(2,'remote')});}}});
  await unlockBoard(f);
  f.context.proj=f.value(project('cloud conflicting draft'));f.api.noteChange(f.context.proj);
  assert.equal((await f.api.save()).ok,false);
  assert.equal(f.state().error.code,'REVISION_CONFLICT');
  assert.equal(f.state().conflict.revision,2);
  assert.equal(f.state().revision,1);
  assert.equal(f.state().canEdit,false);
  assert.equal(f.context.proj.tasks[0].name,'cloud conflicting draft');
  assert.ok([...f.localStorage.map.values()].some(value=>value.includes('cloud conflicting draft')));
  await f.api.retrySave();assert.equal(f.cloudCalls.filter(call=>call.method==='save').length,1);
});

test('WorkBuddy session failures clear token and retain the draft; incorrect edit codes stay visible to caller',async()=>{
  let wrong=true;
  const f=cloudHarness({handlers:{
    unlock:()=>{if(wrong)throw Object.assign(new Error('Incorrect edit code'),{code:'INVALID_EDIT_CODE',status:401});return editorSession();},
    save:()=>{throw Object.assign(new Error('Session expired'),{code:'SESSION_EXPIRED',status:401});},
  }});
  await f.api.load();
  await assert.rejects(f.api.unlock(f.value({displayName:'QA Editor',editCode:'0000'})),{code:'INVALID_EDIT_CODE'});
  assert.equal(f.state().canEdit,false);
  wrong=false;await f.api.unlock(f.value({displayName:'QA Editor',editCode:'1234'}));
  f.context.proj=f.value(project('expired cloud draft'));f.api.noteChange(f.context.proj);
  assert.equal((await f.api.save()).ok,false);
  assert.equal(f.state().role,'viewer');
  assert.equal(f.state().error.code,'SESSION_EXPIRED');
  assert.equal(f.state().dirty,true);
  assert.equal(f.sessionStorage.map.size,0);
  assert.ok([...f.localStorage.map.values()].some(value=>value.includes('expired cloud draft')));
});

test('WorkBuddy namespaces isolate credentials, layouts and drafts from HTTP and other cloud endpoints',async()=>{
  const local=new Map(),session=new Map();
  const http=harness({local,session,fetch:call=>call.url.endsWith('/session')?response(200,editorSession()):response(200,record())});
  await unlockBoard(http);
  http.context.proj=http.value(project('HTTP private draft'));http.api.noteChange(http.context.proj);
  const f=cloudHarness({local,session});await f.api.load();
  assert.equal(f.state().role,'viewer');assert.equal(f.state().dirty,false);
  await f.api.unlock(f.value({displayName:'QA Editor',editCode:'1234'}));
  f.context.proj=f.value(project('endpoint A draft'));f.context.proj.meta.lw=822;f.api.noteChange(f.context.proj);
  const other=cloudHarness({local,session,runtime:cloudRuntime('https://another-cloud.example.test')});
  await other.api.load();
  assert.equal(other.state().role,'viewer');assert.equal(other.state().dirty,false);
  assert.notEqual(other.context.proj.meta.lw,822);
  const reopened=cloudHarness({local,session,runtime:cloudRuntime('https://cloud.example.test/')});
  await reopened.api.load();
  assert.equal(reopened.state().role,'editor');
  assert.equal(reopened.state().error.code,'LOCAL_DRAFT');
  assert.equal(reopened.context.proj.meta.lw,822);
  assert.ok([...local.values()].some(value=>value.includes('HTTP private draft')));
});

test('WorkBuddy logout immediately clears local session and revokes remote token even if revocation later fails',async()=>{
  const revoke=deferred();const f=cloudHarness({handlers:{logout:()=>revoke.promise}});
  await unlockBoard(f);
  const result=f.api.logout();
  assert.equal(f.state().role,'viewer');assert.equal(f.state().canEdit,false);
  assert.equal(f.sessionStorage.map.size,0);
  assert.deepEqual(f.cloudCalls.at(-1),{method:'logout',args:[projectId,editorSession().token]});
  revoke.reject(Object.assign(new Error('Offline'),{code:'NETWORK_ERROR'}));
  await assert.rejects(result,error=>error.code==='NETWORK_ERROR'&&error.message.includes('本机已退出'));
  assert.equal(f.state().role,'viewer');
});

test('WorkBuddy bootstrap fails closed on missing runtime, config or SDK, including the creation homepage',async()=>{
  const local=new Map([['schedule-data',JSON.stringify(project('private local'))]]);
  for(const options of [
    {runtimeMissing:true,markupMode:'workbuddy'},
    {runtime:cloudRuntime()},
    {runtime:{...cloudRuntime(),configured:false}},
    {runtime:{...cloudRuntime(),configError:{code:'CLOUD_CONFIG_INVALID',message:'Invalid runtime endpoint'}}},
  ]){
    const f=harness({...options,local,url:'https://schedule.example.test/'});
    f.loadPersistence();f.loadInit();await tick();
    assert.equal(f.api.enabled,true);
    assert.equal(f.state().screen,'error');
    assert.equal(f.state().canEdit,false);
    assert.match(f.state().error.code,/^CLOUD_/);
    assert.equal(f.sampleCalls,0);assert.equal(f.context.proj,null);assert.equal(f.calls.length,0);
    await assert.rejects(f.api.create(f.value({title:'x',displayName:'QA',editCode:'1234'})),error=>/^CLOUD_/.test(error.code));
  }
  assert.equal(local.size,1);
});

test('WorkBuddy homepage can retry initialization after runtime injection and accepts same-origin SDK defaults',async()=>{
  const f=harness({markupMode:'workbuddy',runtimeMissing:true,url:'https://schedule.example.test/'});
  await f.api.load();assert.equal(f.state().screen,'error');
  let actual;
  f.context.window.SCHEDULE_RUNTIME=cloudRuntime('');
  f.context.window.WorkBuddyTransport={create:config=>{actual=config;return Object.fromEntries(['get','create','unlock','save','logout'].map(method=>[method,()=>{}]));}};
  await f.api.load();
  assert.equal(f.state().screen,'home');assert.equal(f.state().error,null);
  assert.equal(actual.endpoint,'https://schedule.example.test');
});

test('WorkBuddy pagehide retains a local draft without claiming RPC unload delivery',async()=>{
  const f=cloudHarness();await unlockBoard(f);
  f.context.proj=f.value(project('cloud closing draft'));f.api.noteChange(f.context.proj);
  const warning={preventDefault(){this.prevented=true;}};await f.emit('beforeunload',warning);
  assert.equal(warning.prevented,true);
  await f.emit('pagehide');
  assert.equal(f.cloudCalls.some(call=>call.method==='save'),false);
  assert.equal(f.state().dirty,true);
  assert.ok([...f.localStorage.map.values()].some(value=>value.includes('cloud closing draft')));
});

test('WorkBuddy shared state machine consumes production RPC envelopes and keeps conflicts recoverable',async()=>{
  const rpcCalls=[];
  const f=harness({runtime:cloudRuntime(),sdkRpc:async(name,args)=>{
    rpcCalls.push({name,args:clone(args)});
    if(name==='schedule_get_project')return {data:{ok:true,data:record()}};
    if(name==='schedule_unlock_project')return {data:{ok:true,data:editorSession()}};
    if(name==='schedule_save_project')return {data:{ok:false,error:{code:'REVISION_CONFLICT',message:'Remote update'},latest:record(2,'remote')}};
    if(name==='schedule_revoke_session')return {data:{ok:true,data:{revoked:true}}};
    throw new Error('Unexpected RPC '+name);
  }});
  await unlockBoard(f);
  f.context.proj=f.value(project('real transport draft'));f.api.noteChange(f.context.proj);
  assert.equal((await f.api.save()).ok,false);
  assert.equal(f.state().conflict.revision,2);
  assert.equal(f.state().error.code,'REVISION_CONFLICT');
  assert.equal(f.state().dirty,true);
  assert.equal(rpcCalls[2].args.p_token,editorSession().token);
  assert.equal(rpcCalls[2].args.p_expected_revision,1);
  await f.api.logout();
  assert.equal(rpcCalls.at(-1).name,'schedule_revoke_session');
  assert.equal(f.state().canEdit,false);
  assert.equal(f.calls.length,0);
});

test('WorkBuddy configuration error renders its actionable screen and hides the create form',async()=>{
  const f=harness({runtime:cloudRuntime(),url:'https://schedule.example.test/'});
  vm.runInContext(fs.readFileSync(path.join(root,'frontend/scripts/app-shell.js'),'utf8'),f.context,{filename:'frontend/scripts/app-shell.js'});
  f.context.window.SharedWorkspaceUI.bind();await f.api.load();
  assert.equal(f.nodes.get('#shared-home').hidden,true);
  assert.equal(f.nodes.get('#shared-error-page').hidden,false);
  assert.equal(f.nodes.get('#shared-error-title').textContent,'云服务尚未就绪');
  assert.match(f.nodes.get('#shared-error-message').textContent,/重新加载|检查/);
  assert.equal(f.nodes.get('#shared-retry-load').hidden,false);
  assert.equal(f.nodes.get('#workspace-main').hidden,true);
});

const presenceFixture=()=>({members:[
  {displayName:'QA Editor',lastSeenAt:'2026-10-12T01:00:00Z',online:true,source:'human'},
  {displayName:'QA Editor',lastSeenAt:'2026-10-12T00:00:00Z',online:false,source:'external'},
],onlineThresholdSeconds:60});
const heartbeatTimers=f=>[...f.timers].filter(([id])=>f.timerDelays.get(id)===20000);

test('V2 heartbeat runs only for foreground cloud editors and stops on logout or page leave',async()=>{
  const f=cloudHarness({handlers:{heartbeat:presenceFixture,presence:presenceFixture}});
  await f.api.load();
  assert.equal(heartbeatTimers(f).length,0);
  assert.equal(await f.api.refreshPresence(),false);
  assert.equal(f.cloudCalls.some(call=>call.method==='presence'),false);
  await f.api.unlock(f.value({displayName:'QA Editor',editCode:'1234'}));
  assert.equal(heartbeatTimers(f).length,1);
  heartbeatTimers(f)[0][1]();await tick();
  assert.deepEqual(f.cloudCalls.at(-1),{method:'heartbeat',args:[projectId,editorSession().token]});
  assert.equal(f.state().presence.members.length,2);
  f.context.document.hidden=true;await f.emit('document:visibilitychange');
  assert.equal(heartbeatTimers(f).length,0);
  f.context.document.hidden=false;await f.emit('document:visibilitychange');
  assert.equal(heartbeatTimers(f).length,1);
  await f.emit('pagehide');
  assert.equal(heartbeatTimers(f).length,0);
  assert.equal(await f.api.refreshPresence(),false);
  await f.emit('pageshow');assert.equal(heartbeatTimers(f).length,1);
  await f.api.logout();
  assert.equal(heartbeatTimers(f).length,0);
  assert.equal(f.state().presence,null);
  assert.equal(f.state().presenceError,null);
});

test('late collaborator responses cannot disclose sessions after logout',async()=>{
  const pending=deferred(),f=cloudHarness({handlers:{presence:()=>pending.promise}});
  await unlockBoard(f);
  const refreshing=f.api.refreshPresence();assert.equal(f.state().presenceLoading,true);
  await f.api.logout();const at=f.dispatched.length;
  pending.resolve(presenceFixture());
  assert.equal(await refreshing,false);
  assert.equal(f.state().presence,null);
  assert.ok(f.dispatched.slice(at).every(event=>!event.detail?.presence));
});

test('presence failures remain separate from save failures and missing V2 stops repeated requests',async()=>{
  const f=cloudHarness({handlers:{heartbeat:()=>{throw Object.assign(new Error('请执行 V2 迁移'),{code:'CLOUD_NOT_READY',status:503});}}});
  await unlockBoard(f);
  assert.equal(await f.api.refreshPresence(true),false);
  assert.equal(f.state().presenceError.code,'CLOUD_NOT_READY');
  assert.equal(f.state().saveStatus,'saved');
  assert.equal(f.state().canEdit,true);
  assert.equal(heartbeatTimers(f).length,0);
});

test('expired collaborator authorization clears editor session without losing a pending draft',async()=>{
  const f=cloudHarness({handlers:{presence:()=>{throw Object.assign(new Error('expired'),{code:'SESSION_EXPIRED',status:401});}}});
  await unlockBoard(f);f.context.proj=f.value(project('draft remains'));f.api.noteChange(f.context.proj);
  await f.api.refreshPresence();
  assert.equal(f.state().role,'viewer');
  assert.equal(f.state().presence,null);
  assert.equal(f.state().dirty,true);
  assert.equal(f.sessionStorage.map.size,0);
  assert.equal(heartbeatTimers(f).length,0);
});

test('created and reset AI keys are returned once to the caller and never enter shared state or storage',async()=>{
  const key='d'.repeat(64),nextKey='e'.repeat(64);
  const f=cloudHarness({url:'https://schedule.example.test/',handlers:{
    create:input=>({...record(1,'',input.id),project:input.project,session:editorSession(),apiKey:key}),
    resetApiKey:()=>({apiKey:nextKey}),
  }});
  await f.api.load();
  const created=await f.api.create(f.value({title:'Private key board',displayName:'QA',editCode:'1234'}));
  assert.equal(created.apiKey,key);
  assert.equal((await f.api.resetApiKey('5678')).apiKey,nextKey);
  assert.deepEqual(f.cloudCalls.at(-1),{method:'resetApiKey',args:[created.projectId,'5678']});
  for(const serialized of [JSON.stringify(f.state()),JSON.stringify(f.dispatched),JSON.stringify([...f.localStorage.map]),JSON.stringify([...f.sessionStorage.map])]){
    assert.equal(serialized.includes(key),false);assert.equal(serialized.includes(nextKey),false);
  }
  assert.equal(f.state().source,'human');
  await f.api.logout();
  await assert.rejects(f.api.resetApiKey('5678'),/编辑模式/);
});

test('external update source is available in public shared state without revealing an editor token',async()=>{
  const f=cloudHarness({handlers:{get:()=>({...record(2),source:'external'})}});
  await f.api.load();assert.equal(f.state().source,'external');
  assert.equal(JSON.stringify(f.state()).includes(editorSession().token),false);
});

test('internal public record excludes one-time create credentials and unsolicited secret fields on refresh',async()=>{
  const key='d'.repeat(64),extras={apiKey:key,session:editorSession(),api_key_hash:'private hash',extraSecret:'discard'};
  const f=cloudHarness({inspectRecord:true,url:'https://schedule.example.test/',handlers:{
    create:input=>({...record(1,'',input.id),project:input.project,...extras}),
    get:id=>({...record(2,'refreshed',id),...extras}),
  }});
  await f.api.load();
  await f.api.create(f.value({title:'Cloud board',displayName:'QA',editCode:'1234'}));
  for(let pass=0;pass<2;pass++){
    const internal=clone(f.context.window.__inspectSharedRecord());
    assert.deepEqual(Object.keys(internal).sort(),['createdAt','id','project','revision','source','updatedAt','updatedBy']);
    assert.equal(JSON.stringify(internal).includes(key),false);
    assert.equal(JSON.stringify(internal).includes(editorSession().token),false);
    if(pass===0)await f.api.loadLatest();
  }
});

function loadV2UI(f){
  f.context.byId=id=>f.context.proj?.tasks.find(task=>task.id===id);
  f.context.openOvl=overlay=>{overlay.hidden=false;};
  f.context.closeOvl=overlay=>{overlay.hidden=true;};
  vm.runInContext(fs.readFileSync(path.join(root,'frontend/scripts/app-shell.js'),'utf8'),f.context,{filename:'frontend/scripts/app-shell.js'});
  f.context.window.SharedWorkspaceUI.bind();
  return f.context.window.SharedWorkspaceUI;
}

test('AI key dialog displays only the supplied one-time key and wipes it on close, reopen and pagehide',async()=>{
  const f=cloudHarness();await unlockBoard(f);const ui=loadV2UI(f),key='d'.repeat(64);
  ui.openAi(key);assert.equal(f.nodes.get('#shared-ai-key').value,key);
  assert.equal(f.nodes.get('#shared-ai-once').hidden,false);
  ui.closeAi();assert.equal(f.nodes.get('#shared-ai-key').value,'');
  assert.equal(f.nodes.get('#shared-ai-ovl').hidden,true);
  ui.openAi();assert.equal(f.nodes.get('#shared-ai-key').value,'');
  assert.equal(f.nodes.get('#shared-ai-reset-form').hidden,false);
  ui.openAi(key);await f.emit('pagehide');
  assert.equal(f.nodes.get('#shared-ai-key').value,'');
  assert.equal(f.nodes.get('#shared-ai-ovl').hidden,true);
  assert.equal(JSON.stringify(f.dispatched).includes(key),false);
});

test('collaborator UI keeps duplicate nicknames separate, displays source and closes after logout',async()=>{
  const f=cloudHarness({handlers:{presence:presenceFixture}});await unlockBoard(f);
  const ui=loadV2UI(f);ui.openPresence();await tick();
  const rows=f.nodes.get('#shared-presence-list').children;
  assert.equal(rows.length,2);
  assert.equal(rows[0].children[1].children[0].textContent,'QA Editor');
  assert.equal(rows[1].children[1].children[0].textContent,'QA Editor · AI / 外部');
  assert.equal(f.nodes.get('#shared-presence-summary').textContent,'1 人在线 · 2 个有效会话');
  await f.api.logout();
  assert.equal(f.nodes.get('#shared-presence-ovl').hidden,true);
  assert.equal(f.nodes.get('#shared-presence').hidden,true);
  assert.equal(f.nodes.get('#shared-presence-list').children.length,0);
});

test('AI reset form submits PIN once, wipes PIN and displays replacement key only while editor remains',async()=>{
  const key='e'.repeat(64),f=cloudHarness({handlers:{resetApiKey:()=>({apiKey:key})}});
  await unlockBoard(f);const ui=loadV2UI(f);ui.openAi();
  const form=f.nodes.get('#shared-ai-reset-form');form.reportValidity=()=>true;
  f.nodes.get('#shared-ai-code').value='1234';
  await form.dispatch('submit');
  assert.equal(f.cloudCalls.filter(call=>call.method==='resetApiKey').length,1);
  assert.equal(f.nodes.get('#shared-ai-code').value,'');
  assert.equal(f.nodes.get('#shared-ai-key').value,key);
  await f.api.logout();
  assert.equal(f.nodes.get('#shared-ai-key').value,'');
  assert.equal(f.nodes.get('#shared-ai-ovl').hidden,true);
});
