// Read-side of the engine: paged children, treemap layout, top files, search,
// "forgotten files", file types and cleanup insights.
import {
  CAT_COUNT,
  Cat,
  TM_STRIDE,
  type CatTotal,
  type ChildrenPage,
  type Crumb,
  type FileTypeRow,
  type Insight,
  type InsightKind,
  type ListQuery,
  type ListResult,
  type Metric,
  type NodeDetail,
  type NodeInfo,
  type ScanSummary,
  type SortKey,
  type StaleQuery,
  type TreemapResult,
} from '../shared/types';
import { Tree, F_DIR, F_LINK } from './tree';
import { CTX_DL, CTX_TEMP, ctxCat, extOf, INSTALLER_EXTS } from './classify';
import type { ScanState } from './scanner';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DAY = 86400;

const values = (t: Tree, metric: Metric) => (metric === 'size' ? t.aSize : t.aAlloc);

export function nodeInfo(t: Tree, id: number, withPath = false): NodeInfo {
  const f = t.flags[id];
  const n: NodeInfo = {
    id,
    name: t.names[id],
    dir: (f & F_DIR) !== 0,
    size: t.aSize[id],
    alloc: t.aAlloc[id],
    files: t.aFiles[id],
    dirs: t.aDirs[id],
    mtime: t.mtime[id],
    atime: t.atime[id],
    ctime: t.ctime[id],
    last: t.aLast[id],
    cat: t.cat[id],
    flags: f,
    hasKids: t.first[id] !== -1,
  };
  if (withPath) n.path = t.path(id);
  return n;
}

/** Keeps the K largest values seen. */
class TopK {
  ids: number[] = [];
  vals: number[] = [];
  total = 0;
  bytes = 0;
  constructor(private k: number) {}
  offer(id: number, v: number) {
    this.total++;
    this.bytes += v;
    const { ids, vals } = this;
    if (ids.length < this.k) {
      ids.push(id);
      vals.push(v);
      let i = ids.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (vals[p] <= vals[i]) break;
        this.swap(i, p);
        i = p;
      }
    } else if (this.k > 0 && v > vals[0]) {
      ids[0] = id;
      vals[0] = v;
      let i = 0;
      const n = ids.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < n && vals[l] < vals[m]) m = l;
        if (r < n && vals[r] < vals[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
  }
  private swap(a: number, b: number) {
    const { ids, vals } = this;
    [ids[a], ids[b]] = [ids[b], ids[a]];
    [vals[a], vals[b]] = [vals[b], vals[a]];
  }
  sorted(): number[] {
    const idx = this.ids.map((_, i) => i).sort((a, b) => this.vals[b] - this.vals[a]);
    return idx.map((i) => this.ids[i]);
  }
}

export function categoryTotals(t: Tree, from: number): CatTotal[] {
  const cats: CatTotal[] = Array.from({ length: CAT_COUNT }, () => ({ alloc: 0, size: 0, count: 0 }));
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    const f = t.flags[id];
    if (f & F_DIR) {
      if (t.alloc[id] > 0) cats[t.cat[id]].alloc += t.alloc[id];
      for (let c = t.first[id]; c !== -1; c = t.next[c]) stack.push(c);
    } else if (!(f & F_LINK)) {
      const c = cats[t.cat[id]];
      c.alloc += t.alloc[id];
      c.size += t.size[id];
      c.count++;
    }
  }
  return cats;
}

export function summary(s: ScanState, accessTracking: ScanSummary['accessTracking']): ScanSummary {
  const t = s.tree;
  return {
    scanId: s.id,
    root: s.root,
    rootId: s.rootId,
    isVolume: s.isVolume,
    mode: s.mode,
    turboNote: s.turboNote,
    ms: s.ms,
    files: t.aFiles[s.rootId],
    dirs: t.aDirs[s.rootId],
    alloc: t.aAlloc[s.rootId],
    size: t.aSize[s.rootId],
    errors: s.errors,
    total: s.total,
    free: s.free,
    cats: categoryTotals(t, s.rootId),
    accessTracking,
    scannedAt: s.scannedAt,
  };
}

