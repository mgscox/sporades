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

function readMimeHeader(message, name) {
  const lines = message.split("\r\n\r\n")[0].split("\r\n");
  const start = lines.findIndex((line) => line.startsWith(`${name}:`));
  assert.notEqual(start, -1, `missing ${name}`);
  const folded = [lines[start]];
  for (let index = start + 1; index < lines.length && /^[ \t]/.test(lines[index]); index += 1) folded.push(lines[index]);
  return folded.join("\r\n").replace(/\r\n[ \t]+/g, " ").slice(name.length + 2);
}

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

const postmarkConfig = {
  mail: {
    smtp: {
      ...smtpConfig.mail.smtp,
      vendor: "postmark",
    },
  },
};

const mailgunConfig = {
  mail: {
    smtp: {
      ...smtpConfig.mail.smtp,
      vendor: "mailgun",
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

test("Postmark provider fields become exact SMTP MIME headers", async () => {
  const captured = [];
  const transport = {
    async send(message) {
      captured.push(buildSmtpMessage({ ...message, messageId: "<postmark@example.com>" }));
      return { messageId: "<postmark@example.com>", accepted: ["to@example.com"], rejected: [] };
    },
    close() {},
  };
  await withDatabase(postmarkConfig, {
    mutations: {
      send: mutation((ctx) => ctx.mail.send({
        to: "to@example.com",
        subject: "Postmark extensions",
        textBody: "Hello",
        provider: {
          tag: "welcome-email",
          metadata: {
            "Client-ID": "12345",
            color: "blue",
          },
          messageStream: "transactional-dev",
        },
      })),
    },
  }, { mailTransportFactory: () => transport }, async (database) => {
    const result = await runMutation(database, user, "send", []);
    assert.equal(result.ok, true);
  });

  const headerBlock = captured[0].split("\r\n\r\n")[0];
  const postmarkHeaders = headerBlock
    .split("\r\n")
    .filter((line) => line.startsWith("X-PM-"));
  assert.deepEqual(postmarkHeaders, [
    "X-PM-Tag: welcome-email",
    "X-PM-Metadata-client-id: 12345",
    "X-PM-Metadata-color: blue",
    "X-PM-Message-Stream: transactional-dev",
  ]);
});

test("Postmark rejects unsupported, malformed, colliding, and unsafe provider data before SMTP delivery", async () => {
  let sends = 0;
  const transport = {
    async send() {
      sends += 1;
      return { messageId: "<unexpected@example.com>", accepted: [], rejected: [] };
    },
    close() {},
  };
  await withDatabase(postmarkConfig, {
    mutations: {
      send: mutation((ctx, provider) => ctx.mail.send({
        to: "to@example.com",
        subject: "Postmark validation",
        textBody: "Hello",
        provider,
      })),
    },
  }, { mailTransportFactory: () => transport }, async (database) => {
    for (const field of ["headers", "from", "subject"]) {
      const result = await runMutation(database, user, "send", [{ [field]: "unsafe" }]);
      assert.equal(result.error.code, "UNSUPPORTED_MAIL_PROVIDER_FIELD");
      assert.match(result.error.message, new RegExp(`\\b${field}\\b`));
    }

    const invalid = [
      { tag: "" },
      { tag: "x".repeat(1001) },
      { tag: "welcome\r\nBcc: attacker@example.com" },
      { metadata: new Date() },
      { metadata: Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`key-${index}`, "value"])) },
      { metadata: { "this-key-is-far-too-long": "value" } },
      { metadata: { TraceID: "one", traceid: "two" } },
      { metadata: { trace: "x".repeat(81) } },
      { metadata: { trace: "value\u0007" } },
      { messageStream: "Broadcast" },
      { messageStream: "pm-reserved" },
      { messageStream: `a${"b".repeat(30)}` },
    ];
    for (const provider of invalid) {
      const result = await runMutation(database, user, "send", [provider]);
      assert.equal(result.error.code, "INVALID_MAIL_MESSAGE", JSON.stringify(provider));
    }
  });
  assert.equal(sends, 0);
});

