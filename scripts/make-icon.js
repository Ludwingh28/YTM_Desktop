// One-off generator for a simple placeholder app icon (dark square + white
// play triangle). Run with `node scripts/make-icon.js`. Replace
// assets/icon.png with real branding whenever you want.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const BG = [3, 3, 3, 255];
const FG = [255, 255, 255, 255];

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
const ax = SIZE * 0.36, ay = SIZE * 0.28;
const bx = SIZE * 0.36, by = SIZE * 0.72;
const cx = SIZE * 0.74, cy = SIZE * 0.5;

for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (1 + SIZE * 4);
  raw[rowStart] = 0; // filter type: none
  for (let x = 0; x < SIZE; x++) {
    const inside = pointInTriangle(x + 0.5, y + 0.5, ax, ay, bx, by, cx, cy);
    const color = inside ? FG : BG;
    const off = rowStart + 1 + x * 4;
    raw[off] = color[0];
    raw[off + 1] = color[1];
    raw[off + 2] = color[2];
    raw[off + 3] = color[3];
  }
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crc = zlib.crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const idat = zlib.deflateSync(raw);
const png = Buffer.concat([
  signature,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
console.log('Wrote assets/icon.png');
