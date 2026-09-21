const { app, BrowserWindow, ipcMain, Menu, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, execFile } = require('node:child_process');
const { dialog } = require('electron');
const { initDatabase, listComputers, listPeripherals, listAuditLogs, getLookupValues, getAuthState, registerUser, authenticateUser, setActiveUser, saveComputer, deleteComputer, savePeripheral, deletePeripheral, backupDatabase, resetDatabase, exportInventoryCsv } = require('./database');

let mainWindow;
const savedPasswordPath = () => path.join(app.getPath('userData'), 'remote-password.dat');

function loadSavedPassword() {
  if (!safeStorage.isEncryptionAvailable()) return '';
  try {
    const encrypted = fs.readFileSync(savedPasswordPath(), 'utf8');
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return '';
  }
}

function saveRemotePassword(password) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const target = savedPasswordPath();
  if (!String(password || '')) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    return true;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, safeStorage.encryptString(String(password)).toString('base64'), 'utf8');
  return true;
}

function requireSession() {
  const auth = getAuthState();
  if (!auth.currentUser) throw new Error('Please sign in first.');
  return auth.currentUser;
}

function resourcePath(relativePath) {
  return app.isPackaged
    ? path.join(process.resourcesPath, relativePath)
    : path.join(__dirname, '..', relativePath);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 650,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false
    },
    autoHideMenuBar: true,
    menuBarVisible: false
  });
  mainWindow.webContents.on('devtools-opened', () => mainWindow.webContents.closeDevTools());
  mainWindow.webContents.on('did-finish-load', () => mainWindow.webContents.setZoomFactor(0.8));
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.control && input.shift && input.key.toUpperCase() === 'R') {
      _event.preventDefault();
      mainWindow.webContents.reload();
      return;
    }
    const blocked = input.key === 'F12' ||
      (input.control && input.shift && ['I', 'J', 'C'].includes(input.key.toUpperCase()));
    if (blocked) _event.preventDefault();
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function runPowerShell(request) {
  if (request.mode === 'remote') {
    const hostname = String(request.hostname || '').trim();
    if (!hostname || !/^[A-Za-z0-9.-]+$/.test(hostname)) throw new Error('Enter a valid remote hostname or IP address.');
    if (!String(request.username || '').trim()) throw new Error('Remote username is required.');
    if (!String(request.password || '')) throw new Error('Remote password is required.');
  }
  return new Promise((resolve, reject) => {
    const worker = resourcePath(path.join('powershell', 'pcinfo-worker.ps1'));
    const executable = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const child = spawn(executable, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', worker
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('PowerShell collection timed out after 60 seconds. Check WinRM, TrustedHosts, and the target setup.'));
    }, 60000);
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
      try {
        const result = JSON.parse(stdout);
        if (!result.ok) return reject(new Error(result.error || 'PowerShell operation failed.'));
        resolve(result.data);
      } catch {
        reject(new Error(stderr.trim() || 'PowerShell returned invalid JSON.'));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

function addTrustedHost(hostname) {
  if (!/^[A-Za-z0-9.-]+$/.test(String(hostname || ''))) {
    return Promise.reject(new Error('Enter a valid hostname or IP address.'));
  }
  return new Promise((resolve, reject) => {
    const script = resourcePath(path.join('scripts', 'add-trusted-host.ps1'));
    const command = `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${script.replace(/'/g, "''")}','-HostName','${String(hostname).replace(/'/g, "''")}'); exit $p.ExitCode`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) return reject(new Error(stderr.trim() || 'The elevated TrustedHosts operation was cancelled or failed.'));
      resolve(`TrustedHosts updated for ${hostname}.`);
    });
  });
}

async function downloadTargetSetup() {
  const source = resourcePath(path.join('scripts', 'target-setup.ps1'));
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save CHICTool target setup script',
    defaultPath: 'chictool-target-setup.ps1',
    filters: [{ name: 'PowerShell script', extensions: ['ps1'] }]
  });
  if (result.canceled || !result.filePath) return 'Download cancelled.';
  fs.copyFileSync(source, result.filePath);
  return `Target setup script saved to ${result.filePath}`;
}

