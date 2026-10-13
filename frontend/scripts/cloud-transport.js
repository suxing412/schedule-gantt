/* WorkBuddy RPC transport. All permissions are enforced by the database functions. */
if(typeof window!=='undefined')window.WorkBuddyTransport=(()=>{
  'use strict';
  const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
  const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
  const error=(code,message,status,extra={})=>Object.assign(new Error(message),{code,...(status?{status}:{}),...extra});
  const invalid=()=>error('INVALID_RESPONSE','云端返回的数据格式不正确，请检查数据库迁移版本。',502);
  const statuses={NOT_FOUND:404,PROJECT_NOT_FOUND:404,VALIDATION_ERROR:400,UNAUTHORIZED:401,INVALID_EDIT_CODE:401,INVALID_API_KEY:401,INVALID_SESSION:401,SESSION_EXPIRED:401,REVISION_CONFLICT:409,PROJECT_EXISTS:409,RATE_LIMITED:429};
  const sourceField=value=>{if(value===undefined)return {};if(!['human','external'].includes(value))throw invalid();return {source:value};};
  function apiKey(value){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw invalid();return value;}
  function validId(id){if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))throw error('INVALID_ID','排期链接无效。',400);return id;}
  function publicRecord(value,id){
    if(!isObject(value)||value.id!==id||!Number.isSafeInteger(value.revision)||value.revision<1||!isObject(value.project))throw invalid();
    if(['editCodeHash','edit_code_hash','editCode','edit_code','token_hash','api_key_hash','apiKeyHash'].some(key=>own(value,key)))throw invalid();
    for(const field of ['createdAt','updatedAt'])if(typeof value[field]!=='string'||!Number.isFinite(Date.parse(value[field])))throw invalid();
    if(typeof value.updatedBy!=='string')throw invalid();
    return {id:value.id,revision:value.revision,project:value.project,createdAt:value.createdAt,updatedAt:value.updatedAt,updatedBy:value.updatedBy,...sourceField(value.source)};
  }
  function session(value){
    if(!isObject(value)||typeof value.token!=='string'||!value.token||typeof value.displayName!=='string'||!value.displayName.trim()||typeof value.expiresAt!=='string'||!Number.isFinite(Date.parse(value.expiresAt)))throw invalid();
    return {token:value.token,displayName:value.displayName,expiresAt:value.expiresAt,...sourceField(value.source)};
  }
  function presence(value){
    if(!isObject(value)||!Array.isArray(value.members)||value.members.length>50||value.onlineThresholdSeconds!==60)throw invalid();
    return {members:value.members.map(member=>{
      if(!isObject(member)||typeof member.displayName!=='string'||!member.displayName.trim()||typeof member.lastSeenAt!=='string'||!Number.isFinite(Date.parse(member.lastSeenAt))||typeof member.online!=='boolean')throw invalid();
      if(['token','token_hash','tokenHash','apiKey','api_key','api_key_hash','edit_code_hash'].some(key=>own(member,key)))throw invalid();
      return {displayName:member.displayName,lastSeenAt:member.lastSeenAt,online:member.online,source:'human',...sourceField(member.source)};
    }),onlineThresholdSeconds:60};
  }
  function databaseError(result){
    const source=result.error,status=Number(result.status||source?.status)||0;
    if(status===0&&(!source?.code||source.code==='NETWORK_ERROR'||source.name==='TypeError'))return error('NETWORK_ERROR','暂时无法连接云服务，请检查网络后重试。');
    if(source?.code==='PGRST202'||source?.code==='42883')return error('CLOUD_NOT_READY','云端排期接口尚未就绪，请先执行配套数据库迁移。',503);
    if(source?.code==='42501'||status===403)return error('CLOUD_PERMISSION_DENIED','云端接口权限未配置完成，请检查数据库迁移和应用授权。',403);
    if(status===401)return error('CLOUD_CONFIG_ERROR','云服务配置或应用授权无效，请检查部署配置。',503);
    if(status===429)return error('RATE_LIMITED','请求过于频繁，请稍后重试。',429);
    return error('DATABASE_ERROR','云服务请求失败，请稍后重试。',status>=400&&status<=599?status:502);
  }
  function create(options={}){
    const endpoint=(typeof options.endpoint==='string'?options.endpoint.trim():'')||window.location?.origin||'';
    const publishableKey=typeof options.publishableKey==='string'?options.publishableKey.trim():'';
    const timeoutMs=options.timeoutMs===undefined?20000:options.timeoutMs;
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw error('CLOUD_CONFIG_ERROR','云服务请求超时配置无效。',503);
    let address;
    try{address=new URL(endpoint)}catch{throw error('CLOUD_CONFIG_ERROR','缺少有效的云服务地址，请检查部署时注入的 publicConfig。',503);}
    const local=address.hostname==='localhost'||address.hostname==='127.0.0.1'||address.hostname==='[::1]';
    if((address.protocol!=='https:'&&!(address.protocol==='http:'&&local))||address.username||address.password||address.search||address.hash||!publishableKey)throw error('CLOUD_CONFIG_ERROR','云服务 publicConfig 无效，请检查 endpoint 和 publishableKey。',503);
    const factory=options.createClient||window.WorkBuddyCloud?.createWorkBuddyCloud;
    if(typeof factory!=='function')throw error('CLOUD_SDK_MISSING','云服务 SDK 未能加载，请刷新页面或检查部署文件。',503);
    let client;
    try{
      const sdkOptions={endpoint:address.href.replace(/\/$/,''),publishableKey};
      // The app's editing token is independent of platform Auth. Do not inherit another app login.
      if(typeof window.WorkBuddyCloud?.createMemoryStorage==='function')sdkOptions.storage=window.WorkBuddyCloud.createMemoryStorage();
      client=factory(sdkOptions);
    }catch{throw error('CLOUD_CONFIG_ERROR','云服务初始化失败，请检查部署配置。',503);}
    if(!client?.database||typeof client.database.rpc!=='function')throw error('CLOUD_SDK_INVALID','云服务 SDK 版本不兼容，请检查部署文件。',503);
    async function rpc(name,args,kind){
      let result,timer,timedOut=false;
      const timeoutError=()=>error('REQUEST_TIMEOUT','云服务响应超时，操作结果尚未确认。请检查排期后重试；当前页面的编辑草稿会保留。',504);
      try{
        const query=client.database.rpc(name,args);
        // A lost response may still have committed. Never repeat a write or consume another code attempt.
        if(typeof query?.retry==='function')query.retry(false);
        const controller=new AbortController();
        if(typeof query?.abortSignal==='function')query.abortSignal(controller.signal);
        const deadline=new Promise((resolve,reject)=>{
          timer=setTimeout(()=>{timedOut=true;controller.abort();reject(timeoutError());},timeoutMs);
        });
        result=await Promise.race([query,deadline]);
      }catch{
        if(timedOut)throw timeoutError();
        throw error('NETWORK_ERROR','暂时无法连接云服务，请检查网络后重试。');
      }finally{if(timer!==undefined)clearTimeout(timer);}
      if(!isObject(result))throw invalid();
      if(result.error)throw databaseError(result);
      const body=result.data;
      if(!isObject(body)||typeof body.ok!=='boolean')throw invalid();
      if(!body.ok){
        if(!isObject(body.error)||typeof body.error.code!=='string'||!body.error.code||typeof body.error.message!=='string'||!body.error.message)throw invalid();
        const code=body.error.code,status=statuses[code]||(code.startsWith('INVALID_')?400:500),extra={};
        if(own(body,'latest')&&body.latest!==null)extra.latest=publicRecord(body.latest,args.p_id);
        if(code==='REVISION_CONFLICT'&&!extra.latest)throw invalid();
        if(Number.isFinite(body.error.retryAfter)&&body.error.retryAfter>=0)extra.retryAfter=Math.ceil(body.error.retryAfter);
        throw error(code,body.error.message,status,extra);
      }
      if(kind==='record')return publicRecord(body.data,args.p_id);
      if(kind==='session')return session(body.data);
      if(kind==='create')return {...publicRecord(body.data,args.p_id),session:session(body.data.session),...(own(body.data,'apiKey')?{apiKey:apiKey(body.data.apiKey)}:{})};
      if(kind==='presence')return presence(body.data);
      if(kind==='apiKey')return {apiKey:apiKey(body.data?.apiKey)};
      if(kind==='logout'){
        if(!isObject(body.data)||body.data.revoked!==true)throw invalid();
        return {revoked:true};
      }
      throw invalid();
    }
    return Object.freeze({
      get:id=>rpc('schedule_get_project',{p_id:validId(id)},'record'),
      create:({id,editCode,displayName,project})=>rpc('schedule_create_project',{p_id:validId(id),p_edit_code:editCode,p_display_name:displayName,p_project:project},'create'),
      unlock:(id,{editCode,displayName})=>rpc('schedule_unlock_project',{p_id:validId(id),p_edit_code:editCode,p_display_name:displayName},'session'),
      save:(id,{token,baseRevision,project})=>rpc('schedule_save_project',{p_id:validId(id),p_token:token,p_expected_revision:baseRevision,p_project:project},'record'),
      logout:(id,token)=>rpc('schedule_revoke_session',{p_id:validId(id),p_token:token},'logout'),
      presence:(id,token)=>rpc('schedule_list_presence',{p_id:validId(id),p_token:token},'presence'),
      heartbeat:(id,token)=>rpc('schedule_heartbeat',{p_id:validId(id),p_token:token},'presence'),
      resetApiKey:(id,editCode)=>rpc('schedule_reset_api_key',{p_id:validId(id),p_edit_code:editCode},'apiKey'),
      unlockExternal:(id,{apiKey,displayName='AI助手'})=>rpc('schedule_unlock_external',{p_id:validId(id),p_api_key:apiKey,p_display_name:displayName},'session'),
      applyAction:(id,{token,baseRevision,action})=>rpc('schedule_apply_action',{p_id:validId(id),p_token:token,p_expected_revision:baseRevision,p_action:action},'record'),
    });
  }
  return Object.freeze({create});
})();
