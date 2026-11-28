/**
 * ZX-M8XXX - SAM Coupé: the tape
 * @license GPL-3.0
 *
 * As SimCoupe has it (Base/Tape.cpp, Memory.cpp's ROM hooks; Simon Owen, GPL
 * v2 or later), on the app's own tape code (core/loaders/tape.js: TAP, TZX,
 * WAV and the pulse player) in place of libspectrum:
 *
 * - The pulses are the TZX's, in 3.5 MHz T-states: the SAM runs at 6 MHz, so
 *   each is 6 / 3.5 as long here. The EAR bit is port 254 bit 6.
 * - The tape plays by itself when the ROM's edge routine (EDGLP, ROM0) reads
 *   port 254, and stops when the ROM's loader leaves (SVLDCOM, ROM1); Play /
 *   Stop by hand for a loader of a program's own.
 * - Fast loading (traps): when the ROM's loader starts a block (LDSTRT, at
 *   its RET Z in ROM1) and the tape is at the start of a ROM-speed or turbo
 *   block, the block goes into memory at once: HL the address, (5AC8) and
 *   DE the length, A' the type expected (a Spectrum header, type 0, is
 *   always 17 bytes), H the last byte and L the parity, HMPR paged up when
 *   the address passes C000; out through LOADEXIT, or LOADFAIL on a type
 *   or a length that does not match.
 *
 * The ROM's addresses are found as SimCoupe finds them, by their bytes, so
 * another ROM version works too.
 */

import { TapeLoader, TapePlayer, TZXLoader, WAVLoader } from '../loaders/tape.js';

const ZX_CLOCK = 3500000, SAM_CLOCK = 6000000;

// byte patterns (null: any byte) and where in them the address is
const HOOKS = {
    ldstrt: { rom: 1, bytes: [0xCD, null, null, 0xC8, 0x06, 0x08], at: 4 },     // call nn; ret z; ld b,8
    loadExit: { rom: 1, bytes: [0x7D, 0xFE, 0x01, 0xC9], at: 0 },             // ld a,l; cp 1; ret
    loadFail: { rom: 1, bytes: [0xAC, 0xC0, 0x79], at: 0 },                   // xor h; ret nz; ld a,c
    svldcom: { rom: 1, bytes: [0x08, 0x3A, 0x4B, 0x5C, 0xD3, 0xFE], at: 0 },  // ex af,af'; ld a,(bordcol); out (254),a
    edglp: { rom: 0, bytes: [0x0C, 0xC8, 0xA8], at: 0 },                      // inc c; ret z; xor b
};

// The address of each hook in a 32K ROM (ROM0 at 0000, ROM1 at C000), or
// null where it is not found exactly once
export function findRomHooks(rom) {
    const out = {};
    for (const [name, h] of Object.entries(HOOKS)) {
        const base = h.rom * 0x4000, found = [];
        for (let i = 0; i + h.bytes.length <= 0x4000; i++) {
            if (h.bytes.every((b, k) => b === null || rom[base + i + k] === b)) found.push(i);
        }
        out[name] = found.length === 1 ? (h.rom ? 0xC000 : 0) + found[0] + h.at : null;
    }
    return out;
}

// the blocks a loader hears or that steer the tape; the rest (texts, archive
// info, groups) the fast loading steps over
const SIGNAL = new Set(['data', 'tone', 'pulses', 'directRecording', 'cswRecording', 'generalizedData', 'pause', 'stop', 'loopStart', 'loopEnd', 'jump']);

export class SamTape {
    constructor(machine) {
        this.m = machine;
        this.player = new TapePlayer();
        this.name = '';
        this.traps = true;          // fast loading through the ROM's loader
        this.last = 0;              // the SAM T-state the player was brought up to
        this.frac = 0;              // what is left of a 3.5 MHz T-state
        this.hooks = findRomHooks(machine.rom);
        this.onChange = null;       // (tape) when it starts, stops or moves on
    }

    get inserted() { return this.player.blocks.length > 0; }
    get playing() { return this.player.isPlaying(); }

    insert(data, name = '') {
        const b = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (TZXLoader.isTZX(b)) {
            const t = new TZXLoader();
            if (!t.load(b)) throw new Error('not a TZX tape it can read');
            this.player.loadBlocks(t.blocks);
        } else if (WAVLoader.isWAV(b)) {
            const w = new WAVLoader();
            if (!w.load(b)) throw new Error('not a WAV it can read');
            this.player.loadBlocks(w.blocks);
        } else {
            const t = new TapeLoader();
            if (!t.load(b)) throw new Error('not a TAP tape');
            this.player.loadFromTapeLoader(t);
        }
        this.name = name;
        this.hooks = findRomHooks(this.m.rom);
        this._changed();
    }

