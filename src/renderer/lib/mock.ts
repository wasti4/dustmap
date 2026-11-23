// Demo backend for running the UI in a plain browser (npm run dev, then open
// the Vite URL). It builds a synthetic Windows drive and answers with the real
// engine query code, so layouts and numbers behave like the desktop app.
import { CAT_COUNT, type EngineEvent, type InsightKind, type ScanRequest, type StorageApi } from '../../shared/types';
import { Tree, F_DIR } from '../../engine/tree';
import { contextForPath, dirContext, fileCategory } from '../../engine/classify';
import * as Q from '../../engine/query';
import type { ScanState } from '../../engine/scanner';

const GB = 1024 ** 3;
const MB = 1024 ** 2;
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const now = Math.floor(Date.now() / 1000);
const DAY = 86400;

function buildTree(root: string): Tree {
  const t = new Tree(1 << 14);
  const rid = t.add(-1, root, F_DIR);
  t.root = rid;
  t.ctx[rid] = contextForPath(root).ctx;
  const depthOf = new Map<number, number>([[rid, 0]]);
  const dir = (parent: number, name: string) => {
    const id = t.add(parent, name, F_DIR);
    const d = (depthOf.get(parent) ?? 0) + 1;
    depthOf.set(id, d);
    const c = dirContext(t.ctx[parent], name.toLowerCase(), d, t.names[parent].toLowerCase());
    t.ctx[id] = c;
    t.cat[id] = (c & 15) - 1 >= 0 ? (c & 15) - 1 : 11;
    return id;
  };
  const file = (parent: number, name: string, size: number, ageDays: number, accessDays = ageDays) => {
    const id = t.add(parent, name, 0);
    t.size[id] = size;
    t.alloc[id] = Math.ceil(size / 4096) * 4096;
    t.mtime[id] = now - Math.floor(ageDays * DAY);
    t.ctime[id] = now - Math.floor(ageDays * DAY) - 1000;
    t.atime[id] = now - Math.floor(accessDays * DAY);
    t.cat[id] = fileCategory(t.ctx[parent], name.toLowerCase(), size, depthOf.get(parent) === 0);
    return id;
  };
  const many = (parent: number, n: number, ext: string, avg: number, maxAge: number, prefix = 'file') => {
    for (let i = 0; i < n; i++) {
      const age = rnd() * maxAge;
      file(parent, `${prefix}_${i + 1}.${ext}`, Math.floor(avg * (0.2 + rnd() * 1.8)), age, age * rnd());
    }
  };

  const win = dir(rid, 'Windows');
  many(dir(win, 'System32'), 900, 'dll', 9 * MB, 700);
  many(dir(win, 'WinSxS'), 600, 'dll', 14 * MB, 900);
  many(dir(win, 'Installer'), 40, 'msi', 90 * MB, 900);
  many(dir(win, 'Temp'), 60, 'tmp', 14 * MB, 30);
  const pf = dir(rid, 'Program Files');
  many(dir(pf, 'Adobe'), 160, 'dll', 22 * MB, 300);
  many(dir(pf, 'Microsoft Office'), 220, 'dll', 12 * MB, 200);
  many(dir(pf, 'JetBrains'), 140, 'jar', 9 * MB, 120);
  const steam = dir(dir(dir(rid, 'Program Files (x86)'), 'Steam'), 'steamapps');
  const common = dir(steam, 'common');
  many(dir(common, 'Cyber Drift'), 30, 'pak', 1.6 * GB, 500, 'data');
  many(dir(common, 'Stellar Tactics'), 14, 'pak', 1.2 * GB, 900, 'data');
  many(dir(rid, 'ProgramData'), 120, 'dat', 8 * MB, 400);
  const users = dir(rid, 'Users');
  const me = dir(users, 'Alex');
  const appdata = dir(me, 'AppData');
  const local = dir(appdata, 'Local');
  many(dir(local, 'Temp'), 300, 'tmp', 6 * MB, 60);
  const chrome = dir(dir(dir(dir(local, 'Google'), 'Chrome'), 'User Data'), 'Default');
  many(dir(chrome, 'Cache'), 400, 'bin', 4 * MB, 20);
  many(dir(chrome, 'Code Cache'), 200, 'bin', 2 * MB, 20);
  many(dir(dir(local, 'Discord'), 'Cache'), 150, 'bin', 3 * MB, 10);
  many(dir(dir(local, 'npm-cache'), '_cacache'), 300, 'tgz', 1.2 * MB, 200);
  many(dir(dir(appdata, 'Roaming'), 'Telegram Desktop'), 80, 'dat', 12 * MB, 50);
  const docs = dir(me, 'Documents');
  many(docs, 120, 'pdf', 3 * MB, 1400);
  many(docs, 90, 'docx', 0.8 * MB, 1400);
  many(dir(docs, 'Taxes 2021'), 40, 'xlsx', 2 * MB, 1500);
  const proj = dir(dir(me, 'Projects'), 'old-landing');
  file(proj, 'package.json', 2000, 400);
  many(dir(proj, 'src'), 40, 'tsx', 9000, 400);
  many(dir(proj, 'node_modules'), 900, 'js', 0.9 * MB, 420);
  const proj2 = dir(dir(me, 'Projects'), 'storage-app');
  file(proj2, 'package.json', 2000, 2);
  many(dir(proj2, 'node_modules'), 600, 'js', 0.7 * MB, 5);
  const dl = dir(me, 'Downloads');
  many(dl, 14, 'exe', 140 * MB, 400, 'setup');
  many(dl, 6, 'msi', 90 * MB, 300, 'installer');
  many(dl, 10, 'zip', 300 * MB, 700, 'archive');
  file(dl, 'ubuntu-22.04-desktop-amd64.iso', 4.7 * GB, 800, 790);
  many(dl, 30, 'pdf', 4 * MB, 600, 'scan');
  many(dir(me, 'Pictures'), 1400, 'jpg', 4.5 * MB, 1500, 'IMG');
  many(dir(me, 'Pictures'), 300, 'png', 1.8 * MB, 300, 'Screenshot');
  const vids = dir(me, 'Videos');
  many(vids, 24, 'mp4', 1.4 * GB, 1200, 'VID');
  many(dir(vids, 'Captures'), 30, 'mp4', 600 * MB, 90, 'capture');
  file(dir(vids, 'Archive 2019'), 'wedding-4k-master.mov', 38 * GB, 1900, 1800);
  many(dir(me, 'Music'), 700, 'mp3', 8 * MB, 2000, 'track');
  many(dir(me, 'Desktop'), 40, 'lnk', 2000, 100);
  many(dir(dir(dir(rid, '$Recycle.Bin'), 'S-1-5-21-1001'), '$R0001'), 80, 'mp4', 160 * MB, 20);
  file(rid, 'pagefile.sys', 12 * GB, 1, 1);
  file(rid, 'hiberfil.sys', 6.4 * GB, 1, 1);
  file(rid, 'swapfile.sys', 256 * MB, 1, 1);
  t.aggregate(rid);
  return t;
}

