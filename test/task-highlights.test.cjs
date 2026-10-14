const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {buildIndex,traceIndex,createController}=require('../frontend/scripts/highlight.js');
const projectSource=fs.readFileSync(path.join(__dirname,'../frontend/scripts/project.js'),'utf8');
const graphSource=projectSource.slice(projectSource.indexOf('function buildDependencyGraph('),projectSource.indexOf('function topoDependencyGraph('));
function buildGraph(tasks){
  const context=vm.createContext({tasks,tD:s=>Date.parse(s)/86400000});
  vm.runInContext(graphSource,context);
  return vm.runInContext('buildDependencyGraph(tasks)',context);
}
const task=(id,deps=[],extra={})=>({id,name:id,type:'task',pid:null,s:'2026-10-01',e:'2026-10-02',who:'',deps,...extra});
const trace=(tasks,id)=>traceIndex(buildIndex(tasks,buildGraph(tasks)),id);
const sort=value=>[...value].sort();

test('walks upstream and downstream independently, excluding siblings and converging cousins',()=>{
  const tasks=[task('u'),task('a',['u']),task('sibling',['u']),task('d',['a','cousin']),task('cousin'),task('end',['d'])];
  const result=trace(tasks,'a');
  assert.deepEqual(sort(result.taskIds),['a','d','end','u']);
  assert.deepEqual(result.upstreamIds,['u']);
  assert.deepEqual(result.downstreamIds,['d','end']);
  assert.deepEqual(result.edges,[{from:'u',to:'a'},{from:'a',to:'d'},{from:'d',to:'end'}]);
});

test('parent-child barriers and pipelines are excluded; filtered-out explicit dependencies are retained',()=>{
  const tasks=[task('pipeline',[],{type:'pipeline'}),task('parent'),task('a',['hidden'],{pid:'parent'}),task('hidden'),task('child',[],{pid:'a'}),task('illegal',['pipeline'])];
  assert.deepEqual(sort(trace(tasks,'a').taskIds),['a','hidden']);
  assert.deepEqual(trace(tasks,'pipeline').taskIds,[]);
  assert.deepEqual(trace(tasks,'illegal').taskIds,['illegal']);
});

test('visited sets terminate a cycle and exclude duplicate edges without dropping either direction',()=>{
  const tasks=[task('a',['c']),task('b',['a','a']),task('c',['b'])];
  const result=trace(tasks,'a');
  assert.deepEqual(sort(result.taskIds),['a','b','c']);
  assert.deepEqual(sort(result.upstreamIds),['b','c']);
  assert.deepEqual(sort(result.downstreamIds),['b','c']);
  assert.equal(result.edges.length,3);
});

test('10,000-task explicit chain is iterative and reaches both ends',()=>{
  const tasks=Array.from({length:10000},(_,i)=>task('t'+i,i?['t'+(i-1)]:[]));
  const result=trace(tasks,'t5000');
  assert.equal(result.taskIds.length,10000);
  assert.equal(result.upstreamIds.length,5000);
  assert.equal(result.downstreamIds.length,4999);
  assert.equal(result.edges.length,9999);
});

function harness(tasks,options={}){
  let graphBuilds=0,redraws=0,dragging=false;
  const events=new Map(),windowEvents=new Map(),reveals=[],edits=[];
  const nodes=tasks.map(t=>{
    const values=new Set(),node={dataset:{id:t.id},values};
    node.classList={toggle(name,on){on?values.add(name):values.delete(name)}};
    node.closest=selector=>selector.startsWith('.t-row[data-id]')?node:(selector==='#g-left-body,#b-layer'||selector==='#g-left-body,#tl-body'||selector==='#g-left-body,#tl-body,#selection-clear'?{}:null);
    return node;
  });
  const doc={
    activeElement:null,querySelector:()=>null,querySelectorAll:()=>nodes,
    addEventListener(name,fn){events.set(name,fn)},elementFromPoint(){return null}
  };
  const project={tasks,groups:[],flags:[],meta:{title:'test'}};
  const controller=createController({
    document:doc,window:{addEventListener(name,fn){windowEvents.set(name,fn)}},
    getProject:()=>project,buildGraph(tasks){graphBuilds++;return buildGraph(tasks)},redrawEdges(){redraws++},isDragging:()=>dragging,
    revealTasks(before,after){reveals.push({before:[...before],after:[...after]});return options.layoutChanged===true},
    editTask(id){edits.push(id);return options.editTask?.(id)}
  });
  controller.afterRender();
  return{controller,project,nodes,doc,events,windowEvents,reveals,edits,counts:()=>({graphBuilds,redraws}),setDragging(value){dragging=value},emit(name,event={}){events.get(name)?.(event)}};
}



