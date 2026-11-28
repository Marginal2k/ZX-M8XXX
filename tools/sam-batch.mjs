// sam-batch.mjs — boot SAM Coupé disks headless and report what each did.
//
//   node tools/sam-batch.mjs <dir|file>... [--frames 3000] [--out dir] [--jobs 4]
//
// Each image goes into drive 1, the machine is reset, a key takes it past the
// start screen and BOOT is typed, as a user would. After --frames frames it
// writes <out>/<name>.png and a line of report.json: the disk commands seen,
// where the CPU stopped, the screen mode, and how much of the screen is not
// the background (an empty screen is the usual sign of a hang). index.html in
// <out> shows them all as a contact sheet. Zip archives are opened; the first
// SAM disk inside is used.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath, pathToFileURL } from 'url';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

function png(w, h, px) {
    const raw = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const c = px[y * w + x], o = y * (w * 4 + 1) + 1 + x * 4;
        raw[o] = c & 255; raw[o + 1] = (c >> 8) & 255; raw[o + 2] = (c >> 16) & 255; raw[o + 3] = 255;
    }
    const T = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
    const crc = (b) => { let c = ~0; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (~c) >>> 0; };
    const ch = (t, d) => {
        const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
        const td = Buffer.concat([Buffer.from(t), d]);
        const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
        return Buffer.concat([l, td, c]);
    };
    const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch('IHDR', ih),
        ch('IDAT', zlib.deflateSync(raw)), ch('IEND', Buffer.alloc(0))]);
}

// The first SAM disk in a zip (stored or deflated entries), found through the
// central directory: a local header may leave the sizes to a data descriptor
function fromZip(b) {
    let e = b.length - 22;
    while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
    if (e < 0) return null;
    let o = b.readUInt32LE(e + 16);
    for (let n = b.readUInt16LE(e + 10); n > 0 && b.readUInt32LE(o) === 0x02014b50; n--) {
        const method = b.readUInt16LE(o + 10), csize = b.readUInt32LE(o + 20);
        const nlen = b.readUInt16LE(o + 28), xlen = b.readUInt16LE(o + 30), clen = b.readUInt16LE(o + 32);
        const local = b.readUInt32LE(o + 42);
        const name = b.subarray(o + 46, o + 46 + nlen).toString('latin1');
        if (/\.(mgt|sad|dsk|img)(\.gz)?$/i.test(name)) {
            const start = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
            const data = b.subarray(start, start + csize);
            return { name, data: method === 8 ? zlib.inflateRawSync(data) : data };
        }
        o += 46 + nlen + xlen + clen;
    }
    return null;
}

async function runOne(file, frames, out) {
    globalThis.pako = { ungzip: (b) => zlib.gunzipSync(b) };
    const { SamCoupe, FB_W, FB_H } = await imp('core/sam/sam.js');
    const { loadSamDisk } = await imp('core/sam/sam-disk.js');
    const name = path.basename(file);
    const rep = { name };
    try {
        let data = fs.readFileSync(file);
        if (data[0] === 0x50 && data[1] === 0x4B) {
            const z = fromZip(data);
            if (!z) throw new Error('no SAM disk in the zip');
            data = z.data; rep.inner = z.name;
        }
        const m = new SamCoupe();
        m.loadRom(fs.readFileSync(path.join(ROOT, 'roms/samcoupe.rom')));
        const dos = path.join(ROOT, 'roms/samdos2.sbt');
        if (fs.existsSync(dos)) m.setDos(fs.readFileSync(dos));
        m.drives[0].insert(loadSamDisk(data));
        const run = (n) => { for (let i = 0; i < n; i++) m.runFrame(); };
        const press = (k) => { m.key(k, true); run(4); m.key(k, false); run(4); };
        run(300); press('SPACE'); run(50);
        for (const c of 'BOOT') press(c);
        press('RETURN');
        let cmds = 0;
        const d = m.drives[0], wr = d.write.bind(d);
        d.write = (r, v, s) => { if (r === 0) cmds++; wr(r, v, s); };
        run(frames);
        const bg = m.fb[0];
        let lit = 0;
        for (let i = 0; i < m.fb.length; i++) if (m.fb[i] !== bg) lit++;
        Object.assign(rep, {
            cmds, pc: m.cpu.pc.toString(16), mode: ((m.vmpr >> 5) & 3) + 1,
            inRom: m.secBuf[m.cpu.pc >> 14] === m.rom, lit: +(lit / m.fb.length).toFixed(3),
        });
        fs.writeFileSync(path.join(out, name + '.png'), png(FB_W, FB_H, m.fb));
    } catch (e) {
        rep.error = e.message;
    }
    return rep;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function sheet(results) {
    const cell = (r) => {
        const info = r.error
            ? `<span class="e">${esc(r.error)}</span>`
            : `<span class="${r.lit < 0.02 || r.inRom ? 'w' : ''}">cmds ${r.cmds}, pc ${r.pc}, mode ${r.mode}${r.inRom ? ', in ROM' : ''}, lit ${r.lit}</span>`;
        return `<div><img src="${encodeURIComponent(r.name)}.png" alt=""><br><b>${esc(r.name)}</b><br>${info}</div>`;
    };
    return `<!doctype html><meta charset="utf-8"><title>SAM batch</title>
<style>body{background:#111;color:#ccc;font:12px system-ui}div{display:inline-block;margin:4px;width:322px;vertical-align:top}
img{width:320px;height:240px;image-rendering:pixelated;border:1px solid #333}.e{color:#f66}.w{color:#fc6}</style>
${results.map(cell).join('\n')}`;
}

if (!isMainThread) {
    const { file, frames, out } = workerData;
    runOne(file, frames, out).then((r) => parentPort.postMessage(r));
} else {
    const args = process.argv.slice(2);
    const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
    const frames = +opt('--frames', 3000), out = path.resolve(opt('--out', 'sam-batch-out')), jobs = +opt('--jobs', 4);
    fs.mkdirSync(out, { recursive: true });
    const files = [];
    for (const a of args) {
        if (fs.statSync(a).isDirectory()) {
            for (const f of fs.readdirSync(a).sort()) if (/\.(mgt|sad|dsk|zip|gz)$/i.test(f)) files.push(path.join(a, f));
        } else files.push(a);
    }
    const results = [];
    let next = 0;
    const worker = () => new Promise((done) => {
        const go = () => {
            if (next >= files.length) return done();
            const file = files[next++];
            const w = new Worker(fileURLToPath(import.meta.url), { workerData: { file, frames, out } });
            w.on('message', (r) => {
                results.push(r);
                const s = r.error ? `ERROR ${r.error}` : `cmds ${r.cmds} pc ${r.pc} mode ${r.mode}${r.inRom ? ' ROM' : ''} lit ${r.lit}`;
                console.log(`[${results.length}/${files.length}] ${r.name}: ${s}`);
                w.terminate(); go();
            });
            w.on('error', (e) => { results.push({ name: path.basename(file), error: String(e) }); go(); });
        };
        go();
    });
    await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));
    results.sort((a, b) => a.name.localeCompare(b.name));
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(results, null, 1));
    fs.writeFileSync(path.join(out, 'index.html'), sheet(results));
    console.log(`done: ${out}/index.html`);
}
