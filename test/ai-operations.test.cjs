'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { operationDefinitions, applyOperations, normalizeProject, OperationError } = require('../cloud/ai/operations.cjs');
const { validateProject } = require('../project-validation.js');
const op = (name, args) => ({ name, arguments: args });
const task = (id, extra = {}) => ({ id, name: id, s: '2026-10-12', e: '2026-10-16', ...extra });
const project = () => normalizeProject({ tasks: [task('parent'), task('a', { pid: 'parent', who: '苏省', grp: '程序', phase: '开发' }), task('b', { pid: 'parent', deps: ['a'] }), task('c')], groups: [{ name: '程序', color: '#123456' }, { name: '策划', color: '#654321' }], flags: [{ id: 'release', name: '上线', d: '2026-10-20', color: '#abcdef' }], meta: { title: '测试排期' } });
const apply = (input, ...actions) => applyOperations(input, actions);
function errors(fn, code = 'VALIDATION_ERROR') { assert.throws(fn, error => error instanceof OperationError && error.code === code); }
const find = (result, id) => result.project.tasks.find(item => item.id === id);

test('operation catalog matches JSON and exposes complete strict schemas', () => {
  assert.deepEqual(operationDefinitions, require('../cloud/ai/operation-definitions.json'));
  assert.equal(operationDefinitions.length, 25);
  assert.equal(new Set(operationDefinitions.map(item => item.name)).size, 25);
  for (const definition of operationDefinitions) { assert.equal(definition.inputSchema.additionalProperties, false); assert.equal(typeof definition.destructiveHint, 'boolean'); }
});

test('normalization retains unknown JSON, strips personal layout, supplies only storage defaults', () => {
  const input = { tasks: [task('a', { fold: true, collapsed: true, externalReference: 'preserve' })], groups: [], meta: { cols: { name: 200 }, title: 'x', defView: 'week', external: { link: 'https://example.com' } } };
  const output = normalizeProject(input);
  assert.equal(output.tasks[0].externalReference, 'preserve'); assert.equal(output.meta.external.link, 'https://example.com');
  assert.deepEqual(output.groups, []); assert.deepEqual(output.flags, []); assert.equal(output.tasks[0].flow, false); assert.equal(output.tasks[0].pid, null);
  assert.equal('fold' in output.tasks[0], false); assert.equal('cols' in output.meta, false); assert.equal('defView' in output.meta, false);
  assert.equal(input.tasks[0].fold, true);
});

test('task add supports forward parent and dependency references within one atomic batch', () => {
  const input = normalizeProject({ tasks: [] });
  const output = apply(input, op('task.add', { task: task('child', { pid: 'parent', deps: ['first'] }) }), op('task.add', { task: task('parent') }), op('task.add', { task: task('first') }));
  assert.equal(find(output, 'child').pid, 'parent'); assert.deepEqual(find(output, 'child').deps, ['first']); assert.equal(input.tasks.length, 0);
  assert.deepEqual(output.results[0], { index: 0, name: 'task.add', affectedIds: ['child'] });
});

test('task add validates unique ID and same-parent insertion point', () => {
  const input = project();
  const output = apply(input, op('task.add', { task: task('new', { pid: 'parent' }), beforeId: 'b' }));
  assert.deepEqual(output.project.tasks.map(t => t.id), ['parent', 'a', 'new', 'b', 'c']);
  errors(() => apply(input, op('task.add', { task: task('a') })), 'ITEM_EXISTS');
  errors(() => apply(input, op('task.add', { task: task('new'), beforeId: 'a' })));
});

test('task update supports normal properties and preserves opaque fields', () => {
  const input = project(); input.tasks[1].opaque = { legacy: true };
  const output = apply(input, op('task.update', { id: 'a', patch: { name: '联调', who: '王三省', pct: 65.5, phase: '验收', s: '2026-10-13', e: '2026-10-18', lane: 2 } }));
  assert.equal(find(output, 'a').who, '王三省'); assert.equal(find(output, 'a').pct, 65.5); assert.deepEqual(find(output, 'a').opaque, { legacy: true });
  assert.equal(input.tasks[1].who, '苏省');
});

