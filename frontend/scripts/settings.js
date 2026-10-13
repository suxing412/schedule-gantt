/* 设置页面：职能管理 / 阶段管理 / 默认视图 */
function metaRoleColors(){if(!proj.meta.roleColors)proj.meta.roleColors={};return proj.meta.roleColors}
function hiddenRoles(){if(!Array.isArray(proj.meta.hiddenRoles))proj.meta.hiddenRoles=[];return proj.meta.hiddenRoles}
function setOpen(){renderSettings();openOvl($('#set-ovl'))}
function setClose(){closeOvl($('#set-ovl'))}
function helpClose(){closeOvl($('#help-ovl'))}
function renderSettings(){
  // 职能列表
  const box=$('#set-roles');box.innerHTML='';
  for(const g of proj.groups){
    const row=ce('div','set-row');
    const cp=ce('input');cp.type='color';cp.value=g.color;cp.title='修改颜色';cp.setAttribute('aria-label',g.name+'职能颜色');
    cp.addEventListener('input',()=>{if(!mayEditProject('修改职能')){cp.value=g.color;return}g.color=cp.value;metaRoleColors()[g.name]=cp.value;render();schSave()});
    const nm=ce('input','set-name');nm.type='text';nm.value=g.name;nm.setAttribute('aria-label',g.name+'职能名称');
    nm.addEventListener('change',()=>{
      if(!mayEditProject('修改职能')){nm.value=g.name;return}
      const nv=nm.value.trim();
      if(!nv||nv===g.name){nm.value=g.name;return}
      if(['constructor','prototype','__proto__'].includes(nv)){toast('该名称不能作为职能名称，请换一个名称','warn');nm.value=g.name;return}
      if(proj.groups.some(x=>x!==g&&x.name===nv)){toast('已存在同名职能','warn');nm.value=g.name;return}
      const old=g.name;
      for(const t of proj.tasks){if(t.grp===old)t.grp=nv}
      if(GROUPS.some(x=>x.name===old)&&!hiddenRoles().includes(old))hiddenRoles().push(old);
      delete metaRoleColors()[old];metaRoleColors()[nv]=g.color;
      g.name=nv;
      if(filterGrp===old)filterGrp=nv;
      render();schSave();renderSettings();
    });
    const n=proj.tasks.filter(t=>t.grp===g.name).length;
    const cnt=ce('span','set-cnt',n?`${n} 项`:'未使用');
    const del=ce('button','dlg-close');del.innerHTML='&times;';del.title='删除职能';del.setAttribute('aria-label','删除职能 '+g.name);
    del.addEventListener('click',()=>{
      if(!mayEditProject('删除职能'))return;
      if(n){toast(`「${g.name}」还有 ${n} 项任务在使用，先改掉它们的职能再删`,'warn',3200);return}
      proj.groups=proj.groups.filter(x=>x!==g);
      if(GROUPS.some(x=>x.name===g.name)&&!hiddenRoles().includes(g.name))hiddenRoles().push(g.name);
      delete metaRoleColors()[g.name];
      if(filterGrp===g.name)filterGrp=null;
      render();schSave();renderSettings();
    });
    row.appendChild(cp);row.appendChild(nm);row.appendChild(cnt);row.appendChild(del);
    box.appendChild(row);
  }
  // 阶段列表
  const pb=$('#set-phases');pb.innerHTML='';
  const phs=phaseList();
  if(!phs.length)pb.appendChild(ce('div','dep-hint','暂无阶段'));
  for(const p of phs){
    const row=ce('div','set-row');
    const nm=ce('input','set-name');nm.type='text';nm.value=p;nm.setAttribute('aria-label',p+'阶段名称');
    nm.addEventListener('change',()=>{
      if(!mayEditProject('修改阶段')){nm.value=p;return}
      const nv=nm.value.trim();if(!nv||nv===p){nm.value=p;return}
      for(const t of proj.tasks){if(t.phase===p)t.phase=nv}
      if(filterPhase===p)filterPhase=nv;
      render();schSave();renderSettings();
    });
    const n=proj.tasks.filter(t=>t.phase===p).length;
    const cnt=ce('span','set-cnt',`${n} 项`);
    const del=ce('button','dlg-close');del.innerHTML='&times;';del.title='删除阶段（清除相关任务的阶段标签）';del.setAttribute('aria-label','删除阶段 '+p);
    del.addEventListener('click',()=>{if(!mayEditProject('删除阶段'))return;for(const t of proj.tasks){if(t.phase===p)t.phase=''}if(filterPhase===p)filterPhase=null;render();schSave();renderSettings()});
    row.appendChild(nm);row.appendChild(cnt);row.appendChild(del);
    pb.appendChild(row);
  }
  // 默认视图
  $('#set-defview').value=(proj.meta&&proj.meta.defView)||'week';
}

/* Task CRUD */
function addT(pid=null,ty='task'){
  if(typeof mayEditProject==='function'&&!mayEditProject('新建任务'))return;
  // 不允许把子项挂到重要节点（菱形）下面——自动上移到其父级
  if(pid){const p0=byId(pid);if(p0&&p0.type==='milestone')pid=p0.pid||null}
  const T=todayD(),t={id:uid(),name:ty==='milestone'?'新节点':'新任务',pid,type:ty,s:fD(T),e:fD(T+(ty==='milestone'?0:4)),pct:0,who:'',grp:proj.groups[0]?proj.groups[0].name:'其他',deps:[],fold:false};
  if(pid){const p=byId(pid);if(p)p.fold=false}
  proj.tasks.push(t);sel(t.id);render();schSave();edOpen(t.id)}
function addChild(){if(!selId){toast('请先选择一个任务','warn');return}addT(selId,'task')}
// 管线：顶层结构容器（Boss管线/马匹管线…），日期由下属模块自动汇总
function addPipeline(){
  if(typeof mayEditProject==='function'&&!mayEditProject('新建管线'))return;
  const T=todayD(),t={id:uid(),name:'新管线',pid:null,type:'pipeline',s:fD(T),e:fD(T+13),pct:0,who:'',grp:'',deps:[],fold:false};
  proj.tasks.push(t);sel(t.id);render();schSave();edOpen(t.id);
}
// 删除不再拦截确认：立即执行 + 可撤销提示（撤销优于拦截）；支持多选批量删除
function delSel(){
  if(typeof mayEditProject==='function'&&!mayEditProject('删除任务'))return;
  if(!selIds.size){toast('请先选择任务','warn');return}
  const roots=Array.from(selIds).map(byId).filter(Boolean);if(!roots.length)return;
  const rm=new Set();
  for(const r of roots){rm.add(r.id);for(const d of desc(r.id))rm.add(d.id)}
  const kidCount=rm.size-roots.length;
  proj.tasks=proj.tasks.filter(x=>!rm.has(x.id));
  for(const x of proj.tasks){if(x.deps)x.deps=x.deps.filter(d=>!rm.has(d))}
  selId=null;selIds=new Set();render();schSave();
  const label=roots.length===1?`「${roots[0].name}」`:`${roots.length} 个任务`;
  toast(`已删除 ${label}${kidCount?`及 ${kidCount} 个子任务`:''} · Ctrl+Z 可撤销`,'info',3600);
}
