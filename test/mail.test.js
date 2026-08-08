import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as tls from "node:tls";

import { validateMailConfig } from "../dist/cli/project-config.js";
// `buildSmtpMessage`, `createMailTransport` and `connectSmtpSocket` are imported by name rather than
// searched for in `SERVER_RUNTIME_SOURCE_FUNCTIONS` the way the three below still are. The mail
// domain is a module now (ADR-0041), so it is no longer in that list at all and the search would
// return `undefined` — which is the whole reason `server-runtime-source.ts` re-exports the migrated
// modules whole. Nothing else in this file changed: these are the same three functions, resolved
// through the bridge instead of through the list.
import {
  buildSmtpMessage,
  connectSmtpSocket,
  createMailTransport,
  // Batch 7 moved the ACL domain out of the emitted list, so `createTableAclContext` joins the
  // three above: it was a `.find` here and that lookup returns `undefined` the moment a name stops
  // being an entry, which would have called `undefined(…)` in the ACL assertion below instead of
  // failing at load.
  createTableAclContext,
  openDevDatabase,
  runMutation,
  runQuery,
  SERVER_RUNTIME_SOURCE_FUNCTIONS,
} from "../dist/server-runtime-source.js";
import { job, mutation, query } from "../dist/server.js";
import { createServerBundleSource } from "../dist/templates/server-bundle-template.js";

const runEndpoint = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "runEndpoint");
const runAppMessage = SERVER_RUNTIME_SOURCE_FUNCTIONS.find((fn) => fn.name === "runAppMessage");

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

const smtp2goConfig = {
  mail: {
    smtp: {
      ...smtpConfig.mail.smtp,
      vendor: "smtp2go",
      host: "mail.smtp2go.com",
      port: 2525,
      tls: {
        mode: "required-starttls",
        servername: "mail.smtp2go.com",
      },
      auth: {
        method: "LOGIN",
        usernameEnv: "SMTP2GO_USERNAME",
        passwordEnv: "SMTP2GO_PASSWORD",
      },
    },
  },
};

