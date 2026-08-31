import type { IncomingMessage, ServerResponse, IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import { WithImplicitCoercion } from "buffer";
import { BinaryLike, KeyObject } from "node:crypto";
// `createHmac` left this line with the S3 signing path in batch 6: `s3Hmac` was its only remaining
// consumer, and it reaches the builtin through `process.getBuiltinModule` in `file-storage-runtime.ts`
// now (ADR-0042). The rest of this list has been wider than what this file binds since batch 3 —
// tsc elides an unused import, so the generated `dist/` has carried only what is actually called.
import { createHash, createPrivateKey, randomBytes, randomUUID, scryptSync, sign, timingSafeEqual, verify } from "node:crypto";
import { PathLike, PathOrFileDescriptor, appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { SQLOutputValue, StatementResultingChanges, StatementColumnMetadata } from "node:sqlite";
import { Duplex } from "stream";
import { validateMailConfig } from "./mail-config.js";
import { validateStripePaymentsRuntimeConfig } from "./stripe-payment-config.js";
import { createMailRuntime } from "./mail-runtime.js";
import { createEmailEventEndpoints } from "./email-events-runtime.js";
import { sqlWithoutTrailingTerminator, validateReadOnlyInspectionSql } from "./inspection-sql.js";
import { isInternalLogIndexMetadataRow, targetsInternalLogIndexTable } from "./log-index-guard.js";
import { HelperError, assertJsonCompatible, commandError, invalidReferenceError } from "./runtime-errors.js";
import {
  PASSWORD_RESET_DEFAULT_PATH, PASSWORD_RESET_DEFAULT_TTL_MS, PASSWORD_RESET_REQUEST_JOB,
  PASSWORD_RESET_MAX_TTL_MS, PASSWORD_RESET_MIN_TTL_MS, PASSWORD_RESET_THROTTLE_FIELD,
  EMAIL_SIGN_IN_FAILURE_LIMIT, EMAIL_SIGN_IN_THROTTLE_MAX_ENTRIES, EMAIL_SIGN_IN_THROTTLE_WINDOW_MS,
  PRIVILEGED_AUTH_USER_ID, appleOAuthOriginEligible, assertNotReservedAuthUserId,
  authIdentityRowUnlessReserved, authIdentityRowsUnlessReserved, authProvidersForClient, authStatus,
  capsuleIngressAuthUserId, confirmPasswordReset, createAuthDenialLogData, createEmailPasswordResetLink, createSessionToken, currentEmailSignInThrottleState,
  emailAuthDisabledError, emitAuthDeniedLog, hashEmailPassword,
  invalidEmailCredentialsError, isReservedAuthUserId, mailNotConfiguredError,
  normalizeEmailCredentials, normalizePasswordResetPath, normalizeReturnTo, normalizeSimulatedText,
  oauthProviderAdapter, parseOAuthFormBody, prepareEmailPasswordResetDelivery, privilegedAuthUserId,
  readEndpointSessionToken, recordFailedEmailSignInAttempt, refreshSessionOnAdapter, requireAuth,
  resetEmailSignInAttempts, resolveAnonymousSession, serverAuthError, sessionExpiresAt, setEmailPassword,
  setOwnEmailPassword, validateConsumedOAuthCallbackParameters, verifyEmailPassword,
  verifyPasswordResetCode, writeRedirect,
} from "./auth-runtime.js";
// Batch 5. `createWebSocketHub` calls the two email entry points and `routeSporadesAuth` calls
// the identity link; all three left this file for `auth-runtime.ts` in that batch, once user
// preferences stopped holding them.
import { linkProviderIdentity, signInWithEmail, signUpWithEmail } from "./auth-runtime.js";
// Batch 8. `createWebSocketHub` starts an OAuth sign-in, and `openDevDatabase` and
// `sendEmailPasswordResetLink` read the reset-link configuration. Both left this file for
// `auth-runtime.ts` in that batch, once the HTTP layer stopped holding them.
import { beginOAuthSignIn, reconcileOAuthRegistrationKeys, resolvePasswordResetConfig, retireOAuthRegistrationKeys } from "./auth-runtime.js";
// Batch 9. The auth storage bootstrap went home to its own domain's module once the shared adapter
// method set — the only thing that calls it — was on its way out of this file. `ensureAuthStorage()`
// resolves it here for as long as that method set is still below.
import { createAnonymousAuthTables } from "./auth-runtime.js";
import {
  createUserPreferencesTables, readCurrentUserPreferences, updateCurrentUserPreferences,
} from "./user-preferences-runtime.js";
import { countAcceptedTeamMembers, countTeamMembers, createAdditionalTeam, createCurrentUserTeamsApi, createPrivilegedTeamsApi, createTeamJoinLink, deleteCurrentUserTeam, demoteTeamMember, flushTeamSecurityEvents, inspectTeamJoinLink, joinCurrentUserTeam, leaveCurrentUserTeam, listCurrentUserTeams, listTeamJoinLinks, listTeamMembers, normalizeTeamApplicationRoles, promoteTeamMember, removeTeamMember, renameCurrentUserTeam, resolveTeamJoinLinkConfig, revokeTeamJoinLink, updateTeamMemberApplicationRoles, validateTeamJoinLink } from "./teams-runtime.js";
import {
  TEAM_BILLING_CHECKOUT_JOB,
  TEAM_BILLING_CHECKOUT_EXPIRY_JOB,
  TEAM_BILLING_CHECKOUT_MAX_ATTEMPTS,
  TEAM_BILLING_PORTAL_EXPIRY_JOB,
  TEAM_BILLING_PORTAL_JOB,
  TEAM_BILLING_PORTAL_MAX_ATTEMPTS,
  createPrivilegedTeamBillingApi,
  expireTeamBillingCheckout,
  expireTeamBillingPortal,
  normalizeTeamBillingDefinition,
  performTeamBillingCheckout,
  performTeamBillingPortal,
  readCurrentUserTeamBilling,
  safeTeamBillingProjection,
  settleExhaustedTeamBillingCheckoutJob,
  startTeamBillingCheckout,
  startTeamBillingPortal,
  teamBillingErasureObjectKey,
} from "./team-billing-runtime.js";
import { applyVerifiedTeamBillingObservation } from "./team-billing-convergence.js";
import {
  TEAM_BILLING_PLAN_TRANSITION_JOB,
  TEAM_BILLING_SEAT_CONVERGENCE_JOB,
  performTeamBillingPlanTransition,
  performTeamBillingSeatConvergence,
  repairTeamBillingDesiredStateAtStartup,
  requestTeamBillingPlanTransition,
  settleExhaustedTeamBillingManagementJob,
  stageTeamBillingMembershipChange,
} from "./team-billing-management.js";
import {
  TEAM_BILLING_ERASURE_JOB,
  createCurrentUserTeamBillingErasureApi,
  performTeamBillingErasure,
  prepareTeamBillingErasure,
  repairTeamBillingErasureStateAtStartup,
  settleExhaustedTeamBillingErasureJob,
} from "./team-billing-erasure.js";
// Batch 8. Eight names, which is what the one function of that domain still in this file
// (`routeEndpoint`), plus `readEndpointBody`, `openDevDatabase` and `createWebSocketHub`, resolve.
// `routeEndpoint` takes the three writers and the failure log; `readEndpointBody` the body reader;
// `openDevDatabase` the body limit and the security policy; and `createWebSocketHub` the security
// policy, the WebSocket origin check and the request-origin resolver.
import {
  emitHttpFailureLog, readLimitedRequestBody, resolveHttpMaxBodyBytes, resolveOAuthRequestOrigin,
  resolveRuntimeSecurityPolicy, websocketOriginAllowed, writeEndpointError, writeEndpointResult,
} from "./http-runtime.js";
import { chainMaybePromise, isPromiseLike, thenIfPromise } from "./maybe-promise.js";
import { isSensitiveLogKey, logIndexLimit } from "./runtime-log-policy.js";
import {
  accessKeyGrantsSatisfyScopes,
  normalizeCapsuleAuthDefinition,
  readAuthRequirements,
  validateCapsuleAuthRequirements,
} from "./auth-admission.js";
import {
  accessKeyCredentialLogAttribution, bindAccessKeyOwnerSession, createCurrentUserAccessKeysApi, createPrivilegedAccessKeysApi, emitAccessKeyAdmittedAudit,
  accessKeySecretWasDisclosed,
  dropAccessKeyLifecycleAuditEvents, flushAccessKeyLifecycleAuditEvents,
  grantPrivilegedAccessKeyAccess,
  publicAccessKeyManagementError, recordAccessKeyUsage, resolveAccessKeyCredential, transferAccessKeyRuntimeState,
  revokePrivilegedAccessKeyAccess,
} from "./access-keys-runtime.js";
import { createServiceUsersApi } from "./service-users-runtime.js";
import { validateAccessKeyOperatorActionInput } from "./cli/access-key-operator-envelope.js";
// Batch 9. The four names the shared Database adapter method set resolves in the Log index's
// storage module — `ensureLogStorage()` and the three statements that write, prune and read the
// index. The log sink in this file needs none of them: it reaches the same three through
// `database.*`, which is an adapter method rather than a module binding.
import {
  createLogIndexTables, insertLogIndexEvent, pruneLogIndex, readRecentLogEvents,
} from "./log-index-storage.js";
// Batch 9 left one engine-construction name here: `openDevDatabase` builds the Capsule's adapter
// with it. Trusted policy reads now also ask that module whether the supplied adapter is an active
// transaction scope. The runtime reaches engine behavior through those two names rather than
// owning another adapter path here.
import { createRuntimeDatabaseAdapter, isActiveTransactionScopedAdapter } from "./database-runtime.js";
import { deserializeFieldValue, deserializeRow, normalizeDateValue, serializeFieldValue } from "./stored-value-coding.js";
// Twenty-one names, which is what the three functions of that domain still in this file plus
// `openDevDatabase`, the endpoint table API, the schema extractor and the four mutation and message
// runners resolve. `ACL_HELPER_STATE` and `createTableAclContext` are deliberately not among them:
// both are exported from `acl-runtime.js` for consumers outside this file — the constant probe and
// `test/mail.test.js` — and reach them through the `export *` below rather than through a binding
// here, so importing them would declare a name nothing in this file reads.
import {
  applyReadAcl, assertActivePrivilegedJobAccess, createPrivilegedAuditEmitter,
  createPrivilegedAuditEmissionPublicError, createPrivilegedFileApi, createPrivilegedRunAbortError,
  createPrivilegedRunAuditDetails, createPrivilegedRunPublicError, createPrivilegedScheduleApi,
  drainPendingAclWrites, emitAclDeniedLog, emitPrivilegedRunAudit,
  filterRowsByReadAcl, grantPrivilegedDbAccess, isPrivilegedAuditEmissionPublicError,
  normalizeFileAcl, normalizePrivilegedRunSignal, normalizeTableAcl, reindexPrivilegedAuditEventsAfterRollback,
  revokePrivilegedDbAccess, runTableWriteWithAcl, safePrivilegedAuditErrorCode,
} from "./acl-runtime.js";
import {
  checkRuntimeFileStorage, completePendingFileUpload, contentTypeForFile, createFileStorageTables,
  createPendingFileUpload, createPublicFileUrl, createRuntimeFileStorageAdapter,
  createStructuredFileError, deletePrivateFile, fileMetadataFromRow,
  getPrivateFileUrl, isAbsoluteFilePath, normalizeAbsoluteFilePath, resolvePrivilegedLiveFileReference,
  revokePublicFileUrl,
} from "./file-storage-runtime.js";
import { createEndpointIngressApi, finalizeEndpointIngressClaims, stageMultipartIngress, sweepExpiredFileIngress, validateMultipartIngressPolicy } from "./file-ingress-runtime.js";
import {
  abortSchedulePayloadFactories, assertJobScheduleProvenance, boundedJobJson, cancelJob,
  canonicalJobAuthSnapshot, canonicalJobCredentialProvenance, captureJobAuthSnapshot,
  commitPendingJobCancellationAborts, createRuntimeClock, decodeJobCursor,
  dropPendingJobCancellationAborts, encodeJobCursor, ensureJobStorage, ensureScheduleStorage,
  finishFailedScheduledOccurrence, invalidJobRetryPolicyFailure, isCanonicalJobTimestamp, jobActorProvider, jobError,
  jobHandlersFromCapsuleDefinition, jobState, jobSummary, jobTimestampAfter, MAX_JOB_TIMESTAMP_MS, nextScheduleCursor, nextScheduleOccurrence,
  normalizeJobAvailableAt, normalizeJobRetry, parsePersistedJobRetry, readJobAuthSnapshot, readJobCredentialProvenance, resolveSchedulePayload,
  RESERVED_JOB_NAME_PREFIX, resolveSchedulePayloadFactoryTimeoutMs, runtimeOwnedJobHandlers, safeJobFailure,
  scheduleStripeEventPayloadCleanup, startStripeEventPayloadCleanup, stopStripeEventPayloadCleanup,
  STRIPE_EVENT_JOB, stripeEventPayloadRetentionStorageValue,
  scheduleCursorStateIsConsistent, scheduleDefinitionsFromCapsule, scheduleSummary, scheduledOccurrenceIdentity,
} from "./jobs-runtime.js";
import { dispatchVerifiedStripeEvent } from "./stripe-events-runtime.js";

const mutationResultsWithWrites = new WeakSet<object>();
const trustedReadPurposes = new Set(["teams.join-admission", "team-billing.authority", "files.ingress-admission"]);
const trustedReadTransactionAdapter = Symbol("sporades.trustedReadTransactionAdapter");
const runtimeOwnedJobEnqueueHandler = Symbol("sporades.runtimeOwnedJobEnqueueHandler");
const atomicStripeEventDefinitionBrand = Symbol.for("sporades.stripeEvent.atomicDefinition");
const atomicStripeFenceContention = Symbol("sporades.atomicStripeFenceContention");

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

type LooseRecord = Record<string, any>;
type RuntimeConfig = LooseRecord;
type RuntimeEnv = Record<string, string | undefined>;
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

export async function shutdownAndCloseDatabase(database: LooseRecord) {
  let shutdownError: unknown;
  let closeError: unknown;
  let shutdownRejected = false;
  let closeRejected = false;
  try { await database.shutdown(); }
  catch (error) { shutdownRejected = true; shutdownError = error; }
  try { await database.close(); }
  catch (error) { closeRejected = true; closeError = error; }
  if (shutdownRejected && closeRejected) {
    throw new AggregateError([shutdownError, closeError], "Runtime shutdown and database closure both failed.");
  }
  if (shutdownRejected) throw shutdownError;
  if (closeRejected) throw closeError;
}

export async function shutdownHttpServerAndRuntime(server: LooseRecord, shutdownRuntime: () => any) {
  let serverError: unknown;
  let runtimeError: unknown;
  let serverRejected = false;
  let runtimeRejected = false;
  try {
    await new Promise<void>((resolve, reject) => {
      try {
        server.close((error?: Error) => error ? reject(error) : resolve());
      } catch (error) {
        reject(error);
      }
    });
  } catch (error) {
    serverRejected = true;
    serverError = error;
  }
  try { await shutdownRuntime(); }
  catch (error) { runtimeRejected = true; runtimeError = error; }
  if (serverRejected && runtimeRejected) {
    throw new AggregateError([serverError, runtimeError], "HTTP server closure and runtime shutdown both failed.");
  }
  if (serverRejected) throw serverError;
  if (runtimeRejected) throw runtimeError;
}

export async function replaceRuntimeDatabase(currentDatabase: LooseRecord, candidateDatabase: LooseRecord) {
  try {
    await candidateDatabase.__deferJobExecution?.();
    await candidateDatabase.init();
  } catch (initError) {
    try { await candidateDatabase.close(); }
    catch (closeError) {
      throw new AggregateError([initError, closeError], "Runtime initialization and candidate database closure both failed.");
    }
    throw initError;
  }
  try {
    candidateDatabase.__preflightJobExecutionActivation?.();
    await candidateDatabase.__publishAccessKeyScopes?.();
  } catch (preflightError) {
    try { await shutdownAndCloseDatabase(candidateDatabase); }
    catch (cleanupError) {
      throw new AggregateError([preflightError, cleanupError], "Runtime activation preflight and candidate database cleanup both failed.");
    }
    throw preflightError;
  }
  let teardownError: unknown;
  try {
    await shutdownAndCloseDatabase(currentDatabase);
  } catch (error) {
    teardownError = error;
  }
  // Candidate startup can finish its lease and queue scans while the outgoing
  // worker still owns, or is about to acquire, a running claim. Refresh both
  // tracked recovery and runnable work after outgoing settlement: a failed
  // teardown may leave the claim leased, while orderly settlement may return
  // it to delayed/queued state.
  let activationError: unknown;
  try {
    if (typeof candidateDatabase.__activateJobExecution === "function") {
      candidateDatabase.__activateJobExecution(candidateDatabase.clock.now().getTime());
    } else {
      scheduleJobLeaseRecoveryAt(candidateDatabase, candidateDatabase.clock.now().getTime());
      scheduleCurrentUserJobWorker(candidateDatabase);
    }
  } catch (error) {
    activationError = error;
  }
  if (activationError !== undefined) {
    emitRuntimeReplacementWarning(
      candidateDatabase,
      "dev.runtime.job_activation_degraded",
      "Replacement runtime Job activation degraded",
      activationError,
      "RUNTIME_JOB_ACTIVATION_FAILED",
    );
  }
  if (teardownError !== undefined) {
    // Candidate initialization is the ownership decision. The old runtime may
    // already be stopped and its adapter has been closed by the teardown helper,
    // so rejecting here would leave the Dev server pointing at a dead runtime
    // while also destroying its only viable replacement.
    emitRuntimeReplacementWarning(
      candidateDatabase,
      "dev.runtime.previous_teardown_failed",
      "Previous Dev runtime teardown failed after replacement",
      teardownError,
      "RUNTIME_TEARDOWN_FAILED",
    );
  }
  return candidateDatabase;
}

function emitRuntimeReplacementWarning(database: LooseRecord, event: string, message: string, error: unknown, fallbackCode: string) {
  try {
    const warning = database.log?.emit?.({
      category: "platform",
      event,
      level: "warn",
      message,
      data: { code: String((error as any)?.code ?? fallbackCode).slice(0, 80) },
    });
    // Ownership must return to the caller without waiting for logging I/O;
    // otherwise requests can still observe the already-closed prior runtime.
    Promise.resolve(warning).catch(() => {});
  } catch { }
}


function endpointIngressClaimAuthority(endpoint: LooseRecord) {
  const declared = endpoint?.options?.body?.multipart?.claimAuthorities;
  if (declared === undefined) return "actor";
  if (!Array.isArray(declared) || declared.length !== 1 || !["actor", "capsule-principal"].includes(declared[0])) {
    throw commandError("Invalid multipart claim authority.", "Declare exactly one of actor or capsule-principal for this endpoint.", "INVALID_FILE_INGRESS_AUTHORITY");
  }
  return declared[0];
}

function normalizeCapsuleFileIngressDefinition(files: LooseRecord | undefined, endpoints: LooseRecord[]) {
  const usesCapsulePrincipal = endpoints.some((endpoint) => endpoint?.options?.body?.multipart && endpointIngressClaimAuthority(endpoint) === "capsule-principal");
  if (!usesCapsulePrincipal) return null;
  const ingress = files?.ingress;
  const namespaces = ingress?.principalNamespaces;
  if (!ingress || typeof ingress !== "object" || Array.isArray(ingress) || typeof ingress.admit !== "function" || !Array.isArray(namespaces) || namespaces.length === 0 || namespaces.length > 32 || namespaces.some((value: any) => typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) || new Set(namespaces).size !== namespaces.length) {
    throw commandError("Invalid Capsule File ingress admission.", "Declare files.ingress with unique principalNamespaces and an admit function.", "INVALID_FILE_INGRESS_ADMISSION");
  }
  if (typeof files?.acl?.read !== "function" || typeof files?.acl?.delete !== "function") {
    throw commandError("Capsule-principal File ingress requires explicit File ACL rules.", "Declare files.acl.read and files.acl.delete before enabling capsule-principal claims.", "FILE_INGRESS_ACL_REQUIRED");
  }
  return Object.freeze({ principalNamespaces: Object.freeze([...namespaces]), admit: ingress.admit });
}

export async function openDevDatabase(
  databasePath: string,
  serverSource: any,
  serverEnv: RuntimeEnv = {},
  config: RuntimeConfig = {},
  capsuleDefinition: any = null,
  options: LooseRecord = {},
) {
  if (capsuleDefinition) {
    capsuleDefinition = normalizeCapsuleAuthDefinition(capsuleDefinition);
    validateCapsuleAuthRequirements(capsuleDefinition);
    validateStripeEventSubscription(capsuleDefinition.stripeEvents);
  }
  const paymentsConfig = validateStripePaymentsRuntimeConfig(config.payments, serverEnv);
  if (capsuleDefinition?.teams !== undefined && (!capsuleDefinition.teams || typeof capsuleDefinition.teams !== "object" || Array.isArray(capsuleDefinition.teams))) {
    throw commandError("Invalid Capsule Teams declaration.", "Declare teams as { appRoles?: string[], admitJoin?: function }.", "INVALID_TEAM_APPLICATION_ROLES");
  }
  if (capsuleDefinition?.teams?.admitJoin !== undefined && typeof capsuleDefinition.teams.admitJoin !== "function") {
    throw commandError("Invalid Capsule Team admission policy.", "Declare teams.admitJoin as a server function.", "INVALID_TEAM_JOIN_ADMISSION");
  }
  const teamApplicationRoles = normalizeTeamApplicationRoles(capsuleDefinition?.teams?.appRoles);
  const teamBillingDefinition = capsuleDefinition?.teamBilling === undefined
    ? null
    : normalizeTeamBillingDefinition(capsuleDefinition.teamBilling);
  if (capsuleDefinition?.files !== undefined && (!capsuleDefinition.files || typeof capsuleDefinition.files !== "object" || Array.isArray(capsuleDefinition.files))) {
    throw commandError("Invalid Capsule Files declaration.", "Declare files as { acl?: { read?, publicUrl?, delete? } }.", "INVALID_FILE_ACL");
  }
  const fileAcl = normalizeFileAcl(capsuleDefinition?.files?.acl);
  const path = await import("node:path");
  const mailConfig = validateMailConfig(config.mail);
  let mailLogSink: LooseRecord | undefined;
  const mail = createMailRuntime(mailConfig, serverEnv, {
    ...options,
    mailLog: options.mailLog ?? ((event: LooseRecord) => mailLogSink?.emit(event)),
  });
  const capsuleEndpoints = capsuleDefinition
    ? endpointHandlersFromCapsuleDefinition(capsuleDefinition)
    : extractEndpoints(serverSource);
  for (const declaredEndpoint of capsuleEndpoints as LooseRecord[]) if (declaredEndpoint?.options?.body?.multipart !== undefined) validateMultipartIngressPolicy(declaredEndpoint.options.body.multipart);
  const emailEventEndpoints = createEmailEventEndpoints(mailConfig, serverEnv, capsuleDefinition?.emailEvents);
  const stripeCallbackEndpoint = paymentsConfig?.stripe.enabled
    ? options?.createStripeCallbackEndpoint?.(
        paymentsConfig,
        serverEnv,
        options?.stripeCallbackAdmissionFault,
      )
    : null;
  if (paymentsConfig?.stripe.enabled && !stripeCallbackEndpoint) {
    throw commandError(
      "Stripe callback integration is unavailable.",
      "Build and run this Capsule with matching Sporades generated runtime artifacts.",
      "STRIPE_CALLBACK_INTEGRATION_UNAVAILABLE",
    );
  }
  const providerEndpoints: LooseRecord[] = [...emailEventEndpoints, ...(stripeCallbackEndpoint ? [stripeCallbackEndpoint] : [])];
  for (const [providerIndex, providerEndpoint] of providerEndpoints.entries()) {
    const conflictsWithCapsule = capsuleEndpoints.some(
      (endpoint: LooseRecord) => endpoint.method === providerEndpoint.method && endpoint.path === providerEndpoint.path,
    );
    const conflictsWithProvider = providerEndpoints.slice(0, providerIndex).find(
      (endpoint: LooseRecord) => endpoint.method === providerEndpoint.method && endpoint.path === providerEndpoint.path,
    );
    if (conflictsWithCapsule || conflictsWithProvider) {
      const stripeConflict = providerEndpoint.runtimeOwnedStripeCallback || conflictsWithProvider?.runtimeOwnedStripeCallback;
      const error: any = new Error(stripeConflict
        ? "Stripe callback route conflicts with another Capsule or provider route."
        : "Capsule endpoint conflicts with an email-provider webhook route.");
      error.code = stripeConflict ? "STRIPE_CALLBACK_ROUTE_CONFLICT" : "EMAIL_EVENT_ROUTE_CONFLICT";
      error.hint = "Assign every Capsule endpoint and enabled provider a different path in sporades.json.";
      throw error;
    }
  }
  const endpoints = [...capsuleEndpoints, ...providerEndpoints];
  const fileIngressDefinition = normalizeCapsuleFileIngressDefinition(capsuleDefinition?.files, endpoints);
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
  const queries: any[] = (extractQueryHandlersFromCapsule(capsuleDefinition) as any) ?? (extractQueryHandlers(serverSource) as any);
  const mutations: any[] = (capsuleDefinition
    ? mutationHandlersFromCapsuleDefinition(serverSource, capsuleDefinition)
    : extractMutationHandlers(serverSource)) as any[];
  const messages = capsuleDefinition
    ? handlersFromCapsuleDefinition(capsuleDefinition.messages, "message")
    : extractMessageHandlers(serverSource);
  let database: LooseRecord;
  const jobs = [...jobHandlersFromCapsuleDefinition(capsuleDefinition), ...runtimeOwnedJobHandlers({
    prepareEmailPasswordResetDelivery: (context: LooseRecord, payload: LooseRecord) =>
      prepareEmailPasswordResetDelivery(database, payload, database.__runtimeJobAttempts.get(context) ?? 1),
    dispatchStripeEvent: async (context: LooseRecord, event: LooseRecord) => {
      const subscription = capsuleDefinition?.stripeEvents;
      const atomicSubscription = subscription?.options?.consequence === "atomic" ? subscription : undefined;
      const platformConsequence = database.teamBillingDefinition ? applyVerifiedTeamBillingObservation : undefined;
      if (atomicSubscription || platformConsequence) {
        const result = await runAtomicStripeConsequence(database, context, event, atomicSubscription, platformConsequence);
        return !atomicSubscription && subscription
          ? dispatchVerifiedStripeEvent(context, event, subscription)
          : result;
      }
      return dispatchVerifiedStripeEvent(context, event, subscription);
    },
    performTeamBillingCheckout: (context: LooseRecord, payload: LooseRecord) =>
      performTeamBillingCheckout(database, context, payload, database.__runtimeJobAttempts.get(context) ?? 1),
    expireTeamBillingCheckout: (context: LooseRecord, payload: LooseRecord) =>
      expireTeamBillingCheckout(database, context, payload),
    performTeamBillingPortal: (context: LooseRecord, payload: LooseRecord) =>
      performTeamBillingPortal(database, context, payload, database.__runtimeJobAttempts.get(context) ?? 1),
    expireTeamBillingPortal: (context: LooseRecord, payload: LooseRecord) =>
      expireTeamBillingPortal(database, context, payload),
    performTeamBillingPlanTransition: async (context: LooseRecord, payload: LooseRecord) => {
      try { return await performTeamBillingPlanTransition(database, context, payload); }
      catch (error) {
        if ((database.__runtimeJobAttempts.get(context) ?? 1) >= 3) {
          await settleExhaustedTeamBillingManagementJob(database, payload, (error as any)?.code);
        }
        throw error;
      }
    },
    performTeamBillingSeatConvergence: async (context: LooseRecord, payload: LooseRecord) => {
      try { return await performTeamBillingSeatConvergence(database, context, payload); }
      catch (error) {
        if ((database.__runtimeJobAttempts.get(context) ?? 1) >= 3) {
          await settleExhaustedTeamBillingManagementJob(database, payload, (error as any)?.code);
        }
        throw error;
      }
    },
    performTeamBillingErasure: async (context: LooseRecord, payload: LooseRecord) => {
      try { return await performTeamBillingErasure(database, context, payload); }
      catch (error) {
        if ((database.__runtimeJobAttempts.get(context) ?? 1) >= 6) {
          await settleExhaustedTeamBillingErasureJob(database, payload, (error as any)?.code);
        }
        throw error;
      }
    },
  })];
  const schedules = scheduleDefinitionsFromCapsule(capsuleDefinition, jobs);
  const clock = createRuntimeClock(options?.clock);
  const contextMiddleware = capsuleDefinition?.middleware?.map((middleware: Function) => middleware.toString())
    ?? extractContextMiddleware(serverSource);
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
    accessKeyScopes: capsuleDefinition?.accessKeys?.scopes ?? [],
    securitySession: config.__sporadesSession ?? "container",
    clock,
    capsuleIdentity: String(config.name ?? "capsule"),
    capsuleIngressOwnerId: capsuleIngressAuthUserId(config.name ?? capsuleDefinition?.name ?? "capsule"),
    fileIngressDefinition,
    scheduleOccurrenceFault: options?.scheduleOccurrenceFault,
    scheduleReconciliationFault: options?.scheduleReconciliationFault,
    jobRecoveryFault: options?.jobRecoveryFault,
    schedulePayloadFactoryTimeoutMs,
    schedulePayloadFactoryActive: 0,
    schedulePayloadFactoryWaiters: [],
    schedulePayloadFactoryLanes: new Map(),
    schedulePayloadFactoryControllers: new Map(),
    // Construction is not runtime publication. Hooks may persist Jobs during
    // initialization, but no worker or recovery wake may run until every init
    // gate has accepted this candidate.
    __jobStopped: true,
    __jobLeaseRecoveryTimer: null,
    __jobLeaseRecoveryDueAt: null,
    __jobLeaseRecoveryPromise: null,
    __jobLeaseRecoveryRequestedAt: null,
    __jobActivationDeferred: false,
    __scheduleStopped: true,
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
    paymentsConfig,
    createStripeTeamBillingProvider: options?.createStripeTeamBillingProvider,
    stripeApiBaseUrl: options?.stripeApiBaseUrl,
    enqueueTeamBillingCheckoutJob: (transaction: LooseRecord, payload: LooseRecord, idempotencyKey: string) =>
      enqueueRuntimeJob({ ...database, adapter: transaction, __rootDatabase: database }, TEAM_BILLING_CHECKOUT_JOB, payload, idempotencyKey, { maxAttempts: TEAM_BILLING_CHECKOUT_MAX_ATTEMPTS, delayMs: 1_000 }, true),
    enqueueTeamBillingCheckoutExpiryJob: (transaction: LooseRecord, payload: LooseRecord, idempotencyKey: string, availableAt: string) =>
      enqueueRuntimeJob({ ...database, adapter: transaction, __rootDatabase: database }, TEAM_BILLING_CHECKOUT_EXPIRY_JOB, payload, idempotencyKey, undefined, true, availableAt),
    enqueueTeamBillingPortalJob: (transaction: LooseRecord, payload: LooseRecord, idempotencyKey: string) =>
      enqueueRuntimeJob({ ...database, adapter: transaction, __rootDatabase: database }, TEAM_BILLING_PORTAL_JOB, payload, idempotencyKey, { maxAttempts: TEAM_BILLING_PORTAL_MAX_ATTEMPTS, delayMs: 1_000 }, true),
    enqueueTeamBillingPortalExpiryJob: (transaction: LooseRecord, payload: LooseRecord, idempotencyKey: string, availableAt: string) =>
      enqueueRuntimeJob({ ...database, adapter: transaction, __rootDatabase: database }, TEAM_BILLING_PORTAL_EXPIRY_JOB, payload, idempotencyKey, undefined, true, availableAt),
    enqueueTeamBillingPlanTransitionJob: (transaction: LooseRecord, payload: LooseRecord, idempotencyKey: string, availableAt?: string) =>
      enqueueRuntimeJob({ ...database, adapter: transaction, __rootDatabase: database }, TEAM_BILLING_PLAN_TRANSITION_JOB, payload, idempotencyKey, { maxAttempts: 3, delayMs: 5_000 }, true, availableAt, availableAt !== undefined),
    enqueueTeamBillingSeatConvergenceJob: (transaction: LooseRecord, payload: LooseRecord, idempotencyKey: string, availableAt?: string) =>
      enqueueRuntimeJob({ ...database, adapter: transaction, __rootDatabase: database }, TEAM_BILLING_SEAT_CONVERGENCE_JOB, payload, idempotencyKey, { maxAttempts: 3, delayMs: 60_000 }, true, availableAt, availableAt !== undefined),
    enqueueTeamBillingErasureJob: (transaction: LooseRecord, payload: LooseRecord, idempotencyKey: string, availableAt?: string) =>
      enqueueRuntimeJob({ ...database, adapter: transaction, __rootDatabase: database }, TEAM_BILLING_ERASURE_JOB, payload, idempotencyKey, { maxAttempts: 6, delayMs: 60_000 }, true, availableAt, availableAt !== undefined),
    stageTeamBillingMembershipChange: (teamId: string) => stageTeamBillingMembershipChange(database, teamId),
    readTeamBillingActorAuth: async (transaction: LooseRecord, userId: string) => {
      if (typeof userId !== "string") return null;
      const actor = await transaction.prepare(transaction.dialect.sql(
        "SELECT [id], [displayName], [email], [picture], [isAuthenticated], [isGuest], [provider] FROM [sporades_auth_users] WHERE [id] = ?",
      )).get(userId);
      return actor ? Object.freeze({
        userId: actor.id,
        displayName: actor.displayName,
        email: actor.email,
        picture: actor.picture,
        isAuthenticated: Boolean(actor.isAuthenticated),
        isGuest: Boolean(actor.isGuest),
        provider: actor.provider,
      }) : null;
    },
    updateTeamBillingSubscription: async (context: LooseRecord, input: LooseRecord) => {
      if (typeof database.createStripeTeamBillingProvider !== "function") throw commandError(
        "Team Billing provider is unavailable.", "Retry after the configured provider is available.", "TEAM_BILLING_PROVIDER_UNAVAILABLE",
      );
      const provider = database.createStripeTeamBillingProvider({
        enabled: true, config: database.paymentsConfig.stripe, env: database.serverEnv, signal: context?.signal,
        ...(database.stripeApiBaseUrl ? { apiBaseUrl: database.stripeApiBaseUrl } : {}),
      });
      return provider.updateManagedSubscription(Object.freeze({
        mode: input.mode,
        customerId: input.providerCustomerId,
        subscriptionId: input.providerSubscriptionId,
        subscriptionItemId: input.providerSubscriptionItemId,
        sourcePriceId: input.sourcePriceId,
        targetPriceId: input.targetPriceId,
        ...(input.targetProductId ? { targetProductId: input.targetProductId } : {}),
        targetQuantity: input.targetQuantity,
        prorationDate: input.prorationDate,
        idempotencyKey: input.idempotencyKey,
        operationKind: input.operationKind,
      }));
    },
    quiesceTeamBillingProvider: async (context: LooseRecord, input: LooseRecord) => {
      if (typeof database.createStripeTeamBillingProvider !== "function") throw commandError(
        "Team Billing provider is unavailable.", "Retry after the configured provider is available.", "TEAM_BILLING_PROVIDER_UNAVAILABLE",
      );
      const provider = database.createStripeTeamBillingProvider({
        enabled: true, config: database.paymentsConfig.stripe, env: database.serverEnv, signal: context?.signal,
        ...(database.stripeApiBaseUrl ? { apiBaseUrl: database.stripeApiBaseUrl } : {}),
      });
      return provider.quiesceTeamBilling(input);
    },
    scheduleTeamBillingJobDispatch: () => scheduleCurrentUserJobWorker(database),
    mail,
    authConfig: authStatus(config, serverEnv),
    reauthenticationPolicy: capsuleDefinition?.auth?.reauthentication?.purposes ?? null,
    authorizeReauthentication: typeof capsuleDefinition?.auth?.reauthentication?.authorize === "function" ? async function (transaction: LooseRecord, auth: LooseRecord, purpose: string) {
      const reauthDatabase = createTransactionDatabase(database, transaction); let active = true; const assertActive = () => { if (!active) throw commandError("Reauthentication access is no longer active.", "Start a new reauthentication attempt.", "REAUTHENTICATION_ACCESS_INACTIVE"); };
      const reauthContext: LooseRecord = { purpose: "auth.reauthentication", auth }; grantPrivilegedDbAccess(reauthContext); const holder = createContextHolder(reauthContext);
      try { return (await capsuleDefinition.auth.reauthentication.authorize({ db: createEndpointReadOnlyDatabaseApi(reauthDatabase, () => holder.current, assertActive), auth }, purpose)) === true; }
      finally { active = false; revokePrivilegedDbAccess(reauthContext); }
    } : async () => true,
    passwordResetConfig: resolvePasswordResetConfig(config),
    teamJoinLinkConfig: resolveTeamJoinLinkConfig(config),
    teamApplicationRoles,
    teamBillingDefinition,
    teamBillingErasureObjectKey: (providerObjectId: string) => teamBillingErasureObjectKey(database, providerObjectId),
    runRegistrationAdmission: typeof capsuleDefinition?.auth?.registration?.admit === "function"
      ? async function (this: LooseRecord, transactionAdapter: LooseRecord, evidence: LooseRecord, admission: unknown) {
        const rootDatabase = this.__rootDatabase ?? this;
        const transaction = (this as any)[trustedReadTransactionAdapter] ?? transactionAdapter;
        const registrationDatabase = createTransactionDatabase(rootDatabase, transaction);
        let active = true;
        const assertActive = () => { if (!active) throw commandError("Registration access is no longer active.", "Start a new registration callback.", "REGISTRATION_ACCESS_INACTIVE"); };
        const readContext: LooseRecord = { purpose: "auth.registration", evidence, admission };
        grantPrivilegedDbAccess(readContext); const readHolder = createContextHolder(readContext);
        try {
          let decision: LooseRecord | null = null;
          try { decision = await capsuleDefinition.auth.registration.admit({ db: createEndpointReadOnlyDatabaseApi(registrationDatabase, () => readHolder.current, assertActive), evidence, admission }); }
          finally { active = false; revokePrivilegedDbAccess(readContext); }
          if (!decision || decision.allow !== true) return false;
          const finalizeContext: LooseRecord = { purpose: "auth.registration-finalize", evidence };
          grantPrivilegedDbAccess(finalizeContext); const finalizeHolder = createContextHolder(finalizeContext);
          try { await capsuleDefinition.auth.registration.finalize({ db: createEndpointDatabaseApi(registrationDatabase, () => finalizeHolder.current), evidence }, { ...evidence, state: decision.state }); }
          finally { revokePrivilegedDbAccess(finalizeContext); }
          return true;
        } finally { active = false; revokePrivilegedDbAccess(readContext); await drainPendingLogWrites(registrationDatabase); }
      }
      : undefined,
    runTeamJoinAdmission: typeof capsuleDefinition?.teams?.admitJoin === "function"
      ? async function (this: LooseRecord, transactionAdapter: LooseRecord, auth: LooseRecord, input: LooseRecord, signal: any) {
        const rootDatabase = this.__rootDatabase ?? this;
        const trustedTransaction = (this as any)[trustedReadTransactionAdapter] ?? transactionAdapter;
        const admissionDatabase = createTransactionDatabase(rootDatabase, trustedTransaction);
        try {
          return await withTrustedRead(rootDatabase, {
            transaction: trustedTransaction,
            purpose: "teams.join-admission",
            subject: { teamId: input.teamId, userId: input.userId },
            signal,
          }, (trustedDb, assertActive) => capsuleDefinition.teams.admitJoin(
            createTeamJoinAdmissionContext(admissionDatabase, auth, trustedDb, input.teamId, assertActive),
            input,
          ));
        } finally {
          await drainPendingLogWrites(admissionDatabase);
        }
      }
      : undefined,
    runTeamBillingAuthority: teamBillingDefinition
      ? async function (this: LooseRecord, transactionAdapter: LooseRecord, auth: LooseRecord, input: LooseRecord) {
        const rootDatabase = this.__rootDatabase ?? this;
        const trustedTransaction = (this as any)[trustedReadTransactionAdapter] ?? transactionAdapter;
        const policyDatabase = createTransactionDatabase(rootDatabase, trustedTransaction);
        try {
          return await withTrustedRead(rootDatabase, {
            transaction: trustedTransaction,
            purpose: "team-billing.authority",
            subject: { teamId: input.teamId, userId: auth.userId, operation: input.operation },
          }, (trustedDb, assertActive) => teamBillingDefinition.authorize(
            createTeamBillingAuthorityContext(policyDatabase, auth, trustedDb, input.teamId, assertActive),
            input,
          ));
        } finally {
          await drainPendingLogWrites(policyDatabase);
        }
      }
      : undefined,
    fileAcl,
    fileAccessKeyRead: capsuleDefinition?.files?.accessKeys?.read
      ? Object.freeze({ scopes: Object.freeze([...(capsuleDefinition.files.accessKeys.read.scopes ?? [])]) })
      : null,
    securityPolicy: resolveRuntimeSecurityPolicy(config),
    fileStorage,
    fileMaxSizeBytes: config.files?.maxSizeBytes ?? 10 * 1024 * 1024,
    httpMaxBodyBytes: resolveHttpMaxBodyBytes(config),
    close: () => {
      database.__scheduleStopped = true;
      abortSchedulePayloadFactories(database);
      for (const timer of database.__scheduleTimers ?? []) database.clock.clearTimer(timer);
      database.__scheduleTimers?.clear?.();
      const workerSettlement = stopCurrentUserJobWorker(database);
      const scheduleSettlement = settleActiveScheduleWork(database);
      const closeResources = () => {
        const failures: Array<{ index: number; error: unknown }> = [];
        const pending: Promise<void>[] = [];
        const resources = [
          () => database.mail.close(),
          () => database.adapter.close(),
          () => database.fileStorage.close(),
        ];
        for (const [index, closeResource] of resources.entries()) {
          const captureFailure = (error: unknown) => {
            failures.push({ index, error });
          };
          try {
            const result = closeResource();
            if (result && typeof result.then === "function") {
              pending.push(Promise.resolve(result).then(undefined, captureFailure));
            }
          } catch (error) {
            captureFailure(error);
          }
        }
        const finish = () => {
          const errors = failures.sort((left, right) => left.index - right.index).map(({ error }) => error);
          if (errors.length > 1) throw new AggregateError(errors, "Multiple runtime resources failed to close.");
          if (errors.length === 1) throw errors[0];
        };
        return pending.length > 0 ? Promise.all(pending).then(finish) : finish();
      };
      const runtimeSettlements = [workerSettlement, scheduleSettlement].filter(Boolean).map((settlement) => Promise.resolve(settlement));
      if (runtimeSettlements.length === 0) return closeResources();
      return (async () => {
        let workerError: unknown;
        let closeError: unknown;
        let workerRejected = false;
        let closeRejected = false;
        try { await Promise.all(runtimeSettlements); }
        catch (error) { workerRejected = true; workerError = error; }
        try { await closeResources(); }
        catch (error) { closeRejected = true; closeError = error; }
        if (workerRejected && closeRejected) throw new AggregateError([workerError, closeError], "Runtime settlement and resource closure both failed.");
        if (workerRejected) throw workerError;
        if (closeRejected) throw closeError;
      })();
    },
    __deferJobExecution: () => {
      database.__jobActivationDeferred = true;
      const activeWorker = database.__jobWorkerPromise;
      const completeSettlement = stopCurrentUserJobWorker(database);
      // A previously initialized test or internal candidate may already own a
      // read-only lease scan. Keep that scan in the single-flight chain so the
      // post-teardown activation can retain an immediate rerun behind it, but
      // do await any handler-bearing worker before treating the candidate as
      // safely gated.
      Promise.resolve(completeSettlement).catch(() => {});
      return activeWorker ? Promise.resolve(activeWorker) : undefined;
    },
    __activateJobExecution: (recoveryAt: number | null) => {
      database.__jobActivationDeferred = false;
      activateCurrentUserJobExecution(database, recoveryAt);
    },
    __preflightJobExecutionActivation: () => {
      preflightCurrentUserJobExecution(database);
    },
  };
  database.__publishAccessKeyScopes = () => database.adapter.writeSystemMetadata(
    "accessKeyScopes",
    JSON.stringify(database.accessKeyScopes ?? []),
  );
  database.init = async () => {
    if (database.__runtimeInitialized) return;
    try {
      if (database.lifecycleHooks.init !== undefined) {
        if (typeof database.lifecycleHooks.init !== "function") throw commandError("Invalid Capsule init hook.", "Declare hooks.init as a function.");
        await database.lifecycleHooks.init(createMutationContext(database, { userId: "__lifecycle__", displayName: "Capsule lifecycle", email: null, picture: null, isAuthenticated: false, isGuest: false, provider: "lifecycle" }, { ordinaryCredential: false }));
      }
      if (database.teamBillingDefinition) {
        await repairTeamBillingDesiredStateAtStartup(database);
        await repairTeamBillingErasureStateAtStartup(database);
      }
      database.__scheduleTimers = new Set();
      database.__activeScheduleOccurrences = new Set();
      database.__scheduleRecoveryTimer = null;
      database.__scheduleRecoveryDueAt = null;
      database.__scheduleRecoveryPromise = null;
      database.__scheduleLegacyDiscoveryTimer = null;
      // Recovery may classify durable state while the candidate is stopped,
      // but it returns the retained wake instead of arming it. Publication is
      // the single boundary that releases both Job and Schedule work.
      const earliestFutureLeaseAt = await recoverExpiredJobLeases(database);
      await recoverPendingScheduleOccurrences(database, { validateOnly: true });
      preflightStaticScheduleTimers(database);
      const reconciled = await reconcileSchedules(database);
      database.__scheduleStopped = false;
      startStaticSchedules(database, reconciled.timerPlans);
      if (!database.__jobActivationDeferred) {
        // Orderly shutdown deliberately retains queued and delayed Jobs. A
        // fresh runtime has no inherited worker/wake timer, so activation
        // releases recovery plus one normal pass to rediscover durable work.
        activateCurrentUserJobExecution(database, earliestFutureLeaseAt);
      }
      await recoverReconciledSchedules(database, reconciled.recoveredOccurrences);
      // A fresh initial runtime publishes here. Dev replacement candidates are
      // deferred and publish only after activation preflight succeeds.
      if (!database.__jobActivationDeferred) await database.__publishAccessKeyScopes();
      database.__runtimeInitialized = true;
    } catch (error) {
      database.__scheduleStopped = true;
      abortSchedulePayloadFactories(database);
      for (const timer of database.__scheduleTimers ?? []) database.clock.clearTimer(timer);
      database.__scheduleTimers?.clear?.();
      database.__scheduleRecoveryTimer = null;
      database.__scheduleRecoveryDueAt = null;
      database.__scheduleLegacyDiscoveryTimer = null;
      const settlements = [stopCurrentUserJobWorker(database), settleActiveScheduleWork(database)]
        .filter(Boolean)
        .map((pending) => Promise.resolve(pending));
      const cleanup = await Promise.allSettled(settlements);
      database.__runtimeInitialized = false;
      const cleanupFailures = cleanup.filter((result) => result.status === "rejected").map((result: any) => result.reason);
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], "Runtime initialization and cleanup both failed.");
      }
      throw error;
    }
  };
  database.shutdown = () => {
    if (database.__shutdownPromise) return database.__shutdownPromise;
    database.__shutdownPromise = (async () => {
      let shutdownError: unknown;
      let mailCloseError: unknown;
      let shutdownRejected = false;
      let mailCloseRejected = false;
      try {
        database.__scheduleStopped = true;
        const workerSettlement = stopCurrentUserJobWorker(database);
        abortSchedulePayloadFactories(database);
        for (const timer of database.__scheduleTimers ?? []) database.clock.clearTimer(timer);
        database.__scheduleTimers?.clear?.();
        database.__scheduleRecoveryTimer = null;
        database.__scheduleRecoveryDueAt = null;
        database.__scheduleLegacyDiscoveryTimer = null;
        if (workerSettlement) await workerSettlement;
        await settleActiveScheduleWork(database);
        if (database.__runtimeInitialized && database.lifecycleHooks.shutdown !== undefined) {
          if (typeof database.lifecycleHooks.shutdown !== "function") throw commandError("Invalid Capsule shutdown hook.", "Declare hooks.shutdown as a function.");
          await database.lifecycleHooks.shutdown(createMutationContext(database, { userId: "__lifecycle__", displayName: "Capsule lifecycle", email: null, picture: null, isAuthenticated: false, isGuest: false, provider: "lifecycle" }, { ordinaryCredential: false }));
        }
      } catch (error) {
        shutdownRejected = true;
        shutdownError = error;
      } finally {
        database.__runtimeInitialized = false;
      }
      try { await database.mail.close(); }
      catch (error) { mailCloseRejected = true; mailCloseError = error; }
      if (shutdownRejected && mailCloseRejected) {
        throw new AggregateError([shutdownError, mailCloseError], "Runtime shutdown and mail closure both failed.");
      }
      if (shutdownRejected) throw shutdownError;
      if (mailCloseRejected) throw mailCloseError;
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
  if (options?.runtimeActionOnly) {
    const retainedScopes = await sqlite.readSystemMetadata("accessKeyScopes");
    try {
      const parsed = retainedScopes ? JSON.parse(retainedScopes.value) : [];
      database.accessKeyScopes = Array.isArray(parsed) && parsed.every((scope) => typeof scope === "string") ? parsed : [];
    } catch { database.accessKeyScopes = []; }
  }
  await sqlite.ensureAuthStorage(database.authConfig);
  // Reconcile the former single `active` OAuth admission key before this
  // runtime can accept a callback. Retirement is deliberately a separate,
  // bounded pass: it removes only keys whose grace and outstanding states have
  // both expired.
  if (database.runRegistrationAdmission) {
    await reconcileOAuthRegistrationKeys(database);
    await retireOAuthRegistrationKeys(database);
  }
  await sqlite.ensureUserPreferencesStorage();
  await sqlite.ensureTeamsStorage();
  if (teamBillingDefinition) await sqlite.ensureTeamBillingStorage();
  await ensureJobStorage(sqlite);
  await ensureScheduleStorage(sqlite, options?.scheduleStorageFault);
  await sqlite.ensureFileStorage();
  await sqlite.ensureLogStorage();
  if (!options?.runtimeActionOnly) {
    const ingressSweep = await sweepExpiredFileIngress(database);
    if (ingressSweep.failures.length > 0) await database.log.emit({ category: "platform", event: "file.ingress.sweep_failed", level: "warn", message: "Multipart ingress cleanup left retryable orphan state", data: { code: ingressSweep.failures[0].code, failures: ingressSweep.failures.length, scanned: ingressSweep.scanned } });
  }
  if (!options?.runtimeActionOnly) {
    await recoverInvalidRetainedJobState(database);
    await recoverExpiredJobLeases(database);
    assertValidReferenceTargets(schema);
    await sqlite.migrateAppSchema(schema);
  }

  return database;
}

function validateStripeEventSubscription(subscription: LooseRecord | undefined) {
  if (subscription === undefined) return;
  const invalid = () => commandError(
    "Invalid Stripe-event declaration.",
    "Use stripeEvent(handler) or stripeEvent({ consequence: \"atomic\" }, handler).",
    "INVALID_STRIPE_EVENT_DECLARATION",
  );
  if (!subscription || typeof subscription !== "object" || Array.isArray(subscription) || subscription.kind !== "stripeEvent" || typeof subscription.handler !== "function") {
    throw invalid();
  }
  const keys = Object.keys(subscription).sort();
  if (subscription.options === undefined) {
    if (keys.length !== 2 || keys[0] !== "handler" || keys[1] !== "kind") throw invalid();
    return;
  }
  const options = subscription.options;
  if (
    keys.length !== 3 || keys[0] !== "handler" || keys[1] !== "kind" || keys[2] !== "options"
    || !options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).length !== 1 || options.consequence !== "atomic"
    || (subscription as any)[atomicStripeEventDefinitionBrand] !== true
    || !Object.isFrozen(subscription) || !Object.isFrozen(options)
  ) throw invalid();
}

function resolveJourneySessionInactivityMinutes(config: RuntimeConfig = {}) {
  const value = config.journey?.sessionInactivityMinutes;
  if (typeof value !== "number" || !Number.isFinite(value)) return 30;
  return Math.min(1_440, Math.max(1, Math.round(value)));
}

async function reconcileSchedules(database: LooseRecord) {
  const now = database.clock.now();
  const declaredNames = new Set(database.schedules.map((definition: any) => definition.name));
  for (let attempt = 0; ; attempt += 1) {
    let candidateArmed = false;
    try {
      return await database.adapter.withTransaction(async (transactionAdapter: LooseRecord) => {
        const sql = transactionAdapter.dialect.sql;
        // Serialize the complete declaration set, including an empty set. Per-row
        // locks cannot make removal and first declaration one publication boundary.
        await transactionAdapter.prepare(sql(
          "UPDATE [sporades] SET [value]=[value] WHERE [key]='schedule-reconciliation-lock'",
        )).run();
        const persisted = await transactionAdapter.prepare(sql("SELECT * FROM [sporades_schedules]")).all();
        for (const row of persisted) {
          if (!scheduleCursorStateIsConsistent(row.enabled, row.exhausted, row.nextOccurrence)
            || (row.nextOccurrence !== null && row.nextOccurrence !== undefined && !isCanonicalJobTimestamp(row.nextOccurrence))) {
            throw commandError(
              "Stored Schedule state is invalid.",
              "Repair or remove the malformed Schedule before restarting the Capsule.",
              "SCHEDULE_STATE_INVALID",
            );
          }
        }
        const legacyLineages = await transactionAdapter.prepare(sql(
          "SELECT [scheduleName], [definitionFingerprint], [adoptionOpen] FROM [sporades_schedule_legacy_adoption]",
        )).all();
        const legacyLineageByName = new Map<string, LooseRecord>(legacyLineages.map((lineage: any) => [String(lineage.scheduleName), lineage]));
        const plans = [];
        for (const definition of database.schedules) {
          const row = persisted.find((candidate: any) => candidate.name === definition.name);
          const changed = !row || row.definitionFingerprint !== definition.fingerprint || Boolean(row.enabled) !== definition.enabled;
          let nextOccurrence: string | null = null;
          let exhausted = false;
          let recoveredOccurrence: Date | null = null;
          if (definition.enabled) {
            const retainedExhaustion = !changed && Number(row?.exhausted) === 1 && row?.nextOccurrence == null;
            if (retainedExhaustion) {
              exhausted = true;
            } else if (changed || row?.nextOccurrence === null || row?.nextOccurrence === undefined) {
              nextOccurrence = nextScheduleOccurrence(definition.fields, now, definition.effectiveTimezone).toISOString();
            } else {
              nextOccurrence = String(row.nextOccurrence);
              if (Date.parse(nextOccurrence) <= now.getTime()) {
                let latest = new Date(nextOccurrence);
                let successor = nextScheduleCursor(definition, latest);
                while (!successor.exhausted && Date.parse(successor.nextOccurrence!) <= now.getTime()) {
                  latest = new Date(successor.nextOccurrence!);
                  successor = nextScheduleCursor(definition, latest);
                }
                if (definition.missedRun === "latest") {
                  recoveredOccurrence = latest;
                  // Keep the final due cursor durable until occurrence
                  // finalization commits its Job/outcome and terminal cursor
                  // together. A process loss after reconciliation can then
                  // recover the same occurrence instead of preserving a
                  // prematurely exhausted Schedule that never created it.
                  if (successor.exhausted) {
                    nextOccurrence = latest.toISOString();
                    exhausted = false;
                  } else {
                    nextOccurrence = successor.nextOccurrence;
                  }
                } else {
                  nextOccurrence = successor.nextOccurrence;
                  exhausted = successor.exhausted;
                }
              }
            }
          }
          plans.push({ definition, row, nextOccurrence, exhausted, recoveredOccurrence, generationToken: randomUUID() });
        }

        // Every declaration, including calendars with no possible future instant,
        // has now been evaluated without mutating durable state.
        for (const row of persisted) {
          if (!declaredNames.has(String(row.name))) {
            await transactionAdapter.prepare(sql(
              "UPDATE [sporades_schedule_legacy_adoption] SET [definitionFingerprint]=?, [adoptionOpen]=0 WHERE [scheduleName]=?",
            )).run(row.definitionFingerprint, row.name);
            await transactionAdapter.prepare(sql(
              "INSERT INTO [sporades_schedule_legacy_adoption] ([scheduleName], [definitionFingerprint], [adoptionOpen]) VALUES (?, ?, 0) ON CONFLICT ([scheduleName]) DO NOTHING",
            )).run(row.name, row.definitionFingerprint);
            await transactionAdapter.prepare(sql("DELETE FROM [sporades_schedules] WHERE [name]=?")).run(row.name);
          }
        }
        const updateScheduleSql = sql(
          "UPDATE [sporades_schedules] SET [definitionFingerprint]=?, [generationToken]=?, [expression]=?, [effectiveTimezone]=?, " +
          "[missedRunPolicy]=?, [enabled]=?, [exhausted]=?, [nextOccurrence]=? WHERE [name]=?",
        );
        for (const { definition, row, nextOccurrence, exhausted, generationToken } of plans) {
          // Every successful runtime publication receives a fresh incarnation. A
          // same-definition restart transfers only its still-pending work; changed,
          // disabled, removed, and later-restored generations never inherit it.
          const sameEnabledDefinition = Boolean(row) && Boolean(row.enabled) && definition.enabled
            && row.definitionFingerprint === definition.fingerprint;
          const legacyLineage = legacyLineageByName.get(definition.name);
          const legacyAdoptionOpen = sameEnabledDefinition
            && Number(legacyLineage?.adoptionOpen) === 1
            && legacyLineage?.definitionFingerprint === definition.fingerprint;
          definition.__adoptLegacyPendingOccurrences = legacyAdoptionOpen;
          if (row) {
            await database.scheduleReconciliationFault?.("before-generation-lock", { scheduleName: definition.name });
            // Lock and rotate the durable Schedule before scanning its pending
            // work. An outgoing claim holds this row until its occurrence insert
            // commits, so the transfer below cannot miss that insert on Postgres.
            await transactionAdapter.prepare(updateScheduleSql).run(definition.fingerprint, generationToken, definition.expression, definition.effectiveTimezone, definition.missedRun, definition.enabled ? 1 : 0, exhausted ? 1 : 0, nextOccurrence, definition.name);
          } else {
            await transactionAdapter.prepare(sql(
              "INSERT INTO [sporades_schedules] ([name], [definitionFingerprint], [generationToken], [expression], [effectiveTimezone], [missedRunPolicy], [enabled], [exhausted], [nextOccurrence]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )).run(definition.name, definition.fingerprint, generationToken, definition.expression, definition.effectiveTimezone, definition.missedRun, definition.enabled ? 1 : 0, exhausted ? 1 : 0, nextOccurrence);
          }
          if (!legacyAdoptionOpen) {
            await transactionAdapter.prepare(sql(
              "UPDATE [sporades_schedule_legacy_adoption] SET [definitionFingerprint]=?, [adoptionOpen]=0 WHERE [scheduleName]=?",
            )).run(definition.fingerprint, definition.name);
            await transactionAdapter.prepare(sql(
              "INSERT INTO [sporades_schedule_legacy_adoption] ([scheduleName], [definitionFingerprint], [adoptionOpen]) VALUES (?, ?, 0) ON CONFLICT ([scheduleName]) DO NOTHING",
            )).run(definition.name, definition.fingerprint);
          }
          if (sameEnabledDefinition) {
            await transactionAdapter.prepare(sql(
              "UPDATE [sporades_schedule_occurrences] SET [definitionFingerprint]=?, [generationToken]=? WHERE [scheduleName]=? AND [status]='pending' AND [definitionFingerprint]=? AND ([generationToken]=? OR ([generationToken] IS NULL AND ? IS NULL))",
            )).run(definition.fingerprint, generationToken, definition.name, definition.fingerprint, row.generationToken ?? null, row.generationToken ?? null);
          }
          if (legacyAdoptionOpen) {
            await transactionAdapter.prepare(sql(
              "UPDATE [sporades_schedule_occurrences] SET [definitionFingerprint]=?, [generationToken]=? WHERE [scheduleName]=? AND [status]='pending' AND [definitionFingerprint] IS NULL AND [generationToken] IS NULL",
            )).run(definition.fingerprint, generationToken, definition.name);
          }
          definition.nextOccurrence = nextOccurrence;
          definition.exhausted = exhausted;
          definition.generationToken = generationToken;
        }
        candidateArmed = true;
        return {
          recoveredOccurrences: plans.filter(({ recoveredOccurrence }) => recoveredOccurrence).map(({ definition, recoveredOccurrence }) => ({ definition, recoveredOccurrence })),
          timerPlans: plans.filter(({ definition, nextOccurrence, exhausted }) => definition.enabled && !exhausted && nextOccurrence !== null).map(({ definition }) => ({ definition })),
        };
      });
    } catch (error: any) {
      // node:sqlite operations are synchronous. A busy timeout would block the
      // event loop and prevent the owning candidate from reaching COMMIT, so
      // overlapping candidates yield and retry the not-yet-published attempt.
      if (candidateArmed || database.adapter.engine !== "sqlite" || attempt >= 100 || !String(error?.message ?? "").includes("database is locked")) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, attempt + 1)));
    }
  }
}

