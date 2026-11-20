// Scan orchestration: picks the turbo MFT reader when possible, falls back to
// the portable walker, classifies everything and aggregates the tree.
import fs from 'node:fs';
import path from 'node:path';
import { CAT_COUNT, Cat, type Insight, type ScanMode, type ScanProgress, type ScanRequest } from '../shared/types';
import { Tree, F_DIR } from './tree';
import { walkInto, type WalkStats } from './walk';
import { fastWalk, helperPath } from './fastwalk';
import { readMft, MftUnavailable } from './mft';
import { contextForPath, dirContext, fileCategory } from './classify';

export interface ScanState {
  id: number;
  tree: Tree;
  root: string;
  rootId: number;
  baseDepth: number;
  isVolume: boolean;
  mode: ScanMode;
  turboNote?: 'not-admin' | 'not-ntfs' | 'failed' | 'not-volume';
  /** Diagnostic message when the MFT reader failed. */
  turboError?: string;
  /** Milliseconds per phase, for benchmarks. */
  phases?: Record<string, number>;
  ms: number;
  errors: number;
  total: number;
  free: number;
  scannedAt: number;
  insights: Insight[] | null;
}

export interface ScanControl {
  cancelled: boolean;
}

export function normalizeRoot(p: string): string {
  let r = path.resolve(p);
  if (/^[A-Za-z]:$/.test(r)) r += '\\';
  if (/^[a-z]:\\/.test(r)) r = r[0].toUpperCase() + r.slice(1);
  return r;
}

export async function volumeSpace(root: string): Promise<{ total: number; free: number }> {
  try {
    const s = await fs.promises.statfs(root);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return { total: 0, free: 0 };
  }
}

export function newWalkStats(): WalkStats {
  return { files: 0, dirs: 0, bytes: 0, errors: 0, path: '', cats: new Float64Array(CAT_COUNT), cancelled: false };
}

/** Assigns contexts/categories top-down (used after the MFT reader built the tree). */
export function classifyTree(tree: Tree, rootId: number, rootCtx: number, baseDepth: number) {
  const { first, next, flags, names, ctx, cat, size } = tree;
  ctx[rootId] = rootCtx;
  const stack: number[] = [rootId, baseDepth];
  while (stack.length) {
    const depth = stack.pop()!;
    const id = stack.pop()!;
    const pctx = ctx[id];
    const pname = names[id].toLowerCase();
    const atRoot = depth === 0;
    for (let c = first[id]; c !== -1; c = next[c]) {
      const lower = names[c].toLowerCase();
      if (flags[c] & F_DIR) {
        const cc = dirContext(pctx, lower, depth + 1, pname);
        ctx[c] = cc;
        cat[c] = (cc & 15) - 1 >= 0 ? (cc & 15) - 1 : Cat.other;
        stack.push(c, depth + 1);
      } else {
        cat[c] = fileCategory(pctx, lower, size[c], atRoot);
      }
    }
  }
}

