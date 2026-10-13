// RENDER
let axis=null,bds=null,bPos=Object.create(null);
// 流程泳道装箱：重叠的子项自动分到下一子行（行高随之增高）
const SUBP=26;   // 子行间距（22px 条 + 4px 缝）
let rowYs=[],rowsHTotal=0;
// 展开状态在重绘间保留；关闭计时器共享，避免 DOM 重建后悬停层闪退。
const expandedLanes=new Set(),laneCloseTimers=new Map();
function laneAssign(parent){
  const rangeOf=t=>{if(isSum(t))return eRange(t);const s=tD(t.s);return{s,e:t.type==='milestone'?s:tD(t.e)}};
  const keep=filteredTaskIds();
  const items=kids(parent.id).filter(t=>!keep||keep.has(t.id)).sort((a,b)=>rangeOf(a).s-rangeOf(b).s);
  const lanes=[],baseMap=new Map(),sizes=[],map=new Map(),spans=new Map();
  // 先以收起状态装箱，再撑开原子行；展开的父条始终留在原行，后面的行向下让位。
  for(const c of items){
    if(c.type==='milestone')continue;
    const r=rangeOf(c);let li=lanes.findIndex(end=>r.s>end);
    if(li<0){li=lanes.length;lanes.push(r.e)}else lanes[li]=r.e;
    const span=isSum(c)&&expandedLanes.has(c.id)?laneAssign(c).depth:1;
    baseMap.set(c.id,li);spans.set(c.id,span);sizes[li]=Math.max(sizes[li]||1,span);
  }
  if(!sizes.length)sizes.push(1);
  const starts=[];let depth=0;
  for(const size of sizes){starts.push(depth);depth+=size}
  for(const c of items){
    if(c.type==='milestone')map.set(c.id,Math.max(0,Math.min(c.lane||0,depth-1)));
    else map.set(c.id,starts[baseMap.get(c.id)]);
  }
  return{items,map,spans,depth};
}
// 可见任务条覆盖的子行，含已展开的后代，用于节点卡尺和统一标签避让。
function laneCoverage(parent,base=0){
  const{items,map}=laneAssign(parent),out=[];
  for(const c of items){
    if(c.type==='milestone')continue;
    const r=isSum(c)?eRange(c):{s:tD(c.s),e:tD(c.e)},li=base+(map.get(c.id)||0);
    out.push({...r,lane:li});
    if(isSum(c)&&expandedLanes.has(c.id))out.push(...laneCoverage(c,li));
  }
  return out;
}
function laneNodeOverlap(coverage,t){
  const d=tD(t.s);let lo=Infinity,hi=-Infinity;
  for(const r of coverage)if(d>=r.s&&d<=r.e){lo=Math.min(lo,r.lane);hi=Math.max(hi,r.lane)}
  return lo<=hi?{lo,hi}:null;
}
function laneClaims(parent){
  const claims=[];
  const claim=(li,l,r)=>(claims[li]||(claims[li]=[])).push({l,r});
  // 先登记所有条和节点，标签不会侵入后续才绘制的元素。
  for(const r of laneCoverage(parent))claim(r.lane,(r.s-bds.mn)*axis.dw,(r.e-bds.mn+1)*axis.dw);
  const visit=(p,base)=>{
    const{items,map}=laneAssign(p),coverage=laneCoverage(p);
    for(const c of items){
      const li=map.get(c.id)||0;
      if(c.type==='milestone'){
        const ov=laneNodeOverlap(coverage,c),cx=(tD(c.s)-bds.mn)*axis.dw+axis.dw/2;
        claim(base+(ov?ov.lo:li),cx-6,cx+6);
      }else if(isSum(c)&&expandedLanes.has(c.id))visit(c,base+li);
    }
  };
  visit(parent,0);return claims;
}
function clearLaneTimer(id){clearTimeout(laneCloseTimers.get(id));laneCloseTimers.delete(id)}
function closeLane(id){
  for(const tid of [id,...desc(id).map(t=>t.id)]){expandedLanes.delete(tid);clearLaneTimer(tid)}
}
function clearLaneHover(){
  if(!expandedLanes.size)return;
  expandedLanes.clear();for(const timer of laneCloseTimers.values())clearTimeout(timer);laneCloseTimers.clear();render();
}
function rowHOf(t){
  if(isSum(t)&&t.flow&&t.type!=='pipeline'){const d=laneAssign(t).depth;return RH+(d-1)*SUBP}
  return RH;
}
function computeRowYs(rows){
  rowYs=[];let acc=0;
  for(const r of rows){rowYs.push(acc);acc+=rowHOf(r.t)}
  rowsHTotal=acc;
}

