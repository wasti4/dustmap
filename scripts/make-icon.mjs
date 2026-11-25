// Generates assets/icon.png (512x512): the Dustmap mark, a disk platter made of
// dots with the used sector lit up, on a dark rounded tile. Same geometry as
// src/renderer/lib/logo.ts. No image libraries needed: shapes are rasterised
// with 4x4 supersampling and encoded as PNG with zlib.
import { mkdirSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

const S = 512;
const K = S / 128; // logo geometry is defined in a 128x128 box
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const TILE = hex('#141417');
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

const sectors = [
  [-90, -10, '#3b82f6'],
  [-10, 40, '#22c55e'],
  [40, 85, '#ec4899'],
  [85, 125, '#a855f7'],
  [125, 160, '#f97316'],
];
const shapes = [];
for (const [rad, n] of [
  [18, 8],
  [32, 14],
  [46, 20],
]) {
  for (let i = 0; i < n; i++) {
    const a = -90 + (360 / n) * i;
    const s = sectors.find(([a0, a1]) => a >= a0 && a < a1);
    shapes.push({
      cx: (64 + rad * Math.cos((a * Math.PI) / 180)) * K,
      cy: (64 + rad * Math.sin((a * Math.PI) / 180)) * K,
      r: (rad === 46 ? 4.4 : 4) * K,
      c: s ? hex(s[2]) : mix(TILE, [255, 255, 255], 0.13),
    });
  }
}
shapes.push({ cx: 64 * K, cy: 64 * K, r: 5 * K, c: [255, 255, 255] });

function inTile(x, y) {
  const r = 28 * K;
  const cx = Math.min(Math.max(x, r), S - r);
  const cy = Math.min(Math.max(y, r), S - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const px = Buffer.alloc(S * S * 4);
const SS = 4;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let rr = 0, gg = 0, bb = 0, aa = 0;
    const near = shapes.filter((s) => Math.abs(s.cx - x) <= s.r + 1 && Math.abs(s.cy - y) <= s.r + 1);
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const fx = x + (sx + 0.5) / SS;
        const fy = y + (sy + 0.5) / SS;
        if (!inTile(fx, fy)) continue;
        let col = TILE;
        for (const s of near) if ((fx - s.cx) ** 2 + (fy - s.cy) ** 2 <= s.r * s.r) col = s.c;
        rr += col[0];
        gg += col[1];
        bb += col[2];
        aa += 1;
      }
    }
    const o = (y * S + x) * 4;
    if (aa) {
      px[o] = Math.round(rr / aa);
      px[o + 1] = Math.round(gg / aa);
      px[o + 2] = Math.round(bb / aa);
    }
    px[o + 3] = Math.round((aa / (SS * SS)) * 255);
  }
}

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
mkdirSync('build', { recursive: true });
writeFileSync('assets/icon.png', png);
console.log(`assets/icon.png written (${png.length} bytes)`);
