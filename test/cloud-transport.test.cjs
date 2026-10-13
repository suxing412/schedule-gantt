'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../frontend/scripts/cloud-transport.js'),'utf8');
const sdkSource=fs.readFileSync(path.join(__dirname,'../frontend/assets/workbuddy-sdk.js'),'utf8');
const id='a'.repeat(32),otherId='b'.repeat(32);
const project={tasks:[],groups:[],flags:[],meta:{title:'test'}};
const record=(revision=1)=>({id,revision,project,createdAt:'2026-10-10T00:00:00Z',updatedAt:'2026-10-10T00:00:00Z',updatedBy:'Editor'});
const session=()=>({token:'c'.repeat(64),displayName:'Editor',expiresAt:'2099-10-10T00:00:00Z'});
const clone=value=>JSON.parse(JSON.stringify(value));
function harness(handler,options={}){
  const calls=[],configs=[],window={...(options.origin?{location:{origin:options.origin}}:{})};
  const factory=config=>{configs.push(config);return {database:{rpc(name,args){calls.push({name,args});return handler(name,args);}}};};
  if(options.global)window.WorkBuddyCloud={createWorkBuddyCloud:factory,createMemoryStorage:()=>({getItem:()=>null,setItem(){},removeItem(){}})};
  vm.runInNewContext(source,{window,URL,AbortController,setTimeout,clearTimeout});
  const config={endpoint:'https://example.app.workbuddy.host',publishableKey:'wbpk_test',...options.config};
  const create=()=>window.WorkBuddyTransport.create({...config,...(!options.global?{createClient:factory}:{})});
  return {calls,configs,create,window};
}
const ok=data=>({data:{ok:true,data},error:null});
const failure=(code,message='expected error',extra={})=>({data:{ok:false,error:{code,message},...extra},error:null});

function realSdkHarness(handler){
  const calls=[],context={URL,Headers,Request,Response,AbortController,TextEncoder,TextDecoder,setTimeout,clearTimeout,setInterval,clearInterval,console,atob,btoa,location:new URL('https://deployed.app.workbuddy.host/')};
  context.fetch=async(url,init={})=>{
    const call={url:String(url),method:init.method,headers:Object.fromEntries(new Headers(init.headers)),body:init.body?JSON.parse(init.body):null};
    calls.push(call);
    const body=await handler(call);
    return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
  };
  context.window=context;context.self=context;
  vm.createContext(context);
  vm.runInContext(sdkSource,context,{filename:'workbuddy-sdk.js'});
  vm.runInContext(source,context,{filename:'cloud-transport.js'});
  return {calls,api:context.WorkBuddyTransport.create({publishableKey:'wbpk_app_testkey'})};
}

test('can be present in data-only script slices without a browser window',()=>{
  assert.doesNotThrow(()=>vm.runInNewContext(source,{}));
});

test('uses the vendored official SDK factory and supplied publicConfig',async()=>{
  const h=harness(()=>ok(record()),{global:true}),api=h.create();
  assert.deepEqual(clone(h.configs),[{endpoint:'https://example.app.workbuddy.host',publishableKey:'wbpk_test',storage:{}}]);
  assert.equal(typeof h.configs[0].storage.getItem,'function');
  assert.deepEqual(clone(await api.get(id)),record());
});

test('all five operations call their RPC with exact named parameters',async()=>{
  const h=harness(name=>ok(name==='schedule_create_project'?{...record(),session:session()}:name==='schedule_unlock_project'?session():name==='schedule_revoke_session'?{revoked:true}:record()));
  const api=h.create();
  await api.get(id);
  assert.deepEqual(clone(await api.create({id,editCode:'0042',displayName:'Editor',project})),{...record(),session:session()});
  assert.deepEqual(clone(await api.unlock(id,{editCode:'0042',displayName:'Editor'})),session());
  await api.save(id,{token:session().token,baseRevision:1,project});
  assert.deepEqual(clone(await api.logout(id,session().token)),{revoked:true});
  assert.deepEqual(clone(h.calls),[
    {name:'schedule_get_project',args:{p_id:id}},
    {name:'schedule_create_project',args:{p_id:id,p_edit_code:'0042',p_display_name:'Editor',p_project:project}},
    {name:'schedule_unlock_project',args:{p_id:id,p_edit_code:'0042',p_display_name:'Editor'}},
    {name:'schedule_save_project',args:{p_id:id,p_token:session().token,p_expected_revision:1,p_project:project}},
    {name:'schedule_revoke_session',args:{p_id:id,p_token:session().token}},
  ]);
});

