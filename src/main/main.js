'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const net  = require('net');

// ─── Config ───────────────────────────────────────────────────────────────────
const SOCK_PATH        = process.env.DANA_SOCK || '/tmp/danaplayd.sock';
const POLL_INTERVAL_MS = 1000;   // get_data polling frequency
const CMD_TIMEOUT_MS   = 3000;   // max wait for a daemon response

// ─── Window ───────────────────────────────────────────────────────────────────
let mainWindow   = null;
let pollTimer    = null;
let lastFilePath = null;   // tracks when the file changed (for cover art)
let folderWatcher = null;  // fs.watch handle for the music folder

function createWindow() {
    mainWindow = new BrowserWindow({
        width:  1100,
        height: 720,
        minWidth: 800,
        minHeight: 560,
        frame: false,
        titleBarStyle: 'hidden',
        backgroundColor: '#0c0c0f',
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
    mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.on('cmd-eq', (_, { band, gain }) => {
    sendCommand(`set_eq ${band} ${gain}`);
});

ipcMain.on('cmd-seek', (_, { seconds }) => {
    sendCommand(`seek ${seconds}`);
});
app.whenReady().then(() => {
    createWindow();
    sendCommand('stop');
    startPolling();
});

app.on('window-all-closed', () => {
    stopPolling();
    if (folderWatcher) { folderWatcher.close(); folderWatcher = null; }
    app.quit();
});

// ─── Core: request-response over Unix socket ──────────────────────────────────
/**
 * Opens a fresh connection to danaplayd, sends `command\n`,
 * collects the full response until the socket closes, then resolves.
 *
 * @param {string} command  e.g. 'play /abs/path/song.dana'
 * @param {boolean} binary  if true, resolves with a Buffer instead of a string
 * @returns {Promise<string|Buffer>}
 */
function daemonRequest(command, binary = false) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let settled  = false;

        const sock = net.createConnection({ path: SOCK_PATH });
        sock.setTimeout(CMD_TIMEOUT_MS);

        sock.on('connect', () => { sock.write(command + '\n'); });
        sock.on('data',    (chunk) => { chunks.push(chunk); });

        sock.on('end', () => {
            if (settled) return;
            settled = true;
            const raw = Buffer.concat(chunks);
            resolve(binary ? raw : raw.toString('utf8').trimEnd());
        });

        sock.on('timeout', () => {
            if (settled) return;
            settled = true;
            sock.destroy();
            reject(new Error(`Timeout waiting for daemon response to: ${command}`));
        });

        sock.on('error', (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        });
    });
}

/**
 * Sends a command and logs the reply. Returns null on failure.
 */
async function sendCommand(command) {
    try {
        const reply = await daemonRequest(command);
        console.log(`[CMD] ${command}  →  ${reply}`);
        return reply;
    } catch (err) {
        console.error(`[CMD] ${command} failed:`, err.message);
        sendToWindow('daemon-status', { connected: false, error: err.message });
        return null;
    }
}

// ─── Polling: get_data every second ──────────────────────────────────────────
function startPolling() {
    stopPolling();
    pollTimer = setInterval(pollDaemon, POLL_INTERVAL_MS);
}

function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollDaemon() {
    let raw;
    try {
        raw = await daemonRequest('get_data');
    } catch (_) {
        sendToWindow('daemon-status', { connected: false });
        return;
    }

    sendToWindow('daemon-status', { connected: true });

    let tags;
    try {
        tags = JSON.parse(raw);
    } catch (_) {
        return; // get_data not yet ready — ignore this tick
    }

    sendToWindow('dana-tags', tags);

    // Cover art: only fetch when the file has changed and cover exists
    const currentPath = tags.file || tags.path || null;
    if (tags.has_cover && currentPath && currentPath !== lastFilePath) {
        lastFilePath = currentPath;
        fetchCoverArt();
    }

    // Clear cover when track changes and has no cover
    if (!tags.has_cover && currentPath !== lastFilePath) {
        lastFilePath = currentPath;
        sendToWindow('cover-art', null);
    }
}

// ─── Cover art ────────────────────────────────────────────────────────────────
async function fetchCoverArt() {
    let imgBuffer;
    try {
        imgBuffer = await daemonRequest('get_cover', true /* binary */);
    } catch (err) {
        console.error('[Cover] fetch failed:', err.message);
        return;
    }

    if (!imgBuffer || imgBuffer.length === 0) return;

    const b64     = imgBuffer.toString('base64');
    const mime    = detectImageMime(imgBuffer);
    const dataUrl = `data:${mime};base64,${b64}`;
    sendToWindow('cover-art', dataUrl);
}

function detectImageMime(buf) {
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
    return 'image/jpeg';
}

// ─── IPC: Renderer → Main ────────────────────────────────────────────────────

// Playback commands
ipcMain.on('cmd-play', (_, { filePath }) => {
    sendCommand(`play ${filePath}`);
});

ipcMain.on('cmd-pause', () => {
    sendCommand('pause');
});

ipcMain.on('cmd-resume', () => {
    sendCommand('pause'); // toggle — daemon handles pause/resume state
});

ipcMain.on('cmd-stop', () => {
    sendCommand('stop');
    lastFilePath = null;
    sendToWindow('cover-art', null);
});

ipcMain.on('cmd-set-vol', (_, { volume }) => {
    const v = Math.max(0, Math.min(200, Math.round(volume)));
    sendCommand(`set_vol ${v}`);
});

ipcMain.on('cmd-refresh', () => {
    pollDaemon();
});

// File system
ipcMain.handle('scan-folder', async (_, folderPath) => {
    return scanDanaFiles(folderPath);
});

ipcMain.handle('open-folder-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select .dana Music Folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

// Watch folder for new/removed .dana files
ipcMain.on('watch-folder', (event, folderPath) => {
    if (folderWatcher) { folderWatcher.close(); folderWatcher = null; }

    let debounce = null;
    try {
        folderWatcher = fs.watch(folderPath, { persistent: false }, () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                event.sender.send('folder-changed');
            }, 300);
        });
    } catch (err) {
        console.error('[FS] watch-folder failed:', err.message);
    }
});

// Window controls
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());

// ─── File system scanner ──────────────────────────────────────────────────────
function scanDanaFiles(folderPath) {
    try {
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });
        return entries
            .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.dana'))
            .map((e, i) => ({
                id:       Buffer.from(e.name).toString('base64url'),
                name:     e.name.replace(/\.dana$/i, ''),
                filename: e.name,
                path:     path.join(folderPath, e.name),
                index:    i,
            }));
    } catch (err) {
        console.error('[FS] Scan error:', err.message);
        return [];
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sendToWindow(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}