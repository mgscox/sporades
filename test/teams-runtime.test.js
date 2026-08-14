import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  linkProviderIdentity, openDevDatabase, resolveAnonymousSession, runMutation, runQuery, signInWithEmail, signUpWithEmail, simulateLocalIdentitySession,
} from "../dist/server-runtime-source.js";
import { createTeamTables, listCurrentUserTeams } from "../dist/teams-runtime.js";
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

test("Capsules cannot bypass the complete runtime Team namespace with case or future names", async () => {
  for (const name of ["SPORADES_TEAMS", "SPORADES_TEAM_BOOTSTRAP", "sporades_teamfuture"]) {
    await withDatabase(async (databasePath) => {
      await assert.rejects(
        () => openDevDatabase(databasePath, "", {}, { name: "teams-isolation" }, {
          name: "teams-isolation",
          schema: { [name]: table({ leaked: String() }) },
        }),
        (error) => error?.code === "RESERVED_TABLE_NAME",
        name,
      );
    });
  }
});

test("Team runtime DDL runs in deterministic table order", async () => {
  const calls = [];
  let releaseFirst;
  const adapter = {
    dialect: { sql: (statement) => statement },
    exec(statement) {
      calls.push(statement);
      if (calls.length === 1) return new Promise((resolve) => { releaseFirst = resolve; });
    },
  };
  const created = createTeamTables(adapter);
  assert.equal(calls.length, 1, "the second DDL statement waits for the first");
  releaseFirst();
  await created;
  assert.equal(calls.length, 3);
  assert.match(calls[0], /sporades_teams/);
  assert.match(calls[1], /sporades_team_memberships/);
  assert.match(calls[2], /sporades_team_bootstrap/);
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
      assert.equal(
        database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_teams] WHERE [createdByUserId] = ?").get(linked.auth.userId).count,
        1,
        "email account linking commits the initial Team before a Team-interface call",
      );
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

test("a new email link and a legacy Team list share the same SQLite transaction queue", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-auth-and-lazy-queue", auth: { providers: { anonymous: true, email: true } },
    }, { name: "teams-auth-and-lazy-queue", schema: {} });
    try {
      const signupGuest = await resolveAnonymousSession(database, null);
      const legacySession = await resolveAnonymousSession(database, null);
      const legacyAuth = {
        ...legacySession.auth, displayName: "Legacy Queue", email: "legacy-queue@example.com",
        isAuthenticated: true, isGuest: false, provider: "email",
      };
      await database.adapter.withTransaction((tx) => tx.linkAuthUser({
        id: legacyAuth.userId, displayName: legacyAuth.displayName, email: legacyAuth.email, picture: null,
        isAuthenticated: 1, isGuest: 0, provider: "email",
      }));

      const [signedUp, legacyTeams] = await Promise.all([
        signUpWithEmail(database, signupGuest, "email", {
          email: "queued-link@example.com", password: "password-123", name: "Queued Link",
        }),
        listCurrentUserTeams(database, legacyAuth),
      ]);
      assert.equal(signedUp.ok, true);
      assert.equal(teamCountForUser(database, signedUp.auth.userId), 1);
      assert.equal(legacyTeams.teams.length, 1);
      assert.equal(teamCountForUser(database, legacyAuth.userId), 1);
    } finally {
      await database.close();
    }
  });
});

