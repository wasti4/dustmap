// Self-test and benchmark for the MFT parser using a synthetic file table, so
// the turbo reader can be checked without administrator rights:
//   node dist-electron/cli.cjs --selftest
import { Tree } from './tree';
import { MftParser } from './mft';

const RS = 1024;
const align8 = (n: number) => (n + 7) & ~7;
const ft = (sec: number) => BigInt(Math.round((sec + 11644473600) * 1e7));

function resident(type: number, value: Buffer): Buffer {
  const len = align8(24 + value.length);
  const b = Buffer.alloc(len);
  b.writeUInt32LE(type, 0);
  b.writeUInt32LE(len, 4);
  b.writeUInt16LE(24, 10);
  b.writeUInt32LE(value.length, 16);
  b.writeUInt16LE(24, 20);
  value.copy(b, 24);
  return b;
}

function si(created: number, modified: number, accessed: number, attrs = 0x20): Buffer {
  const v = Buffer.alloc(72);
  v.writeBigUInt64LE(ft(created), 0);
  v.writeBigUInt64LE(ft(modified), 8);
  v.writeBigUInt64LE(ft(modified), 16);
  v.writeBigUInt64LE(ft(accessed), 24);
  v.writeUInt32LE(attrs, 32);
  return resident(0x10, v);
}

function fn(parent: number, name: string, ns = 3): Buffer {
  const nb = Buffer.from(name, 'utf16le');
  const v = Buffer.alloc(66 + nb.length);
  v.writeUInt32LE(parent, 0);
  v.writeUInt16LE(1, 6);
  v[64] = name.length;
  v[65] = ns;
  nb.copy(v, 66);
  return resident(0x30, v);
}

const dataResident = (n: number) => resident(0x80, Buffer.alloc(n, 0x41));

function dataNonResident(size: number, alloc: number, o: { flags?: number; compressed?: number; startVcn?: number; name?: string } = {}): Buffer {
  const hdr = o.compressed !== undefined ? 72 : 64;
  const nameBuf = o.name ? Buffer.from(o.name, 'utf16le') : Buffer.alloc(0);
  const runsOfs = align8(hdr + nameBuf.length);
  const runs = Buffer.from([0x11, 0x01, 0x10, 0x00]);
  const len = align8(runsOfs + runs.length);
  const b = Buffer.alloc(len);
  b.writeUInt32LE(0x80, 0);
  b.writeUInt32LE(len, 4);
  b[8] = 1;
  b[9] = o.name ? o.name.length : 0;
  b.writeUInt16LE(hdr, 10);
  b.writeUInt16LE(o.flags ?? 0, 12);
  b.writeBigUInt64LE(BigInt(o.startVcn ?? 0), 16);
  b.writeUInt16LE(runsOfs, 32);
  b.writeBigUInt64LE(BigInt(alloc), 40);
  b.writeBigUInt64LE(BigInt(size), 48);
  b.writeBigUInt64LE(BigInt(size), 56);
  if (o.compressed !== undefined) b.writeBigUInt64LE(BigInt(o.compressed), 64);
  nameBuf.copy(b, hdr);
  runs.copy(b, runsOfs);
  return b;
}

function record(attrs: Buffer[], o: { dir?: boolean; inUse?: boolean; base?: number; corrupt?: boolean } = {}): Buffer {
  const b = Buffer.alloc(RS);
  b.write('FILE', 0, 'latin1');
  const usaCount = RS / 512 + 1;
  b.writeUInt16LE(48, 4);
  b.writeUInt16LE(usaCount, 6);
  b.writeUInt16LE(1, 16);
  b.writeUInt16LE(1, 18);
  const first = align8(48 + usaCount * 2);
  b.writeUInt16LE(first, 20);
  b.writeUInt16LE((o.inUse === false ? 0 : 1) | (o.dir ? 2 : 0), 22);
  let p = first;
  for (const a of attrs) {
    a.copy(b, p);
    p += a.length;
  }
  b.writeUInt32LE(0xffffffff, p);
  p += 8;
  b.writeUInt32LE(p, 24);
  b.writeUInt32LE(RS, 28);
  b.writeUInt32LE(o.base ?? 0, 32);
  // Multi-sector protection: stash the last two bytes of every 512-byte block.
  const usn = 0x0007;
  b.writeUInt16LE(usn, 48);
  for (let i = 1; i < usaCount; i++) {
    const end = i * 512 - 2;
    b.writeUInt16LE(b.readUInt16LE(end), 48 + i * 2);
    b.writeUInt16LE(o.corrupt && i === 2 ? 0x0099 : usn, end);
  }
  return b;
}

function check(cond: boolean, msg: string) {
  if (!cond) throw new Error('MFT self-test failed: ' + msg);
}

