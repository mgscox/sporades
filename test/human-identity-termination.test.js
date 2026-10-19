import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { capsule, endpoint, job, message, mutation, query, requireAuth, String as Text, table } from "../dist/server.js";
import {
  confirmPasswordReset, createEmailPasswordResetLink, hashPasswordResetVerifier, linkProviderIdentity, openDevDatabase,
  prepareEmailPasswordResetDelivery, readCurrentUserPreferences, resolveAnonymousSession, routeEndpoint, runAppMessage,
  runCurrentUserJobWorker, runEndpoint, runMutation, runQuery, signInWithEmail, signUpWithEmail, updateCurrentUserPreferences,
  verifyPasswordResetCode,
} from "../dist/server-runtime-source.js";
import { createAdditionalTeam, createTeamJoinLink, deleteCurrentUserTeam, joinCurrentUserTeam, listCurrentUserTeams } from "../dist/teams-runtime.js";
import { POSTGRES_SKIP_REASON, withLibsqlAdapter, withPostgresAdapter } from "./support/database-adapter-engines.js";

// ADR-0057 acceptance through the public runtime: real sign-up, sign-in, Reset codes, Access keys
// and Mutations against disposable Capsule databases. No provider or mail transport is contacted.

const DENIED = "HUMAN_IDENTITY_TERMINATION_DENIED";
const BLOCKED = "HUMAN_IDENTITY_TERMINATION_BLOCKED";
const PASSWORD = "original-password";

const definition = capsule({
  name: "human-identity-termination",
  accessKeys: { scopes: ["closure:read"] },
  schema: { closures: table({ userId: Text(), value: Text() }) },
  jobs: { recordAsActor: job(async (ctx, payload) => { await ctx.db.closures.insert({ userId: ctx.auth.userId, value: payload.value }); }) },
  mutations: {
    terminate: mutation(async (ctx, userId) => {
      const pending = ctx.serverAuth.terminateHumanIdentity(userId);
      await ctx.db.closures.insert({ userId, value: "erased" });
      return await pending;
    }),
    terminateThenThrow: mutation(async (ctx, userId) => {
      const pending = ctx.serverAuth.terminateHumanIdentity(userId);
      await pending;
      await ctx.db.closures.insert({ userId, value: "rolled-back" });
      throw new Error("force rollback");
    }),
    terminateUnawaited: mutation(async (ctx, userId) => {
      ctx.serverAuth.terminateHumanIdentity(userId);
      await ctx.db.closures.insert({ userId, value: "unawaited" });
      return { queued: true };
    }),
    terminateCaught: mutation(async (ctx, userId) => {
      await ctx.serverAuth.terminateHumanIdentity(userId).catch(() => null);
      await ctx.db.closures.insert({ userId, value: "caught" });
      return { caught: true };
    }),
    terminateAfterAwait: mutation(async (ctx, userId) => {
      await new Promise((resolve) => setImmediate(resolve));
      return await ctx.serverAuth.terminateHumanIdentity(userId);
    }),
    terminateRetargeted: mutation(async (ctx, input) => {
      const reservation = ctx.serverAuth.reserveTerminateHumanIdentity(input.approvedUserId);
      let replacementDenied = false;
      try { ctx.serverAuth.terminateHumanIdentity = () => null; } catch { replacementDenied = true; }
      input.approvedUserId = input.redirectUserId;
      await new Promise((resolve) => setImmediate(resolve));
      return ctx.lifecycle.continue(reservation, (result) => ({ ...result, replacementDenied }));
    }),
    reservedSelfClosure: mutation(async (ctx) => {
      // Asynchronous app checks run after the synchronous reservation; the runtime executes the
      // termination and then the callback in the same transaction.
      const reservation = ctx.serverAuth.reserveTerminateHumanIdentity(ctx.auth.userId);
      const { teams } = await ctx.teams.list();
      for (const team of teams) await ctx.teams.delete(team.id);
      return ctx.lifecycle.continue(reservation, async (result) => {
        await ctx.db.closures.insert({ userId: ctx.auth.userId, value: "reserved" });
        return result;
      });
    }),
    reservedThenThrow: mutation(async (ctx, userId) => {
      const reservation = ctx.serverAuth.reserveTerminateHumanIdentity(userId);
      await new Promise((resolve) => setImmediate(resolve));
      return ctx.lifecycle.continue(reservation, async () => {
        await ctx.db.closures.insert({ userId, value: "callback-failed" });
        throw new Error("continuation failure");
      });
    }),
    reservedTwice: mutation(async (ctx, userId) => {
      const first = ctx.serverAuth.reserveTerminateHumanIdentity(userId);
      const second = ctx.serverAuth.reserveTerminateHumanIdentity(userId);
      await new Promise((resolve) => setImmediate(resolve));
      return ctx.lifecycle.continue([first, second], (results) => results);
    }),
    reservedDuplicate: mutation(async (ctx, userId) => {
      const reservation = ctx.serverAuth.reserveTerminateHumanIdentity(userId);
      await new Promise((resolve) => setImmediate(resolve));
      return ctx.lifecycle.continue([reservation, reservation], () => null);
    }),
    reservedUnused: mutation(async (ctx, userId) => {
      ctx.serverAuth.reserveTerminateHumanIdentity(userId);
      await new Promise((resolve) => setImmediate(resolve));
      return { validated: false };
    }),
    retainReservation: mutation((ctx, userId) => {
      globalThis.__retainedTermination = ctx.serverAuth.reserveTerminateHumanIdentity(userId);
      return null;
    }),
    replayReservation: mutation((ctx) => ctx.lifecycle.continue(globalThis.__retainedTermination, (result) => result)),
    reservedSelfThenRevoke: mutation((ctx, otherUserId) => ctx.lifecycle.continue([
      ctx.serverAuth.reserveTerminateHumanIdentity(ctx.auth.userId),
      ctx.serverAuth.reserveRevokeHumanSecurity(otherUserId),
    ], (results) => results)),
    terminateAndHold: mutation(async (ctx, userId) => {
      const pending = ctx.serverAuth.terminateHumanIdentity(userId);
      const result = await pending;
      globalThis.__terminationHeld?.();
      await globalThis.__terminationRelease;
      return result;
    }),
    enqueueAsActor: mutation((ctx, value) => ctx.jobs.enqueue("recordAsActor", { value }, { availableAt: new Date(Date.now() + 3_600_000) })),
    issueKey: mutation((ctx) => ctx.accessKeys.issue({ name: "closure", grants: ["closure:read"] })),
  },
  queries: { terminate: query((ctx, userId) => ctx.serverAuth.terminateHumanIdentity(userId)) },
  messages: { terminate: message((ctx, userId) => ctx.serverAuth.terminateHumanIdentity(userId)) },
  endpoints: {
    terminate: endpoint({ method: "POST", path: "/terminate" }, (ctx) => ctx.serverAuth.terminateHumanIdentity(ctx.auth.userId)),
    whoami: endpoint({ method: "GET", path: "/whoami" }, requireAuth({ credentials: ["access-key"], scopes: ["closure:read"] }, (ctx) => ({ body: { userId: ctx.auth.userId } }))),
  },
});

