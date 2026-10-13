'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../frontend/scripts/bindings.js'),'utf8').split('/* Bind */')[0];

function harness(scale=1){
  const frames=new Map(),timers=new Map();let next=0;
  const calls={extend:0,shrink:0,draw:0,cursor:null};
  const hover={hidden:0,cleared:0,classesRemoved:0},laneCloseTimers=new Map();
  function target(extra={}){
    const listeners=new Map();return Object.assign({
      listeners,style:{},
      addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn)},
      removeEventListener(type,fn){listeners.get(type)?.delete(fn)},
      fire(type,props={}){const e={button:0,clientX:0,clientY:0,prevented:false,preventDefault(){this.prevented=true},...props};for(const fn of [...(listeners.get(type)||[])])fn(e);return e}
    },extra);
  }
  const rt=target({scrollLeft:1000,scrollTop:200,clientLeft:1,clientTop:1,clientWidth:800,clientHeight:400,
    getBoundingClientRect:()=>({left:20,top:40})});
  const lb=target({scrollTop:200});const doc=target(),win=target();
  doc.querySelectorAll=()=>[{classList:{remove(){hover.classesRemoved++}}}];
  const canvas={style:{left:'600px'},width:1600};
  const context=vm.createContext({
    document:doc,window:win,axis:{tw:10000},sbDrag:false,dragging:false,
    $:selector=>selector==='#dep-canvas'?canvas:selector==='#tooltip'?{classList:{remove(){hover.hidden++}}}:null,
    laneCloseTimers,clearLaneHover:()=>{hover.cleared++},
    canvasClientDelta:value=>value/scale,
    canvasClientPoint:(event,node)=>({x:(event.clientX-node.getBoundingClientRect().left)/scale-node.clientLeft,y:(event.clientY-node.getBoundingClientRect().top)/scale-node.clientTop}),
    requestAnimationFrame:fn=>{const id=++next;frames.set(id,fn);return id},cancelAnimationFrame:id=>frames.delete(id),
    setTimeout:fn=>{const id=++next;timers.set(id,fn);return id},clearTimeout:id=>timers.delete(id),
    maybeExtend:()=>{calls.extend++},shrinkWindow:()=>{calls.shrink++},schDepDraw:()=>{calls.draw++},setDragCur:value=>{calls.cursor=value},
    rt,lb
  });
  vm.runInContext(source+'\nbindGanttPanScroll(rt,lb);rt.addEventListener("mouseleave",clearGanttHover);',context);
  const run=code=>vm.runInContext(code,context);
  const flush=map=>{const pending=[...map.values()];map.clear();pending.forEach(fn=>fn())};
  return {rt,lb,doc,win,canvas,context,calls,frames,timers,hover,laneCloseTimers,run,
    start(x=400,y=300){return rt.fire('mousedown',{button:1,buttons:4,clientX:x,clientY:y})},
    move(x,y,buttons=4){return doc.fire('mousemove',{buttons,clientX:x,clientY:y})},
    end(){doc.fire('mouseup',{button:1,buttons:0})},flushFrames:()=>flush(frames),flushTimers:()=>flush(timers)};
}

test('middle pan updates native scroll and both panes immediately without render work',()=>{
  const h=harness();assert.equal(h.start().prevented,true);assert.equal(h.run('sbDrag'),true);
  assert.equal(h.calls.cursor,'drag-cursor');
  for(let step=1;step<=30;step++){
    h.move(400+step*2,300+step);h.rt.fire('scroll');h.lb.fire('scroll');
    assert.equal(h.rt.scrollLeft,1000-step*2);assert.equal(h.rt.scrollTop,200-step);assert.equal(h.lb.scrollTop,h.rt.scrollTop);
  }
  assert.deepEqual(h.calls,{extend:0,shrink:0,draw:0,cursor:'drag-cursor'});assert.equal(h.frames.size,0);
  h.end();assert.equal(h.run('sbDrag'),false);assert.equal(h.calls.extend,1);assert.equal(h.calls.cursor,null);
  h.flushTimers();assert.equal(h.calls.shrink,1);
});

test('middle pan remains attached to the pointer at every whole-canvas scale',()=>{
  for(const scale of [.35,.5,1,2,3]){
    const h=harness(scale);h.start();h.move(470,335);
    assert.ok(Math.abs((1000-h.rt.scrollLeft)*scale-70)<1e-8);
    assert.ok(Math.abs((200-h.rt.scrollTop)*scale-35)<1e-8);assert.equal(h.lb.scrollTop,h.rt.scrollTop);h.end();
  }
});

test('panning cancels pending calendar maintenance until release',()=>{
  const h=harness();h.rt.fire('scroll');assert.equal(h.frames.size,1);
  h.start();assert.equal(h.frames.size,0);h.flushFrames();assert.equal(h.calls.extend,0);
  h.move(350,260);h.end();assert.equal(h.calls.extend,1);
  h.start();h.flushTimers();assert.equal(h.calls.shrink,0);h.end();h.flushTimers();assert.equal(h.calls.shrink,1);
});

