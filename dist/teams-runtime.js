// Runtime-owned Teams foundation. Team state deliberately lives beside auth
// storage, never in a Capsule schema or the normal ctx.db API.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { requireAuth } from "./auth-runtime.js";
import { chainMaybePromise } from "./maybe-promise.js";
import { commandError } from "./runtime-errors.js";
import { normalizeOrigin } from "./http-runtime.js";
const INITIAL_TEAM_NAME = "My Team";
const TEAM_NAME_MAX_BYTES = 80;
const TEAM_MEMBER_COUNT_MAX = 99;
// Membership lists are a management surface, not a directory export. Keep the
// response bounded even when a Team has more members than its UI renders.
export const TEAM_MEMBER_LIST_MAX = 100;
// A user's Team list is a compact navigation surface, never an unbounded
// directory. The cap applies to all memberships, including the initial Team.
export const TEAM_MEMBERSHIP_MAX = 25;
const TEAM_BOOTSTRAP_RETRY_LIMIT = 5;
export const TEAM_JOIN_LINK_DEFAULT_TTL_SECONDS = 60 * 60 * 24;
export const TEAM_JOIN_LINK_MIN_TTL_SECONDS = 5 * 60;
export const TEAM_JOIN_LINK_MAX_TTL_SECONDS = 60 * 60 * 24 * 7;
export const TEAM_JOIN_LINK_MAX_OUTSTANDING = 20;
export const TEAM_JOIN_LINK_CREATION_MAX_PER_HOUR = 10;
const TEAM_JOIN_LINK_PRUNE_LIMIT = 100;
const TEAM_JOIN_LINK_SECRET_ID = "v1";
export const TEAM_APPLICATION_ROLE_MAX = 32;
export const TEAM_APPLICATION_ROLE_PATCH_MAX = 16;
const TEAM_APPLICATION_ROLE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
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
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_membership_application_roles] (" +
            "[teamId] TEXT NOT NULL, [userId] TEXT NOT NULL, [role] TEXT NOT NULL, [createdAt] TEXT NOT NULL, " +
            "PRIMARY KEY ([teamId], [userId], [role])" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_bootstrap] (" +
            "[userId] TEXT PRIMARY KEY, [teamId] TEXT NOT NULL, [createdAt] TEXT NOT NULL" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_membership_counters] (" +
            "[userId] TEXT PRIMARY KEY, [membershipCount] INTEGER NOT NULL" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_join_link_secrets] (" +
            "[id] TEXT PRIMARY KEY, [secret] TEXT NOT NULL, [createdAt] TEXT NOT NULL" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_join_links] (" +
            "[id] TEXT PRIMARY KEY, [selector] TEXT NOT NULL UNIQUE, [verifierHash] TEXT NOT NULL, [teamId] TEXT NOT NULL, " +
            "[email] TEXT NOT NULL, [createdByUserId] TEXT NOT NULL, [createdAt] TEXT NOT NULL, [expiresAt] TEXT NOT NULL, " +
            "[consumedAt] TEXT NULL, [revokedAt] TEXT NULL" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_join_link_throttles] (" +
            "[teamId] TEXT NOT NULL, [adminUserId] TEXT NOT NULL, [windowStartedAt] TEXT NOT NULL, [count] INTEGER NOT NULL, " +
            "PRIMARY KEY ([teamId], [adminUserId])" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_join_link_counters] (" +
            "[teamId] TEXT PRIMARY KEY, [activeCount] INTEGER NOT NULL" +
            ")")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_team_join_link_redemptions] (" +
            "[joinLinkId] TEXT PRIMARY KEY, [teamId] TEXT NOT NULL, [userId] TEXT NOT NULL, [createdAt] TEXT NOT NULL" +
            ")")),
    ]);
}
export function createCurrentUserTeamsApi(database, auth, contextGetter) {
    return {
        async list() {
            requireAuth({ auth }, { linked: true });
            return listCurrentUserTeams(database, auth);
        },
        async create(name) {
            requireAuth({ auth }, { linked: true });
            return createAdditionalTeam(database, auth, name, contextGetter?.());
        },
        async rename(teamId, name) {
            requireAuth({ auth }, { linked: true });
            return renameCurrentUserTeam(database, auth, teamId, name, contextGetter?.());
        },
        async listMembers(teamId) {
            requireAuth({ auth }, { linked: true });
            return listTeamMembers(database, auth, teamId);
        },
        async updateApplicationRoles(teamId, userId, changes) {
            requireAuth({ auth }, { linked: true });
            return updateTeamMemberApplicationRoles(database, auth, teamId, userId, changes, contextGetter?.());
        },
        async createJoinLink(teamId, email, options = {}) {
            requireAuth({ auth }, { linked: true });
            return createTeamJoinLink(database, auth, teamId, email, options, contextGetter?.());
        },
        async listJoinLinks(teamId) {
            requireAuth({ auth }, { linked: true });
            return listTeamJoinLinks(database, auth, teamId);
        },
        async revokeJoinLink(teamId, joinLinkId) {
            requireAuth({ auth }, { linked: true });
            return revokeTeamJoinLink(database, auth, teamId, joinLinkId, contextGetter?.());
        },
        async inspectJoinLink(code) {
            return inspectTeamJoinLink(database, code);
        },
        async validateJoinLink(code) {
            return validateTeamJoinLink(database, auth, code);
        },
        async join(code) {
            return joinCurrentUserTeam(database, auth, code, contextGetter?.());
        },
        async promote(teamId, userId) {
            requireAuth({ auth }, { linked: true });
            return promoteTeamMember(database, auth, teamId, userId, contextGetter?.());
        },
        async demote(teamId, userId) {
            requireAuth({ auth }, { linked: true });
            return demoteTeamMember(database, auth, teamId, userId, contextGetter?.());
        },
        async removeMember(teamId, userId) {
            requireAuth({ auth }, { linked: true });
            return removeTeamMember(database, auth, teamId, userId, contextGetter?.());
        },
        async leave(teamId) {
            requireAuth({ auth }, { linked: true });
            return leaveCurrentUserTeam(database, auth, teamId, contextGetter?.());
        },
        async delete(teamId) {
            requireAuth({ auth }, { linked: true });
            return deleteCurrentUserTeam(database, auth, teamId, contextGetter?.());
        },
    };
}
export function resolveTeamJoinLinkConfig(config) {
    const join = config?.teams?.join ?? {};
    const port = typeof config?.dev?.port === "number"
        ? config.dev.port : typeof config?.deploy?.port === "number" ? config.deploy.port : 4000;
    return {
        path: normalizeTeamJoinPath(join.path) ?? "/join",
        origin: normalizeOrigin(config?.__sporadesPublicOrigin) ?? `http://localhost:${port}`,
    };
}
export function normalizeTeamJoinPath(value) {
    if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//"))
        return null;
    if (value.includes("\\") || value.includes("?") || value.includes("#") || value.split("/").includes(".."))
        return null;
    return value;
}
/**
 * Validate the Capsule-owned vocabulary once at load time. These identifiers
 * are application authority labels, not runtime identities: management roles
 * and the entire Sporades namespace remain unavailable to Capsules.
 */
