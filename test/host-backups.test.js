import { createHostFixture, hostFixtureConfig, removeHostFixture } from './support/host-fixture-root.js';
import { withFixtureUmask } from './support/fixture-umask.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { attemptJournalPath } from '../dist/deploy-files.js';
import { atomicBackupJson, backupTimerUnits, configureHostBackups, createHostBackup, hostBackupDirectory, hostBackupRetention, hostBackupStatus, listHostBackups, pruneHostBackups, publishHostBackupMetric, recoverHostBackupRestore, restoreHostBackup, trustedBackupPath, validateHostBackupPolicy } from '../dist/cli/host-backups.js';

const root = process.cwd();
const hasRestic = spawnSync('restic', ['version']).status === 0;
async function fixture(fn) {
  const dir = await createHostFixture('sporades-backup-', { privateAncestors: true });
  try { await withFixtureUmask(() => fn(dir)); } finally { await removeHostFixture(dir); }
}
function policy(dir) { return { repository: path.join(dir, 'repository'), passwordFile: path.join(dir, 'password'), schedule: null, retention: 1, maxAgeHours: 26 }; }
function host(dir) { return { alias: 'local', domain: 'backup.example.test', scheme: 'https', remoteRoot: path.join(dir, 'host') }; }
function restic(p, args, options = {}) {
  const result = spawnSync('restic', ['--no-cache', ...args], { env: { PATH: process.env.PATH, RESTIC_REPOSITORY: p.repository, RESTIC_PASSWORD_FILE: p.passwordFile }, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
async function target(h, subname) {
  const data = path.join(h.remoteRoot, 'hosts', h.domain, 'capsules', subname, 'data');
  await mkdir(path.join(data, 'files', 'empty'), { recursive: true });
  return { host: h, subname, releaseId: 'release-one', data };
}
function database(file, text) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT)');
  db.prepare('INSERT INTO items(body) VALUES (?)').run(text);
  return db;
}

test('backup policy is opt-in, bounded and only permits explicit local or HTTPS S3 targets', () => {
  const p = policy('/test');
  assert.deepEqual(validateHostBackupPolicy(p), p);
  assert.equal(validateHostBackupPolicy({ ...p, repository: 's3:https://fsn1.example.test/bucket/capsules' }).repository, 's3:https://fsn1.example.test/bucket/capsules');
  for (const extra of [{ schedule: '* * * * *' }, { retention: 0 }, { maxAgeHours: 0 }, { repository: 's3:http://insecure/bucket' }, { repository: 's3:https://user:secret@example.test/bucket' }, { repository: 'sftp:user@host:path' }, { passwordFile: '../password' }, { password: 'secret' }]) assert.throws(() => validateHostBackupPolicy({ ...p, ...extra }));
  const timer = backupTimerUnits(host('/test'), { ...p, schedule: 'daily' });
  assert.match(timer.timer, /OnCalendar=daily\nPersistent=true/);
  assert.match(timer.service, /UMask=0077/);
  assert.ok(timer.service.includes(`After=docker.service ${timer.name.replace('sporades-backups-', 'sporades-capsules-')}.service`));
  assert.match(timer.service, /--backup-host/);
  assert.doesNotMatch(timer.service, /secret|password/);
  assert.match(backupTimerUnits({ ...host('/test'), remoteRoot: '/srv/host$unit%' }, p).service, /host\$\$unit%%/);
});

test('day-based retention is optional, bounded and leaves count-only policies unchanged', () => {
  const p = policy('/test');
  assert.equal('retentionDays' in validateHostBackupPolicy(p), false);
  assert.deepEqual(validateHostBackupPolicy({ ...p, retentionDays: 30 }), { ...p, retentionDays: 30 });
  assert.equal(validateHostBackupPolicy({ ...p, retentionDays: 3650 }).retentionDays, 3650);
  for (const retentionDays of [0, -1, 1.5, 3651, '30', '30d', null, Number.NaN, Infinity, true, [30], { days: 30 }]) {
    assert.throws(() => validateHostBackupPolicy({ ...p, retentionDays }), /Invalid Host backup policy/, String(retentionDays));
  }
});

test('prune passes the exact restic retention rule and reports it', () => fixture(async dir => {
  const h = host(dir), p = policy(dir), calls = path.join(dir, 'restic-calls');
  await writeFile(p.passwordFile, 'private-key', { mode: 0o600 });
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  await writeFile(path.join(bin, 'restic'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');console.log('[]');\n`, { mode: 0o755 });
  const before = process.env.PATH;
  try {
    process.env.PATH = bin + path.delimiter + before;
    const tagged = `sporades:${h.domain}:source`;
    // Count-only policies keep the exact pre-existing invocation and result.
    assert.deepEqual(await pruneHostBackups({ ...p, retention: 7 }, h, 'source'), { pruned: true, retention: 7 });
    assert.deepEqual(await pruneHostBackups({ ...p, retention: 7, retentionDays: 30 }, h, 'source'), { pruned: true, retention: 7, retentionDays: 30 });
    const commands = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(commands, [
      ['--no-cache', '--json', 'forget', '--tag', tagged, '--group-by', 'tags', '--keep-last', '7', '--prune'],
      ['--no-cache', '--json', 'forget', '--tag', tagged, '--group-by', 'tags', '--keep-last', '7', '--keep-within', '30d', '--prune'],
    ]);
  } finally { process.env.PATH = before; }
}));

test('backup status reports the effective retention rule', () => fixture(async dir => {
  const h = host(dir), p = policy(dir), backups = hostBackupDirectory(h);
  await mkdir(backups, { recursive: true, mode: 0o700 });
  await writeFile(p.passwordFile, 'private-key', { mode: 0o600 });
  assert.deepEqual(await hostBackupRetention(h), null);
  await atomicBackupJson(path.join(backups, 'policy.json'), { ...p, retention: 3 });
  assert.deepEqual(await hostBackupRetention(h), { keepLast: 3, keepWithinDays: null });
  await atomicBackupJson(path.join(backups, 'policy.json'), { ...p, retention: 3, retentionDays: 30 });
  assert.deepEqual(await hostBackupRetention(h), { keepLast: 3, keepWithinDays: 30 });
  // Per-Capsule freshness (health, doctor, metrics) keeps its existing shape.
  assert.deepEqual(Object.keys(await hostBackupStatus(h, 'source')).sort(), ['ageSeconds', 'configured', 'lastBackupAt', 'maxAgeSeconds', 'stale']);
}));

test('keep-within retains every recent snapshot regardless of manual runs and prunes older ones', { skip: !hasRestic && 'Install restic to run encrypted local repository acceptance', timeout: 180000 }, () => fixture(async dir => {
  const p = policy(dir), h = host(dir), tagged = `sporades:${h.domain}:source`;
  await writeFile(p.passwordFile, 'high-entropy-test-backup-password\n', { mode: 0o600 });
  restic(p, ['init']);
  const content = path.join(dir, 'content');
  await mkdir(content);
  const now = Date.now(), day = 86400_000;
  // Daily snapshots plus a burst of manual/rehearsal/catch-up snapshots inside the window.
  const ages = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 1, 2, 5, 10, 20, 29, 31, 45, 90];
  const ids = new Map();
  for (const age of ages) {
    await writeFile(path.join(content, 'value'), String(age));
    const time = new Date(now - age * day).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    const output = restic(p, ['--json', 'backup', '--host', h.domain, '--tag', tagged, '--time', time, '--', 'value'], { cwd: content });
    ids.set(age, output.trim().split('\n').map(JSON.parse).find(v => v.message_type === 'summary').snapshot_id);
  }
  const other = restic(p, ['--json', 'backup', '--host', h.domain, '--tag', `sporades:${h.domain}:other`, '--time', new Date(now - 90 * day).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''), '--', 'value'], { cwd: content });
  const otherId = other.trim().split('\n').map(JSON.parse).find(v => v.message_type === 'summary').snapshot_id;
  // keep-last alone would retain only three snapshots, covering well under a day.
  await pruneHostBackups({ ...p, retention: 3, retentionDays: 30 }, h, 'source');
  const kept = new Set((await listHostBackups(p, h, 'source')).map(s => s.id));
  for (const [age, id] of ids) assert.equal(kept.has(id), age < 30, `snapshot aged ${age} days`);
  // The count rule still applies when it retains more than the day rule.
  await pruneHostBackups({ ...p, retention: 12, retentionDays: 1 }, h, 'source');
  assert.equal((await listHostBackups(p, h, 'source')).length, 12);
  await pruneHostBackups({ ...p, retention: 2 }, h, 'source');
  assert.deepEqual((await listHostBackups(p, h, 'source')).map(s => s.id), [ids.get(0), ids.get(0.1)]);
  // Pruning is scoped to its Capsule tag.
  assert.deepEqual((await listHostBackups(p, h, 'other')).map(s => s.id), [otherId]);
}));

test('backup keys reject readable permissions and symlinks', () => fixture(async dir => {
  const key = path.join(dir, 'key');
  await writeFile(key, 'secret', { mode: 0o600 });
  await trustedBackupPath(key, true);
  await chmod(key, 0o644);
  await assert.rejects(trustedBackupPath(key, true), /private/);
  await symlink(key, path.join(dir, 'link'));
  await assert.rejects(trustedBackupPath(path.join(dir, 'link')), /Unsafe/);
}));

test('unconfigured backup inspection preserves existing Hosts without imposing backup path policy', () => fixture(async dir => {
  const shared = path.join(dir, 'shared');
  await mkdir(shared); await chmod(shared, 0o777);
  assert.deepEqual(await hostBackupStatus(host(shared), 'source'), { configured: false });
}));

test('backup metrics stay exporter-readable on creation and replacement under umask 0077', () => fixture(async dir => {
  const previousUmask = process.umask(0o077);
  try {
    const h = host(dir), p = policy(dir), backups = hostBackupDirectory(h);
    await mkdir(backups, { recursive: true, mode: 0o700 });
    await atomicBackupJson(path.join(backups, 'policy.json'), p);
    await writeFile(p.passwordFile, 'private-backup-password', { mode: 0o600 });
    const metrics = path.join(h.remoteRoot, 'backup-metrics');
    for (const maxAgeHours of [26, 48]) {
      await atomicBackupJson(path.join(backups, 'policy.json'), { ...p, maxAgeHours });
      await publishHostBackupMetric(h, 'source');
      // The exporter runs as UID 65534: other-user read/traverse bits are required
      // on its bind-mounted directory and read bits on every published file.
      assert.equal((await lstat(metrics)).mode & 0o777, 0o755);
      const files = await readdir(metrics);
      assert.equal(files.length, 1, 'atomic publication leaves no temporary file');
      const file = path.join(metrics, files[0]);
      assert.equal((await lstat(file)).mode & 0o777, 0o644);
      assert.match(await readFile(file, 'utf8'), new RegExp(`sporades_backup_max_age_seconds\\{[^\\n]+\\} ${maxAgeHours * 3600}\\n`));
      assert.equal(process.umask(), 0o077);
      assert.equal((await lstat(backups)).mode & 0o777, 0o700);
      for (const secret of [p.passwordFile, path.join(backups, 'policy.json')]) {
        assert.equal((await lstat(secret)).mode & 0o777, 0o600);
      }
      // Also repair a directory created by an earlier scheduled run with this umask.
      await chmod(metrics, 0o700);
    }
  } finally { process.umask(previousUmask); }
}));

test('restore journal rolls back either interrupted rename and is idempotent', () => fixture(async dir => {
  const data = path.join(dir, 'data');
  const journal = path.join(dir, '.backup-restore.json');
  for (const phase of ['before-swap', 'after-swap', 'committed']) {
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, 'value'), 'old');
    await atomicBackupJson(journal, { version: 1, phase: 'prepared' });
    await rename(data, path.join(dir, '.backup-previous'));
    if (phase !== 'before-swap') {
      await mkdir(data);
      await writeFile(path.join(data, 'value'), 'new');
    }
    if (phase === 'committed') await atomicBackupJson(journal, { version: 1, phase: 'committed' });
    await recoverHostBackupRestore(data);
    await recoverHostBackupRestore(data);
    assert.equal(await readFile(path.join(data, 'value'), 'utf8'), phase === 'committed' ? 'new' : 'old');
    await rm(data, { recursive: true });
  }
}));

