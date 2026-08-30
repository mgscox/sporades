import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createCipheriv, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";
import { String as StringField, table } from "../dist/server.js";

// Thirteen of these were `SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === …)` until batch 3
// moved the auth domain into `auth-runtime.ts`. That lookup does not fail when a domain leaves the
// emitted list — it returns `undefined`, and every test below would then call `undefined(…)` or,
// worse, assert against a value derived from one. Named imports through the re-export bridge on
// `server-runtime-source.js` fail at load instead, which is the point of converting them.
//
// `beginOAuthSignIn` and `resolveOAuthRequestOrigin` joined them in batch 8, which moved the HTTP
// layer that had been holding them — the first into `auth-runtime.ts` with the rest of its domain,
// the second into `http-runtime.ts`, because its body validates a request origin against the CORS
// policy and reaches no auth name. Both resolve through the re-export bridge either way. They were
// the last two `.find` lookups in this file, and converting them is not optional: a module-scope
// `.find` that binds `undefined` does not fail the test that uses it, it fails the *import* of the
// whole file, which reports as fewer tests run rather than as a red.
//
// `linkProviderIdentity` joined the named imports in batch 5, which moved the user-preferences
// domain and with it the seven auth functions `migrateAnonymousPreferences` had been holding. It is
// the exact failure this comment describes: it left the emitted list in that batch, so the `.find`
// spelling below would have bound `undefined` and every assertion using it would have called
// `undefined(…)` rather than going red at load.
import {
  appleOAuthOriginEligible,
  beginOAuthSignIn,
  linkProviderIdentity,
  completeMicrosoftOAuth,
  completeOpenIdOAuthCodeExchange,
  createAppleClientSecret,
  discoverMicrosoftOpenIdConfiguration,
  fetchBoundedOAuthJson,
  fetchMicrosoftOidcJson,
  isOAuthLoopbackHostname,
  loadMicrosoftJwks,
  oauthProviderTestEndpoint,
  openDevDatabase,
  reconcileOAuthRegistrationKeys,
  retireOAuthRegistrationKeys,
  rotateOAuthRegistrationKey,
  resolveAnonymousSession,
  resolveOAuthRequestOrigin,
  routeSporadesAuth,
  verifyAppleIdentityToken,
  verifyGoogleIdentityToken,
  verifyMicrosoftIdentityToken,
} from "../dist/server-runtime-source.js";

const execFileAsync = promisify(execFile);

test("provider endpoint overrides require the explicit loopback-only test seam", () => {
  const original = process.env.SPORADES_OAUTH_TEST_ENDPOINTS;
  try {
    delete process.env.SPORADES_OAUTH_TEST_ENDPOINTS;
    assert.equal(
      oauthProviderTestEndpoint("http://127.0.0.1:9000/token", "https://provider.example/token"),
      "https://provider.example/token",
    );
    process.env.SPORADES_OAUTH_TEST_ENDPOINTS = "1";
    assert.equal(
      oauthProviderTestEndpoint("https://attacker.example/token", "https://provider.example/token"),
      "https://provider.example/token",
    );
    assert.equal(
      oauthProviderTestEndpoint("http://127.0.0.1:9000/token", "https://provider.example/token"),
      "http://127.0.0.1:9000/token",
    );
    assert.equal(
      oauthProviderTestEndpoint("https://[::1]:9000/token", "https://provider.example/token"),
      "https://[::1]:9000/token",
    );
    for (const endpoint of [
      "http://127.0.0.2:9000/token",
      "http://[::2]:9000/token",
      "http://user@127.0.0.1:9000/token",
      "http://user:password@[::1]:9000/token",
    ]) {
      assert.equal(
        oauthProviderTestEndpoint(endpoint, "https://provider.example/token"),
        "https://provider.example/token",
      );
    }
    assert.equal(isOAuthLoopbackHostname("127.0.0.1"), true);
    assert.equal(isOAuthLoopbackHostname("[::1]"), true);
    assert.equal(isOAuthLoopbackHostname("::1"), true);
    assert.equal(isOAuthLoopbackHostname("127.0.0.2"), false);
    assert.equal(isOAuthLoopbackHostname("[::2]"), false);
  } finally {
    if (original === undefined) delete process.env.SPORADES_OAUTH_TEST_ENDPOINTS;
    else process.env.SPORADES_OAUTH_TEST_ENDPOINTS = original;
  }
});

test("bounded OAuth JSON fetch refuses every redirect and closes stalled or oversized bodies", async () => {
  let receiverRequests = 0;
  let redirectStatus = 301;
  const receiver = createServer((_request, response) => {
    receiverRequests += 1;
    response.end("{}");
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const receiverPort = receiver.address().port;
  let mode = "redirect";
  const source = createServer((request, response) => {
    if (mode === "redirect") {
      response.writeHead(redirectStatus, { location: `http://127.0.0.1:${receiverPort}/receiver` });
      response.end();
      return;
    }
    if (mode === "http") {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"privateKey":"upstream"}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    if (mode === "stall") {
      response.write('{"privateKey":"partial');
      return;
    }
    if (mode === "malformed") {
      response.end('{"privateKey":"broken"');
      return;
    }
    response.write(`{"padding":"${"x".repeat(70 * 1024)}"}`);
    response.end();
  });
  await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
  const sourcePort = source.address().port;
  const policy = {
    maxBytes: 64 * 1024,
    timeoutProperty: "__oauthJwksTimeoutMs",
    defaultTimeoutMs: 5_000,
    unavailableCode: "OAUTH_TEST_KEYS_UNAVAILABLE",
    unavailableMessage: "Signing keys were unavailable.",
    unavailableHint: "Retry.",
    invalidCode: "OAUTH_TEST_KEYS_INVALID",
    invalidMessage: "Signing keys were invalid.",
    invalidHint: "Retry.",
  };
  try {
    for (const status of [301, 302, 307, 308]) {
      redirectStatus = status;
      await assert.rejects(
        fetchBoundedOAuthJson({}, `http://127.0.0.1:${sourcePort}/redirect`, {}, policy),
        (error) => error.code === "OAUTH_TEST_KEYS_UNAVAILABLE",
      );
    }
    assert.equal(receiverRequests, 0);

    source.closeIdleConnections();
    await new Promise((resolve) => setImmediate(resolve));
    mode = "stall";
    await assert.rejects(
      fetchBoundedOAuthJson(
        { __oauthJwksTimeoutMs: 30 },
        `http://127.0.0.1:${sourcePort}/stall`,
        {},
        policy,
      ),
      (error) => error.code === "OAUTH_TEST_KEYS_UNAVAILABLE" &&
        !/privateKey|partial/i.test(`${error.message} ${error.hint}`),
    );
    const cleanupDeadline = Date.now() + 5_000;
    while (source._connections !== 0 && Date.now() < cleanupDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(source._connections, 0);

    mode = "oversized";
    await assert.rejects(
      fetchBoundedOAuthJson({}, `http://127.0.0.1:${sourcePort}/oversized`, {}, policy),
      (error) => error.code === "OAUTH_TEST_KEYS_INVALID",
    );

    mode = "malformed";
    await assert.rejects(
      fetchBoundedOAuthJson({}, `http://127.0.0.1:${sourcePort}/malformed`, {}, policy),
      (error) => error.code === "OAUTH_TEST_KEYS_INVALID" &&
        !/privateKey|broken/i.test(`${error.message} ${error.hint}`),
    );

    mode = "http";
    await assert.rejects(
      fetchBoundedOAuthJson({}, `http://127.0.0.1:${sourcePort}/http`, {}, policy),
      (error) => error.code === "OAUTH_TEST_KEYS_UNAVAILABLE" &&
        !/privateKey|upstream/i.test(`${error.message} ${error.hint}`),
    );
  } finally {
    await new Promise((resolve) => source.close(resolve));
    await new Promise((resolve) => receiver.close(resolve));
  }
});

test("Google and Apple JWKS failures retain bounded provider key taxonomy", async () => {
  await withTempDatabase(async (database) => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const token = signedJwt(privateKey, "provider-key", {});
    const originalFetch = globalThis.fetch;
    try {
      for (const verifyToken of [verifyGoogleIdentityToken, verifyAppleIdentityToken]) {
        globalThis.fetch = async () => new Response("{malformed", { status: 200 });
        await assert.rejects(
          verifyToken(database, token, "nonce"),
          (error) => error.code === "OAUTH_ID_TOKEN_KEYS_INVALID" &&
            !/malformed/i.test(`${error.message} ${error.hint}`),
        );
        globalThis.fetch = async () => new Response("private upstream body", { status: 503 });
        await assert.rejects(
          verifyToken(database, token, "nonce"),
          (error) => error.code === "OAUTH_ID_TOKEN_KEYS_UNAVAILABLE" &&
            !/private upstream body/i.test(`${error.message} ${error.hint}`),
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Microsoft discovery accepts an exact IPv6 loopback override when IPv6 is available", async (t) => {
  const server = createServer((_request, response) => {
    const origin = `http://[::1]:${server.address().port}`;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      jwks_uri: `${origin}/keys`,
    }));
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "::1", resolve);
    });
  } catch (error) {
    if (error?.code === "EADDRNOTAVAIL" || error?.code === "EAFNOSUPPORT") {
      t.skip("IPv6 loopback is unavailable on this platform.");
      return;
    }
    throw error;
  }
  const originalEndpoints = process.env.SPORADES_OAUTH_TEST_ENDPOINTS;
  const originalDiscovery = process.env.SPORADES_MICROSOFT_DISCOVERY_URL;
  try {
    process.env.SPORADES_OAUTH_TEST_ENDPOINTS = "1";
    process.env.SPORADES_MICROSOFT_DISCOVERY_URL = `http://[::1]:${server.address().port}/discovery`;
    const database = {
      authConfig: {
        providers: {
          microsoft: {
            clientIdEnv: "MICROSOFT_CLIENT_ID",
            clientSecretEnv: "MICROSOFT_CLIENT_SECRET",
          },
        },
      },
      __microsoftOidcTimeoutMs: 500,
    };
    const discovery = await discoverMicrosoftOpenIdConfiguration(database, "organizations");
    assert.equal(new URL(discovery.jwks_uri).hostname, "[::1]");
  } finally {
    if (originalEndpoints === undefined) delete process.env.SPORADES_OAUTH_TEST_ENDPOINTS;
    else process.env.SPORADES_OAUTH_TEST_ENDPOINTS = originalEndpoints;
    if (originalDiscovery === undefined) delete process.env.SPORADES_MICROSOFT_DISCOVERY_URL;
    else process.env.SPORADES_MICROSOFT_DISCOVERY_URL = originalDiscovery;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("provider auth exposes one internal completion and linking seam", async () => {
  // The negatives are the point of this test: a per-provider `completeGoogleOAuth` reappearing
  // anywhere in the runtime has to fail it. So the subject set has to include names nothing exports.
  //
  // This read the emitted list plus `Object.keys` of the auth module until ticket 05. The list is
  // deleted, and `Object.keys` of a namespace sees only exports — so on its own it would have turned
  // both negatives vacuous, passing for exactly the reason a per-provider function would be added:
  // privately. Declarations are read out of the compiled text instead, which sees the private ones.
  const declaredRuntimeNames = (file) => {
    const source = readFileSync(new URL(`../dist/${file}`, import.meta.url), "utf8");
    return [...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map(([, name]) => name);
  };
  const names = new Set([
    ...declaredRuntimeNames("auth-runtime.js"),
    ...declaredRuntimeNames("http-runtime.js"),
    ...declaredRuntimeNames("server-runtime-source.js"),
  ]);
  assert.equal(names.has("linkProviderIdentity"), true);
  assert.equal(names.has("completeOpenIdOAuthCodeExchange"), true);
  assert.equal(names.has("linkGoogleAccount"), false);
  assert.equal(names.has("completeGoogleOAuth"), false);
});

test("shared OpenID exchange refuses credential-bearing HTTP redirects", async () => {
  let receiverRequests = 0;
  let receiverBody = "";
  let redirectStatus = 307;
  const receiver = createServer(async (request, response) => {
    receiverRequests += 1;
    for await (const chunk of request) receiverBody += chunk;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id_token: "redirected-token" }));
  });
  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const receiverPort = receiver.address().port;
  const redirector = createServer((_request, response) => {
    response.writeHead(redirectStatus, { location: `http://127.0.0.1:${receiverPort}/stolen` });
    response.end();
  });
  await new Promise((resolve) => redirector.listen(0, "127.0.0.1", resolve));
  const redirectorPort = redirector.address().port;
  try {
    for (const status of [307, 308]) {
      redirectStatus = status;
      await assert.rejects(
        completeOpenIdOAuthCodeExchange({}, { nonce: "nonce" }, {
          tokenUrl: `http://127.0.0.1:${redirectorPort}/token`,
          parameters: { code: "authorization-code", client_secret: "super-secret" },
          exchangeMessage: "Example OAuth code exchange failed.",
          exchangeHint: "Retry Example sign-in.",
          responseMessage: "Example OAuth response was invalid.",
          tokenMessage: "Example OAuth response did not include a valid identity token.",
          tokenHint: "Retry Example sign-in.",
          verify: async () => ({ subject: "must-not-run" }),
        }),
        (error) => error.code === "OAUTH_EXCHANGE_FAILED",
      );
    }
    assert.equal(receiverRequests, 0);
    assert.doesNotMatch(receiverBody, /authorization-code|super-secret/);
  } finally {
    await new Promise((resolve) => redirector.close(resolve));
    await new Promise((resolve) => receiver.close(resolve));
  }
});

test("shared OpenID exchange bounds status, malformed, oversized, and stalled response bodies", async () => {
  const originalFetch = globalThis.fetch;
  const contract = {
    tokenUrl: "https://provider.example/token",
    parameters: { code: "authorization-code", client_secret: "super-secret" },
    exchangeMessage: "Example OAuth code exchange failed.",
    exchangeHint: "Retry Example sign-in.",
    responseMessage: "Example OAuth response was invalid.",
    tokenMessage: "Example OAuth response did not include a valid identity token.",
    tokenHint: "Retry Example sign-in.",
    exchangeCode: "EXAMPLE_EXCHANGE_FAILED",
    timeoutCode: "EXAMPLE_EXCHANGE_TIMEOUT",
    timeoutMessage: "Example OAuth code exchange timed out.",
    verify: async () => ({ subject: "verified" }),
  };
  const assertSafeFailure = async (response, code, message) => {
    globalThis.fetch = async () => response;
    await assert.rejects(
      completeOpenIdOAuthCodeExchange({}, { nonce: "nonce" }, contract),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.message, message);
        assert.doesNotMatch(`${error.message} ${error.hint}`, /super-secret|upstream-private|authorization-code/);
        return true;
      },
    );
  };
  try {
    await assertSafeFailure(
      new Response("upstream-private", { status: 400 }),
      "EXAMPLE_EXCHANGE_FAILED",
      "Example OAuth code exchange failed.",
    );
    await assertSafeFailure(
      new Response('{"upstream-private":', { status: 200 }),
      "EXAMPLE_EXCHANGE_FAILED",
      "Example OAuth response was invalid.",
    );

    let cancelled = false;
    const oversized = new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(70 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200 });
    await assertSafeFailure(
      oversized,
      "EXAMPLE_EXCHANGE_FAILED",
      "Example OAuth response was invalid.",
    );
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  let closedResolve;
  const closed = new Promise((resolve) => { closedResolve = resolve; });
  const stalled = createServer((request, response) => {
    request.on("close", closedResolve);
    response.on("close", closedResolve);
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"upstream-private":"partial');
  });
  await new Promise((resolve) => stalled.listen(0, "127.0.0.1", resolve));
  const stalledPort = stalled.address().port;
  const startedAt = Date.now();
  try {
    await assert.rejects(
      completeOpenIdOAuthCodeExchange(
        { __oauthExchangeTimeoutMs: 25 },
        { nonce: "nonce" },
        { ...contract, tokenUrl: `http://127.0.0.1:${stalledPort}/token` },
      ),
      (error) => {
        assert.equal(error.code, "EXAMPLE_EXCHANGE_TIMEOUT");
        assert.equal(error.message, "Example OAuth code exchange timed out.");
        assert.doesNotMatch(`${error.message} ${error.hint}`, /upstream-private|partial|super-secret/);
        return true;
      },
    );
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))]);
    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(stalled._connections, 0);
  } finally {
    await new Promise((resolve) => stalled.close(resolve));
  }
});