function mouseActivation(target,detail=1,x=240,y=180){
  return{target,detail,button:0,clientX:x,clientY:y,defaultPrevented:false,propagationStopped:false,
    preventDefault(){this.defaultPrevented=true},stopPropagation(){this.propagationStopped=true}};
}
const blankTaskArea=()=>({closest:selector=>selector==='#g-left-body,#tl-body'||selector==='#g-left-body,#tl-body,#selection-clear'?{}:null});

test('double click edits the original task when the first click reveals rows and its old position becomes blank or another task',()=>{
  for(const landing of ['blank','other-task']){
    const h=harness([task('upstream-parent'),task('upstream',[],{pid:'upstream-parent'}),task('original',['upstream']),task('other')],{layoutChanged:true});
    const before=JSON.stringify(h.project),original=h.nodes[2];
    h.emit('click',mouseActivation(original,1));
    h.controller.beforeRender();h.controller.afterRender();
    const target=landing==='blank'?blankTaskArea():h.nodes[3];
    const second=mouseActivation(target,2);h.emit('click',second);
    assert.equal(second.defaultPrevented,true,landing+' cannot trigger native empty-space creation or select the displaced row');
    assert.equal(second.propagationStopped,true);
    assert.equal(h.controller.state().selectedTaskId,'original');
    const double=mouseActivation(target,2);h.emit('dblclick',double);
    assert.deepEqual(h.edits,['original']);
    assert.equal(double.defaultPrevented,true);assert.equal(double.propagationStopped,true);
    assert.equal(JSON.stringify(h.project),before);
    h.emit('dblclick',mouseActivation(target,2));
    assert.deepEqual(h.edits,['original'],'the capture is consumed exactly once');
  }
});

test('ordinary clicks and changed coordinates keep their native target after a geometry-changing first click',()=>{
  for(const scenario of [
    {detail:1,x:240,y:180},
    {detail:0,x:240,y:180},
    {detail:2,x:244,y:180},
    {detail:2,x:240,y:184}
  ]){
    const h=harness([task('original'),task('other')],{layoutChanged:true});
    h.emit('click',mouseActivation(h.nodes[0],1));
    const second=mouseActivation(blankTaskArea(),scenario.detail,scenario.x,scenario.y);h.emit('click',second);
    assert.equal(second.defaultPrevented,false);
    assert.equal(second.propagationStopped,false);
    assert.equal(h.controller.state().selectedTaskId,null);
    const double=mouseActivation(second.target,2,scenario.x,scenario.y);h.emit('dblclick',double);
    assert.equal(double.defaultPrevented,false);
    assert.deepEqual(h.edits,[]);
  }
});

test('new selection, cleared selection, deleted task and clicks outside the task area invalidate a previous double-click anchor',()=>{
  for(const change of ['new-selection','clear','delete','outside']){
    const h=harness([task('original'),task('other')],{layoutChanged:true});
    h.emit('click',mouseActivation(h.nodes[0],1));
    if(change==='new-selection')h.controller.setSelected('other');
    if(change==='clear')h.controller.setSelected(null);
    if(change==='delete'){h.project.tasks=h.project.tasks.filter(t=>t.id!=='original');h.controller.beforeRender()}
    const target=change==='outside'?{closest:()=>null}:h.nodes[1];
    const second=mouseActivation(target,2);h.emit('click',second);
    assert.equal(second.defaultPrevented,false,change+' must retain native handling');
    const double=mouseActivation(target,2);h.emit('dblclick',double);
    assert.equal(double.defaultPrevented,false);
    assert.deepEqual(h.edits,[]);
  }
});

