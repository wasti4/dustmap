'use strict';
// Draws every output frame on a GPU canvas and streams raw RGBA to ffmpeg.
// Stage: a 1920x1080 scene with a backdrop and the app window; the camera zooms and pans
// over the stage with critically damped springs, so it trails the cursor and eases out.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { ipcRenderer } = require('electron');
const motion = require('./motion.cjs');

const q = new URLSearchParams(location.search);
const IN = q.get('in');
const OUT = q.get('out');
const FPS = Number(q.get('fps')) || 60;
const CRF = q.get('crf') || '22';
const PRESET = q.get('preset') || 'slow';
const W = 1920;
const H = 1080;

const ev = JSON.parse(fs.readFileSync(path.join(IN, 'events.json'), 'utf8'));
const APP = ev.size; // app viewport in DIPs
const PX = ev.pixel; // recorded bitmap size
const WIN = { w: 1600, h: 900 };
WIN.x = (W - WIN.w) / 2;
WIN.y = (H - WIN.h) / 2;
const S = WIN.w / APP.width; // stage px per DIP
const RADIUS = 12;
const toStage = (p) => ({ x: WIN.x + p.x * S, y: WIN.y + p.y * S });

// ------------------------------------------------------------------ recorded frames
const bin = fs.readFileSync(path.join(IN, 'frames.bin'));
const recs = [];
for (let o = 0; o + 20 <= bin.length; ) {
  const n = bin.readUInt32LE(o + 16);
  recs.push({ t: bin.readDoubleLE(o), x: bin.readUInt16LE(o + 8), y: bin.readUInt16LE(o + 10), w: bin.readUInt16LE(o + 12), h: bin.readUInt16LE(o + 14), off: o + 20, n });
  o += 20 + n;
}

const appCv = document.createElement('canvas');
appCv.width = PX.width;
appCv.height = PX.height;
const actx = appCv.getContext('2d');
// Title bar colour decides the caption glyph colour and the theme of overlays.
const probe = { x: PX.width - Math.round(170 * PX.scale), y: Math.round(10 * PX.scale) };
let titleRGB = [24, 24, 27];
let nextRec = 0;

function applyUntil(ms) {
  while (nextRec < recs.length && recs[nextRec].t <= ms) {
    const r = recs[nextRec++];
    const raw = zlib.inflateSync(bin.subarray(r.off, r.off + r.n));
    const u8 = raw.byteOffset % 4 ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.length);
    const u32 = new Uint32Array(u8.buffer, u8.byteOffset, u8.length >> 2);
    for (let i = 0; i < u32.length; i++) {
      const v = u32[i];
      u32[i] = (v & 0xff00ff00) | ((v & 0xff) << 16) | ((v >>> 16) & 0xff);
    }
    if (probe.x >= r.x && probe.x < r.x + r.w && probe.y >= r.y && probe.y < r.y + r.h) {
      const i = ((probe.y - r.y) * r.w + (probe.x - r.x)) * 4;
      titleRGB = [u8[i], u8[i + 1], u8[i + 2]];
    }
    actx.putImageData(new ImageData(new Uint8ClampedArray(u8.buffer, u8.byteOffset, r.w * r.h * 4), r.w, r.h), r.x, r.y);
  }
}
const isDark = () => titleRGB[0] * 0.299 + titleRGB[1] * 0.587 + titleRGB[2] * 0.114 < 128;

// ------------------------------------------------------------------ backdrop
function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

