'use strict';

// One catalog for the HTTP/OpenAPI/MCP adapters and the pure operation engine.
const string = (maxLength, extra = {}) => ({ type: 'string', maxLength, ...extra });
const id = string(256, { minLength: 1 });
const date = string(10, { pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const color = string(7, { pattern: '^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$' });
const array = (items, maxItems = 10000, extra = {}) => ({ type: 'array', items, maxItems, ...extra });
const object = (properties, required = [], extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra });
const ids = array(id, 10000, { minItems: 1, uniqueItems: true });
const parentId = { anyOf: [id, { type: 'null' }] };
const values = { type: 'object', propertyNames: { pattern: '^cf_[A-Za-z0-9_-]{1,64}$' }, additionalProperties: { anyOf: [{ type: 'string', maxLength: 4096 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] } };
const taskProperties = {
  name: string(2048, { minLength: 1 }), type: { enum: ['task', 'milestone', 'pipeline'] },
  s: date, e: date, pct: { type: 'number', minimum: 0, maximum: 100 },
  who: string(512), grp: string(256), phase: string(512), flow: { type: 'boolean' },
  lane: { type: 'integer', minimum: 0, maximum: 10000 }, customValues: values
};
const task = object({ id, pid: parentId, ...taskProperties, deps: array(id, 10000, { uniqueItems: true }) }, ['id', 'name', 's', 'e']);
const option = object({ id: string(67, { pattern: '^fo_[A-Za-z0-9_-]{1,64}$' }), label: string(128, { minLength: 1 }) }, ['id', 'label']);
const fieldId = string(67, { pattern: '^cf_[A-Za-z0-9_-]{1,64}$' });
const field = object({ id: fieldId, name: string(128, { minLength: 1 }), type: { enum: ['text', 'number', 'date', 'select', 'checkbox'] }, options: array(option, 100, { minItems: 1 }) }, ['id', 'name', 'type']);
const flag = object({ id, name: string(2048, { minLength: 1 }), d: date, color }, ['id', 'name', 'd']);
const days = { type: 'integer', minimum: -36500, maximum: 36500 };
const roleName = string(256, { minLength: 1 });
const defs = [];
function define(name, description, inputSchema, destructiveHint = false) { defs.push({ name, description, inputSchema, destructiveHint }); }

define('project.update', '修改共享排期标题；视图、列宽和折叠属于个人界面状态，不写入共享数据。', object({ patch: object({ title: string(512) }, [], { minProperties: 1 }) }, ['patch']));
define('project.replace', '用完整 JSON 导入或恢复排期，替换全部共享内容；须显式传 confirm:true。不会更改排期链接、权限或版本规则。', object({ project: { type: 'object', additionalProperties: true }, confirm: { const: true } }, ['project', 'confirm']), true);
define('project.shift', '按自然日平移整个排期的全部任务和全局里程碑；正数后移、负数前移。', object({ days }, ['days']));
define('task.add', '添加任务、子任务、管线或重要节点。ID 由调用者指定；pid 指向父任务；beforeId 可指定同层插入位置，省略追加。', object({ task, beforeId: id }, ['task']));
define('task.update', '修改任务名称、类型、日期、进度、负责人、职能、阶段、流程泳道或自定义值。patch.customValues 整体替换；局部字段值请用 field.values.set。父任务日期和进度来自子任务，请用 task.shift 平移。', object({ id, patch: object(taskProperties, [], { minProperties: 1 }) }, ['id', 'patch']));
define('task.remove', '删除指定任务。默认遇到子任务时报错；cascade:true 才会连同所有后代删除。会清理剩余任务指向已删除项的依赖。', object({ ids, cascade: { type: 'boolean', default: false } }, ['ids']), true);
define('task.move', '调整父子归属及同层位置。parentId:null 移到顶层；beforeId 省略时移到目标同层最后。不会移动日期。', object({ id, parentId, beforeId: id }, ['id', 'parentId']));
define('task.reorder', '调整指定父级的全部直接子项顺序。ids 必须恰好包含该父级每个子项一次，不改变父子关系。', object({ parentId, ids: array(id, 10000, { uniqueItems: true }) }, ['parentId', 'ids']));
define('task.shift', '按自然日平移所选任务。includeDescendants 默认 true，重叠选择的后代只平移一次；不自动平移依赖任务或全局里程碑。', object({ ids, days, includeDescendants: { type: 'boolean', default: true } }, ['ids', 'days']));
define('task.duplicate', '复制指定任务及其完整子树；idMap 必须为每个原任务提供一个全新 ID。内部依赖重映射，外部依赖保留；parentId 可改变副本根的父级。', object({ id, idMap: { type: 'object', minProperties: 1, maxProperties: 10000, additionalProperties: id }, parentId }, ['id', 'idMap']));
define('dependency.add', '给 taskId 添加前置任务 dependsOn；重复添加不重复写入。拒绝自身、管线及所有显式/隐式依赖环。', object({ taskId: id, dependsOn: id }, ['taskId', 'dependsOn']));
define('dependency.remove', '移除 taskId 的一个前置依赖；不存在的依赖按无变化处理。', object({ taskId: id, dependsOn: id }, ['taskId', 'dependsOn']));
define('dependency.set', '整体替换指定任务的前置依赖列表；空数组表示清空。', object({ taskId: id, deps: array(id, 10000, { uniqueItems: true }) }, ['taskId', 'deps']));
define('role.add', '添加职能及颜色；已隐藏的默认职能可以重新添加。', object({ name: roleName, color }, ['name', 'color']));
define('role.update', '重命名职能或修改颜色；同步更新全部任务的职能引用。', object({ name: roleName, patch: object({ name: roleName, color }, [], { minProperties: 1 }) }, ['name', 'patch']));
define('role.remove', '删除职能。仍被任务使用时须提供 replacement（另一现有职能或空字符串），否则拒绝删除。', object({ name: roleName, replacement: string(256) }, ['name']), true);
define('phase.rename', '重命名阶段并同步其所有任务；目标名称已存在时合并两个阶段。新阶段可直接通过 task.update 的 phase 创建。', object({ name: string(512, { minLength: 1 }), newName: string(512, { minLength: 1 }) }, ['name', 'newName']));
define('phase.remove', '清除指定阶段的全部任务标签，不删除任务。', object({ name: string(512, { minLength: 1 }) }, ['name']), true);
define('field.add', '添加文本、数字、日期、单选或勾选字段。单选须提供 options；每个字段/选项使用稳定 ID。', object({ field }, ['field']));
define('field.update', '修改字段名称及单选选项。字段类型固定；移除选项会清理任务上该选项的值，其余稳定 ID 不变。', object({ id: fieldId, patch: object({ name: string(128, { minLength: 1 }), options: array(option, 100, { minItems: 1 }) }, [], { minProperties: 1 }) }, ['id', 'patch']));
define('field.remove', '删除自定义字段及全部任务上该字段的值。', object({ id: fieldId }, ['id']), true);
define('field.values.set', '局部设置一个任务的自定义字段值；未提及的字段保留，null 清除对应值。值类型必须匹配字段定义。', object({ taskId: id, values }, ['taskId', 'values']));
define('flag.add', '添加时间轴顶部的全局里程碑（不占任务行）；与 task.type=milestone 的重要节点不同。', object({ flag }, ['flag']));
define('flag.update', '修改全局里程碑的名称、日期或颜色。', object({ id, patch: object({ name: string(2048, { minLength: 1 }), d: date, color }, [], { minProperties: 1 }) }, ['id', 'patch']));
define('flag.remove', '删除一个全局里程碑。', object({ id }, ['id']), true);

module.exports = defs;
