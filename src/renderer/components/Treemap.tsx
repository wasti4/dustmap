// Squarified treemap of the focused folder, laid out by the engine and drawn on
// a canvas. Click selects, double-click zooms into a folder.
import { useEffect, useRef, useState } from 'react';
import { TM_STRIDE, type NodeInfo, type TreemapResult } from '../../shared/types';
import { engine } from '../lib/api';
import { useT } from '../lib/i18n';
import { catColor, rgba } from '../lib/categories';
import { fmtBytes, fmtPercent } from '../lib/format';
import { focusNode, setState, useStore } from '../state';
import { ContextMenu, useElementSize, type MenuItem } from './ui';
import { nodeMenu } from './actions';

export function Treemap({ focusId }: { focusId: number }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const metric = useStore((s) => s.prefs.metric);
  const version = useStore((s) => s.version);
  const selectedId = useStore((s) => s.selectedId);
  const dark = useStore((s) => s.dark);
  const [wrapRef, size] = useElementSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<TreemapResult | null>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  useEffect(() => {
    if (focusId < 0 || size.w < 20 || size.h < 20) return;
    let alive = true;
    const id = setTimeout(() => {
      engine<TreemapResult>('treemap', { id: focusId, w: size.w, h: size.h, metric, maxRects: 5000 }).then((r) => alive && setData(r));
    }, 90);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [focusId, size.w, size.h, metric, version]);

  // Draw.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !data) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const r = data.rects;
    const n = r.length / TM_STRIDE;
    const text = dark ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.96)';
    const headText = dark ? 'rgba(255,255,255,0.78)' : 'rgba(24,24,27,0.8)';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < n; i++) {
      const o = i * TM_STRIDE;
      const x = r[o];
      const y = r[o + 1];
      const w = r[o + 2];
      const h = r[o + 3];
      const cat = r[o + 5];
      const flags = r[o + 7];
      const color = catColor(cat, dark);
      if (flags & 1) {
        ctx.fillStyle = rgba(color, dark ? 0.09 : 0.1);
        ctx.fillRect(x + 0.5, y + 0.5, w - 1, h - 1);
        ctx.strokeStyle = rgba(color, dark ? 0.38 : 0.45);
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        if (flags & 2 && data.names[i]) {
          ctx.font = '600 11px Inter Variable, Segoe UI, sans-serif';
          ctx.fillStyle = headText;
          const label = `${data.names[i]}  ${fmtBytes(r[o + 8], lang)}`;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x + 2, y, w - 4, 18);
          ctx.clip();
          ctx.fillText(label, x + 6, y + 10);
          ctx.restore();
        }
      } else {
        ctx.fillStyle = rgba(color, dark ? 0.78 : 0.82);
        ctx.fillRect(x + 0.5, y + 0.5, Math.max(0.5, w - 1), Math.max(0.5, h - 1));
        if (w > 4 && h > 4) {
          ctx.fillStyle = 'rgba(255,255,255,0.14)';
          ctx.fillRect(x + 0.5, y + 0.5, w - 1, 1);
        }
        if (data.names[i] && w > 56 && h > 30) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x + 2, y + 2, w - 4, h - 4);
          ctx.clip();
          ctx.fillStyle = text;
          ctx.font = '600 11px Inter Variable, Segoe UI, sans-serif';
          ctx.fillText(data.names[i], x + 6, y + 12);
          ctx.font = '400 11px Inter Variable, Segoe UI, sans-serif';
          ctx.fillStyle = 'rgba(255,255,255,0.75)';
          ctx.fillText(fmtBytes(r[o + 8], lang), x + 6, y + 26);
          ctx.restore();
        }
      }
    }
    const mark = (i: number, color: string, width: number) => {
      const o = i * TM_STRIDE;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.strokeRect(r[o] + width / 2, r[o + 1] + width / 2, r[o + 2] - width, r[o + 3] - width);
    };
    for (let i = 0; i < n; i++) if (r[i * TM_STRIDE + 4] === selectedId) mark(i, dark ? '#ffffff' : '#18181b', 2);
    if (hover) mark(hover.i, dark ? 'rgba(255,255,255,0.85)' : 'rgba(24,24,27,0.85)', 1.5);
  }, [data, size, dark, hover, selectedId, lang]);

  const hitTest = (e: React.MouseEvent) => {
    if (!data) return -1;
    const b = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - b.left;
    const y = e.clientY - b.top;
    const r = data.rects;
    for (let i = r.length / TM_STRIDE - 1; i >= 0; i--) {
      const o = i * TM_STRIDE;
      if (x >= r[o] && x < r[o] + r[o + 2] && y >= r[o + 1] && y < r[o + 1] + r[o + 3]) return i;
    }
    return -1;
  };
  const nodeAt = (i: number): NodeInfo | null => {
    if (!data || i < 0) return null;
    const o = i * TM_STRIDE;
    const v = data.rects[o + 8];
    return {
      id: data.rects[o + 4],
      name: data.names[i],
      dir: (data.rects[o + 7] & 1) === 1,
      size: v,
      alloc: v,
      files: 0,
      dirs: 0,
      mtime: 0,
      atime: 0,
      ctime: 0,
      last: 0,
      cat: data.rects[o + 5],
      flags: 0,
      hasKids: false,
    };
  };

  const total = data && data.rects.length ? Array.from({ length: data.rects.length / TM_STRIDE }, (_, i) => i).filter((i) => data.rects[i * TM_STRIDE + 6] === 1).reduce((a, i) => a + data.rects[i * TM_STRIDE + 8], 0) : 0;
  const hv = hover && data ? hover.i * TM_STRIDE : -1;

  return (
    <div ref={wrapRef} className="treemap" aria-label={t('ex.view.map')} role="img">
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h }}
        onMouseMove={(e) => {
          const i = hitTest(e);
          const b = e.currentTarget.getBoundingClientRect();
          setHover(i >= 0 ? { i, x: e.clientX - b.left, y: e.clientY - b.top } : null);
        }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const n = nodeAt(hitTest(e));
          if (n) setState({ selectedId: n.id });
        }}
        onDoubleClick={(e) => {
          const n = nodeAt(hitTest(e));
          if (n?.dir) focusNode(n.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const n = nodeAt(hitTest(e));
          if (!n) return;
          setState({ selectedId: n.id });
          setMenu({ x: e.clientX, y: e.clientY, items: nodeMenu(n) });
        }}
      />
      {hover && data && hv >= 0 && (
        <div className="tm-tip" style={{ left: Math.min(hover.x + 14, size.w - 220), top: Math.min(hover.y + 16, size.h - 64) }}>
          <div className="tm-tip-name">{data.names[hover.i] || '…'}</div>
          <div className="muted">
            {fmtBytes(data.rects[hv + 8], lang)}
            {total > 0 ? ` · ${fmtPercent(data.rects[hv + 8] / total, lang)}` : ''}
          </div>
        </div>
      )}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
