'use strict';
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const pg = process.env.PSQL_BIN || 'psql';
const maintenanceDb = process.env.PGDATABASE || 'postgres';
const testDb = 'schedule_rpc_test_' + crypto.randomBytes(10).toString('hex');
const migration = path.join(__dirname, '../migrations/001_schedule_rpc.sql');
let databaseCreated = false;
const checks=[];
const quote=v=>"'"+String(v).replaceAll("'","''")+"'";
const value=v=>typeof v==='number'?String(v):typeof v==='object'?quote(JSON.stringify(v))+'::jsonb':quote(v);
function sql(statement, database = testDb) { return new Promise((resolve,reject)=> {
  const child=spawn(pg,['-X','-d',database,'-v','ON_ERROR_STOP=1','-Atq'],{windowsHide:true,env:process.env});
  let out='',err=''; child.stdout.on('data',x=>out+=x); child.stderr.on('data',x=>err+=x);
  child.on('error',reject); child.on('exit',code=>code?reject(Object.assign(new Error(err),{code})):resolve(out.trim())); child.stdin.end(statement);
});}
async function rpc(name,args,headers={}) {
  return JSON.parse(await sql(`BEGIN; SET LOCAL ROLE anon; SET LOCAL "request.method"='POST'; SET LOCAL "request.headers"=${quote(JSON.stringify(headers))}; SELECT public.${name}(${args.map(value).join(',')}); COMMIT;`));
}
async function check(name,fn){await fn(); checks.push({name,ok:true}); console.log('PASS '+name);}
const project={tasks:[],groups:[],flags:[],meta:{title:'Independent real PostgreSQL QA'}};
const id=crypto.randomBytes(16).toString('hex'), otherId=crypto.randomBytes(16).toString('hex');
let token,token2;
function writeReport(report) {
  const content=JSON.stringify(report,null,2);
  if(process.env.RPC_TEST_REPORT) fs.writeFileSync(path.resolve(process.env.RPC_TEST_REPORT),content+'\n');
  console.log(content);
}
(async()=>{
  if(process.env.SCHEDULE_TEST_DB!=='1') throw new Error('Set SCHEDULE_TEST_DB=1 to confirm a disposable PostgreSQL test environment. This script creates and drops its own random database; it requires CREATEDB and pre-existing anon/authenticated roles. It does not test the WorkBuddy gateway.');
  const roles=await sql("SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated');",maintenanceDb);
  assert.equal(roles,'2','Create anon and authenticated roles in the isolated test cluster before running.');
  await sql(`CREATE DATABASE "${testDb}";`,maintenanceDb); databaseCreated=true;
  console.log('Disposable test database: '+testDb);
  if(process.env.PGCRYPTO_TEST_PUBLIC==='1') await sql('CREATE EXTENSION pgcrypto WITH SCHEMA public;');
  await sql(fs.readFileSync(migration,'utf8'));
  await check('migration rerun succeeds and anonymous crypto entry points are denied',async()=>{
    await sql(fs.readFileSync(migration,'utf8'));
    const schema=await sql("SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto';");
    assert.equal(schema,process.env.PGCRYPTO_TEST_PUBLIC==='1'?'public':'schedule_private');
    assert.equal(await sql(`SELECT has_function_privilege('anon',${quote(schema+'.crypt(text,text)')},'EXECUTE'),has_function_privilege('authenticated',${quote(schema+'.gen_salt(text,integer)')},'EXECUTE');`),'f|f');
    await assert.rejects(sql(`SET ROLE anon; SELECT ${schema}.crypt('1234','$2a$04$abcdefghijklmnopqrstuu');`),/permission denied/);
  });
  await check('create as anon issues random board-bound 12h token',async()=>{
    const r=await rpc('schedule_create_project',[id,'1234','QA creator',project]);
    assert.equal(r.ok,true,JSON.stringify(r)); assert.equal(r.data.revision,1); token=r.data.session.token;
    assert.match(token,/^[a-f0-9]{64}$/); assert.equal(r.data.session.displayName,'QA creator');
    assert.ok(Date.parse(r.data.session.expiresAt)>Date.now()+11*3600000);
    assert.equal((await rpc('schedule_create_project',[otherId,'4321','QA other',project])).ok,true);
  });
  await check('migration rerun preserves existing projects and editor sessions',async()=>{
    await sql(fs.readFileSync(migration,'utf8'));
    const r=await rpc('schedule_get_project',[id]); assert.equal(r.ok,true); assert.equal(r.data.revision,1); assert.equal(r.data.project.meta.title,project.meta.title);
    assert.equal(await sql(`SELECT count(*) FROM schedule_private.sessions WHERE project_id=${quote(id)} AND token_hash=schedule_private.token_digest(${quote(token)});`),'1');
  });
  await check('public reads exclude hash/session; anonymous direct tables/helpers denied',async()=>{
    const r=await rpc('schedule_get_project',[id]); assert.equal(r.ok,true); assert.equal(r.data.id,id);
    assert.ok(!/hash|token|editCode|session/.test(JSON.stringify(r)));
    await assert.rejects(sql('SET ROLE anon; SELECT * FROM schedule_private.projects;'),/permission denied/);
    await assert.rejects(sql('SET ROLE anon; SELECT schedule_private.new_token();'),/permission denied/);
    assert.equal(await sql(`SELECT (edit_code_hash LIKE '$2a$08$%') AND edit_code_hash <> '1234' FROM schedule_private.projects WHERE id=${quote(id)};`),'t');
  });
  await check('Unicode helpers match JavaScript UTF-16 and trimming boundaries',async()=>{
    assert.equal(await sql("SELECT schedule_private.utf16_length('A😀中'),schedule_private.utf16_length(U&'\\+010000'),schedule_private.js_trim(U&'\\00A0\\200B\\FEFF')=U&'\\200B',schedule_private.js_trim(U&'\\0009\\000A\\FEFF')='';"),'4|2|t|t');
  });
  await check('more than ten successful unlocks do not exhaust board failure allowance',async()=>{
    for(let i=0;i<12;i++) {const r=await rpc('schedule_unlock_project',[id,'1234','QA editor '+i]);assert.equal(r.ok,true,JSON.stringify(r));token2=r.data.token;}
    assert.equal(await sql(`SELECT attempts FROM schedule_private.request_budgets WHERE budget_key=${quote('unlock:'+id)};`),'0');
  });
  await check('wrong code denied and persisted; success preserves previous failures',async()=>{
    let r=await rpc('schedule_unlock_project',[id,'9876','Wrong']);assert.equal(r.error.code,'INVALID_EDIT_CODE');
    assert.equal(await sql(`SELECT attempts FROM schedule_private.request_budgets WHERE budget_key=${quote('unlock:'+id)};`),'1');
    r=await rpc('schedule_unlock_project',[id,'1234','Success']); assert.equal(r.ok,true);
    assert.equal(await sql(`SELECT attempts FROM schedule_private.request_budgets WHERE budget_key=${quote('unlock:'+id)};`),'1');
  });
  await check('invalid/cross-board tokens cannot update',async()=>{
    assert.equal((await rpc('schedule_save_project',[id,'a'.repeat(64),1,project])).error.code,'UNAUTHORIZED');
    assert.equal((await rpc('schedule_save_project',[otherId,token,1,project])).error.code,'UNAUTHORIZED');
  });
  await check('twenty concurrent saves from two sessions yield one revision winner',async()=>{
    const results=await Promise.all(Array.from({length:20},(_,i)=>rpc('schedule_save_project',[id,i%2?token:token2,1,{...project,meta:{title:'Concurrent '+i}}])));
    assert.equal(results.filter(r=>r.ok).length,1);
    assert.equal(results.filter(r=>r.error?.code==='REVISION_CONFLICT').length,19);
    assert.ok(results.filter(r=>!r.ok).every(r=>r.latest.revision===2));
    assert.equal((await rpc('schedule_get_project',[id])).data.revision,2);
  });
  await check('validation rejects unsafe/private layout without incrementing revision',async()=>{
    const bad={...project,meta:{title:'bad',cols:{name:999}}};
    assert.equal((await rpc('schedule_save_project',[id,token,2,bad])).error.code,'VALIDATION_ERROR');
    assert.equal((await rpc('schedule_get_project',[id])).data.revision,2);
  });
  await check('expired token denied; revoked token denied',async()=>{
    await sql(`UPDATE schedule_private.sessions SET expires_at=now()-interval '1 second' WHERE token_hash=schedule_private.token_digest(${quote(token2)});`);
    assert.equal((await rpc('schedule_save_project',[id,token2,2,project])).error.code,'UNAUTHORIZED');
    assert.equal((await rpc('schedule_revoke_session',[id,token])).ok,true);
    assert.equal((await rpc('schedule_save_project',[id,token,2,project])).error.code,'UNAUTHORIZED');
  });
  await check('rollback requests rejected without performing authentication',async()=>{
    const before=await sql(`SELECT attempts FROM schedule_private.request_budgets WHERE budget_key=${quote('unlock:'+id)};`);
    const r=await rpc('schedule_unlock_project',[id,'9876','Wrong'],{prefer:'tx=rollback'});assert.equal(r.error.code,'UNSUPPORTED_REQUEST');
    assert.equal(await sql(`SELECT attempts FROM schedule_private.request_budgets WHERE budget_key=${quote('unlock:'+id)};`),before);
  });
  await check('40 concurrent wrong attempts reserve exactly 10; no overshoot',async()=>{
    await sql(`DELETE FROM schedule_private.request_budgets WHERE budget_key=${quote('unlock:'+id)};`);
    const rs=await Promise.all(Array.from({length:40},()=>rpc('schedule_unlock_project',[id,'9876','Wrong'])));
    assert.equal(rs.filter(r=>r.error?.code==='INVALID_EDIT_CODE').length,10);
    assert.equal(rs.filter(r=>r.error?.code==='RATE_LIMITED').length,30);
    assert.equal(await sql(`SELECT attempts FROM schedule_private.request_budgets WHERE budget_key=${quote('unlock:'+id)};`),'10');
    assert.equal((await rpc('schedule_unlock_project',[id,'1234','Correct but locked'])).error.code,'RATE_LIMITED');
  });
  await check('window expiry permits correct code again',async()=>{
    await sql(`UPDATE schedule_private.request_budgets SET window_start=now()-interval '16 minutes' WHERE budget_key=${quote('unlock:'+id)};`);
    assert.equal((await rpc('schedule_unlock_project',[id,'1234','Recovered'])).ok,true);
    assert.equal(await sql(`SELECT attempts FROM schedule_private.request_budgets WHERE budget_key=${quote('unlock:'+id)};`),'0');
  });
  await check('caller forced outer rollback still defeats stored failures: deployment prerequisite',async()=>{
    await sql(`BEGIN; SET LOCAL ROLE anon; SELECT public.schedule_unlock_project(${quote(id)},'9876','Rollback probe'); ROLLBACK;`);
    assert.equal(await sql(`SELECT attempts FROM schedule_private.request_budgets WHERE budget_key=${quote('unlock:'+id)};`),'0');
  });
  writeReport({ok:true,postgres:await sql('SHOW server_version;'),pgcryptoMode:process.env.PGCRYPTO_TEST_PUBLIC==='1'?'existing public extension':'fresh private extension',checks,limitation:'Real PostgreSQL tested; WorkBuddy/PostgREST forced rollback configuration requires deployment verification.'});
})().catch(e=>{writeReport({ok:false,checks,error:e.message.replace(/\b[a-f0-9]{64}\b/g,'[redacted]')});process.exitCode=1;}).finally(async()=>{
  // This name is generated internally, and only a database successfully created
  // by this process is removed. Existing databases/tables are never cleaned.
  if(databaseCreated && /^schedule_rpc_test_[a-f0-9]{20}$/.test(testDb)) {
    try { await sql(`DROP DATABASE "${testDb}";`,maintenanceDb); }
    catch(e) {console.error(`Could not remove this run's disposable database ${testDb}: ${e.message}`);process.exitCode=1;}
  }
});
