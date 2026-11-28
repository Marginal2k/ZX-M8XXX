/**
 * ZX-M8XXX - the trigger engine: breakpoints, watchpoints, port breakpoints,
 * media and screen triggers, and the conditions on them
 * @license GPL-3.0
 *
 * Shared by the machines that have a debugger (Spectrum, SAM Coupe). It was
 * the Spectrum's own until the SAM needed it; it is mixed into a machine's
 * prototype (mixTriggers), so every call site keeps calling these as the
 * machine's methods.
 *
 * What the machine provides:
 *   cpu, memory.read           registers and memory for the conditions
 *   getCurrentPageForAddr(a)   the page at an address now (a number, 'R0' /
 *                              'R1' for a ROM, null for none) - how a trigger
 *                              with a page ("5:C000") is matched
 *   debugPageCount()           how many RAM pages a page number may name
 *                              (default 8, the 128K's)
 *   updateMemoryCallbacksFlag() switch the memory and fetch callbacks on or
 *                              off as the triggers need them
 *   _rebuildScreenBreakpointSets() (optional) for screen triggers
 * and the state initTriggerState() sets up.
 */

import { hex16 } from './utils.js';
import { fmtAddr, fmtPort } from './addr-format.js';

// The state the engine keeps on its machine
export function initTriggerState(m) {
    // Unified trigger system - replaces separate breakpoints/watchpoints/port breakpoints
    // Trigger types: 'exec', 'read', 'write', 'rw', 'port_in', 'port_out', 'port_io',
    //                'tape_block', 'disk_read', 'disk_sector', 'screen_bitmap', 'screen_attr'
    m.triggers = [];
    m.triggerHit = false;
    m.lastTrigger = null;        // {trigger, addr, val, port, direction}
    m.onTrigger = null;          // Unified callback for all trigger types
    // Fast O(1) lookup Set for exec breakpoints (rebuilt when triggers change)
    m.execBreakpointSet = new Set();
    // Fast O(1) lookup Sets for screen region write breakpoints
    m.screenNormalBitmapSet = new Set();
    m.screenNormalAttrSet = new Set();
    m.screenShadowBitmapSet = new Set();
    m.screenShadowAttrSet = new Set();
    m._hasScreenTriggers = false;
    // Legacy arrays - now views into unified triggers for backward compatibility
    m.breakpoints = [];
    m.breakpointHit = false;
    m.portBreakpoints = [];
    m.portBreakpointHit = false;
    m.lastPortBreakpoint = null;
    m.watchpoints = [];
    m.watchpointHit = false;
    m._suppressWatchpoints = false; // Suppress during trace pre-reads and diagnostic reads
    m._inCpuExecution = false;      // True only during cpu.execute()/cpu.step() - gates read watchpoints
    m._currentInstrPC = 0;          // PC of currently executing instruction (for watchpoint reporting)
    m.lastWatchpoint = null;
}

