const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 自动备份：把数据写到 exe 所在文件夹的 JSON
  backupSave: (data) => ipcRenderer.invoke('backup:save', data),
  backupLoad: () => ipcRenderer.invoke('backup:load'),
  backupPath: () => ipcRenderer.invoke('backup:path'),
  onBeforeClose: (flush) => {
    const listener = async (_event, requestId) => {
      try {
        const result = await flush();
        ipcRenderer.send('backup:close-ready', { requestId, ok: !!(result && result.ok), error: result && result.error });
      } catch (e) {
        ipcRenderer.send('backup:close-ready', { requestId, ok: false, error: String(e.message || e) });
      }
    };
    ipcRenderer.on('backup:before-close', listener);
    ipcRenderer.send('backup:renderer-ready');
    return () => ipcRenderer.removeListener('backup:before-close', listener);
  },
});
