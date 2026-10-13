const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function harness(){
  // Exercise the current build, never a machine-local historical repair patch.
  const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../frontend/manifest.json'),'utf8'));
  const source=manifest.scripts.map(file=>fs.readFileSync(path.join(__dirname,'../frontend',file),'utf8')).join('\n');
  const cut=(a,b)=>{
    const start=source.indexOf(a),end=source.indexOf(b,start);
    if(start<0||end<0)throw Error('Missing source boundary: '+a);
    return source.slice(start,end);
  };
  const timers=new Map(),arrows=[],arrowFills=[],criticalChecks=[];
  let timerId=0;
  const context={
    console,
    ScheduleBarGeometry:require('../frontend/scripts/bar-geometry.js'),
    canvasScaleFactor:()=>1,
    window:{},
    setTimeout(fn){const id=++timerId;timers.set(id,fn);return id},
    clearTimeout(id){timers.delete(id)},
    criticalChecks,
    canvas:{style:{},getContext(){let currentPath=[];return{
      setTransform(){},beginPath(){currentPath=[]},setLineDash(){},
      moveTo(...args){currentPath.push(['moveTo',...args])},lineTo(...args){currentPath.push(['lineTo',...args])},
      bezierCurveTo(...args){currentPath.push(['bezierCurveTo',...args])},closePath(){currentPath.push(['closePath'])},
      fill(){arrowFills.push(currentPath.map(command=>[...command]))},
      stroke(){arrows.push(currentPath.map(command=>[...command]))},
    }}},
  };
  vm.createContext(context);
  const prelude=`
    let proj,filterQ='',filterGrp=null,filterPhase=null,selIds=new Set(),crit=new Set(),cf=new Set(),dragging=false;
    let axis={dw:22,tw:1000},bds={mn:0},bPos={},rowYs=[],rowsHTotal=0,depRows=null,depH=0,depPixelScale=0,depPreview=null,renderCount=0;
    const RH=40,SUBP=26,tD=s=>Number(s),textW=(s,size)=>s.length*size;
    const $=()=>({clientWidth:800,scrollLeft:0});
    const bindTip=()=>{},nodeIconSvg=()=>'',barTextCol=()=> '#fff',render=()=>{renderCount++};
    const isCriticalDep=(from,to)=>{criticalChecks.push([from,to]);return false};
    const ce=(tag,cls,text)=>({tag,className:cls||'',textContent:text,style:{},dataset:{},children:[],listeners:{},
      classList:{add(){},remove(){}},appendChild(e){this.children.push(e)},addEventListener(kind,fn){this.listeners[kind]=fn}});
    const mk=(id,pid,s,e,extra={})=>({id,pid,name:id,type:'task',s:String(s),e:String(e),deps:[],grp:'A',...extra});
    function setup(tasks){proj={tasks,groups:[{name:'A',color:'#112233'},{name:'B',color:'#556677'}]};bPos={};expandedLanes.clear();filterQ='';filterGrp=null;filterPhase=null}
    function paint(){const layer=ce('div');laneItems(layer,proj.tasks[0],0);return layer}
  `;
  const code=prelude+cut('// Data helpers','// Analysis')+
    cut('const expandedLanes=','function render(){')+
    cut('function laneItems(','// hex → rgba')+
    cut('function rBar(ly,t,y,sum,claims,barTop)','/* 标签自适应布局')+
    cut('function claimsFree(','/* 管线：')+
    cut('function drawDeps(','/* Ctrl-drag dep */');
  vm.runInContext(code,context);
  const run=code=>vm.runInContext(code,context);
  const value=code=>JSON.parse(JSON.stringify(run(code)));
  return{run,value,timers,arrows,arrowFills,criticalChecks};
}

test('middle-button pan suppresses nested lane hover renders including already pending close timers',()=>{
  const h=harness();
  h.run("setup([mk('P',null,0,5,{flow:true}),mk('B','P',0,5),mk('C','B',0,5)]);let layer=paint();const parentBar=layer.children.find(e=>e.dataset.id==='B');sbDrag=true;parentBar.listeners.mouseenter();parentBar.listeners.mouseleave()");
  assert.equal(h.run('renderCount'),0);
  assert.equal(h.run('expandedLanes.size'),0);
  assert.equal(h.timers.size,0);
  h.run("sbDrag=false;parentBar.listeners.mouseenter();parentBar.listeners.mouseleave();sbDrag=true");
  assert.equal(h.run('renderCount'),1);
  for(const fn of h.timers.values())fn();
  assert.equal(h.run('renderCount'),1);
  assert.equal(h.run("expandedLanes.has('B')"),true);
});


