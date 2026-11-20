// The dot-matrix storage bar: one segment per category drawn as a grid of
// small squares, a glowing scan edge while scanning, and particles that drift
// away when a segment shrinks after a cleanup.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { catColor, rgba } from '../lib/categories';

interface Props {
  values: number[];
  capacity: number;
  /** Uncategorised bytes (used while the MFT is read and categories are unknown). */
  neutral?: number;
  active: number | null;
  scanning: boolean;
  dark: boolean;
  reducedMotion: boolean;
  height: number;
  label: string;
  onHover?: (cat: number | null) => void;
  onSelect?: (cat: number) => void;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
}

function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a + 1, 0x27d4eb2d) ^ Math.imul(b + 7, 0x165667b1) ^ Math.imul(c + 13, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Extra canvas space above/below the bar so particles can float out of it. */
const OVER = 28;

export function DotBar(props: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const sim = useRef(initSim());
  const kick = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    const wrap = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      const s = sim.current;
      s.dpr = window.devicePixelRatio || 1;
      s.w = Math.round(wrap.clientWidth * s.dpr);
      s.h = Math.round(propsRef.current.height * s.dpr);
      s.top = Math.round(OVER * s.dpr);
      const c = canvasRef.current!;
      c.width = s.w;
      c.height = s.h + s.top * 2;
      c.style.width = `${wrap.clientWidth}px`;
      c.style.height = `${propsRef.current.height + OVER * 2}px`;
      s.dirty = true;
      kick.current();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [props.height]);

  useEffect(() => {
    sim.current.dirty = true;
    kick.current();
  }, [props.values, props.capacity, props.active, props.scanning, props.dark, props.height, props.neutral]);

  // The render loop only runs while something moves. Idle "twinkle" frames are
  // drawn at ~7 fps and only while the window has focus, so an idle window
  // costs no CPU at all.
  useEffect(() => {
    let raf = 0;
    let timer = 0;
    let last = performance.now();
    let lastInput = performance.now();
    // Ambient twinkle only while someone is actually using the window.
    const twinkleOn = () => !propsRef.current.reducedMotion && !document.hidden && document.hasFocus() && performance.now() - lastInput < 15000;
    const start = () => {
      if (timer) {
        clearTimeout(timer);
        timer = 0;
      }
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const frame = (now: number) => {
      raf = 0;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const p = propsRef.current;
      const s = sim.current;
      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx || !s.w || !s.h) return;

      // Ease displayed values toward their targets.
      const k = p.reducedMotion ? 1 : 1 - Math.exp(-dt * (p.scanning ? 6 : 5));
      let moving = false;
      for (let i = 0; i < p.values.length; i++) {
        const target = p.values[i] || 0;
        const cur = s.display[i] ?? 0;
        const next = Math.abs(target - cur) < p.capacity * 1e-5 ? target : cur + (target - cur) * k;
        if (next !== cur) moving = true;
        s.display[i] = next;
      }
      const nTarget = p.neutral ?? 0;
      const nNext = Math.abs(nTarget - s.neutral) < p.capacity * 1e-5 ? nTarget : s.neutral + (nTarget - s.neutral) * k;
      if (nNext !== s.neutral) moving = true;
      s.neutral = nNext;

      const twinkle = twinkleOn() && now - s.lastTwinkle >= 130;
      if (moving || twinkle || s.particles.length || p.scanning || s.dirty) {
        if (twinkle) s.lastTwinkle = now;
        s.dirty = false;
        ctx.clearRect(0, 0, s.w, s.h + s.top * 2);
        ctx.save();
        ctx.translate(0, s.top);
        draw(ctx, p, s, now, dt);
        ctx.restore();
      }
      if (moving || s.particles.length || p.scanning) raf = requestAnimationFrame(frame);
      else if (twinkleOn())
        timer = window.setTimeout(() => {
          timer = 0;
          start();
        }, 140);
    };
    kick.current = start;
    const wake = () => {
      sim.current.dirty = true;
      start();
    };
    const onInput = () => {
      const idle = performance.now() - lastInput >= 15000;
      lastInput = performance.now();
      if (idle) start();
    };
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pointermove', onInput, { passive: true });
    window.addEventListener('keydown', onInput);
    start();
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      kick.current = () => undefined;
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pointermove', onInput);
      window.removeEventListener('keydown', onInput);
    };
  }, []);

  const hit = (clientX: number): number | null => {
    const r = wrapRef.current!.getBoundingClientRect();
    const x = (clientX - r.left) * sim.current.dpr;
    for (const seg of sim.current.segs) if (x >= seg.x0 && x < seg.x1) return seg.cat;
    return null;
  };

  return (
    <div
      ref={wrapRef}
      className="dotbar"
      style={{ height: props.height }}
      role="img"
      aria-label={props.label}
      onMouseMove={(e) => props.onHover?.(hit(e.clientX))}
      onMouseLeave={() => props.onHover?.(null)}
      onClick={(e) => {
        const c = hit(e.clientX);
        if (c !== null && c >= 0) props.onSelect?.(c);
      }}
    >
      <canvas ref={canvasRef} aria-hidden style={{ position: 'absolute', left: 0, top: -OVER }} />
    </div>
  );
}

