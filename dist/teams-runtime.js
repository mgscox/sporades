// Runtime-owned Teams foundation. Team state deliberately lives beside auth
// storage, never in a Capsule schema or the normal ctx.db API.
import { randomUUID } from "node:crypto";
import { requireAuth } from "./auth-runtime.js";
import { chainMaybePromise } from "./maybe-promise.js";
const INITIAL_TEAM_NAME = "My Team";
const TEAM_NAME_MAX_BYTES = 80;
const TEAM_MEMBER_COUNT_MAX = 99;
const TEAM_BOOTSTRAP_RETRY_LIMIT = 5;
export function createTeamTables(adapter) {
    const sql = adapter.dialect.sql;
    // Runtime storage DDL is ordered for every adapter, matching auth and file
    // storage bootstrap: a later table is never attempted after an earlier error.
    return chainMaybePromise([
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_teams] (" +
            "[id] TEXT PRIMARY KEY, [name] TEXT NOT NULL, [createdAt] TEXT NOT NULL, [createdByUserId] TEXT NOT NULL" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_memberships] (" +
            "[teamId] TEXT NOT NULL, [userId] TEXT NOT NULL, [role] TEXT NOT NULL, [createdAt] TEXT NOT NULL, " +
            "PRIMARY KEY ([teamId], [userId])" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_bootstrap] (" +
            "[userId] TEXT PRIMARY KEY, [teamId] TEXT NOT NULL, [createdAt] TEXT NOT NULL" +
            ")")),
    ]);
}
export function createCurrentUserTeamsApi(database, auth) {
    return {
        async list() {
            requireAuth({ auth }, { linked: true });
            return listCurrentUserTeams(database, auth);
        },
    };
}
export async function listCurrentUserTeams(database, auth) {
    requireAuth({ auth }, { linked: true });
    await ensureInitialTeam(database, auth);
    const sql = database.adapter.dialect.sql;
    const rows = await database.adapter.prepare(sql("SELECT [t].[id], [t].[name], [m].[role], " +
        "CASE WHEN (SELECT COUNT(*) FROM [sporades_team_memberships] [counted] WHERE [counted].[teamId] = [t].[id]) > ? " +
        "THEN ? ELSE (SELECT COUNT(*) FROM [sporades_team_memberships] [counted] WHERE [counted].[teamId] = [t].[id]) END AS [memberCount] " +
        "FROM [sporades_team_memberships] [m] JOIN [sporades_teams] [t] ON [t].[id] = [m].[teamId] " +
        "WHERE [m].[userId] = ? ORDER BY [t].[createdAt] ASC, [t].[id] ASC")).all(TEAM_MEMBER_COUNT_MAX, TEAM_MEMBER_COUNT_MAX, auth.userId);
    return {
        teams: rows.map((row) => ({
            id: String(row.id),
            name: safeTeamName(row.name),
            role: row.role === "admin" ? "admin" : "member",
            applicationRoles: [],
            memberCount: Math.min(TEAM_MEMBER_COUNT_MAX, Math.max(0, Number(row.memberCount) || 0)),
        })),
    };
}
async function ensureInitialTeam(database, auth) {
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
    if (running)
        return running;
    const previous = root.__runtimeTransactionQueue ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => bootstrapWithRetry(database.adapter, auth.userId));
    root.__runtimeTransactionQueue = work;
    root.__teamBootstrapByUser.set(auth.userId, work);
    try {
        return await work;
    }
    finally {
        if (root.__teamBootstrapByUser.get(auth.userId) === work)
            root.__teamBootstrapByUser.delete(auth.userId);
        if (root.__runtimeTransactionQueue === work)
            root.__runtimeTransactionQueue = null;
    }
}
async function bootstrapWithRetry(adapter, userId) {
    for (let attempt = 0;; attempt += 1) {
        try {
            return await adapter.withTransaction((tx) => ensureInitialTeamOnAdapter(tx, userId));
        }
        catch (error) {
            if (attempt >= TEAM_BOOTSTRAP_RETRY_LIMIT - 1 || !isTransientTeamBootstrapError(error))
                throw error;
            await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 10));
        }
    }
}
function isTransientTeamBootstrapError(error) {
    const text = String(error?.message ?? error?.errstr ?? "").toLowerCase();
    const code = String(error?.code ?? "").toUpperCase();
    return (code === "ERR_SQLITE_ERROR" || code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") &&
        (text.includes("locked") || text.includes("busy") || code === "SQLITE_BUSY" || code === "SQLITE_LOCKED");
}
// Auth account-linking calls this inside its existing Auth transaction. Keeping
// the transaction-aware primitive here gives email and every OAuth provider one
// Team bootstrap implementation while Ticket 01's lazy path remains intact.
export async function bootstrapInitialTeamForLinkedUser(tx, userId) {
    return ensureInitialTeamOnAdapter(tx, userId);
}
async function ensureInitialTeamOnAdapter(tx, userId) {
    const sql = tx.dialect.sql;
    const id = randomUUID();
    const now = new Date().toISOString();
    // Claim bootstrap history first. The unique user key is the concurrency
    // guard; a failed transaction rolls the claim back with its Team/membership.
    // `DO NOTHING` matters on Postgres: catching a uniqueness exception would
    // leave that transaction aborted before it could read the winner's Team.
    const claim = await tx.prepare(sql("INSERT INTO [sporades_team_bootstrap] ([userId], [teamId], [createdAt]) VALUES (?, ?, ?) " +
        "ON CONFLICT ([userId]) DO NOTHING")).run(userId, id, now);
    if (Number(claim?.changes ?? 0) === 0) {
        const existing = await tx.prepare(sql("SELECT [teamId] FROM [sporades_team_bootstrap] WHERE [userId] = ?")).get(userId);
        if (existing?.teamId)
            return String(existing.teamId);
        throw new Error("Team bootstrap claim was not committed.");
    }
    await tx.prepare(sql("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, ?, ?, ?)")).run(id, INITIAL_TEAM_NAME, now, userId);
    await tx.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'admin', ?)")).run(id, userId, now);
    return id;
}
function safeTeamName(value) {
    const name = typeof value === "string" ? value.trim() : "";
    return Buffer.byteLength(name, "utf8") <= TEAM_NAME_MAX_BYTES && name.length > 0 ? name : INITIAL_TEAM_NAME;
}
//# sourceMappingURL=teams-runtime.js.map