test('preserves conflict status and validates the latest public record',async()=>{
  const api=harness(()=>failure('REVISION_CONFLICT','new version',{latest:record(3)})).create();
  await assert.rejects(api.save(id,{token:'token',baseRevision:1,project}),e=>e.code==='REVISION_CONFLICT'&&e.status===409&&e.latest.revision===3);
});

test('wrong/expired session and not-found errors retain statuses used by shared UI',async()=>{
  for(const [code,status] of [['UNAUTHORIZED',401],['INVALID_EDIT_CODE',401],['SESSION_EXPIRED',401],['INVALID_SESSION',401],['NOT_FOUND',404],['INVALID_PROJECT',400],['VALIDATION_ERROR',400]]){
    const api=harness(()=>failure(code)).create();
    await assert.rejects(api.get(id),e=>e.code===code&&e.status===status);
  }
});

test('rate-limit errors retain retry delay without issuing another RPC',async()=>{
  const h=harness(()=>({data:{ok:false,error:{code:'RATE_LIMITED',message:'稍后重试',retryAfter:12.1}},error:null}));
  await assert.rejects(h.create().unlock(id,{editCode:'0042',displayName:'Editor'}),e=>e.status===429&&e.retryAfter===13);
  assert.equal(h.calls.length,1);
});

test('SDK rejection and network error responses fail closed with safe messages',async()=>{
  for(const handler of [()=>Promise.reject(new Error('secret db detail')),()=>{throw new Error('secret db detail');},()=>({error:{message:'Failed to fetch'},status:0})]){
    const h=harness(handler);
    await assert.rejects(h.create().get(id),e=>e.code==='NETWORK_ERROR'&&!e.message.includes('secret'));
    assert.equal(h.calls.length,1);
  }
});

test('SDK database errors are sanitized and missing RPC reports deployment setup',async()=>{
  for(const [rpcError,status,expected] of [[{code:'PGRST202'},404,'CLOUD_NOT_READY'],[{code:'42883'},400,'CLOUD_NOT_READY'],[{code:'42501'},403,'CLOUD_PERMISSION_DENIED'],[{code:'XX000'},500,'DATABASE_ERROR']]){
    const api=harness(()=>({data:null,error:{...rpcError,message:'private table detail',details:'secret'},status})).create();
    await assert.rejects(api.get(id),e=>e.code===expected&&!e.message.includes('private')&&!e.message.includes('secret'));
  }
});

test('null, array, raw records, and malformed envelopes cannot become successful reads',async()=>{
  for(const result of [null,[],{},ok(null),{data:record(),error:null},{data:[],error:null},{data:{ok:'true',data:record()}},{data:{ok:false,error:{code:'BAD'}}}]){
    await assert.rejects(harness(()=>result).create().get(id),e=>e.code==='INVALID_RESPONSE');
  }
});

test('malformed or wrong-board public records are rejected',async()=>{
  for(const data of [{...record(),id:otherId},{...record(),revision:0},{...record(),revision:1.5},{...record(),project:null},{...record(),createdAt:'invalid'},{...record(),updatedBy:null},{...record(),edit_code_hash:'private'}]){
    await assert.rejects(harness(()=>ok(data)).create().get(id),e=>e.code==='INVALID_RESPONSE');
  }
});

test('a conflict cannot carry another board or omit its latest snapshot',async()=>{
  for(const extra of [{},{latest:{...record(),id:otherId}}]){
    await assert.rejects(harness(()=>failure('REVISION_CONFLICT','conflict',extra)).create().save(id,{token:'token',baseRevision:1,project}),e=>e.code==='INVALID_RESPONSE');
  }
});

