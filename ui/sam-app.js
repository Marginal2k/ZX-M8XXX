// sam-app.js — the SAM Coupé page (sam.html): the machine, its screen, the
// keyboard and the sound, run 50 frames a second.

import { SamCoupe, FB_W, FB_H } from '../core/sam/sam.js';
import { loadSamDisk, isSamDiskName } from '../core/sam/sam-disk.js';
import { ZipLoader } from '../core/loaders/zip.js';

// PC key (KeyboardEvent.code) -> SAM key
export const KEYMAP = {
    ShiftLeft: 'SHIFT', ShiftRight: 'SHIFT', AltLeft: 'SYMBOL', AltRight: 'SYMBOL',
    ControlLeft: 'CNTRL', ControlRight: 'CNTRL',
    ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
    Enter: 'RETURN', NumpadEnter: 'RETURN', Space: 'SPACE',
    Backspace: 'DELETE', Delete: 'DELETE', Escape: 'ESC', Tab: 'TAB', CapsLock: 'CAPS',
    Minus: '-', NumpadSubtract: '-', Equal: '=', NumpadAdd: '+', Quote: '"',
    Semicolon: ';', Backslash: ':', Comma: ',', Period: '.',
    Insert: 'EDIT', BracketRight: 'EDIT', End: 'INV', BracketLeft: 'INV',
    F10: 'F0', Numpad0: 'F0',
};
for (let i = 0; i <= 9; i++) KEYMAP['Digit' + i] = String(i);
for (let i = 1; i <= 9; i++) { KEYMAP['F' + i] = 'F' + i; KEYMAP['Numpad' + i] = 'F' + i; }
for (let c = 65; c <= 90; c++) KEYMAP['Key' + String.fromCharCode(c)] = String.fromCharCode(c);