async function withTempDatabase(fn, capsuleDefinition = undefined) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-oauth-provider-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
    auth: { providers: { anonymous: true } },
  }, capsuleDefinition);
  try {
    return await fn(database);
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("OAuth registration admission survives a runtime restart without plaintext state and spends once", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-oauth-registration-restart-"));
  const file = path.join(dir, "data.db");
  let admissionShape = null;
  const capsule = { name: "restart-admission", schema: {}, auth: { registration: { admit: ({ admission }) => { admissionShape = { type: typeof admission, keys: admission && typeof admission === "object" ? Object.keys(admission).sort() : [], bytes: Buffer.byteLength(JSON.stringify(admission ?? null)) }; return admission?.key === "restart" ? { allow: true } : { allow: false }; }, finalize: () => {} } } };
  const adapter = { provider: "google", responseMode: "query", enabled: true, begin: ({ state }) => ({ url: `https://google.example/authorize?state=${state}` }), complete: async () => ({ subject: "restart-subject", email: "restart@example.com", emailVerified: true }) };
  let database;
  try {
    database = await openDevDatabase(file, "", {}, { auth: { providers: { anonymous: true } } }, capsule); database.__oauthProviderAdapters = { google: adapter };
    const session = await resolveAnonymousSession(database, null);
    const started = await beginOAuthSignIn(database, session, "google", { origin: "https://capsule.example.test", returnTo: "https://capsule.example.test/after", registration: { admission: { key: "restart" } } });
    const state = new URL(started.url).searchParams.get("state");
    const stored = await database.adapter.prepare("SELECT registrationCiphertext, provider, sessionToken, redirectUri, nonce, expiresAt FROM sporades_auth_oauth_states WHERE state = ?").get(state);
    assert.doesNotMatch(stored.registrationCiphertext, /restart/); assert.match(stored.registrationCiphertext, /^[A-Za-z0-9_-]{22}\./); assert.doesNotMatch(stored.registrationCiphertext, /^active\./);
    database.close(); database = await openDevDatabase(file, "", {}, { auth: { providers: { anonymous: true } } }, capsule); database.__oauthProviderAdapters = { google: adapter };
    const restarted = await database.adapter.prepare("SELECT registrationCiphertext, provider, sessionToken, redirectUri, nonce, expiresAt FROM sporades_auth_oauth_states WHERE state = ?").get(state);
    assert.deepEqual(Object.fromEntries(["provider", "sessionToken", "redirectUri", "nonce", "expiresAt"].map((key) => [key, restarted[key] === stored[key]])), { provider: true, sessionToken: true, redirectUri: true, nonce: true, expiresAt: true });
    const active = await database.adapter.readSystemMetadata("oauth-registration-key:active");
    assert.match(active.value, /^[A-Za-z0-9_-]{22}$/);
    assert.match((await database.adapter.readSystemMetadata(`oauth-registration-key:key:${active.value}`)).value, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await resolveAnonymousSession(database, stored.sessionToken)).auth.isGuest, true);
    assert.equal(typeof database.runRegistrationAdmission, "function");
    const first = responseRecorder(); await routeSporadesAuth(database, { method: "GET", url: `/__sporades/auth/google/callback?state=${state}&code=ok`, headers: {} }, first);
    assert.deepEqual(admissionShape, { type: "object", keys: ["key"], bytes: 17 });
    assert.equal(first.statusCode, 302, first.body);
    const replay = responseRecorder(); await routeSporadesAuth(database, { method: "GET", url: `/__sporades/auth/google/callback?state=${state}&code=ok`, headers: {} }, replay);
    assert.equal(replay.statusCode, 400); assert.doesNotMatch(replay.body, /restart|active\.|[A-Za-z0-9_-]{43}/);
  } finally { database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("OAuth registration roundtrip preserves explicit null admission", async () => {
  let seen = "unset"; const definition = { name: "oauth-null", auth: { registration: { admit: ({ admission }) => { seen = admission; return { allow: admission === null }; }, finalize: async () => {} } } };
  await withTempDatabase(async (database) => {
    database.__oauthProviderAdapters = { google: { provider: "google", responseMode: "query", enabled: true, begin: ({ state }) => ({ url: `https://google.example/authorize?state=${state}` }), complete: async () => ({ subject: "null-subject", email: "null@example.com", emailVerified: true }) } };
    const session = await resolveAnonymousSession(database, null); const started = await beginOAuthSignIn(database, session, "google", { origin: "https://capsule.example.test", registration: { admission: null } }); const state = new URL(started.url).searchParams.get("state");
    const response = responseRecorder(); await routeSporadesAuth(database, { method: "GET", url: `/__sporades/auth/google/callback?state=${state}&code=ok`, headers: {} }, response);
    assert.equal(response.statusCode, 302); assert.equal(seen, null);
  }, definition);
});

test("corrupt OAuth admission envelopes deny before a database-only first-user policy", async () => {
  let policyCalls = 0; let finalizerCalls = 0;
  const capsule = { name: "oauth-envelope-denial", schema: { claims: table({ userId: StringField() }) }, auth: { registration: {
    admit: async ({ db }) => { policyCalls += 1; return { allow: (await db.claims.all()).length === 0 }; },
    finalize: async ({ db }, admitted) => { finalizerCalls += 1; await db.claims.insert({ userId: admitted.userId }); },
  } } };
  await withTempDatabase(async (database) => {
    const active = await database.adapter.readSystemMetadata("oauth-registration-key:active");
    const material = (await database.adapter.readSystemMetadata(`oauth-registration-key:key:${active.value}`)).value;
    const bindings = { provider: "google", redirectUri: "https://capsule.example.test/__sporades/auth/google/callback", nonce: "nonce", expiresAt: "2099-01-01T00:00:00.000Z" };
    const authenticatedEnvelope = (plaintext, binding = bindings) => { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", Buffer.from(material, "base64url"), iv); cipher.setAAD(Buffer.from(`${binding.provider}\n${binding.sessionToken}\n${binding.redirectUri}\n${binding.nonce}\n${binding.expiresAt}`)); const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]); return `${active.value}.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`; };
    const validBinding = { ...bindings, sessionToken: "filled-per-case" }; const valid = authenticatedEnvelope(JSON.stringify({ invite: "valid" }), validBinding); const [keyId, iv, tag, encrypted] = valid.split(".");
    const cases = [
      { ciphertext: "malformed" },
      { ciphertext: `${valid}.extra` },
      { ciphertext: `${keyId}.${iv}=.${tag}.${encrypted}` },
      { ciphertext: `${keyId}.${iv}.${tag}.${encrypted}+` },
      { ciphertext: `${keyId}.${randomBytes(11).toString("base64url")}.${tag}.${encrypted}` },
      { ciphertext: `${keyId}.${iv}.${randomBytes(15).toString("base64url")}.${encrypted}` },
      { ciphertext: `${"u".repeat(22)}.${iv}.${tag}.${encrypted}` },
      { ciphertextFor: (binding) => authenticatedEnvelope(JSON.stringify({ invite: "bound-elsewhere" }), { ...binding, nonce: "different-nonce" }) },
      { ciphertextFor: (binding) => authenticatedEnvelope("not-json", binding) },
    ];
    for (const [index, candidate] of cases.entries()) {
      const session = await resolveAnonymousSession(database, null); const before = {};
      for (const tableName of ["sporades_auth_users", "sporades_auth_sessions", "sporades_auth_identities", "sporades_teams", "sporades_team_memberships", "claims"]) before[tableName] = Number((await database.adapter.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()).count);
      const binding = { ...bindings, sessionToken: session.token }; const registrationCiphertext = candidate.ciphertextFor ? candidate.ciphertextFor(binding) : candidate.ciphertext;
      const result = await linkProviderIdentity(database, session, "google", { subject: `corrupt-${index}`, email: `corrupt-${index}@example.com`, emailVerified: true }, { ...bindings, sessionToken: session.token, registrationCiphertext });
      assert.equal(result.error.code, "REGISTRATION_DENIED");
      for (const [tableName, count] of Object.entries(before)) assert.equal(Number((await database.adapter.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()).count), count, tableName);
    }
    assert.equal(policyCalls, 0); assert.equal(finalizerCalls, 0);
  }, capsule);
});

function legacyOAuthRegistrationCiphertext(material, value, row) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(material, "base64url"), iv);
  cipher.setAAD(Buffer.from(`${row.provider}\n${row.sessionToken}\n${row.redirectUri}\n${row.nonce}\n${row.expiresAt}`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `active.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

test("startup migrates a legacy active OAuth admission key before callback without requiring a new OAuth start", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-oauth-registration-legacy-"));
  const file = path.join(dir, "data.db");
  const material = randomBytes(32).toString("base64url");
  const capsule = { name: "legacy-admission", schema: {}, auth: { registration: { admit: ({ admission }) => admission?.invite === "kept" ? { allow: true } : { allow: false }, finalize: () => {} } } };
  const provider = { provider: "google", responseMode: "query", enabled: true, begin: () => ({ url: "https://unused.example" }), complete: async () => ({ subject: "legacy-subject", email: "legacy@example.com", emailVerified: true }) };
  let database;
  try {
    database = await openDevDatabase(file, "", {}, { auth: { providers: { anonymous: true } } });
    const session = await resolveAnonymousSession(database, null);
    const row = { state: "legacy-state", provider: "google", sessionToken: session.token, returnTo: "https://capsule.example.test/after", redirectUri: "https://capsule.example.test/__sporades/auth/google/callback", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: "legacy-nonce", pkceVerifier: "legacy-verifier" };
    await database.adapter.writeSystemMetadata("oauth-registration-key:active", material);
    await database.adapter.insertOAuthState({ ...row, registrationCiphertext: legacyOAuthRegistrationCiphertext(material, { invite: "kept" }, row) });
    database.close();

    database = await openDevDatabase(file, "", {}, { auth: { providers: { anonymous: true } } }, capsule);
    database.__oauthProviderAdapters = { google: provider };
    const active = await database.adapter.readSystemMetadata("oauth-registration-key:active");
    assert.match(active.value, /^[A-Za-z0-9_-]{22}$/);
    assert.equal((await database.adapter.readSystemMetadata(`oauth-registration-key:key:${active.value}`)).value, material);
    const alias = JSON.parse((await database.adapter.readSystemMetadata("oauth-registration-key:alias:active")).value);
    assert.equal(alias.keyId, active.value);
    assert.ok(Date.parse(alias.expiresAt) >= Date.now() + 9 * 60_000);
    const rotated = await rotateOAuthRegistrationKey(database);
    assert.equal(rotated.previousKeyId, active.value);
    assert.ok(Date.parse(rotated.retainUntil) >= Date.parse(alias.expiresAt));
    const response = responseRecorder();
    await routeSporadesAuth(database, { method: "GET", url: "/__sporades/auth/google/callback?state=legacy-state&code=ok", headers: {} }, response);
    assert.equal(response.statusCode, 302, response.body);
  } finally { database?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("malformed or expired legacy aliases and attacker key ids fail closed without metadata writes", async () => {
  const capsule = { name: "alias-admission", schema: {}, auth: { registration: { admit: ({ admission }) => admission?.expected === true ? { allow: true } : { allow: false }, finalize: () => {} } } };
  await withTempDatabase(async (database) => {
    const reconciled = await reconcileOAuthRegistrationKeys(database);
    database.__oauthProviderAdapters = { google: { provider: "google", responseMode: "query", enabled: true, complete: async () => ({ subject: randomBytes(8).toString("hex"), email: "alias@example.com", emailVerified: true }) } };
    const before = () => database.adapter.prepare("SELECT key, value FROM sporades WHERE key LIKE 'oauth-registration-key:%' ORDER BY key").all();
    for (const alias of [
      JSON.stringify({ keyId: reconciled.keyId, expiresAt: "not-a-date" }),
      JSON.stringify({ keyId: reconciled.keyId, expiresAt: new Date(Date.now() - 1).toISOString() }),
      JSON.stringify({ keyId: reconciled.keyId, expiresAt: "275760-09-13T00:00:00.000Z" }),
    ]) {
      await database.adapter.writeSystemMetadata("oauth-registration-key:alias:active", alias);
      const snapshot = before();
      const session = await resolveAnonymousSession(database, null);
      const now = new Date().toISOString();
      const state = randomBytes(8).toString("hex");
      await database.adapter.insertOAuthState({ state, provider: "google", sessionToken: session.token, returnTo: "https://capsule.example.test", redirectUri: "https://capsule.example.test/__sporades/auth/google/callback", createdAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: "n", pkceVerifier: "p", registrationCiphertext: "active.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AA" });
      const response = responseRecorder();
      await routeSporadesAuth(database, { method: "GET", url: `/__sporades/auth/google/callback?state=${state}&code=ok`, headers: {} }, response);
      assert.equal(response.statusCode, 500);
      assert.equal(JSON.parse(response.body).error.code, "REGISTRATION_DENIED");
      assert.deepEqual(before(), snapshot);
    }
    const snapshot = before();
    const session = await resolveAnonymousSession(database, null);
    const row = { provider: "google", sessionToken: session.token, redirectUri: "https://capsule.example.test/__sporades/auth/google/callback", nonce: "n", expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const state = "attacker-key-id";
    await database.adapter.insertOAuthState({ state, ...row, returnTo: "https://capsule.example.test", createdAt: new Date().toISOString(), pkceVerifier: "p", registrationCiphertext: "../../metadata.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AA" });
    const response = responseRecorder();
    await routeSporadesAuth(database, { method: "GET", url: `/__sporades/auth/google/callback?state=${state}&code=ok`, headers: {} }, response);
    assert.equal(response.statusCode, 500);
    assert.equal(JSON.parse(response.body).error.code, "REGISTRATION_DENIED");
    assert.deepEqual(before(), snapshot);
  }, capsule);
});

test("concurrent legacy startup converges on one immutable key and one bounded alias", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-oauth-registration-converge-"));
  const file = path.join(dir, "data.db");
  const material = randomBytes(32).toString("base64url");
  let first; let second; let freshFirst; let freshSecond;
  try {
    first = await openDevDatabase(file, "", {}, { auth: { providers: { anonymous: true } } });
    await first.adapter.writeSystemMetadata("oauth-registration-key:active", material);
    second = await openDevDatabase(file, "", {}, { auth: { providers: { anonymous: true } } });
    const [left, right] = await Promise.all([reconcileOAuthRegistrationKeys(first), reconcileOAuthRegistrationKeys(second)]);
    assert.equal(left.keyId, right.keyId);
    assert.equal((await first.adapter.readSystemMetadata(`oauth-registration-key:key:${left.keyId}`)).value, material);
    const keys = await first.adapter.prepare("SELECT key FROM sporades WHERE key LIKE 'oauth-registration-key:key:%'").all();
    assert.deepEqual(keys.map(({ key }) => key), [`oauth-registration-key:key:${left.keyId}`]);
    const alias = JSON.parse((await first.adapter.readSystemMetadata("oauth-registration-key:alias:active")).value);
    assert.equal(alias.keyId, left.keyId);
    const freshFile = path.join(dir, "fresh.db");
    freshFirst = await openDevDatabase(freshFile, "", {}, { auth: { providers: { anonymous: true } } });
    freshSecond = await openDevDatabase(freshFile, "", {}, { auth: { providers: { anonymous: true } } });
    const [freshLeft, freshRight] = await Promise.all([reconcileOAuthRegistrationKeys(freshFirst), reconcileOAuthRegistrationKeys(freshSecond)]);
    assert.equal(freshLeft.keyId, freshRight.keyId);
    assert.equal((await freshFirst.adapter.prepare("SELECT COUNT(*) AS count FROM sporades WHERE key LIKE 'oauth-registration-key:key:%'").get()).count, 1);
  } finally { first?.close(); second?.close(); freshFirst?.close(); freshSecond?.close(); await rm(dir, { recursive: true, force: true }); }
});

test("rotation preserves outstanding state and retirement removes only safely expired material across restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-oauth-registration-rotate-"));
  const file = path.join(dir, "data.db");
  let database;
  try {
    const capsule = { name: "rotation-admission", schema: {}, auth: { registration: { admit: ({ admission }) => admission?.invite === "rotation" ? { allow: true } : { allow: false }, finalize: () => {} } } };
    database = await openDevDatabase(file, "", {}, { auth: { providers: { anonymous: true } } }, capsule);
    const session = await resolveAnonymousSession(database, null);
    database.__oauthProviderAdapters = { google: { provider: "google", responseMode: "query", enabled: true, begin: ({ state }) => ({ url: `https://google.example/authorize?state=${state}` }), complete: async () => ({ subject: "rotation-subject", email: "rotation@example.com", emailVerified: true }) } };
    const started = await beginOAuthSignIn(database, session, "google", { origin: "https://capsule.example.test", registration: { admission: { invite: "rotation" } } });
    const state = new URL(started.url).searchParams.get("state");
    const stored = await database.adapter.prepare("SELECT * FROM sporades_auth_oauth_states WHERE state = ?").get(state);
    const previousKeyId = stored.registrationCiphertext.split(".")[0];
    const rotatedAt = Date.now();
    const rotated = await rotateOAuthRegistrationKey(database, { now: rotatedAt });
    assert.equal(rotated.previousKeyId, previousKeyId);
    assert.ok(Date.parse(rotated.retainUntil) >= Date.parse(stored.expiresAt));
    assert.ok(await database.adapter.readSystemMetadata(`oauth-registration-key:key:${previousKeyId}`));
    const callback = responseRecorder();
    await routeSporadesAuth(database, { method: "GET", url: `/__sporades/auth/google/callback?state=${state}&code=ok`, headers: {} }, callback);
    assert.equal(callback.statusCode, 302, callback.body);
    const early = await retireOAuthRegistrationKeys(database, { now: rotatedAt + 1 });
    assert.deepEqual(early.retired, []);
    const late = await retireOAuthRegistrationKeys(database, { now: Date.parse(rotated.retainUntil) + 1 });
    assert.deepEqual(late.retired, [previousKeyId]);
    assert.equal(await database.adapter.readSystemMetadata(`oauth-registration-key:key:${previousKeyId}`), null);
    database.close();
    database = await openDevDatabase(file, "", {}, { auth: { providers: { anonymous: true } } }, capsule);
    assert.equal((await reconcileOAuthRegistrationKeys(database)).keyId, rotated.keyId);
  } finally { database?.close(); await rm(dir, { recursive: true, force: true }); }
});

function responseRecorder() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk = "") {
      this.body += chunk;
    },
  };
}