    eject() { this.player.stop(); this.player.loadBlocks([]); this.name = ''; this.m.ear = 1; this._changed(); }

    _now() { return this.m.frameBase + this.m.cpu.tStates; }
    _changed() { if (this.onChange) this.onChange(this); }

    play() {
        if (!this.inserted || this.playing) return;
        this.last = this._now(); this.frac = 0;
        this.player.play();
        this._changed();
    }

    stop() {
        if (!this.playing) return;
        this.advance();
        this.player.stop();
        this._changed();
    }

    rewind() { this.player.stop(); this.player.rewind(); this._changed(); }

    // The player up to now, and the EAR bit from it
    advance() {
        const now = this._now();
        if (this.playing) {
            const zx = (now - this.last) * ZX_CLOCK / SAM_CLOCK + this.frac;
            const whole = Math.floor(zx);
            this.frac = zx - whole;
            if (whole > 0) this.player.update(whole, 0);
            this.m.ear = this.player.getEarBit() ? 1 : 0;
            if (!this.player.isPlaying()) this._changed();      // the tape ran out
        }
        this.last = now;
    }

    // ---- the ROM's hooks (the machine calls these) ----
    // IN from port 254
    onReadEar(pc) {
        if (this.inserted && !this.playing && pc === this.hooks.edglp && this._inRom(pc, 0)) this.play();
        if (this.playing) this.advance();
    }

    // before each instruction while a tape is in; true if it took the
    // instruction's place (a block loaded at once)
    onStep(pc) {
        if (pc === this.hooks.svldcom && this._inRom(pc, 1)) { if (this.playing) this.stop(); return false; }
        if (pc === this.hooks.ldstrt - 1 && this._inRom(pc, 1)) {
            if (this.traps) return this._loadTrap();
            this.play();                            // SimCoupe: no traps, the tape plays from here
        }
        return false;
    }

    _inRom(pc, n) {
        const s = pc >> 14, m = this.m;
        return m.secBuf[s] === m.rom && m.secOff[s] === n * 0x4000;
    }

    _nextBlock() {
        this.player.stop();
        this.player.setBlock(this.player.currentBlock + 1);
        this._changed();
    }

    _loadTrap() {
        const { m, player } = this, cpu = m.cpu, h = this.hooks;
        if (h.loadExit === null || h.loadFail === null) return false;
        // skip what makes no signal (texts, groups, archive info)
        while (player.currentBlock < player.blocks.length && !SIGNAL.has(player.blocks[player.currentBlock].type)) player.currentBlock++;
        const block = player.blocks[player.currentBlock];
        const atStart = !this.playing || player.phase === 'idle' || (player.phase === 'pilot' && player.blockTstates < 50000);
        if (!block || block.type !== 'data' || !atStart) { this.play(); return false; }

        const data = block.data;
        let i = 0, dest = (cpu.h << 8) | cpu.l;
        let wanted = (m.read(0x5AC8) << 16) | (cpu.d << 8) | cpu.e;
        let hb = data[i++];
        const fail = () => {
            this._nextBlock();
            cpu.f &= ~(0x40 | 0x01);                // NZ, NC
            cpu.pc = h.loadFail;
            return true;
        };
        if (hb === 0) wanted = (wanted & ~0xFF) | 17;               // a Spectrum header
        else if (hb !== cpu.a_) return fail();                      // not the type it waits for
        let parity = hb;
        while (wanted >= 0) {
            if (i >= data.length) { cpu.h = hb; cpu.l = parity; return fail(); }
            hb = data[i++];
            parity ^= hb;
            if (!wanted) break;
            m.write(dest, hb);
            dest++; wanted--;
            if (dest >= 0xC000) { m.portOut(0x00FB, (m.hmpr + 1) & 0xFF); dest -= 0x4000; }
        }
        cpu.h = hb; cpu.l = parity;
        this._nextBlock();
        cpu.pc = h.loadExit;                        // ld a,l; cp 1; ret: carry when the parity is 0
        return true;
    }

    // what to show: the block and how far into the tape
    status() {
        const p = this.player;
        if (!this.inserted) return '';
        return `${this.playing ? '▶' : '■'} ${Math.min(p.currentBlock + 1, p.blocks.length)}/${p.blocks.length}`;
    }
}
