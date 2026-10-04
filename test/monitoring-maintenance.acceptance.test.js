import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseEnvironment } from '../monitoring/trace/setup.mjs';

test('installed CLI cold backup restores queryable history and exact inventory into fresh volumes', { skip: process.env.SPORADES_MAINTENANCE_DOCKER !== '1', timeout: 300_000 }, async t => {
  const root = process.cwd();
  const temp = await mkdtemp(path.join(root, '.sporades/maintenance-docker-'));
  const original = path.join(temp, 'original'), restored = path.join(temp, 'restored'), backup = path.join(temp, 'backup');
  await mkdir(original); await mkdir(restored);
  const prefix = 'dennis130-' + randomBytes(5).toString('hex');
  const env = { ...process.env, SPORADES_CONFIG_DIR: path.join(temp, 'config'), COMPOSE_PROJECT_NAME: prefix + '-original' };
  const command = (cmd, args, cwd = root, extra = {}) => {
    const r = spawnSync(cmd, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    return r;
  };
  const packed = command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp]);
  assert.equal(packed.status, 0);
  assert.equal(command('tar', ['-xzf', path.join(temp, JSON.parse(packed.stdout)[0].filename), '-C', temp]).status, 0);
  const bin = path.join(temp, 'package/bin/sporades.js');
  const cli = (args, extra = {}) => command(process.execPath, [bin, 'monitoring', 'stack', ...args, '--json'], root, extra);
  const compose = (dir, args, project) => command('docker', ['compose', '--env-file', '.compose.env', ...args], dir, { COMPOSE_PROJECT_NAME: project });
  t.after(async () => {
    for (const [dir, project] of [[original, prefix + '-original'], [restored, prefix + '-restored']]) compose(dir, ['down', '-v', '--rmi', 'local'], project);
    await rm(temp, { recursive: true, force: true });
  });
  const initialized = cli(['init', '--dir', original]);
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
  const sender = (action, name = 'retained-sender', host = 'retained-host') => command(process.execPath, [bin, 'monitoring', 'sender', action, '--dir', original, '--sender', name, ...(action === 'issue' ? ['--host', host] : []), '--json']);
  assert.equal(sender('issue').status, 0);
  const exportSender = async (filename, name = 'retained-sender') => {
    const out = path.join(temp, filename);
    assert.equal(command(process.execPath, [bin, 'monitoring', 'sender', 'export', '--dir', original, '--sender', name, '--out', out, '--json']).status, 0);
    return parseEnvironment(await readFile(out, 'utf8'));
  };
  const activeSender = await exportSender('active-sender.env');
  assert.equal(sender('rotate').status, 0);
  const pendingSender = await exportSender('pending-sender.env');
  assert.equal(sender('issue', 'revoked-sender', 'revoked-host').status, 0);
  const revokedSender = await exportSender('revoked-sender.env', 'revoked-sender');
  assert.equal(sender('revoke', 'revoked-sender', 'revoked-host').status, 0);
  const inventoryToken = randomBytes(24).toString('hex');
  const environment = (await readFile(path.join(original, '.env'), 'utf8')).replace('TRACE_TLS_MODE=tls', 'TRACE_TLS_MODE=proxy').replace('TRACE_PORT=8443', 'TRACE_PORT=5680') + `INVENTORY_HOSTS='{"restore-host":"${inventoryToken}"}'\nOPERATOR_LITERAL=keep:$VALUE # exact\n`;
  await writeFile(path.join(original, '.env'), environment);
  assert.equal(command(process.execPath, [path.join(original, 'setup.mjs')], original).status, 0);
  const values = parseEnvironment(await readFile(path.join(original, '.env'), 'utf8'));
  const basic = 'Basic ' + Buffer.from(values.get('TRACE_UI_USER') + ':' + values.get('TRACE_UI_PASSWORD')).toString('base64');
  const origin = 'http://127.0.0.1:5680';
  const readiness = async () => {
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(origin + '/health', { signal: AbortSignal.timeout(4000) })).status === 200) return; } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    assert.fail('monitoring did not become ready');
  };
  assert.equal(compose(original, ['up', '-d', '--build'], prefix + '-original').status, 0);
  await readiness();
  for (let i = 0; i < 60; i++) {
    if ((await fetch(origin + '/grafana/api/dashboards/uid/sporades-api', { headers: { authorization: basic } })).status === 200) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const trace = command(process.execPath, [path.join(original, 'smoke.mjs'), 'send'], original);
  assert.equal(trace.status, 0, trace.stderr);
  const traceId = trace.stdout.match(/Trace query passed: ([a-f0-9]{32})/)[1];
  const metricValue = 130;
  assert.equal((await fetch(origin + '/v1/metrics', { method: 'POST', headers: { authorization: 'Bearer ' + values.get('TRACE_INGEST_TOKEN'), 'content-type': 'application/json' }, body: JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'maintenance.history', gauge: { dataPoints: [{ timeUnixNano: String(BigInt(Date.now()) * 1000000n), asDouble: metricValue }] } }] }] }] }) })).status, 200);
  const inventory = { schemaVersion: 1, host: 'restore-host', revision: 1, capsules: [{ id: 'apps.example/notes', state: 'running', changedAt: new Date().toISOString(), release: 'release-before-backup', targets: ['https://notes.apps.example/'] }] };
  assert.equal((await fetch(origin + '/v1/inventory/restore-host', { method: 'PUT', headers: { authorization: 'Bearer ' + inventoryToken, 'content-type': 'application/json' }, body: JSON.stringify(inventory) })).status, 200);
  const metricQuery = ['exec', '-T', 'prometheus', 'wget', '-qO-', 'http://localhost:9090/api/v1/query?query=maintenance_history'];
  let metrics;
  for (let i = 0; i < 40; i++) {
    const r = compose(original, metricQuery, prefix + '-original');
    if (r.status === 0 && JSON.parse(r.stdout).data.result.length) { metrics = JSON.parse(r.stdout); break; }
    await new Promise(r => setTimeout(r, 250));
  }
  assert.equal(metrics.data.result[0].value[1], '130');
  // Active-writer denial leaves history alone and returns no credentials.
  const denied = cli(['backup', '--dir', original, '--backup', backup]);
  assert.equal(denied.status, 1);
  assert.equal(compose(original, ['stop', '--timeout', '30'], prefix + '-original').status, 0);
  const installedManifest = path.join(original, 'stack-manifest.json');
  const previous = JSON.parse(await readFile(installedManifest)); previous.packageVersion = '0.9.30';
  await writeFile(installedManifest, JSON.stringify(previous));
  const upgraded = cli(['upgrade', '--dir', original]);
  assert.equal(upgraded.status, 0, upgraded.stdout);
  assert.equal(cli(['rollback', '--dir', original]).status, 0);
  const saved = cli(['backup' , '--dir', original, '--backup', backup]);
  assert.equal(saved.status, 0, saved.stdout);
  assert.equal((await stat(backup)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(backup, 'config/.env'))).mode & 0o777, 0o600);
  for (const key of ['TRACE_INGEST_TOKEN', 'TRACE_UI_PASSWORD', 'GRAFANA_ADMIN_PASSWORD']) assert(!(saved.stdout + denied.stdout).includes(values.get(key)));
  assert.equal(cli(['backup', '--dir', original, '--backup', backup]).status, 1, 'backup overwrite is denied');
  const restoreArgs = ['restore', '--dir', restored, '--backup', backup];
  const restoreEnv = { COMPOSE_PROJECT_NAME: prefix + '-restored' };
  const wrapper = path.join(temp, 'wrapper'); await mkdir(wrapper);
  const realDocker = command('which', ['docker']).stdout.trim().split(/\r?\n/)[0];
  const interrupted = path.join(temp, 'interrupted');
  const racedBackup = path.join(temp, 'raced-backup');
  await writeFile(path.join(wrapper, 'docker'), `#!${process.execPath}\nimport fs from 'node:fs';import cp from 'node:child_process';const a=process.argv.slice(2);if(process.env.SPORADES_MUTATE_BACKUP_SOURCE&&a.includes('-cpf')&&a.includes('/backup/metrics.tar'))fs.appendFileSync(${JSON.stringify(path.join(original, '.env'))},'# concurrent operator edit\\n');if(a.includes('-xpf')&&a.includes('/backup/metrics.tar')&&!fs.existsSync(${JSON.stringify(interrupted)})){fs.writeFileSync(${JSON.stringify(interrupted)},'');process.exit(1)}const r=cp.spawnSync(${JSON.stringify(realDocker)},a,{stdio:'inherit'});process.exit(r.status??1);\n`, { mode: 0o755 });
  const raced = cli(['backup', '--dir', original, '--backup', racedBackup], { PATH: wrapper + path.delimiter + process.env.PATH, SPORADES_MUTATE_BACKUP_SOURCE: '1' });
  assert.equal(raced.status, 1, 'concurrent configuration edits prevent snapshot publication');
  await assert.rejects(access(racedBackup), /ENOENT/);
  const partial = cli(restoreArgs, { ...restoreEnv, PATH: wrapper + path.delimiter + process.env.PATH });
  assert.equal(partial.status, 1, 'interrupted volume extraction is reported as failure');
  assert.equal(await readFile(interrupted, 'utf8'), '', partial.stdout);
  assert.ok((await readFile(path.join(restored, '.env'), 'utf8')) === environment, 'restore preserves environment bytes');
  const recovered = cli(restoreArgs, restoreEnv);
  assert.equal(recovered.status, 0, recovered.stdout);
  assert.equal(JSON.parse(cli(restoreArgs, restoreEnv).stdout).data.changed, false);
  assert.ok((await readFile(path.join(restored, '.env'), 'utf8')) === environment, 'restore preserves environment bytes');
  assert.equal(compose(restored, ['up', '-d', '--build'], prefix + '-restored').status, 0);
  await readiness();
  for (const handoff of [activeSender, pendingSender]) {
    assert.equal((await fetch(origin + '/v1/metrics', { method: 'POST', headers: { authorization: 'Bearer ' + handoff.get('TRACE_INGEST_TOKEN'), 'content-type': 'application/json' }, body: '{}' })).status, 200);
    assert.equal((await fetch(origin + '/v1/inventory/restore-host', { headers: { authorization: 'Bearer ' + handoff.get('HOST_INVENTORY_TOKEN') } })).status, 403, 'retained inventory credentials cannot cross Host scopes');
  }
  assert.equal((await fetch(origin + '/api/traces/'  + traceId, { headers: { authorization: basic } })).status, 200);
  assert.equal((await fetch(origin + '/v1/metrics', { method: 'POST', headers: { authorization: 'Bearer ' + revokedSender.get('TRACE_INGEST_TOKEN'), 'content-type': 'application/json' }, body: '{}' })).status, 401, 'snapshot revocation remains enforced');
  const central = await fetch(origin + '/v1/inventory/restore-host', { headers: { authorization: 'Bearer ' + inventoryToken } });
  assert.deepEqual((await central.json()).data.inventory, inventory);
  assert.equal(JSON.parse(compose(restored, metricQuery, prefix + '-restored').stdout).data.result[0].value[1], '130');
  assert.equal(compose(restored, ['restart', 'jaeger', 'prometheus', 'gateway'], prefix + '-restored').status, 0);
  await readiness();
  assert.equal((await fetch(origin + '/api/traces/' + traceId, { headers: { authorization: basic } })).status, 200);
});
