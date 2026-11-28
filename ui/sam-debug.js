// sam-debug.js — the SAM Coupé page's debugger.
//
// It looks like the Spectrum's (css/app.css and the same classes: the
// disassembly on the left with the step buttons under it, registers, flags,
// stack, calls and pages on the right over the memory dump, and the tabs at
// the bottom) and stands on what that one stands on: the Z80 disassembler
// (core/disasm.js) and the trigger engine (core/debug-triggers.js, mixed into
// SamCoupe). Its panels are its own, because the Spectrum's are wired to a
// Spectrum (ui/app-init.js); the SAM's paging, screen modes and symbols are
// what is different.
//
//   createSamDebugger({ root, machine, app, symbols })
//     root     the element to build it in (the Debug tab's content)
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
import { createSamAssembler } from './sam-asm.js';

const h2 = (v) => (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const h4 = (v) => (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// What the app's stylesheet has no rule for
const CSS = `
.samdbg .disasm-label-row, .samdbg .disasm-lbl { color: var(--cyan); }
.samdbg .sym { color: #f0c060; }
.samdbg .disasm-line { cursor: default; white-space: pre; }
.samdbg .disasm-line.cursor { outline: 1px dashed var(--cyan); }
.samdbg .lst .stack-entry { cursor: pointer; }
.samdbg .lst .stack-entry:hover { background: var(--bg-button); }
.samdbg .call-int { color: #c890ff; }
.samdbg .pages-sam { font-family: Consolas, Monaco, monospace; font-size: 11px; line-height: 1.45; white-space: pre; }
.samdbg canvas.scr { width: 100%; max-width: 768px; aspect-ratio: 512 / 384; image-rendering: pixelated; background: #000; cursor: crosshair; display: block; }
.samdbg textarea.asrc { width: 100%; background: var(--bg-primary); color: var(--text-primary); border: 1px solid var(--border-primary);
    border-radius: 3px; font: 12px Consolas, Monaco, monospace; tab-size: 8; resize: vertical; }
.samdbg .note { color: var(--text-secondary); font-size: 11px; }
.samdbg .status-line { color: #f0c060; font-size: 11px; min-height: 1.3em; padding: 2px 4px; }
.samdbg .memory-byte.mark { background: #f0c060; color: #111; }
.samdbg .panel-tab-content { padding: 6px; }
.samdbg .follow-label { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; white-space: nowrap; cursor: pointer; }
.samdbg .follow-label input[type=checkbox] { width: auto; min-width: 0; margin: 0; padding: 0; height: auto; }
.samdbg .memory-header select, .samdbg .memory-header input { font-size: 11px; }
`;

export function createSamDebugger({ root, machine: m, app, symbols = null }) {
    if (!document.getElementById('samdbg-css')) {
        const st = document.createElement('style'); st.id = 'samdbg-css'; st.textContent = CSS; document.head.appendChild(st);
    }
    const sym = symbols;
    const LABELS_KEY = 'zxm8-sam-labels';
    if (sym) { try { sym.fromJSON(JSON.parse(localStorage.getItem(LABELS_KEY) || '[]')); } catch (e) { /* none kept */ } }
    const saveLabels = () => { if (sym) { try { localStorage.setItem(LABELS_KEY, JSON.stringify(sym.toJSON())); } catch (e) { /* not kept */ } } };
    m.tracking = true;                         // history and calls from now on
    const nameAt = (a, ctx) => (sym ? sym.nameAt(m, a, ctx) : null);
    const parseAddr = (txt) => {
        const t = String(txt).trim().replace(/^\$|^#|^0x/i, '');
        if (sym) { const v = sym.lookup(t); if (v) return v.addr; }
        const v = parseInt(t.replace(/h$/i, ''), 16);
        return isNaN(v) ? null : v & 0xFFFF;
    };

    const dis = new Disassembler(m);
    const peek = (a) => { const s = m._suppressWatchpoints; m._suppressWatchpoints = true; const v = m.read(a & 0xFFFF); m._suppressWatchpoints = s; return v; };
    dis.read = (a) => peek(a);

    root.classList.add('samdbg');
    root.innerHTML = `
<div class="debugger-container"><div class="debugger-panel open">
  <div class="main-debug-row">
    <div class="debugger-section disasm-panel">
      <div class="memory-header">
        <span class="panel-type-select" style="padding:2px 8px">Disasm</span>
        <div class="memory-controls">
          <input type="text" class="dgo" placeholder="addr / name" maxlength="24" title="An address (hex) or a name; Enter to go">
          <button data-a="pcgo" title="Go to PC">PC</button>
          <label class="follow-label" title="Keep the PC in view, while it runs too"><input type="checkbox" class="follow" checked> Follow PC</label>
        </div>
      </div>
      <div class="disassembly-view dis"></div>
      <div class="status-line st"></div>
      <div class="debugger-controls">
        <button data-a="run" class="primary" title="Run (F5)">Run</button>
        <button data-a="pause" title="Pause">Pause</button>
        <button data-a="into" title="Step Into (F7)">Step Into</button>
        <button data-a="over" title="Step Over (F8)">Step Over</button>
        <button data-a="cursor" title="Run to the line picked (F6)">To Cursor</button>
        <button data-a="int" title="Run to the next interrupt">To INT</button>
        <button data-a="ret" title="Run to RET (Shift+F8)">To RET</button>
      </div>
    </div>
    <div class="right-column">
      <div class="registers-row">
        <div class="reg-group">
          <h4>Regs</h4>
          <div class="registers-grid regs-main"></div>
          <div class="registers-grid regs-alt"></div>
          <div class="registers-grid regs-ix"></div>
        </div>
        <div class="reg-group">
          <h4>System</h4>
          <div class="registers-grid regs-sys"></div>
          <div class="registers-grid regs-int"></div>
          <div class="flags-row">
            <div class="flags-block"><div class="flags-label">Flags</div><div class="flags-display flags"></div></div>
          </div>
        </div>
        <div class="stack-pages-row">
          <div class="reg-group"><h4>Stack</h4><div class="stack-view stk"></div></div>
          <div class="reg-group calls-group"><h4>Calls</h4><div class="stack-view lst calls"></div></div>
          <div class="reg-group"><h4>Pages</h4><div class="pages-sam pg"></div></div>
        </div>
      </div>
      <div class="memory-section memory-panel">
        <div class="memory-header">
          <span class="panel-type-select" style="padding:2px 8px">Memory</span>
          <div class="memory-controls">
            <select class="msrc" title="The CPU's 64K, or a page as it is"></select>
            <input type="text" class="mgo" placeholder="addr / name" maxlength="24" title="An address (hex) or a name; Enter to go">
            <button data-a="mpc">PC</button><button data-a="msp">SP</button><button data-a="mhl">HL</button>
            <button data-a="mup" title="Page up">▲</button><button data-a="mdn" title="Page down">▼</button>
          </div>
        </div>
        <div class="memory-view mem"></div>
      </div>
    </div>
  </div>
  <div class="panel-tabs">
    <div class="panel-tab-bar">
      <button class="panel-tab-btn active" data-panel="bp">Breakpoints</button>
      <button class="panel-tab-btn" data-panel="labels">Labels</button>
      <button class="panel-tab-btn" data-panel="hist">History</button>
      <button class="panel-tab-btn" data-panel="screen">Screen</button>
      <button class="panel-tab-btn" data-panel="asm">Assembler</button>
    </div>
    <div class="panel-tab-content active" data-panel="bp">
      <div class="bp-add-form" style="margin-bottom:5px">
        <select class="bt" title="Trigger type">
          <option value="exec">Exec</option><option value="read">Read</option><option value="write">Write</option>
          <option value="rw">R/W</option><option value="port_in">Port IN</option><option value="port_out">Port OUT</option>
          <option value="port_io">Port I/O</option>
        </select>
        <input type="text" class="bs" placeholder="ADDR" maxlength="24" title="8000, 8000-80FF, 5:8000, R0:ERROR; a port: FE, FE&amp;FF">
        <input type="text" class="bc" placeholder="if..." maxlength="30" title="Condition: A==0, HL>4000, (HL)==FF, NZ">
        <button data-a="add" title="Add">+</button>
        <button data-a="clear" title="Clear all">Clear</button>
        <span class="note">page 0-31 RAM, R0 / R1 ROM; names work</span>
      </div>
      <div class="breakpoint-list trigger-list bps"></div>
    </div>
    <div class="panel-tab-content" data-panel="labels">
      <div class="bp-add-form" style="margin-bottom:5px">
        <button data-a="lload">Load…</button>
        <button data-a="lsave">Save</button>
        <input type="file" class="lfile" hidden accept=".map,.sym,.lbl,.txt,.lst,.asm">
        <span class="note">double-click an address in the code to name it; the ROM's, SAMDOS's and the ports' names are built in</span>
      </div>
      <div class="breakpoint-list lst labels"></div>
    </div>
    <div class="panel-tab-content" data-panel="hist">
      <div class="note">the last instructions, newest last; a click shows the code there</div>
      <div class="stack-view lst hist"></div>
    </div>
    <div class="panel-tab-content" data-panel="screen">
      <div class="bp-add-form" style="margin-bottom:5px">
        <select class="spage" title="The RAM page to show"></select>
        <select class="smode" title="The mode to show it in">
          <option value="">mode (VMPR)</option><option value="1">mode 1</option><option value="2">mode 2</option>
          <option value="3">mode 3</option><option value="4">mode 4</option>
        </select>
        <span class="note sinfo">point at it: where each pixel comes from; click: that byte in Memory</span>
      </div>
      <canvas class="scr" width="512" height="192"></canvas>
    </div>
    <div class="panel-tab-content" data-panel="asm">
      <div class="asm"></div>
    </div>
  </div>
</div></div>`;
    const $ = (s) => root.querySelector(s);
    const status = $('.st');

    let disTop = null;        // the first address shown, when not following PC
    let cursor = null;        // the line picked for "to cursor"
    let memAddr = 0x8000;
    const LINES = 26, MEM_LINES = 16;

    // ---- tabs ----
    root.querySelector('.panel-tab-bar').addEventListener('click', (e) => {
        const b = e.target.closest('.panel-tab-btn');
        if (!b) return;
        for (const x of root.querySelectorAll('.panel-tab-btn')) x.classList.toggle('active', x === b);
        for (const x of root.querySelectorAll('.panel-tab-content')) x.classList.toggle('active', x.dataset.panel === b.dataset.panel);
        renderAll();
    });

    // ---- registers ----
    const REGS = {
        AF: [() => (m.cpu.a << 8) | m.cpu.f, (v) => { m.cpu.a = v >> 8; m.cpu.f = v & 0xFF; }],
        BC: [() => (m.cpu.b << 8) | m.cpu.c, (v) => { m.cpu.b = v >> 8; m.cpu.c = v & 0xFF; }],
        DE: [() => (m.cpu.d << 8) | m.cpu.e, (v) => { m.cpu.d = v >> 8; m.cpu.e = v & 0xFF; }],
        HL: [() => (m.cpu.h << 8) | m.cpu.l, (v) => { m.cpu.h = v >> 8; m.cpu.l = v & 0xFF; }],
        "AF'": [() => (m.cpu.a_ << 8) | m.cpu.f_, (v) => { m.cpu.a_ = v >> 8; m.cpu.f_ = v & 0xFF; }],
        "BC'": [() => (m.cpu.b_ << 8) | m.cpu.c_, (v) => { m.cpu.b_ = v >> 8; m.cpu.c_ = v & 0xFF; }],
        "DE'": [() => (m.cpu.d_ << 8) | m.cpu.e_, (v) => { m.cpu.d_ = v >> 8; m.cpu.e_ = v & 0xFF; }],
        "HL'": [() => (m.cpu.h_ << 8) | m.cpu.l_, (v) => { m.cpu.h_ = v >> 8; m.cpu.l_ = v & 0xFF; }],
        IX: [() => m.cpu.ix, (v) => { m.cpu.ix = v; }],
        IY: [() => m.cpu.iy, (v) => { m.cpu.iy = v; }],
        SP: [() => m.cpu.sp, (v) => { m.cpu.sp = v; }],
        PC: [() => m.cpu.pc, (v) => { m.cpu.pc = v; }],
        I: [() => m.cpu.i, (v) => { m.cpu.i = v & 0xFF; }, 8],
        R: [() => (m.cpu.r & 0x7F) | (m.cpu.r7 & 0x80), (v) => { m.cpu.r = v & 0x7F; m.cpu.r7 = v & 0x80; }, 8],
    };
    const item = (name, value, reg) => `<div class="register-item"><span class="register-name">${esc(name)}</span><br>` +
        `<span class="register-value${reg ? ' reg16 editable' : ''}"${reg ? ` data-reg="${esc(reg)}"` : ''}>${value}</span></div>`;
    const regItem = (n) => { const [get, , bits] = REGS[n]; return item(n, bits === 8 ? h2(get()) : h4(get()), n); };
    function renderRegs() {
        $('.regs-main').innerHTML = ['AF', 'BC', 'DE', 'HL'].map(regItem).join('');
        $('.regs-alt').innerHTML = ["AF'", "BC'", "DE'", "HL'"].map(regItem).join('');
        $('.regs-ix').innerHTML = ['IX', 'IY'].map(regItem).join('');
        $('.regs-sys').innerHTML = ['SP', 'PC', 'I', 'R'].map(regItem).join('');
        $('.regs-int').innerHTML = item('IM', String(m.cpu.im)) + item('IFF', `${m.cpu.iff1 ? 1 : 0}/${m.cpu.iff2 ? 1 : 0}`) +
            item('T', String(m.cpu.tStates)) + (m.cpu.halted ? item('', 'HALT') : '');
        const f = m.cpu.f;
        $('.flags').innerHTML = [['S', 0x80], ['Z', 0x40], ['y', 0x20], ['H', 0x10], ['x', 0x08], ['P/V', 0x04], ['N', 0x02], ['C', 0x01]]
            .map(([n, b]) => `<div class="flag-item editable ${f & b ? 'set' : ''}" data-bit="${b}" title="click to toggle">${n}</div>`).join('');
    }
    root.addEventListener('dblclick', (e) => {
        const r = e.target.dataset.reg;
        if (!r || !REGS[r]) return;
        const [get, set, bits] = REGS[r];
        editInline(e.target, bits === 8 ? h2(get()) : h4(get()), (s) => {
            const v = parseInt(s, 16);
            if (!isNaN(v)) set(v & (bits === 8 ? 0xFF : 0xFFFF));
        });
    });
    $('.flags').addEventListener('click', (e) => {
        const b = e.target.dataset.bit;
        if (b === undefined) return;
        m.cpu.f ^= +b; renderRegs();
    });

    // ---- pages ----
    function renderPaging() {
        const p = m.getPagingState();
        const s = (x) => (x === null ? '—' : String(x));
        $('.pg').innerHTML = esc(
            `A ${s(p.sections[0]).padStart(3)}  LMPR ${h2(p.lmpr)}\n` +
            `B ${s(p.sections[1]).padStart(3)}  HMPR ${h2(p.hmpr)}\n` +
            `C ${s(p.sections[2]).padStart(3)}  VMPR ${h2(p.vmpr)}\n` +
            `D ${s(p.sections[3]).padStart(3)}  mode ${p.mode}\n` +
            `scr ${(m.vmpr & 0x1F)}  line ${m.lineInt < 192 ? m.lineInt : '—'}\n` +
            `LEPR ${h2(p.lepr)} HEPR ${h2(p.hepr)}`);
    }

    // ---- code ----
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
    function renderCode() {
        const pc = m.cpu.pc;
        const follow = $('.follow').checked;
        const top = follow || disTop === null ? dis.findStartForPosition(pc, 8, LINES) : disTop;
        if (!follow && disTop === null) disTop = top;
        const lines = dis.disassembleRange(top, LINES);
        const html = [];
        let rows = 0;
        for (const l of lines) {
            if (rows >= LINES) break;
            const own = nameAt(l.addr, l.addr);
            const bp = m.hasBreakpoint(l.addr), off = !bp && m.hasDisabledBreakpoint(l.addr);
            const cls = ['disasm-line', l.addr === pc ? 'current' : '', bp ? 'breakpoint' : '', l.addr === cursor ? 'cursor' : '',
                own ? 'has-long-label' : ''].join(' ');
            html.push(`<div class="${cls}" data-addr="${l.addr}">` +
                (own ? `<div class="disasm-label-row"><span class="label-name">${esc(own)}</span>:</div>` : '') +
                `<span class="disasm-bp ${bp ? 'active' : off ? 'disabled' : ''}" data-bp="${l.addr}" title="Toggle breakpoint">•</span>` +
                `<span class="disasm-addr" data-lbl="${l.addr}" title="double-click to name it">${h4(l.addr)}</span>` +
                `<span class="disasm-bytes">${l.bytes.map(h2).join(' ')}</span>` +
                `<span class="disasm-mnemonic">${operands(l)}</span></div>`);
            rows += own ? 2 : 1;
        }
        $('.dis').innerHTML = html.join('');
    }
    $('.dis').addEventListener('click', (e) => {
        const g = e.target.closest('[data-bp]');
        if (g) { m.toggleBreakpoint(+g.dataset.bp); renderAll(); return; }
        const row = e.target.closest('[data-addr]');
        if (row) { cursor = +row.dataset.addr; renderCode(); }
    });
    $('.dis').addEventListener('dblclick', (e) => {
        const a = e.target.dataset.lbl;
        if (a === undefined || !sym) return;
        const addr = +a;
        editInline(e.target, sym.nameAt(m, addr) || '', (name) => {
            sym.setLabel(addr, name.trim().replace(/\s+/g, '_'));
            saveLabels();
        });
    });
    $('.dis').addEventListener('wheel', (e) => {
        e.preventDefault();
        $('.follow').checked = false;
        const start = disTop === null ? dis.findStartForPosition(m.cpu.pc, 8, LINES) : disTop;
        disTop = e.deltaY > 0 ? (start + dis.disassemble(start).length) & 0xFFFF : (start - 1) & 0xFFFF;
        renderCode();
    }, { passive: false });
    const goCode = (a) => { $('.follow').checked = false; disTop = a; cursor = a; renderCode(); };
    $('.dgo').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const v = parseAddr(e.target.value);
        if (v === null) { say(`no such address or name: ${e.target.value}`); return; }
        goCode(v);
    });
    $('.follow').addEventListener('change', () => { disTop = null; renderCode(); });

    // ---- memory: the CPU's 64K, or a page as it is ----
    const memSrc = $('.msrc');
    memSrc.add(new Option('CPU 64K', 'cpu'));
    for (let i = 0; i < 32; i++) memSrc.add(new Option('RAM page ' + i, 'r' + i));
    memSrc.add(new Option('ROM0', 'R0')); memSrc.add(new Option('ROM1', 'R1'));
    for (let i = 0; i < 64; i++) memSrc.add(new Option('ext page ' + i, 'x' + i));
    let memMark = -1;
    const source = () => {
        const v = memSrc.value;
        if (v === 'cpu') return null;
        if (v[0] === 'r') return { buf: m.ram, base: +v.slice(1) << 14, ro: false };
        if (v[0] === 'R') return { buf: m.rom, base: v === 'R1' ? 0x4000 : 0, ro: true };
        return { buf: m.ext, base: +v.slice(1) << 14, ro: false };
    };
    const memLim = () => (source() ? 0x3FFF : 0xFFFF);
    const memRead = (a) => { const src = source(); return src ? src.buf[src.base + (a & 0x3FFF)] : peek(a); };
    const memWrite = (a, v) => {
        const src = source();
        if (!src) { m.write(a, v); return; }
        if (!src.ro) src.buf[src.base + (a & 0x3FFF)] = v;
    };
    memSrc.addEventListener('change', () => { memMark = -1; memAddr &= memLim() & ~15; renderMem(); });
    function renderMem() {
        const lim = memLim(), rows = [];
        for (let r = 0; r < MEM_LINES; r++) {
            const a = (memAddr + r * 16) & lim;
            let hex = '', asc = '';
            for (let i = 0; i < 16; i++) {
                const ad = (a + i) & lim, v = memRead(ad);
                let cls = 'memory-byte' + (i % 4 === 0 && i ? ' group-start' : '') + (ad === memMark ? ' mark' : '');
                if (!source() && m.hasBreakpointAt(ad)) cls += ' has-bp';
                hex += `<span class="${cls}" data-m="${ad}">${h2(v)}</span>`;
                const pr = v >= 32 && v < 127;
                asc += `<span class="${pr ? 'printable' : v === 0 ? 'null-byte' : ''}">${pr ? esc(String.fromCharCode(v)) : v === 0 ? '■' : '.'}</span>`;
            }
            rows.push(`<div class="memory-line"><span class="memory-addr">${h4(a)}</span><span class="memory-hex">${hex}</span><span class="memory-ascii">${asc}</span></div>`);
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
        memAddr = (memAddr + (e.deltaY > 0 ? 16 : -16)) & memLim();
        renderMem();
    }, { passive: false });
    const goMem = (a) => { memMark = -1; memAddr = a & memLim() & ~15; renderMem(); };
    $('.mgo').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const v = parseAddr(e.target.value);
        if (v === null) { say(`no such address or name: ${e.target.value}`); return; }
        goMem(v);
    });

    // ---- stack, calls, history, labels ----
    const where = (a) => { const n = nameAt(a, a); return `<span class="stack-value">${h4(a)}</span>` + (n ? ` <span class="call-label">${esc(n)}</span>` : ''); };
    function renderStack() {
        const sp = m.cpu.sp, out = [];
        for (let i = 0; i < 8; i++) {
            const a = (sp + i * 2) & 0xFFFF, w = peek(a) | (peek(a + 1) << 8);
            out.push(`<div class="stack-entry${i === 0 ? ' current' : ''}" data-go="${w}"><span class="stack-addr">${h4(a)}</span>${where(w)}</div>`);
        }
        $('.stk').innerHTML = out.join('');
    }
    function renderCalls() {
        const cs = m.callStack.slice().reverse();
        $('.calls').innerHTML = cs.length ? cs.slice(0, 10).map((c, i) =>
            `<div class="stack-entry${i === 0 ? ' current' : ''}" data-go="${c.to}" title="from ${h4(c.from)}">` +
            `${c.int ? '<span class="call-int">INT </span>' : ''}${where(c.to)}</div>`).join('')
            : '<div class="stack-entry" style="opacity:0.4">—</div>';
    }
    function renderHistory() {
        const h = m.getHistory(24);
        $('.hist').innerHTML = h.length ? h.map((a) => {
            const l = dis.disassemble(a);
            return `<div class="stack-entry" data-go="${a}">${where(a)}  <span class="disasm-mnemonic">${operands(l)}</span></div>`;
        }).join('') : '<div class="no-breakpoints">nothing yet: run or step</div>';
    }
    function renderLabels() {
        if (!sym) { $('.labels').innerHTML = '<div class="no-breakpoints">no symbols</div>'; return; }
        const list = sym.userLabels();
        $('.labels').innerHTML = list.length ? list.slice(0, 300).map((l) =>
            `<div class="trigger-item" data-go="${l.addr}"><span class="trigger-desc">${h4(l.addr)}${l.page !== null ? ' (' + esc(l.page) + ')' : ''} ${esc(l.name)}</span>` +
            `<span class="trigger-remove" data-unlabel="${l.addr}" data-page="${l.page ?? ''}" title="Remove">×</span></div>`).join('')
            : '<div class="no-breakpoints">no labels of your own yet</div>';
    }
    root.addEventListener('click', (e) => {
        const un = e.target.dataset.unlabel;
        if (un !== undefined) {
            const pg = e.target.dataset.page;
            sym.setLabel(+un, '', pg === '' ? null : (isNaN(+pg) ? pg : +pg));
            saveLabels(); renderAll(); return;
        }
        const go = e.target.closest('[data-go]');
        if (go && root.contains(go)) goCode(+go.dataset.go);
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
        if (!scr.offsetParent) return;          // its tab is not open
        const { page, mode } = shown();
        // the screen being shown, as the beam coloured it line by line (the
        // palette a program changes on line interrupts); any other page with
        // the CLUT as it is now
        const live = page === (m.vmpr & 0x1F) && mode === ((m.vmpr >> 5) & 3) + 1;
        renderScreen(m.ram, page, mode, m.clut, (m.hmpr >> 3) & 0x0C, !!(m.frames & 16), sbuf,
                     live ? m.lineClut : null, live ? m.lineMd3 : null);
        sctx.putImageData(simg, 0, 0);
    }
    const pixelAt = (e) => {
        const r = scr.getBoundingClientRect();
        const x = Math.min(SCR_W - 1, Math.max(0, Math.floor((e.clientX - r.left) * SCR_W / r.width)));
        const y = Math.min(SCR_H - 1, Math.max(0, Math.floor((e.clientY - r.top) * SCR_H / r.height)));
        const { page, mode } = shown();
        const at = screenByteAt(mode, x, y), base = screenBase(page, mode), mask = m.ram.length - 1;
        return { x: mode === 3 ? x : x >> 1, y, mode, abs: (base + at.offset) & mask, attr: at.attr === null ? null : (base + at.attr) & mask };
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
        memAddr = p.abs & 0x3FF0;
        memMark = p.abs & 0x3FFF;
        renderMem();
    });
    spage.addEventListener('change', renderScreenBox);
    smode.addEventListener('change', renderScreenBox);

    // ---- breakpoints ----
    const ICON = { exec: '●', read: 'R', write: 'W', rw: 'RW' };
    function renderBps() {
        const list = m.getTriggers();
        $('.bps').innerHTML = list.length ? list.map((t, i) =>
            `<div class="trigger-item${t.enabled ? '' : ' disabled'}">` +
            `<span class="trigger-icon ${t.type.startsWith('port') ? 'port' : t.type}">${ICON[t.type] || 'P'}</span>` +
            `<span class="trigger-toggle" data-en="${i}" title="${t.enabled ? 'Disable' : 'Enable'}">⏻</span>` +
            `<span class="trigger-desc">${esc(m.getTriggerLabel ? m.getTriggerLabel(t.type) : t.type)} ${esc(m.formatTrigger(t))} · ${t.hitCount} hits</span>` +
            `<span class="trigger-remove" data-del="${i}" title="Remove">×</span></div>`).join('')
            : '<div class="no-breakpoints">No breakpoints</div>';
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
        pcgo: () => { $('.follow').checked = true; disTop = null; renderCode(); },
        mpc: () => goMem(m.cpu.pc), msp: () => goMem(m.cpu.sp), mhl: () => goMem((m.cpu.h << 8) | m.cpu.l),
        mup: () => { memAddr = (memAddr - MEM_LINES * 16) & memLim(); renderMem(); },
        mdn: () => { memAddr = (memAddr + MEM_LINES * 16) & memLim(); renderMem(); },
        add: addBreakpoint,
        clear: () => { m.clearTriggers(); renderAll(); },
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
        if (!app.isPaused() || e.target.closest?.('input, select, textarea')) return;
        const k = e.key;
        const fn = k === 'F5' ? act.run : k === 'F7' ? act.into : k === 'F8' ? (e.shiftKey ? act.ret : act.over) : k === 'F6' ? act.cursor : null;
        if (fn) { e.preventDefault(); e.stopImmediatePropagation(); fn(); }
    }, true);

    function editInline(el, value, done) {
        const inp = document.createElement('input');
        inp.value = value; inp.size = Math.max(4, value.length + 1);
        inp.style.cssText = 'font:inherit;width:auto';
        el.replaceWith(inp); inp.focus(); inp.select();
        const finish = (ok) => { if (ok) done(inp.value); renderAll(); };
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); e.stopPropagation(); });
        inp.addEventListener('blur', () => finish(false));
    }

    createSamAssembler({
        root: $('.asm'), machine: m, symbols: sym, say,
        onDone: (what) => { saveLabels(); app.draw(); renderAll(); if (what === 'run') { say(''); app.pause(false); } },
    });

    function renderAll() {
        renderRegs(); renderPaging(); renderCode(); renderMem(); renderStack(); renderCalls();
        renderHistory(); renderLabels(); renderBps(); renderScreenBox();
    }

    // While it runs: what changes every frame, a few times a second (as the
    // main debugger does), while the panel is open and the page is shown
    const live = setInterval(() => {
        if (app.isPaused() || !root.offsetParent || document.hidden) return;
        renderRegs(); renderPaging(); if ($('.follow').checked) renderCode();
        renderStack(); renderCalls(); renderMem(); renderScreenBox();
        if (root.querySelector('.panel-tab-content.active')?.dataset.panel === 'hist') renderHistory();
    }, 160);

    renderAll();
    return {
        destroy() { clearInterval(live); },
        goToAddress: (a) => goCode(a & 0xFFFF),
        goToMemoryAddress: (a) => { memSrc.value = 'cpu'; goMem(a & 0xFFFF); },
        onBreak(hit) { after(hit); },
        refresh: renderAll,
        say,
    };
}
