import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { openDevDatabase, createWebSocketHub, runMutation } from "../dist/server-runtime-source.js";
import { String, table, mutation } from "../dist/server.js";
import { createAdditionalTeam } from "../dist/teams-runtime.js";

async function fixture(policy, run, options = {}) {
  const dir = await mkdtemp(path.join(process.cwd(), ".team-create-policy-"));
  const capsule = {
    name: "team-create-policy",
    schema: { evidence: table({ value: String() }).acl({ read: () => false }) },
    teams: { admitCreate: policy, authorizeDestructive: () => ({ allow: true }) },
    mutations: {
      seed: mutation(ctx => ctx.db.evidence.insert({ value: "private" })),
      create: mutation((ctx, name) => ctx.teams.create(name)),
      caught: mutation(async ctx => {
        await ctx.db.evidence.insert({ value: "must roll back" });
        try { await ctx.teams.create("Caught"); } catch {}
        await ctx.db.evidence.insert({ value: "must also roll back" });
        return true;
      }),
      rollback: mutation(async ctx => { await ctx.teams.create("Rollback"); throw new Error("rollback"); }),
    },
  };
  let database, hub, server;
  try {
    const serverEnv = options.serverEnv ?? {};
    const config = { name: capsule.name, auth: { providers: { anonymous: true, email: true } }, ...options.config };
    const open = () => openDevDatabase(path.join(dir, "data.db"), "", serverEnv, config, capsule, options.runtimeOptions);
    database = await open();
    hub = createWebSocketHub(() => database);
    server = createServer();
    server.on("upgrade", (request, socket) => hub.accept(request, socket));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    let sequence = 0;
    async function client(name = "owner") {
      const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/?connectionToken=${hub.createConnectionToken()}`);
      await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
      const send = message => new Promise((resolve, reject) => {
        const id = `create-${sequence++}`;
        const timer = setTimeout(() => { ws.removeEventListener("message", listener); reject(new Error(`Timeout: ${message.type}`)); }, 10000);
        const listener = ({ data }) => { const result = JSON.parse(data); if (result.id === id) { clearTimeout(timer); ws.removeEventListener("message", listener); resolve(result); } };
        ws.addEventListener("message", listener);
        ws.send(JSON.stringify({ ...message, id }));
      });
      const signup = await send({ type: "auth.signUp", provider: "email", credentials: { email: `${name}@example.test`, password: "password-123", name } });
      assert.equal(signup.error, null, JSON.stringify(signup));
      return { send, auth: signup.data.auth, token: signup.data.sessionToken };
    }
    await run({ database, capsule, client, open });
  } finally {
    hub?.disconnectAll();
    if (server) await new Promise(resolve => server.close(resolve));
    await database?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function state(database) {
  const result = {};
  for (const name of ["sporades_teams", "sporades_team_memberships", "sporades_team_membership_counters", "sporades_team_bootstrap", "evidence"]) {
    result[name] = await database.adapter.prepare(database.adapter.dialect.sql(`SELECT * FROM [${name}]`)).all();
  }
  return result;
}

const create = (owner, via, name = "Requested") => owner.send(via === "sdk"
  ? { type: "teams.create", name }
  : { type: "mutation.run", name: "create", args: [name] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("creation policy denies SDK and server paths, poisons caught failures, and bypasses personal-Team bootstrap", async () => {
  let calls = 0;
  await fixture(() => { calls++; return { allow: false }; }, async ({ database, client }) => {
    const owner = await client();
    assert.equal(calls, 0);
    const before = await state(database);
    assert.equal(before.sporades_teams.length, 1);
    for (const via of ["sdk", "server"]) {
      assert.equal((await create(owner, via)).error?.code, "TEAM_POLICY_DENIED");
      assert.deepEqual(await state(database), before);
    }
    assert.equal((await owner.send({ type: "mutation.run", name: "caught", args: [] })).error?.code, "TEAM_POLICY_DENIED");
    assert.deepEqual(await state(database), before);
    assert.equal(calls, 3);
  });
});

test("creation input is frozen, normalized and counts live creator Teams even after leaving", async () => {
  const observations = [];
  await fixture((ctx, input) => { observations.push(input); assert.ok(Object.isFrozen(input)); return { allow: input.currentCreatedTeamCount < 3 }; }, async ({ database, client }) => {
    const owner = await client();
    const other = await client("other");
    const first = await create(owner, "sdk", "  Ａ\t Team  ");
    assert.equal(first.error, null);
    assert.deepEqual(observations[0], { actorUserId: owner.auth.userId, name: "A Team", currentCreatedTeamCount: 1 });
    const teamId = first.data.team.id;
    const link = await owner.send({ type: "teams.createJoinLink", teamId, email: other.auth.email });
    assert.equal(link.error, null);
    assert.equal((await other.send({ type: "teams.join", code: new URL(link.data.link).searchParams.get("code") })).error, null);
    assert.equal((await owner.send({ type: "teams.promote", teamId, userId: other.auth.userId })).error, null);
    assert.equal((await owner.send({ type: "teams.demote", teamId, userId: owner.auth.userId })).error, null);
    assert.equal((await owner.send({ type: "teams.leave", teamId })).error, null);
    assert.equal((await create(owner, "server")).error, null);
    assert.equal(observations.at(-1).currentCreatedTeamCount, 2);
    assert.equal((await create(owner, "sdk")).error?.code, "TEAM_POLICY_DENIED");
    assert.equal(observations.at(-1).currentCreatedTeamCount, 3);
    assert.equal((await other.send({ type: "teams.delete", teamId })).error, null);
    assert.equal((await create(owner, "sdk")).error, null);
    assert.equal(observations.at(-1).currentCreatedTeamCount, 2);
    const calls = observations.length;
    assert.equal((await create(owner, "sdk", "x".repeat(81))).error?.code, "INVALID_TEAM_NAME");
    assert.equal(observations.length, calls);
  });
});

for (const [label, policy] of [
  ["false", () => ({ allow: false })], ["missing", () => undefined], ["array", () => [true]],
  ["truthy", () => ({ allow: 1 })], ["inherited", () => Object.create({ allow: true })],
  ["accessor", () => ({ get allow() { throw new Error("private"); } })],
  ["extra", () => ({ allow: true, private: "secret" })],
  ["symbol", () => ({ allow: true, [Symbol()]: true })],
  ["throw", () => { throw new Error("private provider diagnostic"); }],
  ["caught read failure", async ctx => { try { await ctx.db.evidence.where("absent", "bad").all(); } catch {} return { allow: true }; }],
]) test(`${label}: creation policy fails closed and rolls back caught failure`, async () => {
  await fixture(policy, async ({ database, client }) => {
    const owner = await client();
    const before = await state(database);
    for (const via of ["sdk", "server"]) {
      const result = await create(owner, via);
      assert.equal(result.error?.code, "TEAM_POLICY_DENIED", JSON.stringify(result));
      assert.doesNotMatch(JSON.stringify(result), /private|secret|provider diagnostic/);
    }
    assert.equal((await owner.send({ type: "mutation.run", name: "caught", args: [] })).error?.code, "TEAM_POLICY_DENIED");
    assert.deepEqual(await state(database), before);
  });
});

test("creation policy read capability is narrow, cross-owner and revoked after settle, including aliases", async () => {
  let captured, tableAlias, queryAlias, all;
  await fixture(async (ctx, input) => {
    assert.ok(Object.isFrozen(ctx)); assert.ok(Object.isFrozen(ctx.app)); assert.ok(Object.isFrozen(ctx.auth));
    assert.deepEqual(Object.keys(ctx).sort(), ["app", "auth", "db", "signal"]);
    assert.equal(ctx.auth.userId, input.actorUserId);
    for (const key of ["adapter", "raw", "sporades_teams", "sporades_auth_users"]) assert.equal(ctx.db[key], undefined);
    tableAlias = ctx.db.evidence; queryAlias = tableAlias.where("value", "private"); all = queryAlias.all;
    for (const key of ["insert", "update", "delete", "exec", "prepare"]) assert.equal(tableAlias[key], undefined);
    assert.equal((await queryAlias.all()).length, 1);
    captured = ctx;
    return { allow: true };
  }, async ({ database, client }) => {
    const owner = await client();
    assert.equal((await owner.send({ type: "mutation.run", name: "seed", args: [] })).error, null);
    for (const via of ["sdk", "server"]) {
      assert.equal((await create(owner, via)).error, null);
      for (const read of [() => captured.db.evidence.all(), () => tableAlias.all(), () => queryAlias.get(), () => all()]) {
        assert.throws(read, error => error.code === "TRUSTED_READ_ACCESS_INACTIVE");
      }
    }
  });
});

test("abort revokes creation policy reads and rolls back before a late allow", async () => {
  const entered = deferred(), release = deferred(); let captured;
  await fixture(async ctx => { captured = ctx.db.evidence; entered.resolve(); await release.promise; return { allow: true }; }, async ({ database, client }) => {
    const owner = await client(); const before = await state(database);
    const controller = new AbortController();
    const response = runMutation(database, owner.auth, "create", ["Abort"], { sessionToken: owner.token, signal: controller.signal });
    await entered.promise; controller.abort();
    assert.equal((await response).error?.code, "TEAM_POLICY_DENIED");
    assert.throws(() => captured.all(), error => error.code === "TRUSTED_READ_ACCESS_INACTIVE");
    release.resolve();
    assert.deepEqual(await state(database), before);
  });
});

test("revoked Session and stale actors cannot gain creation authority from a policy grant", async () => {
  let calls = 0;
  await fixture(() => { calls++; return { allow: true }; }, async ({ database, client }) => {
    const owner = await client(); const before = await state(database);
    await database.adapter.deleteAuthSession(owner.token);
    assert.equal((await runMutation(database, owner.auth, "create", ["Revoked"], { sessionToken: owner.token })).error?.code, "TEAM_POLICY_DENIED");
    await assert.rejects(createAdditionalTeam(database, { ...owner.auth, userId: "missing-user" }, "Missing"));
    assert.equal(calls, 0);
    assert.deepEqual(await state(database), before);
  });
});

test("five-second policy budget rejects non-cooperative callbacks and revokes aliases", async () => {
  const entered = deferred(), release = deferred();
  let expire, captured;
  const clock = {
    now: () => new Date(),
    setTimer(fn, ms) { if (ms === 5000) { expire = fn; return "policy"; } return setTimeout(fn, ms); },
    clearTimer(id) { if (id !== "policy") clearTimeout(id); },
  };
  await fixture(async ctx => {
    captured = ctx; entered.resolve(); await release.promise;
    await ctx.db.evidence.all();
    return { allow: true };
  }, async ({ database, client }) => {
    const owner = await client(); const before = await state(database);
    const response = create(owner, "sdk");
    await entered.promise; expire();
    assert.equal((await response).error?.code, "TEAM_POLICY_DENIED");
    assert.ok(captured.signal.aborted);
    assert.throws(() => captured.db.evidence.all(), error => error.code === "TRUSTED_READ_ACCESS_INACTIVE");
    release.resolve();
    assert.deepEqual(await state(database), before);
  }, { runtimeOptions: { clock } });
});

test("unfinished policy reads deny and cannot return data after callback settlement", async () => {
  const { withFakeLibsqlService } = await import("./support/libsql-http-service.js");
  const dir = await mkdtemp(path.join(process.cwd(), ".team-create-libsql-"));
  const entered = deferred(), release = deferred();
  let delay = false, pending;
  try {
    await withFakeLibsqlService(path.join(dir, "data.db"), {
      async beforeStatement(sql) {
        if (delay && /^SELECT .* FROM "evidence"/.test(sql)) { entered.resolve(); await release.promise; }
      },
    }, async ({ url }) => fixture(async ctx => {
      pending = ctx.db.evidence.all().then(rows => ({ rows }), error => ({ error }));
      await entered.promise;
      return { allow: true };
    }, async ({ database, client }) => {
      const owner = await client(); const before = await state(database);
      delay = true;
      const response = create(owner, "server");
      await entered.promise;
      // Let the callback settle before the outstanding adapter read returns.
      await new Promise(resolve => setImmediate(resolve));
      release.resolve();
      assert.equal((await response).error?.code, "TEAM_POLICY_DENIED");
      const result = await pending;
      assert.equal(result.rows, undefined);
      assert.equal(result.error?.code, "TRUSTED_READ_ACCESS_INACTIVE");
      delay = false;
      assert.deepEqual(await state(database), before);
    }, {
      serverEnv: { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url },
      config: { services: { database: { kind: "database", engine: "libsql" } } },
    }));
  } finally { release.resolve(); await rm(dir, { recursive: true, force: true }); }
});

test("omission preserves creation and an allow policy cannot exceed the membership cap", async () => {
  await fixture(undefined, async ({ client }) => {
    const owner = await client();
    assert.equal((await create(owner, "sdk")).error, null);
    assert.equal((await create(owner, "server")).error, null);
  });
  let calls = 0;
  await fixture(() => { calls++; return { allow: true }; }, async ({ database, client }) => {
    const owner = await client();
    for (let index = 0; index < 24; index++) await createAdditionalTeam(database, owner.auth, `Team ${index}`);
    const before = await state(database);
    for (const via of ["sdk", "server"]) assert.equal((await create(owner, via)).error?.code, "TEAM_LIMIT_REACHED");
    assert.equal(calls, 24);
    assert.deepEqual(await state(database), before);
  });
});

for (const engine of ["sqlite", "postgres"]) test(`${engine}: separate connections serialize count admission and rollback preserves capacity`, {
  skip: engine === "postgres" && !process.env.SPORADES_POSTGRES_TEST_URL ? "Set SPORADES_POSTGRES_TEST_URL for real PostgreSQL conformance" : false,
}, async () => {
  const counts = [];
  const policy = async (ctx, input) => { await ctx.db.evidence.all(); counts.push(input.currentCreatedTeamCount); return { allow: input.currentCreatedTeamCount < 2 }; };
  const run = async options => fixture(policy, async ({ database, client, open }) => {
    const owner = await client(); const before = await state(database);
    assert.ok((await owner.send({ type: "mutation.run", name: "rollback", args: [] })).error);
    assert.deepEqual(await state(database), before);
    const second = await open();
    try {
      const results = await Promise.allSettled([createAdditionalTeam(database, owner.auth, "One"), createAdditionalTeam(second, owner.auth, "Two")]);
      assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
      assert.equal(results.find(result => result.status === "rejected").reason.code, "TEAM_POLICY_DENIED");
      assert.deepEqual(counts, [1, 1, 2]);
      const committed = await state(database);
      assert.equal(committed.sporades_teams.length, 2);
      for (const via of ["sdk", "server"]) assert.equal((await create(owner, via)).error?.code, "TEAM_POLICY_DENIED");
      assert.deepEqual(await state(database), committed);
    } finally { await second.close(); }
  }, options);
  if (engine === "sqlite") await run();
  else {
    const { withPostgresAdapter } = await import("./support/database-adapter-engines.js");
    await withPostgresAdapter(async () => {}, { appTableNames: ["evidence"] });
    await run({ serverEnv: { SPORADES_SERVICE_DATABASE_ENGINE: engine, SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL }, config: { services: { database: { kind: "database", engine } } } });
  }
});

test("invalid creation policy declarations reject startup", async () => {
  for (const policy of [null, false, 1, "allow", {}]) {
    await assert.rejects(fixture(policy, () => {}), error => error.code === "INVALID_TEAM_CREATE_ADMISSION");
  }
});
