/* 右键菜单 */
function hideCtx(){$('#ctxmenu').classList.remove('show')}
function showCtx(x,y,taskId,emptyDay,flagDay){
  const menu=$('#ctxmenu');menu.innerHTML='';
  const items=[];
  if(flagDay!=null){
    items.push({ico:'⚑',label:'在此插入里程碑（'+fmtS(flagDay)+'）',act:()=>flagOpen(null,flagDay)});
  }else if(taskId){
    const t=byId(taskId);if(!t)return;const sm=isSum(t);
    items.push({ico:'✎',label:'编辑…',act:()=>edOpen(taskId)});
    if(t.type!=='milestone'){
      items.push({ico:'↳',label:'添加子任务',act:()=>addT(taskId,'task')});
      items.push({ico:nodeIconSvg(11,true),html:1,label:'添加子节点',act:()=>addT(taskId,'milestone')});
    }
    if(sm&&t.type!=='pipeline')items.push({ico:'⛓',label:t.flow?'关闭流程模式':'开启流程模式（同一行）',act:()=>{if(!mayEditProject('调整流程模式'))return;t.flow=!t.flow;render();schSave();toast(t.flow?'已开启流程模式':'已关闭流程模式','info')}});
    items.push({sep:1});
    items.push({ico:'⧉',label:'复制一份',act:()=>dupTask(taskId)});
    items.push({ico:ICON.trash,html:1,label:'删除',danger:1,act:()=>{sel(taskId);delSel()}});
  }else if(emptyDay!=null){
    items.push({ico:'＋',label:'在此新建任务',act:()=>newAtDay(emptyDay,'task')});
    items.push({ico:nodeIconSvg(11,true),html:1,label:'在此新建重要节点',act:()=>newAtDay(emptyDay,'milestone')});
  }
  if(!items.length)return;
  for(const it of items){
    if(it.sep){menu.appendChild(ce('div','ctx-sep'));continue}
    const el=ce('div','ctx-item'+(it.danger?' danger':''));
    const ic=ce('span','ctx-ico');if(it.html)ic.innerHTML=it.ico;else ic.textContent=it.ico;
    el.appendChild(ic);el.appendChild(ce('span',null,it.label));
    el.addEventListener('click',()=>{hideCtx();it.act()});
    menu.appendChild(el);
  }
  menu.classList.add('show');
  const mw=menu.offsetWidth,mh=menu.offsetHeight;
  menu.style.left=Math.min(x,innerWidth-mw-8)+'px';
  menu.style.top=Math.min(y,innerHeight-mh-8)+'px';
}
// 复制任务（含其子孙，重映射 id 与依赖）
function dupTask(id){
  if(typeof mayEditProject==='function'&&!mayEditProject('复制任务'))return;
  const src=byId(id);if(!src)return;
  const all=[src,...desc(id)],idMap=new Map();
  for(const o of all)idMap.set(o.id,uid());
  const clones=all.map(o=>{const c=JSON.parse(JSON.stringify(o));c.id=idMap.get(o.id);if(o.pid&&idMap.has(o.pid))c.pid=idMap.get(o.pid);c.deps=(o.deps||[]).map(d=>idMap.get(d)||d).filter(Boolean);return c});
  // 克隆整体向后挪一天，避免完全重叠
  for(const c of clones){if(c.s)c.s=fD(tD(c.s)+1);if(c.e)c.e=fD(tD(c.e)+1);proj.tasks.push(c)}
  selId=idMap.get(id);selIds=new Set([selId]);render();schSave();toast('已复制','success');
}
function bindCtxMenu(){
  document.addEventListener('contextmenu',e=>{
    const fg=e.target.closest('.flag');
    if(fg){e.preventDefault();return}
    const th=e.target.closest('#tl-header');
    if(th){e.preventDefault();const point=canvasClientPoint(e,$('#tl-body'));const day=Math.floor(point.x/axis.dw)+bds.mn;showCtx(e.clientX,e.clientY,null,null,day);return}
    const bar=e.target.closest('.bar,.ms,.pin,.lane-band,.pipe-head'),row=e.target.closest('.t-row'),tl=e.target.closest('#tl-body');
    if(bar&&bar.dataset.id){e.preventDefault();sel(bar.dataset.id);showCtx(e.clientX,e.clientY,bar.dataset.id);return}
    if(row&&row.dataset.id){e.preventDefault();sel(row.dataset.id);showCtx(e.clientX,e.clientY,row.dataset.id);return}
    if(tl){e.preventDefault();const point=canvasClientPoint(e,tl),day=Math.floor(point.x/axis.dw)+bds.mn;showCtx(e.clientX,e.clientY,null,day);return}
  });
  document.addEventListener('click',hideCtx);
  document.addEventListener('scroll',hideCtx,true);
  window.addEventListener('blur',hideCtx);
  document.addEventListener('keydown',e=>{if(e.key==='Escape')hideCtx()});
}

