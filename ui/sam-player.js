// sam-player.js — the embeddable player when the release is for the SAM Coupé.
//
// ui/player.js hands over to this when the hardware list names the SAM
// (zxart's "samcoupe") or the machine asked for is it, or the file is a SAD:
// the page that embeds the player sees one player either way. It has the same
// options, the same bar (sound, start again, full screen) and returns the same
// methods: restart, setFullscreen, setSound, screenshot, destroy.
//
// The machine is core/sam/ run by ui/sam-app.js, as on sam.html: a disk goes
// into drive 1 and boots the way a user boots it (a key past the start screen,
// then BOOT; a disk with no DOS of its own boots SAMDOS 2.2), a tape (TAP,
// TZX, WAV) is LOADed "" with the ROM loader's blocks loaded at once. Not
// here yet: the on-screen joystick and keyboard of the Spectrum player.

import { createSamApp } from './sam-app.js';

const ICON = { reset: '⟲', sound: '🔊', mute: '🔇', full: '⛶' };

// The codes and the files that make a release a SAM one
export function isSamRelease(opts = {}) {
    if ((opts.machine || '').toLowerCase() === 'samcoupe') return true;
    const codes = (opts.hardware || []).map(c => String(c).toLowerCase());
    if (codes.includes('samcoupe')) return true;
    const name = (opts.fileName || opts.url || '').toLowerCase().split(/[?#]/)[0];
    return /\.sad(\.gz)?$/.test(name);
}

export async function createSamPlayer(container, opts = {}) {
    const status = (text, kind = 'info') => {
        msg.textContent = kind === 'ready' ? '' : text;
        msg.className = 'zxm8-msg' + (kind === 'error' ? ' zxm8-error' : '');
        if (opts.onStatus) { try { opts.onStatus(text, kind); } catch (e) { /* host's */ } }
    };

    // ---- the page: as the Spectrum player builds it ----
    container.classList.add('zxm8-player');
    container.innerHTML = '';
    const screen = document.createElement('div');
    screen.className = 'zxm8-screen';
    screen.style.aspectRatio = '640 / 480';
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    const unmute = document.createElement('button');
    unmute.className = 'zxm8-unmute';
    unmute.textContent = ICON.mute + ' Click for sound';
    unmute.hidden = true;
    const msg = document.createElement('div');
    msg.className = 'zxm8-msg';
    screen.append(canvas, unmute, msg);
    const bar = document.createElement('div');
    bar.className = 'zxm8-bar';
    const button = (label, title, fn) => {
        const b = document.createElement('button');
        b.textContent = label; b.title = title;
        b.addEventListener('click', (e) => { e.preventDefault(); fn(); canvas.focus({ preventScroll: true }); });
        bar.append(b);
        return b;
    };
    if (opts.controls !== false) container.append(screen, bar); else container.append(screen);

    // ---- the machine ----
    // what the SAM app says ("drive 1: …", or why a disk would not load) is
    // kept, and shown only when the disk did not go in
    let lastSay = '';
    const statusEl = { set textContent(t) { if (t) lastSay = t; } };
    let app;
    try {
        app = await createSamApp({ canvas, status: statusEl, romBase: opts.romBase || 'roms/' });
    } catch (e) {
        status('The SAM Coupé ROM (roms/samcoupe.rom) is missing', 'error');
        throw e;
    }

    // ---- the release ----
    let media = null;
    async function fetchMedia() {
        if (!opts.url) return null;
        status('Downloading…');
        const res = await fetch(opts.url);
        if (!res.ok) throw new Error(`Could not download the file (HTTP ${res.status})`);
        const data = await res.arrayBuffer();
        const name = opts.fileName || decodeURIComponent(new URL(opts.url, location.href).pathname.split('/').pop() || 'disk');
        return { name, arrayBuffer: async () => data };
    }
    async function boot() {
        if (!media) { app.machine.reset(); status('', 'ready'); return; }
        lastSay = '';
        const ran = await app.open(media, true, opts.launchFilePath || '');
        if (ran) status('', 'ready'); else status(lastSay || 'This disk could not be loaded', 'error');
    }
    try { media = await fetchMedia(); } catch (e) { status(e.message, 'error'); }

    // ---- sound: browsers start it only from a click or a key ----
    let soundOn = opts.sound !== false;
    async function startAudio() {
        if (!soundOn) return;
        try {
            await app.setSound(true);
            unmute.hidden = app.soundState() === 'running';
        } catch (e) { unmute.hidden = true; }
    }
    const onGesture = () => { startAudio(); };
    container.addEventListener('pointerdown', onGesture);
    document.addEventListener('keydown', onGesture);
    unmute.addEventListener('click', () => { startAudio(); canvas.focus({ preventScroll: true }); });

    // ---- controls ----
    const btnSound = button(soundOn ? ICON.sound : ICON.mute, 'Sound on / off', () => setSound(!soundOn));
    button(ICON.reset, 'Start again', () => restart());
    button(ICON.full, 'Full screen', () => setFullscreen(!document.fullscreenElement));

    function setSound(on) {
        soundOn = !!on;
        btnSound.textContent = soundOn ? ICON.sound : ICON.mute;
        if (soundOn) startAudio(); else app.setSound(false);
    }
    async function restart() {
        try { await boot(); } catch (e) { status(e.message, 'error'); }
    }
    function setFullscreen(on) {
        if (on && !document.fullscreenElement) {
            (container.requestFullscreen ? container.requestFullscreen() : Promise.reject()).catch(() => {});
        } else if (!on && document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        }
    }
    function screenshot(type = 'image/png') {
        app.draw();
        return new Promise(res => canvas.toBlob(res, type));
    }
    let destroyed = false;
    function destroy() {
        if (destroyed) return;
        destroyed = true;
        app.destroy();
        container.removeEventListener('pointerdown', onGesture);
        document.removeEventListener('keydown', onGesture);
        container.innerHTML = '';
    }

    try {
        await boot();
        // not awaited: without a click or a key the browser may hold it forever
        startAudio();
        setTimeout(() => { if (soundOn && app.soundState() !== 'running') unmute.hidden = false; }, 500);
    } catch (e) {
        status(e.message, 'error');
    }
    canvas.focus({ preventScroll: true });
    // runFrames(n): n frames as the player runs them, for scripts and tests
    return { sam: app.machine, machine: 'samcoupe', hardware: { machine: 'samcoupe' }, restart, setFullscreen, setSound,
             screenshot, destroy, runFrames: app.runFrames };
}