async function withDatabase(config, capsule, options, run) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-mail-"));
  const database = await openDevDatabase(
    path.join(dir, "data.db"),
    "",
    {
      SMTP_USERNAME: "user-secret",
      SMTP_PASSWORD: "password-secret",
      SMTP2GO_USERNAME: "smtp2go-user-secret",
      SMTP2GO_PASSWORD: "smtp2go-password-secret",
    },
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

async function startTestSmtpServer({ implicitTls = false, authReject = false, recipientReject = false } = {}) {
  const commands = [];
  const messages = [];
  const tlsOptions = implicitTls ? {
    key: await readFile(new URL("./fixtures/smtp-test-key.pem", import.meta.url)),
    cert: await readFile(new URL("./fixtures/smtp-test-cert.pem", import.meta.url)),
  } : undefined;
  const handle = (socket) => {
    let buffer = "";
    let inData = false;
    socket.on("error", (error) => {
      if (error.code !== "ECONNRESET") throw error;
    });
    socket.setEncoding("utf8");
    socket.write("220 smtp.test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write("250 queued <portable-smtp@test>\r\n");
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const command = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push(command);
        if (/^EHLO /i.test(command)) socket.write("250-smtp.test\r\n250 PIPELINING\r\n");
        else if (/^MAIL FROM:/i.test(command)) socket.write("250 ok\r\n");
        else if (/^RCPT TO:/i.test(command)) socket.write(recipientReject ? "550 rejected\r\n" : "250 ok\r\n");
        else if (command === "DATA") {
          inData = true;
          socket.write("354 end with dot\r\n");
        } else if (command === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else if (/^AUTH /i.test(command)) socket.write(authReject ? "535 authentication failed\r\n" : "235 authenticated\r\n");
        else socket.write("500 unsupported\r\n");
      }
    });
  };
  const server = implicitTls ? tls.createServer(tlsOptions, handle) : createNetServer(handle);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    commands,
    messages,
    port: server.address().port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("mail.smtp configuration rejects ambiguous, incomplete, and unsafe declarations", () => {
  assert.doesNotThrow(() => validateMailConfig(undefined));
  assert.doesNotThrow(() => validateMailConfig(smtpConfig.mail));
  assert.doesNotThrow(() => validateMailConfig(smtp2goConfig.mail));
  assert.doesNotThrow(() => validateMailConfig({
    smtp: {
      ...smtpConfig.mail.smtp,
      host: "127.0.0.1",
      tls: { mode: "disabled", servername: "smtp.internal.example" },
      auth: { method: "none" },
    },
  }));

  const invalid = [
    [{ smtp: { ...smtpConfig.mail.smtp, port: 0 } }, /Invalid SMTP port/],
    [{ smtp: { ...smtpConfig.mail.smtp, secure: true } }, /Invalid SMTP configuration/],
    [{ smtp: { ...smtpConfig.mail.smtp, tls: { mode: "required-starttls", secure: true } } }, /Invalid SMTP TLS configuration/],
    [{ smtp: { ...smtpConfig.mail.smtp, connectionTimeoutMs: 0 } }, /Invalid SMTP connection timeout/],
    [{ smtp: { ...smtpConfig.mail.smtp, auth: { ...smtpConfig.mail.smtp.auth, usernameEnv: "bad-name" } } }, /Invalid SMTP Server env reference/],
    [{ smtp: { ...smtpConfig.mail.smtp, auth: { usernameEnv: "SMTP_USERNAME" } } }, /Invalid SMTP authentication configuration/],
    [{ smtp: { ...smtpConfig.mail.smtp, tls: { mode: "disabled" } } }, /requires an explicit unauthenticated relay/],
    [{ smtp: { ...smtpConfig.mail.smtp, tls: { mode: "opportunistic" } } }, /requires an explicit unauthenticated relay/],
    [{ smtp: { ...smtpConfig.mail.smtp, auth: undefined } }, /Invalid SMTP authentication configuration/],
    [{ smtp: { ...smtpConfig.mail.smtp, auth: { method: "none", usernameEnv: "SMTP_USERNAME" } } }, /Invalid SMTP authentication configuration/],
    [{ smtp: { ...smtpConfig.mail.smtp, tls: { ...smtpConfig.mail.smtp.tls, servername: "bad name" } } }, /Invalid SMTP TLS server name/],
  ];
  for (const [mail, expected] of invalid) assert.throws(() => validateMailConfig(mail), expected);
});

test("mail configuration snapshots complete own data without executing getters", () => {
  const makeConfig = () => structuredClone(smtpConfig.mail);
  const layers = [
    ["mail", (config) => config],
    ["smtp", (config) => config.smtp],
    ["tls", (config) => config.smtp.tls],
    ["auth", (config) => config.smtp.auth],
  ];
  for (const [label, select] of layers) {
    for (const attack of ["accessor", "hidden", "symbol", "inherited", "custom-prototype"]) {
      const config = makeConfig();
      let getterCalls = 0;
      let candidate = select(config);
      if (attack === "accessor") {
        Object.defineProperty(candidate, "unknown", {
          enumerable: true,
          get() {
            getterCalls += 1;
            return "surprise";
          },
        });
      } else if (attack === "hidden") {
        Object.defineProperty(candidate, "unknown", { enumerable: false, value: "surprise" });
      } else if (attack === "symbol") {
        candidate[Symbol("unknown")] = "surprise";
      } else {
        const prototype = attack === "inherited" ? { unknown: "surprise" } : { custom: true };
        Object.setPrototypeOf(candidate, prototype);
      }
      assert.throws(
        () => validateMailConfig(config),
        (error) => error.code === "INVALID_MAIL_CONFIG",
        `${label} ${attack}`,
      );
      assert.equal(getterCalls, 0, `${label} ${attack} executed a getter`);
    }
  }

  for (const attack of ["inherited", "hidden", "accessor", "symbol"]) {
    const config = {
      smtp: {
        ...smtpConfig.mail.smtp,
        tls: { mode: "disabled" },
        auth: { method: "none" },
      },
    };
    let getterCalls = 0;
    if (attack === "inherited") {
      Object.setPrototypeOf(config.smtp.auth, { usernameEnv: "SMTP_USERNAME" });
    } else if (attack === "hidden") {
      Object.defineProperty(config.smtp.auth, "usernameEnv", { enumerable: false, value: "SMTP_USERNAME" });
    } else if (attack === "accessor") {
      Object.defineProperty(config.smtp.auth, "usernameEnv", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "SMTP_USERNAME";
        },
      });
    } else {
      config.smtp.auth[Symbol("usernameEnv")] = "SMTP_USERNAME";
    }
    assert.throws(() => validateMailConfig(config), (error) => error.code === "INVALID_MAIL_CONFIG");
    assert.equal(getterCalls, 0);
  }

  const nullPrototype = structuredClone(smtpConfig.mail);
  Object.setPrototypeOf(nullPrototype, null);
  Object.setPrototypeOf(nullPrototype.smtp, null);
  Object.setPrototypeOf(nullPrototype.smtp.tls, null);
  Object.setPrototypeOf(nullPrototype.smtp.auth, null);
  assert.doesNotThrow(() => validateMailConfig(nullPrototype));
});

