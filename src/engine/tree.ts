// Compact, mutable file tree stored as a struct of typed arrays.
// Millions of nodes fit in a few hundred MB, and every query walks plain
// integer links (first child / next sibling) instead of JS objects.
import { NF } from '../shared/types';

export const F_USED = NF.USED;
export const F_DIR = NF.DIR;
export const F_LINK = NF.LINK;
export const F_ERR = NF.ERR;
export const F_HIDDEN = NF.HIDDEN;
export const F_SYSTEM = NF.SYSTEM;
export const F_DEL = NF.DELETED;

export class Tree {
  cap = 0;
  n = 0;
  root = -1;

  parent = new Int32Array(0);
  first = new Int32Array(0);
  next = new Int32Array(0);
  flags = new Uint8Array(0);
  /** Category for files; dominant category for directories. */
  cat = new Uint8Array(0);
  /** Classification context for directories (see classify.ts). */
  ctx = new Uint8Array(0);
  size = new Float64Array(0);
  alloc = new Float64Array(0);
  mtime = new Uint32Array(0);
  atime = new Uint32Array(0);
  ctime = new Uint32Array(0);
  // Aggregates over the subtree (equal to own values for files).
  aSize = new Float64Array(0);
  aAlloc = new Float64Array(0);
  aFiles = new Uint32Array(0);
  aDirs = new Uint32Array(0);
  aLast = new Uint32Array(0);
  names: string[] = [];

  constructor(capacity = 1 << 16) {
    this.resize(capacity);
  }

  resize(cap: number) {
    type Arr = Int32Array | Uint8Array | Uint32Array | Float64Array;
    const grow = <A extends Arr>(old: A, fill?: number): A => {
      const a = new (old.constructor as new (n: number) => A)(cap);
      a.set((old.length > cap ? old.subarray(0, cap) : old) as never);
      if (fill !== undefined && cap > old.length) a.fill(fill, old.length);
      return a;
    };
    this.parent = grow(this.parent, -1);
    this.first = grow(this.first, -1);
    this.next = grow(this.next, -1);
    this.flags = grow(this.flags);
    this.cat = grow(this.cat);
    this.ctx = grow(this.ctx);
    this.size = grow(this.size);
    this.alloc = grow(this.alloc);
    this.mtime = grow(this.mtime);
    this.atime = grow(this.atime);
    this.ctime = grow(this.ctime);
    this.aSize = grow(this.aSize);
    this.aAlloc = grow(this.aAlloc);
    this.aFiles = grow(this.aFiles);
    this.aDirs = grow(this.aDirs);
    this.aLast = grow(this.aLast);
    this.cap = cap;
  }

  /** Drops spare capacity left by doubling (call once a scan is complete). */
  compact() {
    if (this.cap > this.n + 1024) this.resize(this.n + 1024);
  }

  /** Appends a node and links it as the first child of `parent`. */
  add(parent: number, name: string, flags: number): number {
    if (this.n >= this.cap) this.resize(Math.max(1024, this.cap * 2));
    const id = this.n++;
    this.parent[id] = parent;
    this.first[id] = -1;
    this.flags[id] = flags | F_USED;
    this.names[id] = name;
    if (parent >= 0) {
      this.next[id] = this.first[parent];
      this.first[parent] = id;
    } else {
      this.next[id] = -1;
    }
    return id;
  }

  /** Links an already-populated slot (used by the MFT reader). */
  link(id: number, parent: number) {
    this.parent[id] = parent;
    this.next[id] = this.first[parent];
    this.first[parent] = id;
  }

  isDir(id: number) {
    return (this.flags[id] & F_DIR) !== 0;
  }

  alive(id: number) {
    return id >= 0 && id < this.n && (this.flags[id] & (F_USED | F_DEL)) === F_USED;
  }

  path(id: number): string {
    const parts: string[] = [];
    for (let p = id; p >= 0; p = this.parent[p]) {
      parts.push(this.names[p]);
      if (p === this.root) break;
    }
    parts.reverse();
    let out = parts[0] ?? '';
    for (let i = 1; i < parts.length; i++) {
      out += out.endsWith('\\') || out.endsWith('/') ? parts[i] : '\\' + parts[i];
    }
    return out;
  }

