
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Cat } from '../shared/types';
import { contextForPath, ctxCat } from './classify';
import { runScan } from './scanner';
import { Tree, F_DIR, F_LINK } from './tree';
import { macHelperPath, macTrashPath, scanMount } from '../platform/macos';
import { macProtectedPath, removeMacPath } from '../platform/mac-cleanup';

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
      await removeMacPath(symlink, 'permanent', root, os.tmpdir());
      await assert.rejects(fs.lstat(symlink), { code: 'ENOENT' });
      assert.equal((await fs.stat(nested)).size, 128 * 1024);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  console.log('macOS scan and cleanup self-test passed');
}
