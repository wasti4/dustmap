import { useEffect, useMemo, useState } from 'react';
import { Info, ShieldCheck, TriangleExclamationPoint, Zap } from 'lucide-react';
import { Cat, type NodeInfo } from '../../shared/types';
import { api, engine } from '../lib/api';
import { detectLang, LANG_NAMES, useT, type Lang, type LangPref } from '../lib/i18n';
import { fmtBytes, fmtCount, shortPath } from '../lib/format';
import { elevate, removeItems, runInsight, setPrefs, setState, useStore, type Dialog } from '../state';
import { Button, CatIcon, Checkbox, Modal, NodeIcon, Segmented, Spinner, Switch } from './ui';
import { INSIGHT_CAT } from './Widget';

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const close = () => setState({ dialog: null });
  if (!dialog) return null;
  if (dialog.type === 'remove') return <RemoveDialog d={dialog} onClose={close} />;
  if (dialog.type === 'insight') return <InsightDialog d={dialog} onClose={close} />;
  return <SettingsDialog onClose={close} />;
}

const RISKY = new Set<number>([Cat.system, Cat.apps]);

function RemoveDialog({ d, onClose }: { d: Extract<Dialog, { type: 'remove' }>; onClose: () => void }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const metric = useStore((s) => s.prefs.metric);
  const busy = useStore((s) => s.busy);
  const home = useStore((s) => s.startup?.home ?? '');
  const bytes = d.items.reduce((a, n) => a + (metric === 'size' ? n.size : n.alloc), 0);
  const risky = d.items.some((n) => RISKY.has(n.cat));
  const title = d.items.length === 1 ? t('dlg.removeOne', { name: d.items[0].name }) : t('dlg.removeMany', { count: fmtCount(d.items.length, lang) });
  return (
    <Modal
      title={title}
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <Button kind="ghost" onClick={onClose} disabled={busy}>
            {t('dlg.cancel')}
          </Button>
          <Button kind={d.mode === 'permanent' ? 'danger' : 'primary'} onClick={() => void removeItems(d.items, d.mode)} disabled={busy} autoFocus>
            {busy ? <Spinner size={14} /> : null}
            {busy ? t('dlg.working') : d.mode === 'permanent' ? t('dlg.delete') : t('dlg.trash')}
          </Button>
        </>
      }
    >
      <p className="dlg-lead">{t('dlg.size', { size: fmtBytes(bytes, lang) })}</p>
      <ul className="dlg-items">
        {d.items.slice(0, 6).map((n) => (
          <li key={n.id}>
            <NodeIcon node={n} size={16} />
            <span className="ellipsis">{n.path ? shortPath(n.path, home) : n.name}</span>
            <span className="num muted">{fmtBytes(metric === 'size' ? n.size : n.alloc, lang)}</span>
          </li>
        ))}
        {d.items.length > 6 && <li className="muted">+ {fmtCount(d.items.length - 6, lang)}</li>}
      </ul>
      {risky && (
        <p className="dlg-warn">
          <TriangleExclamationPoint size={16} aria-hidden />
          {t('dlg.warnSystem')}
        </p>
      )}
      <p className="muted small">{d.mode === 'permanent' ? t('dlg.permanentNote') : t('dlg.trashNote')}</p>
    </Modal>
  );
}

