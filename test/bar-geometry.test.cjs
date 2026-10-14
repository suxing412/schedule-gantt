'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const geometry=require('../frontend/scripts/bar-geometry.js');
const root=path.resolve(__dirname,'..');

test('only same-row touching task bars use a short line without an arrow',()=>{
  for(const dw of [1,6,22,72,200]){
    const from={...geometry.span(0,2,0,dw),cy:20,type:'task'},to={...geometry.span(3,5,0,dw),cy:20,type:'task'};
    const route=geometry.connector(from,to),left=geometry.paintedAnchor(from,'end'),right=geometry.paintedAnchor(to,'start');
    assert.equal(route.kind,'adjacent-inline');
    assert.deepEqual(route.commands,[['moveTo',left,20],['lineTo',right,20]],'the short line joins the two painted ends exactly');
    assert.equal(route.arrow,null);
  }
});
test('cross-row touching tasks keep the original curve and arrow above and below',()=>{
  for(const dw of [1,6,22,72,200])for(const dy of [-400,-40,40,400]){
    const from={...geometry.span(0,2,0,dw),cy:500,type:'task'},to={...geometry.span(3,5,0,dw),cy:500+dy,type:'task'};
    const route=geometry.connector(from,to),x1=geometry.paintedAnchor(from,'end'),x2=geometry.paintedAnchor(to,'start');
    assert.equal(route.kind,'standard');assert.equal(route.arrow.length,3);
    assert.deepEqual(route.commands,[['moveTo',x1,from.cy],['lineTo',x1+10,from.cy],['bezierCurveTo',x1+30,from.cy,x2-30,to.cy,x2-10,to.cy],['lineTo',x2-7,to.cy]]);
    assert.deepEqual(route.arrow,[[x2-7,to.cy],[x2-13,to.cy-3.3],[x2-13,to.cy+3.3]]);
    const bounds=geometry.connectorBounds(route);
    for(const [x,y]of route.arrow)assert.ok(x>=bounds.left&&x<=bounds.right&&y>=bounds.top&&y<=bounds.bottom);
  }
});
test('several cross-row dependencies at one date boundary each retain the original arrow route',()=>{
  const from={...geometry.span(0,2,0,22),cy:20,type:'task'};
  const routes=[60,100,420].map(cy=>geometry.connector(from,{...geometry.span(3,5,0,22),cy,type:'task'}));
  assert.equal(new Set(routes.map(route=>JSON.stringify(route.commands))).size,3);
  for(const route of routes){assert.ok(route.commands.some(command=>command[0]==='bezierCurveTo'));assert.ok(route.arrow)}
});
test('summary/lane endpoints and milestone centres preserve the original arrow clearance',()=>{
  for(const type of ['sum','lane','task']){
    const from={...geometry.span(0,2,0,22),cy:20,type},pin={type:'ms',x:60,w:12,cx:66,cy:60};
    const toPin=geometry.connector(from,pin);
    assert.equal(toPin.kind,'standard');assert.deepEqual(toPin.arrow[0],[59,60]);
    assert.deepEqual(toPin.commands[0],['moveTo',64,20]);
    const fromPin=geometry.connector({...pin,cy:20},{...geometry.span(3,4,0,22),cy:60,type});
    assert.equal(fromPin.kind,'standard');assert.deepEqual(fromPin.commands[0],['moveTo',66,20]);
    assert.deepEqual(fromPin.arrow[0],[61,60]);
    const sameRowToPin=geometry.connector(from,{...pin,cy:20});
    const sameRowFromPin=geometry.connector({...pin,cy:20},{...geometry.span(3,4,0,22),cy:20,type});
    for(const route of [sameRowToPin,sameRowFromPin]){
      assert.equal(route.kind,'standard','nodes never take the touching-task shortcut');
      assert.ok(route.arrow);assert.ok(route.commands.some(command=>command[0]==='bezierCurveTo'));
    }
  }
});
test('non-touching same-row, forward, reverse and long-distance routes match the original fixed geometry snapshots',()=>{
  const from={...geometry.span(0,2,0,22),cy:20,type:'task'};
  const cases=[
    {target:{...geometry.span(4,5,0,22),cy:20,type:'task'},commands:[['moveTo',64,20],['lineTo',74,20],['bezierCurveTo',94,20,60,20,80,20],['lineTo',83,20]],arrow:[[83,20],[77,16.7],[77,23.3]]},
    {target:{...geometry.span(0,0,0,22),cy:60,type:'task'},commands:[['moveTo',64,20],['lineTo',74,20],['bezierCurveTo',110.9,20,-44.9,60,-8,60],['lineTo',-5,60]],arrow:[[-5,60],[-11,56.7],[-11,63.3]]},
    {target:{...geometry.span(7,8,0,22),cy:60,type:'task'},commands:[['moveTo',64,20],['lineTo',77.8,20],['bezierCurveTo',106.78,20,113.22,60,142.2,60],['lineTo',149,60]],arrow:[[149,60],[143,56.7],[143,63.3]]},
    {target:{...geometry.span(20,21,0,22),cy:60,type:'task'},commands:[['moveTo',64,20],['lineTo',92,20],['bezierCurveTo',236.9,20,269.1,60,414,60],['lineTo',435,60]],arrow:[[435,60],[429,56.7],[429,63.3]]}
  ];
  const rounded=value=>typeof value==='number'?Math.round(value*1e8)/1e8:Array.isArray(value)?value.map(rounded):value;
  for(const {target,commands,arrow}of cases){
    const route=geometry.connector(from,target);assert.equal(route.kind,'standard');
    assert.deepEqual(rounded(route.commands),commands);assert.deepEqual(rounded(route.arrow),arrow);
  }
});
test('canvas and export tracing share the same route with only the export translation applied',()=>{
  const from={...geometry.span(0,0,0,22),cy:20,type:'task'},to={...geometry.span(1,2,0,22),cy:60,type:'task'};
  for(const target of [{...to,cy:20},to,{...to,x:88,paintX:90}]){
    const route=geometry.connector(from,target),calls=[];
    const ctx={moveTo:(...args)=>calls.push(['moveTo',...args]),lineTo:(...args)=>calls.push(['lineTo',...args]),bezierCurveTo:(...args)=>calls.push(['bezierCurveTo',...args]),closePath:()=>calls.push(['closePath'])};
    geometry.traceConnector(ctx,route,100,50);
    assert.deepEqual(calls,route.commands.map(([kind,...values])=>[kind,...values.map((v,i)=>v+(i%2?50:100))]));
    calls.length=0;
    assert.equal(geometry.traceArrow(ctx,route,100,50),Boolean(route.arrow));
    if(route.arrow)assert.deepEqual(calls,[...route.arrow.map(([x,y],index)=>[index?'lineTo':'moveTo',x+100,y+50]),['closePath']]);
    else assert.deepEqual(calls,[]);
  }
});

