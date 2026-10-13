/* 自定义字段：列管理与任务编辑；字段和选项以稳定 ID 关联。 */
const CUSTOM_FIELD_TYPE_NAMES={text:'文本',number:'数字',date:'日期',select:'单选',checkbox:'勾选'};
let fieldsEditingId=null,customTaskInputs=new Map();
function customFieldDefs(){return Array.isArray(proj.meta&&proj.meta.customFields)?proj.meta.customFields:[]}
function fieldsMeta(){if(!proj.meta)proj.meta={};return proj.meta}
function fieldsNameError(name,exceptId){
  if(!name||name.length>128)return '字段名称不能为空，且最多 128 个字符';
  const key=name.toLocaleLowerCase();
  const reserved=['名称','负责人','开始','结束','进度','职能','阶段'];
  if(reserved.some(value=>value.toLocaleLowerCase()===key))return '字段名称不能与内置列重复';
  if(customFieldDefs().some(field=>field.id!==exceptId&&field.name.toLocaleLowerCase()===key))return '已存在同名字段';
  return '';
}
function fieldsOptionsError(options){
  if(options.length>100)return '单选字段最多 100 个选项';
  if(!options.length)return '单选字段至少需要一个选项';
  const labels=new Set(),ids=new Set();
  for(const option of options){
    if(!option.label||option.label.length>128)return '选项名称不能为空，且最多 128 个字符';
    const key=option.label.toLocaleLowerCase();
    if(labels.has(key))return '单选选项名称不能重复';
    if(!option.id||ids.has(option.id))return '单选选项标识无效，请重新打开字段编辑';
    labels.add(key);ids.add(option.id);
  }
  return '';
}
function fieldsError(message,input){toast(message,'warn',4200);if(input&&input.focus)input.focus();return false}
function fieldsColumnOrder(){return allTableColumns().map(column=>column.id)}
function fieldsHiddenSet(){return new Set(Array.isArray(fieldsMeta().hiddenColumns)?fieldsMeta().hiddenColumns:['grp','phase'])}
function fieldsFocus(key){
  if(!key)return;
  const control=Array.from($('#fields-list').querySelectorAll('[data-focus-key]')).find(el=>el.dataset.focusKey===key);
  if(control)control.focus();
}
function fieldsCommit(message,focusKey){
  render();schSave();renderFieldsManager();fieldsFocus(focusKey);
  toast(message+' · Ctrl+Z 可撤销','info',3000);
}
function fieldsSetVisible(id,visible){
  if(id==='name'||!allTableColumns().some(column=>column.id===id))return false;
  const hidden=fieldsHiddenSet(),wasHidden=hidden.has(id);
  if(wasHidden===!visible)return false;
  if(visible)hidden.delete(id);else hidden.add(id);
  hidden.delete('name');fieldsMeta().hiddenColumns=Array.from(hidden);
  fieldsCommit(visible?'已显示该列':'已隐藏该列','show:'+id);return true;
}
function fieldsMove(id,direction){
  if(id==='name'||(direction!==-1&&direction!==1))return false;
  const order=fieldsColumnOrder(),index=order.indexOf(id),next=index+direction;
  if(index<1||next<1||next>=order.length)return false;
  [order[index],order[next]]=[order[next],order[index]];fieldsMeta().columnOrder=order;
  fieldsCommit('已调整列顺序',(direction<0?'up:':'down:')+id);return true;
}
function fieldsAddDefinition(name,type,labels){
  if(typeof mayEditProject==='function'&&!mayEditProject('添加字段'))return {error:'请解锁编辑后添加字段'};
  if(customFieldDefs().length>=50)return {error:'自定义字段最多 50 个'};
  name=String(name||'').trim();
  let error=fieldsNameError(name);if(error)return {error};
  if(!Object.prototype.hasOwnProperty.call(CUSTOM_FIELD_TYPE_NAMES,type))return {error:'请选择有效字段类型'};
  const field={id:'cf_'+uid(),name,type};
  if(type==='select'){
    field.options=labels.map(label=>({id:'fo_'+uid(),label:String(label).trim()}));
    error=fieldsOptionsError(field.options);if(error)return {error};
  }
  const meta=fieldsMeta(),order=fieldsColumnOrder(),hidden=fieldsHiddenSet();
  if(!Array.isArray(meta.customFields))meta.customFields=[];
  meta.customFields.push(field);meta.columnOrder=[...order,field.id];hidden.delete(field.id);hidden.delete('name');meta.hiddenColumns=Array.from(hidden);
  fieldsCommit('已添加「'+name+'」','edit:'+field.id);
  const body=$('#g-left-body');if(body){body.scrollLeft=Math.max(0,(body.scrollWidth||0)-(body.clientWidth||0));if(typeof syncLeftColumns==='function')syncLeftColumns()}
  return {field};
}
function fieldsCreate(){
  const name=$('#fields-add-name'),type=$('#fields-add-type').value;
  const labels=$('#fields-add-options').value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
  const result=fieldsAddDefinition(name.value,type,labels);
  if(result.error)return fieldsError(result.error,type==='select'&&!labels.length?$('#fields-add-options'):name);
  name.value='';$('#fields-add-options').value='';name.focus();return true;
}
function fieldsApplyEdit(id,name,options){
  if(typeof mayEditProject==='function'&&!mayEditProject('修改字段'))return {error:'请解锁编辑后修改字段'};
  const field=customFieldDefs().find(item=>item.id===id);if(!field)return {error:'该字段已被删除，请重新打开字段管理'};
  name=String(name||'').trim();let error=fieldsNameError(name,id);if(error)return {error};
  const next=field.type==='select'?options.map(option=>({id:option.id,label:String(option.label||'').trim()})):null;
  if(next){error=fieldsOptionsError(next);if(error)return {error}}
  const changed=field.name!==name||(next&&JSON.stringify(next)!==JSON.stringify(field.options));
  if(!changed)return {changed:false};
  field.name=name;
  if(next){
    field.options=next;const valid=new Set(next.map(option=>option.id));
    for(const task of proj.tasks)if(task.customValues&&Object.prototype.hasOwnProperty.call(task.customValues,id)&&!valid.has(task.customValues[id]))delete task.customValues[id];
  }
  fieldsCommit('已更新「'+name+'」','edit:'+id);return {changed:true};
}
function fieldsDelete(id){
  if(typeof mayEditProject==='function'&&!mayEditProject('删除字段'))return false;
  const field=customFieldDefs().find(item=>item.id===id);if(!field)return false;
  const meta=fieldsMeta(),order=fieldsColumnOrder(),hidden=fieldsHiddenSet();
  meta.customFields=meta.customFields.filter(item=>item.id!==id);
  meta.columnOrder=order.filter(value=>value!==id);hidden.delete(id);hidden.delete('name');meta.hiddenColumns=Array.from(hidden);
  if(meta.cols&&typeof meta.cols==='object')delete meta.cols[id];
  for(const task of proj.tasks)if(task.customValues)delete task.customValues[id];
  if(fieldsEditingId===id)fieldsCancelEdit();
  fieldsCommit('已删除「'+field.name+'」');$('#fields-add-name').focus();return true;
}
function fieldsButton(text,label,action,key){
  const button=ce('button','btn',text);button.type='button';button.title=label;button.setAttribute('aria-label',label);
  if(key)button.dataset.focusKey=key;button.addEventListener('click',action);return button;
}
function renderFieldsManager(){
  const list=$('#fields-list');list.innerHTML='';
  const columns=allTableColumns(),hidden=fieldsHiddenSet();
  columns.forEach((column,index)=>{
    const row=ce('div','fields-row');row.setAttribute('role','listitem');row.dataset.columnId=column.id;
    const show=ce('label','fields-show'),checkbox=ce('input');checkbox.type='checkbox';checkbox.checked=column.id==='name'||!hidden.has(column.id);checkbox.disabled=column.id==='name';
    checkbox.dataset.focusKey='show:'+column.id;checkbox.setAttribute('aria-label','显示「'+column.name+'」列');checkbox.addEventListener('change',()=>fieldsSetVisible(column.id,checkbox.checked));
    show.appendChild(checkbox);show.appendChild(ce('span',null,'显示'));row.appendChild(show);
    const main=ce('div','fields-main');main.appendChild(ce('div','fields-name',column.name));
    main.appendChild(ce('span','fields-kind',(CUSTOM_FIELD_TYPE_NAMES[column.type]||'文本')+(column.builtin?' · 内置':' · 自定义')));row.appendChild(main);
    const actions=ce('div','fields-actions');
    const up=fieldsButton('↑','将「'+column.name+'」列向前移动',()=>fieldsMove(column.id,-1),'up:'+column.id);up.disabled=column.id==='name'||index<=1;
    const down=fieldsButton('↓','将「'+column.name+'」列向后移动',()=>fieldsMove(column.id,1),'down:'+column.id);down.disabled=column.id==='name'||index===columns.length-1;
    actions.appendChild(up);actions.appendChild(down);
    if(!column.builtin){
      actions.appendChild(fieldsButton('编辑','编辑「'+column.name+'」名称和选项',()=>fieldsEdit(column.id),'edit:'+column.id));
      const del=fieldsButton('删除','删除「'+column.name+'」字段及其任务值',()=>fieldsDelete(column.id),'delete:'+column.id);del.classList.add('danger');actions.appendChild(del);
    }
    row.appendChild(actions);list.appendChild(row);
  });
  if(fieldsEditingId&&!customFieldDefs().some(field=>field.id===fieldsEditingId))fieldsCancelEdit();
}
function fieldsOptionRow(option){
  const row=ce('div','fields-option-row');row.dataset.optionId=option.id;
  const input=ce('input','fields-option-label');input.type='text';input.maxLength=128;input.value=option.label;input.setAttribute('aria-label','选项名称');row.appendChild(input);
  const up=fieldsButton('↑','将此选项向前移动',()=>{if(row.previousElementSibling)row.parentNode.insertBefore(row,row.previousElementSibling)});
  const down=fieldsButton('↓','将此选项向后移动',()=>{if(row.nextElementSibling)row.parentNode.insertBefore(row.nextElementSibling,row)});
  const del=fieldsButton('×','删除此选项',()=>{row.remove();$('#fields-edit-option-add').focus()});
  row.appendChild(up);row.appendChild(down);row.appendChild(del);$('#fields-edit-options-list').appendChild(row);return row;
}
function fieldsEdit(id){
  const field=customFieldDefs().find(item=>item.id===id);if(!field)return;
  fieldsEditingId=id;$('#fields-editor').hidden=false;$('#fields-edit-name').value=field.name;$('#fields-edit-type').textContent=CUSTOM_FIELD_TYPE_NAMES[field.type]+'（创建后固定）';
  $('#fields-edit-options').hidden=field.type!=='select';$('#fields-edit-options-list').innerHTML='';
  if(field.type==='select')for(const option of field.options||[])fieldsOptionRow(option);
  $('#fields-edit-name').focus();
}
function fieldsCancelEdit(){fieldsEditingId=null;$('#fields-editor').hidden=true}
function fieldsSaveEdit(){
  const options=Array.from($('#fields-edit-options-list').querySelectorAll('.fields-option-row')).map(row=>({id:row.dataset.optionId,label:row.querySelector('.fields-option-label').value.trim()}));
  const id=fieldsEditingId,result=fieldsApplyEdit(id,$('#fields-edit-name').value,options);
  if(result.error)return fieldsError(result.error,$('#fields-edit-name'));
  fieldsCancelEdit();fieldsFocus('edit:'+id);return true;
}
function fieldsToggleAddOptions(){$('#fields-add-options-label').hidden=$('#fields-add-type').value!=='select'}
function fieldsOpen(){
  fieldsCancelEdit();$('#fields-add-name').value='';$('#fields-add-type').value='text';$('#fields-add-options').value='';fieldsToggleAddOptions();
  renderFieldsManager();openOvl($('#fields-ovl'));
}
function fieldsClose(){fieldsCancelEdit();closeOvl($('#fields-ovl'))}
function renderCustomTaskFields(task){
  const defs=customFieldDefs(),block=$('#f-custom-block'),box=$('#f-custom-fields');block.hidden=!defs.length;box.innerHTML='';customTaskInputs=new Map();
  for(const field of defs){
    const label=ce('label',field.type==='checkbox'?'fields-task-check':'');label.appendChild(ce('span',null,field.name));
    const values=task.customValues||{},value=Object.prototype.hasOwnProperty.call(values,field.id)?values[field.id]:undefined;
    let input;
    if(field.type==='select'){
      input=ce('select');const empty=ce('option',null,'未填写');empty.value='';input.appendChild(empty);
      for(const option of field.options||[]){const el=ce('option',null,option.label);el.value=option.id;input.appendChild(el)}
      input.value=(field.options||[]).some(option=>option.id===value)?value:'';
    }else{
      input=ce(field.type==='text'?'textarea':'input');
      if(field.type==='text'){input.rows=2;input.maxLength=4096}
      else input.type=field.type==='checkbox'?'checkbox':field.type==='number'?'number':field.type==='date'?'date':'text';
      if(field.type==='date'){input.min='0100-01-01';input.max='9999-12-31'}
      if(field.type==='checkbox')input.checked=value===true;
      else if(field.type==='number'){input.step='any';input.value=typeof value==='number'&&Number.isFinite(value)?String(value):''}
      else input.value=typeof value==='string'?value:'';
    }
    input.dataset.customFieldId=field.id;input.setAttribute('aria-label',field.name);label.appendChild(input);box.appendChild(label);customTaskInputs.set(field.id,input);
  }
}
function parseCustomTaskValues(){
  const values={};
  for(const field of customFieldDefs()){
    const input=customTaskInputs.get(field.id);if(!input)continue;
    if(field.type==='checkbox'){values[field.id]=input.checked===true;continue}
    const raw=input.value;
    if(field.type==='number'){
      if(input.validity&&input.validity.badInput)return {error:'「'+field.name+'」请输入有效数字',input};
      if(!raw.trim())continue;
      const number=Number(raw);if(!Number.isFinite(number))return {error:'「'+field.name+'」请输入有限数字',input};values[field.id]=number;
    }else if(field.type==='date'){
      if(input.validity&&input.validity.badInput)return {error:'「'+field.name+'」请输入有效日期',input};
      if(!raw)continue;
      const date=new Date(raw+'T00:00:00Z');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(raw)||raw<'0100-01-01'||raw>'9999-12-31'||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==raw)return {error:'「'+field.name+'」请输入 0100—9999 年之间的真实日期（年-月-日）',input};values[field.id]=raw;
    }else if(field.type==='select'){
      if(!raw)continue;if(!(field.options||[]).some(option=>option.id===raw))return {error:'「'+field.name+'」的选项已失效，请重新选择',input};values[field.id]=raw;
    }else{
      if(raw.length>4096)return {error:'「'+field.name+'」文本最多 4096 个字符',input};
      if(raw!=='')values[field.id]=raw;
    }
  }
  return {values};
}
function fieldsRevealColumn(id){
  const header=$('#g-left-hd'),body=$('#g-left-body');
  if(!header||!body||!header.querySelectorAll)return;
  const cell=Array.from(header.querySelectorAll('.col[data-col]')).find(item=>item.dataset.col===id);
  if(!cell)return;
  const bounds=cell.getBoundingClientRect(),viewport=header.getBoundingClientRect();
  const scale=typeof canvasScaleFactor==='function'?canvasScaleFactor():1;
  const start=(bounds.left-viewport.left)/scale+(body.scrollLeft||0);
  body.scrollLeft=Math.max(0,start+bounds.width/scale-body.clientWidth);syncLeftColumns();
}
function fieldsUsePreset(key){
  const native=key==='owner'?'person':key==='role'?'grp':null;
  if(native){
    fieldsSetVisible(native,true);fieldsFocus('show:'+native);fieldsRevealColumn(native);
    toast(key==='owner'?'Owner 使用已有负责人字段':'已显示职能字段','info');return true;
  }
  const presets={
    priority:{name:'优先级',type:'select',labels:['高','中','低'],aliases:['优先级']},
    hours:{name:'预计工时（小时）',type:'number',aliases:['预计工时','预计工时（小时）']},
    duration:{name:'预计工期（天）',type:'number',aliases:['预计工期','预计工期（天）']},
    notes:{name:'备注',type:'text',aliases:['备注']}
  };
  const preset=presets[key];if(!preset)return false;
  const existing=customFieldDefs().find(field=>preset.aliases.includes(field.name));
  if(existing){
    fieldsSetVisible(existing.id,true);fieldsFocus('edit:'+existing.id);fieldsRevealColumn(existing.id);
    toast('已显示「'+existing.name+'」，已有内容保留','info');return true;
  }
  const result=fieldsAddDefinition(preset.name,preset.type,preset.labels||[]);
  if(result.error)return fieldsError(result.error,$('#fields-add-name'));
  fieldsRevealColumn(result.field.id);return true;
}
function bindFieldsUI(){
  $('#header-add-field').addEventListener('click',()=>{fieldsOpen();$('#fields-add-name').focus()});
  $('#fields-reset-widths').addEventListener('click',()=>{resetColumnWidths();toast('已恢复默认列宽','info')});
  document.querySelectorAll('[data-field-preset]').forEach(button=>button.addEventListener('click',()=>fieldsUsePreset(button.dataset.fieldPreset)));
  $('#btn-fields').addEventListener('click',fieldsOpen);$('#fields-close').addEventListener('click',fieldsClose);$('#fields-done').addEventListener('click',fieldsClose);
  $('#fields-ovl').addEventListener('click',e=>{if(e.target.id==='fields-ovl')fieldsClose()});
  $('#fields-add-type').addEventListener('change',fieldsToggleAddOptions);$('#fields-add').addEventListener('click',fieldsCreate);
  $('#fields-edit-save').addEventListener('click',fieldsSaveEdit);$('#fields-edit-cancel').addEventListener('click',fieldsCancelEdit);
  $('#fields-edit-option-add').addEventListener('click',()=>{const row=fieldsOptionRow({id:'fo_'+uid(),label:''});row.querySelector('.fields-option-label').focus()});
  $('#fields-add-name').addEventListener('keydown',e=>{if(e.key==='Enter'&&!isComposingKey(e)){e.preventDefault();fieldsCreate()}});
  $('#fields-edit-name').addEventListener('keydown',e=>{if(e.key==='Enter'&&!isComposingKey(e)){e.preventDefault();fieldsSaveEdit()}});
  $('#fields-ovl').addEventListener('keydown',e=>{
    if(isComposingKey(e)||(!e.ctrlKey&&!e.metaKey))return;
    const tag=(e.target.tagName||'').toLowerCase();
    if(tag==='textarea'||tag==='select'||e.target.isContentEditable||(tag==='input'&&!['checkbox','radio','button'].includes(e.target.type)))return;
    const key=e.key.toLowerCase();if(key!=='z'&&key!=='y')return;
    e.preventDefault();e.stopPropagation();fieldsCancelEdit();
    if(key==='y'||e.shiftKey)redo();else undo();renderFieldsManager();$('#fields-done').focus();
  });
}
