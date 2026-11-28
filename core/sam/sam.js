/**
 * ZX-M8XXX - SAM Coupé: the machine
 * @license GPL-3.0
 *
 * A machine of its own, not a Spectrum model: it shares the Z80 and the
 * SAA1099 with the Spectrum core and nothing else. Written from the SAM
 * Coupé Technical Manual (MGT, 1989/1990); SimCoupe's behaviour is the
 * reference where the manual is silent.
 *
 *   CPU     Z80B at 6 MHz; a frame is 312 lines of 384 T-states
 *   memory  512K of RAM in 32 pages of 16K, a 32K ROM (ROM0 and ROM1)
 *   paging  LMPR (250): page of sections A/B, ROM0 off (b5), ROM1 on (b6),
 *                       write protect of section A (b7)
 *           HMPR (251): page of sections C/D, mode 3 colours (b5-b6)
 *           VMPR (252): screen page, mode (b5-b6)
 *   video   mode 1 (the Spectrum's screen), mode 2 (8x1 attributes),
 *           mode 3 (512x192, 4 colours), mode 4 (256x192, 16 colours);
 *           a CLUT of 16 entries from 128 colours (248, the entry in A8-A11)
 *   ints    frame (status bit 3) and line (status bit 0, line in 249),
 *           active low on the status port 249 for 128 T-states
 *
 * Time in a frame is counted as SimCoupe counts it: T-state 0 is the frame
 * interrupt, at the start of the right border of the last line (311). The
 * raster line l starts (its left border) at 64 + l * 384; screen line y is
 * raster line 68 + y; a line interrupt for y comes at (68 + y) * 384, the
 * start of the right border of the line above it.
 *   sound   SAA1099 (255: A8 = 1 address, A8 = 0 data), beeper (254 bit 4)
 *
 *   disks   a WD1772 for each drive: drive 1 at 224-231, drive 2 at 240-247
 *           (A0-A1 the register, A2 the side); the +D's controller
 *   waits   memory contention and the ASIC port waits as SimCoupe has them:
 *           an access to RAM waits for the next free slot, every 8 T-states
 *           while the screen is fetched (and in mode 1 in a band of each
 *           line), every 4 otherwise; the ROM is not held
 *
 *   mouse   on port 254 with A8-A15 high: each read gives the next nibble of
 *           strobe, -, buttons, Y (256 / 16 / 1), X (256 / 16 / 1); 38 us
 *           without a read and it starts again (SimCoupe's Mouse.cpp)
 *   extmem  1MB on HMPR bit 7: section C the page in LEPR (128), D the one
 *           in HEPR (129); pages past the first megabyte read #FF
 *   DOS     a disk with no DOS boots SAMDOS 2.2 (roms/samdos2.sbt) as
 *           SimCoupe does it: while the ROM's BOOT loads track 4 a disk
 *           holding SAMDOS stands in for it, then the disk is back
 *
 * Not yet: MIDI, a tape.
 */

import { Z80 } from '../z80.js';
import { SAA1099, SAA_CLOCK } from '../saa1099.js';
import { PlusDDisk } from '../loaders/disk-mgt.js';
import { hasDos, makeFileDisk } from './sam-disk.js';

export const CPU_CLOCK = 6000000;
export const T_LINE = 384;
export const LINES = 312;
export const T_FRAME = T_LINE * LINES;
export const TOP = 68;                     // lines above the first screen line
export const SCREEN_T = 64;                // T-states of left border in a line (and the
                                           // frame's offset: T 0 is the right border of line 311)
export const BORDER_X = 32;                // border shown each side, in low-res pixels
export const BORDER_Y = 24;                // border lines shown above and below
export const FB_W = (BORDER_X * 2 + 256) * 2;   // hi-res pixels: mode 3 is 512 wide
export const FB_H = BORDER_Y * 2 + 192;
const CELLS = (BORDER_X * 2 + 256) / 8;    // 8 low-res pixels a cell
const INT_TIME = 128;                      // T-states an interrupt stays active
const PAGES = 32;
const NO_MEMORY = new Uint8Array(0x8000).fill(0xFF);   // past the external memory
const EXT_PAGES = 64;                      // 1MB of external memory
const MOUSE_RESET = 228;                   // 38 us
const SCREEN_CONTENTION_OFFSET = 4;

