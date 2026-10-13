/* Owner emphasis and explicit dependency tracing are page-local visual state. */
(function(root){
  'use strict';
  const edgeKey=(from,to)=>JSON.stringify([from,to]);
  function buildIndex(tasks,graph){
    const ids=new Set(tasks.filter(t=>t.type!=='pipeline').map(t=>t.id));
    const upstream=new Map(),downstream=new Map(),seen=new Set();
    for(const edge of graph.edges||[]){
      const dep=edge.dep;if(!dep||!ids.has(dep.from)||!ids.has(dep.to))continue;
      const key=edgeKey(dep.from,dep.to);if(seen.has(key))continue;seen.add(key);
      if(!upstream.has(dep.to))upstream.set(dep.to,[]);
      if(!downstream.has(dep.from))downstream.set(dep.from,[]);
      upstream.get(dep.to).push(dep.from);downstream.get(dep.from).push(dep.to);
    }
    return{ids,upstream,downstream};
  }
  function traceIndex(index,id){
    if(!index.ids.has(id))return{id,taskIds:[],upstreamIds:[],downstreamIds:[],edges:[]};
    const edgeMap=new Map();
    // Walk the two directions independently. An ancestor's other children are not downstream of id.
    const walk=(adj,reverse)=>{
      const visited=new Set([id]),queue=[id];
      for(let i=0;i<queue.length;i++)for(const next of adj.get(queue[i])||[]){
        const from=reverse?next:queue[i],to=reverse?queue[i]:next;
        edgeMap.set(edgeKey(from,to),{from,to});
        if(!visited.has(next)){visited.add(next);queue.push(next)}
      }
      visited.delete(id);return visited;
    };
    const upstream=walk(index.upstream,true),downstream=walk(index.downstream,false);
    return{id,taskIds:[id,...new Set([...upstream,...downstream])],upstreamIds:[...upstream],downstreamIds:[...downstream],edges:[...edgeMap.values()]};
  }
  function createController(env){
    const doc=env.document;
    let owner=null,selectedTaskId=null,tasksById=new Map(),owners=[],fingerprint=null,index=null,initialized=false;
    let activeTrace=null,activeIds=new Set(),activeEdges=new Set(),controls=null,bound=false,press=null,dragged=false;
    const traceCache=new Map();
    const taskSelector='#g-left-body .t-row[data-id],#b-layer [data-id],#b-layer [data-for]';
    const ownerOf=t=>typeof t.who==='string'?t.who.trim():'';
    function sync(){
      const project=env.getProject(),tasks=project&&Array.isArray(project.tasks)?project.tasks:[];
      tasksById=new Map(tasks.map(t=>[t.id,t]));
      owners=[...new Set(tasks.map(ownerOf).filter(Boolean))];
      const next=JSON.stringify(tasks.map(t=>[t.id,t.type,t.deps||[]]));
      const changed=next!==fingerprint;fingerprint=next;
      if(changed){index=null;traceCache.clear()}
      if(owner&&!owners.includes(owner))owner=null;
      if(selectedTaskId&&(!tasksById.has(selectedTaskId)||tasksById.get(selectedTaskId).type==='pipeline'))selectedTaskId=null;
      initialized=true;
      refreshTrace();
      return changed;
    }
    function ensure(){if(!initialized)sync()}
    function getTrace(id){
      if(!index)index=buildIndex([...tasksById.values()],env.buildGraph([...tasksById.values()]));
      if(traceCache.has(id)){const hit=traceCache.get(id);traceCache.delete(id);traceCache.set(id,hit);return hit}
      const value=traceIndex(index,id);traceCache.set(id,value);
      // Bound memory: a 10k-task chain must not retain a 10k-entry transitive closure for every task.
      if(traceCache.size>8)traceCache.delete(traceCache.keys().next().value);
      return value;
    }
    function refreshTrace(){
      activeTrace=selectedTaskId?getTrace(selectedTaskId):null;
      activeIds=new Set(activeTrace?activeTrace.taskIds:[]);
      activeEdges=new Set(activeTrace?activeTrace.edges.map(e=>edgeKey(e.from,e.to)):[]);
    }
    function state(){
      ensure();
      // hovered is retained as a compatibility alias for older browser tool clients.
      return{owner,selectedTaskId,hovered:selectedTaskId,taskIds:activeTrace?activeTrace.taskIds.slice():[],upstreamIds:activeTrace?activeTrace.upstreamIds.slice():[],downstreamIds:activeTrace?activeTrace.downstreamIds.slice():[]};
    }
    function paint(){
      if(doc)for(const node of doc.querySelectorAll(taskSelector)){
        const id=node.dataset.id||node.dataset.for,t=tasksById.get(id);
        const own=Boolean(owner&&t&&ownerOf(t)===owner),chain=Boolean(selectedTaskId&&activeIds.has(id));
        node.classList.toggle('hl-owner-match',own);
        node.classList.toggle('hl-owner-dim',Boolean(owner&&!own));
        node.classList.toggle('hl-chain-match',chain);
        node.classList.toggle('hl-chain-dim',Boolean(selectedTaskId&&!chain));
        node.classList.toggle('hl-chain-root',Boolean(selectedTaskId&&selectedTaskId===id));
      }
      if(controls){
        controls.select.value=owner||'';controls.clear.hidden=!owner;
        controls.wrap.classList.toggle('is-active',Boolean(owner));
        controls.status.textContent=selectedTaskId?'依赖链 '+activeIds.size+' 项 ×':'';
        controls.status.disabled=!selectedTaskId;
        controls.status.setAttribute('aria-label',selectedTaskId?'清除依赖链高亮（'+activeIds.size+' 项任务）':'清除依赖链高亮');
      }
    }
    function redraw(){if(env.redrawEdges)env.redrawEdges()}
    function setOwner(value){
      ensure();const next=value==null?null:(String(value).trim()||null);
      if(next&&!owners.includes(next))throw new RangeError('负责人不存在');
      owner=next;paint();return state();
    }
    function setSelected(value){
      ensure();let next=value==null||value===''?null:String(value);
      if(next&&!tasksById.has(next))throw new RangeError('任务不存在');
      if(next&&tasksById.get(next).type==='pipeline')next=null;
      if(selectedTaskId===next)return state();
      selectedTaskId=next;refreshTrace();paint();redraw();return state();
    }
    function clear(){owner=null;setSelected(null);paint();return state()}
    function trace(id){
      ensure();if(!tasksById.has(id))throw new RangeError('任务不存在');
      const result=getTrace(id);
      return{id:result.id,taskIds:result.taskIds.slice(),upstreamIds:result.upstreamIds.slice(),downstreamIds:result.downstreamIds.slice(),edges:result.edges.map(e=>({...e}))};
    }
    function edgeState(from,to){
      if(!selectedTaskId)return{highlighted:false,opacity:1};
      const highlighted=activeEdges.has(edgeKey(from,to));return{highlighted,opacity:highlighted?1:.16};
    }
    function elementId(element){
      if(!element||!element.closest)return null;
      const node=element.closest('.t-row[data-id],.bar[data-id],.ms[data-id],.pin[data-id],.lane-band[data-id],.pipe-head[data-id],.bar-out[data-for],.pin-label[data-for],.ms-label[data-for],.lane-tag[data-for]');
      if(!node||!node.closest('#g-left-body,#b-layer'))return null;
      const id=node.dataset.id||node.dataset.for,t=tasksById.get(id);
      return t&&t.type!=='pipeline'?id:null;
    }
    function bind(){
      if(!doc||bound)return;bound=true;
      // A drag ending over another row is not a new chain selection.
      doc.addEventListener('mousedown',event=>{press=event.button===0?{x:event.clientX,y:event.clientY}:null;dragged=false},true);
      doc.addEventListener('mouseup',event=>{
        dragged=Boolean(press&&(Math.abs(event.clientX-press.x)>=4||Math.abs(event.clientY-press.y)>=4));press=null;
      },true);
      doc.addEventListener('click',event=>{
        const moved=dragged;dragged=false;
        if(event.defaultPrevented||(moved&&event.detail!==0)||(event.button!=null&&event.button!==0)||(env.isDragging&&env.isDragging()))return;
        const target=event.target;if(!target||!target.closest)return;
        const id=elementId(target);
        if(id){setSelected(id);return}
        if(target.closest('#g-left-body,#tl-body,#selection-clear'))setSelected(null);
      },true);
      // Focus and arrow navigation retain the clicked chain. Space is an explicit keyboard activation;
      // Enter keeps the existing task-editor shortcut.
      doc.addEventListener('keydown',event=>{
        if(event.defaultPrevented||event.key!==' '||event.repeat||event.isComposing||event.ctrlKey||event.altKey||event.metaKey||(env.isDragging&&env.isDragging()))return;
        const target=event.target;if(!target||!target.closest||target.closest('button,a,input,textarea,select,[contenteditable="true"]'))return;
        const id=elementId(target);if(!id)return;
        event.preventDefault();setSelected(id);
      },true);
    }
    function mountControls(){
      if(!doc)return;
      const bar=doc.querySelector('.filter-bar');if(!bar)return;
      if(!controls||!bar.contains(controls.wrap)){
        const wrap=doc.createElement('div');wrap.className='highlight-controls';
        const label=doc.createElement('label');label.htmlFor='highlight-owner';label.textContent='负责人高亮';
        const select=doc.createElement('select');select.id='highlight-owner';select.setAttribute('aria-label','高亮负责人任务');
        select.title='仅高亮所选负责人的任务；不会隐藏任务或改变排期';
        select.addEventListener('change',()=>setOwner(select.value));
        const clearButton=doc.createElement('button');clearButton.type='button';clearButton.className='highlight-clear';clearButton.textContent='取消';
        clearButton.setAttribute('aria-label','取消负责人高亮');clearButton.addEventListener('click',()=>setOwner(null));
        const status=doc.createElement('button');status.type='button';status.className='highlight-chain-status';status.setAttribute('aria-live','polite');status.setAttribute('aria-atomic','true');
        status.title='点击任务显示依赖链；点击此处或任务区空白可清除';status.addEventListener('click',()=>setSelected(null));
        wrap.append(label,select,clearButton,status);bar.appendChild(wrap);
        controls={wrap,select,clear:clearButton,status,signature:null};
      }
      const signature=JSON.stringify(owners);
      if(controls.signature!==signature){
        const option=doc.createElement('option');option.value='';option.textContent='全部负责人';
        controls.select.replaceChildren(option);
        for(const name of owners){const item=doc.createElement('option');item.value=name;item.textContent=name;controls.select.appendChild(item)}
        controls.signature=signature;
      }
    }
    function afterRender(){
      const previous=selectedTaskId;sync();bind();mountControls();
      // Keep the explicit choice across rendering, filtering and flow expansion.
      paint();if(selectedTaskId||previous)redraw();
    }
    return{listOwners(){ensure();return owners.slice()},setOwner,clear,trace,setSelected,setHovered:setSelected,state,edgeState,afterRender};
  }
  if(typeof module==='object'&&module.exports){module.exports={buildIndex,traceIndex,createController};return}
  root.ScheduleHighlights=createController({
    document:root.document,window:root,getProject:()=>typeof proj==='undefined'?null:proj,
    buildGraph:tasks=>buildDependencyGraph(tasks),
    isDragging:()=>typeof dragging!=='undefined'&&dragging,
    redrawEdges:()=>{if(typeof schDepDraw==='function')schDepDraw()}
  });
})(typeof window==='undefined'?globalThis:window);
