import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { validateMailConfig } from "../dist/cli/project-config.js";
import { openDevDatabase, runMutation, runQuery, SERVER_RUNTIME_SOURCE_FUNCTIONS } from "../dist/server-runtime-source.js";
import { job, mutation, query } from "../dist/server.js";
import { createServerBundleSource } from "../dist/templates/server-bundle-template.js";

const runEndpoint = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "runEndpoint");
const runAppMessage = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "runAppMessage");
const createTableAclContext = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "createTableAclContext");
const buildSmtpMessage = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "buildSmtpMessage");

const user = {
  userId: "mail-user",
  displayName: "Mail user",
  email: "mail-user@example.com",
  picture: null,
  isAuthenticated: true,
  isGuest: false,
  provider: "test",
};

const smtpConfig = {
  mail: {
    smtp: {
      vendor: "generic",
      host: "smtp.example.com",
      port: 587,
      tls: { mode: "required-starttls", rejectUnauthorized: true },
      auth: {
        method: "PLAIN",
        usernameEnv: "SMTP_USERNAME",
        passwordEnv: "SMTP_PASSWORD",
      },
      defaultFrom: "Sporades <mail@example.com>",
      connectionTimeoutMs: 10_000,
      socketTimeoutMs: 30_000,
    },
  },
};

async function withDatabase(config, capsule, options, run) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-mail-"));
  const database = await openDevDatabase(
    path.join(dir, "data.db"),
    "",
    { SMTP_USERNAME: "user-secret", SMTP_PASSWORD: "password-secret" },
    config,
    capsule,
    options,
  );
  try {
    return await run(database);
  } finally {
    await database.shutdown();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("mail.smtp configuration rejects ambiguous, incomplete, and unsafe declarations", () => {
  assert.doesNotThrow(() => validateMailConfig(undefined));
  assert.doesNotThrow(() => validateMailConfig(smtpConfig.mail));

  const invalid = [
    [{ smtp: { ...smtpConfig.mail.smtp, port: 0 } }, /Invalid SMTP port/],
    [{ smtp: { ...smtpConfig.mail.smtp, secure: true } }, /Invalid SMTP configuration/],
    [{ smtp: { ...smtpConfig.mail.smtp, tls: { mode: "required-starttls", secure: true } } }, /Invalid SMTP TLS configuration/],
    [{ smtp: { ...smtpConfig.mail.smtp, connectionTimeoutMs: 0 } }, /Invalid SMTP connection timeout/],
    [{ smtp: { ...smtpConfig.mail.smtp, auth: { ...smtpConfig.mail.smtp.auth, usernameEnv: "bad-name" } } }, /Invalid SMTP Server env reference/],
    [{ smtp: { ...smtpConfig.mail.smtp, auth: { usernameEnv: "SMTP_USERNAME" } } }, /Invalid SMTP authentication configuration/],
  ];
  for (const [mail, expected] of invalid) assert.throws(() => validateMailConfig(mail), expected);
});

test("ctx.mail remains present while disabled and returns a stable error", async () => {
  await withDatabase({ name: "disabled-mail" }, {
    mutations: {
      send: mutation((ctx) => ctx.mail.send({
        to: "recipient@example.com",
        subject: "Hello",
        textBody: "World",
        from: "sender@example.com",
      })),
    },
  }, {}, async (database) => {
    const result = await runMutation(database, user, "send", []);
    assert.equal(result.ok, false);
    assert.deepEqual(result.error, {
      code: "MAIL_DISABLED",
      message: "Mail delivery is disabled.",
      hint: "Configure `mail.smtp` in sporades.json and restart the Capsule runtime.",
    });
  });
});

test("ctx.mail validates messages before using the captured SMTP transport and normalizes success", async () => {
  const captured = [];
  let capturedSmtp;
  const transport = {
    async send(message) {
      captured.push(message);
      return {
        messageId: "<captured@example.com>",
        accepted: ["to@example.com", "copy@example.com"],
        rejected: ["blocked@example.com"],
      };
    },
    close() {},
  };
  const capsule = {
    mutations: {
      send: mutation((ctx, message) => ctx.mail.send(message)),
    },
  };
  await withDatabase(smtpConfig, capsule, { mailTransportFactory: (smtp) => { capturedSmtp = smtp; return transport; } }, async (database) => {
    const invalid = await runMutation(database, user, "send", [{
      to: "victim@example.com\r\nBcc: attacker@example.com",
      subject: "Unsafe",
      textBody: "Nope",
    }]);
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, "INVALID_MAIL_MESSAGE");
    assert.equal(captured.length, 0);

    const success = await runMutation(database, user, "send", [{
      to: [{ email: "to@example.com", name: "To Person" }],
      cc: "copy@example.com",
      bcc: ["blocked@example.com"],
      replyTo: "reply@example.com",
      subject: "Plain and HTML",
      textBody: "Plain",
      htmlBody: "<p>HTML</p>",
      provider: { metadata: { trace: "abc" } },
    }]);
    assert.deepEqual(success, {
      ok: true,
      data: {
        messageId: "<captured@example.com>",
        accepted: ["to@example.com", "copy@example.com"],
        rejected: ["blocked@example.com"],
      },
      error: null,
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].from.email, "mail@example.com");
    assert.equal(captured[0].to[0].email, "to@example.com");
    assert.deepEqual(captured[0].provider, { metadata: { trace: "abc" } });
    assert.equal(capturedSmtp.tls.mode, "required-starttls");
    assert.equal(capturedSmtp.auth.method, "PLAIN");
    assert.equal(capturedSmtp.auth.username, "user-secret");
    assert.equal(capturedSmtp.auth.password, "password-secret");
    assert.equal("smtp" in captured[0], false);
  });
});

