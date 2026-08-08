// `createHmac` left this line with the S3 signing path in batch 6: `s3Hmac` was its only remaining
// consumer, and it reaches the builtin through `process.getBuiltinModule` in `file-storage-runtime.ts`
// now (ADR-0042). The rest of this list has been wider than what this file binds since batch 3 —
// tsc elides an unused import, so the generated `dist/` has carried only what is actually called.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { validateMailConfig } from "./mail-config.js";
import { createMailRuntime } from "./mail-runtime.js";
import { sqlWithoutTrailingTerminator, validateReadOnlyInspectionSql } from "./inspection-sql.js";
import { isInternalLogIndexMetadataRow, targetsInternalLogIndexTable } from "./log-index-guard.js";
import { assertJsonCompatible, commandError, invalidReferenceError } from "./runtime-errors.js";
import { PASSWORD_RESET_MAIL_JOB, PASSWORD_RESET_THROTTLE_FIELD, PRIVILEGED_AUTH_USER_ID, assertNotReservedAuthUserId, authIdentityRowUnlessReserved, authIdentityRowsUnlessReserved, authProvidersForClient, authStatus, confirmPasswordReset, createEmailPasswordResetLink, currentEmailSignInThrottleState, emailAuthDisabledError, emitAuthDeniedLog, hashPasswordResetVerifier, isReservedAuthUserId, issuePasswordResetCode, mailNotConfiguredError, oauthProviderAdapter, passwordResetMailBody, privilegedAuthUserId, readEndpointSessionToken, recordFailedEmailSignInAttempt, requireAuth, resolveAnonymousSession, serverAuthError, sessionExpiresAt, setEmailPassword, setOwnEmailPassword, verifyPasswordResetCode, signInWithEmail, signUpWithEmail, 
// Batch 8. `createWebSocketHub` starts an OAuth sign-in, and `openDevDatabase` and
// `sendEmailPasswordResetLink` read the reset-link configuration. Both left this file for
// `auth-runtime.ts` in that batch, once the HTTP layer stopped holding them.
beginOAuthSignIn, resolvePasswordResetConfig, } from "./auth-runtime.js";
import { createUserPreferencesTables, readCurrentUserPreferences, updateCurrentUserPreferences, } from "./user-preferences-runtime.js";
// Batch 8. Eight names, which is what the one function of that domain still in this file
// (`routeEndpoint`), plus `readEndpointBody`, `openDevDatabase` and `createWebSocketHub`, resolve.
// `routeEndpoint` takes the three writers and the failure log; `readEndpointBody` the body reader;
// `openDevDatabase` the body limit and the security policy; and `createWebSocketHub` the security
// policy, the WebSocket origin check and the request-origin resolver.
import { emitHttpFailureLog, readLimitedRequestBody, resolveHttpMaxBodyBytes, resolveOAuthRequestOrigin, resolveRuntimeSecurityPolicy, websocketOriginAllowed, writeEndpointError, writeEndpointResult, } from "./http-runtime.js";
import { chainMaybePromise, isPromiseLike, thenIfPromise } from "./maybe-promise.js";
import { isSensitiveLogKey, logIndexLimit } from "./runtime-log-policy.js";
import { deserializeFieldValue, deserializeRow, normalizeDateValue, serializeFieldValue } from "./stored-value-coding.js";
// Twenty-one names, which is what the three functions of that domain still in this file plus
// `openDevDatabase`, the endpoint table API, the schema extractor and the four mutation and message
// runners resolve. `ACL_HELPER_STATE` and `createTableAclContext` are deliberately not among them:
// both are exported from `acl-runtime.js` for consumers outside this file — the constant probe and
// `test/mail.test.js` — and reach them through the `export *` below rather than through a binding
// here, so importing them would declare a name nothing in this file reads.
import { applyReadAcl, assertActivePrivilegedJobAccess, createPrivilegedAuditEmitter, createPrivilegedAuditEmissionPublicError, createPrivilegedFileApi, createPrivilegedRunAbortError, createPrivilegedRunAuditDetails, createPrivilegedRunPublicError, createPrivilegedScheduleApi, drainPendingAclWrites, emitAclDeniedLog, emitPrivilegedRunAudit, filterRowsByReadAcl, grantPrivilegedDbAccess, isPrivilegedAuditEmissionPublicError, normalizePrivilegedRunSignal, normalizeTableAcl, reindexPrivilegedAuditEventsAfterRollback, revokePrivilegedDbAccess, runTableWriteWithAcl, safePrivilegedAuditErrorCode, } from "./acl-runtime.js";
import { createFileStorageTables, createPendingFileUpload, createPublicFileUrl, createRuntimeFileStorageAdapter, deletePrivateFile, getPrivateFileUrl, revokePublicFileUrl, } from "./file-storage-runtime.js";
import { abortSchedulePayloadFactories, assertJobScheduleProvenance, boundedJobJson, cancelJob, createRuntimeClock, decodeJobCursor, encodeJobCursor, ensureJobStorage, ensureScheduleStorage, finishFailedScheduledOccurrence, jobActorProvider, jobError, jobHandlersFromCapsuleDefinition, jobState, jobSummary, nextScheduleOccurrence, normalizeJobRetry, resolveSchedulePayload, resolveSchedulePayloadFactoryTimeoutMs, runtimeOwnedJobHandlers, safeJobFailure, scheduleDefinitionsFromCapsule, scheduledOccurrenceIdentity, } from "./jobs-runtime.js";
// The read-only inspection gate is a module now, and these are the two names the rest of this file
// reaches into it for: the Database adapters' `runReadOnlyInspectionQuery` opens with the validator
// and hands the engine `sqlWithoutTrailingTerminator(sql)`, and the Postgres `columns()` primitive
// wraps the same stripped text. That is the gate's whole interface to this file.
//
// It used to be four. `skipSqlTrivia` and `readSqlQuotedIdentifier` were the other two, imported
// here because the internal log-index table guard lexes a table reference with the gate's
// tokenizer — a coupling the single file was hiding, which ADR-0041 recorded and left in place. The
// guard is `./log-index-guard.js` now, so those two names have one consumer and it is a module
// whose job is lexing SQL on this path, rather than being reachable from 13,700 lines of unrelated
// domains.
//
// Both modules are re-exported whole, rather than only the names above, because this module is
// still the address the rest of the repository knows: the constant probe in
// `test/server-bundle-module-graph.test.js` derives what it compares from this module's own
// SCREAMING_CASE exports, the walker census and the terminator-spelling guards in
// `test/database-adapter-engine-seam.test.js` resolve the gate's functions through here, and
// `scripts/inspection-lexing-differential.mjs` compares a build against the pre-work base through
// here too — including `targetsInternalLogIndexTable` and `readSqlTableReference`, which stopped
// being entries in `SERVER_RUNTIME_SOURCE_FUNCTIONS` when the guard moved and would otherwise have
// gone quietly "not comparable" there. A narrower re-export would move those guards' subjects out
// of reach and buy nothing: this is a name-resolution convenience, not a second definition.
export * from "./inspection-sql.js";
export * from "./log-index-guard.js";
// The mail domain left this file the same way, as batch 2 (ADR-0041). `createMailRuntime` is the one
// name the rest of this file reaches into it for — `openDevDatabase` builds the Capsule's mail
// runtime with it — where before there were twenty-six, because every helper of the domain had to be
// registered in `SERVER_RUNTIME_SOURCE_FUNCTIONS` to survive into a deployed Capsule. Twenty-one of
// them are private to that module now.
//
// Re-exported whole for the same reason as the two above: this module is still the address the rest
// of the repository knows, and `test/mail.test.js` resolves `buildSmtpMessage`, `createMailTransport`
// and `connectSmtpSocket` through here. Those three used to be found by searching
// `SERVER_RUNTIME_SOURCE_FUNCTIONS` by name, which returns `undefined` the moment a domain stops
// being entries in it — the silent shape this re-export exists to prevent.
//
// `mail-config.js` is re-exported here too, and it is the same domain arriving from the other side.
// `validateMailConfig` has always lived outside this file and was carried into the bundle by being
// listed in the emitted list anyway — the "cheapest thing that works" ADR-0041 opens by describing.
// It travels as carried module text now, with the rest of mail, so the domain has one carrier rather
// than two. The file stays separate from `mail-runtime.ts` because `cli/project-config.ts` validates
// a `sporades.json` with it at build time and must not import an SMTP transport to do so.
export * from "./mail-config.js";
export * from "./mail-runtime.js";
// The auth domain left this file as batch 3 — sessions, the four OAuth providers, password reset,
// the email sign-in throttles and the credential hashing. Forty-seven of its names are imported
// above, which is what the fourteen auth functions still standing in this file need from it; see
// `auth-runtime.ts` for why those fourteen did not travel and which domain blocks each.
//
// Re-exported whole for the reason the four above are, and this batch is the one where that stops
// being a convenience. **Twelve of the domain's names are SCREAMING_CASE constants**, and the
// constant probe in `test/server-bundle-module-graph.test.js` derives what it compares from *this*
// module's SCREAMING_CASE exports — so a narrower re-export would not fail, it would quietly stop
// comparing the email sign-in failure limit, the throttle window, the password-reset TTL bounds and
// the outstanding-code cap between the two bundles. `scripts/inspection-lexing-differential.mjs`
// resolves through here the same way, falling back from the emitted list to this module's exports,
// and goes silently "not comparable" rather than red when a name it wants is missing.
//
// `runtime-errors.js` is not a domain and is re-exported for the same name-resolution reason. It
// holds `commandError`, which every domain calls and none owns; auth is simply the first batch that
// could not move without it.
export * from "./auth-runtime.js";
export * from "./runtime-errors.js";
// The jobs and schedules domain left this file as batch 4 — the Job Queue's storage, cursors, retry
// normalization and inspection, and the Schedule machinery: cron parsing, timezone resolution,
// occurrence calculation and the payload-factory lanes. One module and not two, because they share
// the queue and the occurrence machinery.
//
// **Fifteen of the domain's fifty-one declarations are still in this file.** It was seventeen until
// batch 7, and the reference graph says why for both numbers: `runCurrentUserJobWorker` and
// `enqueueScheduledOccurrence` build a handler context with `createMutationContext`, which is the
// composition point this file retains, and `assertActivePrivilegedJobAccess` reached
// `hasPrivilegedDbAccess`, which is the ACL domain — batch *7*, which this note called batch 6
// before that batch ran. Batch 7 cleared it and `createPrivilegedScheduleApi` with it;
// `createPrivilegedJobApi` did not follow them, because it reaches `createCurrentUserJobApi`, which
// is one of the fifteen. The names imported below are what those fifteen call. See
// `jobs-runtime.ts` for the per-function account.
//
// **`enqueueRuntimeJob` is one of the seventeen, so batch 3's `sendEmailPasswordResetLink` is still
// blocked.** Auth's blocker moved one link down the chain rather than away: `enqueueRuntimeJob`
// reaches `scheduleCurrentUserJobWorker`, which reaches `runCurrentUserJobWorker`, which needs
// `createMutationContext`. Both leave together or neither does.
//
// Re-exported whole for the reason the six above are. `RESERVED_JOB_NAME_PREFIX` makes that
// load-bearing rather than convenient: it is a SCREAMING_CASE export and the constant probe in
// `test/server-bundle-module-graph.test.js` derives what it compares from *this* module's
// SCREAMING_CASE exports, so a narrower re-export would not fail — it would quietly stop comparing
// the reserved job-name prefix between the two bundles. Four more names
// (`createControllableRuntimeClock`, `ensureJobStorage`, `ensureScheduleStorage`,
// `parseScheduleExpression`) are resolved through here by the job, schedule, clock, password-reset
// and Postgres suites.
export * from "./jobs-runtime.js";
// The user-preferences domain left this file as batch 5 — the preference table's schema, the read
// and update path, and the anonymous-to-account merge. Six declarations: three imported above, one
// by `auth-runtime.js`, one exported for the two-bundle skew probe and one private. See
// `user-preferences-runtime.ts` for why the domain is exactly six and not the fifteen identifiers a
// name sweep for `preference` turns up.
//
// **This is the batch that let auth finish.** `migrateAnonymousPreferences` was the only thing
// keeping `rotateSessionOnAdapter` and `moveSessionToUserOnAdapter` — and through them
// `signInWithEmail`, `signUpWithEmail`, `linkProviderIdentity`, `rotateSession` and
// `moveSessionToUser` — in this file after batch 3. All seven are in `auth-runtime.js` now, so the
// three names imported from it above are the only part of that region this file still resolves.
//
// Re-exported whole for the reason the seven above are, and one consumer makes it load-bearing
// rather than convenient: `test/database-adapter.test.js` imports `updateCurrentUserPreferences`
// through this module by name. This domain declares no SCREAMING_CASE constant, so unlike auth and
// jobs it adds nothing to the constant probe — `INVALID_PREFERENCES_PATCH` and
// `PREFERENCES_UPDATE_FAILED` read like constants and are string literals inside two function
// bodies, so no preamble entry left with this batch.
export * from "./user-preferences-runtime.js";
// The file and object storage domain left this file as batch 6 — the local and S3-compatible
// engines, the AWS SigV4 signature that reaches the second of them, the upload lifecycle, the
// private and public File URLs, and the File metadata table's bootstrap and migrations. Fifty-one
// declarations and one type alias; sixteen of the names are imported above, which is what the two
// storage functions still in this file plus the WebSocket hub, the privileged File API, the ACL
// storage helper, the runtime health route and the shared adapter method set need from it.
//
// **Two of the domain's fifty-three declarations are still here**, and the reference graph says
// why: `handleFileHttpRoute` and `sendFileHttpResponse` reach `writeNotFound` and
// `writeJsonHttpResponse`, whose other consumer is `routeRuntimeHealth`. Those are generic HTTP
// response writers owned by the HTTP layer, which is batch 8 — a domain that has not run yet
// rather than the composition core, so batch 8 lifts those two along with the writers. See
// `file-storage-runtime.ts` for the per-function account, including the three functions a name
// sweep collects that turned out to belong to the dialect and the log index instead.
//
// **`maybe-promise.js` is not a domain**, and it is here for the reason `runtime-errors.js` is. It
// holds `isPromiseLike`, `thenIfPromise` and `chainMaybePromise` — the sync/async bridge the
// adapters, the ACL paths, the log index, schema migration, the auth tables and storage all use and
// none owns. Batch 6 is the batch that could not move without them: they were the only thing
// keeping `singleLiveFileRowByPath` and `createFileStorageTables` in this file, and through the
// first, the whole upload lifecycle and both URL paths.
//
// Both are re-exported whole for the reason the eight above are. Neither declares a SCREAMING_CASE
// constant, so unlike auth and jobs this batch adds nothing to the constant probe and removed
// nothing from the bundle preamble — the four that remained there were the privileged-audit trio
// and `ACL_HELPER_STATE`, which batch 7 took with the ACL domain, leaving that preamble empty. What
// makes the re-export load-bearing here is
// `test/database-adapter.test.js`, which imports ten of this domain's names through this module,
// and `test/dev.test.js`, which asserts the generated bundle still declares `localFileStoragePath`
// and `localFileVersionPath` — both of which are private to `file-storage-runtime.js` now and reach
// the bundle as carried module text rather than as emitted-list entries.
export * from "./file-storage-runtime.js";
export * from "./maybe-promise.js";
// Two more modules that are not domains, extracted by batch 7 for the reason `runtime-errors.js`
// and `maybe-promise.js` were extracted: they hold what the ACL and privileged-audit domain's
// reference graph left outside it and no batch on ticket 04's list owns.
//
// `runtime-log-policy.js` holds `isSensitiveLogKey` and `logIndexLimit` — which field names the
// platform log must never write down, and how many events the log index keeps. Both are read by the
// log sink still in this file *and* by the ACL and audit paths that left it: the first held the
// entire ACL denial record and through it all three enforcement entry points, the second held the
// privileged-audit reindex after a rollback.
//
// `stored-value-coding.js` — `stored-row-decoding.js` until batch 9 — holds the Boolean, Json,
// Number and Date columns converted in both directions. It arrived in batch 7 holding only the
// reading half, `deserializeRow` and `deserializeFieldValue`, because `ctx.acl.db.get()` answers
// with the first. Batch 9 brought the writing half to sit beside it: `toSqlLiteral` in
// `database-runtime.ts` renders a Date default through `normalizeDateValue`, so that function had to
// leave this file or the whole adapter domain stayed in it — and taking it without
// `serializeFieldValue`, whose Date branch it *is*, would have split one rule across a module
// boundary. The file was renamed rather than left describing half of what it holds.
//
// Four of its six names are resolved here: the endpoint table API and both mutation paths call the
// two decoders, `createEndpointTableApi` and `fieldValueForWrite` call `serializeFieldValue`, and
// the schema extractor's two date defaults call `normalizeDateValue`.
//
// Both are re-exported whole for the reason the ten above are. Neither declares a SCREAMING_CASE
// constant, so neither adds anything to the constant probe.
export * from "./runtime-log-policy.js";
export * from "./stored-value-coding.js";
// The ACL and privileged-audit domain left this file as batch 7 — table ACL declaration and
// resolution, the read and write enforcement paths, the frozen `ctx.acl` helpers and their bounded
// read state, the ACL denial record, the privileged server role's `ctx.privileged` File and
// Schedule surfaces, and the whole privileged audit event contract. Fifty-nine declarations, of
// which thirty-one are private to that module now; twenty-one of its names are imported above,
// which is what the three functions of the domain still in this file, plus `openDevDatabase`, the
// endpoint table API, the schema extractor and the four mutation and message runners, need from it.
//
// **Three of the domain's sixty-two declarations are still here**, and the reference graph says
// why: `createPrivilegedHandlerContext` reaches `createContextHolder` and `createEndpointDatabaseApi`,
// `createContextPrivilegedApi` is mutually recursive with it, and `createPrivilegedJobApi` reaches
// `createCurrentUserJobApi`. That is the composition core this file retains until ticket 05 — a
// privileged handler context *is* the point where every domain's API is assembled onto one object —
// so these three are batch 4's case rather than batch 5's: no later batch on ticket 04's list
// clears them. See `acl-runtime.ts` for the per-function account, including the one function a name
// sweep collects that turned out to belong to the mutation layer instead.
//
// **All four remaining preamble constants left with this batch.** `PRIVILEGED_AUDIT_SCHEMA`,
// `PRIVILEGED_AUDIT_ACTOR_KINDS`, `PRIVILEGED_AUDIT_OUTCOMES` and `ACL_HELPER_STATE` are
// declarations inside `acl-runtime.js` now, and they had to leave `runtimeConstants` in the same
// commit or each name would be declared twice at the top level of the emitted ES module. The
// bundle preamble serializes nothing at all as of this batch.
//
// Re-exported whole for the reason the ten above are, and this batch has three consumers that make
// it load-bearing rather than convenient: the constant probe in
// `test/server-bundle-module-graph.test.js` derives what it compares from *this* module's
// SCREAMING_CASE exports, so a narrower re-export would quietly stop comparing the audit schema,
// the actor kinds, the outcomes and the helper-state Symbol between the two bundles;
// `src/cli/sporades.ts` and `src/cli/sporades-host-helper.ts` build a privileged audit event with
// `createPrivilegedAuditLogInput` through here; and `test/database-adapter.test.js` and
// `test/mail.test.js` resolve `emitPrivilegedAuditEvent` and `createTableAclContext` through here.
export * from "./acl-runtime.js";
// The HTTP and security policy domain left this file as batch 8 — the CORS and CSP posture every
// response carries, the origin and host-header validation behind it, the request body reader and
// its size limit, the generic response writers, and the health and File routes. Thirty-two
// declarations and two type aliases, of which fifteen are private to that module now; the eight
// names imported above are what `routeEndpoint`, `readEndpointBody`, `openDevDatabase` and
// `createWebSocketHub` still need from it.
//
// **One of the domain's thirty-three declarations is still here.** `routeEndpoint` reaches
// `runEndpoint`, and `runEndpoint` reaches `createMutationContext`, `createContextHolder` and
// `createEndpointDatabaseApi` — the composition core this file retains until ticket 05. That is
// batch 4's case rather than batch 5's, so batch 9 does not clear it. The three response writers it
// calls (`writeEndpointResult`, `writeEndpointError`, `emitHttpFailureLog`) moved anyway and are
// imported back, which is the same trade batch 6 made in the other direction when `writeNotFound`
// kept `handleFileHttpRoute` here.
//
// **The six auth functions batch 3 left behind are freed by this batch**, which makes them batch
// 5's case rather than batch 4's: a blocker that named a later batch, and that batch cleared it.
// Five are riders in `auth-runtime.ts` now and `resolveOAuthRequestOrigin` is in `http-runtime.ts`,
// because its body validates a request origin against the CORS policy and reaches no auth name.
// `sendEmailPasswordResetLink` is still here and is still not waiting on a batch: it reaches
// `enqueueRuntimeJob`, which needs the composition core.
//
// Re-exported whole for the reason the thirteen above are. Two consumers make it load-bearing:
// `src/cli/sporades.ts` and the generated bundle's boot program resolve `prepareHttpSecurity`,
// `readJsonRequest`, `writeUnhandledHttpError`, `injectPageConnectionToken`, `routeRuntimeHealth`
// and `handleFileHttpRoute` through here, and `test/host.test.js`, `test/database-adapter.test.js`
// and `test/oauth-provider.test.js` resolve `prepareHttpSecurity`, `routeRuntimeHealth`,
// `checkRuntimeSqlite` and `resolveOAuthRequestOrigin` through here.
export * from "./http-runtime.js";
export const SERVER_RUNTIME_SOURCE_FUNCTIONS = [
    // The mail domain's twenty-seven entries stood here until batch 2 moved it to `mail-runtime.ts`
    // and `mail-config.ts`. They are carried into the emitted-list bundle as those modules' own
    // compiled text now (ADR-0041), so listing any of them again would declare the same top-level
    // function twice in an ES module — a load-time `SyntaxError` rather than a subtle drift, which is
    // why none is left behind here.
    normalizeJourneyPolicy,
    normalizeJourneyState,
    validateJourneyJson,
    journeyError,
    createDatabaseDialect,
    quoteSqlIdentifiers,
    sqliteDatabaseDialect,
    postgresDatabaseDialect,
    createDatabaseNormalization,
    sqliteRowNormalization,
    postgresRowNormalization,
    libsqlRowNormalization,
    createSharedDatabaseAdapterMethods,
    createSqliteDatabaseAdapter,
    createLibsqlDatabaseAdapter,
    createPostgresDatabaseAdapter,
    createRuntimeDatabaseAdapter,
    resolveJourneySessionInactivityMinutes,
    claimScheduledOccurrence,
    recoverPendingScheduleOccurrences,
    schedulePendingOccurrenceRecovery,
    reconcileSchedules,
    startStaticSchedules,
    recordScheduledOccurrence,
    enqueueScheduledOccurrence,
    createRuntimeInspectionAdapter,
    createCurrentUserJobApi,
    createPrivilegedJobApi,
    flushPendingJobEnqueues,
    scheduleCurrentUserJobWorker,
    scheduleNextDelayedJob,
    runCurrentUserJobWorker,
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
    libsqlPipelineUrl,
    assertLibsqlOpen,
    libsqlHasMultipleStatements,
    libsqlExecute,
    libsqlDescribe,
    libsqlPipeline,
    libsqlRowsFromResult,
    libsqlValueFromJs,
    libsqlValueToJs,
    splitSqlStatements,
    openDevDatabase,
    recoverExpiredJobLeases,
    enqueueRuntimeJob,
    createRuntimeLogSink,
    requirePathModule,
    createRuntimeLogger,
    createContextPrivilegedApi,
    createPrivilegedHandlerContext,
    createLogEnvelope,
    sanitizeLogData,
    redactLogData,
    logDataContainsServerEnvValue,
    isSensitiveLogString,
    // `isSensitiveLogKey` stood here until batch 7 moved it to `runtime-log-policy.ts`, and
    // `logIndexLimit` eleven entries below it. Both are declarations inside a carried module now, so
    // listing either again would declare the same top-level function twice in the emitted ES module —
    // a load-time `SyntaxError` rather than a drift.
    capLogEnvelope,
    formatLogIndexSequence,
    nextLogIndexSequence,
    backfilledLogIndexSequence,
    createLogIndexTables,
    backfillLogIndexSequences,
    insertLogIndexEvent,
    pruneLogIndex,
    readRecentLogEvents,
    readJsonlLogEvents,
    logPayloadMaxBytes,
    logRedactedValue,
    // The read-only inspection validator and its tokenizer used to occupy twenty-three entries here,
    // between `logRedactedValue` and `extractSchema`, and the internal log-index table guard four more
    // right after them. Both are modules now — `./inspection-sql.js` and `./log-index-guard.js` — and
    // reach the generated Capsule bundle as those modules' own text rather than one function at a time
    // (see `createServerBundleSource` and ADR-0041). Listing any of them here as well would declare
    // each name twice in the emitted bundle, which is a `SyntaxError` rather than a subtle problem.
    //
    // Nothing is left of the log-index guard here. `readSqlIdentifier` is a private helper of that
    // module now, which is a thing this list could not express: a function reached the bundle as its
    // own source text, so a helper that was not listed here was a `ReferenceError` in a deployed
    // Capsule rather than a compile error.
    extractSchema,
    schemaFromCapsuleDefinition,
    schemaTableFromCapsuleTable,
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
    migrateAppSchemaInTransaction,
    normalizeSchema,
    hashSchema,
    assertValidReferenceTargets,
    assertAdditiveSchemaMigration,
    migrateExistingAppTableInTransaction,
    columnSelectExpressionForMigration,
    addedFieldsForTable,
    createAppTable,
    appTableColumnDefinitions,
    appFieldColumnDefinition,
    fieldDefaultIsSqlNull,
    fieldColumnDefaultSql,
    // `commandError` stood here until batch 3 moved it to `runtime-errors.ts`. It is a declaration
    // inside a carried module now, so listing it again would declare the same top-level function
    // twice in the emitted ES module — a load-time `SyntaxError` rather than a drift.
    toSqlLiteral,
    findMatchingParen,
    createTransactionDatabase,
    readEndpointRequest,
    createEndpointContext,
    createContextHolder,
    applyContextMiddleware,
    runContextMiddleware,
    endpointQueryFromUrl,
    createEndpointDatabaseApi,
    createEndpointTableApi,
    // The ACL and privileged-audit domain occupied fifty-five entries in this list until batch 7 —
    // twenty-seven of them here, from `runTableWriteWithAcl` through `createAclDeniedError`, and the
    // rest in four other runs: the privileged audit region above `createLogEnvelope`, the table ACL
    // normalizer among the schema extractors, the privileged-access WeakSet after
    // `endpointQueryFromUrl`, and `assertActivePrivilegedJobAccess` and `drainPendingAclWrites` down
    // among the mutation runners. All fifty-five are declarations inside `./acl-runtime.js` now and
    // reach the generated Capsule bundle as that module's own text, so listing any of them again
    // would declare the same top-level function twice in an ES module — a load-time `SyntaxError`
    // rather than a drift.
    //
    // Three entries the sweep for that domain would collect are still here — `createContextHolder`
    // and `createEndpointDatabaseApi` above, and `createEndpointContext` — because they are the
    // composition core rather than the domain; see the note above `export * from "./acl-runtime.js"`.
    //
    // A comment stood here naming `markAsyncAclHelperRead` and `resolveAclStorageFileReference` as
    // entries that had to be in this list or every ACL rule consulting `ctx.acl` threw. Both are
    // private declarations inside that module now, registered in nothing, which is the thing this
    // list could not express.
    fieldValueForWrite,
    referenceExists,
    // Six entries stood in this run until batch 9. `deserializeFieldValue` and `deserializeRow` left
    // first, in batch 7, for `stored-row-decoding.ts`; batch 9 took the writing half after them —
    // `serializeFieldValue`, `normalizeDateValue` and, private now, `toSqlNumber` and `dateValueError`
    // — and renamed that module `stored-value-coding.ts` for holding both directions.
    // `invalidReferenceError` went to `runtime-errors.ts` in the same batch, because its two callers
    // sit on opposite sides of the adapter boundary. All are declarations inside carried modules now,
    // so listing any of them again would declare the same top-level function twice in the emitted ES
    // module — a load-time `SyntaxError` rather than a drift.
    readEndpointBody,
    createEndpointLogger,
    isDuplicateColumnError,
    runSchemaExecIgnoringDuplicateColumn,
    chainSchemaOperation,
    createAnonymousAuthTables,
    createProviderIdentityTables,
    ensureOAuthStateColumns,
    ensureSessionLifecycleColumns,
    ensureSessionProvenanceColumn,
    // The trusted server-only credential write. `setOwnEmailPassword` and both `ctx.serverAuth`
    // surfaces call it, and each of those calls sits behind its own ownership or privilege gate, so
    // the missing definition failed the change only after the caller had already authorised it.
    sendEmailPasswordResetLink,
    createWebSocketAccept,
    createWebSocketHub,
    drainWebSocketFrames,
    closeWebSocketClient,
    encodeWebSocketJson,
    sendJson,
    sendJsonWithCompletion,
    routeEndpoint,
    runEndpoint,
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
    quoteIdentifier,
];
export async function openDevDatabase(databasePath, serverSource, serverEnv = {}, config = {}, capsuleDefinition = null, options = {}) {
    const path = await import("node:path");
    const mailConfig = validateMailConfig(config.mail);
    let mailLogSink;
    const mail = createMailRuntime(mailConfig, serverEnv, {
        ...options,
        mailLog: options.mailLog ?? ((event) => mailLogSink?.emit(event)),
    });
    const schedulePayloadFactoryTimeoutMs = resolveSchedulePayloadFactoryTimeoutMs(config);
    const journeySessionInactivityMinutes = resolveJourneySessionInactivityMinutes(config);
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
    const endpoints = capsuleDefinition
        ? endpointHandlersFromCapsuleDefinition(capsuleDefinition)
        : extractEndpoints(serverSource);
    const queries = extractQueryHandlersFromCapsule(capsuleDefinition) ?? extractQueryHandlers(serverSource);
    const mutations = (capsuleDefinition
        ? mutationHandlersFromCapsuleDefinition(serverSource, capsuleDefinition)
        : extractMutationHandlers(serverSource));
    const messages = extractMessageHandlers(serverSource);
    const jobs = [...jobHandlersFromCapsuleDefinition(capsuleDefinition), ...runtimeOwnedJobHandlers()];
    const schedules = scheduleDefinitionsFromCapsule(capsuleDefinition, jobs);
    const clock = createRuntimeClock(options?.clock);
    const contextMiddleware = extractContextMiddleware(serverSource);
    const mutationHooks = extractMutationHooks(serverSource);
    const lifecycleHooks = { init: capsuleDefinition?.hooks?.init, shutdown: capsuleDefinition?.hooks?.shutdown };
    const rowCache = new Map();
    const database = {
        adapter: sqlite,
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
        mail,
        authConfig: authStatus(config, serverEnv),
        passwordResetConfig: resolvePasswordResetConfig(config),
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
            const mailResult = database.mail.close();
            const sqliteResult = database.adapter.close();
            const storageResult = database.fileStorage.close();
            const pending = [mailResult, storageResult, sqliteResult].filter((result) => result && typeof result.then === "function");
            return pending.length > 0 ? Promise.all(pending) : undefined;
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
    database.shutdown = () => {
        if (database.__shutdownPromise)
            return database.__shutdownPromise;
        database.__shutdownPromise = (async () => {
            try {
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
            }
            finally {
                database.__runtimeInitialized = false;
                await database.mail.close();
            }
        })();
        return database.__shutdownPromise;
    };
    database.log = createRuntimeLogSink({
        database: sqlite,
        config,
        serverEnv,
        dataDir: path.dirname(databasePath),
    });
    mailLogSink = database.log;
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
function resolveJourneySessionInactivityMinutes(config = {}) {
    const value = config.journey?.sessionInactivityMinutes;
    if (typeof value !== "number" || !Number.isFinite(value))
        return 30;
    return Math.min(1_440, Math.max(1, Math.round(value)));
}
async function reconcileSchedules(database) {
    const now = database.clock.now();
    const sql = database.adapter.dialect.sql;
    const declaredNames = new Set(database.schedules.map((definition) => definition.name));
    const persisted = await database.adapter.prepare(sql("SELECT * FROM [sporades_schedules]")).all();
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
            await database.adapter.prepare(sql("DELETE FROM [sporades_schedules] WHERE [name]=?")).run(row.name);
    }
    const updateScheduleSql = sql("UPDATE [sporades_schedules] SET [definitionFingerprint]=?, [expression]=?, [effectiveTimezone]=?, " +
        "[missedRunPolicy]=?, [enabled]=?, [nextOccurrence]=? WHERE [name]=?");
    for (const { definition, row, nextOccurrence } of plans) {
        if (row)
            await database.adapter.prepare(updateScheduleSql).run(definition.fingerprint, definition.expression, definition.effectiveTimezone, definition.missedRun, definition.enabled ? 1 : 0, nextOccurrence, definition.name);
        else {
            try {
                await database.adapter.prepare(sql("INSERT INTO [sporades_schedules] ([name], [definitionFingerprint], [expression], [effectiveTimezone], [missedRunPolicy], [enabled], [nextOccurrence]) VALUES (?, ?, ?, ?, ?, ?, ?)")).run(definition.name, definition.fingerprint, definition.expression, definition.effectiveTimezone, definition.missedRun, definition.enabled ? 1 : 0, nextOccurrence);
            }
            catch (error) {
                const concurrent = await database.adapter.prepare(sql("SELECT [name] FROM [sporades_schedules] WHERE [name]=?")).get(definition.name);
                if (!concurrent)
                    throw error;
                await database.adapter.prepare(updateScheduleSql).run(definition.fingerprint, definition.expression, definition.effectiveTimezone, definition.missedRun, definition.enabled ? 1 : 0, nextOccurrence, definition.name);
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
async function recordScheduledOccurrence(database, definition, occurrence) {
    const sql = database.adapter.dialect.sql;
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
    await database.adapter.prepare(sql("UPDATE [sporades_schedule_occurrences] SET [status]=?, [claimToken]=NULL, [claimExpiresAt]=NULL, [jobId]=?, [errorCode]=?, [updatedAt]=? WHERE [id]=? AND [claimToken]=?")).run(state ? "enqueued" : "payload-failed", state?.id ?? null, state ? null : "SCHEDULE_PAYLOAD_FAILED", completedAt, claim.id, claim.token);
    if (database.__scheduleStopped)
        return state;
    const next = nextScheduleOccurrence(definition.fields, occurrence, definition.effectiveTimezone).toISOString();
    definition.nextOccurrence = next;
    await database.adapter.prepare(sql("UPDATE [sporades_schedules] SET [nextOccurrence]=?, [latestScheduledFor]=?, [latestOutcome]=?, [latestJobId]=?, [latestErrorCode]=? WHERE [name]=? AND [enabled]=1")).run(next, occurrence.toISOString(), state ? "enqueued" : "payload-failed", state?.id ?? null, state ? null : "SCHEDULE_PAYLOAD_FAILED", definition.name);
    return state;
}
async function claimScheduledOccurrence(database, definition, occurrence) {
    const scheduledFor = occurrence.toISOString();
    const id = scheduledOccurrenceIdentity(database, definition.name, scheduledFor);
    const token = randomUUID();
    const now = database.clock.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + 30_000).toISOString();
    const sql = database.adapter.dialect.sql;
    try {
        await database.adapter.prepare(sql("INSERT INTO [sporades_schedule_occurrences] ([id], [scheduleName], [scheduledFor], [status], [claimToken], [claimExpiresAt], [createdAt], [updatedAt]) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)")).run(id, definition.name, scheduledFor, token, expiresAt, nowIso, nowIso);
        return { id, token };
    }
    catch (error) {
        const existing = await database.adapter.prepare(sql("SELECT [status], [claimExpiresAt] FROM [sporades_schedule_occurrences] WHERE [id]=?")).get(id);
        if (!existing)
            throw error;
        if (existing.status !== "pending")
            return null;
        if (existing.claimExpiresAt && existing.claimExpiresAt > nowIso) {
            schedulePendingOccurrenceRecovery(database, existing.claimExpiresAt);
            return null;
        }
        const result = await database.adapter.prepare(sql("UPDATE [sporades_schedule_occurrences] SET [claimToken]=?, [claimExpiresAt]=?, [updatedAt]=? WHERE [id]=? AND [status]='pending' AND ([claimExpiresAt] IS NULL OR [claimExpiresAt] <= ?)")).run(token, expiresAt, nowIso, id, nowIso);
        return Number(result.changes) === 1 ? { id, token } : null;
    }
}
async function recoverPendingScheduleOccurrences(database) {
    const sql = database.adapter.dialect.sql;
    const rows = await database.adapter.prepare(sql("SELECT [scheduleName], [scheduledFor] FROM [sporades_schedule_occurrences] WHERE [status]='pending' AND ([claimExpiresAt] IS NULL OR [claimExpiresAt] <= ?) ORDER BY [scheduledFor] ASC, [scheduleName] ASC")).all(database.clock.now().toISOString());
    for (const row of rows) {
        const definition = database.schedules.find((candidate) => candidate.enabled && candidate.name === row.scheduleName);
        if (definition)
            await recordScheduledOccurrence(database, definition, new Date(row.scheduledFor));
    }
    const next = await database.adapter.prepare(sql("SELECT [claimExpiresAt] FROM [sporades_schedule_occurrences] WHERE [status]='pending' AND [claimExpiresAt] IS NOT NULL ORDER BY [claimExpiresAt] ASC LIMIT 1")).get();
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
async function recoverExpiredJobLeases(database) {
    const recoveredAt = database.clock.now();
    const recoveredIso = recoveredAt.toISOString();
    const sql = database.adapter.dialect.sql;
    const rows = await database.adapter.prepare(sql("SELECT * FROM [sporades_jobs] WHERE [status]='running' AND [leaseExpiresAt] IS NOT NULL AND [leaseExpiresAt] <= ? ORDER BY [availableAt] ASC, [id] ASC")).all(recoveredIso);
    for (const row of rows) {
        const retry = JSON.parse(row.retryJson || '{"maxAttempts":1,"delayMs":0}');
        const history = JSON.parse(row.attemptHistory || "[]");
        history.push({ attempt: Number(row.attempts), outcome: "interrupted", code: "JOB_LEASE_EXPIRED", completedAt: recoveredIso });
        if (Number(row.attempts) < retry.maxAttempts) {
            const availableAt = new Date(recoveredAt.getTime() + retry.delayMs).toISOString();
            await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status]='delayed', [availableAt]=?, [leaseExpiresAt]=NULL, [attemptHistory]=? WHERE [id]=?")).run(availableAt, JSON.stringify(history), row.id);
            database.clock.setTimer(() => scheduleCurrentUserJobWorker(database), retry.delayMs + 1);
        }
        else
            await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status]='failed', [failure]=?, [failedAt]=?, [leaseExpiresAt]=NULL, [attemptHistory]=? WHERE [id]=?")).run(JSON.stringify({ code: "JOB_LEASE_EXPIRED", message: "Job lease expired." }), recoveredIso, JSON.stringify(history), row.id);
    }
    if (rows.some((row) => Number(row.attempts) < JSON.parse(row.retryJson || '{"maxAttempts":1}').maxAttempts))
        scheduleCurrentUserJobWorker(database);
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
// The Database adapter engine seam.
//
// A Database engine supplies three things and nothing else: statement primitives, a dialect, and
// row and value normalization. Every behavioural method body comes from
// `createSharedDatabaseAdapterMethods` below, which no engine's adapter owns and none of them has
// to borrow. ADR-0037 records the seam; ADR-0034 records the invariant the shared bodies keep.
//
// The dialect is the closed set of places where the engines genuinely cannot agree on the text of a
// statement. ADR-0034 licenses exactly that category of difference — an override may change the
// statement text a method emits, never the answer the method gives — so expressing those
// differences as dialect entries rather than as replacement method bodies turns the licence into
// something the structure enforces instead of something a reviewer has to check by reading.
//
// Every entry is required. A dialect that omits one fails here, at adapter construction, rather
// than at the first statement that needed it: a new engine cannot half-answer the seam and
// discover the gap in production.
export function createDatabaseDialect(spec) {
    const required = [
        "name",
        "quoteIdentifier",
        "columnType",
        "upsertSql",
        "listTables",
        "describeColumns",
        "addMissingColumn",
    ];
    // `== null` rather than `=== undefined`: an entry explicitly set to null would otherwise pass
    // construction and fail at the first statement that needed it, which is precisely the failure
    // this factory exists to move forward.
    const missing = required.filter((key) => spec[key] == null);
    if (missing.length > 0) {
        throw commandError(`Incomplete Database adapter dialect: ${missing.join(", ")}.`, "A Database engine supplies statement primitives, a dialect and row normalization. Answer every dialect entry.");
    }
    // `sql` is derived from `quoteIdentifier` rather than supplied, for the same reason normalization
    // derives `row` from `columnName` and `value`: an engine that answered the quoting entry and then
    // received statement text that had bypassed it would fold anyway. ADR-0039 records why every
    // identifier goes through it.
    return { ...spec, sql: (statement) => quoteSqlIdentifiers(spec.quoteIdentifier, statement) };
}
// The runtime writes every identifier in its own statement text as `[name]`, and this is where the
// marker becomes the engine's quoting. Postgres folds an unquoted identifier to lower case, so a
// half-quoted codebase asks a `"ownerId"` column for `ownerid` and errors outright; routing the
// whole of a statement's identifiers through the dialect is what stops the two halves disagreeing.
//
// The marker is deliberately not the answer. Writing `"ownerId"` in the statement text would be
// correct on all three engines this runtime speaks and would silently bypass the dialect entry that
// exists for the engine whose quoting differs, which is exactly the bypass this function removes.
//
// It is a substitution rather than a parse. The runtime's statement text is authored here, and no
// Capsule value or inspection query reaches it — parameters are bound, never interpolated — so the
// marker means an identifier wherever it appears and there is no literal for it to hide inside.
// `test/postgres-emitted-sql-quoting.test.js` is what keeps that true.
export function quoteSqlIdentifiers(quoteIdentifier, statement) {
    return String(statement).replace(/\[([A-Za-z_][A-Za-z0-9_]*)\]/g, (_marker, identifier) => quoteIdentifier(identifier));
}
// The third thing an engine supplies: how a result row maps back to the names and values the
// runtime reads. Two entries, both required for the same reason the dialect's are — an engine that
// simply omitted one would answer rows the runtime silently misreads, which is how a missing
// `verifierHash` spelling rejected every valid password Reset code on Postgres.
//
// `columnName` restores the runtime's declared spelling of a result column. `value` coerces a
// single value into the JavaScript the runtime expects. `row` is derived from the two so that no
// engine can apply one and forget the other.
export function createDatabaseNormalization(spec) {
    const missing = ["name", "columnName", "value"].filter((key) => spec[key] == null);
    if (missing.length > 0) {
        throw commandError(`Incomplete Database adapter normalization: ${missing.join(", ")}.`, "A Database engine supplies statement primitives, a dialect and row normalization. Answer every normalization entry.");
    }
    return {
        ...spec,
        row: (raw) => Object.fromEntries(Object.entries(raw).map(([key, value]) => [spec.columnName(key), spec.value(value)])),
    };
}
// SQLite preserves the case it was given and `node:sqlite` already hands back JavaScript values, so
// both entries are the identity. Its statement primitives therefore return rows as the driver
// produced them rather than rebuilding each one to prove a no-op; the identity is declared here so
// it can be read, and paid for nowhere.
export function sqliteRowNormalization() {
    return createDatabaseNormalization({
        name: "sqlite",
        columnName: (name) => name,
        value: (value) => value,
    });
}
export function postgresRowNormalization() {
    return createDatabaseNormalization({
        name: "postgres",
        // The identity, like the other two engines. Postgres folds an unquoted identifier to lower
        // case, and a hand-maintained table of declared spellings used to fold it back — a registry
        // nothing failed for omitting, which is how a missing `verifierHash` entry rejected every valid
        // password Reset code here while presenting an ordinary "invalid code". Because that table was
        // applied per result key with no table provenance, it also renamed a Capsule field literally
        // called `errorcode` or `jobid`. ADR-0039 removed both by quoting every identifier the runtime
        // emits: nothing folds, so there is nothing to restore and no name to collide with.
        columnName: (name) => name,
        // Values are already coerced by the wire parser, which reads each column's type oid from the
        // row description. The row does not carry the oid, so the per-value entry cannot repeat that
        // work and does not need to.
        value: (value) => value,
    });
}
export function libsqlRowNormalization() {
    return createDatabaseNormalization({
        name: "libsql",
        // libSQL preserves declared case, so there is nothing to restore.
        columnName: (name) => name,
        // The pipeline protocol tags every value with its type, and this turns the tagged form back
        // into JavaScript.
        value: libsqlValueToJs,
    });
}
// SQLite's dialect, which libSQL shares because libSQL speaks SQLite's SQL.
export function sqliteDatabaseDialect() {
    return createDatabaseDialect({
        name: "sqlite",
        quoteIdentifier,
        // The declared field type is emitted verbatim. `sqliteType` is what the Capsule schema carries,
        // and an engine whose type names differ maps them here rather than in a copy of every DDL
        // method.
        columnType: (field) => field.sqliteType,
        // Write-or-replace a row identified by its key columns. Table and column names arrive
        // unquoted and are quoted here, so the upsert asks for the columns in the style every other
        // statement names them.
        upsertSql: (table, columns, _conflictColumns) => `INSERT OR REPLACE INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) ` +
            `VALUES (${columns.map(() => "?").join(", ")})`,
        // The catalog. Both entries answer rows carrying a `name`, whatever the engine's catalog calls
        // the column, so the shared inspection methods read one shape.
        listTables: (adapter) => adapter
            .prepare(`SELECT ${quoteIdentifier("name")} FROM ${quoteIdentifier("sqlite_schema")} ` +
            `WHERE ${quoteIdentifier("type")} = 'table' AND ${quoteIdentifier("name")} NOT LIKE 'sqlite_%' ` +
            `ORDER BY ${quoteIdentifier("name")}`)
            .all(),
        describeColumns: (adapter, tableName) => adapter.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all(),
        // Declare a column that an older database may not have. SQLite has no
        // `ADD COLUMN IF NOT EXISTS`, so the ALTER is issued and a duplicate-column error swallowed.
        // Probing `PRAGMA table_info` first would work here and nowhere else, which is exactly why the
        // strategy is a dialect entry rather than a line in a shared body.
        addMissingColumn: (adapter, table, column, type) => runSchemaExecIgnoringDuplicateColumn(adapter, `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${type}`),
    });
}
export function postgresDatabaseDialect() {
    return createDatabaseDialect({
        name: "postgres",
        quoteIdentifier,
        // TEXT, INTEGER and REAL all name real Postgres types, so the mapping is the identity here.
        // That is a fact about Postgres rather than a reason to drop the entry: the seam exists for the
        // engine whose type names do differ, and an identity mapping written down is checkable where an
        // absent one is not.
        columnType: (field) => field.sqliteType,
        // Postgres has no `INSERT OR REPLACE`; the same intent is `ON CONFLICT ... DO UPDATE`, which
        // updates the non-key columns from the row that was offered.
        upsertSql: (table, columns, conflictColumns) => {
            const updated = columns.filter((column) => !conflictColumns.includes(column));
            return (`INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) ` +
                `VALUES (${columns.map(() => "?").join(", ")}) ` +
                `ON CONFLICT (${conflictColumns.map(quoteIdentifier).join(", ")}) DO UPDATE SET ` +
                updated.map((column) => `${quoteIdentifier(column)} = EXCLUDED.${quoteIdentifier(column)}`).join(", "));
        },
        // `sqlite_schema` and `PRAGMA table_info` are SQLite's alone; `information_schema` is the
        // standard catalog. Both answer rows carrying a `name`, which is the shape the shared
        // inspection methods read.
        listTables: (adapter) => adapter
            .prepare(`SELECT ${quoteIdentifier("table_name")} AS ${quoteIdentifier("name")} ` +
            `FROM ${quoteIdentifier("information_schema")}.${quoteIdentifier("tables")} ` +
            `WHERE ${quoteIdentifier("table_schema")} = current_schema() ` +
            `AND ${quoteIdentifier("table_type")} = 'BASE TABLE' ORDER BY ${quoteIdentifier("table_name")}`)
            .all(),
        describeColumns: (adapter, tableName) => adapter
            .prepare(`SELECT ${quoteIdentifier("column_name")} AS ${quoteIdentifier("name")} ` +
            `FROM ${quoteIdentifier("information_schema")}.${quoteIdentifier("columns")} ` +
            `WHERE ${quoteIdentifier("table_schema")} = current_schema() AND ${quoteIdentifier("table_name")} = ? ` +
            `ORDER BY ${quoteIdentifier("ordinal_position")}`)
            .all(tableName),
        // Postgres has `ADD COLUMN IF NOT EXISTS`, and using it is not merely tidier than swallowing a
        // duplicate-column error. A swallowed error on Postgres aborts the enclosing transaction, so
        // every statement after it fails with `current transaction is aborted`. Storage bootstrap runs
        // outside the migration transaction to keep that hazard out of reach; asking the engine not to
        // raise the error in the first place removes it.
        addMissingColumn: (adapter, table, column, type) => adapter.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN IF NOT EXISTS ${quoteIdentifier(column)} ${type}`),
    });
}
// The engine-agnostic Database adapter method set, defined once. Composed into every engine's
// adapter by spreading, so each method is an own enumerable property and the conformance coverage
// gate's enumeration sees the same names on every engine.
export function createSharedDatabaseAdapterMethods(dialect) {
    // Every identifier below is written as `[name]` and quoted through the dialect here. ADR-0039
    // records why: a statement that names a column in a style its table was not created with errors
    // outright on Postgres, and the runtime's own DDL goes through the same call so nothing folds.
    const sql = dialect.sql;
    return {
        ensureSystemTable() {
            return this.exec(sql("CREATE TABLE IF NOT EXISTS [sporades] ([key] TEXT PRIMARY KEY, [value] TEXT NOT NULL)"));
        },
        readSystemMetadata(key) {
            return this.prepare(sql("SELECT [value] FROM [sporades] WHERE [key] = ?")).get(key) ?? null;
        },
        writeSystemMetadata(key, value) {
            return this.prepare(dialect.upsertSql("sporades", ["key", "value"], ["key"])).run(key, value);
        },
        readSchemaMetadata() {
            return this.readSystemMetadata("schema");
        },
        writeSchemaMetadata({ schemaVersion, schemaHash, schemaJson }) {
            // ADR-0034's fourth rule limb: three writes fired and nothing returned leaves the caller no
            // way to know when they landed, and on an asynchronous engine no way to know they landed in
            // this order either. Chained and returned, one definition is correct under both synchronous
            // and asynchronous statement primitives, which is what let the Postgres and libSQL
            // await-shim copies of this method go.
            return chainMaybePromise([
                () => this.writeSystemMetadata("schemaVersion", schemaVersion),
                () => this.writeSystemMetadata("schemaHash", schemaHash),
                () => this.writeSystemMetadata("schema", schemaJson),
            ]);
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
            return this.prepare(sql("SELECT * FROM [sporades_file_buckets] WHERE [ownerId] = ? AND [name] = ?")).get(ownerId, name) ?? null;
        },
        createFileBucket(row) {
            return this.prepare(sql("INSERT INTO [sporades_file_buckets] ([id], [ownerId], [name], [createdAt]) VALUES (?, ?, ?, ?)")).run(row.id, row.ownerId, row.name, row.createdAt);
        },
        insertFileRow(row) {
            return this.prepare(sql("INSERT INTO [sporades_files] " +
                "([id], [ownerId], [bucketId], [bucketName], [path], [name], [type], [size], [version], [status], [createdAt], [updatedAt], [deletedAt]) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)")).run(row.id, row.ownerId, row.bucketId, row.bucketName, row.path, row.name, row.type, row.size, row.version, row.status, row.createdAt, row.updatedAt);
        },
        updatePendingFileRow(row) {
            return this.prepare(sql("UPDATE [sporades_files] SET [bucketId] = ?, [bucketName] = ?, [path] = ?, [name] = ?, [type] = ?, [size] = ?, " +
                "[version] = ?, [status] = ?, [updatedAt] = ?, [deletedAt] = NULL WHERE [id] = ?")).run(row.bucketId, row.bucketName, row.path, row.name, row.type, row.size, row.version, row.status, row.updatedAt, row.id);
        },
        insertFileUpload(row) {
            return this.prepare(sql("INSERT INTO [sporades_file_uploads] " +
                "([id], [fileId], [ownerId], [bucketId], [bucketName], [path], [name], [type], [version], [expectedSize], [createdAt]) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")).run(row.id, row.fileId, row.ownerId, row.bucketId, row.bucketName, row.path, row.name, row.type, row.version, row.expectedSize, row.createdAt);
        },
        selectFileById(fileId) {
            return this.prepare(sql("SELECT * FROM [sporades_files] WHERE [id] = ?")).get(fileId) ?? null;
        },
        selectLiveFileByPath(path) {
            return this.prepare(sql("SELECT * FROM [sporades_files] WHERE [path] = ? AND [deletedAt] IS NULL AND [status] = ?")).all(path, "uploaded");
        },
        selectActiveFileByPath(path) {
            return this.prepare(sql("SELECT * FROM [sporades_files] WHERE [path] = ? AND [deletedAt] IS NULL AND [status] IN (?, ?)")).all(path, "pending", "uploaded");
        },
        selectPendingFileUploadByPath(path) {
            return (this.prepare(sql("SELECT * FROM [sporades_file_uploads] WHERE [path] = ? ORDER BY [createdAt] DESC, [id] DESC LIMIT 1")).get(path) ?? null);
        },
        selectFileUpload(uploadId) {
            return this.prepare(sql("SELECT * FROM [sporades_file_uploads] WHERE [id] = ?")).get(uploadId) ?? null;
        },
        completeFileUpload(upload, size, updatedAt) {
            return thenIfPromise(this.prepare(sql("DELETE FROM [sporades_file_uploads] WHERE [id] = ? AND [fileId] = ? AND [version] = ?")).run(upload.id, upload.fileId, upload.version), (consumed) => {
                if (consumed.changes === 0) {
                    return consumed;
                }
                return thenIfPromise(this.selectFileById(upload.fileId), (existing) => {
                    if (existing) {
                        if (existing.deletedAt !== null && existing.deletedAt !== undefined) {
                            return { changes: 0 };
                        }
                        return this.prepare(sql("UPDATE [sporades_files] SET [bucketId] = ?, [bucketName] = ?, [path] = ?, [name] = ?, [type] = ?, [size] = ?, " +
                            "[version] = ?, [status] = ?, [updatedAt] = ? WHERE [id] = ? AND [deletedAt] IS NULL")).run(upload.bucketId, upload.bucketName, upload.path, upload.name, upload.type, size, upload.version, "uploaded", updatedAt, upload.fileId);
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
                });
            });
        },
        deleteFileUploadsForPath(path) {
            return this.prepare(sql("DELETE FROM [sporades_file_uploads] WHERE [path] = ?")).run(path);
        },
        deleteFileUploadsForFile(ownerId, fileId) {
            return this.prepare(sql("DELETE FROM [sporades_file_uploads] WHERE [ownerId] = ? AND [fileId] = ?")).run(ownerId, fileId);
        },
        deleteFileUpload(uploadId) {
            return this.prepare(sql("DELETE FROM [sporades_file_uploads] WHERE [id] = ?")).run(uploadId);
        },
        selectPublicFileRow(publicUrlId) {
            return (this.prepare(sql("SELECT [p].[id] AS [publicUrlId], [p].[fileId], [p].[version] AS [publicVersion], [p].[expiresAt], [p].[revokedAt], " +
                "[f].[id], [f].[ownerId], [f].[bucketId], [f].[bucketName], [f].[path], [f].[name], [f].[type], [f].[size], " +
                "[f].[version], [f].[status], [f].[createdAt], [f].[updatedAt], [f].[deletedAt] " +
                "FROM [sporades_file_public_urls] [p] JOIN [sporades_files] [f] ON [f].[id] = [p].[fileId] " +
                "WHERE [p].[id] = ?")).get(publicUrlId) ?? null);
        },
        insertPublicFileUrl(row) {
            return this.prepare(sql("INSERT INTO [sporades_file_public_urls] ([id], [fileId], [ownerId], [version], [expiresAt], [createdAt], [revokedAt]) " +
                "VALUES (?, ?, ?, ?, ?, ?, NULL)")).run(row.id, row.fileId, row.ownerId, row.version, row.expiresAt, row.createdAt);
        },
        revokePublicFileUrl(publicUrlId, ownerId, revokedAt) {
            return this.prepare(sql("UPDATE [sporades_file_public_urls] SET [revokedAt] = ? WHERE [id] = ? AND [ownerId] = ? AND [revokedAt] IS NULL")).run(revokedAt, publicUrlId, ownerId);
        },
        revokePublicFileUrlsForFile(fileId, revokedAt) {
            return this.prepare(sql("UPDATE [sporades_file_public_urls] SET [revokedAt] = ? WHERE [fileId] = ? AND [revokedAt] IS NULL")).run(revokedAt, fileId);
        },
        markFileDeleted(fileId, deletedAt) {
            return this.prepare(sql("UPDATE [sporades_files] SET [deletedAt] = ?, [updatedAt] = ? WHERE [id] = ?")).run(deletedAt, deletedAt, fileId);
        },
        fileRowForOwner(fileId, ownerId) {
            return (this.prepare(sql("SELECT * FROM [sporades_files] WHERE [id] = ? AND [ownerId] = ? AND [deletedAt] IS NULL AND [status] = ?")).get(fileId, ownerId, "uploaded") ?? null);
        },
        ensureAuthStorage(authConfig = null) {
            return createAnonymousAuthTables(this, authConfig);
        },
        ensureUserPreferencesStorage() {
            return createUserPreferencesTables(this);
        },
        readUserPreferences(userId) {
            return this.prepare(sql("SELECT [userId], [value], [updatedAt] FROM [sporades_user_preferences] WHERE [userId] = ?")).get(userId) ?? null;
        },
        saveUserPreferences(row) {
            return this.prepare(dialect.upsertSql("sporades_user_preferences", ["userId", "value", "updatedAt"], ["userId"])).run(row.userId, row.value, row.updatedAt);
        },
        findAuthIdentityByProviderSubject(provider, subject) {
            const row = this.prepare(sql("SELECT [id], [userId], [provider], [subject], [email], [displayName], [picture], [createdAt], [updatedAt] " +
                "FROM [sporades_auth_identities] WHERE [provider] = ? AND [subject] = ?")).get(provider, subject) ?? null;
            return authIdentityRowUnlessReserved(row);
        },
        findLegacyAuthIdentitiesByProviderEmail(provider, email) {
            const rows = this.prepare(sql("SELECT [id], [userId], [provider], [subject], [email], [displayName], [picture], [createdAt], [updatedAt] " +
                "FROM [sporades_auth_identities] WHERE [provider] = ? AND [email] = ? AND [subject] LIKE 'legacy:%' " +
                "ORDER BY [createdAt], [id]")).all(provider, email);
            return authIdentityRowsUnlessReserved(rows);
        },
        insertAuthIdentity(row) {
            assertNotReservedAuthUserId(row.userId);
            return this.prepare(sql("INSERT INTO [sporades_auth_identities] " +
                "([id], [userId], [provider], [subject], [email], [displayName], [picture], [createdAt], [updatedAt]) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")).run(row.id, row.userId, row.provider, row.subject, row.email, row.displayName, row.picture, row.createdAt, row.updatedAt);
        },
        updateAuthIdentity(row) {
            return this.prepare(sql("UPDATE [sporades_auth_identities] SET [subject] = ?, [email] = ?, [displayName] = ?, [picture] = ?, " +
                "[updatedAt] = ? WHERE [id] = ?")).run(row.subject, row.email, row.displayName, row.picture, row.updatedAt, row.id);
        },
        insertAuthUser(row) {
            assertNotReservedAuthUserId(row.id);
            return this.prepare(sql("INSERT INTO [sporades_auth_users] " +
                "([id], [createdAt], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider]) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)")).run(row.id, row.createdAt, row.displayName, row.email, row.picture, row.isAuthenticated, row.isGuest, row.provider);
        },
        updateAuthUserProfile(row) {
            assertNotReservedAuthUserId(row.id);
            return this.prepare(sql("UPDATE [sporades_auth_users] SET [displayName] = ?, [picture] = ?, [isAuthenticated] = ?, [isGuest] = ? WHERE [id] = ?")).run(row.displayName, row.picture, row.isAuthenticated, row.isGuest, row.id);
        },
        linkAuthUser(row) {
            assertNotReservedAuthUserId(row.id);
            return this.prepare(sql("UPDATE [sporades_auth_users] SET [displayName] = ?, [email] = ?, [picture] = ?, [isAuthenticated] = ?, " +
                "[isGuest] = ? WHERE [id] = ?")).run(row.displayName, row.email, row.picture, row.isAuthenticated, row.isGuest, row.id);
        },
        insertAuthSession(row) {
            assertNotReservedAuthUserId(row.userId);
            return this.prepare(sql("INSERT INTO [sporades_auth_sessions] ([token], [userId], [provider], [createdAt], [expiresAt]) " +
                "VALUES (?, ?, ?, ?, ?)")).run(row.token, row.userId, row.provider, row.createdAt, row.expiresAt);
        },
        deleteAuthSession(token) {
            return this.prepare(sql("DELETE FROM [sporades_auth_sessions] WHERE [token] = ?")).run(token);
        },
        refreshAuthSession(token, expiresAt) {
            return this.prepare(sql("UPDATE [sporades_auth_sessions] SET [expiresAt] = ? WHERE [token] = ?")).run(expiresAt, token);
        },
        setAuthSessionProvider(token, provider) {
            return this.prepare(sql("UPDATE [sporades_auth_sessions] SET [provider] = ? WHERE [token] = ?")).run(provider, token);
        },
        rotateAuthSession(previousToken, row) {
            assertNotReservedAuthUserId(row.userId);
            return this.prepare(sql("UPDATE [sporades_auth_sessions] SET [token] = ?, [userId] = ?, [provider] = ?, [createdAt] = ?, " +
                "[expiresAt] = ? WHERE [token] = ?")).run(row.token, row.userId, row.provider, row.createdAt, row.expiresAt, previousToken);
        },
        readAuthSessionWithUser(token) {
            return thenIfPromise(this.prepare(sql("SELECT [s].[token], [s].[expiresAt], [u].[id] AS [userId], [u].[displayName], [u].[email], [u].[picture], " +
                "[u].[isAuthenticated], [u].[isGuest], [s].[provider] AS [provider] " +
                "FROM [sporades_auth_sessions] [s] " +
                "JOIN [sporades_auth_users] [u] ON [u].[id] = [s].[userId] " +
                "WHERE [s].[token] = ?")).get(token), (row) => (isReservedAuthUserId(row?.userId) ? null : row ?? null));
        },
        insertOAuthState(row) {
            const provider = row.provider ?? "google";
            const expiresAt = row.expiresAt ?? new Date(Date.parse(row.createdAt) + 10 * 60 * 1000).toISOString();
            return this.prepare(sql("INSERT INTO [sporades_auth_oauth_states] " +
                "([state], [provider], [sessionToken], [returnTo], [redirectUri], [createdAt], [expiresAt], [nonce], [pkceVerifier]) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")).run(row.state, provider, row.sessionToken, row.returnTo, row.redirectUri, row.createdAt, expiresAt, row.nonce ?? null, row.pkceVerifier ?? null);
        },
        // One statement, not a SELECT followed by a DELETE. The two-statement form was correct on
        // SQLite and a race everywhere else: nothing ordered the delete after the read, so on an
        // asynchronous engine the two were in flight together. Both service engines carried their own
        // `DELETE ... RETURNING` copy for exactly that reason, and node:sqlite speaks RETURNING too, so
        // there is one definition and no ordering left to get wrong.
        consumeOAuthState(state) {
            return thenIfPromise(this.prepare(sql("DELETE FROM [sporades_auth_oauth_states] WHERE [state] = ? " +
                "RETURNING [state], [provider], [sessionToken], [returnTo], [redirectUri], [createdAt], [expiresAt], " +
                "[nonce], [pkceVerifier]")).get(state), (row) => row ?? null);
        },
        emailCredentialExists(email) {
            return thenIfPromise(this.prepare(sql("SELECT [email] FROM [sporades_auth_email_credentials] WHERE [email] = ?")).get(email), (row) => Boolean(row));
        },
        insertEmailCredential(row) {
            assertNotReservedAuthUserId(row.userId);
            return this.prepare(sql("INSERT INTO [sporades_auth_email_credentials] ([email], [userId], [passwordHash], [passwordSalt], [createdAt]) " +
                "VALUES (?, ?, ?, ?, ?)")).run(row.email, row.userId, row.passwordHash, row.passwordSalt, row.createdAt);
        },
        updateEmailCredentialPassword(email, passwordHash, passwordSalt) {
            return this.prepare(sql("UPDATE [sporades_auth_email_credentials] SET [passwordHash] = ?, [passwordSalt] = ? WHERE [email] = ?")).run(passwordHash, passwordSalt, email);
        },
        findEmailCredentialWithUser(email) {
            return thenIfPromise(this.prepare(sql("SELECT [c].[email], [c].[userId], [c].[passwordHash], [c].[passwordSalt], [u].[displayName], [u].[picture], " +
                "[u].[isAuthenticated], [u].[isGuest] " +
                "FROM [sporades_auth_email_credentials] [c] " +
                "JOIN [sporades_auth_users] [u] ON [u].[id] = [c].[userId] " +
                "WHERE [c].[email] = ?")).get(email), (row) => (isReservedAuthUserId(row?.userId) ? null : row ?? null));
        },
        deleteAuthSessionsForUser(userId) {
            return this.prepare(sql("DELETE FROM [sporades_auth_sessions] WHERE [userId] = ?")).run(userId);
        },
        insertPasswordResetCode(row) {
            assertNotReservedAuthUserId(row.userId);
            return this.prepare(sql("INSERT INTO [sporades_auth_password_reset_codes] " +
                "([selector], [verifierHash], [email], [userId], [createdAt], [expiresAt]) VALUES (?, ?, ?, ?, ?, ?)")).run(row.selector, row.verifierHash, row.email, row.userId, row.createdAt, row.expiresAt);
        },
        findPasswordResetCode(selector) {
            return this.prepare(sql("SELECT [selector], [verifierHash], [email], [userId], [createdAt], [expiresAt] " +
                "FROM [sporades_auth_password_reset_codes] WHERE [selector] = ?")).get(selector) ?? null;
        },
        countPasswordResetCodesForEmail(email, now) {
            return thenIfPromise(this.prepare(sql("SELECT COUNT(*) AS [count] FROM [sporades_auth_password_reset_codes] " +
                "WHERE [email] = ? AND [expiresAt] > ?")).get(email, now), (row) => Number(row?.count ?? 0));
        },
        deletePasswordResetCodesForUser(userId) {
            return this.prepare(sql("DELETE FROM [sporades_auth_password_reset_codes] WHERE [userId] = ?")).run(userId);
        },
        prunePasswordResetCodes(now) {
            return this.prepare(sql("DELETE FROM [sporades_auth_password_reset_codes] WHERE [expiresAt] <= ?")).run(now);
        },
        // ADR-0026: a schema migration is a multi-write workflow that has to succeed or fail as one
        // unit, so it runs inside the adapter's own transaction primitive rather than emitting BEGIN
        // and COMMIT itself. Doing it with bare statements only worked on a synchronous engine: an
        // unawaited `exec("BEGIN")` leaves the enclosing `try`/`catch` unable to see an asynchronous
        // rejection, and the COMMIT fires before the migration it is meant to enclose has finished.
        migrateAppSchema(schema) {
            return this.withTransaction((transaction) => migrateAppSchemaInTransaction(transaction, schema));
        },
        createAppTable(table, tableName = table.name) {
            return createAppTable(this, table, tableName);
        },
        migrateExistingAppTable(existingTable, nextTable) {
            return this.withTransaction((transaction) => migrateExistingAppTableInTransaction(transaction, existingTable, nextTable));
        },
        referenceExists(field, value) {
            return thenIfPromise(this.prepare(`SELECT 1 FROM ${dialect.quoteIdentifier(field.targetTable)} WHERE ${dialect.quoteIdentifier("id")} = ? LIMIT 1`).get(String(value)), (row) => Boolean(row));
        },
        insertAppRow(table, row) {
            const columns = Object.keys(row);
            return this.prepare(`INSERT INTO ${dialect.quoteIdentifier(table.name)} (${columns
                .map((column) => dialect.quoteIdentifier(column))
                .join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((column) => row[column]));
        },
        selectAppRowById(table, id) {
            return (this.prepare(`SELECT * FROM ${dialect.quoteIdentifier(table.name)} WHERE ${dialect.quoteIdentifier("id")} = ?`).get(String(id)) ?? null);
        },
        updateAppRow(table, id, values, options = {}) {
            const columns = Object.keys(values);
            if (columns.length === 0) {
                return { changes: 0 };
            }
            // The owner-scope predicate is quoted like every other identifier here. Emitted bare it
            // folded to `ownerid` on Postgres against a column `appFieldColumnDefinition` had created as
            // `"ownerId"`, so every owner-scoped update on an app table — the tables Capsule code reaches
            // through `ctx.db` — failed outright with `column "ownerid" does not exist`.
            return this.prepare(`UPDATE ${dialect.quoteIdentifier(table.name)} SET ${columns.map((column) => `${dialect.quoteIdentifier(column)} = ?`).join(", ")} ` +
                `WHERE ${dialect.quoteIdentifier("id")} = ?` +
                (options.ownerId === undefined ? "" : ` AND ${dialect.quoteIdentifier("ownerId")} = ?`)).run(...columns.map((column) => values[column]), String(id), ...(options.ownerId === undefined ? [] : [options.ownerId]));
        },
        deleteAppRow(table, id) {
            return this.prepare(`DELETE FROM ${dialect.quoteIdentifier(table.name)} WHERE ${dialect.quoteIdentifier("id")} = ?`).run(String(id));
        },
        selectAppRows(table, query = {}) {
            const columns = query.columns ?? ["*"];
            const whereClauses = [];
            const params = [];
            if (query.ownerId !== undefined) {
                whereClauses.push(`${dialect.quoteIdentifier("ownerId")} = ?`);
                params.push(query.ownerId);
            }
            if (query.where) {
                whereClauses.push(`${dialect.quoteIdentifier(query.where.fieldName)} = ?`);
                params.push(query.where.value);
            }
            const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(" AND ")}` : "";
            const orderSql = query.orderBy
                ? ` ORDER BY ${dialect.quoteIdentifier(query.orderBy.fieldName)} ${String(query.orderBy.direction).toLowerCase() === "desc" ? "DESC" : "ASC"}`
                : "";
            const limit = Number.isInteger(query.limit) && query.limit >= 0 ? query.limit : null;
            const limitSql = limit === null ? "" : " LIMIT ?";
            return this.prepare(`SELECT ${columns.map((column) => (column === "*" ? "*" : dialect.quoteIdentifier(column))).join(", ")} FROM ${dialect.quoteIdentifier(table.name)}${whereSql}${orderSql}${limitSql}`).all(...(limit === null ? params : [...params, limit]));
        },
        // The three inspection methods below each derive from a statement result, so each resolves it
        // first (ADR-0034). They previously read `.all()` and `.columns()` unresolved and were correct
        // on the asynchronous engines only because each engine shadowed them with an await-shim.
        listInspectableTables() {
            return thenIfPromise(dialect.listTables(this), (rows) => rows
                .map((row) => row.name)
                .filter((name) => name !== "sporades_log_events" && name !== "sporades_schedules" && name !== "sporades_schedule_occurrences"));
        },
        dumpInspectableDatabase() {
            const dumpTable = (tableName) => thenIfPromise(dialect.describeColumns(this, tableName), (columnRows) => thenIfPromise(this.prepare(`SELECT * FROM ${dialect.quoteIdentifier(tableName)}`).all(), (rows) => ({
                name: tableName,
                columns: columnRows.map((column) => column.name),
                rows,
            })));
            // Tables are dumped one after another rather than concurrently, so an asynchronous engine
            // issues the same statement sequence a synchronous one does.
            return thenIfPromise(this.listInspectableTables(), (tableNames) => tableNames.reduce((pending, tableName) => thenIfPromise(pending, (tables) => thenIfPromise(dumpTable(tableName), (table) => [...tables, table])), []));
        },
        runReadOnlyInspectionQuery(sql) {
            const inspectionQueryFailure = (error) => ({
                ok: false,
                data: null,
                error: {
                    message: error?.message,
                    hint: "Check the SQL syntax and table names, then retry the query.",
                },
            });
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
                // The engine is handed the one statement the gate accepted, not the text the human typed.
                // `sqlWithoutTrailingTerminator` stops at the first separator the walk sees, so what
                // reaches `all()` cannot be a multi-statement string unless the walk failed to see the
                // separator at all — and it is the same text `columns()` already embeds, so the two reads
                // stop being able to describe and answer different statements. Left raw, the validator was
                // the only thing between `sporades db query` and Postgres's simple query protocol; this
                // makes a walk defect cost a wrong verdict rather than an executed second statement.
                const statement = this.prepare(sqlWithoutTrailingTerminator(sql));
                const result = thenIfPromise(statement.columns(), (columnMetadata) => thenIfPromise(statement.all(), (allRows) => ({
                    ok: true,
                    data: {
                        columns: columnMetadata.map((column) => column.name),
                        rows: allRows.filter((row) => !isInternalLogIndexMetadataRow(row, sql)),
                    },
                    error: null,
                })));
                // A rejected statement is the asynchronous form of the throw the `catch` below handles, so
                // it has to reach the same failure result rather than escape as an unhandled rejection.
                return isPromiseLike(result) ? result.then((value) => value, inspectionQueryFailure) : result;
            }
            catch (error) {
                return inspectionQueryFailure(error);
            }
        },
        checkHealth() {
            // ADR-0034: the probe's answer is derived from the statement result, so the result has to be
            // resolved before the answer is given. A `try`/`catch` around an unresolved statement cannot
            // see a rejection, so the shared definition used to answer `{ ok: true }` for a connection
            // that had just failed — and escape the rejection as an unhandled one. Both engines carried
            // an await-shim over this; with the rejection handled here they no longer need one.
            try {
                const probe = this.prepare(sql("SELECT 1 AS [ok]")).get();
                return isPromiseLike(probe) ? probe.then(() => ({ ok: true }), () => ({ ok: false })) : { ok: true };
            }
            catch {
                return { ok: false };
            }
        },
    };
}
export async function createSqliteDatabaseAdapter(databasePath, options = {}) {
    const { DatabaseSync } = await import("node:sqlite");
    const path = await import("node:path");
    if (!options.readOnly)
        mkdirSync(path.dirname(String(databasePath)), { recursive: true });
    const connection = new DatabaseSync(databasePath, { readOnly: Boolean(options.readOnly) });
    const dialect = sqliteDatabaseDialect();
    // SQLite is an engine like the others now, not the thing the others borrow from: what it supplies
    // below its own name is a connection, statement primitives and transaction session mechanics.
    const adapter = {
        ...createSharedDatabaseAdapterMethods(dialect),
        engine: "sqlite",
        dialect,
        normalization: sqliteRowNormalization(),
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
    const dialect = postgresDatabaseDialect();
    const normalization = postgresRowNormalization();
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
        ...createSharedDatabaseAdapterMethods(dialect),
        engine: "postgres",
        dialect,
        normalization,
        exec(sql) {
            return query(sql).then(() => undefined);
        },
        prepare(sql) {
            assertOpen();
            return {
                all(...params) {
                    return query(sql, params).then((result) => postgresRowsFromResult(normalization, result));
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
                // Postgres has no way to ask a statement for its result shape without running something,
                // so the statement is wrapped and bounded to no rows. Wrapping is not syntax-transparent,
                // and that is a trap rather than a detail: a trailing `;` becomes a syntax error inside
                // the subquery, and a trailing line comment swallows the closing parenthesis and whatever
                // follows it. Both are legal input that `validateReadOnlyInspectionSql` deliberately
                // admits, and `sporades db query <sql>` is typed by a human, so a semicolon is ordinary.
                // Left unhandled, the same query answers on SQLite and libSQL and fails here — the
                // divergence this feature exists to close, reintroduced by the seam meant to prevent it.
                // Stripping the terminator and any trailing trivia first is what makes the wrap safe.
                //
                // This leaves the inspection path issuing two statements on Postgres where the method
                // override it replaced issued one, and that is a deliberate choice rather than an
                // oversight. Merging them would mean caching a result on the prepared-statement object so
                // that `columns()` and a later `all()` share it — which SQLite's and libSQL's statements do
                // not do, so a statement held across two reads would answer stale rows here and fresh rows
                // there. That is a new per-engine behavioural difference, bought in the feature whose
                // purpose is removing them. The bound makes the trade cheap: measured against a 200k-row
                // table, the `LIMIT 0` probe runs in 0.3ms against the read's 79.5ms, because Postgres
                // plans the statement and stops before materializing a row.
                columns() {
                    return query(`SELECT * FROM (${sqlWithoutTrailingTerminator(sql)}) AS __sporades_columns LIMIT 0`).then((result) => result.fields.map((field) => ({ name: normalization.columnName(field.name) })));
                },
            };
        },
        // No behavioural method body lives here, deliberately (ADR-0037). Eleven used to: the upsert
        // form, the auth and File metadata storage bootstraps, the catalog queries behind the three
        // inspection methods, the app-table DDL, the OAuth state consume, and two await-shims. Each is
        // now either a dialect entry or a corrected shared definition, and ADR-0034 and ADR-0036 record
        // why each existed. `test/database-adapter-engine-seam.test.js` is what stops another appearing.
        //
        // The hazard that made removing them better than maintaining them, rather than merely tidier: a
        // shared body an engine shadows is dormant, not correct. It becomes live the moment the shadow
        // goes, or the moment a new engine composes the set without knowing to shadow it. `ensureLogStorage`
        // is the sharpest illustration — a copy of its bare `CREATE TABLE` here would be a Log index
        // that silently never ran ADR-0036's ordering migration.
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
// `?` placeholders replaced with literals, skipping the ones inside strings and comments.
//
// **This is a second SQL lexer, it is on the read-only inspection path, and it is deliberately not
// collapsed into `skipSqlQuotedOrCommented`.** Recording that here rather than leaving it to be
// rediscovered, because the collapse in the inspection region reads as a completeness claim and
// this is the exception to it:
//
//     runReadOnlyInspectionQuery -> prepare(sqlWithoutTrailingTerminator(sql))
//       all()     -> query(sql, params)      -> client.query(postgresInterpolate(sql, params))
//       columns() -> query(`SELECT * FROM (…) AS … LIMIT 0`) -> the same
//
// So every Postgres inspection query passes through it twice, and it disagrees with the one
// tokenizer on four points: it ends a line comment at LF only where that one ends it at CR too, and
// it knows neither dollar quoting, nor E-strings, nor `[…]`.
//
// It is **not** inert there, and the first draft of this comment claimed it was. `params` is empty
// on the whole inspection path — `prepare(sql).all()` is called with no arguments — so there is
// nothing to substitute, and on almost every admitted statement this copies its input character for
// character. But a `?` sitting inside a form this lexer does not know is not protected by it, and
// `SELECT $$?$$ AS s` is admitted by the gate, is legal Postgres, and dies here with
// `Missing Postgres query parameter.` A corpus without `?` in its alphabet reports this clean, and
// one did.
//
// What that costs is a **false rejection on Postgres only**, and only that. The failure is a throw
// before the wire, so it fails closed: with no parameters this function can return its input
// unchanged or it can throw, and there is no third case in which it silently returns *different*
// text. That is the property the gate actually depends on — the text checked is the text executed —
// and it is asserted rather than argued in
// `test/database-adapter-engine-seam.test.js`. It is also byte-identical to the pre-work base, so
// none of this is new.
//
// Collapsing it would fix that false rejection and would reach well past this ticket to do it. Its
// quoting regime treats `\` as an escape inside every string, which the union dialect does not, so
// routing it through changes what `'a\'b'` means on the *write* path — every ordinary query the
// runtime issues to Postgres, not just inspection. That is a larger behavioural surface than the
// read-only gate and wants its own ticket with its own differential rather than a free ride on
// this one.
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
function postgresRowsFromResult(normalization, result) {
    return result.rows.map((row) => normalization.row(row));
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
    // libSQL speaks SQLite's SQL, so it takes SQLite's dialect. That is a statement about the two
    // engines rather than a borrowing: the dialect is a value both adapters ask for, not an adapter
    // one of them builds and strips for parts.
    const dialect = sqliteDatabaseDialect();
    // Normalization is libSQL's own, though: the pipeline protocol tags every value with its type,
    // where node:sqlite hands back JavaScript directly.
    const normalization = libsqlRowNormalization();
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
                    return libsqlExecute({ endpoint, authToken, transaction, sql, params, close: !transaction }).then((result) => libsqlRowsFromResult(normalization, result));
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
        ...createSharedDatabaseAdapterMethods(dialect),
        ...createOperations(),
        engine: "libsql",
        dialect,
        normalization,
        // No behavioural method body lives here either, for the reasons ADR-0037 records and the
        // Postgres adapter states above. Six used to: the two storage bootstraps, the OAuth state
        // consume, and three await-shims over Log index methods that ADR-0036 corrected in the shared
        // body instead.
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
function libsqlRowsFromResult(normalization, result) {
    const columns = (result.cols ?? []).map((column) => column.name);
    return (result.rows ?? []).map((row) => normalization.row(Array.isArray(row) ? Object.fromEntries(columns.map((column, index) => [column, row[index]])) : row));
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
    privilegedContext.mail = database.mail;
    return privilegedContext;
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
// The Log index's internal ordering field (ADR-0036). It is assigned by the runtime when an event
// is indexed, it is the only thing `readRecentLogEvents` and `pruneLogIndex` order by, and it never
// appears in the log envelope or the JSONL log stream.
//
// The column name is written out at each use rather than lifted into a shared constant, and the
// generator's state hangs off the generator instead of living at module scope. That is not style:
// the generated server bundle is assembled from the source text of the functions in
// `SERVER_RUNTIME_SOURCE_FUNCTIONS`, so a module-level binding one of them closes over does not
// travel with it and becomes a `ReferenceError` the first time a deployed Capsule boots.
// Nanoseconds since the epoch is around 1.76e18 today, so the 20-digit width below reaches the year
// 5138. The width is fixed rather than natural because the values are compared as text: a value
// that grew a digit would sort before every narrower one and silently invert the whole index.
function formatLogIndexSequence(nanosSinceEpoch) {
    return String(nanosSinceEpoch).padStart(20, "0");
}
// Nanoseconds since the epoch, strictly increasing for as long as this process lives.
//
// `Date.now()` alone is not enough: it has millisecond resolution, so events indexed in the same
// burst — the routine case, not the exotic one — would tie, and a tie is exactly the undefined
// order this field exists to remove. `process.hrtime.bigint()` alone is not enough either: its
// origin is arbitrary per process, so two runs of the same Capsule would produce values that do not
// order against each other. So the two clocks are read together, once, and every sequence is that
// wall anchor plus the monotonic delta: ordered within the process, and correctly placed against
// sequences any other run wrote.
//
// The previous value is carried forward and stepped past, which is what makes the field monotonic
// by construction rather than by trusting the platform's clock resolution. `process.hrtime.bigint()`
// is strictly increasing on the platforms Sporades runs on, but "increasing because the call takes
// longer than the tick" is a property of the host rather than of this code, and a rare tie would
// leave the order undefined in precisely the case the conformance specification asserts.
function nextLogIndexSequence() {
    const state = nextLogIndexSequence;
    state.anchor ??= { wallNanos: BigInt(Date.now()) * 1000000n, monotonic: process.hrtime.bigint() };
    const derived = state.anchor.wallNanos + (process.hrtime.bigint() - state.anchor.monotonic);
    const previous = state.previous ?? 0n;
    state.previous = derived > previous ? derived : previous + 1n;
    return formatLogIndexSequence(state.previous);
}
// The sequence a row stored before this field existed is given. Its envelope timestamp is the only
// evidence of when it happened, so it is converted to the same units and the same width as a live
// sequence; that is what lets a backfilled row and a newly indexed one sort against each other
// rather than beside each other. Ties among already-stored rows are historical and unrecoverable,
// so the backfill only has to preserve the order the timestamps do record.
function backfilledLogIndexSequence(timestamp) {
    const parsed = Date.parse(String(timestamp ?? ""));
    return Number.isFinite(parsed) ? BigInt(parsed) * 1000000n : 0n;
}
function createLogIndexTables(sqlite) {
    // Kept outside any transaction by its caller. The ALTER below tolerates the column already
    // existing by swallowing the engine's duplicate-column error, and on Postgres a swallowed error
    // aborts the enclosing transaction, so everything after it would fail with `current transaction
    // is aborted`. Storage bootstrap runs before the migration transaction opens; it has to stay
    // there.
    let chain = chainSchemaOperation(undefined, () => sqlite.exec(sqlite.dialect.sql("CREATE TABLE IF NOT EXISTS [sporades_log_events] (" +
        "[id] TEXT PRIMARY KEY, " +
        "[timestamp] TEXT NOT NULL, " +
        "[category] TEXT NOT NULL, " +
        "[event] TEXT NOT NULL, " +
        "[level] TEXT NOT NULL, " +
        "[message] TEXT NOT NULL, " +
        "[capsuleName] TEXT, " +
        "[capsuleId] TEXT, " +
        "[releaseId] TEXT, " +
        "[requestId] TEXT, " +
        "[correlationId] TEXT, " +
        "[indexSequence] TEXT, " +
        "[payload] TEXT NOT NULL" +
        ")")));
    // The additive migration for a Log index table that already exists. Declaring a column an older
    // database may not have is a dialect entry, because the strategies genuinely differ: `PRAGMA
    // table_info` is SQLite's alone, SQLite has no `ADD COLUMN IF NOT EXISTS`, and Postgres does.
    chain = chainSchemaOperation(chain, () => sqlite.dialect.addMissingColumn(sqlite, "sporades_log_events", "indexSequence", "TEXT"));
    return chainSchemaOperation(chain, () => backfillLogIndexSequences(sqlite));
}
// Gives every row stored before the ordering field existed a sequence derived from its timestamp.
// After the first Capsule start that runs it the selection is empty, so later starts cost one
// bounded read and write nothing.
function backfillLogIndexSequences(sqlite) {
    return thenIfPromise(sqlite
        .prepare(sqlite.dialect.sql("SELECT [id], [timestamp] FROM [sporades_log_events] WHERE [indexSequence] IS NULL " +
        "ORDER BY [timestamp] ASC, [id] ASC"))
        .all(), (rows) => {
        // Rows sharing a timestamp are separated by a nanosecond each, in the order the read
        // returned them, so that the backfilled values are distinct and the result of running the
        // backfill is the same on every engine. Which of two historically tied rows comes first is
        // not recoverable; that they come back in a defined order is.
        let previous = 0n;
        let chain = undefined;
        for (const row of rows) {
            const derived = backfilledLogIndexSequence(row.timestamp);
            previous = derived > previous ? derived : previous + 1n;
            const sequence = formatLogIndexSequence(previous);
            chain = chainSchemaOperation(chain, () => sqlite
                .prepare(sqlite.dialect.sql("UPDATE [sporades_log_events] SET [indexSequence] = ? WHERE [id] = ?"))
                .run(sequence, row.id));
        }
        return chain;
    });
}
function insertLogIndexEvent(sqlite, event) {
    // ADR-0034: a Database adapter method that writes returns its statement result rather than
    // discarding it. Without the return the caller has nothing to await, so the write has landed on
    // SQLite and has not landed on Postgres or libSQL by the time the method returns — and the Log
    // index caller's `isPromiseLike` probe can never fire.
    return sqlite
        .prepare(sqlite.dialect.sql("INSERT INTO [sporades_log_events] " +
        "([id], [timestamp], [category], [event], [level], [message], [capsuleName], [capsuleId], [releaseId], " +
        "[requestId], [correlationId], [indexSequence], [payload]) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"))
        .run(randomUUID(), event.timestamp, event.category, event.event, event.level, event.message, event.capsule?.name ?? null, event.capsule?.id ?? null, event.release?.id ?? event.release ?? null, event.request?.id ?? null, event.correlation?.id ?? event.correlation ?? null, 
    // ADR-0036: assigned here, as the event is indexed, and deliberately not added to the
    // envelope that is stringified into `payload` below. The field orders the Log index; it is
    // not part of what a log event says.
    nextLogIndexSequence(), JSON.stringify(event));
}
function pruneLogIndex(sqlite, limit) {
    // ADR-0034: returned rather than discarded, for the same reason as the insert above.
    //
    // ADR-0036: the bound is expressed as "keep the most recently indexed N" rather than "delete
    // everything past offset N". The offset form needed `LIMIT -1 OFFSET ?`, which is SQLite's alone
    // and is why Postgres carried its own copy of this method; naming the kept set instead is
    // portable, so there is one definition and one answer. It also states the intent directly: this
    // is the same subset a bounded `readRecentLogEvents` returns, which is what stops two Capsules on
    // different engines retaining different history.
    //
    // A bound of zero keeps nothing, so `NOT IN` an empty set removes every row. `id` is the primary
    // key and never null, so the `NOT IN` has no null to be confused by.
    return sqlite
        .prepare(sqlite.dialect.sql("DELETE FROM [sporades_log_events] WHERE [id] NOT IN (" +
        "SELECT [id] FROM (" +
        "SELECT [id] FROM [sporades_log_events] ORDER BY [indexSequence] DESC LIMIT ?" +
        ") AS [retained]" +
        ")"))
        .run(limit);
}
function readRecentLogEvents(sqlite, limit = 200) {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : 200;
    // ADR-0034: the rows are reversed and parsed, so they must be resolved first. Reading them
    // unresolved reversed and mapped a Promise, which is why libSQL carried an await-shim.
    //
    // ADR-0036: ordered by the runtime-assigned sequence alone. The envelope `timestamp` no longer
    // participates, because it is a millisecond-resolution value that ties routinely and left the
    // order to a tie-break that differed by engine.
    return thenIfPromise(sqlite
        .prepare(sqlite.dialect.sql("SELECT [payload] FROM [sporades_log_events] ORDER BY [indexSequence] DESC LIMIT ?"))
        .all(safeLimit), (rows) => rows.reverse().map((row) => JSON.parse(row.payload)));
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
// The one definition of what a Capsule schema migration does, run inside a transaction the caller
// has already opened. Its caller is the `migrateAppSchema` adapter method, which is what supplies
// that transaction; it takes the transaction-scoped adapter rather than the adapter itself so that
// every statement it and the table rebuilds below emit belongs to the same unit of work.
function migrateAppSchemaInTransaction(sqlite, schema) {
    const nextSchema = normalizeSchema(schema);
    const nextSchemaJson = JSON.stringify(nextSchema);
    const nextSchemaHash = hashSchema(nextSchemaJson);
    // ADR-0034: the recorded schema is read before anything is derived from it. On an asynchronous
    // engine `readSchemaMetadata()` answers a Promise, which is truthy even when there is no recorded
    // schema at all, so every branch below — whether a schema exists, whether it parses, whether it
    // changed, and whether the change is additive — has to be taken against the resolved row.
    return thenIfPromise(sqlite.readSchemaMetadata(), (existingSchemaRow) => {
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
                // The in-transaction table rebuild rather than the adapter method, which opens a
                // transaction of its own and would nest inside the one already enclosing this migration —
                // and libSQL's transaction adapter throws on a nested `withTransaction`.
                //
                // Issue 09's review asked what happens when an engine overrides `migrateExistingAppTable`:
                // this call would bypass it, from inside a migration, silently. ADR-0037 answers it — an
                // engine supplies statement primitives, a dialect and normalization, and has nowhere to put
                // a behavioural method body. What this call skips is the transaction wrapper and nothing
                // else, and `test/database-adapter-engine-seam.test.js` fails if that stops being true.
                return schemaChanged && existingTable
                    ? migrateExistingAppTableInTransaction(sqlite, existingTable, table)
                    : sqlite.createAppTable(table);
            }),
            () => sqlite.writeSchemaMetadata({
                schemaVersion: "v1:additive-fields",
                schemaHash: nextSchemaHash,
                schemaJson: nextSchemaJson,
            }),
        ]);
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
// The one definition of an additive table rebuild, run inside a transaction the caller has already
// opened. SQLite cannot add a column to a table that carries a default without rewriting it, so the
// rebuild copies every row of the table into a temporary copy and renames it into place — which is
// precisely the work that must not be left half done, and precisely why its caller wraps it.
function migrateExistingAppTableInTransaction(sqlite, existingTable, nextTable) {
    // The dialect is reached through the adapter rather than passed alongside it, so a helper the
    // shared method set delegates to cannot end up emitting a different engine's SQL than the method
    // that called it.
    const dialect = sqlite.dialect;
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
        () => sqlite.exec(`DROP TABLE IF EXISTS ${dialect.quoteIdentifier(tempTableName)}`),
        () => sqlite.createAppTable(nextTable, tempTableName),
        () => sqlite.exec(`INSERT INTO ${dialect.quoteIdentifier(tempTableName)} (${columns.map((column) => dialect.quoteIdentifier(column)).join(", ")}) ` +
            `SELECT ${columns.map((column) => columnSelectExpressionForMigration(dialect, existingTable, nextTable, column)).join(", ")} ` +
            `FROM ${dialect.quoteIdentifier(nextTable.name)}`),
        () => sqlite.exec(`DROP TABLE ${dialect.quoteIdentifier(nextTable.name)}`),
        () => sqlite.exec(`ALTER TABLE ${dialect.quoteIdentifier(tempTableName)} RENAME TO ${dialect.quoteIdentifier(nextTable.name)}`),
    ]);
}
function columnSelectExpressionForMigration(dialect, existingTable, nextTable, columnName) {
    if (["id", "createdAt", "updatedAt"].includes(columnName)) {
        return dialect.quoteIdentifier(columnName);
    }
    if ((existingTable.fields ?? []).some((field) => field.name === columnName)) {
        return dialect.quoteIdentifier(columnName);
    }
    const field = nextTable.fields.find((candidate) => candidate.name === columnName);
    return field?.defaultValue === undefined ? "NULL" : toSqlLiteral(field.defaultValue, field);
}
function addedFieldsForTable(existingTable, nextTable) {
    const existingFields = new Set((existingTable.fields ?? []).map((field) => field.name));
    return (nextTable.fields ?? []).filter((field) => !existingFields.has(field.name));
}
function createAppTable(sqlite, table, tableName = table.name) {
    return sqlite.exec(`CREATE TABLE IF NOT EXISTS ${sqlite.dialect.quoteIdentifier(tableName)} (` +
        appTableColumnDefinitions(sqlite.dialect, table).join(", ") +
        ")");
}
// `id`, `createdAt` and `updatedAt` are quoted like every other column. Postgres folds an unquoted
// identifier to lower case, and its adapter used to carry a whole copy of `createAppTable` for no
// other reason; on SQLite and libSQL, which fold nothing, quoting a name that needed no quoting
// declares exactly the same column. One definition, and the difference the engines actually have is
// answered by the dialect entry rather than by a second method body.
function appTableColumnDefinitions(dialect, table) {
    return [
        `${dialect.quoteIdentifier("id")} TEXT PRIMARY KEY`,
        `${dialect.quoteIdentifier("createdAt")} TEXT NOT NULL`,
        `${dialect.quoteIdentifier("updatedAt")} TEXT NOT NULL`,
        ...table.fields.map((field) => appFieldColumnDefinition(dialect, field)),
    ];
}
function appFieldColumnDefinition(dialect, field) {
    const defaultSql = fieldColumnDefaultSql(field);
    const notNullSql = field.defaultValue !== undefined && !fieldDefaultIsSqlNull(field) ? " NOT NULL" : "";
    return `${dialect.quoteIdentifier(field.name)} ${dialect.columnType(field)}${notNullSql}${defaultSql}`;
}
function fieldDefaultIsSqlNull(field) {
    return field.defaultValue === null && field.kind !== "Json";
}
function fieldColumnDefaultSql(field) {
    return field.defaultValue === undefined ? "" : ` DEFAULT ${toSqlLiteral(field.defaultValue, field)}`;
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
            handlerSource: argsSource.slice(descriptor[0].length).trim().replace(/,\s*$/, ""),
        });
        endpointPattern.lastIndex = argsEnd + 1;
    }
    return endpoints;
}
function endpointHandlersFromCapsuleDefinition(capsuleDefinition) {
    return Object.entries(capsuleDefinition?.endpoints ?? {})
        .filter(([, definition]) => definition?.kind === "endpoint"
        && typeof definition.handler === "function"
        && typeof definition.options?.method === "string"
        && typeof definition.options?.path === "string")
        .map(([name, definition]) => ({
        name,
        method: definition.options.method.toUpperCase(),
        path: definition.options.path,
        handler: definition.handler,
    }));
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
function isDuplicateColumnError(error) {
    const text = [error?.message, error?.stdout, error?.stderr, error].map((value) => String(value ?? "")).join("\n");
    return /duplicate column|already exists/i.test(text);
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
async function runEndpoint(database, endpoint, requestUrl, request) {
    const handler = typeof endpoint.handler === "function"
        ? endpoint.handler
        : new Function(`return (${endpoint.handlerSource});`)();
    const endpointRequest = await readEndpointRequest(database, requestUrl, request);
    const session = await resolveAnonymousSession(database, readEndpointSessionToken(endpointRequest.headers, endpointRequest.query));
    let context;
    try {
        const result = await (database.adapter ?? database.adapter).withTransaction(async (transactionAdapter) => {
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
    const auth = session.auth;
    const context = {
        auth,
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
    context.mail = database.mail;
    context.serverAuth = {
        async setEmailPassword(email, newPassword) {
            const result = await setEmailPassword(database, { auth }, email, newPassword);
            if (!result.ok)
                throw new Error(result.error?.message ?? "Could not set password.");
        },
        async sendEmailPasswordResetLink(email, options = {}) {
            const result = await sendEmailPasswordResetLink(database, { auth }, email, options);
            if (!result.ok)
                throw serverAuthError(result.error, "Could not send the password reset link.");
        },
        async createEmailPasswordResetLink(email) {
            const result = await createEmailPasswordResetLink(database, { auth }, email);
            if (!result.ok)
                throw serverAuthError(result.error, "Could not create a password reset link.");
            return { link: result.link, expiresAt: result.expiresAt };
        },
        async verifyPasswordResetCode(code) {
            const result = await verifyPasswordResetCode(database, { auth }, code);
            if (!result.ok)
                throw serverAuthError(result.error, "Could not verify the password reset code.");
            return { email: result.email };
        },
        async confirmPasswordReset(code, newPassword) {
            const result = await confirmPasswordReset(database, { auth }, code, newPassword);
            if (!result.ok)
                throw serverAuthError(result.error, "Could not complete the password reset.");
        },
    };
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
                    const result = database.adapter.insertAppRow(table, Object.fromEntries(columns.map((column) => [column, row[column]])));
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
                        const result = database.adapter.updateAppRow(table, id, serializedValues);
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
            const selected = database.adapter.selectAppRowById(table, id);
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
                    const result = database.adapter.deleteAppRow(table, id);
                    database.rowCache.clear();
                    return thenIfPromise(result, (writeResult) => writeResult.changes > 0);
                });
            };
            const operation = thenIfPromise(database.adapter.selectAppRowById(table, id), finish);
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
            const selected = database.adapter.selectAppRows(table, {
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
            const selected = database.adapter.selectAppRows(table, {
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
function referenceExists(database, field, value) {
    return database.adapter.referenceExists(field, value);
}
// `serializeFieldValue`, `normalizeDateValue`, `toSqlNumber` and `dateValueError` stood here until
// batch 9 moved them to `stored-value-coding.ts`, beside the reading half they mirror.
// `invalidReferenceError` stood above `referenceExists` and is in `runtime-errors.js` now. The
// first two are imported back at the top of this file; the other three have no consumer here.
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
    return await (database.adapter ?? database.adapter).listInspectableTables();
}
export async function dumpDatabase(database) {
    return await (database.adapter ?? database.adapter).dumpInspectableDatabase();
}
export async function runReadOnlyQuery(database, sql) {
    return await (database.adapter ?? database.adapter).runReadOnlyInspectionQuery(sql);
}
// The internal log-index guard used to be four functions here — `targetsInternalLogIndexTable`,
// `readSqlTableReference`, `readSqlIdentifier` and `isInternalLogIndexMetadataRow`. It is
// `./log-index-guard.js` now, and `runReadOnlyInspectionQuery` above calls it through the import at
// the top of this file. ADR-0038 is why it is a module beside the inspection gate rather than part
// of it, and that module's header states the reasoning.
function normalizeJourneyPolicy(value) {
    if (value == null)
        return null;
    if (!value || typeof value !== "object" || Array.isArray(value) || value.enabled !== true)
        throw commandError("Invalid Journey declaration.", "Declare journey: { enabled: true } on capsule().");
    const ttlSeconds = value.ttlSeconds ?? 30;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300)
        throw commandError("Invalid Journey TTL.", "Set journey.ttlSeconds to an integer from 1 through 300.");
    const capture = {};
    if (value.capture !== undefined && (value.capture === null || typeof value.capture !== "object" || Array.isArray(value.capture) || Object.getPrototypeOf(value.capture) !== Object.prototype))
        throw commandError("Invalid Journey capture policy.", "Set journey.capture to a plain object of boolean source settings.");
    for (const key of ["navigation", "focus", "interactions"]) {
        const setting = value.capture?.[key];
        if (setting !== undefined && typeof setting !== "boolean")
            throw commandError("Invalid Journey capture policy.", `Set journey.capture.${key} to true or false.`);
        capture[key] = setting ?? true;
    }
    return { ttlSeconds, capture };
}
function normalizeJourneyState(value, defaultTtlSeconds) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw { code: "INVALID_JOURNEY_STATE", message: "Journey state must be an object.", hint: "Pass status, optional metadata, and optional ttlSeconds to journey.set()." };
    const status = typeof value.status === "string" ? value.status.trim() : "";
    if (!status || Buffer.byteLength(status, "utf8") > 256 || status === "inactive")
        throw { code: "INVALID_JOURNEY_STATUS", message: "Journey status is invalid.", hint: "Use a trimmed status from 1 through 256 UTF-8 characters other than inactive." };
    const ttlSeconds = value.ttlSeconds ?? defaultTtlSeconds;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300)
        throw { code: "INVALID_JOURNEY_TTL", message: "Journey TTL is invalid.", hint: "Use an integer from 1 through 300." };
    if (value.metadata !== undefined && (value.metadata === null || typeof value.metadata !== "object" || Array.isArray(value.metadata) || Object.getPrototypeOf(value.metadata) !== Object.prototype))
        throw { code: "INVALID_JOURNEY_METADATA", message: "Journey metadata must be a plain JSON object.", hint: "Pass a plain JSON object as metadata." };
    if (value.metadata !== undefined)
        validateJourneyJson(value.metadata, 0, new Set());
    if (value.metadata !== undefined && Buffer.byteLength(JSON.stringify(value.metadata), "utf8") > 8192)
        throw { code: "INVALID_JOURNEY_METADATA", message: "Journey metadata is too large.", hint: "Keep serialized metadata at or below 8 KiB." };
    return { status, metadata: value.metadata, ttlSeconds };
}
function validateJourneyJson(value, depth, seen) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return;
    if (typeof value === "number") {
        if (Number.isFinite(value))
            return;
        throw { code: "INVALID_JOURNEY_METADATA", message: "Journey metadata contains a non-finite number.", hint: "Use finite JSON numbers." };
    }
    if (typeof value !== "object" || depth >= 8 || seen.has(value))
        throw { code: "INVALID_JOURNEY_METADATA", message: "Journey metadata is not JSON-safe.", hint: "Use bounded plain JSON values without cycles, binary values, or custom prototypes." };
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
        throw { code: "INVALID_JOURNEY_METADATA", message: "Journey metadata is not a plain JSON object.", hint: "Use plain JSON objects and arrays." };
    if (!Array.isArray(value) && Reflect.ownKeys(value).some((key) => typeof key === "symbol"))
        throw { code: "INVALID_JOURNEY_METADATA", message: "Journey metadata contains symbol keys.", hint: "Use string-keyed plain JSON objects." };
    const entries = Array.isArray(value) ? value : Object.values(value);
    if (entries.length > 64)
        throw { code: "INVALID_JOURNEY_METADATA", message: "Journey metadata has too many entries.", hint: "Keep each object or array at 64 entries or fewer." };
    seen.add(value);
    try {
        for (const item of entries)
            validateJourneyJson(item, depth + 1, seen);
    }
    finally {
        seen.delete(value);
    }
}
function journeyError(id, code = "JOURNEY_NOT_ENABLED", message = "User journey tracking is not enabled for this Capsule.", hint = "Declare journey: { enabled: true } on capsule().") {
    return { id: id ?? null, type: "error", data: null, error: { code, message, hint } };
}
export function createWebSocketHub(getDatabase, trustedRefresh = null) {
    const clients = new Set();
    const journeys = new Map();
    const connectionTokens = new Map();
    let nextClientId = 1;
    const connectionTokenTtlMs = 4 * 60 * 60 * 1000;
    let journeyExpiryTimer = null;
    let journeyDisableRequests = 0;
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
            const origin = resolveOAuthRequestOrigin(policy, request);
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
                journey: null,
                journeySubscriptions: new Set(),
            };
            clients.add(client);
            socket.on("data", (chunk) => {
                client.lastSeenAt = new Date().toISOString();
                client.buffer = Buffer.concat([client.buffer, chunk]);
                drainWebSocketFrames(client, (message) => enqueueClientMessage(client, message));
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
            if (journeyExpiryTimer !== null)
                getDatabase().clock.clearTimer(journeyExpiryTimer);
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
    function retireJourney(client) {
        if (!client.journey)
            return;
        const removed = [...(client.journey.sessionIds ?? [])].map((sessionId) => journeys.get(sessionId)).filter(Boolean);
        for (const sessionId of client.journey.sessionIds ?? [])
            journeys.delete(sessionId);
        client.journey = null;
        for (const state of removed)
            broadcastJourneyEvent({ type: "removed", state });
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
            if (journeys.get(record.sessionId) !== record)
                continue;
            journeys.delete(record.sessionId);
            broadcastJourneyEvent({ type: "removed", state: record });
        }
        return expired.length;
    }
    function scheduleJourneyExpiry() {
        const database = getDatabase();
        if (journeyExpiryTimer !== null)
            database.clock.clearTimer(journeyExpiryTimer);
        journeyExpiryTimer = null;
        let earliest = Infinity;
        for (const record of journeys.values())
            earliest = Math.min(earliest, Date.parse(record.expiresAt));
        if (!Number.isFinite(earliest))
            return;
        journeyExpiryTimer = database.clock.setTimer(() => {
            journeyExpiryTimer = null;
            pruneExpiredJourneys();
            scheduleJourneyExpiry();
        }, Math.max(0, earliest - database.clock.now().getTime()));
    }
    function broadcastJourneyEvent(event) {
        for (const recipient of clients) {
            for (const subscriptionId of recipient.journeySubscriptions) {
                sendJson(recipient, { id: subscriptionId, type: "journey.event", data: event, error: null });
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
        if (trustedRefresh && message.type === trustedRefresh.subscribeType) {
            const requestId = typeof message.id === "string" && message.id.length <= 128 ? message.id : null;
            await trustedRefresh.subscribe(client.id, requestId, (outgoing) => sendJsonWithCompletion(client, outgoing));
            return;
        }
        if (trustedRefresh && message.type === trustedRefresh.receivedType) {
            if (Number.isSafeInteger(message.sequence) && message.sequence >= 1)
                trustedRefresh.received(client.id, message.sequence);
            return;
        }
        const database = getDatabase();
        const messageSessionToken = typeof message.sessionToken === "string" && message.sessionToken.length > 0 ? message.sessionToken : client.session.token;
        const previousAuth = client.session.auth;
        const resolvedSession = await resolveAnonymousSession(database, messageSessionToken ?? null);
        if (previousAuth.userId && (previousAuth.userId !== resolvedSession.auth.userId ||
            previousAuth.provider !== resolvedSession.auth.provider ||
            Boolean(previousAuth.isAuthenticated) !== Boolean(resolvedSession.auth.isAuthenticated)))
            retireJourney(client);
        client.session = resolvedSession;
        if (message.type === "auth.get") {
            await sendAuthResult(client, message.id ?? null);
            return;
        }
        if (message.type === "auth.signOut") {
            const result = await signOutSession(database, client);
            if (result.ok)
                retireJourney(client);
            sendJson(client, {
                id: message.id ?? null,
                type: result.ok ? "auth.signOut.result" : "error",
                data: result.ok ? { ok: true } : null,
                error: result.error ?? null,
            });
            return;
        }
        if (message.type === "auth.setPassword") {
            const result = await setOwnEmailPassword(database, client.session, message.email ?? "", message.newPassword ?? "");
            sendJson(client, {
                id: message.id ?? null,
                type: result.ok ? "auth.setPassword.result" : "error",
                data: result.ok ? { ok: true } : null,
                error: result.error ?? null,
            });
            return;
        }
        // The browser sends intent and relays an opaque Reset code. Runtime auth
        // internals, and the code's stored form, never leave the server.
        if (message.type === "auth.sendPasswordResetLink") {
            const result = await sendEmailPasswordResetLink(database, client.session, message.email ?? "");
            // Undeliverable mail is a Capsule misconfiguration, not something the
            // browser can act on, and reporting it would leak Capsule configuration
            // state to an unauthenticated caller. Tell the operator, not the client.
            const misconfigured = result.error?.code === "MAIL_NOT_CONFIGURED";
            if (misconfigured) {
                database.log?.emit?.({
                    category: "platform",
                    event: "auth.password_reset.undeliverable",
                    level: "error",
                    message: result.error.message,
                    data: { code: result.error.code, hint: result.error.hint },
                });
            }
            const ok = result.ok || misconfigured;
            sendJson(client, {
                id: message.id ?? null,
                type: ok ? "auth.sendPasswordResetLink.result" : "error",
                data: ok ? { ok: true } : null,
                error: ok ? null : result.error ?? null,
            });
            return;
        }
        if (message.type === "auth.verifyPasswordResetCode") {
            const result = await verifyPasswordResetCode(database, client.session, message.code ?? "");
            sendJson(client, {
                id: message.id ?? null,
                type: result.ok ? "auth.verifyPasswordResetCode.result" : "error",
                data: result.ok ? { email: result.email } : null,
                error: result.error ?? null,
            });
            return;
        }
        // Completing a reset deliberately does not mint a Session: mailbox access
        // alone must not be enough without demonstrating the new credential.
        if (message.type === "auth.confirmPasswordReset") {
            const result = await confirmPasswordReset(database, client.session, message.code ?? "", message.newPassword ?? "");
            sendJson(client, {
                id: message.id ?? null,
                type: result.ok ? "auth.confirmPasswordReset.result" : "error",
                data: result.ok ? { ok: true } : null,
                error: result.error ?? null,
            });
            return;
        }
        if (message.type === "auth.signUp") {
            const result = await signUpWithEmail(database, client.session, message.provider, message.credentials ?? {});
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
                const result = await signInWithEmail(database, client.session, message.credentials ?? {});
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
            void sendQueryResult(client, subscription, (error) => sendUnhandledMessageError(client, rawMessage, error));
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
            if (!policy) {
                sendJson(client, journeyError(message.id));
                return;
            }
            if (!client.journey) {
                const requested = message.options?.capture;
                const capture = {};
                for (const key of ["navigation", "focus", "interactions"])
                    capture[key] = policy.capture[key] && requested?.[key] !== false;
                client.journey = { sessionId: null, sessionIds: new Set(), lastActivityAt: null, userId: client.session.auth.userId, capture };
            }
            sendJson(client, { id: message.id ?? null, type: "journey.enable.result", data: { enabled: true, userId: client.journey.userId, capture: client.journey.capture }, error: null });
            return;
        }
        if (message.type === "journey.set") {
            if (!database.journeyPolicy) {
                sendJson(client, journeyError(message.id));
                return;
            }
            if (!client.journey) {
                sendJson(client, journeyError(message.id, "JOURNEY_NOT_ENABLED", "Journey publication is not enabled for this page.", "Call journey.enable() before journey.set()."));
                return;
            }
            if (client.journey.userId !== client.session.auth.userId) {
                retireJourney(client);
                sendJson(client, journeyError(message.id, "JOURNEY_IDENTITY_CHANGED", "Journey session identity changed.", "Call journey.enable() again for the current authenticated user."));
                return;
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
                    if (userCount >= 32)
                        throw { code: "JOURNEY_USER_CAPACITY", message: "Journey user capacity reached.", hint: "Wait for an existing Journey state to expire or disable one before publishing another." };
                    if (journeys.size >= 1000)
                        throw { code: "JOURNEY_CAPSULE_CAPACITY", message: "Journey Capsule capacity reached.", hint: "Wait for an existing Journey state to expire or be disabled before publishing another." };
                }
                const now = nowDate.toISOString();
                const record = { sessionId: client.journey.sessionId, userId: client.session.auth.userId, status: state.status, metadata: state.metadata ?? null, updatedAt: now, expiresAt: new Date(nowDate.getTime() + state.ttlSeconds * 1000).toISOString() };
                journeys.set(record.sessionId, record);
                client.journey.lastActivityAt = nowDate.getTime();
                scheduleJourneyExpiry();
                sendJson(client, { id: message.id ?? null, type: "journey.set.result", data: { journey: record }, error: null });
                broadcastJourneyEvent({ type: previous ? "updated" : "added", state: record });
            }
            catch (error) {
                sendJson(client, { id: message.id ?? null, type: "error", data: null, error });
            }
            return;
        }
        if (message.type === "journey.list") {
            if (!database.journeyPolicy) {
                sendJson(client, journeyError(message.id));
                return;
            }
            sendJson(client, { id: message.id ?? null, type: "journey.list.result", data: { journeys: activeJourneys() }, error: null });
            return;
        }
        if (message.type === "journey.subscribe") {
            if (!database.journeyPolicy) {
                sendJson(client, journeyError(message.id));
                return;
            }
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
            if (!database.journeyPolicy) {
                sendJson(client, journeyError(message.id));
                return;
            }
            const removed = client.journey ? [...client.journey.sessionIds].map((sessionId) => journeys.get(sessionId)).filter(Boolean) : [];
            if (client.journey)
                for (const sessionId of client.journey.sessionIds)
                    journeys.delete(sessionId);
            client.journey = null;
            scheduleJourneyExpiry();
            sendJson(client, { id: message.id ?? null, type: "journey.disable.result", data: { ok: true }, error: null });
            for (const state of removed)
                broadcastJourneyEvent({ type: "removed", state });
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
                            void sendQueryResult(subscribedClient, subscription, (error) => sendUnhandledMessageError(subscribedClient, JSON.stringify({ id: subscription.id }), error));
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
                hint: "Use auth.get, auth.signIn, auth.signOut, query.subscribe, query.unsubscribe, mutation.run, app messages, or files.* through the Sporades client SDK.",
            },
        });
    }
    async function sendQueryResult(client, subscription, onError) {
        const generation = (subscription.generation ?? 0) + 1;
        subscription.generation = generation;
        try {
            const database = getDatabase();
            const result = await runQuery(database, client.session.auth, subscription.name);
            const data = subscription.style === "direct"
                ? (result.data ?? result.rows)
                : { rows: result.data ?? result.rows };
            if (client.subscriptions.get(subscription.id) !== subscription || subscription.generation !== generation)
                return;
            sendJson(client, {
                id: subscription.id,
                type: "query.result",
                query: subscription.name,
                data,
                error: result.error,
            });
        }
        catch (error) {
            if (client.subscriptions.get(subscription.id) !== subscription || subscription.generation !== generation)
                return;
            try {
                onError(error);
            }
            catch { /* A closed transport already owns cleanup. */ }
        }
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
                providers: authProvidersForClient(database.authConfig, client.origin),
            },
            error: null,
        });
    }
    async function signOutSession(database, client) {
        try {
            await database.adapter.deleteAuthSession(client.session.token);
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
// Enqueues a runtime-owned Job under the reserved privileged actor. This writes
// the queue row directly rather than going through the current-user Job API:
// that API batches enqueues onto the calling Capsule context when a transaction
// is active, and runtime code has no such context, so the row would be dropped.
// A direct insert joins whatever transaction is already open, so a rolled-back
// caller discards the Job with it.
async function enqueueRuntimeJob(database, handlerName, payload, idempotencyKey) {
    const queueDatabase = database.__rootDatabase ?? database;
    const now = queueDatabase.clock.now().toISOString();
    const payloadJson = boundedJobJson(payload, 64 * 1024, "JOB_PAYLOAD_TOO_LARGE", "Job payload");
    await queueDatabase.adapter.prepare(queueDatabase.adapter.dialect.sql("INSERT INTO [sporades_jobs] ([id], [handler], [enqueuedByUserId], [actorUserId], [actorProvider], [payload], [status], " +
        "[availableAt], [attempts], [idempotencyKey], [createdAt], [retryJson], [attemptHistory], [scheduleName], [scheduledFor]) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?, '[]', NULL, NULL)")).run(randomUUID(), handlerName, PRIVILEGED_AUTH_USER_ID, PRIVILEGED_AUTH_USER_ID, "privileged", payloadJson, now, idempotencyKey, now, JSON.stringify(normalizeJobRetry(undefined)));
    scheduleCurrentUserJobWorker(queueDatabase);
}
// Resolves identically whether or not the email is registered: no error, count,
// or send distinguishes the two, so this cannot be used to enumerate accounts.
export async function sendEmailPasswordResetLink(database, session, email, options = {}) {
    if (!database.authConfig.providers.email.enabled) {
        return { ok: false, error: emailAuthDisabledError() };
    }
    if (!database.mail.enabled) {
        return { ok: false, error: mailNotConfiguredError() };
    }
    const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    const throttle = currentEmailSignInThrottleState(database, cleanEmail, session, PASSWORD_RESET_THROTTLE_FIELD);
    if (throttle.throttled) {
        return { ok: true };
    }
    recordFailedEmailSignInAttempt(database, cleanEmail, session, PASSWORD_RESET_THROTTLE_FIELD);
    const credential = cleanEmail ? await database.adapter.findEmailCredentialWithUser(cleanEmail) : null;
    if (!credential) {
        // Comparable work on the unregistered branch so timing does not separate it.
        hashPasswordResetVerifier(randomBytes(32).toString("base64url"));
        return { ok: true };
    }
    const issued = await issuePasswordResetCode(database, credential);
    if (!issued) {
        return { ok: true };
    }
    const body = passwordResetMailBody(issued.link);
    // Delivery is queued, not awaited. Doing the SMTP round trip inline would make
    // the reply time and any transport failure a reliable oracle for whether the
    // address is registered, which is exactly what the uniform result prevents.
    // The Job is durable and retried, so queueing does not mean dropping.
    await enqueueRuntimeJob(database, PASSWORD_RESET_MAIL_JOB, {
        to: credential.email,
        subject: typeof options.subject === "string" ? options.subject : "Reset your password",
        textBody: typeof options.textBody === "string" ? options.textBody : body.textBody,
        htmlBody: typeof options.htmlBody === "string" ? options.htmlBody : body.htmlBody,
        // Job execution is at least once; the key keeps one Reset code to one mail.
    }, `password-reset:${issued.selector}`);
    return { ok: true };
}
// The one definition of the auth storage bootstrap, for every engine.
//
// Each step is chained rather than fired: on a synchronous engine that is the order the statements
// already ran in, and on an asynchronous one it is the difference between a sequence and a race.
// The unchained form worked on SQLite alone, which is why Postgres and libSQL each carried a copy
// that awaited the same statements in order.
//
// Kept outside any transaction by its caller. `addMissingColumn` tolerates a column that is
// already there, and on Postgres a swallowed duplicate-column error would abort the enclosing
// transaction and fail everything after it. The Postgres dialect asks the engine not to raise the
// error at all, but storage bootstrap still runs before the migration transaction opens; it has to
// stay there.
function createAnonymousAuthTables(sqlite, authConfig = null) {
    const sql = sqlite.dialect.sql;
    return chainMaybePromise([
        () => sqlite.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_auth_users] (" +
            "[id] TEXT PRIMARY KEY, " +
            "[createdAt] TEXT NOT NULL, " +
            "[displayName] TEXT NOT NULL, " +
            "[email] TEXT, " +
            "[picture] TEXT, " +
            "[isAuthenticated] INTEGER NOT NULL, " +
            "[isGuest] INTEGER NOT NULL, " +
            "[provider] TEXT NOT NULL" +
            ")")),
        () => sqlite.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_auth_sessions] (" +
            "[token] TEXT PRIMARY KEY, " +
            "[userId] TEXT NOT NULL, " +
            "[provider] TEXT NOT NULL, " +
            "[createdAt] TEXT NOT NULL, " +
            "[expiresAt] TEXT NOT NULL" +
            ")")),
        () => ensureSessionLifecycleColumns(sqlite),
        () => ensureSessionProvenanceColumn(sqlite),
        () => createProviderIdentityTables(sqlite),
        ...(authConfig?.providers?.email?.enabled
            ? [
                () => sqlite.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_auth_email_credentials] (" +
                    "[email] TEXT PRIMARY KEY, " +
                    "[userId] TEXT NOT NULL, " +
                    "[passwordHash] TEXT NOT NULL, " +
                    "[passwordSalt] TEXT NOT NULL, " +
                    "[createdAt] TEXT NOT NULL" +
                    ")")),
                () => sqlite.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_auth_password_reset_codes] (" +
                    "[selector] TEXT PRIMARY KEY, " +
                    "[verifierHash] TEXT NOT NULL, " +
                    "[email] TEXT NOT NULL, " +
                    "[userId] TEXT NOT NULL, " +
                    "[createdAt] TEXT NOT NULL, " +
                    "[expiresAt] TEXT NOT NULL" +
                    ")")),
            ]
            : []),
        () => sqlite.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_auth_oauth_states] (" +
            "[state] TEXT PRIMARY KEY, " +
            "[provider] TEXT NOT NULL, " +
            "[sessionToken] TEXT NOT NULL, " +
            "[returnTo] TEXT NOT NULL, " +
            "[redirectUri] TEXT NOT NULL, " +
            "[createdAt] TEXT NOT NULL, " +
            "[expiresAt] TEXT NOT NULL, " +
            "[nonce] TEXT, " +
            "[pkceVerifier] TEXT" +
            ")")),
        () => ensureOAuthStateColumns(sqlite),
    ]);
}
function ensureOAuthStateColumns(sqlite) {
    const sql = sqlite.dialect.sql;
    return chainMaybePromise([
        ...[
            ["provider", "TEXT"],
            ["expiresAt", "TEXT"],
            ["nonce", "TEXT"],
            ["pkceVerifier", "TEXT"],
        ].map(([name, type]) => () => sqlite.dialect.addMissingColumn(sqlite, "sporades_auth_oauth_states", name, type)),
        () => sqlite.exec(sql("UPDATE [sporades_auth_oauth_states] SET [provider] = 'google' WHERE [provider] IS NULL")),
        () => sqlite.exec(sql("UPDATE [sporades_auth_oauth_states] SET [expiresAt] = [createdAt] WHERE [expiresAt] IS NULL")),
    ]);
}
function createProviderIdentityTables(sqlite) {
    const sql = sqlite.dialect.sql;
    return chainMaybePromise([
        () => sqlite.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_auth_identities] (" +
            "[id] TEXT PRIMARY KEY, " +
            "[userId] TEXT NOT NULL, " +
            "[provider] TEXT NOT NULL, " +
            "[subject] TEXT NOT NULL, " +
            "[email] TEXT, " +
            "[displayName] TEXT, " +
            "[picture] TEXT, " +
            "[createdAt] TEXT NOT NULL, " +
            "[updatedAt] TEXT NOT NULL, " +
            "UNIQUE([provider], [subject])" +
            ")")),
        () => sqlite.exec(sql("INSERT INTO [sporades_auth_identities] " +
            "([id], [userId], [provider], [subject], [email], [displayName], [picture], [createdAt], [updatedAt]) " +
            "SELECT 'legacy:' || [id], [id], [provider], 'legacy:' || [id], [email], [displayName], [picture], " +
            "[createdAt], [createdAt] " +
            "FROM [sporades_auth_users] [u] WHERE [provider] = 'google' AND [id] != '__privileged__' " +
            "AND NOT EXISTS (SELECT 1 FROM [sporades_auth_identities] [i] " +
            "WHERE [i].[userId] = [u].[id] AND [i].[provider] = [u].[provider])")),
    ]);
}
// The backfill runs unconditionally rather than only when the column was just added. It was
// conditional because the `PRAGMA table_info` probe happened to say whether the ALTER had fired,
// and the probe is SQLite's alone; the predicate does the same work portably, because a session
// that already has an expiry has a non-null one.
function ensureSessionLifecycleColumns(sqlite) {
    return chainMaybePromise([
        () => sqlite.dialect.addMissingColumn(sqlite, "sporades_auth_sessions", "expiresAt", "TEXT"),
        () => sqlite
            .prepare(sqlite.dialect.sql("UPDATE [sporades_auth_sessions] SET [expiresAt] = ? WHERE [expiresAt] IS NULL"))
            .run(sessionExpiresAt(new Date().toISOString())),
    ]);
}
function ensureSessionProvenanceColumn(sqlite) {
    return chainMaybePromise([
        () => sqlite.dialect.addMissingColumn(sqlite, "sporades_auth_sessions", "provider", "TEXT"),
        () => sqlite.exec(sqlite.dialect.sql("UPDATE [sporades_auth_sessions] SET [provider] = " +
            "COALESCE([provider], (SELECT [provider] FROM [sporades_auth_users] " +
            "WHERE [id] = [sporades_auth_sessions].[userId]), 'anonymous') " +
            "WHERE [provider] IS NULL")),
    ]);
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
function encodeWebSocketJson(message) {
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
    return Buffer.concat([header, payload]);
}
function sendJson(client, message) {
    client.socket.write(encodeWebSocketJson(message));
}
function sendJsonWithCompletion(client, message, timeoutMs = 250) {
    return new Promise((resolve) => {
        let settled = false;
        let backpressured = false;
        const finish = (status) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ status, backpressured });
        };
        const timer = setTimeout(() => finish("write-timeout"), timeoutMs);
        try {
            backpressured = !client.socket.write(encodeWebSocketJson(message), (error) => finish(error ? "write-failed" : "written"));
        }
        catch {
            finish("write-failed");
        }
    });
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
        const rows = (await database.adapter.selectAppRows(table, {
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
        const committed = await (database.adapter ?? database.adapter).withTransaction(async (transactionAdapter) => {
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
        const response = await (database.adapter ?? database.adapter).withTransaction(async (transactionAdapter) => {
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
    context.mail = database.mail;
    context.serverAuth = {
        async setEmailPassword(email, newPassword) {
            const result = await setEmailPassword(database, { auth }, email, newPassword);
            if (!result.ok)
                throw new Error(result.error?.message ?? "Could not set password.");
        },
        async sendEmailPasswordResetLink(email, options = {}) {
            const result = await sendEmailPasswordResetLink(database, { auth }, email, options);
            if (!result.ok)
                throw serverAuthError(result.error, "Could not send the password reset link.");
        },
        async createEmailPasswordResetLink(email) {
            const result = await createEmailPasswordResetLink(database, { auth }, email);
            if (!result.ok)
                throw serverAuthError(result.error, "Could not create a password reset link.");
            return { link: result.link, expiresAt: result.expiresAt };
        },
        async verifyPasswordResetCode(code) {
            const result = await verifyPasswordResetCode(database, { auth }, code);
            if (!result.ok)
                throw serverAuthError(result.error, "Could not verify the password reset code.");
            return { email: result.email };
        },
        async confirmPasswordReset(code, newPassword) {
            const result = await confirmPasswordReset(database, { auth }, code, newPassword);
            if (!result.ok)
                throw serverAuthError(result.error, "Could not complete the password reset.");
        },
    };
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
                const existing = await queueDatabase.adapter.prepare(queueDatabase.adapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [handler] = ? AND [actorUserId] = ? AND [idempotencyKey] = ?")).get(handlerName, context.auth.userId, idempotencyKey);
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
            const row = { id, handler: handlerName, enqueuedByUserId: context.__jobEnqueuedBy ?? context.auth.userId, actorUserId: context.auth.userId, actorProvider: jobActorProvider(context.auth), payload: payloadJson, status: availableAt > now ? "delayed" : "queued", availableAt, attempts: 0, idempotencyKey: idempotencyKey ?? null, createdAt: now, retryJson: JSON.stringify(retry), attemptHistory: "[]", scheduleName: scheduleProvenance?.scheduleName ?? null, scheduledFor: scheduleProvenance?.scheduledFor ?? null };
            if (database.__transactionActive) {
                const pendingContext = context.__jobParentContext ?? context;
                pendingContext.__pendingJobEnqueues ??= [];
                pendingContext.__jobQueueDatabase = queueDatabase;
                pendingContext.__pendingJobEnqueues.push(row);
                return jobState(row, true);
            }
            try {
                await queueDatabase.adapter.prepare(queueDatabase.adapter.dialect.sql("INSERT INTO [sporades_jobs] ([id], [handler], [enqueuedByUserId], [actorUserId], [actorProvider], [payload], [status], [availableAt], [attempts], [idempotencyKey], [createdAt], [retryJson], [attemptHistory], [scheduleName], [scheduledFor]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)")).run(id, handlerName, row.enqueuedByUserId, row.actorUserId, row.actorProvider, payloadJson, row.status, availableAt, idempotencyKey ?? null, now, row.retryJson, row.attemptHistory, row.scheduleName, row.scheduledFor);
            }
            catch (error) {
                if (idempotencyKey) {
                    const existing = await queueDatabase.adapter.prepare(queueDatabase.adapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [handler] = ? AND [actorUserId] = ? AND [idempotencyKey] = ?")).get(handlerName, context.auth.userId, idempotencyKey);
                    if (existing) {
                        assertJobScheduleProvenance(existing, scheduleProvenance);
                        return jobState(existing, true);
                    }
                }
                throw error;
            }
            scheduleCurrentUserJobWorker(queueDatabase);
            return jobState(await queueDatabase.adapter.prepare(queueDatabase.adapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [id] = ?")).get(id), true);
        },
        async get(id) {
            const context = contextGetter();
            const jobAdapter = (database.__rootDatabase ?? database).adapter;
            const row = await jobAdapter.prepare(jobAdapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [id] = ? AND [actorUserId] = ?")).get(id, context.auth.userId);
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
            const sql = queueDatabase.adapter.dialect.sql;
            const clauses = ["[actorUserId] = ?"];
            const params = [context.auth.userId];
            if (options.status) {
                clauses.push("[status] = ?");
                params.push(options.status);
            }
            if (options.handler) {
                clauses.push("[handler] = ?");
                params.push(options.handler);
            }
            if (options.createdAfter) {
                clauses.push("[createdAt] >= ?");
                params.push(options.createdAfter);
            }
            if (options.createdBefore) {
                clauses.push("[createdAt] <= ?");
                params.push(options.createdBefore);
            }
            if (cursor) {
                clauses.push("([createdAt] > ? OR ([createdAt] = ? AND [id] > ?))");
                params.push(cursor.createdAt, cursor.createdAt, cursor.id);
            }
            const rows = await queueDatabase.adapter.prepare(sql(`SELECT * FROM [sporades_jobs] WHERE ${clauses.join(" AND ")} ORDER BY [createdAt] ASC, [id] ASC LIMIT ?`)).all(...params, limit + 1);
            const page = rows.slice(0, limit);
            return { jobs: page.map((row) => jobSummary(row)), nextCursor: rows.length > limit ? encodeJobCursor(page.at(-1)) : null };
        },
    };
}
function createPrivilegedJobApi(database, contextGetter) {
    const current = createCurrentUserJobApi(database, contextGetter);
    return {
        async enqueue(handler, payload, options = {}) { assertActivePrivilegedJobAccess(contextGetter); return await current.enqueue(handler, payload, options); },
        async get(id) {
            assertActivePrivilegedJobAccess(contextGetter);
            const jobAdapter = (database.__rootDatabase ?? database).adapter;
            const row = await jobAdapter.prepare(jobAdapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [id] = ?")).get(id);
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
            const sqlite = (database.__rootDatabase ?? database).adapter;
            const sql = sqlite.dialect.sql;
            const clauses = [];
            const params = [];
            if (options.status) {
                clauses.push("[status] = ?");
                params.push(options.status);
            }
            if (options.handler) {
                clauses.push("[handler] = ?");
                params.push(options.handler);
            }
            if (options.createdAfter) {
                clauses.push("[createdAt] >= ?");
                params.push(options.createdAfter);
            }
            if (options.createdBefore) {
                clauses.push("[createdAt] <= ?");
                params.push(options.createdBefore);
            }
            if (cursor) {
                clauses.push("([createdAt] > ? OR ([createdAt] = ? AND [id] > ?))");
                params.push(cursor.createdAt, cursor.createdAt, cursor.id);
            }
            const rows = await sqlite.prepare(sql(`SELECT * FROM [sporades_jobs]${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY [createdAt] ASC, [id] ASC LIMIT ?`)).all(...params, limit + 1);
            const page = rows.slice(0, limit);
            return { jobs: page.map((row) => jobSummary(row)), nextCursor: rows.length > limit ? encodeJobCursor(page.at(-1)) : null };
        },
        async cancel(id) { assertActivePrivilegedJobAccess(contextGetter); return await cancelJob(database.__rootDatabase ?? database, { auth: { userId: privilegedAuthUserId() }, __privilegedJobAccess: true }, id); },
    };
}
async function flushPendingJobEnqueues(context) {
    if (!context?.__pendingJobEnqueues?.length || context.__pendingJobsFlushed)
        return;
    context.__pendingJobsFlushed = true;
    const queueDatabase = context.__jobQueueDatabase;
    for (const row of context.__pendingJobEnqueues) {
        await queueDatabase.adapter.prepare(queueDatabase.adapter.dialect.sql("INSERT INTO [sporades_jobs] ([id], [handler], [enqueuedByUserId], [actorUserId], [actorProvider], [payload], [status], [availableAt], [attempts], [idempotencyKey], [createdAt], [retryJson], [attemptHistory], [scheduleName], [scheduledFor]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")).run(row.id, row.handler, row.enqueuedByUserId, row.actorUserId, row.actorProvider, row.payload, row.status, row.availableAt, row.attempts, row.idempotencyKey, row.createdAt, row.retryJson, row.attemptHistory, row.scheduleName ?? null, row.scheduledFor ?? null);
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
    const row = await database.adapter.prepare(database.adapter.dialect.sql("SELECT [availableAt] FROM [sporades_jobs] WHERE [status]='delayed' ORDER BY [availableAt] ASC, [id] ASC LIMIT 1")).get();
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
    const sql = database.adapter.dialect.sql;
    try {
        while (true) {
            await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status]='queued' WHERE [status]='delayed' AND [availableAt] <= ?")).run(database.clock.now().toISOString());
            const row = await database.adapter.prepare(sql("SELECT * FROM [sporades_jobs] WHERE [status] = 'queued' AND [availableAt] <= ? ORDER BY [availableAt] ASC, [id] ASC LIMIT 1")).get(database.clock.now().toISOString());
            if (!row) {
                await scheduleNextDelayedJob(database);
                return;
            }
            const startedAt = database.clock.now().toISOString();
            const claimed = await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status] = 'running', [attempts] = [attempts] + 1, [startedAt] = ?, [leaseExpiresAt] = ? WHERE [id] = ? AND [status] = 'queued'")).run(startedAt, new Date(database.clock.now().getTime() + 30_000).toISOString(), row.id);
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
                    const user = await database.adapter.prepare(sql("SELECT [id], [displayName], [email], [picture], [isAuthenticated], [isGuest] " +
                        "FROM [sporades_auth_users] WHERE [id] = ?")).get(row.actorUserId);
                    if (!user)
                        throw jobError("JOB_ACTOR_UNAVAILABLE", "The captured Job actor is unavailable.", "The user no longer exists, so this Job cannot run.");
                    const auth = {
                        userId: user.id,
                        displayName: user.displayName,
                        email: user.email,
                        picture: user.picture,
                        isAuthenticated: Boolean(user.isAuthenticated),
                        isGuest: Boolean(user.isGuest),
                        provider: jobActorProvider({ provider: row.actorProvider, isGuest: Boolean(user.isGuest) }),
                    };
                    const context = createMutationContext(database, auth);
                    context.signal = abortController.signal;
                    result = await handler.handler(context, JSON.parse(row.payload));
                }
                const resultJson = boundedJobJson(result ?? null, 64 * 1024, "JOB_RESULT_TOO_LARGE", "Job result");
                const completedAt = database.clock.now().toISOString();
                const history = JSON.parse(row.attemptHistory || "[]");
                history.push({ attempt: Number(row.attempts) + 1, startedAt, outcome: "succeeded", completedAt });
                await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status] = 'succeeded', [result] = ?, [completedAt] = ?, [attemptHistory] = ? WHERE [id] = ?")).run(resultJson, completedAt, JSON.stringify(history), row.id);
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
                    await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status]='cancelled', [failure]=?, [failedAt]=?, [attemptHistory]=? WHERE [id]=?")).run(JSON.stringify(failure), failedAt, JSON.stringify(history), row.id);
                else if (Number(row.attempts) + 1 < retry.maxAttempts) {
                    const availableAt = new Date(database.clock.now().getTime() + retry.delayMs).toISOString();
                    await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status]='delayed', [availableAt]=?, [attemptHistory]=? WHERE [id]=?")).run(availableAt, JSON.stringify(history), row.id);
                    database.clock.setTimer(() => scheduleCurrentUserJobWorker(database), retry.delayMs + 1);
                }
                else
                    await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status] = 'failed', [failure] = ?, [failedAt] = ?, [attemptHistory]=? WHERE [id] = ?")).run(boundedJobJson(failure, 8 * 1024, "JOB_FAILURE_TOO_LARGE", "Job failure metadata"), failedAt, JSON.stringify(history), row.id);
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
        await database.adapter.insertAppRow(table, values);
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
    const previousRow = (await database.adapter.selectAppRows(resolved.table, {
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
        await database.adapter.updateAppRow(resolved.table, id, {
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
function quoteIdentifier(identifier) {
    return `"${String(identifier).replaceAll('"', '""')}"`;
}
//# sourceMappingURL=server-runtime-source.js.map