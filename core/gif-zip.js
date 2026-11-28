/**
 * ZX-M8XXX - a GIF encoder and a ZIP writer, for exports
 * @license GPL-3.0
 *
 * Taken out of ui/frame-export.js (where they were local to initFrameExport)
 * so the SAM page's exports use them as well.
 */

import { crc32 } from './utils.js';

export function createZip(files) {
    // Simple ZIP file creator (store method, no compression)
    const localHeaders = [];
    const centralHeaders = [];
    let offset = 0;

    for (const file of files) {
        const nameBytes = new TextEncoder().encode(file.name);
        const data = file.data;

        // CRC32
        const crc = crc32(data);

        // Local file header
        const localHeader = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(localHeader.buffer);
        lv.setUint32(0, 0x04034b50, true);  // Local file header signature
        lv.setUint16(4, 20, true);          // Version needed
        lv.setUint16(6, 0, true);           // General purpose flag
        lv.setUint16(8, 0, true);           // Compression: store
        lv.setUint16(10, 0, true);          // Mod time
        lv.setUint16(12, 0, true);          // Mod date
        lv.setUint32(14, crc, true);        // CRC32
        lv.setUint32(18, data.length, true);// Compressed size
        lv.setUint32(22, data.length, true);// Uncompressed size
        lv.setUint16(26, nameBytes.length, true); // Filename length
        lv.setUint16(28, 0, true);          // Extra field length
        localHeader.set(nameBytes, 30);

        // Central directory header
        const centralHeader = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(centralHeader.buffer);
        cv.setUint32(0, 0x02014b50, true);  // Central file header signature
        cv.setUint16(4, 20, true);          // Version made by
        cv.setUint16(6, 20, true);          // Version needed
        cv.setUint16(8, 0, true);           // General purpose flag
        cv.setUint16(10, 0, true);          // Compression: store
        cv.setUint16(12, 0, true);          // Mod time
        cv.setUint16(14, 0, true);          // Mod date
        cv.setUint32(16, crc, true);        // CRC32
        cv.setUint32(20, data.length, true);// Compressed size
        cv.setUint32(24, data.length, true);// Uncompressed size
        cv.setUint16(28, nameBytes.length, true); // Filename length
        cv.setUint16(30, 0, true);          // Extra field length
        cv.setUint16(32, 0, true);          // Comment length
        cv.setUint16(34, 0, true);          // Disk number start
        cv.setUint16(36, 0, true);          // Internal attributes
        cv.setUint32(38, 0, true);          // External attributes
        cv.setUint32(42, offset, true);     // Relative offset
        centralHeader.set(nameBytes, 46);

        localHeaders.push({ header: localHeader, data: data });
        centralHeaders.push(centralHeader);
        offset += localHeader.length + data.length;
    }

    // End of central directory record
    const centralDirOffset = offset;
    let centralDirSize = 0;
    for (const ch of centralHeaders) {
        centralDirSize += ch.length;
    }

    const endRecord = new Uint8Array(22);
    const ev = new DataView(endRecord.buffer);
    ev.setUint32(0, 0x06054b50, true);      // End signature
    ev.setUint16(4, 0, true);               // Disk number
    ev.setUint16(6, 0, true);               // Start disk
    ev.setUint16(8, files.length, true);    // Entries on disk
    ev.setUint16(10, files.length, true);   // Total entries
    ev.setUint32(12, centralDirSize, true); // Central dir size
    ev.setUint32(16, centralDirOffset, true); // Central dir offset
    ev.setUint16(20, 0, true);              // Comment length

    // Combine all parts
    const totalSize = offset + centralDirSize + 22;
    const result = new Uint8Array(totalSize);
    let pos = 0;

    for (const lh of localHeaders) {
        result.set(lh.header, pos);
        pos += lh.header.length;
        result.set(lh.data, pos);
        pos += lh.data.length;
    }
    for (const ch of centralHeaders) {
        result.set(ch, pos);
        pos += ch.length;
    }
    result.set(endRecord, pos);

    return result;
}

// Simple GIF Encoder (256-color, LZW compression)
export class GifEncoder {
    constructor(width, height) {
        this.width = width;
        this.height = height;
        this.frames = [];
        this.data = [];
    }

    addFrame(rgba, delay) {
        // Quantize to 256 colors and create indexed frame
        const { palette, indexed } = this.quantize(rgba);
        this.frames.push({ palette, indexed, delay });
    }

