/**
 * ZX-M8XXX - SAM Coupé disks
 * @license GPL-3.0
 *
 * A disk is what the controller (core/sam/vl1772.js) reads: per track, the
 * sectors in the order they pass the head, each with its ID field and the
 * state of its data. That holds a disk in a program's own format as well as
 * a SAMDOS one. The shape follows SimCoupe's Disk.cpp (Simon Owen, GPL v2 or
 * later).
 *
 *   MGT   819200 bytes: 80 cylinders, 2 sides, 10 sectors of 512, side 0
 *         then side 1 of each cylinder (SimCoupe's raw .dsk is the same)
 *   SAD   "Aley's disk backup", then sides, tracks, sectors, size / 64;
 *         the data side by side, track by track
 *   EDSK  CPCEMU / EXTENDED: any sectors, with the 765's status bytes for
 *         CRC errors and deleted data (SamDisk, SimCoupe write these)
 *   gzip  any of these packed (SimCoupe's .dsk.gz, often named .dsk)
 */

import { DSKLoader } from '../fdc.js';
import { crcBlock, sizeFromCode, RECORD_NOT_FOUND, CRC_ERROR, DELETED_DATA, WRITE_PROTECT } from './vl1772.js';

export const MGT_SIZE = 819200;
const CYLS = 80, HEADS = 2, SECTORS = 10, SECTOR = 512;
const MAX_CYLS = 83;
const ST1_CRC = 0x20, ST2_DATA_NOT_FOUND = 0x01, ST2_CRC = 0x20, ST2_CONTROL_MARK = 0x40;
const IDAM_CRC = crcBlock([0xA1, 0xA1, 0xA1, 0xFE]);

const mgtOffset = (cyl, head, sec) => ((cyl * HEADS + head) * SECTORS + (sec - 1)) * SECTOR;

export function isSamDiskName(name) {
    return /\.(mgt|sad|dsk|img|cpm)(\.gz)?$/i.test(name || '');
}

export class SamDisk {
    constructor(cyls = CYLS, heads = HEADS) {
        this.cyls = cyls;
        this.heads = heads;
        this.tracks = Array.from({ length: MAX_CYLS * HEADS }, () => []);
        this.writeProtected = false;
        this.modified = false;
    }

    track(cyl, head) { return cyl < MAX_CYLS && head < HEADS ? this.tracks[cyl * HEADS + head] : null; }

    // sector: { id: {cyl, head, sector, size}, idCrcError, dataStatus, data }
    getSector(cyl, head, index) {
        const t = this.track(cyl, head);
        if (!t || index >= t.length) return { status: RECORD_NOT_FOUND };
        const s = t[index];
        const id = { cyl: s.id.cyl, head: s.id.head, sector: s.id.sector, size: s.id.size };
        const crc = crcBlock([id.cyl, id.head, id.sector, id.size], IDAM_CRC);
        id.crc1 = crc >> 8; id.crc2 = crc & 0xFF;
        let status = 0;
        if (s.idCrcError) { status = CRC_ERROR; id.crc1 ^= 0x55; }
        return { status, id };
    }

    readData(cyl, head, index) {
        const t = this.track(cyl, head);
        if (!t || index >= t.length) return { status: RECORD_NOT_FOUND, data: new Uint8Array(0) };
        const s = t[index];
        const data = new Uint8Array(sizeFromCode(s.id.size));
        data.set(s.data.subarray(0, data.length));
        return { status: s.dataStatus, data };
    }

    writeData(cyl, head, index, data) {
        const t = this.track(cyl, head);
        if (!t || index >= t.length) return RECORD_NOT_FOUND;
        if (this.writeProtected) return WRITE_PROTECT;
        const s = t[index];
        if (data.length !== sizeFromCode(s.id.size)) return RECORD_NOT_FOUND;
        s.data = data.slice();
        s.idCrcError = false;
        s.dataStatus &= ~CRC_ERROR;
        this.modified = true;
        return 0;
    }

