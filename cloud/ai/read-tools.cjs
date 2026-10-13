'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { validateProject } = require('../../project-validation.js');

const PERSONAL = ['cols', 'lw', 'leftWidth', 'paneAuto', 'layoutVersion', 'nameAutoWidth', 'columnOrder', 'hiddenColumns', 'defView'];
const MAX_PAGE = 500;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const day = value => {
  const [year, month, date] = value.split('-').map(Number);
  return Date.UTC(year, month - 1, date) / 86400000;
};
function error(code, message) {
  const result = new Error(message);
  result.code = code;
  return result;
}
function invalid(message) { throw error('INVALID_ARGUMENTS', message); }
function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(label + ' must be an object.');
}
function keys(value, permitted, label) {
  plainObject(value, label);
  for (const key of Object.keys(value)) if (!permitted.includes(key)) invalid(label + ': unsupported property ' + key + '.');
}
function text(value, label, max = 2048, nonempty = false) {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim())) invalid(label + ' must be valid text.');
}
function date(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(label + ' must use YYYY-MM-DD.');
  const n = day(value);
  if (Number(value.slice(0, 4)) < 100 || !Number.isFinite(n) || new Date(n * 86400000).toISOString().slice(0, 10) !== value) invalid(label + ' is not a valid date.');
}
function pagination(args) {
  const offset = args.offset === undefined ? 0 : args.offset;
  const limit = args.limit === undefined ? 100 : args.limit;
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000) invalid('offset must be an integer from 0 to 100000.');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) invalid('limit must be an integer from 1 to 500.');
  return { offset, limit };
}
function page(items, args) {
  const { offset, limit } = pagination(args);
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit, hasMore: offset + limit < items.length };
}
function publicRecord(record) {
  if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !Number.isInteger(record.revision) || record.revision < 1) {
    throw error('INVALID_RECORD', 'A public project record with id and revision is required.');
  }
  let project;
  try { project = validateProject(record.project); } catch (cause) {
    throw error('INVALID_PROJECT', cause.message);
  }
  for (const key of PERSONAL) delete project.meta[key];
  for (const task of project.tasks) { delete task.fold; delete task.collapsed; }
  const result = { id: record.id, revision: record.revision, project };
  for (const key of ['createdAt', 'updatedAt', 'updatedBy']) {
    if (typeof record[key] === 'string') result[key] = record[key];
  }
  if (record.source === 'human' || record.source === 'external') result.source = record.source;
  return result;
}

// The task list exposes stored values and derived values separately: parent dates
// and progress are calculated from leaves, exactly as eRange/sumPct in the UI.
function taskIndex(project) {
  const byId = new Map(project.tasks.map(task => [task.id, task]));
  const children = new Map();
  for (const task of project.tasks) {
    if (!children.has(task.pid)) children.set(task.pid, []);
    children.get(task.pid).push(task);
  }
  const memo = new Map();
  function aggregate(task) {
    if (memo.has(task.id)) return memo.get(task.id);
    const descendants = children.get(task.id) || [];
    let result;
    if (!descendants.length) {
      const weight = task.type === 'milestone' ? 0 : Math.max(1, day(task.e) - day(task.s) + 1);
      result = { s: task.s, e: task.e, weight, weighted: weight * (task.pct || 0), summary: false };
    } else {
      const values = descendants.map(aggregate);
      result = {
        s: values.reduce((s, value) => value.s < s ? value.s : s, '9999-12-31'),
        e: values.reduce((e, value) => value.e > e ? value.e : e, '0100-01-01'),
        weight: values.reduce((sum, value) => sum + value.weight, 0),
        weighted: values.reduce((sum, value) => sum + value.weighted, 0),
        summary: true
      };
    }
    result.pct = result.summary ? (result.weight ? Math.round(result.weighted / result.weight) : 0) : task.pct;
    memo.set(task.id, result);
    return result;
  }
  function computed(task) {
    const value = aggregate(task);
    return {
      s: value.s, e: value.e, pct: value.pct, isSummary: value.summary,
      durationDays: task.type === 'milestone' || task.type === 'pipeline' ? 0 : Math.max(1, day(value.e) - day(value.s) + 1),
      childCount: (children.get(task.id) || []).length
    };
  }
  return { byId, children, aggregate, computed };
}

