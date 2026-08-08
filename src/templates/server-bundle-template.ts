import { isBuiltin } from "node:module";
import path from "node:path";

import { buildSync } from "esbuild";

import * as authRuntime from "../auth-runtime.js";
import * as fileStorageRuntime from "../file-storage-runtime.js";
import * as inspectionSql from "../inspection-sql.js";
import * as jobsRuntime from "../jobs-runtime.js";
import * as logIndexGuard from "../log-index-guard.js";
import * as mailConfig from "../mail-config.js";
import * as mailRuntime from "../mail-runtime.js";
import * as maybePromise from "../maybe-promise.js";
import { resolveSporadesPackageRoot } from "../package-root.js";
import * as runtimeErrors from "../runtime-errors.js";
import * as runtimeLogPolicy from "../runtime-log-policy.js";
import * as storedRowDecoding from "../stored-row-decoding.js";
import * as userPreferencesRuntime from "../user-preferences-runtime.js";
import {
  ACL_HELPER_STATE,
  PRIVILEGED_AUDIT_ACTOR_KINDS,
  PRIVILEGED_AUDIT_OUTCOMES,
  PRIVILEGED_AUDIT_SCHEMA,
  SERVER_RUNTIME_SOURCE_FUNCTIONS,
} from "../server-runtime-source.js";
import { PUBLIC_TREE_LIMITS, normalizePublicTreePath, publicTreePathFromRequest } from "../public-tree-contract.js";

// How a runtime module constant is written into the bundle preamble. Values travel as their own
// serialization so the runtime source's declaration stays the only place the value is written.
// A `Symbol` has no serialization, so it is reconstructed from its description: the result is a
// different Symbol than the runtime module's, which is safe for the one Symbol here because the
// bundle's only writer and only reader of that key both resolve the name to the preamble's own
// declaration, and the objects it keys never cross between a bundled Capsule and this process.
function serializeRuntimeConstant(value: unknown): string {
  if (typeof value === "symbol") return `Symbol(${JSON.stringify(value.description)})`;
  if (value instanceof Set) return `new Set(${JSON.stringify([...value])})`;
  return JSON.stringify(value);
}

const MIGRATED_MODULES_NAMESPACE = "__sporadesMigratedRuntimeModules";

// Every region that has left `server-runtime-source.ts` and now travels into the emitted-list bundle
// as its own compiled text rather than as `fn.toString()` over a list of its functions (ADR-0041).
// A batch that migrates a domain adds its module here and nowhere else in this file.
//
// `file` is read from `dist/`; `loaded` is the copy this process is running, which is a *different*
// copy while the CLI ships as `bin/sporades.js`. The two are compared below.
const MIGRATED_RUNTIME_MODULES = [
  { file: "inspection-sql.js", loaded: inspectionSql as Record<string, unknown> },
  { file: "log-index-guard.js", loaded: logIndexGuard as Record<string, unknown> },
  { file: "mail-config.js", loaded: mailConfig as Record<string, unknown> },
  { file: "mail-runtime.js", loaded: mailRuntime as Record<string, unknown> },
  // Batch 3. `runtime-errors` is listed before `auth-runtime` because auth imports it; the order
  // does not matter to esbuild, which resolves the graph, but it matches the dependency direction.
  { file: "runtime-errors.js", loaded: runtimeErrors as Record<string, unknown> },
  { file: "auth-runtime.js", loaded: authRuntime as Record<string, unknown> },
  // Batch 4. Imports `runtime-errors.js` for `commandError` and `assertJsonCompatible`, and
  // `auth-runtime.js` for `PASSWORD_RESET_MAIL_JOB` and `privilegedAuthUserId` — so it is listed
  // after both, matching the dependency direction. esbuild resolves the graph either way.
  { file: "jobs-runtime.js", loaded: jobsRuntime as Record<string, unknown> },
  // Batch 5. Imports `runtime-errors.js` for `assertJsonCompatible` and nothing else, so it is
  // listed before `auth-runtime.js` in the dependency direction — auth imports *it*, for
  // `migrateAnonymousPreferences`, which is what let batch 5 carry seven auth functions with it.
  // esbuild resolves the graph either way; the order is documentation.
  { file: "user-preferences-runtime.js", loaded: userPreferencesRuntime as Record<string, unknown> },
  // Batch 6. `maybe-promise` is not a domain — it is the sync/async bridge six domains use and none
  // owns, extracted for the reason `runtime-errors` was — and it is listed before the storage module
  // because that module imports it. Storage imports `runtime-errors.js` for its `HelperError` type
  // only, which is erased, so `maybe-promise.js` is its one real dependency.
  { file: "maybe-promise.js", loaded: maybePromise as Record<string, unknown> },
  { file: "file-storage-runtime.js", loaded: fileStorageRuntime as Record<string, unknown> },
  // Batch 7. Neither of these is a domain either: they are what closing the ACL and privileged-audit
  // domain's reference graph left outside it and no batch on ticket 04's list owns — the log
  // policy the redactor and the ACL denial record share, and the stored-column decoding the ACL
  // helpers and both mutation paths share. Both are listed before `acl-runtime.js` because it
  // imports them; esbuild resolves the graph either way and the order is documentation.
  { file: "runtime-log-policy.js", loaded: runtimeLogPolicy as Record<string, unknown> },
  { file: "stored-row-decoding.js", loaded: storedRowDecoding as Record<string, unknown> },
];

// The same list as file names, for guards that have to read the modules off disk rather than call
// them. Exported so that `test/server-bundle-free-bindings.test.js` cannot go out of step with what
// is actually carried — the one thing this migration keeps proving is that a second, hand-kept copy
// of this list is how a guard quietly stops covering a domain.
export const MIGRATED_RUNTIME_MODULE_FILES = MIGRATED_RUNTIME_MODULES.map(({ file }) => file);

// Statements the carried copies of the migrated modules and the loaded ones must agree about,
// checked at every bundle build. Half are refused by the inspection gate and half admitted, and the
// refused half is what gives the check its teeth: a carried copy whose validator had been replaced
// by one that admits everything answers `ok` for all of them.
//
// The shapes are the ones ADR-0038 records as having defeated this gate — a bare destructive verb, a
// second statement, a nested block comment, the composed line comment, a verb inside a dollar quote,
// a PRAGMA assignment, whitespace no engine has, and text the wire cannot carry — so a carried copy
// that differs in any limb this project has actually got wrong is caught rather than shipped.
//
// The last three exist for the log-index guard, the second module carried here, which answers a
// different question over the same text. A probe that could not reach a `sporades_log_events`
// reference, a dotted and quoted spelling of one, or a `sqlite_schema` query would compare a skewed
// copy of that module as clean — the same "reports clean for the wrong reason" failure ADR-0038
// records the sweep corpus making three times.
export const MIGRATED_MODULE_SKEW_PROBE = [
  "DROP TABLE t",
  "TRUNCATE TABLE t",
  "SELECT 1 AS s; DROP TABLE t",
  "/*/* */ SELECT 1 */ TRUNCATE TABLE t",
  "SELECT 1 AS s --x\r/*y\n; DROP TABLE t --*/ AS z",
  "SELECT $$a; DROP TABLE t$$ AS s",
  "PRAGMA journal_mode = WAL",
  "SELECT\u00a01 AS a",
  "SELECT 1 AS s\u0000",
  "SELECT 1",
  "SELECT * FROM posts;",
  "PRAGMA table_info(posts)",
  "WITH recent AS (SELECT 1 AS s) SELECT * FROM recent",
  "SELECT id FROM posts WHERE title = 'it''s fine' -- why\r\n;",
  "SELECT * FROM sporades_log_events",
  "SELECT * FROM main . \"sporades_log_events\"",
  "SELECT name FROM sqlite_schema",
];

// Rows the carried copy of the log-index guard and the loaded one must classify the same way. The
// guard's second limb reads result rows rather than SQL, so the statement probe above cannot reach
// it at all: a carried copy that had lost the row filter would answer every statement above
// identically and still hand an operator the log-index table's name out of a deployed Capsule.
export const MIGRATED_MODULE_ROW_SKEW_PROBE: [Record<string, any>, string][] = [
  [{ name: "sporades_log_events" }, "SELECT name FROM sqlite_schema"],
  [{ tbl_name: "sporades_log_events" }, "SELECT tbl_name FROM sqlite_master"],
  [{ sql: "CREATE TABLE sporades_log_events (id TEXT)" }, "SELECT sql FROM sqlite_schema"],
  [{ note: "mentions sporades_log_events in passing" }, "SELECT note FROM sqlite_schema"],
  [{ note: "mentions sporades_log_events in passing" }, "SELECT note FROM posts"],
  [{ name: "posts" }, "SELECT name FROM sqlite_schema"],
  [{}, ""],
];

// Mail configurations the carried copy of `mail-config` and the running one must judge the same way.
// Six are refused and four admitted, for the same reason the statement probe above is split both
// ways: a carried `validateMailConfig` replaced by one that returns its input unchanged answers
// every admitted case correctly and is caught only by a refused one, and one that refuses
// everything is caught only by an admitted one.
//
// The refused half is drawn from what this validator exists to stop rather than from what is merely
// malformed — credentials offered over a plaintext or opportunistically-encrypted hop, a Server env
// reference reaching into the reserved `SPORADES_` namespace, a header-splitting sender, and a TLS
// mode that is not one of the four. Those are the limbs whose loss would be silent.
export const MIGRATED_MODULE_MAIL_CONFIG_SKEW_PROBE: any[] = [
  undefined,
  { smtp: { vendor: "generic", host: "smtp.example.com", port: 587, tls: { mode: "required-starttls" }, auth: { method: "PLAIN", usernameEnv: "SMTP_USERNAME", passwordEnv: "SMTP_PASSWORD" } } },
  { smtp: { vendor: "generic", host: "smtp.example.com", port: 465, tls: { mode: "implicit", rejectUnauthorized: false, servername: "mail.example.com" }, auth: { method: "LOGIN", usernameEnv: "U", passwordEnv: "P" }, defaultFrom: "a@example.com", connectionTimeoutMs: 5000, socketTimeoutMs: 30000 } },
  { smtp: { vendor: "generic", host: "127.0.0.1", port: 25, tls: { mode: "disabled" }, auth: { method: "none" } } },
  { smtp: { vendor: "generic", host: "smtp.example.com", port: 25, tls: { mode: "opportunistic" }, auth: { method: "PLAIN", usernameEnv: "U", passwordEnv: "P" } } },
  { smtp: { vendor: "generic", host: "smtp.example.com", port: 25, tls: { mode: "disabled" }, auth: { method: "PLAIN", usernameEnv: "U", passwordEnv: "P" } } },
  { smtp: { vendor: "generic", host: "smtp.example.com", port: 587, tls: { mode: "required-starttls" }, auth: { method: "PLAIN", usernameEnv: "SPORADES_SECRET", passwordEnv: "P" } } },
  { smtp: { vendor: "generic", host: "smtp.example.com", port: 587, tls: { mode: "starttls" }, auth: { method: "none" } } },
  { smtp: { vendor: "generic", host: "smtp.example.com", port: 587, tls: { mode: "required-starttls" }, auth: { method: "none" }, defaultFrom: "a@example.com\r\nBcc: b@example.com" } },
  { smtp: { vendor: "generic", host: "smtp.example.com", port: 0, tls: { mode: "required-starttls" }, auth: { method: "none" } } },
];

