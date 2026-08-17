import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDevDatabase, runQuery, withTrustedRead } from "../dist/server-runtime-source.js";
import * as publicServer from "../dist/server.js";
import { Number as NumberField, String as StringField, table } from "../dist/server.js";
import { POSTGRES_SKIP_REASON, withPostgresAdapter } from "./support/database-adapter-engines.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";

test("trusted app-database reads bypass row ACLs inside an existing transaction", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-trusted-read-"));
  let aclEvaluations = 0;
  const capsule = {
    name: "trusted-read-test",
    schema: {
      policies: table({ teamId: StringField(), maximumMembers: NumberField() }).acl({
        read: () => {
          aclEvaluations += 1;
          return false;
        },
      }),
    },
    queries: {
      normalPolicyRead: {
        kind: "query",
        handler: (ctx) => ctx.db.policies.all(),
      },
    },
  };
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
    name: capsule.name,
  }, capsule);

  try {
    const policyTable = database.schema.tables.find((candidate) => candidate.name === "policies");
    await database.adapter.insertAppRow(policyTable, {
      id: "policy-1",
      teamId: "team-1",
      maximumMembers: 3,
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
    });

    assert.deepEqual(await runQuery(database, { userId: "invitee-1" }, "normalPolicyRead"), {
      data: [],
      error: null,
    });
    assert.equal(aclEvaluations, 1);

    const policy = await database.adapter.withTransaction((transaction) => withTrustedRead(database, {
      transaction,
      purpose: "teams.join-admission",
      subject: { userId: "invitee-1" },
      signal: new AbortController().signal,
    }, (db) => db.policies.where("teamId", "team-1").get()));

    assert.equal(policy.maximumMembers, 3);
    assert.equal(aclEvaluations, 1, "trusted reads do not evaluate an actor's row ACL");
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted reads are not part of the supported Capsule server interface", () => {
  assert.equal(publicServer.withTrustedRead, undefined);
});

