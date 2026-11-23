
/** Exercise the real renderer, preload and engine with a disposable scan directory. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createRequire } from 'node:module';

const mac = process.platform === 'darwin';
const supplied = process.argv[2];
const executable = supplied ?? createRequire(import.meta.url)('electron');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dustmap-desktop-'));
const root = await fs.realpath(temp);
const fixture = path.join(root, 'scan');
const folder = path.join(fixture, mac ? 'Фото\\2026' : 'Фото 2026');
const file = path.join(folder, '春.bin');
const disposable = path.join(folder, 'trash-me.bin');
await fs.mkdir(folder, { recursive: true });
await fs.writeFile(file, Buffer.alloc(128 * 1024, 7));
await fs.writeFile(disposable, 'disposable');

const child = spawn(executable, [
  ...(supplied ? [] : ['.']),
  '--user-data-dir=' + path.join(root, 'profile'),
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0',
  '--scan=' + fixture,
  '--lang=en',
], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = new Promise((resolve) => child.once('close', resolve));
let output = '';
let startupError;
let socket;
child.on('error', (e) => { startupError = e; });
for (const stream of [child.stdout, child.stderr]) stream.on('data', (buf) => { output += buf.toString(); });

async function eventually(check, label) {
  const until = Date.now() + 40_000;
  while (Date.now() < until) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) throw new Error('Electron exited with code ' + child.exitCode);
    const value = await check();
    if (value) return value;
    await wait(250);
  }
  throw new Error('Timed out waiting for ' + label);
}

try {
  const port = await eventually(() => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1], 'DevTools');
  const page = await eventually(async () => {
    const response = await fetch('http://127.0.0.1:' + port + '/json/list');
    return (await response.json()).find((item) => item.type === 'page' && item.url.includes('index.html'));
  }, 'the app window');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const receive = pending.get(message.id);
    if (receive) receive(message);
  });
  const evaluate = async (expression) => {
    const id = ++seq;
    const message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('DevTools evaluation timed out'));
      }, 12_000);
      pending.set(id, (response) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(response);
      });
      socket.send(JSON.stringify({
        id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
    if (message.error || message.result?.exceptionDetails) {
      throw new Error(JSON.stringify(message.error ?? message.result.exceptionDetails));
    }
    return message.result.result.value;
  };

  await eventually(() => evaluate("!!document.querySelector('#global-search:not([disabled])')"), 'a completed scan');
  const startup = await evaluate('window.storage.startup()');
  assert.equal(startup.platform, process.platform);
  const drives = await evaluate('window.storage.drives(true)');
  assert.ok(drives.some((drive) => drive.system && drive.total > 0), 'startup drive is available');
  const result = await evaluate('window.storage.engine("summary")');
  assert.equal(result.root, fixture);
  assert.equal(result.errors, 0);
  assert.equal(result.files, 2);
  const lookup = await evaluate('window.storage.engine("search", { scopeId: ' + result.rootId + ', metric:"alloc", query:"*.bin", limit:10 })');
  assert.ok(lookup.items.some((entry) => entry.path === file), 'backend returns the native file path');
  assert.equal(await evaluate('typeof window.require'), 'undefined', 'renderer remains sandboxed');
  if (mac) {
    assert.ok(drives.some((drive) => drive.root === '/' && drive.system && !drive.letter));
    assert.equal(await evaluate('document.querySelector(".titlebar kbd").textContent'), '⌘ F');
    assert.equal(await evaluate('!!document.querySelector(".turbo")'), false);
    const move = await evaluate('window.storage.trash([' + JSON.stringify(disposable) + '])');
    assert.deepEqual(move, { ok: [disposable], failed: [] });
    await assert.rejects(fs.lstat(disposable), { code: 'ENOENT' });
    const protectedResult = await evaluate('window.storage.remove(["/System"], "permanent")');
    assert.equal(protectedResult.failed[0].error, 'system-folder');
  }
  const remove = await evaluate('window.storage.remove([' + JSON.stringify(file) + '], "permanent")');
  assert.deepEqual(remove, { ok: [file], failed: [] });
  await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
  console.log('Desktop smoke test passed on ' + process.platform + ' ' + process.arch);
} catch (e) {
  console.error(output);
  throw e;
} finally {
  socket?.close();
  child.kill();
  await Promise.race([exited, wait(5000, null, { ref: false })]);
  await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}
