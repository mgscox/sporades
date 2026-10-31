import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';

const source = `import { capsule, endpoint, endpointError, job, table, String as Text } from 'sporades/server';
const multipart = { maxFiles: 1, maxFileBytes: 64, maxTotalFileBytes: 64, maxFieldCount: 1, maxFieldBytes: 64, maxTotalFieldBytes: 64, allowedPathPrefixes: ['/attachments'], allowedMimeTypes: ['text/plain'], requestKeyHeader: 'idempotency-key', partKeyHeader: 'content-id', claimAuthorities: ['capsule-principal'] };
const secure = { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'no-referrer' };
export default capsule({ name: 'security-refusal',
 schema: { audit: table({ value: Text() }), receipts: table({ value: Text() }), intents: table({ value: Text() }), anchors: table({ value: Text() }), observations: table({ value: Text() }).unique('value'), writes: table({ value: Text() }) },
 files: { acl: { read: () => false, delete: () => false }, ingress: { principalNamespaces: ['application'],
   admit: async ({ db }, request) => {
     if (request.path === '/file-fail') return { allow: true, principal: { namespace: 'application', key: 'resolved-application' } };
     // The credential resolves to this fixed application identity in trusted server code.
     if (request.headers['x-application'] !== 'private-valid-credential') return { allow: false };
     await db.observations.all();
     if (request.query.failure === 'unknown') return { allow: false, refusalJob: { name: 'missing', payload: null, idempotencyKey: 'trusted-unknown' } };
     if (request.query.failure === 'malformed') return { allow: false, refusalJob: { name: 'record', payload: 'x'.repeat(4097), idempotencyKey: 'trusted-malformed' } };
     return { allow: false, refusalJob: { name: 'record', payload: { applicationId: 'resolved-application', reason: 'intake-disabled' }, idempotencyKey: 'resolved-application:intake-disabled:v1' } };
   } } },
 jobs: { record: job(async (ctx, payload) => { await ctx.db.observations.insertOrIgnore({ value: JSON.stringify(payload) }, 'value'); return null; }) },
 endpoints: {
   state: endpoint({ method: 'GET', path: '/state' }, async ctx => ({ body: { observations: await ctx.db.observations.all(), writes: await ctx.db.writes.all(), audit: await ctx.db.audit.all(), receipts: await ctx.db.receipts.all(), intents: await ctx.db.intents.all() } })),
   fail: endpoint({ method: 'POST', path: '/fail' }, async ctx => {
     await ctx.resources.run({ resource: { table: 'anchors', id: 'anchor' }, operationId: 'failed-reply', input: null }, async scope => {
       await scope.db.writes.insert({ value: 'must roll back' });
       await scope.jobs.enqueue('record', { impossible: true });
       scope.log.info('rolled-back audit');
       await scope.notifications.accept({ id: 'failed-reply', to: ['owner@example.test'], subject: 'Reply', text: 'Must roll back' });
       return { accepted: true };
     });
     throw endpointError(secure);
   }),
   fileFail: endpoint({ method: 'POST', path: '/file-fail', body: { multipart } }, async ctx => {
     await ctx.files.claim(ctx.request.multipart.files[0], { path: '/attachments/reply.txt', authority: { kind: 'capsule-principal', ...ctx.ingress.principal } });
     await ctx.db.writes.insert({ value: 'rolled-back reply' });
     await ctx.db.audit.insert({ value: 'reply audit' });
     await ctx.db.receipts.insert({ value: 'reply receipt' });
     await ctx.db.intents.insert({ value: 'owner notification outbox' });
     await ctx.jobs.enqueue('record', { impossible: true });
     throw endpointError(secure);
   }),
   invalid: endpoint({ method: 'GET', path: '/invalid' }, ctx => { throw endpointError({ ...secure, [ctx.request.query.name]: ctx.request.query.value }); }),
   intake: endpoint({ method: 'POST', path: '/intake', body: { multipart } }, () => { throw new Error('Handler must never run'); }),
 }
});`;

