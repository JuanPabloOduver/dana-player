'use strict';

let tracks = [];
let currentIdx = -1;
let loopEnabled = false;
let lastState = 'STOPPED';
let lastDuration = 0;
let lyricsVisible = false;
let playlists = {};
let activePl = null;
let lastFilePath = null;
let lastTitle = null;
let lastHasCover = false;
let parsedLrc = [];
let lastLrcRaw = null;

const elPlaylist = document.getElementById('playlist');
const elPlEmpty = document.getElementById('pl-empty');
const elFolderPath = document.getElementById('folder-path');
const elFolderCnt = document.getElementById('folder-count');
const elFolderBtn = document.getElementById('folder-btn');
const elCoverImg = document.getElementById('cover-img');
const elCoverPlaceholder = document.getElementById('cover-placeholder');
const elVinylContainer = document.getElementById('vinyl-container');
const elNpState = document.getElementById('np-state');
const elNpTitle = document.getElementById('np-title');
const elNpArtist = document.getElementById('np-artist');
const elNpAlbum = document.getElementById('np-album');
const elVolSlider = document.getElementById('vol-slider');
const elVolValue = document.getElementById('vol-value');
const elTimeElapsed = document.getElementById('time-elapsed');
const elTimeTotal = document.getElementById('time-total');
const elProgressFill = document.getElementById('progress-fill');
const elProgressTrack = document.getElementById('progress-track');
const elTpPlay = document.getElementById('tp-play');
const elTpPrev = document.getElementById('tp-prev');
const elTpNext = document.getElementById('tp-next');
const elTpLoop = document.getElementById('tp-loop');
const elDaemonDot = document.getElementById('daemon-dot');
const elDaemonText = document.getElementById('daemon-text');
const elSrFmt = document.getElementById('sr-fmt');
const elLyricsWrap = document.getElementById('lyrics-wrap');
const elLyricsBody = document.getElementById('lyrics-body');
const elLyricsClose = document.getElementById('lyrics-close');
const elLyricsBtn = document.getElementById('sr-lyrics-btn');
const elTbMin = document.getElementById('tb-min');
const elTbMax = document.getElementById('tb-max');
const elTbClose = document.getElementById('tb-close');
const elEqBtn = document.getElementById('eq-btn');
const elPlSectionLabel = document.getElementById('pl-section-label');
const elPlActiveBadge = document.getElementById('pl-active-badge');
const elEqPanel = document.getElementById('eq-panel');
const eqBands = ['eq-60', 'eq-250', 'eq-1k', 'eq-4k', 'eq-16k'];

function parseLrc(raw) {
    if (!raw) return [];
    const LRC_LINE = /^\[(\d{1,3}):(\d{2})(?:[.:,](\d{1,3}))?\d]\s*(.*)/;
    const result = [];
    for (const line of raw.split('\n')) {
        const m = line.match(LRC_LINE);
        if (!m) continue;
        const mins = parseInt(m[1], 10);
        const secs = parseInt(m[2], 10);
        const frac = m[3] ? parseFloat('0.' + m[3]) : 0;
        const time = mins * 60 + secs + frac;
        const text = m[4].trim();
        result.push({ time, text });
    }
    return result.sort((a, b) => a.time - b.time);
}

