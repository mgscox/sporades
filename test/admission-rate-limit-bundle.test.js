import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';
import { clientAddressBoundaryToken } from '../dist/client-address.js';

test('generated self-contained Bundle enforces local fake Hosted quotas, protected diagnostics and process reset', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.agent-tmp-quota-bundle-'));
  const probe = 'a'.repeat(64);
  const identity = { 'x-sporades-client-address': '192.0.2.1', 'x-sporades-client-address-token': clientAddressBoundaryToken(probe) };
  let child, stdout = '', stderr = '';
  try {
    const serverSource = `import { capsule, endpoint } from 'sporades/server';
export default capsule({ name: 'quota-bundle', schema: {}, endpoints: {
  limited: endpoint({ method: 'GET', path: '/limited' }, () => ({ status: 201, body: 'Capsule bytes' }))
} });`;
    const serverModuleSource = await bundleServerCapsuleModule({ serverSource, serverSourcePath: path.join(root, 'server/index.ts') });
    const source = await createServerBundleModuleSource({
      config: { name: 'quota-bundle', admissionPolicy: { path: 'policy.json' } }, serverEnv: {}, serverSource, serverModuleSource,
      // Local fake boundary: load the Dev seed, then supply Host-owned identity configuration.
      epilogue: `database.securitySession = 'hosted'; database.runtimeProbeToken = '${probe}';
process.stdout.write(JSON.stringify({ listening: server.address().port }) + '\\n');`,
    });
    await writeFile(path.join(root, 'server.mjs'), source);
    await writeFile(path.join(root, 'policy.json'), JSON.stringify({ version: 1, rules: [{ id: 'quota', enabled: true,
      conditions: [{ kind: 'pathname', exact: '/limited' }], action: { kind: 'rate-limit', limit: 1, windowMs: 60000 } }] }));
    for (let restart = 0; restart < 2; restart++) {
      stdout = ''; stderr = '';
      child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: {
        ...process.env, PORT: '0', SPORADES_SECURITY_SESSION: 'dev', SPORADES_ADMISSION_POLICY_PATH: 'policy.json', SPORADES_CONFIG_DIR: path.join(root, 'config'),
      } });
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      let port;
      const deadline = Date.now() + 10000;
      while (!port && Date.now() < deadline) {
        port = stdout.split('\n').map(line => { try { return JSON.parse(line).listening; } catch { return null; } }).find(Boolean);
        assert.equal(child.exitCode, null, stdout + stderr);
        if (!port) await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(port, stdout + stderr);
      const base = `http://127.0.0.1:${port}`;
      const first = await fetch(base + '/limited', { headers: identity });
      assert.equal(first.status, 201); assert.equal(await first.text(), 'Capsule bytes');
      const second = await fetch(base + '/limited', { headers: { ...identity, forwarded: 'for=203.0.113.1' } });
      assert.equal(second.status, 429); assert.equal(await second.text(), 'Too Many Requests\n');
      assert.equal(second.headers.get('retry-after'), '60'); assert.equal(second.headers.get('cache-control'), 'no-store');
      assert.equal((await fetch(base + '/limited', { headers: { 'x-forwarded-for': '192.0.2.2' } })).status, 403);
      assert.equal((await fetch(base + '/__sporades/health/runtime')).status, 404);
      const health = await (await fetch(base + '/__sporades/health/runtime', { headers: { 'x-sporades-host-probe': probe } })).json();
      assert.deepEqual(health.data.runtime.admissionPolicy.rateLimit, { buckets: 1, maxBuckets: 10000, evictions: 0 });
      child.kill('SIGTERM'); await once(child, 'exit'); assert.equal(child.exitCode, 0, stderr); child = undefined;
    }
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await rm(root, { recursive: true, force: true });
  }
});
