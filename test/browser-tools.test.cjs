'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const {createBridge,definitions}=require('../frontend/scripts/browser-tools.js');

function recorder(){
  const calls=[];
  const api=createBridge({beforeCall:async(def,args)=>calls.push(['before',def.name,args]),execute:async(name,args)=>{calls.push(['execute',name,args]);return {name,args};}});
  return {api,calls};
}

test('catalog has unique names, closed schemas and explicit browser scope; snapshots cannot mutate catalog',async()=>{
  const {api}=recorder(),list=api.list();
  assert.ok(list.length>=40);
  assert.equal(new Set(list.map(t=>t.name)).size,list.length);
  for(const tool of list){
    assert.equal(tool.scope,'current-browser');
    assert.equal(tool.inputSchema.additionalProperties,false);
    assert.equal(typeof tool.annotations.readOnlyHint,'boolean');
    assert.equal(typeof tool.annotations.destructiveHint,'boolean');
  }
  list.find(t=>t.name==='browser.zoom.set').inputSchema.properties.zoom.enum.push('arbitrary');
  assert.equal((await api.call('browser.zoom.set',{zoom:'arbitrary'})).error.code,'INVALID_ARGUMENTS');
  assert.ok(api.list().find(t=>t.name==='browser.history.undo').annotations.destructiveHint);
  assert.ok(api.list().find(t=>t.name==='browser.state').annotations.readOnlyHint);
});

test('unknown tools, unknown fields, missing values, invalid primitives, repeated IDs and oversized inputs never dispatch',async()=>{
  const {api,calls}=recorder();
  const cases=[
    ['browser.nope',{},'UNKNOWN_TOOL'],
    ['browser.state',{session:true},'INVALID_ARGUMENTS'],
    ['browser.columns.width',{columnId:'name'},'INVALID_ARGUMENTS'],
    ['browser.columns.width',{columnId:'name',width:Infinity},'INVALID_ARGUMENTS'],
    ['browser.columns.width',{columnId:'name',width:0},'INVALID_ARGUMENTS'],
    ['browser.columns.width',{columnId:'name',width:'200'},'INVALID_ARGUMENTS'],
    ['browser.selection.set',{taskIds:['a','a']},'INVALID_ARGUMENTS'],
    ['browser.selection.set',{taskIds:Array.from({length:10001},(_,i)=>String(i))},'INVALID_ARGUMENTS'],
    ['browser.filters.set',{},'INVALID_ARGUMENTS'],
    ['browser.search.set',{query:'x'.repeat(513)},'INVALID_ARGUMENTS'],
    ['browser.state',null,'INVALID_ARGUMENTS'],
    ['browser.state',[],'INVALID_ARGUMENTS'],
    ['browser.shared.load_latest',{discardDraft:false},'INVALID_ARGUMENTS']
  ];
  for(const [name,args,code]of cases)assert.equal((await api.call(name,args)).error.code,code,name);
  assert.equal(calls.length,0);
});

test('prototype keys, custom prototypes, accessors, symbols and sparse arrays are rejected without evaluating accessors',async()=>{
  const {api,calls}=recorder();
  let evaluated=false;
  const getter={};Object.defineProperty(getter,'query',{enumerable:true,get(){evaluated=true;return 'bad';}});
  const symbol={query:'hello',[Symbol('private')]:true};
  const sparse=[];sparse.length=1;
  const cases=[
    ['browser.state',JSON.parse('{"__proto__":{"polluted":true}}')],
    ['browser.state',JSON.parse('{"constructor":{}}')],
    ['browser.search.set',Object.assign(Object.create({inherited:true}),{query:'hello'})],
    ['browser.search.set',getter],
    ['browser.search.set',symbol],
    ['browser.selection.set',{taskIds:sparse}]
  ];
  for(const [name,args]of cases)assert.equal((await api.call(name,args)).error.code,'INVALID_ARGUMENTS');
  assert.equal(evaluated,false);assert.equal(calls.length,0);assert.equal({}.polluted,undefined);
});

