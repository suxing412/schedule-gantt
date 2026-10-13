const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

let html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
// Allow reviewing the replacement bundle before the main agent applies it to the shared HTML.
if (process.env.SCHEDULE_PATCH_PREVIEW === '1') {
  const patches = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.repair-work', 'dependencies.json'), 'utf8'));
  for (const patch of patches) {
    if (html.includes(patch.find)) {
      assert.equal(html.split(patch.find).length, 2, 'replacement target must be unique');
      html = html.replace(patch.find, patch.replace);
    } else {
      assert.ok(html.includes(patch.replace), 'replacement must already be applied or match its original target');
    }
  }
}

const dateCode = html.slice(html.indexOf('const DAY_MS ='), html.indexOf('const ZOOM ='));
const dataAndAnalysis = html.slice(html.indexOf('// Data helpers'), html.indexOf('// Axis'));
const dragCode = html.slice(html.indexOf('/* Ctrl-drag dep */'), html.indexOf('/* Dbl-click empty */'));
const hierarchyCode = html.slice(html.indexOf('/* 左侧拖动排序 */'), html.indexOf('/* Editor */'));
const candidatesCode = html.slice(html.indexOf('function depCandidates(q){'), html.indexOf('function showDepSug(){'));
const saveCode = html.slice(html.indexOf('function edSave(){'), html.indexOf('/* 里程碑旗：'));
const permissionCode = html.slice(html.indexOf('function mayEditProject('), html.indexOf('function undo(){'));
assert.ok(dataAndAnalysis.includes('function buildDependencyGraph('), 'tests must exercise the repaired HTML functions');
assert.ok(permissionCode.includes('function mayEditProject('), 'permission guard must use the actual source helper');

const DAY_MS = 86400000;
const baseDay = Date.UTC(2026, 9, 1) / DAY_MS;
const date = offset => new Date((baseDay + offset) * DAY_MS).toISOString().slice(0, 10);
const task = (id, start, end, deps = [], pid = null, type = 'task') => ({
  id, name: id, s: date(start), e: date(end), deps, pid, type, pct: 0, grp: '程序', who: ''
});

