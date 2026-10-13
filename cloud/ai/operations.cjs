'use strict';

const { validateProject, LIMITS } = require('../../project-validation.js');
const operationDefinitions = require('./operation-definitions.cjs');
const definitions = new Map(operationDefinitions.map(def => [def.name, def]));
const PERSONAL = ['cols', 'lw', 'leftWidth', 'paneAuto', 'layoutVersion', 'nameAutoWidth', 'columnOrder', 'hiddenColumns', 'defView'];
const DEFAULT_ROLES = ['策划', '美术', '程序', '技术策划', '技术美术', '动画'];
const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_OPERATIONS = 100;

class OperationError extends Error {
  constructor(code, message, operationIndex) {
    super(message); this.name = 'OperationError'; this.code = code;
    if (operationIndex !== undefined) this.operationIndex = operationIndex;
  }
}
const fail = (code, message) => { throw new OperationError(code, message); };
const invalid = message => fail('VALIDATION_ERROR', message);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Do not stringify caller input before rejecting accessors, prototypes and cycles.
function cloneJson(input, maxDepth = LIMITS.maxDepth + 4) {
  const parents = new Set(); let nodes = 0;
  function visit(value, depth) {
    if (++nodes > LIMITS.maxNodes + 5000 || depth > maxDepth) invalid('JSON 结构过大或嵌套过深');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { if (value.length > LIMITS.maxBytes) invalid('JSON 文本过大'); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object') invalid('只能包含有限数值和普通 JSON 数据');
    if (parents.has(value)) invalid('JSON 不能包含循环引用');
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalid('不支持的对象原型');
    if (array && value.length > LIMITS.maxNodes) invalid('数组过大');
    const descriptors = Object.getOwnPropertyDescriptors(value), copy = array ? [] : {};
    parents.add(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || DANGEROUS.has(key) || key.length > 256) invalid('不安全或过长的属性名');
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !own(descriptor, 'value')) invalid('属性必须是普通 JSON 值');
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) invalid('数组不能包含额外属性');
      copy[key] = visit(descriptor.value, depth + 1);
    }
    if (array && (copy.length !== value.length || Array.from({ length: value.length }, (_, i) => i).some(i => !own(copy, i)))) invalid('数组不能包含空洞');
    parents.delete(value); return copy;
  }
  const result = visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.maxBytes + 65536) invalid('JSON 超过大小限制');
  return result;
}

// Small JSON Schema subset used by our own catalog, not an arbitrary schema executor.
function validateSchema(value, schema, path = 'arguments') {
  if (schema.anyOf) {
    if (!schema.anyOf.some(candidate => { try { validateSchema(value, candidate, path); return true; } catch (error) { if (error instanceof OperationError) return false; throw error; } })) invalid(path + ' 类型无效');
    return;
  }
  if (own(schema, 'const') && value !== schema.const) invalid(path + ' 值必须为 ' + JSON.stringify(schema.const));
  if (schema.enum && !schema.enum.includes(value)) invalid(path + ' 值不在允许范围');
  const types = { object: isObject, array: Array.isArray, string: x => typeof x === 'string', number: x => typeof x === 'number' && Number.isFinite(x), integer: Number.isSafeInteger, boolean: x => typeof x === 'boolean', null: x => x === null };
  if (schema.type && !types[schema.type](value)) invalid(path + ' 必须为 ' + schema.type);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength) invalid(path + ' 文本长度无效');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) invalid(path + ' 格式无效');
  }
  if (typeof value === 'number' && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) invalid(path + ' 数值超出范围');
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) invalid(path + ' 条目数量无效');
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) invalid(path + ' 条目不能重复');
    if (schema.items) value.forEach((item, i) => validateSchema(item, schema.items, path + '[' + i + ']'));
  }
  if (isObject(value)) {
    const keys = Object.keys(value), properties = schema.properties || {};
    if (schema.minProperties !== undefined && keys.length < schema.minProperties || schema.maxProperties !== undefined && keys.length > schema.maxProperties) invalid(path + ' 属性数量无效');
    for (const key of schema.required || []) if (!own(value, key)) invalid(path + '.' + key + ' 为必填项');
    for (const key of keys) {
      if (schema.propertyNames) validateSchema(key, schema.propertyNames, path + ' 属性名');
      if (own(properties, key)) validateSchema(value[key], properties[key], path + '.' + key);
      else if (schema.additionalProperties === false) invalid(path + '.' + key + ' 为未知属性');
      else if (isObject(schema.additionalProperties)) validateSchema(value[key], schema.additionalProperties, path + '.' + key);
    }
  }
}