test("Postmark reads only complete own data properties from plain provider objects", async () => {
  const captured = [];
  let getterCalls = 0;
  const transport = {
    async send(message) {
      captured.push(buildSmtpMessage({ ...message, messageId: "<descriptor-test@example.com>" }));
      return { messageId: "<descriptor-test@example.com>", accepted: ["to@example.com"], rejected: [] };
    },
    close() {},
  };
  await withDatabase(postmarkConfig, {
    mutations: {
      send: mutation((ctx, provider) => ctx.mail.send({
        to: "to@example.com",
        subject: "Postmark descriptor validation",
        textBody: "Hello",
        provider,
      })),
    },
  }, { mailTransportFactory: () => transport }, async (database) => {
    const inheritedTag = Object.create({ tag: "inherited-tag" });
    const symbolProvider = { tag: "visible" };
    symbolProvider[Symbol("hidden-provider-field")] = "unsafe";
    const accessorProvider = {};
    Object.defineProperty(accessorProvider, "tag", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "accessor-tag";
      },
    });
    const nonEnumerableProvider = {};
    Object.defineProperty(nonEnumerableProvider, "tag", {
      enumerable: false,
      value: "hidden-tag",
    });

    const symbolMetadata = { trace: "visible" };
    symbolMetadata[Symbol("hidden-metadata-field")] = "unsafe";
    const accessorMetadata = {};
    Object.defineProperty(accessorMetadata, "trace", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "accessor-value";
      },
    });
    const nonEnumerableMetadata = {};
    Object.defineProperty(nonEnumerableMetadata, "trace", {
      enumerable: false,
      value: "hidden-value",
    });

    for (const provider of [
      inheritedTag,
      symbolProvider,
      accessorProvider,
      nonEnumerableProvider,
      { metadata: symbolMetadata },
      { metadata: accessorMetadata },
      { metadata: nonEnumerableMetadata },
    ]) {
      const result = await runMutation(database, user, "send", [provider]);
      assert.equal(result.error.code, "INVALID_MAIL_MESSAGE");
    }
    assert.equal(getterCalls, 0);
    assert.equal(captured.length, 0);

    const nullPrototypeMetadata = Object.assign(Object.create(null), {
      "Client-ID": "12345",
      color: "blue",
    });
    const nullPrototypeProvider = Object.assign(Object.create(null), {
      tag: "own-tag",
      metadata: nullPrototypeMetadata,
    });
    const valid = await runMutation(database, user, "send", [nullPrototypeProvider]);
    assert.equal(valid.ok, true);
  });

  const headers = captured[0].split("\r\n\r\n")[0];
  assert.match(headers, /^X-PM-Tag: own-tag$/m);
  assert.match(headers, /^X-PM-Metadata-client-id: 12345$/m);
  assert.match(headers, /^X-PM-Metadata-color: blue$/m);
  assert.equal(headers.includes("inherited-tag"), false);
});

