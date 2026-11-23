
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DriveInfo } from '../shared/types';

const exec = promisify(execFile);
export const MAC_DATA = '/System/Volumes/Data';
export const isMac = process.platform === 'darwin';

export function macHelperPath(): string | undefined {
  if (!isMac || process.env.SC_NO_HELPER) return;
  const helper = path.join(__dirname, 'mac-walker').replace('/app.asar/', '/app.asar.unpacked/');
  if (fs.existsSync(helper)) return helper;
}

interface Mount {
  root: string;
  label: string;
  fs: string;
  local: boolean;
}

export function withinMacPath(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir === '/' ? '/' : dir + '/');
}

export function scanMount(root: string, roots: string[]): string {
  return roots.reduce((best, p) => p.length > best.length && withinMacPath(root, p) ? p : best, '/');
}

export function macTrashPath(volume: string, home = os.homedir(), uid = process.getuid?.() ?? -1): string {
  return volume === '/' ? path.posix.join(home, '.Trash') : path.posix.join(volume, '.Trashes', String(uid));
}

export async function volumeSpace(root: string): Promise<{ total: number; free: number }> {
  try {
    const s = await fs.promises.statfs(root);
    return { total: s.blocks * s.bsize, free: Math.max(0, s.bavail * s.bsize) };
  } catch {
    return { total: 0, free: 0 };
  }
}

async function readMacMounts(): Promise<Mount[]> {
  const helper = macHelperPath();
  if (helper) {
    try {
      const { stdout } = await exec(helper, ['--volumes'], { timeout: 4000, maxBuffer: 1 << 20 });
      const mounts: Mount[] = JSON.parse(stdout);
      if (mounts.some((m) => m.root === '/')) return mounts;
    } catch {
      // The app also works from source without Xcode Command Line Tools.
    }
  }
  const mounts: Mount[] = [{ root: '/', label: 'macOS', fs: '', local: true }];
  try {
    const parent = await fs.promises.stat('/Volumes');
    const entries = await fs.promises.readdir('/Volumes', { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const root = path.posix.join('/Volumes', entry.name);
      const st = await fs.promises.lstat(root).catch(() => null);
      if (st && st.dev !== parent.dev) mounts.push({ root, label: entry.name, fs: '', local: true });
    }
  } catch {
    // A Mac without additional volumes still has a startup disk.
  }
  return mounts;
}

function visibleMount(m: Mount): boolean {
  return m.root === '/' || m.root.startsWith('/Volumes/') || m.root.startsWith('/Network/Servers/');
}

export async function macDrives(): Promise<DriveInfo[]> {
  const mounts = (await readMacMounts()).filter(visibleMount);
  const rows = await Promise.all(mounts.map(async (m): Promise<DriveInfo> => ({
    root: m.root,
    label: m.label,
    fs: m.fs,
    ...(await volumeSpace(m.root)),
    kind: m.local ? (m.root === '/' ? 'fixed' : 'removable') : 'network',
    system: m.root === '/',
  })));
  return rows.filter((d) => d.total > 0);
}

export interface MacScanScope {
  root: string;
  volume: string;
  devices: Set<number>;
  trashPath: string;
  cacheRoots: string[];
}

export async function macScanScope(requested: string): Promise<MacScanScope> {
  // Resolve a selected symlink once. Symlinks discovered inside the scan remain leaves.
  let root = await fs.promises.realpath(requested);
  const st = await fs.promises.lstat(root);
  if (!st.isDirectory()) throw new Error('Select a directory to scan');

  let alias = root;
  if (root === MAC_DATA) alias = '/';
  else if (withinMacPath(root, MAC_DATA)) alias = root.slice(MAC_DATA.length);
  if (alias === '/' || (alias !== root && await fs.promises.stat(alias).then((s) => s.dev === st.dev && s.ino === st.ino, () => false))) {
    root = alias;
  }
  const mounts = await readMacMounts();
  const volume = scanMount(root, mounts.map((m) => m.root));
  const devices = new Set([root === '/' ? (await fs.promises.stat(root)).dev : st.dev]);
  if (root === '/') {
    const data = await fs.promises.stat(MAC_DATA).catch(() => undefined);
    if (data) devices.add(data.dev);
  }
  const home = os.homedir();
  const temp = await fs.promises.realpath(os.tmpdir()).catch(() => os.tmpdir());
  return {
    root, volume, devices, trashPath: macTrashPath(volume, home),
    cacheRoots: [path.posix.join(home, 'Library', 'Caches'), path.posix.join(home, '.cache'), temp],
  };
}
