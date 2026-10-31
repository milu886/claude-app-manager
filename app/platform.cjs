const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const run = promisify(execFile);
const {windows}=require('./windows.cjs');
async function status() {
  if (process.platform === 'win32') return windows('status');
  if (process.platform === 'darwin') {
    for (const file of ['/Applications/Claude.app', path.join(require('node:os').homedir(),'Applications/Claude.app')]) {
      try { const {stdout} = await run('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',`${file}/Contents/Info.plist`]); return {installed:true,version:stdout.trim(),path:file,kind:'dmg'}; } catch {}
    }
  } else if (process.platform === 'linux') {
    try { const {stdout} = await run('dpkg-query',['-W','-f=${Status}\t${Version}','claude-desktop']); const [state,version] = stdout.trim().split('\t'); if (state === 'install ok installed') return {installed:true,version:version.split('-')[0],kind:'deb'}; } catch {}
  }
  return {installed:false,version:null,running:false};
}
async function install(file, shell, options={}) {
  if (process.platform === 'win32') return windows('install',file,options);
  const error = await shell.openPath(file); if (error) throw new Error(error);
  return {manual:true};
}
async function stage(file, options={}) {
  if (process.platform === 'win32') return windows('stage',file,options);
}
async function launch(shell) {
  if (process.platform === 'win32') return windows('launch');
  if (process.platform === 'darwin') { await run('open',['-a','Claude']); return; }
  await run('claude-desktop',[],{timeout:5000}).catch(e => { if (!e.killed) throw e; });
}
async function uninstall() {
  if (process.platform !== 'win32') throw new Error('请在系统应用管理中卸载 Claude。');
  return windows('uninstall');
}
module.exports = { status, install, stage, launch, uninstall };
