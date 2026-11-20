// Engine host. Runs inside an Electron utility process (its own OS process,
// with a large libuv thread pool) and answers requests from the main process.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import type { InsightKind, ScanRequest, ScanSummary } from '../shared/types';
import { runScan, volumeSpace, walkSubtree, type ScanState } from './scanner';
import * as Q from './query';

interface Port {
  on(ev: 'message', cb: (e: { data: { id: number; method: string; params: unknown } }) => void): void;
  postMessage(m: unknown): void;
}
const port = (process as unknown as { parentPort?: Port }).parentPort;

let scan: ScanState | null = null;
let ctl: { cancelled: boolean } | null = null;
let seq = 0;
let accessTracking: ScanSummary['accessTracking'] = 'unknown';

execFile(
  'reg',
  ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'NtfsDisableLastAccessUpdate'],
  { windowsHide: true, timeout: 5000 },
  (err, out) => {
    const m = /0x([0-9a-f]+)/i.exec(out ?? '');
    if (!err && m) accessTracking = parseInt(m[1], 16) & 1 ? 'off' : 'on';
  },
);

const post = (m: unknown) => port?.postMessage(m);

function need(): ScanState {
  if (!scan) throw new Error('no scan');
  return scan;
}

async function sum(s: ScanState): Promise<ScanSummary> {
  const sp = await volumeSpace(s.root);
  if (sp.total) s.free = sp.free;
  return Q.summary(s, accessTracking);
}

/** Re-reads one node from disk (after a cleanup) and patches the tree. */
async function refreshNode(s: ScanState, id: number) {
  const t = s.tree;
  if (!t.alive(id)) return;
  const p = t.path(id);
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(p);
  } catch {
    t.remove(id);
    return;
  }
  const old = { s: t.aSize[id], a: t.aAlloc[id], f: t.aFiles[id], d: t.aDirs[id] };
  if (!t.isDir(id)) {
    t.size[id] = st.size;
    t.alloc[id] = st.blocks * 512 || 0;
    t.aSize[id] = t.size[id];
    t.aAlloc[id] = t.alloc[id];
  } else {
    for (let c = t.first[id]; c !== -1; c = t.next[c]) t.markDeleted(c);
    t.first[id] = -1;
    await walkSubtree(t, id, p, s.baseDepth + t.depthOf(id));
    t.aggregate(id);
  }
  const parent = t.parent[id];
  if (parent >= 0) t.applyDelta(parent, t.aSize[id] - old.s, t.aAlloc[id] - old.a, t.aFiles[id] - old.f, t.aDirs[id] - old.d);
}

const handlers: Record<string, (p: never) => unknown> = {
  scan(p: ScanRequest) {
    const id = ++seq;
    if (ctl) ctl.cancelled = true;
    const c = { cancelled: false };
    ctl = c;
    runScan(id, p, (data) => post({ type: 'progress', data }), c)
      .then((st) => {
        if (c.cancelled) return;
        // Give memory back: trim array capacity, drop the previous scan, collect garbage.
        st.tree.compact();
        scan = null;
        (globalThis as { gc?: () => void }).gc?.();
        scan = st;
        if (ctl === c) ctl = null;
        post({ type: 'done', data: Q.summary(st, accessTracking) });
      })
      .catch((e: unknown) => {
        if (ctl === c) ctl = null;
        post({ type: 'error', data: { scanId: id, message: c.cancelled ? 'cancelled' : String((e as Error)?.message ?? e) } });
      });
    return { scanId: id };
  },
  cancel() {
    if (ctl) ctl.cancelled = true;
    return true;
  },
  summary: () => sum(need()),
  children: (p: Parameters<typeof Q.children>[1]) => Q.children(need(), p),
  detail: (p: { id: number }) => Q.detail(need(), p.id),
  treemap: (p: Parameters<typeof Q.treemap>[1]) => Q.treemap(need(), p),
  topFiles: (p: Parameters<typeof Q.topFiles>[1]) => Q.topFiles(need(), p),
  search: (p: Parameters<typeof Q.search>[1]) => Q.search(need(), p),
  stale: (p: Parameters<typeof Q.stale>[1]) => Q.stale(need(), p),
  fileTypes: (p: Parameters<typeof Q.fileTypes>[1]) => Q.fileTypes(need(), p),
  insights() {
    const s = need();
    s.insights ??= Q.computeInsights(s);
    return s.insights;
  },
  insightItems: (p: { kind: InsightKind }) => Q.insightItems(need(), p.kind),
  paths: (p: { ids: number[] }) => p.ids.map((id) => (need().tree.alive(id) ? need().tree.path(id) : null)),
  async removed(p: { ids: number[] }) {
    const s = need();
    for (const id of p.ids) s.tree.remove(id);
    s.insights = null;
    return sum(s);
  },
  async refresh(p: { ids: number[] }) {
    const s = need();
    for (const id of p.ids) await refreshNode(s, id);
    s.insights = null;
    return sum(s);
  },
  ping: () => 'pong',
};

port?.on('message', async (e) => {
  const { id, method, params } = e.data;
  try {
    const fn = handlers[method];
    if (!fn) throw new Error('unknown method ' + method);
    const result = await fn(params as never);
    post({ id, result });
  } catch (err) {
    post({ id, error: String((err as Error)?.message ?? err) });
  }
});
