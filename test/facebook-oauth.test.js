import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  openDevDatabase,
  resolveAnonymousSession,
  routeSporadesAuth,
  SERVER_RUNTIME_SOURCE_FUNCTIONS,
} from "../dist/server-runtime-source.js";
import { authStatus } from "../dist/bundle-pipeline.js";

const beginOAuthSignIn = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "beginOAuthSignIn");
const oauthProviderAdapter = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "oauthProviderAdapter");
const linkProviderIdentity = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "linkProviderIdentity");
const authProvidersForClient = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "authProvidersForClient");

async function withFacebookDatabase(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-facebook-oauth-"));
  const database = await openDevDatabase(
    path.join(dir, "data.db"),
    "",
    {
      FACEBOOK_CLIENT_ID: "facebook-app-id",
      FACEBOOK_CLIENT_SECRET: "facebook-app-secret",
    },
    {
      auth: {
        providers: {
          anonymous: true,
          facebook: {
            enabled: true,
            clientIdEnv: "FACEBOOK_CLIENT_ID",
            clientSecretEnv: "FACEBOOK_CLIENT_SECRET",
            graphVersion: "v23.0",
          },
        },
      },
    },
  );
  try {
    return await fn(database);
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

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

function responseJson(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Facebook adapter uses the supported versioned code and Graph profile flow without requiring email", async () => {
  await withFacebookDatabase(async (database) => {
    const adapter = oauthProviderAdapter(database, "facebook");
    assert.equal(adapter.enabled, true);
    const started = adapter.begin({
      state: "opaque-state",
      redirectUri: "https://capsule.example/__sporades/auth/facebook/callback",
    });
    const authorizationUrl = new URL(started.url);
    assert.equal(authorizationUrl.origin, "https://www.facebook.com");
    assert.equal(authorizationUrl.pathname, "/v23.0/dialog/oauth");
    assert.equal(authorizationUrl.searchParams.get("client_id"), "facebook-app-id");
    assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "https://capsule.example/__sporades/auth/facebook/callback");
    assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
    assert.equal(authorizationUrl.searchParams.get("scope"), "public_profile,email");
    assert.equal(authorizationUrl.searchParams.get("state"), "opaque-state");
    assert.doesNotMatch(started.url, /facebook-app-secret/);

    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (requests.length === 1) {
        return responseJson({ access_token: "provider-access-token", token_type: "bearer" });
      }
      return responseJson({
        id: "facebook-stable-subject",
        name: "Meta Person",
        picture: { data: { url: "https://images.example/person.jpg" } },
      });
    };
    try {
      const profile = await adapter.complete({
        code: "authorization-code",
        redirectUri: "https://capsule.example/__sporades/auth/facebook/callback",
      });
      assert.deepEqual(profile, {
        subject: "facebook-stable-subject",
        email: null,
        emailVerified: null,
        displayName: "Meta Person",
        picture: "https://images.example/person.jpg",
      });
      const tokenBody = Object.fromEntries(new URLSearchParams(requests[0].options.body).entries());
      assert.deepEqual(tokenBody, {
        code: "authorization-code",
        client_id: "facebook-app-id",
        client_secret: "facebook-app-secret",
        redirect_uri: "https://capsule.example/__sporades/auth/facebook/callback",
      });
      const graphUrl = new URL(requests[1].url);
      assert.equal(graphUrl.pathname, "/v23.0/me");
      assert.equal(graphUrl.searchParams.get("fields"), "id,name,email,picture");
      assert.equal(requests[1].options.headers.authorization, "Bearer provider-access-token");
      assert.doesNotMatch(requests[1].url, /provider-access-token/);
      assert.equal(requests[0].options.redirect, "error");
      assert.equal(requests[1].options.redirect, "error");
      assert.ok(requests[0].options.signal instanceof AbortSignal);
      assert.ok(requests[1].options.signal instanceof AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Facebook direct config distinguishes an absent Graph version from invalid supplied values in build and runtime status", async () => {
  const env = { FACEBOOK_CLIENT_ID: "id", FACEBOOK_CLIENT_SECRET: "secret" };
  const provider = (graphVersion, supplied = true) => {
    const facebook = {
      enabled: true,
      clientIdEnv: "FACEBOOK_CLIENT_ID",
      clientSecretEnv: "FACEBOOK_CLIENT_SECRET",
    };
    if (supplied) facebook.graphVersion = graphVersion;
    return authStatus({ auth: { providers: { facebook } } }, env).providers.facebook;
  };
  const absentBuildStatus = provider(undefined, false);
  assert.deepEqual(
    {
      configured: absentBuildStatus.configured,
      runtimeAvailable: absentBuildStatus.runtimeAvailable,
      graphVersion: absentBuildStatus.graphVersion,
    },
    { configured: true, runtimeAvailable: true, graphVersion: "v23.0" },
  );
  const absentDir = await mkdtemp(path.join(tmpdir(), "sporades-facebook-version-"));
  const absentDatabase = await openDevDatabase(path.join(absentDir, "data.db"), "", env, {
    auth: {
      providers: {
        facebook: {
          enabled: true,
          clientIdEnv: "FACEBOOK_CLIENT_ID",
          clientSecretEnv: "FACEBOOK_CLIENT_SECRET",
        },
      },
    },
  });
  try {
    assert.equal(absentDatabase.authConfig.providers.facebook.graphVersion, "v23.0");
    assert.equal(authProvidersForClient(absentDatabase.authConfig).facebook.graphVersion, "v23.0");
    assert.equal(oauthProviderAdapter(absentDatabase, "facebook").enabled, true);
  } finally {
    absentDatabase.close();
    await rm(absentDir, { recursive: true, force: true });
  }
  for (const invalid of [null, 23, [], "v99.0", "23.0", ""]) {
    const status = provider(invalid);
    assert.equal(status.configured, false, JSON.stringify(invalid));
    assert.equal(status.runtimeAvailable, false, JSON.stringify(invalid));
    const dir = await mkdtemp(path.join(tmpdir(), "sporades-facebook-version-"));
    const database = await openDevDatabase(path.join(dir, "data.db"), "", env, {
      auth: {
        providers: {
          facebook: {
            enabled: true,
            clientIdEnv: "FACEBOOK_CLIENT_ID",
            clientSecretEnv: "FACEBOOK_CLIENT_SECRET",
            graphVersion: invalid,
          },
        },
      },
    });
    try {
      assert.equal(database.authConfig.providers.facebook.configured, false, JSON.stringify(invalid));
      assert.equal(database.authConfig.providers.facebook.runtimeAvailable, false, JSON.stringify(invalid));
      assert.equal(oauthProviderAdapter(database, "facebook").enabled, false, JSON.stringify(invalid));
    } finally {
      database.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("Facebook rejects unsafe endpoint overrides before sending credentials", async () => {
  await withFacebookDatabase(async (database) => {
    const adapter = oauthProviderAdapter(database, "facebook");
    const originalTokenUrl = process.env.SPORADES_FACEBOOK_TOKEN_URL;
    const originalGraphUrl = process.env.SPORADES_FACEBOOK_GRAPH_URL;
    let called = false;
    const originalFetch = globalThis.fetch;
    process.env.SPORADES_FACEBOOK_TOKEN_URL = "http://attacker.example/token";
    globalThis.fetch = async () => {
      called = true;
      return responseJson({});
    };
    try {
      await assert.rejects(
        adapter.complete({ code: "code", redirectUri: "https://capsule.example/__sporades/auth/facebook/callback" }),
        (error) => error.code === "FACEBOOK_ENDPOINT_UNSAFE",
      );
      assert.equal(called, false);

      delete process.env.SPORADES_FACEBOOK_TOKEN_URL;
      process.env.SPORADES_FACEBOOK_GRAPH_URL = "http://attacker.example/me";
      called = false;
      globalThis.fetch = async () => {
        called = true;
        return responseJson({ access_token: "provider-access-token" });
      };
      await assert.rejects(
        adapter.complete({ code: "code", redirectUri: "https://capsule.example/__sporades/auth/facebook/callback" }),
        (error) => error.code === "FACEBOOK_ENDPOINT_UNSAFE",
      );
      assert.equal(called, true, "only the safe HTTPS token exchange occurs before the unsafe Graph endpoint is rejected");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalTokenUrl === undefined) delete process.env.SPORADES_FACEBOOK_TOKEN_URL;
      else process.env.SPORADES_FACEBOOK_TOKEN_URL = originalTokenUrl;
      if (originalGraphUrl === undefined) delete process.env.SPORADES_FACEBOOK_GRAPH_URL;
      else process.env.SPORADES_FACEBOOK_GRAPH_URL = originalGraphUrl;
    }
  });
});

test("Facebook callback failures are bounded for cancellation, restrictions, permissions, and redirect mismatch", async () => {
  await withFacebookDatabase(async (database) => {
    const cases = [
      ["error=access_denied&error_reason=user_denied&error_description=raw-cancel-secret", "FACEBOOK_PERMISSION_DENIED"],
      ["error=temporarily_unavailable&error_description=App+is+still+in+development+mode+raw-secret", "FACEBOOK_APP_RESTRICTED"],
      ["error=OAuthException&error_code=200&error_description=raw-permission-secret", "FACEBOOK_PERMISSION_DENIED"],
      ["error=OAuthException&error_code=191&error_description=raw-redirect-secret", "FACEBOOK_REDIRECT_MISMATCH"],
    ];
    for (const [query, expectedCode] of cases) {
      const session = await resolveAnonymousSession(database, null);
      const started = await beginOAuthSignIn(database, session, "facebook", {
        origin: "https://capsule.example",
        returnTo: "https://capsule.example/after",
      });
      const state = new URL(started.url).searchParams.get("state");
      const response = responseRecorder();
      await routeSporadesAuth(
        database,
        { method: "GET", url: `/__sporades/auth/facebook/callback?state=${state}&${query}`, headers: {} },
        response,
      );
      const payload = JSON.parse(response.body);
      assert.equal(payload.error.code, expectedCode);
      assert.doesNotMatch(response.body, /raw-|development mode/);
    }
  });
});

test("Facebook exchange and Graph failures expose bounded errors without provider bodies or tokens", async () => {
  await withFacebookDatabase(async (database) => {
    const adapter = oauthProviderAdapter(database, "facebook");
    const rawSecret = "raw-facebook-provider-secret";
    const cases = [
      {
        responses: [responseJson({ error: { message: rawSecret } }, 400)],
        code: "FACEBOOK_EXCHANGE_FAILED",
      },
      {
        responses: [new Response(`{"access_token":"${rawSecret}"`)],
        code: "FACEBOOK_EXCHANGE_FAILED",
      },
      {
        responses: [responseJson({ token_type: "bearer", raw: rawSecret })],
        code: "FACEBOOK_EXCHANGE_FAILED",
      },
      {
        responses: [
          responseJson({ access_token: "provider-access-token" }),
          responseJson({ error: { message: rawSecret } }, 403),
        ],
        code: "FACEBOOK_GRAPH_FAILED",
      },
      {
        responses: [
          responseJson({ access_token: "provider-access-token" }),
          new Response(`{"id":"${rawSecret}"`),
        ],
        code: "FACEBOOK_GRAPH_FAILED",
      },
      {
        responses: [
          responseJson({ access_token: "provider-access-token" }),
          responseJson({ name: rawSecret }),
        ],
        code: "FACEBOOK_PROFILE_ID_MISSING",
      },
      {
        responses: [new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(40 * 1024));
            controller.enqueue(new Uint8Array(40 * 1024));
            controller.close();
          },
        }))],
        code: "FACEBOOK_EXCHANGE_FAILED",
      },
      {
        responses: [
          responseJson({ access_token: "provider-access-token" }),
          new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(40 * 1024));
              controller.enqueue(new Uint8Array(40 * 1024));
              controller.close();
            },
          })),
        ],
        code: "FACEBOOK_GRAPH_FAILED",
      },
    ];
    const originalFetch = globalThis.fetch;
    try {
      for (const testCase of cases) {
        let call = 0;
        globalThis.fetch = async () => testCase.responses[call++];
        await assert.rejects(
          adapter.complete({
            code: "authorization-code",
            redirectUri: "https://capsule.example/__sporades/auth/facebook/callback",
          }),
          (error) => {
            assert.equal(error.code, testCase.code);
            assert.doesNotMatch(`${error.message} ${error.hint}`, new RegExp(`${rawSecret}|provider-access-token`));
            return true;
          },
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Facebook bounds redirects and timeouts for both exchange and Graph requests", async () => {
  await withFacebookDatabase(async (database) => {
    const adapter = oauthProviderAdapter(database, "facebook");
    const originalFetch = globalThis.fetch;
    const redirectError = Object.assign(new TypeError("redirect refused raw-secret"), { cause: "raw-secret" });
    const timeoutError = Object.assign(new Error("stall raw-secret"), { name: "TimeoutError" });
    const cases = [
      { fetches: [() => { throw redirectError; }], code: "FACEBOOK_EXCHANGE_FAILED" },
      { fetches: [() => { throw timeoutError; }], code: "FACEBOOK_EXCHANGE_TIMEOUT" },
      {
        fetches: [
          () => responseJson({ access_token: "provider-access-token" }),
          () => { throw redirectError; },
        ],
        code: "FACEBOOK_GRAPH_FAILED",
      },
      {
        fetches: [
          () => responseJson({ access_token: "provider-access-token" }),
          () => { throw timeoutError; },
        ],
        code: "FACEBOOK_GRAPH_TIMEOUT",
      },
    ];
    try {
      for (const testCase of cases) {
        let call = 0;
        globalThis.fetch = async () => testCase.fetches[call++]();
        await assert.rejects(
          adapter.complete({ code: "code", redirectUri: "https://capsule.example/__sporades/auth/facebook/callback" }),
          (error) => {
            assert.equal(error.code, testCase.code);
            assert.doesNotMatch(`${error.message} ${error.hint}`, /raw-secret|provider-access-token/);
            return true;
          },
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Facebook abort deadlines terminate stalled exchange and Graph reads", async () => {
  await withFacebookDatabase(async (database) => {
    const adapter = oauthProviderAdapter(database, "facebook");
    const originalFetch = globalThis.fetch;
    const originalAllow = process.env.SPORADES_FACEBOOK_TEST_ALLOW_INSECURE_LOOPBACK;
    const originalTimeout = process.env.SPORADES_FACEBOOK_TEST_TIMEOUT_MS;
    process.env.SPORADES_FACEBOOK_TEST_ALLOW_INSECURE_LOOPBACK = "1";
    process.env.SPORADES_FACEBOOK_TEST_TIMEOUT_MS = "10";
    const stall = (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
    try {
      globalThis.fetch = stall;
      await assert.rejects(
        adapter.complete({ code: "code", redirectUri: "https://capsule.example/__sporades/auth/facebook/callback" }),
        (error) => error.code === "FACEBOOK_EXCHANGE_TIMEOUT",
      );
      let call = 0;
      globalThis.fetch = (url, options) => call++ === 0
        ? Promise.resolve(responseJson({ access_token: "provider-access-token" }))
        : stall(url, options);
      await assert.rejects(
        adapter.complete({ code: "code", redirectUri: "https://capsule.example/__sporades/auth/facebook/callback" }),
        (error) => error.code === "FACEBOOK_GRAPH_TIMEOUT",
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalAllow === undefined) delete process.env.SPORADES_FACEBOOK_TEST_ALLOW_INSECURE_LOOPBACK;
      else process.env.SPORADES_FACEBOOK_TEST_ALLOW_INSECURE_LOOPBACK = originalAllow;
      if (originalTimeout === undefined) delete process.env.SPORADES_FACEBOOK_TEST_TIMEOUT_MS;
      else process.env.SPORADES_FACEBOOK_TEST_TIMEOUT_MS = originalTimeout;
    }
  });
});

test("Facebook preserves timeout taxonomy and closes real loopback responses that stall after partial JSON", async () => {
  await withFacebookDatabase(async (database) => {
    const closed = new Set();
    const server = createServer((request, response) => {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      response.on("close", () => closed.add(pathname));
      response.writeHead(200, { "content-type": "application/json" });
      if (pathname === "/token") {
        response.end(JSON.stringify({ access_token: "provider-access-token" }));
        return;
      }
      response.flushHeaders();
      response.write(pathname === "/slow-token"
        ? '{"access_token":"raw-partial-token'
        : '{"id":"raw-partial-profile');
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const adapter = oauthProviderAdapter(database, "facebook");
    const originals = {
      allow: process.env.SPORADES_FACEBOOK_TEST_ALLOW_INSECURE_LOOPBACK,
      timeout: process.env.SPORADES_FACEBOOK_TEST_TIMEOUT_MS,
      token: process.env.SPORADES_FACEBOOK_TOKEN_URL,
      graph: process.env.SPORADES_FACEBOOK_GRAPH_URL,
    };
    process.env.SPORADES_FACEBOOK_TEST_ALLOW_INSECURE_LOOPBACK = "1";
    process.env.SPORADES_FACEBOOK_TEST_TIMEOUT_MS = "30";
    try {
      const cases = [
        {
          tokenUrl: `${origin}/slow-token`,
          graphUrl: `${origin}/graph`,
          code: "FACEBOOK_EXCHANGE_TIMEOUT",
          closedPath: "/slow-token",
        },
        {
          tokenUrl: `${origin}/token`,
          graphUrl: `${origin}/slow-graph`,
          code: "FACEBOOK_GRAPH_TIMEOUT",
          closedPath: "/slow-graph",
        },
      ];
      for (const testCase of cases) {
        process.env.SPORADES_FACEBOOK_TOKEN_URL = testCase.tokenUrl;
        process.env.SPORADES_FACEBOOK_GRAPH_URL = testCase.graphUrl;
        const startedAt = Date.now();
        await assert.rejects(
          adapter.complete({ code: "code", redirectUri: "https://capsule.example/__sporades/auth/facebook/callback" }),
          (error) => {
            assert.equal(error.code, testCase.code);
            assert.doesNotMatch(`${error.message} ${error.hint}`, /raw-partial|provider-access-token/);
            return true;
          },
        );
        assert.ok(Date.now() - startedAt < 1_000, `${testCase.code} exceeded its bounded deadline`);
        for (let attempt = 0; attempt < 50 && !closed.has(testCase.closedPath); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(closed.has(testCase.closedPath), `${testCase.closedPath} response was not closed after abort`);
      }
    } finally {
      for (const [name, value] of Object.entries(originals)) {
        const key = {
          allow: "SPORADES_FACEBOOK_TEST_ALLOW_INSECURE_LOOPBACK",
          timeout: "SPORADES_FACEBOOK_TEST_TIMEOUT_MS",
          token: "SPORADES_FACEBOOK_TOKEN_URL",
          graph: "SPORADES_FACEBOOK_GRAPH_URL",
        }[name];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("Facebook links an anonymous session and a returning subject resolves the same Sporades user without persisting tokens", async () => {
  await withFacebookDatabase(async (database) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => String(url).includes("/oauth/access_token")
      ? responseJson({ access_token: "provider-access-token" })
      : responseJson({ id: "returning-facebook-subject", name: "No Email Person" });
    try {
      const firstSession = await resolveAnonymousSession(database, null);
      const firstStart = await beginOAuthSignIn(database, firstSession, "facebook", {
        origin: "https://capsule.example",
        returnTo: "https://capsule.example/after",
      });
      const firstResponse = responseRecorder();
      await routeSporadesAuth(
        database,
        {
          method: "GET",
          url: `/__sporades/auth/facebook/callback?state=${new URL(firstStart.url).searchParams.get("state")}&code=first-code`,
          headers: {},
        },
        firstResponse,
      );
      assert.equal(firstResponse.statusCode, 302, firstResponse.body);
      const linkedFirst = await resolveAnonymousSession(database, firstSession.token);
      assert.equal(linkedFirst.auth.userId, firstSession.auth.userId);
      assert.equal(linkedFirst.auth.provider, "facebook");
      assert.equal(linkedFirst.auth.email, null);

      const returningGuest = await resolveAnonymousSession(database, null);
      const returningStart = await beginOAuthSignIn(database, returningGuest, "facebook", {
        origin: "https://capsule.example",
        returnTo: "https://capsule.example/after",
      });
      const returningResponse = responseRecorder();
      await routeSporadesAuth(
        database,
        {
          method: "GET",
          url: `/__sporades/auth/facebook/callback?state=${new URL(returningStart.url).searchParams.get("state")}&code=return-code`,
          headers: {},
        },
        returningResponse,
      );
      assert.equal(returningResponse.statusCode, 302, returningResponse.body);
      const linkedReturning = await resolveAnonymousSession(database, returningGuest.token);
      assert.equal(linkedReturning.auth.userId, firstSession.auth.userId);
      assert.equal(linkedReturning.auth.provider, "facebook");

      const persisted = database.sqlite.findAuthIdentityByProviderSubject("facebook", "returning-facebook-subject");
      assert.equal(persisted.email, null);
      assert.equal(persisted.displayName, "No Email Person");
      assert.doesNotMatch(JSON.stringify(persisted), /provider-access-token/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Facebook identity conflicts and transaction failures remain structured and provider-safe", async () => {
  await withFacebookDatabase(async (database) => {
    const owner = await resolveAnonymousSession(database, null);
    assert.equal((await linkProviderIdentity(database, owner, "facebook", {
      subject: "owned-facebook-subject",
      displayName: "Owner",
    })).ok, true);
    const challengerGuest = await resolveAnonymousSession(database, null);
    assert.equal((await linkProviderIdentity(database, challengerGuest, "email", {
      subject: "challenger",
      email: "challenger@example.com",
    })).ok, true);
    const challenger = await resolveAnonymousSession(database, challengerGuest.token);
    const conflict = await linkProviderIdentity(database, challenger, "facebook", {
      subject: "owned-facebook-subject",
      displayName: "Owner",
    });
    assert.equal(conflict.error.code, "AUTH_IDENTITY_CONFLICT");
    assert.match(conflict.error.message, /Facebook/);

    const session = await resolveAnonymousSession(database, null);
    database.__oauthProviderAdapters = {
      facebook: {
        enabled: true,
        responseMode: "query",
        begin: ({ state }) => ({ url: `https://provider.example/?state=${state}` }),
        complete: async () => ({ subject: "transaction-subject", displayName: "Person" }),
      },
    };
    const started = await beginOAuthSignIn(database, session, "facebook", {
      origin: "https://capsule.example",
      returnTo: "https://capsule.example/after",
    });
    const originalTransaction = database.sqlite.withTransaction;
    database.sqlite.withTransaction = async () => {
      throw new Error("raw-database-secret");
    };
    try {
      const response = responseRecorder();
      await routeSporadesAuth(
        database,
        {
          method: "GET",
          url: `/__sporades/auth/facebook/callback?state=${new URL(started.url).searchParams.get("state")}&code=code`,
          headers: {},
        },
        response,
      );
      assert.match(response.body, /AUTH_TRANSACTION_FAILED/);
      assert.doesNotMatch(response.body, /raw-database-secret/);
    } finally {
      database.sqlite.withTransaction = originalTransaction;
    }
  });
});