test('input is cloned before asynchronous dispatch and concurrent actions return BUSY',async()=>{
  let release;
  const wait=new Promise(resolve=>{release=resolve;});
  const api=createBridge({beforeCall:()=>wait,execute:(name,args)=>args});
  const args={query:'original'},pending=api.call('browser.search.set',args);
  args.query='modified';
  assert.equal((await api.call('browser.state')).error.code,'BUSY');
  release();assert.deepEqual(await pending,{ok:true,data:{query:'original'}});
  assert.equal((await api.call('browser.state')).ok,true);
});

test('unexpected implementation errors are redacted and release the call lock',async()=>{
  let fail=true;
  const api=createBridge({beforeCall:()=>{},execute:()=>{if(fail){fail=false;throw new Error('secret-token-must-not-escape');}return true;}});
  const result=await api.call('browser.state');
  assert.equal(result.error.code,'BROWSER_TOOL_FAILED');
  assert.doesNotMatch(JSON.stringify(result),/secret-token/);
  assert.deepEqual(await api.call('browser.state'),{ok:true,data:true});
});

function browserHarness({editor=true,shared=true,loaded=true}={}){
  const nodes=new Map(),calls=[];
  const makeNode=selector=>{
    const classes=new Set();
    const node={hidden:selector.endsWith('-ovl')||selector==='#ovl',value:'',scrollLeft:0,scrollTop:0,offsetTop:0,clientWidth:800,
      classList:{toggle(name,on){if(on)classes.add(name);else classes.delete(name);},contains:name=>classes.has(name)},
      getBoundingClientRect:()=>({width:400}),setAttribute:(name,value)=>{node[name]=value;},
      querySelectorAll:()=>[],focus:()=>{},click:()=>{node.clicked=true;}};
    return node;
  };
  const $=selector=>{if(!nodes.has(selector))nodes.set(selector,makeNode(selector));return nodes.get(selector);};
  const project={tasks:[
    {id:'parent',pid:null,name:'Parent',type:'task',s:'2026-10-01',e:'2026-10-05',who:'Alice',grp:'Art',phase:'Plan',fold:false},
    {id:'child',pid:'parent',name:'Child',type:'task',s:'2026-10-01',e:'2026-10-05',who:'Bob',grp:'Art',phase:'Plan'},
    {id:'other',pid:null,name:'Other',type:'task',s:'2026-10-02',e:'2026-10-03',who:'Alice',grp:'Dev',phase:'Build'}
  ],groups:[{name:'Art',color:'#ff0000'},{name:'Dev',color:'#0000ff'}],flags:[{id:'flag',name:'Ship',d:'2026-10-05'}],meta:{cols:{name:248,person:88},columnOrder:['name','person'],hiddenColumns:[]}};
  const cloudState={enabled:shared,mode:'workbuddy',screen:'ready',role:editor?'editor':'viewer',canEdit:editor,projectId:'a'.repeat(32),revision:5,
    dirty:false,saveStatus:'saved',shareURL:'https://example.test/p/'+ 'a'.repeat(32),token:'secret-token',apiKey:'secret-key',session:{token:'secret-session'}};
  const environment={
    console,Set,Map,JSON,Date,Promise,Number,Array,Object,Math,RegExp,Error,globalThis:null,
    proj:loaded?project:null,zoom:'week',selId:null,selIds:new Set(),filterQ:'',filterGrp:null,filterPhase:null,expandedLanes:new Set(),
    hist:['one','two','three'],histI:1,dragging:false,bds:{mn:20727,mx:20757},vMn:20727,vMx:20757,axis:{dw:22},ZOOM:{day:{dw:72},week:{dw:22},month:{dw:6}},
    $,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},
    WorkspaceShell:{view:'gantt',setView(value){this.view=value;calls.push(['view',value]);}},
    SharedWorkspace:{
      enabled:shared,state:()=>cloudState,requireEdit:()=>editor,
      pollNow:async()=>{calls.push(['poll']);return true;},loadLatest:async()=>{calls.push(['loadLatest']);cloudState.dirty=false;},
      exportDraft:()=>{calls.push(['exportDraft']);},copyLink:async()=>{calls.push(['copyLink']);},logout:async()=>{calls.push(['logout']);}
    },
    mayEditProject:()=>editor,
    byId:id=>project.tasks.find(item=>item.id===id),
    isSum:item=>project.tasks.some(task=>task.pid===item.id),
    phaseList:()=>['Plan','Build'],
    vRows:()=>project.tasks.filter(item=>!project.tasks.find(p=>p.id===item.pid)?.fold).map(t=>({t})),
    colW:()=>({...project.meta.cols}),
    allTableColumns:()=>project.meta.columnOrder.map(id=>({id,name:id,type:'text',builtin:true,min:60,max:1000})),
    visibleTableColumns:()=>environment.allTableColumns().filter(item=>!project.meta.hiddenColumns.includes(item.id)),
    paneBounds:()=>({width:1600,min:280,max:1200,defaultWidth:400}),
    render:()=>calls.push(['render']),schSave:()=>calls.push(['save']),paintSelection:()=>calls.push(['selection']),
    selStep:(direction,extend)=>calls.push(['step',direction,extend]),
    canvasFactor:1,
    canvasScaleFactor:()=>environment.canvasFactor,
    zoomTimeline:value=>{environment.zoom=value;environment.axis.dw=environment.ZOOM[value].dw;environment.canvasFactor=1;calls.push(['zoom',value]);},
    setTimelineScale:(value,options)=>{environment.canvasFactor=value/environment.axis.dw;calls.push(['scale',value,options]);},
    setCanvasScale:(value,options)=>{environment.canvasFactor=value;calls.push(['canvasScale',value,options]);},
    timelineScaleState:()=>({pxPerDay:environment.axis.dw*environment.canvasFactor,factor:environment.canvasFactor,min:0.35,max:3,custom:environment.canvasFactor!==1,preset:environment.zoom}),
    fD:day=>new Date(day*86400000).toISOString().slice(0,10),
    tD:date=>Date.parse(date)/86400000,
    eRange:t=>({s:Date.parse(t.s)/86400000,e:Date.parse(t.e)/86400000}),
    sel:id=>{environment.selId=id;environment.selIds=new Set([id]);},clearLaneTimer:()=>{},
    closeLane:id=>environment.expandedLanes.delete(id),ensureFill:()=>{},
    goToday:()=>calls.push(['today']),syncLeftColumns:()=>{},schDepDraw:()=>{},
    fieldsSetVisible:(id,visible)=>{project.meta.hiddenColumns=visible?project.meta.hiddenColumns.filter(key=>key!==id):[...project.meta.hiddenColumns,id];calls.push(['visibility',id,visible]);},
    fieldsMove:(id,direction)=>{calls.push(['move',id,direction]);return false;},
    setColumnWidth:(id,width)=>{project.meta.cols[id]=Math.max(60,Math.min(1000,width));calls.push(['width',id,width]);return true;},
    fitColumnToContent:id=>{calls.push(['fit',id]);return true;},resetColumnWidths:()=>{calls.push(['resetColumns']);return true;},
    setPaneWidth:width=>{calls.push(['pane',width]);return true;},resetPaneLayout:()=>{calls.push(['resetPane']);return true;},
    applyPaneLayout:()=>{},applyColWidths:()=>{},
    undo:()=>{calls.push(['undo']);if(environment.histI>0)environment.histI--;},
    redo:()=>{calls.push(['redo']);if(environment.histI<environment.hist.length-1)environment.histI++;},
    ScheduleProjectValidation:{validateProject:value=>JSON.parse(JSON.stringify(value))},
    expJSON:()=>calls.push(['exportJSON']),capPNG:()=>calls.push(['exportPNG']),
    openOvl:node=>{node.hidden=false;},
    edOpen:id=>{calls.push(['editor',id]);$('#ovl').hidden=false;},
    flagOpen:id=>{calls.push(['flag',id]);$('#flag-ovl').hidden=false;},flags:()=>project.flags,
    fieldsOpen:()=>{$('#fields-ovl').hidden=false;},setOpen:()=>{$('#set-ovl').hidden=false;},
    edClose:()=>{$('#ovl').hidden=true;},flagClose:()=>{$('#flag-ovl').hidden=true;},fieldsClose:()=>{$('#fields-ovl').hidden=true;},
    setClose:()=>{$('#set-ovl').hidden=true;},helpClose:()=>{$('#help-ovl').hidden=true;},
    flushPendingSave:async()=>{calls.push(['flush']);return {ok:true};}
  };
  const window={dispatchEvent:event=>calls.push(['event',event.type]),SharedWorkspaceUI:{
    openAi:()=>{$('#shared-ai-ovl').hidden=false;},closeAi:()=>{$('#shared-ai-ovl').hidden=true;},
    openPresence:()=>{$('#shared-presence-ovl').hidden=false;},closePresence:()=>{$('#shared-presence-ovl').hidden=true;}
  },ScheduleHighlights:{
    listOwners:()=>['Alice','Bob'],setOwner:owner=>({owner}),trace:id=>({id,taskIds:[id],edges:[]}),
    setHovered:hovered=>({hovered}),clear:()=>({owner:null,hovered:null})
  }};
  environment.window=window;environment.globalThis=window;
  const context=vm.createContext(environment);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../frontend/scripts/browser-tools.js'),'utf8'),context);
  const call=async(name,args)=>JSON.parse(JSON.stringify(await window.ScheduleBrowserTools.call('browser.'+name,args)));
  return {call,environment,project,cloudState,calls,nodes,$,api:window.ScheduleBrowserTools};
}

