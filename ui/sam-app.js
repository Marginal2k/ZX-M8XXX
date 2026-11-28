// sam-app.js — the SAM Coupé page (sam.html): the machine, its screen, the
// keyboard and the sound, run 50 frames a second.

import { SamCoupe, FB_W, FB_H } from '../core/sam/sam.js';
import { loadSamDisk, isSamDiskName } from '../core/sam/sam-disk.js';
import { ZipLoader } from '../core/loaders/zip.js';

// PC key (KeyboardEvent.code) -> SAM key
const KEYMAP = {
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
        const k = KEYMAP[e.code];
        if (!k) return;
        e.preventDefault();
        if (isDown) down.add(e.code); else down.delete(e.code);
        m.key(k, isDown);
    };
    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
    window.addEventListener('blur', () => { down.clear(); m.releaseAll(); });

    // ---- mouse ----
    // A click on the screen captures the pointer for the SAM mouse; Esc lets it go
    canvas.addEventListener('mousedown', (e) => {
        if (document.pointerLockElement !== canvas) {
            canvas.requestPointerLock?.();
            return;
        }
        e.preventDefault();
        m.mouseButton(e.button === 0 ? 1 : e.button === 2 ? 2 : 3, true);
    });
    window.addEventListener('mouseup', (e) => {
        if (document.pointerLockElement === canvas) m.mouseButton(e.button === 0 ? 1 : e.button === 2 ? 2 : 3, false);
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('mousemove', (e) => {
        if (document.pointerLockElement === canvas) m.mouseMove(e.movementX, -e.movementY);
    });
    document.addEventListener('pointerlockchange', () => {
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
        if (o.sound) o.sound.textContent = on ? '🔊 Sound on' : '🔇 Sound off';
    };

    // ---- the loop ----
    let paused = false, last = performance.now(), acc = 0;
    const FRAME_MS = 20;
    const tick = (now) => {
        if (!paused) {
            acc += Math.min(now - last, 100);
            while (acc >= FRAME_MS) {
                tickBoot();
                m.runFrame();
                if (soundOn && node) node.port.postMessage({ left: m.audioL.slice(), right: m.audioR.slice() });
                acc -= FRAME_MS;
            }
            draw();
        }
        last = now;
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // ---- disks ----
    // A program boots as on the machine: reset, a key past the start screen,
    // then BOOT typed in, each key held 4 frames and let go for 4
    let script = [];
    const boot = () => {
        m.reset();
        script = [];
        let f = m.frames + 300;
        const tap = (k) => { script.push([f, k, true], [f + 4, k, false]); f += 8; };
        tap('SPACE');
        f += 50;                                  // the ROM clears its screen
        for (const k of ['B', 'O', 'O', 'T', 'RETURN']) tap(k);
    };
    const tickBoot = () => {
        while (script.length && script[0][0] <= m.frames) {
            const [, k, down] = script.shift();
            m.key(k, down);
        }
    };
    const names = ['', ''];
    const insert = async (file, drive, andBoot) => {
        try {
            let data = new Uint8Array(await file.arrayBuffer()), name = file.name;
            if (ZipLoader.isZip(data)) {
                const files = (await ZipLoader.extract(data)).filter(f => isSamDiskName(f.name));
                if (!files.length) throw new Error('no SAM disk in the ZIP');
                data = new Uint8Array(files[0].data); name = files[0].name;
            }
            m.drives[drive].insert(loadSamDisk(data));
            names[drive] = name;
            say(`drive ${drive + 1}: ${name}`);
            if (andBoot) boot();
        } catch (e) {
            say(`${file.name}: ${e.message}`);
        }
        canvas.focus();
    };
    (o.files || []).forEach((input, i) => input?.addEventListener('change', () => {
        if (input.files[0]) insert(input.files[0], i, i === 0);
        input.value = '';
    }));
    if (o.drop) {
        o.drop.addEventListener('dragover', (e) => e.preventDefault());
        o.drop.addEventListener('drop', (e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) insert(f, 0, true);
        });
    }
    o.save?.addEventListener('click', () => {
        const disk = m.drives[0].disk;
        if (!disk) { say('drive 1 is empty'); return; }
        const { data: d, ext } = disk.toFile();   // MGT, or EDSK for a disk in its own format
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([d], { type: 'application/octet-stream' }));
        a.download = (names[0] || 'disk').replace(/(\.gz)?$/i, '').replace(/\.[^.]*$/, '') + '.' + ext;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    o.reset?.addEventListener('click', () => { m.reset(); canvas.focus(); });
    o.pause?.addEventListener('click', () => {
        paused = !paused;
        o.pause.textContent = paused ? '▶ Run' : '⏸ Pause';
    });
    o.sound?.addEventListener('click', () => setSound(!soundOn));
    canvas.focus();
    say('');
    return { machine: m, setSound, pause: (p) => { paused = p; }, draw, insert, boot, tickBoot };
}
