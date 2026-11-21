// Electron main process: window, IPC, the scan engine (utility process) and
// file operations (Recycle Bin, deletion with safety rails, elevation).
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, utilityProcess, type UtilityProcess } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import type { DriveInfo, OpResult, StartupInfo } from '../shared/types';
import { REDACT_USER } from '../shared/redact';

const argv = process.argv.slice(1);
const argValue = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const devUrl = process.env.VITE_DEV_SERVER_URL || argValue('dev-server');
const capturePath = argValue('capture');
// Dev-only video hook: --record=<dir> renders the window offscreen at 2x and hands it to
// scripts/video/recorder.cjs, which drives the UI and saves frames. Ignored in packaged builds.
const recordDir = app.isPackaged ? undefined : argValue('record');
const RECORD_SIZE = { width: 1440, height: 810 };
if (recordDir) {
  // A fresh profile per take, so prefs saved by an earlier take never leak into this one.
  const profile = path.resolve(recordDir, 'profile');
  fs.rmSync(profile, { recursive: true, force: true });
  app.setPath('userData', profile);
}
let win: BrowserWindow | null = null;

app.setAppUserModelId('io.github.dustmap');
// The UI is plain 2D (DOM + canvas). Skipping GPU acceleration saves ~300 MB of
// committed memory and a busy GPU process, at no visible cost.
app.disableHardwareAcceleration();

// ------------------------------------------------------------------ engine

class Engine {
  private proc: UtilityProcess | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private start() {
    const proc = utilityProcess.fork(path.join(__dirname, 'engine.cjs'), [], {
      serviceName: 'Dustmap Engine',
      env: { ...process.env, UV_THREADPOOL_SIZE: '16', ...(recordDir ? { DUSTMAP_REDACT: '1' } : {}) },
      execArgv: ['--expose-gc'],
      stdio: 'inherit',
    });
    proc.on('message', (m: { id?: number; result?: unknown; error?: string; type?: string }) => {
      if (typeof m?.id === 'number') {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error));
        else p.resolve(m.result);
      } else if (m?.type) {
        win?.webContents.send('engine:event', m);
      }
    });
    proc.on('exit', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      for (const p of this.pending.values()) p.reject(new Error('engine-exited'));
      this.pending.clear();
      win?.webContents.send('engine:event', { type: 'error', data: { scanId: -1, message: 'engine-crashed' } });
    });
    this.proc = proc;
  }

  call(method: string, params: unknown): Promise<unknown> {
    if (!this.proc) this.start();
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.proc!.postMessage({ id, method, params });
    });
  }

  kill() {
    this.proc?.kill();
    this.proc = null;
  }
}
const engine = new Engine();

// ------------------------------------------------------------------ helpers

const systemDrive = (process.env.SystemDrive || 'C:').toUpperCase();

function isElevated(): boolean {
  try {
    fs.closeSync(fs.openSync('\\\\.\\' + systemDrive, 'r'));
    return true;
  } catch {
    return false;
  }
}

function runPowerShell(script: string, timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout, maxBuffer: 8 << 20 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

const helperExe = path.join(__dirname, 'sc-walker.exe').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function drivesFromHelper(): Promise<DriveInfo[]> {
  const kinds: Record<string, DriveInfo['kind']> = { Fixed: 'fixed', Removable: 'removable', Network: 'network', CDRom: 'cdrom' };
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(helperExe)) return reject(new Error('no helper'));
    execFile(helperExe, ['--drives'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const rows: { root: string; label: string; fs: string; total: number; free: number; type: string }[] = JSON.parse(stdout);
        resolve(
          rows
            .filter((r) => r.total > 0)
            .map((r) => ({
              root: r.root,
              letter: r.root[0],
              label: r.label ?? '',
              fs: r.fs ?? '',
              total: r.total,
              free: r.free,
              kind: kinds[r.type] ?? 'unknown',
              system: r.root.slice(0, 2).toUpperCase() === systemDrive,
            })),
        );
      } catch (e) {
        reject(e);
      }
    });
  });
}

