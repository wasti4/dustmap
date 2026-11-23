// Global app state (a tiny store on useSyncExternalStore) and the actions that
// talk to the engine and the main process.
import { useSyncExternalStore } from 'react';
import type {
  DeleteMode,
  DriveInfo,
  EngineEvent,
  Insight,
  Metric,
  NodeInfo,
  OpResult,
  ScanProgress,
  ScanSummary,
  StartupInfo,
} from '../shared/types';
import { api, engine, initApi } from './lib/api';
import { detectLang, translate, type Lang, type LangPref, type TKey } from './lib/i18n';
import { fmtBytes } from './lib/format';

export type Tab = 'folders' | 'files' | 'forgotten' | 'types' | 'search';

export interface Prefs {
  theme: 'system' | 'dark' | 'light';
  lang: LangPref;
  metric: Metric;
  turbo: boolean;
  motion: 'system' | 'on' | 'reduced';
  collapsed: boolean;
  view: 'split' | 'list' | 'map';
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
}

export type Dialog =
  | { type: 'remove'; items: NodeInfo[]; mode: 'trash' | 'permanent' }
  | { type: 'insight'; insight: Insight }
  | { type: 'settings' }
  | null;

export interface State {
  ready: boolean;
  desktop: boolean;
  startup: StartupInfo | null;
  drives: DriveInfo[] | null;
  view: 'home' | 'workspace';
  scanning: boolean;
  scanRoot: string | null;
  scanStart: number;
  progress: ScanProgress | null;
  summary: ScanSummary | null;
  freed: { bytes: number; at: number } | null;
  insights: Insight[] | null;
  tab: Tab;
  focusId: number;
  selectedId: number | null;
  search: string;
  /** Category preset for the "Largest files" tab (from the legend). */
  catFilter: number | null;
  /** Name filter preset for the "Largest files" tab (from "File types"). */
  fileQuery: string;
  version: number;
  prefs: Prefs;
  /** Language in effect (resolves 'system'). */
  lang: Lang;
  dark: boolean;
  reducedMotion: boolean;
  toasts: Toast[];
  dialog: Dialog;
  busy: boolean;
  /** Category whose bar segment just shrank (drives the particle animation). */
  dissolve: { cat: number; at: number } | null;
}

const PREFS_KEY = 'dustmap.prefs';
function loadPrefs(): Prefs {
  const q = new URLSearchParams(location.search);
  const forced: Partial<Prefs> = {};
  const qt = q.get('theme');
  if (qt === 'dark' || qt === 'light') forced.theme = qt;
  const ql = q.get('lang');
  if (ql === 'en' || ql === 'ru' || ql === 'zh' || ql === 'es') forced.lang = ql;
  const def: Prefs = { theme: 'system', lang: 'system', metric: 'alloc', turbo: true, motion: 'system', collapsed: false, view: 'split' };
  try {
    return { ...def, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}'), ...forced };
  } catch {
    return { ...def, ...forced };
  }
}

const mqDark = window.matchMedia('(prefers-color-scheme: dark)');
const mqMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let state: State = {
  ready: false,
  desktop: false,
  startup: null,
  drives: null,
  view: 'home',
  scanning: false,
  scanRoot: null,
  scanStart: 0,
  progress: null,
  summary: null,
  freed: null,
  insights: null,
  tab: 'folders',
  focusId: -1,
  selectedId: null,
  search: '',
  catFilter: null,
  fileQuery: '',
  version: 0,
  prefs: loadPrefs(),
  lang: 'en',
  dark: true,
  reducedMotion: false,
  toasts: [],
  dialog: null,
  busy: false,
  dissolve: null,
};
const listeners = new Set<() => void>();

export const getState = () => state;
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

export const t = (key: TKey, vars?: Record<string, string | number>) => translate(state.lang, key, vars, state.startup?.platform === 'darwin');
const bytes = (n: number) => fmtBytes(n, state.lang);

// ------------------------------------------------------------------ theme