test('invalid create and unlock sessions fail before the caller can store them',async()=>{
  for(const value of [null,{}, {...session(),token:''},{...session(),expiresAt:'invalid'},{...session(),displayName:''}]){
    await assert.rejects(harness(()=>ok(value)).create().unlock(id,{editCode:'1234',displayName:'Editor'}),e=>e.code==='INVALID_RESPONSE');
    await assert.rejects(harness(()=>ok({...record(),session:value})).create().create({id,editCode:'1234',displayName:'Editor',project}),e=>e.code==='INVALID_RESPONSE');
  }
});

test('logout requires explicit revocation acknowledgment',async()=>{
  for(const value of [null,true,{}, {revoked:false}]){
    await assert.rejects(harness(()=>ok(value)).create().logout(id,'token'),e=>e.code==='INVALID_RESPONSE');
  }
});

test('missing or unsafe runtime configuration fails before client initialization',()=>{
  for(const config of [{endpoint:''},{endpoint:'not a url'},{endpoint:'http://example.com'},{endpoint:'https://user:password@example.com'},{endpoint:'https://example.com?key=secret'},{endpoint:'https://example.com#fragment'},{publishableKey:''}]){
    const h=harness(()=>ok(record()),{config});
    assert.throws(h.create,e=>e.code==='CLOUD_CONFIG_ERROR');
    assert.equal(h.configs.length,0);
  }
});

test('localhost allows HTTP for local integration tests',async()=>{
  const h=harness(()=>ok(record()),{config:{endpoint:'http://127.0.0.1:3000'}});
  await h.create().get(id);
  assert.equal(h.calls.length,1);
});

test('omitted endpoint uses the current application origin and normalizes trailing slashes',()=>{
  const h=harness(()=>ok(record()),{origin:'https://current.app.workbuddy.host',config:{endpoint:''}});
  h.create();
  assert.equal(h.configs[0].endpoint,'https://current.app.workbuddy.host');
  const explicit=harness(()=>ok(record()),{config:{endpoint:'https://example.app.workbuddy.host/'}});
  explicit.create();
  assert.equal(explicit.configs[0].endpoint,'https://example.app.workbuddy.host');
});

test('disables SDK automatic retries before awaiting every RPC',async()=>{
  const retries=[],h=harness(()=>({retry:enabled=>retries.push(enabled),then:resolve=>resolve(ok(record()))}));
  await h.create().get(id);
  assert.deepEqual(retries,[false]);
  assert.equal(h.calls.length,1);
});

test('missing/broken SDKs fail closed without falling back to fetch',()=>{
  const window={};vm.runInNewContext(source,{window,URL});
  const config={endpoint:'https://example.com',publishableKey:'wbpk_test'};
  assert.throws(()=>window.WorkBuddyTransport.create(config),e=>e.code==='CLOUD_SDK_MISSING');
  assert.throws(()=>window.WorkBuddyTransport.create({...config,createClient:()=>{throw new Error('secret')}}),e=>e.code==='CLOUD_CONFIG_ERROR'&&!e.message.includes('secret'));
  assert.throws(()=>window.WorkBuddyTransport.create({...config,createClient:()=>({})}),e=>e.code==='CLOUD_SDK_INVALID');
});

test('invalid project IDs are never sent to an RPC',()=>{
  const h=harness(()=>ok(record())),api=h.create();
  for(const value of ['',null,'../projects',id.toUpperCase()])assert.throws(()=>api.get(value),e=>e.code==='INVALID_ID');
  assert.equal(h.calls.length,0);
});