/* Selection */
// 选择只更新现有节点，避免单击重建 DOM 打断紧随其后的双击。
function paintSelection(){
  for(const el of document.querySelectorAll('#g-left-body .t-row[data-id],#b-layer [data-id]')){
    const selected=selIds.has(el.dataset.id);el.classList.toggle('selected',selected);
    if(el.classList.contains('t-row'))el.setAttribute('aria-pressed',String(selected));
  }
  updStats();
}
function sel(id,focusRow){
  selId=id;selIds=id?new Set([id]):new Set();paintSelection();
  if(focusRow){const el=Array.from($('#g-left-body').querySelectorAll('.t-row[data-id]')).find(node=>node.dataset.id===id);if(el&&document.activeElement!==el)el.focus()}
}
function toggleSel(id){
  if(selIds.has(id)){selIds.delete(id);if(selId===id)selId=selIds.size?Array.from(selIds).pop():null}
  else{selIds.add(id);selId=id}
  paintSelection();
}
// 行用 Ctrl/Shift+点击、图形用 Shift+点击（Ctrl 留给拖依赖线）
function clickSel(e,id){(e.ctrlKey||e.metaKey||e.shiftKey)?toggleSel(id):sel(id)}
// ↑/↓ 在可见行间移动选中；Shift+↑/↓ 扩展多选
function selStep(dir,extend){
  const rows=vRows();if(!rows.length)return;
  let i=rows.findIndex(r=>r.t.id===selId);
  i=i<0?(dir>0?0:rows.length-1):Math.max(0,Math.min(rows.length-1,i+dir));
  const id=rows[i].t.id;
  if(extend){selIds.add(id);selId=id;paintSelection();const el=Array.from($('#g-left-body').querySelectorAll('.t-row[data-id]')).find(node=>node.dataset.id===id);if(el)el.focus()}
  else sel(id,true);
}
// ←/→ 微调选中任务日期（Shift = 7 天）；父任务整组平移；多选批量平移
function nudgeSel(d){
  if(typeof mayEditProject==='function'&&!mayEditProject('调整任务日期'))return;
  if(!selIds.size)return;
  const roots=Array.from(selIds).map(byId).filter(Boolean);
  const seen=new Set();
  const move=x=>{if(seen.has(x.id))return;seen.add(x.id);x.s=fD(tD(x.s)+d);x.e=fD(tD(x.e)+d)};
  for(const r of roots){if(isSum(r)){for(const k of desc(r.id))move(k)}else move(r)}
  render();schSave();
  const el=Array.from($('#g-left-body').querySelectorAll('.t-row[data-id]')).find(node=>node.dataset.id===selId);if(el)el.focus();
}
/* 轻量拖拽：mousemove 只更新受影响元素的位置与依赖线，mouseup 才全量渲染 */
function paintTask(t){
  const dw=axis.dw,bl=$('#b-layer'),sm=isSum(t);
  const rng=sm?eRange(t):{s:tD(t.s),e:tD(t.e)};
  const p=bPos[t.id];if(!p)return;
  if(p.type==='pipe')return;   // 管线带贯穿项目周期，拖拽中保持静止，mouseup 全量渲染时修正
  if(p.type==='ms'){
    const cx=(rng.s-bds.mn)*dw+dw/2,dx=cx-p.cx,half=p.w/2;
    p.cx=cx;p.x+=dx;
    const el=Array.from(bl.querySelectorAll('.ms[data-id],.pin[data-id]')).find(node=>node.dataset.id===t.id);
    if(el)el.style.left=(cx-half)+'px';
    const lb=Array.from(bl.querySelectorAll('.ms-label[data-for],.pin-label[data-for]')).find(node=>node.dataset.for===t.id);
    if(lb)lb.style.left=(cx+half+6)+'px';
    return;
  }
  const geometry=ScheduleBarGeometry.span(rng.s,rng.e,bds.mn,dw),{x,w,paintX,paintWidth}=geometry;
  Object.assign(p,geometry);
  const el=Array.from(bl.querySelectorAll('[data-id]')).find(node=>node.dataset.id===t.id);
  if(el){el.style.left=paintX+'px';el.style.width=paintWidth+'px'}
  const out=Array.from(bl.querySelectorAll('.bar-out[data-for]')).find(node=>node.dataset.for===t.id);
  if(out)out.style.left=(p.type==='sum'?(x+w/2):(x+w+6))+'px';
  const err=Array.from(bl.querySelectorAll('.bar-err[data-for]')).find(node=>node.dataset.for===t.id);
  if(err)err.style.left=(x+w+4)+'px';
  const tag=Array.from(bl.querySelectorAll('.lane-tag[data-for]')).find(node=>node.dataset.for===t.id);
  if(tag)tag.style.left=(x-8)+'px';
}
// 拖动目标集合：多选时拖任一成员 → 整组；父任务 → 其全部后代
function dragTargets(t){
  let roots=[t];
  if(selIds.size>1&&selIds.has(t.id))roots=Array.from(selIds).map(byId).filter(Boolean);
  const set=new Map();
  for(const r of roots){
    if(isSum(r)){for(const d of desc(r.id))set.set(d.id,d)}
    else set.set(r.id,r);
  }
  return Array.from(set.values());
}
function sBarD(e,t,sum){
  if(e.button!==0||dragging)return;
  // A viewer can still click a bar to select it; editing uses the explicit unlock action.
  if(typeof SharedWorkspace!=='undefined'&&SharedWorkspace.enabled&&!SharedWorkspace.canEdit)return;
  const h=e.target.dataset&&e.target.dataset.handle;
  if(!selIds.has(t.id))sel(t.id);
  const sX=e.clientX,rt=$('#g-right'),sScroll=rt.scrollLeft,dw=axis.dw;
  let lastX=sX,finished=false;
  const mode=(sum||selIds.size>1)?'move':(h||'move');
  const targets=mode==='move'?dragTargets(t):[t];
  const orig=targets.map(x=>({t:x,s:tD(x.s),e:tD(x.e)}));
  const oS=tD(t.s),oE=tD(t.e);
  setDragCur(mode==='move'?'drag-cursor':'drag-ew');
  dragging=true;$('#tooltip').classList.remove('show');
  const el0=Array.from($('#b-layer').querySelectorAll('[data-id]')).find(node=>node.dataset.id===t.id);if(el0)el0.classList.add('dragging');
  // 受影响元素 = 目标 + 各自的祖先链（父任务汇总条会跟着变）
  const paintSet=new Set();
  for(const o of orig){paintSet.add(o.t.id);let p=o.t.pid;while(p){paintSet.add(p);p=(byId(p)||{}).pid}}
  const mv=ev=>{
    if(Number.isFinite(ev.clientX))lastX=ev.clientX;
    const dl=Math.round((canvasClientDelta(lastX-sX)+rt.scrollLeft-sScroll)/dw);
    if(mode==='move'){for(const o of orig){o.t.s=fD(o.s+dl);o.t.e=fD(o.e+dl)}}
    else if(mode==='left')t.s=fD(Math.min(oS+dl,oE));
    else t.e=fD(Math.max(oE+dl,oS));
    for(const id of paintSet){const x=byId(id);if(x)paintTask(x)}
    schDepDraw();
  };
  const fin=save=>{
    if(finished)return;finished=true;
    if(save&&typeof SharedWorkspace!=='undefined'&&SharedWorkspace.enabled&&!SharedWorkspace.canEdit)save=false;
    document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);
    rt.removeEventListener('scroll',scroll);
    document.removeEventListener('keydown',esc,true);window.removeEventListener('blur',cancel);
    setDragCur(null);dragging=false;
    // 无位移时不重建 DOM：否则单击/双击之间元素被替换，双击事件永远凑不齐
    const changed=orig.some(o=>tD(o.t.s)!==o.s||tD(o.t.e)!==o.e);
    if(!save)for(const o of orig){o.t.s=fD(o.s);o.t.e=fD(o.e)}
    if(changed){render();if(save)schSave()}
    else if(el0)el0.classList.remove('dragging');
  };
  const up=ev=>{if(!finished)mv(ev||{});fin(true)};
  const scroll=()=>mv({clientX:lastX});
  const cancel=()=>fin(false);
  const esc=ev=>{if(ev.key==='Escape'&&!isComposingKey(ev)){ev.preventDefault();ev.stopPropagation();cancel()}};
  document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
  rt.addEventListener('scroll',scroll,{passive:true});
  document.addEventListener('keydown',esc,true);window.addEventListener('blur',cancel);
  e.preventDefault();
}

