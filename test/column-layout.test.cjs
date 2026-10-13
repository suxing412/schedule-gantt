'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'scripts', 'columns.js'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('function colW()');
const end = source.indexOf('function bindColRz()', start);
assert.ok(start >= 0 && end > start, 'Column layout helpers are available');

function cell(id, text = '', extra = {}) {
  return {
    dataset: {col: id}, textContent: text, children: [],
    computed: {font: '12px sans-serif', letterSpacing: 'normal', paddingLeft: '10px', paddingRight: '10px', display: 'block'},
    ...extra,
  };
}
function child(text, width, isName = false, extra = {}) {
  return {
    textContent: text, computed: {font: '12px sans-serif', display: 'block'},
    classList: {contains: name => isName && name === 't-name'},
    getBoundingClientRect: () => ({width}), ...extra,
  };
}
function fixture(meta = {}, viewport = 640, ganttWidth = 1440) {
  const styles = new Map(), calls = {save: 0};
  const header = {scrollLeft: 0, cells: [], querySelectorAll(selector) { return selector === '.col' ? this.cells : []; }};
  const body = {clientWidth: viewport, offsetWidth: viewport + 4, scrollLeft: 0, rows: [], querySelectorAll: () => body.rows};
  const classes = new Set();
  const left = {classList: {contains: name => classes.has(name), toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }}};
  const gantt = {clientWidth: ganttWidth};
  const document = {
    documentElement: {clientWidth: ganttWidth, style: {setProperty: (key, value) => styles.set(key, value), getPropertyValue: key => styles.get(key) || ''}},
    querySelector: selector => ({'#g-left-hd': header, '#g-left-body': body, '#g-left': left, '#gantt': gantt}[selector] || null),
    createElement: () => ({getContext: () => ({measureText: text => ({width: [...text].length * 8})})}),
  };
  const ctx = vm.createContext({
    proj: {tasks: [], groups: [], flags: [], meta: {lw: 440, cols: {}, ...meta}},
    document, window: {innerWidth: ganttWidth}, $: document.querySelector,
    getComputedStyle: element => element.computed || element.style,
    schSave() { calls.save++; },
  });
  vm.runInContext(source, ctx);
  const run = expression => vm.runInContext(expression, ctx, {timeout: 1000});
  return {ctx, body, header, left, gantt, styles, calls, run, json: expression => JSON.parse(run(`JSON.stringify(${expression})`))};
}

test('missing column widths use independent defaults without deriving the name from panel width', () => {
  const f = fixture(), before = f.json('proj.meta');
  assert.deepEqual(f.json('visibleTableColumns().map(column=>colW()[column.id])'), [248, 88, 88, 88, 64]);
  f.run('proj.meta.lw=1100');
  assert.equal(f.run('colW().name'), 248);
  f.run('proj.meta.lw=440');
  f.run('applyColWidths()');
  assert.equal(f.styles.get('--table-w'), '576px');
  assert.deepEqual(f.json('proj.meta'), before);
});

test('legacy auto-fill metadata cannot expand or shrink saved columns when the panel viewport changes', () => {
  const f = fixture({nameAutoWidth: true, cols: {name: 650, person: 100, start: 80, end: 90, pct: 70}}, 1700);
  const before = f.json('proj.meta'), widths = f.json('colW()');
  const attributes = {};
  const handle = {dataset: {col: 'name'}, setAttribute: (name, value) => { attributes[name] = value; }};
  f.header.querySelectorAll = selector => selector === '.col-rz' ? [handle] : [];
  for (const viewport of [1700, 320, 0, 850]) {
    f.body.clientWidth = viewport;
    f.run('applyColWidths()');
    assert.deepEqual(f.json('fittedColWidths(colW())'), widths);
    assert.equal(f.styles.get('--table-w'), '990px');
  }
  assert.equal(attributes['aria-valuenow'], '650');
  assert.equal(attributes['aria-valuemax'], '1000');
  assert.deepEqual(f.json('proj.meta'), before);
  assert.equal(f.calls.save, 0);
});

test('visible custom columns add their own width without squeezing any existing column', () => {
  const f = fixture({customFields: [{id: 'cf_note', name: '备注', type: 'text'}]}, 435);
  assert.equal(f.run('fittedColWidths(colW()).name'), 248);
  f.run('applyColWidths()');
  assert.equal(f.styles.get('--table-w'), '696px');
  assert.equal(f.run('colW().cf_note'), 120);
});

test('hiding columns preserves every width and never hides the name', () => {
  const f = fixture({customFields: [{id: 'cf_note', name: '备注', type: 'text'}], hiddenColumns: ['name', 'grp', 'phase', 'person', 'cf_note']});
  assert.deepEqual(f.json('visibleTableColumns().map(column=>column.id)'), ['name', 'start', 'end', 'pct']);
  f.run('applyColWidths()');
  assert.equal(f.styles.get('--table-w'), '488px');
  assert.equal(f.run('colW().name'), 248);
  assert.equal(f.run('colW().cf_note'), 120);
});