test('existing restore journals retain strict path and permission validation', () => fixture(async dir => {
  const capsule = path.join(dir, 'capsule');
  const data = path.join(capsule, 'data');
  const journal = path.join(capsule, '.backup-restore.json');
  await mkdir(data, { recursive: true });
  await writeFile(path.join(data, 'value'), 'unchanged');
  for (const attack of ['readable-journal', 'writable-ancestor', 'dangling-symlink']) {
    if (attack === 'dangling-symlink') await symlink(path.join(dir, 'absent'), journal);
    else {
      await atomicBackupJson(journal, { version: 1, phase: 'committed' });
      if (attack === 'readable-journal') await chmod(journal, 0o644);
      else await chmod(capsule, 0o777);
    }
    await assert.rejects(recoverHostBackupRestore(data), /private|Unsafe/, attack);
    assert.equal(await readFile(path.join(data, 'value'), 'utf8'), 'unchanged');
    assert.equal((await lstat(journal)).isSymbolicLink(), attack === 'dangling-symlink');
    await rm(journal);
    await chmod(capsule, 0o700);
  }
}));

test('backup CLI refuses restore without exact destination confirmation before SSH', () => fixture(async dir => {
  const result = spawnSync(process.execPath, ['bin/sporades.js', 'host', 'backup', 'restore', '--subname', 'source', '--to-subname', 'staging', '--id', 'a'.repeat(64), '--confirm', 'source', '--json'], { cwd: root, env: { ...process.env, SPORADES_CONFIG_DIR: hostFixtureConfig(dir) }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).error.message, /confirmation/);
}));