function stripPersonal(project) {
  if (isObject(project.meta)) for (const key of PERSONAL) delete project.meta[key];
  if (Array.isArray(project.tasks)) for (const task of project.tasks) if (isObject(task)) { delete task.fold; delete task.collapsed; }
  return project;
}
function withTaskDefaults(task) {
  const result = { type: 'task', pid: null, pct: 0, flow: false, lane: 0, deps: [], who: '', grp: '', phase: '', ...task };
  if (result.type === 'milestone' && !own(result, 'e')) result.e = result.s;
  return result;
}
function prepareProject(input) {
  const project = cloneJson(input);
  if (!isObject(project) || !Array.isArray(project.tasks)) invalid('排期必须为包含 tasks 的项目对象');
  if (project.format === 'schedule-gantt-storage') invalid('请先解包本地存储包装，只传 project 项目对象');
  if (!own(project, 'groups')) project.groups = [];
  if (!own(project, 'flags')) project.flags = [];
  if (!own(project, 'meta')) project.meta = {};
  if (!Array.isArray(project.groups) || !Array.isArray(project.flags) || !isObject(project.meta)) invalid('groups、flags 必须为数组，meta 必须为对象');
  project.tasks = project.tasks.map(task => isObject(task) ? withTaskDefaults(task) : task);
  if (Array.isArray(project.groups)) project.groups = project.groups.map(group => isObject(group) ? { color: '#2f6fe8', ...group } : group);
  if (Array.isArray(project.flags)) project.flags = project.flags.map(flag => isObject(flag) ? { color: '#e03e3e', ...flag } : flag);
  return stripPersonal(project);
}
function validateShared(project) {
  try {
    // validateProject intentionally accepts legacy imports by filling names and
    // deduplicating dependencies. Shared SQL storage validates the representation
    // itself, so reject those lossy cases before using the legacy validator.
    for (const task of project.tasks) {
      if (!isObject(task) || typeof task.name !== 'string') invalid('每个任务必须包含文本 name');
      if (Array.isArray(task.deps) && new Set(task.deps).size !== task.deps.length) invalid('任务依赖 ID 不能重复');
    }
    for (const flag of project.flags) if (!isObject(flag) || typeof flag.name !== 'string') invalid('每个里程碑必须包含文本 name');
    validateProject(project);
    if (own(project.meta, 'title') && (typeof project.meta.title !== 'string' || project.meta.title.length > 2048)) invalid('排期标题必须为不超过 2048 个字符的文本');
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError('VALIDATION_ERROR', error.message);
  }
  return project;
}
function normalizeProject(input) { return validateShared(prepareProject(input)); }
function getTask(project, id) {
  const item = project.tasks.find(task => task.id === id);
  if (!item) fail('ITEM_NOT_FOUND', '任务不存在：' + id);
  return item;
}
function getItem(items, id, label, key = 'id') {
  const item = items.find(value => value[key] === id);
  if (!item) fail('ITEM_NOT_FOUND', label + '不存在：' + id);
  return item;
}
function subtree(project, roots) {
  const children = new Map(), selected = new Set(roots), queue = [...selected];
  for (const task of project.tasks) { const list = children.get(task.pid) || []; list.push(task.id); children.set(task.pid, list); }
  for (let i = 0; i < queue.length; i++) for (const id of children.get(queue[i]) || []) if (!selected.has(id)) { selected.add(id); queue.push(id); }
  return selected;
}
function checkParent(project, parentId) {
  if (parentId === null) return;
  const parent = getTask(project, parentId);
  if (parent.type === 'milestone') invalid('重要节点不能有子任务');
}
function insertTask(project, task, beforeId) {
  if (beforeId !== undefined) {
    const before = getTask(project, beforeId);
    if (before.pid !== task.pid || before.id === task.id) invalid('beforeId 必须指向另一同层任务');
    project.tasks.splice(project.tasks.indexOf(before), 0, task);
  } else project.tasks.push(task);
}
function shiftDate(value, days) {
  const date = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid('无法平移无效日期');
  date.setUTCDate(date.getUTCDate() + days);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 100 || date.getUTCFullYear() > 9999) invalid('日期平移超出 0100—9999 年范围');
  return date.toISOString().slice(0, 10);
}
function nonblank(value, label) { if (!value.trim()) invalid(label + '不能为空'); return value; }
function roleMap(project) { return project.meta.roleColors || (project.meta.roleColors = {}); }
function hideDefault(project, name) {
  if (DEFAULT_ROLES.includes(name)) {
    if (!project.meta.hiddenRoles) project.meta.hiddenRoles = [];
    if (!project.meta.hiddenRoles.includes(name)) project.meta.hiddenRoles.push(name);
  }
}
function fields(project) { return project.meta.customFields || (project.meta.customFields = []); }
function validateFieldNames(project, field, exceptId) {
  field.name = nonblank(field.name.trim(), '字段名称');
  const reserved = ['名称', '负责人', '开始', '结束', '进度', '职能', '阶段'];
  const lower = field.name.toLowerCase();
  if (reserved.some(name => name.toLowerCase() === lower) || fields(project).some(item => item.id !== exceptId && item.name.toLowerCase() === lower)) fail('ITEM_EXISTS', '字段名称已存在');
  if (field.type === 'select') {
    if (!Array.isArray(field.options) || !field.options.length) invalid('单选字段至少需要一个选项');
    const names = new Set();
    for (const option of field.options) { option.label = nonblank(option.label.trim(), '选项名称'); const key = option.label.toLowerCase(); if (names.has(key)) fail('ITEM_EXISTS', '选项名称重复'); names.add(key); }
  } else if (own(field, 'options')) invalid('只有单选字段可以包含选项');
}

