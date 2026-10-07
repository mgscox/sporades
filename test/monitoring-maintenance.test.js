import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ASSETS } from '../dist/cli/monitoring-stack.js';
import { legacyPipelineGeneration } from './monitoring-legacy-fixture.js';
const root = process.cwd();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function publicationJournal(stack, name, before, after) {
  const st = await lstat(path.join(stack, name));
  const attributes = { mode: st.mode & 0o777, uid: st.uid, gid: st.gid };
  return { schemaVersion: 1, before: { [name]: before.toString('base64') }, original: { [name]: { hash: digest(before), ...attributes } }, intended: { [name]: { hash: digest(after), ...attributes } } };
}

async function fixture(t) {
  const dir = await mkdtemp(path.join(root, '.sporades/maintenance-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'); await mkdir(bin);
  await writeFile(path.join(bin, 'docker'), `#!/bin/sh\ncase "$*" in\n 'compose version --short') echo 5.5.1;;\n 'version --format {{.Server.Version}}') echo 29.5.0;;\n *'config --format json'*) echo '{"services":{"collector":{"image":"otel/opentelemetry-collector-contrib:0.138.0","command":["--config=/etc/otelcol/config.yaml"],"volumes":[{"type":"bind","read_only":true,"target":"/etc/otelcol/config.yaml","source":"'"$PWD"'/collector.yaml"}]},"jaeger":{"image":"cr.jaegertracing.io/jaegertracing/jaeger:2.21.0","command":["--config=/etc/jaeger/config.yaml"],"environment":{"TRACE_RETENTION":"72h"},"volumes":[{"type":"bind","target":"/etc/jaeger/config.yaml","source":"'"$PWD"'/jaeger.yaml","read_only":true}]},"prometheus":{"image":"prom/prometheus:v3.13.3","command":["--config.file=/etc/prometheus/prometheus.yml","--storage.tsdb.path=/prometheus","--storage.tsdb.retention.time=14d","--storage.tsdb.retention.size=8GB","--web.enable-otlp-receiver"],"volumes":[{"type":"bind","target":"/etc/prometheus/prometheus.yml","source":"'"$PWD"'/prometheus.yaml","read_only":true},{"type":"bind","target":"/etc/prometheus/pipeline-rules.yaml","source":"'"$PWD"'/pipeline-rules.yaml","read_only":true},{"type":"bind","target":"/etc/prometheus/availability-rules.yaml","source":"'"$PWD"'/.private/availability-rules.yaml","read_only":true},{"type":"bind","target":"/etc/prometheus/performance-rules.yaml","source":"'"$PWD"'/.private/performance-rules.yaml","read_only":true}]}}}';;\n *'config --quiet'*) if [ -n "$REJECT_CONFIG" ]; then echo "$REJECT_CONFIG" >&2; exit 1; fi;;\n *'ps --all --quiet'*) if [ -n "$RUNNING" ]; then echo running; fi;;\n 'inspect running') echo '[{"State":{"Running":true}}]';;\n *) exit 0;;\nesac\n`, { mode: 0o755 });
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

test('pipeline-only schema-4 stack rolls back after init fills newer assets', async t => {
  const { dir, stack, cli } = await fixture(t);
  const legacy = await legacyPipelineGeneration(stack);
  const docker = path.join(dir, 'bin/docker');
  const original = docker + '-original';
  await writeFile(original, await readFile(docker), { mode: 0o755 });
  // Resolve the effective mounts of each candidate, rather than returning the
  // current stack's optional mounts for an older rollback generation.
  await writeFile(docker, `#!${process.execPath}
import fs from 'node:fs';import cp from 'node:child_process';
const args=process.argv.slice(2);
const r=cp.spawnSync(${JSON.stringify(original)},args,{encoding:'utf8'});
if(args.includes('config')&&args.includes('--format')){
  const config=JSON.parse(r.stdout),compose=fs.readFileSync('compose.yaml','utf8');
  config.services.prometheus.volumes=config.services.prometheus.volumes.filter(v=>!v.target.endsWith('availability-rules.yaml')&&!v.target.endsWith('performance-rules.yaml')||compose.includes(v.target));
  process.stdout.write(JSON.stringify(config));
}else process.stdout.write(r.stdout);
process.stderr.write(r.stderr);process.exit(r.status??1);
`, { mode: 0o755 });
  const initialized = cli(['init', '--dir', stack]);
  assert.equal(initialized.status, 0, initialized.stdout + initialized.stderr);
  assert.equal(await readFile(path.join(stack, 'compose.yaml'), 'utf8'), legacy['compose.yaml']);
  assert.equal(await readFile(path.join(stack, 'prometheus.yaml'), 'utf8'), legacy['prometheus.yaml']);
  assert.equal(cli(['upgrade', '--dir', stack]).status, 0);
  const rolled = cli(['rollback', '--dir', stack]);
  assert.equal(rolled.status, 0, rolled.stdout + rolled.stderr);
  for (const [name, bytes] of Object.entries(legacy)) assert.equal(await readFile(path.join(stack, name), 'utf8'), bytes, name);
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
  await writeFile(path.join(stack, '.maintenance/journal.json'), JSON.stringify(await publicationJournal(stack, 'README.md', saved, 'interrupted replacement')), { mode: 0o600 });
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
  const journal = await publicationJournal(stack, 'README.md', original, 'interrupted candidate');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {DatabaseSync} from 'node:sqlite';import {writeFileSync,chmodSync} from 'node:fs';const db=new DatabaseSync(${JSON.stringify(path.join(state, 'lock.sqlite'))});chmodSync(${JSON.stringify(path.join(state, 'lock.sqlite'))},0o600);db.exec('BEGIN IMMEDIATE');writeFileSync(${JSON.stringify(path.join(state, 'journal.json'))},${JSON.stringify(JSON.stringify(journal))},{mode:0o600});writeFileSync(${JSON.stringify(path.join(stack, 'README.md'))},'interrupted candidate');process.stdout.write('ready');setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  assert.equal(cli(['upgrade', '--dir', stack]).status, 1, 'active OS writer lock excludes publication');
  assert.equal(await readFile(path.join(stack, 'README.md'), 'utf8'), 'interrupted candidate');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const recovered = cli(['upgrade', '--dir', stack]);
  assert.equal(recovered.status, 0, recovered.stdout);
  assert.deepEqual(await readFile(path.join(stack, 'README.md')), original);
});

test('SIGKILL after shipped CLI publication preserves subsequent operator edits and the entire journal', async t => {
  for (const variant of ['collector.yaml', 'README.md', 'permissions', 'deletion', 'unmodified recovery']) {
    await t.test(variant, async t => {
      const { dir, stack, cli } = await fixture(t);
      const manifestFile = path.join(stack, 'stack-manifest.json');
      const manifest = JSON.parse(await readFile(manifestFile));
      for (const name of ['README.md', 'collector.yaml']) {
        const old = '# previous generated release\n' + await readFile(path.join(stack, name), 'utf8');
        await writeFile(path.join(stack, name), old);
        manifest.assets[name] = digest(old);
      }
      await writeFile(manifestFile, JSON.stringify(manifest));
      const hook = path.join(dir, 'interrupt.cjs');
      await writeFile(hook, `const fs=require('node:fs/promises');const rename=fs.rename;fs.rename=async(...args)=>{await rename(...args);if(args[1]===process.env.INTERRUPT_FILE)process.kill(process.pid,'SIGKILL');};require('node:module').syncBuiltinESMExports();`);
      const interrupted = cli(['upgrade', '--dir', stack], { NODE_OPTIONS: '--require=' + hook, INTERRUPT_FILE: path.join(stack, 'collector.yaml') });
      assert.equal(interrupted.signal, 'SIGKILL', interrupted.stdout + interrupted.stderr);
      const journalFile = path.join(stack, '.maintenance/journal.json');
      const journal = await readFile(journalFile);
      const edited = path.join(stack, variant === 'README.md' ? 'README.md' : 'collector.yaml');
      if (variant === 'unmodified recovery') {
        // A second interruption while restoring must also remain recoverable.
        const again = cli(['upgrade', '--dir', stack], { NODE_OPTIONS: '--require=' + hook, INTERRUPT_FILE: path.join(stack, 'README.md') });
        assert.equal(again.signal, 'SIGKILL', again.stdout + again.stderr);
        assert.equal(cli(['upgrade', '--dir', stack]).status, 0);
        await assert.rejects(readFile(journalFile), { code: 'ENOENT' });
        assert.deepEqual(await readFile(path.join(stack, 'collector.yaml')), await readFile(path.join(root, 'monitoring/trace/collector.yaml')));
        return;
      }
      if (variant === 'permissions') await chmod(edited, 0o600);
      else if (variant === 'deletion') await rm(edited);
      else await writeFile(edited, await readFile(edited, 'utf8') + '\n# operator override SECRET\n');
      const names = Object.keys(JSON.parse(journal).before);
      const snapshot = await Promise.all(names.map(async name => ({ name, bytes: await readFile(path.join(stack, name)).catch(e => { if (e.code === 'ENOENT') return null; throw e; }), mode: await lstat(path.join(stack, name)).then(st => st.mode).catch(e => { if (e.code === 'ENOENT') return null; throw e; }) })));
      for (let attempt = 0; attempt < 2; attempt++) {
        const retry = cli(['upgrade', '--dir', stack]);
        assert.equal(retry.status, 1, retry.stdout + retry.stderr);
        assert.match(retry.stdout + retry.stderr, /operator edits/);
        assert.doesNotMatch(retry.stdout + retry.stderr, /SECRET/);
        assert.deepEqual(await readFile(journalFile), journal);
        for (const { name, bytes, mode } of snapshot) {
          const file = path.join(stack, name);
          if (bytes === null) await assert.rejects(readFile(file), { code: 'ENOENT' });
          else { assert.deepEqual(await readFile(file), bytes); assert.equal((await lstat(file)).mode, mode); }
        }
      }
    });
  }
});

test('legacy publication journals refuse unverifiable replacements without losing operator edits', async t => {
  const { stack, cli } = await fixture(t);
  const file = path.join(stack, 'README.md'), before = await readFile(file);
  await mkdir(path.join(stack, '.maintenance'), { mode: 0o700 });
  const journalFile = path.join(stack, '.maintenance/journal.json');
  const journal = JSON.stringify({ 'README.md': before.toString('base64') });
  await writeFile(journalFile, journal, { mode: 0o600 });
  await writeFile(file, 'operator override SECRET');
  const result = cli(['upgrade', '--dir', stack]);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /legacy journal/);
  assert.doesNotMatch(result.stdout + result.stderr, /SECRET/);
  assert.equal(await readFile(file, 'utf8'), 'operator override SECRET');
  assert.equal(await readFile(journalFile, 'utf8'), journal);
  await writeFile(file, before);
  assert.equal(cli(['upgrade', '--dir', stack]).status, 0);
  await assert.rejects(readFile(journalFile), { code: 'ENOENT' });
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
  for (const variant of ['prometheus mount', 'availability rules mount', 'performance rules mount', 'jaeger mount', 'prometheus command', 'jaeger environment', 'collector entrypoint']) {
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
        const file = variant.startsWith('jaeger') ? 'jaeger.yaml' : variant.startsWith('availability') ? '.private/availability-rules.yaml' : variant.startsWith('performance') ? '.private/performance-rules.yaml' : 'prometheus.yaml';
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


test('UMask=0077 shipped maintenance publishes explicit modes and recovers interrupted generations', async t => {
  const { dir, stack, cli } = await fixture(t);
  // Docker validation drops all capabilities and must read public bind files
  // as a different uid. Reject an unreadable staged config at that boundary.
  const docker = path.join(dir, 'bin/docker');
  const dockerScript = await readFile(docker, 'utf8');
  const checkModes = 'const fs=require("node:fs");for(const arg of process.argv.slice(1)){if(arg.startsWith("type=bind,src=")){const source=arg.split(",")[1].slice(4);if(!(fs.statSync(source).mode&4))process.exit(1);}}';
  await writeFile(docker, dockerScript.replace('case "$*" in', `if [ "$1" = run ]; then "${process.execPath}" -e '${checkModes}' -- "$@" || exit 1; fi\ncase "$*" in`));
  // A version-only upgrade leaves backend config bytes unchanged, so staging
  // must preserve their readable modes before any generated replacement.
  const priorFile = path.join(stack, 'stack-manifest.json');
  const prior = JSON.parse(await readFile(priorFile)); prior.packageVersion = '0.9.30';
  await writeFile(priorFile, JSON.stringify(prior));
  const stagingUmask = process.umask(0o077);
  try {
    const staged = cli(['upgrade', '--dir', stack]);
    assert.equal(staged.status, 0, staged.stdout + staged.stderr);
  } finally { process.umask(stagingUmask); }
  const manifestFile = path.join(stack, 'stack-manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile));
  for (const name of ASSETS) {
    const before = Buffer.concat([await readFile(path.join(stack, name)), Buffer.from('\n')]);
    await writeFile(path.join(stack, name), before);
    manifest.assets[name] = digest(before);
  }
  await writeFile(manifestFile, JSON.stringify(manifest));
  const savedUmask = process.umask(0o077);
  try {
    const hook = path.join(dir, 'interrupt-modes.cjs');
    await writeFile(hook, `const fs=require('node:fs/promises');const rename=fs.rename;fs.rename=async(...args)=>{await rename(...args);if(args[1]===process.env.INTERRUPT_FILE)process.kill(process.pid,'SIGKILL');};require('node:module').syncBuiltinESMExports();`);
    const interrupted = cli(['upgrade', '--dir', stack], { NODE_OPTIONS: '--require=' + hook, INTERRUPT_FILE: path.join(stack, 'collector.yaml') });
    assert.equal(interrupted.signal, 'SIGKILL', interrupted.stdout + interrupted.stderr);
    const journalFile = path.join(stack, '.maintenance/journal.json');
    assert.equal((await lstat(journalFile)).mode & 0o777, 0o600);
    const journal = JSON.parse(await readFile(journalFile));
    for (const value of Object.values(journal.intended)) assert.equal(value.mode, 0o644, 'journal must match explicit published mode');
    assert.equal((await lstat(path.join(stack, 'collector.yaml'))).mode & 0o777, 0o644);
    // Kill recovery after a restored file, then retry with the same restrictive umask.
    const again = cli(['upgrade', '--dir', stack], { NODE_OPTIONS: '--require=' + hook, INTERRUPT_FILE: path.join(stack, '.dockerignore') });
    assert.equal(again.signal, 'SIGKILL', again.stdout + again.stderr);
    const recovered = cli(['upgrade', '--dir', stack]);
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
    await assert.rejects(readFile(journalFile), { code: 'ENOENT' });
    for (const name of [...ASSETS, 'stack-manifest.json']) {
      assert.equal((await lstat(path.join(stack, name))).mode & 0o777, 0o644, name);
      if (name !== 'stack-manifest.json') assert.deepEqual(await readFile(path.join(stack, name)), await readFile(path.join(root, 'monitoring/trace', name === '.gitignore' ? 'gitignore.template' : name)));
    }
    for (const name of ['.env', '.compose.env', '.private/credentials.json', '.private/grafana-admin-password', '.private/alertmanager.yaml', '.private/senders/registry.json', '.maintenance/previous.json', '.maintenance/lock.sqlite']) {
      assert.equal((await lstat(path.join(stack, name))).mode & 0o777, 0o600, name);
    }
    const rolled = cli(['rollback', '--dir', stack]);
    assert.equal(rolled.status, 0, rolled.stdout + rolled.stderr);
    for (const name of [...ASSETS, 'stack-manifest.json']) assert.equal((await lstat(path.join(stack, name))).mode & 0o777, 0o644, `rollback: ${name}`);
  } finally { process.umask(savedUmask); }
});
