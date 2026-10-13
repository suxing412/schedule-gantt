'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
let source = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
if (process.env.SCHEDULE_CUSTOM_FIELDS_UI_PATCH === '1') {
  for (const {find, replace} of JSON.parse(fs.readFileSync(path.join(root, '.repair-work', 'custom-fields-ui.json'), 'utf8'))) {
    assert.equal(source.split(find).length, 2, `Patch no longer matches: ${find.slice(0, 100)}`);
    source = source.replace(find, replace);
  }
}
source = source.replace(/\r\n/g, '\n');
function section(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `Missing code section: ${from}`);
  return source.slice(start, end);
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function key(key, target, extra = {}) {
  return {key, target, ctrlKey: false, metaKey: false, shiftKey: false, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra};
}

function fixture(customFields = []) {
  const document = {activeElement: null, listeners: new Map()};
  const timers = new Map(); let nextId = 1;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.dataset = {}; this.style = {}; this.children = []; this.attributes = {};
      this.parentNode = null; this.hidden = false; this.disabled = false; this.checked = false; this.value = '';
      this.type = ''; this.validity = {badInput: false}; this.listeners = new Map(); this.classes = new Set();
      this.classList = {add: (...items) => items.forEach(item => this.classes.add(item)),
        remove: (...items) => items.forEach(item => this.classes.delete(item)), contains: item => this.classes.has(item)};
    }
    set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
    set innerHTML(value) { this.children.forEach(child => child.parentNode = null); this.children = []; this.html = value; }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text || this.children.map(child => child.textContent).join(''); }
    get isConnected() { return true; }
    get offsetParent() { for (let el = this; el; el = el.parentNode) if (el.hidden) return null; return {}; }
    get previousElementSibling() { const siblings = this.parentNode?.children || []; return siblings[siblings.indexOf(this) - 1] || null; }
    get nextElementSibling() { const siblings = this.parentNode?.children || []; return siblings[siblings.indexOf(this) + 1] || null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    appendChild(child) { child.remove(); child.parentNode = this; this.children.push(child); return child; }
    insertBefore(child, before) { child.remove(); child.parentNode = this; const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, child); }
    remove() { if (this.parentNode) { const siblings = this.parentNode.children; siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; } }
    focus() { document.activeElement = this; }
    select() {}
    contains(child) { return child === this || this.children.some(item => item.contains(child)); }
    matches(selector) {
      if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
      const data = selector.match(/^\[data-([\w-]+)\]$/);
      if (data) return Object.prototype.hasOwnProperty.call(this.dataset, data[1].replace(/-([a-z])/g, (_, char) => char.toUpperCase()));
      return this.tagName.toLowerCase() === selector.toLowerCase();
    }
    querySelectorAll(selector) {
      const selectors = selector.split(',').map(item => item.trim()), result = [];
      const visit = parent => { for (const child of parent.children) { if (selectors.some(item => child.matches(item))) result.push(child); visit(child); } };
      visit(this); return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
    dispatch(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener(event); }
  }
  const ids = ['btn-fields','header-add-field','fields-reset-widths','fields-ovl','fields-close','fields-done','fields-list','fields-editor','fields-edit-name','fields-edit-type',
    'fields-edit-options','fields-edit-options-list','fields-edit-option-add','fields-edit-save','fields-edit-cancel',
    'fields-add-name','fields-add-type','fields-add-options','fields-add-options-label','fields-add',
    'ovl','flag-ovl','set-ovl','help-ovl','g-left-body','btn-add-task','tb-search','f-custom-block','f-custom-fields',
    'f-name','f-type','f-assignee','f-group','f-phase','f-flow','f-start','f-end','f-progress','f-lane'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element(id.includes('name') || id.startsWith('f-') ? 'input' : 'div')]));
  for (const id of ['ovl','flag-ovl','set-ovl','help-ovl','fields-ovl']) elements[id].hidden = true;
  for (const id of ['fields-close','fields-done','fields-edit-option-add','fields-edit-save','fields-edit-cancel','fields-add','btn-fields','header-add-field','fields-reset-widths']) elements[id].tagName = 'BUTTON';
  elements['fields-add-options'].tagName = 'TEXTAREA'; elements['fields-add-type'].tagName = 'SELECT';
  elements['fields-editor'].hidden = true; elements['fields-add-type'].value = 'text';
  elements['fields-add-name'].type = 'text'; elements['fields-edit-name'].type = 'text';
  for (const id of ['fields-close','fields-reset-widths','fields-list','fields-editor','fields-add-name','fields-add-type','fields-add-options-label','fields-add','fields-done']) elements['fields-ovl'].appendChild(elements[id]);
  const presetButtons=Object.fromEntries([...source.matchAll(/data-field-preset="([^"]+)"/g)].map(match=>{
    const button=new Element('button');button.dataset.fieldPreset=match[1];
    elements['fields-ovl'].insertBefore(button,elements['fields-list']);
    return [match[1],button];
  }));
  for (const id of ['fields-edit-name','fields-edit-type','fields-edit-options','fields-edit-cancel','fields-edit-save']) elements['fields-editor'].appendChild(elements[id]);
  for (const id of ['fields-edit-options-list','fields-edit-option-add']) elements['fields-edit-options'].appendChild(elements[id]);
  elements['fields-add-options-label'].appendChild(elements['fields-add-options']);
  elements['f-custom-block'].appendChild(elements['f-custom-fields']);
  document.activeElement = elements['btn-fields'];
  document.querySelector = selector => elements[selector.slice(1)] || null;
  document.querySelectorAll = selector => {
    const found=new Set();
    for(const element of Object.values(elements)){
      if(element.matches(selector))found.add(element);
      for(const child of element.querySelectorAll(selector))found.add(child);
    }
    return [...found];
  };
  document.createElement = type => new Element(type);
  document.addEventListener = (type, listener) => { if (!document.listeners.has(type)) document.listeners.set(type, []); document.listeners.get(type).push(listener); };
  document.dispatch = (type, event) => { for (const listener of document.listeners.get(type) || []) listener(event); };
  const calls = {render: 0, save: 0, manager: 0, close: 0, delete: 0, nudge: 0, edit: 0, undo: 0, redo: 0, resetWidths: 0, toast: []};
  const ctx = {
    document, Date, Number, Object, Set, Map, Array, JSON,
    $: selector => document.querySelector(selector),
    ce(type, className, text) { const el = new Element(type); if (className) el.className = className; if (text != null) el.textContent = text; return el; },
    proj: {tasks: [{id:'a',name:'Original',pid:null,type:'task',s:'2026-10-01',e:'2026-10-05',pct:10,who:'A',grp:'策划',phase:'原型',deps:[]}], groups:[], flags:[], meta:{customFields:clone(customFields),cols:{}}},
    selId:'a',selIds:new Set(['a']),dragging:false,eId:'a',editDeps:[],filterQ:'',filterGrp:null,filterPhase:null,
    uid: () => 't'+nextId++,
    render() { calls.render++; }, schSave() { calls.save++; }, toast(message) { calls.toast.push(message); },
    resetColumnWidths() { calls.resetWidths++; },
    validateDependencies: () => '', isSum: task => ctx.proj.tasks.some(item => item.pid === task.id),
    edClose() { calls.close++; }, tD: value => Date.parse(value), fmtS: value => String(value), eRange: () => ({s:1,e:2}), sumPct: () => 10,
    undo() { calls.undo++; }, redo() { calls.redo++; }, delSel() { calls.delete++; }, nudgeSel() { calls.nudge++; }, edOpen() { calls.edit++; },
    sel() {}, selStep() {},
    edCloseGlobal() { calls.close++; }, flagClose() {}, setClose() {}, helpClose() {},
    setTimeout(callback) { const id = nextId++; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
  };
  ctx.byId = id => ctx.proj.tasks.find(task => task.id === id);
  vm.createContext(ctx);
  vm.runInContext(section('function anyOvlOpen(){', '// 重要节点统一图标'), ctx);
  vm.runInContext(section('function allTableColumns(){', 'function syncLeftColumns(){'), ctx);
  vm.runInContext(section('/* 自定义字段：', '/* 设置页面：职能管理'), ctx);
  function run(code) { vm.runInContext(code, ctx); }
  function flush() { for (const [id, callback] of [...timers]) if (timers.delete(id)) callback(); }
  function taskInputs() { ctx.renderCustomTaskFields(ctx.proj.tasks[0]); return Object.fromEntries(elements['f-custom-fields'].querySelectorAll('input,select,textarea').map(input => [input.dataset.customFieldId, input])); }
  function editor() { run(section('function edSave(){', '/* 里程碑旗：')); }
  function globalKeys() {
    const start=source.indexOf("  document.addEventListener('keydown',e=>{",source.indexOf('function bindUI'));
    run(source.slice(start,source.indexOf('  // 弹窗焦点圈闭',start)));
  }
  elements['f-name'].value='Changed';elements['f-type'].value='task';elements['f-assignee'].value='B';elements['f-group'].value='程序';elements['f-phase'].value='开发';
  elements['f-start'].value='2026-11-01';elements['f-end'].value='2026-11-03';elements['f-progress'].value='50';elements['f-lane'].value='0';
  return {ctx, elements, presetButtons, document, calls, run, flush, taskInputs, editor, globalKeys, Element};
}