    formatTrack(cyl, head, sectors) {
        const t = this.track(cyl, head);
        if (!t) return WRITE_PROTECT;
        if (this.writeProtected) return WRITE_PROTECT;
        this.tracks[cyl * HEADS + head] = sectors.filter(s => s.data).map(s => ({
            id: { ...s.id }, idCrcError: false, dataStatus: 0, data: s.data.slice(),
        }));
        if (cyl >= this.cyls) this.cyls = cyl + 1;
        this.modified = true;
        return 0;
    }

    // The data of the sector with this number, as SAMDOS would find it
    sectorById(cyl, head, sector) {
        const t = this.track(cyl, head) || [];
        const s = t.find(x => x.id.cyl === cyl && x.id.sector === sector);
        return s ? s.data : null;
    }

    // ---- making one ----
    static fromMgt(b) {
        const d = new SamDisk();
        const sectors = b.length / (CYLS * HEADS * SECTOR);
        for (let c = 0; c < CYLS; c++)
            for (let h = 0; h < HEADS; h++)
                for (let s = 1; s <= sectors; s++) {
                    const o = ((c * HEADS + h) * sectors + (s - 1)) * SECTOR;
                    d.track(c, h).push({ id: { cyl: c, head: h, sector: s, size: 2 }, idCrcError: false,
                        dataStatus: 0, data: b.slice(o, o + SECTOR) });
                }
        return d;
    }

    static fromSad(b) {
        const heads = b[18], cyls = b[19], sectors = b[20], size = b[21] * 64;
        const code = Math.max(0, Math.round(Math.log2(size / 128)));
        const d = new SamDisk(Math.min(cyls, MAX_CYLS), heads);
        for (let h = 0; h < heads; h++)
            for (let c = 0; c < Math.min(cyls, MAX_CYLS); c++)
                for (let s = 1; s <= sectors; s++) {
                    const o = 22 + ((h * cyls + c) * sectors + (s - 1)) * size;
                    d.track(c, h).push({ id: { cyl: c, head: h, sector: s, size: code }, idCrcError: false,
                        dataStatus: 0, data: b.slice(o, o + size) });
                }
        return d;
    }

    static fromEdsk(b) {
        const img = DSKLoader.parse(b);
        const d = new SamDisk(Math.min(img.numTracks, MAX_CYLS), Math.min(img.numSides, HEADS));
        for (let c = 0; c < d.cyls; c++)
            for (let h = 0; h < d.heads; h++) {
                const tr = img.getTrack(c, h);
                if (!tr) continue;
                for (const s of tr.sectors) {
                    let status = 0;
                    if (s.st2 & ST2_DATA_NOT_FOUND) status |= RECORD_NOT_FOUND;
                    if (s.st2 & ST2_CRC) status |= CRC_ERROR;
                    if (s.st2 & ST2_CONTROL_MARK) status |= DELETED_DATA;
                    const data = new Uint8Array(sizeFromCode(s.sizeCode));
                    data.set(s.data.subarray(0, data.length));
                    d.track(c, h).push({ id: { cyl: s.cylinder, head: s.head, sector: s.id, size: s.sizeCode },
                        idCrcError: !!(s.st1 & ST1_CRC), dataStatus: status, data });
                }
            }
        return d;
    }

    // ---- saving ----
    // A plain disk saves as an MGT, anything else as an EDSK
    isPlain() {
        for (let c = 0; c < CYLS; c++)
            for (let h = 0; h < HEADS; h++) {
                const t = this.track(c, h);
                if (t.length !== SECTORS) return false;
                const seen = new Set();
                for (const s of t) {
                    if (s.id.size !== 2 || s.id.cyl !== c || s.id.sector < 1 || s.id.sector > SECTORS ||
                        s.idCrcError || s.dataStatus) return false;
                    seen.add(s.id.sector);
                }
                if (seen.size !== SECTORS) return false;
            }
        for (let c = CYLS; c < MAX_CYLS; c++) if (this.track(c, 0).length || this.track(c, 1).length) return false;
        return true;
    }

    toFile() {
        if (this.isPlain()) {
            const out = new Uint8Array(MGT_SIZE);
            for (let c = 0; c < CYLS; c++)
                for (let h = 0; h < HEADS; h++)
                    for (const s of this.track(c, h)) out.set(s.data, mgtOffset(c, h, s.id.sector));
            return { data: out, ext: 'mgt' };
        }
        return { data: this.toEdsk(), ext: 'dsk' };
    }

