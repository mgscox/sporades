import type { IncomingMessage, ServerResponse, IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import { WithImplicitCoercion } from "buffer";
import { BinaryLike, KeyObject } from "node:crypto";
import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual, verify } from "node:crypto";
import { PathLike, PathOrFileDescriptor, appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { SQLOutputValue, StatementResultingChanges, StatementColumnMetadata } from "node:sqlite";
import { Duplex } from "stream";

type LooseRecord = Record<string, any>;
type RuntimeConfig = LooseRecord;
type RuntimeEnv = Record<string, string | undefined>;
type RuntimeSecurityPolicy = {
  cors: {
    sameOrigin: boolean;
    publicDev: boolean;
    allowedOrigins: string[];
    allowedOriginPatterns: string[];
    requireExplicitCrossOrigin: boolean;
    publicOrigin: string | null;
  };
  csp: {
    mode: string;
    header: string;
    directives: Record<string, string[] | string>;
  };
};
type RuntimeRequestLike = {
  headers: IncomingHttpHeaders | LooseRecord;
  socket?: any;
};
type S3RequestResult = {
  statusCode: number;
  headers: IncomingHttpHeaders | LooseRecord;
  body: Buffer;
};
type HelperError = Error & {
  code?: string;
  hint?: string;
  sporadesAclDenialLogData?: any;
  sporadesAuthDenialLogData?: any;
  sporadesEndpointResponse?: boolean;
};

const PRIVILEGED_AUTH_USER_ID = "__privileged__";
const EMAIL_SIGN_IN_FAILURE_LIMIT = 5;
const EMAIL_SIGN_IN_THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_SIGN_IN_THROTTLE_MAX_ENTRIES = 256;

export const SERVER_RUNTIME_SOURCE_FUNCTIONS: Function[] = [
  normalizeJourneyPolicy,
  normalizeJourneyState,
  validateJourneyJson,
  journeyError,
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
  resolveJourneySessionInactivityMinutes,
  scheduleDefinitionsFromCapsule,
  resolveScheduleTimezone,
  parseScheduleExpression,
  scheduleWallClockParts,
  nextScheduleOccurrence,
  ensureScheduleStorage,
  scheduledOccurrenceIdentity,
  claimScheduledOccurrence,
  recoverPendingScheduleOccurrences,
  schedulePendingOccurrenceRecovery,
  reconcileSchedules,
  startStaticSchedules,
  finishFailedScheduledOccurrence,
  recordScheduledOccurrence,
  acquireSchedulePayloadFactoryLane,
  acquireSchedulePayloadFactorySlot,
  resolveSchedulePayload,
  abortSchedulePayloadFactories,
  enqueueScheduledOccurrence,
  createRuntimeInspectionAdapter,
  inspectRuntimeJobs,
  inspectRuntimeSchedules,
  scheduleSummary,
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
  createPrivilegedScheduleApi,
  createPrivilegedFileApi,
  activePrivilegedFileAccess,
  privilegedAuthUserId,
  isReservedAuthUserId,
  authIdentityRowUnlessReserved,
  authIdentityRowsUnlessReserved,
  assertNotReservedAuthUserId,
  createPrivilegedAuditLogInput,
  normalizePrivilegedAuditActorKind,
  normalizePrivilegedAuditOutcome,
  privilegedAuditLevelForOutcome,
  normalizePrivilegedAuditCorrelation,
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
  endpointHandlersFromCapsuleDefinition,
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
  aclRuleTouchedAsyncHelperRead,
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
  emptyProviderConfig,
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
  createProviderIdentityTables,
  createLibsqlProviderIdentityTables,
  ensureOAuthStateColumns,
  ensureLibsqlOAuthStateColumns,
  createUserPreferencesTables,
  ensureSessionLifecycleColumns,
  ensureSessionProvenanceColumn,
  ensureLibsqlSessionProvenanceColumn,
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
  normalizeSimulatedEmail,
  normalizeSimulatedText,
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
  beginOAuthSignIn,
  oauthProviderAdapter,
  createGoogleOAuthProviderAdapter,
  completeGoogleOAuth,
  verifyGoogleIdentityToken,
  decodeJwtPart,
  readOAuthCallbackParameters,
  normalizeReturnTo,
  linkProviderIdentity,
  linkGoogleAccount,
  writeRedirect,
  createWebSocketAccept,
  createWebSocketHub,
  drainWebSocketFrames,
  closeWebSocketClient,
  encodeWebSocketJson,
  sendJson,
  sendJsonWithCompletion,
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

export async function readJsonRequest(request: IncomingMessage, limitSource: LooseRecord | number | null = null): Promise<LooseRecord> {
  const raw = (await readLimitedRequestBody(request, limitSource)).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function readLimitedRequestBody(request: any, limitSource: LooseRecord | number | null = null) {
  const maxBytes = resolveHttpMaxBodyBytes(limitSource);
  const chunks: Buffer[] = [];
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

function resolveHttpMaxBodyBytes(source: LooseRecord | number | null = null) {
  const configured = typeof source === "number"
    ? source
    : Number(source?.httpMaxBodyBytes ?? source?.http?.maxBodyBytes ?? source?.config?.http?.maxBodyBytes);
  return Number.isInteger(configured) && configured > 0 ? configured : 1024 * 1024;
}

function createPayloadTooLargeError(maxBytes: number) {
  const error: HelperError = new Error("Request body is too large.");
  error.code = "PAYLOAD_TOO_LARGE";
  error.hint = `Send a request body at or below ${maxBytes} bytes, or raise http.maxBodyBytes in sporades.json.`;
  return error;
}

function isPayloadTooLargeError(error: any) {
  return error?.code === "PAYLOAD_TOO_LARGE";
}

export function writeUnhandledHttpError(database: LooseRecord, request: IncomingMessage, response: ServerResponse<IncomingMessage>, error: any) {
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

function emitHttpFailureLog(database: LooseRecord, request: IncomingMessage | LooseRecord, error: any, context: LooseRecord = {}) {
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

export function prepareHttpSecurity(database: { securityPolicy?: RuntimeSecurityPolicy }, request: IncomingMessage, response: ServerResponse<IncomingMessage> & { req: IncomingMessage; }) {
  const policy = database.securityPolicy ?? resolveRuntimeSecurityPolicy({});
  const originalWriteHead = response.writeHead.bind(response);
  response.writeHead = ((statusCode: number, statusMessageOrHeaders?: string | OutgoingHttpHeaders, maybeHeaders?: OutgoingHttpHeaders) => {
    const statusMessage = typeof statusMessageOrHeaders === "string" ? statusMessageOrHeaders : undefined;
    const inputHeaders = statusMessage ? maybeHeaders : typeof statusMessageOrHeaders === "string" ? {} : statusMessageOrHeaders;
    const headers: OutgoingHttpHeaders = {
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
  }) as typeof response.writeHead;

  if (request.method === "OPTIONS" && request.headers.origin && request.headers["access-control-request-method"]) {
    const headers: OutgoingHttpHeaders = {
      "content-length": "0",
    };
    if (requestOriginAllowed(policy, request)) {
      headers["access-control-allow-origin"] = policy.cors.publicDev ? "*" : String(request.headers.origin);
      headers["access-control-allow-methods"] = "GET,POST,PUT,DELETE,OPTIONS";
      headers["access-control-allow-headers"] = String(
        request.headers["access-control-request-headers"] ?? "content-type,x-sporades-session-token",
      );
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

function resolveRuntimeSecurityPolicy(config: RuntimeConfig = {}): RuntimeSecurityPolicy {
  const security = config.security ?? {};
  const cors = security.cors ?? {};
  const csp = security.csp ?? {};
  const session = config.__sporadesSession ?? "container";
  const publicDev = session === "public-dev";
  const dev = session === "dev" || publicDev;
  const configuredOrigins = Array.isArray(cors.allowedOrigins) ? cors.allowedOrigins.filter((origin: any) => typeof origin === "string") : [];
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

function defaultRuntimeCspDirectives(): Record<string, string[]> {
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

function serializeCspDirectives(directives: Record<string, unknown>) {
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${Array.isArray(values) ? values.join(" ") : String(values)}`)
    .join("; ");
}

export function injectPageConnectionToken(html: string, token: string) {
  const script = `<script>window.__SPORADES_CONNECTION_TOKEN=${JSON.stringify(token)};</script>`;
  if (/<head(\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n${script}`);
  }
  return `${script}\n${html}`;
}

function requestOriginAllowed(policy: RuntimeSecurityPolicy, request: RuntimeRequestLike) {
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

function websocketOriginAllowed(policy: RuntimeSecurityPolicy, request: RuntimeRequestLike) {
  if (!request.headers.origin) {
    return !policy.cors.publicOrigin;
  }
  return requestOriginAllowed(policy, request);
}

function isSameOriginRequest(request: RuntimeRequestLike, origin: string) {
  const host = request.headers["x-forwarded-host"] ?? request.headers.host;
  if (!host) {
    return false;
  }
  const protocol = request.headers["x-forwarded-proto"] ?? (request.socket?.encrypted ? "https" : "http");
  return origin === `${protocol}://${host}`;
}

function normalizeOrigin(value: any) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isLocalDevOrigin(origin: string | URL) {
  try {
    const parsed = new URL(origin);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function appendVaryHeader(existing: unknown, value: string) {
  if (!existing) {
    return value;
  }
  const parts = String(existing)
    .split(",")
    .map((part) => part.trim().toLowerCase());
  return parts.includes(value.toLowerCase()) ? String(existing) : `${existing}, ${value}`;
}

function sanitizeResponseHeaders(headers: OutgoingHttpHeaders | LooseRecord) {
  const entries = headers instanceof Map ? headers.entries() : Object.entries(headers ?? {});
  return Object.fromEntries(
    [...entries].filter(([name]) => {
      const normalized = String(name).toLowerCase();
      return normalized !== "x-powered-by" && normalized !== "server";
    }),
  );
}

export async function openDevDatabase(
  databasePath: string,
  serverSource: any,
  serverEnv: RuntimeEnv = {},
  config: RuntimeConfig = {},
  capsuleDefinition: any = null,
  options: LooseRecord = {},
) {
  const path = await import("node:path");
  const schedulePayloadFactoryTimeoutMs = resolveSchedulePayloadFactoryTimeoutMs(config);
  const journeySessionInactivityMinutes = resolveJourneySessionInactivityMinutes(config);
  // Handler sources extracted from Capsule server code are re-created with
  // `new Function`, which only sees globals. Install the sporades/server
  // requireAuth helper there so those handlers resolve the same auth gate.
  (globalThis as any).requireAuth = requireAuth;
  const sqlite = await createRuntimeDatabaseAdapter(databasePath, options?.serviceEnv ?? serverEnv, config);
  const serviceEnv = options?.serviceEnv ?? serverEnv;
  const fileStorage = await createRuntimeFileStorageAdapter({
    config,
    databasePath,
    serviceEnv,
  });
  const schema = capsuleDefinition ? schemaFromCapsuleDefinition(capsuleDefinition) : extractSchema(serverSource);
  const endpoints = capsuleDefinition
    ? endpointHandlersFromCapsuleDefinition(capsuleDefinition)
    : extractEndpoints(serverSource);
  const queries: any[] = (extractQueryHandlersFromCapsule(capsuleDefinition) as any) ?? (extractQueryHandlers(serverSource) as any);
  const mutations: any[] = (capsuleDefinition
    ? mutationHandlersFromCapsuleDefinition(serverSource, capsuleDefinition)
    : extractMutationHandlers(serverSource)) as any[];
  const messages = extractMessageHandlers(serverSource);
  const jobs = jobHandlersFromCapsuleDefinition(capsuleDefinition);
  const schedules = scheduleDefinitionsFromCapsule(capsuleDefinition, jobs);
  const clock = createRuntimeClock(options?.clock);
  const contextMiddleware = extractContextMiddleware(serverSource);
  const mutationHooks = extractMutationHooks(serverSource);
  const lifecycleHooks = { init: capsuleDefinition?.hooks?.init, shutdown: capsuleDefinition?.hooks?.shutdown };
  const rowCache = new Map();
  const database: LooseRecord = {
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
    journeyPolicy: normalizeJourneyPolicy(capsuleDefinition?.journey),
    journeySessionInactivityMinutes,
    runtimeDiagnostics: { journey: { sessionInactivityMinutes: journeySessionInactivityMinutes } },
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
      for (const timer of database.__scheduleTimers ?? []) database.clock.clearTimer(timer);
      database.__scheduleTimers?.clear?.();
      if (database.__jobWakeTimer) { database.clock.clearTimer(database.__jobWakeTimer); database.__jobWakeTimer = null; }
      const sqliteResult = database.sqlite.close();
      const storageResult = database.fileStorage.close();
      return storageResult ?? sqliteResult;
    },
  };
  database.init = async () => {
    if (database.__runtimeInitialized) return;
    if (database.lifecycleHooks.init !== undefined) {
      if (typeof database.lifecycleHooks.init !== "function") throw commandError("Invalid Capsule init hook.", "Declare hooks.init as a function.");
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
    for (const timer of database.__scheduleTimers ?? []) database.clock.clearTimer(timer);
    database.__scheduleTimers?.clear?.();
    database.__scheduleRecoveryTimer = null;
    database.__scheduleRecoveryDueAt = null;
    await Promise.allSettled([...(database.__activeScheduleOccurrences ?? [])]);
    if (database.__runtimeInitialized && database.lifecycleHooks.shutdown !== undefined) {
      if (typeof database.lifecycleHooks.shutdown !== "function") throw commandError("Invalid Capsule shutdown hook.", "Declare hooks.shutdown as a function.");
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

function resolveJourneySessionInactivityMinutes(config: RuntimeConfig = {}) {
  const value = config.journey?.sessionInactivityMinutes;
  if (typeof value !== "number" || !Number.isFinite(value)) return 30;
  return Math.min(1_440, Math.max(1, Math.round(value)));
}

function scheduleDefinitionsFromCapsule(capsuleDefinition: any, jobs: any[]) {
  const schedules: any[] = [];
  for (const [name, definition] of Object.entries(capsuleDefinition?.schedules ?? {}) as [string, any][]) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw commandError(`Invalid Schedule name: ${name}`, "Begin Schedule names with a letter and use only letters, numbers, underscores, or hyphens.");
    if (!definition || definition.kind !== "schedule" || Object.keys(definition).some((key) => !["kind", "expression", "timezone", "job", "payload", "retry", "missedRun", "enabled"].includes(key))) throw commandError(`Invalid Schedule declaration: ${name}`, "Declare each Schedule with schedule({ expression, timezone?, job, payload?, retry?, missedRun?, enabled? }).");
    if (schedules.some((candidate) => candidate.name === name)) throw commandError(`Duplicate Schedule declaration: ${name}`, "Use one unique Schedule name per Capsule.");
    if (typeof definition.job !== "string" || !jobs.some((candidate) => candidate.name === definition.job)) throw commandError(`Unknown Job handler for Schedule: ${name}`, "Reference a Job declared in the Capsule jobs map.");
    const expression = parseScheduleExpression(definition.expression);
    const effectiveTimezone = resolveScheduleTimezone(definition.timezone);
    const payload = definition.payload === undefined ? null : definition.payload;
    if (typeof payload !== "function") boundedJobJson(payload, 64 * 1024, "JOB_PAYLOAD_TOO_LARGE", "Schedule payload");
    const retry = normalizeJobRetry(definition.retry);
    const missedRun = definition.missedRun ?? "skip";
    if (missedRun !== "skip" && missedRun !== "latest") throw commandError(`Invalid missed-run policy for Schedule: ${name}`, "Use `skip` or `latest`.");
    if (definition.enabled !== undefined && typeof definition.enabled !== "boolean") throw commandError(`Invalid enabled value for Schedule: ${name}`, "Pass true or false for enabled.");
    const normalizedExpression = definition.expression.trim().replace(/\s+/g, " ");
    const enabled = definition.enabled ?? true;
    const fingerprint = JSON.stringify({ expression: normalizedExpression, timezone: effectiveTimezone, job: definition.job, payload: typeof payload === "function" ? String(payload) : payload, retry, missedRun });
    schedules.push({ name, expression: normalizedExpression, fields: expression, effectiveTimezone, job: definition.job, payload, retry, missedRun, enabled, fingerprint });
  }
  return schedules;
}

function resolveSchedulePayloadFactoryTimeoutMs(config: RuntimeConfig = {}) {
  const scheduling = config.scheduling;
  if (scheduling === undefined) return 30_000;
  if (!scheduling || typeof scheduling !== "object" || Array.isArray(scheduling) || Object.keys(scheduling).some((key) => key !== "payloadFactoryTimeoutSeconds")) {
    throw commandError("Invalid scheduling configuration.", "Set `scheduling.payloadFactoryTimeoutSeconds` to an integer from 1 through 300.");
  }
  const seconds = scheduling.payloadFactoryTimeoutSeconds ?? 30;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
    throw commandError("Invalid Schedule payload factory timeout.", "Set `scheduling.payloadFactoryTimeoutSeconds` to an integer from 1 through 300.");
  }
  return seconds * 1000;
}

function parseScheduleExpression(value: any) {
  if (typeof value !== "string") throw commandError("Invalid Schedule expression.", "Pass a numeric five-field cron expression.");
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 5) throw commandError(`Unsupported Schedule expression: ${value}`, "Use exactly five numeric cron fields; seconds, years, and nicknames are unsupported.");
  const ranges = [[0,59],[0,23],[1,31],[1,12],[0,7]];
  const fields: any = parts.map((part, index) => {
    const values = new Set<number>();
    for (const item of part.split(",")) {
      const [base, stepText] = item.split("/");
      if (item.split("/").length > 2 || (stepText !== undefined && (!/^\d+$/.test(stepText) || Number(stepText) < 1))) throw commandError(`Unsupported Schedule expression: ${value}`, "Use numeric cron fields with lists, ranges, and positive steps.");
      const step = stepText === undefined ? 1 : Number(stepText);
      let start: number, end: number;
      if (base === "*") [start,end] = ranges[index];
      else if (/^\d+$/.test(base)) start = end = Number(base);
      else { const match = /^(\d+)-(\d+)$/.exec(base); if (!match) throw commandError(`Unsupported Schedule expression: ${value}`, "Use numeric cron fields with lists, ranges, and steps."); start=Number(match[1]); end=Number(match[2]); }
      if (start < ranges[index][0] || end > ranges[index][1] || start > end) throw commandError(`Invalid Schedule expression: ${value}`, "Keep each cron value inside its field range.");
      for (let current=start; current<=end; current+=step) values.add(index === 4 && current === 7 ? 0 : current);
    }
    return values;
  });
  fields.restricted = parts.map((part) => part !== "*");
  return fields;
}

function resolveScheduleTimezone(value: any) {
  if (value !== undefined && (typeof value !== "string" || value.trim() === "")) throw commandError("Invalid Schedule timezone.", "Pass an available IANA timezone name.");
  const requested = value === undefined ? Intl.DateTimeFormat().resolvedOptions().timeZone : value.trim();
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: requested }).resolvedOptions().timeZone;
  } catch {
    throw commandError(`Invalid Schedule timezone: ${String(requested)}`, "Pass an available IANA timezone name from the runtime timezone database.");
  }
}

function scheduleWallClockParts(formatter: Intl.DateTimeFormat, instant: Date) {
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { minute: Number(parts.minute), hour: Number(parts.hour), day: Number(parts.day), month: Number(parts.month), weekday: weekdays[parts.weekday] };
}

function nextScheduleOccurrence(fields: Set<number>[], after: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const candidate = new Date(after.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  // Eight years covers the longest gap between valid annual Gregorian dates:
  // leap day immediately before a non-leap century (for example 2096 to 2104).
  for (let count=0; count < 8 * 366 * 24 * 60; count++, candidate.setUTCMinutes(candidate.getUTCMinutes()+1)) {
    const local = scheduleWallClockParts(formatter, candidate);
    const dom = fields[2].has(local.day); const dow = fields[4].has(local.weekday);
    const domRestricted = (fields as any).restricted?.[2] ?? fields[2].size !== 31; const dowRestricted = (fields as any).restricted?.[4] ?? fields[4].size !== 7;
    const dayMatches = domRestricted && dowRestricted ? dom || dow : dom && dow;
    if (fields[0].has(local.minute) && fields[1].has(local.hour) && dayMatches && fields[3].has(local.month)) return new Date(candidate);
  }
  throw commandError("Schedule has no future occurrence.", "Check the Schedule cron expression.");
}

async function ensureScheduleStorage(sqlite: LooseRecord) {
  await sqlite.exec("CREATE TABLE IF NOT EXISTS sporades_schedules (name TEXT PRIMARY KEY, definitionFingerprint TEXT NOT NULL, expression TEXT NOT NULL, effectiveTimezone TEXT NOT NULL, missedRunPolicy TEXT NOT NULL, enabled INTEGER NOT NULL, nextOccurrence TEXT, latestScheduledFor TEXT, latestOutcome TEXT, latestJobId TEXT, latestErrorCode TEXT)");
  await sqlite.exec("CREATE TABLE IF NOT EXISTS sporades_schedule_occurrences (id TEXT PRIMARY KEY, scheduleName TEXT NOT NULL, scheduledFor TEXT NOT NULL, status TEXT NOT NULL, claimToken TEXT, claimExpiresAt TEXT, jobId TEXT, errorCode TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)");
  await sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS sporades_schedule_occurrence_identity ON sporades_schedule_occurrences(scheduleName, scheduledFor)");
}

async function reconcileSchedules(database: LooseRecord) {
  const now = database.clock.now();
  const declaredNames = new Set(database.schedules.map((definition: any) => definition.name));
  const persisted = await database.sqlite.prepare("SELECT * FROM sporades_schedules").all();
  const plans = [];
  for (const definition of database.schedules) {
    const row = persisted.find((candidate: any) => candidate.name === definition.name);
    const changed = !row || row.definitionFingerprint !== definition.fingerprint || Boolean(row.enabled) !== definition.enabled;
    let nextOccurrence: string | null = null;
    let recoveredOccurrence: Date | null = null;
    if (definition.enabled) {
      if (changed || !row?.nextOccurrence) {
        nextOccurrence = nextScheduleOccurrence(definition.fields, now, definition.effectiveTimezone).toISOString();
      } else {
        nextOccurrence = String(row.nextOccurrence);
        if (Date.parse(nextOccurrence) <= now.getTime()) {
          let latest = new Date(nextOccurrence);
          let future = nextScheduleOccurrence(definition.fields, latest, definition.effectiveTimezone);
          while (future.getTime() <= now.getTime()) { latest = future; future = nextScheduleOccurrence(definition.fields, latest, definition.effectiveTimezone); }
          nextOccurrence = future.toISOString();
          if (definition.missedRun === "latest") recoveredOccurrence = latest;
        }
      }
    }
    plans.push({ definition, row, nextOccurrence, recoveredOccurrence });
  }
  // Every declaration, including calendars with no possible future instant,
  // has now been evaluated without mutating durable state.
  for (const row of persisted) {
    if (!declaredNames.has(String(row.name))) await database.sqlite.prepare("DELETE FROM sporades_schedules WHERE name=?").run(row.name);
  }
  for (const { definition, row, nextOccurrence } of plans) {
    if (row) await database.sqlite.prepare("UPDATE sporades_schedules SET definitionFingerprint=?, expression=?, effectiveTimezone=?, missedRunPolicy=?, enabled=?, nextOccurrence=? WHERE name=?").run(definition.fingerprint, definition.expression, definition.effectiveTimezone, definition.missedRun, definition.enabled ? 1 : 0, nextOccurrence, definition.name);
    else {
      try {
        await database.sqlite.prepare("INSERT INTO sporades_schedules (name, definitionFingerprint, expression, effectiveTimezone, missedRunPolicy, enabled, nextOccurrence) VALUES (?, ?, ?, ?, ?, ?, ?)").run(definition.name, definition.fingerprint, definition.expression, definition.effectiveTimezone, definition.missedRun, definition.enabled ? 1 : 0, nextOccurrence);
      } catch (error) {
        const concurrent = await database.sqlite.prepare("SELECT name FROM sporades_schedules WHERE name=?").get(definition.name);
        if (!concurrent) throw error;
        await database.sqlite.prepare("UPDATE sporades_schedules SET definitionFingerprint=?, expression=?, effectiveTimezone=?, missedRunPolicy=?, enabled=?, nextOccurrence=? WHERE name=?").run(definition.fingerprint, definition.expression, definition.effectiveTimezone, definition.missedRun, definition.enabled ? 1 : 0, nextOccurrence, definition.name);
      }
    }
    definition.nextOccurrence = nextOccurrence;
  }
  for (const { definition, recoveredOccurrence } of plans) {
    if (recoveredOccurrence) await recordScheduledOccurrence(database, definition, recoveredOccurrence);
  }
  await recoverPendingScheduleOccurrences(database);
}

async function startStaticSchedules(database: LooseRecord) {
  database.__scheduleTimers ??= new Set();
  database.__activeScheduleOccurrences ??= new Set();
  for (const definition of database.schedules) {
    if (!definition.enabled) continue;
    const arm = () => {
      if (database.__scheduleStopped) return;
      const occurrence = new Date(definition.nextOccurrence);
      const timer = database.clock.setTimer(() => {
        database.__scheduleTimers.delete(timer);
        const active = recordScheduledOccurrence(database, definition, occurrence).catch(async (error: any) => {
          database.log.emit({ category: "platform", event: "schedule.occurrence.enqueue_failed", level: "error", message: "Scheduled occurrence could not enqueue its Job", data: { scheduleName: definition.name, scheduledFor: occurrence.toISOString(), code: String(error?.code ?? "SCHEDULE_ENQUEUE_FAILED").slice(0, 80) } });
          if (!database.__scheduleStopped) await finishFailedScheduledOccurrence(database, definition, occurrence, error);
        }).finally(() => {
          database.__activeScheduleOccurrences.delete(active);
          if (database.__scheduleStopped) return;
          arm();
        });
        database.__activeScheduleOccurrences.add(active);
        return active;
      }, Math.max(0, occurrence.getTime()-database.clock.now().getTime()));
      database.__scheduleTimers.add(timer);
    };
    arm();
  }
}

async function finishFailedScheduledOccurrence(database: LooseRecord, definition: any, occurrence: Date, error: any) {
  const scheduledFor = occurrence.toISOString();
  const id = scheduledOccurrenceIdentity(database, definition.name, scheduledFor);
  const completedAt = database.clock.now().toISOString();
  const code = "SCHEDULE_ENQUEUE_FAILED";
  await database.sqlite.prepare("UPDATE sporades_schedule_occurrences SET status='enqueue-failed', claimToken=NULL, claimExpiresAt=NULL, errorCode=?, updatedAt=? WHERE id=? AND status='pending'").run(code, completedAt, id);
  const next = nextScheduleOccurrence(definition.fields, occurrence, definition.effectiveTimezone).toISOString();
  definition.nextOccurrence = next;
  await database.sqlite.prepare("UPDATE sporades_schedules SET nextOccurrence=?, latestScheduledFor=?, latestOutcome='payload-failed', latestJobId=NULL, latestErrorCode=? WHERE name=? AND enabled=1").run(next, scheduledFor, code, definition.name);
}

async function recordScheduledOccurrence(database: LooseRecord, definition: any, occurrence: Date) {
  const claim = await claimScheduledOccurrence(database, definition, occurrence);
  if (!claim) {
    // Another runtime owns this exact occurrence. Advance only this runtime's
    // timer cursor; the winner owns durable Schedule bookkeeping.
    definition.nextOccurrence = nextScheduleOccurrence(definition.fields, occurrence, definition.effectiveTimezone).toISOString();
    return null;
  }
  await database.scheduleOccurrenceFault?.("after-pending", { scheduleName: definition.name, scheduledFor: occurrence.toISOString() });
  const state = await enqueueScheduledOccurrence(database, definition, occurrence);
  if (state) await database.scheduleOccurrenceFault?.("after-enqueue", { scheduleName: definition.name, scheduledFor: occurrence.toISOString(), jobId: state.id });
  const completedAt = database.clock.now().toISOString();
  await database.sqlite.prepare("UPDATE sporades_schedule_occurrences SET status=?, claimToken=NULL, claimExpiresAt=NULL, jobId=?, errorCode=?, updatedAt=? WHERE id=? AND claimToken=?").run(state ? "enqueued" : "payload-failed", state?.id ?? null, state ? null : "SCHEDULE_PAYLOAD_FAILED", completedAt, claim.id, claim.token);
  if (database.__scheduleStopped) return state;
  const next = nextScheduleOccurrence(definition.fields, occurrence, definition.effectiveTimezone).toISOString();
  definition.nextOccurrence = next;
  await database.sqlite.prepare("UPDATE sporades_schedules SET nextOccurrence=?, latestScheduledFor=?, latestOutcome=?, latestJobId=?, latestErrorCode=? WHERE name=? AND enabled=1").run(next, occurrence.toISOString(), state ? "enqueued" : "payload-failed", state?.id ?? null, state ? null : "SCHEDULE_PAYLOAD_FAILED", definition.name);
  return state;
}

function scheduledOccurrenceIdentity(database: LooseRecord, scheduleName: string, scheduledFor: string) {
  return createHash("sha256").update(JSON.stringify([database.capsuleIdentity, scheduleName, scheduledFor])).digest("hex");
}

async function claimScheduledOccurrence(database: LooseRecord, definition: any, occurrence: Date) {
  const scheduledFor = occurrence.toISOString();
  const id = scheduledOccurrenceIdentity(database, definition.name, scheduledFor);
  const token = randomUUID();
  const now = database.clock.now();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + 30_000).toISOString();
  try {
    await database.sqlite.prepare("INSERT INTO sporades_schedule_occurrences (id, scheduleName, scheduledFor, status, claimToken, claimExpiresAt, createdAt, updatedAt) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)").run(id, definition.name, scheduledFor, token, expiresAt, nowIso, nowIso);
    return { id, token };
  } catch (error) {
    const existing = await database.sqlite.prepare("SELECT status, claimExpiresAt FROM sporades_schedule_occurrences WHERE id=?").get(id);
    if (!existing) throw error;
    if (existing.status !== "pending") return null;
    if (existing.claimExpiresAt && existing.claimExpiresAt > nowIso) {
      schedulePendingOccurrenceRecovery(database, existing.claimExpiresAt);
      return null;
    }
    const result = await database.sqlite.prepare("UPDATE sporades_schedule_occurrences SET claimToken=?, claimExpiresAt=?, updatedAt=? WHERE id=? AND status='pending' AND (claimExpiresAt IS NULL OR claimExpiresAt <= ?)").run(token, expiresAt, nowIso, id, nowIso);
    return Number(result.changes) === 1 ? { id, token } : null;
  }
}

async function recoverPendingScheduleOccurrences(database: LooseRecord) {
  const rows = await database.sqlite.prepare("SELECT scheduleName, scheduledFor FROM sporades_schedule_occurrences WHERE status='pending' AND (claimExpiresAt IS NULL OR claimExpiresAt <= ?) ORDER BY scheduledFor ASC, scheduleName ASC").all(database.clock.now().toISOString());
  for (const row of rows) {
    const definition = database.schedules.find((candidate: any) => candidate.enabled && candidate.name === row.scheduleName);
    if (definition) await recordScheduledOccurrence(database, definition, new Date(row.scheduledFor));
  }
  const next = await database.sqlite.prepare("SELECT claimExpiresAt FROM sporades_schedule_occurrences WHERE status='pending' AND claimExpiresAt IS NOT NULL ORDER BY claimExpiresAt ASC LIMIT 1").get();
  if (next?.claimExpiresAt) schedulePendingOccurrenceRecovery(database, String(next.claimExpiresAt));
}

function schedulePendingOccurrenceRecovery(database: LooseRecord, claimExpiresAt: string) {
  if (database.__scheduleStopped) return;
  const dueAt = Date.parse(claimExpiresAt);
  if (!Number.isFinite(dueAt)) return;
  if (database.__scheduleRecoveryTimer && database.__scheduleRecoveryDueAt <= dueAt) return;
  if (database.__scheduleRecoveryTimer) {
    database.clock.clearTimer(database.__scheduleRecoveryTimer);
    database.__scheduleTimers?.delete(database.__scheduleRecoveryTimer);
  }
  database.__scheduleRecoveryDueAt = dueAt;
  const timer = database.clock.setTimer(() => {
    database.__scheduleTimers?.delete(timer);
    database.__scheduleRecoveryTimer = null;
    database.__scheduleRecoveryDueAt = null;
    if (database.__scheduleStopped) return;
    const active = recoverPendingScheduleOccurrences(database).catch((error: any) => {
      database.log.emit({ category: "platform", event: "schedule.occurrence.recovery_failed", level: "error", message: "Pending Scheduled occurrence recovery failed", data: { code: String(error?.code ?? "SCHEDULE_RECOVERY_FAILED").slice(0, 80) } });
    }).finally(() => database.__activeScheduleOccurrences?.delete(active));
    database.__activeScheduleOccurrences?.add(active);
    return active;
  }, Math.max(0, dueAt - database.clock.now().getTime()));
  database.__scheduleRecoveryTimer = timer;
  database.__scheduleTimers?.add(timer);
}

export async function enqueueScheduledOccurrence(database: LooseRecord, definition: any, occurrence: Date) {
  const scheduledFor = occurrence.toISOString();
  const provenance = `schedule:${scheduledOccurrenceIdentity(database, definition.name, scheduledFor)}`;
  const context: LooseRecord = createMutationContext(database, { userId: provenance, displayName: "Schedule", email: null, picture: null, isAuthenticated: false, isGuest: false, provider: "schedule" });
  const payload = await resolveSchedulePayload(database, definition, scheduledFor, context);
  if (!payload.ok) return null;
  database.jobScheduleProvenanceByContext.set(context, { scheduleName: definition.name, scheduledFor });
  const state = await context.privileged.run({ operation: "schedules.enqueue", targetResourceKind: "job-queue", metadata: { scheduleName: definition.name, scheduledFor } },
    (privilegedContext: any) => privilegedContext.jobs.enqueue(definition.job, payload.value, { retry: definition.retry, idempotencyKey: provenance }));
  return state;
}

async function acquireSchedulePayloadFactorySlot(database: LooseRecord) {
  if (database.schedulePayloadFactoryActive >= 4) await new Promise<void>((resolve) => database.schedulePayloadFactoryWaiters.push(resolve));
  database.schedulePayloadFactoryActive += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    database.schedulePayloadFactoryActive -= 1;
    database.schedulePayloadFactoryWaiters.shift()?.();
  };
}

async function acquireSchedulePayloadFactoryLane(database: LooseRecord, scheduleName: string) {
  const previous = database.schedulePayloadFactoryLanes.get(scheduleName);
  let unlock: () => void = () => {};
  const current = new Promise<void>((resolve) => { unlock = resolve; });
  database.schedulePayloadFactoryLanes.set(scheduleName, current);
  if (previous) await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unlock();
    if (database.schedulePayloadFactoryLanes.get(scheduleName) === current) database.schedulePayloadFactoryLanes.delete(scheduleName);
  };
}

async function resolveSchedulePayload(database: LooseRecord, definition: any, scheduledFor: string, context: LooseRecord) {
  if (typeof definition.payload !== "function") return { ok: true, value: definition.payload };
  const releaseLane = await acquireSchedulePayloadFactoryLane(database, definition.name);
  let releaseSlot: (() => void) | undefined;
  const controller = new AbortController();
  const controllers = database.schedulePayloadFactoryControllers.get(definition.name) ?? new Set();
  controllers.add(controller);
  database.schedulePayloadFactoryControllers.set(definition.name, controllers);
  const occurrence = Object.freeze({ scheduleName: definition.name, scheduledFor });
  const factoryContext = Object.freeze({ signal: controller.signal, privileged: context.privileged });
  let timeout: any;
  try {
    releaseSlot = await acquireSchedulePayloadFactorySlot(database);
    const timeoutFailure = new Promise((_resolve, reject) => {
      timeout = database.clock.setTimer(() => {
        controller.abort();
        const error: any = new Error("Schedule payload factory timed out.");
        error.code = "SCHEDULE_PAYLOAD_FACTORY_TIMEOUT";
        reject(error);
      }, database.schedulePayloadFactoryTimeoutMs);
    });
    const aborted = new Promise((_resolve, reject) => controller.signal.addEventListener("abort", () => {
      const error: any = new Error("Schedule payload factory aborted.");
      error.code = "SCHEDULE_PAYLOAD_FACTORY_ABORTED";
      reject(error);
    }, { once: true }));
    const value = await Promise.race([Promise.resolve().then(() => definition.payload(occurrence, factoryContext)), timeoutFailure, aborted]);
    database.clock.clearTimer(timeout);
    boundedJobJson(value, 64 * 1024, "JOB_PAYLOAD_TOO_LARGE", "Schedule payload");
    return { ok: true, value };
  } catch (error: any) {
    database.clock.clearTimer(timeout);
    const code = error?.code === "SCHEDULE_PAYLOAD_FACTORY_TIMEOUT" ? error.code
      : error?.code === "INVALID_JOB_PAYLOAD" || error?.code === "JOB_PAYLOAD_TOO_LARGE" ? `SCHEDULE_PAYLOAD_${error.code}`
      : "SCHEDULE_PAYLOAD_FACTORY_FAILED";
    await database.log.emit({ category: "platform", event: "schedule.occurrence.payload_failed", level: "error", message: "Scheduled occurrence payload creation failed", data: { scheduleName: definition.name, scheduledFor, code } });
    return { ok: false };
  } finally {
    controllers.delete(controller);
    if (controllers.size === 0) database.schedulePayloadFactoryControllers.delete(definition.name);
    releaseSlot?.();
    releaseLane();
  }
}

function abortSchedulePayloadFactories(database: LooseRecord) {
  for (const controllers of database.schedulePayloadFactoryControllers?.values?.() ?? []) for (const controller of controllers) controller.abort();
}

async function recoverExpiredJobLeases(database: LooseRecord) {
  const recoveredAt = database.clock.now(); const recoveredIso = recoveredAt.toISOString();
  const rows = await database.sqlite.prepare("SELECT * FROM sporades_jobs WHERE status='running' AND leaseExpiresAt IS NOT NULL AND leaseExpiresAt <= ? ORDER BY availableAt ASC, id ASC").all(recoveredIso);
  for (const row of rows) { const retry=JSON.parse(row.retryJson||'{"maxAttempts":1,"delayMs":0}'); const history=JSON.parse(row.attemptHistory||"[]"); history.push({attempt:Number(row.attempts),outcome:"interrupted",code:"JOB_LEASE_EXPIRED",completedAt:recoveredIso}); if(Number(row.attempts)<retry.maxAttempts) { const availableAt=new Date(recoveredAt.getTime()+retry.delayMs).toISOString(); await database.sqlite.prepare("UPDATE sporades_jobs SET status='delayed', availableAt=?, leaseExpiresAt=NULL, attemptHistory=? WHERE id=?").run(availableAt,JSON.stringify(history),row.id); database.clock.setTimer(()=>scheduleCurrentUserJobWorker(database),retry.delayMs+1); } else await database.sqlite.prepare("UPDATE sporades_jobs SET status='failed', failure=?, failedAt=?, leaseExpiresAt=NULL, attemptHistory=? WHERE id=?").run(JSON.stringify({code:"JOB_LEASE_EXPIRED",message:"Job lease expired."}),recoveredIso,JSON.stringify(history),row.id); }
  if(rows.some((row: any) => Number(row.attempts) < JSON.parse(row.retryJson||'{"maxAttempts":1}').maxAttempts)) scheduleCurrentUserJobWorker(database);
}

function createRuntimeClock(clock: LooseRecord | undefined) {
  if (clock) return clock;
  return {
    now: () => new Date(),
    setTimer: (callback: () => any, delayMs: number) => setTimeout(callback, delayMs),
    clearTimer: (timer: any) => clearTimeout(timer),
  };
}

/** Internal full-runtime test support; not exported from sporades/server or sporades/client. */
export function createControllableRuntimeClock(initialInstant: string | number | Date) {
  let nowMs = new Date(initialInstant).getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("Invalid initial runtime clock instant.");
  let nextId = 1;
  const timers = new Map<number, { id: number; dueAt: number; callback: () => any }>();
  return {
    now: () => new Date(nowMs),
    setInstant(instant: string | number | Date) {
      const next = new Date(instant).getTime();
      if (!Number.isFinite(next)) throw new TypeError("Invalid runtime clock instant.");
      nowMs = next;
    },
    advanceBy(delayMs: number) {
      if (!Number.isFinite(delayMs) || delayMs < 0) throw new TypeError("Runtime clock advance must be non-negative.");
      nowMs += delayMs;
    },
    setTimer(callback: () => any, delayMs: number) {
      const id = nextId++;
      timers.set(id, { id, dueAt: nowMs + Math.max(0, delayMs), callback });
      return id;
    },
    clearTimer(id: number) { timers.delete(id); },
    async runDueTimers() {
      while (true) {
        const due = [...timers.values()].filter((timer) => timer.dueAt <= nowMs)
          .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
        if (!due) return;
        timers.delete(due.id);
        await due.callback();
      }
    },
  };
}

function jobHandlersFromCapsuleDefinition(capsuleDefinition: any) {
  const handlers: any[] = [];
  for (const [name, definition] of Object.entries(capsuleDefinition?.jobs ?? {}) as [string, any][]) {
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

async function ensureJobStorage(sqlite: LooseRecord) {
  await sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_jobs (" +
      "id TEXT PRIMARY KEY, handler TEXT NOT NULL, enqueuedByUserId TEXT NOT NULL, actorUserId TEXT NOT NULL, " +
      "payload TEXT NOT NULL, status TEXT NOT NULL, availableAt TEXT NOT NULL, attempts INTEGER NOT NULL, " +
      "idempotencyKey TEXT, result TEXT, failure TEXT, createdAt TEXT NOT NULL, startedAt TEXT, completedAt TEXT, failedAt TEXT)"
  );
  await sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS sporades_jobs_idempotency ON sporades_jobs(handler, actorUserId, idempotencyKey) WHERE idempotencyKey IS NOT NULL");
  await sqlite.exec("CREATE INDEX IF NOT EXISTS sporades_jobs_runnable ON sporades_jobs(status, availableAt, id)");
  const columns = await sqlite.prepare("PRAGMA table_info(sporades_jobs)").all();
  for (const [name, type] of [["retryJson", "TEXT"], ["attemptHistory", "TEXT"], ["cancelRequestedAt", "TEXT"], ["leaseExpiresAt", "TEXT"], ["scheduleName", "TEXT"], ["scheduledFor", "TEXT"]]) if (!columns.some((column: any) => column.name === name)) await sqlite.exec(`ALTER TABLE sporades_jobs ADD COLUMN ${name} ${type}`);
}

async function createRuntimeDatabaseAdapter(databasePath: any, serverEnv: RuntimeEnv = {}, config: RuntimeConfig = {}) {
  if (
    config.services?.database?.engine === "libsql" &&
    serverEnv.SPORADES_SERVICE_DATABASE_ENGINE === "libsql" &&
    serverEnv.SPORADES_SERVICE_DATABASE_URL
  ) {
    return await createLibsqlDatabaseAdapter({
      url: serverEnv.SPORADES_SERVICE_DATABASE_URL,
      authToken: serverEnv.SPORADES_SERVICE_DATABASE_AUTH_TOKEN,
    });
  }
  if (
    config.services?.database?.engine === "postgres" &&
    serverEnv.SPORADES_SERVICE_DATABASE_ENGINE === "postgres" &&
    serverEnv.SPORADES_SERVICE_DATABASE_URL
  ) {
    return await createPostgresDatabaseAdapter({
      url: serverEnv.SPORADES_SERVICE_DATABASE_URL,
    });
  }
  return await createSqliteDatabaseAdapter(databasePath);
}

export async function createRuntimeInspectionAdapter(databasePath: any, serverEnv: RuntimeEnv = {}, config: RuntimeConfig = {}): Promise<LooseRecord | null> {
  if (config.services?.database?.engine === "libsql" && serverEnv.SPORADES_SERVICE_DATABASE_ENGINE === "libsql" && serverEnv.SPORADES_SERVICE_DATABASE_URL) {
    return await createLibsqlDatabaseAdapter({ url: serverEnv.SPORADES_SERVICE_DATABASE_URL, authToken: serverEnv.SPORADES_SERVICE_DATABASE_AUTH_TOKEN });
  }
  if (config.services?.database?.engine === "postgres" && serverEnv.SPORADES_SERVICE_DATABASE_ENGINE === "postgres" && serverEnv.SPORADES_SERVICE_DATABASE_URL) {
    return await createPostgresDatabaseAdapter({ url: serverEnv.SPORADES_SERVICE_DATABASE_URL });
  }
  if (!existsSync(String(databasePath))) return null;
  return await createSqliteDatabaseAdapter(databasePath, { readOnly: true });
}

export async function createRuntimeFileStorageAdapter({ config = {}, databasePath, serviceEnv = {} }: { config?: RuntimeConfig; databasePath: string; serviceEnv?: RuntimeEnv }) {
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

export function createLocalFileStorageAdapter({ storagePath }: { storagePath: string }) {
  if (typeof storagePath !== "string" || storagePath.length === 0) {
    throw new Error("Local file storage requires a storagePath.");
  }

  return {
    engine: "local",
    storagePath,
    async writeFileVersion({ fileId, version, bytes }: { fileId: string; version: string | number; bytes: Uint8Array | Buffer | string }) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(localFileStoragePath(storagePath, fileId), { recursive: true });
      await writeFile(localFileVersionPath(storagePath, fileId, version), bytes);
    },
    async readFileVersion({ fileId, version }: { fileId: string; version: string | number }) {
      const { readFile } = await import("node:fs/promises");
      return await readFile(localFileVersionPath(storagePath, fileId, version));
    },
    async deleteFileVersion({ fileId, version }: { fileId: string; version: string | number }) {
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
      } catch {
        await rm(probeFile, { force: true }).catch(() => { });
        return { ok: false };
      }
    },
    close() { },
  };
}

function localFileStoragePath(storagePath: string, fileId: string) {
  return `${storagePath}/${fileId}`;
}

function localFileVersionPath(storagePath: string, fileId: string, version: string | number) {
  return `${localFileStoragePath(storagePath, fileId)}/${version}`;
}

export function createS3CompatibleFileStorageAdapter({
  endpoint,
  bucket,
  region,
  accessKey,
  secretKey,
  namespace,
}: {
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  namespace: string;
}) {
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
    } else if (head.statusCode < 200 || head.statusCode >= 300) {
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
    async writeFileVersion({ fileId, version, bytes }: { fileId: string; version: string | number; bytes: Uint8Array | Buffer | string }) {
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
    async readFileVersion({ fileId, version }: { fileId: string; version: string | number }) {
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
    async deleteFileVersion({ fileId, version }: { fileId: string; version: string | number }) {
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
      } catch {
        return { ok: false, adapter: "s3-compatible" };
      }
    },
    close() { },
  };
}

function s3ObjectKey(namespace: string, fileId: string, version: string | number) {
  return `${namespace}/files/${fileId}/${version}`;
}

async function s3Request(
  config: { endpoint: string; bucket: string; region: string; accessKey: string; secretKey: string },
  { method, key = null, body = null }: { method: string; key: string | null; body?: any },
): Promise<S3RequestResult> {
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

  return await new Promise<S3RequestResult>((resolve, reject) => {
    const request = transport.request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || undefined,
        method,
        path: `${pathname}${endpoint.search}`,
        headers: {
          ...headers,
          "content-length": payload.length,
        },
      },
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: any) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("error", reject);
    if (payload.length > 0) {
      request.write(payload);
    }
    request.end();
  });
}

function s3RequestBodyBuffer(body: WithImplicitCoercion<ArrayLike<number>> | null | undefined) {
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

function s3SignedHeaders(headers: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(headers)
      .map(([name, value]) => [name.toLowerCase(), String(value).trim()])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function s3Signature({
  method,
  pathname,
  query,
  headers,
  payloadHash,
  accessKey,
  secretKey,
  region,
  date,
  amzDate,
}: {
  method: string;
  pathname: string;
  query: string;
  headers: Record<string, string>;
  payloadHash: string;
  accessKey: string;
  secretKey: string;
  region: string;
  date: string;
  amzDate: string;
}) {
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

function s3SigningKey(secretKey: any, date: any, region: any) {
  const dateKey = s3Hmac(`AWS4${secretKey}`, date);
  const dateRegionKey = s3Hmac(dateKey, region);
  const dateRegionServiceKey = s3Hmac(dateRegionKey, "s3");
  return s3Hmac(dateRegionServiceKey, "aws4_request");
}

function s3CanonicalPath(basePath: string, bucket: string, key: string | null) {
  const base = String(basePath ?? "")
    .split("/")
    .filter(Boolean);
  const parts = [...base, bucket, ...(key ? String(key).split("/") : [])].map(s3EncodedPathSegment);
  return `/${parts.join("/")}`;
}

function s3EncodedPathSegment(segment: string | number | boolean) {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function s3StorageNamespace(namespace: string) {
  if (typeof namespace !== "string" || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(namespace)) {
    throw new Error("S3-compatible file storage requires a capsule storage namespace.");
  }
  return `capsules/${namespace}`;
}

function s3AmzDate(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function s3Hmac(key: BinaryLike | NonSharedBuffer | KeyObject, data: BinaryLike) {
  return createHmac("sha256", key).update(data).digest();
}

function s3Sha256Hex(data: BinaryLike | Buffer<ArrayBufferLike>) {
  return createHash("sha256").update(data).digest("hex");
}

function s3ObjectNotFoundError() {
  const error: HelperError = new Error("S3-compatible file object not found.");
  error.code = "ENOENT";
  return error;
}

export async function createSqliteDatabaseAdapter(databasePath: PathLike, options: LooseRecord = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const path = await import("node:path");
  if (!options.readOnly) mkdirSync(path.dirname(String(databasePath)), { recursive: true });
  const connection = new DatabaseSync(databasePath, { readOnly: Boolean(options.readOnly) });

  const adapter = {
    engine: "sqlite",
    exec(sql: string) {
      return connection.exec(sql);
    },
    prepare(sql: string) {
      const statement = connection.prepare(sql);
      return {
        all(...params: any[]) {
          return statement.all(...params);
        },
        get(...params: any[]) {
          return statement.get(...params);
        },
        run(...params: string[]) {
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
    readSystemMetadata(key: string) {
      return this.prepare("SELECT value FROM sporades WHERE key = ?").get(key) ?? null;
    },
    writeSystemMetadata(key: string, value: any) {
      return this.prepare("INSERT OR REPLACE INTO sporades (key, value) VALUES (?, ?)").run(key, value);
    },
    readSchemaMetadata() {
      return this.readSystemMetadata("schema");
    },
    writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: LooseRecord) {
      this.writeSystemMetadata("schemaVersion", schemaVersion);
      this.writeSystemMetadata("schemaHash", schemaHash);
      this.writeSystemMetadata("schema", schemaJson);
    },
    ensureLogStorage() {
      return createLogIndexTables(this);
    },
    insertLogIndexEvent(event: any) {
      return insertLogIndexEvent(this, event);
    },
    pruneLogIndex(limit: any) {
      return pruneLogIndex(this, limit);
    },
    readRecentLogEvents(limit: number | undefined) {
      return readRecentLogEvents(this, limit);
    },
    ensureFileStorage() {
      return createFileStorageTables(this);
    },
    findFileBucket(ownerId: any, name: any) {
      return this.prepare("SELECT * FROM sporades_file_buckets WHERE ownerId = ? AND name = ?").get(ownerId, name) ?? null;
    },
    createFileBucket(row: { id: any; ownerId: any; name: any; createdAt: any; }) {
      return this.prepare("INSERT INTO sporades_file_buckets (id, ownerId, name, createdAt) VALUES (?, ?, ?, ?)").run(
        row.id,
        row.ownerId,
        row.name,
        row.createdAt,
      );
    },
    insertFileRow(row: { id: any; ownerId: any; bucketId: any; bucketName: any; path: any; name: any; type: any; size: any; version: any; status: any; createdAt: any; updatedAt: any; }) {
      return this.prepare(
        "INSERT INTO sporades_files " +
        "(id, ownerId, bucketId, bucketName, path, name, type, size, version, status, createdAt, updatedAt, deletedAt) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      ).run(
        row.id,
        row.ownerId,
        row.bucketId,
        row.bucketName,
        row.path,
        row.name,
        row.type,
        row.size,
        row.version,
        row.status,
        row.createdAt,
        row.updatedAt,
      );
    },
    updatePendingFileRow(row: { bucketId: any; bucketName: any; path: any; name: any; type: any; size: any; version: any; status: any; updatedAt: any; id: any; }) {
      return this.prepare(
        "UPDATE sporades_files SET bucketId = ?, bucketName = ?, path = ?, name = ?, type = ?, size = ?, version = ?, status = ?, updatedAt = ?, deletedAt = NULL WHERE id = ?",
      ).run(row.bucketId, row.bucketName, row.path, row.name, row.type, row.size, row.version, row.status, row.updatedAt, row.id);
    },
    insertFileUpload(row: { id: any; fileId: any; ownerId: any; bucketId: any; bucketName: any; path: any; name: any; type: any; version: any; expectedSize: any; createdAt: any; }) {
      return this.prepare(
        "INSERT INTO sporades_file_uploads " +
        "(id, fileId, ownerId, bucketId, bucketName, path, name, type, version, expectedSize, createdAt) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        row.id,
        row.fileId,
        row.ownerId,
        row.bucketId,
        row.bucketName,
        row.path,
        row.name,
        row.type,
        row.version,
        row.expectedSize,
        row.createdAt,
      );
    },
    selectFileById(fileId: any) {
      return this.prepare("SELECT * FROM sporades_files WHERE id = ?").get(fileId) ?? null;
    },
    selectLiveFileByPath(path: any) {
      return this.prepare("SELECT * FROM sporades_files WHERE path = ? AND deletedAt IS NULL AND status = ?").all(path, "uploaded");
    },
    selectActiveFileByPath(path: any) {
      return this.prepare("SELECT * FROM sporades_files WHERE path = ? AND deletedAt IS NULL AND status IN (?, ?)").all(
        path,
        "pending",
        "uploaded",
      );
    },
    selectPendingFileUploadByPath(path: any) {
      return (
        this.prepare("SELECT * FROM sporades_file_uploads WHERE path = ? ORDER BY createdAt DESC, id DESC LIMIT 1").get(path) ?? null
      );
    },
    selectFileUpload(uploadId: any) {
      return this.prepare("SELECT * FROM sporades_file_uploads WHERE id = ?").get(uploadId) ?? null;
    },
    completeFileUpload(upload: { id: any; fileId: any; version: any; bucketId: any; bucketName: any; path: any; name: any; type: any; ownerId: any; createdAt: any; }, size: any, updatedAt: any) {
      const consumed = this.prepare("DELETE FROM sporades_file_uploads WHERE id = ? AND fileId = ? AND version = ?").run(
        upload.id,
        upload.fileId,
        upload.version,
      );
      if (consumed.changes === 0) {
        return consumed;
      }
      const existing = this.selectFileById(upload.fileId);
      if (existing) {
        if (existing.deletedAt !== null && existing.deletedAt !== undefined) {
          return { changes: 0 };
        }
        return this.prepare(
          "UPDATE sporades_files SET bucketId = ?, bucketName = ?, path = ?, name = ?, type = ?, size = ?, version = ?, status = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL",
        ).run(
          upload.bucketId,
          upload.bucketName,
          upload.path,
          upload.name,
          upload.type,
          size,
          upload.version,
          "uploaded",
          updatedAt,
          upload.fileId,
        );
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
    deleteFileUploadsForPath(path: any) {
      return this.prepare("DELETE FROM sporades_file_uploads WHERE path = ?").run(path);
    },
    deleteFileUploadsForFile(ownerId: any, fileId: any) {
      return this.prepare("DELETE FROM sporades_file_uploads WHERE ownerId = ? AND fileId = ?").run(ownerId, fileId);
    },
    deleteFileUpload(uploadId: any) {
      return this.prepare("DELETE FROM sporades_file_uploads WHERE id = ?").run(uploadId);
    },
    selectPublicFileRow(publicUrlId: any) {
      return (
        this.prepare(
          "SELECT p.id AS publicUrlId, p.fileId, p.version AS publicVersion, p.expiresAt, p.revokedAt, " +
          "f.id, f.ownerId, f.bucketId, f.bucketName, f.path, f.name, f.type, f.size, f.version, f.status, f.createdAt, f.updatedAt, f.deletedAt " +
          "FROM sporades_file_public_urls p JOIN sporades_files f ON f.id = p.fileId " +
          "WHERE p.id = ?",
        ).get(publicUrlId) ?? null
      );
    },
    insertPublicFileUrl(row: { id: any; fileId: any; ownerId: any; version: any; expiresAt: any; createdAt: any; }) {
      return this.prepare(
        "INSERT INTO sporades_file_public_urls (id, fileId, ownerId, version, expiresAt, createdAt, revokedAt) VALUES (?, ?, ?, ?, ?, ?, NULL)",
      ).run(row.id, row.fileId, row.ownerId, row.version, row.expiresAt, row.createdAt);
    },
    revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any) {
      return this.prepare("UPDATE sporades_file_public_urls SET revokedAt = ? WHERE id = ? AND ownerId = ? AND revokedAt IS NULL").run(
        revokedAt,
        publicUrlId,
        ownerId,
      );
    },
    revokePublicFileUrlsForFile(fileId: any, revokedAt: any) {
      return this.prepare("UPDATE sporades_file_public_urls SET revokedAt = ? WHERE fileId = ? AND revokedAt IS NULL").run(
        revokedAt,
        fileId,
      );
    },
    markFileDeleted(fileId: any, deletedAt: any) {
      return this.prepare("UPDATE sporades_files SET deletedAt = ?, updatedAt = ? WHERE id = ?").run(deletedAt, deletedAt, fileId);
    },
    fileRowForOwner(fileId: any, ownerId: any) {
      return (
        this.prepare("SELECT * FROM sporades_files WHERE id = ? AND ownerId = ? AND deletedAt IS NULL AND status = ?").get(
          fileId,
          ownerId,
          "uploaded",
        ) ?? null
      );
    },
    ensureAuthStorage(authConfig: any = null) {
      return createAnonymousAuthTables(this, authConfig);
    },
    ensureUserPreferencesStorage() {
      return createUserPreferencesTables(this);
    },
    readUserPreferences(userId: any) {
      return this.prepare("SELECT userId, value, updatedAt FROM sporades_user_preferences WHERE userId = ?").get(userId) ?? null;
    },
    saveUserPreferences(row: { userId: any; value: any; updatedAt: any; }) {
      return this.prepare(
        "INSERT OR REPLACE INTO sporades_user_preferences (userId, value, updatedAt) VALUES (?, ?, ?)",
      ).run(row.userId, row.value, row.updatedAt);
    },
    findAuthUserByProviderEmail(provider: any, email: any) {
      const row = this.prepare("SELECT id FROM sporades_auth_users WHERE provider = ? AND email = ?").get(provider, email) ?? null;
      return isReservedAuthUserId(row?.id) ? null : row;
    },
    findAuthIdentityByProviderSubject(provider: any, subject: any) {
      const row = this.prepare(
        "SELECT id, userId, provider, subject, email, displayName, picture, createdAt, updatedAt " +
        "FROM sporades_auth_identities WHERE provider = ? AND subject = ?",
      ).get(provider, subject) ?? null;
      return authIdentityRowUnlessReserved(row);
    },
    findLegacyAuthIdentitiesByProviderEmail(provider: any, email: any) {
      const rows = this.prepare(
        "SELECT id, userId, provider, subject, email, displayName, picture, createdAt, updatedAt " +
        "FROM sporades_auth_identities WHERE provider = ? AND email = ? AND subject LIKE 'legacy:%' ORDER BY createdAt, id",
      ).all(provider, email);
      return authIdentityRowsUnlessReserved(rows);
    },
    insertAuthIdentity(row: { id: any; userId: any; provider: any; subject: any; email: any; displayName: any; picture: any; createdAt: any; updatedAt: any; }) {
      assertNotReservedAuthUserId(row.userId);
      return this.prepare(
        "INSERT INTO sporades_auth_identities " +
        "(id, userId, provider, subject, email, displayName, picture, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(row.id, row.userId, row.provider, row.subject, row.email, row.displayName, row.picture, row.createdAt, row.updatedAt);
    },
    updateAuthIdentity(row: { id: any; subject: any; email: any; displayName: any; picture: any; updatedAt: any; }) {
      return this.prepare(
        "UPDATE sporades_auth_identities SET subject = ?, email = ?, displayName = ?, picture = ?, updatedAt = ? WHERE id = ?",
      ).run(row.subject, row.email, row.displayName, row.picture, row.updatedAt, row.id);
    },
    insertAuthUser(row: { id: any; createdAt: any; displayName: any; email: any; picture: any; isAuthenticated: any; isGuest: any; provider: any; }) {
      assertNotReservedAuthUserId(row.id);
      return this.prepare(
        "INSERT INTO sporades_auth_users " +
        "(id, createdAt, displayName, email, picture, isAuthenticated, isGuest, provider) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(row.id, row.createdAt, row.displayName, row.email, row.picture, row.isAuthenticated, row.isGuest, row.provider);
    },
    updateAuthUserProfile(row: { displayName: any; picture: any; isAuthenticated: any; isGuest: any; id: any; }) {
      assertNotReservedAuthUserId(row.id);
      return this.prepare(
        "UPDATE sporades_auth_users SET displayName = ?, picture = ?, isAuthenticated = ?, isGuest = ? WHERE id = ?",
      ).run(row.displayName, row.picture, row.isAuthenticated, row.isGuest, row.id);
    },
    linkAuthUser(row: { displayName: any; email: any; picture: any; isAuthenticated: any; isGuest: any; provider: any; id: any; }) {
      assertNotReservedAuthUserId(row.id);
      return this.prepare(
        "UPDATE sporades_auth_users SET displayName = ?, email = ?, picture = ?, isAuthenticated = ?, isGuest = ?, provider = ? WHERE id = ?",
      ).run(row.displayName, row.email, row.picture, row.isAuthenticated, row.isGuest, row.provider, row.id);
    },
    insertAuthSession(row: { token: any; userId: any; provider: any; createdAt: any; expiresAt: any; }) {
      assertNotReservedAuthUserId(row.userId);
      return this.prepare("INSERT INTO sporades_auth_sessions (token, userId, provider, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?)").run(
        row.token,
        row.userId,
        row.provider,
        row.createdAt,
        row.expiresAt,
      );
    },
    deleteAuthSession(token: any) {
      return this.prepare("DELETE FROM sporades_auth_sessions WHERE token = ?").run(token);
    },
    refreshAuthSession(token: any, expiresAt: any) {
      return this.prepare("UPDATE sporades_auth_sessions SET expiresAt = ? WHERE token = ?").run(expiresAt, token);
    },
    setAuthSessionProvider(token: any, provider: any) {
      return this.prepare("UPDATE sporades_auth_sessions SET provider = ? WHERE token = ?").run(provider, token);
    },
    rotateAuthSession(previousToken: any, row: { token: any; userId: any; provider: any; createdAt: any; expiresAt: any; }) {
      assertNotReservedAuthUserId(row.userId);
      return this.prepare("UPDATE sporades_auth_sessions SET token = ?, userId = ?, provider = ?, createdAt = ?, expiresAt = ? WHERE token = ?").run(
        row.token,
        row.userId,
        row.provider,
        row.createdAt,
        row.expiresAt,
        previousToken,
      );
    },
    readAuthSessionWithUser(token: any) {
      const row = this.prepare(
        "SELECT s.token, s.expiresAt, u.id AS userId, u.displayName, u.email, u.picture, u.isAuthenticated, u.isGuest, " +
        "COALESCE(s.provider, u.provider) AS provider " +
        "FROM sporades_auth_sessions s " +
        "JOIN sporades_auth_users u ON u.id = s.userId " +
        "WHERE s.token = ?",
      ).get(token) ?? null;
      if (isReservedAuthUserId(row?.userId)) {
        return null;
      }
      return row;
    },
    insertOAuthState(row: LooseRecord) {
      const provider = row.provider ?? "google";
      const expiresAt = row.expiresAt ?? new Date(Date.parse(row.createdAt) + 10 * 60 * 1000).toISOString();
      return this.prepare(
        "INSERT INTO sporades_auth_oauth_states " +
        "(state, provider, sessionToken, returnTo, redirectUri, createdAt, expiresAt, nonce, pkceVerifier) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(row.state, provider, row.sessionToken, row.returnTo, row.redirectUri, row.createdAt, expiresAt, row.nonce ?? null, row.pkceVerifier ?? null);
    },
    consumeOAuthState(state: any) {
      const row =
        this.prepare(
          "SELECT state, provider, sessionToken, returnTo, redirectUri, createdAt, expiresAt, nonce, pkceVerifier " +
          "FROM sporades_auth_oauth_states WHERE state = ?",
        ).get(state) ??
        null;
      this.prepare("DELETE FROM sporades_auth_oauth_states WHERE state = ?").run(state);
      return row;
    },
    emailCredentialExists(email: any) {
      return Boolean(this.prepare("SELECT email FROM sporades_auth_email_credentials WHERE email = ?").get(email));
    },
    insertEmailCredential(row: { email: any; userId: any; passwordHash: any; passwordSalt: any; createdAt: any; }) {
      assertNotReservedAuthUserId(row.userId);
      return this.prepare(
        "INSERT INTO sporades_auth_email_credentials (email, userId, passwordHash, passwordSalt, createdAt) VALUES (?, ?, ?, ?, ?)",
      ).run(row.email, row.userId, row.passwordHash, row.passwordSalt, row.createdAt);
    },
    findEmailCredentialWithUser(email: any) {
      const row = (
        this.prepare(
          "SELECT c.email, c.userId, c.passwordHash, c.passwordSalt, u.displayName, u.picture, u.isAuthenticated, u.isGuest, u.provider " +
          "FROM sporades_auth_email_credentials c " +
          "JOIN sporades_auth_users u ON u.id = c.userId " +
          "WHERE c.email = ?",
        ).get(email) ?? null
      );
      return isReservedAuthUserId(row?.userId) ? null : row;
    },
    migrateAppSchema(schema: { tables: { name: any; acl: { allowByDefault: boolean; } | { allowByDefault: boolean; resolve(operation: any): any; }; fields: { name: any; kind: any; sqliteType: string; targetTable: string | undefined; defaultValue: any; }[]; }[]; } | { tables: { name: string; fields: ({ name: any; kind: any; sqliteType: string; targetTable: any; defaultValue: any; } | null)[]; }[]; }) {
      this.exec("BEGIN");
      try {
        const result = migrateAppSchema(this, schema);
        this.exec("COMMIT");
        return result;
      } catch (error) {
        this.exec("ROLLBACK");
        throw error;
      }
    },
    createAppTable(table: { name: any; }, tableName = table.name) {
      return createAppTable(this, table, tableName);
    },
    migrateExistingAppTable(existingTable: any, nextTable: any) {
      return migrateExistingAppTable(this, existingTable, nextTable);
    },
    referenceExists(field: { targetTable: any; }, value: any) {
      return Boolean(
        this.prepare(`SELECT 1 FROM ${quoteIdentifier(field.targetTable)} WHERE id = ? LIMIT 1`).get(String(value)),
      );
    },
    async withTransaction(fn: (arg0: { engine: string; exec(sql: any): void; prepare(sql: any): { all(...params: any[]): Record<string, SQLOutputValue>[]; get(...params: any[]): Record<string, SQLOutputValue> | undefined; run(...params: any[]): StatementResultingChanges; columns(): StatementColumnMetadata[]; }; ensureSystemTable(): void; readSystemMetadata(key: any): Record<string, SQLOutputValue> | null; writeSystemMetadata(key: any, value: any): StatementResultingChanges; readSchemaMetadata(): Record<string, SQLOutputValue> | null; writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: { schemaVersion: any; schemaHash: any; schemaJson: any; }): void; ensureLogStorage(): void; insertLogIndexEvent(event: any): void; pruneLogIndex(limit: any): void; readRecentLogEvents(limit: any): any; ensureFileStorage(): void; findFileBucket(ownerId: any, name: any): Record<string, SQLOutputValue> | null; createFileBucket(row: any): StatementResultingChanges; insertFileRow(row: any): StatementResultingChanges; updatePendingFileRow(row: any): StatementResultingChanges; insertFileUpload(row: any): StatementResultingChanges; selectFileById(fileId: any): Record<string, SQLOutputValue> | null; selectLiveFileByPath(path: any): Record<string, SQLOutputValue>[]; selectActiveFileByPath(path: any): Record<string, SQLOutputValue>[]; selectPendingFileUploadByPath(path: any): Record<string, SQLOutputValue> | null; selectFileUpload(uploadId: any): Record<string, SQLOutputValue> | null; completeFileUpload(upload: any, size: any, updatedAt: any): StatementResultingChanges | { changes: number; }; deleteFileUploadsForPath(path: any): StatementResultingChanges; deleteFileUploadsForFile(ownerId: any, fileId: any): StatementResultingChanges; deleteFileUpload(uploadId: any): StatementResultingChanges; selectPublicFileRow(publicUrlId: any): Record<string, SQLOutputValue> | null; insertPublicFileUrl(row: any): StatementResultingChanges; revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): StatementResultingChanges; revokePublicFileUrlsForFile(fileId: any, revokedAt: any): StatementResultingChanges; markFileDeleted(fileId: any, deletedAt: any): StatementResultingChanges; fileRowForOwner(fileId: any, ownerId: any): Record<string, SQLOutputValue> | null; ensureAuthStorage(authConfig?: null): void; findAuthUserByProviderEmail(provider: any, email: any): Record<string, SQLOutputValue> | null; insertAuthUser(row: any): StatementResultingChanges; updateAuthUserProfile(row: any): StatementResultingChanges; linkAuthUser(row: any): StatementResultingChanges; insertAuthSession(row: any): StatementResultingChanges; deleteAuthSession(token: any): StatementResultingChanges; refreshAuthSession(token: any, expiresAt: any): StatementResultingChanges; rotateAuthSession(previousToken: any, row: any): StatementResultingChanges; readAuthSessionWithUser(token: any): Record<string, SQLOutputValue> | null; insertOAuthState(row: any): StatementResultingChanges; consumeOAuthState(state: any): Record<string, SQLOutputValue> | null; emailCredentialExists(email: any): boolean; insertEmailCredential(row: any): StatementResultingChanges; findEmailCredentialWithUser(email: any): Record<string, SQLOutputValue> | null; migrateAppSchema(schema: any): any; createAppTable(table: any, tableName?: any): any; migrateExistingAppTable(existingTable: any, nextTable: any): any; referenceExists(field: any, value: any): boolean; withTransaction(fn: any): Promise<any>; insertAppRow(table: any, row: any): StatementResultingChanges; selectAppRowById(table: any, id: any): Record<string, SQLOutputValue> | null; updateAppRow(table: any, id: any, values: any, options?: {}): StatementResultingChanges | { changes: number; }; deleteAppRow(table: any, id: any): StatementResultingChanges; selectAppRows(table: any, query?: {}): Record<string, SQLOutputValue>[]; listInspectableTables(): SQLOutputValue[]; dumpInspectableDatabase(): { name: SQLOutputValue; columns: SQLOutputValue[]; rows: Record<string, SQLOutputValue>[]; }[]; runReadOnlyInspectionQuery(sql: any): { ok: boolean; data: { columns: string[]; rows: Record<string, SQLOutputValue>[]; }; error: null; } | { ok: boolean; data: null; error: { message: any; hint: string; }; }; checkHealth(): { ok: boolean; }; close(): void; }) => any) {
      this.exec("BEGIN");
      try {
        const result = await fn(this);
        this.exec("COMMIT");
        return result;
      } catch (error) {
        this.exec("ROLLBACK");
        throw error;
      }
    },
    async withReadOnlySnapshot(fn: (adapter: LooseRecord) => any) {
      this.exec("BEGIN"); this.exec("PRAGMA query_only = ON");
      try { const result = await fn(this); this.exec("COMMIT"); return result; }
      catch (error) { this.exec("ROLLBACK"); throw error; }
      finally { if (!options.readOnly) this.exec("PRAGMA query_only = OFF"); }
    },
    insertAppRow(table: { name: any; }, row: { [x: string]: any; }) {
      const columns = Object.keys(row);
      return this.prepare(
        `INSERT INTO ${quoteIdentifier(table.name)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns
          .map(() => "?")
          .join(", ")})`,
      ).run(...columns.map((column) => row[column]));
    },
    selectAppRowById(table: { name: any; }, id: any) {
      return this.prepare(`SELECT * FROM ${quoteIdentifier(table.name)} WHERE id = ?`).get(String(id)) ?? null;
    },
    updateAppRow(table: { name: any; }, id: any, values: { [x: string]: any; }, options: LooseRecord = {}) {
      const columns = Object.keys(values);
      if (columns.length === 0) {
        return { changes: 0 };
      }
      return this.prepare(
        `UPDATE ${quoteIdentifier(table.name)} SET ${columns.map((column) => `${quoteIdentifier(column)} = ?`).join(", ")} WHERE id = ?` +
        (options.ownerId === undefined ? "" : " AND ownerId = ?"),
      ).run(
        ...columns.map((column) => values[column]),
        String(id),
        ...(options.ownerId === undefined ? [] : [options.ownerId]),
      );
    },
    deleteAppRow(table: { name: any; }, id: any) {
      return this.prepare(`DELETE FROM ${quoteIdentifier(table.name)} WHERE id = ?`).run(String(id));
    },
    selectAppRows(table: { name: any; }, query: LooseRecord = {}) {
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
        ? ` ORDER BY ${quoteIdentifier(query.orderBy.fieldName)} ${String(query.orderBy.direction).toLowerCase() === "desc" ? "DESC" : "ASC"
        }`
        : "";
      const limit = Number.isInteger(query.limit) && query.limit >= 0 ? query.limit : null;
      const limitSql = limit === null ? "" : " LIMIT ?";
      return this.prepare(
        `SELECT ${columns.map((column: string) => (column === "*" ? "*" : quoteIdentifier(column))).join(", ")} FROM ${quoteIdentifier(
          table.name,
        )}${whereSql}${orderSql}${limitSql}`,
      ).all(...(limit === null ? params : [...params, limit]));
    },
    listInspectableTables() {
      return this.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map((row: any) => row.name)
        .filter((name: any) => name !== "sporades_log_events" && name !== "sporades_schedules" && name !== "sporades_schedule_occurrences");
    },
    dumpInspectableDatabase() {
      return this.listInspectableTables().map((tableName: any) => ({
        name: tableName,
        columns: this.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
          .all()
          .map((column: any) => column.name),
        rows: this.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`).all(),
      }));
    },
    runReadOnlyInspectionQuery(sql: string | undefined) {
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
        const columns = statement.columns().map((column: any) => column.name);
        const rows = statement.all().filter((row: any) => !isInternalLogIndexMetadataRow(row, sql));
        return {
          ok: true,
          data: {
            columns,
            rows,
          },
          error: null as any,
        };
      } catch (error: any) {
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
      } catch {
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

export async function createPostgresDatabaseAdapter(options: { url: any; }) {
  const url = typeof options === "string" ? options : options?.url;
  if (!url) {
    throw commandError(
      "Missing Postgres database service URL.",
      "Start a Dev session or local Container session with services.database.engine set to postgres.",
    );
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

  const query = async (sql: string, params: any[] = []) => {
    assertOpen();
    return await client.query(postgresInterpolate(sql, params));
  };

  const adapter = {
    ...shape,
    engine: "postgres",
    exec(sql: string) {
      return query(sql).then((): undefined => undefined);
    },
    prepare(sql: string) {
      assertOpen();
      return {
        all(...params: (number | undefined)[]) {
          return query(sql, params).then((result: any) => postgresRowsFromResult(result));
        },
        get(...params: undefined[]) {
          return this.all(...params).then((rows: any[]) => rows[0] ?? null);
        },
        run(...params: string[]) {
          return query(sql, params).then((result) => ({
            changes: Number(result.rowCount ?? 0),
            lastInsertRowid: undefined as any,
          }));
        },
        columns() {
          return query(`SELECT * FROM (${sql}) AS __sporades_columns LIMIT 0`).then((result) =>
            result.fields.map((field) => ({ name: postgresRuntimeColumnName(field.name) })),
          );
        },
      };
    },
    async writeSystemMetadata(keyOrMetadata: string | null, maybeValue: any) {
      if (typeof keyOrMetadata === "object" && keyOrMetadata !== null) {
        return await this.writeSchemaMetadata(keyOrMetadata);
      }
      return await this.prepare(
        "INSERT INTO sporades (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      ).run(keyOrMetadata ?? "", maybeValue);
    },
    async writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: LooseRecord) {
      await this.writeSystemMetadata("schemaVersion", schemaVersion);
      await this.writeSystemMetadata("schemaHash", schemaHash);
      await this.writeSystemMetadata("schema", schemaJson);
    },
    async ensureAuthStorage(authConfig: any = null) {
      await this.exec(
        "CREATE TABLE IF NOT EXISTS sporades_auth_users (" +
        "id TEXT PRIMARY KEY, " +
        "createdAt TEXT NOT NULL, " +
        "displayName TEXT NOT NULL, " +
        "email TEXT, " +
        "picture TEXT, " +
        "isAuthenticated INTEGER NOT NULL, " +
        "isGuest INTEGER NOT NULL, " +
        "provider TEXT NOT NULL" +
        ")",
      );
      await this.exec(
        "CREATE TABLE IF NOT EXISTS sporades_auth_sessions (" +
        "token TEXT PRIMARY KEY, " +
        "userId TEXT NOT NULL, " +
        "provider TEXT NOT NULL, " +
        "createdAt TEXT NOT NULL, " +
        "expiresAt TEXT NOT NULL" +
        ")",
      );
      await this.exec("ALTER TABLE sporades_auth_sessions ADD COLUMN IF NOT EXISTS provider TEXT");
      await this.exec(
        "UPDATE sporades_auth_sessions SET provider = " +
        "COALESCE(provider, (SELECT provider FROM sporades_auth_users WHERE id = sporades_auth_sessions.userId), 'anonymous') " +
        "WHERE provider IS NULL",
      );
      await this.exec(
        "CREATE TABLE IF NOT EXISTS sporades_auth_identities (" +
        "id TEXT PRIMARY KEY, userId TEXT NOT NULL, provider TEXT NOT NULL, subject TEXT NOT NULL, email TEXT, " +
        "displayName TEXT, picture TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(provider, subject))",
      );
      await this.exec(
        "INSERT INTO sporades_auth_identities " +
        "(id, userId, provider, subject, email, displayName, picture, createdAt, updatedAt) " +
        "SELECT 'legacy:' || id, id, provider, 'legacy:' || id, email, displayName, picture, createdAt, createdAt " +
        "FROM sporades_auth_users u WHERE provider = 'google' AND id != '__privileged__' " +
        "AND NOT EXISTS (SELECT 1 FROM sporades_auth_identities i WHERE i.userId = u.id AND i.provider = u.provider)",
      );
      if (authConfig?.providers?.email?.enabled) {
        await this.exec(
          "CREATE TABLE IF NOT EXISTS sporades_auth_email_credentials (" +
          "email TEXT PRIMARY KEY, " +
          "userId TEXT NOT NULL, " +
          "passwordHash TEXT NOT NULL, " +
          "passwordSalt TEXT NOT NULL, " +
          "createdAt TEXT NOT NULL" +
          ")",
        );
      }
      await this.exec(
        "CREATE TABLE IF NOT EXISTS sporades_auth_oauth_states (" +
        "state TEXT PRIMARY KEY, " +
        "provider TEXT NOT NULL, " +
        "sessionToken TEXT NOT NULL, " +
        "returnTo TEXT NOT NULL, " +
        "redirectUri TEXT NOT NULL, " +
        "createdAt TEXT NOT NULL, " +
        "expiresAt TEXT NOT NULL, " +
        "nonce TEXT, " +
        "pkceVerifier TEXT" +
        ")",
      );
      await this.exec("ALTER TABLE sporades_auth_oauth_states ADD COLUMN IF NOT EXISTS provider TEXT");
      await this.exec("ALTER TABLE sporades_auth_oauth_states ADD COLUMN IF NOT EXISTS expiresAt TEXT");
      await this.exec("ALTER TABLE sporades_auth_oauth_states ADD COLUMN IF NOT EXISTS nonce TEXT");
      await this.exec("ALTER TABLE sporades_auth_oauth_states ADD COLUMN IF NOT EXISTS pkceVerifier TEXT");
      await this.exec("UPDATE sporades_auth_oauth_states SET provider = 'google' WHERE provider IS NULL");
      await this.exec("UPDATE sporades_auth_oauth_states SET expiresAt = createdAt WHERE expiresAt IS NULL");
    },
    async insertOAuthState(row: LooseRecord) {
      const provider = row.provider ?? "google";
      const expiresAt = row.expiresAt ?? new Date(Date.parse(row.createdAt) + 10 * 60 * 1000).toISOString();
      return await this.prepare(
        "INSERT INTO sporades_auth_oauth_states " +
        "(state, provider, sessionToken, returnTo, redirectUri, createdAt, expiresAt, nonce, pkceVerifier) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(row.state, provider, row.sessionToken, row.returnTo, row.redirectUri, row.createdAt, expiresAt, row.nonce ?? null, row.pkceVerifier ?? null);
    },
    async consumeOAuthState(state: string) {
      const row = await (this.prepare(
        "DELETE FROM sporades_auth_oauth_states WHERE state = ? " +
        "RETURNING state, provider, sessionToken, returnTo, redirectUri, createdAt, expiresAt, nonce, pkceVerifier",
      ) as any).get(state);
      return row ?? null;
    },
    async ensureLogStorage() {
      await this.exec(
        "CREATE TABLE IF NOT EXISTS sporades_log_events (" +
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
        ")",
      );
    },
    async ensureFileStorage() {
      await this.exec(
        "CREATE TABLE IF NOT EXISTS sporades_file_buckets (" +
        "id TEXT PRIMARY KEY, " +
        "ownerId TEXT NOT NULL, " +
        "name TEXT NOT NULL, " +
        "createdAt TEXT NOT NULL, " +
        "UNIQUE(ownerId, name)" +
        ")",
      );
      await this.exec(
        "CREATE TABLE IF NOT EXISTS sporades_files (" +
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
        ")",
      );
      await this.exec("ALTER TABLE sporades_files ADD COLUMN path TEXT").catch((error: any) => {
        if (!isDuplicateColumnError(error)) throw error;
      });
      await this.exec(filePathBackfillSql());
      await this.exec(activeFilePathDedupeSql());
      await this.exec("CREATE INDEX IF NOT EXISTS sporades_files_path_live ON sporades_files (path, deletedAt, status)");
      await this.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS sporades_files_path_active_unique " +
        "ON sporades_files (path) WHERE deletedAt IS NULL AND status IN ('pending', 'uploaded')",
      );
      await this.exec(
        "CREATE TABLE IF NOT EXISTS sporades_file_uploads (" +
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
        ")",
      );
      await ensureFileUploadTargetColumns(this);
      await this.exec(
        "CREATE TABLE IF NOT EXISTS sporades_file_public_urls (" +
        "id TEXT PRIMARY KEY, " +
        "fileId TEXT NOT NULL, " +
        "ownerId TEXT NOT NULL, " +
        "version TEXT NOT NULL, " +
        "expiresAt TEXT, " +
        "createdAt TEXT NOT NULL, " +
        "revokedAt TEXT" +
        ")",
      );
    },
    async ensureUserPreferencesStorage() {
      await createUserPreferencesTables(this);
    },
    async readUserPreferences(userId: any) {
      return (await this.prepare("SELECT userId, value, updatedAt FROM sporades_user_preferences WHERE userId = ?").get(userId)) ?? null;
    },
    async saveUserPreferences(row: { userId: any; value: any; updatedAt: any; }) {
      return await this.prepare(
        "INSERT INTO sporades_user_preferences (userId, value, updatedAt) VALUES (?, ?, ?) " +
        "ON CONFLICT (userId) DO UPDATE SET value = EXCLUDED.value, updatedAt = EXCLUDED.updatedAt",
      ).run(row.userId, row.value, row.updatedAt);
    },
    async insertLogIndexEvent(event: { timestamp: any; category: any; event: any; level: any; message: any; capsule: { name: any; id: any; }; release: { id: any; }; request: { id: any; }; correlation: { id: any; }; }) {
      await this.prepare(
        "INSERT INTO sporades_log_events " +
        "(id, timestamp, category, event, level, message, capsuleName, capsuleId, releaseId, requestId, correlationId, payload) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        randomUUID(),
        event.timestamp,
        event.category,
        event.event,
        event.level,
        event.message,
        event.capsule?.name ?? null,
        event.capsule?.id ?? null,
        event.release?.id ?? event.release ?? null,
        event.request?.id ?? null,
        event.correlation?.id ?? event.correlation ?? null,
        JSON.stringify(event),
      );
    },
    async pruneLogIndex(limit: any) {
      await this.prepare(
        "DELETE FROM sporades_log_events WHERE id IN (" +
        "SELECT id FROM sporades_log_events ORDER BY timestamp DESC, id DESC OFFSET ?" +
        ")",
      ).run(limit);
    },
    async readRecentLogEvents(limit = 200) {
      const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : 200;
      const rows = await this.prepare("SELECT payload FROM sporades_log_events ORDER BY timestamp DESC, id DESC LIMIT ?").all(safeLimit);
      return rows.reverse().map((row: { payload: string; }) => JSON.parse(row.payload));
    },
    async migrateAppSchema(schema: { tables: { name: any; acl: { allowByDefault: boolean; } | { allowByDefault: boolean; resolve(operation: any): any; }; fields: { name: any; kind: any; sqliteType: string; targetTable: string | undefined; defaultValue: any; }[]; }[]; } | { tables: { name: string; fields: ({ name: any; kind: any; sqliteType: string; targetTable: any; defaultValue: any; } | null)[]; }[]; }) {
      return await this.withTransaction((transaction) => migrateLibsqlAppSchema(transaction as any, schema));
    },
    async createAppTable(table: { name: any; }, tableName = table.name) {
      await this.exec(
        `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (` +
        postgresAppTableColumnDefinitions(table).join(", ") +
        ")",
      );
    },
    async migrateExistingAppTable(existingTable: any, nextTable: any) {
      return await migrateExistingLibsqlAppTable(this, existingTable, nextTable);
    },
    async listInspectableTables() {
      const rows = await this.prepare(
        "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name",
      ).all();
      return rows.map((row: { name: any; }) => row.name).filter((name: string) => name !== "sporades_log_events" && name !== "sporades_schedules" && name !== "sporades_schedule_occurrences");
    },
    async dumpInspectableDatabase() {
      const tableNames = await this.listInspectableTables();
      const tables = [];
      for (const tableName of tableNames) {
        const columns = (
          await this.prepare(
            "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position",
          ).all(tableName)
        ).map((column: { name: any; }) => column.name);
        const rows = await this.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`).all();
        tables.push({ name: tableName, columns, rows });
      }
      return tables;
    },
    async runReadOnlyInspectionQuery(sql: string | undefined) {
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
            rows: postgresRowsFromResult(result).filter((row: any) => !isInternalLogIndexMetadataRow(row, sql)),
          },
          error: null as any,
        };
      } catch (error: any) {
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
      } catch {
        return { ok: false };
      }
    },
    async withTransaction(fn: (arg0: { engine: string; exec(sql: any): Promise<undefined>; prepare(sql: any): { all(...params: any[]): Promise<any>; get(...params: any[]): Promise<any>; run(...params: any[]): Promise<{ changes: number; lastInsertRowid: undefined; }>; columns(): Promise<{ name: any; }[]>; }; writeSystemMetadata(keyOrMetadata: any, maybeValue: any): Promise<void | { changes: number; lastInsertRowid: undefined; }>; writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: { schemaVersion: any; schemaHash: any; schemaJson: any; }): Promise<void>; ensureAuthStorage(authConfig?: null): Promise<void>; ensureLogStorage(): Promise<void>; ensureFileStorage(): Promise<void>; insertLogIndexEvent(event: any): Promise<void>; pruneLogIndex(limit: any): Promise<void>; readRecentLogEvents(limit?: number): Promise<any>; migrateAppSchema(schema: any): Promise<void>; createAppTable(table: any, tableName?: any): Promise<void>; migrateExistingAppTable(existingTable: any, nextTable: any): Promise<void>; listInspectableTables(): Promise<any>; dumpInspectableDatabase(): Promise<{ name: any; columns: any; rows: any; }[]>; runReadOnlyInspectionQuery(sql: any): Promise<{ ok: boolean; data: { columns: any[]; rows: any; }; error: null; } | { ok: boolean; data: null; error: { message: any; hint: string; }; }>; checkHealth(): Promise<{ ok: boolean; }>; withTransaction(fn: any): Promise<any>; close(): Promise<void>; ensureSystemTable(): void; readSystemMetadata(key: any): Record<string, SQLOutputValue> | null; readSchemaMetadata(): Record<string, SQLOutputValue> | null; findFileBucket(ownerId: any, name: any): Record<string, SQLOutputValue> | null; createFileBucket(row: any): StatementResultingChanges; insertFileRow(row: any): StatementResultingChanges; updatePendingFileRow(row: any): StatementResultingChanges; insertFileUpload(row: any): StatementResultingChanges; selectFileById(fileId: any): Record<string, SQLOutputValue> | null; selectLiveFileByPath(path: any): Record<string, SQLOutputValue>[]; selectActiveFileByPath(path: any): Record<string, SQLOutputValue>[]; selectPendingFileUploadByPath(path: any): Record<string, SQLOutputValue> | null; selectFileUpload(uploadId: any): Record<string, SQLOutputValue> | null; completeFileUpload(upload: any, size: any, updatedAt: any): StatementResultingChanges | { changes: number; }; deleteFileUploadsForPath(path: any): StatementResultingChanges; deleteFileUploadsForFile(ownerId: any, fileId: any): StatementResultingChanges; deleteFileUpload(uploadId: any): StatementResultingChanges; selectPublicFileRow(publicUrlId: any): Record<string, SQLOutputValue> | null; insertPublicFileUrl(row: any): StatementResultingChanges; revokePublicFileUrl(publicUrlId: any, ownerId: any, revokedAt: any): StatementResultingChanges; revokePublicFileUrlsForFile(fileId: any, revokedAt: any): StatementResultingChanges; markFileDeleted(fileId: any, deletedAt: any): StatementResultingChanges; fileRowForOwner(fileId: any, ownerId: any): Record<string, SQLOutputValue> | null; findAuthUserByProviderEmail(provider: any, email: any): Record<string, SQLOutputValue> | null; insertAuthUser(row: any): StatementResultingChanges; updateAuthUserProfile(row: any): StatementResultingChanges; linkAuthUser(row: any): StatementResultingChanges; insertAuthSession(row: any): StatementResultingChanges; deleteAuthSession(token: any): StatementResultingChanges; refreshAuthSession(token: any, expiresAt: any): StatementResultingChanges; rotateAuthSession(previousToken: any, row: any): StatementResultingChanges; readAuthSessionWithUser(token: any): Record<string, SQLOutputValue> | null; insertOAuthState(row: any): StatementResultingChanges; consumeOAuthState(state: any): Record<string, SQLOutputValue> | null; emailCredentialExists(email: any): boolean; insertEmailCredential(row: any): StatementResultingChanges; findEmailCredentialWithUser(email: any): Record<string, SQLOutputValue> | null; referenceExists(field: any, value: any): boolean; insertAppRow(table: any, row: any): StatementResultingChanges; selectAppRowById(table: any, id: any): Record<string, SQLOutputValue> | null; updateAppRow(table: any, id: any, values: any, options?: {}): StatementResultingChanges | { changes: number; }; deleteAppRow(table: any, id: any): StatementResultingChanges; selectAppRows(table: any, query?: {}): Record<string, SQLOutputValue>[]; }) => any) {
      await this.exec("BEGIN");
      try {
        const result = await fn(this as any);
        await this.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          await this.exec("ROLLBACK");
        } catch { }
        throw error;
      }
    },
    async withReadOnlySnapshot(fn: (adapter: LooseRecord) => any) {
      await this.exec("BEGIN TRANSACTION READ ONLY");
      try { const result = await fn(this); await this.exec("COMMIT"); return result; }
      catch (error) { try { await this.exec("ROLLBACK"); } catch {} throw error; }
    },
    async close() {
      closed = true;
      await client.close();
    },
  };

  return adapter;
}

export async function createPostgresConnection(url: any) {
  const net = await import("node:net");
  const crypto = await import("node:crypto");
  const options = postgresUrlOptions(url);
  const socket = net.createConnection({ host: options.host, port: options.port });
  socket.setNoDelay(true);

  let buffer = Buffer.alloc(0);
  let ready = false;
  let closed = false;
  let backendKeyData = null;
  let queryQueue: Promise<any> = Promise.resolve();
  const waiters: any[] = [];

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
          throw commandError(
            "Unsupported Postgres SASL mechanism.",
            "Use the Sporades-managed Postgres Capsule service, which authenticates with SCRAM-SHA-256.",
          );
        }
        scram = createPostgresScramSession(crypto, options.password);
        const clientFirst = Buffer.from(scram.clientFirstMessage, "utf8");
        socket.write(
          postgresPasswordMessage(
            Buffer.concat([Buffer.from("SCRAM-SHA-256\0", "utf8"), postgresInt32(clientFirst.length), clientFirst]),
          ),
        );
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
      throw commandError(
        "Unsupported Postgres authentication method.",
        "Use the Sporades-managed Postgres Capsule service with the generated Capsule service credentials.",
      );
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
    query(sql: string) {
      if (closed) {
        throw new Error("database is not open");
      }
      const pending = queryQueue.then(
        () => executePostgresQuery(sql),
        () => executePostgresQuery(sql),
      );
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

  async function executePostgresQuery(sql: any) {
    if (closed) {
      throw new Error("database is not open");
    }
    socket.write(postgresQueryMessage(sql));
    const fields: any[] = [];
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

function postgresUrlOptions(url: any) {
  const parsed = new URL(String(url));
  return {
    host: parsed.hostname || "127.0.0.1",
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username || "sporades"),
    password: decodeURIComponent(parsed.password || ""),
    database: decodeURIComponent(parsed.pathname.replace(/^\/+/, "") || "sporades"),
  };
}

function postgresPasswordMessage(body: string | Uint8Array | Buffer) {
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Buffer.concat([Buffer.from("p"), postgresInt32(bodyBuffer.length + 4), bodyBuffer]);
}

function createPostgresScramSession(crypto: typeof import("node:crypto"), password: string) {
  const clientNonce = crypto.randomBytes(18).toString("base64");
  const clientFirstBare = `n=,r=${clientNonce}`;
  let serverSignature: string | null = null;
  return {
    clientFirstMessage: `n,,${clientFirstBare}`,
    continue(serverFirstMessage: string) {
      const attributes = new Map(serverFirstMessage.split(",").map((part: string) => [part.slice(0, 1), part.slice(2)]));
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
      const clientProof = Buffer.from(clientKey.map((byte: number, index: number) => byte ^ clientSignature[index]));
      const serverKey = crypto.createHmac("sha256", saltedPassword).update("Server Key").digest();
      serverSignature = crypto.createHmac("sha256", serverKey).update(authMessage).digest("base64");
      return `${clientFinalWithoutProof},p=${clientProof.toString("base64")}`;
    },
    verify(serverFinalMessage: string) {
      if (serverFinalMessage !== `v=${serverSignature}`) {
        throw new Error("Postgres SCRAM server signature verification failed.");
      }
    },
  };
}

function postgresStartupMessage(options: { host?: string; port?: number; user: any; password?: string; database: any; }) {
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

function postgresQueryMessage(sql: any) {
  const body = Buffer.from(`${sql}\0`, "utf8");
  return Buffer.concat([Buffer.from("Q"), postgresInt32(body.length + 4), body]);
}

function postgresInt32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value, 0);
  return buffer;
}

function waitForPostgresData(waiters: any[]) {
  return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
}

function wakePostgresWaiters(waiters: any[]) {
  for (const waiter of waiters.splice(0)) {
    waiter.resolve();
  }
}

function postgresParseRowDescription(body: Buffer<ArrayBuffer>) {
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

function postgresParseDataRow(body: Buffer<ArrayBuffer>, fields: any[]) {
  const row: LooseRecord = {};
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

function postgresValueFromText(value: string, dataTypeID: number) {
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

function postgresRowCountFromCommand(tag: string) {
  const match = tag.match(/\s(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function postgresErrorFromBody(body: Buffer) {
  const fields: LooseRecord = {};
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

function postgresInterpolate(sql: any, params: any[] = []) {
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

function postgresPlaceholders(sql: any) {
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

function postgresRowsFromResult(result: { fields?: any[]; rows: any; rowCount?: number; }) {
  return result.rows.map((row: { [s: string]: unknown; } | ArrayLike<unknown>) => {
    const normalized: LooseRecord = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[postgresRuntimeColumnName(key)] = value;
    }
    return normalized;
  });
}

function postgresRuntimeColumnName(name: string) {
  return (
    {
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
      returnto: "returnTo",
      redirecturi: "redirectUri",
      pkceverifier: "pkceVerifier",
      capsulename: "capsuleName",
      capsuleid: "capsuleId",
      releaseid: "releaseId",
      requestid: "requestId",
      correlationid: "correlationId",
    }[name] ?? name
  );
}

function postgresAppTableColumnDefinitions(table: any) {
  return [
    `${quoteIdentifier("id")} TEXT PRIMARY KEY`,
    `${quoteIdentifier("createdAt")} TEXT NOT NULL`,
    `${quoteIdentifier("updatedAt")} TEXT NOT NULL`,
    ...table.fields.map((field: any) => appFieldColumnDefinition(field)),
  ];
}

export async function createLibsqlDatabaseAdapter(options: { url: any; authToken: any; }) {
  const url = typeof options === "string" ? options : options?.url;
  if (!url) {
    throw commandError(
      "Missing libSQL database service URL.",
      "Start a Dev session or local Container session with services.database.engine set to libsql.",
    );
  }

  const endpoint = libsqlPipelineUrl(url);
  const authToken = typeof options === "object" ? options.authToken : null;
  let closed = false;
  const activeTransactions = new Set<any>();

  const shape = await createSqliteDatabaseAdapter(":memory:");
  shape.close();

  const createOperations = (transaction: any = null) => ({
    exec(sql: string) {
      assertLibsqlOpen(closed);
      const request = libsqlHasMultipleStatements(sql)
        ? { type: "sequence", sql }
        : { type: "execute", stmt: { sql } };
      return libsqlPipeline({ endpoint, authToken, transaction, requests: [request], close: !transaction }).then((): undefined => undefined);
    },
    prepare(sql: string) {
      assertLibsqlOpen(closed);
      return {
        all(...params: (number | undefined)[]) {
          return libsqlExecute({ endpoint, authToken, transaction, sql, params, close: !transaction }).then((result) =>
            libsqlRowsFromResult(result),
          );
        },
        get(...params: undefined[]) {
          return this.all(...params).then((rows: any[]) => rows[0] ?? null);
        },
        run(...params: string[]) {
          return libsqlExecute({ endpoint, authToken, transaction, sql, params, close: !transaction }).then((result) => ({
            changes: Number(result.affected_row_count ?? result.affectedRowCount ?? 0),
            lastInsertRowid:
              result.last_insert_rowid === null || result.last_insert_rowid === undefined
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
    async writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }: LooseRecord) {
      await this.writeSystemMetadata("schemaVersion", schemaVersion);
      await this.writeSystemMetadata("schemaHash", schemaHash);
      await this.writeSystemMetadata("schema", schemaJson);
    },
    async ensureLogStorage() {
      await this.exec(
        "CREATE TABLE IF NOT EXISTS sporades_log_events (" +
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
        ")",
      );
    },
    async insertLogIndexEvent(event: { timestamp: any; category: any; event: any; level: any; message: any; capsule: { name: any; id: any; }; release: { id: any; }; request: { id: any; }; correlation: { id: any; }; }) {
      await this.prepare(
        "INSERT INTO sporades_log_events " +
        "(id, timestamp, category, event, level, message, capsuleName, capsuleId, releaseId, requestId, correlationId, payload) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        randomUUID(),
        event.timestamp,
        event.category,
        event.event,
        event.level,
        event.message,
        event.capsule?.name ?? null,
        event.capsule?.id ?? null,
        event.release?.id ?? event.release ?? null,
        event.request?.id ?? null,
        event.correlation?.id ?? event.correlation ?? null,
        JSON.stringify(event),
      );
    },
    async pruneLogIndex(limit: any) {
      await this.prepare(
        "DELETE FROM sporades_log_events WHERE id IN (" +
        "SELECT id FROM sporades_log_events ORDER BY timestamp DESC, rowid DESC LIMIT -1 OFFSET ?" +
        ")",
      ).run(limit);
    },
    async readRecentLogEvents(limit = 200) {
      const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : 200;
      const rows = await this.prepare("SELECT payload FROM sporades_log_events ORDER BY timestamp DESC, rowid DESC LIMIT ?").all(safeLimit);
      return rows.reverse().map((row: { payload: string; }) => JSON.parse(row.payload));
    },
    async ensureFileStorage() {
      await this.exec(
        "CREATE TABLE IF NOT EXISTS sporades_file_buckets (" +
        "id TEXT PRIMARY KEY, " +
        "ownerId TEXT NOT NULL, " +
        "name TEXT NOT NULL, " +
        "createdAt TEXT NOT NULL, " +
        "UNIQUE(ownerId, name)" +
        ")",
      );
      await this.exec(
        "CREATE TABLE IF NOT EXISTS sporades_files (" +
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
        ")",
      );
      await this.exec("ALTER TABLE sporades_files ADD COLUMN path TEXT").catch((error: any) => {
        if (!isDuplicateColumnError(error)) throw error;
      });
      await this.exec(filePathBackfillSql());
      await this.exec(activeFilePathDedupeSql());
      await this.exec("CREATE INDEX IF NOT EXISTS sporades_files_path_live ON sporades_files (path, deletedAt, status)");
      await this.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS sporades_files_path_active_unique " +
        "ON sporades_files (path) WHERE deletedAt IS NULL AND status IN ('pending', 'uploaded')",
      );
      await this.exec(
        "CREATE TABLE IF NOT EXISTS sporades_file_uploads (" +
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
        ")",
      );
      await ensureFileUploadTargetColumns(this);
      await this.exec(
        "CREATE TABLE IF NOT EXISTS sporades_file_public_urls (" +
        "id TEXT PRIMARY KEY, " +
        "fileId TEXT NOT NULL, " +
        "ownerId TEXT NOT NULL, " +
        "version TEXT NOT NULL, " +
        "expiresAt TEXT, " +
        "createdAt TEXT NOT NULL, " +
        "revokedAt TEXT" +
        ")",
      );
    },
    async ensureAuthStorage(authConfig: any = null) {
      await this.exec(
        "CREATE TABLE IF NOT EXISTS sporades_auth_users (" +
        "id TEXT PRIMARY KEY, " +
        "createdAt TEXT NOT NULL, " +
        "displayName TEXT NOT NULL, " +
        "email TEXT, " +
        "picture TEXT, " +
        "isAuthenticated INTEGER NOT NULL, " +
        "isGuest INTEGER NOT NULL, " +
        "provider TEXT NOT NULL" +
        ")",
      );
      await this.exec(
        "CREATE TABLE IF NOT EXISTS sporades_auth_sessions (" +
        "token TEXT PRIMARY KEY, " +
        "userId TEXT NOT NULL, " +
        "provider TEXT NOT NULL, " +
        "createdAt TEXT NOT NULL, " +
        "expiresAt TEXT NOT NULL" +
        ")",
      );
      await ensureLibsqlSessionLifecycleColumns(this as any);
      await ensureLibsqlSessionProvenanceColumn(this as any);
      await createLibsqlProviderIdentityTables(this as any);
      if (authConfig?.providers?.email?.enabled) {
        await this.exec(
          "CREATE TABLE IF NOT EXISTS sporades_auth_email_credentials (" +
          "email TEXT PRIMARY KEY, " +
          "userId TEXT NOT NULL, " +
          "passwordHash TEXT NOT NULL, " +
          "passwordSalt TEXT NOT NULL, " +
          "createdAt TEXT NOT NULL" +
          ")",
        );
      }
      await this.exec(
        "CREATE TABLE IF NOT EXISTS sporades_auth_oauth_states (" +
        "state TEXT PRIMARY KEY, " +
        "provider TEXT NOT NULL, " +
        "sessionToken TEXT NOT NULL, " +
        "returnTo TEXT NOT NULL, " +
        "redirectUri TEXT NOT NULL, " +
        "createdAt TEXT NOT NULL, " +
        "expiresAt TEXT NOT NULL, " +
        "nonce TEXT, " +
        "pkceVerifier TEXT" +
        ")",
      );
      await ensureLibsqlOAuthStateColumns(this);
    },
    async insertOAuthState(row: LooseRecord) {
      const provider = row.provider ?? "google";
      const expiresAt = row.expiresAt ?? new Date(Date.parse(row.createdAt) + 10 * 60 * 1000).toISOString();
      return await this.prepare(
        "INSERT INTO sporades_auth_oauth_states " +
        "(state, provider, sessionToken, returnTo, redirectUri, createdAt, expiresAt, nonce, pkceVerifier) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(row.state, provider, row.sessionToken, row.returnTo, row.redirectUri, row.createdAt, expiresAt, row.nonce ?? null, row.pkceVerifier ?? null);
    },
    async consumeOAuthState(state: any) {
      return (await this.prepare(
        "DELETE FROM sporades_auth_oauth_states WHERE state = ? " +
        "RETURNING state, provider, sessionToken, returnTo, redirectUri, createdAt, expiresAt, nonce, pkceVerifier",
      ).get(state)) ?? null;
    },
    async migrateAppSchema(schema: { tables: { name: any; acl: { allowByDefault: boolean; } | { allowByDefault: boolean; resolve(operation: any): any; }; fields: { name: any; kind: any; sqliteType: string; targetTable: string | undefined; defaultValue: any; }[]; }[]; } | { tables: { name: string; fields: ({ name: any; kind: any; sqliteType: string; targetTable: any; defaultValue: any; } | null)[]; }[]; }) {
      return await this.withTransaction((transaction) => migrateLibsqlAppSchema(transaction as any, schema));
    },
    async migrateExistingAppTable(existingTable: any, nextTable: any) {
      return await migrateExistingLibsqlAppTable(this, existingTable, nextTable);
    },
    async listInspectableTables() {
      const rows = await this.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      return rows.map((row: { name: any; }) => row.name).filter((name: string) => name !== "sporades_log_events" && name !== "sporades_schedules" && name !== "sporades_schedule_occurrences");
    },
    async dumpInspectableDatabase() {
      const tableNames = await this.listInspectableTables();
      const tables = [];
      for (const tableName of tableNames) {
        const columns = (await this.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all()).map((column: { name: any; }) => column.name);
        const rows = await this.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`).all();
        tables.push({ name: tableName, columns, rows });
      }
      return tables;
    },
    async runReadOnlyInspectionQuery(sql: string | undefined) {
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
        const columns = (await statement.columns()).map((column: { name: any; }) => column.name);
        const rows = (await statement.all()).filter((row: any) => !isInternalLogIndexMetadataRow(row, sql));
        return { ok: true, data: { columns, rows }, error: null as any };
      } catch (error: any) {
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
      } catch {
        return { ok: false };
      }
    },
    async withTransaction(fn: (transactionAdapter: LooseRecord) => any) {
      const transaction = { baton: null as any, baseUrl: endpoint };
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
      } catch (error) {
        try {
          await libsqlExecute({ endpoint, authToken, transaction, sql: "ROLLBACK", params: [], close: true });
        } catch { }
        throw error;
      } finally {
        activeTransactions.delete(transaction);
      }
    },
    async withReadOnlySnapshot(fn: (adapter: LooseRecord) => any) {
      const transaction = { baton: null as any, baseUrl: endpoint };
      const snapshotAdapter = { ...adapter, ...createOperations(transaction) };
      activeTransactions.add(transaction);
      try {
        await libsqlExecute({ endpoint, authToken, transaction, sql: "BEGIN", params: [], close: false });
        await libsqlExecute({ endpoint, authToken, transaction, sql: "PRAGMA query_only = ON", params: [], close: false });
        const result = await fn(snapshotAdapter);
        await libsqlExecute({ endpoint, authToken, transaction, sql: "COMMIT", params: [], close: true });
        return result;
      } catch (error) { try { await libsqlExecute({ endpoint, authToken, transaction, sql: "ROLLBACK", params: [], close: true }); } catch {} throw error; }
      finally { activeTransactions.delete(transaction); }
    },
    async close() {
      closed = true;
      for (const transaction of activeTransactions as Set<any>) {
        if (transaction.baton) {
          await libsqlPipeline({ endpoint, authToken, transaction, requests: [], close: true }).catch(() => { });
        }
      }
      activeTransactions.clear();
    },
  };

  return adapter;
}

function libsqlPipelineUrl(url: any) {
  const parsed = new URL(String(url));
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/v2/pipeline`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function assertLibsqlOpen(closed: boolean) {
  if (closed) {
    throw new Error("database is not open");
  }
}

function libsqlHasMultipleStatements(sql: any) {
  return splitSqlStatements(sql).length > 1;
}

async function libsqlExecute({ endpoint, authToken, transaction, sql, params = [], close }: LooseRecord) {
  const [result] = await libsqlPipeline({
    endpoint,
    authToken,
    transaction,
    requests: [{ type: "execute", stmt: { sql, args: params.map(libsqlValueFromJs) } }],
    close,
  });
  return result.result;
}

async function libsqlDescribe({ endpoint, authToken, transaction, sql, close }: LooseRecord) {
  const [result] = await libsqlPipeline({
    endpoint,
    authToken,
    transaction,
    requests: [{ type: "describe", sql }],
    close,
  });
  return (result.result?.cols ?? []).map((column: { name: any; }) => ({ name: column.name }));
}

async function libsqlPipeline({ endpoint, authToken, transaction = null, requests, close = true }: LooseRecord) {
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
  const errorResult = results.find((result: { type: string; }) => result.type === "error");
  if (errorResult) {
    throw new Error(errorResult.error?.message ?? "libSQL statement failed.");
  }
  return results.filter((result: { response: { type: string; }; }) => result.response?.type !== "close").map((result: { response: any; }) => result.response);
}

function libsqlRowsFromResult(result: { cols: any; rows: any; }) {
  const columns = (result.cols ?? []).map((column: { name: any; }) => column.name);
  return (result.rows ?? []).map((row: { [s: string]: unknown; } | ArrayLike<unknown>) => {
    if (!Array.isArray(row)) {
      return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, libsqlValueToJs(value)]));
    }
    return Object.fromEntries(columns.map((column: any, index: number) => [column, libsqlValueToJs(row[index])]));
  });
}

function libsqlValueFromJs(value: unknown) {
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

function libsqlValueToJs(value: any) {
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

function logIndexLimit(config: LooseRecord = {}) {
  const configured = Number(config.logs?.indexLimit ?? config.logging?.indexLimit);
  return Number.isInteger(configured) && configured > 0 ? configured : 500;
}

function logPayloadMaxBytes(config: LooseRecord = {}) {
  const configured = Number(config.logs?.payloadMaxBytes ?? config.logging?.payloadMaxBytes);
  return Number.isInteger(configured) && configured > 0 ? configured : 4096;
}

function logRedactedValue() {
  return "[REDACTED]";
}

function createRuntimeLogSink(options: { database: any; config: any; serverEnv: any; dataDir: any; }) {
  const path = requirePathModule();
  const logPath =
    options.config.logs?.jsonlPath ??
    options.config.logging?.jsonlPath ??
    process.env.SPORADES_LOG_PATH ??
    path.join(options.dataDir, "logs", "events.jsonl");
  mkdirSync(path.dirname(logPath), { recursive: true });
  return {
    path: logPath,
    emit(input: any) {
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
      } catch {
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
    join: (...parts: any[]) => parts.join("/").replace(/\/+/g, "/"),
    dirname: (filePath: any) => String(filePath).replace(/\/[^/]*$/, "") || ".",
  };
}

function createRuntimeLogger(database: { log: { emit: (arg0: { category: any; event: any; level: any; message: string; data: any; request: any; release: any; correlation: any; }) => void; }; }, context: LooseRecord = {}) {
  const write = (level: string, args: any[]) => {
    const [message, data, ...rest] = args;
    const structuredData =
      data !== undefined && rest.length === 0
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
    info: (...args: any) => write("info", args),
    warn: (...args: any) => write("warn", args),
    error: (...args: any) => write("error", args),
  };
}

const PRIVILEGED_AUDIT_SCHEMA = "sporades.privileged-audit.v1";
const PRIVILEGED_AUDIT_ACTOR_KINDS = new Set(["privileged-server-role", "captured-user", "platform", "unknown"]);
const PRIVILEGED_AUDIT_OUTCOMES = new Set(["started", "completed", "errored", "finished"]);

function createPrivilegedAuditEmitter(log: { emit: (input: LooseRecord) => any; }) {
  return {
    emit(details: LooseRecord) {
      return emitPrivilegedAuditEvent(log, details);
    },
  };
}

function emitPrivilegedAuditEvent(target: LooseRecord, details: LooseRecord = {}) {
  const log = target?.log?.emit ? target.log : target;
  if (!log?.emit) {
    throw new Error("Privileged audit events require a runtime log sink.");
  }
  return log.emit(createPrivilegedAuditLogInput(details));
}

function createContextPrivilegedApi(database: LooseRecord, contextGetter: () => LooseRecord) {
  return {
    async run(options: LooseRecord, callback: any) {
      const context = contextGetter();
      if (context?.__privilegedRunActive) {
        throw commandError(
          "Nested privileged runs are not supported.",
          "Call separate top-level ctx.privileged.run operations instead of starting one privileged run from inside another.",
          "NESTED_PRIVILEGED_RUN",
        );
      }
      const auditDetails = createPrivilegedRunAuditDetails(context, options);
      if (typeof callback !== "function") {
        throw commandError(
          "Privileged run requires a callback.",
          "Pass a callback to ctx.privileged.run after the operation metadata.",
          "INVALID_PRIVILEGED_RUN_CALLBACK",
        );
      }

      const signal = normalizePrivilegedRunSignal(options.signal);
      try {
        await emitPrivilegedRunAudit(database, context, { ...auditDetails, outcome: "started" });
      } catch (error: any) {
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
        } catch (error: any) {
          callbackError = error;
          callbackSettled = true;
          throw error;
        }
        try {
          await emitPrivilegedRunAudit(database, context, { ...auditDetails, outcome: "completed" });
        } catch (error: any) {
          throw createPrivilegedAuditEmissionPublicError(error, { callbackResult });
        }
        return callbackResult;
      } catch (error: any) {
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
        } catch (auditError: any) {
          throw createPrivilegedAuditEmissionPublicError(auditError, { callbackError: callbackSettled ? callbackError ?? error : error });
        }
        throw createPrivilegedRunPublicError(error);
      } finally {
        try {
          await emitPrivilegedRunAudit(database, context, { ...auditDetails, outcome: "finished" });
        } catch (error: any) {
          throw createPrivilegedAuditEmissionPublicError(
            error,
            callbackSettled
              ? callbackError
                ? { callbackError }
                : { callbackResult }
              : undefined,
          );
        } finally {
          revokePrivilegedDbAccess(privilegedContext);
        }
      }
    },
  };
}

async function emitPrivilegedRunAudit(database: LooseRecord, context: LooseRecord, details: LooseRecord) {
  const event = await database.audit.emit(details);
  recordPrivilegedAuditEventForTransaction(context, event);
  return event;
}

function recordPrivilegedAuditEventForTransaction(context: LooseRecord, event: LooseRecord) {
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

async function reindexPrivilegedAuditEventsAfterRollback(database: LooseRecord, context: LooseRecord | undefined) {
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
    } catch {
      return;
    }
  }
  try {
    await database.sqlite.pruneLogIndex(logIndexLimit(database.config ?? {}));
  } catch {
  }
}

async function privilegedAuditEventAlreadyIndexed(database: LooseRecord, event: LooseRecord) {
  const recent = await database.sqlite.readRecentLogEvents(logIndexLimit(database.config ?? {}));
  return Array.isArray(recent) && recent.some((candidate) => samePrivilegedAuditLogEvent(candidate, event));
}

function samePrivilegedAuditLogEvent(left: LooseRecord, right: LooseRecord) {
  return (
    left?.category === right?.category &&
    left?.event === right?.event &&
    left?.timestamp === right?.timestamp &&
    left?.data?.schema === right?.data?.schema &&
    left?.data?.operation === right?.data?.operation &&
    left?.data?.outcome === right?.data?.outcome &&
    left?.data?.actorKind === right?.data?.actorKind &&
    (left?.data?.safeErrorCode ?? null) === (right?.data?.safeErrorCode ?? null)
  );
}

function normalizePrivilegedRunSignal(value: any) {
  if (value && typeof value === "object" && typeof value.aborted === "boolean") {
    return value;
  }
  return new AbortController().signal;
}

function createPrivilegedRunAbortError() {
  return commandError(
    "Privileged run aborted.",
    "Retry the privileged operation if cancellation was not intended.",
    "ABORTED",
  );
}

function createPrivilegedRunAuditDetails(context: LooseRecord, options: LooseRecord) {
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

function validatedPrivilegedOperation(value: any) {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidPrivilegedRunMetadata("Privileged run requires a stable operation name.");
  }
  const operation = value.trim();
  if (!/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/i.test(operation)) {
    throw invalidPrivilegedRunMetadata("Privileged run operation metadata is invalid.");
  }
  return operation;
}

function validatedPrivilegedMetadata(value: any) {
  if (value === undefined) {
    return {};
  }
  if (!isPlainPrivilegedMetadata(value)) {
    throw invalidPrivilegedRunMetadata("Privileged run metadata must be a structural object.");
  }
  return { ...value };
}

function isPlainPrivilegedMetadata(value: any) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (typeof value.then === "function") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidPrivilegedRunMetadata(message: string) {
  return commandError(
    message,
    "Pass stable, synchronous, structural metadata to ctx.privileged.run before starting privileged work.",
    "INVALID_PRIVILEGED_RUN_METADATA",
  );
}

function createPrivilegedRunPublicError(cause: any) {
  const error = commandError(
    "Privileged run failed.",
    "Check the privileged audit events and server logs before exposing a safe response.",
    "PRIVILEGED_RUN_FAILED",
  );
  error.cause = cause;
  return error;
}

function createPrivilegedAuditEmissionPublicError(cause: any, context: LooseRecord | undefined = undefined) {
  const error = commandError(
    "Privileged audit emission failed.",
    "Check the server audit log configuration before retrying the privileged operation.",
    "PRIVILEGED_AUDIT_EMISSION_FAILED",
  );
  error.cause = cause;
  if (context) {
    (error as any).privilegedAuditContext = context;
  }
  return error;
}

function isPrivilegedAuditEmissionPublicError(error: any) {
  return error?.code === "PRIVILEGED_AUDIT_EMISSION_FAILED";
}

function createPrivilegedHandlerContext(database: LooseRecord, context: LooseRecord, signal: any) {
  const privilegedContext: LooseRecord = {
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
  if (scheduleProvenance) provenanceStore.set(privilegedContext, scheduleProvenance);
  grantPrivilegedDbAccess(privilegedContext);
  const holder = createContextHolder(privilegedContext);
  privilegedContext.db = createEndpointDatabaseApi(database, () => holder.current);
  privilegedContext.files = createPrivilegedFileApi(database, () => holder.current);
  privilegedContext.privileged = createContextPrivilegedApi(database, () => holder.current);
  privilegedContext.jobs = createPrivilegedJobApi(database, () => holder.current);
  privilegedContext.schedules = createPrivilegedScheduleApi(database, () => holder.current);
  return privilegedContext;
}

function createPrivilegedScheduleApi(database: LooseRecord, contextGetter: () => LooseRecord) {
  const sqlite = () => (database.__rootDatabase ?? database).sqlite;
  return {
    async get(name: any) {
      assertActivePrivilegedJobAccess(contextGetter);
      if (typeof name !== "string" || !name) throw jobError("INVALID_SCHEDULE_NAME", "Invalid Schedule name.", "Pass a non-empty declared Schedule name.");
      const row = await sqlite().prepare("SELECT * FROM sporades_schedules WHERE name=?").get(name);
      return row ? await scheduleSummary(sqlite(), row) : null;
    },
    async list() {
      assertActivePrivilegedJobAccess(contextGetter);
      const rows = await sqlite().prepare("SELECT * FROM sporades_schedules ORDER BY name ASC").all();
      const summaries = [];
      for (const row of rows) summaries.push(await scheduleSummary(sqlite(), row));
      return summaries;
    },
  };
}

async function scheduleSummary(sqlite: LooseRecord, row: any) {
  const invalid = (field: string) => {
    const error: any = jobError("SCHEDULE_INSPECTION_INVALID_STATE", "Stored Schedule state is invalid.", "Repair or remove the malformed Schedule before retrying inspection.");
    error.scheduleName = typeof row?.name === "string" ? row.name : null; error.field = field; return error;
  };
  if (typeof row.name !== "string" || !row.name) throw invalid("name");
  if (typeof row.expression !== "string" || !row.expression) throw invalid("expression");
  if (typeof row.effectiveTimezone !== "string" || !row.effectiveTimezone) throw invalid("timezone");
  if (!["skip", "latest"].includes(row.missedRunPolicy)) throw invalid("missedRun");
  if (![0, 1, false, true].includes(row.enabled)) throw invalid("enabled");
  const canonicalInstant = (value: unknown) => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
  if (row.nextOccurrence != null && !canonicalInstant(row.nextOccurrence)) throw invalid("nextOccurrence");
  const latestOutcome = row.latestOutcome == null ? null : String(row.latestOutcome);
  let latestOccurrence = null;
  if (latestOutcome === null && [row.latestScheduledFor, row.latestJobId, row.latestErrorCode].some((value) => value != null)) throw invalid("latestOccurrence");
  if (latestOutcome !== null && !canonicalInstant(row.latestScheduledFor)) throw invalid("latestOccurrence.scheduledFor");
  if (latestOutcome === "enqueued") {
    if (typeof row.latestJobId !== "string" || !row.latestJobId) throw invalid("latestOccurrence.jobId");
    if (row.latestErrorCode != null) throw invalid("latestOccurrence.errorCode");
    const job = await sqlite.prepare("SELECT id FROM sporades_jobs WHERE id=? AND scheduleName=? AND scheduledFor=?").get(row.latestJobId, row.name, row.latestScheduledFor);
    if (!job) throw invalid("latestOccurrence.jobId");
    latestOccurrence = { scheduledFor: row.latestScheduledFor, outcome: "enqueued", jobId: row.latestJobId };
  } else if (latestOutcome === "payload-failed") {
    if (row.latestJobId != null) throw invalid("latestOccurrence.jobId");
    if (typeof row.latestErrorCode !== "string" || !row.latestErrorCode) throw invalid("latestOccurrence.errorCode");
    if (!["SCHEDULE_PAYLOAD_FAILED", "SCHEDULE_ENQUEUE_FAILED"].includes(row.latestErrorCode)) throw invalid("latestOccurrence.errorCode");
    latestOccurrence = { scheduledFor: row.latestScheduledFor, outcome: "payload-failed", errorCode: row.latestErrorCode };
  } else if (latestOutcome !== null) throw invalid("latestOccurrence.outcome");
  return {
    name: String(row.name), expression: String(row.expression), timezone: String(row.effectiveTimezone),
    missedRun: String(row.missedRunPolicy), enabled: Boolean(row.enabled), nextOccurrence: row.nextOccurrence == null ? null : String(row.nextOccurrence), latestOccurrence,
  };
}

function createPrivilegedFileApi(database: LooseRecord, contextGetter: () => LooseRecord) {
  return Object.freeze({
    async url(fileReference: any) {
      const active = activePrivilegedFileAccess(contextGetter);
      if (!active.ok) {
        return active;
      }
      const resolved: any = await resolvePrivilegedLiveFileReference(database, fileReference);
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
          file: {
            ...fileMetadataFromRow(row),
            ownerId: row.ownerId,
          },
        },
        error: null as any,
      };
    },
    async createPublicUrl(fileReference: any, options: LooseRecord = {}) {
      const active = activePrivilegedFileAccess(contextGetter);
      if (!active.ok) {
        return active;
      }
      const resolved: any = await resolvePrivilegedLiveFileReference(database, fileReference);
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
    async delete(fileReference: any) {
      const active = activePrivilegedFileAccess(contextGetter);
      if (!active.ok) {
        return active;
      }
      const resolved: any = await resolvePrivilegedLiveFileReference(database, fileReference);
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
        throw commandError(
          active.error?.message ?? "Privileged file access is no longer active.",
          active.error?.hint ?? "Start a new ctx.privileged.run callback before using privileged file operations.",
          "PRIVILEGED_FILE_ACCESS_INACTIVE",
        );
      }
      throw commandError(
        "Unsupported privileged file operation.",
        "Use one of the approved privileged file operations: url, createPublicUrl, or delete.",
        "UNSUPPORTED_PRIVILEGED_FILE_OPERATION",
      );
    },
  });
}

function activePrivilegedFileAccess(contextGetter: () => LooseRecord) {
  if (hasPrivilegedDbAccess(contextGetter?.())) {
    return { ok: true };
  }
  return {
    ok: false,
    error: createStructuredFileError(
      "Privileged file access is no longer active.",
      "Start a new ctx.privileged.run callback before using privileged file operations.",
    ),
  };
}

function privilegedAuthUserId() {
  return "__privileged__";
}

function isReservedAuthUserId(userId: any) {
  return userId === privilegedAuthUserId();
}

function authIdentityRowUnlessReserved(rowOrPromise: any) {
  if (rowOrPromise && typeof rowOrPromise.then === "function") {
    return rowOrPromise.then((row: any) => (isReservedAuthUserId(row?.userId) ? null : row));
  }
  return isReservedAuthUserId(rowOrPromise?.userId) ? null : rowOrPromise;
}

function authIdentityRowsUnlessReserved(rowsOrPromise: any) {
  if (rowsOrPromise && typeof rowsOrPromise.then === "function") {
    return rowsOrPromise.then((rows: any[]) => rows.filter((row) => !isReservedAuthUserId(row?.userId)));
  }
  return rowsOrPromise.filter((row: any) => !isReservedAuthUserId(row?.userId));
}

function assertNotReservedAuthUserId(userId: any) {
  if (!isReservedAuthUserId(userId)) {
    return;
  }
  throw commandError(
    "Reserved auth user ID cannot be used for a real Sporades user.",
    "Use runtime-generated user IDs for sessions and auth provider links.",
    "RESERVED_AUTH_USER_ID",
  );
}

export function createPrivilegedAuditLogInput(details: LooseRecord = {}) {
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

function normalizePrivilegedAuditActorKind(value: any) {
  const candidate = String(value ?? "unknown");
  return PRIVILEGED_AUDIT_ACTOR_KINDS.has(candidate) ? candidate : "unknown";
}

function normalizePrivilegedAuditOutcome(value: any) {
  const candidate = String(value ?? "started");
  return PRIVILEGED_AUDIT_OUTCOMES.has(candidate) ? candidate : "started";
}

function privilegedAuditLevelForOutcome(outcome: string) {
  if (outcome === "errored") {
    return "error";
  }
  return "info";
}

function safePrivilegedAuditErrorCode(value: any, outcome = "started") {
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

function normalizePrivilegedAuditCorrelation(value: any) {
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

function auditString(value: any, fallback: string) {
  const text = value === null || value === undefined ? "" : String(value);
  return text.trim() ? text : fallback;
}

export function createLogEnvelope(input: { config: LooseRecord; timestamp: any; category: any; event: any; level: any; message: any; release: any; request: { id: any; method: any; path: any; }; correlation: any; data: any; serverEnv: any; }) {
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

function sanitizeLogData(value: any, serverEnv: any) {
  return redactLogData(value, serverEnv);
}

function redactLogData(value: unknown, serverEnv: any): any {
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
    return value.map((item: any) => redactLogData(item, serverEnv));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]: [string, any]) => [
        key,
        isSensitiveLogKey(key)
          ? logRedactedValue()
          : redactLogData(nestedValue, serverEnv),
      ]),
    );
  }
  return String(value);
}

function logDataContainsServerEnvValue(value: unknown, serverEnv: any) {
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
  const serialized = JSON.stringify(value, (_key, nestedValue) =>
    typeof nestedValue === "bigint" ? String(nestedValue) : nestedValue,
  );
  return values.some((secret) => serialized.includes(String(secret)));
}

function isSensitiveLogKey(key: string) {
  return (
    /(^|[-_])(?:password|passwd|token|secret|authorization|cookie|client[-_]?secret|api[-_]?token|private[-_]?key|authorized[-_]?keys?|request[-_]?body|raw[-_]?body|stack(?:trace)?)([-_]|$)/i.test(String(key)) ||
    /(?:password|passwd|token|secret|authorization|cookie|clientSecret|apiToken|privateKey|authorizedKeys|requestBody|rawRequestBody|stackTrace)/i.test(String(key))
  );
}

function isSensitiveLogString(value: string) {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) ||
    /\b(?:ssh-rsa|ssh-ed25519|ecdsa-sha2-[^\s]+)\s+[A-Za-z0-9+/=]{32,}/.test(value) ||
    /(^|\n)\s*at\s+.+:\d+:\d+/.test(value)
  );
}

function capLogEnvelope(envelope: LooseRecord, maxBytes: number) {
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

function createLogIndexTables(sqlite: { engine?: string; exec: any; prepare?: (sql: any) => { all(...params: any[]): Record<string, SQLOutputValue>[]; get(...params: any[]): Record<string, SQLOutputValue> | undefined; run(...params: any[]): StatementResultingChanges; columns(): StatementColumnMetadata[]; }; ensureSystemTable?: () => void; readSystemMetadata?: (key: any) => Record<string, SQLOutputValue> | null; writeSystemMetadata?: (key: any, value: any) => StatementResultingChanges; readSchemaMetadata?: () => Record<string, SQLOutputValue> | null; writeSchemaMetadata?: ({ schemaVersion, schemaHash, schemaJson }: { schemaVersion: any; schemaHash: any; schemaJson: any; }) => void; ensureLogStorage?: () => void; insertLogIndexEvent?: (event: any) => void; pruneLogIndex?: (limit: any) => void; readRecentLogEvents?: (limit: any) => any; ensureFileStorage?: () => void; findFileBucket?: (ownerId: any, name: any) => Record<string, SQLOutputValue> | null; createFileBucket?: (row: any) => StatementResultingChanges; insertFileRow?: (row: any) => StatementResultingChanges; updatePendingFileRow?: (row: any) => StatementResultingChanges; insertFileUpload?: (row: any) => StatementResultingChanges; selectFileById?: (fileId: any) => Record<string, SQLOutputValue> | null; selectLiveFileByPath?: (path: any) => Record<string, SQLOutputValue>[]; selectActiveFileByPath?: (path: any) => Record<string, SQLOutputValue>[]; selectPendingFileUploadByPath?: (path: any) => Record<string, SQLOutputValue> | null; selectFileUpload?: (uploadId: any) => Record<string, SQLOutputValue> | null; completeFileUpload?: (upload: any, size: any, updatedAt: any) => StatementResultingChanges | { changes: number; }; deleteFileUploadsForPath?: (path: any) => StatementResultingChanges; deleteFileUploadsForFile?: (ownerId: any, fileId: any) => StatementResultingChanges; deleteFileUpload?: (uploadId: any) => StatementResultingChanges; selectPublicFileRow?: (publicUrlId: any) => Record<string, SQLOutputValue> | null; insertPublicFileUrl?: (row: any) => StatementResultingChanges; revokePublicFileUrl?: (publicUrlId: any, ownerId: any, revokedAt: any) => StatementResultingChanges; revokePublicFileUrlsForFile?: (fileId: any, revokedAt: any) => StatementResultingChanges; markFileDeleted?: (fileId: any, deletedAt: any) => StatementResultingChanges; fileRowForOwner?: (fileId: any, ownerId: any) => Record<string, SQLOutputValue> | null; ensureAuthStorage?: (authConfig?: null) => void; findAuthUserByProviderEmail?: (provider: any, email: any) => Record<string, SQLOutputValue> | null; insertAuthUser?: (row: any) => StatementResultingChanges; updateAuthUserProfile?: (row: any) => StatementResultingChanges; linkAuthUser?: (row: any) => StatementResultingChanges; insertAuthSession?: (row: any) => StatementResultingChanges; deleteAuthSession?: (token: any) => StatementResultingChanges; refreshAuthSession?: (token: any, expiresAt: any) => StatementResultingChanges; rotateAuthSession?: (previousToken: any, row: any) => StatementResultingChanges; readAuthSessionWithUser?: (token: any) => Record<string, SQLOutputValue> | null; insertOAuthState?: (row: any) => StatementResultingChanges; consumeOAuthState?: (state: any) => Record<string, SQLOutputValue> | null; emailCredentialExists?: (email: any) => boolean; insertEmailCredential?: (row: any) => StatementResultingChanges; findEmailCredentialWithUser?: (email: any) => Record<string, SQLOutputValue> | null; migrateAppSchema?: (schema: any) => any; createAppTable?: (table: any, tableName?: any) => any; migrateExistingAppTable?: (existingTable: any, nextTable: any) => any; referenceExists?: (field: any, value: any) => boolean; withTransaction?: (fn: any) => Promise<any>; insertAppRow?: (table: any, row: any) => StatementResultingChanges; selectAppRowById?: (table: any, id: any) => Record<string, SQLOutputValue> | null; updateAppRow?: (table: any, id: any, values: any, options?: {}) => StatementResultingChanges | { changes: number; }; deleteAppRow?: (table: any, id: any) => StatementResultingChanges; selectAppRows?: (table: any, query?: {}) => Record<string, SQLOutputValue>[]; listInspectableTables?: () => SQLOutputValue[]; dumpInspectableDatabase?: () => { name: SQLOutputValue; columns: SQLOutputValue[]; rows: Record<string, SQLOutputValue>[]; }[]; runReadOnlyInspectionQuery?: (sql: any) => { ok: boolean; data: { columns: string[]; rows: Record<string, SQLOutputValue>[]; }; error: null; } | { ok: boolean; data: null; error: { message: any; hint: string; }; }; checkHealth?: () => { ok: boolean; }; close?: () => void; }) {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_log_events (" +
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
    ")",
  );
}

function insertLogIndexEvent(sqlite: { engine?: string; exec?: (sql: any) => void; prepare: any; ensureSystemTable?: () => void; readSystemMetadata?: (key: any) => Record<string, SQLOutputValue> | null; writeSystemMetadata?: (key: any, value: any) => StatementResultingChanges; readSchemaMetadata?: () => Record<string, SQLOutputValue> | null; writeSchemaMetadata?: ({ schemaVersion, schemaHash, schemaJson }: { schemaVersion: any; schemaHash: any; schemaJson: any; }) => void; ensureLogStorage?: () => void; insertLogIndexEvent?: (event: any) => void; pruneLogIndex?: (limit: any) => void; readRecentLogEvents?: (limit: any) => any; ensureFileStorage?: () => void; findFileBucket?: (ownerId: any, name: any) => Record<string, SQLOutputValue> | null; createFileBucket?: (row: any) => StatementResultingChanges; insertFileRow?: (row: any) => StatementResultingChanges; updatePendingFileRow?: (row: any) => StatementResultingChanges; insertFileUpload?: (row: any) => StatementResultingChanges; selectFileById?: (fileId: any) => Record<string, SQLOutputValue> | null; selectLiveFileByPath?: (path: any) => Record<string, SQLOutputValue>[]; selectActiveFileByPath?: (path: any) => Record<string, SQLOutputValue>[]; selectPendingFileUploadByPath?: (path: any) => Record<string, SQLOutputValue> | null; selectFileUpload?: (uploadId: any) => Record<string, SQLOutputValue> | null; completeFileUpload?: (upload: any, size: any, updatedAt: any) => StatementResultingChanges | { changes: number; }; deleteFileUploadsForPath?: (path: any) => StatementResultingChanges; deleteFileUploadsForFile?: (ownerId: any, fileId: any) => StatementResultingChanges; deleteFileUpload?: (uploadId: any) => StatementResultingChanges; selectPublicFileRow?: (publicUrlId: any) => Record<string, SQLOutputValue> | null; insertPublicFileUrl?: (row: any) => StatementResultingChanges; revokePublicFileUrl?: (publicUrlId: any, ownerId: any, revokedAt: any) => StatementResultingChanges; revokePublicFileUrlsForFile?: (fileId: any, revokedAt: any) => StatementResultingChanges; markFileDeleted?: (fileId: any, deletedAt: any) => StatementResultingChanges; fileRowForOwner?: (fileId: any, ownerId: any) => Record<string, SQLOutputValue> | null; ensureAuthStorage?: (authConfig?: null) => void; findAuthUserByProviderEmail?: (provider: any, email: any) => Record<string, SQLOutputValue> | null; insertAuthUser?: (row: any) => StatementResultingChanges; updateAuthUserProfile?: (row: any) => StatementResultingChanges; linkAuthUser?: (row: any) => StatementResultingChanges; insertAuthSession?: (row: any) => StatementResultingChanges; deleteAuthSession?: (token: any) => StatementResultingChanges; refreshAuthSession?: (token: any, expiresAt: any) => StatementResultingChanges; rotateAuthSession?: (previousToken: any, row: any) => StatementResultingChanges; readAuthSessionWithUser?: (token: any) => Record<string, SQLOutputValue> | null; insertOAuthState?: (row: any) => StatementResultingChanges; consumeOAuthState?: (state: any) => Record<string, SQLOutputValue> | null; emailCredentialExists?: (email: any) => boolean; insertEmailCredential?: (row: any) => StatementResultingChanges; findEmailCredentialWithUser?: (email: any) => Record<string, SQLOutputValue> | null; migrateAppSchema?: (schema: any) => any; createAppTable?: (table: any, tableName?: any) => any; migrateExistingAppTable?: (existingTable: any, nextTable: any) => any; referenceExists?: (field: any, value: any) => boolean; withTransaction?: (fn: any) => Promise<any>; insertAppRow?: (table: any, row: any) => StatementResultingChanges; selectAppRowById?: (table: any, id: any) => Record<string, SQLOutputValue> | null; updateAppRow?: (table: any, id: any, values: any, options?: {}) => StatementResultingChanges | { changes: number; }; deleteAppRow?: (table: any, id: any) => StatementResultingChanges; selectAppRows?: (table: any, query?: {}) => Record<string, SQLOutputValue>[]; listInspectableTables?: () => SQLOutputValue[]; dumpInspectableDatabase?: () => { name: SQLOutputValue; columns: SQLOutputValue[]; rows: Record<string, SQLOutputValue>[]; }[]; runReadOnlyInspectionQuery?: (sql: any) => { ok: boolean; data: { columns: string[]; rows: Record<string, SQLOutputValue>[]; }; error: null; } | { ok: boolean; data: null; error: { message: any; hint: string; }; }; checkHealth?: () => { ok: boolean; }; close?: () => void; }, event: { timestamp: any; category: any; event: any; level: any; message: any; capsule: { name: any; id: any; }; release: { id: any; }; request: { id: any; }; correlation: { id: any; }; }) {
  sqlite
    .prepare(
      "INSERT INTO sporades_log_events " +
      "(id, timestamp, category, event, level, message, capsuleName, capsuleId, releaseId, requestId, correlationId, payload) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      randomUUID(),
      event.timestamp,
      event.category,
      event.event,
      event.level,
      event.message,
      event.capsule?.name ?? null,
      event.capsule?.id ?? null,
      event.release?.id ?? event.release ?? null,
      event.request?.id ?? null,
      event.correlation?.id ?? event.correlation ?? null,
      JSON.stringify(event),
    );
}

function pruneLogIndex(sqlite: { engine?: string; exec?: (sql: any) => void; prepare: any; ensureSystemTable?: () => void; readSystemMetadata?: (key: any) => Record<string, SQLOutputValue> | null; writeSystemMetadata?: (key: any, value: any) => StatementResultingChanges; readSchemaMetadata?: () => Record<string, SQLOutputValue> | null; writeSchemaMetadata?: ({ schemaVersion, schemaHash, schemaJson }: { schemaVersion: any; schemaHash: any; schemaJson: any; }) => void; ensureLogStorage?: () => void; insertLogIndexEvent?: (event: any) => void; pruneLogIndex?: (limit: any) => void; readRecentLogEvents?: (limit: any) => any; ensureFileStorage?: () => void; findFileBucket?: (ownerId: any, name: any) => Record<string, SQLOutputValue> | null; createFileBucket?: (row: any) => StatementResultingChanges; insertFileRow?: (row: any) => StatementResultingChanges; updatePendingFileRow?: (row: any) => StatementResultingChanges; insertFileUpload?: (row: any) => StatementResultingChanges; selectFileById?: (fileId: any) => Record<string, SQLOutputValue> | null; selectLiveFileByPath?: (path: any) => Record<string, SQLOutputValue>[]; selectActiveFileByPath?: (path: any) => Record<string, SQLOutputValue>[]; selectPendingFileUploadByPath?: (path: any) => Record<string, SQLOutputValue> | null; selectFileUpload?: (uploadId: any) => Record<string, SQLOutputValue> | null; completeFileUpload?: (upload: any, size: any, updatedAt: any) => StatementResultingChanges | { changes: number; }; deleteFileUploadsForPath?: (path: any) => StatementResultingChanges; deleteFileUploadsForFile?: (ownerId: any, fileId: any) => StatementResultingChanges; deleteFileUpload?: (uploadId: any) => StatementResultingChanges; selectPublicFileRow?: (publicUrlId: any) => Record<string, SQLOutputValue> | null; insertPublicFileUrl?: (row: any) => StatementResultingChanges; revokePublicFileUrl?: (publicUrlId: any, ownerId: any, revokedAt: any) => StatementResultingChanges; revokePublicFileUrlsForFile?: (fileId: any, revokedAt: any) => StatementResultingChanges; markFileDeleted?: (fileId: any, deletedAt: any) => StatementResultingChanges; fileRowForOwner?: (fileId: any, ownerId: any) => Record<string, SQLOutputValue> | null; ensureAuthStorage?: (authConfig?: null) => void; findAuthUserByProviderEmail?: (provider: any, email: any) => Record<string, SQLOutputValue> | null; insertAuthUser?: (row: any) => StatementResultingChanges; updateAuthUserProfile?: (row: any) => StatementResultingChanges; linkAuthUser?: (row: any) => StatementResultingChanges; insertAuthSession?: (row: any) => StatementResultingChanges; deleteAuthSession?: (token: any) => StatementResultingChanges; refreshAuthSession?: (token: any, expiresAt: any) => StatementResultingChanges; rotateAuthSession?: (previousToken: any, row: any) => StatementResultingChanges; readAuthSessionWithUser?: (token: any) => Record<string, SQLOutputValue> | null; insertOAuthState?: (row: any) => StatementResultingChanges; consumeOAuthState?: (state: any) => Record<string, SQLOutputValue> | null; emailCredentialExists?: (email: any) => boolean; insertEmailCredential?: (row: any) => StatementResultingChanges; findEmailCredentialWithUser?: (email: any) => Record<string, SQLOutputValue> | null; migrateAppSchema?: (schema: any) => any; createAppTable?: (table: any, tableName?: any) => any; migrateExistingAppTable?: (existingTable: any, nextTable: any) => any; referenceExists?: (field: any, value: any) => boolean; withTransaction?: (fn: any) => Promise<any>; insertAppRow?: (table: any, row: any) => StatementResultingChanges; selectAppRowById?: (table: any, id: any) => Record<string, SQLOutputValue> | null; updateAppRow?: (table: any, id: any, values: any, options?: {}) => StatementResultingChanges | { changes: number; }; deleteAppRow?: (table: any, id: any) => StatementResultingChanges; selectAppRows?: (table: any, query?: {}) => Record<string, SQLOutputValue>[]; listInspectableTables?: () => SQLOutputValue[]; dumpInspectableDatabase?: () => { name: SQLOutputValue; columns: SQLOutputValue[]; rows: Record<string, SQLOutputValue>[]; }[]; runReadOnlyInspectionQuery?: (sql: any) => { ok: boolean; data: { columns: string[]; rows: Record<string, SQLOutputValue>[]; }; error: null; } | { ok: boolean; data: null; error: { message: any; hint: string; }; }; checkHealth?: () => { ok: boolean; }; close?: () => void; }, limit: any) {
  sqlite
    .prepare(
      "DELETE FROM sporades_log_events WHERE id IN (" +
      "SELECT id FROM sporades_log_events ORDER BY timestamp DESC, rowid DESC LIMIT -1 OFFSET ?" +
      ")",
    )
    .run(limit);
}

function readRecentLogEvents(sqlite: { engine?: string; exec?: (sql: any) => void; prepare: any; ensureSystemTable?: () => void; readSystemMetadata?: (key: any) => Record<string, SQLOutputValue> | null; writeSystemMetadata?: (key: any, value: any) => StatementResultingChanges; readSchemaMetadata?: () => Record<string, SQLOutputValue> | null; writeSchemaMetadata?: ({ schemaVersion, schemaHash, schemaJson }: { schemaVersion: any; schemaHash: any; schemaJson: any; }) => void; ensureLogStorage?: () => void; insertLogIndexEvent?: (event: any) => void; pruneLogIndex?: (limit: any) => void; readRecentLogEvents?: (limit: any) => any; ensureFileStorage?: () => void; findFileBucket?: (ownerId: any, name: any) => Record<string, SQLOutputValue> | null; createFileBucket?: (row: any) => StatementResultingChanges; insertFileRow?: (row: any) => StatementResultingChanges; updatePendingFileRow?: (row: any) => StatementResultingChanges; insertFileUpload?: (row: any) => StatementResultingChanges; selectFileById?: (fileId: any) => Record<string, SQLOutputValue> | null; selectLiveFileByPath?: (path: any) => Record<string, SQLOutputValue>[]; selectActiveFileByPath?: (path: any) => Record<string, SQLOutputValue>[]; selectPendingFileUploadByPath?: (path: any) => Record<string, SQLOutputValue> | null; selectFileUpload?: (uploadId: any) => Record<string, SQLOutputValue> | null; completeFileUpload?: (upload: any, size: any, updatedAt: any) => StatementResultingChanges | { changes: number; }; deleteFileUploadsForPath?: (path: any) => StatementResultingChanges; deleteFileUploadsForFile?: (ownerId: any, fileId: any) => StatementResultingChanges; deleteFileUpload?: (uploadId: any) => StatementResultingChanges; selectPublicFileRow?: (publicUrlId: any) => Record<string, SQLOutputValue> | null; insertPublicFileUrl?: (row: any) => StatementResultingChanges; revokePublicFileUrl?: (publicUrlId: any, ownerId: any, revokedAt: any) => StatementResultingChanges; revokePublicFileUrlsForFile?: (fileId: any, revokedAt: any) => StatementResultingChanges; markFileDeleted?: (fileId: any, deletedAt: any) => StatementResultingChanges; fileRowForOwner?: (fileId: any, ownerId: any) => Record<string, SQLOutputValue> | null; ensureAuthStorage?: (authConfig?: null) => void; findAuthUserByProviderEmail?: (provider: any, email: any) => Record<string, SQLOutputValue> | null; insertAuthUser?: (row: any) => StatementResultingChanges; updateAuthUserProfile?: (row: any) => StatementResultingChanges; linkAuthUser?: (row: any) => StatementResultingChanges; insertAuthSession?: (row: any) => StatementResultingChanges; deleteAuthSession?: (token: any) => StatementResultingChanges; refreshAuthSession?: (token: any, expiresAt: any) => StatementResultingChanges; rotateAuthSession?: (previousToken: any, row: any) => StatementResultingChanges; readAuthSessionWithUser?: (token: any) => Record<string, SQLOutputValue> | null; insertOAuthState?: (row: any) => StatementResultingChanges; consumeOAuthState?: (state: any) => Record<string, SQLOutputValue> | null; emailCredentialExists?: (email: any) => boolean; insertEmailCredential?: (row: any) => StatementResultingChanges; findEmailCredentialWithUser?: (email: any) => Record<string, SQLOutputValue> | null; migrateAppSchema?: (schema: any) => any; createAppTable?: (table: any, tableName?: any) => any; migrateExistingAppTable?: (existingTable: any, nextTable: any) => any; referenceExists?: (field: any, value: any) => boolean; withTransaction?: (fn: any) => Promise<any>; insertAppRow?: (table: any, row: any) => StatementResultingChanges; selectAppRowById?: (table: any, id: any) => Record<string, SQLOutputValue> | null; updateAppRow?: (table: any, id: any, values: any, options?: {}) => StatementResultingChanges | { changes: number; }; deleteAppRow?: (table: any, id: any) => StatementResultingChanges; selectAppRows?: (table: any, query?: {}) => Record<string, SQLOutputValue>[]; listInspectableTables?: () => SQLOutputValue[]; dumpInspectableDatabase?: () => { name: SQLOutputValue; columns: SQLOutputValue[]; rows: Record<string, SQLOutputValue>[]; }[]; runReadOnlyInspectionQuery?: (sql: any) => { ok: boolean; data: { columns: string[]; rows: Record<string, SQLOutputValue>[]; }; error: null; } | { ok: boolean; data: null; error: { message: any; hint: string; }; }; checkHealth?: () => { ok: boolean; }; close?: () => void; }, limit = 200) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : 200;
  return sqlite
    .prepare("SELECT payload FROM sporades_log_events ORDER BY timestamp DESC, rowid DESC LIMIT ?")
    .all(safeLimit)
    .reverse()
    .map((row: { payload: string; }) => JSON.parse(row.payload));
}

export function readJsonlLogEvents(logPath: PathOrFileDescriptor, limit = 200) {
  let raw = "";
  try {
    raw = readFileSync(logPath, "utf8");
  } catch (error: any) {
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

export function schemaFromCapsuleDefinition(definition: any) {
  const schema = definition?.schema ?? {};
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw commandError(
      "Invalid Capsule schema.",
      "Pass an object whose values are table(...) declarations to capsule({ schema }).",
    );
  }

  return {
    tables: Object.entries(schema).map(([name, table]) => schemaTableFromCapsuleTable(name, table)),
  };
}

function schemaTableFromCapsuleTable(name: string, table: any) {
  if (!table || table.kind !== "table" || !table.fields || typeof table.fields !== "object" || Array.isArray(table.fields)) {
    throw commandError(
      `Invalid Capsule table: ${name}`,
      "Declare schema tables with table({ fieldName: FieldBuilder() }).",
    );
  }

  return {
    name,
    acl: normalizeTableAcl(name, table.aclRules),
    fields: Object.entries(table.fields).map(([fieldName, field]) => schemaFieldFromCapsuleField(fieldName, field)),
  };
}

function normalizeTableAcl(tableName: any, aclRules: LooseRecord | undefined) {
  const supportedOperations = new Set(["read", "write", "insert", "update", "delete"]);
  if (aclRules === undefined) {
    return {
      allowByDefault: true,
      resolve(operation: any) {
        return resolveEffectiveAclRule(this, operation);
      },
    };
  }
  if (!aclRules || typeof aclRules !== "object" || Array.isArray(aclRules)) {
    throw commandError(
      `Invalid Capsule table ACL: ${tableName}`,
      "Pass an object with function rules for read, write, insert, update, and delete.",
    );
  }

  const normalized: LooseRecord = {
    allowByDefault: true,
  };
  for (const [operation, rule] of Object.entries(aclRules)) {
    if (!supportedOperations.has(operation)) {
      throw commandError(
        `Unsupported Capsule table ACL operation: ${tableName}.${operation}`,
        "Supported ACL operations are read, write, insert, update, and delete.",
      );
    }
    if (typeof rule !== "function") {
      throw commandError(
        `Invalid Capsule table ACL: ${tableName}.${operation}`,
        "ACL rules must be functions for read, write, insert, update, and delete.",
      );
    }
    normalized[operation] = rule;
  }
  normalized.resolve = function resolve(operation: any) {
    return resolveEffectiveAclRule(this, operation);
  };
  return normalized;
}

function resolveEffectiveAclRule(aclRules: { [x: string]: any; allowByDefault?: boolean; resolve?: (operation: any) => any; write?: any; }, operation: string) {
  if (!aclRules || typeof aclRules !== "object") {
    return undefined;
  }
  if (operation === "insert" || operation === "update" || operation === "delete") {
    return aclRules[operation] ?? aclRules.write;
  }
  return aclRules[operation];
}

function schemaFieldFromCapsuleField(name: string, field: any) {
  if (!field || typeof field !== "object" || typeof field.kind !== "string") {
    throw commandError(
      `Invalid Capsule field: ${name}`,
      "Use Sporades field builders such as String(), Boolean(), Number(), Date(), Json(), or Reference(...).",
    );
  }

  const supportedKinds = new Set(["String", "Boolean", "Number", "Date", "Json", "Reference"]);
  if (!supportedKinds.has(field.kind)) {
    throw commandError(
      `Unsupported Capsule field type: ${field.kind}`,
      "Use supported Sporades field builders: String, Boolean, Number, Date, Json, Reference.",
    );
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

function sqliteTypeForFieldKind(kind: string) {
  if (kind === "Boolean") {
    return "INTEGER";
  }
  if (kind === "Number") {
    return "REAL";
  }
  return "TEXT";
}

function migrateAppSchema(sqlite: { engine?: string; exec?: (sql: any) => void; prepare?: (sql: any) => { all(...params: any[]): Record<string, SQLOutputValue>[]; get(...params: any[]): Record<string, SQLOutputValue> | undefined; run(...params: any[]): StatementResultingChanges; columns(): StatementColumnMetadata[]; }; ensureSystemTable?: () => void; readSystemMetadata?: (key: any) => Record<string, SQLOutputValue> | null; writeSystemMetadata?: (key: any, value: any) => StatementResultingChanges; readSchemaMetadata: any; writeSchemaMetadata: any; ensureLogStorage?: () => void; insertLogIndexEvent?: (event: any) => void; pruneLogIndex?: (limit: any) => void; readRecentLogEvents?: (limit: any) => any; ensureFileStorage?: () => void; findFileBucket?: (ownerId: any, name: any) => Record<string, SQLOutputValue> | null; createFileBucket?: (row: any) => StatementResultingChanges; insertFileRow?: (row: any) => StatementResultingChanges; updatePendingFileRow?: (row: any) => StatementResultingChanges; insertFileUpload?: (row: any) => StatementResultingChanges; selectFileById?: (fileId: any) => Record<string, SQLOutputValue> | null; selectLiveFileByPath?: (path: any) => Record<string, SQLOutputValue>[]; selectActiveFileByPath?: (path: any) => Record<string, SQLOutputValue>[]; selectPendingFileUploadByPath?: (path: any) => Record<string, SQLOutputValue> | null; selectFileUpload?: (uploadId: any) => Record<string, SQLOutputValue> | null; completeFileUpload?: (upload: any, size: any, updatedAt: any) => StatementResultingChanges | { changes: number; }; deleteFileUploadsForPath?: (path: any) => StatementResultingChanges; deleteFileUploadsForFile?: (ownerId: any, fileId: any) => StatementResultingChanges; deleteFileUpload?: (uploadId: any) => StatementResultingChanges; selectPublicFileRow?: (publicUrlId: any) => Record<string, SQLOutputValue> | null; insertPublicFileUrl?: (row: any) => StatementResultingChanges; revokePublicFileUrl?: (publicUrlId: any, ownerId: any, revokedAt: any) => StatementResultingChanges; revokePublicFileUrlsForFile?: (fileId: any, revokedAt: any) => StatementResultingChanges; markFileDeleted?: (fileId: any, deletedAt: any) => StatementResultingChanges; fileRowForOwner?: (fileId: any, ownerId: any) => Record<string, SQLOutputValue> | null; ensureAuthStorage?: (authConfig?: null) => void; findAuthUserByProviderEmail?: (provider: any, email: any) => Record<string, SQLOutputValue> | null; insertAuthUser?: (row: any) => StatementResultingChanges; updateAuthUserProfile?: (row: any) => StatementResultingChanges; linkAuthUser?: (row: any) => StatementResultingChanges; insertAuthSession?: (row: any) => StatementResultingChanges; deleteAuthSession?: (token: any) => StatementResultingChanges; refreshAuthSession?: (token: any, expiresAt: any) => StatementResultingChanges; rotateAuthSession?: (previousToken: any, row: any) => StatementResultingChanges; readAuthSessionWithUser?: (token: any) => Record<string, SQLOutputValue> | null; insertOAuthState?: (row: any) => StatementResultingChanges; consumeOAuthState?: (state: any) => Record<string, SQLOutputValue> | null; emailCredentialExists?: (email: any) => boolean; insertEmailCredential?: (row: any) => StatementResultingChanges; findEmailCredentialWithUser?: (email: any) => Record<string, SQLOutputValue> | null; migrateAppSchema?: (schema: any) => any; createAppTable: any; migrateExistingAppTable: any; referenceExists?: (field: any, value: any) => boolean; withTransaction?: (fn: any) => Promise<any>; insertAppRow?: (table: any, row: any) => StatementResultingChanges; selectAppRowById?: (table: any, id: any) => Record<string, SQLOutputValue> | null; updateAppRow?: (table: any, id: any, values: any, options?: {}) => StatementResultingChanges | { changes: number; }; deleteAppRow?: (table: any, id: any) => StatementResultingChanges; selectAppRows?: (table: any, query?: {}) => Record<string, SQLOutputValue>[]; listInspectableTables?: () => SQLOutputValue[]; dumpInspectableDatabase?: () => { name: SQLOutputValue; columns: SQLOutputValue[]; rows: Record<string, SQLOutputValue>[]; }[]; runReadOnlyInspectionQuery?: (sql: any) => { ok: boolean; data: { columns: string[]; rows: Record<string, SQLOutputValue>[]; }; error: null; } | { ok: boolean; data: null; error: { message: any; hint: string; }; }; checkHealth?: () => { ok: boolean; }; close?: () => void; }, schema: { tables: any[]; }) {
  const nextSchema = normalizeSchema(schema);
  const nextSchemaJson = JSON.stringify(nextSchema);
  const nextSchemaHash = hashSchema(nextSchemaJson);
  const existingSchemaRow = sqlite.readSchemaMetadata();
  let existingSchema = null;
  let schemaChanged = false;

  if (existingSchemaRow) {
    try {
      existingSchema = JSON.parse(existingSchemaRow.value);
    } catch {
      throw commandError(
        "Invalid Sporades schema metadata.",
        "Delete the Runtime directory only if you can lose local data, then restart the Capsule.",
      );
    }

    schemaChanged = hashSchema(JSON.stringify(existingSchema)) !== nextSchemaHash;
    if (schemaChanged) {
      assertAdditiveSchemaMigration(existingSchema, nextSchema);
    }
  }

  const existingTables = new Map((existingSchema?.tables ?? []).map((table: { name: any; }) => [table.name, table]));
  return chainMaybePromise([
    ...schema.tables.map((table: { name: unknown; }) => () => {
      const existingTable = existingTables.get(table.name);
      return schemaChanged && existingTable ? sqlite.migrateExistingAppTable(existingTable, table) : sqlite.createAppTable(table);
    }),
    () =>
      sqlite.writeSchemaMetadata({
        schemaVersion: "v1:additive-fields",
        schemaHash: nextSchemaHash,
        schemaJson: nextSchemaJson,
      }),
  ]);
}

async function migrateLibsqlAppSchema(sqlite: { engine?: string; exec?: ((sql: any) => Promise<undefined>) | ((sql: any) => Promise<undefined>); prepare?: ((sql: any) => { all(...params: any[]): Promise<any>; get(...params: any[]): Promise<any>; run(...params: any[]): Promise<{ changes: number; lastInsertRowid: bigint | undefined; }>; columns(): Promise<any>; }) | ((sql: any) => { all(...params: any[]): Promise<any>; get(...params: any[]): Promise<any>; run(...params: any[]): Promise<{ changes: number; lastInsertRowid: undefined; }>; columns(): Promise<{ name: any; }[]>; }); writeSystemMetadata?: ((key: any, value: any) => StatementResultingChanges) | ((keyOrMetadata: any, maybeValue: any) => Promise<void | { changes: number; lastInsertRowid: undefined; }>); writeSchemaMetadata: any; ensureAuthStorage?: ((authConfig?: null) => Promise<void>) | ((authConfig?: null) => Promise<void>); ensureLogStorage?: (() => Promise<void>) | (() => Promise<void>); ensureFileStorage?: (() => Promise<void>) | (() => Promise<void>); insertLogIndexEvent?: ((event: any) => Promise<void>) | ((event: any) => Promise<void>); pruneLogIndex?: ((limit: any) => Promise<void>) | ((limit: any) => Promise<void>); readRecentLogEvents?: ((limit?: number) => Promise<any>) | ((limit?: number) => Promise<any>); migrateAppSchema?: ((schema: any) => Promise<void>) | ((schema: any) => Promise<void>); createAppTable: any; migrateExistingAppTable: any; listInspectableTables?: (() => Promise<any>) | (() => Promise<any>); dumpInspectableDatabase?: (() => Promise<{ name: any; columns: any; rows: any; }[]>) | (() => Promise<{ name: any; columns: any; rows: any; }[]>); runReadOnlyInspectionQuery?: ((sql: any) => Promise<{ ok: boolean; data: { columns: any; rows: any; }; error: null; } | { ok: boolean; data: null; error: { message: any; hint: string; }; }>) | ((sql: any) => Promise<{ ok: boolean; data: { columns: any[]; rows: any; }; error: null; } | { ok: boolean; data: null; error: { message: any; hint: string; }; }>); checkHealth?: (() => Promise<{ ok: boolean; }>) | (() => Promise<{ ok: boolean; }>); withTransaction?: ((fn: any) => Promise<any>) | ((fn: any) => Promise<any>); close?: (() => Promise<void>) | (() => Promise<void>); ensureSystemTable?: () => void; readSystemMetadata?: (key: any) => Record<string, SQLOutputValue> | null; readSchemaMetadata: any; findFileBucket?: (ownerId: any, name: any) => Record<string, SQLOutputValue> | null; createFileBucket?: (row: any) => StatementResultingChanges; insertFileRow?: (row: any) => StatementResultingChanges; updatePendingFileRow?: (row: any) => StatementResultingChanges; insertFileUpload?: (row: any) => StatementResultingChanges; selectFileById?: (fileId: any) => Record<string, SQLOutputValue> | null; selectLiveFileByPath?: (path: any) => Record<string, SQLOutputValue>[]; selectActiveFileByPath?: (path: any) => Record<string, SQLOutputValue>[]; selectPendingFileUploadByPath?: (path: any) => Record<string, SQLOutputValue> | null; selectFileUpload?: (uploadId: any) => Record<string, SQLOutputValue> | null; completeFileUpload?: (upload: any, size: any, updatedAt: any) => StatementResultingChanges | { changes: number; }; deleteFileUploadsForPath?: (path: any) => StatementResultingChanges; deleteFileUploadsForFile?: (ownerId: any, fileId: any) => StatementResultingChanges; deleteFileUpload?: (uploadId: any) => StatementResultingChanges; selectPublicFileRow?: (publicUrlId: any) => Record<string, SQLOutputValue> | null; insertPublicFileUrl?: (row: any) => StatementResultingChanges; revokePublicFileUrl?: (publicUrlId: any, ownerId: any, revokedAt: any) => StatementResultingChanges; revokePublicFileUrlsForFile?: (fileId: any, revokedAt: any) => StatementResultingChanges; markFileDeleted?: (fileId: any, deletedAt: any) => StatementResultingChanges; fileRowForOwner?: (fileId: any, ownerId: any) => Record<string, SQLOutputValue> | null; findAuthUserByProviderEmail?: (provider: any, email: any) => Record<string, SQLOutputValue> | null; insertAuthUser?: (row: any) => StatementResultingChanges; updateAuthUserProfile?: (row: any) => StatementResultingChanges; linkAuthUser?: (row: any) => StatementResultingChanges; insertAuthSession?: (row: any) => StatementResultingChanges; deleteAuthSession?: (token: any) => StatementResultingChanges; refreshAuthSession?: (token: any, expiresAt: any) => StatementResultingChanges; rotateAuthSession?: (previousToken: any, row: any) => StatementResultingChanges; readAuthSessionWithUser?: (token: any) => Record<string, SQLOutputValue> | null; insertOAuthState?: (row: any) => StatementResultingChanges; consumeOAuthState?: ((state: any) => Record<string, SQLOutputValue> | null) | ((state: any) => Promise<any>); emailCredentialExists?: (email: any) => boolean; insertEmailCredential?: (row: any) => StatementResultingChanges; findEmailCredentialWithUser?: (email: any) => Record<string, SQLOutputValue> | null; referenceExists?: (field: any, value: any) => boolean; insertAppRow?: (table: any, row: any) => StatementResultingChanges; selectAppRowById?: (table: any, id: any) => Record<string, SQLOutputValue> | null; updateAppRow?: (table: any, id: any, values: any, options?: {}) => StatementResultingChanges | { changes: number; }; deleteAppRow?: (table: any, id: any) => StatementResultingChanges; selectAppRows?: (table: any, query?: {}) => Record<string, SQLOutputValue>[]; }, schema: { tables: any; }) {
  const nextSchema = normalizeSchema(schema);
  const nextSchemaJson = JSON.stringify(nextSchema);
  const nextSchemaHash = hashSchema(nextSchemaJson);
  const existingSchemaRow = await sqlite.readSchemaMetadata();
  let existingSchema = null;
  let schemaChanged = false;

  if (existingSchemaRow) {
    try {
      existingSchema = JSON.parse(existingSchemaRow.value);
    } catch {
      throw commandError(
        "Invalid Sporades schema metadata.",
        "Delete the Runtime directory only if you can lose local data, then restart the Capsule.",
      );
    }

    schemaChanged = hashSchema(JSON.stringify(existingSchema)) !== nextSchemaHash;
    if (schemaChanged) {
      assertAdditiveSchemaMigration(existingSchema, nextSchema);
    }
  }

  const existingTables = new Map((existingSchema?.tables ?? []).map((table: { name: any; }) => [table.name, table]));
  for (const table of schema.tables) {
    const existingTable = existingTables.get(table.name);
    if (schemaChanged && existingTable) {
      await migrateExistingLibsqlAppTableInTransaction(sqlite, existingTable, table);
    } else {
      await sqlite.createAppTable(table);
    }
  }

  await sqlite.writeSchemaMetadata({
    schemaVersion: "v1:additive-fields",
    schemaHash: nextSchemaHash,
    schemaJson: nextSchemaJson,
  });
}

function normalizeSchema(schema: { tables: any[]; }) {
  return {
    tables: schema.tables
      .map((table: { name: any; fields: any[]; }) => ({
        name: table.name,
        fields: table.fields.map((field: { name: any; kind: any; sqliteType: any; targetTable: any; defaultValue: any; }) => ({
          name: field.name,
          kind: field.kind,
          sqliteType: field.sqliteType,
          targetTable: field.targetTable,
          defaultValue: field.defaultValue,
        })),
      }))
      .sort((left: { name: string; }, right: { name: any; }) => left.name.localeCompare(right.name)),
  };
}

function hashSchema(schemaJson: BinaryLike) {
  return createHash("sha256").update(schemaJson).digest("hex");
}

function assertValidReferenceTargets(schema: LooseRecord) {
  const tableNames = new Set(schema.tables.map((table: { name: any; }) => table.name));
  for (const table of schema.tables) {
    for (const field of table.fields) {
      if (field.kind === "Reference" && !tableNames.has(field.targetTable)) {
        throw commandError(
          `Unknown reference target: ${field.targetTable}`,
          "Reference fields must point at another table in the Capsule schema.",
        );
      }
    }
  }
}

function assertAdditiveSchemaMigration(existingSchema: LooseRecord, nextSchema: LooseRecord) {
  const nextTables = new Map<any, any>(nextSchema.tables.map((table: { name: any; }) => [table.name, table]));

  for (const existingTable of existingSchema.tables ?? []) {
    const nextTable = nextTables.get(existingTable.name);
    if (!nextTable) {
      throw commandError(
        "Unsupported Capsule schema change.",
        "Only adding new tables or fields is supported right now. Revert table or field changes, or move data aside and recreate the Runtime directory.",
      );
    }

    const nextFields = new Map(nextTable.fields.map((field: { name: any; }) => [field.name, field]));
    for (const existingField of existingTable.fields ?? []) {
      const nextField = nextFields.get(existingField.name);
      if (!nextField || JSON.stringify(existingField) !== JSON.stringify(nextField)) {
        throw commandError(
          "Unsupported Capsule schema change.",
          "Only adding new tables or fields is supported right now. Revert table or field changes, or move data aside and recreate the Runtime directory.",
        );
      }
    }
  }
}

function migrateExistingAppTable(sqlite: LooseRecord, existingTable: any, nextTable: LooseRecord) {
  const tempTableName = `__sporades_migrating_${nextTable.name}`;
  const columns = ["id", "createdAt", "updatedAt", ...nextTable.fields.map((field: { name: any; }) => field.name)];
  return chainMaybePromise([
    ...addedFieldsForTable(existingTable, nextTable)
      .filter((field: { kind: string; defaultValue: null | undefined; }) => field.kind === "Reference" && field.defaultValue !== undefined && field.defaultValue !== null)
      .map((field: { defaultValue: any; }) => () =>
        thenIfPromise(sqlite.referenceExists(field, field.defaultValue), (exists: any) => {
          if (!exists) {
            throw invalidReferenceError(field);
          }
        }),
      ),
    () => sqlite.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(tempTableName)}`),
    () => sqlite.createAppTable(nextTable, tempTableName),
    () =>
      sqlite.exec(
        `INSERT INTO ${quoteIdentifier(tempTableName)} (${columns.map(quoteIdentifier).join(", ")}) ` +
        `SELECT ${columns.map((column) => columnSelectExpressionForMigration(existingTable, nextTable, column)).join(", ")} ` +
        `FROM ${quoteIdentifier(nextTable.name)}`,
      ),
    () => sqlite.exec(`DROP TABLE ${quoteIdentifier(nextTable.name)}`),
    () => sqlite.exec(`ALTER TABLE ${quoteIdentifier(tempTableName)} RENAME TO ${quoteIdentifier(nextTable.name)}`),
  ]);
}

async function migrateExistingLibsqlAppTable(sqlite: LooseRecord, existingTable: any, nextTable: LooseRecord) {
  await sqlite.withTransaction(async (transaction: LooseRecord) => {
    await migrateExistingLibsqlAppTableInTransaction(transaction, existingTable, nextTable);
  });
}

async function migrateExistingLibsqlAppTableInTransaction(sqlite: LooseRecord, existingTable: any, nextTable: LooseRecord) {
  for (const field of addedFieldsForTable(existingTable, nextTable)) {
    if (
      field.kind === "Reference" &&
      field.defaultValue !== undefined &&
      field.defaultValue !== null &&
      !(await sqlite.referenceExists(field, field.defaultValue))
    ) {
      throw invalidReferenceError(field);
    }
  }

  const tempTableName = `__sporades_migrating_${nextTable.name}`;
  const columns = ["id", "createdAt", "updatedAt", ...nextTable.fields.map((field: { name: any; }) => field.name)];
  await sqlite.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(tempTableName)}`);
  await sqlite.createAppTable(nextTable, tempTableName);
  await sqlite.exec(
    `INSERT INTO ${quoteIdentifier(tempTableName)} (${columns.map(quoteIdentifier).join(", ")}) ` +
    `SELECT ${columns.map((column) => columnSelectExpressionForMigration(existingTable, nextTable, column)).join(", ")} ` +
    `FROM ${quoteIdentifier(nextTable.name)}`,
  );
  await sqlite.exec(`DROP TABLE ${quoteIdentifier(nextTable.name)}`);
  await sqlite.exec(`ALTER TABLE ${quoteIdentifier(tempTableName)} RENAME TO ${quoteIdentifier(nextTable.name)}`);
}

function columnSelectExpressionForMigration(existingTable: LooseRecord, nextTable: LooseRecord, columnName: string) {
  if (["id", "createdAt", "updatedAt"].includes(columnName)) {
    return quoteIdentifier(columnName);
  }
  if ((existingTable.fields ?? []).some((field: { name: any; }) => field.name === columnName)) {
    return quoteIdentifier(columnName);
  }
  const field = nextTable.fields.find((candidate: { name: any; }) => candidate.name === columnName);
  return field?.defaultValue === undefined ? "NULL" : toSqlLiteral(field.defaultValue, field);
}

function addedFieldsForTable(existingTable: LooseRecord, nextTable: LooseRecord) {
  const existingFields = new Set((existingTable.fields ?? []).map((field: { name: any; }) => field.name));
  return (nextTable.fields ?? []).filter((field: { name: unknown; }) => !existingFields.has(field.name));
}

function createAppTable(sqlite: LooseRecord, table: LooseRecord, tableName = table.name) {
  return sqlite.exec(
    `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (` +
    appTableColumnDefinitions(table).join(", ") +
    ")",
  );
}

function appTableColumnDefinitions(table: LooseRecord) {
  return [
    "id TEXT PRIMARY KEY",
    "createdAt TEXT NOT NULL",
    "updatedAt TEXT NOT NULL",
    ...table.fields.map((field: any) => appFieldColumnDefinition(field)),
  ];
}

function appFieldColumnDefinition(field: LooseRecord) {
  const defaultSql = fieldColumnDefaultSql(field);
  const notNullSql = field.defaultValue !== undefined && !fieldDefaultIsSqlNull(field) ? " NOT NULL" : "";
  return `${quoteIdentifier(field.name)} ${field.sqliteType}${notNullSql}${defaultSql}`;
}

function fieldDefaultIsSqlNull(field: LooseRecord) {
  return field.defaultValue === null && field.kind !== "Json";
}

function fieldColumnDefaultSql(field: LooseRecord) {
  return field.defaultValue === undefined ? "" : ` DEFAULT ${toSqlLiteral(field.defaultValue, field)}`;
}

function commandError(message: string | undefined, hint: string, code: string | null = null) {
  const error: HelperError = new Error(message);
  error.hint = hint;
  if (code) {
    error.code = code;
  }
  return error;
}

function extractSchema(serverSource: string) {
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

function findMatchingParen(source: string, openIndex: number) {
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

function extractEndpoints(serverSource: string) {
  const endpoints = [];
  const endpointPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*endpoint\s*\(/g;
  let match;

  while ((match = endpointPattern.exec(serverSource))) {
    const argsEnd = findMatchingParen(serverSource, endpointPattern.lastIndex - 1);
    if (argsEnd === -1) {
      continue;
    }

    const argsSource = serverSource.slice(endpointPattern.lastIndex, argsEnd);
    const descriptor = argsSource.match(
      /^\s*\{\s*method\s*:\s*["']([A-Za-z]+)["']\s*,\s*path\s*:\s*["']([^"']+)["']\s*\}\s*,/,
    );
    if (!descriptor) {
      endpointPattern.lastIndex = argsEnd + 1;
      continue;
    }

    endpoints.push({
      name: match[1],
      method: descriptor[1].toUpperCase(),
      path: descriptor[2],
      handlerSource: argsSource.slice(descriptor[0].length).trim().replace(/,\s*$/, ""),
    });
    endpointPattern.lastIndex = argsEnd + 1;
  }

  return endpoints;
}

function endpointHandlersFromCapsuleDefinition(capsuleDefinition: any) {
  return Object.entries(capsuleDefinition?.endpoints ?? {})
    .filter(([, definition]: [string, any]) =>
      definition?.kind === "endpoint"
      && typeof definition.handler === "function"
      && typeof definition.options?.method === "string"
      && typeof definition.options?.path === "string")
    .map(([name, definition]: [string, any]) => ({
      name,
      method: definition.options.method.toUpperCase(),
      path: definition.options.path,
      handler: definition.handler,
    }));
}

function extractQueryHandlers(serverSource: any) {
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

function extractQueryHandlersFromCapsule(capsuleDefinition: any) {
  if (!capsuleDefinition?.queries || typeof capsuleDefinition.queries !== "object") {
    return null;
  }

  const handlers: any[] = [];
  for (const [name, queryDefinition] of Object.entries(capsuleDefinition.queries) as [string, any][]) {
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

function extractMutationHandlers(serverSource: any, options: LooseRecord = {}) {
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

function handlersFromCapsuleDefinition(definitions: any, kind: string) {
  return Object.entries(definitions ?? {})
    .filter(([, definition]: [string, any]) => definition?.kind === kind && typeof definition.handler === "function")
    .map(([name, definition]: [string, any]) => ({
      name,
      handler: definition.handler,
    }));
}

function mutationHandlersFromCapsuleDefinition(serverSource: any, capsuleDefinition: any) {
  const sourceHandlers = new Map(
    extractMutationHandlers(serverSource, { includeGeneratedNames: true }).map((handler) => [handler.name, handler]),
  );
  return handlersFromCapsuleDefinition(capsuleDefinition.mutations, "mutation").filter((handler) =>
    shouldUseBundledMutationHandler(handler.name, sourceHandlers.get(handler.name)),
  );
}

function shouldUseBundledMutationHandler(name: string, sourceHandler: { name: any; handlerSource: any; } | undefined) {
  if (!name.startsWith("add") && !name.startsWith("update")) {
    return true;
  }
  if (!sourceHandler || !isInlineHandlerSource(sourceHandler.handlerSource)) {
    return true;
  }
  return !isGeneratedScaffoldMutationHandler(sourceHandler.handlerSource);
}

function isInlineHandlerSource(handlerSource: string) {
  const source = handlerSource.trim();
  return source.startsWith("(") || source.startsWith("function") || source.startsWith("async ") || source.includes("=>");
}

function isGeneratedScaffoldMutationHandler(handlerSource: string) {
  const normalized = handlerSource.replace(/\s+/g, "");
  return /^\(ctx,([A-Za-z_$][A-Za-z0-9_$]*)(?::[^,)]+)?\)=>\{ctx\.db\.[A-Za-z_$][A-Za-z0-9_$]*\.insert\(\{\1,ownerId:ctx\.auth\.userId\}\);\}$/.test(
    normalized,
  );
}

function extractMessageHandlers(serverSource: any) {
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

function extractContextMiddleware(serverSource: any) {
  const middlewareSource = extractObjectPropertySource(serverSource, "middleware");
  if (!middlewareSource) {
    return [];
  }
  return extractHookList(`middleware: ${middlewareSource}`, "middleware");
}

function extractMutationHooks(serverSource: any) {
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

function extractHookList(hooksSource: string, propertyName: string) {
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

function extractObjectPropertySource(source: string, propertyName: string) {
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

function findMatchingDelimiter(source: string, openIndex: number, openChar: string, closeChar: string) {
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

function splitTopLevelList(source: string): string[] {
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

function extractFields(tableSource: any) {
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

function extractFieldDefaultSource(fieldSource: string, builderEndIndex: any) {
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

export async function routeEndpoint(database: { endpoints: any[]; }, request: IncomingMessage, response: ServerResponse<IncomingMessage> & { req: IncomingMessage; }) {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const endpoint = database.endpoints.find(
    (candidate: { method: any; path: string; }) => candidate.method === request.method && candidate.path === requestUrl.pathname,
  );
  if (!endpoint) {
    return false;
  }

  try {
    writeEndpointResult(response, await runEndpoint(database, endpoint, requestUrl, request));
  } catch (error: any) {
    if (error?.sporadesAuthDenialLogData) {
      emitAuthDeniedLog(database as LooseRecord, { data: error.sporadesAuthDenialLogData });
    }
    emitHttpFailureLog(database as LooseRecord, request, error);
    writeEndpointError(response, error);
  }
  return true;
}

export async function handleFileHttpRoute(database: LooseRecord, request: IncomingMessage, response: ServerResponse<IncomingMessage> & { req: IncomingMessage; }, websocketHub: any = null) {
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
    if (
      !publicRow ||
      publicRow.revokedAt ||
      publicRow.deletedAt ||
      (publicRow.expiresAt && Date.parse(publicRow.expiresAt) <= Date.now()) ||
      publicRow.publicVersion !== requestUrl.searchParams.get("v") ||
      publicRow.publicVersion !== publicRow.version
    ) {
      writeNotFound(response);
      return true;
    }
    await sendFileHttpResponse(database, response, publicRow);
    return true;
  }

  return false;
}

export async function routeRuntimeHealth(database: any, request: { url: string | URL; method: string; headers: { [x: string]: any; }; }, response: any) {
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

async function createRuntimeHealthResult(database: any) {
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

export async function checkRuntimeSqlite(database: LooseRecord) {
  return await (database.adapter ?? database.sqlite).checkHealth();
}

export async function checkRuntimeFileStorage(database: LooseRecord) {
  return await database.fileStorage.checkHealth();
}

function createFileStorageTables(sqlite: { engine?: string; exec: any; prepare?: (sql: any) => { all(...params: any[]): Record<string, SQLOutputValue>[]; get(...params: any[]): Record<string, SQLOutputValue> | undefined; run(...params: any[]): StatementResultingChanges; columns(): StatementColumnMetadata[]; }; ensureSystemTable?: () => void; readSystemMetadata?: (key: any) => Record<string, SQLOutputValue> | null; writeSystemMetadata?: (key: any, value: any) => StatementResultingChanges; readSchemaMetadata?: () => Record<string, SQLOutputValue> | null; writeSchemaMetadata?: ({ schemaVersion, schemaHash, schemaJson }: { schemaVersion: any; schemaHash: any; schemaJson: any; }) => void; ensureLogStorage?: () => void; insertLogIndexEvent?: (event: any) => void; pruneLogIndex?: (limit: any) => void; readRecentLogEvents?: (limit: any) => any; ensureFileStorage?: () => void; findFileBucket?: (ownerId: any, name: any) => Record<string, SQLOutputValue> | null; createFileBucket?: (row: any) => StatementResultingChanges; insertFileRow?: (row: any) => StatementResultingChanges; updatePendingFileRow?: (row: any) => StatementResultingChanges; insertFileUpload?: (row: any) => StatementResultingChanges; selectFileById?: (fileId: any) => Record<string, SQLOutputValue> | null; selectLiveFileByPath?: (path: any) => Record<string, SQLOutputValue>[]; selectActiveFileByPath?: (path: any) => Record<string, SQLOutputValue>[]; selectPendingFileUploadByPath?: (path: any) => Record<string, SQLOutputValue> | null; selectFileUpload?: (uploadId: any) => Record<string, SQLOutputValue> | null; completeFileUpload?: (upload: any, size: any, updatedAt: any) => StatementResultingChanges | { changes: number; }; deleteFileUploadsForPath?: (path: any) => StatementResultingChanges; deleteFileUploadsForFile?: (ownerId: any, fileId: any) => StatementResultingChanges; deleteFileUpload?: (uploadId: any) => StatementResultingChanges; selectPublicFileRow?: (publicUrlId: any) => Record<string, SQLOutputValue> | null; insertPublicFileUrl?: (row: any) => StatementResultingChanges; revokePublicFileUrl?: (publicUrlId: any, ownerId: any, revokedAt: any) => StatementResultingChanges; revokePublicFileUrlsForFile?: (fileId: any, revokedAt: any) => StatementResultingChanges; markFileDeleted?: (fileId: any, deletedAt: any) => StatementResultingChanges; fileRowForOwner?: (fileId: any, ownerId: any) => Record<string, SQLOutputValue> | null; ensureAuthStorage?: (authConfig?: null) => void; findAuthUserByProviderEmail?: (provider: any, email: any) => Record<string, SQLOutputValue> | null; insertAuthUser?: (row: any) => StatementResultingChanges; updateAuthUserProfile?: (row: any) => StatementResultingChanges; linkAuthUser?: (row: any) => StatementResultingChanges; insertAuthSession?: (row: any) => StatementResultingChanges; deleteAuthSession?: (token: any) => StatementResultingChanges; refreshAuthSession?: (token: any, expiresAt: any) => StatementResultingChanges; rotateAuthSession?: (previousToken: any, row: any) => StatementResultingChanges; readAuthSessionWithUser?: (token: any) => Record<string, SQLOutputValue> | null; insertOAuthState?: (row: any) => StatementResultingChanges; consumeOAuthState?: (state: any) => Record<string, SQLOutputValue> | null; emailCredentialExists?: (email: any) => boolean; insertEmailCredential?: (row: any) => StatementResultingChanges; findEmailCredentialWithUser?: (email: any) => Record<string, SQLOutputValue> | null; migrateAppSchema?: (schema: any) => any; createAppTable?: (table: any, tableName?: any) => any; migrateExistingAppTable?: (existingTable: any, nextTable: any) => any; referenceExists?: (field: any, value: any) => boolean; withTransaction?: (fn: any) => Promise<any>; insertAppRow?: (table: any, row: any) => StatementResultingChanges; selectAppRowById?: (table: any, id: any) => Record<string, SQLOutputValue> | null; updateAppRow?: (table: any, id: any, values: any, options?: {}) => StatementResultingChanges | { changes: number; }; deleteAppRow?: (table: any, id: any) => StatementResultingChanges; selectAppRows?: (table: any, query?: {}) => Record<string, SQLOutputValue>[]; listInspectableTables?: () => SQLOutputValue[]; dumpInspectableDatabase?: () => { name: SQLOutputValue; columns: SQLOutputValue[]; rows: Record<string, SQLOutputValue>[]; }[]; runReadOnlyInspectionQuery?: (sql: any) => { ok: boolean; data: { columns: string[]; rows: Record<string, SQLOutputValue>[]; }; error: null; } | { ok: boolean; data: null; error: { message: any; hint: string; }; }; checkHealth?: () => { ok: boolean; }; close?: () => void; }) {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_file_buckets (" +
    "id TEXT PRIMARY KEY, " +
    "ownerId TEXT NOT NULL, " +
    "name TEXT NOT NULL, " +
    "createdAt TEXT NOT NULL, " +
    "UNIQUE(ownerId, name)" +
    ")",
  );
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_files (" +
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
    ")",
  );
  try {
    sqlite.exec("ALTER TABLE sporades_files ADD COLUMN path TEXT");
  } catch (error: any) {
    if (!isDuplicateColumnError(error)) throw error;
  }
  sqlite.exec(filePathBackfillSql());
  sqlite.exec(activeFilePathDedupeSql());
  sqlite.exec("CREATE INDEX IF NOT EXISTS sporades_files_path_live ON sporades_files (path, deletedAt, status)");
  sqlite.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS sporades_files_path_active_unique " +
    "ON sporades_files (path) WHERE deletedAt IS NULL AND status IN ('pending', 'uploaded')",
  );
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_file_uploads (" +
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
    ")",
  );
  ensureFileUploadTargetColumns(sqlite);
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_file_public_urls (" +
    "id TEXT PRIMARY KEY, " +
    "fileId TEXT NOT NULL, " +
    "ownerId TEXT NOT NULL, " +
    "version TEXT NOT NULL, " +
    "expiresAt TEXT, " +
    "createdAt TEXT NOT NULL, " +
    "revokedAt TEXT" +
    ")",
  );
}

async function readRequestBytes(request: any, maxBytes: number) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      throw createStructuredFileError(
        "File is too large.",
        `Choose a file at or below ${maxBytes} bytes, or raise files.maxSizeBytes in sporades.json.`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function writeJsonHttpResponse(response: any, status: number, result: any) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(result)}\n`);
}

function writeNotFound(response: { writeHead: (arg0: number, arg1: { "content-type": string; }) => void; end: (arg0: string) => void; }) {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

async function sendFileHttpResponse(database: LooseRecord, response: any, row: LooseRecord) {
  try {
    const bytes = await database.fileStorage.readFileVersion({ fileId: row.id, version: row.version });
    response.writeHead(200, {
      "content-type": contentTypeForFile(row.type),
      "cache-control": "private, max-age=31536000, immutable",
    });
    response.end(bytes);
  } catch {
    writeNotFound(response);
  }
}

function contentTypeForFile(type: any) {
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

export async function createPendingFileUpload(database: LooseRecord, auth: LooseRecord, message: LooseRecord) {
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
      error: createStructuredFileError(
        "File is too large.",
        `Choose a file at or below ${database.fileMaxSizeBytes} bytes, or raise files.maxSizeBytes in sporades.json.`,
      ),
    };
  }

  return await withFileUploadPathLock("capsule", async () => {
    const now = new Date().toISOString();
    const replacing = message.replace === true;
    const replaceReference = message.fileReference ?? message.fileId;
    const resolvedReplacement: any = replacing ? await resolveLiveFileReference(database, auth.userId, replaceReference) : { ok: true, row: null };
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
    return await database.sqlite.withTransaction(async (sqlite: { selectPendingFileUploadByPath: (arg0: any) => any; deleteFileUploadsForPath: (arg0: any) => any; insertFileUpload: (arg0: { id: `${string}-${string}-${string}-${string}-${string}`; fileId: any; ownerId: any; bucketId: any; bucketName: any; path: any; name: any; type: string; version: `${string}-${string}-${string}-${string}-${string}`; expectedSize: number; createdAt: string; }) => any; }) => {
      const transactionDatabase = { ...database, sqlite, adapter: sqlite };
      let target;
      try {
        target =
          replacing && existingByReference && (input.path === undefined || input.path === null)
            ? { bucket: { id: existingByReference.bucketId, name: existingByReference.bucketName }, path: existingByReference.path }
            : await resolveFileWriteTarget(transactionDatabase, auth.userId, input, now);
      } catch (error: any) {
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
          error: createStructuredFileError(
            "File path already exists.",
            "Choose another absolute File path or ask the owning user to delete the existing file first.",
          ),
        };
      }
      const pendingByPath =
        !existingByReference && !existingByPath && target.path
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
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
        const current = await sqlite.selectPendingFileUploadByPath(target.path);
        if (!current) throw error;
        return {
          ok: true,
          data: {
            uploadUrl: `/__sporades/uploads/${current.id}`,
            method: "PUT",
            headers: {},
            file: fileMetadataFromUpload(current),
          },
          error: null as any,
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

export async function completePendingFileUpload(database: LooseRecord, uploadId: string, request: any, websocketHub: any = null) {
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
    const completion = await database.sqlite.withTransaction(async (sqlite: LooseRecord) => {
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
        error: createStructuredFileError(
          "Upload URL was superseded.",
          "Request a fresh upload URL before retrying this file upload.",
        ),
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
    return { ok: true, data: { file }, error: null as any };
  } catch (error: any) {
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

export async function getPrivateFileUrl(database: any, auth: LooseRecord, fileReference: any) {
  const resolved: any = await resolveLiveFileReference(database, auth.userId, fileReference);
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
    error: null as any,
  };
}

export async function createPublicFileUrl(database: LooseRecord, auth: LooseRecord, fileReference: any, options: LooseRecord = {}) {
  const expiry = validatePublicUrlExpiry(options);
  if (!expiry.ok) {
    return expiry;
  }
  return await runFileMetadataTransaction(database, async (sqlite: LooseRecord) => {
    const transactionDatabase = { ...database, sqlite, adapter: sqlite };
    const resolved: any = await resolveLiveFileReference(transactionDatabase, auth.userId, fileReference);
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
      error: null as any,
    };
  });
}

async function revokePublicFileUrl(database: LooseRecord, auth: LooseRecord, publicUrlId: any) {
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
    error: null as any,
  };
}

export async function deletePrivateFile(database: LooseRecord, auth: LooseRecord, fileReference: any) {
  const now = new Date().toISOString();
  const result = await runFileMetadataTransaction(database, async (sqlite: LooseRecord) => {
    const transactionDatabase = { ...database, sqlite, adapter: sqlite };
    const resolved: any = await resolveLiveFileReference(transactionDatabase, auth.userId, fileReference);
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
    error: null as any,
  };
}

async function runFileMetadataTransaction(database: LooseRecord, fn: (sqlite: LooseRecord) => any) {
  if (database.__transactionActive) {
    return await fn(database.sqlite);
  }
  return await database.sqlite.withTransaction(fn);
}

function validatePublicUrlExpiry(options: LooseRecord) {
  const choices = [options.ttlSeconds !== undefined, options.expires !== undefined, options.noExpiry === true].filter(Boolean);
  if (choices.length !== 1) {
    return {
      ok: false,
      error: createStructuredFileError(
        "Public file URLs require exactly one expiry choice.",
        "Pass exactly one of ttlSeconds, expires, or noExpiry: true.",
      ),
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

async function fileRowForOwner(database: LooseRecord, fileId: string, ownerId: any) {
  const reference = String(fileId ?? "");
  if (isAbsoluteFilePath(reference)) {
    const resolved: any = await resolveLiveFileReference(database, ownerId, reference);
    return resolved.ok ? resolved.row : null;
  }
  return await database.sqlite.fileRowForOwner(reference, ownerId);
}

function fileMetadataFromRow(row: LooseRecord) {
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

function fileMetadataFromUpload(upload: LooseRecord) {
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

async function withFileUploadPathLock(path: string, fn: () => any) {
  const fileUploadPathLocks = ((globalThis as any).__sporadesFileUploadPathLocks ??= new Map());
  const key = String(path);
  const previous = fileUploadPathLocks.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => current, () => current);
  fileUploadPathLocks.set(key, next);
  try {
    await previous.catch(() => { });
    return await fn();
  } finally {
    release?.();
    if (fileUploadPathLocks.get(key) === next) {
      fileUploadPathLocks.delete(key);
    }
  }
}

async function resolveFileWriteTarget(database: LooseRecord, ownerId: any, input: LooseRecord, now: string) {
  const explicitPath = input.path === undefined || input.path === null ? null : normalizeAbsoluteFilePath(input.path);
  const path = explicitPath ?? `/default/${normalizeFileName(input.name, null)}`;
  const firstSegment = path.split("/").filter(Boolean)[0] ?? "default";
  const existingBucket = await database.sqlite.findFileBucket(ownerId, firstSegment);
  const bucket = existingBucket ?? (await ensureFileBucket(database, ownerId, "default", now));
  return { bucket, path };
}

async function ensureFileBucket(database: LooseRecord, ownerId: any, name: string, now: any) {
  const existing = await database.sqlite.findFileBucket(ownerId, name);
  if (existing) return existing;
  const bucket = { id: randomUUID(), ownerId, name, createdAt: now };
  try {
    await database.sqlite.createFileBucket(bucket);
    return bucket;
  } catch (error: any) {
    if (!isUniqueConstraintError(error)) throw error;
    const raced = await database.sqlite.findFileBucket(ownerId, name);
    if (raced) return raced;
    throw error;
  }
}

function normalizeAbsoluteFilePath(value: string) {
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

function normalizeFileName(name: any, filePath: string | null) {
  const candidate = String(name ?? "").trim();
  if (candidate) return candidate;
  const pathName = filePath?.split("/").filter(Boolean).at(-1);
  return pathName || "upload";
}

function isAbsoluteFilePath(value: string) {
  return typeof value === "string" && value.startsWith("/");
}

async function resolveLiveFileReference(database: LooseRecord, ownerId: any, reference: string) {
  const value = String(reference ?? "");
  if (isAbsoluteFilePath(value)) {
    let path;
    try {
      path = normalizeAbsoluteFilePath(value);
    } catch {
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

async function resolvePrivilegedLiveFileReference(database: LooseRecord, reference: any) {
  const value = String(reference ?? "");
  if (isAbsoluteFilePath(value)) {
    let path;
    try {
      path = normalizeAbsoluteFilePath(value);
    } catch {
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

function singleLiveFileRowByPath(database: LooseRecord, path: string) {
  return thenIfPromise(database.sqlite.selectLiveFileByPath(path), (rows: any[]) => {
    if (rows.length > 1) return { ambiguous: true };
    return rows[0] ?? null;
  });
}

function singleActiveFileRowByPath(database: LooseRecord, path: any) {
  return thenIfPromise(database.sqlite.selectActiveFileByPath(path), (rows: any[]) => {
    if (rows.length > 1) return { ambiguous: true };
    return rows[0] ?? null;
  });
}

function ambiguousFileReferenceError(reference: string) {
  return {
    ok: false,
    error: createStructuredFileError(
      "File reference is ambiguous.",
      `The File reference ${reference} must resolve to exactly one live file before this operation can proceed.`,
    ),
  };
}

function structuredFileException(message: string | undefined, hint: string) {
  const error: HelperError = new Error(message);
  error.hint = hint;
  return error;
}

function isDuplicateColumnError(error: any) {
  const text = [error?.message, error?.stdout, error?.stderr, error].map((value) => String(value ?? "")).join("\n");
  return /duplicate column|already exists/i.test(text);
}

function isUniqueConstraintError(error: any) {
  const text = [error?.message, error?.stdout, error?.stderr, error].map((value) => String(value ?? "")).join("\n");
  return /unique constraint|duplicate key|constraint failed/i.test(text);
}

function filePathBackfillSql() {
  return (
    "UPDATE sporades_files SET path = CASE " +
    "WHEN (SELECT COUNT(*) FROM sporades_files AS matching " +
    "WHERE matching.ownerId = sporades_files.ownerId " +
    "AND matching.bucketName = sporades_files.bucketName " +
    "AND matching.name = sporades_files.name " +
    "AND matching.deletedAt IS NULL " +
    "AND matching.status IN ('pending', 'uploaded')) = 1 " +
    "THEN '/' || bucketName || '/' || name " +
    "ELSE '/' || bucketName || '/' || id || '/' || name END " +
    "WHERE path IS NULL OR path = ''"
  );
}

function activeFilePathDedupeSql() {
  return (
    "UPDATE sporades_files SET deletedAt = COALESCE(deletedAt, updatedAt), updatedAt = updatedAt " +
    "WHERE deletedAt IS NULL AND status IN ('pending', 'uploaded') AND id NOT IN (" +
    "SELECT MAX(id) FROM sporades_files " +
    "WHERE deletedAt IS NULL AND status IN ('pending', 'uploaded') " +
    "GROUP BY path" +
    ")"
  );
}

function ensureFileUploadTargetColumns(sqlite: LooseRecord) {
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
    const operation = () =>
      statement.startsWith("ALTER TABLE")
        ? runSchemaExecIgnoringDuplicateColumn(sqlite, statement)
        : sqlite.exec(statement);
    chain = chainSchemaOperation(chain, operation);
  }
  return chain;
}

function runSchemaExecIgnoringDuplicateColumn(sqlite: LooseRecord, sql: string) {
  try {
    const result = sqlite.exec(sql);
    if (isPromiseLike(result)) {
      return result.catch((error: any) => {
        if (!isDuplicateColumnError(error)) throw error;
      });
    }
    return result;
  } catch (error: any) {
    if (!isDuplicateColumnError(error)) throw error;
    return undefined;
  }
}

function chainSchemaOperation(previous: any, operation: () => any) {
  if (isPromiseLike(previous)) {
    return previous.then(operation);
  }
  return operation();
}

function createStructuredFileError(message: string, hint: string) {
  return { message, hint };
}

async function removeFileVersionBestEffort(database: LooseRecord, fileId: any, version: any) {
  await database.fileStorage.deleteFileVersion({ fileId, version }).catch(() => { });
}

async function runEndpoint(database: any, endpoint: { handler?: Function; handlerSource?: string; }, requestUrl: URL, request: any) {
  const handler =
    typeof endpoint.handler === "function"
      ? endpoint.handler
      : new Function(`return (${endpoint.handlerSource});`)();
  const endpointRequest = await readEndpointRequest(database, requestUrl, request);
  const session = await resolveAnonymousSession(database, readEndpointSessionToken(endpointRequest.headers, endpointRequest.query));
  let context: LooseRecord | undefined;
  try {
    const result = await (database.adapter ?? database.sqlite).withTransaction(async (transactionAdapter: any) => {
      const transactionDatabase = createTransactionDatabase(database, transactionAdapter);
      context = await applyContextMiddleware(
      transactionDatabase,
      createEndpointContext(transactionDatabase, endpointRequest, session),
      "endpoint",
    );
      try {
        return await handler(context);
      } finally {
        await drainPendingAclWrites(context);
        transactionDatabase.rowCache.clear();
      }
    });
    await flushPendingJobEnqueues(context);
    return result;
  } catch (error) {
    await flushPendingJobEnqueues(context);
    throw error;
  }
}

function createTransactionDatabase(database: LooseRecord, transactionAdapter: any) {
  return transactionAdapter
    ? { ...database, adapter: transactionAdapter, sqlite: transactionAdapter, __transactionActive: true, __rootDatabase: database.__rootDatabase ?? database }
    : database;
}

async function readEndpointRequest(database: LooseRecord, requestUrl: URL, request: any) {
  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [
      name.toLowerCase(),
      Array.isArray(value) ? value.join(", ") : value,
    ]),
  );
  const query = endpointQueryFromUrl(requestUrl);
  return {
    method: request.method,
    path: requestUrl.pathname,
    headers,
    query,
    body: await readEndpointBody(request, headers, database),
  };
}

function createEndpointContext(database: LooseRecord, endpointRequest: LooseRecord, session: LooseRecord) {
  const context: LooseRecord = {
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

function createContextHolder(context: LooseRecord) {
  const holder = { current: context };
  Object.defineProperty(context, "__sporadesContextHolder", {
    value: holder,
    enumerable: false,
    configurable: true,
  });
  return holder;
}

function createTableAclContext(context: any, database: any) {
  const { db, privileged, jobs, request, __pendingAclWrites, __sporadesContextHolder, ...aclContext } = context ?? {};
  return {
    ...aclContext,
    acl: createAclHelpers(database),
  };
}

async function applyContextMiddleware(database: LooseRecord, baseContext: LooseRecord, kind: string) {
  let context: LooseRecord = {
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

function runContextMiddleware(middlewareSource: any, context: any) {
  const createMiddleware = new Function(`return (${middlewareSource});`);
  const middleware = createMiddleware();
  return middleware(context);
}

function readEndpointSessionToken(headers: { [x: string]: any; }, query: { [x: string]: any; sessionToken?: any; }) {
  return headers["x-sporades-session-token"] ?? null;
}

function endpointQueryFromUrl(requestUrl: URL) {
  const query: Record<string, string> = {};
  for (const [name, value] of requestUrl.searchParams.entries()) {
    if (name === "sessionToken") {
      continue;
    }
    query[name] = value;
  }
  return query;
}

function privilegedDbAccessContextSet() {
  const holder = privilegedDbAccessContextSet as LooseRecord;
  if (!holder.contexts) {
    Object.defineProperty(holder, "contexts", {
      value: new WeakSet(),
      enumerable: false,
      configurable: false,
    });
  }
  return holder.contexts;
}

function grantPrivilegedDbAccess(context: any) {
  if (context && typeof context === "object") {
    privilegedDbAccessContextSet().add(context);
  }
  return context;
}

function revokePrivilegedDbAccess(context: any) {
  if (context && typeof context === "object") {
    privilegedDbAccessContextSet().delete(context);
  }
  return context;
}

function hasPrivilegedDbAccess(context: any) {
  return Boolean(context && typeof context === "object" && privilegedDbAccessContextSet().has(context));
}

function createEndpointDatabaseApi(database: LooseRecord, contextGetter: any = null) {
  return Object.fromEntries(
    database.schema.tables.map((table: { name: any; }) => [table.name, createEndpointTableApi(database, table, {}, contextGetter)]),
  );
}

function createEndpointTableApi(database: LooseRecord, table: LooseRecord, query: LooseRecord = {}, contextGetter: any = null) {
  return {
    insert(values: LooseRecord) {
      const now = new Date().toISOString();
      const row: LooseRecord = {
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
      };
      const fieldValues = table.fields.map((field: { name: PropertyKey; defaultValue: any; }) =>
        fieldValueForWrite(
          database,
          field,
          Object.hasOwn(values, String(field.name)) && values[String(field.name)] !== undefined ? values[String(field.name)] : field.defaultValue,
        ),
      );
      const finish = (resolvedValues: { [x: string]: any; }) => {
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
    update(id: any, values: LooseRecord) {
      const finishExisting = (existing: any) => {
        if (!existing) {
          return null;
        }
        const previous = deserializeRow(table, existing);
        const fieldsToUpdate = table.fields.filter((field: { name: PropertyKey; }) => Object.hasOwn(values, field.name));
        if (fieldsToUpdate.length === 0) {
          return runTableWriteWithAcl(database, table, "update", previous, previous, contextGetter, () => previous);
        }

        const now = new Date().toISOString();
        const serializedValues: LooseRecord = { updatedAt: now };
        const fieldValues = fieldsToUpdate.map((field: { name: string | number; }) => fieldValueForWrite(database, field, values[field.name]));
        const finishValues = (resolvedValues: { [x: string]: any; }) => {
          for (const [index, field] of fieldsToUpdate.entries()) {
            serializedValues[field.name] = resolvedValues[index];
          }
          const next = {
            ...previous,
            updatedAt: now,
            ...Object.fromEntries(fieldsToUpdate.map((field: { name: string | number; }) => [field.name, deserializeFieldValue(field, serializedValues[field.name])])),
          };
          return runTableWriteWithAcl(database, table, "update", previous, next, contextGetter, () => {
            const result = database.sqlite.updateAppRow(table, id, serializedValues);
            database.rowCache.clear();
            return thenIfPromise(result, (writeResult: { changes: number; }) => {
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
    delete(id: any) {
      const finish = (existing: any) => {
        if (!existing) {
          return false;
        }
        const previous = deserializeRow(table, existing);
        return runTableWriteWithAcl(database, table, "delete", previous, null, contextGetter, () => {
          const result = database.sqlite.deleteAppRow(table, id);
          database.rowCache.clear();
          return thenIfPromise(result, (writeResult: { changes: number; }) => writeResult.changes > 0);
        });
      };
      const operation = thenIfPromise(database.sqlite.selectAppRowById(table, id), finish);
      if (isPromiseLike(operation)) {
        contextGetter?.()?.__pendingAclWrites?.push(operation);
      }
      return operation;
    },
    where(fieldName: any, value: any) {
      return createEndpointTableApi(database, table, { ...query, where: { fieldName, value } }, contextGetter);
    },
    orderBy(fieldName: any, direction = "asc") {
      return createEndpointTableApi(database, table, { ...query, orderBy: { fieldName, direction } }, contextGetter);
    },
    limit(count: any) {
      return createEndpointTableApi(database, table, { ...query, limit: count }, contextGetter);
    },
    get() {
      const selected = database.sqlite.selectAppRows(table, {
        where: query.where
          ? {
            fieldName: query.where.fieldName,
            value: serializeFieldValue(
              table.fields.find((field: { name: any; }) => field.name === query.where.fieldName),
              query.where.value,
            ),
          }
          : null,
        orderBy: query.orderBy,
        limit: 1,
      });
      return thenIfPromise(selected, (rows: null[]) => {
        const row = rows[0] ?? null;
        if (!row) {
          return null;
        }
        const deserialized = deserializeRow(table, row);
        const allowed = applyReadAcl(database, table, deserialized, contextGetter?.());
        return thenIfPromise(allowed, (result: any) => (result ? deserialized : null));
      });
    },
    all() {
      const limit = Number.isInteger(query.limit) && query.limit >= 0 ? query.limit : null;
      const selected = database.sqlite.selectAppRows(table, {
        where: query.where
          ? {
            fieldName: query.where.fieldName,
            value: serializeFieldValue(
              table.fields.find((field: { name: any; }) => field.name === query.where.fieldName),
              query.where.value,
            ),
          }
          : null,
        orderBy: query.orderBy,
        limit,
      });
      return thenIfPromise(selected, (selectedRows: any[]) => {
        const rows = selectedRows.map((row: any) => deserializeRow(table, row));
        return filterRowsByReadAcl(database, table, rows, contextGetter?.());
      });
    },
  };
}

function runTableWriteWithAcl(database: any, table: LooseRecord, operation: string, previous: any, next: any, contextGetter: any, write: () => any) {
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

function isPromiseLike(value: any) {
  return value && typeof value === "object" && typeof value.then === "function";
}

function thenIfPromise(value: any, onResolved: (value: any) => any) {
  return isPromiseLike(value) ? value.then(onResolved) : onResolved(value);
}

function chainMaybePromise(steps: any[]) {
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

function applyReadAcl(database: any, table: LooseRecord, row: any, context: any) {
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

function filterRowsByReadAcl(database: any, table: any, rows: any[], context: any) {
  const decisions = rows.map((row: any) => applyReadAcl(database, table, row, context));
  if (decisions.some(isPromiseLike)) {
    return Promise.all(decisions).then((resolved: any[]) => rows.filter((_: any, index: number) => resolved[index]));
  }
  return rows.filter((_: any, index: number) => decisions[index]);
}

const ACL_HELPER_STATE = Symbol("sporades.aclHelperState");

function createAclHelpers(database: any) {
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

function aclRuleTouchedAsyncHelperRead(aclContext: any) {
  return aclContext?.acl?.[ACL_HELPER_STATE]?.touchedAsyncRead === true;
}

function markAsyncAclHelperRead(state: LooseRecord, result: any) {
  if (isPromiseLike(result)) {
    state.touchedAsyncRead = true;
    Promise.resolve(result).catch(() => { });
    return true;
  }
  return false;
}

function createAclDbHelpers(database: LooseRecord, state: LooseRecord) {
  return Object.freeze({
    get(tableName: any, id: any) {
      assertAclHelperReadAllowed(state);
      const table = resolveAclAppTable(database, tableName);
      const selected = database.sqlite.selectAppRowById(table, id);
      if (markAsyncAclHelperRead(state, selected)) {
        return null;
      }
      return selected ? deserializeRow(table, selected) : null;
    },
    exists(tableName: any, id: any) {
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

function createAclStorageHelpers(database: any, state: LooseRecord) {
  return Object.freeze({
    get(resourceName: any, reference: any) {
      assertAclHelperReadAllowed(state);
      const resource = resolveAclStorageResource(resourceName);
      if (resource === "files") {
        const row = resolveAclStorageFileReference(database, state, reference);
        return row ? aclStorageMetadataFromFileRow(row) : null;
      }
      return null;
    },
    exists(resourceName: any, reference: any) {
      assertAclHelperReadAllowed(state);
      const resource = resolveAclStorageResource(resourceName);
      if (resource === "files") {
        return Boolean(resolveAclStorageFileReference(database, state, reference));
      }
      return false;
    },
  });
}

function resolveAclStorageFileReference(database: LooseRecord, state: any, reference: any) {
  const value = String(reference ?? "");
  if (isAbsoluteFilePath(value)) {
    let path;
    try {
      path = normalizeAbsoluteFilePath(value);
    } catch {
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

function assertAclHelperReadAllowed(state: LooseRecord) {
  state.readCount += 1;
  if (state.readCount > state.maxReads) {
    throw commandError("ACL helper read limit exceeded.", "Keep ACL policies bounded; each rule may perform at most 32 helper reads.");
  }
}

function resolveAclAppTable(database: LooseRecord, tableName: any) {
  const normalized = String(tableName ?? "");
  const table = database.schema.tables.find((candidate: { name: string; }) => candidate.name === normalized);
  if (!table) {
    throw commandError("Unknown ACL database resource.", "ACL database helpers can inspect Capsule app tables by stable table name only.");
  }
  return table;
}

function resolveAclStorageResource(resourceName: any) {
  const normalized = String(resourceName ?? "");
  if (normalized === "files") {
    return normalized;
  }
  throw commandError("Unknown ACL storage resource.", "ACL storage helpers can inspect stable storage metadata resources such as files only.");
}

function aclStorageMetadataFromFileRow(row: LooseRecord) {
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

function emitAclDeniedLog(database: LooseRecord, details: LooseRecord) {
  database.log?.emit?.({
    category: "platform",
    event: "acl.denied",
    level: "warn",
    message: "ACL denied table operation.",
    data: details.data ?? createAclDenialLogData(details),
  });
}

function createAclDenialLogData({ context, table, operation, row = null, previous = null, next = null }: LooseRecord) {
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

function aclRuleDeclaredOperation(table: LooseRecord, operation: string) {
  if (operation !== "read" && table.acl?.[operation] === undefined && table.acl?.write) {
    return "write";
  }
  return operation;
}

function aclRowLogSnapshot(input: any) {
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

function aclVisibleFieldNames(row: any) {
  return Object.keys(row ?? {}).filter(
    (fieldName) => !["id", "createdAt", "updatedAt"].includes(fieldName) && !isSensitiveLogKey(fieldName),
  );
}

function createAclDeniedError(logData: any = null) {
  const error = commandError("Denied.", "The current user is not allowed to perform this operation.", "DENIED");
  if (logData) {
    error.sporadesAclDenialLogData = logData;
  }
  return error;
}

function requireAuth(context: LooseRecord, options: LooseRecord = {}) {
  const linked = options?.linked === true;
  const auth = context?.auth;
  if (auth?.isAuthenticated === true && (!linked || auth.isGuest !== true)) {
    return auth;
  }
  throw createUnauthenticatedError(createAuthDenialLogData(context, linked ? "linked" : "authenticated"));
}

function createUnauthenticatedError(logData: any = null) {
  const error = commandError("Unauthenticated.", "Sign in and retry the request.", "UNAUTHENTICATED");
  if (logData) {
    error.sporadesAuthDenialLogData = logData;
  }
  return error;
}

function createAuthDenialLogData(context: LooseRecord, requirement: string) {
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

function emitAuthDeniedLog(database: LooseRecord, details: LooseRecord) {
  database.log?.emit?.({
    category: "platform",
    event: "auth.denied",
    level: "warn",
    message: "requireAuth denied an unauthenticated handler request.",
    data: details.data ?? null,
  });
}

function fieldValueForWrite(database: any, field: LooseRecord, value: any) {
  if (field.kind === "Reference" && value !== undefined && value !== null) {
    return thenIfPromise(referenceExists(database, field, value), (exists: any) => {
      if (!exists) {
        throw invalidReferenceError(field);
      }
      return serializeFieldValue(field, value);
    });
  }
  return serializeFieldValue(field, value);
}

function invalidReferenceError(field: LooseRecord) {
  return commandError(`Invalid reference for field: ${field.name}`, `Pass the id of an existing ${field.targetTable} row.`);
}

function referenceExists(database: LooseRecord, field: any, value: any) {
  return database.sqlite.referenceExists(field, value);
}

function serializeFieldValue(field: LooseRecord, value: any) {
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

function deserializeFieldValue(field: LooseRecord, value: any) {
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

function normalizeDateValue(value: string | number | Date, fieldName: string) {
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

function dateValueError(fieldName: any) {
  return commandError(
    `Invalid date value for field: ${fieldName}`,
    "Pass an ISO 8601 date string or JavaScript Date value.",
  );
}

function assertJsonCompatible(value: any) {
  let context: LooseRecord | undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw invalidJsonFieldValueError();
    }
    JSON.parse(serialized);
  } catch (error: any) {
    if ((error as any)?.hint) {
      throw error;
    }
    throw invalidJsonFieldValueError();
  }
}

function invalidJsonFieldValueError() {
  return commandError(
    "Invalid JSON field value.",
    "Use only JSON-compatible values: objects, arrays, strings, numbers, booleans, or null.",
  );
}

function deserializeRow(table: LooseRecord, row: LooseRecord) {
  const output = { ...row };
  for (const field of table.fields) {
    if (field.kind === "Boolean") {
      output[field.name] = output[field.name] === null ? null : Boolean(output[field.name]);
    } else if (field.kind === "Json") {
      output[field.name] = output[field.name] === null ? null : JSON.parse(output[field.name]);
    }
    if (field.kind === "Number") {
      output[field.name] = output[field.name] === null ? null : Number(output[field.name]);
    }
  }
  return output;
}

async function readEndpointBody(request: any, headers: { [x: string]: any; }, limitSource: LooseRecord | number | null = null) {
  const raw = (await readLimitedRequestBody(request, limitSource)).toString("utf8");
  if (!raw) {
    return null;
  }
  if ((headers["content-type"] ?? "").toLowerCase().includes("application/json")) {
    return JSON.parse(raw);
  }
  return raw;
}

function createEndpointLogger(database: any, context = {}) {
  return createRuntimeLogger(database, {
    category: "app",
    event: "ctx.log",
    ...context,
  });
}

function writeEndpointResult(response: any, result: any) {
  if (result && typeof result === "object" && !Buffer.isBuffer(result) && "body" in result) {
    const status = result.status ?? 200;
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw endpointResponseError();
    }
    if (
      result.headers !== undefined &&
      (result.headers === null || typeof result.headers !== "object" || Array.isArray(result.headers))
    ) {
      throw endpointResponseError();
    }
    const headers = { ...(result.headers ?? {}) };
    const body = result.body ?? null;
    if (body !== null && typeof body === "object" && !Buffer.isBuffer(body)) {
      headers["content-type"] ??= "application/json; charset=utf-8";
      let payload;
      try {
        payload = JSON.stringify(body);
      } catch {
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

function writeEndpointError(response: any, error: any) {
  response.writeHead(error?.code === "UNAUTHENTICATED" ? 401 : isPayloadTooLargeError(error) ? 413 : 500, { "content-type": "application/json; charset=utf-8" });
  response.end(
    `${JSON.stringify({
      ok: false,
      data: null as any,
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
    })}\n`,
  );
}

function endpointResponseError() {
  const error: HelperError = new Error("Invalid endpoint response.");
  error.sporadesEndpointResponse = true;
  return error;
}

function parseFieldDefault(kind: string, rawDefault: string | undefined) {
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

function parseJsonFieldDefault(rawDefault: any) {
  try {
    const createDefault = new Function(`return (${rawDefault});`);
    const value = createDefault();
    assertJsonCompatible(value);
    return value;
  } catch {
    throw commandError(
      "Invalid JSON field default.",
      "Use a JSON-compatible default value for Json().default(...).",
    );
  }
}

function parseDateFieldDefault(rawDefault: any) {
  try {
    const createDefault = new Function(`return (${rawDefault});`);
    return normalizeDateValue(createDefault(), "default");
  } catch {
    throw commandError(
      "Invalid Date() default.",
      "Pass an ISO 8601 date string or JavaScript Date value to Date().default(...).",
    );
  }
}

function toSqlLiteral(value: any, field: any = null) {
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

export async function listDatabaseTables(database: { adapter: any; sqlite: any; }) {
  return await (database.adapter ?? database.sqlite).listInspectableTables();
}

export async function dumpDatabase(database: { adapter: any; sqlite: any; }) {
  return await (database.adapter ?? database.sqlite).dumpInspectableDatabase();
}

export async function runReadOnlyQuery(database: { adapter: any; sqlite: any; }, sql: any) {
  return await (database.adapter ?? database.sqlite).runReadOnlyInspectionQuery(sql);
}

export function validateReadOnlyInspectionSql(sql: any) {
  const text = String(sql ?? "");
  const firstToken = readFirstSqlToken(text);
  if (!firstToken || hasMultipleSqlStatements(text)) {
    return readOnlyInspectionSqlError();
  }

  const keyword = firstToken.toLowerCase();
  if (keyword === "pragma") {
    return isSafeInspectionPragma(text, firstToken.length) ? { ok: true as const } : readOnlyInspectionSqlError();
  }

  if ((keyword === "select" || keyword === "with") && !containsSideEffectSqlToken(text)) {
    return { ok: true as const };
  }

  return readOnlyInspectionSqlError();
}

function readOnlyInspectionSqlError() {
  return {
    ok: false as const,
    data: null as any,
    error: {
      message: "Only read-only SQL is allowed.",
      hint: "Use a SELECT, WITH, or safe metadata PRAGMA query for `sporades db query`.",
    },
  };
}

function readFirstSqlToken(sql: string) {
  const index = skipSqlTrivia(sql, 0);
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(index));
  return match?.[0] ?? null;
}

function hasMultipleSqlStatements(sql: string) {
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

function isSafeInspectionPragma(sql: string, pragmaTokenLength: number) {
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

function containsSideEffectSqlToken(sql: string) {
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

function readSqlTokens(sql: string) {
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

function readBareSqlIdentifier(sql: string, index: number) {
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(index));
  return match ? { value: match[0], nextIndex: index + match[0].length } : null;
}

function readSqlTokenIdentifier(sql: string, index: number) {
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

function skipSqlLiteralOrComment(sql: string, index: number) {
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

function skipSqlStringOrComment(sql: string, index: number) {
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

function targetsInternalLogIndexTable(sql: any) {
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

function readSqlTableReference(sql: string, startIndex: number) {
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

function skipSqlTrivia(sql: string, startIndex: any) {
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

function readSqlIdentifier(sql: string, index: number) {
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

function isInternalLogIndexMetadataRow(row: Record<string, SQLOutputValue>, sql = "") {
  const queriesSqliteSchema = /\bsqlite_(?:schema|master)\b/i.test(String(sql));
  return (
    ["name", "tbl_name", "table", "tableName"].some((key) => row?.[key] === "sporades_log_events") ||
    Object.values(row ?? {}).some(
      (value) =>
        typeof value === "string" &&
        (/\bcreate\s+table\b[\s\S]*\bsporades_log_events\b/i.test(value) ||
          (queriesSqliteSchema && /\bsporades_log_events\b/i.test(value))),
    )
  );
}

export async function simulateLocalIdentitySession(database: LooseRecord, options: LooseRecord = {}) {
  const provider = String(options.provider ?? "").trim().toLowerCase();
  if (!["email", "google"].includes(provider)) {
    return {
      ok: false,
      data: null as any,
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
      data: null as any,
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

  return await database.sqlite.withTransaction(async (tx: LooseRecord) => {
    const existing = await tx.findAuthUserByProviderEmail(provider, email);
    const userId = existing?.id ?? randomUUID();

    if (existing) {
      await tx.updateAuthUserProfile({ id: userId, displayName, picture, isAuthenticated: 1, isGuest: 0 });
    } else {
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
    await tx.insertAuthSession({ token, userId, provider, createdAt: now, expiresAt: sessionExpiresAt(now) });

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

function normalizeSimulatedEmail(value: any) {
  const email = normalizeSimulatedText(value)?.toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return null;
  }
  return email;
}

function normalizeSimulatedText(value: null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
}

function normalizeJourneyPolicy(value: any) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.enabled !== true) throw commandError("Invalid Journey declaration.", "Declare journey: { enabled: true } on capsule().");
  const ttlSeconds = value.ttlSeconds ?? 30;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300) throw commandError("Invalid Journey TTL.", "Set journey.ttlSeconds to an integer from 1 through 300.");
  const capture: any = {};
  if (value.capture !== undefined && (value.capture === null || typeof value.capture !== "object" || Array.isArray(value.capture) || Object.getPrototypeOf(value.capture) !== Object.prototype)) throw commandError("Invalid Journey capture policy.", "Set journey.capture to a plain object of boolean source settings.");
  for (const key of ["navigation", "focus", "interactions"]) {
    const setting = value.capture?.[key];
    if (setting !== undefined && typeof setting !== "boolean") throw commandError("Invalid Journey capture policy.", `Set journey.capture.${key} to true or false.`);
    capture[key] = setting ?? true;
  }
  return { ttlSeconds, capture };
}

function normalizeJourneyState(value: any, defaultTtlSeconds: number) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw { code: "INVALID_JOURNEY_STATE", message: "Journey state must be an object.", hint: "Pass status, optional metadata, and optional ttlSeconds to journey.set()." };
  const status = typeof value.status === "string" ? value.status.trim() : "";
  if (!status || Buffer.byteLength(status, "utf8") > 256 || status === "inactive") throw { code: "INVALID_JOURNEY_STATUS", message: "Journey status is invalid.", hint: "Use a trimmed status from 1 through 256 UTF-8 characters other than inactive." };
  const ttlSeconds = value.ttlSeconds ?? defaultTtlSeconds;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300) throw { code: "INVALID_JOURNEY_TTL", message: "Journey TTL is invalid.", hint: "Use an integer from 1 through 300." };
  if (value.metadata !== undefined && (value.metadata === null || typeof value.metadata !== "object" || Array.isArray(value.metadata) || Object.getPrototypeOf(value.metadata) !== Object.prototype)) throw { code: "INVALID_JOURNEY_METADATA", message: "Journey metadata must be a plain JSON object.", hint: "Pass a plain JSON object as metadata." };
  if (value.metadata !== undefined) validateJourneyJson(value.metadata, 0, new Set());
  if (value.metadata !== undefined && Buffer.byteLength(JSON.stringify(value.metadata), "utf8") > 8192) throw { code: "INVALID_JOURNEY_METADATA", message: "Journey metadata is too large.", hint: "Keep serialized metadata at or below 8 KiB." };
  return { status, metadata: value.metadata, ttlSeconds };
}

function validateJourneyJson(value: any, depth: number, seen: Set<any>) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (Number.isFinite(value)) return; throw { code: "INVALID_JOURNEY_METADATA", message: "Journey metadata contains a non-finite number.", hint: "Use finite JSON numbers." }; }
  if (typeof value !== "object" || depth >= 8 || seen.has(value)) throw { code: "INVALID_JOURNEY_METADATA", message: "Journey metadata is not JSON-safe.", hint: "Use bounded plain JSON values without cycles, binary values, or custom prototypes." };
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw { code: "INVALID_JOURNEY_METADATA", message: "Journey metadata is not a plain JSON object.", hint: "Use plain JSON objects and arrays." };
  if (!Array.isArray(value) && Reflect.ownKeys(value).some((key) => typeof key === "symbol")) throw { code: "INVALID_JOURNEY_METADATA", message: "Journey metadata contains symbol keys.", hint: "Use string-keyed plain JSON objects." };
  const entries = Array.isArray(value) ? value : Object.values(value);
  if (entries.length > 64) throw { code: "INVALID_JOURNEY_METADATA", message: "Journey metadata has too many entries.", hint: "Keep each object or array at 64 entries or fewer." };
  seen.add(value); try { for (const item of entries) validateJourneyJson(item, depth + 1, seen); } finally { seen.delete(value); }
}

function journeyError(id: any, code = "JOURNEY_NOT_ENABLED", message = "User journey tracking is not enabled for this Capsule.", hint = "Declare journey: { enabled: true } on capsule().") {
  return { id: id ?? null, type: "error", data: null, error: { code, message, hint } };
}

type TrustedRefreshTransport = {
  subscribeType: "dev.refresh.subscribe";
  receivedType: "dev.refresh.received";
  subscribe(connectionId: string, requestId: string | null, send: (message: LooseRecord) => Promise<LooseRecord>): Promise<void> | void;
  received(connectionId: string, sequence: number): void;
  disconnected(connectionId: string): void;
};

export function createWebSocketHub(getDatabase: () => any, trustedRefresh: TrustedRefreshTransport | null = null) {
  const clients = new Set<any>();
  const journeys = new Map<string, any>();
  const connectionTokens = new Map<string, number>();
  let nextClientId = 1;
  const connectionTokenTtlMs = 4 * 60 * 60 * 1000;
  let journeyExpiryTimer: any = null;
  let journeyDisableRequests = 0;

  return {
    createConnectionToken() {
      pruneConnectionTokens();
      const token = randomBytes(32).toString("base64url");
      connectionTokens.set(token, Date.now() + connectionTokenTtlMs);
      return token;
    },
    async accept(request: IncomingMessage, socket: Duplex) {
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

      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${createWebSocketAccept(key)}`,
          "",
          "",
        ].join("\r\n"),
      );

      const origin = requestOrigin(request);
      const now = new Date().toISOString();
      const client: any = {
        id: `client-${(nextClientId++).toString(36)}`,
        socket,
        buffer: Buffer.alloc(0),
        messageQueue: Promise.resolve(),
        subscriptions: new Map(),
        session: createPendingWebSocketSession(),
        origin,
        connectedAt: now,
        lastSeenAt: now,
        journey: null,
        journeySubscriptions: new Set(),
      };
      clients.add(client);
      socket.on("data", (chunk: Uint8Array<ArrayBufferLike>) => {
        client.lastSeenAt = new Date().toISOString();
        client.buffer = Buffer.concat([client.buffer, chunk]);
        drainWebSocketFrames(client, (message: any) => enqueueClientMessage(client, message));
      });
      const removeClient = () => {
        clients.delete(client);
        trustedRefresh?.disconnected(client.id);
        client.subscriptions.clear();
        client.journeySubscriptions.clear();
        client.journey = null;
      };
      socket.on("close", removeClient);
      socket.on("error", removeClient);
    },
    disconnectAll() {
      if (journeyExpiryTimer !== null) getDatabase().clock.clearTimer(journeyExpiryTimer);
      journeyExpiryTimer = null;
      for (const client of clients) {
        trustedRefresh?.disconnected(client.id);
        closeWebSocketClient(client);
      }
      clients.clear();
      journeys.clear();
    },
    listAuthClients() {
      return [...clients].map((client) => ({
        id: client.id,
        connectedAt: client.connectedAt,
        lastSeenAt: client.lastSeenAt,
        auth: summarizeAuthForClientList(client.session.auth),
      }));
    },
    journeyDiagnostics() { return { disableRequests: journeyDisableRequests, activeStates: journeys.size }; },
    notifyFileEvent(userId: any, event: any) {
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
    deliverAuthSession(target: any, sessionData: { localStorage: { value: any; }; auth: any; }) {
      const recipients = authSessionRecipients(target);
      for (const client of recipients) {
        retireJourney(client);
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

  function retireJourney(client: LooseRecord) {
    if (!client.journey) return;
    const removed = [...(client.journey.sessionIds ?? [])].map((sessionId) => journeys.get(sessionId)).filter(Boolean);
    for (const sessionId of client.journey.sessionIds ?? []) journeys.delete(sessionId);
    client.journey = null;
    for (const state of removed) broadcastJourneyEvent({ type: "removed", state });
    scheduleJourneyExpiry();
  }

  function activeJourneys() {
    pruneExpiredJourneys();
    return [...journeys.values()].sort((a, b) => a.userId.localeCompare(b.userId) || a.sessionId.localeCompare(b.sessionId));
  }

  function pruneExpiredJourneys() {
    const now = getDatabase().clock.now().getTime();
    const expired = [...journeys.values()]
      .filter((record) => Date.parse(record.expiresAt) <= now)
      .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt) || a.sessionId.localeCompare(b.sessionId));
    for (const record of expired) {
      if (journeys.get(record.sessionId) !== record) continue;
      journeys.delete(record.sessionId);
      broadcastJourneyEvent({ type: "removed", state: record });
    }
    return expired.length;
  }

  function scheduleJourneyExpiry() {
    const database = getDatabase();
    if (journeyExpiryTimer !== null) database.clock.clearTimer(journeyExpiryTimer);
    journeyExpiryTimer = null;
    let earliest = Infinity;
    for (const record of journeys.values()) earliest = Math.min(earliest, Date.parse(record.expiresAt));
    if (!Number.isFinite(earliest)) return;
    journeyExpiryTimer = database.clock.setTimer(() => {
      journeyExpiryTimer = null;
      pruneExpiredJourneys();
      scheduleJourneyExpiry();
    }, Math.max(0, earliest - database.clock.now().getTime()));
  }

  function broadcastJourneyEvent(event: any) {
    for (const recipient of clients) {
      for (const subscriptionId of recipient.journeySubscriptions) {
        sendJson(recipient, { id: subscriptionId, type: "journey.event", data: event, error: null });
      }
    }
  }

  function validateConnectionToken(token: string | null) {
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

  function authSessionRecipients(target: string) {
    if (target === "all") {
      return [...clients];
    }
    if (target === "current") {
      return [...clients].slice(-1);
    }
    return [...clients].filter((client) => client.id === target);
  }

  function requestOrigin(request: RuntimeRequestLike) {
    const forwardedProto = firstForwardedHeader(request.headers["x-forwarded-proto"]);
    const forwardedHost = firstForwardedHeader(request.headers["x-forwarded-host"]);
    const protocol = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : request.socket?.encrypted ? "https" : "http";
    const host = forwardedHost || request.headers.host;
    return `${protocol}://${host}`;
  }

  function firstForwardedHeader(value: any) {
    const raw = Array.isArray(value) ? value[0] : value;
    return String(raw ?? "")
      .split(",")[0]
      .trim()
      .toLowerCase();
  }

  function summarizeAuthForClientList(auth: LooseRecord) {
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

  function enqueueClientMessage(client: LooseRecord, rawMessage: any) {
    client.messageQueue = client.messageQueue
      .then(() => handleClientMessage(client, rawMessage))
      .catch((error: any) => {
        sendUnhandledMessageError(client, rawMessage, error);
      });
  }

  function sendUnhandledMessageError(client: LooseRecord, rawMessage: string, error: any) {
    let id = null;
    try {
      id = JSON.parse(rawMessage)?.id ?? null;
    } catch {
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

  async function handleClientMessage(client: LooseRecord, rawMessage: string) {
    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch {
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

    if (trustedRefresh && message.type === trustedRefresh.subscribeType) {
      const requestId = typeof message.id === "string" && message.id.length <= 128 ? message.id : null;
      await trustedRefresh.subscribe(client.id, requestId, (outgoing: LooseRecord) => sendJsonWithCompletion(client, outgoing));
      return;
    }
    if (trustedRefresh && message.type === trustedRefresh.receivedType) {
      if (Number.isSafeInteger(message.sequence) && message.sequence >= 1) trustedRefresh.received(client.id, message.sequence);
      return;
    }

    const database = getDatabase();
    const messageSessionToken =
      typeof message.sessionToken === "string" && message.sessionToken.length > 0 ? message.sessionToken : client.session.token;
    const resolvedSession = await resolveAnonymousSession(database, messageSessionToken ?? null);
    if (client.session.auth.userId && client.session.auth.userId !== resolvedSession.auth.userId) retireJourney(client);
    client.session = resolvedSession;
    if (message.type === "auth.get") {
      await sendAuthResult(client, message.id ?? null);
      return;
    }

    if (message.type === "auth.signOut") {
      const result = await signOutSession(database, client);
      if (result.ok) retireJourney(client);
      sendJson(client, {
        id: message.id ?? null,
        type: result.ok ? "auth.signOut.result" : "error",
        data: result.ok ? { ok: true } : null,
        error: result.error ?? null,
      });
      return;
    }

    if (message.type === "auth.signUp") {
      const result: any = await signUpWithEmail(database, client.session, message.provider, message.credentials ?? {});
      if (result.ok) {
        retireJourney(client);
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
        const result: any = await signInWithEmail(database, client.session, message.credentials ?? {});
        if (result.ok) {
          retireJourney(client);
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
      const providerAdapter = oauthProviderAdapter(database, provider);
      if (!providerAdapter?.enabled) {
        sendJson(client, {
          id: message.id ?? null,
          type: "error",
          error: {
            message: `Unsupported auth provider: ${provider ?? ""}`.trim(),
            hint: "Use auth.signIn with a configured OAuth provider.",
          },
        });
        return;
      }
      const result = await beginOAuthSignIn(database, client.session, provider, {
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
      const validId = (typeof message.id === "string" && message.id.length > 0) || (typeof message.id === "number" && Number.isFinite(message.id));
      if (!validId || typeof queryName !== "string" || queryName.length === 0) {
        sendJson(client, {
          id: message.id ?? null,
          type: "error",
          data: null,
          error: {
            message: "Invalid query subscribe request.",
            hint: "Use a string or numeric subscription ID and a non-empty query name.",
          },
        });
        return;
      }
      const subscription = { id: message.id, name: queryName, style: message.query ? "direct" : "rows", generation: 0 };
      client.subscriptions.set(message.id, subscription);
      void sendQueryResult(client, subscription, (error: any) => sendUnhandledMessageError(client, rawMessage, error));
      return;
    }

    if (message.type === "query.unsubscribe") {
      const subscriptionId = message.subscriptionId;
      const validId = (typeof subscriptionId === "string" && subscriptionId.length > 0)
        || (typeof subscriptionId === "number" && Number.isFinite(subscriptionId));
      if (!validId) {
        sendJson(client, {
          id: message.id ?? null,
          type: "error",
          data: null,
          error: {
            message: "Invalid query unsubscribe request.",
            hint: "Use the string or numeric subscription ID returned by query.subscribe.",
          },
        });
        return;
      }
      const removed = client.subscriptions.delete(subscriptionId);
      sendJson(client, {
        id: message.id ?? null,
        type: "query.unsubscribe.result",
        data: { removed },
        error: null,
      });
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

    if (message.type === "journey.enable") {
      const policy = database.journeyPolicy;
      if (!policy) { sendJson(client, journeyError(message.id)); return; }
      if (!client.journey) {
        const requested = message.options?.capture;
        const capture: any = {};
        for (const key of ["navigation", "focus", "interactions"]) capture[key] = policy.capture[key] && requested?.[key] !== false;
        client.journey = { sessionId: null, sessionIds: new Set(), lastActivityAt: null, userId: client.session.auth.userId, capture };
      }
      sendJson(client, { id: message.id ?? null, type: "journey.enable.result", data: { enabled: true, userId: client.journey.userId, capture: client.journey.capture }, error: null });
      return;
    }

    if (message.type === "journey.set") {
      if (!database.journeyPolicy) { sendJson(client, journeyError(message.id)); return; }
      if (!client.journey) { sendJson(client, journeyError(message.id, "JOURNEY_NOT_ENABLED", "Journey publication is not enabled for this page.", "Call journey.enable() before journey.set().")); return; }
      if (client.journey.userId !== client.session.auth.userId) {
        retireJourney(client);
        sendJson(client, journeyError(message.id, "JOURNEY_IDENTITY_CHANGED", "Journey session identity changed.", "Call journey.enable() again for the current authenticated user.")); return;
      }
      try {
        const state = normalizeJourneyState(message.state, database.journeyPolicy.ttlSeconds);
        pruneExpiredJourneys();
        const nowDate = database.clock.now();
        const inactivityMs = database.journeySessionInactivityMinutes * 60_000;
        if (!client.journey.sessionId || (client.journey.lastActivityAt !== null && nowDate.getTime() - client.journey.lastActivityAt >= inactivityMs)) {
          client.journey.sessionId = randomBytes(24).toString("base64url");
          client.journey.sessionIds.add(client.journey.sessionId);
        }
        const previous = journeys.get(client.journey.sessionId);
        if (!previous) {
          const userCount = [...journeys.values()].filter((record) => record.userId === client.session.auth.userId).length;
          if (userCount >= 32) throw { code: "JOURNEY_USER_CAPACITY", message: "Journey user capacity reached.", hint: "Wait for an existing Journey state to expire or disable one before publishing another." };
          if (journeys.size >= 1000) throw { code: "JOURNEY_CAPSULE_CAPACITY", message: "Journey Capsule capacity reached.", hint: "Wait for an existing Journey state to expire or be disabled before publishing another." };
        }
        const now = nowDate.toISOString();
        const record = { sessionId: client.journey.sessionId, userId: client.session.auth.userId, status: state.status, metadata: state.metadata ?? null, updatedAt: now, expiresAt: new Date(nowDate.getTime() + state.ttlSeconds * 1000).toISOString() };
        journeys.set(record.sessionId, record);
        client.journey.lastActivityAt = nowDate.getTime();
        scheduleJourneyExpiry();
        sendJson(client, { id: message.id ?? null, type: "journey.set.result", data: { journey: record }, error: null });
        broadcastJourneyEvent({ type: previous ? "updated" : "added", state: record });
      } catch (error: any) { sendJson(client, { id: message.id ?? null, type: "error", data: null, error }); }
      return;
    }

    if (message.type === "journey.list") {
      if (!database.journeyPolicy) { sendJson(client, journeyError(message.id)); return; }
      sendJson(client, { id: message.id ?? null, type: "journey.list.result", data: { journeys: activeJourneys() }, error: null });
      return;
    }

    if (message.type === "journey.subscribe") {
      if (!database.journeyPolicy) { sendJson(client, journeyError(message.id)); return; }
      const snapshot = activeJourneys();
      client.journeySubscriptions.add(message.id);
      sendJson(client, { id: message.id, type: message.resume === true ? "journey.sync" : "journey.event", data: { type: "snapshot", states: snapshot }, error: null });
      return;
    }

    if (message.type === "journey.unsubscribe") {
      client.journeySubscriptions.delete(message.subscriptionId);
      sendJson(client, { id: message.id ?? null, type: "journey.unsubscribe.result", data: { ok: true }, error: null });
      return;
    }

    if (message.type === "journey.disable") {
      journeyDisableRequests += 1;
      if (!database.journeyPolicy) { sendJson(client, journeyError(message.id)); return; }
      const removed = client.journey ? [...client.journey.sessionIds].map((sessionId) => journeys.get(sessionId)).filter(Boolean) : [];
      if (client.journey) for (const sessionId of client.journey.sessionIds) journeys.delete(sessionId);
      client.journey = null;
      scheduleJourneyExpiry();
      sendJson(client, { id: message.id ?? null, type: "journey.disable.result", data: { ok: true }, error: null });
      for (const state of removed) broadcastJourneyEvent({ type: "removed", state });
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
            for (const subscription of subscribedClient.subscriptions.values()) {
              void sendQueryResult(
                subscribedClient,
                subscription,
                (error: any) => sendUnhandledMessageError(subscribedClient, JSON.stringify({ id: subscription.id }), error),
              );
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
      const result: any = await getPrivateFileUrl(database, client.session.auth, message.fileReference ?? message.fileId);
      sendJson(client, {
        id: message.id ?? null,
        type: result.ok ? "file.url.result" : "error",
        data: result.data ?? null,
        error: result.error,
      });
      return;
    }

    if (message.type === "file.publicUrl.create") {
      const result: any = await createPublicFileUrl(database, client.session.auth, message.fileReference ?? message.fileId, message.options ?? {});
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
      const result: any = await deletePrivateFile(database, client.session.auth, message.fileReference ?? message.fileId);
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
        hint: "Use auth.get, auth.signIn, auth.signOut, query.subscribe, query.unsubscribe, mutation.run, app messages, or files.* through the Sporades client SDK.",
      },
    });
  }

  async function sendQueryResult(client: LooseRecord, subscription: LooseRecord, onError: (error: any) => void) {
    const generation = (subscription.generation ?? 0) + 1;
    subscription.generation = generation;
    try {
      const database = getDatabase();
      const result: any = await runQuery(database, client.session.auth, subscription.name);
      const data =
        subscription.style === "direct"
          ? (result.data ?? result.rows)
          : { rows: result.data ?? result.rows };
      if (client.subscriptions.get(subscription.id) !== subscription || subscription.generation !== generation) return;
      sendJson(client, {
        id: subscription.id,
        type: "query.result",
        query: subscription.name,
        data,
        error: result.error,
      });
    } catch (error) {
      if (client.subscriptions.get(subscription.id) !== subscription || subscription.generation !== generation) return;
      try { onError(error); } catch { /* A closed transport already owns cleanup. */ }
    }
  }

  async function sendAuthResult(client: LooseRecord, id: any) {
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

  async function signOutSession(database: LooseRecord, client: LooseRecord) {
    try {
      await database.sqlite.deleteAuthSession(client.session.token);
      client.session = await resolveAnonymousSession(database, null);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: {
          message: "Could not sign out.",
          hint: "Retry sign-out. If this keeps happening, restart the Sporades dev session.",
        },
      };
    }
  }

  function sendAppMessage(senderAuth: LooseRecord, appMessage: LooseRecord) {
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

  function clientsForAppMessageScope(scope: any, senderAuth: LooseRecord) {
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

  function notifyPreferencesUpdated(sender: LooseRecord, data: LooseRecord) {
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

export async function routeSporadesAuth(database: LooseRecord, request: IncomingMessage, response: ServerResponse<IncomingMessage> & { req: IncomingMessage; }) {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const match = requestUrl.pathname.match(/^\/__sporades\/auth\/([a-z0-9-]+)\/callback$/);
  if (!match) {
    return false;
  }
  const provider = match[1];
  let parameters;
  try {
    parameters = await readOAuthCallbackParameters(request, requestUrl);
  } catch (error) {
    writeEndpointError(response, error);
    return true;
  }
  const state = parameters.get("state");
  if (!state) {
    writeEndpointError(response, commandError("Invalid OAuth callback.", "Retry sign-in from the app.", "OAUTH_INVALID_CALLBACK"));
    return true;
  }
  const stateRow = await database.sqlite.consumeOAuthState(state);
  if (!stateRow) {
    writeEndpointError(response, commandError("Invalid or already-used OAuth state.", "Retry sign-in from the app.", "OAUTH_INVALID_STATE"));
    return true;
  }
  try {
    if (stateRow.provider !== provider) {
      throw commandError("OAuth provider did not match the sign-in request.", "Retry sign-in from the app.", "OAUTH_PROVIDER_MISMATCH");
    }
    if (!stateRow.expiresAt || Date.parse(stateRow.expiresAt) <= Date.now()) {
      throw commandError("OAuth sign-in request expired.", "Retry sign-in from the app.", "OAUTH_STATE_EXPIRED");
    }
    const adapter = oauthProviderAdapter(database, provider);
    if (!adapter?.enabled) {
      throw commandError("OAuth provider is not configured.", "Configure the provider and retry sign-in.", "OAUTH_PROVIDER_NOT_CONFIGURED");
    }
    if ((adapter.responseMode === "form_post" && request.method !== "POST") ||
        (adapter.responseMode !== "form_post" && request.method !== "GET")) {
      throw commandError("OAuth callback used the wrong response mode.", "Retry sign-in from the app.", "OAUTH_RESPONSE_MODE_MISMATCH");
    }
    const providerError = parameters.get("error");
    if (providerError) {
      throw commandError(
        "OAuth sign-in was cancelled or declined.",
        "Retry sign-in when you are ready.",
        "OAUTH_PROVIDER_CANCELLED",
      );
    }
    const code = parameters.get("code");
    if (!code) {
      throw commandError("OAuth callback did not include an authorization code.", "Retry sign-in from the app.", "OAUTH_INVALID_CALLBACK");
    }
    const profile = await adapter.complete({
      provider,
      code,
      redirectUri: stateRow.redirectUri,
      nonce: stateRow.nonce,
      pkceVerifier: stateRow.pkceVerifier,
      parameters,
    });
    const session = await resolveAnonymousSession(database, stateRow.sessionToken);
    const result = await linkProviderIdentity(database, session, provider, profile);
    if (!result.ok) {
      throw commandError(result.error?.message, result.error?.hint ?? "Retry sign-in from the app.", result.error?.code);
    }
    writeRedirect(response, stateRow.returnTo);
  } catch (error: any) {
    writeEndpointError(response, error);
  }
  return true;
}

async function readOAuthCallbackParameters(request: IncomingMessage, requestUrl: URL) {
  if (request.method === "GET") {
    return requestUrl.searchParams;
  }
  if (request.method !== "POST" || !String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    throw commandError("Unsupported OAuth callback request.", "Retry sign-in from the app.", "OAUTH_INVALID_CALLBACK");
  }
  const body = await readRequestBytes(request, 16 * 1024);
  return new URLSearchParams(body.toString("utf8"));
}

async function beginOAuthSignIn(database: LooseRecord, session: LooseRecord, provider: string, options: LooseRecord) {
  const adapter = oauthProviderAdapter(database, provider);
  if (!adapter?.enabled) {
    return {
      ok: false,
      error: {
        code: "OAUTH_PROVIDER_NOT_CONFIGURED",
        message: `${provider || "OAuth"} provider is not configured.`,
        hint: provider === "google"
          ? "Run `sporades auth set google --client-id <id> --client-secret <secret>` or `sporades auth set google --client-json <path>`."
          : "Configure this OAuth provider before retrying sign-in.",
      },
    };
  }
  const origin = options.origin;
  const redirectUri = `${origin}/__sporades/auth/${provider}/callback`;
  const returnTo = normalizeReturnTo(options.returnTo, origin);
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const pkceVerifier = randomBytes(48).toString("base64url");
  const pkceChallenge = createHash("sha256").update(pkceVerifier).digest("base64url");
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  let started;
  try {
    started = await adapter.begin({
      provider,
      state,
      nonce,
      redirectUri,
      pkceChallenge,
      pkceChallengeMethod: "S256",
    });
  } catch {
    return {
      ok: false,
      error: {
        code: "OAUTH_PROVIDER_START_FAILED",
        message: "OAuth sign-in could not be started.",
        hint: "Check the provider configuration and retry sign-in.",
      },
    };
  }
  if (!started?.url) {
    return {
      ok: false,
      error: {
        code: "OAUTH_PROVIDER_START_FAILED",
        message: "OAuth provider did not return an authorization URL.",
        hint: "Check the provider configuration and retry sign-in.",
      },
    };
  }
  await database.sqlite.insertOAuthState({
    state,
    provider,
    sessionToken: session.token,
    returnTo,
    redirectUri,
    createdAt: now,
    expiresAt,
    nonce,
    pkceVerifier,
  });
  return { ok: true, url: started.url };
}

function normalizeReturnTo(returnTo: string | URL, origin: string | URL | undefined) {
  if (!returnTo) {
    return origin;
  }
  try {
    const url = new URL(returnTo, origin);
    if (url.origin !== origin) {
      return origin;
    }
    return url.toString();
  } catch {
    return origin;
  }
}

function oauthProviderAdapter(database: LooseRecord, provider: string) {
  if (database.__oauthProviderAdapters?.[provider]) {
    return database.__oauthProviderAdapters[provider];
  }
  if (provider === "google") {
    return createGoogleOAuthProviderAdapter(database);
  }
  return null;
}

function createGoogleOAuthProviderAdapter(database: LooseRecord) {
  const google = database.authConfig.google;
  const configured = Boolean(database.authConfig.providers.google.enabled && google.configured);
  return {
    provider: "google",
    responseMode: "query",
    enabled: configured,
    begin(context: LooseRecord) {
      const clientId = database.serverEnv[google.clientIdEnv];
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: context.redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state: context.state,
        nonce: context.nonce,
        code_challenge: context.pkceChallenge,
        code_challenge_method: "S256",
      });
      return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` };
    },
    complete(context: LooseRecord) {
      return completeGoogleOAuth(database, context);
    },
  };
}

async function completeGoogleOAuth(database: LooseRecord, context: LooseRecord) {
  const google = database.authConfig.google;
  const tokenUrl = process.env.SPORADES_GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
  const clientId = database.serverEnv[google.clientIdEnv];
  const clientSecret = database.serverEnv[google.clientSecretEnv];
  let tokenResponse;
  try {
    tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: context.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: context.redirectUri,
        grant_type: "authorization_code",
        code_verifier: context.pkceVerifier,
      }),
    });
  } catch {
    throw commandError("Google OAuth code exchange failed.", "Check the Google OAuth client configuration and retry sign-in.", "OAUTH_EXCHANGE_FAILED");
  }
  if (!tokenResponse.ok) {
    throw commandError("Google OAuth code exchange failed.", "Check the Google OAuth client configuration and retry sign-in.", "OAUTH_EXCHANGE_FAILED");
  }
  let token;
  try {
    token = await tokenResponse.json();
  } catch {
    throw commandError("Google OAuth response was invalid.", "Check the Google OAuth client configuration and retry sign-in.", "OAUTH_EXCHANGE_FAILED");
  }
  if (typeof token.id_token !== "string" || token.id_token.length > 16 * 1024) {
    throw commandError("Google OAuth response did not include a valid identity token.", "Check the Google OAuth client configuration and retry sign-in.", "OAUTH_ID_TOKEN_INVALID");
  }
  return await verifyGoogleIdentityToken(database, token.id_token, context.nonce);
}

async function verifyGoogleIdentityToken(database: LooseRecord, token: string, expectedNonce: string) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw commandError("Google identity token was invalid.", "Retry Google sign-in.", "OAUTH_ID_TOKEN_INVALID");
  }
  let header;
  let claims;
  try {
    header = JSON.parse(decodeJwtPart(parts[0]).toString("utf8"));
    claims = JSON.parse(decodeJwtPart(parts[1]).toString("utf8"));
  } catch {
    throw commandError("Google identity token was invalid.", "Retry Google sign-in.", "OAUTH_ID_TOKEN_INVALID");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw commandError("Google identity token used an unsupported signature.", "Retry Google sign-in.", "OAUTH_ID_TOKEN_INVALID");
  }
  const jwksUrl = process.env.SPORADES_GOOGLE_JWKS_URL ?? "https://www.googleapis.com/oauth2/v3/certs";
  let jwks;
  try {
    const response = await fetch(jwksUrl);
    if (!response.ok) {
      throw new Error("jwks");
    }
    jwks = await response.json();
  } catch {
    throw commandError("Google signing keys could not be loaded.", "Retry Google sign-in.", "OAUTH_ID_TOKEN_KEYS_UNAVAILABLE");
  }
  const jwk = Array.isArray(jwks?.keys) ? jwks.keys.find((candidate: LooseRecord) => candidate.kid === header.kid && candidate.kty === "RSA") : null;
  if (!jwk) {
    throw commandError("Google identity token signing key was not recognized.", "Retry Google sign-in.", "OAUTH_ID_TOKEN_INVALID");
  }
  let signatureValid = false;
  let signatureCheckFailed = false;
  try {
    signatureValid = verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key: jwk, format: "jwk" },
      decodeJwtPart(parts[2]),
    );
  } catch {
    signatureCheckFailed = true;
  }
  const clientId = database.serverEnv[database.authConfig.google.clientIdEnv];
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const validIssuer = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  const validSubject = typeof claims.sub === "string" &&
    claims.sub.length <= 255 &&
    /^[\x21-\x7e]+$/.test(claims.sub);
  const invalidCode = signatureCheckFailed ? "OAUTH_ID_TOKEN_SIGNATURE_CHECK_FAILED"
    : !signatureValid ? "OAUTH_ID_TOKEN_SIGNATURE_INVALID"
    : !validIssuer ? "OAUTH_ID_TOKEN_ISSUER_INVALID"
    : !audiences.includes(clientId) ? "OAUTH_ID_TOKEN_AUDIENCE_INVALID"
    : typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now() / 1000) ? "OAUTH_ID_TOKEN_EXPIRED"
    : claims.nonce !== expectedNonce ? "OAUTH_ID_TOKEN_NONCE_INVALID"
    : !validSubject ? "OAUTH_ID_TOKEN_SUBJECT_INVALID"
    : null;
  if (invalidCode) {
    throw commandError("Google identity token failed verification.", "Retry Google sign-in.", invalidCode);
  }
  return {
    subject: claims.sub,
    email: normalizeSimulatedText(claims.email)?.toLowerCase() ?? null,
    emailVerified: claims.email_verified === true,
    displayName: normalizeSimulatedText(claims.name) ?? normalizeSimulatedText(claims.email) ?? "Google user",
    picture: normalizeSimulatedText(claims.picture),
  };
}

function decodeJwtPart(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid JWT encoding");
  }
  return Buffer.from(value, "base64url");
}

async function linkProviderIdentity(database: LooseRecord, session: LooseRecord, provider: string, profile: LooseRecord) {
  const subject = normalizeSimulatedText(profile.subject ?? profile.sub);
  const safeProvider = typeof provider === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(provider)
    ? provider
    : "provider";
  const providerName = safeProvider === "google" ? "Google" : safeProvider;
  if (!subject) {
    return {
      ok: false,
      error: {
        message: `${providerName} profile is missing a stable subject.`,
        hint: "Retry sign-in. Sporades requires a verified stable subject claim.",
      },
    };
  }

  return await database.sqlite.withTransaction(async (tx: LooseRecord) => {
    const email = normalizeSimulatedText(profile.email)?.toLowerCase() ?? null;
    let identity = await tx.findAuthIdentityByProviderSubject(provider, subject);
    if (!identity && email && provider === "google") {
      const legacyIdentities = await tx.findLegacyAuthIdentitiesByProviderEmail(provider, email);
      if (legacyIdentities.length > 0 && profile.emailVerified !== true) {
        return {
          ok: false,
          error: {
            code: "AUTH_LEGACY_IDENTITY_UNVERIFIED_EMAIL",
            message: "Google did not verify the email needed to restore this legacy account.",
            hint: "Use a Google account with a verified email address, or sign in with the account's existing authentication method.",
          },
        };
      }
      if (legacyIdentities.length > 1) {
        return {
          ok: false,
          error: {
            code: "AUTH_LEGACY_IDENTITY_AMBIGUOUS",
            message: "Google email matches more than one legacy account.",
            hint: "Sign in with an existing authentication method before linking this Google identity.",
          },
        };
      }
      identity = legacyIdentities[0] ?? null;
    }
    if (identity && !session.auth.isGuest && identity.userId !== session.auth.userId) {
      return {
        ok: false,
        error: {
          code: "AUTH_IDENTITY_CONFLICT",
          message: `${providerName} identity is already linked to another account.`,
          hint: `Sign out before using this ${providerName} identity, or sign in with the account it is already linked to.`,
        },
      };
    }
    const displayName = normalizeSimulatedText(profile.displayName) ?? email ?? `${providerName} user`;
    const auth = {
      userId: identity?.userId ?? session.auth.userId,
      displayName,
      email,
      picture: profile.picture ?? null,
      isAuthenticated: true,
      isGuest: false,
      provider,
    };
    const now = new Date().toISOString();
    if (identity) {
      await tx.updateAuthIdentity({
        id: identity.id,
        subject,
        email,
        displayName: auth.displayName,
        picture: auth.picture,
        updatedAt: now,
      });
    } else {
      await tx.insertAuthIdentity({
        id: randomUUID(),
        userId: auth.userId,
        provider,
        subject,
        email,
        displayName: auth.displayName,
        picture: auth.picture,
        createdAt: now,
        updatedAt: now,
      });
    }
    await tx.linkAuthUser({
      id: auth.userId,
      displayName: auth.displayName,
      email: auth.email,
      picture: auth.picture,
      isAuthenticated: 1,
      isGuest: 0,
      provider,
    });
    if (session.auth.isGuest && identity?.userId && identity.userId !== session.auth.userId) {
      await moveSessionToUserOnAdapter(database, tx, session, auth.userId, provider);
    } else {
      await tx.setAuthSessionProvider(session.token, provider);
      await refreshSessionOnAdapter(tx, session.token);
    }
    return { ok: true, auth };
  });
}

async function linkGoogleAccount(database: LooseRecord, session: LooseRecord, profile: LooseRecord) {
  return await linkProviderIdentity(database, session, "google", profile);
}

function writeRedirect(response: { writeHead: (arg0: number, arg1: { location: any; }) => void; end: () => void; }, location: any) {
  response.writeHead(302, { location });
  response.end();
}

export async function signUpWithEmail(database: LooseRecord, session: LooseRecord, provider: string, credentials: any) {
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

  const normalized: any = normalizeEmailCredentials(credentials);
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
    picture: null as any,
    isAuthenticated: true,
    isGuest: false,
    provider: "email",
  };
  return await database.sqlite.withTransaction(async (tx: LooseRecord) => {
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
    return { ok: true, sessionToken: await rotateSessionOnAdapter(database, tx, session, auth.userId, "email"), auth };
  });
}

export async function signInWithEmail(database: LooseRecord, session: any, credentials: any) {
  if (!database.authConfig.providers.email.enabled) {
    return { ok: false, error: emailAuthDisabledError() };
  }

  const normalized: any = normalizeEmailCredentials(credentials);
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
    provider: "email",
  };
  return await database.sqlite.withTransaction(async (tx: LooseRecord) => ({
    ok: true,
    sessionToken: await rotateSessionOnAdapter(database, tx, session, auth.userId, "email"),
    auth,
  }));
}

function createEmailSignInThrottleState(database: LooseRecord) {
  const existing = database.__emailSignInThrottle;
  if (existing instanceof Map) {
    return existing;
  }
  const next = new Map();
  database.__emailSignInThrottle = next;
  return next;
}

function emailSignInThrottleKeys(email: string, session: LooseRecord) {
  return [`email\0${email}`, `caller\0${callerContextKey(session)}`];
}

function currentEmailSignInThrottleState(database: LooseRecord, email: string, session: LooseRecord) {
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

function recordFailedEmailSignInAttempt(database: LooseRecord, email: string, session: LooseRecord) {
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

function resetEmailSignInAttempts(database: LooseRecord, email: string, session: LooseRecord) {
  const attempts = createEmailSignInThrottleState(database);
  for (const key of emailSignInThrottleKeys(email, session)) {
    attempts.delete(key);
  }
}

function pruneEmailSignInThrottleState(attempts: Map<string, LooseRecord>, now = Date.now()) {
  for (const [key, entry] of attempts) {
    if (!entry || now >= entry.resetAt) {
      attempts.delete(key);
    }
  }
}

function boundEmailSignInThrottleState(attempts: Map<string, LooseRecord>) {
  while (attempts.size > EMAIL_SIGN_IN_THROTTLE_MAX_ENTRIES) {
    let evictionKey: string | null = null;
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

function emailSignInThrottleEvictionPriority(key: string, entry: LooseRecord) {
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

function callerContextKey(session: LooseRecord) {
  return String(session?.token ?? session?.auth?.userId ?? "anonymous");
}

function invalidEmailCredentialsError(options: LooseRecord = {}) {
  return {
    message: "Email or password is incorrect.",
    hint: "Check the credentials and try email sign-in again.",
    ...(options.code ? { code: options.code } : {}),
  };
}

function normalizeEmailCredentials(credentials: { email: any; password: any; name: null; }) {
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

function hashEmailPassword(password: BinaryLike) {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, 64).toString("base64url");
  return { hash, salt };
}

function verifyEmailPassword(password: BinaryLike, salt: BinaryLike, expectedHash: WithImplicitCoercion<string>) {
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

function createAnonymousAuthTables(sqlite: LooseRecord, authConfig: LooseRecord | null = null) {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_auth_users (" +
    "id TEXT PRIMARY KEY, " +
    "createdAt TEXT NOT NULL, " +
    "displayName TEXT NOT NULL, " +
    "email TEXT, " +
    "picture TEXT, " +
    "isAuthenticated INTEGER NOT NULL, " +
    "isGuest INTEGER NOT NULL, " +
    "provider TEXT NOT NULL" +
    ")",
  );
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_auth_sessions (" +
    "token TEXT PRIMARY KEY, " +
    "userId TEXT NOT NULL, " +
    "provider TEXT NOT NULL, " +
    "createdAt TEXT NOT NULL, " +
    "expiresAt TEXT NOT NULL" +
    ")",
  );
  ensureSessionLifecycleColumns(sqlite);
  ensureSessionProvenanceColumn(sqlite);
  createProviderIdentityTables(sqlite);
  if (authConfig?.providers?.email?.enabled) {
    sqlite.exec(
      "CREATE TABLE IF NOT EXISTS sporades_auth_email_credentials (" +
      "email TEXT PRIMARY KEY, " +
      "userId TEXT NOT NULL, " +
      "passwordHash TEXT NOT NULL, " +
      "passwordSalt TEXT NOT NULL, " +
      "createdAt TEXT NOT NULL" +
      ")",
    );
  }
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_auth_oauth_states (" +
    "state TEXT PRIMARY KEY, " +
    "provider TEXT NOT NULL, " +
    "sessionToken TEXT NOT NULL, " +
    "returnTo TEXT NOT NULL, " +
    "redirectUri TEXT NOT NULL, " +
    "createdAt TEXT NOT NULL, " +
    "expiresAt TEXT NOT NULL, " +
    "nonce TEXT, " +
    "pkceVerifier TEXT" +
    ")",
  );
  ensureOAuthStateColumns(sqlite);
}

function ensureOAuthStateColumns(sqlite: LooseRecord) {
  const existing = new Set(sqlite.prepare("PRAGMA table_info(sporades_auth_oauth_states)").all().map((row: LooseRecord) => row.name));
  const columns = [
    ["provider", "TEXT"],
    ["expiresAt", "TEXT"],
    ["nonce", "TEXT"],
    ["pkceVerifier", "TEXT"],
  ];
  for (const [name, type] of columns) {
    if (!existing.has(name)) {
      sqlite.exec(`ALTER TABLE sporades_auth_oauth_states ADD COLUMN ${name} ${type}`);
    }
  }
  sqlite.exec("UPDATE sporades_auth_oauth_states SET provider = 'google' WHERE provider IS NULL");
  sqlite.exec("UPDATE sporades_auth_oauth_states SET expiresAt = createdAt WHERE expiresAt IS NULL");
}

async function ensureLibsqlOAuthStateColumns(sqlite: LooseRecord) {
  const rows = await sqlite.prepare("PRAGMA table_info(sporades_auth_oauth_states)").all();
  const existing = new Set(rows.map((row: LooseRecord) => row.name));
  for (const [name, type] of [["provider", "TEXT"], ["expiresAt", "TEXT"], ["nonce", "TEXT"], ["pkceVerifier", "TEXT"]]) {
    if (!existing.has(name)) {
      await sqlite.exec(`ALTER TABLE sporades_auth_oauth_states ADD COLUMN ${name} ${type}`);
    }
  }
  await sqlite.exec("UPDATE sporades_auth_oauth_states SET provider = 'google' WHERE provider IS NULL");
  await sqlite.exec("UPDATE sporades_auth_oauth_states SET expiresAt = createdAt WHERE expiresAt IS NULL");
}

function createProviderIdentityTables(sqlite: LooseRecord) {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_auth_identities (" +
    "id TEXT PRIMARY KEY, " +
    "userId TEXT NOT NULL, " +
    "provider TEXT NOT NULL, " +
    "subject TEXT NOT NULL, " +
    "email TEXT, " +
    "displayName TEXT, " +
    "picture TEXT, " +
    "createdAt TEXT NOT NULL, " +
    "updatedAt TEXT NOT NULL, " +
    "UNIQUE(provider, subject)" +
    ")",
  );
  sqlite.exec(
    "INSERT INTO sporades_auth_identities " +
    "(id, userId, provider, subject, email, displayName, picture, createdAt, updatedAt) " +
    "SELECT 'legacy:' || id, id, provider, 'legacy:' || id, email, displayName, picture, createdAt, createdAt " +
    "FROM sporades_auth_users u WHERE provider = 'google' AND id != '__privileged__' " +
    "AND NOT EXISTS (SELECT 1 FROM sporades_auth_identities i WHERE i.userId = u.id AND i.provider = u.provider)",
  );
}

async function createUserPreferencesTables(sqlite: LooseRecord) {
  await sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_user_preferences (" +
    "userId TEXT PRIMARY KEY, " +
    "value TEXT NOT NULL, " +
    "updatedAt TEXT NOT NULL" +
    ")",
  );
}

function ensureSessionLifecycleColumns(sqlite: LooseRecord) {
  const columns = sqlite.prepare("PRAGMA table_info(sporades_auth_sessions)").all();
  const hasExpiresAt = columns.some((column: { name: string; }) => column.name === "expiresAt");
  if (!hasExpiresAt) {
    sqlite.exec("ALTER TABLE sporades_auth_sessions ADD COLUMN expiresAt TEXT");
    sqlite
      .prepare("UPDATE sporades_auth_sessions SET expiresAt = ? WHERE expiresAt IS NULL")
      .run(sessionExpiresAt(new Date().toISOString()));
  }
}

function ensureSessionProvenanceColumn(sqlite: LooseRecord) {
  const columns = sqlite.prepare("PRAGMA table_info(sporades_auth_sessions)").all();
  const hasProvider = columns.some((column: { name: string; }) => column.name === "provider");
  if (!hasProvider) {
    sqlite.exec("ALTER TABLE sporades_auth_sessions ADD COLUMN provider TEXT");
  }
  sqlite.exec(
    "UPDATE sporades_auth_sessions SET provider = " +
    "COALESCE(provider, (SELECT provider FROM sporades_auth_users WHERE id = sporades_auth_sessions.userId), 'anonymous') " +
    "WHERE provider IS NULL",
  );
}

async function ensureLibsqlSessionLifecycleColumns(sqlite: { engine?: string; writeSchemaMetadata?: ({ schemaVersion, schemaHash, schemaJson }: { schemaVersion: any; schemaHash: any; schemaJson: any; }) => Promise<void>; ensureLogStorage?: () => Promise<void>; insertLogIndexEvent?: (event: any) => Promise<void>; pruneLogIndex?: (limit: any) => Promise<void>; readRecentLogEvents?: (limit?: number) => Promise<any>; ensureFileStorage?: () => Promise<void>; ensureAuthStorage?: (authConfig?: null) => Promise<void>; consumeOAuthState?: (state: any) => Promise<any>; migrateAppSchema?: (schema: any) => Promise<void>; migrateExistingAppTable?: (existingTable: any, nextTable: any) => Promise<void>; listInspectableTables?: () => Promise<any>; dumpInspectableDatabase?: () => Promise<{ name: any; columns: any; rows: any; }[]>; runReadOnlyInspectionQuery?: (sql: any) => Promise<{ ok: boolean; data: { columns: any; rows: any; }; error: null; } | { ok: boolean; data: null; error: { message: any; hint: string; }; }>; checkHealth?: () => Promise<{ ok: boolean; }>; withTransaction?: (fn: any) => Promise<any>; close?: () => Promise<void>; exec: any; prepare: any; ensureSystemTable?: () => void; readSystemMetadata?: (key: any) => Record<string, SQLOutputValue> | null; writeSystemMetadata?: (key: any, value: any) => StatementResultingChanges; readSchemaMetadata?: () => Record<string, SQLOutputValue> | null; findFileBucket?: (ownerId: any, name: any) => Record<string, SQLOutputValue> | null; createFileBucket?: (row: any) => StatementResultingChanges; insertFileRow?: (row: any) => StatementResultingChanges; updatePendingFileRow?: (row: any) => StatementResultingChanges; insertFileUpload?: (row: any) => StatementResultingChanges; selectFileById?: (fileId: any) => Record<string, SQLOutputValue> | null; selectLiveFileByPath?: (path: any) => Record<string, SQLOutputValue>[]; selectActiveFileByPath?: (path: any) => Record<string, SQLOutputValue>[]; selectPendingFileUploadByPath?: (path: any) => Record<string, SQLOutputValue> | null; selectFileUpload?: (uploadId: any) => Record<string, SQLOutputValue> | null; completeFileUpload?: (upload: any, size: any, updatedAt: any) => StatementResultingChanges | { changes: number; }; deleteFileUploadsForPath?: (path: any) => StatementResultingChanges; deleteFileUploadsForFile?: (ownerId: any, fileId: any) => StatementResultingChanges; deleteFileUpload?: (uploadId: any) => StatementResultingChanges; selectPublicFileRow?: (publicUrlId: any) => Record<string, SQLOutputValue> | null; insertPublicFileUrl?: (row: any) => StatementResultingChanges; revokePublicFileUrl?: (publicUrlId: any, ownerId: any, revokedAt: any) => StatementResultingChanges; revokePublicFileUrlsForFile?: (fileId: any, revokedAt: any) => StatementResultingChanges; markFileDeleted?: (fileId: any, deletedAt: any) => StatementResultingChanges; fileRowForOwner?: (fileId: any, ownerId: any) => Record<string, SQLOutputValue> | null; findAuthUserByProviderEmail?: (provider: any, email: any) => Record<string, SQLOutputValue> | null; insertAuthUser?: (row: any) => StatementResultingChanges; updateAuthUserProfile?: (row: any) => StatementResultingChanges; linkAuthUser?: (row: any) => StatementResultingChanges; insertAuthSession?: (row: any) => StatementResultingChanges; deleteAuthSession?: (token: any) => StatementResultingChanges; refreshAuthSession?: (token: any, expiresAt: any) => StatementResultingChanges; rotateAuthSession?: (previousToken: any, row: any) => StatementResultingChanges; readAuthSessionWithUser?: (token: any) => Record<string, SQLOutputValue> | null; insertOAuthState?: (row: any) => StatementResultingChanges; emailCredentialExists?: (email: any) => boolean; insertEmailCredential?: (row: any) => StatementResultingChanges; findEmailCredentialWithUser?: (email: any) => Record<string, SQLOutputValue> | null; createAppTable?: (table: any, tableName?: any) => any; referenceExists?: (field: any, value: any) => boolean; insertAppRow?: (table: any, row: any) => StatementResultingChanges; selectAppRowById?: (table: any, id: any) => Record<string, SQLOutputValue> | null; updateAppRow?: (table: any, id: any, values: any, options?: {}) => StatementResultingChanges | { changes: number; }; deleteAppRow?: (table: any, id: any) => StatementResultingChanges; selectAppRows?: (table: any, query?: {}) => Record<string, SQLOutputValue>[]; }) {
  const columns = await sqlite.prepare("PRAGMA table_info(sporades_auth_sessions)").all();
  const hasExpiresAt = columns.some((column: { name: string; }) => column.name === "expiresAt");
  if (!hasExpiresAt) {
    await sqlite.exec("ALTER TABLE sporades_auth_sessions ADD COLUMN expiresAt TEXT");
    await sqlite
      .prepare("UPDATE sporades_auth_sessions SET expiresAt = ? WHERE expiresAt IS NULL")
      .run(sessionExpiresAt(new Date().toISOString()));
  }
}

async function ensureLibsqlSessionProvenanceColumn(sqlite: LooseRecord) {
  const columns = await sqlite.prepare("PRAGMA table_info(sporades_auth_sessions)").all();
  if (!columns.some((column: { name: string; }) => column.name === "provider")) {
    await sqlite.exec("ALTER TABLE sporades_auth_sessions ADD COLUMN provider TEXT");
  }
  await sqlite.exec(
    "UPDATE sporades_auth_sessions SET provider = " +
    "COALESCE(provider, (SELECT provider FROM sporades_auth_users WHERE id = sporades_auth_sessions.userId), 'anonymous') " +
    "WHERE provider IS NULL",
  );
}

async function createLibsqlProviderIdentityTables(sqlite: LooseRecord) {
  await sqlite.exec(
    "CREATE TABLE IF NOT EXISTS sporades_auth_identities (" +
    "id TEXT PRIMARY KEY, userId TEXT NOT NULL, provider TEXT NOT NULL, subject TEXT NOT NULL, email TEXT, " +
    "displayName TEXT, picture TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(provider, subject))",
  );
  await sqlite.exec(
    "INSERT INTO sporades_auth_identities " +
    "(id, userId, provider, subject, email, displayName, picture, createdAt, updatedAt) " +
    "SELECT 'legacy:' || id, id, provider, 'legacy:' || id, email, displayName, picture, createdAt, createdAt " +
    "FROM sporades_auth_users u WHERE provider = 'google' AND id != '__privileged__' " +
    "AND NOT EXISTS (SELECT 1 FROM sporades_auth_identities i WHERE i.userId = u.id AND i.provider = u.provider)",
  );
}

function splitSqlStatements(sql: any) {
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

function isExpiredSession(row: { expiresAt: string; }) {
  return Date.parse(row.expiresAt) <= Date.now();
}

function createSessionToken() {
  return randomBytes(32).toString("base64url");
}

async function refreshSession(database: LooseRecord, token: any) {
  return await refreshSessionOnAdapter(database.sqlite, token);
}

async function refreshSessionOnAdapter(sqlite: LooseRecord, token: any) {
  const now = new Date().toISOString();
  const expiresAt = sessionExpiresAt(now);
  await sqlite.refreshAuthSession(token, expiresAt);
  return expiresAt;
}

async function rotateSession(database: LooseRecord, session: LooseRecord, userId: any, provider = session.auth.provider) {
  return await database.sqlite.withTransaction(async (tx: LooseRecord) => rotateSessionOnAdapter(database, tx, session, userId, provider));
}

async function rotateSessionOnAdapter(database: LooseRecord, sqlite: LooseRecord, session: LooseRecord, userId: any, provider = session.auth.provider) {
  const now = new Date().toISOString();
  const token = createSessionToken();
  await migrateAnonymousPreferences(database, session.auth, userId, sqlite);
  await sqlite.rotateAuthSession(session.token, { token, userId, provider, createdAt: now, expiresAt: sessionExpiresAt(now) });
  return token;
}

async function moveSessionToUser(database: LooseRecord, session: LooseRecord, userId: any, provider = session.auth.provider) {
  return await database.sqlite.withTransaction(async (tx: LooseRecord) => moveSessionToUserOnAdapter(database, tx, session, userId, provider));
}

async function moveSessionToUserOnAdapter(database: LooseRecord, sqlite: LooseRecord, session: LooseRecord, userId: any, provider = session.auth.provider) {
  const now = new Date().toISOString();
  await migrateAnonymousPreferences(database, session.auth, userId, sqlite);
  await sqlite.rotateAuthSession(session.token, {
    token: session.token,
    userId,
    provider,
    createdAt: now,
    expiresAt: sessionExpiresAt(now),
  });
}

async function migrateAnonymousPreferences(database: LooseRecord, auth: LooseRecord, targetUserId: any, sqlite: LooseRecord | null = null) {
  if (!auth?.isGuest || auth.userId === targetUserId) {
    return;
  }
  const migrate = async (tx: LooseRecord) => {
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

export async function resolveAnonymousSession(database: LooseRecord, sessionToken: string | null) {
  if (sessionToken) {
    const existing = await database.sqlite.readAuthSessionWithUser(sessionToken);
    if (existing) {
      if (isExpiredSession(existing)) {
        await database.sqlite.deleteAuthSession(sessionToken);
      } else {
        return sessionFromRow(existing);
      }
    }
  }

  const now = new Date().toISOString();
  const userId = randomUUID();
  const token = createSessionToken();
  await database.sqlite.withTransaction(async (tx: LooseRecord) => {
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
    await tx.insertAuthSession({ token, userId, provider: "anonymous", createdAt: now, expiresAt: sessionExpiresAt(now) });
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

function sessionFromRow(row: { token: any; userId: any; displayName: any; email: any; picture: any; isAuthenticated: any; isGuest: any; provider: any; }) {
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

async function readCurrentUserPreferences(database: LooseRecord, auth: LooseRecord) {
  const row = await database.sqlite.readUserPreferences(auth.userId);
  return {
    ok: true,
    data: {
      preferences: row ? JSON.parse(row.value) : {},
    },
    error: null,
  };
}

export async function updateCurrentUserPreferences(database: LooseRecord, auth: LooseRecord, patch: any) {
  try {
    const normalizedPatch = normalizePreferencesPatch(patch);
    const preferences = await database.sqlite.withTransaction(async (tx: LooseRecord) => {
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
  } catch (error: any) {
    if (error?.code === "INVALID_PREFERENCES_PATCH") {
      return { ok: false, data: null, error };
    }
    return {
      ok: false,
      data: null,
      error: createPreferencesError(
        "Preferences update failed.",
        "Retry the preferences update. If this keeps happening, restart the Sporades session.",
        "PREFERENCES_UPDATE_FAILED",
      ),
    };
  }
}

function normalizePreferencesPatch(patch: any) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw createPreferencesError(
      "Preferences updates must be JSON objects.",
      "Pass a plain JSON object to preferences.update().",
      "INVALID_PREFERENCES_PATCH",
    );
  }
  assertJsonCompatible(patch);
  return patch;
}

function createPreferencesError(message: string, hint: string, code: string) {
  return { code, message, hint };
}

function createWebSocketAccept(key: any) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function drainWebSocketFrames(client: LooseRecord, onMessage: (message: any) => void) {
  while (client.buffer.length >= 2) {
    const firstByte = client.buffer[0];
    const secondByte = client.buffer[1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let length = secondByte & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (client.buffer.length < offset + 2) return;
      length = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (client.buffer.length < offset + 8) return;
      length = Number(client.buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    const maskLength = masked ? 4 : 0;
    if (client.buffer.length < offset + maskLength + length) return;

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

function closeWebSocketClient(client: LooseRecord) {
  if (client.closing || client.socket.destroyed) {
    return;
  }
  client.closing = true;
  try {
    client.socket.write(Buffer.from([0x88, 0x00]), () => {
      client.socket.end();
    });
  } catch {
    client.socket.destroy();
  }
}

function encodeWebSocketJson(message: LooseRecord) {
  const payload = Buffer.from(JSON.stringify(message));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendJson(client: LooseRecord, message: LooseRecord) {
  client.socket.write(encodeWebSocketJson(message));
}

function sendJsonWithCompletion(client: LooseRecord, message: LooseRecord, timeoutMs = 250): Promise<LooseRecord> {
  return new Promise((resolve) => {
    let settled = false;
    let backpressured = false;
    const finish = (status: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, backpressured });
    };
    const timer = setTimeout(() => finish("write-timeout"), timeoutMs);
    try {
      backpressured = !client.socket.write(encodeWebSocketJson(message), (error: Error | null | undefined) => finish(error ? "write-failed" : "written"));
    } catch {
      finish("write-failed");
    }
  });
}

export async function runQuery(database: LooseRecord, auth: any, queryName: string): Promise<any> {
  let context;
  try {
    context = await applyContextMiddleware(database, createMutationContext(database, auth), "query");
  } catch (error: any) {
    return {
      rows: null as any,
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
    const columns = ["id", "createdAt", "updatedAt", ...table.fields.map((field: { name: any; }) => field.name)];
    const ownerScoped = table.fields.some((field: { name: string; }) => field.name === "ownerId");
    const rows = (await database.sqlite.selectAppRows(table, {
      columns,
      ownerId: ownerScoped ? context.auth.userId : undefined,
      orderBy: { fieldName: "createdAt", direction: "desc" },
    })).map((row: any) => rowToApiValue(row, table));
    database.rowCache.set(cacheKey, rows);
  }

  const rows = await filterRowsByReadAcl(database, table, database.rowCache.get(cacheKey), context);
  return { rows, error: null };
}

async function runCustomQuery(database: LooseRecord, context: any, queryName: any) {
  const handler = database.queries.find((candidate: { name: any; }) => candidate.name === queryName);
  if (!handler) {
    return null;
  }

  try {
    const queryHandler =
      typeof handler.handler === "function"
        ? handler.handler
        : new Function(`return (${handler.handlerSource});`)();
    const data = await queryHandler(context);
    assertJsonCompatible(data);
    return { data, error: null as any };
  } catch (error: any) {
    if (error?.sporadesAuthDenialLogData) {
      emitAuthDeniedLog(database, { data: error.sporadesAuthDenialLogData });
    }
    return {
      data: null as any,
      error: {
        ...(error?.code ? { code: error.code } : {}),
        message: error?.message || "Query handler failed.",
        hint: error?.hint ?? "Check the Capsule query handler and retry the query.",
      },
    };
  }
}

export async function runMutation(database: LooseRecord, auth: any, mutationName: string, args: any) {
  let context;
  let result;
  try {
    const committed = await (database.adapter ?? database.sqlite).withTransaction(async (transactionAdapter: any) => {
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
  } catch (error: any) {
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

async function runCustomMutation(database: LooseRecord, context: any, mutationName: any, args: any): Promise<any> {
  const handler = database.mutations.find((candidate: { name: any; }) => candidate.name === mutationName);
  if (!handler) {
    return null;
  }

  const mutationHandler =
    typeof handler.handler === "function"
      ? handler.handler
      : new Function(`return (${handler.handlerSource});`)();
  let result;
  try {
    result = await mutationHandler(context, ...args);
  } finally {
    await drainPendingAclWrites(context);
    database.rowCache.clear();
  }
  if (result !== undefined) {
    assertJsonCompatible(result);
  }
  return { ok: true, data: result ?? null, error: null as any };
}

async function runAppMessage(database: LooseRecord, auth: any, messageName: any, data: any, options: LooseRecord = {}) {
  if (!messageName) {
    return {
      data: null as any,
      error: {
        message: "Missing app message type.",
        hint: "Pass an unprefixed message name declared by the Capsule.",
      },
    };
  }

  let context: LooseRecord | undefined;
  try {
    validateAppMessageType(messageName);
  } catch (error: any) {
    return {
      data: null as any,
      error: {
        message: error.message,
        hint: error.hint,
      },
    };
  }

  const handler = database.messages.find((candidate: { name: any; }) => candidate.name === messageName);
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
    const response = await (database.adapter ?? database.sqlite).withTransaction(async (transactionAdapter: any) => {
      const transactionDatabase = createTransactionDatabase(database, transactionAdapter);
      context = await applyContextMiddleware(
        transactionDatabase,
        createMessageContext(transactionDatabase, auth, options.sendAppMessage),
        "message",
      );
      let result;
      try {
        result = await createHandler()(context, data);
      } finally {
        await drainPendingAclWrites(context);
        transactionDatabase.rowCache.clear();
      }
      if (result !== undefined) {
        assertJsonCompatible(result);
      }
      return { data: result ?? null, error: null as any };
    });
    await flushPendingJobEnqueues(context);
    return response;
  } catch (error: any) {
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

function validateAppMessageType(type: any) {
  const value = String(type ?? "");
  const reservedPrefixes = ["app.", "auth.", "query.", "mutation.", "file.", "files.", "runtime.", "upload."];
  const reservedExact = new Set(["error", "refresh"]);
  if (reservedExact.has(value) || reservedPrefixes.some((prefix) => value.startsWith(prefix))) {
    throw commandError(
      `Reserved app message type: ${value}`,
      "Use an unprefixed app message type that does not start with a Sporades platform namespace.",
    );
  }
  if (!value || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)) {
    throw commandError(
      `Invalid app message type: ${value}`,
      "Use an unprefixed app message type containing letters, numbers, underscores, or hyphens.",
    );
  }
}

function isAllAppMessageScope(scope: any) {
  return scope === "all" || scope?.scope === "all";
}

function createMessageContext(database: LooseRecord, auth: any, sendAppMessage: any) {
  const context = createMutationContext(database, auth);
  context.messages = {
    send(appMessage: { type: any; scope: any; data: undefined; }) {
      validateAppMessageType(appMessage?.type);
      if (isAllAppMessageScope(appMessage?.scope)) {
        throw commandError(
          "Client-origin app messages cannot broadcast to all clients.",
          "Use the default current-user scope or an explicit users scope authorized by the message handler.",
        );
      }
      if (appMessage?.data !== undefined) {
        assertJsonCompatible(appMessage.data);
      }
      return sendAppMessage?.(auth, appMessage) ?? 0;
    },
  };
  return context;
}

async function runMutationHook(hookSource: any, event: { name: any; args: any; ctx: any; result?: { ok: boolean; error: { message: any; hint: any; }; } | { ok: boolean; error: null; }; }) {
  const createHook = new Function(`return (${hookSource});`);
  const hook = createHook();
  return await hook(event);
}

async function runMutationHookAndDrainPendingAclWrites(hookSource: any, event: { name: any; args: any; ctx: any; result?: { ok: boolean; error: { message: any; hint: any; }; } | { ok: boolean; error: null; }; }, context: LooseRecord) {
  try {
    return await runMutationHook(hookSource, event);
  } finally {
    await drainPendingAclWrites(context);
  }
}

function createMutationContext(database: LooseRecord, auth: any) {
  const context: LooseRecord = {
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

function createCurrentUserJobApi(database: LooseRecord, contextGetter: () => LooseRecord) {
  return {
    async enqueue(handlerName: any, payload: any, options: LooseRecord = {}) {
      const context = contextGetter();
      const queueDatabase = database.__rootDatabase ?? database;
      const scheduleProvenance = queueDatabase.jobScheduleProvenanceByContext?.get(context);
      const handler = database.jobs?.find((candidate: any) => candidate.name === handlerName);
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
        if (existing) { assertJobScheduleProvenance(existing, scheduleProvenance); return jobState(existing, true); }
        const pending = (context.__jobParentContext ?? context).__pendingJobEnqueues?.find((candidate: any) =>
          candidate.handler === handlerName && candidate.actorUserId === context.auth.userId && candidate.idempotencyKey === idempotencyKey,
        );
        if (pending) { assertJobScheduleProvenance(pending, scheduleProvenance); return jobState(pending, true); }
      }
      const id = crypto.randomUUID();
      const now = queueDatabase.clock.now().toISOString();
      const availableAt = options.availableAt === undefined ? now : new Date(options.availableAt).toISOString();
      if (Number.isNaN(Date.parse(availableAt))) throw jobError("INVALID_JOB_OPTIONS", "Invalid Job availability time.", "Pass an ISO 8601 availableAt value.");
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
      } catch (error: any) {
        if (idempotencyKey) {
          const existing = await queueDatabase.sqlite.prepare("SELECT * FROM sporades_jobs WHERE handler = ? AND actorUserId = ? AND idempotencyKey = ?").get(handlerName, context.auth.userId, idempotencyKey);
          if (existing) { assertJobScheduleProvenance(existing, scheduleProvenance); return jobState(existing, true); }
        }
        throw error;
      }
      scheduleCurrentUserJobWorker(queueDatabase);
      return jobState(await queueDatabase.sqlite.prepare("SELECT * FROM sporades_jobs WHERE id = ?").get(id), true);
    },
    async get(id: any) {
      const context = contextGetter();
      const row = await (database.__rootDatabase ?? database).sqlite.prepare("SELECT * FROM sporades_jobs WHERE id = ? AND actorUserId = ?").get(id, context.auth.userId);
      return row ? jobState(row, true) : null;
    },
    async cancel(id: any) { return await cancelJob(database.__rootDatabase ?? database, contextGetter(), id); },
    async list(options: LooseRecord = {}) {
      const context = contextGetter();
      if (options === null || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => !["limit","cursor","status","handler","createdAfter","createdBefore"].includes(key))) throw jobError("INVALID_JOB_OPTIONS", "Invalid Job list options.", "Pass supported Job list filters only.");
      const limit = options.limit === undefined ? 50 : options.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw jobError("INVALID_JOB_OPTIONS", "Invalid Job list limit.", "Pass a whole-number limit from 1 to 100.");
      const cursor = decodeJobCursor(options.cursor);
      const queueDatabase = database.__rootDatabase ?? database;
      const clauses=["actorUserId = ?"]; const params:any[]=[context.auth.userId]; if(options.status){clauses.push("status = ?");params.push(options.status)} if(options.handler){clauses.push("handler = ?");params.push(options.handler)} if(options.createdAfter){clauses.push("createdAt >= ?");params.push(options.createdAfter)} if(options.createdBefore){clauses.push("createdAt <= ?");params.push(options.createdBefore)} if(cursor){clauses.push("(createdAt > ? OR (createdAt = ? AND id > ?))");params.push(cursor.createdAt,cursor.createdAt,cursor.id)} const rows=await queueDatabase.sqlite.prepare(`SELECT * FROM sporades_jobs WHERE ${clauses.join(" AND ")} ORDER BY createdAt ASC, id ASC LIMIT ?`).all(...params,limit+1);
      const page = rows.slice(0, limit);
      return { jobs: page.map((row: any) => jobSummary(row)), nextCursor: rows.length > limit ? encodeJobCursor(page.at(-1)) : null };
    },
  };
}

function assertJobScheduleProvenance(row: any, expected: any) {
  if (!expected) return;
  if (row?.scheduleName !== expected.scheduleName || row?.scheduledFor !== expected.scheduledFor) {
    throw jobError("JOB_IDEMPOTENCY_CONFLICT", "Scheduled occurrence idempotency conflicts with existing Job provenance.", "Inspect the existing Job and retry after resolving the conflicting internal idempotency key.");
  }
}

function jobError(code: string, message: string, hint: string) {
  const error: any = new Error(message); error.code = code; error.hint = hint; return error;
}

function boundedJobJson(value: any, limit: number, code: string, label: string) {
  let serialized: string;
  try { assertJsonCompatible(value); serialized = JSON.stringify(value); } catch { throw jobError("INVALID_JOB_PAYLOAD", `${label} must be JSON-compatible.`, "Pass plain JSON data without functions, cycles, or live request objects."); }
  if (Buffer.byteLength(serialized, "utf8") > limit) throw jobError(code, `${label} exceeds the ${limit} byte limit.`, "Reduce the serialized JSON value before enqueueing or returning it.");
  return serialized;
}

function jobState(row: any, includeDetail: boolean) {
  const actor = row.actorUserId === privilegedAuthUserId() ? { mode: "privileged-server-role" } : { mode: "current-user", userId: row.actorUserId };
  const enqueuedBy = row.scheduleName ? { mode: "schedule", scheduleName: row.scheduleName, scheduledFor: row.scheduledFor } : { mode: "user", userId: row.enqueuedByUserId };
  const state: any = { id: row.id, handler: row.handler, status: row.status, enqueuedBy, actor, attempts: Number(row.attempts) };
  if (includeDetail && row.result) state.result = JSON.parse(row.result);
  if (includeDetail && row.failure) state.failure = JSON.parse(row.failure);
  if (includeDetail) state.attemptHistory = JSON.parse(row.attemptHistory || "[]");
  if (row.cancelRequestedAt) state.cancelRequestedAt = row.cancelRequestedAt;
  return state;
}

/** Read the bounded operator view of every Job in one adapter snapshot. */
export async function inspectRuntimeJobs(adapter: LooseRecord) {
  const decode = (row: LooseRecord, field: string, value: unknown, fallback: unknown) => {
    if (value === null || value === undefined || value === "") return fallback;
    try { return JSON.parse(String(value)); }
    catch {
      const error: any = jobError("JOB_INSPECTION_INVALID_STATE", "Stored Job state is invalid.", "Repair or remove the malformed Job before retrying inspection.");
      error.jobId = String(row.id); error.field = field; throw error;
    }
  };
  const read = async (tx: LooseRecord) => {
    let rows: LooseRecord[];
    try {
      rows = await tx.prepare("SELECT * FROM sporades_jobs ORDER BY createdAt DESC, id DESC").all();
    } catch (error) {
      const message = String((error as any)?.message ?? error);
      if (/no such table|does not exist|unknown table/i.test(message)) return [];
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
  if (!adapter?.withReadOnlySnapshot) throw jobError("JOB_INSPECTION_READ_ONLY_UNAVAILABLE", "Database adapter does not support read-only Job inspection.", "Upgrade the Sporades runtime and retry inspection.");
  return await adapter.withReadOnlySnapshot(read);
}

/** Read the bounded operator view of every Schedule in one adapter snapshot. */
export async function inspectRuntimeSchedules(adapter: LooseRecord) {
  const read = async (tx: LooseRecord) => {
    let rows: LooseRecord[];
    try {
      rows = await tx.prepare("SELECT * FROM sporades_schedules ORDER BY name ASC").all();
    } catch (error) {
      const message = String((error as any)?.message ?? error);
      if (/no such table|does not exist|unknown table/i.test(message)) return [];
      throw error;
    }
    const summaries = [];
    for (const row of rows) summaries.push(await scheduleSummary(tx, row));
    return summaries;
  };
  if (!adapter?.withReadOnlySnapshot) throw jobError("SCHEDULE_INSPECTION_READ_ONLY_UNAVAILABLE", "Database adapter does not support read-only Schedule inspection.", "Upgrade the Sporades runtime and retry inspection.");
  return await adapter.withReadOnlySnapshot(read);
}

function normalizeJobRetry(value: any) { if (value === undefined) return { maxAttempts: 1, delayMs: 0 }; if (!value || !Number.isInteger(value.maxAttempts) || value.maxAttempts < 1 || value.maxAttempts > 20 || !Number.isInteger(value.delayMs ?? 0) || (value.delayMs ?? 0) < 0) throw jobError("INVALID_JOB_OPTIONS", "Invalid Job retry policy.", "Pass retry.maxAttempts (1-20) and non-negative retry.delayMs."); return { maxAttempts: value.maxAttempts, delayMs: value.delayMs ?? 0 }; }
async function cancelJob(database: LooseRecord, context: any, id: any) { const row = context.__privilegedJobAccess ? await database.sqlite.prepare("SELECT * FROM sporades_jobs WHERE id = ?").get(id) : await database.sqlite.prepare("SELECT * FROM sporades_jobs WHERE id = ? AND actorUserId = ?").get(id, context.auth.userId); if (!row) return null; const now=database.clock.now().toISOString(); if (["queued","delayed"].includes(row.status)) { await database.sqlite.prepare("UPDATE sporades_jobs SET status='cancelled', completedAt=? WHERE id=?").run(now,id); return jobState({...row,status:"cancelled",completedAt:now},true); } if(row.status==="running"){ database.__jobAbortControllers?.get(id)?.abort(); await database.sqlite.prepare("UPDATE sporades_jobs SET cancelRequestedAt=? WHERE id=?").run(now,id); return jobState({...row,cancelRequestedAt:now},true);} throw jobError("INVALID_JOB_STATE","Job cannot be cancelled from its current state.","Only queued, delayed, or running Jobs can be cancelled."); }

function jobSummary(row: any) { return { id: row.id, handler: row.handler, status: row.status, attempts: Number(row.attempts) }; }

function createPrivilegedJobApi(database: LooseRecord, contextGetter: () => LooseRecord) {
  const current = createCurrentUserJobApi(database, contextGetter);
  return {
    async enqueue(handler: any, payload: any, options: any = {}) { assertActivePrivilegedJobAccess(contextGetter); return await current.enqueue(handler, payload, options); },
    async get(id: any) {
      assertActivePrivilegedJobAccess(contextGetter);
      const row = await (database.__rootDatabase ?? database).sqlite.prepare("SELECT * FROM sporades_jobs WHERE id = ?").get(id);
      return row ? jobState(row, true) : null;
    },
    async list(options: LooseRecord = {}) {
      assertActivePrivilegedJobAccess(contextGetter);
      if (options === null || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => !["limit","cursor","status","handler","createdAfter","createdBefore"].includes(key))) throw jobError("INVALID_JOB_OPTIONS", "Invalid Job list options.", "Pass supported Job list filters only.");
      const limit = options.limit === undefined ? 50 : options.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw jobError("INVALID_JOB_OPTIONS", "Invalid Job list limit.", "Pass a whole-number limit from 1 to 100.");
      const cursor = decodeJobCursor(options.cursor);
      const sqlite = (database.__rootDatabase ?? database).sqlite;
      const clauses:string[]=[]; const params:any[]=[]; if(options.status){clauses.push("status = ?");params.push(options.status)} if(options.handler){clauses.push("handler = ?");params.push(options.handler)} if(options.createdAfter){clauses.push("createdAt >= ?");params.push(options.createdAfter)} if(options.createdBefore){clauses.push("createdAt <= ?");params.push(options.createdBefore)} if(cursor){clauses.push("(createdAt > ? OR (createdAt = ? AND id > ?))");params.push(cursor.createdAt,cursor.createdAt,cursor.id)} const rows=await sqlite.prepare(`SELECT * FROM sporades_jobs${clauses.length?` WHERE ${clauses.join(" AND ")}`:""} ORDER BY createdAt ASC, id ASC LIMIT ?`).all(...params,limit+1);
      const page = rows.slice(0, limit);
      return { jobs: page.map((row: any) => jobSummary(row)), nextCursor: rows.length > limit ? encodeJobCursor(page.at(-1)) : null };
    },
    async cancel(id: any) { assertActivePrivilegedJobAccess(contextGetter); return await cancelJob(database.__rootDatabase ?? database, { auth: { userId: privilegedAuthUserId() }, __privilegedJobAccess: true }, id); },
  };
}

function assertActivePrivilegedJobAccess(contextGetter: () => LooseRecord) {
  if (hasPrivilegedDbAccess(contextGetter?.())) return;
  throw jobError("PRIVILEGED_JOB_ACCESS_INACTIVE", "Privileged Job access is no longer active.", "Start a new ctx.privileged.run callback before using privileged Job operations.");
}

function encodeJobCursor(row: any) { return Buffer.from(JSON.stringify({ createdAt: row.createdAt, id: row.id })).toString("base64url"); }
function decodeJobCursor(value: any) {
  if (value === undefined) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (typeof cursor?.createdAt !== "string" || typeof cursor?.id !== "string") throw new Error("invalid");
    return cursor;
  } catch { throw jobError("INVALID_JOB_OPTIONS", "Invalid Job cursor.", "Pass the nextCursor returned by a previous Job list call."); }
}

async function flushPendingJobEnqueues(context: LooseRecord | undefined) {
  if (!context?.__pendingJobEnqueues?.length || context.__pendingJobsFlushed) return;
  context.__pendingJobsFlushed = true;
  const queueDatabase = context.__jobQueueDatabase;
  for (const row of context.__pendingJobEnqueues) {
    await queueDatabase.sqlite.prepare("INSERT INTO sporades_jobs (id, handler, enqueuedByUserId, actorUserId, payload, status, availableAt, attempts, idempotencyKey, createdAt, retryJson, attemptHistory, scheduleName, scheduledFor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(row.id, row.handler, row.enqueuedByUserId, row.actorUserId, row.payload, row.status, row.availableAt, row.attempts, row.idempotencyKey, row.createdAt, row.retryJson, row.attemptHistory, row.scheduleName ?? null, row.scheduledFor ?? null);
  }
  scheduleCurrentUserJobWorker(queueDatabase);
}

function scheduleCurrentUserJobWorker(database: LooseRecord) {
  if (database.__jobWorkerScheduled || database.__jobWorkerRunning) return;
  database.__jobWorkerScheduled = true;
  database.clock.setTimer(async () => {
    database.__jobWorkerScheduled = false;
    await runCurrentUserJobWorker(database);
  }, 0);
}

async function scheduleNextDelayedJob(database: LooseRecord) {
  const row = await database.sqlite.prepare("SELECT availableAt FROM sporades_jobs WHERE status='delayed' ORDER BY availableAt ASC, id ASC LIMIT 1").get();
  if (!row) return;
  if (database.__jobWakeTimer) database.clock.clearTimer(database.__jobWakeTimer);
  database.__jobWakeTimer = database.clock.setTimer(() => { database.__jobWakeTimer = null; scheduleCurrentUserJobWorker(database); }, Math.max(0, Date.parse(row.availableAt) - database.clock.now().getTime()) + 1);
}

async function runCurrentUserJobWorker(database: LooseRecord) {
  if (database.__jobWorkerRunning) return;
  database.__jobWorkerRunning = true;
  try {
    while (true) {
      await database.sqlite.prepare("UPDATE sporades_jobs SET status='queued' WHERE status='delayed' AND availableAt <= ?").run(database.clock.now().toISOString());
      const row = await database.sqlite.prepare("SELECT * FROM sporades_jobs WHERE status = 'queued' AND availableAt <= ? ORDER BY availableAt ASC, id ASC LIMIT 1").get(database.clock.now().toISOString());
      if (!row) { await scheduleNextDelayedJob(database); return; }
      const startedAt = database.clock.now().toISOString();
      const claimed = await database.sqlite.prepare("UPDATE sporades_jobs SET status = 'running', attempts = attempts + 1, startedAt = ?, leaseExpiresAt = ? WHERE id = ? AND status = 'queued'").run(startedAt, new Date(database.clock.now().getTime()+30_000).toISOString(), row.id);
      if (!claimed?.changes) continue;
      const handler = database.jobs?.find((candidate: any) => candidate.name === row.handler);
      database.__jobAbortControllers ??= new Map(); const abortController = new AbortController(); database.__jobAbortControllers.set(row.id, abortController);
      try {
        if (!handler) throw jobError("UNKNOWN_JOB_HANDLER", "Job handler is no longer declared.", "Restore the handler or inspect the retained Job state.");
        let result;
        if (row.actorUserId === privilegedAuthUserId()) {
          const context = createMutationContext(database, { userId: row.enqueuedByUserId, displayName: "Job enqueuer", email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "job" });
          result = await context.privileged.run({ operation: "jobs.execute", targetResourceKind: "job-queue", signal: abortController.signal, metadata: { jobId: row.id, handler: row.handler, attempt: Number(row.attempts) + 1, ...(row.scheduleName ? { scheduleName: String(row.scheduleName), scheduledFor: String(row.scheduledFor) } : {}) } }, (privilegedCtx: any) => handler.handler(privilegedCtx, JSON.parse(row.payload)));
        } else {
          const user = await database.sqlite.prepare("SELECT * FROM sporades_auth_users WHERE id = ?").get(row.actorUserId);
          if (!user) throw jobError("JOB_ACTOR_UNAVAILABLE", "The captured Job actor is unavailable.", "The user no longer exists, so this Job cannot run.");
          const auth = { userId: user.id, displayName: user.displayName, email: user.email, picture: user.picture, isAuthenticated: Boolean(user.isAuthenticated), isGuest: Boolean(user.isGuest), provider: user.provider };
          const context = createMutationContext(database, auth); context.signal = abortController.signal;
          result = await handler.handler(context, JSON.parse(row.payload));
        }
        const resultJson = boundedJobJson(result ?? null, 64 * 1024, "JOB_RESULT_TOO_LARGE", "Job result");
        const completedAt=database.clock.now().toISOString(); const history=JSON.parse(row.attemptHistory||"[]"); history.push({ attempt:Number(row.attempts)+1, startedAt, outcome:"succeeded", completedAt }); await database.sqlite.prepare("UPDATE sporades_jobs SET status = 'succeeded', result = ?, completedAt = ?, attemptHistory = ? WHERE id = ?").run(resultJson, completedAt, JSON.stringify(history), row.id);
      } catch (error: any) {
        const failure = safeJobFailure(error);
        const failedAt=database.clock.now().toISOString(); const history=JSON.parse(row.attemptHistory||"[]"); const retry=JSON.parse(row.retryJson||'{"maxAttempts":1,"delayMs":0}'); const abortError=error?.cause ?? error; const cancelled=abortController.signal.aborted && (abortError?.name === "AbortError" || abortError?.code === "ABORT_ERR"); history.push({attempt:Number(row.attempts)+1,startedAt,outcome:cancelled?"cancelled":"failed",code:failure.code,completedAt:failedAt}); if(cancelled) await database.sqlite.prepare("UPDATE sporades_jobs SET status='cancelled', failure=?, failedAt=?, attemptHistory=? WHERE id=?").run(JSON.stringify(failure),failedAt,JSON.stringify(history),row.id); else if(Number(row.attempts)+1 < retry.maxAttempts){ const availableAt=new Date(database.clock.now().getTime()+retry.delayMs).toISOString(); await database.sqlite.prepare("UPDATE sporades_jobs SET status='delayed', availableAt=?, attemptHistory=? WHERE id=?").run(availableAt,JSON.stringify(history),row.id); database.clock.setTimer(() => scheduleCurrentUserJobWorker(database), retry.delayMs + 1); } else await database.sqlite.prepare("UPDATE sporades_jobs SET status = 'failed', failure = ?, failedAt = ?, attemptHistory=? WHERE id = ?").run(boundedJobJson(failure, 8 * 1024, "JOB_FAILURE_TOO_LARGE", "Job failure metadata"), failedAt,JSON.stringify(history), row.id);
      } finally { database.__jobAbortControllers?.delete(row.id);
      }
    }
  } finally { database.__jobWorkerRunning = false; }
}

function safeJobFailure(error: any) {
  const knownCodes = new Set(["JOB_ACTOR_UNAVAILABLE", "UNKNOWN_JOB_HANDLER", "JOB_RESULT_TOO_LARGE", "INVALID_JOB_PAYLOAD"]);
  const code = knownCodes.has(error?.code) ? error.code : "JOB_FAILED";
  const messages: LooseRecord = {
    JOB_ACTOR_UNAVAILABLE: "The captured Job actor is unavailable.",
    UNKNOWN_JOB_HANDLER: "The Job handler is unavailable.",
    JOB_RESULT_TOO_LARGE: "The Job result exceeded its safe size limit.",
    INVALID_JOB_PAYLOAD: "The Job produced an unsupported result.",
    JOB_FAILED: "Job handler failed.",
  };
  return { code, message: messages[code] };
}

async function drainPendingAclWrites(context: LooseRecord) {
  let firstError: any = null;
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

function createHookErrorResult(error: any) {
  return {
    ok: false,
    error: {
      ...(error?.code ? { code: error.code } : {}),
      message: error?.message || "Mutation hook failed.",
      hint: error?.hint ?? "Check the Capsule mutation hooks and retry the mutation.",
    },
  };
}

async function runInsertMutation(database: LooseRecord, context: LooseRecord, mutationName: any, args: any[]) {
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
  const values: LooseRecord = {
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
      const positionalIndex = table.fields.filter((candidate: { name: string; }) => candidate.name !== "ownerId").indexOf(field);
      if (args[positionalIndex] !== undefined) {
        values[field.name] = await fieldValueForWrite(database, field, args[positionalIndex]);
        continue;
      }
      if (field.defaultValue !== undefined) {
        values[field.name] = await fieldValueForWrite(database, field, field.defaultValue);
      } else {
        values[field.name] = null;
      }
    }
  } catch (error: any) {
    return { ok: false, error: { message: error.message, hint: error.hint } };
  }
  const missingField = table.fields.find((field: { name: string | number; }) => values[field.name] === undefined);
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

async function runUpdateMutation(database: LooseRecord, context: LooseRecord, mutationName: any, args: any[]) {
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
  const ownerScoped = resolved.table.fields.some((field: { name: string; }) => field.name === "ownerId");
  const previousRow =
    (await database.sqlite.selectAppRows(resolved.table, {
      ownerId: ownerScoped ? context.auth.userId : undefined,
      where: { fieldName: "id", value: String(id) },
      limit: 1,
    }))[0] ?? null;
  let nextValue;
  try {
    nextValue = await fieldValueForWrite(database, resolved.field, value);
  } catch (error: any) {
    return { ok: false, error: { message: error.message, hint: error.hint } };
  }

  const write = async () => {
    await database.sqlite.updateAppRow(
      resolved.table,
      id,
      {
        [resolved.field.name]: nextValue,
        updatedAt: now,
      },
      { ownerId: ownerScoped ? context.auth.userId : undefined },
    );
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
  } else {
    await write();
  }
  return { ok: true, error: null };
}

function formatMutationResult(message: LooseRecord, mutationName: any, result: LooseRecord) {
  const formatted: LooseRecord = {
    id: message.id,
    type: "mutation.result",
    data: result.data ?? null,
    error: result.error,
  };
  if (message.mutation) {
    formatted.mutation = mutationName;
  } else if (message.name) {
    formatted.ok = result.ok;
  }
  return formatted;
}

function authStatus(config: LooseRecord, serverEnv: LooseRecord) {
  const authConfig = config.auth ?? { mode: "anonymous" };
  const normalized = normalizeAuthConfig(authConfig);
  const providerOrder = ["anonymous", "email", "google", "microsoft", "apple", "facebook"] as const;
  const runtimeProviders = new Set(["anonymous", "email", "google"]);
  const providers: LooseRecord = {};
  const port = typeof config.dev?.port === "number" ? config.dev.port : typeof config.deploy?.port === "number" ? config.deploy.port : 4000;
  for (const providerName of providerOrder) {
    const provider = normalized.providers[providerName];
    const configured = providerName === "anonymous" || providerName === "email"
      ? true
      : providerName === "apple"
        ? Boolean(provider.clientId && provider.teamId && provider.keyId && provider.privateKeyEnv && serverEnv[provider.privateKeyEnv])
        : Boolean(provider.clientIdEnv && provider.clientSecretEnv && serverEnv[provider.clientIdEnv] && serverEnv[provider.clientSecretEnv]);
    const state: LooseRecord = {
      enabled: provider.enabled,
      configured,
      runtimeAvailable: runtimeProviders.has(providerName),
    };
    if (["google", "microsoft", "facebook"].includes(providerName)) {
      state.clientIdEnv = provider.clientIdEnv;
      state.clientSecretEnv = provider.clientSecretEnv;
    }
    if (providerName === "microsoft") state.tenant = provider.tenant;
    if (providerName === "facebook") state.graphVersion = provider.graphVersion;
    if (providerName === "apple") {
      state.clientId = provider.clientId;
      state.teamId = provider.teamId;
      state.keyId = provider.keyId;
      state.privateKeyEnv = provider.privateKeyEnv;
    }
    if (!["anonymous", "email"].includes(providerName)) {
      state.callbackPath = `/__sporades/auth/${providerName}/callback`;
      if (providerName === "apple") {
        state.callbackUrl = null;
        state.callbackGuidance = "Register this callback path on the Capsule's Hosted HTTPS origin, or use an HTTPS development tunnel.";
      } else {
        state.callbackUrl = port > 0 ? `http://localhost:${port}${state.callbackPath}` : null;
      }
    }
    providers[providerName] = state;
  }
  return {
    mode: normalized.mode,
    providers,
    google: {
      configured: providers.google.configured,
      clientIdEnv: normalized.providers.google.clientIdEnv,
      clientSecretEnv: normalized.providers.google.clientSecretEnv,
    },
  };
}

function normalizeAuthConfig(authConfig: LooseRecord) {
  const providerConfig = authConfig.providers ?? {};
  for (const provider of Object.keys(providerConfig)) {
    if (!["anonymous", "email", "google", "microsoft", "apple", "facebook"].includes(provider)) {
      throw commandError(
        `Unsupported auth provider: ${provider}`,
        "Use supported auth providers: anonymous, email, google, microsoft, apple, facebook.",
      );
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
        ...emptyProviderConfig(),
      },
      google: {
        ...emptyProviderConfig(),
        enabled: googleEnabled,
        clientIdEnv: googleConfig.clientIdEnv ?? legacyGoogle.clientIdEnv ?? null,
        clientSecretEnv: googleConfig.clientSecretEnv ?? legacyGoogle.clientSecretEnv ?? null,
      },
      email: {
        enabled: emailConfig.enabled,
        ...emptyProviderConfig(),
      },
      microsoft: readProviderConfig(providerConfig.microsoft),
      apple: readProviderConfig(providerConfig.apple),
      facebook: readProviderConfig(providerConfig.facebook),
    },
  };
}

function readProviderConfig(config: any) {
  if (config === true) {
    return { enabled: true, ...emptyProviderConfig() };
  }
  if (config === false || config === undefined || config === null) {
    return { enabled: false, ...emptyProviderConfig() };
  }
  return {
    enabled: config.enabled !== false,
    clientIdEnv: config.clientIdEnv ?? null,
    clientSecretEnv: config.clientSecretEnv ?? null,
    clientId: config.clientId ?? null,
    teamId: config.teamId ?? null,
    keyId: config.keyId ?? null,
    privateKeyEnv: config.privateKeyEnv ?? null,
    tenant: config.tenant ?? null,
    graphVersion: config.graphVersion ?? null,
  };
}

function emptyProviderConfig() {
  return { clientIdEnv: null, clientSecretEnv: null, clientId: null, teamId: null, keyId: null, privateKeyEnv: null, tenant: null, graphVersion: null };
}

function authProvidersForClient(authConfig: LooseRecord) {
  const providers: LooseRecord = {};
  for (const [name, provider] of Object.entries(authConfig.providers) as [string, any][]) {
    providers[name] = {
      enabled: provider.enabled,
      configured: provider.configured,
      runtimeAvailable: provider.runtimeAvailable,
    };
  }
  return providers;
}

function resolveTableForQuery(schema: { tables: any[]; }, queryName: any) {
  return schema.tables.find((table: { name: any; }) => table.name === queryName) ?? null;
}

function resolveTableForAddMutation(schema: { tables: any[]; }, mutationName: string) {
  if (!mutationName.startsWith("add") || mutationName.length <= 3) {
    return null;
  }
  const tableName = tableNameForSingular(mutationName.slice(3));
  return schema.tables.find((table: { name: string; }) => table.name === tableName) ?? null;
}

function resolveTableForUpdateMutation(schema: { tables: any[]; }, mutationName: string) {
  const match = mutationName.match(/^update([A-Z][A-Za-z0-9]*?)([A-Z][A-Za-z0-9]*)$/);
  if (!match) {
    return null;
  }
  const table = schema.tables.find((candidate: { name: string; }) => candidate.name === tableNameForSingular(match[1]));
  if (!table) {
    return null;
  }
  const fieldName = `${match[2][0].toLowerCase()}${match[2].slice(1)}`;
  const field = table.fields.find((candidate: { name: string; }) => candidate.name === fieldName);
  return field ? { table, field } : null;
}

function tableNameForSingular(singular: string) {
  return `${singular[0].toLowerCase()}${singular.slice(1)}s`;
}

function rowToApiValue(row: any, table: { fields: any; }) {
  const value = { ...row };
  for (const field of table.fields) {
    if (field.kind === "Boolean") {
      value[field.name] = value[field.name] === null ? null : Boolean(value[field.name]);
    } else if (field.kind === "Json") {
      value[field.name] = value[field.name] === null ? null : JSON.parse(value[field.name]);
    }
    if (field.kind === "Number") {
      value[field.name] = value[field.name] === null ? null : Number(value[field.name]);
    }
  }
  return value;
}

function toSqlNumber(value: unknown, fieldName: any) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw commandError(`Invalid number for field: ${fieldName}`, "Pass a finite JavaScript number for Number() fields.");
  }
  return value;
}

function quoteIdentifier(identifier: any) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}
