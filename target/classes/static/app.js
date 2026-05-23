/**
 * DANA PLAYER — app.js
 *
 * Architecture:
 *   WebSocket (binary)  →  receiveChunk()  →  AudioScheduler  →  AudioContext
 *
 * Gapless playback via Web Audio API:
 *   Each incoming PCM chunk is decoded into an AudioBuffer and scheduled
 *   at `nextPlayTime`. nextPlayTime advances by the chunk's duration so
 *   chunks play back-to-back with zero silence between them.
 *
 * PCM format expected from backend: 16-bit signed, Little-Endian, 44100 Hz, 2ch stereo.
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const WS_URL        = `ws://${location.host}/audio-stream`;
const SAMPLE_RATE   = 44100;
const NUM_CHANNELS  = 2;
const BIT_DEPTH     = 16;
const BYTES_PER_SAMPLE = BIT_DEPTH / 8;           // 2
const BYTES_PER_FRAME  = BYTES_PER_SAMPLE * NUM_CHANNELS; // 4

/** How many seconds ahead to schedule audio. Keeps playback smooth even if
 *  JS is briefly blocked. Too large = latency; too small = glitches. */
const SCHEDULE_AHEAD_SEC = 0.08;

/** If the audio clock falls behind by this much, reset scheduling (prevents
 *  an ever-growing backlog after pause/resume). */
const MAX_LAG_SEC = 0.5;

// ─── State ────────────────────────────────────────────────────────────────────
let audioCtx     = null;   // Web Audio context (created on first play — browser policy)
let nextPlayTime = 0;      // when the next chunk should start playing
let isPlaying    = false;
let isPaused     = false;

let ws           = null;   // WebSocket instance
let wsReady      = false;

/** All tracks returned by /api/tracks */
let tracks       = [];
let currentIndex = -1;
let loopEnabled  = false;

/** Queued ArrayBuffers received while paused (so we don't lose data) */
const pauseQueue = [];

/** Approximate buffer fill (0–1) for the UI indicator */
let bufferFill = 0;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const elPlaylist      = document.getElementById('playlist');
const elTrackName     = document.getElementById('track-name');
const elTrackStatus   = document.getElementById('track-status');
const elTrackMeta     = document.getElementById('track-meta');
const elFolderPath    = document.getElementById('folder-path');
const elTrackCount    = document.getElementById('track-count');
const elBtnPlay       = document.getElementById('btn-play');
const elBtnPrev       = document.getElementById('btn-prev');
const elBtnNext       = document.getElementById('btn-next');
const elBtnLoop       = document.getElementById('btn-loop');
const elStatusDot     = document.getElementById('status-dot');
const elStatusText    = document.getElementById('status-text');
const elBufferBar     = document.getElementById('buffer-bar');
const elVisualizerLbl = document.getElementById('visualizer-label');
const elCanvas        = document.getElementById('visualizer');

// ─── Visualizer ───────────────────────────────────────────────────────────────
const ctx2d = elCanvas.getContext('2d');
let   analyser      = null;
let   analyserData  = null;
let   animFrameId   = null;

function initAnalyser() {
    if (!audioCtx) return;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.8;
    analyser.connect(audioCtx.destination);
    analyserData = new Uint8Array(analyser.frequencyBinCount);
}

