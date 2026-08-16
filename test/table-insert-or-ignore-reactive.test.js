import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { String, mutation, table } from "../dist/server.js";
import { openDevDatabase, runMutation, runQuery } from "../dist/server-runtime-source.js";

const auth = {
  userId: "insert-or-ignore-cache-user",
  displayName: "Insert or ignore cache user",
  email: null,
  picture: null,
  isAuthenticated: false,
  isGuest: true,
  provider: "anonymous",
};

test("a no-write insertOrIgnore mutation preserves query cache while another write invalidates it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-insert-or-ignore-cache-"));
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "insert-or-ignore-cache" }, {
    schema: {
      subscriptions: table({ teamId: String(), plan: String() }).unique("teamId"),
      mutation_audits: table({ message: String() }),
    },
    mutations: {
      bootstrap: mutation((ctx, teamId) => ctx.db.subscriptions.insertOrIgnore({ teamId, plan: "pro" }, "teamId")),
      bootstrapAndAudit: mutation(async (ctx, teamId) => {
        const singleton = await ctx.db.subscriptions.insertOrIgnore({ teamId, plan: "pro" }, "teamId");
        await ctx.db.mutation_audits.insert({ message: `checked:${teamId}` });
        return singleton;
      }),
    },
  });
  try {
    const inserted = await runMutation(database, auth, "bootstrap", ["team-a"]);
    assert.equal(inserted.ok, true, inserted.error?.message);
    assert.equal((await runQuery(database, auth, "subscriptions")).rows.length, 1);
    assert.equal(database.rowCache.size, 1, "the subscribed query path primes one app-table cache entry");
    const cachedRows = [...database.rowCache.values()][0];

    const duplicate = await runMutation(database, auth, "bootstrap", ["team-a"]);
    assert.equal(duplicate.ok, true, duplicate.error?.message);
    assert.equal(duplicate.data, null);
    assert.equal(database.rowCache.size, 1, "a pure conflict loser does not invalidate the query cache");
    assert.equal([...database.rowCache.values()][0], cachedRows, "the no-write mutation preserves the cached snapshot by identity");

    const otherWrite = await runMutation(database, auth, "bootstrapAndAudit", ["team-a"]);
    assert.equal(otherWrite.ok, true, otherWrite.error?.message);
    assert.equal(database.rowCache.size, 0, "another write in the same mutation still invalidates query cache state");
    assert.equal((await runQuery(database, auth, "subscriptions")).rows.length, 1);
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
