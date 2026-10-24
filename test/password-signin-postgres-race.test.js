import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  createEmailPasswordResetLink, createPostgresDatabaseAdapter, openDevDatabase,
  resolveAnonymousSession, setOwnEmailPassword, signInWithEmail, signUpWithEmail,
} from "../dist/server-runtime-source.js";
import { confirmPasswordReset } from "../dist/auth-runtime.js";
import { POSTGRES_SKIP_REASON, postgresTestUrl, resetPostgresSchema } from "./support/database-adapter-engines.js";

const email = "race@example.test";
const oldPassword = "original-password";
const newPassword = "replacement-password";

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Postgres race barrier timed out")), 10000);
    })]);
  } finally { clearTimeout(timer); }
}

// Wrap the actual transaction adapter, preserving its locks and commit/rollback.
// Barriers run after real storage operations; no mocked transaction semantics.
function interceptTransaction(database, method, after) {
  const original = database.adapter.withTransaction.bind(database.adapter);
  database.adapter.withTransaction = (run, ...options) => original(tx => run(new Proxy(tx, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === method) return async (...args) => {
        const result = await value.apply(target, args);
        await after(target, result);
        return result;
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  })), ...options);
  return () => { database.adapter.withTransaction = original; };
}

async function withContenders(run) {
  const setup = await createPostgresDatabaseAdapter({ url: postgresTestUrl() });
  try { await resetPostgresSchema(setup); } finally { await setup.close(); }
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-pg-password-race-"));
  const databases = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const database = await openDevDatabase(path.join(dir, `runtime-${index}`), "", {
        SPORADES_SERVICE_DATABASE_ENGINE: "postgres", SPORADES_SERVICE_DATABASE_URL: postgresTestUrl(),
      }, { name: "password-race", services: { database: { engine: "postgres" } }, auth: { providers: { email: true } } });
      databases.push(database);
      await database.init();
    }
    const [signer, changer] = databases;
    const registered = await signUpWithEmail(signer, await resolveAnonymousSession(signer, null), "email", { email, password: oldPassword });
    assert.equal(registered.ok, true);
    const guest = await resolveAnonymousSession(signer, null);
    const reset = await createEmailPasswordResetLink(changer, {}, email);
    assert.equal(reset.ok, true);
    const code = new URL(reset.link).searchParams.get("code");
    const pids = await Promise.all(databases.map(database => database.adapter.prepare("SELECT pg_backend_pid() AS pid").get()));
    await run({ signer, changer, guest, registered, code, pids: pids.map(row => Number(row.pid)) });
  } finally {
    for (const database of databases.reverse()) await database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// Observe PostgreSQL's actual lock wait from the held transaction's connection.
// This proves overlap without sleeps deciding the winning transaction, and uses
// exactly two connections throughout the race.
async function assertBlocked(held, waiter, holder, completed) {
  await held.run(async () => {
    const deadline = Date.now() + 10000;
    for (;;) {
      assert.ok(Date.now() < deadline, "Postgres lock wait was not observed");
      assert.equal(completed(), false, "the contender must wait for the retained credential/identity fence");
      const row = await held.tx.prepare("SELECT ? = ANY(pg_blocking_pids(?)) AS blocked").get(holder, waiter);
      if (row.blocked) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  });
}

function transition(kind, { changer, registered, code }) {
  return kind === "reset"
    ? confirmPasswordReset(changer, {}, code, newPassword)
    : setOwnEmailPassword(changer, { token: registered.sessionToken, auth: registered.auth }, email, oldPassword, newPassword);
}

for (const kind of ["reset", "browser change"]) {
  test(`Postgres ${kind} waits for verified sign-in issuance, then revokes its Session`, { skip: POSTGRES_SKIP_REASON }, async () => {
    await withContenders(async context => {
      const { signer, changer, guest, pids } = context;
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const restore = interceptTransaction(signer, "rotateAuthSession", async tx => {
        entered.resolve({ tx, run: AsyncLocalStorage.snapshot() });
        await release.promise;
      });
      const signing = signInWithEmail(signer, guest, { email, password: oldPassword });
      let changing;
      signing.catch(() => {});
      try {
        const held = await bounded(entered.promise);
        let completed = false;
        changing = transition(kind, context).finally(() => { completed = true; });
        changing.catch(() => {});
        await assertBlocked(held, pids[1], pids[0], () => completed);
      } finally {
        release.resolve();
        restore();
        await Promise.allSettled([signing, changing]);
      }
      const signed = await signing;
      assert.equal(signed.ok, true);
      assert.equal((await changing).ok, true);
      assert.equal(await changer.adapter.readAuthSessionWithUser(signed.sessionToken), null, "old-password Session cannot survive revocation");
      assert.equal((await signInWithEmail(signer, guest, { email, password: oldPassword })).ok, false);
      assert.equal((await signInWithEmail(signer, guest, { email, password: newPassword })).ok, true);
    });
  });

  test(`Postgres ${kind} commits before paused old-password sign-in and rejects its fingerprint`, { skip: POSTGRES_SKIP_REASON }, async () => {
    await withContenders(async context => {
      const { signer, guest, pids } = context;
      const verified = Promise.withResolvers();
      const resumePreflight = Promise.withResolvers();
      const read = signer.adapter.findEmailCredentialWithUser;
      signer.adapter.findEmailCredentialWithUser = async (...args) => {
        const row = await read.apply(signer.adapter, args);
        signer.adapter.findEmailCredentialWithUser = read;
        verified.resolve();
        await resumePreflight.promise;
        return row;
      };
      const changed = Promise.withResolvers();
      const releaseChange = Promise.withResolvers();
      const restore = interceptTransaction(context.changer, "updateEmailCredentialPassword", async tx => {
        changed.resolve({ tx, run: AsyncLocalStorage.snapshot() });
        await releaseChange.promise;
      });
      let completed = false;
      const signing = signInWithEmail(signer, guest, { email, password: oldPassword }).finally(() => { completed = true; });
      let changing;
      signing.catch(() => {});
      try {
        await bounded(verified.promise);
        changing = transition(kind, context);
        changing.catch(() => {});
        const held = await bounded(changed.promise);
        resumePreflight.resolve();
        await assertBlocked(held, pids[0], pids[1], () => completed);
      } finally {
        resumePreflight.resolve();
        releaseChange.resolve();
        signer.adapter.findEmailCredentialWithUser = read;
        restore();
        await Promise.allSettled([signing, changing]);
      }
      assert.equal((await changing).ok, true);
      const signed = await signing;
      assert.equal(signed.ok, false);
      assert.equal(signed.sessionToken, undefined, "superseded proof issues no Session");
      assert.equal(typeof signed.error.message, "string");
      assert.equal((await signInWithEmail(signer, guest, { email, password: newPassword })).ok, true);
    });
  });
}

for (const winner of ["reset", "browser change"]) {
  test(`Postgres ${winner} serializes with the competing password transition without deadlock`, { skip: POSTGRES_SKIP_REASON }, async () => {
    await withContenders(async context => {
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const restore = interceptTransaction(context.changer, "updateEmailCredentialPassword", async tx => {
        entered.resolve({ tx, run: AsyncLocalStorage.snapshot() });
        await release.promise;
      });
      const winning = transition(winner, context);
      winning.catch(() => {});
      let losing;
      try {
        const held = await bounded(entered.promise);
        let completed = false;
        losing = transition(winner === "reset" ? "browser change" : "reset", {
          ...context, changer: context.signer,
        }).finally(() => { completed = true; });
        losing.catch(() => {});
        await assertBlocked(held, context.pids[0], context.pids[1], () => completed);
      } finally {
        release.resolve();
        restore();
        await Promise.allSettled([winning, losing]);
      }
      assert.equal((await winning).ok, true);
      assert.equal((await losing).ok, false, "the superseded transition must fail closed");
      assert.equal(await context.signer.adapter.readAuthSessionWithUser(context.registered.sessionToken), null);
      assert.equal((await signInWithEmail(context.signer, context.guest, { email, password: newPassword })).ok, true);
    });
  });
}

test("Postgres browser change takes the identity fence before Access keys when termination owns it", { skip: POSTGRES_SKIP_REASON }, async () => {
  await withContenders(async context => {
    // Registration bootstraps a Team. Seed the membership-free identity that
    // terminal erasure requires, so termination reaches its key revocation.
    await context.changer.adapter.prepare('DELETE FROM sporades_team_memberships WHERE "userId" = ?').run(context.registered.auth.userId);
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const terminating = context.changer.adapter.withTransaction(async tx => {
      await tx.lockAuthUserFileAuthority(context.registered.auth.userId);
      entered.resolve({ tx, run: AsyncLocalStorage.snapshot() });
      await release.promise;
      return await tx.terminateHumanIdentity({
        userId: context.registered.auth.userId, revocationTime: () => new Date().toISOString(),
      });
    });
    terminating.catch(() => {});
    let changing;
    try {
      const held = await bounded(entered.promise);
      let completed = false;
      changing = transition("browser change", { ...context, changer: context.signer }).finally(() => { completed = true; });
      changing.catch(() => {});
      await assertBlocked(held, context.pids[0], context.pids[1], () => completed);
    } finally {
      release.resolve();
      await Promise.allSettled([terminating, changing]);
    }
    assert.equal((await terminating).status, "terminated", "termination must finish without a key-owner deadlock");
    assert.equal((await changing).ok, false);
    assert.equal(await context.signer.adapter.findEmailCredentialWithUser(email), null);
    assert.equal(await context.signer.adapter.readAuthSessionWithUser(context.registered.sessionToken), null);
  });
});