test('double clicks without a first-click geometry change are left to the existing task editor handler',()=>{
  const h=harness([task('original')],{layoutChanged:false});
  h.emit('click',mouseActivation(h.nodes[0],1));
  const second=mouseActivation(h.nodes[0],2);h.emit('click',second);
  const double=mouseActivation(h.nodes[0],2);h.emit('dblclick',double);
  assert.equal(second.defaultPrevented,false);
  assert.equal(double.defaultPrevented,false);
  assert.deepEqual(h.edits,[]);
});

test('relocated double clicks delegate to the supplied permission-checked editor without editing project data',()=>{
  let permissionChecks=0;
  const h=harness([task('original')],{layoutChanged:true,editTask(id){permissionChecks++;assert.equal(id,'original');return false}});
  const before=JSON.stringify(h.project);
  h.emit('click',mouseActivation(h.nodes[0],1));
  h.emit('click',mouseActivation(blankTaskArea(),2));
  h.emit('dblclick',mouseActivation(blankTaskArea(),2));
  assert.equal(permissionChecks,1);
  assert.deepEqual(h.edits,['original']);
  assert.equal(JSON.stringify(h.project),before,'the highlight controller must not bypass the editor to write data');
});

test('selected chain reveals every upstream and downstream ancestor without adding containers or siblings to the chain',()=>{
  const h=harness([
    task('flow-left',[],{flow:true}),task('left-group',[],{pid:'flow-left'}),task('a',[],{pid:'left-group'}),
    task('flow-right',[],{flow:true}),task('right-group',[],{pid:'flow-right'}),task('nested',[],{pid:'right-group'}),
    task('b',['a'],{pid:'nested'}),task('c',['b'],{pid:'right-group'}),task('sibling',['a'],{pid:'left-group'})
  ]);
  const before=JSON.stringify(h.project);
  h.controller.setSelected('b');
  assert.deepEqual(sort(h.controller.state().taskIds),['a','b','c']);
  for(const id of ['flow-left','left-group','flow-right','right-group','nested'])assert.equal(h.controller.revealsChildren(id),true,id+' contains a chain task');
  for(const id of ['a','b','c','sibling'])assert.equal(h.controller.revealsChildren(id),false,id+' is not a needed container');
  const notification=h.reveals.at(-1);
  assert.deepEqual(notification.before,[]);
  assert.deepEqual(sort(notification.after),['flow-left','flow-right','left-group','nested','right-group']);
  const count=h.reveals.length;h.controller.setSelected('b');assert.equal(h.reveals.length,count,'same selection does not schedule another layout');
  h.controller.setSelected(null);
  assert.deepEqual(sort(h.reveals.at(-1).before),sort(notification.after));
  assert.deepEqual(h.reveals.at(-1).after,[]);
  assert.equal(h.controller.revealsChildren('nested'),false);
  assert.equal(JSON.stringify(h.project),before,'temporary reveals never overwrite fold or flow preferences');
});

test('beforeRender refreshes pinned containers after dependency changes and reparenting without a dependency change',()=>{
  const h=harness([task('old-parent'),task('new-parent'),task('target-parent'),task('a',[],{pid:'old-parent'}),task('b',['a'],{pid:'target-parent'}),task('c',[],{pid:'new-parent'})]);
  h.controller.setSelected('b');
  assert.equal(h.controller.revealsChildren('old-parent'),true);
  h.project.tasks.find(t=>t.id==='b').deps=['c'];h.controller.beforeRender();
  assert.deepEqual(sort(h.controller.state().taskIds),['b','c']);
  assert.equal(h.controller.revealsChildren('old-parent'),false);
  assert.equal(h.controller.revealsChildren('new-parent'),true);
  h.project.tasks.find(t=>t.id==='c').pid='old-parent';h.controller.beforeRender();
  assert.equal(h.controller.revealsChildren('new-parent'),false,'pid edits invalidate the visibility path even when deps are unchanged');
  assert.equal(h.controller.revealsChildren('old-parent'),true);
});

