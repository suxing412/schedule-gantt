'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {buildFrontend}=require('./build-frontend.cjs');
const root=path.resolve(__dirname,'..');
const assetsRoot=path.join(root,'frontend','assets');
const port=Number(process.env.SCHEDULE_PREVIEW_PORT||5173);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('SCHEDULE_PREVIEW_PORT must be between 1 and 65535');
buildFrontend();
const routes=new Map([
 ['/',{file:'index.html',type:'text/html; charset=utf-8'}],
 ['/index.html',{file:'index.html',type:'text/html; charset=utf-8'}],
 ['/project-validation.js',{file:'project-validation.js',type:'application/javascript; charset=utf-8'}]
]);
const server=http.createServer((request,response)=>{
 response.setHeader('Cache-Control','no-store');
 response.setHeader('X-Content-Type-Options','nosniff');
 if(request.method!=='GET'&&request.method!=='HEAD'){response.writeHead(405);response.end();return;}
 let pathname;
 try{pathname=new URL(request.url,'http://127.0.0.1').pathname;}catch(_){response.writeHead(400);response.end();return;}
 if(pathname==='/favicon.ico'){response.writeHead(204);response.end();return;}
 let route=routes.get(pathname);
 if(!route&&pathname.startsWith('/frontend/assets/')){
  let asset;
  try{asset=path.resolve(assetsRoot,decodeURIComponent(pathname.slice('/frontend/assets/'.length)));}catch(_){response.writeHead(400);response.end();return;}
  if(asset.startsWith(assetsRoot+path.sep)&&path.extname(asset).toLowerCase()==='.svg'){
   try{
    const realAsset=fs.realpathSync(asset),realAssetsRoot=fs.realpathSync(assetsRoot);
    if(realAsset.startsWith(realAssetsRoot+path.sep))route={file:path.relative(root,realAsset),type:'image/svg+xml; charset=utf-8'};
   }catch(_){}
  }
 }
 if(!route){response.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});response.end('Not found');return;}
 if(route.file==='index.html'){
  try{buildFrontend();}catch(error){console.error('Frontend build failed: '+error.message);response.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'});response.end('Frontend build failed. Check the preview terminal.');return;}
 }
 fs.readFile(path.join(root,route.file),(error,contents)=>{
  if(error){response.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'});response.end('Preview file unavailable');return;}
  response.writeHead(200,{'Content-Type':route.type});
  response.end(request.method==='HEAD'?undefined:contents);
 });
});
server.on('error',error=>{console.error('Preview server: '+error.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log('排期工具网页预览：http://127.0.0.1:'+port+' （修改后刷新页面即可）'));