test('encrypted restic round trip, Capsule isolation, retention and corruption rejection', { skip: !hasRestic && 'Install restic to run encrypted local repository acceptance', timeout: 180000 }, () => fixture(async dir => {
  const p = policy(dir), h = host(dir);
  await mkdir(h.remoteRoot, { recursive: true });
  await mkdir(path.join(h.remoteRoot, 'hosts', h.domain), { recursive: true });
  await writeFile(p.passwordFile, 'high-entropy-test-backup-password\n', { mode: 0o600 });
  restic(p, ['init']);
  await configureHostBackups(h, p);
  const source = await target(h, 'source'), destination = await target(h, 'staging');
  const db = database(path.join(source.data, 'data.db'), 'customer record only encrypted');
  // VACUUM INTO must include committed WAL data while the connection remains open.
  await writeFile(path.join(source.data, 'files', 'upload.bin'), Buffer.from([0, 255, 42, 7]));
  await writeFile(path.join(destination.data, 'target-key'), 'target-owned-secret', { mode: 0o600 });
  await writeFile(path.join(destination.data, 'data.db-journal'), 'old SQLite rollback journal');
  let captured = false;
  const first = await createHostBackup(p, source, async () => { captured = true; });
  assert.equal(captured, true);
  assert.equal(first.manifest.releaseId, source.releaseId);
  assert.equal(first.manifest.fileCount, 2);
  assert.equal(first.manifest.checksums, undefined);
  assert.match(first.manifest.schemaHash, /^[a-f0-9]{64}$/);
  assert.equal((await hostBackupStatus(h, 'source')).stale, false);
  assert.equal((await hostBackupStatus(h, 'staging')).stale, true);
  await publishHostBackupMetric(h, 'source');
  const metrics = await readdir(path.join(h.remoteRoot, 'backup-metrics'));
  assert.match(await readFile(path.join(h.remoteRoot, 'backup-metrics', metrics[0]), 'utf8'), /sporades_backup_last_success_seconds/);
  const restored = await restoreHostBackup(p, destination, 'source', first.id);
  assert.equal(restored.restartRequired, true);
  const check = new DatabaseSync(path.join(destination.data, 'data.db'), { readOnly: true });
  assert.equal(check.prepare('SELECT body FROM items').get().body, 'customer record only encrypted');
  check.close();
  assert.deepEqual(await readFile(path.join(destination.data, 'files', 'upload.bin')), Buffer.from([0, 255, 42, 7]));
  assert.equal((await lstat(path.join(destination.data, 'files', 'empty'))).isDirectory(), true);
  assert.equal(await readFile(path.join(destination.data, 'target-key'), 'utf8'), 'target-owned-secret');
  await assert.rejects(readFile(path.join(destination.data, 'data.db-journal')), { code: 'ENOENT' });
  await assert.rejects(restoreHostBackup(p, destination, 'other', first.id), /does not belong/);
  // A valid encrypted snapshot carrying an altered file must still fail its manifest checks.
  const tampered = path.join(dir, 'tampered');
  restic(p, ['restore', first.id, '--target', tampered]);
  await writeFile(path.join(tampered, 'files', 'upload.bin'), 'tampered');
  const output = restic(p, ['--json', 'backup', '--host', h.domain, '--tag', `sporades:${h.domain}:source`, '--', 'data.db', 'files', 'manifest.json'], { cwd: tampered });
  const badId = output.trim().split('\n').map(JSON.parse).find(v => v.message_type === 'summary').snapshot_id;
  await assert.rejects(restoreHostBackup(p, destination, 'source', badId), /checksums/);
  assert.deepEqual(await readFile(path.join(destination.data, 'files', 'upload.bin')), Buffer.from([0, 255, 42, 7]));
  db.prepare('INSERT INTO items(body) VALUES (?)').run('second');
  const latest = await createHostBackup(p, source);
  db.close();
  assert.ok((await listHostBackups(p, h, 'source')).length >= 3);
  await pruneHostBackups(p, h, 'source');
  assert.deepEqual((await listHostBackups(p, h, 'source')).map(s => s.id), [latest.id]);
  // Corruption of encrypted repository snapshot metadata is rejected by restic itself.
  await chmod(path.join(p.repository, 'snapshots', latest.id), 0o600);
  await writeFile(path.join(p.repository, 'snapshots', latest.id), Buffer.from('corrupted encrypted snapshot'));
  await assert.rejects(restoreHostBackup(p, destination, 'source', latest.id), /repository operation failed|does not belong/);
  assert.deepEqual(await readFile(path.join(destination.data, 'files', 'upload.bin')), Buffer.from([0, 255, 42, 7]));
}));

