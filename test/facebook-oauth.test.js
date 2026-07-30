import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  openDevDatabase,
  resolveAnonymousSession,
  routeSporadesAuth,
  SERVER_RUNTIME_SOURCE_FUNCTIONS,
} from "../dist/server-runtime-source.js";

const beginOAuthSignIn = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "beginOAuthSignIn");
const oauthProviderAdapter = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "oauthProviderAdapter");
const linkProviderIdentity = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "linkProviderIdentity");

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
    } finally {
      globalThis.fetch = originalFetch;
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
