const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const validation = require('../project-validation');
// Each production script and its validator share one realm. These VM harnesses
// transport JSON across realms, like an IPC message, before calling that API.
const vmValidation = {validateProject: input => validation.validateProject(JSON.parse(JSON.stringify(input))),LIMITS:validation.LIMITS};

const root = path.resolve(__dirname, '..');
const mainPath = path.join(root, 'main.js');
const requireFromMain = createRequire(mainPath);
const project = name => ({ tasks: [{id:'t1',name,pid:null,type:'task',s:'2026-10-09',e:'2026-10-10',pct:0,who:'',grp:'策划',deps:[]}],groups:[],flags:[],meta:{lw:440} });
const stored = (revision,name,projectId) => ({format:'schedule-gantt-storage',version:1,revision,savedAt:'2026-10-09T00:00:00.000Z',...(projectId===undefined?{}:{projectId}),project:project(name)});
function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-gantt-persistence-'));
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, {recursive:true,force:true});
  });
  return directory;
}
function mainHarness(options={}) {
  const ipc = new EventEmitter();
  const handlers = new Map();
  ipc.handle = (name,callback) => handlers.set(name,callback);
  const windows = [];
  class FakeWindow extends EventEmitter {
    constructor() {
      super();windows.push(this);
      this.webContents = new EventEmitter();
      this.sent = [];
      this.webContents.send = (...args) => this.sent.push(args);
      this.webContents.setWindowOpenHandler = handler => {this.openHandler=handler;};
      this.closed = false;
    }
    loadFile(file) {this.loadedFile=file;}
    setMenuBarVisibility() {}
    close() {const event={preventDefault(){this.prevented=true;}};this.emit('close',event);if(!event.prevented){this.closed=true;this.emit('closed');}return event;}
    static getAllWindows() {return windows.filter(window=>!window.closed);}
  }
  const app = new EventEmitter();
  app.isPackaged = !!options.packaged;
  app.getPath = () => options.exe || path.join(root,'fake-electron.exe');
  app.whenReady = () => ({then(callback){app.ready=callback;}});
  app.quit = () => {};
  const context = {
    require: name => name==='electron'?{app,BrowserWindow:FakeWindow,ipcMain:ipc,dialog:{showMessageBox:async()=>({response:options.dialogResponse||0})}}:name==='./project-validation'?vmValidation:name==='fs'&&options.fs?options.fs:requireFromMain(name),
    module:{exports:{}},exports:{},__dirname:root,
    process:{platform:'win32',env:options.env||{}},console:options.console||console,setTimeout,clearTimeout,
  };
  vm.createContext(context);vm.runInContext(fs.readFileSync(mainPath,'utf8'),context,{filename:mainPath});
  return {api:context.module.exports,app,ipc,handlers,windows};
}
function rendererHarness(options={}) {
  const html = fs.readFileSync(path.join(root,'index.html'),'utf8');
  const start = html.indexOf('/* Persist: versioned local storage and confirmed desktop backups. */');
  const end = html.indexOf('function expJSON()',start);
  assert.ok(start>=0&&end>start,'actual renderer persistence source exists');
  const source = html.slice(start,end);
  const storage = options.storage || new Map();
  const events = new Map();
  const timers = new Map();
  let timerId=0;
  const classes = new Set();
  const dot = {textContent:'已保存',classList:{add:kind=>classes.add(kind),remove:kind=>classes.delete(kind)}};
  const messages=[];
  const context={
    proj:project('initial'),saveT:null,ScheduleProjectValidation:options.validation||vmValidation,TextEncoder,
    $:()=>dot,document:{documentElement:{style:{setProperty(){}}}},
    getComputedStyle:()=>({getPropertyValue:()=> '440'}),applyColWidths(){},snap(){},sample:()=>project('sample'),
    localStorage:{setItem(key,value){if(options.localFailure)throw Error('unavailable');storage.set(key,value);},getItem:key=>storage.get(key)||null,removeItem(){throw Error('must not delete user data');}},
    window:{api:options.api,addEventListener:(name,handler)=>events.set(name,handler)},
    toast:(...args)=>messages.push(args),
    setTimeout:callback=>{const id=++timerId;timers.set(id,callback);return id;},clearTimeout:id=>timers.delete(id),
  };
  vm.createContext(context);vm.runInContext(source,context);
  return {context,storage,dot,messages,events,timers,state:expression=>vm.runInContext(expression,context)};
}

