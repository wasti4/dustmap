import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, File, Folder, Link2, LoaderCircle, Minus, type LucideIcon } from 'lucide-react';
import { CAT_META, catColor, rgba } from '../lib/categories';
import { useStore } from '../state';
import type { NodeInfo } from '../../shared/types';
import { NF } from '../../shared/types';

export function CatIcon({ cat, size = 16, dim = false }: { cat: number; size?: number; dim?: boolean }) {
  const dark = useStore((s) => s.dark);
  const meta = CAT_META[cat] ?? CAT_META[CAT_META.length - 1];
  const color = catColor(cat, dark);
  return (
    <meta.Icon
      aria-hidden
      size={size}
      strokeWidth={2}
      color={color}
      fill={rgba(color, dim ? 0.12 : 0.22)}
      style={{ flex: 'none', opacity: dim ? 0.55 : 1 }}
    />
  );
}

export function NodeIcon({ node, size = 16 }: { node: NodeInfo; size?: number }) {
  const dark = useStore((s) => s.dark);
  const color = catColor(node.cat, dark);
  if (node.flags & NF.LINK) return <Link2 aria-hidden size={size} className="muted-icon" />;
  const Icon = node.dir ? Folder : File;
  return <Icon aria-hidden size={size} strokeWidth={1.9} color={color} fill={rgba(color, node.dir ? 0.2 : 0.12)} style={{ flex: 'none' }} />;
}

export function Button({
  children,
  onClick,
  kind = 'secondary',
  icon: Icon,
  disabled,
  title,
  small,
  type = 'button',
  autoFocus,
}: {
  children?: ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
  icon?: LucideIcon;
  disabled?: boolean;
  title?: string;
  small?: boolean;
  type?: 'button' | 'submit';
  autoFocus?: boolean;
}) {
  return (
    <button type={type} className={`btn btn-${kind}${small ? ' btn-sm' : ''}`} onClick={onClick} disabled={disabled} title={title} autoFocus={autoFocus}>
      {Icon && <Icon aria-hidden size={small ? 14 : 16} />}
      {children}
    </button>
  );
}

export function IconButton({ icon: Icon, label, onClick, active, size = 16 }: { icon: LucideIcon; label: string; onClick?: () => void; active?: boolean; size?: number }) {
  return (
    <button type="button" className={`icon-btn${active ? ' is-active' : ''}`} onClick={onClick} aria-label={label} title={label} aria-pressed={active}>
      <Icon aria-hidden size={size} />
    </button>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const n = (idx + (e.key === 'ArrowRight' ? 1 : options.length - 1)) % options.length;
    onChange(options[n].value);
    refs.current[n]?.focus();
  };
  return (
    <div className="segmented" role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className={o.value === value ? 'is-on' : ''}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Checkbox({ checked, mixed, onChange, label }: { checked: boolean; mixed?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={mixed ? 'mixed' : checked}
      aria-label={label}
      className={`check${checked || mixed ? ' is-on' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    >
      {mixed ? <Minus size={12} strokeWidth={3} /> : checked ? <Check size={12} strokeWidth={3} /> : null}
    </button>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`switch${checked ? ' is-on' : ''}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle aria-hidden size={size} className="spin" />;
}

export function Modal({ title, children, onClose, footer, width = 560, labelledBy = 'modal-title' }: { title: ReactNode; children: ReactNode; onClose: () => void; footer?: ReactNode; width?: number; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[autofocus], button, [href], input, select, [tabindex]:not([tabindex="-1"])');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab' && el) {
        const items = [...el.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, select, [tabindex]:not([tabindex="-1"])')];
        if (!items.length) return;
        const a = items[0];
        const b = items[items.length - 1];
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          b.focus();
        } else if (!e.shiftKey && document.activeElement === b) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy} style={{ width }}>
        <h2 id={labelledBy} className="modal-title">
          {title}
        </h2>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
    el.querySelector<HTMLElement>('button')?.focus();
  }, [x, y]);
  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      }
    };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="menu" role="menu" style={{ left: pos.x, top: pos.y }}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`menu-item${it.danger ? ' is-danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            {it.icon && <it.icon aria-hidden size={15} />}
            {it.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** Thin horizontal share bar. */
export function ShareBar({ value, cat }: { value: number; cat: number }) {
  const dark = useStore((s) => s.dark);
  const c = catColor(cat, dark);
  return (
    <span className="share" aria-hidden>
      <span style={{ width: `${Math.max(1.5, Math.min(100, value * 100))}%`, background: c }} />
    </span>
  );
}

export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect;
      setSize((s) => (Math.abs(s.w - r.width) < 0.5 && Math.abs(s.h - r.height) < 0.5 ? s : { w: r.width, h: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}
