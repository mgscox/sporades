import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { capsule, endpoint, mutation, query, requireAuth, String as StringField, table } from "../dist/server.js";
import { createAccessKeySecret, readAccessKeyAuthorization } from "../dist/access-keys-runtime.js";
import { deleteCurrentAuthUser, unlinkCurrentAuthUser } from "../dist/auth-runtime.js";
import { openDevDatabase, routeEndpoint, runClientAccessKeyOperation, runMutation, runQuery } from "../dist/server-runtime-source.js";

function linkedAuth(userId = "access-key-owner") {
  return {
    userId,
    displayName: "Access Key Owner",
    email: "owner@example.com",
    picture: null,
    isAuthenticated: true,
    isGuest: false,
    provider: "email",
  };
}

async function requestEndpoint(database, pathName, options = {}) {
  const headers = Object.fromEntries(Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  const rawHeaders = Object.entries(options.headers ?? {}).flatMap(([name, value]) => [name, value]);
  const request = {
    url: pathName,
    method: options.method ?? "GET",
    headers,
    rawHeaders,
    socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" },
    async *[Symbol.asyncIterator]() {},
  };
  const responseHeaders = {};
  const response = {
    status: null,
    body: "",
    setHeader(name, value) { responseHeaders[name.toLowerCase()] = value; },
    writeHead(status, nextHeaders = {}) {
      this.status = status;
      Object.assign(responseHeaders, Object.fromEntries(Object.entries(nextHeaders).map(([name, value]) => [name.toLowerCase(), value])));
    },
    end(body = "") { this.body = String(body); },
  };
  assert.equal(await routeEndpoint(database, request, response), true);
  return {
    status: response.status,
    headers: { get: (name) => responseHeaders[name.toLowerCase()] ?? null },
    json: async () => JSON.parse(response.body),
  };
}

async function seedLinkedUser(database, auth = linkedAuth()) {
  await database.adapter.insertAuthUser({
    id: auth.userId,
    createdAt: "2026-08-20T12:00:00.000Z",
    displayName: auth.displayName,
    email: auth.email,
    picture: auth.picture,
    isAuthenticated: 1,
    isGuest: 0,
    provider: auth.provider,
  });
  return auth;
}

function storedAccessKey(ownerUserId, id, name, selector) {
  return {
    id,
    ownerUserId,
    name,
    reservedName: name,
    grantsJson: JSON.stringify(["requests:read"]),
    secretVersion: 1,
    selector,
    verifierDigest: "ab".repeat(32),
    lifecycleRevision: 1,
    createdAt: "2026-08-20T12:00:00.000Z",
    expiresAt: null,
  };
}

test("owner unlink and deletion retire keys atomically and relinking never revives them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-access-key-owner-transition-"));
  const definition = capsule({ name: "access-key-owner-transition", accessKeys: { scopes: ["requests:read"] } });
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
    name: definition.name,
    auth: { providers: { email: { enabled: true } } },
  }, definition, {
    clock: { now: () => new Date("2026-08-20T12:00:00.000Z") },
  });
  try {
    const auth = await seedLinkedUser(database, linkedAuth("transition-owner"));
    const first = storedAccessKey(auth.userId, "transition-key-unlinked", "unlink-key", "unlinkselector000000000");
    assert.deepEqual(await database.adapter.withTransaction((tx) => tx.issueAccessKeyRecord(first)), { status: "issued" });

    for (const deniedContext of [
      { kind: "mutation", auth, credential: { kind: "access-key", id: first.id, name: first.name } },
      { kind: "mutation", auth },
      { kind: "job", auth, credential: { kind: "session" } },
      { kind: "lifecycle", auth, credential: { kind: "session" } },
    ]) {
      await assert.rejects(unlinkCurrentAuthUser(database, deniedContext), (error) => error.code === "FORBIDDEN");
      await assert.rejects(deleteCurrentAuthUser(database, deniedContext), (error) => error.code === "FORBIDDEN");
      assert.equal((await database.adapter.findAccessKeyAuthenticationRecord(first.selector)).id, first.id);
    }

    await database.adapter.insertEmailCredential({
      email: auth.email,
      userId: auth.userId,
      passwordHash: "dormant-hash",
      passwordSalt: "dormant-salt",
      createdAt: "2026-08-20T12:00:00.000Z",
    });
    await database.adapter.insertPasswordResetCode({
      selector: "dormant-reset-code",
      verifierHash: "dormant-reset-hash",
      email: auth.email,
      userId: auth.userId,
      createdAt: "2026-08-20T12:00:00.000Z",
      expiresAt: "2026-08-20T13:00:00.000Z",
    });
    database.authConfig.providers.email.enabled = false;

    const ownerContext = { kind: "mutation", auth, credential: { kind: "session" } };
    await unlinkCurrentAuthUser(database, ownerContext);
    const unlinked = (await database.adapter.listAccessKeyRecordsForOwner(auth.userId))[0];
    assert.equal(unlinked.revocationCause, "owner-unlinked");
    assert.equal(await database.adapter.findAccessKeyAuthenticationRecord(first.selector), null);
    assert.equal(await database.adapter.emailCredentialExists(auth.email), false);
    assert.equal(await database.adapter.findPasswordResetCode("dormant-reset-code"), null);

    await database.adapter.linkAuthUser({ ...auth, id: auth.userId, isAuthenticated: 1, isGuest: 0 });
    const stillRetired = (await database.adapter.listAccessKeyRecordsForOwner(auth.userId))[0];
    assert.equal(stillRetired.revocationCause, "owner-unlinked");
    assert.equal(await database.adapter.findAccessKeyAuthenticationRecord(first.selector), null);

    const second = storedAccessKey(auth.userId, "transition-key-deleted", "delete-key", "deleteselector000000000");
    assert.deepEqual(await database.adapter.withTransaction((tx) => tx.issueAccessKeyRecord(second)), { status: "issued" });
    await deleteCurrentAuthUser(database, ownerContext);

    const history = await database.adapter.listAccessKeyRecordsForOwner(auth.userId);
    assert.equal(history.find((row) => row.id === first.id).revocationCause, "owner-unlinked");
    assert.equal(history.find((row) => row.id === second.id).revocationCause, "owner-deleted");
    assert.equal(await database.adapter.findAccessKeyAuthenticationRecord(second.selector), null);
    const events = (await database.log.tail(50)).filter((event) => event.event === "access-key.revoked");
    assert.deepEqual(events.map((event) => ({ actor: event.data.actor, target: event.data.target, cause: event.data.revocationCause })), [
      { actor: { userId: auth.userId }, target: { ownerUserId: auth.userId }, cause: "owner-unlinked" },
      { actor: { userId: auth.userId }, target: { ownerUserId: auth.userId }, cause: "owner-deleted" },
    ]);
    assert.equal(events.every((event) => event.data.credential?.kind === "session"), true);
    assert.deepEqual(events.map((event) => event.data.operation), ["auth.unlinkCurrentUser", "auth.deleteCurrentUser"]);
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a linked Session issues, lists, and revokes its own scoped Access key", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-access-key-owner-"));
  const definition = capsule({
    name: "access-key-owner",
    accessKeys: { scopes: ["requests:read", "requests:write", "profile:read"] },
    queries: {
      listKeys: query((ctx) => ctx.accessKeys.list()),
      issueKeyFromQuery: query((ctx) => ctx.accessKeys.issue({ name: "query-audit-failure-key" })),
    },
    mutations: {
      issueKey: mutation((ctx, input) => ctx.accessKeys.issue(input)),
      revokeKey: mutation((ctx, id) => ctx.accessKeys.revoke(id)),
      issueThenFail: mutation(async (ctx) => {
        await ctx.accessKeys.issue({ name: "rolled-back-key" });
        throw new Error("rollback after issue");
      }),
      revokeThenFail: mutation(async (ctx, id) => {
        await ctx.accessKeys.revoke(id);
        throw new Error("rollback after revoke");
      }),
      inspectPrivilegedProjection: mutation((ctx) => ctx.privileged.run(
        { operation: "access-keys.inspect-projection", targetResourceKind: "access-key" },
        (privilegedCtx) => ({ methods: Object.keys(privilegedCtx.accessKeys).sort() }),
      )),
    },
    endpoints: {
      middlewareIssue: endpoint(
        { method: "GET", path: "/middleware-issue" },
        requireAuth({ credentials: ["session"] }, (ctx) => ({ body: { token: ctx.issuedToken } })),
      ),
    },
  });
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: definition.name }, definition, {
    clock: { now: () => new Date("2026-08-20T12:00:00.000Z") },
  });
  try {
    const auth = await seedLinkedUser(database);
    const issued = await runMutation(database, auth, "issueKey", [{
      name: "request-bot",
      grants: ["requests:*", "profile:read"],
      expiresAt: "2026-09-20T12:00:00.000Z",
    }]);
    assert.equal(issued.error, null, JSON.stringify(issued.error));
    assert.match(issued.data.token, /^spk_1_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(issued.data.accessKey, {
      id: issued.data.accessKey.id,
      name: "request-bot",
      grants: ["profile:read", "requests:*"],
      effectiveScopes: ["profile:read", "requests:read", "requests:write"],
      status: "active",
      createdAt: "2026-08-20T12:00:00.000Z",
      expiresAt: "2026-09-20T12:00:00.000Z",
      rotatedAt: null,
      revokedAt: null,
      revocationCause: null,
      lastUsedAt: null,
      lifecycleRevision: 1,
    });

    const listed = await runQuery(database, auth, "listKeys");
    assert.equal(listed.error, null, JSON.stringify(listed.error));
    assert.equal(JSON.stringify(listed.data).includes(issued.data.token), false);
    assert.deepEqual(listed.data, {
      accessKeys: [issued.data.accessKey],
      declaredScopes: ["profile:read", "requests:read", "requests:write"],
      nextCursor: null,
      totalCount: 1,
    });

    const failedIssue = await runMutation(database, auth, "issueThenFail", []);
    assert.equal(failedIssue.error.message, "rollback after issue");
    assert.equal((await runQuery(database, auth, "listKeys")).data.accessKeys.some((key) => key.name === "rolled-back-key"), false);

    const failedRevoke = await runMutation(database, auth, "revokeThenFail", [issued.data.accessKey.id]);
    assert.equal(failedRevoke.error.message, "rollback after revoke");
    assert.equal((await runQuery(database, auth, "listKeys")).data.accessKeys[0].status, "active");

    const revoked = await runMutation(database, auth, "revokeKey", [issued.data.accessKey.id]);
    assert.equal(revoked.error, null, JSON.stringify(revoked.error));
    assert.equal(revoked.data.accessKey.status, "revoked");
    assert.equal(revoked.data.accessKey.revocationCause, "owner");
    assert.equal(revoked.data.accessKey.lifecycleRevision, 2);
    assert.equal(revoked.data.accessKey.revokedAt, "2026-08-20T12:00:00.000Z");

    const after = await runQuery(database, auth, "listKeys");
    assert.equal(after.data.accessKeys[0].status, "revoked");
    assert.equal("token" in after.data.accessKeys[0], false);

    const privilegedProjection = await runMutation(database, auth, "inspectPrivilegedProjection", []);
    assert.equal(privilegedProjection.error, null, JSON.stringify(privilegedProjection.error));
    assert.deepEqual(privilegedProjection.data, { methods: ["delete", "inspect", "list", "revoke", "revokeAll"] });

    const lifecycleEvents = await database.log.tail(50);
    assert.equal(lifecycleEvents.some((event) => event.data?.accessKey?.name === "rolled-back-key"), false);
    assert.equal(lifecycleEvents.filter((event) => event.event === "access-key.issued").length, 1);
    assert.equal(lifecycleEvents.filter((event) => event.event === "access-key.revoked").length, 1);
    const issuedEvent = lifecycleEvents.find((event) => event.event === "access-key.issued");
    assert.deepEqual(issuedEvent.data, {
      operation: "accessKeys.issue",
      executionSource: "server-context",
      outcome: "succeeded",
      actor: { userId: auth.userId },
      credential: { kind: "session" },
      accessKey: { id: issued.data.accessKey.id, name: "request-bot", grants: ["profile:read", "requests:*"] },
    });
    const revokedEvent = lifecycleEvents.find((event) => event.event === "access-key.revoked");
    assert.deepEqual(revokedEvent.data, {
      operation: "accessKeys.revoke",
      executionSource: "server-context",
      outcome: "succeeded",
      actor: { userId: auth.userId },
      credential: { kind: "session" },
      accessKey: { id: issued.data.accessKey.id, name: "request-bot" },
    });

    const originalLogEmit = database.log.emit;
    database.log.emit = () => { throw new Error("simulated post-commit audit failure"); };
    let issuedDespiteAuditFailure;
    try {
      issuedDespiteAuditFailure = await runMutation(database, auth, "issueKey", [{ name: "audit-failure-key" }]);
    } finally {
      database.log.emit = originalLogEmit;
    }
    assert.equal(issuedDespiteAuditFailure.error, null, JSON.stringify(issuedDespiteAuditFailure.error));
    assert.match(issuedDespiteAuditFailure.data.token, /^spk_1_/);
    assert.equal(
      (await runQuery(database, auth, "listKeys")).data.accessKeys.some((key) => key.id === issuedDespiteAuditFailure.data.accessKey.id),
      true,
    );

    database.log.emit = async () => { throw new Error("simulated async direct audit failure"); };
    let queryIssuedDespiteAuditFailure;
    try {
      queryIssuedDespiteAuditFailure = await runQuery(database, auth, "issueKeyFromQuery");
    } finally {
      database.log.emit = originalLogEmit;
    }
    assert.equal(queryIssuedDespiteAuditFailure.error, null, JSON.stringify(queryIssuedDespiteAuditFailure.error));
    assert.match(queryIssuedDespiteAuditFailure.data.token, /^spk_1_/);
    assert.equal(
      (await runQuery(database, auth, "listKeys")).data.accessKeys.some((key) => key.id === queryIssuedDespiteAuditFailure.data.accessKey.id),
      true,
    );

    await database.adapter.insertAuthSession({
      token: "middleware-session",
      userId: auth.userId,
      provider: "email",
      createdAt: "2026-08-20T12:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    database.contextMiddleware = [`async (ctx) => {
      const issued = await ctx.accessKeys.issue({ name: "middleware-issued-key" });
      return {
        auth: ctx.auth,
        credential: ctx.credential,
        issuedToken: issued.token,
        __accessKeyLifecycleAuditEvents: [],
        __sporadesSecretDisclosed: false,
      };
    }`];
    const middlewareIssued = await requestEndpoint(database, "/middleware-issue", {
      headers: { "x-sporades-session-token": "middleware-session" },
    });
    database.contextMiddleware = [];
    assert.equal(middlewareIssued.status, 200);
    assert.equal(middlewareIssued.headers.get("cache-control"), "private, no-store");
    assert.match((await middlewareIssued.json()).token, /^spk_1_/);
    assert.equal(
      (await database.log.tail(50)).some((event) => event.event === "access-key.issued" && event.data?.accessKey?.name === "middleware-issued-key"),
      true,
    );
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a guarded endpoint admits, attributes, scopes, and revokes a Bearer Access key", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-access-key-http-"));
  const definition = capsule({
    name: "access-key-http",
    accessKeys: { scopes: ["requests:read", "requests:write"] },
    schema: {
      protectedRecords: table({ text: StringField() }).acl({ insert: () => false }),
    },
    mutations: {
      issueKey: mutation((ctx, input) => ctx.accessKeys.issue(input)),
      revokeKey: mutation((ctx, id) => ctx.accessKeys.revoke(id)),
    },
    endpoints: {
      read: endpoint(
        { method: "GET", path: "/requests" },
        requireAuth({ credentials: ["access-key"], scopes: ["requests:read"] }, (ctx) => ({
          body: {
            auth: ctx.auth,
            credential: ctx.credential,
            credentialFrozen: Object.isFrozen(ctx.credential),
            authorizationVisible: "authorization" in ctx.request.headers,
          },
        })),
      ),
      write: endpoint(
        { method: "POST", path: "/requests" },
        requireAuth({ credentials: ["access-key"], scopes: ["requests:write"] }, () => ({ body: { ok: true } })),
      ),
      unwrapped: endpoint({ method: "GET", path: "/webhook" }, (ctx) => ({
        body: { provider: ctx.auth.provider, authorization: ctx.request.headers.authorization },
      })),
      sessionOnlyInline: endpoint({ method: "GET", path: "/session-only-inline" }, (ctx) => ({
        body: requireAuth(ctx),
      })),
      ownerApiDenied: endpoint(
        { method: "GET", path: "/owner-keys" },
        requireAuth({ credentials: ["access-key"], scopes: ["requests:read"] }, async (ctx) => ({
          body: await ctx.accessKeys.list(),
        })),
      ),
      attributedLog: endpoint(
        { method: "GET", path: "/attributed-log" },
        requireAuth({ credentials: ["access-key"], scopes: ["requests:read"] }, (ctx) => {
          ctx.log.info("access-key Capsule work", {
            actor: { userId: "forged-user" },
            credential: { kind: "session" },
            detail: "retained",
          });
          return { body: { ok: true } };
        }),
      ),
      aclDenied: endpoint(
        { method: "POST", path: "/acl-denied" },
        requireAuth({ credentials: ["access-key"], scopes: ["requests:read"] }, (ctx) => {
          ctx.db.protectedRecords.insert({ text: "blocked" });
          return { body: { ok: true } };
        }),
      ),
      handlerFailure: endpoint(
        { method: "GET", path: "/handler-failure" },
        requireAuth({ credentials: ["access-key"], scopes: ["requests:read"] }, () => {
          throw new Error("simulated admitted handler failure");
        }),
      ),
    },
  });
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: definition.name }, definition);
  try {
    const auth = await seedLinkedUser(database);
    const issued = await runMutation(database, auth, "issueKey", [{ name: "reader", grants: ["requests:read"] }]);
    assert.equal(issued.error, null, JSON.stringify(issued.error));
    globalThis.__accessKeyMiddlewareObserved = [];
    database.contextMiddleware = [`(ctx) => {
      globalThis.__accessKeyMiddlewareObserved.push({
        provider: ctx.auth.provider,
        credential: ctx.credential,
        authorizationVisible: "authorization" in ctx.request.headers,
      });
      return ctx;
    }`];

    const admitted = await requestEndpoint(database, "/requests", {
      headers: { authorization: `Bearer ${issued.data.token}` },
    });
    assert.equal(admitted.status, 200);
    assert.equal(admitted.headers.get("cache-control"), "private, no-store");
    const admittedBody = await admitted.json();
    assert.deepEqual(admittedBody.auth, {
      userId: auth.userId,
      displayName: auth.displayName,
      email: auth.email,
      picture: null,
      isAuthenticated: true,
      isGuest: false,
      provider: "access-key",
    });
    assert.deepEqual(admittedBody.credential, { kind: "access-key", id: issued.data.accessKey.id, name: "reader" });
    assert.equal(admittedBody.credentialFrozen, true);
    assert.equal(admittedBody.authorizationVisible, false);
    assert.deepEqual(globalThis.__accessKeyMiddlewareObserved[0], {
      provider: "access-key",
      credential: { kind: "access-key", id: issued.data.accessKey.id, name: "reader" },
      authorizationVisible: false,
    });
    const usedRow = await database.adapter.prepare(database.adapter.dialect.sql(
      "SELECT [lastUsedAt] FROM [sporades_auth_access_keys] WHERE [id] = ?",
    )).get(issued.data.accessKey.id);
    assert.match(usedRow.lastUsedAt, /^\d{4}-\d{2}-\d{2}T/);

    const attributed = await requestEndpoint(database, "/attributed-log", {
      headers: { authorization: `Bearer ${issued.data.token}` },
    });
    assert.equal(attributed.status, 200);
    const attributedEvent = (await database.log.tail(50)).find((event) => event.message === "access-key Capsule work");
    assert.deepEqual(attributedEvent.data, {
      actor: { userId: auth.userId },
      credential: { kind: "access-key", id: issued.data.accessKey.id, name: "reader" },
      detail: "retained",
    });

    const ownerApiDenied = await requestEndpoint(database, "/owner-keys", {
      headers: { authorization: `Bearer ${issued.data.token}` },
    });
    assert.equal(ownerApiDenied.status, 403);
    assert.equal((await ownerApiDenied.json()).error.code, "FORBIDDEN");

    const insufficient = await requestEndpoint(database, "/requests", {
      method: "POST",
      headers: { authorization: `Bearer ${issued.data.token}` },
    });
    assert.equal(insufficient.status, 403);
    assert.equal(insufficient.headers.get("cache-control"), "no-store");
    assert.equal((await insufficient.json()).error.code, "FORBIDDEN");

    const aclDenied = await requestEndpoint(database, "/acl-denied", {
      method: "POST",
      headers: { authorization: `Bearer ${issued.data.token}` },
    });
    assert.equal(aclDenied.status, 500);
    const handlerFailure = await requestEndpoint(database, "/handler-failure", {
      headers: { authorization: `Bearer ${issued.data.token}` },
    });
    assert.equal(handlerFailure.status, 500);
    const denialEvents = await database.log.tail(100);
    const scopeDenialEvent = denialEvents.find((candidate) => candidate.event === "auth.denied" && candidate.data?.requirement === "scope");
    assert.ok(scopeDenialEvent, JSON.stringify(denialEvents));
    assert.equal("credential" in scopeDenialEvent.data, false);
    for (const event of [
      denialEvents.find((candidate) => candidate.event === "acl.denied" && candidate.data?.resource?.name === "protectedRecords"),
      denialEvents.find((candidate) => candidate.event === "http.request.failed" && candidate.request?.path === "/handler-failure"),
    ]) {
      assert.ok(event, JSON.stringify(denialEvents));
      assert.deepEqual(event.data.credential, { kind: "access-key", id: issued.data.accessKey.id, name: "reader" });
    }

    const missing = await requestEndpoint(database, "/requests");
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get("www-authenticate"), 'Bearer realm="sporades"');

    const unrelatedSessionDenial = await requestEndpoint(database, "/session-only-inline");
    assert.equal(unrelatedSessionDenial.status, 401);
    assert.equal(unrelatedSessionDenial.headers.get("www-authenticate"), null);

    const previousSecuritySession = database.securitySession;
    database.securitySession = "hosted";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const hostileClient = await requestEndpoint(database, "/requests", {
        remoteAddress: "127.0.0.1",
        headers: {
          authorization: `Bearer malformed-${attempt}`,
          "x-sporades-client-address": "198.51.100.10",
        },
      });
      assert.equal(hostileClient.status, 401);
    }
    const independentHostedClient = await requestEndpoint(database, "/requests", {
      remoteAddress: "127.0.0.1",
      headers: {
        authorization: `Bearer ${issued.data.token}`,
        "x-sporades-client-address": "198.51.100.11",
      },
    });
    assert.equal(independentHostedClient.status, 200,
      "one Hosted client must not exhaust the shared reverse-proxy source bucket");
    database.securitySession = previousSecuritySession;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const directClient = await requestEndpoint(database, "/requests", {
        remoteAddress: "192.0.2.20",
        headers: {
          authorization: `Bearer malformed-direct-${attempt}`,
          "x-sporades-client-address": `198.51.100.${attempt + 20}`,
        },
      });
      assert.equal(directClient.status, 401);
    }
    const spoofedDirectClient = await requestEndpoint(database, "/requests", {
      remoteAddress: "192.0.2.20",
      headers: {
        authorization: `Bearer ${issued.data.token}`,
        "x-sporades-client-address": "203.0.113.200",
      },
    });
    assert.equal(spoofedDirectClient.status, 429,
      "non-Hosted clients must not evade throttling with the private proxy header");

    const malformed = await requestEndpoint(database, "/requests", {
      headers: { authorization: "Bearer definitely-not-a-sporades-key" },
    });
    assert.equal(malformed.status, 401);
    assert.equal(malformed.headers.get("www-authenticate"), 'Bearer realm="sporades", error="invalid_token"');

    const dual = await requestEndpoint(database, "/requests", {
      headers: {
        authorization: `Bearer ${issued.data.token}`,
        "x-sporades-session-token": "simultaneous-session-credential",
      },
    });
    assert.equal(dual.status, 401);
    assert.equal((await dual.json()).error.code, "UNAUTHENTICATED");

    await database.adapter.prepare(database.adapter.dialect.sql(
      "UPDATE [sporades_auth_access_keys] SET [expiresAt] = ? WHERE [id] = ?",
    )).run("2000-01-01T00:00:00.000Z", issued.data.accessKey.id);
    const expired = await requestEndpoint(database, "/requests", {
      headers: { authorization: `Bearer ${issued.data.token}` },
    });
    assert.equal(expired.status, 401);
    await database.adapter.prepare(database.adapter.dialect.sql(
      "UPDATE [sporades_auth_access_keys] SET [expiresAt] = NULL WHERE [id] = ?",
    )).run(issued.data.accessKey.id);

    await database.adapter.updateAuthUserProfile({
      id: auth.userId,
      displayName: auth.displayName,
      picture: null,
      isAuthenticated: 1,
      isGuest: 1,
    });
    const ineligibleOwner = await requestEndpoint(database, "/requests", {
      headers: { authorization: `Bearer ${issued.data.token}` },
    });
    assert.equal(ineligibleOwner.status, 401);
    await database.adapter.updateAuthUserProfile({
      id: auth.userId,
      displayName: auth.displayName,
      picture: null,
      isAuthenticated: 1,
      isGuest: 0,
    });

    const unknown = createAccessKeySecret();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const invalid = await requestEndpoint(database, "/requests", {
        headers: { authorization: `Bearer ${unknown.token}` },
      });
      assert.equal(invalid.status, 401);
    }
    const limited = await requestEndpoint(database, "/requests", {
      headers: { authorization: `Bearer ${unknown.token}` },
    });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("cache-control"), "no-store");
    assert.equal((await limited.json()).error.code, "RATE_LIMITED");

    const unwrapped = await requestEndpoint(database, "/webhook", {
      headers: { authorization: `Bearer ${issued.data.token}` },
    });
    assert.equal(unwrapped.status, 200);
    assert.deepEqual(await unwrapped.json(), { provider: "anonymous", authorization: `Bearer ${issued.data.token}` });

    database.contextMiddleware = [];
    const revoked = await runMutation(database, auth, "revokeKey", [issued.data.accessKey.id]);
    assert.equal(revoked.error, null, JSON.stringify(revoked.error));
    const denied = await requestEndpoint(database, "/requests", {
      headers: { authorization: `Bearer ${issued.data.token}` },
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("www-authenticate"), 'Bearer realm="sporades", error="invalid_token"');
    assert.equal(denied.headers.get("cache-control"), "no-store");
    assert.equal((await denied.json()).error.code, "UNAUTHENTICATED");
  } finally {
    delete globalThis.__accessKeyMiddlewareObserved;
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Access-key admission and coalesced best-effort usage telemetry stay outside Capsule work transactions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-access-key-admission-boundary-"));
  const definition = capsule({
    name: "access-key-admission-boundary",
    accessKeys: { scopes: ["requests:read"] },
    mutations: { issueKey: mutation((ctx) => ctx.accessKeys.issue({ name: "reader" })) },
    endpoints: {
      read: endpoint(
        { method: "GET", path: "/requests" },
        requireAuth({ credentials: ["access-key"], scopes: ["requests:read"] }, () => ({ body: { ok: true } })),
      ),
    },
  });
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: definition.name }, definition);
  try {
    const auth = await seedLinkedUser(database);
    const issued = await runMutation(database, auth, "issueKey", []);
    assert.equal(issued.error, null, JSON.stringify(issued.error));

    let transactionDepth = 0;
    let lookupCount = 0;
    let touchCount = 0;
    const originalWithTransaction = database.adapter.withTransaction.bind(database.adapter);
    const originalLookup = database.adapter.findAccessKeyAuthenticationRecord.bind(database.adapter);
    database.adapter.withTransaction = (callback) => originalWithTransaction(async (adapter) => {
      transactionDepth += 1;
      try {
        return await callback(adapter);
      } finally {
        transactionDepth -= 1;
      }
    });
    database.adapter.findAccessKeyAuthenticationRecord = async (...args) => {
      assert.equal(transactionDepth, 0, "credential lookup must precede the Capsule work transaction");
      lookupCount += 1;
      return originalLookup(...args);
    };
    database.adapter.touchAccessKeyLastUsed = async () => {
      assert.equal(transactionDepth, 0, "usage telemetry must not share the Capsule work transaction");
      touchCount += 1;
      throw new Error("simulated telemetry failure");
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await requestEndpoint(database, "/requests", {
        headers: { authorization: `Bearer ${issued.data.token}` },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    }
    assert.equal(lookupCount, 2);
    assert.equal(touchCount, 1, "one process attempts at most one usage write per key per hour");
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("owners rotate, expire, revoke, delete, paginate, and recover immutable Access keys", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-access-key-lifecycle-"));
  let now = new Date("2026-08-20T12:00:00.000Z");
  const definition = capsule({
    name: "access-key-lifecycle",
    accessKeys: { scopes: ["requests:read"] },
    queries: { listKeys: query((ctx, options) => ctx.accessKeys.list(options)) },
    mutations: {
      issueKey: mutation((ctx, input) => ctx.accessKeys.issue(input)),
      rotateKey: mutation((ctx, id, options) => ctx.accessKeys.rotate(id, options)),
      revokeKey: mutation((ctx, id) => ctx.accessKeys.revoke(id)),
      deleteKey: mutation((ctx, id) => ctx.accessKeys.delete(id)),
    },
    endpoints: {
      read: endpoint(
        { method: "GET", path: "/read" },
        requireAuth({ credentials: ["access-key"], scopes: ["requests:read"] }, () => ({ body: { ok: true } })),
      ),
    },
  });
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: definition.name }, definition, {
    clock: { now: () => now },
  });
  try {
    const owner = await seedLinkedUser(database, linkedAuth("lifecycle-owner"));
    const other = await seedLinkedUser(database, { ...linkedAuth("lifecycle-other"), email: "other@example.com" });
    const issued = await runMutation(database, owner, "issueKey", [{
      name: "recoverable-key",
      grants: ["requests:read"],
      expiresAt: "2026-08-21T12:00:00.000Z",
    }]);
    assert.equal(issued.error, null, JSON.stringify(issued.error));

    now = new Date("2026-08-20T13:00:00.000Z");
    const rotated = await runMutation(database, owner, "rotateKey", [issued.data.accessKey.id, { lifecycleRevision: 1 }]);
    assert.equal(rotated.error, null, JSON.stringify(rotated.error));
    assert.notEqual(rotated.data.token, issued.data.token);
    assert.deepEqual(rotated.data.accessKey, {
      ...issued.data.accessKey,
      rotatedAt: now.toISOString(),
      lifecycleRevision: 2,
    });
    assert.equal((await requestEndpoint(database, "/read", { headers: { authorization: `Bearer ${issued.data.token}` } })).status, 401);
    assert.equal((await requestEndpoint(database, "/read", { headers: { authorization: `Bearer ${rotated.data.token}` } })).status, 200);

    const recoveredMetadata = await runQuery(database, owner, "listKeys", []);
    const recoveredRotation = await runMutation(database, owner, "rotateKey", [
      issued.data.accessKey.id,
      { lifecycleRevision: recoveredMetadata.data.accessKeys[0].lifecycleRevision },
    ]);
    assert.equal(recoveredRotation.error, null, JSON.stringify(recoveredRotation.error));
    assert.equal(recoveredRotation.data.accessKey.lifecycleRevision, 3);
    assert.equal((await requestEndpoint(database, "/read", { headers: { authorization: `Bearer ${rotated.data.token}` } })).status, 401);
    assert.equal((await requestEndpoint(database, "/read", { headers: { authorization: `Bearer ${recoveredRotation.data.token}` } })).status, 200);

    const stale = await runMutation(database, owner, "rotateKey", [issued.data.accessKey.id, { lifecycleRevision: 1 }]);
    assert.equal(stale.error.code, "ACCESS_KEY_REVISION_CONFLICT");
    const otherOwner = await runMutation(database, other, "rotateKey", [issued.data.accessKey.id, { lifecycleRevision: 3 }]);
    assert.equal(otherOwner.error.code, "ACCESS_KEY_NOT_FOUND");
    const activeDelete = await runMutation(database, owner, "deleteKey", [issued.data.accessKey.id]);
    assert.equal(activeDelete.error.code, "ACCESS_KEY_DELETE_REQUIRES_REVOKED");

    now = new Date("2026-08-21T12:00:00.000Z");
    const expiredList = await runQuery(database, owner, "listKeys", [{ status: "expired" }]);
    assert.equal(expiredList.data.totalCount, 1);
    assert.equal(expiredList.data.accessKeys[0].status, "expired");
    const expiredRotate = await runMutation(database, owner, "rotateKey", [issued.data.accessKey.id, { lifecycleRevision: 3 }]);
    assert.equal(expiredRotate.error.code, "ACCESS_KEY_NOT_ACTIVE");
    const duplicateExpiredName = await runMutation(database, owner, "issueKey", [{ name: "recoverable-key" }]);
    assert.equal(duplicateExpiredName.error.code, "ACCESS_KEY_NAME_CONFLICT");

    const revoked = await runMutation(database, owner, "revokeKey", [issued.data.accessKey.id]);
    assert.equal(revoked.data.accessKey.lifecycleRevision, 4);
    const revokedAgain = await runMutation(database, owner, "revokeKey", [issued.data.accessKey.id]);
    assert.deepEqual(revokedAgain.data, revoked.data);
    const reused = await runMutation(database, owner, "issueKey", [{ name: "recoverable-key" }]);
    assert.equal(reused.error, null, JSON.stringify(reused.error));

    now = new Date("2026-08-21T13:00:00.000Z");
    const second = await runMutation(database, owner, "issueKey", [{ name: "second-key" }]);
    now = new Date("2026-08-21T14:00:00.000Z");
    const third = await runMutation(database, owner, "issueKey", [{ name: "third-key" }]);
    const firstPage = await runQuery(database, owner, "listKeys", [{ limit: 2 }]);
    assert.equal(firstPage.data.accessKeys.length, 2);
    assert.equal(firstPage.data.totalCount, 4);
    assert.ok(firstPage.data.nextCursor);
    const secondPage = await runQuery(database, owner, "listKeys", [{ limit: 2, cursor: firstPage.data.nextCursor }]);
    assert.equal(secondPage.data.accessKeys.length, 2);
    assert.equal(new Set([...firstPage.data.accessKeys, ...secondPage.data.accessKeys].map((key) => key.id)).size, 4);

    const deleted = await runMutation(database, owner, "deleteKey", [issued.data.accessKey.id]);
    assert.deepEqual(deleted.data, { id: issued.data.accessKey.id, deleted: true });
    assert.equal((await runQuery(database, owner, "listKeys", [])).data.accessKeys.some((key) => key.id === issued.data.accessKey.id), false);
    assert.equal((await runMutation(database, other, "deleteKey", [reused.data.accessKey.id])).error.code, "ACCESS_KEY_NOT_FOUND");
    assert.ok(second.data.token && third.data.token);
    const lifecycleAudits = await database.log.tail(100);
    assert.equal(lifecycleAudits.filter((event) => event.event === "access-key.rotated" && event.data?.accessKey?.id === issued.data.accessKey.id).length, 2);
    assert.equal(lifecycleAudits.some((event) => event.event === "access-key.deleted" && event.data?.accessKey?.id === issued.data.accessKey.id), true);
    assert.equal(JSON.stringify(lifecycleAudits).includes(recoveredRotation.data.token), false);
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the Access-key bearer parser accepts only the fixed bounded wire form", () => {
  const secret = createAccessKeySecret();
  assert.deepEqual(
    readAccessKeyAuthorization({ rawHeaders: ["Authorization", `bearer ${secret.token}`] }),
    { token: secret.token, selector: secret.selector, verifier: secret.verifier },
  );
  assert.equal(readAccessKeyAuthorization({ rawHeaders: [] }), null);
  for (const value of [
    `Bearer ${secret.token}, Bearer ${secret.token}`,
    `Bearer ${secret.token}=`,
    `Bearer ${secret.token}\n`,
    `Bearer ${secret.token}_extra`,
    `Bearer SPK_1_${secret.selector}_${secret.verifier}`,
    `Basic ${secret.token}`,
  ]) {
    assert.throws(
      () => readAccessKeyAuthorization({ rawHeaders: ["Authorization", value] }),
      (error) => error.code === "UNAUTHENTICATED",
    );
  }
  assert.throws(
    () => readAccessKeyAuthorization({ rawHeaders: ["Authorization", `Bearer ${secret.token}`, "authorization", `Bearer ${secret.token}`] }),
    (error) => error.code === "UNAUTHENTICATED",
  );
});

test("owner operations validate immutable metadata, eligibility, and one-time secret storage", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-access-key-invariants-"));
  let now = new Date("2026-08-20T12:00:00.000Z");
  const definition = capsule({
    name: "access-key-invariants",
    accessKeys: { scopes: ["requests:read", "requests:write"] },
    mutations: { issueKey: mutation((ctx, input) => ctx.accessKeys.issue(input)) },
    queries: { listKeys: query((ctx) => ctx.accessKeys.list()) },
  });
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: definition.name }, definition, {
    clock: { now: () => now },
  });
  try {
    const auth = await seedLinkedUser(database);
    const wildcard = await runMutation(database, auth, "issueKey", [{ name: "default-grants" }]);
    assert.equal(wildcard.error, null, JSON.stringify(wildcard.error));
    assert.deepEqual(wildcard.data.accessKey.grants, ["*"]);
    assert.deepEqual(wildcard.data.accessKey.effectiveScopes, ["requests:read", "requests:write"]);

    const stored = await database.adapter.prepare(database.adapter.dialect.sql(
      "SELECT * FROM [sporades_auth_access_keys] WHERE [id] = ?",
    )).get(wildcard.data.accessKey.id);
    assert.equal(stored.selector.length, 22);
    assert.match(stored.verifierDigest, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(stored).includes(wildcard.data.token), false);
    assert.equal("token" in stored, false);
    assert.equal("verifier" in stored, false);

    const duplicate = await runMutation(database, auth, "issueKey", [{ name: "default-grants" }]);
    assert.equal(duplicate.error.code, "ACCESS_KEY_NAME_CONFLICT");
    const invalidGrant = await runMutation(database, auth, "issueKey", [{ name: "bad-grant", grants: ["undeclared:read"] }]);
    assert.equal(invalidGrant.error.code, "INVALID_ACCESS_KEY_GRANTS");
    const invalidExpiry = await runMutation(database, auth, "issueKey", [{ name: "bad-expiry", expiresAt: now.toISOString() }]);
    assert.equal(invalidExpiry.error.code, "INVALID_ACCESS_KEY_EXPIRY");

    const anonymous = await runMutation(database, {
      ...auth,
      userId: "anonymous-owner",
      isAuthenticated: false,
      isGuest: true,
      provider: "anonymous",
    }, "issueKey", [{ name: "anonymous-key" }]);
    assert.equal(anonymous.error.code, "UNAUTHENTICATED");
    const guest = await runMutation(database, { ...auth, isGuest: true, provider: "anonymous" }, "issueKey", [{ name: "guest-key" }]);
    assert.equal(guest.error.code, "FORBIDDEN");

    now = new Date("2026-08-20T13:00:00.000Z");
    const listed = await runQuery(database, auth, "listKeys");
    assert.equal(listed.error, null);
    assert.equal(JSON.stringify(listed.data).includes(wildcard.data.token), false);

    const originalWithTransaction = database.adapter.withTransaction;
    database.adapter.withTransaction = async () => {
      throw new Error("storage password=secret-db-detail");
    };
    let redactedFailure;
    try {
      redactedFailure = await runClientAccessKeyOperation(database, auth, {
        type: "accessKeys.issue",
        input: { name: "redacted-failure" },
      });
    } finally {
      database.adapter.withTransaction = originalWithTransaction;
    }
    assert.deepEqual(redactedFailure, {
      data: null,
      error: {
        message: "Could not manage Access keys.",
        hint: "Retry the Access-key operation.",
      },
    });
    assert.equal(JSON.stringify(redactedFailure).includes("secret-db-detail"), false);
    const failureEvent = (await database.log.tail(20)).find((event) => event.event === "access-key.management.failed");
    assert.deepEqual(failureEvent.data, { operation: "accessKeys.issue", outcome: "failed" });
    assert.equal(JSON.stringify(failureEvent).includes("secret-db-detail"), false);
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
