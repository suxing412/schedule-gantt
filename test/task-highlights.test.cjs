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

function harness(tasks){
  let graphBuilds=0,redraws=0,dragging=false;
  const events=new Map(),windowEvents=new Map();
  const nodes=tasks.map(t=>{
    const values=new Set(),node={dataset:{id:t.id},values};
    node.classList={toggle(name,on){on?values.add(name):values.delete(name)}};
    node.closest=selector=>selector.startsWith('.t-row[data-id]')?node:(selector==='#g-left-body,#b-layer'||selector==='#g-left-body,#tl-body,#selection-clear'?{}:null);
    return node;
  });
  const doc={
    activeElement:null,querySelector:()=>null,querySelectorAll:()=>nodes,
    addEventListener(name,fn){events.set(name,fn)},elementFromPoint(){return null}
  };
  const project={tasks,groups:[],flags:[],meta:{title:'test'}};
  const controller=createController({
    document:doc,window:{addEventListener(name,fn){windowEvents.set(name,fn)}},
    getProject:()=>project,buildGraph(tasks){graphBuilds++;return buildGraph(tasks)},redrawEdges(){redraws++},isDragging:()=>dragging
  });
  controller.afterRender();
  return{controller,project,nodes,doc,events,windowEvents,counts:()=>({graphBuilds,redraws}),setDragging(value){dragging=value},emit(name,event={}){events.get(name)?.(event)}};
}

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

test('dependency renderer keeps critical red while adding teal chain emphasis and restores canvas alpha',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../frontend/scripts/render.js'),'utf8');
  const drawSource=source.slice(source.indexOf('function drawDeps('),source.indexOf('/* Ctrl-drag dep */'));
  const strokes=[],ctx={
    setTransform(){},beginPath(){},setLineDash(){},moveTo(){},lineTo(){},bezierCurveTo(){},closePath(){},fill(){},
    stroke(){strokes.push({color:this.strokeStyle,alpha:this.globalAlpha,halo:this.shadowColor,width:this.lineWidth})}
  };
  const context=vm.createContext({
    ScheduleBarGeometry:require('../frontend/scripts/bar-geometry.js'),
    proj:{tasks:[task('a'),task('b',['a']),task('c',['b'])]},axis:{tw:1000},depRows:null,depH:0,depPixelScale:0,depPreview:null,
    window:{devicePixelRatio:2},canvasScaleFactor:()=>1.25,
    bPos:{a:{x:0,w:10,cy:20,type:'task'},b:{x:40,w:10,cy:60,type:'task'},c:{x:80,w:10,cy:100,type:'task'}},
    $:()=>({clientWidth:800,clientHeight:600,scrollLeft:0,scrollTop:0}),isCriticalDep:()=>true,
    ScheduleHighlights:{edgeState:(from,to)=>({highlighted:from==='a',opacity:from==='a'?1:.16})},
    canvas:{style:{},getContext:()=>ctx}
  });
  vm.runInContext(drawSource+';drawDeps(canvas,[],200)',context);
  assert.equal(strokes[0].color,'#f53f3f');assert.equal(strokes[0].halo,'#36c9d6');
  assert.equal(strokes[1].color,'#f53f3f');assert.equal(strokes[1].alpha,.16);
  assert.equal(ctx.globalAlpha,1);assert.equal(ctx.shadowBlur,0);
});
