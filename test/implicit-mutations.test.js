// Capsule-level `implicitMutations` opt-out (issue #292): `false` bounds the mutation surface to
// explicitly declared mutation names. Omission or `true` must keep the 0.9.x behavior exactly.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { capsule, mutation, query, String, table } from "../dist/server.js";
import { createWebSocketHub, openDevDatabase, runMutation, runQuery } from "../dist/server-runtime-source.js";


function auth(userId) {
  return {
    userId,
    displayName: userId,
    email: null,
    picture: null,
    isAuthenticated: false,
    isGuest: true,
    provider: "anonymous",
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-implicit-mutations-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function openCapsuleDatabase(dir, capsuleDefinition) {
  return openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "implicit-mutations" }, capsuleDefinition);
}

// The bounded denial every refused mutation name answers. It is the ordinary unknown-mutation
// result, not a new shape, and not a success with a null payload.
function unknownMutation(mutationName) {
  return {
    ok: false,
    error: {
      message: `Unknown mutation: ${mutationName}`,
      hint: "Use a mutation defined by the capsule.",
    },
  };
}

// A fresh definition per database so tests never share table state.
const notesSchema = () => ({ notes: table({ text: String(), ownerId: String() }) });


test("an omitted implicitMutations flag keeps the 0.9.x implicit add and update surface", async () => {
  await withTempDir(async (dir) => {
    for (const [index, flag] of [[0, undefined], [1, true]]) {
      const database = await openDevDatabase(path.join(dir, `data-${index}.db`), "", {}, { name: "legacy-surface" }, capsule({
        name: "legacy-surface",
        implicitMutations: flag,
        schema: notesSchema(),
        mutations: {},
      }));
      try {
        assert.equal(database.implicitMutations, true);
        const added = await runMutation(database, auth("u1"), "addNote", ["implicit"]);
        assert.deepEqual(added, { ok: true, error: null });
        const rows = (await runQuery(database, auth("u1"), "notes")).rows;
        assert.equal(rows.length, 1);
        // On an owner-scoped table the implicit update path mutates only the caller's own rows —
        // pre-existing 0.9.x semantics this flag must not change.
        const updated = await runMutation(database, auth("u1"), "updateNoteText", [rows[0].id, "edited"]);
        assert.deepEqual(updated, { ok: true, error: null });
        assert.deepEqual((await runQuery(database, auth("u1"), "notes")).rows.map((row) => row.text), ["edited"]);
      } finally {
        database.close();
      }
    }
  });
});

test("an opted-out Capsule refuses every undeclared mutation name in the runMutation dispatch", async () => {
  await withTempDir(async (dir) => {
    const database = await openCapsuleDatabase(dir, capsule({
      name: "opted-out-strict",
      implicitMutations: false,
      schema: notesSchema(),
      mutations: { publish: mutation((ctx, text) => ctx.db.notes.insert({ text, ownerId: ctx.auth.userId })) },
    }));
    try {
      assert.equal(database.implicitMutations, false);
      // Both fallback-shaped names and arbitrary names refuse identically. `addNote` and
      // `updateNoteText` describe the `notes` table, so only the flag stands between them and a
      // fallback write.
      for (const name of ["addNote", "updateNoteText", "frobnicate"]) {
        const args = name === "updateNoteText" ? ["some-id", "edited"] : ["write"];
        const result = await runMutation(database, auth("u1"), name, args);
        assert.deepEqual(result, unknownMutation(name), name);
      }
      assert.deepEqual((await runQuery(database, auth("u1"), "notes")).rows, [], "a refused name must not write");
    } finally {
      database.close();
    }
  });
});

