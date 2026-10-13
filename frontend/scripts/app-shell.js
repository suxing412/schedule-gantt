/* App shell owns navigation, menus and presentation state; schedule data stays in the core model. */
const WorkspaceShell = (() => {
  let view='gantt', pipelineSignature='', bound=false;
  const menuPairs=[['file-menu-toggle','file-menu'],['create-menu-toggle','create-menu']];
  function prepareLayout(project){
    if(project.meta.layoutVersion===2)return;
    const widths={...project.meta.cols};
    for(const column of allTableColumns())if(column.builtin)widths[column.id]=column.width;
    delete widths.date;
    Object.assign(project.meta,{cols:widths,lw:576,paneAuto:true,layoutVersion:2,nameAutoWidth:false});
  }
  function closeMenus(returnFocus=false){
    for(const [triggerId,menuId] of menuPairs){
      const menu=$('#'+menuId),trigger=$('#'+triggerId);
      if(!menu||menu.hidden)continue;
      menu.hidden=true;trigger.setAttribute('aria-expanded','false');
      if(returnFocus)trigger.focus();
    }
  }
  function setView(next){
    if(!['gantt','table'].includes(next))return;
    view=next;closeMenus();
    $('#app-shell').classList.toggle('view-table',view==='table');
    document.querySelectorAll('[data-view]').forEach(button=>{
      const selected=button.dataset.view===view;button.classList.toggle('active',selected);
      if(button.classList.contains('nav-item')){if(selected)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
      else button.setAttribute('aria-pressed',String(selected));
    });
    $('#breadcrumb-view').textContent=view==='table'?'任务表格':'项目排期';
    $('#view-hint').textContent=view==='table'?'集中查看属性 · 双击编辑任务':'拖动安排时间 · 双击编辑任务';
    requestAnimationFrame(()=>{applyPaneLayout();applyColWidths();if(view==='gantt'){render();ensureFill();}});
  }
  function updateNavigation(){
    const pipes=proj.tasks.filter(task=>task.type==='pipeline');
    const signature=JSON.stringify(pipes.map(task=>[task.id,task.name]));
    if(signature===pipelineSignature)return;pipelineSignature=signature;
    const box=$('#pipeline-nav');box.replaceChildren();
    if(!pipes.length){box.appendChild(ce('p','nav-empty','用管线组织任务，分组查看项目进展。'));return;}
    for(const pipe of pipes){
      const button=ce('button','pipeline-link');button.title='定位到 '+pipe.name;
      button.appendChild(ce('span',null,pipe.name));
      button.addEventListener('click',()=>{
        filterQ='';filterGrp=filterPhase=null;$('#tb-search').value='';render();sel(pipe.id);
        const row=Array.from($('#g-left-body').querySelectorAll('.t-row')).find(item=>item.dataset.id===pipe.id);
        if(row){$('#g-left-body').scrollTop=row.offsetTop-$('#g-left-body').offsetTop;row.focus({preventScroll:true});}
      });box.appendChild(button);
    }
  }
  function update(){
    if(!proj||!$('#app-shell'))return;
    const tasks=proj.tasks.filter(task=>task.type!=='pipeline'&&task.type!=='milestone'&&!isSum(task));
    let days=0,done=0;for(const task of tasks){const span=Math.max(1,tD(task.e)-tD(task.s)+1);days+=span;done+=span*(task.pct||0);}
    const progress=days?Math.round(done/days):0;
    $('#metric-tasks').textContent=String(tasks.length);
    $('#metric-milestones').textContent=String(proj.tasks.filter(task=>task.type==='milestone').length+(proj.flags||[]).length);
    $('#metric-progress').textContent=String(progress);$('#metric-progress-bar').style.width=progress+'%';
    const dates=proj.tasks.filter(task=>task.type!=='pipeline');
    let first=Infinity,last=-Infinity;
    for(const task of dates){const r=isSum(task)?eRange(task):{s:tD(task.s),e:tD(task.e)};first=Math.min(first,r.s);last=Math.max(last,r.e);}
    $('#project-date-range').textContent=dates.length?fD(first).replaceAll('-','.')+' — '+fD(last).replaceAll('-','.'):'创建第一个任务，开始安排项目';
    const title=$('#project-name');if(document.activeElement!==title)title.value=typeof proj.meta.title==='string'?proj.meta.title:'项目排期';
    $('#clear-filters').hidden=!(filterQ||filterGrp||filterPhase);
    const selected=Array.from(selIds).map(byId).filter(Boolean);
    $('#selection-toolbar').hidden=!selected.length;
    $('#selection-label').textContent=selected.length===1?'已选择「'+selected[0].name+'」':'已选择 '+selected.length+' 项';
    $('#selection-edit').disabled=selected.length!==1;
    $('#btn-add-child').disabled=!selId;
    updateNavigation();
    window.SharedWorkspaceUI?.applyPermissions();
  }
  function bind(){
    if(bound)return;bound=true;
    document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.view)));
    $('#brand-home').addEventListener('click',event=>{if(window.SharedWorkspace?.enabled)return;event.preventDefault();setView('gantt');});
    $('#nav-toggle').addEventListener('click',()=>{
      const shell=$('#app-shell'),collapsed=$('.workspace-nav').getBoundingClientRect().width<100;
      shell.classList.toggle('nav-expanded',collapsed);shell.classList.toggle('nav-collapsed',!collapsed);
      $('#nav-toggle').setAttribute('aria-expanded',String(collapsed));applyPaneLayout();applyColWidths();ensureFill();
    });
    $('#nav-fields').addEventListener('click',fieldsOpen);
    $('#layout-reset').addEventListener('click',()=>{resetPaneLayout();toast('已恢复默认面板比例','info')});
    document.querySelectorAll('[data-command]').forEach(button=>button.addEventListener('click',()=>button.dataset.command==='pipeline'?addPipeline():addChild()));
    $('#selection-edit').addEventListener('click',()=>{if(selId)edOpen(selId);});
    $('#selection-clear').addEventListener('click',()=>sel(null));
    $('#clear-filters').addEventListener('click',()=>{filterQ='';filterGrp=filterPhase=null;$('#tb-search').value='';render();});
    for(const [triggerId,menuId] of menuPairs){
      const trigger=$('#'+triggerId),menu=$('#'+menuId);
      trigger.addEventListener('click',()=>{
        const open=menu.hidden;closeMenus();if(!open)return;
        menu.hidden=false;trigger.setAttribute('aria-expanded','true');
      });
      trigger.addEventListener('keydown',event=>{
        if(event.key==='ArrowDown'){event.preventDefault();event.stopPropagation();closeMenus();menu.hidden=false;trigger.setAttribute('aria-expanded','true');menu.querySelector('button:not(:disabled)')?.focus();}
      });
      // Move focus to the stable trigger before commands open a dialog.
      menu.addEventListener('click',event=>{if(event.target.closest('button')){menu.hidden=true;trigger.setAttribute('aria-expanded','false');trigger.focus();}},true);
      menu.addEventListener('keydown',event=>{
        if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
        event.preventDefault();event.stopPropagation();
        const items=Array.from(menu.querySelectorAll('button:not(:disabled)')),at=items.indexOf(document.activeElement);
        const next=event.key==='Home'?0:event.key==='End'?items.length-1:(at+(event.key==='ArrowUp'?-1:1)+items.length)%items.length;
        items[next]?.focus();
      });
    }
    document.addEventListener('click',event=>{if(!event.target.closest('.menu-host'))closeMenus();});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!isComposingKey(event)&&menuPairs.some(([,id])=>!$('#'+id).hidden)){event.preventDefault();event.stopImmediatePropagation();closeMenus(true);}},true);
    window.addEventListener('blur',()=>closeMenus());
    const title=$('#project-name');
    title.addEventListener('change',()=>{if(!mayEditProject('修改排期名称')){title.value=proj.meta.title||'项目排期';return;}const next=title.value.trim()||'项目排期';title.value=next;if(next!==(typeof proj.meta.title==='string'?proj.meta.title:'项目排期')){proj.meta.title=next;schSave();}});
    title.addEventListener('keydown',event=>{
      if(isComposingKey(event))return;
      if(event.key==='Enter'){event.preventDefault();event.stopPropagation();title.blur();}
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();title.value=typeof proj.meta.title==='string'?proj.meta.title:'项目排期';title.blur();}
    });
    $('#nav-toggle').setAttribute('aria-expanded',String($('.workspace-nav').getBoundingClientRect().width>=100));
  }
  return {bind,update,setView,closeMenus,prepareLayout,get view(){return view;}};
})();