async function recoverReconciledSchedules(database: LooseRecord, recoveredOccurrences: LooseRecord[]) {
  try {
    for (const { definition, recoveredOccurrence } of recoveredOccurrences) {
      await recordScheduledOccurrence(database, definition, recoveredOccurrence);
    }
    await recoverPendingScheduleOccurrences(database);
  } catch (error: any) {
    try {
      await database.log.emit({ category: "platform", event: "schedule.occurrence.recovery_failed", level: "error", message: "Pending Scheduled occurrence recovery failed", data: { code: String(error?.code ?? "SCHEDULE_RECOVERY_FAILED").slice(0, 80) } });
    } catch {}
    if (!database.__scheduleStopped) schedulePendingOccurrenceRecovery(database, new Date(database.clock.now().getTime() + SCHEDULE_RECOVERY_RETRY_MS).toISOString());
  }
}

const MAX_NATIVE_TIMER_DELAY_MS = 2_147_483_647;
const SCHEDULE_RECOVERY_RETRY_MS = 1_000;
const LEGACY_SCHEDULE_DISCOVERY_INTERVAL_MS = 1_000;
const LEGACY_SCHEDULE_DISCOVERY_LIMIT = 100;

function settleActiveScheduleWork(database: LooseRecord) {
  const active = new Set<any>(database.__activeScheduleOccurrences ?? []);
  if (database.__scheduleRecoveryPromise) active.add(database.__scheduleRecoveryPromise);
  if (active.size === 0) return undefined;
  return Promise.allSettled([...active]).then(() => undefined);
}

