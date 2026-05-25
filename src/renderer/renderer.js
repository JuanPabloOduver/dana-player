'use strict';

/**
 * DANA PLAYER v3 — renderer.js
 *
 * Modelo MPD-style:
 *   - El daemon (danaplayd) reproduce el audio por sí mismo.
 *   - Esta UI NO maneja Web Audio API ni PCM.
 *   - La UI envía comandos de texto y consume el JSON de get_data (polling ~1s).
 *
 * Flujo principal:
 *   api.onDanaTags(tags) → actualizar título, artista, progreso, estado
 *   api.onCoverArt(dataUrl) → mostrar carátula (solo cuando cambia el track)
 *   api.onDaemonStatus(status) → indicador de conexión
 */

// ── Estado ────────────────────────────────────────────────────────────────────
let tracks       = [];
let currentIdx   = -1;
let loopEnabled  = false;
let lastState    = 'STOPPED';   // "PLAYING" | "PAUSED" | "STOPPED"
let lastDuration = 0;
let lyricsVisible = false;

// ── DOM ───────────────────────────────────────────────────────────────────────
const elPlaylist    = document.getElementById('playlist');
const elPlEmpty     = document.getElementById('pl-empty');
const elFolderPath  = document.getElementById('folder-path');
const elFolderCnt   = document.getElementById('folder-count');
const elFolderBtn   = document.getElementById('folder-btn');

const elCoverImg         = document.getElementById('cover-img');
const elCoverPlaceholder = document.getElementById('cover-placeholder');
const elNpState   = document.getElementById('np-state');
const elNpTitle   = document.getElementById('np-title');
const elNpArtist  = document.getElementById('np-artist');
const elNpAlbum   = document.getElementById('np-album');

const elVolSlider = document.getElementById('vol-slider');
const elVolValue  = document.getElementById('vol-value');

const elTimeElapsed  = document.getElementById('time-elapsed');
const elTimeTotal    = document.getElementById('time-total');
const elProgressFill = document.getElementById('progress-fill');
const elProgressTrack= document.getElementById('progress-track');

const elTpPlay = document.getElementById('tp-play');
const elTpPrev = document.getElementById('tp-prev');
const elTpNext = document.getElementById('tp-next');
const elTpLoop = document.getElementById('tp-loop');

const elDaemonDot  = document.getElementById('daemon-dot');
const elDaemonText = document.getElementById('daemon-text');

const elSrFmt       = document.getElementById('sr-fmt');
const elLyricsWrap  = document.getElementById('lyrics-wrap');
const elLyricsBody  = document.getElementById('lyrics-body');
const elLyricsClose = document.getElementById('lyrics-close');
const elLyricsBtn   = document.getElementById('sr-lyrics-btn');

const elTbMin   = document.getElementById('tb-min');
const elTbMax   = document.getElementById('tb-max');
const elTbClose = document.getElementById('tb-close');

// ── DanaTags handler (polling result) ────────────────────────────────────────
/**
 * Called every ~1 second with the full state from the daemon.
 * Updates every piece of the UI from a single authoritative source.
 *
 * @param {Object} tags  DanaTags JSON from danaplayd
 */
function handleDanaTags(tags) {
    const state    = (tags.state    || 'STOPPED').toUpperCase();
    const title    = tags.title    || '';
    const artist   = tags.artist   || '';
    const album    = tags.album    || '';
    const elapsed  = Number(tags.time)     || 0;
    const duration = Number(tags.duration) || 0;
    const lyrics   = tags.lyrics   || '';

    // ── State indicator ──────────────────────────────────────────────────
    elNpState.textContent = state;
    lastState    = state;
    lastDuration = duration;

    // ── Track info ───────────────────────────────────────────────────────
    if (title)  elNpTitle.textContent  = title;
    if (artist) elNpArtist.textContent = artist;
    if (album)  elNpAlbum.textContent  = album;

    // ── Format info ──────────────────────────────────────────────────────
    if (tags.sample_rate || tags.sampleRate) {
        const sr  = tags.sample_rate || tags.sampleRate;
        const bd  = tags.bit_depth   || tags.bitDepth || 16;
        const ch  = tags.channels    || 2;
        elSrFmt.textContent = `PCM ${sr / 1000}kHz / ${bd}-bit / ${ch === 1 ? 'Mono' : 'Stereo'}`;
    }

    // ── Progress bar ─────────────────────────────────────────────────────
    updateProgress(elapsed, duration);

    // ── Transport button state ───────────────────────────────────────────
    syncTransportToState(state);

    // ── Playlist highlight ───────────────────────────────────────────────
    // Match active track by title if we don't have an index-level guarantee
    if (title) syncPlaylistToTitle(title);

    // ── Lyrics ───────────────────────────────────────────────────────────
    if (lyrics && lyricsVisible) {
        // Unescape \n sequences the daemon may have escaped
        elLyricsBody.textContent = lyrics.replace(/\\n/g, '\n');
    } else if (!lyrics && lyricsVisible) {
        elLyricsBody.textContent = '— No lyrics available —';
    }
}