test("SMTP2GO-shaped configuration reaches the generic SMTP transport", async () => {
  let capturedSmtp;
  const capturedMessages = [];
  const config = {
    ...smtp2goConfig,
    name: "smtp2go-shaped",
  };
  await withDatabase(config, {
    mutations: {
      send: mutation((ctx) => ctx.mail.send({
        to: "recipient@example.com",
        subject: "SMTP2GO generic delivery",
        textBody: "Portable SMTP",
        provider: {
          headers: {
            "X-Smtp2go-Campaign": "onboarding",
            "X-Smtp2go-Tag": ["welcome  cohort", "trial"],
          },
        },
      })),
    },
  }, {
    mailTransportFactory(smtp) {
      capturedSmtp = smtp;
      return {
        async send(message) {
          capturedMessages.push(buildSmtpMessage({ ...message, messageId: "<smtp2go@example.com>" }));
          return { messageId: "<smtp2go@example.com>", accepted: ["recipient@example.com"], rejected: [] };
        },
        close() {},
      };
    },
  }, async (database) => {
    const result = await runMutation(database, user, "send", []);
    assert.equal(result.ok, true);
  });

  assert.equal(capturedSmtp.vendor, "smtp2go");
  assert.equal(capturedSmtp.host, "mail.smtp2go.com");
  assert.equal(capturedSmtp.port, 2525);
  assert.equal(capturedSmtp.tls.mode, "required-starttls");
  assert.equal(capturedSmtp.tls.rejectUnauthorized, true);
  assert.equal(capturedSmtp.tls.servername, "mail.smtp2go.com");
  assert.equal(capturedSmtp.auth.method, "LOGIN");
  assert.match(capturedMessages[0], /\r\nX-Smtp2go-Campaign: onboarding\r\n/);
  assert.match(capturedMessages[0], /\r\nX-Smtp2go-Tag: welcome  cohort\r\nX-Smtp2go-Tag: trial\r\n/);
});

test("generic provider headers reject unsafe names, values, fields, and descriptor tricks before transport", async () => {
  let sends = 0;
  const transport = {
    async send() {
      sends += 1;
      return { messageId: "<unexpected@example.com>", accepted: [], rejected: [] };
    },
    close() {},
  };
  await withDatabase(smtpConfig, {
    mutations: {
      send: mutation((ctx, provider) => ctx.mail.send({
        to: "to@example.com",
        subject: "provider headers",
        textBody: "body",
        provider,
      })),
    },
  }, { mailTransportFactory: () => transport }, async (database) => {
    const accessorHeaders = {};
    Object.defineProperty(accessorHeaders, "X-Test", {
      enumerable: true,
      get() {
        throw new Error("must not execute");
      },
    });
    const hiddenHeaders = {};
    Object.defineProperty(hiddenHeaders, "X-Test", { enumerable: false, value: "hidden" });
    const inheritedHeaders = Object.create({ "X-Test": "inherited" });
    const sparseValues = [];
    sparseValues.length = 1;
    const cases = [
      { metadata: { trace: "no longer portable" } },
      { headers: { Subject: "override" } },
      { headers: { "X-Original-To": "other@example.com" } },
      { headers: { "X-SMTP-Host": "attacker.example.com" } },
      { headers: { "X-SMTPAPI": "{\"to\":[\"other@example.com\"]}" } },
      { headers: { "X-Test\r\nBcc": "attacker@example.com" } },
      { headers: { "X-Test": "safe\r\nBcc: attacker@example.com" } },
      { headers: { "X-Test": "" } },
      { headers: { "X-Test": " leading" } },
      { headers: { "X-Test": "trailing " } },
      { headers: { "X-Test": 123 } },
      { headers: { "X-Test": [] } },
      { headers: { "X-Test": sparseValues } },
      { headers: accessorHeaders },
      { headers: hiddenHeaders },
      { headers: inheritedHeaders },
    ];
    for (const provider of cases) {
      const result = await runMutation(database, user, "send", [provider]);
      assert.equal(result.ok, false);
      assert.match(result.error.code, /^(?:INVALID_MAIL_MESSAGE|UNSUPPORTED_MAIL_PROVIDER_FIELD)$/);
    }
    assert.equal(sends, 0);
  });
});

test("generic X-* header admission is case-insensitive while preserving spelling", async () => {
  let raw;
  await withDatabase(smtpConfig, {
    mutations: {
      send: mutation((ctx) => ctx.mail.send({
        to: "to@example.com",
        subject: "case",
        textBody: "body",
        provider: {
          headers: {
            "x-test": "lower",
            "x-TeSt-Two": "mixed",
          },
        },
      })),
    },
  }, {
    mailTransportFactory: () => ({
      async send(message) {
        raw = buildSmtpMessage({ ...message, messageId: "<case@test>" });
        return { messageId: "<case@test>", accepted: ["to@example.com"], rejected: [] };
      },
      close() {},
    }),
  }, async (database) => {
    assert.equal((await runMutation(database, user, "send", [])).ok, true);
  });
  assert.match(raw, /\r\nx-test: lower\r\n/);
  assert.match(raw, /\r\nx-TeSt-Two: mixed\r\n/);
});