function isLrc(raw) {
    return /\[\d{1,3}:\d{2}/.test(raw);
}

function renderLyricsDOM(lrcLines, plainText) {
    elLyricsBody.innerHTML = '';
    if (lrcLines && lrcLines.length > 0) {
        lrcLines.forEach(({ time, text }) => {
            if (!text) return;
            const div = document.createElement('div');
            div.className = 'lyric-line';
            div.dataset.time = time;
            div.textContent = text;
            elLyricsBody.appendChild(div);
        });
    } else if (plainText) {
        const lines = plainText.replace(/\\n/g, '\n').split('\n');
        lines.forEach(line => {
            const div = document.createElement('div');
            div.className = 'lyric-line';
            div.textContent = line || '\u00A0';
            elLyricsBody.appendChild(div);
        });
    } else {
        const div = document.createElement('div');
        div.className = 'lyric-line';
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
        if (newTitle) elNpTitle.textContent = newTitle;
        if (newArtist) elNpArtist.textContent = newArtist;
        if (newAlbum) elNpAlbum.textContent = newAlbum;

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

function syncVinylToState(state) {
    if (state === 'PLAYING') {
        elVinylContainer.classList.add('spinning');
        elCoverImg.classList.add('spinning');
    } else {
        elVinylContainer.classList.remove('spinning');
        elCoverImg.classList.remove('spinning');
    }
}

function handleCoverArt(dataUrl) {
    if (dataUrl && dataUrl.startsWith('data:image')) {
        elCoverImg.src = dataUrl;
        elCoverImg.style.display = 'block';
        elCoverPlaceholder.style.display = 'none';
        elVinylContainer.classList.remove('no-cover');
    } else {
        elCoverImg.src = '';
        elCoverImg.style.display = 'none';
        elCoverPlaceholder.style.display = 'flex';
        elVinylContainer.classList.add('no-cover');
    }
}

function handleDanaTags(tags) {
    const state = (tags.state || 'STOPPED').toUpperCase();
    const title = tags.title || '';
    const artist = tags.artist || '';
    const album = tags.album || '';
    const elapsed = Number(tags.time) || 0;
    const duration = Number(tags.duration) || 0;
    const lyrics = tags.lyrics || '';
    const filePath = tags.file || tags.path || null;
    const hasCover = tags.has_cover === true || tags.has_cover === 'true';

    const trackChanged = filePath !== lastFilePath;

    if (trackChanged) {
        lastFilePath = filePath;
        handleCoverArt(null);
        lastHasCover = false;

        if (title || artist) {
            triggerTrackTransition(title || null, artist || null, album || null);
        } else {
            const fallback = tracks[currentIdx]?.name || '';
            elNpTitle.textContent = fallback || 'Unknown';
            elNpArtist.textContent = '—';
            elNpAlbum.textContent = '';
        }

        parsedLrc = [];
        lastLrcRaw = null;
        elLyricsBody.innerHTML = '';
    } else {
        if (title) elNpTitle.textContent = title;
        if (artist) elNpArtist.textContent = artist;
        if (album) elNpAlbum.textContent = album;
    }

    if (hasCover && !lastHasCover && filePath) {
        lastHasCover = true;
    } else if (trackChanged && !hasCover) {
        lastHasCover = false;
        handleCoverArt(null);
    }

    lastTitle = title;
    lastState = state;
    lastDuration = duration;

    elNpState.textContent = state;
    syncVinylToState(state);

    if (tags.sample_rate || tags.sampleRate) {
        const sr = tags.sample_rate || tags.sampleRate;
        const bd = tags.bit_depth || tags.bitDepth || 16;
        const ch = tags.channels || 2;
        elSrFmt.textContent = `PCM ${sr / 1000}kHz / ${bd}-bit / ${ch === 1 ? 'Mono' : 'Stereo'}`;
    }

    updateProgress(elapsed, duration);
    syncTransportToState(state);
    syncPlaylistToState();

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
        parsedLrc = [];
        renderLyricsDOM(null, null);
    }

    if (parsedLrc.length > 0) syncLyricsHighlight(elapsed);
}

function savePlaylists() {
    try {
        localStorage.setItem('dana-playlists', JSON.stringify(playlists));
    } catch (_) {}
}

function loadPlaylists() {
    try {
        playlists = JSON.parse(localStorage.getItem('dana-playlists')) || {};
    } catch {
        playlists = {};
    }
    renderPlSelect();
}

function renderPlSelect() {
    const sel = document.getElementById('pl-select');
    const prev = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    Object.keys(playlists).forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
    });
    if (prev && playlists[prev]) sel.value = prev;
}