test('beforeRender releases obsolete pins when a chain member or the selected task is deleted',()=>{
  const h=harness([task('a-parent'),task('b-parent'),task('a',[],{pid:'a-parent'}),task('b',['a'],{pid:'b-parent'})]);
  h.controller.setSelected('b');
  h.project.tasks=h.project.tasks.filter(t=>t.id!=='a');h.project.tasks.find(t=>t.id==='b').deps=[];
  h.controller.beforeRender();
  assert.deepEqual(h.controller.state().taskIds,['b']);
  assert.equal(h.controller.revealsChildren('a-parent'),false);
  assert.equal(h.controller.revealsChildren('b-parent'),true);
  h.project.tasks=h.project.tasks.filter(t=>t.id!=='b');h.controller.beforeRender();
  assert.equal(h.controller.state().selectedTaskId,null);
  assert.equal(h.controller.revealsChildren('b-parent'),false);
});

test('owner names use trimmed exact matches; visual state never modifies the project',()=>{
  const h=harness([task('a',[],{who:' 苏省 '}),task('b',[],{who:'苏省'}),task('c',[],{who:'苏'}),task('d')]);
  const before=JSON.stringify(h.project);
  assert.deepEqual(h.controller.listOwners(),['苏省','苏']);
  h.controller.setOwner('苏省');
  assert.ok(h.nodes[0].values.has('hl-owner-match'));
  assert.ok(h.nodes[1].values.has('hl-owner-match'));
  assert.ok(h.nodes[2].values.has('hl-owner-dim'));
  assert.ok(h.nodes[3].values.has('hl-owner-dim'));
  assert.throws(()=>h.controller.setOwner('省'),/负责人不存在/);
  assert.equal(h.controller.setOwner('   ').owner,null);
  h.controller.setOwner('苏省');
  h.controller.clear();
  assert.equal(h.nodes.some(n=>n.values.has('hl-owner-dim')),false);
  assert.equal(JSON.stringify(h.project),before);
  assert.deepEqual(h.counts(),{graphBuilds:0,redraws:0});
});

test('owner and selected chain classes coexist and clearing the chain preserves owner emphasis',()=>{
  const h=harness([task('a',[],{who:'甲'}),task('b',['a'],{who:'乙'}),task('c',[],{who:'甲'})]);
  h.controller.setOwner('甲');h.controller.setSelected('b');
  assert.ok(h.nodes[0].values.has('hl-owner-match'));
  assert.ok(h.nodes[0].values.has('hl-chain-match'));
  assert.ok(h.nodes[1].values.has('hl-owner-dim'));
  assert.ok(h.nodes[1].values.has('hl-chain-root'));
  assert.ok(h.nodes[2].values.has('hl-owner-match'));
  assert.ok(h.nodes[2].values.has('hl-chain-dim'));
  assert.deepEqual(h.controller.edgeState('a','b'),{highlighted:true,opacity:1});
  assert.deepEqual(h.controller.edgeState('c','b'),{highlighted:false,opacity:.16});
  h.controller.setSelected(null);
  assert.ok(h.nodes[0].values.has('hl-owner-match'));
  assert.ok(!h.nodes[0].values.has('hl-chain-match'));
  assert.deepEqual(h.controller.edgeState('a','b'),{highlighted:false,opacity:1});
});