test('S3 policy uses protected credentials, strips ambient overrides, and redacts failures', () => fixture(async dir => {
  const h = host(dir), p = { ...policy(dir), repository: 's3:https://storage.example.test/bucket/prefix', credentialsFile: path.join(dir, 'credentials') };
  await mkdir(path.join(h.remoteRoot, 'hosts', h.domain), { recursive: true });
  await writeFile(p.passwordFile, 'private-key', { mode: 0o600 });
  await writeFile(p.credentialsFile, JSON.stringify({ AWS_ACCESS_KEY_ID: 'explicit-id', AWS_SECRET_ACCESS_KEY: 'explicit-secret' }), { mode: 0o600 });
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, "package.json"), JSON.stringify({type:"commonjs"}));
  const executable = path.join(bin, 'restic');
  await writeFile(executable, `#!${process.execPath}\nconst {writeFileSync}=require('node:fs'); writeFileSync(${JSON.stringify(path.join(dir, 'received'))}, JSON.stringify({args:process.argv.slice(2), env:process.env})); console.log('[]');\n`, { mode: 0o755 });
  const before = { ...process.env };
  try {
    process.env.PATH = bin + path.delimiter + process.env.PATH;
    process.env.RESTIC_REPOSITORY = 'do-not-use';
    process.env.RESTIC_PASSWORD_COMMAND = 'do-not-execute';
    process.env.AWS_SECRET_ACCESS_KEY = 'ambient-do-not-use';
    await configureHostBackups(h, p);
    const received = JSON.parse(await readFile(path.join(dir, 'received'), 'utf8'));
    assert.equal(received.env.RESTIC_REPOSITORY, p.repository);
    assert.equal(received.env.RESTIC_PASSWORD_COMMAND, undefined);
    assert.equal(received.env.AWS_SECRET_ACCESS_KEY, 'explicit-secret');
    assert.equal(received.env.AWS_EC2_METADATA_DISABLED, 'true');
    assert.equal(received.env.AWS_CONFIG_FILE, '/dev/null');
    assert.doesNotMatch(JSON.stringify(received.args), /explicit-secret|private-key/);
    await writeFile(executable, `#!${process.execPath}\nconsole.error('explicit-secret private-key');process.exit(3);\n`, { mode: 0o755 });
    await assert.rejects(listHostBackups(p, h, 'source'), error => !/explicit-secret|private-key/.test(error.message) && /repository operation/.test(error.message));
    assert.equal((await hostBackupStatus(h, 'source')).stale, true);
  } finally { process.env = before; }
}));

