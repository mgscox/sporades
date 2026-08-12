import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { openDevDatabase, routeEndpoint, runQuery } from "../dist/server-runtime-source.js";
import { emailEvent, job, query } from "../dist/server.js";

const mailjetSent = {
  event: "sent",
  time: 1433333949,
  MessageID: 19421777835146490,
  Message_GUID: "1ab23cd4-e567-8901-2345-6789f0gh1i2j",
  email: "Client@Example.com",
  mj_message_id: "19421777835146490",
  smtp_reply: "sent (250 2.0.0 OK)",
  CustomID: "delivery-correlation-1",
  Payload: "",
};

const mailjetDocumentedLifecycleFixtures = [
  mailjetSent,
  {
    event: "open", time: 1433103519, MessageID: 19421777396190490,
    Message_GUID: "1ab23cd4-e567-8901-2345-6789f0gh1i2j", email: "api@mailjet.com",
    mj_campaign_id: 7173, mj_contact_id: 320, customcampaign: "", CustomID: "helloworld",
    Payload: "", ip: "127.0.0.1", geo: "US",
    agent: "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0",
  },
  {
    event: "click", time: 1433334653, MessageID: 19421777836302490,
    Message_GUID: "1ab23cd4-e567-8901-2345-6789f0gh1i2j", email: "api@mailjet.com",
    mj_campaign_id: 7272, mj_contact_id: 4, customcampaign: "", CustomID: "helloworld",
    Payload: "", url: "https://mailjet.com", ip: "127.0.0.1", geo: "FR",
    agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_0) AppleWebKit/537.36",
  },
  {
    event: "bounce", time: 1430812195, MessageID: 13792286917004336,
    Message_GUID: "1ab23cd4-e567-8901-2345-6789f0gh1i2j", email: "bounce@mailjet.com",
    mj_campaign_id: 0, mj_contact_id: 0, customcampaign: "", CustomID: "helloworld",
    Payload: "", blocked: false, hard_bounce: true, error_related_to: "recipient",
    error: "user unknown", comment: "Host or domain name not found",
  },
  {
    event: "blocked", time: 1430812195, MessageID: 13792286917004336,
    Message_GUID: "1ab23cd4-e567-8901-2345-6789f0gh1i2j", email: "bounce@mailjet.com",
    mj_campaign_id: 0, mj_contact_id: 0, customcampaign: "", CustomID: "helloworld",
    Payload: "", error_related_to: "recipient", error: "user unknown",
  },
  {
    event: "spam", time: 1430812195, MessageID: 13792286917004336,
    Message_GUID: "1ab23cd4-e567-8901-2345-6789f0gh1i2j", email: "bounce@mailjet.com",
    mj_campaign_id: 0, mj_contact_id: 0, customcampaign: "", CustomID: "helloworld",
    Payload: "", source: "JMRPP",
  },
  {
    event: "unsub", time: 1433334941, MessageID: 20547674933128000,
    Message_GUID: "1ab23cd4-e567-8901-2345-6789f0gh1i2j", email: "api@mailjet.com",
    mj_campaign_id: 7276, mj_contact_id: 126, customcampaign: "", CustomID: "helloworld",
    Payload: "", mj_list_id: 1, ip: "127.0.0.1", geo: "FR",
    agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_0) AppleWebKit/537.36 Chrome/42.0.2311.135",
  },
];

// Shape and value types come from SMTP2GO's live Test this webhook JSON output;
// values are provider-synthetic or replaced while retaining their original types.
const smtp2goCommon = {
  "Message-Id": "<send-42@example.com>",
  Subject: "Mail test - please ignore",
  "X-Sporades-Correlation-Id": "delivery-correlation-2",
  auth: "smtp-user",
  email_id: "email-7ca7f608",
  from: "mail@example.com",
  from_address: "mail@example.com",
  from_name: "",
  "message-id": "<send-42@example.com>",
  sender: "mail@example.com",
  sendtime: "2015-08-04T22:39:34Z",
  subject: "Mail test - please ignore",
  time: "2019-07-03T22:46:33Z",
};

const smtp2goDelivered = {
  ...smtp2goCommon,
  context: "RCPT TO:<client@example.com>",
  event: "delivered",
  host: "mail.example.com [203.0.113.22]",
  id: "76f25fdc693aa43863f9409ab5f0e703",
  message: "250 OK",
  rcpt: "Client@Example.com",
};

