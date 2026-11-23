
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withinMacPath } from './macos';

const posix = path.posix;
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
  // Only the current user's real temporary subtree is eligible under /private.
  if (n === tmp) return 'protected-folder';
  if (systemTrees.some((dir) => withinMacPath(n, dir)) && !withinMacPath(n, tmp)) return 'system-folder';
  if (n === '/applications' || n === '/library' || n === '/opt' ||
      ['/library/apple', '/library/preferences', '/library/keychains', '/library/launchagents', '/library/launchdaemons'].some((dir) => withinMacPath(n, dir))) {
    return 'protected-folder';
  }
  if (withinMacPath(n, '/users') && !withinMacPath(n, h)) return 'protected-profile';
  if (n === h || homeRoots.some((dir) => n === posix.join(h, dir))) return 'protected-folder';
  if (personalLibrary.some((dir) => withinMacPath(n, posix.join(h, 'library', dir)))) return 'protected-folder';
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

  const [st, parentStat] = await Promise.all([fs.lstat(target), fs.stat(parent)]);
  if (st.dev !== parentStat.dev) throw new Error('drive-root');
  return { target, st, tmp };
}

async function readDirectory(p: string, st: Stats): Promise<string[]> {
  // Recheck the directory before using it. Do not follow a replaced directory or link.
  const now = await fs.lstat(p);
  if (!now.isDirectory() || now.dev !== st.dev || now.ino !== st.ino) throw new Error('directory-changed');
  return fs.readdir(p);
}

/** Remove an entry without following links, crossing a mount or changing permissions. */
async function removeEntry(p: string, device: number): Promise<void> {
  const st = await fs.lstat(p);
  if (st.dev !== device) throw new Error('drive-root');
  if (!st.isDirectory()) {
    if (!(st.isFile() || st.isSymbolicLink())) throw new Error('special-file');
    await fs.unlink(p);
    return;
  }
  await removeChildren(p, st);
  await fs.rmdir(p);
}

async function removeChildren(p: string, st: Stats) {
  const names = await readDirectory(p, st);
  let partial = false;
  for (const name of names) {
    try {
      await removeEntry(posix.join(p, name), st.dev);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') partial = true;
    }
  }
  if (partial) throw new Error('some-items-could-not-be-removed');
}

export async function removeMacPath(p: string, mode: 'permanent' | 'contents', home: string, temp: string): Promise<void> {
  const { target, st, tmp } = await macMutationTarget(p, home, temp);
  if (mode === 'permanent') return removeEntry(target, st.dev);
  const allowed = [posix.join(home, 'Library', 'Caches'), posix.join(home, '.cache'), tmp];
  if (!allowed.some((dir) => withinMacPath(key(target), key(dir))) || !st.isDirectory()) throw new Error('not-a-cache-directory');
  await removeChildren(target, st);
}

/** Empty the current user's Trash at an explicitly selected volume, keeping the directory. */
export async function emptyMacTrash(trash: string): Promise<void> {
  const st = await fs.lstat(trash);
  // Refuse both final symlinks and any redirection of the parent (e.g. .Trashes).
  const real = await fs.realpath(trash);
  if (!st.isDirectory() || key(real) !== key(trash) || st.uid !== process.getuid?.()) throw new Error('unexpected-trash-directory');
  await removeChildren(real, st);
}
