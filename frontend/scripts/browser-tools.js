/* Tools for the current open page only. Cloud data operations use the remote AI API. */
(function (root) {
  'use strict';
  const object = (properties = {}, required = []) => ({type:'object',properties,required,additionalProperties:false});
  const string = (maxLength = 256) => ({type:'string',minLength:1,maxLength});
  const ids = {type:'array',items:string(),maxItems:10000,uniqueItems:true};
  const boolean = {type:'boolean'};
  const choice = values => ({type:'string',enum:values});
  const empty = object();
  const definitions = [];
  function define(name, description, inputSchema = empty, options = {}) {
    definitions.push({name:'browser.'+name,description,inputSchema,scope:'current-browser',
      annotations:{readOnlyHint:!!options.readOnly,destructiveHint:!!options.destructive,
        idempotentHint:!!options.idempotent,openWorldHint:!!options.external},
      requiresProject:options.requiresProject!==false});
  }
  define('state','读取当前页视图、筛选、选中、布局和保存状态；不返回凭据。',empty,{readOnly:true,requiresProject:false});
  define('view.set','切换当前页甘特图/任务表格。',object({view:choice(['gantt','table'])},['view']),{idempotent:true});
  define('zoom.set','设置当前甘特图日/周/月缩放，保留中心日期。',object({zoom:choice(['day','week','month'])},['zoom']),{idempotent:true});
  define('zoom.default','设置此浏览器启动时的默认时间缩放。',object({zoom:choice(['day','week','month'])},['zoom']),{idempotent:true});
  define('search.set','按任务名称、负责人、阶段搜索当前页。',object({query:{type:'string',maxLength:512}},['query']),{idempotent:true});
  define('filters.set','设置当前页筛选；null清除职能或阶段筛选。', {...object({query:{type:'string',maxLength:512},role:{type:['string','null'],minLength:1,maxLength:256},phase:{type:['string','null'],minLength:1,maxLength:512}}),minProperties:1},{idempotent:true});
  define('filters.clear','清除当前页全部搜索和筛选。',empty,{idempotent:true});
  define('selection.set','设置当前页选中任务，空数组清空；primaryId必须在taskIds内。',object({taskIds:ids,primaryId:string()},['taskIds']),{idempotent:true});
  define('selection.step','按当前可见行向上或下移动选择，可扩展多选。',object({direction:choice(['up','down']),extend:boolean},['direction']));
  define('task.reveal','清除筛选、展开祖先并定位任务/管线，不修改共享任务属性。',object({taskId:string()},['taskId']),{idempotent:true});
  define('rows.fold','折叠或展开指定父任务；省略taskIds表示全部父任务。流程模式不因折叠而关闭。',object({taskIds:ids,collapsed:boolean},['collapsed']),{idempotent:true});
  define('lanes.expand','展开或收起流程内的父任务子泳道，仅作用当前页。',object({taskId:string(),expanded:boolean},['taskId','expanded']),{idempotent:true});
  define('timeline.today','将当前时间轴滚动到今天。',empty,{idempotent:true});
  define('timeline.date','将当前时间轴定位到指定日期。',object({date:{type:'string',pattern:'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'}},['date']),{idempotent:true});
  define('timeline.scale','兼容入口：按屏幕每天像素数等比缩放整图，实际倍率限制35%–300%；anchorX为时间轴视口内逻辑像素，默认中心。推荐canvas.scale直接传倍率。',object({pxPerDay:{type:'number',minimum:1,maximum:200},anchorX:{type:'number',minimum:0,maximum:10000000}},['pxPerDay']),{idempotent:true});
  define('canvas.scale','等比缩放当前整张排期图（0.35–3），包括日期格、行高、文字和任务条；可传浏览器视口clientX/clientY锚点，默认图表视口中心。factor=1恢复100%。',object({factor:{type:'number',minimum:0.35,maximum:3},clientX:{type:'number'},clientY:{type:'number'}},['factor']),{idempotent:true});
  define('viewport.scroll','设置表格或时间轴滚动位置（像素）；纵向滚动保持两侧同步。',object({pane:choice(['table','timeline']),x:{type:'number',minimum:0,maximum:10000000},y:{type:'number',minimum:0,maximum:10000000}},['pane']),{idempotent:true});
  define('columns.list','列出当前页所有列、顺序、显隐、宽度和允许宽度范围。',empty,{readOnly:true});
  define('columns.visibility','显示或隐藏当前页的一列；名称列始终显示。',object({columnId:string(),visible:boolean},['columnId','visible']),{idempotent:true});
  define('columns.move','将列向前或向后移动一位；名称列固定在首位。',object({columnId:string(),direction:choice(['left','right'])},['columnId','direction']));
  define('columns.order','设置完整列顺序，须包含所有列各一次，名称列在首位。',object({columnIds:ids},['columnIds']),{idempotent:true});
  define('columns.width','设置列宽（像素），按现有布局的最小/最大值钳制。',object({columnId:string(),width:{type:'number',minimum:1,maximum:10000}},['columnId','width']),{idempotent:true});
  define('columns.fit','按当前可见内容自动调整指定可见列。',object({columnId:string()},['columnId']));
  define('columns.reset','恢复当前页全部列的默认宽度。',empty,{idempotent:true});
  define('layout.pane','设置任务表格面板宽度，与列宽独立，保留时间轴最小空间。',object({width:{type:'number',minimum:1,maximum:10000}},['width']),{idempotent:true});
  define('layout.reset','恢复当前页默认表格/时间轴比例。',empty,{idempotent:true});
  define('layout.navigation','展开或收起当前页导航栏。',object({expanded:boolean},['expanded']),{idempotent:true});
  define('history.undo','撤销此页最近一步历史；须拥有编辑权限，可能修改共享排期并自动保存。',empty,{destructive:true});
  define('history.redo','重做此页最近撤销的历史；须拥有编辑权限并自动保存。',empty,{destructive:true});
  define('export.json','返回可导入的当前排期JSON；download=true同时请求浏览器下载，包含此页布局。',object({download:boolean}),{readOnly:true,external:true});
  define('export.png','请求现有PNG导出流程，按当前可见任务/筛选/缩放导出；返回请求状态，不保证浏览器已完成下载。',empty,{readOnly:true,external:true});
  define('dialog.open','打开指定面板；task需taskId，flag需flagId。AI面板只打开，不返回密钥。',object({dialog:choice(['task','flag','fields','settings','help','unlock','ai','presence']),taskId:string(),flagId:string()},['dialog']));
  define('dialog.close','关闭指定面板，未提交的表单输入会被丢弃；AI密钥按面板规则清除。',object({dialog:choice(['task','flag','fields','settings','help','unlock','ai','presence'])},['dialog']),{destructive:true});
  define('shared.save','通过现有保存队列提交此页待保存修改，返回实际保存结果；须有编辑权限。',empty,{external:true});
  define('shared.refresh','按现有轮询规则读取新版本；存在编辑、未保存草稿或打开面板时会跳过。',empty,{external:true,readOnly:true});
  define('shared.load_latest','丢弃此页未提交草稿并加载云端最新版；必须明确discardDraft=true。',object({discardDraft:{type:'boolean',const:true}},['discardDraft']),{destructive:true,external:true});
  define('shared.export_draft','请求下载此页保留的草稿JSON。',empty,{readOnly:true,external:true});
  define('shared.copy_link','复制当前排期分享链接到剪贴板。',empty,{external:true});
  define('shared.logout','退出此页编辑并撤销当前会话；不会暴露令牌，也不会自动丢弃保留草稿。',empty,{destructive:true,external:true});
  define('highlights.owners','列出可高亮的负责人。',empty,{readOnly:true});
  define('highlights.owner','去除首尾空格后高亮该负责人参与的任务；null或空白文本清除负责人高亮，不筛除其他任务。',object({owner:{type:['string','null'],maxLength:512}},['owner']),{idempotent:true});
  define('highlights.trace','读取指定任务的依赖追踪结果，不修改共享数据。',object({taskId:string()},['taskId']),{readOnly:true});
  define('highlights.task','在当前页高亮任务的依赖关系，null清除任务高亮。',object({taskId:{type:['string','null'],minLength:1,maxLength:256}},['taskId']),{idempotent:true});
  define('highlights.clear','清除当前页所有负责人/依赖高亮。',empty,{idempotent:true});
  const forbidden = new Set(['__proto__','prototype','constructor']);
  function fail(code,message){throw Object.assign(new Error(message),{toolCode:code});}
  function validate(schema,value,path='arguments',seen=new Set()) {
    const type=value===null?'null':Array.isArray(value)?'array':typeof value;
    const accepted=Array.isArray(schema.type)?schema.type:[schema.type];
    if(!accepted.includes(type))fail('INVALID_ARGUMENTS',path+'类型无效');
    if(schema.enum&&!schema.enum.includes(value))fail('INVALID_ARGUMENTS',path+'不在允许值内');
    if(Object.prototype.hasOwnProperty.call(schema,'const')&&value!==schema.const)fail('INVALID_ARGUMENTS',path+'须为'+String(schema.const));
    if(type==='string'){
      if(schema.minLength!==undefined&&value.length<schema.minLength||schema.maxLength!==undefined&&value.length>schema.maxLength)fail('INVALID_ARGUMENTS',path+'长度无效');
      if(schema.pattern&&!new RegExp(schema.pattern).test(value))fail('INVALID_ARGUMENTS',path+'格式无效');
    }else if(type==='number'){
      if(!Number.isFinite(value)||schema.minimum!==undefined&&value<schema.minimum||schema.maximum!==undefined&&value>schema.maximum)fail('INVALID_ARGUMENTS',path+'数值越界');
    }else if(type==='array'||type==='object'){
      if(seen.has(value))fail('INVALID_ARGUMENTS','参数不允许循环引用');
      seen.add(value);
      const descriptors=Object.getOwnPropertyDescriptors(value);
      if(Reflect.ownKeys(value).some(key=>typeof key!=='string'))fail('INVALID_ARGUMENTS','参数不允许Symbol键');
      if(Object.entries(descriptors).some(([key,descriptor])=>forbidden.has(key)||!Object.prototype.hasOwnProperty.call(descriptor,'value')))fail('INVALID_ARGUMENTS','参数不允许特殊键或访问器');
      if(type==='array'){
        if(Object.keys(value).some(key=>!/^(0|[1-9][0-9]*)$/.test(key))||schema.maxItems!==undefined&&value.length>schema.maxItems)fail('INVALID_ARGUMENTS',path+'数组无效');
        if(schema.uniqueItems&&new Set(value).size!==value.length)fail('INVALID_ARGUMENTS',path+'不允许重复项');
        for(let i=0;i<value.length;i++)validate(schema.items,value[i],path+'['+i+']',seen);
      }else{
        const proto=Object.getPrototypeOf(value);
        if(proto!==null&&Object.getPrototypeOf(proto)!==null)fail('INVALID_ARGUMENTS','只接受普通JSON对象');
        const keys=Object.keys(value);
        if(schema.minProperties!==undefined&&keys.length<schema.minProperties)fail('INVALID_ARGUMENTS',path+'不能为空');
        for(const key of schema.required||[])if(!Object.prototype.hasOwnProperty.call(value,key))fail('INVALID_ARGUMENTS','缺少'+path+'.'+key);
        for(const key of keys){
          if(!Object.prototype.hasOwnProperty.call(schema.properties,key))fail('INVALID_ARGUMENTS','未知参数'+path+'.'+key);
          validate(schema.properties[key],value[key],path+'.'+key,seen);
        }
      }
      seen.delete(value);
    }
  }
  const clone=value=>JSON.parse(JSON.stringify(value));
  function createBridge(adapter) {
    const catalog=new Map(definitions.map(definition=>[definition.name,definition]));
    let running=false;
    return Object.freeze({
      version:1,scope:'current-browser',
      list:()=>clone(definitions),
      async call(name,args={}){
        try{
          const definition=catalog.get(name);
          if(!definition)fail('UNKNOWN_TOOL','未知浏览器工具');
          validate(definition.inputSchema,args);
          // A returned schema or a caller-owned object cannot change the catalog or an in-flight action.
          const input=clone(args);
          if(running)fail('BUSY','前一个浏览器工具尚未完成，请等待');
          running=true;
          try{
            await adapter.beforeCall(definition,input);
            return {ok:true,data:await adapter.execute(name,input)};
          }finally{running=false;}
        }catch(error){
          return {ok:false,error:{code:error.toolCode||'BROWSER_TOOL_FAILED',message:error.toolCode?error.message:'浏览器操作未完成，请查看页面提示。'}};
        }
      }
    });
  }
  function browserAdapter() {
    const shared=()=>typeof SharedWorkspace!=='undefined'&&SharedWorkspace.enabled?SharedWorkspace:null;
    const assertShared=()=>{const value=shared();if(!value)fail('NOT_SHARED','此页不是共享排期');return value;};
    const assertEditor=()=>{if(!mayEditProject('AI操作当前页'))fail('EDIT_REQUIRED','当前页没有编辑权限，或存在尚未处理的版本冲突');};
    const task=id=>{const value=byId(id);if(!value)fail('NOT_FOUND','任务不存在：'+id);return value;};
    const column=id=>{const value=allTableColumns().find(item=>item.id===id);if(!value)fail('NOT_FOUND','列不存在：'+id);return value;};
    const highlights=()=>{if(!window.ScheduleHighlights)fail('UNAVAILABLE','当前版本没有高亮功能');return window.ScheduleHighlights;};
    const dialogs={task:'#ovl',flag:'#flag-ovl',fields:'#fields-ovl',settings:'#set-ovl',help:'#help-ovl',unlock:'#shared-unlock-ovl',ai:'#shared-ai-ovl',presence:'#shared-presence-ovl'};
    const readShared=()=>{
      const value=shared()?.state();if(!value)return {enabled:false,canEdit:true};
      // Explicit allowlist: state may gain secret or session fields in a later release.
      const result={};
      for(const key of ['enabled','mode','screen','role','canEdit','projectId','revision','displayName','saveStatus','dirty','saving','shareURL','updatedAt','updatedBy','draftAvailable','draftPersisted'])if(value[key]!==undefined)result[key]=value[key];
      if(value.conflict)result.conflict={revision:value.conflict.revision,updatedAt:value.conflict.updatedAt,updatedBy:value.conflict.updatedBy};
      if(value.error)result.errorCode=value.error.code;
      return result;
    };
    const columns=()=>{const widths=colW(),visible=new Set(visibleTableColumns().map(item=>item.id));return allTableColumns().map(item=>({id:item.id,name:item.name,type:item.type,builtin:!!item.builtin,width:widths[item.id],min:item.min,max:item.max,visible:visible.has(item.id)}));};
    const state=()=>{
      const loaded=typeof proj!=='undefined'&&!!proj,collaboration=readShared();
      const result={loaded,scope:'current-browser',collaboration};
      if(!loaded)return result;
      return {...result,view:WorkspaceShell.view,zoom,defaultZoom:proj.meta.defView||'week',
        filters:{query:filterQ,role:filterGrp,phase:filterPhase},selection:{taskIds:Array.from(selIds),primaryId:selId},
        visibleTaskIds:vRows().map(row=>row.t.id),foldedTaskIds:proj.tasks.filter(item=>item.fold).map(item=>item.id),expandedLaneIds:Array.from(expandedLanes),
        columns:columns(),pane:{width:($('#g-left')?.getBoundingClientRect().width||0)/(typeof canvasScaleFactor==='function'?canvasScaleFactor():1),automatic:proj.meta.paneAuto!==false,bounds:paneBounds()},
        timeline:{from:bds?fD(bds.mn):null,to:bds?fD(bds.mx):null,scale:typeof timelineScaleState==='function'?timelineScaleState():{pxPerDay:axis?.dw||ZOOM[zoom].dw,preset:zoom,custom:false}},
        history:{undoAvailable:collaboration.canEdit&&histI>0,redoAvailable:collaboration.canEdit&&histI<hist.length-1},
        openDialogs:Object.entries(dialogs).filter(([,selector])=>$(selector)&&!$(selector).hidden).map(([name])=>name)};
    };
    const setFilters=input=>{
      if(input.role!==undefined&&input.role!==null&&!proj.groups.some(item=>item.name===input.role))fail('NOT_FOUND','职能不存在');
      if(input.phase!==undefined&&input.phase!==null&&!phaseList().includes(input.phase))fail('NOT_FOUND','阶段不存在');
      if(input.query!==undefined){filterQ=input.query.trim();$('#tb-search').value=filterQ;}
      if(input.role!==undefined)filterGrp=input.role;
      if(input.phase!==undefined)filterPhase=input.phase;
      render();
    };
    const centerDate=date=>{
      const day=tD(date);
      if(!Number.isFinite(day)||fD(day)!==date||date<'0001-01-01'||date>'9999-12-31')fail('INVALID_ARGUMENTS','日期不存在');
      const pane=$('#g-right'),margin=Math.ceil((pane.clientWidth/2+600)/(axis?.dw||ZOOM[zoom].dw));
      vMn=Math.min(vMn??day,day-margin);vMx=Math.max(vMx??day,day+margin);
      render();ensureFill();pane.scrollLeft=Math.max(0,(day-bds.mn)*axis.dw-pane.clientWidth/2);
    };
    const handlers={
      'browser.state':state,
      'browser.view.set':a=>{WorkspaceShell.setView(a.view);return state();},
      'browser.zoom.set':a=>{zoomTimeline(a.zoom);return state();},
      'browser.zoom.default':a=>{if(proj.meta.defView!==a.zoom){proj.meta.defView=a.zoom;schSave();}return state();},
      'browser.search.set':a=>{setFilters(a);return state();},
      'browser.filters.set':a=>{setFilters(a);return state();},
      'browser.filters.clear':()=>{setFilters({query:'',role:null,phase:null});return state();},
      'browser.selection.set':a=>{
        a.taskIds.forEach(task);
        if(a.primaryId!==undefined&&!a.taskIds.includes(a.primaryId))fail('INVALID_ARGUMENTS','primaryId必须包含在taskIds中');
        selIds=new Set(a.taskIds);selId=a.primaryId||a.taskIds[a.taskIds.length-1]||null;paintSelection();return state();
      },
      'browser.selection.step':a=>{selStep(a.direction==='up'?-1:1,!!a.extend);return state();},
      'browser.task.reveal':a=>{
        const target=task(a.taskId);let parent=target.pid,changed=false,firstVisible=target;
        while(parent){const item=task(parent);if(item.fold){item.fold=false;changed=true;}clearLaneTimer(item.id);expandedLanes.add(item.id);firstVisible=item;parent=item.pid;}
        setFilters({query:'',role:null,phase:null});sel(target.id);
        const rows=Array.from($('#g-left-body').querySelectorAll('.t-row'));
        const row=rows.find(item=>item.dataset.id===target.id)||rows.find(item=>item.dataset.id===firstVisible.id);
        if(row){const top=Math.max(0,row.offsetTop-$('#g-left-body').offsetTop);$('#g-left-body').scrollTop=top;$('#g-right').scrollTop=top;row.focus({preventScroll:true});}
        const range=eRange(target);centerDate(fD(Math.floor((range.s+range.e)/2)));
        if(changed)schSave();return state();
      },
      'browser.rows.fold':a=>{
        const tasks=a.taskIds?a.taskIds.map(task):proj.tasks.filter(isSum);
        if(tasks.some(item=>!isSum(item)))fail('INVALID_ARGUMENTS','只能折叠父任务');
        let changed=false;for(const item of tasks)if(!!item.fold!==a.collapsed){item.fold=a.collapsed;changed=true;}
        if(changed){render();schSave();}return state();
      },
      'browser.lanes.expand':a=>{
        const target=task(a.taskId);
        if(!isSum(target))fail('INVALID_ARGUMENTS','只能展开父任务子泳道');
        let parent=target.pid,inFlow=false;
        while(parent){const item=task(parent);if(item.flow)inFlow=true;parent=item.pid;}
        if(!inFlow)fail('INVALID_ARGUMENTS','此任务不在流程泳道内');
        if(a.expanded){clearLaneTimer(target.id);expandedLanes.add(target.id);}else closeLane(target.id);
        render();return state();
      },
      'browser.timeline.today':()=>{goToday();return state();},
      'browser.timeline.date':a=>{centerDate(a.date);return state();},
      'browser.timeline.scale':a=>{if(typeof setTimelineScale!=='function')fail('UNAVAILABLE','当前版本没有连续缩放功能');setTimelineScale(a.pxPerDay,a.anchorX===undefined?{}:{anchorX:a.anchorX});return state();},
      'browser.canvas.scale':a=>{if(typeof setCanvasScale!=='function')fail('UNAVAILABLE','当前版本没有整图缩放功能');const {factor,...anchor}=a;setCanvasScale(factor,anchor);return state();},
      'browser.viewport.scroll':a=>{
        if(a.x===undefined&&a.y===undefined)fail('INVALID_ARGUMENTS','至少提供x或y');
        const pane=$(a.pane==='table'?'#g-left-body':'#g-right');
        if(a.x!==undefined)pane.scrollLeft=a.x;
        if(a.y!==undefined){$('#g-left-body').scrollTop=a.y;$('#g-right').scrollTop=a.y;}
        if(a.pane==='table')syncLeftColumns();else schDepDraw();
        return {pane:a.pane,x:pane.scrollLeft,y:pane.scrollTop};
      },
      'browser.columns.list':()=>({columns:columns()}),
      'browser.columns.visibility':a=>{column(a.columnId);if(a.columnId==='name'&&!a.visible)fail('INVALID_ARGUMENTS','名称列不能隐藏');fieldsSetVisible(a.columnId,a.visible);return {columns:columns()};},
      'browser.columns.move':a=>{column(a.columnId);const changed=fieldsMove(a.columnId,a.direction==='left'?-1:1);return {changed,columns:columns()};},
      'browser.columns.order':a=>{
        const current=allTableColumns().map(item=>item.id);
        if(a.columnIds.length!==current.length||a.columnIds[0]!=='name'||a.columnIds.some(id=>!current.includes(id)))fail('INVALID_ARGUMENTS','须包含全部列各一次，名称列在首位');
        if(JSON.stringify(current)!==JSON.stringify(a.columnIds)){proj.meta.columnOrder=a.columnIds.slice();render();schSave();}
        return {columns:columns()};
      },
      'browser.columns.width':a=>{column(a.columnId);const changed=setColumnWidth(a.columnId,a.width);return {changed,columns:columns()};},
      'browser.columns.fit':a=>{column(a.columnId);if(!visibleTableColumns().some(item=>item.id===a.columnId))fail('INVALID_ARGUMENTS','请先显示该列');const changed=fitColumnToContent(a.columnId);return {changed,columns:columns()};},
      'browser.columns.reset':()=>({changed:resetColumnWidths(),columns:columns()}),
      'browser.layout.pane':a=>{const changed=setPaneWidth(a.width);return {changed,...state()};},
      'browser.layout.reset':()=>{const changed=resetPaneLayout();return {changed,...state()};},
      'browser.layout.navigation':a=>{
        const shell=$('#app-shell');shell.classList.toggle('nav-expanded',a.expanded);shell.classList.toggle('nav-collapsed',!a.expanded);
        $('#nav-toggle').setAttribute('aria-expanded',String(a.expanded));applyPaneLayout();applyColWidths();ensureFill();return state();
      },
      'browser.history.undo':()=>{assertEditor();const before=histI;undo();return {changed:histI!==before,...state()};},
      'browser.history.redo':()=>{assertEditor();const before=histI;redo();return {changed:histI!==before,...state()};},
      'browser.export.json':a=>{const project=ScheduleProjectValidation.validateProject(clone(proj));if(a.download)expJSON();return {project,...(a.download?{downloadStatus:'requested'}:{})};},
      'browser.export.png':()=>{if(!vRows().length)fail('NOTHING_TO_EXPORT','当前没有可见任务');capPNG();return {status:'export_requested',completion:'请以页面提示和浏览器下载结果为准'};},
      'browser.dialog.open':a=>{
        const selector=dialogs[a.dialog],node=$(selector);
        if(!node)fail('UNAVAILABLE','当前版本没有此面板');
        if(Object.entries(dialogs).some(([name,id])=>name!==a.dialog&&$(id)&&!$(id).hidden))fail('DIALOG_OPEN','请先关闭当前面板，避免丢失表单输入');
        if(!node.hidden)fail('DIALOG_OPEN','此面板已经打开，保留当前输入');
        if(a.dialog!=='task'&&a.taskId!==undefined||a.dialog!=='flag'&&a.flagId!==undefined)fail('INVALID_ARGUMENTS','此面板不接受任务或里程碑标识');
        switch(a.dialog){
          case 'task':if(!a.taskId)fail('INVALID_ARGUMENTS','task面板需要taskId');task(a.taskId);assertEditor();edOpen(a.taskId);break;
          case 'flag':if(!a.flagId)fail('INVALID_ARGUMENTS','flag面板需要flagId');if(!flags().some(item=>item.id===a.flagId))fail('NOT_FOUND','里程碑不存在');assertEditor();flagOpen(a.flagId);break;
          case 'fields':fieldsOpen();break;
          case 'settings':setOpen();break;
          case 'help':openOvl(node);break;
          case 'unlock':assertShared();window.dispatchEvent(new CustomEvent('schedule:request-unlock',{detail:{action:'AI请求编辑'}}));break;
          case 'ai':case 'presence':{
            assertShared();assertEditor();const method=a.dialog==='ai'?'openAi':'openPresence';
            if(typeof window.SharedWorkspaceUI?.[method]!=='function')fail('UNAVAILABLE','当前版本没有此面板入口');
            window.SharedWorkspaceUI[method]();break;
          }
        }
        return {dialog:a.dialog,open:!node.hidden};
      },
      'browser.dialog.close':a=>{
        const node=$(dialogs[a.dialog]);if(!node)fail('UNAVAILABLE','当前版本没有此面板');
        if(node.hidden)return {dialog:a.dialog,open:false};
        switch(a.dialog){
          case 'task':edClose();break;case 'flag':flagClose();break;case 'fields':fieldsClose();break;case 'settings':setClose();break;case 'help':helpClose();break;
          case 'unlock':$('#shared-unlock-cancel').click();break;
          case 'ai':case 'presence':{
            const method=a.dialog==='ai'?'closeAi':'closePresence';
            if(typeof window.SharedWorkspaceUI?.[method]!=='function')fail('UNAVAILABLE','当前版本没有此面板入口');
            window.SharedWorkspaceUI[method]();break;
          }
        }
        return {dialog:a.dialog,open:!node.hidden};
      },
      'browser.shared.save':async()=>{assertShared();assertEditor();const result=await flushPendingSave();return {saved:!!result.ok,...(!result.ok?{message:result.error||'待保存修改仍被保留'}:{}),state:readShared()};},
      'browser.shared.refresh':async()=>{const changed=await assertShared().pollNow();return {changed:!!changed,state:readShared()};},
      'browser.shared.load_latest':async()=>{await assertShared().loadLatest();return state();},
      'browser.shared.export_draft':()=>{assertShared().exportDraft();return {downloadStatus:'requested'};},
      'browser.shared.copy_link':async()=>{await assertShared().copyLink();return {copied:true};},
      'browser.shared.logout':async()=>{await assertShared().logout();return {state:readShared()};},
      'browser.highlights.owners':()=>({owners:highlights().listOwners()}),
      'browser.highlights.owner':a=>{const api=highlights(),owner=a.owner===null?null:a.owner.trim()||null;if(owner!==null&&!api.listOwners().includes(owner))fail('NOT_FOUND','负责人不存在');return api.setOwner(owner);},
      'browser.highlights.trace':a=>{task(a.taskId);return highlights().trace(a.taskId);},
      'browser.highlights.task':a=>{if(a.taskId!==null)task(a.taskId);const api=highlights();return (api.setSelected||api.setHovered)(a.taskId);},
      'browser.highlights.clear':()=>highlights().clear()
    };
    return {
      beforeCall(definition){
        if(definition.requiresProject&&(typeof proj==='undefined'||!proj||shared()&&shared().state().screen!=='ready'))fail('NOT_READY','请先打开并加载一份排期');
        if(definition.name!=='browser.state'&&((typeof dragging!=='undefined'&&dragging)||(typeof sbDrag!=='undefined'&&sbDrag)))fail('BUSY','当前正在拖动，请先完成或取消拖动');
        // View changes can rebuild editor DOM; do not discard an open form implicitly.
        const opened=Object.values(dialogs).some(selector=>$(selector)&&!$(selector).hidden);
        if(opened&&!definition.annotations.readOnlyHint&&!['browser.dialog.open','browser.dialog.close','browser.shared.logout'].includes(definition.name))fail('DIALOG_OPEN','请先关闭当前面板，避免覆盖未提交的表单输入');
      },
      execute(name,args){return handlers[name](args);}
    };
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={createBridge,definitions:clone(definitions)};
  else root.ScheduleBrowserTools=createBridge(browserAdapter());
})(typeof window!=='undefined'?window:globalThis);