function makeBackdrop() {
  const k = 2;
  const cv = document.createElement('canvas');
  cv.width = W * k;
  cv.height = H * k;
  const b = cv.getContext('2d');
  b.scale(k, k);
  const base = b.createLinearGradient(0, 0, W, H);
  base.addColorStop(0, '#0c0d14');
  base.addColorStop(1, '#08090d');
  b.fillStyle = base;
  b.fillRect(0, 0, W, H);
  const glow = (x, y, r, color) => {
    const g = b.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    b.fillStyle = g;
    b.fillRect(0, 0, W, H);
  };
  glow(260, 1040, 980, 'rgba(96, 88, 255, 0.34)');
  glow(1760, 60, 900, 'rgba(24, 190, 170, 0.18)');
  glow(1500, 1100, 720, 'rgba(236, 80, 160, 0.12)');
  glow(980, 520, 700, 'rgba(120, 110, 255, 0.06)');
  // Faint dot matrix, the Dustmap motif.
  for (let y = 12; y < H; y += 24) {
    for (let x = 12; x < W; x += 24) {
      const d = Math.hypot((x - W / 2) / W, (y - H / 2) / H);
      const a = 0.075 * Math.max(0, 1 - d * 1.25);
      if (a < 0.004) continue;
      b.fillStyle = `rgba(255,255,255,${a.toFixed(4)})`;
      b.fillRect(x - 1.1, y - 1.1, 2.2, 2.2);
    }
  }
  const vg = b.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 1.1);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.5)');
  b.fillStyle = vg;
  b.fillRect(0, 0, W, H);
  // Window shadows: a wide soft one and a tight contact one (blur is in device pixels).
  b.save();
  b.fillStyle = '#000';
  b.shadowColor = 'rgba(0,0,0,0.55)';
  b.shadowBlur = 90 * k;
  b.shadowOffsetY = 30 * k;
  roundRect(b, WIN.x + 10, WIN.y + 10, WIN.w - 20, WIN.h - 20, RADIUS);
  b.fill();
  b.shadowColor = 'rgba(0,0,0,0.45)';
  b.shadowBlur = 14 * k;
  b.shadowOffsetY = 4 * k;
  roundRect(b, WIN.x, WIN.y, WIN.w, WIN.h, RADIUS);
  b.fill();
  b.restore();
  // Light dither against banding in the dark gradients.
  const img = b.getImageData(0, 0, cv.width, cv.height);
  const d = img.data;
  let seed = 1;
  for (let i = 0; i < d.length; i += 4) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const n = ((seed >>> 16) & 3) - 1.5;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  b.putImageData(img, 0, 0);
  return cv;
}

// ------------------------------------------------------------------ camera
const cues = ev.camera.slice().sort((a, b) => a.t - b.t);
function cueAt(ms) {
  let c = { mode: 'overview', zoom: 1 };
  for (const k of cues) {
    if (k.t <= ms) c = k;
    else break;
  }
  return c;
}

function clampView(x, y, z) {
  const hw = W / (2 * z);
  const hh = H / (2 * z);
  return { x: Math.min(W - hw, Math.max(hw, x)), y: Math.min(H - hh, Math.max(hh, y)) };
}

function camTarget(ms, cursor) {
  const c = cueAt(ms);
  let z = c.zoom || 1;
  let p = { x: W / 2, y: H / 2 };
  if (c.mode === 'follow') {
    const s = toStage(cursor);
    p = { x: s.x + (c.dx || 0) * S, y: s.y + (c.dy || 0) * S };
  } else if (c.mode === 'focus' && c.rect) {
    const r = c.rect;
    p = toStage({ x: r.x + r.w / 2 + (c.dx || 0), y: r.y + r.h / 2 + (c.dy || 0) });
    if (!c.zoom) z = Math.min(c.max || 1.9, (0.9 * W) / (r.w * S), (0.9 * H) / (r.h * S));
  }
  z = Math.max(1, z);
  const v = clampView(p.x, p.y, z);
  return { x: v.x, y: v.y, lz: Math.log(z), pan: c.pan || 4.0, zs: c.zs || 3.4 };
}

const cam = { x: W / 2, y: H / 2, lz: 0, vx: 0, vy: 0, vz: 0, init: false };
function stepCamera(ms, cursor, dt) {
  const t = camTarget(ms, cursor);
  if (!cam.init) {
    Object.assign(cam, { x: t.x, y: t.y, lz: t.lz, init: true });
    return;
  }
  [cam.x, cam.vx] = motion.springStep(cam.x, cam.vx, t.x, t.pan, dt);
  [cam.y, cam.vy] = motion.springStep(cam.y, cam.vy, t.y, t.pan, dt);
  [cam.lz, cam.vz] = motion.springStep(cam.lz, cam.vz, t.lz, t.zs, dt);
}