test('development backup directory is the project, packaged directory follows portable exe',()=>{
  const dev=mainHarness({env:{PORTABLE_EXECUTABLE_DIR:'D:\\portable'}});
  assert.equal(dev.api.backupDir(),root);
  const portable=mainHarness({packaged:true,env:{PORTABLE_EXECUTABLE_DIR:'D:\\portable'}});
  assert.equal(portable.api.backupDir(),'D:\\portable');
});

test('atomic writes retain a previous version and recover truncated current JSON',t=>{
  const directory=tempDirectory(t),file=path.join(directory,'排期数据.json');
  const {api}=mainHarness();
  api.writeBackup(stored(1,'first'),file);api.writeBackup(stored(2,'second'),file);
  assert.equal(api.readBackup(file).data.project.tasks[0].name,'second');
  assert.equal(JSON.parse(fs.readFileSync(api.previousFile(file),'utf8')).project.tasks[0].name,'first');
  fs.writeFileSync(file,'{"project":');
  const recovered=api.readBackup(file);
  assert.equal(recovered.recovered,true);assert.equal(recovered.data.project.tasks[0].name,'first');
  api.writeBackup(stored(3,'third'),file);
  assert.equal(api.readBackup(file).data.revision,3);
  assert.equal(JSON.parse(fs.readFileSync(api.previousFile(file),'utf8')).revision,1);
});

test('failed atomic replacement leaves existing JSON intact and no temp files',t=>{
  const directory=tempDirectory(t),file=path.join(directory,'排期数据.json');
  mainHarness().api.writeBackup(stored(1,'first'),file);
  const brokenFS=Object.create(fs);
  brokenFS.renameSync=(from,to)=>{if(to===file)throw Error('simulated rename failure');return fs.renameSync(from,to);};
  assert.throws(()=>mainHarness({fs:brokenFS}).api.writeBackup(stored(2,'second'),file),/rename failure/);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).revision,1);
  assert.equal(fs.readdirSync(directory).some(name=>name.endsWith('.tmp')),false);
});

test('legacy JSON remains readable and invalid writes cannot replace existing data',t=>{
  const directory=tempDirectory(t),file=path.join(directory,'排期数据.json');
  fs.writeFileSync(file,JSON.stringify(project('legacy')));
  const {api}=mainHarness();
  assert.equal(api.readBackup(file).data.tasks[0].name,'legacy');
  assert.throws(()=>api.writeBackup({tasks:[{id:'x',s:'invalid',e:'invalid'}]},file));
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).tasks[0].name,'legacy');
  assert.throws(()=>api.normalizeStorage({...stored(1,'x'),revision:-1}));
});

test('desktop close waits for a trusted matching flush and blocks remote navigation',()=>{
  const harness=mainHarness();harness.api.createWindow();const window=harness.windows[0];
  harness.ipc.emit('backup:renderer-ready',{sender:window.webContents});
  assert.equal(window.close().prevented,true);assert.equal(window.closed,false);
  const [channel,requestId]=window.sent[0];assert.equal(channel,'backup:before-close');
  harness.ipc.emit('backup:close-ready',{sender:{}},{requestId,ok:true});assert.equal(window.closed,false);
  harness.ipc.emit('backup:close-ready',{sender:window.webContents},{requestId:'wrong',ok:true});assert.equal(window.closed,false);
  const event={preventDefault(){this.prevented=true;}};
  window.webContents.emit('will-navigate',event,'https://example.com');assert.equal(event.prevented,true);
  assert.equal(window.openHandler().action,'deny');
  harness.ipc.emit('backup:close-ready',{sender:window.webContents},{requestId,ok:true});assert.equal(window.closed,true);
});

