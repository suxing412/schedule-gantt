#!/usr/bin/env node
'use strict';

// Real Chrome smoke test. Uses Node 22+ and CDP; no npm package is required.
// A temporary Chrome profile isolates localStorage from desktop/browser data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const previewUrl = new URL(process.env.SCHEDULE_PREVIEW_URL || pathToFileURL(path.join(root, 'index.html')).href);
assert.ok(previewUrl.protocol === 'file:' || (previewUrl.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(previewUrl.hostname)), 'Smoke tests only visit a local preview.');
const output = path.join(root, '.repair-work');
const frontendMode = process.env.SMOKE_FRONTEND === '1';
const reportName = frontendMode ? 'frontend-smoke-results.json' : 'browser-smoke-results.json';
const downloads = path.join(output, `${frontendMode ? 'frontend' : 'browser'}-smoke-downloads-${Date.now()}-${process.pid}`);
const chromePath = process.env.SMOKE_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const checks = [];
const pageErrors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { browser: null, checks, pageErrors, screenshots: [], viewportSnapshots: [], desktopLayouts: [], downloads: [] };

function fixture() {
  const today = new Date();
  const day = offset => {
    const d = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + offset));
    return d.toISOString().slice(0, 10);
  };
  const task = (id, name, start, end, options = {}) => ({
    id, name, pid: null, type: 'task', s: day(start), e: day(end),
    pct: 0, who: '测试用户', grp: '程序', phase: '浏览器回归',
    deps: [], fold: false, ...options
  });
  return {
    tasks: [
      task('sm-pipe', '浏览器回归管线', 0, 7, { type: 'pipeline', who: '' }),
      task('sm-parent', '测试模块', 0, 7, { pid: 'sm-pipe', grp: '策划' }),
      task('sm-a', '测试任务 A', 0, 2, { pid: 'sm-parent', pct: 40 }),
      task('sm-b', '测试任务 B', 3, 5, { pid: 'sm-parent', deps: ['sm-a'] }),
      task('sm-node', '模块验收', 6, 6, { pid: 'sm-parent', type: 'milestone', deps: ['sm-b'] }),
      task('sm-flow', '流程装箱测试', 0, 7, { flow: true, grp: '策划' }),
      task('sm-f1', '流程任务 1', 1, 3, { pid: 'sm-flow', grp: '美术' }),
      task('sm-f2', '流程任务 2', 2, 5, { pid: 'sm-flow' }),
      task('sm-fnode', '流程节点', 3, 3, { pid: 'sm-flow', type: 'milestone', lane: 1 }),
      task('sm-free', '独立任务', 1, 4, { grp: '动画', pct: 70 })
    ],
    groups: [
      { name: '策划', color: '#2f6fe8' }, { name: '美术', color: '#ec4899' },
      { name: '程序', color: '#0ea5e9' }, { name: '动画', color: '#f59e0b' }
    ],
    flags: [{ id: 'sm-flag', name: '测试发布节点', d: day(7), color: '#e03e3e' }],
    meta: { lw: 440, cols: { person: 64, date: 76, pct: 52 } }
  };
}