test('Host timer installation and disable are repeatable and write only to the selected unit directory', () => fixture(async dir => {
  const h = host(dir), p = { ...policy(dir), repository: 's3:https://storage.example.test/bucket/prefix', schedule: 'daily' };
  await mkdir(path.join(h.remoteRoot, 'hosts', h.domain), { recursive: true });
  await mkdir(path.join(h.remoteRoot, 'bin'));
  await writeFile(path.join(h.remoteRoot, 'bin', 'sporades-host-helper'), '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(p.passwordFile, 'private-key', { mode: 0o600 });
  const bin = path.join(dir, 'bin'), units = path.join(dir, 'units'), calls = path.join(dir, 'systemctl-calls');
  await mkdir(bin); await mkdir(units);
  await writeFile(path.join(bin, "package.json"), JSON.stringify({type:"commonjs"}));
  await writeFile(path.join(bin, 'restic'), `#!${process.execPath}\nconsole.log('[]');\n`, { mode: 0o755 });
  await writeFile(path.join(bin, 'systemctl'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n'); if(process.argv[2]==='show')console.log('loaded');\n`, { mode: 0o755 });
  const before = process.env.PATH;
  try {
    process.env.PATH = bin + path.delimiter + before;
    const first = await configureHostBackups(h, p, units);
    await configureHostBackups(h, p, units);
    assert.match(await readFile(path.join(units, first.timer), 'utf8'), /OnCalendar=daily/);
    await configureHostBackups(h, { ...p, schedule: null }, units);
    const commands = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(commands.some(c => c[0] === 'enable' && c[1] === '--now'));
    assert.ok(commands.some(c => c[0] === 'disable' && c[1] === '--now'));
    await writeFile(path.join(units, first.timer), '# operator-owned\n');
    await assert.rejects(configureHostBackups(h, p, units), /operator-owned/);
  } finally { process.env.PATH = before; }
}));

test('shipped CLI and helper quiesce exact containers, restore staging, and report backup age', { skip: !hasRestic && 'Install restic for CLI backup acceptance', timeout: 180000 }, () => fixture(async dir => {
  const h = host(dir), p = policy(dir), source = await target(h, 'source'), staging = await target(h, 'staging');
  const db = database(path.join(source.data, 'data.db'), 'CLI round trip'); db.close();
  await writeFile(path.join(source.data, 'files', 'upload'), 'CLI file bytes');
  const registry = path.join(h.remoteRoot, 'hosts', h.domain, 'registry', 'capsules');
  await mkdir(registry, { recursive: true });
  for (const subname of ['source', 'staging']) {
    const capsule = path.join(h.remoteRoot, 'hosts', h.domain, 'capsules', subname);
    await mkdir(path.join(capsule, 'releases', 'release-one'), { recursive: true });
    await symlink('releases/release-one', path.join(capsule, 'current'));
    await writeFile(path.join(capsule, 'releases', 'release-one', 'sporades.json'), '{}');
    await writeFile(path.join(registry, `${subname}.json`), JSON.stringify({ subname, domain: h.domain, remoteCapsuleId: `${h.domain}/${subname}`, status: subname === 'source' ? 'running' : 'stopped', currentRelease: { id: 'release-one' } }));
  }
  const bin = path.join(dir, 'bin'), config = hostFixtureConfig(dir), state = path.join(dir, 'containers'), calls = path.join(dir, 'docker-calls');
  await mkdir(bin); await mkdir(config, { recursive: true });
  await writeFile(path.join(bin, 'package.json'), '{"type":"commonjs"}');
  await writeFile(path.join(config, 'hosts.json'), JSON.stringify({ currentHostAlias: h.alias, profiles: { [h.alias]: { ...h, server: 'fake-only' } } }));
  await writeFile(state, JSON.stringify({ source: true, staging: false }));
  await writeFile(path.join(bin, 'ssh'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const {readFileSync}=require('node:fs'); const r=spawnSync(process.execPath,[${JSON.stringify(path.join(root, 'bin', 'sporades-host-helper.js'))}],{input:readFileSync(0),env:process.env,encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status??1);\n`, { mode: 0o755 });
  await writeFile(path.join(bin, 'docker'), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n'); const state=JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8'));const sourceId='a'.repeat(64), stagingId='b'.repeat(64);const subname=args.at(-1)===sourceId||args.at(-1).endsWith('-source')?'source':'staging';if(args[0]==='inspect')console.log(JSON.stringify({Id:subname==='source'?sourceId:stagingId,State:{Running:state[subname],Restarting:false},Config:{Labels:{'com.sporades.managed':'true','com.sporades.hosted-domain':${JSON.stringify(h.domain)},'com.sporades.capsule-subname':subname,'com.sporades.release-id':process.env.FAKE_BACKUP_RELEASE_ID||'release-one'}}}));else if(args[0]==='stop'||args[0]==='start'){state[subname]=args[0]==='start';fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(state));}\n`, { mode: 0o755 });
  await writeFile(p.passwordFile, 'private-test-key', { mode: 0o600 }); restic(p, ['init']);
  const policyFile = path.join(dir, 'policy.json'); await writeFile(policyFile, JSON.stringify(p));
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, SPORADES_CONFIG_DIR: config, SPORADES_TEST_FLOCK_PATH: path.join(root, 'test', 'support', 'exec-flock.py') };
  function cli(args, expectedOk = true) {
    const result = spawnSync(process.execPath, ['bin/sporades.js', 'host', 'backup', ...args, '--json'], { cwd: root, env, encoding: 'utf8', timeout: 60000 });
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, expectedOk, JSON.stringify(body) + result.stderr);
    return body;
  }
  cli(['configure', '--file', policyFile]);
  const created = cli(['create', '--subname', 'source']).data;
  assert.equal(JSON.parse(await readFile(state, 'utf8')).source, true);
  const operations = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(operations.some(a => a[0] === 'stop' && a.at(-1) === 'a'.repeat(64)));
  assert.ok(operations.some(a => a[0] === 'start' && a.at(-1) === 'a'.repeat(64)));
  env.FAKE_BACKUP_RELEASE_ID = 'pending-old-release';
  const releaseMismatch = cli(['create', '--subname', 'source'], false);
  assert.match(releaseMismatch.error.message, /different release/);
  delete env.FAKE_BACKUP_RELEASE_ID;
  assert.equal(JSON.parse(await readFile(state, 'utf8')).source, true);
  const afterMismatch = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(afterMismatch.filter(a => a[0] === 'stop').length, operations.filter(a => a[0] === 'stop').length);
  const sourceCapsule = path.dirname(source.data);
  await rm(path.join(sourceCapsule, 'current'));
  await symlink('releases/pending-release', path.join(sourceCapsule, 'current'));
  assert.match(cli(['create', '--subname', 'source'], false).error.message, /pointer requires recovery/);
  await rm(path.join(sourceCapsule, 'current'));
  await symlink('releases/release-one', path.join(sourceCapsule, 'current'));
  const preserved = path.join(sourceCapsule, 'preserved-files');
  await mkdir(preserved);
  await atomicBackupJson(attemptJournalPath(preserved), { interrupted: true });
  assert.match(cli(['create', '--subname', 'source'], false).error.message, /Interrupted deployment/);
  await rm(attemptJournalPath(preserved));
  assert.equal(JSON.parse(await readFile(state, 'utf8')).source, true);
  assert.equal(cli(['list', '--subname', 'source']).data.snapshots[0].id, created.id);
  cli(['restore', '--subname', 'source', '--id', created.id, '--confirm', 'source'], false);
  cli(['restore', '--subname', 'source', '--to-subname', 'staging', '--id', created.id, '--confirm', 'staging']);
  assert.equal(await readFile(path.join(staging.data, 'files', 'upload'), 'utf8'), 'CLI file bytes');
  assert.equal(JSON.parse(await readFile(state, 'utf8')).staging, false);
  const status = cli(['status']).data;
  assert.equal(status.capsules.find(c => c.subname === 'source').stale, false);
  assert.equal(status.capsules.find(c => c.subname === 'staging').stale, true);
  // A stopped Capsule still exposes backup freshness through runtime health.
  const health = spawnSync(process.execPath, ['bin/sporades.js', 'host', 'health', 'staging', '--json'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(JSON.parse(health.stdout).data.backups.stale, true);
  // The scheduled worker must continue after a failed Capsule and never prune its history.
  cli(['create', '--subname', 'source']);
  const beforeFailure = cli(['list', '--subname', 'source']).data.snapshots.length;
  assert.equal(beforeFailure, 2);
  await rename(path.join(source.data, 'data.db'), path.join(source.data, 'offline.db'));
  await atomicBackupJson(path.join(hostBackupDirectory(h), 'policy.json'), { ...p, schedule: 'daily' });
  const scheduled = spawnSync(process.execPath, ['bin/sporades-host-helper.js', '--backup-host', Buffer.from(JSON.stringify(h)).toString('base64url')], { cwd: root, env, encoding: 'utf8', timeout: 90000 });
  assert.equal(scheduled.status, 1);
  const outcome = JSON.parse(scheduled.stdout);
  assert.equal(outcome.data.capsules.find(c => c.subname === 'source').ok, false);
  assert.equal(outcome.data.capsules.find(c => c.subname === 'staging').ok, true);
  assert.equal(cli(['list', '--subname', 'source']).data.snapshots.length, beforeFailure);
  assert.equal(JSON.parse(await readFile(state, 'utf8')).source, true);
  assert.equal(cli(['status']).data.capsules.find(c => c.subname === 'staging').stale, false);
  const metricDirectory = path.join(h.remoteRoot, 'backup-metrics');
  const metricFiles = await Promise.all((await readdir(metricDirectory)).map(async name => ({ name, text: await readFile(path.join(metricDirectory, name), 'utf8') })));
  const metricName = metricFiles.find(file => file.text.includes('capsule_subname="source"')).name;
  await writeFile(path.join(bin, 'caddy'), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  const failedUnregister = spawnSync(process.execPath, ['bin/sporades-host-helper.js'], { cwd: root, env: { ...env, SPORADES_FAKE_REGISTRY_ATOMIC_WRITE_FAILURE: '1' }, input: JSON.stringify({ action: 'capsule.unregister', host: h, capsule: { subname: 'source' } }), encoding: 'utf8' });
  assert.equal(JSON.parse(failedUnregister.stdout).ok, false);
  assert.notEqual(JSON.parse(await readFile(path.join(registry, 'source.json'), 'utf8')).status, 'unregistered');
  assert.match(await readFile(path.join(metricDirectory, metricName), 'utf8'), /sporades_backup_last_success_seconds/);
  await rm(path.join(registry, 'source.json'));
  assert.equal(cli(['list', '--subname', 'source']).data.snapshots.length, beforeFailure);
  cli(['prune', '--subname', 'source']);
  assert.equal(cli(['list', '--subname', 'source']).data.snapshots.length, 1);
  assert.deepEqual(cli(['status']).data.retention, { keepLast: 1, keepWithinDays: null });
  await writeFile(policyFile, JSON.stringify({ ...p, retentionDays: 30 }));
  cli(['configure', '--file', policyFile]);
  assert.deepEqual(cli(['status']).data.retention, { keepLast: 1, keepWithinDays: 30 });
  assert.equal(JSON.parse(await readFile(path.join(config, 'hosts.json'), 'utf8')).profiles[h.alias].backups.retentionDays, 30);
  assert.deepEqual(cli(['prune', '--subname', 'source']).data, { pruned: true, retention: 1, retentionDays: 30 });
  // Invalid values are refused locally before any Host contact.
  await writeFile(policyFile, JSON.stringify({ ...p, retentionDays: 0 }));
  assert.match(cli(['configure', '--file', policyFile], false).error.message, /Invalid Host backup policy/);
  assert.deepEqual(cli(['status']).data.retention, { keepLast: 1, keepWithinDays: 30 });
}));
