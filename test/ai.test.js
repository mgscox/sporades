import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { validateAiConfig } from "../dist/cli/project-config.js";
import { createAiRuntime } from "../dist/ai-runtime.js";
import { requiredServerEnvKeys, missingServerEnvKeys } from "../dist/server-env-requirements.js";
import { openDevDatabase, runEndpoint, runMutation, runQuery } from "../dist/server-runtime-source.js";
import { endpoint, job, mutation, query } from "../dist/server.js";

const user = {
  userId: "ai-user",
  displayName: "AI user",
  email: "ai-user@example.com",
  picture: null,
  isAuthenticated: true,
  isGuest: false,
  provider: "test",
};

const PROMPT_SECRET = "prompt-content-that-must-never-be-logged";
const RESPONSE_SECRET = "response-content-that-must-never-be-logged";
const API_KEY = "sk-test-ai-key-value";

/**
 * A stateful local OpenAI-compatible emulator. It serves `/chat/completions` and `/responses`,
 * records every request it receives (method, path, headers and parsed body), and answers each one
 * from a per-test scripted behaviour so the runtime sees real HTTP, real JSON and real sockets.
 */
async function startEmulator() {
  const requests = [];
  let behaviour = () => ({ status: 200 });
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try { body = JSON.parse(raw); } catch {}
    const entry = { method: request.method, path: request.url, headers: request.headers, body };
    requests.push(entry);
    const plan = await behaviour(entry);
    if (plan.hang) return; // never answer: the client must time out or abort
    if (plan.redirect) {
      response.writeHead(302, { location: plan.redirect });
      response.end();
      return;
    }
    const payload = plan.raw ?? JSON.stringify(plan.body ?? defaultPayload(entry));
    response.writeHead(plan.status ?? 200, { "content-type": "application/json" });
    response.end(payload);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    respond(next) { behaviour = next; },
    async close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
}

function defaultPayload(entry) {
  const text = typeof entry.body?.response_format === "object" || typeof entry.body?.text === "object"
    ? JSON.stringify({ plausible: false, reason: RESPONSE_SECRET })
    : RESPONSE_SECRET;
  if (entry.path === "/v1/responses") {
    return {
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
    };
  }
  return {
    id: "chatcmpl_1",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 },
  };
}

const capsule = {
  queries: {
    aiState: query((ctx) => ({ enabled: ctx.ai.enabled })),
  },
  mutations: {
    check: mutation((ctx, input) => ctx.ai.chat(input)),
  },
  endpoints: {
    check: endpoint({ method: "POST", path: "/ai/check" }, async (ctx) => ({
      status: 200,
      body: await ctx.ai.chat(ctx.request.body),
    })),
  },
};

