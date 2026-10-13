'use strict';

// 全局错误捕获 — 把错误直接显示在页面上
window.onerror = function(msg, src, line, col, err) {
  const box = document.getElementById('g-left-body');
  if (!box) return;
  const panel = document.createElement('div');
  Object.assign(panel.style, {
    padding: '20px', color: '#f53f3f', fontFamily: 'monospace',
    fontSize: '12px', lineHeight: '1.8'
  });
  const title = document.createElement('b');
  title.textContent = '⚠ 脚本错误';
  panel.appendChild(title);
  const addLine = (label, value) => {
    const row = document.createElement('div');
    const key = document.createElement('b');
    key.textContent = label + ':';
    row.appendChild(key);
    row.appendChild(document.createTextNode(' ' + String(value == null ? '' : value)));
    panel.appendChild(row);
  };
  addLine('消息', msg);
  addLine('文件', src);
  addLine('行号', line);
  addLine('列号', col);
  if (err && err.stack) {
    const label = document.createElement('b');
    label.textContent = '堆栈:';
    panel.appendChild(label);
    const stack = document.createElement('pre');
    stack.style.whiteSpace = 'pre-wrap';
    stack.style.wordBreak = 'break-all';
    stack.textContent = String(err.stack);
    panel.appendChild(stack);
  }
  box.replaceChildren(panel);
};

/* =================================================================
   排期工具 — 模块化工作空间 / O02 瑞士秩序
   ================================================================= */

const DAY_MS = 86400000;
const P  = n => String(n).padStart(2,'0');
const tD = s => { const[y,m,d]=s.split('-').map(Number); return Math.floor(Date.UTC(y,m-1,d)/DAY_MS) };
const fD = n => { const d=new Date(n*DAY_MS); return `${d.getUTCFullYear()}-${P(d.getUTCMonth()+1)}-${P(d.getUTCDate())}` };
const dow = d => new Date(d*DAY_MS).getUTCDay();
const WD  = ['日','一','二','三','四','五','六'];
const todayD = () => { const n=new Date(); return tD(`${n.getFullYear()}-${P(n.getMonth()+1)}-${P(n.getDate())}`) };
// 按月偏移，返回该月 1 号的天数索引
const monthStart = (di,off) => { const d=new Date(di*DAY_MS); return Math.floor(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+off,1)/DAY_MS) };
// 按月偏移，返回该月最后一天的天数索引
const monthEnd = (di,off) => { const d=new Date(di*DAY_MS); return Math.floor(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+off+1,0)/DAY_MS) };

const ZOOM = { day:{dw:72}, week:{dw:22}, month:{dw:6} };
// 任务职能（六类，可在设置页面里增删改）
const GROUPS = [
  { name:'策划',     color:'#2f6fe8' },  // 蓝
  { name:'美术',     color:'#ec4899' },  // 粉
  { name:'程序',     color:'#0ea5e9' },  // 天蓝
  { name:'技术策划', color:'#a855f7' },  // 紫
  { name:'技术美术', color:'#575ae8' },  // 靛
  { name:'动画',     color:'#f59e0b' }   // 橙
];
// 旧职能 → 新职能自动迁移映射
const ROLE_MAP = { '玩法策划GD':'策划', '关卡策划LD':'策划', '技术策划TD':'技术策划', '技术美术TA':'技术美术' };
const RH = 40; // row height

// State
let proj = null, zoom = 'week', selId = null, saveT = null, idC = 1, dragging = false;
let selIds = new Set();   // 多选集合；selId 始终是"主选中"（编辑/新建子任务的对象）
let crit = new Set(), cf = new Set(), filterQ = '', filterGrp = null, filterPhase = null;