/* 左侧拖动排序 */
function startRowDrag(e,drag){
  if(typeof mayEditProject==='function'&&!mayEditProject('移动任务'))return;
  if(e.button!==0)return;e.preventDefault();e.stopPropagation();
  dragging=true;
  const sX=e.clientX,sY=e.clientY;let started=false,line=null,rw=e.target.closest('.t-row');
  let dropTargetId=null,dropMode='before',lastInto=null;
  const begin=()=>{started=true;if(rw)rw.classList.add('row-dragging');setDragCur('drag-cursor');line=ce('div','drop-line');document.body.appendChild(line)};
  const clearInto=()=>{if(lastInto){lastInto.classList.remove('drop-into');lastInto=null}};
  const mv=ev=>{
    if(!started){if(Math.abs(ev.clientX-sX)<4&&Math.abs(ev.clientY-sY)<4)return;begin()}
    // 找到鼠标下的行
    const ep=document.elementFromPoint(ev.clientX,ev.clientY);
    const row=ep&&ep.closest('.t-row');
    if(!row||row===rw){if(line)line.style.display='none';clearInto();dropTargetId=null;return}
    const tid=row.dataset.id;
    // 不能拖到自己的后代里
    if(tid===drag.id||desc(drag.id).some(d=>d.id===tid)){if(line)line.style.display='none';clearInto();dropTargetId=null;return}
    const r=row.getBoundingClientRect();
    const rel=(ev.clientY-r.top)/r.height;
    const tgt=byId(tid);
    // 中部 = 挂为子任务（节点下不能挂子项；管线不能被挂到别人下面）
    const canInto=tgt&&tgt.type!=='milestone'&&drag.type!=='pipeline';
    dropTargetId=tid;
    if(canInto&&rel>0.3&&rel<0.7){
      dropMode='into';
      if(line)line.style.display='none';
      if(lastInto!==row){clearInto();row.classList.add('drop-into');lastInto=row}
    }else{
      dropMode=rel>=0.5?'after':'before';
      clearInto();
      if(line){line.style.display='block';line.style.left=r.left+'px';line.style.width=r.width+'px';line.style.top=(dropMode==='after'?r.bottom:r.top)+'px'}
    }
  };
  const cleanup=()=>{
    dragging=false;
    document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);
    document.removeEventListener('keydown',esc,true);window.removeEventListener('blur',cleanup);
    setDragCur(null);if(rw)rw.classList.remove('row-dragging');if(line)line.remove();clearInto();
  };
  const up=()=>{
    const mode=dropMode,tid=dropTargetId,ok=started&&tid;
    cleanup();
    if(ok){
      const changed=mode==='into'?makeChild(drag.id,tid):moveTask(drag.id,tid,mode==='after');
      if(changed){render();schSave();}
    }
  };
  const esc=ev=>{if(ev.key==='Escape'){ev.stopPropagation();cleanup()}};
  document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
  document.addEventListener('keydown',esc,true);
  window.addEventListener('blur',cleanup);
}
// 挂为子任务之前先验证拟重挂的完整图，不变更原数据，防止层级屏障与已有依赖组成隐环。
function canReparentTask(dragId,pid){
  const proposed=proj.tasks.map(t=>t.id===dragId?{...t,pid}:t);
  if(dependencyCycle(proposed)){toast('不能移动：新层级会与已有依赖形成循环','warn',4200);return false}
  return true;
}
// 挂为子任务：drag 变成 target 的子级（插入为其第一个子项）
function makeChild(dragId,targetId){
  if(typeof mayEditProject==='function'&&!mayEditProject('移动任务'))return false;
  const drag=byId(dragId),target=byId(targetId);if(!drag||!target)return false;
  if(dragId===targetId||desc(dragId).some(d=>d.id===targetId))return false;
  if(drag.type==='pipeline'||target.type==='milestone')return false;
  if(!canReparentTask(dragId,targetId))return false;
  drag.pid=targetId;target.fold=false;
  const arr=proj.tasks;arr.splice(arr.indexOf(drag),1);
  arr.splice(arr.indexOf(target)+1,0,drag);
  toast('已将「'+drag.name+'」挂到「'+target.name+'」下 · Ctrl+Z 可撤销','info',3000);
  return true;
}
function moveTask(dragId,targetId,after){
  if(typeof mayEditProject==='function'&&!mayEditProject('移动任务'))return false;
  const drag=byId(dragId),target=byId(targetId);if(!drag||!target)return false;
  if(dragId===targetId||desc(dragId).some(d=>d.id===targetId))return false;
  if(drag.type==='pipeline'&&target.pid!==null)return false;
  if(!canReparentTask(dragId,target.pid))return false;
  drag.pid=target.pid;
  const arr=proj.tasks;arr.splice(arr.indexOf(drag),1);
  const ti=arr.indexOf(target);arr.splice(after?ti+1:ti,0,drag);
  return true;
}
