/* Persist: versioned local storage and confirmed desktop backups. */
let storageRevision=0, storageProjectId=null, saveGeneration=0, pendingDirty=false, lastProjectError='';
let lastSavePromise=Promise.resolve({ok:true});
const STORAGE_FORMAT='schedule-gantt-storage';
// Identifies a project's lineage; this deterministic hash is not an access code.
function stableProjectIdentity(project){
  const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  const content=canonical(project);
  let a=0x811c9dc5,b=0x9e3779b9,c=0x85ebca6b,d=0xc2b2ae35;
  for(let i=0;i<content.length;i++){
    const code=content.charCodeAt(i);
    a=Math.imul(a^code,0x01000193);b=Math.imul(b^code,0x85ebca6b);
    c=Math.imul(c^code,0xc2b2ae35);d=Math.imul(d^code,0x27d4eb2f);
  }
  const finish=value=>{value=Math.imul(value^(value>>>16),0x85ebca6b);value=Math.imul(value^(value>>>13),0xc2b2ae35);return((value^(value>>>16))>>>0).toString(16).padStart(8,'0')};
  return finish(a)+finish(b)+finish(c)+finish(d);
}

function sharedEnabled(){return typeof SharedWorkspace!=='undefined'&&SharedWorkspace.enabled}
function markUnsaved(){if(sharedEnabled()){SharedWorkspace.noteChange(proj);pendingDirty=SharedWorkspace.state().dirty;return}saveGeneration++;pendingDirty=true;$('#save-dot').textContent='未保存';$('#save-dot').classList.add('dirty')}
function schSave(){snap();markUnsaved();clearTimeout(saveT);saveT=setTimeout(doSave,400)}
function doSave(){
  clearTimeout(saveT);saveT=null;
  // Shared saves use the last committed snapshot, never an in-progress drag preview.
  if(sharedEnabled()){lastSavePromise=SharedWorkspace.save();return lastSavePromise;}
  const generation=saveGeneration;
  let stored,json;
  try{
    const snapshot=ScheduleProjectValidation.validateProject(proj);
    if(!storageProjectId)storageProjectId=stableProjectIdentity(snapshot);
    stored={format:STORAGE_FORMAT,version:1,projectId:storageProjectId,revision:++storageRevision,savedAt:new Date().toISOString(),project:snapshot};
    json=JSON.stringify(stored);
    if(new TextEncoder().encode(json).length>ScheduleProjectValidation.LIMITS.maxBytes)throw new Error('保存数据超过 10 MiB，请减少任务或额外数据后再保存');
  }catch(e){
    const error='数据校验失败：'+String(e.message||e);setSaveFail(error);
    lastSavePromise=Promise.resolve({ok:false,error});return lastSavePromise;
  }
  lastSavePromise=(async()=>{
    let localOk=false,backupOk=false,backupError='';
    try{localStorage.setItem('schedule-data',json);localOk=true}catch(e){}
    const hasBackup=!!(window.api&&window.api.backupSave);
    if(hasBackup){
      try{const result=await window.api.backupSave(stored);backupOk=!!(result&&result.ok);backupError=result&&result.error||''}catch(e){backupError=String(e.message||e)}
    }
    const ok=localOk||backupOk;
    if(generation===saveGeneration){
      if(ok){pendingDirty=false;if(hasBackup&&!backupOk)setBackupWarning(backupError);else setSaved()}
      else setSaveFail();
    }
    return{ok,...(!ok?{error:'本地存储和文件备份都未能保存，请导出 JSON 备份。'}:{})};
  })();
  return lastSavePromise;
}
function setSaved(){const d=$('#save-dot');d.textContent='已保存';d.classList.remove('dirty')}
function setBackupWarning(error){const d=$('#save-dot');d.textContent='已保存 · 备份失败';d.classList.add('dirty');toast('修改已保存到本地存储，但文件备份失败。'+(error?' '+error:''),'warn',5000)}
function setSaveFail(message){const d=$('#save-dot');d.textContent='保存失败';d.classList.add('dirty');toast(message||'保存失败：请立即「导出」备份数据','warn',5000)}
function applyProject(d){
  let next;
  try{next=ScheduleProjectValidation.validateProject(d)}catch(e){lastProjectError=String(e.message||e);return false}
  lastProjectError='';proj=next;
  if(typeof WorkspaceShell!=='undefined')WorkspaceShell.prepareLayout(proj);
  document.documentElement.style.setProperty('--left-w',proj.meta.lw+'px');applyColWidths();
  if(typeof applyPaneLayout==='function')applyPaneLayout();
  return true;
}
function storedCandidate(data,source,recovered=false){
  const wrapped=data&&data.format===STORAGE_FORMAT;
  if(wrapped&&(data.version!==1||!Number.isSafeInteger(data.revision)||data.revision<0||typeof data.savedAt!=='string'||!Number.isFinite(Date.parse(data.savedAt))))throw new Error('保存版本信息无效');
  if(wrapped&&data.projectId!==undefined&&(typeof data.projectId!=='string'||!/^[a-f0-9]{32}$/i.test(data.projectId)))throw new Error('保存项目身份无效');
  const project=ScheduleProjectValidation.validateProject(data);
  const projectId=wrapped&&data.projectId!==undefined?data.projectId.toLowerCase():stableProjectIdentity(project);
  return{project,projectId,revision:wrapped?data.revision:0,source,recovered};
}
async function load(){
  if(sharedEnabled())return SharedWorkspace.load();
  const candidates=[],errors=[];
  if(window.api&&window.api.backupLoad){
    try{
      const result=await window.api.backupLoad();
      const data=result&&Object.prototype.hasOwnProperty.call(result,'data')?result.data:result;
      if(data)candidates.push(storedCandidate(data,'backup',!!(result&&result.recovered)));
      else if(result&&result.error)errors.push('文件备份未能读取');
    }catch(e){errors.push('文件备份未能读取')}
  }
  try{const raw=localStorage.getItem('schedule-data');if(raw)candidates.push(storedCandidate(JSON.parse(raw),'local'))}catch(e){errors.push('本地存储未能读取')}
  // 有效便携文件决定当前项目；仅比较同一项目身份的版本。
  const portable=candidates.find(candidate=>candidate.source==='backup');
  const compatible=portable?candidates.filter(candidate=>candidate.projectId===portable.projectId):candidates;
  const latest=compatible.reduce((best,next)=>!best||next.revision>best.revision?next:best,null);
  if(latest){
    storageRevision=latest.revision;storageProjectId=latest.projectId;applyProject(latest.project);
    if(latest.recovered)toast('当前备份损坏，已恢复前一版排期。请核对并导出一份备份。','warn',6000);
    else if(errors.length)toast(errors.join('；')+'，已从另一份有效数据恢复。','warn',6000);
    return;
  }
  applyProject(sample());storageProjectId=stableProjectIdentity(proj);
  if(errors.length)toast(errors.join('；')+'。当前显示示例，原始数据未被删除，请通过导入恢复。','warn',7000);
}
async function flushPendingSave(){
  clearTimeout(saveT);saveT=null;
  if(!proj)return{ok:true};
  let result=await lastSavePromise;
  for(let attempt=0;pendingDirty&&attempt<3;attempt++){result=await doSave();if(!result.ok)break}
  return pendingDirty?{ok:false,error:result.error||'修改仍未保存，请先导出备份。'}:result;
}
if(window.api&&window.api.onBeforeClose)window.api.onBeforeClose(flushPendingSave);
window.addEventListener('pagehide',()=>{if(!sharedEnabled()&&pendingDirty)doSave()});
window.addEventListener('beforeunload',()=>{if(!sharedEnabled()&&pendingDirty)doSave()});
function expJSON(){const b=new Blob([JSON.stringify(proj,null,2)],{type:'application/json'}),a=ce('a');a.href=URL.createObjectURL(b);a.download='排期数据.json';a.click();URL.revokeObjectURL(a.href);flash('已导出')}
function impJSON(){if(!mayEditProject('导入排期'))return;$('#import-file').click()}
