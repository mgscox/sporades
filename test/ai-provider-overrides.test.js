import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { openDevDatabase, resolveAnonymousSession, runMutation } from '../dist/server-runtime-source.js';
import { capsule, mutation } from '../dist/server.js';
import { startOpenAiCompatibleEmulator } from './support/openai-compatible-emulator.js';

const PROJECT_KEY = 'sk-project';
const CALLER_KEY = 'sk-caller';
const messages = [{ role: 'user', content: 'Is GB999 9999 99 shaped like a VAT number?' }];
const definition = capsule({
  name: 'ai-overrides',
  schema: {},
  mutations: {
    ask: mutation((ctx, input) => ctx.ai.chat(input)),
    enabled: mutation(ctx => ctx.ai.enabled),
  },
});

async function withRuntime(ai, env, run) {
  const root = await mkdtemp(path.join(process.cwd(), '.agent-tmp-ai-overrides-'));
  const db = await openDevDatabase(path.join(root, 'data.db'), '', env, { name: 'ai-overrides', ...(ai === undefined ? {} : { ai }) }, definition);
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

async function withProviders(run) {
  const project = await startOpenAiCompatibleEmulator({ keys: [PROJECT_KEY, CALLER_KEY], models: ['project-model', 'other-model'] });
  const other = await startOpenAiCompatibleEmulator({ keys: [PROJECT_KEY, CALLER_KEY], models: ['local-model'] });
  try { await run({ project, other }); } finally { await project.close(); await other.close(); }
}

test('the project key is only ever sent to the project base URL', async () => {
  await withProviders(async ({ project, other }) => {
    await withRuntime({ baseUrl: project.url, model: 'project-model' }, { AI_API_KEY: PROJECT_KEY }, async ({ db, call }) => {
      const leaked = await call('ask', { messages, provider: { baseUrl: other.url, model: 'local-model' } });
      assert.equal(leaked.ok, false);
      assert.equal(leaked.code, 'AI_UNCONFIGURED', 'another base URL without its own key is unconfigured');
      assert.equal(other.requests().length, 0, 'nothing, and no project key, reaches the other provider');

      const keyed = await call('ask', { messages, provider: { baseUrl: other.url, model: 'local-model', apiKey: CALLER_KEY } });
      assert.equal(keyed.ok, true, JSON.stringify(keyed));
      assert.deepEqual(other.requests().map(request => request.key), [CALLER_KEY]);
      assert.equal(other.usage(PROJECT_KEY).calls, 0);

      // The same base URL, spelled with a trailing slash, is still the project's: its key applies.
      const sameOrigin = await call('ask', { messages, provider: { baseUrl: `${project.url}/`, model: 'other-model' } });
      assert.equal(sameOrigin.ok, true, JSON.stringify(sameOrigin));
      assert.equal(sameOrigin.model, 'other-model');
      assert.equal(project.usage(PROJECT_KEY).calls, 1);

      const log = await readFile(db.log.path, 'utf8');
      for (const secret of [PROJECT_KEY, CALLER_KEY, messages[0].content]) assert.equal(log.includes(secret), false, secret);
    });
  });
});

test('per-call provider values activate AI without any ai section', async () => {
  await withProviders(async ({ other }) => {
    await withRuntime(undefined, {}, async ({ call }) => {
      assert.equal(await call('enabled'), false, 'the project default stays dormant');
      assert.equal((await call('ask', { messages })).code, 'AI_UNCONFIGURED');
      const partial = await call('ask', { messages, provider: { baseUrl: other.url, model: 'local-model' } });
      assert.equal(partial.code, 'AI_UNCONFIGURED', 'a call still needs a key from somewhere');
      assert.equal(other.requests().length, 0);

      for (const api of ['chat-completions', 'responses']) {
        const result = await call('ask', { messages, provider: { api, baseUrl: other.url, model: 'local-model', apiKey: CALLER_KEY } });
        assert.equal(result.ok, true, `${api}: ${JSON.stringify(result)}`);
        assert.equal(result.model, 'local-model');
      }
      assert.deepEqual(other.requests().map(request => request.path), ['/v1/chat/completions', '/v1/responses']);
      assert.equal(other.requests()[1].body.store, false);
      assert.equal(other.usage(CALLER_KEY).calls, 2);
    });
  });
});

test('per-call provider values activate a disabled ai section and fall back to what it declares', async () => {
  await withProviders(async ({ project, other }) => {
    const ai = { enabled: false, api: 'responses', baseUrl: project.url, model: 'project-model' };
    await withRuntime(ai, { AI_API_KEY: PROJECT_KEY }, async ({ call }) => {
      assert.equal(await call('enabled'), false);
      assert.equal((await call('ask', { messages })).code, 'AI_UNCONFIGURED', 'without an override, enabled: false stays dormant');
      assert.equal(project.requests().length, 0);

      const keyOnly = await call('ask', { messages, provider: { apiKey: CALLER_KEY } });
      assert.equal(keyOnly.ok, true, JSON.stringify(keyOnly));
      assert.equal(keyOnly.model, 'project-model', 'model falls back to the declaration');
      assert.equal(project.requests().at(-1).path, '/v1/responses', 'api falls back to the declaration');
      assert.equal(project.requests().at(-1).key, CALLER_KEY);

      const modelOnly = await call('ask', { messages, provider: { model: 'other-model' } });
      assert.equal(modelOnly.ok, true, 'the declared key still serves the declared base URL');
      assert.equal(project.requests().at(-1).key, PROJECT_KEY);

      const elsewhere = await call('ask', { messages, provider: { baseUrl: other.url, model: 'local-model' } });
      assert.equal(elsewhere.code, 'AI_UNCONFIGURED', 'the declared key never follows a different base URL');
      assert.equal(other.requests().length, 0);
    });
  });
});

test('overrides keep validating their values', async () => {
  await withProviders(async ({ other }) => {
    await withRuntime(undefined, {}, async ({ call }) => {
      for (const provider of [
        { baseUrl: 'http://api.example.test/v1', model: 'm', apiKey: CALLER_KEY },
        { baseUrl: 'https://user:pass@api.example.test/v1', model: 'm', apiKey: CALLER_KEY },
        { baseUrl: other.url, model: 'has space', apiKey: CALLER_KEY },
        { baseUrl: other.url, model: 'm', apiKey: 'has space' },
        { baseUrl: other.url, model: 'm', apiKey: CALLER_KEY, api: 'completions' },
        { baseUrl: other.url, model: 'm', key: CALLER_KEY },
      ]) assert.equal((await call('ask', { messages, provider })).code, 'AI_INVALID_REQUEST', JSON.stringify(provider));
      assert.equal(other.requests().length, 0);
    });
  });
});