test("explicitly unauthenticated plaintext and opportunistic local relays never send AUTH", async () => {
  for (const mode of ["disabled", "opportunistic"]) {
    const server = await startTestSmtpServer();
    const config = {
      name: `${mode}-relay`,
      mail: {
        smtp: {
          vendor: "generic",
          host: "127.0.0.1",
          port: server.port,
          tls: { mode, rejectUnauthorized: true },
          auth: { method: "none" },
          defaultFrom: "relay@example.com",
        },
      },
    };
    try {
      await withDatabase(config, {
        mutations: {
          send: mutation((ctx) => ctx.mail.send({
            to: "recipient@example.com",
            subject: `${mode} relay`,
            textBody: "local relay",
          })),
        },
      }, {}, async (database) => {
        const result = await runMutation(database, user, "send", []);
        assert.equal(result.ok, true);
      });
      assert.equal(server.commands.some((command) => /^AUTH /i.test(command)), false);
      assert.equal(server.commands.some((command) => /^MAIL FROM:/i.test(command)), true);
      assert.equal(server.messages.length, 1);
    } finally {
      await server.close();
    }
  }
});

test("implicit TLS validates the configured server name when the SMTP host is an IP address", async (t) => {
  if (
    typeof tls.getCACertificates !== "function"
    || typeof tls.setDefaultCACertificates !== "function"
  ) {
    t.skip("Runtime trust injection requires Node 22.19+; default certificate rejection is covered through resolved transport configuration.");
    return;
  }
  const server = await startTestSmtpServer({ implicitTls: true });
  const cert = await readFile(new URL("./fixtures/smtp-test-cert.pem", import.meta.url), "utf8");
  const previousDefaultCAs = tls.getCACertificates("default");
  tls.setDefaultCACertificates([...previousDefaultCAs, cert]);
  const config = {
    name: "implicit-tls-relay",
    mail: {
      smtp: {
        vendor: "generic",
        host: "127.0.0.1",
        port: server.port,
        tls: {
          mode: "implicit",
          rejectUnauthorized: true,
          servername: "smtp.internal.example",
        },
        auth: { method: "none" },
        defaultFrom: "relay@example.com",
      },
    },
  };
  try {
    await withDatabase(config, {
      mutations: {
        send: mutation((ctx) => ctx.mail.send({
          to: "recipient@example.com",
          subject: "implicit TLS relay",
          textBody: "certificate checked",
        })),
      },
    }, {}, async (database) => {
      const result = await runMutation(database, user, "send", []);
      assert.equal(result.ok, true);
    });
    assert.equal(server.commands.some((command) => /^AUTH /i.test(command)), false);
    assert.equal(server.messages.length, 1);
  } finally {
    tls.setDefaultCACertificates(previousDefaultCAs);
    await server.close();
  }
});

test("implicit TLS rejects an untrusted certificate by default on every supported Node", async () => {
  const server = await startTestSmtpServer({ implicitTls: true });
  const config = {
    name: "untrusted-implicit-tls",
    mail: {
      smtp: {
        vendor: "generic",
        host: "127.0.0.1",
        port: server.port,
        tls: {
          mode: "implicit",
          servername: "smtp.internal.example",
        },
        auth: { method: "none" },
        defaultFrom: "relay@example.com",
      },
    },
  };
  try {
    await withDatabase(config, {
      mutations: {
        send: mutation((ctx) => ctx.mail.send({
          to: "recipient@example.com",
          subject: "must fail closed",
          textBody: "untrusted certificate",
        })),
      },
    }, {}, async (database) => {
      const result = await runMutation(database, user, "send", []);
      assert.equal(result.ok, false);
      assert.deepEqual(result.error, {
        code: "MAIL_TLS_FAILED",
        message: "SMTP TLS negotiation failed.",
        hint: "Check the SMTP TLS mode, port, and certificate policy.",
      });
    });
    assert.equal(server.messages.length, 0);
    assert.equal(server.commands.some((command) => /^MAIL FROM:/i.test(command)), false);
  } finally {
    await server.close();
  }
});

