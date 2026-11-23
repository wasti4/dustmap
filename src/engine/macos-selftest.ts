
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Cat } from '../shared/types';
import { contextForPath, ctxCat } from './classify';
import { runScan } from './scanner';
import { Tree, F_DIR, F_LINK } from './tree';
import { macDrives, macHelperPath, macTrashPath, scanMount } from '../platform/macos';
import { emptyMacTrash, macProtectedPath, removeMacPath } from '../platform/mac-cleanup';

export async function runMacSelfTest() {
  const tree = new Tree(16, '/');
  tree.root = tree.add(-1, '/', F_DIR);
  const dir = tree.add(tree.root, 'Фото\\2026', F_DIR);
  const file = tree.add(dir, '春.txt', 0);
  assert.equal(tree.path(file), '/Фото\\2026/春.txt');
  const windows = new Tree(16);
  windows.root = windows.add(-1, 'C:\\', F_DIR);
  assert.equal(windows.path(windows.add(windows.root, 'Test', 0)), 'C:\\Test');

  for (const [p, category] of [
    ['/Users/test/Library/Caches/browser', Cat.caches],
    ['/Users/test/Library/Application Support/Steam', Cat.games],
    ['/Users/test/.Trash', Cat.trash],
    ['/Applications/Dustmap.app', Cat.apps],
    ['/System/Library', Cat.system],
    ['/Volumes/外部/.Trashes/501', Cat.trash],
  ] as const) {
    const root = p.startsWith('/Volumes') ? '/Volumes/外部' : '/';
    assert.equal(ctxCat(contextForPath(p, 'darwin', root).ctx), category, p);
  }
  assert.equal(ctxCat(contextForPath('/Users/test/Documents/caches', 'darwin', '/').ctx), -1);
  assert.equal(macTrashPath('/', '/Users/test', 501), '/Users/test/.Trash');
  assert.equal(macTrashPath('/Volumes/外部', '/Users/test', 501), '/Volumes/外部/.Trashes/501');
  assert.equal(scanMount('/Volumes/外部/one', ['/', '/Volumes/外部']), '/Volumes/外部');
  assert.equal(scanMount('/Volumes/外部続/one', ['/', '/Volumes/外部']), '/');

  const home = '/Users/Test';
  for (const p of ['/', '/System/Volume', '/sYsTeM/Volume', '/Volumes', '/Users/Test', '/Users/Test/Documents', '/Users/Other/file', '/Users/Test/.Trash/old', '/Volumes/External/.Trashes/501/old', '/private/var/db/file']) {
    assert.ok(macProtectedPath(p, home, '/private/var/folders/example/T'), p);
  }
  assert.ok(macProtectedPath('/Users/Test/Library/Application Support', home, '/private/var/folders/example/T'));
  assert.equal(macProtectedPath('/Users/Test/Documents/old.txt', home, '/private/var/folders/example/T'), null);
  assert.equal(macProtectedPath('/Users/Test/Library/Caches/example', home, '/private/var/folders/example/T'), null);
  assert.equal(macProtectedPath('/Volumes/External/Users/backup', home, '/private/var/folders/example/T'), null);

  if (process.platform === 'darwin') {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustmap-mac-test-'));
    try {
      const folder = path.join(root, 'Фото\\2026');
      const nested = path.join(folder, '春.bin');
      const alias = path.join(folder, 'hard-link.bin');
      const symlink = path.join(root, 'link');
      await fs.mkdir(folder);
      await fs.writeFile(nested, Buffer.alloc(128 * 1024, 27));
      await fs.link(nested, alias);
      await fs.symlink(folder, symlink);
      const diskBytes = (await fs.lstat(nested)).blocks * 512;
      const scanned = await runScan(1, { root, turbo: false }, () => {}, { cancelled: false });
      assert.equal(scanned.errors, 0);
      if (macHelperPath()) assert.ok((scanned.macBulkEntries ?? 0) > 0, 'APFS fixture should use bulk metadata');
      assert.equal(scanned.tree.aFiles[scanned.rootId], 2);
      assert.equal(scanned.tree.aSize[scanned.rootId], 256 * 1024);
      assert.equal(scanned.tree.aAlloc[scanned.rootId], diskBytes, 'hard links count once on disk');
      const found = Array.from({ length: scanned.tree.n }, (_, id) => scanned.tree.path(id));
      assert.ok(found.includes(await fs.realpath(nested)), 'preserve a literal backslash in a POSIX path');
      assert.ok(scanned.tree.flags[found.indexOf(symlink.replace(root, scanned.root))] & F_LINK);
      await assert.rejects(runScan(2, { root: nested, turbo: false }, () => {}, { cancelled: false }), /directory/i);
      await assert.rejects(removeMacPath(symlink, 'contents', root, os.tmpdir()));
      assert.equal((await fs.stat(nested)).size, 128 * 1024);
      if (macHelperPath()) {
        await removeMacPath(symlink, 'permanent', root, os.tmpdir());
        await assert.rejects(fs.lstat(symlink), { code: 'ENOENT' });
      } else {
        await assert.rejects(removeMacPath(symlink, 'permanent', root, os.tmpdir()), /native-cleanup-unavailable/);
        assert.ok((await fs.lstat(symlink)).isSymbolicLink());
      }
      assert.equal((await fs.stat(nested)).size, 128 * 1024);
      if (macHelperPath()) {
        const realRoot = await fs.realpath(root);
        const trash = path.join(realRoot, '.Trash');
        await fs.mkdir(trash);
        await fs.writeFile(path.join(trash, 'old'), 'test');
        await fs.symlink(nested, path.join(trash, 'link'));
        await emptyMacTrash(trash, realRoot);
        assert.deepEqual(await fs.readdir(trash), []);
        assert.equal((await fs.stat(nested)).size, 128 * 1024);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  const volume = process.env.DUSTMAP_TEST_VOLUME;
  if (process.platform === 'darwin' && volume) {
    const drive = (await macDrives()).find((d) => d.root === volume);
    assert.ok(drive && drive.fs === 'apfs' && drive.total > 0, 'find the mounted APFS volume');
    const root = await fs.mkdtemp(path.join(volume, 'scan-'));
    try {
      const exact = path.join(root, 'Library', 'Caches');
      const similar = path.join(root, 'Library', 'caches');
      await fs.mkdir(exact, { recursive: true });
      await fs.mkdir(similar);
      for (const dir of [exact, similar]) await fs.writeFile(path.join(dir, 'keep.dat'), Buffer.alloc(128 * 1024, 27));
      await assert.rejects(removeMacPath(similar, 'contents', root, os.tmpdir()), /not-a-cache-directory/);
      assert.equal((await fs.stat(path.join(similar, 'keep.dat'))).size, 128 * 1024);
      await removeMacPath(exact, 'contents', root, os.tmpdir());
      assert.deepEqual(await fs.readdir(exact), []);
      const scanned = await runScan(3, { root: volume, turbo: false }, () => {}, { cancelled: false });
      assert.equal(scanned.isVolume, true);
      assert.ok(Array.from({ length: scanned.tree.n }, (_, id) => scanned.tree.path(id)).includes(path.join(similar, 'keep.dat')));
      console.log('Case-sensitive APFS volume self-test passed');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  if (process.platform === 'darwin' && process.env.DUSTMAP_TEST_STARTUP === '1') {
    const root = await fs.mkdtemp(path.join(os.homedir(), 'dustmap-startup-test-'));
    try {
      const name = path.basename(root) + '.bin';
      const file = path.join(root, name);
      await fs.writeFile(file, Buffer.from('startup scan test'));
      const start = await runScan(4, { root: '/', turbo: false }, () => {}, { cancelled: false });
      assert.ok(start.isVolume && start.tree.aFiles[start.rootId] > 0, 'scan the startup disk');
      const matches = [];
      for (let id = 0; id < start.tree.n; id++) {
        if (start.tree.names[id] === name) matches.push(start.tree.path(id));
      }
      assert.deepEqual(matches, [file], 'scan the Data firmlink once through its visible path');
      console.log('Startup APFS self-test passed in ' + start.ms + ' ms');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  console.log('macOS scan and cleanup self-test passed');
}
