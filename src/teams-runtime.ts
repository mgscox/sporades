// Runtime-owned Teams foundation. Team state deliberately lives beside auth
// storage, never in a Capsule schema or the normal ctx.db API.
import { randomUUID } from "node:crypto";

import { requireAuth } from "./auth-runtime.js";
import { chainMaybePromise } from "./maybe-promise.js";
import { commandError } from "./runtime-errors.js";

type LooseRecord = Record<string, any>;

const INITIAL_TEAM_NAME = "My Team";
const TEAM_NAME_MAX_BYTES = 80;
const TEAM_MEMBER_COUNT_MAX = 99;
// A user's Team list is a compact navigation surface, never an unbounded
// directory. The cap applies to all memberships, including the initial Team.
export const TEAM_MEMBERSHIP_MAX = 25;
const TEAM_BOOTSTRAP_RETRY_LIMIT = 5;

export function createTeamTables(adapter: LooseRecord) {
  const sql = adapter.dialect.sql;
  // Runtime storage DDL is ordered for every adapter, matching auth and file
  // storage bootstrap: a later table is never attempted after an earlier error.
  return chainMaybePromise([
    () => adapter.exec(sql(
      "CREATE TABLE IF NOT EXISTS [sporades_teams] (" +
      "[id] TEXT PRIMARY KEY, [name] TEXT NOT NULL, [createdAt] TEXT NOT NULL, [createdByUserId] TEXT NOT NULL" +
      ")",
    )),
    () => adapter.exec(sql(
      "CREATE TABLE IF NOT EXISTS [sporades_team_memberships] (" +
      "[teamId] TEXT NOT NULL, [userId] TEXT NOT NULL, [role] TEXT NOT NULL, [createdAt] TEXT NOT NULL, " +
      "PRIMARY KEY ([teamId], [userId])" +
      ")",
    )),
    () => adapter.exec(sql(
      "CREATE TABLE IF NOT EXISTS [sporades_team_bootstrap] (" +
      "[userId] TEXT PRIMARY KEY, [teamId] TEXT NOT NULL, [createdAt] TEXT NOT NULL" +
      ")",
    )),
    () => adapter.exec(sql(
      "CREATE TABLE IF NOT EXISTS [sporades_team_membership_counters] (" +
      "[userId] TEXT PRIMARY KEY, [membershipCount] INTEGER NOT NULL" +
      ")",
    )),
  ]);
}