export function children(
  s: ScanState,
  p: { id: number; sort?: SortKey; desc?: boolean; metric: Metric; offset?: number; limit?: number },
): ChildrenPage {
  const t = s.tree;
  const val = values(t, p.metric);
  const ids = t.alive(p.id) ? t.childIds(p.id) : [];
  const sort = p.sort ?? 'value';
  const dir = (p.desc ?? sort !== 'name') ? -1 : 1;
  const key: Record<SortKey, (a: number, b: number) => number> = {
    value: (a, b) => val[a] - val[b],
    name: (a, b) => t.names[a].localeCompare(t.names[b], undefined, { numeric: true, sensitivity: 'base' }),
    files: (a, b) => t.aFiles[a] - t.aFiles[b] || val[a] - val[b],
    mtime: (a, b) => t.mtime[a] - t.mtime[b],
    last: (a, b) => t.aLast[a] - t.aLast[b],
  };
  const cmp = key[sort];
  ids.sort((a, b) => dir * cmp(a, b));
  const offset = p.offset ?? 0;
  const limit = p.limit ?? 300;
  const page = ids.slice(offset, offset + limit);
  let rest = 0;
  for (let i = offset + limit; i < ids.length; i++) rest += val[ids[i]];
  return { id: p.id, items: page.map((id) => nodeInfo(t, id)), total: ids.length, restValue: rest };
}

export function detail(s: ScanState, id: number): NodeDetail | null {
  const t = s.tree;
  if (!t.alive(id)) return null;
  const crumbs: Crumb[] = [];
  for (let q = id; q >= 0; q = t.parent[q]) {
    crumbs.push({ id: q, name: t.names[q] });
    if (q === s.rootId) break;
  }
  crumbs.reverse();
  const cats = categoryTotals(t, id).map((c) => c.alloc);
  return { ...nodeInfo(t, id), path: t.path(id), crumbs, catBreakdown: cats };
}

/** Squarified treemap (Bruls, Huizing, van Wijk) of a list sorted by value desc. */
function squarify(ids: number[], vals: number[], x: number, y: number, w: number, h: number, emit: (id: number, x: number, y: number, w: number, h: number) => void) {
  let total = 0;
  for (const v of vals) total += v;
  if (total <= 0 || w <= 0 || h <= 0) return;
  const scale = (w * h) / total;
  let i = 0;
  while (i < ids.length && w > 0.5 && h > 0.5) {
    const side = Math.min(w, h);
    const side2 = side * side;
    let sum = 0;
    let min = Infinity;
    let max = 0;
    let best = Infinity;
    let j = i;
    while (j < ids.length) {
      const a = vals[j] * scale;
      const nSum = sum + a;
      const nMin = Math.min(min, a);
      const nMax = Math.max(max, a);
      const s2 = nSum * nSum;
      const worst = Math.max((side2 * nMax) / s2, s2 / (side2 * nMin));
      if (j > i && worst > best) break;
      best = worst;
      sum = nSum;
      min = nMin;
      max = nMax;
      j++;
    }
    if (w >= h) {
      const rw = sum / h;
      let cy = y;
      for (let k = i; k < j; k++) {
        const rh = (vals[k] * scale) / rw;
        emit(ids[k], x, cy, rw, rh);
        cy += rh;
      }
      x += rw;
      w -= rw;
    } else {
      const rh = sum / w;
      let cx = x;
      for (let k = i; k < j; k++) {
        const cw = (vals[k] * scale) / rh;
        emit(ids[k], cx, y, cw, rh);
        cx += cw;
      }
      y += rh;
      h -= rh;
    }
    i = j;
  }
}

