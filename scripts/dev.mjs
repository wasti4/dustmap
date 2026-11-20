// Development runner: Vite dev server for the UI (with hot reload), esbuild in
// watch mode for main/preload/engine, and Electron pointed at the dev server.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { context } from 'esbuild';
import { createServer } from 'vite';
import { nodeBundles } from './bundles.mjs';

const require = createRequire(import.meta.url);

const ctx = await context(nodeBundles());
await ctx.rebuild();
await ctx.watch();

const server = await createServer({ configFile: 'vite.config.mjs' });
await server.listen();
const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5199/';
console.log(`[dev] renderer at ${url}`);

const electronPath = require('electron');
const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
child.on('exit', async (code) => {
  await ctx.dispose();
  await server.close();
  process.exit(code ?? 0);
});
