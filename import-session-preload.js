const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ytmImport', {
  importCookies: (rawJson) => ipcRenderer.invoke('ytm:import-cookies', rawJson),
  closeAndReload: () => ipcRenderer.send('ytm:import-cookies-done'),
});
