import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { capsule, job, mutation, query, requireAuth, String as Text, table } from "../dist/server.js";
import {
  confirmPasswordReset, createEmailPasswordResetLink, createWebSocketHub, openDevDatabase, resolveAnonymousSession,
  runMutation, runQuery, signInWithEmail, signUpWithEmail, verifyPasswordResetCode,
} from "../dist/server-runtime-source.js";
import { POSTGRES_SKIP_REASON, withLibsqlAdapter, withPostgresAdapter } from "./support/database-adapter-engines.js";

const PASSWORD = "original-password";
const NEXT = "replacement-password";
const guard = { linked: true, credentials: ["session"], reauthentication: "change-password" };
const change = (ctx, input) => {
  const operation = ctx.serverAuth.reserveChangeEmailPassword(input.email, input.currentPassword, input.newPassword);
  if (input.unused) return { unused: true };
  if (input.retain) globalThis.__passwordReservation = operation;
  return (async () => {
    await new Promise((resolve) => setImmediate(resolve));
    if (input.hold) {
      globalThis.__passwordChangeHeld();
      await globalThis.__passwordChangeRelease;
    }
    return ctx.lifecycle.continue(input.duplicate ? [operation, operation] : operation, async (result) => {
      const row = await ctx.db.mailOutbox.insert({ userId: ctx.auth.userId, kind: "password-changed" });
      await ctx.jobs.enqueue("deliverMail", { outboxId: row.id }, { availableAt: new Date(Date.now() + 3_600_000) });
      if (input.fail) throw new Error("post-outbox rollback");
      return result;
    });
  })();
};
const definition = capsule({
  name: "password-change-lifecycle",
  auth: { reauthentication: { purposes: { "change-password": { maxAgeSeconds: 300 } } } },
  schema: { mailOutbox: table({ userId: Text(), kind: Text() }) },
  jobs: { deliverMail: job(async () => {}) },
  mutations: {
    change: mutation(requireAuth(guard, change)),
    unguarded: mutation(change),
    replay: mutation(requireAuth(guard, (ctx) => ctx.lifecycle.continue(globalThis.__passwordReservation, () => null))),
  },
  queries: { reserve: query((ctx, input) => ctx.serverAuth.reserveChangeEmailPassword(input.email, input.currentPassword, input.newPassword)) },
});
const config = { name: definition.name, auth: { providers: { email: { enabled: true } } } };

async function withRuntime(run, env = {}, runtimeConfig = config) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-password-lifecycle-"));
  const database = await openDevDatabase(env.SPORADES_SERVICE_DATABASE_URL ? "" : path.join(dir, "data.db"), "", env, runtimeConfig, definition);
  try { await run(database); }
  finally { await database.close(); await rm(dir, { recursive: true, force: true }); }
}
async function register(database) {
  const email = `${randomUUID()}@example.test`;
  const user = await signUpWithEmail(database, await resolveAnonymousSession(database, null), "email", { email, password: PASSWORD });
  assert.equal(user.ok, true, JSON.stringify(user.error));
  return { ...user, token: user.sessionToken, email };
}
async function proof(database, user, overrides = {}) {
  await database.adapter.replaceReauthenticationProof({ id: randomUUID(), userId: user.auth.userId, sessionToken: user.token,
    purpose: "change-password", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(), ...overrides });
}
function call(database, user, input = {}, name = "change") {
  return runMutation(database, user.auth, name, [{ email: user.email, currentPassword: PASSWORD, newPassword: NEXT, ...input }], { sessionToken: user.token });
}
async function count(database, table) {
  return Number((await database.adapter.prepare(database.adapter.dialect.sql(`SELECT COUNT(*) AS [count] FROM [${table}]`)).get()).count);
}
async function reset(database, user) {
  const result = await createEmailPasswordResetLink(database, user, user.email);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return new URL(result.link).searchParams.get("code");
}
async function signin(database, user, password) {
  const result = await signInWithEmail(database, await resolveAnonymousSession(database, null), { email: user.email, password });
  return { ...result, token: result.sessionToken };
}
async function issueKey(database, user) {
  const id = randomUUID();
  await database.adapter.withTransaction((tx) => tx.issueAccessKeyRecord({ id, ownerUserId: user.auth.userId,
    name: "test", reservedName: "test", grantsJson: "[]", secretVersion: 1, selector: randomUUID(),
    verifierDigest: "ab".repeat(32), lifecycleRevision: 1, createdAt: new Date().toISOString(), expiresAt: null }));
  return id;
}