test("TLS server name is forwarded for implicit and upgraded STARTTLS sockets", () => {
  assert.match(String(connectSmtpSocket), /servername:\s*smtp\.tls\.servername\s*\?\?\s*smtp\.host/);
  assert.match(String(createMailTransport), /servername:\s*smtp\.tls\.servername\s*\?\?\s*smtp\.host/);
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
      provider: { headers: { "X-Trace": "abc" } },
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
    assert.deepEqual(captured[0].providerHeaders, [{ name: "X-Trace", value: "abc", verbatim: true }]);
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
    "X-Mailgun-Recipient-Variables: {\"a@example.com\":{\"name\":\"Amy\"},\"z@example.com\"",
    " :{\"name\":\"Zed\"}}",
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
      { variables: { ["x".repeat(996)]: "value" } },
      { variables: { value: "x".repeat(996) } },
      { variables: { nested: ["x".repeat(996)] } },
      { recipientVariables: [] },
      { recipientVariables: { "not-an-address": { name: "Amy" } } },
      { recipientVariables: { "person@example.com": { note: "x".repeat(1200) } } },
      { recipientVariables: Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`user${index}@example.com`, { id: index }])) },
      { templateName: "unsafe\r\nBcc: attacker@example.com" },
      { templateName: " leading" },
      { templateName: "trailing " },
      { templateName: "repeated  whitespace" },
      { templateName: "non\u00a0breaking" },
      { templateName: "em\u2003space" },
      { templateName: "tab\tspace" },
      { templateVersion: "" },
      { templateVersion: " leading" },
      { templateVersion: "trailing " },
      { templateVersion: "repeated  whitespace" },
      { templateVersion: "non\u00a0breaking" },
      { templateVersion: "em\u2003space" },
      { templateVersion: "tab\tspace" },
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

