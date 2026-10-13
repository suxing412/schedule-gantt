/* Column widths and the table/timeline pane are independent layout state. */
const tableLayoutState={extent:0,lastScrollLeft:0,columnDrag:null,paneDrag:null,observer:null};
function colW(){
  const saved=proj.meta.cols||{},widths={...saved};
  for(const column of allTableColumns()){
    const legacyDate=proj.meta.layoutVersion!==2&&Number.isFinite(saved.date)&&['start','end'].includes(column.id)?saved.date:column.width;
    const value=Number.isFinite(saved[column.id])?saved[column.id]:legacyDate;
    widths[column.id]=Math.max(column.min,Math.min(column.max,value));
  }
  return widths;
}
function columnScreenToLayout(value){return typeof canvasClientDelta==='function'?canvasClientDelta(value):value}
function allTableColumns(){
  const columns=[
    {id:'name',name:'名称',type:'text',builtin:true,width:248,min:120,max:1000},
    {id:'person',name:'负责人',type:'text',builtin:true,width:88,min:60,max:320},
    {id:'start',name:'开始',type:'date',builtin:true,width:88,min:60,max:240},
    {id:'end',name:'结束',type:'date',builtin:true,width:88,min:60,max:240},
    {id:'pct',name:'进度',type:'number',builtin:true,width:64,min:44,max:160},
    {id:'grp',name:'职能',type:'text',builtin:true,width:96,min:72,max:320},
    {id:'phase',name:'阶段',type:'text',builtin:true,width:112,min:72,max:400}
  ];
  const sizes={text:[120,72,600],number:[88,64,240],date:[104,72,240],select:[120,72,320],checkbox:[64,56,120]};
  for(const field of proj.meta.customFields||[]){
    const size=sizes[field.type]||sizes.text;
    columns.push({...field,builtin:false,width:size[0],min:size[1],max:size[2]});
  }
  const byId=new Map(columns.map(column=>[column.id,column]));
  const order=new Set(['name',...(proj.meta.columnOrder||[]),...columns.map(column=>column.id)]);
  return [...order].map(id=>byId.get(id)).filter(Boolean);
}
function columnResizeBounds(column){return {min:column.min,max:column.max}}
function fittedColWidths(base){return {...base}}
function visibleTableColumns(){
  const hidden=new Set(proj.meta.hiddenColumns===undefined?['grp','phase']:proj.meta.hiddenColumns);
  return allTableColumns().filter(column=>column.id==='name'||!hidden.has(column.id));
}
function taskCellText(t,column){
  if(column.builtin){
    switch(column.id){
      case 'name':return t.name;
      case 'person':return t.who||'—';
      case 'grp':return t.type==='pipeline'?'—':t.grp||'—';
      case 'phase':return t.phase||'—';
      case 'start':case 'end':{
        if(t.type==='pipeline'||column.id==='end'&&t.type==='milestone')return '—';
        const range=isSum(t)?eRange(t):{s:tD(t.s),e:tD(t.e)};
        return fmtS(column.id==='start'?range.s:range.e);
      }
      case 'pct':return t.type==='milestone'?'—':(isSum(t)?sumPct(t):t.pct||0)+'%';
    }
  }
  const value=(t.customValues||{})[column.id];
  if(column.type==='checkbox')return value?'✓':'□';
  if(value===undefined||value===null||value==='')return '—';
  if(column.type==='select')return (column.options||[]).find(option=>option.id===value)?.label||'—';
  if(column.type==='date')return fmtS(tD(value));
  return String(value);
}
function rememberTableExtent(viewportWidth){
  const body=$('#g-left-body'),scroll=body?.scrollLeft||0;
  if(scroll>0){
    tableLayoutState.extent=Math.max(tableLayoutState.extent,(viewportWidth??body.clientWidth)+scroll);
    // Publish the retained scroll range before a pane width write can force layout.
    const widths=colW(),total=visibleTableColumns().reduce((sum,column)=>sum+widths[column.id],0);
    document.documentElement.style.setProperty('--table-extent',Math.max(total,tableLayoutState.extent)+'px');
  }
  tableLayoutState.lastScrollLeft=scroll;
}
function syncLeftColumns(){
  const header=$('#g-left-hd'),body=$('#g-left-body');
  if(!header||!body)return;
  const scrollbar=Math.max(0,(body.offsetWidth||0)-(body.clientWidth||0));
  document.documentElement.style.setProperty('--left-scrollbar',scrollbar+'px');
  header.scrollLeft=body.scrollLeft||0;
  $('#g-left')?.classList?.toggle('has-horizontal-scroll',(body.scrollLeft||0)>0);
}
function applyColWidths(previewWidths){
  const widths=fittedColWidths(previewWidths||colW()),columns=visibleTableColumns(),style=document.documentElement.style;
  const body=$('#g-left-body'),left=$('#g-left'),viewport=body?.clientWidth||0;
  const total=columns.reduce((sum,column)=>sum+widths[column.id],0);
  for(const [key,width]of Object.entries(widths))style.setProperty('--col-'+key,width+'px');
  style.setProperty('--table-w',total+'px');
  style.setProperty('--table-extent',Math.max(total,tableLayoutState.extent)+'px');
  if(!tableLayoutState.columnDrag){
    // Re-pin only at the left edge, where switching positioning cannot move text.
    const keepUnpinned=left?.classList?.contains?.('unpin-name')&&(body?.scrollLeft||0)>0;
    left?.classList?.toggle('unpin-name',viewport>0&&(viewport<widths.name+96||keepUnpinned));
  }
  const definitions=new Map(columns.map(column=>[column.id,column]));
  for(const handle of $('#g-left-hd')?.querySelectorAll?.('.col-rz')||[]){
    const column=definitions.get(handle.dataset.col);if(!column)continue;
    handle.setAttribute('aria-valuemax',String(column.max));
    handle.setAttribute('aria-valuenow',String(widths[column.id]));
    handle.setAttribute('aria-valuetext',widths[column.id]+' 像素');
  }
  syncLeftColumns();
}
function renderTableHeader(){
  const header=$('#g-left-hd');header.innerHTML='';
  const row=ce('div','g-left-cols');
  for(const column of visibleTableColumns()){
    const cell=ce('div','col '+(column.builtin?'col-'+column.id+(column.type==='date'?' col-date':''):'col-custom'));
    cell.dataset.col=column.id;
    if(!column.builtin)cell.style.width='var(--col-'+column.id+')';
    cell.appendChild(ce('span','col-title',column.name));
    const handle=ce('span','col-rz');handle.dataset.col=column.id;handle.tabIndex=0;
    handle.title='拖动调整'+column.name+'列宽；双击适应内容';
    handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');
    handle.setAttribute('aria-label','调整'+column.name+'列宽');
    handle.setAttribute('aria-valuemin',String(column.min));handle.setAttribute('aria-valuemax',String(column.max));
    cell.appendChild(handle);row.appendChild(cell);
  }
  header.appendChild(row);applyColWidths();bindColRz();
}
function setColumnWidth(id,width){
  const column=allTableColumns().find(item=>item.id===id);
  if(!column||!Number.isFinite(width))return false;
  const widths=colW(),bounds=columnResizeBounds(column);
  const next=Math.max(bounds.min,Math.min(bounds.max,Math.ceil(width)));
  if(widths[id]===next&&proj.meta.nameAutoWidth===false)return false;
  rememberTableExtent();
  proj.meta.cols={...widths,[id]:next};
  proj.meta.nameAutoWidth=false;
  applyColWidths();schSave();return true;
}
function resetColumnWidths(){
  const defaults=Object.fromEntries(allTableColumns().map(column=>[column.id,column.width]));
  const saved=proj.meta.cols||{};
  const changed=proj.meta.nameAutoWidth!==false||Object.keys(saved).length!==Object.keys(defaults).length||Object.entries(defaults).some(([id,width])=>saved[id]!==width);
  if(!changed)return false;
  rememberTableExtent();proj.meta.cols=defaults;proj.meta.nameAutoWidth=false;
  applyColWidths();schSave();return true;
}
function fitColumnToContent(id){
  const column=visibleTableColumns().find(item=>item.id===id);
  if(!column)return false;
  const context=document.createElement('canvas').getContext('2d');
  if(!context)return false;
  const measureText=(element,text)=>{
    const style=getComputedStyle(element);context.font=style.font;
    // Table cells use nowrap: multiline notes display as a single collapsed line.
    const label=String(text).replace(/[\t\n\r\f ]+/g,' ').replace(/^ | $/g,'');
    return context.measureText(label).width+(parseFloat(style.letterSpacing)||0)*label.length;
  };
  const padding=element=>{const s=getComputedStyle(element);return (parseFloat(s.paddingLeft)||0)+(parseFloat(s.paddingRight)||0)};
  const header=Array.from($('#g-left-hd').querySelectorAll('.col')).find(cell=>cell.dataset.col===id);
  let width=header?measureText(header,column.name)+padding(header)+10:column.min;
  for(const row of $('#g-left-body').querySelectorAll('.t-row')){
    const cell=Array.from(row.children).find(item=>item.dataset.col===id);
    if(!cell)continue;
    let content=0;
    if(id==='name'){
      const children=Array.from(cell.children).filter(child=>getComputedStyle(child).display!=='none');
      content=children.reduce((sum,child)=>{
        const style=getComputedStyle(child);
        const w=child.classList.contains('t-name')?measureText(child,child.textContent):columnScreenToLayout(child.getBoundingClientRect().width);
        return sum+w+(parseFloat(style.marginLeft)||0)+(parseFloat(style.marginRight)||0);
      },0)+Math.max(0,children.length-1)*(parseFloat(getComputedStyle(cell).columnGap)||0);
    }else content=measureText(cell,cell.textContent);
    width=Math.max(width,content+padding(cell)+2);
  }
  return setColumnWidth(id,width);
}
function bindColRz(){
  const body=$('#g-left-body');
  if(body&&!body._columnScrollBound){
    body.addEventListener('scroll',()=>{
      const scroll=body.scrollLeft||0;
      const repin=!dragging&&scroll===0&&tableLayoutState.lastScrollLeft>0&&$('#g-left').classList.contains('unpin-name');
      // Only a deliberate move back to the left reclaims preserved tail space.
      if(!dragging&&scroll<tableLayoutState.lastScrollLeft&&tableLayoutState.extent>0){
        const widths=colW(),total=visibleTableColumns().reduce((sum,column)=>sum+widths[column.id],0);
        tableLayoutState.extent=scroll<=0?0:Math.min(tableLayoutState.extent,Math.max(total,body.clientWidth+scroll));
        applyColWidths();
      }else if(repin)applyColWidths();
      tableLayoutState.lastScrollLeft=scroll;syncLeftColumns();
    });
    body._columnScrollBound=true;
  }
  document.querySelectorAll('.col-rz').forEach(handle=>{
    if(handle._resizeBound)return;handle._resizeBound=true;
    handle.addEventListener('pointerdown',event=>{
      if(event.button!==0||dragging||anyOvlOpen())return;
      event.preventDefault();event.stopPropagation();
      const key=handle.dataset.col,column=allTableColumns().find(item=>item.id===key);
      if(!column)return;
      const baseline=colW(),startX=event.clientX;
      const startWidth=columnScreenToLayout(handle.parentElement.getBoundingClientRect().width),scroll=body.scrollLeft||0;
      const originalExtent=tableLayoutState.extent,bounds=columnResizeBounds(column);
      const pinned=key==='name'&&!$('#g-left').classList.contains('unpin-name');
      const wasDragging=dragging;dragging=true;setDragCur('drag-col');handle.classList.add('active');
      tableLayoutState.columnDrag=handle;rememberTableExtent();
      let finished=false,frame=0,pointerX=startX,draftWidth=startWidth;
      const flush=()=>{
        frame=0;if(finished)return;
        const scrollDelta=pinned?0:(body.scrollLeft||0)-scroll;
        const width=Math.max(bounds.min,Math.min(bounds.max,Math.round(startWidth+columnScreenToLayout(pointerX-startX)+scrollDelta)));
        if(width===draftWidth)return;
        draftWidth=width;applyColWidths({...baseline,[key]:width});
      };
      const move=next=>{
        if(next.pointerId!==event.pointerId)return;
        pointerX=next.clientX;
        if(!frame)frame=requestAnimationFrame(flush);
      };
      const end=commit=>{
        if(finished)return;
        if(frame){cancelAnimationFrame(frame);frame=0;}
        if(commit)flush();
        finished=true;
        document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);
        document.removeEventListener('pointercancel',cancel);document.removeEventListener('keydown',keyDown,true);
        window.removeEventListener('blur',cancel);handle.removeEventListener('lostpointercapture',cancel);
        if(handle.hasPointerCapture?.(event.pointerId))handle.releasePointerCapture(event.pointerId);
        handle.classList.remove('active');tableLayoutState.columnDrag=null;dragging=wasDragging;setDragCur(null);
        if(commit&&draftWidth!==startWidth){
          if(pinned&&body.clientWidth<draftWidth+96&&(body.scrollLeft||0)>0){
            body.scrollLeft=0;tableLayoutState.lastScrollLeft=0;tableLayoutState.extent=0;
          }
          setColumnWidth(key,draftWidth);
        }
        else{
          tableLayoutState.extent=originalExtent;applyColWidths();
          body.scrollLeft=scroll;tableLayoutState.lastScrollLeft=scroll;syncLeftColumns();
        }
      };
      const up=next=>{if(next.pointerId!==event.pointerId)return;if(Number.isFinite(next.clientX))pointerX=next.clientX;end(true)};
      const cancel=next=>{if(next?.pointerId!==undefined&&next.pointerId!==event.pointerId)return;end(false)};
      const keyDown=next=>{if(next.key==='Escape'){next.preventDefault();next.stopPropagation();end(false)}};
      document.addEventListener('pointermove',move);document.addEventListener('pointerup',up);
      document.addEventListener('pointercancel',cancel);document.addEventListener('keydown',keyDown,true);
      window.addEventListener('blur',cancel);handle.addEventListener('lostpointercapture',cancel);
      handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener('dblclick',event=>{
      if(anyOvlOpen()||dragging)return;
      event.preventDefault();event.stopPropagation();fitColumnToContent(handle.dataset.col);
    });
    handle.addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||anyOvlOpen()||dragging)return;
      event.preventDefault();event.stopPropagation();
      const key=handle.dataset.col,column=allTableColumns().find(item=>item.id===key),bounds=columnResizeBounds(column);
      const current=columnScreenToLayout(handle.parentElement.getBoundingClientRect().width),delta=(event.shiftKey?32:8)*(event.key==='ArrowLeft'?-1:1);
      const next=event.key==='Home'?bounds.min:event.key==='End'?bounds.max:Math.max(bounds.min,Math.min(bounds.max,current+delta));
      if(next!==current)setColumnWidth(key,next);
    });
  });
}

