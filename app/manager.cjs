const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ReleaseClient, platformInfo, downloadVerified, hashFile, updateAvailable, compareVersions } = require('./core.cjs');
const defaults = { autoCheck:true, interval:1, autoDownload:false, autoInstall:false, source:'auto', background:true, launchAtLogin:false, theme:'system' };
class Manager extends EventEmitter {
  constructor({ dir, platform, client = new ReleaseClient(), info = platformInfo(), notify = () => {} }) {
    super(); this.dir=dir; this.platform=platform; this.client=client; this.info=info; this.notify=notify;
    this.state={info,settings:{...defaults},installed:null,latest:null,checkedAt:null,nextCheckAt:null,checking:false,job:null,ready:null,pending:null,error:null,logs:[]}; this.failures=0;
  }
  async init() {
    await fs.mkdir(this.dir,{recursive:true});
    try { this.state.settings = validateSettings(JSON.parse(await fs.readFile(path.join(this.dir,'settings.json'),'utf8'))); } catch {}
    try { this.state.logs = JSON.parse(await fs.readFile(path.join(this.dir,'history.json'),'utf8')).slice(-150); } catch {}
    try { const pending=JSON.parse(await fs.readFile(path.join(this.dir,'pending-update.json'),'utf8')); if(pending){compareVersions(pending.version,pending.version);this.state.pending={version:pending.version,requestedAt:pending.requestedAt,...(typeof pending.reason==='string'?{reason:pending.reason.slice(0,500)}:{})};} } catch {}
    this.publish();
  }
  snapshot() { return structuredClone(this.state); }
  async setPending(pending) {
    this.state.pending=pending;
    const file=path.join(this.dir,'pending-update.json');
    if(pending){await fs.writeFile(`${file}.tmp`,JSON.stringify(pending));await fs.rename(`${file}.tmp`,file);}
    else await fs.rm(file,{force:true});
  }
  publish() { this.emit('state',this.snapshot()); }
  log(message,level='info') {
    this.state.logs.push({at:new Date().toISOString(),message,level}); this.state.logs=this.state.logs.slice(-150);
    const data=JSON.stringify(this.state.logs,null,2);
    this.logWrite=(this.logWrite||Promise.resolve()).catch(()=>{}).then(()=>fs.writeFile(path.join(this.dir,'history.json'),data)).catch(()=>{});
  }
  async settings(patch) {
    this.settingsWrite=(this.settingsWrite||Promise.resolve()).catch(()=>{}).then(()=>this.writeSettings(patch));
    return this.settingsWrite;
  }
  async writeSettings(patch) {
    const next=validateSettings({...this.state.settings,...patch});
    const temp=path.join(this.dir,'settings.json.tmp'); await fs.writeFile(temp,JSON.stringify(next,null,2)); await fs.rename(temp,path.join(this.dir,'settings.json'));
    this.state.settings=next; this.schedule(); this.publish(); return this.snapshot();
  }
  schedule() {
    clearTimeout(this.timer); this.state.nextCheckAt=null;
    if (!this.state.settings.autoCheck) return;
    const delay=Math.min(30, this.state.settings.interval * 2 ** Math.min(this.failures,5))*60000;
    this.state.nextCheckAt=new Date(Date.now()+delay).toISOString();
    this.timer=setTimeout(()=>this.check().catch(()=>{}),delay); this.timer.unref?.();
  }
  async check() {
    if (this.state.checking) return this.snapshot();
    if (this.state.job) { this.schedule(); this.publish(); return this.snapshot(); }
    this.state.checking=true; this.state.error=null; this.publish();
    try {
      this.state.installed=await this.platform.status();
      if(this.state.pending){
        const target=this.state.pending.version;
        if(this.state.installed.installed && compareVersions(this.state.installed.version,target)>=0){
          await this.setPending(null);this.state.ready=null;this.log(`Claude ${target} 延后更新已完成`);this.notify('Claude 更新完成',`已安装 ${target}`);
        }else if(!this.state.installed.installed){await this.setPending(null);this.log('Claude 已卸载，已清除等待更新状态');}
      }
      const release=await this.client.latest(this.info,this.state.settings.source);
      const old=this.state.latest;
      this.state.latest=release; this.state.checkedAt=new Date().toISOString(); this.failures=0;
      if (this.state.ready && (this.state.ready.version !== release.version || this.state.ready.sha256 !== release.sha256)) this.state.ready=null;
      const available=updateAvailable(this.state.installed,release);
      if (!old || old.version !== release.version || old.sha256 !== release.sha256) {
        this.log(`检查到 Claude ${release.version}（${release.source}）`);
        if (available) this.notify('Claude 有新版本',`${this.state.installed.version} → ${release.version}`);
      }
      this.state.checking=false;
      if (available && this.state.settings.autoDownload) {
        if (!this.state.ready && !this.state.pending) await this.download();
        if (this.state.settings.autoInstall && process.platform === 'win32' && this.state.installed.kind === 'msix' && !this.state.installed.running) await this.install(true);
      }
    } catch(error) { this.failures++; this.state.error=error.message; this.log(error.message,'error'); }
    finally { this.state.checking=false; this.schedule(); this.publish(); }
    return this.snapshot();
  }
  async download() {
    if (this.state.job || this.state.checking) throw new Error('另一个操作正在进行');
    const release=this.state.latest; if (!release) throw new Error('请先检查更新');
    this.controller=new AbortController(); this.state.error=null; this.state.job={phase:'downloading',received:0,total:release.size}; this.publish();
    try {
      const urls=await this.downloadSources(release,this.controller.signal),started=Date.now();let cached=false,peak=1;
      const file=await downloadVerified(this.client,{...release,urls},path.join(this.dir,'downloads'),{signal:this.controller.signal,onProgress:p=>{cached||=Boolean(p.cached);peak=Math.max(peak,p.connections||1);this.state.job={...this.state.job,...p};this.publish();}});
      const seconds=(Date.now()-started)/1000;
      this.state.ready={file,...release};
      this.log(cached?`Claude ${release.version} 复用已校验的安装包缓存`:`Claude ${release.version} 下载完成（${(release.size/1048576).toFixed(0)} MB，用时 ${seconds.toFixed(0)} 秒，平均 ${(release.size/1048576/Math.max(seconds,0.1)).toFixed(1)} MB/s，最多 ${peak} 个连接），SHA-256 校验通过`);
      await this.stage(this.state.ready);
      return this.snapshot();
    } catch(error) {
      if (this.controller.signal.aborted) this.log('已取消下载');
      else { this.state.error=error.message; this.log(error.message,'error'); throw error; }
    } finally { this.controller=null; this.state.job=null; this.publish(); }
  }
  // Anthropic's version-pinned CDN URL is one more source for the same verified bytes ("GitHub only" keeps GitHub only).
  async downloadSources(release,signal) {
    const urls=[...release.urls];
    if (this.state.settings.source==='github' || !this.client.officialSource || urls.some(url=>new URL(url).hostname==='downloads.claude.ai')) return urls;
    try {
      const official=await this.client.officialSource(release,this.info,signal);
      if (official) { const at=urls.findIndex(url=>new URL(url).hostname==='github.com'); urls.splice(at<0?urls.length:at,0,official); }
    } catch {}
    return urls;
  }
  // Staging unpacks the MSIX into WindowsApps without touching a running Claude (40-80 s for a new version),
  // so "install" later only has to register it. Failure is not fatal: installation stages it again.
  async stage(ready) {
    if (!this.platform.stage || this.info.platform!=='win32' || this.state.installed?.kind==='classic' || ready.staged) return;
    this.state.job={phase:'staging'}; this.publish();
    const started=Date.now();
    try { await this.platform.stage(ready.file,{version:ready.version}); ready.staged=true; this.log(`Claude ${ready.version} 已预安装（用时 ${((Date.now()-started)/1000).toFixed(0)} 秒），完成更新时只需注册`); }
    catch(error) { this.log(`预安装未完成，将在安装时重试：${error.message}`,'error'); }
  }
  cancel() { this.controller?.abort(new Error('已取消下载')); }
  async install(automatic=false,{closeProcesses=[]}={}) {
    if (this.state.job || this.state.checking) throw new Error('另一个操作正在进行');
    if (this.state.pending && !this.state.ready) {
      if(!this.state.latest)throw new Error('请先检查更新以核验安装包');
      await this.download();
    }
    const ready=this.state.ready; if (!ready) throw new Error('请先下载并校验安装包');
    this.state.job={phase:'installing'}; this.state.error=null; this.publish();
    const started=Date.now();
    try {
      const installed=await this.platform.status(); this.state.installed=installed;
      if (installed.running && !(this.info.platform==='win32' && installed.kind==='msix')) throw new Error('Claude 正在运行，请退出 Claude 后再安装');
      if (installed.version && compareVersions(ready.version,installed.version)<0) throw new Error('检测到已安装版本较新，已阻止降级');
      const stat=await fs.stat(ready.file);
      if (stat.size !== ready.size || await hashFile(ready.file) !== ready.sha256) { this.state.ready=null; throw new Error('安装包校验失败，请重新下载'); }
      const result=await this.platform.install(ready.file,{version:ready.version,closeProcesses});
      if(result?.needsConfirmation){
        // Programs started from Claude keep its package identity. Closing them is the user's call; automatic installs never do it.
        const leftovers=result.leftovers||[],key=leftovers.map(p=>p.pid).sort().join(',');
        this.state.installed={...this.state.installed,leftovers};
        if(automatic){
          if(this.leftoverNotice!==key){this.leftoverNotice=key;this.log(`由 Claude 启动的程序仍在运行（${leftovers.map(p=>p.name).join('、')}），已跳过自动安装`);this.notify('Claude 更新等待中','由 Claude 启动的程序仍在运行，请在管理器中完成更新');}
          return this.snapshot();
        }
        return {...this.snapshot(),confirmClose:leftovers};
      }
      const {pending:_p,deferral:_d,targetVersion:_t,warnings:_w,...reported}=result||{};
      const current=async()=>reported.installed!==undefined?reported:this.platform.status();
      if(closeProcesses.length)this.log(`已关闭由 Claude 启动的程序（PID ${closeProcesses.join('、')}）`);
      if(result?.pending){
        this.state.installed=await current();
        const reason=deferralReason(result.deferral);
        await this.setPending({version:ready.version,requestedAt:new Date().toISOString(),...(reason?{reason}:{})});
        this.log(`Claude ${ready.version} 更新已暂存，Windows 尚未完成注册${reason?`（${reason}）`:''}；可点击“完成更新”重试`);
        if(automatic)this.notify('Claude 更新尚未完成','更新已暂存，请在管理器查看占用原因并完成更新');
      }else if (!result?.manual) {
        this.state.installed=await current();
        if (!this.state.installed.installed || compareVersions(this.state.installed.version,ready.version)<0) throw new Error('安装后的版本检查未通过');
        this.log(`Claude ${ready.version} 安装完成（用时 ${((Date.now()-started)/1000).toFixed(0)} 秒${ready.staged?'，已预安装':''}）`); if (automatic) this.notify('Claude 更新完成',`已安装 ${ready.version}`);
        this.state.ready=null;await this.setPending(null);
      } else { this.log('已打开系统安装程序，请完成安装后点击检查更新'); }
      if(result?.warnings?.length){this.state.error=result.warnings.join('\n');this.log(this.state.error,'error');}
    } catch(error) { this.state.error=error.message;this.log(error.message,'error');throw error; }
    finally { this.state.job=null;this.publish(); }
    return this.snapshot();
  }
  async uninstall() {
    if (this.state.job || this.state.checking) throw new Error('另一个操作正在进行');
    this.state.job={phase:'uninstalling'};this.publish();
    try { await this.platform.uninstall();this.state.installed=await this.platform.status();await this.setPending(null);this.log('Claude 已卸载，保留个人数据'); }
    catch(error){this.state.error=error.message;this.log(error.message,'error');throw error;}
    finally {this.state.job=null;this.publish();}
  }
  async clearCache() {
    if (this.state.job) throw new Error('操作进行中，无法清理缓存');
    const dir=path.join(this.dir,'downloads');
    for (const file of await fs.readdir(dir).catch(()=>[])) {
      if (/^\d+(\.\d+){1,3}-[a-f0-9]{12}-Claude-[\w.-]+$/.test(file) || /^\d+(\.\d+){1,3}-[a-f0-9]{12}-Claude-[\w.-]+\.part$/.test(file)) await fs.unlink(path.join(dir,file));
    }
    this.state.ready=null;this.log('已清理安装包缓存');this.publish();
  }
  stop() {clearTimeout(this.timer);this.controller?.abort();}
}
function deferralReason(deferral) {
  if (!deferral) return '';
  if (deferral.desktopRunning) return 'Claude 桌面端仍在运行，退出后才能完成注册';
  const parts=[];
  if (deferral.activeService) parts.push('Windows 报告 Claude 后台服务仍处于活动状态');
  if (deferral.runningApps?.length) parts.push(`Windows 报告仍在运行：${deferral.runningApps.join('、')}`);
  if (deferral.stoppedServices?.length) parts.push(`已临时停止并恢复 ${deferral.stoppedServices.join('、')}`);
  if (deferral.forcedShutdown) parts.push('已请求 Windows 关闭 Claude 残留进程');
  return parts.join('；');
}
function validateSettings(value) {
  const result={...defaults};
  for (const key of ['autoCheck','autoDownload','autoInstall','background','launchAtLogin']) if (typeof value[key]==='boolean') result[key]=value[key];
  if ([1,5,15,30].includes(value.interval)) result.interval=value.interval;
  if (['auto','github'].includes(value.source)) result.source=value.source;
  if (['system','light','dark'].includes(value.theme)) result.theme=value.theme;
  if (!result.autoDownload) result.autoInstall=false;
  return result;
}
module.exports={Manager,validateSettings,deferralReason,defaults};
