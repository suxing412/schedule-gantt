const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 自动备份：把数据写到 exe 所在文件夹的 JSON
  backupSave: (data) => ipcRenderer.invoke('backup:save', data),
  backupLoad: () => ipcRenderer.invoke('backup:load'),
  backupPath: () => ipcRenderer.invoke('backup:path'),
});
