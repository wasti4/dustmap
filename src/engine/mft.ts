// Turbo scanner: reads the NTFS Master File Table straight from the volume.
// One sequential read of the MFT gives every
// file's name, parent, sizes and timestamps without touching directories.
// Requires administrator rights (opening \\.\C: for raw reading).
import fs from 'node:fs';
import { Tree, F_DIR, F_USED, F_HIDDEN, F_SYSTEM } from './tree';

export class MftUnavailable extends Error {
  constructor(
    public reason: 'not-admin' | 'not-ntfs' | 'failed',
    message?: string,
  ) {
    super(message ?? reason);
  }
}

interface Run {
  vcn: number;
  lcn: number; // -1 = sparse
  len: number;
}

const ROOT_RECORD = 5;
const BADCLUS_RECORD = 8;
const FILE_MAGIC = 0x454c4946; // "FILE"
const EPOCH_DIFF = 11644473600; // seconds between 1601-01-01 and 1970-01-01
const CHUNK = 8 * 1024 * 1024;

const u64 = (b: Buffer, o: number) => b.readUInt32LE(o) + b.readUInt32LE(o + 4) * 4294967296;
const u48 = (b: Buffer, o: number) => b.readUInt32LE(o) + b.readUInt16LE(o + 4) * 4294967296;

function ftToSec(b: Buffer, o: number): number {
  const s = b.readUInt32LE(o + 4) * 429.4967296 + b.readUInt32LE(o) / 1e7 - EPOCH_DIFF;
  return s > 0 && s < 4294967295 ? Math.floor(s) : 0;
}

/** Applies the update-sequence fixups of a multi-sector record. */
function fixup(b: Buffer, o: number, recordSize: number): boolean {
  const usaOfs = b.readUInt16LE(o + 4);
  const usaCount = b.readUInt16LE(o + 6);
  if (usaCount < 2 || usaOfs + usaCount * 2 > recordSize) return false;
  const stride = recordSize / (usaCount - 1);
  if (!Number.isInteger(stride) || stride < 256) return false;
  const usn = b.readUInt16LE(o + usaOfs);
  for (let i = 1; i < usaCount; i++) {
    const p = o + i * stride - 2;
    if (b.readUInt16LE(p) !== usn) return false;
    b.writeUInt16LE(b.readUInt16LE(o + usaOfs + i * 2), p);
  }
  return true;
}

function parseRuns(b: Buffer, p: number, end: number, startVcn: number): Run[] {
  const runs: Run[] = [];
  let lcn = 0;
  let vcn = startVcn;
  while (p < end) {
    const h = b[p++];
    if (h === 0) break;
    const ls = h & 0x0f;
    const os = h >> 4;
    if (ls === 0 || ls > 8 || os > 8 || p + ls + os > end) break;
    let len = 0;
    for (let i = ls - 1; i >= 0; i--) len = len * 256 + b[p + i];
    p += ls;
    if (os === 0) {
      runs.push({ vcn, lcn: -1, len });
    } else {
      let off = 0;
      for (let i = os - 1; i >= 0; i--) off = off * 256 + b[p + i];
      if (b[p + os - 1] & 0x80) off -= 2 ** (8 * os);
      lcn += off;
      runs.push({ vcn, lcn, len });
    }
    p += os;
    vcn += len;
  }
  return runs;
}

function findAttr(b: Buffer, o: number, recordSize: number, type: number, unnamedOnly: boolean): number {
  let a = o + b.readUInt16LE(o + 20);
  const end = o + Math.min(b.readUInt32LE(o + 24), recordSize);
  while (a + 16 <= end) {
    const t = b.readUInt32LE(a);
    if (t === 0xffffffff) break;
    const len = b.readUInt32LE(a + 4);
    if (len < 16 || a + len > end) break;
    if (t === type && (!unnamedOnly || b[a + 9] === 0)) return a;
    a += len;
  }
  return -1;
}

export interface MftResult {
  rootId: number;
  records: number;
}

