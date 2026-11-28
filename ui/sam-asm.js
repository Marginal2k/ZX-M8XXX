// sam-asm.js — the SAM debugger's assembler box: sjasmplus (the app's JS
// port, sjasmplus/) straight into the SAM's memory.
//
//   no DEVICE              ORG and the code go into the 64K the CPU sees now
//                          (whatever LMPR / HMPR have paged in)
//   DEVICE ZXSPECTRUM512   its 32 pages of 16K are the SAM's 32: PAGE / SLOT
//                          put code in any of them; the pages the source
//                          wrote to, byte by byte (not what sjasmplus
//                          fills itself for a Spectrum: its screen
//                          attributes and system variables)
//
// The labels go into the debugger as the user's own (replacing the ones the
// last assembly gave). "Assemble & run" sets PC to the label START (any case)
// or else to the first ORG, and runs.

import { Assembler } from '../sjasmplus/assembler.js';
import { AsmMemory } from '../sjasmplus/memory.js';

const KEY = 'zxm8-sam-asm-source';
const SAMPLE = `; SAM Coupé: flash the border
        org 32768
start:  di
        ld b,0
loop:   ld a,b
        and 7
        out (254),a
        djnz loop
        ei
        ret
`;

export function createSamAssembler({ root, machine: m, symbols, onDone, say }) {
    root.innerHTML = `
      <div class="bar">
        <button data-x="asm">Assemble</button>
        <button data-x="run">Assemble &amp; run</button>
        <button data-x="load">Load…</button>
        <input type="file" class="afile" hidden accept=".asm,.a80,.s,.z80,.txt,.inc">
      </div>
      <textarea class="asrc" spellcheck="false" rows="14"></textarea>
      <div class="aout note"></div>`;
    const $ = (s) => root.querySelector(s);
    const src = $('.asrc'), out = $('.aout');
    try { src.value = localStorage.getItem(KEY) || SAMPLE; } catch (e) { src.value = SAMPLE; }
    src.addEventListener('input', () => { try { localStorage.setItem(KEY, src.value); } catch (e) { /* not kept */ } });
    // Tab in the source is a tab, not a jump out of it
    src.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Tab') {
            e.preventDefault();
            const p = src.selectionStart;
            src.setRangeText('\t', p, src.selectionEnd, 'end');
        }
    });

    let lastLabels = [];
    const h4 = (v) => (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');

    // Which pages the source writes to: AsmMemory.writeByte watched while it
    // assembles, except inside setDevice (sjasmplus's Spectrum fill)
    function assembleWatched(text) {
        const touched = new Map();            // page -> the offsets written in it
        let init = false;
        const w = AsmMemory.writeByte, sd = AsmMemory.setDevice;
        AsmMemory.writeByte = function (addr, v) {
            if (!init && this.device) {
                const loc = this.findSlot(addr);
                if (loc) {
                    if (!touched.has(loc.page)) touched.set(loc.page, new Uint8Array(this.device.pageSize));
                    touched.get(loc.page)[loc.offset] = 1;
                }
            }
            return w.call(this, addr, v);
        };
        AsmMemory.setDevice = function (name) { init = true; try { return sd.call(this, name); } finally { init = false; } };
        try {
            const r = Assembler.assemble(text, 'sam.asm', [], {});
            r.touched = touched;
            return r;
        } finally {
            AsmMemory.writeByte = w; AsmMemory.setDevice = sd;
        }
    }

    function assemble() {
        let r;
        try {
            r = assembleWatched(src.value);
        } catch (e) {
            const where = e.line ? `line ${e.line}: ` : '';
            out.innerHTML = '';
            const a = document.createElement('a');
            a.href = '#'; a.textContent = where + e.message;
            a.style.color = '#f38ba8';
            a.addEventListener('click', (ev) => { ev.preventDefault(); if (e.line) goLine(e.line); });
            out.append(a);
            return null;
        }
        let what;
        const device = AsmMemory.getDeviceName();
        if (device === 'ZXSPECTRUM512') {
            const pages = [...r.touched.keys()].filter(p => p < 32).sort((a, b) => a - b);
            for (const p of pages) {
                const data = AsmMemory.getPage(p), mask = r.touched.get(p);
                for (let i = 0; i < 0x4000; i++) if (mask[i]) m.ram[(p << 14) + i] = data[i];
            }
            what = pages.length ? `pages ${pages.join(', ')}` : 'nothing (no page written)';
        } else if (device !== 'NONE') {
            out.textContent = `DEVICE ${device}: not for the SAM; leave DEVICE out, or use ZXSPECTRUM512 (its pages are the SAM's)`;
            return null;
        } else {
            const o = r.output;
            for (let i = 0; i < o.length; i++) if (o[i] !== undefined) m.write((r.outputStart + i) & 0xFFFF, o[i] & 0xFF);
            what = o.length ? `${o.length} bytes at ${h4(r.outputStart)}-${h4(r.outputStart + o.length - 1)}` : 'no code';
        }
        // the labels, in place of the last assembly's
        if (symbols) {
            for (const n of lastLabels) symbols.setLabel(n.addr, '', null);
            lastLabels = (r.symbols || []).filter(s => !s.name.startsWith('_') && !s.name.includes('.')).map(s => ({ addr: s.value & 0xFFFF, name: s.name }));
            for (const l of lastLabels) symbols.setLabel(l.addr, l.name, null);
        }
        const warns = (r.warnings || []).filter(w => !/^Unused label/.test(w.message));
        out.textContent = `${what}, ${lastLabels.length} labels, ${r.passes} passes` +
            (warns.length ? ` · ${warns.length} warnings: ${warns.slice(0, 3).map(w => (w.line ? w.line + ': ' : '') + w.message).join('; ')}` : '');
        return r;
    }

    function goLine(n) {
        const lines = src.value.split('\n');
        let p = 0;
        for (let i = 0; i < n - 1 && i < lines.length; i++) p += lines[i].length + 1;
        src.focus();
        src.setSelectionRange(p, p + (lines[n - 1] || '').length);
    }

    function entry(r) {
        const s = (r.symbols || []).find(x => x.name.toLowerCase() === 'start');
        if (s) return s.value & 0xFFFF;
        return (r.orgAddresses && r.orgAddresses.length ? r.orgAddresses[0] : r.outputStart) & 0xFFFF;
    }

    root.addEventListener('click', (e) => {
        const x = e.target.dataset.x;
        if (x === 'asm') { if (assemble()) onDone(null); }
        if (x === 'run') {
            const r = assemble();
            if (!r) return;
            m.cpu.pc = entry(r);
            m.cpu.halted = false;
            say?.(`running from ${h4(m.cpu.pc)}`);
            onDone('run');
        }
        if (x === 'load') $('.afile').click();
    });
    $('.afile').addEventListener('change', async () => {
        const f = $('.afile').files[0];
        if (!f) return;
        src.value = await f.text();
        try { localStorage.setItem(KEY, src.value); } catch (e) { /* not kept */ }
        $('.afile').value = '';
        out.textContent = `${f.name} loaded`;
    });

    return { assemble, source: src };
}
