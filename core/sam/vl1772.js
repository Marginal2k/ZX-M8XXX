/**
 * ZX-M8XXX - SAM Coupé: the VL1772-02 floppy disk controller
 * @license GPL-3.0
 *
 * Ported from SimCoupe's Drive.cpp (Base/Drive.cpp, VL1772.h):
 *
 *   Copyright (c) 1999-2014 Simon Owen
 *   Copyright (c) 1996-2001 Allan Skillman
 *
 *   SimCoupe is free software under the GNU General Public License, version
 *   2 or (at your option) any later version; this port is under version 3.
 *
 * The controller sees the disk as SimCoupe does: a track is a list of sectors
 * with their ID fields and their status (core/sam/sam-disk.js), so a disk in
 * a program's own format (sizes, numbers, CRC errors, deleted data) reads as
 * it was made. A command runs when the host next looks at the status, as in
 * SimCoupe; the index pulse comes from a real rotation (300 rpm) instead of
 * SimCoupe's one-in-1024 status reads.
 */

// Status bits
export const BUSY = 0x01, INDEX_PULSE = 0x02, DRQ = 0x02, TRACK00 = 0x04, LOST_DATA = 0x04,
    CRC_ERROR = 0x08, SEEK_ERROR = 0x10, RECORD_NOT_FOUND = 0x10, SPIN_UP = 0x20,
    DELETED_DATA = 0x20, WRITE_FAULT = 0x20, WRITE_PROTECT = 0x40, MOTOR_ON = 0x80;
const TYPE23_ERROR_MASK = LOST_DATA | CRC_ERROR | RECORD_NOT_FOUND | WRITE_FAULT;

// Commands
const RESTORE = 0x00, SEEK = 0x10, STEP_NUPD = 0x20, STEP_UPD = 0x30, STEP_IN_NUPD = 0x40,
    STEP_IN_UPD = 0x50, STEP_OUT_NUPD = 0x60, STEP_OUT_UPD = 0x70,
    READ_1SECTOR = 0x80, READ_MSECTOR = 0x90, WRITE_1SECTOR = 0xA0, WRITE_MSECTOR = 0xB0,
    READ_ADDRESS = 0xC0, FORCE_INTERRUPT = 0xD0, READ_TRACK = 0xE0, WRITE_TRACK = 0xF0;
const CMD_FLAG_SPINUP = 0x08, CMD_FLAG_UPDATE = 0x10, CMD_FLAG_DIR = 0x20, CMD_FLAG_STEPDIR = 0x40,
    CMD_FLAG_MULTIPLE = 0x10;

export const MAX_TRACK_SIZE = 6250;
const MOTOR_TIMEOUT_FRAMES = 100;           // 10 revolutions at 300 rpm: 2 seconds
const INDEX_PULSE_SHARE = 1.5 / 200;        // 1.5 ms of each 200 ms revolution

export const sizeFromCode = (code) => 128 << (code & 3);

// CRC-CCITT as the controller computes it (SimCoupe's CrcBlock)
export function crcBlock(bytes, crc = 0xFFFF) {
    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i] << 8;
        for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc;
}

export class VL1772 {
    /**
     * @param {() => number} now  T-states, monotonic (the rotation clock)
     * @param {number} rev        T-states a revolution
     */
    constructor(now = () => 0, rev = 1) {
        this.now = now;
        this.rev = rev;
        this.disk = null;
        this.statusReadsIdle = 0;
        this.reset();
    }

    reset() {
        this.command = 0;
        this.status = 0;
        this.regCyl = 0xFF;
        this.regSector = 1;
        this.regData = 0;
        this.dirOut = false;
        this.cyl = this.cyl || 0;                // the head stays where it is
        this.head = 0;
        this.sectorIndex = 0;
        this.buffer = new Uint8Array(0);
        this.bufferPos = 0;
        this.dataStatus = 0;
        this.statusReadsWithData = 0;
        this.state = 0;
        this.motorOffFrames = 0;
    }

    insert(disk) { this.disk = disk; }
    eject() { this.disk = null; }

