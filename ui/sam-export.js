// sam-export.js — the SAM page's Export/Import: screenshots, recorded frames
// (an animated GIF or a ZIP of PNGs) and memory as binary.
//
// The main page's tab of the same name works on a Spectrum's screen (256 x
// 192, SCR / BSC / SCA / Gigascreen), so this one is the SAM's, in the same
// markup. The pixels come from the machine's own picture (core/sam/sam.js
// fb: 640 x 240, two points a SAM pixel across so mode 3's 512 fit):
//
// Sizes as SimCoupe saves them, whatever the mode:
//   100%  512 x 384 (640 x 480 with the border): every point, mode 3's 512
//         across included, each line twice so the picture keeps its shape
//   50%   256 x 192 (320 x 240): a point a SAM pixel; mode 3 loses every
//         other point
//   200%  1024 x 768 (1280 x 960)
//   raw   a line once: 512 x 192 at 100% (mode 3 as the memory holds it)
//
// GIF and ZIP: core/gif-zip.js (the main page's encoder and writer).

import { FB_W, FB_H, BORDER_X, BORDER_Y } from '../core/sam/sam.js';
import { GifEncoder, createZip } from '../core/gif-zip.js';
import { downloadFile } from '../core/utils.js';

const SCR_W = 256, SCR_H = 192;

// The picture as RGBA: zoom 0.5 | 1 | 2 (SimCoupe's 50%, 100%, 200%); area
// 'screen' | 'border' | {x, y, w, h} in SAM pixels in the screen; raw: a
// line once rather than twice (100% and 200%)
export function samImage(fb, zoom, area, raw = false) {
    const hx = zoom * 2;                                    // points across a SAM pixel
    const vy = raw && zoom >= 1 ? zoom : zoom * 2;          // lines down a SAM line
    let ax = 0, ay = 0, aw = FB_W / 2, ah = FB_H;
    if (area === 'screen') { ax = BORDER_X; ay = BORDER_Y; aw = SCR_W; ah = SCR_H; }
    else if (area && typeof area === 'object') { ax = BORDER_X + area.x; ay = BORDER_Y + area.y; aw = area.w; ah = area.h; }
    const w = aw * hx, h = ah * vy;
    const out = new Uint32Array(w * h);
    for (let oy = 0; oy < h; oy++) {
        const row = (ay + Math.floor(oy / vy)) * FB_W;
        for (let ox = 0; ox < w; ox++) {
            const fx = ax * 2 + Math.floor(ox * 2 / hx);           // fb is 2 points a SAM pixel across
            out[oy * w + ox] = fb[row + fx];
        }
    }
    return { width: w, height: h, data: new Uint8ClampedArray(out.buffer) };
}

function pngBytes(img) {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    return new Promise((res) => c.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), 'image/png'));
}

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