function updateProgress(elapsed, duration) {
    elTimeElapsed.textContent = formatTime(elapsed);
    elTimeTotal.textContent = formatTime(duration);
    const pct = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;
    elProgressFill.style.width = `${pct.toFixed(2)}%`;
}

function formatTime(seconds) {
    const s = Math.floor(seconds);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function syncTransportToState(state) {
    const icoPlay = elTpPlay.querySelector('.ico-play');
    const icoPause = elTpPlay.querySelector('.ico-pause');
    const playing = state === 'PLAYING';
    icoPlay.style.display = playing ? 'none' : '';
    icoPause.style.display = playing ? '' : 'none';
}

let _playDebounce = null;

function playTrack(idx) {
    if (idx < 0 || idx >= tracks.length) return;

    if (_playDebounce) {
        clearTimeout(_playDebounce);
        _playDebounce = null;
    }

    const track = tracks[idx];

    currentIdx = idx;
    lastState = 'PLAYING';
    lastFilePath = null;
    lastHasCover = false;

    elNpTitle.textContent = track.name;
    elNpArtist.textContent = '—';
    elNpAlbum.textContent = '';
    elNpState.textContent = 'BUFFERING…';
    syncTransportToState('PLAYING');
    syncVinylToState('PLAYING');
    updateProgress(0, 0);

    handleCoverArt(null);

    parsedLrc = [];
    lastLrcRaw = null;
    elLyricsBody.innerHTML = '';

    updatePlaylistUI(idx);

    _playDebounce = setTimeout(() => {
        _playDebounce = null;
        api.playFile(track.path);
        setTimeout(() => api.refresh(), 400);
        setTimeout(() => api.refresh(), 1500);
    }, 180);
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
    if (loopEnabled) {
        playTrack(currentIdx);
        return;
    }
    playTrack((currentIdx + 1) % tracks.length);
}

function playPrev() {
    if (!tracks.length) return;
    playTrack((currentIdx - 1 + tracks.length) % tracks.length);
}

function updatePlaylistUI(activeIdx) {
    document.querySelectorAll('.pl-item').forEach((el) => {
        const i = parseInt(el.dataset.index, 10);
        el.classList.toggle('active', i === activeIdx);
        el.classList.toggle('playing', i === activeIdx && lastState === 'PLAYING');
    });
}

function syncPlaylistToState() {
    document.querySelectorAll('.pl-item').forEach((el) => {
        const i = parseInt(el.dataset.index, 10);
        el.classList.toggle('active', i === currentIdx);
        el.classList.toggle('playing', i === currentIdx && lastState === 'PLAYING');
    });
}

async function openFolder() {
    const folder = await api.openFolderDialog();
    if (!folder) return;
    elFolderPath.textContent = folder;
    tracks = await api.scanFolder(folder);
    elFolderCnt.textContent = `${tracks.length} track${tracks.length !== 1 ? 's' : ''}`;
    renderPlaylist();
    api.watchFolder(folder);
}

function renderPlaylist() {
    Array.from(elPlaylist.querySelectorAll('.pl-item')).forEach(el => el.remove());

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

    const showAddBtn = !activePl;

    indices.forEach((trackIdx, displayNum) => {
        const t = tracks[trackIdx];
        if (!t) return;
        const li = document.createElement('li');
        li.className = 'pl-item';
        li.dataset.index = trackIdx;
        li.style.animationDelay = `${displayNum * 25}ms`;

        const isActive = trackIdx === currentIdx;
        const isPlaying = isActive && lastState === 'PLAYING';
        if (isActive) li.classList.add('active');
        if (isPlaying) li.classList.add('playing');

        li.innerHTML = `
            <span class="pl-num">${String(displayNum + 1).padStart(2, '0')}</span>
            <span class="pl-name" title="${esc(t.name)}">${esc(t.name)}</span>
            ${showAddBtn ? '<button class="pl-add-btn" title="Add to playlist">+</button>' : ''}
            <span class="pl-dot"></span>
        `;

        li.querySelector('.pl-name').addEventListener('click', () => playTrack(trackIdx));

        if (showAddBtn) {
            li.querySelector('.pl-add-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                const name = document.getElementById('pl-select').value;
                if (!name) return alert('Select a playlist first');
                if (!playlists[name].includes(trackIdx)) {
                    playlists[name].push(trackIdx);
                    savePlaylists();
                    const btn = e.currentTarget;
                    btn.textContent = '✓';
                    setTimeout(() => {
                        btn.textContent = '+';
                    }, 800);
                }
            });
        }

        elPlaylist.appendChild(li);
    });
}

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