function InsightDialog({ d, onClose }: { d: Extract<Dialog, { type: 'insight' }>; onClose: () => void }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  const busy = useStore((s) => s.busy);
  const home = useStore((s) => s.startup?.home ?? '');
  const ins = d.insight;
  const [items, setItems] = useState<NodeInfo[] | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const selectable = ins.action === 'review';

  useEffect(() => {
    let alive = true;
    engine<NodeInfo[]>('insightItems', { kind: ins.kind }).then((r) => {
      if (!alive) return;
      setItems(r);
      setSel(new Set(r.map((n) => n.id)));
    });
    return () => {
      alive = false;
    };
  }, [ins.kind]);

  const chosen = useMemo(() => (items ?? []).filter((n) => !selectable || sel.has(n.id)), [items, sel, selectable]);
  const bytes = chosen.reduce((a, n) => a + n.alloc, 0);

  let action: React.ReactNode = null;
  if (ins.action === 'emptyTrash')
    action = (
      <Button kind="danger" onClick={() => void runInsight(ins, items ?? [], 'permanent')} disabled={busy || !items}>
        {busy ? t('dlg.working') : t('dlg.empty')}
      </Button>
    );
  else if (ins.action === 'diskCleanup')
    action = (
      <Button kind="primary" onClick={() => void runInsight(ins, [], 'permanent')}>
        {t('insA.windowsOld')}
      </Button>
    );
  else if (ins.action === 'review')
    action = (
      <Button kind={ins.deleteMode === 'trash' ? 'primary' : 'danger'} onClick={() => void runInsight(ins, chosen, ins.deleteMode)} disabled={busy || !chosen.length}>
        {busy ? <Spinner size={14} /> : null}
        {busy ? t('dlg.working') : ins.deleteMode === 'trash' ? `${t('dlg.trash')} · ${fmtBytes(bytes, lang)}` : t('dlg.clear', { size: fmtBytes(bytes, lang) })}
      </Button>
    );

  return (
    <Modal
      width={680}
      title={
        <span className="dlg-title">
          <CatIcon cat={INSIGHT_CAT[ins.kind]} size={20} />
          {t(`insT.${ins.kind}`)}
          <span className="muted">{fmtBytes(ins.bytes, lang)}</span>
        </span>
      }
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <span className="muted small mode-note">{ins.action === 'review' ? (ins.deleteMode === 'trash' ? t('ins.recycle') : t('ins.permanent')) : ''}</span>
          <Button kind="ghost" onClick={onClose} disabled={busy}>
            {ins.action === 'info' ? t('dlg.close') : t('dlg.cancel')}
          </Button>
          {action}
        </>
      }
    >
      <p className="dlg-lead">
        <Info size={15} aria-hidden /> {t(`insE.${ins.kind}`)}
      </p>
      {ins.action !== 'info' && (
        <div className="dlg-list" role="list">
          {!items && <Spinner />}
          {items?.map((n) => (
            <div key={n.id} role="listitem" className="dlg-row" onClick={() => selectable && setSel((s) => toggled(s, n.id))}>
              {selectable && <Checkbox checked={sel.has(n.id)} onChange={() => setSel((s) => toggled(s, n.id))} label={n.name} />}
              <NodeIcon node={n} size={16} />
              <span className="ellipsis" title={n.path}>
                {shortPath(n.path ?? n.name, home)}
              </span>
              <span className="num muted">{fmtBytes(n.alloc, lang)}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function toggled(s: Set<number>, id: number) {
  const n = new Set(s);
  if (n.has(id)) n.delete(id);
  else n.add(id);
  return n;
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const prefs = useStore((s) => s.prefs);
  const startup = useStore((s) => s.startup);
  const elevated = !!startup?.elevated;
  const mac = startup?.platform === 'darwin';
  return (
    <Modal title={t('set.title')} onClose={onClose} width={520} footer={<Button onClick={onClose}>{t('dlg.close')}</Button>}>
      <div className="settings">
        <div className="set-row">
          <span>{t('set.theme')}</span>
          <Segmented
            label={t('set.theme')}
            value={prefs.theme}
            onChange={(v) => setPrefs({ theme: v })}
            options={[
              { value: 'system', label: t('set.system') },
              { value: 'dark', label: t('set.dark') },
              { value: 'light', label: t('set.light') },
            ]}
          />
        </div>
        <div className="set-row">
          <span>{t('set.lang')}</span>
          <select className="select" aria-label={t('set.lang')} value={prefs.lang} onChange={(e) => setPrefs({ lang: e.target.value as LangPref })}>
            <option value="system">
              {t('set.system')} · {LANG_NAMES[detectLang()]}
            </option>
            {(Object.keys(LANG_NAMES) as Lang[]).map((l) => (
              <option key={l} value={l}>
                {LANG_NAMES[l]}
              </option>
            ))}
          </select>
        </div>
        <div className="set-row">
          <span>
            {t('set.metric')}
            <small className="muted">{t('set.metricHint')}</small>
          </span>
          <Segmented
            label={t('set.metric')}
            value={prefs.metric}
            onChange={(v) => setPrefs({ metric: v })}
            options={[
              { value: 'alloc', label: t('set.alloc') },
              { value: 'size', label: t('set.size') },
            ]}
          />
        </div>
        <div className="set-row">
          <span>{t('set.motion')}</span>
          <Segmented
            label={t('set.motion')}
            value={prefs.motion}
            onChange={(v) => setPrefs({ motion: v })}
            options={[
              { value: 'system', label: t('set.system') },
              { value: 'on', label: t('set.on') },
              { value: 'reduced', label: t('set.reduced') },
            ]}
          />
        </div>
        {mac ? (
          <div className="set-row">
            <span>
              <ShieldCheck size={14} aria-hidden /> {t('mac.diskAccess.title')}
              <small className="muted">{t('mac.diskAccess.hint')}</small>
            </span>
            <Button small onClick={() => void api.openDiskAccessSettings()}>{t('mac.diskAccess.open')}</Button>
          </div>
        ) : <>
        <div className="set-row">
          <span>
            <Zap size={14} aria-hidden /> {t('set.turbo')}
            <small className="muted">{t('set.turboHint')}</small>
          </span>
          <Switch checked={prefs.turbo} onChange={(v) => setPrefs({ turbo: v })} label={t('set.turbo')} />
        </div>
        <div className="set-row set-admin">
          <span>
            <ShieldCheck size={14} aria-hidden /> {elevated ? t('set.admin') : t('set.user')}
          </span>
          {!elevated && (
            <Button small icon={Zap} onClick={() => void elevate()}>
              {t('turbo.enable')}
            </Button>
          )}
        </div>
        </>}
        <p className="muted small">{t('set.about', { v: startup?.version ?? '' })}</p>
      </div>
    </Modal>
  );
}