test("OAuth callbacks report provider and state mistakes as client errors", async () => {
  await withTempDatabase(async (database) => {
    const session = await resolveAnonymousSession(database, null);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const insertState = async (state, provider) => {
      await database.adapter.insertOAuthState({
        state,
        sessionToken: session.token,
        returnTo: "http://127.0.0.1:4000",
        provider,
        redirectUri: `http://127.0.0.1:4000/__sporades/auth/${provider}/callback`,
        createdAt: new Date().toISOString(),
        expiresAt,
        nonce: "callback-nonce",
        pkceVerifier: "callback-verifier",
      });
    };

    await insertState("provider-mismatch", "google");
    const mismatch = responseRecorder();
    await routeSporadesAuth(database, {
      method: "GET",
      url: "/__sporades/auth/microsoft/callback?state=provider-mismatch&code=unused",
      headers: {},
    }, mismatch);
    assert.equal(mismatch.statusCode, 400);
    assert.equal(JSON.parse(mismatch.body).error.code, "OAUTH_PROVIDER_MISMATCH");

    // An unsupported path provider is rejected before the state is consumed.
    await insertState("unknown-provider", "nosuch");
    const unknown = responseRecorder();
    await routeSporadesAuth(database, {
      method: "GET",
      url: "/__sporades/auth/nosuch/callback?state=unknown-provider&code=unused",
      headers: {},
    }, unknown);
    assert.equal(unknown.statusCode, 400);
    assert.equal(JSON.parse(unknown.body).error.code, "OAUTH_UNKNOWN_PROVIDER");
    assert.equal(
      database.adapter.prepare("SELECT [state] FROM [sporades_auth_oauth_states] WHERE [state] = ?").get("unknown-provider").state,
      "unknown-provider",
      "unknown provider paths must not consume a valid state",
    );

    // Google is supported but disabled in this test Capsule, so this reaches configuration
    // validation after state consumption and remains a server/configuration failure.
    await insertState("unconfigured-provider", "google");
    const unconfigured = responseRecorder();
    await routeSporadesAuth(database, {
      method: "GET",
      url: "/__sporades/auth/google/callback?state=unconfigured-provider&code=unused",
      headers: {},
    }, unconfigured);
    assert.equal(unconfigured.statusCode, 500);
    assert.equal(JSON.parse(unconfigured.body).error.code, "OAUTH_PROVIDER_NOT_CONFIGURED");
    assert.equal(
      database.adapter.prepare("SELECT [state] FROM [sporades_auth_oauth_states] WHERE [state] = ?").get("unconfigured-provider"),
      undefined,
      "supported provider callbacks still consume their single-use state before configuration validation",
    );
  });
});

function formPostRequest(url, values) {
  const body = new URLSearchParams(values).toString();
  const request = Readable.from([Buffer.from(body)]);
  request.method = "POST";
  request.url = url;
  request.headers = {
    "content-type": "application/x-www-form-urlencoded",
    "content-length": String(Buffer.byteLength(body)),
  };
  return request;
}

function rawFormPostRequest(url, body, contentType = "application/x-www-form-urlencoded") {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const request = Readable.from([bytes]);
  request.method = "POST";
  request.url = url;
  request.headers = {
    "content-type": contentType,
    "content-length": String(bytes.length),
  };
  return request;
}

function providerAdapter(overrides = {}) {
  return {
    provider: "test",
    responseMode: "query",
    enabled: true,
    begin(context) {
      return { url: `https://provider.example/authorize?state=${context.state}` };
    },
    async complete() {
      return { subject: "subject", email: null, emailVerified: null, displayName: "User", picture: null };
    },
    ...overrides,
  };
}

function signedJwt(privateKey, kid, claims) {
  return signedJwtWithHeader(privateKey, { alg: "RS256", typ: "JWT", kid }, claims);
}

