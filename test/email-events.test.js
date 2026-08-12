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

const anonymous = {
  userId: "email-event-reader",
  displayName: "Email event reader",
  email: null,
  picture: null,
  isAuthenticated: false,
  isGuest: false,
  provider: "test",
};

async function withEmailEventDatabase(config, capsule, run, serverEnv = { MAILJET_WEBHOOK_SECRET: "mailjet-webhook-secret" }) {
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