    frameEnd() {
        if (this.motorOffFrames && !--this.motorOffFrames) this.status &= ~MOTOR_ON;
    }

    _modify(set, reset) {
        if (set & MOTOR_ON) this.motorOffFrames = MOTOR_TIMEOUT_FRAMES;
        this.status = (this.status | set) & ~reset;
    }

    _readStatus() {
        if (this.dataStatus & ~CRC_ERROR) this._modify(this.dataStatus, BUSY);
        else this._modify(DRQ, 0);
    }

    _getSector(index) {
        return this.disk ? this.disk.getSector(this.cyl, this.head, index) : { status: RECORD_NOT_FOUND };
    }

    // The sector the registers name, looked for over two turns of the track
    _findSector() {
        this.sectorIndex = 0;
        for (let turns = 0; turns < 2;) {
            const s = this._getSector(this.sectorIndex);
            if (s.status & RECORD_NOT_FOUND) { turns++; this.sectorIndex = 0; continue; }
            if (s.id.cyl === this.regCyl && s.id.sector === this.regSector) return s.id;
            this.sectorIndex++;
        }
        return null;
    }

    _readSector() { return this.disk.readData(this.cyl, this.head, this.sectorIndex); }

    _readAddress() {
        let s = this._getSector(this.sectorIndex++);
        if (!(s.status & RECORD_NOT_FOUND)) return s;
        this.sectorIndex = 0;
        s = this._getSector(this.sectorIndex++);
        return s;
    }

    _executeNext() {
        if (!this.disk) return;
        switch (this.command & 0xF0) {
            case READ_1SECTOR:
            case READ_MSECTOR:
                if (this._findSector()) {
                    const r = this._readSector();
                    this.dataStatus = r.status;
                    this.buffer = r.data;
                    this.bufferPos = 0;
                    this._readStatus();
                } else {
                    this._modify(RECORD_NOT_FOUND, BUSY);
                }
                break;

            case WRITE_1SECTOR:
            case WRITE_MSECTOR:
                if (this.state === 0) {
                    const id = this._findSector();
                    if (!id) this._modify(RECORD_NOT_FOUND, BUSY);
                    else if (this.disk.writeProtected) this._modify(WRITE_PROTECT, BUSY);
                    else {
                        this.buffer = new Uint8Array(sizeFromCode(id.size));
                        this.bufferPos = 0;
                        this._modify(DRQ, 0);
                        this.state++;
                    }
                } else {
                    this._modify(0, BUSY);
                }
                break;

            case READ_ADDRESS: {
                const s = this._readAddress();
                if (!(s.status & TYPE23_ERROR_MASK)) {
                    const id = s.id;
                    this.regSector = id.cyl;
                    this.buffer = Uint8Array.of(id.cyl, id.head, id.sector, id.size, id.crc1, id.crc2);
                    this.bufferPos = 0;
                    this._modify(DRQ, 0);
                } else {
                    this._modify(s.status, BUSY);
                    this.bufferPos = 0;
                }
                break;
            }

            case READ_TRACK:
                this.buffer = this._readTrack();
                this.bufferPos = 0;
                this._modify(DRQ, 0);
                break;

            case WRITE_TRACK:
                if (this.disk.writeProtected) this._modify(WRITE_PROTECT, BUSY);
                else if (this.state === 0) {
                    this.buffer = new Uint8Array(MAX_TRACK_SIZE);
                    this.bufferPos = 0;
                    this._modify(DRQ, 0);
                    this.state++;
                } else {
                    this._modify(0, BUSY);
                }
                break;
        }
    }

    _indexPulse() {
        const p = this.now() % this.rev;
        return p >= 0 && p < this.rev * INDEX_PULSE_SHARE;
    }