function applyTheme() {
  const { theme, motion } = state.prefs;
  const dark = theme === 'system' ? mqDark.matches : theme === 'dark';
  const reducedMotion = motion === 'system' ? mqMotion.matches : motion === 'reduced';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.motion = reducedMotion ? 'reduced' : 'full';
  const lang = state.prefs.lang === 'system' ? detectLang() : state.prefs.lang;
  if (lang !== state.lang) setState({ lang });
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  document.title = t('app.name');
  if (dark !== state.dark || reducedMotion !== state.reducedMotion) setState({ dark, reducedMotion });
  void api?.setChrome({ dark, color: dark ? '#0d0d0f' : '#f4f4f5', symbol: dark ? '#a1a1aa' : '#52525b' });
}

export function setPrefs(p: Partial<Prefs>) {
  setState((s) => ({ prefs: { ...s.prefs, ...p } }));
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
  } catch {
    /* storage unavailable */
  }
  applyTheme();
  if ('metric' in p) setState((s) => ({ version: s.version + 1 }));
}

// ------------------------------------------------------------------ toasts

let toastSeq = 0;
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = ++toastSeq;
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), kind === 'error' ? 7000 : 4200);
}

// ------------------------------------------------------------------ lifecycle

export async function init() {
  applyTheme();
  const desktop = await initApi();
  applyTheme();
  mqDark.addEventListener('change', applyTheme);
  mqMotion.addEventListener('change', applyTheme);
  window.addEventListener('languagechange', applyTheme);
  api.onEngineEvent(onEngineEvent);
  const startup = await api.startup();
  setState({ ready: true, desktop, startup });
  api.drives().then((drives) => setState({ drives }));
  if (startup.autoScan) startScan(startup.autoScan);
}

export async function refreshDrives() {
  setState({ drives: await api.drives(true) });
}

export function startScan(root: string) {
  setState({
    view: 'workspace',
    scanning: true,
    scanRoot: root,
    scanStart: Date.now(),
    progress: null,
    summary: null,
    insights: null,
    freed: null,
    focusId: -1,
    selectedId: null,
    search: '',
    tab: state.tab === 'search' ? 'folders' : state.tab,
  });
  engine('scan', { root, turbo: state.prefs.turbo && !!state.startup?.elevated }).catch((e) => {
    toast(t('toast.scanFailed', { reason: String(e?.message ?? e) }), 'error');
    setState({ scanning: false, view: 'home' });
  });
}

export function cancelScan() {
  void engine('cancel');
  setState({ scanning: false, view: state.summary ? 'workspace' : 'home' });
}

export function goHome() {
  // Release the scanned tree: the engine process is stopped and restarts on the next scan.
  void engine('reset');
  setState({ view: 'home', scanning: false, summary: null, insights: null, progress: null, focusId: -1, selectedId: null, search: '' });
  void refreshDrives();
}

function onEngineEvent(ev: EngineEvent) {
  if (ev.type === 'progress') {
    if (state.scanning) setState({ progress: ev.data });
  } else if (ev.type === 'done') {
    setState((s) => ({ scanning: false, summary: ev.data, focusId: ev.data.rootId, selectedId: null, version: s.version + 1, progress: null }));
    void loadInsights();
  } else if (ev.type === 'error') {
    if (ev.data.message === 'cancelled') return;
    if (ev.data.message === 'engine-crashed') {
      toast(t('toast.engine'), 'error');
      setState({ scanning: false, summary: null, view: 'home' });
      return;
    }
    toast(t('toast.scanFailed', { reason: ev.data.message }), 'error');
    setState({ scanning: false, view: state.summary ? 'workspace' : 'home' });
  }
}

export async function loadInsights() {
  try {
    setState({ insights: await engine<Insight[]>('insights') });
  } catch {
    setState({ insights: [] });
  }
}