function draw(ctx: CanvasRenderingContext2D, p: Props, s: ReturnType<typeof initSim>, now: number, dt: number) {
  const { w, h, dpr } = s;
  const dark = p.dark;
  const radius = Math.min(14 * dpr, h / 2);
  const pitch = Math.max(5, Math.round(7 * dpr));
  const dot = Math.max(2, Math.round(pitch * 0.56));
  const cols = Math.floor((w - (pitch - dot)) / pitch);
  const rows = Math.floor((h - (pitch - dot)) / pitch);
  const ox = Math.round((w - cols * pitch + (pitch - dot)) / 2);
  const oy = Math.round((h - rows * pitch + (pitch - dot)) / 2);
  const cap = Math.max(1, p.capacity);
  const tick = p.reducedMotion ? 0 : now / 900;

  // Segment layout in device pixels.
  const segs: { cat: number; x0: number; x1: number }[] = [];
  let x = 0;
  const widths: number[] = [];
  for (let i = 0; i < s.display.length; i++) {
    const width = (Math.max(0, s.display[i]) / cap) * w;
    widths[i] = width;
    if (width >= 0.5) segs.push({ cat: i, x0: x, x1: x + width });
    x += width;
  }
  if (s.neutral > 0) {
    const width = (s.neutral / cap) * w;
    segs.push({ cat: -2, x0: x, x1: x + width });
    x += width;
  }
  const usedEnd = Math.min(w, x);

  // Particles where a segment shrank.
  if (!p.reducedMotion && !p.scanning) {
    for (const seg of segs) {
      const prev = s.widths[seg.cat];
      const cur = widths[seg.cat];
      if (prev !== undefined && prev - cur > 0.6) {
        const n = Math.min(60, Math.ceil(((prev - cur) / pitch) * rows * 0.5));
        const color = catColor(seg.cat, dark);
        for (let i = 0; i < n; i++) {
          s.particles.push({
            x: seg.x1 + Math.random() * (prev - cur + pitch),
            y: oy + Math.floor(Math.random() * rows) * pitch,
            vx: (20 + Math.random() * 110) * dpr,
            vy: -(25 + Math.random() * 120) * dpr,
            life: 0,
            max: 0.6 + Math.random() * 0.9,
            color,
          });
        }
      }
    }
    if (s.particles.length > 900) s.particles.splice(0, s.particles.length - 900);
  }
  s.widths = widths;
  s.segs = segs;

  ctx.save();
  roundRect(ctx, 0.5, 0.5, w - 1, h - 1, radius);
  ctx.clip();

  ctx.fillStyle = dark ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.03)';
  ctx.fillRect(0, 0, w, h);

  const colorOf = (cat: number) => (cat === -2 ? (dark ? '#e4e4e7' : '#52525b') : catColor(cat, dark));
  for (const seg of segs) {
    const dim = p.active !== null && p.active !== seg.cat;
    const on = p.active === seg.cat;
    ctx.fillStyle = rgba(colorOf(seg.cat), dim ? 0.035 : on ? 0.2 : 0.1);
    ctx.fillRect(seg.x0, 0, seg.x1 - seg.x0, h);
  }

  // Dots.
  let si = 0;
  const freeDot = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.075)';
  for (let c = 0; c < cols; c++) {
    const cx = ox + c * pitch + dot / 2;
    while (si < segs.length && segs[si].x1 <= cx) si++;
    const seg = si < segs.length && segs[si].x0 <= cx ? segs[si] : null;
    const dx = ox + c * pitch;
    if (!seg) {
      ctx.fillStyle = freeDot;
      for (let r = 0; r < rows; r++) ctx.fillRect(dx, oy + r * pitch, dot, dot);
      continue;
    }
    const color = colorOf(seg.cat);
    const dim = p.active !== null && p.active !== seg.cat;
    const on = p.active === seg.cat;
    const nearEdge = p.scanning && usedEnd - cx < pitch * 4;
    const base = rgba(color, dim ? 0.08 : on ? 0.34 : 0.24);
    const lit = dim ? rgba(color, 0.32) : color;
    for (let r = 0; r < rows; r++) {
      const edgeRow = r === 0 || r === rows - 1 ? 0.62 : r === 1 || r === rows - 2 ? 0.3 : 0.06;
      const prob = on ? 0.82 : seg.cat === -2 ? 0.25 : edgeRow;
      const phase = hash(c, r, 99) * 7;
      const v = hash(c, r, Math.floor(tick + phase));
      const dy = oy + r * pitch;
      if (nearEdge && v < 0.7) {
        ctx.fillStyle = dark ? '#ffffff' : '#18181b';
      } else if (v < prob) {
        ctx.fillStyle = !dim && v < prob * 0.06 ? (dark ? '#ffffff' : color) : lit;
      } else {
        ctx.fillStyle = base;
      }
      ctx.fillRect(dx, dy, dot, dot);
    }
  }

  // Segment outlines: rounded outer corners, straight separators.
  ctx.lineWidth = Math.max(1, dpr * 1.25);
  for (const seg of segs) {
    const color = colorOf(seg.cat);
    const dim = p.active !== null && p.active !== seg.cat;
    const on = p.active === seg.cat;
    ctx.save();
    ctx.beginPath();
    ctx.rect(seg.x0, 0, seg.x1 - seg.x0, h);
    ctx.clip();
    ctx.strokeStyle = rgba(color, dim ? 0.22 : on ? 1 : 0.62);
    if (on) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 14 * dpr;
    }
    roundRect(ctx, ctx.lineWidth / 2 + 0.5, ctx.lineWidth / 2 + 0.5, w - ctx.lineWidth - 1, h - ctx.lineWidth - 1, radius);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(seg.x0 + 0.5, 0);
    ctx.lineTo(seg.x0 + 0.5, h);
    ctx.moveTo(seg.x1 - 0.5, 0);
    ctx.lineTo(seg.x1 - 0.5, h);
    ctx.stroke();
    ctx.restore();
  }

  // Free space outline.
  ctx.save();
  ctx.beginPath();
  ctx.rect(usedEnd, 0, w - usedEnd, h);
  ctx.clip();
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.09)';
  roundRect(ctx, 1, 1, w - 2, h - 2, radius);
  ctx.stroke();
  ctx.restore();

  // Glowing scan edge.
  if (p.scanning && usedEnd > 2) {
    const pulse = p.reducedMotion ? 1 : 0.75 + 0.25 * Math.sin(now / 160);
    const g = ctx.createLinearGradient(usedEnd - 70 * dpr, 0, usedEnd, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(1, dark ? `rgba(255,255,255,${0.32 * pulse})` : `rgba(24,24,27,${0.18 * pulse})`);
    ctx.fillStyle = g;
    ctx.fillRect(Math.max(0, usedEnd - 70 * dpr), 0, Math.min(usedEnd, 70 * dpr), h);
    ctx.save();
    ctx.shadowColor = dark ? '#ffffff' : '#18181b';
    ctx.shadowBlur = 18 * dpr * pulse;
    ctx.fillStyle = dark ? '#ffffff' : '#18181b';
    ctx.fillRect(usedEnd - 2 * dpr, 0, 2 * dpr, h);
    ctx.restore();
  }
  ctx.restore();

  // Particles drift outside the bar's clip so they can float away.
  if (s.particles.length) {
    for (const q of s.particles) {
      q.life += dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.vy -= 30 * dpr * dt;
      const a = Math.max(0, 1 - q.life / q.max);
      ctx.fillStyle = rgba(q.color, a);
      ctx.fillRect(q.x, q.y, dot, dot);
    }
    s.particles = s.particles.filter((q) => q.life < q.max);
  }
}

function initSim() {
  return {
    top: 0,
    display: [] as number[],
    neutral: 0,
    widths: [] as number[],
    particles: [] as Particle[],
    w: 0,
    h: 0,
    dpr: 1,
    dirty: true,
    lastTwinkle: 0,
    segs: [] as { cat: number; x0: number; x1: number }[],
  };
}
