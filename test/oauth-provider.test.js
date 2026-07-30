import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  openDevDatabase,
  resolveAnonymousSession,
  routeSporadesAuth,
  SERVER_RUNTIME_SOURCE_FUNCTIONS,
} from "../dist/server-runtime-source.js";

const beginOAuthSignIn = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "beginOAuthSignIn");
const verifyGoogleIdentityToken = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "verifyGoogleIdentityToken");

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
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
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