test("a refusal in an opted-out Capsule runs before middleware, mutation hooks, and any write", async () => {
  await withTempDir(async (dir) => {
    const database = await openCapsuleDatabase(dir, capsule({
      name: "opted-out-effects",
      implicitMutations: false,
      schema: notesSchema(),
      mutations: { publish: mutation((ctx, text) => ctx.db.notes.insert({ text, ownerId: ctx.auth.userId })) },
    }));
    const middlewareCalls = [];
    const beforeCalls = [];
    const afterCalls = [];
    try {
      // Middleware and hooks run inside the transaction; a refusal that precedes either cannot
      // have queued a write, drained an ACL, or notified anything downstream.
      database.contextMiddleware = [
        'async (ctx) => { globalThis.__implicitMiddlewareCalls.push(ctx.kind); return ctx; }',
      ];
      database.mutationHooks.beforeMutation = ["({ name }) => { globalThis.__implicitBeforeCalls.push(name); }"];
      database.mutationHooks.afterMutation = ["({ name }) => { globalThis.__implicitAfterCalls.push(name); }"];

      globalThis.__implicitMiddlewareCalls = middlewareCalls;
      globalThis.__implicitBeforeCalls = beforeCalls;
      globalThis.__implicitAfterCalls = afterCalls;
      try {
        const refused = await runMutation(database, auth("u1"), "addNote", ["refused"]);
        assert.deepEqual(refused, unknownMutation("addNote"));
        assert.deepEqual(middlewareCalls, [], "the refusal must resolve before context middleware");
        assert.deepEqual(beforeCalls, [], "the refusal must resolve before the before-mutation hook");
        assert.deepEqual(afterCalls, [], "the refusal must resolve before the after-mutation hook");
        assert.deepEqual((await runQuery(database, auth("u1"), "notes")).rows, []);

        middlewareCalls.length = 0;
        const declared = await runMutation(database, auth("u1"), "publish", ["declared"]);
        assert.equal(declared.ok, true);
        assert.deepEqual(middlewareCalls, ["mutation"], "declared mutations keep their context middleware");
        assert.deepEqual(beforeCalls, ["publish"], "declared mutations keep their before-mutation hook");
        assert.deepEqual(afterCalls, ["publish"], "declared mutations keep their after-mutation hook");
      } finally {
        delete globalThis.__implicitMiddlewareCalls;
        delete globalThis.__implicitBeforeCalls;
        delete globalThis.__implicitAfterCalls;
      }
    } finally {
      database.close();
    }
  });
});

test("declared mutations in an opted-out Capsule keep their result shape, ACLs and transaction behavior", async () => {
  await withTempDir(async (dir) => {
    const database = await openCapsuleDatabase(dir, capsule({
      name: "opted-out-declared",
      implicitMutations: false,
      schema: {
        notes: table({ text: String(), ownerId: String() }),
        guarded: table({ text: String() }).acl({ insert: () => false }),
      },
      mutations: {
        publish: mutation((ctx, text) => ctx.db.notes.insert({ text, ownerId: ctx.auth.userId })),
        addNote: mutation((ctx, text) => {
          if (text !== "approved") throw new Error("App quota denied.");
          return ctx.db.notes.insert({ text, ownerId: ctx.auth.userId });
        }),
        updateNoteText: mutation((ctx, id, text) => ctx.db.notes.update(id, { text })),
        silent: mutation((ctx) => { ctx.db.notes.insert({ text: "silent-write", ownerId: ctx.auth.userId }); }),
        writeGuard: mutation((ctx, text) => ctx.db.guarded.insert({ text })),
        rollbackProbe: mutation((ctx) => {
          ctx.db.notes.insert({ text: "must-rollback", ownerId: ctx.auth.userId });
          throw new Error("Rollback probe");
        }),
      },
    }));
    try {
      // A declared name identical to a fallback name runs the declared handler with its checks.
      const blocked = await runMutation(database, auth("u1"), "addNote", ["rejected"]);
      assert.deepEqual(blocked, { ok: false, error: { message: "App quota denied.", hint: "Check the Capsule mutation hooks and retry the mutation." } });
      const approved = await runMutation(database, auth("u1"), "addNote", ["approved"]);
      assert.equal(approved.ok, true);
      assert.deepEqual(approved.data.text, "approved");
      assert.deepEqual(approved.data.ownerId, "u1");

      // Falsey declared results stay success with a null payload; the implicit fallback must not
      // attach a second write to them.
      const silent = await runMutation(database, auth("u1"), "silent", []);
      assert.deepEqual(silent, { ok: true, data: null, error: null });

      // Declared updates keep the ordinary declared result shape.
      const rows = (await runQuery(database, auth("u1"), "notes")).rows;
      const changed = await runMutation(database, auth("u1"), "updateNoteText", [rows[0].id, "edited"]);
      assert.equal(changed.ok, true);
      assert.deepEqual(changed.data.text, "edited");

      // Table ACLs keep their authority; the flag neither widens nor weakens them.
      const denied = await runMutation(database, auth("u1"), "writeGuard", ["nope"]);
      assert.equal(denied.ok, false);
      assert.match(denied.error.message, /Denied/);

      // A declared mutation that writes and then fails rolls its write back.
      const before = (await runQuery(database, auth("u1"), "notes")).rows.map((row) => row.text);
      const rolled = await runMutation(database, auth("u1"), "rollbackProbe", []);
      assert.equal(rolled.ok, false);
      assert.deepEqual((await runQuery(database, auth("u1"), "notes")).rows.map((row) => row.text), before);
    } finally {
      database.close();
    }
  });
});

