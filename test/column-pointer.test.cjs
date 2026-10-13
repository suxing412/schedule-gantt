'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'scripts', 'columns.js'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('function colW()'), end = source.indexOf('function bindSp()', start);
assert.ok(start >= 0 && end > start, 'Column pointer handlers are available');

function eventTarget(extra = {}) {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, listener) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(listener); },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, props = {}) {
      const event = {button: 0, pointerId: 1, clientX: 100, preventDefault() {}, stopPropagation() {}, ...props};
      for (const listener of [...(listeners.get(type) || [])]) listener(event);
      return event;
    },
    ...extra,
  };
}
function fixture() {
  const styles = new Map([['--left-w', '600px']]), saves = [], cursor = [], frames = new Map();
  let frameId = 0;
  const makeHandle = id => {
    const classes = new Set(); let captured = null;
    return eventTarget({dataset: {col: id}, attributes: {},
      classList: {add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value),
        toggle(value, on) { if (on) classes.add(value); else classes.delete(value); }},
      setAttribute(name, value) { this.attributes[name] = value; },
      parentElement: {getBoundingClientRect: () => ({width: parseFloat(styles.get('--col-' + id))})},
      setPointerCapture(id) { captured = id; }, hasPointerCapture: id => captured === id,
      releasePointerCapture() { captured = null; },
    });
  };
  const handles = ['name', 'person'].map(makeHandle), splitter = makeHandle('splitter'), left = makeHandle('left');
  left.getBoundingClientRect = () => ({width: parseFloat(styles.get('--left-w'))});
  const body = eventTarget({scrollLeft: 48});
  Object.defineProperties(body, {
    clientWidth: {get: () => parseFloat(styles.get('--left-w')) - 4},
    offsetWidth: {get: () => parseFloat(styles.get('--left-w'))},
  });
  const header = {scrollLeft: 48, querySelectorAll: () => handles};
  const gantt = {clientWidth: 1440};
  const document = eventTarget({
    documentElement: {style: {setProperty: (name, value) => styles.set(name, value)}},
    querySelectorAll: selector => selector === '.col-rz' ? handles : [],
    querySelector: selector => ({'#g-left-body': body, '#g-left-hd': header, '#g-left': left, '#splitter': splitter, '#gantt': gantt}[selector] || null),
  });
  const window = eventTarget();
  const ctx = vm.createContext({document, window, $: document.querySelector, dragging: false, modalOpen: false,
    proj: {meta: {layoutVersion: 2, nameAutoWidth: false, paneAuto: false, lw: 600, cols: {name: 248, person: 88, start: 88, end: 88, pct: 64}}},
    anyOvlOpen: () => ctx.modalOpen,
    setDragCur: value => cursor.push(value),
    schSave: () => saves.push(JSON.parse(JSON.stringify(ctx.proj))),
    requestAnimationFrame: callback => { const id = ++frameId; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  vm.runInContext(source, ctx);
  const run = expression => vm.runInContext(expression, ctx, {timeout: 1000});
  run('applyColWidths();bindColRz()');
  const flushFrames = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); };
  return {ctx, body, header, document, window, handles, splitter, styles, saves, cursor, frames, flushFrames, run,
    json: expression => JSON.parse(run(`JSON.stringify(${expression})`))};
}

test('dragging the name previews a fixed width without changing data until pointer release', () => {
  const f = fixture(), before = f.json('proj');
  f.handles[0].dispatch('pointerdown');
  f.document.dispatch('pointermove', {clientX: 140});
  assert.equal(f.styles.get('--col-name'), '248px', 'Pointer movement is applied on the next animation frame');
  f.flushFrames();
  assert.equal(f.styles.get('--col-name'), '288px');
  assert.deepEqual(f.json('proj'), before, 'An already pending save must only observe committed metadata');
  assert.equal(f.saves.length, 0);
  f.document.dispatch('pointerup', {clientX: 140});
  assert.equal(f.run('proj.meta.cols.name'), 288);
  assert.equal(f.run('proj.meta.cols.person'), 88);
  assert.equal(f.run('proj.meta.nameAutoWidth'), false);
  assert.equal(f.saves.length, 1);
  assert.equal(f.run('dragging'), false);
  assert.equal(f.cursor.at(-1), null);
});