function code(file,start,end){
  const source=fs.readFileSync(path.join(root,'frontend/scripts',file),'utf8');
  const a=source.indexOf(start),b=source.indexOf(end,a);
  assert.ok(a>=0&&b>a,'Source function exists: '+start);
  return source.slice(a,b);
}
test('one-day bars stay inside their date cell with a positive gap at every supported continuous scale',()=>{
  for(let dw=1;dw<=200;dw+=.25){
    const p=geometry.span(100,100,90,dw),next=geometry.span(101,101,90,dw);
    assert.equal(p.w,dw);
    assert.ok(p.paintWidth>0&&p.paintWidth<p.w);
    assert.ok(p.paintX>p.x&&p.paintX+p.paintWidth<p.x+p.w);
    assert.ok(p.paintX+p.paintWidth<next.paintX);
    assert.ok(Math.abs((p.paintX-p.x)-(p.x+p.w-p.paintX-p.paintWidth))<1e-9);
    assert.equal(geometry.anchor(p,'end'),next.x);
  }
});
test('logical dates and dependency anchors never move when paint is inset',()=>{
  for(const dw of [1,6,22,72,137.5,200]){
    const p=geometry.span(30,34,10,dw);
    assert.equal(p.x,20*dw);assert.equal(p.w,5*dw);
    assert.equal(p.gap,Math.min(4,.2*dw));
    assert.equal(p.paintX,p.x+Math.min(2,.1*dw));
    assert.equal(geometry.anchor(p,'start'),20*dw);
    assert.equal(geometry.anchor(p,'end'),25*dw);
    assert.equal(geometry.anchor({type:'ms',x:100,w:16,cx:108},'start'),108);
    assert.equal(geometry.anchor({type:'ms',x:100,w:16,cx:108},'end'),108);
  }
});
test('invalid geometry is rejected instead of producing negative or infinite dimensions',()=>{
  for(const args of [[2,1,0,22],[1,1,0,0],[1,1,0,-1],[1,1,0,Infinity],[NaN,1,0,22],[1,1,NaN,22]])
    assert.throws(()=>geometry.span(...args),RangeError);
});
function fixture(){
  const layers=[];
  function element(tag,cls,text){
    return{tag,className:cls||'',textContent:text,style:{},dataset:{},children:[],listeners:{},
      classList:{add(){}},appendChild(child){this.children.push(child);return child},
      addEventListener(name,fn){this.listeners[name]=fn},
      querySelectorAll(){return this.children}};
  }
  const layer=element('div');layers.push(layer);
  const sandbox={ScheduleBarGeometry:geometry,axis:{dw:6,tw:600},bds:{mn:0},bPos:{},
    RH:40,selIds:new Set(),crit:new Set(),cf:new Set(),expandedLanes:new Set(),
    ce:element,tD:Number,eRange:t=>({s:Number(t.s),e:Number(t.e)}),
    isSum:t=>Boolean(t.summary),gc:()=> '#112233',barTextCol:()=> '#fff',barProgressCol:()=> '#000',
    bindTip(){},hexA:()=> '#112233',darkenCol:()=> '#112233',laneItems(){},rowHOf:()=>40,
    ICON:{warn:'!'},desc:()=>[],taskBounds:()=>({mn:2,mx:2}),rowYs:[0],
    $:()=>layer};
  vm.createContext(sandbox);
  vm.runInContext(code('render.js','function isLaneExpanded(','function refreshHighlightLayout(')+
    code('render.js','function renderLane(','function laneItems(')+
    code('render.js','function rLaneSub(','/* 泳道内的节点：')+
    code('render.js','function rBar(','/* 标签自适应布局')+
    code('render.js','function rPipe(','/* 悬停信息浮层 */')+
    code('interactions.js','function paintTask(','// 拖动目标集合'),sandbox);
  return{sandbox,layer};
}
test('normal, summary, flow container, collapsed flow summary and pipeline share the same painted width',()=>{
  const {sandbox:s,layer}=fixture();
  for(const dw of [1,6,22,72,200]){
    s.axis.dw=dw;
    const ordinary={id:'task',s:'2',e:'2',name:'Task'};
    const summary={...ordinary,id:'summary',summary:true};
    s.rBar(layer,ordinary,0,false);
    s.rBar(layer,summary,40,true);
    s.renderLane(layer,{...summary,id:'flow'},80);
    s.rLaneSub(layer,{...summary,id:'nested'},120,[],129,[],0);
    const pipe={...ordinary,id:'pipe',type:'pipeline'};
    s.rPipe(layer,pipe,160,[{t:pipe}],0);
    for(const id of ['task','summary','flow','nested','pipe']){
      const p=s.bPos[id],el=layer.children.filter(el=>el.dataset.id===id).at(-1);
      assert.equal(p.w,dw,id+' logical duration');
      assert.equal(p.paintWidth,dw-Math.min(4,.2*dw),id+' visual width');
      assert.equal(Number.parseFloat(el.style.left),p.paintX,id+' symmetric inset');
      assert.equal(Number.parseFloat(el.style.width),p.paintWidth,id+' DOM width');
    }
  }
});
test('drag repaint keeps visual gap and date anchors while moving or resizing at month scale',()=>{
  const {sandbox:s,layer}=fixture(),task={id:'task',s:'2',e:'2',name:'Task'};
  s.rBar(layer,task,0,false);
  task.s='3';task.e='3';s.paintTask(task);
  assert.deepEqual(JSON.parse(JSON.stringify(s.bPos.task)),{
    x:18,w:6,paintX:18.6,paintWidth:4.8,gap:1.2000000000000002,inset:.6000000000000001,y:9,h:22,cy:20,type:'task'
  });
  const bar=layer.children.find(el=>el.dataset.id==='task');
  assert.equal(bar.style.left,'18.6px');assert.equal(bar.style.width,'4.8px');
  task.e='5';s.paintTask(task);
  assert.equal(s.bPos.task.w,18);
  assert.equal(s.bPos.task.paintWidth,16.8);
  assert.equal(geometry.anchor(s.bPos.task,'end'),36);
  assert.equal(bar.style.width,'16.8px');
});