test('graph and bounded trace cache are lazy, invalidated after a dependency edit, and cannot leak mutable sets',()=>{
  const h=harness([task('a'),task('b',['a']),task('c')]);
  assert.equal(h.counts().graphBuilds,0);
  h.controller.trace('b');h.controller.trace('a');h.controller.trace('b');
  assert.equal(h.counts().graphBuilds,1);
  const returned=h.controller.trace('b');returned.taskIds.push('c');returned.edges[0].from='c';
  assert.deepEqual(h.controller.trace('b').taskIds,['b','a']);
  assert.deepEqual(h.controller.trace('b').edges,[{from:'a',to:'b'}]);
  h.controller.afterRender();h.controller.trace('b');
  assert.equal(h.counts().graphBuilds,1);
  h.project.tasks[1].deps=['c'];h.controller.afterRender();
  assert.equal(h.counts().graphBuilds,1);
  assert.deepEqual(h.controller.trace('b').taskIds,['b','c']);
  assert.equal(h.counts().graphBuilds,2);
});

test('click pins a complete chain across pointer movement, focus changes, blur and rendering',()=>{
  const h=harness([task('a'),task('b',['a']),task('unrelated')]);
  h.emit('click',{target:h.nodes[1]});
  assert.equal(h.controller.state().selectedTaskId,'b');
  assert.ok(h.nodes[0].values.has('hl-chain-match'));
  const redraws=h.counts().redraws;
  for(const name of ['mouseover','mousemove','mouseout','focusin','focusout']){
    h.emit(name,{target:h.nodes[2],relatedTarget:h.nodes[0],clientX:1,clientY:1});
    assert.equal(h.controller.state().selectedTaskId,'b');
  }
  h.windowEvents.get('blur')?.();
  assert.equal(h.counts().redraws,redraws);
  h.controller.afterRender();
  assert.equal(h.controller.state().selectedTaskId,'b');
  assert.ok(h.nodes[0].values.has('hl-chain-match'));
  assert.ok(h.nodes[2].values.has('hl-chain-dim'));
  h.doc.querySelectorAll=()=>[h.nodes[0]];
  h.controller.afterRender();
  assert.equal(h.controller.state().selectedTaskId,'b','filtering the root out of the DOM does not clear its chain');
});

test('clicking another task switches the chain, repeating the click keeps it, and blank space clears only the chain',()=>{
  const h=harness([task('a',[],{who:'甲'}),task('b',['a']),task('c')]);
  h.controller.setOwner('甲');h.emit('click',{target:h.nodes[1]});
  const before=JSON.stringify(h.project);
  h.emit('click',{target:h.nodes[2]});
  assert.equal(h.controller.state().selectedTaskId,'c');
  assert.deepEqual(h.controller.state().taskIds,['c']);
  const redraws=h.counts().redraws;
  h.emit('click',{target:h.nodes[2]});
  assert.equal(h.counts().redraws,redraws);
  const blank={closest:selector=>selector==='#g-left-body,#tl-body,#selection-clear'?{}:null};
  h.emit('click',{target:blank});
  assert.equal(h.controller.state().selectedTaskId,null);
  assert.equal(h.controller.state().owner,'甲');
  assert.ok(h.nodes[0].values.has('hl-owner-match'));
  assert.equal(JSON.stringify(h.project),before);
});

test('toolbar and dialog clicks do not dismiss the chain; explicit selection-clear and pipeline clicks do',()=>{
  const h=harness([task('a'),task('pipeline',[],{type:'pipeline'})]);
  h.emit('click',{target:h.nodes[0]});
  const outside={closest:()=>null};
  h.emit('click',{target:outside});
  assert.equal(h.controller.state().selectedTaskId,'a');
  const clearButton={closest:selector=>selector==='#g-left-body,#tl-body,#selection-clear'?{}:null};
  h.emit('click',{target:clearButton});
  assert.equal(h.controller.state().selectedTaskId,null);
  h.emit('click',{target:h.nodes[0]});
  h.emit('click',{target:h.nodes[1]});
  assert.equal(h.controller.state().selectedTaskId,null);
});

