/* Shared boards: server revisions are authoritative; personal layout stays in this browser. */
const SharedWorkspace=(()=>{
  // A missing runtime script must never open local data on a cloud deployment.
  const modes=[window.SCHEDULE_RUNTIME?.mode,document.documentElement.dataset?.scheduleMode];
  const mode=modes.includes('workbuddy')?'workbuddy':modes.includes('shared')?'shared':'local';
  const enabled=mode!=='local',cloudMode=mode==='workbuddy';
  let cloudTransport=null,cloudNamespace=null;
  const PERSONAL=['cols','lw','leftWidth','paneAuto','layoutVersion','nameAutoWidth','columnOrder','hiddenColumns','defView'];
  const clone=value=>JSON.parse(JSON.stringify(value));
  const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  let projectId=enabled?(window.location.pathname.match(/^\/p\/([a-f0-9]{32})\/?$/i)||[])[1]?.toLowerCase()||null:null;
  let screen=projectId?'loading':'home',session=null,record=null,revision=0,serverContent='',latestSnapshot=null,pending=null;
  let dirty=false,saving=false,error=null,conflict=null,pump=null,pollTimer=null,polling=false,draftAvailable=false,draftPersisted=false;
  let heartbeatTimer=null,presenceLoading=false,presenceError=null,presenceData=null,presenceEpoch=0,pageActive=true;
  // Preserve HTTP keys; cloud sessions, preferences and drafts stay with their endpoint.
  const key=kind=>(cloudMode?'schedule-workbuddy:'+cloudNamespace:'schedule-shared')+':'+projectId+':'+kind;
  const read=(storage,kind)=>{try{return JSON.parse(storage.getItem(key(kind))||'null')}catch{return null}};
  const write=(storage,kind,value)=>{try{if(value===null)storage.removeItem(key(kind));else storage.setItem(key(kind),JSON.stringify(value));return true}catch{return false}};
  const sessionValid=()=>!!(session&&typeof session.token==='string'&&session.token&&Number.isFinite(Date.parse(session.expiresAt))&&Date.parse(session.expiresAt)>Date.now());
  const canEdit=()=>!enabled||(screen==='ready'&&sessionValid()&&!conflict);
  function state(){return {enabled,mode,screen,role:sessionValid()?'editor':'viewer',canEdit:canEdit(),projectId,revision,displayName:sessionValid()?session.displayName:'',saveStatus:conflict?'conflict':saving?'saving':error?'error':dirty?'dirty':'saved',dirty,saving,error,conflict:conflict?{revision:conflict.revision,updatedAt:conflict.updatedAt,updatedBy:conflict.updatedBy,source:conflict.source||'human'}:null,shareURL:projectId?new URL('/p/'+projectId,window.location.href).href:'',updatedAt:record?.updatedAt||null,updatedBy:record?.updatedBy||null,source:record?.source||'human',presence:sessionValid()&&presenceData?clone(presenceData):null,presenceLoading:sessionValid()&&presenceLoading,presenceError:sessionValid()?presenceError:null,draftAvailable,draftPersisted};}
  function emit(){
    const current=state();
    if(typeof pendingDirty!=='undefined')pendingDirty=dirty;
    const dot=typeof $==='function'?$('#save-dot'):null;
    if(dot){dot.textContent=({saved:cloudMode?'已保存到云端':'已保存到服务器',dirty:'未保存',saving:'正在保存…',error:'同步失败',conflict:'版本冲突'})[current.saveStatus];dot.classList.toggle('dirty',current.saveStatus!=='saved');}
    window.dispatchEvent(new CustomEvent('schedule:shared-state',{detail:current}));
    if(typeof updUndoBtns==='function')updUndoBtns();
  }
  function toSharedProject(project){
    const result=ScheduleProjectValidation.validateProject(clone(project));
    for(const name of PERSONAL)delete result.meta[name];
    for(const task of result.tasks){delete task.fold;delete task.collapsed;}
    return result;
  }
  function savePersonal(project){
    if(!enabled||!projectId||!project)return;
    const meta={},folded=Object.create(null);
    for(const name of PERSONAL)if(Object.prototype.hasOwnProperty.call(project.meta||{},name))meta[name]=clone(project.meta[name]);
    for(const task of project.tasks||[])folded[task.id]=!!task.fold;
    write(localStorage,'preferences',{meta,folded});
  }
  function mergePersonal(project){
    const result=ScheduleProjectValidation.validateProject(clone(project)),prefs=read(localStorage,'preferences');
    // Server normalization may add old default widths: always start a personal layout independently.
    for(const name of PERSONAL)delete result.meta[name];
    if(prefs&&typeof prefs==='object'){
      const valid=new Set(['name','person','start','end','pct','grp','phase',...(result.meta.customFields||[]).map(field=>field.id)]);
      for(const name of PERSONAL)if(Object.prototype.hasOwnProperty.call(prefs.meta||{},name)){
        let value=clone(prefs.meta[name]);
        if((name==='columnOrder'||name==='hiddenColumns')&&Array.isArray(value))value=value.filter(id=>valid.has(id));
        result.meta[name]=value;
      }
      for(const task of result.tasks)task.fold=Object.prototype.hasOwnProperty.call(prefs.folded||{},task.id)&&!!prefs.folded[task.id];
    }
    // Malformed browser preferences must never prevent a valid server board from opening.
    try{return ScheduleProjectValidation.validateProject(result)}catch{
      for(const name of PERSONAL)delete result.meta[name];
      return ScheduleProjectValidation.validateProject(result);
    }
  }
  function validRecord(value){
    if(!value||typeof value.id!=='string'||!/^[a-f0-9]{32}$/i.test(value.id)||!Number.isSafeInteger(value.revision)||value.revision<1||!value.project)throw Object.assign(new Error('服务器返回的排期数据无效'),{code:'INVALID_RESPONSE'});
    if(projectId&&value.id.toLowerCase()!==projectId)throw Object.assign(new Error('服务器返回了其他排期的数据'),{code:'INVALID_RESPONSE'});
    return {id:value.id.toLowerCase(),revision:value.revision,createdAt:value.createdAt,updatedAt:value.updatedAt,updatedBy:value.updatedBy,source:value.source==='external'?'external':'human',project:ScheduleProjectValidation.validateProject(clone(value.project))};
  }
  async function request(path,options={}){
    let response;
    try{response=await fetch(path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...options.headers}})}catch{throw Object.assign(new Error('暂时无法连接服务器，请检查网络后重试。'),{code:'NETWORK_ERROR'})}
    let body;try{body=await response.json()}catch{throw Object.assign(new Error('服务器响应无法读取，请稍后重试'),{code:'INVALID_RESPONSE'})}
    if(!response.ok)throw Object.assign(new Error(body?.error?.message||'请求失败，请重试'),{code:body?.error?.code||'HTTP_'+response.status,status:response.status,latest:body?.latest});
    return body;
  }
  function getCloudTransport(){
    if(cloudTransport)return cloudTransport;
    const runtime=window.SCHEDULE_RUNTIME,config=runtime?.cloud;
    if(runtime?.configError)throw Object.assign(new Error(runtime.configError.message||'云服务配置无效，请部署者检查运行配置。'),{code:runtime.configError.code||'CLOUD_CONFIG_INVALID'});
    if(runtime?.configured===false||!config||typeof config.publishableKey!=='string'||!config.publishableKey.trim())throw Object.assign(new Error('云服务配置尚未完成。请部署者注入 WorkBuddy publicConfig，然后重新加载。'),{code:'CLOUD_CONFIG_MISSING'});
    if(typeof window.WorkBuddyTransport?.create!=='function')throw Object.assign(new Error('云服务连接组件未加载。请重新加载页面；若仍失败，请部署者检查 SDK 和脚本部署。'),{code:'CLOUD_SDK_UNAVAILABLE'});
    let endpoint;try{endpoint=new URL(config.endpoint?.trim()||window.location.origin).href.replace(/\/$/,'')}catch{throw Object.assign(new Error('云服务 endpoint 格式无效，请部署者检查运行配置。'),{code:'CLOUD_CONFIG_INVALID'});}
    const transport=window.WorkBuddyTransport.create({endpoint,publishableKey:config.publishableKey});
    if(!transport||['get','create','unlock','save','logout'].some(method=>typeof transport[method]!=='function'))throw Object.assign(new Error('云服务连接组件版本不兼容，请部署者更新完整前端文件。'),{code:'CLOUD_SDK_UNAVAILABLE'});
    cloudNamespace=encodeURIComponent(endpoint);cloudTransport=transport;return transport;
  }
  const getRecord=id=>cloudMode?getCloudTransport().get(id):request('/api/projects/'+id);
  function newProjectId(){
    if(typeof window.crypto?.getRandomValues!=='function')throw Object.assign(new Error('当前浏览器不支持安全随机数，请使用现代浏览器打开 HTTPS 网站。'),{code:'CRYPTO_UNAVAILABLE'});
    return Array.from(window.crypto.getRandomValues(new Uint8Array(16)),value=>value.toString(16).padStart(2,'0')).join('');
  }
  function applyRecord(next){
    if(!applyProject(mergePersonal(next.project)))throw Object.assign(new Error('排期数据无法加载：'+lastProjectError),{code:'INVALID_PROJECT'});
    record=next;revision=next.revision;serverContent=canonical(toSharedProject(next.project));screen='ready';
    latestSnapshot=toSharedProject(proj);pending=null;dirty=false;error=null;conflict=null;
    selId=null;selIds=new Set();
    if(typeof filterGrp!=='undefined'&&filterGrp&&!proj.groups.some(group=>group.name===filterGrp))filterGrp=null;
    if(typeof filterPhase!=='undefined'&&filterPhase&&!proj.tasks.some(task=>task.phase===filterPhase))filterPhase=null;
    hist=[];histI=-1;snap();savePersonal(proj);
    if(typeof workspaceStarted!=='undefined'&&workspaceStarted){render();ensureFill();}
  }
  function readSession(){session=read(sessionStorage,'session');if(!sessionValid()){session=null;write(sessionStorage,'session',null);}}
  function startPolling(){clearInterval(pollTimer);pollTimer=setInterval(()=>{void pollNow()},5000);}
  function stopHeartbeat(clear=false){
    clearInterval(heartbeatTimer);heartbeatTimer=null;presenceEpoch++;presenceLoading=false;
    if(clear){presenceData=null;presenceError=null;}
  }
  function startHeartbeat(){
    stopHeartbeat();
    if(cloudMode&&screen==='ready'&&sessionValid()&&pageActive&&!document.hidden)heartbeatTimer=setInterval(()=>{void refreshPresence(true)},20000);
  }
  async function refreshPresence(heartbeat=false){
    if(!cloudMode||screen!=='ready'||!sessionValid()||!pageActive||document.hidden){
      if(!sessionValid()){stopHeartbeat(true);emit();}
      return false;
    }
    if(presenceLoading)return false;
    const transport=getCloudTransport(),method=heartbeat?'heartbeat':'presence',token=session.token,epoch=presenceEpoch;
    presenceLoading=true;presenceError=null;emit();
    try{
      if(typeof transport[method]!=='function')throw Object.assign(new Error('协作接口尚未就绪，请部署 V2 数据库迁移和完整前端文件。'),{code:'CLOUD_NOT_READY'});
      const next=await transport[method](projectId,token);
      if(epoch!==presenceEpoch||session?.token!==token||!sessionValid()||!pageActive)return false;
      presenceData=next;return true;
    }catch(e){
      if(epoch!==presenceEpoch||session?.token!==token)return false;
      presenceError={code:e.code||'PRESENCE_FAILED',message:e.message};
      if(e.status===401){session=null;write(sessionStorage,'session',null);stopHeartbeat(true);}
      else if(e.code==='CLOUD_NOT_READY')stopHeartbeat();
      return false;
    }finally{if(epoch===presenceEpoch)presenceLoading=false;emit();}
  }
  async function resetApiKey(editCode){
    if(!cloudMode||screen!=='ready'||!sessionValid())throw new Error('请先输入编辑码进入云端排期的编辑模式。');
    const transport=getCloudTransport();
    if(typeof transport.resetApiKey!=='function')throw Object.assign(new Error('AI 接口尚未就绪，请先部署 V2 数据库迁移。'),{code:'CLOUD_NOT_READY'});
    const result=await transport.resetApiKey(projectId,editCode);
    presenceData=null;emit();
    return result;
  }
  function persistDraft(){
    if(!projectId||!latestSnapshot)return;
    if(dirty){
      draftAvailable=true;draftPersisted=write(localStorage,'draft',{baseRevision:revision,project:latestSnapshot,savedAt:new Date().toISOString()});
      if(!draftPersisted){const warning='草稿仅保留在当前页面，刷新可能丢失，请立即导出草稿。';error={code:error?.code||'DRAFT_STORAGE_FAILED',message:(error?.message?error.message+' ':'')+warning};}
    }else{draftAvailable=false;draftPersisted=false;write(localStorage,'draft',null);}
  }
  async function load(){
    if(!enabled)return false;
    screen='loading';error=null;emit();
    try{
      if(cloudMode)getCloudTransport();
      if(!projectId){screen='home';emit();return false;}
      const next=validRecord(await getRecord(projectId));readSession();applyRecord(next);
      const draft=read(localStorage,'draft');
      if(draft?.project){
        try{
          const saved=toSharedProject(draft.project);
          if(canonical(saved)!==serverContent){latestSnapshot=saved;dirty=true;draftAvailable=true;draftPersisted=true;conflict=next;error={code:'LOCAL_DRAFT',message:'当前显示服务器版本。此浏览器另有未提交草稿，请先导出草稿，或确认加载最新版并丢弃草稿。'};}
          else write(localStorage,'draft',null);
        }catch{error={code:'INVALID_DRAFT',message:'浏览器中的旧草稿无法读取，当前显示服务器版本。'};}
      }
      startPolling();startHeartbeat();emit();if(typeof startWorkspace==='function')startWorkspace();return true;
    }catch(e){screen='error';error={code:e.code||'LOAD_FAILED',message:e.message};emit();return false;}
  }
  async function create({title,displayName,editCode}){
    if(!enabled)throw new Error('当前为本地模式');
    const transport=cloudMode?getCloudTransport():null;
    const project=toSharedProject({tasks:[],groups:clone(GROUPS),flags:[],meta:{title:String(title||'未命名排期').trim()||'未命名排期'}});
    const id=cloudMode?newProjectId():null;
    const value=cloudMode?await transport.create({id,displayName,editCode,project}):await request('/api/projects',{method:'POST',body:JSON.stringify({displayName,editCode,project})});
    const previous=projectId;projectId=null;
    let next;try{next=validRecord(value);if(id&&next.id!==id)throw Object.assign(new Error('云服务返回了其他排期的数据'),{code:'INVALID_RESPONSE'});}catch(e){projectId=previous;throw e;}
    projectId=next.id;session=value.session;
    if(!sessionValid())throw Object.assign(new Error('排期已创建，但编辑凭据无效，请通过分享链接重新解锁'),{code:'INVALID_SESSION'});
    write(sessionStorage,'session',session);window.history.replaceState(null,'','/p/'+projectId);
    applyRecord(next);startPolling();startHeartbeat();emit();if(typeof startWorkspace==='function')startWorkspace();return {...state(),...(typeof value.apiKey==='string'?{apiKey:value.apiKey}:{})};
  }
  async function unlock({displayName,editCode}){
    if(!enabled||screen!=='ready')throw new Error('请先加载排期');
    session=cloudMode?await getCloudTransport().unlock(projectId,{displayName,editCode}):await request('/api/projects/'+projectId+'/session',{method:'POST',body:JSON.stringify({displayName,editCode})});
    if(!sessionValid()){session=null;throw Object.assign(new Error('服务器返回的编辑凭据无效'),{code:'INVALID_SESSION'});}
    write(sessionStorage,'session',session);if(error?.code==='UNAUTHORIZED'||error?.code==='SESSION_EXPIRED')error=null;startHeartbeat();emit();return state();
  }
  async function logout(){
    const token=session?.token;session=null;stopHeartbeat(true);write(sessionStorage,'session',null);emit();
    if(cloudMode&&token){
      try{await getCloudTransport().logout(projectId,token)}catch(e){throw Object.assign(new Error('本机已退出编辑，但云端令牌撤销未完成；令牌到期前仍可能有效。'),{code:e.code||'LOGOUT_FAILED'});}
    }
  }
  function requireEdit(action){
    if(canEdit())return true;
    if(session&&!sessionValid()){session=null;stopHeartbeat(true);write(sessionStorage,'session',null);emit();}
    if(conflict){if(typeof toast==='function')toast('请先处理版本冲突：导出草稿，或加载最新版。','warn',4000);return false;}
    if(screen!=='ready'){if(typeof toast==='function')toast('排期尚未加载完成，请重试连接服务器。','warn');return false;}
    window.dispatchEvent(new CustomEvent('schedule:request-unlock',{detail:{action:action||'编辑排期'}}));return false;
  }
  function noteChange(snapshot){
    if(!enabled||!snapshot||screen!=='ready')return false;
    savePersonal(snapshot);
    if(!canEdit())return false;
    let next;
    try{next=toSharedProject(snapshot)}catch(e){latestSnapshot=clone(snapshot);pending=null;dirty=true;error={code:'INVALID_PROJECT',message:'修改未保存：'+e.message};persistDraft();emit();return false;}
    const content=canonical(next);
    if(content===canonical(latestSnapshot))return false;
    latestSnapshot=next;pending=next;dirty=saving||content!==serverContent;
    if(!dirty)pending=null;
    error=null;persistDraft();emit();return dirty;
  }
  function save(snapshot,options={}){
    if(snapshot)noteChange(snapshot);
    if(pump)return pump;
    if(!enabled||!dirty)return Promise.resolve({ok:true});
    if(error?.code==='INVALID_PROJECT')return Promise.resolve({ok:false,error:error.message});
    if(!canEdit())return Promise.resolve({ok:false,error:conflict?'版本冲突，草稿已保留':'请解锁编辑后重试保存'});
    if(!pending)pending=latestSnapshot;
    pump=(async()=>{
      saving=true;error=null;emit();
      try{
        while(pending&&canEdit()){
          if(error?.code==='INVALID_PROJECT')return {ok:false,error:error.message};
          const outgoing=pending;pending=null;
          try{
            const next=validRecord(cloudMode?await getCloudTransport().save(projectId,{token:session.token,baseRevision:revision,project:outgoing}):await request('/api/projects/'+projectId,{method:'PUT',headers:{Authorization:'Bearer '+session.token},body:JSON.stringify({baseRevision:revision,project:outgoing}),...(options.keepalive?{keepalive:true}:{})}));
            record=next;revision=next.revision;serverContent=canonical(toSharedProject(next.project));
            if(canonical(latestSnapshot)===serverContent){pending=null;dirty=false;error=null;}else{pending=latestSnapshot;dirty=true;}
            persistDraft();emit();
          }catch(e){
            pending=latestSnapshot||outgoing;dirty=true;error={code:e.code||'SAVE_FAILED',message:e.message};
            if(e.status===409){try{conflict=validRecord(e.latest)}catch{conflict={revision,updatedAt:null,updatedBy:null}}}
            if(e.status===401){session=null;stopHeartbeat(true);write(sessionStorage,'session',null);}
            persistDraft();return {ok:false,error:e.message};
          }
        }
        return {ok:!dirty,...(dirty?{error:'草稿尚未保存，请解锁后重试'}:{})};
      }finally{saving=false;pump=null;emit();}
    })();
    return pump;
  }
  async function pollNow(){
    const inputActive=()=>{const active=document.activeElement;return !!(active&&(active.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(active.tagName)));};
    if(!enabled||screen!=='ready'||dirty||saving||polling||dragging||anyOvlOpen()||document.hidden||inputActive())return false;
    polling=true;
    try{
      const next=validRecord(await getRecord(projectId));
      // The user may have started an edit while the request was in flight.
      if(dirty||saving||dragging||anyOvlOpen()||inputActive())return false;
      if(next.revision>revision){savePersonal(proj);applyRecord(next);emit();return true;}
      if(error?.code==='POLL_FAILED'){error=null;emit();}return false;
    }catch(e){error={code:'POLL_FAILED',message:e.message};emit();return false;}finally{polling=false;}
  }
  async function loadLatest(){
    if(pump)await pump;
    const next=validRecord(await getRecord(projectId));
    savePersonal(proj);applyRecord(next);draftAvailable=false;draftPersisted=false;write(localStorage,'draft',null);emit();return state();
  }
  function exportDraft(){
    const draft=latestSnapshot||read(localStorage,'draft')?.project;if(!draft)throw new Error('当前没有可导出的草稿');
    const blob=new Blob([JSON.stringify(draft,null,2)],{type:'application/json'}),link=ce('a');
    link.href=URL.createObjectURL(blob);link.download='排期草稿-'+projectId+'.json';link.click();URL.revokeObjectURL(link.href);return true;
  }
  async function copyLink(){await navigator.clipboard.writeText(state().shareURL);return true;}
  if(enabled){
    window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
    window.addEventListener('pagehide',()=>{pageActive=false;stopHeartbeat(true);if(!dirty)return;if(cloudMode)persistDraft();else void save(undefined,{keepalive:true});});
    window.addEventListener('pageshow',()=>{pageActive=true;startHeartbeat();});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)stopHeartbeat();else if(pageActive)startHeartbeat();});
  }
  return {get enabled(){return enabled},get canEdit(){return canEdit()},state,load,create,unlock,logout,save,noteChange,requireEdit,pollNow,loadLatest,exportDraft,copyLink,refreshPresence,resetApiKey,retrySave:()=>save(),toSharedProject,mergePersonal,savePersonal};
})();
window.SharedWorkspace=SharedWorkspace;
