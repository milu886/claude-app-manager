const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {runScript}=require('../app/windows.cjs');
const {deferralReason}=require('../app/manager.cjs');
const source=fs.readFileSync(path.join(__dirname,'../scripts/platform.ps1'),'utf8');
const boundary=source.indexOf('\ntry {\n    switch');
assert.ok(boundary>0,'Native helper definitions must be isolated from action dispatch');
const definitions=source.slice(0,boundary);
const shims=`
Add-Type -AssemblyName System.ServiceProcess
$script:trace = [Collections.Generic.List[string]]::new()
function Stop-Service { [CmdletBinding()]param($Name) $script:trace.Add('stop') }
function Start-Service { [CmdletBinding()]param($Name) $script:trace.Add('start'); if($config.restoreFails){ throw 'restore failed' } }
function Get-Service {
    [CmdletBinding()]param($Name)
    $controller = [pscustomobject]@{ Name=$Name }
    $controller | Add-Member -MemberType ScriptMethod -Name WaitForStatus -Value { param($status,$timeout) } -PassThru
}
function Add-AppxPackage {
    [CmdletBinding()]param($Path,[switch]$DeferRegistrationWhenPackagesAreInUse,[switch]$ForceApplicationShutdown)
    $script:trace.Add('install')
    if ($DeferRegistrationWhenPackagesAreInUse -eq $ForceApplicationShutdown) { throw 'exactly one deployment mode is required' }
    $script:mode = if ($ForceApplicationShutdown) { 'force' } else { 'defer' }
    if ($config.installFails) { throw 'deployment failed 0x80073D02' }
}
function Get-CimInstance { [CmdletBinding()]param($ClassName,$Filter) return [pscustomobject]@{Name='CoworkVMService';DisplayName='Claude';State='Running';ProcessId=42;PathName=$config.binary} }
$script:clock = 0; $script:polls = 0
function Start-Sleep { param($Milliseconds) $script:clock += $Milliseconds }
function Get-Date { [datetime]'2026-01-01' + [TimeSpan]::FromMilliseconds($script:clock) }
function Get-Process {
    [CmdletBinding()]param($Id,$Name)
    if ($Name) { if ($config.desktopAppears) { return [pscustomobject]@{ Name = $Name } }; return }
    $script:polls++
    if ($config.neverExits -or $script:polls -le [int]$config.lingerPolls) { return [pscustomobject]@{ Id = $Id } }
    if (-not $script:exited) { $script:exited = $true; $script:trace.Add('exited') }
}
function Desktop-Running($before) { [bool]$config.desktopAppears }
function Get-WinEvent {
    [CmdletBinding()]param($FilterHashtable)
    foreach ($item in @($config.events)) { [pscustomobject]@{ Id = $item.id; Properties = @($item.values | ForEach-Object { [pscustomobject]@{ Value = $_ } }) } }
}
`;
async function scenario(config,body){
  const encoded=Buffer.from(JSON.stringify(config)).toString('base64');
  const script=`${definitions}\n$config=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json\n${shims}\n${body}`;
  const result=await runScript(script,{timeout:15000});
  return JSON.parse(result.stdout.trim());
}
const invoke=`
$before=@{running=[bool]$config.desktopRunning;services=@(@{name='CoworkVMService';processId=42;running=-not [bool]$config.initiallyStopped})}
$failure=$null
try { Install-Claude 'inert-fixture.msix' $before } catch { $failure=$_.Exception.Message }
@{ trace=@($script:trace.ToArray());mode=$script:mode;error=$failure;warnings=@($script:serviceWarnings) } | ConvertTo-Json -Compress
`;
const winOnly={skip:process.platform!=='win32'};
test('idle Claude service is stopped, install runs, and service is restored',winOnly,async()=>{
  const result=await scenario({},invoke);assert.deepEqual(result.trace,['stop','exited','install','start']);assert.equal(result.mode,'force');assert.equal(result.error,null);assert.deepEqual(result.warnings,[]);
});
test('a desktop that starts during service shutdown is deferred instead of force-closed',winOnly,async()=>{
  const result=await scenario({desktopAppears:true},invoke);assert.deepEqual(result.trace,['stop','exited','install','start']);assert.equal(result.mode,'defer');
});
test('install waits for the stopped service process to exit before deploying',winOnly,async()=>{
  const result=await scenario({lingerPolls:5},invoke);assert.deepEqual(result.trace,['stop','exited','install','start']);assert.equal(result.error,null);
});
test('a service process that never exits blocks deployment and is still restored',winOnly,async()=>{
  const result=await scenario({neverExits:true},invoke);assert.deepEqual(result.trace,['stop','start']);assert.match(result.error,/60 秒内未退出/);
});
test('deferral reason is read from structured deployment events for this package only',winOnly,async()=>{
  const events=[{id:638,values:['Claude_pzs8sxrjxfjjc!Claude','Claude_4.4212.0.0_x64__pzs8sxrjxfjjc']},{id:638,values:['Other_abc!App','Other_1.0.0.0_x64__abc']},{id:638,values:['Claude_pzs8sxrjxfjjc!Claude','Claude_4.4212.0.0_x64__pzs8sxrjxfjjc']},{id:9641,values:[-2147467260,'Claude_pzs8sxrjxfjjc!Claude']}];
  const result=await scenario({events},`Deferral-Reason (Get-Date) 'Claude_pzs8sxrjxfjjc' | ConvertTo-Json -Compress`);
  assert.deepEqual(result.runningApps,['Claude_pzs8sxrjxfjjc!Claude']);assert.equal(result.activeService,true);
  const quiet=await scenario({events:[]},`Deferral-Reason (Get-Date) 'Claude_pzs8sxrjxfjjc' | ConvertTo-Json -Compress`);assert.deepEqual(quiet.runningApps,[]);assert.equal(quiet.activeService,false);
});
test('deferral reason text separates a running desktop from Windows-reported blockers',()=>{
  assert.equal(deferralReason(null),'');assert.match(deferralReason({desktopRunning:true,runningApps:['Claude_x!Claude']}),/桌面端仍在运行/);
  assert.equal(deferralReason({desktopRunning:false,activeService:false,runningApps:['Claude_x!Claude'],stoppedServices:['CoworkVMService']}),'Windows 报告仍在运行：Claude_x!Claude；已临时停止并恢复 CoworkVMService');
  assert.match(deferralReason({desktopRunning:false,runningApps:[],forcedShutdown:true}),/关闭 Claude 残留进程/);
});
test('deployment failure still restores the service and preserves original error',winOnly,async()=>{
  const result=await scenario({installFails:true},invoke);assert.deepEqual(result.trace,['stop','exited','install','start']);assert.match(result.error,/0x80073D02/);
});
test('an active Claude desktop session is deferred without stopping its service',winOnly,async()=>{
  const result=await scenario({desktopRunning:true},invoke);assert.deepEqual(result.trace,['install']);assert.equal(result.mode,'defer');assert.equal(result.error,null);
});
test('a service that was stopped remains stopped after installation',winOnly,async()=>{
  const result=await scenario({initiallyStopped:true},invoke);assert.deepEqual(result.trace,['install']);assert.equal(result.mode,'force');
});
test('restoration failure is surfaced without masking deployment failure',winOnly,async()=>{
  const result=await scenario({installFails:true,restoreFails:true},invoke);assert.match(result.error,/deployment failed/);assert.equal(result.warnings.length,1);assert.match(result.warnings[0],/restore failed/);
});
test('service ownership requires the exact cowork binary inside the installed package',winOnly,async()=>{
  const body=`$items=@(Claude-Services @{InstallLocation='C:\\test-package'});@{count=$items.Count;items=$items}|ConvertTo-Json -Compress -Depth 4`;
  const unrelated=await scenario({binary:'"C:\\unrelated\\cowork-svc.exe"'},body);assert.equal(unrelated.count,0);
  const owned=await scenario({binary:'"C:\\test-package\\app\\resources\\cowork-svc.exe"'},body);assert.equal(owned.count,1);assert.equal(owned.items[0].name,'CoworkVMService');
});
test('package members split desktop processes from Claude-started programs and skip the service',winOnly,async()=>{
  const body=`function Package-Processes($family) { ,@(@{pid=1;name='claude';path='C:\pkg\app\Claude.exe'},@{pid=42;name='cowork-svc';path=$null},@{pid=7;name='java';path='C:\erp\jdk64\bin\java.exe'}) }
$m=Package-Members 'Claude_x' 'C:\pkg\' @(42); @{desktop=@($m.desktop|ForEach-Object{$_.pid});leftovers=@($m.leftovers|ForEach-Object{$_.pid})}|ConvertTo-Json -Compress`;
  const result=await scenario({},body);assert.deepEqual(result.desktop,[1]);assert.deepEqual(result.leftovers,[7]);
});
test('the real package identity probe compiles and returns an empty list for an unknown package',winOnly,async()=>{
  const result=await scenario({},`$found=Package-Processes 'NoSuchPackage_0000000000000'; @{isNull=($null -eq $found);count=@($found).Count}|ConvertTo-Json -Compress`);
  assert.equal(result.isNull,false);assert.equal(result.count,0);
});
const dispatch=source.slice(boundary);
async function installAction(config,closeProcesses){
  const overrides=`
function Status { if ($script:installed) { return @{ installed=$true; kind='msix'; version='3.1623.0.0'; aumid='Claude_x!Claude' } }; return @{ installed=$true; kind='msix'; version='3.1622.0.0'; running=[bool]$config.running; leftovers=@($config.leftovers); services=@() } }
function Assert-Signature($file) { $script:trace.Add('signature') }
function Install-Claude($file,$before) { $script:trace.Add('install'); $script:installed=$true }
function Close-Leftovers($leftovers) { $script:trace.Add('close:' + (@($leftovers | ForEach-Object { $_.pid }) -join ',')) }
$managerParams=[pscustomobject]@{ action='install'; file='inert.msix'; version='3.1623.0'; closeProcesses=@(${closeProcesses.join(',')}) }`;
  const out=await scenario(config,`${overrides}\n$json = & { ${dispatch} }\n@{ response = ($json | ConvertFrom-Json); trace = @($script:trace.ToArray()) } | ConvertTo-Json -Compress -Depth 6`);
  return {result:out.response.result,trace:out.trace};
}
test('install asks before closing Claude-started programs and closes only approved ones',winOnly,async()=>{
  const leftovers=[{pid:7,name:'java',path:'C:\erp\java.exe'}];
  const asked=await installAction({leftovers},[]);assert.equal(asked.result.needsConfirmation,true);assert.equal(asked.result.leftovers[0].pid,7);assert.deepEqual(asked.trace,[]);
  const other=await installAction({leftovers},[8]);assert.equal(other.result.needsConfirmation,true);assert.deepEqual(other.trace,[]);
  const approved=await installAction({leftovers},[7]);assert.deepEqual(approved.trace,['close:7','signature','install']);assert.equal(approved.result.pending,false);
  const running=await installAction({leftovers,running:true},[]);assert.deepEqual(running.trace,['signature','install'],'a running desktop is deferred, nothing is closed');
});