test("implicit table queries and declared queries still answer in an opted-out Capsule", async () => {
  await withTempDir(async (dir) => {
    const database = await openCapsuleDatabase(dir, capsule({
      name: "opted-out-queries",
      implicitMutations: false,
      schema: notesSchema(),
      queries: { mine: query((ctx) => ctx.db.notes.where("ownerId", ctx.auth.userId).all()) },
      mutations: { publish: mutation((ctx, text) => ctx.db.notes.insert({ text, ownerId: ctx.auth.userId })) },
    }));
    try {
      const declared = await runMutation(database, auth("u1"), "publish", ["queried"]);
      assert.equal(declared.ok, true);
      // The implicit table query keeps its own surface; only implicit *mutations* retire.
      const implicit = await runQuery(database, auth("u1"), "notes");
      assert.equal(implicit.error, null);
      assert.deepEqual(implicit.rows.map((row) => row.text), ["queried"]);
      const mine = await runQuery(database, auth("u1"), "mine");
      assert.equal(mine.error, null);
      assert.deepEqual(mine.data.map((row) => row.text), ["queried"]);
    } finally {
      database.close();
    }
  });
});

test("non-boolean implicitMutations values fail closed at authoring and at runtime admission", async () => {
  await withTempDir(async (dir) => {
    for (const invalid of [null, 0, 1, "false", {}]) {
      // Authoring-side `capsule()` validation (the path bundled sources take).
      assert.throws(() => capsule({ name: "invalid", implicitMutations: invalid }), (error) => {
        assert.equal(error.code, "INVALID_IMPLICIT_MUTATIONS");
        assert.equal(error.message, "Invalid Capsule implicitMutations declaration.");
        return true;
      }, JSON.stringify(invalid));
      assert.doesNotThrow(() => capsule({ name: "omitted", implicitMutations: undefined }),
        "an explicitly present `undefined` is the same as omitting the flag");
      // Runtime-side validation: opening a dev database rejects the same definitions, including
      // ones never passed through `capsule()`.
      await assert.rejects(() => openCapsuleDatabase(dir, { name: "invalid", implicitMutations: invalid, schema: notesSchema() }),
        (error) => error.code === "INVALID_IMPLICIT_MUTATIONS", JSON.stringify(invalid));
    }
  });
});


// The legacy generated scaffold emitted `addNote`/`update…` handlers whose bodies exactly match
// the implicit path's write, and bundled sources with those bodies were routed through the implicit
// path while that surface is enabled. A Capsule's explicit `(implicitMutations: false)` retires the
// surface, so those declarations run as the declarations they are; only the exact legacy body shape
// is affected, and only while the surface is enabled.
test("an opted-out Capsule keeps its scaffold-shaped declared mutations instead of routing them to the retired implicit path", async () => {
  await withTempDir(async (dir) => {
    for (const [index, flag] of [[0, undefined], [1, false]]) {
      const serverSource = `import { capsule, mutation, String, table } from "sporades/server";

export default capsule({
  name: "legacy-scaffold",
${flag === false ? "  implicitMutations: false,\n" : ""}  schema: { notes: table({ text: String(), ownerId: String() }) },
  mutations: { addNote: mutation((ctx, text) => { ctx.db.notes.insert({ text, ownerId: ctx.auth.userId }); }) },
});
`;
      const definition = capsule({
        name: "legacy-scaffold",
        implicitMutations: flag,
        schema: { notes: table({ text: String(), ownerId: String() }) },
        mutations: { addNote: mutation((ctx, text) => { ctx.db.notes.insert({ text, ownerId: ctx.auth.userId }); }) },
      });
      const database = await openDevDatabase(path.join(dir, `data-${index}.db`), serverSource, {}, { name: "legacy-scaffold" }, definition);
      try {
        assert.deepEqual(database.mutations.map((candidate) => candidate.name),
          flag === false ? ["addNote"] : [],
          `the legacy scaffold body must ride the implicit path only while that surface is enabled (flag: ${flag})`);
        const result = await runMutation(database, auth("u1"), "addNote", ["scaffold text"]);
        assert.deepEqual(result,
          flag === false ? { ok: true, data: null, error: null } : { ok: true, error: null },
          `addNote answers through the path its flag selects (flag: ${flag})`);
      } finally {
        database.close();
      }
    }
  });
});