test('actual browser bridge returns allowlisted state without credentials or storage',async()=>{
  const {call}=browserHarness();
  const response=await call('state');
  assert.equal(response.ok,true);assert.equal(response.data.collaboration.revision,5);
  assert.doesNotMatch(JSON.stringify(response),/secret|token|apiKey|session/);
  assert.equal(response.data.view,'gantt');
});

test('viewer can change personal layout, filters, selection and folding using existing UI hooks',async()=>{
  const h=browserHarness({editor:false});
  assert.equal((await h.call('view.set',{view:'table'})).ok,true);
  assert.equal((await h.call('zoom.set',{zoom:'month'})).data.zoom,'month');
  assert.equal((await h.call('filters.set',{role:'Art',phase:'Plan',query:'Bob'})).ok,true);
  assert.equal(h.environment.filterQ,'Bob');assert.equal(h.environment.filterGrp,'Art');
  assert.equal((await h.call('selection.set',{taskIds:['parent','child'],primaryId:'parent'})).ok,true);
  assert.equal(h.environment.selId,'parent');
  assert.equal((await h.call('rows.fold',{taskIds:['parent'],collapsed:true})).ok,true);
  assert.equal(h.project.tasks[0].fold,true);
  assert.equal((await h.call('columns.width',{columnId:'name',width:1700})).data.columns[0].width,1000);
  assert.ok(h.calls.some(item=>item[0]==='save'));
});