test('main IPC refuses untrusted data requests',async()=>{
  const harness=mainHarness();harness.api.createWindow();
  assert.equal((await harness.handlers.get('backup:save')({sender:{}},project('x'))).ok,false);
  assert.equal((await harness.handlers.get('backup:load')({sender:{}})).data,null);
  assert.equal(await harness.handlers.get('backup:path')({sender:{}}),null);
  harness.windows[0].close();
});

test('saved indicator waits for disk acknowledgement',async()=>{
  let acknowledge;
  const renderer=rendererHarness({api:{backupSave:()=>new Promise(resolve=>acknowledge=resolve)}});
  renderer.context.markUnsaved();const saving=renderer.context.doSave();
  assert.equal(renderer.dot.textContent,'未保存');
  acknowledge({ok:true});assert.equal((await saving).ok,true);
  assert.equal(renderer.dot.textContent,'已保存');assert.equal(renderer.state('pendingDirty'),false);
});

test('failed disk backup cannot roll back newer successful local save on restart',async()=>{
  const storage=new Map();
  const api={backupLoad:async()=>({data:stored(7,'old'),recovered:false}),backupSave:async()=>({ok:false,error:'read only'})};
  const first=rendererHarness({storage,api});await first.context.load();
  first.context.proj.tasks[0].name='new';first.context.markUnsaved();assert.equal((await first.context.doSave()).ok,true);
  assert.match(first.dot.textContent,/备份失败/);
  const restarted=rendererHarness({storage,api});await restarted.context.load();
  assert.equal(restarted.context.proj.tasks[0].name,'new');assert.equal(restarted.state('storageRevision'),8);
});

test('older completed saves cannot clear newer unsaved changes; close flushes them',async()=>{
  let firstReply,calls=0;
  const renderer=rendererHarness({api:{backupSave:()=>++calls===1?new Promise(resolve=>firstReply=resolve):Promise.resolve({ok:true})}});
  renderer.context.markUnsaved();const first=renderer.context.doSave();
  renderer.context.proj.tasks[0].name='latest';renderer.context.schSave();
  firstReply({ok:true});await first;
  assert.equal(renderer.dot.textContent,'未保存');assert.equal(renderer.state('pendingDirty'),true);
  assert.equal((await renderer.context.flushPendingSave()).ok,true);assert.equal(renderer.timers.size,0);
  assert.equal(JSON.parse(renderer.storage.get('schedule-data')).project.tasks[0].name,'latest');
});

test('total save failure keeps dirty state and prevents confirmed close',async()=>{
  const renderer=rendererHarness({localFailure:true,api:{backupSave:async()=>({ok:false})}});
  renderer.context.schSave();assert.equal((await renderer.context.flushPendingSave()).ok,false);
  assert.equal(renderer.state('pendingDirty'),true);assert.equal(renderer.dot.textContent,'保存失败');
});

test('invalid imported project does not replace current project or mutate input',()=>{
  const renderer=rendererHarness();const invalid={tasks:[],groups:{length:1}};const before=JSON.stringify(invalid);
  assert.equal(renderer.context.applyProject(invalid),false);
  assert.equal(renderer.context.proj.tasks[0].name,'initial');assert.equal(JSON.stringify(invalid),before);
});

test('corrupt storage is preserved and never automatically written as sample data',async()=>{
  const storage=new Map([['schedule-data','{"tasks":']]);let writes=0;
  const renderer=rendererHarness({storage,api:{backupLoad:async()=>({data:null,error:'bad JSON'}),backupSave:async()=>{writes++;return {ok:true};}}});
  await renderer.context.load();
  assert.equal(renderer.context.proj.tasks[0].name,'sample');assert.equal(storage.get('schedule-data'),'{"tasks":');assert.equal(writes,0);
});

