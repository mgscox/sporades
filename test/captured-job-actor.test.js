import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDevDatabase, runMutation } from "../dist/server-runtime-source.js";
import { job, mutation, String, table } from "../dist/server.js";

const auth = (userId) => ({ userId, displayName: userId, email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "anonymous" });

test("captured Jobs keep their admitted actor snapshot after deletion and re-evaluate ACL at execution time", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-captured-jobs-"));
  let allowWrites = true;
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "jobs" }, {
    schema: { notes: table({ text: String(), ownerId: String() }).acl({ write: () => allowWrites }) },
    jobs: { write: job((ctx, input) => ctx.db.notes.insert({ text: input.text, ownerId: ctx.auth.userId })) },
    mutations: {
      enqueue: mutation((ctx, text, options) => ctx.jobs.enqueue("write", { text }, options)),
      get: mutation((ctx, id) => ctx.jobs.get(id)),
    },
  });
  try {
    await database.init();
    for (const userId of ["gone", "denied"]) database.adapter.prepare("INSERT INTO sporades_auth_users (id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(userId, new Date().toISOString(), userId, null, null, 0, 1, "anonymous");
    const missing = await runMutation(database, auth("gone"), "enqueue", ["missing", { retry: { maxAttempts: 3, delayMs: 0 } }]);
    database.adapter.prepare("DELETE FROM sporades_auth_users WHERE id = ?").run("gone");
    const denied = await runMutation(database, auth("denied"), "enqueue", ["denied"]);
    allowWrites = false;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const missingState = await runMutation(database, auth("gone"), "get", [missing.data.id]);
    const deniedState = await runMutation(database, auth("denied"), "get", [denied.data.id]);
    assert.equal(missingState.data.status, "failed");
    assert.equal(missingState.data.failure.code, "JOB_FAILED");
    assert.equal(missingState.data.attempts, 3, "owner deletion does not revoke already admitted work or its retry policy");
    assert.equal(deniedState.data.status, "failed");
    assert.equal(database.adapter.prepare("SELECT count(*) AS count FROM notes").get().count, 0);
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }
});