    quantize(rgba) {
        // Simple color quantization using a fixed palette
        // Use median-cut or popularity algorithm for better results
        const colorCounts = new Map();
        const pixels = [];

        for (let i = 0; i < rgba.length; i += 4) {
            const r = rgba[i] & 0xF8;     // 5 bits
            const g = rgba[i + 1] & 0xFC; // 6 bits
            const b = rgba[i + 2] & 0xF8; // 5 bits
            const key = (r << 16) | (g << 8) | b;
            pixels.push(key);
            colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
        }

        // Get top 256 colors
        const sorted = [...colorCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 256);

        const palette = new Uint8Array(256 * 3);
        const colorToIndex = new Map();

        for (let i = 0; i < sorted.length; i++) {
            const [color] = sorted[i];
            const r = (color >> 16) & 0xFF;
            const g = (color >> 8) & 0xFF;
            const b = color & 0xFF;
            palette[i * 3] = r;
            palette[i * 3 + 1] = g;
            palette[i * 3 + 2] = b;
            colorToIndex.set(color, i);
        }

        // Map pixels to palette indices
        const indexed = new Uint8Array(pixels.length);
        for (let i = 0; i < pixels.length; i++) {
            indexed[i] = colorToIndex.get(pixels[i]) || 0;
        }

        return { palette, indexed };
    }

    finish() {
        const out = [];

        // GIF Header
        out.push(...[0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a

        // Logical Screen Descriptor
        out.push(this.width & 0xFF, (this.width >> 8) & 0xFF);
        out.push(this.height & 0xFF, (this.height >> 8) & 0xFF);
        out.push(0xF7); // Global color table, 256 colors (2^(7+1))
        out.push(0);    // Background color index
        out.push(0);    // Pixel aspect ratio

        // Global Color Table (placeholder — each frame uses local color table)
        for (let i = 0; i < 256 * 3; i++) {
            out.push(0);
        }

        // Netscape Extension for looping
        out.push(0x21, 0xFF, 0x0B);
        out.push(...[0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2E, 0x30]); // NETSCAPE2.0
        out.push(0x03, 0x01, 0x00, 0x00, 0x00); // Loop forever

        // Frames
        for (const frame of this.frames) {
            // Graphics Control Extension
            out.push(0x21, 0xF9, 0x04);
            out.push(0x04); // Disposal method: 1 (do not dispose) << 2
            out.push(frame.delay & 0xFF, (frame.delay >> 8) & 0xFF); // Delay
            out.push(0x00); // Transparent color index
            out.push(0x00); // Block terminator

            // Image Descriptor
            out.push(0x2C);
            out.push(0, 0, 0, 0); // Left, Top
            out.push(this.width & 0xFF, (this.width >> 8) & 0xFF);
            out.push(this.height & 0xFF, (this.height >> 8) & 0xFF);
            out.push(0x87); // Local color table, 256 colors (2^(7+1))

            // Local Color Table
            for (let i = 0; i < 256 * 3; i++) {
                out.push(frame.palette[i] || 0);
            }

            // LZW Compressed Image Data
            const lzw = this.lzwEncode(frame.indexed, 8);
            out.push(8); // LZW minimum code size

            // Output in sub-blocks
            let pos = 0;
            while (pos < lzw.length) {
                const blockSize = Math.min(255, lzw.length - pos);
                out.push(blockSize);
                for (let i = 0; i < blockSize; i++) {
                    out.push(lzw[pos++]);
                }
            }
            out.push(0x00); // Block terminator
        }

        // GIF Trailer
        out.push(0x3B);

        return new Uint8Array(out);
    }

    lzwEncode(data, minCodeSize) {
        const clearCode = 1 << minCodeSize;
        const eoiCode = clearCode + 1;
        let codeSize = minCodeSize + 1;
        let nextCode = eoiCode + 1;
        const maxCode = 4096;

        // Use numeric keys: (prefix_code << 8) | byte — avoids string allocation
        const table = new Map();

        const output = [];
        let bitBuffer = 0;
        let bitCount = 0;

        const writeBits = (code, size) => {
            bitBuffer |= code << bitCount;
            bitCount += size;
            while (bitCount >= 8) {
                output.push(bitBuffer & 0xFF);
                bitBuffer >>= 8;
                bitCount -= 8;
            }
        };

        writeBits(clearCode, codeSize);

        if (data.length === 0) {
            writeBits(eoiCode, codeSize);
            if (bitCount > 0) output.push(bitBuffer & 0xFF);
            return output;
        }

        let prefix = data[0]; // Initial code = first byte value
        for (let i = 1; i < data.length; i++) {
            const byte = data[i];
            const key = (prefix << 8) | byte;

            const found = table.get(key);
            if (found !== undefined) {
                prefix = found;
            } else {
                writeBits(prefix, codeSize);

                if (nextCode < maxCode) {
                    table.set(key, nextCode++);
                    if (nextCode > (1 << codeSize) && codeSize < 12) {
                        codeSize++;
                    }
                } else {
                    // Reset table
                    writeBits(clearCode, codeSize);
                    table.clear();
                    codeSize = minCodeSize + 1;
                    nextCode = eoiCode + 1;
                }

                prefix = byte;
            }
        }

        writeBits(prefix, codeSize);
        writeBits(eoiCode, codeSize);

        if (bitCount > 0) {
            output.push(bitBuffer & 0xFF);
        }

        return output;
    }
}
