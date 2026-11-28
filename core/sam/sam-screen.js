/**
 * ZX-M8XXX - SAM Coupé: a screen out of any RAM page, for the debugger
 * @license GPL-3.0
 *
 * The four modes as the ASIC fetches them (core/sam/sam.js draws the live
 * picture beam by beam; this draws what a page holds, at once):
 *
 *   mode 1  the Spectrum's layout: 6144 bytes of pixels in thirds, 768 of
 *           attributes after them (8x8 cells)
 *   mode 2  pixels a line after another, 32 bytes a line; attributes at
 *           #2000, one a byte (8x1 cells)
 *   mode 3  512x192, 2 bits a pixel, 128 bytes a line; the colours are CLUT
 *           entries 0-3 plus HMPR bits 5-6 (x4)
 *   mode 4  256x192, 4 bits a pixel, 128 bytes a line
 *
 * Modes 3 and 4 take 24K, so two pages: the even one the VMPR names, and the
 * next. The output is always 512 x 192 (modes 1, 2, 4 have each pixel twice).
 *
 * The colours: one CLUT for the whole screen, or one a line (lineClut and
 * lineMd3, as the machine records them while the beam draws) for a program
 * that changes the palette on line interrupts.
 */

import { PALETTE } from './sam.js';

export const SCR_W = 512, SCR_H = 192;

// page: the RAM page (modes 3-4 use page & 0x1E); mode: 1-4
export function screenBase(page, mode) {
    return (mode >= 3 ? page & 0x1E : page & 0x1F) << 14;
}

// Where in RAM the byte behind a pixel is, and its attribute in modes 1-2.
// x 0-511, y 0-191. Returns { offset, attr } (offsets from screenBase).
export function screenByteAt(mode, x, y) {
    if (mode === 1) {
        const cx = x >> 4;
        return { offset: ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | cx, attr: 0x1800 + ((y >> 3) << 5) + cx };
    }
    if (mode === 2) {
        const cx = x >> 4;
        return { offset: (y << 5) + cx, attr: 0x2000 + (y << 5) + cx };
    }
    if (mode === 3) return { offset: y * 128 + (x >> 2), attr: null };
    return { offset: y * 128 + (x >> 2), attr: null };       // mode 4: x>>1 pixel, 2 a byte
}

/**
 * Draw a page into out (Uint32Array, 512 x 192)
 * @param {Uint8Array} ram   the SAM's 512K
 * @param {number} page      RAM page
 * @param {number} mode      1-4
 * @param {Uint8Array} clut  16 entries of the 128 colours
 * @param {number} md3       HMPR bits 5-6 as a CLUT offset for mode 3 (0, 4, 8, 12)
 * @param {boolean} flash    the flash phase for modes 1-2
 * @param {Uint8Array[]} [lineClut]  a CLUT for each line, in place of clut
 * @param {Uint8Array} [lineMd3]     and HMPR's mode 3 colours for each
 */
export function renderScreen(ram, page, mode, clut, md3, flash, out, lineClut = null, lineMd3 = null) {
    const base = screenBase(page, mode), mask = ram.length - 1;
    let lc = clut;
    const col = (i) => PALETTE[lc[i & 15]];
    let p = 0;
    for (let y = 0; y < SCR_H; y++) {
        if (lineClut) { lc = lineClut[y]; if (lineMd3) md3 = lineMd3[y]; }
        if (mode <= 2) {
            for (let cx = 0; cx < 32; cx++) {
                const at = screenByteAt(mode, cx << 4, y);
                const pix = ram[(base + at.offset) & mask], attr = ram[(base + at.attr) & mask];
                const br = (attr >> 3) & 8;
                let ink = col((attr & 7) | br), paper = col(((attr >> 3) & 7) | br);
                if ((attr & 0x80) && flash) { const t = ink; ink = paper; paper = t; }
                for (let b = 0x80; b; b >>= 1) { const c = (pix & b) ? ink : paper; out[p++] = c; out[p++] = c; }
            }
        } else if (mode === 3) {
            const a = base + y * 128;
            for (let i = 0; i < 128; i++) {
                const v = ram[(a + i) & mask];
                out[p++] = col((v >> 6) | md3); out[p++] = col(((v >> 4) & 3) | md3);
                out[p++] = col(((v >> 2) & 3) | md3); out[p++] = col((v & 3) | md3);
            }
        } else {
            const a = base + y * 128;
            for (let i = 0; i < 128; i++) {
                const v = ram[(a + i) & mask];
                const c1 = col(v >> 4), c2 = col(v & 15);
                out[p++] = c1; out[p++] = c1; out[p++] = c2; out[p++] = c2;
            }
        }
    }
    return out;
}