export function treemap(s: ScanState, p: { id: number; w: number; h: number; metric: Metric; maxRects?: number }): TreemapResult {
  const t = s.tree;
  const val = values(t, p.metric);
  const max = p.maxRects ?? 6000;
  const out: number[] = [];
  const names: string[] = [];
  const q: number[] = [p.id, 0, 0, p.w, p.h, 0];
  const HEADER = 18;
  const PAD = 2;
  for (let qi = 0; qi < q.length && out.length / TM_STRIDE < max; qi += 6) {
    const [id, x, y, w, h, d] = q.slice(qi, qi + 6);
    if (!t.alive(id)) continue;
    const kids: number[] = [];
    for (let c = t.first[id]; c !== -1; c = t.next[c]) if (val[c] > 0) kids.push(c);
    if (!kids.length) continue;
    kids.sort((a, b) => val[b] - val[a]);
    let rx = x;
    let ry = y;
    let rw = w;
    let rh = h;
    if (d > 0) {
      const label = w >= 64 && h >= 40;
      rx += PAD;
      rw -= PAD * 2;
      ry += label ? HEADER : PAD;
      rh -= (label ? HEADER : PAD) + PAD;
    }
    if (rw < 3 || rh < 3) continue;
    squarify(
      kids,
      kids.map((k) => val[k]),
      rx,
      ry,
      rw,
      rh,
      (cid, cx, cy, cw, ch) => {
        if (cw < 1.2 || ch < 1.2) return;
        const isDir = (t.flags[cid] & F_DIR) !== 0;
        const label = isDir && cw >= 64 && ch >= 40;
        out.push(cx, cy, cw, ch, cid, t.cat[cid], d + 1, (isDir ? 1 : 0) | (label ? 2 : 0), val[cid]);
        names.push(t.names[cid]);
        if (isDir && cw >= 8 && ch >= 8) q.push(cid, cx, cy, cw, ch, d + 1);
      },
    );
  }
  return { id: p.id, rects: Float64Array.from(out), names };
}

