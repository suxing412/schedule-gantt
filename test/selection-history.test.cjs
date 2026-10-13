const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),test=require('node:test');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/\r\n/g,'\n');
function section(a,b){const i=source.indexOf(a),j=source.indexOf(b,i);assert.ok(i>=0&&j>i,a);return source.slice(i,j)}
function fixture(){
 const elements=new Map(),styles=new Map([['--left-w','440px']]),events=new Map();
 const document={documentElement:{style:{setProperty:(k,v)=>styles.set(k,v)}},querySelector(s){if(!elements.has(s)){const classes=new Set();elements.set(s,{hidden:true,value:'',classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name),toggle(name,force){const enabled=force===undefined?!classes.has(name):Boolean(force);if(enabled)classes.add(name);else classes.delete(name);return enabled}},addEventListener:(type,fn)=>events.set(s+':'+type,fn)});}return elements.get(s)}};
 const c=vm.createContext({document,getComputedStyle:()=>({getPropertyValue:k=>styles.get(k)||''}),setTimeout:()=>1,clearTimeout(){},FileReader:class{readAsText(f){this.result=f.text;this.onload()}}});
 vm.runInContext([
 section('const DAY_MS','const ZOOM'),
 'let proj,selId=null,selIds=new Set(),filterQ="",filterGrp=null,filterPhase=null,saveT=null,idC=1; const $=s=>document.querySelector(s); let settingsRenders=0,dirtyCalls=0; function render(){} function toast(){} function doSave(){} function markUnsaved(){dirtyCalls++} function renderSettings(){settingsRenders++}',
 section('let hist = [], histI = -1;','const $  ='),section('function uid()','/* Sample data */'),section('const byId','// Analysis'),
 'function schSave(){snap()}',section('function dupTask','function bindCtxMenu'),section('function delSel','/* Shared boards:'),section('const tableLayoutState=','function bindColRz()')].join('\n'),c);
 return {c,document,styles,events,run:s=>vm.runInContext(s,c,{timeout:1000}),json:s=>JSON.parse(vm.runInContext('JSON.stringify('+s+')',c,{timeout:1000})),load(p){c.input=p;vm.runInContext('proj=JSON.parse(JSON.stringify(input));snap()',c)}};
}
const task=(id,pid=null,deps=[])=>({id,name:id,pid,type:'task',s:'2026-10-01',e:'2026-10-02',pct:0,grp:'策划',phase:'原型',deps});
const project=(tasks=[task('source')])=>({tasks,groups:[{name:'策划',color:'#123456'}],flags:[],meta:{lw:440,cols:{person:64,date:76,pct:52},roleColors:{策划:'#123456'},hiddenRoles:[],defView:'week'}});

test('copy selects its root and preserves external prerequisites while remapping internal ones',()=>{
 const f=fixture();f.load(project([task('external'),task('source',null,['external']),task('child','source',['source','external'])]));
 f.run('selId="source";selIds=new Set(["source"]);dupTask("source")');
 const r=f.json('({primary:selId,selected:[...selIds],copies:proj.tasks.filter(t=>!["external","source","child"].includes(t.id))})');
 assert.deepEqual(r.selected,[r.primary]);const [a,b]=r.copies;
 assert.equal(a.id,r.primary);assert.deepEqual(a.deps,['external']);assert.equal(b.pid,a.id);assert.deepEqual(b.deps,[a.id,'external']);
 assert.equal(a.s,'2026-10-02');assert.equal(b.e,'2026-10-03');
 f.run('delSel()');assert.deepEqual(f.json('proj.tasks.map(t=>t.id)'),['external','source','child']);
});
test('undo and redo restore metadata, colors, hidden roles and widths together',()=>{
 const f=fixture(),before=project();f.load(before);
 f.run('proj.groups[0].color="#abcdef";proj.meta.roleColors["策划"]="#abcdef";proj.meta.hiddenRoles=["美术"];proj.meta.defView="month";proj.meta.cols.person=100');
 f.styles.set('--left-w','620px');f.run('proj.meta.lw=620;snap();undo()');
 assert.deepEqual(f.json('proj'),before);assert.equal(f.styles.get('--left-w'),'440px');assert.equal(f.styles.get('--col-person'),'64px');
 f.run('redo()');const meta=f.json('proj.meta');assert.equal(meta.lw,620);assert.equal(meta.defView,'month');assert.deepEqual(meta.hiddenRoles,['美术']);assert.equal(meta.roleColors['策划'],'#abcdef');assert.equal(f.json('proj.groups')[0].color,'#abcdef');assert.equal(f.styles.get('--left-w'),'620px');assert.equal(f.styles.get('--col-person'),'100px');assert.equal(f.run('dirtyCalls'),2);
});
test('undo clears stale selection and unavailable filters, preserving valid queries',()=>{
 const f=fixture();f.load(project());
 f.run('proj.tasks[0].phase="正式";proj.groups[0].name="研发";snap();selId="missing";selIds=new Set(["missing","source"]);filterGrp="研发";filterPhase="正式";filterQ="source";undo()');
 assert.deepEqual(f.json('({primary:selId,selected:[...selIds],group:filterGrp,phase:filterPhase,query:filterQ})'),{primary:null,selected:[],group:null,phase:null,query:'source'});
 f.run('filterGrp="策划";filterPhase="原型";applyHist()');assert.deepEqual(f.json('({group:filterGrp,phase:filterPhase})'),{group:'策划',phase:'原型'});
});
test('settings refresh after undo, snapshots stay immutable and history retains 50 steps',()=>{
 const f=fixture();f.load(project());const first=f.run('hist[0]');f.run('snap()');assert.equal(f.run('hist.length'),1);
 f.document.querySelector('#set-ovl').hidden=false;f.run('proj.meta.hiddenRoles.push("美术");snap();undo()');assert.equal(f.run('settingsRenders'),1);assert.equal(f.run('hist[0]'),first);
 f.run('proj.meta.hiddenRoles.push("动画")');assert.deepEqual(JSON.parse(f.run('hist[1]')).meta.hiddenRoles,['美术']);
 f.run('for(let i=0;i<60;i++){proj.meta.cols.person=80+i;snap()}');assert.equal(f.run('hist.length'),50);assert.equal(f.run('histI'),49);
});
test('import resets old selection and filters, with complete metadata undo/redo',()=>{
 const f=fixture(),before=project();f.load(before);
 f.run('selId="source";selIds=new Set(["source"]);filterGrp="策划";filterPhase="原型";filterQ="obsolete"');f.document.querySelector('#tb-search').value='obsolete';
 vm.runInContext('function applyProject(d){proj=d;document.documentElement.style.setProperty("--left-w",(d.meta.lw||440)+"px");applyColWidths();return true}',f.c);
 const line=source.split('\n').find(l=>l.includes("$('#import-file').addEventListener('change'"));assert.ok(line);vm.runInContext(line,f.c);
 const imported=project([task('new')]);imported.meta.lw=600;imported.meta.roleColors={策划:'#ffee00'};
 const input=f.document.querySelector('#import-file');input.files=[{text:JSON.stringify(imported)}];f.events.get('#import-file:change').call(input);
 assert.deepEqual(f.json('({primary:selId,selected:[...selIds],query:filterQ,group:filterGrp,phase:filterPhase})'),{primary:null,selected:[],query:'',group:null,phase:null});assert.equal(f.document.querySelector('#tb-search').value,'');
 f.run('undo()');assert.deepEqual(f.json('proj'),before);assert.equal(f.styles.get('--left-w'),'440px');
 f.run('redo()');assert.deepEqual(f.json('proj'),imported);
});
