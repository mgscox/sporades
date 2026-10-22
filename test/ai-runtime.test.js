import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { openDevDatabase, resolveAnonymousSession, runMutation, runEndpoint } from '../dist/server-runtime-source.js';
import { capsule, job, mutation } from '../dist/server.js';
import { createAiRuntime, validateAiConfig } from '../dist/ai-runtime.js';
import { chatCompletionsAdapter, responsesAdapter } from '../dist/ai-openai-adapters.js';
import { validateProjectConfigShape } from '../dist/cli/project-config.js';
import { missingServerEnvKeys, requiredServerEnvKeys } from '../dist/server-env-requirements.js';
import { startOpenAiCompatibleEmulator } from './support/openai-compatible-emulator.js';

const KEY = 'sk-emulator-test';
const SECRET_PROMPT = 'Client answer GB999 9999 99 for the VAT field';
const definition = capsule({
  name: 'ai-capsule',
  schema: {},
  mutations: {
    ask: mutation((ctx, input) => ctx.ai.chat(input)),
    enabled: mutation(ctx => ctx.ai.enabled),
    privileged: mutation(ctx => ctx.privileged.run({ operation: 'ai-test.privileged', targetResourceKind: 'ai' }, p => p.ai.chat({ messages: [{ role: 'user', content: 'privileged hello' }] }))),
  },
});