// Messages the carried copy of `mail-runtime` and the running one must assemble into identical MIME.
// This domain's header folding, RFC 2047 encoding, base64 wrapping and Mailgun JSON folding are all
// private to that module, and `buildSmtpMessage` is the only exported name that reaches them — so a
// probe that did not call it could not see any of the four change. The shapes below are chosen to
// reach one limb each.
//
// What this probe does *not* reach is the rest of the domain: the SMTP conversation, the transport's
// error normalization, and the message and provider normalizers upstream of it. Those need a socket
// or an exported entry point, and stating the gap is better than implying the probe covers a domain
// it covers one half of. `test/mail.test.js` is what covers the rest, against `dist/`.
//
// Every message pins `messageId` and carries exactly one body. Both are deliberate:
// `buildSmtpMessage` mints a `randomUUID()` for an absent Message-ID and another for the multipart
// boundary, and two bodies are what make it multipart — so either would make the two copies disagree
// on every build for no reason. The `Date` header is generated the same way and cannot be pinned at
// all, so the comparison below strips it.
export const MIGRATED_MODULE_MAIL_MESSAGE_SKEW_PROBE: any[] = [
  { from: { email: "a@example.com" }, to: [{ email: "b@example.com" }], cc: [], subject: "Plain", messageId: "<1@sporades.local>", textBody: "hello" },
  { from: { email: "a@example.com", name: "Ada Lovelace" }, to: [{ email: "b@example.com", name: "Bob" }], cc: [{ email: "c@example.com" }], replyTo: { email: "r@example.com" }, subject: "Uberändert — café naïve 🚀", messageId: "<2@sporades.local>", htmlBody: "<p>hi</p>" },
  { from: { email: "a@example.com", name: 'Quote "me", back\\slash' }, to: [{ email: "b@example.com" }], cc: [], subject: "x".repeat(200), messageId: "<3@sporades.local>", textBody: "body" },
  // The Mailgun value is two tokens rather than one long one on purpose: `foldMailgunJsonHeader`
  // refuses any single JSON token over 997 characters, so a 1,200-character value would exercise
  // that refusal instead of the folding this message is here to compare. Two 400-character values
  // put the header past SMTP's 998-character line limit while leaving every token foldable.
  { from: { email: "a@example.com" }, to: [{ email: "b@example.com" }], cc: [], subject: "Provider headers", messageId: "<4@sporades.local>", textBody: "body", providerHeaders: [{ name: "X-PM-Tag", value: "welcome" }, { name: "X-Mailgun-Variables", value: `{"a":"${"v".repeat(400)}","b":"${"w".repeat(400)}"}`, json: true }, { name: "X-Verbatim", value: "kept as-is" }] },
  { from: { email: "a@example.com" }, to: [{ email: "b@example.com" }, { email: "c@example.com" }, { email: "d@example.com" }], cc: [], subject: "Folding a long recipient list across the SMTP line limit for good measure", messageId: "<5@sporades.local>", textBody: "z".repeat(300) },
];

// What the carried copy of `auth-runtime` and the running one must answer identically. Batch 3's
// domain is the largest carried here and the only one whose refusals are credentials, so the shapes
// below are chosen for the limbs whose loss would be silent rather than for coverage.
//
// **The credential limb comes first and is the one that matters most.** `verifyEmailPassword` is the
// only probe in this file that reaches `scryptSync` and `timingSafeEqual`, which is also the only
// place `process.getBuiltinModule` is exercised across the carrier (ADR-0042): a carried copy in
// which that accessor had not survived the IIFE throws rather than answering, and a copy that had
// lost the constant-time comparison — or been replaced by one returning `true` — is caught by the
// rejecting vectors. Both hashes are pinned scrypt outputs for the same salt, so the accepting and
// rejecting cases differ only in the password.
//
// The rest are the domain's pure gates: the return-to containment that stops an open redirect, the
// loopback and test-endpoint overrides that must not be honoured in production, Apple's origin
// eligibility, the password-reset path normalizer, and `requireAuth` itself — which reports a
// refusal by throwing, so it travels through `probedAnswer` the way `validateMailConfig` does.
//
// Every gate is given accepting *and* refusing inputs, for the reason ADR-0038 records the sweep
// corpus getting wrong three times: a probe a gate refuses in full cannot see a copy that refuses
// everything, and one it admits in full cannot see a copy that admits everything.
export const MIGRATED_MODULE_AUTH_CREDENTIAL_SKEW_PROBE: [string, string, string][] = [
  ["correct horse battery staple", "cGFzc3dvcmQtc2FsdA", "wpN60e2jr-1ZV-lRCud8jEtOa7QixOUXD-dQYJ5YgmIZmKQ5B1vRp6wfBw83Ts-Q8X1n8WKxuMv0Y-tpHvh3PQ"],
  ["wrong password", "cGFzc3dvcmQtc2FsdA", "wpN60e2jr-1ZV-lRCud8jEtOa7QixOUXD-dQYJ5YgmIZmKQ5B1vRp6wfBw83Ts-Q8X1n8WKxuMv0Y-tpHvh3PQ"],
  ["correct horse battery staple", "cGFzc3dvcmQtc2FsdA", "CxB4VcKLvar_bRuhY5uHwD7QG25RLPRkfphgX3-CeZjq44jeqLjI82Wy0rRqzpvcRrcJ4kSSCoHX5jMLipbNzw"],
  ["correct horse battery staple", "a-different-salt", "wpN60e2jr-1ZV-lRCud8jEtOa7QixOUXD-dQYJ5YgmIZmKQ5B1vRp6wfBw83Ts-Q8X1n8WKxuMv0Y-tpHvh3PQ"],
  // A truncated expected hash, which is what the length comparison in front of `timingSafeEqual`
  // exists for: without it this throws rather than returning false, because `timingSafeEqual`
  // refuses buffers of different lengths.
  ["correct horse battery staple", "cGFzc3dvcmQtc2FsdA", "wpN60e2jr-1ZV-lRCud8jEtOa7Q"],
];

// Statements of the domain's pure gates, as `[exported name, arguments]`. Kept as data rather than
// as calls so the two copies are asked in one loop and a name absent from either is reported by
// `describeMigratedModuleAnswers` rather than throwing a bare `TypeError` out of a bundle build.
export const MIGRATED_MODULE_AUTH_SKEW_PROBE: [string, any[]][] = [
  ["hashPasswordResetVerifier", ["a-reset-verifier"]],
  ["hashPasswordResetVerifier", ["\0absent"]],
  ["normalizeReturnTo", ["/dashboard", "https://app.example.com"]],
  ["normalizeReturnTo", ["https://evil.example.com/steal", "https://app.example.com"]],
  ["normalizeReturnTo", ["//evil.example.com", "https://app.example.com"]],
  ["normalizeReturnTo", ["", "https://app.example.com"]],
  ["isOAuthLoopbackHostname", ["127.0.0.1"]],
  ["isOAuthLoopbackHostname", ["[::1]"]],
  ["isOAuthLoopbackHostname", ["169.254.169.254"]],
  ["isOAuthLoopbackHostname", [null]],
  ["oauthProviderTestEndpoint", ["http://127.0.0.1:9/token", "https://oauth2.googleapis.com/token"]],
  ["oauthProviderTestEndpoint", ["https://evil.example.com/token", "https://oauth2.googleapis.com/token"]],
  ["appleOAuthOriginEligible", ["https://app.example.com"]],
  ["appleOAuthOriginEligible", ["http://app.example.com"]],
  ["appleOAuthOriginEligible", ["https://localhost"]],
  ["appleOAuthOriginEligible", ["https://127.0.0.1"]],
  ["normalizePasswordResetPath", ["/reset-password"]],
  ["normalizePasswordResetPath", ["//evil.example.com"]],
  ["normalizePasswordResetPath", ["/a/../../etc/passwd"]],
  ["normalizePasswordResetPath", ["/reset?token=1"]],
  ["isReservedAuthUserId", ["__privileged__"]],
  ["isReservedAuthUserId", ["an-ordinary-user"]],
  ["privilegedAuthUserId", []],
  ["normalizeSimulatedText", ["  padded  "]],
  ["normalizeSimulatedText", [null]],
  ["readEndpointSessionToken", [{ "x-sporades-session-token": "tok" }, {}]],
  ["readEndpointSessionToken", [{}, { sessionToken: "ignored" }]],
  ["requireAuth", [{ auth: { isAuthenticated: true, isGuest: false } }, {}]],
  ["requireAuth", [{ auth: { isAuthenticated: true, isGuest: true } }, { linked: true }]],
  ["requireAuth", [{ auth: { isAuthenticated: false } }, {}]],
  ["requireAuth", [{ kind: "endpoint" }, {}]],
];