export async function createSamApp(o) {
    const m = new SamCoupe();
    // every listener, so destroy() can take them all off again
    const offs = [];
    const on = (t, ev, fn, opt) => { t.addEventListener(ev, fn, opt); offs.push(() => t.removeEventListener(ev, fn, opt)); };
    const say = (t) => { if (o.status) o.status.textContent = t; };
    try {
        const r = await fetch(o.romBase + 'samcoupe.rom');
        if (!r.ok) throw new Error(r.status);
        m.loadRom(await r.arrayBuffer());
    } catch (e) {
        say('roms/samcoupe.rom (SAM ROM 3.0, 32K) is missing');
        throw e;
    }
    // SAMDOS 2.2 for disks with no DOS on them (SimCoupe's samdos2.sbt)
    try {
        const r = await fetch(o.romBase + 'samdos2.sbt');
        if (r.ok) m.setDos(await r.arrayBuffer());
    } catch (e) { /* disks without a DOS then say NO DOS, as on the machine */ }
    m.reset();

    // ---- screen ----
    const canvas = o.canvas;
    canvas.width = FB_W; canvas.height = FB_H * 2;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(FB_W, FB_H * 2);
    const out = new Uint32Array(img.data.buffer);
    const draw = () => {
        for (let y = 0; y < FB_H; y++) {
            const src = m.fb.subarray(y * FB_W, (y + 1) * FB_W);
            out.set(src, y * 2 * FB_W);
            out.set(src, (y * 2 + 1) * FB_W);
        }
        ctx.putImageData(img, 0, 0);
    };

    // ---- keyboard ----
    const down = new Set();
    const onKey = (e, isDown) => {
        // typing into the debugger's fields is not typing on the SAM
        if (e.target && e.target.closest && e.target.closest('input, select, textarea')) return;
        const k = KEYMAP[e.code];
        if (!k) return;
        e.preventDefault();
        if (isDown) down.add(e.code); else down.delete(e.code);
        m.key(k, isDown);
    };
    on(window, 'keydown', (e) => onKey(e, true));
    on(window, 'keyup', (e) => onKey(e, false));
    on(window, 'blur', () => { down.clear(); m.releaseAll(); });

    // ---- mouse ----
    // A click on the screen captures the pointer for the SAM mouse; Esc lets it go
    on(canvas, 'mousedown', (e) => {
        if (document.pointerLockElement !== canvas) {
            canvas.requestPointerLock?.();
            return;
        }
        e.preventDefault();
        m.mouseButton(e.button === 0 ? 1 : e.button === 2 ? 2 : 3, true);
    });
    on(window, 'mouseup', (e) => {
        if (document.pointerLockElement === canvas) m.mouseButton(e.button === 0 ? 1 : e.button === 2 ? 2 : 3, false);
    });
    on(canvas, 'contextmenu', (e) => e.preventDefault());
    on(document, 'mousemove', (e) => {
        if (document.pointerLockElement === canvas) m.mouseMove(e.movementX, -e.movementY);
    });
    on(document, 'pointerlockchange', () => {
        if (document.pointerLockElement !== canvas) { m.mouseButton(1, false); m.mouseButton(2, false); m.mouseButton(3, false); }
    });

    // ---- sound ----
    let audio = null, node = null, soundOn = false;
    const setSound = async (on) => {
        soundOn = on;
        if (on && !audio) {
            audio = new AudioContext();
            await audio.audioWorklet.addModule(new URL('../core/audio-processor.js', import.meta.url));
            node = new AudioWorkletNode(audio, 'zx-audio-processor', { outputChannelCount: [2] });
            node.connect(audio.destination);
            m.sampleRate = audio.sampleRate;
        }
        if (audio) { if (on) await audio.resume(); else await audio.suspend(); }
        // a page with its own labels (o.labels) gets them; else these
        const lb = o.labels || {};
        if (o.sound) o.sound.textContent = on ? (lb.soundOn ?? '🔊 Sound on') : (lb.soundOff ?? '🔇 Sound off');
    };

    // ---- the loop ----
    let paused = false, last = performance.now(), acc = 0;
    const FRAME_MS = 20;
    const setPaused = (p) => {
        paused = !!p;
        if (o.pause) o.pause.textContent = paused ? ((o.labels || {}).run ?? '▶ Run') : ((o.labels || {}).pause ?? '⏸ Pause');
        if (paused) { m.releaseAll(); draw(); }
        o.onPauseChange?.(paused);
    };
    // One frame as the page runs it; false when a breakpoint stopped it
    const frame = () => {
        tickBoot();
        const hit = m.runFrame();
        if (hit) {                                 // a breakpoint: stop where it is
            setPaused(true);
            o.onBreak?.(hit);
            return false;
        }
        if (soundOn && node) node.port.postMessage({ left: m.audioL.slice(), right: m.audioR.slice() });
        for (const cb of frameListeners) { try { cb(m); } catch (e) { console.error(e); } }
        return true;
    };
    // called after every frame the page runs (recording frames, a batch of
    // screenshots); returns the function that takes it off again
    const frameListeners = new Set();
    const onFrame = (cb) => { frameListeners.add(cb); return () => frameListeners.delete(cb); };
    // The picture at one SAM pixel a point: 320 x 240 (the screen 256 x 192
    // and its border 32 / 24), for tools that crop by Spectrum-sized pixels
    // (the Mapper). Mode 3's 512 across is taken a point in two here.
    let native = null;
    const getNativeCanvas = () => {
        if (!native) { native = document.createElement('canvas'); native.width = FB_W / 2; native.height = FB_H; }
        const nctx = native.getContext('2d'), id = nctx.createImageData(FB_W / 2, FB_H), d = new Uint32Array(id.data.buffer);
        for (let y = 0; y < FB_H; y++) for (let x = 0; x < FB_W / 2; x++) d[y * (FB_W / 2) + x] = m.fb[y * FB_W + x * 2];
        nctx.putImageData(id, 0, 0);
        return native;
    };
    const tick = (now) => {
        if (!paused) {
            acc += Math.min(now - last, 100);
            while (acc >= FRAME_MS) {
                if (!frame()) { acc = 0; break; }
                acc -= FRAME_MS;
            }
            draw();
        }
        last = now;
        if (!stopped) raf = requestAnimationFrame(tick);
    };
    let stopped = false, raf = requestAnimationFrame(tick);

    // ---- disks ----
    // A program boots as on the machine: reset, a key past the start screen,
    // then BOOT typed in, each key held 4 frames and let go for 4
    let script = [];
    // (a tape: LOAD "" in place of BOOT)
    const boot = (command = ['B', 'O', 'O', 'T', 'RETURN']) => {
        m.reset();
        script = [];
        let f = m.frames + 300;
        const tap = (k) => { script.push([f, k, true], [f + 4, k, false]); f += 8; };
        tap('SPACE');
        f += 50;                                  // the ROM clears its screen
        for (const k of command) tap(k);
    };
    const LOAD_TAPE = ['L', 'O', 'A', 'D', 'SPACE', '"', '"', 'RETURN'];
    const isTapeName = (n) => /\.(tap|tzx|wav|csw)$/i.test(n || '');

    // A tape (TAP, TZX, WAV, or one in a zip) on the SAM's tape input; with
    // andBoot the machine is reset and LOAD "" typed
    const insertTape = async (file, andBoot = false, prefer = '') => {
        try {
            let data = new Uint8Array(await file.arrayBuffer()), name = file.name;
            if (ZipLoader.isZip(data)) {
                const files = (await ZipLoader.extract(data)).filter(f => isTapeName(f.name));
                if (!files.length) throw new Error('no tape in the ZIP');
                const want = prefer.split(/[\\/]/).pop().toLowerCase();
                const f = files.find(x => x.name.split('/').pop().toLowerCase() === want) || files[0];
                data = new Uint8Array(f.data); name = f.name;
            }
            m.tape.insert(data, name);
            say(`tape: ${name}`);
            if (andBoot) boot(LOAD_TAPE);
            canvas.focus({ preventScroll: true });
            return name;
        } catch (e) {
            say(`${file.name}: ${e.message}`);
            return null;
        }
    };
    // a disk or a tape, by its name (a zip by what is in it)
    const open = async (file, andBoot = true, prefer = '') => {
        let tape = isTapeName(file.name) || isTapeName(prefer);
        if (!tape && /\.zip$/i.test(file.name || '')) {
            try {
                const list = await ZipLoader.extract(new Uint8Array(await file.arrayBuffer()));
                tape = !list.some(f => isSamDiskName(f.name)) && list.some(f => isTapeName(f.name));
            } catch (e) { /* the disk path will say */ }
        }
        return tape ? insertTape(file, andBoot, prefer) : insert(file, 0, andBoot, prefer);
    };
    const tickBoot = () => {
        while (script.length && script[0][0] <= m.frames) {
            const [, k, down] = script.shift();
            m.key(k, down);
        }
    };
    const names = ['', ''];
    // file: a File, or anything with a name and arrayBuffer(); prefer: the
    // file in a zip to take (zxart's launchFilePath), else its first SAM disk
    const insert = async (file, drive, andBoot, prefer = '') => {
        try {
            let data = new Uint8Array(await file.arrayBuffer()), name = file.name;
            if (ZipLoader.isZip(data)) {
                const files = (await ZipLoader.extract(data)).filter(f => isSamDiskName(f.name));
                if (!files.length) throw new Error('no SAM disk in the ZIP');
                const want = prefer.split(/[\\/]/).pop().toLowerCase();
                const f = files.find(x => x.name.split('/').pop().toLowerCase() === want) || files[0];
                data = new Uint8Array(f.data); name = f.name;
            }
            m.drives[drive].insert(loadSamDisk(data));
            names[drive] = name;
            say(`drive ${drive + 1}: ${name}`);
            if (andBoot) boot();
            canvas.focus({ preventScroll: true });
            return name;
        } catch (e) {
            say(`${file.name}: ${e.message}`);
            return null;
        }
    };
    (o.files || []).forEach((input, i) => input && on(input, 'change', () => {
        if (input.files[0]) insert(input.files[0], i, i === 0);
        input.value = '';
    }));
    if (o.drop) {
        on(o.drop, 'dragover', (e) => e.preventDefault());
        on(o.drop, 'drop', (e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) open(f, true);
        });
    }
    if (o.save) on(o.save, 'click', () => {
        const disk = m.drives[0].disk;
        if (!disk) { say('drive 1 is empty'); return; }
        const { data: d, ext } = disk.toFile();   // MGT, or EDSK for a disk in its own format
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([d], { type: 'application/octet-stream' }));
        a.download = (names[0] || 'disk').replace(/(\.gz)?$/i, '').replace(/\.[^.]*$/, '') + '.' + ext;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    if (o.reset) on(o.reset, 'click', () => { m.reset(); draw(); o.onPauseChange?.(paused); canvas.focus(); });
    if (o.pause) on(o.pause, 'click', () => setPaused(!paused));
    if (o.sound) on(o.sound, 'click', () => setSound(!soundOn));
    canvas.focus();
    say('');
    // runFrames(n): n frames as the page would run them (for scripts and tests);
    // stops early on a breakpoint, returns how many ran
    const runFrames = (n) => {
        let i = 0;
        while (i < n && !paused) { i++; if (!frame()) break; }
        draw();
        return i;
    };
    const destroy = () => {
        stopped = true;
        cancelAnimationFrame(raf);
        offs.forEach(f => f());
        if (document.pointerLockElement === canvas) document.exitPointerLock();
        if (audio) audio.close().catch(() => {});
    };
    // ---- the tape's controls ----
    if (o.tape) {
        const t = o.tape;
        const show = () => {
            if (t.status) t.status.textContent = m.tape.inserted ? `${m.tape.status()} ${m.tape.name}` : '-';
            if (t.play) t.play.textContent = m.tape.playing ? (t.stopLabel || 'Stop') : (t.playLabel || 'Play');
        };
        m.tape.onChange = show;
        if (t.file) on(t.file, 'change', () => { if (t.file.files[0]) insertTape(t.file.files[0], true); t.file.value = ''; });
        if (t.play) on(t.play, 'click', () => { if (m.tape.playing) m.tape.stop(); else m.tape.play(); canvas.focus({ preventScroll: true }); });
        if (t.rewind) on(t.rewind, 'click', () => { m.tape.rewind(); canvas.focus({ preventScroll: true }); });
        if (t.fast) {
            let keep = null; try { keep = localStorage.getItem('zxm8-sam-tape-fast'); } catch (e) { /* none */ }
            t.fast.checked = keep !== '0';
            m.tape.traps = t.fast.checked;
            on(t.fast, 'change', () => { m.tape.traps = t.fast.checked; try { localStorage.setItem('zxm8-sam-tape-fast', t.fast.checked ? '1' : '0'); } catch (e) { /* not kept */ } });
        }
        show();
        const iv = setInterval(() => { if (m.tape.playing) show(); }, 500);
        offs.push(() => clearInterval(iv));
    }

    return { machine: m, onFrame, open, insertTape, getNativeCanvas, diskName: () => names[0], setSound, pause: setPaused, isPaused: () => paused, draw, insert, boot, tickBoot, runFrames, destroy,
             say, soundState: () => (audio ? audio.state : 'none') };
}
