'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'frontend/manifest.json'), 'utf8'));
let source = manifest.scripts.map(file => fs.readFileSync(path.join(root, 'frontend', file), 'utf8')).join('\n');
if (process.env.SCHEDULE_INTERACTIONS_PATCH === '1') {
  const patches = JSON.parse(fs.readFileSync(path.join(root, '.repair-work', 'interactions.json'), 'utf8'));
  for (const {find, replace} of patches) {
    if (source.includes(find)) source = source.replace(find, replace);
    else if (replace && source.includes(replace)) continue;
    else throw new Error(`Interaction patch no longer matches: ${find.slice(0, 80)}`);
  }
}
if (process.env.SCHEDULE_CUSTOM_FIELDS_UI_PATCH === '1') {
  const patches = JSON.parse(fs.readFileSync(path.join(root, '.repair-work', 'custom-fields-ui.json'), 'utf8'));
  for (const {find, replace} of patches) {
    if (source.includes(find)) source = source.replace(find, replace);
    else throw new Error(`Custom field UI patch no longer matches: ${find.slice(0, 80)}`);
  }
}
source = source.replace(/\r\n/g, '\n');

function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `Missing source section: ${from}`);
  return source.slice(start, end);
}

function eventHub() {
  const listeners = new Map();
  return {
    addEventListener(type, callback, capture = false) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({callback, capture: typeof capture === 'object' ? Boolean(capture.capture) : Boolean(capture)});
    },
    removeEventListener(type, callback, capture = false) {
      const useCapture = typeof capture === 'object' ? Boolean(capture.capture) : Boolean(capture);
      listeners.set(type, (listeners.get(type) || []).filter(item => item.callback !== callback || item.capture !== useCapture));
    },
    dispatch(type, event = {}) {
      for (const item of [...(listeners.get(type) || [])]) item.callback(event);
    },
    listenerCount(type) { return (listeners.get(type) || []).length; },
  };
}

function keyEvent(key, tagName = 'BUTTON', extra = {}) {
  return {
    key, target: {tagName}, ctrlKey: false, shiftKey: false,
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
    ...extra,
  };
}

