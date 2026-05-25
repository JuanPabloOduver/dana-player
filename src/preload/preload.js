'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Context Bridge — preload.js
 *
 * Exposes a clean, minimal API to the renderer.
 * The renderer never touches Node.js or ipcRenderer directly.
 *
 * Playback model (danaplayd / MPD-style):
 *   - The daemon owns audio reproduction entirely.
 *   - The UI sends text commands and polls get_data for state updates.
 *   - No Web Audio API, no PCM handling in the renderer.
 */
contextBridge.exposeInMainWorld('api', {

    // ── Playback commands ──────────────────────────────────────────────────

    /** Start playing a specific .dana file */
    playFile: (filePath) =>
        ipcRenderer.send('cmd-play', { filePath }),

    /** Pause playback */
    pause: () =>
        ipcRenderer.send('cmd-pause'),

    /** Resume playback */
    resume: () =>
        ipcRenderer.send('cmd-resume'),

    /** Stop playback and clear state */
    stop: () =>
        ipcRenderer.send('cmd-stop'),

    /**
     * Set playback volume.
     * @param {number} volume  Integer 0–200 (100 = original level)
     */
    setVolume: (volume) =>
        ipcRenderer.send('cmd-set-vol', { volume }),

    /** Force an immediate state refresh (e.g. right after issuing play) */
    refresh: () =>
        ipcRenderer.send('cmd-refresh'),

    // ── File system ────────────────────────────────────────────────────────

    /** Scan a folder and return an array of .dana track objects */
    scanFolder: (folderPath) =>
        ipcRenderer.invoke('scan-folder', folderPath),

    /** Open the native folder-picker dialog, returns selected path or null */
    openFolderDialog: () =>
        ipcRenderer.invoke('open-folder-dialog'),

    // ── Window controls ────────────────────────────────────────────────────

    minimizeWindow: () => ipcRenderer.send('window-minimize'),
    maximizeWindow: () => ipcRenderer.send('window-maximize'),
    closeWindow:    () => ipcRenderer.send('window-close'),

    // ── Callbacks: Main → Renderer ─────────────────────────────────────────

    /**
     * Fired every polling tick (~1s) with the full DanaTags JSON object.
     *
     * Expected fields:
     *   state    {string}  "PLAYING" | "PAUSED" | "STOPPED"
     *   title    {string}
     *   artist   {string}
     *   album    {string}
     *   time     {number}  elapsed seconds
     *   duration {number}  total seconds
     *   lyrics   {string}  full lyrics, newlines as \n
     *   has_cover {boolean}
     */
    onDanaTags: (callback) =>
        ipcRenderer.on('dana-tags', (_, tags) => callback(tags)),

    /**
     * Fired when cover art is ready.
     * @param {function(string|null): void} callback
     *   Receives a base64 data-URL string, or null to clear the cover.
     */
    onCoverArt: (callback) =>
        ipcRenderer.on('cover-art', (_, dataUrl) => callback(dataUrl)),

    /**
     * Fired when the daemon connection state changes.
     * @param {function({connected: boolean, error?: string}): void} callback
     */
    onDaemonStatus: (callback) =>
        ipcRenderer.on('daemon-status', (_, data) => callback(data)),

    /** Remove all listeners for a given channel (cleanup on unmount) */
    removeAllListeners: (channel) =>
        ipcRenderer.removeAllListeners(channel),
});
