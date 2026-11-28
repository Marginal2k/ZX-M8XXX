// sam-utils.js — the SAM page's Utils tab: the main page's tools that are
// not a Spectrum's, on the SAM's memory, and an Info page of the SAM's own.
//
//   Explorer  ui/explorer.js as it is: a file browser (TAP, TZX, TRD, SCL,
//             DSK, MGT with SAMDOS files, SNA, Z80, SZX, RZX, ZIP...)
//   GFX       ui/graphics-viewer.js on the SAM's memory: the CPU's 64K, or
//             one of its 32 pages
//   OCR       ui/text-ripper.js likewise
//   Info      the SAM's ports, paging registers, screen modes and timings
//
// The markup is the main page's (html/tools/*.html, and the OCR extract
// dialog from html/dialogs.html), spliced in as ui/boot.js splices it. Not
// here: Compare, Tests, Export/Import and Mapper, which work on a
// Spectrum's state and the main debugger's own managers.

import { DSKLoader } from '../core/fdc.js';
import { Disassembler } from '../core/disasm.js';
import { SZXLoader } from '../core/loaders/szx.js';
import { RZXLoader } from '../core/loaders/rzx.js';
import { ZipLoader } from '../core/loaders/zip.js';
import { downloadFile } from '../core/utils.js';

