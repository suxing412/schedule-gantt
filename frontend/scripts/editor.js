/* Editor */
let eId=null;
// 阶段列表按"该阶段最早任务的开始日"排序，自然呈时间线
function phaseList(){
  const m=new Map();
  for(const t of proj.tasks){if(!t.phase)continue;const s=tD(t.s);if(!m.has(t.phase)||s<m.get(t.phase))m.set(t.phase,s)}
  return Array.from(m.entries()).sort((a,b)=>a[1]-b[1]).map(x=>x[0]);
}
function edOpen(id){if(typeof mayEditProject==='function'&&!mayEditProject('编辑任务'))return;const t=byId(id);if(!t)return;eId=id;const sm=isSum(t);$('#dlg-title').textContent=t.type==='pipeline'?'编辑管线':(sm?'编辑父任务':'编辑任务');$('#f-name').value=t.name;$('#f-type').value=t.type;$('#f-type').disabled=sm||t.type==='pipeline';$('#f-assignee').value=t.who||'';const gs=$('#f-group');gs.innerHTML='';for(const g of proj.groups){const o=ce('option',null,g.name);o.value=g.name;if(g.name===t.grp)o.selected=true;gs.appendChild(o)}
  $('#f-phase').value=t.phase||'';
  const pl=$('#phase-list');pl.innerHTML='';for(const p of phaseList()){const o=ce('option');o.value=p;pl.appendChild(o)}
  // 父任务：日期/进度显示汇总值且只读；叶子任务：可编辑
  const rg=sm?eRange(t):{s:tD(t.s),e:tD(t.e)};
  $('#f-start').value=sm?fD(rg.s):t.s;$('#f-end').value=sm?fD(rg.e):t.e;
  const pc=sm?sumPct(t):(t.pct||0);$('#f-progress').value=pc;$('#f-pctv').textContent=pc;
  $('#f-start').disabled=sm;$('#f-end').disabled=sm;$('#f-progress').disabled=sm;
  // 管线：无职能、无起止日期、无依赖，贯穿项目周期
  const isPipe=t.type==='pipeline';
  $('.f-lbl-grp').style.display=isPipe?'none':'';
  $('#f-deps-block').style.display=isPipe?'none':'';
  $('#f-sum-hint').innerHTML=isPipe
    ?'管线用于组织功能模块，时间覆盖整个项目周期。可以在管线下添加子任务。'
    :'父任务的日期与进度由子任务自动汇总。编辑子任务调整时间，或拖动父任务整体移动排期。';
  $('#f-sum-hint').style.display=(sm||isPipe)?'block':'none';
  // 节点在多行流程中可选所在行列（默认最上行）；仅当父级开了流程且实际分出多行时展示
  const par=t.pid?byId(t.pid):null;
  const laneDepth=(par&&par.flow&&isSum(par)&&par.type!=='pipeline')?laneAssign(par).depth:1;
  $('.f-lbl-lane').dataset.depth=laneDepth;
  const ls=$('#f-lane');ls.innerHTML='';
  for(let i=0;i<laneDepth;i++){const o=ce('option',null,'第'+(i+1)+'行'+(i===0?'（最上）':''));o.value=i;ls.appendChild(o)}
  ls.value=Math.max(0,Math.min(t.lane||0,laneDepth-1));
  editDeps=(t.deps||[]).filter(id=>byId(id));$('#f-deps-search').value='';hideDepSug();renderDepChips();applyTypeVis();$('#f-flow').checked=!!t.flow;$('.f-lbl-flow').style.display=sm?'flex':'none';
  if(isPipe){$('.f-lbl-start').style.display='none';$('.f-lbl-end').style.display='none';$('.f-lbl-pct').style.display='none';$('.f-lbl-flow').style.display='none'}
  renderCustomTaskFields(t);
  openOvl($('#ovl'));
  setTimeout(()=>{if($('#ovl').hidden||$('#ovl').classList.contains('closing'))return;const n=$('#f-name');n.focus();n.select()},30)}
