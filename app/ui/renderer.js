/* The renderer has no network or filesystem access. All operations use the narrow preload bridge. */
const $=id=>document.getElementById(id);
let state=null,toastTimer,lastBytes=0,lastTime=0,speed=0;
const phaseNames={downloading:'正在下载安装包',verifying:'正在校验 SHA-256',ready:'下载完成',staging:'正在预安装（不影响正在运行的 Claude）',installing:'正在安装，请稍候',uninstalling:'正在卸载'};
const time=value=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
const bytes=value=>`${(value/1024/1024).toFixed(1)} MB`;
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5000);}
async function call(action,value){try{return await window.manager.invoke(action,value);}catch(error){toast(error.message.replace(/^Error invoking remote method '[^']+': Error: /,''));return null;}}
function page(name){document.querySelectorAll('.page').forEach(el=>el.hidden=el.id!==name);document.querySelectorAll('.nav').forEach(el=>el.classList.toggle('active',el.dataset.page===name));}
document.querySelectorAll('.nav').forEach(el=>el.addEventListener('click',()=>page(el.dataset.page)));
function newer(a,b){const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<4;i++){const d=(x[i]||0)-(y[i]||0);if(d)return d>0;}return false;}
function render(s){
  state=s;const installed=s.installed?.installed,latest=s.latest,busy=Boolean(s.job)||s.checking,available=installed&&latest&&newer(latest.version,s.installed.version);
  document.documentElement.dataset.theme=s.settings.theme;
  $('installed-version').textContent=s.installed?(installed?s.installed.version:'尚未安装'):'—';
  $('installed-kind').textContent=installed?({msix:'Windows MSIX',classic:'传统安装版本',dmg:'macOS 应用',deb:'Linux DEB'}[s.installed.kind]||'已安装'):'安装后可在这里管理';
  $('latest-version').textContent=latest?.version||'—';
  $('release-date').textContent=latest?`${time(latest.publishedAt)} 同步`:'检查更新后显示';
  $('platform-label').textContent=`${{win32:'Windows',darwin:'macOS',linux:'Linux'}[s.info.platform]||s.info.platform} / ${s.info.arch==='universal'?'通用架构':s.info.arch} · 官方离线安装包`;
  $('status-badge').textContent=s.checking?'正在检查':s.job?(phaseNames[s.job.phase]||'正在处理'):s.pending?'等待完成注册':available?'有可用更新':installed&&latest?'已是最新版本':installed?'已安装':'未安装';
  $('status-badge').className=`badge ${available?'update':installed&&latest?'good':''}`;
  $('check').disabled=busy;$('check-icon').classList.toggle('spin',s.checking);
  $('launch').disabled=!installed||busy;$('uninstall').disabled=!installed||busy||s.installed.kind!=='msix';
  $('primary').textContent=s.job?(phaseNames[s.job.phase]||'正在处理'):s.checking?'正在检查…':s.pending?'完成更新':s.ready?(installed?'安装更新':'安装 Claude'):!latest?'检查最新版本':!installed?'下载 Claude':available?'下载更新':'重新下载安装包';
  $('primary').disabled=busy;
  $('ready-note').hidden=!s.ready||busy||Boolean(s.pending);
  $('pending-note').hidden=!s.pending;
  const services=(s.installed?.services||[]).filter(service=>service.running);
  $('pending-note').textContent=!s.pending?'':s.installed?.running?'检测到 Claude 相关进程仍在运行。请保存工作并退出 Claude，再点击“完成更新”。':services.length?`后台服务 ${services.map(service=>service.name).join('、')} 正在运行。点击“完成更新”将临时停止 Claude 自带服务，并由 Windows 关闭 Claude 残留的后台进程，更新后恢复服务。`:'更新已暂存，Windows 尚未完成注册。点击“完成更新”重试，将复用已校验的安装包。';
  const leftovers=s.installed?.leftovers||[];
  if(s.pending&&!s.installed?.running&&leftovers.length)$('pending-note').textContent+=` 由 Claude 启动的程序仍在运行：${[...new Set(leftovers.map(p=>p.name))].join('、')}，完成更新时会请你确认是否关闭。`;
  if(s.pending?.reason)$('pending-note').textContent+=` 上次结果：${s.pending.reason}。`;
  $('job').hidden=!s.job;
  if(s.job){const job=s.job,p=job.total?Math.min(100,job.received/job.total*100):0;$('job-title').textContent=phaseNames[job.phase]||'正在处理';$('job-percent').textContent=job.total?`${p.toFixed(1)}%`:'';$('job-progress').value=p;$('cancel').hidden=!['downloading','verifying'].includes(job.phase);
    const now=Date.now();if(job.received<lastBytes){lastBytes=0;lastTime=now;speed=0;}if(now-lastTime>500){speed=(job.received-lastBytes)/((now-lastTime)/1000);lastBytes=job.received;lastTime=now;}
    $('job-size').textContent=job.total?`${bytes(job.received||0)} / ${bytes(job.total)}${speed>0?' · '+bytes(speed)+'/s':''}${job.phase==='downloading'&&job.connections>1?` · ${job.connections} 个连接（${[...new Set(job.hosts||[])].length} 个来源）`:''}`:'请勿关闭 Manager';}
  $('error').hidden=!s.error;$('error').textContent=s.error||'';
  $('source-label').textContent=latest?.source||(s.settings.source==='github'?'仅 GitHub':'国内镜像优先，GitHub 回退');$('asset-label').textContent=latest?`${latest.assetName}（${bytes(latest.size)}）`:s.info.assetName;$('last-check').textContent=time(s.checkedAt);$('next-check').textContent=s.nextCheckAt?time(s.nextCheckAt):s.settings.autoCheck?'稍后自动检查':'自动检查已关闭';$('hash-label').textContent=latest?.sha256||'等待版本信息';
  $('watch-label').textContent=s.settings.autoCheck?'自动检查已开启':'自动检查已关闭';$('monitor-dot').classList.toggle('paused',!s.settings.autoCheck);$('monitor-title').textContent=s.settings.autoCheck?'持续关注新版本':'自动检查已暂停';$('monitor-detail').textContent=s.settings.autoCheck?`每 ${s.settings.interval} 分钟检查${s.settings.autoDownload?'，发现新版本后自动下载':'，发现新版本时提醒'}。`:'可以手动检查，或在设置中重新开启。';
  for(const key of ['autoCheck','autoDownload','autoInstall','background','launchAtLogin']){$(key).checked=s.settings[key];$(key).disabled=false;}
  for(const key of ['interval','source','theme']){$(key).value=s.settings[key];$(key).disabled=false;}
  $('autoInstall').disabled=!s.settings.autoDownload||s.info.platform!=='win32';$('launchAtLogin').disabled=s.info.platform!=='win32';$('cache').disabled=busy;
  const list=$('history-list');list.replaceChildren();
  if(!s.logs.length){const p=document.createElement('p');p.className='empty';p.textContent='还没有活动记录。检查更新后，结果会显示在这里。';list.append(p);}
  for(const item of [...s.logs].reverse()){const row=document.createElement('div');row.className=`history-item ${item.level==='error'?'error-item':''}`;const date=document.createElement('time');date.textContent=time(item.at);const text=document.createElement('span');text.textContent=item.message;row.append(date,text);list.append(row);}
}
$('check').addEventListener('click',()=>call('check'));
$('primary').addEventListener('click',async()=>{if(!state?.latest)return call('check');if(state.ready||state.pending)return call('install');const result=await call('download');if(result)toast('安装包已校验通过，点击安装按钮完成安装。');});
for(const action of ['launch','cancel','release','uninstall','reference'])$(action).addEventListener('click',()=>call(action));
$('monitor-settings').addEventListener('click',()=>page('settings'));
$('cache').addEventListener('click',async()=>{try{await window.manager.invoke('cache');toast('已清理安装包缓存');}catch(error){toast(error.message);}});
for(const key of ['autoCheck','autoDownload','autoInstall','background','launchAtLogin','interval','source','theme'])$(key).addEventListener('change',async()=>{const el=$(key),value=el.type==='checkbox'?el.checked:key==='interval'?Number(el.value):el.value;el.disabled=true;const result=await call('settings',{[key]:value});if(result)render(result);else render(state);});
window.manager.subscribe(render);
call('state').then(s=>{if(s){$('app-version').textContent=s.appVersion;render(s);}});
