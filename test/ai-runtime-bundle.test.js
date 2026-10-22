import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { bundleServerCapsuleModule } from '../dist/bundle-pipeline.js';
import { createServerBundleModuleSource } from '../dist/templates/server-bundle-module-graph.js';
import { startOpenAiCompatibleEmulator } from './support/openai-compatible-emulator.js';

test('generated self-contained Bundle exposes ctx.ai with sealed-env key and project config', { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(process.cwd(), '.agent-tmp-ai-bundle-'));
  const emulator = await startOpenAiCompatibleEmulator({ keys: ['sk-bundle'], models: ['bundle-model'] });
  let child;
  try {
    const serverSource = `import { capsule, endpoint } from 'sporades/server';
export default capsule({ name: 'ai-bundle', schema: {}, endpoints: {
  check: endpoint({ method: 'GET', path: '/check' }, async ctx => ({ status: 200, body: { enabled: ctx.ai.enabled, signalAborted: ctx.signal?.aborted ?? null,
    result: await ctx.ai.chat({ messages: [{ role: 'user', content: 'private client answer' }], jsonSchema: { name: 'verdict', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } } }) } })),
  slow: endpoint({ method: 'GET', path: '/slow' }, async ctx => ({ status: 200, body: await ctx.ai.chat({ messages: [{ role: 'user', content: 'slow' }], timeoutMs: 10000 }) })),
} });`;
    const config = { name: 'ai-bundle', ai: { api: 'responses', baseUrl: emulator.url, model: 'bundle-model' } };
    const serverModuleSource = await bundleServerCapsuleModule({ serverSource, serverSourcePath: path.join(root, 'server/index.ts') });
    const source = await createServerBundleModuleSource({
      config, serverEnv: { AI_API_KEY: 'sk-bundle' }, serverSource, serverModuleSource,
      epilogue: `process.stdout.write(JSON.stringify({ listening: server.address().port }) + '\\n');`,
    });
    await writeFile(path.join(root, 'server.mjs'), source);
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
    emulator.enqueue({ json: { ok: true } });
    const response = await fetch(`http://127.0.0.1:${port}/check`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.enabled, true);
    assert.equal(body.signalAborted, false, 'a completed request body is not a client abort');
    assert.equal(body.result.ok, true, JSON.stringify(body));
    assert.deepEqual(body.result.data.json, { ok: true });
    assert.equal(emulator.usage('sk-bundle').calls, 1);
    assert.equal(emulator.requests()[0].body.store, false);

    // A client that disconnects from a Custom endpoint cancels the provider call.
    emulator.enqueue({ delayMs: 8000 });
    await assert.rejects(fetch(`http://127.0.0.1:${port}/slow`, { signal: AbortSignal.timeout(300) }));
    for (let i = 0; i < 100 && emulator.aborted() === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(emulator.aborted(), 1, 'the upstream request is abandoned with the client');
    let log = '';
    for (let i = 0; i < 100 && !log.includes('AI_ABORTED'); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      log = await readFile(path.join(root, 'events.jsonl'), 'utf8');
    }
    assert.match(log, /"outcome":"AI_ABORTED"/);
    assert.match(log, /"event":"ai\.call"/);
    assert.equal(log.includes('private client answer'), false);
    assert.equal(log.includes('sk-bundle'), false);
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'close'); }
    await emulator.close();
    await rm(root, { recursive: true, force: true });
  }
});