test('viewer cannot undo, redo, save or open mutation dialogs; no mutation handlers run',async()=>{
  const h=browserHarness({editor:false});
  for(const name of ['history.undo','history.redo','shared.save'])assert.equal((await h.call(name)).error.code,'EDIT_REQUIRED');
  assert.equal((await h.call('dialog.open',{dialog:'task',taskId:'child'})).error.code,'EDIT_REQUIRED');
  assert.equal((await h.call('dialog.open',{dialog:'flag',flagId:'flag'})).error.code,'EDIT_REQUIRED');
  assert.equal((await h.call('dialog.open',{dialog:'ai'})).error.code,'EDIT_REQUIRED');
  assert.equal(h.calls.length,0);
});

test('history tools retain existing undo/redo and saving flow; save reports actual queue result',async()=>{
  const h=browserHarness();
  assert.equal((await h.call('history.undo')).data.changed,true);
  assert.equal((await h.call('history.redo')).data.changed,true);
  assert.equal((await h.call('shared.save')).data.saved,true);
  assert.deepEqual(h.calls.filter(item=>['undo','redo','flush'].includes(item[0])),[['undo'],['redo'],['flush']]);
  h.environment.flushPendingSave=async()=>({ok:false,error:'conflict'});
  const result=await h.call('shared.save');
  assert.equal(result.data.saved,false);assert.equal(result.data.message,'conflict');
});

test('selection validates all IDs and primary before making any state change',async()=>{
  const h=browserHarness();
  assert.equal((await h.call('selection.set',{taskIds:['parent','missing']})).error.code,'NOT_FOUND');
  assert.equal((await h.call('selection.set',{taskIds:['parent'],primaryId:'child'})).error.code,'INVALID_ARGUMENTS');
  assert.equal(h.environment.selIds.size,0);assert.equal(h.calls.length,0);
});

