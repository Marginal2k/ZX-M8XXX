/**
 * ZX-M8XXX - SAM Coupé: SAM BASIC programs as text
 * @license GPL-3.0
 *
 * A SAM BASIC program is laid out as the Spectrum's: each line its number
 * (2 bytes, high first), its length (2 bytes, low first), the line and a
 * 0x0D; a number written in the line is followed by 0x0E and its 5-byte
 * form; a byte 0xFF where a line number would be ends the program.
 *
 * The keywords are the SAM ROM's (its table at ROM1 38C9, names in the order
 * of their codes):
 * - commands are one byte, 0x85 (USING) to 0xFE;
 * - functions and operators are two, 0xFF then 0x3B (PI) to 0x83 (>=).
 * Codes the ROM keeps free ('-' in its table) show as [FF xx] or [xx].
 *
 * The result has the shape of core/basic-tokens.js decodeBasicProgram's
 * ({ number, offset, text, tokens, obfuscations } per line), so the
 * Explorer shows and copies it the same way.
 */

import { parseFloat5 } from '../basic-tokens.js';

const FUNCTIONS = [
    'PI', 'RND', 'POINT', 'FREE', 'LENGTH', 'ITEM', 'ATTR', 'FN', 'BIN', 'XMOUSE',
    'YMOUSE', 'XPEN', 'YPEN', 'RAMTOP', null, 'INSTR', 'INKEY$', 'SCREEN$', 'MEM$', null,
    'PATH$', 'STRING$', null, null, 'SIN', 'COS', 'TAN', 'ASN', 'ACS', 'ATN',
    'LN', 'EXP', 'ABS', 'SGN', 'SQR', 'INT', 'USR', 'IN', 'PEEK', 'DPEEK',
    'DVAR', 'SVAR', 'BUTTON', 'EOF', 'PTR', null, 'UDG', null, 'LEN', 'CODE',
    'VAL$', 'VAL', 'TRUNC$', 'CHR$', 'STR$', 'BIN$', 'HEX$', 'USR$', null, 'NOT',
    null, null, null, 'MOD', 'DIV', 'BOR', null, 'BAND', 'OR', 'AND',
    '<>', '<=', '>=',
];
const FN_FIRST = 0x3B;

const COMMANDS = [
    'USING', 'WRITE', 'AT', 'TAB', 'OFF', 'WHILE', 'UNTIL', 'LINE', 'THEN', 'TO',
    'STEP', 'DIR', 'FORMAT', 'ERASE', 'MOVE', 'SAVE', 'LOAD', 'MERGE', 'VERIFY', 'OPEN',
    'CLOSE', 'CIRCLE', 'PLOT', 'LET', 'BLITZ', 'BORDER', 'CLS', 'PALETTE', 'PEN', 'PAPER',
    'FLASH', 'BRIGHT', 'INVERSE', 'OVER', 'FATPIX', 'CSIZE', 'BLOCKS', 'MODE', 'GRAB', 'PUT',
    'BEEP', 'SOUND', 'NEW', 'RUN', 'STOP', 'CONTINUE', 'CLEAR', 'GO TO', 'GO SUB', 'RETURN',
    'REM', 'READ', 'DATA', 'RESTORE', 'PRINT', 'LPRINT', 'LIST', 'LLIST', 'DUMP', 'FOR',
    'NEXT', 'PAUSE', 'DRAW', 'DEFAULT', 'DIM', 'INPUT', 'RANDOMIZE', 'DEF FN', 'DEF KEYCODE', 'DEF PROC',
    'END PROC', 'RENUM', 'DELETE', 'REF', 'COPY', null, 'KEYIN', 'LOCAL', 'LOOP IF', 'DO',
    'LOOP', 'EXIT IF', 'IF', 'IF', 'ELSE', 'ELSE', 'END IF', 'KEY', 'ON ERROR', 'ON',
    'GET', 'OUT', 'POKE', 'DPOKE', 'RENAME', 'CALL', 'ROLL', 'SCROLL', 'SCREEN', 'DISPLAY',
    'BOOT', 'LABEL', 'FILL', 'WINDOW', 'AUTO', 'POP', 'RECORD', 'DEVICE', 'PROTECT', 'HIDE',
    'ZAP', 'POW', 'BOOM', 'ZOOM',
];
const CMD_FIRST = 0x85;
// every keyword, for a highlighter
export const SAM_KEYWORDS = [...new Set([...FUNCTIONS, ...COMMANDS].filter(Boolean))];