function render(){
  const rows=vRows();bds=compBounds(rows);axis=buildAxis(bds.mn,bds.mx,zoom);
  bPos=Object.create(null);analyze();computeRowYs(rows);
  // 重建 DOM 会让 mouseleave 丢失：渲染前强制收起悬停浮层，避免效果残留
  const tp=$('#tooltip');if(tp)tp.classList.remove('show');
  renderLegend();renderLeft(rows);renderTableHeader();renderTLH();renderBody(rows);updStats();
  if(typeof ScheduleHighlights!=='undefined')ScheduleHighlights.afterRender();
}
function renderLegend(){
  const lg=$('#legend');lg.innerHTML='';
  lg.appendChild(ce('span','lg-label','职能'));
  for(const g of proj.groups){
    const n=proj.tasks.filter(t=>t.grp===g.name&&!isSum(t)&&t.type!=='pipeline').length;
    const c=ce('button','lg-chip'+(filterGrp===g.name?' on':''));c.type='button';
    c.setAttribute('aria-pressed',filterGrp===g.name?'true':'false');
    const d=ce('span','lg-dot');d.style.background=g.color;c.appendChild(d);
    c.appendChild(ce('span',null,g.name));
    if(n)c.appendChild(ce('span','lg-count',String(n)));
    c.title=filterGrp===g.name?'点击取消筛选':'只看「'+g.name+'」的任务';
    c.addEventListener('click',()=>{filterGrp=filterGrp===g.name?null:g.name;render()});
    lg.appendChild(c);
  }
  // 阶段过滤 chips（有任务标了阶段才出现）
  const phs=phaseList();
  if(phs.length){
    lg.appendChild(ce('span','lg-sep'));
    lg.appendChild(ce('span','lg-label','阶段'));
    for(const p of phs){
      const n=proj.tasks.filter(t=>t.phase===p&&!isSum(t)).length;
      const c=ce('button','lg-chip ph'+(filterPhase===p?' on':''));c.type='button';
      c.setAttribute('aria-pressed',filterPhase===p?'true':'false');
      c.appendChild(ce('span',null,p));
      if(n)c.appendChild(ce('span','lg-count',String(n)));
      c.title=filterPhase===p?'点击取消筛选':'只看「'+p+'」阶段的任务';
      c.addEventListener('click',()=>{filterPhase=filterPhase===p?null:p;render()});
      lg.appendChild(c);
    }
  }
}
function updStats(){
  const lv=proj.tasks.filter(t=>!isSum(t)&&t.type!=='milestone'&&t.type!=='pipeline');
  const ms=proj.tasks.filter(t=>t.type==='milestone').length;
  let sm=0,dr=0;for(const k of lv){const w=Math.max(1,tD(k.e)-tD(k.s)+1);dr+=w;sm+=w*(k.pct||0)}
  const pct=dr?Math.round(sm/dr):0;
  const fg=(proj.flags||[]).length;
  let txt=lv.length?`${lv.length} 项任务${ms?` · ${ms} 个节点`:''}${fg?` · ${fg} 个里程碑`:''} · 总进度 ${pct}%`:'';
  const fs=[];if(filterGrp)fs.push('职能「'+filterGrp+'」');if(filterPhase)fs.push('阶段「'+filterPhase+'」');if(filterQ)fs.push('「'+filterQ+'」');
  if(fs.length)txt='筛选中：'+fs.join(' + ')+(txt?' · '+txt:'');
  if(selIds.size>1)txt=`已选 ${selIds.size} 项`+(txt?' · '+txt:'');
  $('#tb-stats').textContent=txt;
  // 多选浮动计数：不依赖窄窗口会隐藏的统计栏
  const sc=$('#sel-chip');
  if(selIds.size>1){sc.innerHTML=`已选 <b>${selIds.size}</b> 项 · 拖动任一整体移动 · ←→ 挪期 · Delete 删除 · Esc 取消`;sc.classList.add('show')}
  else sc.classList.remove('show');
  if(typeof WorkspaceShell!=='undefined')WorkspaceShell.update();
}
function renderLeft(rows){
  const bd=$('#g-left-body'),columns=visibleTableColumns();bd.innerHTML='';
  if(!rows.length){const eh=ce('div','empty-hint');eh.innerHTML='<span class="big">'+ICON.calendar+'</span>'+(filterQ||filterGrp||filterPhase?'没有符合筛选条件的任务<br>按 <b>Esc</b> 清除筛选':'还没有任务<br>点击顶部 <b>＋ 任务</b> 或在右侧时间轴<b>双击空白处</b>新建');bd.appendChild(eh);return}
  for(const{t,depth}of rows){
    const rw=ce('div','t-row');rw.dataset.id=t.id;
    rw.style.height=rowHOf(t)+'px';   // 流程行按子行堆叠深度增高
    rw.tabIndex=0;rw.setAttribute('role','button');
    rw.setAttribute('aria-pressed',selIds.has(t.id)?'true':'false');
    rw.addEventListener('focus',()=>{if(rw.matches(':focus-visible')&&!selIds.has(t.id))sel(t.id,true)});
    if(selIds.has(t.id))rw.classList.add('selected');
    if(crit.has(t.id))rw.classList.add('critical');
    if(cf.has(t.id))rw.classList.add('conflict');
    const sm=isSum(t);if(sm)rw.classList.add('is-sum');
    if(t.type==='pipeline')rw.classList.add('is-pipe');
    const nc=ce('div','col col-name');nc.style.paddingLeft=(10+depth*18)+'px';
    const grip=ce('span','t-grip','⠿');grip.title='拖动调整顺序';
    grip.addEventListener('mousedown',ev=>startRowDrag(ev,t));
    nc.appendChild(grip);
    const tw=ce('span','tw'+((sm&&!t.flow)?'':' ghost'),(sm&&!t.flow)?(t.fold?'▶':'▼'):'');
    if(sm&&!t.flow)tw.addEventListener('click',ev=>{ev.stopPropagation();t.fold=!t.fold;render();schSave()});
    nc.appendChild(tw);
    const dot=ce('span','t-dot');
    if(t.type==='milestone'){dot.innerHTML=nodeIconSvg(10,true);dot.style.color=gc(t.grp)||'#e03e3e';dot.style.display='inline-flex';dot.style.alignItems='center'}
    else{dot.textContent=t.type==='pipeline'?'▦':((sm&&t.flow)?'⛓':(sm?'▣':'●'));dot.style.color=t.type==='pipeline'?'#4e5969':(sm?'#86909c':gc(t.grp))}
    nc.appendChild(dot);nc.appendChild(ce('span','t-name',t.name));
    // 阶段标签只在与父任务不同（或顶层）时显示，避免每行重复噪音
    const pph=t.pid?(byId(t.pid)||{}).phase:null;
    if(t.phase&&t.phase!==pph)nc.appendChild(ce('span','t-tag phase',t.phase));
    if(sm&&t.flow)nc.appendChild(ce('span','t-tag flow','流程'));
    if(cf.has(t.id)){const w=ce('span','t-warn');w.innerHTML=ICON.warn;w.title='日期冲突：开始日期早于其依赖任务的完成日期';nc.appendChild(w)}
    const isPipe=t.type==='pipeline';
    const rg=sm?eRange(t):{s:tD(t.s),e:tD(t.e)};
    const pc=sm?sumPct(t):(t.pct||0);
    for(const column of columns){
      const text=taskCellText(t,column);
      const cell=column.id==='name'?nc:ce('div','col '+(column.builtin?'col-'+column.id+(column.type==='date'?' col-date':''):'col-custom is-'+column.type),text);
      cell.dataset.col=column.id;
      if(!column.builtin)cell.style.width='var(--col-'+column.id+')';
      cell.title=text;
      rw.appendChild(cell);
    }
    rw.setAttribute('aria-label',[t.name,isPipe?'管线':t.grp,t.who?'负责人 '+t.who:'',t.phase?'阶段 '+t.phase:'',isPipe?'':(t.type==='milestone'?'日期 '+fD(rg.s):'开始 '+fD(rg.s)+'，结束 '+fD(rg.e)),t.type==='milestone'?'':'进度 '+pc+'%',cf.has(t.id)?'日期冲突':'',crit.has(t.id)?'关键路径':''].filter(Boolean).join(' · '));
    rw.addEventListener('click',e=>clickSel(e,t.id));
    rw.addEventListener('dblclick',()=>edOpen(t.id));
    bd.appendChild(rw);
  }
}
// 跨年日期带两位年份前缀（如 27/3/5），当年内保持简洁的 月/日
function fmtS(di){const dt=new Date(di*DAY_MS),y=dt.getUTCFullYear();return (y===new Date().getFullYear()?'':String(y).slice(2)+'/')+`${dt.getUTCMonth()+1}/${dt.getUTCDate()}`}