export async function readMft(
  volume: string,
  tree: Tree,
  rootName: string,
  onProgress: (read: number, total: number, records: number) => void,
  isCancelled: () => boolean,
): Promise<MftResult> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open('\\\\.\\' + volume.slice(0, 2), 'r');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new MftUnavailable(code === 'EPERM' || code === 'EACCES' ? 'not-admin' : 'failed', (e as Error).message);
  }
  try {
    const boot = Buffer.alloc(4096);
    await fh.read(boot, 0, 4096, 0);
    if (boot.toString('latin1', 3, 11) !== 'NTFS    ') throw new MftUnavailable('not-ntfs');
    const bytesPerSector = boot.readUInt16LE(0x0b);
    const spcRaw = boot[0x0d];
    const sectorsPerCluster = spcRaw <= 0x80 ? spcRaw : 2 ** (256 - spcRaw);
    const clusterSize = bytesPerSector * sectorsPerCluster;
    const mftLcn = u64(boot, 0x30);
    const cpr = boot.readInt8(0x40);
    const recordSize = cpr > 0 ? cpr * clusterSize : 2 ** -cpr;
    if (!clusterSize || recordSize < 256 || recordSize > 65536 || bytesPerSector < 256) {
      throw new MftUnavailable('failed', 'unexpected boot sector geometry');
    }
    const align = Math.max(512, bytesPerSector);

    const readAt = async (offset: number, length: number): Promise<Buffer> => {
      const start = Math.floor(offset / align) * align;
      const end = Math.ceil((offset + length) / align) * align;
      const buf = Buffer.alloc(end - start);
      await fh.read(buf, 0, buf.length, start);
      return Buffer.from(buf.subarray(offset - start, offset - start + length));
    };

    // --- $MFT's own record tells where the table lives on disk. ---
    const rec0 = await readAt(mftLcn * clusterSize, recordSize);
    if (rec0.readUInt32LE(0) !== FILE_MAGIC || !fixup(rec0, 0, recordSize)) throw new MftUnavailable('failed', 'bad $MFT record');
    const da = findAttr(rec0, 0, recordSize, 0x80, true);
    if (da < 0 || !rec0[da + 8]) throw new MftUnavailable('failed', 'no $MFT data attribute');
    const mftBytes = u64(rec0, da + 48);
    const mftAllocClusters = Math.ceil(u64(rec0, da + 40) / clusterSize);
    const runs = parseRuns(rec0, da + rec0.readUInt16LE(da + 32), da + rec0.readUInt32LE(da + 4), u64(rec0, da + 16));
    const lastVcn = u64(rec0, da + 24);

    const vcnToOffset = (vcn: number): number => {
      for (const r of runs) if (vcn >= r.vcn && vcn < r.vcn + r.len && r.lcn >= 0) return (r.lcn + (vcn - r.vcn)) * clusterSize;
      return -1;
    };

    if (lastVcn + 1 < mftAllocClusters) {
      // Heavily fragmented MFT: the rest of its run list lives in extension records.
      const al = findAttr(rec0, 0, recordSize, 0x20, false);
      if (al >= 0) {
        let list: Buffer;
        if (!rec0[al + 8]) {
          const vo = al + rec0.readUInt16LE(al + 20);
          list = rec0.subarray(vo, vo + rec0.readUInt32LE(al + 16));
        } else {
          const lr = parseRuns(rec0, al + rec0.readUInt16LE(al + 32), al + rec0.readUInt32LE(al + 4), 0);
          const size = u64(rec0, al + 48);
          list = Buffer.alloc(size);
          let pos = 0;
          for (const r of lr) {
            if (r.lcn < 0 || pos >= size) continue;
            const chunk = await readAt(r.lcn * clusterSize, r.len * clusterSize);
            chunk.copy(list, pos, 0, Math.min(chunk.length, size - pos));
            pos += chunk.length;
          }
        }
        const seen = new Set<number>();
        for (let p = 0; p + 26 <= list.length; ) {
          const t = list.readUInt32LE(p);
          const rl = list.readUInt16LE(p + 4);
          if (rl < 26) break;
          const ref = u48(list, p + 16);
          if (t === 0x80 && list[p + 6] === 0 && ref !== 0 && !seen.has(ref)) {
            seen.add(ref);
            const byteOff = ref * recordSize;
            const base = vcnToOffset(Math.floor(byteOff / clusterSize));
            if (base >= 0) {
              const rb = await readAt(base + (byteOff % clusterSize), recordSize);
              if (rb.readUInt32LE(0) === FILE_MAGIC && fixup(rb, 0, recordSize)) {
                const xa = findAttr(rb, 0, recordSize, 0x80, true);
                if (xa >= 0 && rb[xa + 8]) runs.push(...parseRuns(rb, xa + rb.readUInt16LE(xa + 32), xa + rb.readUInt32LE(xa + 4), u64(rb, xa + 16)));
              }
            }
          }
          p += rl;
        }
        runs.sort((a, b) => a.vcn - b.vcn);
      }
    }

    // --- Read the whole table sequentially, double-buffered. ---
    const total = Math.floor(mftBytes / recordSize);
    if (total < 16) throw new MftUnavailable('failed', 'MFT too small');
    const parser = new MftParser(tree, total, recordSize);

    const reads: { pos: number; len: number }[] = [];
    let planned = 0;
    for (const r of runs) {
      const bytes = r.len * clusterSize;
      for (let off = 0; off < bytes && planned < mftBytes; ) {
        const len = Math.min(CHUNK, bytes - off);
        reads.push({ pos: r.lcn < 0 ? -1 : r.lcn * clusterSize + off, len });
        off += len;
        planned += len;
      }
    }
    const doRead = async (i: number): Promise<Buffer> => {
      const rd = reads[i];
      const b = Buffer.allocUnsafeSlow(rd.len);
      if (rd.pos < 0) b.fill(0);
      else await fh.read(b, 0, rd.len, rd.pos);
      return b;
    };

    let rec = 0;
    let readBytes = 0;
    let carry: Buffer | null = null;
    let pending: Promise<Buffer> | null = reads.length ? doRead(0) : null;
    for (let i = 0; i < reads.length && rec < total; i++) {
      const chunk: Buffer = await pending!;
      pending = i + 1 < reads.length ? doRead(i + 1) : null;
      const data: Buffer = carry && carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const n = Math.min(Math.floor(data.length / recordSize), total - rec);
      parser.parseChunk(data, rec, n);
      rec += n;
      carry = data.length > n * recordSize ? Buffer.from(data.subarray(n * recordSize)) : null;
      readBytes += chunk.length;
      onProgress(Math.min(readBytes, mftBytes), mftBytes, rec);
      if (isCancelled()) {
        if (pending) await pending.catch(() => undefined);
        throw new Error('cancelled');
      }
    }
    return { rootId: parser.link(rootName), records: total };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

const r16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const r32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const r64 = (b: Uint8Array, o: number) => r32(b, o) + r32(b, o + 4) * 4294967296;
const rft = (b: Uint8Array, o: number) => {
  const s = r32(b, o + 4) * 429.4967296 + r32(b, o) / 1e7 - EPOCH_DIFF;
  return s > 0 && s < 4294967295 ? Math.floor(s) : 0;
};

/**
 * Parses FILE records into a Tree whose node ids are MFT record numbers.
 * Kept separate from the I/O so it can be unit-tested and benchmarked with a
 * synthetic table (see mft-selftest.ts) without administrator rights.
 */
export class MftParser {
  readonly parentRef: Uint32Array;
  readonly nameRank: Uint8Array;

  constructor(
    readonly tree: Tree,
    readonly total: number,
    readonly recordSize: number,
  ) {
    tree.resize(total + 4096);
    tree.n = total;
    tree.names = new Array<string>(total);
    this.parentRef = new Uint32Array(total);
    this.nameRank = new Uint8Array(total);
  }

  parseChunk(b: Buffer, firstRec: number, count: number) {
    const rs = this.recordSize;
    for (let k = 0; k < count; k++) this.parseRecord(b, k * rs, firstRec + k);
  }

  parseRecord(b: Buffer, o: number, rec: number) {
    if (r32(b, o) !== FILE_MAGIC) return;
    const hdrFlags = r16(b, o + 22);
    if (!(hdrFlags & 1)) return;
    const rs = this.recordSize;
    // Update sequence fixups (inlined: this is the hot path).
    const usaOfs = r16(b, o + 4);
    const usaCount = r16(b, o + 6);
    if (usaCount < 2 || usaOfs + usaCount * 2 > rs) return;
    const stride = rs / (usaCount - 1);
    const usn0 = b[o + usaOfs];
    const usn1 = b[o + usaOfs + 1];
    for (let i = 1; i < usaCount; i++) {
      const p = o + i * stride - 2;
      if (b[p] !== usn0 || b[p + 1] !== usn1) return;
      b[p] = b[o + usaOfs + i * 2];
      b[p + 1] = b[o + usaOfs + i * 2 + 1];
    }
    const baseRef = r32(b, o + 32) + r16(b, o + 36) * 4294967296;
    const target = baseRef !== 0 ? baseRef : rec;
    if (target >= this.total) return;
    const { flags, size, alloc, mtime, atime, ctime, names } = this.tree;
    if (baseRef === 0) flags[target] |= F_USED | (hdrFlags & 2 ? F_DIR : 0);
    let a = o + r16(b, o + 20);
    const used = r32(b, o + 24);
    const end = o + (used < rs ? used : rs);
    while (a + 16 <= end) {
      const type = r32(b, a);
      if (type === 0xffffffff) break;
      const len = r32(b, a + 4);
      if (len < 16 || a + len > end) break;
      const nonRes = b[a + 8];
      if (type === 0x30) {
        if (!nonRes) {
          const v = a + r16(b, a + 20);
          const ns = b[v + 65];
          const rank = ns === 2 ? 1 : ns === 0 ? 2 : 3; // prefer Win32 names over POSIX over DOS 8.3
          if (rank > this.nameRank[target]) {
            this.nameRank[target] = rank;
            names[target] = b.toString('utf16le', v + 66, v + 66 + b[v + 64] * 2);
            this.parentRef[target] = r32(b, v); // low 32 bits of the 48-bit record number
          }
        }
      } else if (type === 0x10) {
        if (!nonRes) {
          const v = a + r16(b, a + 20);
          ctime[target] = rft(b, v);
          mtime[target] = rft(b, v + 8);
          atime[target] = rft(b, v + 24);
          const fa = b[v + 32];
          if (fa & 2) flags[target] |= F_HIDDEN;
          if (fa & 4) flags[target] |= F_SYSTEM;
        }
      } else if (type === 0x80) {
        if (nonRes) {
          if (r32(b, a + 16) === 0 && r32(b, a + 20) === 0) {
            const attrFlags = r16(b, a + 12);
            let onDisk = r64(b, a + 40);
            if (attrFlags & 0x8001 && r16(b, a + 32) >= 72) onDisk = r64(b, a + 64); // compressed / sparse
            if (b[a + 9] === 0) size[target] += r64(b, a + 48);
            if (target !== BADCLUS_RECORD) alloc[target] += onDisk;
          }
        } else if (b[a + 9] === 0) {
          size[target] += r32(b, a + 16);
        }
      } else if (type === 0xa0 && nonRes && r32(b, a + 16) === 0 && r32(b, a + 20) === 0) {
        alloc[target] += r64(b, a + 40); // directory index blocks
      }
      a += len;
    }
  }

  /** Links named, in-use records to their parents. Returns the root id. */
  link(rootName: string): number {
    const tree = this.tree;
    const { flags, names } = tree;
    tree.root = ROOT_RECORD;
    names[ROOT_RECORD] = rootName;
    flags[ROOT_RECORD] |= F_USED | F_DIR;
    tree.parent[ROOT_RECORD] = -1;
    for (let r = 0; r < this.total; r++) {
      if (r === ROOT_RECORD || !(flags[r] & F_USED)) continue;
      const p = this.parentRef[r];
      if (!this.nameRank[r] || p >= this.total || p === r || !(flags[p] & F_USED) || !(flags[p] & F_DIR)) {
        flags[r] = 0;
        continue;
      }
      tree.link(r, p);
    }
    return ROOT_RECORD;
  }
}
