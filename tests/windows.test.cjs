const {test}=require('node:test');
const assert=require('node:assert/strict');
const {windows,readResponse,decodeCliXml}=require('../app/windows.cjs');
const progress='#< CLIXML\r\n<Objs><S S="progress">Preparing modules for first use.</S></Objs>';
test('successful JSON output ignores PowerShell progress on stderr',()=>{
  assert.deepEqual(readResponse(JSON.stringify({ok:true,result:{installed:true}}),progress,0),{installed:true});
});
test('structured deployment error survives nonzero exit and CLIXML progress',async()=>{
  const execute=async()=>{throw Object.assign(new Error('hidden command'),{code:1,stdout:JSON.stringify({ok:false,error:{code:'0x80073D02',message:'部署失败，因为 Claude_3.1623.0.0 仍在使用中'}}),stderr:progress});};
  await assert.rejects(windows('install','fixture.msix',{version:'3.1623.1'},execute),e=>e.code==='0x80073D02' && /Claude_3.1623.0.0/.test(e.message) && /不会强制/.test(e.message) && !/服务与权限/.test(e.message));
});
test('legacy CLIXML error records are decoded without including progress records',()=>{
  const xml='#< CLIXML\r\n<Objs><S S="progress">进度</S><S S="Error">部署失败 0x80073D02_x000D__x000A_Claude &amp; helper &lt;busy&gt;</S></Objs>';
  assert.equal(decodeCliXml(xml),'部署失败 0x80073D02\r\nClaude & helper <busy>');assert.throws(()=>readResponse('',xml,1),/0x80073D02/);
});
test('command startup and timeout errors are distinct and do not expose encoded arguments',async()=>{
  await assert.rejects(windows('status',null,{},async()=>{throw Object.assign(new Error('secret encoded command'),{code:'ENOENT'});}),/无法启动 Windows PowerShell/);
  await assert.rejects(windows('install',null,{},async()=>{throw Object.assign(new Error('secret encoded command'),{killed:true});}),/操作超时/);
});
test('malformed child output does not masquerade as permissions failure',()=>{
  assert.throws(()=>readResponse('not json','',1),/未返回有效结果/);
});
test('real Windows PowerShell returns structured Chinese diagnostics', {skip:process.platform!=='win32'},async()=>{
  await assert.rejects(windows('unknown-test-action'),e=>/未知操作/.test(e.message)&&/^0x/i.test(e.code));
});
test('native signature check explicitly loads the Windows PowerShell system module', {skip:process.platform!=='win32'},async()=>{
  const file=require('node:path').join(process.env.WINDIR||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=await windows('signature',file);assert.equal(typeof result.status,'string');assert.match(result.subject,/Microsoft/);
});