test('invalid filters are atomic; empty search and null role/phase clear successfully',async()=>{
  const h=browserHarness();
  assert.equal((await h.call('filters.set',{query:'Bob',role:'missing'})).error.code,'NOT_FOUND');
  assert.equal(h.environment.filterQ,'');
  await h.call('filters.set',{query:'Alice',role:'Art',phase:'Plan'});
  const result=await h.call('filters.clear');
  assert.deepEqual(result.data.filters,{query:'',role:null,phase:null});
});

test('column ordering enforces complete IDs and a pinned first name column',async()=>{
  const h=browserHarness();
  assert.equal((await h.call('columns.order',{columnIds:['person','name']})).error.code,'INVALID_ARGUMENTS');
  assert.equal((await h.call('columns.order',{columnIds:['name']})).error.code,'INVALID_ARGUMENTS');
  assert.equal((await h.call('columns.order',{columnIds:['name','missing']})).error.code,'INVALID_ARGUMENTS');
  assert.equal((await h.call('columns.visibility',{columnId:'name',visible:false})).error.code,'INVALID_ARGUMENTS');
  await h.call('columns.visibility',{columnId:'person',visible:false});
  assert.equal((await h.call('columns.fit',{columnId:'person'})).error.code,'INVALID_ARGUMENTS');
  assert.deepEqual(h.project.meta.columnOrder,['name','person']);
});

test('open dialogs protect pending inputs, close uses the real form close callback',async()=>{
  const h=browserHarness();
  assert.equal((await h.call('dialog.open',{dialog:'task',taskId:'child'})).data.open,true);
  assert.equal((await h.call('view.set',{view:'table'})).error.code,'DIALOG_OPEN');
  assert.equal((await h.call('dialog.open',{dialog:'task',taskId:'parent'})).error.code,'DIALOG_OPEN');
  assert.equal((await h.call('dialog.open',{dialog:'fields'})).error.code,'DIALOG_OPEN');
  assert.equal((await h.call('dialog.close',{dialog:'task'})).data.open,false);
  assert.equal((await h.call('view.set',{view:'table'})).ok,true);
});

test('AI and presence panel tools do not return their DOM contents or credentials',async()=>{
  const h=browserHarness();
  h.$('#shared-ai-key').value='secret-visible-once';
  assert.equal((await h.call('dialog.open',{dialog:'ai'})).data.open,true);
  assert.doesNotMatch(JSON.stringify(await h.call('state')),/secret/);
  assert.equal((await h.call('dialog.close',{dialog:'ai'})).data.open,false);
  assert.equal((await h.call('dialog.open',{dialog:'presence'})).data.open,true);
});

test('JSON export returns an isolated importable object; PNG reports request without inventing success or URLs',async()=>{
  const h=browserHarness({editor:false});
  const result=await h.call('export.json',{download:true});
  assert.equal(result.data.project.tasks.length,3);assert.equal(result.data.downloadStatus,'requested');
  result.data.project.tasks[0].name='changed';
  assert.equal(h.project.tasks[0].name,'Parent');
  const png=await h.call('export.png');
  assert.equal(png.data.status,'export_requested');assert.equal(png.data.url,undefined);
  assert.ok(h.calls.some(item=>item[0]==='exportPNG'));
});

test('invalid dates are rejected, actual date navigation expands calendar and positions it',async()=>{
  const h=browserHarness();
  assert.equal((await h.call('timeline.date',{date:'2026-02-30'})).error.code,'INVALID_ARGUMENTS');
  assert.equal((await h.call('timeline.date',{date:'2026-11-01'})).ok,true);
  assert.ok(h.$('#g-right').scrollLeft>=0);
});

test('continuous scale uses public anchored-zoom API and preset resets the custom scale',async()=>{
  const h=browserHarness({editor:false});
  assert.equal((await h.call('timeline.scale',{pxPerDay:0})).error.code,'INVALID_ARGUMENTS');
  assert.equal((await h.call('timeline.scale',{pxPerDay:201})).error.code,'INVALID_ARGUMENTS');
  const scaled=await h.call('timeline.scale',{pxPerDay:37.5,anchorX:160});
  assert.equal(scaled.data.timeline.scale.pxPerDay,37.5);assert.equal(scaled.data.timeline.scale.custom,true);
  assert.equal(h.calls.find(item=>item[0]==='scale')[2].anchorX,160);
  const reset=await h.call('zoom.set',{zoom:'week'});
  assert.equal(reset.data.timeline.scale.pxPerDay,22);assert.equal(reset.data.timeline.scale.custom,false);
});