/** Applies a new summary after the tree changed and reports the space freed. */
function applySummary(next: ScanSummary) {
  const prev = state.summary;
  const before = prev ? prev.alloc : next.alloc;
  const freedBytes = Math.max(0, before - next.alloc);
  let shrunk: number | null = null;
  if (prev) {
    let best = 0;
    next.cats.forEach((c, i) => {
      const d = prev.cats[i].alloc - c.alloc;
      if (d > best) {
        best = d;
        shrunk = i;
      }
    });
  }
  setState((s) => ({
    summary: next,
    version: s.version + 1,
    freed: freedBytes > 0 ? { bytes: freedBytes + (s.freed && Date.now() - s.freed.at < 15000 ? s.freed.bytes : 0), at: Date.now() } : s.freed,
    dissolve: shrunk !== null ? { cat: shrunk, at: Date.now() } : s.dissolve,
    selectedId: s.selectedId,
  }));
  void loadInsights();
  if (freedBytes > 0) toast(t('toast.freed', { size: bytes(freedBytes) }), 'success');
}

async function afterOp(res: OpResult, items: { id: number; path: string }[], refreshAll = false) {
  if (state.startup?.platform === 'darwin') {
    // Reindex allocation after a move or delete so remaining hard links inherit their blocks.
    // A move to Trash and APFS snapshots can leave the actual available space unchanged.
    if (res.failed.length) toast(t('toast.skipped', { count: res.failed.length }), 'info');
    if (state.summary && (res.ok.length || res.failed.length)) startScan(state.summary.root);
    return;
  }
  const ok = new Set(res.ok);
  const removedIds = refreshAll ? [] : items.filter((i) => ok.has(i.path)).map((i) => i.id);
  const refreshIds = refreshAll ? items.map((i) => i.id) : items.filter((i) => !ok.has(i.path)).map((i) => i.id);
  let summary: ScanSummary | null = null;
  if (removedIds.length) summary = await engine<ScanSummary>('removed', { ids: removedIds });
  if (refreshIds.length) summary = await engine<ScanSummary>('refresh', { ids: refreshIds });
  if (summary) applySummary(summary);
  const skipped = res.failed.length;
  if (skipped) toast(t('toast.skipped', { count: skipped }), 'info');
}

export async function pathsFor(items: NodeInfo[]): Promise<{ id: number; path: string }[]> {
  const missing = items.filter((i) => !i.path).map((i) => i.id);
  const resolved = missing.length ? await engine<(string | null)[]>('paths', { ids: missing }) : [];
  const map = new Map(missing.map((id, k) => [id, resolved[k]]));
  return items.map((i) => ({ id: i.id, path: i.path ?? map.get(i.id) ?? '' })).filter((i) => i.path);
}

export async function removeItems(items: NodeInfo[], mode: 'trash' | 'permanent') {
  setState({ busy: true });
  try {
    const list = await pathsFor(items);
    const paths = list.map((i) => i.path);
    const res = mode === 'trash' ? await api.trash(paths) : await api.remove(paths, 'permanent');
    await afterOp(res, list);
  } finally {
    setState({ busy: false, dialog: null });
  }
}

export async function runInsight(ins: Insight, items: NodeInfo[], mode: DeleteMode) {
  const root = state.summary?.root;
  if (!root) return;
  if (ins.action === 'diskCleanup') {
    await api.diskCleanup(root);
    setState({ dialog: null });
    return;
  }
  setState({ busy: true });
  try {
    const list = await pathsFor(items);
    if (ins.action === 'emptyTrash') {
      const res = await api.emptyRecycleBin(root);
      await afterOp(res, list, true);
    } else if (mode === 'contents') {
      const res = await api.remove(list.map((i) => i.path), 'contents');
      await afterOp(res, list, true);
    } else if (mode === 'trash') {
      await afterOp(await api.trash(list.map((i) => i.path)), list);
    } else {
      await afterOp(await api.remove(list.map((i) => i.path), 'permanent'), list);
    }
  } finally {
    setState({ busy: false, dialog: null });
  }
}

export function openInsight(ins: Insight) {
  setState({ dialog: { type: 'insight', insight: ins } });
}

export async function elevate() {
  const ok = await api.relaunchElevated(state.summary?.root ?? state.scanRoot ?? undefined);
  if (!ok) toast(t('toast.elevateFailed'), 'error');
}

export function focusNode(id: number, select: number | null = null) {
  setState({ focusId: id, selectedId: select, tab: 'folders' });
}
