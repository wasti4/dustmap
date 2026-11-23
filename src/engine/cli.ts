// Command-line benchmark / smoke test for the scan engine.
//   npm run bench -- C:\ [--mft]
import { CATEGORIES } from '../shared/types';
import { runScan } from './scanner';
import * as Q from './query';
import { runMftSelfTest } from './mft-selftest';
import { runMacSelfTest } from './macos-selftest';
import { sep } from 'node:path';

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--')) ?? process.cwd();
const turbo = args.includes('--mft');
const gb = (n: number) => (n / 1024 ** 3).toFixed(2) + ' GB';

async function main() {
  const t0 = Date.now();
  let lastLog = 0;
  const s = await runScan(
    1,
    { root, turbo },
    (p) => {
      if (Date.now() - lastLog > 1000) {
        lastLog = Date.now();
        process.stderr.write(`  ${p.phase} files=${p.files} dirs=${p.dirs} ${gb(p.bytes)}\n`);
      }
    },
    { cancelled: false },
  );
  const sum = Q.summary(s, 'unknown');
  console.log(`\nScanned ${sum.root} in ${Date.now() - t0} ms using ${sum.mode}${s.turboNote ? ` (turbo: ${s.turboNote})` : ''}`);
  if (s.macBulkEntries !== undefined) console.log('macOS bulk metadata entries: ' + s.macBulkEntries);
  if (s.turboError) console.log(`turbo error: ${s.turboError}`);
  if (s.phases) console.log('phases (ms): ' + Object.entries(s.phases).map(([k, v]) => `${k}=${v}`).join(' '));
  console.log(`files=${sum.files} dirs=${sum.dirs} errors=${sum.errors} onDisk=${gb(sum.alloc)} size=${gb(sum.size)} volume used=${gb(sum.total - sum.free)}`);
  console.log('\nCategories:');
  sum.cats.forEach((c, i) => c.alloc > 0 && console.log(`  ${CATEGORIES[i].padEnd(10)} ${gb(c.alloc).padStart(12)}  ${c.count} files`));
  const page = Q.children(s, { id: s.rootId, metric: 'alloc', limit: 12 });
  console.log('\nLargest at root:');
  for (const n of page.items) console.log(`  ${gb(n.alloc).padStart(12)}  ${n.name}${n.dir ? sep : ''}`);

  let t = Date.now();
  const tm = Q.treemap(s, { id: s.rootId, w: 1200, h: 700, metric: 'alloc' });
  console.log(`\ntreemap: ${tm.rects.length / 9} rects in ${Date.now() - t} ms`);
  t = Date.now();
  const st = Q.stale(s, { days: 365, minSize: 50 * 1024 * 1024, mode: 'smart', cats: [], includeSystem: false, scopeId: s.rootId, limit: 200, metric: 'alloc' });
  console.log(`stale(1y, >=50MB): ${st.total} items, ${gb(st.bytes)} in ${Date.now() - t} ms`);
  for (const n of st.items.slice(0, 5)) console.log(`  ${gb(n.alloc).padStart(12)}  ${n.path}`);
  t = Date.now();
  const ft = Q.fileTypes(s, { scopeId: s.rootId, metric: 'alloc' });
  console.log(`fileTypes: ${ft.length} types in ${Date.now() - t} ms; top: ${ft.slice(0, 6).map((r) => `${r.ext || '(none)'} ${gb(r.alloc)}`).join(', ')}`);
  t = Date.now();
  const ins = Q.computeInsights(s);
  console.log(`insights in ${Date.now() - t} ms:`);
  for (const i of ins) console.log(`  ${i.kind.padEnd(13)} ${gb(i.bytes).padStart(12)}  ${i.count} items`);
  const mem = process.memoryUsage();
  console.log(`\nmemory: rss=${(mem.rss / 1048576).toFixed(0)} MB heap=${(mem.heapUsed / 1048576).toFixed(0)} MB arrays=${(mem.arrayBuffers / 1048576).toFixed(0)} MB`);
}

async function selfTest() {
  runMftSelfTest();
  await runMacSelfTest();
}

(args.includes('--selftest') ? selfTest() : main()).catch((e) => {
  console.error(e);
  process.exit(1);
});
