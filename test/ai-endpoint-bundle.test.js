import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';
import { startOpenAiCompatibleEmulator } from './support/openai-compatible-emulator.js';

// A real HTTP server and request, because Node 24's IncomingMessage.signal aborts once the body
// has been read: a fake request object passed to runEndpoint cannot show that.
test('generated Bundle Custom endpoints call ctx.ai with a live signal that aborts on client disconnect', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.agent-tmp-ai-endpoint-bundle-'));
  const emulator = await startOpenAiCompatibleEmulator({ keys: ['sk-bundle'], models: ['bundle-model'] });
  let child;
  try {
    const serverSource = `import { capsule, endpoint } from 'sporades/server';
const ask = (ctx, content, extra = {}) => ctx.ai.chat({ messages: [{ role: 'user', content }], ...extra });
export default capsule({ name: 'ai-endpoint-bundle', schema: {}, endpoints: {
  get: endpoint({ method: 'GET', path: '/check' }, async ctx => ({ status: 200, body: { signalAborted: ctx.signal?.aborted ?? null, result: await ask(ctx, 'private get answer') } })),
  post: endpoint({ method: 'POST', path: '/check' }, async ctx => ({ status: 200, body: { signalAborted: ctx.signal?.aborted ?? null, result: await ask(ctx, String(ctx.request.body?.answer)) } })),
  slow: endpoint({ method: 'GET', path: '/slow' }, async ctx => ({ status: 200, body: await ask(ctx, 'slow', { timeoutMs: 10000 }) })),
} });`;
    const config = { name: 'ai-endpoint-bundle', ai: { baseUrl: emulator.url, model: 'bundle-model' } };
    const serverModuleSource = await bundleServerCapsuleModule({ serverSource, serverSourcePath: path.join(root, 'server/index.ts') });
    await writeFile(path.join(root, 'server.mjs'), await createServerBundleModuleSource({
      config, serverEnv: { AI_API_KEY: 'sk-bundle' }, serverSource, serverModuleSource,
      epilogue: `process.stdout.write(JSON.stringify({ listening: server.address().port }) + '\\n');`,
    }));
    let stdout = '', stderr = '';
    child = spawn(process.execPath, [path.join(root, 'server.mjs')], { cwd: root, env: {
      ...process.env, PORT: '0', SPORADES_SECURITY_SESSION: 'dev', SPORADES_CONFIG_DIR: path.join(root, 'config'),
      SPORADES_LOG_PATH: path.join(root, 'events.jsonl'),
    } });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    let port;
    for (const deadline = Date.now() + 10000; !port && Date.now() < deadline;) {
      port = stdout.split('\n').map(line => { try { return JSON.parse(line).listening; } catch { return null; } }).find(Boolean);
      assert.equal(child.exitCode, null, stdout + stderr);
      if (!port) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(port, stdout + stderr);
    const base = `http://127.0.0.1:${port}`;

    const get = await (await fetch(`${base}/check`)).json();
    assert.equal(get.signalAborted, false, 'a completed request is not a client abort');
    assert.equal(get.result.ok, true, JSON.stringify(get));
    const post = await (await fetch(`${base}/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'private post answer' }) })).json();
    assert.equal(post.signalAborted, false, 'reading the body does not abort the handler');
    assert.equal(post.result.ok, true, JSON.stringify(post));
    assert.equal(emulator.usage('sk-bundle').calls, 2);

    // A client that disconnects mid-call cancels the provider request.
    emulator.enqueue({ delayMs: 8000 });
    await assert.rejects(fetch(`${base}/slow`, { signal: AbortSignal.timeout(300) }));
    for (let i = 0; i < 150 && emulator.aborted() === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(emulator.aborted(), 1, 'the upstream request is abandoned with the client');
    let log = '';
    for (let i = 0; i < 150 && !log.includes('AI_ABORTED'); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      log = await readFile(path.join(root, 'events.jsonl'), 'utf8').catch(() => '');
    }
    assert.match(log, /"outcome":"AI_ABORTED"/);
    for (const secret of ['private get answer', 'private post answer', 'sk-bundle']) assert.equal(log.includes(secret), false, secret);
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'close'); }
    await emulator.close();
    await rm(root, { recursive: true, force: true });
  }
});
