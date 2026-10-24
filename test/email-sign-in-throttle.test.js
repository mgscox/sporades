import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  confirmPasswordReset, createEmailPasswordResetLink, openDevDatabase,
  resolveAnonymousSession, signInWithEmail, signUpWithEmail,
} from "../dist/server-runtime-source.js";
import {
  currentEmailSignInThrottleState, recordFailedEmailSignInAttempt,
  PASSWORD_CHANGE_THROTTLE_FIELD, PASSWORD_RESET_THROTTLE_FIELD,
} from "../dist/auth-runtime.js";

const email = "owner@example.test";
const password = "correct synthetic password";
const config = { auth: { providers: { anonymous: true, email: true } } };

async function fixture(t, mode, run) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2030-01-01T00:00:00.000Z") });
  const root = await mkdtemp(path.join(process.cwd(), ".agent-tmp-email-sign-in-"));
  const db = await openDevDatabase(path.join(root, "data.db"), "", {}, config);
  try {
    db.securitySession = mode;
    const registered = await signUpWithEmail(db, await resolveAnonymousSession(db, null), "email", { email, password });
    assert.equal(registered.ok, true, registered.error?.message);
    // Count actual password-verification work, after fixture registration's hash.
    const crypto = process.getBuiltinModule("node:crypto");
    const scrypt = crypto.scryptSync;
    let verifications = 0;
    t.mock.method(crypto, "scryptSync", (...args) => {
      verifications++;
      return scrypt(...args);
    });
    await run(db, () => verifications);
  } finally {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function caller(db, address = "192.0.2.2") {
  return { ...await resolveAnonymousSession(db, null), clientAddress: address };
}
const signIn = (db, session, suppliedPassword = password, suppliedEmail = email) =>
  signInWithEmail(db, session, { email: suppliedEmail, password: suppliedPassword });

for (const mode of ["dev", "hosted"]) {
  test(`${mode}: another caller's five failures cannot veto the owner's valid password`, async t => {
    await fixture(t, mode, async (db, calls) => {
      const attacker = await caller(db, "192.0.2.1");
      for (let i = 0; i < 5; i++) assert.equal((await signIn(db, attacker, "wrong password")).ok, false);
      const owner = await signIn(db, await caller(db));
      assert.equal(owner.ok, true, owner.error?.message);
      assert.equal(calls(), 6);
      const blocked = await signIn(db, attacker);
      assert.equal(blocked.error.code, "INVALID_EMAIL_CREDENTIALS");
      assert.equal(calls(), 6, "owner success must not refund the attacker's gate");
      t.mock.timers.tick(15 * 60 * 1000 - 1);
      assert.equal((await signIn(db, attacker)).ok, false);
      t.mock.timers.tick(1);
      assert.equal((await signIn(db, attacker)).ok, true, "caller/address gates expire at the exact boundary");
    });
  });
}

test("rotating Anonymous tokens cannot exceed 120 verifications per fixed minute", async t => {
  await fixture(t, "dev", async (db, calls) => {
    const blockedCaller = await caller(db);
    for (let i = 0; i < 5; i++) await signIn(db, blockedCaller, "wrong password");
    for (let i = 0; i < 10; i++) assert.equal((await signIn(db, blockedCaller)).ok, false);
    assert.equal(calls(), 5, "caller rejections do not hash or consume process slots");
    t.mock.timers.tick(30000);
    for (let i = 5; i < 119; i++) {
      const result = await signIn(db, await caller(db), "wrong password");
      assert.equal(result.ok, false);
      assert.equal(result.error.code, undefined, "a credential check still ran");
    }
    // A transaction wrapper must use the same admission state as its root runtime.
    const wrapper = Object.assign(Object.create(db), { __rootDatabase: db });
    assert.equal((await signIn(wrapper, await caller(db))).ok, true, "the final slot can verify a valid password");
    assert.equal(calls(), 120);
    for (const suppliedEmail of [email, "absent@example.test"]) {
      const refused = await signIn(db, await caller(db), password, suppliedEmail);
      assert.equal(refused.error.code, "INVALID_EMAIL_CREDENTIALS");
      assert.equal(refused.error.message, "Email or password is incorrect.");
    }
    assert.equal(calls(), 120, "success does not refund process capacity");
    t.mock.timers.tick(29999);
    assert.equal((await signIn(db, await caller(db))).ok, false);
    t.mock.timers.tick(1);
    assert.equal((await signIn(db, await caller(db))).ok, true);
    assert.equal(calls(), 121, "capacity recovers at the fixed window boundary");
    // Unknown-account attempts also reserve slots before credential lookup.
    for (let i = 0; i < 119; i++) await signIn(db, await caller(db), password, `absent-${i}@example.test`);
    assert.equal((await signIn(db, await caller(db))).ok, false);
    assert.equal(calls(), 121);
  });
});

test("concurrent callers reserve verification capacity before any credential lookup completes", async t => {
  await fixture(t, "dev", async (db, calls) => {
    const sessions = await Promise.all(Array.from({ length: 125 }, () => caller(db)));
    const find = db.adapter.findEmailCredentialWithUser.bind(db.adapter);
    let release;
    const pendingLookup = new Promise(resolve => { release = resolve; });
    let lookups = 0;
    t.mock.method(db.adapter, "findEmailCredentialWithUser", async suppliedEmail => {
      lookups++;
      await pendingLookup;
      return find(suppliedEmail);
    });
    const attempts = sessions.map(session => signIn(db, session, "wrong password"));
    const admittedBeforeLookupCompleted = lookups;
    release();
    const results = await Promise.all(attempts);
    assert.equal(admittedBeforeLookupCompleted, 120, "admission is reserved before the first adapter await");
    assert.equal(calls(), 120);
    assert.equal(results.filter(result => result.error.code === "INVALID_EMAIL_CREDENTIALS").length, 5);
    assert.ok(results.every(result => result.ok === false && result.error.message === "Email or password is incorrect."));
  });
});

test("verified reset clears only its email risk entry; invalid reset leaves all gates intact", async t => {
  await fixture(t, "hosted", async (db) => {
    const attacker = await caller(db, "192.0.2.1");
    for (let i = 0; i < 5; i++) await signIn(db, attacker, "wrong password");
    await signIn(db, await caller(db, "192.0.2.3"), "wrong password", "other@example.test");
    for (const scope of [PASSWORD_CHANGE_THROTTLE_FIELD, PASSWORD_RESET_THROTTLE_FIELD]) {
      recordFailedEmailSignInAttempt(db, email, attacker, scope);
    }
    const before = structuredClone(db.__emailSignInThrottle);
    const otherScopes = [db[PASSWORD_CHANGE_THROTTLE_FIELD], db[PASSWORD_RESET_THROTTLE_FIELD]].map(map => structuredClone(map));
    const link = await createEmailPasswordResetLink(db, attacker, email);
    assert.equal(link.ok, true);
    const code = new URL(link.link).searchParams.get("code");
    assert.equal((await confirmPasswordReset(db, attacker, `${code}-wrong`, "replacement password")).ok, false);
    assert.deepEqual(db.__emailSignInThrottle, before);
    const confirmed = await confirmPasswordReset(db, attacker, code, "replacement password");
    assert.equal(confirmed.ok, true, confirmed.error?.message);
    before.delete(`email\0${email}`);
    assert.deepEqual(db.__emailSignInThrottle, before, "reset changes no caller/address or other-email entry");
    assert.deepEqual([db[PASSWORD_CHANGE_THROTTLE_FIELD], db[PASSWORD_RESET_THROTTLE_FIELD]], otherScopes);
    assert.equal((await signIn(db, attacker, "replacement password")).ok, false);
    assert.equal((await signIn(db, await caller(db), "replacement password")).ok, true);
    const after = structuredClone(db.__emailSignInThrottle);
    assert.equal((await confirmPasswordReset(db, attacker, code, "another password")).ok, false);
    assert.deepEqual(db.__emailSignInThrottle, after, "spent reset changes no throttle state");
  });
});

test("reset does not refund process capacity exhausted against another account", async t => {
  await fixture(t, "dev", async db => {
    for (let i = 0; i < 120; i++) await signIn(db, await caller(db), password, `absent-${i}@example.test`);
    const link = await createEmailPasswordResetLink(db, await caller(db), email);
    const code = new URL(link.link).searchParams.get("code");
    assert.equal((await confirmPasswordReset(db, await caller(db), code, "replacement password")).ok, true);
    assert.equal((await signIn(db, await caller(db), "replacement password")).ok, false);
    t.mock.timers.tick(60000);
    assert.equal((await signIn(db, await caller(db), "replacement password")).ok, true);
  });
});

test("email risk remains bounded and expiring without changing password-change/reset policy", async t => {
  await fixture(t, "dev", async db => {
    const attacker = { token: "attacker" };
    for (const scope of [undefined, PASSWORD_CHANGE_THROTTLE_FIELD, PASSWORD_RESET_THROTTLE_FIELD]) {
      for (let i = 0; i < 5; i++) recordFailedEmailSignInAttempt(db, email, attacker, scope);
      assert.equal(currentEmailSignInThrottleState(db, email, { token: "owner" }, scope).throttled, scope !== undefined);
    }
    for (let i = 0; i < 300; i++) recordFailedEmailSignInAttempt(db, `filler-${i}@example.test`, { token: `filler-${i}` });
    assert.equal(db.__emailSignInThrottle.size, 256);
    assert.equal(db.__emailSignInThrottle.get(`email\0${email}`).count, 5);
    assert.equal((await signIn(db, await caller(db))).ok, true);
    t.mock.timers.tick(15 * 60 * 1000);
    for (const scope of [undefined, PASSWORD_CHANGE_THROTTLE_FIELD, PASSWORD_RESET_THROTTLE_FIELD]) {
      assert.equal(currentEmailSignInThrottleState(db, email, attacker, scope).throttled, false);
    }
    assert.equal(db.__emailSignInThrottle.size, 0);
  });
});