// ---------------------------------------------------------------------------------------------
// The same properties through the WebSocket transport, where the real client-facing dispatch
// lives: refusals answer a bounded result and must not trigger the deferred query rebroadcast
// that only a mutation which actually wrote may produce.
// ---------------------------------------------------------------------------------------------

test("refusal behavior holds on the WebSocket surface of an opted-out Capsule", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".implicit-mutations-ws-"));
  const socketCapsule = capsule({
    name: "opted-out-ws",
    implicitMutations: false,
    schema: notesSchema(),
    queries: { mine: query((ctx) => ctx.db.notes.where("ownerId", ctx.auth.userId).all()) },
    mutations: { publish: mutation((ctx, text) => ctx.db.notes.insert({ text, ownerId: ctx.auth.userId })) },
  });
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "opted-out-ws", auth: { providers: { anonymous: true, email: true } } }, socketCapsule);
  const hub = createWebSocketHub(() => database);
  const server = createServer();
  server.on("upgrade", (request, socket) => hub.accept(request, socket));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/?connectionToken=${hub.createConnectionToken()}`);
  const received = [];
  const waiters = [];
  function waitFrame(predicate, description) {
    const existing = received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, description };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`Timed out waiting for ${description}. Seen: ${received.map((entry) => entry.type).join(", ")}`));
      }, 10000);
      timer.unref();
      waiters.push(waiter);
    });
  }
  ws.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(data);
    received.push(frame);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      if (waiters[index].predicate(frame)) {
        const [waiter] = waiters.splice(index, 1);
        waiter.resolve(frame);
      }
    }
  });
  try {
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
    ws.send(JSON.stringify({ id: "signup", type: "auth.signUp", provider: "email", credentials: { email: "implicit@example.test", password: "password-123", name: "Reporter" } }));
    const signed = await waitFrame((frame) => frame.id === "signup", "auth.signUp reply");
    assert.equal(signed.error, null);

    ws.send(JSON.stringify({ id: "sub", type: "query.subscribe", query: "mine" }));
    const initial = await waitFrame((frame) => frame.id === "sub" && frame.type === "query.result", "query.subscribe initial result");
    assert.equal(initial.error, null);
    assert.deepEqual(initial.data, []);

    // A refused name: bounded result, and — the observable "success effect" — no rebroadcast.
    ws.send(JSON.stringify({ id: "refused-add", type: "mutation.run", mutation: "addNote", args: ["refused-write"] }));
    const refusedFrame = await waitFrame((frame) => frame.id === "refused-add", "refused mutation.run reply");
    assert.deepEqual(refusedFrame, {
      id: "refused-add",
      type: "mutation.result",
      data: null,
      error: { message: "Unknown mutation: addNote", hint: "Use a mutation defined by the capsule." },
      mutation: "addNote",
    });
    const framesBeforeQuiet = received.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(received.length, framesBeforeQuiet, "a refused mutation must not rebroadcast open subscriptions");
    assert.equal((await runQuery(database, auth("probe"), "notes")).rows.length, 0);

    // The legacy `name` key answers the same refusal in the legacy envelope shape.
    ws.send(JSON.stringify({ id: "legacy-refused", type: "mutation.run", name: "frobnicate" }));
    const legacy = await waitFrame((frame) => frame.id === "legacy-refused", "legacy refused mutation.run reply");
    assert.equal(legacy.ok, false);
    assert.deepEqual(legacy.error, { message: "Unknown mutation: frobnicate", hint: "Use a mutation defined by the capsule." });

    // A subscribed implicit table query answers on the same socket.
    ws.send(JSON.stringify({ id: "sub-notes", type: "query.subscribe", query: "notes" }));
    const notesInitial = await waitFrame((frame) => frame.id === "sub-notes" && frame.type === "query.result", "implicit table query initial result");
    assert.equal(notesInitial.error, null);

    // A declared success still rebroadcasts: the opt-out must not touch the real write path.
    ws.send(JSON.stringify({ id: "declared", type: "mutation.run", mutation: "publish", args: ["published"] }));
    const declaredFrame = await waitFrame((frame) => frame.id === "declared", "declared mutation.run reply");
    assert.equal(declaredFrame.error, null);
    assert.equal(declaredFrame.data.text, "published", JSON.stringify(declaredFrame));
    const rebroadcast = await waitFrame((frame) => frame.id === "sub" && frame.type === "query.result"
      && Array.isArray(frame.data) && frame.data.length > 0, "query rebroadcast after declared write");
    assert.deepEqual(rebroadcast.data.map((row) => row.text), ["published"]);
  } finally {
    hub.disconnectAll();
    server.close();
    ws.close();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});