// ── Progress ──────────────────────────────────────────────────────────────────
function updateProgress(elapsed, duration) {
    elTimeElapsed.textContent = formatTime(elapsed);
    elTimeTotal.textContent   = formatTime(duration);

    const pct = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;
    elProgressFill.style.width = `${pct.toFixed(2)}%`;
}

function formatTime(seconds) {
    const s = Math.floor(seconds);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ── Transport state sync ──────────────────────────────────────────────────────
function syncTransportToState(state) {
    const icoPlay  = elTpPlay.querySelector('.ico-play');
    const icoPause = elTpPlay.querySelector('.ico-pause');
    const playing  = state === 'PLAYING';
    icoPlay.style.display  = playing ? 'none' : '';
    icoPause.style.display = playing ? '' : 'none';
}

// ── Cover art ─────────────────────────────────────────────────────────────────
function handleCoverArt(dataUrl) {
    if (dataUrl) {
        elCoverImg.src             = dataUrl;
        elCoverImg.style.display   = 'block';
        elCoverPlaceholder.style.display = 'none';
    } else {
        elCoverImg.src             = '';
        elCoverImg.style.display   = 'none';
        elCoverPlaceholder.style.display = '';
    }
}

// ── Playback commands ─────────────────────────────────────────────────────────
function playTrack(idx) {
    if (idx < 0 || idx >= tracks.length) return;
    currentIdx = idx;
    const track = tracks[idx];

    api.playFile(track.path);

    // Optimistic UI update — daemon confirms on next poll
    elNpTitle.textContent  = track.name;
    elNpArtist.textContent = '—';
    elNpAlbum.textContent  = '';
    elNpState.textContent  = 'BUFFERING…';
    updateProgress(0, 0);
    handleCoverArt(null);   // clear old cover until daemon sends new one

    updatePlaylistUI(idx);

    // Immediate poll to pick up state faster than the 1s interval
    setTimeout(() => api.refresh(), 300);
}

function togglePlayPause() {
    if (lastState === 'PLAYING') {
        api.pause();
        // Optimistic
        syncTransportToState('PAUSED');
        elNpState.textContent = 'PAUSED';
    } else if (lastState === 'PAUSED') {
        api.resume();
        syncTransportToState('PLAYING');
        elNpState.textContent = 'PLAYING';
    } else {
        // STOPPED — play current or first track
        const idx = currentIdx >= 0 ? currentIdx : 0;
        if (tracks.length > 0) playTrack(idx);
    }
}

function playNext() {
    if (!tracks.length) return;
    playTrack((currentIdx + 1) % tracks.length);
}

function playPrev() {
    if (!tracks.length) return;
    playTrack((currentIdx - 1 + tracks.length) % tracks.length);
}

// ── Playlist sync ─────────────────────────────────────────────────────────────
function syncPlaylistToTitle(title) {
    // Find the playlist item whose name matches the current title
    const items = document.querySelectorAll('.pl-item');
    let matched = false;
    items.forEach((el, i) => {
        const name = tracks[i]?.name || '';
        const isMatch = name.toLowerCase() === title.toLowerCase();
        el.classList.toggle('active',  isMatch);
        el.classList.toggle('playing', isMatch && lastState === 'PLAYING');
        if (isMatch) { currentIdx = i; matched = true; }
    });
}

function updatePlaylistUI(activeIdx) {
    document.querySelectorAll('.pl-item').forEach((el, i) => {
        el.classList.toggle('active',  i === activeIdx);
        el.classList.toggle('playing', i === activeIdx && lastState === 'PLAYING');
    });
}

// ── Folder loading ────────────────────────────────────────────────────────────
async function openFolder() {
    const folder = await api.openFolderDialog();
    if (!folder) return;
    elFolderPath.textContent = folder;
    tracks = await api.scanFolder(folder);
    elFolderCnt.textContent = `${tracks.length} track${tracks.length !== 1 ? 's' : ''}`;
    renderPlaylist();
}

function renderPlaylist() {
    Array.from(elPlaylist.querySelectorAll('.pl-item')).forEach(el => el.remove());

    if (tracks.length === 0) {
        elPlEmpty.style.display = '';
        return;
    }
    elPlEmpty.style.display = 'none';

    tracks.forEach((t, i) => {
        const li = document.createElement('li');
        li.className = 'pl-item';
        li.dataset.index = i;
        li.style.animationDelay = `${i * 25}ms`;
        li.innerHTML = `
            <span class="pl-num">${String(i + 1).padStart(2, '0')}</span>
            <span class="pl-name" title="${esc(t.name)}">${esc(t.name)}</span>
            <span class="pl-dot"></span>`;
        li.addEventListener('click', () => playTrack(i));
        elPlaylist.appendChild(li);
    });
}

// ── Volume ────────────────────────────────────────────────────────────────────
elVolSlider.addEventListener('input', () => {
    const v = parseInt(elVolSlider.value, 10);
    elVolValue.textContent = v;
    api.setVolume(v);
});

// ── Progress bar click (seek) ─────────────────────────────────────────────────
// danaplayd does not expose a seek command in the current spec,
// so clicking the bar is a visual-only hint for now. If seek is added,
// wire it up here: api.seek(Math.floor(ratio * lastDuration))
elProgressTrack.addEventListener('click', (e) => {
    const rect  = elProgressTrack.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const pct   = Math.max(0, Math.min(100, ratio * 100));
    elProgressFill.style.width = `${pct.toFixed(2)}%`;
    // Optimistic time display
    const seekSec = Math.floor(ratio * lastDuration);
    elTimeElapsed.textContent = formatTime(seekSec);
});

// ── Lyrics panel ──────────────────────────────────────────────────────────────
function toggleLyrics() {
    lyricsVisible = !lyricsVisible;
    elLyricsWrap.style.display = lyricsVisible ? '' : 'none';
    elLyricsBtn.classList.toggle('active', lyricsVisible);
}

elLyricsBtn.addEventListener('click', toggleLyrics);
elLyricsClose.addEventListener('click', toggleLyrics);

// ── Daemon event callbacks ────────────────────────────────────────────────────
api.onDanaTags((tags) => {
    handleDanaTags(tags);
});

api.onCoverArt((dataUrl) => {
    handleCoverArt(dataUrl);
});

api.onDaemonStatus(({ connected }) => {
    elDaemonDot.className    = `daemon-dot ${connected ? 'ok' : 'err'}`;
    elDaemonText.textContent = connected ? 'danaplayd connected' : 'daemon offline';
});

// ── Transport buttons ─────────────────────────────────────────────────────────
elFolderBtn.addEventListener('click', openFolder);
elTpPlay.addEventListener('click', togglePlayPause);
elTpPrev.addEventListener('click', playPrev);
elTpNext.addEventListener('click', playNext);

elTpLoop.addEventListener('click', () => {
    loopEnabled = !loopEnabled;
    elTpLoop.dataset.on = String(loopEnabled);
    elTpLoop.title = loopEnabled ? 'Loop: ON' : 'Loop: OFF';
});

// Window chrome
elTbMin.addEventListener('click',   () => api.minimizeWindow());
elTbMax.addEventListener('click',   () => api.maximizeWindow());
elTbClose.addEventListener('click', () => api.closeWindow());

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    switch (e.code) {
        case 'Space':      e.preventDefault(); togglePlayPause(); break;
        case 'ArrowRight': playNext(); break;
        case 'ArrowLeft':  playPrev();  break;
        case 'KeyL':       elTpLoop.click(); break;
    }
});

// ── Util ──────────────────────────────────────────────────────────────────────
function esc(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────
syncTransportToState('STOPPED');
