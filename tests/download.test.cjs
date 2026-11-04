const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {ReleaseClient,platformInfo,downloadVerified}=require('../app/core.cjs');
const {Manager}=require('../app/manager.cjs');
const payload=Buffer.from(Array.from({length:1024*1024},(_,i)=>(i*31+7)&255));
const sha=createHash('sha256').update(payload).digest('hex');
const chunkSize=64*1024;
async function server(t,handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));return `http://127.0.0.1:${s.address().port}`;}
async function temp(t){const root=path.resolve('.tmp/tests');await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'case-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));return dir;}
function release(urls){return {version:'3.1623.0',assetName:'Claude-win-x64.msix',sha256:sha,size:payload.length,urls};}
// Serves `bytes` with HTTP Range support and records every requested range start.
function ranged(bytes,log=[]){return (req,res)=>{
  const m=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'');
  if(!m){res.setHeader('Content-Length',bytes.length);return res.end(bytes);}
  const start=Number(m[1]),end=Math.min(Number(m[2]),bytes.length-1);log.push(start);
  res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':end-start+1});res.end(bytes.subarray(start,end+1));
};}
const files=async dir=>(await fs.readdir(dir)).sort();
test('parallel ranged download spreads chunks over every source and verifies the result',async t=>{
  const a=[],b=[];let open=0,peak=0;
  const slow=log=>(req,res)=>{open++;peak=Math.max(peak,open);res.on('finish',()=>open--);setTimeout(()=>ranged(payload,log)(req,res),15);};
  const baseA=await server(t,slow(a)),baseB=await server(t,slow(b));const dir=await temp(t);
  const file=await downloadVerified(new ReleaseClient({local:true}),release([`${baseA}/pinned`,`${baseB}/pinned`]),dir,{chunkSize,connections:4});
  assert.deepEqual(await fs.readFile(file),payload);assert.ok(a.length>0&&b.length>0,'both sources serve chunks');assert.equal(a.length+b.length,16);assert.ok(peak>=3,`concurrent requests: ${peak}`);
  assert.deepEqual(await files(dir),[path.basename(file)]);
});
test('a failing source is dropped and the remaining source completes the download',async t=>{
  const good=await server(t,ranged(payload)),bad=await server(t,(req,res)=>{res.writeHead(500);res.end('down');});const dir=await temp(t);
  const file=await downloadVerified(new ReleaseClient({local:true}),release([`${bad}/pinned`,`${good}/pinned`]),dir,{chunkSize,connections:3});
  assert.deepEqual(await fs.readFile(file),payload);
});
test('an interrupted download keeps its progress and resumes only the missing chunks',async t=>{
  let broken=true;const starts=[];const base=await server(t,(req,res)=>{const start=Number(/bytes=(\d+)/.exec(req.headers.range||'')?.[1]);if(broken&&start>=512*1024){res.writeHead(503);return res.end('busy');}ranged(payload,starts)(req,res);});
  const dir=await temp(t),item=release([`${base}/pinned`]),client=new ReleaseClient({local:true});
  await assert.rejects(downloadVerified(client,item,dir,{chunkSize,connections:2}),/重试将继续/);
  assert.equal((await files(dir)).filter(f=>/\.part(\.json)?$/.test(f)).length,2);
  broken=false;starts.length=0;
  const file=await downloadVerified(client,item,dir,{chunkSize,connections:2});
  assert.deepEqual(await fs.readFile(file),payload);assert.ok(starts.length>0&&starts.every(s=>s>=512*1024),'completed chunks are not downloaded again');
  assert.deepEqual(await files(dir),[path.basename(file)]);
});
test('a stalled connection is abandoned and its chunk is fetched again',async t=>{
  let stalls=2;const base=await server(t,(req,res)=>{if(stalls>0&&/bytes=0-/.test(req.headers.range||'')){stalls--;res.writeHead(206,{'Content-Range':`bytes 0-${chunkSize-1}/${payload.length}`,'Content-Length':chunkSize});res.write(payload.subarray(0,1000));return;}ranged(payload)(req,res);});
  const dir=await temp(t);const file=await downloadVerified(new ReleaseClient({local:true}),release([`${base}/pinned`]),dir,{chunkSize,connections:2,stall:200});
  assert.deepEqual(await fs.readFile(file),payload);assert.equal(stalls,0);
});
test('a mirror /latest route that changed bytes is retried from the version-pinned source only',async t=>{
  const changed=Buffer.from(payload).fill(1,0,4096);const latest=[],pinned=[];
  const base=await server(t,(req,res)=>req.url.startsWith('/latest/')?ranged(changed,latest)(req,res):ranged(payload,pinned)(req,res));const dir=await temp(t);
  const file=await downloadVerified(new ReleaseClient({local:true}),release([`${base}/latest/win-x64`,`${base}/pinned`]),dir,{chunkSize,connections:4});
  assert.deepEqual(await fs.readFile(file),payload);assert.ok(latest.length>0);
});
test('cancelling a parallel download removes partial data and progress state',async t=>{
  const base=await server(t,(req,res)=>setTimeout(()=>ranged(payload)(req,res),30));const dir=await temp(t),controller=new AbortController();
  const job=downloadVerified(new ReleaseClient({local:true}),release([`${base}/pinned`]),dir,{chunkSize,connections:2,signal:controller.signal,onProgress:p=>{if(p.received>chunkSize)controller.abort(new Error('已取消下载'));}});
  await assert.rejects(job);assert.deepEqual(await files(dir),[]);
});
test('a source without range support falls back to a single verified stream',async t=>{
  let calls=0;const base=await server(t,(req,res)=>{calls++;res.setHeader('Content-Length',payload.length);res.end(payload);});const dir=await temp(t);
  const file=await downloadVerified(new ReleaseClient({local:true}),release([`${base}/pinned`]),dir,{chunkSize,connections:4});
  assert.deepEqual(await fs.readFile(file),payload);assert.ok(calls<=5);
});
test('official CDN URLs are accepted only when version-pinned and matching the verified package',async t=>{
  const entry={version:'3.1624.0',assetName:'Claude-win-x64.msix',sha256:sha,contentLength:payload.length,url:'https://downloads.claude.ai/releases/win32/x64/3.1624.0/Claude-abc.msix'};
  const base=await server(t,(req,res)=>res.end(JSON.stringify({sources:{windows:{x64:req.url.includes('mismatch')?{...entry,sha256:'0'.repeat(64)}:entry}}})));
  const client=new ReleaseClient({local:true,repo:base}),info=platformInfo('win32','x64');
  const item=client.fromManifest({sources:{windows:{x64:entry}}},info,'国内镜像');assert.equal(item.urls[1],entry.url);
  assert.equal(client.fromManifest({sources:{windows:{x64:{...entry,url:'https://downloads.claude.ai/releases/win32/x64/latest/Claude.msix'}}}},info,'m').urls.length,2);
  assert.equal(client.fromManifest({sources:{windows:{x64:{...entry,url:'https://evil.test/3.1624.0/Claude.msix'}}}},info,'m').urls.length,2);
  const verified={version:'3.1624.0',sha256:sha,size:payload.length};
  assert.equal(await client.officialSource(verified,info),entry.url);
  assert.equal(await new ReleaseClient({local:true,repo:`${base}/mismatch`}).officialSource(verified,info),null);
});
test('manager adds the official source, stages after download and reports the download',async t=>{
  const seen=[];const base=await server(t,(req,res)=>{seen.push(req.url);if(req.url.endsWith('release-manifest.json'))return res.end(JSON.stringify({sources:{windows:{x64:{version:'3.1623.0',sha256:sha,contentLength:payload.length,url:'https://downloads.claude.ai/releases/win32/x64/3.1623.0/Claude-abc.msix'}}}}));ranged(payload)(req,res);});
  const dir=await temp(t);let staged=null,urls=null;
  const client=new ReleaseClient({local:true,repo:base});const download=client.request.bind(client);
  client.request=(url,options)=>url.startsWith('https://downloads.claude.ai/')?Promise.reject(new Error('offline in test')):download(url,options);
  const m=new Manager({dir,client,info:platformInfo('win32','x64'),platform:{status:async()=>({installed:true,version:'3.1622.0',kind:'msix'}),stage:async(file,options)=>{staged={file,options};}}});await m.init();t.after(()=>m.stop());
  m.state.installed={installed:true,version:'3.1622.0',kind:'msix'};m.state.latest={...release([`${base}/pinned`]),source:'GitHub'};
  const original=m.downloadSources.bind(m);m.downloadSources=async(r,s)=>urls=await original(r,s);
  await m.download();
  assert.deepEqual(urls,[`${base}/pinned`,'https://downloads.claude.ai/releases/win32/x64/3.1623.0/Claude-abc.msix']);
  assert.ok(m.state.ready.staged);assert.equal(staged.options.version,'3.1623.0');assert.deepEqual(await fs.readFile(staged.file),payload);
  assert.ok(m.state.logs.some(l=>/下载完成（1 MB/.test(l.message)));assert.ok(m.state.logs.some(l=>/已预安装/.test(l.message)));
});
test('staging failure does not block the verified download',async t=>{
  const base=await server(t,ranged(payload));const dir=await temp(t);
  const m=new Manager({dir,client:new ReleaseClient({local:true,repo:base}),info:platformInfo('win32','x64'),platform:{status:async()=>({}),stage:async()=>{throw new Error('0x80073CF9 staging failed');}}});await m.init();t.after(()=>m.stop());
  await m.settings({source:'github'});m.state.latest={...release([`${base}/pinned`]),source:'GitHub'};
  await m.download();assert.ok(m.state.ready);assert.ok(!m.state.ready.staged);assert.equal(m.state.error,null);assert.ok(m.state.logs.some(l=>/预安装未完成/.test(l.message)));
});
test('leftover Claude-started programs need confirmation; automatic installs never close them',async t=>{
  const dir=await temp(t),file=path.join(dir,'fixture.msix');await fs.writeFile(file,payload);
  const calls=[];let statusCalls=0;const leftovers=[{pid:4242,name:'java',path:'C:\\erp\\jdk64\\bin\\java.exe'}];
  const platform={status:async()=>{statusCalls++;return {installed:true,version:'3.1622.0.0',kind:'msix',running:false};},install:async(f,options)=>{calls.push(options.closeProcesses);if(!options.closeProcesses.length)return {needsConfirmation:true,leftovers};return {installed:true,version:'3.1623.0.0',kind:'msix',running:false,pending:false};}};
  const m=new Manager({dir,info:platformInfo('win32','x64'),platform});await m.init();t.after(()=>m.stop());
  m.state.ready={...release(['http://localhost']),file};
  const asked=await m.install();assert.deepEqual(asked.confirmClose,leftovers);assert.ok(m.state.ready);assert.equal(m.state.error,null);
  await m.install(true);await m.install(true);assert.equal(m.state.logs.filter(l=>/已跳过自动安装/.test(l.message)).length,1);
  statusCalls=0;await m.install(false,{closeProcesses:[4242]});
  assert.deepEqual(calls.at(-1),[4242]);assert.equal(m.state.installed.version,'3.1623.0.0');assert.equal(m.state.ready,null);assert.equal(statusCalls,1,'post-install status comes from the install result');
  assert.ok(m.state.logs.some(l=>/已关闭由 Claude 启动的程序/.test(l.message)));
});
test('in the endgame a slow chunk is raced on a faster source and the slow copy is cancelled',async t=>{
  const big=512*1024,fastStarts=[];let slowOpen=0;
  const slow=await server(t,(req,res)=>{const m=/bytes=(\d+)-(\d+)/.exec(req.headers.range||'');const start=Number(m[1]),end=Number(m[2]);slowOpen++;res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${payload.length}`,'Content-Length':end-start+1});let at=start;const timer=setInterval(()=>{if(at>end){clearInterval(timer);return res.end();}res.write(payload.subarray(at,Math.min(at+16*1024,end+1)));at+=16*1024;},100);res.on('close',()=>{clearInterval(timer);slowOpen--;});});
  const fast=await server(t,ranged(payload,fastStarts));const dir=await temp(t),began=Date.now();
  const file=await downloadVerified(new ReleaseClient({local:true}),release([`${slow}/pinned`,`${fast}/pinned`]),dir,{chunkSize:big,connections:2,stall:5000});
  assert.deepEqual(await fs.readFile(file),payload);
  assert.ok(Date.now()-began<2500,`finished in ${Date.now()-began} ms instead of waiting ~3 s for the slow source`);
  assert.deepEqual(fastStarts.sort((a,b)=>a-b),[0,big],'the fast source also fetched the chunk the slow source started');
  await new Promise(r=>setTimeout(r,200));assert.equal(slowOpen,0,'the slow copy was cancelled');
});
test('one source is never given more than six parallel connections',async t=>{
  let open=0,peak=0;const base=await server(t,(req,res)=>{open++;peak=Math.max(peak,open);res.on('finish',()=>open--);setTimeout(()=>ranged(payload)(req,res),20);});const dir=await temp(t);
  const file=await downloadVerified(new ReleaseClient({local:true}),release([`${base}/pinned`]),dir,{chunkSize:32*1024,connections:16});
  assert.deepEqual(await fs.readFile(file),payload);assert.ok(peak<=6&&peak>=4,`peak connections ${peak}`);
});