function preflightStaticScheduleTimers(database: LooseRecord) {
  for (const definition of database.schedules) {
    if (!definition.enabled) continue;
    const timer = database.clock.setTimer(() => {}, MAX_NATIVE_TIMER_DELAY_MS);
    database.clock.clearTimer(timer);
  }
}

function startStaticSchedules(database: LooseRecord, timerPlans: LooseRecord[]) {
  database.__scheduleTimers ??= new Set();
  database.__activeScheduleOccurrences ??= new Set();
  for (const { definition } of timerPlans) {
    const arm = () => {
      if (database.__scheduleStopped || !definition.enabled || definition.exhausted || definition.nextOccurrence == null) return;
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
        const active = recordScheduledOccurrence(database, definition, occurrence).catch(async (error: any) => {
          database.log.emit({ category: "platform", event: "schedule.occurrence.enqueue_failed", level: "error", message: "Scheduled occurrence could not enqueue its Job", data: { scheduleName: definition.name, scheduledFor: occurrence.toISOString(), code: String(error?.code ?? "SCHEDULE_ENQUEUE_FAILED").slice(0, 80) } });
        }).finally(() => {
          database.__activeScheduleOccurrences.delete(active);
          if (database.__scheduleStopped) return;
          arm();
        });
        database.__activeScheduleOccurrences.add(active);
        return active;
      }, Math.min(MAX_NATIVE_TIMER_DELAY_MS, Math.max(0, occurrence.getTime()-database.clock.now().getTime())));
      database.__scheduleTimers.add(timer);
    };
    arm();
  }
  scheduleLateLegacyOccurrenceDiscovery(database);
}

async function recordScheduledOccurrence(database: LooseRecord, definition: any, occurrence: Date) {
  const claim = await claimScheduledOccurrence(database, definition, occurrence);
  if (!claim) {
    // Another runtime owns this exact occurrence. Advance only this runtime's
    // timer cursor; the winner owns durable Schedule bookkeeping.
    const successor = nextScheduleCursor(definition, occurrence);
    definition.nextOccurrence = successor.nextOccurrence;
    definition.exhausted = successor.exhausted;
    return null;
  }
  let transactionContext: LooseRecord | undefined;
  try {
    const scheduledFor = occurrence.toISOString();
    await database.scheduleOccurrenceFault?.("after-pending", { scheduleName: definition.name, scheduledFor });
    // Payload code is deliberately outside the ownership transaction: it can
    // take up to the configured five-minute bound and may be evaluated again
    // after lease recovery. Only its durable effects require live ownership.
    const payloadContext = createScheduleMutationContext(database, definition, scheduledFor);
    const payload = await resolveSchedulePayload(database, definition, scheduledFor, payloadContext);
    const committed = await database.adapter.withTransaction(async (transactionAdapter: any) => {
      const transactionDatabase = createTransactionDatabase(database, transactionAdapter);
      const sql = transactionAdapter.dialect.sql;
      // Lock and revalidate the current Schedule generation before any durable
      // Job side effect or occurrence-row lock. Reconciliation takes the same
      // Schedule-then-occurrence order, avoiding a PostgreSQL lock inversion.
      const generation = await transactionAdapter.prepare(sql(
        "UPDATE [sporades_schedules] SET [name]=[name] WHERE [name]=? AND [enabled]=1 AND [definitionFingerprint]=? AND [generationToken]=?",
      )).run(definition.name, definition.fingerprint, definition.generationToken);
      if (Number(generation.changes) !== 1) {
        const completedAt = database.clock.now().toISOString();
        await transactionAdapter.prepare(sql(
          "UPDATE [sporades_schedule_occurrences] SET [status]='enqueue-failed', [claimToken]=NULL, [claimExpiresAt]=NULL, [jobId]=NULL, [errorCode]='SCHEDULE_OCCURRENCE_SUPERSEDED', [updatedAt]=? WHERE [id]=? AND [status]='pending' AND [claimToken]=? AND [definitionFingerprint]=? AND [generationToken]=?",
        )).run(completedAt, claim.id, claim.token, definition.fingerprint, definition.generationToken);
        return { owned: true, state: null, next: null, superseded: true };
      }
      await database.scheduleOccurrenceFault?.("after-finalization-generation-lock", { scheduleName: definition.name, scheduledFor });
      const ownership = await transactionAdapter.prepare(sql(
        "UPDATE [sporades_schedule_occurrences] SET [updatedAt]=[updatedAt] WHERE [id]=? AND [status]='pending' AND [claimToken]=? AND [definitionFingerprint]=? AND [generationToken]=?",
      )).run(claim.id, claim.token, definition.fingerprint, definition.generationToken);
      if (Number(ownership.changes) !== 1) return { owned: false, state: null, next: null };
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
        const terminal = await transactionAdapter.prepare(sql(
          "UPDATE [sporades_schedule_occurrences] SET [status]=?, [claimToken]=NULL, [claimExpiresAt]=NULL, [jobId]=?, [errorCode]=?, [updatedAt]=? WHERE [id]=? AND [status]='pending' AND [claimToken]=? AND [definitionFingerprint]=? AND [generationToken]=?",
        )).run(outcome, state?.id ?? null, errorCode, completedAt, claim.id, claim.token, definition.fingerprint, definition.generationToken);
        if (Number(terminal.changes) !== 1) throw new Error("Schedule occurrence ownership changed during its owned transaction.");
        const successor = nextScheduleCursor(definition, occurrence);
        const summary = await transactionAdapter.prepare(sql(
          "UPDATE [sporades_schedules] SET [nextOccurrence]=?, [exhausted]=?, [latestScheduledFor]=?, [latestOutcome]=?, [latestJobId]=?, [latestErrorCode]=? WHERE [name]=? AND [enabled]=1 AND [definitionFingerprint]=? AND [generationToken]=?",
        )).run(successor.nextOccurrence, successor.exhausted ? 1 : 0, scheduledFor, outcome, state?.id ?? null, errorCode, definition.name, definition.fingerprint, definition.generationToken);
        if (Number(summary.changes) !== 1) throw new Error("Schedule definition changed during occurrence finalization.");
        return { owned: true, state, ...successor };
      } catch (error) {
        handlerFailed = true;
        throw error;
      } finally {
        await cleanupTransactionHandler(transactionDatabase, transactionContext, handlerFailed);
      }
    });
    if (!committed.owned) {
      dropPendingJobDispatch(transactionContext);
      return null;
    }
    if (committed.superseded) definition.enabled = false;
    else {
      definition.nextOccurrence = committed.nextOccurrence;
      definition.exhausted = committed.exhausted;
    }
    await dispatchPendingJobs(transactionContext);
    return committed.state;
  } catch (error) {
    dropPendingJobDispatch(transactionContext);
    if (!database.__scheduleStopped) {
      const failed = await database.adapter.withTransaction((transactionAdapter: any) => finishFailedScheduledOccurrence(
        { ...database, adapter: transactionAdapter }, definition, occurrence, error, claim.token,
      ));
      if (failed.superseded) definition.enabled = false;
      else if (failed.finished) {
        definition.nextOccurrence = failed.nextOccurrence;
        definition.exhausted = failed.exhausted;
      }
    }
    throw error;
  }
}

