const {app,BrowserWindow,ipcMain,Tray,Menu,nativeImage,Notification,dialog,shell,nativeTheme,net}=require('electron');
const path=require('node:path');
const fs=require('node:fs/promises');
const {pathToFileURL}=require('node:url');
const {Manager}=require('./manager.cjs');
const platform=require('./platform.cjs');
const {REPO,ReleaseClient}=require('./core.cjs');
const {electronFetch}=require('./electron-fetch.cjs');
const smoke=process.argv.includes('--smoke');
const smokeRoot=path.resolve(process.env.CLAUDE_MANAGER_SMOKE_DIR||path.join(process.cwd(),'.tmp'));
if (smoke) app.setPath('userData',path.join(smokeRoot,'smoke-profile'));
let win,tray,manager,quitting=false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
app.on('second-instance',()=>show());
app.whenReady().then(async()=>{
  manager=new Manager({dir:app.getPath('userData'),client:new ReleaseClient({fetcher:electronFetch(net)}),platform:{...platform,install:(file,options)=>platform.install(file,shell,options)},notify:(title,body)=>{if(Notification.isSupported()) new Notification({title,body}).show();}});
  await manager.init();
  const entry=path.join(__dirname,'ui/index.html');
  win=new BrowserWindow({width:1120,height:820,minWidth:860,minHeight:680,title:'Claude APP Manager',icon:path.join(__dirname,'ui/icon.png'),backgroundColor:'#f6f7fa',show:false,autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:!smoke}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(url!==pathToFileURL(entry).href)event.preventDefault();});
  win.webContents.session.setPermissionRequestHandler((_,__,callback)=>callback(false));
  manager.on('state',state=>{if(!win.isDestroyed())win.webContents.send('state',state);});
  ipcMain.handle('manager',async(event,action,value)=>{
    if(event.sender!==win.webContents || event.senderFrame!==win.webContents.mainFrame)throw new Error('拒绝未知调用');
    switch(action){
      case 'state':return {...manager.snapshot(),appVersion:app.getVersion()};
      case 'check':return manager.check();
      case 'download':return manager.download();
      case 'cancel':manager.cancel();return;
      case 'install':{
        const result=await manager.install();
        if(!result?.confirmClose)return result;
        const list=result.confirmClose.map(p=>`${p.name}（PID ${p.pid}）${p.path?`\n${p.path}`:''}`).join('\n\n');
        const answer=await dialog.showMessageBox(win,{type:'warning',title:'关闭由 Claude 启动的程序',message:'以下程序由 Claude 启动，仍占用 Claude，Windows 需要关闭它们才能完成更新。',detail:`${list}\n\n关闭前请保存这些程序中的工作。取消则不做任何更改。`,buttons:['取消','关闭并完成更新'],defaultId:0,cancelId:0,noLink:true});
        if(answer.response!==1)return manager.snapshot();
        return manager.install(false,{closeProcesses:result.confirmClose.map(p=>p.pid)});
      }
      case 'launch':return platform.launch(shell);
      case 'settings':{
        if(!value || typeof value!=='object' || Array.isArray(value))throw new Error('无效设置');
        const old=manager.state.settings.launchAtLogin;
        const next=await manager.settings(value);
        nativeTheme.themeSource=next.settings.theme;
        if(old!==next.settings.launchAtLogin && process.platform==='win32' && app.isPackaged)app.setLoginItemSettings({openAtLogin:next.settings.launchAtLogin,path:process.env.PORTABLE_EXECUTABLE_FILE||app.getPath('exe'),args:['--background']});
        return next;
      }
      case 'uninstall':{
        if(smoke)throw new Error('测试模式禁用卸载');
        const answer=await dialog.showMessageBox(win,{type:'warning',title:'卸载 Claude',message:'卸载本机 Claude 桌面应用？',detail:'保留 Claude 个人数据。Claude 运行时请先退出。',buttons:['取消','卸载 Claude'],defaultId:0,cancelId:0});
        if(answer.response===1)await manager.uninstall();return manager.snapshot();
      }
      case 'cache':return manager.clearCache();
      case 'folder':return shell.openPath(path.join(app.getPath('userData'),'downloads'));
      case 'release':return shell.openExternal(manager.state.latest?.releaseUrl||`${REPO}/releases/latest`);
      case 'reference':return shell.openExternal('https://github.com/Wangnov/Codex-App-Manager');
      default:throw new Error('未知操作');
    }
  });
  nativeTheme.themeSource=manager.state.settings.theme;
  await win.loadFile(entry);
  if(!process.argv.includes('--background')&&!smoke)win.show();
  win.on('close',event=>{if(!quitting && !smoke && manager.state.settings.background){event.preventDefault();win.hide();}});
  const image=nativeImage.createFromPath(path.join(__dirname,'ui/icon.png')).resize({width:24,height:24});
  tray=new Tray(image);tray.setToolTip('Claude APP Manager');tray.setContextMenu(Menu.buildFromTemplate([{label:'打开 Claude APP Manager',click:show},{label:'检查 Claude 更新',click:()=>manager.check().catch(()=>{})},{type:'separator'},{label:'退出',click:()=>{quitting=true;app.quit();}}]));tray.on('double-click',show);
  if(smoke){
    try{
      const result=await win.webContents.executeJavaScript("({title:document.title,buttons:document.querySelectorAll('button').length,bridge:typeof window.manager.invoke,overflow:document.documentElement.scrollWidth>innerWidth})");
      if(result.bridge!=='function'||result.buttons<8||result.overflow)throw new Error(JSON.stringify(result));
      await manager.check();
      const live=await win.webContents.executeJavaScript("window.manager.invoke('state').then(s=>{render(s);return {installed:document.getElementById('installed-version').textContent,latest:document.getElementById('latest-version').textContent,badge:document.getElementById('status-badge').textContent}})");
      if(!manager.state.latest || manager.state.error || live.latest!==manager.state.latest.version)throw new Error(`Live check failed: ${manager.state.error||JSON.stringify(live)}`);
      await fs.mkdir(smokeRoot,{recursive:true});
      await fs.writeFile(path.join(smokeRoot,'smoke-result.json'),JSON.stringify({...result,live,state:manager.snapshot()},null,2));
      const paint=()=>win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
      await paint();
      const shot=await win.webContents.capturePage();await fs.writeFile(path.join(smokeRoot,'smoke.png'),shot.toPNG());
      for(const theme of ['light','dark']){
        await manager.settings({theme});
        const checked=await win.webContents.executeJavaScript(`window.manager.invoke('state').then(s=>{render(s);document.querySelector('[data-page="settings"]').click();return {visible:!document.getElementById('settings').hidden,enabled:!document.getElementById('theme').disabled,theme:document.documentElement.dataset.theme}})`);
        if(!checked.visible||!checked.enabled||checked.theme!==theme)throw new Error('Settings UI check failed');
        await paint();
        const image=await win.webContents.capturePage();await fs.writeFile(path.join(smokeRoot,`settings-${theme}.png`),image.toPNG());
      }
      await manager.settings({theme:'system'});
      const pendingUI=await win.webContents.executeJavaScript(`window.manager.invoke('state').then(s=>{s.pending={version:s.latest.version,requestedAt:new Date().toISOString()};render(s);page('overview');return {disabled:document.getElementById('primary').disabled,visible:!document.getElementById('pending-note').hidden,badge:document.getElementById('status-badge').textContent}})`);
      if(pendingUI.disabled||!pendingUI.visible||pendingUI.badge!=='等待完成注册')throw new Error('Deferred update UI check failed');
      await paint();
      const pendingShot=await win.webContents.capturePage();await fs.writeFile(path.join(smokeRoot,'pending-update.png'),pendingShot.toPNG());
      console.log('SMOKE_OK',JSON.stringify(result));
      quitting=true;app.quit();
    }catch(error){console.error(error);quitting=true;app.exit(1);}
  }else{manager.check().catch(()=>{});}
}).catch(error=>{console.error(error);app.exit(1);});
}
function show(){if(win&&!win.isDestroyed()){win.show();if(win.isMinimized())win.restore();win.focus();}}
app.on('before-quit',()=>{quitting=true;manager?.stop();});
app.on('window-all-closed',()=>{if(quitting||!manager?.state.settings.background)app.quit();});
app.on('activate',show);
