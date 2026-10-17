import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';
import { clientAddressBoundaryToken } from '../dist/client-address.js';

test('generated self-contained Bundle rate limits share trusted client identity across endpoints', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.agent-tmp-capsule-rate-bundle-'));
  const probe = 'a'.repeat(64);
  const boundaryToken = clientAddressBoundaryToken(probe);
  let child;

  try {
    const serverSource = `import { capsule, endpoint } from 'sporades/server';
const inspect = ctx => ({ result: ctx.rateLimit('shared', { limit: 1, windowMs: 60000 }), address: ctx.request.clientAddress,
  authAddress: ctx.auth.clientAddress, tokenLeaked: Object.keys(ctx.request.headers).some(name => name.toLowerCase() === 'x-sporades-client-address-token') });
export default capsule({ name: 'capsule-rate-limit-bundle', schema: {}, endpoints: {
  limited: endpoint({ method: 'GET', path: '/limited' }, ctx => ({ status: 200, body: inspect(ctx) })),
  other: endpoint({ method: 'GET', path: '/other' }, ctx => ({ status: 200, body: inspect(ctx) }))
} });`;
    const serverModuleSource = await bundleServerCapsuleModule({ serverSource, serverSourcePath: path.join(root, 'server/index.ts') });
    const source = await createServerBundleModuleSource({
      config: { name: 'capsule-rate-limit-bundle' }, serverEnv: {}, serverSource, serverModuleSource,
      epilogue: `database.securitySession = process.env.FAKE_SECURITY_SESSION || 'hosted'; database.runtimeProbeToken = '${probe}';\nprocess.stdout.write(JSON.stringify({ listening: server.address().port }) + '\\n');`,
    });
    await writeFile(path.join(root, 'server.mjs'), source);

    for (const session of ['hosted', 'dev', 'container']) {
      let stdout = '', stderr = '';
      child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: {
        ...process.env, PORT: '0', SPORADES_SECURITY_SESSION: 'dev', FAKE_SECURITY_SESSION: session,
        SPORADES_CONFIG_DIR: path.join(root, 'config', session),
      } });
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      try {
        let port;
        const deadline = Date.now() + 10000;
        while (!port && Date.now() < deadline) {
          port = stdout.split('\n').map(line => { try { return JSON.parse(line).listening; } catch { return null; } }).find(Boolean);
          assert.equal(child.exitCode, null, stdout + stderr);
          if (!port) await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.ok(port, stdout + stderr);
        const base = `http://127.0.0.1:${port}`;
        const internalIdentity = { 'x-sporades-client-address': '192.0.2.1', 'x-sporades-client-address-token': boundaryToken };
        const spoofedForwarding = { 'x-forwarded-for': '198.51.100.8', 'x-real-ip': '198.51.100.9', 'cf-connecting-ip': '203.0.113.10' };
        const call = async (endpoint, headers) => {
          const response = await fetch(`${base}${endpoint}`, { headers });
          return { status: response.status, body: await response.json() };
        };

        if (session === 'hosted') {
          const first = await call('/limited', { ...internalIdentity, ...spoofedForwarding });
          assert.equal(first.status, 200);
          assert.equal(first.body.result.ok, true);
          assert.equal(first.body.address, '192.0.2.1');
          assert.equal(first.body.authAddress, '192.0.2.1');
          assert.equal(first.body.tokenLeaked, false);
          const shared = await call('/other', internalIdentity);
          assert.equal(shared.status, 200);
          assert.equal(shared.body.result.ok, false, 'different endpoint must share the named quota');
          assert.equal(shared.body.address, '192.0.2.1');
          assert.equal(shared.body.authAddress, '192.0.2.1');
          assert.equal(shared.body.tokenLeaked, false);

          for (const headers of [spoofedForwarding, { ...internalIdentity, 'x-sporades-client-address-token': 'invalid' }]) {
            const response = await call('/limited', headers);
            assert.equal(response.status, 200);
            assert.equal(response.body.address, undefined);
            assert.equal(response.body.authAddress, undefined);
            assert.equal(response.body.tokenLeaked, false);
          }
        } else {
          const response = await call('/limited', { ...internalIdentity, ...spoofedForwarding });
          assert.equal(response.status, 200);
          assert.equal(response.body.address, undefined, `${session} must ignore Host identity headers`);
          assert.equal(response.body.authAddress, undefined);
          assert.equal(response.body.tokenLeaked, false);
        }
      } finally {
        if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'close'); }
        assert.equal(child.exitCode, 0, stderr);
        child = undefined;
      }
    }
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await rm(root, { recursive: true, force: true });
  }
});