function resizeCanvas() {
    elCanvas.width  = elCanvas.offsetWidth  * devicePixelRatio;
    elCanvas.height = elCanvas.offsetHeight * devicePixelRatio;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function drawVisualizer() {
    animFrameId = requestAnimationFrame(drawVisualizer);

    const W = elCanvas.width;
    const H = elCanvas.height;

    ctx2d.clearRect(0, 0, W, H);

    if (!analyser || !isPlaying || isPaused) {
        // Idle: faint grid lines
        ctx2d.strokeStyle = 'rgba(240,165,0,0.04)';
        ctx2d.lineWidth   = 1;
        const step = W / 16;
        for (let x = 0; x <= W; x += step) {
            ctx2d.beginPath();
            ctx2d.moveTo(x, 0);
            ctx2d.lineTo(x, H);
            ctx2d.stroke();
        }
        const vstep = H / 8;
        for (let y = 0; y <= H; y += vstep) {
            ctx2d.beginPath();
            ctx2d.moveTo(0, y);
            ctx2d.lineTo(W, y);
            ctx2d.stroke();
        }
        return;
    }

    analyser.getByteFrequencyData(analyserData);

    const barCount  = analyserData.length;         // 128
    const barW      = W / barCount;
    const accentRGB = '240,165,0';

    for (let i = 0; i < barCount; i++) {
        const value  = analyserData[i] / 255;
        const barH   = value * H * 0.85;
        const x      = i * barW;
        const y      = H - barH;
        const alpha  = 0.15 + value * 0.85;

        // Gradient per bar
        const grad = ctx2d.createLinearGradient(x, H, x, y);
        grad.addColorStop(0, `rgba(${accentRGB},${alpha})`);
        grad.addColorStop(1, `rgba(${accentRGB},${alpha * 0.2})`);

        ctx2d.fillStyle = grad;
        ctx2d.fillRect(x + 1, y, Math.max(barW - 2, 1), barH);
    }
}

drawVisualizer();

// ─── AudioContext helpers ──────────────────────────────────────────────────────
function ensureAudioContext() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    initAnalyser();
}

/**
 * Decodes a raw PCM ArrayBuffer (16-bit LE stereo) into a Web Audio AudioBuffer.
 * We skip decodeAudioData() because the backend sends raw PCM, not a file container.
 */
function pcmToAudioBuffer(arrayBuffer) {
    const samples      = arrayBuffer.byteLength / BYTES_PER_SAMPLE;
    const frames       = samples / NUM_CHANNELS;
    const audioBuffer  = audioCtx.createBuffer(NUM_CHANNELS, frames, SAMPLE_RATE);

    const dataView     = new DataView(arrayBuffer);
    const leftChannel  = audioBuffer.getChannelData(0);
    const rightChannel = audioBuffer.getChannelData(1);

    for (let i = 0; i < frames; i++) {
        const byteOffset       = i * BYTES_PER_FRAME;
        // 16-bit signed little-endian → float32 [-1, 1]
        leftChannel[i]  = dataView.getInt16(byteOffset,     true) / 32768.0;
        rightChannel[i] = dataView.getInt16(byteOffset + 2, true) / 32768.0;
    }

    return audioBuffer;
}

/**
 * Schedules an AudioBuffer for gapless playback.
 * nextPlayTime is advanced by the buffer's duration so the next
 * chunk plays exactly where this one ends — no silence, no overlap.
 */
function scheduleAudioBuffer(audioBuffer) {
    const now = audioCtx.currentTime;

    // If we've fallen behind (e.g. after a long pause), re-sync
    if (nextPlayTime < now - MAX_LAG_SEC) {
        nextPlayTime = now + SCHEDULE_AHEAD_SEC;
    }

    // Also ensure we're never scheduling in the past
    if (nextPlayTime < now) {
        nextPlayTime = now + SCHEDULE_AHEAD_SEC;
    }

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;

    if (analyser) {
        source.connect(analyser);
    } else {
        source.connect(audioCtx.destination);
    }

    source.start(nextPlayTime);
    nextPlayTime += audioBuffer.duration;
}

// ─── Incoming PCM chunk handler ────────────────────────────────────────────────
function receiveChunk(arrayBuffer) {
    if (!isPlaying) return;

    if (isPaused) {
        pauseQueue.push(arrayBuffer);
        // Update buffer UI
        bufferFill = Math.min(1, bufferFill + 0.05);
        updateBufferBar(bufferFill);
        return;
    }

    processChunk(arrayBuffer);
}

function processChunk(arrayBuffer) {
    if (!audioCtx || arrayBuffer.byteLength === 0) return;

    try {
        const audioBuffer = pcmToAudioBuffer(arrayBuffer);
        scheduleAudioBuffer(audioBuffer);

        // Visual feedback: buffer fill approximation
        const scheduledAhead = nextPlayTime - audioCtx.currentTime;
        bufferFill = Math.min(1, scheduledAhead / 2.0); // 2s = full bar
        updateBufferBar(bufferFill);
    } catch (err) {
        console.error('[Audio] Error processing chunk:', err);
    }
}

function flushPauseQueue() {
    while (pauseQueue.length > 0) {
        processChunk(pauseQueue.shift());
    }
    bufferFill = 0;
    updateBufferBar(0);
}