test("Mailgun provider fields become exact SMTP MIME headers", async () => {
  const captured = [];
  const transport = {
    async send(message) {
      captured.push(buildSmtpMessage({ ...message, messageId: "<mailgun@example.com>" }));
      return { messageId: "<mailgun@example.com>", accepted: ["to@example.com"], rejected: [] };
    },
    close() {},
  };
  await withDatabase(mailgunConfig, {
    mutations: {
      send: mutation((ctx) => ctx.mail.send({
        to: "to@example.com",
        subject: "Mailgun extensions",
        htmlBody: "<p>Hello</p>",
        provider: {
          tags: ["welcome", "new-customer"],
          variables: { zeta: 2, account: { tier: "pro", active: true } },
          recipientVariables: {
            "z@example.com": { name: "Zed" },
            "a@example.com": { name: "Amy" },
          },
          templateName: "welcome-email",
          templateVersion: "v2",
          templateVariables: { surname: "Müller", firstName: "Amy" },
          tracking: { enabled: true, clicks: "htmlonly", opens: false, pixelLocationTop: true },
          testMode: true,
          deliveryTime: "Fri, 14 Oct 2011 12:00:00 +0000",
          deliverWithin: "1h30m",
          deliveryTimeOptimizePeriod: "24h",
          timeZoneLocalize: "14:30",
        },
      })),
    },
  }, { mailTransportFactory: () => transport }, async (database) => {
    const result = await runMutation(database, user, "send", []);
    assert.equal(result.ok, true);
  });

  const headerBlock = captured[0].split("\r\n\r\n")[0];
  const mailgunHeaders = headerBlock
    .split("\r\n")
    .filter((line) => line.startsWith("X-Mailgun-") || /^[ \t]/.test(line));
  assert.deepEqual(mailgunHeaders, [
    "X-Mailgun-Tag: welcome",
    "X-Mailgun-Tag: new-customer",
    "X-Mailgun-Variables: {\"account\":{\"active\":true,\"tier\":\"pro\"},\"zeta\":2}",
    "X-Mailgun-Recipient-Variables: {\"a@example.com\":{\"name\":\"Amy\"},",
    " \"z@example.com\":{\"name\":\"Zed\"}}",
    "X-Mailgun-Template-Name: welcome-email",
    "X-Mailgun-Template-Version: v2",
    "X-Mailgun-Template-Variables: {\"firstName\":\"Amy\",\"surname\":\"M\\u00fcller\"}",
    "X-Mailgun-Track: yes",
    "X-Mailgun-Track-Clicks: htmlonly",
    "X-Mailgun-Track-Opens: no",
    "X-Mailgun-Track-Pixel-Location-Top: yes",
    "X-Mailgun-Drop-Message: yes",
    "X-Mailgun-Deliver-By: Fri, 14 Oct 2011 12:00:00 +0000",
    "X-Mailgun-Deliver-Within: 1h30m",
    "X-Mailgun-Delivery-Time-Optimize-Period: 24h",
    "X-Mailgun-Time-Zone-Localize: 14:30",
  ]);
});

test("Mailgun rejects unsupported, malformed, oversized, and protected provider data before SMTP delivery", async () => {
  let sends = 0;
  const transport = {
    async send() {
      sends += 1;
      return { messageId: "<unexpected@example.com>", accepted: [], rejected: [] };
    },
    close() {},
  };
  await withDatabase(mailgunConfig, {
    mutations: {
      send: mutation((ctx, provider) => ctx.mail.send({
        to: "to@example.com",
        subject: "Mailgun validation",
        htmlBody: "<p>Hello</p>",
        provider,
      })),
    },
  }, { mailTransportFactory: () => transport }, async (database) => {
    for (const field of ["headers", "from", "to", "subject", "htmlBody", "authentication"]) {
      const result = await runMutation(database, user, "send", [{ [field]: "unsafe" }]);
      assert.equal(result.error.code, "UNSUPPORTED_MAIL_PROVIDER_FIELD");
      assert.match(result.error.message, new RegExp(`\\b${field}\\b`));
    }
    const invalid = [
      { tags: [] },
      { tags: ["one", "two", "three", "four"] },
      { tags: ["x".repeat(129)] },
      { tags: ["ümlaut"] },
      { tags: ["welcome\r\nBcc: attacker@example.com"] },
      { tags: [" leading"] },
      { tags: ["trailing "] },
      { tags: ["repeated  whitespace"] },
      { variables: { bad: undefined } },
      { variables: [] },
      { variables: { bad: Number.NaN } },
      { variables: { bad: "x".repeat(4097) } },
      { variables: { ["x".repeat(1200)]: "value" } },
      { recipientVariables: [] },
      { recipientVariables: { "not-an-address": { name: "Amy" } } },
      { recipientVariables: { "person@example.com": { note: "x".repeat(1200) } } },
      { recipientVariables: Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`user${index}@example.com`, { id: index }])) },
      { templateName: "unsafe\r\nBcc: attacker@example.com" },
      { templateName: " leading" },
      { templateName: "trailing " },
      { templateName: "repeated  whitespace" },
      { templateVersion: "" },
      { templateVersion: " leading" },
      { templateVersion: "trailing " },
      { templateVersion: "repeated  whitespace" },
      { templateVariables: { bad: 1n } },
      { templateVariables: [] },
      { templateVariables: { note: "x".repeat(1200) } },
      { tracking: { enabled: "yes" } },
      { tracking: { clicks: "all" } },
      { testMode: "yes" },
      { deliveryTime: "tomorrow" },
      { deliverWithin: "4m" },
      { deliverWithin: "24h1m" },
      { deliveryTimeOptimizePeriod: "24 hours" },
      { deliveryTimeOptimizePeriod: "23h" },
      { deliveryTimeOptimizePeriod: "73h" },
      { timeZoneLocalize: "25:00" },
    ];
    for (const provider of invalid) {
      const result = await runMutation(database, user, "send", [provider]);
      assert.equal(result.error.code, "INVALID_MAIL_MESSAGE", String(Object.keys(provider)[0]));
    }
    const nestedUnknown = await runMutation(database, user, "send", [{ tracking: { protectedHeader: true } }]);
    assert.equal(nestedUnknown.error.code, "UNSUPPORTED_MAIL_PROVIDER_FIELD");
    assert.match(nestedUnknown.error.message, /tracking\.protectedHeader/);
  });
  assert.equal(sends, 0);
});

