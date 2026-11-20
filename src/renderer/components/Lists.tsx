// Result lists: largest files, forgotten items, search results and file types.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { FolderOpen, Info, Search, Trash, X } from 'lucide-react';
import { CATEGORIES, type FileTypeRow, type ListResult, type NodeInfo } from '../../shared/types';
import { engine } from '../lib/api';
import { useT } from '../lib/i18n';
import { catColor } from '../lib/categories';
import { fmtAgo, fmtBytes, fmtCount, fmtPercent, shortPath } from '../lib/format';
import { setState, useStore } from '../state';
import { Button, CatIcon, Checkbox, ContextMenu, NodeIcon, Segmented, ShareBar, Spinner, Switch, useElementSize, type MenuItem } from './ui';
import { askRemove, nodeMenu, revealNode } from './actions';

const MB = 1024 * 1024;
const ROW = 46;

export function NodeList({ items, loading, empty, head }: { items: NodeInfo[]; loading: boolean; empty: string; head?: ReactNode }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const metric = useStore((s) => s.prefs.metric);
  const home = useStore((s) => s.startup?.home ?? '');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [bodyRef, size] = useElementSize<HTMLDivElement>();
  const [scrollTop, setScrollTop] = useState(0);
  const value = (n: NodeInfo) => (metric === 'size' ? n.size : n.alloc);

  useEffect(() => {
    setSel(new Set());
    setCursor(0);
  }, [items]);

  const chosen = items.filter((n) => sel.has(n.id));
  const chosenBytes = chosen.reduce((a, n) => a + value(n), 0);
  const allOn = items.length > 0 && chosen.length === items.length;
  const toggle = (id: number) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const onKey = (e: React.KeyboardEvent) => {
    const n = items[cursor];
    if (e.key === 'ArrowDown') setCursor((c) => Math.min(items.length - 1, c + 1));
    else if (e.key === 'ArrowUp') setCursor((c) => Math.max(0, c - 1));
    else if (e.key === ' ' && n) toggle(n.id);
    else if (e.key === 'Enter' && n) void revealNode(n);
    else if (e.key === 'Delete' && (chosen.length || n)) askRemove(chosen.length ? chosen : [n], e.shiftKey ? 'permanent' : 'trash');
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const y = cursor * ROW;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ROW > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW - el.clientHeight;
  }, [cursor, bodyRef]);

  const first = Math.max(0, Math.floor(scrollTop / ROW) - 5);
  const last = Math.min(items.length, Math.ceil((scrollTop + size.h) / ROW) + 5);

  return (
    <div className="nodelist">
      <div className="list-head">
        <Checkbox checked={allOn} mixed={!allOn && chosen.length > 0} onChange={(v) => setSel(v ? new Set(items.map((n) => n.id)) : new Set())} label={t('list.selectAll')} />
        <div className="list-head-text">{head}</div>
        {loading && <Spinner size={15} />}
      </div>
      <div
        ref={bodyRef}
        className="list-body"
        role="listbox"
        aria-multiselectable="true"
        tabIndex={0}
        aria-activedescendant={items[cursor] ? `li-${items[cursor].id}` : undefined}
        onKeyDown={onKey}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {!loading && items.length === 0 && <div className="empty">{empty}</div>}
        <div style={{ height: items.length * ROW, position: 'relative' }}>
          {items.slice(first, last).map((n, k) => {
            const i = first + k;
            const parent = n.path ? n.path.slice(0, Math.max(0, n.path.length - n.name.length - 1)) : '';
            return (
              <div
                key={n.id}
                id={`li-${n.id}`}
                role="option"
                aria-selected={sel.has(n.id)}
                className={`li${sel.has(n.id) ? ' is-checked' : ''}${cursor === i ? ' is-cursor' : ''}`}
                style={{ transform: `translateY(${i * ROW}px)` }}
                onClick={() => {
                  setCursor(i);
                  toggle(n.id);
                }}
                onDoubleClick={() => void revealNode(n)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCursor(i);
                  setMenu({ x: e.clientX, y: e.clientY, items: nodeMenu(n, { zoom: false }) });
                }}
              >
                <Checkbox checked={sel.has(n.id)} onChange={() => toggle(n.id)} label={n.name} />
                <NodeIcon node={n} size={18} />
                <div className="li-text">
                  <div className="ellipsis li-name" title={n.name}>
                    {n.name}
                  </div>
                  <div className="ellipsis muted small mono-ish" title={n.path}>
                    {shortPath(parent, home)}
                  </div>
                </div>
                <span className="li-last muted small" title={n.last ? new Date(n.last * 1000).toLocaleString(lang) : ''}>
                  {fmtAgo(n.last, lang)}
                </span>
                <span className="li-size num">{fmtBytes(value(n), lang)}</span>
              </div>
            );
          })}
        </div>
      </div>
      {chosen.length > 0 && (
        <div className="action-bar" role="region" aria-label={t('list.selected', { count: chosen.length, size: '' })}>
          <span>{t('list.selected', { count: fmtCount(chosen.length, lang), size: fmtBytes(chosenBytes, lang) })}</span>
          <span className="spacer" />
          {chosen.length === 1 && (
            <Button small kind="ghost" icon={FolderOpen} onClick={() => void revealNode(chosen[0])}>
              {t('act.reveal')}
            </Button>
          )}
          <Button small icon={Trash} onClick={() => askRemove(chosen, 'trash')}>
            {t('act.trash')}
          </Button>
          <Button small kind="danger" icon={X} onClick={() => askRemove(chosen, 'permanent')}>
            {t('act.delete')}
          </Button>
        </div>
      )}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function CatChips({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  const t = useT();
  const dark = useStore((s) => s.dark);
  return (
    <div className="chips" role="group" aria-label={t('col.cat')}>
      <button type="button" className={`chip${value.length === 0 ? ' is-on' : ''}`} aria-pressed={value.length === 0} onClick={() => onChange([])}>
        {t('list.all')}
      </button>
      {CATEGORIES.map((c, i) => {
        const on = value.includes(i);
        return (
          <button
            key={c}
            type="button"
            className={`chip${on ? ' is-on' : ''}`}
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== i) : [...value, i])}
            style={on ? { borderColor: catColor(i, dark) } : undefined}
          >
            <span className="dot" style={{ background: catColor(i, dark) }} />
            {t(`cat.${c}`)}
          </button>
        );
      })}
    </div>
  );
}