const selectField={id:'cf_priority',name:'优先级',type:'select',options:[{id:'fo_high',label:'高'},{id:'fo_low',label:'低'}]};

test('preset button clicks reveal an existing priority field without changing its IDs, options or task selection',()=>{
  const f=fixture([selectField]);f.ctx.proj.tasks[0].customValues={cf_priority:'fo_high'};
  f.ctx.proj.meta.hiddenColumns=['grp','phase','cf_priority'];f.ctx.bindFieldsUI();
  assert.ok(f.presetButtons.priority,'priority button must exist in actual HTML');
  f.presetButtons.priority.dispatch('click');f.presetButtons.priority.dispatch('click');
  assert.equal(f.ctx.proj.meta.customFields.length,1);
  assert.deepEqual(clone(f.ctx.proj.meta.customFields[0]),selectField);
  assert.equal(f.ctx.proj.tasks[0].customValues.cf_priority,'fo_high');
  assert.ok(f.ctx.visibleTableColumns().some(column=>column.id==='cf_priority'));
  assert.equal(f.calls.save,1,'only the first visibility change should save');
});

test('Owner and role preset buttons reuse native person and grp columns and preserve their task values',()=>{
  const f=fixture();f.ctx.proj.meta.hiddenColumns=['person','grp','phase'];
  f.ctx.proj.tasks[0].who='刘 A';f.ctx.proj.tasks[0].grp='策划';f.ctx.bindFieldsUI();
  f.presetButtons.owner.dispatch('click');f.presetButtons.role.dispatch('click');
  f.presetButtons.owner.dispatch('click');f.presetButtons.role.dispatch('click');
  assert.equal(f.ctx.proj.meta.customFields.length,0);
  const native=f.ctx.visibleTableColumns().filter(column=>column.id==='person'||column.id==='grp');
  assert.equal(native.length,2);assert.ok(native.every(column=>column.builtin));
  assert.equal(f.ctx.proj.tasks[0].who,'刘 A');assert.equal(f.ctx.proj.tasks[0].grp,'策划');
  assert.equal(f.calls.save,2,'repeated clicks should not create fields or repeat no-op saves');
});

