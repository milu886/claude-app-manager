const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {ReleaseClient,platformInfo,compareVersions,trustedUrl,downloadVerified}=require('../app/core.cjs');
const {Manager,validateSettings}=require('../app/manager.cjs');
const payload=Buffer.from('fixture package bytes: never installed');
const sha=createHash('sha256').update(payload).digest('hex');
const manifest={schemaVersion:2,generatedAt:'2026-10-21T00:00:00Z',version:'3.1623.0',sources:{windows:{x64:{version:'3.1623.0',assetName:'Claude-win-x64.msix',sha256:sha,contentLength:payload.length}}}};
async function server(t,handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>s.close(r)));return `http://127.0.0.1:${s.address().port}`;}
async function temp(t){const root=path.resolve('.tmp/tests');await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'case-'));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));return dir;}
function release(base){return {version:'3.1623.0',assetName:'Claude-win-x64.msix',sha256:sha,size:payload.length,urls:[`${base}/package`]};}
test('numeric versions, trailing zeros and platform architecture selection',()=>{
  assert.equal(compareVersions('3.10.0','3.9.99'),1);assert.equal(compareVersions('3.1623.0','3.1623.0.0'),0);assert.equal(compareVersions('2.9.0','3.0.0'),-1);assert.throws(()=>compareVersions('../../','1.0.0'));
  assert.equal(platformInfo('win32','arm64').assetName,'Claude-win-arm64.msix');assert.equal(platformInfo('darwin','x64').arch,'universal');assert.throws(()=>platformInfo('win32','ia32'));
});
test('download URLs reject unsafe schemes, credentials and lookalike hosts',()=>{
  for(const url of ['http://github.com/a','https://github.com.evil.test/a','https://user:secret@github.com/a','https://evil.test/a','file:///C:/Windows/a'])assert.throws(()=>trustedUrl(url));
  assert.ok(trustedUrl('https://claudeapp.agentsmirror.com/latest/manifest'));
});
test('real HTTP manifest with ETag and 304 reuses cached content',async t=>{
  let calls=0;const base=await server(t,(req,res)=>{if(req.url!=='/latest/manifest'){res.writeHead(404);return res.end();}calls++;if(req.headers['if-none-match']==='"fixture"'){res.writeHead(304);res.end();}else{res.setHeader('ETag','"fixture"');res.end(JSON.stringify(manifest));}});
  const client=new ReleaseClient({mirror:base,api:base,repo:base,local:true});const info=platformInfo('win32','x64');
  const a=await client.latest(info),b=await client.latest(info);assert.equal(a.version,'3.1623.0');assert.equal(b.sha256,sha);assert.equal(calls,2);
});
test('mirror failure falls back to actual GitHub API contract over HTTP',async t=>{
  const paths=[];const base=await server(t,(req,res)=>{paths.push(req.url);if(req.url==='/latest/manifest'){res.writeHead(503);return res.end('offline');}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({tag_name:'claude-app-v3.1624.0',draft:false,prerelease:false,assets:[{name:'Claude-win-x64.msix',size:payload.length,digest:`sha256:${sha}`}]}));});
  const client=new ReleaseClient({mirror:base,api:base,repo:base,local:true});const result=await client.latest(platformInfo('win32','x64'));assert.equal(result.source,'GitHub');assert.equal(result.version,'3.1624.0');assert.deepEqual(paths.sort(),['/latest/manifest','/releases/latest','/releases/latest/download/release-manifest.json']);
});
function github(version){return JSON.stringify({tag_name:`claude-app-v${version}`,draft:false,prerelease:false,published_at:'2026-10-30T00:00:00Z',assets:[{name:'Claude-win-x64.msix',size:payload.length,digest:`sha256:${sha}`}]});}
test('auto source offers a newer GitHub release when the mirror manifest lags',async t=>{
  let tag='3.1624.0';const base=await server(t,(req,res)=>res.end(req.url==='/latest/manifest'?JSON.stringify(manifest):github(tag)));
  const client=new ReleaseClient({mirror:base,api:base,repo:base,local:true}),info=platformInfo('win32','x64');
  const newer=await client.latest(info);assert.equal(newer.version,'3.1624.0');assert.equal(newer.source,'GitHub');assert.deepEqual(newer.urls,[`${base}/releases/download/claude-app-v3.1624.0/Claude-win-x64.msix`]);
  tag='3.1623.0';const same=await client.latest(info);assert.equal(same.source,'国内镜像');assert.deepEqual(same.urls,[`${base}/latest/win-x64`,`${base}/releases/download/claude-app-v3.1623.0/Claude-win-x64.msix`]);
});
test('GitHub failure in auto mode keeps the last GitHub release instead of flipping versions',async t=>{
  let limited=false;const base=await server(t,(req,res)=>{if(req.url==='/latest/manifest')return res.end(JSON.stringify(manifest));if(limited){res.writeHead(403);return res.end('rate limited');}res.end(github('3.1624.0'));});
  const info=platformInfo('win32','x64'),client=new ReleaseClient({mirror:base,api:base,repo:base,local:true});
  assert.equal((await client.latest(info)).version,'3.1624.0');limited=true;const kept=await client.latest(info);assert.equal(kept.version,'3.1624.0');assert.equal(kept.urls.length,1);
  const fresh=await new ReleaseClient({mirror:base,api:base,repo:base,local:true}).latest(info);assert.equal(fresh.version,'3.1623.0');assert.equal(fresh.source,'国内镜像');
});
test('GitHub-only source never contacts the mirror',async t=>{
  const paths=[];const base=await server(t,(req,res)=>{paths.push(req.url);res.end(req.url==='/latest/manifest'?JSON.stringify(manifest):github('3.1622.0'));});
  const result=await new ReleaseClient({mirror:base,api:base,repo:base,local:true}).latest(platformInfo('win32','x64'),'github');
  assert.equal(result.version,'3.1622.0');assert.equal(result.urls.length,1);assert.deepEqual(paths,['/releases/latest/download/release-manifest.json','/releases/latest']);
});
test('GitHub versions come from the release manifest download, not the rate-limited REST API',async t=>{
  const paths=[];const official='https://downloads.claude.ai/releases/win32/x64/3.1625.0/Claude-abc.msix';
  const base=await server(t,(req,res)=>{paths.push(req.url);if(req.url==='/latest/manifest')return res.end(JSON.stringify(manifest));if(req.url==='/releases/latest/download/release-manifest.json')return res.end(JSON.stringify({schemaVersion:2,generatedAt:'2026-10-30T00:00:00Z',sources:{windows:{x64:{version:'3.1625.0',assetName:'Claude-win-x64.msix',sha256:sha,contentLength:payload.length,url:official}}}}));res.writeHead(403);res.end('rate limited');});
  const client=new ReleaseClient({mirror:base,api:base,repo:base,local:true}),info=platformInfo('win32','x64');
  const auto=await client.latest(info);assert.equal(auto.version,'3.1625.0');assert.equal(auto.source,'GitHub');assert.deepEqual(auto.urls,[`${base}/releases/download/claude-app-v3.1625.0/Claude-win-x64.msix`,official]);
  const only=await client.latest(info,'github');assert.deepEqual(only.urls,[`${base}/releases/download/claude-app-v3.1625.0/Claude-win-x64.msix`]);
  assert.ok(!paths.includes('/releases/latest'),'REST API not used when the manifest is available');
});
test('invalid manifest cannot supply a path or missing checksum',()=>{
  const c=new ReleaseClient(),info=platformInfo('win32','x64');const m=structuredClone(manifest);m.sources.windows.x64.assetName='../../bad';assert.throws(()=>c.fromManifest(m,info,'mirror'));m.sources.windows.x64.assetName=info.assetName;m.sources.windows.x64.sha256='';assert.throws(()=>c.fromManifest(m,info,'mirror'));
});
test('real HTTP download is hashed, atomically saved and cached',async t=>{
  let calls=0;const base=await server(t,(_,res)=>{calls++;res.setHeader('Content-Length',payload.length);res.end(payload);});const dir=await temp(t),client=new ReleaseClient({local:true}),events=[];
  const a=await downloadVerified(client,release(base),dir,{onProgress:p=>events.push(p)});const b=await downloadVerified(client,release(base),dir);assert.equal(a,b);assert.deepEqual(await fs.readFile(a),payload);assert.equal(calls,1);assert.ok(events.some(e=>e.phase==='verifying'));
});
test('same-size corrupt bytes are blocked and partial file is removed',async t=>{
  const base=await server(t,(_,res)=>res.end(Buffer.alloc(payload.length)));const dir=await temp(t);
  await assert.rejects(downloadVerified(new ReleaseClient({local:true}),release(base),dir),/SHA-256/);assert.deepEqual(await fs.readdir(dir),[]);
});
test('short-link race falls back to pinned package after SHA mismatch',async t=>{
  const base=await server(t,(req,res)=>res.end(req.url==='/bad'?Buffer.alloc(payload.length):payload));const item=release(base);item.urls=[`${base}/bad`,`${base}/good`];const dir=await temp(t);const file=await downloadVerified(new ReleaseClient({local:true}),item,dir);assert.deepEqual(await fs.readFile(file),payload);
});
test('announced size mismatch is rejected without creating an installable file',async t=>{
  const base=await server(t,(_,res)=>res.end('short'));const dir=await temp(t);await assert.rejects(downloadVerified(new ReleaseClient({local:true}),release(base),dir),/已变化/);assert.deepEqual(await fs.readdir(dir),[]);
});
test('cancel interrupts an active HTTP download and removes partial data',async t=>{
  const base=await server(t,(_,res)=>{res.writeHead(200);res.write(payload.subarray(0,3));const timer=setInterval(()=>res.write('x'),20);res.on('close',()=>clearInterval(timer));});const dir=await temp(t),controller=new AbortController();
  const promise=downloadVerified(new ReleaseClient({local:true}),release(base),dir,{signal:controller.signal});setTimeout(()=>controller.abort(),50);await assert.rejects(promise);assert.deepEqual(await fs.readdir(dir),[]);
});
test('manual redirects cannot escape to an unknown host',async t=>{
  const base=await server(t,(_,res)=>{res.writeHead(302,{Location:'https://evil.example/payload'});res.end();});await assert.rejects(new ReleaseClient({local:true}).request(base),/未知下载域名/);
});
test('HTTP 429 + mirror outage reports actionable error',async t=>{
  const base=await server(t,(req,res)=>{res.writeHead(req.url.startsWith('/latest')?503:429);res.end('busy');});await assert.rejects(new ReleaseClient({local:true,mirror:base,api:base,repo:base}).latest(platformInfo('win32','x64')),/请求限制/);
});
test('network timeout is bounded',async t=>{
  const base=await server(t,()=>{});const client=new ReleaseClient({local:true,timeout:50});await assert.rejects(client.text(base),/timeout|aborted/i);
});
test('settings disable auto-install without auto-download and survive restart',async t=>{
  assert.equal(validateSettings({autoInstall:true}).autoInstall,false);const dir=await temp(t);const options={dir,platform:{status:async()=>({installed:false})},info:platformInfo('win32','x64')};const m=new Manager(options);await m.init();t.after(()=>m.stop());await m.settings({interval:5,autoDownload:true,autoInstall:true,source:'github'});const next=new Manager(options);await next.init();assert.equal(next.state.settings.interval,5);assert.equal(next.state.settings.autoInstall,true);assert.equal(next.state.settings.source,'github');
});
test('busy operation reschedules polling instead of silently stopping',async t=>{
  const dir=await temp(t);const m=new Manager({dir,platform:{},info:platformInfo('win32','x64')});await m.init();t.after(()=>m.stop());m.state.job={phase:'downloading'};await m.check();assert.ok(m.state.nextCheckAt);assert.ok(m.timer);
});
test('concurrent settings changes are serialized without lost fields',async t=>{
  const dir=await temp(t);const m=new Manager({dir,platform:{},info:platformInfo('win32','x64')});await m.init();t.after(()=>m.stop());await Promise.all([m.settings({interval:5}),m.settings({source:'github'}),m.settings({background:false})]);assert.equal(m.state.settings.interval,5);assert.equal(m.state.settings.source,'github');assert.equal(m.state.settings.background,false);
});
test('install rechecks file and never calls platform installer for tampered cache',async t=>{
  const dir=await temp(t);let installs=0;const m=new Manager({dir,info:platformInfo('win32','x64'),platform:{status:async()=>({installed:false}),install:async()=>{installs++;}}});await m.init();t.after(()=>m.stop());const file=path.join(dir,'payload.msix');await fs.writeFile(file,Buffer.alloc(payload.length));m.state.ready={...release('http://localhost'),file};await assert.rejects(m.install(),/校验失败/);assert.equal(installs,0);assert.equal(m.state.ready,null);
});
test('running classic Claude blocks installation and downgrade is rejected',async t=>{
  const dir=await temp(t);let current={installed:true,version:'3.1622.0',kind:'classic',running:true},installs=0;const m=new Manager({dir,info:platformInfo('win32','x64'),platform:{status:async()=>current,install:async()=>{installs++;}}});await m.init();t.after(()=>m.stop());m.state.ready={...release('http://localhost'),file:'unused'};await assert.rejects(m.install(),/正在运行/);current={...current,running:false,version:'3.1624.0'};await assert.rejects(m.install(),/阻止降级/);assert.equal(installs,0);
});
test('busy MSIX update is persisted as pending, not failed or repeatedly installed',async t=>{
  const base=await server(t,(req,res)=>res.end(JSON.stringify(manifest))),dir=await temp(t);let installs=0,current={installed:true,version:'3.1622.0',kind:'msix',running:true};
  const options={dir,info:platformInfo('win32','x64'),client:new ReleaseClient({mirror:base,api:base,repo:base,local:true}),platform:{status:async()=>current,install:async(file,opts)=>{assert.equal(opts.version,'3.1623.0');installs++;return {pending:true};}}};
  const m=new Manager(options);await m.init();t.after(()=>m.stop());const file=path.join(dir,'fixture.msix');await fs.writeFile(file,payload);m.state.ready={...release(base),file};await m.install();assert.equal(m.state.error,null);assert.equal(m.state.pending.version,'3.1623.0');assert.equal(installs,1);
  const restarted=new Manager(options);await restarted.init();t.after(()=>restarted.stop());assert.equal(restarted.state.pending.version,'3.1623.0');await restarted.settings({autoDownload:true,autoInstall:true});await restarted.check();assert.equal(installs,1);assert.ok(restarted.state.pending);assert.equal(restarted.state.error,null);
  current={...current,version:'3.1623.0.0',running:false};await restarted.check();assert.equal(restarted.state.pending,null);assert.equal(restarted.state.ready,null);assert.ok(restarted.state.logs.some(row=>row.message.includes('延后更新已完成')));await assert.rejects(fs.stat(path.join(dir,'pending-update.json')),/ENOENT/);
});
test('a successful native command with an unchanged version is not reported as installed',async t=>{
  const dir=await temp(t),file=path.join(dir,'fixture.msix');await fs.writeFile(file,payload);const m=new Manager({dir,info:platformInfo('win32','x64'),platform:{status:async()=>({installed:true,version:'3.1622.0',kind:'msix'}),install:async()=>({pending:false})}});await m.init();t.after(()=>m.stop());m.state.ready={...release('http://localhost'),file};await assert.rejects(m.install(),/安装后的版本检查未通过/);
});
test('pending update can be completed after restart using verified cache',async t=>{
  const calls=[],base=await server(t,(req,res)=>{calls.push(req.url);res.end(JSON.stringify(manifest));}),dir=await temp(t);
  let current={installed:true,version:'3.1622.0',kind:'msix',running:false,services:[{name:'CoworkVMService',running:true}]},installs=0;
  const options={dir,info:platformInfo('win32','x64'),client:new ReleaseClient({mirror:base,api:base,repo:base,local:true}),platform:{status:async()=>current,install:async()=>{installs++;current={...current,version:'3.1623.0.0'};return {pending:false};}}};
  const m=new Manager(options);await m.init();t.after(()=>m.stop());await m.setPending({version:'3.1623.0',requestedAt:new Date().toISOString()});
  const folder=path.join(dir,'downloads');await fs.mkdir(folder);await fs.writeFile(path.join(folder,`3.1623.0-${sha.slice(0,12)}-Claude-win-x64.msix`),payload);
  const restarted=new Manager(options);await restarted.init();t.after(()=>restarted.stop());await restarted.check();await restarted.install();assert.equal(installs,1);assert.equal(restarted.state.pending,null);assert.equal(restarted.state.installed.version,'3.1623.0.0');assert.deepEqual(calls.filter(url=>!url.startsWith('/releases/')),['/latest/manifest'],'the verified cache is reused instead of downloading');
});
test('manager consumes HTTP manifest, downloads and passes verified package to installer',async t=>{
  const base=await server(t,(req,res)=>res.end(req.url==='/latest/manifest'?JSON.stringify(manifest):payload));const dir=await temp(t);let current={installed:true,version:'3.1622.0',kind:'msix',running:false},installs=0;
  const m=new Manager({dir,info:platformInfo('win32','x64'),client:new ReleaseClient({mirror:base,api:base,repo:base,local:true}),platform:{status:async()=>current,install:async file=>{assert.deepEqual(await fs.readFile(file),payload);installs++;current={...current,version:'3.1623.0.0'};}}});await m.init();t.after(()=>m.stop());await m.settings({autoDownload:true,autoInstall:false});await m.check();assert.ok(m.state.ready);assert.equal(installs,0);await m.install();assert.equal(installs,1);assert.equal(m.state.installed.version,'3.1623.0.0');
});
