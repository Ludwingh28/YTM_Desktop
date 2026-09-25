const { contextBridge, ipcRenderer } = require('electron');

// Lets a script running in the page's main world (see injectAdSkipping in
// main.js) tell the main process when playback starts/stops, so the Windows
// taskbar thumbnail buttons can swap between the play and pause icon.
contextBridge.exposeInMainWorld('ytmDesktop', {
  notifyPlaybackState: (isPlaying) => ipcRenderer.send('playback-state-changed', isPlaying),
});