test('hours and duration presets create numeric columns with units and reuse a legacy hours alias without losing values',()=>{
  const f=fixture();f.ctx.bindFieldsUI();
  f.presetButtons.hours.dispatch('click');f.presetButtons.duration.dispatch('click');
  const [hours,duration]=f.ctx.proj.meta.customFields;
  assert.deepEqual([hours.name,hours.type,duration.name,duration.type],['预计工时（小时）','number','预计工期（天）','number']);
  assert.equal(hours.options,undefined);assert.equal(duration.options,undefined);
  f.ctx.proj.tasks[0].customValues={[hours.id]:1.25,[duration.id]:0.5};hours.name='预计工时';
  f.presetButtons.hours.dispatch('click');f.presetButtons.duration.dispatch('click');
  assert.equal(f.ctx.proj.meta.customFields.length,2);
  assert.equal(f.ctx.proj.meta.customFields[0].id,hours.id);
  const inputs=f.taskInputs();assert.equal(inputs[hours.id].type,'number');assert.equal(inputs[hours.id].step,'any');
  assert.deepEqual(clone(f.ctx.parseCustomTaskValues().values),{[hours.id]:1.25,[duration.id]:0.5});
  assert.equal(f.calls.save,2);
});

test('new custom columns append to the right, are visible, and commit once', () => {
  const f=fixture();const result=f.ctx.fieldsAddDefinition(' 工时 ','number',[]);
  assert.equal(result.field.name,'工时');assert.equal(result.field.type,'number');assert.match(result.field.id,/^cf_/);
  assert.equal(f.ctx.allTableColumns().at(-1).id,result.field.id);
  assert.equal(f.ctx.visibleTableColumns().at(-1).id,result.field.id);
  assert.deepEqual(clone(f.ctx.proj.meta.hiddenColumns),['grp','phase']);
  assert.deepEqual([f.calls.render,f.calls.save],[1,1]);
});

