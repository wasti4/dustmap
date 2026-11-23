
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Cat } from '../shared/types';
import type { MacScanScope } from '../platform/macos';
import { dirContext, fileCategory } from './classify';
import { Tree, F_DIR, F_ERR, F_HIDDEN, F_LINK } from './tree';
import type { WalkStats } from './walk';

type Entry = [parent: number, depth: number, kind: 0 | 1 | 2, name: string, size: number, alloc: number,
  modified: number, accessed: number, created: number, hardLink?: string];

function macEntries(tree: Tree, baseDepth: number, stats: WalkStats) {
  const hardLinks = new Set<string>();
  return (parent: number, depth: number, kind: 0 | 1 | 2, name: string, size: number, alloc: number,
      modified: number, accessed: number, created: number, hardLink?: string) => {
    const flags = (kind === 1 ? F_DIR : kind === 2 ? F_LINK : 0) | (name.startsWith('.') ? F_HIDDEN : 0);
    const id = tree.add(parent, name, flags);
    const ctx = tree.ctx[parent];
    const lower = name.toLowerCase();
    tree.mtime[id] = Math.max(0, modified);
    tree.atime[id] = Math.max(0, accessed);
    tree.ctime[id] = Math.max(0, created);
    if (kind === 1) {
      tree.ctx[id] = dirContext(ctx, lower, baseDepth + depth + 1, tree.names[parent].toLowerCase(), 'darwin');
      const cc = tree.ctx[id] & 15;
      tree.cat[id] = cc ? cc - 1 : Cat.other;
      stats.dirs++;
    } else if (kind === 0) {
      if (hardLink) {
        if (hardLinks.has(hardLink)) alloc = 0;
        else hardLinks.add(hardLink);
      }
      tree.size[id] = size;
      tree.alloc[id] = alloc;
      const category = fileCategory(ctx, lower, size, baseDepth + depth === 0, 'darwin');
      tree.cat[id] = category;
      stats.files++;
      stats.bytes += alloc;
      stats.cats[category] += alloc;
    } else tree.cat[id] = Cat.other;
    return id;
  };
}

function markError(tree: Tree, id: number, stats: WalkStats) {
  tree.flags[id] |= F_ERR;
  stats.errors++;
}

export function walkMacNative(tree: Tree, startId: number, baseDepth: number, scope: MacScanScope, stats: WalkStats, exe: string): Promise<boolean> {
  const add = macEntries(tree, baseDepth, stats);
  const base = tree.n - 1;
  const trashParent = scope.volume === '/' ? '' : path.posix.dirname(scope.trashPath);
  return new Promise((resolve) => {
    const child = spawn(exe, [scope.root, trashParent], { stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let last = startId;
    let done = false;
    let invalid = false;
    const timer = setInterval(() => {
      if (stats.cancelled) child.kill();
      stats.path = tree.path(last);
    }, 100);
    lines.on('line', (line) => {
      if (invalid || stats.cancelled) return;
      try {
        const row = JSON.parse(line);
        if (!Array.isArray(row) || done) throw new Error('invalid Mac walker record');
        if (row.length === 2 && row[0] === 'done') {
          done = true;
          stats.bulkEntries = row[1];
          return;
        }
        const parent = row[0] === 0 ? startId : base + row[0];
        if (!Number.isInteger(row[0]) || row[0] < 0 || !tree.alive(parent) || !tree.isDir(parent)) throw new Error('invalid parent');
        last = parent;
        if (row.length === 1) {
          markError(tree, parent, stats);
          return;
        }
        const [, depth, kind, name, size, alloc, modified, accessed, created, hardLink] = row as Entry;
        if (typeof name !== 'string' || name.includes('/') || ![0, 1, 2].includes(kind)) throw new Error('invalid entry');
        add(parent, depth, kind, name, size, alloc, modified, accessed, created, hardLink);
      } catch {
        invalid = true;
        child.kill();
      }
    });
    child.on('error', () => {
      clearInterval(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearInterval(timer);
      resolve(code === 0 && done && !invalid && !stats.cancelled);
    });
  });
}

/** Fallback for development without a compiled helper. */
export async function walkMacPortable(tree: Tree, startId: number, baseDepth: number, scope: MacScanScope, stats: WalkStats): Promise<void> {
  const add = macEntries(tree, baseDepth, stats);
  const pending = [{ id: startId, depth: 0, full: scope.root }];
  const trashParent = scope.volume === '/' ? '' : path.posix.dirname(scope.trashPath);
  while (pending.length && !stats.cancelled) {
    const { id, depth, full } = pending.pop()!;
    stats.path = full;
    let names: string[];
    try {
      const dir = await fs.lstat(full);
      if (!dir.isDirectory() || !scope.devices.has(dir.dev)) continue;
      if (full === trashParent) {
        const own = await fs.lstat(scope.trashPath).catch((e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return null;
          throw e;
        });
        names = own?.isDirectory() && own.uid === process.getuid?.() ? [path.posix.basename(scope.trashPath)] : [];
      } else names = await fs.readdir(full);
    } catch {
      markError(tree, id, stats);
      continue;
    }
    for (let i = 0; i < names.length && !stats.cancelled; i += 64) {
      await Promise.all(names.slice(i, i + 64).map(async (name) => {
        const p = path.posix.join(full, name);
        if (scope.root === '/' && (p === '/System/Volumes' || p === '/Volumes')) return;
        try {
          const st = await fs.lstat(p, { bigint: true });
          const kind = st.isDirectory() ? 1 : st.isSymbolicLink() ? 2 : 0;
          if (!kind && !st.isFile()) return;
          const child = add(id, depth, kind, name, Number(st.size), Number(st.blocks) * 512,
            Number(st.mtimeMs / 1000n), Number(st.atimeMs / 1000n), Number(st.birthtimeMs / 1000n),
            st.nlink > 1n ? String(st.dev) + ':' + String(st.ino) : undefined);
          if (kind === 1) pending.push({ id: child, depth: depth + 1, full: p });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') markError(tree, id, stats);
        }
      }));
    }
  }
}
