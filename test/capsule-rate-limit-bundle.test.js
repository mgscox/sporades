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
    const serverSource = `import { capsule, endpoint, table, String as Text } from 'sporades/server';
let retainedAdmissionRateLimit;
const ingressOptions = { limit: 1, windowMs: 60000 };
const inspect = ctx => ({ result: ctx.rateLimit('shared', { limit: 1, windowMs: 60000 }), address: ctx.request.clientAddress,
  authAddress: ctx.auth.clientAddress, tokenLeaked: Object.keys(ctx.request.headers).some(name => name.toLowerCase() === 'x-sporades-client-address-token') });
const resource = { resource: { table: 'anchors', id: 'anchor' }, operationId: 'stable' };
export default capsule({ name: 'capsule-rate-limit-bundle', schema: { anchors: table({ value: Text() }) }, files: {
  acl: { read: () => false, delete: () => false },
  ingress: { principalNamespaces: ['signed-resource'], admit: ctx => {
    retainedAdmissionRateLimit = ctx.rateLimit;
    if (ctx.request.headers['x-resource-token'] !== 'synthetic-resource-token') return { allow: false };
    if (!ctx.rateLimit('ingress-shared', ingressOptions).ok) return { allow: false };
    return { allow: true, principal: { namespace: 'signed-resource', key: 'synthetic-resource' } };
  } },
}, endpoints: {
  upload: endpoint({ method: 'POST', path: '/upload', body: { multipart: {
    maxFiles: 1, maxFileBytes: 1024, maxTotalFileBytes: 1024, maxFieldCount: 1, maxFieldBytes: 100, maxTotalFieldBytes: 100,
    allowedPathPrefixes: ['/attachments'], requestKeyHeader: 'idempotency-key', partKeyHeader: 'content-id', claimAuthorities: ['capsule-principal'],
  } } }, ctx => ({ body: { remaining: ctx.rateLimit('ingress-shared', ingressOptions) } })),
  retained: endpoint({ method: 'GET', path: '/retained' }, ctx => {
    let code;
    try { retainedAdmissionRateLimit('unused-after-settle', ingressOptions); } catch (error) { code = error.code; }
    return { body: { code, untouched: ctx.rateLimit('unused-after-settle', ingressOptions) } };
  }),
  limited: endpoint({ method: 'GET', path: '/limited' }, ctx => ({ status: 200, body: inspect(ctx) })),
  other: endpoint({ method: 'GET', path: '/other' }, ctx => ({ status: 200, body: inspect(ctx) })),
  record: endpoint({ method: 'GET', path: '/resource-record' }, async ctx => ({ body: await ctx.resources.run({ ...resource, input: null }, async scope => {
    const anchor = await scope.db.anchors.where('id', 'anchor').get();
    const value = String(Number(anchor.value) + 1);
    await scope.db.anchors.update('anchor', { value });
    return { value };
  }) })),
  status: endpoint({ method: 'GET', path: '/resource-status' }, async ctx => ({ body: await ctx.resources.status(resource) }))
} });`;
    const serverModuleSource = await bundleServerCapsuleModule({ serverSource, serverSourcePath: path.join(root, 'server/index.ts') });
    const source = await createServerBundleModuleSource({
      config: { name: 'capsule-rate-limit-bundle' }, serverEnv: {}, serverSource, serverModuleSource,
      epilogue: `database.securitySession = process.env.FAKE_SECURITY_SESSION || 'hosted'; database.runtimeProbeToken = '${probe}';
await database.adapter.prepare('INSERT OR IGNORE INTO anchors (id,createdAt,updatedAt,value) VALUES (?,?,?,?)').run('anchor', new Date().toISOString(), new Date().toISOString(), '0');
if (database.securitySession === 'hosted') {
await database.adapter.insertAuthUser({ id: 'receipt-actor', displayName: 'Actor', email: null, picture: null, isAuthenticated: 0, isGuest: 1, provider: 'anonymous', createdAt: new Date().toISOString() });
await database.adapter.insertAuthSession({ token: 'receipt-session', userId: 'receipt-actor', provider: 'anonymous', createdAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' });
}
process.stdout.write(JSON.stringify({ listening: server.address().port }) + '\\n');`,
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

        const postUpload = token => fetch(`${base}/upload`, { method: 'POST', headers: {
          'content-type': 'multipart/form-data; boundary=bounded', 'idempotency-key': 'stable', 'x-resource-token': token,
        }, body: '--bounded\r\nContent-Disposition: form-data; name="file"; filename="dummy.txt"\r\nContent-Type: text/plain\r\nContent-ID: stable\r\n\r\ndummy\r\n--bounded--\r\n' });
        const invalidUpload = await postUpload('invalid');
        assert.equal(invalidUpload.status, 401); const opaqueDenial = await invalidUpload.text();
        const admittedUpload = await postUpload('synthetic-resource-token');
        assert.equal(admittedUpload.status, 200);
        assert.equal((await admittedUpload.json()).remaining.ok, false, 'generated admission and handler share one real budget');
        const replayUpload = await postUpload('synthetic-resource-token');
        assert.equal(replayUpload.status, 401); assert.equal(await replayUpload.text(), opaqueDenial);
        const retained = await call('/retained', {});
        assert.equal(retained.body.code, 'TRUSTED_READ_ACCESS_INACTIVE'); assert.equal(retained.body.untouched.ok, true);

        if (session === 'hosted') {
          for (const address of ['192.0.2.1', '2001:db8::2']) {
            const identity = { ...internalIdentity, 'x-sporades-client-address': address, 'x-sporades-session-token': 'receipt-session' };
            const recorded = await call('/resource-record', identity);
            assert.equal(recorded.status, 200);
            assert.deepEqual(recorded.body, { value: '1' }, 'resource callback must run once across address changes');
            const status = await call('/resource-status', identity);
            assert.equal(status.status, 200);
            assert.deepEqual(status.body, { state: 'committed', result: { value: '1' }, intentIds: [] });
          }
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