async function proveAtomicChange(database) {
  const user = await register(database);
  const sibling = await signin(database, user, PASSWORD);
  const code = await reset(database, user);
  await proof(database, user);
  await proof(database, sibling);
  const keyId = await issueKey(database, user);
  const result = await call(database, user);
  assert.equal(result.error, null, JSON.stringify(result.error));
  assert.deepEqual(result.data, { ok: true });
  assert.equal(await database.adapter.readAuthSessionWithUser(user.token), null);
  assert.equal(await database.adapter.readAuthSessionWithUser(sibling.token), null);
  assert.equal(await count(database, "sporades_auth_reauthentication_proofs"), 0);
  const key = await database.adapter.prepare(database.adapter.dialect.sql("SELECT [revokedAt], [revocationCause] FROM [sporades_auth_access_keys] WHERE [id] = ?")).get(keyId);
  assert.ok(key.revokedAt);
  assert.equal(key.revocationCause, "password-change");
  assert.equal((await verifyPasswordResetCode(database, user, code)).ok, false, "an old reset code cannot verify");
  assert.equal((await confirmPasswordReset(database, user, code, "attacker-password")).ok, false, "an old reset code cannot replace the new password");
  assert.equal((await signin(database, user, PASSWORD)).ok, false);
  assert.equal((await signin(database, user, NEXT)).ok, true);
  assert.equal(await count(database, "mailOutbox"), 1);
  assert.equal(await count(database, "sporades_jobs"), 1);
}

test("Capsule password change revokes all authority and stages outbox and Job atomically", async () => {
  await withRuntime(proveAtomicChange);
});

test("failure after outbox staging rolls back credential, revocations, proof, outbox and Job", async () => {
  await withRuntime(async (database) => {
    const user = await register(database);
    const code = await reset(database, user);
    await proof(database, user);
    await issueKey(database, user);
    const keysBefore = await database.adapter.listAccessKeyRecordsForOwner(user.auth.userId);
    const logs = [];
    database.log = { emit: async (event) => logs.push(event) };
    const before = await database.adapter.findEmailCredentialWithUser(user.email);
    assert.equal((await call(database, user, { fail: true })).ok, false);
    assert.deepEqual(await database.adapter.findEmailCredentialWithUser(user.email), before);
    assert.ok(await database.adapter.readAuthSessionWithUser(user.token));
    assert.equal((await verifyPasswordResetCode(database, user, code)).ok, true);
    assert.equal(await count(database, "sporades_auth_reauthentication_proofs"), 1);
    assert.equal(await count(database, "mailOutbox"), 0);
    assert.equal(await count(database, "sporades_jobs"), 0);
    assert.deepEqual(await database.adapter.listAccessKeyRecordsForOwner(user.auth.userId), keysBefore);
    assert.equal(logs.filter((event) => event.event === "access-key.revoked").length, 0, "rollback publishes no success audit");
    assert.equal((await call(database, user)).ok, true, "rolled-back proof can authorize a retry");
    assert.equal(logs.filter((event) => event.event === "access-key.revoked").length, 1, "only committed revocation publishes its audit");
  });
});

test("missing, expired, sibling, guest, unguarded, wrong-password and invalid changes stage no notice", async () => {
  await withRuntime(async (database) => {
    const user = await register(database);
    assert.equal((await call(database, user)).error.code, "REAUTHENTICATION_REQUIRED");
    await proof(database, user, { expiresAt: new Date(Date.now() - 1).toISOString() });
    assert.equal((await call(database, user)).error.code, "REAUTHENTICATION_REQUIRED");
    const sibling = await signin(database, user, PASSWORD);
    await proof(database, sibling);
    assert.equal((await call(database, user)).error.code, "REAUTHENTICATION_REQUIRED");
    await proof(database, user);
    for (const input of [{ currentPassword: "wrong" }, { newPassword: "short" }, { email: "other@example.test" }, { newPassword: null }]) {
      assert.equal((await call(database, user, input)).ok, false);
    }
    assert.equal((await call(database, user, {}, "unguarded")).error.code, "PASSWORD_CHANGE_DENIED");
    assert.equal((await runQuery(database, user.auth, "reserve", [{ email: user.email, currentPassword: PASSWORD, newPassword: NEXT }], { sessionToken: user.token })).error.code, "PASSWORD_CHANGE_DENIED");
    const guest = await resolveAnonymousSession(database, null);
    assert.equal((await call(database, guest)).ok, false);
    assert.equal(await count(database, "mailOutbox"), 0);
    assert.equal(await count(database, "sporades_jobs"), 0);
    assert.equal((await signin(database, user, PASSWORD)).ok, true);
  });
});

