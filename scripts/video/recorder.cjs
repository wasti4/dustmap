'use strict';
// Drives the real app in an offscreen window and records what it paints.
//
// Frames: every offscreen 'paint' is stored as the changed rectangle only (raw BGRA,
// deflated on the libuv thread pool) in frames.bin. Record layout:
//   f64 t(ms) | u16 x | u16 y | u16 w | u16 h | u32 byteLength | data
// events.json logs the cursor moves, clicks and camera cues for the compositor.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const motion = require('./motion.cjs');

const HELPERS = `
window.__rec = {
  find(sel, text, index) {
    const all = [...document.querySelectorAll(sel)].filter((e) => {
      const r = e.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      if (!text) return true;
      if (text.startsWith('=')) {
        const want = text.slice(1);
        // Normalise no-break spaces ("10 MB" may use U+00A0) so targets can be written plainly.
        return [e, ...e.querySelectorAll('*')].some((x) => (x.textContent || '').replace(/\\s+/g, ' ').trim() === want);
      }
      return (e.textContent || '').includes(text) || (e.getAttribute('aria-label') || '').includes(text);
    });
    const e = all[index || 0];
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  },
};
true;
`;

exports.start = ({ win, app, outDir, size, argv }) => {
  const wc = win.webContents;
  const scenarioName = (argv.find((a) => a.startsWith('--scenario=')) || '--scenario=scenario').slice(11);
  fs.mkdirSync(outDir, { recursive: true });
  const fd = fs.openSync(path.join(outDir, 'frames.bin'), 'w');
  // Also log to a file: an elevated recording (UAC) has no console to read.
  const logFile = path.join(outDir, 'record.log');
  fs.writeFileSync(logFile, '');
  const say = (...a) => {
    const line = a.join(' ');
    console.log(line);
    fs.appendFileSync(logFile, `${line}\n`);
  };

  const clock = () => performance.now();
  let t0 = 0;
  let recording = false;
  let lastFull = null; // newest full-frame bitmap before recording starts
  let pixelSize = null;
  let frames = 0;
  let bytesRaw = 0;
  let bytesOut = 0;
  let chain = Promise.resolve();

  function writeRecord(t, x, y, w, h, raw) {
    bytesRaw += raw.length;
    const packed = new Promise((res, rej) => zlib.deflate(raw, { level: 1 }, (err, out) => (err ? rej(err) : res(out))));
    chain = chain.then(async () => {
      const data = await packed;
      const head = Buffer.alloc(20);
      head.writeDoubleLE(t, 0);
      head.writeUInt16LE(x, 8);
      head.writeUInt16LE(y, 10);
      head.writeUInt16LE(w, 12);
      head.writeUInt16LE(h, 14);
      head.writeUInt32LE(data.length, 16);
      fs.writeSync(fd, head);
      fs.writeSync(fd, data);
      bytesOut += data.length + 20;
    });
  }

  wc.setFrameRate(60);
  wc.on('paint', (_e, dirty, image) => {
    const full = image.toBitmap();
    if (!pixelSize) {
      const s = image.getSize();
      const scale = Math.round(Math.sqrt(full.length / 4 / (s.width * s.height))) || 1;
      // dirtyK maps paint dirty rects (reported in getSize() units) to bitmap pixels.
      pixelSize = { width: s.width * scale, height: s.height * scale, scale: (s.width * scale) / size.width, dirtyK: scale };
      say('[rec] frame', JSON.stringify(s), 'bitmap', full.length, '->', JSON.stringify(pixelSize), 'dirty', JSON.stringify(dirty));
    }
    if (!recording) {
      lastFull = full;
      return;
    }
    // Convert the dirty rect to bitmap pixels and pad by one pixel for safety.
    const k = pixelSize.dirtyK;
    const x = Math.max(0, Math.floor(dirty.x * k) - 1);
    const y = Math.max(0, Math.floor(dirty.y * k) - 1);
    const x2 = Math.min(pixelSize.width, Math.ceil((dirty.x + dirty.width) * k) + 1);
    const y2 = Math.min(pixelSize.height, Math.ceil((dirty.y + dirty.height) * k) + 1);
    const w = x2 - x;
    const h = y2 - y;
    if (w <= 0 || h <= 0) return;
    const stride = pixelSize.width * 4;
    let raw;
    if (w === pixelSize.width) raw = full.subarray(y * stride, y2 * stride);
    else {
      raw = Buffer.allocUnsafe(w * h * 4);
      for (let r = 0; r < h; r++) full.copy(raw, r * w * 4, (y + r) * stride + x * 4, (y + r) * stride + x2 * 4);
    }
    frames++;
    writeRecord(clock() - t0, x, y, w, h, raw);
  });

  // ------------------------------------------------------------------ scenario API
  const log = { size, moves: [], clicks: [], camera: [], marks: {}, keys: [] };
  let cur = { x: size.width * 0.62, y: size.height * 0.86 };
  const now = () => clock() - t0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => wc.executeJavaScript(code, true);
  const mouse = (type, p, extra = {}) =>
    wc.sendInputEvent({ type, x: Math.round(p.x), y: Math.round(p.y), ...extra });

  async function resolve(target) {
    if ('x' in target && 'y' in target && !target.sel) return { x: target.x, y: target.y };
    const r = await js(`__rec.find(${JSON.stringify(target.sel)}, ${JSON.stringify(target.text || '')}, ${target.index || 0})`);
    if (!r) throw new Error(`target not found: ${JSON.stringify(target)}`);
    const [fx, fy] = target.at || [0.5, 0.5];
    return { x: r.x + r.w * fx + (target.dx || 0), y: r.y + r.h * fy + (target.dy || 0), rect: r };
  }

  const api = {
    size,
    now,
    sleep,
    js,
    async rect(target) {
      return (await resolve(target)).rect;
    },
    async exists(sel, text) {
      return !!(await js(`__rec.find(${JSON.stringify(sel)}, ${JSON.stringify(text || '')}, 0)`));
    },
    async waitFor(sel, text, timeout = 30000) {
      const end = clock() + timeout;
      while (clock() < end) {
        if (await api.exists(sel, text)) return now();
        await sleep(25);
      }
      throw new Error(`timed out waiting for ${sel} ${text || ''}`);
    },
    /** Moves the cursor along an arched minimum-jerk path, sending real mouse events. */
    async moveTo(target, opts = {}) {
      const p1 = await resolve(target);
      const m = motion.planMove({ ...cur }, { x: p1.x, y: p1.y }, opts);
      const start = now();
      log.moves.push({ t0: start, ...m });
      for (;;) {
        const el = now() - start;
        const p = motion.moveAt(m, el);
        mouse('mouseMove', p);
        if (el >= m.dur) break;
        await sleep(8);
      }
      cur = { x: p1.x, y: p1.y };
      return p1;
    },
    async click(opts = {}) {
      const count = opts.double ? 2 : 1;
      for (let i = 1; i <= count; i++) {
        log.clicks.push({ t: now(), x: cur.x, y: cur.y });
        mouse('mouseDown', cur, { button: 'left', clickCount: i });
        await sleep(85);
        mouse('mouseUp', cur, { button: 'left', clickCount: i });
        if (i < count) await sleep(70);
      }
    },
    /** Smooth wheel scroll at the cursor: positive dy scrolls content down. */
    async scroll(dy, dur = 700) {
      const steps = Math.max(1, Math.round(dur / 16));
      let sent = 0;
      for (let i = 1; i <= steps; i++) {
        const target = Math.round(dy * motion.minJerk(i / steps));
        const d = target - sent;
        sent = target;
        if (d) mouse('mouseWheel', cur, { deltaX: 0, deltaY: -d, canScroll: true, hasPreciseScrollingDeltas: true });
        await sleep(16);
      }
    },
    async key(keyCode, modifiers = []) {
      log.keys.push({ t: now(), key: keyCode, modifiers });
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      await sleep(40);
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    },
    async type(text, cps = 14) {
      for (const ch of text) {
        log.keys.push({ t: now(), key: ch, modifiers: [] });
        wc.sendInputEvent({ type: 'keyDown', keyCode: ch });
        wc.sendInputEvent({ type: 'char', keyCode: ch });
        wc.sendInputEvent({ type: 'keyUp', keyCode: ch });
        await sleep(1000 / cps + (Math.random() - 0.5) * 40);
      }
    },
    /** Camera cue: { mode: 'overview' | 'follow' | 'focus', zoom, rect?, lead? } */
    camera(spec) {
      log.camera.push({ t: now(), ...spec });
    },
    mark(name) {
      log.marks[name] = now();
    },
  };

  async function run() {
    await new Promise((r) => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
    await js(HELPERS);
    wc.focus();
    await js('document.fonts.ready.then(() => true)');
    const scenario = require(path.join(__dirname, `${scenarioName}.cjs`));
    if (scenario.prepare) await scenario.prepare(api);
    // Let the first screen settle, then force a full repaint as the opening keyframe.
    await sleep(900);
    wc.invalidate();
    await sleep(200);
    if (!lastFull) throw new Error('no frame painted');
    recording = true;
    t0 = clock();
    log.start = { ...cur };
    writeRecord(0, 0, 0, pixelSize.width, pixelSize.height, lastFull);
    mouse('mouseMove', cur);
    await scenario.run(api);
    log.duration = now();
    recording = false;
    await chain;
    fs.closeSync(fd);
    log.pixel = pixelSize;
    fs.writeFileSync(path.join(outDir, 'events.json'), JSON.stringify(log, null, 1));
    say(`[rec] done: ${(log.duration / 1000).toFixed(1)} s, ${frames} paints, raw ${(bytesRaw / 1e6).toFixed(0)} MB -> ${(bytesOut / 1e6).toFixed(0)} MB`);
  }

  run()
    .then(() => app.exit(0))
    .catch(async (err) => {
      say('[rec] failed:', err && err.stack ? err.stack : err);
      recording = false;
      log.duration = now();
      log.pixel = pixelSize;
      try {
        await chain;
        fs.closeSync(fd);
        fs.writeFileSync(path.join(outDir, 'events.json'), JSON.stringify(log, null, 1));
      } catch {}
      app.exit(1);
    });
};