async function withRuntime({ ai, env = { AI_API_KEY: KEY }, capsuleDefinition = definition } = {}, run) {
  const root = await mkdtemp(path.join(process.cwd(), '.agent-tmp-ai-runtime-'));
  const db = await openDevDatabase(path.join(root, 'data.db'), '', env, { name: 'ai-capsule', ...(ai === undefined ? {} : { ai }) }, capsuleDefinition);
  try {
    const session = await resolveAnonymousSession(db, null);
    const call = async (name, ...args) => {
      const result = await runMutation(db, session.auth, name, args);
      assert.equal(result.ok, true, result.error?.message);
      return result.data;
    };
    await run({ db, call });
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
}

async function withEmulator(run) {
  const emulator = await startOpenAiCompatibleEmulator({ keys: [KEY, 'sk-emulator-other'], models: ['emulator-small', 'emulator-large'] });
  try { await run(emulator); } finally { await emulator.close(); }
}

const aiEvents = db => db.log.tail().filter(event => event.event === 'ai.call');

test('ai config validates shape, stays out of required Server env, and keeps the key in env', () => {
  assert.deepEqual(validateAiConfig({ baseUrl: 'https://api.example.test/v1/', model: 'small' }),
    { enabled: true, api: 'chat-completions', baseUrl: 'https://api.example.test/v1', model: 'small', keyEnv: 'AI_API_KEY' });
  assert.deepEqual(validateAiConfig({ enabled: false }), { enabled: false, api: 'chat-completions', keyEnv: 'AI_API_KEY' });
  assert.deepEqual(validateAiConfig({ enabled: false, baseUrl: 'https://api.example.test/v1/', model: 'small' }),
    { enabled: false, api: 'chat-completions', keyEnv: 'AI_API_KEY', baseUrl: 'https://api.example.test/v1', model: 'small' });
  assert.equal(validateAiConfig({ api: 'responses', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1:8b', keyEnv: 'OLLAMA_KEY' }).api, 'responses');
  assert.equal(validateAiConfig({ baseUrl: 'http://host.docker.internal:11434/v1', model: 'm' }).baseUrl, 'http://host.docker.internal:11434/v1');
  for (const invalid of [
    { baseUrl: 'http://api.example.test/v1', model: 'm' },
    { baseUrl: 'https://user:pass@api.example.test/v1', model: 'm' },
    { baseUrl: 'https://api.example.test/v1?x=1', model: 'm' },
    { baseUrl: 'https://api.example.test/v1', model: '' },
    { baseUrl: 'https://api.example.test/v1', model: 'm', api: 'completions' },
    { baseUrl: 'https://api.example.test/v1', model: 'm', keyEnv: 'SPORADES_KEY' },
    { baseUrl: 'https://api.example.test/v1', model: 'm', apiKey: 'inline-secret' },
    { enabled: false, baseUrl: 'ftp://x' },
    'https://api.example.test/v1',
  ]) assert.throws(() => validateAiConfig(invalid), { code: 'INVALID_AI_CONFIG' }, JSON.stringify(invalid));
  validateProjectConfigShape({ name: 'x', ai: { baseUrl: 'https://api.example.test/v1', model: 'm' } });
  const config = { env: { required: [] }, ai: validateAiConfig({ baseUrl: 'https://api.example.test/v1', model: 'm', keyEnv: 'AI_API_KEY' }) };
  assert.deepEqual(requiredServerEnvKeys(config), []);
  assert.deepEqual(missingServerEnvKeys(config, {}), []);
});

test('Chat Completions success returns parsed JSON and usage, sends the configured request, and meters without content', async () => {
  await withEmulator(async emulator => {
    await withRuntime({ ai: { baseUrl: emulator.url, model: 'emulator-small' } }, async ({ db, call }) => {
      assert.equal(await call('enabled'), true);
      emulator.enqueue({ json: { plausible: false, reason: 'not a VAT number' } });
      const schema = { type: 'object', properties: { plausible: { type: 'boolean' }, reason: { type: 'string' } }, required: ['plausible', 'reason'], additionalProperties: false };
      const result = await call('ask', {
        system: 'Check the shape of the answer.', messages: [{ role: 'user', content: SECRET_PROMPT }],
        maxTokens: 64, temperature: 0, jsonSchema: { name: 'answer_check', schema },
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.data.json, { plausible: false, reason: 'not a VAT number' });
      assert.equal(result.data.model, 'emulator-small');
      assert.equal(result.data.finishReason, 'stop');
      const ledger = emulator.usage(KEY);
      assert.deepEqual(result.data.usage, { promptTokens: ledger.prompt, completionTokens: ledger.completion, totalTokens: ledger.total });
      assert.equal(ledger.calls, 1);

      const [request] = emulator.requests();
      assert.equal(request.path, '/v1/chat/completions');
      assert.equal(request.key, KEY);
      assert.deepEqual(request.body.messages, [{ role: 'system', content: 'Check the shape of the answer.' }, { role: 'user', content: SECRET_PROMPT }]);
      assert.equal(request.body.max_tokens, 64);
      assert.equal(request.body.temperature, 0);
      assert.deepEqual(request.body.response_format, { type: 'json_schema', json_schema: { name: 'answer_check', schema, strict: true } });
      assert.deepEqual(emulator.storedIds(), [], 'Chat Completions are not stored without store: true');

      const [event] = aiEvents(db);
      assert.equal(event.category, 'ai');
      assert.equal(event.level, 'info');
      assert.deepEqual(event.data.usage, { prompt: ledger.prompt, completion: ledger.completion, total: ledger.total });
      assert.equal(event.data.outcome, 'ok');
      assert.equal(event.data.model, 'emulator-small');
      assert.equal(event.data.api, 'chat-completions');
      assert.equal(event.data.status, 200);
      assert.ok(Number.isInteger(event.data.latencyMs));
      const logFile = await readFile(db.log.path, 'utf8');
      for (const content of [SECRET_PROMPT, 'not a VAT number', 'Check the shape', KEY]) assert.equal(logFile.includes(content), false, content);
    });
  });
});

test('Responses API sends instructions with store: false, decodes output text, and reports truncation', async () => {
  await withEmulator(async emulator => {
    await withRuntime({ ai: { api: 'responses', baseUrl: emulator.url, model: 'emulator-large' } }, async ({ db, call }) => {
      emulator.enqueue({ text: 'looks fine' });
      const first = await call('ask', { system: 'Be brief.', messages: [{ role: 'user', content: 'hello there' }], maxTokens: 32 });
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(first.data.text, 'looks fine');
      assert.equal(first.data.finishReason, 'stop');
      assert.deepEqual(first.data.usage, { promptTokens: 4, completionTokens: 2, totalTokens: 6 });
      const [request] = emulator.requests();
      assert.equal(request.path, '/v1/responses');
      assert.equal(request.body.store, false);
      assert.equal(request.body.instructions, 'Be brief.');
      assert.equal(request.body.max_output_tokens, 32);
      assert.deepEqual(request.body.input, [{ role: 'user', content: 'hello there' }]);
      assert.deepEqual(emulator.storedIds(), [], 'store: false leaves nothing retrievable');

      emulator.enqueue({ text: Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ') });
      const truncated = await call('ask', { messages: [{ role: 'user', content: 'long please' }], maxTokens: 16 });
      assert.equal(truncated.ok, true);
      assert.equal(truncated.data.finishReason, 'length');
      assert.equal(truncated.data.text.split(' ').length, 16);

      const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
      emulator.enqueue({ json: { ok: true } });
      const structured = await call('ask', { messages: [{ role: 'user', content: 'json' }], jsonSchema: { name: 'flag', schema, strict: false } });
      assert.deepEqual(structured.data.json, { ok: true });
      assert.deepEqual(emulator.requests().at(-1).body.text, { format: { type: 'json_schema', name: 'flag', schema, strict: false } });
      assert.equal(emulator.usage(KEY).calls, 3);
      assert.deepEqual(aiEvents(db).map(event => [event.data.api, event.data.outcome]), [['responses', 'ok'], ['responses', 'ok'], ['responses', 'ok']]);
    });
  });
});

test('timeouts fail open as AI_TIMEOUT within the caller deadline and abort the upstream request', async () => {
  await withEmulator(async emulator => {
    await withRuntime({ ai: { baseUrl: emulator.url, model: 'emulator-small' } }, async ({ db, call }) => {
      emulator.enqueue({ delayMs: 1500 });
      const started = performance.now();
      const result = await call('ask', { messages: [{ role: 'user', content: 'slow' }], timeoutMs: 100 });
      assert.ok(performance.now() - started < 1000, 'returns at the deadline, not when the provider answers');
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'AI_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(emulator.aborted(), 1);
      assert.equal(emulator.usage(KEY).calls, 0, 'no completion was metered upstream');
      assert.equal(aiEvents(db).at(-1).data.outcome, 'AI_TIMEOUT');
      assert.equal(aiEvents(db).at(-1).level, 'warn');
      // The emulator stays usable after an abandoned call.
      assert.equal((await call('ask', { messages: [{ role: 'user', content: 'again' }] })).ok, true);
    });
  });
});

test('upstream failures return AI_UPSTREAM_ERROR with status and never follow redirects', async () => {
  await withEmulator(async emulator => {
    const target = await startOpenAiCompatibleEmulator({ keys: [KEY] });
    try {
      await withRuntime({ ai: { baseUrl: emulator.url, model: 'emulator-small' } }, async ({ db, call }) => {
        const ask = () => call('ask', { messages: [{ role: 'user', content: SECRET_PROMPT }] });
        emulator.enqueue({ status: 503, message: `upstream echoed ${SECRET_PROMPT}` });
        const unavailable = await ask();
        assert.deepEqual(unavailable, { ok: false, error: { code: 'AI_UPSTREAM_ERROR', message: 'The AI provider request failed.', status: 503 } });

        emulator.removeModel('emulator-small');
        assert.equal((await ask()).error.status, 404, 'unknown model is an upstream error');
        emulator.addModel('emulator-small');

        emulator.enqueue({ redirectTo: `${target.url}/chat/completions` });
        const redirected = await ask();
        assert.equal(redirected.error.code, 'AI_UPSTREAM_ERROR');
        assert.equal(target.requests().length, 0, 'the key and prompt never reach a redirect target');

        assert.equal((await ask()).ok, true, 'recovers once the provider does');
        assert.deepEqual(aiEvents(db).map(event => [event.data.outcome, event.data.status]),
          [['AI_UPSTREAM_ERROR', 503], ['AI_UPSTREAM_ERROR', 404], ['AI_UPSTREAM_ERROR', null], ['ok', 200]]);
        assert.equal((await readFile(db.log.path, 'utf8')).includes(SECRET_PROMPT), false);
      });
      await withRuntime({ ai: { baseUrl: emulator.url, model: 'emulator-small' }, env: { AI_API_KEY: 'sk-revoked' } }, async ({ call }) => {
        const result = await call('ask', { messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(result.error.code, 'AI_UPSTREAM_ERROR');
        assert.equal(result.error.status, 401);
      });
    } finally { await target.close(); }
  });
});

test('unconfigured runtimes are dormant and send nothing upstream', async () => {
  await withEmulator(async emulator => {
    const input = { messages: [{ role: 'user', content: 'hello' }] };
    for (const options of [
      {},
      { ai: { baseUrl: emulator.url, model: 'emulator-small' }, env: {} },
      { ai: { baseUrl: emulator.url, model: 'emulator-small' }, env: { AI_API_KEY: '   ' } },
      { ai: { enabled: false, baseUrl: emulator.url, model: 'emulator-small' } },
    ]) {
      await withRuntime(options, async ({ db, call }) => {
        assert.equal(await call('enabled'), false);
        assert.deepEqual(await call('ask', input), { ok: false, error: { code: 'AI_UNCONFIGURED', message: 'AI is not configured for this Capsule.' } });
        assert.equal(aiEvents(db).at(-1).data.outcome, 'AI_UNCONFIGURED');
      });
    }
    assert.equal(emulator.requests().length, 0);
  });
});

test('per-call provider values override project settings and env, including without any ai config', async () => {
  await withEmulator(async emulator => {
    const other = await startOpenAiCompatibleEmulator({ keys: ['sk-staging'], models: ['local-model'] });
    try {
      await withRuntime({ ai: { baseUrl: emulator.url, model: 'emulator-small' } }, async ({ call }) => {
        const overridden = await call('ask', { messages: [{ role: 'user', content: 'one two' }], provider: { model: 'emulator-large', apiKey: 'sk-emulator-other' } });
        assert.equal(overridden.data.model, 'emulator-large');
        assert.equal(emulator.usage('sk-emulator-other').calls, 1);
        assert.equal(emulator.usage(KEY).calls, 0);
        const elsewhere = await call('ask', { messages: [{ role: 'user', content: 'x' }], provider: { api: 'responses', baseUrl: other.url, model: 'local-model', apiKey: 'sk-staging' } });
        assert.equal(elsewhere.ok, true, JSON.stringify(elsewhere));
        assert.equal(other.requests()[0].path, '/v1/responses');
        assert.equal(emulator.requests().length, 1);
      });
      await withRuntime({ ai: { baseUrl: emulator.url, model: 'emulator-small' } }, async ({ call }) => {
        const borrowed = await call('ask', { messages: [{ role: 'user', content: 'x' }], provider: { baseUrl: other.url, model: 'local-model' } });
        assert.equal(borrowed.error.code, 'AI_UNCONFIGURED', 'the project key never goes to another base URL');
        assert.equal(other.requests().length, 1, 'only the earlier keyed override reached the other provider');
        const sameOrigin = await call('ask', { messages: [{ role: 'user', content: 'x' }], provider: { baseUrl: `${emulator.url}/`, model: 'emulator-large' } });
        assert.equal(sameOrigin.ok, true, 'the project key still applies to the project base URL');
      });
      await withRuntime({ ai: { enabled: false, baseUrl: emulator.url, model: 'emulator-small' } }, async ({ call }) => {
        const before = emulator.usage(KEY).calls;
        assert.equal(await call('enabled'), false, 'a disabled project default stays dormant');
        assert.equal((await call('ask', { messages: [{ role: 'user', content: 'x' }] })).error.code, 'AI_UNCONFIGURED');
        const keyOnly = await call('ask', { messages: [{ role: 'user', content: 'x' }], provider: { apiKey: 'sk-emulator-other' } });
        assert.equal(keyOnly.ok, true, 'a partial override falls back to the declared base URL and model');
        assert.equal(keyOnly.data.model, 'emulator-small');
        const modelOnly = await call('ask', { messages: [{ role: 'user', content: 'x' }], provider: { model: 'emulator-large' } });
        assert.equal(modelOnly.ok, true, 'the declared key still applies to the declared base URL');
        assert.equal(emulator.usage(KEY).calls, before + 1);
      });
      await withRuntime({ env: {} }, async ({ db, call }) => {
        assert.equal(await call('enabled'), false);
        const partial = await call('ask', { messages: [{ role: 'user', content: 'x' }], provider: { baseUrl: other.url, model: 'local-model' } });
        assert.equal(partial.error.code, 'AI_UNCONFIGURED', 'a missing key is not borrowed from anywhere');
        const complete = await call('ask', { messages: [{ role: 'user', content: 'x' }], provider: { baseUrl: other.url, model: 'local-model', apiKey: 'sk-staging' } });
        assert.equal(complete.ok, true);
        assert.equal((await readFile(db.log.path, 'utf8')).includes('sk-staging'), false);
      });
      await withRuntime({ ai: { baseUrl: emulator.url, model: 'emulator-small' } }, async ({ call }) => {
        for (const provider of [{ baseUrl: 'http://example.test/v1' }, { apiKey: 'has space' }, { api: 'legacy' }, { key: 'x' }]) {
          assert.equal((await call('ask', { messages: [{ role: 'user', content: 'x' }], provider })).error.code, 'AI_INVALID_REQUEST', JSON.stringify(provider));
        }
      });
    } finally { await other.close(); }
  });
});

test('invalid requests and unusable responses return closed result codes', async () => {
  await withEmulator(async emulator => {
    await withRuntime({ ai: { baseUrl: emulator.url, model: 'emulator-small' } }, async ({ call }) => {
      for (const input of [
        null, {}, { messages: [] }, { messages: [{ role: 'tool', content: 'x' }] }, { messages: [{ role: 'user', content: 1 }] },
        { messages: [{ role: 'user', content: 'x' }], timeoutMs: 0 }, { messages: [{ role: 'user', content: 'x' }], timeoutMs: 30001 },
        { messages: [{ role: 'user', content: 'x' }], maxTokens: 0 }, { messages: [{ role: 'user', content: 'x' }], temperature: 3 },
        { messages: [{ role: 'user', content: 'x' }], jsonSchema: { name: 'bad name', schema: {} } },
        { messages: [{ role: 'user', content: 'x' }], extra: true },
      ]) assert.equal((await call('ask', input)).error.code, 'AI_INVALID_REQUEST', JSON.stringify(input));
      assert.equal(emulator.requests().length, 0);
      const direct = createAiRuntime({ baseUrl: emulator.url, model: 'emulator-small' }, { AI_API_KEY: KEY });
      for (const hostile of [{ get messages() { throw new Error('hostile getter'); } }, new Proxy({}, { getPrototypeOf() { throw new Error('hostile proxy'); } })]) {
        assert.equal((await direct.chat(hostile)).error.code, 'AI_INVALID_REQUEST', 'hostile input resolves rather than rejects');
      }

      const ask = extra => call('ask', { messages: [{ role: 'user', content: 'x' }], ...extra });
      emulator.enqueue({ rawBody: '<html>gateway</html>' });
      assert.equal((await ask()).error.code, 'AI_INVALID_RESPONSE');
      emulator.enqueue({ rawBody: { choices: [] } });
      assert.equal((await ask()).error.code, 'AI_INVALID_RESPONSE');
      emulator.enqueue({ rawBody: 'x'.repeat(1024 * 1024 + 1) });
      assert.equal((await ask()).error.code, 'AI_INVALID_RESPONSE');
      emulator.enqueue({ text: 'not json' });
      const schemaMiss = await ask({ jsonSchema: { name: 'flag', schema: { type: 'object' } } });
      assert.equal(schemaMiss.error.code, 'AI_INVALID_RESPONSE');
      emulator.enqueue({ omitUsage: true });
      const noUsage = await ask();
      assert.deepEqual(noUsage.data.usage, { promptTokens: null, completionTokens: null, totalTokens: null });
    });
  });
});

test('ctx.ai is available in endpoints, Privileged callbacks and Jobs, and runtime shutdown aborts in-flight calls', async () => {
  await withEmulator(async emulator => {
    const seen = [];
    const withJob = capsule({
      ...definition,
      jobs: {
        check: job(async ctx => { seen.push((await ctx.ai.chat({ messages: [{ role: 'user', content: 'from job' }] })).ok); }),
        slow: job(async ctx => { seen.push((await ctx.ai.chat({ messages: [{ role: 'user', content: 'slow job' }], timeoutMs: 10000 })).error?.code); }),
      },
      mutations: {
        ...definition.mutations,
        enqueue: mutation((ctx, name = 'check') => ctx.jobs.enqueue(name, null)),
        cancel: mutation((ctx, id) => ctx.jobs.cancel(id)),
      },
    });
    await withRuntime({ ai: { baseUrl: emulator.url, model: 'emulator-small' }, capsuleDefinition: withJob }, async ({ db, call }) => {
      assert.equal((await call('privileged')).ok, true);
      const endpointResult = await runEndpoint(db, { handler: async ctx => ({ body: await ctx.ai.chat({ messages: [{ role: 'user', content: 'from endpoint' }] }) }) },
        new URL('http://capsule.test/check'), { method: 'GET', headers: {}, async *[Symbol.asyncIterator]() {} });
      assert.equal(JSON.stringify(endpointResult).includes('"ok":true'), true, JSON.stringify(endpointResult));
      await call('enqueue');
      await db.init();
      for (let i = 0; i < 100 && !seen.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(seen, [true]);

      // A user-mode Job's cancellation reaches the in-flight call.
      emulator.enqueue({ delayMs: 5000 });
      const slow = await call('enqueue', 'slow');
      for (let i = 0; i < 100 && emulator.requests().at(-1)?.body?.messages?.[0]?.content !== 'slow job'; i++) await new Promise(resolve => setTimeout(resolve, 20));
      const cancelStarted = performance.now();
      await call('cancel', slow.id);
      for (let i = 0; i < 100 && seen.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.deepEqual(seen, [true, 'AI_ABORTED']);
      assert.ok(performance.now() - cancelStarted < 3000);

      emulator.enqueue({ delayMs: 5000 });
      const pending = call('ask', { messages: [{ role: 'user', content: 'during shutdown' }], timeoutMs: 10000 });
      await new Promise(resolve => setTimeout(resolve, 100));
      db.ai.close();
      assert.equal((await pending).error.code, 'AI_ABORTED');
    });
  });
});

test('adapters keep provider wire shapes out of the neutral reply', () => {
  const request = { system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 20, temperature: null, jsonSchema: null };
  assert.deepEqual(chatCompletionsAdapter.encode(request, 'm'), { model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], stream: false, max_tokens: 20 });
  assert.deepEqual(responsesAdapter.encode(request, 'm'), { model: 'm', input: [{ role: 'user', content: 'u' }], store: false, stream: false, instructions: 's', max_output_tokens: 20 });
  assert.equal(chatCompletionsAdapter.decode({ choices: [{ message: { content: null, refusal: 'no' }, finish_reason: 'stop' }] }), null);
  assert.equal(responsesAdapter.decode({ status: 'failed', output: [] }), null);
  assert.equal(responsesAdapter.decode({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }), null);
  assert.deepEqual(chatCompletionsAdapter.decode({ model: 'x', choices: [{ message: { content: 't' }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
    { text: 't', model: 'x', finishReason: 'other', usage: { prompt: 1, completion: 2, total: 3 } });
});
