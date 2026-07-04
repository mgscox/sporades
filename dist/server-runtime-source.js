// @ts-nocheck
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
export const SERVER_RUNTIME_SOURCE_FUNCTIONS = [
    readJsonRequest,
    prepareHttpSecurity,
    resolveRuntimeSecurityPolicy,
    defaultRuntimeCspDirectives,
    serializeCspDirectives,
    requestOriginAllowed,
    isSameOriginRequest,
    isLocalDevOrigin,
    appendVaryHeader,
    sanitizeResponseHeaders,
    createSqliteDatabaseAdapter,
    createLibsqlDatabaseAdapter,
    createRuntimeDatabaseAdapter,
    libsqlPipelineUrl,
    assertLibsqlOpen,
    libsqlHasMultipleStatements,
    libsqlExecute,
    libsqlDescribe,
    libsqlPipeline,
    libsqlRowsFromResult,
    libsqlValueFromJs,
    libsqlValueToJs,
    ensureLibsqlSessionLifecycleColumns,
    migrateLibsqlAppSchema,
    migrateExistingLibsqlAppTable,
    splitSqlStatements,
    openDevDatabase,
    createRuntimeLogSink,
    requirePathModule,
    createRuntimeLogger,
    createLogEnvelope,
    sanitizeLogData,
    redactLogData,
    logDataContainsServerEnvValue,
    isSensitiveLogKey,
    capLogEnvelope,
    createLogIndexTables,
    insertLogIndexEvent,
    pruneLogIndex,
    readRecentLogEvents,
    readJsonlLogEvents,
    logIndexLimit,
    logPayloadMaxBytes,
    logRedactedValue,
    targetsInternalLogIndexTable,
    readSqlTableReference,
    skipSqlTrivia,
    readSqlIdentifier,
    isInternalLogIndexMetadataRow,
    extractSchema,
    schemaFromCapsuleDefinition,
    schemaTableFromCapsuleTable,
    normalizeTableAcl,
    resolveEffectiveAclRule,
    schemaFieldFromCapsuleField,
    sqliteTypeForFieldKind,
    extractEndpoints,
    extractQueryHandlers,
    extractQueryHandlersFromCapsule,
    extractMutationHandlers,
    handlersFromCapsuleDefinition,
    mutationHandlersFromCapsuleDefinition,
    shouldUseBundledMutationHandler,
    isInlineHandlerSource,
    isGeneratedScaffoldMutationHandler,
    extractMessageHandlers,
    extractContextMiddleware,
    extractMutationHooks,
    extractHookList,
    extractFields,
    extractFieldDefaultSource,
    parseFieldDefault,
    parseDateFieldDefault,
    parseJsonFieldDefault,
    extractObjectPropertySource,
    findMatchingDelimiter,
    splitTopLevelList,
    migrateAppSchema,
    normalizeSchema,
    hashSchema,
    assertValidReferenceTargets,
    assertAdditiveSchemaMigration,
    migrateExistingAppTable,
    columnSelectExpressionForMigration,
    addedFieldsForTable,
    createAppTable,
    appTableColumnDefinitions,
    appFieldColumnDefinition,
    fieldDefaultIsSqlNull,
    fieldColumnDefaultSql,
    commandError,
    toSqlLiteral,
    findMatchingParen,
    createEndpointContext,
    createContextHolder,
    createTableAclContext,
    applyContextMiddleware,
    runContextMiddleware,
    readEndpointSessionToken,
    createEndpointDatabaseApi,
    createEndpointTableApi,
    runTableWriteWithAcl,
    isPromiseLike,
    thenIfPromise,
    chainMaybePromise,
    applyReadAcl,
    filterRowsByReadAcl,
    createAclHelpers,
    createAclDbHelpers,
    createAclStorageHelpers,
    assertAclHelperReadAllowed,
    resolveAclAppTable,
    resolveAclStorageResource,
    aclStorageMetadataFromFileRow,
    emitAclDeniedLog,
    createAclDenialLogData,
    aclRuleDeclaredOperation,
    aclRowLogSnapshot,
    aclVisibleFieldNames,
    createAclDeniedError,
    fieldValueForWrite,
    invalidReferenceError,
    referenceExists,
    serializeFieldValue,
    deserializeFieldValue,
    normalizeDateValue,
    dateValueError,
    assertJsonCompatible,
    invalidJsonFieldValueError,
    deserializeRow,
    readEndpointBody,
    createEndpointLogger,
    authStatus,
    normalizeAuthConfig,
    readProviderConfig,
    createFileStorageTables,
    routeRuntimeHealth,
    createRuntimeHealthResult,
    checkRuntimeSqlite,
    checkRuntimeFileStorage,
    handleFileHttpRoute,
    readRequestBytes,
    writeJsonHttpResponse,
    writeNotFound,
    sendFileHttpResponse,
    createPendingFileUpload,
    completePendingFileUpload,
    getPrivateFileUrl,
    createPublicFileUrl,
    revokePublicFileUrl,
    deletePrivateFile,
    fileMetadataFromRow,
    createStructuredFileError,
    validatePublicUrlExpiry,
    fileRowForOwner,
    fileStoragePath,
    fileVersionPath,
    removeFileVersionBestEffort,
    contentTypeForFile,
    createAnonymousAuthTables,
    ensureSessionLifecycleColumns,
    sessionExpiresAt,
    isExpiredSession,
    createSessionToken,
    refreshSession,
    rotateSession,
    resolveAnonymousSession,
    sessionFromRow,
    authProvidersForClient,
    routeSporadesAuth,
    signUpWithEmail,
    signInWithEmail,
    normalizeEmailCredentials,
    hashEmailPassword,
    verifyEmailPassword,
    emailAuthDisabledError,
    beginGoogleSignIn,
    normalizeReturnTo,
    exchangeGoogleCode,
    readGoogleOAuthError,
    oauthErrorHint,
    fetchGoogleProfile,
    linkGoogleAccount,
    writeRedirect,
    createWebSocketAccept,
    createWebSocketHub,
    drainWebSocketFrames,
    sendJson,
    routeEndpoint,
    runEndpoint,
    writeEndpointResult,
    writeEndpointError,
    endpointResponseError,
    runQuery,
    runCustomQuery,
    runMutation,
    runCustomMutation,
    runAppMessage,
    validateAppMessageType,
    isAllAppMessageScope,
    runMutationHook,
    createMutationContext,
    drainPendingAclWrites,
    createMessageContext,
    createHookErrorResult,
    runInsertMutation,
    runUpdateMutation,
    formatMutationResult,
    resolveTableForQuery,
    resolveTableForAddMutation,
    resolveTableForUpdateMutation,
    tableNameForSingular,
    rowToApiValue,
    toSqlNumber,
    quoteIdentifier,
];
export async function readJsonRequest(request) {
    const chunks = [];
    for await (const chunk of request) {
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
}
export function prepareHttpSecurity(database, request, response) {
    const policy = database.securityPolicy ?? resolveRuntimeSecurityPolicy({});
    const originalWriteHead = response.writeHead.bind(response);
    response.writeHead = (statusCode, statusMessageOrHeaders, maybeHeaders) => {
        const statusMessage = typeof statusMessageOrHeaders === "string" ? statusMessageOrHeaders : undefined;
        const inputHeaders = statusMessage ? maybeHeaders : statusMessageOrHeaders;
        const headers = {
            ...sanitizeResponseHeaders(inputHeaders ?? {}),
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "x-frame-options": "DENY",
            "permissions-policy": "camera=(), microphone=(), geolocation=()",
            "cross-origin-opener-policy": "same-origin",
            [policy.csp.header]: serializeCspDirectives(policy.csp.directives),
        };
        const origin = request.headers.origin;
        if (requestOriginAllowed(policy, request)) {
            headers["access-control-allow-origin"] = policy.cors.publicDev ? "*" : origin;
            if (!policy.cors.publicDev) {
                headers.vary = appendVaryHeader(headers.vary, "Origin");
            }
        }
        if (statusMessage) {
            return originalWriteHead(statusCode, statusMessage, headers);
        }
        return originalWriteHead(statusCode, headers);
    };
    if (request.method === "OPTIONS" && request.headers.origin && request.headers["access-control-request-method"]) {
        const headers = {
            "content-length": "0",
        };
        if (requestOriginAllowed(policy, request)) {
            headers["access-control-allow-origin"] = policy.cors.publicDev ? "*" : request.headers.origin;
            headers["access-control-allow-methods"] = "GET,POST,PUT,DELETE,OPTIONS";
            headers["access-control-allow-headers"] =
                request.headers["access-control-request-headers"] ?? "content-type,x-sporades-session-token";
            headers["access-control-max-age"] = "600";
            if (!policy.cors.publicDev) {
                headers.vary = "Origin";
            }
        }
        response.writeHead(204, headers);
        response.end();
        return true;
    }
    return false;
}
function resolveRuntimeSecurityPolicy(config = {}) {
    const security = config.security ?? {};
    const cors = security.cors ?? {};
    const csp = security.csp ?? {};
    const session = config.__sporadesSession ?? "container";
    const publicDev = session === "public-dev";
    const dev = session === "dev" || publicDev;
    const configuredOrigins = Array.isArray(cors.allowedOrigins) ? cors.allowedOrigins.filter((origin) => typeof origin === "string") : [];
    const directives = {
        ...defaultRuntimeCspDirectives(),
        ...(csp.directives && typeof csp.directives === "object" && !Array.isArray(csp.directives) ? csp.directives : {}),
    };
    const mode = csp.mode === "enforce" ? "enforce" : "report-only";
    return {
        cors: {
            sameOrigin: !publicDev,
            publicDev,
            allowedOrigins: publicDev ? ["*"] : configuredOrigins,
            allowedOriginPatterns: dev && !publicDev ? ["http://localhost:*", "http://127.0.0.1:*"] : [],
            requireExplicitCrossOrigin: !dev && configuredOrigins.length === 0,
        },
        csp: {
            mode,
            header: mode === "enforce" ? "content-security-policy" : "content-security-policy-report-only",
            directives,
        },
    };
}
function defaultRuntimeCspDirectives() {
    return {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "blob:"],
        "connect-src": ["'self'", "ws:", "wss:"],
        "font-src": ["'self'", "data:"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "frame-ancestors": ["'none'"],
    };
}
function serializeCspDirectives(directives) {
    return Object.entries(directives)
        .map(([name, values]) => `${name} ${Array.isArray(values) ? values.join(" ") : String(values)}`)
        .join("; ");
}
function requestOriginAllowed(policy, request) {
    const origin = request.headers.origin;
    if (!origin) {
        return false;
    }
    if (policy.cors.publicDev) {
        return true;
    }
    if (policy.cors.allowedOrigins.includes("*") || policy.cors.allowedOrigins.includes(origin)) {
        return true;
    }
    if (policy.cors.sameOrigin && isSameOriginRequest(request, origin)) {
        return true;
    }
    return policy.cors.allowedOriginPatterns.length > 0 && isLocalDevOrigin(origin);
}
function isSameOriginRequest(request, origin) {
    const host = request.headers["x-forwarded-host"] ?? request.headers.host;
    if (!host) {
        return false;
    }
    const protocol = request.headers["x-forwarded-proto"] ?? (request.socket?.encrypted ? "https" : "http");
    return origin === `${protocol}://${host}`;
}
function isLocalDevOrigin(origin) {
    try {
        const parsed = new URL(origin);
        return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    }
    catch {
        return false;
    }
}
function appendVaryHeader(existing, value) {
    if (!existing) {
        return value;
    }
    const parts = String(existing)
        .split(",")
        .map((part) => part.trim().toLowerCase());
    return parts.includes(value.toLowerCase()) ? existing : `${existing}, ${value}`;
}
function sanitizeResponseHeaders(headers) {
    const entries = headers instanceof Map ? headers.entries() : Object.entries(headers ?? {});
    return Object.fromEntries([...entries].filter(([name]) => {
        const normalized = String(name).toLowerCase();
        return normalized !== "x-powered-by" && normalized !== "server";
    }));
}
export async function openDevDatabase(databasePath, serverSource, serverEnv = {}, config = {}, capsuleDefinition = null, options = {}) {
    const path = await import("node:path");
    const sqlite = await createRuntimeDatabaseAdapter(databasePath, options?.serviceEnv ?? serverEnv, config);
    const schema = capsuleDefinition ? schemaFromCapsuleDefinition(capsuleDefinition) : extractSchema(serverSource);
    const endpoints = extractEndpoints(serverSource);
    const queries = extractQueryHandlersFromCapsule(capsuleDefinition) ?? extractQueryHandlers(serverSource);
    const mutations = capsuleDefinition
        ? mutationHandlersFromCapsuleDefinition(serverSource, capsuleDefinition)
        : extractMutationHandlers(serverSource);
    const messages = extractMessageHandlers(serverSource);
    const contextMiddleware = extractContextMiddleware(serverSource);
    const mutationHooks = extractMutationHooks(serverSource);
    const rowCache = new Map();
    const database = {
        adapter: sqlite,
        sqlite,
        schema,
        endpoints,
        queries,
        mutations,
        messages,
        contextMiddleware,
        mutationHooks,
        rowCache,
        serverEnv,
        authConfig: authStatus(config, serverEnv),
        securityPolicy: resolveRuntimeSecurityPolicy(config),
        fileStoragePath: config.files?.storagePath ?? path.join(path.dirname(databasePath), "files"),
        fileMaxSizeBytes: config.files?.maxSizeBytes ?? 10 * 1024 * 1024,
        close: () => sqlite.close(),
    };
    database.log = createRuntimeLogSink({
        database: sqlite,
        config,
        serverEnv,
        dataDir: path.dirname(databasePath),
    });
    await sqlite.ensureSystemTable();
    await sqlite.ensureAuthStorage(database.authConfig);
    await sqlite.ensureFileStorage();
    await sqlite.ensureLogStorage();
    assertValidReferenceTargets(schema);
    await sqlite.migrateAppSchema(schema);
    return database;
}
async function createRuntimeDatabaseAdapter(databasePath, serverEnv = {}, config = {}) {
    if (config.services?.database?.engine === "libsql" &&
        serverEnv.SPORADES_SERVICE_DATABASE_ENGINE === "libsql" &&
        serverEnv.SPORADES_SERVICE_DATABASE_URL) {
        return await createLibsqlDatabaseAdapter({
            url: serverEnv.SPORADES_SERVICE_DATABASE_URL,
            authToken: serverEnv.SPORADES_SERVICE_DATABASE_AUTH_TOKEN,
        });
    }
    return await createSqliteDatabaseAdapter(databasePath);
}
export async function createSqliteDatabaseAdapter(databasePath, options = {}) {
    const { DatabaseSync } = await import("node:sqlite");
    const path = await import("node:path");
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const connection = new DatabaseSync(databasePath, { readOnly: Boolean(options.readOnly) });
    const adapter = {
        engine: "sqlite",
        exec(sql) {
            return connection.exec(sql);
        },
        prepare(sql) {
            const statement = connection.prepare(sql);
            return {
                all(...params) {
                    return statement.all(...params);
                },
                get(...params) {
                    return statement.get(...params);
                },
                run(...params) {
                    return statement.run(...params);
                },
                columns() {
                    return statement.columns();
                },
            };
        },
        ensureSystemTable() {
            return this.exec("CREATE TABLE IF NOT EXISTS sporades (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        },
        readSystemMetadata(key) {
            return this.prepare("SELECT value FROM sporades WHERE key = ?").get(key) ?? null;
        },
        writeSystemMetadata(key, value) {
            return this.prepare("INSERT OR REPLACE INTO sporades (key, value) VALUES (?, ?)").run(key, value);
        },
        readSchemaMetadata() {
            return this.readSystemMetadata("schema");
        },
        writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }) {
            this.writeSystemMetadata("schemaVersion", schemaVersion);
            this.writeSystemMetadata("schemaHash", schemaHash);
            this.writeSystemMetadata("schema", schemaJson);
        },
        ensureLogStorage() {
            return createLogIndexTables(this);
        },
        insertLogIndexEvent(event) {
            return insertLogIndexEvent(this, event);
        },
        pruneLogIndex(limit) {
            return pruneLogIndex(this, limit);
        },
        readRecentLogEvents(limit) {
            return readRecentLogEvents(this, limit);
        },
        ensureFileStorage() {
            return createFileStorageTables(this);
        },
        findFileBucket(ownerId, name) {
            return this.prepare("SELECT * FROM sporades_file_buckets WHERE ownerId = ? AND name = ?").get(ownerId, name) ?? null;
        },
        createFileBucket(row) {
            return this.prepare("INSERT INTO sporades_file_buckets (id, ownerId, name, createdAt) VALUES (?, ?, ?, ?)").run(row.id, row.ownerId, row.name, row.createdAt);
        },
        insertFileRow(row) {
            return this.prepare("INSERT INTO sporades_files " +
                "(id, ownerId, bucketId, bucketName, name, type, size, version, status, createdAt, updatedAt, deletedAt) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)").run(row.id, row.ownerId, row.bucketId, row.bucketName, row.name, row.type, row.size, row.version, row.status, row.createdAt, row.updatedAt);
        },
        updatePendingFileRow(row) {
            return this.prepare("UPDATE sporades_files SET name = ?, type = ?, size = ?, version = ?, status = ?, updatedAt = ?, deletedAt = NULL WHERE id = ?").run(row.name, row.type, row.size, row.version, row.status, row.updatedAt, row.id);
        },
        insertFileUpload(row) {
            return this.prepare("INSERT INTO sporades_file_uploads (id, fileId, ownerId, version, expectedSize, createdAt) VALUES (?, ?, ?, ?, ?, ?)").run(row.id, row.fileId, row.ownerId, row.version, row.expectedSize, row.createdAt);
        },
        selectFileById(fileId) {
            return this.prepare("SELECT * FROM sporades_files WHERE id = ?").get(fileId) ?? null;
        },
        selectFileUpload(uploadId) {
            return this.prepare("SELECT * FROM sporades_file_uploads WHERE id = ?").get(uploadId) ?? null;
        },
        completeFileUpload(upload, size, updatedAt) {
            return this.prepare("UPDATE sporades_files SET size = ?, status = ?, updatedAt = ? WHERE id = ? AND version = ?").run(size, "uploaded", updatedAt, upload.fileId, upload.version);
        },
        deleteFileUpload(uploadId) {
            return this.prepare("DELETE FROM sporades_file_uploads WHERE id = ?").run(uploadId);
        },
        selectPublicFileRow(publicUrlId) {
            return (this.prepare("SELECT p.id AS publicUrlId, p.fileId, p.version AS publicVersion, p.expiresAt, p.revokedAt, " +
                "f.id, f.ownerId, f.bucketId, f.bucketName, f.name, f.type, f.size, f.version, f.status, f.createdAt, f.updatedAt, f.deletedAt " +
                "FROM sporades_file_public_urls p JOIN sporades_files f ON f.id = p.fileId " +
                "WHERE p.id = ?").get(publicUrlId) ?? null);
        },
        insertPublicFileUrl(row) {
            return this.prepare("INSERT INTO sporades_file_public_urls (id, fileId, ownerId, version, expiresAt, createdAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?, NULL)").run(row.id, row.fileId, row.ownerId, row.version, row.expiresAt, row.createdAt);
        },
        revokePublicFileUrl(publicUrlId, ownerId, revokedAt) {
            return this.prepare("UPDATE sporades_file_public_urls SET revokedAt = ? WHERE id = ? AND ownerId = ? AND revokedAt IS NULL").run(revokedAt, publicUrlId, ownerId);
        },
        revokePublicFileUrlsForFile(fileId, revokedAt) {
            return this.prepare("UPDATE sporades_file_public_urls SET revokedAt = ? WHERE fileId = ? AND revokedAt IS NULL").run(revokedAt, fileId);
        },
        markFileDeleted(fileId, deletedAt) {
            return this.prepare("UPDATE sporades_files SET deletedAt = ?, updatedAt = ? WHERE id = ?").run(deletedAt, deletedAt, fileId);
        },
        fileRowForOwner(fileId, ownerId) {
            return (this.prepare("SELECT * FROM sporades_files WHERE id = ? AND ownerId = ? AND deletedAt IS NULL AND status = ?").get(fileId, ownerId, "uploaded") ?? null);
        },
        ensureAuthStorage(authConfig = null) {
            return createAnonymousAuthTables(this, authConfig);
        },
        findAuthUserByProviderEmail(provider, email) {
            return this.prepare("SELECT id FROM sporades_auth_users WHERE provider = ? AND email = ?").get(provider, email) ?? null;
        },
        insertAuthUser(row) {
            return this.prepare("INSERT INTO sporades_auth_users " +
                "(id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(row.id, row.createdAt, row.displayName, row.email, row.picture, row.isAuthenticated, row.isGuest, row.provider);
        },
        updateAuthUserProfile(row) {
            return this.prepare("UPDATE sporades_auth_users SET displayName = ?, picture = ?, isAuthenticated = ?, isGuest = ? WHERE id = ?").run(row.displayName, row.picture, row.isAuthenticated, row.isGuest, row.id);
        },
        linkAuthUser(row) {
            return this.prepare("UPDATE sporades_auth_users SET displayName = ?, email = ?, picture = ?, isAuthenticated = ?, isGuest = ?, provider = ? WHERE id = ?").run(row.displayName, row.email, row.picture, row.isAuthenticated, row.isGuest, row.provider, row.id);
        },
        insertAuthSession(row) {
            return this.prepare("INSERT INTO sporades_auth_sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)").run(row.token, row.userId, row.createdAt, row.expiresAt);
        },
        deleteAuthSession(token) {
            return this.prepare("DELETE FROM sporades_auth_sessions WHERE token = ?").run(token);
        },
        refreshAuthSession(token, expiresAt) {
            return this.prepare("UPDATE sporades_auth_sessions SET expiresAt = ? WHERE token = ?").run(expiresAt, token);
        },
        rotateAuthSession(previousToken, row) {
            return this.prepare("UPDATE sporades_auth_sessions SET token = ?, userId = ?, createdAt = ?, expiresAt = ? WHERE token = ?").run(row.token, row.userId, row.createdAt, row.expiresAt, previousToken);
        },
        readAuthSessionWithUser(token) {
            return (this.prepare("SELECT s.token, s.expiresAt, u.id AS userId, u.displayName, u.email, u.picture, u.isAuthenticated, u.isGuest, u.provider " +
                "FROM sporades_auth_sessions s " +
                "JOIN sporades_auth_users u ON u.id = s.userId " +
                "WHERE s.token = ?").get(token) ?? null);
        },
        insertOAuthState(row) {
            return this.prepare("INSERT INTO sporades_auth_oauth_states (state, sessionToken, returnTo, redirectUri, createdAt) VALUES (?, ?, ?, ?, ?)").run(row.state, row.sessionToken, row.returnTo, row.redirectUri, row.createdAt);
        },
        consumeOAuthState(state) {
            const row = this.prepare("SELECT state, sessionToken, returnTo, redirectUri FROM sporades_auth_oauth_states WHERE state = ?").get(state) ??
                null;
            this.prepare("DELETE FROM sporades_auth_oauth_states WHERE state = ?").run(state);
            return row;
        },
        emailCredentialExists(email) {
            return Boolean(this.prepare("SELECT email FROM sporades_auth_email_credentials WHERE email = ?").get(email));
        },
        insertEmailCredential(row) {
            return this.prepare("INSERT INTO sporades_auth_email_credentials (email, userId, passwordHash, passwordSalt, createdAt) VALUES (?, ?, ?, ?, ?)").run(row.email, row.userId, row.passwordHash, row.passwordSalt, row.createdAt);
        },
        findEmailCredentialWithUser(email) {
            return (this.prepare("SELECT c.email, c.userId, c.passwordHash, c.passwordSalt, u.displayName, u.picture, u.isAuthenticated, u.isGuest, u.provider " +
                "FROM sporades_auth_email_credentials c " +
                "JOIN sporades_auth_users u ON u.id = c.userId " +
                "WHERE c.email = ?").get(email) ?? null);
        },
        migrateAppSchema(schema) {
            return migrateAppSchema(this, schema);
        },
        createAppTable(table, tableName = table.name) {
            return createAppTable(this, table, tableName);
        },
        migrateExistingAppTable(existingTable, nextTable) {
            return migrateExistingAppTable(this, existingTable, nextTable);
        },
        referenceExists(field, value) {
            return Boolean(this.prepare(`SELECT 1 FROM ${quoteIdentifier(field.targetTable)} WHERE id = ? LIMIT 1`).get(String(value)));
        },
        async withTransaction(fn) {
            this.exec("BEGIN");
            try {
                const result = await fn(this);
                this.exec("COMMIT");
                return result;
            }
            catch (error) {
                this.exec("ROLLBACK");
                throw error;
            }
        },
        insertAppRow(table, row) {
            const columns = Object.keys(row);
            return this.prepare(`INSERT INTO ${quoteIdentifier(table.name)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns
                .map(() => "?")
                .join(", ")})`).run(...columns.map((column) => row[column]));
        },
        selectAppRowById(table, id) {
            return this.prepare(`SELECT * FROM ${quoteIdentifier(table.name)} WHERE id = ?`).get(String(id)) ?? null;
        },
        updateAppRow(table, id, values, options = {}) {
            const columns = Object.keys(values);
            if (columns.length === 0) {
                return { changes: 0 };
            }
            return this.prepare(`UPDATE ${quoteIdentifier(table.name)} SET ${columns.map((column) => `${quoteIdentifier(column)} = ?`).join(", ")} WHERE id = ?` +
                (options.ownerId === undefined ? "" : " AND ownerId = ?")).run(...columns.map((column) => values[column]), String(id), ...(options.ownerId === undefined ? [] : [options.ownerId]));
        },
        deleteAppRow(table, id) {
            return this.prepare(`DELETE FROM ${quoteIdentifier(table.name)} WHERE id = ?`).run(String(id));
        },
        selectAppRows(table, query = {}) {
            const columns = query.columns ?? ["*"];
            const whereClauses = [];
            const params = [];
            if (query.ownerId !== undefined) {
                whereClauses.push(`${quoteIdentifier("ownerId")} = ?`);
                params.push(query.ownerId);
            }
            if (query.where) {
                whereClauses.push(`${quoteIdentifier(query.where.fieldName)} = ?`);
                params.push(query.where.value);
            }
            const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(" AND ")}` : "";
            const orderSql = query.orderBy
                ? ` ORDER BY ${quoteIdentifier(query.orderBy.fieldName)} ${String(query.orderBy.direction).toLowerCase() === "desc" ? "DESC" : "ASC"}`
                : "";
            const limit = Number.isInteger(query.limit) && query.limit >= 0 ? query.limit : null;
            const limitSql = limit === null ? "" : " LIMIT ?";
            return this.prepare(`SELECT ${columns.map((column) => (column === "*" ? "*" : quoteIdentifier(column))).join(", ")} FROM ${quoteIdentifier(table.name)}${whereSql}${orderSql}${limitSql}`).all(...(limit === null ? params : [...params, limit]));
        },
        listInspectableTables() {
            return this.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
                .all()
                .map((row) => row.name)
                .filter((name) => name !== "sporades_log_events");
        },
        dumpInspectableDatabase() {
            return this.listInspectableTables().map((tableName) => ({
                name: tableName,
                columns: this.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
                    .all()
                    .map((column) => column.name),
                rows: this.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`).all(),
            }));
        },
        runReadOnlyInspectionQuery(sql) {
            try {
                if (targetsInternalLogIndexTable(sql)) {
                    return {
                        ok: false,
                        data: null,
                        error: {
                            message: "Internal log index tables are not available through generic DB inspection.",
                            hint: "Use `sporades logs --json` or `sporades logs tail --json` to inspect Capsule logs.",
                        },
                    };
                }
                const statement = this.prepare(sql);
                const columns = statement.columns().map((column) => column.name);
                const rows = statement.all().filter((row) => !isInternalLogIndexMetadataRow(row, sql));
                return {
                    ok: true,
                    data: {
                        columns,
                        rows,
                    },
                    error: null,
                };
            }
            catch (error) {
                return {
                    ok: false,
                    data: null,
                    error: {
                        message: error.message,
                        hint: "Check the SQL syntax and table names, then retry the query.",
                    },
                };
            }
        },
        checkHealth() {
            try {
                this.prepare("SELECT 1 AS ok").get();
                return { ok: true };
            }
            catch {
                return { ok: false };
            }
        },
        close() {
            return connection.close();
        },
    };
    if (!options.readOnly) {
        adapter.exec("PRAGMA journal_mode = WAL");
    }
    return adapter;
}
export async function createLibsqlDatabaseAdapter(options) {
    const url = typeof options === "string" ? options : options?.url;
    if (!url) {
        throw commandError("Missing libSQL database service URL.", "Start a Dev session or local Container session with services.database.engine set to libsql.");
    }
    const endpoint = libsqlPipelineUrl(url);
    const authToken = typeof options === "object" ? options.authToken : null;
    let closed = false;
    const activeTransactions = new Set();
    const shape = await createSqliteDatabaseAdapter(":memory:");
    shape.close();
    const createOperations = (transaction = null) => ({
        exec(sql) {
            assertLibsqlOpen(closed);
            const request = libsqlHasMultipleStatements(sql)
                ? { type: "sequence", sql }
                : { type: "execute", stmt: { sql } };
            return libsqlPipeline({ endpoint, authToken, transaction, requests: [request], close: !transaction }).then(() => undefined);
        },
        prepare(sql) {
            assertLibsqlOpen(closed);
            return {
                all(...params) {
                    return libsqlExecute({ endpoint, authToken, transaction, sql, params, close: !transaction }).then((result) => libsqlRowsFromResult(result));
                },
                get(...params) {
                    return this.all(...params).then((rows) => rows[0] ?? null);
                },
                run(...params) {
                    return libsqlExecute({ endpoint, authToken, transaction, sql, params, close: !transaction }).then((result) => ({
                        changes: Number(result.affected_row_count ?? result.affectedRowCount ?? 0),
                        lastInsertRowid: result.last_insert_rowid === null || result.last_insert_rowid === undefined
                            ? undefined
                            : BigInt(result.last_insert_rowid),
                    }));
                },
                columns() {
                    return libsqlDescribe({ endpoint, authToken, transaction, sql, close: !transaction });
                },
            };
        },
    });
    const adapter = {
        ...shape,
        ...createOperations(),
        engine: "libsql",
        async writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }) {
            await this.writeSystemMetadata("schemaVersion", schemaVersion);
            await this.writeSystemMetadata("schemaHash", schemaHash);
            await this.writeSystemMetadata("schema", schemaJson);
        },
        async ensureLogStorage() {
            await this.exec("CREATE TABLE IF NOT EXISTS sporades_log_events (" +
                "id TEXT PRIMARY KEY, " +
                "timestamp TEXT NOT NULL, " +
                "category TEXT NOT NULL, " +
                "event TEXT NOT NULL, " +
                "level TEXT NOT NULL, " +
                "message TEXT NOT NULL, " +
                "capsuleName TEXT, " +
                "capsuleId TEXT, " +
                "releaseId TEXT, " +
                "requestId TEXT, " +
                "correlationId TEXT, " +
                "payload TEXT NOT NULL" +
                ")");
        },
        async insertLogIndexEvent(event) {
            await this.prepare("INSERT INTO sporades_log_events " +
                "(id, timestamp, category, event, level, message, capsuleName, capsuleId, releaseId, requestId, correlationId, payload) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), event.timestamp, event.category, event.event, event.level, event.message, event.capsule?.name ?? null, event.capsule?.id ?? null, event.release?.id ?? event.release ?? null, event.request?.id ?? null, event.correlation?.id ?? event.correlation ?? null, JSON.stringify(event));
        },
        async pruneLogIndex(limit) {
            await this.prepare("DELETE FROM sporades_log_events WHERE id IN (" +
                "SELECT id FROM sporades_log_events ORDER BY timestamp DESC, rowid DESC LIMIT -1 OFFSET ?" +
                ")").run(limit);
        },
        async readRecentLogEvents(limit = 200) {
            const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : 200;
            const rows = await this.prepare("SELECT payload FROM sporades_log_events ORDER BY timestamp DESC, rowid DESC LIMIT ?").all(safeLimit);
            return rows.reverse().map((row) => JSON.parse(row.payload));
        },
        async ensureFileStorage() {
            await this.exec("CREATE TABLE IF NOT EXISTS sporades_file_buckets (" +
                "id TEXT PRIMARY KEY, " +
                "ownerId TEXT NOT NULL, " +
                "name TEXT NOT NULL, " +
                "createdAt TEXT NOT NULL, " +
                "UNIQUE(ownerId, name)" +
                ")");
            await this.exec("CREATE TABLE IF NOT EXISTS sporades_files (" +
                "id TEXT PRIMARY KEY, " +
                "ownerId TEXT NOT NULL, " +
                "bucketId TEXT NOT NULL, " +
                "bucketName TEXT NOT NULL, " +
                "name TEXT NOT NULL, " +
                "type TEXT NOT NULL, " +
                "size INTEGER NOT NULL, " +
                "version TEXT NOT NULL, " +
                "status TEXT NOT NULL, " +
                "createdAt TEXT NOT NULL, " +
                "updatedAt TEXT NOT NULL, " +
                "deletedAt TEXT" +
                ")");
            await this.exec("CREATE TABLE IF NOT EXISTS sporades_file_uploads (" +
                "id TEXT PRIMARY KEY, " +
                "fileId TEXT NOT NULL, " +
                "ownerId TEXT NOT NULL, " +
                "version TEXT NOT NULL, " +
                "expectedSize INTEGER NOT NULL, " +
                "createdAt TEXT NOT NULL" +
                ")");
            await this.exec("CREATE TABLE IF NOT EXISTS sporades_file_public_urls (" +
                "id TEXT PRIMARY KEY, " +
                "fileId TEXT NOT NULL, " +
                "ownerId TEXT NOT NULL, " +
                "version TEXT NOT NULL, " +
                "expiresAt TEXT, " +
                "createdAt TEXT NOT NULL, " +
                "revokedAt TEXT" +
                ")");
        },
        async ensureAuthStorage(authConfig = null) {
            await this.exec("CREATE TABLE IF NOT EXISTS sporades_auth_users (" +
                "id TEXT PRIMARY KEY, " +
                "createdAt TEXT NOT NULL, " +
                "displayName TEXT NOT NULL, " +
                "email TEXT, " +
                "picture TEXT, " +
                "isAuthenticated INTEGER NOT NULL, " +
                "isGuest INTEGER NOT NULL, " +
                "provider TEXT NOT NULL" +
                ")");
            await this.exec("CREATE TABLE IF NOT EXISTS sporades_auth_sessions (" +
                "token TEXT PRIMARY KEY, " +
                "userId TEXT NOT NULL, " +
                "createdAt TEXT NOT NULL, " +
                "expiresAt TEXT NOT NULL" +
                ")");
            await ensureLibsqlSessionLifecycleColumns(this);
            if (authConfig?.providers?.email?.enabled) {
                await this.exec("CREATE TABLE IF NOT EXISTS sporades_auth_email_credentials (" +
                    "email TEXT PRIMARY KEY, " +
                    "userId TEXT NOT NULL, " +
                    "passwordHash TEXT NOT NULL, " +
                    "passwordSalt TEXT NOT NULL, " +
                    "createdAt TEXT NOT NULL" +
                    ")");
            }
            await this.exec("CREATE TABLE IF NOT EXISTS sporades_auth_oauth_states (" +
                "state TEXT PRIMARY KEY, " +
                "sessionToken TEXT NOT NULL, " +
                "returnTo TEXT NOT NULL, " +
                "redirectUri TEXT NOT NULL, " +
                "createdAt TEXT NOT NULL" +
                ")");
        },
        async consumeOAuthState(state) {
            const row = (await this.prepare("SELECT state, sessionToken, returnTo, redirectUri FROM sporades_auth_oauth_states WHERE state = ?").get(state)) ?? null;
            await this.prepare("DELETE FROM sporades_auth_oauth_states WHERE state = ?").run(state);
            return row;
        },
        async migrateAppSchema(schema) {
            return await migrateLibsqlAppSchema(this, schema);
        },
        async migrateExistingAppTable(existingTable, nextTable) {
            return await migrateExistingLibsqlAppTable(this, existingTable, nextTable);
        },
        async listInspectableTables() {
            const rows = await this.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
            return rows.map((row) => row.name).filter((name) => name !== "sporades_log_events");
        },
        async dumpInspectableDatabase() {
            const tableNames = await this.listInspectableTables();
            const tables = [];
            for (const tableName of tableNames) {
                const columns = (await this.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all()).map((column) => column.name);
                const rows = await this.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`).all();
                tables.push({ name: tableName, columns, rows });
            }
            return tables;
        },
        async runReadOnlyInspectionQuery(sql) {
            try {
                if (targetsInternalLogIndexTable(sql)) {
                    return {
                        ok: false,
                        data: null,
                        error: {
                            message: "Internal log index tables are not available through generic DB inspection.",
                            hint: "Use `sporades logs --json` or `sporades logs tail --json` to inspect Capsule logs.",
                        },
                    };
                }
                const statement = this.prepare(sql);
                const columns = (await statement.columns()).map((column) => column.name);
                const rows = (await statement.all()).filter((row) => !isInternalLogIndexMetadataRow(row, sql));
                return { ok: true, data: { columns, rows }, error: null };
            }
            catch (error) {
                return {
                    ok: false,
                    data: null,
                    error: {
                        message: error.message,
                        hint: "Check the SQL syntax and table names, then retry the query.",
                    },
                };
            }
        },
        async checkHealth() {
            try {
                await this.prepare("SELECT 1 AS ok").get();
                return { ok: true };
            }
            catch {
                return { ok: false };
            }
        },
        async withTransaction(fn) {
            const transaction = { baton: null, baseUrl: endpoint };
            const transactionAdapter = {
                ...adapter,
                ...createOperations(transaction),
                async withTransaction() {
                    throw commandError("Nested database transactions are not supported.", "Keep mutation work inside a single Sporades mutation transaction.");
                },
            };
            activeTransactions.add(transaction);
            try {
                await libsqlExecute({ endpoint, authToken, transaction, sql: "BEGIN", params: [], close: false });
                const result = await fn(transactionAdapter);
                await libsqlExecute({ endpoint, authToken, transaction, sql: "COMMIT", params: [], close: true });
                return result;
            }
            catch (error) {
                try {
                    await libsqlExecute({ endpoint, authToken, transaction, sql: "ROLLBACK", params: [], close: true });
                }
                catch { }
                throw error;
            }
            finally {
                activeTransactions.delete(transaction);
            }
        },
        async close() {
            closed = true;
            for (const transaction of activeTransactions) {
                if (transaction.baton) {
                    await libsqlPipeline({ endpoint, authToken, transaction, requests: [], close: true }).catch(() => { });
                }
            }
            activeTransactions.clear();
        },
    };
    return adapter;
}
function libsqlPipelineUrl(url) {
    const parsed = new URL(String(url));
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/v2/pipeline`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
}
function assertLibsqlOpen(closed) {
    if (closed) {
        throw new Error("database is not open");
    }
}
function libsqlHasMultipleStatements(sql) {
    return splitSqlStatements(sql).length > 1;
}
async function libsqlExecute({ endpoint, authToken, transaction, sql, params = [], close }) {
    const [result] = await libsqlPipeline({
        endpoint,
        authToken,
        transaction,
        requests: [{ type: "execute", stmt: { sql, args: params.map(libsqlValueFromJs) } }],
        close,
    });
    return result.result;
}
async function libsqlDescribe({ endpoint, authToken, transaction, sql, close }) {
    const [result] = await libsqlPipeline({
        endpoint,
        authToken,
        transaction,
        requests: [{ type: "describe", sql }],
        close,
    });
    return (result.result?.cols ?? []).map((column) => ({ name: column.name }));
}
async function libsqlPipeline({ endpoint, authToken, transaction = null, requests, close = true }) {
    const requestUrl = transaction?.baseUrl ?? endpoint;
    const payload = {
        ...(transaction ? { baton: transaction.baton } : {}),
        requests: close ? [...requests, { type: "close" }] : requests,
    };
    const response = await fetch(requestUrl, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(body?.error?.message ?? `libSQL request failed with HTTP ${response.status}.`);
    }
    if (transaction) {
        transaction.baton = body.baton ?? null;
        transaction.baseUrl = body.base_url ? new URL("/v2/pipeline", body.base_url).toString() : requestUrl;
    }
    const results = body.results ?? [];
    const errorResult = results.find((result) => result.type === "error");
    if (errorResult) {
        throw new Error(errorResult.error?.message ?? "libSQL statement failed.");
    }
    return results.filter((result) => result.response?.type !== "close").map((result) => result.response);
}
function libsqlRowsFromResult(result) {
    const columns = (result.cols ?? []).map((column) => column.name);
    return (result.rows ?? []).map((row) => {
        if (!Array.isArray(row)) {
            return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, libsqlValueToJs(value)]));
        }
        return Object.fromEntries(columns.map((column, index) => [column, libsqlValueToJs(row[index])]));
    });
}
function libsqlValueFromJs(value) {
    if (value === null || value === undefined) {
        return { type: "null" };
    }
    if (typeof value === "boolean") {
        return { type: "integer", value: value ? "1" : "0" };
    }
    if (typeof value === "bigint") {
        return { type: "integer", value: String(value) };
    }
    if (typeof value === "number" && Number.isInteger(value)) {
        return { type: "integer", value: String(value) };
    }
    if (typeof value === "number") {
        return { type: "float", value };
    }
    if (value instanceof Uint8Array) {
        return { type: "blob", base64: Buffer.from(value).toString("base64") };
    }
    return { type: "text", value: String(value) };
}
function libsqlValueToJs(value) {
    if (value === null || value === undefined || value.type === "null") {
        return null;
    }
    if (value.type === "integer") {
        const number = Number(value.value);
        return Number.isSafeInteger(number) ? number : String(value.value);
    }
    if (value.type === "float") {
        return Number(value.value);
    }
    if (value.type === "blob") {
        return Buffer.from(value.base64 ?? "", "base64");
    }
    if (Object.hasOwn(value, "value")) {
        return value.value;
    }
    return value;
}
function logIndexLimit(config = {}) {
    const configured = Number(config.logs?.indexLimit ?? config.logging?.indexLimit);
    return Number.isInteger(configured) && configured > 0 ? configured : 500;
}
function logPayloadMaxBytes(config = {}) {
    const configured = Number(config.logs?.payloadMaxBytes ?? config.logging?.payloadMaxBytes);
    return Number.isInteger(configured) && configured > 0 ? configured : 4096;
}
function logRedactedValue() {
    return "[REDACTED]";
}
function createRuntimeLogSink(options) {
    const path = requirePathModule();
    const logPath = options.config.logs?.jsonlPath ??
        options.config.logging?.jsonlPath ??
        process.env.SPORADES_LOG_PATH ??
        path.join(options.dataDir, "logs", "events.jsonl");
    mkdirSync(path.dirname(logPath), { recursive: true });
    return {
        path: logPath,
        emit(input) {
            const event = createLogEnvelope({
                ...input,
                config: options.config,
                serverEnv: options.serverEnv,
            });
            appendFileSync(logPath, `${JSON.stringify(event)}\n`);
            const inserted = options.database.insertLogIndexEvent(event);
            const indexed = isPromiseLike(inserted)
                ? inserted.then(() => options.database.pruneLogIndex(logIndexLimit(options.config)))
                : options.database.pruneLogIndex(logIndexLimit(options.config));
            if (process.env.SPORADES_LOG_STDOUT === "1") {
                process.stdout.write(`${JSON.stringify(event)}\n`);
            }
            return isPromiseLike(indexed) ? indexed.then(() => event) : event;
        },
        recent(limit = logIndexLimit(options.config)) {
            return options.database.readRecentLogEvents(limit);
        },
        tail(limit = logIndexLimit(options.config)) {
            return readJsonlLogEvents(logPath, limit);
        },
    };
}
function requirePathModule() {
    return {
        join: (...parts) => parts.join("/").replace(/\/+/g, "/"),
        dirname: (filePath) => String(filePath).replace(/\/[^/]*$/, "") || ".",
    };
}
function createRuntimeLogger(database, context = {}) {
    const write = (level, args) => {
        const [message, data, ...rest] = args;
        const structuredData = data !== undefined && rest.length === 0
            ? data
            : rest.length > 0
                ? { data, args: rest }
                : null;
        database.log.emit({
            category: context.category ?? "app",
            event: context.event ?? "ctx.log",
            level,
            message: String(message ?? ""),
            data: structuredData,
            request: context.request ?? null,
            release: context.release ?? null,
            correlation: context.correlation ?? null,
        });
    };
    return {
        info: (...args) => write("info", args),
        warn: (...args) => write("warn", args),
        error: (...args) => write("error", args),
    };
}
function createLogEnvelope(input) {
    const now = new Date().toISOString();
    const config = input.config ?? {};
    const capsuleName = String(config.name ?? "unknown");
    const envelope = {
        schema: "sporades.log.v1",
        timestamp: input.timestamp ?? now,
        category: input.category ?? "platform",
        event: input.event ?? "runtime.event",
        level: input.level ?? "info",
        message: String(input.message ?? ""),
        capsule: {
            name: capsuleName,
            id: String(config.capsule?.id ?? config.id ?? capsuleName),
        },
        release: input.release ?? config.release ?? null,
        request: input.request
            ? {
                id: input.request.id ?? randomUUID(),
                method: input.request.method ?? null,
                path: input.request.path ?? null,
            }
            : null,
        correlation: input.correlation ?? null,
        data: sanitizeLogData(input.data ?? null, input.serverEnv ?? {}),
    };
    return capLogEnvelope(envelope, logPayloadMaxBytes(config));
}
function sanitizeLogData(value, serverEnv) {
    return redactLogData(value, serverEnv);
}
function redactLogData(value, serverEnv) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === "string") {
        return logDataContainsServerEnvValue(value, serverEnv) ? logRedactedValue() : value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => redactLogData(item, serverEnv));
    }
    if (typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [
            key,
            isSensitiveLogKey(key) || logDataContainsServerEnvValue(nestedValue, serverEnv)
                ? logRedactedValue()
                : redactLogData(nestedValue, serverEnv),
        ]));
    }
    return String(value);
}
function logDataContainsServerEnvValue(value, serverEnv) {
    const values = Object.values(serverEnv ?? {}).filter((candidate) => typeof candidate === "string" && candidate.length > 0);
    if (values.length === 0) {
        return false;
    }
    if (typeof value === "string") {
        return values.includes(value);
    }
    if (value === null || value === undefined || typeof value !== "object") {
        return false;
    }
    const serialized = JSON.stringify(value, (_key, nestedValue) => typeof nestedValue === "bigint" ? String(nestedValue) : nestedValue);
    return values.some((secret) => serialized.includes(secret));
}
function isSensitiveLogKey(key) {
    return (/(^|[-_])(?:password|passwd|token|secret|authorization|cookie|client[-_]?secret|api[-_]?token)([-_]|$)/i.test(String(key)) ||
        /(?:password|passwd|token|secret|authorization|cookie|clientSecret|apiToken)/i.test(String(key)));
}
function capLogEnvelope(envelope, maxBytes) {
    let capped = envelope;
    if (Buffer.byteLength(JSON.stringify(capped), "utf8") <= maxBytes) {
        return { ...capped, truncated: false };
    }
    capped = {
        ...capped,
        data: {
            ...(capped.data && typeof capped.data === "object" && !Array.isArray(capped.data) ? capped.data : { value: capped.data }),
        },
        truncated: true,
    };
    for (const key of Object.keys(capped.data).reverse()) {
        if (Buffer.byteLength(JSON.stringify(capped), "utf8") <= maxBytes) {
            return capped;
        }
        capped.data[key] = "[TRUNCATED]";
    }
    if (Buffer.byteLength(JSON.stringify(capped), "utf8") <= maxBytes) {
        return capped;
    }
    capped.data = { truncated: true };
    capped.message = capped.message.slice(0, 256);
    return capped;
}
function createLogIndexTables(sqlite) {
    sqlite.exec("CREATE TABLE IF NOT EXISTS sporades_log_events (" +
        "id TEXT PRIMARY KEY, " +
        "timestamp TEXT NOT NULL, " +
        "category TEXT NOT NULL, " +
        "event TEXT NOT NULL, " +
        "level TEXT NOT NULL, " +
        "message TEXT NOT NULL, " +
        "capsuleName TEXT, " +
        "capsuleId TEXT, " +
        "releaseId TEXT, " +
        "requestId TEXT, " +
        "correlationId TEXT, " +
        "payload TEXT NOT NULL" +
        ")");
}
function insertLogIndexEvent(sqlite, event) {
    sqlite
        .prepare("INSERT INTO sporades_log_events " +
        "(id, timestamp, category, event, level, message, capsuleName, capsuleId, releaseId, requestId, correlationId, payload) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), event.timestamp, event.category, event.event, event.level, event.message, event.capsule?.name ?? null, event.capsule?.id ?? null, event.release?.id ?? event.release ?? null, event.request?.id ?? null, event.correlation?.id ?? event.correlation ?? null, JSON.stringify(event));
}
function pruneLogIndex(sqlite, limit) {
    sqlite
        .prepare("DELETE FROM sporades_log_events WHERE id IN (" +
        "SELECT id FROM sporades_log_events ORDER BY timestamp DESC, rowid DESC LIMIT -1 OFFSET ?" +
        ")")
        .run(limit);
}
function readRecentLogEvents(sqlite, limit = 200) {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : 200;
    return sqlite
        .prepare("SELECT payload FROM sporades_log_events ORDER BY timestamp DESC, rowid DESC LIMIT ?")
        .all(safeLimit)
        .reverse()
        .map((row) => JSON.parse(row.payload));
}
function readJsonlLogEvents(logPath, limit = 200) {
    let raw = "";
    try {
        raw = readFileSync(logPath, "utf8");
    }
    catch (error) {
        if (error?.code !== "ENOENT") {
            throw error;
        }
    }
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : 200;
    return raw
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-safeLimit)
        .map((line) => JSON.parse(line));
}
function schemaFromCapsuleDefinition(definition) {
    const schema = definition?.schema ?? {};
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        throw commandError("Invalid Capsule schema.", "Pass an object whose values are table(...) declarations to capsule({ schema }).");
    }
    return {
        tables: Object.entries(schema).map(([name, table]) => schemaTableFromCapsuleTable(name, table)),
    };
}
function schemaTableFromCapsuleTable(name, table) {
    if (!table || table.kind !== "table" || !table.fields || typeof table.fields !== "object" || Array.isArray(table.fields)) {
        throw commandError(`Invalid Capsule table: ${name}`, "Declare schema tables with table({ fieldName: FieldBuilder() }).");
    }
    return {
        name,
        acl: normalizeTableAcl(name, table.aclRules),
        fields: Object.entries(table.fields).map(([fieldName, field]) => schemaFieldFromCapsuleField(fieldName, field)),
    };
}
function normalizeTableAcl(tableName, aclRules) {
    const supportedOperations = new Set(["read", "write", "insert", "update", "delete"]);
    if (aclRules === undefined) {
        return {
            allowByDefault: true,
            resolve(operation) {
                return resolveEffectiveAclRule(this, operation);
            },
        };
    }
    if (!aclRules || typeof aclRules !== "object" || Array.isArray(aclRules)) {
        throw commandError(`Invalid Capsule table ACL: ${tableName}`, "Pass an object with function rules for read, write, insert, update, and delete.");
    }
    const normalized = {
        allowByDefault: true,
    };
    for (const [operation, rule] of Object.entries(aclRules)) {
        if (!supportedOperations.has(operation)) {
            throw commandError(`Unsupported Capsule table ACL operation: ${tableName}.${operation}`, "Supported ACL operations are read, write, insert, update, and delete.");
        }
        if (typeof rule !== "function") {
            throw commandError(`Invalid Capsule table ACL: ${tableName}.${operation}`, "ACL rules must be functions for read, write, insert, update, and delete.");
        }
        normalized[operation] = rule;
    }
    normalized.resolve = function resolve(operation) {
        return resolveEffectiveAclRule(this, operation);
    };
    return normalized;
}
function resolveEffectiveAclRule(aclRules, operation) {
    if (!aclRules || typeof aclRules !== "object") {
        return undefined;
    }
    if (operation === "insert" || operation === "update" || operation === "delete") {
        return aclRules[operation] ?? aclRules.write;
    }
    return aclRules[operation];
}
function schemaFieldFromCapsuleField(name, field) {
    if (!field || typeof field !== "object" || typeof field.kind !== "string") {
        throw commandError(`Invalid Capsule field: ${name}`, "Use Sporades field builders such as String(), Boolean(), Number(), Date(), Json(), or Reference(...).");
    }
    const supportedKinds = new Set(["String", "Boolean", "Number", "Date", "Json", "Reference"]);
    if (!supportedKinds.has(field.kind)) {
        throw commandError(`Unsupported Capsule field type: ${field.kind}`, "Use supported Sporades field builders: String, Boolean, Number, Date, Json, Reference.");
    }
    let defaultValue = field.defaultValue;
    if (field.kind === "Number" && defaultValue !== undefined && !Number.isFinite(defaultValue)) {
        throw commandError("Invalid Number() default.", "Pass a finite JavaScript number to Number().default(...).");
    }
    if (field.kind === "Date" && defaultValue !== undefined) {
        defaultValue = normalizeDateValue(defaultValue, "default");
    }
    if (field.kind === "Json" && defaultValue !== undefined) {
        assertJsonCompatible(defaultValue);
    }
    return {
        name,
        kind: field.kind,
        sqliteType: sqliteTypeForFieldKind(field.kind),
        targetTable: field.kind === "Reference" ? String(field.targetTable ?? "") : undefined,
        defaultValue,
    };
}
function sqliteTypeForFieldKind(kind) {
    if (kind === "Boolean") {
        return "INTEGER";
    }
    if (kind === "Number") {
        return "REAL";
    }
    return "TEXT";
}
function migrateAppSchema(sqlite, schema) {
    const nextSchema = normalizeSchema(schema);
    const nextSchemaJson = JSON.stringify(nextSchema);
    const nextSchemaHash = hashSchema(nextSchemaJson);
    const existingSchemaRow = sqlite.readSchemaMetadata();
    let existingSchema = null;
    let schemaChanged = false;
    if (existingSchemaRow) {
        try {
            existingSchema = JSON.parse(existingSchemaRow.value);
        }
        catch {
            throw commandError("Invalid Sporades schema metadata.", "Delete the Runtime directory only if you can lose local data, then restart the Capsule.");
        }
        schemaChanged = hashSchema(JSON.stringify(existingSchema)) !== nextSchemaHash;
        if (schemaChanged) {
            assertAdditiveSchemaMigration(existingSchema, nextSchema);
        }
    }
    const existingTables = new Map((existingSchema?.tables ?? []).map((table) => [table.name, table]));
    return chainMaybePromise([
        ...schema.tables.map((table) => () => {
            const existingTable = existingTables.get(table.name);
            return schemaChanged && existingTable ? sqlite.migrateExistingAppTable(existingTable, table) : sqlite.createAppTable(table);
        }),
        () => sqlite.writeSchemaMetadata({
            schemaVersion: "v1:additive-fields",
            schemaHash: nextSchemaHash,
            schemaJson: nextSchemaJson,
        }),
    ]);
}
async function migrateLibsqlAppSchema(sqlite, schema) {
    const nextSchema = normalizeSchema(schema);
    const nextSchemaJson = JSON.stringify(nextSchema);
    const nextSchemaHash = hashSchema(nextSchemaJson);
    const existingSchemaRow = await sqlite.readSchemaMetadata();
    let existingSchema = null;
    let schemaChanged = false;
    if (existingSchemaRow) {
        try {
            existingSchema = JSON.parse(existingSchemaRow.value);
        }
        catch {
            throw commandError("Invalid Sporades schema metadata.", "Delete the Runtime directory only if you can lose local data, then restart the Capsule.");
        }
        schemaChanged = hashSchema(JSON.stringify(existingSchema)) !== nextSchemaHash;
        if (schemaChanged) {
            assertAdditiveSchemaMigration(existingSchema, nextSchema);
        }
    }
    const existingTables = new Map((existingSchema?.tables ?? []).map((table) => [table.name, table]));
    for (const table of schema.tables) {
        const existingTable = existingTables.get(table.name);
        if (schemaChanged && existingTable) {
            await sqlite.migrateExistingAppTable(existingTable, table);
        }
        else {
            await sqlite.createAppTable(table);
        }
    }
    await sqlite.writeSchemaMetadata({
        schemaVersion: "v1:additive-fields",
        schemaHash: nextSchemaHash,
        schemaJson: nextSchemaJson,
    });
}
function normalizeSchema(schema) {
    return {
        tables: schema.tables
            .map((table) => ({
            name: table.name,
            fields: table.fields.map((field) => ({
                name: field.name,
                kind: field.kind,
                sqliteType: field.sqliteType,
                targetTable: field.targetTable,
                defaultValue: field.defaultValue,
            })),
        }))
            .sort((left, right) => left.name.localeCompare(right.name)),
    };
}
function hashSchema(schemaJson) {
    return createHash("sha256").update(schemaJson).digest("hex");
}
function assertValidReferenceTargets(schema) {
    const tableNames = new Set(schema.tables.map((table) => table.name));
    for (const table of schema.tables) {
        for (const field of table.fields) {
            if (field.kind === "Reference" && !tableNames.has(field.targetTable)) {
                throw commandError(`Unknown reference target: ${field.targetTable}`, "Reference fields must point at another table in the Capsule schema.");
            }
        }
    }
}
function assertAdditiveSchemaMigration(existingSchema, nextSchema) {
    const nextTables = new Map(nextSchema.tables.map((table) => [table.name, table]));
    for (const existingTable of existingSchema.tables ?? []) {
        const nextTable = nextTables.get(existingTable.name);
        if (!nextTable) {
            throw commandError("Unsupported Capsule schema change.", "Only adding new tables or fields is supported right now. Revert table or field changes, or move data aside and recreate the Runtime directory.");
        }
        const nextFields = new Map(nextTable.fields.map((field) => [field.name, field]));
        for (const existingField of existingTable.fields ?? []) {
            const nextField = nextFields.get(existingField.name);
            if (!nextField || JSON.stringify(existingField) !== JSON.stringify(nextField)) {
                throw commandError("Unsupported Capsule schema change.", "Only adding new tables or fields is supported right now. Revert table or field changes, or move data aside and recreate the Runtime directory.");
            }
        }
    }
}
function migrateExistingAppTable(sqlite, existingTable, nextTable) {
    const tempTableName = `__sporades_migrating_${nextTable.name}`;
    const columns = ["id", "createdAt", "updatedAt", ...nextTable.fields.map((field) => field.name)];
    return chainMaybePromise([
        ...addedFieldsForTable(existingTable, nextTable)
            .filter((field) => field.kind === "Reference" && field.defaultValue !== undefined && field.defaultValue !== null)
            .map((field) => () => thenIfPromise(sqlite.referenceExists(field, field.defaultValue), (exists) => {
            if (!exists) {
                throw invalidReferenceError(field);
            }
        })),
        () => sqlite.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(tempTableName)}`),
        () => sqlite.createAppTable(nextTable, tempTableName),
        () => sqlite.exec(`INSERT INTO ${quoteIdentifier(tempTableName)} (${columns.map(quoteIdentifier).join(", ")}) ` +
            `SELECT ${columns.map((column) => columnSelectExpressionForMigration(existingTable, nextTable, column)).join(", ")} ` +
            `FROM ${quoteIdentifier(nextTable.name)}`),
        () => sqlite.exec(`DROP TABLE ${quoteIdentifier(nextTable.name)}`),
        () => sqlite.exec(`ALTER TABLE ${quoteIdentifier(tempTableName)} RENAME TO ${quoteIdentifier(nextTable.name)}`),
    ]);
}
async function migrateExistingLibsqlAppTable(sqlite, existingTable, nextTable) {
    for (const field of addedFieldsForTable(existingTable, nextTable)) {
        if (field.kind === "Reference" &&
            field.defaultValue !== undefined &&
            field.defaultValue !== null &&
            !(await sqlite.referenceExists(field, field.defaultValue))) {
            throw invalidReferenceError(field);
        }
    }
    const tempTableName = `__sporades_migrating_${nextTable.name}`;
    const columns = ["id", "createdAt", "updatedAt", ...nextTable.fields.map((field) => field.name)];
    await sqlite.withTransaction(async (transaction) => {
        await transaction.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(tempTableName)}`);
        await transaction.createAppTable(nextTable, tempTableName);
        await transaction.exec(`INSERT INTO ${quoteIdentifier(tempTableName)} (${columns.map(quoteIdentifier).join(", ")}) ` +
            `SELECT ${columns.map((column) => columnSelectExpressionForMigration(existingTable, nextTable, column)).join(", ")} ` +
            `FROM ${quoteIdentifier(nextTable.name)}`);
        await transaction.exec(`DROP TABLE ${quoteIdentifier(nextTable.name)}`);
        await transaction.exec(`ALTER TABLE ${quoteIdentifier(tempTableName)} RENAME TO ${quoteIdentifier(nextTable.name)}`);
    });
}
function columnSelectExpressionForMigration(existingTable, nextTable, columnName) {
    if (["id", "createdAt", "updatedAt"].includes(columnName)) {
        return quoteIdentifier(columnName);
    }
    if ((existingTable.fields ?? []).some((field) => field.name === columnName)) {
        return quoteIdentifier(columnName);
    }
    const field = nextTable.fields.find((candidate) => candidate.name === columnName);
    return field?.defaultValue === undefined ? "NULL" : toSqlLiteral(field.defaultValue, field);
}
function addedFieldsForTable(existingTable, nextTable) {
    const existingFields = new Set((existingTable.fields ?? []).map((field) => field.name));
    return (nextTable.fields ?? []).filter((field) => !existingFields.has(field.name));
}
function createAppTable(sqlite, table, tableName = table.name) {
    return sqlite.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (` +
        appTableColumnDefinitions(table).join(", ") +
        ")");
}
function appTableColumnDefinitions(table) {
    return [
        "id TEXT PRIMARY KEY",
        "createdAt TEXT NOT NULL",
        "updatedAt TEXT NOT NULL",
        ...table.fields.map((field) => appFieldColumnDefinition(field)),
    ];
}
function appFieldColumnDefinition(field) {
    const defaultSql = fieldColumnDefaultSql(field);
    const notNullSql = field.defaultValue !== undefined && !fieldDefaultIsSqlNull(field) ? " NOT NULL" : "";
    return `${quoteIdentifier(field.name)} ${field.sqliteType}${notNullSql}${defaultSql}`;
}
function fieldDefaultIsSqlNull(field) {
    return field.defaultValue === null && field.kind !== "Json";
}
function fieldColumnDefaultSql(field) {
    return field.defaultValue === undefined ? "" : ` DEFAULT ${toSqlLiteral(field.defaultValue, field)}`;
}
function commandError(message, hint, code = null) {
    const error = new Error(message);
    error.hint = hint;
    if (code) {
        error.code = code;
    }
    return error;
}
function extractSchema(serverSource) {
    const tables = [];
    const tablePattern = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*table\s*\(/g;
    let match;
    while ((match = tablePattern.exec(serverSource))) {
        const argsEnd = findMatchingParen(serverSource, tablePattern.lastIndex - 1);
        if (argsEnd === -1) {
            continue;
        }
        const argsSource = serverSource.slice(tablePattern.lastIndex, argsEnd).trim();
        const fieldsSource = argsSource.startsWith("{") && argsSource.endsWith("}") ? argsSource.slice(1, -1) : argsSource;
        tables.push({
            name: match[1],
            fields: extractFields(fieldsSource),
        });
        tablePattern.lastIndex = argsEnd + 1;
    }
    return { tables };
}
function findMatchingParen(source, openIndex) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = openIndex; index < source.length; index += 1) {
        const char = source[index];
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === "\\") {
                escaped = true;
                continue;
            }
            if (char === quote) {
                quote = null;
            }
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            quote = char;
            continue;
        }
        if (char === "(") {
            depth += 1;
            continue;
        }
        if (char === ")") {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}
function extractEndpoints(serverSource) {
    const endpoints = [];
    const endpointPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*endpoint\s*\(/g;
    let match;
    while ((match = endpointPattern.exec(serverSource))) {
        const argsEnd = findMatchingParen(serverSource, endpointPattern.lastIndex - 1);
        if (argsEnd === -1) {
            continue;
        }
        const argsSource = serverSource.slice(endpointPattern.lastIndex, argsEnd);
        const descriptor = argsSource.match(/^\s*\{\s*method\s*:\s*["']([A-Za-z]+)["']\s*,\s*path\s*:\s*["']([^"']+)["']\s*\}\s*,/);
        if (!descriptor) {
            endpointPattern.lastIndex = argsEnd + 1;
            continue;
        }
        endpoints.push({
            name: match[1],
            method: descriptor[1].toUpperCase(),
            path: descriptor[2],
            handlerSource: argsSource.slice(descriptor[0].length).trim(),
        });
        endpointPattern.lastIndex = argsEnd + 1;
    }
    return endpoints;
}
function extractQueryHandlers(serverSource) {
    const queriesSource = extractObjectPropertySource(serverSource, "queries");
    if (!queriesSource) {
        return [];
    }
    const source = queriesSource.trim();
    if (!source.startsWith("{")) {
        return [];
    }
    const closeIndex = findMatchingDelimiter(source, 0, "{", "}");
    if (closeIndex === -1) {
        return [];
    }
    const handlers = [];
    const entriesSource = source.slice(1, closeIndex);
    for (const entry of splitTopLevelList(entriesSource)) {
        const match = entry.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*query\s*\(/);
        if (!match) {
            continue;
        }
        const queryCallIndex = entry.indexOf("query");
        const openIndex = entry.indexOf("(", queryCallIndex);
        const argsEnd = findMatchingParen(entry, openIndex);
        if (argsEnd === -1) {
            continue;
        }
        handlers.push({
            name: match[1],
            handlerSource: entry.slice(openIndex + 1, argsEnd).trim().replace(/,\s*$/, ""),
        });
    }
    return handlers;
}
function extractQueryHandlersFromCapsule(capsuleDefinition) {
    if (!capsuleDefinition?.queries || typeof capsuleDefinition.queries !== "object") {
        return null;
    }
    const handlers = [];
    for (const [name, queryDefinition] of Object.entries(capsuleDefinition.queries)) {
        if (queryDefinition?.kind !== "query" || typeof queryDefinition.handler !== "function") {
            continue;
        }
        handlers.push({
            name,
            handler: queryDefinition.handler,
        });
    }
    return handlers;
}
function extractMutationHandlers(serverSource, options = {}) {
    const mutationsSource = extractObjectPropertySource(serverSource, "mutations");
    if (!mutationsSource) {
        return [];
    }
    const source = mutationsSource.trim();
    if (!source.startsWith("{")) {
        return [];
    }
    const closeIndex = findMatchingDelimiter(source, 0, "{", "}");
    if (closeIndex === -1) {
        return [];
    }
    const handlers = [];
    const entriesSource = source.slice(1, closeIndex);
    for (const entry of splitTopLevelList(entriesSource)) {
        const match = entry.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*mutation\s*\(/);
        if (!match) {
            continue;
        }
        if (!options.includeGeneratedNames && (match[1].startsWith("add") || match[1].startsWith("update"))) {
            continue;
        }
        const mutationCallIndex = entry.indexOf("mutation");
        const openIndex = entry.indexOf("(", mutationCallIndex);
        const argsEnd = findMatchingParen(entry, openIndex);
        if (argsEnd === -1) {
            continue;
        }
        handlers.push({
            name: match[1],
            handlerSource: entry.slice(openIndex + 1, argsEnd).trim().replace(/,\s*$/, ""),
        });
    }
    return handlers;
}
function handlersFromCapsuleDefinition(definitions, kind) {
    return Object.entries(definitions ?? {})
        .filter(([, definition]) => definition?.kind === kind && typeof definition.handler === "function")
        .map(([name, definition]) => ({
        name,
        handler: definition.handler,
    }));
}
function mutationHandlersFromCapsuleDefinition(serverSource, capsuleDefinition) {
    const sourceHandlers = new Map(extractMutationHandlers(serverSource, { includeGeneratedNames: true }).map((handler) => [handler.name, handler]));
    return handlersFromCapsuleDefinition(capsuleDefinition.mutations, "mutation").filter((handler) => shouldUseBundledMutationHandler(handler.name, sourceHandlers.get(handler.name)));
}
function shouldUseBundledMutationHandler(name, sourceHandler) {
    if (!name.startsWith("add") && !name.startsWith("update")) {
        return true;
    }
    if (!sourceHandler || !isInlineHandlerSource(sourceHandler.handlerSource)) {
        return true;
    }
    return !isGeneratedScaffoldMutationHandler(sourceHandler.handlerSource);
}
function isInlineHandlerSource(handlerSource) {
    const source = handlerSource.trim();
    return source.startsWith("(") || source.startsWith("function") || source.startsWith("async ") || source.includes("=>");
}
function isGeneratedScaffoldMutationHandler(handlerSource) {
    const normalized = handlerSource.replace(/\s+/g, "");
    return /^\(ctx,([A-Za-z_$][A-Za-z0-9_$]*)(?::[^,)]+)?\)=>\{ctx\.db\.[A-Za-z_$][A-Za-z0-9_$]*\.insert\(\{\1,ownerId:ctx\.auth\.userId\}\);\}$/.test(normalized);
}
function extractMessageHandlers(serverSource) {
    const messagesSource = extractObjectPropertySource(serverSource, "messages");
    if (!messagesSource) {
        return [];
    }
    const source = messagesSource.trim();
    if (!source.startsWith("{")) {
        return [];
    }
    const closeIndex = findMatchingDelimiter(source, 0, "{", "}");
    if (closeIndex === -1) {
        return [];
    }
    const handlers = [];
    const entriesSource = source.slice(1, closeIndex);
    for (const entry of splitTopLevelList(entriesSource)) {
        const match = entry.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*message\s*\(/);
        if (!match) {
            continue;
        }
        const messageCallIndex = entry.indexOf("message");
        const openIndex = entry.indexOf("(", messageCallIndex);
        const argsEnd = findMatchingParen(entry, openIndex);
        if (argsEnd === -1) {
            continue;
        }
        handlers.push({
            name: match[1],
            handlerSource: entry.slice(openIndex + 1, argsEnd).trim(),
        });
    }
    return handlers;
}
function extractContextMiddleware(serverSource) {
    const middlewareSource = extractObjectPropertySource(serverSource, "middleware");
    if (!middlewareSource) {
        return [];
    }
    return extractHookList(`middleware: ${middlewareSource}`, "middleware");
}
function extractMutationHooks(serverSource) {
    const hooksSource = extractObjectPropertySource(serverSource, "hooks");
    if (!hooksSource) {
        return {
            beforeMutation: [],
            afterMutation: [],
        };
    }
    return {
        beforeMutation: extractHookList(hooksSource, "beforeMutation"),
        afterMutation: extractHookList(hooksSource, "afterMutation"),
    };
}
function extractHookList(hooksSource, propertyName) {
    const valueSource = extractObjectPropertySource(hooksSource, propertyName);
    if (!valueSource) {
        return [];
    }
    const trimmed = valueSource.trim();
    if (trimmed.startsWith("[")) {
        const closeIndex = findMatchingDelimiter(trimmed, 0, "[", "]");
        if (closeIndex === -1) {
            return [];
        }
        return splitTopLevelList(trimmed.slice(1, closeIndex)).map((source) => source.trim()).filter(Boolean);
    }
    return [trimmed.replace(/,\s*$/, "")];
}
function extractObjectPropertySource(source, propertyName) {
    const pattern = new RegExp(`\\b${propertyName}\\s*:`, "g");
    const match = pattern.exec(source);
    if (!match) {
        return null;
    }
    const valueStart = match.index + match[0].length;
    let index = valueStart;
    while (/\s/.test(source[index] ?? "")) {
        index += 1;
    }
    const firstChar = source[index];
    if (firstChar === "{") {
        const endIndex = findMatchingDelimiter(source, index, "{", "}");
        return endIndex === -1 ? null : source.slice(index, endIndex + 1);
    }
    if (firstChar === "[") {
        const endIndex = findMatchingDelimiter(source, index, "[", "]");
        return endIndex === -1 ? null : source.slice(index, endIndex + 1);
    }
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let cursor = index; cursor < source.length; cursor += 1) {
        const char = source[cursor];
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === "\\") {
                escaped = true;
                continue;
            }
            if (char === quote) {
                quote = null;
            }
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            quote = char;
            continue;
        }
        if (char === "(" || char === "{" || char === "[") {
            depth += 1;
            continue;
        }
        if (char === ")" || char === "}" || char === "]") {
            if (depth === 0) {
                return source.slice(index, cursor);
            }
            depth -= 1;
            continue;
        }
        if (char === "," && depth === 0) {
            return source.slice(index, cursor);
        }
    }
    return source.slice(index);
}
function findMatchingDelimiter(source, openIndex, openChar, closeChar) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = openIndex; index < source.length; index += 1) {
        const char = source[index];
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === "\\") {
                escaped = true;
                continue;
            }
            if (char === quote) {
                quote = null;
            }
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            quote = char;
            continue;
        }
        if (char === openChar) {
            depth += 1;
            continue;
        }
        if (char === closeChar) {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}
function splitTopLevelList(source) {
    const items = [];
    let start = 0;
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === "\\") {
                escaped = true;
                continue;
            }
            if (char === quote) {
                quote = null;
            }
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            quote = char;
            continue;
        }
        if (char === "(" || char === "{" || char === "[") {
            depth += 1;
            continue;
        }
        if (char === ")" || char === "}" || char === "]") {
            depth -= 1;
            continue;
        }
        if (char === "," && depth === 0) {
            items.push(source.slice(start, index));
            start = index + 1;
        }
    }
    items.push(source.slice(start));
    return items;
}
function extractFields(tableSource) {
    return splitTopLevelList(tableSource)
        .map((entry) => {
        const property = entry.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*/);
        if (!property) {
            return null;
        }
        const fieldSource = entry.slice(property[0].length).trim().replace(/,\s*$/, "");
        const referenceMatch = fieldSource.match(/^Reference\s*\(\s*["']([^"']+)["']\s*\)/);
        const scalarMatch = fieldSource.match(/^(String|Boolean|Number|Date|Json)\s*\(\s*\)/);
        const kind = referenceMatch ? "Reference" : scalarMatch?.[1];
        if (!kind) {
            return null;
        }
        const builderSource = referenceMatch?.[0] ?? scalarMatch[0];
        return {
            name: property[1],
            kind,
            sqliteType: kind === "Boolean" ? "INTEGER" : kind === "Number" ? "REAL" : "TEXT",
            targetTable: referenceMatch?.[1],
            defaultValue: parseFieldDefault(kind, extractFieldDefaultSource(fieldSource, builderSource.length)),
        };
    })
        .filter(Boolean);
}
function extractFieldDefaultSource(fieldSource, builderEndIndex) {
    const rest = fieldSource.slice(builderEndIndex).trim();
    if (!rest.startsWith(".default")) {
        return undefined;
    }
    const openIndex = rest.indexOf("(");
    if (openIndex === -1) {
        return undefined;
    }
    const closeIndex = findMatchingParen(rest, openIndex);
    if (closeIndex === -1) {
        return undefined;
    }
    return rest.slice(openIndex + 1, closeIndex).trim();
}
export async function routeEndpoint(database, request, response) {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    const endpoint = database.endpoints.find((candidate) => candidate.method === request.method && candidate.path === requestUrl.pathname);
    if (!endpoint) {
        return false;
    }
    try {
        writeEndpointResult(response, await runEndpoint(database, endpoint, requestUrl, request));
    }
    catch (error) {
        writeEndpointError(response, error);
    }
    return true;
}
export async function handleFileHttpRoute(database, request, response, websocketHub = null) {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    const uploadMatch = requestUrl.pathname.match(/^\/__sporades\/uploads\/([^/]+)$/);
    if (uploadMatch && request.method === "PUT") {
        const result = await completePendingFileUpload(database, uploadMatch[1], request, websocketHub);
        writeJsonHttpResponse(response, result.ok ? 200 : 400, result);
        return true;
    }
    const privateMatch = requestUrl.pathname.match(/^\/__sporades\/files\/private\/([^/]+)$/);
    if (privateMatch && request.method === "GET") {
        const token = request.headers["x-sporades-session-token"];
        const session = await resolveAnonymousSession(database, token);
        const row = await fileRowForOwner(database, privateMatch[1], session.auth.userId);
        if (!row || row.version !== requestUrl.searchParams.get("v")) {
            writeNotFound(response);
            return true;
        }
        await sendFileHttpResponse(database, response, row);
        return true;
    }
    const publicMatch = requestUrl.pathname.match(/^\/__sporades\/files\/public\/([^/]+)$/);
    if (publicMatch && request.method === "GET") {
        const publicRow = await database.sqlite.selectPublicFileRow(publicMatch[1]);
        if (!publicRow ||
            publicRow.revokedAt ||
            publicRow.deletedAt ||
            (publicRow.expiresAt && Date.parse(publicRow.expiresAt) <= Date.now()) ||
            publicRow.publicVersion !== requestUrl.searchParams.get("v") ||
            publicRow.publicVersion !== publicRow.version) {
            writeNotFound(response);
            return true;
        }
        await sendFileHttpResponse(database, response, publicRow);
        return true;
    }
    return false;
}
export async function routeRuntimeHealth(database, request, response) {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    if (request.method !== "GET" || requestUrl.pathname !== "/__sporades/health/runtime") {
        return false;
    }
    const probe = request.headers["x-sporades-host-probe"];
    if (typeof probe !== "string" || probe.length === 0) {
        writeNotFound(response);
        return true;
    }
    const result = await createRuntimeHealthResult(database);
    writeJsonHttpResponse(response, result.ok ? 200 : 503, result);
    return true;
}
async function createRuntimeHealthResult(database) {
    const checks = {
        sqlite: await checkRuntimeSqlite(database),
        fileStorage: await checkRuntimeFileStorage(database),
    };
    const ready = checks.sqlite.ok && checks.fileStorage.ok;
    return {
        ok: ready,
        data: {
            runtime: { ready },
            checks,
        },
        error: ready
            ? null
            : {
                message: "Sporades runtime is not ready.",
                hint: "Check Hosted Capsule logs and data volume permissions.",
            },
    };
}
export async function checkRuntimeSqlite(database) {
    return await (database.adapter ?? database.sqlite).checkHealth();
}
async function checkRuntimeFileStorage(database) {
    const { mkdir, rm, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const probeDirectory = path.join(database.fileStoragePath, ".sporades-health");
    const probeFile = path.join(probeDirectory, `${randomUUID()}.tmp`);
    try {
        await mkdir(probeDirectory, { recursive: true });
        await writeFile(probeFile, "");
        await rm(probeFile, { force: true });
        return { ok: true };
    }
    catch {
        await rm(probeFile, { force: true }).catch(() => { });
        return { ok: false };
    }
}
function createFileStorageTables(sqlite) {
    sqlite.exec("CREATE TABLE IF NOT EXISTS sporades_file_buckets (" +
        "id TEXT PRIMARY KEY, " +
        "ownerId TEXT NOT NULL, " +
        "name TEXT NOT NULL, " +
        "createdAt TEXT NOT NULL, " +
        "UNIQUE(ownerId, name)" +
        ")");
    sqlite.exec("CREATE TABLE IF NOT EXISTS sporades_files (" +
        "id TEXT PRIMARY KEY, " +
        "ownerId TEXT NOT NULL, " +
        "bucketId TEXT NOT NULL, " +
        "bucketName TEXT NOT NULL, " +
        "name TEXT NOT NULL, " +
        "type TEXT NOT NULL, " +
        "size INTEGER NOT NULL, " +
        "version TEXT NOT NULL, " +
        "status TEXT NOT NULL, " +
        "createdAt TEXT NOT NULL, " +
        "updatedAt TEXT NOT NULL, " +
        "deletedAt TEXT" +
        ")");
    sqlite.exec("CREATE TABLE IF NOT EXISTS sporades_file_uploads (" +
        "id TEXT PRIMARY KEY, " +
        "fileId TEXT NOT NULL, " +
        "ownerId TEXT NOT NULL, " +
        "version TEXT NOT NULL, " +
        "expectedSize INTEGER NOT NULL, " +
        "createdAt TEXT NOT NULL" +
        ")");
    sqlite.exec("CREATE TABLE IF NOT EXISTS sporades_file_public_urls (" +
        "id TEXT PRIMARY KEY, " +
        "fileId TEXT NOT NULL, " +
        "ownerId TEXT NOT NULL, " +
        "version TEXT NOT NULL, " +
        "expiresAt TEXT, " +
        "createdAt TEXT NOT NULL, " +
        "revokedAt TEXT" +
        ")");
}
async function readRequestBytes(request, maxBytes) {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        total += chunk.length;
        if (total > maxBytes) {
            throw createStructuredFileError("File is too large.", `Choose a file at or below ${maxBytes} bytes, or raise files.maxSizeBytes in sporades.json.`);
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}
function writeJsonHttpResponse(response, status, result) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify(result)}\n`);
}
function writeNotFound(response) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
}
async function sendFileHttpResponse(database, response, row) {
    const { readFile } = await import("node:fs/promises");
    try {
        const bytes = await readFile(fileVersionPath(database, row.id, row.version));
        response.writeHead(200, {
            "content-type": contentTypeForFile(row.type),
            "cache-control": "private, max-age=31536000, immutable",
        });
        response.end(bytes);
    }
    catch {
        writeNotFound(response);
    }
}
function contentTypeForFile(type) {
    return type || "application/octet-stream";
}
export async function createPendingFileUpload(database, auth, message) {
    const input = message.file ?? {};
    const size = Number(input.size ?? 0);
    if (!Number.isFinite(size) || size < 0) {
        return {
            ok: false,
            error: createStructuredFileError("Invalid file size.", "Pass a browser File or Blob with a finite size."),
        };
    }
    if (size > database.fileMaxSizeBytes) {
        return {
            ok: false,
            error: createStructuredFileError("File is too large.", `Choose a file at or below ${database.fileMaxSizeBytes} bytes, or raise files.maxSizeBytes in sporades.json.`),
        };
    }
    const now = new Date().toISOString();
    const bucket = (await database.sqlite.findFileBucket(auth.userId, "default")) ??
        (await (async () => {
            const bucket = { id: randomUUID(), ownerId: auth.userId, name: "default", createdAt: now };
            await database.sqlite.createFileBucket(bucket);
            return bucket;
        })());
    const replacing = message.replace === true;
    const fileId = replacing ? String(message.fileId ?? "") : randomUUID();
    const existing = replacing ? await fileRowForOwner(database, fileId, auth.userId) : null;
    if (replacing && !existing) {
        return {
            ok: false,
            error: createStructuredFileError("File not found.", "Pass the id of a private file owned by the current user."),
        };
    }
    const uploadId = randomUUID();
    const version = randomUUID();
    const name = String(input.name ?? "upload");
    const type = String(input.type ?? "application/octet-stream");
    if (existing) {
        await database.sqlite.updatePendingFileRow({ id: fileId, name, type, size, version, status: "pending", updatedAt: now });
        await database.sqlite.revokePublicFileUrlsForFile(fileId, now);
    }
    else {
        await database.sqlite.insertFileRow({
            id: fileId,
            ownerId: auth.userId,
            bucketId: bucket.id,
            bucketName: bucket.name,
            name,
            type,
            size,
            version,
            status: "pending",
            createdAt: now,
            updatedAt: now,
        });
    }
    await database.sqlite.insertFileUpload({ id: uploadId, fileId, ownerId: auth.userId, version, expectedSize: size, createdAt: now });
    return {
        ok: true,
        data: {
            uploadUrl: `/__sporades/uploads/${uploadId}`,
            method: "PUT",
            headers: {},
            file: fileMetadataFromRow(await database.sqlite.selectFileById(fileId)),
        },
        error: null,
    };
}
async function completePendingFileUpload(database, uploadId, request, websocketHub = null) {
    const upload = await database.sqlite.selectFileUpload(uploadId);
    if (!upload) {
        return {
            ok: false,
            data: null,
            error: createStructuredFileError("Upload URL not found.", "Request a fresh upload URL from the Sporades client SDK."),
        };
    }
    try {
        websocketHub?.notifyFileEvent?.(upload.ownerId, {
            type: "file.upload.progress",
            fileId: upload.fileId,
            loaded: 0,
            total: upload.expectedSize,
        });
        const bytes = await readRequestBytes(request, database.fileMaxSizeBytes);
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(fileStoragePath(database, upload.fileId), { recursive: true });
        await writeFile(fileVersionPath(database, upload.fileId, upload.version), bytes);
        const now = new Date().toISOString();
        await database.sqlite.completeFileUpload(upload, bytes.length, now);
        await database.sqlite.deleteFileUpload(uploadId);
        const file = fileMetadataFromRow(await database.sqlite.selectFileById(upload.fileId));
        websocketHub?.notifyFileEvent?.(upload.ownerId, {
            type: "file.upload.complete",
            file,
        });
        return { ok: true, data: { file }, error: null };
    }
    catch (error) {
        websocketHub?.notifyFileEvent?.(upload.ownerId, {
            type: "file.upload.failed",
            fileId: upload.fileId,
            error: {
                message: error.message,
                hint: error.hint ?? "Request a fresh upload URL and retry.",
            },
        });
        return {
            ok: false,
            data: null,
            error: {
                message: error.message,
                hint: error.hint ?? "Request a fresh upload URL and retry.",
            },
        };
    }
}
async function getPrivateFileUrl(database, auth, fileId) {
    const row = await fileRowForOwner(database, fileId, auth.userId);
    if (!row) {
        return {
            ok: false,
            error: createStructuredFileError("File not found.", "Pass the id of a private file owned by the current user."),
        };
    }
    return {
        ok: true,
        data: {
            url: `/__sporades/files/private/${row.id}?v=${encodeURIComponent(row.version)}`,
            file: fileMetadataFromRow(row),
        },
        error: null,
    };
}
async function createPublicFileUrl(database, auth, fileId, options = {}) {
    const row = await fileRowForOwner(database, fileId, auth.userId);
    if (!row) {
        return {
            ok: false,
            error: createStructuredFileError("File not found.", "Pass the id of a private file owned by the current user."),
        };
    }
    const expiry = validatePublicUrlExpiry(options);
    if (!expiry.ok) {
        return expiry;
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    await database.sqlite.insertPublicFileUrl({
        id,
        fileId: row.id,
        ownerId: auth.userId,
        version: row.version,
        expiresAt: expiry.expiresAt,
        createdAt: now,
    });
    return {
        ok: true,
        data: {
            publicUrl: {
                id,
                fileId: row.id,
                url: `/__sporades/files/public/${id}?v=${encodeURIComponent(row.version)}`,
                expiresAt: expiry.expiresAt,
                revokedAt: null,
            },
        },
        error: null,
    };
}
async function revokePublicFileUrl(database, auth, publicUrlId) {
    const now = new Date().toISOString();
    const result = await database.sqlite.revokePublicFileUrl(publicUrlId, auth.userId, now);
    if (result.changes === 0) {
        return {
            ok: false,
            error: createStructuredFileError("Public file URL not found.", "Pass a public URL id owned by the current user."),
        };
    }
    return {
        ok: true,
        data: { publicUrl: { id: publicUrlId, revokedAt: now } },
        error: null,
    };
}
async function deletePrivateFile(database, auth, fileId) {
    const row = await fileRowForOwner(database, fileId, auth.userId);
    if (!row) {
        return {
            ok: false,
            error: createStructuredFileError("File not found.", "Pass the id of a private file owned by the current user."),
        };
    }
    const now = new Date().toISOString();
    await database.sqlite.markFileDeleted(row.id, now);
    await database.sqlite.revokePublicFileUrlsForFile(row.id, now);
    await removeFileVersionBestEffort(database, row.id, row.version);
    return {
        ok: true,
        data: { file: fileMetadataFromRow({ ...row, deletedAt: now }) },
        error: null,
    };
}
function validatePublicUrlExpiry(options) {
    const choices = [options.ttlSeconds !== undefined, options.expires !== undefined, options.noExpiry === true].filter(Boolean);
    if (choices.length !== 1) {
        return {
            ok: false,
            error: createStructuredFileError("Public file URLs require exactly one expiry choice.", "Pass exactly one of ttlSeconds, expires, or noExpiry: true."),
        };
    }
    if (options.noExpiry === true) {
        return { ok: true, expiresAt: null };
    }
    if (options.ttlSeconds !== undefined) {
        const ttlSeconds = Number(options.ttlSeconds);
        if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
            return {
                ok: false,
                error: createStructuredFileError("Invalid public file URL TTL.", "Pass a positive ttlSeconds number."),
            };
        }
        return { ok: true, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
    }
    const expiresAt = new Date(options.expires);
    if (Number.isNaN(expiresAt.getTime())) {
        return {
            ok: false,
            error: createStructuredFileError("Invalid public file URL expiry.", "Pass expires as a valid ISO date string."),
        };
    }
    return { ok: true, expiresAt: expiresAt.toISOString() };
}
async function fileRowForOwner(database, fileId, ownerId) {
    return await database.sqlite.fileRowForOwner(fileId, ownerId);
}
function fileMetadataFromRow(row) {
    return {
        id: row.id,
        bucket: row.bucketName,
        size: Number(row.size),
        type: row.type,
        name: row.name,
        path: `/__sporades/files/private/${row.id}?v=${encodeURIComponent(row.version)}`,
        version: row.version,
    };
}
function createStructuredFileError(message, hint) {
    return { message, hint };
}
function fileStoragePath(database, fileId) {
    return `${database.fileStoragePath}/${fileId}`;
}
function fileVersionPath(database, fileId, version) {
    return `${fileStoragePath(database, fileId)}/${version}`;
}
async function removeFileVersionBestEffort(database, fileId, version) {
    const { rm } = await import("node:fs/promises");
    await rm(fileVersionPath(database, fileId, version), { force: true });
}
async function runEndpoint(database, endpoint, requestUrl, request) {
    const createHandler = new Function(`return (${endpoint.handlerSource});`);
    const handler = createHandler();
    const context = await applyContextMiddleware(database, await createEndpointContext(database, requestUrl, request), "endpoint");
    return handler(context);
}
async function createEndpointContext(database, requestUrl, request) {
    const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [
        name.toLowerCase(),
        Array.isArray(value) ? value.join(", ") : value,
    ]));
    const query = Object.fromEntries(requestUrl.searchParams.entries());
    const session = await resolveAnonymousSession(database, readEndpointSessionToken(headers, query));
    const context = {
        auth: session.auth,
        env: database.serverEnv,
        log: createEndpointLogger(database, {
            request: {
                method: request.method,
                path: requestUrl.pathname,
            },
        }),
        request: {
            method: request.method,
            path: requestUrl.pathname,
            headers,
            query,
            body: await readEndpointBody(request, headers),
        },
    };
    const holder = createContextHolder(context);
    context.db = createEndpointDatabaseApi(database, () => holder.current);
    return context;
}
function createContextHolder(context) {
    const holder = { current: context };
    Object.defineProperty(context, "__sporadesContextHolder", {
        value: holder,
        enumerable: false,
        configurable: true,
    });
    return holder;
}
function createTableAclContext(context, database) {
    const { db, request, __pendingAclWrites, __sporadesContextHolder, ...aclContext } = context ?? {};
    return {
        ...aclContext,
        acl: createAclHelpers(database),
    };
}
async function applyContextMiddleware(database, baseContext, kind) {
    let context = {
        ...baseContext,
        kind,
    };
    const holder = baseContext.__sporadesContextHolder ?? createContextHolder(context);
    holder.current = context;
    if (!context.__sporadesContextHolder) {
        Object.defineProperty(context, "__sporadesContextHolder", {
            value: holder,
            enumerable: false,
            configurable: true,
        });
    }
    for (const middlewareSource of database.contextMiddleware) {
        const result = await runContextMiddleware(middlewareSource, context);
        context = result ?? context;
        holder.current = context;
        if (!context.__sporadesContextHolder) {
            Object.defineProperty(context, "__sporadesContextHolder", {
                value: holder,
                enumerable: false,
                configurable: true,
            });
        }
        if (baseContext.__pendingAclWrites && !context.__pendingAclWrites) {
            context.__pendingAclWrites = baseContext.__pendingAclWrites;
        }
    }
    return context;
}
function runContextMiddleware(middlewareSource, context) {
    const createMiddleware = new Function(`return (${middlewareSource});`);
    const middleware = createMiddleware();
    return middleware(context);
}
function readEndpointSessionToken(headers, query) {
    return headers["x-sporades-session-token"] ?? query.sessionToken;
}
function createEndpointDatabaseApi(database, contextGetter = null) {
    return Object.fromEntries(database.schema.tables.map((table) => [table.name, createEndpointTableApi(database, table, {}, contextGetter)]));
}
function createEndpointTableApi(database, table, query = {}, contextGetter = null) {
    return {
        insert(values) {
            const now = new Date().toISOString();
            const row = {
                id: randomUUID(),
                createdAt: now,
                updatedAt: now,
            };
            const fieldValues = table.fields.map((field) => fieldValueForWrite(database, field, Object.hasOwn(values, field.name) && values[field.name] !== undefined ? values[field.name] : field.defaultValue));
            const finish = (resolvedValues) => {
                for (const [index, field] of table.fields.entries()) {
                    row[field.name] = resolvedValues[index];
                }
                const columns = Object.keys(row);
                const next = deserializeRow(table, row);
                return runTableWriteWithAcl(database, table, "insert", null, next, contextGetter, () => {
                    const result = database.sqlite.insertAppRow(table, Object.fromEntries(columns.map((column) => [column, row[column]])));
                    database.rowCache.clear();
                    return thenIfPromise(result, () => next);
                });
            };
            const operation = fieldValues.some(isPromiseLike) ? Promise.all(fieldValues).then(finish) : finish(fieldValues);
            if (isPromiseLike(operation)) {
                contextGetter?.()?.__pendingAclWrites?.push(operation);
            }
            return operation;
        },
        update(id, values) {
            const finishExisting = (existing) => {
                if (!existing) {
                    return null;
                }
                const previous = deserializeRow(table, existing);
                const fieldsToUpdate = table.fields.filter((field) => Object.hasOwn(values, field.name));
                if (fieldsToUpdate.length === 0) {
                    return runTableWriteWithAcl(database, table, "update", previous, previous, contextGetter, () => previous);
                }
                const now = new Date().toISOString();
                const serializedValues = { updatedAt: now };
                const fieldValues = fieldsToUpdate.map((field) => fieldValueForWrite(database, field, values[field.name]));
                const finishValues = (resolvedValues) => {
                    for (const [index, field] of fieldsToUpdate.entries()) {
                        serializedValues[field.name] = resolvedValues[index];
                    }
                    const next = {
                        ...previous,
                        updatedAt: now,
                        ...Object.fromEntries(fieldsToUpdate.map((field) => [field.name, deserializeFieldValue(field, serializedValues[field.name])])),
                    };
                    return runTableWriteWithAcl(database, table, "update", previous, next, contextGetter, () => {
                        const result = database.sqlite.updateAppRow(table, id, serializedValues);
                        database.rowCache.clear();
                        return thenIfPromise(result, (writeResult) => {
                            if (writeResult.changes === 0) {
                                return null;
                            }
                            return next;
                        });
                    });
                };
                return fieldValues.some(isPromiseLike) ? Promise.all(fieldValues).then(finishValues) : finishValues(fieldValues);
            };
            const selected = database.sqlite.selectAppRowById(table, id);
            const operation = thenIfPromise(selected, finishExisting);
            if (isPromiseLike(operation)) {
                contextGetter?.()?.__pendingAclWrites?.push(operation);
            }
            return operation;
        },
        delete(id) {
            const finish = (existing) => {
                if (!existing) {
                    return false;
                }
                const previous = deserializeRow(table, existing);
                return runTableWriteWithAcl(database, table, "delete", previous, null, contextGetter, () => {
                    const result = database.sqlite.deleteAppRow(table, id);
                    database.rowCache.clear();
                    return thenIfPromise(result, (writeResult) => writeResult.changes > 0);
                });
            };
            const operation = thenIfPromise(database.sqlite.selectAppRowById(table, id), finish);
            if (isPromiseLike(operation)) {
                contextGetter?.()?.__pendingAclWrites?.push(operation);
            }
            return operation;
        },
        where(fieldName, value) {
            return createEndpointTableApi(database, table, { ...query, where: { fieldName, value } }, contextGetter);
        },
        orderBy(fieldName, direction = "asc") {
            return createEndpointTableApi(database, table, { ...query, orderBy: { fieldName, direction } }, contextGetter);
        },
        limit(count) {
            return createEndpointTableApi(database, table, { ...query, limit: count }, contextGetter);
        },
        get() {
            const selected = database.sqlite.selectAppRows(table, {
                where: query.where
                    ? {
                        fieldName: query.where.fieldName,
                        value: serializeFieldValue(table.fields.find((field) => field.name === query.where.fieldName), query.where.value),
                    }
                    : null,
                orderBy: query.orderBy,
                limit: 1,
            });
            return thenIfPromise(selected, (rows) => {
                const row = rows[0] ?? null;
                if (!row) {
                    return null;
                }
                const deserialized = deserializeRow(table, row);
                const allowed = applyReadAcl(database, table, deserialized, contextGetter?.());
                return thenIfPromise(allowed, (result) => (result ? deserialized : null));
            });
        },
        all() {
            const limit = Number.isInteger(query.limit) && query.limit >= 0 ? query.limit : null;
            const selected = database.sqlite.selectAppRows(table, {
                where: query.where
                    ? {
                        fieldName: query.where.fieldName,
                        value: serializeFieldValue(table.fields.find((field) => field.name === query.where.fieldName), query.where.value),
                    }
                    : null,
                orderBy: query.orderBy,
                limit,
            });
            return thenIfPromise(selected, (selectedRows) => {
                const rows = selectedRows.map((row) => deserializeRow(table, row));
                return filterRowsByReadAcl(database, table, rows, contextGetter?.());
            });
        },
    };
}
function runTableWriteWithAcl(database, table, operation, previous, next, contextGetter, write) {
    const rule = table.acl?.resolve?.(operation);
    if (!rule) {
        return write();
    }
    const context = contextGetter?.();
    const denialLogData = createAclDenialLogData({
        context,
        table,
        operation,
        previous,
        next,
    });
    const deny = () => {
        if (!context?.__pendingAclWrites) {
            emitAclDeniedLog(database, { data: denialLogData });
        }
        throw createAclDeniedError(denialLogData);
    };
    const result = rule({
        ctx: createTableAclContext(context, database),
        operation,
        table: table.name,
        previous,
        next,
    });
    if (!isPromiseLike(result)) {
        if (!result) {
            deny();
        }
        return write();
    }
    const pending = Promise.resolve(result).then((allowed) => {
        if (!allowed) {
            deny();
        }
        return write();
    });
    context?.__pendingAclWrites?.push(pending);
    return pending;
}
function isPromiseLike(value) {
    return value && typeof value === "object" && typeof value.then === "function";
}
function thenIfPromise(value, onResolved) {
    return isPromiseLike(value) ? value.then(onResolved) : onResolved(value);
}
function chainMaybePromise(steps) {
    let pending = null;
    for (const step of steps) {
        if (pending) {
            pending = pending.then(step);
            continue;
        }
        const result = step();
        if (isPromiseLike(result)) {
            pending = result;
        }
    }
    return pending ?? undefined;
}
function applyReadAcl(database, table, row, context) {
    const rule = table.acl?.resolve?.("read");
    if (!rule) {
        return true;
    }
    const result = rule({
        ctx: createTableAclContext(context, database),
        operation: "read",
        table: table.name,
        row,
    });
    const deny = () => {
        emitAclDeniedLog(database, {
            context,
            table,
            operation: "read",
            row,
        });
        return false;
    };
    if (!isPromiseLike(result)) {
        return result ? true : deny();
    }
    return Promise.resolve(result).then((allowed) => (allowed ? true : deny()));
}
function filterRowsByReadAcl(database, table, rows, context) {
    const decisions = rows.map((row) => applyReadAcl(database, table, row, context));
    if (decisions.some(isPromiseLike)) {
        return Promise.all(decisions).then((resolved) => rows.filter((_, index) => resolved[index]));
    }
    return rows.filter((_, index) => decisions[index]);
}
function createAclHelpers(database) {
    const state = { readCount: 0, maxReads: 32 };
    return Object.freeze({
        db: createAclDbHelpers(database, state),
        storage: createAclStorageHelpers(database, state),
    });
}
function createAclDbHelpers(database, state) {
    return Object.freeze({
        get(tableName, id) {
            assertAclHelperReadAllowed(state);
            const table = resolveAclAppTable(database, tableName);
            return thenIfPromise(database.sqlite.selectAppRowById(table, id), (row) => {
                return row ? deserializeRow(table, row) : null;
            });
        },
        exists(tableName, id) {
            assertAclHelperReadAllowed(state);
            const table = resolveAclAppTable(database, tableName);
            return thenIfPromise(database.sqlite.selectAppRowById(table, id), (row) => Boolean(row));
        },
    });
}
function createAclStorageHelpers(database, state) {
    return Object.freeze({
        get(resourceName, id) {
            assertAclHelperReadAllowed(state);
            const resource = resolveAclStorageResource(resourceName);
            if (resource === "files") {
                return thenIfPromise(database.sqlite.selectFileById(String(id)), (row) => {
                    return row ? aclStorageMetadataFromFileRow(row) : null;
                });
            }
            return null;
        },
        exists(resourceName, id) {
            assertAclHelperReadAllowed(state);
            const resource = resolveAclStorageResource(resourceName);
            if (resource === "files") {
                return thenIfPromise(database.sqlite.selectFileById(String(id)), (row) => Boolean(row));
            }
            return false;
        },
    });
}
function assertAclHelperReadAllowed(state) {
    state.readCount += 1;
    if (state.readCount > state.maxReads) {
        throw commandError("ACL helper read limit exceeded.", "Keep ACL policies bounded; each rule may perform at most 32 helper reads.");
    }
}
function resolveAclAppTable(database, tableName) {
    const normalized = String(tableName ?? "");
    const table = database.schema.tables.find((candidate) => candidate.name === normalized);
    if (!table) {
        throw commandError("Unknown ACL database resource.", "ACL database helpers can inspect Capsule app tables by stable table name only.");
    }
    return table;
}
function resolveAclStorageResource(resourceName) {
    const normalized = String(resourceName ?? "");
    if (normalized === "files") {
        return normalized;
    }
    throw commandError("Unknown ACL storage resource.", "ACL storage helpers can inspect stable storage metadata resources such as files only.");
}
function aclStorageMetadataFromFileRow(row) {
    const metadata = fileMetadataFromRow(row);
    return {
        ...metadata,
        ownerId: row.ownerId,
        bucketId: row.bucketId,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        deletedAt: row.deletedAt ?? null,
    };
}
function emitAclDeniedLog(database, details) {
    database.log?.emit?.({
        category: "platform",
        event: "acl.denied",
        level: "warn",
        message: "ACL denied table operation.",
        data: details.data ?? createAclDenialLogData(details),
    });
}
function createAclDenialLogData({ context, table, operation, row = null, previous = null, next = null }) {
    return {
        resource: {
            kind: "table",
            name: table.name,
        },
        operation,
        rule: {
            category: "table",
            declaredOperation: aclRuleDeclaredOperation(table, operation),
        },
        actor: {
            userId: context?.auth?.userId ?? null,
            provider: context?.auth?.provider ?? null,
            isAuthenticated: context?.auth?.isAuthenticated ?? null,
            isGuest: context?.auth?.isGuest ?? null,
        },
        row: operation === "read" ? aclRowLogSnapshot(row) : aclRowLogSnapshot({ previous, next }),
    };
}
function aclRuleDeclaredOperation(table, operation) {
    if (operation !== "read" && table.acl?.[operation] === undefined && table.acl?.write) {
        return "write";
    }
    return operation;
}
function aclRowLogSnapshot(input) {
    if (input && Object.hasOwn(input, "previous") && Object.hasOwn(input, "next")) {
        const previous = input.previous ?? null;
        const next = input.next ?? null;
        return {
            previousId: previous?.id ?? null,
            nextId: next?.id ?? null,
            previousFields: aclVisibleFieldNames(previous),
            nextFields: aclVisibleFieldNames(next),
            changedFields: aclVisibleFieldNames(next).filter((fieldName) => previous?.[fieldName] !== next?.[fieldName]),
            previousPresent: Boolean(previous),
            nextPresent: Boolean(next),
        };
    }
    return {
        id: input?.id ?? null,
        fields: aclVisibleFieldNames(input),
    };
}
function aclVisibleFieldNames(row) {
    return Object.keys(row ?? {}).filter((fieldName) => !["id", "createdAt", "updatedAt"].includes(fieldName) && !isSensitiveLogKey(fieldName));
}
function createAclDeniedError(logData = null) {
    const error = commandError("Denied.", "The current user is not allowed to perform this operation.", "DENIED");
    if (logData) {
        error.sporadesAclDenialLogData = logData;
    }
    return error;
}
function fieldValueForWrite(database, field, value) {
    if (field.kind === "Reference" && value !== undefined && value !== null) {
        return thenIfPromise(referenceExists(database, field, value), (exists) => {
            if (!exists) {
                throw invalidReferenceError(field);
            }
            return serializeFieldValue(field, value);
        });
    }
    return serializeFieldValue(field, value);
}
function invalidReferenceError(field) {
    return commandError(`Invalid reference for field: ${field.name}`, `Pass the id of an existing ${field.targetTable} row.`);
}
function referenceExists(database, field, value) {
    return database.sqlite.referenceExists(field, value);
}
function serializeFieldValue(field, value) {
    if (value === undefined) {
        return null;
    }
    if (field?.kind === "Json") {
        assertJsonCompatible(value);
        return JSON.stringify(value);
    }
    if (value === null) {
        return null;
    }
    if (field?.kind === "Boolean") {
        return value ? 1 : 0;
    }
    if (field?.kind === "Number") {
        return toSqlNumber(value, field.name);
    }
    if (field?.kind === "Date") {
        return normalizeDateValue(value, field.name);
    }
    if (field?.kind === "Reference") {
        return String(value);
    }
    return String(value ?? "");
}
function deserializeFieldValue(field, value) {
    if (field.kind === "Boolean") {
        return value === null ? null : Boolean(value);
    }
    if (field.kind === "Json") {
        return value === null ? null : JSON.parse(value);
    }
    if (field.kind === "Number") {
        return value === null ? null : Number(value);
    }
    return value;
}
function normalizeDateValue(value, fieldName) {
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
            throw dateValueError(fieldName);
        }
        return value.toISOString();
    }
    if (typeof value !== "string") {
        throw dateValueError(fieldName);
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw dateValueError(fieldName);
    }
    return parsed.toISOString();
}
function dateValueError(fieldName) {
    return commandError(`Invalid date value for field: ${fieldName}`, "Pass an ISO 8601 date string or JavaScript Date value.");
}
function assertJsonCompatible(value) {
    try {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
            throw invalidJsonFieldValueError();
        }
        JSON.parse(serialized);
    }
    catch (error) {
        if (error?.hint) {
            throw error;
        }
        throw invalidJsonFieldValueError();
    }
}
function invalidJsonFieldValueError() {
    return commandError("Invalid JSON field value.", "Use only JSON-compatible values: objects, arrays, strings, numbers, booleans, or null.");
}
function deserializeRow(table, row) {
    const output = { ...row };
    for (const field of table.fields) {
        if (field.kind === "Boolean") {
            output[field.name] = output[field.name] === null ? null : Boolean(output[field.name]);
        }
        else if (field.kind === "Json") {
            output[field.name] = output[field.name] === null ? null : JSON.parse(output[field.name]);
        }
        if (field.kind === "Number") {
            output[field.name] = output[field.name] === null ? null : Number(output[field.name]);
        }
    }
    return output;
}
async function readEndpointBody(request, headers) {
    const chunks = [];
    for await (const chunk of request) {
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) {
        return null;
    }
    if ((headers["content-type"] ?? "").toLowerCase().includes("application/json")) {
        return JSON.parse(raw);
    }
    return raw;
}
function createEndpointLogger(database, context = {}) {
    return createRuntimeLogger(database, {
        category: "app",
        event: "ctx.log",
        ...context,
    });
}
function writeEndpointResult(response, result) {
    if (result && typeof result === "object" && !Buffer.isBuffer(result) && "body" in result) {
        const status = result.status ?? 200;
        if (!Number.isInteger(status) || status < 100 || status > 599) {
            throw endpointResponseError();
        }
        if (result.headers !== undefined &&
            (result.headers === null || typeof result.headers !== "object" || Array.isArray(result.headers))) {
            throw endpointResponseError();
        }
        const headers = { ...(result.headers ?? {}) };
        const body = result.body ?? null;
        if (body !== null && typeof body === "object" && !Buffer.isBuffer(body)) {
            headers["content-type"] ??= "application/json; charset=utf-8";
            let payload;
            try {
                payload = JSON.stringify(body);
            }
            catch {
                throw endpointResponseError();
            }
            response.writeHead(status, headers);
            response.end(payload);
            return;
        }
        headers["content-type"] ??= "text/plain; charset=utf-8";
        response.writeHead(status, headers);
        response.end(String(body ?? ""));
        return;
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(String(result ?? ""));
}
function writeEndpointError(response, error) {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify({
        ok: false,
        data: null,
        error: {
            ...(error?.code ? { code: error.code } : {}),
            message: error?.hint
                ? error.message
                : error?.sporadesEndpointResponse
                    ? "Invalid endpoint response."
                    : "Endpoint handler failed.",
            hint: error?.sporadesEndpointResponse
                ? "Return { status, headers, body } with a numeric status, plain object headers, and a serializable body."
                : error?.hint
                    ? error.hint
                    : "Check the endpoint handler and retry the request.",
        },
    })}\n`);
}
function endpointResponseError() {
    const error = new Error("Invalid endpoint response.");
    error.sporadesEndpointResponse = true;
    return error;
}
function parseFieldDefault(kind, rawDefault) {
    if (rawDefault === undefined) {
        return undefined;
    }
    if (kind === "Boolean") {
        return rawDefault.trim() === "true";
    }
    if (kind === "Number") {
        const value = Number(rawDefault.trim());
        if (!Number.isFinite(value)) {
            throw commandError("Invalid Number() default.", "Pass a finite JavaScript number to Number().default(...).");
        }
        return value;
    }
    const defaultValue = rawDefault.trim().replace(/^["']|["']$/g, "");
    if (kind === "Date") {
        return parseDateFieldDefault(rawDefault);
    }
    if (kind === "Json") {
        return parseJsonFieldDefault(rawDefault);
    }
    return defaultValue;
}
function parseJsonFieldDefault(rawDefault) {
    try {
        const createDefault = new Function(`return (${rawDefault});`);
        const value = createDefault();
        assertJsonCompatible(value);
        return value;
    }
    catch {
        throw commandError("Invalid JSON field default.", "Use a JSON-compatible default value for Json().default(...).");
    }
}
function parseDateFieldDefault(rawDefault) {
    try {
        const createDefault = new Function(`return (${rawDefault});`);
        return normalizeDateValue(createDefault(), "default");
    }
    catch {
        throw commandError("Invalid Date() default.", "Pass an ISO 8601 date string or JavaScript Date value to Date().default(...).");
    }
}
function toSqlLiteral(value, field = null) {
    if (field?.kind === "Json") {
        assertJsonCompatible(value);
        return `'${JSON.stringify(value).replaceAll("'", "''")}'`;
    }
    if (value === null) {
        return "NULL";
    }
    if (field?.kind === "Date") {
        return `'${normalizeDateValue(value, field.name).replaceAll("'", "''")}'`;
    }
    if (typeof value === "boolean") {
        return value ? "1" : "0";
    }
    if (typeof value === "number") {
        return String(value);
    }
    return `'${String(value).replaceAll("'", "''")}'`;
}
export async function listDatabaseTables(database) {
    return await (database.adapter ?? database.sqlite).listInspectableTables();
}
export async function dumpDatabase(database) {
    return await (database.adapter ?? database.sqlite).dumpInspectableDatabase();
}
export async function runReadOnlyQuery(database, sql) {
    return await (database.adapter ?? database.sqlite).runReadOnlyInspectionQuery(sql);
}
function targetsInternalLogIndexTable(sql) {
    const text = String(sql);
    const targetKeywords = /\b(?:from|join|update|into|table)\b/gi;
    let match;
    while ((match = targetKeywords.exec(text))) {
        const reference = readSqlTableReference(text, match.index + match[0].length);
        if (reference.some((part) => part.toLowerCase() === "sporades_log_events")) {
            return true;
        }
    }
    return false;
}
function readSqlTableReference(sql, startIndex) {
    let index = skipSqlTrivia(sql, startIndex);
    while (sql[index] === "(") {
        index += 1;
        index = skipSqlTrivia(sql, index);
    }
    const parts = [];
    while (index < sql.length) {
        const identifier = readSqlIdentifier(sql, index);
        if (!identifier) {
            break;
        }
        parts.push(identifier.value);
        index = skipSqlTrivia(sql, identifier.nextIndex);
        if (sql[index] !== ".") {
            break;
        }
        index = skipSqlTrivia(sql, index + 1);
    }
    return parts;
}
function skipSqlTrivia(sql, startIndex) {
    let index = startIndex;
    let advanced = true;
    while (advanced) {
        advanced = false;
        while (/\s/.test(sql[index] ?? "")) {
            index += 1;
            advanced = true;
        }
        if (sql[index] === "/" && sql[index + 1] === "*") {
            const end = sql.indexOf("*/", index + 2);
            index = end === -1 ? sql.length : end + 2;
            advanced = true;
            continue;
        }
        if (sql[index] === "-" && sql[index + 1] === "-") {
            const end = sql.indexOf("\n", index + 2);
            index = end === -1 ? sql.length : end + 1;
            advanced = true;
        }
    }
    return index;
}
function readSqlIdentifier(sql, index) {
    const quote = sql[index];
    const closingQuote = quote === "[" ? "]" : quote;
    if (quote === '"' || quote === "'" || quote === "`" || quote === "[") {
        let value = "";
        let cursor = index + 1;
        while (cursor < sql.length) {
            if (sql[cursor] === closingQuote) {
                if (sql[cursor + 1] === closingQuote && quote !== "[") {
                    value += closingQuote;
                    cursor += 2;
                    continue;
                }
                return { value, nextIndex: cursor + 1 };
            }
            value += sql[cursor];
            cursor += 1;
        }
        return null;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(index));
    return match ? { value: match[0], nextIndex: index + match[0].length } : null;
}
function isInternalLogIndexMetadataRow(row, sql = "") {
    const queriesSqliteSchema = /\bsqlite_(?:schema|master)\b/i.test(String(sql));
    return (["name", "tbl_name", "table", "tableName"].some((key) => row?.[key] === "sporades_log_events") ||
        Object.values(row ?? {}).some((value) => typeof value === "string" &&
            (/\bcreate\s+table\b[\s\S]*\bsporades_log_events\b/i.test(value) ||
                (queriesSqliteSchema && /\bsporades_log_events\b/i.test(value)))));
}
export async function simulateLocalIdentitySession(database, options = {}) {
    const provider = String(options.provider ?? "").trim().toLowerCase();
    if (!["email", "google"].includes(provider)) {
        return {
            ok: false,
            data: null,
            error: {
                message: `Unsupported simulated auth provider: ${provider || ""}`.trim(),
                hint: "Use `sporades auth as email` for local identity simulation. Google simulation is reserved for provider-shaped browser tests.",
            },
        };
    }
    const email = normalizeSimulatedEmail(options.email);
    if (!email) {
        return {
            ok: false,
            data: null,
            error: {
                message: "Simulated identity requires an email address.",
                hint: "Pass `--email <address>` to `sporades auth as email`.",
            },
        };
    }
    const displayName = normalizeSimulatedText(options.displayName) ?? email;
    const picture = normalizeSimulatedText(options.picture);
    const now = new Date().toISOString();
    const existing = await database.sqlite.findAuthUserByProviderEmail(provider, email);
    const userId = existing?.id ?? randomUUID();
    const token = createSessionToken();
    if (existing) {
        await database.sqlite.updateAuthUserProfile({ id: userId, displayName, picture, isAuthenticated: 1, isGuest: 0 });
    }
    else {
        await database.sqlite.insertAuthUser({
            id: userId,
            createdAt: now,
            displayName,
            email,
            picture,
            isAuthenticated: 1,
            isGuest: 0,
            provider,
        });
    }
    await database.sqlite.insertAuthSession({ token, userId, createdAt: now, expiresAt: sessionExpiresAt(now) });
    const auth = {
        userId,
        displayName,
        email,
        picture,
        isAuthenticated: true,
        isGuest: false,
        provider,
    };
    return {
        ok: true,
        data: {
            localStorage: {
                key: "sporades.sessionToken",
                value: token,
            },
            auth,
        },
        error: null,
    };
}
function normalizeSimulatedEmail(value) {
    const email = normalizeSimulatedText(value)?.toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return null;
    }
    return email;
}
function normalizeSimulatedText(value) {
    if (value === null || value === undefined) {
        return null;
    }
    const text = String(value).trim();
    return text ? text : null;
}
export function createWebSocketHub(getDatabase) {
    const clients = new Set();
    let nextClientId = 1;
    return {
        async accept(request, socket) {
            const key = request.headers["sec-websocket-key"];
            if (!key) {
                socket.destroy();
                return;
            }
            socket.write([
                "HTTP/1.1 101 Switching Protocols",
                "Upgrade: websocket",
                "Connection: Upgrade",
                `Sec-WebSocket-Accept: ${createWebSocketAccept(key)}`,
                "",
                "",
            ].join("\r\n"));
            const requestUrl = new URL(request.url, "http://127.0.0.1");
            const sessionToken = requestUrl.searchParams.get("sessionToken");
            const origin = requestOrigin(request);
            const database = getDatabase();
            const session = await resolveAnonymousSession(database, sessionToken);
            const now = new Date().toISOString();
            const client = {
                id: `client-${(nextClientId++).toString(36)}`,
                socket,
                buffer: Buffer.alloc(0),
                messageQueue: Promise.resolve(),
                subscriptions: new Map(),
                session,
                origin,
                connectedAt: now,
                lastSeenAt: now,
            };
            clients.add(client);
            socket.on("data", (chunk) => {
                client.lastSeenAt = new Date().toISOString();
                client.buffer = Buffer.concat([client.buffer, chunk]);
                drainWebSocketFrames(client, (message) => enqueueClientMessage(client, message));
            });
            socket.on("close", () => clients.delete(client));
            socket.on("error", () => clients.delete(client));
        },
        disconnectAll() {
            for (const client of clients) {
                client.socket.end();
            }
            clients.clear();
        },
        listAuthClients() {
            return [...clients].map((client) => ({
                id: client.id,
                connectedAt: client.connectedAt,
                lastSeenAt: client.lastSeenAt,
                auth: summarizeAuthForClientList(client.session.auth),
            }));
        },
        notifyFileEvent(userId, event) {
            for (const client of clients) {
                if (client.session.auth.userId !== userId) {
                    continue;
                }
                sendJson(client, {
                    id: null,
                    type: "file.event",
                    data: event,
                    error: null,
                });
            }
        },
        deliverAuthSession(target, sessionData) {
            const recipients = authSessionRecipients(target);
            for (const client of recipients) {
                client.session = {
                    token: sessionData.localStorage.value,
                    auth: sessionData.auth,
                };
                sendJson(client, {
                    id: null,
                    type: "auth.session.replace",
                    data: {
                        sessionToken: sessionData.localStorage.value,
                        auth: sessionData.auth,
                    },
                    error: null,
                });
            }
            return {
                target,
                delivered: recipients.length > 0,
                clients: recipients.length,
            };
        },
    };
    function authSessionRecipients(target) {
        if (target === "all") {
            return [...clients];
        }
        if (target === "current") {
            return [...clients].slice(-1);
        }
        return [...clients].filter((client) => client.id === target);
    }
    function requestOrigin(request) {
        const forwardedProto = firstForwardedHeader(request.headers["x-forwarded-proto"]);
        const forwardedHost = firstForwardedHeader(request.headers["x-forwarded-host"]);
        const protocol = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : request.socket?.encrypted ? "https" : "http";
        const host = forwardedHost || request.headers.host;
        return `${protocol}://${host}`;
    }
    function firstForwardedHeader(value) {
        const raw = Array.isArray(value) ? value[0] : value;
        return String(raw ?? "")
            .split(",")[0]
            .trim()
            .toLowerCase();
    }
    function summarizeAuthForClientList(auth) {
        return {
            userId: auth.userId,
            displayName: auth.displayName,
            email: auth.email,
            picture: auth.picture,
            isAuthenticated: auth.isAuthenticated,
            isGuest: auth.isGuest,
            provider: auth.provider,
        };
    }
    function enqueueClientMessage(client, rawMessage) {
        client.messageQueue = client.messageQueue
            .then(() => handleClientMessage(client, rawMessage))
            .catch((error) => {
            sendUnhandledMessageError(client, rawMessage, error);
        });
    }
    function sendUnhandledMessageError(client, rawMessage, error) {
        let id = null;
        try {
            id = JSON.parse(rawMessage)?.id ?? null;
        }
        catch {
            id = null;
        }
        sendJson(client, {
            id,
            type: "error",
            error: {
                message: error?.message || "WebSocket message failed.",
                hint: error?.hint ?? "Retry the request. If this keeps happening, restart the Sporades session.",
            },
        });
    }
    async function handleClientMessage(client, rawMessage) {
        let message;
        try {
            message = JSON.parse(rawMessage);
        }
        catch {
            sendJson(client, {
                id: null,
                type: "error",
                error: {
                    message: "Invalid WebSocket message.",
                    hint: "Send a JSON object with a supported Sporades message type.",
                },
            });
            return;
        }
        const database = getDatabase();
        client.session = await resolveAnonymousSession(database, client.session.token);
        if (message.type === "auth.get") {
            await sendAuthResult(client, message.id ?? null);
            return;
        }
        if (message.type === "auth.signOut") {
            const result = await signOutSession(database, client);
            sendJson(client, {
                id: message.id ?? null,
                type: result.ok ? "auth.signOut.result" : "error",
                data: result.ok ? { ok: true } : null,
                error: result.error ?? null,
            });
            return;
        }
        if (message.type === "auth.signUp") {
            const result = await signUpWithEmail(database, client.session, message.provider, message.credentials ?? {});
            if (result.ok) {
                client.session = {
                    token: result.sessionToken,
                    auth: result.auth,
                };
            }
            sendJson(client, {
                id: message.id ?? null,
                type: result.ok ? "auth.signUp.result" : "error",
                data: result.ok ? { ok: true, sessionToken: result.sessionToken, auth: result.auth } : null,
                error: result.error ?? null,
            });
            return;
        }
        if (message.type === "auth.signIn" || message.type === "auth.signInWithGoogle") {
            const provider = message.type === "auth.signInWithGoogle" ? "google" : message.provider;
            if (provider === "email") {
                const result = await signInWithEmail(database, client.session, message.credentials ?? {});
                if (result.ok) {
                    client.session = {
                        token: result.sessionToken,
                        auth: result.auth,
                    };
                }
                sendJson(client, {
                    id: message.id ?? null,
                    type: result.ok ? "auth.signIn.result" : "error",
                    data: result.ok ? { ok: true, sessionToken: result.sessionToken, auth: result.auth } : null,
                    error: result.error ?? null,
                });
                return;
            }
            if (provider !== "google") {
                sendJson(client, {
                    id: message.id ?? null,
                    type: "error",
                    error: {
                        message: `Unsupported auth provider: ${provider ?? ""}`.trim(),
                        hint: "Use auth.signIn with a configured provider such as google.",
                    },
                });
                return;
            }
            const result = await beginGoogleSignIn(database, client.session, {
                origin: client.origin,
                returnTo: message.returnTo,
            });
            if (!result.ok) {
                sendJson(client, {
                    id: message.id ?? null,
                    type: "error",
                    error: result.error,
                });
                return;
            }
            sendJson(client, {
                id: message.id ?? null,
                type: "auth.redirect",
                data: { url: result.url },
                error: null,
            });
            return;
        }
        if (message.type === "query.subscribe") {
            const queryName = message.query ?? message.name;
            client.subscriptions.set(message.id, { id: message.id, name: queryName, style: message.query ? "direct" : "rows" });
            await sendQueryResult(client, client.subscriptions.get(message.id));
            return;
        }
        if (message.type === "mutation.run") {
            const mutationName = message.mutation ?? message.name;
            const result = await runMutation(database, client.session.auth, mutationName, message.args ?? []);
            sendJson(client, formatMutationResult(message, mutationName, result));
            if (result.ok) {
                setTimeout(() => {
                    for (const subscribedClient of clients) {
                        if (subscribedClient.session.auth.userId !== client.session.auth.userId) {
                            continue;
                        }
                        for (const subscription of subscribedClient.subscriptions.values()) {
                            sendQueryResult(subscribedClient, subscription).catch((error) => {
                                sendUnhandledMessageError(subscribedClient, JSON.stringify({ id: subscription.id }), error);
                            });
                        }
                    }
                }, 0);
            }
            return;
        }
        if (message.type === "app.send") {
            const messageName = message.message ?? message.name;
            const result = await runAppMessage(database, client.session.auth, messageName, message.data, {
                sendAppMessage,
            });
            sendJson(client, {
                id: message.id ?? null,
                type: "app.result",
                message: messageName,
                data: result.data ?? null,
                error: result.error,
            });
            return;
        }
        if (message.type === "file.uploadUrl") {
            const result = await createPendingFileUpload(database, client.session.auth, message);
            sendJson(client, {
                id: message.id ?? null,
                type: result.ok ? "file.uploadUrl.result" : "error",
                data: result.data ?? null,
                error: result.error,
            });
            return;
        }
        if (message.type === "file.url") {
            const result = await getPrivateFileUrl(database, client.session.auth, message.fileId);
            sendJson(client, {
                id: message.id ?? null,
                type: result.ok ? "file.url.result" : "error",
                data: result.data ?? null,
                error: result.error,
            });
            return;
        }
        if (message.type === "file.publicUrl.create") {
            const result = await createPublicFileUrl(database, client.session.auth, message.fileId, message.options ?? {});
            sendJson(client, {
                id: message.id ?? null,
                type: result.ok ? "file.publicUrl.result" : "error",
                data: result.data ?? null,
                error: result.error,
            });
            return;
        }
        if (message.type === "file.publicUrl.revoke") {
            const result = await revokePublicFileUrl(database, client.session.auth, message.publicUrlId);
            sendJson(client, {
                id: message.id ?? null,
                type: result.ok ? "file.publicUrl.revoke.result" : "error",
                data: result.data ?? null,
                error: result.error,
            });
            return;
        }
        if (message.type === "file.delete") {
            const result = await deletePrivateFile(database, client.session.auth, message.fileId);
            sendJson(client, {
                id: message.id ?? null,
                type: result.ok ? "file.delete.result" : "error",
                data: result.data ?? null,
                error: result.error,
            });
            return;
        }
        sendJson(client, {
            id: message.id ?? null,
            type: "error",
            error: {
                message: `Unsupported WebSocket message: ${message.type ?? ""}`.trim(),
                hint: "Use auth.get, auth.signIn, auth.signOut, query.subscribe, mutation.run, app messages, or files.* through the Sporades client SDK.",
            },
        });
    }
    async function sendQueryResult(client, subscription) {
        const database = getDatabase();
        const result = await runQuery(database, client.session.auth, subscription.name);
        const data = subscription.style === "direct"
            ? (result.data ?? result.rows)
            : { rows: result.data ?? result.rows };
        sendJson(client, {
            id: subscription.id,
            type: "query.result",
            query: subscription.name,
            data,
            error: result.error,
        });
    }
    async function sendAuthResult(client, id) {
        const database = getDatabase();
        client.session = await resolveAnonymousSession(database, client.session.token);
        sendJson(client, {
            id,
            type: "auth.result",
            data: {
                sessionToken: client.session.token,
                auth: client.session.auth,
                providers: authProvidersForClient(database.authConfig),
            },
            error: null,
        });
    }
    async function signOutSession(database, client) {
        try {
            await database.sqlite.deleteAuthSession(client.session.token);
            client.session = await resolveAnonymousSession(database, null);
            return { ok: true };
        }
        catch (error) {
            return {
                ok: false,
                error: {
                    message: "Could not sign out.",
                    hint: "Retry sign-out. If this keeps happening, restart the Sporades dev session.",
                },
            };
        }
    }
    function sendAppMessage(senderAuth, appMessage) {
        const scope = appMessage.scope ?? { scope: "user", userId: senderAuth.userId };
        const recipients = clientsForAppMessageScope(scope, senderAuth);
        for (const recipient of recipients) {
            sendJson(recipient, {
                type: "app.message",
                message: appMessage.type,
                data: appMessage.data ?? null,
            });
        }
        return recipients.length;
    }
    function clientsForAppMessageScope(scope, senderAuth) {
        if (scope === "all" || scope?.scope === "all") {
            return [...clients];
        }
        if (scope?.scope === "users") {
            const userIds = new Set((scope.userIds ?? []).map(String));
            return [...clients].filter((candidate) => userIds.has(candidate.session.auth.userId));
        }
        const userId = scope?.userId ?? senderAuth.userId;
        return [...clients].filter((candidate) => candidate.session.auth.userId === userId);
    }
}
export async function routeSporadesAuth(database, request, response) {
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    if (request.method !== "GET" || requestUrl.pathname !== "/__sporades/auth/google/callback") {
        return false;
    }
    const state = requestUrl.searchParams.get("state");
    const code = requestUrl.searchParams.get("code");
    if (!state || !code) {
        writeEndpointError(response, commandError("Invalid Google OAuth callback.", "Retry Google sign-in from the app."));
        return true;
    }
    const stateRow = await database.sqlite.consumeOAuthState(state);
    if (!stateRow) {
        writeEndpointError(response, commandError("Invalid Google OAuth state.", "Retry Google sign-in from the app."));
        return true;
    }
    try {
        const profile = await exchangeGoogleCode(database, code, stateRow.redirectUri);
        const session = await resolveAnonymousSession(database, stateRow.sessionToken);
        const result = await linkGoogleAccount(database, session, profile);
        if (!result.ok) {
            throw commandError(result.error.message, result.error.hint);
        }
        writeRedirect(response, stateRow.returnTo);
    }
    catch (error) {
        writeEndpointError(response, error);
    }
    return true;
}
async function beginGoogleSignIn(database, session, options) {
    if (!database.authConfig.providers.google.enabled || !database.authConfig.google.configured) {
        return {
            ok: false,
            error: {
                message: "Google OAuth is not configured.",
                hint: "Run `sporades auth set google --client-id <id> --client-secret <secret>` or `sporades auth set google --client-json <path>`.",
            },
        };
    }
    const origin = options.origin;
    const redirectUri = `${origin}/__sporades/auth/google/callback`;
    const returnTo = normalizeReturnTo(options.returnTo, origin);
    const state = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    await database.sqlite.insertOAuthState({ state, sessionToken: session.token, returnTo, redirectUri, createdAt: now });
    const clientId = database.serverEnv[database.authConfig.google.clientIdEnv];
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
    });
    return {
        ok: true,
        url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    };
}
function normalizeReturnTo(returnTo, origin) {
    if (!returnTo) {
        return origin;
    }
    try {
        const url = new URL(returnTo, origin);
        if (url.origin !== origin) {
            return origin;
        }
        return url.toString();
    }
    catch {
        return origin;
    }
}
async function exchangeGoogleCode(database, code, redirectUri) {
    const google = database.authConfig.google;
    const tokenUrl = process.env.SPORADES_GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
    const clientId = database.serverEnv[google.clientIdEnv];
    const clientSecret = database.serverEnv[google.clientSecretEnv];
    const tokenResponse = await fetch(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
        }),
    });
    if (!tokenResponse.ok) {
        const details = await readGoogleOAuthError(tokenResponse);
        throw commandError(`Google OAuth code exchange failed${details.message ? `: ${details.message}` : "."}`, details.hint);
    }
    const token = await tokenResponse.json();
    if (!token.access_token) {
        throw commandError("Google OAuth response did not include an access token.", "Check the Google OAuth client configuration and retry sign-in.");
    }
    return fetchGoogleProfile(token.access_token);
}
async function readGoogleOAuthError(response) {
    const fallback = {
        message: "",
        hint: "Check the Google OAuth client configuration and retry sign-in.",
    };
    let body;
    try {
        body = await response.text();
    }
    catch {
        return fallback;
    }
    if (!body) {
        return fallback;
    }
    try {
        const parsed = JSON.parse(body);
        const code = parsed.error ? String(parsed.error) : "";
        const description = parsed.error_description ? String(parsed.error_description) : "";
        return {
            message: [code, description].filter(Boolean).join(": "),
            hint: oauthErrorHint(code, description),
        };
    }
    catch {
        return {
            message: body.slice(0, 240),
            hint: fallback.hint,
        };
    }
}
function oauthErrorHint(code, description) {
    const detail = `${code} ${description}`.toLowerCase();
    if (detail.includes("redirect_uri_mismatch") || detail.includes("redirect_uri")) {
        return "Make sure Google Console has the exact authorized redirect URI shown in the browser callback URL, including scheme, host, and port.";
    }
    if (detail.includes("invalid_client")) {
        return "Check that the Client ID and Client secret belong to the same Web application OAuth client.";
    }
    if (detail.includes("invalid_grant")) {
        return "Retry sign-in from the app. OAuth codes can only be used once and expire quickly; also check that the redirect URI has not changed.";
    }
    return "Check the Google OAuth client configuration and retry sign-in.";
}
async function fetchGoogleProfile(accessToken) {
    const userInfoUrl = process.env.SPORADES_GOOGLE_USERINFO_URL ?? "https://www.googleapis.com/oauth2/v3/userinfo";
    const profileResponse = await fetch(userInfoUrl, {
        headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!profileResponse.ok) {
        throw commandError("Google profile lookup failed.", "Retry Google sign-in with an email-bearing account.");
    }
    const profile = await profileResponse.json();
    return {
        email: profile.email,
        displayName: profile.name ?? profile.email,
        picture: profile.picture ?? null,
    };
}
async function linkGoogleAccount(database, session, profile) {
    if (!profile.email) {
        return {
            ok: false,
            error: {
                message: "Google profile is missing an email address.",
                hint: "Retry Google sign-in with an email-bearing account.",
            },
        };
    }
    const auth = {
        userId: session.auth.userId,
        displayName: profile.displayName ?? profile.email,
        email: profile.email,
        picture: profile.picture ?? null,
        isAuthenticated: true,
        isGuest: false,
        provider: "google",
    };
    await database.sqlite.linkAuthUser({
        id: auth.userId,
        displayName: auth.displayName,
        email: auth.email,
        picture: auth.picture,
        isAuthenticated: 1,
        isGuest: 0,
        provider: "google",
    });
    await refreshSession(database, session.token);
    return { ok: true, auth };
}
function writeRedirect(response, location) {
    response.writeHead(302, { location });
    response.end();
}
export async function signUpWithEmail(database, session, provider, credentials) {
    if (provider !== "email") {
        return {
            ok: false,
            error: {
                message: `Unsupported auth provider: ${provider ?? ""}`.trim(),
                hint: "Use auth.signUp with the email provider.",
            },
        };
    }
    if (!database.authConfig.providers.email.enabled) {
        return { ok: false, error: emailAuthDisabledError() };
    }
    const normalized = normalizeEmailCredentials(credentials);
    if (!normalized.ok) {
        return normalized;
    }
    if (await database.sqlite.emailCredentialExists(normalized.email)) {
        return {
            ok: false,
            error: {
                message: "Email is already registered.",
                hint: "Use auth.signIn(\"email\", ...) with this email address.",
            },
        };
    }
    const password = hashEmailPassword(normalized.password);
    const displayName = normalized.name || normalized.email;
    const auth = {
        userId: session.auth.userId,
        displayName,
        email: normalized.email,
        picture: null,
        isAuthenticated: true,
        isGuest: false,
        provider: "email",
    };
    await database.sqlite.insertEmailCredential({
        email: normalized.email,
        userId: auth.userId,
        passwordHash: password.hash,
        passwordSalt: password.salt,
        createdAt: new Date().toISOString(),
    });
    await database.sqlite.linkAuthUser({
        id: auth.userId,
        displayName: auth.displayName,
        email: auth.email,
        picture: auth.picture,
        isAuthenticated: 1,
        isGuest: 0,
        provider: "email",
    });
    return { ok: true, sessionToken: await rotateSession(database, session, auth.userId), auth };
}
async function signInWithEmail(database, session, credentials) {
    if (!database.authConfig.providers.email.enabled) {
        return { ok: false, error: emailAuthDisabledError() };
    }
    const normalized = normalizeEmailCredentials(credentials);
    if (!normalized.ok) {
        return normalized;
    }
    const row = await database.sqlite.findEmailCredentialWithUser(normalized.email);
    if (!row || !verifyEmailPassword(normalized.password, row.passwordSalt, row.passwordHash)) {
        return {
            ok: false,
            error: {
                message: "Email or password is incorrect.",
                hint: "Check the credentials and try email sign-in again.",
            },
        };
    }
    const auth = {
        userId: row.userId,
        displayName: row.displayName,
        email: row.email,
        picture: row.picture,
        isAuthenticated: Boolean(row.isAuthenticated),
        isGuest: Boolean(row.isGuest),
        provider: row.provider,
    };
    return { ok: true, sessionToken: await rotateSession(database, session, auth.userId), auth };
}
function normalizeEmailCredentials(credentials) {
    const email = String(credentials.email ?? "").trim().toLowerCase();
    const password = String(credentials.password ?? "");
    const name = credentials.name == null ? "" : String(credentials.name).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return {
            ok: false,
            error: {
                message: "Email address is invalid.",
                hint: "Pass credentials with a valid email address.",
            },
        };
    }
    if (password.length < 8) {
        return {
            ok: false,
            error: {
                message: "Password is too short.",
                hint: "Use a password with at least 8 characters.",
            },
        };
    }
    return { ok: true, email, password, name };
}
function hashEmailPassword(password) {
    const salt = randomBytes(16).toString("base64url");
    const hash = scryptSync(password, salt, 64).toString("base64url");
    return { hash, salt };
}
function verifyEmailPassword(password, salt, expectedHash) {
    const actual = scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHash, "base64url");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function emailAuthDisabledError() {
    return {
        message: "Email auth is not enabled.",
        hint: "Enable auth.providers.email in sporades.json.",
    };
}
function createAnonymousAuthTables(sqlite, authConfig = null) {
    sqlite.exec("CREATE TABLE IF NOT EXISTS sporades_auth_users (" +
        "id TEXT PRIMARY KEY, " +
        "createdAt TEXT NOT NULL, " +
        "displayName TEXT NOT NULL, " +
        "email TEXT, " +
        "picture TEXT, " +
        "isAuthenticated INTEGER NOT NULL, " +
        "isGuest INTEGER NOT NULL, " +
        "provider TEXT NOT NULL" +
        ")");
    sqlite.exec("CREATE TABLE IF NOT EXISTS sporades_auth_sessions (" +
        "token TEXT PRIMARY KEY, " +
        "userId TEXT NOT NULL, " +
        "createdAt TEXT NOT NULL, " +
        "expiresAt TEXT NOT NULL" +
        ")");
    ensureSessionLifecycleColumns(sqlite);
    if (authConfig?.providers?.email?.enabled) {
        sqlite.exec("CREATE TABLE IF NOT EXISTS sporades_auth_email_credentials (" +
            "email TEXT PRIMARY KEY, " +
            "userId TEXT NOT NULL, " +
            "passwordHash TEXT NOT NULL, " +
            "passwordSalt TEXT NOT NULL, " +
            "createdAt TEXT NOT NULL" +
            ")");
    }
    sqlite.exec("CREATE TABLE IF NOT EXISTS sporades_auth_oauth_states (" +
        "state TEXT PRIMARY KEY, " +
        "sessionToken TEXT NOT NULL, " +
        "returnTo TEXT NOT NULL, " +
        "redirectUri TEXT NOT NULL, " +
        "createdAt TEXT NOT NULL" +
        ")");
}
function ensureSessionLifecycleColumns(sqlite) {
    const columns = sqlite.prepare("PRAGMA table_info(sporades_auth_sessions)").all();
    const hasExpiresAt = columns.some((column) => column.name === "expiresAt");
    if (!hasExpiresAt) {
        sqlite.exec("ALTER TABLE sporades_auth_sessions ADD COLUMN expiresAt TEXT");
        sqlite
            .prepare("UPDATE sporades_auth_sessions SET expiresAt = ? WHERE expiresAt IS NULL")
            .run(sessionExpiresAt(new Date().toISOString()));
    }
}
async function ensureLibsqlSessionLifecycleColumns(sqlite) {
    const columns = await sqlite.prepare("PRAGMA table_info(sporades_auth_sessions)").all();
    const hasExpiresAt = columns.some((column) => column.name === "expiresAt");
    if (!hasExpiresAt) {
        await sqlite.exec("ALTER TABLE sporades_auth_sessions ADD COLUMN expiresAt TEXT");
        await sqlite
            .prepare("UPDATE sporades_auth_sessions SET expiresAt = ? WHERE expiresAt IS NULL")
            .run(sessionExpiresAt(new Date().toISOString()));
    }
}
function splitSqlStatements(sql) {
    const statements = [];
    let start = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    const text = String(sql ?? "");
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];
        if (lineComment) {
            if (char === "\n") {
                lineComment = false;
            }
            continue;
        }
        if (blockComment) {
            if (char === "*" && next === "/") {
                blockComment = false;
                index += 1;
            }
            continue;
        }
        if (quote) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === "\\") {
                escaped = true;
                continue;
            }
            if (char === quote) {
                if (text[index + 1] === quote && quote !== "`") {
                    index += 1;
                    continue;
                }
                quote = null;
            }
            continue;
        }
        if (char === "-" && next === "-") {
            lineComment = true;
            index += 1;
            continue;
        }
        if (char === "/" && next === "*") {
            blockComment = true;
            index += 1;
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            quote = char;
            continue;
        }
        if (char === ";") {
            const statement = text.slice(start, index).trim();
            if (statement) {
                statements.push(statement);
            }
            start = index + 1;
        }
    }
    const last = text.slice(start).trim();
    if (last) {
        statements.push(last);
    }
    return statements;
}
function sessionExpiresAt(from = new Date().toISOString()) {
    const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
    return new Date(Date.parse(from) + sessionLifetimeMs).toISOString();
}
function isExpiredSession(row) {
    return Date.parse(row.expiresAt) <= Date.now();
}
function createSessionToken() {
    return randomBytes(32).toString("base64url");
}
async function refreshSession(database, token) {
    const now = new Date().toISOString();
    const expiresAt = sessionExpiresAt(now);
    await database.sqlite.refreshAuthSession(token, expiresAt);
    return expiresAt;
}
async function rotateSession(database, session, userId) {
    const now = new Date().toISOString();
    const token = createSessionToken();
    await database.sqlite.rotateAuthSession(session.token, { token, userId, createdAt: now, expiresAt: sessionExpiresAt(now) });
    return token;
}
export async function resolveAnonymousSession(database, sessionToken) {
    if (sessionToken) {
        const existing = await database.sqlite.readAuthSessionWithUser(sessionToken);
        if (existing) {
            if (isExpiredSession(existing)) {
                await database.sqlite.deleteAuthSession(sessionToken);
            }
            else {
                return sessionFromRow(existing);
            }
        }
    }
    const now = new Date().toISOString();
    const userId = randomUUID();
    const token = createSessionToken();
    await database.sqlite.insertAuthUser({
        id: userId,
        createdAt: now,
        displayName: "Anonymous",
        email: null,
        picture: null,
        isAuthenticated: 0,
        isGuest: 1,
        provider: "anonymous",
    });
    await database.sqlite.insertAuthSession({ token, userId, createdAt: now, expiresAt: sessionExpiresAt(now) });
    return {
        token,
        auth: {
            userId,
            displayName: "Anonymous",
            email: null,
            picture: null,
            isAuthenticated: false,
            isGuest: true,
            provider: "anonymous",
        },
    };
}
function sessionFromRow(row) {
    return {
        token: row.token,
        auth: {
            userId: row.userId,
            displayName: row.displayName,
            email: row.email,
            picture: row.picture,
            isAuthenticated: Boolean(row.isAuthenticated),
            isGuest: Boolean(row.isGuest),
            provider: row.provider,
        },
    };
}
function createWebSocketAccept(key) {
    return createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
}
function drainWebSocketFrames(client, onMessage) {
    while (client.buffer.length >= 2) {
        const firstByte = client.buffer[0];
        const secondByte = client.buffer[1];
        const opcode = firstByte & 0x0f;
        const masked = (secondByte & 0x80) !== 0;
        let length = secondByte & 0x7f;
        let offset = 2;
        if (length === 126) {
            if (client.buffer.length < offset + 2)
                return;
            length = client.buffer.readUInt16BE(offset);
            offset += 2;
        }
        else if (length === 127) {
            if (client.buffer.length < offset + 8)
                return;
            length = Number(client.buffer.readBigUInt64BE(offset));
            offset += 8;
        }
        const maskLength = masked ? 4 : 0;
        if (client.buffer.length < offset + maskLength + length)
            return;
        const mask = masked ? client.buffer.subarray(offset, offset + 4) : null;
        offset += maskLength;
        const payload = client.buffer.subarray(offset, offset + length);
        client.buffer = client.buffer.subarray(offset + length);
        if (opcode === 8) {
            client.socket.end();
            return;
        }
        if (opcode !== 1) {
            continue;
        }
        const decoded = Buffer.alloc(payload.length);
        for (let index = 0; index < payload.length; index += 1) {
            decoded[index] = mask ? payload[index] ^ mask[index % 4] : payload[index];
        }
        onMessage(decoded.toString("utf8"));
    }
}
function sendJson(client, message) {
    const payload = Buffer.from(JSON.stringify(message));
    let header;
    if (payload.length < 126) {
        header = Buffer.from([0x81, payload.length]);
    }
    else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
    }
    else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    client.socket.write(Buffer.concat([header, payload]));
}
async function runQuery(database, auth, queryName) {
    let context;
    try {
        context = await applyContextMiddleware(database, createMutationContext(database, auth), "query");
    }
    catch (error) {
        return {
            rows: null,
            error: {
                message: error.message,
                hint: error.hint ?? "Check the Capsule context middleware and retry the query.",
            },
        };
    }
    if (queryName === "ctx.env") {
        return { data: context.env, error: null };
    }
    const customResult = await runCustomQuery(database, context, queryName);
    if (customResult) {
        return customResult;
    }
    const table = resolveTableForQuery(database.schema, queryName);
    if (!table) {
        return {
            rows: null,
            error: {
                message: `Unknown query: ${queryName}`,
                hint: "Use a query defined by the capsule.",
            },
        };
    }
    const cacheKey = `${table.name}:${context.auth.userId}`;
    if (!database.rowCache.has(cacheKey)) {
        const columns = ["id", "createdAt", "updatedAt", ...table.fields.map((field) => field.name)];
        const ownerScoped = table.fields.some((field) => field.name === "ownerId");
        const rows = (await database.sqlite.selectAppRows(table, {
            columns,
            ownerId: ownerScoped ? context.auth.userId : undefined,
            orderBy: { fieldName: "createdAt", direction: "desc" },
        })).map((row) => rowToApiValue(row, table));
        database.rowCache.set(cacheKey, rows);
    }
    const rows = await filterRowsByReadAcl(database, table, database.rowCache.get(cacheKey), context);
    return { rows, error: null };
}
async function runCustomQuery(database, context, queryName) {
    const handler = database.queries.find((candidate) => candidate.name === queryName);
    if (!handler) {
        return null;
    }
    try {
        const queryHandler = typeof handler.handler === "function"
            ? handler.handler
            : new Function(`return (${handler.handlerSource});`)();
        const data = await queryHandler(context);
        assertJsonCompatible(data);
        return { data, error: null };
    }
    catch (error) {
        return {
            data: null,
            error: {
                message: error?.message || "Query handler failed.",
                hint: error?.hint ?? "Check the Capsule query handler and retry the query.",
            },
        };
    }
}
export async function runMutation(database, auth, mutationName, args) {
    let context;
    let result;
    try {
        return await (database.adapter ?? database.sqlite).withTransaction(async (transactionAdapter) => {
            const transactionDatabase = transactionAdapter
                ? { ...database, adapter: transactionAdapter, sqlite: transactionAdapter }
                : database;
            context = await applyContextMiddleware(transactionDatabase, createMutationContext(transactionDatabase, auth), "mutation");
            for (const hookSource of database.mutationHooks.beforeMutation) {
                await runMutationHook(hookSource, { name: mutationName, args, ctx: context });
            }
            result = await runCustomMutation(transactionDatabase, context, mutationName, args);
            if (!result) {
                result = mutationName.startsWith("update")
                    ? await runUpdateMutation(transactionDatabase, context, mutationName, args)
                    : await runInsertMutation(transactionDatabase, context, mutationName, args);
            }
            await drainPendingAclWrites(context);
            if (result.ok) {
                for (const hookSource of database.mutationHooks.afterMutation) {
                    await runMutationHook(hookSource, { name: mutationName, args, ctx: context, result });
                }
                await drainPendingAclWrites(context);
            }
            return result;
        });
    }
    catch (error) {
        database.rowCache.clear();
        if (error?.sporadesAclDenialLogData) {
            emitAclDeniedLog(database, { data: error.sporadesAclDenialLogData });
        }
        return createHookErrorResult(error);
    }
}
async function runCustomMutation(database, context, mutationName, args) {
    const handler = database.mutations.find((candidate) => candidate.name === mutationName);
    if (!handler) {
        return null;
    }
    const mutationHandler = typeof handler.handler === "function"
        ? handler.handler
        : new Function(`return (${handler.handlerSource});`)();
    let result;
    try {
        result = await mutationHandler(context, ...args);
    }
    finally {
        await drainPendingAclWrites(context);
    }
    if (result !== undefined) {
        assertJsonCompatible(result);
    }
    database.rowCache.clear();
    return { ok: true, data: result ?? null, error: null };
}
async function runAppMessage(database, auth, messageName, data, options = {}) {
    if (!messageName) {
        return {
            data: null,
            error: {
                message: "Missing app message type.",
                hint: "Pass an unprefixed message name declared by the Capsule.",
            },
        };
    }
    try {
        validateAppMessageType(messageName);
    }
    catch (error) {
        return {
            data: null,
            error: {
                message: error.message,
                hint: error.hint,
            },
        };
    }
    const handler = database.messages.find((candidate) => candidate.name === messageName);
    if (!handler) {
        return {
            data: null,
            error: {
                message: `Unknown app message: ${messageName}`,
                hint: "Use an app message declared by the Capsule.",
            },
        };
    }
    try {
        if (data !== undefined) {
            assertJsonCompatible(data);
        }
        const context = await applyContextMiddleware(database, createMessageContext(database, auth, options.sendAppMessage), "message");
        const createHandler = new Function(`return (${handler.handlerSource});`);
        const result = await createHandler()(context, data);
        if (result !== undefined) {
            assertJsonCompatible(result);
        }
        return { data: result ?? null, error: null };
    }
    catch (error) {
        return {
            data: null,
            error: {
                message: error?.message || "App message handler failed.",
                hint: error?.hint ?? "Check the Capsule message handler and retry the app message.",
            },
        };
    }
}
function validateAppMessageType(type) {
    const value = String(type ?? "");
    const reservedPrefixes = ["app.", "auth.", "query.", "mutation.", "file.", "files.", "runtime.", "upload."];
    const reservedExact = new Set(["error", "refresh"]);
    if (reservedExact.has(value) || reservedPrefixes.some((prefix) => value.startsWith(prefix))) {
        throw commandError(`Reserved app message type: ${value}`, "Use an unprefixed app message type that does not start with a Sporades platform namespace.");
    }
    if (!value || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) {
        throw commandError(`Invalid app message type: ${value}`, "Use an unprefixed app message type containing letters, numbers, underscores, or hyphens.");
    }
}
function isAllAppMessageScope(scope) {
    return scope === "all" || scope?.scope === "all";
}
function createMessageContext(database, auth, sendAppMessage) {
    return {
        ...createMutationContext(database, auth),
        messages: {
            send(appMessage) {
                validateAppMessageType(appMessage?.type);
                if (isAllAppMessageScope(appMessage?.scope)) {
                    throw commandError("Client-origin app messages cannot broadcast to all clients.", "Use the default current-user scope or an explicit users scope authorized by the message handler.");
                }
                if (appMessage?.data !== undefined) {
                    assertJsonCompatible(appMessage.data);
                }
                return sendAppMessage?.(auth, appMessage) ?? 0;
            },
        },
    };
}
async function runMutationHook(hookSource, event) {
    const createHook = new Function(`return (${hookSource});`);
    const hook = createHook();
    return await hook(event);
}
function createMutationContext(database, auth) {
    const context = {
        auth,
        env: database.serverEnv,
        log: createEndpointLogger(database),
        __pendingAclWrites: [],
    };
    const holder = createContextHolder(context);
    context.db = createEndpointDatabaseApi(database, () => holder.current);
    return context;
}
async function drainPendingAclWrites(context) {
    while (context?.__pendingAclWrites?.length > 0) {
        const pending = context.__pendingAclWrites.splice(0);
        await Promise.all(pending);
    }
}
function createHookErrorResult(error) {
    return {
        ok: false,
        error: {
            ...(error?.code ? { code: error.code } : {}),
            message: error?.message || "Mutation hook failed.",
            hint: error?.hint ?? "Check the Capsule mutation hooks and retry the mutation.",
        },
    };
}
async function runInsertMutation(database, context, mutationName, args) {
    const table = resolveTableForAddMutation(database.schema, mutationName);
    if (!table) {
        return {
            ok: false,
            error: {
                message: `Unknown mutation: ${mutationName}`,
                hint: "Use a mutation defined by the capsule.",
            },
        };
    }
    const now = new Date().toISOString();
    const values = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
    };
    try {
        for (const field of table.fields) {
            if (field.name === "ownerId") {
                values[field.name] = context.auth.userId;
                continue;
            }
            if (field.name === "text") {
                values[field.name] = String(args[0] ?? "");
                continue;
            }
            const positionalIndex = table.fields.filter((candidate) => candidate.name !== "ownerId").indexOf(field);
            if (args[positionalIndex] !== undefined) {
                values[field.name] = await fieldValueForWrite(database, field, args[positionalIndex]);
                continue;
            }
            if (field.defaultValue !== undefined) {
                values[field.name] = await fieldValueForWrite(database, field, field.defaultValue);
            }
            else {
                values[field.name] = null;
            }
        }
    }
    catch (error) {
        return { ok: false, error: { message: error.message, hint: error.hint } };
    }
    const missingField = table.fields.find((field) => values[field.name] === undefined);
    if (missingField) {
        return {
            ok: false,
            error: {
                message: `Missing value for field: ${missingField.name}`,
                hint: "Pass a value accepted by the capsule mutation.",
            },
        };
    }
    await runTableWriteWithAcl(database, table, "insert", null, deserializeRow(table, values), () => context, async () => {
        await database.sqlite.insertAppRow(table, values);
        database.rowCache.clear();
    });
    return { ok: true, error: null };
}
async function runUpdateMutation(database, context, mutationName, args) {
    const resolved = resolveTableForUpdateMutation(database.schema, mutationName);
    if (!resolved) {
        return {
            ok: false,
            error: {
                message: `Unknown mutation: ${mutationName}`,
                hint: "Use a mutation defined by the capsule.",
            },
        };
    }
    const [id, value] = args;
    if (!id) {
        return {
            ok: false,
            error: {
                message: "Missing value for field: id",
                hint: "Pass a value accepted by the capsule mutation.",
            },
        };
    }
    if (value === undefined) {
        return {
            ok: false,
            error: {
                message: `Missing value for field: ${resolved.field.name}`,
                hint: "Pass a value accepted by the capsule mutation.",
            },
        };
    }
    const now = new Date().toISOString();
    const ownerScoped = resolved.table.fields.some((field) => field.name === "ownerId");
    const previousRow = (await database.sqlite.selectAppRows(resolved.table, {
        ownerId: ownerScoped ? context.auth.userId : undefined,
        where: { fieldName: "id", value: String(id) },
        limit: 1,
    }))[0] ?? null;
    let nextValue;
    try {
        nextValue = await fieldValueForWrite(database, resolved.field, value);
    }
    catch (error) {
        return { ok: false, error: { message: error.message, hint: error.hint } };
    }
    const write = async () => {
        await database.sqlite.updateAppRow(resolved.table, id, {
            [resolved.field.name]: nextValue,
            updatedAt: now,
        }, { ownerId: ownerScoped ? context.auth.userId : undefined });
        database.rowCache.clear();
    };
    if (previousRow) {
        const previous = deserializeRow(resolved.table, previousRow);
        const next = {
            ...previous,
            updatedAt: now,
            [resolved.field.name]: deserializeFieldValue(resolved.field, nextValue),
        };
        await runTableWriteWithAcl(database, resolved.table, "update", previous, next, () => context, write);
    }
    else {
        await write();
    }
    return { ok: true, error: null };
}
function formatMutationResult(message, mutationName, result) {
    const formatted = {
        id: message.id,
        type: "mutation.result",
        data: result.data ?? null,
        error: result.error,
    };
    if (message.mutation) {
        formatted.mutation = mutationName;
    }
    else if (message.name) {
        formatted.ok = result.ok;
    }
    return formatted;
}
function authStatus(config, serverEnv) {
    const authConfig = config.auth ?? { mode: "anonymous" };
    const normalized = normalizeAuthConfig(authConfig);
    const clientIdEnv = normalized.providers.google.clientIdEnv;
    const clientSecretEnv = normalized.providers.google.clientSecretEnv;
    const providers = {
        anonymous: {
            enabled: normalized.providers.anonymous.enabled,
        },
        google: {
            enabled: normalized.providers.google.enabled,
            configured: Boolean(clientIdEnv && clientSecretEnv && serverEnv[clientIdEnv] && serverEnv[clientSecretEnv]),
            clientIdEnv,
            clientSecretEnv,
        },
    };
    if (normalized.providers.email.enabled) {
        providers.email = {
            enabled: true,
        };
    }
    return {
        mode: normalized.mode,
        providers,
        google: {
            configured: providers.google.configured,
            clientIdEnv,
            clientSecretEnv,
        },
    };
}
function normalizeAuthConfig(authConfig) {
    const providerConfig = authConfig.providers ?? {};
    for (const provider of Object.keys(providerConfig)) {
        if (!["anonymous", "google", "email"].includes(provider)) {
            throw commandError(`Unsupported auth provider: ${provider}`, "Use supported auth providers: anonymous, google, email.");
        }
    }
    const googleConfig = readProviderConfig(providerConfig.google);
    const legacyGoogle = authConfig.google ?? {};
    const googleEnabled = googleConfig.enabled || authConfig.mode === "google";
    const emailConfig = readProviderConfig(providerConfig.email);
    const anonymousConfig = readProviderConfig(providerConfig.anonymous);
    const anonymousEnabled = providerConfig.anonymous === undefined ? true : anonymousConfig.enabled;
    const mode = authConfig.mode ?? (googleEnabled ? "google" : "anonymous");
    return {
        mode,
        providers: {
            anonymous: {
                enabled: anonymousEnabled,
            },
            google: {
                enabled: googleEnabled,
                clientIdEnv: googleConfig.clientIdEnv ?? legacyGoogle.clientIdEnv ?? null,
                clientSecretEnv: googleConfig.clientSecretEnv ?? legacyGoogle.clientSecretEnv ?? null,
            },
            email: {
                enabled: emailConfig.enabled,
            },
        },
    };
}
function readProviderConfig(config) {
    if (config === true) {
        return { enabled: true };
    }
    if (config === false || config === undefined || config === null) {
        return { enabled: false };
    }
    return {
        enabled: config.enabled !== false,
        clientIdEnv: config.clientIdEnv ?? null,
        clientSecretEnv: config.clientSecretEnv ?? null,
    };
}
function authProvidersForClient(authConfig) {
    const providers = {};
    for (const [name, provider] of Object.entries(authConfig.providers)) {
        if (name === "google") {
            providers.google = {
                enabled: provider.enabled,
                configured: provider.configured,
            };
            continue;
        }
        providers[name] = {
            enabled: provider.enabled,
        };
    }
    return providers;
}
function resolveTableForQuery(schema, queryName) {
    return schema.tables.find((table) => table.name === queryName) ?? null;
}
function resolveTableForAddMutation(schema, mutationName) {
    if (!mutationName.startsWith("add") || mutationName.length <= 3) {
        return null;
    }
    const tableName = tableNameForSingular(mutationName.slice(3));
    return schema.tables.find((table) => table.name === tableName) ?? null;
}
function resolveTableForUpdateMutation(schema, mutationName) {
    const match = mutationName.match(/^update([A-Z][A-Za-z0-9]*?)([A-Z][A-Za-z0-9]*)$/);
    if (!match) {
        return null;
    }
    const table = schema.tables.find((candidate) => candidate.name === tableNameForSingular(match[1]));
    if (!table) {
        return null;
    }
    const fieldName = `${match[2][0].toLowerCase()}${match[2].slice(1)}`;
    const field = table.fields.find((candidate) => candidate.name === fieldName);
    return field ? { table, field } : null;
}
function tableNameForSingular(singular) {
    return `${singular[0].toLowerCase()}${singular.slice(1)}s`;
}
function rowToApiValue(row, table) {
    const value = { ...row };
    for (const field of table.fields) {
        if (field.kind === "Boolean") {
            value[field.name] = value[field.name] === null ? null : Boolean(value[field.name]);
        }
        else if (field.kind === "Json") {
            value[field.name] = value[field.name] === null ? null : JSON.parse(value[field.name]);
        }
        if (field.kind === "Number") {
            value[field.name] = value[field.name] === null ? null : Number(value[field.name]);
        }
    }
    return value;
}
function toSqlNumber(value, fieldName) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw commandError(`Invalid number for field: ${fieldName}`, "Pass a finite JavaScript number for Number() fields.");
    }
    return value;
}
function quoteIdentifier(identifier) {
    return `"${identifier.replaceAll('"', '""')}"`;
}
//# sourceMappingURL=server-runtime-source.js.map