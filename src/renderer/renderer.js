'use strict';

/**
 * DANA PLAYER v3 — renderer.js
 */

// ── Estado ────────────────────────────────────────────────────────────────────
let tracks        = [];
let currentIdx    = -1;
let loopEnabled   = false;
let lastState     = 'STOPPED';
let lastDuration  = 0;
let lyricsVisible = false;
let playlists     = {};      // { "name": [trackIdx, ...] }
let activePl      = null;

let lastFilePath  = null;
let lastTitle     = null;

let parsedLrc     = [];
let lastLrcRaw    = null;

// ── DOM ───────────────────────────────────────────────────────────────────────
const elPlaylist    = document.getElementById('playlist');
const elPlEmpty     = document.getElementById('pl-empty');
const elFolderPath  = document.getElementById('folder-path');
const elFolderCnt   = document.getElementById('folder-count');
const elFolderBtn   = document.getElementById('folder-btn');

const elCoverImg         = document.getElementById('cover-img');
const elCoverPlaceholder = document.getElementById('cover-placeholder');
const elVinylContainer   = document.getElementById('vinyl-container');
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

const elEqBtn         = document.getElementById('eq-btn');
const elPlSectionLabel = document.getElementById('pl-section-label');
const elPlActiveBadge  = document.getElementById('pl-active-badge');
const elEqPanel = document.getElementById('eq-panel');
const eqBands   = ['eq-60', 'eq-250', 'eq-1k', 'eq-4k', 'eq-16k'];

// ── LRC Parser ────────────────────────────────────────────────────────────────
function parseLrc(raw) {
    if (!raw) return [];
    const LRC_LINE = /^\[(\d{1,3}):(\d{2})(?:[.:,](\d{1,3}))?\]\s*(.*)/;
    const result   = [];
    for (const line of raw.split('\n')) {
        const m = line.match(LRC_LINE);
        if (!m) continue;
        const mins  = parseInt(m[1], 10);
        const secs  = parseInt(m[2], 10);
        const frac  = m[3] ? parseFloat('0.' + m[3]) : 0;
        const time  = mins * 60 + secs + frac;
        const text  = m[4].trim();
        result.push({ time, text });
    }
    return result.sort((a, b) => a.time - b.time);
}

