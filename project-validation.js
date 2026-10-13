/* Shared, side-effect-free validation for imported and persisted projects. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScheduleProjectValidation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIMITS = Object.freeze({
    maxBytes: 10 * 1024 * 1024,
    maxTasks: 10000,
    maxGroups: 1000,
    maxFlags: 10000,
    maxDepth: 32,
    maxHierarchyDepth: 128,
    maxNodes: 300000,
    maxDependencies: 100000,
    maxCustomFields: 50,
    maxFieldOptions: 100
  });
  const DEFAULT_GROUPS = [
    { name: '策划', color: '#2f6fe8' },
    { name: '美术', color: '#ec4899' },
    { name: '程序', color: '#0ea5e9' },
    { name: '技术策划', color: '#a855f7' },
    { name: '技术美术', color: '#575ae8' },
    { name: '动画', color: '#f59e0b' }
  ];
  const ROLE_MAP = new Map([
    ['玩法策划GD', '策划'], ['关卡策划LD', '策划'],
    ['技术策划TD', '技术策划'], ['技术美术TA', '技术美术']
  ]);
  const OLD_DEFAULTS = new Set([
    '设计', '开发', '测试', '产品', '玩法策划GD', '技术策划TD',
    '关卡策划LD', '技术美术TA', '音频', '其他'
  ]);
  const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  const BUILTIN_COLUMNS = ['name', 'person', 'start', 'end', 'pct', 'grp', 'phase'];
  const BUILTIN_COLUMN_NAMES = ['名称', '负责人', '开始', '结束', '进度', '职能', '阶段'];
  const CUSTOM_FIELD_TYPES = new Set(['text', 'number', 'date', 'select', 'checkbox']);

  class ValidationError extends Error {
    constructor(message, path) {
      super((path ? path + '：' : '') + message);
      this.name = 'ValidationError';
      this.path = path || '';
    }
  }
  function fail(message, path) { throw new ValidationError(message, path); }
  function object(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('必须是对象', path);
    }
    return value;
  }
  function text(value, path, maxLength, fallback) {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== 'string') fail('必须是文本', path);
    if (value.length > maxLength) fail('文本过长', path);
    return value;
  }
  function identifier(value, path) {
    const id = text(value, path, 256);
    if (!id.trim()) fail('ID 不能为空', path);
    return id;
  }
  function number(value, path, min, max, fallback) {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      fail('数值必须在 ' + min + ' 到 ' + max + ' 之间', path);
    }
    return value;
  }
  function boolean(value, path, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') fail('必须是布尔值', path);
    return value;
  }
  function color(value, path, fallback) {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
      fail('颜色必须是 #RGB 或 #RRGGBB', path);
    }
    // The renderer's color arithmetic expects six hex digits.
    return value.length === 4 ? '#' + value.slice(1).split('').map(c => c + c).join('') : value;
  }
  function date(value, path) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      fail('日期必须使用 YYYY-MM-DD 格式', path);
    }
    const y = Number(value.slice(0, 4)), m = Number(value.slice(5, 7)), d = Number(value.slice(8, 10));
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (y < 100 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) {
      fail('日期不存在或超出支持范围（0100—9999 年）', path);
    }
    return value;
  }
  function list(value, path, limit, fallback) {
    if (value === undefined) return fallback;
    if (!Array.isArray(value)) fail('必须是数组', path);
    if (value.length > limit) fail('数量超过限制 ' + limit, path);
    return value;
  }

  // Clone only bounded JSON data. Inspect descriptors before reading properties,
  // so a malformed object cannot run a getter while it is being validated.
  function cloneJson(input) {
    let nodes = 0;
    const ancestors = new Set();
    function visit(value, path, depth) {
      if (++nodes > LIMITS.maxNodes) fail('项目结构过大', path);
      if (depth > LIMITS.maxDepth) fail('项目嵌套过深', path);
      if (value === null || typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        if (value.length > LIMITS.maxBytes) fail('项目文本过大', path);
        return value;
      }
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value !== 'object' || !value) fail('只能包含有效的 JSON 数据', path);
      if (ancestors.has(value)) fail('JSON 数据不能包含循环引用', path);
      const isArray = Array.isArray(value), proto = Object.getPrototypeOf(value);
      if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
        fail('对象原型不受支持', path);
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.length > LIMITS.maxNodes || (isArray && value.length > LIMITS.maxNodes)) {
        fail('项目结构过大', path);
      }
      const copy = isArray ? [] : {};
      ancestors.add(value);
      for (const key of keys) {
        if (isArray && key === 'length') continue;
        if (typeof key !== 'string' || DANGEROUS_KEYS.has(key)) fail('不安全的字段名', path);
        if (key.length > 256) fail('字段名过长', path);
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          fail('字段必须是普通 JSON 值', path + '.' + key);
        }
        if (isArray && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) {
          fail('数组不能包含额外字段', path);
        }
        copy[key] = visit(descriptor.value, path + (isArray ? '[' + key + ']' : '.' + key), depth + 1);
      }
      if (isArray && copy.length !== value.length) fail('数组不能为空洞', path);
      if (isArray) {
        for (let i = 0; i < value.length; i++) {
          if (!Object.prototype.hasOwnProperty.call(copy, i)) fail('数组不能为空洞', path);
        }
      }
      ancestors.delete(value);
      return copy;
    }
    return visit(input, '项目', 0);
  }
  function jsonBytes(value) {
    const json = JSON.stringify(value);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(json).length;
    let size = 0;
    for (let i = 0; i < json.length; i++) {
      const c = json.charCodeAt(i);
      if (c < 0x80) size++;
      else if (c < 0x800) size += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < json.length && json.charCodeAt(i + 1) >= 0xdc00 && json.charCodeAt(i + 1) <= 0xdfff) {
        size += 4; i++;
      } else size += 3;
    }
    return size;
  }

  function normalizeMeta(project) {
    const meta = project.meta === undefined ? {} : object(project.meta, 'meta');
    if (meta.lw === undefined && meta.leftWidth !== undefined) meta.lw = meta.leftWidth;
    meta.lw = number(meta.lw, 'meta.lw', 100, 2000, 440);
    if (meta.leftWidth !== undefined) number(meta.leftWidth, 'meta.leftWidth', 100, 2000);
    meta.cols = meta.cols === undefined ? {} : object(meta.cols, 'meta.cols');
    for (const key of Object.keys(meta.cols)) number(meta.cols[key], 'meta.cols.' + key, 16, 2000);
    if (meta.layoutVersion === 2) {
      delete meta.cols.date;
    } else {
      for (const [key, fallback] of [['person', 64], ['date', 76], ['pct', 52]]) {
        meta.cols[key] = number(meta.cols[key], 'meta.cols.' + key, 16, 2000, fallback);
      }
    }
    if (meta.defView !== undefined && !['day', 'week', 'month'].includes(meta.defView)) {
      fail('默认视图只能是 day、week 或 month', 'meta.defView');
    }
    if (meta.nameAutoWidth !== undefined) {
      meta.nameAutoWidth = boolean(meta.nameAutoWidth, 'meta.nameAutoWidth');
    }
    if (meta.layoutVersion !== undefined && meta.layoutVersion !== 2) {
      fail('布局版本只能是 2', 'meta.layoutVersion');
    }
    if (meta.paneAuto !== undefined) {
      meta.paneAuto = boolean(meta.paneAuto, 'meta.paneAuto');
    }
    const hidden = list(meta.hiddenRoles, 'meta.hiddenRoles', LIMITS.maxGroups, []);
    meta.hiddenRoles = Array.from(new Set(hidden.map((name, i) => {
      const result = text(name, 'meta.hiddenRoles[' + i + ']', 256);
      if (!result.trim()) fail('职能名不能为空', 'meta.hiddenRoles[' + i + ']');
      return result;
    })));
    if (meta.roleColors !== undefined) {
      object(meta.roleColors, 'meta.roleColors');
      if (Object.keys(meta.roleColors).length > LIMITS.maxGroups) fail('职能颜色数量过多', 'meta.roleColors');
      for (const name of Object.keys(meta.roleColors)) {
        if (!name.trim()) fail('职能名不能为空', 'meta.roleColors');
        meta.roleColors[name] = color(meta.roleColors[name], 'meta.roleColors.' + name);
      }
    }
    project.meta = meta;
  }

  function normalizeTasks(project) {
    const tasks = list(project.tasks, 'tasks', LIMITS.maxTasks);
    if (!tasks) fail('缺少任务数组', 'tasks');
    const byId = new Map();
    let dependencyCount = 0;
    const aliases = [['start', 's'], ['end', 'e'], ['progress', 'pct'], ['parentId', 'pid'],
      ['assignee', 'who'], ['group', 'grp'], ['collapsed', 'fold']];
    for (let i = 0; i < tasks.length; i++) {
      const task = object(tasks[i], 'tasks[' + i + ']'), path = 'tasks[' + i + ']';
      for (const [oldKey, newKey] of aliases) {
        if (task[newKey] === undefined && task[oldKey] !== undefined) task[newKey] = task[oldKey];
      }
      task.id = identifier(task.id, path + '.id');
      if (byId.has(task.id)) fail('任务 ID 重复：' + task.id, path + '.id');
      byId.set(task.id, { task, index: i, children: [] });
      task.name = text(task.name, path + '.name', 2048, '未命名任务');
      if (!task.name.trim()) task.name = '未命名任务';
      task.who = text(task.who, path + '.who', 512, '');
      task.phase = text(task.phase, path + '.phase', 512, '');
      task.grp = text(task.grp, path + '.grp', 256, '');
      task.grp = ROLE_MAP.get(task.grp) || task.grp;
      task.type = task.type === undefined ? 'task' : task.type;
      if (!['task', 'milestone', 'pipeline'].includes(task.type)) fail('不支持的任务类型', path + '.type');
      task.pid = task.pid === undefined ? null : task.pid;
      if (task.pid !== null) identifier(task.pid, path + '.pid');
      if (task.type === 'pipeline') {
        if (task.pid !== null) fail('管线只能位于顶层', path + '.pid');
        task.grp = '';
      }
      task.s = date(task.s, path + '.s');
      if (task.e === undefined && task.type === 'milestone') task.e = task.s;
      task.e = date(task.e, path + '.e');
      if (task.s > task.e) fail('结束日期不能早于开始日期', path + '.e');
      if (task.type === 'milestone' && task.s !== task.e) fail('里程碑的起止日期必须相同', path + '.e');
      task.pct = number(task.pct, path + '.pct', 0, 100, 0);
      task.fold = boolean(task.fold, path + '.fold', false);
      task.flow = boolean(task.flow, path + '.flow', false);
      task.lane = number(task.lane, path + '.lane', 0, 10000, 0);
      if (!Number.isSafeInteger(task.lane)) fail('行号必须是非负整数', path + '.lane');
      const deps = list(task.deps, path + '.deps', LIMITS.maxTasks, []);
      task.deps = Array.from(new Set(deps.map((id, depIndex) => identifier(id, path + '.deps[' + depIndex + ']'))));
      dependencyCount += task.deps.length;
      if (dependencyCount > LIMITS.maxDependencies) fail('依赖数量过多', path + '.deps');
      if (task.type === 'pipeline' && task.deps.length) fail('管线不能参与依赖', path + '.deps');
    }
    for (const entry of byId.values()) {
      if (entry.task.pid === null) continue;
      const parent = byId.get(entry.task.pid);
      if (!parent) fail('父任务不存在：' + entry.task.pid, '任务 ' + entry.task.id);
      if (parent.task.type === 'milestone') fail('里程碑不能有子任务', '任务 ' + parent.task.id);
      parent.children.push(entry);
    }
    return byId;
  }

  function normalizeCustomFields(project) {
    // Preserve omitted properties: adding empty defaults would change the
    // deterministic identity of legacy projects that have no custom columns.
    const descriptors = list(project.meta.customFields, 'meta.customFields', LIMITS.maxCustomFields, []);
    const fields = new Map(), names = new Set(BUILTIN_COLUMN_NAMES);
    for (let i = 0; i < descriptors.length; i++) {
      const fieldPath = 'meta.customFields[' + i + ']';
      const field = object(descriptors[i], fieldPath);
      if (typeof field.id !== 'string' || !/^cf_[A-Za-z0-9_-]{1,64}$/.test(field.id)) {
        fail('字段 ID 必须是 cf_ 开头的字母、数字、下划线或短横线', fieldPath + '.id');
      }
      if (fields.has(field.id)) fail('字段 ID 重复：' + field.id, fieldPath + '.id');
      field.name = text(field.name, fieldPath + '.name', 128).trim();
      if (!field.name) fail('字段名称不能为空', fieldPath + '.name');
      if (names.has(field.name)) fail('字段名称不能与内置列或其他字段重名：' + field.name, fieldPath + '.name');
      names.add(field.name);
      if (!CUSTOM_FIELD_TYPES.has(field.type)) fail('不支持的字段类型', fieldPath + '.type');
      const options = new Set();
      if (field.type === 'select') {
        const choices = list(field.options, fieldPath + '.options', LIMITS.maxFieldOptions);
        if (!choices) fail('选择字段必须提供选项数组', fieldPath + '.options');
        for (let j = 0; j < choices.length; j++) {
          const optionPath = fieldPath + '.options[' + j + ']';
          const option = object(choices[j], optionPath);
          if (typeof option.id !== 'string' || !/^fo_[A-Za-z0-9_-]{1,64}$/.test(option.id)) {
            fail('选项 ID 必须是 fo_ 开头的字母、数字、下划线或短横线', optionPath + '.id');
          }
          if (options.has(option.id)) fail('选项 ID 重复：' + option.id, optionPath + '.id');
          options.add(option.id);
          option.label = text(option.label, optionPath + '.label', 128).trim();
          if (!option.label) fail('选项名称不能为空', optionPath + '.label');
        }
      } else if (field.options !== undefined) {
        fail('只有选择字段可以包含选项', fieldPath + '.options');
      }
      fields.set(field.id, { field, options });
    }
    const validColumns = new Set([...BUILTIN_COLUMNS, ...fields.keys()]);
    for (const key of ['columnOrder', 'hiddenColumns']) {
      if (project.meta[key] === undefined) continue;
      const columnPath = 'meta.' + key;
      const columns = list(project.meta[key], columnPath, validColumns.size), seen = new Set();
      for (let i = 0; i < columns.length; i++) {
        const id = columns[i];
        if (typeof id !== 'string' || !validColumns.has(id)) fail('列 ID 不存在', columnPath + '[' + i + ']');
        if (seen.has(id)) fail('列 ID 不能重复：' + id, columnPath + '[' + i + ']');
        seen.add(id);
        if (key === 'columnOrder' && id === 'name' && i !== 0) fail('名称列只能位于第一列', columnPath);
        if (key === 'hiddenColumns' && id === 'name') fail('名称列不能隐藏', columnPath);
      }
    }
    return fields;
  }

  function normalizeCustomValues(project, fields) {
    for (let i = 0; i < project.tasks.length; i++) {
      const task = project.tasks[i];
      if (task.customValues === undefined) continue;
      const valuesPath = 'tasks[' + i + '].customValues';
      const values = object(task.customValues, valuesPath);
      for (const id of Object.keys(values)) {
        const entry = fields.get(id), valuePath = valuesPath + '.' + id;
        if (!entry) fail('自定义字段不存在：' + id, valuePath);
        const value = values[id];
        if (value === null) { delete values[id]; continue; }
        switch (entry.field.type) {
          case 'text': text(value, valuePath, 4096); break;
          case 'number':
            if (typeof value !== 'number' || !Number.isFinite(value)) fail('数字字段必须是有限数值', valuePath);
            break;
          case 'date': date(value, valuePath); break;
          case 'checkbox':
            if (typeof value !== 'boolean') fail('勾选字段必须是布尔值', valuePath);
            break;
          case 'select':
            if (typeof value !== 'string' || !entry.options.has(value)) fail('选择字段的选项不存在', valuePath);
            break;
        }
      }
    }
  }

  function validateGraph(byId) {
    // Iterative traversal avoids overflowing the call stack on long, valid trees.
    const intervals = new Map(), stack = [];
    for (const entry of byId.values()) {
      if (entry.task.pid === null) stack.push([entry, false, 1]);
    }
    let clock = 0, visited = 0;
    while (stack.length) {
      const [entry, leaving, depth] = stack.pop();
      if (leaving) { intervals.get(entry.task.id).end = clock++; continue; }
      if (depth > LIMITS.maxHierarchyDepth) {
        fail('任务层级超过限制 ' + LIMITS.maxHierarchyDepth, '任务 ' + entry.task.id);
      }
      intervals.set(entry.task.id, { start: clock++, end: 0 });
      visited++;
      stack.push([entry, true, depth]);
      for (const child of entry.children) stack.push([child, false, depth + 1]);
    }
    if (visited !== byId.size) fail('父任务关系存在循环', 'tasks');
    const isAncestor = (a, b) => {
      const x = intervals.get(a), y = intervals.get(b);
      return x.start <= y.start && x.end >= y.end;
    };
    // A summary starts before each child and finishes after all children. A
    // separate start/end port catches cycles through these implicit boundaries.
    const adjacency = Array.from({ length: byId.size * 2 }, () => []);
    const degree = new Uint32Array(adjacency.length);
    function edge(from, to) { adjacency[from].push(to); degree[to]++; }
    for (const entry of byId.values()) {
      const start = entry.index * 2, end = start + 1;
      if (!entry.children.length) edge(start, end);
      for (const child of entry.children) {
        edge(start, child.index * 2);
        edge(child.index * 2 + 1, end);
      }
      for (const depId of entry.task.deps) {
        const dep = byId.get(depId), path = '任务 ' + entry.task.id + '.deps';
        if (!dep) fail('前置任务不存在：' + depId, path);
        if (dep.task.type === 'pipeline') fail('管线不能参与依赖', path);
        if (isAncestor(depId, entry.task.id) || isAncestor(entry.task.id, depId)) {
          fail('不能依赖自身、祖先或后代任务：' + depId, path);
        }
        edge(dep.index * 2 + 1, start);
      }
    }
    const ready = [];
    for (let i = 0; i < degree.length; i++) if (degree[i] === 0) ready.push(i);
    let cursor = 0;
    while (cursor < ready.length) {
      const port = ready[cursor++];
      for (const next of adjacency[port]) if (--degree[next] === 0) ready.push(next);
    }
    if (cursor !== adjacency.length) fail('任务依赖与父任务关系形成循环', 'tasks');
  }

  function normalizeGroups(project) {
    const groups = list(project.groups, 'groups', LIMITS.maxGroups, []), names = new Set();
    for (let i = 0; i < groups.length; i++) {
      const group = object(groups[i], 'groups[' + i + ']');
      group.name = text(group.name, 'groups[' + i + '].name', 256);
      if (!group.name.trim()) fail('职能名不能为空', 'groups[' + i + '].name');
      if (names.has(group.name)) fail('职能名重复：' + group.name, 'groups[' + i + '].name');
      names.add(group.name);
      group.color = color(group.color, 'groups[' + i + '].color', '#2f6fe8');
    }
    const used = new Set(project.tasks.map(task => task.grp));
    const hidden = new Set(project.meta.hiddenRoles);
    const defaults = new Set(DEFAULT_GROUPS.map(group => group.name));
    const extra = groups.filter(group => !defaults.has(group.name) && !ROLE_MAP.has(group.name) &&
      (!OLD_DEFAULTS.has(group.name) || used.has(group.name)));
    // Keep any additional JSON fields on existing groups as well as on tasks.
    project.groups = DEFAULT_GROUPS.filter(group => used.has(group.name) || !hidden.has(group.name))
      .map(group => Object.assign({}, groups.find(saved => saved.name === group.name) || {}, group))
      .concat(extra);
    if (project.groups.length > LIMITS.maxGroups) fail('职能数量超过限制 ' + LIMITS.maxGroups, 'groups');
    if (project.meta.roleColors) {
      for (const group of project.groups) {
        if (Object.prototype.hasOwnProperty.call(project.meta.roleColors, group.name)) {
          group.color = project.meta.roleColors[group.name];
        }
      }
    }
  }

  function normalizeFlags(project) {
    project.flags = list(project.flags, 'flags', LIMITS.maxFlags, []);
    const ids = new Set();
    for (let i = 0; i < project.flags.length; i++) {
      const flag = object(project.flags[i], 'flags[' + i + ']'), path = 'flags[' + i + ']';
      flag.id = identifier(flag.id, path + '.id');
      if (ids.has(flag.id)) fail('旗子 ID 重复：' + flag.id, path + '.id');
      ids.add(flag.id);
      flag.name = text(flag.name, path + '.name', 2048, '未命名节点');
      if (!flag.name.trim()) flag.name = '未命名节点';
      flag.d = date(flag.d, path + '.d');
      flag.color = color(flag.color, path + '.color', '#e03e3e');
    }
  }

  function validateProject(input) {
    let project = cloneJson(input);
    object(project, '项目');
    if (jsonBytes(project) > LIMITS.maxBytes) fail('项目文件超过 10 MiB', '项目');
    if (project.format === 'schedule-gantt-storage') {
      if (project.version !== 1) fail('不支持的存储版本', 'version');
      project = object(project.project, 'project');
    }
    normalizeMeta(project);
    const customFields = normalizeCustomFields(project);
    const byId = normalizeTasks(project);
    normalizeCustomValues(project, customFields);
    validateGraph(byId);
    normalizeGroups(project);
    normalizeFlags(project);
    // Added defaults must obey the same bounds as imported data. Otherwise a
    // project could import successfully and then fail to reopen after saving.
    let normalizedNodes = 0;
    function countNodes(value) {
      if (++normalizedNodes > LIMITS.maxNodes) fail('归一化后的项目结构过大', '项目');
      if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) countNodes(value[key]);
      }
    }
    countNodes(project);
    if (jsonBytes(project) > LIMITS.maxBytes) fail('项目文件超过 10 MiB', '项目');
    return project;
  }

  return { validateProject, ValidationError, LIMITS };
});