    // reg: 0 status, 1 track, 2 sector, 3 data
    read(reg) {
        if ((this.status & (BUSY | DRQ)) === BUSY) this._executeNext();

        switch (reg & 3) {
            case 0: {
                let st = this.status;
                if ((this.command & 0xF0) <= STEP_OUT_UPD) {
                    if (this.cyl === 0) { st |= TRACK00; this.regCyl = 0; }
                    if (this.disk) {
                        if (this.disk.writeProtected) st |= WRITE_PROTECT;
                        if (!(this.command & CMD_FLAG_SPINUP)) st |= SPIN_UP;
                        if ((this.status & MOTOR_ON) && this._indexPulse()) st |= INDEX_PULSE;
                    }
                    return st;
                }
                // 16 looks at the status with data waiting and no data taken:
                // the data is lost (SAM DICE syncs on this; Legend of Eshan
                // issues READ ADDRESS twice without reading what it returned)
                if ((this.status & DRQ) && ++this.statusReadsWithData === 0x10) {
                    this._modify(LOST_DATA, BUSY | DRQ);
                    this.sectorIndex = 0;
                    this.statusReadsWithData = 0;
                }
                return this.status;
            }
            case 1: return this.regCyl;
            case 2: return this.regSector;
            case 3:
                if ((this.status & DRQ) && this.bufferPos < this.buffer.length) {
                    this.regData = this.buffer[this.bufferPos++];
                    this.statusReadsWithData = 0;
                    if (this.bufferPos === this.buffer.length) {
                        this._modify(0, BUSY | DRQ);
                        switch (this.command & 0xF0) {
                            case READ_TRACK: this._modify(RECORD_NOT_FOUND, 0); break;
                            case READ_1SECTOR: this._modify(this.dataStatus, 0); break;
                            case READ_MSECTOR:
                                this._modify(this.dataStatus, 0);
                                if (!this.dataStatus) {
                                    this.regSector = (this.regSector + 1) & 0xFF;
                                    if (this._findSector()) {
                                        const r = this._readSector();
                                        this.dataStatus = r.status;
                                        this.buffer = r.data;
                                        this.bufferPos = 0;
                                        this._readStatus();
                                    }
                                }
                                break;
                        }
                    }
                }
                return this.regData;
        }
        return 0xFF;
    }

    // side: A2 of the port, which the SAM wires to the head select
    write(reg, val, side) {
        this.head = side & 1;
        switch (reg & 3) {
            case 0: {
                this.command = val;
                const cmd = val & 0xF0;
                if ((this.status & BUSY) && cmd !== FORCE_INTERRUPT) return;
                this.status &= MOTOR_ON;
                this._modify(MOTOR_ON, 0);
                this.state = 0;
                switch (cmd) {
                    case RESTORE: this.regCyl = this.cyl = 0; break;
                    case SEEK:
                        this.dirOut = this.regData > this.regCyl;
                        this.regCyl = this.cyl = this.regData;
                        break;
                    case STEP_UPD: case STEP_NUPD: case STEP_IN_UPD: case STEP_IN_NUPD:
                    case STEP_OUT_UPD: case STEP_OUT_NUPD:
                        if (val & CMD_FLAG_STEPDIR) this.dirOut = !!(val & CMD_FLAG_DIR);
                        if (!this.dirOut) this.cyl = Math.min(this.cyl + 1, 255);
                        else if (this.cyl > 0) this.cyl--;
                        if (val & CMD_FLAG_UPDATE) this.regCyl = this.cyl;
                        break;
                    case READ_1SECTOR: case READ_MSECTOR: case WRITE_1SECTOR: case WRITE_MSECTOR:
                    case READ_ADDRESS: case READ_TRACK: case WRITE_TRACK:
                        this._modify(BUSY, 0);
                        break;
                    case FORCE_INTERRUPT:
                        this.status &= MOTOR_ON;
                        this._modify(MOTOR_ON, 0);
                        this.command = 0;
                        this.bufferPos = 0;
                        break;
                }
                break;
            }
            case 1: if (!(this.status & BUSY)) this.regCyl = val; break;
            case 2: if (!(this.status & BUSY)) this.regSector = val; break;
            case 3:
                this.regData = val;
                if ((this.status & DRQ) && this.bufferPos < this.buffer.length) {
                    this.buffer[this.bufferPos++] = val;
                    this.statusReadsWithData = 0;
                    if (this.bufferPos === this.buffer.length) {
                        this._modify(0, BUSY | DRQ);
                        switch (this.command & 0xF0) {
                            case WRITE_1SECTOR:
                            case WRITE_MSECTOR:
                                this._modify(this.disk.writeData(this.cyl, this.head, this.sectorIndex, this.buffer), 0);
                                if (this.command & CMD_FLAG_MULTIPLE) {
                                    this.regSector = (this.regSector + 1) & 0xFF;
                                    const id = this._findSector();
                                    if (id) {
                                        this.buffer = new Uint8Array(sizeFromCode(id.size));
                                        this.bufferPos = 0;
                                        this._modify(DRQ, 0);
                                    }
                                }
                                break;
                            case WRITE_TRACK:
                                this._modify(this._writeTrack(this.buffer), 0);
                                break;
                        }
                    }
                }
                break;
        }
    }

