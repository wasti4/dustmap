// Types shared by the scan engine (utility process), the Electron main process
// and the renderer. Keep this file free of Node/DOM imports.

/** Category order is also the order of segments in the storage bar. */
export const CATEGORIES = [
  'apps',
  'developer',
  'photos',
  'videos',
  'documents',
  'music',
  'archives',
  'games',
  'system',
  'caches',
  'trash',
  'other',
] as const;
export type CategoryId = (typeof CATEGORIES)[number];
export const CAT_COUNT = CATEGORIES.length;
export const Cat = Object.fromEntries(CATEGORIES.map((c, i) => [c, i])) as Record<CategoryId, number>;

/** Node flags (bit set). */
export const NF = {
  USED: 1,
  DIR: 2,
  LINK: 4,
  ERR: 8,
  HIDDEN: 16,
  SYSTEM: 32,
  DELETED: 64,
} as const;

export type Metric = 'alloc' | 'size';
export type SortKey = 'value' | 'name' | 'files' | 'mtime' | 'last';
export type ScanMode = 'mft' | 'walk';

export interface DriveInfo {
  root: string; // "C:\\"
  letter: string; // "C"
  label: string;
  fs: string;
  total: number;
  free: number;
  kind: 'fixed' | 'removable' | 'network' | 'cdrom' | 'unknown';
  system: boolean;
}

export interface ScanRequest {
  root: string;
  /** Try to read the NTFS master file table directly (needs admin). */
  turbo: boolean;
}

export interface ScanProgress {
  scanId: number;
  mode: ScanMode;
  phase: 'mft' | 'walk' | 'build' | 'analyze';
  files: number;
  dirs: number;
  /** Bytes on disk found so far. */
  bytes: number;
  path: string;
  /** 0..1 or -1 when unknown. */
  fraction: number;
  /** Bytes on disk per category so far (may be empty while reading the MFT). */
  cats: number[];
  total: number;
  free: number;
}

export interface CatTotal {
  alloc: number;
  size: number;
  count: number;
}

export interface ScanSummary {
  scanId: number;
  root: string;
  rootId: number;
  isVolume: boolean;
  mode: ScanMode;
  /** Why turbo mode was not used, when it was requested. */
  turboNote?: 'not-admin' | 'not-ntfs' | 'failed' | 'not-volume';
  ms: number;
  files: number;
  dirs: number;
  alloc: number;
  size: number;
  errors: number;
  total: number;
  free: number;
  cats: CatTotal[];
  accessTracking: 'on' | 'off' | 'unknown';
  scannedAt: number;
}

export interface NodeInfo {
  id: number;
  name: string;
  dir: boolean;
  size: number;
  alloc: number;
  files: number;
  dirs: number;
  /** Seconds since epoch (0 = unknown). */
  mtime: number;
  atime: number;
  ctime: number;
  /** "Last used" = latest of access / modify / create over the whole subtree. */
  last: number;
  cat: number;
  flags: number;
  hasKids: boolean;
  path?: string;
}

export interface ChildrenPage {
  id: number;
  items: NodeInfo[];
  total: number;
  /** Value (by metric) of children not included in this page. */
  restValue: number;
}

export interface Crumb {
  id: number;
  name: string;
}

export interface NodeDetail extends NodeInfo {
  path: string;
  crumbs: Crumb[];
  catBreakdown: number[];
}

export interface TreemapResult {
  id: number;
  /** Packed rects: x, y, w, h, id, cat, depth, flags(1=dir, 2=label), value. */
  rects: Float64Array;
  names: string[];
}
export const TM_STRIDE = 9;

export type InsightKind =
  | 'trash'
  | 'temp'
  | 'caches'
  | 'devJunk'
  | 'installers'
  | 'oldDownloads'
  | 'largeOld'
  | 'windowsOld'
  | 'hibernation';

export type DeleteMode = 'trash' | 'permanent' | 'contents';

export interface Insight {
  kind: InsightKind;
  bytes: number;
  count: number;
  ids: number[];
  action: 'emptyTrash' | 'review' | 'diskCleanup' | 'info';
  deleteMode: DeleteMode;
}

export interface StaleQuery {
  days: number;
  minSize: number;
  mode: 'smart' | 'files';
  cats: number[];
  includeSystem: boolean;
  scopeId: number;
  limit: number;
  metric: Metric;
}

export interface ListQuery {
  scopeId: number;
  limit: number;
  metric: Metric;
  cats?: number[];
  query?: string;
  minSize?: number;
  dirs?: boolean;
}

export interface ListResult {
  items: NodeInfo[];
  total: number;
  bytes: number;
}

export interface FileTypeRow {
  ext: string;
  cat: number;
  size: number;
  alloc: number;
  count: number;
}

export interface OpResult {
  ok: string[];
  failed: { path: string; error: string }[];
}

export type EngineEvent =
  | { type: 'progress'; data: ScanProgress }
  | { type: 'done'; data: ScanSummary }
  | { type: 'error'; data: { scanId: number; message: string } };

export interface StartupInfo {
  elevated: boolean;
  autoScan?: string;
  systemDrive: string;
  home: string;
  version: string;
}

/** API exposed to the renderer by the preload script as `window.storage`. */
export interface StorageApi {
  startup(): Promise<StartupInfo>;
  drives(): Promise<DriveInfo[]>;
  relaunchElevated(resumeRoot?: string): Promise<boolean>;
  chooseFolder(): Promise<string | null>;
  pathForFile(file: File): string;
  engine<T = unknown>(method: string, params?: unknown): Promise<T>;
  onEngineEvent(cb: (ev: EngineEvent) => void): () => void;
  openPath(path: string): Promise<string>;
  reveal(path: string): Promise<void>;
  copyText(text: string): Promise<void>;
  trash(paths: string[]): Promise<OpResult>;
  remove(paths: string[], mode: 'permanent' | 'contents'): Promise<OpResult>;
  emptyRecycleBin(root: string): Promise<OpResult>;
  diskCleanup(root: string): Promise<void>;
  space(root: string): Promise<{ total: number; free: number }>;
  setChrome(opts: { dark: boolean; color: string; symbol: string }): Promise<void>;
}