const config = { name: definition.name, auth: { providers: { email: { enabled: true } } } };

async function withRuntime(run, serverEnv = {}, runtimeConfig = config) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sporades-human-identity-"));
  const database = await openDevDatabase(serverEnv.SPORADES_SERVICE_DATABASE_URL ? "" : path.join(dir, "data.db"), "", serverEnv, runtimeConfig, definition);
  try {
    await database.init?.();
    return await run(database);
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function register(database, email, password = PASSWORD) {
  const anonymous = await resolveAnonymousSession(database, null);
  const result = await signUpWithEmail(database, anonymous, "email", { email, password });
  assert.equal(result.ok, true, result.error?.message);
  return { token: result.sessionToken, auth: result.auth };
}

async function signIn(database, email, password = PASSWORD) {
  return signInWithEmail(database, await resolveAnonymousSession(database, null), { email, password });
}

async function clearTeams(database, human) {
  const { teams } = await listCurrentUserTeams(database, human.auth);
  for (const team of teams) await deleteCurrentUserTeam(database, human.auth, team.id);
}

function call(database, human, name, args = []) {
  return runMutation(database, human.auth, name, args, { sessionToken: human.token });
}

async function preferencesOf(database, auth) {
  return (await readCurrentUserPreferences(database, auth)).data?.preferences;
}

async function sessionUser(database, token) {
  return (await resolveAnonymousSession(database, token)).auth;
}

function endpointRequest(headers = {}) {
  return Object.assign(Readable.from([]), { method: "POST", headers });
}

async function requestWhoami(database, token) {
  const request = {
    url: "/whoami", method: "GET", headers: { authorization: `Bearer ${token}` }, rawHeaders: ["Authorization", `Bearer ${token}`],
    socket: { remoteAddress: "127.0.0.1" }, async *[Symbol.asyncIterator]() {},
  };
  const response = { status: null, body: "", setHeader() {}, writeHead(status) { this.status = status; }, end(body = "") { this.body = String(body); } };
  assert.equal(await routeEndpoint(database, request, response), true);
  return { status: response.status, body: response.body };
}

async function userRow(database, userId) {
  const row = await database.adapter.prepare(database.adapter.dialect.sql(
    "SELECT [id], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider], [userKind], [lifecycleStatus] FROM [sporades_auth_users] WHERE [id] = ?",
  )).get(userId);
  return row ? { ...row, isAuthenticated: Number(row.isAuthenticated), isGuest: Number(row.isGuest) } : row;
}

async function countRows(database, table, column, value) {
  const row = await database.adapter.prepare(database.adapter.dialect.sql(`SELECT COUNT(*) AS [count] FROM [${table}] WHERE [${column}] = ?`)).get(value);
  return Number(row?.count ?? 0);
}

async function closures(database, userId) {
  const rows = await database.adapter.prepare(database.adapter.dialect.sql("SELECT [value] FROM [closures] WHERE [userId] = ? ORDER BY [value]")).all(userId);
  return rows.map((row) => row.value);
}

async function resetCode(database, email) {
  const result = await createEmailPasswordResetLink(database, null, email);
  assert.equal(result.ok, true, result.error?.message);
  return new URL(result.link).searchParams.get("code");
}

test("self-closure terminates the identity, every credential and recovery path with the Mutation's app writes", async () => {
  await withRuntime(async (database) => {
    const human = await register(database, "closing@example.test");
    const second = await signIn(database, "closing@example.test");
    assert.equal(second.ok, true);
    assert.notEqual(second.sessionToken, human.token, "two independent Sessions");
    const key = await call(database, human, "issueKey");
    assert.equal(key.error, null, JSON.stringify(key.error));
    assert.deepEqual(JSON.parse((await requestWhoami(database, key.data.token)).body), { userId: human.auth.userId });
    const outstanding = await resetCode(database, "closing@example.test");
    const verifiedButUnspent = await resetCode(database, "closing@example.test");
    assert.equal((await verifyPasswordResetCode(database, null, verifiedButUnspent)).ok, true);
    await updateCurrentUserPreferences(database, human.auth, { theme: "dark" });
    await clearTeams(database, human);

    const result = await call(database, human, "terminate", [human.auth.userId]);
    assert.equal(result.error, null, JSON.stringify(result.error));
    assert.deepEqual(result.data, { userId: human.auth.userId, status: "terminated" });
    assert.deepEqual(await closures(database, human.auth.userId), ["erased"], "app erasure commits with termination");

    for (const token of [human.token, second.sessionToken]) {
      const resolved = await sessionUser(database, token);
      assert.notEqual(resolved.userId, human.auth.userId, "an old Session never resolves to the terminated human");
      assert.equal(resolved.isAuthenticated, false);
    }
    assert.equal((await requestWhoami(database, key.data.token)).status, 401, "the Access key no longer authenticates");
    const keyRow = await database.adapter.prepare("SELECT revokedAt, revocationCause, selector, verifierDigest FROM sporades_auth_access_keys WHERE ownerUserId = ?").get(human.auth.userId);
    assert.equal(keyRow.revocationCause, "owner-deleted");
    assert.ok(keyRow.revokedAt);
    assert.equal(keyRow.selector, null);
    assert.equal(keyRow.verifierDigest, null);
    assert.equal((await signIn(database, "closing@example.test")).ok, false, "the old password cannot sign in");
    for (const code of [outstanding, verifiedButUnspent]) {
      assert.equal((await verifyPasswordResetCode(database, null, code)).ok, false);
      assert.equal((await confirmPasswordReset(database, null, code, "attacker-password")).ok, false, "an outstanding reset link cannot restore access");
    }
    assert.deepEqual(await userRow(database, human.auth.userId), {
      id: human.auth.userId, displayName: "", email: null, picture: null, isAuthenticated: 0, isGuest: 0,
      provider: "unknown", userKind: "human", lifecycleStatus: "terminated",
    });
    assert.equal(await countRows(database, "sporades_auth_email_credentials", "userId", human.auth.userId), 0);
    assert.equal(await countRows(database, "sporades_auth_identities", "userId", human.auth.userId), 0);
    assert.equal(await countRows(database, "sporades_auth_sessions", "userId", human.auth.userId), 0);
    assert.equal(await countRows(database, "sporades_auth_password_reset_codes", "userId", human.auth.userId), 0);
    assert.equal(await countRows(database, "sporades_user_preferences", "userId", human.auth.userId), 0);
    assert.deepEqual(await preferencesOf(database, human.auth), {}, "preferences are gone");

    // Re-registration with the same email creates a new, unrelated account.
    const replacement = await register(database, "closing@example.test", "replacement-password");
    assert.notEqual(replacement.auth.userId, human.auth.userId);
    assert.equal((await signIn(database, "closing@example.test")).ok, false, "the old password still fails for the new account");
    assert.equal((await signIn(database, "closing@example.test", "replacement-password")).ok, true);
    assert.deepEqual(await preferencesOf(database, replacement.auth), {});
    assert.equal((await confirmPasswordReset(database, null, outstanding, "attacker-password")).ok, false, "old Reset codes stay invalid after email reuse");
    assert.equal((await signIn(database, "closing@example.test", "replacement-password")).ok, true);

    // A surviving human administrator replays the original target and observes the stable result.
    const admin = await register(database, "admin@example.test");
    const replay = await call(database, admin, "terminate", [human.auth.userId]);
    assert.equal(replay.error, null, JSON.stringify(replay.error));
    assert.deepEqual(replay.data, { userId: human.auth.userId, status: "already-terminated" });
    assert.ok(Object.isFrozen(replay.data) || typeof replay.data === "object");
  });
});

test("a thrown handler, failed continuation or caught rejection rolls every effect back", async () => {
  await withRuntime(async (database) => {
    const admin = await register(database, "rollback-admin@example.test");
    const target = await register(database, "rollback-target@example.test");
    await updateCurrentUserPreferences(database, target.auth, { kept: true });
    const code = await resetCode(database, "rollback-target@example.test");
    await clearTeams(database, target);

    for (const name of ["terminateThenThrow", "reservedThenThrow"]) {
      const failed = await call(database, admin, name, [target.auth.userId]);
      assert.ok(failed.error, `${name} must fail`);
      assert.equal((await sessionUser(database, target.token)).userId, target.auth.userId, `${name} restores the Session`);
      assert.equal((await userRow(database, target.auth.userId)).lifecycleStatus, "active");
      assert.equal((await verifyPasswordResetCode(database, null, code)).ok, true, `${name} restores the Reset code`);
      assert.deepEqual(await preferencesOf(database, target.auth), { kept: true });
      assert.deepEqual(await closures(database, target.auth.userId), []);
    }
    assert.equal((await signIn(database, "rollback-target@example.test")).ok, true, "credentials survive the rollbacks");

    // A Team membership blocks termination. Catching the rejection cannot commit the app write.
    const member = await register(database, "member@example.test");
    const caught = await call(database, admin, "terminateCaught", [member.auth.userId]);
    assert.equal(caught.error?.code, BLOCKED);
    assert.deepEqual(await closures(database, member.auth.userId), []);
    assert.equal((await call(database, admin, "terminate", [member.auth.userId])).error?.code, BLOCKED);
    assert.equal((await userRow(database, member.auth.userId)).lifecycleStatus, "active");

    // A rolled-back attempt leaves no tombstone; a later attempt still reports `terminated`.
    const retried = await call(database, admin, "terminateUnawaited", [target.auth.userId]);
    assert.equal(retried.error, null, JSON.stringify(retried.error));
    assert.deepEqual(retried.data, { queued: true }, "the runtime drains a forgotten await before commit");
    assert.equal((await userRow(database, target.auth.userId)).lifecycleStatus, "terminated");
    assert.deepEqual(await closures(database, target.auth.userId), ["unawaited"]);
  });
});

test("guest, service, privileged, unknown and terminated callers and every non-Mutation surface are refused", async () => {
  await withRuntime(async (database) => {
    const admin = await register(database, "surface-admin@example.test");
    const target = await register(database, "surface-target@example.test");
    await clearTeams(database, target);
    const guest = await resolveAnonymousSession(database, null);
    const now = new Date().toISOString();
    await database.adapter.insertAuthUser({ id: "service-target", createdAt: now, displayName: "Agent", email: null, picture: null, isAuthenticated: 1, isGuest: 0, provider: "unknown", userKind: "service" });

    for (const targetId of [guest.auth.userId, "service-target", "__privileged__", "operator", `unknown-${randomUUID()}`, "", 42, null]) {
      const result = await call(database, admin, "terminate", [targetId]);
      assert.equal(result.error?.code, DENIED, `target ${String(targetId)}`);
    }
    assert.equal((await runMutation(database, guest.auth, "terminate", [target.auth.userId], { sessionToken: guest.token })).error?.code, DENIED, "guest caller");
    assert.equal((await runMutation(database, admin.auth, "terminate", [target.auth.userId])).error?.code, DENIED, "no Session");
    assert.equal((await runMutation(database, admin.auth, "terminate", [target.auth.userId], { sessionToken: target.token })).error?.code, DENIED, "a Session of another user");
    assert.equal((await runMutation(database, { ...admin.auth, userKind: "service" }, "terminate", [target.auth.userId], { sessionToken: admin.token })).error?.code, DENIED, "service actor");
    assert.equal((await call(database, admin, "terminateAfterAwait", [target.auth.userId])).error?.code, DENIED, "post-await initiation");
    assert.equal((await runQuery(database, admin.auth, "terminate", [target.auth.userId], { sessionToken: admin.token })).error?.code, DENIED, "query");
    assert.equal((await runAppMessage(database, admin.auth, "terminate", target.auth.userId, { sessionToken: admin.token })).error?.code, DENIED, "app message");
    const terminateEndpoint = database.endpoints.find((candidate) => candidate.options.path === "/terminate");
    await assert.rejects(runEndpoint(database, terminateEndpoint, new URL("http://capsule.test/terminate"), endpointRequest({ "x-sporades-session-token": admin.token })),
      (error) => error?.code === DENIED, "custom endpoint");
    assert.equal((await userRow(database, target.auth.userId)).lifecycleStatus, "active");
    assert.equal((await sessionUser(database, target.token)).userId, target.auth.userId);

    // Self-termination must be the last lifecycle operation: the caller Session is gone afterwards.
    await clearTeams(database, admin);
    const ordered = await call(database, admin, "reservedSelfThenRevoke", [target.auth.userId]);
    assert.equal(ordered.error?.code, "HUMAN_SECURITY_TRANSITION_DENIED");
    assert.equal((await userRow(database, admin.auth.userId)).lifecycleStatus, "active", "the whole Mutation rolled back");

    // A terminated human's captured Session authority cannot initiate a replay.
    assert.equal((await call(database, admin, "terminate", [admin.auth.userId])).error, null);
    assert.equal((await call(database, admin, "terminate", [admin.auth.userId])).error?.code, DENIED, "replay requires a current Session");
  });
});

test("the reserved form is write-free until continued, one-shot and cannot be retargeted", async () => {
  await withRuntime(async (database) => {
    const admin = await register(database, "reserve-admin@example.test");
    const unused = await register(database, "reserve-unused@example.test");
    await clearTeams(database, unused);
    assert.deepEqual((await call(database, admin, "reservedUnused", [unused.auth.userId])).data, { validated: false });
    assert.equal((await userRow(database, unused.auth.userId)).lifecycleStatus, "active", "an unused reservation does no work");
    assert.equal((await call(database, admin, "reservedDuplicate", [unused.auth.userId])).error?.code, "LIFECYCLE_CONTINUATION_DENIED");
    assert.equal((await userRow(database, unused.auth.userId)).lifecycleStatus, "active");
    assert.equal((await call(database, admin, "retainReservation", [unused.auth.userId])).error, null);
    assert.equal((await call(database, admin, "replayReservation")).error?.code, "LIFECYCLE_CONTINUATION_DENIED", "a reservation cannot cross Mutations");
    assert.equal((await userRow(database, unused.auth.userId)).lifecycleStatus, "active");

    const approved = await register(database, "reserve-approved@example.test");
    const redirect = await register(database, "reserve-redirect@example.test");
    await clearTeams(database, approved);
    await clearTeams(database, redirect);
    const retargeted = await call(database, admin, "terminateRetargeted", [{ approvedUserId: approved.auth.userId, redirectUserId: redirect.auth.userId }]);
    assert.equal(retargeted.error, null, JSON.stringify(retargeted.error));
    assert.deepEqual(retargeted.data, { userId: approved.auth.userId, status: "terminated", replacementDenied: true });
    assert.equal((await userRow(database, redirect.auth.userId)).lifecycleStatus, "active");

    const twice = await call(database, admin, "reservedTwice", [unused.auth.userId]);
    assert.equal(twice.error, null, JSON.stringify(twice.error));
    assert.deepEqual(twice.data, [
      { userId: unused.auth.userId, status: "terminated" },
      { userId: unused.auth.userId, status: "already-terminated" },
    ]);

    // Self-closure: reserve synchronously, delete the personal Team asynchronously, then continue.
    const closing = await register(database, "reserve-self@example.test");
    const reserved = await call(database, closing, "reservedSelfClosure");
    assert.equal(reserved.error, null, JSON.stringify(reserved.error));
    assert.deepEqual(reserved.data, { userId: closing.auth.userId, status: "terminated" });
    assert.deepEqual(await closures(database, closing.auth.userId), ["reserved"]);
    assert.deepEqual((await listCurrentUserTeams(database, closing.auth)).teams, [], "a tombstone never bootstraps a new personal Team");
  });
});

test("terminated humans cannot join Teams, and captured Job provenance does not restore their authority", async () => {
  await withRuntime(async (database) => {
    const admin = await register(database, "job-admin@example.test");
    const target = await register(database, "job-target@example.test");
    const enqueued = await call(database, target, "enqueueAsActor", ["after-termination"]);
    assert.equal(enqueued.error, null, JSON.stringify(enqueued.error));
    const [adminTeam] = (await listCurrentUserTeams(database, admin.auth)).teams;
    const invitation = await createTeamJoinLink(database, admin.auth, adminTeam.id, "job-target@example.test");
    await clearTeams(database, target);
    assert.equal((await call(database, admin, "terminate", [target.auth.userId])).error, null);

    // Work that captured the human's authority before termination cannot add memberships after it.
    const joinCode = new URL(invitation.link).searchParams.get("code");
    await assert.rejects(joinCurrentUserTeam(database, target.auth, joinCode), (error) => error?.code === "INVALID_JOIN_LINK");
    await assert.rejects(createAdditionalTeam(database, target.auth, "Resurrected"), (error) => error?.code === "DENIED");
    assert.equal(await countRows(database, "sporades_team_memberships", "userId", target.auth.userId), 0);
    // A sign-up or provider callback whose Session was resolved before termination cannot attach a
    // credential or identity to the tombstone, so it can never block re-registration either.
    const staleSession = { token: target.token, auth: target.auth };
    assert.equal((await signUpWithEmail(database, staleSession, "email", { email: "stale@example.test", password: PASSWORD })).error?.code, "AUTH_SESSION_INVALID");
    assert.equal((await linkProviderIdentity(database, staleSession, "google", { subject: "google-stale", email: "stale@example.test", emailVerified: true })).error?.code, "AUTH_SESSION_INVALID");
    assert.equal(await countRows(database, "sporades_auth_email_credentials", "userId", target.auth.userId), 0);
    assert.equal(await countRows(database, "sporades_auth_identities", "userId", target.auth.userId), 0);
    assert.equal((await userRow(database, target.auth.userId)).isAuthenticated, 0);
    await database.adapter.prepare("UPDATE sporades_jobs SET availableAt = ?, status = 'queued' WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), enqueued.data.id);
    await runCurrentUserJobWorker(database);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const row = await database.adapter.prepare("SELECT status FROM sporades_jobs WHERE id = ?").get(enqueued.data.id);
      if (row.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const job = await database.adapter.prepare("SELECT status, failure FROM sporades_jobs WHERE id = ?").get(enqueued.data.id);
    assert.equal(job.status, "failed");
    assert.equal(JSON.parse(job.failure).code, "JOB_ACTOR_UNAVAILABLE");
    assert.deepEqual(await closures(database, target.auth.userId), ["erased"], "the Job wrote nothing as the terminated human");
  });
});

test("a delayed reset request accepted before re-registration cannot reach the replacement account", async () => {
  await withRuntime(async (database) => {
    const admin = await register(database, "delay-admin@example.test");
    const original = await register(database, "delayed@example.test");
    await clearTeams(database, original);
    const requestedAt = new Date().toISOString();
    assert.equal((await call(database, admin, "terminate", [original.auth.userId])).error, null);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await register(database, "delayed@example.test", "replacement-password");
    const delivery = await prepareEmailPasswordResetDelivery(database, { email: "delayed@example.test", code: null, requestedAt });
    assert.equal(delivery, null, "the delayed request belongs to the terminated identity");
    assert.equal(await countRows(database, "sporades_auth_password_reset_codes", "email", "delayed@example.test"), 0);
    const fresh = await prepareEmailPasswordResetDelivery(database, { email: "delayed@example.test", code: null, requestedAt: new Date().toISOString() });
    assert.equal(fresh?.to, "delayed@example.test", "a request accepted after re-registration is delivered normally");

    // A Reset code bound to the old identity (for example one a racing writer inserted) can never
    // set the password of the account that later registered the same email.
    const selector = "stale-identity-selector-0001";
    const verifier = "stale-identity-verifier-000000000000000001";
    await database.adapter.insertPasswordResetCode({ selector, verifierHash: hashPasswordResetVerifier(verifier), email: "delayed@example.test", userId: original.auth.userId, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() });
    assert.equal((await confirmPasswordReset(database, null, `${selector}.${verifier}`, "attacker-password")).ok, false);
    assert.equal((await signIn(database, "delayed@example.test", "attacker-password")).ok, false);
    assert.equal((await signIn(database, "delayed@example.test", "replacement-password")).ok, true);
  });
});

async function proveAdapterTermination(serverEnv, runtimeConfig) {
  await withRuntime(async (database) => {
    const admin = await register(database, `admin-${randomUUID()}@example.test`);
    const email = `target-${randomUUID()}@example.test`;
    const target = await register(database, email);
    const code = await resetCode(database, email);
    await clearTeams(database, target);
    assert.equal((await call(database, admin, "terminateThenThrow", [target.auth.userId])).error?.message, "force rollback");
    assert.equal((await userRow(database, target.auth.userId)).lifecycleStatus, "active");
    assert.equal((await sessionUser(database, target.token)).userId, target.auth.userId);
    const result = await call(database, admin, "terminate", [target.auth.userId]);
    assert.equal(result.error, null, JSON.stringify(result.error));
    assert.deepEqual(result.data, { userId: target.auth.userId, status: "terminated" });
    assert.notEqual((await sessionUser(database, target.token)).userId, target.auth.userId);
    assert.equal((await signIn(database, email)).ok, false);
    assert.equal((await confirmPasswordReset(database, null, code, "attacker-password")).ok, false);
    assert.deepEqual((await call(database, admin, "terminate", [target.auth.userId])).data, { userId: target.auth.userId, status: "already-terminated" });
    const replacement = await register(database, email, "replacement-password");
    assert.notEqual(replacement.auth.userId, target.auth.userId);

    // Independently authorized surviving humans race: exactly one commits the transition.
    const secondAdmin = await register(database, `admin-two-${randomUUID()}@example.test`);
    const contested = await register(database, `contested-${randomUUID()}@example.test`);
    await clearTeams(database, contested);
    const raced = await Promise.all([
      call(database, admin, "terminate", [contested.auth.userId]),
      call(database, secondAdmin, "terminate", [contested.auth.userId]),
    ]);
    assert.deepEqual(raced.map((result) => result.error), [null, null], JSON.stringify(raced));
    assert.deepEqual(raced.map((result) => result.data.status).sort(), ["already-terminated", "terminated"]);
    assert.deepEqual((await closures(database, contested.auth.userId)), ["erased", "erased"]);
  }, serverEnv, runtimeConfig);
}

test("a terminated identity's replay result survives a runtime restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sporades-human-identity-restart-"));
  const open = () => openDevDatabase(path.join(dir, "data.db"), "", {}, config, definition);
  try {
    let database = await open();
    const admin = await register(database, "restart-admin@example.test");
    const target = await register(database, "restart-target@example.test");
    await clearTeams(database, target);
    assert.equal((await call(database, admin, "terminate", [target.auth.userId])).data.status, "terminated");
    await database.close();
    database = await open();
    try {
      assert.deepEqual((await call(database, admin, "terminate", [target.auth.userId])).data, { userId: target.auth.userId, status: "already-terminated" });
      assert.notEqual((await sessionUser(database, target.token)).userId, target.auth.userId);
      assert.equal((await userRow(database, target.auth.userId)).lifecycleStatus, "terminated", "startup repair never revives a tombstone");
    } finally { await database.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("SQLite terminates human identities through the shared adapter transition", async () => {
  await proveAdapterTermination({}, config);
});

test("libSQL terminates human identities through the shared adapter transition", async () => {
  await withLibsqlAdapter(async (_adapter, { url }) => {
    await proveAdapterTermination(
      { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url },
      { ...config, name: `human-identity-libsql-${randomUUID()}`, services: { database: { engine: "libsql" } } },
    );
  }, { isolateProcess: true });
});

test("Postgres terminates human identities through the shared adapter transition", { skip: POSTGRES_SKIP_REASON }, async () => {
  await withPostgresAdapter(async () => {
    await proveAdapterTermination(
      { SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL },
      { ...config, name: `human-identity-postgres-${randomUUID()}`, services: { database: { engine: "postgres" } } },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Live WebSocket connections and subscriptions through a real Dev session.
// ---------------------------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin", "sporades.js");
const WAIT_MS = 15_000;

function spawnCli(args, cwd) {
  return spawn(process.execPath, [cliPath, ...args], { cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
}

async function runCliToCompletion(args, cwd) {
  const child = spawnCli(args, cwd);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
}

function firstJsonLine(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for Dev.\n${stdout}\n${stderr}`)), WAIT_MS);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const line = stdout.split("\n").find((candidate) => candidate.trim());
      if (line) { clearTimeout(timeout); resolve(JSON.parse(line)); }
    });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Dev exited with ${code}.\n${stdout}\n${stderr}`)); });
  });
}

async function openSocket(baseUrl) {
  const page = await fetch(new URL("/", baseUrl), { headers: { "sec-fetch-dest": "document" } });
  const connectionToken = /window\.__SPORADES_CONNECTION_TOKEN="([^"]+)"/.exec(await page.text())?.[1];
  assert.ok(connectionToken);
  const url = new URL("/__sporades/ws", baseUrl);
  url.searchParams.set("connectionToken", connectionToken);
  const socket = new WebSocket(url);
  socket.received = [];
  socket.addEventListener("message", (event) => socket.received.push(JSON.parse(event.data)));
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return socket;
}

async function waitFor(socket, predicate) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const found = socket.received.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a WebSocket message. Received: ${JSON.stringify(socket.received)}`);
}

function send(socket, payload) {
  socket.send(JSON.stringify(payload));
  return waitFor(socket, (message) => message.id === payload.id);
}

test("committed termination moves every live connection and subscription off the terminated human", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sporades-human-identity-ws-"));
  let child;
  const sockets = [];
  try {
    await runCliToCompletion(["create", "closure-island", "--template", "todo", "--no-install", "--no-git", "--json"], dir);
    const projectDir = path.join(dir, "closure-island");
    const configPath = path.join(projectDir, "sporades.json");
    const projectConfig = JSON.parse(await readFile(configPath, "utf8"));
    projectConfig.dev.port = 0;
    projectConfig.auth = { providers: { anonymous: true, email: true } };
    await writeFile(configPath, `${JSON.stringify(projectConfig, null, 2)}\n`);
    await writeFile(path.join(projectDir, "server", "index.ts"), `import { capsule, mutation, query, String, table } from "sporades/server";

export default capsule({
  name: "closure-island",
  schema: { receipts: table({ userId: String() }) },
  queries: {
    whoami: query(async (ctx) => ({ userId: ctx.auth.userId, authenticated: ctx.auth.isAuthenticated, receipts: (await ctx.db.receipts.all()).length })),
  },
  mutations: {
    closeAccount: mutation(async (ctx) => {
      const termination = ctx.serverAuth.reserveTerminateHumanIdentity(ctx.auth.userId);
      const { teams } = await ctx.teams.list();
      for (const team of teams) await ctx.teams.delete(team.id);
      return ctx.lifecycle.continue(termination, async (result) => {
        await ctx.db.receipts.insert({ userId: result.userId });
        return result;
      });
    }),
  },
});
`);
    // The scaffolded React client is irrelevant here; a framework-free entry keeps the bundle offline.
    await writeFile(path.join(projectDir, "client", "index.tsx"), "export {};\n");
    child = spawnCli(["dev", "--json"], projectDir);
    const started = await firstJsonLine(child);
    assert.equal(started.ok, true, JSON.stringify(started));

    const closing = await openSocket(started.data.url);
    const other = await openSocket(started.data.url);
    sockets.push(closing, other);
    const signedUp = await send(closing, { id: "sign-up", type: "auth.signUp", provider: "email", credentials: { email: "live@example.test", password: PASSWORD } });
    assert.equal(signedUp.data?.ok, true, JSON.stringify(signedUp));
    const userId = signedUp.data.auth.userId;
    const signedIn = await send(other, { id: "sign-in", type: "auth.signIn", provider: "email", credentials: { email: "live@example.test", password: PASSWORD } });
    assert.equal(signedIn.data?.auth?.userId, userId, JSON.stringify(signedIn));
    assert.notEqual(signedIn.data.sessionToken, signedUp.data.sessionToken, "two independent Sessions");
    const subscribed = await send(other, { id: "watch", type: "query.subscribe", query: "whoami" });
    assert.equal(subscribed.data.userId, userId);

    const closed = await send(closing, { id: "close", type: "mutation.run", mutation: "closeAccount", args: [] });
    assert.deepEqual(closed.data, { userId, status: "terminated" }, JSON.stringify(closed));
    for (const socket of [closing, other]) {
      const replaced = await waitFor(socket, (message) => message.type === "auth.session.replace");
      assert.notEqual(replaced.data.auth.userId, userId);
      assert.equal(replaced.data.auth.isAuthenticated, false);
    }
    const closingIndex = closing.received.findIndex((message) => message.type === "auth.session.replace");
    assert.ok(closingIndex < closing.received.findIndex((message) => message.id === "close"), "the connection is replaced before the result is sent");
    const refreshed = await waitFor(other, (message) => message.type === "query.result" && message.data?.receipts === 1);
    assert.notEqual(refreshed.data.userId, userId, "the live subscription refreshes under the replacement actor");
    assert.equal(refreshed.data.authenticated, false);
    const stale = await send(other, { id: "stale", type: "auth.get", sessionToken: signedIn.data.sessionToken });
    assert.notEqual(stale.data.auth.userId, userId, "the old Session token never resolves to the terminated human");
    const relogin = await send(other, { id: "relogin", type: "auth.signIn", provider: "email", credentials: { email: "live@example.test", password: PASSWORD } });
    assert.equal(relogin.type, "error", "the old password cannot sign in");
  } finally {
    for (const socket of sockets) socket.close();
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("Postgres serializes sign-in and Team Join on another connection with an uncommitted termination", { skip: POSTGRES_SKIP_REASON }, async () => {
  await withPostgresAdapter(async () => {
    const serverEnv = { SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL };
    const runtimeConfig = { ...config, name: `human-identity-race-${randomUUID()}`, services: { database: { engine: "postgres" } } };
    const first = await openDevDatabase("", "", serverEnv, runtimeConfig, definition);
    const second = await openDevDatabase("", "", serverEnv, runtimeConfig, definition);
    try {
      const admin = await register(first, "race-admin@example.test");
      const target = await register(first, "race-target@example.test");
      const [adminTeam] = (await listCurrentUserTeams(first, admin.auth)).teams;
      const invitation = await createTeamJoinLink(first, admin.auth, adminTeam.id, "race-target@example.test");
      await clearTeams(first, target);
      let held;
      const heldPromise = new Promise((resolve) => { held = resolve; });
      let release;
      globalThis.__terminationRelease = new Promise((resolve) => { release = resolve; });
      globalThis.__terminationHeld = held;
      const termination = call(first, admin, "terminateAndHold", [target.auth.userId]);
      await heldPromise;
      // Both writers on the second connection must wait for the termination's user-row lock.
      const signInAttempt = signIn(second, "race-target@example.test");
      const joinAttempt = joinCurrentUserTeam(second, target.auth, new URL(invitation.link).searchParams.get("code")).then(() => "joined", (error) => error?.code);
      await new Promise((resolve) => setTimeout(resolve, 150));
      release();
      assert.deepEqual((await termination).data, { userId: target.auth.userId, status: "terminated" });
      assert.equal((await signInAttempt).ok, false, "a sign-in that verified the old password cannot mint a Session");
      assert.equal(await joinAttempt, "TEAM_JOIN_DENIED", "a Join that passed its email check cannot add a membership");
      assert.equal(await countRows(first, "sporades_team_memberships", "userId", target.auth.userId), 0);
      assert.equal(await countRows(first, "sporades_auth_sessions", "userId", target.auth.userId), 0);
    } finally {
      delete globalThis.__terminationHeld;
      delete globalThis.__terminationRelease;
      await second.close();
      await first.close();
    }
  });
});