/* Calendar Header (2 层：顶=分组，底=最小单位) */
function renderTLH(){
  const hd=$('#tl-header');hd.innerHTML='';hd.style.width=axis.tw+'px';
  const topR=ce('div','tl-row tl-top');
  for(const g of axis.groups){const c=ce('div','tl-cell tl-top-cell',g.label);c.style.width=g.w+'px';topR.appendChild(c)}
  const botR=ce('div','tl-row tl-bot');
  for(const c of axis.cells){
    let cls='tl-cell tl-bot-cell';if(c.wk)cls+=' wk';if(c.tdy)cls+=' tdy';if(c.tdyWk)cls+=' tdy-wk';
    const el=ce('div',cls);el.style.width=c.w+'px';
    const n=ce('span','n',c.n);el.appendChild(n);
    if(c.w2)el.appendChild(ce('span','w',c.w2));
    botR.appendChild(el);
  }
  hd.appendChild(topR);hd.appendChild(botR);
  // 里程碑旗层：插在日期栏上，点击编辑、按住可拖动改期
  const fl=ce('div','flag-layer');
  const sorted=(proj.flags||[]).slice().sort((a,b)=>tD(a.d)-tD(b.d));
  let lastRight=-Infinity;
  for(const f of sorted){
    const d=tD(f.d);if(d<bds.mn||d>bds.mx)continue;
    const x=(d-bds.mn)*axis.dw+axis.dw/2;
    const el=ce('div','flag');el.style.left=x+'px';el.style.color=f.color||'#e03e3e';
    el.innerHTML=ICON.flag;
    const est=16+6+f.name.length*11+12;              // 估算标签宽度做贪心避让
    const showName=x>=lastRight+4;
    if(showName){
      const nm=ce('span','flag-name',f.name);
      nm.style.color=darkenCol(f.color||'#e03e3e',.62);   // 深色变体，小字达标
      el.appendChild(nm);
      if(x+est>axis.tw-4)el.classList.add('flip');        // 近右缘时翻转到旗子左侧
      lastRight=x+est;
    }else lastRight=Math.max(lastRight,x+13);
    el.title=`${f.name} · ${f.d}（点击编辑，拖动改期）`;
    el.addEventListener('click',ev=>{ev.stopPropagation();if(!suppressFlagClick)flagOpen(f.id)});
    el.addEventListener('dblclick',ev=>ev.stopPropagation());
    el.addEventListener('mousedown',ev=>flagDragStart(ev,f,el,d));
    fl.appendChild(el);
  }
  hd.appendChild(fl);
}
// 旗子横向拖动改期（阈值 4px 区分点击）
let suppressFlagClick=false;
function flagDragStart(ev,f,el,d0){
  if(ev.button!==0||dragging)return;ev.preventDefault();
  if(typeof SharedWorkspace!=='undefined'&&SharedWorkspace.enabled&&!SharedWorkspace.canEdit)return;
  const rt=$('#g-right'),sX=ev.clientX,sScroll=rt.scrollLeft,dw=axis.dw,mn=bds.mn,originalDate=f.d;
  let moved=false,finished=false,lastX=sX;dragging=true;
  const delta=x=>Math.round((canvasClientDelta(x-sX)+rt.scrollLeft-sScroll)/dw);
  const mv=m=>{
    if(Number.isFinite(m.clientX))lastX=m.clientX;
    if(!moved&&Math.abs(lastX-sX)<4&&Math.abs(rt.scrollLeft-sScroll)*canvasScaleFactor()<4)return;
    if(!moved)setDragCur('drag-cursor');
    moved=true;
    const nx=((d0+delta(lastX))-mn)*dw+dw/2;
    el.style.left=nx+'px';
    const l2=Array.from($('#tl-body').querySelectorAll('.flag-line[data-flag]')).find(node=>node.dataset.flag===f.id);
    if(l2)l2.style.left=nx+'px';
  };
  const fin=(save,m)=>{
    if(save&&typeof SharedWorkspace!=='undefined'&&SharedWorkspace.enabled&&!SharedWorkspace.canEdit)save=false;
    if(finished)return;finished=true;
    document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);
    rt.removeEventListener('scroll',scroll);
    document.removeEventListener('keydown',esc,true);window.removeEventListener('blur',cancel);
    setDragCur(null);dragging=false;
    const nextDate=save&&moved?fD(d0+delta(Number.isFinite(m&&m.clientX)?m.clientX:lastX)):originalDate;
    const changed=save&&nextDate!==originalDate;
    if(changed)f.d=nextDate;
    if(moved){suppressFlagClick=true;setTimeout(()=>suppressFlagClick=false,50)}
    if(moved||!save)render();
    if(changed)schSave();
  };
  const up=m=>{if(!finished)mv(m||{});fin(true,m)};
  const scroll=()=>mv({clientX:lastX});
  const cancel=()=>fin(false);
  const esc=e=>{if(e.key==='Escape'&&!isComposingKey(e)){e.preventDefault();e.stopPropagation();cancel()}};
  document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
  rt.addEventListener('scroll',scroll,{passive:true});
  document.addEventListener('keydown',esc,true);window.addEventListener('blur',cancel);
}