test('column resize limits stay independent of the viewport and other visible fields', () => {
  const f = fixture({}, 200);
  assert.deepEqual(f.json('columnResizeBounds(allTableColumns().find(column=>column.id==="name"))'), {min: 120, max: 1000});
  assert.deepEqual(f.json('columnResizeBounds(allTableColumns().find(column=>column.id==="person"))'), {min: 60, max: 320});
  f.run('proj.meta.cols.name=650');
  assert.equal(f.run('fittedColWidths(colW()).name'), 650);
});

test('a name wider than the usable panel scrolls normally instead of shrinking its saved width', () => {
  const f = fixture({cols: {name: 650}}, 320);
  f.run('applyColWidths()');
  assert.equal(f.left.classList.contains('unpin-name'), true);
  assert.equal(f.styles.get('--col-name'), '650px');
  f.body.clientWidth = 900;
  f.run('applyColWidths()');
  assert.equal(f.left.classList.contains('unpin-name'), false);
  assert.equal(f.styles.get('--col-name'), '650px');
  assert.equal(f.run('proj.meta.cols.name'), 650);
  assert.equal(f.calls.save, 0);
});

test('fitted widths are a detached copy so layout drafts cannot mutate stored widths', () => {
  const f = fixture({}, 0);
  assert.deepEqual(f.json('fittedColWidths(colW())'), f.json('colW()'));
  assert.equal(f.run('(()=>{const base=colW();return fittedColWidths(base)!==base})()'), true);
});

test('resizing one field preserves all other visible and hidden column widths', () => {
  const f = fixture({cols: {name: 340, person: 150, start: 100, end: 115, pct: 80, grp: 172, cf_note: 290},
    customFields: [{id: 'cf_note', name: '备注', type: 'text'}], hiddenColumns: ['grp', 'phase', 'cf_note']});
  const before = f.json('colW()');
  assert.equal(f.run('setColumnWidth("person",101.2)'), true);
  assert.deepEqual(f.json('colW()'), {...before, person: 102});
  assert.equal(f.styles.get('--col-name'), '340px');
  assert.equal(f.run('setColumnWidth("person",102)'), false);
  assert.equal(f.calls.save, 1);
});

test('invalid width requests and unchanged widths do not create save snapshots', () => {
  const f = fixture({nameAutoWidth: false});
  assert.equal(f.run('setColumnWidth("person",88)'), false);
  assert.equal(f.run('setColumnWidth("missing",100)'), false);
  assert.equal(f.run('setColumnWidth("person",NaN)'), false);
  assert.equal(f.run('setColumnWidth("person",Infinity)'), false);
  assert.equal(f.calls.save, 0);
});

test('restoring default column widths resets custom and hidden fields in one save without changing task data', () => {
  const f = fixture({cols: {name: 430, person: 140, start: 160, end: 140, pct: 90, grp: 180, phase: 230, cf_note: 420},
    customFields: [{id: 'cf_note', name: '备注', type: 'text'}], hiddenColumns: ['grp', 'phase', 'cf_note'],
    columnOrder: ['name', 'person', 'cf_note', 'pct']});
  f.run('proj.tasks=[{id:"t1",name:"Task",customValues:{cf_note:"Keep this"}}]');
  const tasks = f.json('proj.tasks'), hidden = f.json('proj.meta.hiddenColumns'), order = f.json('proj.meta.columnOrder');
  assert.equal(f.run('resetColumnWidths()'), true);
  assert.deepEqual(f.json('colW()'), {name: 248, person: 88, start: 88, end: 88, pct: 64, grp: 96, phase: 112, cf_note: 120});
  assert.equal(f.calls.save, 1);
  assert.deepEqual(f.json('proj.tasks'), tasks);
  assert.deepEqual(f.json('proj.meta.hiddenColumns'), hidden);
  assert.deepEqual(f.json('proj.meta.columnOrder'), order);
  assert.equal(f.run('resetColumnWidths()'), false);
  assert.equal(f.calls.save, 1);
});

test('panel bounds reserve visible timeline space across desktop and compact widths', () => {
  const f = fixture();
  assert.deepEqual(f.json('paneBounds()'), {width: 1440, min: 280, max: 935, defaultWidth: 576});
  f.gantt.clientWidth = 760;
  assert.deepEqual(f.json('paneBounds()'), {width: 760, min: 240, max: 519, defaultWidth: 336});
  f.gantt.clientWidth = 400;
  assert.deepEqual(f.json('paneBounds()'), {width: 400, min: 192, max: 219, defaultWidth: 192});
  f.gantt.clientWidth = 5000;
  assert.equal(f.run('paneBounds().max'), 1200);
});