let drivesCache: Promise<DriveInfo[]> | null = null;
async function listDrives(): Promise<DriveInfo[]> {
  try {
    const list = await drivesFromHelper();
    if (list.length) return list;
  } catch {
    /* fall back to PowerShell */
  }
  const kinds: Record<number, DriveInfo['kind']> = { 2: 'removable', 3: 'fixed', 4: 'network', 5: 'cdrom' };
  try {
    const json = await runPowerShell(
      'Get-CimInstance -ClassName Win32_LogicalDisk | Select-Object DeviceID,VolumeName,FileSystem,Size,FreeSpace,DriveType | ConvertTo-Json -Compress',
    );
    const v = JSON.parse(json);
    const rows: { DeviceID: string; VolumeName: string; FileSystem: string; Size: number; FreeSpace: number; DriveType: number }[] = Array.isArray(v) ? v : [v];
    const list = rows
      .filter((r) => Number(r.Size) > 0)
      .map((r) => ({
        root: r.DeviceID + '\\',
        letter: r.DeviceID[0],
        label: r.VolumeName ?? '',
        fs: r.FileSystem ?? '',
        total: Number(r.Size),
        free: Number(r.FreeSpace),
        kind: kinds[r.DriveType] ?? 'unknown',
        system: r.DeviceID.toUpperCase() === systemDrive,
      }));
    if (list.length) return list;
  } catch {
    /* fall through */
  }
  const out: DriveInfo[] = [];
  for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${L}:\\`;
    try {
      const s = await fs.promises.statfs(root);
      out.push({ root, letter: L, label: '', fs: '', total: s.blocks * s.bsize, free: s.bavail * s.bsize, kind: 'fixed', system: `${L}:` === systemDrive });
    } catch {
      /* no such drive */
    }
  }
  return out;
}

/** Paths that must never be deleted from inside the app, whatever the UI says. */
function protectedReason(p: string): string | null {
  const n = path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  if (/^[a-z]:$/.test(n) || n.startsWith('\\\\?\\') || n.length < 4) return 'drive-root';
  const home = os.homedir().toLowerCase();
  const sysRoot = (process.env.SystemRoot || `${systemDrive}\\Windows`).toLowerCase();
  const sd = systemDrive.toLowerCase();
  const exact = new Set(
    [
      sysRoot,
      `${sd}\\program files`,
      `${sd}\\program files (x86)`,
      `${sd}\\programdata`,
      `${sd}\\users`,
      `${sd}\\$recycle.bin`,
      `${sd}\\system volume information`,
      `${sd}\\recovery`,
      `${sd}\\boot`,
      home,
      path.join(home, 'appdata'),
      path.join(home, 'appdata', 'local'),
      path.join(home, 'appdata', 'roaming'),
      path.join(home, 'appdata', 'locallow'),
      path.join(home, 'documents'),
      path.join(home, 'desktop'),
      path.join(home, 'downloads'),
      path.join(home, 'pictures'),
      path.join(home, 'music'),
      path.join(home, 'videos'),
      path.join(home, 'onedrive'),
    ].map((x) => x.toLowerCase()),
  );
  if (exact.has(n)) return 'protected-folder';
  if (n.startsWith(sysRoot + '\\') && !n.startsWith(sysRoot + '\\temp')) return 'windows';
  const base = path.basename(n);
  if (/^[a-z]:\\[^\\]+$/.test(n) && ['pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'bootmgr'].includes(base)) return 'system-file';
  return null;
}

/** Deletes as much as possible, continuing past locked files. Returns true if nothing is left. */
async function removeBestEffort(p: string): Promise<boolean> {
  try {
    await fs.promises.rm(p, { recursive: true, force: true, maxRetries: 1 });
    return !fs.existsSync(p);
  } catch {
    /* partial: fall back to entry-by-entry */
  }
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(p);
  } catch {
    return true;
  }
  if (st.isDirectory() && !st.isSymbolicLink()) {
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(p);
    } catch {
      return false;
    }
    let all = true;
    for (let i = 0; i < names.length; i += 16) {
      const res = await Promise.all(names.slice(i, i + 16).map((n) => removeBestEffort(path.join(p, n))));
      if (res.includes(false)) all = false;
    }
    if (!all) return false;
    try {
      await fs.promises.rmdir(p);
      return true;
    } catch {
      return false;
    }
  }
  try {
    await fs.promises.unlink(p);
    return true;
  } catch {
    try {
      await fs.promises.chmod(p, 0o666);
      await fs.promises.unlink(p);
      return true;
    } catch {
      return false;
    }
  }
}

function relaunchElevated(resumeRoot?: string): Promise<boolean> {
  const quoteArg = (a: string) => '"' + a.replace(/(\\+)$/, '$1$1') + '"';
  const args: string[] = [];
  if (!app.isPackaged) args.push(app.getAppPath());
  if (devUrl) args.push(`--dev-server=${devUrl}`);
  if (resumeRoot) args.push(`--scan=${resumeRoot}`);
  const ps = (s: string) => "'" + s.replace(/'/g, "''") + "'";
  const argList = args.length ? ` -ArgumentList ${args.map((a) => ps(quoteArg(a))).join(',')}` : '';
  // A portable build runs from a temporary copy; relaunch the original .exe instead.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const cmd = `Start-Process -FilePath ${ps(exe)}${argList} -Verb RunAs`;
  return runPowerShell(cmd, 120000).then(
    () => {
      setTimeout(() => app.quit(), 200);
      return true;
    },
    () => false,
  );
}

// ------------------------------------------------------------------ IPC

function registerIpc() {
  ipcMain.handle('startup', (): StartupInfo => {
    const scan = argValue('scan');
    return { elevated: isElevated(), autoScan: scan, systemDrive, home: recordDir ? path.join(path.dirname(os.homedir()), REDACT_USER) : os.homedir(), version: app.getVersion() };
  });
  ipcMain.handle('drives', async (_e, refresh?: boolean) => {
    if (!drivesCache || refresh) drivesCache = listDrives();
    return drivesCache;
  });
  ipcMain.handle('relaunchElevated', (_e, root?: string) => relaunchElevated(root));
  ipcMain.handle('chooseFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('engine', (_e, method: string, params: unknown) => {
    if (method === 'reset') {
      // Dropping the whole process returns every byte of the scanned tree to the OS.
      engine.kill();
      return true;
    }
    return engine.call(method, params);
  });
  ipcMain.handle('openPath', (_e, p: string) => shell.openPath(p));
  ipcMain.handle('reveal', (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.handle('copyText', (_e, t: string) => clipboard.writeText(t));
  ipcMain.handle('space', async (_e, root: string) => {
    try {
      const s = await fs.promises.statfs(root);
      return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch {
      return { total: 0, free: 0 };
    }
  });

  ipcMain.handle('trash', async (_e, paths: string[]): Promise<OpResult> => {
    const res: OpResult = { ok: [], failed: [] };
    for (const p of paths) {
      const why = protectedReason(p);
      if (why) {
        res.failed.push({ path: p, error: why });
        continue;
      }
      try {
        await shell.trashItem(p);
        res.ok.push(p);
      } catch (e) {
        res.failed.push({ path: p, error: String((e as Error).message ?? e) });
      }
    }
    return res;
  });

  ipcMain.handle('remove', async (_e, paths: string[], mode: 'permanent' | 'contents'): Promise<OpResult> => {
    const res: OpResult = { ok: [], failed: [] };
    for (const p of paths) {
      const why = protectedReason(p);
      if (why) {
        res.failed.push({ path: p, error: why });
        continue;
      }
      if (mode === 'contents') {
        let names: string[] = [];
        try {
          names = await fs.promises.readdir(p);
        } catch (e) {
          res.failed.push({ path: p, error: String((e as Error).message ?? e) });
          continue;
        }
        let all = true;
        for (let i = 0; i < names.length; i += 8) {
          const r = await Promise.all(names.slice(i, i + 8).map((n) => removeBestEffort(path.join(p, n))));
          if (r.includes(false)) all = false;
        }
        if (all) res.ok.push(p);
        else res.failed.push({ path: p, error: 'in-use' });
      } else if (await removeBestEffort(p)) {
        res.ok.push(p);
      } else {
        res.failed.push({ path: p, error: 'in-use' });
      }
    }
    return res;
  });

  ipcMain.handle('emptyRecycleBin', async (_e, root: string): Promise<OpResult> => {
    const letter = /^[a-z]/i.exec(root)?.[0]?.toUpperCase() ?? systemDrive[0];
    try {
      await runPowerShell(`Clear-RecycleBin -DriveLetter ${letter} -Force -ErrorAction SilentlyContinue`, 120000);
      return { ok: [root], failed: [] };
    } catch (e) {
      return { ok: [], failed: [{ path: root, error: String((e as Error).message ?? e) }] };
    }
  });

  ipcMain.handle('diskCleanup', (_e, root: string) => {
    const letter = /^[a-z]/i.exec(root)?.[0]?.toUpperCase() ?? systemDrive[0];
    spawn('cleanmgr.exe', [`/d`, letter], { detached: true, stdio: 'ignore' }).unref();
  });

  ipcMain.handle('setChrome', (_e, o: { dark: boolean; color: string; symbol: string }) => {
    saveChrome(o);
    if (!win) return;
    win.setBackgroundColor(o.color);
    try {
      win.setTitleBarOverlay({ color: o.color, symbolColor: o.symbol, height: 48 });
    } catch {
      /* not supported */
    }
  });
}

// ------------------------------------------------------------------ window

const chromeFile = () => path.join(app.getPath('userData'), 'window.json');
function loadChrome(): { color: string; symbol: string } {
  try {
    const c = JSON.parse(fs.readFileSync(chromeFile(), 'utf8'));
    if (typeof c.color === 'string' && typeof c.symbol === 'string') return c;
  } catch {
    /* first launch */
  }
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? '#0d0d0f' : '#f3f3f5', symbol: dark ? '#a1a1aa' : '#52525b' };
}
let savedChrome = '';
function saveChrome(o: { color: string; symbol: string }) {
  const json = JSON.stringify({ color: o.color, symbol: o.symbol });
  if (json === savedChrome) return;
  savedChrome = json;
  fs.promises.writeFile(chromeFile(), json).catch(() => undefined);
}

function createWindow() {
  const chrome = loadChrome();
  win = new BrowserWindow({
    width: recordDir ? RECORD_SIZE.width : 1400,
    height: recordDir ? RECORD_SIZE.height : 900,
    useContentSize: !!recordDir,
    minWidth: 760,
    minHeight: 540,
    show: false,
    backgroundColor: chrome.color,
    title: 'Dustmap',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: chrome.color, symbolColor: chrome.symbol, height: 48 },
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      ...(recordDir ? { offscreen: { deviceScaleFactor: 2 }, backgroundThrottling: false } : {}),
    },
  });
  if (!recordDir) win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!devUrl || !url.startsWith(devUrl)) e.preventDefault();
  });
  // --demo shows a synthetic drive (for screenshots); --theme/--lang force the look.
  const query: Record<string, string> = {};
  if (argv.includes('--demo')) Object.assign(query, { demo: '1', scan: 'C:\\' });
  for (const k of ['theme', 'lang']) {
    const v = argValue(k);
    if (v) query[k] = v;
  }
  if (devUrl) win.loadURL(devUrl + (Object.keys(query).length ? '?' + new URLSearchParams(query) : ''));
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { query });

  // Test hook: --capture=<png> [--capture-delay=ms] [--size=WxH] saves a screenshot and quits.
  if (capturePath) {
    const size = /^(\d+)x(\d+)$/.exec(argValue('size') ?? '');
    if (size) win.setContentSize(Number(size[1]), Number(size[2]));
    const delay = Number(argValue('capture-delay') ?? 6000);
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (argv.includes('--capture-scroll')) {
          await win!.webContents.executeJavaScript("document.querySelector('.workspace')?.scrollTo(0, 1e6)");
          await new Promise((r) => setTimeout(r, 400));
        }
        const img = await win!.webContents.capturePage();
        fs.writeFileSync(capturePath, img.toPNG());
        app.quit();
      }, delay);
    });
  }
  win.on('closed', () => {
    win = null;
  });
  if (recordDir) {
    // Loaded at runtime from the project so the recorder never ships in the bundle.
    const recorder = require(path.join(app.getAppPath(), 'scripts', 'video', 'recorder.cjs'));
    recorder.start({ win, app, outDir: path.resolve(recordDir), size: RECORD_SIZE, argv });
  }
}

app.whenReady().then(() => {
  registerIpc();
  drivesCache = listDrives();
  createWindow();
});

app.on('window-all-closed', () => {
  engine.kill();
  app.quit();
});
