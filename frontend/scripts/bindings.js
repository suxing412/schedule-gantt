function hideGanttTooltip(){const tip=$('#tooltip');if(tip)tip.classList.remove('show')}
function clearGanttHover(){
  hideGanttTooltip();
  // A middle-pan or scrollbar gesture keeps lane geometry frozen until release.
  if((typeof sbDrag!=='undefined'&&sbDrag)||(typeof dragging!=='undefined'&&dragging))return;
  // Re-render hover state through the layout model; selected chains may still
  // require these same expansion layers after the pointer leaves the canvas.
  clearLaneHover();
}

/* Native scrolling owns the pan gesture. Keep layout work off mousemove. */
function bindGanttPanScroll(rt,lb){
  let pan=null,scrollbar=null,scrollFrame=0,shrinkTimer=null,mirroredTop=lb.scrollTop,lastRightTop=rt.scrollTop,hoverExitPending=false;
  const pauseHover=()=>{
    hideGanttTooltip();
    if(typeof laneCloseTimers==='undefined')return;
    if(laneCloseTimers.size)hoverExitPending=true;
    for(const timer of laneCloseTimers.values())clearTimeout(timer);
    laneCloseTimers.clear();
  };
  const settleHover=()=>{if(hoverExitPending){hoverExitPending=false;clearGanttHover()}};
  rt.addEventListener('mouseleave',()=>{if(pan||scrollbar)hoverExitPending=true});
  const cancelMaintenance=()=>{
    if(scrollFrame){cancelAnimationFrame(scrollFrame);scrollFrame=0}
    clearTimeout(shrinkTimer);shrinkTimer=null;
  };
  const syncRows=()=>{
    if(Math.abs(lb.scrollTop-rt.scrollTop)>.5)lb.scrollTop=rt.scrollTop;
    mirroredTop=lb.scrollTop;lastRightTop=rt.scrollTop;
  };
  const refreshConnections=()=>{
    // The dependency bitmap scrolls with the bars; reuse its overscan until
    // the viewport leaves it. The renderer accounts for both axes and DPR.
    if(typeof depViewportCovered==='function'){
      if(!depViewportCovered())schDepDraw();
      return;
    }
    const cv=$('#dep-canvas');if(!cv)return;
    const left=Number.parseFloat(cv.style.left)||0,width=Number.parseFloat(cv.style.width)||cv.width||0;
    const visibleRight=Math.min(axis?axis.tw:Infinity,rt.scrollLeft+rt.clientWidth);
    if(!width||rt.scrollLeft<left||visibleRight>left+width)schDepDraw();
  };
  const settle=()=>{
    if(pan||scrollbar)return;
    maybeExtend();refreshConnections();
    clearTimeout(shrinkTimer);shrinkTimer=setTimeout(()=>{shrinkTimer=null;if(!pan&&!scrollbar)shrinkWindow()},250);
  };
  rt.addEventListener('scroll',()=>{
    syncRows();refreshConnections();
    if(pan||scrollbar)return;
    if(!scrollFrame)scrollFrame=requestAnimationFrame(()=>{scrollFrame=0;settle()});
  },{passive:true});
  lb.addEventListener('scroll',()=>{
    // Scroll events are asynchronous; compare the last mirrored position rather
    // than relying on a boolean that is already reset when the event arrives.
    // A zoom/layout change can queue a left-pane event before a newer explicit
    // right-pane scroll. Preserve that newer position even if its event is later.
    if(Math.abs(rt.scrollTop-lastRightTop)>.5){syncRows();return}
    if(Math.abs(lb.scrollTop-mirroredTop)<=.5)return;
    mirroredTop=lb.scrollTop;
    if(Math.abs(rt.scrollTop-lb.scrollTop)>.5)rt.scrollTop=lb.scrollTop;
    lastRightTop=rt.scrollTop;
  },{passive:true});
  const finishScrollbar=()=>{
    if(!scrollbar)return;
    document.removeEventListener('mouseup',scrollbarUp,true);window.removeEventListener('blur',finishScrollbar);
    scrollbar=null;sbDrag=false;settleHover();settle();
  };
  const scrollbarUp=e=>{if(e.button===0)finishScrollbar()};
  rt.addEventListener('mousedown',e=>{
    if(e.button!==0||pan||scrollbar)return;
    const r=rt.getBoundingClientRect();
    const point=typeof canvasClientPoint==='function'?canvasClientPoint(e,rt):{x:e.clientX-r.left-rt.clientLeft,y:e.clientY-r.top-rt.clientTop};
    if(point.x>=rt.clientWidth||point.y>=rt.clientHeight){
      cancelMaintenance();scrollbar=true;sbDrag=true;pauseHover();
      document.addEventListener('mouseup',scrollbarUp,true);window.addEventListener('blur',finishScrollbar);
    }
  },true);
  const finishPan=()=>{
    if(!pan)return;
    document.removeEventListener('mousemove',movePan,true);document.removeEventListener('mouseup',panUp,true);
    window.removeEventListener('blur',finishPan);
    rt.style.scrollBehavior=pan.rightBehavior;lb.style.scrollBehavior=pan.leftBehavior;
    pan=null;sbDrag=false;setDragCur(null);settleHover();syncRows();settle();
  };
  const movePan=e=>{
    if(!pan)return;
    if(typeof e.buttons==='number'&&!(e.buttons&4)){finishPan();return}
    e.preventDefault();
    const delta=typeof canvasClientDelta==='function'?canvasClientDelta:value=>value;
    const dx=delta(e.clientX-pan.x),dy=delta(e.clientY-pan.y);
    pan.x=e.clientX;pan.y=e.clientY;
    rt.scrollLeft-=dx;rt.scrollTop-=dy;
    syncRows();refreshConnections();
  };
  const panUp=e=>{if(e.button===1)finishPan()};
  rt.addEventListener('mousedown',e=>{
    if(e.button!==1||pan||scrollbar||(typeof dragging!=='undefined'&&dragging))return;
    e.preventDefault();cancelMaintenance();
    pan={x:e.clientX,y:e.clientY,rightBehavior:rt.style.scrollBehavior,leftBehavior:lb.style.scrollBehavior};
    rt.style.scrollBehavior='auto';lb.style.scrollBehavior='auto';sbDrag=true;setDragCur('drag-cursor');pauseHover();
    document.addEventListener('mousemove',movePan,true);document.addEventListener('mouseup',panUp,true);
    window.addEventListener('blur',finishPan);
  });
  rt.addEventListener('auxclick',e=>{if(e.button===1)e.preventDefault()});
}

