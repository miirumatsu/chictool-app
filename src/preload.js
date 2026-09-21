const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pcinfo', {
  authState: () => ipcRenderer.invoke('auth:state'),
  login: (username, password) => ipcRenderer.invoke('auth:login', username, password),
  registerUser: (username, password) => ipcRenderer.invoke('auth:register', username, password),
  logout: () => ipcRenderer.invoke('auth:logout'),
  listInventory: () => ipcRenderer.invoke('inventory:list'),
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  loadSavedPassword: () => ipcRenderer.invoke('credentials:loadPassword'),
  saveRemotePassword: password => ipcRenderer.invoke('credentials:savePassword', password),
  listAuditLogs: () => ipcRenderer.invoke('audit:list'),
  listPeripherals: (computerId, filter) => ipcRenderer.invoke('peripherals:list', computerId, filter),
  savePeripheral: peripheral => ipcRenderer.invoke('peripherals:save', peripheral),
  deletePeripheral: id => ipcRenderer.invoke('peripherals:delete', id),
  listLookups: () => ipcRenderer.invoke('lookup:list'),
  saveInventory: record => ipcRenderer.invoke('inventory:save', record),
  deleteInventory: id => ipcRenderer.invoke('inventory:delete', id),
  backupDatabase: () => ipcRenderer.invoke('database:backup'),
  resetDatabase: () => ipcRenderer.invoke('database:reset'),
  exportInventoryCsv: () => ipcRenderer.invoke('inventory:exportCsv'),
  zoom: direction => ipcRenderer.invoke('view:zoom', direction),
  resetZoom: () => ipcRenderer.invoke('view:zoom', 0),
  collectInventory: request => ipcRenderer.invoke('inventory:collect', request)
  , testConnection: request => ipcRenderer.invoke('inventory:testConnection', request)
  , addTrustedHost: hostname => ipcRenderer.invoke('network:addTrustedHost', hostname),
  downloadTargetSetup: () => ipcRenderer.invoke('target:downloadSetup')
});
