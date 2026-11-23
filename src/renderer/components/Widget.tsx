// The storage widget from the design reference: headline, status line,
// dot-matrix bar, category legend and the "what you can clear" footer.
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, CircleCheck, RefreshCw, Square } from 'lucide-react';
import { CATEGORIES, Cat, type Insight, type InsightKind } from '../../shared/types';
import { useT } from '../lib/i18n';
import { bytesParts, fmtBytes, fmtCompact, fmtDuration } from '../lib/format';
import { cancelScan, openInsight, setPrefs, setState, startScan, useStore } from '../state';
import { Button, CatIcon, IconButton, Spinner } from './ui';
import { DotBar } from './DotBar';

export const INSIGHT_CAT: Record<InsightKind, number> = {
  trash: Cat.trash,
  caches: Cat.caches,
  temp: Cat.caches,
  devJunk: Cat.developer,
  installers: Cat.archives,
  oldDownloads: Cat.other,
  largeOld: Cat.videos,
  windowsOld: Cat.system,
  hibernation: Cat.system,
};

export function Widget() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const metric = useStore((s) => s.prefs.metric);
  const collapsed = useStore((s) => s.prefs.collapsed);
  const summary = useStore((s) => s.summary);
  const progress = useStore((s) => s.progress);
  const scanning = useStore((s) => s.scanning);
  const scanRoot = useStore((s) => s.scanRoot);
  const mac = useStore((s) => s.startup?.platform === 'darwin');
  const drives = useStore((s) => s.drives);
  const insights = useStore((s) => s.insights);
  const freed = useStore((s) => s.freed);
  const dark = useStore((s) => s.dark);
  const reducedMotion = useStore((s) => s.reducedMotion);
  const [hover, setHover] = useState<number | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    if (!freed) return;
    const id = setTimeout(() => force((x) => x + 1), 20000);
    return () => clearTimeout(id);
  }, [freed]);

  const isVolume = summary?.isVolume ?? (mac
    ? scanRoot === '/' || !!drives?.some((drive) => drive.root === scanRoot)
    : /^[A-Za-z]:\\?$/.test(scanRoot ?? ''));
  const total = summary?.total ?? progress?.total ?? 0;
  const free = summary?.free ?? progress?.free ?? 0;

  const { values, neutral, capacity, headline, unaccounted } = useMemo(() => {
    const zero = CATEGORIES.map(() => 0);
    if (scanning || !summary) {
      const cats = progress?.cats?.length ? progress.cats : zero;
      const neutral = progress && !progress.cats.length ? progress.bytes : 0;
      const scanned = progress?.bytes ?? 0;
      return { values: cats, neutral, capacity: isVolume ? Math.max(total, 1) : Math.max(scanned * 1.15, 1), headline: scanned, unaccounted: 0 };
    }
    const vals = summary.cats.map((c) => (metric === 'size' && !(mac && summary.isVolume) ? c.size : c.alloc));
    const sum = vals.reduce((a, b) => a + b, 0);
    if (summary.isVolume && summary.total) {
      const used = summary.total - summary.free;
      const extra = Math.max(0, used - sum);
      if (mac) return { values: vals, neutral: extra, capacity: Math.max(sum, summary.total), headline: used, unaccounted: extra };
      vals[Cat.system] += extra;
      return { values: vals, neutral: 0, capacity: summary.total, headline: used, unaccounted: extra };
    }
    return { values: vals, neutral: 0, capacity: Math.max(sum, 1), headline: sum, unaccounted: 0 };
  }, [scanning, summary, progress, metric, isVolume, total, mac]);

  const [num, unit] = bytesParts(headline, lang);
  const root = summary?.root ?? scanRoot ?? '';
  const folderName = mac ? root.replace(/\/+$/, '').split('/').pop() || root : root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const top = insights?.[0];
  const recentFreed = freed && Date.now() - freed.at < 20000 ? freed : null;

  let status: React.ReactNode;
  if (hover !== null && hover >= 0) {
    status = (
      <>
        <CatIcon cat={hover} size={15} />
        <b>{t(`cat.${CATEGORIES[hover]}`)}</b>
        <span className="muted">{fmtBytes(values[hover], lang)}</span>
        <span className="muted ellipsis">
          {t(`catd.${CATEGORIES[hover]}`)}
          {!mac && hover === Cat.system && unaccounted > 1024 ** 3 ? ` (${t('w.unaccounted', { size: fmtBytes(unaccounted, lang) })})` : ''}
        </span>
      </>
    );
  } else if (mac && hover === -2 && !scanning) {
    status = <span className="muted ellipsis">{t('w.unaccounted', { size: fmtBytes(unaccounted, lang) })}</span>;
  } else if (scanning) {
    const label = progress?.phase === 'mft' ? t('w.readingMft') : progress?.phase === 'build' || progress?.phase === 'analyze' ? t('w.building') : t('w.scanning');
    status = (
      <>
        <b>{label}</b>
        <span className="mono muted ellipsis">{progress?.path ?? scanRoot}</span>
      </>
    );
  } else if (recentFreed) {
    status = (
      <>
        <CircleCheck size={15} className="ok-icon" aria-hidden />
        <b>{t('w.freed', { size: fmtBytes(recentFreed.bytes, lang) })}</b>
        {isVolume && <span className="muted">{t('w.available', { size: fmtBytes(free, lang) })}</span>}
      </>
    );
  } else if (summary) {
    status = (
      <span className="muted ellipsis">
        {t('w.done', { files: fmtCompact(summary.files, lang), time: fmtDuration(summary.ms, lang) })} · {t(summary.mode === 'mft' ? 'w.mode.mft' : 'w.mode.walk')}
        {isVolume ? ` · ${t('w.available', { size: fmtBytes(free, lang) })}` : ''}
      </span>
    );
  }

  const catLabel = CATEGORIES.map((c, i) => `${t(`cat.${c}`)} ${fmtBytes(values[i], lang)}`).join(', ');

  return (
    <section className="card widget" aria-label={t('w.bar')}>
      <header className="widget-head">
        <h1 className="headline">
          <span className="headline-num">{num}</span>
          <span className="headline-unit">{unit}</span>
          <span className="headline-sub">{isVolume ? t('w.used', { total: fmtBytes(total, lang) }) : t('w.folder', { name: folderName })}</span>
        </h1>
        <div className="widget-tools">
          {scanning ? (
            <Button kind="ghost" small icon={Square} onClick={cancelScan}>
              {t('w.stop')}
            </Button>
          ) : (
            <Button kind="ghost" small icon={RefreshCw} onClick={() => summary && startScan(summary.root)} disabled={!summary}>
              {t('w.rescan')}
            </Button>
          )}
          <IconButton icon={collapsed ? ChevronDown : ChevronUp} label={collapsed ? t('w.expand') : t('w.collapse')} onClick={() => setPrefs({ collapsed: !collapsed })} />
        </div>
      </header>
      <div className="status-line" aria-live="off">
        {status}
      </div>
      <DotBar
        values={values}
        neutral={neutral}
        capacity={capacity}
        active={hover}
        scanning={scanning}
        dark={dark}
        reducedMotion={reducedMotion}
        height={collapsed ? 44 : 96}
        label={`${t('w.bar')}: ${catLabel}`}
        onHover={setHover}
        onSelect={(c) => setState({ tab: 'files', catFilter: c })}
      />
      {!collapsed && (
        <div className="legend" role="group" aria-label={t('w.bar')}>
          {CATEGORIES.map((c, i) => (
            <button
              key={c}
              type="button"
              className={`legend-item${hover === i ? ' is-hover' : ''}${values[i] <= 0 ? ' is-empty' : ''}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              onClick={() => setState({ tab: 'files', catFilter: i })}
            >
              <CatIcon cat={i} size={16} dim={values[i] <= 0} />
              <span className="legend-name">{t(`cat.${c}`)}</span>
              <span className="legend-size">{fmtBytes(values[i], lang)}</span>
            </button>
          ))}
        </div>
      )}
      {!collapsed && (
        <footer className="widget-foot">
          {scanning || insights === null ? (
            <span className="muted foot-text">
              <Spinner size={14} /> {t('w.looking')}
            </span>
          ) : top ? (
            <>
              <span className="foot-text">
                <CatIcon cat={INSIGHT_CAT[top.kind]} size={16} />
                <span className="clamp">{t(`ins.${top.kind}`, { size: fmtBytes(top.bytes, lang) })}</span>
              </span>
              <Button small onClick={() => openInsight(top)}>
                {t(`insA.${top.kind}`)}
              </Button>
            </>
          ) : (
            <span className="foot-text">
              <CircleCheck size={16} className="ok-icon" aria-hidden />
              {t('w.nothing')}
            </span>
          )}
        </footer>
      )}
    </section>
  );
}

export function InsightList() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const insights = useStore((s) => s.insights);
  const scanning = useStore((s) => s.scanning);
  if (scanning || !insights || insights.length < 2) return null;
  const rest: Insight[] = insights.slice(1);
  return (
    <section className="card insights" aria-labelledby="insights-title">
      <h2 id="insights-title" className="card-title">
        {t('ins.more')}
      </h2>
      <ul className="insight-rows">
        {rest.map((ins) => (
          <li key={ins.kind} className="insight-row">
            <CatIcon cat={INSIGHT_CAT[ins.kind]} size={18} />
            <div className="insight-text">
              <div className="insight-title">{t(`insT.${ins.kind}`)}</div>
              <div className="muted small ellipsis">{t(`ins.${ins.kind}`, { size: fmtBytes(ins.bytes, lang) })}</div>
            </div>
            <span className="insight-size">{fmtBytes(ins.bytes, lang)}</span>
            <Button small onClick={() => openInsight(ins)}>
              {t(`insA.${ins.kind}`)}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
