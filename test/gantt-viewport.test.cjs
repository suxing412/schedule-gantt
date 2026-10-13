'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const geometry=require('../frontend/scripts/bar-geometry.js');
function harness(){
  const render=fs.readFileSync(path.join(__dirname,'../frontend/scripts/render.js'),'utf8');
  const calls=[],ctx={setTransform:(...args)=>calls.push(['transform',...args]),beginPath(){},setLineDash(){},moveTo(){},lineTo(){},bezierCurveTo(){},closePath(){},fill(){},stroke(){calls.push(['stroke'])}};
  const rt={clientWidth:800,clientHeight:600,scrollLeft:0,scrollTop:0},canvas={style:{},getContext:()=>ctx};
  const lines=[{style:{}},{style:{}}],body={style:{height:'200px'},getBoundingClientRect:()=>({left:-rt.scrollLeft,top:-rt.scrollTop})};
  const layer={style:{height:'200px'},querySelectorAll:()=>lines},header={offsetHeight:52};
  const elements={'#g-right':rt,'#dep-canvas':canvas,'#tl-body':body,'#b-layer':layer,'#tl-header':header};
  let queued=null;
  const sandbox={ScheduleBarGeometry:geometry,window:{devicePixelRatio:1},scale:1,
    axis:{tw:100000,dw:22},rowsHTotal:400000,proj:{tasks:[{id:'a',deps:[]},{id:'b',deps:['a']}]},
    bPos:{a:{...geometry.span(1,2,0,22),cy:20,type:'task'},b:{...geometry.span(4,5,0,22),cy:60,type:'task'}},
    $:id=>elements[id],isCriticalDep:()=>false,
    canvasScaleFactor:()=>sandbox.scale,
    canvasClientPoint:(event,element)=>({x:event.clientX/sandbox.scale+rt.scrollLeft,y:event.clientY/sandbox.scale+rt.scrollTop}),
    requestAnimationFrame:fn=>{queued=fn;return 1}};
  vm.createContext(sandbox);
  vm.runInContext(render.slice(render.indexOf('let depRows=null'),render.indexOf('/* Ctrl-drag dep */')),sandbox);
  return{sandbox,rt,canvas,body,layer,lines,calls,run:code=>vm.runInContext(code,sandbox),flush(){const fn=queued;queued=null;if(fn)fn()}};
}
test('dependency canvas clips both logical axes and bounds its high-DPI bitmap allocation',()=>{
  const h=harness();h.sandbox.scale=3;h.sandbox.window.devicePixelRatio=2;h.rt.scrollLeft=4000;h.rt.scrollTop=10000;
  h.sandbox.drawDeps(h.canvas,[],400000);
  assert.ok(h.canvas.width*h.canvas.height<=16000000);
  assert.ok(h.canvas.width<=32760&&h.canvas.height<=32760);
  assert.equal(h.canvas.style.height,'1000px');assert.equal(h.canvas.style.width,'1600px');
  const [,rx,, ,ry,tx,ty]=h.calls.find(c=>c[0]==='transform');
  assert.ok(rx>1&&ry>1);
  assert.ok(Math.abs(tx+parseFloat(h.canvas.style.left)*rx)<.00001);
  assert.ok(Math.abs(ty+parseFloat(h.canvas.style.top)*ry)<.00001);
  assert.equal(h.sandbox.depViewportCovered(),true);
});
test('coverage invalidates independently for vertical scrolling, horizontal scrolling and zoom density',()=>{
  const h=harness();h.sandbox.drawDeps(h.canvas,[],400000);
  assert.equal(h.sandbox.depViewportCovered(),true);
  h.rt.scrollTop=900;assert.equal(h.sandbox.depViewportCovered(),false);
  h.sandbox.drawDeps(h.canvas,[],400000);assert.equal(h.sandbox.depViewportCovered(),true);
  h.rt.scrollLeft=2000;assert.equal(h.sandbox.depViewportCovered(),false);
  h.sandbox.drawDeps(h.canvas,[],400000);assert.equal(h.sandbox.depViewportCovered(),true);
  h.sandbox.scale=3;assert.equal(h.sandbox.depViewportCovered(),false);
});
test('offscreen dependency edges are pruned while an edge crossing the viewport is retained',()=>{
  const h=harness();
  h.sandbox.drawDeps(h.canvas,[],400000);assert.equal(h.calls.filter(c=>c[0]==='stroke').length,1);
  h.calls.length=0;h.sandbox.bPos.a.cy=9000;h.sandbox.bPos.b.cy=9050;
  h.sandbox.drawDeps(h.canvas,[],400000);assert.equal(h.calls.filter(c=>c[0]==='stroke').length,0);
  h.sandbox.bPos.a.cy=-100;h.sandbox.bPos.b.cy=1200;
  h.sandbox.drawDeps(h.canvas,[],400000);assert.equal(h.calls.filter(c=>c[0]==='stroke').length,1);
});
test('zoom refresh only adjusts viewport surfaces and queues one canvas redraw without rebuilding tasks',()=>{
  const h=harness();h.sandbox.rowsHTotal=80;h.sandbox.drawDeps(h.canvas,[],200);
  h.sandbox.refreshCanvasViewport();h.sandbox.refreshCanvasViewport();
  assert.equal(h.body.style.height,'548px');assert.equal(h.layer.style.height,'548px');
  assert.ok(h.lines.every(line=>line.style.height==='548px'));
  h.calls.length=0;h.flush();
  assert.equal(h.calls.filter(c=>c[0]==='transform').length,1);
});
test('dependency preview follows the last screen pointer after the viewport scrolls',()=>{
  const h=harness();h.sandbox.scale=2;
  h.run("depPreview={id:'a',clientX:100,clientY:80}");
  h.sandbox.drawDeps(h.canvas,[],400000);
  assert.equal(h.calls.filter(c=>c[0]==='stroke').length,2);
  h.rt.scrollLeft=4000;h.rt.scrollTop=10000;h.calls.length=0;
  h.sandbox.drawDeps(h.canvas,[],400000);
  assert.equal(h.calls.filter(c=>c[0]==='stroke').length,1,'preview survives viewport recrop with no old bitmap snapshot');
});