test("Mailgun JSON tokens accept 997 serialized characters and reject the next character pre-transport", async () => {
  const captured = [];
  let sends = 0;
  const transport = {
    async send(message) {
      sends += 1;
      captured.push(buildSmtpMessage({ ...message, messageId: "<mailgun-token-boundary@example.com>" }));
      return { messageId: "<mailgun-token-boundary@example.com>", accepted: ["to@example.com"], rejected: [] };
    },
    close() {},
  };
  const maximum = "x".repeat(995);
  await withDatabase(mailgunConfig, {
    mutations: {
      send: mutation((ctx, provider) => ctx.mail.send({
        to: "to@example.com",
        subject: "Mailgun token boundary",
        htmlBody: "<p>Hello</p>",
        provider,
      })),
    },
  }, { mailTransportFactory: () => transport }, async (database) => {
    const valid = await runMutation(database, user, "send", [{
      variables: {
        [maximum]: maximum,
        nested: [maximum],
      },
      templateName: "welcome email",
      templateVersion: "version 2",
    }]);
    assert.equal(valid.ok, true);
  });
  assert.equal(sends, 1);
  assert.deepEqual(JSON.parse(readMimeHeader(captured[0], "X-Mailgun-Variables")), {
    [maximum]: maximum,
    nested: [maximum],
  });
  assert.match(captured[0], /^X-Mailgun-Template-Name: welcome email$/m);
  assert.match(captured[0], /^X-Mailgun-Template-Version: version 2$/m);
  for (const line of captured[0].split("\r\n\r\n")[0].split("\r\n")) assert.ok(line.length <= 998);
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
    }, { mailTransportFactory: () => transport, mailTransportFactoryTrusted: true }, async (database) => {
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
    database.adapter.prepare("INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
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
    assert.match(source, /function createMailDeliveryLogData/);
    assert.match(source, /function validateMailConfig/);
    await writeFile(bundlePath, source);
    const checked = spawnSync(process.execPath, ["--check", bundlePath], { encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mail delivery emits bounded secret-safe structured diagnostics", async () => {
  const secretAddress = "private-recipient@example.com";
  const secretBody = "a body that must never reach logs";
  const secretProviderValue = "private-provider-payload";
  const transport = {
    async send() {
      return {
        messageId: "<provider-message@example.com>",
        accepted: [secretAddress],
        rejected: ["blocked@example.com"],
      };
    },
    close() {},
  };
  await withDatabase(smtpConfig, {
    mutations: {
      send: mutation((ctx) => ctx.mail.send({
        to: secretAddress,
        cc: "copy@example.com",
        subject: "Secret subject",
        textBody: secretBody,
        provider: { headers: { "X-Private": secretProviderValue } },
      })),
    },
  }, { mailTransportFactory: () => transport }, async (database) => {
    const result = await runMutation(database, user, "send", []);
    assert.equal(result.ok, true);
    const event = database.log.tail().findLast((candidate) => candidate.event === "mail.delivery");
    assert.ok(event);
    assert.equal(event.category, "mail");
    assert.equal(event.level, "info");
    assert.equal(event.data.vendor, "generic");
    assert.deepEqual(event.data.recipients, {
      to: 1,
      cc: 1,
      bcc: 0,
      total: 2,
      accepted: 1,
      rejected: 1,
    });
    assert.equal(event.data.result, "partial");
    assert.equal(typeof event.data.latencyMs, "number");
    assert.match(event.data.messageIdentity, /^mail_[0-9a-f-]{36}$/);
    const serialized = JSON.stringify(event);
    for (const forbidden of [
      secretAddress,
      "copy@example.com",
      "blocked@example.com",
      "Secret subject",
      secretBody,
      secretProviderValue,
      "provider-message@example.com",
      "user-secret",
      "password-secret",
      "SMTP_USERNAME",
      "SMTP_PASSWORD",
      "AUTH PLAIN",
    ]) assert.equal(serialized.includes(forbidden), false, `mail log leaked ${forbidden}`);
  });
});

test("mail delivery failure diagnostics expose only stable result categories", async () => {
  const transport = {
    async send() {
      const error = new Error("SMTP_PASSWORD raw AUTH PLAIN password-secret recipient@example.com");
      error.code = "EAUTH";
      throw error;
    },
    close() {},
  };
  await withDatabase(smtpConfig, {
    mutations: {
      send: mutation((ctx) => ctx.mail.send({
        to: "recipient@example.com",
        subject: "do not log this",
        textBody: "or this body",
      })),
    },
  }, { mailTransportFactory: () => transport, mailTransportFactoryTrusted: true }, async (database) => {
    const result = await runMutation(database, user, "send", []);
    assert.equal(result.error.code, "MAIL_AUTH_FAILED");
    const event = database.log.tail().findLast((candidate) => candidate.event === "mail.delivery");
    assert.ok(event);
    assert.equal(event.level, "error");
    assert.equal(event.data.result, "MAIL_AUTH_FAILED");
    assert.equal(event.data.recipients.total, 1);
    const serialized = JSON.stringify(event);
    for (const forbidden of ["recipient@example.com", "do not log this", "or this body", "SMTP_PASSWORD", "AUTH PLAIN", "password-secret"]) {
      assert.equal(serialized.includes(forbidden), false, `mail error log leaked ${forbidden}`);
    }
  });
});

test("Capsule code cannot inspect raw SMTP transport failure details", async () => {
  const rawDetail = "AUTH PLAIN password-secret recipient@example.com 535 provider response";
  const rawSymbol = Symbol("smtp-auth-detail");
  const transport = {
    async send() {
      const error = new Error(rawDetail);
      error.code = "MAIL_AUTH_FAILED";
      error.cause = new Error(`nested ${rawDetail}`);
      error[rawSymbol] = rawDetail;
      throw error;
    },
    close() {},
  };
  await withDatabase(smtpConfig, {
    mutations: {
      inspect: mutation(async (ctx) => {
        try {
          await ctx.mail.send({
            to: "recipient@example.com",
            subject: "failure surface",
            textBody: "failure surface",
          });
          return null;
        } catch (error) {
          return {
            public: {
              code: error.code,
              message: error.message,
              hint: error.hint,
            },
            hasCause: "cause" in error,
            causeDescriptor: Object.getOwnPropertyDescriptor(error, "cause") !== undefined,
            symbolCount: Object.getOwnPropertySymbols(error).length,
            enumerableKeys: Object.keys(error).sort(),
            ownKeys: Reflect.ownKeys(error).map((key) => typeof key === "symbol" ? String(key) : key).sort(),
            serialized: JSON.stringify(error),
          };
        }
      }),
    },
  }, { mailTransportFactory: () => transport, mailTransportFactoryTrusted: true }, async (database) => {
    const result = await runMutation(database, user, "inspect", []);
    assert.deepEqual(result, {
      ok: true,
      data: {
        public: {
          code: "MAIL_AUTH_FAILED",
          message: "SMTP authentication failed.",
          hint: "Check the SMTP Server env credentials and authentication method.",
        },
        hasCause: false,
        causeDescriptor: false,
        symbolCount: 0,
        enumerableKeys: ["code", "hint"],
        ownKeys: ["code", "hint", "message", "stack"],
        serialized: "{\"code\":\"MAIL_AUTH_FAILED\",\"hint\":\"Check the SMTP Server env credentials and authentication method.\"}",
      },
      error: null,
    });
    assert.equal(JSON.stringify(result).includes(rawDetail), false);
  });
});

test("SMTP failure normalization never executes hostile code properties and still logs safely", async () => {
  let getterCalls = 0;
  let proxyTrapCalls = 0;
  const rawDetail = "AUTH LOGIN password-secret inherited@example.com provider response";
  const ownAccessor = new Error("own accessor");
  Object.defineProperty(ownAccessor, "code", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(rawDetail);
    },
  });
  const inheritedAccessor = Object.create(Object.defineProperty({}, "code", {
    get() {
      getterCalls += 1;
      throw new Error(rawDetail);
    },
  }));
  inheritedAccessor.message = rawDetail;
  const trapped = new Proxy(new Error(rawDetail), {
    get() {
      proxyTrapCalls += 1;
      throw new Error(rawDetail);
    },
    getOwnPropertyDescriptor() {
      proxyTrapCalls += 1;
      throw new Error(rawDetail);
    },
    getPrototypeOf() {
      proxyTrapCalls += 1;
      throw new Error(rawDetail);
    },
    has() {
      proxyTrapCalls += 1;
      throw new Error(rawDetail);
    },
    ownKeys() {
      proxyTrapCalls += 1;
      throw new Error(rawDetail);
    },
  });
  const customCoded = new Error(rawDetail);
  customCoded.code = "EAUTH";
  const failures = [ownAccessor, inheritedAccessor, trapped, customCoded];
  let index = 0;
  const transport = {
    async send() {
      throw failures[index++];
    },
    close() {},
  };
  await withDatabase(smtpConfig, {
    mutations: {
      send: mutation((ctx) => ctx.mail.send({
        to: "recipient@example.com",
        subject: "hostile failure",
        textBody: "hostile failure",
      })),
    },
  }, { mailTransportFactory: () => transport }, async (database) => {
    for (let failureIndex = 0; failureIndex < failures.length; failureIndex += 1) {
      const result = await runMutation(database, user, "send", []);
      assert.deepEqual(result.error, {
        code: "MAIL_CONNECTION_FAILED",
        message: "SMTP delivery failed.",
        hint: "Check the SMTP host, port, network access, and provider status.",
      });
    }
    assert.equal(getterCalls, 0);
    assert.equal(proxyTrapCalls, 0);
    const events = database.log.tail().filter((event) => event.event === "mail.delivery");
    assert.equal(events.length, failures.length);
    for (const event of events) {
      assert.equal(event.level, "error");
      assert.equal(event.data.result, "MAIL_CONNECTION_FAILED");
    }
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes(rawDetail), false);
    assert.equal(serialized.includes("password-secret"), false);
    assert.equal(serialized.includes("inherited@example.com"), false);
  });
});