/* Sharing is opt-in at runtime; static and desktop builds keep their local workflow. */
window.SharedWorkspaceUI = (() => {
  let bound=false, current=null, busyCreate=false, busyUnlock=false, confirmLatest=false, busyAi=false, aiEpoch=0;
  const node=id=>document.getElementById(id);
  const enabled=()=>['shared','workbuddy'].includes(window.SCHEDULE_RUNTIME?.mode)||['shared','workbuddy'].includes(document.documentElement.dataset.scheduleMode)||window.SharedWorkspace?.enabled===true;
  const api=()=>window.SharedWorkspace;
  function errorText(error,fallback){
    if(error?.code==='INVALID_EDIT_CODE'||error?.code==='INVALID_CODE')return '编辑码不正确，请向创建者确认四位数字。';
    if(error?.code==='RATE_LIMITED')return '尝试次数较多，请稍后再试。';
    return typeof error?.message==='string'&&error.message?error.message:fallback;
  }
  function showError(id,message){const el=node(id);el.textContent=message||'';el.hidden=!message;}
  function setBusy(formId,buttonId,busy,label){
    const form=node(formId);
    form.setAttribute('aria-busy',String(busy));
    form.querySelectorAll('input,button').forEach(el=>el.disabled=busy);
    node(buttonId).textContent=label;
  }
  function applyPermissions(){
    if(!enabled())return;
    const state=current||api()?.state?.(),allowed=state?.screen==='ready'&&state.canEdit;
    document.querySelectorAll('[data-shared-edit]').forEach(button=>{
      if(!allowed){
        if(!button.hasAttribute('data-shared-disabled')){
          button.dataset.sharedDisabled='1';button.dataset.sharedPreviousDisabled=String(button.disabled);
        }
        button.disabled=true;
      }else if(button.hasAttribute('data-shared-disabled')){
        button.disabled=button.dataset.sharedPreviousDisabled==='true';
        delete button.dataset.sharedDisabled;delete button.dataset.sharedPreviousDisabled;
      }
    });
    if(allowed){
      // Selection and history may change while viewing; recalculate their enabled state.
      const selected=Array.from(selIds).map(byId).filter(Boolean);
      node('btn-add-child').disabled=!selId;
      node('selection-edit').disabled=selected.length!==1;
      updUndoBtns();
    }
    const title=node('project-name');if(title)title.readOnly=!allowed;
    const hint=node('view-hint');
    if(hint)hint.textContent=!allowed?(state?.conflict?'存在版本冲突 · 请先处理上方提示':'只读浏览 · 输入编辑码后可修改'):WorkspaceShell.view==='table'?'集中查看属性 · 双击编辑任务':'拖动安排时间 · 双击编辑任务';
  }
  function renderPresence(state){
    const presence=state.presence,members=presence?.members||[],list=node('shared-presence-list');
    list.replaceChildren();
    for(const member of members){
      const row=ce('li','shared-presence-item'),dot=ce('span','shared-presence-dot'+(member.online?' online':'')),person=ce('div','shared-presence-person');
      dot.setAttribute('aria-hidden','true');
      person.appendChild(ce('strong',null,member.displayName+(member.source==='external'?' · AI / 外部':'')));
      const date=new Date(member.lastSeenAt);
      person.appendChild(ce('small',null,'最近活跃 '+(Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'未知')));
      row.appendChild(dot);row.appendChild(person);row.appendChild(ce('span','shared-presence-state',member.online?'在线':'最近离开'));list.appendChild(row);
    }
    node('shared-presence-summary').textContent=state.presenceLoading?'正在更新协作者…':presence?members.filter(member=>member.online).length+' 人在线 · '+members.length+' 个有效会话':'尚未加载协作者';
    node('shared-presence-refresh').disabled=!!state.presenceLoading;
    showError('shared-presence-error',state.presenceError?errorText(state.presenceError,'暂时无法更新协作者。'):'');
    node('shared-presence').textContent=presence?'协作者 '+members.filter(member=>member.online).length:'协作者';
  }
  function closePresence(){closeOvl(node('shared-presence-ovl'));}
  function openPresence(){
    const state=api()?.state?.();if(state?.mode!=='workbuddy'||state.role!=='editor'||state.screen!=='ready')return;
    renderPresence(state);openOvl(node('shared-presence-ovl'));void api().refreshPresence();
  }
  function clearAiSecret(){aiEpoch++;node('shared-ai-key').value='';node('shared-ai-code').value='';node('shared-ai-once').hidden=true;node('shared-ai-reset-form').hidden=false;node('shared-ai-feedback').textContent='';}
  function closeAi(force=false){
    if(busyAi&&!force)return;
    clearAiSecret();closeOvl(node('shared-ai-ovl'));
  }
  function openAi(key){
    const state=api()?.state?.();if(state?.mode!=='workbuddy'||state.role!=='editor'||state.screen!=='ready')return;
    clearAiSecret();showError('shared-ai-error','');
    if(typeof key==='string'&&/^[a-f0-9]{64}$/.test(key)){
      node('shared-ai-key').value=key;node('shared-ai-once').hidden=false;node('shared-ai-reset-form').hidden=true;
    }
    openOvl(node('shared-ai-ovl'));
  }
  function bindDialog(id,close){
    node(id).addEventListener('click',event=>{if(event.target===event.currentTarget)close();});
    node(id).addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();return;}
      if(event.key!=='Tab')return;
      const items=Array.from(event.currentTarget.querySelectorAll('button,input,textarea,a[href]')).filter(el=>!el.disabled&&el.offsetParent!==null);
      if(!items.length){event.preventDefault();return;}
      if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1).focus();}
      else if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0].focus();}
    },true);
  }
  function render(next){
    if(!enabled())return;
    current=next||api()?.state?.()||{screen:'loading',role:'viewer'};
    const state=current,ready=state.screen==='ready',home=state.screen==='home',loading=state.screen==='loading',failed=state.screen==='error',editor=state.role==='editor';
    node('app-shell').classList.add('shared-mode');
    node('brand-home').setAttribute('href','/');
    node('workspace-main').hidden=!ready;
    node('shared-gateway').hidden=ready;
    node('shared-home').hidden=!home;
    node('shared-loading').hidden=!loading;
    node('shared-error-page').hidden=!failed;
    node('shared-topbar').hidden=!ready;
    node('shared-workspace-note').hidden=!ready;
    node('save-dot').hidden=true;
    node('project-file-actions').hidden=!ready;
    node('btn-settings').hidden=!ready;
    node('btn-help').hidden=!ready;
    node('breadcrumb-view').textContent=ready?(WorkspaceShell.view==='table'?'任务表格':'项目排期'):'共享排期';
    const runtime=window.SCHEDULE_RUNTIME||{},storageDriver=runtime.storage||document.documentElement.dataset.scheduleStorage;
    const cloud=state.mode==='workbuddy'||runtime.mode==='workbuddy'||document.documentElement.dataset.scheduleMode==='workbuddy';
    node('shared-presence').hidden=!(cloud&&ready&&editor);node('shared-ai').hidden=!(cloud&&ready&&editor);
    if(!(cloud&&ready&&editor)){
      if(!node('shared-presence-ovl').hidden)closePresence();
      if(!node('shared-ai-ovl').hidden)closeAi(true);
    }
    renderPresence(state);
    const storage=typeof runtime.storageLabel==='string'?runtime.storageLabel:cloud?'共享存储 · 数据保存在云端':storageDriver==='external'?'共享存储 · 数据保存在服务器':'开发存储 · 数据保存在此服务器';
    document.querySelectorAll('[data-shared-storage]').forEach(el=>el.textContent=storage);
    node('help-save-description').textContent='共享排期的修改自动保存到'+(cloud?'云端':'服务器')+'。打开分享链接即可查看；输入昵称和四位编辑码后可以编辑。若遇到版本冲突，请先导出草稿，再加载最新版。列宽、面板比例和折叠状态仅保存在当前浏览器。';
    const role=node('shared-role');
    role.textContent=editor?'编辑者 · '+(state.displayName||'未命名'):'只读浏览';
    role.title=role.textContent;role.classList.toggle('is-editor',editor);
    node('shared-unlock').hidden=editor;
    node('shared-logout').hidden=!editor;
    const status=node('shared-save-state');
    const labels={saved:cloud?'已保存到云端':'已保存到服务器',dirty:'有修改待保存',saving:'正在保存…',error:'保存未完成',conflict:'存在版本冲突'};
    status.textContent=ready?(labels[state.saveStatus]||''):'';
    status.classList.toggle('is-error',['error','conflict'].includes(state.saveStatus));
    if(failed){
      const notFound=state.error?.code==='NOT_FOUND'||state.error?.code==='PROJECT_NOT_FOUND';
      const configError=['CLOUD_CONFIG_MISSING','CLOUD_CONFIG_INVALID','CLOUD_CONFIG_ERROR','CLOUD_SDK_UNAVAILABLE','CLOUD_SDK_MISSING','CLOUD_SDK_INVALID','CLOUD_NOT_READY','CLOUD_PERMISSION_DENIED'].includes(state.error?.code);
      node('shared-error-title').textContent=configError?'云服务尚未就绪':notFound?'这份排期不存在':'暂时无法打开排期';
      node('shared-error-message').textContent=notFound?'请检查链接是否完整，或向创建者索取新的链接。':errorText(state.error,'连接服务器失败，请稍后重新加载。');
      node('shared-retry-load').hidden=notFound;
    }
    const conflict=ready&&(!!state.conflict||state.saveStatus==='conflict');
    const saveError=ready&&state.saveStatus==='error';
    node('shared-notice').hidden=!conflict&&!saveError;
    if(conflict||saveError){
      const localDraft=state.error?.code==='LOCAL_DRAFT',syncError=state.error?.code==='POLL_FAILED';
      node('shared-notice-title').textContent=localDraft?'此浏览器有未提交草稿':conflict?'服务器上有新的版本':syncError?'暂时无法同步最新排期':'修改还没有保存成功';
      const by=state.conflict?.updatedBy;
      const person=typeof by==='string'?by:typeof by?.displayName==='string'?by.displayName:'';
      const conflictMessage=(person?person+' 已提交新版本。':'服务器上已有新版本。')+'你的修改仍保留在当前页面，请先导出草稿，再加载最新版。';
      node('shared-notice-message').textContent=localDraft||state.draftPersisted===false?errorText(state.error,'草稿仅保留在当前页面，刷新可能丢失，请立即导出草稿。'):conflict?conflictMessage:errorText(state.error,'请检查连接后重试。当前修改仍保留在本页。');
      node('shared-retry-save').hidden=conflict;
      node('shared-retry-save').textContent=syncError?'重新同步':'重试保存';
      node('shared-load-latest').hidden=!conflict;
      node('shared-export-draft').hidden=!state.draftAvailable&&!state.dirty;
      node('shared-export-draft').disabled=!state.draftAvailable&&!state.dirty;
    }else confirmLatest=false;
    node('shared-conflict-confirm').hidden=!confirmLatest;
    const updatedBy=typeof state.updatedBy==='string'?state.updatedBy:state.updatedBy?.displayName;
    let stamp='';
    if(state.updatedAt){const date=new Date(state.updatedAt);if(Number.isFinite(date.getTime()))stamp=date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}
    node('shared-last-update').textContent=stamp?'最近更新 '+stamp+(updatedBy?' · '+updatedBy:'')+(state.source==='external'?' · AI / 外部操作':''):'';
    applyPermissions();
  }
  function closeUnlock(){
    if(busyUnlock)return;
    const overlay=node('shared-unlock-ovl');closeOvl(overlay);node('shared-unlock-code').value='';
  }
  function openUnlock(){
    const latest=api()?.state?.();if(latest)current=latest;
    if(!enabled()||current?.screen!=='ready'||current.role==='editor')return;
    showError('shared-unlock-error','');
    node('shared-unlock-name').value=current.displayName||'';
    node('shared-unlock-code').value='';
    openOvl(node('shared-unlock-ovl'));
    setTimeout(()=>node('shared-unlock-name').focus(),35);
  }
  async function loadLatest(){
    node('shared-confirm-latest').disabled=true;
    try{await api().loadLatest();confirmLatest=false;render();}
    catch(error){node('shared-notice-message').textContent=errorText(error,'加载失败，请重试。');}
    finally{node('shared-confirm-latest').disabled=false;}
  }
  function bind(){
    if(bound||!enabled())return;bound=true;
    window.addEventListener('schedule:shared-state',event=>render(event.detail));
    window.addEventListener('schedule:request-unlock',openUnlock);
    node('shared-create-form').addEventListener('submit',async event=>{
      event.preventDefault();if(busyCreate||!event.currentTarget.reportValidity())return;
      busyCreate=true;showError('shared-create-error','');setBusy('shared-create-form','shared-create-submit',true,'正在创建…');
      try{
        const result=await api().create({title:node('shared-create-title').value.trim(),displayName:node('shared-create-name').value.trim(),editCode:node('shared-create-code').value});
        node('shared-create-code').value='';
        if(result.apiKey)openAi(result.apiKey);
      }catch(error){showError('shared-create-error',errorText(error,'创建失败，请稍后重试。'));}
      finally{busyCreate=false;setBusy('shared-create-form','shared-create-submit',false,'创建共享排期');}
    });
    node('shared-unlock').addEventListener('click',openUnlock);
    node('shared-unlock-close').addEventListener('click',closeUnlock);
    node('shared-unlock-cancel').addEventListener('click',closeUnlock);
    node('shared-unlock-ovl').addEventListener('click',event=>{if(event.target===event.currentTarget)closeUnlock();});
    node('shared-unlock-form').addEventListener('submit',async event=>{
      event.preventDefault();if(busyUnlock||!event.currentTarget.reportValidity())return;
      busyUnlock=true;showError('shared-unlock-error','');setBusy('shared-unlock-form','shared-unlock-submit',true,'正在验证…');
      try{
        await api().unlock({displayName:node('shared-unlock-name').value.trim(),editCode:node('shared-unlock-code').value});
        busyUnlock=false;closeUnlock();
      }catch(error){showError('shared-unlock-error',errorText(error,'无法进入编辑模式，请重试。'));}
      finally{busyUnlock=false;setBusy('shared-unlock-form','shared-unlock-submit',false,'进入编辑模式');}
    });
    node('shared-unlock-ovl').addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeUnlock();return;}
      if(event.key!=='Tab')return;
      const items=Array.from(event.currentTarget.querySelectorAll('button,input')).filter(el=>!el.disabled&&el.offsetParent!==null);
      if(!items.length){event.preventDefault();return;}
      if(event.shiftKey&&document.activeElement===items[0]){event.preventDefault();items.at(-1).focus();}
      else if(!event.shiftKey&&document.activeElement===items.at(-1)){event.preventDefault();items[0].focus();}
    });
    node('shared-copy-link').addEventListener('click',async()=>{
      const button=node('shared-copy-link'),feedback=node('shared-copy-feedback');button.disabled=true;feedback.textContent='';
      try{const result=await api().copyLink();if(result===false)throw new Error('复制失败，请从浏览器地址栏复制链接。');feedback.textContent='分享链接已复制';button.textContent='已复制链接';}
      catch(error){feedback.textContent=errorText(error,'复制失败，请从浏览器地址栏复制链接。');}
      finally{button.disabled=false;setTimeout(()=>{button.textContent='复制分享链接';},2500);}
    });
    node('shared-logout').addEventListener('click',async()=>{try{await api().logout();}catch(error){node('shared-copy-feedback').textContent=errorText(error,'退出编辑失败，请重试。');}});
    node('shared-presence').addEventListener('click',openPresence);
    node('shared-presence-close').addEventListener('click',closePresence);node('shared-presence-done').addEventListener('click',closePresence);
    node('shared-presence-refresh').addEventListener('click',()=>api().refreshPresence());bindDialog('shared-presence-ovl',closePresence);
    node('shared-ai').addEventListener('click',()=>openAi());
    node('shared-ai-close').addEventListener('click',()=>closeAi());node('shared-ai-done').addEventListener('click',()=>closeAi());bindDialog('shared-ai-ovl',()=>closeAi());
    node('shared-ai-reset-form').addEventListener('submit',async event=>{
      event.preventDefault();if(busyAi||!event.currentTarget.reportValidity())return;
      const epoch=aiEpoch;busyAi=true;showError('shared-ai-error','');setBusy('shared-ai-reset-form','shared-ai-reset',true,'正在生成…');
      node('shared-ai-close').disabled=true;node('shared-ai-done').disabled=true;
      try{
        const result=await api().resetApiKey(node('shared-ai-code').value);
        if(epoch===aiEpoch)openAi(result.apiKey);
      }catch(error){if(epoch===aiEpoch)showError('shared-ai-error',errorText(error,'密钥生成失败，请重试。'));}
      finally{busyAi=false;node('shared-ai-code').value='';setBusy('shared-ai-reset-form','shared-ai-reset',false,'生成 / 重置 AI 密钥');node('shared-ai-close').disabled=false;node('shared-ai-done').disabled=false;}
    });
    node('shared-ai-copy').addEventListener('click',async()=>{
      if(!node('shared-ai-key').value)return;
      const epoch=aiEpoch;
      try{await navigator.clipboard.writeText(node('shared-ai-key').value);if(epoch===aiEpoch)node('shared-ai-feedback').textContent='AI 密钥已复制，请保存到安全的位置。';}
      catch{if(epoch===aiEpoch)node('shared-ai-feedback').textContent='复制失败，请选中上方密钥手动复制。';}
    });
    window.addEventListener('pagehide',()=>{clearAiSecret();node('shared-ai-ovl').hidden=true;node('shared-presence-ovl').hidden=true;});
    node('shared-retry-load').addEventListener('click',()=>api().load().catch(error=>{node('shared-error-message').textContent=errorText(error,'加载失败，请重试。');}));
    node('shared-export-draft').addEventListener('click',()=>api().exportDraft());
    node('shared-load-latest').addEventListener('click',()=>{confirmLatest=true;node('shared-conflict-confirm').hidden=false;node('shared-confirm-latest').focus();});
    node('shared-cancel-latest').addEventListener('click',()=>{confirmLatest=false;node('shared-conflict-confirm').hidden=true;node('shared-load-latest').focus();});
    node('shared-confirm-latest').addEventListener('click',loadLatest);
    node('shared-retry-save').addEventListener('click',async()=>{try{if(current?.error?.code==='POLL_FAILED')await api().pollNow();else await api().retrySave();}catch(error){node('shared-notice-message').textContent=errorText(error,'保存仍未成功，请稍后重试。');}});
    render();
  }
  return {bind,render,openUnlock,openPresence,closePresence,openAi,closeAi,applyPermissions};
})();