    toEdsk() {
        const parts = [];
        const head = new Uint8Array(256);
        const text = (arr, at, s) => { for (let i = 0; i < s.length; i++) arr[at + i] = s.charCodeAt(i); };
        text(head, 0, 'EXTENDED CPC DSK File\r\nDisk-Info\r\n');
        text(head, 0x22, 'ZX-M8XXX SAM ');
        head[0x30] = this.cyls; head[0x31] = this.heads;
        parts.push(head);
        for (let c = 0; c < this.cyls; c++)
            for (let h = 0; h < this.heads; h++) {
                const t = this.track(c, h);
                if (!t.length) continue;
                const dataLen = t.reduce((n, s) => n + s.data.length, 0);
                const blocks = Math.ceil((256 + dataLen) / 256);
                head[0x34 + c * this.heads + h] = blocks;
                const tr = new Uint8Array(blocks * 256);
                text(tr, 0, 'Track-Info\r\n');
                tr[0x10] = c; tr[0x11] = h; tr[0x14] = 2; tr[0x15] = t.length; tr[0x16] = 0x4E; tr[0x17] = 0xE5;
                let o = 256;
                t.forEach((s, i) => {
                    const e = 0x18 + i * 8;
                    tr[e] = s.id.cyl; tr[e + 1] = s.id.head; tr[e + 2] = s.id.sector; tr[e + 3] = s.id.size;
                    tr[e + 4] = s.idCrcError ? ST1_CRC : 0;
                    tr[e + 5] = ((s.dataStatus & RECORD_NOT_FOUND) ? ST2_DATA_NOT_FOUND : 0) |
                        ((s.dataStatus & CRC_ERROR) ? ST2_CRC : 0) | ((s.dataStatus & DELETED_DATA) ? ST2_CONTROL_MARK : 0);
                    tr[e + 6] = s.data.length & 0xFF; tr[e + 7] = s.data.length >> 8;
                    tr.set(s.data, o); o += s.data.length;
                });
                parts.push(tr);
            }
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    }
}

function gunzip(bytes) {
    const pako = globalThis.pako;
    if (!pako) throw new Error('gzip: pako is not loaded');
    return pako.ungzip(bytes);
}

// Any SAM image into a disk
export function loadSamDisk(data) {
    let b = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (b[0] === 0x1F && b[1] === 0x8B) b = gunzip(b);

    if (b.length === MGT_SIZE || b.length === MGT_SIZE * 9 / 10) return SamDisk.fromMgt(b);
    if (String.fromCharCode(...b.subarray(0, 18)) === "Aley's disk backup") return SamDisk.fromSad(b);
    if (DSKLoader.isDSK(b)) {
        const img = DSKLoader.parse(b);
        // A +3 / CPC disk (sectors from #41 / #C1, or 9 a track on one side
        // of 40 tracks) is not the SAM's: say where it belongs
        const t0 = img.getTrack(0, 0);
        const ids = t0 ? t0.sectors.map(s => s.id) : [];
        if (ids.length && (ids.some(id => id >= 0x41) || (img.numSides === 1 && img.numTracks <= 42 && ids.length === 9))) {
            throw new Error('a +3 / CPC disk, not a SAM one: open it in the Spectrum (+3)');
        }
        return SamDisk.fromEdsk(b);
    }
    throw new Error(`not a SAM disk image (${b.length} bytes)`);
}

// ---- a DOS for disks without one ----
// SAMDOS lives in track 4, sector 1: "BOOT" at byte 256 of it, which is what
// the ROM's BOOT looks for
export function hasDos(disk) {
    const s = disk.sectorById(4, 0, 1);
    return !!s && s.length > 260 && [0x42, 0x4F, 0x4F, 0x54].every((c, i) => (s[256 + i] & 0x5F) === c);
}