test('newly added columns scroll the left table to the right edge and synchronize its header', () => {
  const f=fixture();let syncs=0;
  f.elements['g-left-body'].scrollWidth=1750;f.elements['g-left-body'].clientWidth=440;
  f.ctx.syncLeftColumns=()=>syncs++;
  f.ctx.fieldsAddDefinition('新列','text',[]);
  assert.equal(f.elements['g-left-body'].scrollLeft,1310);assert.equal(syncs,1);
});

test('the 50-field boundary is accepted and a 51st field is rejected atomically', () => {
  const defs=Array.from({length:49},(_,i)=>({id:'cf_'+i,name:'字段'+i,type:'text'}));
  const f=fixture(defs);assert.ok(f.ctx.fieldsAddDefinition('第50个','text',[]).field);
  const before=clone(f.ctx.proj);
  assert.match(f.ctx.fieldsAddDefinition('第51个','text',[]).error,/50/);
  assert.deepEqual(clone(f.ctx.proj),before);assert.equal(f.calls.save,1);
});

test('the 100-option boundary is accepted and a 101st option cannot create or edit a field', () => {
  const labels=Array.from({length:100},(_,i)=>'选项'+i),f=fixture();
  const result=f.ctx.fieldsAddDefinition('选择','select',labels);assert.equal(result.field.options.length,100);
  const before=clone(f.ctx.proj);
  assert.match(f.ctx.fieldsAddDefinition('超出','select',[...labels,'第101项']).error,/100/);
  assert.match(f.ctx.fieldsApplyEdit(result.field.id,'不可改名',[...clone(result.field.options),{id:'fo_extra',label:'第101项'}]).error,/100/);
  assert.deepEqual(clone(f.ctx.proj),before);assert.equal(f.calls.save,1);
});

test('reserved, duplicate, blank and oversized names fail without metadata or task mutation', () => {
  const f=fixture([{id:'cf_hours',name:'Hours',type:'number'}]),before=clone(f.ctx.proj);
  for(const name of ['名称','负责人','开始','结束','进度','职能','阶段','hours',' ','x'.repeat(129)])assert.ok(f.ctx.fieldsAddDefinition(name,'text',[]).error);
  assert.deepEqual(clone(f.ctx.proj),before);assert.equal(f.calls.save,0);
});

test('select creation rejects duplicate or absent labels and allocates stable option IDs', () => {
  const f=fixture();
  assert.ok(f.ctx.fieldsAddDefinition('状态','select',[]).error);
  assert.ok(f.ctx.fieldsAddDefinition('状态','select',[' Ready ','ready']).error);
  assert.equal(f.ctx.proj.meta.customFields.length,0);
  const result=f.ctx.fieldsAddDefinition('状态','select',[' 未开始 ','进行中']);
  assert.deepEqual(clone(result.field.options).map(option=>option.label),['未开始','进行中']);
  assert.equal(new Set(result.field.options.map(option=>option.id)).size,2);
  assert.ok(result.field.options.every(option=>option.id.startsWith('fo_')));
});

test('name stays first and visible; built-in columns can be shown and reordered', () => {
  const f=fixture();
  assert.equal(f.ctx.fieldsSetVisible('name',false),false);assert.equal(f.ctx.fieldsMove('name',1),false);assert.equal(f.ctx.fieldsMove('person',-1),false);
  assert.equal(f.ctx.fieldsSetVisible('grp',true),true);
  assert.equal(f.ctx.visibleTableColumns().some(column=>column.id==='grp'),true);
  assert.equal(f.ctx.fieldsMove('phase',-1),true);
  assert.deepEqual(clone(f.ctx.allTableColumns().map(column=>column.id)),['name','person','start','end','pct','phase','grp']);
  assert.equal(f.calls.save,2);
});

