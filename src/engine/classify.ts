// Smart categorisation: a directory "context" flows top-down (Windows, Program
// Files, AppData caches, node_modules, Steam libraries...), and files without a
// context are categorised by extension.
import { Cat, type DesktopPlatform } from '../shared/types';

// Context byte layout:
//   bits 0-3: category index + 1 (0 = no context category)
//   bit 4: inside a Downloads folder
//   bit 5: inside AppData (application data, where caches are safe to clear)
//   bit 6: inside a user profile (C:\Users\<name>)
//   bit 7: inside a temp directory
export const CTX_DL = 16;
export const CTX_APPDATA = 32;
export const CTX_PROFILE = 64;
export const CTX_TEMP = 128;

export const ctxCat = (ctx: number) => (ctx & 15) - 1;
const withCat = (ctx: number, cat: number) => (ctx & ~15) | (cat + 1);

const ROOT_SYSTEM = new Set([
  'windows',
  'system volume information',
  'recovery',
  'perflogs',
  'config.msi',
  'windows.old',
  'boot',
  'efi',
  'msocache',
  'onedrivetemp',
  'intel',
  'amd',
  'nvidia',
  'drivers',
]);
const ROOT_TRASH = new Set(['$recycle.bin', 'recycler', 'recycled']);
const ROOT_APPS = new Set(['program files', 'program files (x86)', 'programdata']);
export const ROOT_SYSTEM_FILES = new Set([
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys',
  'dumpstack.log',
  'dumpstack.log.tmp',
  'bootmgr',
  'bootnxt',
  'bootsect.bak',
]);

const CACHE_NAMES = new Set([
  'cache',
  'caches',
  'cache2',
  '.cache',
  'code cache',
  'gpucache',
  'grshadercache',
  'graphitedawncache',
  'shadercache',
  'dawncache',
  'dawngraphitecache',
  'dawnwebgpucache',
  'cachestorage',
  'scriptcache',
  'inetcache',
  'd3dscache',
  'dxcache',
  'glcache',
  'nv_cache',
  'crashdumps',
  'htmlcache',
  'webcache',
  'npm-cache',
  '_cacache',
  'localcache',
  'tempstate',
  'squirreltemp',
  'pip',
  'yarn',
  'nuget\\v3-cache',
  'v3-cache',
  'http-cache',
  'pnpm-cache',
  'deliveryoptimization',
  'jumplistcache',
]);

const DEV_NAMES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.venv',
  'venv',
  '__pycache__',
  '.gradle',
  '.m2',
  '.nuget',
  '.cargo',
  '.rustup',
  '.pnpm-store',
  '.yarn',
  '.idea',
  '.vs',
  '.vscode',
  '.android',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.angular',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.dotnet',
  '.docker',
  '.conda',
  'anaconda3',
  'miniconda3',
  'site-packages',
  'windows kits',
  'microsoft sdks',
  'android',
  'jetbrains',
  'docker',
  'nodejs',
  'dotnet',
  'go',
  'msys64',
  'cygwin64',
]);

const GAME_NAMES = new Set([
  'steamapps',
  'steamlibrary',
  'steam',
  'epic games',
  'gog games',
  'gog galaxy',
  'xboxgames',
  'riot games',
  'battle.net',
  'ubisoft',
  'ubisoft game launcher',
  'ea games',
  'origin games',
  'rockstar games',
  'games',
  '.minecraft',
  'wargaming.net',
  'genshin impact',
  'hoyoplay',
]);

const MAC_SYSTEM = new Set(['system', 'bin', 'sbin', 'usr', 'private', 'cores', 'dev', 'network', '.fseventsd', '.spotlight-v100', '.documentrevisions-v100', '.temporaryitems']);