async function claimScheduledOccurrence(database: LooseRecord, definition: any, occurrence: Date) {
  const scheduledFor = occurrence.toISOString();
  const id = scheduledOccurrenceIdentity(database, definition.name, scheduledFor);
  const token = randomUUID();
  const now = database.clock.now();
  const nowIso = now.toISOString();
  // The final occurrence can fire late enough that a full claim lease no
  // longer fits. Keep the claim canonical and bounded by the end of the
  // runtime domain; transaction ownership still prevents a stale claimant
  // from finalizing after an overlapping runtime takes the expired claim.
  const fullLeaseExpiresAt = jobTimestampAfter(now, RUNTIME_CLAIM_LEASE_MS);
  const expiresAt = fullLeaseExpiresAt ?? (isCanonicalJobTimestamp(nowIso)
    ? new Date(MAX_JOB_TIMESTAMP_MS).toISOString()
    : null);
  if (expiresAt === null) {
    throw commandError("Schedule occurrence claim exceeds the runtime timestamp domain.", "Run the Schedule before the end of the supported four-digit UTC timestamp range.", "SCHEDULE_TIME_DOMAIN_EXHAUSTED");
  }
  let recoveryAt: string | null = null;
  const claimed = await database.adapter.withTransaction(async (transactionAdapter: any) => {
    const sql = transactionAdapter.dialect.sql;
    // The durable enabled Schedule row, not this runtime's captured declaration,
    // owns the generation. Lock it before touching the occurrence so an outgoing
    // runtime can only stop itself after a replacement has reconciled the name.
    const generation = await transactionAdapter.prepare(sql(
      "UPDATE [sporades_schedules] SET [name]=[name] WHERE [name]=? AND [enabled]=1 AND [definitionFingerprint]=? AND [generationToken]=?",
    )).run(definition.name, definition.fingerprint, definition.generationToken);
    if (Number(generation.changes) !== 1) return { claim: null, superseded: true };
    await database.scheduleOccurrenceFault?.("after-generation-lock", { scheduleName: definition.name, scheduledFor });

    const inserted = await transactionAdapter.prepare(sql(
      "INSERT INTO [sporades_schedule_occurrences] ([id], [scheduleName], [definitionFingerprint], [generationToken], [scheduledFor], [status], [claimToken], [claimExpiresAt], [createdAt], [updatedAt]) " +
      "VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    )).run(id, definition.name, definition.fingerprint, definition.generationToken, scheduledFor, token, expiresAt, nowIso, nowIso);
    if (Number(inserted.changes) === 1) return { claim: { id, token }, superseded: false };

    let existing = await transactionAdapter.prepare(sql("SELECT [id], [status], [scheduleName], [definitionFingerprint], [generationToken], [scheduledFor], [claimToken], [claimExpiresAt], [errorCode] FROM [sporades_schedule_occurrences] WHERE [id]=?")).get(id);
    if (!existing) {
      // A retained row with a forged id can still occupy the unique
      // (scheduleName, scheduledFor) key. Treat that row as the failed claim
      // target instead of turning a recoverable retained-state defect into a
      // startup or timer-loop failure.
      existing = await transactionAdapter.prepare(sql("SELECT [id], [status], [scheduleName], [definitionFingerprint], [generationToken], [scheduledFor], [claimToken], [claimExpiresAt], [errorCode] FROM [sporades_schedule_occurrences] WHERE [scheduleName]=? AND [scheduledFor]=?")).get(definition.name, scheduledFor);
      if (!existing) throw new Error("Schedule occurrence conflict could not be resolved.");
    }
    if (!validRetainedScheduleOccurrenceIdentity(database, existing)
      || String(existing.scheduleName) !== definition.name
      || String(existing.scheduledFor) !== scheduledFor
      || (existing.claimExpiresAt !== null && !isCanonicalJobTimestamp(existing.claimExpiresAt))) {
      const invalid = await finishInvalidRetainedScheduleOccurrence(database, existing, transactionAdapter);
      recoveryAt = earliestScheduleRecoveryAt(recoveryAt, invalid.recoveryAt);
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
      const adopted = await transactionAdapter.prepare(sql(
        "UPDATE [sporades_schedule_occurrences] SET [definitionFingerprint]=?, [generationToken]=?, [updatedAt]=? WHERE [id]=? AND [scheduleName]=? AND [scheduledFor]=? AND [status]='pending' AND [definitionFingerprint] IS NULL AND [generationToken] IS NULL",
      )).run(definition.fingerprint, definition.generationToken, nowIso, existing.id, definition.name, scheduledFor);
      if (Number(adopted.changes) === 1) {
        existing = { ...existing, definitionFingerprint: definition.fingerprint, generationToken: definition.generationToken, updatedAt: nowIso };
      } else {
        existing = await transactionAdapter.prepare(sql("SELECT [id], [status], [scheduleName], [definitionFingerprint], [generationToken], [scheduledFor], [claimToken], [claimExpiresAt], [errorCode] FROM [sporades_schedule_occurrences] WHERE [id]=?")).get(existing.id);
        if (!existing) return { claim: null, superseded: false };
      }
    }
    if (existing.definitionFingerprint !== definition.fingerprint || existing.generationToken !== definition.generationToken) {
      // This occurrence was created before the live generation reconciled. It
      // belongs to the replaced definition and must not be reinterpreted under
      // the new payload or cadence. The durable generation lock above ensures a
      // stale caller can never apply this transition to replacement-owned work.
      if (existing.status === "pending") {
        const superseded = await finishSupersededRetainedScheduleOccurrence(database, existing, transactionAdapter);
        recoveryAt = earliestScheduleRecoveryAt(recoveryAt, superseded.recoveryAt);
      }
      return { claim: null, superseded: false };
    }
    if (existing.status !== "pending") return { claim: null, superseded: false };
    if (existing.claimExpiresAt && existing.claimExpiresAt > nowIso) {
      recoveryAt = existing.claimExpiresAt;
      return { claim: null, superseded: false };
    }
    const result = await transactionAdapter.prepare(sql("UPDATE [sporades_schedule_occurrences] SET [claimToken]=?, [claimExpiresAt]=?, [updatedAt]=? WHERE [id]=? AND [status]='pending' AND [definitionFingerprint]=? AND [generationToken]=? AND ([claimExpiresAt] IS NULL OR [claimExpiresAt] <= ?)")).run(token, expiresAt, nowIso, id, definition.fingerprint, definition.generationToken, nowIso);
    return { claim: Number(result.changes) === 1 ? { id, token } : null, superseded: false };
  });
  if (claimed.superseded) definition.enabled = false;
  armRetainedScheduleRecoveryAfterCommit(database, recoveryAt);
  return claimed.claim;
}

async function recoverPendingScheduleOccurrences(database: LooseRecord, options: { validateOnly?: boolean } = {}) {
  const sql = database.adapter.dialect.sql;
  const rows = await database.adapter.prepare(sql("SELECT [id], [scheduleName], [definitionFingerprint], [generationToken], [scheduledFor], [claimToken], [claimExpiresAt] FROM [sporades_schedule_occurrences] WHERE [status]='pending' ORDER BY [scheduledFor] ASC, [scheduleName] ASC")).all();
  const nowMs = database.clock.now().getTime();
  let earliestFutureClaimAt: number | null = null;
  for (const row of rows) {
    if (!validRetainedScheduleOccurrenceIdentity(database, row)
      || (row.claimExpiresAt !== null && !isCanonicalJobTimestamp(row.claimExpiresAt))) {
      if (!options.validateOnly) await finishInvalidRetainedScheduleOccurrence(database, row);
      continue;
    }
    const durable = await database.adapter.prepare(sql(
      "SELECT [definitionFingerprint], [generationToken], [enabled] FROM [sporades_schedules] WHERE [name]=?",
    )).get(row.scheduleName);
    if (options.validateOnly) continue;
    const definition = database.schedules.find((candidate: any) => candidate.enabled && candidate.name === row.scheduleName);
    if (!durable || !Boolean(durable.enabled)) {
      await finishSupersededRetainedScheduleOccurrence(database, row);
      continue;
    }
    if (!definition || definition.fingerprint !== durable.definitionFingerprint || definition.generationToken !== durable.generationToken) {
      if (definition) definition.enabled = false;
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
  if (earliestFutureClaimAt !== null) schedulePendingOccurrenceRecovery(database, new Date(earliestFutureClaimAt).toISOString());
}

async function recoverLateLegacyScheduleOccurrences(database: LooseRecord) {
  const sql = database.adapter.dialect.sql;
  const rows = await database.adapter.prepare(sql(
    "SELECT [id], [scheduleName], [definitionFingerprint], [generationToken], [scheduledFor], [claimToken], [claimExpiresAt] " +
    "FROM [sporades_schedule_occurrences] WHERE [status]='pending' AND [definitionFingerprint] IS NULL AND [generationToken] IS NULL " +
    "ORDER BY [scheduledFor] ASC, [scheduleName] ASC LIMIT ?",
  )).all(LEGACY_SCHEDULE_DISCOVERY_LIMIT);
  for (const row of rows) {
    if (!validRetainedScheduleOccurrenceIdentity(database, row)
      || (row.claimExpiresAt !== null && !isCanonicalJobTimestamp(row.claimExpiresAt))) {
      await finishInvalidRetainedScheduleOccurrence(database, row);
      continue;
    }
    const durable = await database.adapter.prepare(sql(
      "SELECT [definitionFingerprint], [generationToken], [enabled] FROM [sporades_schedules] WHERE [name]=?",
    )).get(row.scheduleName);
    const definition = database.schedules.find((candidate: any) => candidate.enabled && candidate.name === row.scheduleName);
    if (!durable || !Boolean(durable.enabled)) {
      await finishSupersededRetainedScheduleOccurrence(database, row);
      continue;
    }
    if (!definition || definition.fingerprint !== durable.definitionFingerprint || definition.generationToken !== durable.generationToken) {
      if (definition) definition.enabled = false;
      continue;
    }
    await recordScheduledOccurrence(database, definition, new Date(row.scheduledFor));
  }
}

function scheduleLateLegacyOccurrenceDiscovery(database: LooseRecord) {
  if (database.__scheduleStopped || database.__scheduleLegacyDiscoveryTimer) return;
  if (!database.schedules.some((definition: any) => definition.enabled && definition.__adoptLegacyPendingOccurrences === true)) return;
  const timer = database.clock.setTimer(() => {
    database.__scheduleTimers?.delete(timer);
    database.__scheduleLegacyDiscoveryTimer = null;
    if (database.__scheduleStopped) return;
    const active = recoverLateLegacyScheduleOccurrences(database).catch((error: any) => {
      database.log.emit({ category: "platform", event: "schedule.legacy_occurrence.discovery_failed", level: "error", message: "Late legacy Scheduled occurrence discovery failed", data: { code: String(error?.code ?? "SCHEDULE_LEGACY_DISCOVERY_FAILED").slice(0, 80) } });
    }).finally(() => {
      database.__activeScheduleOccurrences?.delete(active);
      if (!database.__scheduleStopped) scheduleLateLegacyOccurrenceDiscovery(database);
    });
    database.__activeScheduleOccurrences?.add(active);
    return active;
  }, LEGACY_SCHEDULE_DISCOVERY_INTERVAL_MS);
  database.__scheduleLegacyDiscoveryTimer = timer;
  database.__scheduleTimers?.add(timer);
}

function validRetainedScheduleOccurrenceIdentity(database: LooseRecord, row: LooseRecord) {
  return typeof row.id === "string" && row.id.length > 0
    && typeof row.scheduleName === "string" && row.scheduleName.length > 0
    && isCanonicalJobTimestamp(row.scheduledFor)
    && row.id === scheduledOccurrenceIdentity(database, row.scheduleName, row.scheduledFor);
}

async function finishInvalidRetainedScheduleOccurrence(database: LooseRecord, row: LooseRecord, adapter?: LooseRecord) {
  if (adapter) return finishRetainedScheduleOccurrence(database, row, "SCHEDULE_OCCURRENCE_INVALID", adapter);
  const result = await database.adapter.withTransaction((transactionAdapter: LooseRecord) =>
    finishRetainedScheduleOccurrence(database, row, "SCHEDULE_OCCURRENCE_INVALID", transactionAdapter));
  armRetainedScheduleRecoveryAfterCommit(database, result.recoveryAt);
  return result;
}

async function finishSupersededRetainedScheduleOccurrence(database: LooseRecord, row: LooseRecord, adapter?: LooseRecord) {
  if (adapter) return finishRetainedScheduleOccurrence(database, row, "SCHEDULE_OCCURRENCE_SUPERSEDED", adapter);
  const result = await database.adapter.withTransaction((transactionAdapter: LooseRecord) =>
    finishRetainedScheduleOccurrence(database, row, "SCHEDULE_OCCURRENCE_SUPERSEDED", transactionAdapter));
  armRetainedScheduleRecoveryAfterCommit(database, result.recoveryAt);
  return result;
}

function earliestScheduleRecoveryAt(current: string | null, candidate: string | null) {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

function armRetainedScheduleRecoveryAfterCommit(database: LooseRecord, recoveryAt: string | null) {
  if (recoveryAt !== null) schedulePendingOccurrenceRecovery(database, recoveryAt);
}

async function finishRetainedScheduleOccurrence(database: LooseRecord, row: LooseRecord, errorCode: string, adapter: LooseRecord) {
  const sql = adapter.dialect.sql;
  if (typeof row.scheduleName === "string") {
    await adapter.prepare(sql(
      "UPDATE [sporades_schedules] SET [name]=[name] WHERE [name]=?",
    )).run(row.scheduleName);
  }
  const completedAt = database.clock.now().toISOString();
  const definitionFingerprint = row.definitionFingerprint ?? null;
  const generationToken = row.generationToken ?? null;
  const liveGenerationGuard = errorCode === "SCHEDULE_OCCURRENCE_SUPERSEDED"
    ? " AND NOT EXISTS (SELECT 1 FROM [sporades_schedules] WHERE [name]=? AND [enabled]=1 AND ([generationToken]=? OR ([generationToken] IS NULL AND ? IS NULL)))"
    : "";
  const liveGenerationParams = errorCode === "SCHEDULE_OCCURRENCE_SUPERSEDED"
    ? [row.scheduleName, generationToken, generationToken]
    : [];
  const result = await adapter.prepare(sql(
    "UPDATE [sporades_schedule_occurrences] SET [status]='enqueue-failed', [claimToken]=NULL, [claimExpiresAt]=NULL, [jobId]=NULL, [errorCode]=?, [updatedAt]=? " +
    "WHERE [id]=? AND [status]='pending' AND [scheduledFor]=? " +
    "AND ([definitionFingerprint]=? OR ([definitionFingerprint] IS NULL AND ? IS NULL)) " +
    "AND ([generationToken]=? OR ([generationToken] IS NULL AND ? IS NULL)) " +
    "AND ([claimToken]=? OR ([claimToken] IS NULL AND ? IS NULL)) " +
    "AND ([claimExpiresAt]=? OR ([claimExpiresAt] IS NULL AND ? IS NULL))" + liveGenerationGuard,
  )).run(errorCode, completedAt, row.id, row.scheduledFor, definitionFingerprint, definitionFingerprint, generationToken, generationToken, row.claimToken, row.claimToken, row.claimExpiresAt, row.claimExpiresAt, ...liveGenerationParams);
  if (Number(result.changes) === 1) return { finished: true, recoveryAt: null };
  const current = await adapter.prepare(sql(
    "SELECT [status], [claimExpiresAt] FROM [sporades_schedule_occurrences] WHERE [id]=?",
  )).get(row.id);
  if (current?.status === "pending") {
    const nowMs = database.clock.now().getTime();
    const retainedExpiry = isCanonicalJobTimestamp(current.claimExpiresAt) ? Date.parse(current.claimExpiresAt) : Number.NaN;
    const retryAt = Number.isFinite(retainedExpiry) && retainedExpiry > nowMs
      ? current.claimExpiresAt
      : new Date(nowMs + SCHEDULE_RECOVERY_RETRY_MS).toISOString();
    return { finished: false, recoveryAt: retryAt };
  }
  return { finished: false, recoveryAt: null };
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
    if (dueAt > database.clock.now().getTime()) {
      schedulePendingOccurrenceRecovery(database, claimExpiresAt);
      return;
    }
    const active = recoverPendingScheduleOccurrences(database).catch((error: any) => {
      database.log.emit({ category: "platform", event: "schedule.occurrence.recovery_failed", level: "error", message: "Pending Scheduled occurrence recovery failed", data: { code: String(error?.code ?? "SCHEDULE_RECOVERY_FAILED").slice(0, 80) } });
      if (!database.__scheduleStopped) {
        schedulePendingOccurrenceRecovery(database, new Date(database.clock.now().getTime() + SCHEDULE_RECOVERY_RETRY_MS).toISOString());
      }
    }).finally(() => {
      database.__activeScheduleOccurrences?.delete(active);
      if (database.__scheduleRecoveryPromise === active) database.__scheduleRecoveryPromise = null;
    });
    database.__scheduleRecoveryPromise = active;
    database.__activeScheduleOccurrences?.add(active);
    return active;
  }, Math.min(MAX_NATIVE_TIMER_DELAY_MS, Math.max(0, dueAt - database.clock.now().getTime())));
  database.__scheduleRecoveryTimer = timer;
  database.__scheduleTimers?.add(timer);
}

export async function enqueueScheduledOccurrence(database: LooseRecord, definition: any, occurrence: Date) {
  const scheduledFor = occurrence.toISOString();
  const context = createScheduleMutationContext(database, definition, scheduledFor);
  const payload = await resolveSchedulePayload(database, definition, scheduledFor, context);
  if (!payload.ok) return null;
  return enqueueResolvedScheduledOccurrence(database, definition, scheduledFor, payload.value, context);
}

function createScheduleMutationContext(database: LooseRecord, definition: any, scheduledFor: string) {
  const provenance = `schedule:${scheduledOccurrenceIdentity(database, definition.name, scheduledFor)}`;
  return createMutationContext(database, { userId: provenance, displayName: "Schedule", email: null, picture: null, isAuthenticated: false, isGuest: false, provider: "schedule" }, { ordinaryCredential: false });
}

async function enqueueResolvedScheduledOccurrence(database: LooseRecord, definition: any, scheduledFor: string, payload: any, context: LooseRecord) {
  const provenance = `schedule:${scheduledOccurrenceIdentity(database, definition.name, scheduledFor)}`;
  database.jobScheduleProvenanceByContext.set(context, { scheduleName: definition.name, scheduledFor });
  const state = await context.privileged.run({ operation: "schedules.enqueue", targetResourceKind: "job-queue", metadata: { scheduleName: definition.name, scheduledFor } },
    (privilegedContext: any) => privilegedContext.jobs.enqueue(definition.job, payload, { retry: definition.retry, idempotencyKey: provenance }));
  return state;
}

/** Internal runtime/test seam; not exported from sporades/server. */
export async function recoverExpiredJobLeases(database: LooseRecord) {
  const recoveredAt = database.clock.now(); const recoveredIso = recoveredAt.toISOString();
  const sql = database.adapter.dialect.sql;
  const rows = await database.adapter.prepare(sql("SELECT * FROM [sporades_jobs] WHERE [status]='running' ORDER BY [availableAt] ASC, [id] ASC")).all();
  let earliestFutureLeaseAt: number | null = null;
  for (const row of rows) {
    if (jobClaimTokenIsMalformed(row.claimToken)) {
      const failure = { code: "JOB_CLAIM_INVALID", message: "The stored Job claim ownership is invalid." };
      const ownership = jobClaimOwnership(row.claimToken);
      const leasePredicate = row.leaseExpiresAt === null
        ? "[leaseExpiresAt] IS NULL"
        : "[leaseExpiresAt] = ?";
      const leaseParams = row.leaseExpiresAt === null ? [] : [row.leaseExpiresAt];
      await database.adapter.prepare(sql(
        "UPDATE [sporades_jobs] SET [status]='failed', [failure]=?, [failedAt]=?, [leaseExpiresAt]=NULL, [claimToken]=NULL " +
        "WHERE [id]=? AND [status]='running' AND " + leasePredicate + " AND " + ownership.predicate,
      )).run(JSON.stringify(failure), recoveredIso, row.id, ...leaseParams, ...ownership.params);
      continue;
    }
    if (!isCanonicalJobTimestamp(row.leaseExpiresAt)) {
      const failure = { code: "JOB_LEASE_INVALID", message: "The stored Job claim lease is invalid." };
      const ownership = jobClaimOwnership(row.claimToken);
      const leasePredicate = row.leaseExpiresAt === null
        ? "[leaseExpiresAt] IS NULL"
        : "[leaseExpiresAt] = ?";
      const leaseParams = row.leaseExpiresAt === null ? [] : [row.leaseExpiresAt];
      await database.adapter.prepare(sql(
        "UPDATE [sporades_jobs] SET [status]='failed', [failure]=?, [failedAt]=?, [leaseExpiresAt]=NULL, [claimToken]=NULL " +
        "WHERE [id]=? AND [status]='running' AND " + leasePredicate + " AND " + ownership.predicate,
      )).run(JSON.stringify(failure), recoveredIso, row.id, ...leaseParams, ...ownership.params);
      continue;
    }
    const provenanceFailure = invalidStoredJobFailure(row, recoveredAt);
    if (["JOB_ACTOR_SNAPSHOT_INVALID", "JOB_CREDENTIAL_INVALID"].includes(provenanceFailure?.code)) {
      const ownership = jobClaimOwnership(row.claimToken);
      await database.adapter.prepare(sql(
        "UPDATE [sporades_jobs] SET [status]='failed', [failure]=?, [failedAt]=?, [leaseExpiresAt]=NULL, [claimToken]=NULL " +
        "WHERE [id]=? AND [status]='running' AND [leaseExpiresAt] = ? AND " + ownership.predicate,
      )).run(JSON.stringify(provenanceFailure), recoveredIso, row.id, row.leaseExpiresAt, ...ownership.params);
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
      await database.adapter.prepare(sql(
        "UPDATE [sporades_jobs] SET [status]='delayed', [availableAt]=?, [leaseExpiresAt]=NULL, [claimToken]=NULL, [attemptHistory]=? " +
        "WHERE [id]=? AND [status]='running' AND [leaseExpiresAt] = ? AND " + ownership.predicate,
      )).run(retryAvailableAt, JSON.stringify(history), row.id, row.leaseExpiresAt, ...ownership.params);
    } else {
      const failure = storedFailure ?? (retry === null || retryEligible
        ? invalidJobRetryPolicyFailure()
        : { code: "JOB_LEASE_EXPIRED", message: "Job lease expired." });
      const teamBillingReplacementScheduled = await database.adapter.withTransaction(async (transaction: LooseRecord) => {
        let replacementScheduled = false;
        const settled = await transaction.prepare(transaction.dialect.sql(
          "UPDATE [sporades_jobs] SET [status]='failed', [failure]=?, [failedAt]=?, [leaseExpiresAt]=NULL, [claimToken]=NULL, [attemptHistory]=? " +
          "WHERE [id]=? AND [status]='running' AND [leaseExpiresAt] = ? AND " + ownership.predicate,
        )).run(JSON.stringify(failure), recoveredIso, JSON.stringify(history), row.id, row.leaseExpiresAt, ...ownership.params);
        if (Number(settled?.changes ?? 0) === 1) {
          await settleExhaustedTeamBillingCheckoutJob(transaction, row.handler, row.payload, recoveredIso);
          if ([TEAM_BILLING_PLAN_TRANSITION_JOB, TEAM_BILLING_SEAT_CONVERGENCE_JOB].includes(row.handler)) {
            let payload: any = null;
            try { payload = JSON.parse(row.payload); } catch {}
            const managementSettlement = await settleExhaustedTeamBillingManagementJob(
              { ...database, adapter: transaction, __transactionActive: true }, payload, "JOB_LEASE_EXPIRED",
            );
            replacementScheduled = managementSettlement?.replacementScheduled === true;
          }
          if (row.handler === TEAM_BILLING_ERASURE_JOB) {
            let payload: any = null;
            try { payload = JSON.parse(row.payload); } catch {}
            const erasureSettlement = await settleExhaustedTeamBillingErasureJob(
              { ...database, adapter: transaction, __transactionActive: true }, payload, "JOB_LEASE_EXPIRED",
            );
            replacementScheduled = erasureSettlement?.replacementScheduled === true;
          }
        }
        return replacementScheduled;
      });
      if (teamBillingReplacementScheduled && !database.__jobStopped) scheduleCurrentUserJobWorker(database);
    }
  }
  return earliestFutureLeaseAt;
}

function activateCurrentUserJobExecution(database: LooseRecord, recoveryAt: number | null) {
  database.__jobStopped = false;
  const failures: unknown[] = [];
  try { scheduleJobLeaseRecoveryAt(database, recoveryAt); }
  catch (error) { failures.push(error); }
  try { scheduleCurrentUserJobWorker(database, true); }
  catch (error) { failures.push(error); }
  try { startStripeEventPayloadCleanup(database); }
  catch (error) { failures.push(error); }
  if (failures.length > 1) throw new AggregateError(failures, "Job activation scheduling failed.");
  if (failures.length === 1) throw failures[0];
}

function preflightCurrentUserJobExecution(database: LooseRecord) {
  const timer = database.clock.setTimer(() => {}, MAX_NATIVE_TIMER_DELAY_MS);
  database.clock.clearTimer(timer);
}

function scheduleJobLeaseRecoveryAt(database: LooseRecord, dueAt: number | null) {
  if (database.__jobStopped) return;
  // A scan owns the recovery chain until it has installed its next wake. Any
  // request that arrives meanwhile belongs after that scan, so retain the
  // earliest requested instant instead of starting a competing callback whose
  // stale result could replace newer handoff state.
  if (database.__jobLeaseRecoveryPromise) {
    if (dueAt !== null) {
      database.__jobLeaseRecoveryRequestedAt = database.__jobLeaseRecoveryRequestedAt === null
        ? dueAt
        : Math.min(database.__jobLeaseRecoveryRequestedAt, dueAt);
    }
    return;
  }
  if (dueAt !== null && database.__jobLeaseRecoveryTimer && database.__jobLeaseRecoveryDueAt !== null && database.__jobLeaseRecoveryDueAt <= dueAt) return;
  scheduleJobLeaseRecoveryTimer(database, dueAt);
}

function startJobLeaseRecovery(database: LooseRecord) {
  if (database.__jobStopped) return undefined;
  if (database.__jobLeaseRecoveryPromise) {
    const now = database.clock.now().getTime();
    database.__jobLeaseRecoveryRequestedAt = database.__jobLeaseRecoveryRequestedAt === null
      ? now
      : Math.min(database.__jobLeaseRecoveryRequestedAt, now);
    return database.__jobLeaseRecoveryPromise;
  }
  const recovery = runJobLeaseRecoveryChain(database);
  database.__jobLeaseRecoveryPromise = recovery;
  recovery.finally(() => {
    if (database.__jobLeaseRecoveryPromise === recovery) database.__jobLeaseRecoveryPromise = null;
  }).catch(() => {});
  return recovery;
}

async function runJobLeaseRecoveryChain(database: LooseRecord) {
  let wakeWorker = false;
  while (!database.__jobStopped) {
    database.__jobLeaseRecoveryRequestedAt = null;
    let nextRecoveryAt: number | null;
    try {
      nextRecoveryAt = await recoverExpiredJobLeases(database);
      wakeWorker = true;
    } catch (error: any) {
      try {
        database.log.emit({ category: "platform", event: "job.lease_recovery.failed", level: "error", message: "Running Job lease recovery failed", data: { code: String(error?.code ?? "JOB_LEASE_RECOVERY_FAILED").slice(0, 80) } });
      } catch {}
      nextRecoveryAt = database.clock.now().getTime() + 1_000;
    }
    if (database.__jobStopped) return;
    const requestedAt = database.__jobLeaseRecoveryRequestedAt;
    database.__jobLeaseRecoveryRequestedAt = null;
    if (requestedAt !== null && requestedAt <= database.clock.now().getTime()) continue;
    const dueAt = requestedAt === null
      ? nextRecoveryAt
      : nextRecoveryAt === null ? requestedAt : Math.min(nextRecoveryAt, requestedAt);
    scheduleJobLeaseRecoveryTimer(database, dueAt);
    if (wakeWorker && !database.__jobStopped) scheduleCurrentUserJobWorker(database);
    return;
  }
}

function scheduleJobLeaseRecoveryTimer(database: LooseRecord, dueAt: number | null) {
  if (database.__jobLeaseRecoveryTimer) {
    database.clock.clearTimer(database.__jobLeaseRecoveryTimer);
    database.__jobLeaseRecoveryTimer = null;
  }
  database.__jobLeaseRecoveryDueAt = dueAt;
  if (database.__jobStopped || dueAt === null) return;
  database.__jobLeaseRecoveryTimer = database.clock.setTimer(async () => {
    database.__jobLeaseRecoveryTimer = null;
    database.__jobLeaseRecoveryDueAt = null;
    if (!database.__jobStopped) await startJobLeaseRecovery(database);
  }, Math.min(MAX_NATIVE_TIMER_DELAY_MS, Math.max(0, dueAt - database.clock.now().getTime())));
}

const RUNTIME_CLAIM_LEASE_MS = 30_000;

function invalidStoredJobFailure(row: LooseRecord, referenceInstant: Date) {
  if (row.scheduleName !== null && row.scheduleName !== undefined && row.actorUserId !== privilegedAuthUserId()) {
    return { code: "JOB_ACTOR_SNAPSHOT_INVALID", message: "Stored Job actor provenance is invalid." };
  }
  if (row.actorUserId !== privilegedAuthUserId()) {
    try {
      readJobAuthSnapshot(row);
      readJobCredentialProvenance(row);
    } catch (error: any) {
      if (["JOB_ACTOR_SNAPSHOT_INVALID", "JOB_CREDENTIAL_INVALID"].includes(error?.code)) {
        return { code: error.code, message: error.message };
      }
      throw error;
    }
  }
  if (!isCanonicalJobTimestamp(row.availableAt)) {
    return { code: "JOB_AVAILABLE_AT_INVALID", message: "The stored Job availability time is invalid." };
  }
  const retry = parsePersistedJobRetry(row.retryJson);
  const attempts = Number(row.attempts);
  const attemptsValid = Number.isInteger(attempts)
    && (row.status === "running"
      ? attempts >= 1 && attempts <= (retry?.maxAttempts ?? -1)
      : attempts >= 0 && attempts < (retry?.maxAttempts ?? -1));
  if (retry === null || !attemptsValid) return invalidJobRetryPolicyFailure();
  const remainingAttempts = retry.maxAttempts - attempts;
  if (remainingAttempts === 0) return null;
  const firstAttempt = row.status === "running"
    ? jobTimestampAfter(referenceInstant, retry.delayMs)
    : new Date(Math.max(referenceInstant.getTime(), Date.parse(row.availableAt))).toISOString();
  if (firstAttempt === null) return invalidJobRetryPolicyFailure();
  if (!jobRetryHorizonFits(new Date(firstAttempt), retry, remainingAttempts, Boolean(row.scheduleName && row.scheduledFor && retry.maxAttempts === 1))) return invalidJobRetryPolicyFailure();
  return null;
}

function jobRetryHorizonFits(firstAttempt: Date, retry: LooseRecord, attemptCount: number, allowShortFinalScheduleLease = false) {
  let attemptAt = firstAttempt;
  for (let attempt = 0; attempt < attemptCount; attempt += 1) {
    if (jobTimestampAfter(attemptAt, RUNTIME_CLAIM_LEASE_MS) === null) {
      return allowShortFinalScheduleLease
        && attempt === attemptCount - 1
        && isCanonicalJobTimestamp(attemptAt.toISOString());
    }
    if (attempt === attemptCount - 1) return true;
    const nextAttempt = jobTimestampAfter(attemptAt, retry.delayMs);
    if (nextAttempt === null) return false;
    attemptAt = new Date(nextAttempt);
  }
  return true;
}

async function failInvalidQueuedJob(database: LooseRecord, row: LooseRecord, failure: LooseRecord) {
  const sql = database.adapter.dialect.sql;
  return await database.adapter.prepare(sql(
    "UPDATE [sporades_jobs] SET [status]='failed', [failure]=?, [failedAt]=?, [leaseExpiresAt]=NULL, [claimToken]=NULL " +
    "WHERE [id]=? AND [status]=? AND [availableAt]=? AND COALESCE([retryJson], '') = COALESCE(?, '')",
  )).run(JSON.stringify(failure), database.clock.now().toISOString(), row.id, row.status, row.availableAt, row.retryJson);
}

async function recoverInvalidRetainedJobState(database: LooseRecord) {
  const recoveredAt = database.clock.now();
  const failedAt = recoveredAt.toISOString();
  const sql = database.adapter.dialect.sql;
  const rows = await database.adapter.prepare(sql(
    "SELECT * FROM [sporades_jobs] WHERE [status] IN ('queued', 'delayed')",
  )).all();
  await database.jobRecoveryFault?.("after-scan", { jobIds: rows.map((row: LooseRecord) => String(row.id)) });
  for (const row of rows) {
    const failure = invalidStoredJobFailure(row, recoveredAt);
    if (!failure) continue;
    await database.adapter.prepare(sql(
      "UPDATE [sporades_jobs] SET [status]='failed', [failure]=?, [failedAt]=?, [leaseExpiresAt]=NULL, [claimToken]=NULL " +
      "WHERE [id]=? AND [status]=? AND [availableAt]=? AND COALESCE([retryJson], '') = COALESCE(?, '')",
    )).run(JSON.stringify(failure), failedAt, row.id, row.status, row.availableAt, row.retryJson);
  }
}

function jobClaimOwnership(claimToken: any) {
  return claimToken === null || claimToken === undefined
    ? { predicate: "[claimToken] IS NULL", params: [] }
    : { predicate: "[claimToken] = ?", params: [claimToken] };
}

function jobClaimTokenIsMalformed(claimToken: any) {
  return claimToken !== null && claimToken !== undefined
    && (typeof claimToken !== "string" || claimToken.length === 0);
}

function logPayloadMaxBytes(config: LooseRecord = {}) {
  const configured = Number(config.logs?.payloadMaxBytes ?? config.logging?.payloadMaxBytes);
  return Number.isInteger(configured) && configured > 0 ? configured : 4096;
}

function logRedactedValue() {
  return "[REDACTED]";
}

const transactionPendingLogWrites = Symbol("sporades.transactionPendingLogWrites");

export function createRuntimeLogSink(options: { database: any; config: any; serverEnv: any; dataDir: any; }) {
  const path = requirePathModule();
  const logPath =
    options.config.logs?.jsonlPath ??
    options.config.logging?.jsonlPath ??
    process.env.SPORADES_LOG_PATH ??
    path.join(options.dataDir, "logs", "events.jsonl");
  mkdirSync(path.dirname(logPath), { recursive: true });
  return {
    path: logPath,
    withDatabase(database: LooseRecord) {
      return createRuntimeLogSink({ ...options, database });
    },
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
      const pendingWrites = options.database?.[transactionPendingLogWrites];
      const settled = isPromiseLike(indexed)
        ? pendingWrites ? indexed.then(() => event) : indexed.then(() => event, () => event)
        : event;
      if (isPromiseLike(settled) && pendingWrites) pendingWrites.push(settled);
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
    const attributedData = context.attribution
      ? {
          ...(structuredData && typeof structuredData === "object" && !Array.isArray(structuredData)
            ? structuredData
            : structuredData === null ? {} : { value: structuredData }),
          ...context.attribution,
        }
      : structuredData;
    database.log.emit({
      category: context.category ?? "app",
      event: context.event ?? "ctx.log",
      level,
      message: String(message ?? ""),
      data: attributedData,
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
      const auditMetadataOwner = database.__rootDatabase ?? database;
      auditMetadataOwner.__privilegedAuditMetadataByContext ??= new WeakMap();
      auditMetadataOwner.__privilegedAuditMetadataByContext.set(privilegedContext, auditDetails.metadata);
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
          revokePrivilegedAccessKeyAccess(privilegedContext);
          privilegedContext.__privilegedRunActive = false;
        } catch (error: any) {
          callbackError = error;
          callbackSettled = true;
          revokePrivilegedAccessKeyAccess(privilegedContext);
          privilegedContext.__privilegedRunActive = false;
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
          auditMetadataOwner.__privilegedAuditMetadataByContext.delete(privilegedContext);
          revokePrivilegedAccessKeyAccess(privilegedContext);
          privilegedContext.__privilegedRunActive = false;
          revokePrivilegedDbAccess(privilegedContext);
        }
      }
    },
  };
}
function createPrivilegedHandlerContext(database: LooseRecord, context: LooseRecord, signal: any) {
  const privilegedContext: LooseRecord = {
    ...context,
    signal,
    __privilegedRunActive: true,
    __jobEnqueuedBy: context.auth?.userId ?? null,
    __jobParentContext: context,
    auth: Object.freeze({
      userId: privilegedAuthUserId(),
      displayName: "Privileged server role",
      email: null,
      picture: null,
      isAuthenticated: false,
      isGuest: false,
      provider: "privileged-server-role",
    }),
  };
  if (context.__accessKeyOperatorExecutionSource) {
    Object.defineProperty(privilegedContext, "__accessKeyOperatorExecutionSource", {
      value: context.__accessKeyOperatorExecutionSource,
      enumerable: false,
    });
  }
  // User-scoped and mutating Team operations remain unavailable. This is the
  // separate userless inspection projection, not inherited Team authority.
  delete privilegedContext.teams;
  delete privilegedContext.accessKeys;
  delete privilegedContext.credential;
  delete privilegedContext.__sporadesAccessKeyGrants;
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
  privilegedContext.teams = createPrivilegedTeamsApi(database, () => holder.current);
  privilegedContext.teamBilling = createPrivilegedTeamBillingApi(database, () => holder.current);
  grantPrivilegedAccessKeyAccess(privilegedContext);
  privilegedContext.accessKeys = createPrivilegedAccessKeysApi(
    database,
    () => holder.current,
    (transactionAdapter: LooseRecord) => createTransactionDatabase(database, transactionAdapter),
  );
  privilegedContext.mail = database.mail;
  return privilegedContext;
}

export async function runRuntimeAccessKeyOperatorAction(database: LooseRecord, action: string, input: LooseRecord = {}, executionSource = "runtime-action") {
  const boundedInput = validateAccessKeyOperatorActionInput(action, input, () => {
    throw commandError("Invalid Access-key operator action input.", "Upgrade the Sporades CLI and generated Bundle together.", "INVALID_ACCESS_KEY_ACTION_INPUT");
  });
  const boundedExecutionSource = ["operator-cli-dev", "operator-cli-container", "operator-cli-hosted"].includes(executionSource)
    ? executionSource
    : "runtime-action";
  const metadata = {
    executionSource: boundedExecutionSource,
    ...(typeof boundedInput.userId === "string" ? { ownerUserId: boundedInput.userId } : {}),
    ...(typeof boundedInput.keyId === "string" ? { accessKeyId: boundedInput.keyId } : {}),
  };
  let context: LooseRecord | undefined;
  try {
    return await database.adapter.withTransaction(async (transactionAdapter: LooseRecord) => {
      const transactionDatabase = createTransactionDatabase(database, transactionAdapter);
      let actionFailed = false;
      try {
        context = createMutationContext(transactionDatabase, {
          userId: "__operator__", displayName: "Sporades operator", email: null, picture: null,
          isAuthenticated: false, isGuest: false, provider: "operator",
        }, { ordinaryCredential: false });
        Object.defineProperty(context, "__accessKeyOperatorExecutionSource", { value: boundedExecutionSource, enumerable: false });
        return await context.privileged.run({
          operation: "access-keys.operator-dispatch",
          surface: boundedExecutionSource,
          targetResourceKind: "access-key",
          metadata: { ...metadata, requestedAction: action },
        }, async (privilegedContext: LooseRecord) => {
          switch (action) {
            case "access-keys.list": return await privilegedContext.accessKeys.list(boundedInput.userId, boundedInput.options);
            case "access-keys.inspect": return await privilegedContext.accessKeys.inspect(boundedInput.keyId);
            case "access-keys.revoke": return await privilegedContext.accessKeys.revoke(boundedInput.keyId);
            case "access-keys.revoke-all": return await privilegedContext.accessKeys.revokeAll(boundedInput.userId);
            case "access-keys.delete": return await privilegedContext.accessKeys.delete(boundedInput.keyId);
            default: throw commandError("Unsupported Access-key operator action.", "Upgrade the Sporades CLI and generated Bundle together.", "ACCESS_KEY_ACTION_UNSUPPORTED");
          }
        });
      } catch (error) {
        actionFailed = true;
        throw error;
      } finally {
        await cleanupTransactionHandler(transactionDatabase, context, actionFailed, actionFailed);
      }
    });
  } catch (error: any) {
    database.rowCache.clear();
    await reindexPrivilegedAuditEventsAfterRollback(database, context);
    if (error?.code === "PRIVILEGED_RUN_FAILED" && publicAccessKeyManagementError(error.cause)) throw error.cause;
    throw error;
  }
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
  assertNotReservedTeamTableName(name);
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
    uniqueConstraints: normalizeUniqueConstraints(name, table.fields, table.uniqueConstraints),
  };
}

function normalizeUniqueConstraints(tableName: string, fields: Record<string, unknown>, declarations: unknown) {
  if (declarations === undefined) return [];
  if (!Array.isArray(declarations)) {
    throw commandError(
      `Invalid unique declaration on Capsule table: ${tableName}`,
      "Declare uniqueness with .unique(\"field\") or .unique(\"firstField\", \"secondField\").",
    );
  }

  const declaredFields = new Set(Object.keys(fields));
  const seen = new Set<string>();
  return declarations.map((declaration) => {
    if (!Array.isArray(declaration) || declaration.length === 0 || declaration.some((field) => typeof field !== "string" || !declaredFields.has(field))) {
      throw commandError(
        `Invalid unique declaration on Capsule table: ${tableName}`,
        "Each unique declaration must name one or more declared Capsule fields.",
      );
    }
    if (new Set(declaration).size !== declaration.length) {
      throw commandError(
        `Invalid unique declaration on Capsule table: ${tableName}`,
        "A unique declaration cannot repeat a Capsule field.",
      );
    }
    const identity = [...declaration].sort().join("\u0000");
    if (seen.has(identity)) {
      throw commandError(
        `Duplicate unique declaration on Capsule table: ${tableName}`,
        "Declare each set of unique Capsule fields only once; field order does not make a new constraint.",
      );
    }
    seen.add(identity);
    return [...declaration];
  }).sort((left, right) => [...left].sort().join("\u0000").localeCompare([...right].sort().join("\u0000")));
}

function assertNotReservedTeamTableName(name: string) {
  if (name.toLowerCase().startsWith("sporades_team")) {
    throw commandError(
      `Reserved runtime table name: ${name}`,
      "Choose a Capsule table name outside the sporades_team runtime namespace.",
      "RESERVED_TABLE_NAME",
    );
  }
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

export function extractEndpoints(serverSource: string) {
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
      // Keep declaration-time transport policy with the runtime route. It is security
      // configuration, not handler-owned data, and must survive Capsule registration.
      options: definition.options,
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

function materializeHandler(handler: LooseRecord): Function {
  return typeof handler.handler === "function"
    ? handler.handler
    : new Function(`return (${handler.handlerSource});`)();
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
    const result = await runEndpoint(database, endpoint, requestUrl, request);
    const sensitiveResponseHeaders = (request as LooseRecord).__sporadesAccessKeyAdmitted
      || (request as LooseRecord).__sporadesSecretDisclosed
      ? { "cache-control": "private, no-store", pragma: "no-cache" }
      : undefined;
    writeEndpointResult(response, result, sensitiveResponseHeaders);
  } catch (error: any) {
    if (error?.sporadesAuthDenialLogData) {
      emitAuthDeniedLog(database as LooseRecord, { data: error.sporadesAuthDenialLogData });
    } else if (error?.sporadesAccessKeyFailure) {
      emitAuthDeniedLog(database as LooseRecord, { data: {
        requirement: "access-key",
        reason: error.sporadesAccessKeyReason ?? error.sporadesAccessKeyFailure,
        handler: { kind: "endpoint", path: requestUrl.pathname },
        actor: { userId: null, provider: null, isAuthenticated: null, isGuest: null },
      } });
    }
    if ((request as LooseRecord).__sporadesAccessKeyAdmitted || error?.sporadesAccessKeyFailure) {
      response.setHeader("cache-control", "no-store");
      response.setHeader("pragma", "no-cache");
    }
    emitHttpFailureLog(database as LooseRecord, request, error);
    writeEndpointError(response, error);
  }
  return true;
}


























async function admitCapsuleIngressPrincipal(database: LooseRecord, endpoint: LooseRecord, endpointRequest: LooseRecord, signal: any) {
  const definition = database.fileIngressDefinition;
  if (!definition) throw commandError("Unauthenticated.", "Provide valid ingress authority and retry.", "UNAUTHENTICATED");
  const decision = await database.adapter.withTransaction((transaction: LooseRecord) => withTrustedRead(database, {
    transaction,
    purpose: "files.ingress-admission",
    subject: { method: endpoint.options.method, path: endpoint.options.path },
    signal,
  }, (db) => definition.admit(Object.freeze({
    db,
    env: database.serverEnv,
    signal,
    request: Object.freeze({ method: endpointRequest.method, path: endpointRequest.path, headers: Object.freeze({ ...endpointRequest.headers }), query: Object.freeze({ ...endpointRequest.query }) }),
  }), Object.freeze({ method: endpointRequest.method, path: endpointRequest.path, headers: Object.freeze({ ...endpointRequest.headers }), query: Object.freeze({ ...endpointRequest.query }) }))));
  const namespace = decision?.principal?.namespace; const key = decision?.principal?.key;
  const serialized = (() => { try { return JSON.stringify(decision); } catch { return ""; } })();
  if (decision?.allow !== true || typeof namespace !== "string" || !definition.principalNamespaces.includes(namespace) || typeof key !== "string" || key.length === 0 || Buffer.byteLength(key, "utf8") > 256 || /[\x00-\x1f\x7f]/.test(key) || Buffer.byteLength(serialized, "utf8") > 4096) {
    throw commandError("Unauthenticated.", "Provide valid ingress authority and retry.", "UNAUTHENTICATED");
  }
  return Object.freeze({ kind: "capsule-principal", namespace, key, keyDigest: createHash("sha256").update(`${namespace}\0${key}`, "utf8").digest("hex"), ownerId: database.capsuleIngressOwnerId });
}

export async function runEndpoint(database: any, endpoint: { handler?: Function; handlerSource?: string; }, requestUrl: URL, request: any) {
  const handler =
    typeof endpoint.handler === "function"
      ? endpoint.handler
      : new Function(`return (${endpoint.handlerSource});`)();
  const runtimeOwnedProviderCallback = (endpoint as LooseRecord).runtimeOwnedEmailEvent || (endpoint as LooseRecord).runtimeOwnedStripeCallback;
  // Admission intentionally precedes multipart body consumption. Ordinary endpoint bodies retain
  // their historic bounded read path below.
  let endpointRequest = endpointRequestHead(requestUrl, request);
  const requirements = readAuthRequirements(handler);
  const hasAuthorization = requirements ? endpointHasAuthorization(request) : false;
  if (requirements) delete endpointRequest.headers.authorization;
  const session = runtimeOwnedProviderCallback
    ? { auth: {
        userId: privilegedAuthUserId(),
        displayName: (endpoint as LooseRecord).runtimeOwnedStripeCallback ? "Stripe provider callback" : "Email provider callback",
        email: null,
        picture: null,
        isAuthenticated: false,
        isGuest: false,
        provider: "privileged-server-role",
      } }
    : hasAuthorization
      ? null
      : await resolveAnonymousSession(database, readEndpointSessionToken(endpointRequest.headers, endpointRequest.query));
  const accessKeyAdmission = hasAuthorization
    ? await resolveAccessKeyCredential(
      database,
      request,
      readEndpointSessionToken(endpointRequest.headers, endpointRequest.query),
    )
    : null;
  // Multipart is an ingress capability, not a way to make an unauthenticated client
  // pay us in bytes before we reject it. Session guards have no body dependency, so
  // admit them before the multipart reader advances the request iterator.
  if (!accessKeyAdmission && requirements && (endpoint as LooseRecord).options?.body?.multipart) {
    admitCredentialHandler(handler, { auth: session?.auth, credential: { kind: "session" } }, "endpoint");
  }
  if (accessKeyAdmission) {
    const admissionContext = {
      auth: accessKeyAdmission.auth,
      credential: accessKeyAdmission.credential,
      __sporadesAccessKeyGrants: accessKeyAdmission.grants,
      request: { path: endpointRequest.path },
    };
    admitCredentialHandler(handler, admissionContext, "endpoint");
    (request as LooseRecord).__sporadesAccessKeyAdmitted = true;
    (request as LooseRecord).__sporadesAccessKeyAttribution = {
      actor: { userId: admissionContext.auth.userId },
      ...accessKeyCredentialLogAttribution(admissionContext),
    };
    emitAccessKeyAdmittedAudit(database, { ...admissionContext, kind: "endpoint" }, accessKeyAdmission.record);
    await recordAccessKeyUsage(database, accessKeyAdmission);
  }
  if ((endpoint as LooseRecord).options?.body?.multipart) {
    const claimAuthority = endpointIngressClaimAuthority(endpoint as LooseRecord);
    const admitted = (accessKeyAdmission ?? session) as LooseRecord;
    let ingressAuthority: LooseRecord;
    if (claimAuthority === "capsule-principal") {
      ingressAuthority = await admitCapsuleIngressPrincipal(database, endpoint as LooseRecord, endpointRequest, request.signal);
    } else {
      if (!admitted?.auth?.isAuthenticated || admitted.auth.isGuest || isReservedAuthUserId(admitted.auth.userId)) throw commandError("Unauthenticated.", "Sign in with a linked human or service User and retry.", "UNAUTHENTICATED");
      ingressAuthority = Object.freeze({ kind: "actor", actorId: String(admitted.auth.userId), ownerId: String(admitted.auth.userId) });
    }
    const payload = await stageMultipartIngress(database, endpoint as LooseRecord, request, endpointRequest, admitted.auth, ingressAuthority);
    endpointRequest = { ...endpointRequest, ...payload };
  } else {
    endpointRequest = await readEndpointRequest(database, requestUrl, request, !(endpoint as LooseRecord).runtimeOwnedStripeCallback);
    // `readEndpointRequest` rebuilds the request head before reading the body.
    // Preserve the long-standing guard invariant that a consumed Bearer value
    // never reaches Capsule middleware or handler code.
    if (requirements) delete endpointRequest.headers.authorization;
  }
  let context: LooseRecord | undefined;
  try {
    let result: any; let transactionAttempt = 0;
    while (true) {
      let ingressFenceAcquired = false;
      try {
        context = undefined;
        result = await database.adapter.withTransaction(async (transactionAdapter: any) => {
          // This conditional no-op UPDATE is deliberately the first endpoint SQL. It gives every
          // runtime connection the same sorted receipt lock order before middleware or app code
          // can produce effects. SQLite contention is retried only while this fence is unarmed.
          const ingressLeaseIds = (((endpointRequest as LooseRecord).multipart?.files) ?? []).map((lease: LooseRecord) => String(lease.leaseId));
          if (ingressLeaseIds.length > 0) await transactionAdapter.lockIngressReceipts(ingressLeaseIds);
          ingressFenceAcquired = true;
          const transactionDatabase = createTransactionDatabase(database, transactionAdapter);
          let handlerFailed = false;
          try {
            const resolvedSession = (accessKeyAdmission ?? session) as LooseRecord;
            context = createEndpointContext(transactionDatabase, endpointRequest, resolvedSession, {
              ordinaryCredential: !runtimeOwnedProviderCallback,
              credential: accessKeyAdmission?.credential,
              accessKeyGrants: accessKeyAdmission?.grants,
            });
            context.files = createEndpointIngressApi(transactionDatabase, endpoint as LooseRecord, endpointRequest, context);
            if ((endpoint as LooseRecord).runtimeOwnedStripeCallback) {
              Object.defineProperty(context, runtimeOwnedJobEnqueueHandler, { value: STRIPE_EVENT_JOB });
            }
            if (!runtimeOwnedProviderCallback) {
              if (!accessKeyAdmission) admitCredentialHandler(handler, context, "endpoint");
              context = await applyContextMiddleware(transactionDatabase, context, "endpoint");
            }
            const result = await handler(context);
            if (accessKeySecretWasDisclosed(context)) (request as LooseRecord).__sporadesSecretDisclosed = true;
            return result;
          } catch (error) {
            handlerFailed = true;
            throw error;
          } finally {
            await cleanupTransactionHandler(transactionDatabase, context, handlerFailed);
          }
        });
        break;
      } catch (error: any) {
        if (ingressFenceAcquired || database.adapter.engine !== "sqlite" || transactionAttempt >= 100 || !String(error?.message ?? "").includes("database is locked")) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, transactionAttempt + 1)));
        transactionAttempt += 1;
      }
    }
    finalizeEndpointIngressClaims(context ?? {}, true);
    commitPendingJobCancellationAborts(context);
    await flushAccessKeyLifecycleAuditEvents(database, context);
    flushTeamSecurityEvents(database, context);
    await dispatchPendingJobs(context);
    return result;
  } catch (error) {
    finalizeEndpointIngressClaims(context ?? {}, false);
    dropPendingJobCancellationAborts(context);
    dropAccessKeyLifecycleAuditEvents(context);
    flushTeamSecurityEvents(database, context, { deniedOnly: true });
    dropPendingJobDispatch(context);
    throw error;
  }
}

