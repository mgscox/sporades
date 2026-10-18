import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { acl, mutation, query, String, table } from "../dist/server.js";
import { openDevDatabase, runMutation, runQuery } from "../dist/server-runtime-source.js";

for (const helper of ["privilegedOnly", "denyAll"]) {
  test(`acl.${helper} denies ordinary reads and writes while Privileged CRUD remains callback-bound`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sporades-privileged-only-"));
    let database;
    let capturedTable;
    const actor = { userId: "user-1", isAuthenticated: true, isGuest: false, provider: "email" };
    const metadata = { operation: "secrets.maintain", targetResourceKind: "capsule-db" };
    try {
      database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "privileged-only" }, {
        schema: { secrets: table({ value: String() }).acl(acl[helper]()) },
        queries: {
          list: query(ctx => ctx.db.secrets.all()),
          get: query((ctx, id) => ctx.db.secrets.where("id", id).get()),
          privilegedList: query(ctx => ctx.privileged.run(metadata, p => p.db.secrets.all())),
        },
        mutations: {
          insert: mutation(ctx => ctx.db.secrets.insert({ value: "forbidden" })),
          update: mutation((ctx, id) => ctx.db.secrets.update(id, { value: "forbidden" })),
          delete: mutation((ctx, id) => ctx.db.secrets.delete(id)),
          privilegedInsert: mutation(ctx => ctx.privileged.run(metadata, p => {
            capturedTable = p.db.secrets;
            return p.db.secrets.insert({ value: "private-value" });
          })),
          privilegedUpdate: mutation((ctx, id) => ctx.privileged.run(metadata, p => p.db.secrets.update(id, { value: "updated" }))),
          privilegedDelete: mutation((ctx, id) => ctx.privileged.run(metadata, p => p.db.secrets.delete(id))),
        },
      });
      const inserted = await runMutation(database, actor, "privilegedInsert", []);
      assert.equal(inserted.error, null);
      assert.equal(inserted.ok, true);
      const id = inserted.data.id;
      for (const user of [actor, { ...actor, userId: "guest", isAuthenticated: false, isGuest: true, provider: "anonymous" }]) {
        assert.deepEqual((await runQuery(database, user, "list")).data, []);
        assert.equal((await runQuery(database, user, "get", [id])).data, null);
        for (const operation of ["insert", "update", "delete"]) {
          const denied = await runMutation(database, user, operation, [id]);
          assert.deepEqual(denied.error, { code: "DENIED", message: "Denied.", hint: "The current user is not allowed to perform this operation." });
        }
      }
      assert.equal((await runQuery(database, actor, "privilegedList")).data[0].value, "private-value");
      assert.equal((await runMutation(database, actor, "privilegedUpdate", [id])).ok, true);
      assert.equal((await runQuery(database, actor, "privilegedList")).data[0].value, "updated");
      await assert.rejects(async () => capturedTable.all());
      await assert.rejects(async () => capturedTable.insert({ value: "escaped" }));
      assert.equal((await runMutation(database, actor, "privilegedDelete", [id])).ok, true);
      assert.deepEqual((await runQuery(database, actor, "privilegedList")).data, []);
    } finally {
      database?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