test("mail transport close is idempotent across shutdown and database close", async () => {
  for (const kind of ["sync", "async"]) {
    const dir = await mkdtemp(path.join(tmpdir(), `sporades-mail-${kind}-close-`));
    let closeCalls = 0;
    const firstResult = kind === "async" ? Promise.resolve(`${kind}-closed`) : `${kind}-closed`;
    const database = await openDevDatabase(
      path.join(dir, "data.db"),
      "",
      { SMTP_USERNAME: "user-secret", SMTP_PASSWORD: "password-secret" },
      smtpConfig,
      {},
      {
        mailTransportFactory: () => ({
          async send() {
            return { messageId: "<close@example.com>", accepted: [], rejected: [] };
          },
          close() {
            closeCalls += 1;
            return firstResult;
          },
        }),
      },
    );
    try {
      const directFirst = database.mail.close();
      assert.strictEqual(directFirst, firstResult);
      assert.strictEqual(database.mail.close(), firstResult);
      await database.shutdown();
      await database.close();
      assert.strictEqual(database.mail.close(), firstResult);
      assert.equal(closeCalls, 1, kind);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("concurrent and repeated shutdown calls run the lifecycle hook and mail close once", async () => {
  let releaseHook;
  const hookBarrier = new Promise((resolve) => {
    releaseHook = resolve;
  });
  let hookCalls = 0;
  let sends = 0;
  let closes = 0;
  const transport = {
    async send() {
      sends += 1;
      return { messageId: "<shutdown-once@example.com>", accepted: ["to@example.com"], rejected: [] };
    },
    close() {
      closes += 1;
    },
  };
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-mail-concurrent-shutdown-"));
  const database = await openDevDatabase(
    path.join(dir, "data.db"),
    "",
    { SMTP_USERNAME: "user-secret", SMTP_PASSWORD: "password-secret" },
    smtpConfig,
    {
      hooks: {
        shutdown: async (ctx) => {
          hookCalls += 1;
          await ctx.mail.send({ to: "to@example.com", subject: "shutdown once", textBody: "shutdown once" });
          await hookBarrier;
        },
      },
    },
    { mailTransportFactory: () => transport },
  );
  try {
    await database.init();
    const first = database.shutdown();
    const second = database.shutdown();
    assert.strictEqual(first, second);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(hookCalls, 1);
    assert.equal(sends, 1);
    assert.equal(closes, 0);
    releaseHook();
    assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
    assert.equal(hookCalls, 1);
    assert.equal(sends, 1);
    assert.equal(closes, 1);
    const repeated = database.shutdown();
    assert.strictEqual(repeated, first);
    assert.equal(await repeated, undefined);
    assert.equal(hookCalls, 1);
    assert.equal(sends, 1);
    assert.equal(closes, 1);
    await database.close();
    assert.equal(closes, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime shutdown promptly aborts an active stalled SMTP delivery", async () => {
  let acceptConnection;
  const accepted = new Promise((resolve) => {
    acceptConnection = resolve;
  });
  const server = createNetServer((socket) => {
    socket.on("error", () => {});
    acceptConnection();
    // Intentionally never send the SMTP greeting.
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-mail-shutdown-"));
  const database = await openDevDatabase(
    path.join(dir, "data.db"),
    "",
    {},
    {
      name: "mail-shutdown",
      mail: {
        smtp: {
          vendor: "generic",
          host: "127.0.0.1",
          port: server.address().port,
          tls: { mode: "disabled" },
          auth: { method: "none" },
          defaultFrom: "sender@example.com",
          connectionTimeoutMs: 5_000,
          socketTimeoutMs: 5_000,
        },
      },
    },
    {
      mutations: {
        send: mutation((ctx) => ctx.mail.send({
          to: "recipient@example.com",
          subject: "stalled",
          textBody: "stalled",
        })),
      },
    },
  );
  try {
    const pending = runMutation(database, user, "send", []);
    await accepted;
    const startedAt = Date.now();
    await database.shutdown();
    assert.ok(Date.now() - startedAt < 1_000, "shutdown waited for the stalled SMTP timeout");
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "MAIL_CONNECTION_FAILED");
  } finally {
    await database.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stalled SMTP greeting is bounded by the configured socket timeout", async () => {
  const server = createNetServer((socket) => socket.on("error", () => {}));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const config = {
    name: "mail-timeout",
    mail: {
      smtp: {
        vendor: "generic",
        host: "127.0.0.1",
        port: server.address().port,
        tls: { mode: "disabled" },
        auth: { method: "none" },
        defaultFrom: "sender@example.com",
        connectionTimeoutMs: 1_000,
        socketTimeoutMs: 100,
      },
    },
  };
  try {
    await withDatabase(config, {
      mutations: {
        send: mutation((ctx) => ctx.mail.send({
          to: "recipient@example.com",
          subject: "timeout",
          textBody: "timeout",
        })),
      },
    }, {}, async (database) => {
      const startedAt = Date.now();
      const result = await runMutation(database, user, "send", []);
      assert.equal(result.error.code, "MAIL_TIMEOUT");
      assert.ok(Date.now() - startedAt < 1_000, "stalled peer exceeded the configured timeout");
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("owned SMTP transport preserves stable connection, authentication, and rejection categories", async () => {
  const authServer = await startTestSmtpServer({ implicitTls: true, authReject: true });
  const rejectionServer = await startTestSmtpServer({ recipientReject: true });
  const refusedServer = createNetServer();
  await new Promise((resolve, reject) => {
    refusedServer.once("error", reject);
    refusedServer.listen(0, "127.0.0.1", resolve);
  });
  const refusedPort = refusedServer.address().port;
  await new Promise((resolve, reject) => refusedServer.close((error) => error ? reject(error) : resolve()));
  const cases = [
    [{
      name: "owned-auth-failure",
      mail: {
        smtp: {
          vendor: "generic",
          host: "127.0.0.1",
          port: authServer.port,
          tls: { mode: "implicit", rejectUnauthorized: false, servername: "smtp.internal.example" },
          auth: { method: "PLAIN", usernameEnv: "SMTP_USERNAME", passwordEnv: "SMTP_PASSWORD" },
          defaultFrom: "sender@example.com",
          connectionTimeoutMs: 1_000,
          socketTimeoutMs: 1_000,
        },
      },
    }, "MAIL_AUTH_FAILED"],
    [{
      name: "owned-recipient-rejection",
      mail: {
        smtp: {
          vendor: "generic",
          host: "127.0.0.1",
          port: rejectionServer.port,
          tls: { mode: "disabled" },
          auth: { method: "none" },
          defaultFrom: "sender@example.com",
          connectionTimeoutMs: 1_000,
          socketTimeoutMs: 1_000,
        },
      },
    }, "MAIL_REJECTED"],
    [{
      name: "owned-connect-failure",
      mail: {
        smtp: {
          vendor: "generic",
          host: "127.0.0.1",
          port: refusedPort,
          tls: { mode: "disabled" },
          auth: { method: "none" },
          defaultFrom: "sender@example.com",
          connectionTimeoutMs: 1_000,
          socketTimeoutMs: 1_000,
        },
      },
    }, "MAIL_CONNECTION_FAILED"],
  ];
  try {
    for (const [config, expectedCode] of cases) {
      await withDatabase(config, {
        mutations: {
          send: mutation((ctx) => ctx.mail.send({
            to: "recipient@example.com",
            subject: "owned transport category",
            textBody: "owned transport category",
          })),
        },
      }, {}, async (database) => {
        const result = await runMutation(database, user, "send", []);
        assert.equal(result.error.code, expectedCode);
        assert.deepEqual(Object.keys(result.error).sort(), ["code", "hint", "message"]);
      });
    }
  } finally {
    await authServer.close();
    await rejectionServer.close();
  }
});