// ---- Pro-DOS: CP/M 2.2 for the SAM (Chris Pile, Digital Reality 1991) ----
// It boots from a SAMDOS disk with its code on it ("procode" for 1.9,
// "Pro-DOS-v2" for 2), then works with Pro-DOS disks: CP/M disks of
// 80 x 2 x 9 sectors whose first sector says "SAM Coupe Pro-Dos." or
// "SAM Coupe Pro-DOS" (the FDOS library disks, games released as .cpm).
const text = (b, from, to) => String.fromCharCode(...b.subarray(from, to));

export function isProDosDisk(disk) {
    const s = disk.sectorById(0, 0, 1);
    return !!s && s.length >= 34 && text(s, 16, 33).toLowerCase() === 'sam coupe pro-dos' && !hasDos(disk);
}

// Which Pro-DOS a system disk boots: 1 (1.9: it asks for a Pro-DOS disk in
// A: and SPACE), 2 (2.0: A: is a RAM drive, drive 1 is B:), or 0 if the
// disk is none. Found by its SAMDOS directory (tracks 0-3, two 256-byte
// entries a sector).
export function proDosSystem(disk) {
    if (!hasDos(disk)) return 0;
    for (let c = 0; c < 4; c++) {
        for (let n = 1; n <= 10; n++) {
            const s = disk.sectorById(c, 0, n);
            if (!s) continue;
            for (let e = 0; e + 11 <= s.length; e += 256) {
                const name = s[e] ? text(s, e + 1, e + 11).toLowerCase() : '';
                if (name.startsWith('procode')) return 1;
                if (name.startsWith('pro-dos')) return 2;
            }
        }
    }
    return 0;
}

// a file on a Pro-DOS disk, by its CP/M directory entry (a user number,
// then the name and type padded with spaces) in the first tracks
export function cpmHasFile(disk, name, type) {
    const want = [...(name.padEnd(8) + type.padEnd(3)).toUpperCase()].map(c => c.charCodeAt(0));
    for (let c = 0; c < 4; c++) {
        for (let h = 0; h < 2; h++) {
            for (const sec of disk.track(c, h) || []) {
                const d = sec.data;
                for (let e = 0; e + 32 <= d.length; e += 32) {
                    if (d[e] <= 15 && want.every((b, k) => (d[e + 1 + k] & 0x7F) === b)) return true;
                }
            }
        }
    }
    return false;
}

export function isProDosSystem(disk) { return proDosSystem(disk) > 0; }

// A disk holding one CODE file at #8000, as SimCoupe makes one from a .sbt
// (Disk.cpp FileDisk): a directory entry "autoExec", the file from track 4
// on, each sector 510 bytes of it and the next track / sector. Returns the
// disk and where its last sector is.
export function makeFileDisk(code) {
    const size = code.length;
    const data = new Uint8Array(9 + size);
    data.set([19, size & 0xFF, (size >> 8) & 0x3F, 0x00, 0x80, 0xFF, 0xFF, (size >> 14) & 0x1F, 0x01]);
    data.set(code, 9);
    const out = new Uint8Array(MGT_SIZE);
    const sectors = Math.ceil(data.length / 510);
    out[0] = 19;
    'autoExec  '.split('').forEach((c, i) => { out[1 + i] = c.charCodeAt(0); });
    out[11] = sectors >> 8; out[12] = sectors & 0xFF;
    out[13] = 4; out[14] = 1;
    out.fill(0xFF, 15, 15 + (sectors >> 3));
    if (sectors & 7) out[15 + (sectors >> 3)] = (1 << (sectors & 7)) - 1;
    out[236] = data[8]; out[237] = data[3]; out[238] = data[4];
    out[239] = data[7]; out[240] = data[1]; out[241] = data[2];
    out[242] = 2; out[243] = data[3]; out[244] = data[4];
    let cyl = 4, sec = 1, last = null;
    for (let n = 0; n < sectors; n++) {
        const o = mgtOffset(cyl, 0, sec);
        out.set(data.subarray(n * 510, n * 510 + 510), o);
        last = { track: cyl, sector: sec };
        sec++;
        if (sec > SECTORS) { sec = 1; cyl++; }
        if (n < sectors - 1) { out[o + 510] = cyl; out[o + 511] = sec; }
    }
    return { disk: SamDisk.fromMgt(out), last };
}