test("email and every OAuth linking provider commit one initial Team while returning accounts remain unchanged", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-linking-seams",
      auth: { providers: { anonymous: true, email: true, google: true, microsoft: true, apple: true, facebook: true } },
    }, { name: "teams-linking-seams", schema: {} });
    try {
      const emailAnonymous = await resolveAnonymousSession(database, null);
      assert.equal(teamCount(database), 0, "ordinary anonymous browsing creates no Team rows");
      const emailLinked = await signUpWithEmail(database, emailAnonymous, "email", {
        email: "email@example.com", password: "password-123", name: "Email Owner",
      });
      assert.equal(emailLinked.ok, true);
      assert.equal(teamCountForUser(database, emailLinked.auth.userId), 1);
      const emailSignInAnonymous = await resolveAnonymousSession(database, null);
      const emailSignIn = await signInWithEmail(database, emailSignInAnonymous, {
        email: "email@example.com", password: "password-123", name: "Ignored",
      });
      assert.equal(emailSignIn.ok, true);
      assert.equal(teamCountForUser(database, emailLinked.auth.userId), 1, "email sign-in does not duplicate the initial Team");

      for (const provider of ["google", "microsoft", "apple", "facebook"]) {
        const firstAnonymous = await resolveAnonymousSession(database, null);
        const linked = await linkProviderIdentity(database, firstAnonymous, provider, {
          subject: `${provider}-new-user`, email: `${provider}@example.com`, displayName: `${provider} Owner`,
        });
        assert.equal(linked.ok, true, provider);
        assert.equal(teamCountForUser(database, linked.auth.userId), 1, `${provider} linking commits one Team`);
        assert.equal((await listCurrentUserTeams(database, linked.auth)).teams.length, 1, `${provider} caller immediately sees its Team`);

        const returningAnonymous = await resolveAnonymousSession(database, null);
        const returned = await linkProviderIdentity(database, returningAnonymous, provider, {
          subject: `${provider}-new-user`, email: `${provider}@example.com`, displayName: `${provider} Owner`,
        });
        assert.equal(returned.ok, true, `${provider} existing-account sign-in`);
        assert.equal(returned.auth.userId, linked.auth.userId, `${provider} returns the original account`);
        assert.equal(teamCountForUser(database, linked.auth.userId), 1, `${provider} sign-in does not duplicate the Team`);
      }
    } finally {
      await database.close();
    }
  });
});

test("a Team-bootstrap failure rolls back new email linking and retains the anonymous Session", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-linking-rollback", auth: { providers: { anonymous: true, email: true } },
    }, { name: "teams-linking-rollback", schema: {} });
    const baseAdapter = database.adapter;
    try {
      const anonymous = await resolveAnonymousSession(database, null);
      database.adapter = failTeamBootstrapMembershipInsert(baseAdapter, new Error("team membership exploded"));
      await assert.rejects(
        () => signUpWithEmail(database, anonymous, "email", {
          email: "rollback@example.com", password: "password-123", name: "Rollback",
        }),
        /team membership exploded/,
      );
      assert.equal(baseAdapter.emailCredentialExists("rollback@example.com"), false);
      assert.equal(teamCount(baseAdapter), 0);
      const preserved = baseAdapter.readAuthSessionWithUser(anonymous.token);
      assert.equal(preserved.userId, anonymous.auth.userId);
      assert.equal(preserved.provider, "anonymous");
      assert.equal(preserved.isGuest, 1);
    } finally {
      await database.close();
    }
  });
});

test("retried concurrent OAuth completions share one committed initial Team", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-linking-concurrency", auth: { providers: { anonymous: true, google: true } },
    }, { name: "teams-linking-concurrency", schema: {} });
    try {
      const anonymous = await resolveAnonymousSession(database, null);
      const profile = { subject: "concurrent-google-user", email: "concurrent@example.com", displayName: "Concurrent" };
      const results = await Promise.all([
        linkProviderIdentity(database, anonymous, "google", profile),
        linkProviderIdentity(database, anonymous, "google", profile),
      ]);
      assert.equal(results[0].ok, true);
      assert.equal(results[1].ok, true);
      assert.equal(results[0].auth.userId, results[1].auth.userId);
      assert.equal(teamCountForUser(database, results[0].auth.userId), 1);
      assert.equal((await listCurrentUserTeams(database, results[0].auth)).teams.length, 1);
    } finally {
      await database.close();
    }
  });
});

test("a linked user from before Team bootstrap still receives the initial Team lazily", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-legacy-lazy", auth: { providers: { anonymous: true, email: true } },
    }, { name: "teams-legacy-lazy", schema: {} });
    try {
      const anonymous = await resolveAnonymousSession(database, null);
      const auth = { ...anonymous.auth, displayName: "Legacy", email: "legacy@example.com", isAuthenticated: true, isGuest: false, provider: "email" };
      await database.adapter.withTransaction((tx) => tx.linkAuthUser({
        id: auth.userId, displayName: auth.displayName, email: auth.email, picture: null,
        isAuthenticated: 1, isGuest: 0, provider: "email",
      }));
      assert.equal(teamCountForUser(database, auth.userId), 0);
      const teams = await listCurrentUserTeams(database, auth);
      assert.equal(teams.teams.length, 1);
      assert.equal(teamCountForUser(database, auth.userId), 1);
    } finally {
      await database.close();
    }
  });
});