test('times out an actual signal-aware pending mutation after one call',async()=>{
  let activeSignal,aborts=0,retries=[];
  const h=harness(()=>({
    retry(enabled){retries.push(enabled);return this;},
    abortSignal(signal){activeSignal=signal;return this;},
    then(resolve,reject){activeSignal.addEventListener('abort',()=>{aborts++;reject(new DOMException('aborted','AbortError'));},{once:true});},
  }),{config:{timeoutMs:10}});
  await assert.rejects(h.create().save(id,{token:session().token,baseRevision:1,project}),e=>e.code==='REQUEST_TIMEOUT'&&e.status===504&&e.message.includes('尚未确认'));
  assert.equal(h.calls.length,1);
  assert.equal(aborts,1);
  assert.equal(activeSignal.aborted,true);
  assert.deepEqual(retries,[false]);
});

test('also bounds a hung injected client without abortSignal support',async()=>{
  const h=harness(()=>new Promise(()=>{}),{config:{timeoutMs:10}});
  await assert.rejects(h.create().create({id,editCode:'0042',displayName:'Editor',project}),e=>e.code==='REQUEST_TIMEOUT'&&e.message.includes('尚未确认'));
  assert.equal(h.calls.length,1);
});

test('clears the timeout after success instead of aborting a completed query',async()=>{
  let activeSignal;
  const h=harness(()=>({
    retry(){return this;},abortSignal(signal){activeSignal=signal;return this;},
    then(resolve){resolve(ok(record()));},
  }),{config:{timeoutMs:10}});
  await h.create().get(id);
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(activeSignal.aborted,false);
});

test('official SDK sends actual RPC routes, access-key header, and named JSON parameters',async()=>{
  const h=realSdkHarness(call=>({ok:true,data:call.url.endsWith('schedule_unlock_project')?session():call.url.endsWith('schedule_create_project')?{...record(),session:session()}:record()}));
  await h.api.get(id);
  await h.api.create({id,editCode:'0042',displayName:'Editor',project});
  await h.api.unlock(id,{editCode:'0042',displayName:'Editor'});
  assert.deepEqual(h.calls.map(call=>call.url),[
    'https://deployed.app.workbuddy.host/.cloud/database/rest/rpc/schedule_get_project',
    'https://deployed.app.workbuddy.host/.cloud/database/rest/rpc/schedule_create_project',
    'https://deployed.app.workbuddy.host/.cloud/database/rest/rpc/schedule_unlock_project',
  ]);
  for(const call of h.calls){assert.equal(call.method,'POST');assert.equal(call.headers['x-wb-webapp-access-key'],'wbpk_app_testkey');}
  assert.deepEqual(h.calls[0].body,{p_id:id});
  assert.deepEqual(h.calls[1].body,{p_id:id,p_edit_code:'0042',p_display_name:'Editor',p_project:project});
  assert.deepEqual(h.calls[2].body,{p_id:id,p_edit_code:'0042',p_display_name:'Editor'});
});

test('official SDK keeps editor token in RPC arguments and does not impersonate platform Auth',async()=>{
  const h=realSdkHarness(call=>({ok:true,data:call.url.endsWith('schedule_revoke_session')?{revoked:true}:record(2)}));
  await h.api.save(id,{token:session().token,baseRevision:1,project});
  await h.api.logout(id,session().token);
  assert.equal(h.calls.length,2);
  assert.deepEqual(h.calls[0].body,{p_id:id,p_token:session().token,p_expected_revision:1,p_project:project});
  assert.deepEqual(h.calls[1].body,{p_id:id,p_token:session().token});
  for(const call of h.calls){assert.equal(call.headers.authorization,undefined);assert.equal(call.url.includes(session().token),false);}
});

test('official SDK handles business errors inside a normal HTTP 200 response without retrying',async()=>{
  const h=realSdkHarness(call=>call.url.endsWith('schedule_save_project')?{ok:false,error:{code:'REVISION_CONFLICT',message:'已有更新'},latest:record(3)}:{ok:false,error:{code:'INVALID_EDIT_CODE',message:'编辑码错误'}});
  await assert.rejects(h.api.unlock(id,{editCode:'0000',displayName:'Editor'}),e=>e.code==='INVALID_EDIT_CODE'&&e.status===401);
  await assert.rejects(h.api.save(id,{token:session().token,baseRevision:1,project}),e=>e.code==='REVISION_CONFLICT'&&e.status===409&&e.latest.revision===3);
  assert.equal(h.calls.length,2);
});

