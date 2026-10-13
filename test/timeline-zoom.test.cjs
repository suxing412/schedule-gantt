'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),core=fs.readFileSync(path.join(root,'frontend/scripts/core.js'),'utf8');
const dates=core.slice(core.indexOf('const DAY_MS ='),core.indexOf('// 任务职能'));
const axisSource=fs.readFileSync(path.join(root,'frontend/scripts/axis.js'),'utf8');
const columns=fs.readFileSync(path.join(root,'frontend/scripts/columns.js'),'utf8');
function harness(){
 const frames=new Map(),handlers=new Map();let frameId=0;
 const buttons=['day','week','month'].map(zoom=>({dataset:{z:zoom},active:false,attrs:{},classList:{toggle(name,on){buttons.find(b=>b.dataset.z===zoom).active=on}},setAttribute(name,value){this.attrs[name]=value}}));
 const context=vm.createContext({document:{querySelectorAll:()=>buttons},
  requestAnimationFrame:cb=>{const id=++frameId;frames.set(id,cb);return id},cancelAnimationFrame:id=>frames.delete(id),
  localStorage:new Proxy({},{get(){throw Error('Must not persist scale')}}),
  bindWheel:(cb,options)=>{handlers.set('wheel',cb);handlers.set('options',options)}
 });
 vm.runInContext(dates+[
  "let proj={tasks:[{id:'a',s:'2026-10-10',e:'2026-11-15'}],meta:{title:'unchanged'}},zoom='week',dragging=false,axis=null,bds=null,renderCount=0,refreshCount=0;",
  "const host={style:{zoom:'1'}},leftBody={scrollTop:0},header={offsetHeight:52},reset={attrs:{},addEventListener(){},setAttribute(k,v){this.attrs[k]=v}};",
  "const isSum=()=>false,eRange=t=>({s:tD(t.s),e:tD(t.e)}),vRows=()=>proj.tasks.map(t=>({t}));",
  "const rt={clientLeft:1,clientTop:1,_left:0,_top:200,getBoundingClientRect:()=>({left:130+300*Number(host.style.zoom),top:200}),",
  "get clientWidth(){return (1250-300*Number(host.style.zoom))/Number(host.style.zoom)},get clientHeight(){return 600/Number(host.style.zoom)},",
  "get scrollWidth(){return axis?axis.tw:0},get scrollLeft(){return this._left},get scrollTop(){return this._top},",
  "set scrollLeft(v){this._left=Math.max(0,Math.min(v,Math.max(0,this.scrollWidth-this.clientWidth)))},",
  "set scrollTop(v){this._top=Math.max(0,Math.min(v,Math.max(0,5000-this.clientHeight)))},",
  "addEventListener(name,cb,options){bindWheel(cb,options)}};",
  "const $=s=>({'#gantt':host,'#g-right':rt,'#g-left-body':leftBody,'#tl-header':header,'#canvas-scale-reset':reset}[s]||null),anyOvlOpen=()=>false;",
  "function schSave(){throw Error('Must not save')}",
  "function render(){renderCount++;bds=compBounds(vRows());axis=buildAxis(bds.mn,bds.mx,zoom);rt.scrollLeft=rt.scrollLeft;rt.scrollTop=rt.scrollTop}",
  "function refreshCanvasViewport(){refreshCount++}",
  "function goToday(){rt.scrollLeft=(todayD()-bds.mn)*axis.dw-rt.clientWidth/2}"
 ].join('\n')+'\n'+axisSource+'\n'+columns+"\napplyPaneLayout=()=>{};vMn=tD('2026-01-01');vMx=tD('2027-12-31');render();rt.scrollLeft=4210;bindWh(rt);",context);
 const run=code=>vm.runInContext(code,context,{timeout:5000});
 return {run,frames,buttons,handlers,
  wheel(props={}){const e={clientX:1050,clientY:480,deltaMode:0,deltaY:-100,altKey:true,shiftKey:false,prevented:false,preventDefault(){this.prevented=true},...props};handlers.get('wheel')(e);return e},
  flush(){const calls=[...frames.values()];frames.clear();calls.forEach(cb=>cb())},
  value(code){return JSON.parse(run('JSON.stringify('+code+')'))},
  anchor(x=1050,y=480){return this.value('(()=>{const p=canvasClientPoint({clientX:'+x+',clientY:'+y+'},rt);return{day:bds.mn+(rt.scrollLeft+p.x)/axis.dw,bodyY:rt.scrollTop+Math.max(52,p.y)-52}})()')},
  center(){return this.value('({day:bds.mn+(rt.scrollLeft+rt.clientWidth/2)/axis.dw,bodyY:rt.scrollTop+(rt.clientHeight-52)/2})')},
  scale(){return run('canvasScaleFactor()')}
 };
}
function close(a,b){assert.ok(Math.abs(a-b)<1e-8,a+' != '+b)}
function equalAnchor(a,b){close(a.day,b.day);close(a.bodyY,b.bodyY)}
test('uniform scale preserves both mouse axes with nonzero origin and scroll',()=>{
 const h=harness(),anchor=h.anchor(),proj=h.value('proj'),presets=h.value('ZOOM');
 assert.equal(h.run('setCanvasScale(1.6,{clientX:1050,clientY:480})'),true);
 equalAnchor(h.anchor(),anchor);assert.equal(h.run('axis.dw'),22);assert.equal(h.run('host.style.zoom'),'1.6');
 assert.deepEqual(h.value('proj'),proj);assert.deepEqual(h.value('ZOOM'),presets);
 assert.equal(h.run('leftBody.scrollTop'),h.run('rt.scrollTop'));assert.equal(h.run('reset.textContent'),'160%');
});
test('near-edge scale covers the complete viewport and retains both coordinates',()=>{
 for(const x of [431,468,1375]){
  const h=harness();h.run('rt.scrollLeft=0;rt.scrollTop=1200');const before=h.anchor(x);
  h.run('setCanvasScale(.35,{clientX:'+x+',clientY:480})');equalAnchor(h.anchor(x),before);
  assert.ok(h.run('axis.tw>=rt.clientWidth'));
 }
});
test('35%-300% bounds reject invalid input and leave logical day width unchanged',()=>{
 const h=harness();
 for(const value of ['NaN','Infinity','-10','0','"2"'])assert.equal(h.run('setCanvasScale('+value+')'),false);
 h.run('setCanvasScale(.01)');assert.equal(h.scale(),.35);
 h.run('setCanvasScale(1000)');assert.equal(h.scale(),3);assert.equal(h.run('axis.dw'),22);
 const state=h.value('timelineScaleState()');assert.equal(state.factor,3);assert.equal(state.pxPerDay,66);close(state.min,7.7);assert.equal(state.max,66);
});
test('preset reset restores 100% and retains viewport center in both axes',()=>{
 const h=harness();h.run('setCanvasScale(1.4)');const center=h.center();
 h.run("zoomTimeline('week')");assert.equal(h.scale(),1);assert.equal(h.run('axis.dw'),22);equalAnchor(h.center(),center);
 h.run('setCanvasScale(2)');h.run("zoomTimeline('month')");
 assert.equal(h.scale(),1);assert.equal(h.run('axis.dw'),6);equalAnchor(h.center(),center);
 assert.equal(h.buttons.find(b=>b.dataset.z==='month').active,true);
 assert.equal(h.buttons.find(b=>b.dataset.z==='week').attrs['aria-pressed'],'false');
});
test('Alt wheel batches a burst without rebuilding the task tree',()=>{
 const h=harness(),renders=h.run('renderCount'),before=h.anchor();
 assert.equal(h.handlers.get('options').passive,false);
 for(let i=0;i<8;i++)assert.equal(h.wheel({deltaY:-8}).prevented,true);
 assert.equal(h.frames.size,1);assert.equal(h.scale(),1);h.flush();
 assert.equal(h.run('renderCount'),renders);assert.equal(h.run('refreshCount'),1);assert.ok(h.scale()>1);equalAnchor(h.anchor(),before);
});
test('coalesced wheel uses the final mouse position as its two-dimensional anchor',()=>{
 const h=harness(),before=h.anchor(1070,520);
 h.wheel({clientX:1000,clientY:490});h.wheel({clientX:1070,clientY:520});h.flush();
 close(h.scale(),Math.exp(.4));equalAnchor(h.anchor(1070,520),before);
});
test('ordinary wheel stays native and Alt+Shift pans by screen pixels at nonunit scale',()=>{
 const h=harness();h.run('setCanvasScale(2)');const left=h.run('rt.scrollLeft');
 assert.equal(h.wheel({altKey:false,deltaY:80}).prevented,false);assert.equal(h.run('rt.scrollLeft'),left);
 assert.equal(h.wheel({altKey:true,shiftKey:true,deltaY:80}).prevented,true);
 assert.equal(h.run('rt.scrollLeft'),left+40);assert.equal(h.frames.size,0);assert.equal(h.scale(),2);
 h.wheel({altKey:false,shiftKey:true,deltaMode:1,deltaY:1});assert.equal(h.run('rt.scrollLeft'),left+48);
});
test('line/pixel wheel units agree and preset reset cancels queued changes',()=>{
 const a=harness(),b=harness();a.wheel({deltaMode:1,deltaY:-1});a.flush();b.wheel({deltaY:-16});b.flush();close(a.scale(),b.scale());
 a.wheel();assert.equal(a.frames.size,1);a.run("zoomTimeline('week')");assert.equal(a.frames.size,0);a.flush();assert.equal(a.scale(),1);
});
test('zoomed-out calendar extension and recycling preserve viewport and task bounds',()=>{
 const h=harness();h.run('setCanvasScale(.35);rt.scrollLeft=rt.scrollWidth-rt.clientWidth');const before=h.anchor();
 h.run('maybeExtend()');equalAnchor(h.anchor(),before);assert.ok(h.run('(rt.scrollWidth-rt.scrollLeft-rt.clientWidth)*canvasScaleFactor()')>=599);
 h.run('shrinkWindow()');equalAnchor(h.anchor(),before);assert.ok(h.run('vMn<=tD(proj.tasks[0].s)&&vMx>=tD(proj.tasks[0].e)'));
});
test('legacy px/day API applies uniform scale using logical anchorX',()=>{
 const h=harness(),before=h.anchor();h.run('setTimelineScale(33,{anchorX:619})');
 assert.equal(h.scale(),1.5);assert.equal(h.run('axis.dw'),22);close(h.anchor().day,before.day);
});
test('screen coordinate helpers account for borders, scrolling and uniform factor',()=>{
 const h=harness();h.run('setCanvasScale(2)');assert.equal(h.run('canvasClientDelta(80)'),40);
 const point=h.value('canvasClientPoint({clientX:1132,clientY:442},rt)');assert.deepEqual(point,{x:200,y:120});
 const content=h.value('canvasClientPoint({clientX:1132,clientY:442},rt,{content:true})');
 close(content.x,point.x+h.run('rt.scrollLeft'));close(content.y,point.y+h.run('rt.scrollTop'));
});
test('active task dragging prevents deferred wheel scaling',()=>{
 const h=harness();h.run('dragging=true');assert.equal(h.wheel().prevented,true);assert.equal(h.frames.size,0);assert.equal(h.scale(),1);
});
test('zoom at the start of the task list clamps to its natural top boundary',()=>{
 const h=harness();h.run('rt.scrollTop=0;setCanvasScale(.35,{clientX:1050,clientY:480})');
 assert.equal(h.run('rt.scrollTop'),0);assert.equal(h.run('leftBody.scrollTop'),0);
});
