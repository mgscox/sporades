import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, mkdir, symlink, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';

const repo = process.cwd();
const policy = rules => JSON.stringify({ version: 1, rules });
const deny = id => ({ id, enabled: true, conditions: [{ kind: 'pathname', exact: '/blocked' }], action: { kind: 'deny' } });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const events = output => output.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
async function until(read, child, diagnostics) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, diagnostics());
    const value = await read();
    if (value) return value;
    await delay(25);
  }
  assert.fail('Timed out: ' + diagnostics());
}
async function stop(child) {
  if (child && child.exitCode === null) {
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    await closed;
  }
}

async function createDevProject(root) {
  const cli = path.join(repo, 'bin/sporades.js');
  const env = { ...process.env, SPORADES_CONFIG_DIR: path.join(root, 'config') };
  const created = spawnSync(process.execPath, [cli, 'create', 'app', '--template', 'blank', '--framework', 'vanilla', '--no-install', '--no-git', '--json'], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(created.status, 0, created.stderr);
  const project = path.join(root, 'app');
  await mkdir(path.join(project, 'node_modules'), { recursive: true });
  await symlink(repo, path.join(project, 'node_modules/sporades'));
  const configPath = path.join(project, 'sporades.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.dev.port = 0;
  return { project, config, configPath, cli, env };
}

function upgrade(base, target) {
  return new Promise((resolve, reject) => {
    const req = request(new URL(target, base), { headers: {
      connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    } });
    req.on('upgrade', (response, socket) => { socket.destroy(); resolve(response.statusCode); });
    req.on('response', response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Upgrade timed out')));
    req.end();
  });
}

for (const mode of ['generated Bundle', 'Dev CLI']) test(`${mode} emits redacted failure and recovery before slow Capsule initialization finishes`, { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(repo, '.agent-tmp-evidence-startup-'));
  let child, output = '', errors = '';
  try {
    const serverSource = `import { capsule } from 'sporades/server';
import { access } from 'node:fs/promises';
process.stdout.write(JSON.stringify({ initializing: true }) + '\\n');
while (true) { try { await access(${JSON.stringify(path.join(root, 'ready'))}); break; } catch { await new Promise(resolve => setTimeout(resolve, 25)); } }
export default capsule({ name: 'slow-evidence', schema: {} });`;
    let project = root;
    if (mode === 'generated Bundle') {
      const serverModuleSource = await bundleServerCapsuleModule({ serverSource, serverSourcePath: path.join(root, 'server/index.ts') });
      const source = await createServerBundleModuleSource({
        config: { name: 'slow-evidence', admissionPolicy: { path: 'policy.json' } }, serverEnv: {}, serverSource, serverModuleSource,
        epilogue: `process.stdout.write(JSON.stringify({ listening: server.address().port, health: admissionPolicyRuntime.health() }) + '\\n');`,
      });
      await writeFile(path.join(root, 'server.mjs'), source);
      await writeFile(path.join(root, 'policy.json'), policy([deny('startup-rule')]));
      child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: {
        ...process.env, PORT: '0', SPORADES_SECURITY_SESSION: 'dev', SPORADES_CONFIG_DIR: path.join(root, 'config'), SPORADES_LOG_STDOUT: '1',
      } });
    } else {
      const fixture = await createDevProject(root);
      project = fixture.project;
      fixture.config.admissionPolicy = { path: 'policy.json' };
      await writeFile(fixture.configPath, JSON.stringify(fixture.config));
      await writeFile(path.join(project, 'server/index.ts'), serverSource);
      await writeFile(path.join(project, 'policy.json'), policy([deny('startup-rule')]));
      child = spawn(process.execPath, [fixture.cli, 'dev', '--json'], { cwd: project, env: fixture.env });
    }
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const diagnostics = () => output + errors;
    await until(() => events(output).find(event => event.initializing), child, diagnostics);
    await writeFile(path.join(project, 'policy.json'), 'private-malformed-policy');
    await until(() => events(errors).find(event => event.event === 'admission.policy.failure'), child, diagnostics);
    await writeFile(path.join(project, 'policy.json'), policy([deny('startup-rule')]));
    // The loader polls independently while Capsule evaluation holds back logger initialization.
    await until(() => events(errors).find(event => event.event === 'admission.policy.recovery'), child, diagnostics);
    assert.equal(events(output).some(event => event.listening || event.data?.event === 'started'), false);
    await writeFile(path.join(root, 'ready'), '');
    const started = await until(() => events(output).find(event => event.listening || event.data?.event === 'started'), child, diagnostics);
    let health = started.health;
    if (mode === 'Dev CLI') {
      const session = JSON.parse(await readFile(path.join(project, '.sporades/dev-session.json'), 'utf8'));
      health = (await (await fetch(started.data.url + '/__sporades/health/runtime', { headers: { 'x-sporades-host-probe': session.inspectionToken } })).json()).data.runtime.admissionPolicy;
    }
    assert.equal(health.evidence.counters.reloadFailures, '1');
    assert.equal(health.evidence.counters.reloadRecoveries, '1');
    assert.deepEqual(events(errors).map(event => event.event), ['admission.policy.failure', 'admission.policy.recovery']);
    assert.equal(events(errors)[1].data.state, 'healthy');
    assert.equal(events(errors)[1].data.digest, health.digest);
    for (const secret of ['private-malformed-policy', 'startup-rule', root]) assert.equal(diagnostics().includes(secret), false, secret);
  } finally {
    await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});

test('one Dev PID retains counters and the exhausted sampling budget across path changes, disable/re-enable, and runtime replacement', { timeout: 45000 }, async () => {
  const root = await mkdtemp(path.join(repo, '.agent-tmp-evidence-dev-'));
  let child, output = '', errors = '';
  try {
    const { project, config, configPath, cli, env } = await createDevProject(root);
    config.admissionPolicy = { path: 'a.json' };
    await writeFile(configPath, JSON.stringify(config));
    const initialPolicy = policy(Array.from({ length: 20 }, (_, i) => ({ ...deny('initial-' + i), conditions: [{ kind: 'pathname', exact: '/blocked/' + i }] })));
    await writeFile(path.join(project, 'a.json'), initialPolicy);
    await writeFile(path.join(project, 'b.json'), policy([deny('replacement')]));
    await writeFile(path.join(project, 'bad.json'), 'private-malformed-candidate');
    child = spawn(process.execPath, [cli, 'dev', '--json'], { cwd: project, env });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    const diagnostics = () => output + errors;
    const started = await until(() => events(output).find(event => event.data?.event === 'started'), child, diagnostics);
    const base = started.data.url;
    const sessionPath = path.join(project, '.sporades/dev-session.json');
    const session = JSON.parse(await readFile(sessionPath, 'utf8'));
    assert.equal(session.pid, child.pid);
    const health = async () => (await (await fetch(base + '/__sporades/health/runtime', { headers: { 'x-sporades-host-probe': session.inspectionToken } })).json()).data.runtime.admissionPolicy;
    let previous;
    const assertRetained = async expectedDenied => {
      const current = await health();
      assert.equal(JSON.parse(await readFile(sessionPath, 'utf8')).pid, session.pid);
      for (const [name, total] of Object.entries(previous?.evidence.counters ?? {})) {
        assert.ok(BigInt(current.evidence.counters[name]) >= BigInt(total), name + ' decreased');
      }
      assert.equal(current.evidence.counters.denied, String(expectedDenied));
      assert.equal(current.evidence.counters.decisionsEmitted, '20');
      assert.equal(current.evidence.counters.decisionsSuppressed, String(expectedDenied - 20));
      assert.equal(current.evidence.sampling.retainedKeys, 20);
      previous = current;
      return current;
    };
    const rebuild = async (mutate, status = 'success') => {
      const offset = output.length;
      await mutate();
      await until(() => events(output.slice(offset)).find(event => event.data?.event === 'rebuild' && event.data.status === status), child, diagnostics);
    };
    for (let i = 0; i < 20; i++) {
      const response = await fetch(base + '/blocked/' + i);
      assert.equal(response.status, 403);
      assert.equal(await response.text(), 'Forbidden\n');
    }
    assert.equal(await upgrade(base, '/blocked/0'), 403);
    await assertRetained(21);
    await writeFile(path.join(project, 'a.json'), 'private-malformed-policy');
    await until(async () => (await health()).state === 'degraded', child, diagnostics);
    await writeFile(path.join(project, 'a.json'), initialPolicy);
    await until(async () => (await health()).state === 'healthy', child, diagnostics);
    const recovered = await assertRetained(21);
    assert.equal(recovered.evidence.counters.reloadRecoveries, '1');
    assert.ok(BigInt(recovered.evidence.counters.reloadFailures) >= 1n);

    await rebuild(async () => { config.admissionPolicy.path = 'b.json'; await writeFile(configPath, JSON.stringify(config)); });
    assert.notEqual((await health()).digest, recovered.digest);
    await assertRetained(21);
    assert.equal((await fetch(base + '/blocked')).status, 403);
    await assertRetained(22);

    const digest = previous.digest;
    const failures = BigInt(previous.evidence.counters.reloadFailures);
    await rebuild(async () => { config.admissionPolicy.path = 'bad.json'; await writeFile(configPath, JSON.stringify(config)); }, 'failed');
    assert.equal((await health()).digest, digest);
    assert.equal(BigInt((await health()).evidence.counters.reloadFailures), failures + 1n);
    await assertRetained(22);

    await rebuild(async () => { delete config.admissionPolicy; await writeFile(configPath, JSON.stringify(config)); });
    assert.equal(await health(), undefined);
    const bypass = await fetch(base + '/blocked');
    assert.notEqual(bypass.status, 403);
    await bypass.text();
    await rebuild(async () => { config.admissionPolicy = { path: 'b.json' }; await writeFile(configPath, JSON.stringify(config)); });
    await assertRetained(22);
    assert.equal(await upgrade(base, '/blocked'), 403);
    await assertRetained(23);

    await rebuild(async () => {
      const serverPath = path.join(project, 'server/index.ts');
      await writeFile(serverPath, (await readFile(serverPath, 'utf8')) + '\n// Replace the Capsule runtime within this Dev session.\n');
    });
    await assertRetained(23);
    assert.equal((await fetch(base + '/blocked')).status, 403);
    await assertRetained(24);
    for (const secret of ['private-malformed-candidate', 'private-malformed-policy', session.inspectionToken]) assert.equal(diagnostics().includes(secret), false, secret);
  } finally {
    await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});
