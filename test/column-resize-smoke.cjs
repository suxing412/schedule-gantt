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
const downloads = path.join(output, `column-resize-smoke-downloads-${Date.now()}-${process.pid}`);
const chromePath = process.env.SMOKE_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const customFieldsMode = process.env.SMOKE_CUSTOM_FIELDS === '1';
const reportFile = path.join(output, customFieldsMode ? 'custom-fields-smoke-results.json' : 'column-resize-smoke-results.json');
const checks = [];
const pageErrors = [];
const consoleErrors = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { browser: null, previewUrl:previewUrl.href, checks, pageErrors, consoleErrors, screenshots: [], viewportSnapshots: [], desktopLayouts: [], downloads: [] };

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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-gantt-column-smoke-'));
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
    on('Runtime.consoleAPICalled', params => { if(params.type==='error')consoleErrors.push(params.args.map(arg=>arg.value??arg.description??arg.type).join(' ')); });
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
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: virtual, modifiers });
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
      const file = path.join(output, name);
      fs.writeFileSync(file, Buffer.from(data, 'base64')); report.screenshots.push(file);
    };
    captureFailure = () => shot('column-resize-smoke-failure.png').catch(() => {});
    const check = async (name, operation) => {
      await operation(); checks.push({ name, ok: true }); console.log(`PASS ${name}`);
    };
    const project = fixture();
    for (let i = 0; i < 24; i++) project.tasks.push({ ...project.tasks[9], id: 'column-row-' + i, name: '列宽与滚动测试任务 ' + (i + 1), who: '测试成员 ' + (i + 1), deps: [] });
    const seed = JSON.stringify(project);
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `if (location.href.split('#')[0] === ${JSON.stringify(previewUrl.href)} && !localStorage.getItem('schedule-data')) localStorage.setItem('schedule-data', ${JSON.stringify(seed)});` });
    await send('Page.navigate', { url: previewUrl.href });
    await waitFor(`typeof proj !== 'undefined' && proj && document.querySelector('.bar[data-id="sm-a"]')`, 'initial task rendering');
    await sleep(400);


    const keys = ['name', 'person', 'start', 'end', 'pct'];
    const selectors = { name: '.col-name', person: '.col-person', start: '.col-start', end: '.col-end', pct: '.col-pct' };
    report.columnSnapshots = [];
    const taskSnapshot = await evaluate('JSON.stringify(proj.tasks)');
    await evaluate('window.__resizeSmokePointer=null; document.addEventListener("pointermove",event=>{window.__resizeSmokePointer={x:event.clientX,y:event.clientY,buttons:event.buttons,pointerId:event.pointerId};},true); true');
    const snapshot = async (label,raf=false) => {
      const expression = '(() => {' +
        'const keys = ' + JSON.stringify(keys) + ', selectors = ' + JSON.stringify(selectors) + ';' +
        'const header = document.getElementById("g-left-hd"), body = document.getElementById("g-left-body");' +
        'const ids=visibleTableColumns().map(column=>column.id);' +
        'const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { left:r.left, right:r.right, width:r.width, top:r.top, height:r.height }; };' +
        'const columns = el => Object.fromEntries(ids.map(id => [id, rect(el.querySelector(".col[data-col="+CSS.escape(id)+"]"))]));' +
        'return { columnIds:ids, cols: { ...colW() }, storedCols: { ...proj.meta.cols }, paneAuto:proj.meta.paneAuto, savedPaneWidth:proj.meta.lw, unpinName:document.getElementById("g-left").classList.contains("unpin-name"), pointer:window.__resizeSmokePointer, headers: columns(header.querySelector(".g-left-cols")),' +
        'rows: [...body.querySelectorAll(".t-row")].slice(0,3).map(columns),' +
        'tableWidth: rect(header.querySelector(".g-left-cols")).width,' +
        'tableContentWidth:ids.reduce((sum,id)=>sum+rect(header.querySelector(".col[data-col="+CSS.escape(id)+"]")).width,0),' +
        'tableCssWidth:parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--table-w")),' +
        'bodyLeft:rect(body).left+body.clientLeft,bodyRight:rect(body).left+body.clientLeft+body.clientWidth,bodyScrollbarWidth:body.offsetWidth-body.clientWidth,' +
        'leftWidth: rect(document.getElementById("g-left")).width, headerScrollLeft:header.scrollLeft, bodyScrollLeft:body.scrollLeft,' +
        'headerClientWidth:header.clientWidth, bodyClientWidth:body.clientWidth, bodyScrollWidth:body.scrollWidth,' +
        'chartWidth:document.getElementById("g-right").clientWidth, viewport:innerWidth, documentWidth:document.documentElement.scrollWidth,' +
        'documentClientWidth:document.documentElement.clientWidth, scrollX }; })()';
      const state = await evaluate(raf?'new Promise(resolve=>requestAnimationFrame(()=>resolve('+expression+')))':expression);
      report.columnSnapshots.push({ label, ...state });
      return state;
    };
    const near=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<=1,message+': '+actual+' vs '+expected);
    const assertAlignment=(state,label,preview={})=>{
      assert.ok(state.rows.length,label+': rows missing');let total=0;
      for(const id of state.columnIds){
        const expected=preview[id]??state.cols[id],head=state.headers[id];near(head.width,expected,label+': fixed width '+id);
        const expectedLeft=id==='name'&&!state.unpinName?state.bodyLeft:state.bodyLeft+total-state.bodyScrollLeft;
        near(head.left,expectedLeft,label+': column position '+id);total+=expected;
        for(const row of state.rows){near(row[id].width,head.width,label+': row width '+id);near(row[id].left,head.left,label+': row left '+id);near(row[id].right,head.right,label+': row right '+id);}
      }
      near(state.tableContentWidth,total,label+': visible column sum');near(state.tableCssWidth,total,label+': CSS column sum');
      near(state.headerScrollLeft,state.bodyScrollLeft,label+': shared horizontal offset');assert.ok(state.tableWidth>=total-1,label+': header clips its column container');
    };
    const sameWidths=(before,after,label,except)=>{
      for(const id of before.columnIds) if(id!==except) near(after.headers[id].width,before.headers[id].width,label+': changed physical width '+id);
      for(const [id,width] of Object.entries(before.cols)) if(id!==except) assert.equal(after.cols[id],width,label+': changed saved width '+id);
    };
    const revealHandle=async id=>{
      await evaluate('(() => {const body=document.getElementById("g-left-body"),cell=document.querySelector('+JSON.stringify('#g-left-hd .col[data-col="')+'+'+JSON.stringify(id)+'+'+JSON.stringify('"]')+'),r=cell.getBoundingClientRect(),b=body.getBoundingClientRect(),name=document.querySelector("#g-left-hd .col-name").getBoundingClientRect();const low='+JSON.stringify(id==='name')+';const safeLeft=low||document.getElementById("g-left").classList.contains("unpin-name")?b.left+12:name.right+12,target=r.right-5,safeRight=b.left+body.clientWidth-12;if(target>safeRight)body.scrollLeft+=target-safeRight;else if(target<safeLeft)body.scrollLeft-=safeLeft-target;return true;})()');
      await waitFor('Math.abs(document.getElementById("g-left-hd").scrollLeft-document.getElementById("g-left-body").scrollLeft)<=1','resize scroll synchronization');
      const p=await evaluate('(() => {const r=document.querySelector('+JSON.stringify('#g-left-hd .col-rz[data-col="'+id+'"]')+').getBoundingClientRect();return {x:r.left+r.width/2,y:r.bottom-8};})()');
      assert.equal(await evaluate('document.elementFromPoint('+p.x+','+p.y+')?.closest(".col-rz")?.dataset.col'),id,'Resize grip must receive physical input: '+id);return p;
    };
    const panePoint=async()=>{
      const center=await point('#splitter');
      const probes=await evaluate('[-5,-3,-1,0,1,3,5].map(dx=>({x:'+center.x+'+dx,y:'+center.y+',hit:document.elementFromPoint('+center.x+'+dx,'+center.y+')?.closest("#splitter")?.id}))');
      const p=probes.find(probe=>probe.hit==='splitter');assert.ok(p,'Pane grip must receive physical input');return p;
    };
    let blurSession,nativeTabBlurSupported;
    const blurPointerDraft=async()=>{
      await evaluate('window.__resizeSmokeBlur=0;window.addEventListener("blur",()=>window.__resizeSmokeBlur++,{once:true});true');
      const focusState=()=>evaluate('({focused:document.hasFocus(),visibility:document.visibilityState,active:document.activeElement?.id,blurCount:window.__resizeSmokeBlur})');
      const diagnostic={before:await focusState()};report.blurFocusDiagnostics=(report.blurFocusDiagnostics||[]).concat([diagnostic]);
      if(nativeTabBlurSupported!==false){
        if(!blurSession){const target=await command('Target.createTarget',{url:'about:blank'});blurSession=(await command('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;}
        await command('Page.bringToFront',{},blurSession);
        for(const type of ['mouseMoved','mousePressed','mouseReleased'])await command('Input.dispatchMouseEvent',{type,x:20,y:20,...(type==='mouseMoved'?{}:{button:'left',buttons:type==='mousePressed'?1:0,clickCount:1})},blurSession);
        await sleep(150);diagnostic.afterTabClick=await focusState();
        nativeTabBlurSupported=diagnostic.afterTabClick.blurCount>0;
        report.nativeTabBlurSupported=nativeTabBlurSupported;
      }
      diagnostic.mode=nativeTabBlurSupported?'native-tab-blur':'explicit-window-blur-event';
      // Headless Chrome can activate the other page without emitting window blur.
      // Record that limitation and exercise the same registered cancel handler.
      if(!nativeTabBlurSupported)await evaluate('window.dispatchEvent(new Event("blur"));true');
      await waitFor('window.__resizeSmokeBlur>0','window blur cancellation event');await send('Page.bringToFront');
    };
    const gesture=async(kind,id,moves,options={})=>{
      await send('Page.bringToFront');const p=kind==='pane'?await panePoint():await revealHandle(id);
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y});
      const before=await snapshot(kind+' '+id+' before down',true);
      await send('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',buttons:1,clickCount:1});
      const down=await snapshot(kind+' '+id+' down',true);sameWidths(before,down,'pointerdown');near(down.leftWidth,before.leftWidth,'pointerdown pane jump');
      const trace={kind,id,start:p,before,down,frames:[]};report.resizeTraces=(report.resizeTraces||[]).concat([trace]);
      for(const delta of moves){
        await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x+delta,y:p.y,button:'left',buttons:1});
        const frame=await snapshot(kind+' '+id+' move '+delta,true);trace.frames.push({delta,state:frame});
        if(frame.pointer)near(frame.pointer.x,p.x+delta,'pointer event coordinate');
        if(kind==='pane'){
          assertAlignment(frame,'live pane');
          sameWidths(before,frame,'live pane resize');
          if(options.bounds)near(frame.leftWidth,Math.max(options.bounds.min,Math.min(options.bounds.max,before.leftWidth+delta)),'pane limit frame');
          else near(frame.leftWidth,before.leftWidth+delta,'pane frame follows pointer');
        }else{
          sameWidths(before,frame,'live column resize',id);near(frame.leftWidth,before.leftWidth,'column resize moved pane');
          const scrollDelta=id==='name'&&!before.unpinName?0:frame.bodyScrollLeft-before.bodyScrollLeft;
          near(frame.headers[id].width,before.headers[id].width+delta+scrollDelta,'column frame follows pointer');
          near(frame.headers[id].right,before.headers[id].right+delta,'column visible boundary follows pointer');
          assertAlignment(frame,'live column '+id,{[id]:before.headers[id].width+delta+scrollDelta});
        }
        assert.deepEqual(frame.storedCols,before.storedCols,'Uncommitted pointer draft must not mutate saved columns');
        assert.equal(frame.savedPaneWidth,before.savedPaneWidth,'Uncommitted pointer draft must not mutate saved pane');
      }
      if(options.hold)await sleep(options.hold);
      if(options.beforeRelease)await options.beforeRelease(trace);
      if(options.cancel==='escape')await key('Escape','Escape',27);
      if(options.cancel==='blur')await blurPointerDraft();
      const delta=moves.at(-1)||0,last=trace.frames.at(-1)?.state||down;
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x+delta,y:p.y,button:'left',buttons:0,clickCount:1});
      trace.release=await snapshot(kind+' '+id+' release',true);trace.settled=await snapshot(kind+' '+id+' next frame',true);
      const expected=options.cancel?before:last;
      for(const state of [trace.release,trace.settled]){sameWidths(expected,state,'release',kind==='column'&&!options.cancel?id:undefined);for(const column of expected.columnIds)near(state.headers[column].width,expected.headers[column].width,'release physical column jump '+column);if(kind==='column')near(state.headers[id].right,expected.headers[id].right,'release column boundary jump');near(state.leftWidth,expected.leftWidth,'release pane jump');assertAlignment(state,'release alignment');}
      if(options.cancel){assert.deepEqual(trace.settled.storedCols,before.storedCols);assert.equal(trace.settled.savedPaneWidth,before.savedPaneWidth);assert.equal(trace.settled.paneAuto,before.paneAuto);}
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x+delta+9,y:p.y});
      const idle=await snapshot(kind+' '+id+' idle pointer',true);sameWidths(trace.settled,idle,'idle pointer after release');near(idle.leftWidth,trace.settled.leftWidth,'idle pointer changed pane');
      return trace;
    };
    const dragColumn=(id,distance,cancel,hold=0)=>gesture('column',id,[distance/4,distance/2,distance*3/4,distance],{cancel,hold});
    const doubleClickHandle=async id=>{const p=await revealHandle(id);await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y});for(let count=1;count<=2;count++){await send('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',buttons:1,clickCount:count});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',buttons:0,clickCount:count});}await snapshot('double click '+id,true);};
    const reloadColumns=async label=>{await send('Page.reload');await waitFor('typeof proj!=="undefined" && proj && document.querySelector("#g-left-hd .col-rz[data-col=name]")',label);await sleep(180);return snapshot(label);};
    const resetPane=async()=>{await click('#layout-reset');await snapshot('pane proportion restored',true);};
    const resetColumns=async()=>{await click('#btn-fields');await waitFor('!document.getElementById("fields-ovl").hidden && document.getElementById("fields-ovl").getAnimations({subtree:true}).every(a=>a.playState==="finished")','field manager ready');await click('#fields-reset-widths');await click('#fields-done');await waitFor('document.getElementById("fields-ovl").hidden','field manager closed');};
    const defaults={name:248,person:88,start:88,end:88,pct:64};
    await check('legacy layouts migrate once to fixed independent columns',async()=>{
      const state=await snapshot('version two defaults');for(const id of keys)assert.equal(state.cols[id],defaults[id]);
      assert.equal(await evaluate('proj.meta.layoutVersion'),2);assert.equal(state.paneAuto,true);assert.equal(state.savedPaneWidth,576);
      assert.equal(await evaluate('"date" in proj.meta.cols'),false);assert.equal(await evaluate('!!document.getElementById("fields-name-auto")'),false);
      near(state.bodyRight,state.headers.end.right,'Automatic starting pane must end at the complete nearest column');
      assertAlignment(state,'default fixed columns');await shot('column-resize-initial.png');
    });
    await check('pane resize follows every pointer frame without changing column widths or jumping on release',async()=>{
      const trace=await gesture('pane','splitter',[3,9,24,18,80]);assert.equal(trace.settled.paneAuto,false);
      near(trace.settled.savedPaneWidth,trace.settled.leftWidth,'Committed pane must save actual physical width');await shot('pane-resize-expanded.png');
      await waitFor(storedProject+'.meta.paneAuto === false && Math.abs('+storedProject+'.meta.lw - '+trace.settled.leftWidth+')<=1','pane commit stored');
    });
    await check('CSS clamped pane resize begins at its actual narrow viewport width',async()=>{
      await gesture('pane','splitter',[120]);await send('Emulation.setDeviceMetricsOverride',{width:720,height:1000,deviceScaleFactor:1,mobile:false});await sleep(250);
      const narrow=await snapshot('narrow pane actual start');assert.ok(narrow.savedPaneWidth>narrow.leftWidth+12,'Fixture must exercise a saved pane width larger than the displayed CSS clamp');
      await gesture('pane','splitter',[-3,-8,-12]);await shot('pane-resize-css-clamp.png');
      await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await sleep(250);await resetPane();
    });
    await check('pane limits clamp overshoot and recover on reverse motion',async()=>{
      const start=await snapshot('before pane limits'),bounds=await evaluate('paneBounds()');const maximum=bounds.max-start.leftWidth;
      await gesture('pane','splitter',[maximum+12,maximum-8,0],{bounds,cancel:'escape'});
      const minimum=bounds.min-start.leftWidth;await gesture('pane','splitter',[minimum-12,minimum+8,0],{bounds,cancel:'escape'});
    });
    const distances={name:36,person:24,start:20,end:32,pct:16};
    for(const id of keys)await check('independent '+id+' column follows each pointer frame and release',async()=>{await dragColumn(id,distances[id]);});
    await check('start and end retain separate fixed widths',async()=>{const state=await snapshot('independent date columns');assert.equal(state.cols.start,defaults.start+20);assert.equal(state.cols.end,defaults.end+32);assert.notEqual(state.cols.start,state.cols.end);});
    await check('Escape rolls back pane and column drafts even while a pending save fires',async()=>{
      await dragColumn('pct',8);const before=await snapshot('before pending save cancellation');
      await gesture('pane','splitter',[3,12,24],{cancel:'escape',hold:550,beforeRelease:async()=>{const saved=await evaluate(storedProject);assert.equal(saved.meta.lw,before.savedPaneWidth);assert.deepEqual(saved.meta.cols,before.storedCols);}});
      await dragColumn('person',24,'escape',550);await sleep(450);assert.deepEqual(await evaluate(storedProject+'.meta.cols'),before.storedCols);
      assert.equal(await evaluate(storedProject+'.meta.lw'),before.savedPaneWidth);
    });
    await check('window blur handler cancels pane and column pointer drafts',async()=>{await gesture('pane','splitter',[3,14],{cancel:'blur'});await dragColumn('end',20,'blur');});
    await check('fixed widths and manual pane survive reload without task metadata loss',async()=>{
      await gesture('pane','splitter',[24]);const expected=await evaluate('JSON.stringify(proj)');await waitFor('JSON.stringify('+storedProject+') === '+JSON.stringify(expected),'complete layout saved');
      const identity=await evaluate('JSON.parse(localStorage.getItem("schedule-data")).projectId');const after=await reloadColumns('fixed layout reloaded');
      assert.equal(await evaluate('JSON.stringify(proj)'),expected);assert.equal(await evaluate('JSON.stringify(proj.tasks)'),taskSnapshot);assert.equal(await evaluate('JSON.parse(localStorage.getItem("schedule-data")).projectId'),identity);assertAlignment(after,'reloaded fixed widths');
    });
    await check('horizontal scrolling synchronizes fixed headers and rows without document overflow',async()=>{
      for(const width of [720,900,1100,1440]){await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});await sleep(250);await evaluate('document.getElementById("g-left-body").scrollLeft=0;true');await snapshot('horizontal left '+width,true);
        await evaluate('document.getElementById("g-left-body").scrollLeft=document.getElementById("g-left-body").scrollWidth;true');const state=await snapshot('horizontal right '+width,true);assertAlignment(state,'horizontal '+width);assert.ok(state.documentWidth<=state.documentClientWidth+1);assert.ok(state.chartWidth>0);assert.equal(state.scrollX,0);}
      await shot('column-resize-fixed-scroll.png');
    });
    await check('oversized name unpins instead of shrinking or blocking the other fixed columns',async()=>{
      const before=await snapshot('before oversized name');await dragColumn('name',620-before.headers.name.width);
      const wide=await snapshot('oversized fixed name');assert.equal(wide.cols.name,620);near(wide.headers.name.width,620,'Oversized name width must remain physical');assert.equal(wide.unpinName,true);
      await evaluate('document.getElementById("g-left-body").scrollLeft=document.getElementById("g-left-body").scrollWidth;true');const scrolled=await snapshot('oversized name scrolled',true);assertAlignment(scrolled,'unpin scrolling');assert.ok(scrolled.headers.name.left<scrolled.bodyLeft);
      await dragColumn('person',8);await dragColumn('person',-8);await shot('column-name-unpinned.png');await resetColumns();await evaluate('document.getElementById("g-left-body").scrollLeft=0;true');
      const restored=await snapshot('name pin restored',true);assert.equal(restored.unpinName,false);assertAlignment(restored,'restored name pin');
    });
    await check('content fit uses fixed widths and leaves the pane and other columns alone',async()=>{
      const before=await snapshot('before content fit');await dragColumn('person',320-before.headers.person.width);await doubleClickHandle('person');await waitFor('colW().person<320','person content fit');
      const fitted=await snapshot('person fit');sameWidths(before,fitted,'content fit','person');near(fitted.leftWidth,before.leftWidth,'content fit changed pane');assertAlignment(fitted,'content fit');
      for(const item of await evaluate('[...document.querySelectorAll(".t-row .col-person")].map(el=>({client:el.clientWidth,scroll:el.scrollWidth}))'))assert.ok(item.scroll<=item.client+1);
      await doubleClickHandle('name');const nameFit=await snapshot('name content fit');sameWidths(fitted,nameFit,'name content fit','name');near(nameFit.leftWidth,fitted.leftWidth,'Name fit changed pane');assertAlignment(nameFit,'name fit');for(const item of await evaluate('[...document.querySelectorAll(".t-row .t-name")].map(el=>({client:el.clientWidth,scroll:el.scrollWidth}))'))assert.ok(item.scroll<=item.client+1);
      await shot('column-content-fit.png');
    });
    await check('default column reset and proportional pane reset are explicit independent controls',async()=>{
      const paneBefore=await snapshot('before column reset');await resetColumns();const reset=await snapshot('column defaults reset');for(const id of keys)assert.equal(reset.cols[id],defaults[id]);near(reset.leftWidth,paneBefore.leftWidth,'Column reset changed pane');assertAlignment(reset,'column reset');
      await resetPane();const automatic=await snapshot('pane reset');assert.equal(automatic.paneAuto,true);sameWidths(reset,automatic,'Pane reset changed columns');
      await send('Emulation.setDeviceMetricsOverride',{width:1920,height:1000,deviceScaleFactor:1,mobile:false});await sleep(250);const wider=await snapshot('proportional pane wide');assert.equal(wider.paneAuto,true);assert.ok(wider.leftWidth<=577);sameWidths(automatic,wider,'Auto pane changed columns');assert.ok(wider.bodyClientWidth>=wider.tableContentWidth-1,'Wide default pane should contain the default columns');
      await shot('column-resize-wide.png');await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await sleep(250);
    });
    await check('add field command opens its manager and focuses the new field name',async()=>{
      await click('#header-add-field');await waitFor('!document.getElementById("fields-ovl").hidden && document.activeElement===document.getElementById("fields-add-name")','add field focus');await waitFor('document.getElementById("fields-ovl").getAnimations({subtree:true}).every(a=>a.playState==="finished")','field manager entrance');await shot('column-add-field.png');await click('#fields-done');await waitFor('document.getElementById("fields-ovl").hidden','field manager closed');
    });

    if (customFieldsMode) {
      const fieldIds = {};
      const fieldSelector = id => '[data-custom-field-id="' + id + '"]';
      const managerRow = id => '.fields-row[data-column-id="' + id + '"]';
      const taskCell = id => '.t-row[data-id="sm-a"] .col[data-col="' + id + '"]';
      const taskDates = await evaluate('JSON.stringify({s:byId("sm-a").s,e:byId("sm-a").e})');
      const selectValue = async (selector, value) => {
        const index = await evaluate('Array.from(document.querySelector(' + JSON.stringify(selector) + ').options).findIndex(option=>option.value===' + JSON.stringify(value) + ')');
        assert.ok(index >= 0, 'Missing option ' + value);
        await click(selector); await key('Home','Home',36);
        for (let i=0;i<index;i++) await key('ArrowDown','ArrowDown',40);
        // Enter is the task dialog's save shortcut. Tab commits a native select
        // without accidentally submitting the rest of the task editor early.
        await key('Tab','Tab',9);
        assert.equal(await evaluate('document.querySelector(' + JSON.stringify(selector) + ').value'),value);
      };
      const openFields = async () => { await click('#btn-fields'); await waitFor('!document.getElementById("fields-ovl").hidden','field manager open'); };
      const closeFields = async () => { await click('#fields-done'); await waitFor('document.getElementById("fields-ovl").hidden','field manager close'); };
      const openTask = async (id='sm-a') => { await click('.t-row[data-id="'+id+'"] .col-name',2); await waitFor('!document.getElementById("ovl").hidden','custom task editor open'); await waitFor('document.activeElement === document.getElementById("f-name")','task editor initial autofocus'); };
      const saveTask = async () => { await click('#dlg-save'); await waitFor('document.getElementById("ovl").hidden','custom task editor saved'); };
      await openFields();
      for (const definition of [
        {key:'priority',name:'优先级',type:'select',options:'高\n中\n低'},
        {key:'hours',name:'工时',type:'number'},
        {key:'note',name:'备注',type:'text'},
        {key:'date',name:'验收日期',type:'date'},
        {key:'confirmed',name:'确认',type:'checkbox'}
      ]) {
        await check('field manager creates '+definition.type+' through its controls', async () => {
          const count = await evaluate('(proj.meta.customFields||[]).length');
          if(definition.key==='priority') await click('button[data-field-preset="priority"]');
          else {
            await fill('#fields-add-name',definition.name);
            await selectValue('#fields-add-type',definition.type);
            if(definition.options) await fill('#fields-add-options',definition.options);
            await click('#fields-add');
          }
          await waitFor('(proj.meta.customFields||[]).length === '+(count+1),'custom field added');
          const field = await evaluate('proj.meta.customFields.at(-1)');fieldIds[definition.key]=field.id;
          assert.equal(field.name,definition.name);assert.equal(field.type,definition.type);
          const geometry = await evaluate('(() => { const body=document.getElementById("g-left-body"),header=document.getElementById("g-left-hd"),cell=header.querySelector(' + JSON.stringify('.col[data-col="'+field.id+'"]') + '),r=cell.getBoundingClientRect(),b=body.getBoundingClientRect();return {right:r.right,visibleRight:b.left+body.clientWidth,headerScroll:header.scrollLeft,bodyScroll:body.scrollLeft};})()');
          assert.ok(geometry.right<=geometry.visibleRight+1,'The newly created column must be revealed at the right edge');
          assert.ok(Math.abs(geometry.headerScroll-geometry.bodyScroll)<=1,'Header must follow new-column scrolling');
          if(definition.options) assert.deepEqual(field.options.map(option=>option.label),['高','中','低']);
        });
      }
      await shot('custom-fields-manager.png');await closeFields();
      const priority = await evaluate('proj.meta.customFields.find(field=>field.id==='+JSON.stringify(fieldIds.priority)+')');
      const selectedOptionId=priority.options[0].id;
      const note='<b>需评审</b> & literal';
      let customDate;
      await check('task editor saves all five types, zero and literal HTML without changing schedule dates',async()=>{
        await openTask();
        await selectValue(fieldSelector(fieldIds.priority),selectedOptionId);
        await fill(fieldSelector(fieldIds.hours),'0');await fill(fieldSelector(fieldIds.note),note);
        // Chromium exposes the date as segmented locale controls. Use its native
        // DOM value setter for an ISO date, then exercise the real save/renderer.
        await evaluate('(() => {const input=document.querySelector('+JSON.stringify(fieldSelector(fieldIds.date))+');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"2026-10-23");input.dispatchEvent(new Event("input",{bubbles:true}));input.dispatchEvent(new Event("change",{bubbles:true}));return input.value;})()');
        await click(fieldSelector(fieldIds.date));
        for(let i=0;i<3;i++) await key('ArrowLeft','ArrowLeft',37);
        await key('ArrowUp','ArrowUp',38);
        customDate=await evaluate('document.querySelector('+JSON.stringify(fieldSelector(fieldIds.date))+').value');
        assert.match(customDate,/^\d{4}-\d{2}-\d{2}$/);assert.notEqual(customDate,'2026-10-23','A real keyboard edit must change the segmented date control');
        await click(fieldSelector(fieldIds.confirmed));await shot('custom-fields-task-editor.png');await saveTask();
        const values=await evaluate('byId("sm-a").customValues');
        assert.deepEqual(values,{[fieldIds.priority]:selectedOptionId,[fieldIds.hours]:0,[fieldIds.note]:note,[fieldIds.date]:customDate,[fieldIds.confirmed]:true});
        assert.equal(await evaluate('JSON.stringify({s:byId("sm-a").s,e:byId("sm-a").e})'),taskDates);
        assert.equal(await evaluate('document.querySelector('+JSON.stringify(taskCell(fieldIds.note))+').textContent'),note);
        assert.equal(await evaluate('!!document.querySelector('+JSON.stringify(taskCell(fieldIds.note))+').querySelector("b")'),false,'Custom HTML text must not become markup');
        assert.equal(await evaluate('document.querySelector('+JSON.stringify(taskCell(fieldIds.confirmed))+').textContent'),'✓');
      });
      await check('fractional numbers and false checkbox values survive editor reopen',async()=>{
        await openTask();assert.equal(await evaluate('document.querySelector('+JSON.stringify(fieldSelector(fieldIds.hours))+').value'),'0');
        await fill(fieldSelector(fieldIds.hours),'2.5');await saveTask();
        await openTask('sm-b');await fill(fieldSelector(fieldIds.hours),'0');await saveTask();
        const values=await evaluate('({a:byId("sm-a").customValues,b:byId("sm-b").customValues})');
        assert.equal(values.a[fieldIds.hours],2.5);assert.equal(values.b[fieldIds.hours],0);assert.equal(values.b[fieldIds.confirmed],false);
      });
      await check('renaming and reordering select options retain the existing selected option ID',async()=>{
        await openFields();await click(managerRow(fieldIds.priority)+' button[aria-label^="编辑"]');
        await fill('#fields-edit-name','重要程度');
        await fill('.fields-option-row[data-option-id="'+selectedOptionId+'"] .fields-option-label','紧急');
        await click('.fields-option-row[data-option-id="'+selectedOptionId+'"] button[aria-label="将此选项向后移动"]');
        await click('#fields-edit-save');await closeFields();
        const field=await evaluate('proj.meta.customFields.find(field=>field.id==='+JSON.stringify(fieldIds.priority)+')');
        assert.equal(field.name,'重要程度');assert.equal(field.options[1].id,selectedOptionId);assert.equal(field.options[1].label,'紧急');
        assert.equal(await evaluate('byId("sm-a").customValues['+JSON.stringify(fieldIds.priority)+']'),selectedOptionId);
        assert.equal(await evaluate('document.querySelector('+JSON.stringify(taskCell(fieldIds.priority))+').textContent'),'紧急');
      });
      await check('hiding preserves values and moving custom columns keeps the name first',async()=>{
        await openFields();await click(managerRow(fieldIds.note)+' input[type="checkbox"]');
        await click(managerRow('person')+' input[type="checkbox"]');
        let index=await evaluate('allTableColumns().findIndex(column=>column.id==='+JSON.stringify(fieldIds.confirmed)+')');
        while(index>1){await click(managerRow(fieldIds.confirmed)+' button[aria-label*="向前移动"]');index--;}
        await closeFields();
        assert.equal(await evaluate('!!document.querySelector('+JSON.stringify(taskCell(fieldIds.note))+')'),false);
        assert.equal(await evaluate('byId("sm-a").customValues['+JSON.stringify(fieldIds.note)+']'),note);
        const visible=await evaluate('visibleTableColumns().map(column=>column.id)');assert.deepEqual(visible.slice(0,2),['name',fieldIds.confirmed]);
        assert.equal(visible.includes('person'),false);report.fieldColumnOrder=visible;
      });
      await check('new custom column resize aligns every header and row and saves its own width',async()=>{
        const before=await evaluate('colW()['+JSON.stringify(fieldIds.hours)+']');await dragColumn(fieldIds.hours,40);
        assert.equal(await evaluate('colW()['+JSON.stringify(fieldIds.hours)+']'),before+40);
        const geometry=await evaluate('(() => {const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,width:r.width}};return {head:rect(document.querySelector('+JSON.stringify('#g-left-hd .col[data-col="'+fieldIds.hours+'"]')+')),rows:[...document.querySelectorAll('+JSON.stringify('.t-row .col[data-col="'+fieldIds.hours+'"]')+')].map(rect)};})()');
        for(const row of geometry.rows){assert.ok(Math.abs(row.width-geometry.head.width)<=1);assert.ok(Math.abs(row.left-geometry.head.left)<=1);}
        await shot('custom-fields-values.png');
      });
      await check('custom definitions, values, order, visibility and widths persist after real reload',async()=>{
        const expected=await evaluate('JSON.stringify(proj)');
        await waitFor('JSON.stringify('+storedProject+') === '+JSON.stringify(expected),'complete custom project stored');
        report.fieldProjectId=await evaluate('JSON.parse(localStorage.getItem("schedule-data")).projectId');
        const loaded=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Field reload timed out')),5000);on('Page.loadEventFired',()=>{clearTimeout(timer);resolve();});});
        await send('Page.reload');await loaded;await sleep(200);
        await waitFor('typeof proj!=="undefined" && proj && document.querySelector("#btn-fields")','custom project reloaded');
        assert.equal(await evaluate('JSON.stringify(proj)'),expected);
        assert.equal(await evaluate('JSON.parse(localStorage.getItem("schedule-data")).projectId'),report.fieldProjectId);
        await shot('custom-fields-reloaded.png');
      });
      await check('JSON and PNG downloads include the current custom field view',async()=>{
        const waitDownload=async start=>{const deadline=Date.now()+10000;while(Date.now()<deadline){const entry=downloadEvents.slice(start).find(item=>item.state==='completed');if(entry&&fs.existsSync(path.join(downloads,entry.suggestedFilename)))return entry;await sleep(100);}throw new Error('Custom export download timed out');};
        let start=downloadEvents.length;await click('#btn-export');let entry=await waitDownload(start);
        const jsonPath=path.join(downloads,entry.suggestedFilename),exported=JSON.parse(fs.readFileSync(jsonPath,'utf8'));
        assert.deepEqual(exported,await evaluate('proj'));report.downloads.push({kind:'json',path:jsonPath,bytes:fs.statSync(jsonPath).size});
        start=downloadEvents.length;await click('#btn-png');entry=await waitDownload(start);
        const pngPath=path.join(downloads,entry.suggestedFilename),png=fs.readFileSync(pngPath);assert.equal(png.subarray(1,4).toString(),'PNG');
        report.downloads.push({kind:'png',path:pngPath,bytes:png.length,width:png.readUInt32BE(16),height:png.readUInt32BE(20)});
        report.expectedPngHeaders=await evaluate('visibleTableColumns().map(column=>column.name)');report.fieldIds=fieldIds;report.customDate=customDate;
      });
    }
    await check('no uncaught browser exceptions or console errors', async () => { assert.deepEqual(pageErrors, []); assert.deepEqual(consoleErrors, []); });
    await shot('column-resize-final.png');
    report.ok=true;
    fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
    console.log((customFieldsMode?'Custom fields':'Column resize')+' smoke passed: '+checks.length+' checks. Report: '+reportFile);
  } catch (error) {
    if (captureFailure) await captureFailure();
    report.ok = false; report.error = error.stack || String(error);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    throw error;
  } finally {
    if (closeBrowser && !browserExited) await Promise.race([closeBrowser(), sleep(2000)]);
    if (socket && socket.readyState === WebSocket.OPEN) socket.close();
    if (!browserExited) { child.kill(); await sleep(300); }
    // Only remove the exact directory returned by mkdtemp, inside the OS temp directory.
    if (path.dirname(path.resolve(profile)) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('schedule-gantt-column-smoke-')) {
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
      catch (error) { console.warn(`Temporary Chrome profile cleanup failed: ${error.message}`); }
    }
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