test("SMTP transport failures use stable safe mail errors", async () => {
  const cases = [
    ["ETIMEDOUT", "MAIL_TIMEOUT"],
    ["ETLS", "MAIL_TLS_FAILED"],
    ["EAUTH", "MAIL_AUTH_FAILED"],
    ["EREJECTED", "MAIL_REJECTED"],
    ["CERT_HAS_EXPIRED", "MAIL_TLS_FAILED"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "MAIL_TLS_FAILED"],
    ["ERR_SSL_WRONG_VERSION_NUMBER", "MAIL_TLS_FAILED"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "MAIL_TLS_FAILED"],
    ["ECONNREFUSED", "MAIL_CONNECTION_FAILED"],
  ];
  for (const [transportCode, expected] of cases) {
    const transport = {
      async send() {
        const error = new Error("password-secret provider internals");
        error.code = transportCode;
        throw error;
      },
      close() {},
    };
    await withDatabase(smtpConfig, {
      mutations: {
        send: mutation((ctx) => ctx.mail.send({ to: "to@example.com", subject: "test", textBody: "test" })),
      },
    }, { mailTransportFactory: () => transport }, async (database) => {
      const result = await runMutation(database, user, "send", []);
      assert.equal(result.error.code, expected);
      assert.equal(JSON.stringify(result).includes("password-secret"), false);
      assert.equal(JSON.stringify(result).includes("provider internals"), false);
    });
  }
});

test("mail headers reject every prohibited C0 control and internationalized envelopes before transport", async () => {
  let sends = 0;
  const transport = {
    async send() {
      sends += 1;
      return { messageId: "<unexpected@example.com>", accepted: [], rejected: [] };
    },
    close() {},
  };
  await withDatabase(smtpConfig, {
    mutations: { send: mutation((ctx, message) => ctx.mail.send(message)) },
  }, { mailTransportFactory: () => transport }, async (database) => {
    for (const message of [
      { to: "to@example.com", subject: "bad\u0001subject", textBody: "body" },
      { to: { email: "to@example.com", name: "bad\u000bname" }, subject: "subject", textBody: "body" },
      { to: "tést@example.com", subject: "subject", textBody: "body" },
      { to: "to@exämple.com", subject: "subject", textBody: "body" },
    ]) {
      const result = await runMutation(database, user, "send", [message]);
      assert.equal(result.error.code, "INVALID_MAIL_MESSAGE");
    }
    assert.equal(sends, 0);
  });
});

test("MIME generation encodes Unicode headers, folds headers, and wraps base64 body lines", () => {
  const recipients = Array.from({ length: 100 }, (_, index) => ({
    email: `recipient-${String(index).padStart(3, "0")}@example.com`,
    name: `Recipient ${index}`,
  }));
  const mime = buildSmtpMessage({
    from: { email: "sender@example.com", name: "Équipe Sporades" },
    to: recipients,
    cc: [],
    bcc: [],
    subject: `Résumé ${"long subject ".repeat(100)}`,
    textBody: "long body ".repeat(500),
    messageId: "<mime-test@sporades.local>",
  });
  const [headerBlock, body] = mime.split("\r\n\r\n");
  assert.equal(headerBlock.includes("Équipe"), false);
  assert.equal(headerBlock.includes("Résumé"), false);
  assert.match(headerBlock, /=\?UTF-8\?B\?/);
  assert.equal(headerBlock.split("\r\n").every((line) => line.length <= 998), true);
  assert.equal(body.split("\r\n").every((line) => line.length <= 76), true);
});