// The waits a RAM access starting at each T-state of the frame gets
// (SimCoupe's Memory.cpp): mode 1, modes 2-4, and the screen off
function contentionTable(kind) {
    const tab = new Uint8Array(T_FRAME + 64);
    for (let t = 0; t < tab.length; t++) {
        const line = Math.floor(t / T_LINE);
        const lc = (t + SCREEN_CONTENTION_OFFSET) % T_LINE;
        const screen = line >= TOP && line < TOP + 192 && lc >= 128;
        const band = !(lc & 0x40);
        const mask = kind === 1 ? ((screen || band) ? 7 : 3) : kind === 2 ? (screen ? 7 : 3) : 3;
        tab[t] = mask - ((t + 2) & mask);
    }
    return tab;
}
const WAIT_MODE1 = contentionTable(1), WAIT_MODE234 = contentionTable(2), WAIT_OFF = contentionTable(3);
const RAM_MASK = PAGES * 0x4000 - 1;

// SAM keyboard: rows selected by A8-A15 as on the Spectrum, bits 0-4 read on
// port 254, bits 5-7 on port 249; row 8 (A8-A15 all high) on port 254
export const KEY_ROWS = [
    ['SHIFT', 'Z', 'X', 'C', 'V', 'F1', 'F2', 'F3'],
    ['A', 'S', 'D', 'F', 'G', 'F4', 'F5', 'F6'],
    ['Q', 'W', 'E', 'R', 'T', 'F7', 'F8', 'F9'],
    ['1', '2', '3', '4', '5', 'ESC', 'TAB', 'CAPS'],
    ['0', '9', '8', '7', '6', '-', '+', 'DELETE'],
    ['P', 'O', 'I', 'U', 'Y', '=', '"', 'F0'],
    ['RETURN', 'L', 'K', 'J', 'H', ';', ':', 'EDIT'],
    ['SPACE', 'SYMBOL', 'M', 'N', 'B', ',', '.', 'INV'],
    ['CNTRL', 'UP', 'DOWN', 'LEFT', 'RIGHT'],
];
export const KEYS = {};
KEY_ROWS.forEach((row, r) => row.forEach((k, b) => { KEYS[k] = [r, b]; }));