function useDebounced<T>(v: T, ms = 250): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const id = setTimeout(() => setD(v), ms);
    return () => clearTimeout(id);
  }, [v, ms]);
  return d;
}

export function LargestFiles() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const metric = useStore((s) => s.prefs.metric);
  const version = useStore((s) => s.version);
  const rootId = useStore((s) => s.summary?.rootId ?? -1);
  const catFilter = useStore((s) => s.catFilter);
  const fileQuery = useStore((s) => s.fileQuery);
  const [cats, setCats] = useState<number[]>(catFilter !== null ? [catFilter] : []);
  const [query, setQuery] = useState(fileQuery);
  const dq = useDebounced(query);
  const [res, setRes] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (catFilter !== null) setCats([catFilter]);
  }, [catFilter]);
  useEffect(() => setQuery(fileQuery), [fileQuery]);

  useEffect(() => {
    if (rootId < 0) return;
    let alive = true;
    setLoading(true);
    engine<ListResult>('topFiles', { scopeId: rootId, limit: 500, metric, cats, query: dq }).then((r) => {
      if (!alive) return;
      setRes(r);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [rootId, metric, cats, dq, version]);

  return (
    <div className="tab-pane">
      <div className="filters">
        <label className="search-field">
          <Search size={15} aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('list.filter')} aria-label={t('list.filter')} />
        </label>
        <CatChips
          value={cats}
          onChange={(v) => {
            setCats(v);
            setState({ catFilter: null });
          }}
        />
      </div>
      <NodeList
        items={res?.items ?? []}
        loading={loading}
        empty={t('list.none')}
        head={res ? t('files.summary', { count: fmtCount(res.items.length, lang), total: fmtCount(res.total, lang) }) : ''}
      />
    </div>
  );
}

const PERIODS = [90, 180, 365, 730, 1095] as const;
const SIZES = [10 * MB, 100 * MB, 1024 * MB] as const;

export function Forgotten() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const metric = useStore((s) => s.prefs.metric);
  const version = useStore((s) => s.version);
  const rootId = useStore((s) => s.summary?.rootId ?? -1);
  const tracking = useStore((s) => s.summary?.accessTracking ?? 'unknown');
  const [days, setDays] = useState<number>(365);
  const [minSize, setMinSize] = useState<number>(100 * MB);
  const [mode, setMode] = useState<'smart' | 'files'>('smart');
  const [includeSystem, setIncludeSystem] = useState(false);
  const [cats, setCats] = useState<number[]>([]);
  const [res, setRes] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (rootId < 0) return;
    let alive = true;
    setLoading(true);
    engine<ListResult>('stale', { days, minSize, mode, cats, includeSystem, scopeId: rootId, limit: 1000, metric }).then((r) => {
      if (!alive) return;
      setRes(r);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [rootId, days, minSize, mode, cats, includeSystem, metric, version]);

  return (
    <div className="tab-pane">
      <div className="filters">
        <div className="filter-row">
          <span className="filter-label">{t('fg.period')}</span>
          <Segmented label={t('fg.period')} value={days} onChange={setDays} options={PERIODS.map((d) => ({ value: d, label: t(`fg.p${d}`) }))} />
          <span className="filter-label">{t('fg.size')}</span>
          <Segmented label={t('fg.size')} value={minSize} onChange={setMinSize} options={SIZES.map((s) => ({ value: s, label: fmtBytes(s, lang).replace(',0', '').replace('.0', '') }))} />
        </div>
        <div className="filter-row">
          <span className="filter-label">{t('fg.group')}</span>
          <Segmented
            label={t('fg.group')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'smart', label: t('fg.smart') },
              { value: 'files', label: t('fg.files') },
            ]}
          />
          <label className="switch-label">
            <Switch checked={includeSystem} onChange={setIncludeSystem} label={t('fg.system')} />
            {t('fg.system')}
          </label>
        </div>
        <CatChips value={cats} onChange={setCats} />
        <p className="explain">
          <Info size={14} aria-hidden />
          {tracking === 'off' ? t('fg.explainOff') : t('fg.explainOn')}
        </p>
      </div>
      <NodeList items={res?.items ?? []} loading={loading} empty={t('fg.empty')} head={res ? t('fg.summary', { count: fmtCount(res.total, lang), size: fmtBytes(res.bytes, lang) }) : ''} />
    </div>
  );
}