test('renaming and reordering select options preserve existing task selections by option ID', () => {
  const f=fixture([selectField]);f.ctx.proj.tasks[0].customValues={cf_priority:'fo_high'};
  const result=f.ctx.fieldsApplyEdit('cf_priority','重要程度',[{id:'fo_low',label:'普通'},{id:'fo_high',label:'紧急'}]);
  assert.equal(result.changed,true);assert.equal(f.ctx.proj.tasks[0].customValues.cf_priority,'fo_high');
  assert.deepEqual(clone(f.ctx.proj.meta.customFields[0].options),[{id:'fo_low',label:'普通'},{id:'fo_high',label:'紧急'}]);
  assert.equal(f.ctx.taskCellText(f.ctx.proj.tasks[0],f.ctx.allTableColumns().at(-1)),'紧急');
});

test('invalid option edits are atomic; removing an option clears only its affected values', () => {
  const f=fixture([selectField]);f.ctx.proj.tasks[0].customValues={cf_priority:'fo_high'};
  f.ctx.proj.tasks.push({...clone(f.ctx.proj.tasks[0]),id:'b',customValues:{cf_priority:'fo_low'}});
  const before=clone(f.ctx.proj);
  assert.ok(f.ctx.fieldsApplyEdit('cf_priority','改名',[]).error);
  assert.deepEqual(clone(f.ctx.proj),before);
  f.ctx.fieldsApplyEdit('cf_priority','优先级',[{id:'fo_low',label:'低'}]);
  assert.equal(Object.hasOwn(f.ctx.proj.tasks[0].customValues,'cf_priority'),false);
  assert.equal(f.ctx.proj.tasks[1].customValues.cf_priority,'fo_low');
  assert.equal(f.calls.save,1);
});

test('saving unchanged field edits avoids extra undo snapshots and trimmed duplicate option names are rejected', () => {
  const f=fixture([selectField]);
  assert.equal(f.ctx.fieldsApplyEdit('cf_priority','优先级',clone(selectField.options)).changed,false);
  assert.equal(f.calls.save,0);
  const before=clone(f.ctx.proj);
  assert.ok(f.ctx.fieldsApplyEdit('cf_priority','改名',[{id:'fo_high',label:'相同'},{id:'fo_low',label:' 相同 '}]).error);
  assert.deepEqual(clone(f.ctx.proj),before);assert.equal(f.calls.save,0);
});

test('deleting a custom field clears task values, widths, hidden flags and order in one undoable commit', () => {
  const f=fixture([selectField,{id:'cf_note',name:'备注',type:'text'}]);
  f.ctx.proj.tasks[0].customValues={cf_priority:'fo_high',cf_note:'keep'};
  f.ctx.proj.meta.cols={cf_priority:220,person:90};f.ctx.proj.meta.hiddenColumns=['grp','cf_priority'];f.ctx.proj.meta.columnOrder=['name','cf_priority','person','cf_note'];
  assert.equal(f.ctx.fieldsDelete('cf_priority'),true);
  assert.equal(f.ctx.proj.meta.customFields.some(field=>field.id==='cf_priority'),false);
  assert.equal(Object.hasOwn(f.ctx.proj.meta.cols,'cf_priority'),false);assert.equal(f.ctx.proj.meta.cols.person,90);
  assert.equal(f.ctx.proj.meta.columnOrder.includes('cf_priority'),false);assert.equal(f.ctx.proj.meta.hiddenColumns.includes('cf_priority'),false);
  assert.deepEqual(clone(f.ctx.proj.tasks[0].customValues),{cf_note:'keep'});
  assert.deepEqual([f.calls.render,f.calls.save],[1,1]);assert.match(f.calls.toast.at(-1),/Ctrl\+Z/);
});

test('editing option rows keeps IDs while moving or adding entries and never changes field type', () => {
  const f=fixture([selectField]);f.ctx.fieldsEdit('cf_priority');
  const list=f.elements['fields-edit-options-list'];
  assert.deepEqual(list.children.map(row=>row.dataset.optionId),['fo_high','fo_low']);
  list.children[1].children[1].dispatch('click');
  assert.deepEqual(list.children.map(row=>row.dataset.optionId),['fo_low','fo_high']);
  list.children[1].querySelector('.fields-option-label').value='紧急';
  f.ctx.fieldsSaveEdit();
  assert.equal(f.ctx.proj.meta.customFields[0].type,'select');
  assert.deepEqual(clone(f.ctx.proj.meta.customFields[0].options),[{id:'fo_low',label:'低'},{id:'fo_high',label:'紧急'}]);
});