function isLrc(raw) {
    return /\[\d{1,3}:\d{2}/.test(raw);
}

// ── Render de letras ──────────────────────────────────────────────────────────
function renderLyricsDOM(lrcLines, plainText) {
    elLyricsBody.innerHTML = '';
    if (lrcLines && lrcLines.length > 0) {
        lrcLines.forEach(({ time, text }) => {
            if (!text) return;
            const div = document.createElement('div');
            div.className    = 'lyric-line';
            div.dataset.time = time;
            div.textContent  = text;
            elLyricsBody.appendChild(div);
        });
    } else if (plainText) {
        const lines = plainText.replace(/\\n/g, '\n').split('\n');
        lines.forEach(line => {
            const div = document.createElement('div');
            div.className   = 'lyric-line';
            div.textContent = line || '\u00A0';
            elLyricsBody.appendChild(div);
        });
    } else {
        const div = document.createElement('div');
        div.className   = 'lyric-line';
        div.textContent = '— No lyrics available —';
        elLyricsBody.appendChild(div);
    }
}

function syncLyricsHighlight(elapsed) {
    if (!parsedLrc.length) return;
    const lines = elLyricsBody.querySelectorAll('.lyric-line[data-time]');
    if (!lines.length) return;
    let activeIdx = -1;
    parsedLrc.forEach(({ time }, i) => {
        if (elapsed >= time) activeIdx = i;
    });
    lines.forEach((el, i) => {
        const isActive = i === activeIdx;
        el.classList.toggle('active-lyric', isActive);
        if (isActive) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
}

// ── Animación de transición de canción ────────────────────────────────────────
let trackTransitionTimeout = null;

function triggerTrackTransition(newTitle, newArtist, newAlbum) {
    if (trackTransitionTimeout) {
        clearTimeout(trackTransitionTimeout);
        trackTransitionTimeout = null;
        elNpTitle.classList.remove('track-exit');
        elNpArtist.classList.remove('track-exit');
        elCoverImg.classList.remove('track-exit');
        elCoverPlaceholder.classList.remove('track-exit');
    }
    elNpTitle.classList.add('track-exit');
    elNpArtist.classList.add('track-exit');
    elCoverImg.classList.add('track-exit');
    elCoverPlaceholder.classList.add('track-exit');

    trackTransitionTimeout = setTimeout(() => {
        if (newTitle)  elNpTitle.textContent  = newTitle;
        if (newArtist) elNpArtist.textContent = newArtist;
        if (newAlbum)  elNpAlbum.textContent  = newAlbum;

        elNpTitle.classList.remove('track-exit');
        elNpArtist.classList.remove('track-exit');
        elCoverImg.classList.remove('track-exit');
        elCoverPlaceholder.classList.remove('track-exit');

        elNpTitle.classList.add('track-enter');
        elNpArtist.classList.add('track-enter');
        elCoverImg.classList.add('track-enter');
        elCoverPlaceholder.classList.add('track-enter');

        setTimeout(() => {
            elNpTitle.classList.remove('track-enter');
            elNpArtist.classList.remove('track-enter');
            elCoverImg.classList.remove('track-enter');
            elCoverPlaceholder.classList.remove('track-enter');
            trackTransitionTimeout = null;
        }, 350);
    }, 220);
}

// ── Vinilo ────────────────────────────────────────────────────────────────────
function syncVinylToState(state) {
    if (state === 'PLAYING') {
        elVinylContainer.classList.add('is-playing');
    } else {
        elVinylContainer.classList.remove('is-playing');
    }
}

// ── DanaTags handler ──────────────────────────────────────────────────────────
function handleDanaTags(tags) {
    const state    = (tags.state    || 'STOPPED').toUpperCase();
    const title    = tags.title    || '';
    const artist   = tags.artist   || '';
    const album    = tags.album    || '';
    const elapsed  = Number(tags.time)     || 0;
    const duration = Number(tags.duration) || 0;
    const lyrics   = tags.lyrics   || '';
    const filePath = tags.file     || tags.path || null;

    const trackChanged = filePath && filePath !== lastFilePath;
    if (trackChanged) {
        lastFilePath = filePath;
        triggerTrackTransition(title || null, artist || null, album || null);
        parsedLrc  = [];
        lastLrcRaw = null;
        elLyricsBody.innerHTML = '';
    } else {
        if (title && title !== lastTitle) elNpTitle.textContent  = title;
        if (artist) elNpArtist.textContent = artist;
        if (album)  elNpAlbum.textContent  = album;
    }

    lastTitle    = title;
    lastState    = state;
    lastDuration = duration;

    elNpState.textContent = state;
    syncVinylToState(state);

    if (tags.sample_rate || tags.sampleRate) {
        const sr  = tags.sample_rate || tags.sampleRate;
        const bd  = tags.bit_depth   || tags.bitDepth || 16;
        const ch  = tags.channels    || 2;
        elSrFmt.textContent = `PCM ${sr / 1000}kHz / ${bd}-bit / ${ch === 1 ? 'Mono' : 'Stereo'}`;
    }

    updateProgress(elapsed, duration);
    syncTransportToState(state);
    if (title) syncPlaylistToTitle(title);

    if (lyrics && lyrics !== lastLrcRaw) {
        lastLrcRaw = lyrics;
        if (isLrc(lyrics)) {
            parsedLrc = parseLrc(lyrics);
            renderLyricsDOM(parsedLrc, null);
        } else {
            parsedLrc = [];
            renderLyricsDOM(null, lyrics);
        }
    } else if (!lyrics && lastLrcRaw) {
        lastLrcRaw = null;
        parsedLrc  = [];
        renderLyricsDOM(null, null);
    }

    if (parsedLrc.length > 0) syncLyricsHighlight(elapsed);
}

// ── Playlists ─────────────────────────────────────────────────────────────────
function savePlaylists() {
    try { localStorage.setItem('dana-playlists', JSON.stringify(playlists)); } catch (_) {}
}

function loadPlaylists() {
    try {
        playlists = JSON.parse(localStorage.getItem('dana-playlists')) || {};
    } catch { playlists = {}; }
    renderPlSelect();
}

/**
 * Rebuilds the <select> with all saved playlists.
 */
function renderPlSelect() {
    const sel = document.getElementById('pl-select');
    // Save current value
    const prev = sel.value;
    // Remove all options except the first ("— All Tracks —")
    while (sel.options.length > 1) sel.remove(1);
    Object.keys(playlists).forEach(name => {
        const opt = document.createElement('option');
        opt.value       = name;
        opt.textContent = name;
        sel.appendChild(opt);
    });
    // Restore selection if still valid
    if (prev && playlists[prev]) sel.value = prev;
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
        elCoverImg.src                   = dataUrl;
        elCoverImg.style.display         = 'block';
        elCoverPlaceholder.style.display = 'none';
    } else {
        elCoverImg.src                   = '';
        elCoverImg.style.display         = 'none';
        elCoverPlaceholder.style.display = '';
    }
}

// ── Playback commands ─────────────────────────────────────────────────────────
function playTrack(idx) {
    if (idx < 0 || idx >= tracks.length) return;
    currentIdx = idx;
    const track = tracks[idx];

    api.playFile(track.path);

    elNpTitle.textContent  = track.name;
    elNpArtist.textContent = '—';
    elNpAlbum.textContent  = '';
    elNpState.textContent  = 'BUFFERING…';
    syncTransportToState('PLAYING');
    syncVinylToState('PLAYING');
    updateProgress(0, 0);
    handleCoverArt(null);

    parsedLrc  = [];
    lastLrcRaw = null;
    elLyricsBody.innerHTML = '';

    updatePlaylistUI(idx);
    setTimeout(() => api.refresh(), 300);
}

function togglePlayPause() {
    if (lastState === 'PLAYING') {
        api.pause();
        syncTransportToState('PAUSED');
        syncVinylToState('PAUSED');
        elNpState.textContent = 'PAUSED';
    } else if (lastState === 'PAUSED') {
        api.resume();
        syncTransportToState('PLAYING');
        syncVinylToState('PLAYING');
        elNpState.textContent = 'PLAYING';
    } else {
        const idx = currentIdx >= 0 ? currentIdx : 0;
        if (tracks.length > 0) playTrack(idx);
    }
}

function playNext() {
    if (!tracks.length) return;
    if (loopEnabled) { playTrack(currentIdx); return; }
    playTrack((currentIdx + 1) % tracks.length);
}

function playPrev() {
    if (!tracks.length) return;
    playTrack((currentIdx - 1 + tracks.length) % tracks.length);
}

// ── Playlist UI sync ──────────────────────────────────────────────────────────
/**
 * Marks items as active/playing based on the currentIdx.
 * Called after playTrack() and from syncPlaylistToTitle().
 */
function updatePlaylistUI(activeIdx) {
    document.querySelectorAll('.pl-item').forEach((el) => {
        const i = parseInt(el.dataset.index, 10);
        el.classList.toggle('active',  i === activeIdx);
        el.classList.toggle('playing', i === activeIdx && lastState !== 'STOPPED');
    });
}

/**
 * Syncs playlist highlight when daemon reports a title.
 * Handles the case where the track was started externally.
 */
function syncPlaylistToTitle(title) {
    document.querySelectorAll('.pl-item').forEach((el) => {
        const i    = parseInt(el.dataset.index, 10);
        const name = tracks[i]?.name || '';
        const isMatch = name.toLowerCase() === title.toLowerCase();
        // active = selected track (always), playing = active + currently playing
        el.classList.toggle('active',  isMatch);
        el.classList.toggle('playing', isMatch && lastState !== 'STOPPED');
        if (isMatch) currentIdx = i;
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
    api.watchFolder(folder);
}

/**
 * Renders the playlist list.
 * If activePl is set, only shows tracks in that playlist.
 * Each item shows a "+" button only when a playlist is active (to add tracks).
 */
function renderPlaylist() {
    Array.from(elPlaylist.querySelectorAll('.pl-item')).forEach(el => el.remove());

    // Determine which track indices to show
    let indices;
    if (activePl && playlists[activePl]) {
        indices = playlists[activePl];
    } else {
        indices = tracks.map((_, i) => i);
    }

    if (indices.length === 0) {
        elPlEmpty.style.display = '';
        return;
    }
    elPlEmpty.style.display = 'none';

    const showAddBtn = !activePl; // show "+" only in All Tracks view so user can add to a playlist

    indices.forEach((trackIdx, displayNum) => {
        const t  = tracks[trackIdx];
        if (!t) return;
        const li = document.createElement('li');
        li.className         = 'pl-item';
        li.dataset.index     = trackIdx;
        li.style.animationDelay = `${displayNum * 25}ms`;

        const isActive  = trackIdx === currentIdx;
        const isPlaying = isActive && lastState === 'PLAYING';
        if (isActive)  li.classList.add('active');
        if (isPlaying) li.classList.add('playing');

        li.innerHTML = `
            <span class="pl-num">${String(displayNum + 1).padStart(2, '0')}</span>
            <span class="pl-name" title="${esc(t.name)}">${esc(t.name)}</span>
            ${showAddBtn ? `<button class="pl-add-btn" title="Add to playlist">+</button>` : ''}
            <span class="pl-dot"></span>`;

        li.querySelector('.pl-name').addEventListener('click', () => playTrack(trackIdx));

        if (showAddBtn) {
            li.querySelector('.pl-add-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                const name = document.getElementById('pl-select').value;
                if (!name) return alert('Select a playlist first');
                if (!playlists[name].includes(trackIdx)) {
                    playlists[name].push(trackIdx);
                    savePlaylists();
                    // Flash feedback
                    const btn = e.currentTarget;
                    btn.textContent = '✓';
                    setTimeout(() => { btn.textContent = '+'; }, 800);
                }
            });
        }

        elPlaylist.appendChild(li);
    });
}

// ── Volume ────────────────────────────────────────────────────────────────────
function updateVolFill(v) {
    const fill = document.getElementById('vol-fill');
    if (fill) fill.style.height = (Math.min(v, 200) / 200 * 100) + '%';
}

elVolSlider.addEventListener('input', () => {
    const v = parseInt(elVolSlider.value, 10);
    elVolValue.textContent = v;
    updateVolFill(v);
    api.setVolume(v);
});
updateVolFill(100);

// ── Progress bar click (seek) ─────────────────────────────────────────────────
elProgressTrack.addEventListener('click', (e) => {
    const rect  = elProgressTrack.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const pct   = Math.max(0, Math.min(100, ratio * 100));
    elProgressFill.style.width = `${pct.toFixed(2)}%`;
    const seekSec = Math.floor(ratio * lastDuration);
    elTimeElapsed.textContent = formatTime(seekSec);
    if (lastDuration > 0) api.seek(seekSec);
});

// ── Lyrics panel ──────────────────────────────────────────────────────────────
function toggleLyrics() {
    lyricsVisible = !lyricsVisible;
    if (lyricsVisible) {
        elLyricsWrap.style.display = 'flex';
        void elLyricsWrap.offsetWidth;
        elLyricsWrap.classList.add('lyrics-open');
        elLyricsBtn.classList.add('active');
    } else {
        elLyricsWrap.classList.remove('lyrics-open');
        elLyricsBtn.classList.remove('active');
        elLyricsWrap.addEventListener('transitionend', () => {
            if (!lyricsVisible) elLyricsWrap.style.display = 'none';
        }, { once: true });
    }
}

// ── EQ ────────────────────────────────────────────────────────────────────────
elEqBtn.addEventListener('click', () => {
    const open = elEqPanel.style.display === 'none' || elEqPanel.style.display === '';
    // toggle: if currently hidden (display none or empty after initial hide), show it
    const isHidden = elEqPanel.style.display === 'none';
    elEqPanel.style.display = isHidden ? 'flex' : 'none';
    elEqBtn.classList.toggle('active', isHidden);
});

eqBands.forEach(id => {
    document.getElementById(id).addEventListener('input', (e) => {
        const band = id.replace('eq-', '');
        const gain = parseInt(e.target.value, 10);
        api.setEq(band, gain);
    });
});

elLyricsBtn.addEventListener('click', toggleLyrics);
elLyricsClose.addEventListener('click', toggleLyrics);

// ── Daemon event callbacks ────────────────────────────────────────────────────
api.onDanaTags((tags) => { handleDanaTags(tags); });
api.onCoverArt((dataUrl) => { handleCoverArt(dataUrl); });
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

api.onFolderChanged(async () => {
    const folder = elFolderPath.textContent;
    if (!folder || folder === 'no folder selected') return;
    tracks = await api.scanFolder(folder);
    elFolderCnt.textContent = `${tracks.length} track${tracks.length !== 1 ? 's' : ''}`;
    renderPlaylist();
});

// ── Playlist controls ─────────────────────────────────────────────────────────
document.getElementById('pl-new-btn').addEventListener('click', () => {
    const name = prompt('Playlist name:');
    if (!name || !name.trim()) return;
    if (playlists[name.trim()]) return alert('Playlist already exists');
    playlists[name.trim()] = [];
    renderPlSelect();
    savePlaylists();
});

document.getElementById('pl-select').addEventListener('change', (e) => {
    activePl = e.target.value || null;
    renderPlaylist();
    // Update section label and badge
    if (activePl) {
        elPlSectionLabel.textContent = 'PLAYLIST';
        elPlActiveBadge.textContent  = activePl.toUpperCase();
        elPlActiveBadge.classList.add('visible');
    } else {
        elPlSectionLabel.textContent = 'LIBRARY';
        elPlActiveBadge.textContent  = '';
        elPlActiveBadge.classList.remove('visible');
    }
});

// ── Window chrome ─────────────────────────────────────────────────────────────
elTbMin.addEventListener('click',   () => api.minimizeWindow());
elTbMax.addEventListener('click',   () => api.maximizeWindow());
elTbClose.addEventListener('click', () => api.closeWindow());

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    switch (e.code) {
        case 'Space':      e.preventDefault(); togglePlayPause(); break;
        case 'ArrowRight': playNext(); break;
        case 'ArrowLeft':  playPrev(); break;
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
loadPlaylists();
syncTransportToState('STOPPED');
syncVinylToState('STOPPED');