function app(tasks) {
  const handlers = new Map(), windowHandlers = new Map(), canvasHandlers = new Map();
  const messages = [];
  const canvas = { width: 1, height: 1, getContext: () => ({}),
    addEventListener: (name, listener) => canvasHandlers.set(name, listener),
    removeEventListener: (name, listener) => { if (canvasHandlers.get(name) === listener) canvasHandlers.delete(name); }
  };
  const element = id => ({
    dataset: { id }, style: {}, classList: { add() {}, remove() {} }, remove() {},
    getBoundingClientRect: () => ({ top: 0, bottom: 40, height: 40, left: 0, width: 100 })
  });
  const rows = new Map(tasks.map(t => [t.id, element(t.id)]));
  let dropId = null;
  let saves = 0;
  let renders = 0;
  const context = vm.createContext({
    input: structuredClone(tasks),
    document: {
      body: { appendChild() {} },
      addEventListener: (name, listener) => handlers.set(name, listener),
      removeEventListener: (name, listener) => { if (handlers.get(name) === listener) handlers.delete(name); },
      elementFromPoint: () => ({ closest: selector => selector === '.t-row' ? rows.get(dropId) : { dataset: { id: dropId } } })
    },
    window: {
      addEventListener: (name, listener) => windowHandlers.set(name, listener),
      removeEventListener: (name, listener) => { if (windowHandlers.get(name) === listener) windowHandlers.delete(name); }
    },
    ce: () => element(null),
    $: () => canvas,
    bPos: Object.fromEntries(tasks.map(t => [t.id, { x: 0, w: 1, cy: 0 }])),
    toast: (message, type) => messages.push({ message, type }),
    flash: message => messages.push({ message, type: 'success' }),
    setDragCur() {},
    depPreview: null,
    schDepDraw() {},
    render: () => renders++,
    schSave: () => saves++,
    edClose() {},
    // Keep this fixture focused on dependency transactions; custom value parsing has its own UI regression suite.
    parseCustomTaskValues: () => ({ values: {} }),
    fieldsError() {}
  });
  vm.runInContext('let proj={tasks:input,groups:[]};let crit=new Set(),cf=new Set(),eId=null,editDeps=[],dragging=false;' + permissionCode + dateCode + dataAndAnalysis + dragCode + hierarchyCode + candidatesCode + saveCode, context);
  const json = code => JSON.parse(vm.runInContext('JSON.stringify(' + code + ')', context));
  return {
    context,
    messages,
    run: code => vm.runInContext(code, context),
    analyze() {
      vm.runInContext('analyze()', context);
      return json('({critical:[...crit].sort(),conflicts:[...cf].sort()})');
    },
    graphHasCycle: () => vm.runInContext('dependencyCycle()', context),
    deps: id => json('byId(' + JSON.stringify(id) + ').deps'),
    snapshot: () => json('proj.tasks'),
    validate: (id, deps) => vm.runInContext('validateDependencies(' + JSON.stringify(id) + ',' + JSON.stringify(deps) + ')', context),
    criticalEdge: (from, to) => vm.runInContext('isCriticalDep(' + JSON.stringify(from) + ',' + JSON.stringify(to) + ')', context),
    edit(id, deps) {
      vm.runInContext('eId=' + JSON.stringify(id) + ';editDeps=' + JSON.stringify(deps), context);
    },
    candidates: () => json('depCandidates("").map(t=>t.id).sort()'),
    drag(from, to) {
      dropId = to;
      vm.runInContext('sDepD({button:0,preventDefault(){},stopPropagation(){}},byId(' + JSON.stringify(from) + '))', context);
      const up = handlers.get('mouseup');
      assert.equal(typeof up, 'function', 'actual drag handler must register a mouseup listener');
      up({ clientX: 0, clientY: 0 });
      assert.equal(canvasHandlers.size, 0, 'dependency drag removes its viewport scroll listener');
    },
    dragRow(from, to, mode = 'into') {
      dropId = to;
      context.rowStartEvent = { button: 0, clientX: 10, clientY: 100, target: { closest: () => rows.get(from) }, preventDefault() {}, stopPropagation() {} };
      vm.runInContext('startRowDrag(rowStartEvent,byId(' + JSON.stringify(from) + '))', context);
      handlers.get('mousemove')({ clientX: 10, clientY: mode === 'into' ? 20 : mode === 'after' ? 39 : 1 });
      handlers.get('mouseup')();
    },
    saves: () => saves,
    renders: () => renders
  };
}

test('a six-day task, zero-duration node, and six-day task beat an independent ten-day task', () => {
  const schedule = app([
    task('A', 0, 5), task('M', 6, 6, ['A'], null, 'milestone'),
    task('B', 7, 12, ['M']), task('C', 0, 9)
  ]);
  assert.deepEqual(schedule.analyze(), { critical: ['A', 'B', 'M'], conflicts: [] });
  assert.equal(schedule.criticalEdge('A', 'M'), true);
  assert.equal(schedule.criticalEdge('M', 'B'), true);
});

test('parent-to-parent dependencies serialize their child work without counting stale parent durations', () => {
  const schedule = app([
    task('P', 0, 99), task('A', 0, 1, [], 'P'), task('B', 2, 4, ['A'], 'P'),
    task('Q', 0, 99, ['P']), task('C', 5, 8, [], 'Q'), task('D', 0, 6)
  ]);
  assert.deepEqual(schedule.analyze(), { critical: ['A', 'B', 'C', 'P', 'Q'], conflicts: [] });
  assert.equal(schedule.criticalEdge('P', 'Q'), true);
});

test('a parent completion waits for its longest parallel child', () => {
  const schedule = app([
    task('P', 0, 99), task('short', 0, 1, [], 'P'), task('long', 0, 5, [], 'P'),
    task('Q', 0, 99, ['P']), task('next', 6, 9, [], 'Q'), task('independent', 0, 8)
  ]);
  assert.deepEqual(schedule.analyze().critical, ['P', 'Q', 'long', 'next']);
});

test('nested parent barriers preserve a dependency through multiple summary levels', () => {
  const schedule = app([
    task('P', 0, 99), task('N', 0, 99, [], 'P'), task('A', 0, 5, [], 'N'),
    task('Q', 0, 99, ['P']), task('B', 6, 11, [], 'Q'), task('C', 0, 9)
  ]);
  assert.deepEqual(schedule.analyze().critical, ['A', 'B', 'N', 'P', 'Q']);
});