test("password reservation is write-free, one-shot and bound to its owning mutation", async () => {
  await withRuntime(async (database) => {
    const user = await register(database);
    await proof(database, user);
    const credential = await database.adapter.findEmailCredentialWithUser(user.email);
    assert.equal((await call(database, user, { unused: true })).ok, true);
    assert.deepEqual(await database.adapter.findEmailCredentialWithUser(user.email), credential);
    await proof(database, user);
    assert.equal((await call(database, user, { duplicate: true, retain: true })).error.code, "LIFECYCLE_CONTINUATION_DENIED");
    assert.equal((await call(database, user, {}, "replay")).error.code, "LIFECYCLE_CONTINUATION_DENIED");
    assert.deepEqual(await database.adapter.findEmailCredentialWithUser(user.email), credential);
    assert.equal(await count(database, "mailOutbox"), 0);
  });
});

test("concurrent password changes have exactly one successful continuation", async () => {
  await withRuntime(async (database) => {
    const user = await register(database);
    await proof(database, user);
    const results = await Promise.all([call(database, user), call(database, user, { newPassword: "contender-password" })]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(await count(database, "mailOutbox"), 1);
    assert.equal(await count(database, "sporades_jobs"), 1);
  });
});

test("runtime storage failures are opaque and cannot commit partial password changes", async () => {
  await withRuntime(async (database) => {
    const user = await register(database);
    const code = await reset(database, user);
    await proof(database, user);
    const before = await database.adapter.findEmailCredentialWithUser(user.email);
    const original = database.adapter.withTransaction.bind(database.adapter);
    const logs = [];
    database.log = { emit: async (event) => logs.push(event) };
    for (const failAt of ["deleteExpiredReauthenticationProofs", "lockAuthUserFileAuthority", "consumeReauthenticationProof", "updateEmailCredentialPassword", "deletePasswordResetCodesForUser", "deleteAuthSessionsForUser", "bulkRevokeAccessKeysForOwner"]) {
      database.adapter.withTransaction = (callback) => original((tx) => callback(new Proxy(tx, {
        get(target, property, receiver) {
          if (property === failAt) return async () => { throw new Error("sensitive-storage-marker"); };
          return Reflect.get(target, property, receiver);
        },
      })));
      const result = await call(database, user);
      assert.equal(result.error.code, "PASSWORD_CHANGE_DENIED", failAt);
      assert.doesNotMatch(JSON.stringify(result), /sensitive-storage-marker/);
      assert.deepEqual(await database.adapter.findEmailCredentialWithUser(user.email), before);
      assert.ok(await database.adapter.readAuthSessionWithUser(user.token));
      assert.equal((await verifyPasswordResetCode(database, user, code)).ok, true);
      assert.equal(await count(database, "sporades_auth_reauthentication_proofs"), 1);
      assert.equal(await count(database, "mailOutbox"), 0);
      assert.equal(await count(database, "sporades_jobs"), 0);
    }
    database.adapter.withTransaction = original;
    assert.doesNotMatch(JSON.stringify(logs), /sensitive-storage-marker/);
    assert.equal(logs.filter((event) => event.event === "access-key.revoked").length, 0);
  });
});

test("successful lifecycle revocations, outbox and Job survive runtime restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-password-restart-"));
  const file = path.join(dir, "data.db");
  let database = await openDevDatabase(file, "", {}, config, definition);
  try {
    const user = await register(database);
    const code = await reset(database, user);
    await proof(database, user);
    assert.equal((await call(database, user)).ok, true);
    await database.close();
    database = await openDevDatabase(file, "", {}, config, definition);
    assert.equal(await database.adapter.readAuthSessionWithUser(user.token), null);
    assert.equal((await verifyPasswordResetCode(database, user, code)).ok, false);
    assert.equal((await confirmPasswordReset(database, user, code, "attacker-password")).ok, false);
    assert.equal((await signin(database, user, PASSWORD)).ok, false);
    assert.equal((await signin(database, user, NEXT)).ok, true);
    assert.equal(await count(database, "mailOutbox"), 1);
    assert.equal(await count(database, "sporades_jobs"), 1);
  } finally { await database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("real transport reauthenticates the password and signs out initiating and sibling connections", async () => {
  await withRuntime(async (database) => {
    const user = await register(database);
    const sibling = await signin(database, user, PASSWORD);
    const hub = createWebSocketHub(() => database);
    const server = createServer();
    server.on("upgrade", (request, socket) => hub.accept(request, socket));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const sockets = [];
    async function connect(token) {
      const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/?connectionToken=${hub.createConnectionToken()}`);
      socket.messages = [];
      socket.addEventListener("message", (event) => socket.messages.push(JSON.parse(String(event.data))));
      sockets.push(socket);
      await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
      await send(socket, { type: "auth.get", sessionToken: token });
      return socket;
    }
    async function waitFor(socket, predicate) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const match = socket.messages.find(predicate);
        if (match) return match;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Timed out waiting for transport result");
    }
    function send(socket, message) {
      const id = randomUUID();
      socket.send(JSON.stringify({ ...message, id }));
      return waitFor(socket, (result) => result.id === id);
    }
    try {
      const first = await connect(user.token);
      const second = await connect(sibling.token);
      const badProof = await send(first, { type: "auth.reauthenticate", provider: "email", purpose: "change-password", credentials: { email: user.email, password: "wrong-password" } });
      assert.equal(badProof.error.code, "REAUTHENTICATION_FAILED");
      const rejected = await send(first, { type: "mutation.run", mutation: "change", args: [{ email: user.email, currentPassword: PASSWORD, newPassword: NEXT }] });
      assert.equal(rejected.error.code, "REAUTHENTICATION_REQUIRED");
      assert.equal(await count(database, "mailOutbox"), 0);
      const reauthenticated = await send(first, { type: "auth.reauthenticate", provider: "email", purpose: "change-password", credentials: { email: user.email, password: PASSWORD } });
      assert.equal(reauthenticated.error, null);
      const changed = await send(first, { type: "mutation.run", mutation: "change", args: [{ email: user.email, currentPassword: PASSWORD, newPassword: NEXT }] });
      assert.equal(changed.error, null, JSON.stringify(changed));
      for (const socket of [first, second]) {
        const replacement = await waitFor(socket, (message) => message.type === "auth.session.replace");
        assert.equal(replacement.data.auth.isAuthenticated, false);
        const retry = await send(socket, { type: "mutation.run", mutation: "change", args: [{ email: user.email, currentPassword: NEXT, newPassword: PASSWORD }] });
        assert.ok(retry.error, "cached revoked Session cannot change credentials");
      }
      assert.equal(await count(database, "mailOutbox"), 1);
      assert.equal(await count(database, "sporades_jobs"), 1);
    } finally {
      for (const socket of sockets) socket.close();
      hub.disconnectAll();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("libSQL Capsule password-change lifecycle parity", async () => {
  await withLibsqlAdapter(async (_adapter, { url }) => {
    await withRuntime(proveAtomicChange, { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url },
      { ...config, services: { database: { engine: "libsql" } } });
  }, { isolateProcess: true });
});

test("Postgres Capsule password-change lifecycle parity", { skip: POSTGRES_SKIP_REASON }, async () => {
  await withPostgresAdapter(async () => {
    await withRuntime(proveAtomicChange, { SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL },
      { ...config, services: { database: { engine: "postgres" } } });
  }, { appTableNames: ["mailOutbox"] });
});

test("Postgres password-change fence rejects concurrent stale sign-in, reset and change", { skip: POSTGRES_SKIP_REASON, timeout: 30_000 }, async () => {
  const env = { SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL };
  const runtimeConfig = { ...config, services: { database: { engine: "postgres" } } };
  await withPostgresAdapter(async () => {
    await withRuntime(async (database) => {
      const other = await openDevDatabase("", "", env, runtimeConfig, definition);
      try {
        for (const competitor of ["sign-in", "reset", "change"]) {
          const user = await register(database);
          const code = await reset(database, user);
          await proof(database, user);
          let held;
          const ready = new Promise((resolve) => { held = resolve; });
          let release;
          globalThis.__passwordChangeHeld = held;
          globalThis.__passwordChangeRelease = new Promise((resolve) => { release = resolve; });
          const changing = call(database, user, { hold: true });
          await ready;
          const contender = competitor === "sign-in" ? signin(other, user, PASSWORD)
            : competitor === "reset" ? confirmPasswordReset(other, user, code, "contender-password")
            : call(other, user, { newPassword: "contender-password" });
          let settled = false;
          void contender.finally(() => { settled = true; });
          try {
            await new Promise((resolve) => setTimeout(resolve, 50));
            assert.equal(settled, false, `${competitor} waits for the identity fence`);
          } finally { release(); }
          assert.equal((await changing).ok, true);
          assert.equal((await contender).ok, false, `${competitor} cannot use the retired password authority`);
          assert.equal((await signin(other, user, NEXT)).ok, true);
        }
        assert.equal(await count(database, "mailOutbox"), 3);
        assert.equal(await count(database, "sporades_jobs"), 3);
      } finally {
        delete globalThis.__passwordChangeHeld;
        delete globalThis.__passwordChangeRelease;
        await other.close();
      }
    }, env, runtimeConfig);
  }, { appTableNames: ["mailOutbox"] });
});