const smtp2goDocumentedLifecycleFixtures = [
  {
    ...smtp2goCommon, event: "processed", id: "5f1a307f74e3e3f61551a30a377ac908",
    recipients: ["client@example.com", "other@example.com"], srchost: "203.0.113.22",
  },
  smtp2goDelivered,
  {
    ...smtp2goCommon, event: "open", id: "38b4c516440ec91673b7ecde3ba16b19",
    context: "Unavailable", message: "Unavailable", rcpt: "client@example.com",
    "opened-at": "2019-07-03T22:46:33Z", "user-agent": "Mail client", "read-secs": "60",
    client: "Thunderbird 2.0", "client-device": "Other", "client-os": "Linux",
    "geoip-continent": "OC", "geoip-country": "NZ", "geoip-city": "Auckland",
    srchost: "192.0.2.10",
  },
  {
    ...smtp2goCommon, event: "click", id: "ba3b0cd48f8b69c6f2510536e05e030b",
    context: "Unavailable", message: "Unavailable", rcpt: "client@example.com",
    "clicked-at": "2019-07-03T22:46:33Z", url: "https://example.com/report",
    "user-agent": "Mail client", client: "Thunderbird 2.0", "client-device": "Other",
    "client-os": "Linux", "geoip-continent": "OC", "geoip-country": "NZ",
    "geoip-city": "Auckland", srchost: "192.0.2.10",
  },
  {
    ...smtp2goCommon, event: "bounce", id: "fa3fe1c3f316014def2d7bd32779fccd",
    context: "RCPT TO:<client@example.com>", rcpt: "client@example.com",
    bounce: "hard", host: "mx.example.com", message: "550 user unknown",
  },
  {
    ...smtp2goCommon, event: "bounce", id: "smtp2go-event-soft-bounce",
    context: "RCPT TO:<client@example.com>", rcpt: "client@example.com",
    bounce: "soft", host: "mx.example.com", message: "451 try again later",
  },
  {
    ...smtp2goCommon, event: "spam", id: "90500515721201307fc68b1358a383d7",
    context: "feedback", message: "", rcpt: "client@example.com",
  },
  {
    ...smtp2goCommon, event: "unsubscribe", id: "dd808e3290be2bf8caa13f0ebc2b4e37",
    context: "feedback", message: "mail@example.com", rcpt: "client@example.com",
  },
  {
    ...smtp2goCommon, event: "resubscribe", id: "smtp2go-event-resubscribe",
    context: "feedback", message: "mail@example.com", rcpt: "client@example.com",
  },
  {
    ...smtp2goCommon, event: "reject", id: "c003df08125abef6a0550b867749b239",
    context: "submission", message: "sender not verified", rcpt: "client@example.com",
    srchost: "192.0.2.10",
  },
];

const anonymous = {
  userId: "email-event-reader",
  displayName: "Email event reader",
  email: null,
  picture: null,
  isAuthenticated: false,
  isGuest: false,
  provider: "test",
};

async function withEmailEventDatabase(config, capsule, run, serverEnv = {
  MAILJET_WEBHOOK_SECRET: "mailjet-webhook-secret",
  SMTP2GO_WEBHOOK_SECRET: "smtp2go-webhook-secret",
}) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-email-events-"));
  const database = await openDevDatabase(
    path.join(dir, "data.db"),
    "",
    serverEnv,
    config,
    capsule,
  );
  try {
    return await run(database);
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function jsonRequest(pathname, body, token = "mailjet-webhook-secret") {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: "POST",
    url: `${pathname}?token=${encodeURIComponent(token)}`,
    headers: { "content-type": "application/json" },
  });
}

function responseCapture() {
  let resolveFinished;
  const finished = new Promise((resolve) => { resolveFinished = resolve; });
  return {
    status: null,
    headers: null,
    body: "",
    finished,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = "") {
      this.body += String(body);
      resolveFinished();
    },
  };
}

const mailjetConfig = {
  mail: {
    webhooks: {
      mailjet: { path: "/mailjet-webhook", secretEnv: "MAILJET_WEBHOOK_SECRET" },
    },
  },
};

async function postMailjet(database, body, { token = "mailjet-webhook-secret", authorization } = {}) {
  const request = jsonRequest("/mailjet-webhook", body, token);
  if (authorization !== undefined) request.headers.authorization = authorization;
  const response = responseCapture();
  const handled = await routeEndpoint(database, request, response);
  if (handled) await response.finished;
  return { handled, response };
}