test('summary dates and progress cannot be silently edited', () => {
  for (const patch of [{ s: '2026-10-14' }, { e: '2026-10-20' }, { pct: 50 }]) errors(() => apply(project(), op('task.update', { id: 'parent', patch })));
  const output = apply(project(), op('task.update', { id: 'parent', patch: { flow: true } })); assert.equal(find(output, 'parent').flow, true);
});

test('milestone and pipeline creation follows hierarchy and date rules', () => {
  const output = apply(project(), op('task.add', { task: task('pipe', { type: 'pipeline' }) }), op('task.add', { task: task('node', { type: 'milestone', s: '2026-10-20', e: '2026-10-20', pid: 'pipe' }) }));
  assert.equal(find(output, 'pipe').type, 'pipeline'); assert.equal(find(output, 'node').s, find(output, 'node').e);
  errors(() => apply(project(), op('task.add', { task: task('bad', { type: 'pipeline', pid: 'parent' }) })));
  errors(() => apply(project(), op('task.add', { task: task('bad', { type: 'milestone' }) })));
});

test('task removal requires cascade and cleans dependencies atomically', () => {
  const input = project(); input.tasks[3].deps = ['b']; const snapshot = JSON.stringify(input);
  errors(() => apply(input, op('task.remove', { ids: ['parent'] })), 'ITEM_IN_USE'); assert.equal(JSON.stringify(input), snapshot);
  const output = apply(input, op('task.remove', { ids: ['parent'], cascade: true }));
  assert.deepEqual(output.project.tasks.map(t => t.id), ['c']); assert.deepEqual(find(output, 'c').deps, []);
  assert.deepEqual(new Set(output.results[0].affectedIds), new Set(['parent', 'a', 'b']));
});

test('explicitly listing parent and every child requires no implicit cascade', () => {
  assert.deepEqual(apply(project(), op('task.remove', { ids: ['parent', 'a', 'b'] })).project.tasks.map(t => t.id), ['c']);
});

test('task move reparents, reorders and rejects ancestry cycle', () => {
  const input = project(); const output = apply(input, op('task.move', { id: 'c', parentId: 'parent', beforeId: 'a' }));
  assert.equal(find(output, 'c').pid, 'parent'); assert.deepEqual(output.project.tasks.map(t => t.id), ['parent', 'c', 'a', 'b']);
  errors(() => apply(input, op('task.move', { id: 'parent', parentId: 'a' })));
  errors(() => apply(input, op('task.move', { id: 'c', parentId: null, beforeId: 'c' })));
});

test('sibling reorder requires a complete unique list and retains other slots', () => {
  const input = project(), output = apply(input, op('task.reorder', { parentId: 'parent', ids: ['b', 'a'] }));
  assert.deepEqual(output.project.tasks.map(t => t.id), ['parent', 'b', 'a', 'c']);
  errors(() => apply(input, op('task.reorder', { parentId: 'parent', ids: ['b'] })));
  errors(() => apply(input, op('task.reorder', { parentId: 'parent', ids: ['a', 'a'] })));
});

test('task shift de-duplicates overlapping subtrees without moving global milestones', () => {
  const output = apply(project(), op('task.shift', { ids: ['parent', 'a'], days: 2 }));
  assert.equal(find(output, 'a').s, '2026-10-14'); assert.equal(find(output, 'b').s, '2026-10-14');
  assert.equal(find(output, 'c').s, '2026-10-12'); assert.equal(output.project.flags[0].d, '2026-10-20');
});

test('project shift uses calendar days correctly across leap year and date limits', () => {
  const input = normalizeProject({ tasks: [task('a', { s: '2024-02-28', e: '2024-02-28' })], flags: [{ id: 'f', name: 'leap', d: '2024-02-29' }] });
  const output = apply(input, op('project.shift', { days: 1 })); assert.equal(find(output, 'a').s, '2024-02-29'); assert.equal(output.project.flags[0].d, '2024-03-01');
  const limit = normalizeProject({ tasks: [task('a', { s: '0100-01-01', e: '0100-01-01' })] }); errors(() => apply(limit, op('project.shift', { days: -1 })));
  const upper = normalizeProject({ tasks: [task('a', { s: '9999-12-31', e: '9999-12-31' })] }); errors(() => apply(upper, op('project.shift', { days: 1 })));
});