function taskPath(t){const ps=[];let p=t.pid;while(p){const pt=byId(p);if(!pt)break;ps.unshift(pt.name);p=pt.pid}return ps.join(' / ')}
/* 依赖选择：已选显示为标签，搜索框智能推荐（最多 8 条，避免长列表） */
let editDeps=[];
function renderDepChips(){
  const box=$('#dep-chips');box.innerHTML='';
  for(const id of editDeps){
    const c=byId(id);if(!c)continue;
    const ch=ce('span','dep-chip');
    const d=ce('span','dc-dot');d.style.background=c.type==='milestone'?'#e03e3e':gc(c.grp);ch.appendChild(d);
    ch.appendChild(ce('span',null,c.name));
    const x=ce('button','dc-x','×');x.type='button';x.title='移除该前置';x.setAttribute('aria-label','移除前置任务 '+c.name);
    x.addEventListener('click',()=>{editDeps=editDeps.filter(i=>i!==id);renderDepChips();$('#f-deps-search').focus()});
    ch.appendChild(x);
    box.appendChild(ch);
  }
  if(!editDeps.length)box.appendChild(ce('span','dep-none','暂无前置，任务可随时开始'));
  $('#f-deps-count').textContent=editDeps.length?`已选 ${editDeps.length}`:'';
}
function depCandidates(q){
  const t=byId(eId);if(!t)return[];
  const chosen=new Set(editDeps),graph=buildDependencyGraph(proj.tasks,{id:eId,deps:editDeps});
  if(!topoDependencyGraph(graph))return[];
  // 从本任务入口可达的出口不能作为前置，统一排除传递依赖以及父子屏障造成的隐含环。
  const blocked=new Set(),stack=[graph.entry.get(eId)];
  while(stack.length){const id=stack.pop();if(blocked.has(id))continue;blocked.add(id);for(const edge of graph.adj[id])stack.push(edge.to)}
  const myS=eRange(t).s;
  q=(q||'').trim().toLowerCase();
  // 推荐同父级兄弟；跨层依赖可通过 Ctrl 拖线建立，使用相同的图校验。
  let cs=proj.tasks.filter(x=>x.id!==eId&&!chosen.has(x.id)&&x.pid===t.pid&&x.type!=='pipeline'&&!blocked.has(graph.exit.get(x.id)));
  if(q)cs=cs.filter(x=>((x.name||'')+' '+(x.who||'')+' '+(x.grp||'')).toLowerCase().includes(q));
  cs.sort((a,b)=>{
    const ea=eRange(a).e,eb=eRange(b).e;
    const group=(ea<=myS?0:1)-(eb<=myS?0:1);
    return group||Math.abs(myS-ea)-Math.abs(myS-eb);
  });
  return cs.slice(0,8);
}
function showDepSug(){
  const sug=$('#dep-sug'),q=$('#f-deps-search').value;
  const cs=depCandidates(q);
  sug.innerHTML='';
  if(!cs.length)sug.appendChild(ce('div','dep-sug-empty',q?'没有匹配的任务':'没有可选的前置任务'));
  for(const c of cs){
    const it=ce('div','dep-sug-item');
    const d=ce('span','fd-dot');
    if(c.type==='milestone'){d.innerHTML=nodeIconSvg(10,true);d.style.color=gc(c.grp)||'#e03e3e';d.style.display='inline-flex'}
    else{d.textContent='●';d.style.color=gc(c.grp)}
    it.appendChild(d);
    const main=ce('div','fd-main');main.appendChild(ce('div','fd-name',c.name));
    const pth=taskPath(c);if(pth)main.appendChild(ce('div','fd-path',pth));
    it.appendChild(main);
    const rg=isSum(c)?eRange(c):{s:tD(c.s),e:tD(c.e)};
    it.appendChild(ce('span','fd-date',c.type==='milestone'?fmtS(rg.s):fmtS(rg.s)+'–'+fmtS(rg.e)));
    it.addEventListener('mousedown',ev=>{ev.preventDefault();const deps=[...editDeps,c.id],depError=validateDependencies(eId,deps);if(depError){toast(depError,'warn',4200);return}editDeps=deps;renderDepChips();$('#f-deps-search').value='';showDepSug()});
    sug.appendChild(it);
  }
  sug.hidden=false;
}
function hideDepSug(){$('#dep-sug').hidden=true}
function applyTypeVis(){const isMs=$('#f-type').value==='milestone';$('.f-lbl-start').style.display='';$('.f-lbl-end').style.display=isMs?'none':'';$('.f-lbl-pct').style.display=isMs?'none':'';$('.f-lbl-start').firstChild.nodeValue=isMs?'日期':'开始';
  $('.f-lbl-lane').style.display=(isMs&&Number($('.f-lbl-lane').dataset.depth||1)>1)?'':'none'}