  depthOf(id: number): number {
    let d = 0;
    for (let p = id; p >= 0 && p !== this.root; p = this.parent[p]) d++;
    return d;
  }

  childIds(id: number): number[] {
    const out: number[] = [];
    for (let c = this.first[id]; c !== -1; c = this.next[c]) out.push(c);
    return out;
  }

  /** Post-order aggregation of sizes, counts, last-used time and dominant category. */
  aggregate(from = this.root) {
    const { first, next, flags, aSize, aAlloc, aFiles, aDirs, aLast, size, alloc, cat } = this;
    const order = new Int32Array(Math.max(16, this.n));
    let k = 0;
    const stack: number[] = [from];
    while (stack.length) {
      const id = stack.pop()!;
      order[k++] = id;
      for (let c = first[id]; c !== -1; c = next[c]) stack.push(c);
    }
    for (let i = k - 1; i >= 0; i--) {
      const id = order[i];
      if (flags[id] & F_DIR) {
        let s = size[id];
        let a = alloc[id];
        let f = 0;
        let d = 0;
        let last = 0;
        let best = -1;
        let bestV = -1;
        for (let c = first[id]; c !== -1; c = next[c]) {
          s += aSize[c];
          a += aAlloc[c];
          f += aFiles[c];
          d += aDirs[c] + (flags[c] & F_DIR ? 1 : 0);
          if (aLast[c] > last) last = aLast[c];
          if (aAlloc[c] > bestV) {
            bestV = aAlloc[c];
            best = c;
          }
        }
        if (last === 0) last = Math.max(this.mtime[id], this.ctime[id]);
        aSize[id] = s;
        aAlloc[id] = a;
        aFiles[id] = f;
        aDirs[id] = d;
        aLast[id] = last;
        if (best >= 0 && bestV > 0) cat[id] = cat[best];
      } else {
        aSize[id] = size[id];
        aAlloc[id] = alloc[id];
        aFiles[id] = flags[id] & F_LINK ? 0 : 1;
        aDirs[id] = 0;
        const t = this.atime[id] > this.mtime[id] ? this.atime[id] : this.mtime[id];
        aLast[id] = t > this.ctime[id] ? t : this.ctime[id];
      }
    }
  }

  /** Unlinks a node from its parent and subtracts its aggregates from all ancestors. */
  remove(id: number) {
    if (!this.alive(id) || id === this.root) return;
    const p = this.parent[id];
    let prev = -1;
    let c = this.first[p];
    while (c !== -1 && c !== id) {
      prev = c;
      c = this.next[c];
    }
    if (c !== id) return;
    if (prev === -1) this.first[p] = this.next[id];
    else this.next[prev] = this.next[id];
    this.markDeleted(id);
    this.applyDelta(p, -this.aSize[id], -this.aAlloc[id], -this.aFiles[id], -(this.aDirs[id] + (this.isDir(id) ? 1 : 0)));
  }

  /** Marks a whole subtree as deleted. */
  markDeleted(id: number) {
    const stack = [id];
    while (stack.length) {
      const x = stack.pop()!;
      this.flags[x] |= F_DEL;
      for (let c = this.first[x]; c !== -1; c = this.next[c]) stack.push(c);
    }
  }

  /** Adds deltas to `from` and every ancestor, then refreshes their last-used times. */
  applyDelta(from: number, dSize: number, dAlloc: number, dFiles: number, dDirs: number) {
    for (let q = from; q >= 0; q = this.parent[q]) {
      this.aSize[q] = Math.max(0, this.aSize[q] + dSize);
      this.aAlloc[q] = Math.max(0, this.aAlloc[q] + dAlloc);
      this.aFiles[q] = Math.max(0, this.aFiles[q] + dFiles);
      this.aDirs[q] = Math.max(0, this.aDirs[q] + dDirs);
      let last = 0;
      for (let c = this.first[q]; c !== -1; c = this.next[c]) if (this.aLast[c] > last) last = this.aLast[c];
      this.aLast[q] = last;
      if (q === this.root) break;
    }
  }
}
