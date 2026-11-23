import { useEffect } from 'react';
import { Disc, FolderOpen, Globe, HardDrive, RefreshCw, ShieldCheck, Usb, Zap } from 'lucide-react';
import type { DriveInfo } from '../../shared/types';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { fmtBytes } from '../lib/format';
import { elevate, refreshDrives, startScan, useStore } from '../state';
import { Button, IconButton, Spinner } from './ui';
import { ThemeToggle } from './ThemeToggle';

const ICONS = { fixed: HardDrive, removable: Usb, network: Globe, cdrom: Disc, unknown: HardDrive };

export function Home() {
  const t = useT();
  const drives = useStore((s) => s.drives);
  const elevated = useStore((s) => !!s.startup?.elevated);
  const mac = useStore((s) => s.startup?.platform === 'darwin');
  const sorted = [...(drives ?? [])].sort((a, b) => Number(b.system) - Number(a.system) || (a.letter ?? a.label).localeCompare(b.letter ?? b.label));

  useEffect(() => {
    if (!mac) return;
    const onFocus = () => void refreshDrives();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [mac]);
  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-head">
          <div>
            <h1 className="home-title">{t('home.title')}</h1>
            <p className="home-sub">{t('home.subtitle')}</p>
          </div>
          {mac ? (
            <div className="home-controls">
              <IconButton icon={RefreshCw} label={t('mac.refreshDrives')} onClick={() => void refreshDrives()} />
              <ThemeToggle />
            </div>
          ) : <ThemeToggle />}
        </div>
        <div className="drive-grid">
          {!drives && (
            <div className="drive-card is-loading">
              <Spinner /> {t('home.loading')}
            </div>
          )}
          {sorted.map((d) => (
            <DriveCard key={d.root} d={d} />
          ))}
          <div className="drive-card folder-card">
            <FolderOpen size={22} aria-hidden className="muted-icon" />
            <div>
              <div className="drive-name">{t('home.folder.title')}</div>
              <div className="muted small">{t('home.folder.body')}</div>
            </div>
            <Button
              small
              onClick={async () => {
                const p = await api.chooseFolder();
                if (p) startScan(p);
              }}
            >
              {t('home.folder.button')}
            </Button>
          </div>
        </div>
        {!mac && (
          <div className={`turbo${elevated ? ' is-on' : ''}`}>
            {elevated ? <ShieldCheck size={18} aria-hidden /> : <Zap size={18} aria-hidden />}
            <div>
              <div className="turbo-title">{elevated ? t('turbo.active') : t('turbo.title')}</div>
              {!elevated && <div className="muted small">{t('turbo.body')}</div>}
            </div>
            {!elevated && (
              <Button small icon={Zap} onClick={() => void elevate()}>
                {t('turbo.enable')}
              </Button>
            )}
          </div>
        )}
        <p className="muted small privacy">{t('home.privacy')}</p>
      </div>
    </div>
  );
}

function DriveCard({ d }: { d: DriveInfo }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const Icon = ICONS[d.kind] ?? HardDrive;
  const used = d.total - d.free;
  const share = d.total ? used / d.total : 0;
  const label = d.label || t(`drive.${d.kind}`);
  const name = d.letter ? `${label} (${d.letter}:)` : label;
  return (
    <button type="button" className="drive-card" onClick={() => startScan(d.root)} aria-label={`${t('home.scan')} ${name}`}>
      <div className="drive-top">
        <Icon size={20} aria-hidden className="muted-icon" />
        <span className="drive-name">{name}</span>
        {d.system && <span className="tag">{t('home.system')}</span>}
        {d.fs && <span className="tag tag-dim">{d.fs}</span>}
      </div>
      <div className="drive-used">
        <span className="drive-num">{fmtBytes(used, lang)}</span>
        <span className="muted">{t('w.used', { total: fmtBytes(d.total, lang) })}</span>
      </div>
      <div className={`mini-bar${share > 0.9 ? ' is-full' : ''}`} aria-hidden>
        <span style={{ width: `${Math.max(2, share * 100)}%` }} />
      </div>
      <div className="drive-foot">
        <span className={`small ${share > 0.9 ? 'low-space' : 'muted'}`}>{t('home.free', { free: fmtBytes(d.free, lang), total: fmtBytes(d.total, lang) })}</span>
        <span className="drive-go">{t('home.scan')} →</span>
      </div>
    </button>
  );
}
