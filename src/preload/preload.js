'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    playFile: (filePath) => ipcRenderer.send('cmd-play', { filePath }),
    pause: () => ipcRenderer.send('cmd-pause'),
    resume: () => ipcRenderer.send('cmd-resume'),
    stop: () => ipcRenderer.send('cmd-stop'),
    setVolume: (volume) => ipcRenderer.send('cmd-set-vol', { volume }),
    refresh: () => ipcRenderer.send('cmd-refresh'),
    setEq: (band, gain) => ipcRenderer.send('cmd-eq', { band, gain }),
    seek: (seconds) => ipcRenderer.send('cmd-seek', { seconds }),
    watchFolder: (folderPath) => ipcRenderer.send('watch-folder', folderPath),
    onFolderChanged: (cb) => ipcRenderer.on('folder-changed', () => cb()),
    scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),
    openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
    minimizeWindow: () => ipcRenderer.send('window-minimize'),
    maximizeWindow: () => ipcRenderer.send('window-maximize'),
    closeWindow: () => ipcRenderer.send('window-close'),
    onDanaTags: (callback) => ipcRenderer.on('dana-tags', (_, tags) => callback(tags)),
    onCoverArt: (callback) => ipcRenderer.on('cover-art', (_, dataUrl) => callback(dataUrl)),
    onDaemonStatus: (callback) => ipcRenderer.on('daemon-status', (_, data) => callback(data)),
    removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});