const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { fileURLToPath } = require('url');
const { validateProject } = require('./project-validation');

const STORAGE_FORMAT = 'schedule-gantt-storage';
const MAX_STORAGE_BYTES = 32 * 1024 * 1024; // 格式化 JSON 的空白也计入文件大小。

// 开发版用项目目录；便携版的数据随 exe 一起迁移。
function backupDir() {
  if (!app.isPackaged) return __dirname;
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  return path.dirname(app.getPath('exe'));
}
const backupFile = () => path.join(backupDir(), '排期数据.json');
const previousFile = file => file.replace(/\.json$/i, '') + '.previous.json';

function normalizeStorage(input) {
  const wrapped = input && input.format === STORAGE_FORMAT;
  if (wrapped && (input.version !== 1 || !Number.isSafeInteger(input.revision) || input.revision < 0)) {
    throw new Error('备份版本信息无效');
  }
  const project = validateProject(input);
  if (!wrapped) return project;
  const savedAt = input.savedAt;
  if (typeof savedAt !== 'string' || !Number.isFinite(Date.parse(savedAt))) throw new Error('备份保存时间无效');
  if (input.projectId !== undefined && (typeof input.projectId !== 'string' || !/^[a-f0-9]{32}$/i.test(input.projectId))) {
    throw new Error('备份项目身份无效');
  }
  return {
    format: STORAGE_FORMAT, version: 1, revision: input.revision, savedAt,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId.toLowerCase() }), project,
  };
}

function readStorageFile(file) {
  if (fs.statSync(file).size > MAX_STORAGE_BYTES) throw new Error('备份文件过大');
  return normalizeStorage(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function atomicWriteJSON(file, data) {
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function writeBackup(input, file = backupFile()) {
  const data = normalizeStorage(input);
  // 损坏的当前文件不覆盖仍可恢复的前一版。
  if (fs.existsSync(file)) {
    let previous;
    try { previous = readStorageFile(file); } catch (_) { /* 保留既有前版。 */ }
    if (previous) atomicWriteJSON(previousFile(file), previous);
  }
  atomicWriteJSON(file, data);
  return { ok: true, path: file, revision: data.format === STORAGE_FORMAT ? data.revision : 0 };
}

function readBackup(file = backupFile()) {
  let error;
  for (const candidate of [file, previousFile(file)]) {
    if (!fs.existsSync(candidate)) continue;
    try { return { data: readStorageFile(candidate), path: candidate, recovered: candidate !== file }; }
    catch (e) { error = String(e.message || e); }
  }
  return { data: null, path: file, recovered: false, ...(error ? { error } : {}) };
}

let mainWindow;
let rendererCanFlush = false;
let closingRequest = null;
let closeTimer = null;
let allowClose = false;
let closeDialogOpen = false;

function isTrusted(event) {
  return !!mainWindow && event.sender === mainWindow.webContents;
}

async function reportCloseFailure(detail) {
  if (!mainWindow || closeDialogOpen) return;
  closeDialogOpen = true;
  const currentWindow = mainWindow;
  try {
    const result = await dialog.showMessageBox(currentWindow, {
      type: 'warning', title: '排期尚未保存',
      message: '最后一次修改尚未确认保存。',
      detail: detail || '请返回工具导出备份，避免丢失未保存的修改。',
      buttons: ['返回工具', '仍然退出'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response === 1 && mainWindow === currentWindow) { allowClose = true; currentWindow.close(); }
  } catch (e) {
    console.error('保存失败提示未能显示', e);
  } finally { closeDialogOpen = false; closingRequest = null; }
}

function createWindow() {
  rendererCanFlush = false;
  allowClose = false;
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600,
    title: '排期工具', backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
    },
  });
  const page = path.join(__dirname, 'index.html');
  const staysInApp = target => {
    try { return path.resolve(fileURLToPath(target)) === path.resolve(page); } catch (_) { return false; }
  };
  mainWindow.webContents.on('will-navigate', (event, target) => { if (!staysInApp(target)) event.preventDefault(); });
  mainWindow.webContents.on('will-redirect', (event, target) => { if (!staysInApp(target)) event.preventDefault(); });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.on('close', event => {
    if (allowClose || !rendererCanFlush) return;
    event.preventDefault();
    if (closingRequest || closeDialogOpen) return;
    closingRequest = crypto.randomBytes(12).toString('hex');
    mainWindow.webContents.send('backup:before-close', closingRequest);
    closeTimer = setTimeout(() => { closeTimer = null; reportCloseFailure('工具未及时响应保存请求，请返回工具确认数据或导出备份。'); }, 15000);
  });
  mainWindow.on('closed', () => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null; closingRequest = null; mainWindow = null; rendererCanFlush = false;
  });
  mainWindow.loadFile(page);
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('backup:save', async (event, data) => {
  if (!isTrusted(event)) return { ok: false, error: '未经授权的保存请求' };
  try { return writeBackup(data); }
  catch (e) { console.error('备份写入失败', e); return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('backup:load', async event => {
  if (!isTrusted(event)) return { data: null, error: '未经授权的读取请求' };
  return readBackup();
});
ipcMain.handle('backup:path', async event => isTrusted(event) ? backupFile() : null);
ipcMain.on('backup:renderer-ready', event => { if (isTrusted(event)) rendererCanFlush = true; });
ipcMain.on('backup:close-ready', (event, result) => {
  if (!isTrusted(event) || !result || result.requestId !== closingRequest) return;
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = null;
  if (result.ok) { allowClose = true; mainWindow.close(); }
  else reportCloseFailure(result.error);
});

module.exports = { backupDir, backupFile, previousFile, normalizeStorage, atomicWriteJSON, writeBackup, readBackup, createWindow };