test('drag gestures, secondary clicks and prevented clicks cannot switch the selected chain',()=>{
  const h=harness([task('a'),task('b')]);
  h.controller.setSelected('a');
  h.emit('mousedown',{button:0,clientX:1,clientY:1});
  h.emit('mouseup',{clientX:20,clientY:1});
  h.emit('click',{target:h.nodes[1],button:0});
  assert.equal(h.controller.state().selectedTaskId,'a');
  h.emit('click',{target:h.nodes[1],button:2});
  h.emit('click',{target:h.nodes[1],defaultPrevented:true});
  h.setDragging(true);h.emit('click',{target:h.nodes[1]});h.setDragging(false);
  assert.equal(h.controller.state().selectedTaskId,'a');
  h.emit('mousedown',{button:0,clientX:1,clientY:1});
  h.emit('mouseup',{clientX:2,clientY:2});
  h.emit('click',{target:h.nodes[1],button:0});
  assert.equal(h.controller.state().selectedTaskId,'b');
  h.emit('mousedown',{button:0,clientX:1,clientY:1});
  h.emit('mouseup',{clientX:20,clientY:1});
  const clearButton={closest:selector=>selector==='#g-left-body,#tl-body,#selection-clear'?{}:null};
  h.emit('click',{target:clearButton,detail:0});
  assert.equal(h.controller.state().selectedTaskId,null,'keyboard activation after a drag is still an explicit clear');
});

test('Space explicitly activates a focused task; focus, arrows and Enter do not override the clicked chain',()=>{
  const h=harness([task('a'),task('b',['a'])]);
  h.controller.setSelected('a');
  let prevented=0;
  const event={target:h.nodes[1],preventDefault(){prevented++}};
  h.emit('focusin',event);h.emit('keydown',{...event,key:'ArrowDown'});h.emit('keydown',{...event,key:'Enter'});
  assert.equal(h.controller.state().selectedTaskId,'a');
  h.emit('keydown',{...event,key:' '});
  assert.equal(h.controller.state().selectedTaskId,'b');
  assert.equal(prevented,1);
  const input={closest:selector=>selector.startsWith('button,a,input')?{}:h.nodes[0]};
  h.emit('keydown',{target:input,key:' ',preventDefault(){throw new Error('native input must retain Space')}});
  assert.equal(h.controller.state().selectedTaskId,'b');
});

test('legacy setHovered tool calls pin the same persistent selection as setSelected',()=>{
  const h=harness([task('a'),task('b',['a'])]);
  const state=h.controller.setHovered('b');
  assert.equal(state.selectedTaskId,'b');assert.equal(state.hovered,'b');
  h.emit('mouseout',{target:h.nodes[1],relatedTarget:null});
  assert.equal(h.controller.state().selectedTaskId,'b');
  h.controller.clear();
  assert.equal(h.controller.state().selectedTaskId,null);
  assert.equal(h.controller.state().hovered,null);
});

test('removed owners and tasks clear stale visual state on render',()=>{
  const h=harness([task('a',[],{who:'甲'}),task('b')]);
  h.controller.setOwner('甲');h.controller.setHovered('a');
  h.project.tasks.splice(0,1);h.controller.afterRender();
  assert.equal(h.controller.state().owner,null);
  assert.equal(h.controller.state().hovered,null);
  assert.throws(()=>h.controller.trace('a'),/任务不存在/);
});