export function createCurrentUserTeamsApi(database: LooseRecord, auth: LooseRecord, contextGetter?: () => LooseRecord) {
  return {
    async list() {
      requireAuth({ auth }, { linked: true });
      return listCurrentUserTeams(database, auth);
    },
    async create(name: any) {
      requireAuth({ auth }, { linked: true });
      return createAdditionalTeam(database, auth, name, contextGetter?.());
    },
    async rename(teamId: any, name: any) {
      requireAuth({ auth }, { linked: true });
      return renameCurrentUserTeam(database, auth, teamId, name, contextGetter?.());
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

export async function createAdditionalTeam(database: LooseRecord, auth: LooseRecord, name: any, eventContext?: LooseRecord) {
  requireAuth({ auth }, { linked: true });
  const normalizedName = normalizeTeamName(name);
  const team = await withTeamTransaction(database, async (tx) => {
    await ensureInitialTeamOnAdapter(tx, auth.userId);
    await ensureMembershipCounterOnAdapter(tx, auth.userId);
    const claim = await tx.prepare(tx.dialect.sql(
      "UPDATE [sporades_team_membership_counters] SET [membershipCount] = [membershipCount] + 1 " +
      "WHERE [userId] = ? AND [membershipCount] < ?",
    )).run(auth.userId, TEAM_MEMBERSHIP_MAX);
    if (Number(claim?.changes ?? 0) !== 1) {
      throw commandError(
        "Team limit reached.",
        `A user can belong to at most ${TEAM_MEMBERSHIP_MAX} Teams.`,
        "TEAM_LIMIT_REACHED",
      );
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    await tx.prepare(tx.dialect.sql(
      "INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, ?, ?, ?)",
    )).run(id, normalizedName, now, auth.userId);
    await tx.prepare(tx.dialect.sql(
      "INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'admin', ?)",
    )).run(id, auth.userId, now);
    return teamSummary({ id, name: normalizedName, role: "admin", memberCount: 1 });
  });
  emitTeamSecurityEvent(database, eventContext, "teams.created", auth.userId, team.id);
  return { team };
}

export async function renameCurrentUserTeam(database: LooseRecord, auth: LooseRecord, teamId: any, name: any, eventContext?: LooseRecord) {
  requireAuth({ auth }, { linked: true });
  if (!isOpaqueTeamId(teamId)) throw teamDenied();
  const normalizedName = normalizeTeamName(name);
  const team = await withTeamTransaction(database, async (tx) => {
    const membership = await tx.prepare(tx.dialect.sql(
      "SELECT [role] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?",
    )).get(teamId, auth.userId);
    // Deliberately merge absent Teams, non-members, and ordinary members into
    // one public denial. No name or membership state escapes this boundary.
    if (membership?.role !== "admin") throw teamDenied();
    const changed = await tx.prepare(tx.dialect.sql(
      "UPDATE [sporades_teams] SET [name] = ? WHERE [id] = ?",
    )).run(normalizedName, teamId);
    if (Number(changed?.changes ?? 0) !== 1) throw teamDenied();
    const count = await tx.prepare(tx.dialect.sql(
      "SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ?",
    )).get(teamId);
    return teamSummary({ id: teamId, name: normalizedName, role: "admin", memberCount: Number(count?.count ?? 0) });
  });
  emitTeamSecurityEvent(database, eventContext, "teams.renamed", auth.userId, team.id);
  return { team };
}

async function ensureInitialTeam(database: LooseRecord, auth: LooseRecord) {
  if (database.__transactionActive) {
    return ensureInitialTeamOnAdapter(database.adapter, auth.userId);
  }
  // node:sqlite has one connection, so two simultaneous BEGIN calls fail
  // before the durable bootstrap uniqueness claim can arbitrate. Queue every
  // bootstrap and Auth links on this runtime; the database key remains the
  // cross-runtime guard.
  const root = database.__rootDatabase ?? database;
  root.__teamBootstrapByUser ??= new Map();
  const running = root.__teamBootstrapByUser.get(auth.userId);
  if (running) return running;
  const previous = root.__runtimeTransactionQueue ?? Promise.resolve();
  const work = previous.catch(() => undefined).then(() => bootstrapWithRetry(database.adapter, auth.userId));
  root.__runtimeTransactionQueue = work;
  root.__teamBootstrapByUser.set(auth.userId, work);
  try {
    return await work;
  } finally {
    if (root.__teamBootstrapByUser.get(auth.userId) === work) root.__teamBootstrapByUser.delete(auth.userId);
    if (root.__runtimeTransactionQueue === work) root.__runtimeTransactionQueue = null;
  }
}

async function withTeamTransaction(database: LooseRecord, callback: (tx: LooseRecord) => Promise<any>) {
  if (database.__transactionActive) return callback(database.adapter);
  // Share Ticket 01's runtime queue: node:sqlite has one connection, and Team
  // operations must not race a lazy/bootstrap auth transaction into BEGIN.
  const root = database.__rootDatabase ?? database;
  const previous = root.__runtimeTransactionQueue ?? Promise.resolve();
  const work = previous.catch(() => undefined).then(() => teamTransactionWithRetry(database.adapter, callback));
  root.__runtimeTransactionQueue = work;
  try {
    return await work;
  } finally {
    if (root.__runtimeTransactionQueue === work) root.__runtimeTransactionQueue = null;
  }
}

async function teamTransactionWithRetry(adapter: LooseRecord, callback: (tx: LooseRecord) => Promise<any>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await adapter.withTransaction(callback);
    } catch (error) {
      if (attempt >= TEAM_BOOTSTRAP_RETRY_LIMIT - 1 || !isTransientTeamBootstrapError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 10));
    }
  }
}

async function bootstrapWithRetry(adapter: LooseRecord, userId: any) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await adapter.withTransaction((tx: LooseRecord) => ensureInitialTeamOnAdapter(tx, userId));
    } catch (error) {
      if (attempt >= TEAM_BOOTSTRAP_RETRY_LIMIT - 1 || !isTransientTeamBootstrapError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 10));
    }
  }
}

