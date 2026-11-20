// Folder explorer: breadcrumbs, a virtualised tree table sorted by size and the
// treemap. Selection is shared between the table and the map.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ChevronRight, Columns2, LayoutGrid, List } from 'lucide-react';
import type { ChildrenPage, NodeDetail, NodeInfo, SortKey } from '../../shared/types';
import { NF } from '../../shared/types';
import { engine } from '../lib/api';
import { useT } from '../lib/i18n';
import { fmtAgo, fmtBytes, fmtCount, fmtPercent } from '../lib/format';
import { focusNode, setPrefs, setState, useStore } from '../state';
import { ContextMenu, IconButton, NodeIcon, Segmented, ShareBar, Spinner, useElementSize, type MenuItem } from './ui';
import { askRemove, nodeMenu, openNode } from './actions';
import { Treemap } from './Treemap';

const ROW = 32;
const PAGE = 200;

type Row =
  | { kind: 'node'; node: NodeInfo; depth: number; parentValue: number; parentId: number }
  | { kind: 'loading'; depth: number; key: string }
  | { kind: 'more'; depth: number; parentId: number; count: number; rest: number; key: string };

export function Explorer() {
  const t = useT();
  const focusId = useStore((s) => s.focusId);
  const version = useStore((s) => s.version);
  const view = useStore((s) => s.prefs.view);
  const [detail, setDetail] = useState<NodeDetail | null>(null);

  useEffect(() => {
    if (focusId < 0) return;
    let alive = true;
    engine<NodeDetail | null>('detail', { id: focusId }).then((d) => alive && setDetail(d));
    return () => {
      alive = false;
    };
  }, [focusId, version]);

  const crumbs = detail?.crumbs ?? [];
  const up = crumbs.length > 1 ? crumbs[crumbs.length - 2].id : null;

  return (
    <div className="explorer">
      <div className="explorer-bar">
        <IconButton icon={ArrowUp} label={t('ex.up')} onClick={() => up !== null && focusNode(up, focusId)} />
        <nav className="crumbs" aria-label={t('a11y.crumbs')}>
          {crumbs.map((c, i) => (
            <span key={c.id} className="crumb-wrap">
              {i > 0 && <ChevronRight size={14} className="crumb-sep" aria-hidden />}
              <button type="button" className={`crumb${i === crumbs.length - 1 ? ' is-current' : ''}`} onClick={() => focusNode(c.id)} aria-current={i === crumbs.length - 1 ? 'page' : undefined}>
                {c.name.replace(/\\$/, '') || c.name}
              </button>
            </span>
          ))}
        </nav>
        <Segmented
          label={t('a11y.view')}
          value={view}
          onChange={(v) => setPrefs({ view: v })}
          options={[
            { value: 'list', label: <List size={15} aria-label={t('ex.view.list')} />, title: t('ex.view.list') },
            { value: 'split', label: <Columns2 size={15} aria-label={t('ex.view.split')} />, title: t('ex.view.split') },
            { value: 'map', label: <LayoutGrid size={15} aria-label={t('ex.view.map')} />, title: t('ex.view.map') },
          ]}
        />
      </div>
      <div className={`explorer-body view-${view}`}>
        {view !== 'map' && <TreeTable focus={detail} />}
        {view !== 'list' && <Treemap focusId={focusId} />}
      </div>
    </div>
  );
}