function applyOne(project, name, args) {
  switch (name) {
    case 'project.update': Object.assign(project.meta, args.patch); return [];
    case 'project.replace': {
      const replacement = normalizeProject(args.project);
      for (const key of Object.keys(project)) delete project[key];
      Object.assign(project, replacement); return [];
    }
    case 'project.shift': {
      for (const task of project.tasks) { task.s = shiftDate(task.s, args.days); task.e = shiftDate(task.e, args.days); }
      for (const flag of project.flags) flag.d = shiftDate(flag.d, args.days);
      return [];
    }
    case 'task.add': {
      const task = withTaskDefaults(args.task);
      if (project.tasks.some(item => item.id === task.id)) fail('ITEM_EXISTS', '任务 ID 已存在：' + task.id);
      // Parent/dependency forward references within an atomic batch are checked at the end.
      insertTask(project, task, args.beforeId); return [task.id];
    }
    case 'task.update': {
      const task = getTask(project, args.id);
      if (project.tasks.some(child => child.pid === task.id) && ['s', 'e', 'pct'].some(key => own(args.patch, key))) invalid('父任务日期和进度由子任务汇总，请调整子任务或使用 task.shift');
      Object.assign(task, args.patch);
      return [task.id];
    }
    case 'task.remove': {
      args.ids.forEach(id => getTask(project, id));
      const selected = new Set(args.ids), all = subtree(project, args.ids);
      if (!args.cascade && [...all].some(id => !selected.has(id))) fail('ITEM_IN_USE', '任务含有子任务；删除整棵子树须显式传 cascade:true');
      const removed = args.cascade ? all : selected;
      project.tasks = project.tasks.filter(task => !removed.has(task.id));
      for (const task of project.tasks) task.deps = task.deps.filter(id => !removed.has(id));
      return [...removed];
    }
    case 'task.move': {
      const task = getTask(project, args.id); checkParent(project, args.parentId);
      if (subtree(project, [task.id]).has(args.parentId)) invalid('不能移入自己或自己的后代');
      if (task.type === 'pipeline' && args.parentId !== null) invalid('管线只能位于顶层');
      // Verify the destination before removing the task (beforeId=self is invalid).
      if (args.beforeId !== undefined) { const before = getTask(project, args.beforeId); if (before.id === task.id || before.pid !== args.parentId) invalid('beforeId 必须指向目标父级下另一任务'); }
      project.tasks = project.tasks.filter(item => item.id !== task.id); task.pid = args.parentId;
      insertTask(project, task, args.beforeId); return [task.id];
    }
    case 'task.reorder': {
      checkParent(project, args.parentId);
      const siblings = project.tasks.filter(task => task.pid === args.parentId), byId = new Map(siblings.map(task => [task.id, task]));
      if (args.ids.length !== siblings.length || args.ids.some(id => !byId.has(id))) invalid('ids 必须恰好包含该父级全部直接子项');
      let i = 0; project.tasks = project.tasks.map(task => task.pid === args.parentId ? byId.get(args.ids[i++]) : task);
      return args.ids.slice();
    }
    case 'task.shift': {
      args.ids.forEach(id => getTask(project, id));
      const selected = args.includeDescendants === false ? new Set(args.ids) : subtree(project, args.ids);
      for (const task of project.tasks) if (selected.has(task.id)) { task.s = shiftDate(task.s, args.days); task.e = shiftDate(task.e, args.days); }
      return [...selected];
    }
    case 'task.duplicate': {
      const root = getTask(project, args.id), selected = subtree(project, [root.id]);
      const keys = Object.keys(args.idMap), mapped = Object.values(args.idMap);
      if (keys.length !== selected.size || keys.some(id => !selected.has(id))) invalid('idMap 必须恰好映射根任务及全部后代');
      if (new Set(mapped).size !== mapped.length || mapped.some(id => project.tasks.some(task => task.id === id))) fail('ITEM_EXISTS', '副本 ID 必须各不相同且尚未使用');
      const parentId = own(args, 'parentId') ? args.parentId : root.pid; checkParent(project, parentId);
      const copies = project.tasks.filter(task => selected.has(task.id)).map(task => {
        const copy = cloneJson(task); copy.id = args.idMap[task.id];
        copy.pid = task.id === root.id ? parentId : args.idMap[task.pid];
        copy.deps = copy.deps.map(id => own(args.idMap, id) ? args.idMap[id] : id);
        return copy;
      });
      project.tasks.push(...copies); return copies.map(task => task.id);
    }
    case 'dependency.add': {
      const task = getTask(project, args.taskId); getTask(project, args.dependsOn);
      if (!task.deps.includes(args.dependsOn)) task.deps.push(args.dependsOn); return [task.id];
    }
    case 'dependency.remove': {
      const task = getTask(project, args.taskId); task.deps = task.deps.filter(id => id !== args.dependsOn); return [task.id];
    }
    case 'dependency.set': getTask(project, args.taskId).deps = args.deps.slice(); return [args.taskId];
    case 'role.add': {
      nonblank(args.name, '职能名称'); if (DANGEROUS.has(args.name)) invalid('不安全的职能名称');
      if (project.groups.some(group => group.name === args.name)) fail('ITEM_EXISTS', '职能已存在：' + args.name);
      project.groups.push({ name: args.name, color: args.color }); roleMap(project)[args.name] = args.color;
      if (project.meta.hiddenRoles) project.meta.hiddenRoles = project.meta.hiddenRoles.filter(name => name !== args.name);
      return [args.name];
    }
    case 'role.update': {
      const group = getItem(project.groups, args.name, '职能', 'name'), nextName = args.patch.name ?? group.name;
      nonblank(nextName, '职能名称'); if (DANGEROUS.has(nextName)) invalid('不安全的职能名称');
      if (project.groups.some(item => item !== group && item.name === nextName)) fail('ITEM_EXISTS', '职能已存在：' + nextName);
      if (nextName !== group.name) {
        for (const task of project.tasks) if (task.grp === group.name) task.grp = nextName;
        hideDefault(project, group.name); delete roleMap(project)[group.name];
        if (project.meta.hiddenRoles) project.meta.hiddenRoles = project.meta.hiddenRoles.filter(name => name !== nextName);
      }
      Object.assign(group, args.patch); roleMap(project)[group.name] = group.color; return [group.name];
    }
    case 'role.remove': {
      const group = getItem(project.groups, args.name, '职能', 'name'), used = project.tasks.some(task => task.grp === group.name);
      if (used && !own(args, 'replacement')) fail('ITEM_IN_USE', '职能仍被任务使用，请指定 replacement');
      if (own(args, 'replacement') && args.replacement !== '') {
        if (args.replacement === group.name) invalid('不能替换为被删除的职能');
        getItem(project.groups, args.replacement, '替代职能', 'name');
      }
      for (const task of project.tasks) if (task.grp === group.name) task.grp = args.replacement || '';
      project.groups = project.groups.filter(item => item !== group); hideDefault(project, group.name); delete roleMap(project)[group.name]; return [group.name];
    }
    case 'phase.rename':
    case 'phase.remove': {
      const selected = project.tasks.filter(task => task.phase === args.name);
      if (!selected.length) fail('ITEM_NOT_FOUND', '阶段不存在：' + args.name);
      const value = name === 'phase.rename' ? nonblank(args.newName, '阶段名称') : '';
      for (const task of selected) task.phase = value; return [args.name];
    }
    case 'field.add': {
      const field = args.field;
      if (fields(project).some(item => item.id === field.id)) fail('ITEM_EXISTS', '字段 ID 已存在');
      validateFieldNames(project, field); fields(project).push(field); return [field.id];
    }
    case 'field.update': {
      const field = getItem(fields(project), args.id, '字段'); Object.assign(field, args.patch); validateFieldNames(project, field, field.id);
      if (own(args.patch, 'options')) {
        const allowed = new Set(field.options.map(option => option.id));
        for (const task of project.tasks) if (task.customValues && own(task.customValues, field.id) && !allowed.has(task.customValues[field.id])) delete task.customValues[field.id];
      }
      return [field.id];
    }
    case 'field.remove': {
      getItem(fields(project), args.id, '字段'); project.meta.customFields = fields(project).filter(field => field.id !== args.id);
      for (const task of project.tasks) if (task.customValues) delete task.customValues[args.id];
      return [args.id];
    }
    case 'field.values.set': {
      const task = getTask(project, args.taskId), values = task.customValues || (task.customValues = {});
      for (const [id, value] of Object.entries(args.values)) { getItem(fields(project), id, '字段'); if (value === null) delete values[id]; else values[id] = value; }
      return [task.id];
    }
    case 'flag.add': {
      if (project.flags.some(flag => flag.id === args.flag.id)) fail('ITEM_EXISTS', '里程碑 ID 已存在');
      project.flags.push({ color: '#e03e3e', ...args.flag }); return [args.flag.id];
    }
    case 'flag.update': Object.assign(getItem(project.flags, args.id, '里程碑'), args.patch); return [args.id];
    case 'flag.remove': getItem(project.flags, args.id, '里程碑'); project.flags = project.flags.filter(flag => flag.id !== args.id); return [args.id];
    default: fail('UNKNOWN_OPERATION', '未知操作：' + name);
  }
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
}