export function SearchResults() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const metric = useStore((s) => s.prefs.metric);
  const version = useStore((s) => s.version);
  const rootId = useStore((s) => s.summary?.rootId ?? -1);
  const query = useDebounced(useStore((s) => s.search), 200);
  const [res, setRes] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (rootId < 0 || !query.trim()) {
      setRes(null);
      return;
    }
    let alive = true;
    setLoading(true);
    engine<ListResult>('search', { scopeId: rootId, query, limit: 1000, metric }).then((r) => {
      if (!alive) return;
      setRes(r);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [rootId, query, metric, version]);
  return (
    <div className="tab-pane">
      <p className="explain">
        <Info size={14} aria-hidden />
        {t('search.hint')}
      </p>
      <NodeList items={res?.items ?? []} loading={loading} empty={t('list.none')} head={res ? t('search.summary', { count: fmtCount(res.total, lang), size: fmtBytes(res.bytes, lang) }) : ''} />
    </div>
  );
}

export function FileTypes() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const metric = useStore((s) => s.prefs.metric);
  const version = useStore((s) => s.version);
  const rootId = useStore((s) => s.summary?.rootId ?? -1);
  const [rows, setRows] = useState<FileTypeRow[] | null>(null);
  useEffect(() => {
    if (rootId < 0) return;
    let alive = true;
    engine<FileTypeRow[]>('fileTypes', { scopeId: rootId, metric }).then((r) => alive && setRows(r));
    return () => {
      alive = false;
    };
  }, [rootId, metric, version]);
  const val = (r: FileTypeRow) => (metric === 'size' ? r.size : r.alloc);
  const total = useMemo(() => (rows ?? []).reduce((a, r) => a + val(r), 0), [rows, metric]); // eslint-disable-line react-hooks/exhaustive-deps
  const max = rows?.length ? val(rows[0]) : 1;
  return (
    <div className="tab-pane">
      <div className="table types">
        <div className="thead">
          <span className="th c-name">{t('types.ext')}</span>
          <span className="th c-size">{t('col.size')}</span>
          <span className="th c-share">{t('col.share')}</span>
          <span className="th c-files">{t('types.count')}</span>
          <span className="th c-last">{t('types.avg')}</span>
        </div>
        <div className="tbody" role="list">
          {!rows && (
            <div className="empty">
              <Spinner />
            </div>
          )}
          {rows?.map((r) => (
            <button
              key={r.ext}
              type="button"
              role="listitem"
              className="tr tr-static"
              title={t('types.show')}
              onClick={() => setState({ tab: 'files', fileQuery: r.ext ? `*.${r.ext}` : '', catFilter: null })}
            >
              <span className="c-name">
                <CatIcon cat={r.cat} size={16} />
                <span className="name">{r.ext ? `.${r.ext}` : t('types.none')}</span>
                <span className="muted small">{t(`cat.${CATEGORIES[r.cat]}`)}</span>
              </span>
              <span className="c-size num">{fmtBytes(val(r), lang)}</span>
              <span className="c-share">
                <ShareBar value={val(r) / max} cat={r.cat} />
                <span className="num muted">{fmtPercent(total ? val(r) / total : 0, lang)}</span>
              </span>
              <span className="c-files num muted">{fmtCount(r.count, lang)}</span>
              <span className="c-last num muted">{fmtBytes(r.count ? val(r) / r.count : 0, lang)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
