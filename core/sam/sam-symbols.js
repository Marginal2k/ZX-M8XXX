/**
 * ZX-M8XXX - SAM Coupé symbols for the debugger
 * @license GPL-3.0
 *
 * Names for addresses and ports, picked as SimCoupe's Symbol.cpp picks them
 * (its maps are in data/sam/, see the README there):
 *
 *   ROM      samrom.map, for an address where a ROM is paged
 *   sysvars  samrom.map too, for #4000-#5CFF while RAM page 0 is there
 *   SAMDOS   samdos2.map, for #4000-#7FFF while SAMDOS 2 is paged there
 *            (#20 at #4096 and "SAMDOS" at #50AF)
 *   user     the program's own: loaded from a file (a SimCoupe / pasmo map
 *            "ADDR=NAME", sjasmplus / pasmo "NAME: EQU 0xADDR" or
 *            "NAME EQU #ADDR", or "ADDR NAME") or named in the debugger;
 *            a name may hold for one RAM page only
 *   ports    samports.map: a name to read a port by, and one to write it by
 */

const hex = (s) => parseInt(s, 16);

// "ADDR=NAME" lines, ';' comments
export function parseSimpleMap(text) {
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/;.*/, '').trim();
        const m = /^([0-9A-Fa-f]{1,4})\s*=\s*(\S*)/.exec(line);
        if (m) out.push({ addr: hex(m[1]), name: m[2] });
    }
    return out;
}

// A labels file from an assembler or from SimCoupe, as well as we can read it
export function parseLabels(text) {
    const out = [];
    const num = (s) => {
        s = s.trim();
        let m;
        if ((m = /^(?:0x|#|\$|&)([0-9a-f]+)$/i.exec(s))) return hex(m[1]);
        if ((m = /^([0-9a-f]+)h$/i.exec(s))) return hex(m[1]);
        if ((m = /^\d+$/.exec(s))) return parseInt(s, 10);
        return NaN;
    };
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/;.*/, '').trim();
        if (!line) continue;
        let m, name, addr;
        if ((m = /^([0-9A-Fa-f]{1,4})\s*=\s*([A-Za-z_.@$?][\w.@$?]*)$/.exec(line))) { addr = hex(m[1]); name = m[2]; }
        else if ((m = /^([A-Za-z_.@$?][\w.@$?]*):?\s+(?:equ|=)\s+(\S+)/i.exec(line))) { name = m[1]; addr = num(m[2]); }
        else if ((m = /^(?:\$|#|0x)?([0-9A-Fa-f]{4})\s+([A-Za-z_.@$?][\w.@$?]*)$/.exec(line))) { addr = hex(m[1]); name = m[2]; }
        if (name && !isNaN(addr)) out.push({ addr: addr & 0xFFFF, name });
    }
    return out;
}

export class SamSymbols {
    constructor() {
        this.rom = new Map(); this.dos = new Map(); this.user = new Map();   // addr -> name ("addr" or "page:addr" for user)
        this.portsIn = new Map(); this.portsOut = new Map();
        this.values = new Map();      // lower-case name -> { addr, page }
    }

    // ---- loading ----
    loadRomMap(text) { for (const { addr, name } of parseSimpleMap(text)) if (name) { this.rom.set(addr, name); this._value(name, addr, null); } }
    loadDosMap(text) { for (const { addr, name } of parseSimpleMap(text)) if (name) { this.dos.set(addr, name); this._value(name, addr, null); } }
    loadPortMap(text) {
        for (const { addr, name } of parseSimpleMap(text)) {
            if (!name) continue;
            if (addr & 0x8000) this.portsOut.set(addr & 0xFF, name);
            else { this.portsIn.set(addr & 0xFF, name); if (!this.portsOut.has(addr & 0xFF)) this.portsOut.set(addr & 0xFF, name); }
        }
    }
    // returns how many it took
    loadUserLabels(text, page = null) {
        const list = parseLabels(text);
        for (const { addr, name } of list) this.setLabel(addr, name, page);
        return list.length;
    }

    _value(name, addr, page) { this.values.set(name.toLowerCase(), { addr, page }); }

    // ---- the user's own ----
    setLabel(addr, name, page = null) {
        addr &= 0xFFFF;
        const key = page === null ? String(addr) : `${page}:${addr}`;
        const old = this.user.get(key);
        if (old) this.values.delete(old.toLowerCase());
        if (!name) { this.user.delete(key); return; }
        this.user.set(key, name);
        this._value(name, addr, page);
    }
    userLabels() {
        return [...this.user].map(([k, name]) => {
            const [a, b] = k.includes(':') ? k.split(':') : [null, k];
            return { addr: +b, page: a === null ? null : (isNaN(+a) ? a : +a), name };
        }).sort((x, y) => x.addr - y.addr);
    }
    toJSON() { return this.userLabels(); }
    fromJSON(list) { for (const l of list || []) this.setLabel(l.addr, l.name, l.page); }
    exportMap() { return this.userLabels().map(l => `${l.addr.toString(16).toUpperCase().padStart(4, '0')}=${l.name}`).join('\n') + '\n'; }

    // ---- looking up ----
    _samdosPaged(m) {
        if (m.read(0x4096) !== 0x20) return false;
        let s = '';
        for (let i = 0; i < 6; i++) s += String.fromCharCode(m.read(0x50AF + i));
        return s === 'SAMDOS';
    }

    // The name of an address as the machine is paged now; `context` is where
    // the code that mentions it is (a ROM routine's operand is a ROM name)
    nameAt(m, addr, context = addr) {
        addr &= 0xFFFF;
        const page = m.getCurrentPageForAddr(addr);
        const ctxPage = m.getCurrentPageForAddr(context);
        const isRom = page === 'R0' || page === 'R1';
        const ctxRom = ctxPage === 'R0' || ctxPage === 'R1';
        const user = this.user.get(`${page}:${addr}`) || this.user.get(String(addr));
        if (user) return user;
        if (isRom && ctxRom) return this.rom.get(addr) || null;
        if (addr >= 0x4000 && addr < 0x5D00 && page === 0) return this.rom.get(addr) || null;
        if (addr >= 0x4000 && addr < 0x8000 && context >= 0x4000 && context < 0x8000 && this.dos.size && this._samdosPaged(m)) {
            return this.dos.get(addr) || null;
        }
        if (isRom) return this.rom.get(addr) || null;
        return null;
    }

    portName(port, isOut) { return (isOut ? this.portsOut : this.portsIn).get(port & 0xFF) || null; }

    // A name back to an address: { addr, page } or null
    lookup(name) { return this.values.get(String(name).trim().toLowerCase()) || null; }

    // "[page:]addr-or-name[-end]" -> the same with names turned into hex
    resolveSpec(spec) {
        return String(spec).replace(/[A-Za-z_.@?][\w.@?]*/g, (w) => {
            if (/^(R[01]|[0-9A-Fa-f]+)$/.test(w)) return w;      // a page or hex number stays
            const v = this.lookup(w);
            return v ? v.addr.toString(16) : w;
        });
    }
}

export async function loadSamSymbols(base = 'data/sam/') {
    const s = new SamSymbols();
    const get = async (f) => { try { const r = await fetch(base + f); return r.ok ? await r.text() : ''; } catch (e) { return ''; } };
    const [rom, dos, ports] = await Promise.all([get('samrom.map'), get('samdos2.map'), get('samports.map')]);
    s.loadRomMap(rom); s.loadDosMap(dos); s.loadPortMap(ports);
    return s;
}