export async function runScan(id: number, req: ScanRequest, onProgress: (p: ScanProgress) => void, ctl: ScanControl): Promise<ScanState> {
  const t0 = Date.now();
  const root = normalizeRoot(req.root);
  const isVolume = /^[A-Z]:\\$/.test(root);
  const { total, free } = await volumeSpace(root);
  const { ctx: rootCtx, depth: baseDepth } = contextForPath(root);
  const used = Math.max(1, total - free);
  let turboNote: ScanState['turboNote'];
  let turboError: string | undefined;

  const emit = (p: Omit<ScanProgress, 'scanId' | 'total' | 'free'>) => onProgress({ ...p, scanId: id, total, free });

  if (req.turbo && !isVolume) turboNote = 'not-volume';
  if (req.turbo && isVolume) {
    const tree = new Tree(16);
    let last = 0;
    try {
      const res = await readMft(
        root,
        tree,
        root,
        (read, all, records) => {
          const now = Date.now();
          if (now - last < 90) return;
          last = now;
          emit({ mode: 'mft', phase: 'mft', files: records, dirs: 0, bytes: (read / all) * used, path: root, fraction: read / all, cats: [] });
        },
        () => ctl.cancelled,
      );
      const tRead = Date.now();
      emit({ mode: 'mft', phase: 'build', files: res.records, dirs: 0, bytes: used, path: root, fraction: 1, cats: [] });
      classifyTree(tree, res.rootId, rootCtx, baseDepth);
      const tClassify = Date.now();
      tree.aggregate(res.rootId);
      const phases = { read: tRead - t0, classify: tClassify - tRead, aggregate: Date.now() - tClassify };
      if (tree.aFiles[res.rootId] > 10) {
        return {
          id,
          tree,
          root,
          rootId: res.rootId,
          baseDepth,
          isVolume,
          mode: 'mft',
          phases,
          ms: Date.now() - t0,
          errors: 0,
          total,
          free,
          scannedAt: Date.now(),
          insights: null,
        };
      }
      turboNote = 'failed';
      turboError = `MFT produced only ${tree.aFiles[res.rootId]} files`;
    } catch (e) {
      if (ctl.cancelled) throw e;
      turboNote = e instanceof MftUnavailable ? e.reason : 'failed';
      turboError = String((e as Error)?.stack ?? e);
    }
  }

  // Directory walk: native helper when available, portable walker otherwise.
  const stats = newWalkStats();
  const timer = setInterval(() => {
    stats.cancelled = ctl.cancelled;
    emit({
      mode: 'walk',
      phase: 'walk',
      files: stats.files,
      dirs: stats.dirs,
      bytes: stats.bytes,
      path: stats.path,
      fraction: isVolume ? Math.min(0.99, stats.bytes / used) : -1,
      cats: Array.from(stats.cats),
    });
  }, 100);
  let tree: Tree;
  try {
    tree = await walkTree(root, rootCtx, baseDepth, stats);
  } finally {
    clearInterval(timer);
  }
  if (ctl.cancelled) throw new Error('cancelled');
  emit({ mode: 'walk', phase: 'analyze', files: stats.files, dirs: stats.dirs, bytes: stats.bytes, path: root, fraction: 1, cats: Array.from(stats.cats) });
  tree.aggregate(tree.root);
  return {
    id,
    tree,
    root,
    rootId: tree.root,
    baseDepth,
    isVolume,
    mode: 'walk',
    turboNote,
    turboError,
    ms: Date.now() - t0,
    errors: stats.errors,
    total,
    free,
    scannedAt: Date.now(),
    insights: null,
  };
}

function freshTree(root: string, rootCtx: number): Tree {
  const tree = new Tree(1 << 18);
  const rootId = tree.add(-1, root, F_DIR);
  tree.root = rootId;
  tree.ctx[rootId] = rootCtx;
  return tree;
}

async function walkTree(root: string, rootCtx: number, baseDepth: number, stats: WalkStats): Promise<Tree> {
  const exe = helperPath();
  if (exe) {
    const tree = freshTree(root, rootCtx);
    if (await fastWalk(tree, tree.root, root, baseDepth, stats, exe)) return tree;
    if (stats.cancelled) return tree;
    Object.assign(stats, newWalkStats());
  }
  const tree = freshTree(root, rootCtx);
  await walkInto(tree, tree.root, root, baseDepth, stats);
  return tree;
}

/** Re-walks the children of an existing directory node (used after cleanups). */
export async function walkSubtree(tree: Tree, id: number, dirPath: string, depth: number): Promise<void> {
  const stats = newWalkStats();
  const exe = helperPath();
  if (exe) {
    const before = tree.n;
    if (await fastWalk(tree, id, dirPath, depth, stats, exe)) return;
    // Discard partial results, then fall back.
    for (let c = tree.first[id]; c !== -1; c = tree.next[c]) tree.markDeleted(c);
    tree.first[id] = -1;
    void before;
  }
  await walkInto(tree, id, dirPath, depth, newWalkStats(), 48);
}