function isTransientTeamBootstrapError(error: any) {
  const text = String(error?.message ?? error?.errstr ?? "").toLowerCase();
  const code = String(error?.code ?? "").toUpperCase();
  return (code === "ERR_SQLITE_ERROR" || code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") &&
    (text.includes("locked") || text.includes("busy") || code === "SQLITE_BUSY" || code === "SQLITE_LOCKED");
}

// Auth account-linking calls this inside its existing Auth transaction. Keeping
// the transaction-aware primitive here gives email and every OAuth provider one
// Team bootstrap implementation while Ticket 01's lazy path remains intact.
export async function bootstrapInitialTeamForLinkedUser(tx: LooseRecord, userId: any) {
  return ensureInitialTeamOnAdapter(tx, userId);
}

async function ensureInitialTeamOnAdapter(tx: LooseRecord, userId: any) {
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
  )).run(userId, id, now);
  if (Number(claim?.changes ?? 0) === 0) {
    const existing = await tx.prepare(sql("SELECT [teamId] FROM [sporades_team_bootstrap] WHERE [userId] = ?")).get(userId);
    if (existing?.teamId) return String(existing.teamId);
    throw new Error("Team bootstrap claim was not committed.");
  }
  await tx.prepare(sql("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, ?, ?, ?)")).run(id, INITIAL_TEAM_NAME, now, userId);
  await tx.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'admin', ?)")).run(id, userId, now);
  await tx.prepare(sql("INSERT INTO [sporades_team_membership_counters] ([userId], [membershipCount]) VALUES (?, 1)")).run(userId);
  return id;
}

async function ensureMembershipCounterOnAdapter(tx: LooseRecord, userId: any) {
  const sql = tx.dialect.sql;
  // Ticket 01 rows can predate this counter. The insert backfills exactly once;
  // the guarded UPDATE above is the durable, cross-runtime admission claim.
  await tx.prepare(sql(
    "INSERT INTO [sporades_team_membership_counters] ([userId], [membershipCount]) " +
    "SELECT ?, COUNT(*) FROM [sporades_team_memberships] WHERE [userId] = ? " +
    "ON CONFLICT ([userId]) DO NOTHING",
  )).run(userId, userId);
}

function safeTeamName(value: any) {
  const name = typeof value === "string" ? value.trim() : "";
  return Buffer.byteLength(name, "utf8") <= TEAM_NAME_MAX_BYTES && name.length > 0 ? name : INITIAL_TEAM_NAME;
}

function normalizeTeamName(value: any) {
  if (typeof value !== "string") {
    throw commandError("Team name is required.", "Provide a non-empty Team name.", "INVALID_TEAM_NAME");
  }
  const name = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (name.length === 0 || Buffer.byteLength(name, "utf8") > TEAM_NAME_MAX_BYTES) {
    throw commandError(
      "Team name is invalid.",
      `Use a non-empty Team name up to ${TEAM_NAME_MAX_BYTES} UTF-8 bytes.`,
      "INVALID_TEAM_NAME",
    );
  }
  return name;
}

function isOpaqueTeamId(value: any) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function teamDenied() {
  return commandError("Team operation denied.", "Sign in with a Team administrator account and retry.", "DENIED");
}

function teamSummary(input: LooseRecord) {
  return {
    id: String(input.id),
    name: safeTeamName(input.name),
    role: input.role === "admin" ? "admin" : "member",
    applicationRoles: [],
    memberCount: Math.min(TEAM_MEMBER_COUNT_MAX, Math.max(0, Number(input.memberCount) || 0)),
  };
}

function emitTeamSecurityEvent(database: LooseRecord, eventContext: LooseRecord | undefined, event: string, actorUserId: any, teamId: any) {
  // Keep audit data identifier-only and bounded: names can contain sensitive
  // presentation text, while Sessions and provider records never belong here.
  const input = {
    category: "audit",
    event,
    level: "info",
    message: event === "teams.created" ? "Team created." : "Team renamed.",
    data: { actorUserId: String(actorUserId).slice(0, 128), teamId: String(teamId).slice(0, 64) },
    request: null,
    release: null,
    correlation: null,
  };
  if (database.__transactionActive && eventContext) {
    eventContext.__teamSecurityEvents ??= [];
    eventContext.__teamSecurityEvents.push(input);
    return;
  }
  database.log?.emit?.(input);
}

export function flushTeamSecurityEvents(database: LooseRecord, context: LooseRecord | undefined) {
  const events = context?.__teamSecurityEvents;
  if (!Array.isArray(events)) return;
  if (!context) return;
  delete context.__teamSecurityEvents;
  for (const event of events) database.log?.emit?.(event);
}