function macDirContext(parentCtx: number, name: string, depth: number, parentName: string): number {
  const cur = ctxCat(parentCtx);
  if (cur === Cat.trash || cur === Cat.caches || cur === Cat.system) return parentCtx;
  if (depth === 1) {
    if (name === '.trashes' || name === '.trash') return withCat(parentCtx, Cat.trash);
    if (MAC_SYSTEM.has(name) || name === 'library') return withCat(parentCtx, Cat.system);
  }
  let ctx = parentCtx;
  if (depth === 2 && parentName === 'users') return ctx | CTX_PROFILE;
  if (name === '.trash' && ctx & CTX_PROFILE) return withCat(ctx, Cat.trash);
  if (name === 'downloads') ctx |= CTX_DL;
  if (name === 'caches' && parentName === 'library' && ctx & CTX_PROFILE) return withCat(ctx, Cat.caches);
  if (name === '.cache' && ctx & CTX_PROFILE) return withCat(ctx, Cat.caches);
  if (name === 'library' && ctx & CTX_PROFILE && depth === 3) return withCat(ctx | CTX_APPDATA, Cat.apps);
  if (name === 'applications' || name.endsWith('.app') || name.endsWith('.framework')) return withCat(ctx, Cat.apps);
  if (cur !== Cat.developer && GAME_NAMES.has(name)) return withCat(ctx, Cat.games);
  if (DEV_NAMES.has(name) || name === 'deriveddata' && parentName === 'xcode') return withCat(ctx, Cat.developer);
  return ctx;
}

/** Computes the context of a directory from its parent's context and its name. */
export function dirContext(parentCtx: number, name: string, depth: number, parentName: string, platform: DesktopPlatform = 'win32'): number {
  if (platform === 'darwin') return macDirContext(parentCtx, name, depth, parentName);
  let ctx = parentCtx;
  const cur = ctxCat(parentCtx);
  if (cur === Cat.trash) return ctx;

  if (depth === 1) {
    if (ROOT_TRASH.has(name)) return withCat(ctx, Cat.trash);
    if (ROOT_SYSTEM.has(name) || name.startsWith('$')) return withCat(ctx, Cat.system);
    if (ROOT_APPS.has(name)) return withCat(ctx, Cat.apps);
  }
  if (depth === 2 && parentName === 'users') return ctx | CTX_PROFILE;
  if (name === 'downloads') ctx |= CTX_DL;
  if ((ctx & CTX_PROFILE) && depth === 3 && name === 'appdata') return withCat(ctx | CTX_APPDATA, Cat.apps);

  // Temp folders: %LOCALAPPDATA%\Temp and C:\Windows\Temp.
  if ((name === 'temp' || name === 'tmp') && ((ctx & CTX_APPDATA && parentName === 'local') || (depth === 2 && parentName === 'windows'))) {
    return withCat(ctx | CTX_TEMP, Cat.caches);
  }
  if (cur === Cat.caches) return ctx;

  if (CACHE_NAMES.has(name)) {
    const managed = ctx & CTX_APPDATA || cur === Cat.apps || cur === Cat.games || cur === Cat.system || cur === Cat.developer;
    if (managed || name === '.cache' || name === 'npm-cache' || name === '_cacache') return withCat(ctx, Cat.caches);
  }
  if (cur === Cat.system) return ctx;
  if (DEV_NAMES.has(name)) return withCat(ctx, Cat.developer);
  if (cur === Cat.developer) return ctx;
  if (GAME_NAMES.has(name)) return withCat(ctx, Cat.games);
  if (name === 'windowsapps' || (name === 'programs' && ctx & CTX_APPDATA)) return withCat(ctx, Cat.apps);
  return ctx;
}

