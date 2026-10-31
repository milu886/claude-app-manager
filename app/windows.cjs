const {execFile}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
// promisify(execFile) cannot feed stdin; the script travels there (see runScript).
function run(file,args,options){
  return new Promise((resolve,reject)=>{
    const child=execFile(file,args,options,(error,stdout,stderr)=>error?reject(Object.assign(error,{stdout,stderr})):resolve({stdout,stderr}));
    child.stdin?.end(options.input);
  });
}
// -EncodedCommand is capped by the 32K-character command line, which the script outgrew. Only this bootstrap is
// passed as an argument; the script arrives on stdin as Base64 of UTF-8, so console code pages cannot garble it.
const bootstrap=Buffer.from("$ProgressPreference = 'SilentlyContinue'\n. ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))))",'utf16le').toString('base64');
function runScript(code,options={},execute=run){
  const powershell=path.join(process.env.WINDIR||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  return execute(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',bootstrap],{windowsHide:true,maxBuffer:1024*1024,encoding:'utf8',...options,input:Buffer.from(code,'utf8').toString('base64')});
}

class WindowsOperationError extends Error {
  constructor(message,code){super(message);this.name='WindowsOperationError';this.code=code;}
}
function decodeCliXml(stderr=''){
  if(!stderr.includes('#< CLIXML'))return stderr.trim();
  return [...stderr.matchAll(/<S\b[^>]*\bS="Error"[^>]*>([\s\S]*?)<\/S>/g)].map(m=>m[1]
    .replace(/_x([0-9a-f]{4})_/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)))
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&')).join('\n').trim();
}
function operationError(detail,code){
  const detected=code||detail.match(/0x[0-9a-f]{8}/i)?.[0];
  const prefix=detected?.toUpperCase()==='0X80073D02'?'Claude 或相关后台组件仍被 Windows 占用。请完全退出 Claude 后重试；管理器不会强制结束会话。\n':'';
  return new WindowsOperationError(`${prefix}${detected?`[${detected}] `:''}${detail}`,detected);
}
function readResponse(stdout='',stderr='',exitCode){
  const raw=stdout.trim().replace(/^\uFEFF/,'');
  let result;
  try{result=JSON.parse(raw);}catch{}
  if(result?.ok===true && !exitCode)return result.result;
  if(result?.ok===false)throw operationError(result.error?.message||'Windows 未返回错误详情',result.error?.code);
  const detail=decodeCliXml(stderr);
  if(detail)throw operationError(detail);
  throw operationError(`Windows 操作未返回有效结果（退出码 ${exitCode??0}）。请重试并查看活动记录。`);
}
async function windows(action,file,options={},execute=run){
  const script=await fs.readFile(path.join(__dirname,'../scripts/platform.ps1'),'utf8');
  const data=Buffer.from(JSON.stringify({action,file,version:options.version,closeProcesses:options.closeProcesses||[]}),'utf8').toString('base64');
  const code=`$managerParams = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json\n${script}`;
  try{
    const result=await runScript(code,{timeout:['install','stage'].includes(action)?300000:30000},execute);
    return readResponse(result.stdout,result.stderr,0);
  }catch(error){
    if(error instanceof WindowsOperationError)throw error;
    if(error.killed)throw operationError('Windows 操作超时。请检查本机安装状态后再重试，避免重复提交。');
    if(error.code==='ENOENT')throw operationError('无法启动 Windows PowerShell，请检查系统组件是否完整。');
    return readResponse(error.stdout,error.stderr,error.code);
  }
}
module.exports={windows,runScript,readResponse,decodeCliXml,WindowsOperationError};
