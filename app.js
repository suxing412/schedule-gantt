'use strict';

/* ============================================================
   排期工具 — 渲染进程核心逻辑  v2
   ============================================================ */

// ---------- 日期工具 ----------
const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, '0');

function toDays(str) {
  const [y, m, d] = str.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}
function fromDays(n) {
  const dt = new Date(n * DAY_MS);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
function dowOf(dayIndex) { return new Date(dayIndex * DAY_MS).getUTCDay(); }
function todayDays() {
  const now = new Date();
  return toDays(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
}
const WD = ['日', '一', '二', '三', '四', '五', '六'];

// ---------- 缩放 ----------
const ZOOM = {
  day: { dw: 32, minor: 'day', major: 'month' },
  week: { dw: 15, minor: 'week', major: 'month' },
  month: { dw: 5, minor: 'month', major: 'year' },
};

const DEFAULT_GROUPS = [
  { name: '设计', color: '#8b5cf6' },
  { name: '开发', color: '#3b82f6' },
  { name: '测试', color: '#10b981' },
  { name: '产品', color: '#f59e0b' },
  { name: '其他', color: '#64748b' },
];

const ROW_H = 38;

// ---------- 状态 ----------
let project = null;
let zoom = 'week';
let selectedId = null;
let saveTimer = null;
let idCounter = 1;

// 分析结果缓存
let criticalSet = new Set();
let conflictSet = new Set();

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};

function uid() {
  return 't' + (idCounter++) + '_' + Math.floor(performance.now() % 100000);
}

// ============================================================
//  示例数据
// ============================================================
function sampleData() {
  const T = todayDays();
  const d = (offset) => fromDays(T + offset);
  const mk = (key, o) => { const id = 'seed_' + key; return { id, ...o }; };

  return {
    tasks: [
      mk('proto', { name: '原型制作', parentId: null, type: 'task', start: d(0), end: d(13), progress: 0, assignee: '张三', group: '设计', deps: [], collapsed: false }),
      mk('attack', { name: '攻击模块', parentId: 'seed_proto', type: 'task', start: d(0), end: d(6), progress: 60, assignee: '张三', group: '设计', deps: [] }),
      mk('move', { name: '移动模块', parentId: 'seed_proto', type: 'task', start: d(7), end: d(12), progress: 20, assignee: '李四', group: '设计', deps: ['seed_attack'] }),
      mk('accept', { name: '原型验收', parentId: 'seed_proto', type: 'milestone', start: d(13), end: d(13), progress: 0, assignee: '王五', group: '产品', deps: ['seed_move'] }),
      mk('dev', { name: '开发实现', parentId: null, type: 'task', start: d(14), end: d(31), progress: 0, assignee: '', group: '开发', deps: [], collapsed: false }),
      mk('fe', { name: '前端开发', parentId: 'seed_dev', type: 'task', start: d(14), end: d(27), progress: 0, assignee: '赵六', group: '开发', deps: ['seed_accept'] }),
      mk('be', { name: '后端开发', parentId: 'seed_dev', type: 'task', start: d(14), end: d(31), progress: 0, assignee: '钱七', group: '开发', deps: ['seed_accept'] }),
      mk('test', { name: '集成测试', parentId: null, type: 'task', start: d(28), end: d(38), progress: 0, assignee: '孙八', group: '测试', deps: ['seed_fe', 'seed_be'] }),
      mk('launch', { name: '正式上线', parentId: null, type: 'milestone', start: d(40), end: d(40), progress: 0, assignee: '', group: '产品', deps: ['seed_test'] }),
    ],
    groups: DEFAULT_GROUPS.slice(),
    meta: { leftWidth: 460 }
  };
}

// ============================================================
//  数据访问
// ============================================================
const byId = (id) => project.tasks.find((t) => t.id === id);
const childrenOf = (id) => project.tasks.filter((t) => t.parentId === id);
const isSummary = (t) => project.tasks.some((c) => c.parentId === t.id);
const groupColor = (name) => (project.groups.find((g) => g.name === name) || {}).color || '#64748b';

function descendants(id, acc = []) {
  for (const c of childrenOf(id)) { acc.push(c); descendants(c.id, acc); }
  return acc;
}
function effectiveRange(t) {
  if (isSummary(t)) {
    const kids = descendants(t.id);
    let s = Infinity, e = -Infinity;
    for (const k of kids) { s = Math.min(s, toDays(k.start)); e = Math.max(e, toDays(k.end)); }
    if (s === Infinity) return { s: toDays(t.start), e: toDays(t.end) };
    return { s, e };
  }
  return { s: toDays(t.start), e: toDays(t.end) };
}
function summaryProgress(t) {
  const leaves = descendants(t.id).filter((k) => !isSummary(k) && k.type !== 'milestone');
  let sum = 0, dur = 0;
  for (const k of leaves) {
    const w = Math.max(1, toDays(k.end) - toDays(k.start) + 1);
    dur += w; sum += w * (k.progress || 0);
  }
  return dur ? Math.round(sum / dur) : 0;
}
function visibleRows() {
  const out = [];
  const walk = (parentId, depth) => {
    for (const t of childrenOf(parentId)) {
      out.push({ task: t, depth });
      if (isSummary(t) && !t.collapsed) walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

// ============================================================
//  关键路径 & 冲突检测
// ============================================================
function runAnalysis() {
  criticalSet = new Set();
  conflictSet = new Set();

  const leafTasks = project.tasks.filter((t) => !isSummary(t) && t.type !== 'milestone');
  if (leafTasks.length === 0) return;

  const idMap = new Map(leafTasks.map((t) => [t.id, t]));
  const dur = (t) => Math.max(1, toDays(t.end) - toDays(t.start) + 1);

  // Forward pass: ES, EF
  const ES = new Map();
  const EF = new Map();
  const sorted = topologicalSort(leafTasks, idMap);
  for (const t of sorted) {
    let es = 0;
    for (const d of (t.deps || [])) {
      if (idMap.has(d)) es = Math.max(es, EF.get(d) || 0);
    }
    ES.set(t.id, es);
    EF.set(t.id, es + dur(t));
  }

  // Backward pass: LF, LS
  const projectEnd = Math.max(...Array.from(EF.values()), 0);
  const LF = new Map();
  const LS = new Map();
  const rev = [...sorted].reverse();
  for (const t of rev) {
    let lf = projectEnd;
    const successors = leafTasks.filter((x) => (x.deps || []).includes(t.id));
    for (const s of successors) {
      lf = Math.min(lf, LS.get(s.id) || projectEnd);
    }
    LF.set(t.id, lf);
    LS.set(t.id, lf - dur(t));
  }

  // Critical: ES == LS (float = 0)
  for (const t of leafTasks) {
    if ((ES.get(t.id) || 0) === (LS.get(t.id) || 0)) {
      criticalSet.add(t.id);
    }
  }

  // Conflicts: task starts before its deps end
  for (const t of project.tasks) {
    if (!t.deps || !t.deps.length) continue;
    const ts = toDays(t.start);
    for (const depId of t.deps) {
      const dep = byId(depId);
      if (!dep) continue;
      const de = toDays(dep.end);
      if (ts < de) { conflictSet.add(t.id); break; }
    }
  }
}

function topologicalSort(leafTasks, idMap) {
  const indeg = new Map(leafTasks.map((t) => [t.id, 0]));
  const adj = new Map(leafTasks.map((t) => [t.id, []]));
  for (const t of leafTasks) {
    for (const d of (t.deps || [])) {
      if (idMap.has(d)) {
        adj.get(d).push(t.id);
        indeg.set(t.id, (indeg.get(t.id) || 0) + 1);
      }
    }
  }
  const q = leafTasks.filter((t) => indeg.get(t.id) === 0);
  const res = [];
  while (q.length) {
    const n = q.shift();
    res.push(n);
    for (const s of (adj.get(n.id) || [])) {
      indeg.set(s, indeg.get(s) - 1);
      if (indeg.get(s) === 0) q.push(leafTasks.find((x) => x.id === s));
    }
  }
  return res.length === leafTasks.length ? res : leafTasks;
}

// ============================================================
//  时间轴
// ============================================================
function computeBounds(rows) {
  let min = Infinity, max = -Infinity;
  for (const { task } of rows) {
    const { s, e } = effectiveRange(task);
    min = Math.min(min, s); max = Math.max(max, e);
  }
  const T = todayDays();
  if (min === Infinity) { min = T; max = T + 30; }
  min = Math.min(min, T); max = Math.max(max, T);
  min -= 7; max += 10;
  return { min, max };
}

function buildAxis(min, max, zoomKey) {
  const { dw, minor, major } = ZOOM[zoomKey];
  const T = todayDays();
  const minorSegs = [];
  const majorSegs = [];

  if (minor === 'day') {
    for (let d = min; d <= max; d++) {
      const dowd = dowOf(d);
      minorSegs.push({ x: (d - min) * dw, w: dw, label: String(new Date(d * DAY_MS).getUTCDate()), sub: WD[dowd], weekend: dowd === 0 || dowd === 6, today: d === T });
    }
  } else if (minor === 'week') {
    let d = min;
    while (d <= max) {
      let end = d;
      while (end < max && dowOf(end + 1) !== 1) end++;
      const dt = new Date(d * DAY_MS);
      minorSegs.push({ x: (d - min) * dw, w: (end - d + 1) * dw, label: `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`, today: T >= d && T <= end });
      d = end + 1;
    }
  } else {
    let d = min;
    while (d <= max) {
      const dt = new Date(d * DAY_MS);
      const y = dt.getUTCFullYear(), m = dt.getUTCMonth();
      let end = d;
      while (end < max) {
        const nx = new Date((end + 1) * DAY_MS);
        if (nx.getUTCFullYear() !== y || nx.getUTCMonth() !== m) break;
        end++;
      }
      minorSegs.push({ x: (d - min) * dw, w: (end - d + 1) * dw, label: `${m + 1}月`, today: T >= d && T <= end });
      d = end + 1;
    }
  }

  const majorKey = (dt) => major === 'month' ? `${dt.getUTCFullYear()}-${dt.getUTCMonth()}` : `${dt.getUTCFullYear()}`;
  const majorLabel = (dt) => major === 'month' ? `${dt.getUTCFullYear()}年${dt.getUTCMonth() + 1}月` : `${dt.getUTCFullYear()}年`;
  let curKey = null, segStart = min;
  for (let d = min; d <= max + 1; d++) {
    const atEnd = d > max;
    const k = atEnd ? null : majorKey(new Date(d * DAY_MS));
    if (k !== curKey) {
      if (curKey !== null) majorSegs.push({ x: (segStart - min) * dw, w: (d - segStart) * dw, label: majorLabel(new Date(segStart * DAY_MS)) });
      curKey = k; segStart = d;
    }
  }
  return { dw, minorSegs, majorSegs, totalWidth: (max - min + 1) * dw };
}

// ============================================================
//  渲染主入口
// ============================================================
let axis = null;
let bounds = null;
let barPos = {};

function render() {
  const rows = visibleRows();
  bounds = computeBounds(rows);
  axis = buildAxis(bounds.min, bounds.max, zoom);
  barPos = {};
  runAnalysis();

  renderLegend();
  renderLeft(rows);
  renderTimelineHeader();
  renderBody(rows);
}

function renderLegend() {
  const box = $('#legend');
  box.innerHTML = '<span class="legend-item">分组：</span>';
  for (const g of project.groups) {
    const item = el('div', 'legend-item');
    const sw = el('span', 'legend-swatch'); sw.style.background = g.color;
    item.appendChild(sw); item.appendChild(el('span', null, g.name));
    box.appendChild(item);
  }
  box.appendChild(el('div', 'legend-item', '◆ 里程碑')).style.color = '#f43f5e';
  const cp = el('div', 'legend-item', '◆ 关键路径');
  cp.style.color = '#ef4444'; cp.style.fontWeight = '600';
  box.appendChild(cp);
}

function renderLeft(rows) {
  const body = $('#left-body');
  body.innerHTML = '';
  if (!rows.length) return void body.appendChild(el('div', 'empty-hint', '暂无任务，点击上方"＋ 任务"新增'));

  for (const { task, depth } of rows) {
    const row = el('div', 'task-row');
    row.dataset.id = task.id;
    if (task.id === selectedId) row.classList.add('selected');
    if (criticalSet.has(task.id)) row.classList.add('critical');
    if (conflictSet.has(task.id)) row.classList.add('conflict');
    const summary = isSummary(task);
    if (summary) row.classList.add('is-summary');

    const nameCol = el('div', 'col col-name');
    nameCol.style.paddingLeft = (8 + depth * 16) + 'px';
    const tw = el('span', 'twisty' + (summary ? '' : ' empty'), summary ? (task.collapsed ? '▶' : '▼') : '');
    if (summary) tw.addEventListener('click', (ev) => { ev.stopPropagation(); task.collapsed = !task.collapsed; render(); scheduleSave(); });
    nameCol.appendChild(tw);
    const dot = el('span', 'type-dot');
    dot.textContent = task.type === 'milestone' ? '◆' : (summary ? '▣' : '▬');
    dot.style.color = task.type === 'milestone' ? '#f43f5e' : (summary ? '#475569' : groupColor(task.group));
    nameCol.appendChild(dot);
    const nameSpan = el('span', 'task-name-text', task.name);
    nameCol.appendChild(nameSpan);
    if (conflictSet.has(task.id)) {
      const warn = el('span', 'conflict-badge', '⚠');
      nameCol.appendChild(warn);
    }
    row.appendChild(nameCol);
    row.appendChild(el('div', 'col col-assignee', task.assignee || '—'));
    const rng = summary ? effectiveRange(task) : { s: toDays(task.start), e: toDays(task.end) };
    row.appendChild(el('div', 'col col-date', fmtShort(rng.s)));
    row.appendChild(el('div', 'col col-date', task.type === 'milestone' ? '—' : fmtShort(rng.e)));
    const prog = summary ? summaryProgress(task) : (task.progress || 0);
    row.appendChild(el('div', 'col col-prog', task.type === 'milestone' ? '—' : prog + '%'));

    row.addEventListener('click', () => selectTask(task.id));
    row.addEventListener('dblclick', () => openEditor(task.id));
    body.appendChild(row);
  }
}

function fmtShort(dayIndex) {
  const dt = new Date(dayIndex * DAY_MS);
  return `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
}

function renderTimelineHeader() {
  const hd = $('#timeline-header');
  hd.innerHTML = '';
  hd.style.width = axis.totalWidth + 'px';
  const top = el('div', 'tl-row tl-row-top');
  for (const m of axis.majorSegs) {
    const c = el('div', 'tl-cell month-cell', m.label); c.style.width = m.w + 'px'; top.appendChild(c);
  }
  const bot = el('div', 'tl-row tl-row-bot');
  for (const s of axis.minorSegs) {
    const c = el('div', 'tl-cell', zoom === 'day' ? `${s.label}` : s.label);
    c.style.width = s.w + 'px';
    if (s.weekend) c.classList.add('weekend');
    if (s.today) c.classList.add('is-today');
    if (zoom === 'day') c.title = s.sub;
    bot.appendChild(c);
  }
  hd.appendChild(top); hd.appendChild(bot);
}

function renderBody(rows) {
  const tb = $('#timeline-body');
  const barsLayer = $('#bars-layer');
  const depLayer = $('#dep-layer');
  const totalH = Math.max(rows.length * ROW_H, 200);

  tb.style.width = axis.totalWidth + 'px';
  tb.style.height = totalH + 'px';
  barsLayer.style.width = axis.totalWidth + 'px';
  barsLayer.style.height = totalH + 'px';
  barsLayer.innerHTML = '';

  // 网格
  for (const s of axis.minorSegs) {
    const col = el('div', 'grid-col' + (s.weekend ? ' weekend' : ''));
    col.style.left = s.x + 'px'; col.style.width = s.w + 'px'; col.style.height = totalH + 'px';
    barsLayer.appendChild(col);
  }

  // 今日
  const T = todayDays();
  if (T >= bounds.min && T <= bounds.max) {
    const line = el('div', 'today-line');
    line.style.left = ((T - bounds.min) * axis.dw + axis.dw / 2) + 'px';
    line.style.height = totalH + 'px';
    barsLayer.appendChild(line);
  }

  // 任务条
  rows.forEach(({ task }, i) => {
    const y = i * ROW_H;
    const summary = isSummary(task);
    if (task.type === 'milestone') renderMilestone(barsLayer, task, y);
    else renderBar(barsLayer, task, y, summary);
  });

  drawDeps(depLayer, rows, totalH);
  bindEmptyAreaDblClick(tb);
}

function renderBar(layer, task, y, summary) {
  const rng = summary ? effectiveRange(task) : { s: toDays(task.start), e: toDays(task.end) };
  const x = (rng.s - bounds.min) * axis.dw;
  const w = Math.max((rng.e - rng.s + 1) * axis.dw, 6);
  const barH = summary ? 12 : 20;
  const top = y + (ROW_H - barH) / 2;

  barPos[task.id] = { x, y: top, w, h: barH, cy: top + barH / 2, type: summary ? 'summary' : 'task' };

  const bar = el('div', 'bar' + (summary ? ' summary' : ''));
  bar.dataset.id = task.id;
  bar.style.left = x + 'px';
  bar.style.top = top + 'px';
  bar.style.width = w + 'px';
  if (!summary) bar.style.background = groupColor(task.group);
  if (task.id === selectedId) bar.classList.add('selected');
  if (criticalSet.has(task.id)) bar.classList.add('critical-bar');
  if (conflictSet.has(task.id)) bar.classList.add('conflict-bar');

  if (!summary) {
    const prog = task.progress || 0;
    if (prog > 0) {
      const pf = el('div', 'bar-progress'); pf.style.width = prog + '%'; bar.appendChild(pf);
    }
    const lbl = el('span', 'bar-label', task.name);
    bar.appendChild(lbl);
    bar.appendChild(makeHandle('left'));
    bar.appendChild(makeHandle('right'));
    if (w < 44) {
      lbl.style.display = 'none';
      const out = el('div', 'bar-outside-label', task.name + (prog ? ` (${prog}%)` : ''));
      out.style.left = (x + w + 6) + 'px'; out.style.top = top + 'px'; out.style.height = barH + 'px';
      layer.appendChild(out);
    }
    if (conflictSet.has(task.id)) {
      const warn = el('div', 'bar-conflict-icon', '⚠');
      warn.style.left = (x + w + 4) + 'px'; warn.style.top = (top - 6) + 'px';
      warn.title = '存在工期冲突：任务开始于其依赖任务结束之前';
      layer.appendChild(warn);
    }
  } else {
    const out = el('div', 'bar-outside-label', task.name);
    out.style.left = (x + w + 8) + 'px'; out.style.top = (top - 3) + 'px'; out.style.fontWeight = '700';
    layer.appendChild(out);
  }

  bar.addEventListener('mousedown', (e) => {
    if (e.ctrlKey) startDepDrag(e, task); else startBarDrag(e, task, summary);
  });
  bar.addEventListener('click', (e) => { e.stopPropagation(); selectTask(task.id); });
  bar.addEventListener('dblclick', (e) => { e.stopPropagation(); openEditor(task.id); });
  layer.appendChild(bar);
}

function makeHandle(side) {
  const h = el('div', 'bar-handle ' + side);
  h.dataset.handle = side;
  return h;
}

function renderMilestone(layer, task, y) {
  const d = toDays(task.start);
  const cx = (d - bounds.min) * axis.dw + axis.dw / 2;
  const size = 16;
  const top = y + (ROW_H - size) / 2;
  barPos[task.id] = { x: cx - size / 2, y: top, w: size, h: size, cy: top + size / 2, cx, type: 'milestone' };

  const dia = el('div', 'milestone');
  dia.dataset.id = task.id;
  dia.style.left = (cx - size / 2) + 'px';
  dia.style.top = top + 'px';
  dia.style.background = groupColor(task.group) || '#f43f5e';
  if (task.id === selectedId) dia.classList.add('selected');
  dia.addEventListener('mousedown', (e) => {
    if (e.ctrlKey) startDepDrag(e, task); else startMilestoneDrag(e, task);
  });
  dia.addEventListener('click', (e) => { e.stopPropagation(); selectTask(task.id); });
  dia.addEventListener('dblclick', (e) => { e.stopPropagation(); openEditor(task.id); });
  layer.appendChild(dia);

  const lbl = el('div', 'milestone-label', `${task.name}（${fmtShort(d)}）`);
  lbl.style.left = (cx + size / 2 + 6) + 'px';
  lbl.style.top = top + 'px'; lbl.style.height = size + 'px';
  layer.appendChild(lbl);
}

// ---------- 依赖连线 ----------
function drawDeps(canvas, rows, totalH) {
  const W = axis.totalWidth;
  const H = totalH;

  canvas.width = W;
  canvas.height = H;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');

  const vis = new Set(rows.map((r) => r.task.id));
  for (const { task } of rows) {
    if (!task.deps || !task.deps.length) continue;
    const to = barPos[task.id]; if (!to) continue;
    for (const depId of task.deps) {
      if (!vis.has(depId)) continue;
      const from = barPos[depId]; if (!from) continue;
      const crit = criticalSet.has(task.id) && criticalSet.has(depId);

      const x1 = from.x + from.w;     // from 右边缘
      const y1 = from.cy;
      const x2 = to.type === 'milestone' ? to.cx : to.x;   // to 左边缘
      const y2 = to.cy;

      // 两端各留一段直线，只在中间用贝塞尔弯折，保证出入平滑
      const totalDx = x2 - x1;
      const straightRun = Math.min(28, Math.max(10, totalDx * 0.15)); // 直线段 10~28px
      const p0x = x1 + straightRun;   // 直线结束，曲线开始
      const p3x = x2 - straightRun;   // 曲线结束，直线开始

      ctx.beginPath();
      ctx.strokeStyle = crit ? '#ef4444' : '#64748b';
      ctx.lineWidth = crit ? 2.5 : 1.5;
      ctx.setLineDash(crit ? [8, 3] : [6, 5]);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // 1) from 右端 → 直线到 p0x
      ctx.moveTo(x1, y1);
      ctx.lineTo(p0x, y1);
      // 2) 中间贝塞尔弯折（控制点沿水平方向延伸）
      const cpLen = Math.max(Math.abs(p3x - p0x) * 0.45, 20);
      ctx.bezierCurveTo(p0x + cpLen, y1, p3x - cpLen, y2, p3x, y2);
      // 3) 直线到 to 左端
      ctx.lineTo(x2 - 7, y2);
      ctx.stroke();
      ctx.setLineDash([]);

      // 箭头三角形
      const ax = x2 - 7, ay = y2, sz = 7;
      ctx.beginPath();
      ctx.fillStyle = crit ? '#ef4444' : '#64748b';
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - sz, ay - sz * 0.6);
      ctx.lineTo(ax - sz, ay + sz * 0.6);
      ctx.closePath();
      ctx.fill();
    }
  }
}

// ============================================================
//  Ctrl+拖拽建立依赖
// ============================================================
function startDepDrag(e, fromTask) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const canvas = $('#dep-layer');
  const from = barPos[fromTask.id];
  if (!from) return;

  // 保存当前画布内容（同步）
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  document.body.style.cursor = 'crosshair';

  const onMove = (ev) => {
    // 恢复原内容
    ctx.putImageData(imageData, 0, 0);
    const x1 = from.x + from.w, y1 = from.cy;
    const rect = canvas.getBoundingClientRect();
    const right = $('#gantt-right');
    const sx = right.scrollLeft;
    const x2 = ev.clientX - rect.left + sx;
    const y2 = ev.clientY - rect.top + right.scrollTop;

    const totalDx = x2 - x1;
    const straightRun = Math.min(28, Math.max(10, totalDx * 0.15));
    const p0x = x1 + straightRun;
    const p3x = x2 - straightRun;
    const cpLen = Math.max(Math.abs(p3x - p0x) * 0.45, 20);

    ctx.beginPath();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2.5;
    ctx.setLineDash([8, 4]);
    ctx.moveTo(x1, y1);
    ctx.lineTo(p0x, y1);
    ctx.bezierCurveTo(p0x + cpLen, y1, p3x - cpLen, y2, p3x, y2);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
  };

  const onUp = (ev) => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    // 恢复原画布
    ctx.putImageData(imageData, 0, 0);

    let toId = null;
    const elFromPoint = document.elementFromPoint(ev.clientX, ev.clientY);
    if (elFromPoint) {
      const bar = elFromPoint.closest('.bar, .milestone');
      if (bar && bar.dataset && bar.dataset.id) toId = bar.dataset.id;
    }

    if (!toId || toId === fromTask.id) { render(); return; }
    const toTask = byId(toId);
    if (!toTask) { render(); return; }

    // 防环
    if (descendants(toId).some((d) => d.id === fromTask.id)) { render(); return; }
    if (fromTask.deps && fromTask.deps.includes(toId)) { render(); return; }
    if (toTask.deps && toTask.deps.includes(fromTask.id)) { render(); return; }

    if (!toTask.deps) toTask.deps = [];
    if (!toTask.deps.includes(fromTask.id)) {
      toTask.deps.push(fromTask.id);
      render();
      scheduleSave();
      flashStatus(`已建立依赖：${fromTask.name} → ${toTask.name}`);
    } else {
      render();
    }
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ============================================================
//  双击空白处新建任务
// ============================================================
function bindEmptyAreaDblClick(tb) {
  tb.addEventListener('dblclick', (e) => {
    // 只在 bars/dep layer（空白区）触发，不在具体 bar/milestone 上
    const el = e.target;
    if (el.closest('.bar') || el.closest('.milestone') || el.closest('.grid-col') || el.closest('.today-line')) return;
    const rect = tb.getBoundingClientRect();
    const offsetX = e.clientX - rect.left + tb.scrollLeft;
    const day = Math.round(offsetX / axis.dw) + bounds.min;
    const T = todayDays();
    const t = {
      id: uid(),
      name: '新任务',
      parentId: null,
      type: 'task',
      start: fromDays(Math.max(T, day)),
      end: fromDays(Math.max(T, day) + 4),
      progress: 0,
      assignee: '',
      group: project.groups[0] ? project.groups[0].name : '其他',
      deps: [],
      collapsed: false,
    };
    project.tasks.push(t);
    selectedId = t.id;
    render();
    scheduleSave();
    openEditor(t.id);
  });
}

// ============================================================
//  选中 / 拖拽
// ============================================================
function selectTask(id) { selectedId = id; render(); }

function startBarDrag(e, task, summary) {
  if (e.button !== 0) return;
  const handle = e.target.dataset.handle;
  selectedId = task.id;
  const startX = e.clientX;
  const origS = toDays(task.start), origE = toDays(task.end);
  const desc = summary ? descendants(task.id) : [];
  const descOrig = desc.map((d) => ({ t: d, s: toDays(d.start), e: toDays(d.end) }));
  const mode = summary ? 'move' : (handle || 'move');
  document.body.style.cursor = mode === 'move' ? 'grabbing' : 'ew-resize';

  const onMove = (ev) => {
    const delta = Math.round((ev.clientX - startX) / axis.dw);
    if (summary) {
      for (const o of descOrig) { o.t.start = fromDays(o.s + delta); o.t.end = fromDays(o.e + delta); }
    } else if (mode === 'move') {
      task.start = fromDays(origS + delta); task.end = fromDays(origE + delta);
    } else if (mode === 'left') {
      task.start = fromDays(Math.min(origS + delta, origE));
    } else if (mode === 'right') {
      task.end = fromDays(Math.max(origE + delta, origS));
    }
    render();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    scheduleSave();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  e.preventDefault();
}

function startMilestoneDrag(e, task) {
  if (e.button !== 0) return;
  selectedId = task.id;
  const startX = e.clientX;
  const origS = toDays(task.start);
  document.body.style.cursor = 'grabbing';
  const onMove = (ev) => {
    const delta = Math.round((ev.clientX - startX) / axis.dw);
    task.start = fromDays(origS + delta); task.end = task.start;
    render();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    scheduleSave();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  e.preventDefault();
}

// ============================================================
//  编辑面板
// ============================================================
let editingId = null;

function openEditor(id) {
  const t = byId(id);
  if (!t) return;
  editingId = id;
  const summary = isSummary(t);

  $('#editor-title').textContent = summary ? '编辑父任务' : '编辑任务';
  $('#f-name').value = t.name;
  $('#f-type').value = t.type;
  $('#f-type').disabled = summary;
  $('#f-assignee').value = t.assignee || '';

  const gsel = $('#f-group'); gsel.innerHTML = '';
  for (const g of project.groups) {
    const o = el('option', null, g.name);
    o.value = g.name; if (g.name === t.group) o.selected = true;
    gsel.appendChild(o);
  }

  $('#f-start').value = t.start;
  $('#f-end').value = t.end;
  $('#f-progress').value = t.progress || 0;
  $('#f-prog-val').textContent = t.progress || 0;

  const banned = new Set([id, ...descendants(id).map((d) => d.id)]);
  const list = $('#f-deps-list'); list.innerHTML = '';
  const candidates = project.tasks.filter((x) => !banned.has(x.id));
  if (!candidates.length) list.appendChild(el('div', 'f-deps-label', '（无可选前置任务）'));
  for (const c of candidates) {
    const item = el('label', 'f-dep-item');
    const cb = el('input'); cb.type = 'checkbox'; cb.value = c.id;
    cb.checked = (t.deps || []).includes(c.id);
    item.appendChild(cb); item.appendChild(el('span', null, c.name));
    list.appendChild(item);
  }

  applyTypeVisibility(t.type === 'milestone' || summary);
  $('#editor-overlay').hidden = false;
}

function applyTypeVisibility() {
  const isMs = $('#f-type').value === 'milestone';
  $('.f-end-wrap').style.display = isMs ? 'none' : '';
  $('.f-prog-wrap').style.display = isMs ? 'none' : '';
  $('.f-start-wrap').firstChild.nodeValue = isMs ? '日期' : '开始';
}

function closeEditor() { $('#editor-overlay').hidden = true; editingId = null; }

function saveEditor() {
  const t = byId(editingId);
  if (!t) return closeEditor();
  t.name = $('#f-name').value.trim() || '未命名任务';
  if (!$('#f-type').disabled) t.type = $('#f-type').value;
  t.assignee = $('#f-assignee').value.trim();
  t.group = $('#f-group').value;
  t.start = $('#f-start').value || t.start;
  if (t.type === 'milestone') { t.end = t.start; t.progress = 0; }
  else {
    t.end = $('#f-end').value || t.end;
    if (toDays(t.end) < toDays(t.start)) t.end = t.start;
    t.progress = Number($('#f-progress').value);
  }
  t.deps = Array.from($('#f-deps-list').querySelectorAll('input:checked')).map((c) => c.value);
  closeEditor();
  render();
  scheduleSave();
}

// ============================================================
//  任务增删
// ============================================================
function addTask(parentId = null, type = 'task') {
  const T = todayDays();
  const t = {
    id: uid(),
    name: type === 'milestone' ? '新里程碑' : '新任务',
    parentId, type,
    start: fromDays(T), end: fromDays(T + (type === 'milestone' ? 0 : 4)),
    progress: 0, assignee: '',
    group: project.groups[0] ? project.groups[0].name : '其他',
    deps: [], collapsed: false,
  };
  if (parentId) { const p = byId(parentId); if (p) p.collapsed = false; }
  project.tasks.push(t);
  selectedId = t.id;
  render();
  scheduleSave();
  openEditor(t.id);
}

function addChild() {
  if (!selectedId) { alert('请先在左侧选择一个任务，再添加子任务'); return; }
  addTask(selectedId, 'task');
}

function deleteSelected() {
  if (!selectedId) { alert('请先选择要删除的任务'); return; }
  const t = byId(selectedId);
  if (!t) return;
  const kids = descendants(selectedId);
  const msg = kids.length ? `删除「${t.name}」及其 ${kids.length} 个子任务？` : `删除「${t.name}」？`;
  if (!confirm(msg)) return;
  const removeIds = new Set([selectedId, ...kids.map((k) => k.id)]);
  project.tasks = project.tasks.filter((x) => !removeIds.has(x.id));
  for (const x of project.tasks) { if (x.deps) x.deps = x.deps.filter((d) => !removeIds.has(d)); }
  selectedId = null;
  render();
  scheduleSave();
}

// ============================================================
//  持久化
// ============================================================
function scheduleSave() { setSaveStatus(true); clearTimeout(saveTimer); saveTimer = setTimeout(doSave, 500); }
async function doSave() {
  if (project.meta) project.meta.leftWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--left-w')) || 460;
  await window.api.save(project);
  setSaveStatus(false);
}
function setSaveStatus(dirty) {
  const s = $('#save-status');
  s.textContent = dirty ? '未保存…' : '已保存';
  s.classList.toggle('dirty', dirty);
}

async function loadData() {
  const data = await window.api.load();
  if (data && Array.isArray(data.tasks)) {
    project = data;
    if (!project.groups || !project.groups.length) project.groups = DEFAULT_GROUPS.slice();
    if (!project.meta) project.meta = { leftWidth: 460 };
  } else {
    project = sampleData();
  }
  if (project.meta && project.meta.leftWidth) document.documentElement.style.setProperty('--left-w', project.meta.leftWidth + 'px');
}

// ============================================================
//  PNG 导出
// ============================================================
async function exportPNG() {
  flashStatus('正在导出…');
  try {
    const r = await window.api.capturePage();
    if (r && r.ok && r.filePath) flashStatus('已导出: ' + r.filePath.split('\\').pop());
    else if (!r.canceled) alert('导出图片失败');
  } catch (e) {
    alert('导出图片失败: ' + e.message);
  }
}

// ============================================================
//  事件绑定
// ============================================================
function bindUI() {
  $('#btn-add-task').addEventListener('click', () => addTask(null, 'task'));
  $('#btn-add-child').addEventListener('click', addChild);
  $('#btn-add-milestone').addEventListener('click', () => addTask(selectedId || null, 'milestone'));
  $('#btn-delete').addEventListener('click', deleteSelected);
  $('#btn-today').addEventListener('click', scrollToToday);
  $('#btn-png').addEventListener('click', exportPNG);

  $('#zoom-seg').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    zoom = b.dataset.zoom;
    document.querySelectorAll('#zoom-seg .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    render();
  });

  $('#btn-export').addEventListener('click', async () => {
    const r = await window.api.export(project);
    if (r && r.ok) flashStatus('已导出');
  });
  $('#btn-import').addEventListener('click', async () => {
    const r = await window.api.import();
    if (r && r.ok && r.data && Array.isArray(r.data.tasks)) {
      project = r.data;
      if (!project.groups) project.groups = DEFAULT_GROUPS.slice();
      if (!project.meta) project.meta = { leftWidth: 460 };
      selectedId = null;
      render();
      scheduleSave();
      flashStatus('已导入');
    } else if (r && !r.canceled) { alert('导入失败：文件格式不正确'); }
  });

  $('#editor-close').addEventListener('click', closeEditor);
  $('#editor-cancel').addEventListener('click', closeEditor);
  $('#editor-save').addEventListener('click', saveEditor);
  $('#f-type').addEventListener('change', applyTypeVisibility);
  $('#f-progress').addEventListener('input', (e) => { $('#f-prog-val').textContent = e.target.value; });
  $('#editor-overlay').addEventListener('click', (e) => { if (e.target.id === 'editor-overlay') closeEditor(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#editor-overlay').hidden) closeEditor();
    if (e.key === 'Delete' && $('#editor-overlay').hidden && selectedId) deleteSelected();
  });

  // 滚动同步
  const left = $('#left-body');
  const right = $('#gantt-right');
  let syncing = false;
  right.addEventListener('scroll', () => { if (syncing) return; syncing = true; left.scrollTop = right.scrollTop; syncing = false; });
  left.addEventListener('scroll', () => { if (syncing) return; syncing = true; right.scrollTop = left.scrollTop; syncing = false; });

  bindSplitter();
  bindWheelPan(right);
}

function flashStatus(txt) {
  const s = $('#save-status');
  s.textContent = txt; s.classList.remove('dirty');
  setTimeout(() => setSaveStatus(false), 2000);
}

function scrollToToday() {
  const T = todayDays();
  const x = (T - bounds.min) * axis.dw;
  const right = $('#gantt-right');
  right.scrollLeft = Math.max(0, x - right.clientWidth / 2);
}

function bindSplitter() {
  const sp = $('#splitter');
  sp.addEventListener('mousedown', (e) => {
    const startX = e.clientX;
    const startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--left-w')) || 460;
    const onMove = (ev) => {
      const w = Math.max(240, Math.min(760, startW + (ev.clientX - startX)));
      document.documentElement.style.setProperty('--left-w', w + 'px');
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); scheduleSave(); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
}

function bindWheelPan(right) {
  right.addEventListener('wheel', (e) => {
    if (e.shiftKey && e.deltaY !== 0) { right.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });
}

// ============================================================
//  启动
// ============================================================
(async function init() {
  await loadData();
  bindUI();
  render();
  setTimeout(scrollToToday, 50);
})();
