/**
 * ZX-M8XXX - SAM Coupé disk images
 * @license GPL-3.0
 *
 * Every image is turned into the one layout the controller reads (core/
 * loaders/disk-mgt.js): 80 cylinders, 2 sides, 10 sectors of 512 bytes,
 * cylinder by cylinder, side 0 then side 1 (MGT).
 *
 *   MGT   819200 bytes as they are (SimCoupe's raw .dsk is the same)
 *   SAD   "Aley's disk backup", then sides, tracks, sectors, size / 64;
 *         the data side by side, track by track
 *   DSK   CPCEMU / EXTENDED with SAM's geometry (sectors 1-10 of 512)
 *   gzip  any of these packed (SimCoupe's .dsk.gz, often named .dsk)
 *
 * Disks in other formats (copy protection: other sector sizes or numbers)
 * are not read yet.
 */

import { DSKLoader } from '../fdc.js';

export const MGT_SIZE = 819200;
const TRACKS = 80, SIDES = 2, SECTORS = 10, SECTOR = 512;

const mgtOffset = (cyl, side, sec) => ((cyl * SIDES + side) * SECTORS + (sec - 1)) * SECTOR;

export function isSamDiskName(name) {
    return /\.(mgt|sad|dsk|img|cpm)(\.gz)?$/i.test(name || '');
}

function gunzip(bytes) {
    const pako = globalThis.pako;
    if (!pako) throw new Error('gzip: pako is not loaded');
    return pako.ungzip(bytes);
}

export function toMgt(data) {
    let b = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (b[0] === 0x1F && b[1] === 0x8B) b = gunzip(b);

    if (b.length === MGT_SIZE) return b.slice();

    const sig = String.fromCharCode(...b.subarray(0, 18));
    if (sig === "Aley's disk backup") {
        const sides = b[18], tracks = b[19], sectors = b[20], size = b[21] * 64;
        if (size !== SECTOR || sectors !== SECTORS || sides > SIDES || tracks > TRACKS) {
            throw new Error(`SAD: ${sides} sides, ${tracks} tracks, ${sectors} sectors of ${size} not supported yet`);
        }
        const out = new Uint8Array(MGT_SIZE);
        for (let side = 0; side < sides; side++)
            for (let t = 0; t < tracks; t++)
                for (let s = 1; s <= sectors; s++) {
                    const src = 22 + ((side * tracks + t) * sectors + (s - 1)) * size;
                    out.set(b.subarray(src, src + size), mgtOffset(t, side, s));
                }
        return out;
    }

    if (DSKLoader.isDSK(b)) {
        const img = DSKLoader.parse(b);
        // A +3 / CPC disk (sectors numbered from #01 with 9 a track, or from
        // #41 / #C1) is not the SAM's: say where it belongs
        const t0 = img.getTrack(0, 0);
        const ids = t0 ? t0.sectors.map(s => s.id) : [];
        if (ids.length && (ids.some(id => id >= 0x41) || (img.numSides === 1 && img.numTracks <= 42 && ids.length === 9))) {
            throw new Error('a +3 / CPC disk, not a SAM one: open it in the Spectrum (+3)');
        }
        const out = new Uint8Array(MGT_SIZE);
        for (let t = 0; t < Math.min(img.numTracks, TRACKS); t++)
            for (let side = 0; side < Math.min(img.numSides, SIDES); side++) {
                const tr = img.getTrack(t, side);
                if (!tr || !tr.sectors.length) continue;
                if (tr.sectors.length !== SECTORS) {
                    throw new Error(`DSK: track ${t} side ${side} has ${tr.sectors.length} sectors, a disk in its own format (protected?) is not supported yet`);
                }
                for (const sec of tr.sectors) {
                    if (sec.id < 1 || sec.id > SECTORS || sec.data.length !== SECTOR) {
                        throw new Error('DSK: not a standard SAM disk (protected?), not supported yet');
                    }
                    out.set(sec.data.subarray(0, SECTOR), mgtOffset(t, side, sec.id));
                }
            }
        return out;
    }

    throw new Error(`not a SAM disk image (${b.length} bytes)`);
}

// ---- a DOS for disks without one ----
// SAMDOS lives in a sector at track 4, sector 1: "BOOT" at byte 256 of it,
// which is what the ROM's BOOT looks for
export function hasDos(mgt) {
    const o = mgtOffset(4, 0, 1) + 256;
    return [0x42, 0x4F, 0x4F, 0x54].every((c, i) => (mgt[o + i] & 0x5F) === c);
}

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
    // directory
    out[0] = 19;
    'autoExec  '.split('').forEach((c, i) => { out[1 + i] = c.charCodeAt(0); });
    out[11] = sectors >> 8; out[12] = sectors & 0xFF;
    out[13] = 4; out[14] = 1;
    out.fill(0xFF, 15, 15 + (sectors >> 3));
    if (sectors & 7) out[15 + (sectors >> 3)] = (1 << (sectors & 7)) - 1;
    out[236] = data[8]; out[237] = data[3]; out[238] = data[4];
    out[239] = data[7]; out[240] = data[1]; out[241] = data[2];
    out[242] = 2; out[243] = data[3]; out[244] = data[4];
    // the file
    let cyl = 4, sec = 1, last = null;
    for (let n = 0; n < sectors; n++) {
        const o = mgtOffset(cyl, 0, sec);
        out.set(data.subarray(n * 510, n * 510 + 510), o);
        last = { track: cyl, sector: sec };
        sec++;
        if (sec > SECTORS) { sec = 1; cyl++; }
        if (n < sectors - 1) { out[o + 510] = cyl; out[o + 511] = sec; }
    }
    return { disk: out, last };
}