/** Initial context for a scan root: classify each path segment from the volume root. */
export function contextForPath(path: string, platform: DesktopPlatform = 'win32', volume = '/'): { ctx: number; depth: number } {
  const segs = platform === 'darwin'
    ? path.slice(volume === '/' ? 0 : volume.length).split('/').filter(Boolean)
    : path.replace(/[\\/]+$/, '').split(/[\\/]+/).slice(1);
  let ctx = 0;
  let parent = '';
  for (let i = 0; i < segs.length; i++) {
    const n = segs[i].toLowerCase();
    ctx = dirContext(ctx, n, i + 1, parent, platform);
    parent = n;
  }
  return { ctx, depth: segs.length };
}

const EXT = new Map<string, number>();
const reg = (cat: number, list: string) => list.split(' ').forEach((e) => EXT.set(e, cat));
reg(Cat.photos, 'jpg jpeg jfif png gif bmp tif tiff webp heic heif avif raw cr2 cr3 nef arw dng orf rw2 raf srw psd psb xcf svg ico kra');
reg(Cat.videos, 'mp4 m4v mkv avi mov wmv webm flv f4v mpg mpeg m2ts mts 3gp vob ogv rmvb divx prproj braw r3d');
reg(Cat.music, 'mp3 flac wav aac ogg oga m4a wma opus aiff aif alac ape mid midi m4b dsf');
reg(
  Cat.documents,
  'pdf doc docx docm xls xlsx xlsm xlsb ppt pptx odt ods odp rtf txt md epub fb2 djvu mobi azw3 csv tex pages numbers key one onepkg pst ost msg eml vsdx pub xps oxps',
);
reg(Cat.archives, 'zip rar 7z tar gz tgz bz2 xz zst lz4 cab iso img vhd vhdx vmdk qcow2 dmg pkg msi msix msixbundle appx appxbundle wim esd apk xapk torrent');
reg(Cat.apps, 'exe dll ocx cpl msc drv appref-ms');
// Game data: Bethesda, Unreal, Unity, Valve, FromSoftware, Rockstar and friends.
reg(Cat.games, 'bsa ba2 esp esm esl nif dds pak upk uasset uexp ubulk utoc ucas umap bdt bhd vpk gcf forge sga rpf wad pck bank unity3d assets ress');
reg(Cat.system, 'sys mui cat etl evtx efi');
reg(Cat.caches, 'tmp temp dmp mdmp crdownload partial');
reg(
  Cat.developer,
  'js mjs cjs ts tsx jsx vue svelte py pyc pyd pyi ipynb cs csproj sln vb fs c h cpp cc cxx hpp hh rs go java class jar kt kts scala swift m mm php rb pl lua r dart sh ps1 psm1 bat cmd sql yaml yml toml lock gradle pdb obj o lib a pch ipch idb ilk exp map wasm whl nupkg gem vsix',
);

export function extOf(nameLower: string): string {
  const dot = nameLower.lastIndexOf('.');
  if (dot <= 0 || dot === nameLower.length - 1 || nameLower.length - dot > 12) return '';
  return nameLower.slice(dot + 1);
}

/** Category for a file given its parent directory context. */
export function fileCategory(parentCtx: number, nameLower: string, size: number, atVolumeRoot: boolean, platform: DesktopPlatform = 'win32'): number {
  const c = ctxCat(parentCtx);
  if (c >= 0) return c;
  if (platform === 'win32' && atVolumeRoot && (ROOT_SYSTEM_FILES.has(nameLower) || nameLower.startsWith('$'))) return Cat.system;
  const ext = extOf(nameLower);
  const cat = EXT.get(ext);
  if (cat === undefined) return Cat.other;
  if (ext === 'ts' && size > 8 * 1024 * 1024) return Cat.videos; // MPEG transport stream, not TypeScript
  if (cat === Cat.apps && parentCtx & CTX_DL) return Cat.archives; // installers in Downloads
  return cat;
}

export const INSTALLER_EXTS = new Set(['exe', 'msi', 'msix', 'msixbundle', 'appx', 'dmg', 'pkg', 'zip', 'rar', '7z', 'iso', 'img', 'cab', 'tar', 'gz', 'tgz', 'apk', 'torrent']);
