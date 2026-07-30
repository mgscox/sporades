import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import test from "node:test";

import {
  openDevDatabase,
  resolveAnonymousSession,
  routeSporadesAuth,
  SERVER_RUNTIME_SOURCE_FUNCTIONS,
} from "../dist/server-runtime-source.js";

const beginOAuthSignIn = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "beginOAuthSignIn");
const verifyGoogleIdentityToken = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "verifyGoogleIdentityToken");
const verifyAppleIdentityToken = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "verifyAppleIdentityToken");
const createAppleClientSecret = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "createAppleClientSecret");
const appleOAuthOriginEligible = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "appleOAuthOriginEligible");
const resolveOAuthRequestOrigin = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "resolveOAuthRequestOrigin");
const linkProviderIdentity = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "linkProviderIdentity");

async function withTempDatabase(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-oauth-provider-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
    auth: { providers: { anonymous: true } },
  });
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
    const stored = database.sqlite.prepare("SELECT * FROM sporades_auth_oauth_states WHERE state = ?").get(queryState);
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
    assert.equal(database.sqlite.readAuthSessionWithUser(querySession.token).provider, "query");

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
    assert.equal(database.sqlite.readAuthSessionWithUser(formSession.token).provider, "form");
    assert.equal(completions.length, 2);
    assert.equal(completions[0].provider, "query");
    assert.ok(completions[0].nonce);
    assert.ok(completions[0].pkceVerifier);
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
      },
      {
        provider: "alpha",
        mutate(database, state) {
          database.sqlite.prepare("UPDATE sporades_auth_oauth_states SET expiresAt = ? WHERE state = ?")
            .run(new Date(Date.now() - 1_000).toISOString(), state);
        },
        query: "code=expired",
        code: "OAUTH_STATE_EXPIRED",
      },
      {
        provider: "alpha",
        query: "error=access_denied&error_description=sensitive-provider-detail",
        code: "OAUTH_PROVIDER_CANCELLED",
      },
      {
        provider: "failing",
        query: "code=exchange-failure",
        code: "Endpoint handler failed",
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
      assert.equal(response.statusCode, 500);
      assert.match(response.body, new RegExp(testCase.code));
      assert.doesNotMatch(response.body, /sensitive-provider-detail|leaked secret/);
      assert.equal(
        database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state),
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

test("Google identity tokens require signature, issuer, audience, expiry, nonce, and subject", async () => {
  await withTempDatabase(async (database) => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { privateKey: attackerKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = "test-key";
    const jwk = publicKey.export({ format: "jwk" });
    jwk.kid = kid;
    jwk.alg = "RS256";
    jwk.use = "sig";
    database.authConfig.google.clientIdEnv = "GOOGLE_CLIENT_ID";
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
      assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM sporades_auth_oauth_states").get().count, 0);
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
      database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(authorization.searchParams.get("state")),
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
      database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(cancelledState),
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
    assert.equal(database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state), undefined);

    for (const ambiguous of [
      "error=access_denied&error=user_cancelled",
      "code=one&user=%7B%7D&user=%7B%7D",
    ]) {
      state = await start();
      response = await callback(`state=${state}&${ambiguous}`);
      assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
      assert.equal(database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state), undefined);
    }

    state = await start();
    response = await callback(`state=${state}&code=one&error=access_denied`);
    assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
    assert.equal(database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state), undefined);

    state = await start();
    response = await callback(`state=${state}&state=other&code=one`);
    assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
    assert.ok(database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state));

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
      assert.ok(database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state));
    }

    state = await start();
    response = await callback(`state=${state}&code=%GG`);
    assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
    assert.equal(database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state), undefined);

    for (const encodedControl of ["%00", "%01", "%09", "%0D", "%7F", "%C2%80"]) {
      for (const field of ["code", "error", "user"]) {
        state = await start();
        response = await callback(`state=${state}&${field}=${encodedControl}`);
        assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
        assert.equal(database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state), undefined);
      }
      state = await start();
      response = await callback(`state=${encodedControl}&code=one`);
      assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
      assert.ok(database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state));

      state = await start();
      response = await callback(`state=${state}&co${encodedControl}de=one`);
      assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
      assert.ok(database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state));
    }

    for (const rawControl of [0x00, 0x01, 0x09, 0x0d, 0x7f]) {
      state = await start();
      response = await callback(Buffer.concat([
        Buffer.from(`state=${state}&code=`),
        Buffer.from([rawControl]),
      ]));
      assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
      assert.equal(database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state), undefined);
    }

    for (const invalidUtf8 of [Buffer.from([0xc3, 0x28]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80])]) {
      state = await start();
      response = await callback(Buffer.concat([Buffer.from(`state=${state}&code=`), invalidUtf8]));
      assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
      assert.equal(database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state), undefined);

      state = await start();
      response = await callback(Buffer.concat([Buffer.from("state="), invalidUtf8, Buffer.from("&code=one")]));
      assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
      assert.ok(database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state));
    }

    state = await start();
    response = await callback(`state=${state}&co%00de=one`);
    assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
    assert.ok(database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state));

    state = await start();
    response = await callback(`state=${state}&code=%C3%28`);
    assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
    assert.equal(database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state), undefined);

    for (const forbiddenScalar of ["%EF%BF%BD", "%EF%B7%90", "%F0%9F%BF%BE"]) {
      state = await start();
      response = await callback(`state=${state}&code=${forbiddenScalar}`);
      assert.match(response.body, /OAUTH_INVALID_CALLBACK/);
      assert.equal(database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state), undefined);
    }

    state = await start();
    response = await callback(`state=${state}&code=${"x".repeat(17 * 1024)}`);
    assert.equal(response.statusCode, 413);
    assert.ok(database.sqlite.prepare("SELECT state FROM sporades_auth_oauth_states WHERE state = ?").get(state));

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
          (error) => error.code?.startsWith("OAUTH_ID_TOKEN_"),
        );
      }

      globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk], padding: "x".repeat(70 * 1024) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      await assert.rejects(
        verifyAppleIdentityToken(database, signedJwt(privateKey, kid, claims), "expected-nonce"),
        (error) => error.code === "OAUTH_ID_TOKEN_KEYS_UNAVAILABLE",
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
      expectedNonce = database.sqlite.prepare("SELECT nonce FROM sporades_auth_oauth_states WHERE state = ?").get(firstState).nonce;
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

      const firstSession = database.sqlite.readAuthSessionWithUser(firstGuest.token);
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
      expectedNonce = database.sqlite.prepare("SELECT nonce FROM sporades_auth_oauth_states WHERE state = ?").get(returningState).nonce;
      const returningResponse = responseRecorder();
      await routeSporadesAuth(database, formPostRequest("/__sporades/auth/apple/callback", {
        state: returningState,
        code: "return-code",
      }), returningResponse);
      assert.equal(returningResponse.statusCode, 302, returningResponse.body);
      const returningSession = database.sqlite.readAuthSessionWithUser(returningGuest.token);
      assert.equal(returningSession.provider, "apple");
      assert.equal(returningSession.userId, firstGuest.auth.userId);
      assert.equal(returningSession.displayName, "Zoë 张");
      assert.equal(returningSession.email, "relay@privaterelay.appleid.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
