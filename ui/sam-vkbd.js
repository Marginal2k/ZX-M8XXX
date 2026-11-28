// sam-vkbd.js — an on-screen SAM Coupé keyboard, for phones and tablets.
//
// The SAM's keys as its keyboard has them (the function keypad as a row on
// top, the cursor keys at the bottom right), drawn with the Spectrum
// player's keyboard styles (css/vkbd.css). SHIFT, SYMBOL and CNTRL stick:
// a tap arms one, the next key is pressed with it and lets it go.
//
//   const kb = createSamKeyboard({ parent, machine });
//   kb.show(true); kb.toggle(); kb.destroy();

const ROWS = [
    ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F0'],
    ['ESC', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '+', 'DELETE'],
    ['TAB', 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '=', '"'],
    ['CAPS', 'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', ':', 'EDIT', 'RETURN'],
    ['SHIFT', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', 'INV'],
    ['CNTRL', 'SYMBOL', 'SPACE', 'LEFT', 'UP', 'DOWN', 'RIGHT'],
];
const LABEL = { DELETE: 'DEL', RETURN: 'ENTER', SYMBOL: 'SYM', LEFT: '←', UP: '↑', DOWN: '↓', RIGHT: '→', SPACE: 'SPACE' };
const WIDE = new Set(['SPACE', 'RETURN', 'SHIFT', 'DELETE', 'CAPS', 'TAB', 'SYMBOL', 'CNTRL', 'EDIT']);
const MODS = new Set(['SHIFT', 'SYMBOL', 'CNTRL']);
const HOLD_MS = 90;          // a tap is held this long, so the ROM's scan sees it

export function createSamKeyboard({ parent, machine: m }) {
    const root = document.createElement('div');
    root.className = 'vkbd zxm8-samkbd';
    root.hidden = true;
    root.innerHTML = '<div class="vkbd-header"><span class="vkbd-title">SAM Coupé</span><span class="vkbd-close" title="Close">×</span></div>';
    const armed = new Set(), els = new Map();

    const release = (k) => { m.key(k, false); els.get(k)?.classList.remove('armed'); };
    const tap = (k) => {
        if (MODS.has(k)) {
            if (armed.has(k)) { armed.delete(k); release(k); }
            else { armed.add(k); m.key(k, true); els.get(k)?.classList.add('armed'); }
            return;
        }
        m.key(k, true);
        els.get(k)?.classList.add('armed');
        setTimeout(() => {
            release(k);
            for (const a of armed) release(a);   // the modifiers went with this key
            armed.clear();
        }, HOLD_MS);
    };

    for (const row of ROWS) {
        const r = document.createElement('div');
        r.className = 'vkbd-row';
        for (const k of row) {
            const cell = document.createElement('div');
            cell.className = 'vkbd-cell' + (WIDE.has(k) ? ' wide' : '');
            const box = document.createElement('div');
            box.className = 'vkbd-key' + (MODS.has(k) ? ' mod' : '');
            box.innerHTML = `<span class="vk-main${(LABEL[k] || k).length > 2 ? ' vk-word' : ''}">${LABEL[k] || k}</span>`;
            box.addEventListener('pointerdown', (e) => { e.preventDefault(); tap(k); });
            els.set(k, box);
            cell.append(box);
            r.append(cell);
        }
        root.append(r);
    }
    root.querySelector('.vkbd-close').addEventListener('click', () => show(false));
    parent.append(root);

    function show(on) {
        root.hidden = !on;
        if (!on) { for (const a of armed) release(a); armed.clear(); }
    }
    return {
        el: root,
        show,
        toggle() { show(root.hidden); return !root.hidden; },
        get visible() { return !root.hidden; },
        destroy() { show(false); root.remove(); },
    };
}