test('browser unload synchronously stores pending changes',()=>{
  const renderer=rendererHarness();renderer.context.schSave();renderer.events.get('beforeunload')();
  assert.equal(JSON.parse(renderer.storage.get('schedule-data')).project.tasks[0].name,'initial');
  assert.equal(renderer.state('pendingDirty'),false);
});

test('preload bridge acknowledges asynchronous close flush and unsubscribes',async()=>{
  const ipc=new EventEmitter(),sent=[];let api;
  ipc.send=(...args)=>sent.push(args);
  const context={require:()=>({ipcRenderer:ipc,contextBridge:{exposeInMainWorld(_name,value){api=value;}}})};
  vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(root,'preload.js'),'utf8'),context);
  const unsubscribe=api.onBeforeClose(async()=>({ok:true}));
  assert.equal(sent[0][0],'backup:renderer-ready');
  ipc.emit('backup:before-close',{},'request-1');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sent[1][0],'backup:close-ready');assert.equal(sent[1][1].requestId,'request-1');assert.equal(sent[1][1].ok,true);
  unsubscribe();assert.equal(ipc.listenerCount('backup:before-close'),0);
  api.onBeforeClose(async()=>{throw Error('flush failed');});
  ipc.emit('backup:before-close',{},'request-2');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sent.at(-1)[1].ok,false);assert.equal(sent.at(-1)[1].error,'flush failed');
});

test('desktop close can return to the tool after failed flush then safely retry',async()=>{
  const harness=mainHarness();harness.api.createWindow();const window=harness.windows[0];
  harness.ipc.emit('backup:renderer-ready',{sender:window.webContents});window.close();
  harness.ipc.emit('backup:close-ready',{sender:window.webContents},{requestId:window.sent[0][1],ok:false,error:'unsaved'});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(window.closed,false);
  assert.equal(window.close().prevented,true);assert.equal(window.sent.length,2);
  harness.ipc.emit('backup:close-ready',{sender:window.webContents},{requestId:window.sent[1][1],ok:true});assert.equal(window.closed,true);
});