export function runMftSelfTest(log: (s: string) => void = console.log) {
  const now = Math.floor(Date.now() / 1000);
  const old = now - 3 * 365 * 86400;
  const GiB = 2 ** 30;
  const recs: Buffer[] = Array.from({ length: 32 }, () => Buffer.alloc(RS));
  const S = () => si(old, old, old);
  recs[5] = record([S(), fn(5, '.')], { dir: true });
  recs[16] = record([S(), fn(5, 'Users')], { dir: true });
  recs[17] = record([S(), fn(16, 'Alex')], { dir: true });
  recs[18] = record([si(old, old, now - 3600), fn(17, 'photo.jpg'), dataNonResident(5_000_000, 5_001_216)]);
  recs[19] = record([S(), fn(17, 'small.txt'), dataResident(100)]);
  recs[20] = record([S(), fn(17, 'LONGNA~1.TXT', 2), fn(17, 'Long name document.txt', 1), dataResident(10)]);
  recs[21] = record([S(), fn(17, 'linked.bin', 1), fn(16, 'linked-copy.bin', 1), dataNonResident(4096, 4096)]);
  recs[22] = record([S(), fn(17, 'huge.vhdx')]);
  recs[23] = record([dataNonResident(GiB, GiB)], { base: 22 });
  recs[24] = record([S(), fn(17, 'deleted.tmp'), dataResident(5)], { inUse: false });
  recs[25] = record([S(), fn(17, 'sparse.db'), dataNonResident(10 * GiB, 10 * GiB, { flags: 0x8000, compressed: 65536 })]);
  recs[26] = record([S(), fn(999, 'orphan.txt'), dataResident(1)]);
  recs[27] = record([S(), fn(17, 'corrupt.bin'), dataResident(1)], { corrupt: true });
  recs[28] = record([S(), fn(17, 'streams.txt'), dataResident(50), dataNonResident(8192, 8192, { name: 'Zone' })]);
  recs[29] = record([si(old, old, old, 0x26), fn(16, 'hidden.sys'), dataNonResident(1000, 4096)]);

  const tree = new Tree(16);
  const parser = new MftParser(tree, recs.length, RS);
  parser.parseChunk(Buffer.concat(recs), 0, recs.length);
  const root = parser.link('X:\\');
  tree.aggregate(root);

  check(tree.path(18) === 'X:\\Users\\Alex\\photo.jpg', 'path of photo.jpg: ' + tree.path(18));
  check(tree.size[18] === 5_000_000 && tree.alloc[18] === 5_001_216, 'sizes of photo.jpg');
  check(tree.atime[18] === now - 3600 && tree.mtime[18] === old, 'timestamps of photo.jpg');
  check(tree.size[19] === 100 && tree.alloc[19] === 0, 'resident data');
  check(tree.names[20] === 'Long name document.txt', 'Win32 name preferred over DOS name');
  check(tree.parent[21] === 17, 'hard link counted once under its first name');
  check(tree.size[22] === GiB && tree.alloc[22] === GiB, 'data attribute from an extension record');
  check(!tree.alive(23), 'extension record is not a separate file');
  check(!tree.alive(24), 'unused record ignored');
  check(tree.size[25] === 10 * GiB && tree.alloc[25] === 65536, 'sparse file uses allocated clusters');
  check(!tree.alive(26), 'orphan ignored');
  check(!tree.alive(27), 'record with broken fixups ignored');
  check(tree.size[28] === 50 && tree.alloc[28] === 8192, 'named stream counts towards allocation only');
  check((tree.flags[29] & 16) !== 0 && (tree.flags[29] & 32) !== 0, 'hidden/system attributes');
  check(tree.aFiles[root] === 8 && tree.aDirs[root] === 2, `counts files=${tree.aFiles[root]} dirs=${tree.aDirs[root]}`);
  log('MFT parser self-test: all 15 checks passed');

  // Benchmark on a realistic-looking table.
  const N = 200_000;
  const templates: Buffer[] = [];
  for (let i = 0; i < 256; i++) {
    const name = `file_${(i * 7919) % 100000}_${['dll', 'jpg', 'txt', 'json', 'exe', 'png'][i % 6]}`;
    const attrs = [si(old + i, old + i, now - i), fn(16 + (i % 8), name)];
    attrs.push(i % 3 === 0 ? dataResident(200) : dataNonResident(10_000 + i * 997, 12_288 + i * 4096));
    templates.push(record(attrs, { dir: i % 10 === 0 }));
  }
  const tpl = Buffer.concat(templates);
  let best = Infinity;
  for (let round = 0; round < 3; round++) {
    const big = Buffer.allocUnsafeSlow(N * RS);
    for (let off = 0; off < big.length; off += tpl.length) tpl.copy(big, off, 0, Math.min(tpl.length, big.length - off));
    const t = new Tree(16);
    const p = new MftParser(t, N, RS);
    const t0 = performance.now();
    p.parseChunk(big, 0, N);
    best = Math.min(best, performance.now() - t0);
  }
  log(`MFT parser benchmark: ${N.toLocaleString('en')} records in ${best.toFixed(0)} ms (${Math.round(N / (best / 1000)).toLocaleString('en')} records/s)`);
}
