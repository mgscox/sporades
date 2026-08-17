// `createHmac` left this line with the S3 signing path in batch 6: `s3Hmac` was its only remaining
// consumer, and it reaches the builtin through `process.getBuiltinModule` in `file-storage-runtime.ts`
// now (ADR-0042). The rest of this list has been wider than what this file binds since batch 3 —
// tsc elides an unused import, so the generated `dist/` has carried only what is actually called.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { validateMailConfig } from "./mail-config.js";
import { createMailRuntime } from "./mail-runtime.js";
import { createEmailEventEndpoints } from "./email-events-runtime.js";
import { assertJsonCompatible, commandError, invalidReferenceError } from "./runtime-errors.js";
import { PASSWORD_RESET_REQUEST_JOB, PASSWORD_RESET_THROTTLE_FIELD, PRIVILEGED_AUTH_USER_ID, authProvidersForClient, authStatus, confirmPasswordReset, createEmailPasswordResetLink, currentEmailSignInThrottleState, emailAuthDisabledError, emitAuthDeniedLog, mailNotConfiguredError, oauthProviderAdapter, prepareEmailPasswordResetDelivery, privilegedAuthUserId, readEndpointSessionToken, recordFailedEmailSignInAttempt, requireAuth, resolveAnonymousSession, serverAuthError, setEmailPassword, setOwnEmailPassword, verifyPasswordResetCode, } from "./auth-runtime.js";
// Batch 5. `createWebSocketHub` calls the two email entry points and `routeSporadesAuth` calls
// the identity link; all three left this file for `auth-runtime.ts` in that batch, once user
// preferences stopped holding them.
import { signInWithEmail, signUpWithEmail } from "./auth-runtime.js";
// Batch 8. `createWebSocketHub` starts an OAuth sign-in, and `openDevDatabase` and
// `sendEmailPasswordResetLink` read the reset-link configuration. Both left this file for
// `auth-runtime.ts` in that batch, once the HTTP layer stopped holding them.
import { beginOAuthSignIn, resolvePasswordResetConfig } from "./auth-runtime.js";
import { readCurrentUserPreferences, updateCurrentUserPreferences, } from "./user-preferences-runtime.js";
import { countTeamMembers, createAdditionalTeam, createCurrentUserTeamsApi, createPrivilegedTeamsApi, createTeamJoinLink, deleteCurrentUserTeam, demoteTeamMember, flushTeamSecurityEvents, inspectTeamJoinLink, joinCurrentUserTeam, leaveCurrentUserTeam, listCurrentUserTeams, listTeamJoinLinks, listTeamMembers, normalizeTeamApplicationRoles, promoteTeamMember, removeTeamMember, renameCurrentUserTeam, resolveTeamJoinLinkConfig, revokeTeamJoinLink, updateTeamMemberApplicationRoles, validateTeamJoinLink } from "./teams-runtime.js";
// Batch 8. Eight names, which is what the one function of that domain still in this file
// (`routeEndpoint`), plus `readEndpointBody`, `openDevDatabase` and `createWebSocketHub`, resolve.
// `routeEndpoint` takes the three writers and the failure log; `readEndpointBody` the body reader;
// `openDevDatabase` the body limit and the security policy; and `createWebSocketHub` the security
// policy, the WebSocket origin check and the request-origin resolver.
import { emitHttpFailureLog, readLimitedRequestBody, resolveHttpMaxBodyBytes, resolveOAuthRequestOrigin, resolveRuntimeSecurityPolicy, websocketOriginAllowed, writeEndpointError, writeEndpointResult, } from "./http-runtime.js";
import { isPromiseLike, thenIfPromise } from "./maybe-promise.js";
import { isSensitiveLogKey, logIndexLimit } from "./runtime-log-policy.js";
// Batch 9. One name, which is what is left of this file's relationship with the Database engines:
// `openDevDatabase` builds the Capsule's adapter with it. It was fifty-nine declarations in this
// file, and every domain above reached the engines through them.
import { createRuntimeDatabaseAdapter } from "./database-runtime.js";
import { deserializeFieldValue, deserializeRow, normalizeDateValue, serializeFieldValue } from "./stored-value-coding.js";
// Twenty-one names, which is what the three functions of that domain still in this file plus
// `openDevDatabase`, the endpoint table API, the schema extractor and the four mutation and message
// runners resolve. `ACL_HELPER_STATE` and `createTableAclContext` are deliberately not among them:
// both are exported from `acl-runtime.js` for consumers outside this file — the constant probe and
// `test/mail.test.js` — and reach them through the `export *` below rather than through a binding
// here, so importing them would declare a name nothing in this file reads.
import { applyReadAcl, assertActivePrivilegedJobAccess, createPrivilegedAuditEmitter, createPrivilegedAuditEmissionPublicError, createPrivilegedFileApi, createPrivilegedRunAbortError, createPrivilegedRunAuditDetails, createPrivilegedRunPublicError, createPrivilegedScheduleApi, drainPendingAclWrites, emitAclDeniedLog, emitPrivilegedRunAudit, filterRowsByReadAcl, grantPrivilegedDbAccess, isPrivilegedAuditEmissionPublicError, normalizeFileAcl, normalizePrivilegedRunSignal, normalizeTableAcl, reindexPrivilegedAuditEventsAfterRollback, revokePrivilegedDbAccess, runTableWriteWithAcl, safePrivilegedAuditErrorCode, } from "./acl-runtime.js";
import { createPendingFileUpload, createPublicFileUrl, createRuntimeFileStorageAdapter, deletePrivateFile, getPrivateFileUrl, revokePublicFileUrl, } from "./file-storage-runtime.js";
import { abortSchedulePayloadFactories, assertJobScheduleProvenance, boundedJobJson, cancelJob, commitPendingJobCancellationAborts, createRuntimeClock, decodeJobCursor, dropPendingJobCancellationAborts, encodeJobCursor, ensureJobStorage, ensureScheduleStorage, finishFailedScheduledOccurrence, invalidJobRetryPolicyFailure, isCanonicalJobTimestamp, jobActorProvider, jobError, jobHandlersFromCapsuleDefinition, jobState, jobSummary, jobTimestampAfter, nextScheduleOccurrence, normalizeJobAvailableAt, normalizeJobRetry, parsePersistedJobRetry, resolveSchedulePayload, resolveSchedulePayloadFactoryTimeoutMs, runtimeOwnedJobHandlers, safeJobFailure, scheduleDefinitionsFromCapsule, scheduledOccurrenceIdentity, } from "./jobs-runtime.js";
const mutationResultsWithWrites = new WeakSet();
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
// here too — including `targetsInternalLogIndexTable` and `readSqlTableReference`, which would
// otherwise have gone quietly "not comparable" there when the guard moved. A narrower re-export
// would move those guards' subjects out of reach and buy nothing: this is a name-resolution
// convenience, not a second definition.
export * from "./inspection-sql.js";
export * from "./log-index-guard.js";
// The mail domain left this file the same way, as batch 2 (ADR-0041). `createMailRuntime` is the one
// name the rest of this file reaches into it for — `openDevDatabase` builds the Capsule's mail
// runtime with it — where before there were twenty-six, because every helper of the domain had to be
// registered in the emitted function list to survive into a deployed Capsule. Twenty-one of them are
// private to that module now.
//
// Re-exported whole for the same reason as the two above: this module is still the address the rest
// of the repository knows, and `test/mail.test.js` resolves `buildSmtpMessage`, `createMailTransport`
// and `connectSmtpSocket` through here. Those three used to be found by searching the emitted
// function list by name, which answered `undefined` the moment a domain stopped being entries in it
// — the silent shape this re-export exists to prevent.
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
// by `auth-runtime.js`, and two private — one of which was exported for the two-bundle skew probe
// until ticket 05 deleted it. See `user-preferences-runtime.ts` for why the domain is exactly six
// and not the fifteen identifiers a name sweep for `preference` turns up.
//
// **This is the batch that let auth finish.** `migrateAnonymousPreferences` was the only thing
// keeping `rotateSessionOnAdapter` and `moveSessionToUserOnAdapter` — and through them
// `signInWithEmail`, `signUpWithEmail`, `linkProviderIdentity`, `rotateSession` and
// `moveSessionToUser` — in this file after batch 3. All seven moved to `auth-runtime.js`, so the
// three names imported from it above are the only part of that region this file still resolves.
// (`rotateSession` and `moveSessionToUser` no longer exist anywhere: batch 3 found nothing in the
// repository named them, and ticket 05 deleted the declarations.)
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
// The Log index's storage left this file as part of batch 9 — the `sporades_log_events` table, its
// additive migration, ADR-0036's runtime ordering sequence, and the three statements that write,
// prune and read it. Nine declarations, of which five are private now.
//
// **It is a domain ticket 04's nine batches never named**, and it is worth saying so here rather
// than only in the module. Batch 1 was the log-index *guard* — the four functions that conceal this
// table from `sporades db query` — and nothing in the sequence was ever scoped to the index itself.
// It surfaced as batch 9's blocker instead, because the only thing in the repository that calls it
// is the shared Database adapter method set, which is what batch 9 moves. Extracted rather than
// shrugged at, on the rule batch 6 established for `maybe-promise.ts`: a blocker owned by no batch
// on the list is not a later batch's and never will be. Left here it would have held
// `createSharedDatabaseAdapterMethods`, and through it every engine and every dialect.
//
// The platform log did not go with it, and the seam is the adapter. `createRuntimeLogSink` and
// `createRuntimeLogger` are still in this file and reach the index through
// `database.insertLogIndexEvent(…)`, `database.pruneLogIndex(…)` and `database.readRecentLogEvents(…)`
// — adapter methods resolved at run time, not module bindings — so that half of the logging domain
// cost this batch nothing and remains for ticket 05 to place.
//
// Re-exported whole for the reason the twelve above are. It declares no SCREAMING_CASE constant, so
// it adds nothing to the constant probe.
export * from "./log-index-storage.js";
// The Database adapters and dialect left this file as batch 9, the last domain of ticket 04's nine
// and the one deliberately sequenced last: every other domain reaches an engine through it, so
// moving it earlier would have put a module boundary under every batch before it. Fifty-nine
// declarations — the three engines, ADR-0037's dialect and normalization seam, the one shared method
// set every behavioural call goes through, and the app-schema DDL that method set emits — of which
// thirty-eight are private now.
//
// **All fifty-nine moved.** Closing this domain's reference graph left nine names outside it and not
// one of them reaches the composition core, which is the first time that has been true since batch 4.
// One name is imported above, which is the whole of what this file still resolves in it.
//
// Re-exported whole for the reason the thirteen above are, and this batch has the widest set of
// consumers that makes it load-bearing rather than convenient: `src/cli/sporades.ts` resolves
// `createSqliteDatabaseAdapter`, `createPostgresConnection` and the three `sporades db` delegates
// through here; the generated bundle's boot program resolves `createRuntimeInspectionAdapter`; and
// `test/database-adapter-engine-seam.test.js` — the file that verifies ADR-0037's seam holds —
// resolves the two dialects, the three normalizations, both factories, the shared method set and two
// SQL walkers through here. This domain declares no SCREAMING_CASE constant, so it adds nothing to
// the constant probe.
export * from "./database-runtime.js";
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
// The emitted function list stood here: 537 entries at its largest, 107 at the end, each one a
// runtime function the generated Capsule bundle carried as `fn.toString()`. Ticket 05 deleted it
// along with the builder that read it.
//
// It is worth being precise about what it cost, because the cost was structural rather than untidy.
// A function reached the bundle as detached source text, so it could not call a helper that was not
// itself registered, could not close over a module constant, and a name that failed to travel was a
// `ReferenceError` in a deployed Capsule rather than a build error — invisible to a green suite,
// because tests import from `dist/` where every name resolves. Four bindings shipped that way. The
// list was also a global registry every one of those functions was implicitly coupled to, so adding
// or removing a function was a cross-cutting edit, and the runtime could not be split into files.
//
// ADR-0038 is the bill: the read-only inspection gate's lexing rules existed in five copies, because
// factoring them into a shared helper was the one thing this mechanism forbade, and each fix landed
// in one copy and left the siblings.
//
// Everything in this file now reaches a deployed Capsule the ordinary way — `server-bundle-entry.ts`
// imports what it calls, and esbuild follows the graph.
export async function shutdownAndCloseDatabase(database) {
    let shutdownError;
    let closeError;
    let shutdownRejected = false;
    let closeRejected = false;
    try {
        await database.shutdown();
    }
    catch (error) {
        shutdownRejected = true;
        shutdownError = error;
    }
    try {
        await database.close();
    }
    catch (error) {
        closeRejected = true;
        closeError = error;
    }
    if (shutdownRejected && closeRejected) {
        throw new AggregateError([shutdownError, closeError], "Runtime shutdown and database closure both failed.");
    }
    if (shutdownRejected)
        throw shutdownError;
    if (closeRejected)
        throw closeError;
}
export async function shutdownHttpServerAndRuntime(server, shutdownRuntime) {
    let serverError;
    let runtimeError;
    let serverRejected = false;
    let runtimeRejected = false;
    try {
        await new Promise((resolve, reject) => {
            try {
                server.close((error) => error ? reject(error) : resolve());
            }
            catch (error) {
                reject(error);
            }
        });
    }
    catch (error) {
        serverRejected = true;
        serverError = error;
    }
    try {
        await shutdownRuntime();
    }
    catch (error) {
        runtimeRejected = true;
        runtimeError = error;
    }
    if (serverRejected && runtimeRejected) {
        throw new AggregateError([serverError, runtimeError], "HTTP server closure and runtime shutdown both failed.");
    }
    if (serverRejected)
        throw serverError;
    if (runtimeRejected)
        throw runtimeError;
}
export async function replaceRuntimeDatabase(currentDatabase, candidateDatabase) {
    try {
        await candidateDatabase.init();
    }
    catch (initError) {
        try {
            await candidateDatabase.close();
        }
        catch (closeError) {
            throw new AggregateError([initError, closeError], "Runtime initialization and candidate database closure both failed.");
        }
        throw initError;
    }
    try {
        await shutdownAndCloseDatabase(currentDatabase);
    }
    catch (teardownError) {
        // Candidate initialization is the ownership decision. The old runtime may
        // already be stopped and its adapter has been closed by the teardown helper,
        // so rejecting here would leave the Dev server pointing at a dead runtime
        // while also destroying its only viable replacement.
        try {
            const warning = candidateDatabase.log?.emit?.({
                category: "platform",
                event: "dev.runtime.previous_teardown_failed",
                level: "warn",
                message: "Previous Dev runtime teardown failed after replacement",
                data: { code: String(teardownError?.code ?? "RUNTIME_TEARDOWN_FAILED").slice(0, 80) },
            });
            // Ownership must return to the caller without waiting for logging I/O;
            // otherwise requests can still observe the already-closed prior runtime.
            Promise.resolve(warning).catch(() => { });
        }
        catch { }
        return candidateDatabase;
    }
    return candidateDatabase;
}
export async function openDevDatabase(databasePath, serverSource, serverEnv = {}, config = {}, capsuleDefinition = null, options = {}) {
    if (capsuleDefinition?.teams !== undefined && (!capsuleDefinition.teams || typeof capsuleDefinition.teams !== "object" || Array.isArray(capsuleDefinition.teams))) {
        throw commandError("Invalid Capsule Teams declaration.", "Declare teams as { appRoles?: string[], admitJoin?: function }.", "INVALID_TEAM_APPLICATION_ROLES");
    }
    if (capsuleDefinition?.teams?.admitJoin !== undefined && typeof capsuleDefinition.teams.admitJoin !== "function") {
        throw commandError("Invalid Capsule Team admission policy.", "Declare teams.admitJoin as a server function.", "INVALID_TEAM_JOIN_ADMISSION");
    }
    const teamApplicationRoles = normalizeTeamApplicationRoles(capsuleDefinition?.teams?.appRoles);
    if (capsuleDefinition?.files !== undefined && (!capsuleDefinition.files || typeof capsuleDefinition.files !== "object" || Array.isArray(capsuleDefinition.files))) {
        throw commandError("Invalid Capsule Files declaration.", "Declare files as { acl?: { read?, publicUrl?, delete? } }.", "INVALID_FILE_ACL");
    }
    const fileAcl = normalizeFileAcl(capsuleDefinition?.files?.acl);
    const path = await import("node:path");
    const mailConfig = validateMailConfig(config.mail);
    let mailLogSink;
    const mail = createMailRuntime(mailConfig, serverEnv, {
        ...options,
        mailLog: options.mailLog ?? ((event) => mailLogSink?.emit(event)),
    });
    const capsuleEndpoints = capsuleDefinition
        ? endpointHandlersFromCapsuleDefinition(capsuleDefinition)
        : extractEndpoints(serverSource);
    const emailEventEndpoints = createEmailEventEndpoints(mailConfig, serverEnv, capsuleDefinition?.emailEvents);
    for (const [providerIndex, providerEndpoint] of emailEventEndpoints.entries()) {
        const conflictsWithCapsule = capsuleEndpoints.some((endpoint) => endpoint.method === providerEndpoint.method && endpoint.path === providerEndpoint.path);
        const conflictsWithProvider = emailEventEndpoints.slice(0, providerIndex).some((endpoint) => endpoint.method === providerEndpoint.method && endpoint.path === providerEndpoint.path);
        if (conflictsWithCapsule || conflictsWithProvider) {
            const error = new Error("Capsule endpoint conflicts with an email-provider webhook route.");
            error.code = "EMAIL_EVENT_ROUTE_CONFLICT";
            error.hint = "Assign every Capsule endpoint and enabled email provider a different path in sporades.json.";
            throw error;
        }
    }
    const endpoints = [...capsuleEndpoints, ...emailEventEndpoints];
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
    const queries = extractQueryHandlersFromCapsule(capsuleDefinition) ?? extractQueryHandlers(serverSource);
    const mutations = (capsuleDefinition
        ? mutationHandlersFromCapsuleDefinition(serverSource, capsuleDefinition)
        : extractMutationHandlers(serverSource));
    const messages = extractMessageHandlers(serverSource);
    let database;
    const jobs = [...jobHandlersFromCapsuleDefinition(capsuleDefinition), ...runtimeOwnedJobHandlers({
            prepareEmailPasswordResetDelivery: (context, payload) => prepareEmailPasswordResetDelivery(database, payload, database.__runtimeJobAttempts.get(context) ?? 1),
        })];
    const schedules = scheduleDefinitionsFromCapsule(capsuleDefinition, jobs);
    const clock = createRuntimeClock(options?.clock);
    const contextMiddleware = extractContextMiddleware(serverSource);
    const mutationHooks = extractMutationHooks(serverSource);
    const lifecycleHooks = { init: capsuleDefinition?.hooks?.init, shutdown: capsuleDefinition?.hooks?.shutdown };
    const rowCache = new Map();
    database = {
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
        scheduleReconciliationFault: options?.scheduleReconciliationFault,
        jobRecoveryFault: options?.jobRecoveryFault,
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
        __runtimeJobAttempts: new WeakMap(),
        __handlerContextMappingCount: 0,
        rowCache,
        serverEnv,
        mail,
        authConfig: authStatus(config, serverEnv),
        passwordResetConfig: resolvePasswordResetConfig(config),
        teamJoinLinkConfig: resolveTeamJoinLinkConfig(config),
        teamApplicationRoles,
        teamJoinAdmission: capsuleDefinition?.teams?.admitJoin,
        createTeamJoinAdmissionContext(transactionAdapter, auth) {
            return createTeamJoinAdmissionContext(createTransactionDatabase(database, transactionAdapter), auth);
        },
        fileAcl,
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
            const workerSettlement = stopCurrentUserJobWorker(database);
            const scheduleSettlement = settleActiveScheduleWork(database);
            const closeResources = () => {
                const failures = [];
                const pending = [];
                const resources = [
                    () => database.mail.close(),
                    () => database.adapter.close(),
                    () => database.fileStorage.close(),
                ];
                for (const [index, closeResource] of resources.entries()) {
                    const captureFailure = (error) => {
                        failures.push({ index, error });
                    };
                    try {
                        const result = closeResource();
                        if (result && typeof result.then === "function") {
                            pending.push(Promise.resolve(result).then(undefined, captureFailure));
                        }
                    }
                    catch (error) {
                        captureFailure(error);
                    }
                }
                const finish = () => {
                    const errors = failures.sort((left, right) => left.index - right.index).map(({ error }) => error);
                    if (errors.length > 1)
                        throw new AggregateError(errors, "Multiple runtime resources failed to close.");
                    if (errors.length === 1)
                        throw errors[0];
                };
                return pending.length > 0 ? Promise.all(pending).then(finish) : finish();
            };
            const runtimeSettlements = [workerSettlement, scheduleSettlement].filter(Boolean).map((settlement) => Promise.resolve(settlement));
            if (runtimeSettlements.length === 0)
                return closeResources();
            return (async () => {
                let workerError;
                let closeError;
                let workerRejected = false;
                let closeRejected = false;
                try {
                    await Promise.all(runtimeSettlements);
                }
                catch (error) {
                    workerRejected = true;
                    workerError = error;
                }
                try {
                    await closeResources();
                }
                catch (error) {
                    closeRejected = true;
                    closeError = error;
                }
                if (workerRejected && closeRejected)
                    throw new AggregateError([workerError, closeError], "Runtime settlement and resource closure both failed.");
                if (workerRejected)
                    throw workerError;
                if (closeRejected)
                    throw closeError;
            })();
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
        database.__jobStopped = false;
        database.__scheduleTimers = new Set();
        database.__activeScheduleOccurrences = new Set();
        database.__scheduleRecoveryTimer = null;
        database.__scheduleRecoveryDueAt = null;
        database.__scheduleRecoveryPromise = null;
        await armJobLeaseRecovery(database);
        await recoverPendingScheduleOccurrences(database, { validateOnly: true });
        const reconciled = await reconcileSchedules(database, () => startStaticSchedules(database));
        // Orderly shutdown deliberately retains queued and delayed Jobs. A fresh
        // runtime has no inherited worker/wake timer, so one normal worker pass
        // must rediscover ready work and recreate the earliest delayed wake.
        scheduleCurrentUserJobWorker(database);
        database.__runtimeInitialized = true;
        await recoverReconciledSchedules(database, reconciled.recoveredOccurrences);
    };
    database.shutdown = () => {
        if (database.__shutdownPromise)
            return database.__shutdownPromise;
        database.__shutdownPromise = (async () => {
            let shutdownError;
            let mailCloseError;
            let shutdownRejected = false;
            let mailCloseRejected = false;
            try {
                database.__scheduleStopped = true;
                const workerSettlement = stopCurrentUserJobWorker(database);
                abortSchedulePayloadFactories(database);
                for (const timer of database.__scheduleTimers ?? [])
                    database.clock.clearTimer(timer);
                database.__scheduleTimers?.clear?.();
                database.__scheduleRecoveryTimer = null;
                database.__scheduleRecoveryDueAt = null;
                if (workerSettlement)
                    await workerSettlement;
                await settleActiveScheduleWork(database);
                if (database.__runtimeInitialized && database.lifecycleHooks.shutdown !== undefined) {
                    if (typeof database.lifecycleHooks.shutdown !== "function")
                        throw commandError("Invalid Capsule shutdown hook.", "Declare hooks.shutdown as a function.");
                    await database.lifecycleHooks.shutdown(createMutationContext(database, { userId: "__lifecycle__", displayName: "Capsule lifecycle", email: null, picture: null, isAuthenticated: false, isGuest: false, provider: "lifecycle" }));
                }
            }
            catch (error) {
                shutdownRejected = true;
                shutdownError = error;
            }
            finally {
                database.__runtimeInitialized = false;
            }
            try {
                await database.mail.close();
            }
            catch (error) {
                mailCloseRejected = true;
                mailCloseError = error;
            }
            if (shutdownRejected && mailCloseRejected) {
                throw new AggregateError([shutdownError, mailCloseError], "Runtime shutdown and mail closure both failed.");
            }
            if (shutdownRejected)
                throw shutdownError;
            if (mailCloseRejected)
                throw mailCloseError;
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
    await sqlite.ensureTeamsStorage();
    await ensureJobStorage(sqlite);
    await ensureScheduleStorage(sqlite, options?.scheduleStorageFault);
    await sqlite.ensureFileStorage();
    await sqlite.ensureLogStorage();
    await recoverInvalidRetainedJobState(database);
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
async function reconcileSchedules(database, beforeCommit) {
    const now = database.clock.now();
    const declaredNames = new Set(database.schedules.map((definition) => definition.name));
    for (let attempt = 0;; attempt += 1) {
        let candidateArmed = false;
        try {
            return await database.adapter.withTransaction(async (transactionAdapter) => {
                const sql = transactionAdapter.dialect.sql;
                // Serialize the complete declaration set, including an empty set. Per-row
                // locks cannot make removal and first declaration one publication boundary.
                await transactionAdapter.prepare(sql("UPDATE [sporades] SET [value]=[value] WHERE [key]='schedule-reconciliation-lock'")).run();
                const persisted = await transactionAdapter.prepare(sql("SELECT * FROM [sporades_schedules]")).all();
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
                    plans.push({ definition, row, nextOccurrence, recoveredOccurrence, generationToken: randomUUID() });
                }
                // Every declaration, including calendars with no possible future instant,
                // has now been evaluated without mutating durable state.
                for (const row of persisted) {
                    if (!declaredNames.has(String(row.name)))
                        await transactionAdapter.prepare(sql("DELETE FROM [sporades_schedules] WHERE [name]=?")).run(row.name);
                }
                const updateScheduleSql = sql("UPDATE [sporades_schedules] SET [definitionFingerprint]=?, [generationToken]=?, [expression]=?, [effectiveTimezone]=?, " +
                    "[missedRunPolicy]=?, [enabled]=?, [nextOccurrence]=? WHERE [name]=?");
                for (const { definition, row, nextOccurrence, generationToken } of plans) {
                    // Every successful runtime publication receives a fresh incarnation. A
                    // same-definition restart transfers only its still-pending work; changed,
                    // disabled, removed, and later-restored generations never inherit it.
                    const sameEnabledDefinition = Boolean(row) && Boolean(row.enabled) && definition.enabled
                        && row.definitionFingerprint === definition.fingerprint;
                    definition.__adoptLegacyPendingOccurrences = sameEnabledDefinition;
                    if (row) {
                        await database.scheduleReconciliationFault?.("before-generation-lock", { scheduleName: definition.name });
                        // Lock and rotate the durable Schedule before scanning its pending
                        // work. An outgoing claim holds this row until its occurrence insert
                        // commits, so the transfer below cannot miss that insert on Postgres.
                        await transactionAdapter.prepare(updateScheduleSql).run(definition.fingerprint, generationToken, definition.expression, definition.effectiveTimezone, definition.missedRun, definition.enabled ? 1 : 0, nextOccurrence, definition.name);
                    }
                    else {
                        await transactionAdapter.prepare(sql("INSERT INTO [sporades_schedules] ([name], [definitionFingerprint], [generationToken], [expression], [effectiveTimezone], [missedRunPolicy], [enabled], [nextOccurrence]) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")).run(definition.name, definition.fingerprint, generationToken, definition.expression, definition.effectiveTimezone, definition.missedRun, definition.enabled ? 1 : 0, nextOccurrence);
                    }
                    if (sameEnabledDefinition) {
                        await transactionAdapter.prepare(sql("UPDATE [sporades_schedule_occurrences] SET [definitionFingerprint]=?, [generationToken]=? WHERE [scheduleName]=? AND [status]='pending' AND (([definitionFingerprint]=? AND ([generationToken]=? OR ([generationToken] IS NULL AND ? IS NULL))) OR ([definitionFingerprint] IS NULL AND [generationToken] IS NULL))")).run(definition.fingerprint, generationToken, definition.name, definition.fingerprint, row.generationToken ?? null, row.generationToken ?? null);
                    }
                    definition.nextOccurrence = nextOccurrence;
                    definition.generationToken = generationToken;
                }
                candidateArmed = true;
                await beforeCommit?.();
                return { recoveredOccurrences: plans.filter(({ recoveredOccurrence }) => recoveredOccurrence).map(({ definition, recoveredOccurrence }) => ({ definition, recoveredOccurrence })) };
            });
        }
        catch (error) {
            // node:sqlite operations are synchronous. A busy timeout would block the
            // event loop and prevent the owning candidate from reaching COMMIT, so
            // overlapping candidates yield and retry the not-yet-published attempt.
            if (candidateArmed || database.adapter.engine !== "sqlite" || attempt >= 100 || !String(error?.message ?? "").includes("database is locked"))
                throw error;
            await new Promise((resolve) => setTimeout(resolve, Math.min(25, attempt + 1)));
        }
    }
}
async function recoverReconciledSchedules(database, recoveredOccurrences) {
    try {
        for (const { definition, recoveredOccurrence } of recoveredOccurrences) {
            await recordScheduledOccurrence(database, definition, recoveredOccurrence);
        }
        await recoverPendingScheduleOccurrences(database);
    }
    catch (error) {
        try {
            await database.log.emit({ category: "platform", event: "schedule.occurrence.recovery_failed", level: "error", message: "Pending Scheduled occurrence recovery failed", data: { code: String(error?.code ?? "SCHEDULE_RECOVERY_FAILED").slice(0, 80) } });
        }
        catch { }
        if (!database.__scheduleStopped)
            schedulePendingOccurrenceRecovery(database, new Date(database.clock.now().getTime() + SCHEDULE_RECOVERY_RETRY_MS).toISOString());
    }
}
const MAX_NATIVE_TIMER_DELAY_MS = 2_147_483_647;
const SCHEDULE_RECOVERY_RETRY_MS = 1_000;
function settleActiveScheduleWork(database) {
    const active = new Set(database.__activeScheduleOccurrences ?? []);
    if (database.__scheduleRecoveryPromise)
        active.add(database.__scheduleRecoveryPromise);
    if (active.size === 0)
        return undefined;
    return Promise.allSettled([...active]).then(() => undefined);
}
async function startStaticSchedules(database) {
    database.__scheduleTimers ??= new Set();
    database.__activeScheduleOccurrences ??= new Set();
    for (const definition of database.schedules) {
        if (!definition.enabled)
            continue;
        const arm = () => {
            if (database.__scheduleStopped || !definition.enabled)
                return;
            const occurrence = new Date(definition.nextOccurrence);
            const timer = database.clock.setTimer(() => {
                database.__scheduleTimers.delete(timer);
                // Native timers clamp delays above 2^31-1 milliseconds to one
                // millisecond. Long recurrences therefore wake in bounded chunks and
                // must prove the nominal occurrence is due before creating durable
                // Schedule or Job state.
                if (occurrence.getTime() > database.clock.now().getTime()) {
                    arm();
                    return;
                }
                const active = recordScheduledOccurrence(database, definition, occurrence).catch(async (error) => {
                    database.log.emit({ category: "platform", event: "schedule.occurrence.enqueue_failed", level: "error", message: "Scheduled occurrence could not enqueue its Job", data: { scheduleName: definition.name, scheduledFor: occurrence.toISOString(), code: String(error?.code ?? "SCHEDULE_ENQUEUE_FAILED").slice(0, 80) } });
                }).finally(() => {
                    database.__activeScheduleOccurrences.delete(active);
                    if (database.__scheduleStopped)
                        return;
                    arm();
                });
                database.__activeScheduleOccurrences.add(active);
                return active;
            }, Math.min(MAX_NATIVE_TIMER_DELAY_MS, Math.max(0, occurrence.getTime() - database.clock.now().getTime())));
            database.__scheduleTimers.add(timer);
        };
        arm();
    }
}
async function recordScheduledOccurrence(database, definition, occurrence) {
    const claim = await claimScheduledOccurrence(database, definition, occurrence);
    if (!claim) {
        // Another runtime owns this exact occurrence. Advance only this runtime's
        // timer cursor; the winner owns durable Schedule bookkeeping.
        definition.nextOccurrence = nextScheduleOccurrence(definition.fields, occurrence, definition.effectiveTimezone).toISOString();
        return null;
    }
    let transactionContext;
    try {
        const scheduledFor = occurrence.toISOString();
        await database.scheduleOccurrenceFault?.("after-pending", { scheduleName: definition.name, scheduledFor });
        // Payload code is deliberately outside the ownership transaction: it can
        // take up to the configured five-minute bound and may be evaluated again
        // after lease recovery. Only its durable effects require live ownership.
        const payloadContext = createScheduleMutationContext(database, definition, scheduledFor);
        const payload = await resolveSchedulePayload(database, definition, scheduledFor, payloadContext);
        const committed = await database.adapter.withTransaction(async (transactionAdapter) => {
            const transactionDatabase = createTransactionDatabase(database, transactionAdapter);
            const sql = transactionAdapter.dialect.sql;
            const ownership = await transactionAdapter.prepare(sql("UPDATE [sporades_schedule_occurrences] SET [updatedAt]=[updatedAt] WHERE [id]=? AND [status]='pending' AND [claimToken]=? AND [definitionFingerprint]=? AND [generationToken]=?")).run(claim.id, claim.token, definition.fingerprint, definition.generationToken);
            if (Number(ownership.changes) !== 1)
                return { owned: false, state: null, next: null };
            // Lock and revalidate the current Schedule generation before any durable
            // Job side effect. Dev replacement initializes the candidate before
            // stopping the old runtime, so a name alone is not an ownership token.
            const generation = await transactionAdapter.prepare(sql("UPDATE [sporades_schedules] SET [name]=[name] WHERE [name]=? AND [enabled]=1 AND [definitionFingerprint]=? AND [generationToken]=?")).run(definition.name, definition.fingerprint, definition.generationToken);
            if (Number(generation.changes) !== 1) {
                const completedAt = database.clock.now().toISOString();
                const superseded = await transactionAdapter.prepare(sql("UPDATE [sporades_schedule_occurrences] SET [status]='enqueue-failed', [claimToken]=NULL, [claimExpiresAt]=NULL, [jobId]=NULL, [errorCode]='SCHEDULE_OCCURRENCE_SUPERSEDED', [updatedAt]=? WHERE [id]=? AND [status]='pending' AND [claimToken]=? AND [definitionFingerprint]=? AND [generationToken]=?")).run(completedAt, claim.id, claim.token, definition.fingerprint, definition.generationToken);
                if (Number(superseded.changes) !== 1)
                    throw new Error("Schedule occurrence ownership changed during generation invalidation.");
                return { owned: true, state: null, next: null, superseded: true };
            }
            let handlerFailed = false;
            try {
                let state = null;
                if (payload.ok) {
                    transactionContext = createScheduleMutationContext(transactionDatabase, definition, scheduledFor);
                    state = await enqueueResolvedScheduledOccurrence(transactionDatabase, definition, scheduledFor, payload.value, transactionContext);
                    await database.scheduleOccurrenceFault?.("after-enqueue", { scheduleName: definition.name, scheduledFor, jobId: state.id });
                }
                const completedAt = database.clock.now().toISOString();
                const outcome = state ? "enqueued" : "payload-failed";
                const errorCode = state ? null : "SCHEDULE_PAYLOAD_FAILED";
                const terminal = await transactionAdapter.prepare(sql("UPDATE [sporades_schedule_occurrences] SET [status]=?, [claimToken]=NULL, [claimExpiresAt]=NULL, [jobId]=?, [errorCode]=?, [updatedAt]=? WHERE [id]=? AND [status]='pending' AND [claimToken]=? AND [definitionFingerprint]=? AND [generationToken]=?")).run(outcome, state?.id ?? null, errorCode, completedAt, claim.id, claim.token, definition.fingerprint, definition.generationToken);
                if (Number(terminal.changes) !== 1)
                    throw new Error("Schedule occurrence ownership changed during its owned transaction.");
                const next = nextScheduleOccurrence(definition.fields, occurrence, definition.effectiveTimezone).toISOString();
                const summary = await transactionAdapter.prepare(sql("UPDATE [sporades_schedules] SET [nextOccurrence]=?, [latestScheduledFor]=?, [latestOutcome]=?, [latestJobId]=?, [latestErrorCode]=? WHERE [name]=? AND [enabled]=1 AND [definitionFingerprint]=? AND [generationToken]=?")).run(next, scheduledFor, outcome, state?.id ?? null, errorCode, definition.name, definition.fingerprint, definition.generationToken);
                if (Number(summary.changes) !== 1)
                    throw new Error("Schedule definition changed during occurrence finalization.");
                return { owned: true, state, next };
            }
            catch (error) {
                handlerFailed = true;
                throw error;
            }
            finally {
                await cleanupTransactionHandler(transactionDatabase, transactionContext, handlerFailed);
            }
        });
        if (!committed.owned) {
            dropPendingJobDispatch(transactionContext);
            return null;
        }
        if (committed.superseded)
            definition.enabled = false;
        else
            definition.nextOccurrence = committed.next;
        await dispatchPendingJobs(transactionContext);
        return committed.state;
    }
    catch (error) {
        dropPendingJobDispatch(transactionContext);
        if (!database.__scheduleStopped) {
            const failed = await database.adapter.withTransaction((transactionAdapter) => finishFailedScheduledOccurrence({ ...database, adapter: transactionAdapter }, definition, occurrence, error, claim.token));
            if (failed.superseded)
                definition.enabled = false;
            else if (failed.finished)
                definition.nextOccurrence = failed.nextOccurrence;
        }
        throw error;
    }
}
async function claimScheduledOccurrence(database, definition, occurrence) {
    const scheduledFor = occurrence.toISOString();
    const id = scheduledOccurrenceIdentity(database, definition.name, scheduledFor);
    const token = randomUUID();
    const now = database.clock.now();
    const nowIso = now.toISOString();
    const expiresAt = jobTimestampAfter(now, RUNTIME_CLAIM_LEASE_MS);
    if (expiresAt === null) {
        throw commandError("Schedule occurrence claim exceeds the runtime timestamp domain.", "Run the Schedule before the end of the supported four-digit UTC timestamp range.", "SCHEDULE_TIME_DOMAIN_EXHAUSTED");
    }
    let recoveryAt = null;
    const claimed = await database.adapter.withTransaction(async (transactionAdapter) => {
        const sql = transactionAdapter.dialect.sql;
        // The durable enabled Schedule row, not this runtime's captured declaration,
        // owns the generation. Lock it before touching the occurrence so an outgoing
        // runtime can only stop itself after a replacement has reconciled the name.
        const generation = await transactionAdapter.prepare(sql("UPDATE [sporades_schedules] SET [name]=[name] WHERE [name]=? AND [enabled]=1 AND [definitionFingerprint]=? AND [generationToken]=?")).run(definition.name, definition.fingerprint, definition.generationToken);
        if (Number(generation.changes) !== 1)
            return { claim: null, superseded: true };
        await database.scheduleOccurrenceFault?.("after-generation-lock", { scheduleName: definition.name, scheduledFor });
        const inserted = await transactionAdapter.prepare(sql("INSERT INTO [sporades_schedule_occurrences] ([id], [scheduleName], [definitionFingerprint], [generationToken], [scheduledFor], [status], [claimToken], [claimExpiresAt], [createdAt], [updatedAt]) " +
            "VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?) ON CONFLICT DO NOTHING")).run(id, definition.name, definition.fingerprint, definition.generationToken, scheduledFor, token, expiresAt, nowIso, nowIso);
        if (Number(inserted.changes) === 1)
            return { claim: { id, token }, superseded: false };
        let existing = await transactionAdapter.prepare(sql("SELECT [id], [status], [scheduleName], [definitionFingerprint], [generationToken], [scheduledFor], [claimToken], [claimExpiresAt], [errorCode] FROM [sporades_schedule_occurrences] WHERE [id]=?")).get(id);
        if (!existing) {
            // A retained row with a forged id can still occupy the unique
            // (scheduleName, scheduledFor) key. Treat that row as the failed claim
            // target instead of turning a recoverable retained-state defect into a
            // startup or timer-loop failure.
            existing = await transactionAdapter.prepare(sql("SELECT [id], [status], [scheduleName], [definitionFingerprint], [generationToken], [scheduledFor], [claimToken], [claimExpiresAt], [errorCode] FROM [sporades_schedule_occurrences] WHERE [scheduleName]=? AND [scheduledFor]=?")).get(definition.name, scheduledFor);
            if (!existing)
                throw new Error("Schedule occurrence conflict could not be resolved.");
        }
        if (!validRetainedScheduleOccurrenceIdentity(database, existing)
            || String(existing.scheduleName) !== definition.name
            || String(existing.scheduledFor) !== scheduledFor
            || (existing.claimExpiresAt !== null && !isCanonicalJobTimestamp(existing.claimExpiresAt))) {
            await finishInvalidRetainedScheduleOccurrence(database, existing, transactionAdapter);
            return { claim: null, superseded: false };
        }
        // A still-live v0.8.5 runtime can insert after the finite upgrade scan
        // because it does not know the reconciliation lock or identity columns.
        // Bind only a pending, wholly legacy row to a durable same-definition restart;
        // changed, disabled, removed, and restored generations never receive this flag.
        if (existing.status === "pending"
            && existing.definitionFingerprint === null
            && existing.generationToken === null
            && definition.__adoptLegacyPendingOccurrences === true) {
            const adopted = await transactionAdapter.prepare(sql("UPDATE [sporades_schedule_occurrences] SET [definitionFingerprint]=?, [generationToken]=?, [updatedAt]=? WHERE [id]=? AND [scheduleName]=? AND [scheduledFor]=? AND [status]='pending' AND [definitionFingerprint] IS NULL AND [generationToken] IS NULL")).run(definition.fingerprint, definition.generationToken, nowIso, existing.id, definition.name, scheduledFor);
            if (Number(adopted.changes) === 1) {
                existing = { ...existing, definitionFingerprint: definition.fingerprint, generationToken: definition.generationToken, updatedAt: nowIso };
            }
            else {
                existing = await transactionAdapter.prepare(sql("SELECT [id], [status], [scheduleName], [definitionFingerprint], [generationToken], [scheduledFor], [claimToken], [claimExpiresAt], [errorCode] FROM [sporades_schedule_occurrences] WHERE [id]=?")).get(existing.id);
                if (!existing)
                    return { claim: null, superseded: false };
            }
        }
        if (existing.definitionFingerprint !== definition.fingerprint || existing.generationToken !== definition.generationToken) {
            // This occurrence was created before the live generation reconciled. It
            // belongs to the replaced definition and must not be reinterpreted under
            // the new payload or cadence. The durable generation lock above ensures a
            // stale caller can never apply this transition to replacement-owned work.
            if (existing.status === "pending")
                await finishSupersededRetainedScheduleOccurrence(database, existing, transactionAdapter);
            return { claim: null, superseded: false };
        }
        if (existing.status !== "pending")
            return { claim: null, superseded: false };
        if (existing.claimExpiresAt && existing.claimExpiresAt > nowIso) {
            recoveryAt = existing.claimExpiresAt;
            return { claim: null, superseded: false };
        }
        const result = await transactionAdapter.prepare(sql("UPDATE [sporades_schedule_occurrences] SET [claimToken]=?, [claimExpiresAt]=?, [updatedAt]=? WHERE [id]=? AND [status]='pending' AND [definitionFingerprint]=? AND [generationToken]=? AND ([claimExpiresAt] IS NULL OR [claimExpiresAt] <= ?)")).run(token, expiresAt, nowIso, id, definition.fingerprint, definition.generationToken, nowIso);
        return { claim: Number(result.changes) === 1 ? { id, token } : null, superseded: false };
    });
    if (claimed.superseded)
        definition.enabled = false;
    if (recoveryAt !== null)
        schedulePendingOccurrenceRecovery(database, recoveryAt);
    return claimed.claim;
}
async function recoverPendingScheduleOccurrences(database, options = {}) {
    const sql = database.adapter.dialect.sql;
    const rows = await database.adapter.prepare(sql("SELECT [id], [scheduleName], [definitionFingerprint], [generationToken], [scheduledFor], [claimToken], [claimExpiresAt] FROM [sporades_schedule_occurrences] WHERE [status]='pending' ORDER BY [scheduledFor] ASC, [scheduleName] ASC")).all();
    const nowMs = database.clock.now().getTime();
    let earliestFutureClaimAt = null;
    for (const row of rows) {
        if (!validRetainedScheduleOccurrenceIdentity(database, row)
            || (row.claimExpiresAt !== null && !isCanonicalJobTimestamp(row.claimExpiresAt))) {
            if (!options.validateOnly)
                await finishInvalidRetainedScheduleOccurrence(database, row);
            continue;
        }
        const durable = await database.adapter.prepare(sql("SELECT [definitionFingerprint], [generationToken], [enabled] FROM [sporades_schedules] WHERE [name]=?")).get(row.scheduleName);
        if (options.validateOnly)
            continue;
        const definition = database.schedules.find((candidate) => candidate.enabled && candidate.name === row.scheduleName);
        if (!durable || !Boolean(durable.enabled)) {
            await finishSupersededRetainedScheduleOccurrence(database, row);
            continue;
        }
        if (!definition || definition.fingerprint !== durable.definitionFingerprint || definition.generationToken !== durable.generationToken) {
            if (definition)
                definition.enabled = false;
            continue;
        }
        if (row.definitionFingerprint !== durable.definitionFingerprint || row.generationToken !== durable.generationToken) {
            await recordScheduledOccurrence(database, definition, new Date(row.scheduledFor));
            continue;
        }
        const claimExpiresAt = row.claimExpiresAt === null ? null : Date.parse(row.claimExpiresAt);
        if (claimExpiresAt !== null && claimExpiresAt > nowMs) {
            earliestFutureClaimAt = earliestFutureClaimAt === null ? claimExpiresAt : Math.min(earliestFutureClaimAt, claimExpiresAt);
            continue;
        }
        await recordScheduledOccurrence(database, definition, new Date(row.scheduledFor));
    }
    if (earliestFutureClaimAt !== null)
        schedulePendingOccurrenceRecovery(database, new Date(earliestFutureClaimAt).toISOString());
}
function validRetainedScheduleOccurrenceIdentity(database, row) {
    return typeof row.id === "string" && row.id.length > 0
        && typeof row.scheduleName === "string" && row.scheduleName.length > 0
        && isCanonicalJobTimestamp(row.scheduledFor)
        && row.id === scheduledOccurrenceIdentity(database, row.scheduleName, row.scheduledFor);
}
async function finishInvalidRetainedScheduleOccurrence(database, row, adapter = database.adapter) {
    return finishRetainedScheduleOccurrence(database, row, "SCHEDULE_OCCURRENCE_INVALID", adapter);
}
async function finishSupersededRetainedScheduleOccurrence(database, row, adapter = database.adapter) {
    return finishRetainedScheduleOccurrence(database, row, "SCHEDULE_OCCURRENCE_SUPERSEDED", adapter);
}
async function finishRetainedScheduleOccurrence(database, row, errorCode, adapter = database.adapter) {
    const sql = adapter.dialect.sql;
    const completedAt = database.clock.now().toISOString();
    const definitionFingerprint = row.definitionFingerprint ?? null;
    const generationToken = row.generationToken ?? null;
    const liveGenerationGuard = errorCode === "SCHEDULE_OCCURRENCE_SUPERSEDED"
        ? " AND NOT EXISTS (SELECT 1 FROM [sporades_schedules] WHERE [name]=? AND [enabled]=1 AND ([generationToken]=? OR ([generationToken] IS NULL AND ? IS NULL)))"
        : "";
    const liveGenerationParams = errorCode === "SCHEDULE_OCCURRENCE_SUPERSEDED"
        ? [row.scheduleName, generationToken, generationToken]
        : [];
    const result = await adapter.prepare(sql("UPDATE [sporades_schedule_occurrences] SET [status]='enqueue-failed', [claimToken]=NULL, [claimExpiresAt]=NULL, [jobId]=NULL, [errorCode]=?, [updatedAt]=? " +
        "WHERE [id]=? AND [status]='pending' AND [scheduledFor]=? " +
        "AND ([definitionFingerprint]=? OR ([definitionFingerprint] IS NULL AND ? IS NULL)) " +
        "AND ([generationToken]=? OR ([generationToken] IS NULL AND ? IS NULL)) " +
        "AND ([claimToken]=? OR ([claimToken] IS NULL AND ? IS NULL)) " +
        "AND ([claimExpiresAt]=? OR ([claimExpiresAt] IS NULL AND ? IS NULL))" + liveGenerationGuard)).run(errorCode, completedAt, row.id, row.scheduledFor, definitionFingerprint, definitionFingerprint, generationToken, generationToken, row.claimToken, row.claimToken, row.claimExpiresAt, row.claimExpiresAt, ...liveGenerationParams);
    if (Number(result.changes) === 1)
        return true;
    const current = await adapter.prepare(sql("SELECT [status], [claimExpiresAt] FROM [sporades_schedule_occurrences] WHERE [id]=?")).get(row.id);
    if (current?.status === "pending") {
        const nowMs = database.clock.now().getTime();
        const retainedExpiry = isCanonicalJobTimestamp(current.claimExpiresAt) ? Date.parse(current.claimExpiresAt) : Number.NaN;
        const retryAt = Number.isFinite(retainedExpiry) && retainedExpiry > nowMs
            ? current.claimExpiresAt
            : new Date(nowMs + SCHEDULE_RECOVERY_RETRY_MS).toISOString();
        schedulePendingOccurrenceRecovery(database, retryAt);
    }
    return false;
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
        if (dueAt > database.clock.now().getTime()) {
            schedulePendingOccurrenceRecovery(database, claimExpiresAt);
            return;
        }
        const active = recoverPendingScheduleOccurrences(database).catch((error) => {
            database.log.emit({ category: "platform", event: "schedule.occurrence.recovery_failed", level: "error", message: "Pending Scheduled occurrence recovery failed", data: { code: String(error?.code ?? "SCHEDULE_RECOVERY_FAILED").slice(0, 80) } });
            if (!database.__scheduleStopped) {
                schedulePendingOccurrenceRecovery(database, new Date(database.clock.now().getTime() + SCHEDULE_RECOVERY_RETRY_MS).toISOString());
            }
        }).finally(() => {
            database.__activeScheduleOccurrences?.delete(active);
            if (database.__scheduleRecoveryPromise === active)
                database.__scheduleRecoveryPromise = null;
        });
        database.__scheduleRecoveryPromise = active;
        database.__activeScheduleOccurrences?.add(active);
        return active;
    }, Math.min(MAX_NATIVE_TIMER_DELAY_MS, Math.max(0, dueAt - database.clock.now().getTime())));
    database.__scheduleRecoveryTimer = timer;
    database.__scheduleTimers?.add(timer);
}
export async function enqueueScheduledOccurrence(database, definition, occurrence) {
    const scheduledFor = occurrence.toISOString();
    const context = createScheduleMutationContext(database, definition, scheduledFor);
    const payload = await resolveSchedulePayload(database, definition, scheduledFor, context);
    if (!payload.ok)
        return null;
    return enqueueResolvedScheduledOccurrence(database, definition, scheduledFor, payload.value, context);
}
function createScheduleMutationContext(database, definition, scheduledFor) {
    const provenance = `schedule:${scheduledOccurrenceIdentity(database, definition.name, scheduledFor)}`;
    return createMutationContext(database, { userId: provenance, displayName: "Schedule", email: null, picture: null, isAuthenticated: false, isGuest: false, provider: "schedule" });
}
async function enqueueResolvedScheduledOccurrence(database, definition, scheduledFor, payload, context) {
    const provenance = `schedule:${scheduledOccurrenceIdentity(database, definition.name, scheduledFor)}`;
    database.jobScheduleProvenanceByContext.set(context, { scheduleName: definition.name, scheduledFor });
    const state = await context.privileged.run({ operation: "schedules.enqueue", targetResourceKind: "job-queue", metadata: { scheduleName: definition.name, scheduledFor } }, (privilegedContext) => privilegedContext.jobs.enqueue(definition.job, payload, { retry: definition.retry, idempotencyKey: provenance }));
    return state;
}
async function recoverExpiredJobLeases(database) {
    const recoveredAt = database.clock.now();
    const recoveredIso = recoveredAt.toISOString();
    const sql = database.adapter.dialect.sql;
    const rows = await database.adapter.prepare(sql("SELECT * FROM [sporades_jobs] WHERE [status]='running' ORDER BY [availableAt] ASC, [id] ASC")).all();
    let earliestFutureLeaseAt = null;
    for (const row of rows) {
        if (jobClaimTokenIsMalformed(row.claimToken)) {
            const failure = { code: "JOB_CLAIM_INVALID", message: "The stored Job claim ownership is invalid." };
            const ownership = jobClaimOwnership(row.claimToken);
            const leasePredicate = row.leaseExpiresAt === null
                ? "[leaseExpiresAt] IS NULL"
                : "[leaseExpiresAt] = ?";
            const leaseParams = row.leaseExpiresAt === null ? [] : [row.leaseExpiresAt];
            await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status]='failed', [failure]=?, [failedAt]=?, [leaseExpiresAt]=NULL, [claimToken]=NULL " +
                "WHERE [id]=? AND [status]='running' AND " + leasePredicate + " AND " + ownership.predicate)).run(JSON.stringify(failure), recoveredIso, row.id, ...leaseParams, ...ownership.params);
            continue;
        }
        if (!isCanonicalJobTimestamp(row.leaseExpiresAt)) {
            const failure = { code: "JOB_LEASE_INVALID", message: "The stored Job claim lease is invalid." };
            const ownership = jobClaimOwnership(row.claimToken);
            const leasePredicate = row.leaseExpiresAt === null
                ? "[leaseExpiresAt] IS NULL"
                : "[leaseExpiresAt] = ?";
            const leaseParams = row.leaseExpiresAt === null ? [] : [row.leaseExpiresAt];
            await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status]='failed', [failure]=?, [failedAt]=?, [leaseExpiresAt]=NULL, [claimToken]=NULL " +
                "WHERE [id]=? AND [status]='running' AND " + leasePredicate + " AND " + ownership.predicate)).run(JSON.stringify(failure), recoveredIso, row.id, ...leaseParams, ...ownership.params);
            continue;
        }
        const leaseExpiresAt = Date.parse(row.leaseExpiresAt);
        if (leaseExpiresAt > recoveredAt.getTime()) {
            earliestFutureLeaseAt = earliestFutureLeaseAt === null
                ? leaseExpiresAt
                : Math.min(earliestFutureLeaseAt, leaseExpiresAt);
            continue;
        }
        const retry = parsePersistedJobRetry(row.retryJson);
        const storedFailure = invalidStoredJobFailure(row, recoveredAt);
        const history = JSON.parse(row.attemptHistory || "[]");
        history.push({ attempt: Number(row.attempts), outcome: "interrupted", code: "JOB_LEASE_EXPIRED", completedAt: recoveredIso });
        const ownership = jobClaimOwnership(row.claimToken);
        const retryEligible = storedFailure === null && retry !== null && Number(row.attempts) < retry.maxAttempts;
        const retryAvailableAt = retryEligible ? jobTimestampAfter(recoveredAt, retry.delayMs) : null;
        const retryLeaseExpiresAt = retryAvailableAt === null
            ? null
            : jobTimestampAfter(new Date(retryAvailableAt), RUNTIME_CLAIM_LEASE_MS);
        if (retryAvailableAt !== null && retryLeaseExpiresAt !== null) {
            await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status]='delayed', [availableAt]=?, [leaseExpiresAt]=NULL, [claimToken]=NULL, [attemptHistory]=? " +
                "WHERE [id]=? AND [status]='running' AND [leaseExpiresAt] = ? AND " + ownership.predicate)).run(retryAvailableAt, JSON.stringify(history), row.id, row.leaseExpiresAt, ...ownership.params);
        }
        else {
            const failure = storedFailure ?? (retry === null || retryEligible
                ? invalidJobRetryPolicyFailure()
                : { code: "JOB_LEASE_EXPIRED", message: "Job lease expired." });
            await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status]='failed', [failure]=?, [failedAt]=?, [leaseExpiresAt]=NULL, [claimToken]=NULL, [attemptHistory]=? " +
                "WHERE [id]=? AND [status]='running' AND [leaseExpiresAt] = ? AND " + ownership.predicate)).run(JSON.stringify(failure), recoveredIso, JSON.stringify(history), row.id, row.leaseExpiresAt, ...ownership.params);
        }
    }
    return earliestFutureLeaseAt;
}
async function armJobLeaseRecovery(database) {
    if (database.__jobStopped)
        return;
    const earliestFutureLeaseAt = await recoverExpiredJobLeases(database);
    if (database.__jobStopped)
        return;
    scheduleJobLeaseRecoveryAt(database, earliestFutureLeaseAt);
}
function scheduleJobLeaseRecoveryAt(database, dueAt) {
    if (database.__jobLeaseRecoveryTimer) {
        database.clock.clearTimer(database.__jobLeaseRecoveryTimer);
        database.__jobLeaseRecoveryTimer = null;
    }
    database.__jobLeaseRecoveryDueAt = dueAt;
    if (database.__jobStopped || dueAt === null)
        return;
    database.__jobLeaseRecoveryTimer = database.clock.setTimer(async () => {
        database.__jobLeaseRecoveryTimer = null;
        database.__jobLeaseRecoveryDueAt = null;
        if (database.__jobStopped)
            return;
        const recovery = (async () => {
            try {
                await armJobLeaseRecovery(database);
                if (!database.__jobStopped)
                    scheduleCurrentUserJobWorker(database);
            }
            catch (error) {
                try {
                    database.log.emit({ category: "platform", event: "job.lease_recovery.failed", level: "error", message: "Running Job lease recovery failed", data: { code: String(error?.code ?? "JOB_LEASE_RECOVERY_FAILED").slice(0, 80) } });
                }
                catch { }
                if (!database.__jobStopped)
                    scheduleJobLeaseRecoveryAt(database, database.clock.now().getTime() + 1_000);
            }
        })();
        database.__jobLeaseRecoveryPromise = recovery;
        try {
            await recovery;
        }
        finally {
            if (database.__jobLeaseRecoveryPromise === recovery)
                database.__jobLeaseRecoveryPromise = null;
        }
    }, Math.min(MAX_NATIVE_TIMER_DELAY_MS, Math.max(0, dueAt - database.clock.now().getTime())));
}
const RUNTIME_CLAIM_LEASE_MS = 30_000;
function invalidStoredJobFailure(row, referenceInstant) {
    if (!isCanonicalJobTimestamp(row.availableAt)) {
        return { code: "JOB_AVAILABLE_AT_INVALID", message: "The stored Job availability time is invalid." };
    }
    const retry = parsePersistedJobRetry(row.retryJson);
    const attempts = Number(row.attempts);
    const attemptsValid = Number.isInteger(attempts)
        && (row.status === "running"
            ? attempts >= 1 && attempts <= (retry?.maxAttempts ?? -1)
            : attempts >= 0 && attempts < (retry?.maxAttempts ?? -1));
    if (retry === null || !attemptsValid)
        return invalidJobRetryPolicyFailure();
    const remainingAttempts = retry.maxAttempts - attempts;
    if (remainingAttempts === 0)
        return null;
    const firstAttempt = row.status === "running"
        ? jobTimestampAfter(referenceInstant, retry.delayMs)
        : new Date(Math.max(referenceInstant.getTime(), Date.parse(row.availableAt))).toISOString();
    if (firstAttempt === null)
        return invalidJobRetryPolicyFailure();
    if (!jobRetryHorizonFits(new Date(firstAttempt), retry, remainingAttempts))
        return invalidJobRetryPolicyFailure();
    return null;
}
function jobRetryHorizonFits(firstAttempt, retry, attemptCount) {
    let attemptAt = firstAttempt;
    for (let attempt = 0; attempt < attemptCount; attempt += 1) {
        if (jobTimestampAfter(attemptAt, RUNTIME_CLAIM_LEASE_MS) === null)
            return false;
        if (attempt === attemptCount - 1)
            return true;
        const nextAttempt = jobTimestampAfter(attemptAt, retry.delayMs);
        if (nextAttempt === null)
            return false;
        attemptAt = new Date(nextAttempt);
    }
    return true;
}
async function failInvalidQueuedJob(database, row, failure) {
    const sql = database.adapter.dialect.sql;
    return await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status]='failed', [failure]=?, [failedAt]=?, [leaseExpiresAt]=NULL, [claimToken]=NULL " +
        "WHERE [id]=? AND [status]=? AND [availableAt]=? AND COALESCE([retryJson], '') = COALESCE(?, '')")).run(JSON.stringify(failure), database.clock.now().toISOString(), row.id, row.status, row.availableAt, row.retryJson);
}
async function recoverInvalidRetainedJobState(database) {
    const recoveredAt = database.clock.now();
    const failedAt = recoveredAt.toISOString();
    const sql = database.adapter.dialect.sql;
    const rows = await database.adapter.prepare(sql("SELECT [id], [status], [availableAt], [attempts], [retryJson] FROM [sporades_jobs] WHERE [status] IN ('queued', 'delayed')")).all();
    await database.jobRecoveryFault?.("after-scan", { jobIds: rows.map((row) => String(row.id)) });
    for (const row of rows) {
        const failure = invalidStoredJobFailure(row, recoveredAt);
        if (!failure)
            continue;
        await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status]='failed', [failure]=?, [failedAt]=?, [leaseExpiresAt]=NULL, [claimToken]=NULL " +
            "WHERE [id]=? AND [status]=? AND [availableAt]=? AND COALESCE([retryJson], '') = COALESCE(?, '')")).run(JSON.stringify(failure), failedAt, row.id, row.status, row.availableAt, row.retryJson);
    }
}
function jobClaimOwnership(claimToken) {
    return claimToken === null || claimToken === undefined
        ? { predicate: "[claimToken] IS NULL", params: [] }
        : { predicate: "[claimToken] = ?", params: [claimToken] };
}
function jobClaimTokenIsMalformed(claimToken) {
    return claimToken !== null && claimToken !== undefined
        && (typeof claimToken !== "string" || claimToken.length === 0);
}
function logPayloadMaxBytes(config = {}) {
    const configured = Number(config.logs?.payloadMaxBytes ?? config.logging?.payloadMaxBytes);
    return Number.isInteger(configured) && configured > 0 ? configured : 4096;
}
function logRedactedValue() {
    return "[REDACTED]";
}
const transactionPendingLogWrites = Symbol("sporades.transactionPendingLogWrites");
export function createRuntimeLogSink(options) {
    const path = requirePathModule();
    const logPath = options.config.logs?.jsonlPath ??
        options.config.logging?.jsonlPath ??
        process.env.SPORADES_LOG_PATH ??
        path.join(options.dataDir, "logs", "events.jsonl");
    mkdirSync(path.dirname(logPath), { recursive: true });
    return {
        path: logPath,
        withDatabase(database) {
            return createRuntimeLogSink({ ...options, database });
        },
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
            const settled = isPromiseLike(indexed) ? indexed.then(() => event, () => event) : event;
            const pendingWrites = options.database?.[transactionPendingLogWrites];
            if (isPromiseLike(settled) && pendingWrites)
                pendingWrites.push(settled);
            return settled;
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
                    // The callback boundary, not the trailing audit writes, defines the
                    // lifetime of userless Team inspection. Detached inspection promises
                    // must fail closed while this run records its completion event.
                    privilegedContext.__privilegedRunActive = false;
                }
                catch (error) {
                    callbackError = error;
                    callbackSettled = true;
                    privilegedContext.__privilegedRunActive = false;
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
                    privilegedContext.__privilegedRunActive = false;
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
    // User-scoped and mutating Team operations remain unavailable. This is the
    // separate userless inspection projection, not inherited Team authority.
    delete privilegedContext.teams;
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
    privilegedContext.teams = createPrivilegedTeamsApi(database, () => holder.current);
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
// generator's state hangs off the generator instead of living at module scope. That was not style
// but necessity: the generated server bundle was assembled from the source text of individually
// registered functions, so a module-level binding one of them closed over did not travel with it and
// became a `ReferenceError` the first time a deployed Capsule booted.
//
// **Ticket 05 lifted that constraint** — this file reaches a deployed Capsule as a module now, and a
// module-scope constant travels with it like any other binding. The shape here is left as it stands
// because ticket 05 is a deletion and changing it would be a behavioural risk taken for tidiness;
// but nothing prevents the obvious edit any more, and a reader who wants the shared constant should
// take this comment as permission rather than as the prohibition it used to be.
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
    assertNotReservedTeamTableName(name);
    if (!table || table.kind !== "table" || !table.fields || typeof table.fields !== "object" || Array.isArray(table.fields)) {
        throw commandError(`Invalid Capsule table: ${name}`, "Declare schema tables with table({ fieldName: FieldBuilder() }).");
    }
    return {
        name,
        acl: normalizeTableAcl(name, table.aclRules),
        fields: Object.entries(table.fields).map(([fieldName, field]) => schemaFieldFromCapsuleField(fieldName, field)),
        uniqueConstraints: normalizeUniqueConstraints(name, table.fields, table.uniqueConstraints),
    };
}
function normalizeUniqueConstraints(tableName, fields, declarations) {
    if (declarations === undefined)
        return [];
    if (!Array.isArray(declarations)) {
        throw commandError(`Invalid unique declaration on Capsule table: ${tableName}`, "Declare uniqueness with .unique(\"field\") or .unique(\"firstField\", \"secondField\").");
    }
    const declaredFields = new Set(Object.keys(fields));
    const seen = new Set();
    return declarations.map((declaration) => {
        if (!Array.isArray(declaration) || declaration.length === 0 || declaration.some((field) => typeof field !== "string" || !declaredFields.has(field))) {
            throw commandError(`Invalid unique declaration on Capsule table: ${tableName}`, "Each unique declaration must name one or more declared Capsule fields.");
        }
        if (new Set(declaration).size !== declaration.length) {
            throw commandError(`Invalid unique declaration on Capsule table: ${tableName}`, "A unique declaration cannot repeat a Capsule field.");
        }
        const identity = [...declaration].sort().join("\u0000");
        if (seen.has(identity)) {
            throw commandError(`Duplicate unique declaration on Capsule table: ${tableName}`, "Declare each set of unique Capsule fields only once; field order does not make a new constraint.");
        }
        seen.add(identity);
        return [...declaration];
    }).sort((left, right) => [...left].sort().join("\u0000").localeCompare([...right].sort().join("\u0000")));
}
function assertNotReservedTeamTableName(name) {
    if (name.toLowerCase().startsWith("sporades_team")) {
        throw commandError(`Reserved runtime table name: ${name}`, "Choose a Capsule table name outside the sporades_team runtime namespace.", "RESERVED_TABLE_NAME");
    }
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
        const name = match[1];
        assertNotReservedTeamTableName(name);
        tables.push({
            name,
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
export function extractEndpoints(serverSource) {
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
export async function runEndpoint(database, endpoint, requestUrl, request) {
    const handler = typeof endpoint.handler === "function"
        ? endpoint.handler
        : new Function(`return (${endpoint.handlerSource});`)();
    const endpointRequest = await readEndpointRequest(database, requestUrl, request);
    const session = endpoint.runtimeOwnedEmailEvent
        ? { auth: {
                userId: privilegedAuthUserId(),
                displayName: "Email provider callback",
                email: null,
                picture: null,
                isAuthenticated: false,
                isGuest: false,
                provider: "privileged-server-role",
            } }
        : await resolveAnonymousSession(database, readEndpointSessionToken(endpointRequest.headers, endpointRequest.query));
    let context;
    try {
        const result = await (database.adapter ?? database.adapter).withTransaction(async (transactionAdapter) => {
            const transactionDatabase = createTransactionDatabase(database, transactionAdapter);
            let handlerFailed = false;
            try {
                context = createEndpointContext(transactionDatabase, endpointRequest, session);
                if (!endpoint.runtimeOwnedEmailEvent) {
                    context = await applyContextMiddleware(transactionDatabase, context, "endpoint");
                }
                return await handler(context);
            }
            catch (error) {
                handlerFailed = true;
                throw error;
            }
            finally {
                await cleanupTransactionHandler(transactionDatabase, context, handlerFailed);
            }
        });
        commitPendingJobCancellationAborts(context);
        flushTeamSecurityEvents(database, context);
        await dispatchPendingJobs(context);
        return result;
    }
    catch (error) {
        dropPendingJobCancellationAborts(context);
        flushTeamSecurityEvents(database, context, { deniedOnly: true });
        dropPendingJobDispatch(context);
        throw error;
    }
}
function createWriteTrackingAdapter(transactionAdapter, writeState) {
    return new Proxy(transactionAdapter, {
        get(target, property, receiver) {
            if (property === "prepare") {
                return (sql) => {
                    const statement = Reflect.apply(Reflect.get(target, property, receiver), receiver, [sql]);
                    return Object.assign(Object.create(statement), {
                        run(...params) {
                            const result = Reflect.apply(statement.run, statement, params);
                            return thenIfPromise(result, (writeResult) => {
                                if (Number(writeResult?.changes ?? 0) > 0)
                                    writeState.didWrite = true;
                                return writeResult;
                            });
                        },
                    });
                };
            }
            if (property === "exec") {
                return (sql) => thenIfPromise(Reflect.apply(Reflect.get(target, property, receiver), receiver, [sql]), (result) => { writeState.didWrite = true; return result; });
            }
            return Reflect.get(target, property, receiver);
        },
    });
}
function createTransactionDatabase(database, transactionAdapter, writeState) {
    const adapter = writeState ? createWriteTrackingAdapter(transactionAdapter, writeState) : transactionAdapter;
    if (!transactionAdapter)
        return database;
    const pendingLogWrites = transactionAdapter[transactionPendingLogWrites] ?? [];
    if (!transactionAdapter[transactionPendingLogWrites]) {
        Object.defineProperty(transactionAdapter, transactionPendingLogWrites, { value: pendingLogWrites });
    }
    const transactionDatabase = {
        ...database,
        adapter,
        sqlite: adapter,
        __transactionActive: true,
        __rootDatabase: database.__rootDatabase ?? database,
        __pendingLogWrites: pendingLogWrites,
    };
    if (typeof database.log?.withDatabase === "function") {
        transactionDatabase.log = database.log.withDatabase(adapter);
        transactionDatabase.audit = createPrivilegedAuditEmitter(transactionDatabase.log);
    }
    transactionDatabase.mail = Object.assign(Object.create(database.mail), {
        send(input, deliveryLog) {
            return database.mail.send(input, deliveryLog ?? ((event) => transactionDatabase.log?.emit(event)));
        },
    });
    return transactionDatabase;
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
    registerHandlerContextMapping(database, holder);
    context.db = createEndpointDatabaseApi(database, () => holder.current);
    context.privileged = createContextPrivilegedApi(database, () => holder.current);
    context.jobs = createCurrentUserJobApi(database, () => holder.current);
    context.mail = {
        enabled: database.mail.enabled,
        send(input) {
            return database.mail.send(input, (event) => database.log?.emit(event));
        },
    };
    context.teams = createCurrentUserTeamsApi(database, auth, () => holder.current);
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
const handlerContextByDatabase = new WeakMap();
function registerHandlerContextMapping(database, holder) {
    if (!database.__transactionActive)
        return;
    releaseHandlerContextMapping(database);
    const rootDatabase = database.__rootDatabase ?? database;
    handlerContextByDatabase.set(database, () => holder.current);
    rootDatabase.__handlerContextMappingCount += 1;
    database.__releaseHandlerContextMapping = () => {
        if (!handlerContextByDatabase.delete(database))
            return;
        rootDatabase.__handlerContextMappingCount -= 1;
    };
}
function releaseHandlerContextMapping(database) {
    database.__releaseHandlerContextMapping?.();
    delete database.__releaseHandlerContextMapping;
}
async function cleanupTransactionHandler(database, context, preservePrimaryError, clearCache = true) {
    let cleanupFailed = false;
    try {
        if (context)
            await drainPendingAclWrites(context);
        await drainPendingLogWrites(database);
    }
    catch (error) {
        cleanupFailed = true;
        if (!preservePrimaryError)
            throw error;
    }
    finally {
        try {
            if (clearCache || cleanupFailed)
                database.rowCache.clear();
        }
        finally {
            releaseHandlerContextMapping(database);
        }
    }
}
async function drainPendingLogWrites(database) {
    const pending = database.__pendingLogWrites;
    while (pending?.length > 0) {
        await Promise.allSettled(pending.splice(0));
    }
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
export function createEndpointDatabaseApi(database, contextGetter = null) {
    return Object.fromEntries(database.schema.tables.map((table) => [table.name, createEndpointTableApi(database, table, {}, contextGetter)]));
}
function createEndpointReadOnlyDatabaseApi(database, contextGetter = null) {
    return Object.fromEntries(database.schema.tables.map((table) => [
        table.name,
        readOnlyEndpointTableApi(createEndpointTableApi(database, table, {}, contextGetter)),
    ]));
}
function readOnlyEndpointTableApi(tableApi) {
    return {
        where(fieldName, value) {
            return readOnlyEndpointTableApi(tableApi.where(fieldName, value));
        },
        orderBy(fieldName, direction = "asc") {
            return readOnlyEndpointTableApi(tableApi.orderBy(fieldName, direction));
        },
        limit(count) {
            return readOnlyEndpointTableApi(tableApi.limit(count));
        },
        get() {
            return tableApi.get();
        },
        all() {
            return tableApi.all();
        },
    };
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
        insertOrIgnore(values, ...conflictFields) {
            if (conflictFields.length === 0 ||
                !table.uniqueConstraints?.some((constraint) => constraint.length === conflictFields.length && constraint.every((field, index) => field === conflictFields[index]))) {
                throw new Error(`insertOrIgnore requires an exactly matching declared unique constraint on ${table.name}.`);
            }
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
                    const result = database.adapter.insertAppRowOrIgnore(table, Object.fromEntries(columns.map((column) => [column, row[column]])), conflictFields);
                    return thenIfPromise(result, (writeResult) => {
                        if (writeResult.changes === 0) {
                            return null;
                        }
                        database.rowCache.clear();
                        return next;
                    });
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
        try {
            return JSON.parse(raw);
        }
        catch {
            throw commandError("Invalid JSON request body.", "Send a valid JSON request body.", "INVALID_JSON_REQUEST");
        }
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
// The internal log-index guard used to be four functions here — `targetsInternalLogIndexTable`,
// `readSqlTableReference`, `readSqlIdentifier` and `isInternalLogIndexMetadataRow`. It is
// `./log-index-guard.js` now, and `runReadOnlyInspectionQuery` above calls it through the import at
// the top of this file. ADR-0038 is why it is a module beside the inspection gate rather than part
// of it, and that module's header states the reasoning.
export function normalizeJourneyPolicy(value) {
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
export function normalizeJourneyState(value, defaultTtlSeconds) {
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
            const result = await setOwnEmailPassword(database, client.session, message.email ?? "", message.currentPassword ?? "", message.newPassword ?? "");
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
            let args;
            try {
                args = normalizeQueryArguments(message.args ?? []);
            }
            catch {
                sendJson(client, {
                    id: message.id,
                    type: "query.result",
                    query: queryName,
                    data: null,
                    error: invalidQueryArgumentsError(),
                });
                return;
            }
            if (!message.query && args.length > 0) {
                sendJson(client, {
                    id: message.id,
                    type: "query.result",
                    query: queryName,
                    data: null,
                    error: invalidQueryArgumentsError(),
                });
                return;
            }
            const subscription = { id: message.id, name: queryName, args, style: message.query ? "direct" : "rows", generation: 0 };
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
        if (message.type === "teams.list") {
            try {
                const data = await listCurrentUserTeams(database, client.session.auth);
                sendJson(client, { id: message.id ?? null, type: "teams.list.result", data, error: null });
            }
            catch (error) {
                if (error?.sporadesAuthDenialLogData)
                    emitAuthDeniedLog(database, { data: error.sporadesAuthDenialLogData });
                sendJson(client, {
                    id: message.id ?? null,
                    type: "error",
                    data: null,
                    error: {
                        ...(error?.code ? { code: error.code } : {}),
                        message: error?.message ?? "Could not list Teams.",
                        hint: error?.hint ?? "Sign in and retry the request.",
                    },
                });
            }
            return;
        }
        if (message.type === "teams.create") {
            try {
                const data = await createAdditionalTeam(database, client.session.auth, message.name);
                sendJson(client, { id: message.id ?? null, type: "teams.create.result", data, error: null });
            }
            catch (error) {
                if (error?.sporadesAuthDenialLogData)
                    emitAuthDeniedLog(database, { data: error.sporadesAuthDenialLogData });
                sendJson(client, {
                    id: message.id ?? null,
                    type: "error",
                    data: null,
                    error: {
                        ...(error?.code ? { code: error.code } : {}),
                        message: error?.message ?? "Could not create Team.",
                        hint: error?.hint ?? "Sign in and retry the request.",
                    },
                });
            }
            return;
        }
        if (message.type === "teams.rename") {
            try {
                const data = await renameCurrentUserTeam(database, client.session.auth, message.teamId, message.name);
                sendJson(client, { id: message.id ?? null, type: "teams.rename.result", data, error: null });
            }
            catch (error) {
                if (error?.sporadesAuthDenialLogData)
                    emitAuthDeniedLog(database, { data: error.sporadesAuthDenialLogData });
                sendJson(client, {
                    id: message.id ?? null,
                    type: "error",
                    data: null,
                    error: {
                        ...(error?.code ? { code: error.code } : {}),
                        message: error?.message ?? "Could not rename Team.",
                        hint: error?.hint ?? "Sign in and retry the request.",
                    },
                });
            }
            return;
        }
        if (message.type === "teams.listMembers") {
            try {
                const data = await listTeamMembers(database, client.session.auth, message.teamId, { cursor: message.cursor, limit: message.limit });
                sendJson(client, { id: message.id ?? null, type: "teams.listMembers.result", data, error: null });
            }
            catch (error) {
                if (error?.sporadesAuthDenialLogData)
                    emitAuthDeniedLog(database, { data: error.sporadesAuthDenialLogData });
                sendJson(client, {
                    id: message.id ?? null,
                    type: "error",
                    data: null,
                    error: {
                        ...(error?.code ? { code: error.code } : {}),
                        message: error?.message ?? "Could not list Team members.",
                        hint: error?.hint ?? "Sign in with a Team administrator account and retry.",
                    },
                });
            }
            return;
        }
        if (message.type === "teams.countMembers") {
            try {
                const data = await countTeamMembers(database, client.session.auth, message.teamId);
                sendJson(client, { id: message.id ?? null, type: "teams.countMembers.result", data, error: null });
            }
            catch (error) {
                if (error?.sporadesAuthDenialLogData)
                    emitAuthDeniedLog(database, { data: error.sporadesAuthDenialLogData });
                sendJson(client, {
                    id: message.id ?? null,
                    type: "error",
                    data: null,
                    error: {
                        ...(error?.code ? { code: error.code } : {}),
                        message: error?.message ?? "Could not read this Team's member count.",
                        hint: error?.hint ?? "Sign in as a current Team member and retry.",
                    },
                });
            }
            return;
        }
        if (message.type === "teams.updateApplicationRoles") {
            try {
                const data = await updateTeamMemberApplicationRoles(database, client.session.auth, message.teamId, message.userId, { add: message.add, remove: message.remove });
                sendJson(client, { id: message.id ?? null, type: "teams.updateApplicationRoles.result", data, error: null });
            }
            catch (error) {
                sendJson(client, { id: message.id ?? null, type: "error", data: null, error: { ...(error?.code ? { code: error.code } : {}), message: error?.message ?? "Could not update Team application roles.", hint: error?.hint ?? "Sign in with a Team administrator account and retry." } });
            }
            return;
        }
        if (message.type === "teams.createJoinLink") {
            try {
                const data = await createTeamJoinLink(database, client.session.auth, message.teamId, message.email, { ttlSeconds: message.ttlSeconds });
                sendJson(client, { id: message.id ?? null, type: "teams.createJoinLink.result", data, error: null });
            }
            catch (error) {
                sendJson(client, { id: message.id ?? null, type: "error", data: null, error: { ...(error?.code ? { code: error.code } : {}), message: error?.message ?? "Could not create Join link.", hint: error?.hint ?? "Sign in with a Team administrator account and retry." } });
            }
            return;
        }
        if (message.type === "teams.listJoinLinks") {
            try {
                const data = await listTeamJoinLinks(database, client.session.auth, message.teamId);
                sendJson(client, { id: message.id ?? null, type: "teams.listJoinLinks.result", data, error: null });
            }
            catch (error) {
                sendJson(client, { id: message.id ?? null, type: "error", data: null, error: { ...(error?.code ? { code: error.code } : {}), message: error?.message ?? "Could not list Join links.", hint: error?.hint ?? "Sign in with a Team administrator account and retry." } });
            }
            return;
        }
        if (message.type === "teams.revokeJoinLink") {
            try {
                const data = await revokeTeamJoinLink(database, client.session.auth, message.teamId, message.joinLinkId);
                sendJson(client, { id: message.id ?? null, type: "teams.revokeJoinLink.result", data, error: null });
            }
            catch (error) {
                sendJson(client, { id: message.id ?? null, type: "error", data: null, error: { ...(error?.code ? { code: error.code } : {}), message: error?.message ?? "Could not revoke Join link.", hint: error?.hint ?? "Sign in with a Team administrator account and retry." } });
            }
            return;
        }
        if (message.type === "teams.inspectJoinLink") {
            const data = await inspectTeamJoinLink(database, message.code);
            sendJson(client, { id: message.id ?? null, type: "teams.inspectJoinLink.result", data, error: null });
            return;
        }
        if (message.type === "teams.validateJoinLink") {
            const data = await validateTeamJoinLink(database, client.session.auth, message.code);
            sendJson(client, { id: message.id ?? null, type: "teams.validateJoinLink.result", data, error: null });
            return;
        }
        if (message.type === "teams.join") {
            try {
                const data = await joinCurrentUserTeam(database, client.session.auth, message.code);
                sendJson(client, { id: message.id ?? null, type: "teams.join.result", data, error: null });
            }
            catch (error) {
                sendJson(client, { id: message.id ?? null, type: "error", data: null, error: { ...(error?.code ? { code: error.code } : {}), message: error?.message ?? "Could not join this Team.", hint: error?.hint ?? "Use a current Join link for this linked account." } });
            }
            return;
        }
        if (message.type === "teams.promote" || message.type === "teams.demote" || message.type === "teams.removeMember" || message.type === "teams.leave" || message.type === "teams.delete") {
            try {
                const data = message.type === "teams.promote"
                    ? await promoteTeamMember(database, client.session.auth, message.teamId, message.userId)
                    : message.type === "teams.demote"
                        ? await demoteTeamMember(database, client.session.auth, message.teamId, message.userId)
                        : message.type === "teams.removeMember"
                            ? await removeTeamMember(database, client.session.auth, message.teamId, message.userId)
                            : message.type === "teams.leave"
                                ? await leaveCurrentUserTeam(database, client.session.auth, message.teamId)
                                : await deleteCurrentUserTeam(database, client.session.auth, message.teamId);
                sendJson(client, { id: message.id ?? null, type: `${message.type}.result`, data, error: null });
            }
            catch (error) {
                sendJson(client, { id: message.id ?? null, type: "error", data: null, error: { ...(error?.code ? { code: error.code } : {}), message: error?.message ?? "Could not update Team membership.", hint: error?.hint ?? "Sign in with a Team administrator account and retry." } });
            }
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
            if (result.ok && mutationResultsWithWrites.has(result)) {
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
            const result = await runQuery(database, client.session.auth, subscription.name, subscription.args);
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
// Enqueues a runtime-owned Job under the reserved privileged actor. The direct
// insert joins the handler transaction, while dispatch uses that transaction's
// live context so the worker is not woken until commit. Outside a handler
// transaction, runtime-owned Jobs retain ordinary immediate scheduling.
async function enqueueRuntimeJob(database, handlerName, payload, idempotencyKey, retry = undefined) {
    const queueDatabase = database.__rootDatabase ?? database;
    const jobAdapter = database.adapter;
    const now = queueDatabase.clock.now().toISOString();
    const payloadJson = boundedJobJson(payload, 64 * 1024, "JOB_PAYLOAD_TOO_LARGE", "Job payload");
    await jobAdapter.prepare(jobAdapter.dialect.sql("INSERT INTO [sporades_jobs] ([id], [handler], [enqueuedByUserId], [actorUserId], [actorProvider], [payload], [status], " +
        "[availableAt], [attempts], [idempotencyKey], [createdAt], [retryJson], [attemptHistory], [scheduleName], [scheduledFor]) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?, '[]', NULL, NULL)")).run(randomUUID(), handlerName, PRIVILEGED_AUTH_USER_ID, PRIVILEGED_AUTH_USER_ID, "privileged", payloadJson, now, idempotencyKey, now, JSON.stringify(normalizeJobRetry(retry)));
    deferOrScheduleJobDispatch(database, queueDatabase);
}
// Runtime-owned delivery may transiently fail after the request response has returned. Keep retries
// bounded and private to this Job so Capsule Job defaults and API semantics remain unchanged.
const PASSWORD_RESET_REQUEST_RETRY = { maxAttempts: 3, delayMs: 1_000 };
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
    const code = `${randomBytes(16).toString("base64url")}.${randomBytes(32).toString("base64url")}`;
    // Both paths stop after this one durable enqueue. The worker owns lookup, Reset-code creation,
    // and SMTP delivery, so no request-side database or Job sequence identifies a registered email.
    await enqueueRuntimeJob(database, PASSWORD_RESET_REQUEST_JOB, {
        email: cleanEmail,
        code,
        subject: typeof options.subject === "string" ? options.subject : "Reset your password",
        textBody: typeof options.textBody === "string" ? options.textBody : null,
        htmlBody: typeof options.htmlBody === "string" ? options.htmlBody : null,
    }, `password-reset-request:${code.split(".")[0]}`, PASSWORD_RESET_REQUEST_RETRY);
    return { ok: true };
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
export async function runQuery(database, auth, queryName, rawArgs = []) {
    let args;
    try {
        args = normalizeQueryArguments(rawArgs);
    }
    catch {
        return { rows: null, data: null, error: invalidQueryArgumentsError() };
    }
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
        if (args.length > 0)
            return { rows: null, data: null, error: invalidQueryArgumentsError() };
        return { data: context.env, error: null };
    }
    const customResult = await runCustomQuery(database, context, queryName, args);
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
    if (args.length > 0)
        return { rows: null, data: null, error: invalidQueryArgumentsError() };
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
async function runCustomQuery(database, context, queryName, args) {
    const handler = database.queries.find((candidate) => candidate.name === queryName);
    if (!handler) {
        return null;
    }
    try {
        const queryHandler = typeof handler.handler === "function"
            ? handler.handler
            : new Function(`return (${handler.handlerSource});`)();
        const data = await queryHandler(context, ...args);
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
const QUERY_ARGUMENT_LIMIT_BYTES = 65536;
function invalidQueryArgumentsError() {
    return {
        message: "Invalid query arguments.",
        hint: "Use a JSON-compatible argument array no larger than 65536 UTF-8 bytes.",
    };
}
function normalizeQueryArguments(value) {
    if (!Array.isArray(value))
        throw new Error("Query arguments must be an array.");
    const snapshot = normalizeQueryArgumentValue(value, new Set());
    const canonicalJson = JSON.stringify(snapshot);
    if (Buffer.byteLength(canonicalJson, "utf8") > QUERY_ARGUMENT_LIMIT_BYTES) {
        throw new Error("Query arguments are too large.");
    }
    return snapshot;
}
function normalizeQueryArgumentValue(value, ancestors) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new Error("Query arguments must contain finite numbers.");
        return value;
    }
    if (typeof value !== "object")
        throw new Error("Query arguments must be JSON-compatible.");
    if (Object.getOwnPropertySymbols(value).length > 0)
        throw new Error("Query arguments must not contain symbol keys.");
    if (ancestors.has(value))
        throw new Error("Query arguments must not contain cycles.");
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            if (Object.getOwnPropertyNames(value).some((key) => key !== "length" && (!/^(0|[1-9]\\d*)$/.test(key) || Number(key) >= value.length))) {
                throw new Error("Query arguments must not contain non-index array properties.");
            }
            const copy = [];
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.hasOwn(value, index))
                    throw new Error("Query arguments must not contain sparse arrays.");
                copy.push(normalizeQueryArgumentValue(value[index], ancestors));
            }
            return Object.freeze(copy);
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new Error("Query arguments must contain plain objects only.");
        }
        const copy = Object.create(null);
        for (const key of Object.getOwnPropertyNames(value).sort()) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
                throw new Error("Query arguments must not contain accessors.");
            Object.defineProperty(copy, key, {
                value: normalizeQueryArgumentValue(descriptor.value, ancestors),
                enumerable: true,
                writable: false,
                configurable: false,
            });
        }
        return Object.freeze(copy);
    }
    finally {
        ancestors.delete(value);
    }
}
export async function runMutation(database, auth, mutationName, args) {
    let context;
    let result;
    const writeState = { didWrite: false };
    try {
        const committed = await (database.adapter ?? database.adapter).withTransaction(async (transactionAdapter) => {
            const transactionDatabase = createTransactionDatabase(database, transactionAdapter, writeState);
            let handlerFailed = false;
            try {
                context = createMutationContext(transactionDatabase, auth);
                context = await applyContextMiddleware(transactionDatabase, context, "mutation");
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
            }
            catch (error) {
                handlerFailed = true;
                throw error;
            }
            finally {
                await cleanupTransactionHandler(transactionDatabase, context, handlerFailed, handlerFailed);
            }
        });
        commitPendingJobCancellationAborts(context);
        flushTeamSecurityEvents(database, context);
        await dispatchPendingJobs(context);
        if (writeState.didWrite) {
            database.rowCache.clear();
            mutationResultsWithWrites.add(committed);
        }
        return committed;
    }
    catch (error) {
        dropPendingJobCancellationAborts(context);
        flushTeamSecurityEvents(database, context, { deniedOnly: true });
        dropPendingJobDispatch(context);
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
    }
    if (result !== undefined) {
        assertJsonCompatible(result);
    }
    return { ok: true, data: result ?? null, error: null };
}
export async function runAppMessage(database, auth, messageName, data, options = {}) {
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
            let handlerFailed = false;
            try {
                context = createMessageContext(transactionDatabase, auth, options.sendAppMessage);
                context = await applyContextMiddleware(transactionDatabase, context, "message");
                const result = await createHandler()(context, data);
                if (result !== undefined) {
                    assertJsonCompatible(result);
                }
                return { data: result ?? null, error: null };
            }
            catch (error) {
                handlerFailed = true;
                throw error;
            }
            finally {
                await cleanupTransactionHandler(transactionDatabase, context, handlerFailed);
            }
        });
        commitPendingJobCancellationAborts(context);
        flushTeamSecurityEvents(database, context);
        await dispatchPendingJobs(context);
        return response;
    }
    catch (error) {
        dropPendingJobCancellationAborts(context);
        flushTeamSecurityEvents(database, context, { deniedOnly: true });
        dropPendingJobDispatch(context);
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
    registerHandlerContextMapping(database, holder);
    context.db = createEndpointDatabaseApi(database, () => holder.current);
    context.privileged = createContextPrivilegedApi(database, () => holder.current);
    context.jobs = createCurrentUserJobApi(database, () => holder.current);
    context.mail = {
        enabled: database.mail.enabled,
        send(input) {
            return database.mail.send(input, (event) => database.log?.emit(event));
        },
    };
    context.teams = createCurrentUserTeamsApi(database, auth, () => holder.current);
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
function createTeamJoinAdmissionContext(database, auth) {
    const context = {
        auth,
        env: database.serverEnv,
        log: createEndpointLogger(database),
    };
    const holder = createContextHolder(context);
    context.db = createEndpointReadOnlyDatabaseApi(database, () => holder.current);
    return context;
}
function deferOrScheduleJobDispatch(database, queueDatabase, context = undefined) {
    const currentContext = context ?? handlerContextByDatabase.get(database)?.();
    if (database.__transactionActive && currentContext) {
        const pendingContext = currentContext.__jobParentContext ?? currentContext;
        pendingContext.__pendingJobDispatch = true;
        pendingContext.__jobQueueDatabase = queueDatabase;
        return;
    }
    scheduleCurrentUserJobWorker(queueDatabase);
}
function createCurrentUserJobApi(database, contextGetter) {
    return {
        async enqueue(handlerName, payload, options = {}) {
            const context = contextGetter();
            const queueDatabase = database.__rootDatabase ?? database;
            const jobAdapter = database.adapter;
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
                const existing = await jobAdapter.prepare(jobAdapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [handler] = ? AND [actorUserId] = ? AND [idempotencyKey] = ?")).get(handlerName, context.auth.userId, idempotencyKey);
                if (existing) {
                    assertJobScheduleProvenance(existing, scheduleProvenance);
                    return jobState(existing, true);
                }
            }
            const id = crypto.randomUUID();
            const nowInstant = queueDatabase.clock.now();
            const now = normalizeJobAvailableAt(nowInstant);
            const availableAt = options.availableAt === undefined ? now : normalizeJobAvailableAt(options.availableAt);
            const retry = normalizeJobRetry(options.retry);
            const firstAttemptInstant = availableAt > now ? new Date(availableAt) : nowInstant;
            if (jobTimestampAfter(firstAttemptInstant, RUNTIME_CLAIM_LEASE_MS) === null) {
                throw jobError("INVALID_JOB_OPTIONS", "Invalid Job availability time.", "Pass an availableAt value with room for a canonical runtime claim lease.");
            }
            if (!jobRetryHorizonFits(firstAttemptInstant, retry, retry.maxAttempts)) {
                throw jobError("INVALID_JOB_OPTIONS", "Invalid Job retry policy.", "Pass retry.delayMs with room for every configured attempt and its canonical runtime claim lease.");
            }
            const row = { id, handler: handlerName, enqueuedByUserId: context.__jobEnqueuedBy ?? context.auth.userId, actorUserId: context.auth.userId, actorProvider: jobActorProvider(context.auth), payload: payloadJson, status: availableAt > now ? "delayed" : "queued", availableAt, attempts: 0, idempotencyKey: idempotencyKey ?? null, createdAt: now, retryJson: JSON.stringify(retry), attemptHistory: "[]", scheduleName: scheduleProvenance?.scheduleName ?? null, scheduledFor: scheduleProvenance?.scheduledFor ?? null };
            // Persistence belongs to the handler transaction. Only worker dispatch waits until commit, so
            // a rollback cannot leave a Job behind and a post-commit timer failure cannot undo or
            // misreport handler work that is already durable.
            try {
                const result = await jobAdapter.prepare(jobAdapter.dialect.sql("INSERT INTO [sporades_jobs] ([id], [handler], [enqueuedByUserId], [actorUserId], [actorProvider], [payload], [status], [availableAt], [attempts], [idempotencyKey], [createdAt], [retryJson], [attemptHistory], [scheduleName], [scheduledFor]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)" +
                    (idempotencyKey ? " ON CONFLICT DO NOTHING" : ""))).run(id, handlerName, row.enqueuedByUserId, row.actorUserId, row.actorProvider, payloadJson, row.status, availableAt, idempotencyKey ?? null, now, row.retryJson, row.attemptHistory, row.scheduleName, row.scheduledFor);
                if (idempotencyKey && Number(result?.changes ?? 0) === 0) {
                    const existing = await jobAdapter.prepare(jobAdapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [handler] = ? AND [actorUserId] = ? AND [idempotencyKey] = ?")).get(handlerName, context.auth.userId, idempotencyKey);
                    if (existing) {
                        assertJobScheduleProvenance(existing, scheduleProvenance);
                        return jobState(existing, true);
                    }
                    throw jobError("JOB_ENQUEUE_CONFLICT", "Could not resolve the existing idempotent Job.", "Retry the Job enqueue.");
                }
            }
            catch (error) {
                if (idempotencyKey) {
                    const existing = await jobAdapter.prepare(jobAdapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [handler] = ? AND [actorUserId] = ? AND [idempotencyKey] = ?")).get(handlerName, context.auth.userId, idempotencyKey);
                    if (existing) {
                        assertJobScheduleProvenance(existing, scheduleProvenance);
                        return jobState(existing, true);
                    }
                }
                throw error;
            }
            deferOrScheduleJobDispatch(database, queueDatabase, context);
            if (database.__transactionActive)
                return jobState(row, true);
            return jobState(await jobAdapter.prepare(jobAdapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [id] = ?")).get(id), true);
        },
        async get(id) {
            const context = contextGetter();
            const jobAdapter = database.adapter;
            const row = await jobAdapter.prepare(jobAdapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [id] = ? AND [actorUserId] = ?")).get(id, context.auth.userId);
            return row ? jobState(row, true) : null;
        },
        async cancel(id) { return await cancelJob(database, contextGetter(), id); },
        async list(options = {}) {
            const context = contextGetter();
            if (options === null || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => !["limit", "cursor", "status", "handler", "createdAfter", "createdBefore"].includes(key)))
                throw jobError("INVALID_JOB_OPTIONS", "Invalid Job list options.", "Pass supported Job list filters only.");
            const limit = options.limit === undefined ? 50 : options.limit;
            if (!Number.isInteger(limit) || limit < 1 || limit > 100)
                throw jobError("INVALID_JOB_OPTIONS", "Invalid Job list limit.", "Pass a whole-number limit from 1 to 100.");
            const cursor = decodeJobCursor(options.cursor);
            const jobAdapter = database.adapter;
            const sql = jobAdapter.dialect.sql;
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
            const rows = await jobAdapter.prepare(sql(`SELECT * FROM [sporades_jobs] WHERE ${clauses.join(" AND ")} ORDER BY [createdAt] ASC, [id] ASC LIMIT ?`)).all(...params, limit + 1);
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
            const jobAdapter = database.adapter;
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
            const sqlite = database.adapter;
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
        async cancel(id) {
            const context = contextGetter();
            assertActivePrivilegedJobAccess(() => context);
            return await cancelJob(database, Object.assign(Object.create(context), { __privilegedJobAccess: true }), id);
        },
    };
}
async function dispatchPendingJobs(context) {
    if (!context?.__pendingJobDispatch || context.__pendingJobsFlushed)
        return false;
    context.__pendingJobsFlushed = true;
    const queueDatabase = context.__jobQueueDatabase;
    context.__pendingJobDispatch = false;
    try {
        scheduleCurrentUserJobWorker(queueDatabase);
    }
    catch { }
    return false;
}
function dropPendingJobDispatch(context) {
    if (!context)
        return;
    context.__pendingJobDispatch = false;
    context.__pendingJobsFlushed = true;
    delete context.__jobQueueDatabase;
}
function stopCurrentUserJobWorker(database) {
    database.__jobStopped = true;
    database.__jobWorkerRerunRequested = false;
    if (database.__jobWorkerTimer) {
        database.clock.clearTimer(database.__jobWorkerTimer);
        database.__jobWorkerTimer = null;
    }
    database.__jobWorkerScheduled = false;
    if (database.__jobWakeTimer) {
        database.clock.clearTimer(database.__jobWakeTimer);
        database.__jobWakeTimer = null;
    }
    if (database.__jobLeaseRecoveryTimer) {
        database.clock.clearTimer(database.__jobLeaseRecoveryTimer);
        database.__jobLeaseRecoveryTimer = null;
    }
    database.__jobLeaseRecoveryDueAt = null;
    for (const activeClaim of database.__jobAbortControllers?.values?.() ?? [])
        (activeClaim?.controller ?? activeClaim)?.abort?.();
    const settlements = [database.__jobWorkerPromise, database.__jobLeaseRecoveryPromise]
        .filter(Boolean)
        .map((pending) => Promise.resolve(pending));
    if (settlements.length === 0)
        return undefined;
    if (settlements.length === 1)
        return settlements[0];
    return Promise.all(settlements).then(() => undefined);
}
function scheduleCurrentUserJobWorker(database) {
    if (database.__jobStopped)
        return;
    if (database.__jobWorkerRunning) {
        // A transaction may commit after the active worker's final queue read but
        // before that worker relinquishes ownership. Remember the dispatch so the
        // worker cannot clear its running state without arranging another scan.
        database.__jobWorkerRerunRequested = true;
        return;
    }
    if (database.__jobWorkerScheduled)
        return;
    database.__jobWorkerScheduled = true;
    try {
        database.__jobWorkerTimer = database.clock.setTimer(async () => {
            database.__jobWorkerTimer = null;
            database.__jobWorkerScheduled = false;
            if (database.__jobStopped)
                return;
            const worker = runCurrentUserJobWorker(database);
            database.__jobWorkerPromise = worker;
            try {
                await worker;
            }
            finally {
                if (database.__jobWorkerPromise === worker)
                    database.__jobWorkerPromise = null;
            }
        }, 0);
    }
    catch {
        database.__jobWorkerScheduled = false;
        database.__jobWorkerTimer = null;
    }
}
function scheduleJobWorkerWake(database, delayMs) {
    if (database.__jobStopped)
        return;
    if (database.__jobWakeTimer)
        database.clock.clearTimer(database.__jobWakeTimer);
    database.__jobWakeTimer = database.clock.setTimer(() => {
        database.__jobWakeTimer = null;
        scheduleCurrentUserJobWorker(database);
    }, Math.min(MAX_NATIVE_TIMER_DELAY_MS, Math.max(0, delayMs)));
}
async function relinquishUnstartedJobClaim(database, jobId, claimToken) {
    const sql = database.adapter.dialect.sql;
    await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET " +
        "[status] = CASE WHEN [cancelRequestedAt] IS NULL THEN 'queued' ELSE 'cancelled' END, " +
        "[attempts] = CASE WHEN [attempts] > 0 THEN [attempts] - 1 ELSE 0 END, " +
        "[startedAt] = NULL, [leaseExpiresAt] = NULL, [claimToken] = NULL, " +
        "[completedAt] = CASE WHEN [cancelRequestedAt] IS NULL THEN [completedAt] ELSE [cancelRequestedAt] END " +
        "WHERE [id] = ? AND [status] = 'running' AND [claimToken] = ?")).run(jobId, claimToken);
}
async function scheduleNextDelayedJob(database) {
    while (true) {
        const row = await database.adapter.prepare(database.adapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [status]='delayed' ORDER BY [availableAt] ASC, [id] ASC LIMIT 1")).get();
        if (!row)
            return;
        const failure = invalidStoredJobFailure(row, database.clock.now());
        if (failure) {
            await failInvalidQueuedJob(database, row, failure);
            continue;
        }
        scheduleJobWorkerWake(database, Math.max(0, Date.parse(row.availableAt) - database.clock.now().getTime()) + 1);
        return;
    }
}
export async function runCurrentUserJobWorker(database) {
    if (database.__jobStopped || database.__jobWorkerRunning)
        return;
    database.__jobWorkerRunning = true;
    const sql = database.adapter.dialect.sql;
    try {
        while (true) {
            if (database.__jobStopped)
                return;
            const workerNow = database.clock.now();
            const workerNowIso = workerNow.toISOString();
            await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status]='queued' WHERE [status]='delayed' AND [availableAt] <= ?")).run(workerNowIso);
            if (database.__jobStopped)
                return;
            const row = await database.adapter.prepare(sql("SELECT * FROM [sporades_jobs] WHERE [status] = 'queued' AND [availableAt] <= ? ORDER BY [availableAt] ASC, [id] ASC LIMIT 1")).get(workerNowIso);
            if (database.__jobStopped)
                return;
            if (!row) {
                await scheduleNextDelayedJob(database);
                return;
            }
            const storedFailure = invalidStoredJobFailure(row, workerNow);
            if (storedFailure) {
                await failInvalidQueuedJob(database, row, storedFailure);
                continue;
            }
            const startedAt = workerNowIso;
            const leaseExpiresAt = jobTimestampAfter(workerNow, RUNTIME_CLAIM_LEASE_MS);
            if (leaseExpiresAt === null) {
                await failInvalidQueuedJob(database, row, { code: "JOB_AVAILABLE_AT_INVALID", message: "The Job cannot acquire a canonical claim lease." });
                continue;
            }
            const claimToken = randomUUID();
            const claimed = await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status] = 'running', [attempts] = [attempts] + 1, [startedAt] = ?, [leaseExpiresAt] = ?, [claimToken] = ? " +
                "WHERE [id] = ? AND [status] = 'queued' AND [availableAt] = ? AND COALESCE([retryJson], '') = COALESCE(?, '')")).run(startedAt, leaseExpiresAt, claimToken, row.id, row.availableAt, row.retryJson);
            if (!claimed?.changes)
                continue;
            if (database.__jobStopped) {
                // Shutdown can begin while the asynchronous claim statement is in
                // flight. The Job has not reached its handler boundary yet, so return
                // the claim without consuming an attempt. A cancellation that raced
                // the claim remains terminal instead of being resurrected as queued.
                await relinquishUnstartedJobClaim(database, row.id, claimToken);
                return;
            }
            const handler = database.jobs?.find((candidate) => candidate.name === row.handler);
            database.__jobAbortControllers ??= new Map();
            const abortController = new AbortController();
            database.__jobAbortControllers.set(row.id, { claimToken, controller: abortController });
            let handlerStarted = false;
            try {
                // Cancellation may commit after the durable claim but before its
                // in-memory controller is registered. Reconcile the exact owned claim
                // before crossing the handler boundary so that window cannot lose the
                // abort signal or affect a newer attempt.
                const claimedState = await database.adapter.prepare(sql("SELECT [cancelRequestedAt] FROM [sporades_jobs] WHERE [id]=? AND [status]='running' AND [claimToken]=?")).get(row.id, claimToken);
                if (!claimedState)
                    continue;
                if (database.__jobStopped) {
                    await relinquishUnstartedJobClaim(database, row.id, claimToken);
                    return;
                }
                if (claimedState?.cancelRequestedAt)
                    abortController.abort();
                if (!handler)
                    throw jobError("UNKNOWN_JOB_HANDLER", "Job handler is no longer declared.", "Restore the handler or inspect the retained Job state.");
                let result;
                if (row.actorUserId === privilegedAuthUserId()) {
                    const context = createMutationContext(database, { userId: row.enqueuedByUserId, displayName: "Job enqueuer", email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "job" });
                    result = await context.privileged.run({ operation: "jobs.execute", targetResourceKind: "job-queue", signal: abortController.signal, metadata: { jobId: row.id, handler: row.handler, attempt: Number(row.attempts) + 1, ...(row.scheduleName ? { scheduleName: String(row.scheduleName), scheduledFor: String(row.scheduledFor) } : {}) } }, async (privilegedCtx) => {
                        handlerStarted = true;
                        database.__runtimeJobAttempts.set(privilegedCtx, Number(row.attempts) + 1);
                        try {
                            return await handler.handler(privilegedCtx, JSON.parse(row.payload));
                        }
                        finally {
                            database.__runtimeJobAttempts.delete(privilegedCtx);
                        }
                    });
                }
                else {
                    const user = await database.adapter.prepare(sql("SELECT [id], [displayName], [email], [picture], [isAuthenticated], [isGuest] " +
                        "FROM [sporades_auth_users] WHERE [id] = ?")).get(row.actorUserId);
                    if (database.__jobStopped) {
                        await relinquishUnstartedJobClaim(database, row.id, claimToken);
                        return;
                    }
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
                    handlerStarted = true;
                    database.__runtimeJobAttempts.set(context, Number(row.attempts) + 1);
                    try {
                        result = await handler.handler(context, JSON.parse(row.payload));
                    }
                    finally {
                        database.__runtimeJobAttempts.delete(context);
                    }
                }
                const resultJson = boundedJobJson(result ?? null, 64 * 1024, "JOB_RESULT_TOO_LARGE", "Job result");
                const completedAt = database.clock.now().toISOString();
                const history = JSON.parse(row.attemptHistory || "[]");
                history.push({ attempt: Number(row.attempts) + 1, startedAt, outcome: "succeeded", completedAt });
                await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status] = 'succeeded', [result] = ?, [completedAt] = ?, [leaseExpiresAt] = NULL, [claimToken] = NULL, [attemptHistory] = ? " +
                    "WHERE [id] = ? AND [status] = 'running' AND [claimToken] = ?")).run(resultJson, completedAt, JSON.stringify(history), row.id, claimToken);
            }
            catch (error) {
                if (database.__jobStopped && !handlerStarted) {
                    await relinquishUnstartedJobClaim(database, row.id, claimToken);
                    return;
                }
                const handlerFailure = safeJobFailure(error);
                const failedAt = database.clock.now().toISOString();
                const history = JSON.parse(row.attemptHistory || "[]");
                const retry = parsePersistedJobRetry(row.retryJson);
                const abortError = error?.cause ?? error;
                const abortShaped = abortController.signal.aborted && (abortError?.name === "AbortError" || abortError?.code === "ABORT_ERR");
                const cancellation = abortShaped
                    ? await database.adapter.prepare(sql("SELECT [cancelRequestedAt] FROM [sporades_jobs] WHERE [id]=? AND [status]='running' AND [claimToken]=?")).get(row.id, claimToken)
                    : null;
                const cancelled = Boolean(cancellation?.cancelRequestedAt);
                const retryEligible = !cancelled && handlerFailure.code !== "JOB_ACTOR_UNAVAILABLE"
                    && retry !== null && Number(row.attempts) + 1 < retry.maxAttempts;
                const retryAvailableAtCandidate = retryEligible ? jobTimestampAfter(database.clock.now(), retry.delayMs) : null;
                const remainingAttempts = retry === null ? 0 : retry.maxAttempts - (Number(row.attempts) + 1);
                const retryAvailableAt = retryAvailableAtCandidate !== null && retry !== null
                    && jobRetryHorizonFits(new Date(retryAvailableAtCandidate), retry, remainingAttempts)
                    ? retryAvailableAtCandidate
                    : null;
                const retryPolicyInvalid = !cancelled && handlerFailure.code !== "JOB_ACTOR_UNAVAILABLE"
                    && (retry === null || (retryEligible && retryAvailableAt === null));
                const failure = retryPolicyInvalid
                    ? invalidJobRetryPolicyFailure()
                    : handlerFailure;
                history.push({ attempt: Number(row.attempts) + 1, startedAt, outcome: cancelled ? "cancelled" : "failed", code: failure.code, completedAt: failedAt });
                if (cancelled) {
                    await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status]='cancelled', [failure]=?, [failedAt]=?, [leaseExpiresAt]=NULL, [claimToken]=NULL, [attemptHistory]=? " +
                        "WHERE [id]=? AND [status]='running' AND [claimToken]=?")).run(JSON.stringify(failure), failedAt, JSON.stringify(history), row.id, claimToken);
                }
                else if (retryAvailableAt !== null) {
                    const changed = await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status]='delayed', [availableAt]=?, [leaseExpiresAt]=NULL, [claimToken]=NULL, [attemptHistory]=? " +
                        "WHERE [id]=? AND [status]='running' AND [claimToken]=?")).run(retryAvailableAt, JSON.stringify(history), row.id, claimToken);
                    if (Number(changed?.changes ?? 0) === 1)
                        scheduleJobWorkerWake(database, retry.delayMs + 1);
                }
                else {
                    await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status] = 'failed', [failure] = ?, [failedAt] = ?, [leaseExpiresAt]=NULL, [claimToken]=NULL, [attemptHistory]=? " +
                        "WHERE [id] = ? AND [status]='running' AND [claimToken]=?")).run(boundedJobJson(failure, 8 * 1024, "JOB_FAILURE_TOO_LARGE", "Job failure metadata"), failedAt, JSON.stringify(history), row.id, claimToken);
                }
            }
            finally {
                const activeClaim = database.__jobAbortControllers?.get(row.id);
                if (activeClaim?.claimToken === claimToken)
                    database.__jobAbortControllers.delete(row.id);
            }
        }
    }
    finally {
        database.__jobWorkerRunning = false;
        const rerunRequested = database.__jobWorkerRerunRequested === true;
        database.__jobWorkerRerunRequested = false;
        if (rerunRequested && !database.__jobStopped)
            scheduleCurrentUserJobWorker(database);
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
//# sourceMappingURL=server-runtime-source.js.map