function paneBounds(){
  const gantt=$('#gantt'),width=Math.max(0,gantt?.clientWidth||columnScreenToLayout(gantt?.getBoundingClientRect?.().width||0));
  if(!width)return {width:0,min:0,max:0,defaultWidth:0};
  const compact=width<=800;
  const min=compact?Math.min(240,width*.48):280;
  const timelineMin=compact?Math.min(240,width*.45):Math.max(280,width*.35);
  const max=Math.min(1200,Math.max(min,width-1-timelineMin));
  const target=Math.max(min,Math.min(max,Math.min(576,width*.4)));
  // Align the initial layout to default columns without coupling the pane to edited columns.
  const defaults=new Map(allTableColumns().map(column=>[column.id,column.width]));let edge=0;
  const edges=['name','person','start','end','pct'].map(id=>(edge+=defaults.get(id))).filter(value=>value>=min&&value<=Math.min(max,576));
  const defaultWidth=edges.length?edges.reduce((best,value)=>Math.abs(value-target)<Math.abs(best-target)?value:best,edges[0]):target;
  return {width,min,max,defaultWidth};
}
function renderPaneWidth(width,{retainExtent=true}={}){
  const body=$('#g-left-body'),scroll=body?.scrollLeft||0;
  if(retainExtent)rememberTableExtent(width);
  document.documentElement.style.setProperty('--left-w',width+'px');
  applyColWidths();
  if(body&&scroll>0){body.scrollLeft=scroll;syncLeftColumns();}
  const splitter=$('#splitter'),bounds=paneBounds();
  splitter?.setAttribute('aria-valuemin',String(Math.round(bounds.min)));
  splitter?.setAttribute('aria-valuemax',String(Math.round(bounds.max)));
  splitter?.setAttribute('aria-valuenow',String(Math.round(width)));
  splitter?.setAttribute('aria-valuetext',Math.round(width)+' 像素');
  return width;
}
function applyPaneLayout(options){
  if(tableLayoutState.paneDrag)return false;
  const bounds=paneBounds();if(!bounds.width)return false;
  const preferred=proj.meta.paneAuto!==false||!Number.isFinite(proj.meta.lw)||proj.meta.lw<=0?bounds.defaultWidth:proj.meta.lw;
  return renderPaneWidth(Math.max(bounds.min,Math.min(bounds.max,preferred)),options);
}
function setPaneWidth(width){
  if(!Number.isFinite(width))return false;
  const bounds=paneBounds();if(!bounds.width)return false;
  const next=Math.max(bounds.min,Math.min(bounds.max,width));
  renderPaneWidth(next);
  if(proj.meta.paneAuto===false&&proj.meta.lw===next)return false;
  proj.meta.lw=next;proj.meta.paneAuto=false;schSave();return true;
}
function resetPaneLayout(){
  const changed=proj.meta.paneAuto===false;
  proj.meta.paneAuto=true;applyPaneLayout();
  if(changed)schSave();
  return changed;
}
function bindSp(){
  const sp=$('#splitter');
  if(!sp||sp._paneResizeBound)return;sp._paneResizeBound=true;
  sp.addEventListener('pointerdown',event=>{
    if(event.button!==0||dragging||anyOvlOpen())return;
    event.preventDefault();event.stopPropagation();
    const startX=event.clientX,startWidth=columnScreenToLayout($('#g-left').getBoundingClientRect().width);
    const body=$('#g-left-body'),scroll=body.scrollLeft||0,originalExtent=tableLayoutState.extent;
    const wasDragging=dragging;dragging=true;tableLayoutState.paneDrag=sp;setDragCur('drag-col');sp.classList.add('active');
    let pointerX=startX,draftWidth=startWidth,frame=0,finished=false;
    const flush=()=>{
      frame=0;if(finished)return;
      const bounds=paneBounds();
      const width=Math.max(bounds.min,Math.min(bounds.max,startWidth+columnScreenToLayout(pointerX-startX)));
      if(width===draftWidth)return;
      draftWidth=width;renderPaneWidth(width);
    };
    const move=next=>{
      if(next.pointerId!==event.pointerId)return;
      pointerX=next.clientX;
      if(!frame)frame=requestAnimationFrame(flush);
    };
    const end=commit=>{
      if(finished)return;
      if(frame){cancelAnimationFrame(frame);frame=0;}
      if(commit)flush();
      finished=true;
      document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);
      document.removeEventListener('pointercancel',cancel);document.removeEventListener('keydown',keyDown,true);
      window.removeEventListener('blur',cancel);sp.removeEventListener('lostpointercapture',cancel);
      if(sp.hasPointerCapture?.(event.pointerId))sp.releasePointerCapture(event.pointerId);
      tableLayoutState.paneDrag=null;dragging=wasDragging;sp.classList.remove('active');setDragCur(null);
      if(commit&&draftWidth!==startWidth)setPaneWidth(draftWidth);
      else{
        // Rollback must not treat the draft scroll position as a new tail-space request.
        body.scrollLeft=scroll;tableLayoutState.lastScrollLeft=scroll;
        tableLayoutState.extent=originalExtent;renderPaneWidth(startWidth,{retainExtent:false});
        body.scrollLeft=scroll;tableLayoutState.lastScrollLeft=scroll;syncLeftColumns();
      }
      if(typeof ensureFill==='function')ensureFill();
    };
    const up=next=>{if(next.pointerId!==event.pointerId)return;if(Number.isFinite(next.clientX))pointerX=next.clientX;end(true)};
    const cancel=next=>{if(next?.pointerId!==undefined&&next.pointerId!==event.pointerId)return;end(false)};
    const keyDown=next=>{if(next.key==='Escape'){next.preventDefault();next.stopPropagation();end(false)}};
    document.addEventListener('pointermove',move);document.addEventListener('pointerup',up);
    document.addEventListener('pointercancel',cancel);document.addEventListener('keydown',keyDown,true);
    window.addEventListener('blur',cancel);sp.addEventListener('lostpointercapture',cancel);
    sp.setPointerCapture?.(event.pointerId);
  });
  sp.addEventListener('dblclick',event=>{
    if(anyOvlOpen()||dragging)return;
    event.preventDefault();resetPaneLayout();
  });
  sp.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||anyOvlOpen()||dragging)return;
    event.preventDefault();event.stopPropagation();
    const bounds=paneBounds(),current=columnScreenToLayout($('#g-left').getBoundingClientRect().width);
    const next=event.key==='Home'?bounds.min:event.key==='End'?bounds.max:current+(event.key==='ArrowLeft'?-1:1)*(event.shiftKey?32:8);
    setPaneWidth(next);
  });
  if(typeof ResizeObserver!=='undefined'&&!tableLayoutState.observer){
    tableLayoutState.observer=new ResizeObserver(()=>{
      if(dragging)return;
      applyPaneLayout();
      if(typeof ensureFill==='function')ensureFill();
    });
    tableLayoutState.observer.observe($('#gantt'));
  }
  applyPaneLayout();
}
function bindWh(rt){
  const reset=$('#canvas-scale-reset');
  if(reset&&!reset._canvasScaleResetBound){reset._canvasScaleResetBound=true;reset.addEventListener('click',()=>setCanvasScale(1))}
  if(rt._timelineWheelBound)return;rt._timelineWheelBound=true;
  rt.addEventListener('wheel',e=>{
    if(e.altKey&&!e.shiftKey){e.preventDefault();queueTimelineWheelZoom(e,rt);return}
    if(e.shiftKey&&e.deltaY!==0){
      const unit=e.deltaMode===1?16:e.deltaMode===2?(rt.clientHeight||600)*(typeof canvasScaleFactor==='function'?canvasScaleFactor():1):1;
      rt.scrollLeft+=columnScreenToLayout(e.deltaY*unit);e.preventDefault();
    }
  },{passive:false});
}