test('task controls preserve zero, fractional numbers, false and option IDs without affecting schedule dates', () => {
  const defs=[{id:'cf_zero',name:'工时',type:'number'},{id:'cf_ratio',name:'比例',type:'number'},{id:'cf_done',name:'审核',type:'checkbox'},{id:'cf_day',name:'评审日',type:'date'},selectField];
  const f=fixture(defs);const task=f.ctx.proj.tasks[0];task.customValues={cf_zero:0,cf_ratio:1.25,cf_done:false,cf_day:'2028-02-29',cf_priority:'fo_high'};
  const inputs=f.taskInputs();assert.equal(inputs.cf_zero.value,'0');assert.equal(inputs.cf_ratio.value,'1.25');assert.equal(inputs.cf_done.checked,false);
  assert.deepEqual(clone(f.ctx.parseCustomTaskValues().values),task.customValues);
  assert.equal(task.s,'2026-10-01');assert.equal(task.e,'2026-10-05');
});

test('blank fields omit keys, text remains literal and whitespace is retained', () => {
  const f=fixture([{id:'cf_note',name:'<img onerror=alert(1)>',type:'text'},selectField,{id:'cf_day',name:'日期记录',type:'date'}]);
  const inputs=f.taskInputs();inputs.cf_note.value='  <script>literal</script>  ';
  const result=f.ctx.parseCustomTaskValues();
  assert.deepEqual(clone(result.values),{cf_note:'  <script>literal</script>  '});
  assert.equal(f.elements['f-custom-fields'].children[0].children[0].textContent,'<img onerror=alert(1)>');
});

test('imported multi-line text remains intact when another task field is edited', () => {
  const f=fixture([{id:'cf_note',name:'备注',type:'text'}]),note='第一行\n\n第二行 <literal>\n最后一行';
  f.ctx.proj.tasks[0].customValues={cf_note:note};
  const inputs=f.taskInputs();assert.equal(inputs.cf_note.tagName,'TEXTAREA');assert.equal(inputs.cf_note.rows,2);
  assert.equal(inputs.cf_note.value,note);f.editor();f.ctx.edSave();
  assert.equal(f.ctx.proj.tasks[0].name,'Changed');assert.equal(f.ctx.proj.tasks[0].customValues.cf_note,note);
  assert.equal(f.calls.save,1);
});

test('text inputs cap normal entry at 4096 and oversized injected values block the whole task save', () => {
  const f=fixture([{id:'cf_note',name:'备注',type:'text'}]),inputs=f.taskInputs();
  assert.equal(inputs.cf_note.maxLength,4096);
  inputs.cf_note.value='x'.repeat(4097);f.editor();const before=clone(f.ctx.proj.tasks[0]);
  f.ctx.edSave();assert.deepEqual(clone(f.ctx.proj.tasks[0]),before);assert.equal(f.calls.save,0);assert.equal(f.calls.close,0);
  assert.match(f.calls.toast.at(-1),/4096/);
  inputs.cf_note.value='x'.repeat(4096);f.ctx.edSave();
  assert.equal(f.ctx.proj.tasks[0].customValues.cf_note.length,4096);assert.equal(f.calls.save,1);
});

for(const [definition,value] of [
  [{id:'cf_num',name:'数字',type:'number'},'Infinity'],
  [{id:'cf_day',name:'日期',type:'date'},'2026-02-29'],
  [{id:'cf_day',name:'日期',type:'date'},'2026-13-01'],
  [{id:'cf_day',name:'日期',type:'date'},'0099-01-01'],
  [selectField,'fo_removed'],
]){
  test(`invalid ${definition.type} value ${value} blocks all built-in and custom task changes`,()=>{
    const f=fixture([definition]),inputs=f.taskInputs();inputs[definition.id].value=value;
    f.editor();const before=clone(f.ctx.proj.tasks[0]);f.ctx.edSave();
    assert.deepEqual(clone(f.ctx.proj.tasks[0]),before);
    assert.equal(f.calls.save,0);assert.equal(f.calls.close,0);
    assert.equal(f.document.activeElement,inputs[definition.id]);assert.ok(f.calls.toast.length);
  });
}