async function saveDatabaseBackup() {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Back up CHIT database',
    defaultPath: 'chictool-backup.db',
    filters: [{ name: 'SQLite database', extensions: ['db'] }]
  });
  if (result.canceled || !result.filePath) return 'Database backup cancelled.';
  backupDatabase(result.filePath);
  return `Database backup saved to ${result.filePath}`;
}

async function saveInventoryExport() {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export inventory CSV',
    defaultPath: 'chictool-inventory.csv',
    filters: [{ name: 'CSV file', extensions: ['csv'] }]
  });
  if (result.canceled || !result.filePath) return 'CSV export cancelled.';
  const exportResult = exportInventoryCsv(result.filePath);
  return `Exported ${exportResult.count} inventory records to ${result.filePath}`;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  if (app.isPackaged) {
    const portableDirectory = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
    process.env.PCINFO_DATA_DIR = path.join(portableDirectory, 'data');
  }
  initDatabase();

  ipcMain.handle('inventory:list', () => { requireSession(); return listComputers(); });
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), dataPath: process.env.PCINFO_DATA_DIR || path.join(__dirname, '..', 'data') }));
  ipcMain.handle('auth:state', () => getAuthState());
  ipcMain.handle('auth:login', (_event, username, password) => {
    const user = authenticateUser(username, password);
    setActiveUser(user);
    return user;
  });
  ipcMain.handle('auth:register', (_event, username, password) => {
    const user = registerUser(username, password);
    if (!getAuthState().currentUser) setActiveUser(user);
    return user;
  });
  ipcMain.handle('auth:logout', () => { setActiveUser(null); return true; });
  ipcMain.handle('credentials:loadPassword', () => loadSavedPassword());
  ipcMain.handle('credentials:savePassword', (_event, password) => saveRemotePassword(password));
  ipcMain.handle('audit:list', () => { requireSession(); return listAuditLogs(); });
  ipcMain.handle('peripherals:list', (_event, computerId, filter) => { requireSession(); return listPeripherals(computerId, filter); });
  ipcMain.handle('peripherals:save', (_event, peripheral) => { requireSession(); return savePeripheral(peripheral); });
  ipcMain.handle('peripherals:delete', (_event, id) => { requireSession(); return deletePeripheral(id); });
  ipcMain.handle('lookup:list', () => { requireSession(); return getLookupValues(); });
  ipcMain.handle('inventory:save', (_event, record) => { requireSession(); return saveComputer(record); });
  ipcMain.handle('inventory:delete', (_event, id) => { requireSession(); return deleteComputer(id); });
  ipcMain.handle('database:backup', () => { requireSession(); return saveDatabaseBackup(); });
  ipcMain.handle('database:reset', () => { requireSession(); return resetDatabase(); });
  ipcMain.handle('inventory:exportCsv', () => { requireSession(); return saveInventoryExport(); });
  ipcMain.handle('view:zoom', (_event, direction) => {
    if (Number(direction) === 0) {
      mainWindow.webContents.setZoomFactor(0.8);
      return 0.8;
    }
    const step = Number(direction) < 0 ? -0.1 : 0.1;
    const current = mainWindow.webContents.getZoomFactor();
    const next = Math.min(1.5, Math.max(0.5, Math.round((current + step) * 10) / 10));
    mainWindow.webContents.setZoomFactor(next);
    return next;
  });
  ipcMain.handle('inventory:collect', (_event, request) => runPowerShell(request));
  ipcMain.handle('inventory:testConnection', (_event, request) => runPowerShell({ ...request, operation: 'test' }));
  ipcMain.handle('network:addTrustedHost', (_event, hostname) => addTrustedHost(hostname));
  ipcMain.handle('target:downloadSetup', () => downloadTargetSetup());

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