test('dependency conflicts use the parent derived finish instead of its stale stored end', () => {
  const schedule = app([
    task('P', 0, 1), task('child', 0, 9, [], 'P'), task('next', 4, 7, ['P'])
  ]);
  assert.deepEqual(schedule.analyze().conflicts, ['next']);
});

test('a parent dependent uses its derived start and avoids a stale-start false warning', () => {
  const schedule = app([
    task('before', 0, 5), task('P', 0, 99, ['before']), task('child', 6, 8, [], 'P')
  ]);
  assert.deepEqual(schedule.analyze().conflicts, []);
});

test('a schedule containing only important nodes still checks dependency dates', () => {
  const schedule = app([
    task('M1', 9, 9, [], null, 'milestone'), task('M2', 8, 8, ['M1'], null, 'milestone')
  ]);
  assert.deepEqual(schedule.analyze().conflicts, ['M2']);
});

test('a pre-existing three-task cycle produces no fabricated critical path and reports it once', () => {
  const schedule = app([task('A', 0, 0, ['C']), task('B', 1, 1, ['A']), task('C', 2, 2, ['B'])]);
  assert.equal(schedule.graphHasCycle(), true);
  assert.deepEqual(schedule.analyze(), { critical: [], conflicts: ['A'] });
  assert.match(schedule.messages[0].message, /循环依赖/);
  schedule.analyze();
  assert.equal(schedule.messages.length, 1, 'rendering repeatedly must not repeat the same warning');
});

test('the actual Ctrl-drag handler rejects a transitive cycle without saving or changing dependencies', () => {
  const schedule = app([task('A', 0, 0), task('B', 1, 1, ['A']), task('C', 2, 2, ['B'])]);
  const before = schedule.snapshot();
  schedule.drag('C', 'A');
  assert.deepEqual(schedule.snapshot(), before);
  assert.equal(schedule.saves(), 0);
  assert.equal(schedule.graphHasCycle(), false);
  assert.match(schedule.messages.at(-1).message, /循环/);
});

test('the actual Ctrl-drag handler adds a legal dependency and saves it', () => {
  const schedule = app([task('A', 0, 1), task('B', 2, 3)]);
  schedule.drag('A', 'B');
  assert.deepEqual(schedule.deps('B'), ['A']);
  assert.equal(schedule.saves(), 1);
  assert.equal(schedule.graphHasCycle(), false);
});

test('both ancestor-to-descendant and descendant-to-ancestor dependencies are rejected', () => {
  const schedule = app([task('P', 0, 5), task('child', 0, 5, [], 'P')]);
  assert.match(schedule.validate('child', ['P']), /循环/);
  assert.match(schedule.validate('P', ['child']), /循环/);
});

test('parent barriers reveal an implicit cycle even when explicit dependency IDs have no cycle', () => {
  const schedule = app([
    task('P', 0, 99), task('a', 0, 2, ['Q'], 'P'),
    task('Q', 0, 99), task('b', 0, 2, ['P'], 'Q')
  ]);
  assert.equal(schedule.graphHasCycle(), true);
  assert.deepEqual(schedule.analyze().critical, []);
});

test('legal cross-group leaf dependencies are not rejected by collapsing parent groups', () => {
  const schedule = app([
    task('P', 0, 99), task('a', 0, 2, [], 'P'), task('b', 3, 5, ['d'], 'P'),
    task('Q', 0, 99), task('c', 3, 5, ['a'], 'Q'), task('d', 0, 2, [], 'Q')
  ]);
  assert.equal(schedule.graphHasCycle(), false);
  assert.equal(schedule.validate('c', ['a']), null);
  assert.equal(schedule.validate('b', ['d']), null);
});

test('dependency suggestions exclude all transitive downstream tasks', () => {
  const schedule = app([task('A', 0, 0), task('B', 1, 1, ['A']), task('C', 2, 2, ['B']), task('D', 0, 0)]);
  schedule.edit('A', []);
  assert.deepEqual(schedule.candidates(), ['D']);
});