function signedJwtWithHeader(privateKey, headerValue, claims) {
  const header = Buffer.from(JSON.stringify(headerValue)).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function configureMicrosoft(database, tenant = "organizations") {
  database.authConfig.providers.microsoft = {
    enabled: true,
    configured: true,
    runtimeAvailable: true,
    clientIdEnv: "MICROSOFT_CLIENT_ID",
    clientSecretEnv: "MICROSOFT_CLIENT_SECRET",
    tenant,
  };
  database.serverEnv.MICROSOFT_CLIENT_ID = "microsoft-client-id";
  database.serverEnv.MICROSOFT_CLIENT_SECRET = "microsoft-client-secret";
}

function microsoftDiscovery(tenant = "organizations") {
  return {
    issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
    authorization_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    token_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    jwks_uri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
  };
}

test("runtime OAuth provider seam completes query and form-post callbacks with provider-bound state", async () => {
  await withTempDatabase(async (database) => {
    const completions = [];
    database.__oauthProviderAdapters = {
      query: {
        provider: "query",
        responseMode: "query",
        enabled: true,
        begin(context) {
          return { url: `https://provider.example/authorize?state=${context.state}` };
        },
        async complete(context) {
          completions.push(context);
          return {
            subject: `subject-${context.code}`,
            email: null,
            emailVerified: null,
            displayName: "Query User",
            picture: null,
          };
        },
      },
      form: {
        provider: "form",
        responseMode: "form_post",
        enabled: true,
        begin(context) {
          return { url: `https://provider.example/authorize?state=${context.state}` };
        },
        async complete(context) {
          completions.push(context);
          return {
            subject: `subject-${context.code}`,
            email: "form@example.com",
            emailVerified: true,
            displayName: "Form User",
            picture: null,
          };
        },
      },
    };

    const querySession = await resolveAnonymousSession(database, null);
    const queryStart = await beginOAuthSignIn(database, querySession, "query", {
      origin: "http://127.0.0.1:4000",
      returnTo: "https://evil.example/steal",
    });
    assert.equal(queryStart.ok, true);
    const queryState = new URL(queryStart.url).searchParams.get("state");
    const stored = database.adapter.prepare("SELECT * FROM sporades_auth_oauth_states WHERE state = ?").get(queryState);
    assert.equal(stored.provider, "query");
    assert.equal(stored.sessionToken, querySession.token);
    assert.equal(stored.returnTo, "http://127.0.0.1:4000");
    assert.equal(stored.redirectUri, "http://127.0.0.1:4000/__sporades/auth/query/callback");
    assert.ok(Date.parse(stored.expiresAt) > Date.parse(stored.createdAt));
    assert.ok(stored.nonce);
    assert.ok(stored.pkceVerifier);

    const queryResponse = responseRecorder();
    assert.equal(
      await routeSporadesAuth(
        database,
        { method: "GET", url: `/__sporades/auth/query/callback?state=${queryState}&code=query-code`, headers: {} },
        queryResponse,
      ),
      true,
    );
    assert.equal(queryResponse.statusCode, 302);
    assert.equal(queryResponse.headers.location, "http://127.0.0.1:4000");
    assert.equal(database.adapter.readAuthSessionWithUser(querySession.token).provider, "query");

    const linkedSession = database.adapter.readAuthSessionWithUser(querySession.token);
    const identitiesBeforeReauthentication = database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_identities").get().count;
    database.reauthenticationPolicy = { "administrator-authority": { maxAgeSeconds: 900 } };
    let authorizationAllowed = true;
    database.authorizeReauthentication = async (_transaction, auth, purpose) => authorizationAllowed && auth.userId === linkedSession.userId && purpose === "administrator-authority";
    const deniedStart = await beginOAuthSignIn(database, querySession, "query", {
      origin: "http://127.0.0.1:4000",
      reauthentication: { purpose: "administrator-authority", userId: linkedSession.userId },
    });
    const deniedState = new URL(deniedStart.url).searchParams.get("state"); authorizationAllowed = false;
    const deniedResponse = responseRecorder();
    assert.equal(await routeSporadesAuth(database, { method: "GET", url: `/__sporades/auth/query/callback?state=${deniedState}&code=query-code`, headers: {} }, deniedResponse), true);
    assert.equal(deniedResponse.statusCode, 500); assert.equal(database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_reauthentication_proofs").get().count, 0);
    assert.equal(database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_oauth_states WHERE state = ?").get(deniedState).count, 0, "denied callback state must be spent");
    authorizationAllowed = true; const staleResponse = responseRecorder(); await routeSporadesAuth(database, { method: "GET", url: `/__sporades/auth/query/callback?state=${deniedState}&code=query-code`, headers: {} }, staleResponse); assert.equal(database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_reauthentication_proofs").get().count, 0, "reauthorizing later must not resurrect a spent callback");
    const reauthenticationStart = await beginOAuthSignIn(database, querySession, "query", {
      origin: "http://127.0.0.1:4000",
      reauthentication: { purpose: "administrator-authority", userId: linkedSession.userId },
    });
    const reauthenticationState = new URL(reauthenticationStart.url).searchParams.get("state");
    const storedReauthentication = database.adapter.prepare("SELECT * FROM sporades_auth_oauth_states WHERE state = ?").get(reauthenticationState);
    assert.equal(storedReauthentication.reauthPurpose, "administrator-authority");
    assert.equal(storedReauthentication.reauthUserId, linkedSession.userId);
    assert.ok(database.clock?.now);
    const reauthenticationResponse = responseRecorder();
    assert.equal(await routeSporadesAuth(
      database,
      { method: "GET", url: `/__sporades/auth/query/callback?state=${reauthenticationState}&code=query-code`, headers: {} },
      reauthenticationResponse,
    ), true);
    assert.equal(reauthenticationResponse.statusCode, 302, reauthenticationResponse.body);
    assert.equal(database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_identities").get().count, identitiesBeforeReauthentication, "reauthentication must not link or replace identities");
    const proof = database.adapter.prepare("SELECT * FROM sporades_auth_reauthentication_proofs WHERE sessionToken = ? AND purpose = ?").get(querySession.token, "administrator-authority");
    assert.equal(proof.userId, linkedSession.userId);
    assert.equal(database.adapter.readAuthSessionWithUser(querySession.token).userId, linkedSession.userId, "reauthentication must not replace the Session User");

    const formSession = await resolveAnonymousSession(database, null);
    const formStart = await beginOAuthSignIn(database, formSession, "form", {
      origin: "http://127.0.0.1:4000",
      returnTo: "http://127.0.0.1:4000/after",
    });
    const formState = new URL(formStart.url).searchParams.get("state");
    const formResponse = responseRecorder();
    assert.equal(
      await routeSporadesAuth(
        database,
        formPostRequest("/__sporades/auth/form/callback", { state: formState, code: "form-code" }),
        formResponse,
      ),
      true,
    );
    assert.equal(formResponse.statusCode, 302, formResponse.body);
    assert.equal(formResponse.headers.location, "http://127.0.0.1:4000/after");
    assert.equal(database.adapter.readAuthSessionWithUser(formSession.token).provider, "form");
    assert.equal(completions.length, 4);
    assert.equal(completions[0].provider, "query");
    assert.ok(completions[0].nonce);
    assert.ok(completions[0].pkceVerifier);
  });
});

test("an all-provider Capsule dispatches each sign-in intent only to its selected adapter", async () => {
  await withTempDatabase(async (database) => {
    const calls = [];
    database.__oauthProviderAdapters = Object.fromEntries(
      ["google", "microsoft", "apple", "facebook"].map((provider) => [
        provider,
        {
          provider,
          responseMode: provider === "apple" ? "form_post" : "query",
          enabled: true,
          begin(context) {
            calls.push({ adapter: provider, requested: context.provider });
            return { url: `https://${provider}.example/authorize?state=${context.state}` };
          },
        },
      ]),
    );

    for (const provider of ["google", "microsoft", "apple", "facebook"]) {
      const session = await resolveAnonymousSession(database, null);
      const started = await beginOAuthSignIn(database, session, provider, {
        origin: "https://capsule.example.test",
        returnTo: "https://capsule.example.test/account",
      });
      assert.equal(started.ok, true);
      assert.equal(new URL(started.url).hostname, `${provider}.example`);
      assert.deepEqual(calls.at(-1), { adapter: provider, requested: provider });
      assert.equal(calls.length, ["google", "microsoft", "apple", "facebook"].indexOf(provider) + 1);
    }
  });
});

test("provider callbacks coexist across same-email, absent-email, switching, returning, and conflict paths", async () => {
  await withTempDatabase(async (database) => {
    const profiles = new Map();
    database.__oauthProviderAdapters = Object.fromEntries(
      ["google", "microsoft", "apple", "facebook"].map((provider) => [
        provider,
        {
          provider,
          responseMode: provider === "apple" ? "form_post" : "query",
          enabled: true,
          begin(context) {
            return { url: `https://${provider}.example/authorize?state=${context.state}` };
          },
          async complete() {
            return profiles.get(provider);
          },
        },
      ]),
    );
    const complete = async (provider, session, profile) => {
      profiles.set(provider, profile);
      const started = await beginOAuthSignIn(database, session, provider, {
        origin: "https://capsule.example.test",
        returnTo: "https://capsule.example.test/account",
      });
      const state = new URL(started.url).searchParams.get("state");
      const response = responseRecorder();
      const request = provider === "apple"
        ? formPostRequest(`/__sporades/auth/${provider}/callback`, { state, code: `${provider}-code` })
        : { method: "GET", url: `/__sporades/auth/${provider}/callback?state=${state}&code=${provider}-code`, headers: {} };
      await routeSporadesAuth(database, request, response);
      return response;
    };

    const googleSession = await resolveAnonymousSession(database, null);
    assert.equal((await complete("google", googleSession, {
      subject: "google-owner",
      email: "same@example.com",
      emailVerified: true,
      displayName: "Google Owner",
    })).statusCode, 302);
    const googleUserId = database.adapter.readAuthSessionWithUser(googleSession.token).userId;

    const independentMicrosoft = await resolveAnonymousSession(database, null);
    assert.equal((await complete("microsoft", independentMicrosoft, {
      subject: "tenant:microsoft-independent",
      email: "same@example.com",
      displayName: "Microsoft Independent",
    })).statusCode, 302);
    const microsoftUserId = database.adapter.readAuthSessionWithUser(independentMicrosoft.token).userId;
    assert.notEqual(microsoftUserId, googleUserId, "mutable email must not bridge users across providers");

    assert.equal((await complete("microsoft", googleSession, {
      subject: "tenant:microsoft-owner",
      email: "same@example.com",
      displayName: "Microsoft Owner",
    })).statusCode, 302);
    assert.equal(database.adapter.readAuthSessionWithUser(googleSession.token).provider, "microsoft");
    assert.equal(database.adapter.readAuthSessionWithUser(googleSession.token).userId, googleUserId);

    assert.equal((await complete("facebook", googleSession, {
      subject: "facebook-owner",
      email: null,
      displayName: "Facebook Owner",
    })).statusCode, 302);
    assert.equal(database.adapter.findAuthIdentityByProviderSubject("facebook", "facebook-owner").email, null);
    assert.equal(database.adapter.readAuthSessionWithUser(googleSession.token).provider, "facebook");

    assert.equal((await complete("apple", googleSession, {
      subject: "apple-owner",
      email: null,
      displayName: null,
    })).statusCode, 302);
    const returningApple = await resolveAnonymousSession(database, null);
    assert.equal((await complete("apple", returningApple, {
      subject: "apple-owner",
      email: "relay@privaterelay.appleid.com",
      displayName: null,
    })).statusCode, 302);
    assert.equal(database.adapter.readAuthSessionWithUser(returningApple.token).userId, googleUserId);
    assert.equal(database.adapter.readAuthSessionWithUser(returningApple.token).provider, "apple");

    const conflict = await complete("apple", independentMicrosoft, {
      subject: "apple-owner",
      email: "same@example.com",
      displayName: "Conflict",
    });
    assert.equal(conflict.statusCode, 500);
    assert.match(conflict.body, /AUTH_IDENTITY_CONFLICT/);
    assert.equal(database.adapter.readAuthSessionWithUser(independentMicrosoft.token).userId, microsoftUserId);
    assert.equal(database.adapter.readAuthSessionWithUser(independentMicrosoft.token).provider, "microsoft");

    const identities = database.adapter.prepare(
      "SELECT provider, subject, userId FROM sporades_auth_identities ORDER BY provider, subject",
    ).all();
    assert.deepEqual(
      identities.filter((identity) => identity.userId === googleUserId).map((identity) => identity.provider),
      ["apple", "facebook", "google", "microsoft"],
    );
    assert.equal(identities.filter((identity) => identity.userId === microsoftUserId).length, 1);
  });
});

test("OAuth state is single-use across mismatch, expiry, cancellation, and completion failure", async () => {
  await withTempDatabase(async (database) => {
    database.__oauthProviderAdapters = {
      alpha: providerAdapter({ provider: "alpha" }),
      beta: providerAdapter({ provider: "beta" }),
      failing: providerAdapter({
        provider: "failing",
        async complete() {
          throw new Error("provider leaked secret should never reach client");
        },
      }),
    };

    const cases = [
      {
        provider: "alpha",
        callbackProvider: "beta",
        query: "code=wrong-provider",
        code: "OAUTH_PROVIDER_MISMATCH",
        status: 400,
      },
      {
        provider: "alpha",
        mutate(database, state) {
          database.adapter.prepare("UPDATE sporades_auth_oauth_states SET expiresAt = ? WHERE state = ?")
            .run(new Date(Date.now() - 1_000).toISOString(), state);
        },
        query: "code=expired",
        code: "OAUTH_STATE_EXPIRED",
        status: 500,
      },
      {
        provider: "alpha",
        query: "error=access_denied&error_description=sensitive-provider-detail",
        code: "OAUTH_PROVIDER_CANCELLED",
        status: 500,
      },
      {
        provider: "failing",
        query: "code=exchange-failure",
        code: "Endpoint handler failed",
        status: 500,
      },
    ];

    for (const testCase of cases) {
      const session = await resolveAnonymousSession(database, null);
      const start = await beginOAuthSignIn(database, session, testCase.provider, {
        origin: "http://127.0.0.1:4000",
        returnTo: "http://127.0.0.1:4000/after",
      });
      const state = new URL(start.url).searchParams.get("state");
      testCase.mutate?.(database, state);
      const response = responseRecorder();
      await routeSporadesAuth(
        database,
        {
          method: "GET",
          url: `/__sporades/auth/${testCase.callbackProvider ?? testCase.provider}/callback?state=${state}&${testCase.query}`,
          headers: {},
        },
        response,
      );
      assert.equal(response.statusCode, testCase.status);
      assert.match(response.body, new RegExp(testCase.code));
      assert.doesNotMatch(response.body, /sensitive-provider-detail|leaked secret/);
      assert.equal(
        database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state),
        undefined,
      );

      const replay = responseRecorder();
      await routeSporadesAuth(
        database,
        {
          method: "GET",
          url: `/__sporades/auth/${testCase.provider}/callback?state=${state}&code=replay`,
          headers: {},
        },
        replay,
      );
      assert.match(replay.body, /OAUTH_INVALID_STATE/);
    }
  });
});

test("OAuth callbacks distinguish provider action requirements without reflecting provider details", async () => {
  await withTempDatabase(async (database) => {
    database.__oauthProviderAdapters = {
      microsoft: providerAdapter({ provider: "microsoft" }),
    };
    const session = await resolveAnonymousSession(database, null);
    const start = await beginOAuthSignIn(database, session, "microsoft", {
      origin: "http://127.0.0.1:4000",
      returnTo: "http://127.0.0.1:4000/after",
    });
    const state = new URL(start.url).searchParams.get("state");
    const response = responseRecorder();
    await routeSporadesAuth(
      database,
      {
        method: "GET",
        url: `/__sporades/auth/microsoft/callback?state=${state}&error=consent_required&error_description=secret-provider-detail`,
        headers: {},
      },
      response,
    );
    assert.equal(response.statusCode, 500);
    assert.match(response.body, /OAUTH_PROVIDER_ACTION_REQUIRED/);
    assert.doesNotMatch(response.body, /secret-provider-detail|consent_required/);
  });
});

test("Google identity tokens require signature, issuer, audience, expiry, nonce, and subject", async () => {
  await withTempDatabase(async (database) => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { privateKey: attackerKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = "test-key";
    const jwk = publicKey.export({ format: "jwk" });
    jwk.kid = kid;
    jwk.alg = "RS256";
    jwk.use = "sig";
    database.authConfig.providers.google.clientIdEnv = "GOOGLE_CLIENT_ID";
    database.serverEnv.GOOGLE_CLIENT_ID = "client-id";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const baseClaims = {
      iss: "https://accounts.google.com",
      aud: "client-id",
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: "expected-nonce",
      sub: "google-subject",
      email: "person@example.com",
      email_verified: true,
      name: "Person",
    };
    try {
      const identity = await verifyGoogleIdentityToken(
        database,
        signedJwt(privateKey, kid, baseClaims),
        "expected-nonce",
      );
      assert.deepEqual(identity, {
        subject: "google-subject",
        email: "person@example.com",
        emailVerified: true,
        displayName: "Person",
        picture: null,
      });

      const invalidCases = [
        signedJwt(attackerKey, kid, baseClaims),
        signedJwt(privateKey, kid, { ...baseClaims, iss: "https://attacker.example" }),
        signedJwt(privateKey, kid, { ...baseClaims, aud: "wrong-client" }),
        signedJwt(privateKey, kid, { ...baseClaims, exp: Math.floor(Date.now() / 1000) - 1 }),
        signedJwt(privateKey, kid, { ...baseClaims, nonce: "wrong-nonce" }),
        signedJwt(privateKey, kid, { ...baseClaims, sub: "" }),
        signedJwt(privateKey, kid, { ...baseClaims, sub: {} }),
        signedJwt(privateKey, kid, { ...baseClaims, sub: ["subject"] }),
        signedJwt(privateKey, kid, { ...baseClaims, sub: 42 }),
        signedJwt(privateKey, kid, { ...baseClaims, sub: null }),
        signedJwt(privateKey, kid, { ...baseClaims, sub: "x".repeat(257) }),
      ];
      for (const token of invalidCases) {
        await assert.rejects(
          verifyGoogleIdentityToken(database, token, "expected-nonce"),
          (error) => error.code?.startsWith("OAUTH_ID_TOKEN_"),
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Microsoft uses discovered OIDC endpoints with PKCE, nonce, exact callback, and identity-only scopes", async () => {
  await withTempDatabase(async (database) => {
    configureMicrosoft(database);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      assert.equal(String(url), "https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration");
      return new Response(JSON.stringify({
        issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
        authorization_endpoint: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
        token_endpoint: "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
        jwks_uri: "https://login.microsoftonline.com/organizations/discovery/v2.0/keys",
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const session = await resolveAnonymousSession(database, null);
      const start = await beginOAuthSignIn(database, session, "microsoft", {
        origin: "https://capsule.example.test",
        returnTo: "https://capsule.example.test/after",
      });
      assert.equal(start.ok, true);
      const authorizationUrl = new URL(start.url);
      assert.equal(authorizationUrl.origin + authorizationUrl.pathname, "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
      assert.equal(authorizationUrl.searchParams.get("client_id"), "microsoft-client-id");
      assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
      assert.equal(authorizationUrl.searchParams.get("response_mode"), "query");
      assert.equal(authorizationUrl.searchParams.get("scope"), "openid profile email");
      assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "https://capsule.example.test/__sporades/auth/microsoft/callback");
      assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
      assert.ok(authorizationUrl.searchParams.get("code_challenge"));
      assert.ok(authorizationUrl.searchParams.get("state"));
      assert.ok(authorizationUrl.searchParams.get("nonce"));
      assert.equal(authorizationUrl.searchParams.has("offline_access"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Microsoft discovery fetches are deadline-bound, size-bound, no-redirect, and safely classified", async () => {
  await withTempDatabase(async (database) => {
    configureMicrosoft(database);
    database.__microsoftOidcTimeoutMs = 5;
    const originalFetch = globalThis.fetch;
    try {
      let sawRedirectError = false;
      globalThis.fetch = async (_url, options) => {
        sawRedirectError = options.redirect === "error";
        return await new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new DOMException("secret stall", "AbortError")), { once: true });
        });
      };
      await assert.rejects(
        discoverMicrosoftOpenIdConfiguration(database, "organizations"),
        (error) => error.code === "OAUTH_DISCOVERY_UNAVAILABLE" && !/secret stall/i.test(error.message),
      );
      assert.equal(sawRedirectError, true);
      globalThis.fetch = async (_url, options) => {
        assert.equal(options.redirect, "error");
        throw new TypeError("redirect blocked with sensitive location");
      };
      await assert.rejects(
        discoverMicrosoftOpenIdConfiguration(database, "organizations"),
        (error) => error.code === "OAUTH_DISCOVERY_UNAVAILABLE" && !/sensitive location/i.test(error.message),
      );

      const cases = [
        {
          response: new Response("x".repeat(70 * 1024), { status: 200 }),
          code: "OAUTH_DISCOVERY_INVALID",
        },
        {
          response: new Response("{broken-json", { status: 200 }),
          code: "OAUTH_DISCOVERY_INVALID",
        },
        {
          response: new Response("secret upstream body", { status: 503 }),
          code: "OAUTH_DISCOVERY_UNAVAILABLE",
        },
      ];
      for (const testCase of cases) {
        globalThis.fetch = async (_url, options) => {
          assert.equal(options.redirect, "error");
          assert.ok(options.signal);
          return testCase.response;
        };
        await assert.rejects(
          discoverMicrosoftOpenIdConfiguration(database, "organizations"),
          (error) => error.code === testCase.code &&
            !/secret upstream body|broken-json|x{20}/i.test(`${error.message} ${error.hint}`),
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Microsoft response-body deadlines close a real stalled loopback response without leaking its partial body", async () => {
  const script = `
    import { createServer } from "node:http";
    import { fetchMicrosoftOidcJson as fetchJson } from "./dist/server-runtime-source.js";
    let closedResolve;
    const closed = new Promise((resolve) => { closedResolve = resolve; });
    const server = createServer((request, response) => {
      request.on("close", closedResolve);
      response.on("close", closedResolve);
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"upstreamSecret":"partial');
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const startedAt = Date.now();
    let result;
    try {
      const address = server.address();
      await fetchJson(
        { __microsoftOidcTimeoutMs: 40 },
        "http://127.0.0.1:" + address.port + "/stalled",
        {},
        {
          maxBytes: 65536,
          unavailableCode: "OAUTH_TEST_UNAVAILABLE",
          unavailableMessage: "OIDC test response was unavailable.",
          unavailableHint: "Retry the test request.",
          invalidCode: "OAUTH_TEST_INVALID",
          invalidMessage: "OIDC test response was invalid.",
          invalidHint: "Retry the test request.",
        },
      );
      result = { unexpectedSuccess: true };
    } catch (error) {
      const deadlineElapsedMs = Date.now() - startedAt;
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))]);
      result = {
        code: error.code,
        deadlineElapsedMs,
        cleanupElapsedMs: Date.now() - startedAt,
        leaked: /upstreamSecret|partial/i.test(String(error.message) + " " + String(error.hint)),
        connections: server._connections,
      };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    process.stdout.write(JSON.stringify(result));
  `;
  const { stdout, stderr } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    timeout: 2_000,
  });
  assert.equal(stderr, "");
  const result = JSON.parse(stdout);
  assert.equal(result.code, "OAUTH_TEST_UNAVAILABLE");
  assert.equal(result.leaked, false);
  assert.ok(result.deadlineElapsedMs < 500, "stalled body should be bounded by the configured deadline");
  assert.ok(result.cleanupElapsedMs < 1_000, "stalled connection cleanup should remain bounded");
  assert.equal(result.connections, 0, "aborting the reader should close the stalled loopback connection");
});

test("Microsoft oversized response cleanup cancels and releases the body reader", async () => {
  await withTempDatabase(async (database) => {
    let cancelled = 0;
    let released = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      headers: { get: () => null },
      body: {
        getReader() {
          let read = false;
          return {
            async read() {
              if (read) return { done: true };
              read = true;
              return { done: false, value: new Uint8Array(65) };
            },
            async cancel() { cancelled += 1; },
            releaseLock() { released += 1; },
          };
        },
      },
    });
    try {
      await assert.rejects(
        fetchMicrosoftOidcJson(database, "https://example.test/oversized", {}, {
          maxBytes: 64,
          unavailableCode: "OAUTH_TEST_UNAVAILABLE",
          unavailableMessage: "unavailable",
          unavailableHint: "retry",
          invalidCode: "OAUTH_TEST_INVALID",
          invalidMessage: "invalid",
          invalidHint: "retry",
        }),
        (error) => error.code === "OAUTH_TEST_INVALID",
      );
      assert.equal(cancelled, 1);
      assert.equal(released, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Microsoft token and JWKS fetches bound stalls, redirects, body size, malformed JSON, and HTTP failures", async () => {
  await withTempDatabase(async (database) => {
    configureMicrosoft(database);
    database.__microsoftOidcTimeoutMs = 5;
    const discovery = microsoftDiscovery();
    const context = {
      code: "server-code",
      redirectUri: "https://capsule.example/__sporades/auth/microsoft/callback",
      pkceVerifier: "verifier",
      nonce: "nonce",
    };
    const originalFetch = globalThis.fetch;
    try {
      for (const response of [
        new Response("x".repeat(80 * 1024), { status: 200 }),
        new Response("{broken-json", { status: 200 }),
        new Response("null", { status: 200 }),
        new Response("[]", { status: 200 }),
        new Response("secret invalid client", { status: 401 }),
      ]) {
        globalThis.fetch = async (url, options) => {
          assert.equal(options.redirect, "error");
          assert.ok(options.signal);
          if (String(url).includes("openid-configuration")) {
            return new Response(JSON.stringify(discovery));
          }
          assert.doesNotMatch(String(options.body), /undefined/);
          return response;
        };
        await assert.rejects(
          completeMicrosoftOAuth(database, context),
          (error) => error.code === "OAUTH_EXCHANGE_FAILED" &&
            !/secret invalid client|broken-json|x{20}|microsoft-secret/i.test(`${error.message} ${error.hint}`),
        );
      }

      globalThis.fetch = async (url, options) => {
        assert.equal(options.redirect, "error");
        if (String(url).includes("openid-configuration")) {
          return new Response(JSON.stringify(discovery));
        }
        return await new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new DOMException("token secret stall", "AbortError")), { once: true });
        });
      };
      await assert.rejects(
        completeMicrosoftOAuth(database, context),
        (error) => error.code === "OAUTH_EXCHANGE_FAILED" && !/secret stall/i.test(error.message),
      );
      globalThis.fetch = async (url, options) => {
        assert.equal(options.redirect, "error");
        if (String(url).includes("openid-configuration")) {
          return new Response(JSON.stringify(discovery));
        }
        throw new TypeError("redirect blocked with token secret");
      };
      await assert.rejects(
        completeMicrosoftOAuth(database, context),
        (error) => error.code === "OAUTH_EXCHANGE_FAILED" && !/token secret/i.test(error.message),
      );

      const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const token = signedJwt(privateKey, "missing-key", {
        iss: "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0",
        aud: "microsoft-client-id",
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: "nonce",
        tid: "11111111-2222-3333-4444-555555555555",
        sub: "subject",
      });
      for (const response of [
        new Response("x".repeat(300 * 1024), { status: 200 }),
        new Response("{broken-json", { status: 200 }),
        new Response("null", { status: 200 }),
        new Response(JSON.stringify({ keys: null }), { status: 200 }),
        new Response("secret keys failure", { status: 502 }),
      ]) {
        globalThis.fetch = async (_url, options) => {
          assert.equal(options.redirect, "error");
          assert.ok(options.signal);
          return response;
        };
        await assert.rejects(
          verifyMicrosoftIdentityToken(database, token, "nonce", discovery),
          (error) => ["OAUTH_ID_TOKEN_KEYS_INVALID", "OAUTH_ID_TOKEN_KEYS_UNAVAILABLE"].includes(error.code) &&
            !/secret keys failure|broken-json|x{20}/i.test(`${error.message} ${error.hint}`),
        );
      }
      globalThis.fetch = async (_url, options) => {
        assert.equal(options.redirect, "error");
        throw new TypeError("redirect blocked with key location");
      };
      await assert.rejects(
        verifyMicrosoftIdentityToken(database, token, "nonce", discovery),
        (error) => error.code === "OAUTH_ID_TOKEN_KEYS_UNAVAILABLE" && !/key location/i.test(error.message),
      );
      globalThis.fetch = async (_url, options) => await new Promise((_resolve, reject) => {
        assert.equal(options.redirect, "error");
        options.signal.addEventListener("abort", () => reject(new DOMException("key secret stall", "AbortError")), { once: true });
      });
      await assert.rejects(
        verifyMicrosoftIdentityToken(database, token, "nonce", discovery),
        (error) => error.code === "OAUTH_ID_TOKEN_KEYS_UNAVAILABLE" && !/secret stall/i.test(error.message),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Microsoft discovery and JWKS caches are bounded by TTL and refresh an unknown kid exactly once", async () => {
  await withTempDatabase(async (database) => {
    configureMicrosoft(database);
    database.__microsoftOidcNowMs = 1_000;
    const discovery = microsoftDiscovery();
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rotatedJwk = publicKey.export({ format: "jwk" });
    Object.assign(rotatedJwk, {
      kid: "rotated-key",
      alg: "RS256",
      use: "sig",
      issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
    });
    const originalFetch = globalThis.fetch;
    let discoveryFetches = 0;
    let jwksFetches = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(options.redirect, "error");
      if (String(url).includes("openid-configuration")) {
        discoveryFetches += 1;
        return new Response(JSON.stringify(discovery));
      }
      jwksFetches += 1;
      return new Response(JSON.stringify({
        keys: jwksFetches === 1
          ? [{ ...rotatedJwk, kid: "old-key" }]
          : [rotatedJwk],
      }));
    };
    const tenantId = "11111111-2222-3333-4444-555555555555";
    const claims = {
      iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      aud: "microsoft-client-id",
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: "nonce",
      tid: tenantId,
      sub: "subject",
    };
    try {
      assert.deepEqual(
        await discoverMicrosoftOpenIdConfiguration(database, "organizations"),
        await discoverMicrosoftOpenIdConfiguration(database, "organizations"),
      );
      assert.equal(discoveryFetches, 1);
      database.__microsoftOidcNowMs += 5 * 60 * 1000 + 1;
      await discoverMicrosoftOpenIdConfiguration(database, "organizations");
      assert.equal(discoveryFetches, 2);

      const token = signedJwt(privateKey, "rotated-key", claims);
      assert.equal((await verifyMicrosoftIdentityToken(database, token, "nonce", discovery)).subject, `${tenantId}:subject`);
      assert.equal(jwksFetches, 2);
      await verifyMicrosoftIdentityToken(database, token, "nonce", discovery);
      assert.equal(jwksFetches, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Microsoft coalesces concurrent discovery and JWKS rollover loads and keeps the newest generation", async () => {
  await withTempDatabase(async (database) => {
    configureMicrosoft(database);
    database.__microsoftOidcNowMs = 1_000;
    const discovery = microsoftDiscovery();
    const tenantId = "11111111-2222-3333-4444-555555555555";
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rotatedJwk = {
      ...publicKey.export({ format: "jwk" }),
      kid: "rotated-key",
      alg: "RS256",
      use: "sig",
      issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
    };
    const token = signedJwt(privateKey, rotatedJwk.kid, {
      iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      aud: "microsoft-client-id",
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: "nonce",
      tid: tenantId,
      sub: "subject",
    });
    const originalFetch = globalThis.fetch;
    let discoveryFetches = 0;
    let jwksFetches = 0;
    let releaseDiscovery;
    let releaseInitialKeys;
    let releaseRotatedKeys;
    const discoveryGate = new Promise((resolve) => { releaseDiscovery = resolve; });
    const initialKeysGate = new Promise((resolve) => { releaseInitialKeys = resolve; });
    const rotatedKeysGate = new Promise((resolve) => { releaseRotatedKeys = resolve; });
    globalThis.fetch = async (url) => {
      if (String(url).includes("openid-configuration")) {
        discoveryFetches += 1;
        await discoveryGate;
        return new Response(JSON.stringify(discovery));
      }
      jwksFetches += 1;
      if (jwksFetches === 1) {
        await initialKeysGate;
        return new Response(JSON.stringify({ keys: [{ ...rotatedJwk, kid: "old-key" }] }));
      }
      if (jwksFetches === 2) {
        await rotatedKeysGate;
        return new Response(JSON.stringify({ keys: [rotatedJwk] }));
      }
      throw new Error(`unexpected JWKS fetch ${jwksFetches}`);
    };
    try {
      const discoveries = Array.from({ length: 8 }, () =>
        discoverMicrosoftOpenIdConfiguration(database, "organizations"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(discoveryFetches, 1);
      releaseDiscovery();
      assert.equal((await Promise.all(discoveries)).length, 8);

      const callbacks = Array.from({ length: 8 }, () =>
        verifyMicrosoftIdentityToken(database, token, "nonce", discovery));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(jwksFetches, 1);
      releaseInitialKeys();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(jwksFetches, 2);
      releaseRotatedKeys();
      const identities = await Promise.all(callbacks);
      assert.deepEqual(
        identities.map((identity) => identity.subject),
        Array(8).fill(`${tenantId}:subject`),
      );
      assert.equal(jwksFetches, 2);

      await verifyMicrosoftIdentityToken(database, token, "nonce", discovery);
      assert.equal(jwksFetches, 2, "the older key response must not overwrite the rotated generation");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Microsoft retries one missing kid after a short cooldown without amplifying concurrent callbacks", async () => {
  await withTempDatabase(async (database) => {
    configureMicrosoft(database);
    database.__microsoftOidcNowMs = 1_000;
    const discovery = microsoftDiscovery();
    const tenantId = "11111111-2222-3333-4444-555555555555";
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const propagatedJwk = {
      ...publicKey.export({ format: "jwk" }),
      kid: "propagated-key",
      alg: "RS256",
      use: "sig",
      issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
    };
    const token = signedJwt(privateKey, propagatedJwk.kid, {
      iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      aud: "microsoft-client-id",
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: "nonce",
      tid: tenantId,
      sub: "subject",
    });
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    let releaseInitial;
    let releaseRollover;
    const initialGate = new Promise((resolve) => { releaseInitial = resolve; });
    const rolloverGate = new Promise((resolve) => { releaseRollover = resolve; });
    globalThis.fetch = async () => {
      fetches += 1;
      if (fetches === 1) await initialGate;
      if (fetches === 2) await rolloverGate;
      return new Response(JSON.stringify({
        keys: fetches >= 3 ? [propagatedJwk] : [{ ...propagatedJwk, kid: "old-key" }],
      }));
    };
    try {
      const callbacks = Array.from({ length: 8 }, () =>
        verifyMicrosoftIdentityToken(database, token, "nonce", discovery));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fetches, 1);
      releaseInitial();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fetches, 2);
      releaseRollover();
      const missing = await Promise.allSettled(callbacks);
      assert.equal(missing.every((result) =>
        result.status === "rejected" && result.reason.code === "OAUTH_ID_TOKEN_INVALID"), true);
      assert.equal(fetches, 2);

      await assert.rejects(
        verifyMicrosoftIdentityToken(database, token, "nonce", discovery),
        (error) => error.code === "OAUTH_ID_TOKEN_INVALID",
      );
      assert.equal(fetches, 2, "the per-kid cooldown should suppress immediate repeat refreshes");

      database.__microsoftOidcNowMs += 10_001;
      assert.equal(
        (await verifyMicrosoftIdentityToken(database, token, "nonce", discovery)).subject,
        `${tenantId}:subject`,
      );
      assert.equal(fetches, 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Microsoft bounds per-kid JWKS rollover cooldown state", async () => {
  await withTempDatabase(async (database) => {
    configureMicrosoft(database);
    database.__microsoftOidcNowMs = 1_000;
    const discovery = microsoftDiscovery();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ keys: [] }));
    try {
      await loadMicrosoftJwks(database, discovery, false);
      const state = [...database.__microsoftOidcCache.jwks.values()][0];
      for (let index = 0; index < 80; index += 1) {
        await loadMicrosoftJwks(database, discovery, true, state.generation, `missing-key-${index}`);
      }
      assert.equal(state.missingKidCooldowns.size, 64);
      assert.equal(state.missingKidCooldowns.has("missing-key-0"), false);
      assert.equal(state.missingKidCooldowns.has("missing-key-79"), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Microsoft discovery and JWKS cache maps prune expired state and cap distinct full keys without evicting inflight work", async () => {
  await withTempDatabase(async (database) => {
    configureMicrosoft(database);
    database.__microsoftOidcNowMs = 1_000;
    const originalFetch = globalThis.fetch;
    const originalDiscoveryOverride = process.env.SPORADES_MICROSOFT_DISCOVERY_URL;
    const originalTestEndpoints = process.env.SPORADES_OAUTH_TEST_ENDPOINTS;
    let heldDiscoveryRelease;
    let heldJwksRelease;
    const heldDiscoveryGate = new Promise((resolve) => { heldDiscoveryRelease = resolve; });
    const heldJwksGate = new Promise((resolve) => { heldJwksRelease = resolve; });
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value.includes("held-discovery")) await heldDiscoveryGate;
      if (value.includes("held-jwks")) await heldJwksGate;
      if (value.includes("openid-configuration") || value.includes("held-discovery") || value.includes("ordinary-discovery")) {
        if (value.startsWith("http://127.0.0.1/")) {
          return new Response(JSON.stringify({
            ...microsoftDiscovery(),
            authorization_endpoint: "http://127.0.0.1/authorize",
            token_endpoint: "http://127.0.0.1/token",
            jwks_uri: "http://127.0.0.1/keys",
          }));
        }
        return new Response(JSON.stringify(microsoftDiscovery()));
      }
      return new Response(JSON.stringify({ keys: [], marker: value }));
    };
    try {
      process.env.SPORADES_OAUTH_TEST_ENDPOINTS = "1";
      for (let index = 0; index < 40; index += 1) {
        database.authConfig.providers.microsoft.clientIdEnv = `MICROSOFT_CLIENT_ID_${index}`;
        await discoverMicrosoftOpenIdConfiguration(database, "organizations");
      }
      assert.equal(database.__microsoftOidcCache.discovery.size, 32);

      database.__microsoftOidcNowMs += 5 * 60 * 1000 + 1;
      database.authConfig.providers.microsoft.clientIdEnv = "MICROSOFT_CLIENT_ID_AFTER_EXPIRY";
      await discoverMicrosoftOpenIdConfiguration(database, "organizations");
      assert.equal(database.__microsoftOidcCache.discovery.size, 1);

      for (let index = 0; index < 40; index += 1) {
        const keyedDiscovery = {
          ...microsoftDiscovery(),
          issuer: `https://login.microsoftonline.com/${String(index).padStart(2, "0")}/v2.0`,
          jwks_uri: `https://keys.example.test/${index}`,
        };
        const loaded = await loadMicrosoftJwks(database, keyedDiscovery, false);
        assert.equal(loaded.marker, keyedDiscovery.jwks_uri);
      }
      assert.equal(database.__microsoftOidcCache.jwks.size, 32);

      database.__microsoftOidcNowMs += 5 * 60 * 1000 + 1;
      const postExpiryDiscovery = {
        ...microsoftDiscovery(),
        issuer: "https://login.microsoftonline.com/post-expiry/v2.0",
        jwks_uri: "https://keys.example.test/post-expiry",
      };
      await loadMicrosoftJwks(database, postExpiryDiscovery, false);
      assert.equal(database.__microsoftOidcCache.jwks.size, 1);

      process.env.SPORADES_MICROSOFT_DISCOVERY_URL = "http://127.0.0.1/held-discovery";
      database.authConfig.providers.microsoft.clientIdEnv = "MICROSOFT_CLIENT_ID_HELD";
      const heldDiscovery = discoverMicrosoftOpenIdConfiguration(database, "organizations");
      const heldJwksDescriptor = {
        ...microsoftDiscovery(),
        issuer: "https://login.microsoftonline.com/held/v2.0",
        jwks_uri: "https://keys.example.test/held-jwks",
      };
      const heldJwks = loadMicrosoftJwks(database, heldJwksDescriptor, false);
      await new Promise((resolve) => setImmediate(resolve));

      process.env.SPORADES_MICROSOFT_DISCOVERY_URL = "http://127.0.0.1/ordinary-discovery";
      for (let index = 0; index < 40; index += 1) {
        database.authConfig.providers.microsoft.clientIdEnv = `MICROSOFT_CLIENT_ID_CHURN_${index}`;
        await discoverMicrosoftOpenIdConfiguration(database, "organizations");
        await loadMicrosoftJwks(database, {
          ...microsoftDiscovery(),
          issuer: `https://login.microsoftonline.com/churn-${index}/v2.0`,
          jwks_uri: `https://keys.example.test/churn-${index}`,
        }, false);
      }
      assert.ok([...database.__microsoftOidcCache.discovery.values()].some((state) => state.inflight));
      assert.ok([...database.__microsoftOidcCache.jwks.values()].some((state) => state.inflight));
      assert.ok(database.__microsoftOidcCache.discovery.size <= 32);
      assert.ok(database.__microsoftOidcCache.jwks.size <= 32);
      heldDiscoveryRelease();
      heldJwksRelease();
      await heldDiscovery;
      await heldJwks;
    } finally {
      if (originalDiscoveryOverride === undefined) delete process.env.SPORADES_MICROSOFT_DISCOVERY_URL;
      else process.env.SPORADES_MICROSOFT_DISCOVERY_URL = originalDiscoveryOverride;
      if (originalTestEndpoints === undefined) delete process.env.SPORADES_OAUTH_TEST_ENDPOINTS;
      else process.env.SPORADES_OAUTH_TEST_ENDPOINTS = originalTestEndpoints;
      globalThis.fetch = originalFetch;
    }
  });
});

test("Microsoft cache saturation fails closed without launching untracked discovery or JWKS fetches", async () => {
  await withTempDatabase(async (database) => {
    configureMicrosoft(database);
    const discoveryControls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => await new Promise((resolve, reject) => {
      discoveryControls.push({ resolve, reject });
    });
    try {
      const held = [];
      for (let index = 0; index < 32; index += 1) {
        database.authConfig.providers.microsoft.clientIdEnv = `MICROSOFT_HELD_CLIENT_${index}`;
        held.push(discoverMicrosoftOpenIdConfiguration(database, "organizations")
          .then((value) => ({ value }), (error) => ({ error })));
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(discoveryControls.length, 32);
      assert.equal(database.__microsoftOidcCache.discovery.size, 32);

      database.authConfig.providers.microsoft.clientIdEnv = "MICROSOFT_CAPACITY|CLIENT";
      const overflowCalls = Array.from({ length: 8 }, () =>
        discoverMicrosoftOpenIdConfiguration(database, "organizations")
          .then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason })));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(discoveryControls.length, 32);
      assert.equal(database.__microsoftOidcCache.discovery.size, 32);
      const overflow = await Promise.all(overflowCalls);
      assert.equal(overflow.every((result) =>
        result.status === "rejected" &&
        result.reason.code === "OAUTH_DISCOVERY_UNAVAILABLE" &&
        !/CAPACITY|CLIENT|openid-configuration/i.test(`${result.reason.message} ${result.reason.hint}`)), true);

      discoveryControls[0].reject(new TypeError("temporary discovery failure"));
      assert.equal((await held[0]).error.code, "OAUTH_DISCOVERY_UNAVAILABLE");
      const retry = Array.from({ length: 8 }, () =>
        discoverMicrosoftOpenIdConfiguration(database, "organizations"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(discoveryControls.length, 33);
      discoveryControls[32].resolve(new Response(JSON.stringify(microsoftDiscovery())));
      assert.equal((await Promise.all(retry)).length, 8);
      for (let index = 1; index < 32; index += 1) {
        discoveryControls[index].resolve(new Response(JSON.stringify(microsoftDiscovery())));
      }
      await Promise.all(held.slice(1));
      assert.equal(database.__microsoftOidcCache.discovery.size, 32);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await withTempDatabase(async (database) => {
    configureMicrosoft(database);
    const jwksControls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => await new Promise((resolve, reject) => {
      jwksControls.push({ resolve, reject });
    });
    try {
      const held = Array.from({ length: 32 }, (_, index) =>
        loadMicrosoftJwks(database, {
          ...microsoftDiscovery(),
          issuer: `https://login.microsoftonline.com/held-${index}/v2.0`,
          jwks_uri: `https://keys.example.test/held-${index}`,
        }, false).then((value) => ({ value }), (error) => ({ error })));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(jwksControls.length, 32);
      assert.equal(database.__microsoftOidcCache.jwks.size, 32);

      const overflowDiscovery = {
        ...microsoftDiscovery(),
        issuer: "https://login.microsoftonline.com/CAPACITY|ISSUER/v2.0",
        jwks_uri: "https://keys.example.test/CAPACITY|KEYS",
      };
      const overflowCalls = Array.from({ length: 8 }, () =>
        loadMicrosoftJwks(database, overflowDiscovery, false)
          .then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason })));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(jwksControls.length, 32);
      assert.equal(database.__microsoftOidcCache.jwks.size, 32);
      const overflow = await Promise.all(overflowCalls);
      assert.equal(overflow.every((result) =>
        result.status === "rejected" &&
        result.reason.code === "OAUTH_ID_TOKEN_KEYS_UNAVAILABLE" &&
        !/CAPACITY|ISSUER|keys\.example/i.test(`${result.reason.message} ${result.reason.hint}`)), true);

      jwksControls[0].reject(new TypeError("temporary JWKS failure"));
      assert.equal((await held[0]).error.code, "OAUTH_ID_TOKEN_KEYS_UNAVAILABLE");
      const retry = Array.from({ length: 8 }, () => loadMicrosoftJwks(database, overflowDiscovery, false));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(jwksControls.length, 33);
      jwksControls[32].resolve(new Response(JSON.stringify({ keys: [], marker: "overflow" })));
      assert.equal((await Promise.all(retry)).every((value) => value.marker === "overflow"), true);
      for (let index = 1; index < 32; index += 1) {
        jwksControls[index].resolve(new Response(JSON.stringify({ keys: [], marker: `held-${index}` })));
      }
      await Promise.all(held.slice(1));
      assert.equal(database.__microsoftOidcCache.jwks.size, 32);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Microsoft cache tuple encoding separates delimiter-bearing discovery, JWKS, and missing-kid components", async () => {
  await withTempDatabase(async (database) => {
    configureMicrosoft(database);
    const originalFetch = globalThis.fetch;
    const originalDiscoveryOverride = process.env.SPORADES_MICROSOFT_DISCOVERY_URL;
    const originalTestEndpoints = process.env.SPORADES_OAUTH_TEST_ENDPOINTS;
    let fetches = 0;
    globalThis.fetch = async (url) => {
      fetches += 1;
      const value = String(url);
      if (value.includes("discovery")) {
        return new Response(JSON.stringify({
          ...microsoftDiscovery(),
          authorization_endpoint: "http://127.0.0.1/authorize",
          token_endpoint: "http://127.0.0.1/token",
          jwks_uri: "http://127.0.0.1/keys",
          marker: value,
        }));
      }
      return new Response(JSON.stringify({ keys: [], marker: value }));
    };
    try {
      process.env.SPORADES_OAUTH_TEST_ENDPOINTS = "1";
      process.env.SPORADES_MICROSOFT_DISCOVERY_URL = "http://127.0.0.1/discovery|segment";
      database.authConfig.providers.microsoft.clientIdEnv = "CLIENT";
      const discoveryA = await discoverMicrosoftOpenIdConfiguration(database, "organizations");
      process.env.SPORADES_MICROSOFT_DISCOVERY_URL = "http://127.0.0.1/discovery";
      database.authConfig.providers.microsoft.clientIdEnv = "segment|CLIENT";
      const discoveryB = await discoverMicrosoftOpenIdConfiguration(database, "organizations");
      assert.notEqual(discoveryA.marker, discoveryB.marker);
      assert.equal(database.__microsoftOidcCache.discovery.size, 2);

      database.authConfig.providers.microsoft.clientIdEnv = "CLIENT";
      const descriptorA = {
        ...microsoftDiscovery(),
        issuer: "https://issuer.example/a|https://keys.example/b",
        jwks_uri: "https://keys.example/c",
      };
      const descriptorB = {
        ...microsoftDiscovery(),
        issuer: "https://issuer.example/a",
        jwks_uri: "https://keys.example/b|https://keys.example/c",
      };
      const jwksA = await loadMicrosoftJwks(database, descriptorA, false);
      const jwksB = await loadMicrosoftJwks(database, descriptorB, false);
      assert.equal(jwksA.marker, descriptorA.jwks_uri);
      assert.equal(jwksB.marker, descriptorB.jwks_uri);
      assert.equal(database.__microsoftOidcCache.jwks.size, 2);

      const states = [...database.__microsoftOidcCache.jwks.values()];
      const stateA = states.find((state) => state.value.marker === descriptorA.jwks_uri);
      const stateB = states.find((state) => state.value.marker === descriptorB.jwks_uri);
      await loadMicrosoftJwks(database, descriptorA, true, stateA.generation, "nested|missing-a");
      await loadMicrosoftJwks(database, descriptorB, true, stateB.generation, "nested|missing-b");
      assert.equal(stateA.missingKidCooldowns.has("nested|missing-a"), true);
      assert.equal(stateA.missingKidCooldowns.has("nested|missing-b"), false);
      assert.equal(stateB.missingKidCooldowns.has("nested|missing-b"), true);
      assert.equal(stateB.missingKidCooldowns.has("nested|missing-a"), false);
    } finally {
      if (originalDiscoveryOverride === undefined) delete process.env.SPORADES_MICROSOFT_DISCOVERY_URL;
      else process.env.SPORADES_MICROSOFT_DISCOVERY_URL = originalDiscoveryOverride;
      if (originalTestEndpoints === undefined) delete process.env.SPORADES_OAUTH_TEST_ENDPOINTS;
      else process.env.SPORADES_OAUTH_TEST_ENDPOINTS = originalTestEndpoints;
      globalThis.fetch = originalFetch;
    }
  });
});

test("Microsoft clears rejected shared JWKS loads so a later callback can retry", async () => {
  await withTempDatabase(async (database) => {
    configureMicrosoft(database);
    const discovery = microsoftDiscovery();
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    let releaseFailure;
    const failureGate = new Promise((resolve) => { releaseFailure = resolve; });
    globalThis.fetch = async () => {
      fetches += 1;
      if (fetches === 1) {
        await failureGate;
        throw new TypeError("temporary secret network failure");
      }
      return new Response(JSON.stringify({ keys: [] }));
    };
    try {
      const loads = Array.from({ length: 6 }, () => loadMicrosoftJwks(database, discovery, false));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fetches, 1);
      releaseFailure();
      const failures = await Promise.allSettled(loads);
      assert.equal(failures.every((result) =>
        result.status === "rejected" &&
        result.reason.code === "OAUTH_ID_TOKEN_KEYS_UNAVAILABLE" &&
        !/secret network/i.test(result.reason.message)), true);
      assert.deepEqual(await loadMicrosoftJwks(database, discovery, false), { keys: [] });
      assert.equal(fetches, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Microsoft rejects hostile JWT and selected JWK shapes with deterministic bounded errors", async () => {
  await withTempDatabase(async (database) => {
    configureMicrosoft(database);
    const discovery = microsoftDiscovery();
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = "strict-key";
    const jwk = publicKey.export({ format: "jwk" });
    Object.assign(jwk, {
      kid,
      alg: "RS256",
      use: "sig",
      issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
    });
    const tenantId = "11111111-2222-3333-4444-555555555555";
    const claims = {
      iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      aud: "microsoft-client-id",
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: "nonce",
      tid: tenantId,
      sub: "subject",
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ keys: [null, 42, "string", [], jwk] }));
    try {
      assert.equal(
        (await verifyMicrosoftIdentityToken(database, signedJwt(privateKey, kid, claims), "nonce", discovery)).subject,
        `${tenantId}:subject`,
      );
      const hostileTokens = [
        ...[null, [], 42, "claims"].map((payload) => signedJwt(privateKey, kid, payload)),
        ...[null, [], 42, "header"].map((header) => signedJwtWithHeader(privateKey, header, claims)),
        signedJwtWithHeader(privateKey, { alg: "RS256", kid: "x".repeat(300) }, claims),
        signedJwt(privateKey, kid, { ...claims, aud: { client: "microsoft-client-id" } }),
        signedJwt(privateKey, kid, { ...claims, aud: ["microsoft-client-id", 42] }),
        signedJwt(privateKey, kid, { ...claims, exp: "soon" }),
        signedJwt(privateKey, kid, { ...claims, exp: 1.5 }),
        signedJwt(privateKey, kid, { ...claims, exp: -1 }),
        signedJwt(privateKey, kid, { ...claims, nbf: "later" }),
        signedJwt(privateKey, kid, { ...claims, nbf: 1.5 }),
        signedJwt(privateKey, kid, { ...claims, iat: [] }),
        signedJwt(privateKey, kid, { ...claims, iat: 1.5 }),
        signedJwt(privateKey, kid, { ...claims, nonce: { value: "nonce" } }),
        signedJwt(privateKey, kid, { ...claims, iss: ["https://login.microsoftonline.com"] }),
        `${"a".repeat(20 * 1024)}.e30.signature`,
      ];
      for (const token of hostileTokens) {
        await assert.rejects(
          verifyMicrosoftIdentityToken(database, token, "nonce", discovery),
          (error) => error.code === "OAUTH_ID_TOKEN_INVALID",
        );
      }

      database.__microsoftOidcNowMs = Date.now() + 5 * 60 * 1000 + 1;
      globalThis.fetch = async () => new Response(JSON.stringify({
        keys: [{ kid, kty: "RSA", alg: "RS256", use: "sig", issuer: jwk.issuer, n: null, e: "AQAB" }],
      }));
      await assert.rejects(
        verifyMicrosoftIdentityToken(database, signedJwt(privateKey, kid, claims), "nonce", discovery),
        (error) => error.code === "OAUTH_ID_TOKEN_KEYS_INVALID",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Microsoft identity tokens require signed issuer, audience, expiry, nonce, tenant, and collision-safe stable subject", async () => {
  await withTempDatabase(async (database) => {
    assert.equal(typeof verifyMicrosoftIdentityToken, "function");
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { privateKey: attackerKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = "microsoft-key";
    const jwk = publicKey.export({ format: "jwk" });
    Object.assign(jwk, {
      kid,
      alg: "RS256",
      use: "sig",
      issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
    });
    database.authConfig.providers.microsoft = {
      enabled: true,
      configured: true,
      runtimeAvailable: true,
      clientIdEnv: "MICROSOFT_CLIENT_ID",
      clientSecretEnv: "MICROSOFT_CLIENT_SECRET",
      tenant: "organizations",
    };
    database.serverEnv.MICROSOFT_CLIENT_ID = "microsoft-client-id";
    const tenantId = "11111111-2222-3333-4444-555555555555";
    const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
    const discovery = {
      issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
      jwks_uri: "https://login.microsoftonline.com/organizations/discovery/v2.0/keys",
    };
    const baseClaims = {
      iss: issuer,
      aud: "microsoft-client-id",
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: "expected-nonce",
      tid: tenantId,
      sub: "same-subject-in-every-tenant",
      name: "Microsoft Person",
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      assert.equal(String(url), discovery.jwks_uri);
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const identity = await verifyMicrosoftIdentityToken(
        database,
        signedJwt(privateKey, kid, baseClaims),
        "expected-nonce",
        discovery,
      );
      assert.deepEqual(identity, {
        subject: `${tenantId}:same-subject-in-every-tenant`,
        email: null,
        emailVerified: null,
        displayName: "Microsoft Person",
        picture: null,
      });

      const invalidCases = [
        signedJwt(attackerKey, kid, baseClaims),
        signedJwt(privateKey, kid, { ...baseClaims, iss: "https://attacker.example" }),
        signedJwt(privateKey, kid, { ...baseClaims, aud: "wrong-client" }),
        signedJwt(privateKey, kid, { ...baseClaims, exp: Math.floor(Date.now() / 1000) - 1 }),
        signedJwt(privateKey, kid, { ...baseClaims, nonce: "wrong-nonce" }),
        signedJwt(privateKey, kid, { ...baseClaims, tid: "9188040d-6c67-4c5b-b112-36a304b66dad" }),
        signedJwt(privateKey, kid, { ...baseClaims, sub: "" }),
      ];
      for (const token of invalidCases) {
        await assert.rejects(
          verifyMicrosoftIdentityToken(database, token, "expected-nonce", discovery),
          (error) => error.code?.startsWith("OAUTH_ID_TOKEN_") || error.code === "OAUTH_TENANT_REJECTED",
        );
      }
      jwk.issuer = "https://login.microsoftonline.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/v2.0";
      database.__microsoftOidcNowMs = Date.now() + 5 * 60 * 1000 + 1;
      await assert.rejects(
        verifyMicrosoftIdentityToken(database, signedJwt(privateKey, kid, baseClaims), "expected-nonce", discovery),
        (error) => error.code === "OAUTH_ID_TOKEN_KEY_ISSUER_INVALID",
      );
      jwk.issuer = "https://login.microsoftonline.com/{tenantid}/v2.0";
      database.__microsoftOidcNowMs = Date.now();

      const consumerTenant = "9188040d-6c67-4c5b-b112-36a304b66dad";
      database.authConfig.providers.microsoft.tenant = "consumers";
      const consumerClaims = {
        ...baseClaims,
        iss: `https://login.microsoftonline.com/${consumerTenant}/v2.0`,
        tid: consumerTenant,
      };
      assert.equal(
        (await verifyMicrosoftIdentityToken(
          database,
          signedJwt(privateKey, kid, consumerClaims),
          "expected-nonce",
          discovery,
        )).subject,
        `${consumerTenant}:same-subject-in-every-tenant`,
      );

      database.authConfig.providers.microsoft.tenant = tenantId;
      const otherTenant = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      await assert.rejects(
        verifyMicrosoftIdentityToken(
          database,
          signedJwt(privateKey, kid, {
            ...baseClaims,
            iss: `https://login.microsoftonline.com/${otherTenant}/v2.0`,
            tid: otherTenant,
          }),
          "expected-nonce",
          discovery,
        ),
        (error) => error.code === "OAUTH_TENANT_REJECTED",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("common provider linking reports non-Google identity conflicts neutrally", async () => {
  await withTempDatabase(async (database) => {
    const ownerSession = await resolveAnonymousSession(database, null);
    assert.equal((await linkProviderIdentity(database, ownerSession, "contoso", {
      subject: "shared-subject",
      displayName: "Owner",
    })).ok, true);

    const challengerGuest = await resolveAnonymousSession(database, null);
    assert.equal((await linkProviderIdentity(database, challengerGuest, "rival", {
      subject: "rival-subject",
      displayName: "Challenger",
    })).ok, true);
    const challengerSession = await resolveAnonymousSession(database, challengerGuest.token);
    const conflict = await linkProviderIdentity(database, challengerSession, "contoso", {
      subject: "shared-subject",
      displayName: "Owner",
    });

    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, "AUTH_IDENTITY_CONFLICT");
    assert.doesNotMatch(`${conflict.error.message} ${conflict.error.hint}`, /Google/i);
    assert.match(conflict.error.message, /contoso|provider/i);
  });
});

test("Apple only starts on eligible HTTPS domain origins and sends the exact web authorization contract", async () => {
  await withTempDatabase(async (database) => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    database.authConfig.providers.apple = {
      enabled: true,
      configured: true,
      runtimeAvailable: true,
      clientId: "com.example.web",
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      privateKeyEnv: "APPLE_PRIVATE_KEY",
    };
    database.serverEnv.APPLE_PRIVATE_KEY = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

    for (const origin of [
      "http://capsule.example.test",
      "https://localhost:4000",
      "https://127.0.0.1:4000",
      "https://[::1]:4000",
    ]) {
      assert.equal(appleOAuthOriginEligible(origin), false);
      const session = await resolveAnonymousSession(database, null);
      const result = await beginOAuthSignIn(database, session, "apple", { origin, returnTo: `${origin}/after` });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "OAUTH_APPLE_HTTPS_ORIGIN_REQUIRED");
      assert.match(result.error.hint, /HTTPS.*domain|tunnel|Hosted/i);
      assert.equal(database.adapter.prepare("SELECT COUNT(*) AS count FROM sporades_auth_oauth_states").get().count, 0);
    }

    const origin = "https://capsule.example.test";
    assert.equal(appleOAuthOriginEligible(origin), true);
    const session = await resolveAnonymousSession(database, null);
    const result = await beginOAuthSignIn(database, session, "apple", { origin, returnTo: `${origin}/after` });
    assert.equal(result.ok, true);
    const authorization = new URL(result.url);
    assert.equal(authorization.origin, "https://appleid.apple.com");
    assert.equal(authorization.pathname, "/auth/authorize");
    assert.equal(authorization.searchParams.get("client_id"), "com.example.web");
    assert.equal(authorization.searchParams.get("redirect_uri"), `${origin}/__sporades/auth/apple/callback`);
    assert.equal(authorization.searchParams.get("response_type"), "code");
    assert.equal(authorization.searchParams.get("response_mode"), "form_post");
    assert.equal(authorization.searchParams.get("scope"), "name email");
    assert.ok(authorization.searchParams.get("state"));
    assert.ok(authorization.searchParams.get("nonce"));
    assert.equal(authorization.searchParams.has("code_challenge"), false);

    database.serverEnv.APPLE_PRIVATE_KEY = "not-a-private-key";
    const invalidCredentialResponse = responseRecorder();
    await routeSporadesAuth(database, formPostRequest("/__sporades/auth/apple/callback", {
      state: authorization.searchParams.get("state"),
      code: "cannot-exchange",
    }), invalidCredentialResponse);
    assert.equal(invalidCredentialResponse.statusCode, 500);
    assert.match(invalidCredentialResponse.body, /OAUTH_CLIENT_CREDENTIAL_INVALID/);
    assert.doesNotMatch(invalidCredentialResponse.body, /not-a-private-key|cannot-exchange/);
    assert.equal(
      database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(authorization.searchParams.get("state")),
      undefined,
    );

    database.serverEnv.APPLE_PRIVATE_KEY = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const cancelledStart = await beginOAuthSignIn(database, await resolveAnonymousSession(database, null), "apple", {
      origin,
      returnTo: `${origin}/after`,
    });
    const cancelledState = new URL(cancelledStart.url).searchParams.get("state");
    const cancelledResponse = responseRecorder();
    await routeSporadesAuth(database, formPostRequest("/__sporades/auth/apple/callback", {
      state: cancelledState,
      error: "user_cancelled_authorize",
      error_description: "private-provider-detail",
    }), cancelledResponse);
    assert.equal(cancelledResponse.statusCode, 500);
    assert.match(cancelledResponse.body, /OAUTH_PROVIDER_CANCELLED/);
    assert.doesNotMatch(cancelledResponse.body, /private-provider-detail/);
    assert.equal(
      database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(cancelledState),
      undefined,
    );
  });
});

test("OAuth origin resolution ignores untrusted forwarding and requires configured-origin header agreement", () => {
  const noPublicOrigin = { cors: { publicOrigin: null } };
  assert.equal(resolveOAuthRequestOrigin(noPublicOrigin, {
    headers: {
      host: "127.0.0.1:4000",
      "x-forwarded-host": "spoofed.example.test",
      "x-forwarded-proto": "https",
    },
    socket: { encrypted: false },
  }), null);
  assert.equal(resolveOAuthRequestOrigin(noPublicOrigin, {
    headers: { host: "localhost:4000", origin: "http://localhost:4000" },
    socket: { encrypted: false },
  }), "http://localhost:4000");
  assert.equal(resolveOAuthRequestOrigin(noPublicOrigin, {
    headers: { host: "capsule.example.test", origin: "https://capsule.example.test" },
    socket: { encrypted: true },
  }), "https://capsule.example.test");
  assert.equal(resolveOAuthRequestOrigin(noPublicOrigin, {
    headers: { host: "other.example.test", origin: "https://capsule.example.test" },
    socket: { encrypted: true },
  }), null);

  const hostedPolicy = { cors: { publicOrigin: "https://capsule.example.test" } };
  const matchingProxyRequest = {
    headers: {
      host: "capsule.example.test",
      origin: "https://capsule.example.test",
      "x-forwarded-host": "capsule.example.test",
      "x-forwarded-proto": "https",
    },
    socket: { encrypted: false },
  };
  assert.equal(resolveOAuthRequestOrigin(hostedPolicy, matchingProxyRequest), "https://capsule.example.test");
  for (const request of [
    { ...matchingProxyRequest, headers: { ...matchingProxyRequest.headers, origin: "https://evil.example" } },
    { ...matchingProxyRequest, headers: { ...matchingProxyRequest.headers, host: "evil.example" } },
    { ...matchingProxyRequest, headers: { ...matchingProxyRequest.headers, "x-forwarded-host": "evil.example" } },
    { ...matchingProxyRequest, headers: { ...matchingProxyRequest.headers, "x-forwarded-proto": "http" } },
  ]) {
    assert.equal(resolveOAuthRequestOrigin(hostedPolicy, request), null);
  }
});

test("OAuth form-post callbacks reject ambiguous or malformed input with deliberate state spending", async () => {
  await withTempDatabase(async (database) => {
    database.__oauthProviderAdapters = {
      apple: providerAdapter({ provider: "apple", responseMode: "form_post" }),
    };
    async function start() {
      const session = await resolveAnonymousSession(database, null);
      const result = await beginOAuthSignIn(database, session, "apple", {
        origin: "https://capsule.example.test",
        returnTo: "https://capsule.example.test/after",
      });
      return new URL(result.url).searchParams.get("state");
    }
    async function callback(body, contentType) {
      const response = responseRecorder();
      await routeSporadesAuth(database, rawFormPostRequest("/__sporades/auth/apple/callback", body, contentType), response);
      return response;
    }

    let state = await start();
    let response = await callback(`state=${state}&code=one&code=two`);
    assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
    assert.equal(database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state), undefined);

    for (const ambiguous of [
      "error=access_denied&error=user_cancelled",
      "code=one&user=%7B%7D&user=%7B%7D",
    ]) {
      state = await start();
      response = await callback(`state=${state}&${ambiguous}`);
      assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
      assert.equal(database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state), undefined);
    }

    state = await start();
    response = await callback(`state=${state}&code=one&error=access_denied`);
    assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
    assert.equal(database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state), undefined);

    state = await start();
    response = await callback(`state=${state}&state=other&code=one`);
    assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
    assert.ok(database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state));

    for (const contentType of [
      "text/plain",
      "application/x-www-form-urlencodedish",
      "application/x-www-form-urlencoded; charset=iso-8859-1",
      "application/x-www-form-urlencoded; surprise=yes",
      "application/x-www-form-urlencoded; charset",
    ]) {
      state = await start();
      response = await callback(`state=${state}&code=one`, contentType);
      assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
      assert.ok(database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state));
    }

    state = await start();
    response = await callback(`state=${state}&code=%GG`);
    assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
    assert.equal(database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state), undefined);

    for (const encodedControl of ["%00", "%01", "%09", "%0D", "%7F", "%C2%80"]) {
      for (const field of ["code", "error", "user"]) {
        state = await start();
        response = await callback(`state=${state}&${field}=${encodedControl}`);
        assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
        assert.equal(database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state), undefined);
      }
      state = await start();
      response = await callback(`state=${encodedControl}&code=one`);
      assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
      assert.ok(database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state));

      state = await start();
      response = await callback(`state=${state}&co${encodedControl}de=one`);
      assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
      assert.ok(database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state));
    }

    for (const rawControl of [0x00, 0x01, 0x09, 0x0d, 0x7f]) {
      state = await start();
      response = await callback(Buffer.concat([
        Buffer.from(`state=${state}&code=`),
        Buffer.from([rawControl]),
      ]));
      assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
      assert.equal(database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state), undefined);
    }

    for (const invalidUtf8 of [Buffer.from([0xc3, 0x28]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80])]) {
      state = await start();
      response = await callback(Buffer.concat([Buffer.from(`state=${state}&code=`), invalidUtf8]));
      assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
      assert.equal(database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state), undefined);

      state = await start();
      response = await callback(Buffer.concat([Buffer.from("state="), invalidUtf8, Buffer.from("&code=one")]));
      assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
      assert.ok(database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state));
    }

    state = await start();
    response = await callback(`state=${state}&co%00de=one`);
    assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
    assert.ok(database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state));

    state = await start();
    response = await callback(`state=${state}&code=%C3%28`);
    assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
    assert.equal(database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state), undefined);

    for (const forbiddenScalar of ["%EF%BF%BD", "%EF%B7%90", "%F0%9F%BF%BE"]) {
      state = await start();
      response = await callback(`state=${state}&code=${forbiddenScalar}`);
      assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
      assert.equal(database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state), undefined);
    }

    state = await start();
    response = await callback(`state=${state}&code=${"x".repeat(17 * 1024)}`);
    assert.equal(response.statusCode, 413);
    assert.ok(database.adapter.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state));

    state = await start();
    response = await callback(
      `state=${state}&code=valid&user=${encodeURIComponent(JSON.stringify({ name: { firstName: "Zoë", lastName: "张" } }))}`,
      "Application/X-Www-Form-Urlencoded; Charset=\"UTF-8\"",
    );
    assert.equal(response.statusCode, 302, response.body);
  });
});

test("Apple client secret is a short-lived ES256 JWT and identity tokens are verified strictly", async () => {
  await withTempDatabase(async (database) => {
    const { publicKey: clientPublicKey, privateKey: clientPrivateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    database.authConfig.providers.apple = {
      enabled: true,
      configured: true,
      runtimeAvailable: true,
      clientId: "com.example.web",
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      privateKeyEnv: "APPLE_PRIVATE_KEY",
    };
    database.serverEnv.APPLE_PRIVATE_KEY = clientPrivateKey.export({ format: "pem", type: "pkcs8" }).toString();

    const now = 2_000_000_000;
    const clientSecret = createAppleClientSecret(database, now);
    const [clientHeaderPart, clientClaimsPart, clientSignaturePart] = clientSecret.split(".");
    const clientHeader = JSON.parse(Buffer.from(clientHeaderPart, "base64url").toString());
    const clientClaims = JSON.parse(Buffer.from(clientClaimsPart, "base64url").toString());
    assert.deepEqual(clientHeader, { alg: "ES256", kid: "KEY1234567", typ: "JWT" });
    assert.equal(clientClaims.iss, "TEAM123456");
    assert.equal(clientClaims.sub, "com.example.web");
    assert.equal(clientClaims.aud, "https://appleid.apple.com");
    assert.equal(clientClaims.iat, now);
    assert.ok(clientClaims.exp > now);
    assert.ok(clientClaims.exp - now <= 300);
    assert.equal(Buffer.from(clientSignaturePart, "base64url").length, 64);
    assert.equal(
      verify(
        "sha256",
        Buffer.from(`${clientHeaderPart}.${clientClaimsPart}`),
        { key: clientPublicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(clientSignaturePart, "base64url"),
      ),
      true,
    );

    const invalidPrivateKeys = [
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      clientPublicKey.export({ format: "pem", type: "spki" }).toString(),
      clientPrivateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "encrypted" }).toString(),
      "not-a-key",
    ];
    for (const privateKey of invalidPrivateKeys) {
      database.serverEnv.APPLE_PRIVATE_KEY = privateKey;
      assert.throws(
        () => createAppleClientSecret(database, now),
        (error) => error.code === "OAUTH_CLIENT_CREDENTIAL_INVALID" && !String(error.message).includes(privateKey),
      );
    }
    database.serverEnv.APPLE_PRIVATE_KEY = clientPrivateKey.export({ format: "pem", type: "pkcs8" }).toString();

    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { privateKey: attackerKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = "apple-signing-key";
    const jwk = publicKey.export({ format: "jwk" });
    Object.assign(jwk, { kid, alg: "RS256", use: "sig" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const claims = {
      iss: "https://appleid.apple.com",
      aud: "com.example.web",
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: "expected-nonce",
      sub: "apple-stable-subject",
      email: "relay@privaterelay.appleid.com",
      email_verified: "true",
    };
    try {
      assert.deepEqual(
        await verifyAppleIdentityToken(database, signedJwt(privateKey, kid, claims), "expected-nonce"),
        {
          subject: "apple-stable-subject",
          email: "relay@privaterelay.appleid.com",
          emailVerified: true,
          displayName: null,
          picture: null,
        },
      );
      for (const token of [
        signedJwt(attackerKey, kid, claims),
        signedJwt(privateKey, kid, { ...claims, iss: "https://attacker.example" }),
        signedJwt(privateKey, kid, { ...claims, aud: "wrong-service" }),
        signedJwt(privateKey, kid, { ...claims, exp: Math.floor(Date.now() / 1000) - 1 }),
        signedJwt(privateKey, kid, { ...claims, nonce: "wrong" }),
        signedJwt(privateKey, kid, { ...claims, sub: "" }),
        signedJwt(privateKey, kid, null),
        signedJwt(privateKey, kid, []),
        signedJwt(privateKey, kid, "claims"),
        signedJwt(privateKey, kid, { ...claims, aud: { client: "com.example.web" } }),
        signedJwt(privateKey, kid, { ...claims, exp: "soon" }),
        signedJwt(privateKey, kid, { ...claims, nonce: ["expected-nonce"] }),
        signedJwt(privateKey, kid, { ...claims, sub: ["apple-stable-subject"] }),
        signedJwtWithHeader(privateKey, null, claims),
        signedJwtWithHeader(privateKey, [], claims),
        signedJwtWithHeader(privateKey, "header", claims),
      ]) {
        await assert.rejects(
          verifyAppleIdentityToken(database, token, "expected-nonce"),
          (error) => error.code?.startsWith("OAUTH_ID_TOKEN_"),
        );
      }

      globalThis.fetch = async () => new Response(JSON.stringify({
        keys: [{ ...jwk, use: "enc" }, { ...jwk, use: "sig", alg: "RS512" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
      await assert.rejects(
        verifyAppleIdentityToken(database, signedJwt(privateKey, kid, claims), "expected-nonce"),
        (error) => error.code === "OAUTH_ID_TOKEN_INVALID",
      );

      for (const malformedJwks of [null, [], "jwks", { keys: {} }, { keys: Array.from({ length: 33 }, () => jwk) }]) {
        globalThis.fetch = async () => new Response(JSON.stringify(malformedJwks), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
        await assert.rejects(
          verifyAppleIdentityToken(database, signedJwt(privateKey, kid, claims), "expected-nonce"),
          (error) => error.code === "OAUTH_ID_TOKEN_KEYS_INVALID",
        );
      }

      globalThis.fetch = async () => new Response(JSON.stringify({
        keys: [{ ...jwk, kid: "different-valid-key" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
      await assert.rejects(
        verifyAppleIdentityToken(database, signedJwt(privateKey, kid, claims), "expected-nonce"),
        (error) => error.code === "OAUTH_ID_TOKEN_INVALID",
      );

      globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk], padding: "x".repeat(70 * 1024) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      await assert.rejects(
        verifyAppleIdentityToken(database, signedJwt(privateKey, kid, claims), "expected-nonce"),
        (error) => error.code === "OAUTH_ID_TOKEN_KEYS_INVALID",
      );

      const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const rotatedJwk = rotated.publicKey.export({ format: "jwk" });
      Object.assign(rotatedJwk, { kid: "rotated-key", alg: "RS256", use: "sig" });
      globalThis.fetch = async () => new Response(JSON.stringify({ keys: [rotatedJwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      const rotatedIdentity = await verifyAppleIdentityToken(
        database,
        signedJwt(rotated.privateKey, "rotated-key", claims),
        "expected-nonce",
      );
      assert.equal(rotatedIdentity.subject, "apple-stable-subject");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Apple form-post links the anonymous user, sanitizes first-login name, and later resolves by subject without name or email", async () => {
  await withTempDatabase(async (database) => {
    const { privateKey: clientPrivateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const { publicKey: applePublicKey, privateKey: applePrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = "apple-key";
    const jwk = applePublicKey.export({ format: "jwk" });
    Object.assign(jwk, { kid, alg: "RS256", use: "sig" });
    database.authConfig.providers.apple = {
      enabled: true,
      configured: true,
      runtimeAvailable: true,
      clientId: "com.example.web",
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      privateKeyEnv: "APPLE_PRIVATE_KEY",
    };
    database.serverEnv.APPLE_PRIVATE_KEY = clientPrivateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const originalFetch = globalThis.fetch;
    let expectedNonce = "";
    let includeEmail = true;
    let tokenRequestBody = null;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/auth/token")) {
        tokenRequestBody = new URLSearchParams(init.body);
        return new Response(JSON.stringify({
          id_token: signedJwt(applePrivateKey, kid, {
            iss: "https://appleid.apple.com",
            aud: "com.example.web",
            exp: Math.floor(Date.now() / 1000) + 300,
            nonce: expectedNonce,
            sub: "stable-apple-subject",
            ...(includeEmail ? { email: "relay@privaterelay.appleid.com", email_verified: "true" } : {}),
          }),
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const firstGuest = await resolveAnonymousSession(database, null);
      const firstStart = await beginOAuthSignIn(database, firstGuest, "apple", {
        origin: "https://capsule.example.test",
        returnTo: "https://capsule.example.test/after",
      });
      const firstState = new URL(firstStart.url).searchParams.get("state");
      expectedNonce = database.adapter.prepare("SELECT nonce FROM sporades_auth_oauth_states WHERE state = ?").get(firstState).nonce;
      const firstResponse = responseRecorder();
      await routeSporadesAuth(database, formPostRequest("/__sporades/auth/apple/callback", {
        state: firstState,
        code: "first-code",
        user: JSON.stringify({
          email: "untrusted@example.test",
          name: { firstName: "  Zoë\u0000 ", lastName: " 张  " },
        }),
      }), firstResponse);
      assert.equal(firstResponse.statusCode, 302, firstResponse.body);
      assert.equal(firstResponse.headers.location, "https://capsule.example.test/after");
      assert.equal(tokenRequestBody.get("client_id"), "com.example.web");
      assert.equal(tokenRequestBody.get("redirect_uri"), "https://capsule.example.test/__sporades/auth/apple/callback");
      assert.equal(tokenRequestBody.get("grant_type"), "authorization_code");
      assert.equal(tokenRequestBody.get("code"), "first-code");
      assert.ok(tokenRequestBody.get("client_secret"));
      assert.doesNotMatch(firstResponse.body, /client_secret|PRIVATE KEY|relay@/i);

      const firstSession = database.adapter.readAuthSessionWithUser(firstGuest.token);
      assert.equal(firstSession.provider, "apple");
      assert.equal(firstSession.userId, firstGuest.auth.userId);
      assert.equal(firstSession.displayName, "Zoë 张");
      assert.equal(firstSession.email, "relay@privaterelay.appleid.com");

      includeEmail = false;
      const returningGuest = await resolveAnonymousSession(database, null);
      const returningStart = await beginOAuthSignIn(database, returningGuest, "apple", {
        origin: "https://capsule.example.test",
        returnTo: "https://capsule.example.test/account",
      });
      const returningState = new URL(returningStart.url).searchParams.get("state");
      expectedNonce = database.adapter.prepare("SELECT nonce FROM sporades_auth_oauth_states WHERE state = ?").get(returningState).nonce;
      const returningResponse = responseRecorder();
      await routeSporadesAuth(database, formPostRequest("/__sporades/auth/apple/callback", {
        state: returningState,
        code: "return-code",
      }), returningResponse);
      assert.equal(returningResponse.statusCode, 302, returningResponse.body);
      const returningSession = database.adapter.readAuthSessionWithUser(returningGuest.token);
      assert.equal(returningSession.provider, "apple");
      assert.equal(returningSession.userId, firstGuest.auth.userId);
      assert.equal(returningSession.displayName, "Zoë 张");
      assert.equal(returningSession.email, "relay@privaterelay.appleid.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
