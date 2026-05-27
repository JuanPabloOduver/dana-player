'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

const SOCK_PATH = process.env.DANA_SOCK || '/tmp/danaplayd.sock';
const POLL_INTERVAL_MS = 1000;
const CMD_TIMEOUT_MS = 3000;
const PLAYLIST_EXTENSIONS = new Set(['.dana', '.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac']);

let mainWindow = null;
let pollTimer = null;
let lastFilePath = null;
let lastHasCover = false;
let folderWatcher = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
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
    if (folderWatcher) {
        folderWatcher.close();
        folderWatcher = null;
    }
    app.quit();
});

function daemonRequest(command, binary = false) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let settled = false;
        const sock = net.createConnection({ path: SOCK_PATH });
        sock.setTimeout(CMD_TIMEOUT_MS);
        sock.on('connect', () => {
            sock.write(command + '\n');
        });
        sock.on('data', (chunk) => {
            chunks.push(chunk);
        });
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
            reject(new Error(`Timeout: ${command}`));
        });
        sock.on('error', (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        });
    });
}

async function sendCommand(command) {
    try {
        return await daemonRequest(command);
    } catch (err) {
        sendToWindow('daemon-status', { connected: false, error: err.message });
        return null;
    }
}

function startPolling() {
    stopPolling();
    pollTimer = setInterval(pollDaemon, POLL_INTERVAL_MS);
}

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
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
        return;
    }
    sendToWindow('dana-tags', tags);
    const currentPath = tags.file || tags.path || null;
    const fileChanged = currentPath !== lastFilePath;
    const hasCover = tags.has_cover === true || tags.has_cover === 'true';
    if (fileChanged) {
        lastFilePath = currentPath;
        lastHasCover = false;
        if (!currentPath) {
            sendToWindow('cover-art', null);
        }
    }
    if (currentPath && hasCover && !lastHasCover) {
        lastHasCover = true;
        setTimeout(() => fetchCoverArt(), 100);
    } else if (fileChanged && !hasCover) {
        lastHasCover = false;
        sendToWindow('cover-art', null);
    }
}

async function fetchCoverArt() {
    let imgBuffer;
    try {
        imgBuffer = await daemonRequest('get_cover', true);
    } catch (_) {
        return;
    }
    if (!imgBuffer || imgBuffer.length === 0) return;
    const b64 = imgBuffer.toString('base64');
    const mime = detectImageMime(imgBuffer);
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

ipcMain.on('cmd-play', (_, { filePath }) => {
    sendCommand(`play ${filePath}`);
});

ipcMain.on('cmd-pause', () => {
    sendCommand('pause');
});

ipcMain.on('cmd-resume', () => {
    sendCommand('pause');
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

ipcMain.handle('scan-folder', async (_, folderPath) => {
    return scanAudioFiles(folderPath);
});

ipcMain.handle('open-folder-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select Music Folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

ipcMain.on('watch-folder', (event, folderPath) => {
    if (folderWatcher) {
        folderWatcher.close();
        folderWatcher = null;
    }
    let debounce = null;
    try {
        folderWatcher = fs.watch(folderPath, { persistent: false }, () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => {
                event.sender.send('folder-changed');
            }, 300);
        });
    } catch (_) { }
});

ipcMain.on('window-minimize', () => {
    mainWindow?.minimize();
});

ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow?.maximize();
    }
});

ipcMain.on('window-close', () => {
    mainWindow?.close();
});

function scanAudioFiles(folderPath) {
    try {
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });
        return entries
            .filter(e => e.isFile() && PLAYLIST_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
            .map((e, i) => ({
                id: Buffer.from(e.name).toString('base64url'),
                name: path.basename(e.name, path.extname(e.name)),
                filename: e.name,
                path: path.join(folderPath, e.name),
                index: i,
            }));
    } catch (_) {
        return [];
    }
}

function sendToWindow(channel, data) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}