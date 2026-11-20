import { useEffect, useRef, useState } from 'react';
import { CircleCheck, CircleX, House, Info, Search, SlidersHorizontal, X, Zap } from 'lucide-react';
import { api } from './lib/api';
import { LOGO_DOTS } from './lib/logo';
import { useT, type TKey } from './lib/i18n';
import { fmtBytes, fmtCompact, fmtCount, fmtDuration } from './lib/format';
import { elevate, getState, goHome, init, setState, startScan, t as tt, useStore, type Tab } from './state';
import { Home } from './components/Home';
import { InsightList, Widget } from './components/Widget';
import { Explorer } from './components/Explorer';
import { FileTypes, Forgotten, LargestFiles, SearchResults } from './components/Lists';
import { Dialogs } from './components/Dialogs';
import { Button, IconButton } from './components/ui';

export function App() {
  const ready = useStore((s) => s.ready);
  const view = useStore((s) => s.view);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    void init();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.key === '/' && !(e.target instanceof HTMLInputElement))) {
        const el = document.getElementById('global-search') as HTMLInputElement | null;
        if (el) {
          e.preventDefault();
          el.focus();
          el.select();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      className={`app${drag ? ' is-drop' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files[0];
        const p = f ? api.pathForFile(f) : '';
        if (p) startScan(p);
      }}
    >
      <TitleBar />
      <main className="main">{!ready ? null : view === 'home' ? <Home /> : <Workspace />}</main>
      <Dialogs />
      <Toasts />
      <Announcer />
    </div>
  );
}

function TitleBar() {
  const t = useT();
  const view = useStore((s) => s.view);
  const summary = useStore((s) => s.summary);
  const scanRoot = useStore((s) => s.scanRoot);
  const search = useStore((s) => s.search);
  const prevTab = useRef<Tab>('folders');
  const root = summary?.root ?? scanRoot;

  const onSearch = (v: string) => {
    const st = getState();
    if (v && st.tab !== 'search') prevTab.current = st.tab;
    setState({ search: v, tab: v ? 'search' : prevTab.current });
  };

  return (
    <header className="titlebar">
      <div className="brand">
        <Logo />
        <span>{t('app.name')}</span>
      </div>
      {view === 'workspace' && (
        <>
          <button type="button" className="tb-btn" onClick={goHome}>
            <House size={15} aria-hidden />
            {t('app.home')}
          </button>
          {root && <span className="tb-root mono">{root}</span>}
          <label className={`tb-search${summary ? '' : ' is-disabled'}`}>
            <Search size={15} aria-hidden />
            <input
              id="global-search"
              value={search}
              disabled={!summary}
              placeholder={t('app.search')}
              aria-label={t('app.search')}
              onChange={(e) => onSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onSearch('');
              }}
            />
            {search ? (
              <button type="button" className="tb-clear" aria-label={t('search.close')} onClick={() => onSearch('')}>
                <X size={14} />
              </button>
            ) : (
              <kbd>Ctrl F</kbd>
            )}
          </label>
        </>
      )}
      <span className="tb-spacer" />
      <IconButton icon={SlidersHorizontal} label={t('app.settings')} onClick={() => setState({ dialog: { type: 'settings' } })} />
    </header>
  );
}

function Logo() {
  // Dots are drawn ~1.45x larger than in the icon so the mark stays legible at 20 px.
  return (
    <svg width="20" height="20" viewBox="0 0 128 128" aria-hidden>
      {LOGO_DOTS.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={d.r * 1.45} fill={d.color ?? 'currentColor'} opacity={d.color ? 1 : 0.22} />
      ))}
      <circle cx="64" cy="64" r="7" fill="currentColor" />
    </svg>
  );
}

function Workspace() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const scanning = useStore((s) => s.scanning);
  const summary = useStore((s) => s.summary);
  const elevated = useStore((s) => !!s.startup?.elevated);
  const turbo = useStore((s) => s.prefs.turbo);
  return (
    <div className="workspace">
      <aside className="col-left">
        <Widget />
        <InsightList />
        {summary && !scanning && summary.errors > 0 && !elevated && (
          <p className="note">
            <Info size={14} aria-hidden />
            {t('w.unreadable', { count: fmtCount(summary.errors, lang) })}
          </p>
        )}
        {summary && !scanning && summary.isVolume && summary.mode === 'walk' && !elevated && turbo && (
          <div className="turbo compact">
            <Zap size={16} aria-hidden />
            <div className="small">{t('turbo.body')}</div>
            <Button small onClick={() => void elevate()}>
              {t('turbo.enable')}
            </Button>
          </div>
        )}
      </aside>
      <section className="col-right">{scanning || !summary ? <ScanPanel /> : <Tabs />}</section>
    </div>
  );
}

function ScanPanel() {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const progress = useStore((s) => s.progress);
  const start = useStore((s) => s.scanStart);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.max(1, now - start);
  const files = progress?.files ?? 0;
  const stats: [TKey, string][] = [
    ['scan.files', fmtCount(files, lang)],
    ['scan.dirs', fmtCount(progress?.dirs ?? 0, lang)],
    ['scan.speed', fmtCompact((files / elapsed) * 1000, lang)],
    ['scan.elapsed', fmtDuration(elapsed, lang)],
  ];
  return (
    <div className="card scan-panel" aria-busy="true">
      <div className="scan-stats">
        {stats.map(([k, v]) => (
          <div key={k} className="stat">
            <div className="stat-num num">{v}</div>
            <div className="muted small">{t(k)}</div>
          </div>
        ))}
      </div>
      <p className="muted small">{progress?.mode === 'mft' ? t('scan.mode.mft') : t('scan.mode.walk')}</p>
      <div className="scan-path mono ellipsis">{progress?.path ?? ''}</div>
      {progress && progress.bytes > 0 && <div className="muted small">{fmtBytes(progress.bytes, lang)}</div>}
    </div>
  );
}

const TABS: Tab[] = ['folders', 'files', 'forgotten', 'types'];

function Tabs() {
  const t = useT();
  const tab = useStore((s) => s.tab);
  const search = useStore((s) => s.search);
  const summary = useStore((s) => s.summary);
  const tabs: Tab[] = search ? [...TABS, 'search'] : TABS;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = tabs.indexOf(tab);
    const n = (i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    setState({ tab: tabs[n] });
    refs.current[n]?.focus();
  };
  return (
    <div className="tabs-wrap">
      <div className="tabs" role="tablist" aria-label={t('a11y.views')} onKeyDown={onKey}>
        {tabs.map((k, i) => (
          <button
            key={k}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${k}`}
            aria-selected={tab === k}
            aria-controls={`panel-${k}`}
            tabIndex={tab === k ? 0 : -1}
            className={`tab${tab === k ? ' is-on' : ''}`}
            onClick={() => setState({ tab: k })}
          >
            {t(`tab.${k}`)}
          </button>
        ))}
        {summary?.turboNote && summary.turboNote !== 'not-volume' && <span className="tab-note muted small">{t(`note.${summary.turboNote}`)}</span>}
      </div>
      <div className="tab-panel card" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'folders' && <Explorer />}
        {tab === 'files' && <LargestFiles />}
        {tab === 'forgotten' && <Forgotten />}
        {tab === 'types' && <FileTypes />}
        {tab === 'search' && <SearchResults />}
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className={`toast toast-${x.kind}`}>
          {x.kind === 'success' ? <CircleCheck size={16} aria-hidden /> : x.kind === 'error' ? <CircleX size={16} aria-hidden /> : <Info size={16} aria-hidden />}
          <span>{x.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Screen-reader announcements for scan start/finish. */
function Announcer() {
  const summary = useStore((s) => s.summary);
  const scanning = useStore((s) => s.scanning);
  const lang = useStore((s) => s.lang);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (scanning) setMsg(tt('w.scanning'));
    else if (summary) setMsg(`${tt('w.done', { files: fmtCount(summary.files, lang), time: fmtDuration(summary.ms, lang) })}. ${fmtBytes(summary.alloc, lang)}`);
  }, [scanning, summary, lang]);
  return (
    <div className="sr-only" aria-live="polite">
      {msg}
    </div>
  );
}