test("Mailgun provider JSON reads only complete own data descriptors and is deterministic", async () => {
  const captured = [];
  let getterCalls = 0;
  const transport = {
    async send(message) {
      captured.push(buildSmtpMessage({ ...message, messageId: "<mailgun-descriptors@example.com>" }));
      return { messageId: "<mailgun-descriptors@example.com>", accepted: ["to@example.com"], rejected: [] };
    },
    close() {},
  };
  await withDatabase(mailgunConfig, {
    mutations: {
      send: mutation((ctx, provider) => ctx.mail.send({
        to: "to@example.com",
        subject: "Mailgun descriptors",
        htmlBody: "<p>Hello</p>",
        provider,
      })),
    },
  }, { mailTransportFactory: () => transport }, async (database) => {
    const inherited = Object.create({ tags: ["inherited"] });
    const accessor = {};
    Object.defineProperty(accessor, "variables", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { unsafe: true };
      },
    });
    const nestedAccessor = {};
    Object.defineProperty(nestedAccessor, "unsafe", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      },
    });
    const nonEnumerable = { variables: {} };
    Object.defineProperty(nonEnumerable.variables, "hidden", { enumerable: false, value: true });
    const symbol = { variables: { visible: true } };
    symbol.variables[Symbol("hidden")] = true;
    const accessorTags = ["safe"];
    Object.defineProperty(accessorTags, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "unsafe";
      },
    });
    const symbolTags = ["safe"];
    symbolTags[Symbol("hidden")] = "unsafe";
    const sparseTags = new Array(1);
    for (const provider of [
      inherited,
      accessor,
      { variables: nestedAccessor },
      nonEnumerable,
      symbol,
      { tags: accessorTags },
      { tags: symbolTags },
      { tags: sparseTags },
    ]) {
      const result = await runMutation(database, user, "send", [provider]);
      assert.equal(result.error.code, "INVALID_MAIL_MESSAGE");
      assert.match(result.error.message, /Invalid Mailgun provider data/);
    }
    assert.equal(getterCalls, 0);
    assert.equal(captured.length, 0);

    const variables = Object.assign(Object.create(null), {
      z: 1,
      a: Object.assign(Object.create(null), { second: 2, first: 1 }),
    });
    const provider = Object.assign(Object.create(null), { variables });
    const valid = await runMutation(database, user, "send", [provider]);
    assert.equal(valid.ok, true);
  });

  const headers = captured[0].split("\r\n\r\n")[0];
  assert.match(headers, /X-Mailgun-Variables: \{"a":\{"first":1,"second":2\},"z":1\}/);
});

