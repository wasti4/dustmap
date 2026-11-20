// Drives the native sc-walker helper (see src/native/sc-walker.cs) and turns
// its stream of raw FILE_FULL_DIR_INFORMATION records into tree nodes.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Cat } from '../shared/types';
import { Tree, F_DIR, F_LINK, F_ERR, F_HIDDEN, F_SYSTEM } from './tree';
import { dirContext, fileCategory } from './classify';
import type { WalkStats } from './walk';

const EPOCH_DIFF = 11644473600;
const ft = (b: Buffer, o: number) => {
  const s = b.readUInt32LE(o + 4) * 429.4967296 + b.readUInt32LE(o) / 1e7 - EPOCH_DIFF;
  return s > 0 && s < 4294967295 ? Math.floor(s) : 0;
};
const u64 = (b: Buffer, o: number) => b.readUInt32LE(o) + b.readUInt32LE(o + 4) * 4294967296;

let cachedHelper: string | null | undefined;
export function helperPath(): string | null {
  if (cachedHelper !== undefined) return cachedHelper;
  if (process.platform !== 'win32' || process.env.SC_NO_HELPER) return (cachedHelper = null);
  const p = path.join(__dirname, 'sc-walker.exe').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  cachedHelper = fs.existsSync(p) ? p : null;
  return cachedHelper;
}

/** Resolves true when the helper finished the whole subtree. */
export function fastWalk(tree: Tree, startId: number, startPath: string, baseDepth: number, stats: WalkStats, exe: string): Promise<boolean> {
  return new Promise((resolve) => {
    let nodeOf = new Int32Array(1 << 16).fill(-1);
    let depthOf = new Uint16Array(1 << 16);
    nodeOf[0] = startId;
    depthOf[0] = baseDepth;
    const ensure = (id: number) => {
      if (id < nodeOf.length) return;
      let n = nodeOf.length;
      while (n <= id) n *= 2;
      const a = new Int32Array(n).fill(-1);
      a.set(nodeOf);
      nodeOf = a;
      const d = new Uint16Array(n);
      d.set(depthOf);
      depthOf = d;
    };

    let lastDir = startId;
    const parseBlock = (b: Buffer, start: number, end: number, dirId: number, first: number) => {
      const parent = nodeOf[dirId];
      if (parent < 0) return;
      lastDir = parent;
      const depth = depthOf[dirId];
      const pctx = tree.ctx[parent];
      const pname = tree.names[parent].toLowerCase();
      const atRoot = depth === 0;
      let sub = 0;
      let o = start;
      while (o + 68 <= end) {
        const next = b.readUInt32LE(o);
        const attrs = b.readUInt32LE(o + 56);
        const nameLen = b.readUInt32LE(o + 60);
        const tag = b.readUInt32LE(o + 64);
        const name = b.toString('utf16le', o + 68, o + 68 + nameLen);
        const link = (attrs & 0x400) !== 0 && (tag & 0x20000000) !== 0;
        const fl = (attrs & 2 ? F_HIDDEN : 0) | (attrs & 4 ? F_SYSTEM : 0) | (link ? F_LINK : 0);
        if (attrs & 0x10) {
          if (name !== '.' && name !== '..') {
            const hid = first + sub++;
            const id = tree.add(parent, name, F_DIR | fl);
            tree.ctime[id] = ft(b, o + 8);
            tree.atime[id] = ft(b, o + 16);
            tree.mtime[id] = ft(b, o + 24);
            ensure(hid);
            if (link) {
              tree.cat[id] = Cat.other;
            } else {
              const cctx = dirContext(pctx, name.toLowerCase(), depth + 1, pname);
              tree.ctx[id] = cctx;
              tree.cat[id] = cctx & 15 ? (cctx & 15) - 1 : Cat.other;
              nodeOf[hid] = id;
              depthOf[hid] = depth + 1;
              stats.dirs++;
            }
          }
        } else {
          const id = tree.add(parent, name, fl);
          tree.ctime[id] = ft(b, o + 8);
          tree.atime[id] = ft(b, o + 16);
          tree.mtime[id] = ft(b, o + 24);
          if (link) {
            tree.cat[id] = Cat.other;
          } else {
            const size = u64(b, o + 40);
            const alloc = u64(b, o + 48);
            tree.size[id] = size;
            tree.alloc[id] = alloc;
            const c = fileCategory(pctx, name.toLowerCase(), size, atRoot);
            tree.cat[id] = c;
            stats.files++;
            stats.bytes += alloc;
            stats.cats[c] += alloc;
          }
        }
        if (next === 0) break;
        o += next;
      }
    };

    let child;
    try {
      child = spawn(exe, [startPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(false);
    }
    let buf: Buffer = Buffer.alloc(0);
    let ended = false;
    const pathTimer = setInterval(() => {
      if (stats.cancelled) child.kill();
      stats.path = tree.path(lastDir);
    }, 100);
    child.stdout!.on('data', (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let o = 0;
      while (o + 12 <= buf.length) {
        const dirId = buf.readUInt32LE(o);
        const first = buf.readUInt32LE(o + 4);
        const len = buf.readUInt32LE(o + 8);
        if (dirId === 0xffffffff) {
          ended = true;
          o += 12;
          break;
        }
        if (first === 0xffffffff) {
          const node = dirId < nodeOf.length ? nodeOf[dirId] : -1;
          if (node >= 0) tree.flags[node] |= F_ERR;
          stats.errors++;
          o += 12;
          continue;
        }
        if (o + 12 + len > buf.length) break;
        parseBlock(buf, o + 12, o + 12 + len, dirId, first);
        o += 12 + len;
      }
      buf = o < buf.length ? buf.subarray(o) : Buffer.alloc(0);
    });
    const done = (ok: boolean) => {
      clearInterval(pathTimer);
      resolve(ok);
    };
    child.on('error', () => done(false));
    child.on('close', () => done(ended && !stats.cancelled));
  });
}