function dependencyCanvasHarness(options={}){
  const source=fs.readFileSync(path.join(__dirname,'../frontend/scripts/render.js'),'utf8');
  const drawSource=source.slice(source.indexOf('function drawDeps('),source.indexOf('/* Ctrl-drag dep */'));
  function recordedCanvas(){
    let width=0,height=0,currentPath=[];
    const strokes=[],fills=[],transforms=[];
    const ctx={
      globalAlpha:1,shadowBlur:0,shadowColor:'transparent',
      setTransform(...args){this.transform=args;transforms.push(args)},
      beginPath(){currentPath=[]},setLineDash(){},
      moveTo(...args){currentPath.push(['moveTo',...args])},
      lineTo(...args){currentPath.push(['lineTo',...args])},
      bezierCurveTo(...args){currentPath.push(['bezierCurveTo',...args])},
      closePath(){currentPath.push(['closePath'])},
      stroke(){strokes.push({color:this.strokeStyle,alpha:this.globalAlpha,halo:this.shadowColor,width:this.lineWidth,path:currentPath.map(command=>[...command])})},
      fill(){fills.push({color:this.fillStyle,alpha:this.globalAlpha,path:currentPath.map(command=>[...command])})},
      clearRect(){strokes.length=0;fills.length=0}
    };
    const canvas={style:{},strokes,fills,transforms,ctx,clears:0,getContext:()=>ctx};
    function resetBitmap(){
      canvas.clears++;strokes.length=0;fills.length=0;currentPath=[];
      Object.assign(ctx,{globalAlpha:1,shadowBlur:0,shadowColor:'transparent',transform:[1,0,0,1,0,0]});
    }
    Object.defineProperties(canvas,{
      width:{get:()=>width,set(value){width=value;resetBitmap()}},
      height:{get:()=>height,set(value){height=value;resetBitmap()}}
    });
    return canvas;
  }
  const bottom=recordedCanvas(),top=recordedCanvas();
  const viewport={clientWidth:800,clientHeight:600,scrollLeft:0,scrollTop:0,...options.viewport};
  const body={style:{}},positions={
    a:{x:0,w:10,cy:20,type:'task'},b:{x:40,w:10,cy:60,type:'task'},
    c:{x:80,w:10,cy:100,type:'task'},d:{x:120,w:10,cy:140,type:'task'}
  };
  let highlighted=new Set();
  const geometry=require('../frontend/scripts/bar-geometry.js');
  const context=vm.createContext({
    ScheduleBarGeometry:geometry,
    proj:{tasks:[task('a'),task('b',['a']),task('c',['b']),task('d',['c'])]},
    axis:{tw:options.timelineWidth||1000},depRows:null,depH:0,depPixelScale:0,depPreview:null,
    window:{devicePixelRatio:options.dpr||2},canvasScaleFactor:()=>options.scale||1.25,
    canvasClientPoint:event=>({x:event.clientX,y:event.clientY}),
    bPos:positions,
    $:selector=>({'#g-right':viewport,'#tl-body':body,'#dep-canvas':bottom,'#dep-highlight-canvas':top}[selector]||null),
    isCriticalDep:from=>from==='a',
    ScheduleHighlights:{edgeState:(from,to)=>({highlighted:highlighted.has(from+'>'+to),opacity:highlighted.size&&!highlighted.has(from+'>'+to)?.16:1})},
    canvas:bottom
  });
  vm.runInContext(drawSource,context);
  return{
    bottom,top,viewport,context,positions,
    highlight(edges){highlighted=new Set(edges)},
    draw(){vm.runInContext('drawDeps(canvas,[],totalHeight)',Object.assign(context,{totalHeight:options.totalHeight||200}))},
    preview(value){context.depPreview=value},
    path(from,to){return geometry.connector(positions[from],positions[to]).commands}
  };
}

test('unselected dependency edges all use the bottom canvas',()=>{
  const h=dependencyCanvasHarness();h.draw();
  assert.deepEqual(h.bottom.strokes.map(stroke=>stroke.path),[h.path('a','b'),h.path('b','c'),h.path('c','d')]);
  assert.deepEqual(h.bottom.strokes.map(stroke=>stroke.color),['#f53f3f','#86909c','#86909c']);
  assert.equal(h.top.strokes.length,0);
  assert.equal(h.top.fills.length,0);
});