test('subtree duplication remaps internal references and keeps external dependencies', () => {
  const input = project(); input.tasks[1].deps = ['c'];
  const output = apply(input, op('task.duplicate', { id: 'parent', idMap: { parent: 'copy', a: 'copy_a', b: 'copy_b' } }));
  assert.equal(find(output, 'copy_a').pid, 'copy'); assert.deepEqual(find(output, 'copy_a').deps, ['c']); assert.deepEqual(find(output, 'copy_b').deps, ['copy_a']);
  assert.deepEqual(output.results[0].affectedIds, ['copy', 'copy_a', 'copy_b']);
});

test('duplication rejects incomplete maps, repeated IDs and occupied IDs', () => {
  const input = project(); errors(() => apply(input, op('task.duplicate', { id: 'parent', idMap: { parent: 'copy' } })));
  errors(() => apply(input, op('task.duplicate', { id: 'parent', idMap: { parent: 'copy', a: 'same', b: 'same' } })), 'ITEM_EXISTS');
  errors(() => apply(input, op('task.duplicate', { id: 'c', idMap: { c: 'a' } })), 'ITEM_EXISTS');
});

test('dependency operations are idempotent and preserve explicit direction', () => {
  const input = project(); assert.equal(apply(input, op('dependency.add', { taskId: 'b', dependsOn: 'a' })).changed, false);
  const output = apply(input, op('dependency.add', { taskId: 'c', dependsOn: 'b' }), op('dependency.remove', { taskId: 'b', dependsOn: 'a' }));
  assert.deepEqual(find(output, 'c').deps, ['b']); assert.deepEqual(find(output, 'b').deps, []);
  assert.deepEqual(find(apply(input, op('dependency.set', { taskId: 'b', deps: [] })), 'b').deps, []);
});

test('direct, ancestor, pipeline and implicit parent-boundary dependency cycles fail', () => {
  const input = project();
  errors(() => apply(input, op('dependency.add', { taskId: 'a', dependsOn: 'b' })));
  errors(() => apply(input, op('dependency.add', { taskId: 'a', dependsOn: 'parent' })));
  errors(() => apply(input, op('task.add', { task: task('pipe', { type: 'pipeline' }) }), op('dependency.add', { taskId: 'a', dependsOn: 'pipe' })));
  const graph = normalizeProject({ tasks: [task('p'), task('q'), task('p1', { pid: 'p' }), task('q1', { pid: 'q', deps: ['p'] })] });
  errors(() => apply(graph, op('dependency.add', { taskId: 'p1', dependsOn: 'q' })));
});

test('batch dependency replacement can temporarily form a cycle but final graph must be valid', () => {
  const input = project();
  const output = apply(input, op('dependency.add', { taskId: 'a', dependsOn: 'b' }), op('dependency.remove', { taskId: 'b', dependsOn: 'a' }));
  assert.deepEqual(find(output, 'a').deps, ['b']); assert.deepEqual(find(output, 'b').deps, []);
});

test('role rename updates every task and persists builtin color/hiding settings', () => {
  const output = apply(project(), op('role.update', { name: '程序', patch: { name: '研发', color: '#0f0' } }));
  assert.equal(find(output, 'a').grp, '研发'); assert.deepEqual(output.project.meta.hiddenRoles, ['程序']); assert.equal(output.project.meta.roleColors['研发'], '#0f0');
  const reloaded = validateProject(output.project); assert.equal(reloaded.groups.find(g => g.name === '研发').color, '#00ff00'); assert.equal(reloaded.groups.some(g => g.name === '程序'), false);
});

test('role removal requires explicit reassignment; default role can be added back', () => {
  const input = project(); errors(() => apply(input, op('role.remove', { name: '程序' })), 'ITEM_IN_USE');
  const output = apply(input, op('role.remove', { name: '程序', replacement: '策划' }), op('role.add', { name: '程序', color: '#333333' }));
  assert.equal(find(output, 'a').grp, '策划'); assert.equal(output.project.meta.hiddenRoles.includes('程序'), false); assert.equal(output.project.meta.roleColors['程序'], '#333333');
  errors(() => apply(input, op('role.remove', { name: '程序', replacement: '程序' })));
});