function fixture() {
  const timers = new Map();
  let nextTimer = 1;
  const document = {...eventHub(), activeElement: null};
  const window = eventHub();
  function element(className = '', id = '') {
    const classes = new Set(className.split(/\s+/).filter(Boolean));
    const el = {
      ...eventHub(), dataset: id ? {id} : {}, style: {}, attributes: {},
      hidden: false, disabled: false, offsetParent: {}, isConnected: true,
      children: [],
      classList: {
        add(...values) { values.forEach(value => classes.add(value)); },
        remove(...values) { values.forEach(value => classes.delete(value)); },
        contains(value) { return classes.has(value); },
        toggle(value, enabled) {
          const shouldEnable = enabled === undefined ? !classes.has(value) : enabled;
          if (shouldEnable) classes.add(value); else classes.delete(value);
          return shouldEnable;
        },
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      focus() { document.activeElement = this; },
      contains(other) { return this === other || this.children.includes(other); },
      querySelectorAll() { return this.children; },
      querySelector(selector) {
        const idMatch = selector.match(/data-id="([^"]*)"/);
        return this.children.find(child => idMatch ? child.dataset.id === idMatch[1] : true) || null;
      },
    };
    return el;
  }
  const rows = [element('t-row', 'a'), element('t-row', 'b')];
  const bars = [element('bar', 'a'), element('pin', 'b')];
  const elements = {
    '#g-left-body': element(), '#b-layer': element(), '#btn-add-task': element(),
    '#g-right': {...element(), scrollLeft: 0}, '#tl-body': element(),
    '#tooltip': element('show'), '#tb-search': {...element(), value: ''},
  };
  elements['#g-left-body'].children = rows;
  elements['#b-layer'].children = bars;
  const flagLine = element();
  elements['#tl-body'].children = [flagLine];
  for (const id of ['#ovl', '#flag-ovl', '#fields-ovl', '#set-ovl', '#help-ovl']) {
    const ovl = element();
    ovl.hidden = true;
    ovl.children = [element()];
    elements[id] = ovl;
  }
  document.activeElement = elements['#btn-add-task'];
  document.querySelector = selector => elements[selector] || null;
  document.querySelectorAll = selector => selector.startsWith('#g-left-body') ? [...rows, ...bars] : [];
  const calls = {render: 0, stats: 0, save: 0, delete: 0, nudge: 0, edit: 0, undo: 0, redo: 0, step: 0};
  const ctx = {
    document, window, Set, Map, Array, Number,
    $: selector => elements[selector] || null,
    selId: null, selIds: new Set(), dragging: false,
    suppressFlagClick: false, filterQ: '', filterGrp: null, filterPhase: null,
    axis: {dw: 10}, bds: {mn: 90},
    canvasScale: 1,
    canvasScaleFactor: () => ctx.canvasScale,
    canvasClientDelta: value => value / ctx.canvasScale,
    proj: {tasks: [{id: 'a', pid: null, s: '100', e: '104'}, {id: 'b', pid: null, s: '105', e: '106'}], groups: [{name: '策划'}]},
    tD: Number, fD: String, todayD: () => 100, uid: () => `new-${nextTimer++}`,
    render() { calls.render++; }, updStats() { calls.stats++; }, schSave() { calls.save++; },
    delSel() { calls.delete++; }, nudgeSel() { calls.nudge++; }, edOpen() { calls.edit++; },
    undo() { calls.undo++; }, redo() { calls.redo++; }, selStep() { calls.step++; },
    isSum: () => false, desc: () => [], paintTask() {}, schDepDraw() {},
    dragTargets: task => [task], setDragCur(value) { ctx.cursor = value; },
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, {callback, delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  ctx.byId = id => ctx.proj.tasks.find(task => task.id === id);
  vm.createContext(ctx);
  vm.runInContext(section('function anyOvlOpen(){', '// 重要节点统一图标'), ctx);
  function run(code) { vm.runInContext(code, ctx); }
  function selection() { run(section('/* Selection */', '// ←/→ 微调选中任务日期')); }
  function globalKeys() {
    const start = source.indexOf("  document.addEventListener('keydown',e=>{", source.indexOf('function bindUI'));
    const end = source.indexOf('  // 弹窗焦点圈闭', start);
    run(source.slice(start, end));
    for (const [id, fn] of [['#ovl', 'edClose'], ['#flag-ovl', 'flagClose'], ['#fields-ovl', 'fieldsClose'], ['#set-ovl', 'setClose'], ['#help-ovl', 'helpClose']]) {
      ctx[fn] = () => ctx.closeOvl(elements[id]);
    }
  }
  function flagDrag() { run(section('function flagDragStart(', '/* Body */')); }
  function flushTimers() {
    const pending = [...timers.entries()].sort((a, b) => a[1].delay - b[1].delay);
    for (const [id, timer] of pending) if (timers.delete(id)) timer.callback();
  }
  return {ctx, document, window, elements, rows, bars, calls, flagLine, element, selection, globalKeys, flagDrag, flushTimers, run};
}

test('single-click selection keeps task and row nodes available for the following double-click', () => {
  const f = fixture(); f.selection();
  const originalRow = f.rows[0], originalBar = f.bars[0];
  f.ctx.sel('a'); f.ctx.sel('a');
  assert.equal(f.calls.render, 0);
  assert.equal(f.rows[0], originalRow); assert.equal(f.bars[0], originalBar);
  assert.equal(originalRow.classList.contains('selected'), true);
  assert.equal(originalRow.attributes['aria-pressed'], 'true');
  assert.equal(originalBar.classList.contains('selected'), true);
  assert.equal(f.calls.stats, 2);
});

test('multi-selection changes update classes, counts, main selection, and keyboard focus without rebuilding', () => {
  const f = fixture(); f.selection();
  f.ctx.sel('a'); f.ctx.toggleSel('b');
  assert.deepEqual([...f.ctx.selIds], ['a', 'b']);
  assert.equal(f.ctx.selId, 'b');
  assert.equal(f.bars[1].classList.contains('selected'), true);
  f.ctx.toggleSel('b');
  assert.equal(f.ctx.selId, 'a');
  assert.equal(f.rows[1].attributes['aria-pressed'], 'false');
  f.ctx.sel('b', true);
  assert.equal(f.document.activeElement, f.rows[1]);
  assert.equal(f.calls.render, 0);
});

for (const modal of ['#ovl', '#flag-ovl', '#fields-ovl', '#set-ovl', '#help-ovl']) {
  test(`${modal} blocks background mutation shortcuts while a button has focus`, () => {
    const f = fixture(); f.globalKeys(); f.ctx.selId = 'a';
    f.elements[modal].hidden = false;
    for (const key of ['Delete', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Enter']) f.document.dispatch('keydown', keyEvent(key));
    for (const key of ['z', 'y', 'f']) f.document.dispatch('keydown', keyEvent(key, 'BUTTON', {ctrlKey: true}));
    assert.deepEqual([f.calls.delete, f.calls.nudge, f.calls.edit, f.calls.undo, f.calls.redo, f.calls.step], [0, 0, 0, 0, 0, 0]);
  });
}

test('background shortcuts continue to work when no modal or drag is active', () => {
  const f = fixture(); f.globalKeys(); f.ctx.selId = 'a';
  f.document.dispatch('keydown', keyEvent('Delete', 'DIV'));
  f.document.dispatch('keydown', keyEvent('ArrowRight', 'DIV'));
  f.document.dispatch('keydown', keyEvent('Enter', 'DIV'));
  assert.deepEqual([f.calls.delete, f.calls.nudge, f.calls.edit], [1, 1, 1]);
});

test('selected tasks do not hijack native button, link, or nested icon activation', () => {
  const f = fixture(); f.globalKeys(); f.ctx.selId = 'a';
  const targets = [{tagName: 'BUTTON'}, {tagName: 'A'}, {tagName: 'svg', closest: () => ({tagName: 'BUTTON'})}];
  for (const target of targets) {
    for (const key of ['Enter', ' ', 'ArrowDown', 'ArrowUp', 'ArrowRight', 'Delete']) {
      const event = keyEvent(key, target.tagName, {target});
      f.document.dispatch('keydown', event);
      assert.equal(event.prevented, false);
    }
  }
  assert.deepEqual([f.calls.delete, f.calls.nudge, f.calls.edit, f.calls.step], [0, 0, 0, 0]);
});

test('active drags and IME composition cannot invoke background keyboard mutations', () => {
  const f = fixture(); f.globalKeys(); f.ctx.selId = 'a';
  f.ctx.dragging = true;
  f.document.dispatch('keydown', keyEvent('Delete'));
  f.ctx.dragging = false;
  f.document.dispatch('keydown', keyEvent('Enter', 'BUTTON', {isComposing: true}));
  f.document.dispatch('keydown', keyEvent('Delete', 'BUTTON', {keyCode: 229}));
  assert.deepEqual([f.calls.delete, f.calls.edit], [0, 0]);
});

test('Escape closes the modal and restores its invoking button after the closing animation', () => {
  const f = fixture(); f.globalKeys();
  const caller = f.elements['#btn-add-task'], modal = f.elements['#help-ovl'];
  f.ctx.openOvl(modal); f.flushTimers();
  assert.equal(f.document.activeElement, modal.children[0]);
  f.document.dispatch('keydown', keyEvent('Escape'));
  assert.equal(modal.classList.contains('closing'), true);
  assert.equal(f.document.activeElement, modal.children[0]);
  f.flushTimers();
  assert.equal(modal.hidden, true);
  assert.equal(f.document.activeElement, caller);
});

test('closing a modal restores the current row if its original caller was replaced by rendering', () => {
  const f = fixture(); f.selection();
  f.ctx.sel('a'); f.rows[0].focus();
  const modal = f.elements['#set-ovl'];
  f.ctx.openOvl(modal); f.flushTimers();
  f.rows[0].isConnected = false;
  const replacement = f.element('t-row', 'a');
  f.elements['#g-left-body'].children = [replacement];
  f.ctx.closeOvl(modal); f.flushTimers();
  assert.equal(f.document.activeElement, replacement);
});

test('reopening a modal cancels its pending close and never returns focus behind it', () => {
  const f = fixture(), modal = f.elements['#help-ovl'];
  f.ctx.openOvl(modal); f.flushTimers();
  f.ctx.closeOvl(modal); f.ctx.openOvl(modal); f.flushTimers();
  assert.equal(modal.hidden, false);
  assert.equal(f.document.activeElement, modal.children[0]);
});

test('flag drag Escape restores the date without saving and removes all drag listeners', () => {
  const f = fixture(); f.flagDrag();
  const flag = {id: 'flag', d: '100'}, el = f.element();
  f.ctx.flagDragStart(keyEvent('', 'DIV', {button: 0, clientX: 100}), flag, el, 100);
  assert.equal(f.ctx.dragging, true);
  f.document.dispatch('mousemove', {clientX: 130});
  assert.equal(el.style.left, '135px');
  const esc = keyEvent('Escape'); f.document.dispatch('keydown', esc);
  assert.equal(flag.d, '100'); assert.equal(f.calls.save, 0);
  assert.equal(f.ctx.dragging, false); assert.equal(f.ctx.cursor, null);
  assert.equal(esc.stopped, true);
  for (const type of ['mousemove', 'mouseup', 'keydown']) assert.equal(f.document.listenerCount(type), 0);
  assert.equal(f.window.listenerCount('blur'), 0);
  f.document.dispatch('mouseup', {clientX: 150});
  assert.equal(flag.d, '100');
});

test('flag drag losing window focus cancels instead of leaving a stuck interaction', () => {
  const f = fixture(); f.flagDrag();
  const flag = {id: 'flag', d: '100'};
  f.ctx.flagDragStart(keyEvent('', 'DIV', {button: 0, clientX: 100}), flag, f.element(), 100);
  f.document.dispatch('mousemove', {clientX: 120}); f.window.dispatch('blur');
  assert.equal(flag.d, '100'); assert.equal(f.calls.save, 0);
  assert.equal(f.ctx.dragging, false); assert.equal(f.window.listenerCount('blur'), 0);
});

test('flag drag commits a changed date once, including the horizontal scroll offset', () => {
  const f = fixture(); f.flagDrag();
  const flag = {id: 'flag', d: '100'};
  f.ctx.flagDragStart(keyEvent('', 'DIV', {button: 0, clientX: 100}), flag, f.element(), 100);
  f.elements['#g-right'].scrollLeft = 20;
  f.document.dispatch('mousemove', {clientX: 110}); f.document.dispatch('mouseup', {clientX: 110});
  assert.equal(flag.d, '103'); assert.equal(f.calls.save, 1);
  assert.equal(f.calls.render, 1); assert.equal(f.ctx.dragging, false);
});

test('flag clicks and movement below a full date unit do not create saves', () => {
  const f = fixture(); f.flagDrag();
  const flag = {id: 'flag', d: '100'};
  f.ctx.flagDragStart(keyEvent('', 'DIV', {button: 0, clientX: 100}), flag, f.element(), 100);
  f.document.dispatch('mouseup', {clientX: 100});
  assert.equal(f.calls.render, 0); assert.equal(f.calls.save, 0);
  f.ctx.flagDragStart(keyEvent('', 'DIV', {button: 0, clientX: 100}), flag, f.element(), 100);
  f.document.dispatch('mousemove', {clientX: 104}); f.document.dispatch('mouseup', {clientX: 104});
  assert.equal(flag.d, '100'); assert.equal(f.calls.save, 0);
});

test('task drag losing window focus restores its in-progress date mutation without saving', () => {
  const f = fixture(); f.ctx.selId = 'a'; f.ctx.selIds.add('a');
  f.run(section('function sBarD(', '/* 左侧拖动排序 */'));
  const task = f.ctx.proj.tasks[0];
  f.ctx.sBarD(keyEvent('', 'DIV', {button: 0, clientX: 100, target: {dataset: {}}}), task, false);
  f.document.dispatch('mousemove', {clientX: 130});
  assert.equal(task.s, '103');
  f.window.dispatch('blur');
  assert.equal(task.s, '100'); assert.equal(task.e, '104');
  assert.equal(f.calls.save, 0); assert.equal(f.ctx.dragging, false);
  assert.equal(f.window.listenerCount('blur'), 0);
});

test('task movement and resizing divide screen deltas by canvas scale and include scroll changes', () => {
  for(const factor of [.35,1,2,3])for(const handle of [undefined,'left','right']){
    const f=fixture();f.ctx.canvasScale=factor;f.ctx.selId='a';f.ctx.selIds.add('a');
    f.run(section('function sBarD(', '/* 左侧拖动排序 */'));
    const task=f.ctx.proj.tasks[0],rt=f.elements['#g-right'];
    f.ctx.sBarD(keyEvent('', 'DIV', {button:0,clientX:100,target:{dataset:handle?{handle}:{}}}),task,false);
    f.document.dispatch('mousemove',{clientX:100+10*factor});
    rt.scrollLeft=10;rt.dispatch('scroll');
    f.document.dispatch('mouseup',{clientX:100+10*factor});
    assert.equal(task.s,handle==='right'?'100':'102');
    assert.equal(task.e,handle==='left'?'104':'106');
    assert.equal(f.calls.save,1);
    assert.equal(rt.listenerCount('scroll'),0);
  }
});

test('flag preview and commit stay on the same date through uniform zoom and stationary-pointer scroll', () => {
  for(const factor of [.35,2,3]){
    const f=fixture();f.ctx.canvasScale=factor;f.flagDrag();
    const flag={id:'flag',d:'100'},el=f.element(),rt=f.elements['#g-right'];
    f.ctx.flagDragStart(keyEvent('', 'DIV', {button:0,clientX:100}),flag,el,100);
    f.document.dispatch('mousemove',{clientX:100+10*factor});
    rt.scrollLeft=20;rt.dispatch('scroll');
    assert.equal(el.style.left,'135px');
    f.document.dispatch('mouseup',{clientX:100+10*factor});
    assert.equal(flag.d,'103');assert.equal(f.calls.save,1);
    assert.equal(rt.listenerCount('scroll'),0);
  }
});


test('IME Enter never saves a flag or task or accepts a dependency suggestion', () => {
  const f = fixture();
  let flagSaves = 0, taskSaves = 0, suggestions = 0;
  f.ctx.flagSave = () => flagSaves++; f.ctx.edSave = () => taskSaves++;
  const flagHandler = source.match(/  \$\('#flag-ovl'\)\.addEventListener\('keydown',e=>\{[^\n]+/)[0];
  f.run(flagHandler);
  f.run(section('  // 编辑弹窗：Enter 保存', "  const lb=$('#g-left-body')"));
  const dependencyInput = f.element(); f.ctx.ds = dependencyInput;
  f.ctx.hideDepSug = () => {}; f.elements['#dep-sug'] = {hidden: true};
  f.elements['#dep-sug .dep-sug-item'] = {dispatchEvent() { suggestions++; }};
  const start = source.indexOf("  ds.addEventListener('keydown',e=>{");
  f.run(source.slice(start, source.indexOf('\n  });', start) + 6));
  for (const extra of [{isComposing: true}, {keyCode: 229}]) {
    const event = keyEvent('Enter', 'INPUT', extra);
    f.elements['#flag-ovl'].dispatch('keydown', event);
    f.elements['#ovl'].dispatch('keydown', event);
    dependencyInput.dispatch('keydown', event);
  }
  assert.deepEqual([flagSaves, taskSaves, suggestions], [0, 0, 0]);
  f.elements['#flag-ovl'].dispatch('keydown', keyEvent('Enter', 'INPUT'));
  f.elements['#ovl'].dispatch('keydown', keyEvent('Enter', 'INPUT'));
  assert.deepEqual([flagSaves, taskSaves], [1, 1]);
});

for (const [name, end, args] of [
  ['newAtDay', 'function showCtx', [120, 'task']],
  ['addT', 'function addChild', [null, 'task']],
  ['addPipeline', '// 删除不再拦截确认', []],
]) {
  test(`${name} still renders newly created tasks after selection stops rebuilding`, () => {
    const f = fixture(); f.selection();
    f.run(section(`function ${name}(`, end));
    f.ctx[name](...args);
    assert.equal(f.ctx.proj.tasks.length, 3);
    assert.equal(f.ctx.selId, f.ctx.proj.tasks[2].id);
    assert.equal(f.calls.render, 1); assert.equal(f.calls.save, 1); assert.equal(f.calls.edit, 1);
  });
}