// ─── WebSocket ─────────────────────────────────────────────────────────────────
function connectWebSocket() {
    setStatus('connecting', 'Connecting…');

    ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        wsReady = true;
        setStatus('connected', 'Connected');
        console.log('[WS] Connected');
    };

    ws.onclose = () => {
        wsReady = false;
        setStatus('disconnected', 'Disconnected — retrying…');
        console.log('[WS] Closed, reconnecting in 2s…');
        setTimeout(connectWebSocket, 2000);
    };

    ws.onerror = (err) => {
        console.error('[WS] Error:', err);
    };

    ws.onmessage = (event) => {
        // Binary = PCM audio chunk
        if (event.data instanceof ArrayBuffer) {
            receiveChunk(event.data);
            return;
        }

        // Text = control message
        const msg = event.data;
        console.log('[WS] Control:', msg);

        if (msg.startsWith('PLAYING:')) {
            const trackId = msg.slice(8);
            onTrackStarted(trackId);

        } else if (msg.startsWith('TRACK_END:')) {
            onTrackEnded();

        } else if (msg.startsWith('ERROR:')) {
            console.error('[WS] Server error:', msg.slice(6));
            setTrackStatus('ERROR');
        }
    };
}

function wsSend(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(message);
    } else {
        console.warn('[WS] Cannot send — not connected');
    }
}

// ─── Playback control ──────────────────────────────────────────────────────────
function playTrack(index) {
    if (index < 0 || index >= tracks.length) return;

    ensureAudioContext();

    // Resume AudioContext if it was suspended (autoplay policy)
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    // Reset scheduling
    nextPlayTime = audioCtx.currentTime + SCHEDULE_AHEAD_SEC;
    pauseQueue.length = 0;
    bufferFill = 0;
    updateBufferBar(0);

    currentIndex = index;
    isPlaying    = true;
    isPaused     = false;

    updatePlaylistUI();
    updateTransportUI();

    const track = tracks[index];
    elTrackName.textContent = track.name;
    elTrackStatus.textContent = 'BUFFERING…';
    elTrackMeta.textContent = `PCM · 44.1kHz · 16-bit · Stereo`;
    elVisualizerLbl.textContent = 'PLAYING';
    elVisualizerLbl.classList.add('active');

    wsSend(`PLAY:${track.id}`);
}

function stopPlayback() {
    wsSend('STOP');
    isPlaying  = false;
    isPaused   = false;
    pauseQueue.length = 0;
    bufferFill = 0;
    updateBufferBar(0);
    updateTransportUI();
    elTrackStatus.textContent = '—';
    elVisualizerLbl.textContent = 'IDLE';
    elVisualizerLbl.classList.remove('active');
}

function togglePause() {
    if (!isPlaying) return;

    if (!isPaused) {
        // Pause: suspend AudioContext so scheduled audio stops
        audioCtx.suspend();
        isPaused = true;
        elTrackStatus.textContent = 'PAUSED';
        elVisualizerLbl.textContent = 'PAUSED';
        elVisualizerLbl.classList.remove('active');
    } else {
        // Resume: flush buffered chunks, then resume context
        audioCtx.resume();
        isPaused = false;
        // Reset nextPlayTime so buffered chunks play from now
        nextPlayTime = audioCtx.currentTime + SCHEDULE_AHEAD_SEC;
        flushPauseQueue();
        elTrackStatus.textContent = 'PLAYING';
        elVisualizerLbl.textContent = 'PLAYING';
        elVisualizerLbl.classList.add('active');
    }

    updateTransportUI();
}

function playNext() {
    if (tracks.length === 0) return;
    const next = (currentIndex + 1) % tracks.length;
    playTrack(next);
}

function playPrev() {
    if (tracks.length === 0) return;
    // If more than 3s in, restart current track; otherwise go back
    const prev = (currentIndex - 1 + tracks.length) % tracks.length;
    playTrack(prev);
}

// ─── Server event callbacks ────────────────────────────────────────────────────
function onTrackStarted(trackId) {
    elTrackStatus.textContent = 'PLAYING';
}