function matcher(query?: string): ((lower: string) => boolean) | null {
  const qn = (query ?? '').trim().toLowerCase();
  if (!qn) return null;
  if (qn.includes('*') || qn.includes('?')) {
    const re = new RegExp('^' + qn.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    return (n) => re.test(n);
  }
  return (n) => n.includes(qn);
}

export function topFiles(s: ScanState, q: ListQuery): ListResult {
  const t = s.tree;
  const val = values(t, q.metric);
  const cats = q.cats?.length ? new Set(q.cats) : null;
  const match = matcher(q.query);
  const top = new TopK(q.limit);
  const min = q.minSize ?? 0;
  const stack = [q.scopeId];
  while (stack.length) {
    const id = stack.pop()!;
    for (let c = t.first[id]; c !== -1; c = t.next[c]) {
      const f = t.flags[c];
      if (f & F_LINK) continue;
      if (f & F_DIR) {
        if (val[c] >= min) stack.push(c);
        continue;
      }
      if (val[c] < min) continue;
      if (cats && !cats.has(t.cat[c])) continue;
      if (match && !match(t.names[c].toLowerCase())) continue;
      top.offer(c, val[c]);
    }
  }
  return { items: top.sorted().map((id) => nodeInfo(t, id, true)), total: top.total, bytes: top.bytes };
}

export function search(s: ScanState, q: ListQuery): ListResult {
  const t = s.tree;
  const val = values(t, q.metric);
  const match = matcher(q.query);
  const top = new TopK(q.limit);
  if (!match) return { items: [], total: 0, bytes: 0 };
  const stack = [q.scopeId];
  while (stack.length) {
    const id = stack.pop()!;
    for (let c = t.first[id]; c !== -1; c = t.next[c]) {
      if (match(t.names[c].toLowerCase())) top.offer(c, val[c]);
      if (t.flags[c] & F_DIR) stack.push(c);
    }
  }
  return { items: top.sorted().map((id) => nodeInfo(t, id, true)), total: top.total, bytes: top.bytes };
}

/** Contexts that are managed by Windows or installers and never "forgotten". */
const MANAGED = new Set<number>([Cat.system, Cat.apps, Cat.trash, Cat.caches]);

export function stale(s: ScanState, q: StaleQuery): ListResult {
  const t = s.tree;
  const val = values(t, q.metric);
  const cutoff = Date.now() / 1000 - q.days * DAY;
  const cats = q.cats.length ? new Set(q.cats) : null;
  const top = new TopK(q.limit);
  const stack = [q.scopeId];
  while (stack.length) {
    const id = stack.pop()!;
    for (let c = t.first[id]; c !== -1; c = t.next[c]) {
      const f = t.flags[c];
      if (f & F_LINK) continue;
      const v = val[c];
      if (v < q.minSize || v <= 0) continue;
      const isDir = (f & F_DIR) !== 0;
      if (!q.includeSystem && MANAGED.has(isDir ? ctxCat(t.ctx[c]) : t.cat[c])) continue;
      const last = t.aLast[c];
      const old = last > 0 && last < cutoff;
      const catOk = !cats || cats.has(t.cat[c]);
      if (q.mode === 'smart' && old && catOk) {
        top.offer(c, v);
      } else if (isDir) {
        stack.push(c);
      } else if (q.mode === 'files' && old && catOk) {
        top.offer(c, v);
      }
    }
  }
  return { items: top.sorted().map((id) => nodeInfo(t, id, true)), total: top.total, bytes: top.bytes };
}

export function fileTypes(s: ScanState, p: { scopeId: number; metric: Metric; limit?: number }): FileTypeRow[] {
  const t = s.tree;
  const map = new Map<string, FileTypeRow>();
  const stack = [p.scopeId];
  while (stack.length) {
    const id = stack.pop()!;
    for (let c = t.first[id]; c !== -1; c = t.next[c]) {
      const f = t.flags[c];
      if (f & F_DIR) {
        stack.push(c);
        continue;
      }
      if (f & F_LINK) continue;
      const ext = extOf(t.names[c].toLowerCase());
      let row = map.get(ext);
      if (!row) {
        row = { ext, cat: t.cat[c], size: 0, alloc: 0, count: 0 };
        map.set(ext, row);
      }
      row.size += t.size[c];
      row.alloc += t.alloc[c];
      row.count++;
    }
  }
  const key = p.metric === 'size' ? 'size' : 'alloc';
  return [...map.values()].sort((a, b) => b[key] - a[key]).slice(0, p.limit ?? 400);
}

// ---------------------------------------------------------------- insights

const REBUILDABLE: Record<string, (sib: string[]) => boolean> = {
  node_modules: (s) => s.includes('package.json'),
  '.next': (s) => s.includes('package.json'),
  '.nuxt': (s) => s.includes('package.json'),
  '.svelte-kit': (s) => s.includes('package.json'),
  '.turbo': (s) => s.includes('package.json'),
  '.parcel-cache': (s) => s.includes('package.json'),
  '.angular': (s) => s.includes('package.json'),
  '.gradle': (s) => s.some((n) => n.startsWith('build.gradle') || n.startsWith('settings.gradle') || n === 'gradlew'),
  target: (s) => s.includes('cargo.toml'),
  bin: (s) => s.some((n) => /\.(cs|fs|vb)proj$/.test(n)),
  obj: (s) => s.some((n) => /\.(cs|fs|vb)proj$/.test(n)),
  build: (s) => s.some((n) => n.startsWith('build.gradle') || n === 'cmakelists.txt'),
};

const ACTION_ORDER: InsightKind[] = ['trash', 'caches', 'temp', 'devJunk', 'installers', 'oldDownloads', 'largeOld', 'windowsOld', 'hibernation'];

export function computeInsights(s: ScanState): Insight[] {
  const t = s.tree;
  const now = Date.now() / 1000;
  const mk = (kind: InsightKind, action: Insight['action'], deleteMode: Insight['deleteMode']): Insight => ({ kind, bytes: 0, count: 0, ids: [], action, deleteMode });
  const I: Record<InsightKind, Insight> = {
    trash: mk('trash', 'emptyTrash', 'permanent'),
    caches: mk('caches', 'review', 'contents'),
    temp: mk('temp', 'review', 'contents'),
    devJunk: mk('devJunk', 'review', 'permanent'),
    installers: mk('installers', 'review', 'trash'),
    oldDownloads: mk('oldDownloads', 'review', 'trash'),
    largeOld: mk('largeOld', 'review', 'trash'),
    windowsOld: mk('windowsOld', 'diskCleanup', 'permanent'),
    hibernation: mk('hibernation', 'info', 'permanent'),
  };
  const add = (ins: Insight, id: number) => {
    ins.ids.push(id);
    ins.bytes += t.aAlloc[id];
  };
  const lowerKids = (id: number) => t.childIds(id).map((c) => t.names[c].toLowerCase());

  const mac = s.mac;
  if (mac && s.root === mac.trashPath && t.aAlloc[s.rootId] > 0) add(I.trash, s.rootId);

  const scanDownloads = (dl: number) => {
    for (let c = t.first[dl]; c !== -1; c = t.next[c]) {
      if (t.flags[c] & F_LINK) continue;
      const lower = t.names[c].toLowerCase();
      const last = t.aLast[c];
      const isDir = (t.flags[c] & F_DIR) !== 0;
      if (!isDir && INSTALLER_EXTS.has(extOf(lower)) && last > 0 && last < now - 14 * DAY) add(I.installers, c);
      else if (last > 0 && last < now - 90 * DAY && t.aAlloc[c] >= MB) add(I.oldDownloads, c);
    }
  };

  const stack: number[] = [s.rootId, s.baseDepth];
  while (stack.length) {
    const depth = stack.pop()!;
    const id = stack.pop()!;
    const pctx = t.ctx[id];
    const pcat = ctxCat(pctx);
    let siblings: string[] | null = null;
    for (let c = t.first[id]; c !== -1; c = t.next[c]) {
      const f = t.flags[c];
      if (f & F_LINK) continue;
      const lower = t.names[c].toLowerCase();
      const v = t.aAlloc[c];
      const cd = depth + 1;
      if (f & F_DIR) {
        const cctx = t.ctx[c];
        const ccat = ctxCat(cctx);
        if (mac && ccat === Cat.trash) {
          const full = t.path(c);
          if (full === mac.trashPath && v > 0) add(I.trash, c);
          else if (mac.trashPath.startsWith(full + '/')) stack.push(c, cd);
          continue;
        }
        if (!mac && cd === 1 && ccat === Cat.trash) {
          if (v > 0) add(I.trash, c);
          continue;
        }
        if (!mac && cd === 1 && lower === 'windows.old') {
          add(I.windowsOld, c);
          continue;
        }
        if (cctx & CTX_TEMP && !(pctx & CTX_TEMP)) {
          if (v >= MB) add(I.temp, c);
          continue;
        }
        if (ccat === Cat.caches && pcat !== Cat.caches) {
          const full = mac ? t.path(c) : '';
          if (v >= 4 * MB && (!mac || mac.cacheRoots.some((dir) => full === dir || full.startsWith(dir + '/')))) add(I.caches, c);
          continue;
        }
        const rule = REBUILDABLE[lower];
        if (rule && pcat !== Cat.system && pcat !== Cat.apps) {
          siblings ??= lowerKids(id);
          if (rule(siblings)) {
            let projectLast = 0;
            for (let k = t.first[id]; k !== -1; k = t.next[k]) if (k !== c && t.aLast[k] > projectLast) projectLast = t.aLast[k];
            if (projectLast > 0 && projectLast < now - 60 * DAY && v >= 5 * MB) add(I.devJunk, c);
            continue;
          }
        }
        if (cctx & CTX_DL && !(pctx & CTX_DL)) {
          scanDownloads(c);
          continue;
        }
        if (v >= MB) stack.push(c, cd);
      } else if (!mac && cd === 1 && lower === 'hiberfil.sys') {
        if (v >= GB) add(I.hibernation, c);
      } else if (v >= 512 * MB && !MANAGED.has(pcat) && t.aLast[c] > 0 && t.aLast[c] < now - 365 * DAY) {
        add(I.largeOld, c);
      }
    }
  }

  const val = t.aAlloc;
  const list = ACTION_ORDER.map((k) => I[k]).filter((i) => i.ids.length && i.bytes >= (i.kind === 'trash' ? MB : i.kind === 'hibernation' ? GB : 32 * MB));
  for (const i of list) {
    i.ids.sort((a, b) => val[b] - val[a]);
    i.count = i.ids.length;
  }
  const info = (i: Insight) => i.action === 'info' || i.action === 'diskCleanup';
  return list.sort((a, b) => Number(info(a)) - Number(info(b)) || b.bytes - a.bytes);
}

export function insightItems(s: ScanState, kind: InsightKind, limit = 2000): NodeInfo[] {
  s.insights ??= computeInsights(s);
  const ins = s.insights.find((i) => i.kind === kind);
  if (!ins) return [];
  return ins.ids
    .filter((id) => s.tree.alive(id))
    .slice(0, limit)
    .map((id) => nodeInfo(s.tree, id, true));
}
