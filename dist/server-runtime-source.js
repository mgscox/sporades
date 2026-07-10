import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
const PRIVILEGED_AUTH_USER_ID = "__privileged__";
const EMAIL_SIGN_IN_FAILURE_LIMIT = 5;
const EMAIL_SIGN_IN_THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_SIGN_IN_THROTTLE_MAX_ENTRIES = 256;
export const SERVER_RUNTIME_SOURCE_FUNCTIONS = [
    readJsonRequest,
    readLimitedRequestBody,
    resolveHttpMaxBodyBytes,
    createPayloadTooLargeError,
    isPayloadTooLargeError,
    writeUnhandledHttpError,
    emitHttpFailureLog,
    prepareHttpSecurity,
    resolveRuntimeSecurityPolicy,
    defaultRuntimeCspDirectives,
    serializeCspDirectives,
    injectPageConnectionToken,
    requestOriginAllowed,
    websocketOriginAllowed,
    isSameOriginRequest,
    isLocalDevOrigin,
    normalizeOrigin,
    appendVaryHeader,
    sanitizeResponseHeaders,
    createSqliteDatabaseAdapter,
    createLibsqlDatabaseAdapter,
    createPostgresDatabaseAdapter,
    createRuntimeDatabaseAdapter,
    createRuntimeClock,
    resolveSchedulePayloadFactoryTimeoutMs,
    scheduleDefinitionsFromCapsule,
    parseScheduleExpression,
    nextScheduleOccurrence,
    ensureScheduleStorage,
    reconcileSchedules,
    startStaticSchedules,
    recordScheduledOccurrence,
    acquireSchedulePayloadFactoryLane,
    acquireSchedulePayloadFactorySlot,
    resolveSchedulePayload,
    abortSchedulePayloadFactories,
    enqueueScheduledOccurrence,
    createRuntimeInspectionAdapter,
    inspectRuntimeJobs,
    jobError,
    boundedJobJson,
    jobState,
    normalizeJobRetry,
    cancelJob,
    jobSummary,
    createCurrentUserJobApi,
    createPrivilegedJobApi,
    assertJobScheduleProvenance,
    assertActivePrivilegedJobAccess,
    encodeJobCursor,
    decodeJobCursor,
    flushPendingJobEnqueues,
    scheduleCurrentUserJobWorker,
    scheduleNextDelayedJob,
    runCurrentUserJobWorker,
    safeJobFailure,
    postgresPlaceholders,
    postgresInterpolate,
    createPostgresConnection,
    postgresUrlOptions,
    postgresPasswordMessage,
    createPostgresScramSession,
    postgresStartupMessage,
    postgresQueryMessage,
    postgresInt32,
    waitForPostgresData,
    wakePostgresWaiters,
    postgresParseRowDescription,
    postgresParseDataRow,
    postgresValueFromText,
    postgresRowCountFromCommand,
    postgresErrorFromBody,
    postgresRowsFromResult,
    postgresRuntimeColumnName,
    postgresAppTableColumnDefinitions,
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
    recoverExpiredJobLeases,
    jobHandlersFromCapsuleDefinition,
    ensureJobStorage,
    createRuntimeLogSink,
    requirePathModule,
    createRuntimeLogger,
    createPrivilegedAuditEmitter,
    emitPrivilegedAuditEvent,
    createContextPrivilegedApi,
    emitPrivilegedRunAudit,
    recordPrivilegedAuditEventForTransaction,
    reindexPrivilegedAuditEventsAfterRollback,
    privilegedAuditEventAlreadyIndexed,
    samePrivilegedAuditLogEvent,
    normalizePrivilegedRunSignal,
    createPrivilegedRunAbortError,
    createPrivilegedRunAuditDetails,
    validatedPrivilegedOperation,
    validatedPrivilegedMetadata,
    isPlainPrivilegedMetadata,
    invalidPrivilegedRunMetadata,
    createPrivilegedRunPublicError,
    createPrivilegedAuditEmissionPublicError,
    isPrivilegedAuditEmissionPublicError,
    createPrivilegedHandlerContext,
    createPrivilegedFileApi,
    privilegedAuthUserId,
    isReservedAuthUserId,
    assertNotReservedAuthUserId,
    createPrivilegedAuditLogInput,
    normalizePrivilegedAuditActorKind,
    normalizePrivilegedAuditOutcome,
    safePrivilegedAuditErrorCode,
    auditString,
    createLogEnvelope,
    sanitizeLogData,
    redactLogData,
    logDataContainsServerEnvValue,
    isSensitiveLogString,
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
    createTransactionDatabase,
    readEndpointRequest,
    createEndpointContext,
    createContextHolder,
    createTableAclContext,
    applyContextMiddleware,
    runContextMiddleware,
    readEndpointSessionToken,
    endpointQueryFromUrl,
    privilegedDbAccessContextSet,
    grantPrivilegedDbAccess,
    revokePrivilegedDbAccess,
    hasPrivilegedDbAccess,
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
    requireAuth,
    createUnauthenticatedError,
    createAuthDenialLogData,
    emitAuthDeniedLog,
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
    createRuntimeFileStorageAdapter,
    createLocalFileStorageAdapter,
    localFileStoragePath,
    localFileVersionPath,
    createS3CompatibleFileStorageAdapter,
    s3ObjectKey,
    s3Request,
    s3RequestBodyBuffer,
    s3SignedHeaders,
    s3Signature,
    s3SigningKey,
    s3CanonicalPath,
    s3EncodedPathSegment,
    s3StorageNamespace,
    s3AmzDate,
    s3Hmac,
    s3Sha256Hex,
    s3ObjectNotFoundError,
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
    fileMetadataFromUpload,
    runFileMetadataTransaction,
    resolveFileWriteTarget,
    normalizeAbsoluteFilePath,
    normalizeFileName,
    isAbsoluteFilePath,
    resolveLiveFileReference,
    resolvePrivilegedLiveFileReference,
    singleActiveFileRowByPath,
    singleLiveFileRowByPath,
    ambiguousFileReferenceError,
    structuredFileException,
    ensureFileBucket,
    isDuplicateColumnError,
    isUniqueConstraintError,
    filePathBackfillSql,
    activeFilePathDedupeSql,
    ensureFileUploadTargetColumns,
    runSchemaExecIgnoringDuplicateColumn,
    chainSchemaOperation,
    withFileUploadPathLock,
    createStructuredFileError,
    validatePublicUrlExpiry,
    fileRowForOwner,
    removeFileVersionBestEffort,
    contentTypeForFile,
    createAnonymousAuthTables,
    createUserPreferencesTables,
    ensureSessionLifecycleColumns,
    sessionExpiresAt,
    isExpiredSession,
    createSessionToken,
    refreshSession,
    refreshSessionOnAdapter,
    rotateSession,
    rotateSessionOnAdapter,
    moveSessionToUser,
    moveSessionToUserOnAdapter,
    migrateAnonymousPreferences,
    resolveAnonymousSession,
    sessionFromRow,
    readCurrentUserPreferences,
    updateCurrentUserPreferences,
    normalizePreferencesPatch,
    createPreferencesError,
    authProvidersForClient,
    routeSporadesAuth,
    signUpWithEmail,
    signInWithEmail,
    createEmailSignInThrottleState,
    emailSignInThrottleKeys,
    currentEmailSignInThrottleState,
    recordFailedEmailSignInAttempt,
    resetEmailSignInAttempts,
    pruneEmailSignInThrottleState,
    boundEmailSignInThrottleState,
    emailSignInThrottleEvictionPriority,
    callerContextKey,
    invalidEmailCredentialsError,
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
    closeWebSocketClient,
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
    runMutationHookAndDrainPendingAclWrites,
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
export async function readJsonRequest(request, limitSource = null) {
    const raw = (await readLimitedRequestBody(request, limitSource)).toString("utf8");
    return raw ? JSON.parse(raw) : {};
}
async function readLimitedRequestBody(request, limitSource = null) {
    const maxBytes = resolveHttpMaxBodyBytes(limitSource);
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > maxBytes) {
            throw createPayloadTooLargeError(maxBytes);
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}
function resolveHttpMaxBodyBytes(source = null) {
    const configured = typeof source === "number"
        ? source
        : Number(source?.httpMaxBodyBytes ?? source?.http?.maxBodyBytes ?? source?.config?.http?.maxBodyBytes);
    return Number.isInteger(configured) && configured > 0 ? configured : 1024 * 1024;
}
function createPayloadTooLargeError(maxBytes) {
    const error = new Error("Request body is too large.");
    error.code = "PAYLOAD_TOO_LARGE";
    error.hint = `Send a request body at or below ${maxBytes} bytes, or raise http.maxBodyBytes in sporades.json.`;
    return error;
}
function isPayloadTooLargeError(error) {
    return error?.code === "PAYLOAD_TOO_LARGE";
}
export function writeUnhandledHttpError(database, request, response, error) {
    emitHttpFailureLog(database, request, error);
    if (isPayloadTooLargeError(error)) {
        response.writeHead(413, { "content-type": "application/json; charset=utf-8" });
        response.end(`${JSON.stringify({ ok: false, data: null, error: { code: error.code, message: error.message, hint: error.hint } })}\n`);
        return;
    }
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify({
        ok: false,
        data: null,
        error: {
            message: "Internal server error.",
            hint: "Check server logs and retry the request.",
        },
    })}\n`);
}
function emitHttpFailureLog(database, request, error, context = {}) {
    const requestUrl = new URL(request.url ?? context.path ?? "/", "http://127.0.0.1");
    database.log?.emit?.({
        category: "platform",
        event: "http.request.failed",
        level: "error",
        message: isPayloadTooLargeError(error) ? "HTTP request body exceeded the configured limit." : "HTTP request failed.",
        request: {
            method: request.method ?? context.method ?? null,
            path: requestUrl.pathname,
        },
        data: {
            code: error?.code ?? null,
            message: error?.message ?? String(error),
            hint: error?.hint ?? null,
            stack: error?.stack ?? null,
        },
    });
}
export function prepareHttpSecurity(database, request, response) {
    const policy = database.securityPolicy ?? resolveRuntimeSecurityPolicy({});
    const originalWriteHead = response.writeHead.bind(response);
    response.writeHead = ((statusCode, statusMessageOrHeaders, maybeHeaders) => {
        const statusMessage = typeof statusMessageOrHeaders === "string" ? statusMessageOrHeaders : undefined;
        const inputHeaders = statusMessage ? maybeHeaders : typeof statusMessageOrHeaders === "string" ? {} : statusMessageOrHeaders;
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
            headers["access-control-allow-origin"] = policy.cors.publicDev ? "*" : String(origin);
            if (!policy.cors.publicDev) {
                headers.vary = appendVaryHeader(headers.vary, "Origin");
            }
        }
        if (statusMessage) {
            return originalWriteHead(statusCode, statusMessage, headers);
        }
        return originalWriteHead(statusCode, headers);
    });
    if (request.method === "OPTIONS" && request.headers.origin && request.headers["access-control-request-method"]) {
        const headers = {
            "content-length": "0",
        };
        if (requestOriginAllowed(policy, request)) {
            headers["access-control-allow-origin"] = policy.cors.publicDev ? "*" : String(request.headers.origin);
            headers["access-control-allow-methods"] = "GET,POST,PUT,DELETE,OPTIONS";
            headers["access-control-allow-headers"] = String(request.headers["access-control-request-headers"] ?? "content-type,x-sporades-session-token");
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
    const publicOrigin = normalizeOrigin(config.__sporadesPublicOrigin);
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
            publicOrigin,
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
export function injectPageConnectionToken(html, token) {
    const script = `<script>window.__SPORADES_CONNECTION_TOKEN=${JSON.stringify(token)};</script>`;
    if (/<head(\s[^>]*)?>/i.test(html)) {
        return html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n${script}`);
    }
    return `${script}\n${html}`;
}
function requestOriginAllowed(policy, request) {
    const origin = request.headers.origin;
    if (!origin) {
        return false;
    }
    if (policy.cors.publicDev) {
        return true;
    }
    if (policy.cors.publicOrigin && normalizeOrigin(origin) === policy.cors.publicOrigin) {
        return true;
    }
    if (policy.cors.allowedOrigins.includes("*") || policy.cors.allowedOrigins.includes(origin)) {
        return true;
    }
    if (!policy.cors.publicOrigin && policy.cors.sameOrigin && isSameOriginRequest(request, origin)) {
        return true;
    }
    return policy.cors.allowedOriginPatterns.length > 0 && isLocalDevOrigin(origin);
}
function websocketOriginAllowed(policy, request) {
    if (!request.headers.origin) {
        return !policy.cors.publicOrigin;
    }
    return requestOriginAllowed(policy, request);
}
function isSameOriginRequest(request, origin) {
    const host = request.headers["x-forwarded-host"] ?? request.headers.host;
    if (!host) {
        return false;
    }
    const protocol = request.headers["x-forwarded-proto"] ?? (request.socket?.encrypted ? "https" : "http");
    return origin === `${protocol}://${host}`;
}
function normalizeOrigin(value) {
    if (typeof value !== "string" || value.trim() === "") {
        return null;
    }
    try {
        return new URL(value).origin;
    }
    catch {
        return null;
    }
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
    return parts.includes(value.toLowerCase()) ? String(existing) : `${existing}, ${value}`;
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
    const schedulePayloadFactoryTimeoutMs = resolveSchedulePayloadFactoryTimeoutMs(config);
    // Handler sources extracted from Capsule server code are re-created with
    // `new Function`, which only sees globals. Install the sporades/server
    // requireAuth helper there so those handlers resolve the same auth gate.
    globalThis.requireAuth = requireAuth;
    const sqlite = await createRuntimeDatabaseAdapter(databasePath, options?.serviceEnv ?? serverEnv, config);
    const serviceEnv = options?.serviceEnv ?? serverEnv;
    const fileStorage = await createRuntimeFileStorageAdapter({
        config,
        databasePath,
        serviceEnv,
    });
    const schema = capsuleDefinition ? schemaFromCapsuleDefinition(capsuleDefinition) : extractSchema(serverSource);
    const endpoints = extractEndpoints(serverSource);
    const queries = extractQueryHandlersFromCapsule(capsuleDefinition) ?? extractQueryHandlers(serverSource);
    const mutations = (capsuleDefinition
        ? mutationHandlersFromCapsuleDefinition(serverSource, capsuleDefinition)
        : extractMutationHandlers(serverSource));
    const messages = extractMessageHandlers(serverSource);
    const jobs = jobHandlersFromCapsuleDefinition(capsuleDefinition);
    const schedules = scheduleDefinitionsFromCapsule(capsuleDefinition, jobs);
    const clock = createRuntimeClock(options?.clock);
    const contextMiddleware = extractContextMiddleware(serverSource);
    const mutationHooks = extractMutationHooks(serverSource);
    const lifecycleHooks = { init: capsuleDefinition?.hooks?.init, shutdown: capsuleDefinition?.hooks?.shutdown };
    const rowCache = new Map();
    const database = {
        adapter: sqlite,
        sqlite,
        schema,
        endpoints,
        queries,
        mutations,
        messages,
        jobs,
        schedules,
        clock,
        capsuleIdentity: String(config.name ?? "capsule"),
        scheduleOccurrenceFault: options?.scheduleOccurrenceFault,
        schedulePayloadFactoryTimeoutMs,
        schedulePayloadFactoryActive: 0,
        schedulePayloadFactoryWaiters: [],
        schedulePayloadFactoryLanes: new Map(),
        schedulePayloadFactoryControllers: new Map(),
        contextMiddleware,
        mutationHooks,
        lifecycleHooks,
        jobScheduleProvenanceByContext: new WeakMap(),
        rowCache,
        serverEnv,
        authConfig: authStatus(config, serverEnv),
        securityPolicy: resolveRuntimeSecurityPolicy(config),
        fileStorage,
        fileMaxSizeBytes: config.files?.maxSizeBytes ?? 10 * 1024 * 1024,
        httpMaxBodyBytes: resolveHttpMaxBodyBytes(config),
        close: () => {
            database.__scheduleStopped = true;
            abortSchedulePayloadFactories(database);
            for (const timer of database.__scheduleTimers ?? [])
                database.clock.clearTimer(timer);
            database.__scheduleTimers?.clear?.();
            if (database.__jobWakeTimer) {
                database.clock.clearTimer(database.__jobWakeTimer);
                database.__jobWakeTimer = null;
            }
            const sqliteResult = database.sqlite.close();
            const storageResult = database.fileStorage.close();
            return storageResult ?? sqliteResult;
        },
    };
    database.init = async () => {
        if (database.__runtimeInitialized)
            return;
        if (database.lifecycleHooks.init !== undefined) {
            if (typeof database.lifecycleHooks.init !== "function")
                throw commandError("Invalid Capsule init hook.", "Declare hooks.init as a function.");
            await database.lifecycleHooks.init(createMutationContext(database, { userId: "__lifecycle__", displayName: "Capsule lifecycle", email: null, picture: null, isAuthenticated: false, isGuest: false, provider: "lifecycle" }));
        }
        database.__scheduleStopped = false;
        database.__scheduleTimers = new Set();
        database.__activeScheduleOccurrences = new Set();
        database.__scheduleRecoveryTimer = null;
        database.__scheduleRecoveryDueAt = null;
        await reconcileSchedules(database);
        await startStaticSchedules(database);
        database.__runtimeInitialized = true;
    };
    database.shutdown = async () => {
        database.__scheduleStopped = true;
        abortSchedulePayloadFactories(database);
        for (const timer of database.__scheduleTimers ?? [])
            database.clock.clearTimer(timer);
        database.__scheduleTimers?.clear?.();
        database.__scheduleRecoveryTimer = null;
        database.__scheduleRecoveryDueAt = null;
        await Promise.allSettled([...(database.__activeScheduleOccurrences ?? [])]);
        if (database.__runtimeInitialized && database.lifecycleHooks.shutdown !== undefined) {
            if (typeof database.lifecycleHooks.shutdown !== "function")
                throw commandError("Invalid Capsule shutdown hook.", "Declare hooks.shutdown as a function.");
            await database.lifecycleHooks.shutdown(createMutationContext(database, { userId: "__lifecycle__", displayName: "Capsule lifecycle", email: null, picture: null, isAuthenticated: false, isGuest: false, provider: "lifecycle" }));
        }
        database.__runtimeInitialized = false;
    };
    database.log = createRuntimeLogSink({
        database: sqlite,
        config,
        serverEnv,
        dataDir: path.dirname(databasePath),
    });
    database.audit = createPrivilegedAuditEmitter(database.log);
    await sqlite.ensureSystemTable();
    await sqlite.ensureAuthStorage(database.authConfig);
    await sqlite.ensureUserPreferencesStorage();
    await ensureJobStorage(sqlite);
    await ensureScheduleStorage(sqlite);
    await sqlite.ensureFileStorage();
    await sqlite.ensureLogStorage();
    await recoverExpiredJobLeases(database);
    assertValidReferenceTargets(schema);
    await sqlite.migrateAppSchema(schema);
    return database;
}
function scheduleDefinitionsFromCapsule(capsuleDefinition, jobs) {
    const schedules = [];
    for (const [name, definition] of Object.entries(capsuleDefinition?.schedules ?? {})) {
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name))
            throw commandError(`Invalid Schedule name: ${name}`, "Begin Schedule names with a letter and use only letters, numbers, underscores, or hyphens.");
        if (!definition || definition.kind !== "schedule" || Object.keys(definition).some((key) => !["kind", "expression", "timezone", "job", "payload", "retry", "missedRun", "enabled"].includes(key)))
            throw commandError(`Invalid Schedule declaration: ${name}`, "Declare each Schedule with schedule({ expression, timezone?, job, payload?, retry?, missedRun?, enabled? }).");
        if (schedules.some((candidate) => candidate.name === name))
            throw commandError(`Duplicate Schedule declaration: ${name}`, "Use one unique Schedule name per Capsule.");
        if (typeof definition.job !== "string" || !jobs.some((candidate) => candidate.name === definition.job))
            throw commandError(`Unknown Job handler for Schedule: ${name}`, "Reference a Job declared in the Capsule jobs map.");
        const expression = parseScheduleExpression(definition.expression);
        const effectiveTimezone = resolveScheduleTimezone(definition.timezone);
        const payload = definition.payload === undefined ? null : definition.payload;
        if (typeof payload !== "function")
            boundedJobJson(payload, 64 * 1024, "JOB_PAYLOAD_TOO_LARGE", "Schedule payload");
        const retry = normalizeJobRetry(definition.retry);
        const missedRun = definition.missedRun ?? "skip";
        if (missedRun !== "skip" && missedRun !== "latest")
            throw commandError(`Invalid missed-run policy for Schedule: ${name}`, "Use `skip` or `latest`.");
        if (definition.enabled !== undefined && typeof definition.enabled !== "boolean")
            throw commandError(`Invalid enabled value for Schedule: ${name}`, "Pass true or false for enabled.");
        const normalizedExpression = definition.expression.trim().replace(/\s+/g, " ");
        const enabled = definition.enabled ?? true;
        const fingerprint = JSON.stringify({ expression: normalizedExpression, timezone: effectiveTimezone, job: definition.job, payload: typeof payload === "function" ? String(payload) : payload, retry, missedRun });
        schedules.push({ name, expression: normalizedExpression, fields: expression, effectiveTimezone, job: definition.job, payload, retry, missedRun, enabled, fingerprint });
    }
    return schedules;
}
function resolveSchedulePayloadFactoryTimeoutMs(config = {}) {
    const scheduling = config.scheduling;
    if (scheduling === undefined)
        return 30_000;
    if (!scheduling || typeof scheduling !== "object" || Array.isArray(scheduling) || Object.keys(scheduling).some((key) => key !== "payloadFactoryTimeoutSeconds")) {
        throw commandError("Invalid scheduling configuration.", "Set `scheduling.payloadFactoryTimeoutSeconds` to an integer from 1 through 300.");
    }
    const seconds = scheduling.payloadFactoryTimeoutSeconds ?? 30;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
        throw commandError("Invalid Schedule payload factory timeout.", "Set `scheduling.payloadFactoryTimeoutSeconds` to an integer from 1 through 300.");
    }
    return seconds * 1000;
}
function parseScheduleExpression(value) {
    if (typeof value !== "string")
        throw commandError("Invalid Schedule expression.", "Pass a numeric five-field cron expression.");
    const parts = value.trim().split(/\s+/);
    if (parts.length !== 5)
        throw commandError(`Unsupported Schedule expression: ${value}`, "Use exactly five numeric cron fields; seconds, years, and nicknames are unsupported.");
    const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
    const fields = parts.map((part, index) => {
        const values = new Set();
        for (const item of part.split(",")) {
            const [base, stepText] = item.split("/");
            if (item.split("/").length > 2 || (stepText !== undefined && (!/^\d+$/.test(stepText) || Number(stepText) < 1)))
                throw commandError(`Unsupported Schedule expression: ${value}`, "Use numeric cron fields with lists, ranges, and positive steps.");
            const step = stepText === undefined ? 1 : Number(stepText);
            let start, end;
            if (base === "*")
                [start, end] = ranges[index];
            else if (/^\d+$/.test(base))
                start = end = Number(base);
            else {
                const match = /^(\d+)-(\d+)$/.exec(base);
                if (!match)
                    throw commandError(`Unsupported Schedule expression: ${value}`, "Use numeric cron fields with lists, ranges, and steps.");
                start = Number(match[1]);
                end = Number(match[2]);
            }
            if (start < ranges[index][0] || end > ranges[index][1] || start > end)
                throw commandError(`Invalid Schedule expression: ${value}`, "Keep each cron value inside its field range.");
            for (let current = start; current <= end; current += step)
                values.add(index === 4 && current === 7 ? 0 : current);
        }
        return values;
    });
    fields.restricted = parts.map((part) => part !== "*");
    return fields;
}
function resolveScheduleTimezone(value) {
    if (value !== undefined && (typeof value !== "string" || value.trim() === ""))
        throw commandError("Invalid Schedule timezone.", "Pass an available IANA timezone name.");
    const requested = value === undefined ? Intl.DateTimeFormat().resolvedOptions().timeZone : value.trim();
    try {
        return new Intl.DateTimeFormat("en-US", { timeZone: requested }).resolvedOptions().timeZone;
    }
    catch {
        throw commandError(`Invalid Schedule timezone: ${String(requested)}`, "Pass an available IANA timezone name from the runtime timezone database.");
    }
}
const scheduleWeekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function scheduleWallClockParts(formatter, instant) {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
    return { minute: Number(parts.minute), hour: Number(parts.hour), day: Number(parts.day), month: Number(parts.month), weekday: scheduleWeekdays[parts.weekday] };
}
function nextScheduleOccurrence(fields, after, timezone) {
    const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
        timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    const candidate = new Date(after.getTime());
    candidate.setUTCSeconds(0, 0);
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
    // Eight years covers the longest gap between valid annual Gregorian dates:
    // leap day immediately before a non-leap century (for example 2096 to 2104).
    for (let count = 0; count < 8 * 366 * 24 * 60; count++, candidate.setUTCMinutes(candidate.getUTCMinutes() + 1)) {
        const local = scheduleWallClockParts(formatter, candidate);
        const dom = fields[2].has(local.day);
        const dow = fields[4].has(local.weekday);
        const domRestricted = fields.restricted?.[2] ?? fields[2].size !== 31;
        const dowRestricted = fields.restricted?.[4] ?? fields[4].size !== 7;
        const dayMatches = domRestricted && dowRestricted ? dom || dow : dom && dow;
        if (fields[0].has(local.minute) && fields[1].has(local.hour) && dayMatches && fields[3].has(local.month))
            return new Date(candidate);
    }
    throw commandError("Schedule has no future occurrence.", "Check the Schedule cron expression.");
}
async function ensureScheduleStorage(sqlite) {
    await sqlite.exec("CREATE TABLE IF NOT EXISTS sporades_schedules (name TEXT PRIMARY KEY, definitionFingerprint TEXT NOT NULL, expression TEXT NOT NULL, effectiveTimezone TEXT NOT NULL, missedRunPolicy TEXT NOT NULL, enabled INTEGER NOT NULL, nextOccurrence TEXT, latestScheduledFor TEXT, latestOutcome TEXT, latestJobId TEXT, latestErrorCode TEXT)");
    await sqlite.exec("CREATE TABLE IF NOT EXISTS sporades_schedule_occurrences (id TEXT PRIMARY KEY, scheduleName TEXT NOT NULL, scheduledFor TEXT NOT NULL, status TEXT NOT NULL, claimToken TEXT, claimExpiresAt TEXT, jobId TEXT, errorCode TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)");
    await sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS sporades_schedule_occurrence_identity ON sporades_schedule_occurrences(scheduleName, scheduledFor)");
}
async function reconcileSchedules(database) {
    const now = database.clock.now();
    const declaredNames = new Set(database.schedules.map((definition) => definition.name));
    const persisted = await database.sqlite.prepare("SELECT * FROM sporades_schedules").all();
    const plans = [];
    for (const definition of database.schedules) {
        const row = persisted.find((candidate) => candidate.name === definition.name);
        const changed = !row || row.definitionFingerprint !== definition.fingerprint || Boolean(row.enabled) !== definition.enabled;
        let nextOccurrence = null;
        let recoveredOccurrence = null;
        if (definition.enabled) {
            if (changed || !row?.nextOccurrence) {
                nextOccurrence = nextScheduleOccurrence(definition.fields, now, definition.effectiveTimezone).toISOString();
            }
            else {
                nextOccurrence = String(row.nextOccurrence);
                if (Date.parse(nextOccurrence) <= now.getTime()) {
                    let latest = new Date(nextOccurrence);
                    let future = nextScheduleOccurrence(definition.fields, latest, definition.effectiveTimezone);
                    while (future.getTime() <= now.getTime()) {
                        latest = future;
                        future = nextScheduleOccurrence(definition.fields, latest, definition.effectiveTimezone);
                    }
                    nextOccurrence = future.toISOString();
                    if (definition.missedRun === "latest")
                        recoveredOccurrence = latest;
                }
            }
        }
        plans.push({ definition, row, nextOccurrence, recoveredOccurrence });
    }
    // Every declaration, including calendars with no possible future instant,
    // has now been evaluated without mutating durable state.
    for (const row of persisted) {
        if (!declaredNames.has(String(row.name)))
            await database.sqlite.prepare("DELETE FROM sporades_schedules WHERE name=?").run(row.name);
    }
    for (const { definition, row, nextOccurrence } of plans) {
        if (row)
            await database.sqlite.prepare("UPDATE sporades_schedules SET definitionFingerprint=?, expression=?, effectiveTimezone=?, missedRunPolicy=?, enabled=?, nextOccurrence=? WHERE name=?").run(definition.fingerprint, definition.expression, definition.effectiveTimezone, definition.missedRun, definition.enabled ? 1 : 0, nextOccurrence, definition.name);
        else {
            try {
                await database.sqlite.prepare("INSERT INTO sporades_schedules (name, definitionFingerprint, expression, effectiveTimezone, missedRunPolicy, enabled, nextOccurrence) VALUES (?, ?, ?, ?, ?, ?, ?)").run(definition.name, definition.fingerprint, definition.expression, definition.effectiveTimezone, definition.missedRun, definition.enabled ? 1 : 0, nextOccurrence);
            }
            catch (error) {
                const concurrent = await database.sqlite.prepare("SELECT name FROM sporades_schedules WHERE name=?").get(definition.name);
                if (!concurrent)
                    throw error;
                await database.sqlite.prepare("UPDATE sporades_schedules SET definitionFingerprint=?, expression=?, effectiveTimezone=?, missedRunPolicy=?, enabled=?, nextOccurrence=? WHERE name=?").run(definition.fingerprint, definition.expression, definition.effectiveTimezone, definition.missedRun, definition.enabled ? 1 : 0, nextOccurrence, definition.name);
            }
        }
        definition.nextOccurrence = nextOccurrence;
    }
    for (const { definition, recoveredOccurrence } of plans) {
        if (recoveredOccurrence)
            await recordScheduledOccurrence(database, definition, recoveredOccurrence);
    }
    await recoverPendingScheduleOccurrences(database);
}
async function startStaticSchedules(database) {
    database.__scheduleTimers ??= new Set();
    database.__activeScheduleOccurrences ??= new Set();
    for (const definition of database.schedules) {
        if (!definition.enabled)
            continue;
        const arm = () => {
            if (database.__scheduleStopped)
                return;
            const occurrence = new Date(definition.nextOccurrence);
            const timer = database.clock.setTimer(() => {
                database.__scheduleTimers.delete(timer);
                const active = recordScheduledOccurrence(database, definition, occurrence).catch(async (error) => {
                    database.log.emit({ category: "platform", event: "schedule.occurrence.enqueue_failed", level: "error", message: "Scheduled occurrence could not enqueue its Job", data: { scheduleName: definition.name, scheduledFor: occurrence.toISOString(), code: String(error?.code ?? "SCHEDULE_ENQUEUE_FAILED").slice(0, 80) } });
                    if (!database.__scheduleStopped)
                        await finishFailedScheduledOccurrence(database, definition, occurrence, error);
                }).finally(() => {
                    database.__activeScheduleOccurrences.delete(active);
                    if (database.__scheduleStopped)
                        return;
                    arm();
                });
                database.__activeScheduleOccurrences.add(active);
                return active;
            }, Math.max(0, occurrence.getTime() - database.clock.now().getTime()));
            database.__scheduleTimers.add(timer);
        };
        arm();
    }
}
async function finishFailedScheduledOccurrence(database, definition, occurrence, error) {
    const scheduledFor = occurrence.toISOString();
    const id = scheduledOccurrenceIdentity(database, definition.name, scheduledFor);
    const completedAt = database.clock.now().toISOString();
    const code = "SCHEDULE_ENQUEUE_FAILED";
    await database.sqlite.prepare("UPDATE sporades_schedule_occurrences SET status='enqueue-failed', claimToken=NULL, claimExpiresAt=NULL, errorCode=?, updatedAt=? WHERE id=? AND status='pending'").run(code, completedAt, id);
    const next = nextScheduleOccurrence(definition.fields, occurrence, definition.effectiveTimezone).toISOString();
    definition.nextOccurrence = next;
    await database.sqlite.prepare("UPDATE sporades_schedules SET nextOccurrence=?, latestScheduledFor=?, latestOutcome='payload-failed', latestJobId=NULL, latestErrorCode=? WHERE name=? AND enabled=1").run(next, scheduledFor, code, definition.name);
}
async function recordScheduledOccurrence(database, definition, occurrence) {
    const claim = await claimScheduledOccurrence(database, definition, occurrence);
    if (!claim) {
        // Another runtime owns this exact occurrence. Advance only this runtime's
        // timer cursor; the winner owns durable Schedule bookkeeping.
        definition.nextOccurrence = nextScheduleOccurrence(definition.fields, occurrence, definition.effectiveTimezone).toISOString();
        return null;
    }
    await database.scheduleOccurrenceFault?.("after-pending", { scheduleName: definition.name, scheduledFor: occurrence.toISOString() });
    const state = await enqueueScheduledOccurrence(database, definition, occurrence);
    if (state)
        await database.scheduleOccurrenceFault?.("after-enqueue", { scheduleName: definition.name, scheduledFor: occurrence.toISOString(), jobId: state.id });
    const completedAt = database.clock.now().toISOString();
    await database.sqlite.prepare("UPDATE sporades_schedule_occurrences SET status=?, claimToken=NULL, claimExpiresAt=NULL, jobId=?, errorCode=?, updatedAt=? WHERE id=? AND claimToken=?").run(state ? "enqueued" : "payload-failed", state?.id ?? null, state ? null : "SCHEDULE_PAYLOAD_FAILED", completedAt, claim.id, claim.token);
    if (database.__scheduleStopped)
        return state;
    const next = nextScheduleOccurrence(definition.fields, occurrence, definition.effectiveTimezone).toISOString();
    definition.nextOccurrence = next;
    await database.sqlite.prepare("UPDATE sporades_schedules SET nextOccurrence=?, latestScheduledFor=?, latestOutcome=?, latestJobId=?, latestErrorCode=? WHERE name=? AND enabled=1").run(next, occurrence.toISOString(), state ? "enqueued" : "payload-failed", state?.id ?? null, state ? null : "SCHEDULE_PAYLOAD_FAILED", definition.name);
    return state;
}
function scheduledOccurrenceIdentity(database, scheduleName, scheduledFor) {
    return createHash("sha256").update(JSON.stringify([database.capsuleIdentity, scheduleName, scheduledFor])).digest("hex");
}
async function claimScheduledOccurrence(database, definition, occurrence) {
    const scheduledFor = occurrence.toISOString();
    const id = scheduledOccurrenceIdentity(database, definition.name, scheduledFor);
    const token = randomUUID();
    const now = database.clock.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + 30_000).toISOString();
    try {
        await database.sqlite.prepare("INSERT INTO sporades_schedule_occurrences (id, scheduleName, scheduledFor, status, claimToken, claimExpiresAt, createdAt, updatedAt) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)").run(id, definition.name, scheduledFor, token, expiresAt, nowIso, nowIso);
        return { id, token };
    }
    catch (error) {
        const existing = await database.sqlite.prepare("SELECT status, claimExpiresAt FROM sporades_schedule_occurrences WHERE id=?").get(id);
        if (!existing)
            throw error;
        if (existing.status !== "pending")
            return null;
        if (existing.claimExpiresAt && existing.claimExpiresAt > nowIso) {
            schedulePendingOccurrenceRecovery(database, existing.claimExpiresAt);
            return null;
        }
        const result = await database.sqlite.prepare("UPDATE sporades_schedule_occurrences SET claimToken=?, claimExpiresAt=?, updatedAt=? WHERE id=? AND status='pending' AND (claimExpiresAt IS NULL OR claimExpiresAt <= ?)").run(token, expiresAt, nowIso, id, nowIso);
        return Number(result.changes) === 1 ? { id, token } : null;
    }
}
async function recoverPendingScheduleOccurrences(database) {
    const rows = await database.sqlite.prepare("SELECT scheduleName, scheduledFor FROM sporades_schedule_occurrences WHERE status='pending' AND (claimExpiresAt IS NULL OR claimExpiresAt <= ?) ORDER BY scheduledFor ASC, scheduleName ASC").all(database.clock.now().toISOString());
    for (const row of rows) {
        const definition = database.schedules.find((candidate) => candidate.enabled && candidate.name === row.scheduleName);
        if (definition)
            await recordScheduledOccurrence(database, definition, new Date(row.scheduledFor));
    }
    const next = await database.sqlite.prepare("SELECT claimExpiresAt FROM sporades_schedule_occurrences WHERE status='pending' AND claimExpiresAt IS NOT NULL ORDER BY claimExpiresAt ASC LIMIT 1").get();
    if (next?.claimExpiresAt)
        schedulePendingOccurrenceRecovery(database, String(next.claimExpiresAt));
}
function schedulePendingOccurrenceRecovery(database, claimExpiresAt) {
    if (database.__scheduleStopped)
        return;
    const dueAt = Date.parse(claimExpiresAt);
    if (!Number.isFinite(dueAt))
        return;
    if (database.__scheduleRecoveryTimer && database.__scheduleRecoveryDueAt <= dueAt)
        return;
    if (database.__scheduleRecoveryTimer) {
        database.clock.clearTimer(database.__scheduleRecoveryTimer);
        database.__scheduleTimers?.delete(database.__scheduleRecoveryTimer);
    }
    database.__scheduleRecoveryDueAt = dueAt;
    const timer = database.clock.setTimer(() => {
        database.__scheduleTimers?.delete(timer);
        database.__scheduleRecoveryTimer = null;
        database.__scheduleRecoveryDueAt = null;
        if (database.__scheduleStopped)
            return;
        const active = recoverPendingScheduleOccurrences(database).catch((error) => {
            database.log.emit({ category: "platform", event: "schedule.occurrence.recovery_failed", level: "error", message: "Pending Scheduled occurrence recovery failed", data: { code: String(error?.code ?? "SCHEDULE_RECOVERY_FAILED").slice(0, 80) } });
        }).finally(() => database.__activeScheduleOccurrences?.delete(active));
        database.__activeScheduleOccurrences?.add(active);
        return active;
    }, Math.max(0, dueAt - database.clock.now().getTime()));
    database.__scheduleRecoveryTimer = timer;
    database.__scheduleTimers?.add(timer);
}
export async function enqueueScheduledOccurrence(database, definition, occurrence) {
    const scheduledFor = occurrence.toISOString();
    const provenance = `schedule:${scheduledOccurrenceIdentity(database, definition.name, scheduledFor)}`;
    const context = createMutationContext(database, { userId: provenance, displayName: "Schedule", email: null, picture: null, isAuthenticated: false, isGuest: false, provider: "schedule" });
    const payload = await resolveSchedulePayload(database, definition, scheduledFor, context);
    if (!payload.ok)
        return null;
    database.jobScheduleProvenanceByContext.set(context, { scheduleName: definition.name, scheduledFor });
    const state = await context.privileged.run({ operation: "schedules.enqueue", targetResourceKind: "job-queue", metadata: { scheduleName: definition.name, scheduledFor } }, (privilegedContext) => privilegedContext.jobs.enqueue(definition.job, payload.value, { retry: definition.retry, idempotencyKey: provenance }));
    return state;
}
async function acquireSchedulePayloadFactorySlot(database) {
    if (database.schedulePayloadFactoryActive >= 4)
        await new Promise((resolve) => database.schedulePayloadFactoryWaiters.push(resolve));
    database.schedulePayloadFactoryActive += 1;
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        database.schedulePayloadFactoryActive -= 1;
        database.schedulePayloadFactoryWaiters.shift()?.();
    };
}
async function acquireSchedulePayloadFactoryLane(database, scheduleName) {
    const previous = database.schedulePayloadFactoryLanes.get(scheduleName);
    let unlock = () => { };
    const current = new Promise((resolve) => { unlock = resolve; });
    database.schedulePayloadFactoryLanes.set(scheduleName, current);
    if (previous)
        await previous;
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        unlock();
        if (database.schedulePayloadFactoryLanes.get(scheduleName) === current)
            database.schedulePayloadFactoryLanes.delete(scheduleName);
    };
}
async function resolveSchedulePayload(database, definition, scheduledFor, context) {
    if (typeof definition.payload !== "function")
        return { ok: true, value: definition.payload };
    const releaseLane = await acquireSchedulePayloadFactoryLane(database, definition.name);
    let releaseSlot;
    const controller = new AbortController();
    const controllers = database.schedulePayloadFactoryControllers.get(definition.name) ?? new Set();
    controllers.add(controller);
    database.schedulePayloadFactoryControllers.set(definition.name, controllers);
    const occurrence = Object.freeze({ scheduleName: definition.name, scheduledFor });
    const factoryContext = Object.freeze({ signal: controller.signal, privileged: context.privileged });
    let timeout;
    try {
        releaseSlot = await acquireSchedulePayloadFactorySlot(database);
        const timeoutFailure = new Promise((_resolve, reject) => {
            timeout = database.clock.setTimer(() => {
                controller.abort();
                const error = new Error("Schedule payload factory timed out.");
                error.code = "SCHEDULE_PAYLOAD_FACTORY_TIMEOUT";
                reject(error);
            }, database.schedulePayloadFactoryTimeoutMs);
        });
        const aborted = new Promise((_resolve, reject) => controller.signal.addEventListener("abort", () => {
            const error = new Error("Schedule payload factory aborted.");
            error.code = "SCHEDULE_PAYLOAD_FACTORY_ABORTED";
            reject(error);
        }, { once: true }));
        const value = await Promise.race([Promise.resolve().then(() => definition.payload(occurrence, factoryContext)), timeoutFailure, aborted]);
        database.clock.clearTimer(timeout);
        boundedJobJson(value, 64 * 1024, "JOB_PAYLOAD_TOO_LARGE", "Schedule payload");
        return { ok: true, value };
    }
    catch (error) {
        database.clock.clearTimer(timeout);
        const code = error?.code === "SCHEDULE_PAYLOAD_FACTORY_TIMEOUT" ? error.code
            : error?.code === "INVALID_JOB_PAYLOAD" || error?.code === "JOB_PAYLOAD_TOO_LARGE" ? `SCHEDULE_PAYLOAD_${error.code}`
                : "SCHEDULE_PAYLOAD_FACTORY_FAILED";
        await database.log.emit({ category: "platform", event: "schedule.occurrence.payload_failed", level: "error", message: "Scheduled occurrence payload creation failed", data: { scheduleName: definition.name, scheduledFor, code } });
        return { ok: false };
    }
    finally {
        controllers.delete(controller);
        if (controllers.size === 0)
            database.schedulePayloadFactoryControllers.delete(definition.name);
        releaseSlot?.();
        releaseLane();
    }
}
function abortSchedulePayloadFactories(database) {
    for (const controllers of database.schedulePayloadFactoryControllers?.values?.() ?? [])
        for (const controller of controllers)
            controller.abort();
}
async function recoverExpiredJobLeases(database) {
    const recoveredAt = database.clock.now();
    const recoveredIso = recoveredAt.toISOString();
    const rows = await database.sqlite.prepare("SELECT * FROM sporades_jobs WHERE status='running' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt <= ? ORDER BY availableAt ASC, id ASC").all(recoveredIso);
    for (const row of rows) {
        const retry = JSON.parse(row.retryJson || '{"maxAttempts":1,"delayMs":0}');
        const history = JSON.parse(row.attemptHistory || "[]");
        history.push({ attempt: Number(row.attempts), outcome: "interrupted", code: "JOB_LEASE_EXPIRED", completedAt: recoveredIso });
        if (Number(row.attempts) < retry.maxAttempts) {
            const availableAt = new Date(recoveredAt.getTime() + retry.delayMs).toISOString();
            await database.sqlite.prepare("UPDATE sporades_jobs SET status='delayed', availableAt=?, leaseExpiresAt=NULL, attemptHistory=? WHERE id=?").run(availableAt, JSON.stringify(history), row.id);
            database.clock.setTimer(() => scheduleCurrentUserJobWorker(database), retry.delayMs + 1);
        }
        else
            await database.sqlite.prepare("UPDATE sporades_jobs SET status='failed', failure=?, failedAt=?, leaseExpiresAt=NULL, attemptHistory=? WHERE id=?").run(JSON.stringify({ code: "JOB_LEASE_EXPIRED", message: "Job lease expired." }), recoveredIso, JSON.stringify(history), row.id);
    }
    if (rows.some((row) => Number(row.attempts) < JSON.parse(row.retryJson || '{"maxAttempts":1}').maxAttempts))
        scheduleCurrentUserJobWorker(database);
}
function createRuntimeClock(clock) {
    if (clock)
        return clock;
    return {
        now: () => new Date(),
        setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: (timer) => clearTimeout(timer),
    };
}
/** Internal full-runtime test support; not exported from sporades/server or sporades/client. */
export function createControllableRuntimeClock(initialInstant) {
    let nowMs = new Date(initialInstant).getTime();
    if (!Number.isFinite(nowMs))
        throw new TypeError("Invalid initial runtime clock instant.");
    let nextId = 1;
    const timers = new Map();
    return {
        now: () => new Date(nowMs),
        setInstant(instant) {
            const next = new Date(instant).getTime();
            if (!Number.isFinite(next))
                throw new TypeError("Invalid runtime clock instant.");
            nowMs = next;
        },
        advanceBy(delayMs) {
            if (!Number.isFinite(delayMs) || delayMs < 0)
                throw new TypeError("Runtime clock advance must be non-negative.");
            nowMs += delayMs;
        },
        setTimer(callback, delayMs) {
            const id = nextId++;
            timers.set(id, { id, dueAt: nowMs + Math.max(0, delayMs), callback });
            return id;
        },
        clearTimer(id) { timers.delete(id); },
        async runDueTimers() {
            while (true) {
                const due = [...timers.values()].filter((timer) => timer.dueAt <= nowMs)
                    .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
                if (!due)
                    return;
                timers.delete(due.id);
                await due.callback();
            }
        },
    };
}
function jobHandlersFromCapsuleDefinition(capsuleDefinition) {
    const handlers = [];
    for (const [name, definition] of Object.entries(capsuleDefinition?.jobs ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) || definition?.kind !== "job" || typeof definition.handler !== "function") {
            throw commandError("Invalid Job handler.", "Declare jobs as named job(...) handlers using letters, numbers, underscores, or hyphens.");
        }
        if (handlers.some((handler) => handler.name === name)) {
            throw commandError(`Duplicate Job handler: ${name}`, "Use one unique Job handler name per Capsule.");
        }
        handlers.push({ name, handler: definition.handler });
    }
    return handlers;
}
async function ensureJobStorage(sqlite) {
    await sqlite.exec("CREATE TABLE IF NOT EXISTS sporades_jobs (" +
        "id TEXT PRIMARY KEY, handler TEXT NOT NULL, enqueuedByUserId TEXT NOT NULL, actorUserId TEXT NOT NULL, " +
        "payload TEXT NOT NULL, status TEXT NOT NULL, availableAt TEXT NOT NULL, attempts INTEGER NOT NULL, " +
        "idempotencyKey TEXT, result TEXT, failure TEXT, createdAt TEXT NOT NULL, startedAt TEXT, completedAt TEXT, failedAt TEXT)");
    await sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS sporades_jobs_idempotency ON sporades_jobs(handler, actorUserId, idempotencyKey) WHERE idempotencyKey IS NOT NULL");
    await sqlite.exec("CREATE INDEX IF NOT EXISTS sporades_jobs_runnable ON sporades_jobs(status, availableAt, id)");
    const columns = await sqlite.prepare("PRAGMA table_info(sporades_jobs)").all();
    for (const [name, type] of [["retryJson", "TEXT"], ["attemptHistory", "TEXT"], ["cancelRequestedAt", "TEXT"], ["leaseExpiresAt", "TEXT"], ["scheduleName", "TEXT"], ["scheduledFor", "TEXT"]])
        if (!columns.some((column) => column.name === name))
            await sqlite.exec(`ALTER TABLE sporades_jobs ADD COLUMN ${name} ${type}`);
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
    if (config.services?.database?.engine === "postgres" &&
        serverEnv.SPORADES_SERVICE_DATABASE_ENGINE === "postgres" &&
        serverEnv.SPORADES_SERVICE_DATABASE_URL) {
        return await createPostgresDatabaseAdapter({
            url: serverEnv.SPORADES_SERVICE_DATABASE_URL,
        });
    }
    return await createSqliteDatabaseAdapter(databasePath);
}
export async function createRuntimeInspectionAdapter(databasePath, serverEnv = {}, config = {}) {
    if (config.services?.database?.engine === "libsql" && serverEnv.SPORADES_SERVICE_DATABASE_ENGINE === "libsql" && serverEnv.SPORADES_SERVICE_DATABASE_URL) {
        return await createLibsqlDatabaseAdapter({ url: serverEnv.SPORADES_SERVICE_DATABASE_URL, authToken: serverEnv.SPORADES_SERVICE_DATABASE_AUTH_TOKEN });
    }
    if (config.services?.database?.engine === "postgres" && serverEnv.SPORADES_SERVICE_DATABASE_ENGINE === "postgres" && serverEnv.SPORADES_SERVICE_DATABASE_URL) {
        return await createPostgresDatabaseAdapter({ url: serverEnv.SPORADES_SERVICE_DATABASE_URL });
    }
    if (!existsSync(String(databasePath)))
        return null;
    return await createSqliteDatabaseAdapter(databasePath, { readOnly: true });
}
export async function createRuntimeFileStorageAdapter({ config = {}, databasePath, serviceEnv = {} }) {
    const path = await import("node:path");
    if (config.services?.storage?.engine === "minio" && serviceEnv.SPORADES_SERVICE_STORAGE_ENGINE === "minio") {
        return createS3CompatibleFileStorageAdapter({
            endpoint: serviceEnv.SPORADES_SERVICE_STORAGE_ENDPOINT ?? "",
            bucket: serviceEnv.SPORADES_SERVICE_STORAGE_BUCKET ?? "sporades",
            region: serviceEnv.SPORADES_SERVICE_STORAGE_REGION ?? "us-east-1",
            accessKey: serviceEnv.SPORADES_SERVICE_STORAGE_ACCESS_KEY ?? "",
            secretKey: serviceEnv.SPORADES_SERVICE_STORAGE_SECRET_KEY ?? "",
            namespace: serviceEnv.SPORADES_SERVICE_STORAGE_NAMESPACE ?? "capsule",
        });
    }
    return createLocalFileStorageAdapter({
        storagePath: config.files?.storagePath ?? path.join(path.dirname(databasePath), "files"),
    });
}
export function createLocalFileStorageAdapter({ storagePath }) {
    if (typeof storagePath !== "string" || storagePath.length === 0) {
        throw new Error("Local file storage requires a storagePath.");
    }
    return {
        engine: "local",
        storagePath,
        async writeFileVersion({ fileId, version, bytes }) {
            const { mkdir, writeFile } = await import("node:fs/promises");
            await mkdir(localFileStoragePath(storagePath, fileId), { recursive: true });
            await writeFile(localFileVersionPath(storagePath, fileId, version), bytes);
        },
        async readFileVersion({ fileId, version }) {
            const { readFile } = await import("node:fs/promises");
            return await readFile(localFileVersionPath(storagePath, fileId, version));
        },
        async deleteFileVersion({ fileId, version }) {
            const { rm } = await import("node:fs/promises");
            await rm(localFileVersionPath(storagePath, fileId, version), { force: true });
        },
        async checkHealth() {
            const { mkdir, rm, writeFile } = await import("node:fs/promises");
            const path = await import("node:path");
            const probeDirectory = path.join(storagePath, ".sporades-health");
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
        },
        close() { },
    };
}
function localFileStoragePath(storagePath, fileId) {
    return `${storagePath}/${fileId}`;
}
function localFileVersionPath(storagePath, fileId, version) {
    return `${localFileStoragePath(storagePath, fileId)}/${version}`;
}
export function createS3CompatibleFileStorageAdapter({ endpoint, bucket, region, accessKey, secretKey, namespace, }) {
    if (typeof endpoint !== "string" || endpoint.length === 0) {
        throw new Error("S3-compatible file storage requires an endpoint.");
    }
    if (typeof bucket !== "string" || bucket.length === 0) {
        throw new Error("S3-compatible file storage requires a bucket.");
    }
    if (typeof region !== "string" || region.length === 0) {
        throw new Error("S3-compatible file storage requires a region.");
    }
    if (typeof accessKey !== "string" || accessKey.length === 0 || typeof secretKey !== "string" || secretKey.length === 0) {
        throw new Error("S3-compatible file storage requires access credentials.");
    }
    const isolatedNamespace = s3StorageNamespace(namespace);
    const config = { endpoint, bucket, region, accessKey, secretKey };
    let bucketReady = false;
    const ensureBucket = async () => {
        if (bucketReady) {
            return;
        }
        const head = await s3Request(config, { method: "HEAD", key: null });
        if (head.statusCode === 404) {
            const created = await s3Request(config, { method: "PUT", key: null, body: Buffer.alloc(0) });
            if (created.statusCode < 200 || created.statusCode >= 300) {
                throw new Error(`S3-compatible file storage bucket setup failed with HTTP ${created.statusCode}.`);
            }
        }
        else if (head.statusCode < 200 || head.statusCode >= 300) {
            throw new Error(`S3-compatible file storage bucket check failed with HTTP ${head.statusCode}.`);
        }
        bucketReady = true;
    };
    return {
        engine: "s3-compatible",
        endpoint,
        bucket,
        region,
        namespace: isolatedNamespace,
        objectKeyPrefix: `${isolatedNamespace}/files`,
        async writeFileVersion({ fileId, version, bytes }) {
            await ensureBucket();
            const result = await s3Request(config, {
                method: "PUT",
                key: s3ObjectKey(isolatedNamespace, fileId, version),
                body: bytes,
            });
            if (result.statusCode < 200 || result.statusCode >= 300) {
                throw new Error(`S3-compatible file write failed with HTTP ${result.statusCode}.`);
            }
        },
        async readFileVersion({ fileId, version }) {
            const result = await s3Request(config, {
                method: "GET",
                key: s3ObjectKey(isolatedNamespace, fileId, version),
            });
            if (result.statusCode === 404) {
                throw s3ObjectNotFoundError();
            }
            if (result.statusCode < 200 || result.statusCode >= 300) {
                throw new Error(`S3-compatible file read failed with HTTP ${result.statusCode}.`);
            }
            return result.body;
        },
        async deleteFileVersion({ fileId, version }) {
            const result = await s3Request(config, {
                method: "DELETE",
                key: s3ObjectKey(isolatedNamespace, fileId, version),
            });
            if (result.statusCode === 404) {
                return;
            }
            if (result.statusCode < 200 || result.statusCode >= 300) {
                throw new Error(`S3-compatible file delete failed with HTTP ${result.statusCode}.`);
            }
        },
        async checkHealth() {
            try {
                await ensureBucket();
                return { ok: true, adapter: "s3-compatible" };
            }
            catch {
                return { ok: false, adapter: "s3-compatible" };
            }
        },
        close() { },
    };
}
function s3ObjectKey(namespace, fileId, version) {
    return `${namespace}/files/${fileId}/${version}`;
}
async function s3Request(config, { method, key = null, body = null }) {
    const endpoint = new URL(config.endpoint);
    const isHttps = endpoint.protocol === "https:";
    const transport = await import(isHttps ? "node:https" : "node:http");
    const payload = s3RequestBodyBuffer(body);
    const amzDate = s3AmzDate(new Date());
    const date = amzDate.slice(0, 8);
    const pathname = s3CanonicalPath(endpoint.pathname, config.bucket, key);
    const payloadHash = s3Sha256Hex(payload);
    const headers = s3SignedHeaders({
        "host": endpoint.host,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
    });
    headers.authorization = s3Signature({
        method,
        pathname,
        query: "",
        headers,
        payloadHash,
        accessKey: config.accessKey,
        secretKey: config.secretKey,
        region: config.region,
        date,
        amzDate,
    });
    return await new Promise((resolve, reject) => {
        const request = transport.request({
            protocol: endpoint.protocol,
            hostname: endpoint.hostname,
            port: endpoint.port || undefined,
            method,
            path: `${pathname}${endpoint.search}`,
            headers: {
                ...headers,
                "content-length": payload.length,
            },
        }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.on("end", () => {
                resolve({
                    statusCode: response.statusCode ?? 0,
                    headers: response.headers,
                    body: Buffer.concat(chunks),
                });
            });
        });
        request.on("error", reject);
        if (payload.length > 0) {
            request.write(payload);
        }
        request.end();
    });
}
function s3RequestBodyBuffer(body) {
    if (body === null || body === undefined) {
        return Buffer.alloc(0);
    }
    if (Buffer.isBuffer(body)) {
        return body;
    }
    if (body instanceof Uint8Array) {
        return Buffer.from(body);
    }
    return Buffer.from(String(body));
}
function s3SignedHeaders(headers) {
    return Object.fromEntries(Object.entries(headers)
        .map(([name, value]) => [name.toLowerCase(), String(value).trim()])
        .sort(([left], [right]) => left.localeCompare(right)));
}
function s3Signature({ method, pathname, query, headers, payloadHash, accessKey, secretKey, region, date, amzDate, }) {
    const signedHeaders = Object.keys(headers).join(";");
    const canonicalHeaders = Object.entries(headers)
        .map(([name, value]) => `${name}:${value}\n`)
        .join("");
    const canonicalRequest = [method, pathname, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const credentialScope = `${date}/${region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, s3Sha256Hex(canonicalRequest)].join("\n");
    const signature = s3Hmac(s3SigningKey(secretKey, date, region), stringToSign).toString("hex");
    return `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
function s3SigningKey(secretKey, date, region) {
    const dateKey = s3Hmac(`AWS4${secretKey}`, date);
    const dateRegionKey = s3Hmac(dateKey, region);
    const dateRegionServiceKey = s3Hmac(dateRegionKey, "s3");
    return s3Hmac(dateRegionServiceKey, "aws4_request");
}
function s3CanonicalPath(basePath, bucket, key) {
    const base = String(basePath ?? "")
        .split("/")
        .filter(Boolean);
    const parts = [...base, bucket, ...(key ? String(key).split("/") : [])].map(s3EncodedPathSegment);
    return `/${parts.join("/")}`;
}
function s3EncodedPathSegment(segment) {
    return encodeURIComponent(segment).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
function s3StorageNamespace(namespace) {
    if (typeof namespace !== "string" || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(namespace)) {
        throw new Error("S3-compatible file storage requires a capsule storage namespace.");
    }
    return `capsules/${namespace}`;
}
function s3AmzDate(date) {
    return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}
function s3Hmac(key, data) {
    return createHmac("sha256", key).update(data).digest();
}
function s3Sha256Hex(data) {
    return createHash("sha256").update(data).digest("hex");
}
function s3ObjectNotFoundError() {
    const error = new Error("S3-compatible file object not found.");
    error.code = "ENOENT";
    return error;
}
export async function createSqliteDatabaseAdapter(databasePath, options = {}) {
    const { DatabaseSync } = await import("node:sqlite");
    const path = await import("node:path");
    if (!options.readOnly)
        mkdirSync(path.dirname(String(databasePath)), { recursive: true });
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
                "(id, ownerId, bucketId, bucketName, path, name, type, size, version, status, createdAt, updatedAt, deletedAt) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)").run(row.id, row.ownerId, row.bucketId, row.bucketName, row.path, row.name, row.type, row.size, row.version, row.status, row.createdAt, row.updatedAt);
        },
        updatePendingFileRow(row) {
            return this.prepare("UPDATE sporades_files SET bucketId = ?, bucketName = ?, path = ?, name = ?, type = ?, size = ?, version = ?, status = ?, updatedAt = ?, deletedAt = NULL WHERE id = ?").run(row.bucketId, row.bucketName, row.path, row.name, row.type, row.size, row.version, row.status, row.updatedAt, row.id);
        },
        insertFileUpload(row) {
            return this.prepare("INSERT INTO sporades_file_uploads " +
                "(id, fileId, ownerId, bucketId, bucketName, path, name, type, version, expectedSize, createdAt) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(row.id, row.fileId, row.ownerId, row.bucketId, row.bucketName, row.path, row.name, row.type, row.version, row.expectedSize, row.createdAt);
        },
        selectFileById(fileId) {
            return this.prepare("SELECT * FROM sporades_files WHERE id = ?").get(fileId) ?? null;
        },
        selectLiveFileByPath(path) {
            return this.prepare("SELECT * FROM sporades_files WHERE path = ? AND deletedAt IS NULL AND status = ?").all(path, "uploaded");
        },
        selectActiveFileByPath(path) {
            return this.prepare("SELECT * FROM sporades_files WHERE path = ? AND deletedAt IS NULL AND status IN (?, ?)").all(path, "pending", "uploaded");
        },
        selectPendingFileUploadByPath(path) {
            return (this.prepare("SELECT * FROM sporades_file_uploads WHERE path = ? ORDER BY createdAt DESC, id DESC LIMIT 1").get(path) ?? null);
        },
        selectFileUpload(uploadId) {
            return this.prepare("SELECT * FROM sporades_file_uploads WHERE id = ?").get(uploadId) ?? null;
        },
        completeFileUpload(upload, size, updatedAt) {
            const consumed = this.prepare("DELETE FROM sporades_file_uploads WHERE id = ? AND fileId = ? AND version = ?").run(upload.id, upload.fileId, upload.version);
            if (consumed.changes === 0) {
                return consumed;
            }
            const existing = this.selectFileById(upload.fileId);
            if (existing) {
                if (existing.deletedAt !== null && existing.deletedAt !== undefined) {
                    return { changes: 0 };
                }
                return this.prepare("UPDATE sporades_files SET bucketId = ?, bucketName = ?, path = ?, name = ?, type = ?, size = ?, version = ?, status = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL").run(upload.bucketId, upload.bucketName, upload.path, upload.name, upload.type, size, upload.version, "uploaded", updatedAt, upload.fileId);
            }
            return this.insertFileRow({
                id: upload.fileId,
                ownerId: upload.ownerId,
                bucketId: upload.bucketId,
                bucketName: upload.bucketName,
                path: upload.path,
                name: upload.name,
                type: upload.type,
                size,
                version: upload.version,
                status: "uploaded",
                createdAt: upload.createdAt,
                updatedAt,
            });
        },
        deleteFileUploadsForPath(path) {
            return this.prepare("DELETE FROM sporades_file_uploads WHERE path = ?").run(path);
        },
        deleteFileUploadsForFile(ownerId, fileId) {
            return this.prepare("DELETE FROM sporades_file_uploads WHERE ownerId = ? AND fileId = ?").run(ownerId, fileId);
        },
        deleteFileUpload(uploadId) {
            return this.prepare("DELETE FROM sporades_file_uploads WHERE id = ?").run(uploadId);
        },
        selectPublicFileRow(publicUrlId) {
            return (this.prepare("SELECT p.id AS publicUrlId, p.fileId, p.version AS publicVersion, p.expiresAt, p.revokedAt, " +
                "f.id, f.ownerId, f.bucketId, f.bucketName, f.path, f.name, f.type, f.size, f.version, f.status, f.createdAt, f.updatedAt, f.deletedAt " +
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
        ensureUserPreferencesStorage() {
            return createUserPreferencesTables(this);
        },
        readUserPreferences(userId) {
            return this.prepare("SELECT userId, value, updatedAt FROM sporades_user_preferences WHERE userId = ?").get(userId) ?? null;
        },
        saveUserPreferences(row) {
            return this.prepare("INSERT OR REPLACE INTO sporades_user_preferences (userId, value, updatedAt) VALUES (?, ?, ?)").run(row.userId, row.value, row.updatedAt);
        },
        findAuthUserByProviderEmail(provider, email) {
            const row = this.prepare("SELECT id FROM sporades_auth_users WHERE provider = ? AND email = ?").get(provider, email) ?? null;
            return isReservedAuthUserId(row?.id) ? null : row;
        },
        insertAuthUser(row) {
            assertNotReservedAuthUserId(row.id);
            return this.prepare("INSERT INTO sporades_auth_users " +
                "(id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(row.id, row.createdAt, row.displayName, row.email, row.picture, row.isAuthenticated, row.isGuest, row.provider);
        },
        updateAuthUserProfile(row) {
            assertNotReservedAuthUserId(row.id);
            return this.prepare("UPDATE sporades_auth_users SET displayName = ?, picture = ?, isAuthenticated = ?, isGuest = ? WHERE id = ?").run(row.displayName, row.picture, row.isAuthenticated, row.isGuest, row.id);
        },
        linkAuthUser(row) {
            assertNotReservedAuthUserId(row.id);
            return this.prepare("UPDATE sporades_auth_users SET displayName = ?, email = ?, picture = ?, isAuthenticated = ?, isGuest = ?, provider = ? WHERE id = ?").run(row.displayName, row.email, row.picture, row.isAuthenticated, row.isGuest, row.provider, row.id);
        },
        insertAuthSession(row) {
            assertNotReservedAuthUserId(row.userId);
            return this.prepare("INSERT INTO sporades_auth_sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)").run(row.token, row.userId, row.createdAt, row.expiresAt);
        },
        deleteAuthSession(token) {
            return this.prepare("DELETE FROM sporades_auth_sessions WHERE token = ?").run(token);
        },
        refreshAuthSession(token, expiresAt) {
            return this.prepare("UPDATE sporades_auth_sessions SET expiresAt = ? WHERE token = ?").run(expiresAt, token);
        },
        rotateAuthSession(previousToken, row) {
            assertNotReservedAuthUserId(row.userId);
            return this.prepare("UPDATE sporades_auth_sessions SET token = ?, userId = ?, createdAt = ?, expiresAt = ? WHERE token = ?").run(row.token, row.userId, row.createdAt, row.expiresAt, previousToken);
        },
        readAuthSessionWithUser(token) {
            const row = this.prepare("SELECT s.token, s.expiresAt, u.id AS userId, u.displayName, u.email, u.picture, u.isAuthenticated, u.isGuest, u.provider " +
                "FROM sporades_auth_sessions s " +
                "JOIN sporades_auth_users u ON u.id = s.userId " +
                "WHERE s.token = ?").get(token) ?? null;
            if (isReservedAuthUserId(row?.userId)) {
                return null;
            }
            return row;
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
            assertNotReservedAuthUserId(row.userId);
            return this.prepare("INSERT INTO sporades_auth_email_credentials (email, userId, passwordHash, passwordSalt, createdAt) VALUES (?, ?, ?, ?, ?)").run(row.email, row.userId, row.passwordHash, row.passwordSalt, row.createdAt);
        },
        findEmailCredentialWithUser(email) {
            const row = (this.prepare("SELECT c.email, c.userId, c.passwordHash, c.passwordSalt, u.displayName, u.picture, u.isAuthenticated, u.isGuest, u.provider " +
                "FROM sporades_auth_email_credentials c " +
                "JOIN sporades_auth_users u ON u.id = c.userId " +
                "WHERE c.email = ?").get(email) ?? null);
            return isReservedAuthUserId(row?.userId) ? null : row;
        },
        migrateAppSchema(schema) {
            this.exec("BEGIN");
            try {
                const result = migrateAppSchema(this, schema);
                this.exec("COMMIT");
                return result;
            }
            catch (error) {
                this.exec("ROLLBACK");
                throw error;
            }
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
        async withReadOnlySnapshot(fn) {
            this.exec("BEGIN");
            this.exec("PRAGMA query_only = ON");
            try {
                const result = await fn(this);
                this.exec("COMMIT");
                return result;
            }
            catch (error) {
                this.exec("ROLLBACK");
                throw error;
            }
            finally {
                if (!options.readOnly)
                    this.exec("PRAGMA query_only = OFF");
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
                .filter((name) => name !== "sporades_log_events" && name !== "sporades_schedules" && name !== "sporades_schedule_occurrences");
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
                const validation = validateReadOnlyInspectionSql(sql);
                if (!validation.ok) {
                    return validation;
                }
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
                const statement = this.prepare(String(sql ?? ""));
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
export async function createPostgresDatabaseAdapter(options) {
    const url = typeof options === "string" ? options : options?.url;
    if (!url) {
        throw commandError("Missing Postgres database service URL.", "Start a Dev session or local Container session with services.database.engine set to postgres.");
    }
    const client = await createPostgresConnection(url);
    let closed = false;
    const shape = await createSqliteDatabaseAdapter(":memory:");
    shape.close();
    const assertOpen = () => {
        if (closed) {
            throw new Error("database is not open");
        }
    };
    const query = async (sql, params = []) => {
        assertOpen();
        return await client.query(postgresInterpolate(sql, params));
    };
    const adapter = {
        ...shape,
        engine: "postgres",
        exec(sql) {
            return query(sql).then(() => undefined);
        },
        prepare(sql) {
            assertOpen();
            return {
                all(...params) {
                    return query(sql, params).then((result) => postgresRowsFromResult(result));
                },
                get(...params) {
                    return this.all(...params).then((rows) => rows[0] ?? null);
                },
                run(...params) {
                    return query(sql, params).then((result) => ({
                        changes: Number(result.rowCount ?? 0),
                        lastInsertRowid: undefined,
                    }));
                },
                columns() {
                    return query(`SELECT * FROM (${sql}) AS __sporades_columns LIMIT 0`).then((result) => result.fields.map((field) => ({ name: postgresRuntimeColumnName(field.name) })));
                },
            };
        },
        async writeSystemMetadata(keyOrMetadata, maybeValue) {
            if (typeof keyOrMetadata === "object" && keyOrMetadata !== null) {
                return await this.writeSchemaMetadata(keyOrMetadata);
            }
            return await this.prepare("INSERT INTO sporades (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value").run(keyOrMetadata ?? "", maybeValue);
        },
        async writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }) {
            await this.writeSystemMetadata("schemaVersion", schemaVersion);
            await this.writeSystemMetadata("schemaHash", schemaHash);
            await this.writeSystemMetadata("schema", schemaJson);
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
                "path TEXT NOT NULL, " +
                "name TEXT NOT NULL, " +
                "type TEXT NOT NULL, " +
                "size INTEGER NOT NULL, " +
                "version TEXT NOT NULL, " +
                "status TEXT NOT NULL, " +
                "createdAt TEXT NOT NULL, " +
                "updatedAt TEXT NOT NULL, " +
                "deletedAt TEXT" +
                ")");
            await this.exec("ALTER TABLE sporades_files ADD COLUMN path TEXT").catch((error) => {
                if (!isDuplicateColumnError(error))
                    throw error;
            });
            await this.exec(filePathBackfillSql());
            await this.exec(activeFilePathDedupeSql());
            await this.exec("CREATE INDEX IF NOT EXISTS sporades_files_path_live ON sporades_files (path, deletedAt, status)");
            await this.exec("CREATE UNIQUE INDEX IF NOT EXISTS sporades_files_path_active_unique " +
                "ON sporades_files (path) WHERE deletedAt IS NULL AND status IN ('pending', 'uploaded')");
            await this.exec("CREATE TABLE IF NOT EXISTS sporades_file_uploads (" +
                "id TEXT PRIMARY KEY, " +
                "fileId TEXT NOT NULL, " +
                "ownerId TEXT NOT NULL, " +
                "bucketId TEXT NOT NULL, " +
                "bucketName TEXT NOT NULL, " +
                "path TEXT NOT NULL, " +
                "name TEXT NOT NULL, " +
                "type TEXT NOT NULL, " +
                "version TEXT NOT NULL, " +
                "expectedSize INTEGER NOT NULL, " +
                "createdAt TEXT NOT NULL" +
                ")");
            await ensureFileUploadTargetColumns(this);
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
        async ensureUserPreferencesStorage() {
            await createUserPreferencesTables(this);
        },
        async readUserPreferences(userId) {
            return (await this.prepare("SELECT userId, value, updatedAt FROM sporades_user_preferences WHERE userId = ?").get(userId)) ?? null;
        },
        async saveUserPreferences(row) {
            return await this.prepare("INSERT INTO sporades_user_preferences (userId, value, updatedAt) VALUES (?, ?, ?) " +
                "ON CONFLICT (userId) DO UPDATE SET value = EXCLUDED.value, updatedAt = EXCLUDED.updatedAt").run(row.userId, row.value, row.updatedAt);
        },
        async insertLogIndexEvent(event) {
            await this.prepare("INSERT INTO sporades_log_events " +
                "(id, timestamp, category, event, level, message, capsuleName, capsuleId, releaseId, requestId, correlationId, payload) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), event.timestamp, event.category, event.event, event.level, event.message, event.capsule?.name ?? null, event.capsule?.id ?? null, event.release?.id ?? event.release ?? null, event.request?.id ?? null, event.correlation?.id ?? event.correlation ?? null, JSON.stringify(event));
        },
        async pruneLogIndex(limit) {
            await this.prepare("DELETE FROM sporades_log_events WHERE id IN (" +
                "SELECT id FROM sporades_log_events ORDER BY timestamp DESC, id DESC OFFSET ?" +
                ")").run(limit);
        },
        async readRecentLogEvents(limit = 200) {
            const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : 200;
            const rows = await this.prepare("SELECT payload FROM sporades_log_events ORDER BY timestamp DESC, id DESC LIMIT ?").all(safeLimit);
            return rows.reverse().map((row) => JSON.parse(row.payload));
        },
        async migrateAppSchema(schema) {
            return await this.withTransaction((transaction) => migrateLibsqlAppSchema(transaction, schema));
        },
        async createAppTable(table, tableName = table.name) {
            await this.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (` +
                postgresAppTableColumnDefinitions(table).join(", ") +
                ")");
        },
        async migrateExistingAppTable(existingTable, nextTable) {
            return await migrateExistingLibsqlAppTable(this, existingTable, nextTable);
        },
        async listInspectableTables() {
            const rows = await this.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name").all();
            return rows.map((row) => row.name).filter((name) => name !== "sporades_log_events" && name !== "sporades_schedules" && name !== "sporades_schedule_occurrences");
        },
        async dumpInspectableDatabase() {
            const tableNames = await this.listInspectableTables();
            const tables = [];
            for (const tableName of tableNames) {
                const columns = (await this.prepare("SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position").all(tableName)).map((column) => column.name);
                const rows = await this.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`).all();
                tables.push({ name: tableName, columns, rows });
            }
            return tables;
        },
        async runReadOnlyInspectionQuery(sql) {
            try {
                const validation = validateReadOnlyInspectionSql(sql);
                if (!validation.ok) {
                    return validation;
                }
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
                const result = await query(String(sql ?? ""));
                return {
                    ok: true,
                    data: {
                        columns: result.fields.map((field) => postgresRuntimeColumnName(field.name)),
                        rows: postgresRowsFromResult(result).filter((row) => !isInternalLogIndexMetadataRow(row, sql)),
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
            await this.exec("BEGIN");
            try {
                const result = await fn(this);
                await this.exec("COMMIT");
                return result;
            }
            catch (error) {
                try {
                    await this.exec("ROLLBACK");
                }
                catch { }
                throw error;
            }
        },
        async withReadOnlySnapshot(fn) {
            await this.exec("BEGIN TRANSACTION READ ONLY");
            try {
                const result = await fn(this);
                await this.exec("COMMIT");
                return result;
            }
            catch (error) {
                try {
                    await this.exec("ROLLBACK");
                }
                catch { }
                throw error;
            }
        },
        async close() {
            closed = true;
            await client.close();
        },
    };
    return adapter;
}
export async function createPostgresConnection(url) {
    const net = await import("node:net");
    const crypto = await import("node:crypto");
    const options = postgresUrlOptions(url);
    const socket = net.createConnection({ host: options.host, port: options.port });
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let ready = false;
    let closed = false;
    let backendKeyData = null;
    let queryQueue = Promise.resolve();
    const waiters = [];
    socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        wakePostgresWaiters(waiters);
    });
    socket.on("error", (error) => {
        for (const waiter of waiters.splice(0)) {
            waiter.reject(error);
        }
    });
    socket.on("close", () => {
        closed = true;
        for (const waiter of waiters.splice(0)) {
            waiter.reject(new Error("database is not open"));
        }
    });
    await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
    });
    let scram = null;
    socket.write(postgresStartupMessage(options));
    while (!ready) {
        const message = await readPostgresMessage();
        if (message.type === "R") {
            const authType = message.body.readInt32BE(0);
            if (authType === 0) {
                continue;
            }
            if (authType === 3) {
                socket.write(postgresPasswordMessage(Buffer.from(`${options.password}\0`, "utf8")));
                continue;
            }
            if (authType === 10) {
                const mechanisms = message.body.subarray(4).toString("utf8").split("\0").filter(Boolean);
                if (!mechanisms.includes("SCRAM-SHA-256")) {
                    throw commandError("Unsupported Postgres SASL mechanism.", "Use the Sporades-managed Postgres Capsule service, which authenticates with SCRAM-SHA-256.");
                }
                scram = createPostgresScramSession(crypto, options.password);
                const clientFirst = Buffer.from(scram.clientFirstMessage, "utf8");
                socket.write(postgresPasswordMessage(Buffer.concat([Buffer.from("SCRAM-SHA-256\0", "utf8"), postgresInt32(clientFirst.length), clientFirst])));
                continue;
            }
            if (authType === 11 && scram) {
                const clientFinal = scram.continue(message.body.subarray(4).toString("utf8"));
                socket.write(postgresPasswordMessage(Buffer.from(clientFinal, "utf8")));
                continue;
            }
            if (authType === 12 && scram) {
                scram.verify(message.body.subarray(4).toString("utf8"));
                continue;
            }
            throw commandError("Unsupported Postgres authentication method.", "Use the Sporades-managed Postgres Capsule service with the generated Capsule service credentials.");
        }
        if (message.type === "K") {
            backendKeyData = message.body;
            continue;
        }
        if (message.type === "E") {
            throw postgresErrorFromBody(message.body);
        }
        if (message.type === "Z") {
            ready = true;
        }
    }
    return {
        get backendKeyData() {
            return backendKeyData;
        },
        query(sql) {
            if (closed) {
                throw new Error("database is not open");
            }
            const pending = queryQueue.then(() => executePostgresQuery(sql), () => executePostgresQuery(sql));
            queryQueue = pending.catch(() => { });
            return pending;
        },
        async close() {
            await queryQueue.catch(() => { });
            if (closed) {
                return;
            }
            closed = true;
            socket.write(Buffer.from([0x58, 0, 0, 0, 4]));
            socket.end();
        },
    };
    async function executePostgresQuery(sql) {
        if (closed) {
            throw new Error("database is not open");
        }
        socket.write(postgresQueryMessage(sql));
        const fields = [];
        const rows = [];
        let rowCount = 0;
        let queryError = null;
        while (true) {
            const message = await readPostgresMessage();
            if (message.type === "T") {
                fields.splice(0, fields.length, ...postgresParseRowDescription(message.body));
                continue;
            }
            if (message.type === "D") {
                rows.push(postgresParseDataRow(message.body, fields));
                continue;
            }
            if (message.type === "C") {
                rowCount = postgresRowCountFromCommand(message.body.toString("utf8").replace(/\0$/, ""));
                continue;
            }
            if (message.type === "E") {
                // Keep reading to the ReadyForQuery message so the next queued query
                // does not consume this query's remaining response messages.
                queryError = postgresErrorFromBody(message.body);
                continue;
            }
            if (message.type === "Z") {
                if (queryError) {
                    throw queryError;
                }
                return { fields, rows, rowCount };
            }
        }
    }
    async function readPostgresMessage() {
        while (buffer.length < 5) {
            await waitForPostgresData(waiters);
        }
        const type = String.fromCharCode(buffer[0]);
        const length = buffer.readInt32BE(1);
        while (buffer.length < 1 + length) {
            await waitForPostgresData(waiters);
        }
        const body = buffer.subarray(5, 1 + length);
        buffer = buffer.subarray(1 + length);
        return { type, body };
    }
}
function postgresUrlOptions(url) {
    const parsed = new URL(String(url));
    return {
        host: parsed.hostname || "127.0.0.1",
        port: parsed.port ? Number(parsed.port) : 5432,
        user: decodeURIComponent(parsed.username || "sporades"),
        password: decodeURIComponent(parsed.password || ""),
        database: decodeURIComponent(parsed.pathname.replace(/^\/+/, "") || "sporades"),
    };
}
function postgresPasswordMessage(body) {
    const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return Buffer.concat([Buffer.from("p"), postgresInt32(bodyBuffer.length + 4), bodyBuffer]);
}
function createPostgresScramSession(crypto, password) {
    const clientNonce = crypto.randomBytes(18).toString("base64");
    const clientFirstBare = `n=,r=${clientNonce}`;
    let serverSignature = null;
    return {
        clientFirstMessage: `n,,${clientFirstBare}`,
        continue(serverFirstMessage) {
            const attributes = new Map(serverFirstMessage.split(",").map((part) => [part.slice(0, 1), part.slice(2)]));
            const serverNonce = attributes.get("r") ?? "";
            const salt = Buffer.from(attributes.get("s") ?? "", "base64");
            const iterations = Number(attributes.get("i") ?? "0");
            if (!serverNonce.startsWith(clientNonce) || salt.length === 0 || !Number.isInteger(iterations) || iterations <= 0) {
                throw new Error("Invalid Postgres SCRAM server-first message.");
            }
            const saltedPassword = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
            const clientKey = crypto.createHmac("sha256", saltedPassword).update("Client Key").digest();
            const storedKey = crypto.createHash("sha256").update(clientKey).digest();
            const clientFinalWithoutProof = `c=biws,r=${serverNonce}`;
            const authMessage = `${clientFirstBare},${serverFirstMessage},${clientFinalWithoutProof}`;
            const clientSignature = crypto.createHmac("sha256", storedKey).update(authMessage).digest();
            const clientProof = Buffer.from(clientKey.map((byte, index) => byte ^ clientSignature[index]));
            const serverKey = crypto.createHmac("sha256", saltedPassword).update("Server Key").digest();
            serverSignature = crypto.createHmac("sha256", serverKey).update(authMessage).digest("base64");
            return `${clientFinalWithoutProof},p=${clientProof.toString("base64")}`;
        },
        verify(serverFinalMessage) {
            if (serverFinalMessage !== `v=${serverSignature}`) {
                throw new Error("Postgres SCRAM server signature verification failed.");
            }
        },
    };
}
function postgresStartupMessage(options) {
    const params = [
        ["user", options.user],
        ["database", options.database],
        ["client_encoding", "UTF8"],
    ];
    const bodyParts = [postgresInt32(196608)];
    for (const [key, value] of params) {
        bodyParts.push(Buffer.from(`${key}\0${value}\0`, "utf8"));
    }
    bodyParts.push(Buffer.from([0]));
    const body = Buffer.concat(bodyParts);
    return Buffer.concat([postgresInt32(body.length + 4), body]);
}
function postgresQueryMessage(sql) {
    const body = Buffer.from(`${sql}\0`, "utf8");
    return Buffer.concat([Buffer.from("Q"), postgresInt32(body.length + 4), body]);
}
function postgresInt32(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32BE(value, 0);
    return buffer;
}
function waitForPostgresData(waiters) {
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
}
function wakePostgresWaiters(waiters) {
    for (const waiter of waiters.splice(0)) {
        waiter.resolve();
    }
}
function postgresParseRowDescription(body) {
    const fields = [];
    let offset = 0;
    const count = body.readInt16BE(offset);
    offset += 2;
    for (let index = 0; index < count; index += 1) {
        const nameEnd = body.indexOf(0, offset);
        const name = body.subarray(offset, nameEnd).toString("utf8");
        offset = nameEnd + 1;
        offset += 6;
        const dataTypeID = body.readInt32BE(offset);
        offset += 4;
        offset += 8;
        fields.push({ name, dataTypeID });
    }
    return fields;
}
function postgresParseDataRow(body, fields) {
    const row = {};
    let offset = 0;
    const count = body.readInt16BE(offset);
    offset += 2;
    for (let index = 0; index < count; index += 1) {
        const field = fields[index];
        if (!field) {
            throw new Error("Postgres protocol error: data row did not match row description.");
        }
        const length = body.readInt32BE(offset);
        offset += 4;
        if (length === -1) {
            row[field.name] = null;
            continue;
        }
        const raw = body.subarray(offset, offset + length).toString("utf8");
        offset += length;
        row[field.name] = postgresValueFromText(raw, field.dataTypeID);
    }
    return row;
}
function postgresValueFromText(value, dataTypeID) {
    if ([20, 21, 23].includes(dataTypeID)) {
        return Number(value);
    }
    if ([700, 701, 1700].includes(dataTypeID)) {
        return Number(value);
    }
    if (dataTypeID === 16) {
        return value === "t";
    }
    return value;
}
function postgresRowCountFromCommand(tag) {
    const match = tag.match(/\s(\d+)$/);
    return match ? Number(match[1]) : 0;
}
function postgresErrorFromBody(body) {
    const fields = {};
    let offset = 0;
    while (offset < body.length && body[offset] !== 0) {
        const type = String.fromCharCode(body[offset]);
        offset += 1;
        const end = body.indexOf(0, offset);
        fields[type] = body.subarray(offset, end).toString("utf8");
        offset = end + 1;
    }
    return new Error(fields.M ?? "Postgres query failed.");
}
function postgresInterpolate(sql, params = []) {
    let index = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    let result = "";
    const text = String(sql ?? "");
    for (let position = 0; position < text.length; position += 1) {
        const char = text[position];
        const next = text[position + 1];
        if (lineComment) {
            result += char;
            if (char === "\n") {
                lineComment = false;
            }
            continue;
        }
        if (blockComment) {
            result += char;
            if (char === "*" && next === "/") {
                result += next;
                position += 1;
                blockComment = false;
            }
            continue;
        }
        if (quote) {
            result += char;
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
        if (char === "-" && next === "-") {
            result += char + next;
            position += 1;
            lineComment = true;
            continue;
        }
        if (char === "/" && next === "*") {
            result += char + next;
            position += 1;
            blockComment = true;
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            quote = char;
            result += char;
            continue;
        }
        if (char === "?") {
            if (index >= params.length) {
                throw new Error("Missing Postgres query parameter.");
            }
            result += toSqlLiteral(params[index]);
            index += 1;
            continue;
        }
        result += char;
    }
    if (index < params.length) {
        throw new Error("Too many Postgres query parameters.");
    }
    return result;
}
function postgresPlaceholders(sql) {
    let index = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    let result = "";
    const text = String(sql ?? "");
    for (let position = 0; position < text.length; position += 1) {
        const char = text[position];
        const next = text[position + 1];
        if (lineComment) {
            result += char;
            if (char === "\n") {
                lineComment = false;
            }
            continue;
        }
        if (blockComment) {
            result += char;
            if (char === "*" && next === "/") {
                result += next;
                position += 1;
                blockComment = false;
            }
            continue;
        }
        if (quote) {
            result += char;
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
        if (char === "-" && next === "-") {
            result += char + next;
            position += 1;
            lineComment = true;
            continue;
        }
        if (char === "/" && next === "*") {
            result += char + next;
            position += 1;
            blockComment = true;
            continue;
        }
        if (char === '"' || char === "'" || char === "`") {
            quote = char;
            result += char;
            continue;
        }
        if (char === "?") {
            index += 1;
            result += `$${index}`;
            continue;
        }
        result += char;
    }
    return result;
}
function postgresRowsFromResult(result) {
    return result.rows.map((row) => {
        const normalized = {};
        for (const [key, value] of Object.entries(row)) {
            normalized[postgresRuntimeColumnName(key)] = value;
        }
        return normalized;
    });
}
function postgresRuntimeColumnName(name) {
    return ({
        ownerid: "ownerId",
        bucketid: "bucketId",
        bucketname: "bucketName",
        createdat: "createdAt",
        updatedat: "updatedAt",
        deletedat: "deletedAt",
        fileid: "fileId",
        expectedsize: "expectedSize",
        publicurlid: "publicUrlId",
        publicversion: "publicVersion",
        expiresat: "expiresAt",
        revokedat: "revokedAt",
        userid: "userId",
        displayname: "displayName",
        isauthenticated: "isAuthenticated",
        isguest: "isGuest",
        passwordhash: "passwordHash",
        passwordsalt: "passwordSalt",
        sessiontoken: "sessionToken",
        redirecturi: "redirectUri",
        capsulename: "capsuleName",
        capsuleid: "capsuleId",
        releaseid: "releaseId",
        requestid: "requestId",
        correlationid: "correlationId",
    }[name] ?? name);
}
function postgresAppTableColumnDefinitions(table) {
    return [
        `${quoteIdentifier("id")} TEXT PRIMARY KEY`,
        `${quoteIdentifier("createdAt")} TEXT NOT NULL`,
        `${quoteIdentifier("updatedAt")} TEXT NOT NULL`,
        ...table.fields.map((field) => appFieldColumnDefinition(field)),
    ];
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
                "path TEXT NOT NULL, " +
                "name TEXT NOT NULL, " +
                "type TEXT NOT NULL, " +
                "size INTEGER NOT NULL, " +
                "version TEXT NOT NULL, " +
                "status TEXT NOT NULL, " +
                "createdAt TEXT NOT NULL, " +
                "updatedAt TEXT NOT NULL, " +
                "deletedAt TEXT" +
                ")");
            await this.exec("ALTER TABLE sporades_files ADD COLUMN path TEXT").catch((error) => {
                if (!isDuplicateColumnError(error))
                    throw error;
            });
            await this.exec(filePathBackfillSql());
            await this.exec(activeFilePathDedupeSql());
            await this.exec("CREATE INDEX IF NOT EXISTS sporades_files_path_live ON sporades_files (path, deletedAt, status)");
            await this.exec("CREATE UNIQUE INDEX IF NOT EXISTS sporades_files_path_active_unique " +
                "ON sporades_files (path) WHERE deletedAt IS NULL AND status IN ('pending', 'uploaded')");
            await this.exec("CREATE TABLE IF NOT EXISTS sporades_file_uploads (" +
                "id TEXT PRIMARY KEY, " +
                "fileId TEXT NOT NULL, " +
                "ownerId TEXT NOT NULL, " +
                "bucketId TEXT NOT NULL, " +
                "bucketName TEXT NOT NULL, " +
                "path TEXT NOT NULL, " +
                "name TEXT NOT NULL, " +
                "type TEXT NOT NULL, " +
                "version TEXT NOT NULL, " +
                "expectedSize INTEGER NOT NULL, " +
                "createdAt TEXT NOT NULL" +
                ")");
            await ensureFileUploadTargetColumns(this);
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
            return await this.withTransaction((transaction) => migrateLibsqlAppSchema(transaction, schema));
        },
        async migrateExistingAppTable(existingTable, nextTable) {
            return await migrateExistingLibsqlAppTable(this, existingTable, nextTable);
        },
        async listInspectableTables() {
            const rows = await this.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
            return rows.map((row) => row.name).filter((name) => name !== "sporades_log_events" && name !== "sporades_schedules" && name !== "sporades_schedule_occurrences");
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
                const validation = validateReadOnlyInspectionSql(sql);
                if (!validation.ok) {
                    return validation;
                }
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
                const statement = this.prepare(String(sql ?? ""));
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
        async withReadOnlySnapshot(fn) {
            const transaction = { baton: null, baseUrl: endpoint };
            const snapshotAdapter = { ...adapter, ...createOperations(transaction) };
            activeTransactions.add(transaction);
            try {
                await libsqlExecute({ endpoint, authToken, transaction, sql: "BEGIN", params: [], close: false });
                await libsqlExecute({ endpoint, authToken, transaction, sql: "PRAGMA query_only = ON", params: [], close: false });
                const result = await fn(snapshotAdapter);
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
            let indexed;
            try {
                const inserted = options.database.insertLogIndexEvent(event);
                indexed = isPromiseLike(inserted)
                    ? inserted.then(() => options.database.pruneLogIndex(logIndexLimit(options.config)))
                    : options.database.pruneLogIndex(logIndexLimit(options.config));
            }
            catch {
                indexed = undefined;
            }
            if (process.env.SPORADES_LOG_STDOUT === "1") {
                process.stdout.write(`${JSON.stringify(event)}\n`);
            }
            return isPromiseLike(indexed) ? indexed.then(() => event, () => event) : event;
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
const PRIVILEGED_AUDIT_SCHEMA = "sporades.privileged-audit.v1";
const PRIVILEGED_AUDIT_ACTOR_KINDS = new Set(["privileged-server-role", "captured-user", "platform", "unknown"]);
const PRIVILEGED_AUDIT_OUTCOMES = new Set(["started", "completed", "errored", "finished"]);
function createPrivilegedAuditEmitter(log) {
    return {
        emit(details) {
            return emitPrivilegedAuditEvent(log, details);
        },
    };
}
function emitPrivilegedAuditEvent(target, details = {}) {
    const log = target?.log?.emit ? target.log : target;
    if (!log?.emit) {
        throw new Error("Privileged audit events require a runtime log sink.");
    }
    return log.emit(createPrivilegedAuditLogInput(details));
}
function createContextPrivilegedApi(database, contextGetter) {
    return {
        async run(options, callback) {
            const context = contextGetter();
            if (context?.__privilegedRunActive) {
                throw commandError("Nested privileged runs are not supported.", "Call separate top-level ctx.privileged.run operations instead of starting one privileged run from inside another.", "NESTED_PRIVILEGED_RUN");
            }
            const auditDetails = createPrivilegedRunAuditDetails(context, options);
            if (typeof callback !== "function") {
                throw commandError("Privileged run requires a callback.", "Pass a callback to ctx.privileged.run after the operation metadata.", "INVALID_PRIVILEGED_RUN_CALLBACK");
            }
            const signal = normalizePrivilegedRunSignal(options.signal);
            try {
                await emitPrivilegedRunAudit(database, context, { ...auditDetails, outcome: "started" });
            }
            catch (error) {
                throw createPrivilegedAuditEmissionPublicError(error);
            }
            const privilegedContext = createPrivilegedHandlerContext(database, context, signal);
            let callbackResult;
            let callbackError;
            let callbackSettled = false;
            try {
                if (signal.aborted) {
                    throw createPrivilegedRunAbortError();
                }
                try {
                    callbackResult = await callback(privilegedContext);
                    callbackSettled = true;
                }
                catch (error) {
                    callbackError = error;
                    callbackSettled = true;
                    throw error;
                }
                try {
                    await emitPrivilegedRunAudit(database, context, { ...auditDetails, outcome: "completed" });
                }
                catch (error) {
                    throw createPrivilegedAuditEmissionPublicError(error, { callbackResult });
                }
                return callbackResult;
            }
            catch (error) {
                if (isPrivilegedAuditEmissionPublicError(error)) {
                    throw error;
                }
                const safeErrorCode = signal.aborted && !callbackSettled
                    ? "ABORTED"
                    : safePrivilegedAuditErrorCode(error, "errored");
                try {
                    await emitPrivilegedRunAudit(database, context, {
                        ...auditDetails,
                        outcome: "errored",
                        safeErrorCode,
                    });
                }
                catch (auditError) {
                    throw createPrivilegedAuditEmissionPublicError(auditError, { callbackError: callbackSettled ? callbackError ?? error : error });
                }
                throw createPrivilegedRunPublicError(error);
            }
            finally {
                try {
                    await emitPrivilegedRunAudit(database, context, { ...auditDetails, outcome: "finished" });
                }
                catch (error) {
                    throw createPrivilegedAuditEmissionPublicError(error, callbackSettled
                        ? callbackError
                            ? { callbackError }
                            : { callbackResult }
                        : undefined);
                }
                finally {
                    revokePrivilegedDbAccess(privilegedContext);
                }
            }
        },
    };
}
async function emitPrivilegedRunAudit(database, context, details) {
    const event = await database.audit.emit(details);
    recordPrivilegedAuditEventForTransaction(context, event);
    return event;
}
function recordPrivilegedAuditEventForTransaction(context, event) {
    if (!context || event?.category !== "audit" || !String(event?.event ?? "").startsWith("privileged.")) {
        return;
    }
    if (!Array.isArray(context.__privilegedAuditEvents)) {
        Object.defineProperty(context, "__privilegedAuditEvents", {
            value: [],
            enumerable: false,
            configurable: true,
        });
    }
    context.__privilegedAuditEvents.push(event);
}
async function reindexPrivilegedAuditEventsAfterRollback(database, context) {
    const events = context?.__privilegedAuditEvents;
    if (!Array.isArray(events) || events.length === 0) {
        return;
    }
    for (const event of events) {
        try {
            if (await privilegedAuditEventAlreadyIndexed(database, event)) {
                continue;
            }
            await database.sqlite.insertLogIndexEvent(event);
        }
        catch {
            return;
        }
    }
    try {
        await database.sqlite.pruneLogIndex(logIndexLimit(database.config ?? {}));
    }
    catch {
    }
}
async function privilegedAuditEventAlreadyIndexed(database, event) {
    const recent = await database.sqlite.readRecentLogEvents(logIndexLimit(database.config ?? {}));
    return Array.isArray(recent) && recent.some((candidate) => samePrivilegedAuditLogEvent(candidate, event));
}
function samePrivilegedAuditLogEvent(left, right) {
    return (left?.category === right?.category &&
        left?.event === right?.event &&
        left?.timestamp === right?.timestamp &&
        left?.data?.schema === right?.data?.schema &&
        left?.data?.operation === right?.data?.operation &&
        left?.data?.outcome === right?.data?.outcome &&
        left?.data?.actorKind === right?.data?.actorKind &&
        (left?.data?.safeErrorCode ?? null) === (right?.data?.safeErrorCode ?? null));
}
function normalizePrivilegedRunSignal(value) {
    if (value && typeof value === "object" && typeof value.aborted === "boolean") {
        return value;
    }
    return new AbortController().signal;
}
function createPrivilegedRunAbortError() {
    return commandError("Privileged run aborted.", "Retry the privileged operation if cancellation was not intended.", "ABORTED");
}
function createPrivilegedRunAuditDetails(context, options) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw invalidPrivilegedRunMetadata("Privileged run requires operation metadata.");
    }
    const operation = validatedPrivilegedOperation(options.operation);
    const metadata = validatedPrivilegedMetadata(options.metadata);
    return {
        actorKind: "privileged-server-role",
        operation,
        surface: auditString(options.surface ?? context?.kind, "server-handler"),
        targetResourceKind: auditString(options.targetResourceKind ?? options.target?.resourceKind, "unknown"),
        correlation: options.correlation ?? null,
        request: options.request ?? null,
        source: "runtime",
        metadata,
    };
}
function validatedPrivilegedOperation(value) {
    if (typeof value !== "string" || !value.trim()) {
        throw invalidPrivilegedRunMetadata("Privileged run requires a stable operation name.");
    }
    const operation = value.trim();
    if (!/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/i.test(operation)) {
        throw invalidPrivilegedRunMetadata("Privileged run operation metadata is invalid.");
    }
    return operation;
}
function validatedPrivilegedMetadata(value) {
    if (value === undefined) {
        return {};
    }
    if (!isPlainPrivilegedMetadata(value)) {
        throw invalidPrivilegedRunMetadata("Privileged run metadata must be a structural object.");
    }
    return { ...value };
}
function isPlainPrivilegedMetadata(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    if (typeof value.then === "function") {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function invalidPrivilegedRunMetadata(message) {
    return commandError(message, "Pass stable, synchronous, structural metadata to ctx.privileged.run before starting privileged work.", "INVALID_PRIVILEGED_RUN_METADATA");
}
function createPrivilegedRunPublicError(cause) {
    const error = commandError("Privileged run failed.", "Check the privileged audit events and server logs before exposing a safe response.", "PRIVILEGED_RUN_FAILED");
    error.cause = cause;
    return error;
}
function createPrivilegedAuditEmissionPublicError(cause, context = undefined) {
    const error = commandError("Privileged audit emission failed.", "Check the server audit log configuration before retrying the privileged operation.", "PRIVILEGED_AUDIT_EMISSION_FAILED");
    error.cause = cause;
    if (context) {
        error.privilegedAuditContext = context;
    }
    return error;
}
function isPrivilegedAuditEmissionPublicError(error) {
    return error?.code === "PRIVILEGED_AUDIT_EMISSION_FAILED";
}
function createPrivilegedHandlerContext(database, context, signal) {
    const privilegedContext = {
        ...context,
        signal,
        __privilegedRunActive: true,
        __jobEnqueuedBy: context.auth?.userId ?? null,
        __jobParentContext: context,
        auth: {
            userId: privilegedAuthUserId(),
            displayName: "Privileged server role",
            email: null,
            picture: null,
            isAuthenticated: false,
            isGuest: false,
            provider: "privileged-server-role",
        },
    };
    const provenanceStore = (database.__rootDatabase ?? database).jobScheduleProvenanceByContext;
    const scheduleProvenance = provenanceStore?.get(context);
    if (scheduleProvenance)
        provenanceStore.set(privilegedContext, scheduleProvenance);
    grantPrivilegedDbAccess(privilegedContext);
    const holder = createContextHolder(privilegedContext);
    privilegedContext.db = createEndpointDatabaseApi(database, () => holder.current);
    privilegedContext.files = createPrivilegedFileApi(database, () => holder.current);
    privilegedContext.privileged = createContextPrivilegedApi(database, () => holder.current);
    privilegedContext.jobs = createPrivilegedJobApi(database, () => holder.current);
    privilegedContext.schedules = createPrivilegedScheduleApi(database, () => holder.current);
    return privilegedContext;
}
function createPrivilegedScheduleApi(database, contextGetter) {
    const sqlite = () => (database.__rootDatabase ?? database).sqlite;
    return {
        async get(name) {
            assertActivePrivilegedJobAccess(contextGetter);
            if (typeof name !== "string" || !name)
                throw jobError("INVALID_SCHEDULE_NAME", "Invalid Schedule name.", "Pass a non-empty declared Schedule name.");
            const row = await sqlite().prepare("SELECT * FROM sporades_schedules WHERE name=?").get(name);
            return row ? await scheduleSummary(sqlite(), row) : null;
        },
        async list() {
            assertActivePrivilegedJobAccess(contextGetter);
            const rows = await sqlite().prepare("SELECT * FROM sporades_schedules ORDER BY name ASC").all();
            const summaries = [];
            for (const row of rows)
                summaries.push(await scheduleSummary(sqlite(), row));
            return summaries;
        },
    };
}
async function scheduleSummary(sqlite, row) {
    const invalid = (field) => {
        const error = jobError("SCHEDULE_INSPECTION_INVALID_STATE", "Stored Schedule state is invalid.", "Repair or remove the malformed Schedule before retrying inspection.");
        error.scheduleName = typeof row?.name === "string" ? row.name : null;
        error.field = field;
        return error;
    };
    if (typeof row.name !== "string" || !row.name)
        throw invalid("name");
    if (typeof row.expression !== "string" || !row.expression)
        throw invalid("expression");
    if (typeof row.effectiveTimezone !== "string" || !row.effectiveTimezone)
        throw invalid("timezone");
    if (!["skip", "latest"].includes(row.missedRunPolicy))
        throw invalid("missedRun");
    if (![0, 1, false, true].includes(row.enabled))
        throw invalid("enabled");
    if (row.nextOccurrence != null && Number.isNaN(Date.parse(row.nextOccurrence)))
        throw invalid("nextOccurrence");
    const latestOutcome = row.latestOutcome == null ? null : String(row.latestOutcome);
    let latestOccurrence = null;
    if (latestOutcome === null && [row.latestScheduledFor, row.latestJobId, row.latestErrorCode].some((value) => value != null))
        throw invalid("latestOccurrence");
    if (latestOutcome !== null && (typeof row.latestScheduledFor !== "string" || Number.isNaN(Date.parse(row.latestScheduledFor))))
        throw invalid("latestOccurrence.scheduledFor");
    if (latestOutcome === "enqueued") {
        if (typeof row.latestJobId !== "string" || !row.latestJobId)
            throw invalid("latestOccurrence.jobId");
        if (row.latestErrorCode != null)
            throw invalid("latestOccurrence.errorCode");
        const job = await sqlite.prepare("SELECT id FROM sporades_jobs WHERE id=? AND scheduleName=? AND scheduledFor=?").get(row.latestJobId, row.name, row.latestScheduledFor);
        if (!job)
            throw invalid("latestOccurrence.jobId");
        latestOccurrence = { scheduledFor: row.latestScheduledFor, outcome: "enqueued", jobId: row.latestJobId };
    }
    else if (latestOutcome === "payload-failed") {
        if (row.latestJobId != null)
            throw invalid("latestOccurrence.jobId");
        if (typeof row.latestErrorCode !== "string" || !row.latestErrorCode)
            throw invalid("latestOccurrence.errorCode");
        if (!["SCHEDULE_PAYLOAD_FAILED", "SCHEDULE_ENQUEUE_FAILED"].includes(row.latestErrorCode))
            throw invalid("latestOccurrence.errorCode");
        latestOccurrence = { scheduledFor: row.latestScheduledFor, outcome: "payload-failed", errorCode: row.latestErrorCode };
    }
    else if (latestOutcome !== null)
        throw invalid("latestOccurrence.outcome");
    return {
        name: String(row.name), expression: String(row.expression), timezone: String(row.effectiveTimezone),
        missedRun: String(row.missedRunPolicy), enabled: Boolean(row.enabled), nextOccurrence: row.nextOccurrence == null ? null : String(row.nextOccurrence), latestOccurrence,
    };
}
function createPrivilegedFileApi(database, contextGetter) {
    return Object.freeze({
        async url(fileReference) {
            const active = activePrivilegedFileAccess(contextGetter);
            if (!active.ok) {
                return active;
            }
            const resolved = await resolvePrivilegedLiveFileReference(database, fileReference);
            if (!resolved.ok) {
                return resolved;
            }
            const row = resolved.row;
            if (!row) {
                return {
                    ok: false,
                    error: createStructuredFileError("File not found.", "Pass the id or absolute File path of a live Capsule file."),
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
        },
        async createPublicUrl(fileReference, options = {}) {
            const active = activePrivilegedFileAccess(contextGetter);
            if (!active.ok) {
                return active;
            }
            const resolved = await resolvePrivilegedLiveFileReference(database, fileReference);
            if (!resolved.ok) {
                return resolved;
            }
            if (!resolved.row) {
                return {
                    ok: false,
                    error: createStructuredFileError("File not found.", "Pass the id or absolute File path of a live Capsule file."),
                };
            }
            return await createPublicFileUrl(database, { userId: resolved.row.ownerId }, resolved.row.id, options);
        },
        async delete(fileReference) {
            const active = activePrivilegedFileAccess(contextGetter);
            if (!active.ok) {
                return active;
            }
            const resolved = await resolvePrivilegedLiveFileReference(database, fileReference);
            if (!resolved.ok) {
                return resolved;
            }
            if (!resolved.row) {
                return {
                    ok: false,
                    error: createStructuredFileError("File not found.", "Pass the id or absolute File path of a live Capsule file."),
                };
            }
            return await deletePrivateFile(database, { userId: resolved.row.ownerId }, resolved.row.id);
        },
        unsupported() {
            const active = activePrivilegedFileAccess(contextGetter);
            if (!active.ok) {
                throw commandError(active.error?.message ?? "Privileged file access is no longer active.", active.error?.hint ?? "Start a new ctx.privileged.run callback before using privileged file operations.", "PRIVILEGED_FILE_ACCESS_INACTIVE");
            }
            throw commandError("Unsupported privileged file operation.", "Use one of the approved privileged file operations: url, createPublicUrl, or delete.", "UNSUPPORTED_PRIVILEGED_FILE_OPERATION");
        },
    });
}
function activePrivilegedFileAccess(contextGetter) {
    if (hasPrivilegedDbAccess(contextGetter?.())) {
        return { ok: true };
    }
    return {
        ok: false,
        error: createStructuredFileError("Privileged file access is no longer active.", "Start a new ctx.privileged.run callback before using privileged file operations."),
    };
}
function privilegedAuthUserId() {
    return "__privileged__";
}
function isReservedAuthUserId(userId) {
    return userId === privilegedAuthUserId();
}
function assertNotReservedAuthUserId(userId) {
    if (!isReservedAuthUserId(userId)) {
        return;
    }
    throw commandError("Reserved auth user ID cannot be used for a real Sporades user.", "Use runtime-generated user IDs for sessions and auth provider links.", "RESERVED_AUTH_USER_ID");
}
export function createPrivilegedAuditLogInput(details = {}) {
    const outcome = normalizePrivilegedAuditOutcome(details.outcome);
    const safeErrorCode = safePrivilegedAuditErrorCode(details.safeErrorCode ?? details.error, outcome);
    const correlation = normalizePrivilegedAuditCorrelation(details.correlation ?? details.correlationId ?? null);
    const release = details.release ?? null;
    const data = {
        schema: PRIVILEGED_AUDIT_SCHEMA,
        actorKind: normalizePrivilegedAuditActorKind(details.actorKind),
        operation: auditString(details.operation, "unknown"),
        surface: auditString(details.surface ?? details.callSite ?? details.apiSurface, "unknown"),
        targetResourceKind: auditString(details.targetResourceKind ?? details.target?.resourceKind, "unknown"),
        outcome,
        safeErrorCode,
        source: auditString(details.source, "runtime"),
        metadata: details.metadata && typeof details.metadata === "object" && !Array.isArray(details.metadata)
            ? details.metadata
            : {},
    };
    return {
        category: "audit",
        event: auditString(details.event, `privileged.${outcome}`),
        level: details.level ?? privilegedAuditLevelForOutcome(outcome),
        message: auditString(details.message, `Privileged audit event ${outcome}: ${data.operation}`),
        data,
        request: details.request ?? null,
        release,
        correlation,
    };
}
function normalizePrivilegedAuditActorKind(value) {
    const candidate = String(value ?? "unknown");
    return PRIVILEGED_AUDIT_ACTOR_KINDS.has(candidate) ? candidate : "unknown";
}
function normalizePrivilegedAuditOutcome(value) {
    const candidate = String(value ?? "started");
    return PRIVILEGED_AUDIT_OUTCOMES.has(candidate) ? candidate : "started";
}
function privilegedAuditLevelForOutcome(outcome) {
    if (outcome === "errored") {
        return "error";
    }
    return "info";
}
function safePrivilegedAuditErrorCode(value, outcome = "started") {
    const source = value && typeof value === "object" && "code" in value ? value.code : value;
    if (source === null || source === undefined || source === "") {
        if (outcome === "errored") {
            return "UNKNOWN_ERROR";
        }
        return null;
    }
    return String(source)
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9_.-]+/g, "_")
        .slice(0, 64) || (outcome === "errored" ? "UNKNOWN_ERROR" : null);
}
function normalizePrivilegedAuditCorrelation(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === "string") {
        return { id: value };
    }
    if (typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    return { id: String(value) };
}
function auditString(value, fallback) {
    const text = value === null || value === undefined ? "" : String(value);
    return text.trim() ? text : fallback;
}
export function createLogEnvelope(input) {
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
        return logDataContainsServerEnvValue(value, serverEnv) || isSensitiveLogString(value) ? logRedactedValue() : value;
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
            isSensitiveLogKey(key)
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
    return values.some((secret) => serialized.includes(String(secret)));
}
function isSensitiveLogKey(key) {
    return (/(^|[-_])(?:password|passwd|token|secret|authorization|cookie|client[-_]?secret|api[-_]?token|private[-_]?key|authorized[-_]?keys?|request[-_]?body|raw[-_]?body|stack(?:trace)?)([-_]|$)/i.test(String(key)) ||
        /(?:password|passwd|token|secret|authorization|cookie|clientSecret|apiToken|privateKey|authorizedKeys|requestBody|rawRequestBody|stackTrace)/i.test(String(key)));
}
function isSensitiveLogString(value) {
    return (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) ||
        /\b(?:ssh-rsa|ssh-ed25519|ecdsa-sha2-[^\s]+)\s+[A-Za-z0-9+/=]{32,}/.test(value) ||
        /(^|\n)\s*at\s+.+:\d+:\d+/.test(value));
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
    if (capped.data.metadata && typeof capped.data.metadata === "object" && !Array.isArray(capped.data.metadata)) {
        for (const key of Object.keys(capped.data.metadata).reverse()) {
            if (Buffer.byteLength(JSON.stringify(capped), "utf8") <= maxBytes) {
                return capped;
            }
            capped.data.metadata[key] = "[TRUNCATED]";
        }
    }
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
export function readJsonlLogEvents(logPath, limit = 200) {
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
export function schemaFromCapsuleDefinition(definition) {
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
            await migrateExistingLibsqlAppTableInTransaction(sqlite, existingTable, table);
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
    await sqlite.withTransaction(async (transaction) => {
        await migrateExistingLibsqlAppTableInTransaction(transaction, existingTable, nextTable);
    });
}
async function migrateExistingLibsqlAppTableInTransaction(sqlite, existingTable, nextTable) {
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
    await sqlite.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(tempTableName)}`);
    await sqlite.createAppTable(nextTable, tempTableName);
    await sqlite.exec(`INSERT INTO ${quoteIdentifier(tempTableName)} (${columns.map(quoteIdentifier).join(", ")}) ` +
        `SELECT ${columns.map((column) => columnSelectExpressionForMigration(existingTable, nextTable, column)).join(", ")} ` +
        `FROM ${quoteIdentifier(nextTable.name)}`);
    await sqlite.exec(`DROP TABLE ${quoteIdentifier(nextTable.name)}`);
    await sqlite.exec(`ALTER TABLE ${quoteIdentifier(tempTableName)} RENAME TO ${quoteIdentifier(nextTable.name)}`);
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
        const builderSource = referenceMatch?.[0] ?? scalarMatch?.[0] ?? "";
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
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const endpoint = database.endpoints.find((candidate) => candidate.method === request.method && candidate.path === requestUrl.pathname);
    if (!endpoint) {
        return false;
    }
    try {
        writeEndpointResult(response, await runEndpoint(database, endpoint, requestUrl, request));
    }
    catch (error) {
        if (error?.sporadesAuthDenialLogData) {
            emitAuthDeniedLog(database, { data: error.sporadesAuthDenialLogData });
        }
        emitHttpFailureLog(database, request, error);
        writeEndpointError(response, error);
    }
    return true;
}
export async function handleFileHttpRoute(database, request, response, websocketHub = null) {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const uploadMatch = requestUrl.pathname.match(/^\/__sporades\/uploads\/([^/]+)$/);
    if (uploadMatch && request.method === "PUT") {
        const result = await completePendingFileUpload(database, uploadMatch[1], request, websocketHub);
        writeJsonHttpResponse(response, result.ok ? 200 : 400, result);
        return true;
    }
    const privateMatch = requestUrl.pathname.match(/^\/__sporades\/files\/private\/([^/]+)$/);
    if (privateMatch && request.method === "GET") {
        const token = request.headers["x-sporades-session-token"];
        const session = await resolveAnonymousSession(database, Array.isArray(token) ? token[0] : (token ?? null));
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
export async function checkRuntimeFileStorage(database) {
    return await database.fileStorage.checkHealth();
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
        "path TEXT NOT NULL, " +
        "name TEXT NOT NULL, " +
        "type TEXT NOT NULL, " +
        "size INTEGER NOT NULL, " +
        "version TEXT NOT NULL, " +
        "status TEXT NOT NULL, " +
        "createdAt TEXT NOT NULL, " +
        "updatedAt TEXT NOT NULL, " +
        "deletedAt TEXT" +
        ")");
    try {
        sqlite.exec("ALTER TABLE sporades_files ADD COLUMN path TEXT");
    }
    catch (error) {
        if (!isDuplicateColumnError(error))
            throw error;
    }
    sqlite.exec(filePathBackfillSql());
    sqlite.exec(activeFilePathDedupeSql());
    sqlite.exec("CREATE INDEX IF NOT EXISTS sporades_files_path_live ON sporades_files (path, deletedAt, status)");
    sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS sporades_files_path_active_unique " +
        "ON sporades_files (path) WHERE deletedAt IS NULL AND status IN ('pending', 'uploaded')");
    sqlite.exec("CREATE TABLE IF NOT EXISTS sporades_file_uploads (" +
        "id TEXT PRIMARY KEY, " +
        "fileId TEXT NOT NULL, " +
        "ownerId TEXT NOT NULL, " +
        "bucketId TEXT NOT NULL, " +
        "bucketName TEXT NOT NULL, " +
        "path TEXT NOT NULL, " +
        "name TEXT NOT NULL, " +
        "type TEXT NOT NULL, " +
        "version TEXT NOT NULL, " +
        "expectedSize INTEGER NOT NULL, " +
        "createdAt TEXT NOT NULL" +
        ")");
    ensureFileUploadTargetColumns(sqlite);
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
    try {
        const bytes = await database.fileStorage.readFileVersion({ fileId: row.id, version: row.version });
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
    if (typeof type !== "string") {
        return "application/octet-stream";
    }
    const normalized = type.split(";")[0].trim().toLowerCase();
    const safeInlineTypes = new Set([
        "text/plain",
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/avif",
        "image/bmp",
    ]);
    return safeInlineTypes.has(normalized) ? normalized : "application/octet-stream";
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
    return await withFileUploadPathLock("capsule", async () => {
        const now = new Date().toISOString();
        const replacing = message.replace === true;
        const replaceReference = message.fileReference ?? message.fileId;
        const resolvedReplacement = replacing ? await resolveLiveFileReference(database, auth.userId, replaceReference) : { ok: true, row: null };
        if (!resolvedReplacement.ok) {
            return resolvedReplacement;
        }
        const existingByReference = resolvedReplacement.row;
        if (replacing && !existingByReference) {
            return {
                ok: false,
                error: createStructuredFileError("File not found.", "Pass the id or absolute File path of a private file owned by the current user."),
            };
        }
        return await database.sqlite.withTransaction(async (sqlite) => {
            const transactionDatabase = { ...database, sqlite, adapter: sqlite };
            let target;
            try {
                target =
                    replacing && existingByReference && (input.path === undefined || input.path === null)
                        ? { bucket: { id: existingByReference.bucketId, name: existingByReference.bucketName }, path: existingByReference.path }
                        : await resolveFileWriteTarget(transactionDatabase, auth.userId, input, now);
            }
            catch (error) {
                return {
                    ok: false,
                    error: createStructuredFileError(error.message, error.hint ?? "Pass a valid absolute File path."),
                };
            }
            const existingByPath = target.path ? await singleActiveFileRowByPath(transactionDatabase, target.path) : null;
            if (existingByPath?.ambiguous) {
                return ambiguousFileReferenceError(target.path);
            }
            if (existingByPath && existingByPath.ownerId !== auth.userId) {
                return {
                    ok: false,
                    error: createStructuredFileError("File path already exists.", "Choose another absolute File path or ask the owning user to delete the existing file first."),
                };
            }
            const pendingByPath = !existingByReference && !existingByPath && target.path
                ? await sqlite.selectPendingFileUploadByPath(target.path)
                : null;
            const existing = existingByReference ?? existingByPath;
            const fileId = existing?.id ?? (pendingByPath?.ownerId === auth.userId ? pendingByPath.fileId : null) ?? randomUUID();
            const uploadId = randomUUID();
            const version = randomUUID();
            const name = normalizeFileName(input.name, target.path);
            const type = String(input.type ?? "application/octet-stream");
            await sqlite.deleteFileUploadsForPath(target.path);
            try {
                await sqlite.insertFileUpload({
                    id: uploadId,
                    fileId,
                    ownerId: auth.userId,
                    bucketId: target.bucket.id,
                    bucketName: target.bucket.name,
                    path: target.path,
                    name,
                    type,
                    version,
                    expectedSize: size,
                    createdAt: now,
                });
            }
            catch (error) {
                if (!isUniqueConstraintError(error))
                    throw error;
                const current = await sqlite.selectPendingFileUploadByPath(target.path);
                if (!current)
                    throw error;
                return {
                    ok: true,
                    data: {
                        uploadUrl: `/__sporades/uploads/${current.id}`,
                        method: "PUT",
                        headers: {},
                        file: fileMetadataFromUpload(current),
                    },
                    error: null,
                };
            }
            return {
                ok: true,
                data: {
                    uploadUrl: `/__sporades/uploads/${uploadId}`,
                    method: "PUT",
                    headers: {},
                    file: fileMetadataFromUpload({
                        fileId,
                        bucketName: target.bucket.name,
                        path: target.path,
                        name,
                        type,
                        expectedSize: size,
                        version,
                    }),
                },
                error: null,
            };
        });
    });
}
export async function completePendingFileUpload(database, uploadId, request, websocketHub = null) {
    const upload = await database.sqlite.selectFileUpload(uploadId);
    if (!upload) {
        return {
            ok: false,
            data: null,
            error: createStructuredFileError("Upload URL not found.", "Request a fresh upload URL from the Sporades client SDK."),
        };
    }
    let wroteFileVersion = false;
    const previousFile = await database.sqlite.selectFileById(upload.fileId);
    try {
        websocketHub?.notifyFileEvent?.(upload.ownerId, {
            type: "file.upload.progress",
            fileId: upload.fileId,
            loaded: 0,
            total: upload.expectedSize,
        });
        const bytes = await readRequestBytes(request, database.fileMaxSizeBytes);
        await database.fileStorage.writeFileVersion({ fileId: upload.fileId, version: upload.version, bytes });
        wroteFileVersion = true;
        const now = new Date().toISOString();
        const completion = await database.sqlite.withTransaction(async (sqlite) => {
            const completed = await sqlite.completeFileUpload(upload, bytes.length, now);
            if (completed?.changes === 0) {
                return { ok: false, superseded: true };
            }
            await sqlite.revokePublicFileUrlsForFile(upload.fileId, now);
            return { ok: true, row: await sqlite.selectFileById(upload.fileId) };
        });
        if (!completion.ok && completion.superseded) {
            await removeFileVersionBestEffort(database, upload.fileId, upload.version);
            return {
                ok: false,
                data: null,
                error: createStructuredFileError("Upload URL was superseded.", "Request a fresh upload URL before retrying this file upload."),
            };
        }
        if (previousFile && previousFile.deletedAt == null && previousFile.status === "uploaded" && previousFile.version !== upload.version) {
            await removeFileVersionBestEffort(database, previousFile.id, previousFile.version);
        }
        const file = fileMetadataFromRow(completion.row);
        websocketHub?.notifyFileEvent?.(upload.ownerId, {
            type: "file.upload.complete",
            file,
        });
        return { ok: true, data: { file }, error: null };
    }
    catch (error) {
        if (wroteFileVersion) {
            await removeFileVersionBestEffort(database, upload.fileId, upload.version);
        }
        const structuredError = isUniqueConstraintError(error)
            ? createStructuredFileError("Upload URL was superseded.", "Request a fresh upload URL before retrying this file upload.")
            : {
                message: error.message,
                hint: error.hint ?? "Request a fresh upload URL and retry.",
            };
        websocketHub?.notifyFileEvent?.(upload.ownerId, {
            type: "file.upload.failed",
            fileId: upload.fileId,
            error: structuredError,
        });
        return {
            ok: false,
            data: null,
            error: structuredError,
        };
    }
}
export async function getPrivateFileUrl(database, auth, fileReference) {
    const resolved = await resolveLiveFileReference(database, auth.userId, fileReference);
    if (!resolved.ok) {
        return resolved;
    }
    const row = resolved.row;
    if (!row) {
        return {
            ok: false,
            error: createStructuredFileError("File not found.", "Pass the id or absolute File path of a private file owned by the current user."),
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
export async function createPublicFileUrl(database, auth, fileReference, options = {}) {
    const expiry = validatePublicUrlExpiry(options);
    if (!expiry.ok) {
        return expiry;
    }
    return await runFileMetadataTransaction(database, async (sqlite) => {
        const transactionDatabase = { ...database, sqlite, adapter: sqlite };
        const resolved = await resolveLiveFileReference(transactionDatabase, auth.userId, fileReference);
        if (!resolved.ok) {
            return resolved;
        }
        const row = resolved.row;
        if (!row) {
            return {
                ok: false,
                error: createStructuredFileError("File not found.", "Pass the id or absolute File path of a private file owned by the current user."),
            };
        }
        const id = randomUUID();
        const now = new Date().toISOString();
        await sqlite.insertPublicFileUrl({
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
    });
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
export async function deletePrivateFile(database, auth, fileReference) {
    const now = new Date().toISOString();
    const result = await runFileMetadataTransaction(database, async (sqlite) => {
        const transactionDatabase = { ...database, sqlite, adapter: sqlite };
        const resolved = await resolveLiveFileReference(transactionDatabase, auth.userId, fileReference);
        if (!resolved.ok) {
            return resolved;
        }
        const row = resolved.row;
        if (!row) {
            return {
                ok: false,
                error: createStructuredFileError("File not found.", "Pass the id or absolute File path of a private file owned by the current user."),
            };
        }
        await sqlite.deleteFileUploadsForFile(auth.userId, row.id);
        await sqlite.deleteFileUploadsForPath(row.path);
        await sqlite.markFileDeleted(row.id, now);
        await sqlite.revokePublicFileUrlsForFile(row.id, now);
        return {
            ok: true,
            data: { file: fileMetadataFromRow({ ...row, deletedAt: now }) },
            error: null,
            deletedFile: row,
        };
    });
    if (!result.ok) {
        return result;
    }
    await removeFileVersionBestEffort(database, result.deletedFile.id, result.deletedFile.version);
    return {
        ok: true,
        data: result.data,
        error: null,
    };
}
async function runFileMetadataTransaction(database, fn) {
    if (database.__transactionActive) {
        return await fn(database.sqlite);
    }
    return await database.sqlite.withTransaction(fn);
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
    const reference = String(fileId ?? "");
    if (isAbsoluteFilePath(reference)) {
        const resolved = await resolveLiveFileReference(database, ownerId, reference);
        return resolved.ok ? resolved.row : null;
    }
    return await database.sqlite.fileRowForOwner(reference, ownerId);
}
function fileMetadataFromRow(row) {
    return {
        id: row.id,
        bucket: row.bucketName,
        size: Number(row.size),
        type: row.type,
        name: row.name,
        path: row.path,
        version: row.version,
    };
}
function fileMetadataFromUpload(upload) {
    return {
        id: upload.fileId,
        bucket: upload.bucketName,
        size: Number(upload.expectedSize),
        type: upload.type,
        name: upload.name,
        path: upload.path,
        version: upload.version,
    };
}
async function withFileUploadPathLock(path, fn) {
    const fileUploadPathLocks = (globalThis.__sporadesFileUploadPathLocks ??= new Map());
    const key = String(path);
    const previous = fileUploadPathLocks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
        release = resolve;
    });
    const next = previous.then(() => current, () => current);
    fileUploadPathLocks.set(key, next);
    try {
        await previous.catch(() => { });
        return await fn();
    }
    finally {
        release?.();
        if (fileUploadPathLocks.get(key) === next) {
            fileUploadPathLocks.delete(key);
        }
    }
}
async function resolveFileWriteTarget(database, ownerId, input, now) {
    const explicitPath = input.path === undefined || input.path === null ? null : normalizeAbsoluteFilePath(input.path);
    const path = explicitPath ?? `/default/${normalizeFileName(input.name, null)}`;
    const firstSegment = path.split("/").filter(Boolean)[0] ?? "default";
    const existingBucket = await database.sqlite.findFileBucket(ownerId, firstSegment);
    const bucket = existingBucket ?? (await ensureFileBucket(database, ownerId, "default", now));
    return { bucket, path };
}
async function ensureFileBucket(database, ownerId, name, now) {
    const existing = await database.sqlite.findFileBucket(ownerId, name);
    if (existing)
        return existing;
    const bucket = { id: randomUUID(), ownerId, name, createdAt: now };
    try {
        await database.sqlite.createFileBucket(bucket);
        return bucket;
    }
    catch (error) {
        if (!isUniqueConstraintError(error))
            throw error;
        const raced = await database.sqlite.findFileBucket(ownerId, name);
        if (raced)
            return raced;
        throw error;
    }
}
function normalizeAbsoluteFilePath(value) {
    const raw = String(value ?? "").trim();
    if (!raw.startsWith("/")) {
        throw structuredFileException("Invalid File path.", "Pass an absolute Capsule-scoped File path that starts with '/'.");
    }
    const segments = raw.split("/").filter(Boolean);
    if (segments.length === 0) {
        throw structuredFileException("Invalid File path.", "Pass an absolute Capsule-scoped File path with a file name.");
    }
    return `/${segments.join("/")}`;
}
function normalizeFileName(name, filePath) {
    const candidate = String(name ?? "").trim();
    if (candidate)
        return candidate;
    const pathName = filePath?.split("/").filter(Boolean).at(-1);
    return pathName || "upload";
}
function isAbsoluteFilePath(value) {
    return typeof value === "string" && value.startsWith("/");
}
async function resolveLiveFileReference(database, ownerId, reference) {
    const value = String(reference ?? "");
    if (isAbsoluteFilePath(value)) {
        let path;
        try {
            path = normalizeAbsoluteFilePath(value);
        }
        catch {
            return { ok: true, row: null };
        }
        const resolved = await singleLiveFileRowByPath(database, path);
        if (resolved?.ambiguous) {
            return ambiguousFileReferenceError(value);
        }
        return { ok: true, row: resolved?.ownerId === ownerId ? resolved : null };
    }
    return { ok: true, row: await database.sqlite.fileRowForOwner(value, ownerId) };
}
async function resolvePrivilegedLiveFileReference(database, reference) {
    const value = String(reference ?? "");
    if (isAbsoluteFilePath(value)) {
        let path;
        try {
            path = normalizeAbsoluteFilePath(value);
        }
        catch {
            return { ok: true, row: null };
        }
        const resolved = await singleLiveFileRowByPath(database, path);
        if (resolved?.ambiguous) {
            return ambiguousFileReferenceError(value);
        }
        return { ok: true, row: resolved };
    }
    const row = await database.sqlite.selectFileById(value);
    if (!row || row.deletedAt !== null || row.status !== "uploaded") {
        return { ok: true, row: null };
    }
    return { ok: true, row };
}
function singleLiveFileRowByPath(database, path) {
    return thenIfPromise(database.sqlite.selectLiveFileByPath(path), (rows) => {
        if (rows.length > 1)
            return { ambiguous: true };
        return rows[0] ?? null;
    });
}
function singleActiveFileRowByPath(database, path) {
    return thenIfPromise(database.sqlite.selectActiveFileByPath(path), (rows) => {
        if (rows.length > 1)
            return { ambiguous: true };
        return rows[0] ?? null;
    });
}
function ambiguousFileReferenceError(reference) {
    return {
        ok: false,
        error: createStructuredFileError("File reference is ambiguous.", `The File reference ${reference} must resolve to exactly one live file before this operation can proceed.`),
    };
}
function structuredFileException(message, hint) {
    const error = new Error(message);
    error.hint = hint;
    return error;
}
function isDuplicateColumnError(error) {
    const text = [error?.message, error?.stdout, error?.stderr, error].map((value) => String(value ?? "")).join("\n");
    return /duplicate column|already exists/i.test(text);
}
function isUniqueConstraintError(error) {
    const text = [error?.message, error?.stdout, error?.stderr, error].map((value) => String(value ?? "")).join("\n");
    return /unique constraint|duplicate key|constraint failed/i.test(text);
}
function filePathBackfillSql() {
    return ("UPDATE sporades_files SET path = CASE " +
        "WHEN (SELECT COUNT(*) FROM sporades_files AS matching " +
        "WHERE matching.ownerId = sporades_files.ownerId " +
        "AND matching.bucketName = sporades_files.bucketName " +
        "AND matching.name = sporades_files.name " +
        "AND matching.deletedAt IS NULL " +
        "AND matching.status IN ('pending', 'uploaded')) = 1 " +
        "THEN '/' || bucketName || '/' || name " +
        "ELSE '/' || bucketName || '/' || id || '/' || name END " +
        "WHERE path IS NULL OR path = ''");
}
function activeFilePathDedupeSql() {
    return ("UPDATE sporades_files SET deletedAt = COALESCE(deletedAt, updatedAt), updatedAt = updatedAt " +
        "WHERE deletedAt IS NULL AND status IN ('pending', 'uploaded') AND id NOT IN (" +
        "SELECT MAX(id) FROM sporades_files " +
        "WHERE deletedAt IS NULL AND status IN ('pending', 'uploaded') " +
        "GROUP BY path" +
        ")");
}
function ensureFileUploadTargetColumns(sqlite) {
    const statements = [
        "ALTER TABLE sporades_file_uploads ADD COLUMN bucketId TEXT",
        "ALTER TABLE sporades_file_uploads ADD COLUMN bucketName TEXT",
        "ALTER TABLE sporades_file_uploads ADD COLUMN path TEXT",
        "ALTER TABLE sporades_file_uploads ADD COLUMN name TEXT",
        "ALTER TABLE sporades_file_uploads ADD COLUMN type TEXT",
        "UPDATE sporades_file_uploads SET " +
            "bucketId = COALESCE(bucketId, (SELECT bucketId FROM sporades_files WHERE sporades_files.id = sporades_file_uploads.fileId)), " +
            "bucketName = COALESCE(bucketName, (SELECT bucketName FROM sporades_files WHERE sporades_files.id = sporades_file_uploads.fileId)), " +
            "path = COALESCE(path, (SELECT path FROM sporades_files WHERE sporades_files.id = sporades_file_uploads.fileId)), " +
            "name = COALESCE(name, (SELECT name FROM sporades_files WHERE sporades_files.id = sporades_file_uploads.fileId)), " +
            "type = COALESCE(type, (SELECT type FROM sporades_files WHERE sporades_files.id = sporades_file_uploads.fileId)) " +
            "WHERE path IS NULL OR path = ''",
        "DELETE FROM sporades_file_uploads WHERE id NOT IN (" +
            "SELECT MAX(id) FROM sporades_file_uploads GROUP BY path" +
            ")",
        "CREATE INDEX IF NOT EXISTS sporades_file_uploads_path ON sporades_file_uploads (path)",
        "CREATE UNIQUE INDEX IF NOT EXISTS sporades_file_uploads_path_unique ON sporades_file_uploads (path)",
    ];
    let chain = undefined;
    for (const statement of statements) {
        const operation = () => statement.startsWith("ALTER TABLE")
            ? runSchemaExecIgnoringDuplicateColumn(sqlite, statement)
            : sqlite.exec(statement);
        chain = chainSchemaOperation(chain, operation);
    }
    return chain;
}
function runSchemaExecIgnoringDuplicateColumn(sqlite, sql) {
    try {
        const result = sqlite.exec(sql);
        if (isPromiseLike(result)) {
            return result.catch((error) => {
                if (!isDuplicateColumnError(error))
                    throw error;
            });
        }
        return result;
    }
    catch (error) {
        if (!isDuplicateColumnError(error))
            throw error;
        return undefined;
    }
}
function chainSchemaOperation(previous, operation) {
    if (isPromiseLike(previous)) {
        return previous.then(operation);
    }
    return operation();
}
function createStructuredFileError(message, hint) {
    return { message, hint };
}
async function removeFileVersionBestEffort(database, fileId, version) {
    await database.fileStorage.deleteFileVersion({ fileId, version }).catch(() => { });
}
async function runEndpoint(database, endpoint, requestUrl, request) {
    const createHandler = new Function(`return (${endpoint.handlerSource});`);
    const handler = createHandler();
    const endpointRequest = await readEndpointRequest(database, requestUrl, request);
    const session = await resolveAnonymousSession(database, readEndpointSessionToken(endpointRequest.headers, endpointRequest.query));
    let context;
    try {
        const result = await (database.adapter ?? database.sqlite).withTransaction(async (transactionAdapter) => {
            const transactionDatabase = createTransactionDatabase(database, transactionAdapter);
            context = await applyContextMiddleware(transactionDatabase, createEndpointContext(transactionDatabase, endpointRequest, session), "endpoint");
            try {
                return await handler(context);
            }
            finally {
                await drainPendingAclWrites(context);
                transactionDatabase.rowCache.clear();
            }
        });
        await flushPendingJobEnqueues(context);
        return result;
    }
    catch (error) {
        await flushPendingJobEnqueues(context);
        throw error;
    }
}
function createTransactionDatabase(database, transactionAdapter) {
    return transactionAdapter
        ? { ...database, adapter: transactionAdapter, sqlite: transactionAdapter, __transactionActive: true, __rootDatabase: database.__rootDatabase ?? database }
        : database;
}
async function readEndpointRequest(database, requestUrl, request) {
    const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [
        name.toLowerCase(),
        Array.isArray(value) ? value.join(", ") : value,
    ]));
    const query = endpointQueryFromUrl(requestUrl);
    return {
        method: request.method,
        path: requestUrl.pathname,
        headers,
        query,
        body: await readEndpointBody(request, headers, database),
    };
}
function createEndpointContext(database, endpointRequest, session) {
    const context = {
        auth: session.auth,
        env: database.serverEnv,
        log: createEndpointLogger(database, {
            request: {
                method: endpointRequest.method,
                path: endpointRequest.path,
            },
        }),
        request: {
            method: endpointRequest.method,
            path: endpointRequest.path,
            headers: endpointRequest.headers,
            query: endpointRequest.query,
            body: endpointRequest.body,
        },
    };
    const holder = createContextHolder(context);
    context.db = createEndpointDatabaseApi(database, () => holder.current);
    context.privileged = createContextPrivilegedApi(database, () => holder.current);
    context.jobs = createCurrentUserJobApi(database, () => holder.current);
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
    const { db, privileged, jobs, request, __pendingAclWrites, __sporadesContextHolder, ...aclContext } = context ?? {};
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
    return headers["x-sporades-session-token"] ?? null;
}
function endpointQueryFromUrl(requestUrl) {
    const query = {};
    for (const [name, value] of requestUrl.searchParams.entries()) {
        if (name === "sessionToken") {
            continue;
        }
        query[name] = value;
    }
    return query;
}
function privilegedDbAccessContextSet() {
    const holder = privilegedDbAccessContextSet;
    if (!holder.contexts) {
        Object.defineProperty(holder, "contexts", {
            value: new WeakSet(),
            enumerable: false,
            configurable: false,
        });
    }
    return holder.contexts;
}
function grantPrivilegedDbAccess(context) {
    if (context && typeof context === "object") {
        privilegedDbAccessContextSet().add(context);
    }
    return context;
}
function revokePrivilegedDbAccess(context) {
    if (context && typeof context === "object") {
        privilegedDbAccessContextSet().delete(context);
    }
    return context;
}
function hasPrivilegedDbAccess(context) {
    return Boolean(context && typeof context === "object" && privilegedDbAccessContextSet().has(context));
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
            const fieldValues = table.fields.map((field) => fieldValueForWrite(database, field, Object.hasOwn(values, String(field.name)) && values[String(field.name)] !== undefined ? values[String(field.name)] : field.defaultValue));
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
    if (hasPrivilegedDbAccess(contextGetter?.())) {
        return write();
    }
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
    const aclContext = createTableAclContext(context, database);
    const result = rule({
        ctx: aclContext,
        operation,
        table: table.name,
        previous,
        next,
    });
    if (!isPromiseLike(result)) {
        if (!result || aclRuleTouchedAsyncHelperRead(aclContext)) {
            deny();
        }
        return write();
    }
    const pending = Promise.resolve(result).then((allowed) => {
        if (!allowed || aclRuleTouchedAsyncHelperRead(aclContext)) {
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
    if (hasPrivilegedDbAccess(context)) {
        return true;
    }
    const rule = table.acl?.resolve?.("read");
    if (!rule) {
        return true;
    }
    const aclContext = createTableAclContext(context, database);
    const result = rule({
        ctx: aclContext,
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
        return result && !aclRuleTouchedAsyncHelperRead(aclContext) ? true : deny();
    }
    return Promise.resolve(result).then((allowed) => (allowed && !aclRuleTouchedAsyncHelperRead(aclContext) ? true : deny()));
}
function filterRowsByReadAcl(database, table, rows, context) {
    const decisions = rows.map((row) => applyReadAcl(database, table, row, context));
    if (decisions.some(isPromiseLike)) {
        return Promise.all(decisions).then((resolved) => rows.filter((_, index) => resolved[index]));
    }
    return rows.filter((_, index) => decisions[index]);
}
const ACL_HELPER_STATE = Symbol("sporades.aclHelperState");
function createAclHelpers(database) {
    const state = { readCount: 0, maxReads: 32, touchedAsyncRead: false };
    const helpers = {
        db: createAclDbHelpers(database, state),
        storage: createAclStorageHelpers(database, state),
    };
    Object.defineProperty(helpers, ACL_HELPER_STATE, {
        value: state,
        enumerable: false,
    });
    return Object.freeze(helpers);
}
function aclRuleTouchedAsyncHelperRead(aclContext) {
    return aclContext?.acl?.[ACL_HELPER_STATE]?.touchedAsyncRead === true;
}
function markAsyncAclHelperRead(state, result) {
    if (isPromiseLike(result)) {
        state.touchedAsyncRead = true;
        Promise.resolve(result).catch(() => { });
        return true;
    }
    return false;
}
function createAclDbHelpers(database, state) {
    return Object.freeze({
        get(tableName, id) {
            assertAclHelperReadAllowed(state);
            const table = resolveAclAppTable(database, tableName);
            const selected = database.sqlite.selectAppRowById(table, id);
            if (markAsyncAclHelperRead(state, selected)) {
                return null;
            }
            return selected ? deserializeRow(table, selected) : null;
        },
        exists(tableName, id) {
            assertAclHelperReadAllowed(state);
            const table = resolveAclAppTable(database, tableName);
            const selected = database.sqlite.selectAppRowById(table, id);
            if (markAsyncAclHelperRead(state, selected)) {
                return false;
            }
            return Boolean(selected);
        },
    });
}
function createAclStorageHelpers(database, state) {
    return Object.freeze({
        get(resourceName, reference) {
            assertAclHelperReadAllowed(state);
            const resource = resolveAclStorageResource(resourceName);
            if (resource === "files") {
                const row = resolveAclStorageFileReference(database, state, reference);
                return row ? aclStorageMetadataFromFileRow(row) : null;
            }
            return null;
        },
        exists(resourceName, reference) {
            assertAclHelperReadAllowed(state);
            const resource = resolveAclStorageResource(resourceName);
            if (resource === "files") {
                return Boolean(resolveAclStorageFileReference(database, state, reference));
            }
            return false;
        },
    });
}
function resolveAclStorageFileReference(database, state, reference) {
    const value = String(reference ?? "");
    if (isAbsoluteFilePath(value)) {
        let path;
        try {
            path = normalizeAbsoluteFilePath(value);
        }
        catch {
            return null;
        }
        const selected = database.sqlite.selectLiveFileByPath(path);
        if (markAsyncAclHelperRead(state, selected)) {
            return null;
        }
        const resolved = selected.length > 1 ? { ambiguous: true } : (selected[0] ?? null);
        return resolved?.ambiguous ? null : resolved;
    }
    const selected = database.sqlite.selectFileById(value);
    if (markAsyncAclHelperRead(state, selected)) {
        return null;
    }
    if (!selected || selected.deletedAt !== null || selected.status !== "uploaded") {
        return null;
    }
    return selected;
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
        originalName: row.name,
        owner: row.ownerId,
        ownerId: row.ownerId,
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
function requireAuth(context, options = {}) {
    const linked = options?.linked === true;
    const auth = context?.auth;
    if (auth?.isAuthenticated === true && (!linked || auth.isGuest !== true)) {
        return auth;
    }
    throw createUnauthenticatedError(createAuthDenialLogData(context, linked ? "linked" : "authenticated"));
}
function createUnauthenticatedError(logData = null) {
    const error = commandError("Unauthenticated.", "Sign in and retry the request.", "UNAUTHENTICATED");
    if (logData) {
        error.sporadesAuthDenialLogData = logData;
    }
    return error;
}
function createAuthDenialLogData(context, requirement) {
    return {
        requirement,
        handler: {
            kind: context?.kind ?? null,
        },
        actor: {
            userId: context?.auth?.userId ?? null,
            provider: context?.auth?.provider ?? null,
            isAuthenticated: context?.auth?.isAuthenticated ?? null,
            isGuest: context?.auth?.isGuest ?? null,
        },
    };
}
function emitAuthDeniedLog(database, details) {
    database.log?.emit?.({
        category: "platform",
        event: "auth.denied",
        level: "warn",
        message: "requireAuth denied an unauthenticated handler request.",
        data: details.data ?? null,
    });
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
    let context;
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
async function readEndpointBody(request, headers, limitSource = null) {
    const raw = (await readLimitedRequestBody(request, limitSource)).toString("utf8");
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
    response.writeHead(error?.code === "UNAUTHENTICATED" ? 401 : isPayloadTooLargeError(error) ? 413 : 500, { "content-type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify({
        ok: false,
        data: null,
        error: {
            ...(error?.code ? { code: error.code } : {}),
            message: isPayloadTooLargeError(error)
                ? error.message
                : error?.hint
                    ? error.message
                    : error?.sporadesEndpointResponse
                        ? "Invalid endpoint response."
                        : "Endpoint handler failed.",
            hint: error?.sporadesEndpointResponse
                ? "Return { status, headers, body } with a numeric status, plain object headers, and a serializable body."
                : isPayloadTooLargeError(error)
                    ? error.hint
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
export function validateReadOnlyInspectionSql(sql) {
    const text = String(sql ?? "");
    const firstToken = readFirstSqlToken(text);
    if (!firstToken || hasMultipleSqlStatements(text)) {
        return readOnlyInspectionSqlError();
    }
    const keyword = firstToken.toLowerCase();
    if (keyword === "pragma") {
        return isSafeInspectionPragma(text, firstToken.length) ? { ok: true } : readOnlyInspectionSqlError();
    }
    if ((keyword === "select" || keyword === "with") && !containsSideEffectSqlToken(text)) {
        return { ok: true };
    }
    return readOnlyInspectionSqlError();
}
function readOnlyInspectionSqlError() {
    return {
        ok: false,
        data: null,
        error: {
            message: "Only read-only SQL is allowed.",
            hint: "Use a SELECT, WITH, or safe metadata PRAGMA query for `sporades db query`.",
        },
    };
}
function readFirstSqlToken(sql) {
    const index = skipSqlTrivia(sql, 0);
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(index));
    return match?.[0] ?? null;
}
function hasMultipleSqlStatements(sql) {
    let index = 0;
    while (index < sql.length) {
        const skipped = skipSqlStringOrComment(sql, index);
        if (skipped > index) {
            index = skipped;
            continue;
        }
        if (sql[index] === ";") {
            return skipSqlTrivia(sql, index + 1) < sql.length;
        }
        index += 1;
    }
    return false;
}
function isSafeInspectionPragma(sql, pragmaTokenLength) {
    let index = skipSqlTrivia(sql, skipSqlTrivia(sql, 0) + pragmaTokenLength);
    let identifier = readBareSqlIdentifier(sql, index);
    if (!identifier) {
        return false;
    }
    let pragmaName = identifier.value.toLowerCase();
    index = skipSqlTrivia(sql, identifier.nextIndex);
    if (sql[index] === ".") {
        identifier = readBareSqlIdentifier(sql, skipSqlTrivia(sql, index + 1));
        if (!identifier) {
            return false;
        }
        pragmaName = identifier.value.toLowerCase();
        index = skipSqlTrivia(sql, identifier.nextIndex);
    }
    if (!SAFE_INSPECTION_PRAGMAS.has(pragmaName)) {
        return false;
    }
    while (index < sql.length) {
        const skipped = skipSqlStringOrComment(sql, index);
        if (skipped > index) {
            index = skipped;
            continue;
        }
        if (sql[index] === "=") {
            return false;
        }
        index += 1;
    }
    return true;
}
const SAFE_INSPECTION_PRAGMAS = new Set([
    "database_list",
    "foreign_key_list",
    "index_info",
    "index_list",
    "index_xinfo",
    "table_info",
    "table_list",
    "table_xinfo",
]);
function containsSideEffectSqlToken(sql) {
    for (const token of readSqlTokens(sql)) {
        const value = token.value.toLowerCase();
        if (SIDE_EFFECT_SQL_KEYWORDS.has(value)) {
            return true;
        }
        if (SIDE_EFFECT_SQL_FUNCTIONS.has(value) && sql[skipSqlTrivia(sql, token.nextIndex)] === "(") {
            return true;
        }
    }
    return false;
}
const SIDE_EFFECT_SQL_KEYWORDS = new Set([
    "alter",
    "analyze",
    "attach",
    "create",
    "delete",
    "detach",
    "drop",
    "insert",
    "reindex",
    "replace",
    "update",
    "vacuum",
]);
const SIDE_EFFECT_SQL_FUNCTIONS = new Set([
    "load_extension",
    "nextval",
    "set_config",
    "setval",
]);
function readSqlTokens(sql) {
    const tokens = [];
    let index = 0;
    while (index < sql.length) {
        const skipped = skipSqlLiteralOrComment(sql, index);
        if (skipped > index) {
            index = skipped;
            continue;
        }
        const identifier = readSqlTokenIdentifier(sql, index);
        if (identifier) {
            tokens.push(identifier);
            index = identifier.nextIndex;
            continue;
        }
        index += 1;
    }
    return tokens;
}
function readBareSqlIdentifier(sql, index) {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(index));
    return match ? { value: match[0], nextIndex: index + match[0].length } : null;
}
function readSqlTokenIdentifier(sql, index) {
    const quote = sql[index];
    const closingQuote = quote === "[" ? "]" : quote;
    if (quote === '"' || quote === "`" || quote === "[") {
        let value = "";
        let cursor = index + 1;
        while (cursor < sql.length) {
            if (sql[cursor] === closingQuote) {
                if (quote !== "[" && sql[cursor + 1] === closingQuote) {
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
    return readBareSqlIdentifier(sql, index);
}
function skipSqlLiteralOrComment(sql, index) {
    if (sql[index] === "/" && sql[index + 1] === "*") {
        const end = sql.indexOf("*/", index + 2);
        return end === -1 ? sql.length : end + 2;
    }
    if (sql[index] === "-" && sql[index + 1] === "-") {
        const end = sql.indexOf("\n", index + 2);
        return end === -1 ? sql.length : end + 1;
    }
    if (sql[index] !== "'") {
        return index;
    }
    let cursor = index + 1;
    while (cursor < sql.length) {
        if (sql[cursor] === "'") {
            if (sql[cursor + 1] === "'") {
                cursor += 2;
                continue;
            }
            return cursor + 1;
        }
        cursor += 1;
    }
    return sql.length;
}
function skipSqlStringOrComment(sql, index) {
    if (sql[index] === "/" && sql[index + 1] === "*") {
        const end = sql.indexOf("*/", index + 2);
        return end === -1 ? sql.length : end + 2;
    }
    if (sql[index] === "-" && sql[index + 1] === "-") {
        const end = sql.indexOf("\n", index + 2);
        return end === -1 ? sql.length : end + 1;
    }
    const quote = sql[index];
    const closingQuote = quote === "[" ? "]" : quote;
    if (quote !== "'" && quote !== '"' && quote !== "`" && quote !== "[") {
        return index;
    }
    let cursor = index + 1;
    while (cursor < sql.length) {
        if (sql[cursor] === closingQuote) {
            if (quote !== "[" && sql[cursor + 1] === closingQuote) {
                cursor += 2;
                continue;
            }
            return cursor + 1;
        }
        cursor += 1;
    }
    return sql.length;
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
    const token = createSessionToken();
    return await database.sqlite.withTransaction(async (tx) => {
        const existing = await tx.findAuthUserByProviderEmail(provider, email);
        const userId = existing?.id ?? randomUUID();
        if (existing) {
            await tx.updateAuthUserProfile({ id: userId, displayName, picture, isAuthenticated: 1, isGuest: 0 });
        }
        else {
            await tx.insertAuthUser({
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
        await tx.insertAuthSession({ token, userId, createdAt: now, expiresAt: sessionExpiresAt(now) });
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
    });
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
    const connectionTokens = new Map();
    let nextClientId = 1;
    const connectionTokenTtlMs = 4 * 60 * 60 * 1000;
    return {
        createConnectionToken() {
            pruneConnectionTokens();
            const token = randomBytes(32).toString("base64url");
            connectionTokens.set(token, Date.now() + connectionTokenTtlMs);
            return token;
        },
        async accept(request, socket) {
            const key = request.headers["sec-websocket-key"];
            if (!key) {
                socket.destroy();
                return;
            }
            const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
            if (!validateConnectionToken(requestUrl.searchParams.get("connectionToken"))) {
                socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
                socket.destroy();
                return;
            }
            const database = getDatabase();
            const policy = database.securityPolicy ?? resolveRuntimeSecurityPolicy({});
            if (!websocketOriginAllowed(policy, request)) {
                socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
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
            const origin = requestOrigin(request);
            const now = new Date().toISOString();
            const client = {
                id: `client-${(nextClientId++).toString(36)}`,
                socket,
                buffer: Buffer.alloc(0),
                messageQueue: Promise.resolve(),
                subscriptions: new Map(),
                session: createPendingWebSocketSession(),
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
                closeWebSocketClient(client);
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
    function pruneConnectionTokens() {
        const now = Date.now();
        for (const [token, expiresAt] of connectionTokens) {
            if (expiresAt <= now) {
                connectionTokens.delete(token);
            }
        }
    }
    function validateConnectionToken(token) {
        pruneConnectionTokens();
        if (!token) {
            return false;
        }
        const expiresAt = connectionTokens.get(token);
        return Boolean(expiresAt && expiresAt > Date.now());
    }
    function createPendingWebSocketSession() {
        return {
            token: null,
            auth: {
                userId: null,
                displayName: "Anonymous",
                email: null,
                picture: null,
                isAuthenticated: false,
                isGuest: true,
                provider: "anonymous",
            },
        };
    }
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
            userId: auth?.userId ?? null,
            displayName: auth?.displayName ?? null,
            email: auth?.email ?? null,
            picture: auth?.picture ?? null,
            isAuthenticated: Boolean(auth?.isAuthenticated),
            isGuest: auth?.isGuest ?? true,
            provider: auth?.provider ?? "anonymous",
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
        const messageSessionToken = typeof message.sessionToken === "string" && message.sessionToken.length > 0 ? message.sessionToken : client.session.token;
        client.session = await resolveAnonymousSession(database, messageSessionToken ?? null);
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
        if (message.type === "preferences.get") {
            const result = await readCurrentUserPreferences(database, client.session.auth);
            sendJson(client, {
                id: message.id ?? null,
                type: "preferences.result",
                data: result.data,
                error: result.error,
            });
            return;
        }
        if (message.type === "preferences.update") {
            const result = await updateCurrentUserPreferences(database, client.session.auth, message.patch);
            sendJson(client, {
                id: message.id ?? null,
                type: result.ok ? "preferences.result" : "error",
                data: result.data,
                error: result.error,
            });
            if (result.ok && result.data) {
                notifyPreferencesUpdated(client, {
                    preferences: result.data.preferences,
                    changes: result.changes,
                });
            }
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
            const result = await getPrivateFileUrl(database, client.session.auth, message.fileReference ?? message.fileId);
            sendJson(client, {
                id: message.id ?? null,
                type: result.ok ? "file.url.result" : "error",
                data: result.data ?? null,
                error: result.error,
            });
            return;
        }
        if (message.type === "file.publicUrl.create") {
            const result = await createPublicFileUrl(database, client.session.auth, message.fileReference ?? message.fileId, message.options ?? {});
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
            const result = await deletePrivateFile(database, client.session.auth, message.fileReference ?? message.fileId);
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
    function notifyPreferencesUpdated(sender, data) {
        for (const client of clients) {
            if (client === sender || client.session.auth.userId !== sender.session.auth.userId) {
                continue;
            }
            sendJson(client, {
                id: null,
                type: "preferences.updated",
                data,
                error: null,
            });
        }
    }
}
export async function routeSporadesAuth(database, request, response) {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
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
            throw commandError(result.error?.message, result.error?.hint ?? "Retry Google sign-in from the app.");
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
    return await database.sqlite.withTransaction(async (tx) => {
        const existingUser = await tx.findAuthUserByProviderEmail("google", profile.email);
        const auth = {
            userId: existingUser?.id ?? session.auth.userId,
            displayName: profile.displayName ?? profile.email,
            email: profile.email,
            picture: profile.picture ?? null,
            isAuthenticated: true,
            isGuest: false,
            provider: "google",
        };
        if (session.auth.isGuest && existingUser?.id && existingUser.id !== session.auth.userId) {
            await tx.linkAuthUser({
                id: auth.userId,
                displayName: auth.displayName,
                email: auth.email,
                picture: auth.picture,
                isAuthenticated: 1,
                isGuest: 0,
                provider: "google",
            });
            await moveSessionToUserOnAdapter(database, tx, session, auth.userId);
            return { ok: true, auth };
        }
        await tx.linkAuthUser({
            id: auth.userId,
            displayName: auth.displayName,
            email: auth.email,
            picture: auth.picture,
            isAuthenticated: 1,
            isGuest: 0,
            provider: "google",
        });
        await refreshSessionOnAdapter(tx, session.token);
        return { ok: true, auth };
    });
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
    return await database.sqlite.withTransaction(async (tx) => {
        await tx.insertEmailCredential({
            email: normalized.email,
            userId: auth.userId,
            passwordHash: password.hash,
            passwordSalt: password.salt,
            createdAt: new Date().toISOString(),
        });
        await tx.linkAuthUser({
            id: auth.userId,
            displayName: auth.displayName,
            email: auth.email,
            picture: auth.picture,
            isAuthenticated: 1,
            isGuest: 0,
            provider: "email",
        });
        return { ok: true, sessionToken: await rotateSessionOnAdapter(database, tx, session, auth.userId), auth };
    });
}
export async function signInWithEmail(database, session, credentials) {
    if (!database.authConfig.providers.email.enabled) {
        return { ok: false, error: emailAuthDisabledError() };
    }
    const normalized = normalizeEmailCredentials(credentials);
    if (!normalized.ok) {
        return normalized;
    }
    const throttle = currentEmailSignInThrottleState(database, normalized.email, session);
    if (throttle.throttled) {
        return { ok: false, error: invalidEmailCredentialsError({ code: "INVALID_EMAIL_CREDENTIALS" }) };
    }
    const row = await database.sqlite.findEmailCredentialWithUser(normalized.email);
    if (!row || !verifyEmailPassword(normalized.password, row.passwordSalt, row.passwordHash)) {
        recordFailedEmailSignInAttempt(database, normalized.email, session);
        return { ok: false, error: invalidEmailCredentialsError() };
    }
    resetEmailSignInAttempts(database, normalized.email, session);
    const auth = {
        userId: row.userId,
        displayName: row.displayName,
        email: row.email,
        picture: row.picture,
        isAuthenticated: Boolean(row.isAuthenticated),
        isGuest: Boolean(row.isGuest),
        provider: row.provider,
    };
    return await database.sqlite.withTransaction(async (tx) => ({
        ok: true,
        sessionToken: await rotateSessionOnAdapter(database, tx, session, auth.userId),
        auth,
    }));
}
function createEmailSignInThrottleState(database) {
    const existing = database.__emailSignInThrottle;
    if (existing instanceof Map) {
        return existing;
    }
    const next = new Map();
    database.__emailSignInThrottle = next;
    return next;
}
function emailSignInThrottleKeys(email, session) {
    return [`email\0${email}`, `caller\0${callerContextKey(session)}`];
}
function currentEmailSignInThrottleState(database, email, session) {
    const attempts = createEmailSignInThrottleState(database);
    const now = Date.now();
    pruneEmailSignInThrottleState(attempts, now);
    const keys = emailSignInThrottleKeys(email, session);
    const entries = keys.map((key) => {
        const current = attempts.get(key);
        return {
            key,
            count: current?.count ?? 0,
            resetAt: current?.resetAt ?? now + EMAIL_SIGN_IN_THROTTLE_WINDOW_MS,
        };
    });
    return {
        throttled: entries.some((entry) => entry.count >= EMAIL_SIGN_IN_FAILURE_LIMIT),
        entries,
        count: Math.max(...entries.map((entry) => entry.count)),
        resetAt: Math.max(...entries.map((entry) => entry.resetAt)),
    };
}
function recordFailedEmailSignInAttempt(database, email, session) {
    const attempts = createEmailSignInThrottleState(database);
    const current = currentEmailSignInThrottleState(database, email, session);
    for (const entry of current.entries) {
        attempts.set(entry.key, {
            count: entry.count + 1,
            resetAt: entry.resetAt,
        });
    }
    boundEmailSignInThrottleState(attempts);
}
function resetEmailSignInAttempts(database, email, session) {
    const attempts = createEmailSignInThrottleState(database);
    for (const key of emailSignInThrottleKeys(email, session)) {
        attempts.delete(key);
    }
}
function pruneEmailSignInThrottleState(attempts, now = Date.now()) {
    for (const [key, entry] of attempts) {
        if (!entry || now >= entry.resetAt) {
            attempts.delete(key);
        }
    }
}
function boundEmailSignInThrottleState(attempts) {
    while (attempts.size > EMAIL_SIGN_IN_THROTTLE_MAX_ENTRIES) {
        let evictionKey = null;
        let evictionPriority = Infinity;
        let oldestResetAt = Infinity;
        for (const [key, entry] of attempts) {
            const priority = emailSignInThrottleEvictionPriority(key, entry);
            const resetAt = Number(entry?.resetAt ?? 0);
            if (priority < evictionPriority || (priority === evictionPriority && resetAt < oldestResetAt)) {
                evictionPriority = priority;
                oldestResetAt = resetAt;
                evictionKey = key;
            }
        }
        if (evictionKey === null) {
            return;
        }
        attempts.delete(evictionKey);
    }
}
function emailSignInThrottleEvictionPriority(key, entry) {
    const throttled = Number(entry?.count ?? 0) >= EMAIL_SIGN_IN_FAILURE_LIMIT;
    if (key.startsWith("email\0") && throttled) {
        return 3;
    }
    if (key.startsWith("caller\0") && throttled) {
        return 2;
    }
    if (key.startsWith("email\0")) {
        return 1;
    }
    return 0;
}
function callerContextKey(session) {
    return String(session?.token ?? session?.auth?.userId ?? "anonymous");
}
function invalidEmailCredentialsError(options = {}) {
    return {
        message: "Email or password is incorrect.",
        hint: "Check the credentials and try email sign-in again.",
        ...(options.code ? { code: options.code } : {}),
    };
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
async function createUserPreferencesTables(sqlite) {
    await sqlite.exec("CREATE TABLE IF NOT EXISTS sporades_user_preferences (" +
        "userId TEXT PRIMARY KEY, " +
        "value TEXT NOT NULL, " +
        "updatedAt TEXT NOT NULL" +
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
    return await refreshSessionOnAdapter(database.sqlite, token);
}
async function refreshSessionOnAdapter(sqlite, token) {
    const now = new Date().toISOString();
    const expiresAt = sessionExpiresAt(now);
    await sqlite.refreshAuthSession(token, expiresAt);
    return expiresAt;
}
async function rotateSession(database, session, userId) {
    return await database.sqlite.withTransaction(async (tx) => rotateSessionOnAdapter(database, tx, session, userId));
}
async function rotateSessionOnAdapter(database, sqlite, session, userId) {
    const now = new Date().toISOString();
    const token = createSessionToken();
    await migrateAnonymousPreferences(database, session.auth, userId, sqlite);
    await sqlite.rotateAuthSession(session.token, { token, userId, createdAt: now, expiresAt: sessionExpiresAt(now) });
    return token;
}
async function moveSessionToUser(database, session, userId) {
    return await database.sqlite.withTransaction(async (tx) => moveSessionToUserOnAdapter(database, tx, session, userId));
}
async function moveSessionToUserOnAdapter(database, sqlite, session, userId) {
    const now = new Date().toISOString();
    await migrateAnonymousPreferences(database, session.auth, userId, sqlite);
    await sqlite.rotateAuthSession(session.token, {
        token: session.token,
        userId,
        createdAt: now,
        expiresAt: sessionExpiresAt(now),
    });
}
async function migrateAnonymousPreferences(database, auth, targetUserId, sqlite = null) {
    if (!auth?.isGuest || auth.userId === targetUserId) {
        return;
    }
    const migrate = async (tx) => {
        const sourceRow = await tx.readUserPreferences(auth.userId);
        if (!sourceRow) {
            return;
        }
        const targetRow = await tx.readUserPreferences(targetUserId);
        const source = JSON.parse(sourceRow.value);
        const target = targetRow ? JSON.parse(targetRow.value) : {};
        const next = { ...target, ...source };
        assertJsonCompatible(next);
        await tx.saveUserPreferences({
            userId: targetUserId,
            value: JSON.stringify(next),
            updatedAt: new Date().toISOString(),
        });
    };
    if (sqlite) {
        await migrate(sqlite);
        return;
    }
    await database.sqlite.withTransaction(migrate);
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
    await database.sqlite.withTransaction(async (tx) => {
        await tx.insertAuthUser({
            id: userId,
            createdAt: now,
            displayName: "Anonymous",
            email: null,
            picture: null,
            isAuthenticated: 0,
            isGuest: 1,
            provider: "anonymous",
        });
        await tx.insertAuthSession({ token, userId, createdAt: now, expiresAt: sessionExpiresAt(now) });
    });
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
async function readCurrentUserPreferences(database, auth) {
    const row = await database.sqlite.readUserPreferences(auth.userId);
    return {
        ok: true,
        data: {
            preferences: row ? JSON.parse(row.value) : {},
        },
        error: null,
    };
}
export async function updateCurrentUserPreferences(database, auth, patch) {
    try {
        const normalizedPatch = normalizePreferencesPatch(patch);
        const preferences = await database.sqlite.withTransaction(async (tx) => {
            const row = await tx.readUserPreferences(auth.userId);
            const current = row ? JSON.parse(row.value) : {};
            const next = { ...current, ...normalizedPatch };
            assertJsonCompatible(next);
            await tx.saveUserPreferences({
                userId: auth.userId,
                value: JSON.stringify(next),
                updatedAt: new Date().toISOString(),
            });
            return next;
        });
        return {
            ok: true,
            data: { preferences },
            changes: normalizedPatch,
            error: null,
        };
    }
    catch (error) {
        if (error?.code === "INVALID_PREFERENCES_PATCH") {
            return { ok: false, data: null, error };
        }
        return {
            ok: false,
            data: null,
            error: createPreferencesError("Preferences update failed.", "Retry the preferences update. If this keeps happening, restart the Sporades session.", "PREFERENCES_UPDATE_FAILED"),
        };
    }
}
function normalizePreferencesPatch(patch) {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
        throw createPreferencesError("Preferences updates must be JSON objects.", "Pass a plain JSON object to preferences.update().", "INVALID_PREFERENCES_PATCH");
    }
    assertJsonCompatible(patch);
    return patch;
}
function createPreferencesError(message, hint, code) {
    return { code, message, hint };
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
            closeWebSocketClient(client);
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
function closeWebSocketClient(client) {
    if (client.closing || client.socket.destroyed) {
        return;
    }
    client.closing = true;
    try {
        client.socket.write(Buffer.from([0x88, 0x00]), () => {
            client.socket.end();
        });
    }
    catch {
        client.socket.destroy();
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
export async function runQuery(database, auth, queryName) {
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
        if (error?.sporadesAuthDenialLogData) {
            emitAuthDeniedLog(database, { data: error.sporadesAuthDenialLogData });
        }
        return {
            data: null,
            error: {
                ...(error?.code ? { code: error.code } : {}),
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
        const committed = await (database.adapter ?? database.sqlite).withTransaction(async (transactionAdapter) => {
            const transactionDatabase = createTransactionDatabase(database, transactionAdapter);
            context = await applyContextMiddleware(transactionDatabase, createMutationContext(transactionDatabase, auth), "mutation");
            for (const hookSource of database.mutationHooks.beforeMutation) {
                await runMutationHookAndDrainPendingAclWrites(hookSource, { name: mutationName, args, ctx: context }, context);
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
                    await runMutationHookAndDrainPendingAclWrites(hookSource, { name: mutationName, args, ctx: context, result }, context);
                }
                await drainPendingAclWrites(context);
            }
            return result;
        });
        await flushPendingJobEnqueues(context);
        return committed;
    }
    catch (error) {
        await flushPendingJobEnqueues(context);
        database.rowCache.clear();
        await reindexPrivilegedAuditEventsAfterRollback(database, context);
        if (error?.sporadesAclDenialLogData) {
            emitAclDeniedLog(database, { data: error.sporadesAclDenialLogData });
        }
        if (error?.sporadesAuthDenialLogData) {
            emitAuthDeniedLog(database, { data: error.sporadesAuthDenialLogData });
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
        database.rowCache.clear();
    }
    if (result !== undefined) {
        assertJsonCompatible(result);
    }
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
    let context;
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
        const createHandler = new Function(`return (${handler.handlerSource});`);
        const response = await (database.adapter ?? database.sqlite).withTransaction(async (transactionAdapter) => {
            const transactionDatabase = createTransactionDatabase(database, transactionAdapter);
            context = await applyContextMiddleware(transactionDatabase, createMessageContext(transactionDatabase, auth, options.sendAppMessage), "message");
            let result;
            try {
                result = await createHandler()(context, data);
            }
            finally {
                await drainPendingAclWrites(context);
                transactionDatabase.rowCache.clear();
            }
            if (result !== undefined) {
                assertJsonCompatible(result);
            }
            return { data: result ?? null, error: null };
        });
        await flushPendingJobEnqueues(context);
        return response;
    }
    catch (error) {
        await flushPendingJobEnqueues(context);
        if (error?.sporadesAuthDenialLogData) {
            emitAuthDeniedLog(database, { data: error.sporadesAuthDenialLogData });
        }
        return {
            data: null,
            error: {
                ...(error?.code ? { code: error.code } : {}),
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
    const context = createMutationContext(database, auth);
    context.messages = {
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
    };
    return context;
}
async function runMutationHook(hookSource, event) {
    const createHook = new Function(`return (${hookSource});`);
    const hook = createHook();
    return await hook(event);
}
async function runMutationHookAndDrainPendingAclWrites(hookSource, event, context) {
    try {
        return await runMutationHook(hookSource, event);
    }
    finally {
        await drainPendingAclWrites(context);
    }
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
    context.privileged = createContextPrivilegedApi(database, () => holder.current);
    context.jobs = createCurrentUserJobApi(database, () => holder.current);
    return context;
}
function createCurrentUserJobApi(database, contextGetter) {
    return {
        async enqueue(handlerName, payload, options = {}) {
            const context = contextGetter();
            const queueDatabase = database.__rootDatabase ?? database;
            const scheduleProvenance = queueDatabase.jobScheduleProvenanceByContext?.get(context);
            const handler = database.jobs?.find((candidate) => candidate.name === handlerName);
            if (!handler) {
                throw jobError("UNKNOWN_JOB_HANDLER", `Unknown Job handler: ${String(handlerName)}`, "Declare the named handler in capsule({ jobs }) before enqueueing it.");
            }
            if (options === null || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => !["idempotencyKey", "availableAt", "retry"].includes(key))) {
                throw jobError("INVALID_JOB_OPTIONS", "Invalid Job enqueue options.", "Only idempotencyKey is supported for current-user Jobs.");
            }
            const payloadJson = boundedJobJson(payload, 64 * 1024, "JOB_PAYLOAD_TOO_LARGE", "Job payload");
            const idempotencyKey = options.idempotencyKey;
            if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !idempotencyKey || idempotencyKey.length > 256)) {
                throw jobError("INVALID_JOB_OPTIONS", "Invalid Job idempotency key.", "Pass a non-empty idempotencyKey no longer than 256 characters.");
            }
            if (idempotencyKey) {
                const existing = await queueDatabase.sqlite.prepare("SELECT * FROM sporades_jobs WHERE handler = ? AND actorUserId = ? AND idempotencyKey = ?").get(handlerName, context.auth.userId, idempotencyKey);
                if (existing) {
                    assertJobScheduleProvenance(existing, scheduleProvenance);
                    return jobState(existing, true);
                }
                const pending = (context.__jobParentContext ?? context).__pendingJobEnqueues?.find((candidate) => candidate.handler === handlerName && candidate.actorUserId === context.auth.userId && candidate.idempotencyKey === idempotencyKey);
                if (pending) {
                    assertJobScheduleProvenance(pending, scheduleProvenance);
                    return jobState(pending, true);
                }
            }
            const id = crypto.randomUUID();
            const now = queueDatabase.clock.now().toISOString();
            const availableAt = options.availableAt === undefined ? now : new Date(options.availableAt).toISOString();
            if (Number.isNaN(Date.parse(availableAt)))
                throw jobError("INVALID_JOB_OPTIONS", "Invalid Job availability time.", "Pass an ISO 8601 availableAt value.");
            const retry = normalizeJobRetry(options.retry);
            const row = { id, handler: handlerName, enqueuedByUserId: context.__jobEnqueuedBy ?? context.auth.userId, actorUserId: context.auth.userId, payload: payloadJson, status: availableAt > now ? "delayed" : "queued", availableAt, attempts: 0, idempotencyKey: idempotencyKey ?? null, createdAt: now, retryJson: JSON.stringify(retry), attemptHistory: "[]", scheduleName: scheduleProvenance?.scheduleName ?? null, scheduledFor: scheduleProvenance?.scheduledFor ?? null };
            if (database.__transactionActive) {
                const pendingContext = context.__jobParentContext ?? context;
                pendingContext.__pendingJobEnqueues ??= [];
                pendingContext.__jobQueueDatabase = queueDatabase;
                pendingContext.__pendingJobEnqueues.push(row);
                return jobState(row, true);
            }
            try {
                await queueDatabase.sqlite.prepare("INSERT INTO sporades_jobs (id, handler, enqueuedByUserId, actorUserId, payload, status, availableAt, attempts, idempotencyKey, createdAt, retryJson, attemptHistory, scheduleName, scheduledFor) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)").run(id, handlerName, row.enqueuedByUserId, row.actorUserId, payloadJson, row.status, availableAt, idempotencyKey ?? null, now, row.retryJson, row.attemptHistory, row.scheduleName, row.scheduledFor);
            }
            catch (error) {
                if (idempotencyKey) {
                    const existing = await queueDatabase.sqlite.prepare("SELECT * FROM sporades_jobs WHERE handler = ? AND actorUserId = ? AND idempotencyKey = ?").get(handlerName, context.auth.userId, idempotencyKey);
                    if (existing) {
                        assertJobScheduleProvenance(existing, scheduleProvenance);
                        return jobState(existing, true);
                    }
                }
                throw error;
            }
            scheduleCurrentUserJobWorker(queueDatabase);
            return jobState(await queueDatabase.sqlite.prepare("SELECT * FROM sporades_jobs WHERE id = ?").get(id), true);
        },
        async get(id) {
            const context = contextGetter();
            const row = await (database.__rootDatabase ?? database).sqlite.prepare("SELECT * FROM sporades_jobs WHERE id = ? AND actorUserId = ?").get(id, context.auth.userId);
            return row ? jobState(row, true) : null;
        },
        async cancel(id) { return await cancelJob(database.__rootDatabase ?? database, contextGetter(), id); },
        async list(options = {}) {
            const context = contextGetter();
            if (options === null || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => !["limit", "cursor", "status", "handler", "createdAfter", "createdBefore"].includes(key)))
                throw jobError("INVALID_JOB_OPTIONS", "Invalid Job list options.", "Pass supported Job list filters only.");
            const limit = options.limit === undefined ? 50 : options.limit;
            if (!Number.isInteger(limit) || limit < 1 || limit > 100)
                throw jobError("INVALID_JOB_OPTIONS", "Invalid Job list limit.", "Pass a whole-number limit from 1 to 100.");
            const cursor = decodeJobCursor(options.cursor);
            const queueDatabase = database.__rootDatabase ?? database;
            const clauses = ["actorUserId = ?"];
            const params = [context.auth.userId];
            if (options.status) {
                clauses.push("status = ?");
                params.push(options.status);
            }
            if (options.handler) {
                clauses.push("handler = ?");
                params.push(options.handler);
            }
            if (options.createdAfter) {
                clauses.push("createdAt >= ?");
                params.push(options.createdAfter);
            }
            if (options.createdBefore) {
                clauses.push("createdAt <= ?");
                params.push(options.createdBefore);
            }
            if (cursor) {
                clauses.push("(createdAt > ? OR (createdAt = ? AND id > ?))");
                params.push(cursor.createdAt, cursor.createdAt, cursor.id);
            }
            const rows = await queueDatabase.sqlite.prepare(`SELECT * FROM sporades_jobs WHERE ${clauses.join(" AND ")} ORDER BY createdAt ASC, id ASC LIMIT ?`).all(...params, limit + 1);
            const page = rows.slice(0, limit);
            return { jobs: page.map((row) => jobSummary(row)), nextCursor: rows.length > limit ? encodeJobCursor(page.at(-1)) : null };
        },
    };
}
function assertJobScheduleProvenance(row, expected) {
    if (!expected)
        return;
    if (row?.scheduleName !== expected.scheduleName || row?.scheduledFor !== expected.scheduledFor) {
        throw jobError("JOB_IDEMPOTENCY_CONFLICT", "Scheduled occurrence idempotency conflicts with existing Job provenance.", "Inspect the existing Job and retry after resolving the conflicting internal idempotency key.");
    }
}
function jobError(code, message, hint) {
    const error = new Error(message);
    error.code = code;
    error.hint = hint;
    return error;
}
function boundedJobJson(value, limit, code, label) {
    let serialized;
    try {
        assertJsonCompatible(value);
        serialized = JSON.stringify(value);
    }
    catch {
        throw jobError("INVALID_JOB_PAYLOAD", `${label} must be JSON-compatible.`, "Pass plain JSON data without functions, cycles, or live request objects.");
    }
    if (Buffer.byteLength(serialized, "utf8") > limit)
        throw jobError(code, `${label} exceeds the ${limit} byte limit.`, "Reduce the serialized JSON value before enqueueing or returning it.");
    return serialized;
}
function jobState(row, includeDetail) {
    const actor = row.actorUserId === privilegedAuthUserId() ? { mode: "privileged-server-role" } : { mode: "current-user", userId: row.actorUserId };
    const enqueuedBy = row.scheduleName ? { mode: "schedule", scheduleName: row.scheduleName, scheduledFor: row.scheduledFor } : { mode: "user", userId: row.enqueuedByUserId };
    const state = { id: row.id, handler: row.handler, status: row.status, enqueuedBy, actor, attempts: Number(row.attempts) };
    if (includeDetail && row.result)
        state.result = JSON.parse(row.result);
    if (includeDetail && row.failure)
        state.failure = JSON.parse(row.failure);
    if (includeDetail)
        state.attemptHistory = JSON.parse(row.attemptHistory || "[]");
    if (row.cancelRequestedAt)
        state.cancelRequestedAt = row.cancelRequestedAt;
    return state;
}
/** Read the bounded operator view of every Job in one adapter snapshot. */
export async function inspectRuntimeJobs(adapter) {
    const decode = (row, field, value, fallback) => {
        if (value === null || value === undefined || value === "")
            return fallback;
        try {
            return JSON.parse(String(value));
        }
        catch {
            const error = jobError("JOB_INSPECTION_INVALID_STATE", "Stored Job state is invalid.", "Repair or remove the malformed Job before retrying inspection.");
            error.jobId = String(row.id);
            error.field = field;
            throw error;
        }
    };
    const read = async (tx) => {
        let rows;
        try {
            rows = await tx.prepare("SELECT * FROM sporades_jobs ORDER BY createdAt DESC, id DESC").all();
        }
        catch (error) {
            const message = String(error?.message ?? error);
            if (/no such table|does not exist|unknown table/i.test(message))
                return [];
            throw error;
        }
        return rows.map((row) => ({
            id: String(row.id), handler: String(row.handler), status: String(row.status),
            enqueuedBy: row.scheduleName ? { mode: "schedule", scheduleName: String(row.scheduleName), scheduledFor: String(row.scheduledFor) } : { mode: "user", userId: String(row.enqueuedByUserId) },
            actor: row.actorUserId === privilegedAuthUserId() ? { mode: "privileged-server-role" } : { mode: "current-user", userId: String(row.actorUserId) },
            attempts: Number(row.attempts), retry: decode(row, "retry", row.retryJson, { maxAttempts: 1, delayMs: 0 }),
            idempotencyKeyPresent: row.idempotencyKey !== null && row.idempotencyKey !== undefined,
            availableAt: row.availableAt ?? null, createdAt: row.createdAt ?? null, startedAt: row.startedAt ?? null,
            completedAt: row.completedAt ?? null, failedAt: row.failedAt ?? null, cancelRequestedAt: row.cancelRequestedAt ?? null,
            leaseExpiresAt: row.leaseExpiresAt ?? null, attemptHistory: decode(row, "attemptHistory", row.attemptHistory, []),
            // Job results are arbitrary Capsule JSON. Validate storage but never disclose the payload
            // until the runtime has a separate safe-result metadata classifier.
            result: (decode(row, "result", row.result, null), null), failure: decode(row, "failure", row.failure, null),
        }));
    };
    if (!adapter?.withReadOnlySnapshot)
        throw jobError("JOB_INSPECTION_READ_ONLY_UNAVAILABLE", "Database adapter does not support read-only Job inspection.", "Upgrade the Sporades runtime and retry inspection.");
    return await adapter.withReadOnlySnapshot(read);
}
function normalizeJobRetry(value) { if (value === undefined)
    return { maxAttempts: 1, delayMs: 0 }; if (!value || !Number.isInteger(value.maxAttempts) || value.maxAttempts < 1 || value.maxAttempts > 20 || !Number.isInteger(value.delayMs ?? 0) || (value.delayMs ?? 0) < 0)
    throw jobError("INVALID_JOB_OPTIONS", "Invalid Job retry policy.", "Pass retry.maxAttempts (1-20) and non-negative retry.delayMs."); return { maxAttempts: value.maxAttempts, delayMs: value.delayMs ?? 0 }; }
async function cancelJob(database, context, id) { const row = context.__privilegedJobAccess ? await database.sqlite.prepare("SELECT * FROM sporades_jobs WHERE id = ?").get(id) : await database.sqlite.prepare("SELECT * FROM sporades_jobs WHERE id = ? AND actorUserId = ?").get(id, context.auth.userId); if (!row)
    return null; const now = database.clock.now().toISOString(); if (["queued", "delayed"].includes(row.status)) {
    await database.sqlite.prepare("UPDATE sporades_jobs SET status='cancelled', completedAt=? WHERE id=?").run(now, id);
    return jobState({ ...row, status: "cancelled", completedAt: now }, true);
} if (row.status === "running") {
    database.__jobAbortControllers?.get(id)?.abort();
    await database.sqlite.prepare("UPDATE sporades_jobs SET cancelRequestedAt=? WHERE id=?").run(now, id);
    return jobState({ ...row, cancelRequestedAt: now }, true);
} throw jobError("INVALID_JOB_STATE", "Job cannot be cancelled from its current state.", "Only queued, delayed, or running Jobs can be cancelled."); }
function jobSummary(row) { return { id: row.id, handler: row.handler, status: row.status, attempts: Number(row.attempts) }; }
function createPrivilegedJobApi(database, contextGetter) {
    const current = createCurrentUserJobApi(database, contextGetter);
    return {
        async enqueue(handler, payload, options = {}) { assertActivePrivilegedJobAccess(contextGetter); return await current.enqueue(handler, payload, options); },
        async get(id) {
            assertActivePrivilegedJobAccess(contextGetter);
            const row = await (database.__rootDatabase ?? database).sqlite.prepare("SELECT * FROM sporades_jobs WHERE id = ?").get(id);
            return row ? jobState(row, true) : null;
        },
        async list(options = {}) {
            assertActivePrivilegedJobAccess(contextGetter);
            if (options === null || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => !["limit", "cursor", "status", "handler", "createdAfter", "createdBefore"].includes(key)))
                throw jobError("INVALID_JOB_OPTIONS", "Invalid Job list options.", "Pass supported Job list filters only.");
            const limit = options.limit === undefined ? 50 : options.limit;
            if (!Number.isInteger(limit) || limit < 1 || limit > 100)
                throw jobError("INVALID_JOB_OPTIONS", "Invalid Job list limit.", "Pass a whole-number limit from 1 to 100.");
            const cursor = decodeJobCursor(options.cursor);
            const sqlite = (database.__rootDatabase ?? database).sqlite;
            const clauses = [];
            const params = [];
            if (options.status) {
                clauses.push("status = ?");
                params.push(options.status);
            }
            if (options.handler) {
                clauses.push("handler = ?");
                params.push(options.handler);
            }
            if (options.createdAfter) {
                clauses.push("createdAt >= ?");
                params.push(options.createdAfter);
            }
            if (options.createdBefore) {
                clauses.push("createdAt <= ?");
                params.push(options.createdBefore);
            }
            if (cursor) {
                clauses.push("(createdAt > ? OR (createdAt = ? AND id > ?))");
                params.push(cursor.createdAt, cursor.createdAt, cursor.id);
            }
            const rows = await sqlite.prepare(`SELECT * FROM sporades_jobs${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY createdAt ASC, id ASC LIMIT ?`).all(...params, limit + 1);
            const page = rows.slice(0, limit);
            return { jobs: page.map((row) => jobSummary(row)), nextCursor: rows.length > limit ? encodeJobCursor(page.at(-1)) : null };
        },
        async cancel(id) { assertActivePrivilegedJobAccess(contextGetter); return await cancelJob(database.__rootDatabase ?? database, { auth: { userId: privilegedAuthUserId() }, __privilegedJobAccess: true }, id); },
    };
}
function assertActivePrivilegedJobAccess(contextGetter) {
    if (hasPrivilegedDbAccess(contextGetter?.()))
        return;
    throw jobError("PRIVILEGED_JOB_ACCESS_INACTIVE", "Privileged Job access is no longer active.", "Start a new ctx.privileged.run callback before using privileged Job operations.");
}
function encodeJobCursor(row) { return Buffer.from(JSON.stringify({ createdAt: row.createdAt, id: row.id })).toString("base64url"); }
function decodeJobCursor(value) {
    if (value === undefined)
        return null;
    try {
        const cursor = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
        if (typeof cursor?.createdAt !== "string" || typeof cursor?.id !== "string")
            throw new Error("invalid");
        return cursor;
    }
    catch {
        throw jobError("INVALID_JOB_OPTIONS", "Invalid Job cursor.", "Pass the nextCursor returned by a previous Job list call.");
    }
}
async function flushPendingJobEnqueues(context) {
    if (!context?.__pendingJobEnqueues?.length || context.__pendingJobsFlushed)
        return;
    context.__pendingJobsFlushed = true;
    const queueDatabase = context.__jobQueueDatabase;
    for (const row of context.__pendingJobEnqueues) {
        await queueDatabase.sqlite.prepare("INSERT INTO sporades_jobs (id, handler, enqueuedByUserId, actorUserId, payload, status, availableAt, attempts, idempotencyKey, createdAt, retryJson, attemptHistory, scheduleName, scheduledFor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(row.id, row.handler, row.enqueuedByUserId, row.actorUserId, row.payload, row.status, row.availableAt, row.attempts, row.idempotencyKey, row.createdAt, row.retryJson, row.attemptHistory, row.scheduleName ?? null, row.scheduledFor ?? null);
    }
    scheduleCurrentUserJobWorker(queueDatabase);
}
function scheduleCurrentUserJobWorker(database) {
    if (database.__jobWorkerScheduled || database.__jobWorkerRunning)
        return;
    database.__jobWorkerScheduled = true;
    database.clock.setTimer(async () => {
        database.__jobWorkerScheduled = false;
        await runCurrentUserJobWorker(database);
    }, 0);
}
async function scheduleNextDelayedJob(database) {
    const row = await database.sqlite.prepare("SELECT availableAt FROM sporades_jobs WHERE status='delayed' ORDER BY availableAt ASC, id ASC LIMIT 1").get();
    if (!row)
        return;
    if (database.__jobWakeTimer)
        database.clock.clearTimer(database.__jobWakeTimer);
    database.__jobWakeTimer = database.clock.setTimer(() => { database.__jobWakeTimer = null; scheduleCurrentUserJobWorker(database); }, Math.max(0, Date.parse(row.availableAt) - database.clock.now().getTime()) + 1);
}
async function runCurrentUserJobWorker(database) {
    if (database.__jobWorkerRunning)
        return;
    database.__jobWorkerRunning = true;
    try {
        while (true) {
            await database.sqlite.prepare("UPDATE sporades_jobs SET status='queued' WHERE status='delayed' AND availableAt <= ?").run(database.clock.now().toISOString());
            const row = await database.sqlite.prepare("SELECT * FROM sporades_jobs WHERE status = 'queued' AND availableAt <= ? ORDER BY availableAt ASC, id ASC LIMIT 1").get(database.clock.now().toISOString());
            if (!row) {
                await scheduleNextDelayedJob(database);
                return;
            }
            const startedAt = database.clock.now().toISOString();
            const claimed = await database.sqlite.prepare("UPDATE sporades_jobs SET status = 'running', attempts = attempts + 1, startedAt = ?, leaseExpiresAt = ? WHERE id = ? AND status = 'queued'").run(startedAt, new Date(database.clock.now().getTime() + 30_000).toISOString(), row.id);
            if (!claimed?.changes)
                continue;
            const handler = database.jobs?.find((candidate) => candidate.name === row.handler);
            database.__jobAbortControllers ??= new Map();
            const abortController = new AbortController();
            database.__jobAbortControllers.set(row.id, abortController);
            try {
                if (!handler)
                    throw jobError("UNKNOWN_JOB_HANDLER", "Job handler is no longer declared.", "Restore the handler or inspect the retained Job state.");
                let result;
                if (row.actorUserId === privilegedAuthUserId()) {
                    const context = createMutationContext(database, { userId: row.enqueuedByUserId, displayName: "Job enqueuer", email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "job" });
                    result = await context.privileged.run({ operation: "jobs.execute", targetResourceKind: "job-queue", signal: abortController.signal, metadata: { jobId: row.id, handler: row.handler, attempt: Number(row.attempts) + 1, ...(row.scheduleName ? { scheduleName: String(row.scheduleName), scheduledFor: String(row.scheduledFor) } : {}) } }, (privilegedCtx) => handler.handler(privilegedCtx, JSON.parse(row.payload)));
                }
                else {
                    const user = await database.sqlite.prepare("SELECT * FROM sporades_auth_users WHERE id = ?").get(row.actorUserId);
                    if (!user)
                        throw jobError("JOB_ACTOR_UNAVAILABLE", "The captured Job actor is unavailable.", "The user no longer exists, so this Job cannot run.");
                    const auth = { userId: user.id, displayName: user.displayName, email: user.email, picture: user.picture, isAuthenticated: Boolean(user.isAuthenticated), isGuest: Boolean(user.isGuest), provider: user.provider };
                    const context = createMutationContext(database, auth);
                    context.signal = abortController.signal;
                    result = await handler.handler(context, JSON.parse(row.payload));
                }
                const resultJson = boundedJobJson(result ?? null, 64 * 1024, "JOB_RESULT_TOO_LARGE", "Job result");
                const completedAt = database.clock.now().toISOString();
                const history = JSON.parse(row.attemptHistory || "[]");
                history.push({ attempt: Number(row.attempts) + 1, startedAt, outcome: "succeeded", completedAt });
                await database.sqlite.prepare("UPDATE sporades_jobs SET status = 'succeeded', result = ?, completedAt = ?, attemptHistory = ? WHERE id = ?").run(resultJson, completedAt, JSON.stringify(history), row.id);
            }
            catch (error) {
                const failure = safeJobFailure(error);
                const failedAt = database.clock.now().toISOString();
                const history = JSON.parse(row.attemptHistory || "[]");
                const retry = JSON.parse(row.retryJson || '{"maxAttempts":1,"delayMs":0}');
                const abortError = error?.cause ?? error;
                const cancelled = abortController.signal.aborted && (abortError?.name === "AbortError" || abortError?.code === "ABORT_ERR");
                history.push({ attempt: Number(row.attempts) + 1, startedAt, outcome: cancelled ? "cancelled" : "failed", code: failure.code, completedAt: failedAt });
                if (cancelled)
                    await database.sqlite.prepare("UPDATE sporades_jobs SET status='cancelled', failure=?, failedAt=?, attemptHistory=? WHERE id=?").run(JSON.stringify(failure), failedAt, JSON.stringify(history), row.id);
                else if (Number(row.attempts) + 1 < retry.maxAttempts) {
                    const availableAt = new Date(database.clock.now().getTime() + retry.delayMs).toISOString();
                    await database.sqlite.prepare("UPDATE sporades_jobs SET status='delayed', availableAt=?, attemptHistory=? WHERE id=?").run(availableAt, JSON.stringify(history), row.id);
                    database.clock.setTimer(() => scheduleCurrentUserJobWorker(database), retry.delayMs + 1);
                }
                else
                    await database.sqlite.prepare("UPDATE sporades_jobs SET status = 'failed', failure = ?, failedAt = ?, attemptHistory=? WHERE id = ?").run(boundedJobJson(failure, 8 * 1024, "JOB_FAILURE_TOO_LARGE", "Job failure metadata"), failedAt, JSON.stringify(history), row.id);
            }
            finally {
                database.__jobAbortControllers?.delete(row.id);
            }
        }
    }
    finally {
        database.__jobWorkerRunning = false;
    }
}
function safeJobFailure(error) {
    const knownCodes = new Set(["JOB_ACTOR_UNAVAILABLE", "UNKNOWN_JOB_HANDLER", "JOB_RESULT_TOO_LARGE", "INVALID_JOB_PAYLOAD"]);
    const code = knownCodes.has(error?.code) ? error.code : "JOB_FAILED";
    const messages = {
        JOB_ACTOR_UNAVAILABLE: "The captured Job actor is unavailable.",
        UNKNOWN_JOB_HANDLER: "The Job handler is unavailable.",
        JOB_RESULT_TOO_LARGE: "The Job result exceeded its safe size limit.",
        INVALID_JOB_PAYLOAD: "The Job produced an unsupported result.",
        JOB_FAILED: "Job handler failed.",
    };
    return { code, message: messages[code] };
}
async function drainPendingAclWrites(context) {
    let firstError = null;
    while (context?.__pendingAclWrites?.length > 0) {
        const pending = context.__pendingAclWrites.splice(0);
        const results = await Promise.allSettled(pending);
        for (const result of results) {
            if (result.status === "rejected" && !firstError) {
                firstError = result.reason;
            }
        }
    }
    if (firstError) {
        throw firstError;
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
    return `"${String(identifier).replaceAll('"', '""')}"`;
}
//# sourceMappingURL=server-runtime-source.js.map