// The jobs and schedules domain, batch 4. Two limbs, because the domain answers two different
// shapes of question and a probe that asked only one would compare a skewed copy of the other as
// clean — the failure ADR-0041 records the statement probe making before the log-index guard's rows
// were added to it.
//
// The schedule limb is `[cron, timezone, afterISO]` and is deliberately routed through
// `nextScheduleOccurrence` rather than `parseScheduleExpression` alone. That call reaches
// `scheduleWallClockParts`, one of this module's five private helpers, which converts every
// candidate instant to local wall-clock fields before the cron match — so a carried copy whose
// privacy hid a broken helper is caught here rather than only by the census. Comparing a returned
// `Date` also gives the probe a value that skew cannot preserve accidentally: an occurrence
// calculator off by one minute, one hour or one DST transition disagrees visibly.
//
// It does *not* reach `resolveScheduleTimezone`, because `nextScheduleOccurrence` takes the zone as
// an argument and hands it straight to `Intl`. That helper is reached by the definition limb below
// instead, which is why both exist — stated rather than left for the next reader to assume the
// first limb covers more than it does.
//
// The cases are the ones this cron implementation has actually got wrong: the day-of-month /
// day-of-week OR rule when both fields are restricted, a step, a range, a list, a leap-day
// occurrence, a DST spring-forward hour that does not exist locally, and three inputs that must
// throw rather than return.
//
// **Every case must resolve within a few thousand minutes of its `after` instant, and that is a
// correctness requirement of this probe rather than a preference.** `nextScheduleOccurrence` scans
// minute by minute with an `Intl.DateTimeFormat.formatToParts` call per candidate, bounded at
// `8 * 366 * 24 * 60` = 4,207,680 iterations; this whole function runs twice per bundle build, once
// for the carried copy and once for the loaded one, and a bundle is built on every `sporades dev`
// start. The first version of this list asked for `0 0 29 2 *` after 2096-03-01, whose next
// occurrence is 2104-02-29 because 2100 is not a leap year — the full eight-year bound, measured at
// **9,254 ms per copy**, so 18.5 s added to every dev start. That is not a hang and nothing throws;
// it simply moved dev startup from 0.3 s to 19.5 s and blew the ten-second process and socket
// budgets in `test/password-reset-transport.test.js` and `test/require-auth.test.js`.
//
// So the leap-day case starts the day before the occurrence it is looking for. It still proves the
// carried copy agrees about 29 February — which is the property worth comparing — and costs about a
// thousand iterations rather than four million. The eight-year bound itself is not probe material.
const MIGRATED_MODULE_SCHEDULE_SKEW_PROBE: [string, string, string][] = [
  ["*/15 * * * *", "UTC", "2031-03-01T09:07:00.000Z"],
  ["0 9 * * *", "America/New_York", "2031-03-08T00:00:00.000Z"],
  ["30 2 * * *", "America/New_York", "2031-03-09T00:00:00.000Z"],
  ["0 0 29 2 *", "UTC", "2096-02-28T12:00:00.000Z"],
  ["0 12 13 * 5", "UTC", "2031-01-01T00:00:00.000Z"],
  ["0,30 1-3 * * *", "Australia/Adelaide", "2031-06-01T00:00:00.000Z"],
  ["0 0 * * 0", "Europe/London", "2031-10-25T00:00:00.000Z"],
  ["not a cron", "UTC", "2031-01-01T00:00:00.000Z"],
  ["* * * *", "UTC", "2031-01-01T00:00:00.000Z"],
  ["0 9 * * *", "Not/AZone", "2031-01-01T00:00:00.000Z"],
];

// The definition limb: whole Capsule `schedules` maps put through `scheduleDefinitionsFromCapsule`,
// which is the domain's validation front door and the only exported path to `resolveScheduleTimezone`.
// Its `effectiveTimezone` and `fingerprint` outputs are what a skewed copy would have to reproduce,
// and the fingerprint is what decides whether a redeployed Schedule is treated as changed — so a
// copy that computed it differently would silently re-reconcile every Schedule on every boot.
//
// Cases: a valid definition with a zone alias, one whose Job is not declared, a duplicate name, an
// invalid missed-run policy, and a payload that is not JSON-compatible — which is the path through
// `boundedJobJson` into `assertJsonCompatible`.
const MIGRATED_MODULE_SCHEDULE_DEFINITION_SKEW_PROBE: [Record<string, unknown>, string[]][] = [
  [{ nightly: { kind: "schedule", expression: "0 3 * * *", timezone: "Asia/Calcutta", job: "cleanup" } }, ["cleanup"]],
  [{ hourly: { kind: "schedule", expression: "0 * * * *", job: "cleanup", retry: { maxAttempts: 3, delayMs: 100 } } }, ["cleanup"]],
  [{ orphan: { kind: "schedule", expression: "0 * * * *", job: "missing" } }, ["cleanup"]],
  [{ bad: { kind: "schedule", expression: "0 * * * *", job: "cleanup", missedRun: "sometimes" } }, ["cleanup"]],
  [{ zone: { kind: "schedule", expression: "0 * * * *", timezone: "Not/AZone", job: "cleanup" } }, ["cleanup"]],
];

// The Job limb. `boundedJobJson` is the one every Job payload, result and failure passes through,
// and it is the function this batch moved `assertJsonCompatible` into `runtime-errors.js` for — so
// a carried copy that lost the JSON check or the byte bound answers differently here. The rest are
// the queue's pure boundaries: the retry normalizer's range checks, the cursor codec, and the
// failure sanitizer that decides which internal codes a Capsule author is allowed to see.
const MIGRATED_MODULE_JOB_SKEW_PROBE: [string, unknown[]][] = [
  ["boundedJobJson", [{ ok: 1 }, 64 * 1024, "JOB_PAYLOAD_TOO_LARGE", "Schedule payload"]],
  ["boundedJobJson", ["x".repeat(200), 64, "JOB_RESULT_TOO_LARGE", "Job result"]],
  ["boundedJobJson", [undefined, 1024, "JOB_PAYLOAD_TOO_LARGE", "Job payload"]],
  ["normalizeJobRetry", [undefined]],
  ["normalizeJobRetry", [{ maxAttempts: 3, delayMs: 500 }]],
  ["normalizeJobRetry", [{ maxAttempts: 21, delayMs: 0 }]],
  ["normalizeJobRetry", [{ maxAttempts: 3, delayMs: -1 }]],
  ["encodeJobCursor", [{ createdAt: "2031-01-01T00:00:00.000Z", id: "job-1" }]],
  ["decodeJobCursor", ["eyJjcmVhdGVkQXQiOiIyMDMxLTAxLTAxVDAwOjAwOjAwLjAwMFoiLCJpZCI6ImpvYi0xIn0"]],
  ["decodeJobCursor", [undefined]],
  ["decodeJobCursor", ["not-a-cursor"]],
  ["safeJobFailure", [Object.assign(new Error("boom"), { code: "UNKNOWN_JOB_HANDLER" })]],
  ["safeJobFailure", [Object.assign(new Error("leak"), { code: "SOME_INTERNAL_CODE" })]],
  ["jobSummary", [{ id: "j", handler: "h", status: "queued", attempts: "2" }]],
  // Exercises the `nodeCryptoModule.createHash` call site — the one line of this module that is not
  // byte-identical to the region it moved out of, and the one a bad builtin binding would break.
  ["scheduledOccurrenceIdentity", [{ capsuleIdentity: "capsule-a" }, "nightly", "2031-01-01T00:00:00.000Z"]],
];

// Patches the carried copy of `user-preferences-runtime` and the running one must judge the same
// way, as arguments to `normalizePreferencesPatch`. Batch 5's domain is the smallest carried here
// and the hardest to reach, so what this probe *can* see is worth stating exactly.
//
// `describeMigratedModuleAnswers` is synchronous, and three of that module's four other exports are
// `async` — they take a database adapter and answer with a promise, so none of them can be compared
// from inside a bundle build. `normalizePreferencesPatch` is the synchronous validation path they
// all funnel through, and it is exported for this probe rather than because something resolves it.
// One call reaches all three of the things about this domain that would otherwise be carried
// uncompared: the object/array/null gate itself, `createPreferencesError` — the module's only
// private function, reachable through nothing else — and `assertJsonCompatible`, its only
// cross-module import, which is where the JSON-compatibility refusal actually lives.
//
// Split both ways for the reason this file repeats: a corpus the gate refuses in full cannot tell
// a validator that refuses everything from the real one, and one it admits in full cannot see a
// validator that returns its input unchanged. The refusals cover both codes the domain can answer
// with — `INVALID_PREFERENCES_PATCH` from the shape gate, and the hint-bearing refusal
// `assertJsonCompatible` throws — because a copy that reached the right verdict by the wrong route
// would hand a Capsule author the wrong error, which `probedAnswer` compares and nothing else would.
//
// **Each case is `[label, patch]` and only the label is serialized.** Two of the patches cannot
// survive `JSON.stringify` at all — that is precisely why they are refused — so a corpus that put
// the patch itself into the comparison would throw out of the middle of every bundle build.
export const MIGRATED_MODULE_PREFERENCES_PATCH_SKEW_PROBE: [string, unknown][] = [
  // Admitted. A patch that reaches the end of both gates and comes back unchanged.
  ["plain", { theme: "dark" }],
  ["nested", { density: "compact", locale: "en-GB", nested: { a: [1, 2, null], b: "" } }],
  ["empty", {}],
  // Refused by the shape gate, which is the limb that owns `INVALID_PREFERENCES_PATCH`. `null` and
  // an array both pass `typeof === "object"`, so they are the two the gate's extra clauses exist
  // for and the two a copy that had kept only the `typeof` check would wrongly admit.
  ["null", null],
  ["array", []],
  ["undefined", undefined],
  ["string", "not an object"],
  ["number", 42],
  // Refused by `assertJsonCompatible` rather than by the shape gate: plain objects the shape gate
  // admits and JSON cannot carry. A copy that had lost the JSON check admits both and disagrees
  // here, and it is the only limb of this probe that leaves the module at all.
  ["bigint", { big: 1n }],
  ["cyclic", (() => { const a: Record<string, unknown> = {}; a.self = a; return { cyclic: a }; })()],
];

// The DDL the carried copy and the running one must emit for the preference table, driven through a
// stand-in for the engine. `createUserPreferencesTables` is the domain's other synchronously
// reachable export: it takes an adapter and calls `exec(dialect.sql(…))`, so a fake that returns the
// text it is handed captures the statement exactly. A carried copy that had drifted on the table
// name, a column, the primary key or a NOT NULL would be a deployed Capsule reading and writing
// preferences against a different schema than the one it created — silent until it is not.
//
// One call, four string concatenations, no clock and no I/O. Every probe in this file runs twice on
// every `sporades dev` start, which is why that is worth stating.
const MIGRATED_MODULE_PREFERENCES_STORAGE_PROBE = {
  dialect: { sql: (text: string) => text },
  exec: (text: string) => text,
};