/* Body */
function renderBody(rows){
  const tb=$('#tl-body'),bl=$('#b-layer'),dc=$('#dep-canvas'),gr=$('#g-right'),hd=$('#tl-header');
  // 始终撑满可视区高度，不随任务数量收缩
  const avail=(gr.clientHeight||600)-(hd.offsetHeight||52);
  const totalH=Math.max(rowsHTotal,avail,200);
  tb.style.width=axis.tw+'px';tb.style.height=totalH+'px';
  bl.style.width=axis.tw+'px';bl.style.height=totalH+'px';bl.innerHTML='';
  for(const c of axis.cells){const col=ce('div','grid-col'+(c.wk?' wk':'')+(c.heavy?' heavy':''));col.style.left=c.x+'px';col.style.width=c.w+'px';col.style.height=totalH+'px';bl.appendChild(col)}
  const T=todayD();
  if(T>=bds.mn&&T<=bds.mx){const ln=ce('div','t-line');ln.style.left=((T-bds.mn)*axis.dw+axis.dw/2)+'px';ln.style.height=totalH+'px';bl.appendChild(ln)}
  // 里程碑旗的贯穿竖虚线（与任务重叠正是它的意义）
  for(const f of (proj.flags||[])){
    const d=tD(f.d);if(d<bds.mn||d>bds.mx)continue;
    const ln=ce('div','flag-line');ln.dataset.flag=f.id;ln.style.left=((d-bds.mn)*axis.dw+axis.dw/2)+'px';ln.style.height=totalH+'px';ln.style.borderColor=f.color||'#e03e3e';bl.appendChild(ln);
  }
  for(let i=0;i<rows.length;i++){const{t}=rows[i],y=rowYs[i];if(t.type==='pipeline')rPipe(bl,t,y,rows,i);else if(isSum(t)&&t.flow)renderLane(bl,t,y);else if(t.type==='milestone')rMs(bl,t,y);else rBar(bl,t,y,isSum(t))}
  drawDeps(dc,rows,totalH);
}

/* 流程泳道：父任务作为「容器实体」，直接子项作为流程步骤叠在其上
   - 节点(milestone)在泳道内用「图钉」样式，可与任务条重叠
   - 子父单（含流程子父单）收起为一整条，悬停原地展开显露内部子单 */
function renderLane(ly,parent,y){
  const rg=eRange(parent);
  const geometry=ScheduleBarGeometry.span(rg.s,rg.e,bds.mn,axis.dw),{x,w,paintX,paintWidth}=geometry;
  const col=gc(parent.grp);
  const rh=rowHOf(parent);   // 子项重叠时行高增高，容器随之伸展
  // 父任务容器实体（可点选/编辑/拖动整组/挂依赖）
  const band=ce('div','lane-band');band.dataset.id=parent.id;
  band.style.left=paintX+'px';band.style.width=paintWidth+'px';band.style.top=(y+4)+'px';band.style.height=(rh-8)+'px';
  band.style.background=hexA(col,.10);band.style.color=hexA(col,.40);
  if(selIds.has(parent.id))band.classList.add('selected');
  band.addEventListener('mousedown',e=>{if(e.ctrlKey)sDepD(e,parent);else if(!e.shiftKey)sBarD(e,parent,true)});
  band.addEventListener('click',e=>{e.stopPropagation();if(e.shiftKey)toggleSel(parent.id);else if(!e.ctrlKey)sel(parent.id)});
  band.addEventListener('dblclick',e=>{e.stopPropagation();edOpen(parent.id)});
  bindTip(band,parent);
  ly.appendChild(band);
  bPos[parent.id]={...geometry,y:y+4,h:rh-8,cy:y+RH/2,type:'lane'};
  // 父任务名称标签（放容器左侧外面、右对齐，避免与右端里程碑文字重叠）
  const tag=ce('div','lane-tag',parent.name);tag.dataset.for=parent.id;tag.style.left=(x-8)+'px';tag.style.transform='translateX(-100%)';tag.style.top=y+'px';tag.style.height=rh+'px';tag.style.color=darkenCol(col,.62);ly.appendChild(tag);
  // 子项流程步骤（只渲染直接子级；子父单收起，悬停展开）
  laneItems(ly,parent,y);
}
function laneItems(ly,parent,y,sharedClaims,baseLane=0){
  const{items,map}=laneAssign(parent),coverage=laneCoverage(parent);
  const claimsByLane=sharedClaims||laneClaims(parent);
  for(const c of items){
    const li=map.get(c.id)||0,bt=y+9+li*SUBP;
    const ov=c.type==='milestone'?laneNodeOverlap(coverage,c):null;
    const claimLane=baseLane+(ov?ov.lo:li),claims=claimsByLane[claimLane]||(claimsByLane[claimLane]=[]);
    if(c.type==='milestone')rPin(ly,c,y,claims,bt,ov);
    else if(isSum(c))rLaneSub(ly,c,y,claims,bt,claimsByLane,baseLane+li);
    else rBar(ly,c,y,false,claims,bt);
  }
}
/* 泳道内的子父单：收起为整条；展开时为后代预留子行并重算后续行位置。 */
function rLaneSub(ly,c,y,claims,barTop,sharedClaims,baseLane){
  claims=claims||[];
  const rg=eRange(c),geometry=ScheduleBarGeometry.span(rg.s,rg.e,bds.mn,axis.dw),{x,w,paintX,paintWidth}=geometry;
  const bt=barTop!=null?barTop:y+(RH-22)/2,opened=expandedLanes.has(c.id);
  bPos[c.id]={...geometry,y:bt,h:22,cy:bt+11,type:'task',summary:true,expanded:opened};
  const bar=ce('div','bar lane-sub'+(opened?' ghosted':''));bar.dataset.id=c.id;
  bar.style.left=paintX+'px';bar.style.top=bt+'px';bar.style.width=paintWidth+'px';bar.style.background=gc(c.grp);
  if(selIds.has(c.id))bar.classList.add('selected');
  const lb=ce('span','bar-name',c.name+' ⌄');lb.style.color=barTextCol(gc(c.grp));bar.appendChild(lb);
  claims.push({l:x,r:x+w});
  bar.addEventListener('mousedown',e=>{if(e.ctrlKey)sDepD(e,c);else if(!e.shiftKey)sBarD(e,c,true)});
  bar.addEventListener('click',e=>{e.stopPropagation();if(e.shiftKey)toggleSel(c.id);else if(!e.ctrlKey)sel(c.id)});
  bar.addEventListener('dblclick',e=>{e.stopPropagation();edOpen(c.id)});
  bindTip(bar,c);ly.appendChild(bar);
  const exp=ce('div','lane-exp'+(opened?' show':''));
  // 关闭的后代不产生 DOM 或 bPos；展开基准跟随自身子行，供屏幕和导出共享。
  if(opened)laneItems(exp,c,bt-9,sharedClaims,baseLane||0);
  ly.appendChild(exp);
  const busy=()=>dragging||(typeof sbDrag!=='undefined'&&sbDrag);
  const open=()=>{clearLaneTimer(c.id);if(busy())return;if(!expandedLanes.has(c.id)){expandedLanes.add(c.id);render()}};
  const close=()=>{clearLaneTimer(c.id);if(busy())return;laneCloseTimers.set(c.id,setTimeout(()=>{if(busy()){laneCloseTimers.delete(c.id);return}closeLane(c.id);render()},140))};
  bar.addEventListener('mouseenter',open);bar.addEventListener('mouseleave',close);
  exp.addEventListener('mouseenter',open);exp.addEventListener('mouseleave',close);
}
/* 泳道内的节点：与任务条重叠时显示完整卡尺（标尺卡住重叠条的顶与底，跨多子行时拉长）；
   不与任何条重叠时只显示标头、居中在所选子行（t.lane，默认最上行） */