const REM = CMD_FIRST + COMMANDS.indexOf('REM');

// the SAM's colour codes in a line (PEN for the Spectrum's INK)
const CONTROL = { 0x10: 'PEN', 0x11: 'PAPER', 0x12: 'FLASH', 0x13: 'BRIGHT', 0x14: 'INVERSE', 0x15: 'OVER', 0x16: 'AT', 0x17: 'TAB' };

const hx = (b) => b.toString(16).toUpperCase().padStart(2, '0');

function formatNumber(n) {
    if (n === null || n === undefined) return '?';
    if (Number.isInteger(n)) return n.toString();
    return parseFloat(n.toPrecision(10)).toString();
}

// the keyword at data[i] outside a string, or null: { word, size, fn }
export function samKeyword(data, i) {
    const b = data[i];
    if (b === 0xFF && i + 1 < data.length) {
        const w = FUNCTIONS[data[i + 1] - FN_FIRST];
        return { word: w || `[FF ${hx(data[i + 1])}]`, size: 2, fn: true };
    }
    if (b >= CMD_FIRST && b < 0xFF) {
        const w = COMMANDS[b - CMD_FIRST];
        return { word: w || `[${hx(b)}]`, size: 1, fn: false };
    }
    return null;
}

function decodeLine(data, deobfuscate) {
    let text = '';
    const tokens = [], obfuscations = [];
    let inString = false, inRem = false;
    let digits = '', digitsText = -1, digitsTok = -1;
    let kwEnd = -1;                                         // where the last keyword ends in text        // a number as written, before its 0x0E
    const resetDigits = () => { digits = ''; digitsText = -1; digitsTok = -1; };
    const isWordChar = (c) => /[A-Za-z0-9$")]/.test(c);
    let i = 0;
    while (i < data.length) {
        const b = data[i];
        if (b === 0x0D) break;

        if (inRem) {
            if (CONTROL[b]) {
                const n = b >= 0x16 ? 2 : 1, params = Array.from(data.subarray(i + 1, i + 1 + n));
                text += `{${CONTROL[b]} ${params.join(',')}}`;
                tokens.push({ type: 'control', name: CONTROL[b], params });
                i += 1 + n; continue;
            }
            if (b >= 0x20 && b < 0x7F) { text += String.fromCharCode(b); tokens.push({ type: 'text', value: String.fromCharCode(b) }); }
            else { text += `[${hx(b)}]`; tokens.push({ type: 'hex', value: hx(b) }); }
            i++; continue;
        }

        if (b === 0x0E && !inString) {
            const v = parseFloat5(Array.from(data.subarray(i + 1, i + 6)));
            const shown = digits.trim();
            // after a name, the 5 bytes are no number: SAM BASIC keeps a
            // procedure call's hidden pointer there
            if (shown === '' && /[A-Za-z0-9$_]$/.test(text)) { resetDigits(); i += 6; continue; }
            // as written: decimal, &hex, or binary after BIN
            const asWritten = shown.startsWith('&') ? parseInt(shown.slice(1), 16)
                : /BIN *$/.test(text.substring(0, digitsText)) ? parseInt(shown, 2)
                : parseFloat(shown.startsWith('.') ? '0' + shown : shown);
            if (shown === '' || isNaN(asWritten) || Math.abs(asWritten - v) >= 0.0001) {
                obfuscations.push({ ascii: shown || '(hidden)', actual: v });
                if (deobfuscate) {
                    if (digitsText >= 0) text = text.substring(0, digitsText);
                    if (digitsTok >= 0) tokens.length = digitsTok;
                    text += `{{${formatNumber(v)}}}`;
                    tokens.push({ type: 'number', value: `{{${formatNumber(v)}}}` });
                }
            }
            resetDigits();
            i += 6; continue;
        }

        if (b === 0x22) {
            inString = !inString;
            text += '"'; tokens.push({ type: 'string_delim' });
            resetDigits();
            i++; continue;
        }

        if (inString) {
            if (b >= 0x20 && b < 0x7F) { text += String.fromCharCode(b); tokens.push({ type: 'string_char', value: String.fromCharCode(b) }); }
            else if (b === 0x7F) { text += '©'; tokens.push({ type: 'string_char', value: '©' }); }
            else if (CONTROL[b]) {
                const n = b >= 0x16 ? 2 : 1, params = Array.from(data.subarray(i + 1, i + 1 + n));
                text += `{${CONTROL[b]} ${params.join(',')}}`;
                tokens.push({ type: 'control', name: CONTROL[b], params });
                i += n;
            } else if (b >= 0x80 && b <= 0x8F) { text += '[BLK]'; tokens.push({ type: 'block', byte: b }); }
            else if (b >= 0x90 && b <= 0xA8) {
                const l = String.fromCharCode(65 + b - 0x90);
                text += `[UDG-${l}]`; tokens.push({ type: 'udg', letter: l });
            } else { text += `[${hx(b)}]`; tokens.push({ type: 'hex', value: hx(b) }); }
            i++; continue;
        }

        const kw = samKeyword(data, i);
        if (kw) {
            const word = /^[A-Z]/.test(kw.word);
            if (word && text && !text.endsWith(' ') && isWordChar(text[text.length - 1])) { text += ' '; tokens.push({ type: 'space' }); }
            text += kw.word;
            tokens.push({ type: 'keyword', value: kw.word });
            i += kw.size;
            // a space after a command, and after a function when a word follows
            const next = data[i];
            const wordNext = next !== undefined && next !== 0x0D && next !== 0x20 &&
                (!kw.fn || next === 0x22 || next >= 0x80 || /[A-Za-z0-9]/.test(String.fromCharCode(next)));
            if (word && wordNext && !(kw.fn === false && (next === 0x3A || next === 0x3B || next === 0x2C))) { text += ' '; tokens.push({ type: 'space' }); }
            kwEnd = text.length;
            if (data[i - kw.size] === REM && kw.size === 1) inRem = true;
            resetDigits();
            continue;
        }

        if (CONTROL[b]) {
            const n = b >= 0x16 ? 2 : 1, params = Array.from(data.subarray(i + 1, i + 1 + n));
            text += `{${CONTROL[b]} ${params.join(',')}}`;
            tokens.push({ type: 'control', name: CONTROL[b], params });
            resetDigits();
            i += 1 + n; continue;
        }

        if (b >= 0x20 && b < 0x7F) {
            const c = String.fromCharCode(b);
            // a number starts with a digit, '.' or '&', not inside a name (a1, spage)
            const inName = !digits && text.length !== kwEnd && /[A-Za-z0-9_$]$/.test(text);
            const numChar = digits.startsWith('&') ? (/[0-9A-Fa-f]/.test(c) && !digits.endsWith(' '))
                : digits ? (/[0-9.eE]/.test(c) || (/[+-]/.test(c) && /[eE]$/.test(digits)))
                : !inName && /[0-9.&]/.test(c);
            if (numChar) {
                if (digitsText < 0) { digitsText = text.length; digitsTok = tokens.length; }
                digits += c;
            } else if (b === 0x20 && digits) digits += ' ';
            else resetDigits();
            text += c;
            tokens.push(b === 0x20 ? { type: 'space' } : b === 0x3A ? { type: 'colon' } : { type: 'text', value: c });
        } else {
            resetDigits();
            if (b === 0x7F) { text += '©'; tokens.push({ type: 'text', value: '©' }); }
            else if (b >= 0x80) { text += `[${hx(b)}]`; tokens.push({ type: 'hex', value: hx(b) }); }
        }
        i++;
    }
    return { text: text.trim(), tokens, obfuscations };
}

// A SAM BASIC program (Uint8Array, without its file header) as lines of text
export function decodeSamBasicProgram(data, options) {
    const deobfuscate = !options || options.deobfuscate !== false;
    const lines = [];
    let offset = 0;
    while (offset + 4 <= data.length && data[offset] !== 0xFF) {
        const number = (data[offset] << 8) | data[offset + 1];
        let len = data[offset + 2] | (data[offset + 3] << 8);
        if (len === 0) break;
        len = Math.min(len, data.length - offset - 4);
        const d = decodeLine(data.subarray(offset + 4, offset + 4 + len), deobfuscate);
        lines.push({ number, offset, text: d.text, tokens: d.tokens, obfuscations: d.obfuscations });
        offset += 4 + len;
    }
    return lines;
}
