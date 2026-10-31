const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {createHash}=require('node:crypto');
const {ReleaseClient,downloadVerified}=require('../app/core.cjs');
const {electronFetch}=require('../app/electron-fetch.cjs');
const payload=Buffer.alloc(256*1024,7);
const sha=createHash('sha256').update(payload).digest('hex');
async function server(t,handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));return `http://127.0.0.1:${s.address().port}`;}
async function temp(t){const root=path.resolve('.tmp/tests');await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'case-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));return dir;}
// Mirrors Electron's ClientRequest in manual redirect mode: 3xx emits 'redirect' and waits; other statuses emit 'response'.
function fakeNet(){
  const requests=[];
  return {requests,request(options){
    const req=new EventEmitter(),headers={};let client;
    req.setHeader=(name,value)=>{headers[name]=value;};
    req.abort=()=>{req.aborted=true;client?.destroy();};
    req.end=()=>{client=http.get(options.url,{headers},res=>{
      if([301,302,303,307,308].includes(res.statusCode)){res.resume();req.emit('redirect',res.statusCode,'GET',new URL(res.headers.location,options.url).href,res.headers);}
      else req.emit('response',res);
    });client.on('error',error=>{if(!req.aborted)req.emit('error',error);});};
    requests.push({options,headers});return req;
  }};
}
function release(base){return {version:'3.1623.0',assetName:'Claude-win-x64.msix',sha256:sha,size:payload.length,urls:[`${base}/start`]};}
test('Electron network adapter downloads through a validated manual redirect',async t=>{
  const base=await server(t,(req,res)=>{if(req.url==='/start'){res.writeHead(302,{Location:'/package'});return res.end();}res.setHeader('Content-Length',payload.length);res.end(payload);});
  const net=fakeNet();const client=new ReleaseClient({local:true,fetcher:electronFetch(net)});
  const file=await downloadVerified(client,release(base),await temp(t));
  assert.deepEqual(await fs.readFile(file),payload);
  assert.deepEqual(net.requests.map(r=>new URL(r.options.url).pathname),['/start','/package']);
  assert.equal(net.requests[0].options.redirect,'manual');assert.equal(net.requests[0].options.cache,'no-store');assert.match(net.requests[0].headers['User-Agent'],/Claude-App-Manager/);
});
test('Electron network adapter cannot follow a redirect to an unknown host',async t=>{
  const base=await server(t,(req,res)=>{res.writeHead(302,{Location:'https://evil.test/Claude-win-x64.msix'});res.end();});
  const net=fakeNet();const client=new ReleaseClient({local:true,fetcher:electronFetch(net)});
  await assert.rejects(downloadVerified(client,release(base),await temp(t)),/拒绝未知下载域名：evil\.test/);
  assert.equal(net.requests.length,1);
});
test('Electron network adapter keeps ETag 304 reuse working',async t=>{
  let calls=0;const base=await server(t,(req,res)=>{calls++;if(req.headers['if-none-match']==='"v1"'){res.writeHead(304);return res.end();}res.setHeader('ETag','"v1"');res.end('{"ok":true}');});
  const client=new ReleaseClient({local:true,fetcher:electronFetch(fakeNet())});
  assert.equal(await client.text(`${base}/manifest`),'{"ok":true}');assert.equal(await client.text(`${base}/manifest`),'{"ok":true}');assert.equal(calls,2);
});
test('Electron network adapter cancellation stops the body and removes partial data',async t=>{
  const base=await server(t,(req,res)=>{res.setHeader('Content-Length',payload.length);res.write(payload.subarray(0,64*1024));});
  const dir=await temp(t),controller=new AbortController();
  const client=new ReleaseClient({local:true,fetcher:electronFetch(fakeNet())});
  const job=downloadVerified(client,release(base),dir,{signal:controller.signal,onProgress:p=>{if(p.received>0)controller.abort(new Error('已取消下载'));}});
  await assert.rejects(job,error=>error.name==='AbortError'||/已取消下载/.test(error.message));
  assert.deepEqual((await fs.readdir(dir)).filter(f=>f.endsWith('.part')),[]);
});
