import assert from "node:assert/strict";

const NOW = "2026-08-14T12:00:00.000Z";

async function count(adapter, statement, ...values) {
  const row = await adapter.prepare(adapter.dialect.sql(statement)).get(...values);
  return Number(row?.count ?? 0);
}

export const CONFORMANCE_SURFACE = {
  title: "Database adapter conformance (runtime Team storage)",
  appTableNames: [],
  async prepareStorage(adapter) {
    await adapter.ensureTeamsStorage();
  },
  cases: [
    {
      name: "ensureTeamBillingStorage upgrades the prior schema and preserves private provider correlation on every engine",
      async run(adapter) {
        await adapter.ensureTeamsStorage();
        const sql = adapter.dialect.sql;
        await createPriorTeamBillingStorage(adapter);
        await adapter.prepare(sql("INSERT INTO [sporades_team_billing_customers] ([teamId], [mode], [providerCustomerId], [createdAt], [updatedAt]) VALUES (?, ?, ?, ?, ?)")).run("billing-team", "sandbox", "cus_private", NOW, NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_billing_subscriptions] ([id], [teamId], [mode], [providerSubscriptionId], [providerPriceId], [productKey], [quantity], [state], [cancelAtPeriodEnd], [currentPeriodEnd], [observedAt], [updatedAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")).run("local-sub", "billing-team", "sandbox", "sub_private", "price_private", "agency", 3, "active", 0, "2026-09-14T12:00:00.000Z", NOW, NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_billing_operations] ([id], [requestId], [teamId], [actorUserId], [kind], [productKey], [status], [providerObjectId], [idempotencyKey], [safeFailureCode], [createdAt], [updatedAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")).run("operation-1", "request-1", "billing-team", "billing-admin", "checkout", "agency", "queued", null, "private-idempotency", null, NOW, NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_billing_observations] ([id], [teamId], [mode], [providerEventId], [providerObjectId], [payloadDigest], [observedAt], [createdAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")).run("observation-1", "billing-team", "sandbox", "evt_private", "sub_private", "digest", NOW, NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_billing_replay] ([providerEventId], [payloadDigest], [settledAt], [retainedUntil]) VALUES (?, ?, ?, ?)")).run("evt_private", "digest", NOW, "2026-09-13T12:00:00.000Z");

        await adapter.ensureTeamBillingStorage();
        await adapter.prepare(sql(
          "UPDATE [sporades_team_billing_subscriptions] SET [providerSubscriptionItemId] = 'si_private', [currentPeriodStart] = ?, [lastEventOccurredAt] = ?, [lastEventKind] = 'cancelled', [lastEventRank] = 50, [terminalLatch] = 1 WHERE [id] = 'local-sub'",
        )).run(NOW, NOW);
        await adapter.prepare(sql(
          "UPDATE [sporades_team_billing_operations] SET [providerSubscriptionId] = 'sub_private' WHERE [id] = 'operation-1'",
        )).run();
        await adapter.prepare(sql(
          "UPDATE [sporades_team_billing_observations] SET [eventType] = 'customer.subscription.deleted', [eventRank] = 50, [outcome] = 'applied', [safeReason] = NULL WHERE [id] = 'observation-1'",
        )).run();

        await adapter.ensureTeamBillingStorage();
        for (const table of ["customers", "subscriptions", "operations", "observations", "replay"]) {
          assert.equal(await count(adapter, `SELECT COUNT(*) AS [count] FROM [sporades_team_billing_${table}]`), 1, table);
        }
        assert.equal(await count(adapter,
          "SELECT COUNT(*) AS [count] FROM [sporades_team_billing_subscriptions] WHERE [providerSubscriptionItemId] = 'si_private' AND [currentPeriodStart] = ? AND [lastEventRank] = 50 AND [terminalLatch] = 1", NOW), 1);
        assert.equal(await count(adapter,
          "SELECT COUNT(*) AS [count] FROM [sporades_team_billing_operations] WHERE [providerSubscriptionId] = 'sub_private'"), 1);
        assert.equal(await count(adapter,
          "SELECT COUNT(*) AS [count] FROM [sporades_team_billing_observations] WHERE [eventType] = 'customer.subscription.deleted' AND [eventRank] = 50 AND [outcome] = 'applied'"), 1);
      },
    },
    {
      name: "ensureTeamsStorage creates empty writable runtime tables and preserves existing Team history",
      async run(adapter) {
        await adapter.ensureTeamsStorage();
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_teams]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_bootstrap]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_membership_counters]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_secrets]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_join_links]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_throttles]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_counters]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_redemptions]"), 0);

        const sql = adapter.dialect.sql;
        await adapter.prepare(sql("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, ?, ?, ?)")).run("team-one", "My Team", NOW, "user-one");
        await adapter.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, ?, ?)")).run("team-one", "user-one", "admin", NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_bootstrap] ([userId], [teamId], [createdAt]) VALUES (?, ?, ?)")).run("user-one", "team-one", NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_membership_counters] ([userId], [membershipCount]) VALUES (?, ?)")).run("user-one", 1);
        await adapter.prepare(sql("INSERT INTO [sporades_team_join_link_secrets] ([id], [secret], [createdAt]) VALUES (?, ?, ?)")).run("v1", "test-secret", NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_join_links] ([id], [selector], [verifierHash], [teamId], [email], [createdByUserId], [createdAt], [expiresAt], [consumedAt], [revokedAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)")).run("link-one", "selector-one", "hash-one", "team-one", "invitee@example.com", "user-one", NOW, "2026-08-15T12:00:00.000Z");
        await adapter.prepare(sql("INSERT INTO [sporades_team_join_link_throttles] ([teamId], [adminUserId], [windowStartedAt], [count]) VALUES (?, ?, ?, ?)")).run("team-one", "user-one", NOW, 1);
        await adapter.prepare(sql("INSERT INTO [sporades_team_join_link_counters] ([teamId], [activeCount]) VALUES (?, ?)")).run("team-one", 1);

        await adapter.ensureTeamsStorage();
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_teams] WHERE [id] = ?", "team-one"), 1);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?", "team-one", "user-one"), 1);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_bootstrap] WHERE [userId] = ? AND [teamId] = ?", "user-one", "team-one"), 1);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_membership_counters] WHERE [userId] = ? AND [membershipCount] = ?", "user-one", 1), 1);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_secrets] WHERE [id] = ?", "v1"), 1);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_join_links] WHERE [id] = ? AND [email] = ?", "link-one", "invitee@example.com"), 1);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_throttles] WHERE [teamId] = ? AND [adminUserId] = ?", "team-one", "user-one"), 1);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_join_link_counters] WHERE [teamId] = ? AND [activeCount] = ?", "team-one", 1), 1);
      },
    },
    {
      name: "Team membership counter admits exactly one final bounded slot through the adapter transaction seam",
      async run(adapter) {
        await adapter.ensureTeamsStorage();
        const sql = adapter.dialect.sql;
        await adapter.prepare(sql("INSERT INTO [sporades_team_membership_counters] ([userId], [membershipCount]) VALUES (?, ?)")).run("bounded-user", 24);
        const first = await adapter.withTransaction((tx) => tx.prepare(tx.dialect.sql(
          "UPDATE [sporades_team_membership_counters] SET [membershipCount] = [membershipCount] + 1 WHERE [userId] = ? AND [membershipCount] < ?",
        )).run("bounded-user", 25));
        const second = await adapter.withTransaction((tx) => tx.prepare(tx.dialect.sql(
          "UPDATE [sporades_team_membership_counters] SET [membershipCount] = [membershipCount] + 1 WHERE [userId] = ? AND [membershipCount] < ?",
        )).run("bounded-user", 25));
        assert.equal(Number(first.changes), 1);
        assert.equal(Number(second.changes), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_membership_counters] WHERE [userId] = ? AND [membershipCount] = ?", "bounded-user", 25), 1);
      },
    },
    {
      name: "Team lifecycle locking keeps exact counts and membership rollback portable",
      async run(adapter) {
        await adapter.ensureTeamsStorage();
        const sql = adapter.dialect.sql;
        await adapter.prepare(sql("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, ?, ?, ?)")).run("counted-team", "Counted", NOW, "counted-admin");
        await adapter.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, ?, ?)")).run("counted-team", "counted-admin", "admin", NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, ?, ?)")).run("counted-team", "counted-member", "member", NOW);
        await assert.rejects(adapter.withTransaction(async (tx) => {
          const locked = await tx.prepare(tx.dialect.sql("UPDATE [sporades_teams] SET [name] = [name] WHERE [id] = ?")).run("counted-team");
          assert.equal(Number(locked.changes), 1);
          assert.equal(await count(tx, "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ?", "counted-team"), 2);
          await tx.prepare(tx.dialect.sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, ?, ?)")).run("counted-team", "rolled-back-member", "member", NOW);
          throw new Error("roll back admission lane");
        }), /roll back admission lane/);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ?", "counted-team"), 2);
      },
    },
  ],
};

