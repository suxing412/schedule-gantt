'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { definitions, executeReadTool } = require('../cloud/ai/read-tools.cjs');
const { validateProject } = require('../project-validation.js');

const task = (id, values = {}) => ({
  id, name: id, pid: null, type: 'task', s: '2026-10-01', e: '2026-10-03',
  pct: 0, who: '林知行', grp: '程序', phase: '研发', deps: [], customValues: {}, ...values
});
function fixture() {
  return {
    tasks: [
      task('pipeline', { type: 'pipeline', grp: '', s: '2025-01-01', e: '2025-01-02' }),
      task('summary', { pid: 'pipeline', s: '2025-01-01', e: '2025-01-02', pct: 99, fold: true }),
      task('a', { pid: 'summary', name: 'Combat Prototype', pct: 100, customValues: { cf_priority: 'fo_high', cf_notes: 'contains Needle', cf_hours: 4, cf_done: true, cf_date: '2026-10-02' } }),
      task('b', { pid: 'summary', s: '2026-10-03', e: '2026-10-07', pct: 20, deps: ['a'], who: '张三' }),
      task('m', { pid: 'summary', type: 'milestone', s: '2026-10-07', e: '2026-10-07', deps: ['b'], who: '张三' }),
      task('c', { s: '2026-10-01', e: '2026-10-02', pct: 50, phase: '准备', who: '王五' }),
      task('early', { s: '2026-10-02', e: '2026-10-03', deps: ['a'] })
    ],
    groups: [{ name: '程序', color: '#0ea5e9' }],
    flags: [{ id: 'release', name: '提审', d: '2026-10-10', color: '#336699' }],
    meta: {
      title: 'Fixture',
      cols: { name: 200 }, lw: 900, hiddenColumns: ['pct'], columnOrder: ['name', 'pct'],
      customFields: [
        { id: 'cf_priority', name: '优先级', type: 'select', options: [{ id: 'fo_high', label: 'Urgent', color: '#ee4455' }] },
        { id: 'cf_notes', name: '备注', type: 'text' },
        { id: 'cf_hours', name: '预计工时', type: 'number' },
        { id: 'cf_done', name: '验收', type: 'checkbox' },
        { id: 'cf_date', name: '验收日期', type: 'date' }
      ],
      futureMetadata: { preserved: true }
    }
  };
}
function record(project = fixture()) {
  return {
    id: 'a'.repeat(32), revision: 7, project,
    createdAt: '2026-10-01T08:00:00Z', updatedAt: '2026-10-02T08:00:00Z', updatedBy: '苏省', source: 'external',
    editCodeHash: 'never-return-this-hash', apiKey: 'never-return-this-key', session: { token: 'never-return-this-token' }, privateColumn: 'never-return-this-private-column'
  };
}
const call = (name, args = {}, project) => executeReadTool(name, args, record(project));
function uiExpected(project) {
  const source = fs.readFileSync(path.join(__dirname, '../frontend/scripts/project.js'), 'utf8');
  const context = vm.createContext({ input: validateProject(project) });
  const json = vm.runInContext(
    'let proj=input,crit=new Set(),cf=new Set();const tD=s=>{const[y,m,d]=s.split("-").map(Number);return Math.floor(Date.UTC(y,m-1,d)/86400000)};function toast(){}\n' +
    source + '\nanalyze();JSON.stringify({critical:[...crit],edges:[...critEdges].map(JSON.parse),conflicts:[...cf],rows:proj.tasks.map(t=>({id:t.id,range:eRange(t),pct:isSum(t)?sumPct(t):t.pct}))})', context
  );
  return JSON.parse(json);
}

test('catalog exposes bounded read-only tool schemas and no mutation names', () => {
  assert.equal(definitions.length, 10);
  assert.equal(new Set(definitions.map(def => def.name)).size, definitions.length);
  for (const def of definitions) {
    assert.equal(def.readOnlyHint, true);
    assert.equal(def.annotations.readOnlyHint, true);
    assert.equal(def.annotations.destructiveHint, false);
    assert.equal(def.inputSchema.additionalProperties, false);
    if (def.inputSchema.properties.limit) assert.equal(def.inputSchema.properties.limit.maximum, 500);
  }
});

test('public record and export exclude private columns and personal layout, retain importable project data', () => {
  const input = record(), original = structuredClone(input);
  const output = executeReadTool('project.get', {}, input);
  assert.deepEqual(Object.keys(output).sort(), ['id', 'revision', 'project', 'createdAt', 'updatedAt', 'updatedBy', 'source'].sort());
  assert.equal(output.project.meta.lw, undefined);
  assert.equal(output.project.meta.cols, undefined);
  assert.equal(output.project.tasks[1].fold, undefined);
  assert.deepEqual(output.project.meta.futureMetadata, { preserved: true });
  const exported = executeReadTool('project.export', {}, input);
  assert.equal(exported.tasks.length, 7);
  assert.equal(exported.meta.customFields.length, 5);
  assert.doesNotThrow(() => validateProject(exported));
  for (const marker of ['never-return-this-hash', 'never-return-this-key', 'never-return-this-token', 'never-return-this-private-column']) assert.equal(JSON.stringify(output).includes(marker), false);
  exported.tasks[0].name = 'changed by caller';
  assert.deepEqual(input, original, 'read calls must not mutate caller project');
});

