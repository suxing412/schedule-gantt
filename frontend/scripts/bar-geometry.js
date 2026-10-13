/* Calendar spans keep their full logical width; only the painted body is inset. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.ScheduleBarGeometry=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  function span(start,end,minimum,dayWidth){
    const width=Number(dayWidth),days=Number(end)-Number(start)+1;
    if(!Number.isFinite(width)||width<=0||!Number.isFinite(days)||days<1||!Number.isFinite(Number(minimum)))throw new RangeError('Invalid calendar span');
    const x=(Number(start)-Number(minimum))*width,w=days*width;
    // Equal insets keep the body centred in its exact inclusive calendar span.
    const inset=Math.min(2,width*.1),gap=inset*2,paintX=x+inset,paintWidth=w-gap;
    return{x,w,paintX,paintWidth,gap,inset};
  }
  function anchor(position,side){
    if(position.type==='ms')return position.cx;
    return position.x+(side==='end'?position.w:0);
  }
  function paintWidth(position){return position.paintWidth==null?position.w:position.paintWidth}
  function paintX(position){return position.paintX==null?position.x:position.paintX}
  function paintedAnchor(position,side){
    if(position.type==='ms')return position.cx;
    return paintX(position)+(side==='end'?paintWidth(position):0);
  }
  function connector(from,to){
    const x1=paintedAnchor(from,'end'),y1=from.cy,x2=paintedAnchor(to,'start'),y2=to.cy;
    const logicalGap=anchor(to,'start')-anchor(from,'end'),dx=x2-x1;
    const commands=[['moveTo',x1,y1]];
    // Only consecutive task bars on the same row use a short, arrowless joint.
    if(Math.abs(logicalGap)<.01&&Math.abs(y2-y1)<.01&&from.type!=='ms'&&to.type!=='ms'){
      commands.push(['lineTo',x2,y2]);
      return{kind:'adjacent-inline',commands,arrow:null};
    }
    // Preserve the original dependency routing and arrow for every other edge.
    const reach=Math.min(28,Math.max(10,dx*.15)),p0=x1+reach,p3=x2-reach,control=Math.max(Math.abs(p3-p0)*.45,20),finish=x2-7;
    commands.push(['lineTo',p0,y1],['bezierCurveTo',p0+control,y1,p3-control,y2,p3,y2],['lineTo',finish,y2]);
    return{kind:'standard',commands,arrow:[[finish,y2],[finish-6,y2-6*.55],[finish-6,y2+6*.55]]};
  }
  function traceConnector(ctx,route,offsetX=0,offsetY=0){
    for(const [method,...values]of route.commands)ctx[method](...values.map((value,index)=>value+(index%2?offsetY:offsetX)));
  }
  function connectorBounds(route){
    let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
    const point=(x,y)=>{left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y)};
    for(const command of route.commands)for(let i=1;i<command.length;i+=2)point(command[i],command[i+1]);
    for(const [x,y]of route.arrow||[])point(x,y);
    return{left,top,right,bottom};
  }
  function traceArrow(ctx,route,offsetX=0,offsetY=0){
    if(!route.arrow)return false;
    route.arrow.forEach(([x,y],index)=>ctx[index?'lineTo':'moveTo'](x+offsetX,y+offsetY));ctx.closePath();return true;
  }
  return Object.freeze({span,anchor,paintX,paintWidth,paintedAnchor,connector,connectorBounds,traceConnector,traceArrow});
});
