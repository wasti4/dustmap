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
if (process.platform === 'darwin') buildMacHelper();
else buildHelper();
if (existsSync('build/icon.png')) copyFileSync('build/icon.png', 'dist-electron/icon.png');
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

/** Compiles the native APFS scanner for the architecture used by Electron. */
function buildMacHelper() {
  const src = 'src/native/mac-walker.cc';
  const out = 'dist-electron/mac-walker';
  if (existsSync(out) && statSync(out).mtimeMs >= Math.max(statSync(src).mtimeMs, statSync('scripts/build.mjs').mtimeMs)) return;
  mkdirSync('dist-electron', { recursive: true });
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  try {
    execFileSync('/usr/bin/xcrun', ['clang++', '-arch', arch, '-std=c++17', '-O2', '-mmacosx-version-min=13.0', resolve(src), '-o', resolve(out)], { stdio: 'inherit' });
    console.log('[build] macOS native walker ready');
  } catch (e) {
    if (args.has('--require-native') || process.env.CI) throw e;
    console.warn('[build] macOS native walker unavailable - portable walker will be used');
  }
}