test('built Capsule HTTP rolls back secure failures and persists unprocessed pre-byte refusal Jobs across restart', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.tmp/security-refusal-bundle-'));
  let child, db;
  async function stop() { if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'close'); } child = null; }
  async function boot(hold) {
    let stdout = '', stderr = '';
    child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: {
      ...process.env, PORT: '0', SPORADES_SECURITY_SESSION: 'dev', HOLD_JOBS: hold ? '1' : '',
      SPORADES_CONFIG_DIR: path.join(root, 'config'), SPORADES_LOG_PATH: path.join(root, 'events.jsonl'),
    } });
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
      const port = stdout.split('\n').map(line => { try { return JSON.parse(line).listening; } catch { return null; } }).find(Boolean);
      if (port) return `http://127.0.0.1:${port}`;
      assert.equal(child.exitCode, null, stdout + stderr);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(stdout + stderr);
  }
  try {
    const serverModuleSource = await bundleServerCapsuleModule({ serverSource: source, serverSourcePath: path.join(root, 'server/index.ts') });
    await writeFile(path.join(root, 'server.mjs'), await createServerBundleModuleSource({
      config: { name: 'security-refusal', mail: { smtp: { vendor: 'generic', host: '127.0.0.1', port: 5204, tls: { mode: 'disabled' }, auth: { method: 'none' }, defaultFrom: 'sender@example.test' } }, security: { csp: { mode: 'enforce', nonce: true } } }, serverEnv: {}, serverSource: source, serverModuleSource,
      epilogue: `await database.adapter.prepare('INSERT OR IGNORE INTO anchors (id,createdAt,updatedAt,value) VALUES (?,?,?,?)').run('anchor',new Date().toISOString(),new Date().toISOString(),'anchor'); if (process.env.HOLD_JOBS) await database.__deferJobExecution(); process.stdout.write(JSON.stringify({ listening: server.address().port }) + '\\n');`,
    }));
    const base = await boot(true);
    db = new DatabaseSync(path.join(root, 'data/data.db'), { readOnly: true });
    const count = name => db.prepare(`SELECT COUNT(*) AS n FROM [${name}]`).get().n;
    const failed = await fetch(base + '/fail', { method: 'POST' });
    assert.equal(failed.status, 500);
    assert.equal(failed.headers.get('cache-control'), 'no-store');
    assert.equal(failed.headers.get('pragma'), 'no-cache');
    assert.equal(failed.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(failed.headers.get('referrer-policy'), 'no-referrer');
    const policies = failed.headers.get('content-security-policy').split(/,\s*/);
    assert.ok(policies.includes("default-src 'none'"), 'the independent restrictive policy survives final serialization');
    assert.ok(policies.some(policy => /nonce-.*strict-dynamic/.test(policy)), 'platform baseline also survives');
    assert.equal((await failed.json()).error.message, 'Endpoint handler failed.');
    assert.deepEqual(await (await fetch(base + '/state')).json(), { observations: [], writes: [], audit: [], receipts: [], intents: [] });
    assert.equal(count('writes'), 0);
    assert.equal(count('sporades_jobs'), 0);
    assert.equal(count('sporades_notification_intents'), 0);
    assert.equal(count('sporades_notification_recipients'), 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='sporades_resource_receipts'").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sporades_log_events WHERE event='resource.log'").get().n, 0);
    for (const [name, value] of [['Set-Cookie', 'secret=yes'], ['Content-Length', '0'], ['X-Evil', 'escaped'], ['Cache-Control', 'no-store\r\nX-Evil: escaped']]) {
      const response = await fetch(base + '/invalid?' + new URLSearchParams({ name, value }));
      assert.equal(response.status, 500);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('x-evil'), null);
      assert.doesNotMatch(await response.text(), /secret|escaped|Invalid endpoint error headers/);
    }
    for (const [suffix, credential, status] of [['', 'invalid', 401], ['?failure=unknown', 'private-valid-credential', 503], ['?failure=malformed', 'private-valid-credential', 401]]) {
      const rejected = await fetch(base + '/intake' + suffix, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=broken', 'x-application': credential }, body: 'never parsed' });
      assert.equal(rejected.status, status);
      assert.equal(rejected.headers.get('cache-control'), 'no-store');
      assert.equal(rejected.headers.get('pragma'), 'no-cache');
      const body = await rejected.text();
      assert.doesNotMatch(body, /private-valid|trusted-unknown|trusted-malformed|missing|refusalJob/);
      if (status === 503) assert.equal(JSON.parse(body).error.code, 'FILE_INGRESS_REFUSAL_FAILED');
      assert.equal(count('sporades_jobs'), 0);
    }
    for (const key of ['caller-key-a', 'caller-key-b']) {
      const denied = await fetch(base + '/intake', { method: 'POST', headers: {
        'content-type': 'multipart/form-data; boundary=broken', 'idempotency-key': key, 'x-application': 'private-valid-credential',
      }, body: 'malformed multipart bytes must never be parsed' });
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(await denied.text(), /private-valid|resolved-application|refusalJob|Handler must never/);
    }
    assert.equal(count('sporades_jobs'), 1);
    assert.equal(count('observations'), 0, 'stop with the Job still pending');
    const pending = db.prepare('SELECT * FROM sporades_jobs').get();
    assert.equal(pending.status, 'queued');
    assert.equal(pending.attempts, 0);
    assert.equal(pending.actorUserId, '__privileged__');
    assert.match(pending.idempotencyKey, /^file-ingress-refusal:[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(pending), /caller-key|private-valid/);
    assert.deepEqual(JSON.parse(pending.payload), { applicationId: 'resolved-application', reason: 'intake-disabled' });
    assert.equal(count('sporades_file_ingress'), 0);
    assert.equal(count('sporades_files'), 0);
    assert.deepEqual(await readdir(path.join(root, 'data/files')).catch(() => []), []);
    const fileFailed = await fetch(base + '/file-fail', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=claim', 'idempotency-key': 'file-reply' }, body: '--claim\r\nContent-Disposition: form-data; name="file"; filename="reply.txt"\r\nContent-Type: text/plain\r\nContent-ID: file-one\r\n\r\nreply bytes\r\n--claim--' });
    assert.equal(fileFailed.status, 500);
    assert.equal(fileFailed.headers.get('cache-control'), 'no-store');
    assert.ok(fileFailed.headers.get('content-security-policy').split(/,\s*/).includes("default-src 'none'"));
    assert.equal((await fileFailed.json()).error.message, 'Endpoint handler failed.');
    assert.equal(count('writes'), 0);
    assert.equal(count('sporades_jobs'), 1);
    assert.equal(count('sporades_files'), 0);
    assert.equal(count('sporades_file_ingress_audit_outbox'), 0);
    assert.deepEqual(await (await fetch(base + '/state')).json(), { observations: [], writes: [], audit: [], receipts: [], intents: [] });
    assert.equal(db.prepare('SELECT state FROM sporades_file_ingress').get().state, 'leased', 'rollback restores the unclaimed lease');
    await stop();
    const restarted = await boot(false);
    for (const deadline = Date.now() + 10000; db.prepare('SELECT status FROM sporades_jobs').get().status !== 'succeeded' && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(count('observations'), 1);
    const publicState = await (await fetch(restarted + '/state')).json();
    for (const name of ['writes', 'audit', 'receipts', 'intents']) assert.deepEqual(publicState[name], []);
    assert.deepEqual(publicState.observations.map(row => JSON.parse(row.value)), [{ applicationId: 'resolved-application', reason: 'intake-disabled' }]);
    assert.equal(db.prepare('SELECT status FROM sporades_jobs').get().status, 'succeeded');
    await stop();
    await boot(false);
    assert.equal(count('observations'), 1, 'completed replay stays deduplicated after another restart');
  } finally { await stop(); db?.close(); await rm(root, { recursive: true, force: true }); }
});