// ------------------------------------------------------------------ cursor and overlays
const ARROW = [
  [0, 0],
  [0, 16.8],
  [4.1, 13.1],
  [6.8, 19.3],
  [9.5, 18.2],
  [6.9, 12.2],
  [12.2, 12.2],
];

function drawCursor(c, p, scale, zoom) {
  c.save();
  c.translate(p.x, p.y);
  c.scale(scale, scale);
  c.beginPath();
  ARROW.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.closePath();
  c.lineJoin = 'round';
  c.shadowColor = 'rgba(0,0,0,0.38)';
  c.shadowBlur = 3.2 * scale * zoom;
  c.shadowOffsetY = 1.4 * scale * zoom;
  c.fillStyle = '#fff';
  c.fill();
  c.shadowColor = 'transparent';
  c.lineWidth = 1.2;
  c.strokeStyle = '#121216';
  c.stroke();
  c.restore();
}

const easeOut = (u) => 1 - Math.pow(1 - u, 3);

function drawClicks(c, ms) {
  for (const k of ev.clicks) {
    const age = ms - k.t;
    if (age < 0 || age > 520) continue;
    const u = age / 520;
    const p = toStage(k);
    const r = (7 + 20 * easeOut(u)) * S;
    const a = 0.55 * (1 - u) * (1 - u);
    const rgb = isDark() ? '255,255,255' : '40,60,140';
    c.beginPath();
    c.arc(p.x, p.y, r, 0, Math.PI * 2);
    c.fillStyle = `rgba(${rgb},${(a * 0.28).toFixed(3)})`;
    c.fill();
    c.lineWidth = 1.6 * S;
    c.strokeStyle = `rgba(${rgb},${a.toFixed(3)})`;
    c.stroke();
  }
}

function pressScale(ms) {
  for (const k of ev.clicks) {
    const age = ms - k.t;
    if (age >= 0 && age < 220) return 1 - 0.14 * Math.sin(Math.PI * (age / 220));
  }
  return 1;
}

function drawCaptionButtons(c) {
  // Native Windows caption buttons are not part of offscreen frames; draw their glyphs.
  const col = isDark() ? 'rgba(235,235,240,0.92)' : 'rgba(30,30,35,0.9)';
  const cy = 24;
  const g = 5;
  c.save();
  c.strokeStyle = col;
  c.lineWidth = 1 * S;
  const at = (dx) => toStage({ x: APP.width - dx, y: cy });
  let p = at(115);
  c.beginPath();
  c.moveTo(p.x - g * S, p.y);
  c.lineTo(p.x + g * S, p.y);
  c.stroke();
  p = at(69);
  c.beginPath();
  c.roundRect(p.x - g * S, p.y - g * S, 2 * g * S, 2 * g * S, 1.2 * S);
  c.stroke();
  p = at(23);
  c.beginPath();
  c.moveTo(p.x - g * S, p.y - g * S);
  c.lineTo(p.x + g * S, p.y + g * S);
  c.moveTo(p.x + g * S, p.y - g * S);
  c.lineTo(p.x - g * S, p.y + g * S);
  c.stroke();
  c.restore();
}

/** Draws text with fixed-width digits so a running counter does not jitter. */
function drawTabular(c, text, x, y) {
  const dw = c.measureText('0').width;
  let cx = x;
  for (const ch of text) {
    const w = /[0-9]/.test(ch) ? dw : c.measureText(ch).width;
    c.fillText(ch, cx + (w - c.measureText(ch).width) / 2, y);
    cx += w;
  }
  return cx - x;
}
function tabularWidth(c, text) {
  const dw = c.measureText('0').width;
  let w = 0;
  for (const ch of text) w += /[0-9]/.test(ch) ? dw : c.measureText(ch).width;
  return w;
}

