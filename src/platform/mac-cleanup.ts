
import fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { macHelperPath, withinMacPath } from './macos';

const posix = path.posix;
const exec = promisify(execFile);
const key = (p: string) => posix.resolve(p).normalize('NFD').toLowerCase();
const systemTrees = ['/system', '/bin', '/sbin', '/usr', '/private', '/dev', '/cores', '/network'];
const homeRoots = ['desktop', 'documents', 'downloads', 'pictures', 'movies', 'music', 'public', 'applications', 'library', '.ssh', '.gnupg'];
const personalLibrary = ['accounts', 'application support/mobilesync', 'calendars', 'cloudstorage', 'keychains', 'mail', 'messages', 'mobile documents', 'preferences'];

export function macProtectedPath(p: string, home: string, temp: string): string | null {
  const n = key(p);
  const h = key(home);
  const tmp = key(temp);
  if (n === '/' || n === '/volumes' || n === '/users' || /^\/volumes\/[^/]+$/.test(n)) return 'drive-root';
  if (/(?:^|\/)\.(?:trash|trashes)(?:\/|$)/.test(n)) return 'protected-trash';
  if (n === tmp) return 'protected-folder';
  if (systemTrees.some((dir) => withinMacPath(n, dir)) && !withinMacPath(n, tmp)) return 'system-folder';
  if (n === '/applications' || n === '/library' || n === '/opt' ||
      ['/library/apple', '/library/preferences', '/library/keychains', '/library/launchagents', '/library/launchdaemons'].some((dir) => withinMacPath(n, dir))) {
    return 'protected-folder';
  }
  if (withinMacPath(n, '/users') && !withinMacPath(n, h)) return 'protected-profile';
  if (n === h || homeRoots.some((dir) => n === posix.join(h, dir))) return 'protected-folder';
  if (n === posix.join(h, 'library', 'application support') ||
      personalLibrary.some((dir) => withinMacPath(n, posix.join(h, 'library', dir)))) return 'protected-folder';
  return null;
}

export async function macMutationTarget(input: string, home: string, temp: string) {
  if (!posix.isAbsolute(input)) throw new Error('absolute-path-required');
  const p = posix.normalize(input).replace(/\/+$/, '') || '/';
  const tmp = await fs.realpath(temp).catch(() => temp);
  const parent = await fs.realpath(posix.dirname(p));
  const target = posix.join(parent, posix.basename(p));
  const why = macProtectedPath(p, home, tmp) || macProtectedPath(target, home, tmp);
  if (why) throw new Error(why);

  const [st, parentStat] = await Promise.all([fs.lstat(target, { bigint: true }), fs.stat(parent, { bigint: true })]);
  if (st.dev !== parentStat.dev) throw new Error('drive-root');
  return { target, st, tmp };
}

async function removePinned(target: string, st: BigIntStats, mode: 'permanent' | 'contents'): Promise<void> {
  const helper = macHelperPath();
  if (!helper) throw new Error('native-cleanup-unavailable');
  try {
    await exec(helper, ['--remove', mode, posix.dirname(target), posix.basename(target), String(st.dev), String(st.ino)]);
  } catch (e) {
    throw new Error((e as { stderr?: string }).stderr?.trim() || 'some-items-could-not-be-removed');
  }
}

export async function removeMacPath(p: string, mode: 'permanent' | 'contents', home: string, temp: string): Promise<void> {
  const { target, st, tmp } = await macMutationTarget(p, home, temp);
  if (mode === 'contents') {
    if (!st.isDirectory()) throw new Error('not-a-cache-directory');
    const allowed = await Promise.all([posix.join(home, 'Library', 'Caches'), posix.join(home, '.cache'), tmp].map(async (dir) => {
      // Keep the allowlist tied to a real directory with the filesystem's case semantics.
      const dirStat = await fs.lstat(dir).catch(() => null);
      return dirStat?.isDirectory() ? fs.realpath(dir).catch(() => null) : null;
    }));
    const actual = await fs.realpath(target);
    if (!allowed.some((dir) => dir !== null && withinMacPath(actual, dir))) throw new Error('not-a-cache-directory');
  }
  await removePinned(target, st, mode);
}

/** Empty the current user's Trash on one volume, leaving the Trash directory intact. */
export async function emptyMacTrash(trash: string, volume: string): Promise<void> {
  const [st, disk] = await Promise.all([fs.lstat(trash, { bigint: true }), fs.stat(volume, { bigint: true })]);
  const real = await fs.realpath(trash);
  if (!st.isDirectory() || real !== trash || st.dev !== disk.dev || st.uid !== BigInt(process.getuid?.() ?? -1)) {
    throw new Error('unexpected-trash-directory');
  }
  await removePinned(real, st, 'contents');
}
