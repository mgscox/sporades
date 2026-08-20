import { accessKeyGrantsSatisfyScopes, scopeGrantMatches } from "./auth-admission.js";
import { chainMaybePromise } from "./maybe-promise.js";
import { commandError } from "./runtime-errors.js";
const UNKNOWN_ACCESS_KEY_DIGEST = Buffer.from("4f7c77f7b9231094754542ed50fdfd62a2cf24a5e961b61f899b85b6fe33c72b", "hex");
function accessKeyCrypto() {
    return process.getBuiltinModule("node:crypto");
}
export const ACCESS_KEY_CURRENT_LIMIT = 100;
export const ACCESS_KEY_RETAINED_LIMIT = 1000;
export const ACCESS_KEY_GRANT_LIMIT = 128;
export const ACCESS_KEY_GRANT_BYTE_LIMIT = 256;
export const ACCESS_KEY_GRANTS_JSON_BYTE_LIMIT = 32 * 1024;
export function createAccessKeyTables(adapter) {
    const sql = adapter.dialect.sql;
    return chainMaybePromise([
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_auth_access_keys] (" +
            "[id] TEXT PRIMARY KEY, " +
            "[ownerUserId] TEXT NOT NULL, " +
            "[name] TEXT NOT NULL, " +
            "[reservedName] TEXT, " +
            "[grantsJson] TEXT NOT NULL, " +
            "[secretVersion] INTEGER NOT NULL, " +
            "[selector] TEXT, " +
            "[verifierDigest] TEXT, " +
            "[lifecycleRevision] INTEGER NOT NULL, " +
            "[createdAt] TEXT NOT NULL, " +
            "[expiresAt] TEXT, " +
            "[rotatedAt] TEXT, " +
            "[revokedAt] TEXT, " +
            "[revocationCause] TEXT, " +
            "[lastUsedAt] TEXT" +
            ")")),
        () => adapter.exec(sql("CREATE UNIQUE INDEX IF NOT EXISTS [sporades_auth_access_keys_secret] " +
            "ON [sporades_auth_access_keys] ([secretVersion], [selector])")),
        () => adapter.exec(sql("CREATE UNIQUE INDEX IF NOT EXISTS [sporades_auth_access_keys_current_name] " +
            "ON [sporades_auth_access_keys] ([ownerUserId], [reservedName])")),
        () => adapter.exec(sql("CREATE INDEX IF NOT EXISTS [sporades_auth_access_keys_owner_listing] " +
            "ON [sporades_auth_access_keys] ([ownerUserId], [createdAt], [id])")),
        () => adapter.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_auth_access_key_owners] (" +
            "[ownerUserId] TEXT PRIMARY KEY, " +
            "[currentCount] INTEGER NOT NULL, " +
            "[totalCount] INTEGER NOT NULL, " +
            "[operationRevision] INTEGER NOT NULL" +
            ")")),
    ]);
}
export function createCurrentUserAccessKeysApi(database, contextGetter) {
    return {
        async issue(input) {
            const context = requireOwnerSessionContext(contextGetter());
            const normalized = normalizeAccessKeyIssue(input, database.accessKeyScopes ?? [], database.clock.now());
            for (let attempt = 0; attempt < 5; attempt += 1) {
                const secret = createAccessKeySecret();
                const record = {
                    id: accessKeyCrypto().randomUUID(),
                    ownerUserId: context.auth.userId,
                    name: normalized.name,
                    reservedName: normalized.name,
                    grantsJson: JSON.stringify(normalized.grants),
                    secretVersion: 1,
                    selector: secret.selector,
                    verifierDigest: accessKeyVerifierDigest(secret.selector, secret.verifier),
                    lifecycleRevision: 1,
                    createdAt: normalized.createdAt,
                    expiresAt: normalized.expiresAt,
                };
                const outcome = await withAccessKeyTransaction(database, (adapter) => adapter.issueAccessKeyRecord(record));
                if (outcome.status === "selector-conflict")
                    continue;
                if (outcome.status !== "issued")
                    throwAccessKeyIssueError(outcome.status);
                const accessKey = accessKeySummary(record, database.accessKeyScopes ?? [], normalized.createdAt);
                context.__sporadesSecretDisclosed = true;
                emitOwnerAccessKeyAudit(database, "access-key.issued", context, accessKey);
                return { accessKey, token: secret.token };
            }
            throw commandError("Could not generate a unique Access key.", "Retry Access-key issuance.", "ACCESS_KEY_SECRET_CONFLICT");
        },
        async list(options = {}) {
            const context = requireOwnerSessionContext(contextGetter());
            const normalized = normalizeAccessKeyListOptions(options);
            const rows = await database.adapter.listAccessKeyRecordsForOwner(context.auth.userId);
            return accessKeyListPage(rows, database.accessKeyScopes ?? [], database.clock.now(), normalized);
        },
        async revoke(id) {
            const context = requireOwnerSessionContext(contextGetter());
            if (typeof id !== "string" || !id)
                throw accessKeyNotFoundError();
            const now = database.clock.now().toISOString();
            const outcome = await withAccessKeyTransaction(database, (adapter) => adapter.revokeAccessKeyRecord({ ownerUserId: context.auth.userId, id, revokedAt: now, revocationCause: "owner" }));
            if (!outcome)
                throw accessKeyNotFoundError();
            const accessKey = accessKeySummary(outcome, database.accessKeyScopes ?? [], now);
            emitOwnerAccessKeyAudit(database, "access-key.revoked", context, accessKey);
            return { accessKey };
        },
    };
}
export function readAccessKeyAuthorization(request) {
    const values = [];
    if (Array.isArray(request?.rawHeaders)) {
        for (let index = 0; index < request.rawHeaders.length; index += 2) {
            if (String(request.rawHeaders[index]).toLowerCase() === "authorization") {
                values.push(String(request.rawHeaders[index + 1] ?? ""));
            }
        }
    }
    else {
        const value = request?.headers?.authorization;
        if (Array.isArray(value))
            values.push(...value.map(String));
        else if (value !== undefined)
            values.push(String(value));
    }
    if (values.length === 0)
        return null;
    if (values.length !== 1)
        throw accessKeyAuthenticationError("malformed");
    const value = values[0];
    if (/[,\u0000-\u001f\u007f]/.test(value))
        throw accessKeyAuthenticationError("malformed");
    const matched = value.match(/^Bearer (spk_1_([A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{43}))$/i);
    if (!matched || !matched[1].startsWith("spk_1_"))
        throw accessKeyAuthenticationError("malformed");
    return { token: matched[1], selector: matched[2], verifier: matched[3] };
}
export async function resolveAccessKeyCredential(database, request, sessionToken) {
    const source = accessKeySourceBucket(request);
    assertAccessKeyFailureLimit(database, "source", source, 30, 60_000);
    let parsed;
    try {
        parsed = readAccessKeyAuthorization(request);
    }
    catch (error) {
        recordAccessKeyFailure(database, "source", source, 60_000);
        throw error;
    }
    if (!parsed)
        return null;
    if (sessionToken !== null && sessionToken !== undefined) {
        recordAccessKeyFailure(database, "source", source, 60_000);
        throw accessKeyAuthenticationError("dual");
    }
    const selectorFingerprint = accessKeySelectorFingerprint(parsed.selector);
    assertAccessKeyFailureLimit(database, "selector", selectorFingerprint, 10, 5 * 60_000);
    const row = await database.adapter.findAccessKeyAuthenticationRecord(parsed.selector);
    const candidateDigest = Buffer.from(accessKeyVerifierDigest(parsed.selector, parsed.verifier), "hex");
    let storedDigest = UNKNOWN_ACCESS_KEY_DIGEST;
    if (typeof row?.verifierDigest === "string" && /^[a-f0-9]{64}$/i.test(row.verifierDigest)) {
        storedDigest = Buffer.from(row.verifierDigest, "hex");
    }
    const verified = accessKeyCrypto().timingSafeEqual(candidateDigest, storedDigest);
    const now = database.clock.now();
    let failure = null;
    if (!verified || !row)
        failure = "invalid";
    else if (row.revokedAt)
        failure = "revoked";
    else if (row.expiresAt && Date.parse(row.expiresAt) <= now.getTime())
        failure = "expired";
    else if (Number(row.ownerIsAuthenticated) !== 1 || Number(row.ownerIsGuest) !== 0)
        failure = "owner-ineligible";
    if (failure) {
        recordAccessKeyFailure(database, "source", source, 60_000);
        recordAccessKeyFailure(database, "selector", selectorFingerprint, 5 * 60_000);
        throw accessKeyAuthenticationError(failure);
    }
    clearAccessKeyFailure(database, "selector", selectorFingerprint);
    return {
        auth: protectAccessKeyValue({
            userId: row.ownerUserId,
            displayName: row.ownerDisplayName,
            email: row.ownerEmail ?? null,
            picture: row.ownerPicture ?? null,
            isAuthenticated: true,
            isGuest: false,
            provider: "access-key",
        }),
        credential: protectAccessKeyValue({ kind: "access-key", id: row.id, name: row.name }),
        grants: JSON.parse(row.grantsJson),
        record: row,
        admittedAt: now.toISOString(),
    };
}
export function accessKeyAuthenticationError(reason, limited = false) {
    const error = commandError(limited ? "Too many authentication attempts." : "Unauthenticated.", limited ? "Retry the request later." : "Provide a valid Access key and retry the request.", limited ? "AUTH_RATE_LIMITED" : "UNAUTHENTICATED");
    error.sporadesAccessKeyFailure = limited ? "limited" : "invalid";
    error.sporadesAccessKeyReason = reason;
    return error;
}
export function emitAccessKeyAdmittedAudit(database, context, record) {
    database.log?.emit?.({
        category: "platform",
        event: "access-key.admitted",
        level: "info",
        message: "Access key admitted for its owner.",
        data: {
            actor: { userId: context.auth.userId },
            credential: { kind: "access-key", id: context.credential.id, name: context.credential.name },
            accessKey: { id: record.id, name: record.name },
            handler: { kind: context.kind, path: context.request?.path ?? null },
        },
    });
}
export function createAccessKeySecret() {
    const selector = accessKeyCrypto().randomBytes(16).toString("base64url");
    const verifier = accessKeyCrypto().randomBytes(32).toString("base64url");
    return { selector, verifier, token: `spk_1_${selector}_${verifier}` };
}
export function accessKeyVerifierDigest(selector, verifier) {
    return accessKeyCrypto().createHash("sha256")
        .update("sporades-access-key-v1\0", "utf8")
        .update(Buffer.from(selector, "base64url"))
        .update(Buffer.from(verifier, "base64url"))
        .digest("hex");
}
function requireOwnerSessionContext(context) {
    if (!["query", "mutation", "endpoint", "message"].includes(context?.kind)
        || context?.credential?.kind !== "session"
        || context?.auth?.isAuthenticated !== true
        || context?.auth?.isGuest === true) {
        throw commandError("Access-key owner approval requires a linked Session.", "Sign in interactively and retry the Access-key operation.", context?.auth?.isAuthenticated === true ? "FORBIDDEN" : "UNAUTHENTICATED");
    }
    return context;
}
function normalizeAccessKeyIssue(input, declaredScopes, now) {
    if (!isPlainObject(input) || Object.keys(input).some((key) => !["name", "grants", "expiresAt"].includes(key))) {
        throw commandError("Invalid Access-key issuance input.", "Pass name with optional grants and expiresAt.", "INVALID_ACCESS_KEY_NAME");
    }
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || Array.from(name).length > 128) {
        throw commandError("Invalid Access-key name.", "Use a non-empty name of at most 128 Unicode characters.", "INVALID_ACCESS_KEY_NAME");
    }
    const grants = normalizeAccessKeyGrants(input.grants, declaredScopes);
    let expiresAt = null;
    if (input.expiresAt !== undefined && input.expiresAt !== null) {
        const parsed = typeof input.expiresAt === "string" ? Date.parse(input.expiresAt) : Number.NaN;
        if (!Number.isFinite(parsed) || parsed <= now.getTime()) {
            throw commandError("Invalid Access-key expiry.", "Pass an ISO instant later than issuance.", "INVALID_ACCESS_KEY_EXPIRY");
        }
        expiresAt = new Date(parsed).toISOString();
    }
    return { name, grants, expiresAt, createdAt: now.toISOString() };
}
function normalizeAccessKeyGrants(value, declaredScopes) {
    const grants = value === undefined ? ["*"] : value;
    if (!Array.isArray(grants) || grants.length === 0 || grants.length > ACCESS_KEY_GRANT_LIMIT) {
        throw invalidAccessKeyGrantsError();
    }
    const result = [];
    for (const grant of grants) {
        if (typeof grant !== "string"
            || !grant
            || Buffer.byteLength(grant, "utf8") > ACCESS_KEY_GRANT_BYTE_LIMIT
            || result.includes(grant)
            || (grant !== "*" && !declaredScopes.some((scope) => scopeGrantMatches(grant, scope)))) {
            throw invalidAccessKeyGrantsError();
        }
        result.push(grant);
    }
    result.sort();
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > ACCESS_KEY_GRANTS_JSON_BYTE_LIMIT)
        throw invalidAccessKeyGrantsError();
    return result;
}
function normalizeAccessKeyListOptions(value) {
    if (!isPlainObject(value) || Object.keys(value).some((key) => !["cursor", "limit", "status"].includes(key))) {
        throw commandError("Invalid Access-key list options.", "Use cursor, limit, and status only.", "INVALID_ACCESS_KEY_LIST_OPTIONS");
    }
    const limit = value.limit === undefined ? 50 : value.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw commandError("Invalid Access-key list limit.", "Use a limit from 1 through 100.", "INVALID_ACCESS_KEY_LIST_OPTIONS");
    }
    if (value.status !== undefined && !["active", "expired", "revoked"].includes(value.status)) {
        throw commandError("Invalid Access-key status filter.", "Use active, expired, or revoked.", "INVALID_ACCESS_KEY_LIST_OPTIONS");
    }
    let cursor = null;
    if (value.cursor !== undefined) {
        try {
            cursor = JSON.parse(Buffer.from(value.cursor, "base64url").toString("utf8"));
        }
        catch {
            cursor = null;
        }
        if (!isPlainObject(cursor) || typeof cursor.createdAt !== "string" || typeof cursor.id !== "string") {
            throw commandError("Invalid Access-key list cursor.", "Use the opaque nextCursor returned by list().", "INVALID_ACCESS_KEY_LIST_OPTIONS");
        }
    }
    return { cursor, limit, status: value.status ?? null };
}
function accessKeyListPage(rows, declaredScopes, now, options) {
    let summaries = rows.map((row) => accessKeySummary(row, declaredScopes, now.toISOString()));
    if (options.status)
        summaries = summaries.filter((summary) => summary.status === options.status);
    const totalCount = summaries.length;
    if (options.cursor) {
        summaries = summaries.filter((summary) => summary.createdAt < options.cursor.createdAt
            || (summary.createdAt === options.cursor.createdAt && summary.id < options.cursor.id));
    }
    const page = summaries.slice(0, options.limit);
    const next = summaries.length > options.limit ? page.at(-1) : null;
    return {
        accessKeys: page,
        declaredScopes: [...declaredScopes].sort(),
        nextCursor: next ? Buffer.from(JSON.stringify({ createdAt: next.createdAt, id: next.id }), "utf8").toString("base64url") : null,
        totalCount,
    };
}
function accessKeySummary(row, declaredScopes, now) {
    const grants = Array.isArray(row.grants) ? row.grants : JSON.parse(row.grantsJson);
    const status = row.revokedAt ? "revoked" : row.expiresAt && Date.parse(row.expiresAt) <= Date.parse(now) ? "expired" : "active";
    return {
        id: row.id,
        name: row.name,
        grants: [...grants],
        effectiveScopes: [...declaredScopes].filter((scope) => accessKeyGrantsSatisfyScopes(grants, [scope])).sort(),
        status,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt ?? null,
        rotatedAt: row.rotatedAt ?? null,
        revokedAt: row.revokedAt ?? null,
        revocationCause: row.revocationCause ?? null,
        lastUsedAt: row.lastUsedAt ?? null,
        lifecycleRevision: Number(row.lifecycleRevision),
    };
}
function withAccessKeyTransaction(database, operation) {
    return database.__transactionActive
        ? operation(database.adapter)
        : database.adapter.withTransaction(operation);
}
function emitOwnerAccessKeyAudit(database, event, context, accessKey) {
    database.log?.emit?.({
        category: "platform",
        event,
        level: "info",
        message: event === "access-key.issued" ? "Access key issued by its owner." : "Access key revoked by its owner.",
        data: {
            actor: { userId: context.auth.userId },
            credential: { kind: "session" },
            accessKey: { id: accessKey.id, name: accessKey.name },
        },
    });
}
function protectAccessKeyValue(value) {
    const target = Object.freeze({ ...value });
    const tampered = () => { throw commandError("Invalid Capsule context middleware result.", "Runtime-owned Auth and Credential values are immutable.", "INVALID_CONTEXT_MIDDLEWARE_RESULT"); };
    return new Proxy(target, { set: tampered, defineProperty: tampered, deleteProperty: tampered, setPrototypeOf: tampered });
}
function accessKeySelectorFingerprint(selector) {
    return accessKeyCrypto().createHash("sha256").update("sporades-access-key-selector-limit\0").update(selector).digest("hex");
}
function accessKeySourceBucket(request) {
    return accessKeyCrypto().createHash("sha256")
        .update("sporades-access-key-source-limit\0")
        .update(String(request?.socket?.remoteAddress ?? "unknown"))
        .digest("hex");
}
function accessKeyLimiter(database, kind) {
    const root = database.__rootDatabase ?? database;
    root.__accessKeyFailureLimiters ??= { source: new Map(), selector: new Map() };
    return root.__accessKeyFailureLimiters[kind];
}
function assertAccessKeyFailureLimit(database, kind, key, limit, windowMs) {
    const state = accessKeyLimiter(database, kind).get(key);
    const now = database.clock.now().getTime();
    if (state && now - state.startedAt < windowMs && state.count >= limit)
        throw accessKeyAuthenticationError("rate-limited", true);
}
function recordAccessKeyFailure(database, kind, key, windowMs) {
    const limiter = accessKeyLimiter(database, kind);
    const now = database.clock.now().getTime();
    const previous = limiter.get(key);
    const state = !previous || now - previous.startedAt >= windowMs
        ? { count: 1, startedAt: now, lastSeenAt: now }
        : { count: previous.count + 1, startedAt: previous.startedAt, lastSeenAt: now };
    limiter.delete(key);
    limiter.set(key, state);
    for (const [candidate, candidateState] of limiter) {
        if (now - candidateState.lastSeenAt > 15 * 60_000 || limiter.size > 10_000)
            limiter.delete(candidate);
        else
            break;
    }
}
function clearAccessKeyFailure(database, kind, key) {
    accessKeyLimiter(database, kind).delete(key);
}
function throwAccessKeyIssueError(status) {
    if (status === "owner-ineligible") {
        throw commandError("Access-key owner is not eligible.", "Use a currently linked non-guest user.", "FORBIDDEN");
    }
    if (status === "name-conflict") {
        throw commandError("An Access key already uses that name.", "Choose a unique current Access-key name.", "ACCESS_KEY_NAME_CONFLICT");
    }
    throw commandError("Access-key owner limit reached.", "Revoke or delete retained Access keys before issuing another.", "ACCESS_KEY_LIMIT_REACHED");
}
function accessKeyNotFoundError() {
    return commandError("Access key not found.", "Refresh the current user's Access-key list.", "ACCESS_KEY_NOT_FOUND");
}
function invalidAccessKeyGrantsError() {
    return commandError("Invalid Access-key grants.", "Use 1 through 128 unique grant expressions that match the Capsule's declared scopes.", "INVALID_ACCESS_KEY_GRANTS");
}
function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
//# sourceMappingURL=access-keys-runtime.js.map