import assert from "node:assert/strict";

const NOW = "2026-08-14T12:00:00.000Z";

async function count(adapter, statement, ...values) {
  const row = await adapter.prepare(adapter.dialect.sql(statement)).get(...values);
  return Number(row?.count ?? 0);
}

export const CONFORMANCE_SURFACE = {
  title: "Database adapter conformance (runtime Team storage)",
  appTableNames: [],
  cases: [
    {
      name: "ensureTeamsStorage creates empty writable runtime tables and preserves existing Team history",
      async run(adapter) {
        await adapter.ensureTeamsStorage();
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_teams]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_bootstrap]"), 0);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_membership_counters]"), 0);

        const sql = adapter.dialect.sql;
        await adapter.prepare(sql("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, ?, ?, ?)")).run("team-one", "My Team", NOW, "user-one");
        await adapter.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, ?, ?)")).run("team-one", "user-one", "admin", NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_bootstrap] ([userId], [teamId], [createdAt]) VALUES (?, ?, ?)")).run("user-one", "team-one", NOW);
        await adapter.prepare(sql("INSERT INTO [sporades_team_membership_counters] ([userId], [membershipCount]) VALUES (?, ?)")).run("user-one", 1);

        await adapter.ensureTeamsStorage();
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_teams] WHERE [id] = ?", "team-one"), 1);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?", "team-one", "user-one"), 1);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_bootstrap] WHERE [userId] = ? AND [teamId] = ?", "user-one", "team-one"), 1);
        assert.equal(await count(adapter, "SELECT COUNT(*) AS [count] FROM [sporades_team_membership_counters] WHERE [userId] = ? AND [membershipCount] = ?", "user-one", 1), 1);
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
  ],
};