    // ---- whole tracks ----
    _readTrack() {
        const out = [];
        const add = (v, n = 1) => { for (let i = 0; i < n; i++) out.push(v); };
        this.sectorIndex = 0;
        add(0x4E, 32);                                     // gap 4a
        for (;;) {
            const s = this._getSector(this.sectorIndex++);
            if (s.status & RECORD_NOT_FOUND) break;
            const id = s.id;
            add(0x4E, 22); add(0x00, 12);                  // gap 1/3, sync
            add(0xA1, 3); add(0xFE);                       // IDAM
            out.push(id.cyl, id.head, id.sector, id.size, id.crc1, id.crc2);
            add(0x4E, 22); add(0x00, 8);                   // gap 2, sync
            if (!(s.status & CRC_ERROR)) {
                const start = out.length;
                this.sectorIndex--;                        // the data of this sector
                const r = this._readSector();
                this.sectorIndex++;
                add(0xA1, 3); add((r.status & DELETED_DATA) ? 0xF8 : 0xFB);
                for (const b of r.data) out.push(b);
                const crc = crcBlock(out.slice(start)) ^ (r.status & CRC_ERROR);
                out.push(crc >> 8, crc & 0xFF);
            }
        }
        while (out.length < MAX_TRACK_SIZE) out.push(0x4E);  // gap 4b
        return Uint8Array.from(out.slice(0, MAX_TRACK_SIZE));
    }

    // The byte stream of a Write Track, back into sectors
    _writeTrack(data) {
        if (!this.disk) return WRITE_PROTECT;
        const sectors = [];
        const end = data.length;
        let p = data.indexOf(0x4E);
        const expect = (val, min, max = Infinity) => {
            for (; p < end && data[p] === val && max; p++, min--, max--);
            return min <= 0 && max >= 0;
        };
        if (p >= 0 && expect(0x4E, 32)) {
            while (p < end) {
                let valid = true;
                const id = { cyl: 0, head: 0, sector: 0, size: 0 };
                let sdata = null;
                valid = expect(0x00, 12, 12) && valid;
                valid = expect(0xF5, 3, 3) && valid;
                valid = expect(0xFE, 1, 1) && valid;
                valid = valid && p + 6 <= end;
                if (valid) { id.cyl = data[p]; id.head = data[p + 1]; id.sector = data[p + 2]; id.size = data[p + 3]; p += 4; }
                valid = expect(0xF7, 1, 1) && valid;
                valid = expect(0x4E, 22) && valid;
                valid = expect(0x00, 8) && valid;
                valid = expect(0xF5, 3, 3) && valid;
                valid = (expect(0xFB, 1, 1) || expect(0xF8, 1, 1)) && valid;
                const size = sizeFromCode(id.size);
                valid = valid && p + size < end;
                if (valid) { sdata = data.slice(p, p + size); p += size; }
                valid = expect(0xF7, 1, 1) && valid;
                valid = expect(0x4E, 16) && valid;
                sectors.push({ id, data: sdata });
                if (!valid) break;
            }
        }
        return this.disk.formatTrack(this.cyl, this.head, sectors);
    }
}
