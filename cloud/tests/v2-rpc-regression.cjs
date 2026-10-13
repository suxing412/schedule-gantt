'use strict';
// Run only against an explicitly disposable cluster. All DDL/data below is
// isolated in a random database that this process creates and owns.
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const pg = process.env.PSQL_BIN || 'psql';
const maintenanceDb = process.env.PGDATABASE || 'postgres';
const testDb = 'schedule_v2_test_' + crypto.randomBytes(10).toString('hex');
const migrations = ['001_schedule_rpc.sql','002_collab_external.sql','003_tool_actions.sql'];
const loadedMigrationSha256={};
const checks=[];
const project={tasks:[],groups:[],flags:[],meta:{title:'V2 independent PostgreSQL QA'}};
const id=crypto.randomBytes(16).toString('hex'), otherId=crypto.randomBytes(16).toString('hex');
const unknownId=crypto.randomBytes(16).toString('hex');
let databaseCreated=false, humanToken, externalToken, otherToken, apiKey, otherKey, revision=1;
const quote=v=>"'"+String(v).replaceAll("'","''")+"'";
const value=v=>v===null?'NULL':typeof v==='number'?String(v):typeof v==='object'?quote(JSON.stringify(v))+'::jsonb':quote(v);
const safe = s=>String(s).replace(/\b[a-f0-9]{64}\b/g,'[redacted credential/digest]');
function sql(statement,database=testDb) {return new Promise((resolve,reject)=>{
  const child=spawn(pg,['-X','-d',database,'-v','ON_ERROR_STOP=1','-Atq'],{windowsHide:true,env:process.env});
  let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
  child.on('error',reject);child.on('exit',code=>code?reject(new Error(safe(err))):resolve(out.trim()));
  child.stdin.end(statement);
});}
async function rpc(name,args,headers={},method='POST') {
  const result=await sql("BEGIN; SET LOCAL ROLE anon; SET LOCAL \"request.method\"="+quote(method)+"; SET LOCAL \"request.headers\"="+quote(JSON.stringify(headers))+"; SELECT public."+name+"("+args.map(value).join(',')+"); COMMIT;");
  return JSON.parse(result);
}
function ok(r){assert.equal(r.ok,true,safe(JSON.stringify(r)));return r.data;}
function error(r,code){assert.equal(r.ok,false,safe(JSON.stringify(r)));assert.equal(r.error.code,code);return r.error;}
async function check(name,fn){await fn();checks.push({name,ok:true});console.log('PASS '+name);}
async function migrate(name){
  const source=fs.readFileSync(path.join(__dirname,'../migrations',name),'utf8');
  await sql(source);loadedMigrationSha256[name]=crypto.createHash('sha256').update(source).digest('hex');
}
async function resetBudgets(){await sql("UPDATE schedule_private.request_budgets SET window_start=clock_timestamp()-interval '2 hours';");}
async function attempts(key){return Number(await sql("SELECT COALESCE((SELECT attempts FROM schedule_private.request_budgets WHERE budget_key="+quote(key)+"),0);"));}
async function read(){return ok(await rpc('schedule_get_project',[id]));}
async function unlock(){const r=ok(await rpc('schedule_unlock_external',[id,apiKey,'AI 同名']));externalToken=r.token;return r;}
async function currentRevision(){return (await read()).revision;}
function assertPublic(record) {
  assert.ok(!Object.keys(record).some(k=>/hash|token|apikey|session/i.test(k)));
  for(const secret of [humanToken,externalToken,apiKey,otherKey]) if(secret) assert.ok(!JSON.stringify(record).includes(secret));
}
function writeReport(report) {
  const content=JSON.stringify(report,null,2);
  if(process.env.RPC_TEST_REPORT) {
    const output=path.resolve(process.env.RPC_TEST_REPORT),allowed=path.resolve(__dirname,'results');
    if(path.dirname(output)!==allowed || !/^v2-[a-z0-9-]+\.json$/.test(path.basename(output))) throw new Error('RPC_TEST_REPORT must be cloud/tests/results/v2-*.json');
    fs.mkdirSync(allowed,{recursive:true});fs.writeFileSync(output,content+'\n');
  }
  console.log(content);
}
async function authChecks(){
  await check('V1 data and sessions survive V2 upgrade; legacy API digest is initialized privately',async()=>{
    const r=await read();assert.equal(r.revision,1);assert.deepEqual(r.project,project);assert.equal(r.source,'human');
    assert.equal(await sql("SELECT api_key_hash ~ '^[a-f0-9]{64}$' FROM schedule_private.projects WHERE id="+quote(id)),'t');
    const p=ok(await rpc('schedule_list_presence',[id,humanToken]));assert.equal(p.members.length,1);assert.equal(p.members[0].source,'human');
  });
  await check('legacy PIN reset issues the first usable key; create returns one-time API key',async()=>{
    apiKey=ok(await rpc('schedule_reset_api_key',[id,'1234'])).apiKey;assert.match(apiKey,/^[a-f0-9]{64}$/);
    const r=ok(await rpc('schedule_create_project',[otherId,'4321','Other owner',project]));otherKey=r.apiKey;otherToken=r.session.token;
    assert.match(otherKey,/^[a-f0-9]{64}$/);assert.equal(r.session.source,'human');
    assert.equal(await sql("SELECT api_key_hash=schedule_private.token_digest("+quote(apiKey)+") AND api_key_hash<>"+quote(apiKey)+" FROM schedule_private.projects WHERE id="+quote(id)),'t');
  });
  await check('V2 migration is idempotent and preserves key, board, and both session kinds',async()=>{
    await unlock();const digest=await sql("SELECT api_key_hash FROM schedule_private.projects WHERE id="+quote(id));
    await migrate(migrations[1]);
    assert.equal(await sql("SELECT api_key_hash FROM schedule_private.projects WHERE id="+quote(id)),digest);
    assert.equal((await read()).revision,1);
    assert.equal(ok(await rpc('schedule_list_presence',[id,humanToken])).members.length,2);
    assert.equal(ok(await rpc('schedule_list_presence',[id,externalToken])).members.length,2);
  });
  await check('public records never reveal API key, hash, or sessions; anonymous private access is denied',async()=>{
    assertPublic(await read());
    for(const table of ['projects','sessions','request_budgets']) await assert.rejects(sql('SET ROLE anon; SELECT * FROM schedule_private.'+table),/permission denied/);
    for(const signature of ['schedule_private.authorize_external(text,text)','schedule_private.issue_session(text,text,text)','schedule_private.reserve_external_request(text)']) {
      assert.equal(await sql("SELECT has_function_privilege('anon',"+quote(signature)+",'EXECUTE'),has_function_privilege('authenticated',"+quote(signature)+",'EXECUTE')"),'f|f');
    }
    assert.equal(await sql("SELECT to_regprocedure('public.schedule_list_presence(text)') IS NULL"),'t');
  });
  await check('wrong API key, cross-board key, malformed key, and expired token are rejected',async()=>{
    error(await rpc('schedule_unlock_external',[id,'f'.repeat(64),'Wrong']),'INVALID_API_KEY');
    error(await rpc('schedule_unlock_external',[id,otherKey,'Cross board']),'INVALID_API_KEY');
    error(await rpc('schedule_unlock_external',[id,'1234','Malformed']),'INVALID_API_KEY');
    const expired=ok(await rpc('schedule_unlock_external',[id,apiKey,'Expired']));
    await sql("UPDATE schedule_private.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=schedule_private.token_digest("+quote(expired.token)+")");
    error(await rpc('schedule_list_presence',[id,expired.token]),'UNAUTHORIZED');
  });
  await check('presence requires a valid board-bound session and returns only safe member fields',async()=>{
    for(const args of [[id,null],[id,'f'.repeat(64)],[id,otherToken],[unknownId,humanToken]]) error(await rpc('schedule_list_presence',args),'UNAUTHORIZED');
    const r=ok(await rpc('schedule_list_presence',[id,humanToken]));assert.equal(r.onlineThresholdSeconds,60);
    for(const member of r.members) {
      assert.deepEqual(Object.keys(member).sort(),['displayName','lastSeenAt','online','source']);
      assert.ok(Number.isFinite(Date.parse(member.lastSeenAt)));assert.equal(typeof member.online,'boolean');
    }
    assertPublic(r);
  });
  await check('same nicknames remain separate; offline holders and heartbeat are accurate without project writes',async()=>{
    const a=ok(await rpc('schedule_unlock_project',[id,'1234','Same nickname']));
    const b=ok(await rpc('schedule_unlock_project',[id,'1234','Same nickname']));
    await sql("UPDATE schedule_private.sessions SET last_seen=clock_timestamp()-interval '2 minutes' WHERE token_hash=schedule_private.token_digest("+quote(a.token)+")");
    let r=ok(await rpc('schedule_list_presence',[id,b.token]));
    assert.equal(r.members.filter(m=>m.displayName==='Same nickname').length,2);
    assert.equal(r.members.filter(m=>m.displayName==='Same nickname'&&!m.online).length,1);
    const before=await read();
    r=ok(await rpc('schedule_heartbeat',[id,a.token]));
    assert.ok(r.members.filter(m=>m.displayName==='Same nickname').every(m=>m.online));
    assert.deepEqual(await read(),before);
  });
  await check('external sessions cannot call legacy save and human writes keep source human',async()=>{
    error(await rpc('schedule_save_project',[id,externalToken,1,project]),'FORBIDDEN');
    const r=ok(await rpc('schedule_save_project',[id,humanToken,1,project]));assert.equal(r.source,'human');revision=r.revision;
  });
  await check('external rate limits serialize concurrent requests and do not consume human PIN budget',async()=>{
    await resetBudgets();
    const before=await attempts('unlock:'+id);
    const rs=await Promise.all(Array.from({length:64},()=>rpc('schedule_unlock_external',[id,'f'.repeat(64),'Wrong'])));
    assert.equal(rs.filter(r=>r.error?.code==='INVALID_API_KEY').length,60);
    assert.equal(rs.filter(r=>r.error?.code==='RATE_LIMITED').length,4);
    assert.equal(await attempts('external:global'),60);assert.equal(await attempts('external:'+id),60);
    assert.equal(await attempts('unlock:'+id),before);
    assert.equal(ok(await rpc('schedule_unlock_project',[id,'1234','Human during API throttle'])).source,'human');
    error(await rpc('schedule_unlock_external',[id,apiKey,'Locked API']),'RATE_LIMITED');
    await resetBudgets();
  });
  await check('presence has an independent budget and cannot exhaust edit-code or external budgets',async()=>{
    await rpc('schedule_list_presence',[id,humanToken]);
    await sql("UPDATE schedule_private.request_budgets SET attempts=600 WHERE budget_key="+quote('presence:'+id));
    error(await rpc('schedule_heartbeat',[id,humanToken]),'RATE_LIMITED');
    assert.equal(ok(await rpc('schedule_unlock_project',[id,'1234','Human during presence throttle'])).source,'human');
    await unlock();await resetBudgets();
  });
  await check('wrong PIN reset persists failure counts; unsupported rollback headers do not run authorization',async()=>{
    await resetBudgets();
    error(await rpc('schedule_reset_api_key',[id,'9999']),'INVALID_EDIT_CODE');
    assert.equal(await attempts('unlock:'+id),1);
    for(const [name,args] of [
      ['schedule_reset_api_key',[id,'1234']],
      ['schedule_unlock_external',[id,apiKey,'AI']],
      ['schedule_heartbeat',[id,humanToken]],
      ['schedule_revoke_session',[id,humanToken]]
    ]) error(await rpc(name,args,{prefer:'tx=rollback'}),'UNSUPPORTED_REQUEST');
    assert.equal(await attempts('unlock:'+id),1);
    error(await rpc('schedule_unlock_external',[id,apiKey,'AI'],{},'GET'),'UNSUPPORTED_REQUEST');
  });
  await check('key reset invalidates all external sessions and old key while preserving human access and revision',async()=>{
    const second=ok(await rpc('schedule_unlock_external',[id,apiKey,'Second AI']));
    const oldKey=apiKey,before=await currentRevision();
    apiKey=ok(await rpc('schedule_reset_api_key',[id,'1234'])).apiKey;assert.notEqual(apiKey,oldKey);
    for(const t of [externalToken,second.token]) error(await rpc('schedule_heartbeat',[id,t]),'UNAUTHORIZED');
    error(await rpc('schedule_unlock_external',[id,oldKey,'Old key']),'INVALID_API_KEY');
    assert.equal(ok(await rpc('schedule_list_presence',[id,humanToken])).onlineThresholdSeconds,60);
    assert.equal(await currentRevision(),before);await unlock();
  });
  await check('concurrent reset and old-key exchange cannot leave an authorized old-key session behind',async()=>{
    for(let i=0;i<4;i++) {
      const oldKey=apiKey;
      const [reset,exchange]=await Promise.all([
        rpc('schedule_reset_api_key',[id,'1234']),
        rpc('schedule_unlock_external',[id,oldKey,'Race AI'])
      ]);
      apiKey=ok(reset).apiKey;
      if(exchange.ok) error(await rpc('schedule_heartbeat',[id,exchange.data.token]),'UNAUTHORIZED');
      else error(exchange,'INVALID_API_KEY');
      error(await rpc('schedule_unlock_external',[id,oldKey,'After reset']),'INVALID_API_KEY');
    }
    await unlock();
  });
  await check('session cap bounds holders to fifty; external revoke removes only its own session',async()=>{
    await resetBudgets();
    for(let i=0;i<51;i++) humanToken=ok(await rpc('schedule_unlock_project',[id,'1234','Cap '+i])).token;
    await unlock();
    assert.equal(ok(await rpc('schedule_list_presence',[id,humanToken])).members.length,50);
    assert.equal(ok(await rpc('schedule_revoke_session',[id,externalToken])).revoked,true);
    error(await rpc('schedule_list_presence',[id,externalToken]),'UNAUTHORIZED');
    assert.equal(ok(await rpc('schedule_list_presence',[id,humanToken])).members.length,49);
    await unlock();await resetBudgets();
  });
  await check('forced outer rollback remains a deployment boundary and is reported explicitly',async()=>{
    await rpc('schedule_reset_api_key',[id,'1234']);
    const before=await attempts('unlock:'+id);
    await sql("BEGIN; SET LOCAL ROLE anon; SELECT public.schedule_reset_api_key("+quote(id)+",'9999'); ROLLBACK;");
    assert.equal(await attempts('unlock:'+id),before);
    apiKey=ok(await rpc('schedule_reset_api_key',[id,'1234'])).apiKey;
    await unlock();
  });
}
async function actionChecks(){
  const {applyOperations,operationDefinitions}=require('../ai/operations.cjs');
  const op=(name,args)=>({name,arguments:args});
  const seen=new Set();
  async function action(action,token=externalToken,expected=revision) {
    return rpc('schedule_apply_action',[id,token,expected,action]);
  }
  async function parity(name,args) {
    const before=await read();revision=before.revision;
    const expected=applyOperations(before.project,[op(name,args)]);
    const result=ok(await action(op(name,args)));
    assert.deepEqual(result.project,expected.project,name+' project parity');
    assert.deepEqual(result.results,expected.results,name+' result parity');
    assert.equal(result.changed,expected.changed,name+' changed parity');
    assert.equal(result.revision,before.revision+(expected.changed?1:0));
    if(expected.changed){assert.equal(result.source,'external');assert.equal(result.updatedBy,'AI 同名');}
    assertPublic({...result});
    revision=result.revision;seen.add(name);return result;
  }
  const task=(id,extra={})=>({id,name:id,type:'task',pid:null,s:'2026-10-12',e:'2026-10-16',pct:0,who:'QA',grp:'策划',phase:'规划',deps:[],flow:false,lane:0,...extra});
  const base={
    tasks:[
      task('p',{name:'父任务',flow:true,extension:{keep:true}}),
      task('a',{pid:'p',e:'2026-10-14',pct:50,customValues:{cf_note:'保留'}}),
      task('b',{pid:'p',s:'2026-10-15',deps:['a']}),
      task('t',{grp:'程序',phase:'交付'})
    ],
    groups:[{name:'策划',color:'#2f6fe8'},{name:'程序',color:'#abcdef'}],
    flags:[{id:'f0',name:'初始里程碑',d:'2026-10-20',color:'#ff0000'}],
    meta:{title:'Actions fixture',customFields:[{id:'cf_note',name:'备注',type:'text'}],extension:{retain:['安全扩展']}}
  };
  await check('action migration reruns without replacing data, keys, or sessions',async()=>{
    const before=await read(),digest=await sql("SELECT api_key_hash FROM schedule_private.projects WHERE id="+quote(id));
    await migrate(migrations[2]);
    assert.deepEqual(await read(),before);
    assert.equal(await sql("SELECT api_key_hash FROM schedule_private.projects WHERE id="+quote(id)),digest);
    assert.equal(ok(await rpc('schedule_list_presence',[id,externalToken])).onlineThresholdSeconds,60);
    assert.equal(await sql("SELECT has_function_privilege('anon','schedule_private.tool_apply(jsonb,jsonb)','EXECUTE')"),'f');
  });
  await check('action RPC rejects missing, human, expired, and cross-board sessions before applying changes',async()=>{
    revision=await currentRevision();const before=await read();
    const update=op('project.update',{patch:{title:'Unauthorized'}});
    error(await action(update,'f'.repeat(64)),'UNAUTHORIZED');
    error(await action(update,humanToken),'FORBIDDEN');
    error(await action(update,otherToken),'UNAUTHORIZED');
    const expired=ok(await rpc('schedule_unlock_external',[id,apiKey,'Expiring AI']));
    await sql("UPDATE schedule_private.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=schedule_private.token_digest("+quote(expired.token)+")");
    error(await action(update,expired.token),'UNAUTHORIZED');
    assert.deepEqual(await read(),before);await resetBudgets();
  });
  const cases=[
    ['project.replace',{project:base,confirm:true}],
    ['project.update',{patch:{title:'完整动作覆盖'}}],
    ['role.add',{name:'QA',color:'#abcdef'}],
    ['role.update',{name:'QA',patch:{name:'测试',color:'#fedcba'}}],
    ['task.add',{task:task('x',{pid:'p',grp:'测试',phase:'规划'}),beforeId:'b'}],
    ['task.update',{id:'x',patch:{name:'质量检查',who:'AI',pct:40,s:'2026-10-13',e:'2026-10-17'}}],
    ['task.move',{id:'x',parentId:null,beforeId:'t'}],
    ['task.reorder',{parentId:null,ids:['t','p','x']}],
    ['task.shift',{ids:['p','a'],days:2}],
    ['task.duplicate',{id:'p',idMap:{p:'p2',a:'a2',b:'b2'}}],
    ['dependency.add',{taskId:'t',dependsOn:'x'}],
    ['dependency.remove',{taskId:'t',dependsOn:'x'}],
    ['dependency.set',{taskId:'t',deps:['a']}],
    ['phase.rename',{name:'规划',newName:'开发'}],
    ['phase.remove',{name:'开发'}],
    ['field.add',{field:{id:'cf_priority',name:'优先级',type:'select',options:[{id:'fo_high',label:'高'},{id:'fo_low',label:'低'}]}}],
    ['field.values.set',{taskId:'x',values:{cf_priority:'fo_high',cf_note:'优先处理'}}],
    ['field.update',{id:'cf_priority',patch:{name:'任务优先级',options:[{id:'fo_low',label:'较低'}]}}],
    ['field.remove',{id:'cf_priority'}],
    ['flag.add',{flag:{id:'f1',name:'新增节点',d:'2026-10-22'}}],
    ['flag.update',{id:'f1',patch:{name:'修改节点',d:'2026-10-23',color:'#aabbcc'}}],
    ['flag.remove',{id:'f1'}],
    ['project.shift',{days:3}],
    ['role.remove',{name:'测试',replacement:'策划'}],
    ['task.remove',{ids:['p2'],cascade:true}]
  ];
  for(const [name,args] of cases) await check('SQL/JavaScript parity: '+name,()=>parity(name,args));
  await check('all catalog mutation names are exercised; deleted options and internal duplicate dependencies are handled',async()=>{
    assert.deepEqual([...seen].sort(),operationDefinitions.map(d=>d.name).sort());
    const state=await read();
    assert.equal(state.project.tasks.find(t=>t.id==='x').customValues.cf_priority,undefined);
    assert.equal(state.project.tasks.find(t=>t.id==='x').customValues.cf_note,'优先处理');
    assert.equal(state.project.tasks.find(t=>t.id==='x').grp,'策划');
    assert.ok(state.project.tasks.every(t=>!['p2','a2','b2'].includes(t.id)));
  });
  await check('field types, trimming, select cleanup, short colors, and role/phase whitespace match JavaScript',async()=>{
    await resetBudgets();
    await parity('task.shift',{ids:['a','p'],days:1});
    const preserved=(await read()).project;
    await parity('role.update',{name:'策划',patch:{name:'策划新',color:'#123'}});
    await parity('role.remove',{name:'策划新',replacement:'程序'});
    await parity('project.replace',{project:preserved,confirm:true});
    await parity('role.add',{name:' QA 空格 ',color:'#abc'});
    await parity('task.update',{id:'x',patch:{grp:' QA 空格 ',phase:' 阶段空格 '}});
    await parity('role.update',{name:' QA 空格 ',patch:{name:' 新职能 ',color:'#def'}});
    await parity('phase.rename',{name:' 阶段空格 ',newName:' 新阶段 '});
    await parity('phase.remove',{name:' 新阶段 '});
    await parity('role.remove',{name:' 新职能 ',replacement:''});
    await parity('field.add',{field:{id:'cf_select',name:'  级别  ',type:'select',options:[{id:'fo_one',label:' 一 '},{id:'fo_two',label:' 二 '}]}});
    await parity('field.add',{field:{id:'cf_number',name:'工时',type:'number'}});
    await parity('field.add',{field:{id:'cf_date',name:'验收日',type:'date'}});
    await parity('field.add',{field:{id:'cf_check',name:'确认',type:'checkbox'}});
    await parity('field.values.set',{taskId:'x',values:{cf_select:'fo_one',cf_number:3.5,cf_date:'2026-10-25',cf_check:true}});
    await parity('field.values.set',{taskId:'x',values:{cf_number:null,cf_check:false}});
    await parity('field.update',{id:'cf_select',patch:{options:[{id:'fo_two',label:'保留'}]}});
    assert.equal((await read()).project.tasks.find(t=>t.id==='x').customValues.cf_select,undefined);
    await parity('flag.add',{flag:{id:'short-color',name:'颜色',d:'2026-10-26',color:'#def'}});
    await parity('flag.remove',{id:'short-color'});
  });
  await check('an atomic batch permits forward references and increments the revision only once',async()=>{
    await resetBudgets();const before=await read();revision=before.revision;
    const operations=[
      op('task.add',{task:task('forward-child',{pid:'forward-parent',deps:['forward-dependency']})}),
      op('task.add',{task:task('forward-parent')}),
      op('task.add',{task:task('forward-dependency')}),
      op('project.update',{patch:{title:'原子批次'}})
    ];
    const expected=applyOperations(before.project,operations),result=ok(await action({operations}));
    assert.deepEqual(result.project,expected.project);assert.deepEqual(result.results,expected.results);
    assert.equal(result.revision,before.revision+1);revision=result.revision;
  });
  await check('batch failure rolls back every project change while committing its external budget reservation',async()=>{
    const before=await read(),budgetBefore=await attempts('external:'+id);
    const operations=[
      op('project.update',{patch:{title:'MUST NOT PERSIST'}}),
      op('task.update',{id:'a',patch:{s:'2026-02-30'}})
    ];
    error(await action({operations}),'VALIDATION_ERROR');
    assert.deepEqual(await read(),before);assert.equal(await attempts('external:'+id),budgetBefore+1);
    const bad=[op('project.update',{patch:{title:'ALSO NO'}}),op('task.remove',{ids:['does-not-exist']})];
    error(await action({operations:bad}),'ITEM_NOT_FOUND');assert.deepEqual(await read(),before);
    assert.equal(await attempts('external:'+id),budgetBefore+2);
  });
  await check('SQL and JavaScript reject invalid dates, dependency cycles, hierarchy cycles, field misuse, and unsafe properties',async()=>{
    const invalid=[
      op('task.update',{id:'a',patch:{s:'2026-02-30'}}),
      op('dependency.set',{taskId:'a',deps:['b']}),
      op('dependency.set',{taskId:'a',deps:['a']}),
      op('task.move',{id:'p',parentId:'a'}),
      op('task.update',{id:'p',patch:{pct:99}}),
      op('task.remove',{ids:['p']}),
      op('task.update',{id:'a',patch:{customValues:{cf_missing:'x'}}}),
      op('field.update',{id:'cf_note',patch:{type:'number'}}),
      op('field.add',{field:{id:'cf_note2',name:'备注',type:'text'}}),
      op('field.add',{field:{id:'cf_reserved',name:'名称',type:'text'}}),
      op('field.add',{field:{id:'cf_no_options',name:'空选项',type:'select'}}),
      op('field.add',{field:{id:'cf_duplicate_labels',name:'重复选项',type:'select',options:[{id:'fo_a',label:'Same'},{id:'fo_b',label:' same '}]}}),
      op('field.values.set',{taskId:'x',values:{cf_date:'2026-02-30'}}),
      op('field.values.set',{taskId:'x',values:{cf_check:'true'}}),
      op('field.values.set',{taskId:'x',values:{cf_number:'3'}}),
      op('role.remove',{name:'策划'}),
      op('task.reorder',{parentId:'p',ids:['a']}),
      op('task.duplicate',{id:'p',idMap:{p:'z'}}),
      op('project.replace',{project:base}),
      op('not.an.operation',{}),
      JSON.parse('{"name":"task.update","arguments":{"id":"a","patch":{"customValues":{"__proto__":{"polluted":true}}}}}')
    ];
    const before=await read();
    for(const item of invalid) {
      let expected;try{applyOperations(before.project,[item]);}catch(e){expected=e.code;}
      assert.ok(expected,'Fixture must reject '+item.name);
      const response=await action(item);
      assert.equal(response.ok,false,item.name+' should reject');
      assert.equal(response.error.code,expected,JSON.stringify(item)+' error parity');
      assert.deepEqual(await read(),before);
    }
    assert.equal({}.polluted,undefined);
  });
  await check('empty, overlarge, and malformed batches are rejected without state changes',async()=>{
    const before=await read();
    for(const payload of [null,[],{operations:[]},{operations:Array.from({length:101},()=>op('project.shift',{days:0}))},{operations:[op('project.shift',{days:0})],extra:true}]) {
      error(await action(payload),'VALIDATION_ERROR');assert.deepEqual(await read(),before);
    }
  });
  await check('no-op actions preserve the revision and a real edit records the external author',async()=>{
    const before=await read();
    const noChange=ok(await action(op('project.update',{patch:{title:before.project.meta.title}})));
    assert.equal(noChange.changed,false);assert.equal(noChange.revision,before.revision);
    assert.equal(noChange.updatedAt,before.updatedAt);
    const changed=ok(await action(op('project.update',{patch:{title:'AI 作者来源'}})));
    assert.equal(changed.changed,true);assert.equal(changed.source,'external');assert.equal(changed.updatedBy,'AI 同名');revision=changed.revision;
    const human=ok(await rpc('schedule_save_project',[id,humanToken,revision,changed.project]));
    assert.equal(human.source,'human');revision=human.revision;
  });
  await check('twenty concurrent actions at one revision have exactly one winner and nineteen safe conflicts',async()=>{
    await resetBudgets();const initial=await currentRevision();revision=initial;
    const rs=await Promise.all(Array.from({length:20},(_,i)=>action(op('project.update',{patch:{title:'Concurrent action '+i}}),externalToken,initial)));
    assert.equal(rs.filter(r=>r.ok).length,1);assert.equal(rs.filter(r=>r.error?.code==='REVISION_CONFLICT').length,19);
    for(const r of rs.filter(r=>!r.ok)){assert.equal(r.latest.revision,initial+1);assertPublic(r.latest);}
    revision=await currentRevision();assert.equal(revision,initial+1);
  });
  await check('revocation racing an action cannot authorize later writes with the revoked session',async()=>{
    const [revoked,written]=await Promise.all([
      rpc('schedule_revoke_session',[id,externalToken]),
      action(op('project.update',{patch:{title:'Revocation race'}}))
    ]);
    ok(revoked);if(!written.ok) error(written,'UNAUTHORIZED');
    revision=await currentRevision();
    error(await action(op('project.update',{patch:{title:'MUST NOT WRITE'}})),'UNAUTHORIZED');
    await unlock();
  });
  await check('key rotation racing an action cannot leave an old external token able to write',async()=>{
    const [reset,written]=await Promise.all([
      rpc('schedule_reset_api_key',[id,'1234']),
      action(op('project.update',{patch:{title:'Key rotation race'}}))
    ]);
    apiKey=ok(reset).apiKey;if(!written.ok) error(written,'UNAUTHORIZED');
    revision=await currentRevision();
    error(await action(op('project.update',{patch:{title:'MUST NOT WRITE'}})),'UNAUTHORIZED');
    assert.equal(ok(await rpc('schedule_list_presence',[id,humanToken])).onlineThresholdSeconds,60);
    await unlock();
  });
  await check('action rollback preferences are rejected before consuming budget or changing state',async()=>{
    const before=await read(),budgetBefore=await attempts('external:'+id);
    error(await rpc('schedule_apply_action',[id,externalToken,revision,op('project.shift',{days:1})],{prefer:'tx=rollback'}),'UNSUPPORTED_REQUEST');
    assert.deepEqual(await read(),before);assert.equal(await attempts('external:'+id),budgetBefore);
  });
}
(async()=>{
  if(process.env.SCHEDULE_TEST_DB!=='1') throw new Error('Set SCHEDULE_TEST_DB=1 for a disposable PostgreSQL cluster; this script only creates/drops its own random database and does not test WorkBuddy deployment.');
  assert.equal(await sql("SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated');",maintenanceDb),'2');
  await sql('CREATE DATABASE "'+testDb+'"',maintenanceDb);databaseCreated=true;console.log('Disposable V2 database: '+testDb);
  if(process.env.PGCRYPTO_TEST_PUBLIC==='1') await sql('CREATE EXTENSION pgcrypto WITH SCHEMA public');
  await migrate(migrations[0]);
  humanToken=ok(await rpc('schedule_create_project',[id,'1234','Legacy human',project])).session.token;
  await migrate(migrations[1]);
  await authChecks();
  if(process.env.V2_AUTH_ONLY!=='1') {await migrate(migrations[2]);await actionChecks();}
  writeReport({ok:true,completedAt:new Date().toISOString(),scope:process.env.V2_AUTH_ONLY==='1'?'V2 authentication and presence only':'V2 authentication, presence, and action RPC',postgres:await sql('SHOW server_version'),pgcryptoMode:process.env.PGCRYPTO_TEST_PUBLIC==='1'?'existing public extension':'fresh private extension',migrationSha256:loadedMigrationSha256,checks,limitation:'Real isolated PostgreSQL only. WorkBuddy/PostgREST gateway transaction-commit and forced-rollback configuration require separate deployment verification. No live board was modified.'});
})().catch(e=>{writeReport({ok:false,checks,error:safe(e.stack||e.message)});process.exitCode=1;}).finally(async()=>{
  if(databaseCreated&&/^schedule_v2_test_[a-f0-9]{20}$/.test(testDb)) {
    try{await sql('DROP DATABASE "'+testDb+'"',maintenanceDb);}
    catch(e){console.error('Unable to remove this run disposable database '+testDb+': '+safe(e.message));process.exitCode=1;}
  }
});
