'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { validateProject, ValidationError, LIMITS } = require('../project-validation.js');

function task(id, changes = {}) {
  return { id, name: id, s: '2026-10-09', e: '2026-10-12', ...changes };
}
function project(tasks = [task('a')], changes = {}) {
  return { tasks, ...changes };
}
function rejects(input, expression) {
  assert.throws(() => validateProject(input), error => {
    assert.ok(error instanceof ValidationError);
    if (expression) assert.match(error.message, expression);
    return true;
  });
}

test('validates the actual desktop sample without changing its input', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const groups = html.match(/const GROUPS = \[[\s\S]*?\n\];/)[0];
  const sampleStart = html.indexOf('function sample(){');
  const sampleEnd = html.indexOf('// Data helpers', sampleStart);
  const sample = vm.runInNewContext(
    groups + '\nconst todayD=()=>20735; const fD=n=>new Date(n*86400000).toISOString().slice(0,10);\n' +
    html.slice(sampleStart, sampleEnd) + '\nsample();'
  );
  // Imported JSON belongs to the caller's realm, as in the actual renderer.
  const input = JSON.parse(JSON.stringify(sample)), before = JSON.stringify(input);
  const result = validateProject(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.tasks.length, 9);
  assert.equal(result.groups.length, 6);
  assert.equal(result.flags[0].name, '一测节点');
  assert.equal(result.tasks[1].pid, 's_pro');
  assert.notEqual(result.tasks, input.tasks);
  assert.equal(result.meta.cols.person, 64);
  assert.equal(result.tasks[0].flow, false);
  assert.deepEqual(validateProject(result), result);
});

test('migrates legacy long fields and preserves unknown JSON data', () => {
  const input = {
    tasks: [{ id: 'old', name: '', start: '2024-02-29', end: '2024-03-01',
      progress: 25, parentId: null, assignee: '小王', group: '玩法策划GD', collapsed: true,
      notes: { tags: ['原型'], count: 2 } }],
    groups: [{ name: '玩法策划GD', color: '#00f' }, { name: '外包', color: '#abc', extra: true }],
    meta: { leftWidth: 500, other: ['retain'] }, custom: { safe: true }
  };
  const result = validateProject(input), t = result.tasks[0];
  assert.equal(t.name, '未命名任务');
  assert.equal(t.s, '2024-02-29');
  assert.equal(t.e, '2024-03-01');
  assert.equal(t.pct, 25);
  assert.equal(t.pid, null);
  assert.equal(t.who, '小王');
  assert.equal(t.grp, '策划');
  assert.equal(t.fold, true);
  assert.equal(t.type, 'task');
  assert.deepEqual(t.deps, []);
  assert.deepEqual(result.custom, { safe: true });
  assert.deepEqual(t.notes, { tags: ['原型'], count: 2 });
  assert.equal(result.meta.lw, 500);
  assert.equal(result.groups.find(g => g.name === '外包').extra, true);
  result.tasks[0].notes.tags.push('changed');
  assert.deepEqual(input.tasks[0].notes.tags, ['原型']);
});

test('compact fields take precedence over their legacy aliases', () => {
  const result = validateProject(project([task('a', {
    start: '2026-10-01', progress: 5, pct: 75, group: '技术美术TA', grp: '美术'
  })]));
  assert.equal(result.tasks[0].s, '2026-10-09');
  assert.equal(result.tasks[0].pct, 75);
  assert.equal(result.tasks[0].grp, '美术');
});

test('accepts an empty project and a versioned storage wrapper', () => {
  const empty = validateProject({ tasks: [] });
  assert.deepEqual(empty.tasks, []);
  assert.deepEqual(empty.flags, []);
  assert.equal(empty.groups.length, 6);
  assert.equal(empty.meta.lw, 440);
  const wrapped = validateProject({ format: 'schedule-gantt-storage', version: 1,
    revision: 9, savedAt: '2026-10-09T10:00:00.000Z', project: { tasks: [] } });
  assert.deepEqual(wrapped, empty);
  rejects({ format: 'schedule-gantt-storage', version: 2, project: { tasks: [] } }, /存储版本/);
  rejects({ format: 'schedule-gantt-storage', version: 1 }, /必须是对象/);
});