test('flow uses inclusive day intervals and reuses lanes after the end date',()=>{
  const h=harness();h.run("setup([mk('P',null,0,5,{flow:true}),mk('A','P',0,2),mk('B','P',2,3),mk('C','P',3,5)])");
  assert.deepEqual(h.value("[laneAssign(proj.tasks[0]).depth,...['A','B','C'].map(id=>laneAssign(proj.tasks[0]).map.get(id))]"),[2,0,1,0]);
});

test('group and phase filters apply to flow children while retaining matching ancestors',()=>{
  const h=harness();h.run("setup([mk('P',null,0,5,{flow:true,grp:'B'}),mk('A','P',0,2,{phase:'one'}),mk('B','P',3,5,{grp:'B',phase:'two'})]);filterGrp='A';paint()");
  assert.deepEqual(h.value('vRows().map(r=>r.t.id)'),['P']);
  assert.deepEqual(h.value('Object.keys(bPos)'),['A']);
  h.run("filterGrp=null;filterPhase='two';bPos={};paint()");
  assert.deepEqual(h.value('Object.keys(bPos)'),['B']);
});

test('matching a parent by name keeps its descendants as in the tree view',()=>{
  const h=harness();h.run("setup([mk('P',null,0,5,{flow:true,name:'Feature'}),mk('A','P',0,2),mk('B','P',3,5)]);filterQ='feature';paint()");
  assert.deepEqual(h.value('Object.keys(bPos)'),['A','B']);
});

test('closed subgroups have no hidden descendant coordinates or DOM',()=>{
  const h=harness();h.run("setup([mk('P',null,0,5,{flow:true}),mk('A','P',0,5),mk('B','P',0,5),mk('B1','B',0,5)]);paint()");
  assert.deepEqual(h.value('Object.keys(bPos)'),['A','B']);
  assert.equal(h.run('bPos.B.summary'),true);
  assert.equal(h.run('bPos.B.expanded'),false);
});

test('expanded subgroup follows its own lane and grows the parent and next-row offset',()=>{
  const h=harness();h.run("setup([mk('P',null,0,5,{flow:true}),mk('A','P',0,5),mk('B','P',0,5),mk('B1','B',0,5),mk('B2','B',0,5),mk('B3','B',0,5),mk('N',null,0,5)]);expandedLanes.add('B');paint();computeRowYs(vRows())");
  assert.deepEqual(h.value('[bPos.B.y,bPos.B1.y,bPos.B2.y,bPos.B3.y]'),[35,35,61,87]);
  assert.equal(h.run('rowHOf(proj.tasks[0])'),118);
  assert.equal(h.run('rowYs[1]'),118);
  assert.ok(h.run('bPos.B3.y+bPos.B3.h<rowYs[1]'));
  h.run("closeLane('B');bPos={};paint();computeRowYs(vRows())");
  assert.equal(h.run('rowYs[1]'),66);
  assert.equal(h.run("'B1' in bPos"),false);
});

test('opening a reusable upper lane keeps the hovered parent in place and shifts lower lanes',()=>{
  const h=harness();h.run("setup([mk('P',null,0,5,{flow:true}),mk('A','P',0,1),mk('D','P',0,5),mk('C','P',2,5),mk('C1','C',2,5),mk('C2','C',2,5)]);paint()");
  const before=h.run('bPos.C.y');assert.equal(before,9);
  h.run("expandedLanes.add('C');bPos={};paint()");
  assert.equal(h.run('bPos.C.y'),before);
  assert.equal(h.run('bPos.D.y'),61);
  assert.equal(h.run('rowHOf(proj.tasks[0])'),92);
});

test('recursive subgroup expansion reserves all descendant rows',()=>{
  const h=harness();h.run("setup([mk('P',null,0,5,{flow:true}),mk('A','P',0,5),mk('B','P',0,5),mk('C','B',0,5),mk('D','B',0,5),mk('C1','C',0,5),mk('C2','C',0,5)]);expandedLanes.add('B');expandedLanes.add('C');paint()");
  assert.deepEqual(h.value('[bPos.B.y,bPos.C.y,bPos.C1.y,bPos.C2.y,bPos.D.y]'),[35,35,35,61,87]);
  assert.equal(h.run('rowHOf(proj.tasks[0])'),118);
});

