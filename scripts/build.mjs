// Builds the Electron main process, preload, scan engine, the native
// directory-walker helper and (unless --engine-only) the React renderer.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { nodeBundles } from './bundles.mjs';

const args = new Set(process.argv.slice(2));
const engineOnly = args.has('--engine-only');

const t = Date.now();
await build(nodeBundles({ engineOnly }));
console.log(`[build] node bundles ready in ${Date.now() - t} ms`);
buildHelper();
if (existsSync('assets/icon.png')) copyFileSync('assets/icon.png', 'dist-electron/icon.png');
if (!engineOnly) {
  await viteBuild({ configFile: 'vite.config.mjs', logLevel: 'warn' });
  console.log('[build] renderer ready');
}

/**
 * Compiles src/native/sc-walker.cs with the C# compiler that ships with
 * Windows (.NET Framework 4.x). If it is unavailable the app silently falls
 * back to the portable Node.js walker.
 */
function buildHelper() {
  if (process.platform !== 'win32') return;
  const csc = `${process.env.WINDIR ?? 'C:\\Windows'}\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe`;
  const src = 'src/native/sc-walker.cs';
  const out = 'dist-electron/sc-walker.exe';
  if (!existsSync(csc)) {
    console.warn('[build] csc.exe not found - native walker skipped (portable walker will be used)');
    return;
  }
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) return;
  mkdirSync('dist-electron', { recursive: true });
  try {
    execFileSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', `/out:${resolve(out)}`, resolve(src)], { stdio: 'inherit' });
    console.log('[build] native walker ready');
  } catch {
    console.warn('[build] native walker failed to compile - portable walker will be used');
  }
}