test("trusted read handles are app-table-only, read-only, and revoked after settlement", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-trusted-read-revocation-"));
  const capsule = {
    name: "trusted-read-revocation-test",
    schema: {
      policies: table({ teamId: StringField(), maximumMembers: NumberField() }).acl({
        read: () => false,
      }),
    },
  };
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
    name: capsule.name,
  }, capsule);

  try {
    const policyTable = database.schema.tables.find((candidate) => candidate.name === "policies");
    await database.adapter.insertAppRow(policyTable, {
      id: "policy-1",
      teamId: "team-1",
      maximumMembers: 3,
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
    });

    let leakedDb;
    let leakedTable;
    let leakedQuery;
    await database.adapter.withTransaction((transaction) => withTrustedRead(database, {
      transaction,
      purpose: "teams.join-admission",
      subject: { userId: "invitee-1" },
      signal: new AbortController().signal,
    }, (db) => {
      leakedDb = db;
      leakedTable = db.policies;
      leakedQuery = db.policies.where("teamId", "team-1");
      assert.deepEqual(Object.keys(db), ["policies"]);
      assert.deepEqual(Object.keys(db.policies).sort(), ["all", "get", "limit", "orderBy", "where"]);
      assert.equal(db.policies.insert, undefined);
      assert.equal(db.policies.update, undefined);
      assert.equal(db.policies.delete, undefined);
      assert.equal(db.sporades_auth_users, undefined);
      return db.policies.get();
    }));

    for (const read of [
      () => leakedDb.policies.all(),
      () => leakedTable.all(),
      () => leakedQuery.get(),
    ]) {
      assert.throws(read, (error) => error.code === "TRUSTED_READ_ACCESS_INACTIVE");
    }

    let failureLeakedTable;
    const policyFailure = new Error("protected subscription row policy-secret-123 failed");
    await assert.rejects(database.adapter.withTransaction((transaction) => withTrustedRead(database, {
      transaction,
      purpose: "teams.join-admission",
      subject: { userId: "invitee-1" },
      signal: new AbortController().signal,
    }, (db) => {
      failureLeakedTable = db.policies;
      throw policyFailure;
    })), (error) => {
      assert.equal(error.code, "TRUSTED_READ_FAILED");
      assert.equal(error.message.includes("policy-secret-123"), false);
      return true;
    });
    assert.throws(() => failureLeakedTable.get(), (error) => error.code === "TRUSTED_READ_ACCESS_INACTIVE");
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted reads require an active transaction and a runtime-owned purpose", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-trusted-read-authority-"));
  const capsule = {
    name: "trusted-read-authority-test",
    schema: {
      policies: table({ teamId: StringField(), maximumMembers: NumberField() }),
    },
  };
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
    name: capsule.name,
  }, capsule);
  const callback = () => {
    throw new Error("an invalid trusted-read scope must not invoke its callback");
  };

  try {
    await assert.rejects(withTrustedRead(database, {
      transaction: database.adapter,
      purpose: "teams.join-admission",
      subject: { userId: "invitee-1" },
      signal: new AbortController().signal,
    }, callback), (error) => error.code === "TRUSTED_READ_TRANSACTION_REQUIRED");

    await database.adapter.withTransaction(async (transaction) => {
      await assert.rejects(withTrustedRead(database, {
        transaction,
        purpose: "capsule.caller-invented-bypass",
        subject: { userId: "invitee-1" },
        signal: new AbortController().signal,
      }, callback), (error) => error.code === "INVALID_TRUSTED_READ_PURPOSE");
    });
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted reads reject an active transaction owned by another runtime", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-trusted-read-owner-"));
  const capsule = {
    name: "trusted-read-owner-test",
    schema: {
      policies: table({ teamId: StringField(), maximumMembers: NumberField() }),
    },
  };
  const first = await openDevDatabase(path.join(dir, "first.db"), "", {}, { name: capsule.name }, capsule);
  const second = await openDevDatabase(path.join(dir, "second.db"), "", {}, { name: capsule.name }, capsule);

  try {
    await second.adapter.withTransaction(async (foreignTransaction) => {
      await assert.rejects(withTrustedRead(first, {
        transaction: foreignTransaction,
        purpose: "teams.join-admission",
        subject: { userId: "invitee-1" },
        signal: new AbortController().signal,
      }, () => {
        throw new Error("a foreign transaction must not acquire trusted-read authority");
      }), (error) => error.code === "TRUSTED_READ_TRANSACTION_REQUIRED");
    });
  } finally {
    await first.close();
    await second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted reads fail closed on cancellation and revoke retained handles", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-trusted-read-cancellation-"));
  const capsule = {
    name: "trusted-read-cancellation-test",
    schema: {
      policies: table({ teamId: StringField(), maximumMembers: NumberField() }).acl({
        read: () => false,
      }),
    },
  };
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, {
    name: capsule.name,
  }, capsule);

  try {
    const preAborted = new AbortController();
    preAborted.abort();
    let preAbortedCallbackCalled = false;
    await database.adapter.withTransaction(async (transaction) => {
      await assert.rejects(withTrustedRead(database, {
        transaction,
        purpose: "teams.join-admission",
        subject: { userId: "invitee-1" },
        signal: preAborted.signal,
      }, () => {
        preAbortedCallbackCalled = true;
      }), (error) => error.code === "TRUSTED_READ_ABORTED");
    });
    assert.equal(preAbortedCallbackCalled, false);

    const lateController = new AbortController();
    await database.adapter.withTransaction(async (transaction) => {
      await assert.rejects(withTrustedRead(database, {
        transaction,
        purpose: "teams.join-admission",
        subject: { userId: "invitee-1" },
        signal: lateController.signal,
      }, async () => {
        await Promise.resolve();
        lateController.abort();
        return "must not escape";
      }), (error) => error.code === "TRUSTED_READ_ABORTED");
    });

    const controller = new AbortController();
    let leakedDb;
    await database.adapter.withTransaction(async (transaction) => {
      await assert.rejects(withTrustedRead(database, {
        transaction,
        purpose: "teams.join-admission",
        subject: { userId: "invitee-1" },
        signal: controller.signal,
      }, (db) => {
        leakedDb = db;
        controller.abort();
        return db.policies.all();
      }), (error) => error.code === "TRUSTED_READ_ABORTED");
    });
    assert.throws(() => leakedDb.policies.all(), (error) => error.code === "TRUSTED_READ_ACCESS_INACTIVE");
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const engine of [
  {
    name: "SQLite",
    skip: false,
    async run(dir, capsule, fn) {
      const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: capsule.name }, capsule);
      try { await fn(database); } finally { await database.close(); }
    },
  },
  {
    name: "libSQL",
    skip: false,
    async run(dir, capsule, fn) {
      await withFakeLibsqlService(path.join(dir, "libsql.db"), async ({ url }) => {
        const serverEnv = {
          SPORADES_SERVICE_DATABASE_ENGINE: "libsql",
          SPORADES_SERVICE_DATABASE_URL: url,
        };
        const database = await openDevDatabase(path.join(dir, "data.db"), "", serverEnv, {
          name: capsule.name,
          services: { database: { kind: "database", engine: "libsql" } },
        }, capsule, { serviceEnv: serverEnv });
        try { await fn(database); } finally { await database.close(); }
      });
    },
  },
  {
    name: "PostgreSQL",
    skip: POSTGRES_SKIP_REASON,
    async run(dir, capsule, fn) {
      await withPostgresAdapter(async () => {}, { appTableNames: ["policies"] });
      const serverEnv = {
        SPORADES_SERVICE_DATABASE_ENGINE: "postgres",
        SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL,
      };
      const database = await openDevDatabase(path.join(dir, "data.db"), "", serverEnv, {
        name: capsule.name,
        services: { database: { kind: "database", engine: "postgres" } },
      }, capsule, { serviceEnv: serverEnv });
      try { await fn(database); } finally { await database.close(); }
    },
  },
]) {
  test(`${engine.name} trusted-read conformance`, { skip: engine.skip }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), `sporades-trusted-read-${engine.name.toLowerCase()}-`));
    const capsule = {
      name: `trusted-read-${engine.name.toLowerCase()}-conformance`,
      schema: {
        policies: table({ teamId: StringField(), maximumMembers: NumberField() }).acl({
          read: () => false,
        }),
      },
      queries: {
        normalPolicyRead: {
          kind: "query",
          handler: (ctx) => ctx.db.policies.all(),
        },
      },
    };
    try {
      await engine.run(dir, capsule, async (database) => {
        const policyTable = database.schema.tables.find((candidate) => candidate.name === "policies");
        const timestamp = "2026-08-17T00:00:00.000Z";
        await database.adapter.insertAppRow(policyTable, {
          id: "committed-policy",
          teamId: "team-1",
          maximumMembers: 2,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        assert.deepEqual(await runQuery(database, { userId: "invitee-1" }, "normalPolicyRead"), {
          data: [],
          error: null,
        });

        let snapshotCallbackCalled = false;
        await database.adapter.withReadOnlySnapshot(async (snapshot) => {
          await assert.rejects(withTrustedRead(database, {
            transaction: snapshot,
            purpose: "teams.join-admission",
            subject: { userId: "invitee-1" },
            signal: new AbortController().signal,
          }, () => {
            snapshotCallbackCalled = true;
          }), (error) => error.code === "TRUSTED_READ_TRANSACTION_REQUIRED");
        });
        assert.equal(snapshotCallbackCalled, false, "read-only snapshots cannot acquire transition authority");

        let observedSeatLimits;
        let leakedTable;
        await assert.rejects(database.adapter.withTransaction(async (transaction) => {
          await transaction.prepare(transaction.dialect.sql(
            "INSERT INTO [policies] ([id], [createdAt], [updatedAt], [teamId], [maximumMembers]) VALUES (?, ?, ?, ?, ?)",
          )).run("transaction-policy", timestamp, timestamp, "team-1", 3);
          observedSeatLimits = await withTrustedRead(database, {
            transaction,
            purpose: "teams.join-admission",
            subject: { userId: "invitee-1" },
            signal: new AbortController().signal,
          }, async (db) => {
            leakedTable = db.policies;
            assert.deepEqual(Object.keys(db), ["policies"]);
            assert.deepEqual(Object.keys(db.policies).sort(), ["all", "get", "limit", "orderBy", "where"]);
            assert.equal(db.policies.insert, undefined);
            assert.equal(db.adapter, undefined);
            return (await db.policies.orderBy("maximumMembers", "asc").all())
              .map((policy) => policy.maximumMembers);
          });
          throw new Error("roll back trusted-read conformance transaction");
        }), /roll back trusted-read conformance transaction/);

        assert.deepEqual(observedSeatLimits, [2, 3], "trusted reads see committed and same-transaction app rows");
        assert.throws(() => leakedTable.all(), (error) => error.code === "TRUSTED_READ_ACCESS_INACTIVE");

        await database.adapter.withTransaction(async (transaction) => {
          await assert.rejects(withTrustedRead(database, {
            transaction,
            purpose: "teams.join-admission",
            subject: { userId: "invitee-1" },
            signal: new AbortController().signal,
          }, () => {
            throw new Error("protected policy-secret-123");
          }), (error) => error.code === "TRUSTED_READ_FAILED" && !error.message.includes("policy-secret-123"));

          const controller = new AbortController();
          await assert.rejects(withTrustedRead(database, {
            transaction,
            purpose: "teams.join-admission",
            subject: { userId: "invitee-1" },
            signal: controller.signal,
          }, async () => {
            await Promise.resolve();
            controller.abort();
            return null;
          }), (error) => error.code === "TRUSTED_READ_ABORTED");
        });

        assert.deepEqual(
          (await database.adapter.selectAppRows(policyTable, {
            columns: ["id", "maximumMembers"],
            orderBy: { fieldName: "maximumMembers", direction: "asc" },
          })).map((row) => ({ ...row })),
          [{ id: "committed-policy", maximumMembers: 2 }],
          "the caller's transaction still owns rollback",
        );
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
