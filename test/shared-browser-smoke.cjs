#!/usr/bin/env node
'use strict';

// Two isolated browser contexts and a disposable loopback service. Node 22+ only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.repair-work');
const reportFile = path.join(output, 'shared-browser-smoke-results.json');
const chromePath = process.env.SMOKE_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { browser: null, origin: '', checks: [], screenshots: [], pageErrors: [], consoleErrors: [],
  apiResponses: [], conflict: null, isolation: null };

async function waitUntil(operation, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await operation()) return;
    await sleep(100);
  }
  throw new Error('Timed out: ' + description);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(2500)]);
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

async function main() {
  assert.equal(typeof WebSocket, 'function', 'Run with Node 22 or newer.');
  assert.ok(fs.existsSync(chromePath), 'Chrome is required.');
  assert.ok(fs.existsSync(path.join(root, 'server.js')), 'Build the shared frontend and server before running.');
  fs.mkdirSync(output, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-gantt-shared-smoke-'));
  const dataDir = path.join(temporaryRoot, 'data');
  const profile = path.join(temporaryRoot, 'chrome');
  let server, chrome, socket, command, pages = [];
  let serverOutput = '', serverError = '', chromeError = '';
  try {
    server = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, windowsHide: true,
      env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDir, NODE_ENV: 'development',
        STORAGE_DRIVER: 'file', STORAGE_ADAPTER_MODULE: '', PUBLIC_ORIGIN: '', ALLOWED_ORIGINS: '', TRUST_PROXY: '0',
        SESSION_SECRET: 'shared-browser-smoke-isolated-test-secret-2026' }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
    server.stderr.on('data', chunk => { serverError += chunk.toString(); });
    await waitUntil(() => {
      if (server.exitCode !== null) throw new Error('Temporary server exited: ' + serverError);
      return /http:\/\/127\.0\.0\.1:\d+/.test(serverOutput);
    }, 'temporary service startup', 20000);
    report.origin = serverOutput.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
    const health = await fetch(report.origin + '/healthz');
    assert.equal(health.status, 200); assert.equal((await health.json()).mode, 'shared');

    chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-sync', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows', '--window-size=1440,1000', '--force-device-scale-factor=1', 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    chrome.stderr.on('data', chunk => { chromeError += chunk.toString(); });
    await waitUntil(() => {
      if (chrome.exitCode !== null) throw new Error('Chrome exited: ' + chromeError.slice(-1200));
      return /DevTools listening on (ws:\/\/[^\s]+)/.test(chromeError);
    }, 'Chrome CDP startup', 20000);
    socket = new WebSocket(chromeError.match(/DevTools listening on (ws:\/\/[^\s]+)/)[1]);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let sequence = 0;
    const pending = new Map(), listeners = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const entry = pending.get(message.id); if (!entry) return;
        pending.delete(message.id); clearTimeout(entry.timer);
        message.error ? entry.reject(new Error(entry.method + ': ' + message.error.message)) : entry.resolve(message.result || {});
      } else for (const listener of listeners.get(message.method) || []) listener(message.params || {}, message.sessionId);
    });
    command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
      pending.set(id, { resolve, reject, timer, method });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const on = (method, listener) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(listener); };
    report.browser = await command('Browser.getVersion');

    async function page(label) {
      const { browserContextId } = await command('Target.createBrowserContext');
      const { targetId } = await command('Target.createTarget', { url: 'about:blank', browserContextId });
      const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
      const send = (method, params = {}) => command(method, params, sessionId);
      let loadCount=0;
      on('Page.loadEventFired', (_params, source) => { if(source===sessionId)loadCount++; });
      const evaluate = async expression => {
        const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(label + ': ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
        return result.result.value;
      };
      const waitFor = (expression, description, timeout) => waitUntil(() => evaluate(expression), label + ': ' + description, timeout);
      const point = async selector => {
        const p = await evaluate('(() => {const el=document.querySelector(' + JSON.stringify(selector) + ');if(!el)throw new Error("Missing element");el.scrollIntoView({block:"nearest",inline:"nearest"});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height};})()');
        assert.ok(p.w > 0 && p.h > 0, label + ': hidden ' + selector); return p;
      };
      const clickAt = async (p, count = 1) => {
        await send('Page.bringToFront'); await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
        for (let i = 1; i <= count; i++) {
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: i });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: i });
        }
      };
      const click = async (selector, count = 1) => {
        const menu = await evaluate('document.querySelector(' + JSON.stringify(selector) + ')?.closest(".action-menu")?.id');
        const toggle = { 'file-menu': '#file-menu-toggle', 'create-menu': '#create-menu-toggle' }[menu];
        if (toggle && await evaluate('document.getElementById(' + JSON.stringify(menu) + ').hidden')) { await click(toggle); await waitFor('!document.getElementById(' + JSON.stringify(menu) + ').hidden', 'action menu'); }
        await clickAt(await point(selector), count);
      };
      const key = async (key, code, virtual, modifiers = 0) => {
        await send('Input.dispatchKeyEvent', { type: key === 'Enter' ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: virtual, modifiers,
          ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual, modifiers });
      };
      const fill = async (selector, text) => { await click(selector); await key('a', 'KeyA', 65, 2); if (text) await send('Input.insertText', { text }); else await key('Backspace', 'Backspace', 8); };
      const navigate = async (url, shared=true) => { const previous=loadCount; await send('Page.navigate', { url }); await waitUntil(()=>loadCount>previous,label+': document load'); if(shared)await waitFor('location.href===' + JSON.stringify(url) + ' && typeof SharedWorkspace!=="undefined" && SharedWorkspace.enabled', 'shared runtime ready'); };
      const reload = async () => { const previous=loadCount; await send('Page.reload'); await waitUntil(()=>loadCount>previous,label+': refreshed document load'); };
      const shot = async name => {
        await send('Page.bringToFront'); await evaluate('window.scrollTo(0,0);true');
        const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const file = path.join(output, name); fs.writeFileSync(file, Buffer.from(data, 'base64')); report.screenshots.push(file);
      };
      on('Runtime.exceptionThrown', (params, source) => { if (source === sessionId) report.pageErrors.push({ label, error: params.exceptionDetails.exception?.description || params.exceptionDetails.text }); });
      on('Runtime.consoleAPICalled', (params, source) => { if (source === sessionId && params.type === 'error') report.consoleErrors.push({ label, error: params.args.map(arg => arg.value ?? arg.description ?? arg.type).join(' ') }); });
      on('Network.responseReceived', (params, source) => { if (source === sessionId && params.response.url.startsWith(report.origin + '/api/')) report.apiResponses.push({ label, url: params.response.url, status: params.response.status }); });
      on('Page.javascriptDialogOpening', (_params, source) => { if (source === sessionId) send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); });
      await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
      await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      const result = { label, browserContextId, sessionId, send, evaluate, waitFor, point, clickAt, click, key, fill, navigate, reload, shot };
      pages.push(result); return result;
    }
    const A = await page('A'), B = await page('B');
    report.isolation = { contextsDistinct: A.browserContextId !== B.browserContextId, temporaryService: true };
    assert.equal(report.isolation.contextsDistinct, true);
    const check = async (name, operation) => { await operation(); report.checks.push({ name, ok: true }); console.log('PASS ' + name); };
    const state = client => client.evaluate('SharedWorkspace.state()');
    const ready = client => client.waitFor('typeof SharedWorkspace!=="undefined" && SharedWorkspace.state().screen==="ready" && typeof proj!=="undefined" && !!proj && !document.getElementById("workspace-main").hidden', 'shared project displayed');
    const saved = client => client.waitFor('SharedWorkspace.state().saveStatus==="saved" && !SharedWorkspace.state().dirty && !SharedWorkspace.state().saving', 'cloud save confirmed');
    const openTask = async (client, id) => {
      await client.waitFor('!anyOvlOpen()', 'previous modal fully closed');
      const p=await client.point('.t-row[data-id="' + id + '"] .col-name');
      assert.equal(await client.evaluate('document.elementFromPoint(' + p.x + ',' + p.y + ')?.closest(".t-row")?.dataset.id'),id,'Task row must receive the physical double-click');
      await client.clickAt(p, 2);
      await client.waitFor('!document.getElementById("ovl").hidden && document.activeElement===document.getElementById("f-name")', 'task drawer autofocus');
      await client.waitFor('document.getElementById("ovl").getAnimations({subtree:true}).every(a=>a.playState==="finished")', 'task drawer entrance');
    };
    const saveTask = async client => { await client.click('#dlg-save'); await client.waitFor('document.getElementById("ovl").hidden', 'task drawer closes'); };
    let projectId, shareURL, taskId, fieldId;
    const title = '共享回归排期', initialName = 'A 创建的共享任务';
    const publicProject = async () => { const response = await fetch(report.origin + '/api/projects/' + projectId); assert.equal(response.status, 200); return response.json(); };

    await check('home shows an empty creation form without sample or local project fallback', async () => {
      await A.navigate(report.origin + '/'); await A.waitFor('SharedWorkspace.state().screen==="home"', 'home screen');
      assert.equal(await A.evaluate('typeof proj==="undefined" || proj===null || proj.tasks.length===0'), true);
      assert.equal(await A.evaluate('document.getElementById("workspace-main").hidden'), true); await A.shot('shared-home.png');
    });
    await check('A creates an empty shared schedule through title nickname and four-digit form', async () => {
      await A.fill('#shared-create-title', title); await A.fill('#shared-create-name', '成员 A'); await A.fill('#shared-create-code', '4826'); await A.click('#shared-create-submit'); await ready(A);
      const current = await state(A); projectId = current.projectId; shareURL = current.shareURL;
      assert.match(projectId, /^[a-f0-9]{32}$/); assert.equal(new URL(shareURL).origin, report.origin); assert.equal(new URL(shareURL).pathname, '/p/' + projectId);
      assert.equal(current.role, 'editor'); assert.equal(current.displayName, '成员 A'); assert.equal(await A.evaluate('proj.tasks.length'), 0);
      assert.equal(await A.evaluate('document.getElementById("view-hint").textContent.includes("只读")'), false);
      assert.equal(await A.evaluate('proj.meta.title'), title); report.projectId = projectId; await A.shot('shared-created.png');
    });
    await check('A adds and saves a task plus a custom text field using the real editors', async () => {
      await A.click('#btn-add-task'); await A.waitFor('!document.getElementById("ovl").hidden && document.activeElement===document.getElementById("f-name")', 'new task autofocus');
      await A.waitFor('document.getElementById("ovl").getAnimations({subtree:true}).every(a=>a.playState==="finished")', 'new task drawer entrance');
      await A.fill('#f-name', initialName); await saveTask(A); taskId = await A.evaluate('proj.tasks[0].id'); await saved(A);
      await A.click('#btn-fields'); await A.waitFor('!document.getElementById("fields-ovl").hidden && document.getElementById("fields-ovl").getAnimations({subtree:true}).every(a=>a.playState==="finished")', 'field manager');
      await A.fill('#fields-add-name', '共享备注'); await A.click('#fields-add'); await A.waitFor('(proj.meta.customFields||[]).length===1', 'custom field created');
      fieldId = await A.evaluate('proj.meta.customFields[0].id'); await A.click('#fields-done'); await openTask(A, taskId);
      await A.fill('[data-custom-field-id="' + fieldId + '"]', '<b>共享文本</b> literal'); await saveTask(A); await saved(A);
      const cloud = await publicProject(); assert.equal(cloud.project.tasks[0].name, initialName); assert.equal(cloud.project.meta.customFields[0].id, fieldId);
      assert.equal(cloud.project.tasks[0].customValues[fieldId], '<b>共享文本</b> literal'); await A.shot('shared-editor-A.png');
    });
    await check('the copy link control reports a usable shared URL', async () => {
      await A.click('#shared-copy-link'); await A.waitFor('document.getElementById("shared-copy-feedback").textContent.trim().length>0', 'copy feedback');
      report.copyFeedback = await A.evaluate('document.getElementById("shared-copy-feedback").textContent'); assert.match(report.copyFeedback, /已复制/); assert.equal((await state(A)).shareURL, shareURL);
    });
    await check('isolated B opens the link as a read-only viewer and sees A data', async () => {
      await B.navigate(shareURL); await ready(B); const current = await state(B); assert.equal(current.role, 'viewer'); assert.equal(current.canEdit, false);
      assert.equal(await B.evaluate('document.getElementById("view-hint").textContent.includes("只读")'), true);
      assert.equal(await B.evaluate('byId(' + JSON.stringify(taskId) + ').name'), initialName); assert.equal(await B.evaluate('proj.meta.customFields[0].id'), fieldId);
      assert.equal(await B.evaluate('byId(' + JSON.stringify(taskId) + ').customValues[' + JSON.stringify(fieldId) + ']'), '<b>共享文本</b> literal'); await B.shot('shared-readonly-B.png');
    });
    await check('read-only buttons keyboard shortcuts and physical bar drag cannot change the project', async () => {
      const before = JSON.stringify((await publicProject()).project), revision = (await publicProject()).revision;
      assert.equal(await B.evaluate('document.getElementById("btn-add-task").disabled'), true); await B.click('#btn-add-task');
      await B.click('.t-row[data-id="' + taskId + '"] .col-name'); await B.key('Delete', 'Delete', 46); await B.key('Enter', 'Enter', 13); await B.key('z', 'KeyZ', 90, 2);
      await B.click('#btn-today'); const p = await B.point('.bar[data-id="' + taskId + '"]'); await B.send('Page.bringToFront');
      await B.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await B.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
      for (const dx of [5, 20, 45]) await B.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + dx, y: p.y, button: 'left', buttons: 1 });
      await B.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + 45, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(700); assert.equal((await state(B)).dirty, false); const after = await publicProject(); assert.equal(JSON.stringify(after.project), before); assert.equal(after.revision, revision);
      assert.equal(await B.evaluate('proj.tasks.length'), 1); assert.equal(await B.evaluate('byId(' + JSON.stringify(taskId) + ').name'), initialName);
    });
    await check('a wrong code remains read-only and the correct code unlocks B with its nickname', async () => {
      await B.click('#shared-unlock'); await B.waitFor('!document.getElementById("shared-unlock-ovl").hidden && document.getElementById("shared-unlock-ovl").getAnimations({subtree:true}).every(a=>a.playState==="finished")', 'unlock dialog');
      await B.fill('#shared-unlock-name', '成员 B'); await B.fill('#shared-unlock-code', '0000'); await B.click('#shared-unlock-submit');
      await B.waitFor('document.getElementById("shared-unlock-error").textContent.trim().length>0', 'wrong code feedback'); assert.equal((await state(B)).canEdit, false);
      await B.fill('#shared-unlock-code', '4826'); await B.click('#shared-unlock-submit'); await B.waitFor('SharedWorkspace.state().canEdit && document.getElementById("shared-unlock-ovl").hidden', 'B unlocked');
      assert.equal((await state(B)).displayName, '成员 B');
      assert.equal(await B.evaluate('document.getElementById("view-hint").textContent.includes("只读")'), false);
    });
    await check('B saves an edit and A receives it through automatic polling', async () => {
      await openTask(B, taskId); await B.fill('#f-name', 'B 保存后的任务'); await saveTask(B); await saved(B);
      await A.send('Page.bringToFront');
      await A.waitFor('byId(' + JSON.stringify(taskId) + ').name==="B 保存后的任务"', 'A receives B edit through polling', 15000);
      assert.equal((await publicProject()).updatedBy, '成员 B'); await A.shot('shared-polled-A.png');
    });
    await check('a held A save conflicts with B and preserves A draft until explicit load latest', async () => {
      let held;
      on('Fetch.requestPaused', (params, session) => {
        if (session !== A.sessionId) return;
        if (params.request.method === 'PUT' && params.request.url === report.origin + '/api/projects/' + projectId && !held) held = params;
        else A.send('Fetch.continueRequest', { requestId: params.requestId }).catch(error => report.pageErrors.push({ label: 'A interception', error: error.message }));
      });
      await A.send('Fetch.enable', { patterns: [{ urlPattern: report.origin + '/api/projects/' + projectId, requestStage: 'Request' }] });
      await openTask(A, taskId); await A.fill('#f-name', 'A 冲突草稿保留'); await saveTask(A); await waitUntil(() => !!held, 'A save physically held before reaching the service');
      assert.equal((await state(A)).dirty, true); const heldBody = JSON.parse(held.request.postData); assert.equal(heldBody.project.tasks[0].name, 'A 冲突草稿保留');
      await openTask(B, taskId); await B.fill('#f-name', 'B 并发提交版本'); await saveTask(B); await saved(B); const cloud = await publicProject(); assert.ok(cloud.revision > heldBody.baseRevision);
      assert.equal(await A.evaluate('byId(' + JSON.stringify(taskId) + ').name'), 'A 冲突草稿保留');
      await A.send('Fetch.continueRequest', { requestId: held.requestId }); await A.send('Fetch.disable');
      await A.waitFor('SharedWorkspace.state().saveStatus==="conflict"', '409 conflict state');
      assert.equal(await A.evaluate('byId(' + JSON.stringify(taskId) + ').name'), 'A 冲突草稿保留'); assert.equal((await state(A)).dirty, true); assert.equal((await state(A)).canEdit, false);
      assert.equal((await state(A)).role, 'editor'); assert.equal(await A.evaluate('document.getElementById("shared-unlock").hidden'), true);
      report.conflict = { heldBaseRevision: heldBody.baseRevision, cloudRevision: cloud.revision, state: await state(A) }; await A.shot('shared-conflict-A.png');
      await A.click('#shared-load-latest'); await A.waitFor('!document.getElementById("shared-conflict-confirm").hidden', 'explicit conflict confirmation');
      assert.equal(await A.evaluate('byId(' + JSON.stringify(taskId) + ').name'), 'A 冲突草稿保留'); await A.click('#shared-cancel-latest');
      assert.equal((await state(A)).saveStatus, 'conflict'); assert.equal(await A.evaluate('byId(' + JSON.stringify(taskId) + ').name'), 'A 冲突草稿保留');
      await A.click('#shared-load-latest'); await A.waitFor('!document.getElementById("shared-conflict-confirm").hidden', 'second explicit confirmation'); await A.click('#shared-confirm-latest');
      await A.waitFor('!SharedWorkspace.state().dirty && SharedWorkspace.state().saveStatus==="saved" && byId(' + JSON.stringify(taskId) + ').name==="B 并发提交版本"', 'confirmed latest version applied');
      assert.equal((await publicProject()).project.tasks[0].name, 'B 并发提交版本'); assert.ok(report.apiResponses.some(item => item.label === 'A' && item.status === 409));
    });
    await check('refresh reloads the confirmed cloud project and custom values', async () => {
      await A.reload(); await ready(A); await A.waitFor('byId(' + JSON.stringify(taskId) + ').name==="B 并发提交版本"', 'cloud project after refresh');
      assert.equal(await A.evaluate('byId(' + JSON.stringify(taskId) + ').customValues[' + JSON.stringify(fieldId) + ']'), '<b>共享文本</b> literal');
      assert.equal((await state(A)).dirty, false); await A.shot('shared-refreshed-A.png');
    });
    await check('A personal column resize remains local and does not alter B or cloud revision', async () => {
      const cloudBefore = await publicProject(), bWidth = await B.evaluate('colW().person');
      const p = await A.point('#g-left-hd .col-rz[data-col="person"]'), aWidth = await A.evaluate('colW().person');
      assert.equal(await A.evaluate('document.elementFromPoint(' + p.x + ',' + p.y + ')?.closest(".col-rz")?.dataset.col'), 'person');
      await A.send('Page.bringToFront'); await A.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await A.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
      for (const dx of [8, 16, 32]) { await A.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + dx, y: p.y, button: 'left', buttons: 1 }); await A.evaluate('new Promise(resolve=>requestAnimationFrame(()=>resolve(true)))'); }
      await A.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + 32, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
      assert.equal(await A.evaluate('colW().person'), aWidth + 32); await sleep(900); assert.equal(await B.evaluate('colW().person'), bWidth);
      const cloudAfter = await publicProject(); assert.equal(cloudAfter.revision, cloudBefore.revision); assert.deepEqual(cloudAfter.project, cloudBefore.project);
      await A.reload(); await ready(A); await A.waitFor('colW().person===' + (aWidth + 32), 'personal width restored after refresh');
      assert.equal(await B.evaluate('colW().person'), bWidth);
    });
    await check('a nonexistent shared ID shows an error and never falls back to sample tasks', async () => {
      await B.navigate(report.origin + '/p/' + '0'.repeat(32)); await B.waitFor('SharedWorkspace.state().screen==="error"', 'missing project error');
      assert.equal(await B.evaluate('document.getElementById("workspace-main").hidden'), true);
      assert.equal(await B.evaluate('typeof proj==="undefined" || proj===null || proj.tasks.length===0'), true); await B.shot('shared-not-found.png');
    });
    await check('an initial shared load error recovers through the real retry control and starts the workspace', async () => {
      let injected = false;
      on('Fetch.requestPaused', (params, session) => {
        if (session !== B.sessionId) return;
        if (!injected && params.request.method === 'GET' && params.request.url === report.origin + '/api/projects/' + projectId) {
          injected = true;
          B.send('Fetch.fulfillRequest', { requestId: params.requestId, responseCode: 503,
            responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }],
            body: Buffer.from(JSON.stringify({ error: { code: 'STORAGE_UNAVAILABLE', message: '浏览器测试注入的一次加载失败' } })).toString('base64') })
            .catch(error => report.pageErrors.push({ label: 'B interception', error: error.message }));
        } else B.send('Fetch.continueRequest', { requestId: params.requestId }).catch(error => report.pageErrors.push({ label: 'B interception', error: error.message }));
      });
      await B.send('Fetch.enable', { patterns: [{ urlPattern: report.origin + '/api/projects/' + projectId, requestStage: 'Request' }] });
      await B.navigate(shareURL); await B.waitFor('SharedWorkspace.state().screen==="error"', 'injected initial load failure'); assert.equal(injected, true);
      assert.equal(await B.evaluate('typeof proj==="undefined" || proj===null || proj.tasks.length===0'), true);
      await B.send('Fetch.disable'); await B.click('#shared-retry-load'); await ready(B);
      await B.waitFor('!!document.querySelector(' + JSON.stringify('.bar[data-id="' + taskId + '"]') + ')', 'task bar rendered after retry');
      assert.equal(await B.evaluate('byId(' + JSON.stringify(taskId) + ').name'), 'B 并发提交版本');
      await openTask(B, taskId); assert.equal(await B.evaluate('document.getElementById("f-name").value'), 'B 并发提交版本'); await B.click('#dlg-cancel');
      await B.shot('shared-load-recovered.png');
    });
    await check('the built file page still renders and saves a task in an isolated local context', async () => {
      const Local = await page('Local'); await Local.navigate(pathToFileURL(path.join(root, 'index.html')).href,false);
      await Local.waitFor('typeof proj!=="undefined" && proj && proj.tasks.length>0 && document.querySelector(".bar")', 'local sample project');
      assert.equal(await Local.evaluate('SharedWorkspace.enabled'), false);
      const localTaskId = await Local.evaluate('[...document.querySelectorAll(".t-row")].map(row=>byId(row.dataset.id)).find(task=>task?.type==="task"&&!isSum(task))?.id');
      assert.ok(localTaskId, 'Local page must contain a visible editable task'); await openTask(Local, localTaskId);
      await Local.fill('#f-name', '本地兼容回归任务'); await saveTask(Local);
      await Local.waitFor('(() => {const raw=JSON.parse(localStorage.getItem("schedule-data")||"null"),p=raw?.project||raw;return p?.tasks.some(t=>t.id===' + JSON.stringify(localTaskId) + ' && t.name==="本地兼容回归任务");})()', 'local task persisted');
      await Local.shot('shared-local-compatibility.png');
    });
    await check('shared and local contexts have no uncaught runtime exceptions or console errors', async () => {
      assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.consoleErrors, []);
    });
    report.ok = true; fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log('Shared browser smoke passed: ' + report.checks.length + ' checks. Report: ' + reportFile);
  } catch (error) {
    report.ok = false; report.error = String(error.stack || error);
    report.failedStates=[];
    for(const client of pages)report.failedStates.push({label:client.label,state:await client.evaluate('typeof SharedWorkspace!=="undefined"?SharedWorkspace.state():null').catch(()=>null)});
    for (const client of pages) await client.shot('shared-failure-' + client.label + '.png').catch(() => {});
    report.serverError = serverError; fs.writeFileSync(reportFile, JSON.stringify(report, null, 2)); throw error;
  } finally {
    if (socket?.readyState === WebSocket.OPEN && command) await command('Browser.close').catch(() => {});
    socket?.close(); await stopChild(chrome); await stopChild(server);
    // Both targets were freshly created by this test beneath the OS temporary root.
    const verifiedTemp = path.resolve(temporaryRoot), parentTemp = path.resolve(os.tmpdir());
    assert.ok(path.dirname(verifiedTemp) === parentTemp && path.basename(verifiedTemp).startsWith('schedule-gantt-shared-smoke-'));
    fs.rmSync(verifiedTemp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