/* Bind */
function bindUI(){
  bindFieldsUI();
  $('#btn-add-task').addEventListener('click',()=>addT(null,'task'));
  $('#btn-add-pipe').addEventListener('click',addPipeline);
  $('#btn-add-child').addEventListener('click',addChild);
  $('#btn-add-ms').addEventListener('click',()=>addT(selId||null,'milestone'));
  $('#btn-add-flag').addEventListener('click',()=>{const rt=$('#g-right');const day=bds.mn+Math.round((rt.scrollLeft+rt.clientWidth/2)/axis.dw);flagOpen(null,day)});
  $('#btn-del').addEventListener('click',delSel);
  $('#btn-today').addEventListener('click',goToday);
  $('#btn-png').addEventListener('click',capPNG);
  $('#btn-export').addEventListener('click',expJSON);
  $('#btn-import').addEventListener('click',impJSON);
  $('#btn-undo').addEventListener('click',undo);
  $('#btn-redo').addEventListener('click',redo);
  $('#btn-help').addEventListener('click',()=>openOvl($('#help-ovl')));
  $('#help-close').addEventListener('click',helpClose);
  $('#help-ovl').addEventListener('click',e=>{if(e.target.id==='help-ovl')helpClose()});
  // 里程碑旗弹窗
  $('#flag-close').addEventListener('click',flagClose);
  $('#fl-cancel').addEventListener('click',flagClose);
  $('#fl-save').addEventListener('click',flagSave);
  $('#fl-del').addEventListener('click',flagDel);
  $('#flag-ovl').addEventListener('click',e=>{if(e.target.id==='flag-ovl')flagClose()});
  $('#flag-ovl').addEventListener('keydown',e=>{if(e.key==='Enter'&&!isComposingKey(e)&&e.target.tagName!=='BUTTON'){e.preventDefault();flagSave()}});
  // 双击日期栏 = 在该日期插里程碑旗
  $('#tl-header').addEventListener('dblclick',e=>{
    if(e.target.closest('.flag'))return;
    const body=$('#tl-body');
    const x=typeof canvasClientPoint==='function'?canvasClientPoint(e,body).x:e.clientX-body.getBoundingClientRect().left;
    const day=Math.floor(x/axis.dw)+bds.mn;
    flagOpen(null,day);
  });
  const ds=$('#f-deps-search');
  ds.addEventListener('input',showDepSug);
  ds.addEventListener('focus',showDepSug);
  ds.addEventListener('blur',()=>setTimeout(hideDepSug,120));
  ds.addEventListener('keydown',e=>{
    if(isComposingKey(e))return;
    if(e.key==='Enter'){e.preventDefault();e.stopPropagation();const first=$('#dep-sug .dep-sug-item');if(first)first.dispatchEvent(new Event('mousedown'))}
    if(e.key==='Escape'&&!$('#dep-sug').hidden){e.stopPropagation();hideDepSug()}
  });
  const sq=$('#tb-search');let sqT=null;
  sq.addEventListener('input',()=>{clearTimeout(sqT);sqT=setTimeout(()=>{filterQ=sq.value.trim();render()},150)});
  sq.addEventListener('keydown',e=>{
    if(isComposingKey(e))return;
    e.stopPropagation();
    if(e.key==='Escape'){sq.value='';filterQ='';render();sq.blur()}
    if(e.key==='Enter')sq.blur();
  });
  $('#zoom-seg').addEventListener('click',e=>{
    const b=e.target.closest('.seg-btn');if(!b)return;
    zoomTimeline(b.dataset.z);
    document.querySelectorAll('#zoom-seg .seg-btn').forEach(x=>{x.classList.toggle('active',x.dataset.z===zoom);x.setAttribute('aria-pressed',x.dataset.z===zoom?'true':'false')});
  });
  $('#dlg-close').addEventListener('click',edClose);$('#dlg-cancel').addEventListener('click',edClose);$('#dlg-save').addEventListener('click',edSave);
  $('#f-type').addEventListener('change',applyTypeVis);$('#f-progress').addEventListener('input',e=>{$('#f-pctv').textContent=e.target.value});
  $('#ovl').addEventListener('click',e=>{if(e.target.id==='ovl')edClose()});
  document.addEventListener('keydown',e=>{
    if(isComposingKey(e))return;
    if(e.key==='Escape'){
      if(!$('#ovl').hidden)edClose();
      else if(!$('#flag-ovl').hidden)flagClose();
      else if(!$('#fields-ovl').hidden)fieldsClose();
      else if(!$('#set-ovl').hidden)setClose();
      else if(!$('#help-ovl').hidden)helpClose();
      else if(selIds.size>1)sel(selId);          // 多选态先收回单选
      else if(filterQ||filterGrp||filterPhase){$('#tb-search').value='';filterQ='';filterGrp=null;filterPhase=null;render()}
      return;
    }
    if(anyOvlOpen()||dragging)return;
    const tag=(e.target.tagName||'').toLowerCase();
    if(tag==='input'||tag==='textarea'||tag==='select'||e.target.isContentEditable)return;
    if(e.ctrlKey&&!e.shiftKey&&e.key.toLowerCase()==='z'){e.preventDefault();undo();return}
    if(e.ctrlKey&&(e.key.toLowerCase()==='y'||(e.shiftKey&&e.key.toLowerCase()==='z'))){e.preventDefault();redo();return}
    if(e.ctrlKey&&e.key.toLowerCase()==='f'){e.preventDefault();$('#tb-search').focus();return}
    // Native controls keep their own activation and menu navigation when a row is selected.
    if(tag==='button'||tag==='a'||e.target.closest?.('button,a'))return;
    if($('#ovl').hidden){
      if(e.key==='ArrowUp'){e.preventDefault();selStep(-1,e.shiftKey);return}
      if(e.key==='ArrowDown'){e.preventDefault();selStep(1,e.shiftKey);return}
      if(selId){
        if(e.key==='Delete'){e.preventDefault();delSel();return}
        if(e.key==='Enter'){e.preventDefault();edOpen(selId);return}
        if(e.key==='ArrowLeft'){e.preventDefault();nudgeSel(e.shiftKey?-7:-1);return}
        if(e.key==='ArrowRight'){e.preventDefault();nudgeSel(e.shiftKey?7:1);return}
      }
    }
  });
  // 弹窗焦点圈闭（三个弹窗统一）
  const trapFocus=ovl=>ovl.addEventListener('keydown',e=>{
    if(e.key!=='Tab')return;
    const list=Array.from(ovl.querySelectorAll('button,input,select,textarea')).filter(x=>!x.disabled&&x.offsetParent!==null);
    if(!list.length)return;
    const first=list[0],last=list[list.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
  });
  trapFocus($('#ovl'));trapFocus($('#flag-ovl'));trapFocus($('#fields-ovl'));trapFocus($('#help-ovl'));trapFocus($('#set-ovl'));
  // 设置页面
  $('#btn-settings').addEventListener('click',setOpen);
  $('#set-close').addEventListener('click',setClose);
  $('#set-done').addEventListener('click',setClose);
  $('#set-ovl').addEventListener('click',e=>{if(e.target.id==='set-ovl')setClose()});
  $('#set-role-add').addEventListener('click',()=>{
    if(!mayEditProject('添加职能'))return;
    let i=1,nm='新职能';while(proj.groups.some(g=>g.name===nm))nm='新职能'+(++i);
    if(['constructor','prototype','__proto__'].includes(nm)){toast('该名称不能作为职能名称，请换一个名称','warn');return}
    proj.groups.push({name:nm,color:'#6b7280'});
    render();schSave();renderSettings();
  });
  $('#set-defview').addEventListener('change',e=>{proj.meta.defView=e.target.value;schSave();toast('已设置启动默认视图：'+({day:'日',week:'周',month:'月'}[e.target.value]),'info')});
  // 编辑弹窗：Enter 保存
  $('#ovl').addEventListener('keydown',e=>{
    if(e.key==='Enter'&&!isComposingKey(e)){
      const tg=e.target;
      if(tg.id==='f-deps-search'||tg.tagName==='BUTTON'||tg.tagName==='TEXTAREA')return;
      e.preventDefault();edSave();
    }
  });
  const lb=$('#g-left-body'),rt=$('#g-right');
  bindGanttPanScroll(rt,lb);
  // 光标离开图表/列表区域：收起 tooltip 与流程悬停展开层，杜绝残留
  rt.addEventListener('mouseleave',clearGanttHover);
  lb.addEventListener('mouseleave',hideGanttTooltip);
  bindSp();bindWh(rt);bindCtxMenu();bindColRz();
  bindDblEmpty($('#tl-body'));   // 只绑一次（原先每次渲染重复叠加监听器）
  let rz=null;window.addEventListener('resize',()=>{clearTimeout(rz);rz=setTimeout(()=>{if(dragging)return;applyPaneLayout();renderBody(vRows());ensureFill();applyColWidths()},120)});
  $('#import-file').addEventListener('change',function(){const f=this.files[0];this.value='';if(!f||!mayEditProject('导入排期'))return;const r=new FileReader();r.onload=()=>{if(!mayEditProject('导入排期'))return;try{const d=JSON.parse(r.result);if(applyProject(d)){selId=null;selIds=new Set();filterQ='';filterGrp=null;filterPhase=null;$('#tb-search').value='';render();schSave();toast('已导入 · 原数据可 Ctrl+Z 恢复','info',3600)}else toast('导入失败：文件里没有任务数据（需要本工具导出的 JSON）','warn',3600)}catch(e){toast('导入失败：JSON 解析出错，请确认文件未被修改','warn',3600)}};r.readAsText(f)});
}
function flash(t){toast(t,'success')}
function goToday(){const T=todayD(),x=(T-bds.mn)*axis.dw;$('#g-right').scrollLeft=Math.max(0,x-$('#g-right').clientWidth/2)}