test('phase rename and remove are synchronized labels, not separate stored entities', () => {
  const output = apply(project(), op('phase.rename', { name: '开发', newName: '验收' })); assert.equal(find(output, 'a').phase, '验收');
  assert.equal(find(apply(output.project, op('phase.remove', { name: '验收' })), 'a').phase, '');
  errors(() => apply(project(), op('phase.remove', { name: '不存在' })), 'ITEM_NOT_FOUND');
});

const allFields = [
  { id: 'cf_text', name: '备注', type: 'text' }, { id: 'cf_number', name: '预计工时', type: 'number' },
  { id: 'cf_date', name: '验收日', type: 'date' }, { id: 'cf_check', name: '已确认', type: 'checkbox' },
  { id: 'cf_select', name: '优先级', type: 'select', options: [{ id: 'fo_high', label: '高' }, { id: 'fo_low', label: '低' }] }
];
function withFields() { return applyOperations(project(), allFields.map(field => op('field.add', { field }))).project; }

test('all five field types support values and null clearing without replacing untouched fields', () => {
  const input = withFields(), values = { cf_text: '说明', cf_number: 2.5, cf_date: '2026-10-19', cf_check: true, cf_select: 'fo_high' };
  const output = apply(input, op('field.values.set', { taskId: 'a', values })); assert.deepEqual(find(output, 'a').customValues, values);
  const cleared = apply(output.project, op('field.values.set', { taskId: 'a', values: { cf_number: null, cf_text: '修改' } }));
  assert.deepEqual(find(cleared, 'a').customValues, { cf_text: '修改', cf_date: '2026-10-19', cf_check: true, cf_select: 'fo_high' });
});

test('custom values validate exact types and do not allow unknown fields even when clearing', () => {
  const input = withFields();
  for (const values of [{ cf_number: '2' }, { cf_check: 1 }, { cf_date: '2026-02-30' }, { cf_select: 'not-an-option' }]) errors(() => apply(input, op('field.values.set', { taskId: 'a', values })));
  errors(() => apply(input, op('field.values.set', { taskId: 'a', values: { cf_missing: null } })), 'ITEM_NOT_FOUND');
});

test('removing select options clears removed choices and keeps stable retained choices', () => {
  const input = withFields(); const edited = apply(input, op('field.values.set', { taskId: 'a', values: { cf_select: 'fo_high' } }), op('field.values.set', { taskId: 'b', values: { cf_select: 'fo_low' } })).project;
  const output = apply(edited, op('field.update', { id: 'cf_select', patch: { options: [{ id: 'fo_low', label: '普通' }] } }));
  assert.equal(find(output, 'a').customValues.cf_select, undefined); assert.equal(find(output, 'b').customValues.cf_select, 'fo_low');
});

test('field deletion clears all task values and fixed field type cannot be patched', () => {
  const input = apply(withFields(), op('field.values.set', { taskId: 'a', values: { cf_text: 'memo' } })).project;
  const output = apply(input, op('field.remove', { id: 'cf_text' })); assert.equal(find(output, 'a').customValues.cf_text, undefined); assert.equal(output.project.meta.customFields.some(f => f.id === 'cf_text'), false);
  errors(() => apply(input, op('field.update', { id: 'cf_text', patch: { type: 'number' } })));
});

test('field names and option labels reject trimmed and case-insensitive duplicates', () => {
  errors(() => apply(project(), op('field.add', { field: { id: 'cf_dup', name: '负责人', type: 'text' } })), 'ITEM_EXISTS');
  errors(() => apply(project(), op('field.add', { field: { id: 'cf_dup', name: 'x', type: 'select', options: [{ id: 'fo_a', label: ' A ' }, { id: 'fo_b', label: 'a' }] } })), 'ITEM_EXISTS');
});

test('global milestones add, update and delete independently of task milestones', () => {
  const output = apply(project(), op('flag.add', { flag: { id: 'review', name: '验收', d: '2026-10-18' } }), op('flag.update', { id: 'review', patch: { d: '2026-10-19', color: '#123' } }), op('flag.remove', { id: 'release' }));
  assert.deepEqual(output.project.flags, [{ id: 'review', name: '验收', d: '2026-10-19', color: '#123' }]); assert.equal(output.project.tasks.length, 4);
});

