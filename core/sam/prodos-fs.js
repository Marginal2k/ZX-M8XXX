/**
 * ZX-M8XXX - SAM Coupé: the files on a Pro-DOS (CP/M) disk
 * @license GPL-3.0
 *
 * Pro-DOS's disks are CP/M 2.2 disks of 80 cylinders, 2 sides, 9 sectors of
 * 512 bytes, laid out as found on its own disks (the FDOS library, games
 * released as .cpm):
 * - in the order of an MGT image: cylinder, then side, then sector;
 * - track 0 side 0 is Pro-DOS's own ("SAM Coupe Pro-Dos." / "Pro-DOS" at
 *   byte 16 of its first sector), the rest is the CP/M disk;
 * - blocks of 2K from there, the directory in blocks 0-3 (256 entries of 32
 *   bytes), 16-bit block numbers, 8 to an entry: 16K an extent.
 *
 *   const lin = proDosImage(bytes);     // the 720K in order, or null
 *   const files = listProDosFiles(lin); // { name, base, ext, user, length, data, ... }
 */

import { loadSamDisk, isProDosDisk } from './sam-disk.js';

const SECTOR = 512, SECTORS = 9, CYLS = 80, HEADS = 2;
const RESERVED = SECTORS * SECTOR;       // track 0, side 0
const BLOCK = 2048, DIR_BLOCKS = 4, ENTRY = 32;
const EXTENT = 16384, RECORD = 128;

// The disk's 720K in order (from any image of it: raw, MGT-sized, EDSK),
// or null if it is not a Pro-DOS disk
export function proDosImage(bytes) {
    let disk;
    try { disk = loadSamDisk(bytes); } catch (e) { return null; }
    if (!isProDosDisk(disk)) return null;
    const out = new Uint8Array(CYLS * HEADS * SECTORS * SECTOR);
    for (let c = 0; c < CYLS; c++) {
        for (let h = 0; h < HEADS; h++) {
            for (let s = 1; s <= SECTORS; s++) {
                const t = disk.track(c, h) || [];
                const sec = t.find(x => x.id.sector === s);
                if (sec) out.set(sec.data.subarray(0, SECTOR), ((c * HEADS + h) * SECTORS + s - 1) * SECTOR);
            }
        }
    }
    return out;
}

const TYPES = {
    COM: 'Program', SUB: 'Submit', TXT: 'Text', DOC: 'Text', LBR: 'Library', BAS: 'BASIC',
    ASM: 'Source', MAC: 'Source', Z80: 'Source', DAT: 'Data', OVR: 'Overlay', HLP: 'Help',
};

// The files, as CP/M sees them: each file's extents put together in order
export function listProDosFiles(lin) {
    const byKey = new Map();
    for (let e = 0; e < DIR_BLOCKS * BLOCK / ENTRY; e++) {
        const o = RESERVED + e * ENTRY, user = lin[o];
        if (user > 15) continue;                 // E5: free
        const ch = (k) => String.fromCharCode(lin[o + k] & 0x7F);
        let base = '', ext = '';
        for (let k = 1; k <= 8; k++) base += ch(k);
        for (let k = 9; k <= 11; k++) ext += ch(k);
        base = base.trimEnd(); ext = ext.trimEnd();
        if (!base || /[\x00-\x1F]/.test(base + ext)) continue;
        const key = `${user}:${base}.${ext}`;
        if (!byKey.has(key)) {
            byKey.set(key, {
                user, base, ext, extents: [],
                readOnly: !!(lin[o + 9] & 0x80), system: !!(lin[o + 10] & 0x80),
            });
        }
        const blocks = [];
        for (let k = 16; k < 32; k += 2) {
            const b = lin[o + k] | (lin[o + k + 1] << 8);
            if (b) blocks.push(b);
        }
        byKey.get(key).extents.push({ n: (lin[o + 14] << 5) | (lin[o + 12] & 0x1F), rc: lin[o + 15], blocks });
    }
    const files = [];
    for (const f of byKey.values()) {
        f.extents.sort((a, b) => a.n - b.n);
        const last = f.extents[f.extents.length - 1];
        const length = last.n * EXTENT + Math.min(last.rc, 128) * RECORD;
        const data = new Uint8Array(length);
        for (const x of f.extents) {
            x.blocks.forEach((b, k) => {
                const at = x.n * EXTENT + k * BLOCK, from = RESERVED + b * BLOCK;
                if (at >= length || from + BLOCK > lin.length) return;
                data.set(lin.subarray(from, from + Math.min(BLOCK, length - at)), at);
            });
        }
        files.push({
            name: f.ext ? `${f.base}.${f.ext}` : f.base, base: f.base, ext: f.ext, user: f.user,
            length, data, readOnly: f.readOnly, system: f.system,
            typeName: TYPES[f.ext] || (f.ext || 'File'),
            startAddr: f.ext === 'COM' ? 0x100 : 0,
        });
    }
    return files.sort((a, b) => a.user - b.user || a.name.localeCompare(b.name));
}

// how full the disk is: blocks in use and the disk's blocks
export function proDosUsage(lin) {
    const used = new Set();
    for (let e = 0; e < DIR_BLOCKS * BLOCK / ENTRY; e++) {
        const o = RESERVED + e * ENTRY;
        if (lin[o] > 15) continue;
        for (let k = 16; k < 32; k += 2) { const b = lin[o + k] | (lin[o + k + 1] << 8); if (b) used.add(b); }
    }
    const total = Math.floor((lin.length - RESERVED) / BLOCK);
    return { used: used.size + DIR_BLOCKS, total, blockSize: BLOCK };
}
