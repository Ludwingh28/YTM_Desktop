// One-off generator for the Windows taskbar thumbar button icons
// (previous / play / pause / next): white glyphs on a transparent
// background, drawn pixel-by-pixel so no image library is needed.
// Run with `node scripts/make-media-icons.js`.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 32;
const FG = [255, 255, 255, 255];
const TRANSPARENT = [0, 0, 0, 0];

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function pointInRect(px, py, x, y, w, h) {
  return px >= x && px < x + w && py >= y && py < y + h;
}

function makeCanvas() {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => TRANSPARENT));
}

function paintShape(canvas, testFn) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (testFn(x + 0.5, y + 0.5)) canvas[y][x] = FG;
    }
  }
}

function triangleTest(ax, ay, bx, by, cx, cy) {
  return (x, y) => pointInTriangle(x, y, ax, ay, bx, by, cx, cy);
}

function rectTest(x, y, w, h) {
  return (px, py) => pointInRect(px, py, x, y, w, h);
}

function anyTest(tests) {
  return (x, y) => tests.some((t) => t(x, y));
}

const icons = {
  play: (canvas) => {
    paintShape(canvas, triangleTest(11, 8, 11, 24, 24, 16));
  },
  pause: (canvas) => {
    paintShape(canvas, anyTest([rectTest(9, 8, 5, 16), rectTest(18, 8, 5, 16)]));
  },
  next: (canvas) => {
    paintShape(canvas, anyTest([triangleTest(7, 8, 7, 24, 19, 16), rectTest(21, 8, 4, 16)]));
  },
  previous: (canvas) => {
    paintShape(canvas, anyTest([rectTest(7, 8, 4, 16), triangleTest(25, 8, 25, 24, 13, 16)]));
  },
};

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crc = zlib.crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(canvas) {
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  for (let y = 0; y < SIZE; y++) {
    const rowStart = y * (1 + SIZE * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b, a] = canvas[y][x];
      const off = rowStart + 1 + x * 4;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = a;
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'assets', 'media');
fs.mkdirSync(outDir, { recursive: true });

for (const [name, draw] of Object.entries(icons)) {
  const canvas = makeCanvas();
  draw(canvas);
  fs.writeFileSync(path.join(outDir, `${name}.png`), encodePng(canvas));
  console.log(`Wrote assets/media/${name}.png`);
}
