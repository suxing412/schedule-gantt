// Axis —— 完整日历：滚动到边缘时自动向过去/未来延伸（无限日历）
let vMn=null, vMx=null;            // 当前日历窗口（天索引），独立于任务范围
const MAXSPAN={day:420,week:1430,month:5430}; // 空白日历回收的目标跨度；完整任务范围与今天可以超过此目标
// One uniform canvas scale. All model/layout coordinates remain logical pixels.
// Only #gantt is zoomed; controls, dialogs and project data are unaffected.
const CANVAS_SCALE_LIMITS={min:.35,max:3};
let canvasScale=1,timelineZoomFrame=0,timelineZoomPending=null,canvasZoomSettleTimer=null;
function canvasScaleFactor(){return canvasScale}
function canvasClientDelta(value){return value/canvasScale}
function canvasClientPoint(event,element,{content=false}={}){
  const rect=element.getBoundingClientRect?.()||{left:0,top:0};
  return {
    x:canvasClientDelta(event.clientX-rect.left)-(element.clientLeft||0)+(content?(element.scrollLeft||0):0),
    y:canvasClientDelta(event.clientY-rect.top)-(element.clientTop||0)+(content?(element.scrollTop||0):0)
  };
}
function timelineDayWidth(zk=zoom){return ZOOM[zk].dw}
function timelineScaleState(){
  const width=timelineDayWidth();
  return {factor:canvasScale,pxPerDay:width*canvasScale,min:width*CANVAS_SCALE_LIMITS.min,max:width*CANVAS_SCALE_LIMITS.max,
    minFactor:CANVAS_SCALE_LIMITS.min,maxFactor:CANVAS_SCALE_LIMITS.max,custom:canvasScale!==1,preset:zoom};
}
function syncTimelineZoomButtons(){
  if(typeof document==='undefined')return;
  for(const button of document.querySelectorAll('#zoom-seg .seg-btn')){
    button.classList.toggle('active',button.dataset.z===zoom);
    button.setAttribute('aria-pressed',String(button.dataset.z===zoom));
  }
  const reset=$('#canvas-scale-reset');
  if(reset){reset.textContent=Math.round(canvasScale*100)+'%';reset.title='等比例缩放画布（Alt + 滚轮）；点击恢复 100%';reset.setAttribute?.('aria-label','画布缩放 '+Math.round(canvasScale*100)+'%，点击恢复 100%')}
}
function cancelTimelineWheelZoom(){
  if(timelineZoomFrame)cancelAnimationFrame(timelineZoomFrame);
  timelineZoomFrame=0;timelineZoomPending=null;
}
function scheduleCanvasSettle(){
  if(typeof setTimeout!=='function')return;
  clearTimeout(canvasZoomSettleTimer);
  canvasZoomSettleTimer=setTimeout(()=>{
    canvasZoomSettleTimer=null;
    if(dragging||sbDrag)return;
    ensureFill();maybeExtend();shrinkWindow();
    if(typeof refreshCanvasViewport==='function')refreshCanvasViewport();
  },160);
}
function timelineViewport(rt){
  const mn=bds.mn+rt.scrollLeft/axis.dw;
  return {mn,mx:mn+rt.clientWidth/axis.dw};
}
function coverTimelineViewport(anchorDay,anchorX,dw){
  const rt=$('#g-right'),tb=taskBounds(),leftDay=anchorDay-anchorX/dw;
  const buffer=Math.max(2,Math.ceil(600/(dw*canvasScale)));
  vMn=Math.floor(Math.min(tb.mn,leftDay)-buffer);
  vMx=Math.ceil(Math.max(tb.mx,leftDay+rt.clientWidth/dw)+buffer);
}
function applyCanvasView(factor,preset,{clientX,clientY}={}){
  if(!Number.isFinite(factor)||factor<=0||!axis||!bds||!Object.prototype.hasOwnProperty.call(ZOOM,preset))return false;
  const next=Math.max(CANVAS_SCALE_LIMITS.min,Math.min(CANVAS_SCALE_LIMITS.max,factor));
  if(Math.abs(next-canvasScale)<1e-10&&preset===zoom){syncTimelineZoomButtons();return false}
  const rt=$('#g-right'),rect=rt.getBoundingClientRect?.()||{left:0,top:0};
  const header=$('#tl-header')?.offsetHeight||52,height=rt.clientHeight||600;
  const pointer={
    clientX:Number.isFinite(clientX)?clientX:rect.left+((rt.clientLeft||0)+rt.clientWidth/2)*canvasScale,
    clientY:Number.isFinite(clientY)?clientY:rect.top+((rt.clientTop||0)+header+(height-header)/2)*canvasScale
  };
  const before=canvasClientPoint(pointer,rt);
  const day=bds.mn+(rt.scrollLeft+before.x)/axis.dw;
  const bodyY=(rt.scrollTop||0)+Math.max(header,before.y)-header;
  const presetChanged=preset!==zoom;
  const wasExtending=extending;extending=true;
  try{
    canvasScale=next;zoom=preset;
    const host=$('#gantt');if(host?.style)host.style.zoom=String(next);
    // CSS zoom changes the logical viewport and may clamp scroll positions.
    // Reapply pane limits before computing the new mouse position in the canvas.
    if(typeof applyPaneLayout==='function')applyPaneLayout();
    const after=canvasClientPoint(pointer,rt);
    if(!Number.isFinite(clientX))after.x=rt.clientWidth/2;
    if(!Number.isFinite(clientY)){
      const nextHeader=$('#tl-header')?.offsetHeight||52;
      after.y=nextHeader+((rt.clientHeight||600)-nextHeader)/2;
    }
    const width=ZOOM[zoom].dw,wantLeft=(day-bds.mn)*width-after.x;
    // Scaling the existing DOM is immediate. Rebuild only when a new preset or
    // an uncovered calendar edge requires new dates; defer blank-window cleanup.
    if(presetChanged||wantLeft<0||wantLeft+rt.clientWidth>axis.tw){
      coverTimelineViewport(day,after.x,width);render();
    }
    rt.scrollLeft=(day-bds.mn)*axis.dw-after.x;
    const nextHeader=$('#tl-header')?.offsetHeight||52;
    rt.scrollTop=Math.max(0,bodyY+nextHeader-Math.max(nextHeader,after.y));
    const left=$('#g-left-body');if(left)left.scrollTop=rt.scrollTop;
    if(typeof refreshCanvasViewport==='function')refreshCanvasViewport();
  }
  finally{extending=wasExtending}
  syncTimelineZoomButtons();
  scheduleCanvasSettle();
  return true;
}
function setCanvasScale(factor,options={}){
  cancelTimelineWheelZoom();
  return applyCanvasView(factor,zoom,options);
}
// Compatibility entry point: pxPerDay is displayed width, anchorX is a logical
// offset inside #g-right (the same units as scrollLeft), not a screen coordinate.
function setTimelineScale(pxPerDay,{anchorX}={}){
  if(!Number.isFinite(pxPerDay)||pxPerDay<=0)return false;
  const rt=$('#g-right'),rect=rt.getBoundingClientRect?.()||{left:0};
  const clientX=Number.isFinite(anchorX)?rect.left+((rt.clientLeft||0)+anchorX)*canvasScale:undefined;
  return setCanvasScale(pxPerDay/timelineDayWidth(),{clientX});
}
function queueTimelineWheelZoom(event,rt){
  if(!axis||!bds||dragging||sbDrag||(typeof anyOvlOpen==='function'&&anyOvlOpen()))return false;
  const multiplier=event.deltaMode===1?16:event.deltaMode===2?(rt.clientHeight||600)*canvasScale:1;
  const delta=Number(event.deltaY)*multiplier;
  if(!Number.isFinite(delta)||delta===0)return false;
  const prior=timelineZoomPending?.factor||canvasScale;
  const next=Math.max(CANVAS_SCALE_LIMITS.min,Math.min(CANVAS_SCALE_LIMITS.max,prior*Math.exp(-Math.max(-1200,Math.min(1200,delta))*.002)));
  timelineZoomPending={factor:next,clientX:event.clientX,clientY:event.clientY};
  if(!timelineZoomFrame)timelineZoomFrame=requestAnimationFrame(()=>{
    const pending=timelineZoomPending;timelineZoomFrame=0;timelineZoomPending=null;
    if(pending&&!dragging&&!sbDrag)applyCanvasView(pending.factor,zoom,pending);
  });
  return true;
}
function taskBounds(){
  let mn=Infinity,mx=-Infinity;
  for(const t of proj.tasks){const r=isSum(t)?eRange(t):{s:tD(t.s),e:tD(t.e)};mn=Math.min(mn,r.s);mx=Math.max(mx,r.e)}
  const T=todayD();if(mn===Infinity){mn=T;mx=T}
  return{mn:Math.min(mn,T),mx:Math.max(mx,T)};
}
function compBounds(rows){
  let mn=Infinity,mx=-Infinity;
  for(const{t}of rows){const{s,e}=eRange(t);mn=Math.min(mn,s);mx=Math.max(mx,e)}
  const T=todayD();if(mn===Infinity){mn=T;mx=T}
  mn=Math.min(mn,T);mx=Math.max(mx,T);
  if(vMn==null||vMx==null){
    // 初始窗口：按视图给默认跨度
    if(zoom==='day'){vMn=mn-7;vMx=mx+14}
    else if(zoom==='week'){vMn=monthStart(mn,-1);vMx=monthEnd(mx,3)}
    else{vMn=monthStart(mn,-4);vMx=monthEnd(mx,9)}
  }else{
    // 任务被拖出窗口时自动扩窗覆盖
    if(mn-2<vMn)vMn=zoom==='day'?mn-7:monthStart(mn,-1);
    if(mx+2>vMx)vMx=zoom==='day'?mx+14:monthEnd(mx,1);
  }
  return{mn:vMn,mx:vMx};
}
// 超过目标跨度时回收远端空白；保留任务与今天，不把目标误当硬上限
function trimIfOver(side){
  const rt=$('#g-right'),visible=timelineViewport(rt),buffer=Math.ceil(600/(axis.dw*canvasScale));
  const max=Math.max(MAXSPAN[zoom],Math.ceil(visible.mx-visible.mn)+2*buffer),span=vMx-vMn+1;if(span<=max)return;
  const tb=taskBounds();
  if(side==='right')vMx=Math.max(vMx-(span-max),tb.mx+2,Math.ceil(visible.mx)+buffer);
  else vMn=Math.min(vMn+(span-max),tb.mn-2,Math.floor(visible.mn)-buffer);
}
let extending=false,sbDrag=false;
function maybeExtend(){
  if(extending||dragging||sbDrag||timelineZoomFrame||canvasZoomSettleTimer||!axis)return;
  const rt=$('#g-right'),edge=600/canvasScale;
  const left=rt.scrollLeft<edge;
  if(!left&&rt.scrollWidth-rt.clientWidth-rt.scrollLeft>=edge)return;
  // 渲染缩窄内容时浏览器会先钳制 scrollLeft，所以按日期锚点恢复位置。
  const anchor=bds.mn+rt.scrollLeft/axis.dw;
  extending=true;
  try{
    if(left){
      vMn=Math.min(zoom==='day'?vMn-30:monthStart(vMn,zoom==='week'?-2:-6),vMn-Math.ceil(1200/(axis.dw*canvasScale)));
      trimIfOver('right');
    }else{
      vMx=Math.max(zoom==='day'?vMx+30:monthEnd(vMx,zoom==='week'?2:6),vMx+Math.ceil(1200/(axis.dw*canvasScale)));
      trimIfOver('left');
    }
    render();
    rt.scrollLeft=(anchor-bds.mn)*axis.dw;
  }finally{extending=false}
}
// 空窗回收：停止滚动后，把「视口 ∪ 任务范围」之外的多余日历裁掉（保留缓冲），
// 让滚动条滑块与实际内容成比例，不再越滚越小、快得无法控制
function shrinkWindow(){
  if(dragging||extending||sbDrag||timelineZoomFrame||canvasZoomSettleTimer||!axis)return;
  const rt=$('#g-right');
  const buf=Math.max({day:20,week:45,month:120}[zoom],Math.ceil(600/(axis.dw*canvasScale)));
  const tb=taskBounds();
  const vis0=bds.mn+Math.floor(rt.scrollLeft/axis.dw);
  const vis1=bds.mn+Math.ceil((rt.scrollLeft+rt.clientWidth)/axis.dw);
  const wantMn=Math.min(tb.mn,vis0)-buf;
  const wantMx=Math.max(tb.mx,vis1)+buf;
  let changed=false;
  if(vMn<wantMn-buf){vMn=wantMn;changed=true}   // 多余超过一个缓冲才回收，避免频繁重排
  if(vMx>wantMx+buf){vMx=wantMx;changed=true}
  if(changed){
    extending=true;
    const anchor=bds.mn+rt.scrollLeft/axis.dw;   // 锚定视口左缘的日期（浏览器会先钳制 scrollLeft，差值补偿不可靠）
    render();
    rt.scrollLeft=(anchor-bds.mn)*axis.dw;
    extending=false;
  }
}
// 内容不足以铺满可视区时向右补足（初始 / 切视图 / 改窗口大小后）
function ensureFill(){
  const rt=$('#g-right');
  const buffer=600/canvasScale;
  if(axis&&axis.tw<rt.clientWidth+buffer){vMx=Math.max(vMx,vMn+Math.ceil((rt.clientWidth+buffer)/axis.dw));render()}
}
// 切视图前保留精确的中心日期，新窗口同时覆盖该日期和完整视口。
function zoomTimeline(zk){
  if(!Object.prototype.hasOwnProperty.call(ZOOM,zk))return false;
  cancelTimelineWheelZoom();
  return applyCanvasView(1,zk);
}
function buildAxis(mn,mx,zk){
  const dw=timelineDayWidth(zk), T=todayD();
  const cells=[], groups=[];   // 底层最小单位 + 顶层分组
  if(zk==='day'){
    // 底=天（大格：日期+星期），顶=月 —— 工具为天粒度，不显示小时假精度
    for(let d=mn;d<=mx;d++){
      const dt=new Date(d*DAY_MS);
      cells.push({x:(d-mn)*dw,w:dw,n:String(dt.getUTCDate()),w2:'周'+WD[dow(d)],wk:dow(d)===0||dow(d)===6,tdy:d===T,heavy:dow(d)===1});
    }
    groupBy(mn,mx,dw,groups,d=>{const t=new Date(d*DAY_MS);return `${t.getUTCFullYear()}年${t.getUTCMonth()+1}月`},d=>{const t=new Date(d*DAY_MS);return t.getUTCFullYear()+'-'+t.getUTCMonth()});
  } else if(zk==='week'){
    // 底=天，顶=月
    for(let d=mn;d<=mx;d++){
      const dt=new Date(d*DAY_MS);
      cells.push({x:(d-mn)*dw,w:dw,n:String(dt.getUTCDate()),w2:WD[dow(d)],wk:dow(d)===0||dow(d)===6,tdy:d===T,heavy:dow(d)===1});
    }
    groupBy(mn,mx,dw,groups,d=>{const t=new Date(d*DAY_MS);return `${t.getUTCFullYear()}年${t.getUTCMonth()+1}月`},d=>{const t=new Date(d*DAY_MS);return t.getUTCFullYear()+'-'+t.getUTCMonth()});
  } else {
    // 底=周(周一对齐)，顶=月
    let d=mn;
    while(d<=mx){
      let end=d;while(end<mx&&dow(end+1)!==1)end++;   // 到本周日
      const dt=new Date(d*DAY_MS);
      // 月视图的"今日"是整周浅橙底（tdyWk），精确位置由今日竖线指示，不用会截断的圆圈
      cells.push({x:(d-mn)*dw,w:(end-d+1)*dw,n:`${dt.getUTCMonth()+1}/${dt.getUTCDate()}`,tdyWk:T>=d&&T<=end,heavy:true});
      d=end+1;
    }
    groupBy(mn,mx,dw,groups,d=>{const t=new Date(d*DAY_MS);return `${t.getUTCFullYear()}年${t.getUTCMonth()+1}月`},d=>{const t=new Date(d*DAY_MS);return t.getUTCFullYear()+'-'+t.getUTCMonth()});
  }
  return{dw,cells,groups,tw:(mx-mn+1)*dw};
}
// 按 key 把天分组为顶层段
function groupBy(mn,mx,dw,out,labelFn,keyFn){
  let cur=null,start=mn;
  for(let d=mn;d<=mx+1;d++){
    const k=d>mx?null:keyFn(d);
    if(k!==cur){if(cur!==null)out.push({x:(start-mn)*dw,w:(d-start)*dw,label:labelFn(start)});cur=k;start=d}
  }
}