elProgressTrack.addEventListener('click', (e) => {
    const rect = elProgressTrack.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const pct = Math.max(0, Math.min(100, ratio * 100));
    elProgressFill.style.width = `${pct.toFixed(2)}%`;
    const seekSec = Math.floor(ratio * lastDuration);
    elTimeElapsed.textContent = formatTime(seekSec);
    if (lastDuration > 0) api.seek(seekSec);
});

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

elEqBtn.addEventListener('click', () => {
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

api.onDanaTags((tags) => {
    handleDanaTags(tags);
});

api.onCoverArt((dataUrl) => {
    handleCoverArt(dataUrl);
});

api.onDaemonStatus(({ connected }) => {
    elDaemonDot.className = `daemon-dot ${connected ? 'ok' : 'err'}`;
    elDaemonText.textContent = connected ? 'danaplayd connected' : 'daemon offline';
});

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

// ── Playlist Modal (replaces prompt) ────────────────────────────────────────
const elModalOverlay = document.getElementById('playlist-modal');
const elModalInput = document.getElementById('modal-playlist-name');
const elModalCreate = document.getElementById('modal-create-btn');
const elModalCancel = document.getElementById('modal-cancel-btn');
const elModalClose = document.getElementById('modal-close-btn');

function showPlaylistModal() {
    elModalOverlay.style.display = 'flex';
    elModalInput.value = '';
    elModalInput.focus();
}

function hidePlaylistModal() {
    elModalOverlay.style.display = 'none';
    elModalInput.value = '';
}

function createPlaylist() {
    const name = elModalInput.value.trim();
    if (!name) {
        elModalInput.focus();
        return;
    }
    if (playlists[name]) {
        alert('Playlist already exists!');
        return;
    }
    playlists[name] = [];
    renderPlSelect();
    savePlaylists();
    hidePlaylistModal();
}

document.getElementById('pl-new-btn').addEventListener('click', showPlaylistModal);
elModalCreate.addEventListener('click', createPlaylist);
elModalCancel.addEventListener('click', hidePlaylistModal);
elModalClose.addEventListener('click', hidePlaylistModal);

elModalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createPlaylist();
    if (e.key === 'Escape') hidePlaylistModal();
});

elModalOverlay.addEventListener('click', (e) => {
    if (e.target === elModalOverlay) hidePlaylistModal();
});

document.getElementById('pl-select').addEventListener('change', (e) => {
    activePl = e.target.value || null;
    renderPlaylist();
    if (activePl) {
        elPlSectionLabel.textContent = 'PLAYLIST';
        elPlActiveBadge.textContent = activePl.toUpperCase();
        elPlActiveBadge.classList.add('visible');
    } else {
        elPlSectionLabel.textContent = 'LIBRARY';
        elPlActiveBadge.textContent = '';
        elPlActiveBadge.classList.remove('visible');
    }
});

elTbMin.addEventListener('click', () => api.minimizeWindow());
elTbMax.addEventListener('click', () => api.maximizeWindow());
elTbClose.addEventListener('click', () => api.closeWindow());

document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    switch (e.code) {
        case 'Space':
            e.preventDefault();
            togglePlayPause();
            break;
        case 'ArrowRight':
            playNext();
            break;
        case 'ArrowLeft':
            playPrev();
            break;
        case 'KeyL':
            elTpLoop.click();
            break;
    }
});

function esc(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

loadPlaylists();
syncTransportToState('STOPPED');
syncVinylToState('STOPPED');