export function createMockApi(): StorageApi {
  const listeners = new Set<(ev: EngineEvent) => void>();
  const emit = (ev: EngineEvent) => listeners.forEach((l) => l(ev));
  let scan: ScanState | null = null;
  let seq = 0;
  const total = 512 * GB;
  let free = 0;

  const need = () => {
    if (!scan) throw new Error('no scan');
    return scan;
  };
  const summary = () => {
    const s = need();
    s.free = free;
    return Q.summary(s, 'on');
  };

  const methods: Record<string, (p: never) => unknown> = {
    scan(p: ScanRequest) {
      const id = ++seq;
      const root = p.root.endsWith('\\') ? p.root : p.root + '\\';
      const tree = buildTree(root.length <= 3 ? root : root.replace(/\\$/, ''));
      const used = tree.aAlloc[tree.root] * 1.03;
      free = total - used;
      const cats = Q.categoryTotals(tree, tree.root).map((c) => c.alloc);
      const t0 = Date.now();
      const dur = 2600;
      const paths = ['Windows\\System32', 'Program Files\\Adobe', 'Users\\Alex\\AppData\\Local\\Google\\Chrome', 'Users\\Alex\\Pictures', 'Users\\Alex\\Videos', '$Recycle.Bin'];
      const timer = setInterval(() => {
        const f = Math.min(1, (Date.now() - t0) / dur);
        const e = 1 - (1 - f) ** 2;
        if (f >= 1) {
          clearInterval(timer);
          scan = { id, tree, root, rootId: tree.root, baseDepth: 0, isVolume: root.length <= 3, mode: 'walk', ms: dur, errors: 3, total, free, scannedAt: Date.now(), insights: null };
          emit({ type: 'done', data: summary() });
          return;
        }
        emit({
          type: 'progress',
          data: {
            scanId: id,
            mode: 'walk',
            phase: 'walk',
            files: Math.floor(tree.aFiles[tree.root] * e),
            dirs: Math.floor(tree.aDirs[tree.root] * e),
            bytes: used * e,
            path: root + paths[Math.floor(f * paths.length)],
            fraction: e,
            cats: cats.map((c, i) => c * Math.min(1, e * (1 + (i % 3) * 0.15))),
            total,
            free,
          },
        });
      }, 90);
      return { scanId: id };
    },
    cancel: () => true,
    summary: () => summary(),
    children: (p: Parameters<typeof Q.children>[1]) => Q.children(need(), p),
    detail: (p: { id: number }) => Q.detail(need(), p.id),
    treemap: (p: Parameters<typeof Q.treemap>[1]) => Q.treemap(need(), p),
    topFiles: (p: Parameters<typeof Q.topFiles>[1]) => Q.topFiles(need(), p),
    search: (p: Parameters<typeof Q.search>[1]) => Q.search(need(), p),
    stale: (p: Parameters<typeof Q.stale>[1]) => Q.stale(need(), p),
    fileTypes: (p: Parameters<typeof Q.fileTypes>[1]) => Q.fileTypes(need(), p),
    insights: () => (need().insights ??= Q.computeInsights(need())),
    insightItems: (p: { kind: InsightKind }) => Q.insightItems(need(), p.kind),
    paths: (p: { ids: number[] }) => p.ids.map((id) => need().tree.path(id)),
    removed(p: { ids: number[] }) {
      const s = need();
      for (const id of p.ids) {
        free += s.tree.aAlloc[id];
        s.tree.remove(id);
      }
      s.insights = null;
      return summary();
    },
    refresh(p: { ids: number[] }) {
      const s = need();
      for (const id of p.ids) {
        if (!s.tree.alive(id)) continue;
        for (const c of s.tree.childIds(id)) {
          free += s.tree.aAlloc[c];
          s.tree.remove(c);
        }
      }
      s.insights = null;
      return summary();
    },
  };

  const delay = <T>(v: T, ms = 30) => new Promise<T>((r) => setTimeout(() => r(v), ms));
  const findIds = (paths: string[]) => paths.map((p) => p);

  return {
    startup: () => delay({ platform: 'win32', elevated: false, systemDrive: 'C:', home: 'C:\\Users\\Alex', version: '0.1.0 (demo)', autoScan: new URLSearchParams(location.search).get('scan') ?? undefined }),
    drives: () =>
      delay([
        { root: 'C:\\', letter: 'C', label: 'Windows', fs: 'NTFS', total, free: 154 * GB, kind: 'fixed', system: true },
        { root: 'D:\\', letter: 'D', label: 'Data', fs: 'NTFS', total: 2 * 1024 * GB, free: 1.2 * 1024 * GB, kind: 'fixed', system: false },
        { root: 'E:\\', letter: 'E', label: 'USB', fs: 'exFAT', total: 64 * GB, free: 21 * GB, kind: 'removable', system: false },
      ]),
    relaunchElevated: () => delay(false),
    chooseFolder: () => delay('C:\\Users\\Alex\\Documents'),
    pathForFile: () => '',
    engine: <T>(method: string, params?: unknown) => {
      try {
        return delay(methods[method](params as never) as T, 10);
      } catch (e) {
        return Promise.reject(e);
      }
    },
    onEngineEvent: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    openPath: () => delay(''),
    reveal: () => delay(undefined),
    copyText: (t) => navigator.clipboard?.writeText(t).catch(() => undefined) ?? delay(undefined),
    trash: (paths) => delay({ ok: findIds(paths), failed: [] }, 400),
    remove: (paths) => delay({ ok: findIds(paths), failed: [] }, 600),
    emptyRecycleBin: (root) => delay({ ok: [root], failed: [] }, 500),
    diskCleanup: () => delay(undefined),
    openDiskAccessSettings: () => delay(undefined),
    space: () => delay({ total, free }),
    setChrome: () => delay(undefined),
  };
}

export const MOCK_CATS = CAT_COUNT;