for (const cancellation of ['Escape', 'pointercancel', 'blur', 'lostpointercapture']) {
  test(`${cancellation} cancels a name resize, restores scrolling and clears temporary listeners`, () => {
    const f = fixture(), before = f.json('proj');
    f.handles[0].dispatch('pointerdown');
    f.document.dispatch('pointermove', {clientX: 140});
    f.flushFrames();
    assert.equal(f.styles.get('--col-name'), '288px');
    assert.deepEqual(f.json('proj'), before, 'Pending autosave cannot persist a preview width or mode');
    f.body.scrollLeft = 90;
    if (cancellation === 'Escape') f.document.dispatch('keydown', {key: 'Escape'});
    else if (cancellation === 'blur') f.window.dispatch('blur');
    else if (cancellation === 'lostpointercapture') f.handles[0].dispatch('lostpointercapture');
    else f.document.dispatch('pointercancel');
    assert.deepEqual(f.json('proj'), before);
    assert.equal(f.styles.get('--col-name'), '248px');
    assert.equal(f.body.scrollLeft, 48);
    assert.equal(f.header.scrollLeft, 48);
    assert.equal(f.saves.length, 0);
    assert.equal(f.run('dragging'), false);
    assert.equal(f.handles[0].classList.contains('active'), false);
    for (const type of ['pointermove', 'pointerup', 'pointercancel', 'keydown']) assert.equal(f.document.listeners.get(type).size, 0);
    assert.equal(f.window.listeners.get('blur').size, 0);
    assert.equal(f.handles[0].listeners.get('lostpointercapture').size, 0);
    assert.equal(f.frames.size, 0);
    assert.equal(f.run('tableLayoutState.columnDrag'), null);
    f.document.dispatch('pointerup');
    assert.equal(f.saves.length, 0, 'A later release cannot commit the canceled drag');
  });
}

test('pressing a handle without moving or dragging back to its origin leaves widths unchanged', () => {
  const f = fixture(), before = f.json('proj');
  f.handles[0].dispatch('pointerdown');
  f.document.dispatch('pointerup');
  f.handles[0].dispatch('pointerdown');
  f.document.dispatch('pointermove', {clientX: 150});
  f.flushFrames();
  f.document.dispatch('pointermove', {clientX: 100});
  f.flushFrames();
  f.document.dispatch('pointerup');
  assert.deepEqual(f.json('proj'), before);
  assert.equal(f.saves.length, 0);
});

test('name keyboard resizing starts from the rendered column and uses fixed column bounds', () => {
  const f = fixture();
  f.handles[0].dispatch('keydown', {key: 'ArrowLeft'});
  assert.equal(f.run('proj.meta.cols.name'), 240);
  assert.equal(f.run('proj.meta.nameAutoWidth'), false);
  f.handles[0].dispatch('keydown', {key: 'End'});
  assert.equal(f.run('proj.meta.cols.name'), 1000);
  assert.equal(f.handles[0].attributes['aria-valuemax'], '1000');
  assert.equal(f.saves.length, 2);
});

test('resizing another column preserves the displayed name width and all other saved widths', () => {
  const f = fixture();
  f.handles[1].dispatch('pointerdown');
  f.document.dispatch('pointermove', {clientX: 140});
  f.flushFrames();
  assert.equal(f.styles.get('--col-name'), '248px');
  f.document.dispatch('pointerup', {clientX: 140});
  assert.deepEqual(f.json('proj.meta.cols'), {name: 248, person: 128, start: 88, end: 88, pct: 64, grp: 96, phase: 112});
  assert.equal(f.saves.length, 1);
});

test('another pointer cannot change or commit the active resize', () => {
  const f = fixture();
  f.handles[0].dispatch('pointerdown');
  f.document.dispatch('pointermove', {pointerId: 2, clientX: 150});
  f.document.dispatch('pointerup', {pointerId: 2});
  f.document.dispatch('pointercancel', {pointerId: 2});
  f.flushFrames();
  assert.equal(f.styles.get('--col-name'), '248px');
  assert.equal(f.run('dragging'), true);
  assert.equal(f.saves.length, 0);
  f.document.dispatch('pointercancel');
});

test('open dialogs and non-primary pointer buttons cannot start column changes', () => {
  const f = fixture();
  f.handles[0].dispatch('pointerdown', {button: 2});
  f.ctx.modalOpen = true;
  f.handles[0].dispatch('pointerdown');
  f.handles[0].dispatch('keydown', {key: 'ArrowRight'});
  assert.equal(f.run('dragging'), false);
  assert.equal(f.saves.length, 0);
  assert.equal(f.document.listeners.size, 0);
});

test('releasing before the next frame commits the final pointer position once', () => {
  const f = fixture();
  f.handles[0].dispatch('pointerdown');
  f.document.dispatch('pointermove', {clientX: 130});
  assert.equal(f.frames.size, 1);
  f.document.dispatch('pointerup', {clientX: 160});
  assert.equal(f.run('proj.meta.cols.name'), 308);
  assert.equal(f.frames.size, 0);
  f.flushFrames();
  assert.equal(f.styles.get('--col-name'), '308px');
  assert.equal(f.saves.length, 1);
});

