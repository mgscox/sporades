// Runtime-owned Teams foundation. Team state deliberately lives beside auth
// storage, never in a Capsule schema or the normal ctx.db API.
import { randomUUID } from "node:crypto";

import { requireAuth } from "./auth-runtime.js";

type LooseRecord = Record<string, any>;

const INITIAL_TEAM_NAME = "My Team";
const TEAM_NAME_MAX_BYTES = 80;
const TEAM_MEMBER_COUNT_MAX = 99;

export function createTeamTables(adapter: LooseRecord) {
  const sql = adapter.dialect.sql;
  return Promise.all([
    adapter.exec(sql(
      "CREATE TABLE IF NOT EXISTS [sporades_teams] (" +
      "[id] TEXT PRIMARY KEY, [name] TEXT NOT NULL, [createdAt] TEXT NOT NULL, [createdByUserId] TEXT NOT NULL" +
      ")",
    )),
    adapter.exec(sql(
      "CREATE TABLE IF NOT EXISTS [sporades_team_memberships] (" +
      "[teamId] TEXT NOT NULL, [userId] TEXT NOT NULL, [role] TEXT NOT NULL, [createdAt] TEXT NOT NULL, " +
      "PRIMARY KEY ([teamId], [userId])" +
      ")",
    )),
    adapter.exec(sql(
      "CREATE TABLE IF NOT EXISTS [sporades_team_bootstrap] (" +
      "[userId] TEXT PRIMARY KEY, [teamId] TEXT NOT NULL, [createdAt] TEXT NOT NULL" +
      ")",
    )),
  ]);
}

export function createCurrentUserTeamsApi(database: LooseRecord, auth: LooseRecord) {
  return {
    async list() {
      requireAuth({ auth }, { linked: true });
      return listCurrentUserTeams(database, auth);
    },
  };
}

export async function listCurrentUserTeams(database: LooseRecord, auth: LooseRecord) {
  requireAuth({ auth }, { linked: true });
  await ensureInitialTeam(database, auth);
  const sql = database.adapter.dialect.sql;
  const rows = await database.adapter.prepare(sql(
    "SELECT [t].[id], [t].[name], [m].[role], " +
    "CASE WHEN (SELECT COUNT(*) FROM [sporades_team_memberships] [counted] WHERE [counted].[teamId] = [t].[id]) > ? " +
    "THEN ? ELSE (SELECT COUNT(*) FROM [sporades_team_memberships] [counted] WHERE [counted].[teamId] = [t].[id]) END AS [memberCount] " +
    "FROM [sporades_team_memberships] [m] JOIN [sporades_teams] [t] ON [t].[id] = [m].[teamId] " +
    "WHERE [m].[userId] = ? ORDER BY [t].[createdAt] ASC, [t].[id] ASC",
  )).all(TEAM_MEMBER_COUNT_MAX, TEAM_MEMBER_COUNT_MAX, auth.userId);
  return {
    teams: rows.map((row: LooseRecord) => ({
      id: String(row.id),
      name: safeTeamName(row.name),
      role: row.role === "admin" ? "admin" : "member",
      applicationRoles: [],
      memberCount: Math.min(TEAM_MEMBER_COUNT_MAX, Math.max(0, Number(row.memberCount) || 0)),
    })),
  };
}

async function ensureInitialTeam(database: LooseRecord, auth: LooseRecord) {
  if (database.__transactionActive) {
    return ensureInitialTeamOnAdapter(database.adapter, auth);
  }
  return database.adapter.withTransaction((tx: LooseRecord) => ensureInitialTeamOnAdapter(tx, auth));
}

async function ensureInitialTeamOnAdapter(tx: LooseRecord, auth: LooseRecord) {
  const sql = tx.dialect.sql;
  const id = randomUUID();
  const now = new Date().toISOString();
  // Claim bootstrap history first. The unique user key is the concurrency
  // guard; a failed transaction rolls the claim back with its Team/membership.
  // `DO NOTHING` matters on Postgres: catching a uniqueness exception would
  // leave that transaction aborted before it could read the winner's Team.
  const claim = await tx.prepare(sql(
    "INSERT INTO [sporades_team_bootstrap] ([userId], [teamId], [createdAt]) VALUES (?, ?, ?) " +
    "ON CONFLICT ([userId]) DO NOTHING",
  )).run(auth.userId, id, now);
  if (Number(claim?.changes ?? 0) === 0) {
    const existing = await tx.prepare(sql("SELECT [teamId] FROM [sporades_team_bootstrap] WHERE [userId] = ?")).get(auth.userId);
    if (existing?.teamId) return String(existing.teamId);
    throw new Error("Team bootstrap claim was not committed.");
  }
  await tx.prepare(sql("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, ?, ?, ?)")).run(id, INITIAL_TEAM_NAME, now, auth.userId);
  await tx.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'admin', ?)")).run(id, auth.userId, now);
  return id;
}

function safeTeamName(value: any) {
  const name = typeof value === "string" ? value.trim() : "";
  return Buffer.byteLength(name, "utf8") <= TEAM_NAME_MAX_BYTES && name.length > 0 ? name : INITIAL_TEAM_NAME;
}