function applyOperations(input, inputOperations, _options = {}) {
  const project = normalizeProject(input), before = stableJson(project), operations = cloneJson(inputOperations);
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_OPERATIONS) invalid('operations 必须包含 1 到 100 个操作');
  const results = [];
  operations.forEach((operation, index) => {
    try {
      if (!isObject(operation) || Object.keys(operation).some(key => !['name', 'arguments'].includes(key)) || typeof operation.name !== 'string' || !own(operation, 'arguments')) invalid('每个操作必须为 {name,arguments}');
      const definition = definitions.get(operation.name);
      if (!definition) fail('UNKNOWN_OPERATION', '未知操作：' + operation.name);
      validateSchema(operation.arguments, definition.inputSchema);
      const affectedIds = applyOne(project, operation.name, operation.arguments);
      results.push({ index, name: operation.name, affectedIds });
    } catch (error) {
      const failure = error instanceof OperationError ? error : new OperationError('VALIDATION_ERROR', '操作数据无效：' + error.message);
      failure.operationIndex = index; throw failure;
    }
  });
  // One atomic validation at the end permits forward references in a batch.
  validateShared(project);
  return { project, results, changed: before !== stableJson(project) };
}

module.exports = { operationDefinitions, applyOperations, normalizeProject, OperationError, MAX_OPERATIONS, validateSchema };
