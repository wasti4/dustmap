// Privacy filter for recording demo videos on a real drive (dev only, `--record`).
// Personal names become stable pseudonyms: the user folder turns into "alex", and
// anything inside it or at the drive root that is not a standard Windows or app folder
// gets an adjective-noun name with its original extension. System areas stay real.

export const REDACT_USER = 'alex';

const ROOT_KEEP = new Set(
  [
    'users', 'windows', 'program files', 'program files (x86)', 'programdata', 'pagefile.sys', 'hiberfil.sys',
    'swapfile.sys', '$recycle.bin', '$windows.~ws', '$winreagent', 'recovery', 'perflogs', 'system volume information',
    'dumpstack.log', 'dumpstack.log.tmp', 'config.msi', 'intel', 'amd', 'nvidia', 'drivers', 'msocache', 'windows.old',
    'documents and settings', 'onedrivetemp', 'xboxgames', 'inetpub', 'temp', 'tmp',
  ].map((s) => s.toLowerCase()),
);

const USERS_KEEP = new Set(['public', 'default', 'default user', 'all users', 'desktop.ini', 'все пользователи']);

/** Standard folders inside a user profile that say nothing about the person. */
const COMMON = new Set(
  [
    'appdata', 'local', 'locallow', 'roaming', 'documents', 'downloads', 'desktop', 'pictures', 'videos', 'music',
    'favorites', 'links', 'contacts', 'saved games', 'searches', 'onedrive', 'temp', 'programs', 'microsoft',
    'windows', 'packages', 'cache', 'caches', 'code cache', 'gpucache', 'shadercache', 'dawncache', 'google',
    'chrome', 'user data', 'default', 'mozilla', 'firefox', 'profiles', 'nvidia', 'nvidia corporation', 'dxcache',
    'glcache', 'intel', 'amd', 'd3dscache', 'crashdumps', 'logs', 'history', 'fonts', 'start menu', 'recent',
    'inetcache', 'wer', 'squirreltemp', 'extensions', 'service worker', 'indexeddb', 'local storage', 'python',
    'pip', 'npm', 'npm-cache', 'node_modules', 'yarn', 'pnpm', '.cache', '.npm', '.nuget', '.gradle', '.m2',
    '.vscode', '.android', '.cargo', '.rustup', '.docker', '.git', '.idea', 'source', 'repos', 'sdk', 'platforms',
    'build-tools', 'android', 'jetbrains', 'steam', 'discord', 'spotify', 'zoom', 'slack', 'code', 'vs code',
    'visual studio code', 'electron', 'squirrel', 'onedrive', 'camera roll', 'screenshots', 'saved pictures',
  ].map((s) => s.toLowerCase()),
);

const ADJ = ['amber', 'bright', 'calm', 'cedar', 'clear', 'coral', 'crisp', 'dusty', 'early', 'fern', 'gentle', 'golden', 'hazel', 'ivory', 'jade', 'keen', 'lunar', 'maple', 'misty', 'north', 'olive', 'pale', 'quiet', 'rapid', 'rustic', 'silver', 'solar', 'still', 'swift', 'tidal', 'velvet', 'wild'];
const NOUN = ['atlas', 'beacon', 'brook', 'canyon', 'comet', 'delta', 'ember', 'field', 'fjord', 'garden', 'grove', 'harbor', 'island', 'lagoon', 'meadow', 'mesa', 'orbit', 'pebble', 'pine', 'prairie', 'quarry', 'reef', 'ridge', 'river', 'shore', 'summit', 'thicket', 'tundra', 'valley', 'willow', 'harvest', 'lantern'];

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Stable pseudonym that keeps a leading dot and a short extension. */
export function pseudonym(name: string): string {
  const dot = name.startsWith('.') ? '.' : '';
  const base = dot ? name.slice(1) : name;
  const i = base.lastIndexOf('.');
  const ext = i > 0 && base.length - i <= 8 ? base.slice(i).toLowerCase() : '';
  const h = hash(name.toLowerCase());
  return `${dot}${ADJ[h % ADJ.length]}-${NOUN[(h >>> 7) % NOUN.length]}${ext}`;
}

/**
 * Masks one name given its depth below the drive root (1 = a root entry) and the root
 * entry it sits under (lower case).
 */
export function maskName(name: string, depth: number, top: string, user: string): string {
  const low = name.toLowerCase();
  if (depth <= 0) return name;
  if (depth === 1) return ROOT_KEEP.has(low) ? name : pseudonym(name);
  if (top !== 'users') return name;
  if (depth === 2) return USERS_KEEP.has(low) ? name : low === user ? REDACT_USER : pseudonym(name);
  return COMMON.has(low) ? name : pseudonym(name);
}

/** Masks a full Windows path such as C:\Users\name\AppData\…. */
export function redactPath(p: string, user: string): string {
  if (!p) return p;
  const parts = p.split('\\');
  const top = (parts[1] ?? '').toLowerCase();
  return parts.map((seg, i) => (seg ? maskName(seg, i, top, user) : seg)).join('\\');
}