test('replace requires explicit confirmation, strips local layout, and preserves metadata', () => {
  errors(() => apply(project(), op('project.replace', { project: { tasks: [] }, confirm: false })));
  const output = apply(project(), op('project.replace', { project: { tasks: [], meta: { title: '导入', cols: { name: 200 }, external: 'preserve' } }, confirm: true }));
  assert.equal(output.project.tasks.length, 0); assert.deepEqual(output.project.meta, { title: '导入', external: 'preserve' });
});

test('project title updates preserve all content and reject arbitrary metadata changes', () => {
  const input = project(), output = apply(input, op('project.update', { patch: { title: '新标题' } }));
  assert.equal(output.project.meta.title, '新标题'); assert.deepEqual(output.project.tasks, input.tasks);
  errors(() => apply(input, op('project.update', { patch: { apiKey: 'malicious' } })));
});

test('malformed imported documents return validation errors before subsequent actions run', () => {
  errors(() => apply(project(), op('project.replace', { project: { tasks: [], meta: null }, confirm: true }), op('project.update', { patch: { title: 'x' } })));
  errors(() => apply(project(), op('project.replace', { project: { tasks: [task('bad', { deps: 'wrong' })] }, confirm: true }), op('dependency.add', { taskId: 'bad', dependsOn: 'bad' })));
  errors(() => normalizeProject({ tasks: [], flags: null }));
});

test('shared representation rejects legacy missing names and duplicate dependencies', () => {
  errors(() => normalizeProject({ tasks: [{ id: 'missing-name', s: '2026-10-12', e: '2026-10-12' }] }));
  errors(() => normalizeProject({ tasks: [], flags: [{ id: 'missing-name', d: '2026-10-12' }] }));
  const replacement = project(); replacement.tasks.find(t => t.id === 'b').deps = ['a', 'a'];
  errors(() => normalizeProject(replacement));
  errors(() => apply(project(), op('project.replace', { project: replacement, confirm: true })));
});

test('failed batch leaves source unchanged and reports failing action index', () => {
  const input = project(), before = JSON.stringify(input);
  assert.throws(() => apply(input, op('project.update', { patch: { title: '暂存' } }), op('task.update', { id: 'missing', patch: { who: 'x' } })), error => error.code === 'ITEM_NOT_FOUND' && error.operationIndex === 1);
  assert.equal(JSON.stringify(input), before);
});

test('unknown operations, properties, wrong shapes and batch limits fail closed', () => {
  const input = project(); errors(() => apply(input, op('sql.execute', { query: 'x' })), 'UNKNOWN_OPERATION');
  errors(() => apply(input, op('task.update', { id: 'a', patch: { id: 'changed' } })));
  errors(() => applyOperations(input, [])); errors(() => applyOperations(input, Array.from({ length: 101 }, () => op('project.update', { patch: { title: 'x' } }))));
  errors(() => applyOperations(input, [{ name: 'project.update', arguments: { patch: { title: 'x' } }, extra: true }]));
  assert.equal(applyOperations(input, Array.from({ length: 100 }, () => op('project.update', { patch: { title: 'x' } }))).results.length, 100);
});

test('malicious JSON, accessors, cycles, nonfinite numbers and sparse arrays never execute', () => {
  let invoked = false; const evil = {}; Object.defineProperty(evil, 'tasks', { enumerable: true, get() { invoked = true; return []; } });
  errors(() => normalizeProject(evil)); assert.equal(invoked, false);
  errors(() => apply(project(), op('project.replace', { project: JSON.parse('{"tasks":[],"meta":{"__proto__":{"polluted":true}}}'), confirm: true })));
  errors(() => apply(project(), op('task.update', { id: 'a', patch: { pct: Infinity } })));
  const cyclic = {}; cyclic.a = cyclic; errors(() => normalizeProject(cyclic));
  const sparse = new Array(2); sparse[0] = op('project.update', { patch: { title: 'x' } }); errors(() => applyOperations(project(), sparse));
  assert.equal({}.polluted, undefined);
});

test('invalid final graph is atomic and no-op edits report changed false', () => {
  const input = project(), before = JSON.stringify(input); errors(() => apply(input, op('dependency.set', { taskId: 'a', deps: ['missing'] })));
  assert.equal(JSON.stringify(input), before);
  assert.equal(apply(input, op('task.update', { id: 'a', patch: { who: '苏省' } })).changed, false);
  assert.equal(apply(input, op('project.shift', { days: 0 })).changed, false);
});