test("Mailgun JSON headers preserve string whitespace and fold payloads larger than 998 bytes", async () => {
  const captured = [];
  const transport = {
    async send(message) {
      captured.push(buildSmtpMessage({ ...message, messageId: "<mailgun-large-json@example.com>" }));
      return { messageId: "<mailgun-large-json@example.com>", accepted: ["to@example.com"], rejected: [] };
    },
    close() {},
  };
  const spaced = "  leading   repeated   trailing  ";
  const variables = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`variable-${String(index).padStart(3, "0")}`, `${spaced}${index}`]));
  const recipientVariables = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`user${index}@example.com`, { note: `${spaced}${index}` }]));
  const templateVariables = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`template-${String(index).padStart(3, "0")}`, `${spaced}${index}`]));
  await withDatabase(mailgunConfig, {
    mutations: {
      send: mutation((ctx) => ctx.mail.send({
        to: "to@example.com",
        subject: "Large Mailgun JSON",
        htmlBody: "<p>Hello</p>",
        provider: {
          variables,
          recipientVariables,
          templateVariables,
          deliveryTimeOptimizePeriod: "72h",
        },
      })),
    },
  }, { mailTransportFactory: () => transport }, async (database) => {
    const result = await runMutation(database, user, "send", []);
    assert.equal(result.ok, true);
  });

  const message = captured[0];
  for (const [name, expected] of [
    ["X-Mailgun-Variables", variables],
    ["X-Mailgun-Recipient-Variables", recipientVariables],
    ["X-Mailgun-Template-Variables", templateVariables],
  ]) {
    const unfolded = readMimeHeader(message, name);
    assert.ok(unfolded.length > 998, `${name} did not exercise long JSON`);
    assert.deepEqual(JSON.parse(unfolded), expected);
  }
  for (const line of message.split("\r\n\r\n")[0].split("\r\n")) assert.ok(line.length <= 998, `overlong MIME header line: ${line.length}`);
  assert.equal(readMimeHeader(message, "X-Mailgun-Delivery-Time-Optimize-Period"), "72h");
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
    from: { email: "sender@example.com", name: "Équipe Sporades ".repeat(12) },
    to: recipients,
    cc: [],
    bcc: [],
    replyTo: { email: "reply@example.com", name: "Réponse Sporades ".repeat(12) },
    subject: `Résumé ${"long subject ".repeat(100)}`,
    textBody: "long body ".repeat(500),
    messageId: "<mime-test@sporades.local>",
  });
  const [headerBlock, body] = mime.split("\r\n\r\n");
  assert.equal(headerBlock.includes("Équipe"), false);
  assert.equal(headerBlock.includes("Résumé"), false);
  assert.match(headerBlock, /=\?UTF-8\?B\?/);
  assert.equal(headerBlock.split("\r\n").every((line) => line.length <= 998), true);
  assert.equal(
    headerBlock.split("\r\n").filter((line) => line.includes("=?UTF-8?B?")).every((line) => line.length <= 76),
    true,
  );
  assert.equal(body.split("\r\n").every((line) => line.length <= 76), true);
});

test("encoded display names fold before a short mailbox would push the line past 76 characters", () => {
  const displayName = `${"🙂".repeat(9)}abc`;
  const mime = buildSmtpMessage({
    from: { email: "a@bc", name: displayName },
    to: [{ email: "to@example.com" }],
    cc: [],
    bcc: [],
    replyTo: { email: "a@bcd", name: displayName },
    subject: "Encoded address line",
    textBody: "body",
    messageId: "<encoded-address@sporades.local>",
  });
  const headerLines = mime.split("\r\n\r\n")[0].split("\r\n");
  const encodedLines = headerLines.filter((line) => line.includes("=?UTF-8?B?"));
  assert.equal(encodedLines.length >= 2, true);
  assert.equal(encodedLines.every((line) => line.length <= 76), true);
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
    assert.match(source, /function normalizePostmarkProvider/);
    assert.match(source, /function normalizeMailgunProvider/);
    assert.match(source, /function validateMailConfig/);
    await writeFile(bundlePath, source);
    const checked = spawnSync(process.execPath, ["--check", bundlePath], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