async function main() {
  assert.equal(typeof WebSocket, 'function', 'Run this script with Node 22 or newer.');
  assert.ok(fs.existsSync(chromePath), `Chrome executable is missing: ${chromePath}`);
  fs.mkdirSync(downloads, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-gantt-smoke-'));
  const child = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--window-size=1440,1000',
    '--force-device-scale-factor=1', 'about:blank'
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let socket;
  let closeBrowser;
  let captureFailure;
  let browserExited = false;
  child.once('exit', () => { browserExited = true; });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try {
    const deadline = Date.now() + 20000;
    while (!/DevTools listening on (ws:\/\/[^\s]+)/.test(stderr)) {
      if (browserExited) throw new Error(`Chrome exited before CDP became available: ${stderr.slice(-1200)}`);
      if (Date.now() > deadline) throw new Error(`Chrome CDP startup timed out: ${stderr.slice(-1200)}`);
      await sleep(100);
    }
    socket = new WebSocket(stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)[1]);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map();
    const listeners = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id); clearTimeout(item.timer);
        message.error ? item.reject(new Error(`${item.method}: ${message.error.message}`)) : item.resolve(message.result || {});
      } else {
        for (const listener of listeners.get(message.method) || []) listener(message.params || {}, message.sessionId);
      }
    });
    const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP command timed out: ${method}`)); }, 20000);
      pending.set(id, { resolve, reject, timer, method });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const on = (method, listener) => {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(listener);
    };
    closeBrowser = () => command('Browser.close').catch(() => {});
    report.browser = await command('Browser.getVersion');
    const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params = {}) => command(method, params, sessionId);
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    on('Runtime.exceptionThrown', params => pageErrors.push(params.exceptionDetails.exception?.description || params.exceptionDetails.text));
    on('Page.javascriptDialogOpening', () => { send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); });
    await command('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
    const downloadEvents = [];
    on('Browser.downloadWillBegin', params => downloadEvents.push({ ...params }));
    on('Browser.downloadProgress', params => {
      const entry = downloadEvents.find(item => item.guid === params.guid);
      if (entry) Object.assign(entry, params);
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const storedProject = `(() => { const stored = JSON.parse(localStorage.getItem('schedule-data')); return stored?.project || stored; })()`;
    const waitFor = async (expression, message, timeout = 5000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await sleep(100);
      }
      throw new Error(`Timed out: ${message}`);
    };
    const point = async selector => {
      const rectangle = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Missing element: ' + ${JSON.stringify(selector)});
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
      })()`);
      assert.ok(rectangle.w > 0 && rectangle.h > 0, `Element is hidden: ${selector}`);
      return rectangle;
    };
    const click = async (selector, count = 1) => {
      const menu=await evaluate('document.querySelector('+JSON.stringify(selector)+')?.closest(".action-menu")?.id');
      const menuToggle={"file-menu":"#file-menu-toggle","create-menu":"#create-menu-toggle"}[menu];
      if(menuToggle && await evaluate('document.getElementById('+JSON.stringify(menu)+').hidden')){
        await click(menuToggle);
        await waitFor('!document.getElementById('+JSON.stringify(menu)+').hidden','menu opens for '+selector);
        await waitFor('document.getElementById('+JSON.stringify(menu)+').getAnimations({subtree:true}).every(animation=>animation.playState === "finished")','menu entrance for '+selector);
      }
      const p = await point(selector);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      for (let i = 1; i <= count; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: i });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: i });
      }
    };
    const key = async (key, code, virtual, modifiers = 0) => {
      // Enter needs its character-bearing keyDown to exercise native button
      // activation; rawKeyDown alone tests JS handlers but omits keypress.
      await send('Input.dispatchKeyEvent', { type: key==='Enter'?'keyDown':'rawKeyDown', key, code, windowsVirtualKeyCode: virtual, modifiers,
        ...(key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual, modifiers });
    };
    const fill = async (selector, value) => {
      await click(selector); await key('a', 'KeyA', 65, 2);
      if (value) await send('Input.insertText', { text: value });
      else await key('Backspace', 'Backspace', 8);
    };
    const shot = async name => {
      const before = await evaluate(`({ width: innerWidth, height: innerHeight, scrollX, scrollY,
        documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
        chartLeft: document.querySelector('#g-right').getBoundingClientRect().left,
        fileMenuRight: document.querySelector('#file-menu-toggle').getBoundingClientRect().right,
        planningRight: document.querySelector('.planning-surface').getBoundingClientRect().right })`);
      // scrollIntoView may move the document while revealing a wide toolbar.
      // Restore the page origin for screenshots without changing chart scrollLeft.
      await evaluate(`window.scrollTo(0, 0); document.documentElement.scrollLeft = 0; document.body.scrollLeft = 0; true`);
      report.viewportSnapshots.push({ name, before, after: await evaluate(`({ scrollX, scrollY, chartLeft: document.querySelector('#g-right').getBoundingClientRect().left })`) });
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(output, frontendMode ? name.replace('browser-smoke-','frontend-smoke-') : name);
      fs.writeFileSync(file, Buffer.from(data, 'base64')); report.screenshots.push(file);
    };
    captureFailure = () => shot('browser-smoke-failure.png').catch(() => {});
    const check = async (name, operation) => {
      await operation(); checks.push({ name, ok: true }); console.log(`PASS ${name}`);
    };
    const seed = JSON.stringify(fixture());
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `if (location.href.split('#')[0] === ${JSON.stringify(previewUrl.href)} && !localStorage.getItem('schedule-data')) localStorage.setItem('schedule-data', ${JSON.stringify(seed)});` });
    await send('Page.navigate', { url: previewUrl.href });
    await waitFor(`typeof proj !== 'undefined' && proj && document.querySelector('.bar[data-id="sm-a"]')`, 'initial task rendering');
    await sleep(400);

    await check('initial rows, hierarchy, flow lanes, milestone, dependencies', async () => {
      const state = await evaluate(`({ tasks: proj.tasks.length, rows: document.querySelectorAll('#g-left-body .t-row').length,
        lanes: document.querySelectorAll('.lane-band').length, pins: document.querySelectorAll('.pin').length,
        canvas: { width: document.querySelector('#dep-canvas').width, height: document.querySelector('#dep-canvas').height } })`);
      assert.equal(state.tasks, 10); assert.ok(state.rows >= 7); assert.ok(state.lanes >= 1); assert.ok(state.pins >= 2);
      assert.ok(state.canvas.width > 0 && state.canvas.height > 0); report.initial = state;
      await shot('browser-smoke-initial.png');
    });
    await check('navigation and action menus are reachable at 720, 900, 1280 and 1440 pixels', async () => {
      const controls = ['nav-toggle','file-menu-toggle','btn-add-task','create-menu-toggle',
        'btn-undo','btn-redo','btn-settings','btn-fields'];
      const measureControls = ids => evaluate(`(() => {
        const controls = ${JSON.stringify(ids)}.map(id => {
          const el = document.getElementById(id), r = el?.getBoundingClientRect();
          return { id, left:r?.left, right:r?.right, top:r?.top, bottom:r?.bottom, width:r?.width, height:r?.height,
            hit:r && document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')?.id };
        });
        return { width:innerWidth, documentWidth:document.documentElement.scrollWidth,
          clientWidth:document.documentElement.clientWidth, scrollX, controls }; })()`);
      const assertReachable = (layout,width) => {
        assert.ok(layout.documentWidth<=layout.clientWidth+1,`Document overflows at ${width}px: ${layout.documentWidth}`);
        for(const control of layout.controls){
          assert.ok(control.width>0 && control.height>0,`${control.id} is hidden at ${width}px`);
          assert.ok(control.left>=-1 && control.right<=width+1,`${control.id} is clipped at ${width}px`);
          assert.ok(control.top>=-1 && control.bottom<=1001,`${control.id} is outside the viewport at ${width}px`);
          assert.equal(control.hit,control.id,`${control.id} is covered at ${width}px`);
        }
      };
      for (const width of [720, 900, 1280, 1440]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
        await sleep(300);
        const layout=await measureControls(controls);assertReachable(layout,width);
        layout.menus=[];
        for(const [toggle,menu,items] of [
          ['file-menu-toggle','file-menu',['btn-import','btn-export','btn-png']],
          ['create-menu-toggle','create-menu',['btn-add-pipe','btn-add-child','btn-add-ms','btn-add-flag']]
        ]){
          await click('#'+toggle);await waitFor('!document.getElementById('+JSON.stringify(menu)+').hidden',menu+' opened');
          await waitFor('document.getElementById('+JSON.stringify(menu)+').getAnimations({subtree:true}).every(animation=>animation.playState === "finished")',menu+' entrance');
          const open=await measureControls(items);assertReachable(open,width);layout.menus.push({menu,...open});
          await click('#'+toggle);await waitFor('document.getElementById('+JSON.stringify(menu)+').hidden',menu+' closed');
        }
        report.desktopLayouts.push(layout);
        await click('#btn-settings');
        await waitFor(`!document.querySelector('#set-ovl').hidden`, `settings opens at ${width}px`);
        assert.equal(await evaluate('scrollX'), 0, `Clicking a navigation action scrolled the whole page at ${width}px`);
        await key('Escape', 'Escape', 27);
        await waitFor(`document.querySelector('#set-ovl').hidden`, `settings closes at ${width}px`);
        if (width === 720 || width === 900) await shot('browser-smoke-'+width+'.png');
      }
    });
    await check('unselected row double-click opens editor', async () => {
      await click('#g-left-body .t-row[data-id="sm-a"]', 2);
      await waitFor(`!document.querySelector('#ovl').hidden`, 'row double-click editor');
      assert.equal(await evaluate(`document.querySelector('#f-name').value`), '测试任务 A');
      await waitFor(`document.querySelector('#ovl').contains(document.activeElement)`, 'editor receives keyboard focus');
      await key('Delete', 'Delete', 46);
      assert.equal(await evaluate('proj.tasks.length'), 10, 'Delete inside the editor must not delete a selected project task');
      assert.equal(await evaluate(`byId('sm-a').name`), '测试任务 A', 'Unsaved field input must not alter the project');
      await key('Escape', 'Escape', 27); await waitFor(`document.querySelector('#ovl').hidden`, 'close row editor');
    });
    await check('unselected bar double-click and editor save', async () => {
      await click('.bar[data-id="sm-b"] .bar-name', 2);
      await waitFor(`!document.querySelector('#ovl').hidden`, 'bar double-click editor');
      assert.equal(await evaluate(`document.querySelector('#f-name').value`), '测试任务 B');
      await fill('#f-name', '浏览器回归任务 B');
      await click('#dlg-save'); await waitFor(`document.querySelector('#ovl').hidden`, 'save editor');
      await waitFor(`${storedProject}.tasks.find(t => t.id === 'sm-b').name === '浏览器回归任务 B'`, 'persist editor change');
    });
    await check('undo and redo preserve task edit', async () => {
      await click('#btn-undo'); assert.equal(await evaluate(`byId('sm-b').name`), '测试任务 B');
      await click('#btn-redo'); assert.equal(await evaluate(`byId('sm-b').name`), '浏览器回归任务 B');
    });
    await check('search filters and clears through input events', async () => {
      await fill('#tb-search', '浏览器回归任务 B');
      await waitFor(`document.querySelector('#g-left-body .t-row[data-id="sm-b"]') && !document.querySelector('#g-left-body .t-row[data-id="sm-a"]')`, 'search filtering');
      await fill('#tb-search', '');
      await waitFor(`document.querySelector('#g-left-body .t-row[data-id="sm-a"]')`, 'clear filtering');
    });
    await check('day, month and week view switch', async () => {
      for (const [zoom, width] of [['day', 72], ['month', 6], ['week', 22]]) {
        await click(`#zoom-seg .seg-btn[data-z="${zoom}"]`);
        assert.equal(await evaluate('axis.dw'), width);
      }
      await shot('browser-smoke-week.png');
    });
    await check('drag shifts dates and undo restores them', async () => {
      const before = await evaluate(`({ s: byId('sm-b').s, e: byId('sm-b').e })`);
      await click('#g-left-body .t-row[data-id="sm-b"]');
      const p = await point('.bar[data-id="sm-b"] .bar-name');
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 4; i++) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + 11 * i, y: p.y, button: 'left', buttons: 1 });
        await sleep(20);
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x + 44, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
      assert.equal(await evaluate(`tD(byId('sm-b').s) - tD(${JSON.stringify(before.s)})`), 2);
      assert.equal(await evaluate(`tD(byId('sm-b').e) - tD(${JSON.stringify(before.e)})`), 2);
      await click('#btn-undo'); assert.deepEqual(await evaluate(`({ s: byId('sm-b').s, e: byId('sm-b').e })`), before);
    });
    await check('saved project survives page reload', async () => {
      await waitFor(`${storedProject}.tasks.find(t => t.id === 'sm-b').name === '浏览器回归任务 B'`, 'save before reload');
      await sleep(500);
      const saved = await evaluate(`JSON.parse(localStorage.getItem('schedule-data'))`);
      assert.equal(saved.format, 'schedule-gantt-storage');
      assert.match(saved.projectId, /^[a-f0-9]{32}$/i, 'Saved project must carry a valid project identity');
      const loaded = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Reload load event timed out')), 5000);
        on('Page.loadEventFired', () => { clearTimeout(timer); resolve(); });
      });
      await send('Page.reload'); await loaded;
      await waitFor(`typeof proj !== 'undefined' && proj && byId('sm-b') && byId('sm-b').name === '浏览器回归任务 B'`, 'reload saved project');
      const reloaded = await evaluate(`JSON.parse(localStorage.getItem('schedule-data'))`);
      assert.equal(reloaded.projectId, saved.projectId, 'Page reload must preserve project identity');
      assert.ok(reloaded.revision >= saved.revision, 'Page reload must not replace a newer saved revision');
      report.storageIdentity = { projectId: saved.projectId, revisionBefore: saved.revision, revisionAfter: reloaded.revision };
    });
    const download = async (kind, selector) => {
      const previous = downloadEvents.length;
      await click(selector);
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const item = downloadEvents.slice(previous).find(entry => entry.state === 'completed');
        if (item) {
          const filename = path.join(downloads, item.suggestedFilename);
          assert.ok(fs.existsSync(filename), `Missing download ${filename}`);
          const buffer = fs.readFileSync(filename);
          if (kind === 'json') assert.equal(JSON.parse(buffer.toString('utf8')).tasks.length, 10);
          else assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
          report.downloads.push({ kind, filename, bytes: buffer.length }); return;
        }
        await sleep(100);
      }
      throw new Error(`${kind} download did not complete`);
    };
    await check('JSON export downloads valid project', async () => {
      await download('json', '#btn-export');
    });
    await check('PNG export downloads valid image', async () => {
      await download('png', '#btn-png');
    });
    if(frontendMode){
      report.frontend={};
      const waitOverlay = id => waitFor('!document.getElementById('+JSON.stringify(id)+').hidden && document.getElementById('+JSON.stringify(id)+').getAnimations({subtree:true}).every(animation=>animation.playState === "finished")',id+' interactive');
      const rect = selector => evaluate('(() => { const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; })()');
      await check('project summary and edited project name persist through the new header',async()=>{
        assert.equal(await evaluate('document.getElementById("metric-tasks").textContent'),'5');
        assert.equal(await evaluate('document.getElementById("metric-milestones").textContent'),'3');
        assert.equal(await evaluate('document.getElementById("metric-progress").textContent'),'24');
        const tasks=await evaluate('JSON.stringify(proj.tasks)'),title='浏览器验收 · 研发排期';
        await fill('#project-name',title);await key('Enter','Enter',13);
        await waitFor('proj.meta.title === '+JSON.stringify(title)+' && '+storedProject+'.meta.title === '+JSON.stringify(title),'project title saved');
        await send('Page.reload');await waitFor('typeof proj!=="undefined" && proj && document.querySelector(".bar[data-id=sm-a]")','renamed project reloaded');await sleep(200);
        assert.equal(await evaluate('document.getElementById("project-name").value'),title);
        assert.equal(await evaluate('JSON.stringify(proj.tasks)'),tasks,'Changing the project title must preserve all task data');
        report.frontend.title=title;await shot('frontend-project-header.png');
      });
      await check('navigation collapse and both table view entrances keep the project editable',async()=>{
        const expanded=await rect('.workspace-nav');
        await click('#nav-toggle');await sleep(150);const collapsed=await rect('.workspace-nav');
        assert.ok(collapsed.width<expanded.width);assert.equal(await evaluate('document.getElementById("nav-toggle").getAttribute("aria-expanded")'),'false');
        await click('#nav-toggle');await sleep(150);assert.equal((await rect('.workspace-nav')).width,expanded.width);
        const cols=await evaluate('JSON.stringify(proj.meta.cols)');
        await click('.view-tab[data-view="table"]');await waitFor('document.getElementById("app-shell").classList.contains("view-table")','table view selected');await sleep(180);
        assert.equal((await rect('#g-right')).width,0);assert.equal((await rect('#splitter')).width,0);
        assert.ok(Math.abs((await rect('#g-left')).width-(await rect('#gantt')).width)<=1,'Table view should use the full planning canvas');
        assert.equal(await evaluate('document.querySelector(".nav-item[data-view=table]").getAttribute("aria-current")'),'page');
        await shot('frontend-table-view.png');
        const fixedWidths=await evaluate('Object.fromEntries(visibleTableColumns().map(column=>[column.id,document.querySelector("#g-left-hd .col[data-col="+CSS.escape(column.id)+"]").getBoundingClientRect().width]))');
        await send('Emulation.setDeviceMetricsOverride',{width:1920,height:1000,deviceScaleFactor:1,mobile:false});await sleep(250);
        const wideTable=await evaluate('(() => {const body=document.getElementById("g-left-body"),b=body.getBoundingClientRect(),h=document.querySelector("#g-left-hd .col:last-child").getBoundingClientRect();return {bodyRight:b.left+body.clientLeft+body.clientWidth,headerRight:h.right,rowRights:[...body.querySelectorAll(".t-row")].map(row=>row.querySelector(".col:last-child").getBoundingClientRect().right),name:document.querySelector("#g-left-hd .col-name").getBoundingClientRect().width,scrollWidth:body.scrollWidth,clientWidth:body.clientWidth};})()');
        const wideFixedWidths=await evaluate('Object.fromEntries(visibleTableColumns().map(column=>[column.id,document.querySelector("#g-left-hd .col[data-col="+CSS.escape(column.id)+"]").getBoundingClientRect().width]))');
        assert.deepEqual(wideFixedWidths,fixedWidths,'Widening the table viewport must preserve every fixed column');
        assert.ok(wideTable.bodyRight-wideTable.headerRight>100,'Wide table must leave extra viewport space as background after its fixed columns');
        for(const right of wideTable.rowRights) assert.ok(Math.abs(right-wideTable.headerRight)<=1,'Fixed header and row column ends must align');
        assert.ok(wideTable.scrollWidth<=wideTable.clientWidth+1,'Wide fixed table should not need horizontal scrolling');
        await shot('frontend-table-1920.png');
        await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await sleep(250);
        await click('.nav-item[data-view="gantt"]');await waitFor('!document.getElementById("app-shell").classList.contains("view-table") && document.querySelector(".bar[data-id=sm-a]")','gantt restored');await sleep(150);
        assert.ok((await rect('#g-right')).width>0);assert.equal(await evaluate('JSON.stringify(proj.meta.cols)'),cols,'View switching must preserve saved column widths');
        await send('Emulation.setDeviceMetricsOverride',{width:360,height:1000,deviceScaleFactor:1,mobile:false});await sleep(250);
        if((await rect('.workspace-nav')).width>=100) await click('#nav-toggle');
        await waitFor('document.querySelector(".workspace-nav").getBoundingClientRect().width < 100','narrow navigation closed');
        const narrowSplitter=await rect('#splitter');assert.ok(narrowSplitter.width>0 && narrowSplitter.left>=0 && narrowSplitter.right<=361,'Narrow canvas splitter must stay on screen');
        assert.ok((await rect('#g-right')).width>=95,'Narrow canvas must retain a reachable timeline');
        await click('#nav-toggle');await waitFor('document.querySelector(".workspace-nav").getBoundingClientRect().width >= 100','narrow navigation expanded');
        const toggle=await point('#nav-toggle');assert.equal(await evaluate('document.elementFromPoint('+toggle.x+','+toggle.y+')?.closest("button")?.id'),'nav-toggle','Expanded narrow navigation must have a reachable close button');
        await shot('frontend-nav-360.png');await click('#nav-toggle');await waitFor('document.querySelector(".workspace-nav").getBoundingClientRect().width < 100','narrow navigation closed again');
        assert.ok(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1'),'Narrow navigation must not overflow the document');
        await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await sleep(250);
        await click('#nav-toggle');await sleep(150);assert.equal((await rect('.workspace-nav')).width,expanded.width);
        report.frontend.navigation={expanded:expanded.width,collapsed:collapsed.width,wideTable,narrowSplitter};
      });
      await check('selection actions keep row positions stable and open a focused right task drawer',async()=>{
        if(await evaluate('!document.getElementById("selection-toolbar").hidden')) await click('#selection-clear');
        const before=await rect('.t-row[data-id="sm-a"]');
        await click('.t-row[data-id="sm-a"] .t-name');await waitFor('!document.getElementById("selection-toolbar").hidden','selection actions visible');
        const selected=await rect('.t-row[data-id="sm-a"]');assert.equal(selected.top,before.top,'Selecting a row must not move it');
        await click('#selection-edit');await waitOverlay('ovl');await waitFor('document.activeElement === document.getElementById("f-name")','task drawer focus');
        const drawer=await rect('#ovl .task-drawer'),viewport=await evaluate('({width:innerWidth,height:innerHeight})');
        assert.ok(Math.abs(drawer.right-viewport.width)<=1,'Task drawer should anchor to the right edge');assert.ok(drawer.top>=-1 && drawer.bottom<=viewport.height+1,'Task drawer must fit vertically');
        assert.equal(await evaluate('document.getElementById("f-name").value'),'测试任务 A');
        await shot('frontend-task-drawer.png');
        const longName='长任务名称 · '+ '验收内容和操作入口 '.repeat(16);
        await fill('#f-name',longName);await click('#dlg-save');await waitFor('document.getElementById("ovl").hidden','long task name saved');
        for(const id of ['selection-edit','btn-del','selection-clear']){
          const p=await point('#'+id);assert.ok(p.x>=0 && p.x<=1440,id+' must remain on screen with a long selection label');
          assert.equal(await evaluate('document.elementFromPoint('+p.x+','+p.y+')?.closest("button")?.id'),id,id+' must remain reachable with a long selection label');
        }
        assert.ok(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth+1'),'Long selection text must not overflow the page');
        await shot('frontend-selection-long-name.png');
        await click('#selection-edit');await waitOverlay('ovl');await fill('#f-name','测试任务 A');await click('#dlg-save');await waitFor('document.getElementById("ovl").hidden','original task name restored');
        await click('#selection-clear');assert.equal(await evaluate('document.getElementById("selection-toolbar").hidden'),true);
        assert.equal((await rect('.t-row[data-id="sm-a"]')).top,before.top,'Clearing selection must not move the rows');report.frontend.drawer=drawer;
      });
      await check('action menus support real keyboard navigation and new item forms',async()=>{
        await click('#file-menu-toggle');await key('ArrowDown','ArrowDown',40);
        await waitFor('!document.getElementById("file-menu").hidden && document.activeElement.id === "btn-import"','file menu keyboard focus');
        await key('End','End',35);assert.equal(await evaluate('document.activeElement.id'),'btn-png');
        await key('Escape','Escape',27);assert.equal(await evaluate('document.getElementById("file-menu").hidden'),true);assert.equal(await evaluate('document.activeElement.id'),'file-menu-toggle');
        const tasks=await evaluate('JSON.stringify(proj.tasks)');
        await click('.t-row[data-id="sm-a"] .t-name');
        const selected=await evaluate('JSON.stringify([...selIds])');
        await click('#create-menu-toggle');await key('ArrowDown','ArrowDown',40);
        await waitFor('document.activeElement.id === "btn-add-pipe"','create menu first keyboard item');
        assert.equal(await evaluate('JSON.stringify([...selIds])'),selected,'Menu navigation must not change the selected task');
        report.frontend.createMenuBeforeEnter=await evaluate('({active:document.activeElement.id,selected:[...selIds],taskCount:proj.tasks.length,menuHidden:document.getElementById("create-menu").hidden})');
        await key('Enter','Enter',13);
        report.frontend.createMenuAfterEnter=await evaluate('({active:document.activeElement.id,selected:[...selIds],taskCount:proj.tasks.length,menuHidden:document.getElementById("create-menu").hidden,editorHidden:document.getElementById("ovl").hidden})');
        await waitOverlay('ovl');
        assert.equal(await evaluate('proj.tasks.length'),11);assert.equal(await evaluate('byId(selId).type'),'pipeline');
        assert.equal(await evaluate('document.getElementById("f-name").value'),'新管线','Enter should create the chosen item rather than edit the old selection');
        await shot('frontend-create-pipeline.png');await click('#dlg-cancel');await waitFor('document.getElementById("ovl").hidden','pipeline editor closed');
        await waitFor(storedProject+'.tasks.length === 11','new pipeline saved');await click('#btn-undo');
        await waitFor('proj.tasks.length === 10 && '+storedProject+'.tasks.length === 10','new pipeline undone');assert.equal(await evaluate('JSON.stringify(proj.tasks)'),tasks);
        await click('#btn-add-flag');await waitOverlay('flag-ovl');assert.equal(await evaluate('proj.flags.length'),1);
        await click('#fl-cancel');await waitFor('document.getElementById("flag-ovl").hidden','new milestone cancelled');assert.equal(await evaluate('proj.flags.length'),1);
      });
      await check('field manager has usable desktop columns and a scrollable narrow form',async()=>{
        const fields=await evaluate('JSON.stringify(proj.meta.customFields||[])');
        await click('#nav-fields');await waitOverlay('fields-ovl');
        const list=await rect('.fields-columns-pane'),form=await rect('.fields-form-pane'),modal=await rect('#fields-ovl .dlg');
        assert.ok(list.right<=form.left+1,'Field list and form should occupy separate desktop columns');assert.ok(modal.left>=0 && modal.right<=1440);
        await fill('#fields-add-name','未创建的草稿');await shot('frontend-fields-desktop.png');
        await click('#fields-done');await waitFor('document.getElementById("fields-ovl").hidden','desktop fields closed');
        assert.equal(await evaluate('JSON.stringify(proj.meta.customFields||[])'),fields,'Editing an unsaved draft must not add a field');
        await send('Emulation.setDeviceMetricsOverride',{width:720,height:1000,deviceScaleFactor:1,mobile:false});await sleep(200);
        await click('#btn-fields');await waitOverlay('fields-ovl');
        const narrowList=await rect('.fields-columns-pane'),narrowForm=await rect('.fields-form-pane'),narrowModal=await rect('#fields-ovl .dlg');
        assert.ok(narrowForm.top>=narrowList.bottom-1,'Narrow field manager should stack the list and form');assert.ok(narrowModal.left>=-1 && narrowModal.right<=721);
        await fill('#fields-add-name','窄窗口草稿');assert.equal(await evaluate('document.getElementById("fields-add-name").value'),'窄窗口草稿');
        await shot('frontend-fields-720.png');await click('#fields-done');await waitFor('document.getElementById("fields-ovl").hidden','narrow fields closed');
        assert.equal(await evaluate('JSON.stringify(proj.meta.customFields||[])'),fields);
        await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await sleep(200);
        report.frontend.fields={list,form,modal,narrowList,narrowForm,narrowModal};
      });
    }
    await check('no uncaught browser exceptions', async () => { assert.deepEqual(pageErrors, []); });
    await shot('browser-smoke-final.png');
    report.ok = true;
    fs.writeFileSync(path.join(output, reportName), JSON.stringify(report, null, 2));
    console.log(`${frontendMode ? 'Frontend' : 'Browser'} smoke passed: ${checks.length} checks. Report: ${path.join(output, reportName)}`);
  } catch (error) {
    if (captureFailure) await captureFailure();
    report.ok = false; report.error = error.stack || String(error);
    fs.writeFileSync(path.join(output, reportName), JSON.stringify(report, null, 2));
    throw error;
  } finally {
    if (closeBrowser && !browserExited) await Promise.race([closeBrowser(), sleep(2000)]);
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    if (!browserExited) { child.kill(); await sleep(300); }
    // Only remove the exact directory returned by mkdtemp, inside the OS temp directory.
    if (path.dirname(path.resolve(profile)) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('schedule-gantt-smoke-')) {
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch (error) { console.warn(`Temporary Chrome profile cleanup failed: ${error.message}`); }
    }
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
