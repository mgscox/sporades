import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDevDatabase, resolveAnonymousSession, runMutation, runQuery, signUpWithEmail } from "../dist/server-runtime-source.js";
import { listCurrentUserTeams } from "../dist/teams-runtime.js";
import { mutation, String, table } from "../dist/server.js";
import { createPendingFileUpload } from "../dist/file-storage-runtime.js";

test("Capsules cannot adopt runtime-owned Team tables through ctx.db schema", async () => {
  await withDatabase(async (databasePath) => {
    await assert.rejects(
      () => openDevDatabase(databasePath, "", {}, { name: "teams-isolation" }, {
        name: "teams-isolation",
        schema: { sporades_teams: table({ leaked: String() }) },
      }),
      (error) => error?.code === "RESERVED_TABLE_NAME",
    );
  });
});

test("concurrent initial Team listing shares one SQLite bootstrap transaction", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-concurrency",
      auth: { providers: { anonymous: true, email: true } },
    }, { name: "teams-concurrency", schema: {} });
    try {
      const anonymous = await resolveAnonymousSession(database, null);
      const linked = await signUpWithEmail(database, anonymous, "email", {
        email: "owner@example.com", password: "password-123", name: "Owner",
      });
      const results = await Promise.all([
        listCurrentUserTeams(database, linked.auth),
        listCurrentUserTeams(database, linked.auth),
      ]);
      assert.equal(results[0].teams.length, 1);
      assert.deepEqual(results[0], results[1]);
    } finally {
      await database.close();
    }
  });
});

test("different linked users can bootstrap Teams concurrently on one SQLite runtime", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-concurrency-users",
      auth: { providers: { anonymous: true, email: true } },
    }, { name: "teams-concurrency-users", schema: {} });
    try {
      const firstAnonymous = await resolveAnonymousSession(database, null);
      const secondAnonymous = await resolveAnonymousSession(database, null);
      const first = await signUpWithEmail(database, firstAnonymous, "email", { email: "first@example.com", password: "password-123", name: "First" });
      const second = await signUpWithEmail(database, secondAnonymous, "email", { email: "second@example.com", password: "password-123", name: "Second" });
      const listed = await Promise.all([
        listCurrentUserTeams(database, first.auth),
        listCurrentUserTeams(database, second.auth),
      ]);
      assert.equal(listed[0].teams.length, 1);
      assert.equal(listed[1].teams.length, 1);
      assert.notEqual(listed[0].teams[0].id, listed[1].teams[0].id);
    } finally {
      await database.close();
    }
  });
});

test("different SQLite runtimes retry concurrent initial Team bootstraps", async () => {
  await withDatabase(async (databasePath) => {
    const config = {
      name: "teams-concurrency-runtimes",
      auth: { providers: { anonymous: true, email: true } },
    };
    const capsule = { name: "teams-concurrency-runtimes", schema: {} };
    const firstRuntime = await openDevDatabase(databasePath, "", {}, config, capsule);
    const secondRuntime = await openDevDatabase(databasePath, "", {}, config, capsule);
    try {
      const firstAnonymous = await resolveAnonymousSession(firstRuntime, null);
      const secondAnonymous = await resolveAnonymousSession(firstRuntime, null);
      const first = await signUpWithEmail(firstRuntime, firstAnonymous, "email", { email: "runtime-first@example.com", password: "password-123", name: "First" });
      const second = await signUpWithEmail(firstRuntime, secondAnonymous, "email", { email: "runtime-second@example.com", password: "password-123", name: "Second" });
      const listed = await Promise.all([
        listCurrentUserTeams(firstRuntime, first.auth),
        listCurrentUserTeams(secondRuntime, second.auth),
      ]);
      assert.equal(listed[0].teams.length, 1);
      assert.equal(listed[1].teams.length, 1);
      assert.notEqual(listed[0].teams[0].id, listed[1].teams[0].id);
    } finally {
      await Promise.all([firstRuntime.close(), secondRuntime.close()]);
    }
  });
});

test("Privileged callbacks do not inherit current-user Teams", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, { name: "teams-privileged" }, {
      name: "teams-privileged",
      schema: {},
      mutations: {
        probe: mutation((ctx) => ctx.privileged.run(
          { operation: "teams.probe", targetResourceKind: "capsule-db" },
          (privileged) => Object.hasOwn(privileged, "teams"),
        )),
      },
    });
    try {
      const result = await runMutation(database, linkedAuth("user-one"), "probe", []);
      assert.deepEqual(result, { ok: true, data: false, error: null });
    } finally {
      await database.close();
    }
  });
});

test("a Capsule that never uses Teams retains auth, query, mutation, file, and ACL behavior", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-compatibility",
      auth: { providers: { anonymous: true, email: true } },
    }, {
      name: "teams-compatibility",
      schema: {
        notes: table({ ownerId: String(), body: String() }).acl({
          read: ({ row, ctx }) => row.ownerId === ctx.auth.userId,
          write: ({ next, ctx }) => next.ownerId === ctx.auth.userId,
        }),
      },
      queries: { mine: { kind: "query", handler: (ctx) => ctx.db.notes.all() } },
      mutations: { add: mutation((ctx, body) => ctx.db.notes.insert({ ownerId: ctx.auth.userId, body })) },
    });
    try {
      const anonymous = await resolveAnonymousSession(database, null);
      assert.deepEqual(Object.keys(anonymous.auth).sort(), ["displayName", "email", "isAuthenticated", "isGuest", "picture", "provider", "userId"]);
      const linked = await signUpWithEmail(database, anonymous, "email", {
        email: "compat@example.com", password: "password-123", name: "Compatible",
      });
      assert.equal((await runMutation(database, linked.auth, "add", ["unchanged"])).ok, true);
      assert.deepEqual((await runQuery(database, linked.auth, "mine")).data.map((row) => row.body), ["unchanged"]);
      assert.deepEqual((await runQuery(database, linkedAuth("other-user"), "mine")).data, []);
      const upload = await createPendingFileUpload(database, linked.auth, {
        file: { name: "note.txt", type: "text/plain", size: 4, path: "/notes/note.txt" },
      });
      assert.equal(upload.ok, true);
      assert.equal(upload.data.file.path, "/notes/note.txt");
    } finally {
      await database.close();
    }
  });
});

function linkedAuth(userId) {
  return { userId, displayName: "Owner", email: "owner@example.com", picture: null, isAuthenticated: true, isGuest: false, provider: "email" };
}

async function withDatabase(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-runtime-"));
  try {
    return await fn(path.join(dir, "data.db"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