test('canvas scale is viewer-safe, preserves logical day width and never saves content',async()=>{
  const h=browserHarness({editor:false});
  assert.equal((await h.call('canvas.scale',{factor:0.34})).error.code,'INVALID_ARGUMENTS');
  assert.equal((await h.call('canvas.scale',{factor:3.01})).error.code,'INVALID_ARGUMENTS');
  const scaled=await h.call('canvas.scale',{factor:2,clientX:900,clientY:450});
  assert.equal(scaled.ok,true);assert.equal(scaled.data.timeline.scale.factor,2);
  assert.equal(scaled.data.timeline.scale.pxPerDay,44);assert.equal(h.environment.axis.dw,22);
  assert.equal(scaled.data.pane.width,200);
  const invoked=h.calls.find(item=>item[0]==='canvasScale');
  assert.deepEqual(JSON.parse(JSON.stringify(invoked)),['canvasScale',2,{clientX:900,clientY:450}]);
  assert.equal(h.calls.some(item=>item[0]==='save'),false);
  const reset=await h.call('zoom.set',{zoom:'week'});
  assert.equal(reset.data.timeline.scale.factor,1);
});

test('timeline/table scroll synchronize vertical positions and reveal expands ancestors without changing flow mode',async()=>{
  const h=browserHarness();
  const result=await h.call('viewport.scroll',{pane:'table',x:100,y:200});
  assert.deepEqual(result.data,{pane:'table',x:100,y:200});assert.equal(h.$('#g-right').scrollTop,200);
  h.project.tasks[0].fold=true;h.project.tasks[0].flow=true;
  assert.equal((await h.call('task.reveal',{taskId:'child'})).ok,true);
  assert.equal(h.project.tasks[0].fold,false);assert.equal(h.project.tasks[0].flow,true);assert.equal(h.environment.selId,'child');
});

test('shared load latest requires explicit discard; local page cannot run cloud commands',async()=>{
  const h=browserHarness();
  assert.equal((await h.call('shared.load_latest')).error.code,'INVALID_ARGUMENTS');
  assert.equal((await h.call('shared.load_latest',{discardDraft:true})).ok,true);
  assert.ok(h.calls.some(item=>item[0]==='loadLatest'));
  const local=browserHarness({shared:false});
  assert.equal((await local.call('shared.refresh')).error.code,'NOT_SHARED');
});

test('dragging or unloaded pages reject actions; state remains inspectable',async()=>{
  const h=browserHarness();h.environment.dragging=true;
  assert.equal((await h.call('view.set',{view:'table'})).error.code,'BUSY');
  assert.equal((await h.call('state')).ok,true);
  h.environment.dragging=false;h.environment.sbDrag=true;
  assert.equal((await h.call('canvas.scale',{factor:2})).error.code,'BUSY');
  assert.equal((await h.call('state')).ok,true);
  const empty=browserHarness({loaded:false});
  assert.equal((await empty.call('state')).data.loaded,false);
  assert.equal((await empty.call('view.set',{view:'table'})).error.code,'NOT_READY');
});

test('highlight tools use public highlighting API and reject unknown targets',async()=>{
  const h=browserHarness({editor:false});
  assert.deepEqual((await h.call('highlights.owners')).data.owners,['Alice','Bob']);
  assert.deepEqual((await h.call('highlights.owner',{owner:'Alice'})).data,{owner:'Alice'});
  assert.deepEqual((await h.call('highlights.owner',{owner:'  Alice  '})).data,{owner:'Alice'});
  assert.deepEqual((await h.call('highlights.owner',{owner:'  '})).data,{owner:null});
  assert.deepEqual((await h.call('highlights.owner',{owner:''})).data,{owner:null});
  assert.equal((await h.call('highlights.owner',{owner:'missing'})).error.code,'NOT_FOUND');
  assert.equal((await h.call('highlights.trace',{taskId:'missing'})).error.code,'NOT_FOUND');
  assert.equal((await h.call('highlights.trace',{taskId:'child'})).data.id,'child');
  assert.deepEqual((await h.call('highlights.clear')).data,{owner:null,hovered:null});
});