test('task.get separates stale stored parent fields from effective descendant dates/progress', () => {
  const parent = call('task.get', { id: 'summary' });
  assert.equal(parent.s, '2025-01-01');
  assert.equal(parent.pct, 99);
  assert.deepEqual(parent.computed, { s: '2026-10-01', e: '2026-10-07', pct: 50, isSummary: true, durationDays: 7, childCount: 3 });
  assert.equal(call('task.get', { id: 'm' }).computed.durationDays, 0);
  assert.equal(call('task.get', { id: 'pipeline' }).computed.durationDays, 0);
  assert.throws(() => call('task.get', { id: 'missing' }), { code: 'TASK_NOT_FOUND' });
});

test('task listing applies exact ownership/role/phase/type/parent filters and stable pagination', () => {
  assert.deepEqual(call('task.list', { filter: { who: '张三', grp: '程序', phase: '研发', type: 'task', pid: 'summary' } }).items.map(task => task.id), ['b']);
  assert.deepEqual(call('task.list', { filter: { pid: null } }).items.map(task => task.id), ['pipeline', 'c', 'early']);
  const result = call('task.list', { offset: 2, limit: 2 });
  assert.deepEqual(result.items.map(task => task.id), ['a', 'b']);
  assert.equal(result.total, 7);
  assert.equal(result.hasMore, true);
  assert.deepEqual(call('task.list', { offset: 99999 }).items, []);
});

test('date overlap and progress filters use effective summary values with inclusive endpoints', () => {
  assert.deepEqual(call('task.list', { filter: { isSummary: true, dateFrom: '2026-10-07', dateTo: '2026-10-07', pctMin: 50, pctMax: 50 } }).items.map(task => task.id), ['pipeline', 'summary']);
  assert.deepEqual(call('task.list', { filter: { dateFrom: '2026-10-08' } }).items, []);
  assert.deepEqual(call('task.list', { filter: { dateTo: '2026-10-01', isSummary: false } }).items.map(task => task.id), ['a', 'c']);
});

test('custom value filters preserve scalar types, option ids and null/absent semantics', () => {
  assert.deepEqual(call('task.list', { filter: { customValues: { cf_priority: 'fo_high', cf_hours: 4, cf_done: true, cf_date: '2026-10-02' } } }).items.map(task => task.id), ['a']);
  assert.equal(call('task.list', { filter: { customValues: { cf_hours: '4' } } }).total, 0);
  assert.equal(call('task.list', { filter: { customValues: { cf_notes: null } } }).total, 6);
  assert.throws(() => call('task.list', { filter: { customValues: { cf_unknown: 1 } } }), { code: 'INVALID_ARGUMENTS' });
});

test('search matches case-insensitive task text and custom text/select labels', () => {
  for (const query of ['combat', 'NEEDLE', 'urgent']) assert.deepEqual(call('task.search', { query }).items.map(task => task.id), ['a']);
  assert.deepEqual(call('task.search', { query: '研发', filter: { type: 'milestone' } }).items.map(task => task.id), ['m']);
  assert.equal(call('task.search', { query: '张三', limit: 1 }).total, 2);
  assert.equal(call('task.search', { query: '<script>' }).total, 0);
});

test('group, phase, field and flag tools distinguish custom fields and row milestones', () => {
  assert.deepEqual(call('group.list').items.filter(group => group.taskCount), [{ name: '程序', color: '#0ea5e9', taskCount: 6 }]);
  assert.equal(call('group.list').total, validateProject(fixture()).groups.length);
  assert.deepEqual(call('phase.list').items, [{ name: '研发', taskCount: 6 }, { name: '准备', taskCount: 1 }]);
  const fields = call('field.list');
  assert.equal(fields.total, 12);
  assert.equal(fields.items.filter(field => field.builtIn).length, 7);
  assert.equal(fields.items.find(field => field.id === 'person').property, 'who');
  assert.equal(fields.items.find(field => field.id === 'cf_priority').options[0].id, 'fo_high');
  assert.equal(call('flag.list').total, 1);
  assert.equal(call('flag.list').items[0].id, 'release');
});