const filterProperties = {
  who: { type: 'string', maxLength: 2048, description: 'Exact owner/负责人 match.' },
  grp: { type: 'string', maxLength: 2048, description: 'Exact role/职能 match.' },
  phase: { type: 'string', maxLength: 2048 },
  type: { type: 'string', enum: ['task', 'milestone', 'pipeline'] },
  pid: { type: ['string', 'null'], maxLength: 256, description: 'Exact parent id; null selects root rows.' },
  pctMin: { type: 'number', minimum: 0, maximum: 100 },
  pctMax: { type: 'number', minimum: 0, maximum: 100 },
  dateFrom: { type: 'string', format: 'date', description: 'Inclusive overlap range, using effective summary dates.' },
  dateTo: { type: 'string', format: 'date' },
  isSummary: { type: 'boolean' },
  customValues: {
    type: 'object', maxProperties: 50,
    propertyNames: { pattern: '^cf_[A-Za-z0-9_-]{1,64}$' },
    additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
    description: 'Exact custom-field values; null selects absent/null values; select fields use option ids.'
  }
};
const filterSchema = { type: 'object', properties: filterProperties, additionalProperties: false };
const paging = {
  offset: { type: 'integer', minimum: 0, maximum: 100000, default: 0 },
  limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: 100 }
};
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const def = (name, description, inputSchema) => ({
  name, description, inputSchema, readOnlyHint: true,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
});
const definitions = [
  def('project.get', 'Read the public project record and current revision. Never returns credentials, tokens or private record fields.', schema()),
  def('project.export', 'Export the complete project JSON directly importable by the scheduler. Browser layout preferences are omitted.', schema()),
  def('project.analyze', 'Analyze effective summary dates/progress, critical tasks/dependencies and dependency date conflicts using the exact UI algorithm. Each detail list is independently paginated.', schema(paging)),
  def('task.list', 'List tasks with exact filters, effective summary values and pagination. This does not include ancestor rows automatically.', schema({ ...paging, filter: filterSchema })),
  def('task.get', 'Read one task by id, including stored editable values and computed summary values.', schema({ id: { type: 'string', minLength: 1, maxLength: 256 } }, ['id'])),
  def('task.search', 'Case-insensitive substring search across task name, owner, role, phase and custom text/select labels; combine with exact filters.', schema({ ...paging, query: { type: 'string', minLength: 1, maxLength: 512 }, filter: filterSchema }, ['query'])),
  def('group.list', 'List project roles/职能 (groups), their colors and task counts.', schema(paging)),
  def('phase.list', 'List named phases and task counts in first-appearance order.', schema(paging)),
  def('field.list', 'List built-in field metadata and custom field definitions, including select option ids.', schema(paging)),
  def('flag.list', 'List global milestone flags, separate from task milestone rows.', schema(paging))
];
const definitionMap = new Map(definitions.map(item => [item.name, item]));

function checkedFilter(input, project) {
  const filter = input === undefined ? {} : input;
  keys(filter, Object.keys(filterProperties), 'filter');
  for (const key of ['who', 'grp', 'phase']) if (own(filter, key)) text(filter[key], 'filter.' + key);
  if (own(filter, 'pid') && filter.pid !== null) text(filter.pid, 'filter.pid', 256, true);
  if (own(filter, 'type') && !['task', 'milestone', 'pipeline'].includes(filter.type)) invalid('Unsupported task type.');
  for (const key of ['pctMin', 'pctMax']) if (own(filter, key) && (typeof filter[key] !== 'number' || !Number.isFinite(filter[key]) || filter[key] < 0 || filter[key] > 100)) invalid(key + ' must be from 0 to 100.');
  if (filter.pctMin !== undefined && filter.pctMax !== undefined && filter.pctMin > filter.pctMax) invalid('pctMin must not exceed pctMax.');
  for (const key of ['dateFrom', 'dateTo']) if (own(filter, key)) date(filter[key], key);
  if (filter.dateFrom && filter.dateTo && filter.dateFrom > filter.dateTo) invalid('dateFrom must not exceed dateTo.');
  if (own(filter, 'isSummary') && typeof filter.isSummary !== 'boolean') invalid('isSummary must be boolean.');
  if (own(filter, 'customValues')) {
    plainObject(filter.customValues, 'filter.customValues');
    const fields = new Map((project.meta.customFields || []).map(field => [field.id, field]));
    if (Object.keys(filter.customValues).length > 50) invalid('At most 50 custom value filters are allowed.');
    for (const [id, value] of Object.entries(filter.customValues)) {
      if (!fields.has(id)) invalid('Unknown custom field: ' + id);
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) invalid('Custom filters require scalar values.');
      if (typeof value === 'number' && !Number.isFinite(value)) invalid('Custom filters require finite numbers.');
      if (typeof value === 'string' && value.length > 20000) invalid('Custom filter text is too long.');
    }
  }
  return filter;
}
function matches(task, computed, filter) {
  for (const key of ['who', 'grp', 'phase', 'pid', 'type']) if (own(filter, key) && task[key] !== filter[key]) return false;
  if (filter.pctMin !== undefined && computed.pct < filter.pctMin) return false;
  if (filter.pctMax !== undefined && computed.pct > filter.pctMax) return false;
  if (filter.dateFrom && computed.e < filter.dateFrom) return false;
  if (filter.dateTo && computed.s > filter.dateTo) return false;
  if (filter.isSummary !== undefined && computed.isSummary !== filter.isSummary) return false;
  for (const [id, value] of Object.entries(filter.customValues || {})) {
    const actual = task.customValues?.[id];
    if (value === null ? actual !== undefined && actual !== null : actual !== value) return false;
  }
  return true;
}
function searchable(task, fields) {
  const values = [task.name, task.who, task.grp, task.phase];
  for (const field of fields) {
    const value = task.customValues?.[field.id];
    if (typeof value === 'string') {
      values.push(value);
      if (field.type === 'select') values.push(field.options?.find(option => option.id === value)?.label || '');
    }
  }
  return values.join('\n').toLowerCase();
}