test('dependency bitmap is reused for vertical motion and only refreshed outside horizontal overscan',()=>{
  const h=harness();h.start();h.move(400,0);h.rt.fire('scroll');assert.equal(h.calls.draw,0);
  h.move(390,0);h.rt.fire('scroll');assert.equal(h.calls.draw,0);
  h.move(-100,0);assert.ok(h.calls.draw>0);
});

test('renderer coverage check controls redraws for its two-axis high-DPI cache',()=>{
  const h=harness();let covered=true;h.context.depViewportCovered=()=>covered;
  h.start();h.move(400,200);assert.equal(h.calls.draw,0);
  covered=false;h.move(400,100);assert.equal(h.calls.draw,1);
  covered=true;h.rt.fire('scroll');assert.equal(h.calls.draw,1);
});

test('asynchronous mirrored scroll events do not feed back into the source pane',()=>{
  const h=harness();h.rt.scrollTop=201.25;h.rt.fire('scroll');assert.equal(h.lb.scrollTop,201.25);
  h.rt.scrollTop=250.5;h.rt.fire('scroll');h.lb.fire('scroll');assert.equal(h.rt.scrollTop,250.5);
  h.lb.scrollTop=450.75;h.lb.fire('scroll');assert.equal(h.rt.scrollTop,450.75);
});

test('a stale left-pane event cannot overwrite a newer right-pane scroll after zoom',()=>{
  const h=harness();
  // Layout clamps the left pane and queues its event; a subsequent API call or
  // pan moves the right pane before either queued scroll event is dispatched.
  h.lb.scrollTop=0;h.rt.scrollTop=180;h.lb.fire('scroll');
  assert.equal(h.rt.scrollTop,180);assert.equal(h.lb.scrollTop,180);
  h.rt.fire('scroll');h.lb.fire('scroll');assert.equal(h.rt.scrollTop,180);
  // A later actual left-pane scroll still owns its normal synchronization.
  h.lb.scrollTop=220;h.lb.fire('scroll');assert.equal(h.rt.scrollTop,220);
  h.rt.fire('scroll');assert.equal(h.lb.scrollTop,220);
});

test('multiple queued left events cannot roll back consecutive explicit right scrolls',()=>{
  const h=harness();
  for(const top of [180,90,360,0,240]){
    h.lb.scrollTop=0;h.rt.scrollTop=top;h.lb.fire('scroll');h.lb.fire('scroll');
    assert.equal(h.rt.scrollTop,top);assert.equal(h.lb.scrollTop,top);
  }
  h.rt.fire('scroll');h.lb.scrollTop=300;h.lb.fire('scroll');assert.equal(h.rt.scrollTop,300);
});

test('other button releases preserve pan; middle release or focus loss cleans it up',()=>{
  const h=harness();h.rt.style.scrollBehavior='smooth';h.lb.style.scrollBehavior='smooth';h.start();
  assert.equal(h.rt.style.scrollBehavior,'auto');h.doc.fire('mouseup',{button:0});assert.equal(h.run('sbDrag'),true);
  h.win.fire('blur');assert.equal(h.run('sbDrag'),false);assert.equal(h.calls.cursor,null);assert.equal(h.rt.style.scrollBehavior,'smooth');
  const left=h.rt.scrollLeft;h.move(900,900);assert.equal(h.rt.scrollLeft,left);
  assert.equal(h.doc.listeners.get('mousemove').size,0);assert.equal(h.doc.listeners.get('mouseup').size,0);
  h.start();h.move(450,350,0);assert.equal(h.run('sbDrag'),false);assert.equal(h.calls.cursor,null);
});

test('scaled scrollbar hit area pauses maintenance and releases on window blur',()=>{
  const h=harness(2);
  h.rt.fire('mousedown',{button:0,clientX:20+2*(h.rt.clientWidth+4),clientY:100});
  assert.equal(h.run('sbDrag'),true);h.rt.fire('scroll');assert.equal(h.frames.size,0);
  h.win.fire('blur');assert.equal(h.run('sbDrag'),false);assert.equal(h.calls.extend,1);
});

test('middle auxiliary click suppresses browser autoscroll without affecting other buttons',()=>{
  const h=harness();assert.equal(h.rt.fire('auxclick',{button:1}).prevented,true);assert.equal(h.rt.fire('auxclick',{button:2}).prevented,false);
});

test('leaving the viewport during pan freezes expanded lanes until the gesture finishes',()=>{
  const h=harness();h.start();assert.equal(h.hover.hidden,1);
  h.rt.fire('mouseleave');h.move(1100,300);h.rt.fire('scroll');
  assert.equal(h.hover.cleared,0);assert.equal(h.hover.classesRemoved,0);assert.equal(h.calls.extend,0);
  h.end();assert.equal(h.hover.cleared,1);assert.equal(h.hover.classesRemoved,2);
  h.rt.fire('mouseleave');assert.equal(h.hover.cleared,2);
});

test('pan cancels already pending lane-close timers without changing lane geometry mid-gesture',()=>{
  const h=harness();let closed=0;
  h.laneCloseTimers.set('parent',h.context.setTimeout(()=>{closed++}));
  h.start();assert.equal(h.laneCloseTimers.size,0);h.flushTimers();assert.equal(closed,0);assert.equal(h.hover.cleared,0);
  h.move(430,340);assert.equal(h.hover.cleared,0);h.end();assert.equal(h.hover.cleared,1);
});