function drawStopwatch(c, ms) {
  const t0 = ev.marks.scanStart;
  const t1 = ev.marks.scanEnd;
  if (t0 == null || ms < t0) return;
  const hold = 2600;
  if (t1 != null && ms > t1 + hold) return;
  let a = Math.min(1, (ms - t0) / 200);
  if (t1 != null && ms > t1 + hold - 450) a = Math.min(a, (t1 + hold - ms) / 450);
  const done = t1 != null && ms >= t1;
  const secs = ((done ? t1 : ms) - t0) / 1000;
  const value = `${secs.toFixed(1)} s`;
  const label = done ? 'Scanned in' : 'Scanning';
  c.save();
  c.globalAlpha = easeOut(Math.max(0, a));
  c.font = '500 26px Inter';
  const lw = c.measureText(label).width;
  c.font = '650 26px Inter';
  const vw = tabularWidth(c, '00.0 s');
  const padX = 26;
  const icon = 28;
  const gap = 12;
  const w = padX + icon + gap + lw + 10 + vw + padX;
  const h = 58;
  const x = (W - w) / 2;
  const y = H - 46 - h + (1 - easeOut(Math.max(0, a))) * 14;
  c.shadowColor = 'rgba(0,0,0,0.45)';
  c.shadowBlur = 24;
  c.shadowOffsetY = 8;
  c.fillStyle = 'rgba(18,18,24,0.86)';
  roundRect(c, x, y, w, h, h / 2);
  c.fill();
  c.shadowColor = 'transparent';
  c.lineWidth = 1;
  c.strokeStyle = 'rgba(255,255,255,0.12)';
  c.stroke();
  // Stopwatch icon with a sweeping hand.
  const ix = x + padX + icon / 2;
  const iy = y + h / 2 + 1.5;
  c.strokeStyle = done ? '#4ade80' : '#e8e8ee';
  c.lineWidth = 2.4;
  c.beginPath();
  c.arc(ix, iy, 10.5, 0, Math.PI * 2);
  c.stroke();
  c.beginPath();
  c.moveTo(ix - 3.5, iy - 15.5);
  c.lineTo(ix + 3.5, iy - 15.5);
  c.stroke();
  const ang = done ? -Math.PI / 2 + secs * Math.PI * 2 : -Math.PI / 2 + ((ms - t0) / 1000) * Math.PI * 2;
  c.beginPath();
  c.moveTo(ix, iy);
  c.lineTo(ix + Math.cos(ang) * 7, iy + Math.sin(ang) * 7);
  c.stroke();
  c.textBaseline = 'middle';
  c.fillStyle = 'rgba(235,235,242,0.78)';
  c.font = '500 26px Inter';
  const tx = x + padX + icon + gap;
  c.fillText(label, tx, y + h / 2 + 1);
  c.fillStyle = done ? '#ffffff' : '#f4f4f8';
  c.font = '650 26px Inter';
  drawTabular(c, value, tx + lw + 10, y + h / 2 + 1);
  c.restore();
}

function drawKeycaps(c, ms) {
  const k = [...ev.keys].reverse().find((e) => e.modifiers.length && ms >= e.t && ms < e.t + 1100);
  if (!k) return;
  const age = ms - k.t;
  const a = Math.min(1, age / 140, (1100 - age) / 260);
  const parts = [...k.modifiers.map((m) => m[0].toUpperCase() + m.slice(1).replace('ontrol', 'trl')), k.key.toUpperCase()];
  c.save();
  c.globalAlpha = Math.max(0, a);
  c.font = '600 24px Inter';
  const ws = parts.map((p) => Math.max(46, c.measureText(p).width + 30));
  const total = ws.reduce((s, w) => s + w, 0) + (parts.length - 1) * 30;
  let x = (W - total) / 2;
  const y = H - 108;
  parts.forEach((p, i) => {
    c.fillStyle = 'rgba(18,18,24,0.88)';
    c.shadowColor = 'rgba(0,0,0,0.4)';
    c.shadowBlur = 18;
    c.shadowOffsetY = 6;
    roundRect(c, x, y, ws[i], 50, 12);
    c.fill();
    c.shadowColor = 'transparent';
    c.strokeStyle = 'rgba(255,255,255,0.16)';
    c.lineWidth = 1;
    c.stroke();
    c.fillStyle = '#f2f2f6';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(p, x + ws[i] / 2, y + 26);
    x += ws[i];
    if (i < parts.length - 1) {
      c.fillStyle = 'rgba(235,235,242,0.7)';
      c.fillText('+', x + 15, y + 25);
      x += 30;
    }
  });
  c.restore();
}

