// Light/dark switch: a glassy knob slides along a recessed track. The pixel
// sun and moon dissolve into dots and re-form when the theme changes.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useT } from '../lib/i18n';
import { setPrefs, useStore } from '../state';

const N = 11; // icon grid
const PITCH = 2.5; // CSS px between dot centres
const DOT = 2; // CSS px dot size
const SIZE = N * PITCH;

type Cell = [number, number, number]; // x, y, alpha

const SUN: Cell[] = (() => {
  const out: Cell[] = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if ((x - 5) ** 2 + (y - 5) ** 2 <= 4.5) out.push([x, y, 1]);
  const rays: [number, number][] = [
    [5, 0],
    [5, 1],
    [5, 9],
    [5, 10],
    [0, 5],
    [1, 5],
    [9, 5],
    [10, 5],
    [2, 2],
    [8, 2],
    [2, 8],
    [8, 8],
  ];
  for (const [x, y] of rays) out.push([x, y, 0.85]);
  return out;
})();

const MOON: Cell[] = (() => {
  const out: Cell[] = [];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const disc = (x - 4.6) ** 2 + (y - 5.6) ** 2 <= 17;
      const bite = (x - 7.2) ** 2 + (y - 3.4) ** 2 <= 11;
      if (disc && !bite) out.push([x, y, 1]);
    }
  out.push([9, 1, 1], [9, 0, 0.5], [8, 1, 0.5], [10, 1, 0.5], [9, 2, 0.5]); // sparkle
  return out;
})();

interface Particle {
  x: number;
  y: number;
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  a: number;
  delay: number;
  incoming: boolean;
  color: string;
}

const colorFor = (dark: boolean) => (dark ? '#f4f4f5' : '#3f3f46');

export function ThemeToggle() {
  const t = useT();
  const dark = useStore((s) => s.dark);
  const reduced = useStore((s) => s.reducedMotion);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const prev = useRef(dark);
  const raf = useRef(0);

  const drawStatic = (isDark: boolean) => {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(SIZE * dpr);
    c.height = Math.round(SIZE * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    for (const [x, y, a] of isDark ? MOON : SUN) {
      ctx.globalAlpha = a;
      ctx.fillStyle = isDark && y <= 2 && x >= 8 ? '#c7c9ff' : colorFor(isDark);
      ctx.fillRect(x * PITCH, y * PITCH, DOT, DOT);
    }
    ctx.globalAlpha = 1;
  };

  useLayoutEffect(() => {
    drawStatic(dark);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (prev.current === dark) return;
    const from = prev.current;
    prev.current = dark;
    cancelAnimationFrame(raf.current);
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || reduced) {
      drawStatic(dark);
      return;
    }
    const mid = (N - 1) / 2;
    const parts: Particle[] = [];
    for (const [x, y, a] of from ? MOON : SUN) {
      const ang = Math.atan2(y - mid, x - mid) + (Math.random() - 0.5) * 1.6;
      const dist = 6 + Math.random() * 10;
      parts.push({ x: 0, y: 0, fx: x * PITCH, fy: y * PITCH, tx: x * PITCH + Math.cos(ang) * dist, ty: y * PITCH + Math.sin(ang) * dist, a, delay: Math.random() * 80, incoming: false, color: colorFor(from) });
    }
    for (const [x, y, a] of dark ? MOON : SUN) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 5 + Math.random() * 9;
      parts.push({ x: 0, y: 0, fx: x * PITCH + Math.cos(ang) * dist, fy: y * PITCH + Math.sin(ang) * dist, tx: x * PITCH, ty: y * PITCH, a, delay: 140 + Math.random() * 160, incoming: true, color: colorFor(dark) });
    }
    const start = performance.now();
    const OUT = 320;
    const IN = 380;
    const ease = (k: number) => 1 - (1 - k) ** 3;
    const frame = (now: number) => {
      const el = now - start;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);
      let alive = false;
      for (const p of parts) {
        const k = Math.max(0, Math.min(1, (el - p.delay) / (p.incoming ? IN : OUT)));
        if (k < 1) alive = true;
        const e = ease(k);
        const x = p.fx + (p.tx - p.fx) * e;
        const y = p.fy + (p.ty - p.fy) * e;
        ctx.globalAlpha = p.a * (p.incoming ? e : 1 - e);
        ctx.fillStyle = p.color;
        ctx.fillRect(x, y, DOT, DOT);
      }
      ctx.globalAlpha = 1;
      if (alive) raf.current = requestAnimationFrame(frame);
      else drawStatic(dark);
    };
    raf.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dark, reduced]);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label={t('theme.dark')}
      title={dark ? t('theme.toLight') : t('theme.toDark')}
      className={`theme-toggle${dark ? ' is-dark' : ''}`}
      onClick={() => {
        if (!reduced) {
          document.documentElement.classList.add('theme-anim');
          setTimeout(() => document.documentElement.classList.remove('theme-anim'), 600);
        }
        setPrefs({ theme: dark ? 'light' : 'dark' });
      }}
    >
      <span className="tt-knob">
        <canvas ref={canvasRef} aria-hidden style={{ width: SIZE, height: SIZE }} />
      </span>
    </button>
  );
}
