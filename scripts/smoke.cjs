const {spawn}=require('node:child_process');
const path=require('node:path');
const exe=process.argv[2]?path.resolve(process.argv[2]):require('electron');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
env.CLAUDE_MANAGER_SMOKE_DIR=path.resolve('.tmp',process.argv[2]?'packaged-smoke':'');
const args=process.argv[2]?['--smoke']:[path.join(__dirname,'..'),'--smoke'];
const child=spawn(exe,args,{env,stdio:'inherit',windowsHide:true});
const timer=setTimeout(()=>{child.kill();console.error('Smoke test timed out');process.exitCode=1;},120000);
child.on('exit',code=>{clearTimeout(timer);process.exitCode=code??1;});
