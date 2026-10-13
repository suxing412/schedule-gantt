'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

class TextNode {
  constructor(value) { this.textContent = String(value); }
}

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.offsetWidth = 100;
    this.offsetHeight = 40;
    this._text = '';
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : Boolean(force);
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      }
    };
  }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  focus() { this.focused = true; }
  querySelectorAll(selector) {
    return descendants(this).filter(node => selector.split(',').some(part => {
      const cls = part.match(/\.([\w-]+)/);
      const attr = part.match(/\[data-([\w-]+)\]/);
      return (!cls || (node.className || '').split(/\s+/).includes(cls[1])) &&
        (!attr || Object.hasOwn(node.dataset, attr[1]));
    }));
  }
  get textContent() {
    return this._text + this.children.map(node => node.textContent).join('');
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  set innerHTML(value) {
    if (!this.forbidInnerHTML && (value === '' || value === '&times;')) {
      this.children = []; this._text = value === '&times;' ? '×' : ''; return;
    }
    throw new Error('Dynamic tooltip and error rendering must not use innerHTML: ' + value);
  }
}

function descendants(element) {
  return element.children.flatMap(child => child instanceof Element ? [child, ...descendants(child)] : []);
}

function fixture() {
  const tooltip = new Element();
  const errorBox = new Element();
  tooltip.forbidInnerHTML = errorBox.forbidInnerHTML = true;
  const elements = new Map([['#tooltip', tooltip], ['#g-left-body', errorBox]]);
  const events = new Map();
  const context = {
    window: {
      location: { pathname: '/', href: 'http://localhost/' },
      addEventListener() {},
      removeEventListener() {}
    },
    document: {
      documentElement: { dataset: {}, style: { setProperty() {} } },
      createElement: tag => new Element(tag),
      createTextNode: value => new TextNode(value),
      querySelector: selector => {
        if (!elements.has(selector)) elements.set(selector, new Element());
        return elements.get(selector);
      },
      querySelectorAll: () => [],
      addEventListener: (name, handler) => events.set(name, handler),
      removeEventListener() {},
      body: new Element('body'),
      getElementById: id => id === 'g-left-body' ? errorBox : null
    },
    innerWidth: 1200,
    innerHeight: 800
  };
  vm.createContext(context);
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  // Exercise the real rendering functions without starting the full browser workspace.
  const source = html.split('<script>')[1].split('</script>')[0]
    .split('/* The shared landing page is independent from all local/desktop project storage. */')[0];
  vm.runInContext(source, context, { timeout: 2000 });
  return { context, tooltip, errorBox, elements, events, source };
}

function showTooltip(f, overrides = {}, color = '#3370ff') {
  f.context.testTask = {
    id: 'task-a', name: '任务', pid: null, type: 'task',
    s: '2026-10-01', e: '2026-10-02', pct: 50,
    grp: 'custom', who: '', phase: '', deps: [], ...overrides
  };
  f.context.testColor = color;
  f.context.anchor = new Element();
  vm.runInContext("proj={tasks:[testTask],groups:[{name:'custom',color:testColor}]};bindTip(anchor,testTask)", f.context);
  f.context.anchor.listeners.get('mouseenter')({ clientX: 20, clientY: 20 });
}

test('tooltip keeps malicious labels as text and rejects injected progress and color', () => {
  const f = fixture();
  const name = '<img src=x onerror=alert(1)>';
  const who = '<svg onload=alert(2)>';
  const phase = '<script>alert(3)</script>';
  showTooltip(f, { name, who, phase, pct: name }, '#000" onmouseover="alert(4)');
  assert.equal(f.tooltip.children[0].textContent, name);
  assert.ok(f.tooltip.textContent.includes(who));
  assert.ok(f.tooltip.textContent.includes(phase));
  assert.ok(f.tooltip.textContent.includes('进度0%'));
  const dot = descendants(f.tooltip).find(node => node.className === 'tt-dot');
  assert.equal(dot.style.backgroundColor, '#6b7280');
  assert.ok(descendants(f.tooltip).every(node => ['b', 'div', 'span'].includes(node.tagName)));
});

test('tooltip preserves valid color and clamps non-finite or out-of-range progress', () => {
  const f = fixture();
  for (const [input, expected] of [[64, '64%'], ['75', '75%'], [140, '100%'], [-2, '0%'], [Infinity, '0%']]) {
    showTooltip(f, { pct: input }, '#Ab12CD');
    assert.ok(f.tooltip.textContent.includes('进度' + expected));
    assert.equal(descendants(f.tooltip).find(node => node.className === 'tt-dot').style.backgroundColor, '#Ab12CD');
  }
  assert.ok(f.tooltip.classList.contains('show'));
  f.context.anchor.listeners.get('mouseleave')();
  assert.equal(f.tooltip.classList.contains('show'), false);
});