async function createPriorTeamBillingStorage(adapter) {
  const sql = adapter.dialect.sql;
  for (const statement of [
    "CREATE TABLE [sporades_team_billing_customers] ([teamId] TEXT PRIMARY KEY, [mode] TEXT NOT NULL, [providerCustomerId] TEXT NOT NULL UNIQUE, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL)",
    "CREATE TABLE [sporades_team_billing_subscriptions] ([id] TEXT PRIMARY KEY, [teamId] TEXT NOT NULL, [mode] TEXT NOT NULL, [providerSubscriptionId] TEXT NOT NULL UNIQUE, [providerPriceId] TEXT NOT NULL, [productKey] TEXT NOT NULL, [quantity] INTEGER NOT NULL, [state] TEXT NOT NULL, [cancelAtPeriodEnd] INTEGER NOT NULL, [currentPeriodEnd] TEXT NULL, [observedAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL)",
    "CREATE TABLE [sporades_team_billing_operations] ([id] TEXT PRIMARY KEY, [requestId] TEXT NOT NULL, [teamId] TEXT NOT NULL, [actorUserId] TEXT NOT NULL, [kind] TEXT NOT NULL, [productKey] TEXT NULL, [status] TEXT NOT NULL, [providerObjectId] TEXT NULL, [idempotencyKey] TEXT NOT NULL UNIQUE, [safeFailureCode] TEXT NULL, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL, UNIQUE ([teamId], [requestId]))",
    "CREATE TABLE [sporades_team_billing_observations] ([id] TEXT PRIMARY KEY, [teamId] TEXT NULL, [mode] TEXT NOT NULL, [providerEventId] TEXT NOT NULL UNIQUE, [providerObjectId] TEXT NULL, [payloadDigest] TEXT NOT NULL, [observedAt] TEXT NOT NULL, [createdAt] TEXT NOT NULL)",
    "CREATE TABLE [sporades_team_billing_replay] ([providerEventId] TEXT PRIMARY KEY, [payloadDigest] TEXT NOT NULL, [settledAt] TEXT NOT NULL, [retainedUntil] TEXT NOT NULL)",
  ]) {
    await adapter.exec(sql(statement));
  }
}
