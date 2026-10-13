/* Manual integration: electron.exe test/electron-smoke.cjs [path/to/app.asar]
 * This script opens only a hidden window. All mutable data stays in its own
 * .repair-work/electron-smoke-* directory; it never edits existing backups.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const electron = require('electron');
const { app, BrowserWindow } = electron;

const projectRoot = path.resolve(__dirname, '..');
const runId = Date.now() + '-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
const runDirectory = path.join(projectRoot, '.repair-work', 'electron-smoke-' + runId);
const userDataDirectory = path.join(runDirectory, 'user-data');
const backupDirectory = path.join(runDirectory, 'backup');
const reportPath = path.join(runDirectory, 'report.json');
const sourceArgument = process.argv.slice(2).find(argument => !argument.startsWith('--'));
const resourceDirectory = sourceArgument ? path.resolve(sourceArgument) : projectRoot;
const mainPath = path.join(resourceDirectory, 'main.js');
const currentFile = path.join(backupDirectory, '排期数据.json');
const previousFile = path.join(backupDirectory, '排期数据.previous.json');
const checks = [];
const windows = [];
let finished = false;
let mainQuitRequested = false;
let resolveMainQuit;
const mainQuit = new Promise(resolve => { resolveMainQuit = resolve; });
let originalLoad;

for (const directory of [runDirectory,userDataDirectory,backupDirectory,path.join(userDataDirectory,'session'),path.join(runDirectory,'crash-dumps')]) {
  fs.mkdirSync(directory,{recursive:true});
}
app.setPath('userData',userDataDirectory);
app.setPath('sessionData',path.join(userDataDirectory,'session'));
app.setPath('crashDumps',path.join(runDirectory,'crash-dumps'));
app.commandLine.appendSwitch('disable-gpu');
process.env.PORTABLE_EXECUTABLE_DIR = backupDirectory;

function writeReport(error) {
  const report = {
    ok: !error,
    runDirectory, resourceDirectory, mainPath,
    isolation: {userData:app.getPath('userData'),backupDirectory},
    electron:process.versions.electron,node:process.versions.node,
    mainQuitRequested,
    checks,
    ...(error?{error:{message:String(error.message||error),stack:error.stack||''}}:{}),
  };
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2),'utf8');
  process.stdout.write(JSON.stringify({ok:report.ok,checks:checks.length,report:reportPath})+'\n');
}
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(overallTimeout);
  if (originalLoad) Module._load = originalLoad;
  try { writeReport(error); } catch (reportError) { process.stderr.write(String(reportError)+'\n'); }
  if (error) { process.stderr.write(String(error.stack||error)+'\n'); app.exit(1); return; }
  app.quit();
  const forceExit = setTimeout(() => app.exit(0),3000);
  forceExit.unref();
}
const overallTimeout = setTimeout(() => finish(new Error('Electron smoke timed out after 45 seconds')),45000);
process.on('uncaughtException',finish);
process.on('unhandledRejection',finish);

// Only the tested main module receives these adapters. Preload uses Electron's
// real context bridge and IPC implementation in its isolated renderer process.
const testedApp = new Proxy(app, {
  get(target,key) {
    if (key === 'isPackaged') return true;
    if (key === 'quit') return () => {mainQuitRequested=true;resolveMainQuit();};
    const value = Reflect.get(target,key,target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
class HiddenWindow extends BrowserWindow {
  constructor(options) {
    super({...options,show:false});
    this.smokeLoaded = new Promise((resolve,reject) => {
      this.webContents.once('did-finish-load',resolve);
      this.webContents.once('did-fail-load',(_event,code,description) => reject(new Error('Page load failed '+code+': '+description)));
      this.webContents.once('render-process-gone',(_event,detail) => reject(new Error('Renderer exited: '+detail.reason)));
    });
    this.smokeLoaded.catch(finish);
    windows.push(this);
  }
}
HiddenWindow.getAllWindows = () => BrowserWindow.getAllWindows();
const adaptedElectron = {app:testedApp,BrowserWindow:HiddenWindow,ipcMain:electron.ipcMain,dialog:electron.dialog};
originalLoad = Module._load;
Module._load = function(request,parent,isMain) {
  if (request === 'electron' && parent && path.resolve(parent.filename) === mainPath) return adaptedElectron;
  return originalLoad.call(this,request,parent,isMain);
};

async function check(name,callback) {
  const started = Date.now();
  try {
    const result = await callback();
    checks.push({name,ok:true,durationMs:Date.now()-started,...(result===undefined?{}:{result})});
  } catch (error) {
    checks.push({name,ok:false,durationMs:Date.now()-started,error:String(error.message||error)});
    throw error;
  }
}
const delay = milliseconds => new Promise(resolve=>setTimeout(resolve,milliseconds));
async function ready(window) {
  await window.smokeLoaded;
  return window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
    const deadline=Date.now()+5000;
    function poll(){
      if(typeof proj!=='undefined'&&proj&&typeof schSave==='function'&&window.api&&typeof window.api.backupSave==='function'&&document.querySelector('#g-left-body'))return resolve({tasks:proj.tasks.length});
      if(Date.now()>deadline)return reject(new Error('Renderer initialization did not finish'));
      setTimeout(poll,10);
    }
    poll();
  })`);
}
async function reload(window) {
  const loaded = new Promise((resolve,reject)=>{
    window.webContents.once('did-finish-load',resolve);
    window.webContents.once('did-fail-load',(_event,code,description)=>reject(new Error('Reload failed '+code+': '+description)));
  });
  window.webContents.reloadIgnoringCache();
  await loaded;
  return ready(window);
}
function diskData(file=currentFile) { return JSON.parse(fs.readFileSync(file,'utf8')); }

const fixture = {
  tasks:[{id:'smoke-task',name:'真实 IPC 保存',pid:null,type:'task',s:'2026-10-09',e:'2026-10-10',pct:25,who:'Smoke负责人',grp:'策划',deps:[]}],
  groups:[],flags:[],meta:{lw:440},
};

(async()=>{
  assert.ok(fs.existsSync(mainPath),'main.js exists in the selected source or app.asar');
  require(mainPath);
  Module._load = originalLoad;
  await app.whenReady();
  const windowDeadline=Date.now()+5000;
  while(!windows.length){if(Date.now()>windowDeadline)throw new Error('Main module did not create a window');await delay(10);}
  const window = windows[0];
  await ready(window);

  await check('hidden window, isolated storage, first load does not save samples',async()=>{
    assert.equal(window.isVisible(),false);
    assert.equal(app.getPath('userData'),userDataDirectory);
    assert.equal(fs.existsSync(currentFile),false);
    const backupPath=await window.webContents.executeJavaScript('window.api.backupPath()');
    assert.equal(backupPath,currentFile);
    return {backupPath,visible:false};
  });

  await check('real preload IPC saves and reads the versioned project',async()=>{
    const result=await window.webContents.executeJavaScript(`(async()=>{
      if(!applyProject(${JSON.stringify(fixture)}))throw new Error(lastProjectError);
      render();snap();markUnsaved();
      const saved=await doSave();
      const loaded=await window.api.backupLoad();
      return{saved,loaded,status:document.querySelector('#save-dot').textContent};
    })()`);
    assert.equal(result.saved.ok,true);
    assert.equal(result.loaded.recovered,false);
    assert.equal(result.loaded.data.format,'schedule-gantt-storage');
    assert.equal(result.loaded.data.project.tasks[0].name,fixture.tasks[0].name);
    assert.equal(result.status,'已保存');
    assert.equal(diskData().project.tasks[0].name,fixture.tasks[0].name);
    return {revision:result.loaded.data.revision};
  });

  await check('atomic replacement preserves the previous project',async()=>{
    const firstRevision=diskData().revision;
    const result=await window.webContents.executeJavaScript(`(async()=>{
      proj.tasks[0].name='第二次文件保存';markUnsaved();return doSave();
    })()`);
    assert.equal(result.ok,true);
    assert.equal(diskData().project.tasks[0].name,'第二次文件保存');
    assert.equal(diskData(previousFile).project.tasks[0].name,'真实 IPC 保存');
    assert.ok(diskData().revision>firstRevision);
  });

  await check('IPC validation refuses malformed data without replacing the file',async()=>{
    const before=fs.readFileSync(currentFile,'utf8');
    const result=await window.webContents.executeJavaScript(`window.api.backupSave({tasks:[{id:'broken',s:'not-a-date',e:'not-a-date'}]})`);
    assert.equal(result.ok,false);assert.equal(fs.readFileSync(currentFile,'utf8'),before);
  });

  await check('new local save survives a failed disk backup and actual page reload',async()=>{
    const oldRevision=diskData().revision;
    process.env.PORTABLE_EXECUTABLE_DIR=path.join(backupDirectory,'intentionally-missing');
    try{
      const result=await window.webContents.executeJavaScript(`(async()=>{
        proj.tasks[0].name='文件备份失败后保留的本地新版本';markUnsaved();
        const saved=await doSave();return{saved,status:document.querySelector('#save-dot').textContent};
      })()`);
      assert.equal(result.saved.ok,true);assert.match(result.status,/备份失败/);
      assert.equal(diskData().revision,oldRevision);
    }finally{process.env.PORTABLE_EXECUTABLE_DIR=backupDirectory;}
    await reload(window);
    const restored=await window.webContents.executeJavaScript('({name:proj.tasks[0].name,revision:storageRevision})');
    assert.equal(restored.name,'文件备份失败后保留的本地新版本');assert.ok(restored.revision>oldRevision);
    const saved=await window.webContents.executeJavaScript('doSave()');assert.equal(saved.ok,true);
    return restored;
  });

  await check('copied lower-revision portable project wins over unrelated high-revision local data',async()=>{
    const oldFile=diskData();
    const copiedId=oldFile.projectId==='1'.repeat(32)?'2'.repeat(32):'1'.repeat(32);
    const copied={format:'schedule-gantt-storage',version:1,projectId:copiedId,revision:1,savedAt:new Date().toISOString(),project:{...fixture,tasks:[{...fixture.tasks[0],name:'另一份低版本便携排期'}]}};
    const oldLocal=await window.webContents.executeJavaScript("JSON.parse(localStorage.getItem('schedule-data'))");
    assert.ok(oldLocal.revision>copied.revision);assert.notEqual(oldLocal.projectId,copiedId);
    fs.writeFileSync(currentFile,JSON.stringify(copied,null,2),'utf8');
    await reload(window);
    const selected=await window.webContents.executeJavaScript('({name:proj.tasks[0].name,revision:storageRevision,projectId:storageProjectId})');
    assert.equal(selected.name,'另一份低版本便携排期');assert.equal(selected.revision,1);assert.equal(selected.projectId,copiedId);
    return selected;
  });

  await check('legacy bare JSON keeps stable identity when the first file backup fails',async()=>{
    const legacy={...fixture,tasks:[{...fixture.tasks[0],name:'旧裸 JSON 排期'}]};
    fs.writeFileSync(currentFile,JSON.stringify(legacy,null,2),'utf8');
    await reload(window);
    const original=await window.webContents.executeJavaScript('({name:proj.tasks[0].name,revision:storageRevision,projectId:storageProjectId})');
    assert.equal(original.name,'旧裸 JSON 排期');assert.equal(original.revision,0);assert.match(original.projectId,/^[a-f0-9]{32}$/);
    process.env.PORTABLE_EXECUTABLE_DIR=path.join(backupDirectory,'intentionally-missing-legacy');
    try{
      const saved=await window.webContents.executeJavaScript(`(async()=>{
        proj.tasks[0].name='旧 JSON 首次文件失败后的本地新排期';markUnsaved();return doSave();
      })()`);
      assert.equal(saved.ok,true);assert.equal(diskData().format,undefined);
    }finally{process.env.PORTABLE_EXECUTABLE_DIR=backupDirectory;}
    await reload(window);
    const restored=await window.webContents.executeJavaScript('({name:proj.tasks[0].name,revision:storageRevision,projectId:storageProjectId})');
    assert.equal(restored.name,'旧 JSON 首次文件失败后的本地新排期');assert.equal(restored.projectId,original.projectId);assert.equal(restored.revision,1);
    const saved=await window.webContents.executeJavaScript('doSave()');assert.equal(saved.ok,true);
    assert.equal(diskData().projectId,original.projectId);
    return restored;
  });

  await check('closing immediately flushes the pending 400 ms save through real IPC',async()=>{
    const closed=new Promise(resolve=>window.once('closed',resolve));
    const before=await window.webContents.executeJavaScript(`(()=>{
      proj.tasks[0].name='关闭前立即修改';render();schSave();
      return{pending:!!saveT,status:document.querySelector('#save-dot').textContent};
    })()`);
    assert.equal(before.pending,true);assert.equal(before.status,'未保存');
    window.close();
    await closed;
    await Promise.race([mainQuit,delay(2000).then(()=>{throw new Error('Production main did not request quit after closing');})]);
    assert.equal(diskData().project.tasks[0].name,'关闭前立即修改');
    assert.equal(fs.readdirSync(backupDirectory).some(name=>name.endsWith('.tmp')),false);
    return {revision:diskData().revision,mainQuitRequested};
  });
  finish();
})().catch(finish);
