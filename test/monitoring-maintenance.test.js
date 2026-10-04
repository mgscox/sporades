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
  await writeFile(path.join(bin, 'docker'), `#!/bin/sh\ncase "$*" in\n 'compose version --short') echo 5.5.1;;\n 'version --format {{.Server.Version}}') echo 29.5.0;;\n *'config --format json'*) echo '{"services":{"collector":{"image":"otel/opentelemetry-collector-contrib:0.138.0","command":["--config=/etc/otelcol/config.yaml"],"volumes":[{"type":"bind","read_only":true,"target":"/etc/otelcol/config.yaml","source":"'"$PWD"'/collector.yaml"}]},"jaeger":{"image":"cr.jaegertracing.io/jaegertracing/jaeger:2.21.0","command":["--config=/etc/jaeger/config.yaml"],"environment":{"TRACE_RETENTION":"72h"},"volumes":[{"type":"bind","target":"/etc/jaeger/config.yaml","source":"'"$PWD"'/jaeger.yaml","read_only":true}]},"prometheus":{"image":"prom/prometheus:v3.13.3","command":["--config.file=/etc/prometheus/prometheus.yml","--storage.tsdb.path=/prometheus","--storage.tsdb.retention.time=14d","--storage.tsdb.retention.size=8GB","--web.enable-otlp-receiver"],"volumes":[{"type":"bind","target":"/etc/prometheus/prometheus.yml","source":"'"$PWD"'/prometheus.yaml","read_only":true},{"type":"bind","target":"/etc/prometheus/pipeline-rules.yaml","source":"'"$PWD"'/pipeline-rules.yaml","read_only":true}]}}}';;\n *'config --quiet'*) if [ -n "$REJECT_CONFIG" ]; then echo "$REJECT_CONFIG" >&2; exit 1; fi;;\n *'ps --all --quiet'*) if [ -n "$RUNNING" ]; then echo running; fi;;\n 'inspect running') echo '[{"State":{"Running":true}}]';;\n *) exit 0;;\nesac\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, SPORADES_CONFIG_DIR: path.join(dir, 'config') };
  const cli = (args, extra = {}) => spawnSync(process.execPath, [process.env.SPORADES_MAINTENANCE_TEST_BIN ?? path.join(root, 'bin/sporades.js'), 'monitoring', 'stack', ...args, '--json'], { env: { ...env, ...extra }, encoding: 'utf8' });
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

test('upgrade and rollback refuse operator edits made during candidate validation', async t => {
  for (const action of ['upgrade', 'rollback']) {
    for (const asset of ['README.md', '.env', '.compose.env', 'collector.yaml', 'compose.override.yaml', '.private/operator.json']) {
      await t.test(`${action}: ${asset}`, async t => {
        const { dir, stack, cli } = await fixture(t);
        const manifestFile = path.join(stack, 'stack-manifest.json');
        const manifest = JSON.parse(await readFile(manifestFile));
        const { createHash } = await import('node:crypto');
        await writeFile(path.join(stack, 'README.md'), 'previous documentation\n');
        manifest.assets['README.md'] = createHash('sha256').update('previous documentation\n').digest('hex');
        await writeFile(manifestFile, JSON.stringify(manifest));
        if (action === 'rollback') assert.equal(cli(['upgrade', '--dir', stack]).status, 0);
        const before = await readFile(manifestFile);
        const readme = await readFile(path.join(stack, 'README.md'));
        const docker = path.join(dir, 'bin/docker');
        const script = await readFile(docker, 'utf8');
        await writeFile(docker, script.replace('case "$*" in', `if [ "$1" = run ]; then mkdir -p "$(dirname "$EDIT_FILE")"; printf '%s\\n' 'concurrent operator edit' >> "$EDIT_FILE"; fi\ncase "$*" in`));
        const target = path.join(stack, asset);
        const result = cli([action, '--dir', stack], { EDIT_FILE: target });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.match(await readFile(target, 'utf8'), /concurrent operator edit/);
        assert.deepEqual(await readFile(manifestFile), before, 'manifest must not be published');
        if (asset !== 'README.md') assert.deepEqual(await readFile(path.join(stack, 'README.md')), readme);
        await assert.rejects(readFile(path.join(stack, '.maintenance/journal.json')), { code: 'ENOENT' });
      });
    }
  }
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

test('large cold snapshots hash archive bytes beyond the Node whole-file read limit', async t => {
  const { dir, stack, cli } = await fixture(t);
  const docker = path.join(dir, 'bin/docker');
  await writeFile(docker, `#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';const a=process.argv.slice(2);if(a[0]==='compose'&&a[1]==='version')console.log('5.5.1');else if(a[0]==='version')console.log('29.5.0');else if(a.includes('config')){const services={},volumes={};for(const [key,service,target] of [['traces','jaeger','/badger'],['metrics','prometheus','/prometheus'],['grafana','grafana','/var/lib/grafana'],['inventory','gateway','/inventory']]){services[service]={volumes:[{type:'volume',source:key,target}]};volumes[key]={name:'large_'+key};}console.log(JSON.stringify({services,volumes}));}else if(a[0]==='run'){const bind=a.find(x=>x.startsWith('type=bind,src='));const location=bind.match(/^type=bind,src=(.*),dst=\\/backup$/)[1];const filename=path.basename(a.find(x=>x.startsWith('/backup/')));const out=path.join(location,filename);fs.writeFileSync(out,'',{mode:0o600});fs.truncateSync(out,filename==='metrics.tar'?2147484160:512);}\n`, { mode: 0o755 });
  const backup = path.join(dir, 'large-backup');
  const saved = cli(['backup', '--dir', stack, '--backup', backup]);
  assert.equal(saved.status, 0, saved.stdout);
  const manifest = JSON.parse(await readFile(path.join(backup, 'backup-manifest.json')));
  assert.equal(manifest.files['metrics.tar'], '17f5b6a32ce5d36010fef46f65d8969ffa79d29e32850391c64f45f6807a51db');
});