test('analysis matches actual UI critical path, ignores stale parents and accepts equal end/start dates', () => {
  const project = fixture(), expected = uiExpected(project), result = call('project.analyze', {}, project);
  assert.deepEqual(result.criticalTasks.items.map(task => task.id), expected.critical);
  assert.deepEqual(result.criticalDependencies.items.map(edge => [edge.from, edge.to]), expected.edges);
  assert.deepEqual([...new Set(result.dateConflicts.items.map(edge => edge.to))], expected.conflicts);
  assert.equal(result.summary.criticalPathDays, 8);
  assert.equal(result.summary.progress, 42);
  assert.equal(result.summary.start, '2026-10-01');
  assert.equal(result.summary.end, '2026-10-07');
  assert.equal(result.summary.conflictTaskCount, 1);
  assert.deepEqual(result.dateConflicts.items, [{ from: 'a', fromName: 'Combat Prototype', to: 'early', toName: 'early', predecessorEnd: '2026-10-03', successorStart: '2026-10-02', overlapDays: 1 }]);
});

test('computed list values match UI eRange and sumPct for all fixture rows', () => {
  const project = fixture(), expected = uiExpected(project), list = call('task.list', {}, project);
  for (const row of list.items) {
    const ui = expected.rows.find(item => item.id === row.id);
    assert.equal(new Date(ui.range.s * 86400000).toISOString().slice(0, 10), row.computed.s);
    assert.equal(new Date(ui.range.e * 86400000).toISOString().slice(0, 10), row.computed.e);
    assert.equal(ui.pct, row.computed.pct);
  }
});

test('each analysis detail list paginates without changing complete-project summary', () => {
  const all = call('project.analyze'), result = call('project.analyze', { offset: 1, limit: 1 });
  assert.deepEqual(result.summary, all.summary);
  for (const key of ['criticalTasks', 'criticalDependencies', 'dateConflicts']) {
    assert.equal(result[key].total, all[key].total);
    assert.deepEqual(result[key].items, all[key].items.slice(1, 2));
  }
});

test('analysis of full-feature example preserves UI parity and intentional scheduling conflict', () => {
  const project = JSON.parse(fs.readFileSync(path.join(__dirname, '../examples/全功能示例排期_星火行动.json'), 'utf8'));
  const expected = uiExpected(project), result = call('project.analyze', { limit: 500 }, project);
  assert.equal(result.summary.taskCount, 43);
  assert.equal(result.summary.pipelineCount, 3);
  assert.equal(result.summary.nodeCount, 7);
  assert.equal(result.summary.flagCount, 4);
  assert.equal(result.summary.customFieldCount, 7);
  assert.deepEqual(result.criticalTasks.items.map(task => task.id), expected.critical);
  assert.deepEqual(result.criticalDependencies.items.map(edge => [edge.from, edge.to]), expected.edges);
  assert.deepEqual([...new Set(result.dateConflicts.items.map(edge => edge.to))], ['early_regression']);
  assert.equal(result.summary.criticalDependencyCount, 18);
});

test('empty projects produce zero summaries and empty collections', () => {
  const result = call('project.analyze', {}, { tasks: [], groups: [], flags: [], meta: {} });
  assert.equal(result.summary.taskCount, 0);
  assert.equal(result.summary.start, null);
  assert.equal(result.summary.end, null);
  assert.equal(result.summary.progress, 0);
  assert.equal(result.summary.criticalPathDays, 0);
  assert.deepEqual(result.criticalTasks.items, []);
});

test('invalid tool arguments fail explicitly rather than being silently ignored', () => {
  const invalid = [
    ['task.list', { limit: 501 }], ['task.list', { offset: -1 }], ['task.list', { limit: 0 }],
    ['task.list', { filter: { who: 123 } }], ['task.list', { filter: { type: 'unknown' } }],
    ['task.list', { filter: { pctMin: 60, pctMax: 50 } }], ['task.list', { filter: { pctMin: NaN } }],
    ['task.list', { filter: { dateFrom: '2026-02-30' } }], ['task.list', { filter: { dateFrom: '0099-01-01' } }],
    ['task.list', { filter: { dateFrom: '2026-10-03', dateTo: '2026-10-01' } }],
    ['task.list', { filter: { owner: 'typo' } }], ['task.list', { filter: { isSummary: 1 } }],
    ['task.search', {}], ['task.search', { query: '' }], ['task.search', { query: ' '.repeat(10) }],
    ['task.get', { id: '' }], ['task.get', {}], ['project.get', { token: 'unexpected' }],
    ['project.export', null], ['task.list', { filter: [] }]
  ];
  for (const [name, args] of invalid) assert.throws(() => call(name, args), { code: 'INVALID_ARGUMENTS' }, name + ' ' + JSON.stringify(args));
  assert.throws(() => call('project.destroy', {}), { code: 'UNKNOWN_TOOL' });
  assert.throws(() => executeReadTool('project.get', {}, { project: fixture() }), { code: 'INVALID_RECORD' });
});

test('invalid project graphs are rejected before analysis can hang or report misleading data', () => {
  const project = fixture();
  project.tasks.find(task => task.id === 'a').deps = ['b'];
  assert.throws(() => call('project.analyze', {}, project), { code: 'INVALID_PROJECT' });
});
