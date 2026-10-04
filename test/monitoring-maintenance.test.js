import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd();

async function fixture(t) {
  const dir = await mkdtemp(path.join(root, '.sporades/maintenance-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'); await mkdir(bin);
  await writeFile(path.join(bin, 'docker'), `#!/bin/sh\ncase "$*" in\n 'compose version --short') echo 5.5.1;;\n 'version --format {{.Server.Version}}') echo 29.5.0;;\n *'config --format json'*) echo '{"services":{"collector":{"image":"otel/opentelemetry-collector-contrib:0.138.0","volumes":[{"type":"bind","target":"/etc/otelcol/config.yaml","source":"'"$PWD"'/collector.yaml"}]},"jaeger":{"image":"cr.jaegertracing.io/jaegertracing/jaeger:2.21.0"},"prometheus":{"image":"prom/prometheus:v3.13.3"}}}';;\n *'config --quiet'*) if [ -n "$REJECT_CONFIG" ]; then echo "$REJECT_CONFIG" >&2; exit 1; fi;;\n *'ps --all --quiet'*) if [ -n "$RUNNING" ]; then echo running; fi;;\n 'inspect running') echo '[{"State":{"Running":true}}]';;\n *) exit 0;;\nesac\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, SPORADES_CONFIG_DIR: path.join(dir, 'config') };
  const cli = (args, extra = {}) => spawnSync(process.execPath, [path.join(root, 'bin/sporades.js'), 'monitoring', 'stack', ...args, '--json'], { env: { ...env, ...extra }, encoding: 'utf8' });
  const stack = path.join(dir, 'stack');
  assert.equal(cli(['init', '--dir', stack]).status, 0);
  await writeFile(path.join(stack, '.env'), (await readFile(path.join(stack, '.env'), 'utf8')).replace('TRACE_TLS_MODE=tls', 'TRACE_TLS_MODE=proxy'));
  // Generate only the Compose projection; preserve literal operator environment.
  return { dir, stack, cli };
}

test('upgrade tracks generated assets, preserves overrides and literal credentials, and rolls back', async t => {
  const { stack, cli } = await fixture(t);
  const manifest = JSON.parse(await readFile(path.join(stack, 'stack-manifest.json')));
  assert.ok(manifest.assets, 'new stacks must record generated hashes');
  const original = await readFile(path.join(stack, 'README.md'), 'utf8');
  await writeFile(path.join(stack, 'README.md'), 'previous release documentation\n');
  const { createHash } = await import('node:crypto');
  manifest.assets['README.md'] = createHash('sha256').update('previous release documentation\n').digest('hex');
  manifest.packageVersion = '0.9.30';
  await writeFile(path.join(stack, 'stack-manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(stack, 'collector.yaml'), '# operator collector override\n');
  const env = await readFile(path.join(stack, '.env'), 'utf8');
  const upgraded = cli(['upgrade', '--dir', stack]);
  assert.equal(upgraded.status, 0, upgraded.stdout + upgraded.stderr);
  assert.equal(await readFile(path.join(stack, 'README.md'), 'utf8'), original);
  assert.equal(await readFile(path.join(stack, 'collector.yaml'), 'utf8'), '# operator collector override\n');
  assert.ok((await readFile(path.join(stack, '.env'), 'utf8')) === env);
  assert.ok(JSON.parse(upgraded.stdout).data.overrides.includes('collector.yaml'));
  assert.equal(cli(['upgrade', '--dir', stack]).status, 0);
  const rolled = cli(['rollback', '--dir', stack]);
  assert.equal(rolled.status, 0, rolled.stdout + rolled.stderr);
  assert.equal(await readFile(path.join(stack, 'README.md'), 'utf8'), 'previous release documentation\n');
  assert.ok((await readFile(path.join(stack, '.env'), 'utf8')) === env);
  assert.equal(JSON.parse(cli(['rollback', '--dir', stack]).stdout).data.changed, false);
});

test('maintenance rejects running writers and opaque invalid configuration before replacements', async t => {
  const { stack, cli } = await fixture(t);
  const before = await readFile(path.join(stack, 'stack-manifest.json'), 'utf8');
  const manifest = JSON.parse(before); manifest.packageVersion = '0.9.30';
  await writeFile(path.join(stack, 'stack-manifest.json'), JSON.stringify(manifest));
  const expected = await readFile(path.join(stack, 'stack-manifest.json'), 'utf8');
  for (const extra of [{ RUNNING: '1' }, { REJECT_CONFIG: 'interpolated-password-SECRET' }]) {
    const result = cli(['upgrade', '--dir', stack], extra);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /interpolated-password-SECRET/);
    assert.equal(await readFile(path.join(stack, 'stack-manifest.json'), 'utf8'), expected);
  }
  await writeFile(path.join(stack, '.env'), 'TRACE_TLS_MODE=unrecognized-secret\n');
  const invalid = cli(['upgrade', '--dir', stack]);
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /unrecognized-secret/);
  assert.equal(await readFile(path.join(stack, 'stack-manifest.json'), 'utf8'), expected);
});

test('interrupted generated-file publication is recovered before retry; rollback refuses later operator edits', async t => {
  const { stack, cli } = await fixture(t);
  const saved = await readFile(path.join(stack, 'README.md'));
  await mkdir(path.join(stack, '.maintenance'), { mode: 0o700 });
  await writeFile(path.join(stack, '.maintenance/journal.json'), JSON.stringify({ 'README.md': saved.toString('base64') }), { mode: 0o600 });
  await writeFile(path.join(stack, 'README.md'), 'interrupted replacement');
  assert.equal(cli(['upgrade', '--dir', stack]).status, 0);
  assert.deepEqual(await readFile(path.join(stack, 'README.md')), saved);
  const manifest = JSON.parse(await readFile(path.join(stack, 'stack-manifest.json')));
  manifest.packageVersion = '0.9.30';
  await writeFile(path.join(stack, 'stack-manifest.json'), JSON.stringify(manifest));
  assert.equal(cli(['upgrade', '--dir', stack]).status, 0);
  await writeFile(path.join(stack, 'stack-manifest.json'), JSON.stringify({ ...manifest, packageVersion: '0.9.29' }));
  assert.equal(cli(['rollback', '--dir', stack]).status, 1);
});

test('a live maintenance owner excludes concurrency and SIGKILL releases ownership for journal recovery', async t => {
  const { stack, cli } = await fixture(t);
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const state = path.join(stack, '.maintenance'); await mkdir(state, { mode: 0o700 });
  const original = await readFile(path.join(stack, 'README.md'));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {DatabaseSync} from 'node:sqlite';import {writeFileSync,chmodSync} from 'node:fs';const db=new DatabaseSync(${JSON.stringify(path.join(state, 'lock.sqlite'))});chmodSync(${JSON.stringify(path.join(state, 'lock.sqlite'))},0o600);db.exec('BEGIN IMMEDIATE');writeFileSync(${JSON.stringify(path.join(state, 'journal.json'))},${JSON.stringify(JSON.stringify({ 'README.md': original.toString('base64') }))},{mode:0o600});writeFileSync(${JSON.stringify(path.join(stack, 'README.md'))},'interrupted candidate');process.stdout.write('ready');setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  assert.equal(cli(['upgrade', '--dir', stack]).status, 1, 'active OS writer lock excludes publication');
  assert.equal(await readFile(path.join(stack, 'README.md'), 'utf8'), 'interrupted candidate');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const recovered = cli(['upgrade', '--dir', stack]);
  assert.equal(recovered.status, 0, recovered.stdout);
  assert.deepEqual(await readFile(path.join(stack, 'README.md')), original);
});

test('schema-3 upgrade requires a matching trusted baseline and unsafe generated paths fail closed', async t => {
  const { dir, stack, cli } = await fixture(t);
  const manifest = JSON.parse(await readFile(path.join(stack, 'stack-manifest.json')));
  const legacy = { schemaVersion: 3, packageVersion: manifest.packageVersion };
  await writeFile(path.join(stack, 'stack-manifest.json'), JSON.stringify(legacy));
  assert.equal(cli(['upgrade', '--dir', stack]).status, 1);
  const baseline = path.join(dir, 'baseline');
  const { cp, symlink } = await import('node:fs/promises');
  await cp(stack, baseline, { recursive: true, filter: file => !file.includes('.maintenance') });
  assert.equal(cli(['upgrade', '--dir', stack, '--baseline', baseline]).status, 0);
  const outside = path.join(dir, 'outside'); await writeFile(outside, 'retained private data');
  await rm(path.join(stack, 'collector.yaml')); await symlink(outside, path.join(stack, 'collector.yaml'));
  assert.equal(cli(['upgrade', '--dir', stack]).status, 1);
  assert.equal(await readFile(outside, 'utf8'), 'retained private data');
});