test("configured SMTP credentials must resolve from Server env before startup", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-mail-credentials-"));
  try {
    await assert.rejects(
      openDevDatabase(path.join(dir, "data.db"), "", {}, smtpConfig, {}),
      (error) => error.code === "MAIL_CREDENTIAL_MISSING" && !error.message.includes("SMTP_PASSWORD"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mail authority reaches trusted server contexts but not ACL or Schedule payload contexts", async () => {
  const seen = [];
  const transport = {
    async send(message) {
      seen.push(message.subject);
      return { messageId: `<${seen.length}@example.com>`, accepted: ["to@example.com"], rejected: [] };
    },
    close() {},
  };
  const send = (ctx, subject) => ctx.mail.send({ to: "to@example.com", subject, textBody: subject });
  const capsule = {
    queries: { sendQuery: query((ctx) => send(ctx, "query")) },
    mutations: {
      sendMutation: mutation((ctx) => send(ctx, "mutation")),
      sendPrivileged: mutation((ctx) => ctx.privileged.run(
        { operation: "mail.send", targetResourceKind: "smtp" },
        (privilegedCtx) => send(privilegedCtx, "privileged"),
      )),
      enqueueCurrent: mutation((ctx) => ctx.jobs.enqueue("current", {})),
      enqueuePrivileged: mutation((ctx) => ctx.privileged.run(
        { operation: "mail.enqueue", targetResourceKind: "job-queue" },
        (privilegedCtx) => privilegedCtx.jobs.enqueue("privileged", {}),
      )),
    },
    jobs: {
      current: job((ctx) => send(ctx, "current-user-job")),
      privileged: job((ctx) => send(ctx, "privileged-job")),
    },
    hooks: {
      init: (ctx) => send(ctx, "init"),
      shutdown: (ctx) => send(ctx, "shutdown"),
    },
  };
  await withDatabase(smtpConfig, capsule, { mailTransportFactory: () => transport }, async (database) => {
    database.sqlite.prepare("INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(user.userId, new Date().toISOString(), user.displayName, user.email, null, 1, 0, user.provider);
    await database.init();
    database.contextMiddleware = ["async (ctx) => { if (ctx.kind === 'mutation') await ctx.mail.send({ to: 'to@example.com', subject: 'middleware', textBody: 'middleware' }); }"];
    database.mutationHooks.beforeMutation = ["async ({ ctx }) => ctx.mail.send({ to: 'to@example.com', subject: 'before-hook', textBody: 'before-hook' })"];
    database.mutationHooks.afterMutation = ["async ({ ctx }) => ctx.mail.send({ to: 'to@example.com', subject: 'after-hook', textBody: 'after-hook' })"];
    await runMutation(database, user, "sendMutation", []);
    const queryResult = await runQuery(database, user, "sendQuery");
    assert.equal(queryResult.error, null);
    await runMutation(database, user, "sendPrivileged", []);
    await runMutation(database, user, "enqueueCurrent", []);
    await runMutation(database, user, "enqueuePrivileged", []);
    await runEndpoint(database, { handlerSource: "ctx => ctx.mail.send({ to: 'to@example.com', subject: 'endpoint', textBody: 'endpoint' })" }, new URL("http://capsule.test/mail"), { method: "POST", headers: {}, async *[Symbol.asyncIterator]() {} });
    database.messages = [{ name: "mail", handlerSource: "ctx => ctx.mail.send({ to: 'to@example.com', subject: 'message', textBody: 'message' })" }];
    await runAppMessage(database, user, "mail", null);

    const aclContext = createTableAclContext({
      auth: user,
      mail: database.mail,
      db: {},
      privileged: {},
      jobs: {},
    }, database);
    assert.equal("mail" in aclContext, false);
    assert.deepEqual(Object.keys(Object.freeze({ signal: new AbortController().signal, privileged: {} })).sort(), ["privileged", "signal"]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const expected of [
      "after-hook", "before-hook", "current-user-job", "endpoint", "init", "message",
      "middleware", "mutation", "privileged", "privileged-job",
    ]) assert.equal(seen.includes(expected), true, `missing ${expected}`);
  });
  assert.equal(seen.includes("shutdown"), true);
});

test("generated Server Bundles carry the generic mail runtime helpers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-mail-bundle-"));
  const bundlePath = path.join(dir, "server.mjs");
  try {
    const source = createServerBundleSource({
      config: smtpConfig,
      serverEnv: { SMTP_USERNAME: "bundle-user", SMTP_PASSWORD: "bundle-password" },
      serverSource: "",
      serverModuleSource: "export default { name: 'mail-bundle' };",
    });
    assert.match(source, /function createMailRuntime/);
    assert.match(source, /function createMailTransport/);
    assert.match(source, /function validateMailConfig/);
    await writeFile(bundlePath, source);
    const checked = spawnSync(process.execPath, ["--check", bundlePath], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
