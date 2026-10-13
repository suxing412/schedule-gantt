const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'frontend/manifest.json'), 'utf8'));
let html = manifest.scripts.map(file => fs.readFileSync(path.join(root, 'frontend', file), 'utf8')).join('\n');
// Before integration, the owner can validate the isolated proposal in memory.
if (process.env.PNG_TEST_PATCH === '1') {
  for (const file of ['png.json', 'png-layout.json', 'custom-fields-png.json']) {
    const proposal = path.join(root, '.repair-work', file);
    if (!fs.existsSync(proposal)) continue;
    for (const patch of JSON.parse(fs.readFileSync(proposal, 'utf8'))) {
      if (html.includes(patch.find)) html = html.replace(patch.find, patch.replace);
    }
  }
}
const source = html.slice(html.indexOf('const DAY_MS ='), html.indexOf('(async function(){'));

function task(id, options = {}) {
  return { id, name: id, pid: null, type: 'task', s: '2026-10-09', e: '2026-10-09',
    pct: 0, who: '', grp: '策划', deps: [], ...options };
}

function harness(options = {}) {
  const canvases = [], toasts = [], downloads = [], urls = [], edgeCalls = [], progressCalls = [];
  const FixedDate = class extends Date {
    constructor(...args) { super(...(args.length ? args : [Date.UTC(2026, 9, 9, 12)])); }
  };
  function makeCanvas() {
    const index = canvases.length;
    const events = [], states = [];
    let currentPath = [];
    const target = {
      globalAlpha: 1,
      measureText: value => ({ width: String(value).length * 6 }),
      fillText(text, x, y) { events.push({ kind: 'text', text: String(text), x, y, fill: this.fillStyle, alpha: this.globalAlpha }); },
      beginPath() { currentPath = []; },
      moveTo(...args) { currentPath.push(['moveTo', ...args]); },
      lineTo(...args) { currentPath.push(['lineTo', ...args]); },
      closePath() { currentPath.push(['closePath']); },
      fill() { events.push({ kind: 'fill', fill: this.fillStyle, alpha: this.globalAlpha, path: currentPath.map(command=>[...command]) }); },
      fillRect(x, y, width, height) { events.push({ kind: 'fill-rect', x, y, width, height, fill: this.fillStyle, alpha: this.globalAlpha }); },
      arcTo(x1, y1, x2, y2, radius) { assert.ok(Number.isFinite(radius) && radius >= 0); events.push({ kind: 'arc', x1, y1, x2, y2, radius }); },
      stroke() { events.push({ kind: 'stroke', stroke: this.strokeStyle, path: currentPath.map(command=>[...command]) }); },
      rect(x, y, width, height) { events.push({ kind: 'clip-rect', x, y, width, height }); },
      bezierCurveTo(...args) { currentPath.push(['bezierCurveTo',...args]); events.push({ kind: 'bezier', args }); },
      save() { states.push({ globalAlpha: this.globalAlpha, fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, textAlign: this.textAlign, font: this.font }); },
      restore() { Object.assign(this, states.pop() || {}); },
    };
    const context = new Proxy(target, { get: (object, key) => key in object ? object[key] : () => {} });
    const canvas = { width: 0, height: 0, events,
      getContext() { return options.nullContext === index ? null : context; },
      toBlob(callback) {
        if (options.blobThrows) throw new Error('encoding failed');
        callback(options.nullBlob ? null : { png: true });
      },
    };
    canvases.push(canvas);
    return canvas;
  }
  const sandbox = {
    Date: FixedDate, console, edgeCalls, progressCalls,
    window: { addEventListener() {}, location: { pathname: '/', href: 'http://localhost/' } },
    document: { documentElement: { dataset: {} }, createElement(tag) { return tag === 'canvas' ? makeCanvas() : { click() { downloads.push(this.download); } }; } },
    URL: { createObjectURL(blob) { urls.push(blob); return 'blob:png-test'; }, revokeObjectURL() {} },
    setTimeout() {}, setInterval() {}, clearTimeout() {},
    recordToast: (...args) => toasts.push(args),
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  if (process.env.PNG_TEST_PATCH !== '1') {
    assert.equal(vm.runInContext('typeof isCriticalDep', sandbox), 'function', 'critical dependency helper is integrated');
    assert.equal(vm.runInContext('typeof barProgressCol', sandbox), 'function', 'shared progress contrast helper is integrated');
    assert.equal(vm.runInContext('typeof visibleTableColumns', sandbox), 'function', 'visible column getter is integrated');
    assert.equal(vm.runInContext('typeof taskCellText', sandbox), 'function', 'column text getter is integrated');
  }
  vm.runInContext("toast=recordToast; isCriticalDep=(from,to)=>{edgeCalls.push([from,to]);return true}; barProgressCol=col=>{progressCalls.push(col);return '#progress'};", sandbox);
  function configure(tasks, positions, settings = {}) {
    sandbox.fixture = { tasks, positions, settings };
    vm.runInContext(`
      proj={tasks:fixture.tasks,groups:fixture.settings.groups||GROUPS,flags:fixture.settings.flags||[],meta:fixture.settings.meta||{}};
      filterQ=fixture.settings.filterQ||'';filterGrp=fixture.settings.filterGrp||null;filterPhase=fixture.settings.filterPhase||null;
      zoom=fixture.settings.zoom||'week';canvasScale=fixture.settings.canvasScale??1;
      bds={mn:tD('2026-10-07')};axis=buildAxis(bds.mn,bds.mn+30,zoom);
      computeRowYs(vRows());if(fixture.settings.height!==undefined)rowsHTotal=fixture.settings.height;
      bPos={};
      for(const [id,values] of Object.entries(fixture.positions)){
        const t=byId(id),r=isSum(t)?eRange(t):{s:tD(t.s),e:tD(t.e)};
        const geometry=ScheduleBarGeometry.span(r.s,r.e,bds.mn,axis.dw);
        bPos[id]={...geometry,y:9,h:22,cy:20,type:'task',...values};
      }
      cf=new Set(fixture.settings.conflicts||[]);crit=new Set();
    `, sandbox);
  }
  return { canvases, toasts, downloads, urls, edgeCalls, progressCalls, configure,
    run() { vm.runInContext('capPNG()', sandbox); },
    route(from,to) { return JSON.parse(vm.runInContext('JSON.stringify(ScheduleBarGeometry.connector(bPos['+JSON.stringify(from)+'],bPos['+JSON.stringify(to)+']))',sandbox)); },
    texts() { return canvases.flatMap(canvas => canvas.events.filter(event => event.kind === 'text').map(event => event.text)); },
  };
}

test('uniform canvas zoom exports both dimensions at the same scale and keeps short bars centred in their date cells', () => {
  for (const [zoom,dw] of [['day',72],['week',22],['month',6]]) for(const factor of [.35,1,2,3]) {
    const h=harness();
    h.configure([task('SHORT')],{SHORT:{}},{zoom,canvasScale:factor,groups:[{name:'策划',color:'#123456'}]});
    h.run();
    assert.equal(h.downloads.length,1,'dw='+dw);
    const body=h.canvases[0],clip=body.events.filter(event=>event.kind==='clip-rect').at(-1);
    assert.equal(clip.width,6*dw,'logical export time axis matches the preset');
    assert.ok(Math.abs(body.width-(clip.x+clip.width)*2*factor)<1,'export width includes uniform canvas scale');
    assert.ok(Math.abs(body.height-102*2*factor)<1,'export height includes the same canvas scale');
    const painted=body.events.find(event=>event.kind==='fill-rect'&&event.fill==='#123456');
    assert.ok(painted,'task rectangle is painted');
    assert.equal(painted.width,dw-Math.min(4,.2*dw));
    assert.ok(Math.abs(painted.x-clip.x-(2*dw+Math.min(2,.1*dw)))<1e-9);
    assert.ok(painted.width>0&&painted.width<dw);
    assert.ok(body.events.filter(event=>event.kind==='arc').every(event=>event.radius>=0));
  }
});

test('maximum canvas zoom rejects an oversized image before allocating canvas pixels',()=>{
  const h=harness();
  h.configure([task('LONG',{e:'2027-10-09'})],{LONG:{}},{zoom:'day',canvasScale:3});
  h.run();
  assert.equal(h.downloads.length,0);
  assert.ok(h.toasts.some(([message])=>message.includes('时间范围过大')));
  assert.ok(h.canvases.every(canvas=>canvas.width===0&&canvas.height===0));
});

test('filtered export bounds ignore hidden tasks and today outside the selected schedule', () => {
  const h = harness();
  h.configure([task('VISIBLE', { s: '2020-01-01', e: '2020-01-01' }), task('HIDDEN', { s: '2030-01-01', e: '2030-01-01', grp: '程序' })],
    { VISIBLE: {} }, { zoom: 'day', filterGrp: '策划' });
  h.run();
  assert.equal(h.downloads.length, 1);
  const bodyClip = h.canvases[0].events.filter(event => event.kind === 'clip-rect').at(-1);
  assert.equal(bodyClip.width, 6 * 72);
  assert.equal(h.canvases[0].width, (bodyClip.x + bodyClip.width) * 2);
  assert.ok(h.texts().includes('2020年1月'));
  assert.ok(!h.texts().includes('HIDDEN'));
});

test('closed nested flow exports the visible summary and all visible role colours', () => {
  const h = harness();
  h.configure([task('FLOW', { flow: true }), task('VISIBLE-SUM', { pid: 'FLOW', grp: '程序' }),
    task('HIDDEN-LEAF', { pid: 'VISIBLE-SUM', grp: '动画', e: '2026-10-15', pct: 70 })],
    { FLOW: { type: 'lane', y: 4, h: 32 }, 'VISIBLE-SUM': { summary: true }, 'HIDDEN-LEAF': { hidden: true } });
  h.run();
  assert.ok(h.texts().includes('VISIBLE-SUM'));
  assert.ok(!h.texts().includes('HIDDEN-LEAF'));
  assert.ok(h.texts().includes('策划'));
  assert.ok(h.texts().includes('程序'));
  assert.ok(!h.texts().includes('动画'));
  assert.ok(h.progressCalls.length > 0, 'the summary uses the descendants aggregate progress');
});

test('flow child dependencies use the visible geometries and critical-edge helper', () => {
  const h = harness();
  h.configure([task('FLOW', { flow: true }), task('FIRST', { pid: 'FLOW' }),
    task('SECOND', { pid: 'FLOW', s: '2026-10-10', e: '2026-10-12', deps: ['FIRST'] })],
    { FLOW: { type: 'lane', y: 4, h: 32 }, FIRST: {}, SECOND: {} });
  h.run();
  assert.deepEqual(JSON.parse(JSON.stringify(h.edgeCalls)), [['FIRST', 'SECOND']]);
  assert.ok(!h.canvases[0].events.some(event => event.kind === 'bezier'),'adjacent flow dependencies export a compact joint without a detour');
  const arrow=h.canvases[0].events.find(event=>event.kind==='fill'&&event.fill==='#f53f3f');
  assert.equal(arrow,undefined,'the inline dependency exports no arrow');
  const route=h.route('FIRST','SECOND'),clip=h.canvases[0].events.filter(event=>event.kind==='clip-rect').at(-1);
  assert.equal(route.arrow,null);
  const stroke=h.canvases[0].events.find(event=>event.kind==='stroke'&&event.stroke==='#f53f3f');
  assert.deepEqual(stroke.path,route.commands.map(([name,x,y])=>[name,x+clip.x,y+52]));
});

test('cross-row adjacent dependencies export the same curved route and normal arrow in both vertical directions',()=>{
  for(const dy of [-400,-40,40,400]){
    const h=harness(),sourceY=dy<0?20-dy:20,targetY=sourceY+dy;
    h.configure([task('FIRST'),task('SECOND',{s:'2026-10-10',e:'2026-10-12',deps:['FIRST']})],
      {FIRST:{y:sourceY-11,cy:sourceY},SECOND:{y:targetY-11,cy:targetY}},{height:Math.max(sourceY,targetY)+20});
    h.run();assert.equal(h.downloads.length,1);
    const body=h.canvases[0],route=h.route('FIRST','SECOND'),clip=body.events.filter(event=>event.kind==='clip-rect').at(-1);
    assert.equal(route.kind,'standard');
    const stroke=body.events.find(event=>event.kind==='stroke'&&event.stroke==='#f53f3f');
    const fill=body.events.find(event=>event.kind==='fill'&&event.fill==='#f53f3f');
    assert.ok(stroke&&fill,'export draws both a line and a directional arrow');
    assert.deepEqual(stroke.path,route.commands.map(([name,...coords])=>[name,...coords.map((value,index)=>value+(index%2?52:clip.x))]));
    assert.deepEqual(fill.path,[...route.arrow.map(([x,y],index)=>[index?'lineTo':'moveTo',x+clip.x,y+52]),['closePath']]);
    assert.ok(body.events.some(event=>event.kind==='bezier'),'export keeps the original dependency curve across rows');
  }
});


test('expanded summary stays faint and descendants remain visible in the PNG', () => {
  const h = harness();
  h.configure([task('FLOW', { flow: true }), task('SUMMARY', { pid: 'FLOW', grp: '程序' }),
    task('VISIBLE-LEAF', { pid: 'SUMMARY', grp: '动画', e: '2026-10-20' })],
    { FLOW: { type: 'lane', y: 4, h: 58 }, SUMMARY: { summary: true, expanded: true }, 'VISIBLE-LEAF': { y: 35, cy: 46 } }, { height: 66 });
  h.run();
  assert.ok(h.texts().includes('VISIBLE-LEAF'));
  assert.ok(h.texts().includes('动画'));
  const summary = h.canvases[0].events.find(event => event.kind === 'text' && event.text === 'SUMMARY');
  assert.equal(summary.alpha, 0.18);
});

test('500 rows are rejected before allocating oversized pixel canvases', () => {
  const h = harness();
  const tasks = Array.from({ length: 500 }, (_, index) => task('TASK-' + index));
  h.configure(tasks, Object.fromEntries(tasks.map(t => [t.id, {}])));
  h.run();
  assert.equal(h.downloads.length, 0);
  assert.ok(h.toasts.some(([message]) => message.includes('图片过大')));
  assert.ok(h.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('total pixel area is limited even when each side fits', () => {
  const h = harness();
  h.configure([task('WIDE', { e: '2027-04-11' })], { WIDE: {} }, { zoom: 'day', height: 5000 });
  h.run();
  assert.equal(h.downloads.length, 0);
  assert.ok(h.toasts.some(([message]) => message.includes('图片过大')));
});

test('null Blob and unavailable drawing contexts report failure without a success toast', () => {
  for (const options of [{ nullBlob: true }, { nullContext: 0 }, { nullContext: 1 }, { blobThrows: true }]) {
    const h = harness(options);
    h.configure([task('TASK')], { TASK: {} });
    assert.doesNotThrow(() => h.run());
    assert.equal(h.downloads.length, 0);
    assert.equal(h.urls.length, 0);
    assert.ok(h.toasts.some(([, type]) => type === 'warn'));
    assert.ok(!h.toasts.some(([, type]) => type === 'success'));
  }
});

test('legend wraps without dropping custom roles or filtered-stage explanation', () => {
  const groups = Array.from({ length: 12 }, (_, index) => ({ name: '职能角色-' + index, color: '#123456' }));
  const tasks = groups.map((g, index) => task('TASK-' + index, { grp: g.name, phase: '共同阶段' }));
  const h = harness();
  h.configure(tasks, Object.fromEntries(tasks.map(t => [t.id, {}])), { groups, zoom: 'month', filterPhase: '共同阶段' });
  h.run();
  const legend = h.canvases[1].events.filter(event => event.kind === 'text');
  for (const g of groups) assert.ok(legend.some(event => event.text === g.name));
  assert.ok(legend.some(event => event.text === '共同阶段'));
  assert.ok(legend.map(event => event.text).join('').includes('非全部任务'));
  assert.ok(new Set(legend.map(event => event.y)).size > 1);
  const logicalWidth = h.canvases[1].width / 2;
  assert.ok(legend.every(event => event.x + event.text.length * 6 <= logicalWidth - 10));
});

test('dependency conflicts and shared progress colours remain present in exported tasks', () => {
  const h = harness();
  h.configure([task('CONFLICT', { e: '2026-10-15', pct: 50 })], { CONFLICT: {} }, { conflicts: ['CONFLICT'] });
  h.run();
  assert.ok(h.progressCalls.length > 0);
  assert.ok(h.canvases[0].events.some(event => event.kind === 'stroke' && event.stroke === '#ff7d00'));
  assert.ok(h.texts().includes('!'));
  assert.ok(h.texts().includes('⚠ 工期冲突'));
});

test('milestone conflicts are identifiable in both the table and node geometry', () => {
  const h = harness();
  h.configure([task('PIN', { type: 'milestone' })], { PIN: { type: 'ms', cx: 55, w: 16, h: 17 } }, { conflicts: ['PIN'] });
  h.run();
  assert.equal(h.texts().filter(text => text === '!').length, 2);
  assert.ok(h.texts().includes('⚠ 工期冲突'));
});

test('flow milestone labels follow the final label geometry or remain hidden', () => {
  const tasks = [task('FLOW', { flow: true }), task('PIN', { pid: 'FLOW', type: 'milestone' })];
  for (const label of [null, { x: 90, y: 5, text: 'PIN LABEL', fontSize: 10, height: 14 }]) {
    const h = harness();
    h.configure(tasks, { FLOW: { type: 'lane', y: 4, h: 32 }, PIN: { type: 'ms', cx: 55, w: 12, h: 13, label } });
    h.run();
    assert.ok(!h.texts().some(text => text.startsWith('PIN ' + '10/9')));
    assert.equal(h.texts().includes('PIN LABEL'), !!label);
  }
});

test('right-edge milestone and flag labels fit completely without including unrelated flags', () => {
  const h = harness();
  const name = '模块验收的重要节点';
  const flagName = '测试发布节点以及需要完整看到的非常长的名称';
  h.configure([task('PIN', { name, type: 'milestone', s: '2026-10-15', e: '2026-10-15' })],
    { PIN: { type: 'ms', cx: 187, w: 16, h: 17 } }, {
      flags: [{ id: 'flag1', name: flagName, d: '2026-10-16', color: '#e03e3e' },
        { id: 'flag2', name: 'UNRELATED FLAG', d: '2026-10-23', color: '#e03e3e' }],
    });
  h.run();
  assert.equal(h.downloads.length, 1);
  const labels = h.canvases[0].events.filter(event => event.kind === 'text' && (event.text === flagName || event.text === name + ' 10/15'));
  assert.equal(labels.length, 2);
  const width = h.canvases[0].width / 2;
  assert.ok(labels.every(label => label.x + label.text.length * 6 + 10 <= width));
  assert.ok(!h.texts().includes('UNRELATED FLAG'));
});

test('complete same-year and cross-year dates fit their independent start and end cells', () => {
  for (const [s, e, startText, endText] of [
    ['2026-10-12', '2026-10-14', '10/12', '10/14'],
    ['2025-12-31', '2026-01-02', '25/12/31', '1/2'],
    ['2024-12-31', '2025-01-02', '24/12/31', '25/1/2'],
  ]) {
    const h = harness();
    h.configure([task('TASK', { s, e, pct: 75 })], { TASK: {} });
    h.run();
    assert.equal(h.downloads.length, 1);
    const events = h.canvases[0].events;
    for (const expected of [startText, endText]) {
      const date = events.find(event => event.kind === 'text' && event.text === expected);
      assert.ok(date, 'the complete date string is displayed');
      const clip = events.find(event => event.kind === 'clip-rect' && event.height === 40 && event.x <= date.x && event.x + event.width > date.x);
      assert.ok(clip, 'the date has a table cell clip');
      assert.ok(date.x + date.text.length * 6 + 10 <= clip.x + clip.width, 'the date clip contains every character and padding');
    }
  }
});

test('custom values export in the visible field order while hidden fields stay absent', () => {
  const customFields = [
    { id: 'cf_note', name: '说明', type: 'text' },
    { id: 'cf_number', name: '预算', type: 'number' },
    { id: 'cf_date', name: '评审日期', type: 'date' },
    { id: 'cf_select', name: '状态', type: 'select', options: [{ id: 'go', label: '计划内' }] },
    { id: 'cf_check', name: '确认', type: 'checkbox' },
    { id: 'cf_secret', name: '隐藏信息', type: 'text' },
  ];
  const h = harness();
  h.configure([task('TASK', { who: 'HIDDEN PERSON', customValues: {
    cf_note: '完整自定义内容', cf_number: 12.5, cf_date: '2025-10-01', cf_select: 'go', cf_check: true, cf_secret: 'SECRET HIDDEN DATA',
  } })], { TASK: {} }, { meta: {
    customFields, hiddenColumns: ['person', 'grp', 'phase', 'cf_secret'],
    columnOrder: ['cf_check', 'cf_note', 'start', 'end', 'pct', 'cf_select', 'cf_number', 'cf_date', 'cf_secret', 'person'],
    cols: { cf_note: 160 },
  } });
  h.run();
  assert.equal(h.downloads.length, 1);
  const headers = ['名称', '确认', '说明', '开始', '结束', '进度', '状态', '预算', '评审日期'];
  const renderedHeaders = h.canvases[0].events.filter(event => event.kind === 'text' && event.y === 39 && headers.includes(event.text)).map(event => event.text);
  assert.deepEqual(renderedHeaders, headers);
  for (const value of ['完整自定义内容', '12.5', '25/10/1', '计划内', '✓']) assert.ok(h.texts().includes(value));
  for (const value of ['HIDDEN PERSON', 'SECRET HIDDEN DATA', '隐藏信息', '负责人']) assert.ok(!h.texts().includes(value));
});
