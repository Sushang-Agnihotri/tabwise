// Generate Tabwise icons: a rounded square with a stack of tabs.
// Usage: node scripts/make-icons.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src', 'icons');

function crc32(buf) {
  let c = ~0;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function inRoundedSquare(x, y) {
  const m = 0.06; const r = 0.22;
  if (x < m || x > 1 - m || y < m || y > 1 - m) return false;
  const cx = Math.min(Math.max(x, m + r), 1 - m - r);
  const cy = Math.min(Math.max(y, m + r), 1 - m - r);
  return Math.hypot(x - cx, y - cy) <= r;
}
// Three stacked "tab" bars, the top one widest.
function bar(x, y, x0, x1, y0, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}
function inGlyph(x, y) {
  return bar(x, y, 0.22, 0.78, 0.26, 0.38, 0.04) || bar(x, y, 0.22, 0.66, 0.45, 0.57, 0.04) || bar(x, y, 0.22, 0.54, 0.64, 0.76, 0.04);
}

function render(size, color) {
  const buf = Buffer.alloc(size * size * 4);
  const S = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0; let fg = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const x = (px + (sx + 0.5) / S) / size; const y = (py + (sy + 0.5) / S) / size;
        if (inRoundedSquare(x, y)) { if (inGlyph(x, y)) fg++; else bg++; }
      }
      const a = (bg + fg) / (S * S);
      if (!a) continue;
      const w = fg / (bg + fg);
      const i = (py * size + px) * 4;
      for (let k = 0; k < 3; k++) buf[i + k] = Math.round(color[k] * (1 - w) + 255 * w);
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, buf);
}

await mkdir(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) await writeFile(path.join(outDir, `icon-${size}.png`), render(size, [109, 78, 216]));
console.log('Icons written to src/icons');