test('keeps custom roles, used hidden defaults, and saved role colors', () => {
  const result = validateProject(project([
    task('a', { grp: '技术策划TD' }), task('b', { grp: '外包' }), task('c', { grp: '设计' })
  ], {
    groups: [{ name: '外包', color: '#abc' }, { name: '设计', color: '#123456' },
      { name: '测试', color: '#321' }, { name: '策划', color: '#aaa', preserved: true }],
    meta: { hiddenRoles: ['策划', '美术', '技术策划', '技术策划'],
      roleColors: { '技术策划': '#123', '外包': '#FF11EE' } }
  }));
  const names = result.groups.map(g => g.name);
  assert.ok(!names.includes('策划'));
  assert.ok(!names.includes('美术'));
  assert.ok(!names.includes('测试'));
  assert.ok(names.includes('技术策划'));
  assert.ok(names.includes('外包'));
  assert.ok(names.includes('设计'));
  assert.equal(result.groups.find(g => g.name === '技术策划').color, '#112233');
  assert.equal(result.groups.find(g => g.name === '外包').color, '#FF11EE');
  assert.deepEqual(result.meta.hiddenRoles, ['策划', '美术', '技术策划']);
  assert.equal(result.tasks[0].grp, '技术策划');
});

test('rejects invalid dates, date ranges, IDs, and field types without modifying input', () => {
  const cases = [
    { id: '' }, { id: ' ' }, { id: 1 }, { s: '2026-02-30' }, { s: '1900-02-29' },
    { s: '2026-2-09' }, { e: '2026-10-08' }, { e: null }, { s: '0099-12-01' },
    { name: {} }, { who: 8 }, { phase: [] }, { grp: {} }, { type: 'unknown' },
    { pid: '' }, { pct: -1 }, { pct: 101 }, { pct: '25' }, { pct: null },
    { lane: -1 }, { lane: 1.2 }, { lane: '1' }, { fold: 1 }, { flow: 'false' },
    { deps: {} }, { deps: [7] }
  ];
  for (const change of cases) {
    const input = project([task('a', change)]), before = JSON.stringify(input);
    rejects(input);
    assert.equal(JSON.stringify(input), before);
  }
  rejects(project([task('a'), task('a')]), /ID 重复/);
  assert.equal(validateProject(project([task('a', { s: '2000-02-29', e: '2000-02-29' })])).tasks[0].s, '2000-02-29');
});

test('rejects malformed root, metadata, group, and flag values', () => {
  for (const input of [null, [], 'project', {}, { tasks: {} }, { tasks: [null] },
    project([], { groups: { length: 1 } }), project([], { groups: null }),
    project([], { flags: {} }), project([], { meta: [] }), project([], { meta: null })]) rejects(input);
  const invalidMetas = [
    { lw: '440' }, { lw: -1 }, { leftWidth: -1 }, { cols: [] }, { cols: { person: '64' } },
    { cols: { date: 0 } }, { defView: 'year' }, { defView: {} },
    { hiddenRoles: '策划' }, { hiddenRoles: [1] }, { roleColors: [] },
    { roleColors: { '策划': 'red' } }, { roleColors: { '策划': '#123456;display:none' } }
  ];
  for (const meta of invalidMetas) rejects(project([], { meta }));
  for (const groups of [
    [{ name: '', color: '#123' }], [{ name: 1, color: '#123' }],
    [{ name: '外包', color: 'url(javascript:alert(1))' }],
    [{ name: '外包', color: '#123' }, { name: '外包', color: '#456' }]
  ]) rejects(project([], { groups }));
  for (const flag of [
    { id: '', name: '节点', d: '2026-10-09' },
    { id: 'f', name: {}, d: '2026-10-09' },
    { id: 'f', name: '节点', d: '2026-02-30' },
    { id: 'f', name: '节点', d: '2026-10-09', color: '#1234567' }
  ]) rejects(project([], { flags: [flag] }));
  rejects(project([], { flags: [{ id: 'f', d: '2026-10-09' }, { id: 'f', d: '2026-10-09' }] }), /ID 重复/);
});