const smtp2goConfig = {
  mail: {
    webhooks: {
      smtp2go: { path: "/smtp2go-webhook", secretEnv: "SMTP2GO_WEBHOOK_SECRET" },
    },
  },
};

async function postSmtp2go(database, body, authorization = "Bearer smtp2go-webhook-secret") {
  const request = Object.assign(Readable.from([JSON.stringify(body)]), {
    method: "POST",
    url: "/smtp2go-webhook",
    headers: { "content-type": "application/json", authorization },
  });
  const response = responseCapture();
  const handled = await routeEndpoint(database, request, response);
  if (handled) await response.finished;
  return { handled, response };
}

test("SMTP2GO callbacks reach the same provider-neutral subscription only when configured and verified", async () => {
  const seen = [];
  const capsule = { emailEvents: emailEvent((_ctx, event) => { seen.push(event); }) };

  await withEmailEventDatabase({}, capsule, async (database) => {
    assert.equal((await postSmtp2go(database, smtp2goDelivered)).handled, false);
  });

  await withEmailEventDatabase(smtp2goConfig, capsule, async (database) => {
    assert.equal((await postSmtp2go(database, smtp2goDelivered, "Bearer wrong")).response.status, 401);
    assert.equal(seen.length, 0);
    const result = await postSmtp2go(database, smtp2goDelivered);
    assert.equal(result.response.status, 200);
    assert.deepEqual(seen, [{
      provider: "smtp2go",
      kind: "delivered",
      providerEventId: "76f25fdc693aa43863f9409ab5f0e703",
      occurredAt: "2019-07-03T22:46:33.000Z",
      correlationId: "delivery-correlation-2",
      recipient: "client@example.com",
      raw: smtp2goDelivered,
    }]);
  });
});

test("SMTP2GO documented email lifecycle names normalize without changing raw event objects", async () => {
  const seen = [];
  const capsule = { emailEvents: emailEvent((_ctx, event) => { seen.push(event); }) };
  await withEmailEventDatabase(smtp2goConfig, capsule, async (database) => {
    for (const fixture of smtp2goDocumentedLifecycleFixtures) {
      assert.equal((await postSmtp2go(database, fixture)).response.status, 200);
    }
    assert.deepEqual(
      seen.map(({ kind }) => kind),
      ["deferred", "delivered", "opened", "clicked", "bounced", "bounced", "complained", "unsubscribed", "resubscribed", "blocked"],
    );
    assert.deepEqual(seen.map(({ raw }) => raw), smtp2goDocumentedLifecycleFixtures);
  });
});

test("SMTP2GO accepts omitted optional fields and exposes a stable identity on duplicate delivery", async () => {
  const minimal = { event: "delivered", time: 1786529730, id: "smtp2go-event-minimal" };
  const seen = [];
  const capsule = { emailEvents: emailEvent((_ctx, event) => { seen.push(event); }) };
  await withEmailEventDatabase(smtp2goConfig, capsule, async (database) => {
    assert.equal((await postSmtp2go(database, minimal)).response.status, 200);
    assert.equal((await postSmtp2go(database, minimal)).response.status, 200);
  });
  assert.deepEqual(seen, [
    {
      provider: "smtp2go",
      kind: "delivered",
      providerEventId: "smtp2go-event-minimal",
      occurredAt: "2026-08-12T10:15:30.000Z",
      raw: minimal,
    },
    {
      provider: "smtp2go",
      kind: "delivered",
      providerEventId: "smtp2go-event-minimal",
      occurredAt: "2026-08-12T10:15:30.000Z",
      raw: minimal,
    },
  ]);
});

test("SMTP2GO acknowledgement and failure semantics remain independent of a Capsule subscription", async () => {
  await withEmailEventDatabase(smtp2goConfig, {}, async (database) => {
    const accepted = await postSmtp2go(database, smtp2goDelivered);
    assert.equal(accepted.response.status, 200);
    assert.deepEqual(JSON.parse(accepted.response.body), { ok: true, accepted: 1, ignored: 0 });
    assert.equal((await postSmtp2go(database, smtp2goDelivered, "")).response.status, 401);
    for (const malformed of [[], [smtp2goDelivered], {}, { ...smtp2goDelivered, id: "" }, { ...smtp2goDelivered, time: "never" }]) {
      assert.equal((await postSmtp2go(database, malformed)).response.status, 400);
    }
    const unknown = await postSmtp2go(database, { ...smtp2goDelivered, event: "future-event" });
    assert.equal(unknown.response.status, 200);
    assert.deepEqual(JSON.parse(unknown.response.body), { ok: true, accepted: 0, ignored: 1 });
  });

  await withEmailEventDatabase(smtp2goConfig, {}, async (database) => {
    assert.equal((await postSmtp2go(database, smtp2goDelivered)).response.status, 503);
  }, {});

  await withEmailEventDatabase(
    smtp2goConfig,
    { emailEvents: emailEvent(() => { throw new Error("application failed"); }) },
    async (database) => {
      assert.equal((await postSmtp2go(database, smtp2goDelivered)).response.status, 500);
    },
  );
});