// The 128 colours: G1 R1 B1 BRIGHT G0 R0 B0 (bits 6..0); each gun is three
// bits, its two and the shared BRIGHT
export const PALETTE = new Uint32Array(128);
for (let c = 0; c < 128; c++) {
    const br = (c >> 3) & 1;
    const lvl = (hi, lo) => Math.round((((c >> hi) & 1) << 2 | ((c >> lo) & 1) << 1 | br) * 255 / 7);
    const r = lvl(5, 1), g = lvl(6, 2), b = lvl(4, 0);
    PALETTE[c] = (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0;
}

export class SamCoupe {
    constructor() {
        this.ram = new Uint8Array(PAGES * 0x4000);
        this.ext = new Uint8Array(EXT_PAGES * 0x4000);
        this.lepr = 0; this.hepr = 0;
        this.dos = null;                           // { disk, last } of SAMDOS, see setDos
        this.rom = new Uint8Array(0x8000);
        this.fb = new Uint32Array(FB_W * FB_H);
        this.clut = new Uint8Array(16);
        this.keys = new Uint8Array(9).fill(0xFF);
        this.saa = new SAA1099();
        this.secBuf = [this.rom, this.ram, this.ram, this.ram];
        this.secOff = [0, 0, 0, 0];
        this.secRO = [true, false, false, false];
        this.cpu = new Z80(this);
        this.cpu.portRead = (port) => this.portIn(port);
        this.cpu.portWrite = (port, val) => this.portOut(port, val);
        this.mouse = { dx: 0, dy: 0, buttons: 0, pos: 0, last: 0, buf: new Uint8Array(9) };
        this.disks = [new PlusDDisk(), new PlusDDisk()];
        // The disks turn in real time: 300 rpm, ten frames a revolution
        this.frameBase = 0;
        for (const d of this.disks) d.setRotationClock(() => this.frameBase + this.cpu.tStates, () => 10 * T_FRAME);
        this.contention = true;
        this._hookWaits();
        this.sampleRate = 44100;
        this.frames = 0;
        this.ear = 1;                          // the tape input idles high
        this.reset();
    }

    loadRom(data) {
        const b = new Uint8Array(data);
        this.rom.fill(0xFF);
        this.rom.set(b.subarray(0, 0x8000));
    }

    reset() {
        this.lmpr = 0; this.hmpr = 0; this.vmpr = 0; this.lepr = 0; this.hepr = 0;
        this._restoreDos();
        this.border = 0; this.lineInt = 0xFF;
        this.clut.fill(0);
        this.beeper = 0;
        this.saa.reset();
        for (const d of this.disks) d.reset();
        this.cpu.reset();
        this.cpu.tStates = 0;
        this.rpos = 0;
        this._audioReset();
        this._page();
    }

    // ---- memory ----
    _page() {
        const lp = this.lmpr & 0x1F, hp = this.hmpr & 0x1F;
        if (this.lmpr & 0x20) {
            this.secBuf[0] = this.ram; this.secOff[0] = lp << 14; this.secRO[0] = !!(this.lmpr & 0x80);
        } else {
            this.secBuf[0] = this.rom; this.secOff[0] = 0; this.secRO[0] = true;
        }
        this.secBuf[1] = this.ram; this.secOff[1] = ((lp + 1) & 0x1F) << 14; this.secRO[1] = false;
        if (this.hmpr & 0x80) {                    // external memory
            for (const [sec, pg] of [[2, this.lepr], [3, this.hepr]]) {
                if (pg < EXT_PAGES) { this.secBuf[sec] = this.ext; this.secOff[sec] = pg << 14; this.secRO[sec] = false; }
                else { this.secBuf[sec] = NO_MEMORY; this.secOff[sec] = 0; this.secRO[sec] = true; }
            }
            return;
        }
        this.secBuf[2] = this.ram; this.secOff[2] = hp << 14; this.secRO[2] = false;
        if (this.lmpr & 0x40) {
            this.secBuf[3] = this.rom; this.secOff[3] = 0x4000; this.secRO[3] = true;
        } else {
            this.secBuf[3] = this.ram; this.secOff[3] = ((hp + 1) & 0x1F) << 14; this.secRO[3] = false;
        }
    }

    read(addr) {
        const s = addr >> 14;
        return this.secBuf[s][this.secOff[s] + (addr & 0x3FFF)];
    }

    write(addr, val) {
        const s = addr >> 14;
        if (this.secRO[s]) return;
        const a = this.secOff[s] + (addr & 0x3FFF), buf = this.secBuf[s];
        if (buf === this.ram) {
            // the beam has to see what was there before the write
            const sp = this._screenBase();
            if (a >= sp && a < sp + this._screenSize()) this.renderTo(this.cpu.tStates);
        }
        buf[a] = val;
    }

    // ---- waits ----
    // The core counts an instruction's T-states from its start; where in it an
    // access falls is tracked here (4 for an opcode fetch, 3 for any other
    // access, plus the internal cycles), as the Spectrum does it.
    _hookWaits() {
        const cpu = this.cpu;
        let off = 0, first = true;
        this._startInstr = () => { off = 0; first = true; };
        cpu.contend = (addr) => {
            if (this.contention && this.secBuf[addr >> 14] === this.ram) {
                cpu.tStates += this._waits()[cpu.tStates + off] || 0;
            }
            off += first ? 4 : 3;
            first = false;
        };
        cpu.internalCycles = (n) => { off += n; };
        cpu.contendInternal = (addr, n) => { off += n; };
        cpu.ioContend = (port) => {
            if (this.contention && (port & 0xFF) >= 0xF8) {
                cpu.tStates += 7 - ((cpu.tStates + off + 2) & 7);
            }
        };
        const incR = cpu.incR.bind(cpu);
        cpu.incR = () => { if (off > 0) first = true; return incR(); };
    }

    _waits() {
        const mode = this._mode();
        return mode === 0 ? WAIT_MODE1 : (mode >= 2 && (this.border & 0x80)) ? WAIT_OFF : WAIT_MODE234;
    }

    _mode() { return (this.vmpr >> 5) & 3; }      // 0..3 = modes 1..4
    _screenBase() { return (this._mode() >= 2 ? this.vmpr & 0x1E : this.vmpr & 0x1F) << 14; }
    _screenSize() { return this._mode() >= 2 ? 0x6000 : this._mode() === 1 ? 0x3800 : 0x1B00; }

    // ---- ports ----
    _status(t) {
        let s = 0x1F;
        if (this.lineInt < 192) {
            const lt = this._intT(this.lineInt);
            if (t >= lt && t < lt + INT_TIME) s &= ~0x01;
        }
        if (t < INT_TIME) s &= ~0x08;
        return s;
    }

    // An interrupt for screen line n comes at the start of the right border
    // of the line above it
    _intT(n) { return (TOP + n) * T_LINE; }

    _keyRows(hi) {
        let v = 0xFF;
        for (let r = 0; r < 8; r++) if (!(hi & (1 << r))) v &= this.keys[r];
        return v;
    }

    portIn(port) {
        const lo = port & 0xFF, hi = port >> 8, t = this.cpu.tStates;
        if ((lo & 0xF8) === 0xE0 || (lo & 0xF8) === 0xF0) {
            const d = this.disks[(lo >> 4) & 1];
            if (!(lo & 0x08)) { d.side = (lo >> 2) & 1; return d.readRegister(lo & 3); }
        }
        switch (lo) {
            case 0xFE: {
                const k = hi === 0xFF ? this.keys[8] & this._mouseIn() : this._keyRows(hi);
                return (k & 0x1F) | (this.border & 0x80) | (this.ear ? 0x40 : 0);
            }
            case 0xF9: return this._status(t) | (this._keyRows(hi) & 0xE0);
            case 0xF8: {
                // As SimCoupe counts them: the line from the frame interrupt,
                // the position from 128 T-states into it
                const line = Math.floor(t / T_LINE) - TOP, lt = t % T_LINE;
                const onScreen = line >= 0 && line < 192;
                if (port & 0x100) {                  // HPEN: the line being scanned
                    return onScreen && (line > 0 || lt >= 2 * SCREEN_T) ? line : 192;
                }
                if (onScreen && lt >= 2 * SCREEN_T) return ((lt - 2 * SCREEN_T) & 0xFC) | (this.border & 1);
                return this.border & 1;              // LPEN
            }
            case 0xFA: return this.lmpr;
            case 0xFB: return this.hmpr;
            case 0xFC: return this.vmpr | 0x80;       // bit 7: MIDI in, idle high
            default: return 0xFF;
        }
    }

    portOut(port, val) {
        const lo = port & 0xFF, t = this.cpu.tStates;
        if ((lo & 0xF8) === 0xE0 || (lo & 0xF8) === 0xF0) {
            const d = this.disks[(lo >> 4) & 1];
            if (!(lo & 0x08)) {
                d.side = (lo >> 2) & 1;
                if ((lo & 3) === 0 && d === this.disks[0]) this._dosBoot(d, val);
                d.writeRegister(lo & 3, val);
                return;
            }
        }
        switch (lo) {
            case 0xF8: this.renderTo(t); this.clut[hi4(port)] = val & 0x7F; break;
            case 0xF9: this.lineInt = val; break;
            case 0xFA: this.lmpr = val; this._page(); break;
            case 0xFB: this.renderTo(t); this.hmpr = val; this._page(); break;
            case 0xFC: this.renderTo(t); this.vmpr = val; break;
            case 0xFE:
                this.renderTo(t);
                this.border = val;
                if (((val >> 4) & 1) !== this.beeper) { this.beeper = (val >> 4) & 1; this.beepLog.push(t, this.beeper); }
                break;
            case 0x80: this.lepr = val; this._page(); break;
            case 0x81: this.hepr = val; this._page(); break;
            case 0xFF: this.saaLog.push(t, (port & 0x100) ? 0x100 | val : val); break;
        }
    }

    // ---- the frame ----
    runFrame() {
        const cpu = this.cpu;
        while (cpu.tStates < T_FRAME) {
            const t = cpu.tStates;
            if (cpu.iff1 && this._status(t) !== 0x1F) {
                cpu.tStates += cpu.interrupt();
                continue;
            }
            if (cpu.halted) {
                if (cpu.eiPending) { cpu.eiPending = false; cpu.iff1 = cpu.iff2 = true; }
                cpu.tStates += 4;
                cpu.incR();
            } else {
                this._startInstr();
                cpu.execute();
            }
        }
        this.renderTo(T_FRAME);
        this._audioFrame();
        cpu.tStates -= T_FRAME;
        this.frameBase += T_FRAME;
        this.rpos = 0;
        this.frames++;
    }

    // ---- the picture ----
    _cellOf(t) {
        const u = t - SCREEN_T;                     // from the left border of raster line 0
        if (u < 0) return 0;
        const line = Math.floor(u / T_LINE) - (TOP - BORDER_Y);
        if (line < 0) return 0;
        if (line >= FB_H) return FB_H * CELLS;
        const x = (u % T_LINE) - (SCREEN_T - BORDER_X);
        if (x < 0) return line * CELLS;
        if (x >= CELLS * 8) return (line + 1) * CELLS;
        return line * CELLS + (x >> 3);
    }

    renderTo(t) {
        const end = this._cellOf(t);
        for (let c = this.rpos; c < end; c++) this._cell(Math.floor(c / CELLS), c % CELLS);
        if (end > this.rpos) this.rpos = end;
    }

    _cell(y, cx) {
        const fb = this.fb, clut = this.clut;
        let p = y * FB_W + cx * 16;
        const sy = y - BORDER_Y, sx = cx - BORDER_X / 8;
        const mode = this._mode();
        if (sy < 0 || sy >= 192 || sx < 0 || sx >= 32 || (mode >= 2 && (this.border & 0x80))) {
            const c = PALETTE[clut[(this.border & 7) | ((this.border >> 2) & 8)]];
            for (let i = 0; i < 16; i++) fb[p++] = c;
            return;
        }
        const ram = this.ram, base = this._screenBase();
        if (mode <= 1) {
            let pix, attr;
            if (mode === 0) {
                pix = ram[base + (((sy & 0xC0) << 5) | ((sy & 7) << 8) | ((sy & 0x38) << 2) | sx)];
                attr = ram[base + 0x1800 + ((sy >> 3) << 5) + sx];
            } else {
                pix = ram[base + (sy << 5) + sx];
                attr = ram[base + 0x2000 + (sy << 5) + sx];
            }
            const br = (attr >> 3) & 8;
            let ink = PALETTE[clut[(attr & 7) | br]], paper = PALETTE[clut[((attr >> 3) & 7) | br]];
            if ((attr & 0x80) && (this.frames & 16)) { const x = ink; ink = paper; paper = x; }
            for (let b = 0x80; b; b >>= 1) { const c = (pix & b) ? ink : paper; fb[p++] = c; fb[p++] = c; }
        } else if (mode === 2) {
            const a = (base + sy * 128 + sx * 4) & RAM_MASK, md3 = (this.hmpr >> 3) & 0x0C;
            for (let i = 0; i < 4; i++) {
                const v = ram[(a + i) & RAM_MASK];
                fb[p++] = PALETTE[clut[(v >> 6) | md3]];
                fb[p++] = PALETTE[clut[((v >> 4) & 3) | md3]];
                fb[p++] = PALETTE[clut[((v >> 2) & 3) | md3]];
                fb[p++] = PALETTE[clut[(v & 3) | md3]];
            }
        } else {
            const a = base + sy * 128 + sx * 4;
            for (let i = 0; i < 4; i++) {
                const v = ram[(a + i) & RAM_MASK];
                const c1 = PALETTE[clut[v >> 4]], c2 = PALETTE[clut[v & 15]];
                fb[p++] = c1; fb[p++] = c1; fb[p++] = c2; fb[p++] = c2;
            }
        }
    }

    // ---- sound ----
    _audioReset() {
        this.beepLog = [];
        this.saaLog = [];
        this.beepLevel = 0;
        this.audioL = new Float32Array(0);
        this.audioR = new Float32Array(0);
        this._sampleAcc = 0;
    }

    // The frame's samples, the beeper and the SAA's writes at their T-states
    _audioFrame() {
        const tPerSample = CPU_CLOCK / this.sampleRate;
        const n = Math.floor((T_FRAME - this._sampleAcc) / tPerSample) + 1;
        const L = new Float32Array(n), R = new Float32Array(n);
        const saaPerSample = SAA_CLOCK / this.sampleRate;
        let bi = 0, si = 0, t = this._sampleAcc, i = 0;
        const bl = this.beepLog, sl = this.saaLog;
        for (; i < n && t < T_FRAME; i++, t += tPerSample) {
            while (bi < bl.length && bl[bi] <= t) { this.beepLevel = bl[bi + 1]; bi += 2; }
            while (si < sl.length && sl[si] <= t) {
                const v = sl[si + 1];
                if (v & 0x100) this.saa.writeAddress(v & 0xFF); else this.saa.writeData(v);
                si += 2;
            }
            const [a, b] = this.saa.run(saaPerSample);
            const beep = this.beepLevel ? 0.25 : 0;
            L[i] = a + beep; R[i] = b + beep;
        }
        for (; bi < bl.length; bi += 2) this.beepLevel = bl[bi + 1];
        for (; si < sl.length; si += 2) {
            const v = sl[si + 1];
            if (v & 0x100) this.saa.writeAddress(v & 0xFF); else this.saa.writeData(v);
        }
        this._sampleAcc = t - T_FRAME;
        this.beepLog = []; this.saaLog = [];
        this.audioL = L.subarray(0, i); this.audioR = R.subarray(0, i);
    }

    // ---- a DOS for disks without one ----
    setDos(code) { this.dos = code ? makeFileDisk(new Uint8Array(code)) : null; }

    // Called on every command to drive 1: the ROM's read of track 4 sector 1
    // (BOOT) from a disk with no DOS reads SAMDOS instead, up to its last
    // sector. Only the ROM's: a program's own file may start there too.
    _dosBoot(d, cmd) {
        const drv = d.drives[0], sw = this._dosSwap, isRead = (cmd & 0xE0) === 0x80;
        if (sw && sw.done) this._restoreDos();
        if (!this._dosSwap && this.dos && isRead && drv.diskData && d.side === 0 &&
            this.secBuf[this.cpu.pc >> 14] === this.rom &&
            d.track === 4 && d.sector === 1 && !hasDos(drv.diskData)) {
            this._dosSwap = { orig: drv.diskData, done: false };
            drv.diskData = this.dos.disk;
        }
        const s = this._dosSwap;
        if (s && isRead && d.track === this.dos.last.track && d.sector === this.dos.last.sector) s.done = true;
    }

    _restoreDos() {
        if (!this._dosSwap) return;
        this.disks[0].drives[0].diskData = this._dosSwap.orig;
        this._dosSwap = null;
    }

    // ---- mouse ----
    _mouseIn() {
        const ms = this.mouse, now = this.frameBase + this.cpu.tStates;
        if (now - ms.last > MOUSE_RESET) ms.pos = 0;
        ms.last = now;
        const b = ms.buf;
        if (ms.pos === 2) {                       // the first data byte: take the movement now
            const x = ms.dx, y = ms.dy;
            b[0] = b[1] = 0xFF;
            b[2] = ~ms.buttons & 0xFF;
            b[3] = (y >> 8) & 0x0F; b[4] = (y >> 4) & 0x0F; b[5] = y & 0x0F;
            b[6] = (x >> 8) & 0x0F; b[7] = (x >> 4) & 0x0F; b[8] = x & 0x0F;
            ms.readX = x; ms.readY = y;
        } else if (ms.pos < 2) {
            b[0] = b[1] = 0xFF;
        }
        const i = ms.pos % 9;
        const v = 0xF0 | b[i];
        ms.pos++;
        if (i === 8) {                            // all read: what was reported is used up
            b.fill(0, 3);
            ms.dx -= ms.readX || 0; ms.dy -= ms.readY || 0;
            ms.readX = ms.readY = 0;
            ms.pos++;                             // back to the data, still strobed
        }
        return v;
    }

    // Movement in SAM's directions: x right, y up
    mouseMove(dx, dy) {
        const ms = this.mouse;
        ms.dx = Math.max(-127, Math.min(127, ms.dx + dx));
        ms.dy = Math.max(-127, Math.min(127, ms.dy + dy));
    }

    // button 1 left, 2 right, 3 middle
    mouseButton(n, down) {
        const bit = 1 << (n - 1);
        if (down) this.mouse.buttons |= bit; else this.mouse.buttons &= ~bit;
    }

    // ---- keyboard ----
    key(name, down) {
        const k = KEYS[name];
        if (!k) return;
        if (down) this.keys[k[0]] &= ~(1 << k[1]); else this.keys[k[0]] |= 1 << k[1];
    }

    releaseAll() { this.keys.fill(0xFF); }
}

function hi4(port) { return (port >> 8) & 0x0F; }
