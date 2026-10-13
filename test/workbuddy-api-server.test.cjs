'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {createServer} = require('../cloud/serve.cjs');
const id = 'a'.repeat(32);
const token = 'b'.repeat(64);
const project = {tasks:[],groups:[],flags:[],meta:{title:'API integration'}};
const record = {id,revision:1,project,createdAt:'2026-10-12T00:00:00Z',updatedAt:'2026-10-12T00:00:00Z',updatedBy:'Test',source:'human'};

async function listen(t, server) {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return 'http://127.0.0.1:'+server.address().port;
}

test('WorkBuddy serves discoverable AI tools without requiring a new port or exposing implementation files', async t=>{
  const origin=await listen(t,createServer({env:{}}));
  const html=await (await fetch(origin+'/')).text();
  assert.match(html,/rel="service-desc"[^>]+href="\/api\/openapi.json"/);
  const catalog=await (await fetch(origin+'/api/tools')).json();
  assert.ok(catalog.tools.some(tool=>tool.name==='task.add'));
  assert.ok(catalog.tools.some(tool=>tool.name==='project.get'));
  const spec=await (await fetch(origin+'/api/openapi.json')).json();
  assert.match(spec.openapi,/^3\.1\./);
  assert.ok(spec.paths['/api/tools/call']);
  assert.equal((await fetch(origin+'/llms.txt')).status,200);
  for(const pathname of ['/cloud/ai/http.cjs','/cloud/migrations/002_collab_external.sql','/cloud/ai/operation-definitions.json']) {
    assert.equal((await fetch(origin+pathname)).status,404);
  }
  const read=await fetch(origin+'/api/projects/'+id);
  assert.equal(read.status,503);
  assert.equal((await read.json()).ok,false);
  assert.equal((await fetch(origin+'/',{method:'POST',body:'ignored'})).status,405);
});

test('single-port integration uses X-Schedule-Token despite platform Authorization and preserves CAS revision', async t=>{
  const calls=[];
  const upstream=await listen(t,http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const args=JSON.parse(body);
    calls.push({url:req.url,args,headers:req.headers});
    const result=req.url.endsWith('/schedule_apply_action')
      ? {ok:true,data:{...record,revision:2,source:'external',changed:true,results:[{index:0,name:'project.update',affectedIds:[]}]}}
      : {ok:true,data:record};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));
  }));
  const origin=await listen(t,createServer({env:{WORKBUDDY_ENDPOINT:upstream,WORKBUDDY_PUBLISHABLE_KEY:'wbpk_integration',NODE_ENV:'development'}}));
  assert.equal((await fetch(origin+'/api/projects/'+id)).status,200);
  assert.equal(calls[0].headers['x-wb-webapp-access-key'],'wbpk_integration');
  assert.equal(calls[0].headers.origin,undefined);
  const payload={name:'project.update',arguments:{patch:{title:'Changed'}},projectId:id,expectedRevision:1};
  const denied=await fetch(origin+'/api/tools/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  assert.equal(denied.status,401);
  assert.equal(calls.length,1);
  const response=await fetch(origin+'/api/tools/call',{method:'POST',headers:{'Content-Type':'application/json','X-Schedule-Token':token,Authorization:'Bearer platform.jwt.signature'},body:JSON.stringify(payload)});
  assert.equal(response.status,200);
  const value=await response.json();assert.equal(value.ok,true);assert.equal(value.data.record.revision,2);
  assert.equal(calls.length,2);
  assert.equal(calls[1].args.p_expected_revision,1);
  assert.equal(calls[1].args.p_token,token);
  assert.deepEqual(calls[1].args.p_action,{name:'project.update',arguments:{patch:{title:'Changed'}}});
  assert.equal(calls[1].headers.authorization,undefined);
  assert.equal(calls[1].headers['x-schedule-token'],undefined);
});