export function normalizeTeamApplicationRoles(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.length > TEAM_APPLICATION_ROLE_MAX)
        throw invalidTeamApplicationRoleDeclaration();
    const roles = [];
    const seen = new Set();
    for (const role of value) {
        if (typeof role !== "string" || !TEAM_APPLICATION_ROLE_PATTERN.test(role) || role === "admin" || role === "member" || role.startsWith("sporades-")) {
            throw invalidTeamApplicationRoleDeclaration();
        }
        if (seen.has(role))
            throw invalidTeamApplicationRoleDeclaration();
        seen.add(role);
        roles.push(role);
    }
    return roles;
}
export async function createTeamJoinLink(database, auth, teamId, email, options = {}, eventContext) {
    requireAuth({ auth }, { linked: true });
    let created;
    try {
        if (!isOpaqueTeamId(teamId))
            throw teamDenied();
        const normalizedEmail = normalizeTeamJoinEmail(email);
        const ttlSeconds = normalizeTeamJoinTtl(options?.ttlSeconds);
        created = await withTeamTransaction(database, async (tx) => {
            // Deletion uses the same Team row lock. Take it before authorization so
            // a stale admin cannot issue state for a Team that has just gone away.
            await lockTeamLifecycle(tx, teamId);
            if (!await currentTeamAdmin(tx, teamId, auth.userId))
                throw teamDenied();
            const now = database.clock?.now?.() ?? new Date();
            const nowIso = now.toISOString();
            await pruneExpiredTeamJoinLinks(tx, nowIso);
            await reconcileTeamJoinLinkCapacity(tx, teamId, nowIso);
            await claimTeamJoinLinkCreationSlot(tx, teamId, auth.userId, nowIso);
            await claimTeamJoinLinkCapacity(tx, teamId, nowIso);
            const secret = await teamJoinSigningSecret(tx, nowIso);
            const id = randomUUID();
            const selector = randomBytes(16).toString("base64url");
            const verifier = randomBytes(32).toString("base64url");
            const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
            const signature = teamJoinSignature(secret, id, selector, verifier, expiresAt);
            await tx.prepare(tx.dialect.sql("INSERT INTO [sporades_team_join_links] ([id], [selector], [verifierHash], [teamId], [email], [createdByUserId], [createdAt], [expiresAt], [consumedAt], [revokedAt]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)")).run(id, selector, hashTeamJoinVerifier(verifier), teamId, normalizedEmail, auth.userId, nowIso, expiresAt);
            return { id, code: `v1.${selector}.${verifier}.${signature}`, createdAt: nowIso, expiresAt };
        });
    }
    catch (error) {
        emitTeamSecurityEvent(database, eventContext, "teams.joinLink.create", auth.userId, isOpaqueTeamId(teamId) ? teamId : null, "denied", String(error?.code ?? "DENIED"));
        throw error;
    }
    const link = new URL(database.teamJoinLinkConfig.path, database.teamJoinLinkConfig.origin);
    link.searchParams.set("code", created.code);
    emitTeamSecurityEvent(database, eventContext, "teams.joinLink.created", auth.userId, teamId, "succeeded", "TEAM_JOIN_LINK_CREATED");
    return { id: created.id, link: link.toString(), createdAt: created.createdAt, expiresAt: created.expiresAt };
}
export async function listTeamJoinLinks(database, auth, teamId) {
    requireAuth({ auth }, { linked: true });
    if (!isOpaqueTeamId(teamId))
        throw teamDenied();
    return withTeamTransaction(database, async (tx) => {
        if (!await currentTeamAdmin(tx, teamId, auth.userId))
            throw teamDenied();
        const now = (database.clock?.now?.() ?? new Date()).toISOString();
        await pruneExpiredTeamJoinLinks(tx, now);
        const rows = await tx.prepare(tx.dialect.sql("SELECT [id], [email], [createdAt], [expiresAt] FROM [sporades_team_join_links] WHERE [teamId] = ? AND [expiresAt] > ? AND [consumedAt] IS NULL AND [revokedAt] IS NULL ORDER BY [createdAt] ASC, [id] ASC LIMIT ?")).all(teamId, now, TEAM_JOIN_LINK_MAX_OUTSTANDING);
        return { links: rows.map((row) => ({ id: String(row.id), email: String(row.email), createdAt: String(row.createdAt), expiresAt: String(row.expiresAt) })) };
    });
}
export async function revokeTeamJoinLink(database, auth, teamId, joinLinkId, eventContext) {
    requireAuth({ auth }, { linked: true });
    if (!isOpaqueTeamId(teamId) || !isOpaqueTeamId(joinLinkId)) {
        emitTeamSecurityEvent(database, eventContext, "teams.joinLink.revoke", auth.userId, null, "denied", "DENIED");
        throw teamDenied();
    }
    await withTeamTransaction(database, async (tx) => {
        // Keep revocation linearized with Team deletion and re-check authority
        // after the lock: a previously-admin caller may have been demoted while
        // waiting for another lifecycle operation to commit.
        await lockTeamLifecycle(tx, teamId);
        if (!await currentTeamAdmin(tx, teamId, auth.userId)) {
            emitTeamSecurityEvent(database, eventContext, "teams.joinLink.revoke", auth.userId, teamId, "denied", "DENIED");
            throw teamDenied();
        }
        const now = (database.clock?.now?.() ?? new Date()).toISOString();
        const changed = await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_join_links] SET [revokedAt] = ? WHERE [id] = ? AND [teamId] = ? AND [consumedAt] IS NULL AND [revokedAt] IS NULL AND [expiresAt] > ?")).run(now, joinLinkId, teamId, now);
        if (Number(changed?.changes ?? 0) === 1)
            await releaseTeamJoinLinkCapacity(tx, teamId);
    });
    emitTeamSecurityEvent(database, eventContext, "teams.joinLink.revoked", auth.userId, teamId, "succeeded", "TEAM_JOIN_LINK_REVOKED");
    return { revoked: true };
}
export async function inspectTeamJoinLink(database, code) {
    const parsed = parseTeamJoinCode(code);
    if (!parsed)
        return { team: null, expiresAt: null, usable: false };
    const row = await database.adapter.prepare(database.adapter.dialect.sql("SELECT [id], [selector], [verifierHash], [teamId], [expiresAt], [consumedAt], [revokedAt] FROM [sporades_team_join_links] WHERE [selector] = ?")).get(parsed.selector);
    const secretRow = await database.adapter.prepare(database.adapter.dialect.sql("SELECT [secret] FROM [sporades_team_join_link_secrets] WHERE [id] = ?")).get(TEAM_JOIN_LINK_SECRET_ID);
    const expectedVerifier = Buffer.from(row?.verifierHash ?? hashTeamJoinVerifier("\0absent"), "base64url");
    const actualVerifier = Buffer.from(hashTeamJoinVerifier(parsed.verifier), "base64url");
    const expectedSignature = Buffer.from(row && secretRow ? teamJoinSignature(String(secretRow.secret), String(row.id), parsed.selector, parsed.verifier, String(row.expiresAt)) : teamJoinSignature("absent", "absent", parsed.selector, parsed.verifier, "absent"), "base64url");
    const actualSignature = Buffer.from(parsed.signature, "base64url");
    const verifierMatches = actualVerifier.length === expectedVerifier.length && timingSafeEqual(actualVerifier, expectedVerifier);
    const signatureMatches = actualSignature.length === expectedSignature.length && timingSafeEqual(actualSignature, expectedSignature);
    const now = (database.clock?.now?.() ?? new Date()).getTime();
    const usable = Boolean(row && verifierMatches && signatureMatches && !row.consumedAt && !row.revokedAt && Date.parse(row.expiresAt) > now);
    if (!usable)
        return { team: null, expiresAt: null, usable: false };
    const team = await database.adapter.prepare(database.adapter.dialect.sql("SELECT [id], [name] FROM [sporades_teams] WHERE [id] = ?")).get(row.teamId);
    if (!team)
        return { team: null, expiresAt: null, usable: false };
    return { team: { id: String(team.id), name: safeTeamName(team.name) }, expiresAt: String(row.expiresAt), usable: true };
}
// Post-auth validation is deliberately read-only. It proves only that this
// current linked user owns an attached email matching an active capability;
// Ticket 07 owns membership creation and capability consumption.
export async function validateTeamJoinLink(database, auth, code) {
    if (!auth?.isAuthenticated || auth?.isGuest || typeof auth.userId !== "string" || !auth.userId)
        return { valid: false };
    const parsed = parseTeamJoinCode(code);
    if (!parsed)
        return { valid: false };
    const row = await database.adapter.prepare(database.adapter.dialect.sql("SELECT [id], [teamId], [verifierHash], [email], [expiresAt], [consumedAt], [revokedAt] FROM [sporades_team_join_links] WHERE [selector] = ?")).get(parsed.selector);
    const secretRow = await database.adapter.prepare(database.adapter.dialect.sql("SELECT [secret] FROM [sporades_team_join_link_secrets] WHERE [id] = ?")).get(TEAM_JOIN_LINK_SECRET_ID);
    const expectedVerifier = Buffer.from(row?.verifierHash ?? hashTeamJoinVerifier("\0absent"), "base64url");
    const actualVerifier = Buffer.from(hashTeamJoinVerifier(parsed.verifier), "base64url");
    const expectedSignature = Buffer.from(row && secretRow
        ? teamJoinSignature(String(secretRow.secret), String(row.id), parsed.selector, parsed.verifier, String(row.expiresAt))
        : teamJoinSignature("absent", "absent", parsed.selector, parsed.verifier, "absent"), "base64url");
    const actualSignature = Buffer.from(parsed.signature, "base64url");
    const verifierMatches = actualVerifier.length === expectedVerifier.length && timingSafeEqual(actualVerifier, expectedVerifier);
    const signatureMatches = actualSignature.length === expectedSignature.length && timingSafeEqual(actualSignature, expectedSignature);
    const now = (database.clock?.now?.() ?? new Date()).getTime();
    const expiresAt = Date.parse(row?.expiresAt ?? "");
    if (!row || !verifierMatches || !signatureMatches || row.consumedAt || row.revokedAt || !Number.isFinite(expiresAt) || expiresAt <= now)
        return { valid: false };
    const team = await database.adapter.prepare(database.adapter.dialect.sql("SELECT [id] FROM [sporades_teams] WHERE [id] = ?")).get(row.teamId);
    if (!team)
        return { valid: false };
    const attachedEmails = await database.adapter.prepare(database.adapter.dialect.sql("SELECT [email] FROM [sporades_auth_email_credentials] WHERE [userId] = ? " +
        "UNION ALL SELECT [email] FROM [sporades_auth_identities] WHERE [userId] = ? AND [email] IS NOT NULL")).all(auth.userId, auth.userId);
    const targetEmail = normalizeTeamJoinIdentityEmail(row.email);
    const valid = attachedEmails.some((identity) => normalizeTeamJoinIdentityEmail(identity.email) === targetEmail);
    return { valid };
}
// Redemption deliberately repeats validation inside its own transaction. The
// browser's earlier non-consuming check is only UI guidance, never authority.
export async function joinCurrentUserTeam(database, auth, code, eventContext) {
    let joined;
    let deniedTeamId = null;
    try {
        requireAuth({ auth }, { linked: true });
        const parsed = parseTeamJoinCode(code);
        if (!parsed)
            throw invalidTeamJoinLink();
        joined = await withTeamTransaction(database, async (tx) => {
            const sql = tx.dialect.sql;
            let row = await tx.prepare(sql("SELECT [id], [selector], [verifierHash], [teamId], [email], [expiresAt], [consumedAt], [revokedAt] FROM [sporades_team_join_links] WHERE [selector] = ?")).get(parsed.selector);
            // A Join link identifies the Team to lock, but that lookup alone is not
            // authority: deletion may commit between it and a membership write on a
            // different runtime. Acquire the shared lifecycle lock, then read the
            // grant again so every predicate below observes post-lock state.
            if (!row)
                throw invalidTeamJoinLink();
            await lockTeamLifecycle(tx, String(row.teamId));
            row = await tx.prepare(sql("SELECT [id], [selector], [verifierHash], [teamId], [email], [expiresAt], [consumedAt], [revokedAt] FROM [sporades_team_join_links] WHERE [selector] = ?")).get(parsed.selector);
            const secretRow = await tx.prepare(sql("SELECT [secret] FROM [sporades_team_join_link_secrets] WHERE [id] = ?")).get(TEAM_JOIN_LINK_SECRET_ID);
            const expectedVerifier = Buffer.from(row?.verifierHash ?? hashTeamJoinVerifier("\0absent"), "base64url");
            const actualVerifier = Buffer.from(hashTeamJoinVerifier(parsed.verifier), "base64url");
            const expectedSignature = Buffer.from(row && secretRow
                ? teamJoinSignature(String(secretRow.secret), String(row.id), parsed.selector, parsed.verifier, String(row.expiresAt))
                : teamJoinSignature("absent", "absent", parsed.selector, parsed.verifier, "absent"), "base64url");
            const actualSignature = Buffer.from(parsed.signature, "base64url");
            const verifierMatches = actualVerifier.length === expectedVerifier.length && timingSafeEqual(actualVerifier, expectedVerifier);
            const signatureMatches = actualSignature.length === expectedSignature.length && timingSafeEqual(actualSignature, expectedSignature);
            const now = (database.clock?.now?.() ?? new Date()).toISOString();
            const expiresAt = Date.parse(row?.expiresAt ?? "");
            if (!row || !verifierMatches || !signatureMatches || row.revokedAt || !Number.isFinite(expiresAt) || expiresAt <= Date.parse(now))
                throw invalidTeamJoinLink();
            const team = await tx.prepare(sql("SELECT [id], [name] FROM [sporades_teams] WHERE [id] = ?")).get(row.teamId);
            if (!team)
                throw invalidTeamJoinLink();
            const attachedEmails = await tx.prepare(sql("SELECT [email] FROM [sporades_auth_email_credentials] WHERE [userId] = ? " +
                "UNION ALL SELECT [email] FROM [sporades_auth_identities] WHERE [userId] = ? AND [email] IS NOT NULL")).all(auth.userId, auth.userId);
            const targetEmail = normalizeTeamJoinIdentityEmail(row.email);
            if (!attachedEmails.some((identity) => normalizeTeamJoinIdentityEmail(identity.email) === targetEmail)) {
                // The signed, current link has already resolved its Team. Preserve
                // that internal audit correlation without changing the generic public
                // denial or recording the link or either email address.
                deniedTeamId = String(team.id);
                throw invalidTeamJoinLink();
            }
            const redemption = await tx.prepare(sql("SELECT [userId] FROM [sporades_team_join_link_redemptions] WHERE [joinLinkId] = ?")).get(row.id);
            if (row.consumedAt) {
                if (redemption?.userId !== auth.userId)
                    throw invalidTeamJoinLink();
                const membership = await tx.prepare(sql("SELECT [role] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).get(row.teamId, auth.userId);
                if (!membership)
                    throw invalidTeamJoinLink();
                await ensureInitialTeamOnAdapter(tx, auth.userId);
                const count = await tx.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ?")).get(row.teamId);
                return teamSummary({ id: team.id, name: team.name, role: membership.role, memberCount: Number(count?.count ?? 0) });
            }
            if (redemption)
                throw invalidTeamJoinLink();
            // This conditional claim is the persistent single-use authority. Every
            // following write rolls it back if the membership cannot commit.
            const consumed = await tx.prepare(sql("UPDATE [sporades_team_join_links] SET [consumedAt] = ? WHERE [id] = ? AND [consumedAt] IS NULL AND [revokedAt] IS NULL AND [expiresAt] > ?")).run(now, row.id, now);
            if (Number(consumed?.changes ?? 0) !== 1)
                throw invalidTeamJoinLink();
            await tx.prepare(sql("INSERT INTO [sporades_team_join_link_redemptions] ([joinLinkId], [teamId], [userId], [createdAt]) VALUES (?, ?, ?, ?)")).run(row.id, row.teamId, auth.userId, now);
            // Legacy linked accounts bootstrap only after this caller owns the
            // committed redemption; all resulting writes remain one transaction.
            await ensureInitialTeamOnAdapter(tx, auth.userId);
            let membership = await tx.prepare(sql("SELECT [role] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).get(row.teamId, auth.userId);
            if (!membership) {
                await ensureMembershipCounterOnAdapter(tx, auth.userId);
                const claim = await tx.prepare(sql("UPDATE [sporades_team_membership_counters] SET [membershipCount] = [membershipCount] + 1 " +
                    "WHERE [userId] = ? AND [membershipCount] < ?")).run(auth.userId, TEAM_MEMBERSHIP_MAX);
                if (Number(claim?.changes ?? 0) !== 1) {
                    throw commandError("Team limit reached.", `A user can belong to at most ${TEAM_MEMBERSHIP_MAX} Teams.`, "TEAM_LIMIT_REACHED");
                }
                await tx.prepare(sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'member', ?)")).run(row.teamId, auth.userId, now);
                membership = { role: "member" };
            }
            await releaseTeamJoinLinkCapacity(tx, String(row.teamId));
            const count = await tx.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ?")).get(row.teamId);
            return teamSummary({ id: team.id, name: team.name, role: membership.role, memberCount: Number(count?.count ?? 0) });
        });
    }
    catch (error) {
        emitTeamSecurityEvent(database, eventContext, "teams.joinLink.join", auth?.userId, deniedTeamId, "denied", String(error?.code ?? "INVALID_JOIN_LINK"));
        throw error;
    }
    emitTeamSecurityEvent(database, eventContext, "teams.joined", auth.userId, joined.id, "succeeded", "TEAM_JOINED");
    return { team: joined };
}
function normalizeTeamJoinEmail(email) {
    const normalized = String(email ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
        throw commandError("Email address is invalid.", "Provide a valid email address for the Join link.", "INVALID_EMAIL");
    }
    return normalized;
}
function normalizeTeamJoinIdentityEmail(email) {
    return String(email ?? "").trim().toLowerCase();
}
function normalizeTeamJoinTtl(value) {
    if (value === undefined)
        return TEAM_JOIN_LINK_DEFAULT_TTL_SECONDS;
    if (!Number.isInteger(value) || value < TEAM_JOIN_LINK_MIN_TTL_SECONDS || value > TEAM_JOIN_LINK_MAX_TTL_SECONDS) {
        throw commandError("Join link lifetime is invalid.", `Use an integer between ${TEAM_JOIN_LINK_MIN_TTL_SECONDS} and ${TEAM_JOIN_LINK_MAX_TTL_SECONDS} seconds.`, "INVALID_JOIN_LINK_TTL");
    }
    return value;
}
function parseTeamJoinCode(code) {
    const [version, selector, verifier, signature, ...rest] = typeof code === "string" ? code.split(".") : [];
    if (version !== "v1" || rest.length > 0 || !/^[A-Za-z0-9_-]{16,64}$/.test(selector ?? "") || !/^[A-Za-z0-9_-]{32,128}$/.test(verifier ?? "") || !/^[A-Za-z0-9_-]{32,128}$/.test(signature ?? ""))
        return null;
    return { selector, verifier, signature };
}
function hashTeamJoinVerifier(verifier) { return createHash("sha256").update(verifier).digest("base64url"); }
function teamJoinSignature(secret, id, selector, verifier, expiresAt) { return createHmac("sha256", secret).update(`v1.${id}.${selector}.${verifier}.${expiresAt}`).digest("base64url"); }
async function teamJoinSigningSecret(tx, createdAt) {
    const existing = await tx.prepare(tx.dialect.sql("SELECT [secret] FROM [sporades_team_join_link_secrets] WHERE [id] = ?")).get(TEAM_JOIN_LINK_SECRET_ID);
    if (existing?.secret)
        return String(existing.secret);
    const secret = randomBytes(32).toString("base64url");
    await tx.prepare(tx.dialect.sql("INSERT INTO [sporades_team_join_link_secrets] ([id], [secret], [createdAt]) VALUES (?, ?, ?) ON CONFLICT ([id]) DO NOTHING")).run(TEAM_JOIN_LINK_SECRET_ID, secret, createdAt);
    const claimed = await tx.prepare(tx.dialect.sql("SELECT [secret] FROM [sporades_team_join_link_secrets] WHERE [id] = ?")).get(TEAM_JOIN_LINK_SECRET_ID);
    return String(claimed?.secret ?? secret);
}
async function currentTeamAdmin(tx, teamId, userId) {
    const membership = await tx.prepare(tx.dialect.sql("SELECT [role] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).get(teamId, userId);
    return membership?.role === "admin";
}
async function countTeamAdmins(tx, teamId) {
    const row = await tx.prepare(tx.dialect.sql("SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [role] = 'admin'")).get(teamId);
    return Number(row?.count ?? 0);
}
async function lockTeamLifecycle(tx, teamId) {
    // A no-op row update is a portable per-Team write lock: under Postgres the
    // next lifecycle transaction waits and then observes the prior commit;
    // SQLite/libSQL retain their adapter transaction serialization. This keeps
    // the admin predicate and its write one linearizable operation.
    const claimed = await tx.prepare(tx.dialect.sql("UPDATE [sporades_teams] SET [name] = [name] WHERE [id] = ?")).run(teamId);
    if (Number(claimed?.changes ?? 0) !== 1)
        throw teamDenied();
}
async function releaseTeamMembershipSlot(tx, userId) {
    await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_membership_counters] SET [membershipCount] = [membershipCount] - 1 WHERE [userId] = ? AND [membershipCount] > 0")).run(userId);
}
async function pruneExpiredTeamJoinLinks(tx, now) {
    const rows = await tx.prepare(tx.dialect.sql("SELECT [id], [teamId] FROM [sporades_team_join_links] WHERE [expiresAt] <= ? LIMIT ?")).all(now, TEAM_JOIN_LINK_PRUNE_LIMIT);
    for (const row of rows) {
        const deleted = await deleteExpiredTeamJoinLink(tx, String(row.id), String(row.teamId), now);
        if (Number(deleted?.changes ?? 0) === 1)
            await releaseTeamJoinLinkCapacity(tx, String(row.teamId));
    }
}
async function claimTeamJoinLinkCreationSlot(tx, teamId, adminUserId, now) {
    const windowStart = new Date(Date.parse(now) - 60 * 60 * 1000).toISOString();
    await tx.prepare(tx.dialect.sql("INSERT INTO [sporades_team_join_link_throttles] ([teamId], [adminUserId], [windowStartedAt], [count]) VALUES (?, ?, ?, 0) ON CONFLICT ([teamId], [adminUserId]) DO NOTHING")).run(teamId, adminUserId, now);
    await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_join_link_throttles] SET [windowStartedAt] = ?, [count] = 0 WHERE [teamId] = ? AND [adminUserId] = ? AND [windowStartedAt] <= ?")).run(now, teamId, adminUserId, windowStart);
    const claimed = await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_join_link_throttles] SET [count] = [count] + 1 WHERE [teamId] = ? AND [adminUserId] = ? AND [windowStartedAt] > ? AND [count] < ?")).run(teamId, adminUserId, windowStart, TEAM_JOIN_LINK_CREATION_MAX_PER_HOUR);
    if (Number(claimed?.changes ?? 0) !== 1)
        throw teamJoinLinkThrottleError();
}
async function claimTeamJoinLinkCapacity(tx, teamId, now) {
    await tx.prepare(tx.dialect.sql("INSERT INTO [sporades_team_join_link_counters] ([teamId], [activeCount]) SELECT ?, COUNT(*) FROM [sporades_team_join_links] WHERE [teamId] = ? AND [expiresAt] > ? AND [consumedAt] IS NULL AND [revokedAt] IS NULL ON CONFLICT ([teamId]) DO NOTHING")).run(teamId, teamId, now);
    const claimed = await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_join_link_counters] SET [activeCount] = [activeCount] + 1 WHERE [teamId] = ? AND [activeCount] < ?")).run(teamId, TEAM_JOIN_LINK_MAX_OUTSTANDING);
    if (Number(claimed?.changes ?? 0) !== 1)
        throw teamJoinLinkLimitError();
}
// A global bounded prune is deliberately not the capacity authority: an older
// Capsule can have expired rows in many other Teams. Reconcile this exact
// Team immediately before its guarded claim, so those rows cannot pin the
// durable counter at the limit merely because another Team used the budget.
async function reconcileTeamJoinLinkCapacity(tx, teamId, now) {
    const expired = await tx.prepare(tx.dialect.sql("SELECT [id] FROM [sporades_team_join_links] WHERE [teamId] = ? AND [expiresAt] <= ? LIMIT ?")).all(teamId, now, TEAM_JOIN_LINK_PRUNE_LIMIT);
    for (const row of expired)
        await deleteExpiredTeamJoinLink(tx, String(row.id), teamId, now);
    await tx.prepare(tx.dialect.sql("INSERT INTO [sporades_team_join_link_counters] ([teamId], [activeCount]) SELECT ?, COUNT(*) FROM [sporades_team_join_links] WHERE [teamId] = ? AND [expiresAt] > ? AND [consumedAt] IS NULL AND [revokedAt] IS NULL ON CONFLICT ([teamId]) DO NOTHING")).run(teamId, teamId, now);
    await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_join_link_counters] SET [activeCount] = (SELECT COUNT(*) FROM [sporades_team_join_links] WHERE [teamId] = ? AND [expiresAt] > ? AND [consumedAt] IS NULL AND [revokedAt] IS NULL) WHERE [teamId] = ?")).run(teamId, now, teamId);
}
// Redemptions are durable only while their corresponding grant exists. Remove
// the ownership record in the same transaction before pruning an expired grant
// so repeated redemptions cannot accumulate orphaned Team or user references.
async function deleteExpiredTeamJoinLink(tx, joinLinkId, teamId, now) {
    await tx.prepare(tx.dialect.sql("DELETE FROM [sporades_team_join_link_redemptions] WHERE [joinLinkId] = ? AND [teamId] = ?")).run(joinLinkId, teamId);
    return tx.prepare(tx.dialect.sql("DELETE FROM [sporades_team_join_links] WHERE [id] = ? AND [teamId] = ? AND [expiresAt] <= ?")).run(joinLinkId, teamId, now);
}
async function releaseTeamJoinLinkCapacity(tx, teamId) {
    await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_join_link_counters] SET [activeCount] = [activeCount] - 1 WHERE [teamId] = ? AND [activeCount] > 0")).run(teamId);
}
function teamJoinLinkThrottleError() { return commandError("Join link creation is temporarily limited.", "Wait before creating another Join link for this Team.", "JOIN_LINK_THROTTLED"); }
function teamJoinLinkLimitError() { return commandError("Too many Join links are outstanding for this Team.", "Revoke an unused link or wait for one to expire.", "JOIN_LINK_LIMIT_REACHED"); }
function invalidTeamJoinLink() { return commandError("Join link is invalid.", "Use a current Join link for this linked account.", "INVALID_JOIN_LINK"); }
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
        teams: await Promise.all(rows.map(async (row) => ({
            id: String(row.id),
            name: safeTeamName(row.name),
            role: row.role === "admin" ? "admin" : "member",
            applicationRoles: await activeTeamApplicationRoles(database.adapter, database.teamApplicationRoles, row.id, auth.userId),
            memberCount: Math.min(TEAM_MEMBER_COUNT_MAX, Math.max(0, Number(row.memberCount) || 0)),
        }))),
    };
}
export async function createAdditionalTeam(database, auth, name, eventContext) {
    requireAuth({ auth }, { linked: true });
    const normalizedName = normalizeTeamName(name);
    const team = await withTeamTransaction(database, async (tx) => {
        await ensureInitialTeamOnAdapter(tx, auth.userId);
        await ensureMembershipCounterOnAdapter(tx, auth.userId);
        const claim = await tx.prepare(tx.dialect.sql("UPDATE [sporades_team_membership_counters] SET [membershipCount] = [membershipCount] + 1 " +
            "WHERE [userId] = ? AND [membershipCount] < ?")).run(auth.userId, TEAM_MEMBERSHIP_MAX);
        if (Number(claim?.changes ?? 0) !== 1) {
            throw commandError("Team limit reached.", `A user can belong to at most ${TEAM_MEMBERSHIP_MAX} Teams.`, "TEAM_LIMIT_REACHED");
        }
        const id = randomUUID();
        const now = new Date().toISOString();
        await tx.prepare(tx.dialect.sql("INSERT INTO [sporades_teams] ([id], [name], [createdAt], [createdByUserId]) VALUES (?, ?, ?, ?)")).run(id, normalizedName, now, auth.userId);
        await tx.prepare(tx.dialect.sql("INSERT INTO [sporades_team_memberships] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, 'admin', ?)")).run(id, auth.userId, now);
        return teamSummary({ id, name: normalizedName, role: "admin", memberCount: 1 });
    });
    emitTeamSecurityEvent(database, eventContext, "teams.created", auth.userId, team.id, "succeeded", "TEAM_CREATED");
    return { team };
}
export async function renameCurrentUserTeam(database, auth, teamId, name, eventContext) {
    requireAuth({ auth }, { linked: true });
    if (!isOpaqueTeamId(teamId)) {
        emitTeamSecurityEvent(database, eventContext, "teams.rename", auth.userId, null, "denied", "DENIED");
        throw teamDenied();
    }
    const normalizedName = normalizeTeamName(name);
    const team = await withTeamTransaction(database, async (tx) => {
        // Rename is a Team-scoped write too. It must not report a successful
        // update for a Team concurrently deleted by another runtime.
        await lockTeamLifecycle(tx, teamId);
        const membership = await tx.prepare(tx.dialect.sql("SELECT [role] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).get(teamId, auth.userId);
        // Deliberately merge absent Teams, non-members, and ordinary members into
        // one public denial. No name or membership state escapes this boundary.
        if (membership?.role !== "admin") {
            emitTeamSecurityEvent(database, eventContext, "teams.rename", auth.userId, teamId, "denied", "DENIED");
            throw teamDenied();
        }
        const changed = await tx.prepare(tx.dialect.sql("UPDATE [sporades_teams] SET [name] = ? WHERE [id] = ?")).run(normalizedName, teamId);
        if (Number(changed?.changes ?? 0) !== 1)
            throw teamDenied();
        const count = await tx.prepare(tx.dialect.sql("SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ?")).get(teamId);
        return teamSummary({ id: teamId, name: normalizedName, role: "admin", memberCount: Number(count?.count ?? 0) });
    });
    emitTeamSecurityEvent(database, eventContext, "teams.renamed", auth.userId, team.id, "succeeded", "TEAM_RENAMED");
    return { team };
}
/** Atomically reconcile one exact membership's Capsule-declared role set. */
export async function updateTeamMemberApplicationRoles(database, auth, teamId, userId, changes, eventContext) {
    requireAuth({ auth }, { linked: true });
    let patch;
    try {
        if (!isOpaqueTeamId(teamId) || !isOpaqueTeamId(userId))
            throw teamDenied();
        patch = normalizeTeamApplicationRolePatch(changes, database.teamApplicationRoles ?? []);
        await withTeamTransaction(database, async (tx) => {
            const sql = tx.dialect.sql;
            // The shared lifecycle lock linearizes role changes with membership
            // removal and Team deletion. Both actor authority and target existence
            // are deliberately re-read after it.
            await lockTeamLifecycle(tx, teamId);
            if (!await currentTeamAdmin(tx, teamId, auth.userId))
                throw teamDenied();
            const target = await tx.prepare(sql("SELECT [userId] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).get(teamId, userId);
            if (!target)
                throw teamDenied();
            for (const role of patch.remove) {
                await tx.prepare(sql("DELETE FROM [sporades_team_membership_application_roles] WHERE [teamId] = ? AND [userId] = ? AND [role] = ?")).run(teamId, userId, role);
            }
            const now = (database.clock?.now?.() ?? new Date()).toISOString();
            for (const role of patch.add) {
                await tx.prepare(sql("INSERT INTO [sporades_team_membership_application_roles] ([teamId], [userId], [role], [createdAt]) VALUES (?, ?, ?, ?) ON CONFLICT ([teamId], [userId], [role]) DO NOTHING")).run(teamId, userId, role, now);
            }
        });
    }
    catch (error) {
        emitTeamSecurityEvent(database, eventContext, "teams.updateApplicationRoles", auth.userId, isOpaqueTeamId(teamId) ? teamId : null, "denied", String(error?.code ?? "DENIED"));
        throw error;
    }
    emitTeamSecurityEvent(database, eventContext, "teams.applicationRolesUpdated", auth.userId, teamId, "succeeded", "TEAM_APPLICATION_ROLES_UPDATED", {
        targetUserId: String(userId).slice(0, 128), add: patch.add, remove: patch.remove,
    });
    return { updated: true };
}
/**
 * Team-admin lifecycle mutations deliberately re-read both the actor and
 * target inside one adapter transaction. A browser's old membership list is
 * presentation only; it never authorizes a later role or removal write.
 */
export async function promoteTeamMember(database, auth, teamId, userId, eventContext) {
    return changeTeamMemberRole(database, auth, teamId, userId, "admin", eventContext);
}
export async function demoteTeamMember(database, auth, teamId, userId, eventContext) {
    return changeTeamMemberRole(database, auth, teamId, userId, "member", eventContext);
}
async function changeTeamMemberRole(database, auth, teamId, userId, role, eventContext) {
    requireAuth({ auth }, { linked: true });
    const operation = role === "admin" ? "teams.promote" : "teams.demote";
    const event = role === "admin" ? "teams.promoted" : "teams.demoted";
    try {
        if (!isOpaqueTeamId(teamId) || !isOpaqueTeamId(userId))
            throw teamDenied();
        await withTeamTransaction(database, async (tx) => {
            const sql = tx.dialect.sql;
            await lockTeamLifecycle(tx, teamId);
            if (!await currentTeamAdmin(tx, teamId, auth.userId))
                throw teamDenied();
            const target = await tx.prepare(sql("SELECT [role] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).get(teamId, userId);
            if (!target)
                throw teamDenied();
            if (role === "member" && target.role === "admin") {
                const admins = await countTeamAdmins(tx, teamId);
                if (admins < 2)
                    throw teamDenied();
            }
            await tx.prepare(sql("UPDATE [sporades_team_memberships] SET [role] = ? WHERE [teamId] = ? AND [userId] = ?")).run(role, teamId, userId);
        });
    }
    catch (error) {
        emitTeamSecurityEvent(database, eventContext, operation, auth.userId, isOpaqueTeamId(teamId) ? teamId : null, "denied", String(error?.code ?? "DENIED"));
        throw error;
    }
    emitTeamSecurityEvent(database, eventContext, event, auth.userId, teamId, "succeeded", role === "admin" ? "TEAM_MEMBER_PROMOTED" : "TEAM_MEMBER_DEMOTED");
    return { updated: true };
}
export async function removeTeamMember(database, auth, teamId, userId, eventContext) {
    requireAuth({ auth }, { linked: true });
    try {
        if (!isOpaqueTeamId(teamId) || !isOpaqueTeamId(userId) || userId === auth.userId)
            throw teamDenied();
        await withTeamTransaction(database, async (tx) => {
            const sql = tx.dialect.sql;
            await lockTeamLifecycle(tx, teamId);
            if (!await currentTeamAdmin(tx, teamId, auth.userId))
                throw teamDenied();
            const target = await tx.prepare(sql("SELECT [role] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).get(teamId, userId);
            if (!target)
                throw teamDenied();
            if (target.role === "admin" && await countTeamAdmins(tx, teamId) < 2)
                throw teamDenied();
            await tx.prepare(sql("DELETE FROM [sporades_team_membership_application_roles] WHERE [teamId] = ? AND [userId] = ?")).run(teamId, userId);
            const removed = await tx.prepare(sql("DELETE FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).run(teamId, userId);
            if (Number(removed?.changes ?? 0) !== 1)
                throw teamDenied();
            await releaseTeamMembershipSlot(tx, userId);
        });
    }
    catch (error) {
        emitTeamSecurityEvent(database, eventContext, "teams.removeMember", auth.userId, isOpaqueTeamId(teamId) ? teamId : null, "denied", String(error?.code ?? "DENIED"));
        throw error;
    }
    emitTeamSecurityEvent(database, eventContext, "teams.memberRemoved", auth.userId, teamId, "succeeded", "TEAM_MEMBER_REMOVED");
    return { removed: true };
}
export async function leaveCurrentUserTeam(database, auth, teamId, eventContext) {
    requireAuth({ auth }, { linked: true });
    try {
        if (!isOpaqueTeamId(teamId))
            throw teamDenied();
        await withTeamTransaction(database, async (tx) => {
            const sql = tx.dialect.sql;
            await lockTeamLifecycle(tx, teamId);
            const membership = await tx.prepare(sql("SELECT [role] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).get(teamId, auth.userId);
            // An admin must explicitly hand over/demote first. This is deliberately
            // stricter than merely checking whether another admin exists.
            if (!membership || membership.role === "admin")
                throw teamDenied();
            await tx.prepare(sql("DELETE FROM [sporades_team_membership_application_roles] WHERE [teamId] = ? AND [userId] = ?")).run(teamId, auth.userId);
            const removed = await tx.prepare(sql("DELETE FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).run(teamId, auth.userId);
            if (Number(removed?.changes ?? 0) !== 1)
                throw teamDenied();
            await releaseTeamMembershipSlot(tx, auth.userId);
        });
    }
    catch (error) {
        emitTeamSecurityEvent(database, eventContext, "teams.leave", auth.userId, isOpaqueTeamId(teamId) ? teamId : null, "denied", String(error?.code ?? "DENIED"));
        throw error;
    }
    emitTeamSecurityEvent(database, eventContext, "teams.left", auth.userId, teamId, "succeeded", "TEAM_LEFT");
    return { left: true };
}
export async function deleteCurrentUserTeam(database, auth, teamId, eventContext) {
    requireAuth({ auth }, { linked: true });
    try {
        if (!isOpaqueTeamId(teamId))
            throw teamDenied();
        await withTeamTransaction(database, async (tx) => {
            const sql = tx.dialect.sql;
            await lockTeamLifecycle(tx, teamId);
            if (!await currentTeamAdmin(tx, teamId, auth.userId))
                throw teamDenied();
            const members = await tx.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_team_memberships] WHERE [teamId] = ?")).get(teamId);
            if (Number(members?.count ?? 0) !== 1)
                throw teamDenied();
            const links = await tx.prepare(sql("SELECT [id] FROM [sporades_team_join_links] WHERE [teamId] = ?")).all(teamId);
            for (const link of links) {
                await tx.prepare(sql("DELETE FROM [sporades_team_join_link_redemptions] WHERE [joinLinkId] = ?")).run(link.id);
            }
            await tx.prepare(sql("DELETE FROM [sporades_team_join_links] WHERE [teamId] = ?")).run(teamId);
            await tx.prepare(sql("DELETE FROM [sporades_team_join_link_throttles] WHERE [teamId] = ?")).run(teamId);
            await tx.prepare(sql("DELETE FROM [sporades_team_join_link_counters] WHERE [teamId] = ?")).run(teamId);
            await tx.prepare(sql("DELETE FROM [sporades_team_membership_application_roles] WHERE [teamId] = ?")).run(teamId);
            await tx.prepare(sql("DELETE FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).run(teamId, auth.userId);
            const deleted = await tx.prepare(sql("DELETE FROM [sporades_teams] WHERE [id] = ?")).run(teamId);
            if (Number(deleted?.changes ?? 0) !== 1)
                throw teamDenied();
            await releaseTeamMembershipSlot(tx, auth.userId);
        });
    }
    catch (error) {
        emitTeamSecurityEvent(database, eventContext, "teams.delete", auth.userId, isOpaqueTeamId(teamId) ? teamId : null, "denied", String(error?.code ?? "DENIED"));
        throw error;
    }
    emitTeamSecurityEvent(database, eventContext, "teams.deleted", auth.userId, teamId, "succeeded", "TEAM_DELETED");
    return { deleted: true };
}
export async function listTeamMembers(database, auth, teamId) {
    requireAuth({ auth }, { linked: true });
    if (!isOpaqueTeamId(teamId))
        throw teamDenied();
    return withTeamTransaction(database, async (tx) => {
        const sql = tx.dialect.sql;
        // Check the caller's current, persisted membership before querying member
        // profiles. Missing Teams, non-members, and ordinary members are one
        // opaque public denial, so this API cannot become a Team-existence probe.
        const callerMembership = await tx.prepare(sql("SELECT [role] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).get(teamId, auth.userId);
        if (callerMembership?.role !== "admin")
            throw teamDenied();
        const rows = await tx.prepare(sql("SELECT [m].[userId], [u].[displayName], [u].[picture], [m].[role] " +
            "FROM [sporades_team_memberships] [m] JOIN [sporades_auth_users] [u] ON [u].[id] = [m].[userId] " +
            "WHERE [m].[teamId] = ? ORDER BY [m].[createdAt] ASC, [m].[userId] ASC LIMIT ?")).all(teamId, TEAM_MEMBER_LIST_MAX);
        return {
            members: await Promise.all(rows.map(async (row) => ({
                userId: String(row.userId),
                displayName: String(row.displayName),
                picture: typeof row.picture === "string" && row.picture.length > 0 ? row.picture : null,
                role: row.role === "admin" ? "admin" : "member",
                applicationRoles: await activeTeamApplicationRoles(tx, database.teamApplicationRoles, teamId, row.userId),
            }))),
        };
    });
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
async function withTeamTransaction(database, callback) {
    if (database.__transactionActive)
        return callback(database.adapter);
    // Share Ticket 01's runtime queue: node:sqlite has one connection, and Team
    // operations must not race a lazy/bootstrap auth transaction into BEGIN.
    const root = database.__rootDatabase ?? database;
    const previous = root.__runtimeTransactionQueue ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => teamTransactionWithRetry(database.adapter, callback));
    root.__runtimeTransactionQueue = work;
    try {
        return await work;
    }
    finally {
        if (root.__runtimeTransactionQueue === work)
            root.__runtimeTransactionQueue = null;
    }
}
async function teamTransactionWithRetry(adapter, callback) {
    for (let attempt = 0;; attempt += 1) {
        try {
            return await adapter.withTransaction(callback);
        }
        catch (error) {
            if (attempt >= TEAM_BOOTSTRAP_RETRY_LIMIT - 1 || !isTransientTeamBootstrapError(error))
                throw error;
            await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 10));
        }
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
    await tx.prepare(sql("INSERT INTO [sporades_team_membership_counters] ([userId], [membershipCount]) VALUES (?, 1)")).run(userId);
    return id;
}
async function ensureMembershipCounterOnAdapter(tx, userId) {
    const sql = tx.dialect.sql;
    // Ticket 01 rows can predate this counter. The insert backfills exactly once;
    // the guarded UPDATE above is the durable, cross-runtime admission claim.
    await tx.prepare(sql("INSERT INTO [sporades_team_membership_counters] ([userId], [membershipCount]) " +
        "SELECT ?, COUNT(*) FROM [sporades_team_memberships] WHERE [userId] = ? " +
        "ON CONFLICT ([userId]) DO NOTHING")).run(userId, userId);
}
function safeTeamName(value) {
    const name = typeof value === "string" ? value.trim() : "";
    return Buffer.byteLength(name, "utf8") <= TEAM_NAME_MAX_BYTES && name.length > 0 ? name : INITIAL_TEAM_NAME;
}
function normalizeTeamName(value) {
    if (typeof value !== "string") {
        throw commandError("Team name is required.", "Provide a non-empty Team name.", "INVALID_TEAM_NAME");
    }
    const name = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (name.length === 0 || Buffer.byteLength(name, "utf8") > TEAM_NAME_MAX_BYTES) {
        throw commandError("Team name is invalid.", `Use a non-empty Team name up to ${TEAM_NAME_MAX_BYTES} UTF-8 bytes.`, "INVALID_TEAM_NAME");
    }
    return name;
}
function invalidTeamApplicationRoleDeclaration() {
    return commandError("Invalid Team application-role declaration.", `Declare at most ${TEAM_APPLICATION_ROLE_MAX} unique lowercase roles using letters, digits, and hyphens; admin, member, and sporades-* are reserved.`, "INVALID_TEAM_APPLICATION_ROLES");
}
function invalidTeamApplicationRolePatch() {
    return commandError("Invalid Team application-role update.", `Use non-overlapping add and remove arrays of at most ${TEAM_APPLICATION_ROLE_PATCH_MAX} declared roles.`, "INVALID_APPLICATION_ROLES");
}
function normalizeTeamApplicationRolePatch(value, declared) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.add) || !Array.isArray(value.remove)
        || value.add.length > TEAM_APPLICATION_ROLE_PATCH_MAX || value.remove.length > TEAM_APPLICATION_ROLE_PATCH_MAX)
        throw invalidTeamApplicationRolePatch();
    const allowed = new Set(Array.isArray(declared) ? declared : []);
    const normalize = (roles) => {
        const seen = new Set();
        for (const role of roles) {
            if (typeof role !== "string" || !allowed.has(role) || seen.has(role))
                throw invalidTeamApplicationRolePatch();
            seen.add(role);
        }
        return [...seen];
    };
    const add = normalize(value.add);
    const remove = normalize(value.remove);
    if (add.some((role) => remove.includes(role)))
        throw invalidTeamApplicationRolePatch();
    return { add, remove };
}
async function activeTeamApplicationRoles(adapter, declared, teamId, userId) {
    const active = Array.isArray(declared) ? declared : [];
    if (active.length === 0)
        return [];
    const rows = await adapter.prepare(adapter.dialect.sql("SELECT [role] FROM [sporades_team_membership_application_roles] WHERE [teamId] = ? AND [userId] = ?")).all(String(teamId), String(userId));
    const assigned = new Set(rows.map((row) => String(row.role)));
    // Declaration order gives a stable UI projection and avoids exposing storage
    // row order. Undeclared retained assignments fail closed until restored.
    return active.filter((role) => assigned.has(role));
}
function isOpaqueTeamId(value) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function teamDenied() {
    return commandError("Team operation denied.", "Sign in with a Team administrator account and retry.", "DENIED");
}
function teamSummary(input) {
    return {
        id: String(input.id),
        name: safeTeamName(input.name),
        role: input.role === "admin" ? "admin" : "member",
        applicationRoles: [],
        memberCount: Math.min(TEAM_MEMBER_COUNT_MAX, Math.max(0, Number(input.memberCount) || 0)),
    };
}
function emitTeamSecurityEvent(database, eventContext, event, actorUserId, teamId, outcome, code, extra = {}) {
    // Keep audit data identifier-only and bounded: names can contain sensitive
    // presentation text, while Sessions and provider records never belong here.
    const input = {
        category: "audit",
        event,
        level: "info",
        message: teamSecurityMessage(event, outcome),
        data: { operation: teamSecurityOperation(event), outcome, code: code.slice(0, 80), actorUserId: String(actorUserId).slice(0, 128), teamId: teamId === null ? null : String(teamId).slice(0, 64), ...extra },
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
function teamSecurityOperation(event) {
    if (event === "teams.created")
        return "teams.create";
    if (event === "teams.renamed" || event === "teams.rename")
        return "teams.rename";
    if (event === "teams.joined" || event === "teams.joinLink.join")
        return "teams.join";
    if (event === "teams.joinLink.created" || event === "teams.joinLink.create")
        return "teams.createJoinLink";
    if (event === "teams.joinLink.revoked" || event === "teams.joinLink.revoke")
        return "teams.revokeJoinLink";
    if (event === "teams.promoted" || event === "teams.promote")
        return "teams.promote";
    if (event === "teams.demoted" || event === "teams.demote")
        return "teams.demote";
    if (event === "teams.applicationRolesUpdated" || event === "teams.updateApplicationRoles")
        return "teams.updateApplicationRoles";
    if (event === "teams.memberRemoved" || event === "teams.removeMember")
        return "teams.removeMember";
    if (event === "teams.left" || event === "teams.leave")
        return "teams.leave";
    return "teams.delete";
}
function teamSecurityMessage(event, outcome) {
    if (outcome === "denied")
        return "Team lifecycle operation denied.";
    if (event === "teams.created")
        return "Team created.";
    if (event === "teams.renamed")
        return "Team renamed.";
    if (event === "teams.joined")
        return "Joined Team.";
    if (event === "teams.joinLink.created")
        return "Team Join link created.";
    if (event === "teams.joinLink.revoked")
        return "Team Join link revoked.";
    if (event === "teams.promoted")
        return "Team member promoted.";
    if (event === "teams.demoted")
        return "Team admin demoted.";
    if (event === "teams.applicationRolesUpdated")
        return "Team application roles updated.";
    if (event === "teams.memberRemoved")
        return "Team member removed.";
    if (event === "teams.left")
        return "Left Team.";
    if (event === "teams.deleted")
        return "Team deleted.";
    return "Team operation completed.";
}
export function flushTeamSecurityEvents(database, context, options = {}) {
    const events = context?.__teamSecurityEvents;
    if (!Array.isArray(events))
        return;
    if (!context)
        return;
    delete context.__teamSecurityEvents;
    for (const event of events) {
        if (options.deniedOnly && event?.data?.outcome !== "denied")
            continue;
        database.log?.emit?.(event);
    }
}
//# sourceMappingURL=teams-runtime.js.map