function rPin(ly,t,y,claims,barTop,ov){
  claims=claims||[];
  const d=tD(t.s),cx=(d-bds.mn)*axis.dw+axis.dw/2;
  const sz=12,s=sz/16,hh=Math.round(17*s);
  const bt=barTop!=null?barTop:y+9;
  let tp,h,ruler=null;
  if(ov){
    const rT=y+9+ov.lo*SUBP, rB=y+9+ov.hi*SUBP+22;   // 标尺上边 = 最上重叠条顶，下边 = 最下重叠条底
    tp=rT-hh-3;h=Math.ceil(hh+3+(rB-rT)+1);ruler={t:rT,b:rB};
  }else{
    tp=bt+11-Math.round(hh/2);h=hh;   // 无重叠：只出标头，垂直居中于所选子行
  }
  bPos[t.id]={x:cx-6,y:tp,w:sz,h,cy:tp+Math.round(7.2*s),cx,type:'ms',ruler,label:null};
  const pin=ce('div','pin');pin.dataset.id=t.id;
  pin.style.left=(cx-6)+'px';pin.style.top=tp+'px';
  pin.style.color=gc(t.grp)||'#e03e3e';
  pin.innerHTML=ov?nodeIconSvg(sz,false,(ruler.b-ruler.t)-0.8):nodeIconSvg(sz,true);
  if(selIds.has(t.id))pin.classList.add('selected');
  pin.addEventListener('mousedown',e=>{if(e.ctrlKey)sDepD(e,t);else if(!e.shiftKey)sBarD(e,t,false)});
  pin.addEventListener('click',e=>{e.stopPropagation();if(e.shiftKey)toggleSel(t.id);else if(!e.ctrlKey)sel(t.id)});
  pin.addEventListener('dblclick',e=>{e.stopPropagation();edOpen(t.id)});
  bindTip(pin,t);
  ly.appendChild(pin);
  // 图钉标签也参与同行避让；放不下只留图钉（悬停看名）
  claims.push({l:cx-6,r:cx+6});
  const pw=textW(t.name,10)+10,l=cx+6+6,r=l+pw;
  if(claimsFree(claims,l,r)&&r<=axis.tw-2){
    const lb=ce('span','pin-label',t.name);lb.dataset.for=t.id;lb.style.left=l+'px';lb.style.top=tp+'px';ly.appendChild(lb);
    bPos[t.id].label={x:l,y:tp,text:t.name,fontSize:10,height:14};
    claims.push({l,r});
  }
}
// hex → rgba
function hexA(h,a){if(!h||h[0]!=='#')return `rgba(100,116,139,${a})`;const n=parseInt(h.slice(1),16);return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`}
// 相对亮度；条内文字在白与深墨之间取对比度更高者（浅色条自动换深字）
function lumOf(h){
  if(typeof h!=='string'||!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(h))return 0;
  let hex=h.slice(1);if(hex.length===3)hex=hex.split('').map(c=>c+c).join('');
  const n=parseInt(hex,16);
  const c=[(n>>16)&255,(n>>8)&255,n&255].map(v=>{v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4)});
  return .2126*c[0]+.7152*c[1]+.0722*c[2];
}
function barTextCol(bg){
  const L=lumOf(bg),dark='#050505';
  return 1.05/(L+.05)>=(L+.05)/(lumOf(dark)+.05)?'#fff':dark;
}
// 进度覆盖朝文字的相反方向变亮/变暗，保持完成区和未完成区都可读。
function barProgressCol(bg){return barTextCol(bg)==='#fff'?'rgba(0,0,0,.18)':'rgba(255,255,255,.35)'}
function darkenCol(h,f){if(!h||h[0]!=='#')return h;const n=parseInt(h.slice(1),16);return `rgb(${((n>>16)&255)*f|0},${((n>>8)&255)*f|0},${(n&255)*f|0})`}

function rBar(ly,t,y,sum,claims,barTop){
  claims=claims||[];
  const rng=sum?eRange(t):{s:tD(t.s),e:tD(t.e)};
  const geometry=ScheduleBarGeometry.span(rng.s,rng.e,bds.mn,axis.dw),{x,w,paintX,paintWidth}=geometry;
  const bh=sum?10:22,top=barTop!=null?barTop:y+(RH-bh)/2;
  bPos[t.id]={...geometry,y:top,h:bh,cy:top+bh/2,type:sum?'sum':'task'};
  const bar=ce('div','bar'+(sum?' summary':''));
  bar.dataset.id=t.id;bar.style.left=paintX+'px';bar.style.top=top+'px';bar.style.width=paintWidth+'px';
  if(!sum)bar.style.background=gc(t.grp);
  if(selIds.has(t.id))bar.classList.add('selected');
  if(crit.has(t.id))bar.classList.add('crit');
  if(cf.has(t.id)&&!sum)bar.classList.add('conflict-outline');
  if(!sum){
    const pc=t.pct||0;if(pc>0){const pf=ce('div','bar-pct');pf.style.background=barProgressCol(gc(t.grp));pf.style.width=pc+'%';bar.appendChild(pf)}
    bar.appendChild(mkH('left'));bar.appendChild(mkH('right'));
    // 名字始终在条内，超出部分省略号截断（完整名称看悬浮详情）
    const lb=ce('span','bar-name',t.name);lb.style.color=barTextCol(gc(t.grp));bar.appendChild(lb);
    claims.push({l:x,r:x+w});
    if(cf.has(t.id)){const wn=ce('div','bar-err');wn.innerHTML=ICON.warn;wn.dataset.for=t.id;wn.style.left=(x+w+4)+'px';wn.style.top=(top-6)+'px';wn.title='工期冲突：开始日期在其依赖完成之前';ly.appendChild(wn)}
  }else{
    // 父任务名称：水平居中悬于汇总条正上方
    const o=ce('div','bar-out chip',t.name);o.dataset.for=t.id;
    o.style.left=(x+w/2)+'px';o.style.transform='translateX(-50%)';
    o.style.top=(y+1)+'px';o.style.height='14px';
    o.style.fontWeight='700';o.style.fontSize='11.5px';
    ly.appendChild(o);
  }
  bar.addEventListener('mousedown',e=>{if(e.ctrlKey)sDepD(e,t);else if(!e.shiftKey)sBarD(e,t,sum)});
  bar.addEventListener('click',e=>{e.stopPropagation();if(e.shiftKey)toggleSel(t.id);else if(!e.ctrlKey)sel(t.id)});
  bar.addEventListener('dblclick',e=>{e.stopPropagation();edOpen(t.id)});
  bindTip(bar,t);
  ly.appendChild(bar);
}
function mkH(sd){const h=ce('div','bar-handle '+sd);h.dataset.handle=sd;return h}

/* 标签自适应布局：实测文字宽度，条内放得下进条内；否则右侧白底药丸；
   右侧被占/出界改放左侧；都放不下只显条（悬停看 tooltip）。同行贪心避让。 */
let _measCtx=null,_measFam='';
function textW(s,size){
  if(!_measCtx){_measCtx=document.createElement('canvas').getContext('2d');_measFam=getComputedStyle(document.body).fontFamily}
  _measCtx.font=size+'px '+_measFam;
  return _measCtx.measureText(s).width;
}
function claimsFree(claims,l,r){return !claims.some(c=>l<c.r+4&&r>c.l-4)}
/* 管线：容器区域画法——虚线圆角大框从自身行罩到全部可见子行，
   顶部加深表头带显示管线名与任务数，"包含"关系一目了然 */
function rPipe(ly,t,y,rows,idx){
  const tb=taskBounds();
  const geometry=ScheduleBarGeometry.span(tb.mn,tb.mx,bds.mn,axis.dw),{x,w,paintX,paintWidth}=geometry;
  // 包含区域高度 = 自身行 + 紧随其后的可见后代行
  const dset=new Set(desc(t.id).map(d=>d.id));
  let n=0;while(rows&&rows[idx+1+n]&&dset.has(rows[idx+1+n].t.id))n++;
  const endIdx=idx+n;
  const regionH=(rowYs[endIdx]+rowHOf(rows[endIdx].t))-rowYs[idx];
  const region=ce('div','pipe-region');
  region.style.left=paintX+'px';region.style.top=(y+3)+'px';
  region.style.width=paintWidth+'px';region.style.height=(regionH-6)+'px';
  ly.appendChild(region);
  bPos[t.id]={...geometry,y:y+3,h:RH-6,cy:y+RH/2,type:'pipe'};
  const hd=ce('div','pipe-head'+(n?'':' solo'));hd.dataset.id=t.id;
  hd.style.left=paintX+'px';hd.style.top=(y+3)+'px';hd.style.width=paintWidth+'px';hd.style.height=(RH-6)+'px';
  if(selIds.has(t.id))hd.classList.add('selected');
  const cnt=desc(t.id).filter(k=>!isSum(k)&&k.type!=='milestone').length;
  hd.appendChild(ce('span','pipe-label','▦ '+t.name+(cnt?`　·　${cnt} 项任务`:'　·　空管线，在下面建功能模块')));
  hd.addEventListener('mousedown',e=>{if(e.ctrlKey)sDepD(e,t);else if(!e.shiftKey)sBarD(e,t,isSum(t))});
  hd.addEventListener('click',e=>{e.stopPropagation();if(e.shiftKey)toggleSel(t.id);else if(!e.ctrlKey)sel(t.id)});
  hd.addEventListener('dblclick',e=>{e.stopPropagation();edOpen(t.id)});
  bindTip(hd,t);
  ly.appendChild(hd);
}

/* 悬停信息浮层 */
function bindTip(elm,t){
  const tip=$('#tooltip');
  const addLine=(label,value)=>{
    const row=ce('div');
    if(label)row.appendChild(ce('span','tt-k',label));
    row.appendChild(document.createTextNode(String(value==null?'':value)));
    tip.appendChild(row);
  };
  const addCategory=(color,value)=>{
    const row=ce('div'),dot=ce('span','tt-dot');
    dot.style.backgroundColor=typeof color==='string'&&/^#[0-9a-f]{6}$/i.test(color)?color:'#6b7280';
    row.appendChild(dot);
    row.appendChild(document.createTextNode(value));
    tip.appendChild(row);
  };
  const show=ev=>{
    if(dragging||(typeof sbDrag!=='undefined'&&sbDrag)){tip.classList.remove('show');return} // 拖拽/平移时不显示
    tip.replaceChildren(ce('b',null,t.name));
    if(t.type==='pipeline'){
      const n=desc(t.id).filter(k=>!isSum(k)&&k.type!=='milestone').length;
      addCategory('#4e5969','管线 · 贯穿项目周期');
      addLine('包含',n+' 项任务');
      tip.classList.add('show');moveTip(ev);return;
    }
    const sm=isSum(t);
    const rng=sm?eRange(t):{s:tD(t.s),e:tD(t.e)};
    const rawPct=Number(sm?sumPct(t):t.pct);
    const pc=Number.isFinite(rawPct)?Math.max(0,Math.min(100,rawPct)):0;
    const dur=rng.e-rng.s+1;
    const gCol=t.type==='milestone'?'#e03e3e':gc(t.grp);
    addCategory(gCol,(t.type==='milestone'?'重要节点':(sm?'父任务':'任务'))+' · '+(t.grp||'')+(t.phase?' · '+t.phase:''));
    if(t.who)addLine('负责人',t.who);
    if(t.type==='milestone')addLine('日期',fD(rng.s));
    else{
      addLine('周期',fD(rng.s)+' → '+fD(rng.e)+'（'+dur+'天）');
      addLine('进度',pc+'%');
    }
    const dn=Array.isArray(t.deps)?t.deps.length:0;
    if(dn)addLine('依赖',dn+' 个前置');
    tip.classList.add('show');moveTip(ev);
  };
  const moveTip=ev=>{
    const pad=14,w=tip.offsetWidth,ht=tip.offsetHeight;
    let x=ev.clientX+pad,yy=ev.clientY+pad;
    if(x+w>innerWidth-8)x=ev.clientX-w-pad;
    if(yy+ht>innerHeight-8)yy=ev.clientY-ht-pad;
    tip.style.left=x+'px';tip.style.top=yy+'px';
  };
  elm.addEventListener('mouseenter',show);
  elm.addEventListener('mousemove',ev=>{if(tip.classList.contains('show'))moveTip(ev)});
  elm.addEventListener('mouseleave',()=>tip.classList.remove('show'));
  elm.addEventListener('mousedown',()=>tip.classList.remove('show'));
}
function esc(s){return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}

/* Toast 轻提示 */
function toast(msg,type,dur){
  type=type||'success';
  const wrap=$('#toast-wrap');
  const el=ce('div','toast '+type);
  el.setAttribute('role','status');
  const ico=ce('span','tico',type==='warn'?'!':(type==='info'?'i':'✓'));
  el.appendChild(ico);el.appendChild(ce('span',null,msg));
  wrap.appendChild(el);
  setTimeout(()=>{el.classList.add('out');setTimeout(()=>el.remove(),260)},dur||2000);
}
function rMs(ly,t,y){
  const d=tD(t.s),cx=(d-bds.mn)*axis.dw+axis.dw/2;
  const sz=zoom==='month'?12:16,s=sz/16,hh=Math.round(17*s);
  const tp=y+Math.round((RH-hh)/2);   // 独立行内没有可卡的任务条：只出标头，垂直居中
  bPos[t.id]={x:cx-sz/2,y:tp,w:sz,h:hh,cy:tp+Math.round(7.2*s),cx,type:'ms',ruler:null};
  const dg=ce('div','pin node');dg.dataset.id=t.id;
  dg.style.left=(cx-sz/2)+'px';dg.style.top=tp+'px';
  dg.style.color=gc(t.grp)||'#e03e3e';
  dg.innerHTML=nodeIconSvg(sz,true);
  if(selIds.has(t.id))dg.classList.add('selected');
  dg.addEventListener('mousedown',e=>{if(e.ctrlKey)sDepD(e,t);else if(!e.shiftKey)sBarD(e,t,false)});
  dg.addEventListener('click',e=>{e.stopPropagation();if(e.shiftKey)toggleSel(t.id);else if(!e.ctrlKey)sel(t.id)});
  dg.addEventListener('dblclick',e=>{e.stopPropagation();edOpen(t.id)});
  bindTip(dg,t);
  ly.appendChild(dg);
  const lb=ce('div','ms-label',`${t.name} ${fmtS(d)}`);lb.dataset.for=t.id;lb.style.left=(cx+sz/2+6)+'px';lb.style.top=tp+'px';lb.style.height=hh+'px';ly.appendChild(lb);
}

/* Deps Canvas —— 视口虚拟化：画布只覆盖可视区附近，随滚动重绘
   （无限日历下内容可远超 canvas 32767px 尺寸上限，故不能整幅铺画布） */
let depRows=null,depH=0,depRaf=null,depPixelScale=0,depPreview=null;
function schDepDraw(){if(depRaf)return;depRaf=requestAnimationFrame(()=>{depRaf=null;if(depRows)drawDeps($('#dep-canvas'),depRows,depH)})}
function refreshCanvasViewport(){
  if(!axis)return;
  const rt=$('#g-right'),header=$('#tl-header'),body=$('#tl-body'),layer=$('#b-layer');
  const height=Math.max(rowsHTotal,(rt.clientHeight||600)-(header.offsetHeight||52),200),cssHeight=height+'px';
  if(body.style.height!==cssHeight){
    body.style.height=cssHeight;layer.style.height=cssHeight;
    for(const node of layer.querySelectorAll('.grid-col,.t-line,.flag-line'))node.style.height=cssHeight;
  }
  depH=height;schDepDraw();
}
function depViewportCovered(){
  if(!axis||!depRows)return false;
  const rt=$('#g-right'),cv=$('#dep-canvas'),left=parseFloat(cv.style.left),top=parseFloat(cv.style.top);
  const width=parseFloat(cv.style.width),height=parseFloat(cv.style.height);
  const desired=Math.max(1,(window.devicePixelRatio||1)*canvasScaleFactor());
  return Math.abs(desired-depPixelScale)<.0001&&Number.isFinite(left)&&Number.isFinite(top)&&
    left<=rt.scrollLeft+.01&&left+width>=Math.min(axis.tw,rt.scrollLeft+rt.clientWidth)-.01&&
    top<=(rt.scrollTop||0)+.01&&top+height>=Math.min(depH,(rt.scrollTop||0)+rt.clientHeight)-.01;
}
function drawDeps(cv,rows,totalH){
  depRows=rows;depH=totalH;
  const rt=$('#g-right');
  const vw=Math.min(axis.tw,(rt.clientWidth||800)+800);
  const sl=Math.max(0,Math.min(rt.scrollLeft-400,axis.tw-vw));
  const vh=Math.min(totalH,(rt.clientHeight||600)+400),st=Math.max(0,Math.min((rt.scrollTop||0)-200,totalH-vh));
  // Zoom affects bitmap density, never the logical date/row coordinates. Both
  // axes are virtualised so a 10,000-row project cannot allocate a huge canvas.
  const desired=Math.max(1,(window.devicePixelRatio||1)*canvasScaleFactor());
  depPixelScale=desired;
  const density=Math.min(desired,32760/vw,32760/vh,Math.sqrt(16000000/(vw*vh)));
  cv.width=Math.max(1,Math.floor(vw*density));cv.height=Math.max(1,Math.floor(vh*density));
  cv.style.width=vw+'px';cv.style.height=vh+'px';cv.style.left=sl+'px';cv.style.top=st+'px';
  const rx=cv.width/vw,ry=cv.height/vh,ctx=cv.getContext('2d');ctx.setTransform(rx,0,0,ry,-sl*rx,-st*ry);
  const visible=proj.tasks.filter(t=>bPos[t.id]&&!bPos[t.id].hidden),vs=new Set(visible.map(t=>t.id));
  const arrow=(fr,to,isC,fromId,toId)=>{
    if(Math.max(fr.cy,to.cy)<st-16||Math.min(fr.cy,to.cy)>st+vh+16)return;
    const route=ScheduleBarGeometry.connector(fr,to),bounds=ScheduleBarGeometry.connectorBounds(route);
    if(bounds.right<sl-16||bounds.left>sl+vw+16)return;
    const emphasis=typeof ScheduleHighlights!=='undefined'?ScheduleHighlights.edgeState(fromId,toId):{highlighted:false,opacity:1};
    const color=isC?'#f53f3f':(emphasis.highlighted?'#087e8b':'#86909c');
    ctx.globalAlpha=emphasis.opacity;
    ctx.shadowColor=emphasis.highlighted?'#36c9d6':'transparent';ctx.shadowBlur=emphasis.highlighted?5:0;
    ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=emphasis.highlighted?2.6:(isC?2.2:1.4);
    ctx.setLineDash(route.kind==='adjacent-inline'?[]:(isC?[7,3]:[5,5]));ctx.lineCap='round';ctx.lineJoin='round';
    ScheduleBarGeometry.traceConnector(ctx,route);
    ctx.stroke();ctx.setLineDash([]);
    ctx.beginPath();ctx.fillStyle=color;
    if(ScheduleBarGeometry.traceArrow(ctx,route))ctx.fill();
    ctx.globalAlpha=1;ctx.shadowBlur=0;ctx.shadowColor='transparent';
  };
  for(const t of visible){
    if(!t.deps||!t.deps.length)continue;const to=bPos[t.id];
    for(const dp of t.deps){if(!vs.has(dp))continue;const fr=bPos[dp];if(!fr)continue;
      arrow(fr,to,isCriticalDep(dp,t.id),dp,t.id);
    }
  }
  if(depPreview&&bPos[depPreview.id]){
    const point=canvasClientPoint(depPreview,$('#tl-body'));
    const route=ScheduleBarGeometry.connector(bPos[depPreview.id],{type:'ms',cx:point.x,cy:point.y});
    ctx.beginPath();ctx.strokeStyle='#3370ff';ctx.lineWidth=2.2;ctx.setLineDash(route.kind==='adjacent-inline'?[]:[7,4]);
    ScheduleBarGeometry.traceConnector(ctx,route);ctx.stroke();ctx.setLineDash([]);
    ctx.beginPath();ctx.fillStyle='#3370ff';if(ScheduleBarGeometry.traceArrow(ctx,route))ctx.fill();
  }
  // （流程自动串联已移除：连接线只由显式依赖关系产生）
}

/* Ctrl-drag dep */
function sDepD(e,ft){
  if(typeof mayEditProject==='function'&&!mayEditProject('调整任务依赖'))return;
  if(e.button!==0)return;e.preventDefault();e.stopPropagation();
  if(ft.type==='pipeline'){toast('管线贯穿项目周期，不参与依赖','warn');return}
  const cv=$('#dep-canvas'),fr=bPos[ft.id];if(!fr)return;
  const rt=$('#g-right');setDragCur('drag-cross');dragging=true;
  depPreview={id:ft.id,clientX:e.clientX,clientY:e.clientY};
  const mv=ev=>{depPreview={id:ft.id,clientX:ev.clientX,clientY:ev.clientY};schDepDraw()};
  const scroll=()=>schDepDraw();
  const cleanup=()=>{document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);document.removeEventListener('keydown',cancelKey,true);window.removeEventListener('blur',cancel);rt.removeEventListener('scroll',scroll);depPreview=null;setDragCur(null);dragging=false;schDepDraw();};
  const cancel=()=>{cleanup();render()};
  const cancelKey=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancel()}};
  const up=ev=>{cleanup();if(typeof mayEditProject==='function'&&!mayEditProject('调整任务依赖')){render();return}let toId=null;const ep=document.elementFromPoint(ev.clientX,ev.clientY);if(ep){const b=ep.closest('.bar,.ms,.pin,.lane-band,.pipe-head');if(b&&b.dataset&&b.dataset.id)toId=b.dataset.id;else{const l=ep.closest('.pin-label,.ms-label');if(l&&l.dataset&&l.dataset.for)toId=l.dataset.for}}if(!toId||toId===ft.id){render();return}const tt=byId(toId);if(!tt){render();return}if(tt.type==='pipeline'){toast('管线贯穿项目周期，不参与依赖','warn');render();return}if((tt.deps||[]).includes(ft.id)){render();return}const deps=[...(tt.deps||[]),ft.id],depError=validateDependencies(tt.id,deps);if(depError){toast(depError,'warn',4200);render();return}tt.deps=deps;render();schSave();
    if(tt.pid!==ft.pid)toast(`已建立跨层级依赖：${ft.name} → ${tt.name}（建议同层级之间建依赖，父级对父级）`,'warn',4200);
    else flash(`已建立依赖：${ft.name} → ${tt.name}`)};
  document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
  rt.addEventListener('scroll',scroll,{passive:true});
  document.addEventListener('keydown',cancelKey,true);window.addEventListener('blur',cancel);
}

/* Dbl-click empty */
function bindDblEmpty(tb){tb.addEventListener('dblclick',e=>{if(e.target.closest('.bar,.ms,.pin,.lane-band,.pipe-head,.flag'))return;const point=canvasClientPoint(e,tb),day=Math.floor(point.x/axis.dw)+bds.mn;newAtDay(day,'task')})}
function newAtDay(day,type){if(typeof mayEditProject==='function'&&!mayEditProject('新建任务'))return;const s=day,t={id:uid(),name:type==='milestone'?'新节点':'新任务',pid:null,type,s:fD(s),e:fD(type==='milestone'?s:s+4),pct:0,who:'',grp:proj.groups[0]?proj.groups[0].name:'其他',deps:[],fold:false};proj.tasks.push(t);sel(t.id);render();schSave();edOpen(t.id)}