test('editor save validates the complete final dependency set before any field mutation', () => {
  const schedule = app([task('A', 0, 0), task('B', 1, 1, ['A']), task('C', 2, 2, ['B'])]);
  const before = schedule.snapshot();
  schedule.edit('A', ['C']);
  schedule.run('edSave()');
  assert.deepEqual(schedule.snapshot(), before);
  assert.equal(schedule.saves(), 0);
  assert.equal(schedule.run('eId'), 'A', 'the editor must remain open to fix the rejected dependency');
});

test('a redundant edge between critical tasks is not marked as a driving critical dependency', () => {
  const schedule = app([task('A', 0, 2), task('B', 3, 5, ['A']), task('C', 6, 8, ['A', 'B'])]);
  assert.deepEqual(schedule.analyze().critical, ['A', 'B', 'C']);
  assert.equal(schedule.criticalEdge('A', 'B'), true);
  assert.equal(schedule.criticalEdge('B', 'C'), true);
  assert.equal(schedule.criticalEdge('A', 'C'), false);
});

test('pipelines remain structural containers and cannot be dependency endpoints', () => {
  const schedule = app([task('pipe', 0, 99, [], null, 'pipeline'), task('A', 0, 2, [], 'pipe'), task('B', 3, 5)]);
  assert.match(schedule.validate('B', ['pipe']), /管线/);
  assert.match(schedule.validate('pipe', ['B']), /管线/);
  assert.ok(!schedule.analyze().critical.includes('pipe'));
});

test('existing same-day conflict policy is retained while fixing range and graph handling', () => {
  const schedule = app([task('A', 0, 2), task('B', 2, 4, ['A'])]);
  assert.deepEqual(schedule.analyze().conflicts, []);
});

test('makeChild rejects moving a predecessor beneath its successor without changing the hierarchy or order', () => {
  const schedule = app([task('A', 0, 2), { ...task('B', 3, 5, ['A']), fold: true }]);
  const before = schedule.snapshot();
  assert.equal(schedule.run('makeChild("A","B")'), false);
  assert.deepEqual(schedule.snapshot(), before);
  assert.match(schedule.messages.at(-1).message, /新层级.*循环/);
});

test('moveTask rejects joining the child level of a dependent parent without mutating data', () => {
  const schedule = app([task('A', 0, 2), task('P', 0, 99, ['A']), task('child', 3, 5, [], 'P')]);
  const before = schedule.snapshot();
  assert.equal(schedule.run('moveTask("A","child",true)'), false);
  assert.deepEqual(schedule.snapshot(), before);
});

test('makeChild and moveTask continue to support legal reparenting and sibling insertion', () => {
  const schedule = app([task('P', 0, 99), task('child', 0, 2, [], 'P'), task('A', 3, 5), task('B', 6, 8)]);
  assert.equal(schedule.run('makeChild("A","P")'), true);
  assert.equal(schedule.run('moveTask("B","child",true)'), true);
  assert.deepEqual(schedule.snapshot().map(t => [t.id, t.pid]), [['P', null], ['A', 'P'], ['child', 'P'], ['B', 'P']]);
  assert.equal(schedule.graphHasCycle(), false);
});

test('sibling reorder preserves a legal dependency even if visual row order changes', () => {
  const schedule = app([task('P', 0, 99), task('A', 0, 2, [], 'P'), task('B', 3, 5, ['A'], 'P')]);
  assert.equal(schedule.run('moveTask("A","B",true)'), true);
  assert.deepEqual(schedule.snapshot().map(t => t.id), ['P', 'B', 'A']);
  assert.equal(schedule.graphHasCycle(), false);
});

test('the actual row-drop completion does not save a rejected reparent', () => {
  const schedule = app([task('A', 0, 2), task('B', 3, 5, ['A'])]);
  const before = schedule.snapshot();
  schedule.dragRow('A', 'B');
  assert.deepEqual(schedule.snapshot(), before);
  assert.equal(schedule.saves(), 0);
  assert.equal(schedule.renders(), 0);
  assert.match(schedule.messages.at(-1).message, /循环/);
});

test('the actual row-drop completion renders and saves a legal reparent', () => {
  const schedule = app([task('A', 0, 2), task('B', 3, 5)]);
  schedule.dragRow('A', 'B');
  assert.equal(schedule.snapshot().find(t => t.id === 'A').pid, 'B');
  assert.equal(schedule.saves(), 1);
  assert.equal(schedule.renders(), 1);
  assert.equal(schedule.graphHasCycle(), false);
});