test('accepts milestones and pipelines with compatible optional fields', () => {
  const result = validateProject(project([
    task('pipeline', { type: 'pipeline', grp: '美术' }),
    task('child', { pid: 'pipeline' }),
    { id: 'm', type: 'milestone', s: '2026-10-13', deps: ['child', 'child'], lane: 2 }
  ]));
  assert.equal(result.tasks[0].grp, '');
  assert.equal(result.tasks[2].e, '2026-10-13');
  assert.deepEqual(result.tasks[2].deps, ['child']);
  rejects(project([task('m', { type: 'milestone' })]), /起止日期必须相同/);
  rejects(project([task('m', { type: 'milestone', e: '2026-10-09' }), task('c', { pid: 'm' })]), /不能有子任务/);
  rejects(project([task('a'), task('p', { pid: 'a', type: 'pipeline' })]), /只能位于顶层/);
  rejects(project([task('a'), task('p', { type: 'pipeline', deps: ['a'] })]), /不能参与依赖/);
  rejects(project([task('p', { type: 'pipeline' }), task('a', { deps: ['p'] })]), /不能参与依赖/);
});

test('normalizes short hex colors for the renderer while preserving their actual color', () => {
  const result = validateProject(project([], {
    groups: [{ name: '外包', color: '#AbC' }],
    flags: [{ id: 'f', name: '节点', d: '2026-10-09', color: '#e03' }],
    meta: { roleColors: { '美术': '#F0a' } }
  }));
  assert.equal(result.groups.find(g => g.name === '外包').color, '#AAbbCC');
  assert.equal(result.groups.find(g => g.name === '美术').color, '#FF00aa');
  assert.equal(result.meta.roleColors['美术'], '#FF00aa');
  assert.equal(result.flags[0].color, '#ee0033');
  assert.deepEqual(validateProject(result), result);
});

test('rejects missing parents, parent cycles, and direct dependency cycles', () => {
  rejects(project([task('a', { pid: 'missing' })]), /父任务不存在/);
  rejects(project([task('a', { pid: 'a' })]), /存在循环/);
  rejects(project([task('a', { pid: 'b' }), task('b', { pid: 'a' })]), /存在循环/);
  rejects(project([task('a', { deps: ['missing'] })]), /前置任务不存在/);
  rejects(project([task('a', { deps: ['a'] })]), /自身、祖先或后代/);
  rejects(project([task('a', { deps: ['b'] }), task('b', { deps: ['a'] })]), /形成循环/);
  rejects(project([task('a', { deps: ['c'] }), task('b', { deps: ['a'] }), task('c', { deps: ['b'] })]), /形成循环/);
});

test('rejects dependencies on ancestors or descendants and implicit cycles across summaries', () => {
  rejects(project([task('p', { deps: ['c'] }), task('c', { pid: 'p' })]), /自身、祖先或后代/);
  rejects(project([task('p'), task('c', { pid: 'p', deps: ['p'] })]), /自身、祖先或后代/);
  // No explicit dependency cycle: Q -> P and P's child -> Q's child.
  // Finishing Q requires its child, whose dependency cannot finish until P starts.
  rejects(project([
    task('p', { deps: ['q'] }), task('pc', { pid: 'p' }),
    task('q'), task('qc', { pid: 'q', deps: ['pc'] })
  ]), /形成循环/);
  // A dependency in each direction between two trees may still be valid when
  // different leaves can execute in order. Do not collapse whole trees to nodes.
  const valid = validateProject(project([
    task('p'), task('pa', { pid: 'p' }), task('pb', { pid: 'p', deps: ['qa'] }),
    task('q'), task('qa', { pid: 'q', deps: ['pa'] })
  ]));
  assert.equal(valid.tasks.length, 5);
});

test('bounds the separate flat-encoded task hierarchy before recursive UI consumers run', () => {
  const hierarchy = count => Array.from({ length: count }, (_, i) => task('t' + i, { pid: i ? 't' + (i - 1) : null }));
  assert.equal(validateProject(project(hierarchy(LIMITS.maxHierarchyDepth))).tasks.length, 128);
  rejects(project(hierarchy(LIMITS.maxHierarchyDepth + 1)), /任务层级超过限制 128/);
  rejects(project(hierarchy(LIMITS.maxTasks)), /任务层级超过限制 128/);
  // Many siblings are shallow and remain valid at the project task limit.
  assert.equal(validateProject(project(Array.from({ length: LIMITS.maxTasks }, (_, i) => task('t' + i)))).tasks.length, LIMITS.maxTasks);
});