test('pipeline and milestone tooltips also render names as text', () => {
  const f = fixture();
  const name = '<iframe src=javascript:alert(1)>';
  showTooltip(f, { type: 'pipeline', name });
  assert.equal(f.tooltip.children[0].textContent, name);
  assert.ok(f.tooltip.textContent.includes('管线 · 贯穿项目周期'));
  assert.ok(f.tooltip.textContent.includes('包含0 项任务'));
  showTooltip(f, { type: 'milestone', name, deps: ['a', 'b'] });
  assert.equal(f.tooltip.children[0].textContent, name);
  assert.ok(f.tooltip.textContent.includes('日期2026-10-01'));
  assert.ok(f.tooltip.textContent.includes('依赖2 个前置'));
});

test('global error display preserves message, source and stack as text', () => {
  const f = fixture();
  const msg = '<img src=x onerror=alert(1)>';
  const src = '<svg onload=alert(2)>';
  const stack = '<script>alert(3)</script>\n at malicious';
  f.errorBox.appendChild(new Element('old'));
  f.context.window.onerror(msg, src, 0, 9, { stack });
  assert.ok(f.errorBox.textContent.includes('消息: ' + msg));
  assert.ok(f.errorBox.textContent.includes('文件: ' + src));
  assert.ok(f.errorBox.textContent.includes('行号: 0'));
  assert.ok(f.errorBox.textContent.includes(stack));
  assert.equal(f.errorBox.children.length, 1);
  assert.equal(descendants(f.errorBox).find(node => node.tagName === 'pre').textContent, stack);
  assert.ok(descendants(f.errorBox).every(node => ['b', 'div', 'pre'].includes(node.tagName)));
});


test('actual settings change listeners reject reserved role names and preserve ordinary names', () => {
  const f = fixture();
  f.context.warnings = [];
  vm.runInContext("proj={tasks:[{id:'a',name:'A',pid:null,type:'task',s:'2026-10-01',e:'2026-10-02',grp:'Original',phase:'Stage'}],groups:[{name:'Original',color:'#123456'}],meta:{}};render=()=>{};schSave=()=>{};toast=msg=>warnings.push(msg);renderSettings()", f.context);
  const nameInput = f.elements.get('#set-roles').children[0].children[1];
  for (const reserved of ['constructor', 'prototype', '__proto__']) {
    nameInput.value = ' ' + reserved + ' ';
    nameInput.listeners.get('change')();
    assert.equal(nameInput.value, 'Original');
    assert.equal(vm.runInContext('proj.groups[0].name', f.context), 'Original');
    assert.equal(vm.runInContext('proj.tasks[0].grp', f.context), 'Original');
  }
  assert.equal(f.context.warnings.length, 3);
  nameInput.value = 'constructor 团队';
  nameInput.listeners.get('change')();
  assert.equal(vm.runInContext('proj.groups[0].name', f.context), 'constructor 团队');
  assert.equal(vm.runInContext('proj.tasks[0].grp', f.context), 'constructor 团队');
  const phaseInput = f.elements.get('#set-phases').children[0].children[0];
  phaseInput.value = '__proto__';
  phaseInput.listeners.get('change')();
  assert.equal(vm.runInContext('proj.tasks[0].phase', f.context), '__proto__');
});

test('actual add-role listener creates a safe editable role name', () => {
  const f = fixture();
  vm.runInContext("proj={tasks:[],groups:[],meta:{}};render=()=>{};schSave=()=>{};toast=()=>{}", f.context);
  const start = f.source.indexOf("  $('#set-role-add').addEventListener('click'");
  const end = f.source.indexOf('\n  });', start) + 6;
  assert.ok(start >= 0 && end > start);
  vm.runInContext(f.source.slice(start, end), f.context);
  f.elements.get('#set-role-add').listeners.get('click')();
  assert.equal(vm.runInContext('proj.groups[0].name', f.context), '新职能');
  const input = f.elements.get('#set-roles').children[0].children[1];
  input.value = 'constructor';
  input.listeners.get('change')();
  assert.equal(vm.runInContext('proj.groups[0].name', f.context), '新职能');
});

