// sam-debug.js — the SAM Coupé page's debugger panel.
//
// Built on what the Spectrum's debugger stands on, not on its panels: the
// Z80 disassembler (core/disasm.js) and the trigger engine
// (core/debug-triggers.js, mixed into SamCoupe). The machine stops itself:
// runFrame() returns the trigger that stopped it, and the page pauses.
//
//   createSamDebugger({ root, machine, app, symbols })
//     root     the element to build the panel in
//     machine  the SamCoupe
//     app      { pause(bool), isPaused(), draw() } from ui/sam-app.js
//     symbols  a SamSymbols (core/sam/sam-symbols.js): the ROM's, SAMDOS's
//              and the ports' names, and the user's own labels
//
// Shortcuts while the machine is paused: F5 run, F7 step into, F8 step over,
// Shift+F8 run to RET, F6 run to the cursor line. (While it runs the keys
// belong to the SAM: F7 and F8 are keys of its keypad.)

import { Disassembler } from '../core/disasm.js';
import { renderScreen, screenByteAt, screenBase, SCR_W, SCR_H } from '../core/sam/sam-screen.js';

const h2 = (v) => (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const h4 = (v) => (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const CSS = `
.sd { display:flex; flex-direction:column; gap:6px; padding:6px; overflow-x:hidden; box-sizing:border-box; font:12px/1.35 ui-monospace,Consolas,monospace;
      color:#cdd6f4; background:#181825; overflow:auto; min-width:0; }
.sd button { background:#2c2c3a; color:#cdd6f4; border:1px solid #45475a; border-radius:3px; padding:2px 7px; cursor:pointer; font:inherit; }
.sd button:hover { background:#3b3b4f; }
.sd input, .sd select { background:#11111b; color:#cdd6f4; border:1px solid #45475a; border-radius:3px; font:inherit; padding:1px 4px; }
.sd .bar { display:flex; flex-wrap:wrap; gap:4px; align-items:center; }
.sd .box { border:1px solid #313244; border-radius:4px; padding:4px 6px; }
.sd .ttl { color:#89b4fa; font-weight:bold; margin-bottom:2px; display:flex; gap:6px; align-items:center; }
.sd .regs { display:grid; grid-template-columns:repeat(4, auto); gap:1px 10px; justify-content:start; }
.sd .reg b { color:#a6adc8; font-weight:normal; display:inline-block; width:2.6em; }
.sd .reg span { cursor:text; }
.sd .reg span:hover { background:#313244; }
.sd .flags span { margin-right:4px; color:#585b70; }
.sd .flags span.on { color:#a6e3a1; }
.sd .dis div { white-space:pre; cursor:default; }
.sd .dis .g { display:inline-block; width:1.2em; color:#f38ba8; cursor:pointer; text-align:center; }
.sd .dis .g:hover { background:#45475a; }
.sd .dis .pc { background:#45475a; }
.sd .dis .cur { outline:1px dashed #89b4fa; }
.sd .dis .a { color:#89b4fa; }
.sd .dis .b { color:#6c7086; }
.sd .mem div { white-space:pre; }
.sd .mem .a { color:#89b4fa; }
.sd .mem .x span { cursor:text; }
.sd .mem .x span:hover { background:#313244; }
.sd .st { color:#f9e2af; min-height:1.3em; }
.sd .bps div { display:flex; gap:6px; align-items:center; }
.sd .bps .off { color:#585b70; text-decoration:line-through; }
.sd .note { color:#6c7086; }
.sd canvas.scr { width:100%; aspect-ratio:512 / 384; image-rendering:pixelated; background:#000; cursor:crosshair; display:block; }
.sd .dis .lbl { color:#f9e2af; }
.sd .dis .sym { color:#fab387; }
.sd .lst div { white-space:pre; cursor:pointer; }
.sd .lst div:hover { background:#313244; }
.sd .lst .int { color:#cba6f7; }
.sd .cols { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
`;

export function createSamDebugger({ root, machine: m, app, symbols = null }) {
    const sym = symbols;
    const LABELS_KEY = 'zxm8-sam-labels';
    if (sym) { try { sym.fromJSON(JSON.parse(localStorage.getItem(LABELS_KEY) || '[]')); } catch (e) { /* none kept */ } }
    const saveLabels = () => { if (sym) { try { localStorage.setItem(LABELS_KEY, JSON.stringify(sym.toJSON())); } catch (e) { /* not kept */ } } };
    m.tracking = true;                         // history and calls from now on
    const nameAt = (a, ctx) => (sym ? sym.nameAt(m, a, ctx) : null);
    // an address typed in: hex, or a name
    const parseAddr = (txt) => {
        const t = String(txt).trim();
        if (sym) { const v = sym.lookup(t); if (v) return v.addr; }
        const v = parseInt(t, 16);
        return isNaN(v) ? null : v & 0xFFFF;
    };
    if (!document.getElementById('sd-css')) {
        const st = document.createElement('style'); st.id = 'sd-css'; st.textContent = CSS; document.head.appendChild(st);
    }
    const dis = new Disassembler(m);
    // reads for the display must not set off read watchpoints
    const peek = (a) => { const s = m._suppressWatchpoints; m._suppressWatchpoints = true; const v = m.read(a & 0xFFFF); m._suppressWatchpoints = s; return v; };
    dis.read = (a) => peek(a);

    root.classList.add('sd');
    root.innerHTML = `
      <div class="bar">
        <button data-a="run" title="F5">▶ Run</button>
        <button data-a="pause">⏸ Pause</button>
        <button data-a="into" title="F7">Step</button>
        <button data-a="over" title="F8">Over</button>
        <button data-a="ret" title="Shift+F8">To RET</button>
        <button data-a="int">To INT</button>
        <button data-a="cursor" title="F6">To cursor</button>
      </div>
      <div class="st"></div>
      <div class="box"><div class="ttl">Registers</div><div class="regs"></div><div class="flags"></div></div>
      <div class="box"><div class="ttl">Paging</div><div class="pg"></div></div>
      <div class="box"><div class="ttl">Screen
          <select class="spage" title="the RAM page to show"></select>
          <select class="smode" title="the mode to show it in">
            <option value="">mode (VMPR)</option><option value="1">mode 1</option><option value="2">mode 2</option>
            <option value="3">mode 3</option><option value="4">mode 4</option>
          </select>
        </div>
        <canvas class="scr" width="512" height="192"></canvas>
        <div class="sinfo note">point at it: where each pixel comes from; click: that byte in Memory</div>
      </div>
      <div class="box"><div class="ttl">Code <input class="dgo" size="10" placeholder="addr"> <label><input type="checkbox" class="follow" checked> follow PC</label></div><div class="dis"></div></div>
      <div class="box"><div class="ttl">Memory <select class="msrc" title="what the dump shows"></select>
          <input class="mgo" size="10" placeholder="addr"></div><div class="mem"></div></div>
      <div class="cols">
        <div class="box"><div class="ttl">Stack</div><div class="stk"></div></div>
        <div class="box"><div class="ttl">Calls</div><div class="lst calls"></div></div>
      </div>
      <div class="box"><div class="ttl">History <span class="note">(last executed, newest last)</span></div><div class="lst hist"></div></div>
      <div class="box"><div class="ttl">Labels
          <label class="btnlike"><button data-a="lload">Load…</button></label>
          <button data-a="lsave">Save</button>
          <input type="file" class="lfile" hidden accept=".map,.sym,.lbl,.txt,.lst,.asm">
        </div>
        <div class="note">double-click an address in the code to name it; names work in every address field</div>
        <div class="lst labels"></div>
      </div>
      <div class="box"><div class="ttl">Breakpoints</div>
        <div class="bar">
          <select class="bt">
            <option value="exec">exec</option><option value="read">read</option><option value="write">write</option>
            <option value="rw">read/write</option><option value="port_in">port in</option><option value="port_out">port out</option>
            <option value="port_io">port in/out</option>
          </select>
          <input class="bs" size="14" placeholder="[page:]addr[-end]">
          <input class="bc" size="12" placeholder="condition">
          <button data-a="add">Add</button>
        </div>
        <div class="note">page: 0-31 RAM, R0 / R1 ROM; a name for the address. condition: A==0, HL>4000, (HL)==FF, NZ…</div>
        <div class="bps"></div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    const status = $('.st');

    let disTop = null;        // the first address shown, when not following PC
    let cursor = null;        // the line picked for "to cursor"
    let memAddr = 0x8000;
    const LINES = 22;

    // ---- registers ----
    const REGS = [
        ['AF', () => (m.cpu.a << 8) | m.cpu.f, (v) => { m.cpu.a = v >> 8; m.cpu.f = v & 0xFF; }],
        ['BC', () => (m.cpu.b << 8) | m.cpu.c, (v) => { m.cpu.b = v >> 8; m.cpu.c = v & 0xFF; }],
        ['DE', () => (m.cpu.d << 8) | m.cpu.e, (v) => { m.cpu.d = v >> 8; m.cpu.e = v & 0xFF; }],
        ['HL', () => (m.cpu.h << 8) | m.cpu.l, (v) => { m.cpu.h = v >> 8; m.cpu.l = v & 0xFF; }],
        ["AF'", () => (m.cpu.a_ << 8) | m.cpu.f_, (v) => { m.cpu.a_ = v >> 8; m.cpu.f_ = v & 0xFF; }],
        ["BC'", () => (m.cpu.b_ << 8) | m.cpu.c_, (v) => { m.cpu.b_ = v >> 8; m.cpu.c_ = v & 0xFF; }],
        ["DE'", () => (m.cpu.d_ << 8) | m.cpu.e_, (v) => { m.cpu.d_ = v >> 8; m.cpu.e_ = v & 0xFF; }],
        ["HL'", () => (m.cpu.h_ << 8) | m.cpu.l_, (v) => { m.cpu.h_ = v >> 8; m.cpu.l_ = v & 0xFF; }],
        ['IX', () => m.cpu.ix, (v) => { m.cpu.ix = v; }],
        ['IY', () => m.cpu.iy, (v) => { m.cpu.iy = v; }],
        ['SP', () => m.cpu.sp, (v) => { m.cpu.sp = v; }],
        ['PC', () => m.cpu.pc, (v) => { m.cpu.pc = v; }],
        ['IR', () => (m.cpu.i << 8) | ((m.cpu.r & 0x7F) | (m.cpu.r7 & 0x80)), (v) => { m.cpu.i = v >> 8; m.cpu.r = v & 0x7F; m.cpu.r7 = v & 0x80; }],
    ];

    function renderRegs() {
        $('.regs').innerHTML = REGS.map(([n, get], i) =>
            `<div class="reg"><b>${esc(n)}</b><span data-r="${i}">${h4(get())}</span></div>`).join('') +
            `<div class="reg"><b>IM</b>${m.cpu.im} ${m.cpu.iff1 ? 'EI' : 'DI'}${m.cpu.halted ? ' HALT' : ''}</div>`;
        const f = m.cpu.f;
        $('.flags').innerHTML = 'SZ5H3PNC'.split('').map((c, i) => `<span class="${f & (0x80 >> i) ? 'on' : ''}">${c}</span>`).join('');
    }
    $('.regs').addEventListener('dblclick', (e) => {
        const i = e.target.dataset.r;
        if (i === undefined) return;
        editInline(e.target, h4(REGS[i][1]()), (s) => {
            const v = parseInt(s, 16);
            if (!isNaN(v)) REGS[i][2](v & 0xFFFF);
        });
    });

    // ---- paging ----
    function renderPaging() {
        const p = m.getPagingState();
        const sec = p.sections.map((x, i) => `${'ABCD'[i]}:${x === null ? '—' : x}`).join('  ');
        $('.pg').innerHTML = `LMPR ${h2(p.lmpr)}  HMPR ${h2(p.hmpr)}  VMPR ${h2(p.vmpr)}  mode ${p.mode}<br>` +
            `${esc(sec)}<br>LEPR ${h2(p.lepr)}  HEPR ${h2(p.hepr)}  border ${h2(m.border)}  line int ${m.lineInt < 192 ? m.lineInt : 'off'}`;
    }

    // ---- code ----
    function renderCode() {
        const pc = m.cpu.pc;
        const follow = $('.follow').checked;
        let top = follow || disTop === null ? dis.findStartForPosition(pc, 6, LINES) : disTop;
        if (!follow && disTop === null) disTop = top;
        const lines = dis.disassembleRange(top, LINES);
        let rows = 0;
        const html = [];
        for (const l of lines) {
            if (rows >= LINES) break;
            const own = nameAt(l.addr, l.addr);
            if (own) { html.push(`<div class="lbl" data-addr="${l.addr}">${esc(own)}:</div>`); rows++; }
            const bp = m.hasBreakpoint ? m.hasBreakpoint(l.addr) : false;
            const cls = [l.addr === pc ? 'pc' : '', l.addr === cursor ? 'cur' : ''].join(' ');
            const bytes = l.bytes.map(h2).join(' ').padEnd(12);
            html.push(`<div class="${cls}" data-addr="${l.addr}"><span class="g" data-bp="${l.addr}">${bp ? '●' : ''}</span>` +
                `<span class="a" data-lbl="${l.addr}">${h4(l.addr)}</span>  <span class="b">${bytes}</span> ${operands(l)}</div>`);
            rows++;
        }
        $('.dis').innerHTML = html.join('');
    }
    // names in an instruction: a 16-bit operand that has one, and the port of IN / OUT
    function operands(l) {
        let t = esc(l.mnemonic);
        if (!sym) return t;
        t = t.replace(/\b([0-9A-F]{4})h\b/g, (w, x) => {
            const n = nameAt(parseInt(x, 16), l.addr);
            return n ? `<span class="sym" title="${w}">${esc(n)}</span>` : w;
        });
        if (/^(IN|OUT)\b/.test(l.mnemonic)) {
            t = t.replace(/\(([0-9A-F]{2})h\)/, (w, x) => {
                const n = sym.portName(parseInt(x, 16), l.mnemonic.startsWith('OUT'));
                return n ? `(<span class="sym" title="${x}h">${esc(n)}</span>)` : w;
            });
        }
        return t;
    }
    $('.dis').addEventListener('dblclick', (e) => {
        const a = e.target.dataset.lbl;
        if (a === undefined || !sym) return;
        const addr = +a;
        editInline(e.target, sym.nameAt(m, addr) || '', (name) => {
            sym.setLabel(addr, name.trim().replace(/\s+/g, '_'));
            saveLabels();
        });
    });
    $('.dis').addEventListener('click', (e) => {
        const g = e.target.closest('[data-bp]');
        if (g) { m.toggleBreakpoint(+g.dataset.bp); renderAll(); return; }
        const row = e.target.closest('[data-addr]');
        if (row) { cursor = +row.dataset.addr; renderCode(); }
    });
    $('.dis').addEventListener('wheel', (e) => {
        e.preventDefault();
        $('.follow').checked = false;
        const start = disTop === null ? dis.findStartForPosition(m.cpu.pc, 6, LINES) : disTop;
        disTop = e.deltaY > 0 ? (start + dis.disassemble(start).length) & 0xFFFF : (start - 1) & 0xFFFF;
        renderCode();
    }, { passive: false });
    $('.dgo').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const v = parseAddr(e.target.value);
        if (v === null) { say(`no such address or name: ${e.target.value}`); return; }
        $('.follow').checked = false; disTop = v; renderCode();
    });
    $('.follow').addEventListener('change', () => { disTop = null; renderCode(); });

    // ---- screen ----
    const spage = $('.spage'), smode = $('.smode');
    spage.add(new Option('page (VMPR)', ''));
    for (let i = 0; i < 32; i++) spage.add(new Option('page ' + i, String(i)));
    const scr = $('.scr'), sctx = scr.getContext('2d');
    const simg = sctx.createImageData(SCR_W, SCR_H), sbuf = new Uint32Array(simg.data.buffer);
    const shown = () => ({
        page: spage.value === '' ? m.vmpr & 0x1F : +spage.value,
        mode: smode.value === '' ? ((m.vmpr >> 5) & 3) + 1 : +smode.value,
    });
    function renderScreenBox() {
        const { page, mode } = shown();
        renderScreen(m.ram, page, mode, m.clut, (m.hmpr >> 3) & 0x0C, !!(m.frames & 16), sbuf);
        sctx.putImageData(simg, 0, 0);
    }
    const pixelAt = (e) => {
        const r = scr.getBoundingClientRect();
        const x = Math.min(SCR_W - 1, Math.max(0, Math.floor((e.clientX - r.left) * SCR_W / r.width)));
        const y = Math.min(SCR_H - 1, Math.max(0, Math.floor((e.clientY - r.top) * SCR_H / r.height)));
        const { page, mode } = shown();
        const at = screenByteAt(mode, x, y);
        const base = screenBase(page, mode);
        const abs = (base + at.offset) & (m.ram.length - 1);
        const attr = at.attr === null ? null : (base + at.attr) & (m.ram.length - 1);
        const px = mode === 3 ? x : x >> 1;
        return { x: px, y, mode, abs, attr };
    };
    const physical = (abs) => `${abs >> 14}:${h4(abs & 0x3FFF)}`;
    scr.addEventListener('mousemove', (e) => {
        const p = pixelAt(e);
        $('.sinfo').textContent = `mode ${p.mode}  x ${p.x} y ${p.y}  byte ${physical(p.abs)} = ${h2(m.ram[p.abs])}` +
            (p.attr === null ? '' : `  attr ${physical(p.attr)} = ${h2(m.ram[p.attr])}`);
    });
    scr.addEventListener('click', (e) => {
        const p = pixelAt(e);
        memSrc.value = 'r' + (p.abs >> 14);
        memAddr = p.abs & 0x3FF8;
        memMark = p.abs & 0x3FFF;
        renderMem();
    });
    spage.addEventListener('change', renderScreenBox);
    smode.addEventListener('change', renderScreenBox);

    // ---- memory: the CPU's 64K, or a page as it is ----
    const memSrc = $('.msrc');
    memSrc.add(new Option('CPU 64K', 'cpu'));
    for (let i = 0; i < 32; i++) memSrc.add(new Option('RAM page ' + i, 'r' + i));
    memSrc.add(new Option('ROM0', 'R0')); memSrc.add(new Option('ROM1', 'R1'));
    for (let i = 0; i < 64; i++) memSrc.add(new Option('ext page ' + i, 'x' + i));
    let memMark = -1;
    // the buffer, base and size of the source; null for the CPU's view
    const source = () => {
        const v = memSrc.value;
        if (v === 'cpu') return null;
        if (v[0] === 'r') return { buf: m.ram, base: +v.slice(1) << 14, ro: false };
        if (v[0] === 'R') return { buf: m.rom, base: v === 'R1' ? 0x4000 : 0, ro: true };
        return { buf: m.ext, base: +v.slice(1) << 14, ro: false };
    };
    const memRead = (a) => { const src = source(); return src ? src.buf[src.base + (a & 0x3FFF)] : peek(a); };
    const memWrite = (a, v) => {
        const src = source();
        if (!src) { m.write(a, v); return; }
        if (!src.ro) src.buf[src.base + (a & 0x3FFF)] = v;
    };
    memSrc.addEventListener('change', () => { memMark = -1; memAddr = source() ? memAddr & 0x3FF8 : memAddr; renderMem(); });

    // ---- memory ----
    function renderMem() {
        const rows = [];
        for (let r = 0; r < 16; r++) {
            const lim = source() ? 0x3FFF : 0xFFFF;
            const a = (memAddr + r * 8) & lim;
            const bytes = [], chars = [];
            for (let i = 0; i < 8; i++) {
                const v = memRead((a + i) & lim);
                const mark = ((a + i) & lim) === memMark ? ' style="background:#f9e2af;color:#11111b"' : '';
                bytes.push(`<span data-m="${(a + i) & lim}"${mark}>${h2(v)}</span>`);
                chars.push(v >= 32 && v < 127 ? esc(String.fromCharCode(v)) : '.');
            }
            rows.push(`<div><span class="a">${h4(a)}</span> <span class="x">${bytes.join(' ')}</span>  ${chars.join('')}</div>`);
        }
        $('.mem').innerHTML = rows.join('');
    }
    $('.mem').addEventListener('dblclick', (e) => {
        const a = e.target.dataset.m;
        if (a === undefined) return;
        editInline(e.target, h2(memRead(+a)), (s) => {
            const v = parseInt(s, 16);
            if (!isNaN(v)) memWrite(+a, v & 0xFF);
        });
    });
    $('.mem').addEventListener('wheel', (e) => {
        e.preventDefault();
        memAddr = (memAddr + (e.deltaY > 0 ? 8 : -8)) & (source() ? 0x3FFF : 0xFFFF);
        renderMem();
    }, { passive: false });
    $('.mgo').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const v = parseAddr(e.target.value);
        if (v === null) { say(`no such address or name: ${e.target.value}`); return; }
        memMark = -1;
        memAddr = v & (source() ? 0x3FF8 : 0xFFF8); renderMem();
    });

    // ---- stack ----
    function renderStack() {
        const sp = m.cpu.sp, out = [];
        for (let i = 0; i < 8; i++) {
            const a = (sp + i * 2) & 0xFFFF;
            const w = peek(a) | (peek(a + 1) << 8);
            const n = nameAt(w, w);
            out.push(`${h4(a)}: ${h4(w)}${n ? ' ' + esc(n) : ''}`);
        }
        $('.stk').innerHTML = out.join('<br>');
    }

    // ---- calls, history, labels ----
    const where = (a) => { const n = nameAt(a, a); return h4(a) + (n ? ' ' + esc(n) : ''); };
    function renderCalls() {
        const cs = m.callStack.slice().reverse();
        $('.calls').innerHTML = cs.length ? cs.slice(0, 12).map((c) =>
            `<div class="${c.int ? 'int' : ''}" data-go="${c.to}" title="from ${h4(c.from)}">${c.int ? 'INT ' : ''}${where(c.to)}</div>`).join('')
            : '<span class="note">none</span>';
    }
    function renderHistory() {
        const h = m.getHistory(16);
        $('.hist').innerHTML = h.length ? h.map((a) => {
            const l = dis.disassemble(a);
            return `<div data-go="${a}">${where(a).padEnd(18)} ${operands(l)}</div>`;
        }).join('') : '<span class="note">nothing yet: run or step</span>';
    }
    function renderLabels() {
        if (!sym) { $('.labels').innerHTML = '<span class="note">no symbols</span>'; return; }
        const list = sym.userLabels();
        $('.labels').innerHTML = list.length ? list.slice(0, 200).map((l) =>
            `<div data-go="${l.addr}">${h4(l.addr)}${l.page !== null ? ' (' + esc(l.page) + ')' : ''} ${esc(l.name)} <button data-unlabel="${l.addr}" data-page="${l.page ?? ''}">✕</button></div>`).join('')
            : '<span class="note">none of your own yet (the ROM\'s and SAMDOS\'s are built in)</span>';
    }
    root.addEventListener('click', (e) => {
        const un = e.target.dataset.unlabel;
        if (un !== undefined) {
            const pg = e.target.dataset.page;
            sym.setLabel(+un, '', pg === '' ? null : (isNaN(+pg) ? pg : +pg));
            saveLabels(); renderAll(); return;
        }
        const go = e.target.closest('[data-go]');
        if (go && root.contains(go)) { $('.follow').checked = false; disTop = +go.dataset.go; cursor = +go.dataset.go; renderCode(); }
    });
    $('.lfile').addEventListener('change', async () => {
        const f = $('.lfile').files[0];
        if (!f || !sym) return;
        const n = sym.loadUserLabels(await f.text());
        saveLabels();
        say(`${n} labels from ${f.name}`);
        $('.lfile').value = '';
        renderAll();
    });

    // ---- breakpoints ----
    function renderBps() {
        const list = m.getTriggers();
        $('.bps').innerHTML = list.length ? list.map((t, i) =>
            `<div><input type="checkbox" data-en="${i}" ${t.enabled ? 'checked' : ''}>` +
            `<span class="${t.enabled ? '' : 'off'}">${esc(t.type)} ${esc(m.formatTrigger(t))} · ${t.hitCount} hits</span>` +
            `<button data-del="${i}">✕</button></div>`).join('') : '<span class="note">none: click left of a code line, or add one here</span>';
    }
    $('.bps').addEventListener('click', (e) => {
        if (e.target.dataset.del !== undefined) { m.removeTrigger(+e.target.dataset.del); renderAll(); }
        if (e.target.dataset.en !== undefined) { m.toggleTrigger(+e.target.dataset.en); renderAll(); }
    });
    function addBreakpoint() {
        const type = $('.bt').value, spec = $('.bs').value.trim(), cond = $('.bc').value.trim();
        if (!spec) return;
        let t;
        if (type.startsWith('port')) {
            const p = m.parsePortSpec(spec);
            if (!p) { say(`not a port: ${spec}`); return; }
            t = { type, start: p.port, end: p.port, mask: p.mask, condition: cond };
        } else {
            const a = m.parseAddressSpec(sym ? sym.resolveSpec(spec) : spec);
            if (!a) { say(`not an address: ${spec} (page 0-31 or R0 / R1, or a name)`); return; }
            t = { type, start: a.start, end: a.end, page: a.page, condition: cond };
        }
        if (m.addTrigger(t) < 0) say('that one is there already');
        $('.bs').value = ''; $('.bc').value = '';
        renderAll();
    }

    // ---- running ----
    function say(s) { status.textContent = s; }
    function describe(hit) {
        if (!hit) return '';
        if (hit.type === 'exec') return `breakpoint at ${h4(hit.addr)}`;
        if (hit.type === 'read' || hit.type === 'write') return `${hit.type} ${h2(hit.val)} at ${h4(hit.addr)} by ${h4(hit.instrPC)}`;
        if (hit.direction) return `port ${hit.direction.toUpperCase()} ${h4(hit.port)}${hit.val !== undefined && hit.direction === 'out' ? ' = ' + h2(hit.val) : ''}`;
        if (hit.type === 'timeout') return 'gave up: it did not get there';
        return '';
    }
    function after(r) {
        app.draw();
        const text = describe(r);
        const n = nameAt(m.cpu.pc, m.cpu.pc);
        say((text || (app.isPaused() ? 'paused' : '')) + (n && app.isPaused() ? ` · PC in ${n}` : ''));
        renderAll();
    }
    const act = {
        run: () => { say(''); app.pause(false); },
        pause: () => { app.pause(true); after(null); },
        into: () => { app.pause(true); after(m.stepInto()); },
        over: () => { app.pause(true); after(m.stepOver()); },
        ret: () => { app.pause(true); after(m.runToRet()); },
        int: () => { app.pause(true); after(m.runToInterrupt()); },
        cursor: () => { if (cursor === null) { say('pick a line in the code first'); return; } app.pause(true); after(m.runToAddress(cursor)); },
        add: addBreakpoint,
        lload: () => $('.lfile').click(),
        lsave: () => {
            if (!sym) return;
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([sym.exportMap()], { type: 'text/plain' }));
            a.download = 'labels.map';
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        },
    };
    root.addEventListener('click', (e) => { const a = e.target.dataset.a; if (a && act[a]) act[a](); });
    $('.bs').addEventListener('keydown', (e) => { if (e.key === 'Enter') addBreakpoint(); });
    $('.bc').addEventListener('keydown', (e) => { if (e.key === 'Enter') addBreakpoint(); });

    window.addEventListener('keydown', (e) => {
        if (!app.isPaused() || e.target.closest?.('input, select')) return;
        const k = e.key;
        const fn = k === 'F5' ? act.run : k === 'F7' ? act.into : k === 'F8' ? (e.shiftKey ? act.ret : act.over) : k === 'F6' ? act.cursor : null;
        if (fn) { e.preventDefault(); e.stopImmediatePropagation(); fn(); }
    }, true);

    function editInline(el, value, done) {
        const inp = document.createElement('input');
        inp.value = value; inp.size = value.length + 1;
        el.replaceWith(inp); inp.focus(); inp.select();
        const finish = (ok) => { if (ok) done(inp.value); renderAll(); };
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); e.stopPropagation(); });
        inp.addEventListener('blur', () => finish(false));
    }

    function renderAll() {
        renderRegs(); renderPaging(); renderScreenBox(); renderCode(); renderMem(); renderStack(); renderCalls(); renderHistory();
        renderLabels(); renderBps();
    }

    renderAll();
    return {
        // the page calls this when a frame stopped on a trigger
        onBreak(hit) { after(hit); },
        refresh: renderAll,
        say,
    };
}
