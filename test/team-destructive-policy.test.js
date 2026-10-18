import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { openDevDatabase, createWebSocketHub } from "../dist/server-runtime-source.js";
import { String, table, mutation, query } from "../dist/server.js";

async function fixture(run, policy, options = {}) {
  const dir = await mkdtemp(path.join(process.cwd(), ".team-policy-"));
  const capsule = {
    name: "team-policy",
    schema: {
      responsibility: table({ teamId: String(), holder: String(), state: String(), provider: String() }).acl({
        read: ({ row, ctx }) => row.holder === ctx.auth.userId,
        update: ({ previous, ctx }) => previous.holder === ctx.auth.userId,
      }),
      acceptances: table({ teamId: String(), userId: String() }),
    },
    teams: { authorizeDestructive: policy ?? (async (ctx, input) => {
      const rows = await ctx.db.responsibility.where("teamId", input.teamId).all();
      return { allow: rows.length === 1 && (rows[0].state === "inactive" || (input.scope === "member" && input.member.userId !== rows[0].holder)) };
    }) },
    queries: { responsibilities: query(ctx => ctx.db.responsibility.all()) },
    mutations: {
      accept: mutation(async (ctx, teamId) => {
        const snapshot = await ctx.teams.lockLifecycle(teamId, ctx.auth.userId);
        if (snapshot.member?.role !== "admin") throw new Error("Ineligible");
        await ctx.db.acceptances.insert({ teamId, userId: ctx.auth.userId });
        return { accepted: true };
      }),
      transfer: mutation(async (ctx, teamId, target, stepDown = false, fail = false) => {
        const snapshot = await ctx.teams.lockLifecycle(teamId, target);
        const rows = await ctx.db.responsibility.where("teamId", teamId).all();
        const accepted = await ctx.db.acceptances.where("teamId", teamId).where("userId", target).get();
        if (snapshot.member?.role !== "admin" || rows.length !== 1 || rows[0].holder !== ctx.auth.userId || !accepted) throw new Error("Transfer refused");
        await ctx.db.responsibility.update(rows[0].id, { holder: target });
        await ctx.db.acceptances.delete(accepted.id);
        if (stepDown) await ctx.teams.demote(teamId, ctx.auth.userId);
        if (fail) throw new Error("Rollback transfer");
        return { transferred: true };
      }),
      setState: mutation(async (ctx, teamId, state) => {
        await ctx.teams.lockLifecycle(teamId);
        const row = await ctx.db.responsibility.where("teamId", teamId).get();
        if (!row || row.holder !== ctx.auth.userId) throw new Error("Missing responsibility");
        await ctx.db.responsibility.update(row.id, { state });
        return { updated: true };
      }),
      catchDenied: mutation(async (ctx, operation, teamId, userId) => {
        await ctx.db.acceptances.insert({ teamId, userId: ctx.auth.userId });
        try { await ctx.teams[operation](teamId, userId); } catch {}
        return { caught: true };
      }),
      seed: mutation(async (ctx, teamId, holder, state = "active") => {
        return ctx.db.responsibility.insert({ teamId, holder, state, provider: "sub_SYNTHETIC_PRIVATE" });
      }),
      destroy: mutation((ctx, operation, teamId, userId) => ctx.teams[operation](teamId, userId)),
    },
  };
  options.configure?.(capsule);
  const database = await openDevDatabase(path.join(dir, "data.db"), "", options.serverEnv ?? {}, { name: "team-policy", auth: { providers: { anonymous: true, email: true } }, ...(options.config ?? {}) }, capsule, { serviceEnv: options.serverEnv ?? {}, ...(options.runtimeOptions ?? {}) });
  const hub = createWebSocketHub(() => database);
  const server = createServer();
  server.on("upgrade", (request, socket) => hub.accept(request, socket));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const sockets = [];
  let sequence = 0;
  async function client(name) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/?connectionToken=${hub.createConnectionToken()}`);
    sockets.push(ws);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
    const send = message => new Promise((resolve, reject) => {
      const id = `${name}-${sequence++}`;
      const timer = setTimeout(() => { ws.removeEventListener("message", listener); reject(new Error(`Timed out: ${message.type}`)); }, 10000);
      const listener = ({ data }) => { const result = JSON.parse(data); if (result.id === id) { clearTimeout(timer); ws.removeEventListener("message", listener); resolve(result); } };
      ws.addEventListener("message", listener);
      ws.send(JSON.stringify({ ...message, id }));
    });
    const signed = await send({ type: "auth.signUp", provider: "email", credentials: { email: `${name}@example.test`, password: "password-123", name } });
    assert.equal(signed.error, null);
    return { send, ws, auth: signed.data.auth, userId: signed.data.auth.userId, token: signed.data.sessionToken };
  }
  try { await run({ database, capsule, client, databasePath: path.join(dir, "data.db") }); }
  finally { hub.disconnectAll(); await new Promise(resolve => server.close(resolve)); await database.close(); await rm(dir, { recursive: true, force: true }); }
}

async function team(owner, name = "Guarded") {
  const created = await owner.send({ type: "teams.create", name });
  assert.equal(created.error, null);
  return created.data.team.id;
}
async function join(owner, member, teamId) {
  const auth = await member.send({ type: "auth.get" });
  const actual = await owner.send({ type: "teams.createJoinLink", teamId, email: auth.data.auth.email });
  assert.equal(actual.error, null);
  const code = new URL(actual.data.link).searchParams.get("code");
  const joined = await member.send({ type: "teams.join", code });
  assert.equal(joined.error, null, JSON.stringify(joined));
}
async function seed(owner, teamId, holder, state) {
  const result = await owner.send({ type: "mutation.run", name: "seed", args: [teamId, holder.userId, state] });
  assert.equal(result.error, null, JSON.stringify(result));
}

test("Capsule responsibility policy refuses destructive SDK and ctx.teams operations", async () => {
  await fixture(async ({ client }) => {
    const owner = await client("owner");
    const holder = await client("holder");
    for (const operation of ["demote", "removeMember", "leave", "delete"]) {
      const teamId = await team(owner);
      if (operation !== "delete") {
        await join(owner, holder, teamId);
        if (operation !== "leave") assert.equal((await owner.send({ type: "teams.promote", teamId, userId: holder.userId })).error, null);
      }
      await seed(owner, teamId, operation === "delete" ? owner : holder);
      const actor = operation === "leave" ? holder : owner;
      for (const via of ["sdk", "app"]) {
        const before = await owner.send({ type: "teams.listMembers", teamId });
        const response = await actor.send(via === "sdk"
          ? { type: `teams.${operation}`, teamId, userId: holder.userId }
          : { type: "mutation.run", name: "destroy", args: [operation, teamId, holder.userId] });
        assert.equal(response.error?.code, "TEAM_POLICY_DENIED", `${operation} via ${via}: ${JSON.stringify(response)}`);
        assert.deepEqual((await owner.send({ type: "teams.listMembers", teamId })).data, before.data);
        assert.doesNotMatch(JSON.stringify(response), /sub_SYNTHETIC_PRIVATE/);
      }
    }
  });
});

async function scenario(client, operation, suffix = "") {
  const owner = await client(`owner${suffix}`);
  const holder = operation === "delete" ? owner : await client(`holder${suffix}`);
  const teamId = await team(owner);
  if (holder !== owner) {
    await join(owner, holder, teamId);
    if (operation !== "leave") assert.equal((await owner.send({ type: "teams.promote", teamId, userId: holder.userId })).error, null);
  }
  return { owner, holder, actor: operation === "leave" ? holder : owner, teamId };
}

for (const mode of ["missing", "ambiguous", "throw", "undefined", "null", "truthy", "extra", "inherited", "getter", "unreadable"]) {
  test(`all destructive paths fail closed with ${mode} responsibility or decisions`, async () => {
    let captured;
    await fixture(async ({ client, database }) => {
      for (const operation of ["demote", "removeMember", "leave", "delete"]) {
        const { owner, holder, actor, teamId } = await scenario(client, operation, operation);
        if (mode !== "missing") await seed(owner, teamId, holder);
        if (mode === "ambiguous") await seed(owner, teamId, holder);
        for (const via of ["sdk", "app", "caught"]) {
          const response = await actor.send(via === "sdk" ? { type: `teams.${operation}`, teamId, userId: holder.userId }
            : { type: "mutation.run", name: via === "caught" ? "catchDenied" : "destroy", args: [operation, teamId, holder.userId] });
          assert.equal(response.error?.code, "TEAM_POLICY_DENIED", `${operation}/${via}: ${JSON.stringify(response)}`);
          assert.doesNotMatch(JSON.stringify(response), /sub_SYNTHETIC_PRIVATE|PRIVATE_FAILURE/);
          assert.equal((await owner.send({ type: "teams.listMembers", teamId })).data.totalCount, operation === "delete" ? 1 : 2);
        }
      }
      if (captured) assert.throws(() => captured.all(), error => error.code === "TRUSTED_READ_ACCESS_INACTIVE");
      assert.equal(database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [acceptances]").get().count, 0, "caught refusal rolls back app writes");
      assert.doesNotMatch(JSON.stringify(await database.log.tail(1000)), /sub_SYNTHETIC_PRIVATE|PRIVATE_FAILURE/);
    }, async (ctx, input) => {
      captured = ctx.db.responsibility;
      if (mode === "unreadable") {
        try { await ctx.db.responsibility.where("missingField", "anything").all(); } catch {}
        return { allow: true };
      }
      const rows = await ctx.db.responsibility.where("teamId", input.teamId).all();
      if (mode === "missing" || mode === "ambiguous") return { allow: rows.length === 1 };
      if (mode === "throw") throw new Error("PRIVATE_FAILURE sub_SYNTHETIC_PRIVATE");
      if (mode === "undefined") return undefined;
      if (mode === "null") return null;
      if (mode === "truthy") return { allow: 1 };
      if (mode === "extra") return { allow: true, provider: "sub_SYNTHETIC_PRIVATE" };
      if (mode === "inherited") return Object.create({ allow: true });
      if (mode === "getter") return { get allow() { throw new Error("PRIVATE_FAILURE"); } };
    });
  });
}

test("accepted transfer and step-down share one transaction; promotion alone never transfers responsibility", async () => {
  await fixture(async ({ client }) => {
    const { owner, holder, teamId } = await scenario(client, "demote");
    await seed(owner, teamId, owner);
    const mutate = (actor, name, args) => actor.send({ type: "mutation.run", name, args });
    assert.equal((await owner.send({ type: "teams.demote", teamId, userId: owner.userId })).error?.code, "TEAM_POLICY_DENIED");
    assert.ok((await mutate(owner, "transfer", [teamId, holder.userId])).error, "recipient must explicitly accept");
    assert.equal((await mutate(holder, "accept", [teamId])).error, null);
    assert.ok((await mutate(owner, "transfer", [teamId, holder.userId, true, true])).error);
    assert.equal((await owner.send({ type: "teams.demote", teamId, userId: owner.userId })).error?.code, "TEAM_POLICY_DENIED", "failed transfer restores holder and admin");
    const transfer = await mutate(owner, "transfer", [teamId, holder.userId, true]);
    assert.equal(transfer.error, null, JSON.stringify(transfer));
    assert.equal((await holder.send({ type: "teams.demote", teamId, userId: holder.userId })).error?.code, "DENIED", "final admin remains protected");
    assert.equal((await owner.send({ type: "teams.leave", teamId })).error, null, "former holder may now leave");
    assert.equal((await holder.send({ type: "teams.delete", teamId })).error?.code, "TEAM_POLICY_DENIED");
    assert.equal((await mutate(holder, "setState", [teamId, "inactive"])).error, null);
    assert.equal((await holder.send({ type: "teams.delete", teamId })).error, null);
  });
});

test("inactive responsibility permits all paths and policies receive immutable exact scope with cross-owner reads", async () => {
  const inputs = [];
  let capturedDb;
  await fixture(async ({ client }) => {
    for (const via of ["sdk", "app"]) {
      for (const operation of ["demote", "removeMember", "leave", "delete"]) {
        const { owner, holder, actor, teamId } = await scenario(client, operation, `${via}${operation}`);
        await seed(owner, teamId, holder, "inactive");
        const response = await actor.send(via === "sdk" ? { type: `teams.${operation}`, teamId, userId: holder.userId }
          : { type: "mutation.run", name: "destroy", args: [operation, teamId, holder.userId] });
        assert.equal(response.error, null, JSON.stringify(response));
        assert.deepEqual(inputs.at(-1), {
          teamId, actorUserId: actor.userId, operation,
          member: { userId: holder.userId, role: operation === "leave" ? "member" : "admin" },
          scope: operation === "delete" ? "team" : "member",
        });
        assert.throws(() => capturedDb.responsibility.all(), error => error.code === "TRUSTED_READ_ACCESS_INACTIVE");
      }
    }
  }, async (ctx, input) => {
    assert.deepEqual(Object.keys(ctx).sort(), ["auth", "db", "signal"]);
    assert.equal(ctx.db.responsibility.update, undefined);
    assert.equal(ctx.db.sporades_teams, undefined);
    assert.equal(Object.isFrozen(ctx.auth), true);
    assert.equal(Object.isFrozen(input), true);
    assert.equal(Object.isFrozen(input.member), true);
    capturedDb = ctx.db;
    inputs.push(input);
    const rows = await ctx.db.responsibility.where("teamId", input.teamId).all();
    assert.equal(rows[0].provider, "sub_SYNTHETIC_PRIVATE");
    return { allow: rows.length === 1 && rows[0].state === "inactive" };
  });
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const operation of ["demote", "removeMember", "leave", "delete"]) {
  test(`${operation}: policy budget expiry rolls back and revokes non-cooperative late reads`, async () => {
    const entered = deferred();
    const release = deferred();
    let captured;
    let expire;
    const clock = {
      now: () => new Date(),
      setTimer(fn, ms) { if (ms === 5000) { expire = fn; return "policy"; } return setTimeout(fn, ms); },
      clearTimer(id) { if (id !== "policy") clearTimeout(id); },
    };
    await fixture(async ({ client }) => {
      const { owner, holder, actor, teamId } = await scenario(client, operation);
      await seed(owner, teamId, holder, "inactive");
      const response = actor.send({ type: `teams.${operation}`, teamId, userId: holder.userId });
      await entered.promise;
      expire();
      assert.equal((await response).error?.code, "TEAM_POLICY_DENIED");
      assert.throws(() => captured.all(), error => error.code === "TRUSTED_READ_ACCESS_INACTIVE");
      release.resolve();
      assert.equal((await owner.send({ type: "teams.listMembers", teamId })).data.totalCount, operation === "delete" ? 1 : 2);
    }, async ctx => {
      captured = ctx.db.responsibility;
      entered.resolve();
      await release.promise;
      await captured.all();
      return { allow: true };
    }, { runtimeOptions: { clock } });
  });
}

test("current Sessions, exact-Team admin authority and expired lifecycle contexts cannot be reused", async () => {
  const { runMutation } = await import("../dist/server-runtime-source.js");
  let leakedTeams;
  await fixture(async ({ client, database }) => {
    const { owner, holder, teamId } = await scenario(client, "demote");
    await seed(owner, teamId, holder, "inactive");
    const otherTeam = await team(holder, "Other Team");
    const locked = await runMutation(database, owner.auth, "capture", [teamId], { sessionToken: owner.token });
    assert.equal(locked.error, null);
    await assert.rejects(() => leakedTeams.lockLifecycle(teamId), error => error.code === "TEAM_POLICY_DENIED");
    assert.equal((await runMutation(database, owner.auth, "capture", [otherTeam], { sessionToken: owner.token })).error?.code, "TEAM_POLICY_DENIED");
    await database.adapter.deleteAuthSession(owner.token);
    for (const operation of ["demote", "removeMember", "delete"]) {
      const result = await runMutation(database, owner.auth, "destroy", [operation, operation === "delete" ? otherTeam : teamId, holder.userId], { sessionToken: owner.token });
      assert.ok(result.error, operation);
    }
    assert.equal((await holder.send({ type: "teams.listMembers", teamId })).data.totalCount, 2);
  }, undefined, { configure(capsule) {
    capsule.mutations.capture = mutation(async (ctx, teamId) => { leakedTeams = ctx.teams; await ctx.teams.lockLifecycle(teamId); return { locked: true }; });
  } });
});

for (const operation of ["demote", "removeMember", "leave", "delete"]) {
  test(`${operation}: a queued destructive change re-reads a committed billing-state change`, async () => {
    const entered = deferred();
    const release = deferred();
    await fixture(async ({ client }) => {
      const { owner, holder, actor, teamId } = await scenario(client, operation);
      await seed(owner, teamId, holder, "inactive");
      const change = owner.send({ type: "mutation.run", name: "holdState", args: [teamId] });
      await entered.promise;
      const destruction = actor.send({ type: `teams.${operation}`, teamId, userId: holder.userId });
      release.resolve();
      assert.equal((await change).error, null);
      assert.equal((await destruction).error?.code, "TEAM_POLICY_DENIED");
      assert.equal((await owner.send({ type: "teams.listMembers", teamId })).data.totalCount, operation === "delete" ? 1 : 2);
    }, undefined, { configure(capsule) {
      capsule.mutations.holdState = mutation((ctx, teamId) => ctx.privileged.run(
        { operation: "responsibility.update", targetResourceKind: "capsule-db" },
        async privileged => {
          await privileged.teams.lockLifecycle(teamId);
          assert.equal(privileged.teams.demote, undefined);
          const row = await privileged.db.responsibility.where("teamId", teamId).get();
          await privileged.db.responsibility.update(row.id, { state: "active" });
          entered.resolve();
          await release.promise;
          return { updated: true };
        },
      ));
    } });
  });
}

test("holder transfer serializes with recipient demotion/removal and rechecks current eligibility", async () => {
  const entered = deferred();
  const release = deferred();
  await fixture(async ({ client }) => {
    const { owner, holder, teamId } = await scenario(client, "demote");
    await seed(owner, teamId, owner);
    assert.equal((await holder.send({ type: "mutation.run", name: "accept", args: [teamId] })).error, null);
    const transfer = owner.send({ type: "mutation.run", name: "heldTransfer", args: [teamId, holder.userId] });
    await entered.promise;
    const demote = owner.send({ type: "teams.demote", teamId, userId: holder.userId });
    const remove = owner.send({ type: "teams.removeMember", teamId, userId: holder.userId });
    release.resolve();
    assert.equal((await transfer).error, null);
    assert.equal((await demote).error?.code, "TEAM_POLICY_DENIED");
    assert.equal((await remove).error?.code, "TEAM_POLICY_DENIED");
    assert.equal((await holder.send({ type: "teams.demote", teamId, userId: owner.userId })).error, null);
    assert.equal((await owner.send({ type: "teams.leave", teamId })).error, null);
  }, undefined, { configure(capsule) {
    const transfer = capsule.mutations.transfer.handler;
    // Keep the same public acceptance/eligibility mutation and pause after its writes while the lock remains held.
    capsule.mutations.heldTransfer = mutation(async (ctx, ...args) => {
      const result = await transfer(ctx, ...args);
      entered.resolve();
      await release.promise;
      return result;
    });
  } });
});

test("an accepted administrator demoted before transfer cannot become the holder", async () => {
  await fixture(async ({ client }) => {
    const { owner, holder, teamId } = await scenario(client, "demote");
    await seed(owner, teamId, owner);
    assert.equal((await holder.send({ type: "mutation.run", name: "accept", args: [teamId] })).error, null);
    assert.equal((await owner.send({ type: "teams.demote", teamId, userId: holder.userId })).error, null);
    assert.ok((await owner.send({ type: "mutation.run", name: "transfer", args: [teamId, holder.userId] })).error);
    assert.equal((await owner.send({ type: "teams.removeMember", teamId, userId: holder.userId })).error, null);
    assert.equal((await owner.send({ type: "teams.delete", teamId })).error?.code, "TEAM_POLICY_DENIED");
  });
});

test("opt-in preserves last-admin races and refuses invalid policy declarations at load", async () => {
  await fixture(async ({ client }) => {
    const { owner, holder, teamId } = await scenario(client, "demote");
    await seed(owner, teamId, holder, "inactive");
    const outcomes = await Promise.all([
      owner.send({ type: "teams.demote", teamId, userId: holder.userId }),
      holder.send({ type: "teams.demote", teamId, userId: owner.userId }),
    ]);
    assert.equal(outcomes.filter(result => !result.error).length, 1);
    const admin = !outcomes[0].error ? owner : holder;
    assert.equal((await admin.send({ type: "teams.listMembers", teamId })).data.members.filter(member => member.role === "admin").length, 1);
  });
  for (const authorizeDestructive of [null, true, {}, "allow"]) {
    const dir = await mkdtemp(path.join(process.cwd(), ".team-policy-invalid-"));
    try {
      await assert.rejects(() => openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "invalid-policy" }, {
        name: "invalid-policy", schema: {}, teams: { authorizeDestructive },
      }), error => error.code === "INVALID_TEAM_DESTRUCTIVE_POLICY");
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

for (const operation of ["demote", "removeMember", "leave", "delete"]) {
  test(`${operation}: aborting a server context rolls back before a late allow`, async () => {
    const { runMutation } = await import("../dist/server-runtime-source.js");
    const entered = deferred(); const release = deferred();
    let captured;
    await fixture(async ({ client, database }) => {
      const { owner, holder, actor, teamId } = await scenario(client, operation);
      await seed(owner, teamId, holder, "inactive");
      const controller = new AbortController();
      const response = runMutation(database, actor.auth, "destroy", [operation, teamId, holder.userId], { sessionToken: actor.token, signal: controller.signal });
      await entered.promise;
      controller.abort();
      assert.equal((await response).error?.code, "TEAM_POLICY_DENIED");
      assert.throws(() => captured.all(), error => error.code === "TRUSTED_READ_ACCESS_INACTIVE");
      release.resolve();
      assert.equal((await owner.send({ type: "teams.listMembers", teamId })).data.totalCount, operation === "delete" ? 1 : 2);
    }, async ctx => { captured = ctx.db.responsibility; entered.resolve(); await release.promise; return { allow: true }; });
  });
}

test("atomic provider consequences share the Team lock and do not acquire membership mutation authority", async () => {
  const { runAtomicStripeConsequence } = await import("../dist/server-runtime-source.js");
  const { stripeEvent } = await import("../dist/server.js");
  const entered = deferred(); const release = deferred();
  let captured;
  await fixture(async ({ client, database }) => {
    const { owner, holder, teamId } = await scenario(client, "demote");
    await seed(owner, teamId, holder, "inactive");
    const event = { provider: "stripe", providerEventId: "evt_SYNTHETIC", type: "customer.subscription.updated", raw: {} };
    const consequence = runAtomicStripeConsequence(database, { signal: new AbortController().signal }, event,
      stripeEvent({ consequence: "atomic" }, async ctx => {
        captured = ctx.teams;
        const snapshot = await ctx.teams.lockLifecycle(teamId, holder.userId);
        assert.equal(snapshot.member.role, "admin");
        assert.equal(ctx.teams.demote, undefined);
        const row = await ctx.db.responsibility.where("teamId", teamId).get();
        await ctx.db.responsibility.update(row.id, { state: "active" });
        entered.resolve(); await release.promise;
      }));
    await entered.promise;
    const demote = owner.send({ type: "teams.demote", teamId, userId: holder.userId });
    release.resolve();
    await consequence;
    assert.equal((await demote).error?.code, "TEAM_POLICY_DENIED");
    await assert.rejects(() => captured.lockLifecycle(teamId), error => error.code === "PRIVILEGED_TEAM_ACCESS_INACTIVE");
  });
});

for (const engine of ["libsql", "postgres"]) {
  test(`${engine}: public policy denial and accepted transfer use the same adapter transaction`, { skip: engine === "postgres" && !process.env.SPORADES_POSTGRES_TEST_URL ? "Set SPORADES_POSTGRES_TEST_URL for real PostgreSQL conformance" : false }, async () => {
    const prove = async (options) => fixture(async ({ client }) => {
      for (const operation of ["demote", "removeMember", "leave", "delete"]) {
        const { owner, holder, actor, teamId } = await scenario(client, operation, operation);
        await seed(owner, teamId, holder);
        for (const via of ["sdk", "app"]) {
          const result = await actor.send(via === "sdk" ? { type: `teams.${operation}`, teamId, userId: holder.userId }
            : { type: "mutation.run", name: "destroy", args: [operation, teamId, holder.userId] });
          assert.equal(result.error?.code, "TEAM_POLICY_DENIED", JSON.stringify(result));
        }
        assert.equal((await owner.send({ type: "teams.listMembers", teamId })).data.totalCount, operation === "delete" ? 1 : 2);
      }
      const { owner, holder, teamId } = await scenario(client, "demote", "transfer");
      await seed(owner, teamId, owner);
      assert.equal((await holder.send({ type: "mutation.run", name: "accept", args: [teamId] })).error, null);
      const transfer = await owner.send({ type: "mutation.run", name: "transfer", args: [teamId, holder.userId, true] });
      assert.equal(transfer.error, null, JSON.stringify(transfer));
      assert.equal((await owner.send({ type: "teams.leave", teamId })).error, null);
    }, undefined, options);
    const run = url => {
      const serverEnv = { SPORADES_SERVICE_DATABASE_ENGINE: engine, SPORADES_SERVICE_DATABASE_URL: url };
      return prove({ serverEnv, config: { services: { database: { kind: "database", engine } } } });
    };
    if (engine === "libsql") {
      const { withFakeLibsqlService } = await import("./support/libsql-http-service.js");
      const dir = await mkdtemp(path.join(process.cwd(), ".team-policy-libsql-"));
      try { await withFakeLibsqlService(path.join(dir, "data.db"), async ({ url }) => run(url)); }
      finally { await rm(dir, { recursive: true, force: true }); }
    } else {
      const { withPostgresAdapter } = await import("./support/database-adapter-engines.js");
      await withPostgresAdapter(async () => {}, { appTableNames: ["responsibility", "acceptances"] });
      await run(process.env.SPORADES_POSTGRES_TEST_URL);
    }
  });
}

for (const operation of ["demote", "removeMember", "leave", "delete"]) {
  test(`${operation}: a revoked Session cannot authorize an otherwise eligible server transition`, async () => {
    const { runMutation } = await import("../dist/server-runtime-source.js");
    let invoked = 0;
    await fixture(async ({ client, database }) => {
      const { owner, holder, actor, teamId } = await scenario(client, operation);
      await seed(owner, teamId, holder, "inactive");
      await database.adapter.deleteAuthSession(actor.token);
      const result = await runMutation(database, actor.auth, "destroy", [operation, teamId, holder.userId], { sessionToken: actor.token });
      assert.equal(result.error?.code, "TEAM_POLICY_DENIED");
      assert.equal(invoked, 0, "current Session checks precede the Capsule policy");
      const signed = await actor.send({ type: "auth.signIn", provider: "email", credentials: {
        email: operation === "leave" ? "holder@example.test" : "owner@example.test", password: "password-123",
      } });
      assert.equal(signed.error, null);
      assert.equal((await owner.send({ type: "teams.listMembers", teamId })).data.totalCount, operation === "delete" ? 1 : 2);
    }, () => { invoked++; return { allow: true }; });
  });
}

for (const operation of ["leave", "delete"]) {
  test(`accepted transfer commits before a queued former-holder ${operation}`, async () => {
    const entered = deferred(); const release = deferred();
    await fixture(async ({ client }) => {
      const { owner, holder, teamId } = await scenario(client, "demote");
      await seed(owner, teamId, owner);
      assert.equal((await holder.send({ type: "mutation.run", name: "accept", args: [teamId] })).error, null);
      const transfer = owner.send({ type: "mutation.run", name: "heldTransfer", args: [teamId, holder.userId, true] });
      await entered.promise;
      const change = owner.send({ type: `teams.${operation}`, teamId });
      release.resolve();
      assert.equal((await transfer).error, null);
      const result = await change;
      if (operation === "leave") assert.equal(result.error, null);
      else assert.equal(result.error?.code, "DENIED");
      const members = (await holder.send({ type: "teams.listMembers", teamId })).data;
      assert.equal(members.members.find(member => member.userId === holder.userId).role, "admin");
      if (operation === "leave") assert.equal((await holder.send({ type: "teams.delete", teamId })).error?.code, "TEAM_POLICY_DENIED");
    }, undefined, { configure(capsule) {
      const transfer = capsule.mutations.transfer.handler;
      capsule.mutations.heldTransfer = mutation(async (ctx, ...args) => {
        const result = await transfer(ctx, ...args); entered.resolve(); await release.promise; return result;
      });
    } });
  });
}