for(const date of ['0100-01-01','9999-12-31']){
  test(`custom date boundary ${date} saves and its control exposes the same supported range`,()=>{
    const f=fixture([{id:'cf_day',name:'评审日期',type:'date'}]),inputs=f.taskInputs();
    assert.equal(inputs.cf_day.type,'date');
    assert.equal(inputs.cf_day.min,'0100-01-01');assert.equal(inputs.cf_day.max,'9999-12-31');
    inputs.cf_day.value=date;f.editor();f.ctx.edSave();
    assert.equal(f.ctx.proj.tasks[0].customValues.cf_day,date);
    assert.equal(f.calls.save,1);assert.equal(f.calls.close,1);
  });
}

test('partially entered numeric values reported by the browser do not silently clear existing data', () => {
  const f=fixture([{id:'cf_num',name:'工时',type:'number'}]);f.ctx.proj.tasks[0].customValues={cf_num:8};
  const inputs=f.taskInputs();inputs.cf_num.value='';inputs.cf_num.validity.badInput=true;
  assert.ok(f.ctx.parseCustomTaskValues().error);
  assert.equal(f.ctx.proj.tasks[0].customValues.cf_num,8);
});

for(const type of ['task','milestone','pipeline']){
  test(`custom task values save on ${type} tasks`,()=>{
    const f=fixture([{id:'cf_num',name:'工时',type:'number'}]);f.ctx.proj.tasks[0].type=type;f.elements['f-type'].value=type;
    const inputs=f.taskInputs();inputs.cf_num.value='0.5';f.editor();f.ctx.edSave();
    assert.equal(f.ctx.proj.tasks[0].customValues.cf_num,0.5);assert.equal(f.calls.save,1);
  });
}

test('fields modal blocks background shortcuts, supports project undo on buttons and retains native text undo', () => {
  const f=fixture();f.ctx.bindFieldsUI();f.globalKeys();f.ctx.fieldsOpen();
  const modal=f.elements['fields-ovl'],button=f.elements['fields-done'];
  for(const name of ['Delete','ArrowLeft','Enter'])f.document.dispatch('keydown',key(name,button));
  assert.deepEqual([f.calls.delete,f.calls.nudge,f.calls.edit],[0,0,0]);
  const undo=key('z',button,{ctrlKey:true});modal.dispatch('keydown',undo);assert.equal(f.calls.undo,1);assert.equal(undo.prevented,true);
  const redo=key('z',button,{metaKey:true,shiftKey:true});modal.dispatch('keydown',redo);assert.equal(f.calls.redo,1);
  const textUndo=key('z',f.elements['fields-add-name'],{ctrlKey:true});modal.dispatch('keydown',textUndo);assert.equal(f.calls.undo,1);assert.equal(textUndo.prevented,false);
  f.document.dispatch('keydown',key('Escape',button));f.flush();assert.equal(modal.hidden,true);assert.equal(f.document.activeElement,f.elements['btn-fields']);
});

test('fields modal participates in the shared focus trap in both directions', () => {
  const f=fixture();f.ctx.fieldsOpen();f.flush();
  f.run(section('  // 弹窗焦点圈闭','  // 设置页面'));
  const modal=f.elements['fields-ovl'],first=f.elements['fields-close'],last=f.elements['fields-done'];
  first.focus();const backwards=key('Tab',first,{shiftKey:true});modal.dispatch('keydown',backwards);
  assert.equal(f.document.activeElement,last);assert.equal(backwards.prevented,true);
  const forwards=key('Tab',last);modal.dispatch('keydown',forwards);
  assert.equal(f.document.activeElement,first);assert.equal(forwards.prevented,true);
});

test('field name Enter during IME composition never creates or updates metadata', () => {
  const f=fixture();f.ctx.bindFieldsUI();f.elements['fields-add-name'].value='工时';
  for(const extra of [{isComposing:true},{keyCode:229}])f.elements['fields-add-name'].dispatch('keydown',key('Enter',f.elements['fields-add-name'],extra));
  assert.equal(f.ctx.proj.meta.customFields.length,0);assert.equal(f.calls.save,0);
  f.elements['fields-add-name'].dispatch('keydown',key('Enter',f.elements['fields-add-name']));
  assert.equal(f.ctx.proj.meta.customFields.length,1);assert.equal(f.calls.save,1);
});
