import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  confirmPasswordReset,
  createControllableRuntimeClock,
  createEmailPasswordResetLink,
  hashPasswordResetVerifier,
  openDevDatabase,
  prepareEmailPasswordResetDelivery,
  resolveAnonymousSession,
  signInWithEmail,
  signUpWithEmail,
  runMutation,
  sendEmailPasswordResetLink,
  verifyPasswordResetCode,
} from "../dist/server-runtime-source.js";
import { mutation } from "../dist/server.js";

const emailAuthConfig = {
  name: "reset",
  auth: { providers: { email: { enabled: true } } },
};

async function withDatabase(config, run, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-password-reset-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, config, {}, options);
  try {
    return await run(database);
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function registerEmailAccount(database, email, password) {
  const session = await resolveAnonymousSession(database, null);
  const result = await signUpWithEmail(database, session, "email", { email, password });
  assert.equal(result.ok, true, result.error?.message);
  return result;
}

async function issueCode(database, session, email) {
  const result = await createEmailPasswordResetLink(database, session, email);
  assert.equal(result.ok, true, result.error?.message);
  return new URL(result.link).searchParams.get("code");
}

test("a Reset code is issued as a link to the Capsule reset page", async () => {
  await withDatabase(emailAuthConfig, async (database) => {
    await registerEmailAccount(database, "reset-user@example.com", "original-password");
    const session = await resolveAnonymousSession(database, null);

    const result = await createEmailPasswordResetLink(database, session, "reset-user@example.com");

    assert.equal(result.ok, true, result.error?.message);
    const link = new URL(result.link);
    assert.equal(link.pathname, "/reset-password", "the default Capsule reset page path is used");
    assert.ok(link.searchParams.get("code"), "the link carries the Reset code");
    assert.ok(Date.parse(result.expiresAt) > Date.now(), "the Reset code has a future expiry");
  });
});

test("verifying a Reset code reports the account and does not spend the code", async () => {
  await withDatabase(emailAuthConfig, async (database) => {
    await registerEmailAccount(database, "scanned@example.com", "original-password");
    const session = await resolveAnonymousSession(database, null);
    const code = await issueCode(database, session, "scanned@example.com");

    // A mail security product may fetch the link before the recipient does.
    const scanned = await verifyPasswordResetCode(database, session, code);
    const clicked = await verifyPasswordResetCode(database, session, code);

    assert.equal(scanned.ok, true, scanned.error?.message);
    assert.equal(scanned.email, "scanned@example.com");
    assert.equal(clicked.ok, true, "a scanned link must still work for the recipient");
    assert.equal(clicked.email, "scanned@example.com");
  });
});

test("confirming a reset sets the new password and spends the Reset code", async () => {
  await withDatabase(emailAuthConfig, async (database) => {
    await registerEmailAccount(database, "spender@example.com", "original-password");
    const session = await resolveAnonymousSession(database, null);
    const code = await issueCode(database, session, "spender@example.com");

    const confirmed = await confirmPasswordReset(database, session, code, "replacement-password");

    assert.equal(confirmed.ok, true, confirmed.error?.message);
    const withOldPassword = await signInWithEmail(database, await resolveAnonymousSession(database, null), {
      email: "spender@example.com",
      password: "original-password",
    });
    assert.equal(withOldPassword.ok, false, "the old password must stop working");
    const withNewPassword = await signInWithEmail(database, await resolveAnonymousSession(database, null), {
      email: "spender@example.com",
      password: "replacement-password",
    });
    assert.equal(withNewPassword.ok, true, withNewPassword.error?.message);

    const replayed = await confirmPasswordReset(database, session, code, "third-password");
    assert.equal(replayed.ok, false, "a spent Reset code must not be reusable");
    const replayVerify = await verifyPasswordResetCode(database, session, code);
    assert.equal(replayVerify.ok, false, "a spent Reset code must no longer verify");
  });
});

test("concurrent reset confirmations spend a Reset code once before changing the password", async () => {
  const row = {
    selector: "racing-reset-selector",
    verifierHash: hashPasswordResetVerifier("racing-reset-verifier"),
    email: "racing@example.com",
    userId: "racing-user",
    createdAt: "2031-03-01T09:00:00.000Z",
    expiresAt: "2031-03-01T10:00:00.000Z",
  };
  let codeRemains = true;
  let reads = 0;
  let activeTransactions = 0;
  const readInsideTransactions = [];
  let releaseReads;
  const bothContendersRead = new Promise((resolve) => {
    releaseReads = resolve;
  });
  const passwordUpdates = [];
  let sessionRevocations = 0;
  const adapter = {
    async findPasswordResetCode(selector) {
      if (selector !== row.selector) return null;
      readInsideTransactions.push(activeTransactions > 0);
      reads += 1;
      if (reads === 2) releaseReads();
      await bothContendersRead;
      // Both reads model transactions that took their snapshots before either
      // contender spent the code. The conditional delete decides the winner.
      return row;
    },
    async deletePasswordResetCode(selector) {
      if (selector !== row.selector || !codeRemains) return { changes: 0 };
      codeRemains = false;
      return { changes: 1 };
    },
    async deletePasswordResetCodesForUser(userId) {
      assert.equal(userId, row.userId);
      return { changes: 0 };
    },
    async updateEmailCredentialPassword(email, hash, salt) {
      passwordUpdates.push({ email, hash, salt });
      return { changes: 1 };
    },
    async deleteAuthSessionsForUser(userId) {
      assert.equal(userId, row.userId);
      sessionRevocations += 1;
      return { changes: 2 };
    },
    async withTransaction(run) {
      activeTransactions += 1;
      try {
        return await run(adapter);
      } finally {
        activeTransactions -= 1;
      }
    },
  };
  const database = {
    authConfig: { providers: { email: { enabled: true } } },
    adapter,
    clock: { now: () => new Date("2031-03-01T09:30:00.000Z") },
  };
  const session = {};
  const code = `${row.selector}.racing-reset-verifier`;

  const results = await Promise.all([
    confirmPasswordReset(database, session, code, "winner-password"),
    confirmPasswordReset(database, session, code, "loser-password"),
  ]);

  assert.deepEqual(results.map((result) => result.ok).sort(), [false, true]);
  assert.equal(readInsideTransactions.filter(Boolean).length, 2, "each contender revalidates the code inside its Auth transaction");
  assert.equal(readInsideTransactions.filter((insideTransaction) => !insideTransaction).length, 2, "the cheap preflight does not authorize the reset");
  assert.equal(passwordUpdates.length, 1, "the contender that loses consumption cannot update the password");
  assert.equal(sessionRevocations, 1, "only the successful confirmation revokes Sessions");
  assert.equal(codeRemains, false);
});

test("a stale Reset code cannot consume a newly issued sibling", async () => {
  const staleRow = {
    selector: "stale-reset-selector",
    verifierHash: hashPasswordResetVerifier("stale-reset-verifier"),
    email: "stale@example.com",
    userId: "stale-user",
    createdAt: "2031-03-01T09:00:00.000Z",
    expiresAt: "2031-03-01T10:00:00.000Z",
  };
  let replacementCodeRemains = true;
  let passwordUpdates = 0;
  let sessionRevocations = 0;
  const adapter = {
    // A transaction that began before another request replaced the code can
    // still read this old row from its snapshot.
    async findPasswordResetCode(selector) {
      return selector === staleRow.selector ? staleRow : null;
    },
    async deletePasswordResetCode(selector) {
      assert.equal(selector, staleRow.selector);
      return { changes: 0 };
    },
    async deletePasswordResetCodesForUser(userId) {
      assert.equal(userId, staleRow.userId);
      const changes = replacementCodeRemains ? 1 : 0;
      replacementCodeRemains = false;
      return { changes };
    },
    async updateEmailCredentialPassword() {
      passwordUpdates += 1;
      return { changes: 1 };
    },
    async deleteAuthSessionsForUser() {
      sessionRevocations += 1;
      return { changes: 1 };
    },
    async withTransaction(run) {
      return await run(adapter);
    },
  };
  const database = {
    authConfig: { providers: { email: { enabled: true } } },
    adapter,
    clock: { now: () => new Date("2031-03-01T09:30:00.000Z") },
  };

  const result = await confirmPasswordReset(
    database,
    {},
    `${staleRow.selector}.stale-reset-verifier`,
    "replacement-password",
  );

  assert.equal(result.ok, false);
  assert.equal(replacementCodeRemains, true, "a stale reset must not delete the newer sibling code");
  assert.equal(passwordUpdates, 0);
  assert.equal(sessionRevocations, 0);
});

test("confirming a reset revokes every existing Session for that account", async () => {
  await withDatabase(emailAuthConfig, async (database) => {
    const registered = await registerEmailAccount(database, "evicted@example.com", "original-password");
    const attacker = await signInWithEmail(database, await resolveAnonymousSession(database, null), {
      email: "evicted@example.com",
      password: "original-password",
    });
    assert.equal(attacker.ok, true, attacker.error?.message);

    const session = await resolveAnonymousSession(database, null);
    const code = await issueCode(database, session, "evicted@example.com");
    const confirmed = await confirmPasswordReset(database, session, code, "replacement-password");
    assert.equal(confirmed.ok, true, confirmed.error?.message);

    for (const [label, token] of [["the owner's", registered.sessionToken], ["the attacker's", attacker.sessionToken]]) {
      const resolved = await resolveAnonymousSession(database, token);
      assert.equal(resolved.auth.isAuthenticated, false, `${label} Session must not survive the reset`);
    }
  });
});

test("a Reset code with a valid selector but a wrong verifier is rejected", async () => {
  await withDatabase(emailAuthConfig, async (database) => {
    await registerEmailAccount(database, "guessed@example.com", "original-password");
    const session = await resolveAnonymousSession(database, null);
    const code = await issueCode(database, session, "guessed@example.com");
    const [selector] = code.split(".");

    const guessed = await verifyPasswordResetCode(database, session, `${selector}.wrong-verifier`);

    assert.equal(guessed.ok, false, "knowing the selector must not be enough");
    assert.equal(guessed.error.code, "INVALID_PASSWORD_RESET_CODE");
    const unknown = await verifyPasswordResetCode(database, session, "unknown-selector.wrong-verifier");
    assert.deepEqual(unknown.error, guessed.error, "a wrong verifier and an unknown selector must be indistinguishable");
  });
});

test("a Reset code stops working once it expires", async () => {
  const clock = createControllableRuntimeClock("2031-03-01T09:00:00.000Z");
  await withDatabase(emailAuthConfig, async (database) => {
    await registerEmailAccount(database, "stale@example.com", "original-password");
    const session = await resolveAnonymousSession(database, null);
    const code = await issueCode(database, session, "stale@example.com");

    clock.advanceBy(59 * 60 * 1000);
    const beforeExpiry = await verifyPasswordResetCode(database, session, code);
    clock.advanceBy(2 * 60 * 1000);
    const afterExpiry = await verifyPasswordResetCode(database, session, code);

    assert.equal(beforeExpiry.ok, true, "the code is valid within the default one-hour window");
    assert.equal(afterExpiry.ok, false, "the code must not outlive its expiry");
    const confirmed = await confirmPasswordReset(database, session, code, "replacement-password");
    assert.equal(confirmed.ok, false, "an expired code must not be spendable");
  }, { clock });
});

test("outstanding Reset codes per account are capped without invalidating earlier codes", async () => {
  await withDatabase(emailAuthConfig, async (database) => {
    await registerEmailAccount(database, "flooded@example.com", "original-password");
    const session = await resolveAnonymousSession(database, null);
    const firstCode = await issueCode(database, session, "flooded@example.com");
    for (let issued = 1; issued < 5; issued += 1) {
      await issueCode(database, session, "flooded@example.com");
    }

    const overCap = await createEmailPasswordResetLink(database, session, "flooded@example.com");

    assert.equal(overCap.ok, false, "a sixth outstanding code must be refused");
    assert.equal(overCap.error.code, "PASSWORD_RESET_LIMIT_REACHED");
    const stillValid = await verifyPasswordResetCode(database, session, firstCode);
    assert.equal(stillValid.ok, true, "issuing more codes must not invalidate a link the user is about to click");
  });
});

test("creating a link for an unregistered email fails, because the caller asked for a link", async () => {
  await withDatabase(emailAuthConfig, async (database) => {
    const session = await resolveAnonymousSession(database, null);

    const result = await createEmailPasswordResetLink(database, session, "never-registered@example.com");

    assert.equal(result.ok, false, "the server-only create call cannot invent a link");
  });
});

const smtpConfig = {
  smtp: {
    vendor: "generic",
    host: "smtp.example.com",
    port: 587,
    tls: { mode: "required-starttls", rejectUnauthorized: true },
    auth: { method: "PLAIN", usernameEnv: "SMTP_USERNAME", passwordEnv: "SMTP_PASSWORD" },
    defaultFrom: "Notes <mail@example.com>",
  },
};

const capsuleUser = {
  userId: "capsule-caller",
  displayName: "Capsule caller",
  email: null,
  picture: null,
  isAuthenticated: false,
  isGuest: true,
  provider: "anonymous",
};

test("the delivered reset mail carries a working link on the configured origin and path", async () => {
  const sent = [];
  const config = {
    name: "delivery",
    mail: smtpConfig,
    __sporadesPublicOrigin: "https://notes.example.com",
    auth: {
      providers: { email: { enabled: true } },
      email: { passwordReset: { path: "/account/new-password" } },
    },
  };
  const capsule = {
    mutations: {
      requestReset: mutation((ctx, email) => ctx.serverAuth.sendEmailPasswordResetLink(email)),
    },
  };
  const deliveryClock = createControllableRuntimeClock("2031-05-01T10:00:00.000Z");
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-password-reset-mail-"));
  const database = await openDevDatabase(
    path.join(dir, "data.db"),
    "",
    { SMTP_USERNAME: "user-secret", SMTP_PASSWORD: "password-secret" },
    config,
    capsule,
    {
      clock: deliveryClock,
      mailTransportFactory: () => ({
        async send(message) {
          sent.push(message);
          return { messageId: "<reset@example.com>", accepted: ["owner@example.com"], rejected: [] };
        },
        close() {},
      }),
    },
  );
  try {
    await registerEmailAccount(database, "owner@example.com", "original-password");

    const result = await runMutation(database, capsuleUser, "requestReset", ["owner@example.com"]);
    assert.equal(result.ok, true, result.error?.message);
    await drainJobQueue(deliveryClock);

    assert.equal(sent.length, 1, "exactly one reset mail is delivered");
    assert.deepEqual(sent[0].to, [{ email: "owner@example.com" }]);
    const body = `${sent[0].textBody ?? ""}${sent[0].htmlBody ?? ""}`;
    const link = body.match(/https:\/\/notes\.example\.com\/account\/new-password\?code=[^\s"<]+/);
    assert.ok(link, `the mail must carry the configured origin and path, got: ${body}`);

    // The mailed link must be the real code, not merely a well-formed URL.
    const mailedCode = new URL(link[0]).searchParams.get("code");
    const session = await resolveAnonymousSession(database, null);
    const verified = await verifyPasswordResetCode(database, session, mailedCode);
    assert.equal(verified.ok, true, "the code in the delivered mail must be usable");
    assert.equal(verified.email, "owner@example.com");
  } finally {
    await database.shutdown();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("sending fails with an actionable error when SMTP is not configured", async () => {
  await withDatabase(emailAuthConfig, async (database) => {
    await registerEmailAccount(database, "no-smtp@example.com", "original-password");
    const session = await resolveAnonymousSession(database, null);

    const sent = await sendEmailPasswordResetLink(database, session, "no-smtp@example.com");
    const created = await createEmailPasswordResetLink(database, session, "no-smtp@example.com");

    assert.equal(sent.ok, false, "delivery needs a transport");
    assert.equal(sent.error.code, "MAIL_NOT_CONFIGURED");
    assert.match(sent.error.hint, /mail\.smtp/);
    assert.equal(created.ok, true, "creating a link must still work without SMTP");
  });
});

// The Job worker re-arms itself, so drain until the queue stops scheduling work.
async function drainJobQueue(clock, passes = 5) {
  for (let pass = 0; pass < passes; pass += 1) {
    clock.advanceBy(1);
    await clock.runDueTimers();
  }
}

async function withMailDatabase(run, transport) {
  const clock = createControllableRuntimeClock("2031-05-01T10:00:00.000Z");
  const config = {
    name: "queued-delivery",
    mail: smtpConfig,
    __sporadesPublicOrigin: "https://notes.example.com",
    auth: { providers: { email: { enabled: true } } },
  };
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-password-reset-job-"));
  const database = await openDevDatabase(
    path.join(dir, "data.db"),
    "",
    { SMTP_USERNAME: "user-secret", SMTP_PASSWORD: "password-secret" },
    config,
    {},
    { mailTransportFactory: () => transport, clock },
  );
  try {
    return await run(database, clock);
  } finally {
    await database.shutdown();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("reset mail leaves the request path and is delivered by a durable Job", async () => {
  const sent = [];
  await withMailDatabase(async (database, clock) => {
    await registerEmailAccount(database, "queued@example.com", "original-password");
    const session = await resolveAnonymousSession(database, null);

    const result = await sendEmailPasswordResetLink(database, session, "queued@example.com");

    assert.equal(result.ok, true, result.error?.message);
    assert.equal(sent.length, 0, "SMTP must not run inside the request path");

    await drainJobQueue(clock);

    assert.equal(sent.length, 1, "the queued Job delivers the mail");
    const body = `${sent[0].textBody ?? ""}${sent[0].htmlBody ?? ""}`;
    assert.match(body, /https:\/\/notes\.example\.com\/reset-password\?code=/);
  }, {
    async send(message) {
      sent.push(message);
      return { messageId: "<queued@example.com>", accepted: ["queued@example.com"], rejected: [] };
    },
    close() {},
  });
});

test("an SMTP delivery failure does not tell the caller whether the address is registered", async () => {
  await withMailDatabase(async (database) => {
    await registerEmailAccount(database, "registered@example.com", "original-password");
    const session = await resolveAnonymousSession(database, null);

    const known = await sendEmailPasswordResetLink(database, session, "registered@example.com");
    const unknown = await sendEmailPasswordResetLink(database, session, "never-registered@example.com");

    assert.deepEqual(known, unknown, "a broken transport must not become an enumeration oracle");
    assert.equal(known.ok, true);
  }, {
    async send() {
      throw new Error("SMTP delivery failed.");
    },
    close() {},
  });
});

test("a password reset request Job retries SMTP delivery with one Reset code", async () => {
  const attemptedBodies = [];
  await withMailDatabase(async (database, clock) => {
    await registerEmailAccount(database, "retry-delivery@example.com", "original-password");
    const session = await resolveAnonymousSession(database, null);

    await sendEmailPasswordResetLink(database, session, "retry-delivery@example.com");
    await drainJobQueue(clock);

    let job = database.adapter.prepare(
      "SELECT [status], [attempts] FROM [sporades_jobs] WHERE [handler] = ?",
    ).get("_sporades_password_reset_request");
    assert.equal(job.status, "delayed", "the first SMTP failure must schedule a retry");
    assert.equal(job.attempts, 1);
    assert.equal(
      database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_password_reset_codes] WHERE [email] = ?").get("retry-delivery@example.com").count,
      1,
    );

    clock.advanceBy(1_001);
    await clock.runDueTimers();

    job = database.adapter.prepare(
      "SELECT [status], [attempts] FROM [sporades_jobs] WHERE [handler] = ?",
    ).get("_sporades_password_reset_request");
    assert.equal(job.status, "succeeded");
    assert.equal(job.attempts, 2);
    assert.equal(new Set(attemptedBodies).size, 1, "the retry must resend the same Reset link");
    assert.equal(
      database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_password_reset_codes] WHERE [email] = ?").get("retry-delivery@example.com").count,
      1,
      "the retry must not create another Reset row",
    );
  }, {
    async send(message) {
      attemptedBodies.push(`${message.textBody ?? ""}${message.htmlBody ?? ""}`);
      if (attemptedBodies.length === 1) throw new Error("SMTP unavailable");
      return { messageId: "<retry-delivery@example.com>", accepted: ["retry-delivery@example.com"], rejected: [] };
    },
    close() {},
  });
});

test("a retried reset request cannot resurrect a code consumed after its first send", async () => {
  let attemptedDeliveries = 0;
  let spentCode;
  let runtimeDatabase;
  await withMailDatabase(async (database, clock) => {
    runtimeDatabase = database;
    await registerEmailAccount(database, "spent-during-retry@example.com", "original-password");
    const session = await resolveAnonymousSession(database, null);

    await sendEmailPasswordResetLink(database, session, "spent-during-retry@example.com");
    await drainJobQueue(clock);

    assert.ok(spentCode, "the first delivery attempt must have issued a Reset code");
    const afterSpend = await verifyPasswordResetCode(database, await resolveAnonymousSession(database, null), spentCode);
    assert.equal(afterSpend.ok, false, "the first attempt spent the delivered code before its retry");

    clock.advanceBy(1_001);
    await clock.runDueTimers();

    const job = database.adapter.prepare(
      "SELECT [status], [attempts] FROM [sporades_jobs] WHERE [handler] = ?",
    ).get("_sporades_password_reset_request");
    assert.equal(job.status, "succeeded");
    assert.equal(job.attempts, 2);
    assert.equal(attemptedDeliveries, 1, "the retry must no-op instead of sending a resurrected link");
    assert.equal(
      database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_password_reset_codes] WHERE [email] = ?").get("spent-during-retry@example.com").count,
      0,
      "the retry must not recreate the consumed Reset row",
    );
  }, {
    async send(message) {
      attemptedDeliveries += 1;
      const match = String(message.textBody ?? "").match(/[?&]code=([^\s]+)/);
      spentCode = decodeURIComponent(match?.[1] ?? "");
      const spent = await confirmPasswordReset(runtimeDatabase, await resolveAnonymousSession(runtimeDatabase, null), spentCode, "replacement-password");
      assert.equal(spent.ok, true, spent.error?.message);
      throw new Error("SMTP connection dropped after acceptance");
    },
    close() {},
  });
});

test("registered and unregistered reset requests each enqueue one durable request Job", async () => {
  const sent = [];
  await withMailDatabase(async (database, clock) => {
    await registerEmailAccount(database, "registered@example.com", "original-password");
    const session = await resolveAnonymousSession(database, null);

    await sendEmailPasswordResetLink(database, session, "registered@example.com");
    await sendEmailPasswordResetLink(database, session, "never-registered@example.com");

    const jobs = database.adapter.prepare(
      "SELECT [payload] FROM [sporades_jobs] WHERE [handler] = ? ORDER BY [createdAt], [id]",
    ).all("_sporades_password_reset_request");
    assert.equal(jobs.length, 2, "every public reset request must perform the same durable enqueue");
    assert.deepEqual(
      jobs.map((job) => Object.keys(JSON.parse(job.payload)).sort()),
      Array.from({ length: 2 }, () => ["code", "email", "htmlBody", "subject", "textBody"]),
      "both public paths enqueue the identical request shape",
    );

    await drainJobQueue(clock);
    assert.deepEqual(sent.map((message) => message.to), [[{ email: "registered@example.com" }]], "unknown accounts must complete their Job without mail");
    assert.equal(
      database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_password_reset_codes]").get().count,
      1,
      "an unknown request must not create a cover Reset row",
    );
  }, {
    async send(message) {
      sent.push(message);
      return { messageId: "<registered@example.com>", accepted: ["registered@example.com"], rejected: [] };
    },
    close() {},
  });
});

test("retrying a durable reset request reuses its one Reset code", async () => {
  await withMailDatabase(async (database) => {
    await registerEmailAccount(database, "retry@example.com", "original-password");
    const payload = {
      email: "retry@example.com",
      code: `${"selector".padEnd(16, "x")}.${"verifier".padEnd(32, "x")}`,
      subject: "Reset your password",
      textBody: null,
      htmlBody: null,
    };

    const first = await prepareEmailPasswordResetDelivery(database, payload);
    const retried = await prepareEmailPasswordResetDelivery(database, payload);

    assert.equal(retried.textBody, first.textBody, "a retry must resend the same opaque Reset link");
    assert.equal(
      database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_auth_password_reset_codes] WHERE [email] = ?").get("retry@example.com").count,
      1,
      "a retry must not consume another outstanding-code slot",
    );
  }, { async send() {}, close() {} });
});