const h2 = (v) => (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');

async function spliceAll(root) {
    for (let depth = 0; depth < 4; depth++) {
        const slots = [...root.querySelectorAll('[data-include]')];
        if (!slots.length) return;
        const parts = await Promise.all(slots.map(el => fetch(el.getAttribute('data-include'), { cache: 'no-cache' })
            .then(r => { if (!r.ok) throw new Error(el.getAttribute('data-include') + ': ' + r.status); return r.text(); })));
        slots.forEach((el, i) => { el.outerHTML = parts[i]; });
    }
}

// The OCR extract dialog lives with the other dialogs; take just it
async function addOcrDialog() {
    if (document.getElementById('ocrExtractDialog')) return;
    const r = await fetch('html/dialogs.html', { cache: 'no-cache' });
    if (!r.ok) return;
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    const d = doc.getElementById('ocrExtractDialog');
    if (d) document.body.appendChild(document.importNode(d, true));
}

function infoHtml(ports) {
    const row = (...c) => `<tr>${c.map(x => `<td>${x}</td>`).join('')}</tr>`;
    const portRows = ports.map(([p, r, w]) => row(p, r || '', w || '')).join('');
    return `
<div class="info-tab-content sam-info" style="padding:6px;font-size:12px;line-height:1.5">
  <div class="info-section"><h4>Memory and paging</h4>
    <p>512K in 32 pages of 16K (0-31), a 32K ROM (ROM0, ROM1), external memory on HMPR bit 7.
       The 64K is four sections: A 0000, B 4000, C 8000, D C000.</p>
    <table class="info-table"><tr><th>Port</th><th>Register</th><th>Bits</th></tr>
      ${row('250 (FA)', 'LMPR', '0-4 page of A (B gets the next); 5 RAM in A (else ROM0); 6 ROM1 in D; 7 A write-protected')}
      ${row('251 (FB)', 'HMPR', '0-4 page of C (D gets the next); 5-6 mode 3 colours (CLUT +0/4/8/12); 7 external memory in C/D')}
      ${row('252 (FC)', 'VMPR', '0-4 screen page (modes 3-4: the even one and the next); 5-6 mode 1-4; 7 MIDI in (read)')}
      ${row('128 / 129', 'LEPR / HEPR', 'the external pages for C and D')}
    </table></div>
  <div class="info-section"><h4>Screen modes</h4>
    <table class="info-table"><tr><th>Mode</th><th>Size</th><th>Layout</th></tr>
      ${row('1', '256x192, 8x8 attributes', 'the Spectrum\'s: 6144 bytes of pixels in thirds, 768 of attributes')}
      ${row('2', '256x192, 8x1 attributes', 'pixels linear, 32 bytes a line; attributes at +2000')}
      ${row('3', '512x192, 4 colours', '2 bits a pixel, 128 bytes a line, 24K')}
      ${row('4', '256x192, 16 colours', '4 bits a pixel, 128 bytes a line, 24K')}
    </table>
    <p>Colours: a CLUT of 16 entries from 128 (port 248, the entry in A8-A11; colour bits G1 R1 B1 BRIGHT G0 R0 B0).
       Border: port 254 bits 0-2 and 5; bit 7 switches the screen off in modes 3-4.</p></div>
  <div class="info-section"><h4>Timing and interrupts</h4>
    <p>Z80B at 6 MHz. A frame is 312 lines of 384 T-states (119,808 T, 50.08 Hz); the screen is lines 68-259.
       Interrupts (IM 1, status port 249, active low for 128 T): frame (bit 3) at the start of the frame,
       line (bit 0) for the line set on port 249 (0-191, 255 none), at the start of the right border of the line above it.
       Memory waits: RAM only, a slot every 8 T while the screen is fetched (in mode 1 also in a band of each line),
       every 4 otherwise; ports 248-255 wait for a slot of 8.</p></div>
  <div class="info-section"><h4>Ports</h4>
    <table class="info-table"><tr><th>Port</th><th>Read</th><th>Write</th></tr>${portRows}</table>
    <p>Keyboard: port 254 with the row in A8-A15 as on the Spectrum (bits 0-4), the extra keys in bits 5-7 of
       port 249; A8-A15 all high reads the cursor row (CNTRL, UP, DOWN, LEFT, RIGHT) and the mouse.
       Disks: drive 1 at 224-231, drive 2 at 240-247 (A0-A1 the VL1772 register, A2 the side).
       SAA1099: 511 (1FF) the register, 255 (FF) the data.</p></div>
</div>`;
}

export async function createSamUtils({ root, machine: m, getDebugger, symbols, say }) {
    root.innerHTML = `
      <div class="tools-subtab-bar">
        <button class="tools-subtab-btn active" data-toolstab="explorer">Explorer</button>
        <button class="tools-subtab-btn" data-toolstab="graphics">GFX</button>
        <button class="tools-subtab-btn" data-toolstab="ocr">OCR</button>
        <button class="tools-subtab-btn" data-toolstab="saminfo">Info</button>
      </div>
      <div data-include="html/tools/explorer.html"></div>
      <div data-include="html/tools/graphics.html"></div>
      <div data-include="html/tools/ocr.html"></div>
      <div class="tools-subtab-content" id="tools-saminfo"></div>`;
    await spliceAll(root);
    await addOcrDialog();

    // the SAM's ports, from the symbol map
    const ports = [];
    if (symbols) {
        const all = new Set([...symbols.portsIn.keys(), ...symbols.portsOut.keys()]);
        for (const p of [...all].sort((a, b) => a - b)) {
            const r = symbols.portsIn.get(p), w = symbols.portsOut.get(p);
            ports.push([`${p} (${h2(p)})`, r, w && w !== r ? w : (r ? r : w)]);
        }
    }
    document.getElementById('tools-saminfo').innerHTML = infoHtml(ports);

    // the SAM's memory, as the tools want it
    const peek = (a) => { const s = m._suppressWatchpoints; m._suppressWatchpoints = true; const v = m.read(a & 0xFFFF); m._suppressWatchpoints = s; return v; };
    const getRAMPage = (p) => m.ram.subarray((p & 31) << 14, ((p & 31) + 1) << 14);
    const getMemoryInfo = () => ({ machineType: 'sam', currentRomBank: 0, currentRamBank: m.hmpr & 0x1F, ramPages: 32 });
    const regions = new Map();
    const showMessage = (text) => say?.(text);
    const dbg = () => getDebugger?.();

    let gfx = null, ocr = null, explorer = false;
    const ensure = async (tab) => {
        if (tab === 'explorer' && !explorer) {
            explorer = true;
            const { initExplorer } = await import('./explorer.js');
            let charset = null;
            try { const r = await fetch('roms/48.rom'); if (r.ok) charset = new Uint8Array(await r.arrayBuffer()).subarray(0x3D00, 0x3D00 + 768); } catch (e) { /* none */ }
            initExplorer({
                DSKLoader, Disassembler, SZXLoader, RZXLoader, ZipLoader, pako: window.pako,
                getPalette: () => null, getRomLabels: () => ({}), getZxCharset: () => charset,
            });
        }
        if (tab === 'ocr' && !ocr) {
            const { initTextRipper } = await import('./text-ripper.js');
            ocr = initTextRipper({ readMemory: peek, getRAMPage, showMessage, downloadFile });
        }
        if (tab === 'graphics' && !gfx) {
            const { initGraphicsViewer } = await import('./graphics-viewer.js');
            gfx = initGraphicsViewer({
                readMemory: peek, getMemoryInfo, getRAMPage,
                getRegion: (a) => regions.get(a) || null,
                addRegion: (r) => { for (let a = r.start; a <= r.end; a++) regions.set(a, r); },
                getAllRegions: () => [...new Set(regions.values())],
                isRunning: () => false,
                showMessage,
                goToAddress: (a) => dbg()?.goToAddress(a),
                goToMemoryAddress: (a) => dbg()?.goToMemoryAddress(a),
                updateDebugger: () => dbg()?.refresh(),
                openOcrExtractDialog: async (addr, bank) => { await ensure('ocr'); ocr?.openExtractDialog(addr, bank); },
            });
            gfx.updateGraphicsViewer();
        }
        if (tab === 'graphics' && gfx) gfx.updateGraphicsViewer();
    };

    const show = async (tab) => {
        for (const b of root.querySelectorAll('.tools-subtab-btn')) b.classList.toggle('active', b.dataset.toolstab === tab);
        for (const c of root.querySelectorAll('.tools-subtab-content')) c.classList.toggle('active', c.id === 'tools-' + tab);
        try { localStorage.setItem('zxm8-sam-utils-tab', tab); } catch (e) { /* not kept */ }
        await ensure(tab);
    };
    root.querySelector('.tools-subtab-bar').addEventListener('click', (e) => {
        const b = e.target.closest('.tools-subtab-btn');
        if (b) show(b.dataset.toolstab);
    });
    let t0 = 'explorer';
    try { t0 = localStorage.getItem('zxm8-sam-utils-tab') || 'explorer'; } catch (e) { /* none */ }
    await show(['explorer', 'graphics', 'ocr', 'saminfo'].includes(t0) ? t0 : 'explorer');

    return { show, refresh: () => { if (gfx) gfx.updateGraphicsViewer(); } };
}