test("Mailjet callbacks reach the provider-neutral Capsule email-event subscription only when configured", async () => {
  const seen = [];
  const capsule = {
    emailEvents: emailEvent((_ctx, event) => { seen.push(event); }),
    queries: { seen: query(() => seen) },
  };

  await withEmailEventDatabase({}, capsule, async (database) => {
    const response = responseCapture();
    assert.equal(await routeEndpoint(database, jsonRequest("/mailjet-webhook", mailjetSent), response), false);
    assert.deepEqual((await runQuery(database, anonymous, "seen")).data, []);
  });

  await withEmailEventDatabase(mailjetConfig, capsule, async (database) => {
    const response = responseCapture();
    assert.equal(await routeEndpoint(database, jsonRequest("/mailjet-webhook", mailjetSent), response), true);
    await response.finished;
    assert.equal(response.status, 200);
    assert.deepEqual((await runQuery(database, anonymous, "seen")).data, [{
      provider: "mailjet",
      kind: "delivered",
      providerEventId: "sent:1ab23cd4-e567-8901-2345-6789f0gh1i2j:1433333949",
      occurredAt: "2015-06-03T12:19:09.000Z",
      correlationId: "delivery-correlation-1",
      recipient: "client@example.com",
      raw: mailjetSent,
    }]);
  });
});

test("an enabled Mailjet route acknowledges verified events without requiring a Capsule subscription", async () => {
  await withEmailEventDatabase(mailjetConfig, {}, async (database) => {
    const result = await postMailjet(database, mailjetSent);
    assert.equal(result.handled, true);
    assert.equal(result.response.status, 200);
    assert.deepEqual(JSON.parse(result.response.body), { ok: true, accepted: 1, ignored: 0 });
  });
});