function edClose(){eId=null;closeOvl($('#ovl'))}
function edSave(){if(typeof mayEditProject==='function'&&!mayEditProject('保存任务'))return;const t=byId(eId);if(!t)return edClose();const customEdit=parseCustomTaskValues();if(customEdit.error){fieldsError(customEdit.error,customEdit.input);return}const depError=validateDependencies(t.id,editDeps);if(depError){toast(depError,'warn',4200);return}const sm=isSum(t);t.name=$('#f-name').value.trim()||'未命名任务';if(!$('#f-type').disabled)t.type=$('#f-type').value;t.who=$('#f-assignee').value.trim();if(t.type!=='pipeline')t.grp=$('#f-group').value;t.phase=$('#f-phase').value.trim();
  if(sm){t.flow=$('#f-flow').checked}  // 父任务：起止/进度自动汇总，不写
  else if(t.type==='milestone'){t.s=$('#f-start').value||t.s;t.e=t.s;t.pct=0;t.lane=Number($('#f-lane').value)||0}
  else{t.s=$('#f-start').value||t.s;t.e=$('#f-end').value||t.e;if(tD(t.e)<tD(t.s))t.e=t.s;t.pct=Number($('#f-progress').value)}
  t.deps=editDeps.slice();t.customValues=customEdit.values;edClose();render();schSave()}

/* 里程碑旗：顶部日期栏的旗子 + 贯穿竖虚线，不占任务行，可与任务重叠 */
let flId=null, flColor='#e03e3e';
function flags(){if(!Array.isArray(proj.flags))proj.flags=[];return proj.flags}
function flagOpen(id,day){
  if(typeof mayEditProject==='function'&&!mayEditProject('编辑里程碑'))return;
  flId=id;
  const f=id?flags().find(x=>x.id===id):null;
  $('#flag-title').textContent=f?'编辑里程碑':'新建里程碑';
  $('#fl-name').value=f?f.name:'';
  $('#fl-date').value=f?f.d:fD(day!=null?day:todayD());
  flColor=f?(f.color||'#e03e3e'):'#e03e3e';
  renderFlagColors();
  $('#fl-del').style.display=f?'':'none';
  openOvl($('#flag-ovl'));
  setTimeout(()=>{if($('#flag-ovl').hidden||$('#flag-ovl').classList.contains('closing'))return;const n=$('#fl-name');n.focus();n.select()},30);
}
function flagClose(){flId=null;closeOvl($('#flag-ovl'))}
function renderFlagColors(){
  const box=$('#fl-colors');box.innerHTML='';
  const cols=[...new Set(['#e03e3e',...proj.groups.map(g=>g.color)])];
  for(const c of cols){
    const b=ce('button','fl-sw'+(c===flColor?' on':''));b.type='button';b.style.background=c;
    const nm=c==='#e03e3e'?'红（默认）':((proj.groups.find(g=>g.color===c)||{}).name||c);
    b.title=nm;b.setAttribute('aria-label',nm);b.setAttribute('aria-pressed',c===flColor?'true':'false');
    b.addEventListener('click',()=>{const focused=document.activeElement===b;flColor=c;renderFlagColors();if(focused)$('#fl-colors .fl-sw.on').focus()});
    box.appendChild(b);
  }
}
function flagSave(){
  if(typeof mayEditProject==='function'&&!mayEditProject('保存里程碑'))return;
  const name=$('#fl-name').value.trim()||'里程碑';
  const d=$('#fl-date').value;if(!d){toast('请选择日期','warn');return}
  if(flId){const f=flags().find(x=>x.id===flId);if(f){f.name=name;f.d=d;f.color=flColor}}
  else flags().push({id:uid(),name,d,color:flColor});
  flagClose();render();schSave();
}
function flagDel(){
  if(typeof mayEditProject==='function'&&!mayEditProject('删除里程碑'))return;
  proj.flags=flags().filter(x=>x.id!==flId);
  flagClose();render();schSave();
  toast('已删除里程碑 · Ctrl+Z 可撤销','info');
}
