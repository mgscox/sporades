import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDevDatabase, resolveAnonymousSession, runMutation, signUpWithEmail } from "../dist/server-runtime-source.js";
import { listCurrentUserTeams } from "../dist/teams-runtime.js";
import { mutation, String, table } from "../dist/server.js";

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
