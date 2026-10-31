const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {ReleaseClient,platformInfo,downloadVerified}=require('../app/core.cjs');
(async()=>{
  const dir=path.resolve('.tmp/simulation-downloads');
  const client=new ReleaseClient({mirror:process.argv[2]||'http://127.0.0.1:4900/mirror',local:true});
  const release=await client.latest(platformInfo('win32','x64'));
  const file=await downloadVerified(client,release,dir);
  assert.match(await fs.readFile(file,'utf8'),/postman simulation installer fixture/);
  console.log(JSON.stringify({passed:true,version:release.version,sha256:release.sha256,bytes:release.size}));
})().catch(error=>{console.error(error);process.exitCode=1;});