export function createSamExport({ root, app, getName, say }) {
    const m = app.machine;
    root.innerHTML = `
<div class="settings-tab-content">
  <div class="settings-section full-width">
    <div class="settings-row"><span style="font-weight:bold;font-size:12px">Screenshot</span></div>
    <div class="settings-row">
      <label>Size:</label>
      <select class="x-ssize"><option value="border">With border</option><option value="screen">Screen only</option></select>
      <label style="min-width:auto;margin-left:10px">Zoom:</label>
      <select class="x-szoom"><option value="0.5">50%</option><option value="1" selected>100%</option><option value="2">200%</option></select>
      <label style="min-width:auto;margin-left:10px" title="A line once: 512 x 192 at 100% (mode 3 as the memory holds it); else each line twice, 512 x 384, the shape it has on the screen"><input type="checkbox" class="x-sraw"> Raw (512x192)</label>
      <button class="frame-grab-btn x-shot" style="margin-left:10px" title="The screen as a PNG">PNG</button>
    </div>
    <div class="settings-row">
      <label style="min-width:auto"><input type="checkbox" class="x-batch"> Batch:</label>
      <input type="number" class="x-bcount" value="10" min="1" style="width:55px"> shots, every
      <input type="number" class="x-bevery" value="50" min="1" style="width:55px"> frames, into a ZIP
      <span class="x-bstat" style="font-size:11px;color:var(--cyan);margin-left:8px"></span>
    </div>
  </div>
  <hr style="border:none;border-top:1px solid var(--border-color);margin:4px 0">
  <div class="settings-section full-width">
    <div class="settings-row"><span style="font-weight:bold;font-size:12px">Record frames</span></div>
    <div class="settings-row">
      <label>Format:</label>
      <select class="x-fmt"><option value="gif">Animated GIF</option><option value="zip">ZIP (PNG sequence)</option></select>
      <label style="min-width:auto;margin-left:10px">Size:</label>
      <select class="x-fsize"><option value="border">With border</option><option value="screen">Screen only</option><option value="region">Region</option></select>
      <label style="min-width:auto;margin-left:10px">Zoom:</label>
      <select class="x-fzoom"><option value="0.5">50%</option><option value="1" selected>100%</option><option value="2">200%</option></select>
      <label style="min-width:auto;margin-left:10px" title="A line once: 512 x 192 at 100% (mode 3 as the memory holds it)"><input type="checkbox" class="x-fraw"> Raw (512x192)</label>
    </div>
    <div class="settings-row x-region" style="display:none">
      <label>Region:</label> X <input type="number" class="x-rx" value="0" min="0" max="255" style="width:55px">
      Y <input type="number" class="x-ry" value="0" min="0" max="191" style="width:55px">
      W <input type="number" class="x-rw" value="64" min="1" max="256" style="width:55px">
      H <input type="number" class="x-rh" value="64" min="1" max="192" style="width:55px">
      <span class="note" style="font-size:11px;color:var(--text-secondary)">SAM pixels in the screen (256 x 192)</span>
    </div>
    <div class="settings-row">
      <label>Every:</label><input type="number" class="x-step" value="1" min="1" style="width:55px"> frame(s)
      <label style="min-width:auto;margin-left:10px">Max:</label><input type="number" class="x-max" value="1500" min="1" style="width:65px"> frames
    </div>
    <div class="settings-row">
      <button class="frame-grab-btn x-rec">Start</button>
      <button class="frame-grab-btn x-stop" disabled>Stop &amp; export</button>
      <button class="frame-grab-btn x-cancel" disabled>Cancel</button>
      <span class="frame-grab-status x-rstat"></span>
    </div>
  </div>
  <hr style="border:none;border-top:1px solid var(--border-color);margin:4px 0">
  <div class="settings-section full-width">
    <div class="settings-row"><span style="font-weight:bold;font-size:12px">Binary</span></div>
    <div class="settings-row">
      <label>From:</label>
      <select class="x-bsrc"></select>
      Start <input type="text" class="x-bstart" value="8000" style="width:60px">
      Len <input type="text" class="x-blen" value="4000" style="width:60px">
      <button class="frame-grab-btn x-bexp">Export</button>
      <button class="frame-grab-btn x-bimp" title="Load a file into memory at Start">Import</button>
      <input type="file" class="x-bfile" hidden>
      <span class="x-bmsg" style="font-size:11px;color:var(--cyan);margin-left:8px"></span>
    </div>
  </div>
</div>`;
    const $ = (s) => root.querySelector(s);
    const base = () => (getName?.() || 'sam').replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '_') || 'sam';

    // ---- screenshots ----
    $('.x-shot').addEventListener('click', async () => {
        const scale = parseFloat($('.x-szoom').value), area = $('.x-ssize').value;
        const raw = () => $('.x-sraw').checked;
        if (!$('.x-batch').checked) {
            app.draw();
            const img = samImage(m.fb, scale, area, raw());
            downloadFile(`${base()}_${stamp()}.png`, await pngBytes(img));
            say?.(`screenshot ${img.width} x ${img.height}`);
            return;
        }
        const count = Math.max(1, +$('.x-bcount').value | 0), every = Math.max(1, +$('.x-bevery').value | 0);
        const shots = [];
        let n = 0;
        const stat = $('.x-bstat');
        const off = app.onFrame(() => {
            if (n++ % every) return;
            shots.push(samImage(m.fb, scale, area, raw()));
            stat.textContent = `${shots.length} / ${count}`;
            if (shots.length >= count) {
                off();
                (async () => {
                    const files = [];
                    for (let i = 0; i < shots.length; i++) files.push({ name: `${base()}_${String(i).padStart(4, '0')}.png`, data: await pngBytes(shots[i]) });
                    downloadFile(`${base()}_shots.zip`, createZip(files));
                    stat.textContent = `${shots.length} shots saved`;
                })();
            }
        });
        if (app.isPaused()) app.pause(false);
        stat.textContent = `0 / ${count}`;
    });

    // ---- recording ----
    $('.x-fsize').addEventListener('change', () => { $('.x-region').style.display = $('.x-fsize').value === 'region' ? '' : 'none'; });
    let rec = null;
    const rstat = $('.x-rstat');
    const buttons = (on) => { $('.x-rec').disabled = on; $('.x-stop').disabled = !on; $('.x-cancel').disabled = !on; };
    const area = () => {
        const v = $('.x-fsize').value;
        if (v !== 'region') return v;
        const c = (s, lo, hi) => Math.max(lo, Math.min(hi, +$(s).value | 0));
        const x = c('.x-rx', 0, SCR_W - 1), y = c('.x-ry', 0, SCR_H - 1);
        return { x, y, w: c('.x-rw', 1, SCR_W - x), h: c('.x-rh', 1, SCR_H - y) };
    };
    $('.x-rec').addEventListener('click', () => {
        const scale = parseFloat($('.x-fzoom').value), a = area(), step = Math.max(1, +$('.x-step').value | 0), max = Math.max(1, +$('.x-max').value | 0);
        rec = { frames: [], scale, area: a, step, max, n: 0, format: $('.x-fmt').value,
                raw: $('.x-fraw').checked };
        rec.off = app.onFrame(() => {
            if (rec.n++ % rec.step) return;
            const img = samImage(m.fb, rec.scale, rec.area, rec.raw);
            const last = rec.frames[rec.frames.length - 1];
            // a frame like the last one only lengthens it (a GIF holds still for free)
            if (last && rec.format === 'gif' && last.img.data.length === img.data.length && last.img.data.every((v, i) => v === img.data[i])) last.ticks += rec.step;
            else rec.frames.push({ img, ticks: rec.step });
            rstat.textContent = `Recording: ${rec.n} frames (${(rec.n / 50).toFixed(1)} s), ${rec.frames.length} distinct`;
            if (rec.n >= rec.max * rec.step) stop(true);
        });
        buttons(true);
        rstat.textContent = 'Recording…';
        if (app.isPaused()) app.pause(false);
    });
    async function stop(save) {
        if (!rec) return;
        const r = rec; rec = null;
        r.off();
        buttons(false);
        if (!save || !r.frames.length) { rstat.textContent = save ? 'nothing recorded' : 'cancelled'; return; }
        rstat.textContent = `Encoding ${r.frames.length} frames…`;
        await new Promise(res => setTimeout(res, 0));
        if (r.format === 'gif') {
            const { width, height } = r.frames[0].img;
            const gif = new GifEncoder(width, height);
            for (let i = 0; i < r.frames.length; i++) {
                gif.addFrame(r.frames[i].img.data, Math.max(2, r.frames[i].ticks * 2));   // 1/100 s: a frame is 2
                if (i % 20 === 0) { rstat.textContent = `Encoding ${i} / ${r.frames.length}…`; await new Promise(res => setTimeout(res, 0)); }
            }
            downloadFile(`${base()}_${stamp()}.gif`, gif.finish());
        } else {
            const files = [];
            for (let i = 0; i < r.frames.length; i++) files.push({ name: `${base()}_${String(i).padStart(5, '0')}.png`, data: await pngBytes(r.frames[i].img) });
            downloadFile(`${base()}_${stamp()}.zip`, createZip(files));
        }
        rstat.textContent = `Exported ${r.frames.length} frames (${r.n} recorded)`;
    }
    $('.x-stop').addEventListener('click', () => stop(true));
    $('.x-cancel').addEventListener('click', () => stop(false));

    // ---- binary ----
    const src = $('.x-bsrc');
    src.add(new Option('CPU 64K', 'cpu'));
    for (let i = 0; i < 32; i++) src.add(new Option('RAM page ' + i, 'r' + i));
    const hex = (s) => parseInt(String(s).trim().replace(/^\$|^#|^0x/i, '').replace(/h$/i, ''), 16);
    const bmsg = $('.x-bmsg');
    const range = () => {
        const page = src.value === 'cpu' ? -1 : +src.value.slice(1);
        const lim = page < 0 ? 0x10000 : 0x4000;
        const start = hex($('.x-bstart').value), len = hex($('.x-blen').value);
        if (isNaN(start) || isNaN(len) || start < 0 || start >= lim || len <= 0) return null;
        return { page, start, len: Math.min(len, lim - start) };
    };
    $('.x-bexp').addEventListener('click', () => {
        const r = range();
        if (!r) { bmsg.textContent = 'start and length in hex'; return; }
        const out = new Uint8Array(r.len);
        for (let i = 0; i < r.len; i++) out[i] = r.page < 0 ? m.read((r.start + i) & 0xFFFF) : m.ram[(r.page << 14) + r.start + i];
        const where = r.page < 0 ? '' : `_p${r.page}`;
        downloadFile(`${base()}${where}_${r.start.toString(16).toUpperCase().padStart(4, '0')}.bin`, out);
        bmsg.textContent = `${r.len} bytes`;
    });
    $('.x-bimp').addEventListener('click', () => $('.x-bfile').click());
    $('.x-bfile').addEventListener('change', async () => {
        const f = $('.x-bfile').files[0];
        $('.x-bfile').value = '';
        if (!f) return;
        const page = src.value === 'cpu' ? -1 : +src.value.slice(1);
        const start = hex($('.x-bstart').value);
        if (isNaN(start)) { bmsg.textContent = 'start in hex'; return; }
        const data = new Uint8Array(await f.arrayBuffer());
        const lim = page < 0 ? 0x10000 : 0x4000;
        const n = Math.min(data.length, lim - start);
        for (let i = 0; i < n; i++) {
            if (page < 0) m.write((start + i) & 0xFFFF, data[i]); else m.ram[(page << 14) + start + i] = data[i];
        }
        app.draw();
        bmsg.textContent = `${n} bytes of ${f.name} at ${page < 0 ? '' : page + ':'}${start.toString(16).toUpperCase()}`;
    });

    return { stop: () => stop(false) };
}