// ------------------------------------------------------------------ main loop
async function main() {
  const fontUrl = path.join(__dirname, '..', '..', 'node_modules', '@fontsource-variable', 'inter', 'files', 'inter-latin-wght-normal.woff2');
  const face = new FontFace('Inter', `url("file:///${fontUrl.replace(/\\/g, '/')}")`, { weight: '100 900' });
  document.fonts.add(await face.load());

  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const c = out.getContext('2d', { alpha: false });
  const backdrop = makeBackdrop();

  const total = Math.ceil((ev.duration / 1000) * FPS);
  const from = q.get('from') ? Math.floor(Number(q.get('from')) * FPS) : 0;
  const to = q.get('to') ? Math.min(total, Math.ceil(Number(q.get('to')) * FPS)) : total;
  const ff = spawn(
    process.env.FFMPEG || 'ffmpeg',
    ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', '-',
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
      '-c:v', 'libx264', '-preset', PRESET, '-crf', CRF, '-profile:v', 'high',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart', OUT],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  ff.stderr.on('data', (d) => console.log('[ffmpeg] ' + d));
  const exited = new Promise((r) => ff.on('close', r));
  const write = (buf) => new Promise((r) => (ff.stdin.write(buf) ? r() : ff.stdin.once('drain', r)));

  const started = performance.now();
  for (let i = 0; i < to; i++) {
    const ms = (i * 1000) / FPS;
    applyUntil(ms);
    const cursor = motion.cursorAt(ev.moves, ev.start, ms);
    stepCamera(ms, cursor, 1 / FPS);
    if (i < from) continue;

    const z = Math.exp(cam.lz);
    const v = clampView(cam.x, cam.y, z);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.setTransform(z, 0, 0, z, W / 2 - v.x * z, H / 2 - v.y * z);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(backdrop, 0, 0, W, H);
    c.save();
    roundRect(c, WIN.x, WIN.y, WIN.w, WIN.h, RADIUS);
    c.clip();
    c.drawImage(appCv, WIN.x, WIN.y, WIN.w, WIN.h);
    drawCaptionButtons(c);
    c.restore();
    roundRect(c, WIN.x + 0.5, WIN.y + 0.5, WIN.w - 1, WIN.h - 1, RADIUS);
    c.lineWidth = 1;
    c.strokeStyle = isDark() ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.14)';
    c.stroke();
    drawClicks(c, ms);
    drawCursor(c, toStage(cursor), S * pressScale(ms), z);

    c.setTransform(1, 0, 0, 1, 0, 0);
    drawStopwatch(c, ms);
    drawKeycaps(c, ms);
    const fadeIn = Math.min(1, ms / 450);
    const fadeOut = Math.min(1, (ev.duration - ms) / 600);
    const f = Math.min(fadeIn, fadeOut);
    if (f < 1) {
      c.fillStyle = `rgba(6,6,9,${(1 - easeOut(Math.max(0, f))).toFixed(3)})`;
      c.fillRect(0, 0, W, H);
    }
    const img = c.getImageData(0, 0, W, H);
    await write(Buffer.from(img.data.buffer));
    if ((i - from) % 300 === 0) console.log(`[compose] frame ${i - from}/${to - from} (${((performance.now() - started) / 1000).toFixed(0)} s)`);
  }
  ff.stdin.end();
  const code = await exited;
  console.log(`[compose] done in ${((performance.now() - started) / 1000).toFixed(0)} s -> ${OUT} (ffmpeg ${code})`);
  ipcRenderer.send('done', code ? 1 : 0);
}

main().catch((err) => {
  console.log('[compose] failed: ' + (err && err.stack ? err.stack : err));
  ipcRenderer.send('done', 1);
});
