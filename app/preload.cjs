const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('manager',{
  invoke:(action,value)=>ipcRenderer.invoke('manager',action,value),
  subscribe:callback=>{ const listener=(_,state)=>callback(state);ipcRenderer.on('state',listener);return ()=>ipcRenderer.removeListener('state',listener); }
});