test("Mailjet retries use one stable provider actor for durable Job idempotency", async () => {
  const capsule = {
    emailEvents: emailEvent((ctx, event) => ctx.jobs.enqueue(
      "recordDelivery",
      event,
      { idempotencyKey: event.providerEventId, availableAt: new Date(Date.now() + 60_000).toISOString() },
    )),
    jobs: { recordDelivery: job(() => null) },
  };
  await withEmailEventDatabase(mailjetConfig, capsule, async (database) => {
    assert.equal((await postMailjet(database, mailjetSent)).response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await postMailjet(database, mailjetSent)).response.status, 200);
    const rows = database.adapter.prepare(
      "SELECT [actorUserId], [actorProvider], [idempotencyKey] FROM [sporades_jobs]",
    ).all().map((row) => ({ ...row }));
    assert.deepEqual(rows, [{
      actorUserId: "__privileged__",
      actorProvider: "privileged-server-role",
      idempotencyKey: "sent:1ab23cd4-e567-8901-2345-6789f0gh1i2j:1433333949",
    }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

test("Mailjet callbacks fail closed and accept either supported credential form", async () => {
  const seen = [];
  const capsule = { emailEvents: emailEvent((_ctx, event) => { seen.push(event); }) };
  await withEmailEventDatabase(mailjetConfig, capsule, async (database) => {
    assert.equal((await postMailjet(database, mailjetSent, { token: "wrong" })).response.status, 401);
    assert.equal(seen.length, 0);

    const basic = `Basic ${Buffer.from("mailjet:mailjet-webhook-secret").toString("base64")}`;
    assert.equal((await postMailjet(database, mailjetSent, { token: "", authorization: basic })).response.status, 200);
    assert.equal(seen.length, 1);
  });

  await withEmailEventDatabase(mailjetConfig, capsule, async (database) => {
    assert.equal((await postMailjet(database, mailjetSent)).response.status, 503);
  }, {});
});

test("runtime-owned Mailjet routes never mint Anonymous users or sessions", async () => {
  await withEmailEventDatabase(mailjetConfig, { emailEvents: emailEvent(() => {}) }, async (database) => {
    const middlewareAuth = [];
    database.contextMiddleware = [
      "async (ctx) => { globalThis.__emailEventMiddlewareAuth.push(ctx.auth.userId); }",
    ];
    globalThis.__emailEventMiddlewareAuth = middlewareAuth;
    assert.equal((await postMailjet(database, mailjetSent, { token: "wrong" })).response.status, 401);
    assert.equal((await postMailjet(database, mailjetSent)).response.status, 200);
    assert.equal(database.adapter.prepare("SELECT COUNT(*) AS count FROM [sporades_auth_users]").get().count, 0);
    assert.equal(database.adapter.prepare("SELECT COUNT(*) AS count FROM [sporades_auth_sessions]").get().count, 0);
    assert.deepEqual(middlewareAuth, [], "unverified provider requests must not reach Capsule middleware");
    delete globalThis.__emailEventMiddlewareAuth;
  });
});

test("runtime-owned SMTP2GO routes never mint Anonymous users or sessions", async () => {
  await withEmailEventDatabase(smtp2goConfig, { emailEvents: emailEvent(() => {}) }, async (database) => {
    assert.equal((await postSmtp2go(database, smtp2goDelivered, "Bearer wrong")).response.status, 401);
    assert.equal((await postSmtp2go(database, smtp2goDelivered)).response.status, 200);
    assert.equal(database.adapter.prepare("SELECT COUNT(*) AS count FROM [sporades_auth_users]").get().count, 0);
    assert.equal(database.adapter.prepare("SELECT COUNT(*) AS count FROM [sporades_auth_sessions]").get().count, 0);
  });
});

test("Mailjet single and grouped fixtures dispatch exact raw events through the same subscription", async () => {
  const seen = [];
  const opened = { ...mailjetSent, event: "open", time: 1433333999, ip: "192.0.2.10", agent: "Mail client" };
  const capsule = {
    emailEvents: emailEvent((_ctx, event) => { seen.push(event); }),
    queries: { seen: query(() => seen) },
  };
  await withEmailEventDatabase(mailjetConfig, capsule, async (database) => {
    const result = await postMailjet(database, [mailjetSent, opened]);
    assert.equal(result.response.status, 200);
    assert.deepEqual(JSON.parse(result.response.body), { ok: true, accepted: 2, ignored: 0 });
    const events = (await runQuery(database, anonymous, "seen")).data;
    assert.deepEqual(events.map(({ kind }) => kind), ["delivered", "opened"]);
    assert.deepEqual(events.map(({ raw }) => raw), [mailjetSent, opened]);
  });
});

test("Mailjet lifecycle names normalize to the provider-neutral event vocabulary", async () => {
  const seen = [];
  const capsule = { emailEvents: emailEvent((_ctx, event) => { seen.push(event); }) };
  await withEmailEventDatabase(mailjetConfig, capsule, async (database) => {
    assert.equal((await postMailjet(database, mailjetDocumentedLifecycleFixtures)).response.status, 200);
    assert.deepEqual(
      seen.map(({ kind }) => kind),
      ["delivered", "opened", "clicked", "bounced", "blocked", "complained", "unsubscribed"],
    );
    assert.deepEqual(seen.map(({ raw }) => raw), mailjetDocumentedLifecycleFixtures);
  });
});

test("known Mailjet events require a stable string identity and timestamp", async () => {
  const seen = [];
  const capsule = { emailEvents: emailEvent((_ctx, event) => { seen.push(event); }) };
  await withEmailEventDatabase(mailjetConfig, capsule, async (database) => {
    for (const invalid of [
      { event: "sent", time: mailjetSent.time, MessageID: mailjetSent.MessageID },
      { ...mailjetSent, Message_GUID: undefined, mj_message_id: 19421777835146490 },
      { ...mailjetSent, time: "not-a-timestamp" },
    ]) {
      assert.equal((await postMailjet(database, invalid)).response.status, 400);
    }
    assert.equal(seen.length, 0);
  });
});

test("Mailjet click identity does not confuse URL punctuation with a missing message identity", async () => {
  const seen = [];
  const raw = { ...mailjetDocumentedLifecycleFixtures[2], url: "https://example.test/?value=a::b" };
  await withEmailEventDatabase(
    mailjetConfig,
    { emailEvents: emailEvent((_ctx, event) => { seen.push(event); }) },
    async (database) => {
      assert.equal((await postMailjet(database, raw)).response.status, 200);
      assert.equal(seen[0].raw.url, raw.url);
    },
  );
});

test("Mailjet malformed callbacks retry while unknown event types are acknowledged", async () => {
  const seen = [];
  const capsule = { emailEvents: emailEvent((_ctx, event) => { seen.push(event); }) };
  await withEmailEventDatabase(mailjetConfig, capsule, async (database) => {
    const malformed = await postMailjet(database, "not event JSON");
    assert.equal(malformed.response.status, 400);
    for (const invalid of [{}, [42], [{ event: 42 }], []]) {
      assert.equal((await postMailjet(database, invalid)).response.status, 400);
    }
    const unknown = await postMailjet(database, [{ event: "invented", raw: true }]);
    assert.equal(unknown.response.status, 200);
    assert.deepEqual(JSON.parse(unknown.response.body), { ok: true, accepted: 0, ignored: 1 });
    assert.equal(seen.length, 0);
  });
});

test("a Capsule email-event handler failure rejects the provider callback", async () => {
  const capsule = { emailEvents: emailEvent(() => { throw new Error("application failed"); }) };
  await withEmailEventDatabase(mailjetConfig, capsule, async (database) => {
    const result = await postMailjet(database, mailjetSent);
    assert.equal(result.response.status, 500);
    assert.equal(JSON.parse(result.response.body).error.message, "Privileged run failed.");
  });
});

test("Mailjet webhook configuration rejects unsafe paths and Server env references", async () => {
  const capsule = { emailEvents: emailEvent(() => {}) };
  for (const mailjet of [
    { path: "https://capsule.example/mailjet", secretEnv: "MAILJET_WEBHOOK_SECRET" },
    { path: "/mailjet?token=checked-in", secretEnv: "MAILJET_WEBHOOK_SECRET" },
    { path: "/mailjet", secretEnv: "not-an-env-name" },
  ]) {
    await assert.rejects(
      withEmailEventDatabase({ mail: { webhooks: { mailjet } } }, capsule, async () => {}),
      (error) => error.code === "INVALID_MAIL_CONFIG",
    );
  }
});

test("SMTP2GO webhook configuration rejects unsafe paths and Server env references", async () => {
  for (const smtp2go of [
    { path: "https://capsule.example/smtp2go", secretEnv: "SMTP2GO_WEBHOOK_SECRET" },
    { path: "/smtp2go?token=checked-in", secretEnv: "SMTP2GO_WEBHOOK_SECRET" },
    { path: "/smtp2go", secretEnv: "not-an-env-name" },
  ]) {
    await assert.rejects(
      withEmailEventDatabase({ mail: { webhooks: { smtp2go } } }, {}, async () => {}),
      (error) => error.code === "INVALID_MAIL_CONFIG",
    );
  }
});

test("email-provider routes cannot overlap Sporades runtime-owned HTTP namespaces", async () => {
  const capsule = { emailEvents: emailEvent(() => {}) };
  for (const path of [
    "/__sporades/auth/google/callback",
    "/__sporades/uploads/upload-id",
    "/__sporades/files/private/file-id",
    "/__sporades/health/runtime",
    "/__sporades/debug/auth/clients",
  ]) {
    await assert.rejects(
      withEmailEventDatabase(
        { mail: { webhooks: { mailjet: { path, secretEnv: "MAILJET_WEBHOOK_SECRET" } } } },
        capsule,
        async () => {},
      ),
      (error) => error.code === "INVALID_MAIL_CONFIG",
      path,
    );
  }
});

test("a Capsule endpoint cannot shadow its configured provider-facing email-event route", async () => {
  const capsule = {
    emailEvents: emailEvent(() => {}),
    endpoints: {
      collision: { kind: "endpoint", options: { method: "POST", path: "/mailjet-webhook" }, handler: () => "shadowed" },
    },
  };
  await assert.rejects(
    withEmailEventDatabase(mailjetConfig, capsule, async () => {}),
    (error) => error.code === "EMAIL_EVENT_ROUTE_CONFLICT",
  );
});

test("two enabled email providers cannot claim the same provider-facing route", async () => {
  const config = {
    mail: {
      webhooks: {
        mailjet: { path: "/email-events", secretEnv: "MAILJET_WEBHOOK_SECRET" },
        smtp2go: { path: "/email-events", secretEnv: "SMTP2GO_WEBHOOK_SECRET" },
      },
    },
  };
  await assert.rejects(
    withEmailEventDatabase(config, { emailEvents: emailEvent(() => {}) }, async () => {}),
    (error) => error.code === "EMAIL_EVENT_ROUTE_CONFLICT",
  );
});
