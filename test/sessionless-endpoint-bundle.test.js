import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';

function snapshot(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'sporades_auth_%' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM [${name}] ORDER BY rowid`).all()]));
}

test('generated Bundle sessionless HTTP keeps admission, bounds, response handling and disconnect signals without auth persistence', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.agent-tmp-sessionless-bundle-'));
  let child, db, stdout = '', stderr = '';
  try {
    const serverSource = `import { capsule, endpoint, endpointFor, requireAuth } from 'sporades/server';
// These declarations run through the generated public helper, before runtime startup.
for (const declare of [
  () => endpoint({ method: 'GET', path: '/bad', session: undefined }, () => null),
  () => endpoint({ method: 'GET', path: '/bad', session: 'none', mcp: true }, () => null),
  () => endpointFor({})({ method: 'GET', path: '/bad', session: 'none' }, requireAuth(() => null)),
  () => capsule({ name: 'bad', endpoints: { raw: { kind: 'endpoint', options: { session: 'none', response: { fileAttachment: true } }, handler() {} } } }),
]) {
  let rejected = false;
  try { declare(); } catch (error) { rejected = error.code === 'INVALID_ENDPOINT_SESSION_DECLARATION'; }
  if (!rejected) throw new Error('Generated declaration validator failed');
}
const health = ctx => {
  ctx.log.info('Public health requested');
  ctx.log.info('Public health payload', { detail: 'p'.repeat(10000) });
  return { status: 201, headers: { 'x-health': 'public' }, body: {
    keys: Object.keys(ctx).sort(), symbols: Object.getOwnPropertySymbols(ctx).length,
    middleware: ctx.middleware ?? null, identity: ctx.auth ?? null,
    retainedEnvIdentity: ctx.env.retainedContext?.auth?.userId ?? null,
    retainedLimiterIdentity: ctx.rateLimit.retainedContext?.auth?.userId ?? null,
    body: ctx.request.body, size: ctx.request.bodyBytes.byteLength,
    aborted: ctx.signal.aborted, limited: !ctx.rateLimit('health', { limit: 1, windowMs: 60000 }).ok,
  } };
};
export default capsule({ name: 'sessionless-bundle', schema: {},
  middleware: [ctx => {
    ctx.middleware = 'ordinary';
    ctx.env.retainedContext = ctx;
    ctx.rateLimit.retainedContext = ctx;
    return ctx;
  }],
  endpoints: {
    health: endpoint({ method: 'POST', path: '/health', session: 'none' }, health),
    blocked: endpoint({ method: 'POST', path: '/blocked', session: 'none' }, health),
    fail: endpoint({ method: 'GET', path: '/fail', session: 'none' }, () => { throw new Error('private handler detail'); }),
    invalid: endpoint({ method: 'GET', path: '/invalid', session: 'none' }, () => ({ status: 'bad', body: 'never' })),
    cancel: endpoint({ method: 'GET', path: '/cancel', session: 'none' }, ctx => new Promise(resolve => {
      ctx.log.info('Waiting for cancellation');
      ctx.signal.addEventListener('abort', () => { ctx.log.info('Public request canceled'); resolve('canceled'); }, { once: true });
    })),
    ordinary: endpoint({ method: 'GET', path: '/ordinary' }, ctx => ({ body: { middleware: ctx.middleware, identity: !!ctx.auth.userId } })),
  },
});`;
    const serverModuleSource = await bundleServerCapsuleModule({ serverSource, serverSourcePath: path.join(root, 'server/index.ts') });
    await writeFile(path.join(root, 'server.mjs'), await createServerBundleModuleSource({
      config: { name: 'sessionless-bundle', http: { maxBodyBytes: 64 }, logs: { payloadMaxBytes: 4096 }, admissionPolicy: { path: 'policy.json' } }, serverEnv: {}, serverSource, serverModuleSource,
      epilogue: `process.stdout.write(JSON.stringify({ listening: server.address().port }) + '\\n');`,
    }));
    await writeFile(path.join(root, 'policy.json'), JSON.stringify({ version: 1, rules: [{ id: 'blocked-health', enabled: true,
      conditions: [{ kind: 'pathname', exact: '/blocked' }], action: { kind: 'deny' } }] }));
    child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: {
      ...process.env, PORT: '0', SPORADES_SECURITY_SESSION: 'dev', SPORADES_ADMISSION_POLICY_PATH: 'policy.json',
      SPORADES_CONFIG_DIR: path.join(root, 'config'), SPORADES_LOG_PATH: path.join(root, 'events.jsonl'),
    } });
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    let port;
    for (const deadline = Date.now() + 10000; !port && Date.now() < deadline;) {
      port = stdout.split('\n').map(line => { try { return JSON.parse(line).listening; } catch { return null; } }).find(Boolean);
      assert.equal(child.exitCode, null, stdout + stderr);
      if (!port) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(port, stdout + stderr);
    const base = `http://127.0.0.1:${port}`;
    db = new DatabaseSync(path.join(root, 'data/data.db'), { readOnly: true });
    const before = snapshot(db);
    for (let index = 0; index < 3; index++) {
      const response = await fetch(base + '/health', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer private-ignored-credential' }, body: '{ "ok": true }' });
      assert.equal(response.status, 201);
      assert.equal(response.headers.get('x-health'), 'public');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const data = await response.json();
      assert.deepEqual(data, { keys: ['app', 'env', 'log', 'rateLimit', 'request', 'services', 'signal'], symbols: 0,
        middleware: null, identity: null, retainedEnvIdentity: null, retainedLimiterIdentity: null,
        body: { ok: true }, size: 14, aborted: false, limited: index > 0 });
      assert.deepEqual(snapshot(db), before);
    }
    for (const [pathname, init, status, code] of [
      ['/blocked', { method: 'POST' }, 403],
      ['/health', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }, 400, 'INVALID_JSON_REQUEST'],
      ['/health', { method: 'POST', body: 'x'.repeat(65) }, 413, 'PAYLOAD_TOO_LARGE'],
      ['/fail', {}, 500], ['/invalid', {}, 500],
    ]) {
      const response = await fetch(base + pathname, init);
      assert.equal(response.status, status, pathname);
      const text = await response.text();
      if (code) assert.equal(JSON.parse(text).error.code, code);
      assert.equal(text.includes('private handler detail'), false);
      assert.deepEqual(snapshot(db), before);
    }
    await assert.rejects(fetch(base + '/cancel', { signal: AbortSignal.timeout(200) }));
    let logs = '';
    for (const deadline = Date.now() + 5000; !logs.includes('Public request canceled') && Date.now() < deadline;) {
      logs = await readFile(path.join(root, 'events.jsonl'), 'utf8').catch(() => '');
      if (!logs.includes('Public request canceled')) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.match(logs, /Public request canceled/);
    assert.equal(logs.includes('private-ignored-credential'), false);
    assert.equal(logs.includes('access-key.admitted'), false);
    const envelopes = logs.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(envelopes.some(event => event.message === 'Public health payload' && event.truncated === true));
    for (const event of envelopes) assert.ok(Buffer.byteLength(JSON.stringify(event)) <= 4096, 'sessionless logging uses the normal payload cap');
    assert.deepEqual(snapshot(db), before);
    const ordinary = await (await fetch(base + '/ordinary')).json();
    assert.deepEqual(ordinary, { middleware: 'ordinary', identity: true });
    assert.equal(snapshot(db).sporades_auth_users.length, before.sporades_auth_users.length + 1);
    assert.equal(snapshot(db).sporades_auth_sessions.length, before.sporades_auth_sessions.length + 1);
    const afterOrdinary = snapshot(db);
    const afterRetained = await (await fetch(base + '/health', { method: 'POST' })).json();
    assert.equal(afterRetained.retainedEnvIdentity, null);
    assert.equal(afterRetained.retainedLimiterIdentity, null);
    assert.deepEqual(snapshot(db), afterOrdinary);
  } finally {
    db?.close();
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'close'); }
    await rm(root, { recursive: true, force: true });
  }
});