function TreeTable({ focus }: { focus: NodeDetail | null }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const metric = useStore((s) => s.prefs.metric);
  const version = useStore((s) => s.version);
  const focusId = useStore((s) => s.focusId);
  const selectedId = useStore((s) => s.selectedId);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'value', desc: true });
  const [pages, setPages] = useState<Map<number, ChildrenPage>>(new Map());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [limits, setLimits] = useState<Map<number, number>>(new Map());
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [bodyRef, size] = useElementSize<HTMLDivElement>();
  const inflight = useRef(new Set<string>());

  // Reset caches whenever the tree, metric, sort or focus changes.
  useEffect(() => {
    setPages(new Map());
    inflight.current.clear();
  }, [version, metric, sort]);
  useEffect(() => {
    setExpanded(new Set());
    setLimits(new Map());
    setScrollTop(0);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [focusId, bodyRef]);

  const load = useCallback(
    (id: number, limit: number) => {
      const key = `${id}:${limit}`;
      if (inflight.current.has(key)) return;
      inflight.current.add(key);
      engine<ChildrenPage>('children', { id, sort: sort.key, desc: sort.desc, metric, offset: 0, limit }).then((page) => {
        setPages((m) => new Map(m).set(id, page));
      });
    },
    [sort, metric],
  );

  const value = (n: NodeInfo) => (metric === 'size' ? n.size : n.alloc);

  const rows = useMemo(() => {
    const out: Row[] = [];
    if (focusId < 0) return out;
    const walk = (id: number, depth: number, parentValue: number) => {
      const page = pages.get(id);
      const limit = limits.get(id) ?? PAGE;
      if (!page || (page.items.length < limit && page.items.length < page.total)) {
        out.push({ kind: 'loading', depth, key: `l${id}` });
        load(id, limit);
        return;
      }
      for (const node of page.items) {
        out.push({ kind: 'node', node, depth, parentValue, parentId: id });
        if (node.dir && expanded.has(node.id)) walk(node.id, depth + 1, value(node));
      }
      if (page.total > page.items.length) out.push({ kind: 'more', depth, parentId: id, count: page.total - page.items.length, rest: page.restValue, key: `m${id}` });
    };
    walk(focusId, 0, focus ? value(focus) : 0);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, expanded, limits, focusId, focus, load, metric]);

  const nodeRows = rows.filter((r): r is Extract<Row, { kind: 'node' }> => r.kind === 'node');
  const selIndex = rows.findIndex((r) => r.kind === 'node' && r.node.id === selectedId);

  // Reveal a node selected elsewhere (e.g. in the treemap) by expanding its ancestors.
  useEffect(() => {
    if (selectedId === null || selIndex >= 0) return;
    let alive = true;
    engine<NodeDetail | null>('detail', { id: selectedId }).then((d) => {
      if (!alive || !d) return;
      const ids = d.crumbs.map((c) => c.id);
      const at = ids.indexOf(focusId);
      if (at < 0) return;
      setExpanded((s) => {
        const n = new Set(s);
        ids.slice(at + 1, -1).forEach((id) => n.add(id));
        return n;
      });
    });
    return () => {
      alive = false;
    };
  }, [selectedId, selIndex, focusId]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || selIndex < 0) return;
    const y = selIndex * ROW;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ROW > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW - el.clientHeight;
  }, [selIndex, bodyRef]);

  const toggle = (id: number, open?: boolean) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (open ?? !n.has(id)) n.add(id);
      else n.delete(id);
      return n;
    });

  const select = (id: number | null) => setState({ selectedId: id });

  const onKey = (e: React.KeyboardEvent) => {
    const cur = selIndex >= 0 ? (rows[selIndex] as Extract<Row, { kind: 'node' }>) : null;
    const nodeIdx = cur ? nodeRows.indexOf(cur) : -1;
    const go = (i: number) => {
      const r = nodeRows[Math.max(0, Math.min(nodeRows.length - 1, i))];
      if (r) select(r.node.id);
    };
    switch (e.key) {
      case 'ArrowDown':
        go(nodeIdx + 1);
        break;
      case 'ArrowUp':
        go(nodeIdx < 0 ? 0 : nodeIdx - 1);
        break;
      case 'Home':
        go(0);
        break;
      case 'End':
        go(nodeRows.length - 1);
        break;
      case 'PageDown':
        go(nodeIdx + Math.floor(size.h / ROW));
        break;
      case 'PageUp':
        go(nodeIdx - Math.floor(size.h / ROW));
        break;
      case 'ArrowRight':
        if (cur?.node.dir) {
          if (!expanded.has(cur.node.id)) toggle(cur.node.id, true);
          else go(nodeIdx + 1);
        }
        break;
      case 'ArrowLeft':
        if (cur?.node.dir && expanded.has(cur.node.id)) toggle(cur.node.id, false);
        else if (cur && cur.parentId !== focusId) select(cur.parentId);
        break;
      case 'Enter':
        if (cur?.node.dir) focusNode(cur.node.id);
        else if (cur) void openNode(cur.node);
        break;
      case 'Backspace':
        if (focus && focus.crumbs.length > 1) focusNode(focus.crumbs[focus.crumbs.length - 2].id, focusId);
        break;
      case 'Delete':
        if (cur) askRemove([cur.node], e.shiftKey ? 'permanent' : 'trash');
        break;
      case 'ContextMenu':
        if (cur) setMenu({ x: 200, y: 200 + selIndex * ROW - (bodyRef.current?.scrollTop ?? 0), items: nodeMenu(cur.node) });
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW) - 6);
  const last = Math.min(rows.length, Math.ceil((scrollTop + size.h) / ROW) + 6);

  const header = (key: SortKey, label: string, cls: string) => (
    <button
      type="button"
      className={`th ${cls}${sort.key === key ? ' is-sorted' : ''}`}
      aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}
      onClick={() => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'name' && key !== 'last' }))}
    >
      {label}
      {sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
    </button>
  );

  return (
    <div className="table">
      <div className="thead" role="presentation">
        {header('name', t('col.name'), 'c-name')}
        {header('value', t('col.size'), 'c-size')}
        <span className="th c-share">{t('col.share')}</span>
        {header('files', t('col.files'), 'c-files')}
        {header('last', t('col.last'), 'c-last')}
      </div>
      <div
        ref={bodyRef}
        className="tbody"
        role="treegrid"
        aria-label={focus?.path ?? ''}
        aria-activedescendant={selectedId !== null && selIndex >= 0 ? `row-${selectedId}` : undefined}
        tabIndex={0}
        onKeyDown={onKey}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div style={{ height: rows.length * ROW, position: 'relative' }}>
          {rows.slice(first, last).map((r, k) => {
            const i = first + k;
            const style = { transform: `translateY(${i * ROW}px)` };
            if (r.kind === 'loading')
              return (
                <div key={r.key} className="tr tr-meta" style={style}>
                  <span className="c-name" style={{ paddingLeft: 12 + r.depth * 18 }}>
                    <Spinner size={14} /> {t('ex.loading')}
                  </span>
                </div>
              );
            if (r.kind === 'more')
              return (
                <div key={r.key} className="tr tr-meta" style={style}>
                  <button
                    type="button"
                    className="c-name link-btn"
                    style={{ paddingLeft: 30 + r.depth * 18 }}
                    onClick={() => setLimits((m) => new Map(m).set(r.parentId, (m.get(r.parentId) ?? PAGE) + 1000))}
                  >
                    {t('ex.more', { count: fmtCount(r.count, lang), size: fmtBytes(r.rest, lang) })}
                  </button>
                </div>
              );
            const n = r.node;
            const v = value(n);
            const share = r.parentValue > 0 ? v / r.parentValue : 0;
            const open = expanded.has(n.id);
            const denied = (n.flags & NF.ERR) !== 0;
            return (
              <div
                key={n.id}
                id={`row-${n.id}`}
                role="row"
                aria-level={r.depth + 1}
                aria-expanded={n.dir && n.hasKids ? open : undefined}
                aria-selected={selectedId === n.id}
                className={`tr${selectedId === n.id ? ' is-selected' : ''}`}
                style={style}
                onClick={() => select(n.id)}
                onDoubleClick={() => (n.dir ? focusNode(n.id) : void openNode(n))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  select(n.id);
                  setMenu({ x: e.clientX, y: e.clientY, items: nodeMenu(n) });
                }}
              >
                <span className="c-name" role="gridcell" style={{ paddingLeft: 8 + r.depth * 18 }}>
                  {n.dir && n.hasKids ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      className={`chev${open ? ' is-open' : ''}`}
                      aria-label={open ? t('w.collapse') : t('w.expand')}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(n.id);
                      }}
                    >
                      <ChevronRight size={14} />
                    </button>
                  ) : (
                    <span className="chev-space" />
                  )}
                  <NodeIcon node={n} size={16} />
                  <span className="name ellipsis" title={n.name}>
                    {n.name}
                  </span>
                  {denied && <span className="tag">{t('ex.denied')}</span>}
                  {(n.flags & NF.LINK) !== 0 && <span className="tag">{t('ex.link')}</span>}
                </span>
                <span className="c-size num" role="gridcell">
                  {fmtBytes(v, lang)}
                </span>
                <span className="c-share" role="gridcell">
                  <ShareBar value={share} cat={n.cat} />
                  <span className="num muted">{fmtPercent(share, lang)}</span>
                </span>
                <span className="c-files num muted" role="gridcell">
                  {n.dir ? fmtCount(n.files, lang) : ''}
                </span>
                <span className="c-last muted" role="gridcell" title={n.last ? new Date(n.last * 1000).toLocaleString(lang) : ''}>
                  {fmtAgo(n.last, lang)}
                </span>
              </div>
            );
          })}
        </div>
        {rows.length === 0 && focusId >= 0 && <div className="empty">{t('ex.empty')}</div>}
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