// Execute only this repository's trusted frontend algorithm, never text from a
// project or tool argument. No globals for filesystem, network or module loading
// are available to it, and analysis work is capped at five seconds.
const analysisSource = fs.readFileSync(path.join(__dirname, '../../frontend/scripts/project.js'), 'utf8');
const analysisScript = new vm.Script(
  "'use strict';\nlet proj=input,crit=new Set(),cf=new Set();\n" +
  "const tD=s=>{const[y,m,d]=s.split('-').map(Number);return Math.floor(Date.UTC(y,m-1,d)/86400000)};\n" +
  'function toast(){}\n' + analysisSource +
  '\nanalyze();\n' +
  'const graph=buildDependencyGraph(),order=topoDependencyGraph(graph);let criticalPathDays=null;\n' +
  'if(order){const earliest=graph.nodes.map(()=>0);for(const id of order)for(const edge of graph.adj[id])earliest[edge.to]=Math.max(earliest[edge.to],earliest[id]+edge.weight);criticalPathDays=earliest.reduce((a,b)=>Math.max(a,b),0)}\n' +
  'JSON.stringify({criticalTaskIds:[...crit],conflictTaskIds:[...cf],criticalDependencies:[...critEdges].map(value=>{const[from,to]=JSON.parse(value);return{from,to}}),criticalPathDays,hasDependencyCycle:order===null});',
  { filename: 'schedule-read-tools-ui-analysis.js' }
);
function uiAnalysis(project) {
  try {
    return JSON.parse(analysisScript.runInNewContext({ input: project }, { timeout: 5000, contextCodeGeneration: { strings: false, wasm: false } }));
  } catch (cause) {
    if (cause.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw error('ANALYSIS_LIMIT', 'Analysis exceeded its time limit; use filtered task tools to inspect this project.');
    throw cause;
  }
}
function analyzeProject(project, args, index) {
  const result = uiAnalysis(project);
  const criticalSet = new Set(result.criticalTaskIds);
  const leafTasks = project.tasks.filter(task => !(index.children.get(task.id) || []).length && task.type !== 'milestone' && task.type !== 'pipeline');
  const totalWeight = leafTasks.reduce((sum, task) => sum + index.aggregate(task).weight, 0);
  const weighted = leafTasks.reduce((sum, task) => sum + index.aggregate(task).weighted, 0);
  const ranges = project.tasks.map(task => index.computed(task));
  const conflicts = [];
  for (const task of project.tasks) {
    if (task.type === 'pipeline') continue;
    const current = index.computed(task);
    for (const beforeId of task.deps || []) {
      const before = index.byId.get(beforeId);
      if (!before || before.type === 'pipeline') continue;
      const previous = index.computed(before);
      if (current.s < previous.e) conflicts.push({
        from: before.id, fromName: before.name, to: task.id, toName: task.name,
        predecessorEnd: previous.e, successorStart: current.s,
        overlapDays: day(previous.e) - day(current.s)
      });
    }
  }
  return {
    summary: {
      title: project.meta.title || '未命名排期',
      taskCount: project.tasks.length, leafTaskCount: leafTasks.length,
      summaryTaskCount: ranges.filter(value => value.isSummary).length,
      nodeCount: project.tasks.filter(task => task.type === 'milestone').length,
      pipelineCount: project.tasks.filter(task => task.type === 'pipeline').length,
      flagCount: project.flags.length, groupCount: project.groups.length,
      phaseCount: new Set(project.tasks.map(task => task.phase).filter(Boolean)).size,
      customFieldCount: (project.meta.customFields || []).length,
      dependencyCount: project.tasks.reduce((sum, task) => sum + task.deps.length, 0),
      start: ranges.length ? ranges.reduce((s, value) => value.s < s ? value.s : s, '9999-12-31') : null,
      end: ranges.length ? ranges.reduce((e, value) => value.e > e ? value.e : e, '0100-01-01') : null,
      progress: totalWeight ? Math.round(weighted / totalWeight) : 0,
      criticalPathDays: result.criticalPathDays, hasDependencyCycle: result.hasDependencyCycle,
      criticalTaskCount: result.criticalTaskIds.length, criticalDependencyCount: result.criticalDependencies.length,
      conflictTaskCount: result.conflictTaskIds.length, conflictingDependencyCount: conflicts.length
    },
    criticalTasks: page(project.tasks.filter(task => criticalSet.has(task.id)).map(task => ({ id: task.id, name: task.name, ...index.computed(task) })), args),
    criticalDependencies: page(result.criticalDependencies, args),
    dateConflicts: page(conflicts, args),
    conventions: {
      criticalPath: 'Inclusive calendar-day task durations; summary entry/exit barriers avoid double counting; milestone and pipeline activity durations are zero.',
      dateConflict: 'A successor starts before its predecessor effective end. Equal dates are accepted, matching the UI.',
      progress: 'Duration-weighted progress of leaf task rows, excluding milestone and pipeline rows.',
      pagination: 'offset/limit apply independently to each detail list.'
    }
  };
}

const builtInFields = [
  { id: 'name', property: 'name', name: '名称', type: 'text' },
  { id: 'person', property: 'who', name: '负责人', type: 'text' },
  { id: 'start', property: 's', name: '开始', type: 'date' },
  { id: 'end', property: 'e', name: '结束', type: 'date' },
  { id: 'pct', property: 'pct', name: '进度', type: 'number' },
  { id: 'grp', property: 'grp', name: '职能', type: 'text' },
  { id: 'phase', property: 'phase', name: '阶段', type: 'text' }
];
function executeReadTool(name, args = {}, record) {
  const definition = definitionMap.get(name);
  if (!definition) throw error('UNKNOWN_TOOL', 'Unknown read tool: ' + name);
  keys(args, Object.keys(definition.inputSchema.properties), 'arguments');
  for (const required of definition.inputSchema.required) if (!own(args, required)) invalid('Missing argument: ' + required);
  if (own(definition.inputSchema.properties, 'limit')) pagination(args);
  if (name === 'task.get') text(args.id, 'id', 256, true);
  if (name === 'task.search') text(args.query, 'query', 512, true);
  const safeRecord = publicRecord(record), project = safeRecord.project;
  if (name === 'project.get') return safeRecord;
  if (name === 'project.export') return project;
  if (name === 'group.list') return page(project.groups.map(group => ({ ...group, taskCount: project.tasks.filter(task => task.grp === group.name).length })), args);
  if (name === 'phase.list') {
    const phases = new Map();
    for (const task of project.tasks) if (task.phase) phases.set(task.phase, (phases.get(task.phase) || 0) + 1);
    return page([...phases].map(([phase, taskCount]) => ({ name: phase, taskCount })), args);
  }
  if (name === 'field.list') return page([
    ...builtInFields.map(field => ({ ...field, builtIn: true })),
    ...(project.meta.customFields || []).map(field => ({ ...field, builtIn: false }))
  ], args);
  if (name === 'flag.list') return page(project.flags, args);
  const index = taskIndex(project);
  if (name === 'project.analyze') return analyzeProject(project, args, index);
  if (name === 'task.get') {
    const task = index.byId.get(args.id);
    if (!task) throw error('TASK_NOT_FOUND', 'Task not found: ' + args.id);
    return { ...task, computed: index.computed(task) };
  }
  const filter = checkedFilter(args.filter, project), query = name === 'task.search' ? args.query.toLowerCase() : null;
  const fields = project.meta.customFields || [];
  return page(project.tasks.filter(task => matches(task, index.computed(task), filter) && (!query || searchable(task, fields).includes(query))).map(task => ({ ...task, computed: index.computed(task) })), args);
}

module.exports = { definitions, executeReadTool };
