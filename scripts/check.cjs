const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
let count=0;
function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())walk(file);else if(/\.(cjs|js)$/.test(item.name)){const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(r.status!==0){console.error(r.stderr);process.exitCode=1;}count++;}}}
for(const dir of ['app','scripts','tests'])walk(dir);
console.log(`Syntax checked ${count} JavaScript files`);