test('canceling before the next frame prevents a queued width from appearing later', () => {
  const f = fixture(), before = f.json('proj');
  f.handles[0].dispatch('pointerdown');
  f.document.dispatch('pointermove', {clientX: 150});
  assert.equal(f.frames.size, 1);
  f.document.dispatch('keydown', {key: 'Escape'});
  assert.equal(f.frames.size, 0);
  f.flushFrames();
  assert.equal(f.styles.get('--col-name'), '248px');
  assert.deepEqual(f.json('proj'), before);
  assert.equal(f.saves.length, 0);
});

test('dragging a scrolling field accounts for horizontal scrolling without resizing the name', () => {
  const f = fixture();
  f.handles[1].dispatch('pointerdown');
  f.body.scrollLeft = 68;
  f.document.dispatch('pointermove', {clientX: 120});
  f.flushFrames();
  f.document.dispatch('pointerup', {clientX: 120});
  assert.equal(f.run('proj.meta.cols.person'), 128);
  assert.equal(f.run('proj.meta.cols.name'), 248);
  assert.equal(f.body.scrollLeft, 68);
});

for (const cancellation of ['Escape', 'pointercancel', 'blur', 'lostpointercapture']) {
  test(`${cancellation} cancels a pane resize without changing any saved column widths`, () => {
    const f = fixture();
    f.run('bindSp()');
    const before = f.json('proj'), originalExtent = f.run('tableLayoutState.extent');
    f.splitter.dispatch('pointerdown');
    f.document.dispatch('pointermove', {clientX: 20});
    f.flushFrames();
    assert.equal(f.styles.get('--left-w'), '520px');
    assert.equal(f.styles.get('--col-name'), '248px');
    assert.deepEqual(f.json('proj'), before, 'Pending saves cannot observe a provisional pane width');
    f.document.dispatch('pointermove', {clientX: 10});
    assert.equal(f.frames.size, 1);
    f.body.scrollLeft = 90;
    if (cancellation === 'Escape') f.document.dispatch('keydown', {key: 'Escape'});
    else if (cancellation === 'blur') f.window.dispatch('blur');
    else if (cancellation === 'lostpointercapture') f.splitter.dispatch('lostpointercapture');
    else f.document.dispatch('pointercancel');
    f.flushFrames();
    assert.equal(f.styles.get('--left-w'), '600px');
    assert.equal(f.body.scrollLeft, 48);
    assert.equal(f.header.scrollLeft, 48);
    assert.equal(f.run('tableLayoutState.extent'), originalExtent);
    assert.equal(f.run('tableLayoutState.paneDrag'), null);
    assert.equal(f.run('dragging'), false);
    assert.equal(f.splitter.classList.contains('active'), false);
    assert.equal(f.frames.size, 0);
    for (const type of ['pointermove', 'pointerup', 'pointercancel', 'keydown']) assert.equal(f.document.listeners.get(type).size, 0);
    assert.deepEqual(f.json('proj'), before);
    assert.equal(f.saves.length, 0);
  });
}

test('pane release flushes the final coordinate once and preserves every independent column width', () => {
  const f = fixture();
  f.run('bindSp()');
  const before = f.json('proj.meta.cols');
  f.splitter.dispatch('pointerdown');
  f.document.dispatch('pointermove', {clientX: 190});
  f.document.dispatch('pointerup', {clientX: 220});
  assert.equal(f.styles.get('--left-w'), '720px');
  assert.equal(f.run('proj.meta.lw'), 720);
  assert.equal(f.run('proj.meta.paneAuto'), false);
  assert.deepEqual(f.json('proj.meta.cols'), before);
  assert.equal(f.frames.size, 0);
  assert.equal(f.saves.length, 1);
});

test('canceling an automatic pane drag restores the actual starting width instead of recalculating the default', () => {
  const f = fixture();
  f.run('bindSp();proj.meta.paneAuto=true');
  assert.equal(f.run('paneBounds().defaultWidth'), 576);
  f.styles.set('--left-w', '512px');
  const before = f.json('proj');
  f.splitter.dispatch('pointerdown');
  f.document.dispatch('pointermove', {clientX: 160});
  f.flushFrames();
  assert.equal(f.styles.get('--left-w'), '572px');
  f.document.dispatch('keydown', {key: 'Escape'});
  assert.equal(f.styles.get('--left-w'), '512px');
  assert.equal(f.body.scrollLeft, 48);
  assert.equal(f.header.scrollLeft, 48);
  assert.deepEqual(f.json('proj'), before);
  assert.equal(f.saves.length, 0);
  assert.equal(f.frames.size, 0);
  assert.equal(f.run('tableLayoutState.paneDrag'), null);
});