test('rejects dangerous keys, prototypes, cyclic/non-JSON data, and accessors', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    rejects(JSON.parse('{"tasks":[],"meta":{"' + key + '":{}}}'), /不安全的字段名/);
  }
  rejects(Object.create({ tasks: [] }), /原型/);
  const circular = { tasks: [] }; circular.self = circular;
  rejects(circular, /循环引用/);
  for (const value of [undefined, NaN, Infinity, () => {}, 1n, new Date()]) {
    rejects(project([], { unknown: value }));
  }
  let accessed = false;
  const withGetter = { tasks: [] };
  Object.defineProperty(withGetter, 'unknown', { enumerable: true, get() { accessed = true; throw Error('getter ran'); } });
  rejects(withGetter, /普通 JSON 值/);
  assert.equal(accessed, false);
  const arrayWithField = []; arrayWithField.extra = true;
  rejects(project(arrayWithField), /额外字段/);
  rejects(project(Array(2)), /空洞/);
  const nullPrototype = Object.create(null); nullPrototype.tasks = [];
  assert.deepEqual(validateProject(nullPrototype).tasks, []);
});

test('bounds project size, nesting, text, and collection sizes', () => {
  rejects(project([], { large: '文'.repeat(4 * 1024 * 1024) }), /超过 10 MiB/);
  const tooDeep = { tasks: [] }; let next = tooDeep;
  for (let i = 0; i <= LIMITS.maxDepth; i++) next = next.child = {};
  rejects(tooDeep, /嵌套过深/);
  rejects(project([task('a', { name: 'a'.repeat(2049) })]), /文本过长/);
  rejects(project(Array.from({ length: LIMITS.maxTasks + 1 }, (_, i) => task('t' + i))), /数量超过限制/);
  rejects(project([], { groups: Array.from({ length: LIMITS.maxGroups + 1 }, (_, i) => ({ name: 'g' + i, color: '#123' })) }), /数量超过限制/);
  // Six default roles cannot push an accepted output over its own input limit.
  rejects(project([], { groups: Array.from({ length: LIMITS.maxGroups }, (_, i) => ({ name: 'g' + i, color: '#123' })) }), /数量超过限制/);
  rejects(project([], { extra: Array(LIMITS.maxNodes - 5).fill(0) }), /归一化后的项目结构过大/);
});

test('exports the same API to a browser global without Node dependencies', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'project-validation.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(typeof context.ScheduleProjectValidation.validateProject, 'function');
  assert.equal(vm.runInContext('ScheduleProjectValidation.validateProject({tasks:[]}).meta.lw', context), 440);
  assert.equal(vm.runInContext('ScheduleProjectValidation.validateProject({tasks:[]}).groups.length', context), 6);
  assert.equal(vm.runInContext("try { ScheduleProjectValidation.validateProject({tasks:[{id:'x',s:'2026-02-30',e:'2026-10-09'}]}); false } catch(e) { e instanceof ScheduleProjectValidation.ValidationError }", context), true);
});

function customField(id, type = 'text', changes = {}) {
  return { id, name: '字段 ' + id, type,
    ...(type === 'select' ? { options: [{ id: 'fo_todo', label: '待办' }, { id: 'fo_done', label: '完成' }] } : {}),
    ...changes };
}
function allCustomFields() {
  return ['text', 'number', 'date', 'select', 'checkbox'].map(type => customField('cf_' + type, type));
}