export const TriggerEngine = {
    // How many RAM pages a breakpoint's page number may name
    debugPageCount() { return 8; },

    // ========== Debugging - Breakpoints ==========

    parseAddressSpec(spec) {
        spec = spec.trim().toUpperCase();
        let page = null;
        
        // Check for page prefix (e.g., "5:" or "R0:")
        const colonIdx = spec.indexOf(':');
        if (colonIdx !== -1) {
            const pageSpec = spec.substring(0, colonIdx);
            spec = spec.substring(colonIdx + 1);
            if (pageSpec.startsWith('R')) {
                page = pageSpec; // ROM page like 'R0' or 'R1'
            } else {
                page = parseInt(pageSpec, 10);
                if (isNaN(page) || page < 0 || page >= this.debugPageCount()) return null;
            }
        }
        
        // Check for range (e.g., "1234-5678")
        const dashIdx = spec.indexOf('-');
        if (dashIdx !== -1) {
            const startStr = spec.substring(0, dashIdx);
            const endStr = spec.substring(dashIdx + 1);
            const start = parseInt(startStr, 16);
            const end = parseInt(endStr, 16);
            if (isNaN(start) || isNaN(end)) return null;
            return { start: start & 0xffff, end: end & 0xffff, page };
        }
        
        // Single address
        const addr = parseInt(spec, 16);
        if (isNaN(addr)) return null;
        return { start: addr & 0xffff, end: addr & 0xffff, page };
    },

    // Check if breakpoint matches current state
    checkBreakpointMatch(bp, addr) {
        addr = addr & 0xffff;
        if (addr < bp.start || addr > bp.end) return false;
        if (bp.page !== null && bp.page !== this.getCurrentPageForAddr(addr)) return false;
        // Check condition if present
        if (bp.condition) {
            return this.evaluateCondition(bp.condition);
        }
        return true;
    },

    // Evaluate a breakpoint condition
    // Supports: A, B, C, D, E, H, L, F, AF, BC, DE, HL, IX, IY, SP, PC, I, R
    // Operators: ==, !=, <, >, <=, >=, &, |
    // Memory: (HL), (DE), (BC), (1234)
    // Flags: Z, NZ, C, NC, P, M, PE, PO
    // Context: val (for watchpoints), port (for port breakpoints)
    evaluateCondition(condition, context = {}) {
        if (!this.cpu) return false;
        try {
            const cpu = this.cpu;
            const mem = this.memory;
            const ctxVal = context.val;
            const ctxPort = context.port;

            // Get register value by name
            const getReg = (name) => {
                name = name.toUpperCase();
                switch (name) {
                    case 'A': return cpu.a;
                    case 'B': return cpu.b;
                    case 'C': return cpu.c;
                    case 'D': return cpu.d;
                    case 'E': return cpu.e;
                    case 'H': return cpu.h;
                    case 'L': return cpu.l;
                    case 'F': return cpu.f;
                    case 'I': return cpu.i;
                    case 'R': return cpu.r;
                    case 'AF': return (cpu.a << 8) | cpu.f;
                    case 'BC': return (cpu.b << 8) | cpu.c;
                    case 'DE': return (cpu.d << 8) | cpu.e;
                    case 'HL': return (cpu.h << 8) | cpu.l;
                    case 'IX': return cpu.ix;
                    case 'IY': return cpu.iy;
                    case 'SP': return cpu.sp;
                    case 'PC': return cpu.pc;
                    case "A'": return cpu.a_;
                    case "B'": return cpu.b_;
                    case "C'": return cpu.c_;
                    case "D'": return cpu.d_;
                    case "E'": return cpu.e_;
                    case "H'": return cpu.h_;
                    case "L'": return cpu.l_;
                    case "F'": return cpu.f_;
                    case "AF'": return (cpu.a_ << 8) | cpu.f_;
                    case "BC'": return (cpu.b_ << 8) | cpu.c_;
                    case "DE'": return (cpu.d_ << 8) | cpu.e_;
                    case "HL'": return (cpu.h_ << 8) | cpu.l_;
                    default: return null;
                }
            };

            // Get flag value
            const getFlag = (name) => {
                name = name.toUpperCase();
                const f = cpu.f;
                switch (name) {
                    case 'Z': return (f & 0x40) !== 0;
                    case 'NZ': return (f & 0x40) === 0;
                    case 'C': return (f & 0x01) !== 0;
                    case 'NC': return (f & 0x01) === 0;
                    case 'P': case 'PE': return (f & 0x04) !== 0;
                    case 'M': case 'PO': return (f & 0x04) === 0;
                    case 'N': return (f & 0x02) !== 0;
                    case 'H': return (f & 0x10) !== 0;
                    case 'S': return (f & 0x80) !== 0;
                    default: return null;
                }
            };

            // Parse a value (register, memory, literal, or context)
            const parseValue = (s) => {
                s = s.trim();
                const upper = s.toUpperCase();

                // Context variables for watchpoints/port breakpoints
                if (upper === 'VAL' && ctxVal !== undefined) return ctxVal;
                if (upper === 'PORT' && ctxPort !== undefined) return ctxPort;

                // T-states counter
                if (upper === 'T' || upper === 'TSTATES') return cpu.tStates;

                // Memory access: (HL), (DE), (BC), (1234), (IX+n), (IY+n)
                const memMatch = s.match(/^\(([^)]+)\)$/);
                if (memMatch) {
                    const inner = memMatch[1].trim().toUpperCase();
                    let addr;
                    if (inner === 'HL') addr = getReg('HL');
                    else if (inner === 'DE') addr = getReg('DE');
                    else if (inner === 'BC') addr = getReg('BC');
                    else if (inner === 'SP') addr = getReg('SP');
                    else if (inner === 'IX') addr = cpu.ix;
                    else if (inner === 'IY') addr = cpu.iy;
                    else if (inner.match(/^IX[+-]\d+$/i)) {
                        const offset = parseInt(inner.slice(2));
                        addr = (cpu.ix + offset) & 0xffff;
                    } else if (inner.match(/^IY[+-]\d+$/i)) {
                        const offset = parseInt(inner.slice(2));
                        addr = (cpu.iy + offset) & 0xffff;
                    } else {
                        // Numeric address
                        addr = parseInt(inner, 16);
                    }
                    return mem.read(addr & 0xffff);
                }
                // Register
                const regVal = getReg(s);
                if (regVal !== null) return regVal;
                // Decimal literal (pure digits, no letters)
                if (s.match(/^\d+$/)) {
                    return parseInt(s, 10);
                }
                // Hex literal (with 'h' suffix or contains A-F)
                if (s.match(/^[0-9A-Fa-f]+h$/i) || s.match(/^[0-9]*[A-Fa-f][0-9A-Fa-f]*$/)) {
                    return parseInt(s.replace(/h$/i, ''), 16);
                }
                return null;
            };

            // Check for simple flag test
            const cond = condition.trim();
            const flagVal = getFlag(cond);
            if (flagVal !== null) return flagVal;

            // Parse comparison: value op value
            const opMatch = cond.match(/^(.+?)\s*(==|!=|<>|<=|>=|<|>|&|\|)\s*(.+)$/);
            if (opMatch) {
                const left = parseValue(opMatch[1]);
                const op = opMatch[2];
                const right = parseValue(opMatch[3]);
                if (left === null || right === null) return false;
                switch (op) {
                    case '==': return left === right;
                    case '!=': case '<>': return left !== right;
                    case '<': return left < right;
                    case '>': return left > right;
                    case '<=': return left <= right;
                    case '>=': return left >= right;
                    case '&': return (left & right) !== 0;
                    case '|': return (left | right) !== 0;
                }
            }

            return false;
        } catch (e) {
            return false;
        }
    },

    // Check if any breakpoint matches
    hasBreakpointAt(addr) {
        // Use unified trigger system
        return this.checkExecTriggers(addr) !== null;
    },

    addBreakpoint(spec) {
        if (typeof spec === 'number') {
            spec = { start: spec & 0xffff, end: spec & 0xffff, page: null };
        } else if (typeof spec === 'string') {
            spec = this.parseAddressSpec(spec);
            if (!spec) return false;
        }
        // Use unified trigger system
        return this.addTrigger({
            type: 'exec',
            start: spec.start,
            end: spec.end,
            page: spec.page
        }) >= 0;
    },

    removeBreakpoint(index) {
        // Find the corresponding trigger in the unified array
        const execTriggers = this.triggers
            .map((t, i) => ({ ...t, triggerIndex: i }))
            .filter(t => t.type === 'exec');
        if (index >= 0 && index < execTriggers.length) {
            return this.removeTrigger(execTriggers[index].triggerIndex);
        }
        return false;
    },

    removeBreakpointByAddr(addr) {
        addr = addr & 0xffff;
        const idx = this.triggers.findIndex(t =>
            t.type === 'exec' && t.start === addr && t.end === addr && t.page === null);
        if (idx !== -1) {
            return this.removeTrigger(idx);
        }
        return false;
    },

    toggleBreakpoint(addr) {
        addr = addr & 0xffff;
        const idx = this.triggers.findIndex(t =>
            t.type === 'exec' && t.start === addr && t.end === addr && t.page === null);
        if (idx !== -1) {
            this.removeTrigger(idx);
            return false;
        } else {
            this.addTrigger({ type: 'exec', start: addr, end: addr, page: null });
            return true;
        }
    },

    hasBreakpoint(addr) {
        // For disassembly display - check if exact single-address breakpoint exists (enabled only)
        addr = addr & 0xffff;
        return this.triggers.some(t =>
            t.type === 'exec' && t.enabled && t.start === addr && t.end === addr);
    },

    hasDisabledBreakpoint(addr) {
        // For disassembly display - check if a disabled breakpoint exists at this address
        addr = addr & 0xffff;
        return this.triggers.some(t =>
            t.type === 'exec' && !t.enabled && t.start === addr && t.end === addr);
    },

    getBreakpoints() {
        // Return from legacy array (synced from triggers)
        return this.breakpoints.map((bp, idx) => ({ ...bp, index: idx }));
    },

    clearBreakpoints() {
        this.clearTriggers('exec');
    },

    // Format breakpoint for display
    formatBreakpoint(bp) {
        let str = '';
        if (bp.page !== null) {
            str += (typeof bp.page === 'string' ? bp.page : bp.page.toString()) + ':';
        }
        str += hex16(bp.start);
        if (bp.end !== bp.start) {
            str += '-' + hex16(bp.end);
        }
        if (bp.condition) {
            str += ' if ' + bp.condition;
        }
        return str;
    },

    // Add breakpoint with optional condition
    addBreakpointWithCondition(addrSpec, condition) {
        let spec;
        if (typeof addrSpec === 'number') {
            spec = { start: addrSpec & 0xffff, end: addrSpec & 0xffff, page: null };
        } else if (typeof addrSpec === 'string') {
            spec = this.parseAddressSpec(addrSpec);
            if (!spec) return false;
        } else {
            spec = addrSpec;
        }
        // Use unified trigger system
        return this.addTrigger({
            type: 'exec',
            start: spec.start,
            end: spec.end,
            page: spec.page,
            condition: condition ? condition.trim() : ''
        }) >= 0;
    },

    // ========== Debugging - Port Breakpoints ==========

    parsePortSpec(spec) {
        spec = spec.trim().toUpperCase();
        // Format: "FE", "7FFD", "FE&FF", "7FFD&FFFF" (port & mask)
        const ampIdx = spec.indexOf('&');
        let port, mask;
        if (ampIdx !== -1) {
            port = parseInt(spec.substring(0, ampIdx), 16);
            mask = parseInt(spec.substring(ampIdx + 1), 16);
        } else {
            port = parseInt(spec, 16);
            // Default mask: 0xFF for 8-bit, 0xFFFF for 16-bit
            mask = port > 0xFF ? 0xFFFF : 0xFF;
        }
        if (isNaN(port) || isNaN(mask)) return null;
        // Determine if it's 16-bit based on port value or mask
        const is16bit = port > 0xFF || mask > 0xFF;
        return { 
            port: port & (is16bit ? 0xFFFF : 0xFF), 
            mask: mask & (is16bit ? 0xFFFF : 0xFF),
            is16bit 
        };
    },

    addPortBreakpoint(spec, direction = 'both') {
        if (typeof spec === 'string') {
            const parsed = this.parsePortSpec(spec);
            if (!parsed) return false;
            spec = parsed;
        }
        // Map direction to trigger type
        const typeMap = { 'in': 'port_in', 'out': 'port_out', 'both': 'port_io' };
        const type = typeMap[direction] || 'port_io';

        return this.addTrigger({
            type,
            start: spec.port,
            end: spec.port,
            mask: spec.mask
        }) >= 0;
    },

    removePortBreakpoint(index) {
        // Find the corresponding trigger in the unified array
        const portTriggers = this.triggers
            .map((t, i) => ({ ...t, triggerIndex: i }))
            .filter(t => t.type.startsWith('port'));
        if (index >= 0 && index < portTriggers.length) {
            return this.removeTrigger(portTriggers[index].triggerIndex);
        }
        return false;
    },

    getPortBreakpoints() {
        // Return from legacy array (synced from triggers)
        return this.portBreakpoints.map((pb, idx) => ({ ...pb, index: idx }));
    },

    clearPortBreakpoints() {
        this.clearTriggers(['port_in', 'port_out', 'port_io']);
    },

    formatPortBreakpoint(pb) {
        const hexFn = (v) => fmtPort(v, pb.is16bit);
        const defaultMask = pb.is16bit ? 0xFFFF : 0xFF;
        let str = hexFn(pb.port);
        if (pb.mask !== defaultMask) {
            str += '&' + hexFn(pb.mask);
        }
        str += ' (' + pb.direction.toUpperCase() + ')';
        return str;
    },

    checkPortBreakpoint(port, direction) {
        // Use unified trigger system
        const isOut = direction === 'out';
        const trigger = this.checkPortTriggers(port, 0, isOut);
        if (trigger) {
            // Return in legacy format for compatibility
            return {
                port: trigger.start,
                mask: trigger.mask,
                is16bit: trigger.start > 0xff || trigger.mask > 0xff,
                direction: trigger.type === 'port_in' ? 'in' : trigger.type === 'port_out' ? 'out' : 'both'
            };
        }
        return null;
    },

    // ========== Debugging - Watchpoints ==========

    addWatchpoint(spec, type = 'both') {
        if (typeof spec === 'number') {
            spec = { start: spec & 0xffff, end: spec & 0xffff, page: null };
        } else if (typeof spec === 'string') {
            spec = this.parseAddressSpec(spec);
            if (!spec) return false;
        }
        // Map type to trigger type
        const typeMap = { 'read': 'read', 'write': 'write', 'both': 'rw' };
        const triggerType = typeMap[type] || 'rw';

        return this.addTrigger({
            type: triggerType,
            start: spec.start,
            end: spec.end,
            page: spec.page
        }) >= 0;
    },

    removeWatchpoint(index) {
        // Find the corresponding trigger in the unified array
        const memTriggers = this.triggers
            .map((t, i) => ({ ...t, triggerIndex: i }))
            .filter(t => ['read', 'write', 'rw'].includes(t.type));
        if (index >= 0 && index < memTriggers.length) {
            return this.removeTrigger(memTriggers[index].triggerIndex);
        }
        return false;
    },

    hasWatchpoint(addr) {
        addr = addr & 0xffff;
        return this.triggers.some(t =>
            ['read', 'write', 'rw'].includes(t.type) && t.enabled &&
            addr >= t.start && addr <= t.end);
    },

    getWatchpoint(addr) {
        addr = addr & 0xffff;
        for (const t of this.triggers) {
            if (!['read', 'write', 'rw'].includes(t.type) || !t.enabled) continue;
            if (addr >= t.start && addr <= t.end) {
                if (t.page === null || t.page === this.getCurrentPageForAddr(addr)) {
                    // Return in legacy format
                    return {
                        start: t.start,
                        end: t.end,
                        page: t.page,
                        read: t.type === 'read' || t.type === 'rw',
                        write: t.type === 'write' || t.type === 'rw'
                    };
                }
            }
        }
        return null;
    },

    getWatchpoints() {
        // Return from legacy array (synced from triggers)
        return this.watchpoints.map((wp, idx) => ({ ...wp, index: idx }));
    },

    clearWatchpoints() {
        this.clearTriggers(['read', 'write', 'rw']);
    },

    formatWatchpoint(wp) {
        let str = '';
        if (wp.page !== null) {
            str += (typeof wp.page === 'string' ? wp.page : wp.page.toString()) + ':';
        }
        str += hex16(wp.start);
        if (wp.end !== wp.start) {
            str += '-' + hex16(wp.end);
        }
        str += ' (';
        if (wp.read && wp.write) str += 'R/W';
        else if (wp.read) str += 'R';
        else if (wp.write) str += 'W';
        str += ')';
        return str;
    },

    checkReadWatchpoint(addr, val) {
        if (!this.running || this.triggers.length === 0) return;
        // Use unified trigger system
        const trigger = this.checkMemTriggers(addr, val, false);
        if (trigger) {
            this.watchpointHit = true;
            this.triggerHit = true;
            this.lastWatchpoint = { addr, type: 'read', val, instrPC: this._currentInstrPC };
            this.lastTrigger = { trigger, addr, val, type: 'read', instrPC: this._currentInstrPC };
        }
    },

    checkWriteWatchpoint(addr, val) {
        if (!this.running || this.triggers.length === 0) return;
        // Use unified trigger system
        const trigger = this.checkMemTriggers(addr, val, true);
        if (trigger) {
            this.watchpointHit = true;
            this.triggerHit = true;
            this.lastWatchpoint = { addr, type: 'write', val, instrPC: this._currentInstrPC };
            this.lastTrigger = { trigger, addr, val, type: 'write', instrPC: this._currentInstrPC };
        }
    },

    // ========== Unified Trigger System ==========

    /**
     * Add a trigger (unified breakpoint/watchpoint/port breakpoint)
     * @param {Object} trigger - Trigger object with properties:
     *   type: 'exec'|'read'|'write'|'rw'|'port_in'|'port_out'|'port_io'
     *   start: number - Address or port number
     *   end: number - End of range (= start for single)
     *   page: number|string|null - Memory page (null = any)
     *   mask: number - Port mask (for port types)
     *   condition: string - Condition expression
     *   enabled: boolean - Whether trigger is active
     *   hitCount: number - Times triggered
     *   log: boolean - Log without breaking
     *   name: string - Optional description
     * @returns {number} Index of added trigger, or -1 if duplicate
     */
    addTrigger(trigger) {
        const isMedia = trigger.type === 'tape_block' || trigger.type === 'disk_read' || trigger.type === 'disk_sector';
        const isScreen = trigger.type === 'screen_bitmap' || trigger.type === 'screen_attr';

        // Normalize trigger
        const t = {
            type: trigger.type || 'exec',
            start: isMedia || isScreen ? (trigger.start || 0) : trigger.start & 0xffff,
            end: isMedia || isScreen ? (trigger.end !== undefined ? trigger.end : 0) : (trigger.end !== undefined ? trigger.end : trigger.start) & 0xffff,
            page: trigger.page !== undefined ? trigger.page : null,
            mask: trigger.mask !== undefined ? trigger.mask : 0xffff,
            condition: trigger.condition || '',
            enabled: trigger.enabled !== false,
            hitCount: trigger.hitCount || 0,
            skipCount: trigger.skipCount || 0,
            log: trigger.log || false,
            name: trigger.name || ''
        };

        // Screen trigger properties
        if (isScreen) {
            t.col = trigger.col || 0;
            t.row = trigger.row || 0;
            t.w = trigger.w || 1;
            t.h = trigger.h || 1;
            t.pixelMode = trigger.pixelMode || false;
            t.screen = trigger.screen || 'normal';
            t.start = 0;
            t.end = 0;
        }

        // For port types, default mask based on port value
        if (t.type.startsWith('port') && trigger.mask === undefined) {
            t.mask = t.start > 0xff ? 0xffff : 0xff;
        }

        // Check for duplicate
        for (const existing of this.triggers) {
            if (existing.type !== t.type) continue;
            // tape_block and disk_read: only one of each type
            if (t.type === 'tape_block' || t.type === 'disk_read') {
                if (t.skipCount !== existing.skipCount) {
                    existing.skipCount = t.skipCount;
                    existing.hitCount = 0;
                }
                return this.triggers.indexOf(existing);
            }
            // disk_sector: same track + sector = duplicate
            if (t.type === 'disk_sector') {
                if (existing.start === t.start && existing.end === t.end) {
                    if (t.skipCount !== existing.skipCount) {
                        existing.skipCount = t.skipCount;
                        existing.hitCount = 0;
                    }
                    return this.triggers.indexOf(existing);
                }
                continue;
            }
            // Screen triggers: same col/row/w/h/screen = duplicate
            if (isScreen) {
                if (existing.col === t.col && existing.row === t.row &&
                    existing.w === t.w && existing.h === t.h &&
                    existing.screen === t.screen && existing.pixelMode === t.pixelMode) {
                    if (t.condition && t.condition !== existing.condition) {
                        existing.condition = t.condition;
                    }
                    return this.triggers.indexOf(existing);
                }
                continue;
            }
            // Original duplicate check for other types
            if (existing.start === t.start &&
                existing.end === t.end &&
                existing.page === t.page &&
                existing.mask === t.mask) {
                // Update existing trigger's condition if different
                if (t.condition && t.condition !== existing.condition) {
                    existing.condition = t.condition;
                }
                return this.triggers.indexOf(existing);
            }
        }

        this.triggers.push(t);
        this._syncLegacyArrays();
        this.updateMemoryCallbacksFlag();
        return this.triggers.length - 1;
    },

    /**
     * Remove a trigger by index
     */
    removeTrigger(index) {
        if (index >= 0 && index < this.triggers.length) {
            this.triggers.splice(index, 1);
            this._syncLegacyArrays();
            this.updateMemoryCallbacksFlag();
            return true;
        }
        return false;
    },

    /**
     * Toggle a trigger's enabled state
     */
    toggleTrigger(index) {
        if (index >= 0 && index < this.triggers.length) {
            this.triggers[index].enabled = !this.triggers[index].enabled;
            // Rebuild exec breakpoint Set if this is an exec trigger
            if (this.triggers[index].type === 'exec') {
                this._rebuildExecBreakpointSet();
            }
            // Rebuild screen breakpoint Sets if this is a screen trigger
            if (this.triggers[index].type === 'screen_bitmap' || this.triggers[index].type === 'screen_attr') {
                this._rebuildScreenBreakpointSets();
            }
            return this.triggers[index].enabled;
        }
        return null;
    },

    /**
     * Get all triggers, optionally filtered by type
     * @param {string|string[]} type - Optional type or array of types to filter
     */
    getTriggers(type = null) {
        if (!type) return this.triggers.map((t, i) => ({ ...t, index: i }));
        const types = Array.isArray(type) ? type : [type];
        return this.triggers
            .map((t, i) => ({ ...t, index: i }))
            .filter(t => types.includes(t.type));
    },

    /**
     * Clear all triggers, optionally filtered by type
     */
    clearTriggers(type = null) {
        if (!type) {
            this.triggers = [];
        } else {
            const types = Array.isArray(type) ? type : [type];
            this.triggers = this.triggers.filter(t => !types.includes(t.type));
        }
        this._syncLegacyArrays();
        this.updateMemoryCallbacksFlag();
    },

    /**
     * Format a trigger for display
     */
    formatTrigger(t) {
        let str = '';

        if (t.type === 'tape_block') {
            str = 'TAPE';
            if (t.condition) str += ' if ' + t.condition;
            return str;
        }
        if (t.type === 'disk_read') {
            str = 'DISK';
            if (t.condition) str += ' if ' + t.condition;
            return str;
        }
        if (t.type === 'disk_sector') {
            str = 'T' + String(t.start).padStart(2, '0') + ':S' + String(t.end).padStart(2, '0');
            if (t.condition) str += ' if ' + t.condition;
            return str;
        }
        if (t.type === 'screen_bitmap') {
            str = t.pixelMode
                ? `SCR px:${t.col},${t.row} ${t.w}\u00D7${t.h}`
                : `SCR ${t.col},${t.row} ${t.w}\u00D7${t.h}`;
            if (t.screen === 'shadow') str += ' (shadow)';
            else if (t.screen === 'both') str += ' (both)';
            if (t.condition) str += ' if ' + t.condition;
            return str;
        }
        if (t.type === 'screen_attr') {
            str = `ATTR ${t.col},${t.row} ${t.w}\u00D7${t.h}`;
            if (t.screen === 'shadow') str += ' (shadow)';
            else if (t.screen === 'both') str += ' (both)';
            if (t.condition) str += ' if ' + t.condition;
            return str;
        }

        const isPort = t.type.startsWith('port');

        if (isPort) {
            // Port trigger
            const hexFn = (v) => fmtPort(v, t.start > 0xff);
            const defaultMask = t.start > 0xff ? 0xffff : 0xff;
            str = hexFn(t.start);
            if (t.mask !== defaultMask) {
                str += '&' + hexFn(t.mask);
            }
        } else {
            // Memory trigger
            if (t.page !== null) {
                str += (typeof t.page === 'string' ? t.page : t.page.toString()) + ':';
            }
            // Display only -- parseAddressSpec still reads and the API still
            // takes hex, so a script's addBreakpoint('8000') never changes meaning.
            str += fmtAddr(t.start);
            if (t.end !== t.start) {
                str += '-' + fmtAddr(t.end);
            }
        }

        if (t.condition) {
            str += ' if ' + t.condition;
        }

        return str;
    },

    /**
     * Get trigger type display icon
     */
    getTriggerIcon(type) {
        const icons = {
            exec: '●',
            read: 'R',
            write: 'W',
            rw: 'RW',
            port_in: '⇐',
            port_out: '⇒',
            port_io: '⇔',
            tape_block: 'T',
            disk_read: 'D',
            disk_sector: 'S',
            screen_bitmap: '\u25A6',
            screen_attr: '\u25A4'
        };
        return icons[type] || '?';
    },

    /**
     * Get trigger type display label
     */
    getTriggerLabel(type) {
        const labels = {
            exec: 'Exec',
            read: 'Read',
            write: 'Write',
            rw: 'R/W',
            port_in: 'Port IN',
            port_out: 'Port OUT',
            port_io: 'Port I/O',
            tape_block: 'Tape Block',
            disk_read: 'Disk Read',
            disk_sector: 'Disk Sector',
            screen_bitmap: 'Write Bitmap',
            screen_attr: 'Write Attr'
        };
        return labels[type] || type;
    },

    /**
     * Check if an execution trigger matches at the given PC
     */
    checkExecTriggers(pc) {
        // Fast O(1) check using Set - skip iteration if PC not in any breakpoint range
        if (!this.execBreakpointSet.has(pc)) return null;
        // PC is in a breakpoint range - do full check for conditions, page, etc.
        for (const t of this.triggers) {
            if (t.type !== 'exec' || !t.enabled) continue;
            if (this._matchesTrigger(t, pc)) {
                t.hitCount++;
                if (t.hitCount > t.skipCount) {
                    return t;
                }
            }
        }
        return null;
    },

    /**
     * Check if a memory access trigger matches
     */
    checkMemTriggers(addr, val, isWrite) {
        const types = isWrite ? ['write', 'rw'] : ['read', 'rw'];
        for (const t of this.triggers) {
            if (!types.includes(t.type) || !t.enabled) continue;
            if (this._matchesTrigger(t, addr, val)) {
                t.hitCount++;
                if (t.hitCount > t.skipCount) {
                    return t;
                }
            }
        }
        return null;
    },

    /**
     * Check if a port access trigger matches
     */
    checkPortTriggers(port, val, isOut) {
        if (this.triggers.length === 0) return null;
        const types = isOut ? ['port_out', 'port_io'] : ['port_in', 'port_io'];
        for (const t of this.triggers) {
            if (!types.includes(t.type) || !t.enabled) continue;
            if (this._matchesPortTrigger(t, port, val)) {
                t.hitCount++;
                if (t.hitCount > t.skipCount) {
                    return t;
                }
            }
        }
        return null;
    },

    /**
     * Check if a tape block trigger should fire
     */
    checkTapeBlockTrigger(blockIndex) {
        for (const t of this.triggers) {
            if (t.type !== 'tape_block' || !t.enabled) continue;
            t.hitCount++;
            if (t.hitCount > t.skipCount) {
                return t;
            }
        }
        return null;
    },

    /**
     * Check if a disk read trigger should fire
     */
    checkDiskReadTrigger() {
        for (const t of this.triggers) {
            if (t.type !== 'disk_read' || !t.enabled) continue;
            t.hitCount++;
            if (t.hitCount > t.skipCount) {
                return t;
            }
        }
        return null;
    },

    /**
     * Check if a disk sector trigger should fire for specific track/sector
     */
    checkDiskSectorTrigger(track, sector) {
        for (const t of this.triggers) {
            if (t.type !== 'disk_sector' || !t.enabled) continue;
            if (t.start === track && t.end === sector) {
                t.hitCount++;
                if (t.hitCount > t.skipCount) {
                    return t;
                }
            }
        }
        return null;
    },

    /**
     * Check if a trigger matches an address
     */
    _matchesTrigger(t, addr, val = undefined) {
        addr = addr & 0xffff;
        if (addr < t.start || addr > t.end) return false;
        if (t.page !== null && t.page !== this.getCurrentPageForAddr(addr)) return false;
        if (t.condition) {
            return this.evaluateCondition(t.condition, { val });
        }
        return true;
    },

    /**
     * Check if a port trigger matches
     */
    _matchesPortTrigger(t, port, val) {
        if ((port & t.mask) !== (t.start & t.mask)) return false;
        if (t.condition) {
            return this.evaluateCondition(t.condition, { port, val });
        }
        return true;
    },

    /**
     * Sync legacy arrays from unified triggers for backward compatibility
     */
    _syncLegacyArrays() {
        // Rebuild breakpoints array from exec triggers
        this.breakpoints = this.triggers
            .filter(t => t.type === 'exec')
            .map(t => ({
                start: t.start,
                end: t.end,
                page: t.page,
                condition: t.condition
            }));

        // Rebuild watchpoints array from read/write/rw triggers
        this.watchpoints = this.triggers
            .filter(t => ['read', 'write', 'rw'].includes(t.type))
            .map(t => ({
                start: t.start,
                end: t.end,
                page: t.page,
                read: t.type === 'read' || t.type === 'rw',
                write: t.type === 'write' || t.type === 'rw'
            }));

        // Rebuild portBreakpoints array from port triggers
        this.portBreakpoints = this.triggers
            .filter(t => t.type.startsWith('port'))
            .map(t => ({
                port: t.start,
                mask: t.mask,
                is16bit: t.start > 0xff || t.mask > 0xff,
                direction: t.type === 'port_in' ? 'in' : t.type === 'port_out' ? 'out' : 'both'
            }));

        // Rebuild fast exec breakpoint Set
        this._rebuildExecBreakpointSet();

        // Rebuild screen breakpoint Sets
        this._rebuildScreenBreakpointSets();
    },

    /**
     * Rebuild the exec breakpoint Set for O(1) lookup
     */
    _rebuildExecBreakpointSet() {
        this.execBreakpointSet.clear();
        for (const t of this.triggers) {
            if (t.type === 'exec' && t.enabled) {
                // Add all addresses in range to the Set
                const end = t.end !== undefined ? t.end : t.start;
                for (let addr = t.start; addr <= end; addr++) {
                    this.execBreakpointSet.add(addr);
                }
            }
        }
    },

    /**
     * Parse trigger from address input string
     * Format: "[TYPE:]ADDR[-END]" where TYPE is optional
     */
    parseTriggerSpec(spec, defaultType = 'exec') {
        spec = spec.trim().toUpperCase();

        // Check for type prefix
        let type = defaultType;
        const colonIdx = spec.indexOf(':');
        if (colonIdx !== -1) {
            const prefix = spec.substring(0, colonIdx);
            // Check if it's a type prefix (not a page prefix like "5:" or "R0:")
            const typeMap = {
                'E': 'exec', 'EXEC': 'exec',
                'R': 'read', 'READ': 'read',
                'W': 'write', 'WRITE': 'write',
                'RW': 'rw',
                'PI': 'port_in', 'IN': 'port_in',
                'PO': 'port_out', 'OUT': 'port_out',
                'PIO': 'port_io', 'IO': 'port_io'
            };
            if (typeMap[prefix]) {
                type = typeMap[prefix];
                spec = spec.substring(colonIdx + 1);
            }
        }

        // Handle port types
        if (type.startsWith('port')) {
            const parsed = this.parsePortSpec(spec);
            if (!parsed) return null;
            return {
                type,
                start: parsed.port,
                end: parsed.port,
                mask: parsed.mask
            };
        }

        // Handle address types
        const parsed = this.parseAddressSpec(spec);
        if (!parsed) return null;
        return {
            type,
            start: parsed.start,
            end: parsed.end,
            page: parsed.page
        };
    }
};

// Mix the engine into a machine's prototype. What the machine defines itself
// (debugPageCount, say) stays its own.
export function mixTriggers(Machine) {
    for (const [k, v] of Object.entries(TriggerEngine)) {
        if (!Object.prototype.hasOwnProperty.call(Machine.prototype, k)) Machine.prototype[k] = v;
    }
}