// 撤销 / 重做：每次数据变动后快照（上限 50 步）
let hist = [], histI = -1;
function snap(){
  if(!proj.meta)proj.meta={lw:440};
  // Layout gestures commit their metadata on release; snapshots exclude visual drafts.
  const s = JSON.stringify({tasks:proj.tasks, groups:proj.groups, flags:proj.flags||[], meta:proj.meta});
  if(hist[histI] === s) return;
  hist = hist.slice(0, histI+1);
  hist.push(s);
  if(hist.length > 50) hist.shift();
  histI = hist.length - 1;
  updUndoBtns();
}
function mayEditProject(action){return typeof SharedWorkspace==='undefined'||!SharedWorkspace.enabled||SharedWorkspace.requireEdit(action)}
function undo(){ if(!mayEditProject('撤销修改'))return;if(histI<=0){toast('没有可撤销的操作','info');return} histI--; applyHist() }
function redo(){ if(!mayEditProject('重做修改'))return;if(histI>=hist.length-1){toast('没有可重做的操作','info');return} histI++; applyHist() }
function updUndoBtns(){
  const u=$('#btn-undo'),r=$('#btn-redo');
  const blocked=typeof SharedWorkspace!=='undefined'&&SharedWorkspace.enabled&&!SharedWorkspace.canEdit;
  if(u)u.disabled=blocked||histI<=0;
  if(r)r.disabled=blocked||histI>=hist.length-1;
}
function applyHist(){
  const d = JSON.parse(hist[histI]);
  proj.tasks = d.tasks; proj.groups = d.groups; proj.flags = d.flags||[]; proj.meta = d.meta||{lw:440};
  document.documentElement.style.setProperty('--left-w',(proj.meta.lw||440)+'px');
  if(typeof applyPaneLayout==='function')applyPaneLayout();
  applyColWidths();
  selId = null; selIds = new Set();
  if(filterGrp&&!proj.groups.some(g=>g.name===filterGrp))filterGrp=null;
  if(filterPhase&&!proj.tasks.some(t=>t.phase===filterPhase))filterPhase=null;
  render(); updUndoBtns();
  if(!$('#set-ovl').hidden)renderSettings();
  markUnsaved();
  clearTimeout(saveT); saveT = setTimeout(doSave, 300);
}
const $  = s => document.querySelector(s);
// 拖动期间的全局光标（静止时一律箭头）
function setDragCur(cls){document.body.classList.remove('drag-cursor','drag-ew','drag-col','drag-cross');if(cls)document.body.classList.add(cls)}
// 弹窗关闭动画：淡出下沉后再隐藏（退出比入场更快）
function anyOvlOpen(){return ['#ovl','#flag-ovl','#fields-ovl','#set-ovl','#help-ovl','#shared-unlock-ovl','#shared-presence-ovl','#shared-ai-ovl'].some(id=>{const ovl=$(id);return ovl&&!ovl.hidden})}
function isComposingKey(e){return e.isComposing||e.keyCode===229}
function restoreOvlFocus(ovl){
  const previous=ovl._returnFocus;ovl._returnFocus=null;
  if(anyOvlOpen())return;
  let target=previous&&previous.isConnected&&previous.focus?previous:null;
  if(!target&&selId){target=Array.from($('#g-left-body').querySelectorAll('.t-row')).find(row=>row.dataset.id===selId)}
  if(!target)target=$('#btn-add-task');
  if(target&&target.focus)target.focus();
}
function closeOvl(ovl,after){
  clearTimeout(ovl._focusT);
  if(ovl.hidden||ovl.classList.contains('closing')){if(after)after();return}
  ovl.classList.add('closing');
  ovl._closeT=setTimeout(()=>{ovl.hidden=true;ovl.classList.remove('closing');if(after)after();restoreOvlFocus(ovl)},140);
}
function openOvl(ovl){
  clearTimeout(ovl._closeT);clearTimeout(ovl._focusT);
  if(ovl.hidden)ovl._returnFocus=document.activeElement;
  ovl.classList.remove('closing');ovl.hidden=false;
  ovl._focusT=setTimeout(()=>{
    if(ovl.hidden||ovl.classList.contains('closing')||ovl.contains(document.activeElement))return;
    const first=Array.from(ovl.querySelectorAll('button,input,select,textarea')).find(x=>!x.disabled&&x.offsetParent!==null);
    if(first)first.focus();
  },0);
}
// 重要节点统一图标：定位标（卡尺）。与任务条重叠时 = 标头 + 工字标尺（标尺卡住条的顶与底）
// listMode=true 时只出头部（列表/菜单，以及图上不与任务条重叠的节点）
// rulerLen 可变：标尺跨越多个子行的任务条时按实际高度拉长（默认 21.2 ≈ 单条高 22px）
function nodeIconSvg(sz,listMode,rulerLen){
  const s=sz/16, hh=17*s;                    // 头部显示高度（针尖在 hh 处）
  if(listMode){
    return `<svg width="${sz}" height="${Math.ceil(hh)}" viewBox="0 0 16 17" fill="none" aria-hidden="true">`
      +`<g class="head-zoom"><path d="M8 1a6.2 6.2 0 0 1 6.2 6.2c0 4-4.3 8.6-5.6 9.9a.85.85 0 0 1-1.2 0C6.1 15.8 1.8 11.2 1.8 7.2A6.2 6.2 0 0 1 8 1z" fill="currentColor" stroke="#fff" stroke-width="1.3"/>`
      +`<circle cx="8" cy="7.2" r="2.4" fill="#fff"/></g></svg>`;
  }
  const g=3, L=rulerLen!=null?rulerLen:21.2, H=hh+g+L+1.3, c=sz/2;   // g = 标头与标尺之间的空隙
  // 尾部 = 完整工字标尺：顶横条 + 竖杆 + 底横条；头部悬在标尺上方、留空隙不相叠
  const bar=(y)=>`<line x1="${c-3.4}" y1="${y}" x2="${c+3.4}" y2="${y}" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>`
    +`<line x1="${c-3.4}" y1="${y}" x2="${c+3.4}" y2="${y}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
  return `<svg width="${sz}" height="${Math.ceil(H)}" viewBox="0 0 ${sz} ${H}" fill="none" aria-hidden="true">`
    +`<line x1="${c}" y1="${hh+g}" x2="${c}" y2="${hh+g+L}" stroke="#fff" stroke-width="3.4"/>`
    +`<line x1="${c}" y1="${hh+g}" x2="${c}" y2="${hh+g+L}" stroke="currentColor" stroke-width="1.8"/>`
    +bar(hh+g)+bar(hh+g+L)
    +`<g transform="scale(${s})"><g class="head-zoom"><path d="M8 1a6.2 6.2 0 0 1 6.2 6.2c0 4-4.3 8.6-5.6 9.9a.85.85 0 0 1-1.2 0C6.1 15.8 1.8 11.2 1.8 7.2A6.2 6.2 0 0 1 8 1z" fill="currentColor" stroke="#fff" stroke-width="${(1.3/s).toFixed(2)}"/>`
    +`<circle cx="8" cy="7.2" r="2.4" fill="#fff"/></g></g></svg>`;
}
// 单色内联 SVG 图标（替代彩色 emoji，保持"极简·安静"的视觉人格）
const ICON={
  warn:'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.6 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  trash:'<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
  calendar:'<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#86909c" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2.5" x2="8" y2="5.5"/><line x1="16" y1="2.5" x2="16" y2="5.5"/></svg>',
  flag:'<svg width="16" height="22" viewBox="0 0 16 22" fill="none" aria-hidden="true"><line x1="2.2" y1="2" x2="2.2" y2="21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M2.2 2.5h11.6L10.6 6.4l3.2 3.9H2.2z" fill="currentColor"/></svg>'
};
const ce = (t,c,v) => { const e=document.createElement(t); if(c)e.className=c; if(v!=null)e.textContent=v; return e };
function uid(){ return 't'+(idC++)+'_'+(Math.random()*1e6|0) }