async function withRuntime(config, serverEnv, run, definition = capsule) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-ai-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", serverEnv, { name: "ai-test", ...config }, definition);
  try {
    database.adapter.prepare("INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(user.userId, new Date().toISOString(), user.displayName, user.email, null, 1, 0, user.provider);
    await database.init();
    return await run(database, async () => {
      const raw = await readFile(path.join(dir, "logs", "events.jsonl"), "utf8").catch(() => "");
      return { raw, events: raw.split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
    });
  } finally {
    await database.shutdown();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const ask = (extra = {}) => ({ messages: [{ role: "user", content: PROMPT_SECRET }], ...extra });

test("ai configuration validates shape, defaults and endpoint safety", () => {
  assert.equal(validateAiConfig(undefined), undefined);
  assert.deepEqual(
    { ...validateAiConfig({ baseUrl: "https://api.openai.com/v1/", model: "gpt-4o-mini" }) },
    { enabled: true, api: "chat-completions", keyEnv: "AI_API_KEY", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  );
  const normalized = validateAiConfig({ api: "responses", baseUrl: "https://zdr.example.com/v1", model: "m", keyEnv: "ZDR_KEY" });
  assert.deepEqual({ ...validateAiConfig({ ...normalized }) }, { ...normalized }, "normalization is idempotent");
  assert.deepEqual({ ...validateAiConfig({ enabled: false }) }, { enabled: false, api: "chat-completions", keyEnv: "AI_API_KEY" });
  for (const local of ["http://localhost:11434/v1", "http://127.0.0.1:8000/v1", "http://ollama:11434/v1", "http://host.docker.internal:11434/v1", "http://10.0.0.5/v1", "http://192.168.1.20:8000/v1", "http://[::1]:8000/v1"]) {
    assert.doesNotThrow(() => validateAiConfig({ baseUrl: local, model: "llama3" }), local);
  }
  const invalid = [
    [null, /Invalid AI configuration/],
    [[], /Invalid AI configuration/],
    [{ baseUrl: "https://a.example/v1", model: "m", secret: "x" }, /Invalid AI configuration/],
    [{ baseUrl: "https://a.example/v1", model: "m", apiKey: "sk-inline" }, /Invalid AI configuration/],
    [{ enabled: "yes", baseUrl: "https://a.example/v1", model: "m" }, /Invalid AI enablement/],
    [{ api: "completions", baseUrl: "https://a.example/v1", model: "m" }, /Invalid AI API/],
    [{ model: "m" }, /Invalid AI base URL/],
    [{ baseUrl: "http://api.example.com/v1", model: "m" }, /Invalid AI base URL/],
    [{ baseUrl: "https://user:pass@a.example/v1", model: "m" }, /Invalid AI base URL/],
    [{ baseUrl: "https://a.example/v1?key=x", model: "m" }, /Invalid AI base URL/],
    [{ baseUrl: "https://a.example/v1#x", model: "m" }, /Invalid AI base URL/],
    [{ baseUrl: "ftp://a.example/v1", model: "m" }, /Invalid AI base URL/],
    [{ baseUrl: "https://a.example/v1" }, /Invalid AI model/],
    [{ baseUrl: "https://a.example/v1", model: "has space" }, /Invalid AI model/],
    [{ baseUrl: "https://a.example/v1", model: "m", keyEnv: "lower" }, /Invalid AI Server env reference/],
    [{ baseUrl: "https://a.example/v1", model: "m", keyEnv: "SPORADES_AI" }, /Invalid AI Server env reference/],
    [{ enabled: false, baseUrl: "not a url" }, /Invalid AI base URL/],
  ];
  for (const [value, expected] of invalid) {
    assert.throws(() => validateAiConfig(value), (error) => error.code === "INVALID_AI_CONFIG" && expected.test(error.message), JSON.stringify(value));
  }
  let getterCalls = 0;
  const accessor = { baseUrl: "https://a.example/v1" };
  Object.defineProperty(accessor, "model", { enumerable: true, get() { getterCalls += 1; return "m"; } });
  assert.throws(() => validateAiConfig(accessor), /Invalid AI configuration/);
  assert.equal(getterCalls, 0, "configuration is read without executing getters");
});

test("ai key is never a required Server env key, so doctor and host push are unaffected", () => {
  const config = { ai: validateAiConfig({ baseUrl: "https://a.example/v1", model: "m", keyEnv: "ZDR_KEY" }) };
  assert.deepEqual(requiredServerEnvKeys(config), []);
  assert.deepEqual(missingServerEnvKeys(config, {}), []);
  assert.deepEqual(requiredServerEnvKeys({ ...config, env: { required: ["OTHER"] } }), ["OTHER"]);
});

test("a declared but key-less ai runtime boots dormant and reports AI_UNCONFIGURED", async () => {
  const emulator = await startEmulator();
  try {
    await withRuntime({ ai: { baseUrl: emulator.baseUrl, model: "local-model" }, env: { failClosed: true } }, {}, async (database, logs) => {
      assert.deepEqual((await runQuery(database, user, "aiState")).data, { enabled: false });
      const result = (await runMutation(database, user, "check", [ask()])).data;
      assert.deepEqual(result, { ok: false, code: "AI_UNCONFIGURED", message: "AI is not configured." });
      const events = (await logs()).events.filter((event) => event.event === "ai.call");
      assert.equal(events.length, 1);
      assert.equal(events[0].data.outcome, "AI_UNCONFIGURED");
    });
    await withRuntime({}, { AI_API_KEY: API_KEY }, async (database) => {
      assert.deepEqual((await runQuery(database, user, "aiState")).data, { enabled: false });
      const result = (await runMutation(database, user, "check", [ask({ provider: { baseUrl: emulator.baseUrl, model: "m", apiKey: API_KEY } })])).data;
      assert.equal(result.code, "AI_UNCONFIGURED", "per-call overrides cannot stand in for the project declaration");
    });
    await withRuntime({ ai: { enabled: false, baseUrl: emulator.baseUrl, model: "m" } }, { AI_API_KEY: API_KEY }, async (database) => {
      assert.equal((await runMutation(database, user, "check", [ask()])).data.code, "AI_UNCONFIGURED");
    });
    assert.equal(emulator.requests.length, 0, "no dormant call reaches the provider");
  } finally {
    await emulator.close();
  }
});

test("chat-completions success sends the neutral request on the wire and never logs content", async () => {
  const emulator = await startEmulator();
  try {
    await withRuntime({ ai: { baseUrl: emulator.baseUrl, model: "local-model" } }, { AI_API_KEY: API_KEY }, async (database, logs) => {
      assert.deepEqual((await runQuery(database, user, "aiState")).data, { enabled: true });
      const result = (await runMutation(database, user, "check", [ask({ system: "Be brief.", maxTokens: 64, temperature: 0 })])).data;
      assert.deepEqual(result, {
        ok: true,
        text: RESPONSE_SECRET,
        usage: { inputTokens: 9, outputTokens: 5, totalTokens: 14 },
        model: "local-model",
      });
      const [request] = emulator.requests;
      assert.equal(request.method, "POST");
      assert.equal(request.path, "/v1/chat/completions");
      assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
      assert.deepEqual(request.body, {
        model: "local-model",
        messages: [{ role: "system", content: "Be brief." }, { role: "user", content: PROMPT_SECRET }],
        stream: false,
        max_tokens: 64,
        temperature: 0,
      });
      const { raw, events } = await logs();
      assert.doesNotMatch(raw, new RegExp(PROMPT_SECRET));
      assert.doesNotMatch(raw, new RegExp(RESPONSE_SECRET));
      assert.doesNotMatch(raw, new RegExp(API_KEY));
      assert.doesNotMatch(raw, /Be brief/);
      const metering = events.filter((event) => event.event === "ai.call");
      assert.equal(metering.length, 1);
      assert.equal(metering[0].category, "ai");
      const { latencyMs, ...data } = metering[0].data;
      assert.ok(Number.isInteger(latencyMs) && latencyMs >= 0);
      assert.deepEqual(data, { api: "chat-completions", model: "local-model", outcome: "ok", usage: { input: 9, output: 5, total: 14 } });
    });
  } finally {
    await emulator.close();
  }
});

test("responses success sends store:false and parses schema output as JSON", async () => {
  const emulator = await startEmulator();
  const schema = { type: "object", properties: { plausible: { type: "boolean" }, reason: { type: "string" } }, required: ["plausible", "reason"], additionalProperties: false };
  try {
    await withRuntime({ ai: { api: "responses", baseUrl: emulator.baseUrl, model: "zdr-model", keyEnv: "ZDR_KEY" } }, { ZDR_KEY: API_KEY }, async (database, logs) => {
      const result = (await runMutation(database, user, "check", [ask({ system: "Validate.", jsonSchema: schema, maxTokens: 32 })])).data;
      assert.deepEqual(result, {
        ok: true,
        text: JSON.stringify({ plausible: false, reason: RESPONSE_SECRET }),
        json: { plausible: false, reason: RESPONSE_SECRET },
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
        model: "zdr-model",
      });
      const [request] = emulator.requests;
      assert.equal(request.path, "/v1/responses");
      assert.deepEqual(request.body, {
        model: "zdr-model",
        instructions: "Validate.",
        input: [{ role: "user", content: PROMPT_SECRET }],
        store: false,
        stream: false,
        max_output_tokens: 32,
        text: { format: { type: "json_schema", name: "response", schema, strict: true } },
      });
      const metering = (await logs()).events.find((event) => event.event === "ai.call");
      assert.equal(metering.data.api, "responses");
      assert.deepEqual(metering.data.usage, { input: 11, output: 7, total: 18 });
    });
  } finally {
    await emulator.close();
  }
});

test("chat-completions schema calls request json_schema and per-call provider overrides apply", async () => {
  const primary = await startEmulator();
  const secondary = await startEmulator();
  try {
    await withRuntime({ ai: { baseUrl: primary.baseUrl, model: "primary-model" } }, { AI_API_KEY: API_KEY }, async (database) => {
      const schema = { type: "object", properties: { plausible: { type: "boolean" } }, required: ["plausible"], additionalProperties: false };
      const schemaResult = (await runMutation(database, user, "check", [ask({ jsonSchema: schema })])).data;
      assert.equal(schemaResult.ok, true);
      assert.deepEqual(schemaResult.json, { plausible: false, reason: RESPONSE_SECRET });
      assert.deepEqual(primary.requests[0].body.response_format, { type: "json_schema", json_schema: { name: "response", schema, strict: true } });

      const overridden = (await runMutation(database, user, "check", [ask({ provider: { api: "responses", baseUrl: secondary.baseUrl, model: "other", apiKey: "sk-other" } })])).data;
      assert.equal(overridden.ok, true);
      assert.equal(overridden.model, "other");
      assert.equal(primary.requests.length, 1);
      assert.equal(secondary.requests[0].path, "/v1/responses");
      assert.equal(secondary.requests[0].headers.authorization, "Bearer sk-other");
      assert.equal(secondary.requests[0].body.store, false);
    });
  } finally {
    await primary.close();
    await secondary.close();
  }
});

test("upstream errors, redirects, timeouts and invalid responses resolve to closed result codes", async () => {
  const emulator = await startEmulator();
  try {
    await withRuntime({ ai: { baseUrl: emulator.baseUrl, model: "m" } }, { AI_API_KEY: API_KEY }, async (database, logs) => {
      const call = async (extra = {}) => (await runMutation(database, user, "check", [ask(extra)])).data;

      emulator.respond(() => ({ status: 429, body: { error: { message: `rate limited: ${RESPONSE_SECRET}` } } }));
      assert.deepEqual(await call(), { ok: false, code: "AI_UPSTREAM_ERROR", message: "The AI provider request failed.", status: 429 });
      emulator.respond(() => ({ status: 500, raw: "upstream exploded" }));
      assert.equal((await call()).status, 500);

      emulator.respond(() => ({ redirect: "https://elsewhere.example/v1/chat/completions" }));
      const redirected = await call();
      assert.equal(redirected.code, "AI_UPSTREAM_ERROR", "redirects are refused rather than followed");
      assert.equal(redirected.status, undefined);

      emulator.respond(() => ({ hang: true }));
      const startedAt = Date.now();
      assert.deepEqual(await call({ timeoutMs: 150 }), { ok: false, code: "AI_TIMEOUT", message: "The AI provider did not respond in time." });
      assert.ok(Date.now() - startedAt < 2_000);

      emulator.respond(() => ({ raw: "not json" }));
      assert.equal((await call()).code, "AI_INVALID_RESPONSE");
      emulator.respond(() => ({ body: { choices: [] } }));
      assert.equal((await call()).code, "AI_INVALID_RESPONSE");
      emulator.respond(() => ({ body: { choices: [{ message: { role: "assistant", content: null, refusal: "no" } }] } }));
      assert.equal((await call()).code, "AI_INVALID_RESPONSE");
      emulator.respond(() => ({ body: { choices: [{ message: { content: "not json" } }] } }));
      assert.equal((await call({ jsonSchema: { type: "object" } })).code, "AI_INVALID_RESPONSE");
      emulator.respond(() => ({ raw: JSON.stringify({ choices: [{ message: { content: "x".repeat(1024 * 1024 + 1) } }] }) }));
      assert.equal((await call()).code, "AI_INVALID_RESPONSE", "oversized responses are refused");

      emulator.respond(() => ({ body: { status: "failed", output: [] } }));
      assert.equal((await call({ provider: { api: "responses" } })).code, "AI_INVALID_RESPONSE");

      const { raw, events } = await logs();
      assert.doesNotMatch(raw, new RegExp(RESPONSE_SECRET));
      assert.doesNotMatch(raw, /upstream exploded|rate limited/);
      const outcomes = events.filter((event) => event.event === "ai.call").map((event) => event.data.outcome);
      assert.deepEqual(outcomes, [
        "AI_UPSTREAM_ERROR", "AI_UPSTREAM_ERROR", "AI_UPSTREAM_ERROR", "AI_TIMEOUT",
        "AI_INVALID_RESPONSE", "AI_INVALID_RESPONSE", "AI_INVALID_RESPONSE", "AI_INVALID_RESPONSE", "AI_INVALID_RESPONSE", "AI_INVALID_RESPONSE",
      ]);
      assert.equal(events.find((event) => event.data?.status === 429)?.event, "ai.call");
    });
  } finally {
    await emulator.close();
  }
});

test("invalid requests and unreachable providers never throw and send nothing", async () => {
  const emulator = await startEmulator();
  try {
    await withRuntime({ ai: { baseUrl: emulator.baseUrl, model: "m" } }, { AI_API_KEY: API_KEY }, async (database) => {
      const invalid = [
        undefined,
        null,
        "prompt",
        { messages: [] },
        { messages: [{ role: "system", content: "x" }] },
        { messages: [{ role: "user", content: 1 }] },
        { messages: [{ role: "user", content: "x", name: "extra" }] },
        ask({ unknown: true }),
        ask({ system: 1 }),
        ask({ maxTokens: 0 }),
        ask({ maxTokens: 1.5 }),
        ask({ timeoutMs: 50 }),
        ask({ timeoutMs: 30_001 }),
        ask({ temperature: 3 }),
        ask({ jsonSchema: [] }),
        ask({ provider: { api: "completions" } }),
        ask({ provider: { baseUrl: "http://public.example.com/v1" } }),
        ask({ provider: { model: "" } }),
        ask({ provider: { apiKey: "has space" } }),
        ask({ provider: { secret: "x" } }),
        { messages: Array.from({ length: 65 }, () => ({ role: "user", content: "x" })) },
        { messages: [{ role: "user", content: "x".repeat(256 * 1024 + 1) }] },
        new Proxy({}, { ownKeys() { throw new Error("hostile"); } }),
      ];
      for (const [index, input] of invalid.entries()) {
        const result = await database.ai.chat(input);
        assert.equal(result.ok, false);
        assert.equal(result.code, "AI_INVALID_REQUEST", `invalid input #${index}`);
      }
      assert.equal(emulator.requests.length, 0);

      const unreachable = await database.ai.chat(ask({ provider: { baseUrl: "http://127.0.0.1:9/v1" } }));
      assert.equal(unreachable.code, "AI_UPSTREAM_ERROR");
      assert.equal(unreachable.status, undefined);
    });
  } finally {
    await emulator.close();
  }
});

test("caller and Job cancellation resolve AI_ABORTED", async () => {
  const emulator = await startEmulator();
  emulator.respond(() => ({ hang: true }));
  try {
    const runtime = createAiRuntime(validateAiConfig({ baseUrl: emulator.baseUrl, model: "m" }), { AI_API_KEY: API_KEY });
    const preAborted = AbortSignal.abort();
    assert.equal((await runtime.chat(ask({ signal: preAborted }))).code, "AI_ABORTED");
    assert.equal(emulator.requests.length, 0, "an already-aborted call sends nothing");

    const controller = new AbortController();
    const pending = runtime.chat(ask({ signal: controller.signal, timeoutMs: 5_000 }));
    while (emulator.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    assert.deepEqual(await pending, { ok: false, code: "AI_ABORTED", message: "The AI request was aborted." });

    const contextController = new AbortController();
    const fromContext = runtime.chat(ask({ timeoutMs: 5_000 }), { signal: contextController.signal });
    while (emulator.requests.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    contextController.abort();
    assert.equal((await fromContext).code, "AI_ABORTED", "the handler context signal (Jobs, Privileged runs) cancels the call");
  } finally {
    await emulator.close();
  }
});

test("ctx.ai is available to endpoints, Jobs and Privileged callbacks", async () => {
  const emulator = await startEmulator();
  const observed = [];
  const definition = {
    ...capsule,
    mutations: {
      ...capsule.mutations,
      enqueue: mutation((ctx) => ctx.jobs.enqueue("check", {})),
      privileged: mutation((ctx) => ctx.privileged.run(
        { operation: "ai.check", targetResourceKind: "capsule" },
        async (privilegedCtx) => (await privilegedCtx.ai.chat(ask())).ok,
      )),
    },
    jobs: {
      check: job(async (ctx) => { observed.push(await ctx.ai.chat(ask())); }),
    },
  };
  try {
    await withRuntime({ ai: { baseUrl: emulator.baseUrl, model: "m" } }, { AI_API_KEY: API_KEY }, async (database) => {
      const declared = database.endpoints.find((candidate) => candidate.path === "/ai/check");
      const response = await runEndpoint(
        database,
        declared,
        new URL("http://localhost/ai/check"),
        Object.assign(Readable.from([Buffer.from(JSON.stringify(ask()))]), { method: "POST", headers: { "content-type": "application/json" } }),
      );
      const body = response.body ?? response;
      assert.equal(body.ok, true, JSON.stringify(response));
      assert.equal(body.text, RESPONSE_SECRET);

      const privileged = await runMutation(database, user, "privileged", []);
      assert.equal(privileged.error, null);
      assert.equal(privileged.data, true);

      assert.equal((await runMutation(database, user, "enqueue", [])).error, null);
      const deadline = Date.now() + 5_000;
      while (observed.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(observed[0]?.ok, true);
    }, definition);
  } finally {
    await emulator.close();
  }
});