test("a pre-Teams Google legacy account remains lazy when a guest restores it", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-legacy-google", auth: { providers: { anonymous: true, google: true } },
    }, { name: "teams-legacy-google", schema: {} });
    try {
      const legacySession = await resolveAnonymousSession(database, null);
      await database.adapter.withTransaction(async (tx) => {
        await tx.linkAuthUser({
          id: legacySession.auth.userId, displayName: "Legacy Google", email: "legacy-google@example.com", picture: null,
          isAuthenticated: 1, isGuest: 0, provider: "google",
        });
        await tx.insertAuthIdentity({
          id: "legacy-google-identity", userId: legacySession.auth.userId, provider: "google", subject: "legacy:google-email",
          email: "legacy-google@example.com", displayName: "Legacy Google", picture: null,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
      });
      const guest = await resolveAnonymousSession(database, null);
      const restored = await linkProviderIdentity(database, guest, "google", {
        subject: "google-restored-subject", email: "legacy-google@example.com", emailVerified: true, displayName: "Legacy Google",
      });
      assert.equal(restored.ok, true);
      assert.equal(restored.auth.userId, legacySession.auth.userId);
      assert.equal(teamCountForUser(database, restored.auth.userId), 0, "legacy restoration must retain Ticket 01 lazy bootstrap");
      assert.equal((await listCurrentUserTeams(database, restored.auth)).teams.length, 1);
    } finally {
      await database.close();
    }
  });
});

test("new simulated identities bootstrap transactionally while existing simulated identities retain lazy Team history", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-simulated-linking", auth: { providers: { anonymous: true, email: true, google: true } },
    }, { name: "teams-simulated-linking", schema: {} });
    try {
      for (const provider of ["email", "google"]) {
        const simulated = await simulateLocalIdentitySession(database, {
          provider, email: `${provider}-simulated@example.com`, displayName: `${provider} Simulated`,
        });
        assert.equal(simulated.ok, true);
        assert.equal(teamCountForUser(database, simulated.data.auth.userId), 1, `${provider} simulated link commits its Team`);
        const repeated = await simulateLocalIdentitySession(database, {
          provider, email: `${provider}-simulated@example.com`, displayName: `${provider} Simulated`,
        });
        assert.equal(repeated.ok, true);
        assert.equal(repeated.data.auth.userId, simulated.data.auth.userId);
        assert.equal(teamCountForUser(database, simulated.data.auth.userId), 1, `${provider} simulated retry does not duplicate`);
      }

      const now = new Date().toISOString();
      await database.adapter.withTransaction(async (tx) => {
        await tx.insertAuthUser({
          id: "legacy-simulated-user", createdAt: now, displayName: "Legacy Simulated", email: "legacy-simulated@example.com",
          picture: null, isAuthenticated: 1, isGuest: 0, provider: "anonymous",
        });
        await tx.insertAuthIdentity({
          id: "legacy-simulated-identity", userId: "legacy-simulated-user", provider: "email", subject: "local:legacy-simulated@example.com",
          email: "legacy-simulated@example.com", displayName: "Legacy Simulated", picture: null, createdAt: now, updatedAt: now,
        });
      });
      const legacy = await simulateLocalIdentitySession(database, {
        provider: "email", email: "legacy-simulated@example.com", displayName: "Legacy Simulated",
      });
      assert.equal(legacy.ok, true);
      assert.equal(legacy.data.auth.userId, "legacy-simulated-user");
      assert.equal(teamCountForUser(database, legacy.data.auth.userId), 0);
      assert.equal((await listCurrentUserTeams(database, legacy.data.auth)).teams.length, 1);
    } finally {
      await database.close();
    }
  });
});

test("same-runtime concurrent simulated identity creation commits one Team", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-simulated-concurrency", auth: { providers: { anonymous: true, email: true } },
    }, { name: "teams-simulated-concurrency", schema: {} });
    try {
      const options = { provider: "email", email: "concurrent-simulated@example.com", displayName: "Concurrent Simulated" };
      const [first, second] = await Promise.all([
        simulateLocalIdentitySession(database, options),
        simulateLocalIdentitySession(database, options),
      ]);
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(first.data.auth.userId, second.data.auth.userId);
      assert.equal(teamCountForUser(database, first.data.auth.userId), 1);
    } finally {
      await database.close();
    }
  });
});