// These probes model Compose's effective projection, rather than the generated filenames.
test('upgrade validates effective backend mounts and rejects unsupported invocation overrides before publication', async t => {
  for (const variant of ['prometheus mount', 'jaeger mount', 'prometheus command', 'jaeger environment', 'collector entrypoint']) {
    await t.test(variant, async t => {
      const { dir, stack, cli } = await fixture(t);
      const manifestFile = path.join(stack, 'stack-manifest.json');
      const manifest = JSON.parse(await readFile(manifestFile)); manifest.packageVersion = '0.9.29';
      await writeFile(manifestFile, JSON.stringify(manifest));
      const before = await readFile(manifestFile);
      const readme = await readFile(path.join(stack, 'README.md'));
      await writeFile(path.join(stack, 'operator-backend.yaml'), 'malformed-secret: [\n');
      const wrapper = path.join(dir, 'bin/docker');
      const script = await readFile(wrapper, 'utf8');
      let altered = script;
      if (variant.endsWith('mount')) {
        const file = variant.startsWith('jaeger') ? 'jaeger.yaml' : 'prometheus.yaml';
        altered = altered.replace('/' + file, '/operator-backend.yaml');
      } else if (variant === 'prometheus command') altered = altered.replace('--config.file=/etc/prometheus/prometheus.yml', '--config.file=/etc/prometheus/unvalidated.yml');
      else if (variant === 'jaeger environment') altered = altered.replace('"TRACE_RETENTION":"72h"', '"UNSUPPORTED":"secret"');
      else altered = altered.replace('"collector":{', '"collector":{"entrypoint":["sh"],');
      // The real validators reject the malformed file when that effective source is mounted.
      altered = altered.replace('case "$*" in', 'case "$*" in\n *type=bind,src=*/operator-backend.yaml*) echo malformed-secret >&2; exit 1;;');
      await writeFile(wrapper, altered);
      const result = cli(['upgrade', '--dir', stack]);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /malformed-secret|UNSUPPORTED/);
      assert.deepEqual(await readFile(manifestFile), before);
      assert.deepEqual(await readFile(path.join(stack, 'README.md')), readme);
    });
  }
});


test('backup creates private operator-owned archive files before the root archiver writes', async t => {
  const { dir, stack, cli } = await fixture(t);
  const docker = path.join(dir, 'bin/docker');
  await writeFile(docker, `#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';
const a=process.argv.slice(2);
if(a[0]==='compose'&&a[1]==='version')console.log('5.5.1');
else if(a[0]==='version')console.log('29.5.0');
else if(a.includes('config')){const services={},volumes={};for(const [key,service,target] of [['traces','jaeger','/badger'],['metrics','prometheus','/prometheus'],['grafana','grafana','/var/lib/grafana'],['inventory','gateway','/inventory']]){services[service]={volumes:[{type:'volume',source:key,target}]};volumes[key]={name:'private_'+key};}console.log(JSON.stringify({services,volumes}));}
else if(a[0]==='run'){const bind=a.find(x=>x.startsWith('type=bind,src='));const location=bind.slice(14).split(',dst=')[0];const filename=path.basename(a.find(x=>x.startsWith('/backup/')));const out=path.join(location,filename);const st=fs.statSync(out);if((st.mode&511)!==384||st.uid!==process.getuid())process.exit(1);fs.writeFileSync(out,'snapshot');}
`, { mode: 0o755 });
  const backup = path.join(dir, 'private-backup');
  const result = cli(['backup', '--dir', stack, '--backup', backup]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const key of ['traces', 'metrics', 'grafana', 'inventory']) assert.equal(await readFile(path.join(backup, key + '.tar'), 'utf8'), 'snapshot');
});