test('selection and task painting preserve historical IDs with CSS-special characters', () => {
  const f = fixture();
  const id = 'task"\\\n\u0000],.other[data-id="attack';
  f.context.specialId = id;
  const left = f.elements.get('#g-left-body');
  const row = new Element(); row.className = 't-row'; row.dataset.id = id; left.children = [row];
  const layer = f.context.document.querySelector('#b-layer');
  const bar = new Element(); bar.className = 'bar'; bar.dataset.id = id;
  const out = new Element(); out.className = 'bar-out'; out.dataset.for = id;
  const warn = new Element(); warn.className = 'bar-err'; warn.dataset.for = id;
  const tag = new Element(); tag.className = 'lane-tag'; tag.dataset.for = id;
  layer.children = [bar, out, warn, tag];
  vm.runInContext("paintSelection=()=>{};render=()=>{};schSave=()=>{};proj={tasks:[{id:specialId,pid:null,type:'task',s:'2026-10-01',e:'2026-10-02'}]};axis={dw:10};bds={mn:tD('2026-10-01')};bPos=Object.create(null);bPos[specialId]={type:'task',x:0,w:20};sel(specialId,true);paintTask(proj.tasks[0])", f.context);
  assert.equal(row.focused, true);
  assert.equal(bar.style.width, '18px');
  assert.equal(vm.runInContext('bPos[specialId].w', f.context), 20);
  assert.equal(out.style.left, '26px');
  assert.equal(warn.style.left, '24px');
  assert.equal(tag.style.left, '-8px');
});

test('flag dragging looks up the exact historical flag ID without parsing it as CSS', () => {
  const f = fixture();
  const id = 'flag"\\\n\u0000]';
  f.context.specialId = id;
  const right = f.context.document.querySelector('#g-right'); right.scrollLeft = 0;
  const body = f.context.document.querySelector('#tl-body');
  const line = new Element(); line.className = 'flag-line'; line.dataset.flag = id; body.children = [line];
  f.context.flagElement = new Element();
  vm.runInContext("axis={dw:10};bds={mn:0};flagDragStart({button:0,clientX:0,preventDefault(){}},{id:specialId,d:'2026-10-01'},flagElement,10)", f.context);
  f.events.get('mousemove')({ clientX: 10 });
  assert.equal(line.style.left, '115px');
  assert.equal(f.context.flagElement.style.left, '115px');
});


test('actual geometry initialization and render retain prototype-like historical IDs for selection and export', () => {
  const f = fixture();
  const ids = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'prototype'];
  f.context.historyIds = ids;
  assert.equal(vm.runInContext('Object.getPrototypeOf(bPos) === null', f.context), true);
  for (const id of ids) {
    f.context.lookupId = id;
    assert.equal(vm.runInContext('bPos[lookupId]', f.context), undefined);
  }
  const left = f.elements.get('#g-left-body');
  const rows = ids.map(id => {
    const row = new Element(); row.className = 't-row'; row.dataset.id = id; return row;
  });
  left.children = rows;
  const layer = f.context.document.querySelector('#b-layer');
  f.context.geometryLayer = layer;
  vm.runInContext("proj={tasks:historyIds.map(id=>({id,name:id,pid:null,type:'task',s:'2026-10-01',e:'2026-10-02',pct:0,grp:'custom'})),groups:[{name:'custom',color:'#123456'}],meta:{lw:440,cols:{person:64,date:76,pct:52}}};vRows=()=>proj.tasks.map(t=>({t,depth:0}));compBounds=()=>({mn:tD('2026-10-01'),mx:tD('2026-10-02')});buildAxis=()=>({dw:10});renderLegend=()=>{};renderLeft=()=>{};renderTLH=()=>{};updStats=()=>{};renderBody=rows=>{for(const {t} of rows)rBar(geometryLayer,t,0,false)};render()", f.context);
  assert.equal(vm.runInContext('Object.getPrototypeOf(bPos) === null', f.context), true);
  for (const [index, id] of ids.entries()) {
    f.context.lookupId = id;
    assert.equal(vm.runInContext('Object.hasOwn(bPos,lookupId)', f.context), true);
    assert.equal(vm.runInContext('bPos[lookupId].type', f.context), 'task');
    vm.runInContext('sel(lookupId,true)', f.context);
    assert.equal(rows[index].focused, true);
    assert.equal(vm.runInContext('selIds.has(lookupId)', f.context), true);
  }
  const exportLine = f.source.split(/\r?\n/).find(line => line.includes('const visible=Object.entries(bPos)'));
  assert.ok(exportLine, 'actual PNG geometry entry selection exists');
  vm.runInContext(exportLine + '\nexportIds=visible.map(item=>item.t.id)', f.context);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(exportIds)', f.context)), ids);
});