test('a node label yields to a later task while retaining the node and tooltip target',()=>{
  const h=harness();h.run("setup([mk('P',null,1,5,{flow:true}),mk('N','P',1,1,{type:'milestone',name:'LONG NODE NAME'}),mk('T','P',2,5)]);const crowded=paint()");
  assert.equal(h.run("crowded.children.some(e=>e.className==='pin-label')"),false);
  assert.equal(h.run('bPos.N.label'),null);
  assert.equal(h.run('bPos.N.type'),'ms');
  h.run("setup([mk('P',null,0,5,{flow:true}),mk('N','P',0,0,{type:'milestone',name:'N'}),mk('T','P',5,5)]);paint()");
  assert.deepEqual(h.value('bPos.N.label'),{x:23,y:13,text:'N',fontSize:10,height:14});
});

test('nested node labels share claims with later siblings outside their subgroup',()=>{
  const h=harness();h.run("setup([mk('P',null,1,5,{flow:true}),mk('B','P',1,1),mk('N','B',1,1,{type:'milestone',name:'LONG NODE NAME'}),mk('T','P',2,5)]);expandedLanes.add('B');paint()");
  assert.equal(h.run('bPos.N.label'),null);
});

test('explicit dependencies between visible flow children are drawn and use edge criticality',()=>{
  const h=harness();h.run("setup([mk('P',null,0,5,{flow:true}),mk('A','P',0,2),mk('B','P',3,5,{deps:['A']})]);paint();drawDeps(canvas,vRows(),100)");
  assert.equal(h.arrowFills.length,0,'same-row touching tasks have no arrow');
  const route=h.value('ScheduleBarGeometry.connector(bPos.A,bPos.B)');
  assert.equal(route.kind,'adjacent-inline');
  assert.equal(route.arrow,null);
  assert.deepEqual(h.arrows,[route.commands],'same-row touching tasks draw their short connecting line');
  assert.deepEqual(JSON.parse(JSON.stringify(h.criticalChecks)),[['A','B']]);
});

test('screen rendering preserves the curved cross-row arrow for near and distant targets above or below',()=>{
  for(const dy of [-400,-40,40,400]){
    const h=harness(),sourceY=dy<0?20-dy:20,targetY=sourceY+dy;
    h.run("setup([mk('P',null,0,5,{flow:true}),mk('A','P',0,2),mk('B','P',3,5,{deps:['A']})]);paint();bPos.A.cy="+sourceY+";bPos.B.cy="+targetY+";drawDeps(canvas,vRows(),500)");
    const route=h.value('ScheduleBarGeometry.connector(bPos.A,bPos.B)');
    assert.equal(route.kind,'standard');
    assert.deepEqual(h.arrows,[route.commands],'screen strokes the shared route exactly');
    assert.deepEqual(h.arrowFills,[[...route.arrow.map(([x,y],index)=>[index?'lineTo':'moveTo',x,y]),['closePath']]],'screen fills the shared directional arrow exactly');
  }
});


test('dependencies exclude filtered or closed subgroup descendants',()=>{
  const h=harness();h.run("setup([mk('P',null,0,5,{flow:true}),mk('A','P',0,2,{grp:'B'}),mk('B','P',3,5,{deps:['A']}),mk('C','P',3,5),mk('C1','C',3,5,{deps:['B']})]);filterGrp='A';paint();drawDeps(canvas,vRows(),100)");
  assert.equal(h.arrows.length,0);
  assert.equal(h.arrowFills.length,0);
  assert.equal(h.run("'C1' in bPos"),false);
});

test('shared close timers cancel on hover reentry and parent closure clears descendants',()=>{
  const h=harness();h.run("setup([mk('P',null,0,5,{flow:true}),mk('B','P',0,5),mk('C','B',0,5),mk('D','C',0,5)]);let layer=paint();const parentBar=layer.children.find(e=>e.dataset.id==='B');parentBar.listeners.mouseenter();parentBar.listeners.mouseleave()");
  assert.equal(h.timers.size,1);
  h.run('parentBar.listeners.mouseenter()');assert.equal(h.timers.size,0);
  h.run("expandedLanes.add('C');closeLane('B')");
  assert.equal(h.run('expandedLanes.size'),0);
  assert.equal(h.run('laneCloseTimers.size'),0);
});