test('automatic pane defaults stay aligned to built-in defaults after columns are resized, hidden or reordered', () => {
  const f = fixture({paneAuto: true});
  const defaults = [[620, 248], [840, 336], [1060, 424], [1280, 512], [1440, 576]];
  const checkDefaults = () => {
    for (const [viewport, expected] of defaults) {
      f.gantt.clientWidth = viewport;
      assert.equal(f.run('paneBounds().defaultWidth'), expected, `Stable pane default at viewport ${viewport}`);
    }
  };
  checkDefaults();
  f.run('proj.meta.cols={name:430,person:140,start:160,end:160,pct:100}');
  checkDefaults();
  f.run('proj.meta.hiddenColumns=["person","start","end","pct","grp","phase"]');
  checkDefaults();
  f.run('proj.meta.customFields=[{id:"cf_note",name:"备注",type:"text"}];proj.meta.columnOrder=["name","cf_note","pct","end","start","person"]');
  checkDefaults();
  assert.equal(f.calls.save, 0);
});

test('responsive panel clamping only changes presentation and never changes saved panel or column widths', () => {
  const f = fixture({paneAuto: false, lw: 900, cols: {name: 430, person: 140}}, 220, 400);
  const before = f.json('proj.meta');
  f.run('applyPaneLayout()');
  assert.equal(f.styles.get('--left-w'), '219px');
  assert.deepEqual(f.json('proj.meta'), before);
  f.gantt.clientWidth = 1440;
  f.run('applyPaneLayout()');
  assert.equal(f.styles.get('--left-w'), '900px');
  assert.deepEqual(f.json('proj.meta'), before);
  assert.equal(f.calls.save, 0);
});

test('manual panel width and its reset preserve all independent column widths', () => {
  const f = fixture({cols: {name: 430, person: 140}});
  const columns = f.json('colW()');
  f.run('setPaneWidth(2000)');
  assert.equal(f.run('proj.meta.lw'), 935);
  assert.equal(f.run('proj.meta.paneAuto'), false);
  assert.equal(f.styles.get('--left-w'), '935px');
  assert.deepEqual(f.json('colW()'), columns);
  assert.equal(f.calls.save, 1);
  f.run('resetPaneLayout()');
  assert.equal(f.run('proj.meta.paneAuto'), true);
  assert.equal(f.styles.get('--left-w'), '576px');
  assert.deepEqual(f.json('colW()'), columns);
  assert.equal(f.calls.save, 2);
});

test('content fitting uses the widest rendered value, padding and the field bounds', () => {
  const f = fixture();
  f.header.cells = [cell('person', '负责人')];
  f.body.rows = [{children: [cell('person', '1234567890')]}, {children: [cell('person', 'short')]}];
  assert.equal(f.run('fitColumnToContent("person")'), true);
  assert.equal(f.run('proj.meta.cols.person'), 102);
  f.body.rows.push({children: [cell('person', 'x'.repeat(100))]});
  f.run('fitColumnToContent("person")');
  assert.equal(f.run('proj.meta.cols.person'), 320);
  assert.equal(f.run('proj.meta.cols.name'), 248);
});

test('name content fitting includes hierarchy padding, icons, badges, margins and gaps', () => {
  const f = fixture({cols: {name: 400}});
  f.header.cells = [cell('name', '名称')];
  f.body.rows = [{children: [cell('name', '', {
    computed: {paddingLeft: '56px', paddingRight: '10px', columnGap: '5px'},
    children: [child('', 6), child('', 10), child('Nested task', 30, true),
      child('阶段', 40, false, {computed: {display: 'block', marginLeft: '2px', marginRight: '2px'}}),
      child('', 12), child('hidden', 999, false, {computed: {display: 'none'}})],
  })]}];
  f.run('fitColumnToContent("name")');
  assert.equal(f.run('proj.meta.cols.name'), 248);
  assert.equal(f.run('proj.meta.nameAutoWidth'), false);
});

test('multiline content fits its rendered single-line text and hidden fields cannot be fitted', () => {
  const f = fixture({customFields: [{id: 'cf_note', name: '备注', type: 'text'}]});
  f.header.cells = [cell('cf_note', '备注')];
  f.body.rows = [{children: [cell('cf_note', ' \tsmall\n\r longer  note\t ')]}];
  assert.equal(f.run('fitColumnToContent("cf_note")'), true);
  assert.equal(f.run('proj.meta.cols.cf_note'), 158);
  f.run('proj.meta.hiddenColumns=["cf_note"]');
  assert.equal(f.run('fitColumnToContent("cf_note")'), false);
  assert.equal(f.calls.save, 1);
});

test('content fitting preserves non-breaking spaces that the rendered table does not collapse', () => {
  const f = fixture({customFields: [{id: 'cf_note', name: '备注', type: 'text'}]});
  f.header.cells = [cell('cf_note', '备注')];
  f.body.rows = [{children: [cell('cf_note', '\u00a0small\u00a0\u00a0note\u00a0')]}];
  assert.equal(f.run('fitColumnToContent("cf_note")'), true);
  assert.equal(f.run('proj.meta.cols.cf_note'), 126);
});