function createWriteTrackingAdapter(transactionAdapter: LooseRecord, writeState: { didWrite: boolean; }) {
  return new Proxy(transactionAdapter, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => {
          const statement: any = Reflect.apply(Reflect.get(target, property, receiver), receiver, [sql]);
          return Object.assign(Object.create(statement), {
            run(...params: any[]) {
              const result = Reflect.apply(statement.run, statement, params);
              return thenIfPromise(result, (writeResult: LooseRecord) => {
                if (Number(writeResult?.changes ?? 0) > 0) writeState.didWrite = true;
                return writeResult;
              });
            },
          });
        };
      }
      if (property === "exec") {
        return (sql: string) => thenIfPromise(
          Reflect.apply(Reflect.get(target, property, receiver), receiver, [sql]),
          (result: any) => { writeState.didWrite = true; return result; },
        );
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

function createTransactionDatabase(database: LooseRecord, transactionAdapter: any, writeState?: { didWrite: boolean; }) {
  const adapter = writeState ? createWriteTrackingAdapter(transactionAdapter, writeState) : transactionAdapter;
  if (!transactionAdapter) return database;
  const pendingLogWrites = transactionAdapter[transactionPendingLogWrites] ?? [];
  if (!transactionAdapter[transactionPendingLogWrites]) {
    Object.defineProperty(transactionAdapter, transactionPendingLogWrites, { value: pendingLogWrites });
  }
  const transactionDatabase: LooseRecord = {
    ...database,
    adapter,
    sqlite: adapter,
    __transactionActive: true,
    [trustedReadTransactionAdapter]: transactionAdapter,
    __rootDatabase: database.__rootDatabase ?? database,
    __pendingLogWrites: pendingLogWrites,
  };
  transactionDatabase.stageTeamBillingMembershipChange = (teamId: string) =>
    stageTeamBillingMembershipChange(transactionDatabase, teamId);
  transactionDatabase.scheduleTeamBillingJobDispatch = () => deferOrScheduleJobDispatch(
    transactionDatabase,
    transactionDatabase.__rootDatabase,
  );
  if (typeof database.log?.withDatabase === "function") {
    transactionDatabase.log = database.log.withDatabase(adapter);
    transactionDatabase.audit = createPrivilegedAuditEmitter(transactionDatabase.log);
  }
  transactionDatabase.mail = Object.assign(Object.create(database.mail), {
    send(input: LooseRecord, deliveryLog?: (event: LooseRecord) => any) {
      return database.mail.send(
        input,
        deliveryLog ?? ((event: LooseRecord) => transactionDatabase.log?.emit(event)),
      );
    },
  });
  return transactionDatabase;
}

function atomicStripeAbortError() {
  const error: any = new Error("Atomic Stripe consequence aborted.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

async function acquireAtomicStripeConsequenceFence(adapter: LooseRecord) {
  const sql = adapter.dialect.sql;
  let acquired;
  try {
    await adapter.prepare(sql(
      "INSERT INTO [sporades] ([key], [value]) VALUES (?, ?) ON CONFLICT ([key]) DO NOTHING",
    )).run("stripe-consequence-fence", "0");
    acquired = await adapter.prepare(sql(
      "UPDATE [sporades] SET [value] = CAST([value] AS INTEGER) + 1 WHERE [key] = ?",
    )).run("stripe-consequence-fence");
  } catch (cause: any) {
    const contention = cause?.errcode === 5 || cause?.code === "SQLITE_BUSY"
      || cause?.code === "ERR_SQLITE_ERROR" && /\b(?:busy|locked)\b/i.test(String(cause?.message ?? ""))
      || ["40001", "40P01", "55P03"].includes(cause?.code);
    if (!contention) throw cause;
    const error: any = new Error("Atomic Stripe consequence serialization is busy.");
    error.code = "STRIPE_CONSEQUENCE_FENCE_BUSY";
    error.retryable = true;
    error.cause = cause;
    error[atomicStripeFenceContention] = true;
    throw error;
  }
  if (Number(acquired?.changes ?? 0) !== 1) {
    const error: any = new Error("Atomic Stripe consequence serialization is unavailable.");
    error.code = "STRIPE_CONSEQUENCE_FENCE_UNAVAILABLE";
    throw error;
  }
}

function createAtomicStripeConsequenceContext(database: LooseRecord, parent: LooseRecord) {
  const context: LooseRecord = {
    auth: parent.auth,
    env: database.serverEnv,
    signal: parent.signal,
    log: createEndpointLogger(database),
    __privilegedRunActive: true,
    __jobEnqueuedBy: parent.__jobEnqueuedBy ?? null,
    __pendingAclWrites: [],
  };
  grantPrivilegedDbAccess(context);
  const holder = createContextHolder(context);
  registerHandlerContextMapping(database, holder);
  context.db = createEndpointDatabaseApi(database, () => holder.current);
  const privilegedJobs = createPrivilegedJobApi(database, () => holder.current);
  context.jobs = Object.freeze({
    enqueue: privilegedJobs.enqueue.bind(privilegedJobs),
  });
  const privilegedTeams = createPrivilegedTeamsApi(database, () => holder.current);
  context.teams = Object.freeze({
    countMembers: privilegedTeams.countMembers.bind(privilegedTeams),
  });
  return context;
}

async function settleAtomicStripeEventHandler(
  database: LooseRecord,
  context: LooseRecord,
  signal: AbortSignal | undefined,
  dispatch: () => Promise<any>,
) {
  if (signal?.aborted) throw atomicStripeAbortError();
  let abortHandler: (() => void) | undefined;
  let watchdog: any;
  let rejectSettlement: ((reason: any) => void) | undefined;
  const failClosed = () => {
    context.__privilegedRunActive = false;
    revokePrivilegedDbAccess(context);
    rejectSettlement?.(atomicStripeAbortError());
  };
  const aborted = new Promise((_, reject) => {
    rejectSettlement = reject;
    if (!signal) return;
    abortHandler = failClosed;
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  watchdog = database.clock.setTimer(failClosed, RUNTIME_CLAIM_LEASE_MS);
  try {
    return await Promise.race([dispatch(), aborted]);
  } finally {
    database.clock.clearTimer(watchdog);
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
  }
}

export async function runAtomicStripeConsequence(
  database: LooseRecord,
  parentContext: LooseRecord,
  event: LooseRecord,
  subscription?: LooseRecord,
  platformConsequence?: (database: LooseRecord, event: LooseRecord) => Promise<any>,
) {
  if (parentContext.signal?.aborted) throw atomicStripeAbortError();
  for (let fenceAttempt = 1; fenceAttempt <= 200; fenceAttempt += 1) {
    let context: LooseRecord | undefined;
    try {
      const result = await database.adapter.withTransaction(async (transactionAdapter: LooseRecord) => {
        await acquireAtomicStripeConsequenceFence(transactionAdapter);
        if (parentContext.signal?.aborted) throw atomicStripeAbortError();
        const transactionDatabase = createTransactionDatabase(database, transactionAdapter);
        let cleanupComplete = false;
        let handlerFailed = false;
        try {
          context = createAtomicStripeConsequenceContext(transactionDatabase, parentContext);
          const delivered = await settleAtomicStripeEventHandler(
            database,
            context,
            parentContext.signal,
            async () => {
              await platformConsequence?.(transactionDatabase, event);
              return dispatchVerifiedStripeEvent(context!, event, subscription);
            },
          );
          await cleanupTransactionHandler(transactionDatabase, context, false, false);
          cleanupComplete = true;
          if (parentContext.signal?.aborted) throw atomicStripeAbortError();
          return delivered;
        } catch (error) {
          handlerFailed = true;
          throw error;
        } finally {
          try {
            if (!cleanupComplete) {
              await cleanupTransactionHandler(transactionDatabase, context, handlerFailed, handlerFailed);
            }
          } finally {
            if (context) {
              context.__privilegedRunActive = false;
              revokePrivilegedDbAccess(context);
            }
          }
        }
      });
      commitPendingJobCancellationAborts(context);
      await dispatchPendingJobs(context);
      database.rowCache.clear();
      return result;
    } catch (error: any) {
      dropPendingJobCancellationAborts(context);
      dropPendingJobDispatch(context);
      database.rowCache.clear();
      await reindexPrivilegedAuditEventsAfterRollback(database, context);
      if (error?.code !== "STRIPE_CONSEQUENCE_FENCE_BUSY" || fenceAttempt === 200 || parentContext.signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, fenceAttempt)));
    }
  }
  throw new Error("Unreachable atomic Stripe consequence fence state.");
}

async function readEndpointRequest(database: LooseRecord, requestUrl: URL, request: any, parseJsonBody = true) {
  const head = endpointRequestHead(requestUrl, request);
  const payload = await readEndpointPayload(request, head.headers, database, parseJsonBody);
  return { ...head, ...payload };
}

function endpointRequestHead(requestUrl: URL, request: any) {
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
  };
}

function createEndpointContext(database: LooseRecord, endpointRequest: LooseRecord, session: LooseRecord, options: LooseRecord = {}) {
  const auth = protectContextIdentity(contextAuthIdentity(session.auth));
  const credential = options.ordinaryCredential === false
    ? null
    : protectContextIdentity(options.credential ?? { kind: "session" });
  const context: LooseRecord = {
    auth,
    ...(credential ? { credential } : {}),
    env: database.serverEnv,
    payments: database.paymentsConfig,
    log: createEndpointLogger(database, {
      request: {
        method: endpointRequest.method,
        path: endpointRequest.path,
      },
      ...(credential?.kind === "access-key" ? {
        attribution: {
          actor: { userId: auth.userId },
          credential: { kind: credential.kind, id: credential.id, name: credential.name },
        },
      } : {}),
    }),
    request: {
      method: endpointRequest.method,
      path: endpointRequest.path,
      headers: endpointRequest.headers,
      query: endpointRequest.query,
      body: endpointRequest.body,
      bodyBytes: endpointRequest.bodyBytes,
      ...(endpointRequest.multipart ? { multipart: endpointRequest.multipart } : {}),
    },
  };
  if (endpointRequest.__ingressAuthority?.kind === "capsule-principal") {
    context.ingress = Object.freeze({ principal: Object.freeze({ namespace: endpointRequest.__ingressAuthority.namespace, key: endpointRequest.__ingressAuthority.key }) });
  }
  if (credential?.kind === "session" && typeof session.token === "string") {
    bindAccessKeyOwnerSession(context, session.token);
  }
  if (options.accessKeyGrants) {
    Object.defineProperty(context, "__sporadesAccessKeyGrants", { value: Object.freeze([...options.accessKeyGrants]) });
  }
  const holder = createContextHolder(context);
  registerHandlerContextMapping(database, holder);
  context.db = createEndpointDatabaseApi(database, () => holder.current);
  context.privileged = createContextPrivilegedApi(database, () => holder.current);
  context.jobs = createCurrentUserJobApi(database, () => holder.current);
  context.mail = {
    enabled: database.mail.enabled,
    send(input: LooseRecord) {
      return database.mail.send(input, (event: LooseRecord) => database.log?.emit(event));
    },
  };
  context.teams = createCurrentUserTeamsApi(database, auth, () => holder.current);
  context.teamBilling = createCurrentUserTeamBillingErasureApi(
    database,
    auth,
    () => holder.current,
    (candidate) => handlerContextByDatabase.get(database)?.() === candidate,
  );
  context.accessKeys = createCurrentUserAccessKeysApi(database, () => holder.current);
  context.serviceUsers = createServiceUsersApi(
    database,
    () => holder.current,
    credential?.kind === "session" && typeof session.token === "string" ? session.token : null,
    { mutationSurface: false },
  );
  context.serverAuth = {
    async revokeHumanSecurity(_userId: string) {
      throw commandError("Human security transition is unavailable.", "Run this operation inside an authenticated Capsule mutation.", "HUMAN_SECURITY_TRANSITION_UNAVAILABLE");
    },
    async setEmailPassword(email: string, newPassword: string) {
      const result = await setEmailPassword(database, { auth }, email, newPassword);
      if (!result.ok) throw new Error(result.error?.message ?? "Could not set password.");
    },
    async sendEmailPasswordResetLink(email: string, options: LooseRecord = {}) {
      const result: any = await sendEmailPasswordResetLink(database, { auth }, email, options);
      if (!result.ok) throw serverAuthError(result.error, "Could not send the password reset link.");
    },
    async createEmailPasswordResetLink(email: string) {
      const result: any = await createEmailPasswordResetLink(database, { auth }, email);
      if (!result.ok) throw serverAuthError(result.error, "Could not create a password reset link.");
      return { link: result.link, expiresAt: result.expiresAt };
    },
    async verifyPasswordResetCode(code: string) {
      const result: any = await verifyPasswordResetCode(database, { auth }, code);
      if (!result.ok) throw serverAuthError(result.error, "Could not verify the password reset code.");
      return { email: result.email };
    },
    async confirmPasswordReset(code: string, newPassword: string) {
      const result: any = await confirmPasswordReset(database, { auth }, code, newPassword);
      if (!result.ok) throw serverAuthError(result.error, "Could not complete the password reset.");
    },
  };
  return context;
}

function contextAuthIdentity(value: LooseRecord) {
  const { userKind, ...legacyIdentity } = value ?? {};
  return userKind === "service" ? { ...legacyIdentity, userKind } : legacyIdentity;
}

function protectContextIdentity(value: LooseRecord) {
  const target = Object.freeze({ ...value });
  const tampered = () => {
    throw commandError(
      "Invalid Capsule context middleware result.",
      "Runtime-owned Auth and Credential values are immutable.",
      "INVALID_CONTEXT_MIDDLEWARE_RESULT",
    );
  };
  return new Proxy(target, {
    set: tampered,
    defineProperty: tampered,
    deleteProperty: tampered,
    setPrototypeOf: tampered,
  });
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

const handlerContextByDatabase = new WeakMap<object, () => LooseRecord>();
// Lexical runtime authority: Capsule input and context middleware can neither
// construct nor recover this exact identity.
const serviceUserMutationAuthority = Object.freeze({ kind: "service-user-mutation-authority" });

function registerHandlerContextMapping(database: LooseRecord, holder: { current: LooseRecord; }) {
  if (!database.__transactionActive) return;
  releaseHandlerContextMapping(database);
  const rootDatabase = database.__rootDatabase ?? database;
  handlerContextByDatabase.set(database, () => holder.current);
  rootDatabase.__handlerContextMappingCount += 1;
  database.__releaseHandlerContextMapping = () => {
    if (!handlerContextByDatabase.delete(database)) return;
    rootDatabase.__handlerContextMappingCount -= 1;
  };
}

function releaseHandlerContextMapping(database: LooseRecord) {
  database.__releaseHandlerContextMapping?.();
  delete database.__releaseHandlerContextMapping;
}

async function cleanupTransactionHandler(
  database: LooseRecord,
  context: LooseRecord | undefined,
  preservePrimaryError: boolean,
  clearCache = true,
) {
  let cleanupFailed = false;
  try {
    if (context) await drainPendingAclWrites(context);
    await drainPendingLogWrites(database);
  } catch (error) {
    cleanupFailed = true;
    if (!preservePrimaryError) throw error;
  } finally {
    try {
      if (clearCache || cleanupFailed) database.rowCache.clear();
    } finally {
      releaseHandlerContextMapping(database);
    }
  }
}

function trackMutationContextWork(context: LooseRecord, promise: Promise<any>, requiresConsumption = false) {
  const operation = Promise.resolve(promise);
  const tracked = requiresConsumption
    ? operation.then((value) => {
        const token = value?.token;
        if (typeof token !== "string" || token.length === 0) {
          throw Object.assign(new Error("One-time credential result was invalid."), {
            code: "ACCESS_KEY_SECRET_NOT_CONSUMED",
            hint: "Return the complete Service-User credential result from the Mutation.",
          });
        }
        context.__pendingMutationSecrets.push(token);
        return value;
      })
    : operation;
  const entry = { promise: tracked };
  context.__pendingAclWrites.push(entry);
  return operation;
}

function resultContainsMutationSecret(value: any, token: string): boolean {
  if (value === token) return true;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => resultContainsMutationSecret(entry, token));
  return Object.values(value).some((entry) => resultContainsMutationSecret(entry, token));
}

function assertMutationSecretsReturned(context: LooseRecord, result: LooseRecord) {
  for (const token of context.__pendingMutationSecrets ?? []) {
    if (!resultContainsMutationSecret(result?.data, token)) {
      throw Object.assign(new Error("One-time credential result was not returned."), {
        code: "ACCESS_KEY_SECRET_NOT_CONSUMED",
        hint: "Return the complete Service-User credential result from the Mutation.",
      });
    }
  }
}

async function drainPendingLogWrites(database: LooseRecord) {
  const pending = database.__pendingLogWrites;
  while (pending?.length > 0) {
    const outcomes = await Promise.allSettled(pending.splice(0));
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  }
}

async function applyContextMiddleware(database: LooseRecord, baseContext: LooseRecord, kind: string) {
  const canonicalAuth = baseContext.auth;
  const canonicalCredential = baseContext.credential;
  let context: LooseRecord = {
    ...baseContext,
    kind,
  };
  transferAccessKeyRuntimeState(baseContext, context);
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
    const previousContext = context;
    const result = await runContextMiddleware(middlewareSource, context);
    const middlewareContext = result ?? context;
    if (!middlewareContext || typeof middlewareContext !== "object" || middlewareContext.auth !== canonicalAuth || middlewareContext.credential !== canonicalCredential) {
      throw commandError(
        "Invalid Capsule context middleware result.",
        "Context middleware must preserve the runtime-owned Auth and Credential values.",
        "INVALID_CONTEXT_MIDDLEWARE_RESULT",
      );
    }
    context = { ...middlewareContext, auth: canonicalAuth };
    if (Object.prototype.hasOwnProperty.call(baseContext, "credential")) {
      context.credential = canonicalCredential;
    } else {
      delete context.credential;
    }
    holder.current = context;
    if (!context.__sporadesContextHolder) {
      Object.defineProperty(context, "__sporadesContextHolder", {
        value: holder,
        enumerable: false,
        configurable: true,
      });
    }
    if (previousContext.__pendingAclWrites && !context.__pendingAclWrites) {
      context.__pendingAclWrites = previousContext.__pendingAclWrites;
    }
    transferAccessKeyRuntimeState(previousContext, context);
  }
  return context;
}

function admitCredentialHandler(handler: unknown, context: LooseRecord, kind: string) {
  const requirements = readAuthRequirements(handler);
  if (!requirements) {
    return;
  }
  const auth = context?.auth;
  const credentialKind = context?.credential?.kind ?? "session";
  if (auth?.isAuthenticated !== true || (requirements.linked && auth?.isGuest === true)) {
    const error: LooseRecord = commandError("Unauthenticated.", "Sign in and retry the request.", "UNAUTHENTICATED");
    error.sporadesAuthDenialLogData = createAuthDenialLogData({ auth, kind }, requirements.linked ? "linked" : "authenticated");
    if (requirements.credentials.includes("access-key")) error.sporadesAccessKeyFailure = "missing";
    throw error;
  }
  if (!requirements.credentials.includes(credentialKind)) {
    const error: LooseRecord = commandError(
      "Forbidden.",
      "The authenticated credential is not permitted for this operation.",
      "FORBIDDEN",
    );
    error.sporadesAuthDenialLogData = createAuthDenialLogData({ auth, kind }, "credential");
    if (credentialKind === "access-key" || requirements.credentials.includes("access-key")) {
      error.sporadesAccessKeyFailure = "forbidden";
    }
    throw error;
  }
  if (
    credentialKind === "access-key"
    && !accessKeyGrantsSatisfyScopes(context.__sporadesAccessKeyGrants ?? [], requirements.scopes)
  ) {
    const error: LooseRecord = commandError("Forbidden.", "The authenticated credential is not permitted for this operation.", "FORBIDDEN");
    error.sporadesAuthDenialLogData = createAuthDenialLogData({ auth, kind }, "scope");
    error.sporadesAccessKeyFailure = "forbidden";
    throw error;
  }
}

function endpointHasAuthorization(request: LooseRecord) {
  if (Array.isArray(request?.rawHeaders)) {
    return request.rawHeaders.some((value: unknown, index: number) => index % 2 === 0 && String(value).toLowerCase() === "authorization");
  }
  return request?.headers?.authorization !== undefined;
}

function runContextMiddleware(middlewareSource: any, context: any) {
  const createMiddleware = new Function(`return (${middlewareSource});`);
  const middleware = createMiddleware();
  return middleware(context);
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
export function createEndpointDatabaseApi(database: LooseRecord, contextGetter: any = null) {
  return Object.fromEntries(
    database.schema.tables.map((table: { name: any; }) => [table.name, createEndpointTableApi(database, table, {}, contextGetter)]),
  );
}

function createEndpointReadOnlyDatabaseApi(database: LooseRecord, contextGetter: any = null, assertActive: () => void = () => {}) {
  return Object.fromEntries(
    database.schema.tables.map((table: { name: any; }) => [
      table.name,
      readOnlyEndpointTableApi(createEndpointTableApi(database, table, {}, contextGetter), assertActive),
    ]),
  );
}

function readOnlyEndpointTableApi(tableApi: LooseRecord, assertActive: () => void): LooseRecord {
  return {
    where(fieldName: any, value: any) {
      assertActive();
      return readOnlyEndpointTableApi(tableApi.where(fieldName, value), assertActive);
    },
    orderBy(fieldName: any, direction = "asc") {
      assertActive();
      return readOnlyEndpointTableApi(tableApi.orderBy(fieldName, direction), assertActive);
    },
    limit(count: any) {
      assertActive();
      return readOnlyEndpointTableApi(tableApi.limit(count), assertActive);
    },
    get() {
      assertActive();
      return trustedReadResult(tableApi.get(), assertActive);
    },
    all() {
      assertActive();
      return trustedReadResult(tableApi.all(), assertActive);
    },
  };
}

function trustedReadResult(value: any, assertActive: () => void) {
  return Promise.resolve(value).then((result) => {
    assertActive();
    return result;
  });
}

export async function withTrustedRead(database: LooseRecord, options: LooseRecord, callback: (db: LooseRecord, assertActive: () => void) => any) {
  if (!isActiveTransactionScopedAdapter(options?.transaction, database?.adapter)) {
    throw commandError(
      "Trusted app-database reads require an active transaction.",
      "Start the trusted policy from the runtime-owned transition transaction.",
      "TRUSTED_READ_TRANSACTION_REQUIRED",
    );
  }
  if (!trustedReadPurposes.has(options?.purpose)) {
    throw commandError(
      "Trusted app-database read purpose is invalid.",
      "Use a runtime-owned trusted policy purpose.",
      "INVALID_TRUSTED_READ_PURPOSE",
    );
  }
  const signal = options?.signal;
  const abortError = () => commandError(
    "Trusted app-database read was aborted.",
    "Retry the runtime-owned trusted policy if cancellation was not intended.",
    "TRUSTED_READ_ABORTED",
  );
  if (signal?.aborted) throw abortError();
  const transactionDatabase = createTransactionDatabase(database, options.transaction);
  let active = true;
  const assertActive = () => {
    if (!active) {
      throw commandError(
        "Trusted app-database read access is no longer active.",
        "Start a new runtime-owned trusted policy callback before reading app data.",
        "TRUSTED_READ_ACCESS_INACTIVE",
      );
    }
    if (signal?.aborted) throw abortError();
  };
  const context: LooseRecord = {
    subject: options.subject,
    purpose: options.purpose,
    signal,
  };
  grantPrivilegedDbAccess(context);
  const holder = createContextHolder(context);
  const db = createEndpointReadOnlyDatabaseApi(transactionDatabase, () => holder.current, assertActive);
  try {
    try {
      const result = await callback(db, assertActive);
      assertActive();
      return result;
    } catch {
      if (signal?.aborted) throw abortError();
      throw commandError(
        "Trusted app-database read failed.",
        "The runtime-owned trusted policy could not be evaluated.",
        "TRUSTED_READ_FAILED",
      );
    }
  } finally {
    active = false;
    revokePrivilegedDbAccess(context);
  }
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
    insertOrIgnore(values: LooseRecord, ...conflictFields: string[]) {
      if (
        conflictFields.length === 0 ||
        !table.uniqueConstraints?.some(
          (constraint: string[]) =>
            constraint.length === conflictFields.length && constraint.every((field, index) => field === conflictFields[index]),
        )
      ) {
        throw new Error(`insertOrIgnore requires an exactly matching declared unique constraint on ${table.name}.`);
      }
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
          const result = database.adapter.insertAppRowOrIgnore(
            table,
            Object.fromEntries(columns.map((column) => [column, row[column]])),
            conflictFields,
          );
          return thenIfPromise(result, (writeResult: { changes: number; }) => {
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
            const result = database.adapter.updateAppRow(table, id, serializedValues);
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
      const selected = database.adapter.selectAppRowById(table, id);
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
          const result = database.adapter.deleteAppRow(table, id);
          database.rowCache.clear();
          return thenIfPromise(result, (writeResult: { changes: number; }) => writeResult.changes > 0);
        });
      };
      const operation = thenIfPromise(database.adapter.selectAppRowById(table, id), finish);
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
      const selected = database.adapter.selectAppRows(table, {
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
      const selected = database.adapter.selectAppRows(table, {
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

function referenceExists(database: LooseRecord, field: any, value: any) {
  return database.adapter.referenceExists(field, value);
}

// `serializeFieldValue`, `normalizeDateValue`, `toSqlNumber` and `dateValueError` stood here until
// batch 9 moved them to `stored-value-coding.ts`, beside the reading half they mirror.
// `invalidReferenceError` stood above `referenceExists` and is in `runtime-errors.js` now. The
// first two are imported back at the top of this file; the other three have no consumer here.

async function readEndpointPayload(request: any, headers: { [x: string]: any; }, limitSource: LooseRecord | number | null = null, parseJsonBody = true) {
  const raw = await readLimitedRequestBody(request, limitSource);
  const bodyBytes = immutableEndpointBodyBytes(raw);
  if (raw.byteLength === 0) return { body: null, bodyBytes };
  if (!parseJsonBody) return { body: null, bodyBytes };
  const text = raw.toString("utf8");
  if ((headers["content-type"] ?? "").toLowerCase().includes("application/json")) {
    try {
      return { body: JSON.parse(text), bodyBytes };
    } catch {
      throw commandError("Invalid JSON request body.", "Send a valid JSON request body.", "INVALID_JSON_REQUEST");
    }
  }
  return { body: text, bodyBytes };
}

function immutableEndpointBodyBytes(bytes: Uint8Array) {
  return Object.freeze({
    byteLength: bytes.byteLength,
    length: bytes.byteLength,
    at(index: number) {
      return bytes.at(index);
    },
    toUint8Array() {
      return Uint8Array.from(bytes);
    },
    [Symbol.iterator]() {
      return bytes.values();
    },
  });
}

function createEndpointLogger(database: any, context = {}) {
  return createRuntimeLogger(database, {
    category: "app",
    event: "ctx.log",
    ...context,
  });
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

// The internal log-index guard used to be four functions here — `targetsInternalLogIndexTable`,
// `readSqlTableReference`, `readSqlIdentifier` and `isInternalLogIndexMetadataRow`. It is
// `./log-index-guard.js` now, and `runReadOnlyInspectionQuery` above calls it through the import at
// the top of this file. ADR-0038 is why it is a module beside the inspection gate rather than part
// of it, and that module's header states the reasoning.

export function normalizeJourneyPolicy(value: any) {
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

export function normalizeJourneyState(value: any, defaultTtlSeconds: number) {
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

export async function runClientAccessKeyOperation(database: LooseRecord, auth: LooseRecord, message: LooseRecord, sessionToken?: string | null) {
  const context = { kind: "message", auth, credential: { kind: "session" } };
  bindAccessKeyOwnerSession(context, sessionToken);
  const accessKeys = createCurrentUserAccessKeysApi(database, () => context);
  const operation = message.type.slice("accessKeys.".length);
  try {
    const data = operation === "list"
      ? await accessKeys.list(message.options)
      : operation === "issue"
        ? await accessKeys.issue(message.input)
        : operation === "rotate"
          ? await accessKeys.rotate(message.accessKeyId, message.options)
          : operation === "revoke"
            ? await accessKeys.revoke(message.accessKeyId)
            : await accessKeys.delete(message.accessKeyId);
    return { data, error: null };
  } catch (error: any) {
    if (error?.sporadesAuthDenialLogData) emitAuthDeniedLog(database, { data: error.sporadesAuthDenialLogData });
    const publicError = publicAccessKeyManagementError(error);
    if (publicError) return { data: null, error: publicError };
    try {
      await database.log?.emit?.({
        category: "platform",
        event: "access-key.management.failed",
        level: "error",
        message: "Access-key browser management failed internally.",
        data: { operation: `accessKeys.${operation}`, outcome: "failed" },
      });
    } catch { }
    return {
      data: null,
      error: {
        message: "Could not manage Access keys.",
        hint: "Retry the Access-key operation.",
      },
    };
  }
}

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

      const origin = resolveOAuthRequestOrigin(policy, request);
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
    const previousAuth = client.session.auth;
    const resolvedSession = await resolveAnonymousSession(database, messageSessionToken ?? null);
    if (previousAuth.userId && (
      previousAuth.userId !== resolvedSession.auth.userId ||
      previousAuth.provider !== resolvedSession.auth.provider ||
      Boolean(previousAuth.isAuthenticated) !== Boolean(resolvedSession.auth.isAuthenticated)
    )) retireJourney(client);
    client.session = resolvedSession;
    if (message.type === "auth.get") {
      await sendAuthResult(client, message.id ?? null);
      return;
    }

    if (["accessKeys.list", "accessKeys.issue", "accessKeys.rotate", "accessKeys.revoke", "accessKeys.delete"].includes(message.type)) {
      const result = await runClientAccessKeyOperation(database, client.session.auth, message, client.session.token);
      sendJson(client, {
        id: message.id ?? null,
        type: result.error ? "error" : `${message.type}.result`,
        data: result.data,
        error: result.error,
      });
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

    if (message.type === "auth.setPassword") {
      const result: any = await setOwnEmailPassword(
        database,
        client.session,
        message.email ?? "",
        message.currentPassword ?? "",
        message.newPassword ?? "",
      );
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
      const result: any = await sendEmailPasswordResetLink(database, client.session, message.email ?? "");
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
      const result: any = await verifyPasswordResetCode(database, client.session, message.code ?? "");
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
      const result: any = await confirmPasswordReset(database, client.session, message.code ?? "", message.newPassword ?? "");
      sendJson(client, {
        id: message.id ?? null,
        type: result.ok ? "auth.confirmPasswordReset.result" : "error",
        data: result.ok ? { ok: true } : null,
        error: result.error ?? null,
      });
      return;
    }

    if (message.type === "auth.signUp") {
      const result: any = await signUpWithEmail(database, client.session, message.provider, message.credentials ?? {}, message.registration?.admission);
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

    if (message.type === "auth.reauthenticate") {
      const purpose = message.purpose; const policy = database.reauthenticationPolicy?.[purpose]; const normalized = normalizeEmailCredentials(message.credentials ?? {});
      let ok = false; let expiresAt: string | null = null;
      const authorized = Boolean(policy && client.session.auth?.isAuthenticated && !client.session.auth?.isGuest);
      const emailProviderEnabled = database.authConfig.providers.email?.enabled === true;
      if (authorized && message.provider === "email" && emailProviderEnabled && normalized.ok && typeof normalized.password === "string") {
        const reauthenticationThrottleKeys = [
          `email:${createHash("sha256").update(normalized.email).digest("base64url")}`,
          `session:${createHash("sha256").update(client.session.token).digest("base64url")}`,
        ];
        const throttleNow = database.clock.now();
        let reserved = false;
        try {
          reserved = await database.adapter.withTransaction((tx: LooseRecord) => tx.reserveEmailReauthenticationAttempt({ keys: reauthenticationThrottleKeys, now: throttleNow.toISOString(), resetAt: new Date(throttleNow.getTime() + EMAIL_SIGN_IN_THROTTLE_WINDOW_MS).toISOString(), limit: EMAIL_SIGN_IN_FAILURE_LIMIT, maxEntries: EMAIL_SIGN_IN_THROTTLE_MAX_ENTRIES }));
        } catch {
          try { await database.log?.emit?.({ category: "platform", event: "auth.reauthentication.throttle_failed", level: "error", message: "Reauthentication attempt reservation failed.", data: { provider: "email", purpose } }); } catch {}
        }
        if (reserved) {
          const now = database.clock.now(); expiresAt = new Date(now.getTime() + policy.maxAgeSeconds * 1000).toISOString();
          try {
            await database.adapter.withTransaction(async (tx: LooseRecord) => {
              const current = await tx.readAuthSessionWithUser(client.session.token);
              const credential = await tx.findEmailCredentialWithUser(normalized.email);
              if (!current || current.token !== client.session.token || current.userId !== client.session.auth.userId || !current.isAuthenticated || current.isGuest || Date.parse(current.expiresAt) <= now.getTime() || credential?.userId !== current.userId || !verifyEmailPassword(normalized.password, credential.passwordSalt, credential.passwordHash)) return;
              const currentAuth = { userId: current.userId, displayName: current.displayName, email: current.email, picture: current.picture, isAuthenticated: Boolean(current.isAuthenticated), isGuest: Boolean(current.isGuest), provider: current.provider };
              if (!await tx.claimEmailCredentialVersion(normalized.email, credential.passwordHash, credential.passwordSalt)) return;
              if (!await database.authorizeReauthentication(tx, currentAuth, purpose)) return;
              await tx.replaceReauthenticationProof({ id: randomUUID(), userId: current.userId, sessionToken: current.token, purpose, createdAt: now.toISOString(), expiresAt }); ok = true;
              await tx.clearEmailReauthenticationAttempts(reauthenticationThrottleKeys);
            });
          } catch {
            try { await database.log?.emit?.({ category: "platform", event: "auth.reauthentication.authorization_failed", level: "error", message: "Reauthentication authorization policy failed.", data: { provider: "email", purpose } }); } catch {}
            ok = false;
          }
        }
      }
      if (!ok && authorized && message.provider !== "email" && oauthProviderAdapter(database, message.provider)?.enabled) {
        const started: any = await beginOAuthSignIn(database, client.session, message.provider, { origin: client.origin, returnTo: message.returnTo, reauthentication: { purpose, userId: client.session.auth.userId } });
        if (started.ok) { sendJson(client, { id: message.id ?? null, type: "auth.redirect", data: { url: started.url }, error: null }); return; }
      }
      sendJson(client, { id: message.id ?? null, type: ok ? "auth.reauthenticate.result" : "error", data: ok ? { ok: true, purpose, expiresAt } : null, error: ok ? null : { code: "REAUTHENTICATION_FAILED", message: "Reauthentication failed.", hint: "Verify the current linked identity and retry." } }); return;
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
      const result: any = await beginOAuthSignIn(database, client.session, provider, {
        origin: client.origin,
        returnTo: message.returnTo,
        registration: message.registration,
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
      } catch {
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
      database.__notifyJobStateQueries = refreshQueries;
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

    if (message.type === "teams.list") {
      try {
        const data = await listCurrentUserTeams(database, client.session.auth);
        sendJson(client, { id: message.id ?? null, type: "teams.list.result", data, error: null });
      } catch (error: any) {
        if (error?.sporadesAuthDenialLogData) emitAuthDeniedLog(database, { data: error.sporadesAuthDenialLogData });
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

    if (message.type === "teamBilling.get") {
      try {
        const data = await readCurrentUserTeamBilling(database, client.session.auth, message.teamId);
        sendJson(client, { id: message.id ?? null, type: "teamBilling.get.result", data, error: null });
      } catch (error: any) {
        sendJson(client, {
          id: message.id ?? null,
          type: "error",
          data: null,
          error: {
            code: "TEAM_BILLING_DENIED",
            message: "Team Billing is unavailable.",
            hint: "Sign in as the current policy-approved billing administrator for this Team and retry.",
          },
        });
      }
      return;
    }

    if (message.type === "teamBilling.startCheckout") {
      try {
        const input = message.input;
        const data = await startTeamBillingCheckout(database, client.session.auth, input?.teamId, input?.requestId, input?.productKey);
        sendJson(client, { id: message.id ?? null, type: "teamBilling.startCheckout.result", data, error: null });
      } catch (error: any) {
        sendJson(client, {
          id: message.id ?? null,
          type: "error",
          data: null,
          error: {
            code: ["TEAM_BILLING_REQUEST_CONFLICT", "TEAM_BILLING_CHECKOUT_ACTIVE", "TEAM_BILLING_CHECKOUT_UNAVAILABLE"].includes(error?.code)
              ? error.code : "TEAM_BILLING_DENIED",
            message: error?.code === "TEAM_BILLING_REQUEST_CONFLICT"
              ? "Team Checkout request conflicts with existing work."
              : error?.code === "TEAM_BILLING_CHECKOUT_ACTIVE" ? "A Team Checkout is already active." : "Team Checkout is unavailable.",
            hint: error?.code === "TEAM_BILLING_REQUEST_CONFLICT"
              ? "Use a new request identifier for a different product."
              : error?.code === "TEAM_BILLING_CHECKOUT_ACTIVE"
                ? "Finish, abandon, or allow the current Team Checkout to expire before starting another."
                : "Sign in as the current policy-approved billing administrator and retry.",
          },
        });
      }
      return;
    }

    if (message.type === "teamBilling.openPortal") {
      try {
        const input = message.input;
        const data = await startTeamBillingPortal(database, client.session.auth, input?.teamId, input?.requestId);
        sendJson(client, { id: message.id ?? null, type: "teamBilling.openPortal.result", data, error: null });
      } catch (error: any) {
        sendJson(client, {
          id: message.id ?? null,
          type: "error",
          data: null,
          error: {
            code: ["TEAM_BILLING_REQUEST_CONFLICT", "TEAM_BILLING_CHECKOUT_ACTIVE", "TEAM_BILLING_CHECKOUT_UNAVAILABLE"].includes(error?.code)
              ? error.code : "TEAM_BILLING_DENIED",
            message: error?.code === "TEAM_BILLING_REQUEST_CONFLICT" ? "Team billing request conflicts with existing work."
              : error?.code === "TEAM_BILLING_CHECKOUT_ACTIVE" ? "A Team billing session is already active." : "Team Customer Portal is unavailable.",
            hint: error?.code === "TEAM_BILLING_REQUEST_CONFLICT" ? "Use a new request identifier."
              : error?.code === "TEAM_BILLING_CHECKOUT_ACTIVE" ? "Finish or allow the current session to expire before starting another."
                : "Sign in as the current policy-approved billing administrator and retry.",
          },
        });
      }
      return;
    }

    if (message.type === "teamBilling.requestPlanTransition") {
      try {
        const input = message.input;
        const data = await requestTeamBillingPlanTransition(database, client.session.auth, input?.teamId, input?.requestId, input?.productKey);
        sendJson(client, { id: message.id ?? null, type: "teamBilling.requestPlanTransition.result", data, error: null });
      } catch (error: any) {
        const code = ["TEAM_BILLING_REQUEST_CONFLICT", "TEAM_BILLING_MANAGED_TRANSITION_NOT_REQUIRED", "TEAM_BILLING_PROVIDER_STATE_AMBIGUOUS"].includes(error?.code)
          ? error.code : "TEAM_BILLING_DENIED";
        sendJson(client, {
          id: message.id ?? null,
          type: "error",
          data: null,
          error: {
            code,
            message: code === "TEAM_BILLING_REQUEST_CONFLICT" ? "Team Plan request conflicts with existing work."
              : code === "TEAM_BILLING_MANAGED_TRANSITION_NOT_REQUIRED" ? "This Plan switch belongs in the configured Customer Portal."
                : code === "TEAM_BILLING_PROVIDER_STATE_AMBIGUOUS" ? "Team billing state requires attention." : "Team Plan change is unavailable.",
            hint: code === "TEAM_BILLING_MANAGED_TRANSITION_NOT_REQUIRED" ? "Open the configured Customer Portal for a compatible quantity-policy switch."
              : "Sign in as the current policy-approved billing administrator and retry with a new request identifier.",
          },
        });
      }
      return;
    }

    if (message.type === "teamBilling.prepareErasure") {
      try {
        const input = message.input;
        const data = await prepareTeamBillingErasure(database, client.session.auth, input?.teamId, input?.requestId);
        sendJson(client, { id: message.id ?? null, type: "teamBilling.prepareErasure.result", data, error: null });
      } catch (error: any) {
        sendJson(client, {
          id: message.id ?? null,
          type: "error",
          data: null,
          error: {
            code: error?.code === "TEAM_BILLING_REQUEST_CONFLICT" ? error.code : "TEAM_BILLING_ERASURE_UNAVAILABLE",
            message: "Team billing erasure is unavailable.",
            hint: "Sign in as the current policy-approved Team administrator and retry.",
          },
        });
      }
      return;
    }

    if (message.type === "teams.create") {
      try {
        const data = await createAdditionalTeam(database, client.session.auth, message.name);
        sendJson(client, { id: message.id ?? null, type: "teams.create.result", data, error: null });
      } catch (error: any) {
        if (error?.sporadesAuthDenialLogData) emitAuthDeniedLog(database, { data: error.sporadesAuthDenialLogData });
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
      } catch (error: any) {
        if (error?.sporadesAuthDenialLogData) emitAuthDeniedLog(database, { data: error.sporadesAuthDenialLogData });
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
      } catch (error: any) {
        if (error?.sporadesAuthDenialLogData) emitAuthDeniedLog(database, { data: error.sporadesAuthDenialLogData });
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
      } catch (error: any) {
        if (error?.sporadesAuthDenialLogData) emitAuthDeniedLog(database, { data: error.sporadesAuthDenialLogData });
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
      } catch (error: any) {
        sendJson(client, { id: message.id ?? null, type: "error", data: null, error: { ...(error?.code ? { code: error.code } : {}), message: error?.message ?? "Could not update Team application roles.", hint: error?.hint ?? "Sign in with a Team administrator account and retry." } });
      }
      return;
    }

    if (message.type === "teams.createJoinLink") {
      try {
        const data = await createTeamJoinLink(database, client.session.auth, message.teamId, message.email, { ttlSeconds: message.ttlSeconds });
        sendJson(client, { id: message.id ?? null, type: "teams.createJoinLink.result", data, error: null });
      } catch (error: any) {
        sendJson(client, { id: message.id ?? null, type: "error", data: null, error: { ...(error?.code ? { code: error.code } : {}), message: error?.message ?? "Could not create Join link.", hint: error?.hint ?? "Sign in with a Team administrator account and retry." } });
      }
      return;
    }

    if (message.type === "teams.listJoinLinks") {
      try {
        const data = await listTeamJoinLinks(database, client.session.auth, message.teamId);
        sendJson(client, { id: message.id ?? null, type: "teams.listJoinLinks.result", data, error: null });
      } catch (error: any) {
        sendJson(client, { id: message.id ?? null, type: "error", data: null, error: { ...(error?.code ? { code: error.code } : {}), message: error?.message ?? "Could not list Join links.", hint: error?.hint ?? "Sign in with a Team administrator account and retry." } });
      }
      return;
    }

    if (message.type === "teams.revokeJoinLink") {
      try {
        const data = await revokeTeamJoinLink(database, client.session.auth, message.teamId, message.joinLinkId);
        sendJson(client, { id: message.id ?? null, type: "teams.revokeJoinLink.result", data, error: null });
      } catch (error: any) {
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
      } catch (error: any) {
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
      } catch (error: any) {
        sendJson(client, { id: message.id ?? null, type: "error", data: null, error: { ...(error?.code ? { code: error.code } : {}), message: error?.message ?? "Could not update Team membership.", hint: error?.hint ?? "Sign in with a Team administrator account and retry." } });
      }
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
      const result = await runMutation(database, client.session.auth, mutationName, message.args ?? [], {
        sessionToken: client.session.token,
      });
      sendJson(client, formatMutationResult(message, mutationName, result));
      if (result.ok && mutationResultsWithWrites.has(result)) {
        setTimeout(refreshQueries, 0);
      }
      return;
    }

    if (message.type === "app.send") {
      const messageName = message.message ?? message.name;
      const result = await runAppMessage(database, client.session.auth, messageName, message.data, {
        sendAppMessage,
        sessionToken: client.session.token,
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
      const result: any = await runQuery(database, client.session.auth, subscription.name, subscription.args, {
        sessionToken: client.session.token,
      });
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

  function refreshQueries() {
    for (const subscribedClient of clients) {
      for (const subscription of subscribedClient.subscriptions.values()) {
        void sendQueryResult(
          subscribedClient,
          subscription,
          (error: any) => sendUnhandledMessageError(subscribedClient, JSON.stringify({ id: subscription.id }), error),
        );
      }
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
        providers: authProvidersForClient(database.authConfig, client.origin),
      },
      error: null,
    });
  }

  async function signOutSession(database: LooseRecord, client: LooseRecord) {
    try {
      await database.adapter.withTransaction((tx: LooseRecord) => tx.deleteAuthSession(client.session.token));
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



// Enqueues a runtime-owned Job under the reserved privileged actor. The direct
// insert joins the handler transaction, while dispatch uses that transaction's
// live context so the worker is not woken until commit. Outside a handler
// transaction, runtime-owned Jobs retain ordinary immediate scheduling.
async function enqueueRuntimeJob(
  database: LooseRecord,
  handlerName: string,
  payload: LooseRecord,
  idempotencyKey: string,
  retry: LooseRecord | undefined = undefined,
  deferDispatch = false,
  availableAt: string | undefined = undefined,
  persistDelayed = false,
) {
  const queueDatabase = database.__rootDatabase ?? database;
  const jobAdapter = database.adapter;
  const now = queueDatabase.clock.now().toISOString();
  const jobAvailableAt = availableAt ?? now;
  // Checkout and Portal expiry Jobs have historically remained future queued
  // rows. Only a provider-lane recovery successor opts into delayed storage so
  // the delayed-Job wake timer durably owns its post-TTL rediscovery.
  const status = persistDelayed && jobAvailableAt > now ? "delayed" : "queued";
  const payloadJson = boundedJobJson(payload, 64 * 1024, "JOB_PAYLOAD_TOO_LARGE", "Job payload");
  await jobAdapter.prepare(
    jobAdapter.dialect.sql(
      "INSERT INTO [sporades_jobs] ([id], [handler], [enqueuedByUserId], [actorUserId], [actorProvider], [payload], [status], " +
      "[availableAt], [attempts], [idempotencyKey], [createdAt], [retryJson], [attemptHistory], [scheduleName], [scheduledFor]) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, '[]', NULL, NULL)",
    ),
  ).run(
    randomUUID(),
    handlerName,
    PRIVILEGED_AUTH_USER_ID,
    PRIVILEGED_AUTH_USER_ID,
    "privileged",
    payloadJson,
    status,
    jobAvailableAt,
    idempotencyKey,
    now,
    JSON.stringify(normalizeJobRetry(retry)),
  );
  if (!deferDispatch) deferOrScheduleJobDispatch(database, queueDatabase);
}

// Runtime-owned delivery may transiently fail after the request response has returned. Keep retries
// bounded and private to this Job so Capsule Job defaults and API semantics remain unchanged.
const PASSWORD_RESET_REQUEST_RETRY = { maxAttempts: 3, delayMs: 1_000 };

// Resolves identically whether or not the email is registered: no error, count,
// or send distinguishes the two, so this cannot be used to enumerate accounts.
export async function sendEmailPasswordResetLink(
  database: LooseRecord,
  session: LooseRecord,
  email: string,
  options: LooseRecord = {},
) {
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

export async function runQuery(database: LooseRecord, auth: any, queryName: string, rawArgs: unknown = [], options: LooseRecord = {}): Promise<any> {
  let args;
  try {
    args = normalizeQueryArguments(rawArgs);
  } catch {
    return { rows: null, data: null, error: invalidQueryArgumentsError() };
  }
  const customHandler = database.queries.find((candidate: { name: any; }) => candidate.name === queryName);
  const queryHandler = customHandler ? materializeHandler(customHandler) : null;
  let context;
  try {
    context = createMutationContext(database, auth, { sessionToken: options.sessionToken });
    if (queryHandler) admitCredentialHandler(queryHandler, context, "query");
    context = await applyContextMiddleware(database, context, "query");
  } catch (error: any) {
    if (error?.sporadesAuthDenialLogData) {
      emitAuthDeniedLog(database, { data: error.sporadesAuthDenialLogData });
    }
    return {
      rows: null as any,
      error: {
        ...(error?.code ? { code: error.code } : {}),
        message: error.message,
        hint: error.hint ?? "Check the Capsule context middleware and retry the query.",
      },
    };
  }

  if (queryName === "ctx.env") {
    if (args.length > 0) return { rows: null, data: null, error: invalidQueryArgumentsError() };
    return { data: context.env, error: null };
  }

  const customResult = await runCustomQuery(database, context, queryName, args, queryHandler);
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

  if (args.length > 0) return { rows: null, data: null, error: invalidQueryArgumentsError() };

  const cacheKey = `${table.name}:${context.auth.userId}`;
  if (!database.rowCache.has(cacheKey)) {
    const columns = ["id", "createdAt", "updatedAt", ...table.fields.map((field: { name: any; }) => field.name)];
    const ownerScoped = table.fields.some((field: { name: string; }) => field.name === "ownerId");
    const rows = (await database.adapter.selectAppRows(table, {
      columns,
      ownerId: ownerScoped ? context.auth.userId : undefined,
      orderBy: { fieldName: "createdAt", direction: "desc" },
    })).map((row: any) => rowToApiValue(row, table));
    database.rowCache.set(cacheKey, rows);
  }

  const rows = await filterRowsByReadAcl(database, table, database.rowCache.get(cacheKey), context);
  return { rows, error: null };
}

async function runCustomQuery(database: LooseRecord, context: any, queryName: any, args: readonly unknown[], resolvedHandler: Function | null = null) {
  const handler = database.queries.find((candidate: { name: any; }) => candidate.name === queryName);
  if (!handler) {
    return null;
  }

  try {
    const queryHandler = resolvedHandler ?? materializeHandler(handler);
    const data = await queryHandler(context, ...args);
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
  } finally {
    const holder = context?.__sporadesContextHolder;
    if (holder?.current === context) holder.current = null;
  }
}

const QUERY_ARGUMENT_LIMIT_BYTES = 65536;

function invalidQueryArgumentsError() {
  return {
    message: "Invalid query arguments.",
    hint: "Use a JSON-compatible argument array no larger than 65536 UTF-8 bytes.",
  };
}

function normalizeQueryArguments(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error("Query arguments must be an array.");
  const snapshot = normalizeQueryArgumentValue(value, new Set<object>());
  const canonicalJson = JSON.stringify(snapshot);
  if (Buffer.byteLength(canonicalJson, "utf8") > QUERY_ARGUMENT_LIMIT_BYTES) {
    throw new Error("Query arguments are too large.");
  }
  return snapshot as readonly unknown[];
}

function normalizeQueryArgumentValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Query arguments must contain finite numbers.");
    return value;
  }
  if (typeof value !== "object") throw new Error("Query arguments must be JSON-compatible.");
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("Query arguments must not contain symbol keys.");
  if (ancestors.has(value)) throw new Error("Query arguments must not contain cycles.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertyNames(value).some((key) => key !== "length" && (!/^(0|[1-9]\\d*)$/.test(key) || Number(key) >= value.length))) {
        throw new Error("Query arguments must not contain non-index array properties.");
      }
      const copy: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error("Query arguments must not contain sparse arrays.");
        copy.push(normalizeQueryArgumentValue(value[index], ancestors));
      }
      return Object.freeze(copy);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Query arguments must contain plain objects only.");
    }
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Query arguments must not contain accessors.");
      Object.defineProperty(copy, key, {
        value: normalizeQueryArgumentValue(descriptor.value, ancestors),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
}

export async function runMutation(database: LooseRecord, auth: any, mutationName: string, args: any, options: LooseRecord = {}) {
  let context: LooseRecord | undefined;
  let result;
  const writeState = { didWrite: false };
  try {
    const declaredHandler = database.mutations.find((candidate: { name: any; }) => candidate.name === mutationName);
    const declaredMutationHandler = declaredHandler ? materializeHandler(declaredHandler) : null;
    if (readAuthRequirements(declaredMutationHandler)?.reauthentication) {
      const maintenanceNow = database.clock.now().toISOString();
      await database.adapter.withTransaction((maintenanceAdapter: LooseRecord) => maintenanceAdapter.deleteExpiredReauthenticationProofs(maintenanceNow));
    }
    const committed = await (database.adapter ?? database.adapter).withTransaction(async (transactionAdapter: any) => {
      const transactionDatabase = createTransactionDatabase(database, transactionAdapter, writeState);
      let handlerFailed = false;
      try {
        context = createMutationContext(transactionDatabase, auth, {
          sessionToken: options.sessionToken,
          serviceUserMutationAuthority,
        });
        const customHandler = transactionDatabase.mutations.find((candidate: { name: any; }) => candidate.name === mutationName);
        const mutationHandler = customHandler ? materializeHandler(customHandler) : null;
        if (mutationHandler) admitCredentialHandler(mutationHandler, context, "mutation");
        const reauthenticationPurpose = readAuthRequirements(mutationHandler)?.reauthentication;
        if (reauthenticationPurpose) {
          const consumed = typeof options.sessionToken === "string" && await transactionAdapter.consumeReauthenticationProof({ sessionToken: options.sessionToken, userId: auth.userId, purpose: reauthenticationPurpose, now: database.clock.now().toISOString() });
          if (!consumed) throw commandError("Reauthentication required.", "Verify the current Session for this purpose and retry.", "REAUTHENTICATION_REQUIRED");
        }
        context = await applyContextMiddleware(transactionDatabase, context, "mutation");

        for (const hookSource of database.mutationHooks.beforeMutation) {
          await runMutationHookAndDrainPendingAclWrites(hookSource, { name: mutationName, args, ctx: context }, context);
        }

        result = await runCustomMutation(transactionDatabase, context, mutationName, args, mutationHandler);
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
          assertMutationSecretsReturned(context, result);
        }

        return result;
      } catch (error) {
        handlerFailed = true;
        throw error;
      } finally {
        await cleanupTransactionHandler(transactionDatabase, context, handlerFailed, handlerFailed);
      }
    });
    commitPendingJobCancellationAborts(context);
    await flushAccessKeyLifecycleAuditEvents(database, context);
    flushTeamSecurityEvents(database, context);
    await dispatchPendingJobs(context);
    if (writeState.didWrite) {
      database.rowCache.clear();
      mutationResultsWithWrites.add(committed);
    }
    return committed;
  } catch (error: any) {
    dropPendingJobCancellationAborts(context);
    dropAccessKeyLifecycleAuditEvents(context);
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

async function runCustomMutation(database: LooseRecord, context: any, mutationName: any, args: any, resolvedHandler: Function | null = null): Promise<any> {
  const handler = database.mutations.find((candidate: { name: any; }) => candidate.name === mutationName);
  if (!handler) {
    return null;
  }

  const mutationHandler = resolvedHandler ?? materializeHandler(handler);
  let result;
  try {
    result = await mutationHandler(context, ...args);
  } finally {
    await drainPendingAclWrites(context);
  }
  if (result !== undefined) {
    // This inert snapshot is the single source of truth for both one-time-secret
    // reachability and the value returned across the public boundary. Never read
    // Capsule-owned getters or proxies again after this point.
    result = assertJsonCompatible(result);
  }
  return { ok: true, data: result ?? null, error: null as any };
}

export async function runAppMessage(database: LooseRecord, auth: any, messageName: any, data: any, options: LooseRecord = {}) {
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
    const messageHandler = materializeHandler(handler);
    admitCredentialHandler(messageHandler, { auth, credential: { kind: "session" } }, "message");
    const response = await (database.adapter ?? database.adapter).withTransaction(async (transactionAdapter: any) => {
      const transactionDatabase = createTransactionDatabase(database, transactionAdapter);
      let handlerFailed = false;
      try {
        context = createMessageContext(transactionDatabase, auth, options.sendAppMessage, options.sessionToken);
        context = await applyContextMiddleware(transactionDatabase, context, "message");
        const result = await messageHandler(context, data);
        if (result !== undefined) {
          assertJsonCompatible(result);
        }
        return { data: result ?? null, error: null as any };
      } catch (error) {
        handlerFailed = true;
        throw error;
      } finally {
        await cleanupTransactionHandler(transactionDatabase, context, handlerFailed);
      }
    });
    commitPendingJobCancellationAborts(context);
    await flushAccessKeyLifecycleAuditEvents(database, context);
    flushTeamSecurityEvents(database, context);
    await dispatchPendingJobs(context);
    return response;
  } catch (error: any) {
    dropPendingJobCancellationAborts(context);
    dropAccessKeyLifecycleAuditEvents(context);
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

function validateAppMessageType(type: any) {
  const value = String(type ?? "");
  const reservedPrefixes = ["app.", "auth.", "query.", "mutation.", "file.", "files.", "runtime.", "teamBilling.", "upload."];
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

function createMessageContext(database: LooseRecord, auth: any, sendAppMessage: any, sessionToken?: string | null) {
  const context = createMutationContext(database, auth, { sessionToken });
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

function createMutationContext(database: LooseRecord, auth: any, options: LooseRecord = {}) {
  auth = protectContextIdentity(contextAuthIdentity(auth));
  const credential = options.ordinaryCredential === false
    ? null
    : protectContextIdentity(options.credential ?? { kind: "session" });
  const context: LooseRecord = {
    auth,
    ...(credential ? { credential } : {}),
    env: database.serverEnv,
    payments: database.paymentsConfig,
    log: createEndpointLogger(database, credential ? {
      attribution: {
        actor: { userId: auth.userId },
        credential: credential.kind === "access-key"
          ? { kind: credential.kind, id: credential.id, name: credential.name }
          : { kind: "session" },
      },
    } : {}),
    __pendingAclWrites: [],
    __pendingMutationSecrets: [],
  };
  if (typeof options.sessionToken === "string") {
    bindAccessKeyOwnerSession(context, options.sessionToken);
  }
  const holder = createContextHolder(context);
  registerHandlerContextMapping(database, holder);
  context.db = createEndpointDatabaseApi(database, () => holder.current);
  context.privileged = createContextPrivilegedApi(database, () => holder.current);
  context.jobs = createCurrentUserJobApi(database, () => holder.current);
  context.mail = {
    enabled: database.mail.enabled,
    send(input: LooseRecord) {
      return database.mail.send(input, (event: LooseRecord) => database.log?.emit(event));
    },
  };
  context.teams = createCurrentUserTeamsApi(database, auth, () => holder.current);
  context.teamBilling = createCurrentUserTeamBillingErasureApi(
    database,
    auth,
    () => holder.current,
    (candidate) => database.__transactionActive
      ? handlerContextByDatabase.get(database)?.() === candidate
      : holder.current === candidate,
  );
  context.accessKeys = createCurrentUserAccessKeysApi(database, () => holder.current);
  context.serviceUsers = createServiceUsersApi(
    database,
    () => holder.current,
    credential?.kind === "session" && typeof options.sessionToken === "string" ? options.sessionToken : null,
    {
      mutationSurface: options.serviceUserMutationAuthority === serviceUserMutationAuthority,
      ...(options.serviceUserMutationAuthority === serviceUserMutationAuthority
        ? { trackMutationWork: (promise: Promise<any>, requiresConsumption?: boolean) => trackMutationContextWork(context, promise, requiresConsumption) }
        : {}),
    },
  );
  context.serverAuth = {
    revokeHumanSecurity(userId: string) {
      return trackMutationContextWork(context, (async () => {
      if (!database.__transactionActive || !auth?.isAuthenticated || auth?.isGuest || auth?.userKind === "service" || typeof options.sessionToken !== "string" || typeof userId !== "string" || !userId || userId === "__privileged__") {
        throw commandError("Human security transition denied.", "Use an authenticated human Session inside a Capsule mutation.", "HUMAN_SECURITY_TRANSITION_DENIED");
      }
      const actorSession = await database.adapter.prepare(database.adapter.dialect.sql(
        "SELECT [s].[token] FROM [sporades_auth_sessions] [s] JOIN [sporades_auth_users] [u] ON [u].[id] = [s].[userId] WHERE [s].[token] = ? AND [s].[userId] = ? AND [s].[expiresAt] > ? AND [u].[isAuthenticated] = 1 AND [u].[isGuest] = 0",
      )).get(options.sessionToken, auth.userId, database.clock.now().toISOString());
      if (!actorSession) throw commandError("Human security transition denied.", "Use an authenticated human Session inside a Capsule mutation.", "HUMAN_SECURITY_TRANSITION_DENIED");
      const target = await database.adapter.prepare(database.adapter.dialect.sql(
        "SELECT [u].[id] FROM [sporades_auth_users] [u] WHERE [u].[id] = ? AND [u].[isAuthenticated] = 1 AND [u].[isGuest] = 0 AND (EXISTS (SELECT 1 FROM [sporades_auth_email_credentials] [c] WHERE [c].[userId] = [u].[id]) OR EXISTS (SELECT 1 FROM [sporades_auth_identities] [i] WHERE [i].[userId] = [u].[id]))",
      )).get(userId);
      if (!target) {
        throw commandError("Human security transition denied.", "Select one existing active human user.", "HUMAN_SECURITY_TRANSITION_DENIED");
      }
      const sessions = await database.adapter.prepare(database.adapter.dialect.sql(
        "SELECT COUNT(*) AS [count] FROM [sporades_auth_sessions] WHERE [userId] = ?",
      )).get(userId);
      await database.adapter.deleteAuthSessionsForUser(userId);
      const revoked = await database.adapter.bulkRevokeAccessKeysForOwner({
        ownerUserId: userId,
        revocationTime: () => database.clock.now().toISOString(),
        revocationCause: "operator",
      });
      return { userId, revokedSessionCount: Number(sessions?.count ?? 0), revokedAccessKeyCount: Number(revoked?.records?.length ?? 0) };
      })());
    },
    async setEmailPassword(email: string, newPassword: string) {
      const result = await setEmailPassword(database, { auth }, email, newPassword);
      if (!result.ok) throw new Error(result.error?.message ?? "Could not set password.");
    },
    async sendEmailPasswordResetLink(email: string, options: LooseRecord = {}) {
      const result: any = await sendEmailPasswordResetLink(database, { auth }, email, options);
      if (!result.ok) throw serverAuthError(result.error, "Could not send the password reset link.");
    },
    async createEmailPasswordResetLink(email: string) {
      const result: any = await createEmailPasswordResetLink(database, { auth }, email);
      if (!result.ok) throw serverAuthError(result.error, "Could not create a password reset link.");
      return { link: result.link, expiresAt: result.expiresAt };
    },
    async verifyPasswordResetCode(code: string) {
      const result: any = await verifyPasswordResetCode(database, { auth }, code);
      if (!result.ok) throw serverAuthError(result.error, "Could not verify the password reset code.");
      return { email: result.email };
    },
    async confirmPasswordReset(code: string, newPassword: string) {
      const result: any = await confirmPasswordReset(database, { auth }, code, newPassword);
      if (!result.ok) throw serverAuthError(result.error, "Could not complete the password reset.");
    },
  };
  return context;
}

function createTeamJoinAdmissionContext(database: LooseRecord, auth: LooseRecord, trustedDb: LooseRecord, teamId: string, assertActive: () => void) {
  const context: LooseRecord = {
    auth: Object.freeze({ ...auth }),
    env: database.serverEnv,
    log: createEndpointLogger(database),
    db: trustedDb,
    teamBilling: Object.freeze({
      async get(requestedTeamId: unknown) {
        assertActive();
        if (requestedTeamId !== teamId) throw commandError(
          "Team Billing operation denied.",
          "Use verified Team Billing state only for the Team whose Join is being admitted.",
          "TEAM_BILLING_DENIED",
        );
        const projection = database.teamBillingDefinition
          ? await safeTeamBillingProjection(database.adapter, database.teamBillingDefinition, teamId)
          : Object.freeze({ state: "inactive" as const, teamId });
        assertActive();
        return projection;
      },
    }),
  };
  return context;
}

function createTeamBillingAuthorityContext(database: LooseRecord, auth: LooseRecord, trustedDb: LooseRecord, teamId: string, assertActive: () => void) {
  return {
    auth: Object.freeze({ ...auth }),
    env: database.serverEnv,
    log: createEndpointLogger(database),
    db: trustedDb,
    teams: Object.freeze({
      async countMembers(requestedTeamId: unknown) {
        assertActive();
        if (requestedTeamId !== teamId) throw commandError(
          "Team Billing operation denied.",
          "Count accepted members only for the Team whose billing authority is being evaluated.",
          "TEAM_BILLING_DENIED",
        );
        const totalCount = await countAcceptedTeamMembers(database.adapter, teamId, () => commandError(
          "Team Billing operation denied.",
          "Retry against the current Team state.",
          "TEAM_BILLING_DENIED",
        ));
        assertActive();
        return Object.freeze({ totalCount });
      },
    }),
  };
}

function deferOrScheduleJobDispatch(database: LooseRecord, queueDatabase: LooseRecord, context: LooseRecord | undefined = undefined) {
  const currentContext = context ?? handlerContextByDatabase.get(database)?.();
  if (database.__transactionActive && currentContext) {
    const pendingContext = currentContext.__jobParentContext ?? currentContext;
    pendingContext.__pendingJobDispatch = true;
    pendingContext.__jobQueueDatabase = queueDatabase;
    return;
  }
  scheduleCurrentUserJobWorker(queueDatabase);
}

function createCurrentUserJobApi(database: LooseRecord, contextGetter: () => LooseRecord) {
  return {
    async enqueue(handlerName: any, payload: any, options: LooseRecord = {}) {
      const context = contextGetter();
      const queueDatabase = database.__rootDatabase ?? database;
      const jobAdapter = database.adapter;
      const scheduleProvenance = queueDatabase.jobScheduleProvenanceByContext?.get(context);
      if (
        typeof handlerName === "string"
        && handlerName.toLowerCase().startsWith(RESERVED_JOB_NAME_PREFIX)
        && Reflect.get(context, runtimeOwnedJobEnqueueHandler) !== handlerName
      ) {
        throw jobError("RESERVED_JOB_NAME", "Runtime-owned Job handlers cannot be enqueued by Capsule code.", "Use a Capsule-declared Job handler name.");
      }
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
        const existing = await jobAdapter.prepare(jobAdapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [handler] = ? AND [actorUserId] = ? AND [idempotencyKey] = ?")).get(handlerName, context.auth.userId, idempotencyKey);
        if (existing) { assertJobScheduleProvenance(existing, scheduleProvenance); return jobState(existing, true); }
      }
      const id = crypto.randomUUID();
      const nowInstant = queueDatabase.clock.now();
      const now = normalizeJobAvailableAt(nowInstant);
      const availableAt = options.availableAt === undefined ? now : normalizeJobAvailableAt(options.availableAt);
      const retry = normalizeJobRetry(options.retry);
      const firstAttemptInstant = availableAt > now ? new Date(availableAt) : nowInstant;
      if (jobTimestampAfter(firstAttemptInstant, RUNTIME_CLAIM_LEASE_MS) === null && !scheduleProvenance) {
        throw jobError("INVALID_JOB_OPTIONS", "Invalid Job availability time.", "Pass an availableAt value with room for a canonical runtime claim lease.");
      }
      if (!jobRetryHorizonFits(firstAttemptInstant, retry, retry.maxAttempts, Boolean(scheduleProvenance && retry.maxAttempts === 1))) {
        throw jobError("INVALID_JOB_OPTIONS", "Invalid Job retry policy.", "Pass retry.delayMs with room for every configured attempt and its canonical runtime claim lease.");
      }
      const provenanceContext = context.__jobParentContext?.credential ? context.__jobParentContext : context;
      const authSnapshotJson = scheduleProvenance || !provenanceContext?.credential
        ? null
        : JSON.stringify(captureJobAuthSnapshot(provenanceContext.auth));
      const credentialJson = scheduleProvenance || !provenanceContext?.credential
        ? null
        : JSON.stringify(canonicalJobCredentialProvenance(provenanceContext.credential));
      const row = { id, handler: handlerName, enqueuedByUserId: context.__jobEnqueuedBy ?? context.auth.userId, actorUserId: context.auth.userId, actorProvider: jobActorProvider(context.auth), authSnapshotJson, credentialJson, payload: payloadJson, status: availableAt > now ? "delayed" : "queued", availableAt, attempts: 0, idempotencyKey: idempotencyKey ?? null, createdAt: now, retryJson: JSON.stringify(retry), attemptHistory: "[]", scheduleName: scheduleProvenance?.scheduleName ?? null, scheduledFor: scheduleProvenance?.scheduledFor ?? null };
      // Persistence belongs to the handler transaction. Only worker dispatch waits until commit, so
      // a rollback cannot leave a Job behind and a post-commit timer failure cannot undo or
      // misreport handler work that is already durable.
      try {
        const result = await jobAdapter.prepare(jobAdapter.dialect.sql(
          "INSERT INTO [sporades_jobs] ([id], [handler], [enqueuedByUserId], [actorUserId], [actorProvider], [authSnapshotJson], [credentialJson], [payload], [status], [availableAt], [attempts], [idempotencyKey], [createdAt], [retryJson], [attemptHistory], [scheduleName], [scheduledFor]) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)" +
          (idempotencyKey ? " ON CONFLICT DO NOTHING" : ""),
        )).run(id, handlerName, row.enqueuedByUserId, row.actorUserId, row.actorProvider, row.authSnapshotJson, row.credentialJson, payloadJson, row.status, availableAt, idempotencyKey ?? null, now, row.retryJson, row.attemptHistory, row.scheduleName, row.scheduledFor);
        if (idempotencyKey && Number(result?.changes ?? 0) === 0) {
          const existing = await jobAdapter.prepare(jobAdapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [handler] = ? AND [actorUserId] = ? AND [idempotencyKey] = ?")).get(handlerName, context.auth.userId, idempotencyKey);
          if (existing) { assertJobScheduleProvenance(existing, scheduleProvenance); return jobState(existing, true); }
          throw jobError("JOB_ENQUEUE_CONFLICT", "Could not resolve the existing idempotent Job.", "Retry the Job enqueue.");
        }
      } catch (error: any) {
        if (idempotencyKey) {
          const existing = await jobAdapter.prepare(jobAdapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [handler] = ? AND [actorUserId] = ? AND [idempotencyKey] = ?")).get(handlerName, context.auth.userId, idempotencyKey);
          if (existing) { assertJobScheduleProvenance(existing, scheduleProvenance); return jobState(existing, true); }
        }
        throw error;
      }
      deferOrScheduleJobDispatch(database, queueDatabase, context);
      if (database.__transactionActive) return jobState(row, true);
      return jobState(await jobAdapter.prepare(jobAdapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [id] = ?")).get(id), true);
    },
    async get(id: any) {
      const context = contextGetter();
      const jobAdapter = database.adapter;
      const row = await jobAdapter.prepare(jobAdapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [id] = ? AND [actorUserId] = ?")).get(id, context.auth.userId);
      return row ? jobState(row, true) : null;
    },
    async cancel(id: any) { return await cancelJob(database, contextGetter(), id); },
    async list(options: LooseRecord = {}) {
      const context = contextGetter();
      if (options === null || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => !["limit","cursor","status","handler","createdAfter","createdBefore"].includes(key))) throw jobError("INVALID_JOB_OPTIONS", "Invalid Job list options.", "Pass supported Job list filters only.");
      const limit = options.limit === undefined ? 50 : options.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw jobError("INVALID_JOB_OPTIONS", "Invalid Job list limit.", "Pass a whole-number limit from 1 to 100.");
      const cursor = decodeJobCursor(options.cursor);
      const jobAdapter = database.adapter;
      const sql = jobAdapter.dialect.sql;
      const clauses=["[actorUserId] = ?"]; const params:any[]=[context.auth.userId]; if(options.status){clauses.push("[status] = ?");params.push(options.status)} if(options.handler){clauses.push("[handler] = ?");params.push(options.handler)} if(options.createdAfter){clauses.push("[createdAt] >= ?");params.push(options.createdAfter)} if(options.createdBefore){clauses.push("[createdAt] <= ?");params.push(options.createdBefore)} if(cursor){clauses.push("([createdAt] > ? OR ([createdAt] = ? AND [id] > ?))");params.push(cursor.createdAt,cursor.createdAt,cursor.id)} const rows=await jobAdapter.prepare(sql(`SELECT * FROM [sporades_jobs] WHERE ${clauses.join(" AND ")} ORDER BY [createdAt] ASC, [id] ASC LIMIT ?`)).all(...params,limit+1);
      const page = rows.slice(0, limit);
      return { jobs: page.map((row: any) => jobSummary(row)), nextCursor: rows.length > limit ? encodeJobCursor(page.at(-1)) : null };
    },
  };
}

function createPrivilegedJobApi(database: LooseRecord, contextGetter: () => LooseRecord) {
  const current = createCurrentUserJobApi(database, contextGetter);
  return {
    async enqueue(handler: any, payload: any, options: any = {}) { assertActivePrivilegedJobAccess(contextGetter); return await current.enqueue(handler, payload, options); },
    async get(id: any) {
      assertActivePrivilegedJobAccess(contextGetter);
      const jobAdapter = database.adapter;
      const row = await jobAdapter.prepare(jobAdapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [id] = ?")).get(id);
      return row ? jobState(row, true) : null;
    },
    async list(options: LooseRecord = {}) {
      assertActivePrivilegedJobAccess(contextGetter);
      if (options === null || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some((key) => !["limit","cursor","status","handler","createdAfter","createdBefore"].includes(key))) throw jobError("INVALID_JOB_OPTIONS", "Invalid Job list options.", "Pass supported Job list filters only.");
      const limit = options.limit === undefined ? 50 : options.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw jobError("INVALID_JOB_OPTIONS", "Invalid Job list limit.", "Pass a whole-number limit from 1 to 100.");
      const cursor = decodeJobCursor(options.cursor);
      const sqlite = database.adapter;
      const sql = sqlite.dialect.sql;
      const clauses:string[]=[]; const params:any[]=[]; if(options.status){clauses.push("[status] = ?");params.push(options.status)} if(options.handler){clauses.push("[handler] = ?");params.push(options.handler)} if(options.createdAfter){clauses.push("[createdAt] >= ?");params.push(options.createdAfter)} if(options.createdBefore){clauses.push("[createdAt] <= ?");params.push(options.createdBefore)} if(cursor){clauses.push("([createdAt] > ? OR ([createdAt] = ? AND [id] > ?))");params.push(cursor.createdAt,cursor.createdAt,cursor.id)} const rows=await sqlite.prepare(sql(`SELECT * FROM [sporades_jobs]${clauses.length?` WHERE ${clauses.join(" AND ")}`:""} ORDER BY [createdAt] ASC, [id] ASC LIMIT ?`)).all(...params,limit+1);
      const page = rows.slice(0, limit);
      return { jobs: page.map((row: any) => jobSummary(row)), nextCursor: rows.length > limit ? encodeJobCursor(page.at(-1)) : null };
    },
    async cancel(id: any) {
      const context = contextGetter();
      assertActivePrivilegedJobAccess(() => context);
      return await cancelJob(database, Object.assign(Object.create(context), { __privilegedJobAccess: true }), id);
    },
  };
}
async function dispatchPendingJobs(context: LooseRecord | undefined) {
  if (!context?.__pendingJobDispatch || context.__pendingJobsFlushed) return false;
  context.__pendingJobsFlushed = true;
  const queueDatabase = context.__jobQueueDatabase;
  context.__pendingJobDispatch = false;
  try { scheduleCurrentUserJobWorker(queueDatabase); } catch {}
  return false;
}

function dropPendingJobDispatch(context: LooseRecord | undefined) {
  if (!context) return;
  context.__pendingJobDispatch = false;
  context.__pendingJobsFlushed = true;
  delete context.__jobQueueDatabase;
}

function stopCurrentUserJobWorker(database: LooseRecord) {
  database.__jobStopped = true;
  database.__jobWorkerRerunRequested = false;
  if (database.__jobWorkerTimer) { database.clock.clearTimer(database.__jobWorkerTimer); database.__jobWorkerTimer = null; }
  database.__jobWorkerScheduled = false;
  if (database.__jobWakeTimer) { database.clock.clearTimer(database.__jobWakeTimer); database.__jobWakeTimer = null; }
  if (database.__jobLeaseRecoveryTimer) { database.clock.clearTimer(database.__jobLeaseRecoveryTimer); database.__jobLeaseRecoveryTimer = null; }
  database.__jobLeaseRecoveryDueAt = null;
  database.__jobLeaseRecoveryRequestedAt = null;
  for (const activeClaim of database.__jobAbortControllers?.values?.() ?? []) (activeClaim?.controller ?? activeClaim)?.abort?.();
  const payloadCleanupSettlement = stopStripeEventPayloadCleanup(database);
  const settlements = [database.__jobWorkerPromise, database.__jobLeaseRecoveryPromise, payloadCleanupSettlement]
    .filter(Boolean)
    .map((pending) => Promise.resolve(pending));
  if (settlements.length === 0) return undefined;
  if (settlements.length === 1) return settlements[0];
  return Promise.all(settlements).then(() => undefined);
}

function scheduleCurrentUserJobWorker(database: LooseRecord, propagateSchedulingFailure = false) {
  if (database.__jobStopped) return;
  if (database.__jobWorkerRunning) {
    // A transaction may commit after the active worker's final queue read but
    // before that worker relinquishes ownership. Remember the dispatch so the
    // worker cannot clear its running state without arranging another scan.
    database.__jobWorkerRerunRequested = true;
    return;
  }
  if (database.__jobWorkerScheduled) return;
  database.__jobWorkerScheduled = true;
  try {
    database.__jobWorkerTimer = database.clock.setTimer(async () => {
      database.__jobWorkerTimer = null;
      database.__jobWorkerScheduled = false;
      if (database.__jobStopped) return;
      const worker = runCurrentUserJobWorker(database);
      database.__jobWorkerPromise = worker;
      try { await worker; }
      finally { if (database.__jobWorkerPromise === worker) database.__jobWorkerPromise = null; }
    }, 0);
  } catch (error) {
    database.__jobWorkerScheduled = false;
    database.__jobWorkerTimer = null;
    if (propagateSchedulingFailure) throw error;
  }
}

function scheduleJobWorkerWake(database: LooseRecord, delayMs: number) {
  if (database.__jobStopped) return;
  if (database.__jobWakeTimer) database.clock.clearTimer(database.__jobWakeTimer);
  database.__jobWakeTimer = database.clock.setTimer(() => {
    database.__jobWakeTimer = null;
    scheduleCurrentUserJobWorker(database);
  }, Math.min(MAX_NATIVE_TIMER_DELAY_MS, Math.max(0, delayMs)));
}

async function relinquishUnstartedJobClaim(database: LooseRecord, jobId: string, claimToken: string) {
  const sql = database.adapter.dialect.sql;
  await database.adapter.prepare(sql(
    "UPDATE [sporades_jobs] SET " +
    "[status] = CASE WHEN [cancelRequestedAt] IS NULL THEN 'queued' ELSE 'cancelled' END, " +
    "[attempts] = CASE WHEN [attempts] > 0 THEN [attempts] - 1 ELSE 0 END, " +
    "[startedAt] = NULL, [leaseExpiresAt] = NULL, [claimToken] = NULL, " +
    "[completedAt] = CASE WHEN [cancelRequestedAt] IS NULL THEN [completedAt] ELSE [cancelRequestedAt] END " +
    "WHERE [id] = ? AND [status] = 'running' AND [claimToken] = ?",
  )).run(jobId, claimToken);
}

async function deferAtomicStripeFenceContention(database: LooseRecord, jobId: string, claimToken: string) {
  const sql = database.adapter.dialect.sql;
  const claimed = await database.adapter.prepare(sql(
    "SELECT [cancelRequestedAt] FROM [sporades_jobs] WHERE [id]=? AND [status]='running' AND [claimToken]=?",
  )).get(jobId, claimToken);
  if (!claimed) return "lost";
  if (claimed.cancelRequestedAt) return "cancelled";
  const availableAt = jobTimestampAfter(database.clock.now(), 25);
  if (availableAt === null) return "lost";
  const changed = await database.adapter.prepare(sql(
    "UPDATE [sporades_jobs] SET [status]='delayed', [availableAt]=?, " +
    "[attempts]=CASE WHEN [attempts] > 0 THEN [attempts] - 1 ELSE 0 END, " +
    "[startedAt]=NULL, [leaseExpiresAt]=NULL, [claimToken]=NULL " +
    "WHERE [id]=? AND [status]='running' AND [claimToken]=? AND [cancelRequestedAt] IS NULL",
  )).run(availableAt, jobId, claimToken);
  if (Number(changed?.changes ?? 0) !== 1) {
    const currentClaim = await database.adapter.prepare(sql(
      "SELECT [cancelRequestedAt] FROM [sporades_jobs] WHERE [id]=? AND [status]='running' AND [claimToken]=?",
    )).get(jobId, claimToken);
    if (currentClaim?.cancelRequestedAt) return "cancelled";
    return "lost";
  }
  scheduleJobWorkerWake(database, 26);
  return "deferred";
}

async function scheduleNextDelayedJob(database: LooseRecord) {
  while (true) {
    const row = await database.adapter.prepare(database.adapter.dialect.sql("SELECT * FROM [sporades_jobs] WHERE [status]='delayed' ORDER BY [availableAt] ASC, [id] ASC LIMIT 1")).get();
    if (!row) return;
    const failure = invalidStoredJobFailure(row, database.clock.now());
    if (failure) {
      await failInvalidQueuedJob(database, row, failure);
      continue;
    }
    scheduleJobWorkerWake(database, Math.max(0, Date.parse(row.availableAt) - database.clock.now().getTime()) + 1);
    return;
  }
}

export async function runCurrentUserJobWorker(database: LooseRecord) {
  if (database.__jobStopped || database.__jobWorkerRunning) return;
  database.__jobWorkerRunning = true;
  const sql = database.adapter.dialect.sql;
  try {
    while (true) {
      if (database.__jobStopped) return;
      const workerNow = database.clock.now();
      const workerNowIso = workerNow.toISOString();
      await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status]='queued' WHERE [status]='delayed' AND [availableAt] <= ?")).run(workerNowIso);
      if (database.__jobStopped) return;
      const row = await database.adapter.prepare(sql("SELECT * FROM [sporades_jobs] WHERE [status] = 'queued' AND [availableAt] <= ? ORDER BY [availableAt] ASC, [id] ASC LIMIT 1")).get(workerNowIso);
      if (database.__jobStopped) return;
      if (!row) { await scheduleNextDelayedJob(database); return; }
      const storedFailure = invalidStoredJobFailure(row, workerNow);
      if (storedFailure) {
        await failInvalidQueuedJob(database, row, storedFailure);
        continue;
      }
      const startedAt = workerNowIso;
      // A Job created by the final representable Schedule occurrence may have
      // less than one full lease remaining. It gets the same canonical domain
      // clamp as its occurrence claim; ordinary Jobs still require full
      // headroom at enqueue and claim time.
      const fullLeaseExpiresAt = jobTimestampAfter(workerNow, RUNTIME_CLAIM_LEASE_MS);
      const storedRetry = parsePersistedJobRetry(row.retryJson);
      const leaseExpiresAt = fullLeaseExpiresAt ?? (row.scheduleName && row.scheduledFor && storedRetry?.maxAttempts === 1 && isCanonicalJobTimestamp(workerNowIso)
        ? new Date(MAX_JOB_TIMESTAMP_MS).toISOString()
        : null);
      if (leaseExpiresAt === null) {
        await failInvalidQueuedJob(database, row, { code: "JOB_AVAILABLE_AT_INVALID", message: "The Job cannot acquire a canonical claim lease." });
        continue;
      }
      const claimToken = randomUUID();
      const claimed = await database.adapter.prepare(sql(
        "UPDATE [sporades_jobs] SET [status] = 'running', [attempts] = [attempts] + 1, [startedAt] = ?, [leaseExpiresAt] = ?, [claimToken] = ? " +
        "WHERE [id] = ? AND [status] = 'queued' AND [availableAt] = ? AND COALESCE([retryJson], '') = COALESCE(?, '')",
      )).run(startedAt, leaseExpiresAt, claimToken, row.id, row.availableAt, row.retryJson);
      if (!claimed?.changes) continue;
      if (database.__jobStopped) {
        // Shutdown can begin while the asynchronous claim statement is in
        // flight. The Job has not reached its handler boundary yet, so return
        // the claim without consuming an attempt. A cancellation that raced
        // the claim remains terminal instead of being resurrected as queued.
        await relinquishUnstartedJobClaim(database, row.id, claimToken);
        return;
      }
      const handler = database.jobs?.find((candidate: any) => candidate.name === row.handler);
      database.__jobAbortControllers ??= new Map(); const abortController = new AbortController(); database.__jobAbortControllers.set(row.id, { claimToken, controller: abortController });
      let handlerStarted = false;
      try {
        const jobPayload = JSON.parse(row.payload);
        // Cancellation may commit after the durable claim but before its
        // in-memory controller is registered. Reconcile the exact owned claim
        // before crossing the handler boundary so that window cannot lose the
        // abort signal or affect a newer attempt.
        const claimedState = await database.adapter.prepare(sql(
          "SELECT [cancelRequestedAt] FROM [sporades_jobs] WHERE [id]=? AND [status]='running' AND [claimToken]=?",
        )).get(row.id, claimToken);
        if (!claimedState) continue;
        if (database.__jobStopped) {
          await relinquishUnstartedJobClaim(database, row.id, claimToken);
          return;
        }
        if (claimedState?.cancelRequestedAt) abortController.abort();
        if (!handler) throw jobError("UNKNOWN_JOB_HANDLER", "Job handler is no longer declared.", "Restore the handler or inspect the retained Job state.");
        let result;
        if (row.actorUserId === privilegedAuthUserId()) {
          const context = createMutationContext(database, { userId: row.enqueuedByUserId, displayName: "Job enqueuer", email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "job" }, { ordinaryCredential: false });
          result = await context.privileged.run({ operation: "jobs.execute", targetResourceKind: "job-queue", signal: abortController.signal, metadata: { jobId: row.id, handler: row.handler, attempt: Number(row.attempts) + 1, ...(row.scheduleName ? { scheduleName: String(row.scheduleName), scheduledFor: String(row.scheduledFor) } : {}) } }, async (privilegedCtx: any) => {
            handlerStarted = true;
            database.__runtimeJobAttempts.set(privilegedCtx, Number(row.attempts) + 1);
            try { return await handler.handler(privilegedCtx, jobPayload); }
            finally { database.__runtimeJobAttempts.delete(privilegedCtx); }
          });
        } else {
          const auth = readJobAuthSnapshot(row);
          const credential = readJobCredentialProvenance(row);
          if (database.__jobStopped) {
            await relinquishUnstartedJobClaim(database, row.id, claimToken);
            return;
          }
          const context = createMutationContext(database, auth, { credential }); context.signal = abortController.signal;
          handlerStarted = true;
          database.__runtimeJobAttempts.set(context, Number(row.attempts) + 1);
          try { result = await handler.handler(context, jobPayload); }
          finally { database.__runtimeJobAttempts.delete(context); }
        }
        const resultJson = boundedJobJson(result ?? null, 64 * 1024, "JOB_RESULT_TOO_LARGE", "Job result");
        const completedAt = database.clock.now().toISOString();
        const history = JSON.parse(row.attemptHistory || "[]");
        history.push({ attempt: Number(row.attempts) + 1, startedAt, outcome: "succeeded", completedAt });
        const payloadRetentionUntil = row.handler === STRIPE_EVENT_JOB
          ? stripeEventPayloadRetentionStorageValue(completedAt)
          : null;
        const settled = row.handler === STRIPE_EVENT_JOB
          ? await database.adapter.prepare(sql(
            "UPDATE [sporades_jobs] SET [status] = 'succeeded', [result] = ?, [completedAt] = ?, [leaseExpiresAt] = NULL, [claimToken] = NULL, [attemptHistory] = ?, [payloadRetentionUntil] = ? " +
            "WHERE [id] = ? AND [status] = 'running' AND [claimToken] = ?",
          )).run(resultJson, completedAt, JSON.stringify(history), payloadRetentionUntil, row.id, claimToken)
          : await database.adapter.prepare(sql(
            "UPDATE [sporades_jobs] SET [status] = 'succeeded', [result] = ?, [completedAt] = ?, [leaseExpiresAt] = NULL, [claimToken] = NULL, [attemptHistory] = ? " +
            "WHERE [id] = ? AND [status] = 'running' AND [claimToken] = ?",
          )).run(resultJson, completedAt, JSON.stringify(history), row.id, claimToken);
        if (row.handler === STRIPE_EVENT_JOB && Number(settled?.changes ?? 0) === 1 && typeof payloadRetentionUntil === "string" && isCanonicalJobTimestamp(payloadRetentionUntil)) {
          scheduleStripeEventPayloadCleanup(database, Date.parse(payloadRetentionUntil));
        }
      } catch (error: any) {
        if (database.__jobStopped && !handlerStarted) {
          await relinquishUnstartedJobClaim(database, row.id, claimToken);
          return;
        }
        const runtimeError = error?.cause ?? error;
        if (row.handler === STRIPE_EVENT_JOB && runtimeError?.[atomicStripeFenceContention] === true) {
          const contention = await deferAtomicStripeFenceContention(database, row.id, claimToken);
          if (contention === "deferred") continue;
          if (contention === "cancelled") {
            abortController.abort();
            error = atomicStripeAbortError();
          }
        }
        const handlerFailure = safeJobFailure(error);
        const permanentFailure = error?.retryable === false && handlerFailure.code !== "JOB_FAILED";
        const failedAt = database.clock.now().toISOString();
        const history = JSON.parse(row.attemptHistory || "[]");
        const retry = parsePersistedJobRetry(row.retryJson);
        const abortError = error?.cause ?? error;
        const abortShaped = abortController.signal.aborted && (abortError?.name === "AbortError" || abortError?.code === "ABORT_ERR");
        const cancellation = abortShaped
          ? await database.adapter.prepare(sql(
            "SELECT [cancelRequestedAt] FROM [sporades_jobs] WHERE [id]=? AND [status]='running' AND [claimToken]=?",
          )).get(row.id, claimToken)
          : null;
        const cancelled = Boolean(cancellation?.cancelRequestedAt);
        const retryEligible = !cancelled && !permanentFailure && handlerFailure.code !== "JOB_ACTOR_UNAVAILABLE"
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
          await database.adapter.prepare(sql(
            "UPDATE [sporades_jobs] SET [status]='cancelled', [failure]=?, [failedAt]=?, [leaseExpiresAt]=NULL, [claimToken]=NULL, [attemptHistory]=? " +
            "WHERE [id]=? AND [status]='running' AND [claimToken]=?",
          )).run(JSON.stringify(failure), failedAt, JSON.stringify(history), row.id, claimToken);
        } else if (retryAvailableAt !== null) {
          const changed = await database.adapter.prepare(sql(
            "UPDATE [sporades_jobs] SET [status]='delayed', [availableAt]=?, [leaseExpiresAt]=NULL, [claimToken]=NULL, [attemptHistory]=? " +
            "WHERE [id]=? AND [status]='running' AND [claimToken]=?",
          )).run(retryAvailableAt, JSON.stringify(history), row.id, claimToken);
          if (Number(changed?.changes ?? 0) === 1) scheduleJobWorkerWake(database, retry!.delayMs + 1);
        } else {
          await database.adapter.prepare(sql(
            "UPDATE [sporades_jobs] SET [status] = 'failed', [failure] = ?, [failedAt] = ?, [leaseExpiresAt]=NULL, [claimToken]=NULL, [attemptHistory]=? " +
            "WHERE [id] = ? AND [status]='running' AND [claimToken]=?",
          )).run(boundedJobJson(failure, 8 * 1024, "JOB_FAILURE_TOO_LARGE", "Job failure metadata"), failedAt, JSON.stringify(history), row.id, claimToken);
        }
      } finally {
        const activeClaim = database.__jobAbortControllers?.get(row.id);
        if (activeClaim?.claimToken === claimToken) database.__jobAbortControllers.delete(row.id);
        database.__notifyJobStateQueries?.();
      }
    }
  } finally {
    database.__jobWorkerRunning = false;
    const rerunRequested = database.__jobWorkerRerunRequested === true;
    database.__jobWorkerRerunRequested = false;
    if (rerunRequested && !database.__jobStopped) scheduleCurrentUserJobWorker(database);
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
    await database.adapter.insertAppRow(table, values);
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
    (await database.adapter.selectAppRows(resolved.table, {
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
    await database.adapter.updateAppRow(
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