test('dependency renderer keeps critical red while adding teal chain emphasis and restores canvas alpha',()=>{
  const h=dependencyCanvasHarness();h.highlight(['a>b','b>c']);h.draw();
  assert.deepEqual(h.top.strokes.map(stroke=>stroke.path),[h.path('a','b'),h.path('b','c')],'selected paths render only above the task bars');
  assert.deepEqual(h.bottom.strokes.map(stroke=>stroke.path),[h.path('c','d')],'unrelated dependencies stay behind the bars');
  assert.equal(h.top.strokes[0].color,'#f53f3f');assert.equal(h.top.strokes[0].halo,'#36c9d6');
  assert.equal(h.top.strokes[1].color,'#087e8b');assert.equal(h.top.strokes[1].halo,'#36c9d6');
  assert.equal(h.bottom.strokes[0].alpha,.16);
  for(const canvas of [h.bottom,h.top]){assert.equal(canvas.ctx.globalAlpha,1);assert.equal(canvas.ctx.shadowBlur,0)}
});

test('clearing the selected chain repaints both canvases without duplicate lines or stale top-layer arrows',()=>{
  const h=dependencyCanvasHarness();h.highlight(['a>b','b>c']);h.draw();
  assert.equal(h.top.strokes.length,2);assert.equal(h.top.fills.length,2);
  const previousClears=h.top.clears;
  h.highlight([]);h.draw();
  assert.equal(h.top.strokes.length,0);
  assert.equal(h.top.fills.length,0);
  assert.ok(h.top.clears>previousClears,'redraw resets the top bitmap even when no edge is highlighted');
  assert.deepEqual(h.bottom.strokes.map(stroke=>stroke.path),[h.path('a','b'),h.path('b','c'),h.path('c','d')]);
  assert.ok(h.bottom.strokes.every(stroke=>stroke.alpha===1),'clearing also restores unrelated edge opacity');
  h.draw();
  assert.equal(h.bottom.strokes.length,3,'repeated drawing replaces the bottom bitmap instead of accumulating paths');
});

test('dependency drag preview and its arrow use the top canvas and disappear after cancel',()=>{
  const h=dependencyCanvasHarness();h.preview({id:'a',clientX:160,clientY:110});h.draw();
  assert.equal(h.bottom.strokes.length,3);
  assert.equal(h.top.strokes.length,1);assert.equal(h.top.strokes[0].color,'#3370ff');
  assert.equal(h.top.fills.length,1);assert.equal(h.top.fills[0].color,'#3370ff');
  h.preview(null);h.draw();
  assert.equal(h.top.strokes.length,0);assert.equal(h.top.fills.length,0);
  assert.equal(h.bottom.strokes.length,3);
});

test('both dependency layers share viewport offsets, transforms and a combined 16M-pixel bitmap budget',()=>{
  for(const options of [
    {timelineWidth:4000,totalHeight:4000,viewport:{clientWidth:640,clientHeight:420,scrollLeft:850,scrollTop:700},dpr:2.5,scale:1.75},
    {timelineWidth:1000000,totalHeight:400000,viewport:{clientWidth:20000,clientHeight:10000,scrollLeft:50000,scrollTop:25000},dpr:4,scale:4}
  ]){
    const h=dependencyCanvasHarness(options);h.draw();
    assert.deepEqual(h.top.style,h.bottom.style);
    assert.equal(h.top.width,h.bottom.width);assert.equal(h.top.height,h.bottom.height);
    assert.deepEqual(h.top.ctx.transform,h.bottom.ctx.transform);
    const [rx,, ,ry,tx,ty]=h.bottom.ctx.transform;
    assert.ok(rx>0&&ry>0);
    assert.equal(tx,-parseFloat(h.bottom.style.left)*rx);
    assert.equal(ty,-parseFloat(h.bottom.style.top)*ry);
    assert.ok(tx<0&&ty<0,'horizontal and vertical scroll both participate in the transform');
    assert.ok(h.bottom.width*h.bottom.height+h.top.width*h.top.height<=16000000,'the memory cap is shared by both layers');
    assert.ok(h.bottom.width<=32760&&h.bottom.height<=32760,'neither bitmap dimension exceeds the canvas limit');
  }
});