function onTrackEnded() {
    elTrackStatus.textContent = 'ENDED';
    elVisualizerLbl.textContent = 'IDLE';
    elVisualizerLbl.classList.remove('active');

    if (loopEnabled) {
        playTrack(currentIndex);
    } else if (currentIndex < tracks.length - 1) {
        playTrack(currentIndex + 1);
    } else {
        // End of playlist
        isPlaying = false;
        updateTransportUI();
        updatePlaylistUI();
        elTrackStatus.textContent = '—';
        elTrackName.textContent   = 'No track selected';
        elTrackMeta.textContent   = 'Select a track from the library';
        currentIndex = -1;
    }
}

// ─── Library loading ───────────────────────────────────────────────────────────
async function loadLibrary() {
    try {
        const [tracksRes, infoRes] = await Promise.all([
            fetch('/api/tracks'),
            fetch('/api/info'),
        ]);

        tracks = await tracksRes.json();
        const info = await infoRes.json();

        elFolderPath.textContent = info.folder || '—';
        elTrackCount.textContent = tracks.length;

        renderPlaylist();
    } catch (err) {
        console.error('[Library] Failed to load:', err);
        elFolderPath.textContent = 'Error loading library';
    }
}

function renderPlaylist() {
    elPlaylist.innerHTML = '';

    if (tracks.length === 0) {
        elPlaylist.innerHTML = `
            <li class="playlist-empty">
                <span class="empty-icon">⬡</span>
                <span>No .dana files found</span>
                <span class="empty-hint">Add files to the music folder and refresh</span>
            </li>`;
        return;
    }

    tracks.forEach((track, i) => {
        const li = document.createElement('li');
        li.className    = 'playlist-item';
        li.dataset.index = i;
        li.style.animationDelay = `${i * 30}ms`;
        li.innerHTML = `
            <span class="item-index">${String(i + 1).padStart(2, '0')}</span>
            <span class="item-name" title="${escapeHtml(track.name)}">${escapeHtml(track.name)}</span>
            <span class="item-playing-indicator"></span>`;
        li.addEventListener('click', () => {
            if (currentIndex === i && isPlaying) {
                togglePause();
            } else {
                playTrack(i);
            }
        });
        elPlaylist.appendChild(li);
    });
}

function updatePlaylistUI() {
    document.querySelectorAll('.playlist-item').forEach((el, i) => {
        el.classList.toggle('active',   i === currentIndex);
        el.classList.toggle('playing',  i === currentIndex && isPlaying && !isPaused);
    });
}

// ─── Transport UI ──────────────────────────────────────────────────────────────
function updateTransportUI() {
    const iconPlay  = elBtnPlay.querySelector('.icon-play');
    const iconPause = elBtnPlay.querySelector('.icon-pause');

    if (isPlaying && !isPaused) {
        iconPlay.style.display  = 'none';
        iconPause.style.display = '';
    } else {
        iconPlay.style.display  = '';
        iconPause.style.display = 'none';
    }
}

function updateBufferBar(fill) {
    elBufferBar.style.width = `${Math.round(fill * 100)}%`;
}

// ─── Connection status ─────────────────────────────────────────────────────────
function setStatus(state, text) {
    elStatusDot.className  = `status-dot ${state}`;
    elStatusText.textContent = text;
}

function setTrackStatus(text) {
    elTrackStatus.textContent = text;
}

// ─── Button listeners ──────────────────────────────────────────────────────────
elBtnPlay.addEventListener('click', () => {
    if (!isPlaying && currentIndex >= 0) {
        playTrack(currentIndex);
    } else if (!isPlaying && tracks.length > 0) {
        playTrack(0);
    } else {
        togglePause();
    }
});

elBtnPrev.addEventListener('click', playPrev);
elBtnNext.addEventListener('click', playNext);

elBtnLoop.addEventListener('click', () => {
    loopEnabled = !loopEnabled;
    elBtnLoop.dataset.active = String(loopEnabled);
    elBtnLoop.title = loopEnabled ? 'Loop: ON' : 'Loop: OFF';
});

// ─── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
    // Don't fire if focus is on an input
    if (e.target.tagName === 'INPUT') return;

    switch (e.code) {
        case 'Space':
            e.preventDefault();
            elBtnPlay.click();
            break;
        case 'ArrowRight':
            playNext();
            break;
        case 'ArrowLeft':
            playPrev();
            break;
        case 'KeyL':
            elBtnLoop.click();
            break;
    }
});

// ─── Utilities ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ─── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
    connectWebSocket();
    await loadLibrary();
    updateTransportUI();
})();
