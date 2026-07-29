const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// 备份文件位置：优先 exe 所在目录（便携版），否则 exe 目录，开发时用项目目录
function backupDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  try { return path.dirname(app.getPath('exe')); } catch (e) { return __dirname; }
}
const backupFile = () => path.join(backupDir(), '排期数据.json');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: '排期工具',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- 自动备份：读写 exe 同目录下的 排期数据.json ----
ipcMain.handle('backup:save', async (_e, data) => {
  try {
    fs.writeFileSync(backupFile(), JSON.stringify(data, null, 2), 'utf-8');
    return { ok: true, path: backupFile() };
  } catch (e) { console.error('备份写入失败', e); return { ok: false, error: String(e) }; }
});

ipcMain.handle('backup:load', async () => {
  try {
    const p = backupFile();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (e) { console.error('备份读取失败', e); return null; }
});

ipcMain.handle('backup:path', async () => backupFile());