test('official SDK sends each read/write only once when the connection fails',async()=>{
  const h=realSdkHarness(()=>{throw new TypeError('network failure');});
  await assert.rejects(h.api.get(id),e=>e.code==='NETWORK_ERROR');
  await assert.rejects(h.api.save(id,{token:session().token,baseRevision:1,project}),e=>e.code==='NETWORK_ERROR');
  assert.equal(h.calls.length,2);
});

test('V2 RPC methods retain named arguments and one-time keys without weakening V1 compatibility',async()=>{
  const key='d'.repeat(64),members={members:[{displayName:'Editor',lastSeenAt:'2026-10-12T00:00:00Z',online:true,source:'human'}],onlineThresholdSeconds:60};
  const h=harness(name=>ok(name==='schedule_create_project'?{...record(),session:session(),apiKey:key}:name==='schedule_reset_api_key'?{apiKey:key}:name==='schedule_unlock_external'?{...session(),source:'external'}:name==='schedule_apply_action'?{...record(2),source:'external'}:members));
  const api=h.create(),action={name:'project.rename',arguments:{title:'New'}};
  assert.equal((await api.create({id,editCode:'1234',displayName:'Editor',project})).apiKey,key);
  assert.deepEqual(clone(await api.presence(id,session().token)),members);
  await api.heartbeat(id,session().token);
  assert.deepEqual(clone(await api.resetApiKey(id,'1234')),{apiKey:key});
  assert.equal((await api.unlockExternal(id,{apiKey:key})).source,'external');
  assert.equal((await api.applyAction(id,{token:session().token,baseRevision:1,action})).source,'external');
  assert.deepEqual(clone(h.calls.slice(1)),[
    {name:'schedule_list_presence',args:{p_id:id,p_token:session().token}},
    {name:'schedule_heartbeat',args:{p_id:id,p_token:session().token}},
    {name:'schedule_reset_api_key',args:{p_id:id,p_edit_code:'1234'}},
    {name:'schedule_unlock_external',args:{p_id:id,p_api_key:key,p_display_name:'AI助手'}},
    {name:'schedule_apply_action',args:{p_id:id,p_token:session().token,p_expected_revision:1,p_action:action}},
  ]);
});

test('presence rejects leaked credentials and malformed responses instead of rendering them',async()=>{
  const member={displayName:'Editor',lastSeenAt:'2026-10-12T00:00:00Z',online:true,source:'human'};
  for(const bad of [null,{members:null,onlineThresholdSeconds:60},{members:[member],onlineThresholdSeconds:0},...['token','token_hash','apiKey','api_key_hash','edit_code_hash'].map(key=>({members:[{...member,[key]:'secret'}],onlineThresholdSeconds:60})),{members:[{...member,source:'owner'}],onlineThresholdSeconds:60},{members:[{...member,lastSeenAt:'bad'}],onlineThresholdSeconds:60}]){
    await assert.rejects(harness(()=>ok(bad)).create().presence(id,'token'),{code:'INVALID_RESPONSE'});
  }
});

test('V2 secrets and sources are validated and missing migrations produce an actionable error',async()=>{
  for(const key of ['',null,'1234','x'.repeat(64)])await assert.rejects(harness(()=>ok({apiKey:key})).create().resetApiKey(id,'1234'),{code:'INVALID_RESPONSE'});
  for(const data of [{...record(),api_key_hash:'secret'},{...record(),source:'owner'}])await assert.rejects(harness(()=>ok(data)).create().get(id),{code:'INVALID_RESPONSE'});
  await assert.rejects(harness(()=>({error:{code:'PGRST202'},status:404})).create().heartbeat(id,'token'),error=>error.code==='CLOUD_NOT_READY'&&error.message.includes('迁移'));
  await assert.rejects(harness(()=>failure('INVALID_API_KEY')).create().unlockExternal(id,{apiKey:'0'.repeat(64)}),error=>error.status===401);
});
