// Portable scanner: highly concurrent readdir + lstat on the libuv thread pool.
// Works on any file system and without administrator rights.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { Cat } from '../shared/types';
import { Tree, F_DIR, F_LINK, F_ERR } from './tree';
import { dirContext, fileCategory } from './classify';

export interface WalkStats {
  files: number;
  dirs: number;
  bytes: number;
  errors: number;
  path: string;
  cats: Float64Array;
  cancelled: boolean;
}

const toSec = (ms: number) => (ms > 0 ? Math.floor(ms / 1000) : 0);

/**
 * Walks every directory below `startId` (which must already exist in the tree
 * with its context set) and appends the entries to the tree.
 * `baseDepth` is the depth of `startId` below the volume root.
 */
export function walkInto(tree: Tree, startId: number, startPath: string, baseDepth: number, stats: WalkStats, concurrency = 96): Promise<void> {
  const paths = new Map<number, string>([[startId, startPath]]);
  const depths = new Map<number, number>([[startId, baseDepth]]);
  const queue: number[] = [startId];
  const locked: { id: number; path: string; parentCtx: number; atRoot: boolean }[] = [];
  let active = 0;

  return new Promise<void>((resolve) => {
    const finish = () => {
      if (!locked.length || stats.cancelled) return resolve();
      fillLockedFiles(tree, locked, stats).finally(resolve);
    };
    const pump = () => {
      while (!stats.cancelled && active < concurrency && queue.length) {
        const id = queue.pop()!;
        active++;
        readDir(id, () => {
          active--;
          pump();
        });
      }
      if (active === 0 && (queue.length === 0 || stats.cancelled)) {
        active = -1; // resolve only once
        finish();
      }
    };

    const readDir = (id: number, done: () => void) => {
      const dirPath = paths.get(id)!;
      const depth = depths.get(id)!;
      paths.delete(id);
      depths.delete(id);
      stats.path = dirPath;
      fs.readdir(dirPath, { withFileTypes: true }, (err, ents) => {
        if (err) {
          tree.flags[id] |= F_ERR;
          stats.errors++;
          return done();
        }
        const ctx = tree.ctx[id];
        const parentName = tree.names[id].toLowerCase();
        const sep = dirPath.endsWith('\\') ? '' : '\\';
        const atRoot = depth === 0;
        let pending = 1;
        const fin = () => {
          if (--pending === 0) done();
        };
        const addDir = (name: string, full: string) => {
          const cid = tree.add(id, name, F_DIR);
          tree.ctx[cid] = dirContext(ctx, name.toLowerCase(), depth + 1, parentName);
          const cc = tree.ctx[cid] & 15;
          tree.cat[cid] = cc ? cc - 1 : Cat.other;
          paths.set(cid, full);
          depths.set(cid, depth + 1);
          queue.push(cid);
          stats.dirs++;
          return cid;
        };
        const addFile = (name: string, st: fs.Stats | undefined, full: string, isLink: boolean) => {
          const lower = name.toLowerCase();
          const fid = tree.add(id, name, isLink ? F_LINK : 0);
          if (!st) {
            tree.cat[fid] = fileCategory(ctx, lower, 0, atRoot);
            locked.push({ id: fid, path: full, parentCtx: ctx, atRoot });
            return;
          }
          const alloc = isLink ? 0 : st.blocks * 512 || 0;
          const size = isLink ? 0 : st.size;
          tree.size[fid] = size;
          tree.alloc[fid] = alloc;
          tree.mtime[fid] = toSec(st.mtimeMs);
          tree.atime[fid] = toSec(st.atimeMs);
          tree.ctime[fid] = toSec(st.birthtimeMs);
          const c = fileCategory(ctx, lower, size, atRoot);
          tree.cat[fid] = c;
          if (!isLink) {
            stats.files++;
            stats.bytes += alloc;
            stats.cats[c] += alloc;
          }
        };

        for (const ent of ents) {
          const name = ent.name;
          const full = dirPath + sep + name;
          if (ent.isDirectory()) {
            addDir(name, full);
          } else if (ent.isSymbolicLink()) {
            // Reparse point: real symlink/junction (skip), or cloud/dedup file or folder.
            pending++;
            fs.lstat(full, (e, st) => {
              if (e) addFile(name, undefined, full, false);
              else if (st.isSymbolicLink()) {
                const lid = tree.add(id, name, F_LINK | (st.isDirectory() ? F_DIR : 0));
                tree.cat[lid] = Cat.other;
              } else if (st.isDirectory()) addDir(name, full);
              else addFile(name, st, full, false);
              fin();
            });
          } else {
            pending++;
            fs.lstat(full, (e, st) => {
              addFile(name, e ? undefined : st, full, false);
              fin();
            });
          }
        }
        fin();
      });
    };

    pump();
  });
}

/**
 * Files like pagefile.sys refuse to be opened for stat; ask PowerShell, which
 * reads the directory entry instead (FindFirstFile) and always gets the size.
 */
function fillLockedFiles(tree: Tree, locked: { id: number; path: string; parentCtx: number; atRoot: boolean }[], stats: WalkStats): Promise<void> {
  const batch = locked.slice(0, 400);
  const list = batch.map((l) => "'" + l.path.replace(/'/g, "''") + "'").join(',');
  const script =
    `$ErrorActionPreference='SilentlyContinue'; foreach($p in @(${list})){ $i = Get-Item -Force -LiteralPath $p; ` +
    `if($i){ [Console]::Out.WriteLine($i.Length.ToString() + '|' + [DateTimeOffset]::new($i.LastWriteTimeUtc).ToUnixTimeSeconds() + '|' + [DateTimeOffset]::new($i.CreationTimeUtc).ToUnixTimeSeconds()) } else { [Console]::Out.WriteLine('') } }`;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20000, maxBuffer: 4 << 20 },
      (err, stdout) => {
        if (!err && stdout) {
          const lines = stdout.split(/\r?\n/);
          batch.forEach((l, i) => {
            const [len, mt, ct] = (lines[i] ?? '').split('|').map(Number);
            if (!Number.isFinite(len) || len <= 0) return;
            // Size on disk is not exposed here; round up to 4 KiB clusters.
            const alloc = Math.ceil(len / 4096) * 4096;
            tree.size[l.id] = len;
            tree.alloc[l.id] = alloc;
            tree.mtime[l.id] = mt > 0 ? mt : 0;
            tree.ctime[l.id] = ct > 0 ? ct : 0;
            tree.atime[l.id] = mt > 0 ? mt : 0;
            const c = fileCategory(l.parentCtx, tree.names[l.id].toLowerCase(), len, l.atRoot);
            tree.cat[l.id] = c;
            stats.files++;
            stats.bytes += alloc;
            stats.cats[c] += alloc;
          });
        }
        resolve();
      },
    );
  });
}