test('native failure dialog rejection is handled and the tool can retry closing',async t=>{
  const rejected=[],logged=[];
  const onRejection=error=>rejected.push(error);
  process.on('unhandledRejection',onRejection);
  t.after(()=>process.removeListener('unhandledRejection',onRejection));
  const harness=mainHarness({
    get dialogResponse(){throw Error('native dialog unavailable');},
    console:{...console,error:(...args)=>logged.push(args)},
  });
  harness.api.createWindow();const window=harness.windows[0];
  harness.ipc.emit('backup:renderer-ready',{sender:window.webContents});window.close();
  harness.ipc.emit('backup:close-ready',{sender:window.webContents},{requestId:window.sent[0][1],ok:false,error:'unsaved'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(rejected.length,0);assert.equal(window.closed,false);
  assert.equal(logged.length,1);assert.match(String(logged[0][0]),/保存失败提示未能显示/);
  assert.equal(window.close().prevented,true);assert.equal(window.sent.length,2);
  harness.ipc.emit('backup:close-ready',{sender:window.webContents},{requestId:window.sent[1][1],ok:true});
  assert.equal(window.closed,true);
});

test('first load and clean close do not persist or overwrite sample data',async()=>{
  let writes=0;
  const renderer=rendererHarness({api:{backupLoad:async()=>({data:null}),backupSave:async()=>{writes++;return {ok:true};}}});
  await renderer.context.load();assert.equal((await renderer.context.flushPendingSave()).ok,true);
  assert.equal(writes,0);assert.equal(renderer.storage.size,0);
});

test('storage wrapper overhead cannot turn an accepted project into an unreadable saved file',async()=>{
  const boundary=validation.validateProject(project('boundary'));boundary.extra='';
  boundary.extra='x'.repeat(validation.LIMITS.maxBytes-Buffer.byteLength(JSON.stringify(boundary)));
  assert.equal(Buffer.byteLength(JSON.stringify(boundary)),validation.LIMITS.maxBytes);
  validation.validateProject(boundary);
  let writes=0;
  const renderer=rendererHarness({api:{backupSave:async()=>{writes++;return {ok:true};}}});
  renderer.context.proj=boundary;renderer.context.markUnsaved();
  assert.equal((await renderer.context.doSave()).ok,false);assert.equal(renderer.storage.size,0);assert.equal(writes,0);
  assert.equal(renderer.state('pendingDirty'),true);
});

test('main preserves valid project identity, normalizes case, and rejects malformed identity',()=>{
  const {api}=mainHarness();
  assert.equal(api.normalizeStorage(stored(1,'same','ABCDEF0123456789ABCDEF0123456789')).projectId,'abcdef0123456789abcdef0123456789');
  assert.equal(Object.hasOwn(api.normalizeStorage(stored(1,'old wrapper')),'projectId'),false);
  for(const invalid of [null,{},1,'','too-short','g'.repeat(32),'a'.repeat(33)]){
    assert.throws(()=>api.normalizeStorage(stored(1,'invalid',invalid)),/项目身份无效/);
  }
});

test('legacy project identity is deterministic across JSON key order after normalization',()=>{
  const renderer=rendererHarness();
  const first=validation.validateProject(project('same'));
  function reorder(value){
    if(Array.isArray(value))return value.map(reorder);
    if(!value||typeof value!=='object')return value;
    return Object.fromEntries(Object.keys(value).reverse().map(key=>[key,reorder(value[key])]));
  }
  const inputBefore=JSON.stringify(first);
  const bare=renderer.context.storedCandidate(first,'backup');
  const reordered=renderer.context.storedCandidate(reorder(first),'local');
  const legacyWrapped=renderer.context.storedCandidate({...stored(20,'unused'),project:reorder(first)},'local');
  assert.match(bare.projectId,/^[a-f0-9]{32}$/);assert.equal(bare.projectId,reordered.projectId);assert.equal(bare.projectId,legacyWrapped.projectId);
  assert.equal(JSON.stringify(first),inputBefore);
  assert.notEqual(bare.projectId,renderer.context.storedCandidate(project('changed'),'backup').projectId);
});

test('new local save keeps legacy bare-file identity after disk failure and is chosen on reload',async()=>{
  const storage=new Map(),oldFile=project('old bare file');
  const api={backupLoad:async()=>({data:oldFile,recovered:false}),backupSave:async()=>({ok:false,error:'read only'})};
  const first=rendererHarness({storage,api});await first.context.load();
  const originalIdentity=first.state('storageProjectId');
  first.context.proj.tasks[0].name='new local edit';first.context.schSave();assert.equal((await first.context.doSave()).ok,true);
  const local=JSON.parse(storage.get('schedule-data'));assert.equal(local.projectId,originalIdentity);assert.equal(local.revision,1);
  const reload=rendererHarness({storage,api});await reload.context.load();
  assert.equal(reload.context.proj.tasks[0].name,'new local edit');assert.equal(reload.state('storageProjectId'),originalIdentity);assert.equal(reload.state('storageRevision'),1);
});

test('unrelated legacy local project cannot override copied portable project with a lower revision',async()=>{
  const storage=new Map([['schedule-data',JSON.stringify(stored(20,'unrelated local board'))]]);
  const portable=stored(3,'copied portable board');
  const renderer=rendererHarness({storage,api:{backupLoad:async()=>({data:portable})}});await renderer.context.load();
  assert.equal(renderer.context.proj.tasks[0].name,'copied portable board');assert.equal(renderer.state('storageRevision'),3);
  assert.equal(renderer.state('storageProjectId'),renderer.context.storedCandidate(portable,'backup').projectId);
  renderer.context.schSave();await renderer.context.doSave();
  assert.equal(JSON.parse(storage.get('schedule-data')).revision,4);
});

test('explicit identities compare revisions only within the portable project lineage',async()=>{
  const portableId='a'.repeat(32),otherId='b'.repeat(32);
  for(const [localId,expectedName,expectedRevision] of [[otherId,'portable',3],[portableId,'newer local content',20],[portableId.toUpperCase(),'newer local content',20]]){
    const storage=new Map([['schedule-data',JSON.stringify(stored(20,'newer local content',localId))]]);
    const renderer=rendererHarness({storage,api:{backupLoad:async()=>({data:stored(3,'portable',portableId)})}});await renderer.context.load();
    assert.equal(renderer.context.proj.tasks[0].name,expectedName);assert.equal(renderer.state('storageRevision'),expectedRevision);assert.equal(renderer.state('storageProjectId'),portableId);
  }
});

test('corrupt current file can recover previous identity and newer matching local changes',async t=>{
  const directory=tempDirectory(t),file=path.join(directory,'排期数据.json'),projectId='c'.repeat(32);
  const main=mainHarness();main.api.writeBackup(stored(1,'first',projectId),file);main.api.writeBackup(stored(2,'second',projectId),file);fs.writeFileSync(file,'{broken');
  const storage=new Map([['schedule-data',JSON.stringify(stored(3,'newest local',projectId))]]);
  const renderer=rendererHarness({storage,api:{backupLoad:async()=>main.api.readBackup(file),backupSave:async data=>main.api.writeBackup(data,file)}});
  await renderer.context.load();assert.equal(renderer.context.proj.tasks[0].name,'newest local');assert.equal(renderer.state('storageProjectId'),projectId);
  renderer.context.schSave();assert.equal((await renderer.context.doSave()).ok,true);
  assert.equal(main.api.readBackup(file).data.projectId,projectId);assert.equal(main.api.readBackup(file).data.revision,4);
  assert.equal(JSON.parse(fs.readFileSync(main.api.previousFile(file),'utf8')).revision,1);
});

test('no valid portable copy allows restoration of a valid local project identity',async t=>{
  const directory=tempDirectory(t),file=path.join(directory,'排期数据.json'),projectId='d'.repeat(32);
  fs.writeFileSync(file,'{bad current');fs.writeFileSync(mainHarness().api.previousFile(file),'{bad previous');
  const main=mainHarness();const storage=new Map([['schedule-data',JSON.stringify(stored(8,'local recovery',projectId))]]);
  const renderer=rendererHarness({storage,api:{backupLoad:async()=>main.api.readBackup(file)}});await renderer.context.load();
  assert.equal(renderer.context.proj.tasks[0].name,'local recovery');assert.equal(renderer.state('storageProjectId'),projectId);assert.equal(renderer.state('storageRevision'),8);
});

test('invalid local identity is rejected without replacing valid portable data',async()=>{
  const portableId='e'.repeat(32);
  for(const invalid of [null,{},1,'not-hex']){
    const original=JSON.stringify(stored(99,'invalid local',invalid));
    const storage=new Map([['schedule-data',original]]);
    const renderer=rendererHarness({storage,api:{backupLoad:async()=>({data:stored(2,'valid portable',portableId)})}});await renderer.context.load();
    assert.equal(renderer.context.proj.tasks[0].name,'valid portable');assert.equal(renderer.state('storageProjectId'),portableId);assert.equal(storage.get('schedule-data'),original);
  }
});

test('import and history-style restoration preserve current project identity',async()=>{
  const projectId='f'.repeat(32),original=stored(2,'current board',projectId);
  const renderer=rendererHarness({api:{backupLoad:async()=>({data:original})}});await renderer.context.load();
  assert.equal(renderer.context.applyProject(project('imported content')),true);
  renderer.context.schSave();await renderer.context.doSave();assert.equal(JSON.parse(renderer.storage.get('schedule-data')).projectId,projectId);
  assert.equal(renderer.context.applyProject(original.project),true);
  renderer.context.markUnsaved();await renderer.context.doSave();assert.equal(JSON.parse(renderer.storage.get('schedule-data')).projectId,projectId);assert.equal(renderer.state('storageProjectId'),projectId);
});