// Batch 6: file and object storage. Four corpora and a stand-in engine, and what they can and
// cannot reach is worth stating exactly, because this domain is the hardest yet to question from
// inside a bundle build.
//
// `describeMigratedModuleAnswers` is synchronous. Every entry point of this domain —
// `createPendingFileUpload`, `completePendingFileUpload`, both URL paths, `deletePrivateFile` — is
// `async` and takes a database adapter and a storage engine, so none of them can be called here.
// What is reachable is the pure spine underneath them, and six of these names are exported for this
// probe rather than because something resolves them. Without that widening the only limbs this
// domain could offer would be the two engine constructors, and the AWS SigV4 signature, the File
// path rules, the public-URL expiry gate and the metadata projections would be carried into every
// deployed Capsule uncompared.
//
// **The AWS SigV4 signature.** `s3Signature` is a pure function of its arguments — the date and the
// `x-amz-date` are parameters rather than a clock read — so it pins the whole signing path:
// `s3SigningKey`, `s3Hmac` and `s3Sha256Hex`, which are private, and with them the two
// `nodeCryptoModule.` call sites this domain needs ADR-0042 for. A carried copy whose signature
// differed would authenticate against no S3-compatible endpoint at all, and one whose *canonical
// request* differed would sign the wrong request while still producing a well-formed header.
//
// Split across the shapes that actually break AWS request signing rather than across arbitrary
// inputs: no key, a nested key, a key needing percent-encoding, and a payload hash that is not the
// empty-body one. Four calls, sixteen HMACs, no I/O.
export const MIGRATED_MODULE_STORAGE_SIGNATURE_SKEW_PROBE: [string, Record<string, unknown>][] = [
  ["bucket-head", {
    method: "HEAD", pathname: "/sporades", query: "",
    headers: { "host": "minio.example.com:9000", "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "x-amz-date": "20310101T000000Z" },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    accessKey: "AKIAPROBE", secretKey: "s3cr3t-probe", region: "us-east-1",
    date: "20310101", amzDate: "20310101T000000Z",
  }],
  ["object-put", {
    method: "PUT", pathname: "/sporades/capsules/probe/files/file-1/version-1", query: "",
    headers: { "host": "minio.example.com:9000", "x-amz-content-sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "x-amz-date": "20310102T030405Z" },
    payloadHash: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    accessKey: "AKIAPROBE", secretKey: "s3cr3t-probe", region: "eu-west-2",
    date: "20310102", amzDate: "20310102T030405Z",
  }],
  ["encoded-path", {
    method: "GET", pathname: "/sporades/capsules/probe/files/a%20b%21/1", query: "",
    headers: { "host": "s3.example.com", "x-amz-date": "20310103T101112Z" },
    payloadHash: "UNSIGNED-PAYLOAD",
    accessKey: "AKIAPROBE", secretKey: "another-secret", region: "ap-south-1",
    date: "20310103", amzDate: "20310103T101112Z",
  }],
  ["single-header", {
    method: "DELETE", pathname: "/sporades", query: "",
    headers: { "host": "s3.example.com" },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    accessKey: "AKIAPROBE", secretKey: "s3cr3t-probe", region: "us-east-1",
    date: "20310104", amzDate: "20310104T000000Z",
  }],
];

// The two pure functions that decide *what* gets signed and *where* an object lands. Percent
// encoding is the limb worth naming: `s3EncodedPathSegment` re-encodes the six characters
// `encodeURIComponent` leaves alone, and a carried copy that had lost that would sign a canonical
// path the endpoint does not agree with — a signature mismatch on exactly the file names that
// contain a quote or a parenthesis and on no others.
export const MIGRATED_MODULE_STORAGE_PATH_SKEW_PROBE: [string, unknown[]][] = [
  ["s3CanonicalPath", ["", "sporades", null]],
  ["s3CanonicalPath", ["/", "sporades", "capsules/probe/files/f/1"]],
  ["s3CanonicalPath", ["/prefix/base", "sporades", "a b!'()*~"]],
  ["s3ObjectKey", ["capsules/probe", "file-1", "version-1"]],
  ["s3ObjectKey", ["capsules/probe", "file-1", 7]],
  // The Capsule-scoped absolute File path rules, which decide which row a `files.get("/x/y")` reads.
  // Admitted and refused both ways: a copy reduced to a `startsWith("/")` check admits the second
  // and third, and one that refused everything would be caught by the first two.
  ["normalizeAbsoluteFilePath", ["/images/avatars/profile.png"]],
  ["normalizeAbsoluteFilePath", ["  /a//b///c  "]],
  ["normalizeAbsoluteFilePath", ["images/profile.png"]],
  ["normalizeAbsoluteFilePath", ["/"]],
  ["normalizeAbsoluteFilePath", [""]],
  ["isAbsoluteFilePath", ["/a/b"]],
  ["isAbsoluteFilePath", ["a/b"]],
  ["isAbsoluteFilePath", [null]],
  ["normalizeFileName", ["", "/bucket/dir/name.png"]],
  ["normalizeFileName", ["  ", null]],
  ["normalizeFileName", ["given.png", "/other/path.png"]],
  // The inline content-type allow-list, which is a containment rather than a calculation: it decides
  // which uploaded bytes a browser is allowed to render inline off the Capsule's own origin. A
  // carried copy that echoed the stored type back would turn a stored `text/html` into stored XSS,
  // and every honest upload would still work.
  ["contentTypeForFile", ["image/png"]],
  ["contentTypeForFile", ["IMAGE/PNG; charset=binary"]],
  ["contentTypeForFile", ["text/html"]],
  ["contentTypeForFile", ["image/svg+xml"]],
  ["contentTypeForFile", [null]],
  // The public-URL expiry gate. **No admitted `ttlSeconds` case**, deliberately: that branch is
  // `Date.now() + ttl`, so the two copies are called microseconds apart and would disagree on an
  // honest build. `expires` and `noExpiry` are pinned, and the `ttlSeconds` limbs here are the ones
  // refused before the clock is read.
  ["validatePublicUrlExpiry", [{ noExpiry: true }]],
  ["validatePublicUrlExpiry", [{ expires: "2031-01-01T00:00:00.000Z" }]],
  ["validatePublicUrlExpiry", [{ expires: "not-a-date" }]],
  ["validatePublicUrlExpiry", [{}]],
  ["validatePublicUrlExpiry", [{ ttlSeconds: 60, noExpiry: true }]],
  ["validatePublicUrlExpiry", [{ ttlSeconds: 0 }]],
  ["validatePublicUrlExpiry", [{ ttlSeconds: "soon" }]],
  // The two projections every File the SDK hands a Capsule author passes through. A copy that
  // dropped `path` or stopped coercing `size` is a wrong File object rather than a wrong verdict.
  ["fileMetadataFromRow", [{ id: "f1", bucketName: "images", size: "1234", type: "image/png", name: "a.png", path: "/images/a.png", version: "v1", ownerId: "u1", status: "uploaded" }]],
  ["fileMetadataFromUpload", [{ fileId: "f1", bucketName: "images", expectedSize: "99", type: "text/plain", name: "a.txt", path: "/images/a.txt", version: "v1" }]],
];

// The S3-compatible engine's constructor, which is five refusals and one namespace rule. Every
// refusal is a misconfiguration a deployed Capsule would otherwise carry to its first upload, and
// `s3StorageNamespace` is a private regex gate whose loss would let one Capsule's namespace escape
// into another's prefix inside a shared bucket. Constructing costs an object literal and no I/O.
export const MIGRATED_MODULE_STORAGE_ENGINE_SKEW_PROBE: [string, Record<string, unknown>][] = [
  ["ok", { endpoint: "http://minio:9000", bucket: "sporades", region: "us-east-1", accessKey: "a", secretKey: "b", namespace: "capsule" }],
  ["ok-hyphenated", { endpoint: "https://s3.example.com/base", bucket: "b", region: "eu-west-2", accessKey: "a", secretKey: "b", namespace: "a-capsule-9" }],
  ["no-endpoint", { endpoint: "", bucket: "sporades", region: "us-east-1", accessKey: "a", secretKey: "b", namespace: "capsule" }],
  ["no-bucket", { endpoint: "http://minio:9000", bucket: "", region: "us-east-1", accessKey: "a", secretKey: "b", namespace: "capsule" }],
  ["no-region", { endpoint: "http://minio:9000", bucket: "sporades", region: "", accessKey: "a", secretKey: "b", namespace: "capsule" }],
  ["no-secret", { endpoint: "http://minio:9000", bucket: "sporades", region: "us-east-1", accessKey: "a", secretKey: "", namespace: "capsule" }],
  ["namespace-uppercase", { endpoint: "http://minio:9000", bucket: "sporades", region: "us-east-1", accessKey: "a", secretKey: "b", namespace: "Capsule" }],
  ["namespace-traversal", { endpoint: "http://minio:9000", bucket: "sporades", region: "us-east-1", accessKey: "a", secretKey: "b", namespace: "../other" }],
  ["namespace-trailing-hyphen", { endpoint: "http://minio:9000", bucket: "sporades", region: "us-east-1", accessKey: "a", secretKey: "b", namespace: "capsule-" }],
];

// The scalar surface of a constructed engine. The returned object's methods are closures over the
// constructor's arguments and do not serialize, so they are dropped by name rather than by
// `JSON.stringify` quietly omitting them — `objectKeyPrefix` is the one that matters, because it is
// where every object this Capsule writes lands inside a shared bucket.
function migratedModuleStorageEngineShape(engine: any) {
  return [engine.engine, engine.endpoint ?? null, engine.bucket ?? null, engine.region ?? null, engine.namespace ?? null, engine.objectKeyPrefix ?? null, engine.storagePath ?? null];
}

// The File metadata DDL, driven through a stand-in for the engine, for the same reason the
// preferences table is: no verdict-shaped probe can reach a `CREATE TABLE`. This domain's schema is
// larger and carries two data migrations — `filePathBackfillSql` derives the `path` column for rows
// created before it existed, and `activeFilePathDedupeSql` soft-deletes the duplicates that backfill
// can produce — and both are private. A carried copy that had drifted on either would leave a
// deployed Capsule's file table with two live rows on one path, which is precisely the state the
// unique index created two statements later then refuses to build.
//
// The fake records rather than returns, because `createFileStorageTables` chains its steps through
// `chainMaybePromise` and answers `undefined`. That also puts `maybe-promise.js` under this limb:
// a carried copy of it that stopped chaining would record a different set of statements.
//
// Sixteen recorded statements, string concatenation only, no clock and no I/O. Every probe in this
// file runs twice on every `sporades dev` start, which is why that is worth stating.
function migratedModuleStorageTableProbe() {
  const statements: string[] = [];
  const sqlite = {
    dialect: {
      sql: (text: string) => text,
      addMissingColumn: (_target: unknown, table: string, name: string, type: string) => {
        statements.push(`ADD COLUMN ${table}.${name} ${type}`);
      },
    },
    exec: (text: string) => {
      statements.push(text);
    },
  };
  return { sqlite, statements };
}

// The sync/async bridge `maybe-promise.js` holds, asked directly. It is reached through the DDL limb
// above as well, but only in its synchronous lane: every step of `createFileStorageTables` answers
// without a promise under the stand-in engine, so `chainMaybePromise`'s `pending.then(step)` arm and
// `thenIfPromise`'s promise arm are never taken there. These cases take both arms, which is what
// lets this limb see a copy that had stopped distinguishing them — the shape that would make every
// adapter method on the Postgres and libSQL engines return before its statement had run.
//
// The promise arms are compared by what they *are* rather than by awaiting them, because
// `describeMigratedModuleAnswers` is synchronous: a returned thenable is reported as `promise` and a
// plain value as itself, so a copy that resolved eagerly is a disagreement.
export const MIGRATED_MODULE_MAYBE_PROMISE_SKEW_PROBE: [string, unknown][] = [
  ["null", null],
  ["undefined", undefined],
  ["number", 7],
  ["plain-object", { a: 1 }],
  ["thenable", { then: (resolve: (value: unknown) => void) => resolve("resolved") }],
  ["then-not-a-function", { then: 1 }],
  ["function", () => "called"],
];

// Batch 7's two non-domain modules. Both are pure leaf functions, so both limbs are `[name, args]`
// data put through `probedAnswer` in one loop — no clock, no I/O, and thirty-odd calls between them.
//
// **`isSensitiveLogKey` is the limb whose loss would be silent.** It is the only thing in this
// runtime that decides which field names are never written into the platform log, and it is read
// from two sides — `redactLogData` redacts a log payload with it, and `aclVisibleFieldNames` uses it
// to decide which field names an ACL denial record may name. A carried copy reduced to a bare
// `password` test would put a `clientSecret` or an `authorization` field name into every denial
// record a deployed Capsule writes, and every honest log would still look right. Split both ways for
// the reason this file repeats: a corpus it refuses in full cannot see a copy that refuses
// everything, and one it admits in full cannot see one that admits everything. The refused half
// covers both of the two alternations the real body is written as — the delimited spelling and the
// camelCase one — because a copy that had kept only the first passes every `snake_case` case.
export const MIGRATED_MODULE_LOG_POLICY_SKEW_PROBE: [string, unknown[]][] = [
  ["isSensitiveLogKey", ["password"]],
  ["isSensitiveLogKey", ["user_password_hash"]],
  ["isSensitiveLogKey", ["client-secret"]],
  ["isSensitiveLogKey", ["clientSecret"]],
  ["isSensitiveLogKey", ["apiToken"]],
  ["isSensitiveLogKey", ["privateKey"]],
  ["isSensitiveLogKey", ["authorized_keys"]],
  ["isSensitiveLogKey", ["rawRequestBody"]],
  ["isSensitiveLogKey", ["stacktrace"]],
  ["isSensitiveLogKey", ["AUTHORIZATION"]],
  ["isSensitiveLogKey", ["title"]],
  ["isSensitiveLogKey", ["passwordless"]],
  ["isSensitiveLogKey", ["id"]],
  ["isSensitiveLogKey", [""]],
  ["isSensitiveLogKey", [null]],
  // The log index's retention cap: a `config` read with two spellings, an integer gate and a
  // default. A carried copy that had lost the gate would let a Capsule configure a fractional or
  // negative cap and prune its own log index to nothing.
  ["logIndexLimit", [{}]],
  ["logIndexLimit", [{ logs: { indexLimit: 25 } }]],
  ["logIndexLimit", [{ logging: { indexLimit: 25 } }]],
  ["logIndexLimit", [{ logs: { indexLimit: 25 }, logging: { indexLimit: 99 } }]],
  ["logIndexLimit", [{ logs: { indexLimit: 0 } }]],
  ["logIndexLimit", [{ logs: { indexLimit: -1 } }]],
  ["logIndexLimit", [{ logs: { indexLimit: 1.5 } }]],
  ["logIndexLimit", [{ logs: { indexLimit: "25" } }]],
];

// The stored-column decoding, at both granularities the module holds it: a whole row against a
// table's fields, and one field's value. The two are the same rule written twice — see that
// module's header — so the cases are chosen to make a copy that had drifted on either visible in
// the other: `null` survives every branch, a `"0"` from Postgres is a `Number` and not a string, a
// stored `0` is Boolean `false`, and a Json column is parsed rather than handed back as text.
//
// `deserializeRow` is what `ctx.acl.db.get()` answers with, so a copy that stopped parsing Json
// would hand an ACL rule a string where the Capsule author's policy expects an object — a rule that
// then denies every row, out of a deployed Capsule, with nothing in any log to say why.
export const MIGRATED_MODULE_ROW_DECODING_SKEW_PROBE: [string, unknown[]][] = [
  ["deserializeFieldValue", [{ kind: "Boolean" }, 0]],
  ["deserializeFieldValue", [{ kind: "Boolean" }, 1]],
  ["deserializeFieldValue", [{ kind: "Boolean" }, null]],
  ["deserializeFieldValue", [{ kind: "Number" }, "42"]],
  ["deserializeFieldValue", [{ kind: "Number" }, null]],
  ["deserializeFieldValue", [{ kind: "Json" }, '{"a":[1,null]}']],
  ["deserializeFieldValue", [{ kind: "Json" }, null]],
  ["deserializeFieldValue", [{ kind: "Json" }, "not json"]],
  ["deserializeFieldValue", [{ kind: "Text" }, "left alone"]],
  ["deserializeFieldValue", [{ kind: "Reference" }, "row-1"]],
  ["deserializeRow", [
    { fields: [{ name: "flag", kind: "Boolean" }, { name: "count", kind: "Number" }, { name: "meta", kind: "Json" }, { name: "title", kind: "Text" }] },
    { id: "r1", flag: 0, count: "7", meta: '{"a":1}', title: "kept" },
  ]],
  ["deserializeRow", [
    { fields: [{ name: "flag", kind: "Boolean" }, { name: "count", kind: "Number" }, { name: "meta", kind: "Json" }] },
    { id: "r2", flag: null, count: null, meta: null },
  ]],
  ["deserializeRow", [{ fields: [] }, { id: "r3", untouched: "value" }]],
  ["deserializeRow", [{ fields: [{ name: "meta", kind: "Json" }] }, { id: "r4", meta: "not json" }]],
];

function bundleTemplateError(message: string, hint: string) {
  return Object.assign(new Error(message), { hint });
}

// The carried block, evaluated so it can be questioned rather than only pattern-matched.
//
// The input is this build's own output, produced two lines earlier from files inside the Sporades
// package — not Capsule code and not anything a Capsule author supplies. Evaluating it costs one
// `new Function` and runs the modules' top level, which builds three `Set`s and declares functions.
function evaluateMigratedModulesBlock(code: string) {
  try {
    return new Function(`${code}\nreturn ${MIGRATED_MODULES_NAMESPACE};`)();
  } catch (error: any) {
    throw bundleTemplateError(
      `Server bundle failed: the migrated runtime modules did not evaluate: ${error?.message ?? error}`,
      "A file under dist/ is truncated or corrupt. Run `npm run build`, or reinstall the Sporades CLI.",
    );
  }
}

// The names the comparison below calls, so it can say what is missing instead of dying on it. A
// probe that names a function no listed module exports is otherwise a bare `TypeError` out of the
// middle of a bundle build — which is how it first failed, when the two lists were deliberately put
// out of step while testing something else. The probe and `MIGRATED_RUNTIME_MODULES` have to move
// together, and this is where that is said.
const MIGRATED_MODULE_PROBE_NAMES = [
  "validateReadOnlyInspectionSql",
  "sqlWithoutTrailingTerminator",
  "targetsInternalLogIndexTable",
  "readSqlTableReference",
  "isInternalLogIndexMetadataRow",
  "validateMailConfig",
  "buildSmtpMessage",
  "verifyEmailPassword",
  ...new Set(MIGRATED_MODULE_AUTH_SKEW_PROBE.map(([name]) => name)),
  "parseScheduleExpression",
  "nextScheduleOccurrence",
  "scheduleDefinitionsFromCapsule",
  ...new Set(MIGRATED_MODULE_JOB_SKEW_PROBE.map(([name]) => name)),
  "normalizePreferencesPatch",
  "createUserPreferencesTables",
  "s3Signature",
  ...new Set(MIGRATED_MODULE_STORAGE_PATH_SKEW_PROBE.map(([name]) => name)),
  "createS3CompatibleFileStorageAdapter",
  "createLocalFileStorageAdapter",
  "createFileStorageTables",
  "isPromiseLike",
  "thenIfPromise",
  "chainMaybePromise",
  ...new Set(MIGRATED_MODULE_LOG_POLICY_SKEW_PROBE.map(([name]) => name)),
  ...new Set(MIGRATED_MODULE_ROW_DECODING_SKEW_PROBE.map(([name]) => name)),
];

// What a probed call answered, as one comparable string, whether it returned or threw. The mail
// limbs need this and the inspection ones do not: `validateReadOnlyInspectionSql` reports a refusal
// by returning `{ ok: false }`, while `validateMailConfig` reports one by throwing, and a comparison
// that let the throw escape would fail the build with the validator's own message and no indication
// that two copies of a module were being compared. The error's `code` and `message` are part of the
// answer, so a carried copy that refuses the right configurations for the wrong reason is a
// disagreement rather than a match.
function probedAnswer(call: () => unknown) {
  try {
    return { returned: call() };
  } catch (error: any) {
    return { threw: { code: error?.code ?? null, message: String(error?.message ?? error) } };
  }
}

// The same, plus the field `requireAuth` hangs its denial record on. That record is the whole output
// of `createAuthDenialLogData`, which is private to `auth-runtime` and reachable through nothing
// else — and it travels on the *error*, not in the return value, so `probedAnswer` drops it and a
// carried copy whose denial record had been skewed compares clean. Found by planting exactly that
// skew and watching this check pass; the case is in `test/server-bundle-module-graph.test.js` now.
//
// It is what a deployed Capsule writes to the platform log on every refused handler call, so a copy
// that reported the wrong actor would be a wrong audit trail rather than a wrong verdict — the kind
// of difference this comparison exists to catch precisely because nothing else would.
function authProbedAnswer(call: () => unknown) {
  try {
    return { returned: call() };
  } catch (error: any) {
    return {
      threw: {
        code: error?.code ?? null,
        message: String(error?.message ?? error),
        denial: error?.sporadesAuthDenialLogData ?? null,
      },
    };
  }
}

// What the two copies of the migrated modules answer, as comparable text. The inspection gate over
// the statement probe, then the log-index guard over the same statements and over the row probe —
// the guard reads rows as well as SQL, and a check that only asked about SQL could not see half of
// it go missing. Then the mail domain, which answers a question in a different shape again: a
// configuration is judged by throwing rather than by returning a verdict, and a message is answered
// with the MIME text it assembles.
//
// Every migrated module needs a limb here or it is carried without being compared, which is the
// state this whole check exists to make unreachable. A batch that adds a module to
// `MIGRATED_RUNTIME_MODULES` and nothing to this function has bought the export-surface check and
// none of the behavioural one.
function describeMigratedModuleAnswers(module: any) {
  const absent = MIGRATED_MODULE_PROBE_NAMES.filter((name) => typeof module[name] !== "function");
  if (absent.length > 0) {
    throw bundleTemplateError(
      `Server bundle failed: the migrated runtime modules do not supply ${absent.join(", ")}, which the skew probe compares.`,
      "MIGRATED_RUNTIME_MODULES and MIGRATED_MODULE_PROBE_NAMES in server-bundle-template.ts are out of step. A module listed for carrying must still export what the probe asks it.",
    );
  }
  return [
    ...MIGRATED_MODULE_SKEW_PROBE.map((sql) =>
      JSON.stringify([
        sql,
        module.validateReadOnlyInspectionSql(sql),
        module.sqlWithoutTrailingTerminator(sql),
        module.targetsInternalLogIndexTable(sql),
        module.readSqlTableReference(sql, 0),
      ]),
    ),
    ...MIGRATED_MODULE_ROW_SKEW_PROBE.map(([row, sql]) =>
      JSON.stringify([row, sql, module.isInternalLogIndexMetadataRow(row, sql)]),
    ),
    ...MIGRATED_MODULE_MAIL_CONFIG_SKEW_PROBE.map((config) =>
      JSON.stringify([config, probedAnswer(() => module.validateMailConfig(config))]),
    ),
    // The `Date` header is `new Date().toUTCString()` and cannot be pinned from outside, so the two
    // copies are compared without it. Stripped rather than tolerated: a comparison that ignored any
    // line beginning `Date:` would also ignore one a skewed copy had emitted wrongly, and dropping
    // exactly one line keeps the rest of the message — every folded header, every encoded word, the
    // base64 body — under comparison.
    ...MIGRATED_MODULE_MAIL_MESSAGE_SKEW_PROBE.map((message) =>
      JSON.stringify([
        message.messageId,
        probedAnswer(() => {
          const mime = module.buildSmtpMessage(message);
          return typeof mime === "string"
            ? mime.split("\r\n").filter((line: string) => !line.startsWith("Date: ")).join("\r\n")
            : mime;
        }),
      ]),
    ),
    // The auth domain. Every call goes through `probedAnswer` rather than only `requireAuth`'s,
    // because `verifyEmailPassword` throws on a length mismatch its own guard is what prevents —
    // so a carried copy that had lost that guard reports as a disagreement here instead of failing
    // the build with `timingSafeEqual`'s message and no indication that two copies were compared.
    ...MIGRATED_MODULE_AUTH_CREDENTIAL_SKEW_PROBE.map(([password, salt, expected]) =>
      JSON.stringify([password, salt, expected, probedAnswer(() => module.verifyEmailPassword(password, salt, expected))]),
    ),
    ...MIGRATED_MODULE_AUTH_SKEW_PROBE.map(([name, args]) =>
      JSON.stringify([name, args, authProbedAnswer(() => module[name](...args))]),
    ),
    // The jobs and schedules domain. The schedule limb goes through `nextScheduleOccurrence`, which
    // reaches both of this module's private helpers on the way; see the probe's own comment.
    ...MIGRATED_MODULE_SCHEDULE_SKEW_PROBE.map(([expression, timezone, after]) =>
      JSON.stringify([
        expression,
        timezone,
        after,
        probedAnswer(() => {
          const fields = module.parseScheduleExpression(expression);
          return module.nextScheduleOccurrence(fields, new Date(after), timezone).toISOString();
        }),
      ]),
    ),
    ...MIGRATED_MODULE_SCHEDULE_DEFINITION_SKEW_PROBE.map(([schedules, jobNames]) =>
      JSON.stringify([
        schedules,
        probedAnswer(() =>
          module
            .scheduleDefinitionsFromCapsule({ schedules }, jobNames.map((name) => ({ name })))
            // `fields` is an array of `Set`s and serializes as `{}`, so it is replaced with a
            // comparable form rather than left to compare as nothing.
            .map((definition: any) => ({ ...definition, fields: definition.fields.map((set: Set<number>) => [...set]) })),
        ),
      ]),
    ),
    ...MIGRATED_MODULE_JOB_SKEW_PROBE.map(([name, args]) =>
      JSON.stringify([name, probedAnswer(() => module[name](...args))]),
    ),
    // The user-preferences domain. **Neither the patch nor the returned value is serialized** —
    // only the label and a verdict — and both halves of that are load-bearing rather than tidy.
    //
    // Two of the probe's patches cannot survive `JSON.stringify` at all, which is exactly why they
    // are refused. Serializing the *input* would throw on every build; serializing the *output*
    // would throw on precisely the builds where the JSON check had gone missing, turning the one
    // sabotage this limb exists to catch into a bare `TypeError` out of the middle of a bundle
    // build instead of a reported disagreement. That is not hypothetical: it is what this limb did
    // when it was first written, found by planting the missing check.
    //
    // The verdict keeps its teeth by comparing *identity* rather than a bare "admitted".
    // `normalizePreferencesPatch` returns its argument unchanged by contract, so a carried copy
    // that returned a rebuilt or filtered object would still be admitting the patch while quietly
    // changing what gets written to a user's preferences — and `admitted:rewrote` is a
    // disagreement where `admitted` would not have been.
    ...MIGRATED_MODULE_PREFERENCES_PATCH_SKEW_PROBE.map(([label, patch]) =>
      JSON.stringify([
        label,
        probedAnswer(() => (module.normalizePreferencesPatch(patch) === patch ? "admitted:same-reference" : "admitted:rewrote")),
      ]),
    ),
    JSON.stringify([
      "createUserPreferencesTables",
      probedAnswer(() => module.createUserPreferencesTables(MIGRATED_MODULE_PREFERENCES_STORAGE_PROBE)),
    ]),
    // The file and object storage domain, batch 6. Five limbs, because this domain answers in five
    // different shapes: a signature string, a canonical path or a verdict from a pure gate, a
    // constructed engine, a schema, and — through `maybe-promise.js`, which the DDL limb reaches —
    // a chained sequence.
    ...MIGRATED_MODULE_STORAGE_SIGNATURE_SKEW_PROBE.map(([label, request]) =>
      JSON.stringify([label, probedAnswer(() => module.s3Signature(request))]),
    ),
    ...MIGRATED_MODULE_STORAGE_PATH_SKEW_PROBE.map(([name, args]) =>
      JSON.stringify([name, args, probedAnswer(() => module[name](...args))]),
    ),
    // The engine constructors. Only the scalar surface is compared, because the methods are closures
    // — see `migratedModuleStorageEngineShape`. The local engine's one refusal is here too: it is a
    // one-line guard, and a copy that had lost it would build an adapter writing every File version
    // to a relative path off whatever the Capsule's working directory happened to be.
    ...MIGRATED_MODULE_STORAGE_ENGINE_SKEW_PROBE.map(([label, config]) =>
      JSON.stringify([
        label,
        probedAnswer(() => migratedModuleStorageEngineShape(module.createS3CompatibleFileStorageAdapter(config))),
      ]),
    ),
    ...[{ storagePath: "/data/files" }, { storagePath: "" }, {}].map((config) =>
      JSON.stringify([
        "createLocalFileStorageAdapter",
        config,
        probedAnswer(() => migratedModuleStorageEngineShape(module.createLocalFileStorageAdapter(config))),
      ]),
    ),
    JSON.stringify([
      "createFileStorageTables",
      probedAnswer(() => {
        const probe = migratedModuleStorageTableProbe();
        module.createFileStorageTables(probe.sqlite);
        return probe.statements;
      }),
    ]),
    // `maybe-promise.js`, asked directly rather than only through the limb above. A thenable is
    // reported as the token `promise` rather than awaited, because this function is synchronous.
    ...MIGRATED_MODULE_MAYBE_PROMISE_SKEW_PROBE.map(([label, value]) =>
      JSON.stringify([
        label,
        probedAnswer(() => module.isPromiseLike(value) === true),
        probedAnswer(() => {
          const answered = module.thenIfPromise(value, (resolved: unknown) => `then:${String(resolved)}`);
          return module.isPromiseLike(answered) ? "promise" : String(answered);
        }),
        probedAnswer(() => {
          const seen: string[] = [];
          const chained = module.chainMaybePromise([
            () => { seen.push("one"); return value; },
            () => { seen.push("two"); return null; },
          ]);
          return [seen.join(","), module.isPromiseLike(chained) ? "promise" : String(chained)];
        }),
      ]),
    ),
    // Batch 7's two non-domain modules, asked directly. Both are also reached through the ACL
    // limbs — `aclRowLogSnapshot` filters field names with `isSensitiveLogKey`, and the ACL helper
    // state limb reads a row back through `deserializeRow` — but a limb that reached them only
    // that way would report a skew in either of them under an ACL heading, and would go missing
    // entirely if the ACL limbs were ever narrowed.
    ...MIGRATED_MODULE_LOG_POLICY_SKEW_PROBE.map(([name, args]) =>
      JSON.stringify([name, args, probedAnswer(() => module[name](...args))]),
    ),
    ...MIGRATED_MODULE_ROW_DECODING_SKEW_PROBE.map(([name, args]) =>
      JSON.stringify([name, args, probedAnswer(() => module[name](...args))]),
    ),
  ];
}

// Every region that has left the monolith, carried into the bundle as those modules' own compiled
// text rather than as `fn.toString()` over a list of their functions.
//
// **Why a migrated region is carried differently.** A stringified function reaches the bundle without
// anything it closes over, so under the emitted-list mechanism a helper had to be registered in
// `SERVER_RUNTIME_SOURCE_FUNCTIONS` to survive — and the inspection gate paid for that in five
// duplicated copies of one set of comment and quoting rules, four independent reviews and five
// rounds of fixes (ADR-0038). Carrying a module whole removes the registration step for that
// region: a private helper travels because it is in the file, not because someone remembered it.
// ADR-0041 records the decision. Everything that has not migrated still travels through the list.
//
// The modules are compiled to an IIFE by esbuild rather than concatenated with their `export`
// keywords stripped, and the reason is privacy rather than safety. Concatenation would be *loud* if
// it collided: the generated bundle is an ES module — it imports `node:crypto` and uses top-level
// `await` — and a duplicate top-level `function` or `const` there is a load-time `SyntaxError`, which
// is exactly what a duplicate entry in the emitted list produces and why none is left there. What
// concatenation would cost is the thing this whole change is for: every one of these modules' private
// helpers would land at the bundle's top level, reachable from 500-odd runtime functions, so
// "private" would stop meaning anything at the point it started to matter. Inside the IIFE it does.
// Not stripping `export` keywords out of generated JavaScript by hand is the second reason.
//
// **`build`, not `transformSync`, and this is the batch that forced the change.** ADR-0041 proved
// the carrier for one module that imports nothing, and named the boundary: `transformSync` is a
// format conversion of one file and resolves nothing, so given a module with an import of its own it
// emits a `require(…)` into the IIFE and the Capsule dies at boot with "Cannot determine intended
// module format". `log-index-guard` imports the inspection gate's tokenizer, so it is the first
// region to cross that line. Every later batch will cross it too — the domains left in the monolith
// call each other.
//
// **One block for all of them, rather than one block each**, and the reason is that bundling each
// module separately would inline `inspection-sql` into every block that imports it. Two copies of
// the one tokenizer inside the shipped artifact cannot drift — they come from the same file in the
// same build — but ADR-0038's whole subject is that the duplication *itself* is the defect
// generator, and an artifact that contradicts it teaches the next reader the wrong thing. Bundled
// together there is one copy of each module, whatever imports what.
//
// `buildSync` rather than `build`, so `createServerBundleSource` stays synchronous; every caller and
// three test files expect that. The cost ADR-0041 measured for `transformSync` applies here too: the
// esbuild binary runs out of process and the first call in a process pays for the spawn.
function migratedRuntimeModulesSource() {
  return migratedRuntimeModulesBlockFrom(path.join(resolveSporadesPackageRoot(), "dist"));
}

// The block, and the checks that decide whether the copies it was built from are the copies this
// process is running. Takes the directory rather than reading a fixed one, so that a test can drive
// it against a deliberately skewed tree without touching the tree the suite is running out of.
//
// A directory and not the file contents, which is what this took before it bundled: `buildSync`
// accepts no plugins, so there is no way to hand esbuild an in-memory module graph. Handing it a
// directory is also the more faithful seam — a skewed copy is now resolved by the same import the
// real build resolves, so a skew that breaks the import between two migrated modules fails here for
// the same reason it would fail in a release.
export function migratedRuntimeModulesBlockFrom(distDir: string) {
  // One synthetic entry re-exporting each migrated module, so the block's export surface is their
  // union and esbuild resolves the imports between them exactly once.
  const entry = MIGRATED_RUNTIME_MODULES.map(({ file }) => `export * from ${JSON.stringify(`./${file}`)};`).join("\n");

  let result;
  try {
    result = buildSync({
      bundle: true,
      format: "iife",
      globalName: MIGRATED_MODULES_NAMESPACE,
      platform: "node",
      target: "node22",
      write: false,
      metafile: true,
      logLevel: "silent",
      // esbuild labels every inlined module with its path relative to the working directory, and
      // those labels are comments in the text that ships. Pinned to the directory being read so a
      // Capsule bundle carries `inspection-sql.js` rather than whoever's absolute home directory the
      // CLI was invoked from, and so the same inputs build identically on two machines.
      absWorkingDir: distDir,
      stdin: {
        contents: entry,
        sourcefile: path.join(distDir, "__sporades-migrated-runtime-modules__.js"),
        resolveDir: distDir,
        loader: "js",
      },
    });
  } catch (error: any) {
    // A file that will not parse or an import that will not resolve — a truncated write and a
    // half-updated `dist/` are the ordinary ways to get each. esbuild's own error names the position,
    // and it is worth nothing to a person without the hint beside it.
    throw bundleTemplateError(
      `Server bundle failed: the migrated runtime modules in ${distDir} did not build: ${error?.errors?.map((entry: any) => entry.text).join("; ") || error?.message || String(error)}`,
      "A file under dist/ is truncated or corrupt. Run `npm run build`, or reinstall the Sporades CLI.",
    );
  }

  // ADR-0040: a deployed Capsule runs `node /app/server.mjs` in an image with no `node_modules`, so
  // this block must resolve nothing at runtime that the image cannot supply. Asked of esbuild's
  // metafile rather than of the text, because this is exactly where the property stops holding by
  // construction: the moment a migrated module imports something outside this list, `format: "iife"`
  // emits a `require(…)` for it and the Capsule dies at boot rather than at build.
  //
  // **One kind of external is allowed, and only because it is not lowered.** A *static* import — of a
  // package or of a builtin, it makes no difference — becomes `__require("node:crypto")`, which
  // throws `Dynamic require of "node:crypto" is not supported` on the first line of a bundle that is
  // an ES module. That was executed, not assumed, and it is why the mail domain reaches the Web
  // Crypto global instead of importing `randomUUID`. A *dynamic* `import(…)` is different in kind:
  // esbuild emits it verbatim, so `await import("node:tls")` survives into the block as itself and a
  // deployed Capsule resolves it exactly as it resolves the bundle's own top-level
  // `import … from "node:crypto"`. The mail transport has opened its TLS and TCP sockets that way
  // since long before any of this, through the same text, and refusing it here would have forced
  // that one function to stay behind in the monolith for a reason that does not exist.
  //
  // So the rule is narrower than "no externals" and stricter than the module-graph builder's: a
  // dynamic import of a Node builtin, and nothing else. A dynamic import of a *package* is still
  // refused — it survives verbatim too, and then finds no `node_modules` in the image.
  //
  // ADR-0041 named this as the untested case; batch 2 is where it was executed. `isBuiltin` rather
  // than a `node:` prefix test, matching `createServerBundleModuleSource`: an unprefixed `tls`
  // resolves in the container exactly as well as `node:tls` does.
  const unresolved = Object.values(result.metafile.outputs)
    .flatMap((entry) => entry.imports)
    .filter((entry) => entry.external && !(entry.kind === "dynamic-import" && isBuiltin(entry.path)))
    .map((entry) => entry.path);
  if (unresolved.length > 0) {
    throw bundleTemplateError(
      `Server bundle failed: the migrated runtime modules would resolve ${[...new Set(unresolved)].sort().join(", ")} at runtime.`,
      "A migrated runtime module may import another migrated module, or a Node builtin through a dynamic `import(…)`. A static import of anything outside the migrated set becomes a `require(…)` the bundle cannot execute: add the dependency to MIGRATED_RUNTIME_MODULES, or inline what it needs.",
    );
  }

  const code = result.outputFiles?.[0]?.text;
  if (!code) {
    throw bundleTemplateError(
      "Server bundle failed: esbuild produced no text for the migrated runtime modules.",
      "Report this: the Sporades migrated runtime modules produced no output.",
    );
  }

  // **Two copies of these modules exist while the CLI is a bundle, and they are checked against each
  // other here.** `bin/sporades.js` is built by esbuild from `src/`, so the namespaces imported at
  // the top of this file are copies inlined into `bin/`, while the text just built comes from
  // `dist/` on disk. Running from `dist/` there is one copy and the question does not arise; running
  // from `bin/` a tree whose `dist/` and `bin/` came from different builds would ship the `dist/`
  // gate inside a Capsule while every other runtime function in that same Capsule came from `bin/`.
  //
  // Nothing in `scripts/` compares those for freshness — `check-generated-bin.mjs` checks the
  // shebang, the generated header and the absence of `../src/` imports, and an earlier version of
  // this comment claimed a freshness check it does not perform. So the comparison is made here,
  // against the copy that will actually be carried rather than against the files it came from.
  const carried = evaluateMigratedModulesBlock(code);

  // The names the rest of the bundle resolves against, taken from the carried namespace itself. A
  // name that the block does not export cannot be destructured from it, so "declared here, absent
  // there" is not a state this can reach. Written out by hand instead, a misspelling would declare a
  // binding that is simply `undefined` at runtime, which the free-binding guard resolves exactly as
  // cleanly as a correct one.
  const exported = Object.keys(carried).sort();
  const loaded = [...new Set(MIGRATED_RUNTIME_MODULES.flatMap(({ loaded: module }) => Object.keys(module)))].sort();
  if (exported.join(",") !== loaded.join(",")) {
    const missing = loaded.filter((name) => !exported.includes(name));
    const extra = exported.filter((name) => !loaded.includes(name));
    throw bundleTemplateError(
      `Server bundle failed: the migrated runtime modules in ${distDir} export a different set of names than the running CLI's copies of them`
        + `${missing.length ? `; missing ${missing.join(", ")}` : ""}${extra.length ? `; unexpected ${extra.join(", ")}` : ""}.`,
      "dist/ and bin/ are from different builds. Run `npm run build`, or reinstall the Sporades CLI.",
    );
  }

  // And the same names are not enough, because the shape that matters most keeps them: a carried copy
  // whose validator body had been replaced would export exactly this list and admit everything. So
  // the two copies are asked the same questions and must answer identically.
  //
  // This is a probe, not a proof, and the difference is worth stating rather than leaving to be
  // discovered: two copies that agree on the export surface and on every question below still ship,
  // however else they differ. What it does close is the case that is otherwise silent.
  const loadedModule = Object.assign({}, ...MIGRATED_RUNTIME_MODULES.map(({ loaded: module }) => ({ ...module })));
  const carriedAnswers = describeMigratedModuleAnswers(carried);
  const loadedAnswers = describeMigratedModuleAnswers(loadedModule);
  const disagreement = carriedAnswers.findIndex((answer, index) => answer !== loadedAnswers[index]);
  if (disagreement >= 0) {
    throw bundleTemplateError(
      // Not "the read-only inspection surface" any more. That is what the probe was when the only
      // migrated modules were the inspection gate and the log-index guard, and it became wrong the
      // moment a mail disagreement started reporting itself under an inspection heading.
      `Server bundle failed: the migrated runtime modules in ${distDir} answer the skew probe differently `
        + `than the running CLI's copies of them, starting at ${carriedAnswers[disagreement]}.`,
      "dist/ and bin/ are from different builds. Run `npm run build`, or reinstall the Sporades CLI.",
    );
  }

  return `${code}\nconst { ${exported.join(", ")} } = ${MIGRATED_MODULES_NAMESPACE};`;
}

export function createServerBundleSource({
  config, 
  serverEnv, 
  sealedServerEnv = { enabled: false }, 
  serverSource, 
  serverModuleSource 
}: {
  config: any;
  serverEnv: any;
  sealedServerEnv?: any;
  serverSource: string;
  serverModuleSource: string;
}) {
  const runtimeFunctions = SERVER_RUNTIME_SOURCE_FUNCTIONS
    .map((fn) => fn.toString())
    .join("\n\n");
  const publicTreeContract = [
    `const PUBLIC_TREE_LIMITS = ${JSON.stringify(PUBLIC_TREE_LIMITS)};`,
    normalizePublicTreePath.toString(),
    publicTreePathFromRequest.toString(),
  ].join("\n\n");
  // The read-only inspection gate's three keyword tables used to be serialized into a preamble here,
  // because a runtime function reaches the bundle as its own source text and a module-level binding
  // it closes over does not follow. They are declarations inside `migratedModules` now, and the
  // gate's own functions close over them there exactly as they do in `dist/`, so serializing them
  // again would declare each name twice. They are still reachable by name at the bundle's top level
  // through the destructuring that block ends with, which is what the constant probe in
  // `test/server-bundle-module-graph.test.js` reads them through. A migrated domain's own constants
  // travel the same way, which is why nothing was added to the preamble below when the log-index
  // guard moved.
  const migratedModules = migratedRuntimeModulesSource();
  // The runtime's module-level constants, for the same reason as the keyword tables above: a
  // runtime function reaches the bundle as its own source text and a module-level binding it closes
  // over does not follow. Each is serialized from the runtime source's own declaration rather than
  // restated here, so a threshold is written in exactly one place and changing it there changes
  // what a deployed Capsule enforces. Several of these are security thresholds, and a restated copy
  // that drifted would be silent — the free-binding guard resolves names, and a wrong value
  // resolves exactly as cleanly as a right one.
  //
  // **Twelve entries left this list in batch 3, and they had to leave in the same commit that moved
  // them.** `PRIVILEGED_AUTH_USER_ID`, the four `EMAIL_SIGN_IN_THROTTLE*` thresholds, the six
  // `PASSWORD_RESET_*` bounds and `PASSWORD_RESET_MAIL_JOB` are declarations inside
  // `auth-runtime.js` now, and that module's text is spliced in immediately below this preamble.
  // Serializing them here as well would declare each name twice at the top level of an ES module,
  // which is a load-time `SyntaxError` in a deployed Capsule rather than a drift — the same hazard
  // that keeps a migrated function out of the emitted list. They are still reachable by name at the
  // bundle's top level through the destructuring the carried block ends with, which is how the
  // still-monolithic `resolvePasswordResetConfig`, `sendEmailPasswordResetLink` and
  // `runtimeOwnedJobHandlers` resolve them, and how the constant probe in
  // `test/server-bundle-module-graph.test.js` reads them.
  //
  // **`RESERVED_JOB_NAME_PREFIX` left in batch 4, for exactly the same reason and with the same
  // constraint.** It is a declaration in `jobs-runtime.js` now, whose text is spliced in below this
  // preamble alongside `auth-runtime.js`'s, so serializing it here as well would declare the name
  // twice. `isReservedJobName` is its only reader and moved with it; it stays exported so the
  // carried block destructures it and so the constant probe keeps comparing it.
  //
  // The four that remain are the ones whose domain has not migrated: the privileged-audit trio and
  // `ACL_HELPER_STATE` are batch 6's.
  const runtimeConstants = ([
    ["PRIVILEGED_AUDIT_SCHEMA", PRIVILEGED_AUDIT_SCHEMA],
    ["PRIVILEGED_AUDIT_ACTOR_KINDS", PRIVILEGED_AUDIT_ACTOR_KINDS],
    ["PRIVILEGED_AUDIT_OUTCOMES", PRIVILEGED_AUDIT_OUTCOMES],
    ["ACL_HELPER_STATE", ACL_HELPER_STATE],
  ] as [string, unknown][])
    .map(([name, value]) => `const ${name} = ${serializeRuntimeConstant(value)};`)
    .join("\n");
  const serverModuleDataUrl = `data:text/javascript;base64,${Buffer.from(serverModuleSource, "utf8").toString("base64")}`;

return `// Sporades server bundle
import { createDecipheriv, createHash, createHash as createHash2, createHmac, createPrivateKey, privateDecrypt, randomBytes, randomBytes as randomBytes2, randomUUID, scryptSync, sign, timingSafeEqual, verify } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readFileSync as readFileSync2 } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

export const sporadesConfig = ${JSON.stringify(config, null, 2)};
export const sporadesServerEnv = ${JSON.stringify(serverEnv, null, 2)};
export const sporadesSealedServerEnv = ${JSON.stringify(sealedServerEnv, null, 2)};
export const sporadesServerSource = ${JSON.stringify(serverSource)};
const sporadesActionIndex = process.argv.indexOf("--sporades-action");
const sporadesAction = sporadesActionIndex < 0 ? null : process.argv[sporadesActionIndex + 1];
const sporadesCapsuleModule = sporadesAction ? null : await import(${JSON.stringify(serverModuleDataUrl)});
const sporadesCapsuleDefinition = sporadesCapsuleModule?.default ?? null;
${runtimeConstants}
${migratedModules}
${runtimeFunctions}
${publicTreeContract}

const port = Number(process.env.PORT ?? sporadesConfig.deploy?.port ?? 4000);
const databasePath = process.env.SPORADES_DATABASE_PATH ?? path.join(process.cwd(), "data", "data.db");
const runtimeConfig = {
  ...sporadesConfig,
  __sporadesSession: process.env.SPORADES_SECURITY_SESSION ?? sporadesConfig.__sporadesSession,
  __sporadesPublicOrigin: process.env.SPORADES_PUBLIC_ORIGIN ?? sporadesConfig.__sporadesPublicOrigin,
};
const runtimeServerEnv = await readRuntimeServerEnv(sporadesServerEnv, sporadesSealedServerEnv);
const runtimeServiceEnv = readRuntimeServiceEnv();
if (sporadesAction) {
  if (!['jobs.inspect', 'schedules.inspect'].includes(sporadesAction)) {
    process.stdout.write(JSON.stringify({ ok: false, data: null, error: { message: "Unsupported Sporades runtime action.", hint: "Upgrade the Sporades CLI and generated Bundle together." } }) + "\\n");
    process.exit(1);
  }
  const adapter = await createRuntimeInspectionAdapter(databasePath, runtimeServiceEnv, runtimeConfig);
  try {
    const items = adapter ? await (sporadesAction === 'jobs.inspect' ? inspectRuntimeJobs(adapter) : inspectRuntimeSchedules(adapter)) : [];
    const key = sporadesAction === 'jobs.inspect' ? 'jobs' : 'schedules';
    process.stdout.write(JSON.stringify({ ok: true, data: { capsule: { name: sporadesConfig.name }, [key]: items }, error: null }) + "\\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, data: null, error: { code: error.code ?? (sporadesAction === 'jobs.inspect' ? "JOB_INSPECTION_FAILED" : "SCHEDULE_INSPECTION_FAILED"), message: error.message, hint: error.hint, ...(error.jobId ? { jobId: error.jobId, field: error.field } : {}), ...(error.scheduleName ? { scheduleName: error.scheduleName, field: error.field } : {}) } }) + "\\n");
    process.exitCode = 1;
  } finally { await adapter?.close(); }
  process.exit();
}
const database = await openDevDatabase(databasePath, sporadesServerSource, runtimeServerEnv, runtimeConfig, sporadesCapsuleDefinition, {
  serviceEnv: runtimeServiceEnv,
});
await database.init();
database.log.emit({
  category: "platform",
  event: "runtime.started",
  level: "info",
  message: "Capsule runtime started",
  data: { diagnostics: database.runtimeDiagnostics },
  release: process.env.SPORADES_RELEASE_ID ? { id: process.env.SPORADES_RELEASE_ID } : null,
});
const websocketHub = createWebSocketHub(() => database);
const runtimePublicRoot = resolveRuntimePublicRoot();

const server = createServer(async (request, response) => {
  try {
    if (prepareHttpSecurity(database, request, response)) {
      return;
    }

    if (await routeRuntimeHealth(database, request, response)) {
      return;
    }

    if (await routeSporadesAuth(database, request, response)) {
      return;
    }

    if (await handleFileHttpRoute(database, request, response, websocketHub)) {
      return;
    }

    if (await routeEndpoint(database, request, response)) {
      return;
    }

    if (await routePublicAsset(request, response, runtimePublicRoot, websocketHub)) {
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  } catch (error) {
    writeUnhandledHttpError(database, request, response, error);
  }
});

server.on("upgrade", (request, socket) => {
  const requestUrl = new URL(request.url, "http://127.0.0.1");
  if (requestUrl.pathname !== "/__sporades/ws") {
    socket.destroy();
    return;
  }
  websocketHub.accept(request, socket);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "0.0.0.0", resolve);
});

let shutdownStarted = false;
const shutdown = async () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  websocketHub.disconnectAll();
  await database.shutdown();
  server.close(() => {
    database.close();
    process.exit(0);
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function resolveRuntimePublicRoot() {
  const mounted = path.join(process.cwd(), "public");
  if (process.cwd() === "/app") return mounted;
  return resolveActiveRuntimePublicRoot() ?? mounted;
}

function resolveActiveRuntimePublicRoot() {
  try {
    const treesDir = path.join(process.cwd(), ".sporades", "build", ".public-trees");
    const treesStats = lstatSync(treesDir);
    const referencePath = path.join(treesDir, "active.json");
    const referenceStats = lstatSync(referencePath);
    const tree = JSON.parse(readFileSync(path.join(treesDir, "active.json"), "utf8"))?.tree;
    if (!/^[1-9][0-9]*-[0-9]{10,}-[a-f0-9]{8,}$/.test(tree)) return null;
    const candidate = path.join(treesDir, tree);
    const candidateStats = lstatSync(candidate);
    const indexStats = lstatSync(path.join(candidate, "index.html"));
    if (
      treesStats.isDirectory() && !treesStats.isSymbolicLink()
      && referenceStats.isFile() && !referenceStats.isSymbolicLink()
      && candidateStats.isDirectory() && !candidateStats.isSymbolicLink()
      && indexStats.isFile() && !indexStats.isSymbolicLink()
    ) return candidate;
  } catch {}
  return null;
}

async function routePublicAsset(request, response, publicRoot, hub) {
  const rawPathname = String(request.url ?? "/").split("?", 1)[0];
  const relativePath = publicTreePathFromRequest(rawPathname);
  if (relativePath === null) return false;
  const filePath = path.join(publicRoot, ...relativePath.split("/"));
  const stats = await lstat(filePath).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink()) return false;
  const body = await readFile(filePath);
  const html = relativePath === "index.html";
  response.writeHead(200, { "content-type": publicContentType(relativePath) });
  response.end(html ? injectPageConnectionToken(body.toString("utf8"), hub.createConnectionToken()) : body);
  return true;
}

function publicContentType(relativePath) {
  switch (path.extname(relativePath).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": case ".mjs": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": case ".map": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".ico": return "image/x-icon";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

async function readRuntimeServerEnv(fallbackEnv, sealed) {
  let env;
  if (!sealed?.enabled) {
    env = fallbackEnv;
  } else {
    const envelopePath = process.env.SPORADES_SEALED_SERVER_ENV_PATH ?? path.join(process.cwd(), ".sporades", "sealed-server-env", "server-env.sealed.json");
    const privateKeyPath = process.env.SPORADES_SEALED_SERVER_ENV_PRIVATE_KEY_PATH ?? path.join(process.cwd(), ".sporades", "sealed-server-env", "server-env.private.pem");
    const [envelopeRaw, privateKey] = await Promise.all([readFile(envelopePath, "utf8"), readFile(privateKeyPath, "utf8")]);
    env = unsealRuntimeServerEnv(JSON.parse(envelopeRaw), privateKey);
  }
  return env;
}

function readRuntimeServiceEnv() {
  const keys = [
    "SPORADES_SERVICE_DATABASE_ENGINE",
    "SPORADES_SERVICE_DATABASE_URL",
    "SPORADES_SERVICE_DATABASE_AUTH_TOKEN",
    "SPORADES_SERVICE_STORAGE_ENGINE",
    "SPORADES_SERVICE_STORAGE_ENDPOINT",
    "SPORADES_SERVICE_STORAGE_ACCESS_KEY",
    "SPORADES_SERVICE_STORAGE_SECRET_KEY",
    "SPORADES_SERVICE_STORAGE_BUCKET",
    "SPORADES_SERVICE_STORAGE_REGION",
    "SPORADES_SERVICE_STORAGE_NAMESPACE",
  ];
  return Object.fromEntries(keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}

function unsealRuntimeServerEnv(envelope, privateKey) {
  const values = {};
  for (const [key, entry] of Object.entries(envelope.entries ?? {})) {
    const dataKey = privateDecrypt(privateKey, Buffer.from(entry.encryptedKey, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(entry.iv, "base64"));
    decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
    values[key] = Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
  return values;
}
`;
}
