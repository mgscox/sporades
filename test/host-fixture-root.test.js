import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { trustedBackupPath } from '../dist/cli/host-backups.js';
import { createHostFixture, hostFixtureConfig, removeHostFixture } from './support/host-fixture-root.js';

test('Host fixtures avoid group-writable checkout ancestry without changing it', async t => {
  const originalTmp = process.env.TMPDIR;
  const unsafe = await mkdtemp(path.resolve('.agent-tmp-unsafe-host-'));
  t.after(async () => {
    if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp;
    await rm(unsafe, { recursive: true, force: true });
  });
  await chmod(unsafe, 0o775);
  process.env.TMPDIR = unsafe;
  const first = await createHostFixture('sporades-fixture-');
  const second = await createHostFixture('sporades-fixture-');
  t.after(() => Promise.all([first, second].map(dir => rm(dir, { recursive: true, force: true }))));
  assert.notEqual(first, second);
  assert.equal(first.startsWith(unsafe + path.sep), false);
  assert.equal((await lstat(first)).mode & 0o777, 0o700);
  assert.equal((await lstat(unsafe)).mode & 0o777, 0o775);
  const config = hostFixtureConfig(first);
  const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  assert(config.startsWith(repo + path.sep), 'CLI profiles stay inside the worktree');
  assert.equal(config.startsWith(first + path.sep), false);
  await mkdir(config, { recursive: true });
  await writeFile(path.join(config, 'hosts.json'), '{}');
  await removeHostFixture(first);
  await assert.rejects(lstat(first), { code: 'ENOENT' });
  await assert.rejects(lstat(config), { code: 'ENOENT' });
});

test('backup fixtures supply real protected ancestors while writable and symlink attacks still fail', async t => {
  const root = await createHostFixture('sporades-backup-fixture-', { privateAncestors: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = path.join(root, 'password');
  await writeFile(key, 'test-only-secret', { mode: 0o600 });
  await trustedBackupPath(key, true);
  await chmod(key, 0o644);
  await assert.rejects(trustedBackupPath(key, true), /private/);
  await chmod(key, 0o600);
  await symlink(key, path.join(root, 'link'));
  await assert.rejects(trustedBackupPath(path.join(root, 'link'), true), /Unsafe/);
  const unsafe = path.join(root, 'writable');
  await mkdir(unsafe, { mode: 0o777 }); await chmod(unsafe, 0o777);
  await writeFile(path.join(unsafe, 'password'), 'test-only-secret', { mode: 0o600 });
  await assert.rejects(trustedBackupPath(path.join(unsafe, 'password'), true), /private/);
});
