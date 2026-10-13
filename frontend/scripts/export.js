/* 导出 PNG（左侧表格 + 甘特图整体绘制到画布）
   只导出任务所在时间范围 —— 无限日历窗口本身太宽，不适合整幅导出 */
function capPNG(){
  try{
  const rows=vRows();
  if(!rows.length){toast('没有任务可导出','warn');return}
  // bPos 只包含当前实际绘制的内容，流程内关闭的展开层不参与导出。
  const visible=Object.entries(bPos).map(([id,p])=>({t:byId(id),p})).filter(v=>v.t&&v.p&&!v.p.hidden);
  const itemRange=t=>isSum(t)?eRange(t):{s:tD(t.s),e:tD(t.e)};
  function effectiveRange(t){
    const p=bPos[t.id];
    if(!p||p.type!=='lane')return itemRange(t);
    const ids=new Set(desc(t.id).map(d=>d.id));
    const children=visible.filter(v=>ids.has(v.t.id)&&v.p.type!=='lane'&&v.p.type!=='pipe');
    if(!children.length)return itemRange(t);
    let s=Infinity,e=-Infinity;
    for(const v of children){const r=itemRange(v.t);s=Math.min(s,r.s);e=Math.max(e,r.e)}
    return{s,e};
  }
  let mn=Infinity,mx=-Infinity;
  const rangeItems=visible.filter(v=>v.p.type!=='lane'&&v.p.type!=='pipe');
  const boundsItems=rangeItems.length?rangeItems.map(v=>v.t):rows.map(r=>r.t);
  for(const t of boundsItems){const r=effectiveRange(t);mn=Math.min(mn,r.s);mx=Math.max(mx,r.e)}
  if(!Number.isFinite(mn)||!Number.isFinite(mx)||mx<mn){toast('任务日期无效，无法导出图片','warn');return}
  const exMn=mn-2,dw=axis.dw;
  let exMx=mx+3;
  // 先测量文字，给独立节点与旗标留足图片边距，不把新增空白里的其他旗标带入导出。
  const exportFlags=(proj.flags||[]).filter(f=>{const fd=tD(f.d);return fd>=exMn&&fd<=exMx});
  const cv=document.createElement('canvas'),ctx=cv.getContext('2d');
  if(!ctx){toast('无法创建图片画布，请重试或减少导出任务','warn');return}
  const F='"PingFang SC","Microsoft YaHei",sans-serif';
  function reserveLabelRight(x,text,size,weight=''){
    ctx.font=weight+size+'px '+F;
    const right=x+ctx.measureText(String(text)).width+10;
    exMx=Math.max(exMx,bds.mn+Math.ceil(right/dw)-1);
  }
  for(const{t,p}of visible){
    if(p.type!=='ms'&&t.type!=='milestone')continue;
    if(Object.prototype.hasOwnProperty.call(p,'label')){
      if(p.label)reserveLabelRight(p.label.x,p.label.text,p.label.fontSize||10);
    }else{
      const R=6.2*(p.w||12)/16;
      reserveLabelRight(p.cx+R+7,t.name+' '+fmtS(tD(t.s)),11);
    }
  }
  for(const f of exportFlags)reserveLabelRight((tD(f.d)-bds.mn)*dw+dw/2+14,f.name,11,'700 ');
  // 使用与网页相同的可见字段、列序和显示文本，自定义字段也参与导出。
  const exportWidths=colW();
  ctx.font='11px '+F;
  let leftW=0;
  const tableColumns=visibleTableColumns().map(column=>{
    const minimum=Math.max(40,Math.min(160,Number(column.min)||40));
    const maximum=Math.max(minimum,Math.min(480,Number(column.max)||480));
    const requested=Number(exportWidths[column.id]??column.width);
    let width=Math.max(minimum,Math.min(maximum,Number.isFinite(requested)&&requested>0?requested:96));
    if(column.type==='date'||column.id==='start'||column.id==='end'){
      for(const{t}of rows)width=Math.max(width,Math.min(maximum,Math.ceil(ctx.measureText(String(taskCellText(t,column))).width)+20));
    }
    const item={column,x:leftW,width};leftW+=width;return item;
  });
  const hasFlags=exportFlags.length>0,hdH=hasFlags?74:52;
  const W=leftW+(exMx-exMn+1)*dw,H=hdH+rowsHTotal+10;
  const scale=(W>15000?1:2)*(typeof canvasScaleFactor==='function'?canvasScaleFactor():1),MAX_SIDE=32000,MAX_PIXELS=64000000;
  if(!Number.isFinite(W)||!Number.isFinite(H)||W*scale>MAX_SIDE){toast('时间范围过大，请缩小画布或切换到周/月视图后再导出','warn');return}
  // 图例按真实绘制的任务取职能和阶段，并在窄图中折行。
  const roles=proj.groups.filter(g=>visible.some(v=>v.p.type!=='pipe'&&v.t.grp===g.name));
  const phs=phaseList().filter(p=>visible.some(v=>v.t.phase===p));
  const filtered=!!(filterQ||filterGrp||filterPhase),legend=[];
  ctx.font='11px '+F;
  let lx=10,line=0;
  function addLegend(kind,label,color){
    const width=ctx.measureText(label).width+(kind==='role'?27:kind==='phase'?20:14);
    if(lx>10&&lx+width>W-10){line++;lx=10}
    // 超长自定义名称也分行，避免图例被截断。
    if(width>W-20){
      if(kind==='role'){legend.push({kind:'role',label:'',color,x:lx,y:15+line*24});lx+=13}
      addLegendText(label,kind==='filter'?'filter':'text');return;
    }
    legend.push({kind,label,color,x:lx,y:15+line*24});lx+=width;
  }
  function addLegendText(label,kind){
    let part='';
    for(const ch of String(label)){
      if(part&&lx+ctx.measureText(part+ch).width+14>W-10){
        legend.push({kind,label:part,x:lx,y:15+line*24});part='';line++;lx=10;
      }
      part+=ch;
    }
    if(part){legend.push({kind,label:part,x:lx,y:15+line*24});lx+=ctx.measureText(part).width+14}
  }
  if(roles.length){addLegend('text','职能');for(const g of roles)addLegend('role',g.name,g.color)}
  if(phs.length){addLegend('text','阶段');for(const p of phs)addLegend('phase',p)}
  if(visible.some(v=>cf.has(v.t.id)))addLegend('filter','⚠ 工期冲突');
  if(filtered)addLegend('filter','（已筛选'+(filterGrp?'：职能「'+filterGrp+'」':'')+(filterPhase?'：阶段「'+filterPhase+'」':'')+(filterQ?'：关键词「'+filterQ+'」':'')+'，非全部任务）');
  const lgH=legend.length?30+line*24:0;
  if((H+lgH)*scale>MAX_SIDE||W*(H+lgH)*scale*scale>MAX_PIXELS){toast('图片过大，请减少导出任务或切换到周/月视图','warn');return}
  const axE=buildAxis(exMn,exMx,zoom);
  const shift=(exMn-bds.mn)*axis.dw;
  cv.width=W*scale;cv.height=H*scale;ctx.scale(scale,scale);
  ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
  const ox=leftW,oy=hdH,T=todayD(),bx=ox-shift;
  // 周末底色 + 网格竖线
  for(const c of axE.cells){if(c.wk){ctx.fillStyle='#f9fafb';ctx.fillRect(ox+c.x,oy,c.w,H-oy)}}
  ctx.strokeStyle='#f1f2f5';ctx.lineWidth=1;
  for(const c of axE.cells){const gx=Math.round(ox+c.x+c.w)+.5;ctx.beginPath();ctx.moveTo(gx,oy);ctx.lineTo(gx,H);ctx.stroke()}
  // 行分隔线
  ctx.strokeStyle='#f5f6f8';
  for(let i=1;i<=rows.length;i++){const gy=Math.round(oy+(i<rows.length?rowYs[i]:rowsHTotal))+.5;ctx.beginPath();ctx.moveTo(0,gy);ctx.lineTo(W,gy);ctx.stroke()}
  // 表头
  ctx.fillStyle='#fafbfc';ctx.fillRect(0,0,W,hdH);
  ctx.textBaseline='middle';
  ctx.font='700 12px '+F;ctx.fillStyle='#1d2129';
  for(const g of axE.groups)ctx.fillText(g.label,ox+g.x+8,14);
  ctx.font='10px '+F;ctx.textAlign='center';
  for(const c of axE.cells){if(c.w>=13){ctx.fillStyle=c.tdy?'#ff7d00':'#4e5969';ctx.fillText(String(c.n),ox+c.x+c.w/2,39)}}
  ctx.textAlign='left';
  ctx.font='700 11px '+F;ctx.fillStyle='#86909c';
  for(const{column,x,width}of tableColumns){
    ctx.save();ctx.beginPath();ctx.rect(x,0,width,hdH);ctx.clip();
    ctx.fillText(fitCell(column.name,width-18),x+10,39);ctx.restore();
  }
  ctx.strokeStyle='#e8eaef';ctx.beginPath();ctx.moveTo(0,hdH+.5);ctx.lineTo(W,hdH+.5);ctx.stroke();
  ctx.beginPath();ctx.moveTo(ox+.5,0);ctx.lineTo(ox+.5,H);ctx.stroke();
  // 今日线
  if(T>=exMn&&T<=exMx){const tx=ox+(T-exMn)*axE.dw+axE.dw/2;ctx.strokeStyle='rgba(255,125,0,.7)';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(tx,oy);ctx.lineTo(tx,H);ctx.stroke();ctx.lineWidth=1}
  // 里程碑旗（专属条带 oy-26..oy-3）+ 竖虚线
  for(const f of exportFlags){
    const fd=tD(f.d);
    const fx=ox+(fd-exMn)*axE.dw+axE.dw/2,fc=f.color||'#e03e3e';
    ctx.strokeStyle=fc;ctx.setLineDash([5,4]);ctx.globalAlpha=.85;ctx.lineWidth=2;
    ctx.beginPath();ctx.moveTo(fx,oy);ctx.lineTo(fx,H);ctx.stroke();
    ctx.setLineDash([]);ctx.globalAlpha=1;
    ctx.strokeStyle=fc;ctx.lineWidth=2.2;ctx.beginPath();ctx.moveTo(fx,oy-26);ctx.lineTo(fx,oy-3);ctx.stroke();ctx.lineWidth=1;
    ctx.fillStyle=fc;ctx.beginPath();ctx.moveTo(fx,oy-26);ctx.lineTo(fx+12,oy-21.5);ctx.lineTo(fx,oy-17);ctx.closePath();ctx.fill();
    ctx.font='700 11px '+F;ctx.fillStyle=darkenCol(fc,.62);ctx.fillText(f.name,fx+14,oy-21);
  }
  // 左侧表格 + 图形
  const clip=(s,max)=>{let w=0,r='';for(const ch of String(s||'')){w+=ch.charCodeAt(0)>255?12:6.2;if(w>max)return r+'…';r+=ch}return r};
  function fitCell(value,width){
    const text=String(value==null?'':value);
    if(width<=0)return'';
    if(ctx.measureText(text).width<=width)return text;
    const chars=Array.from(text);let low=0,high=chars.length;
    while(low<high){const middle=Math.ceil((low+high)/2);if(ctx.measureText(chars.slice(0,middle).join('')+'…').width<=width)low=middle;else high=middle-1}
    return low?chars.slice(0,low).join('')+'…':'';
  }
  for(let i=0;i<rows.length;i++){
    const{t,depth}=rows[i],rowTop0=oy+rowYs[i],height=rowHOf(t),ry=rowTop0+height/2,sm=isSum(t);
    for(const{column,x,width}of tableColumns){
      ctx.save();ctx.beginPath();ctx.rect(x,rowTop0,width,height);ctx.clip();
      const text=taskCellText(t,column);
      if(column.id==='name'){
        let tx=x+10+depth*14;
        const icon=t.type==='pipeline'?'▦':t.type==='milestone'?'◆':sm?(t.flow?'⛓':'▣'):'●';
        ctx.font='10px '+F;ctx.fillStyle=t.type==='pipeline'||sm?'#86909c':gc(t.grp);ctx.fillText(icon,tx,ry);tx+=14;
        ctx.font=(sm?'700 ':'')+'11.5px '+F;ctx.fillStyle='#1d2129';
        const warning=cf.has(t.id),nm=fitCell(text,x+width-tx-(warning?24:8));ctx.fillText(nm,tx,ry);
        const pph=t.pid?(byId(t.pid)||{}).phase:null;
        if(t.phase&&t.phase!==pph){
          const px=tx+ctx.measureText(nm).width+6;
          ctx.font='10px '+F;ctx.fillStyle='#4e5969';const phase=fitCell('·'+t.phase,x+width-px-(warning?24:8));
          if(phase)ctx.fillText(phase,px,ry);
        }
        if(warning){ctx.font='700 12px '+F;ctx.fillStyle='#ff7d00';ctx.fillText('!',x+width-14,ry)}
      }else{
        ctx.font='11px '+F;ctx.fillStyle='#4e5969';
        const numeric=column.type==='number'||column.id==='pct';
        ctx.textAlign=numeric?'right':column.type==='checkbox'?'center':'left';
        ctx.fillText(fitCell(text,width-20),numeric?x+width-10:column.type==='checkbox'?x+width/2:x+10,ry);
      }
      ctx.restore();
    }
  }
  // 图形与左表分开绘制：可见流程子父单也保留，不穿透关闭的展开层。
  ctx.save();ctx.beginPath();ctx.rect(ox,oy,axE.tw,H-oy);ctx.clip();
  for(const{t,p}of visible){
    if(p.type==='lane'){
      const rg=effectiveRange(t),geometry=ScheduleBarGeometry.span(rg.s,rg.e,exMn,axE.dw),x=ox+geometry.paintX,w=geometry.paintWidth;
      const col=gc(t.grp);ctx.fillStyle=hexA(col,.10);ctx.strokeStyle=hexA(col,.4);
      rr(ctx,x,oy+p.y,w,p.h,4);ctx.fill();
      rr(ctx,x+.5,oy+p.y+.5,Math.max(0,w-1),Math.max(0,p.h-1),3.5);ctx.stroke();
    }else if(p.type==='pipe'){
      const i=rows.findIndex(r=>r.t.id===t.id);if(i<0)continue;
      const dset=new Set(desc(t.id).map(d=>d.id));
      let nk=0;while(rows[i+1+nk]&&dset.has(rows[i+1+nk].t.id))nk++;
      const endIdx=i+nk,geometry=ScheduleBarGeometry.span(mn,mx,exMn,axE.dw),x=ox+geometry.paintX,w=geometry.paintWidth;
      const ry0=oy+rowYs[i]+3,rh=(rowYs[endIdx]+rowHOf(rows[endIdx].t))-rowYs[i]-6;
      ctx.fillStyle='rgba(78,89,105,.045)';rr(ctx,x,ry0,w,rh,4);ctx.fill();
      ctx.strokeStyle='#b3bac6';rr(ctx,x+.5,ry0+.5,Math.max(0,w-1),Math.max(0,rh-1),3.5);ctx.stroke();
      ctx.fillStyle='rgba(78,89,105,.08)';rr(ctx,x,ry0,w,RH-6,4);ctx.fill();
      if(w>20){ctx.font='700 11px '+F;ctx.fillStyle='#4e5969';ctx.fillText(clip('▦ '+t.name,w-20),x+10,oy+p.cy)}
    }else if(p.type==='sum'){
      const x=bx+ScheduleBarGeometry.paintX(p),y=oy+p.y,w=ScheduleBarGeometry.paintWidth(p);
      ctx.fillStyle='#919aa4';rr(ctx,x,y,w,p.h,2);ctx.fill();
      ctx.font='700 11px '+F;ctx.fillStyle='#4e5969';ctx.textAlign='center';
      ctx.fillText(t.name,bx+p.x+p.w/2,oy+p.y-7);ctx.textAlign='left';
    }else drawItem(t);
  }
  ctx.restore();
  function drawItem(t,rowTop){
    const p=bPos[t.id];if(!p)return;
    if(p.type==='ms'||t.type==='milestone'){
      // 定位标（几何取自 bPos：与屏上一致——重叠时带工字标尺卡住条顶条底，不重叠只画标头）
      const cx=bx+p.cx,s2=(p.w||12)/16,R=6.2*s2,col2=gc(t.grp)||'#e03e3e';
      const hy=oy+p.cy;                          // 圆头中心
      let tip;
      if(p.ruler){
        const tipY=oy+p.ruler.t, by2=oy+p.ruler.b;   // 标尺顶 = 最上重叠条顶，底 = 最下重叠条底
        ctx.strokeStyle='#fff';ctx.lineWidth=3;      // 尾杆白色包边（工字：顶横 + 竖杆 + 底横）
        ctx.beginPath();ctx.moveTo(cx,tipY-1);ctx.lineTo(cx,by2);ctx.stroke();
        ctx.beginPath();ctx.moveTo(cx-3.5,tipY);ctx.lineTo(cx+3.5,tipY);ctx.stroke();
        ctx.beginPath();ctx.moveTo(cx-3.5,by2);ctx.lineTo(cx+3.5,by2);ctx.stroke();
        ctx.strokeStyle=col2;ctx.lineWidth=1.6;
        ctx.beginPath();ctx.moveTo(cx,tipY-1);ctx.lineTo(cx,by2);ctx.stroke();
        ctx.beginPath();ctx.moveTo(cx-3.5,tipY);ctx.lineTo(cx+3.5,tipY);ctx.stroke();
        ctx.beginPath();ctx.moveTo(cx-3.5,by2);ctx.lineTo(cx+3.5,by2);ctx.stroke();
        tip=tipY-3;                                // 针尖止于标尺上方 3px 空隙
      }else tip=hy+9.8*s2;                         // 无重叠：针尖即标头下缘
      ctx.fillStyle=col2;ctx.strokeStyle='#fff';ctx.lineWidth=1.2;
      ctx.beginPath();
      ctx.moveTo(cx-R*0.7,hy+R*0.66);
      ctx.lineTo(cx,tip);
      ctx.lineTo(cx+R*0.7,hy+R*0.66);
      ctx.closePath();ctx.fill();ctx.stroke();
      ctx.beginPath();ctx.arc(cx,hy,R,0,7);ctx.fill();ctx.stroke();  // 圆头
      ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(cx,hy,R*0.4,0,7);ctx.fill();  // 白心
      ctx.fillStyle='#4e5969';
      if(Object.prototype.hasOwnProperty.call(p,'label')){
        if(p.label){ctx.font=(p.label.fontSize||10)+'px '+F;ctx.fillText(p.label.text,bx+p.label.x,oy+p.label.y+(p.label.height||14)/2)}
      }else{ctx.font='11px '+F;ctx.fillText(t.name+' '+fmtS(tD(t.s)),cx+R+7,hy+2)}

      if(cf.has(t.id)){ctx.font='700 12px '+F;ctx.fillStyle='#ff7d00';ctx.fillText('!',cx+R+3,hy-8)}
      return;
    }
    const x=bx+ScheduleBarGeometry.paintX(p),y=oy0(p),w=ScheduleBarGeometry.paintWidth(p),h=p.h,col=gc(t.grp);
    ctx.save();if(p.expanded)ctx.globalAlpha=.18;
    ctx.save();rr(ctx,x,y,w,h,5);ctx.clip();ctx.fillStyle=col;ctx.fillRect(x,y,w,h);
    const pc=isSum(t)?sumPct(t):Math.max(0,Math.min(100,Number(t.pct)||0));
    if(pc>0){ctx.fillStyle=barProgressCol(col);ctx.fillRect(x,y,w*pc/100,h)}

    ctx.font='11px '+F;
    const nm2=w>12?clip(t.name,w-12):'';
    if(nm2){ctx.fillStyle=barTextCol(col);ctx.fillText(nm2,x+6,y+h/2)}
    ctx.restore();
    if(crit.has(t.id)){ctx.strokeStyle='#f53f3f';ctx.lineWidth=2;rr(ctx,x-1,y-1,w+2,h+2,6);ctx.stroke();ctx.lineWidth=1}
    ctx.restore();
    if(cf.has(t.id)&&!isSum(t)){
      ctx.strokeStyle='#ff7d00';ctx.lineWidth=2;rr(ctx,x-2,y-2,w+4,h+4,6);ctx.stroke();ctx.lineWidth=1;
      ctx.font='700 12px '+F;ctx.fillStyle='#ff7d00';ctx.fillText('!',x+w+5,y-2);
    }

  }
  function oy0(p){return oy+p.y}
  // 依赖连线
  const vs=new Set(visible.map(v=>v.t.id));
  ctx.save();ctx.beginPath();ctx.rect(ox,oy,axE.tw,H-oy);ctx.clip();
  const pArrow=(fr,to,isC)=>{
    const route=ScheduleBarGeometry.connector(fr,to);
    ctx.beginPath();ctx.strokeStyle=isC?'#f53f3f':'#86909c';ctx.lineWidth=isC?2:1.3;
    ctx.setLineDash(route.kind==='adjacent-inline'?[]:(isC?[7,3]:[5,5]));ctx.lineCap='round';ctx.lineJoin='round';
    ScheduleBarGeometry.traceConnector(ctx,route,bx,oy);
    ctx.stroke();ctx.setLineDash([]);
    ctx.beginPath();ctx.fillStyle=isC?'#f53f3f':'#86909c';
    if(ScheduleBarGeometry.traceArrow(ctx,route,bx,oy))ctx.fill();
  };
  for(const{t}of visible){
    if(!t.deps||!t.deps.length)continue;const to=bPos[t.id];if(!to)continue;
    for(const dp of t.deps){if(!vs.has(dp))continue;const fr=bPos[dp];if(!fr)continue;
      pArrow(fr,to,isCriticalDep(dp,t.id));
    }
  }
  ctx.restore();
  // 顶部图例与主体合成；检查 Blob 实际生成后才报告成功。
  const out=document.createElement('canvas');out.width=W*scale;out.height=(H+lgH)*scale;
  const c2=out.getContext('2d');
  if(!c2){toast('无法创建图片画布，请重试或减少导出任务','warn');return}
  c2.scale(scale,scale);c2.fillStyle='#fff';c2.fillRect(0,0,W,H+lgH);
  if(lgH){
    c2.textBaseline='middle';c2.font='11px '+F;
    for(const s of legend){
      if(s.kind==='role'){
        c2.fillStyle=s.color;rr(c2,s.x,s.y-4.5,9,9,2);c2.fill();
        c2.fillStyle='#1d2129';c2.fillText(s.label,s.x+13,s.y);
      }else if(s.kind==='phase'){
        const w2=c2.measureText(s.label).width;c2.strokeStyle='#dcdfe6';rr(c2,s.x-1,s.y-8.5,w2+12,17,8.5);c2.stroke();
        c2.fillStyle='#1d2129';c2.fillText(s.label,s.x+5,s.y);
      }else{c2.fillStyle=s.kind==='filter'?'#c25400':'#4e5969';c2.fillText(s.label,s.x,s.y)}
    }
    c2.strokeStyle='#e8eaef';c2.beginPath();c2.moveTo(0,lgH-.5);c2.lineTo(W,lgH-.5);c2.stroke();
  }
  c2.drawImage(cv,0,0,cv.width,cv.height,0,lgH,W,H);
  out.toBlob(b=>{
    if(!b){toast('图片生成失败，请减少导出任务后重试','warn');return}
    let url;
    try{
      const a=ce('a');url=URL.createObjectURL(b);a.href=url;
      a.download='排期图_'+fD(T)+(filtered?'_已筛选':'')+'.png';a.click();
      setTimeout(()=>URL.revokeObjectURL(url),1500);
      toast('已导出 PNG 图片','success');
    }catch(e){if(url)URL.revokeObjectURL(url);toast('图片下载失败，请重试','warn')}
  });
  }catch(e){toast('图片导出失败，请减少任务或切换到周/月视图后重试','warn')}
}
// 圆角矩形路径
function rr(ctx,x,y,w,h,r){w=Math.max(0,w);h=Math.max(0,h);r=Math.max(0,Math.min(r,w/2,h/2));ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath()}