test("separate SQLite runtimes retry concurrent simulated identity creation without duplicate Teams", async () => {
  await withDatabase(async (databasePath) => {
    const config = { name: "teams-simulated-cross-runtime", auth: { providers: { anonymous: true, google: true } } };
    const capsule = { name: "teams-simulated-cross-runtime", schema: {} };
    const firstRuntime = await openDevDatabase(databasePath, "", {}, config, capsule);
    const secondRuntime = await openDevDatabase(databasePath, "", {}, config, capsule);
    try {
      const options = { provider: "google", email: "cross-runtime-simulated@example.com", displayName: "Cross Runtime Simulated" };
      const [first, second] = await Promise.all([
        simulateLocalIdentitySession(firstRuntime, options),
        simulateLocalIdentitySession(secondRuntime, options),
      ]);
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(first.data.auth.userId, second.data.auth.userId);
      assert.equal(teamCountForUser(firstRuntime, first.data.auth.userId), 1);
    } finally {
      await Promise.all([firstRuntime.close(), secondRuntime.close()]);
    }
  });
});

test("separate SQLite runtimes retry a concurrent OAuth account link without duplicate Teams", async () => {
  await withDatabase(async (databasePath) => {
    const config = { name: "teams-linking-cross-runtime", auth: { providers: { anonymous: true, google: true } } };
    const capsule = { name: "teams-linking-cross-runtime", schema: {} };
    const firstRuntime = await openDevDatabase(databasePath, "", {}, config, capsule);
    const secondRuntime = await openDevDatabase(databasePath, "", {}, config, capsule);
    try {
      const firstGuest = await resolveAnonymousSession(firstRuntime, null);
      const secondGuest = await resolveAnonymousSession(secondRuntime, null);
      const profile = { subject: "cross-runtime-google", email: "cross-runtime@example.com", displayName: "Cross Runtime" };
      const [first, second] = await Promise.all([
        linkProviderIdentity(firstRuntime, firstGuest, "google", profile),
        linkProviderIdentity(secondRuntime, secondGuest, "google", profile),
      ]);
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(first.auth.userId, second.auth.userId);
      assert.equal(teamCountForUser(firstRuntime, first.auth.userId), 1);
    } finally {
      await Promise.all([firstRuntime.close(), secondRuntime.close()]);
    }
  });
});

test("OAuth linking retries a recognized Postgres provider-identity unique conflict", async () => {
  await withDatabase(async (databasePath) => {
    const database = await openDevDatabase(databasePath, "", {}, {
      name: "teams-postgres-identity-conflict", auth: { providers: { anonymous: true, google: true } },
    }, { name: "teams-postgres-identity-conflict", schema: {} });
    const baseAdapter = database.adapter;
    try {
      const guest = await resolveAnonymousSession(database, null);
      database.adapter = failFirstAuthTransaction(baseAdapter, Object.assign(new Error("duplicate provider identity"), {
        code: "23505", constraint: "sporades_auth_identities_provider_subject_key",
      }));
      const linked = await linkProviderIdentity(database, guest, "google", {
        subject: "postgres-conflict-subject", email: "postgres-conflict@example.com", displayName: "Postgres Conflict",
      });
      assert.equal(linked.ok, true);
      assert.equal(teamCountForUser(database, linked.auth.userId), 1);
    } finally {
      database.adapter = baseAdapter;
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

function teamCount(adapterOrDatabase) {
  const adapter = adapterOrDatabase.adapter ?? adapterOrDatabase;
  return Number(adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_teams]").get().count);
}

function teamCountForUser(database, userId) {
  return Number(database.adapter.prepare("SELECT COUNT(*) AS [count] FROM [sporades_teams] WHERE [createdByUserId] = ?").get(userId).count);
}

function failTeamBootstrapMembershipInsert(adapter, error) {
  const wrap = (target) => new Proxy(target, {
    get(currentTarget, property, receiver) {
      if (property === "withTransaction") {
        return async (fn) => {
          const withTransaction = Reflect.get(currentTarget, property, receiver);
          return await withTransaction.call(currentTarget, async (transactionAdapter) => await fn(wrap(transactionAdapter)));
        };
      }
      const value = Reflect.get(currentTarget, property, receiver);
      if (property !== "prepare" || typeof value !== "function") return value;
      return (statement) => {
        const prepared = value.call(currentTarget, statement);
        if (!`${statement}`.includes("sporades_team_memberships")) return prepared;
        return { ...prepared, run() { throw error; } };
      };
    },
  });
  return wrap(adapter);
}

function failFirstAuthTransaction(adapter, error) {
  let first = true;
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (property !== "withTransaction") return Reflect.get(target, property, receiver);
      return async (fn) => {
        if (first) {
          first = false;
          throw error;
        }
        return await target.withTransaction(fn);
      };
    },
  });
}

async function withDatabase(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-teams-runtime-"));
  try {
    return await fn(path.join(dir, "data.db"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