test('supports all custom field types without changing built-in schedule semantics', () => {
  const values = { cf_text: '<b>备注</b>\n第二行', cf_number: -12.5, cf_date: '2000-02-29', cf_select: 'fo_done', cf_checkbox: false };
  const input = project([
    task('a', { customValues: values }), task('b', { deps: ['a'] })
  ], { meta: { customFields: allCustomFields(), columnOrder: ['name', 'cf_text', 'person', 'cf_number'], hiddenColumns: ['grp', 'phase', 'cf_date'], cols: {cf_text:150} } });
  const before = JSON.stringify(input), result = validateProject(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(result.tasks[0].customValues, values);
  assert.equal(result.tasks[0].s, '2026-10-09');assert.equal(result.tasks[0].e, '2026-10-12');assert.equal(result.tasks[0].pct, 0);
  assert.deepEqual(result.tasks[1].deps, ['a']);assert.equal(Object.hasOwn(result.tasks[1], 'customValues'), false);
  assert.deepEqual(result.meta.columnOrder, ['name', 'cf_text', 'person', 'cf_number']);
  assert.deepEqual(result.meta.hiddenColumns, ['grp', 'phase', 'cf_date']);assert.equal(result.meta.cols.cf_text, 150);
  assert.deepEqual(validateProject(result), result);
});

test('omitted custom field and layout properties stay omitted for legacy project identity', () => {
  const result = validateProject(project([task('a')], { meta: { lw:500 } }));
  for (const key of ['customFields', 'columnOrder', 'hiddenColumns']) assert.equal(Object.hasOwn(result.meta,key), false);
  assert.equal(Object.hasOwn(result.tasks[0],'customValues'), false);
  assert.deepEqual(validateProject(result), result);
  const explicit = validateProject(project([task('a',{customValues:{}})], {meta:{customFields:[],columnOrder:[],hiddenColumns:[]}}));
  assert.deepEqual(explicit.meta.customFields, []);assert.deepEqual(explicit.meta.columnOrder, []);assert.deepEqual(explicit.meta.hiddenColumns, []);
  assert.deepEqual(explicit.tasks[0].customValues, {});
});

test('optional title auto width is a strict boolean and stays omitted for legacy identity', () => {
  const legacy = validateProject(project([task('a')], { meta: { lw:500, other:{retained:true} } }));
  assert.equal(Object.hasOwn(legacy.meta,'nameAutoWidth'),false);
  assert.equal(Object.hasOwn(legacy.meta,'namePinned'),false);
  assert.deepEqual(validateProject(legacy),legacy);
  for(const nameAutoWidth of [false,true]){
    const input=project([task('a',{customValues:{cf_notes:'保留'}})],{meta:{nameAutoWidth,customFields:[customField('cf_notes')],other:{retained:true}}});
    const before=JSON.stringify(input),result=validateProject(input);
    assert.equal(result.meta.nameAutoWidth,nameAutoWidth);assert.equal(JSON.stringify(input),before);
    assert.deepEqual(result.meta.other,{retained:true});assert.deepEqual(result.tasks[0].customValues,{cf_notes:'保留'});
    const wrapped=validateProject({format:'schedule-gantt-storage',version:1,revision:1,savedAt:'2026-10-10T00:00:00.000Z',project:input});
    assert.deepEqual(wrapped,result);assert.deepEqual(validateProject(result),result);
  }
  for(const nameAutoWidth of [null,0,1,'true','false',{},[]]){
    const input=project([],{meta:{nameAutoWidth}}),before=JSON.stringify(input);
    rejects(input,/nameAutoWidth.*必须是布尔值/);assert.equal(JSON.stringify(input),before);
  }
});

test('optional pane layout metadata validates without changing legacy identity or title width settings', () => {
  const oldInput=project([task('a')],{meta:{lw:500,nameAutoWidth:false,other:{retained:true}}});
  const oldResult=validateProject(oldInput);
  assert.equal(Object.hasOwn(oldResult.meta,'layoutVersion'),false);
  assert.equal(Object.hasOwn(oldResult.meta,'paneAuto'),false);
  assert.equal(oldResult.meta.nameAutoWidth,false);assert.equal(oldResult.meta.lw,500);
  assert.deepEqual(validateProject(oldResult),oldResult);
  for(const paneAuto of [false,true]){
    const input=project([task('a')],{meta:{layoutVersion:2,paneAuto,nameAutoWidth:true,lw:100}});
    const before=JSON.stringify(input),result=validateProject(input);
    assert.equal(result.meta.layoutVersion,2);assert.equal(result.meta.paneAuto,paneAuto);
    assert.equal(result.meta.nameAutoWidth,true);assert.equal(result.meta.lw,100);
    assert.equal(JSON.stringify(input),before);assert.deepEqual(validateProject(result),result);
    const wrapper={format:'schedule-gantt-storage',version:1,revision:1,savedAt:'2026-10-10T00:00:00.000Z',project:input};
    assert.deepEqual(validateProject(wrapper),result);
  }
  const onlyVersion=validateProject(project([],{meta:{layoutVersion:2,lw:2000}}));
  assert.equal(Object.hasOwn(onlyVersion.meta,'paneAuto'),false);assert.equal(onlyVersion.meta.lw,2000);
  const onlyPane=validateProject(project([],{meta:{paneAuto:false}}));
  assert.equal(Object.hasOwn(onlyPane.meta,'layoutVersion'),false);assert.equal(onlyPane.meta.paneAuto,false);
  for(const layoutVersion of [null,0,1,3,'2',true,{},[]]){
    const input=project([],{meta:{layoutVersion}}),before=JSON.stringify(input);
    rejects(input,/layoutVersion.*布局版本只能是 2/);assert.equal(JSON.stringify(input),before);
  }
  for(const paneAuto of [null,0,1,'true','false',{},[]]){
    const input=project([],{meta:{paneAuto}}),before=JSON.stringify(input);
    rejects(input,/paneAuto.*必须是布尔值/);assert.equal(JSON.stringify(input),before);
  }
  rejects(project([],{meta:{layoutVersion:2,paneAuto:true,lw:99}}),/meta.lw/);
  rejects(project([],{meta:{layoutVersion:2,paneAuto:false,lw:2001}}),/meta.lw/);
});

test('v2 column widths remain stable through save and reload without injecting legacy defaults', () => {
  for(const cols of [undefined,{}, {date:76}, {name:280,person:92,start:108,end:112,pct:64,date:88,cf_notes:150}]){
    const meta={layoutVersion:2,paneAuto:true,lw:500};
    if(cols!==undefined)meta.cols=cols;
    const input=project([task('a')],{meta}),before=JSON.stringify(input);
    const normalized=validateProject(input);
    const expectedCols=cols===undefined?{}:{...cols};delete expectedCols.date;
    assert.deepEqual(normalized.meta.cols,expectedCols);
    assert.equal(Object.hasOwn(normalized.meta.cols,'date'),false);
    assert.equal(JSON.stringify(input),before);
    const saved={format:'schedule-gantt-storage',version:1,revision:2,savedAt:'2026-10-10T00:00:00.000Z',project:normalized};
    const reloaded=validateProject(JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(reloaded,normalized);
    assert.deepEqual(validateProject(reloaded),normalized);
  }
  for(const date of [null,'76',15,2001]){
    const input=project([],{meta:{layoutVersion:2,cols:{date}}}),before=JSON.stringify(input);
    rejects(input,/meta.cols.date/);assert.equal(JSON.stringify(input),before);
  }
});

test('legacy column width normalization keeps its previous defaults and supplied values', () => {
  const empty=validateProject(project([],{meta:{cols:{}}}));
  assert.deepEqual(empty.meta.cols,{person:64,date:76,pct:52});
  assert.equal(Object.hasOwn(empty.meta,'layoutVersion'),false);
  const input=project([],{meta:{cols:{person:91,date:84,cf_notes:150},paneAuto:false,nameAutoWidth:false}});
  const before=JSON.stringify(input),result=validateProject(input);
  assert.deepEqual(result.meta.cols,{person:91,date:84,cf_notes:150,pct:52});
  assert.equal(JSON.stringify(input),before);assert.deepEqual(validateProject(result),result);
});

test('new custom fields leave existing tasks empty and preserve optional descriptor metadata', () => {
  const fields = [customField('cf_notes','text',{name:'  备注  ',extra:{help:'可选说明'}}),customField('cf_empty','select',{options:[]})];
  const result = validateProject(project([task('a')],{meta:{customFields:fields}}));
  assert.equal(result.meta.customFields[0].name,'备注');assert.deepEqual(result.meta.customFields[0].extra,{help:'可选说明'});
  assert.equal(Object.hasOwn(result.tasks[0],'customValues'),false);assert.deepEqual(result.meta.customFields[1].options,[]);
});

test('custom null values are cleared while empty text, zero, and false are preserved', () => {
  const input=project([task('a',{customValues:{cf_text:'',cf_number:0,cf_date:null,cf_select:null,cf_checkbox:false}})],{meta:{customFields:allCustomFields()}});
  const before=JSON.stringify(input),result=validateProject(input);
  assert.deepEqual(result.tasks[0].customValues,{cf_text:'',cf_number:0,cf_checkbox:false});assert.equal(JSON.stringify(input),before);
  const cleared=validateProject(project([task('a',{customValues:{cf_text:null}})],{meta:{customFields:[customField('cf_text')]}}));
  assert.deepEqual(cleared.tasks[0].customValues,{});
  rejects(project([task('a',{customValues:{cf_missing:null}})]),/自定义字段不存在/);
});

test('custom field names are nonempty, bounded, and unique against built-in columns', () => {
  for(const name of ['', ' ', '名称','负责人','开始','结束','进度','职能','阶段',' 负责人 ','x'.repeat(129)]){
    rejects(project([],{meta:{customFields:[customField('cf_a','text',{name})]}}));
  }
  rejects(project([],{meta:{customFields:[customField('cf_a','text',{name:'备注'}),customField('cf_b','number',{name:' 备注 '})]}}),/重名/);
  assert.equal(validateProject(project([],{meta:{customFields:[customField('cf_a','text',{name:'x'.repeat(128)})]}})).meta.customFields[0].name.length,128);
});

test('custom field IDs, types, counts, and options obey the declared schema', () => {
  for(const id of ['', 'cf_', 'field_a', 'cf_a b', 'cf_中文', 'cf_'+ 'x'.repeat(65), 1, null]){
    rejects(project([],{meta:{customFields:[customField(id)]}}));
  }
  assert.equal(validateProject(project([],{meta:{customFields:[customField('cf_'+ 'x'.repeat(64))]}})).meta.customFields.length,1);
  rejects(project([],{meta:{customFields:[customField('cf_same'),customField('cf_same','number',{name:'另一个名字'})]}}),/ID 重复/);
  for(const type of ['unknown','',null,{},1])rejects(project([],{meta:{customFields:[customField('cf_a','text',{type})]}}),/字段类型/);
  rejects(project([],{meta:{customFields:null}}));rejects(project([],{meta:{customFields:{}}}));rejects(project([],{meta:{customFields:[null]}}));
  const maximum=Array.from({length:LIMITS.maxCustomFields},(_,i)=>customField('cf_'+i));
  assert.equal(validateProject(project([],{meta:{customFields:maximum}})).meta.customFields.length,50);
  rejects(project([],{meta:{customFields:[...maximum,customField('cf_extra')]}}),/数量超过限制 50/);
  for(const type of ['text','number','date','checkbox'])rejects(project([],{meta:{customFields:[customField('cf_a',type,{options:[]})]}}),/只有选择字段/);
});

test('select options require valid unique IDs and bounded nonempty labels', () => {
  rejects(project([],{meta:{customFields:[{id:'cf_a',name:'选择',type:'select'}]}}),/选项数组/);
  for(const options of [null,{},[null],[{id:'option_a',label:'选项'}],[{id:'fo_',label:'选项'}],[{id:'fo_a b',label:'选项'}],[{id:'fo_'+ 'x'.repeat(65),label:'选项'}],[{id:'fo_a',label:''}],[{id:'fo_a',label:'  '}],[{id:'fo_a',label:'x'.repeat(129)}]]){
    rejects(project([],{meta:{customFields:[customField('cf_a','select',{options})]}}));
  }
  rejects(project([],{meta:{customFields:[customField('cf_a','select',{options:[{id:'fo_same',label:'A'},{id:'fo_same',label:'B'}]})]}}),/选项 ID 重复/);
  const options=Array.from({length:LIMITS.maxFieldOptions},(_,i)=>({id:'fo_'+i,label:'选项 '+i}));
  assert.equal(validateProject(project([],{meta:{customFields:[customField('cf_a','select',{options})]}})).meta.customFields[0].options.length,100);
  rejects(project([],{meta:{customFields:[customField('cf_a','select',{options:[...options,{id:'fo_extra',label:'多一个'}]})]}}),/数量超过限制 100/);
  const accepted=validateProject(project([],{meta:{customFields:[customField('cf_a','select',{options:[{id:'fo_'+ 'x'.repeat(64),label:'x'.repeat(128)},{id:'fo_b',label:'  相同名称  '},{id:'fo_c',label:'相同名称'}]})]}}));
  assert.equal(accepted.meta.customFields[0].options[1].label,'相同名称');
  // Option IDs are scoped to their field, rather than across all fields.
  assert.equal(validateProject(project([],{meta:{customFields:[customField('cf_a','select'),customField('cf_b','select')]}})).meta.customFields.length,2);
});

test('custom values use strict types and defined field and option references', () => {
  const invalidByType={text:[0,false,{},[], 'x'.repeat(4097)],number:['0','1.5',false,{},NaN,Infinity,-Infinity],date:['','2026-2-09','2026-02-30','1900-02-29','0099-12-01',1],checkbox:[0,1,'true','false',{}],select:['完成','fo_missing',1,false,{}]};
  for(const [type,values] of Object.entries(invalidByType)){
    for(const value of values)rejects(project([task('a',{customValues:{['cf_'+type]:value}})],{meta:{customFields:[customField('cf_'+type,type)]}}));
  }
  for(const customValues of [null,[],1,'values'])rejects(project([task('a',{customValues})]));
  rejects(project([task('a',{customValues:{cf_missing:'value'}})],{meta:{customFields:[customField('cf_text')]}}),/字段不存在/);
  assert.equal(validateProject(project([task('a',{customValues:{cf_text:'x'.repeat(4096)}})],{meta:{customFields:[customField('cf_text')]}})).tasks[0].customValues.cf_text.length,4096);
  assert.equal(validateProject(project([task('a',{customValues:{cf_number:Number.MAX_VALUE}})],{meta:{customFields:[customField('cf_number','number')]}})).tasks[0].customValues.cf_number,Number.MAX_VALUE);
});

test('column layouts allow partial lists without injecting defaults and reject invalid references', () => {
  const fields=[customField('cf_notes')];
  for(const columnOrder of [[],['person'],['cf_notes','pct'],['name','end','cf_notes']]){
    const result=validateProject(project([],{meta:{customFields:fields,columnOrder}}));assert.deepEqual(result.meta.columnOrder,columnOrder);
  }
  for(const columnOrder of [null,{},[1],['unknown'],['cf_missing'],['person','person'],['person','name'],['name','name']])rejects(project([],{meta:{customFields:fields,columnOrder}}));
  for(const hiddenColumns of [[],['person','start','end','pct','grp','phase','cf_notes']]){
    assert.deepEqual(validateProject(project([],{meta:{customFields:fields,hiddenColumns}})).meta.hiddenColumns,hiddenColumns);
  }
  for(const hiddenColumns of [null,{},['name'],['grp','grp'],['cf_missing'],[false]])rejects(project([],{meta:{customFields:fields,hiddenColumns}}));
});

test('custom schema validation is atomic on failure and keeps plain text inert', () => {
  const input=project([task('a',{customValues:{cf_text:'<script>alert(1)</script>',cf_select:'fo_missing'}})],{meta:{customFields:[customField('cf_text','text',{name:'<b>文本</b>'}),customField('cf_select','select')]}});
  const before=JSON.stringify(input);rejects(input,/选项不存在/);assert.equal(JSON.stringify(input),before);
  delete input.tasks[0].customValues.cf_select;
  const result=validateProject(input);assert.equal(result.tasks[0].customValues.cf_text,'<script>alert(1)</script>');assert.equal(result.meta.customFields[0].name,'<b>文本</b>');
  for(const key of ['__proto__','constructor','prototype']){
    rejects(JSON.parse('{"tasks":[{"id":"a","s":"2026-10-09","e":"2026-10-10","customValues":{"'+key+'":null}}]}'),/不安全的字段名/);
  }
});

test('custom fields remain bounded by total project size and work through storage wrappers', () => {
  const tooLarge=project(Array.from({length:2700},(_,i)=>task('t'+i,{customValues:{cf_text:'x'.repeat(4096)}})),{meta:{customFields:[customField('cf_text')]}});
  rejects(tooLarge,/超过 10 MiB/);
  const small=project([task('a',{customValues:{cf_checkbox:true}})],{meta:{customFields:[customField('cf_checkbox','checkbox')]}});
  const wrapped={format:'schedule-gantt-storage',version:1,revision:1,savedAt:'2026-10-09T00:00:00.000Z',project:small};
  const result=validateProject(wrapped);assert.deepEqual(result.tasks[0].customValues,{cf_checkbox:true});assert.deepEqual(validateProject(result),result);
});

test('browser validation exposes the same custom field behavior without Node dependencies', () => {
  const context=vm.createContext({});vm.runInContext(fs.readFileSync(path.join(__dirname,'..','project-validation.js'),'utf8'),context);
  const custom=project([task('a',{customValues:{cf_checkbox:false}})],{meta:{customFields:[customField('cf_checkbox','checkbox')]}});
  assert.equal(vm.runInContext('ScheduleProjectValidation.validateProject('+JSON.stringify(custom)+').tasks[0].customValues.cf_checkbox',context),false);
  assert.equal(vm.runInContext('ScheduleProjectValidation.LIMITS.maxCustomFields',context),50);
});
