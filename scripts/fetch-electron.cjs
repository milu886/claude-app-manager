// Deterministic development bootstrap for hosts where the npm install hook is disabled.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const {pipeline}=require('node:stream/promises');
const {Readable,Transform}=require('node:stream');
const {createHash}=require('node:crypto');
(async()=>{
  const version=require('../node_modules/electron/package.json').version;
  const name=`electron-v${version}-win32-x64.zip`;
  const expected=require('../node_modules/electron/checksums.json')[name];
  const mirror=process.argv.includes('--mirror');
  const file=path.resolve('.tmp',mirror?`mirror-${name}`:name);await fsp.mkdir(path.dirname(file),{recursive:true});
  const url=mirror?`https://registry.npmmirror.com/-/binary/electron/${version}/${name}`:`https://github.com/electron/electron/releases/download/v${version}/${name}`;
  const r=await fetch(url,{signal:AbortSignal.timeout(240000)});
  if(!r.ok)throw new Error(`Electron HTTP ${r.status}`);
  const hash=createHash('sha256');let size=0,last=0;
  await pipeline(Readable.fromWeb(r.body),new Transform({transform(chunk,enc,cb){size+=chunk.length;hash.update(chunk);if(size-last>20e6){last=size;console.log(`Electron downloaded ${(size/1e6).toFixed(0)} MB`);}cb(null,chunk);}}),fs.createWriteStream(file));
  if(hash.digest('hex')!==expected)throw new Error('Electron checksum mismatch');
  console.log('Electron verified',file);
})().catch(e=>{console.error(e);process.exitCode=1;});
