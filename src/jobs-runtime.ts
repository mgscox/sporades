// The Capsule runtime's jobs and schedules domain: the Job Queue's storage, cursors, retry
// normalization and inspection, and the Schedule machinery — cron parsing, timezone resolution,
// occurrence calculation, the payload-factory concurrency lanes and the runtime clock both depend
// on. Batch 4 of the migration ADR-0041 records. Apart from the one line named below, every body
// here is byte-identical to the one that stood in `server-runtime-source.ts`.
//
// **Jobs and schedules are one module and not two**, because they share the queue and the
// occurrence machinery: `scheduleDefinitionsFromCapsule` validates a Schedule by resolving the Job
// it names and bounding its payload with `boundedJobJson`, and `resolveSchedulePayload` turns an
// occurrence into a Job payload. Splitting them would put that shared surface on a module boundary.
//
// **What moved and what did not.** The domain is 52 declarations by inspection — 51 functions and
// `RESERVED_JOB_NAME_PREFIX`. Thirty-five are here; seventeen stayed behind, and the reference
// graph says exactly why. Closing the domain leaves three things outside it:
//
//   - `createMutationContext`, which is the composition point where every domain's API is wired
//     into one context object, and which ticket 04 says is what `server-runtime-source.ts` retains.
//     `runCurrentUserJobWorker` and `enqueueScheduledOccurrence` build a handler context with it,
//     and through those two it blocks `scheduleCurrentUserJobWorker`, `scheduleNextDelayedJob`,
//     `enqueueRuntimeJob`, `flushPendingJobEnqueues`, `recoverExpiredJobLeases`,
//     `createCurrentUserJobApi`, `recordScheduledOccurrence`, `recoverPendingScheduleOccurrences`,
//     `schedulePendingOccurrenceRecovery`, `claimScheduledOccurrence`, `reconcileSchedules` and
//     `startStaticSchedules`.
//   - `hasPrivilegedDbAccess`, which is the ACL and privileged-audit domain — batch *7*, not 6, as
//     this said before that batch ran. It blocked `assertActivePrivilegedJobAccess` and through it
//     `createPrivilegedJobApi` and `createPrivilegedScheduleApi`. Batch 7 cleared two of the three:
//     `assertActivePrivilegedJobAccess` and `createPrivilegedScheduleApi` are in `acl-runtime.js`
//     now. `createPrivilegedJobApi` is not, and the reason is this module's own blocker rather than
//     that one — it reaches `createCurrentUserJobApi`, which is in the list above.
//   - `assertJsonCompatible`, which is in `runtime-errors.js` as of this batch. It is not a later
//     batch: thirteen call sites and one of them is a Job. See that module for why.
//
// A migrated module may not import from the monolith, so those seventeen follow their blockers.
// **`enqueueRuntimeJob` is among them, so this batch does not unblock batch 3's
// `sendEmailPasswordResetLink`** — auth's blocker moved one link down the chain rather than away.
//
// **What is exported and what is not.** Thirty of the thirty-five are exported and five are
// private. The exports are not a designed interface — they are the names something outside this
// file still resolves: what the seventeen stranded functions call, what `openDevDatabase` wires at
// startup, what `server-bundle-entry.ts` reaches for the two `--sporades-action` inspections, and
// what the suites import. **Four of those names are reached only from test files**
// (`createControllableRuntimeClock`, `ensureJobStorage`, `ensureScheduleStorage`,
// `parseScheduleExpression`), so a closure derived from the monolith alone would have made them
// private and broken the suite; the export set is derived from a repo-wide scan for that reason.
//
// The five private ones are private because nothing outside the domain ever named them. Under the
// emitted list each had to be registered in `SERVER_RUNTIME_SOURCE_FUNCTIONS` or become a
// `ReferenceError` in a deployed Capsule, so "private" was not a thing this domain could be.
//
// **Why `node:crypto` is reached through `process.getBuiltinModule` and not imported.** ADR-0042,
// and the same argument as the auth domain's. `scheduledOccurrenceIdentity` is synchronous — it is
// called from inside a transaction to derive an occurrence's idempotency key — and the emitted-list
// bundle carries this module as one esbuild IIFE, where a *static* external import lowers to
// `__require("node:crypto")` and the Capsule dies at boot. The one call site carries the
// `nodeCryptoModule.` prefix and is the only line here that is not byte-identical to the region it
// moved out of.

import { assertJsonCompatible, commandError } from "./runtime-errors.js";
import { PASSWORD_RESET_MAIL_JOB, PASSWORD_RESET_REQUEST_JOB, privilegedAuthUserId } from "./auth-runtime.js";
import { TEAM_BILLING_CHECKOUT_EXPIRY_JOB, TEAM_BILLING_CHECKOUT_JOB, TEAM_BILLING_PORTAL_EXPIRY_JOB, TEAM_BILLING_PORTAL_JOB } from "./team-billing-runtime.js";
import { TEAM_BILLING_ERASURE_JOB } from "./team-billing-erasure.js";
import { TEAM_BILLING_PLAN_TRANSITION_JOB, TEAM_BILLING_SEAT_CONVERGENCE_JOB } from "./team-billing-management.js";

// Synchronous access to a Node builtin without an import — see the header. Bound as one namespace
// and **not destructured**: `bin/sporades.js` is the whole of `src/` in one esbuild scope, so a
// top-level `const { createHash } = …` here would collide with `server-runtime-source.ts`'s
// `import … from "node:crypto"` and esbuild would rename one side. That is the defect batch 2
// shipped with `randomUUID` (ADR-0041), and the collision guard refuses it by name.
//
// `auth-runtime.ts` declares this same name, so esbuild *does* rename one of the two — to
// `nodeCryptoModule2`, in `bin/sporades.js` and again inside the carried IIFE. That is safe where
// the monolith case is not, and the difference is what carries the name: a private module-scope
// binding never leaves its module, so the declaration and its uses are renamed together, while a
// stringified runtime function carries the *text* of a name whose binding stayed behind. Verified
// rather than assumed — the generated bundle declares both names and every use resolves. See
// ADR-0041 for why an *exported* collision between two migrated modules would not be safe.
const nodeCryptoModule = process.getBuiltinModule("node:crypto");

// The monolith's own aliases, redeclared rather than imported: they are types, so they are erased
// before either bundle is built and there is no binding to collide with.
type LooseRecord = Record<string, any>;
type RuntimeConfig = LooseRecord;


// The prefix that marks a Job name as runtime-owned rather than user-declared, so a Capsule cannot
// declare a Job that shadows one the runtime enqueues for itself. `isReservedJobName` is the only
// reader and it is private, but this is exported for two reasons, both load-bearing.
//
// It stood in `server-runtime-source.ts` and was serialized into the generated bundle's constant
// preamble, because a runtime function reaches that bundle as its own source text and the
// module-level bindings it closes over do not follow. **It is not in the preamble any more, and it
// left in the same commit that moved it here**: this module's compiled text is spliced into the
// bundle right after that preamble, so serializing it there as well would declare the name twice at
// the top level of an ES module — a load-time `SyntaxError` in a deployed Capsule rather than a
// drift. It is still reachable at the bundle's top level through the destructuring the carried
// block ends with.
//
// The carried block only destructures what this module exports, so a private one would not reach
// the bundle at all; and the two-bundle constant probe in `test/server-bundle-module-graph.test.js`
// derives what it compares from the SCREAMING_CASE *exports* re-exported through
// `server-runtime-source.js` — so making it private would not fail that probe, it would silently
// stop comparing this value between the two bundles.
export const RESERVED_JOB_NAME_PREFIX = "_sporades";
export const STRIPE_EVENT_JOB = "_sporades.stripe-event";
export const STRIPE_EVENT_PAYLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const STRIPE_EVENT_PAYLOAD_CLEANUP_BATCH_SIZE = 100;

const REDACTED_STRIPE_EVENT_PAYLOAD = JSON.stringify({ kind: "stripe-event", retained: false });
const STRIPE_EVENT_PAYLOAD_SENTINEL_CURSOR_KEY = "stripe-event-payload-retention-sentinel-cursor-v1";
const STRIPE_EVENT_PAYLOAD_UNREPRESENTABLE_DEADLINE = "~";
const STRIPE_EVENT_PAYLOAD_SENTINEL_RECHECK_MS = 24 * 60 * 60 * 1_000;
const STRIPE_EVENT_PAYLOAD_CLEANUP_RETRY_MS = 1_000;
const STRIPE_EVENT_PAYLOAD_TIMER_CHUNK_MS = 2_147_483_647;

function parseStripeEventPayloadSentinelMaintenance(value: unknown) {
  if (typeof value !== "string") return { afterId: "", recheckAt: null };
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && typeof parsed.afterId === "string") {
      return {
        afterId: parsed.afterId,
        recheckAt: isCanonicalJobTimestamp(parsed.recheckAt) ? parsed.recheckAt : null,
      };
    }
  } catch {
    // The first cursor release stored the opaque key directly. Read it as an additive migration.
  }
  return { afterId: value, recheckAt: null };
}

function serializeStripeEventPayloadSentinelMaintenance(afterId: string, recheckAt: string | null) {
  return JSON.stringify({ afterId, recheckAt });
}

export function stripeEventPayloadRetentionDeadline(settledAt: string) {
  if (!isCanonicalJobTimestamp(settledAt)) return null;
  return jobTimestampAfter(new Date(settledAt), STRIPE_EVENT_PAYLOAD_RETENTION_MS);
}

export function stripeEventPayloadRetentionStorageValue(settledAt: string) {
  const deadline = stripeEventPayloadRetentionDeadline(settledAt);
  if (deadline !== null) return deadline;
  return isCanonicalJobTimestamp(settledAt) ? STRIPE_EVENT_PAYLOAD_UNREPRESENTABLE_DEADLINE : "";
}

/** Internal privacy maintenance for the reserved Stripe Event Job only. */
export async function cleanupExpiredStripeEventPayloads(database: LooseRecord, options: LooseRecord = {}) {
  const batchSize = options.batchSize ?? STRIPE_EVENT_PAYLOAD_CLEANUP_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > STRIPE_EVENT_PAYLOAD_CLEANUP_BATCH_SIZE) {
    throw jobError("STRIPE_EVENT_PAYLOAD_CLEANUP_INVALID", "Invalid Stripe Event payload cleanup batch.", "Use the runtime-owned bounded cleanup batch.");
  }
  const adapter = database.adapter;
  const sql = adapter.dialect.sql;
  const nowIso = database.clock.now().toISOString();
  let assignedCount = 0;
  let classifiedCount = 0;
  let redactedCount = 0;
  let remaining = batchSize;
  let sentinelScanPending = false;
  let sentinelRecheckAt: string | null = null;

  // Expired deadlines have privacy priority over legacy classification. Every successful CAS,
  // regardless of mutation kind, consumes this invocation's one shared budget.
  const due = await adapter.prepare(sql(
    "SELECT [id], [completedAt], [payloadRetentionUntil] FROM [sporades_jobs] WHERE [handler]=? " +
    "AND [status]='succeeded' AND [payloadRedactedAt] IS NULL AND [payloadRetentionUntil] IS NOT NULL AND [payloadRetentionUntil] <> '' " +
    "AND [payloadRetentionUntil] <= ? ORDER BY [payloadRetentionUntil] ASC, [id] ASC LIMIT ?",
  )).all(STRIPE_EVENT_JOB, nowIso, remaining);
  for (const row of due) {
    // Status, exact deadline, settlement time and absent claim form the CAS. Concurrent runtimes
    // cannot cross a retry/lease transition or redact work that has become unresolved.
    const changed = await adapter.prepare(sql(
      "UPDATE [sporades_jobs] SET [payload]=?, [result]=NULL, [payloadRedactedAt]=? " +
      "WHERE [id]=? AND [handler]=? AND [status]='succeeded' AND [completedAt]=? " +
      "AND [payloadRedactedAt] IS NULL AND [payloadRetentionUntil]=? " +
      "AND [payloadRetentionUntil] <= ? AND [claimToken] IS NULL AND [leaseExpiresAt] IS NULL",
    )).run(REDACTED_STRIPE_EVENT_PAYLOAD, nowIso, row.id, STRIPE_EVENT_JOB, row.completedAt, row.payloadRetentionUntil, nowIso);
    const mutations = Number(changed?.changes ?? 0);
    redactedCount += mutations;
    remaining -= mutations;
  }

  // A durable opaque Job-row cursor makes the bounded sentinel scan fair without relying on
  // dialect-specific date parsing. Invalid candidates advance the cursor but consume no Job
  // mutation budget; JavaScript remains the canonical timestamp authority.
  const cursorRow = await adapter.prepare(sql(
    "SELECT [value] FROM [sporades] WHERE [key]=?",
  )).get(STRIPE_EVENT_PAYLOAD_SENTINEL_CURSOR_KEY);
  let observedMaintenanceValue = typeof cursorRow?.value === "string"
    ? cursorRow.value
    : serializeStripeEventPayloadSentinelMaintenance("", null);
  let sentinelMaintenance = parseStripeEventPayloadSentinelMaintenance(observedMaintenanceValue);
  const recheckIsWaiting = sentinelMaintenance.afterId === ""
    && isCanonicalJobTimestamp(sentinelMaintenance.recheckAt)
    && String(sentinelMaintenance.recheckAt) > nowIso;
  if (recheckIsWaiting) sentinelRecheckAt = sentinelMaintenance.recheckAt;
  const sentinelCandidates = remaining === 0 || recheckIsWaiting ? [] : await adapter.prepare(sql(
    "SELECT [id], [completedAt] FROM [sporades_jobs] WHERE [handler]=? AND [status]='succeeded' " +
    "AND [payloadRedactedAt] IS NULL AND [payloadRetentionUntil]='' AND [id]>? " +
    "ORDER BY [id] ASC LIMIT ?",
  )).all(STRIPE_EVENT_JOB, sentinelMaintenance.afterId, STRIPE_EVENT_PAYLOAD_CLEANUP_BATCH_SIZE + 1);
  let processedSentinelCount = 0;
  let processedSentinelCursor = sentinelMaintenance.afterId;
  for (const observed of sentinelCandidates.slice(0, STRIPE_EVENT_PAYLOAD_CLEANUP_BATCH_SIZE)) {
    if (remaining === 0) break;
    processedSentinelCount += 1;
    processedSentinelCursor = String(observed.id);
    let row = observed;
    let retried = false;
    while (row && remaining > 0) {
      const deadline = stripeEventPayloadRetentionDeadline(row.completedAt);
      if (deadline === null) break;
      const changed = await adapter.prepare(sql(
        "UPDATE [sporades_jobs] SET [payloadRetentionUntil]=? WHERE [id]=? AND [handler]=? " +
        "AND [status]='succeeded' AND [completedAt]=? AND [payloadRedactedAt] IS NULL " +
        "AND [payloadRetentionUntil]='' AND [claimToken] IS NULL AND [leaseExpiresAt] IS NULL",
      )).run(deadline, row.id, STRIPE_EVENT_JOB, row.completedAt);
      const mutations = Number(changed?.changes ?? 0);
      if (mutations > 0) {
        assignedCount += mutations;
        remaining -= mutations;
        break;
      }
      if (retried) break;
      row = await adapter.prepare(sql(
        "SELECT [id], [completedAt] FROM [sporades_jobs] WHERE [id]=? AND [handler]=? " +
        "AND [status]='succeeded' AND [payloadRedactedAt] IS NULL AND [payloadRetentionUntil]='' " +
        "AND [claimToken] IS NULL AND [leaseExpiresAt] IS NULL",
      )).get(observed.id, STRIPE_EVENT_JOB);
      retried = true;
    }
  }
  if (remaining === 0 && processedSentinelCount === 0) {
    // Spending the Job budget elsewhere must not defeat an already-durable future safety
    // deadline. An unfinished cursor (or a cycle with no deadline yet) still re-arms immediately.
    sentinelScanPending = recheckIsWaiting ? false : Boolean(await adapter.prepare(sql(
      "SELECT [id] FROM [sporades_jobs] WHERE [handler]=? AND [status]='succeeded' " +
      "AND [payloadRedactedAt] IS NULL AND [payloadRetentionUntil]='' LIMIT 1",
    )).get(STRIPE_EVENT_JOB));
  } else if (processedSentinelCount > 0) {
    const pageHasMore = sentinelCandidates.length > processedSentinelCount;
    const unresolvedSentinel = pageHasMore || Boolean(await adapter.prepare(sql(
      "SELECT [id] FROM [sporades_jobs] WHERE [handler]=? AND [status]='succeeded' " +
      "AND [payloadRedactedAt] IS NULL AND [payloadRetentionUntil]='' LIMIT 1",
    )).get(STRIPE_EVENT_JOB));
    const nextCursor = pageHasMore ? processedSentinelCursor : "";
    const nextRecheckAt = !pageHasMore && unresolvedSentinel
      ? jobTimestampAfter(database.clock.now(), STRIPE_EVENT_PAYLOAD_SENTINEL_RECHECK_MS)
      : null;
    const nextMaintenanceValue = serializeStripeEventPayloadSentinelMaintenance(nextCursor, nextRecheckAt);
    const advanced = await adapter.prepare(sql(
      "UPDATE [sporades] SET [value]=? WHERE [key]=? AND [value]=?",
    )).run(nextMaintenanceValue, STRIPE_EVENT_PAYLOAD_SENTINEL_CURSOR_KEY, observedMaintenanceValue);
    if (Number(advanced?.changes ?? 0) === 0) sentinelScanPending = true;
    else {
      observedMaintenanceValue = nextMaintenanceValue;
      sentinelMaintenance = { afterId: nextCursor, recheckAt: nextRecheckAt };
      sentinelScanPending = pageHasMore;
      sentinelRecheckAt = nextRecheckAt;
    }
  } else if (!recheckIsWaiting && (sentinelMaintenance.afterId !== "" || sentinelMaintenance.recheckAt !== null)) {
    // Completing a keyspace cycle schedules a bounded safety scan instead of hot-looping. The
    // periodic deadline is durable, so storage repair behind the cursor remains discoverable after
    // restart even though that narrow repair emits no runtime signal.
    const unresolvedSentinel = Boolean(await adapter.prepare(sql(
      "SELECT [id] FROM [sporades_jobs] WHERE [handler]=? AND [status]='succeeded' " +
      "AND [payloadRedactedAt] IS NULL AND [payloadRetentionUntil]='' LIMIT 1",
    )).get(STRIPE_EVENT_JOB));
    const nextRecheckAt = unresolvedSentinel
      ? jobTimestampAfter(database.clock.now(), STRIPE_EVENT_PAYLOAD_SENTINEL_RECHECK_MS)
      : null;
    const nextMaintenanceValue = serializeStripeEventPayloadSentinelMaintenance("", nextRecheckAt);
    const wrapped = await adapter.prepare(sql(
      "UPDATE [sporades] SET [value]=? WHERE [key]=? AND [value]=?",
    )).run(nextMaintenanceValue, STRIPE_EVENT_PAYLOAD_SENTINEL_CURSOR_KEY, observedMaintenanceValue);
    if (Number(wrapped?.changes ?? 0) === 0) sentinelScanPending = true;
    else {
      observedMaintenanceValue = nextMaintenanceValue;
      sentinelMaintenance = { afterId: "", recheckAt: nextRecheckAt };
      sentinelRecheckAt = nextRecheckAt;
    }
  }

  // Older successful reserved Jobs predate the deadline column. Assign their deadline from the
  // durable settlement time only after due redaction, using whatever shared budget remains.
  const unassigned = remaining === 0 ? [] : await adapter.prepare(sql(
    "SELECT [id], [completedAt] FROM [sporades_jobs] WHERE [handler]=? AND [status]='succeeded' " +
    "AND [payloadRedactedAt] IS NULL AND [payloadRetentionUntil] IS NULL " +
    "ORDER BY [completedAt] ASC, [id] ASC LIMIT ?",
  )).all(STRIPE_EVENT_JOB, remaining);
  for (const observed of unassigned) {
    if (remaining === 0) break;
    let row = observed;
    let retried = false;
    while (row && remaining > 0) {
      const deadline = stripeEventPayloadRetentionDeadline(row.completedAt);
      const unresolvedDeadline = stripeEventPayloadRetentionStorageValue(row.completedAt);
      const changed = deadline === null
        ? await adapter.prepare(sql(
          "UPDATE [sporades_jobs] SET [payloadRetentionUntil]=? WHERE [id]=? AND [handler]=? " +
          "AND [status]='succeeded' AND ([completedAt]=? OR ([completedAt] IS NULL AND ? IS NULL)) " +
          "AND [payloadRedactedAt] IS NULL AND [payloadRetentionUntil] IS NULL " +
          "AND [claimToken] IS NULL AND [leaseExpiresAt] IS NULL",
        )).run(unresolvedDeadline, row.id, STRIPE_EVENT_JOB, row.completedAt, row.completedAt)
        : await adapter.prepare(sql(
          "UPDATE [sporades_jobs] SET [payloadRetentionUntil]=? WHERE [id]=? AND [handler]=? " +
          "AND [status]='succeeded' AND ([completedAt]=? OR ([completedAt] IS NULL AND ? IS NULL)) " +
          "AND [payloadRedactedAt] IS NULL AND [payloadRetentionUntil] IS NULL " +
          "AND [claimToken] IS NULL AND [leaseExpiresAt] IS NULL",
        )).run(deadline, row.id, STRIPE_EVENT_JOB, row.completedAt, row.completedAt);
      const mutations = Number(changed?.changes ?? 0);
      if (mutations > 0) {
        if (deadline === null) classifiedCount += mutations;
        else assignedCount += mutations;
        remaining -= mutations;
        break;
      }
      if (retried) break;
      // The observed settlement may have been repaired concurrently. Reselect once and apply the
      // canonical deadline (or exact new malformed classification) instead of overwriting repair.
      row = await adapter.prepare(sql(
        "SELECT [id], [completedAt] FROM [sporades_jobs] WHERE [id]=? AND [handler]=? " +
        "AND [status]='succeeded' AND [payloadRedactedAt] IS NULL AND [payloadRetentionUntil] IS NULL " +
        "AND [claimToken] IS NULL AND [leaseExpiresAt] IS NULL",
      )).get(observed.id, STRIPE_EVENT_JOB);
      retried = true;
    }
  }

  const moreUnassigned = await adapter.prepare(sql(
    "SELECT [id] FROM [sporades_jobs] WHERE [handler]=? AND [status]='succeeded' " +
    "AND [payloadRedactedAt] IS NULL AND [payloadRetentionUntil] IS NULL LIMIT 1",
  )).get(STRIPE_EVENT_JOB);
  if (!sentinelScanPending && sentinelMaintenance.afterId === "" && sentinelRecheckAt === null && classifiedCount > 0) {
    const nextRecheckAt = jobTimestampAfter(database.clock.now(), STRIPE_EVENT_PAYLOAD_SENTINEL_RECHECK_MS);
    const nextMaintenanceValue = serializeStripeEventPayloadSentinelMaintenance("", nextRecheckAt);
    const scheduled = await adapter.prepare(sql(
      "UPDATE [sporades] SET [value]=? WHERE [key]=? AND [value]=?",
    )).run(nextMaintenanceValue, STRIPE_EVENT_PAYLOAD_SENTINEL_CURSOR_KEY, observedMaintenanceValue);
    if (Number(scheduled?.changes ?? 0) === 0) sentinelScanPending = true;
    else sentinelRecheckAt = nextRecheckAt;
  }
  const next = await adapter.prepare(sql(
    "SELECT [payloadRetentionUntil] FROM [sporades_jobs] WHERE [handler]=? AND [status]='succeeded' " +
    "AND [payloadRedactedAt] IS NULL AND [payloadRetentionUntil] IS NOT NULL AND [payloadRetentionUntil] <> '' " +
    "ORDER BY [payloadRetentionUntil] ASC, [id] ASC LIMIT 1",
  )).get(STRIPE_EVENT_JOB);
  const nextDeadline = isCanonicalJobTimestamp(next?.payloadRetentionUntil) ? String(next.payloadRetentionUntil) : null;
  const scheduledCleanupAt = sentinelRecheckAt !== null && nextDeadline !== null
    ? (sentinelRecheckAt < nextDeadline ? sentinelRecheckAt : nextDeadline)
    : sentinelRecheckAt ?? nextDeadline;
  const nextCleanupAt = moreUnassigned || sentinelScanPending ? nowIso : scheduledCleanupAt;
  return Object.freeze({ assignedCount, classifiedCount, redactedCount, nextCleanupAt });
}

export function scheduleStripeEventPayloadCleanup(database: LooseRecord, dueAt: number | null) {
  if (database.__jobStopped) return;
  if (database.__stripeEventPayloadCleanupPromise) {
    if (dueAt !== null) {
      database.__stripeEventPayloadCleanupRequestedAt = database.__stripeEventPayloadCleanupRequestedAt === null
        ? dueAt
        : Math.min(database.__stripeEventPayloadCleanupRequestedAt, dueAt);
    }
    return;
  }
  if (dueAt !== null && database.__stripeEventPayloadCleanupTimer && database.__stripeEventPayloadCleanupDueAt !== null
    && database.__stripeEventPayloadCleanupDueAt <= dueAt) return;
  installStripeEventPayloadCleanupTimer(database, dueAt);
}

function installStripeEventPayloadCleanupTimer(database: LooseRecord, dueAt: number | null) {
  if (database.__stripeEventPayloadCleanupTimer) database.clock.clearTimer(database.__stripeEventPayloadCleanupTimer);
  database.__stripeEventPayloadCleanupTimer = null;
  database.__stripeEventPayloadCleanupDueAt = dueAt;
  if (dueAt === null) return;
  database.__stripeEventPayloadCleanupTimer = database.clock.setTimer(async () => {
    database.__stripeEventPayloadCleanupTimer = null;
    database.__stripeEventPayloadCleanupDueAt = null;
    if (!database.__jobStopped) await startStripeEventPayloadCleanup(database);
  }, Math.min(STRIPE_EVENT_PAYLOAD_TIMER_CHUNK_MS, Math.max(0, dueAt - database.clock.now().getTime())));
}

export function startStripeEventPayloadCleanup(database: LooseRecord) {
  if (database.__jobStopped) return undefined;
  if (database.__stripeEventPayloadCleanupPromise) {
    const now = database.clock.now().getTime();
    database.__stripeEventPayloadCleanupRequestedAt = database.__stripeEventPayloadCleanupRequestedAt === null
      ? now
      : Math.min(database.__stripeEventPayloadCleanupRequestedAt, now);
    return database.__stripeEventPayloadCleanupPromise;
  }
  const cleanup = runStripeEventPayloadCleanupChain(database);
  database.__stripeEventPayloadCleanupPromise = cleanup;
  cleanup.finally(() => {
    if (database.__stripeEventPayloadCleanupPromise === cleanup) database.__stripeEventPayloadCleanupPromise = null;
  }).catch(() => {});
  return cleanup;
}

async function runStripeEventPayloadCleanupChain(database: LooseRecord) {
  while (!database.__jobStopped) {
    database.__stripeEventPayloadCleanupRequestedAt = null;
    let nextDueAt: number | null;
    try {
      const result = await cleanupExpiredStripeEventPayloads(database);
      nextDueAt = result.nextCleanupAt === null ? null : Date.parse(result.nextCleanupAt);
    } catch (error: any) {
      try {
        await database.log.emit({
          category: "platform", event: "stripe.event_payload_cleanup.failed", level: "error",
          message: "Stripe Event payload cleanup failed",
          data: { code: String(error?.code ?? "STRIPE_EVENT_PAYLOAD_CLEANUP_FAILED").slice(0, 80) },
        });
      } catch { }
      nextDueAt = database.clock.now().getTime() + STRIPE_EVENT_PAYLOAD_CLEANUP_RETRY_MS;
    }
    if (database.__jobStopped) return;
    const requestedAt = database.__stripeEventPayloadCleanupRequestedAt;
    database.__stripeEventPayloadCleanupRequestedAt = null;
    if (requestedAt !== null && requestedAt <= database.clock.now().getTime()) continue;
    const dueAt = requestedAt === null ? nextDueAt : nextDueAt === null ? requestedAt : Math.min(nextDueAt, requestedAt);
    installStripeEventPayloadCleanupTimer(database, dueAt);
    return;
  }
}

export function stopStripeEventPayloadCleanup(database: LooseRecord) {
  if (database.__stripeEventPayloadCleanupTimer) database.clock.clearTimer(database.__stripeEventPayloadCleanupTimer);
  database.__stripeEventPayloadCleanupTimer = null;
  database.__stripeEventPayloadCleanupDueAt = null;
  database.__stripeEventPayloadCleanupRequestedAt = null;
  return database.__stripeEventPayloadCleanupPromise
    ? Promise.resolve(database.__stripeEventPayloadCleanupPromise).then(() => undefined)
    : undefined;
}

export function scheduleDefinitionsFromCapsule(capsuleDefinition: any, jobs: any[]) {
  const schedules: any[] = [];
  for (const [name, definition] of Object.entries(capsuleDefinition?.schedules ?? {}) as [string, any][]) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw commandError(`Invalid Schedule name: ${name}`, "Begin Schedule names with a letter and use only letters, numbers, underscores, or hyphens.");
    if (!definition || definition.kind !== "schedule" || Object.keys(definition).some((key) => !["kind", "expression", "timezone", "job", "payload", "payloadVersion", "retry", "missedRun", "enabled"].includes(key))) throw commandError(`Invalid Schedule declaration: ${name}`, "Declare each Schedule with schedule({ expression, timezone?, job, payload?, payloadVersion?, retry?, missedRun?, enabled? }).");
    if (schedules.some((candidate) => candidate.name === name)) throw commandError(`Duplicate Schedule declaration: ${name}`, "Use one unique Schedule name per Capsule.");
    if (typeof definition.job !== "string" || !jobs.some((candidate) => candidate.name === definition.job)) throw commandError(`Unknown Job handler for Schedule: ${name}`, "Reference a Job declared in the Capsule jobs map.");
    const expression = parseScheduleExpression(definition.expression);
    const effectiveTimezone = resolveScheduleTimezone(definition.timezone);
    const payload = definition.payload === undefined ? null : definition.payload;
    let payloadFingerprint: any;
    let payloadVersion: string | undefined;
    if (typeof payload === "function") {
      if (definition.payloadVersion !== undefined
        && (typeof definition.payloadVersion !== "string"
          || definition.payloadVersion.length < 1
          || definition.payloadVersion.length > 128
          || definition.payloadVersion.trim() !== definition.payloadVersion)) {
        throw commandError(`Invalid Schedule payloadVersion: ${name}`, "When supplied, give a payload factory a stable non-empty payloadVersion of at most 128 characters, and change it whenever captured inputs change.");
      }
      // v0.8.5 identified factories by source text. Keep that exact serialized
      // shape for existing declarations; payloadVersion is the explicit,
      // closure-safe identity available to new and upgraded declarations.
      payloadFingerprint = definition.payloadVersion === undefined ? String(payload) : null;
      payloadVersion = definition.payloadVersion;
    } else {
      if (definition.payloadVersion !== undefined) {
        throw commandError(`Invalid Schedule payloadVersion: ${name}`, "Use payloadVersion only with a Schedule payload factory; static payload values are fingerprinted directly.");
      }
      boundedJobJson(payload, 64 * 1024, "JOB_PAYLOAD_TOO_LARGE", "Schedule payload");
      payloadFingerprint = payload;
    }
    const retry = normalizeJobRetry(definition.retry);
    const missedRun = definition.missedRun ?? "skip";
    if (missedRun !== "skip" && missedRun !== "latest") throw commandError(`Invalid missed-run policy for Schedule: ${name}`, "Use `skip` or `latest`.");
    if (definition.enabled !== undefined && typeof definition.enabled !== "boolean") throw commandError(`Invalid enabled value for Schedule: ${name}`, "Pass true or false for enabled.");
    const normalizedExpression = definition.expression.trim().replace(/\s+/g, " ");
    const enabled = definition.enabled ?? true;
    const fingerprint = JSON.stringify({ expression: normalizedExpression, timezone: effectiveTimezone, job: definition.job, payload: payloadFingerprint, retry, missedRun, ...(payloadVersion === undefined ? {} : { payloadVersion }) });
    schedules.push({ name, expression: normalizedExpression, fields: expression, effectiveTimezone, job: definition.job, payload, payloadVersion: definition.payloadVersion, retry, missedRun, enabled, fingerprint });
  }
  return schedules;
}

export function resolveSchedulePayloadFactoryTimeoutMs(config: RuntimeConfig = {}) {
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

export function parseScheduleExpression(value: any) {
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

export function nextScheduleOccurrence(fields: Set<number>[], after: Date, timezone: string) {
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
    if (fields[0].has(local.minute) && fields[1].has(local.hour) && dayMatches && fields[3].has(local.month)) {
      const occurrence = new Date(candidate);
      if (!isCanonicalJobTimestamp(occurrence.toISOString())) {
        throw commandError(
          "Stored Schedule state is invalid.",
          "Repair or remove the malformed Schedule before restarting the Capsule.",
          "SCHEDULE_STATE_INVALID",
        );
      }
      return occurrence;
    }
  }
  throw commandError("Schedule has no future occurrence.", "Check the Schedule cron expression.");
}

export async function ensureScheduleStorage(sqlite: LooseRecord, scheduleStorageFault?: (boundary: string, details: LooseRecord) => any) {
  const sql = sqlite.dialect.sql;
  await sqlite.exec(
    sql(
      "CREATE TABLE IF NOT EXISTS [sporades_schedules] ([name] TEXT PRIMARY KEY, [definitionFingerprint] TEXT NOT NULL, [generationToken] TEXT NOT NULL, " +
      "[expression] TEXT NOT NULL, [effectiveTimezone] TEXT NOT NULL, [missedRunPolicy] TEXT NOT NULL, " +
      "[enabled] INTEGER NOT NULL, [exhausted] INTEGER NOT NULL DEFAULT 0, [nextOccurrence] TEXT, [latestScheduledFor] TEXT, [latestOutcome] TEXT, " +
      "[latestJobId] TEXT, [latestErrorCode] TEXT)",
    ),
  );
  await sqlite.exec(
    sql(
      "CREATE TABLE IF NOT EXISTS [sporades_schedule_legacy_adoption] ([scheduleName] TEXT PRIMARY KEY, " +
      "[definitionFingerprint] TEXT NOT NULL, [adoptionOpen] INTEGER NOT NULL)",
    ),
  );
  await sqlite.exec(
    sql(
      "CREATE TABLE IF NOT EXISTS [sporades_schedule_occurrences] ([id] TEXT PRIMARY KEY, [scheduleName] TEXT NOT NULL, " +
      "[definitionFingerprint] TEXT, [generationToken] TEXT, [scheduledFor] TEXT NOT NULL, [status] TEXT NOT NULL, [claimToken] TEXT, [claimExpiresAt] TEXT, [jobId] TEXT, " +
      "[errorCode] TEXT, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL)",
    ),
  );
  await sqlite.dialect.addMissingColumn(sqlite, "sporades_schedules", "generationToken", "TEXT");
  await sqlite.dialect.addMissingColumn(sqlite, "sporades_schedules", "exhausted", "INTEGER NOT NULL DEFAULT 0");
  await sqlite.dialect.addMissingColumn(sqlite, "sporades_schedule_occurrences", "definitionFingerprint", "TEXT");
  await sqlite.dialect.addMissingColumn(sqlite, "sporades_schedule_occurrences", "generationToken", "TEXT");
  await sqlite.prepare(sql(
    "INSERT INTO [sporades] ([key], [value]) VALUES ('schedule-reconciliation-lock', 'v1') ON CONFLICT ([key]) DO NOTHING",
  )).run();
  const migrateLegacyScheduleIdentity = async (adapter: LooseRecord) => {
    const migrationSql = adapter.dialect.sql;
    await adapter.prepare(migrationSql(
      "UPDATE [sporades] SET [value]=[value] WHERE [key]='schedule-reconciliation-lock'",
    )).run();
    const lineageMigration = await adapter.prepare(migrationSql(
      "SELECT [value] FROM [sporades] WHERE [key]='schedule-legacy-adoption-lineage-v1'",
    )).get();
    const initializeLegacyLineage = !lineageMigration;
    const schedules = await adapter.prepare(migrationSql(
      "SELECT [name], [definitionFingerprint], [generationToken] FROM [sporades_schedules] ORDER BY [name] ASC",
    )).all();
    const scheduleByName = new Map<string, LooseRecord>();
    for (const row of schedules) {
      // Migration/adoption follows the same Schedule-then-occurrence lock order
      // as reconciliation and occurrence finalization.
      await adapter.prepare(migrationSql(
        "UPDATE [sporades_schedules] SET [name]=[name] WHERE [name]=?",
      )).run(row.name);
      let generationToken = row.generationToken;
      const wasLegacySchedule = typeof generationToken !== "string" || generationToken.length === 0;
      if (typeof generationToken !== "string" || generationToken.length === 0) {
        const proposed = nodeCryptoModule.randomUUID();
        await adapter.prepare(migrationSql(
          "UPDATE [sporades_schedules] SET [generationToken]=? WHERE [name]=? AND ([generationToken] IS NULL OR [generationToken]='')",
        )).run(proposed, row.name);
        const current = await adapter.prepare(migrationSql(
          "SELECT [definitionFingerprint], [generationToken] FROM [sporades_schedules] WHERE [name]=?",
        )).get(row.name);
        generationToken = current?.generationToken ?? proposed;
        row.definitionFingerprint = current?.definitionFingerprint ?? row.definitionFingerprint;
      }
      if (initializeLegacyLineage) {
        await adapter.prepare(migrationSql(
          "INSERT INTO [sporades_schedule_legacy_adoption] ([scheduleName], [definitionFingerprint], [adoptionOpen]) VALUES (?, ?, ?) ON CONFLICT ([scheduleName]) DO NOTHING",
        )).run(row.name, row.definitionFingerprint, wasLegacySchedule ? 1 : 0);
      }
      const lineage = await adapter.prepare(migrationSql(
        "SELECT [definitionFingerprint], [adoptionOpen] FROM [sporades_schedule_legacy_adoption] WHERE [scheduleName]=?",
      )).get(row.name);
      scheduleByName.set(String(row.name), {
        definitionFingerprint: row.definitionFingerprint,
        generationToken,
        legacyAdoptionOpen: Number(lineage?.adoptionOpen) === 1 && lineage?.definitionFingerprint === row.definitionFingerprint,
      });
    }
    const pending = await adapter.prepare(migrationSql(
      "SELECT [id], [scheduleName], [definitionFingerprint], [generationToken] FROM [sporades_schedule_occurrences] WHERE [status]='pending' AND ([definitionFingerprint] IS NULL OR [generationToken] IS NULL OR [generationToken]='') ORDER BY [scheduledFor] ASC, [id] ASC",
    )).all();
    await scheduleStorageFault?.("after-legacy-pending-scan", { adapter });
    for (const row of pending) {
      const schedule = scheduleByName.get(String(row.scheduleName));
      if (!schedule) continue;
      if (row.definitionFingerprint !== null && row.definitionFingerprint !== undefined
        && row.definitionFingerprint !== schedule.definitionFingerprint) continue;
      if ((row.definitionFingerprint === null || row.definitionFingerprint === undefined)
        && !schedule.legacyAdoptionOpen) continue;
      await adapter.prepare(migrationSql(
        "UPDATE [sporades_schedule_occurrences] SET [definitionFingerprint]=?, [generationToken]=? WHERE [id]=? AND [status]='pending' AND ([definitionFingerprint] IS NULL OR [definitionFingerprint]=?) AND ([generationToken] IS NULL OR [generationToken]='')",
      )).run(schedule.definitionFingerprint, schedule.generationToken, row.id, schedule.definitionFingerprint);
    }
    if (initializeLegacyLineage) {
      await adapter.prepare(migrationSql(
        "INSERT INTO [sporades] ([key], [value]) VALUES ('schedule-legacy-adoption-lineage-v1', 'complete') ON CONFLICT ([key]) DO NOTHING",
      )).run();
    }
  };
  if (typeof sqlite.withTransaction === "function") {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await sqlite.withTransaction(migrateLegacyScheduleIdentity);
        break;
      } catch (error: any) {
        if (sqlite.engine !== "sqlite" || attempt >= 100 || String(error?.message ?? "") !== "database is locked") throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, attempt + 1)));
      }
    }
  } else await migrateLegacyScheduleIdentity(sqlite);
  await sqlite.exec(
    sql(
      "CREATE UNIQUE INDEX IF NOT EXISTS [sporades_schedule_occurrence_identity] " +
      "ON [sporades_schedule_occurrences]([scheduleName], [scheduledFor])",
    ),
  );
  await sqlite.exec(
    sql(
      "CREATE INDEX IF NOT EXISTS [sporades_schedule_legacy_pending_discovery] " +
      "ON [sporades_schedule_occurrences]([status], [definitionFingerprint], [generationToken], [scheduledFor], [scheduleName])",
    ),
  );
}

export async function finishFailedScheduledOccurrence(database: LooseRecord, definition: any, occurrence: Date, error: any, claimToken: string) {
  const scheduledFor = occurrence.toISOString();
  const id = scheduledOccurrenceIdentity(database, definition.name, scheduledFor);
  const completedAt = database.clock.now().toISOString();
  const code = "SCHEDULE_ENQUEUE_FAILED";
  const sql = database.adapter.dialect.sql;
  const generation = await database.adapter.prepare(sql("UPDATE [sporades_schedules] SET [name]=[name] WHERE [name]=? AND [enabled]=1 AND [definitionFingerprint]=? AND [generationToken]=?")).run(definition.name, definition.fingerprint, definition.generationToken);
  if (Number(generation.changes) !== 1) {
    await database.adapter.prepare(sql("UPDATE [sporades_schedule_occurrences] SET [status]='enqueue-failed', [claimToken]=NULL, [claimExpiresAt]=NULL, [jobId]=NULL, [errorCode]='SCHEDULE_OCCURRENCE_SUPERSEDED', [updatedAt]=? WHERE [id]=? AND [status]='pending' AND [claimToken]=? AND [definitionFingerprint]=? AND [generationToken]=?")).run(completedAt, id, claimToken, definition.fingerprint, definition.generationToken);
    return { finished: false, nextOccurrence: null, superseded: true };
  }
  const terminal = await database.adapter.prepare(sql("UPDATE [sporades_schedule_occurrences] SET [status]='enqueue-failed', [claimToken]=NULL, [claimExpiresAt]=NULL, [errorCode]=?, [updatedAt]=? WHERE [id]=? AND [status]='pending' AND [claimToken]=? AND [definitionFingerprint]=? AND [generationToken]=?")).run(code, completedAt, id, claimToken, definition.fingerprint, definition.generationToken);
  if (Number(terminal.changes) !== 1) return { finished: false, nextOccurrence: null };
  const successor = nextScheduleCursor(definition, occurrence);
  const summary = await database.adapter.prepare(sql("UPDATE [sporades_schedules] SET [nextOccurrence]=?, [exhausted]=?, [latestScheduledFor]=?, [latestOutcome]='payload-failed', [latestJobId]=NULL, [latestErrorCode]=? WHERE [name]=? AND [enabled]=1 AND [definitionFingerprint]=? AND [generationToken]=?")).run(successor.nextOccurrence, successor.exhausted ? 1 : 0, scheduledFor, code, definition.name, definition.fingerprint, definition.generationToken);
  if (Number(summary.changes) !== 1) throw new Error("Schedule definition changed during occurrence failure finalization.");
  return { finished: true, ...successor };
}

export function nextScheduleCursor(definition: any, occurrence: Date) {
  try {
    return {
      nextOccurrence: nextScheduleOccurrence(definition.fields, occurrence, definition.effectiveTimezone).toISOString(),
      exhausted: false,
    };
  } catch (error: any) {
    if (error?.code !== "SCHEDULE_STATE_INVALID") throw error;
    return { nextOccurrence: null, exhausted: true };
  }
}

export function scheduledOccurrenceIdentity(database: LooseRecord, scheduleName: string, scheduledFor: string) {
  return nodeCryptoModule.createHash("sha256").update(JSON.stringify([database.capsuleIdentity, scheduleName, scheduledFor])).digest("hex");
}

function schedulePayloadFactoryAbortError() {
  const error: any = new Error("Schedule payload factory aborted.");
  error.code = "SCHEDULE_PAYLOAD_FACTORY_ABORTED";
  return error;
}

async function acquireSchedulePayloadFactorySlot(database: LooseRecord, signal: AbortSignal) {
  if (signal.aborted || database.__scheduleStopped) throw schedulePayloadFactoryAbortError();
  if (database.schedulePayloadFactoryActive < 4 && database.schedulePayloadFactoryWaiters.length === 0) {
    database.schedulePayloadFactoryActive += 1;
  } else {
    await new Promise<void>((resolve, reject) => {
      const waiter: LooseRecord = {};
      const remove = () => {
        const index = database.schedulePayloadFactoryWaiters.indexOf(waiter);
        if (index >= 0) database.schedulePayloadFactoryWaiters.splice(index, 1);
      };
      const onAbort = () => {
        remove();
        reject(schedulePayloadFactoryAbortError());
      };
      waiter.grant = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      database.schedulePayloadFactoryWaiters.push(waiter);
      if (signal.aborted || database.__scheduleStopped) onAbort();
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const waiter = database.schedulePayloadFactoryWaiters.shift();
    if (waiter) waiter.grant();
    else database.schedulePayloadFactoryActive -= 1;
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

export async function resolveSchedulePayload(database: LooseRecord, definition: any, scheduledFor: string, context: LooseRecord) {
  if (typeof definition.payload !== "function") return { ok: true, value: definition.payload };
  let releaseLane: (() => void) | undefined;
  let releaseSlot: (() => void) | undefined;
  const controller = new AbortController();
  const controllers = database.schedulePayloadFactoryControllers.get(definition.name) ?? new Set();
  controllers.add(controller);
  database.schedulePayloadFactoryControllers.set(definition.name, controllers);
  const occurrence = Object.freeze({ scheduleName: definition.name, scheduledFor });
  const factoryContext = Object.freeze({ signal: controller.signal, privileged: context.privileged });
  let timeout: any;
  let removeAbortListener: (() => void) | undefined;
  try {
    releaseLane = await acquireSchedulePayloadFactoryLane(database, definition.name);
    if (controller.signal.aborted || database.__scheduleStopped) throw schedulePayloadFactoryAbortError();
    releaseSlot = await acquireSchedulePayloadFactorySlot(database, controller.signal);
    if (controller.signal.aborted || database.__scheduleStopped) throw schedulePayloadFactoryAbortError();
    const timeoutFailure = new Promise((_resolve, reject) => {
      timeout = database.clock.setTimer(() => {
        controller.abort();
        const error: any = new Error("Schedule payload factory timed out.");
        error.code = "SCHEDULE_PAYLOAD_FACTORY_TIMEOUT";
        reject(error);
      }, database.schedulePayloadFactoryTimeoutMs);
    });
    const aborted = new Promise((_resolve, reject) => {
      const onAbort = () => reject(schedulePayloadFactoryAbortError());
      removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
    });
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
    removeAbortListener?.();
    controllers.delete(controller);
    if (controllers.size === 0) database.schedulePayloadFactoryControllers.delete(definition.name);
    releaseSlot?.();
    releaseLane?.();
  }
}

export function abortSchedulePayloadFactories(database: LooseRecord) {
  for (const controllers of database.schedulePayloadFactoryControllers?.values?.() ?? []) for (const controller of controllers) controller.abort();
}

export function createRuntimeClock(clock: LooseRecord | undefined) {
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

// Jobs the runtime enqueues for itself. They live in the reserved `_sporades`
// namespace, which Capsule definitions cannot claim.
export function runtimeOwnedJobHandlers(runtime: {
  prepareEmailPasswordResetDelivery: (context: LooseRecord, payload: LooseRecord) => Promise<LooseRecord | null>;
  dispatchStripeEvent: (context: LooseRecord, event: LooseRecord) => Promise<LooseRecord>;
  performTeamBillingCheckout: (context: LooseRecord, payload: LooseRecord) => Promise<LooseRecord | null>;
  expireTeamBillingCheckout: (context: LooseRecord, payload: LooseRecord) => Promise<null>;
  performTeamBillingPortal: (context: LooseRecord, payload: LooseRecord) => Promise<LooseRecord | null>;
  expireTeamBillingPortal: (context: LooseRecord, payload: LooseRecord) => Promise<null>;
  performTeamBillingPlanTransition: (context: LooseRecord, payload: LooseRecord) => Promise<LooseRecord | null>;
  performTeamBillingSeatConvergence: (context: LooseRecord, payload: LooseRecord) => Promise<LooseRecord | null>;
  performTeamBillingErasure: (context: LooseRecord, payload: LooseRecord) => Promise<LooseRecord | null>;
}) {
  return [
    {
      name: TEAM_BILLING_CHECKOUT_JOB,
      handler: runtime.performTeamBillingCheckout,
    },
    {
      name: TEAM_BILLING_CHECKOUT_EXPIRY_JOB,
      handler: runtime.expireTeamBillingCheckout,
    },
    { name: TEAM_BILLING_PORTAL_JOB, handler: runtime.performTeamBillingPortal },
    { name: TEAM_BILLING_PORTAL_EXPIRY_JOB, handler: runtime.expireTeamBillingPortal },
    { name: TEAM_BILLING_PLAN_TRANSITION_JOB, handler: runtime.performTeamBillingPlanTransition },
    { name: TEAM_BILLING_SEAT_CONVERGENCE_JOB, handler: runtime.performTeamBillingSeatConvergence },
    { name: TEAM_BILLING_ERASURE_JOB, handler: runtime.performTeamBillingErasure },
    {
      name: STRIPE_EVENT_JOB,
      handler: runtime.dispatchStripeEvent,
    },
    {
      name: PASSWORD_RESET_MAIL_JOB,
      handler: async (ctx: LooseRecord, payload: LooseRecord) => {
        return await ctx.mail.send({
          to: payload.to,
          subject: payload.subject,
          textBody: payload.textBody,
          htmlBody: payload.htmlBody,
        });
      },
    },
    {
      name: PASSWORD_RESET_REQUEST_JOB,
      handler: async (ctx: LooseRecord, payload: LooseRecord) => {
        const delivery = await runtime.prepareEmailPasswordResetDelivery(ctx, payload);
        if (!delivery) return;
        return await ctx.mail.send(delivery);
      },
    },
  ];
}

function isReservedJobName(name: string) {
  return name.toLowerCase().startsWith(RESERVED_JOB_NAME_PREFIX);
}

export function jobHandlersFromCapsuleDefinition(capsuleDefinition: any) {
  const handlers: any[] = [];
  for (const [name, definition] of Object.entries(capsuleDefinition?.jobs ?? {}) as [string, any][]) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) || definition?.kind !== "job" || typeof definition.handler !== "function") {
      throw commandError("Invalid Job handler.", "Declare jobs as named job(...) handlers using letters, numbers, underscores, or hyphens.");
    }
    // The runtime enqueues its own Jobs, such as password reset delivery. A
    // Capsule handler with the same name would capture that work, so the whole
    // prefix is reserved rather than any single name.
    if (isReservedJobName(name)) {
      throw commandError(
        `Reserved Job handler name: ${name}`,
        "Job names beginning with `_sporades` are reserved for the Sporades runtime. Rename this Job.",
        "RESERVED_JOB_NAME",
      );
    }
    if (handlers.some((handler) => handler.name === name)) {
      throw commandError(`Duplicate Job handler: ${name}`, "Use one unique Job handler name per Capsule.");
    }
    handlers.push({ name, handler: definition.handler });
  }
  return handlers;
}

export async function ensureJobStorage(sqlite: LooseRecord) {
  const sql = sqlite.dialect.sql;
  await sqlite.exec(sql("CREATE TABLE IF NOT EXISTS [sporades] ([key] TEXT PRIMARY KEY, [value] TEXT NOT NULL)"));
  await sqlite.prepare(sql(
    "INSERT INTO [sporades] ([key], [value]) VALUES (?, ?) ON CONFLICT ([key]) DO NOTHING",
  )).run(STRIPE_EVENT_PAYLOAD_SENTINEL_CURSOR_KEY, serializeStripeEventPayloadSentinelMaintenance("", null));
  await sqlite.exec(
    sql(
      "CREATE TABLE IF NOT EXISTS [sporades_jobs] (" +
      "[id] TEXT PRIMARY KEY, [handler] TEXT NOT NULL, [enqueuedByUserId] TEXT NOT NULL, [actorUserId] TEXT NOT NULL, " +
      "[actorProvider] TEXT, [payload] TEXT NOT NULL, [status] TEXT NOT NULL, [availableAt] TEXT NOT NULL, " +
      "[attempts] INTEGER NOT NULL, [idempotencyKey] TEXT, [result] TEXT, [failure] TEXT, [createdAt] TEXT NOT NULL, " +
      "[startedAt] TEXT, [completedAt] TEXT, [failedAt] TEXT)",
    ),
  );
  await sqlite.exec(
    sql(
      "CREATE UNIQUE INDEX IF NOT EXISTS [sporades_jobs_idempotency] " +
      "ON [sporades_jobs]([handler], [actorUserId], [idempotencyKey]) WHERE [idempotencyKey] IS NOT NULL",
    ),
  );
  await sqlite.exec(
    sql("CREATE INDEX IF NOT EXISTS [sporades_jobs_runnable] ON [sporades_jobs]([status], [availableAt], [id])"),
  );
  // The columns added to the Job queue after its first release are declared through the dialect's
  // add-missing-column strategy rather than probed for first. `PRAGMA table_info` is SQLite's
  // alone, and this definition is sent verbatim to whichever engine is configured, so the probe
  // made every Capsule boot on a Postgres Capsule service fail with `syntax error at or near
  // "PRAGMA"` before the Job queue existed.
  for (const [name, type] of [["retryJson", "TEXT"], ["attemptHistory", "TEXT"], ["cancelRequestedAt", "TEXT"], ["leaseExpiresAt", "TEXT"], ["claimToken", "TEXT"], ["scheduleName", "TEXT"], ["scheduledFor", "TEXT"], ["actorProvider", "TEXT"], ["authSnapshotJson", "TEXT"], ["credentialJson", "TEXT"], ["payloadRetentionUntil", "TEXT"], ["payloadRedactedAt", "TEXT"]]) await sqlite.dialect.addMissingColumn(sqlite, "sporades_jobs", name, type);
  await sqlite.exec(sql(
    "CREATE INDEX IF NOT EXISTS [sporades_jobs_stripe_payload_retention] " +
    "ON [sporades_jobs]([handler], [status], [payloadRetentionUntil], [id])",
  ));
  await sqlite.exec(
    sql("UPDATE [sporades_jobs] SET [actorProvider] = 'anonymous' WHERE [actorProvider] IS NULL OR [actorProvider] = ''"),
  );
  const legacyRows = await sqlite.prepare(sqlite.dialect.sql(
    "SELECT [id], [actorUserId], [enqueuedByUserId], [actorProvider] FROM [sporades_jobs] " +
    "WHERE [scheduleName] IS NULL AND [actorUserId] <> ? AND ([authSnapshotJson] IS NULL OR [credentialJson] IS NULL)",
  )).all(privilegedAuthUserId());
  for (const row of legacyRows) {
    let user = null;
    try {
      user = await sqlite.prepare(sqlite.dialect.sql(
        "SELECT [id], [displayName], [email], [picture], [isAuthenticated], [isGuest] FROM [sporades_auth_users] WHERE [id] = ?",
      )).get(row.actorUserId);
    } catch (error: any) {
      if (!/no such table|does not exist|unknown table/i.test(String(error?.message ?? error))) throw error;
    }
    const provider = jobActorProvider({ provider: row.actorProvider, isGuest: user ? Boolean(user.isGuest) : row.actorProvider === "anonymous" });
    const authSnapshot = captureJobAuthSnapshot(user ? {
      userId: user.id,
      displayName: user.displayName,
      email: user.email,
      picture: user.picture,
      isAuthenticated: Boolean(user.isAuthenticated),
      isGuest: Boolean(user.isGuest),
      provider,
    } : legacyJobAuthFallback(row.actorUserId, provider));
    await sqlite.prepare(sqlite.dialect.sql(
      "UPDATE [sporades_jobs] SET [authSnapshotJson] = COALESCE([authSnapshotJson], ?), [credentialJson] = COALESCE([credentialJson], ?) WHERE [id] = ?",
    )).run(JSON.stringify(authSnapshot), JSON.stringify({ kind: "session" }), row.id);
  }
}

export async function scheduleSummary(sqlite: LooseRecord, row: any) {
  const invalid = (field: string) => {
    const error: any = jobError("SCHEDULE_INSPECTION_INVALID_STATE", "Stored Schedule state is invalid.", "Repair or remove the malformed Schedule before retrying inspection.");
    error.scheduleName = typeof row?.name === "string" ? row.name : null; error.field = field; return error;
  };
  if (typeof row.name !== "string" || !row.name) throw invalid("name");
  if (typeof row.expression !== "string" || !row.expression) throw invalid("expression");
  if (typeof row.effectiveTimezone !== "string" || !row.effectiveTimezone) throw invalid("timezone");
  if (!["skip", "latest"].includes(row.missedRunPolicy)) throw invalid("missedRun");
  if (![0, 1, false, true].includes(row.enabled)) throw invalid("enabled");
  const exhausted = row.exhausted ?? 0;
  if (![0, 1, false, true].includes(exhausted) || !scheduleCursorStateIsConsistent(row.enabled, exhausted, row.nextOccurrence)) throw invalid("exhausted");
  if (row.nextOccurrence != null && !isCanonicalJobTimestamp(row.nextOccurrence)) throw invalid("nextOccurrence");
  const latestOutcome = row.latestOutcome == null ? null : String(row.latestOutcome);
  let latestOccurrence = null;
  if (latestOutcome === null && [row.latestScheduledFor, row.latestJobId, row.latestErrorCode].some((value) => value != null)) throw invalid("latestOccurrence");
  if (latestOutcome !== null && !isCanonicalJobTimestamp(row.latestScheduledFor)) throw invalid("latestOccurrence.scheduledFor");
  if (latestOutcome === "enqueued") {
    if (typeof row.latestJobId !== "string" || !row.latestJobId) throw invalid("latestOccurrence.jobId");
    if (row.latestErrorCode != null) throw invalid("latestOccurrence.errorCode");
    const job = await sqlite.prepare(sqlite.dialect.sql("SELECT [id] FROM [sporades_jobs] WHERE [id]=? AND [scheduleName]=? AND [scheduledFor]=?")).get(row.latestJobId, row.name, row.latestScheduledFor);
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

export function scheduleCursorStateIsConsistent(enabled: any, exhausted: any, nextOccurrence: any) {
  if (![0, 1, false, true].includes(enabled) || ![0, 1, false, true].includes(exhausted)) return false;
  const hasNextOccurrence = nextOccurrence !== null && nextOccurrence !== undefined;
  return Boolean(enabled)
    ? hasNextOccurrence !== Boolean(exhausted)
    : !Boolean(exhausted) && !hasNextOccurrence;
}

export function assertJobScheduleProvenance(row: any, expected: any) {
  if (!expected) return;
  if (row?.scheduleName !== expected.scheduleName || row?.scheduledFor !== expected.scheduledFor) {
    throw jobError("JOB_IDEMPOTENCY_CONFLICT", "Scheduled occurrence idempotency conflicts with existing Job provenance.", "Inspect the existing Job and retry after resolving the conflicting internal idempotency key.");
  }
}

export function jobError(code: string, message: string, hint: string) {
  const error: any = new Error(message); error.code = code; error.hint = hint; return error;
}

export function boundedJobJson(value: any, limit: number, code: string, label: string) {
  let serialized: string;
  try { assertJsonCompatible(value); serialized = JSON.stringify(value); } catch { throw jobError("INVALID_JOB_PAYLOAD", `${label} must be JSON-compatible.`, "Pass plain JSON data without functions, cycles, or live request objects."); }
  if (Buffer.byteLength(serialized, "utf8") > limit) throw jobError(code, `${label} exceeds the ${limit} byte limit.`, "Reduce the serialized JSON value before enqueueing or returning it.");
  return serialized;
}

const JOB_AUTH_SNAPSHOT_MAX_BYTES = 8 * 1024;

function boundedJobIdentityString(value: unknown, field: string, maximum: number, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length > maximum) {
    throw jobError("INVALID_JOB_IDENTITY", "Job identity provenance is invalid.", `Keep ${field} within its runtime-owned bound.`);
  }
  return value;
}

/** Canonical bounded AuthContext persisted at the successful enqueue boundary. */
export function canonicalJobAuthSnapshot(auth: LooseRecord) {
  const snapshot = {
    userId: boundedJobIdentityString(auth?.userId, "userId", 256),
    displayName: boundedJobIdentityString(auth?.displayName, "displayName", 512),
    email: boundedJobIdentityString(auth?.email, "email", 320, true),
    picture: boundedJobIdentityString(auth?.picture, "picture", 4096, true),
    isAuthenticated: auth?.isAuthenticated,
    isGuest: auth?.isGuest,
    provider: boundedJobIdentityString(auth?.provider, "provider", 64),
  };
  if (typeof snapshot.isAuthenticated !== "boolean" || typeof snapshot.isGuest !== "boolean") {
    throw jobError("INVALID_JOB_IDENTITY", "Job identity provenance is invalid.", "Use a runtime-issued AuthContext when enqueueing a Job.");
  }
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, "utf8") > JOB_AUTH_SNAPSHOT_MAX_BYTES) {
    throw jobError("INVALID_JOB_IDENTITY", "Job identity provenance is too large.", "Reduce bounded profile metadata before enqueueing the Job.");
  }
  return snapshot;
}

function truncateJobDisplayName(value: string) {
  let truncated = value.slice(0, 512);
  const finalCodeUnit = truncated.charCodeAt(truncated.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) truncated = truncated.slice(0, -1);
  return truncated || "Job enqueuer";
}

/**
 * Bounds profile metadata at the enqueue/migration boundary without rejecting Auth profiles that
 * were valid before durable Job provenance introduced narrower storage limits. Authority-bearing
 * identity fields remain strict; only display metadata is shortened or omitted.
 */
export function captureJobAuthSnapshot(auth: LooseRecord) {
  if (
    typeof auth?.displayName !== "string" ||
    !(auth?.email === null || typeof auth?.email === "string") ||
    !(auth?.picture === null || typeof auth?.picture === "string")
  ) return canonicalJobAuthSnapshot(auth);
  // Validate exact authority/provenance fields before applying any compatibility fallback.
  boundedJobIdentityString(auth?.userId, "userId", 256);
  boundedJobIdentityString(auth?.provider, "provider", 64);
  if (typeof auth?.isAuthenticated !== "boolean" || typeof auth?.isGuest !== "boolean") {
    return canonicalJobAuthSnapshot(auth);
  }
  const bounded = {
    ...auth,
    displayName: auth.displayName.length > 512 ? truncateJobDisplayName(auth.displayName) : auth.displayName,
    email: auth.email !== null && auth.email.length > 320 ? null : auth.email,
    picture: auth.picture !== null && auth.picture.length > 4096 ? null : auth.picture,
  };
  try {
    return canonicalJobAuthSnapshot(bounded);
  } catch (error: any) {
    if (error?.code !== "INVALID_JOB_IDENTITY") throw error;
    // Escaped JSON can exceed the aggregate byte budget while every field is individually bounded.
    return canonicalJobAuthSnapshot({ ...bounded, displayName: "Job enqueuer", email: null, picture: null });
  }
}

/** Canonical Credential provenance; secret material and granted scopes have no accepted field. */
export function canonicalJobCredentialProvenance(credential: LooseRecord) {
  if (credential?.kind === "session" && Object.keys(credential).every((key) => key === "kind")) return { kind: "session" };
  if (credential?.kind === "access-key" && Object.keys(credential).every((key) => ["kind", "id", "name"].includes(key))) {
    return {
      kind: "access-key",
      id: boundedJobIdentityString(credential.id, "credential.id", 256),
      name: boundedJobIdentityString(credential.name, "credential.name", 256),
    };
  }
  throw jobError("INVALID_JOB_CREDENTIAL", "Job Credential provenance is invalid.", "Enqueue from a runtime-issued Session or Access-key context.");
}

export function legacyJobAuthFallback(userId: unknown, provider: unknown) {
  const normalizedProvider = jobActorProvider({ provider, isGuest: provider === "anonymous" });
  return {
    userId: boundedJobIdentityString(userId, "userId", 256),
    displayName: "Job enqueuer",
    email: null,
    picture: null,
    isAuthenticated: normalizedProvider !== "anonymous",
    isGuest: normalizedProvider === "anonymous",
    provider: normalizedProvider,
  };
}

export function readJobAuthSnapshot(row: LooseRecord) {
  let snapshot;
  if (row?.authSnapshotJson) {
    try { snapshot = canonicalJobAuthSnapshot(JSON.parse(String(row.authSnapshotJson))); }
    catch { throw jobError("JOB_ACTOR_SNAPSHOT_INVALID", "Stored Job actor provenance is invalid.", "Repair or remove the malformed Job before retrying execution."); }
  } else {
    snapshot = canonicalJobAuthSnapshot(legacyJobAuthFallback(row?.actorUserId, row?.actorProvider));
  }
  if (snapshot.userId !== row?.actorUserId) {
    throw jobError("JOB_ACTOR_SNAPSHOT_INVALID", "Stored Job actor provenance is invalid.", "Repair the mismatched Job actor snapshot before retrying execution.");
  }
  return snapshot;
}

export function readJobCredentialProvenance(row: LooseRecord) {
  if (row?.credentialJson) {
    try { return canonicalJobCredentialProvenance(JSON.parse(String(row.credentialJson))); }
    catch { throw jobError("JOB_CREDENTIAL_INVALID", "Stored Job Credential provenance is invalid.", "Repair or remove the malformed Job before retrying execution."); }
  }
  return { kind: "session" };
}

export function jobState(row: any, includeDetail: boolean) {
  const actor = row.actorUserId === privilegedAuthUserId() ? { mode: "privileged-server-role" } : { mode: "current-user", userId: row.actorUserId };
  const enqueuedBy = row.scheduleName ? { mode: "schedule", scheduleName: row.scheduleName, scheduledFor: row.scheduledFor } : { mode: "user", userId: row.enqueuedByUserId, credential: readJobCredentialProvenance(row) };
  const state: any = { id: row.id, handler: row.handler, status: row.status, enqueuedBy, actor, attempts: Number(row.attempts) };
  if (includeDetail && row.result) state.result = JSON.parse(row.result);
  if (includeDetail && row.failure) state.failure = JSON.parse(row.failure);
  if (includeDetail) state.attemptHistory = JSON.parse(row.attemptHistory || "[]");
  if (row.cancelRequestedAt) state.cancelRequestedAt = row.cancelRequestedAt;
  return state;
}

export function jobActorProvider(auth: LooseRecord) {
  const provider = auth?.provider;
  if (typeof provider === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(provider)) return provider;
  return auth?.isGuest ? "anonymous" : "authenticated";
}

function stripeEventPayloadRetentionState(row: LooseRecord) {
  if (String(row.handler) !== STRIPE_EVENT_JOB) return undefined;
  if (row.payloadRedactedAt !== null && row.payloadRedactedAt !== undefined && row.payloadRedactedAt !== "") {
    return Object.freeze({
      state: "redacted",
      deadline: isCanonicalJobTimestamp(row.payloadRetentionUntil) ? String(row.payloadRetentionUntil) : null,
      redactedAt: isCanonicalJobTimestamp(row.payloadRedactedAt) ? String(row.payloadRedactedAt) : null,
    });
  }
  if (row.status !== "succeeded") {
    return Object.freeze({ state: "unresolved", code: "JOB_NOT_SUCCESSFULLY_SETTLED", deadline: null });
  }
  if (row.payloadRetentionUntil === "") {
    if (stripeEventPayloadRetentionDeadline(row.completedAt) !== null) {
      return Object.freeze({ state: "unresolved", code: "CANONICAL_REPAIR_PENDING", deadline: null });
    }
    return Object.freeze({ state: "unresolved", code: "INVALID_COMPLETED_AT", deadline: null });
  }
  if (row.payloadRetentionUntil === STRIPE_EVENT_PAYLOAD_UNREPRESENTABLE_DEADLINE) {
    return Object.freeze({ state: "unresolved", code: "RETENTION_DEADLINE_UNREPRESENTABLE", deadline: null });
  }
  if (isCanonicalJobTimestamp(row.payloadRetentionUntil)) {
    return Object.freeze({ state: "retained", deadline: String(row.payloadRetentionUntil) });
  }
  return Object.freeze({ state: "unresolved", code: "RETENTION_DEADLINE_UNASSIGNED", deadline: null });
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
      rows = await tx.prepare(tx.dialect.sql("SELECT * FROM [sporades_jobs] ORDER BY [createdAt] DESC, [id] DESC")).all();
    } catch (error) {
      const message = String((error as any)?.message ?? error);
      if (/no such table|does not exist|unknown table/i.test(message)) return [];
      throw error;
    }
    return rows.map((row) => {
      const retention = stripeEventPayloadRetentionState(row);
      return {
        id: String(row.id), handler: String(row.handler), status: String(row.status),
        enqueuedBy: row.scheduleName ? { mode: "schedule", scheduleName: String(row.scheduleName), scheduledFor: String(row.scheduledFor) } : { mode: "user", userId: String(row.enqueuedByUserId), credential: readJobCredentialProvenance(row) },
        actor: row.actorUserId === privilegedAuthUserId() ? { mode: "privileged-server-role" } : { mode: "current-user", userId: String(row.actorUserId) },
        attempts: Number(row.attempts), retry: decode(row, "retry", row.retryJson, { maxAttempts: 1, delayMs: 0 }),
        idempotencyKeyPresent: row.idempotencyKey !== null && row.idempotencyKey !== undefined,
        availableAt: row.availableAt ?? null, createdAt: row.createdAt ?? null, startedAt: row.startedAt ?? null,
        completedAt: row.completedAt ?? null, failedAt: row.failedAt ?? null, cancelRequestedAt: row.cancelRequestedAt ?? null,
        leaseExpiresAt: row.leaseExpiresAt ?? null, attemptHistory: decode(row, "attemptHistory", row.attemptHistory, []),
        ...(retention ? { payloadRetention: retention } : {}),
        // Job results are arbitrary Capsule JSON. Validate storage but never disclose the payload
        // until the runtime has a separate safe-result metadata classifier.
        result: (decode(row, "result", row.result, null), null), failure: decode(row, "failure", row.failure, null),
      };
    });
  };
  if (!adapter?.withReadOnlySnapshot) throw jobError("JOB_INSPECTION_READ_ONLY_UNAVAILABLE", "Database adapter does not support read-only Job inspection.", "Upgrade the Sporades runtime and retry inspection.");
  return await adapter.withReadOnlySnapshot(read);
}

/** Read the bounded operator view of every Schedule in one adapter snapshot. */
export async function inspectRuntimeSchedules(adapter: LooseRecord) {
  const read = async (tx: LooseRecord) => {
    let rows: LooseRecord[];
    try {
      rows = await tx.prepare(tx.dialect.sql("SELECT * FROM [sporades_schedules] ORDER BY [name] ASC")).all();
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

export const MAX_JOB_TIMESTAMP_MS = Date.parse("9999-12-31T23:59:59.999Z");
export const MIN_JOB_TIMESTAMP_MS = Date.parse("0000-01-01T00:00:00.000Z");

export function normalizeJobAvailableAt(value: any) {
  let milliseconds = Number.NaN;
  try {
    if (typeof value === "string") {
      if (/^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) throw new TypeError("Unsupported Job availability value.");
      milliseconds = new Date(value).getTime();
    } else {
      milliseconds = Date.prototype.getTime.call(value);
    }
  }
  catch { }
  if (!Number.isFinite(milliseconds) || milliseconds < MIN_JOB_TIMESTAMP_MS || milliseconds > MAX_JOB_TIMESTAMP_MS) {
    throw jobError("INVALID_JOB_OPTIONS", "Invalid Job availability time.", "Pass an availableAt value in the supported four-digit UTC timestamp range.");
  }
  return new Date(milliseconds).toISOString();
}

export function isCanonicalJobTimestamp(value: any) {
  if (typeof value !== "string") return false;
  try { return normalizeJobAvailableAt(value) === value; }
  catch { return false; }
}

export function normalizeJobRetry(value: any) {
  if (value === undefined) return { maxAttempts: 1, delayMs: 0 };
  let maxAttempts;
  let delayMs;
  let hasMaxAttempts = false;
  let keys: PropertyKey[] = [];
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid Job retry policy.");
    keys = Reflect.ownKeys(value);
    hasMaxAttempts = Object.prototype.hasOwnProperty.call(value, "maxAttempts");
    maxAttempts = value.maxAttempts;
    delayMs = Object.prototype.hasOwnProperty.call(value, "delayMs") ? value.delayMs : 0;
  } catch { }
  if (!hasMaxAttempts || keys.some((key) => typeof key !== "string" || !["maxAttempts", "delayMs"].includes(key))
    || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20
    || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_JOB_TIMESTAMP_MS) {
    throw jobError(
      "INVALID_JOB_OPTIONS",
      "Invalid Job retry policy.",
      "Pass retry.maxAttempts (1-20) and retry.delayMs within the supported Job timestamp range.",
    );
  }
  return { maxAttempts, delayMs };
}

export function parsePersistedJobRetry(value: any) {
  try { return normalizeJobRetry(value ? JSON.parse(value) : undefined); }
  catch { return null; }
}

export function jobTimestampAfter(instant: Date, delayMs: number) {
  const milliseconds = instant.getTime() + delayMs;
  if (!Number.isFinite(milliseconds) || milliseconds < MIN_JOB_TIMESTAMP_MS || milliseconds > MAX_JOB_TIMESTAMP_MS) return null;
  return new Date(milliseconds).toISOString();
}

export function invalidJobRetryPolicyFailure() {
  return { code: "JOB_RETRY_POLICY_INVALID", message: "The stored Job retry policy is invalid." };
}

export async function cancelJob(database: LooseRecord, context: any, id: any) {
  const sql = database.adapter.dialect.sql;
  const read = () => context.__privilegedJobAccess
    ? database.adapter.prepare(sql("SELECT * FROM [sporades_jobs] WHERE [id] = ?")).get(id)
    : database.adapter.prepare(sql("SELECT * FROM [sporades_jobs] WHERE [id] = ? AND [actorUserId] = ?")).get(id, context.auth.userId);
  // Cancellation is a state transition, not a stale projection update. Retry
  // when another runtime wins between the authorized read and the guarded
  // write so a queued cancellation cannot overwrite a newly running claim.
  for (let transition = 0; transition < 8; transition += 1) {
    const row = await read();
    if (!row) return null;
    const now = database.clock.now().toISOString();
    if (["queued", "delayed"].includes(row.status)) {
      const changed = await database.adapter.prepare(sql(
        "UPDATE [sporades_jobs] SET [status]='cancelled', [completedAt]=?, [startedAt]=NULL, " +
        "[leaseExpiresAt]=NULL, [claimToken]=NULL WHERE [id]=? AND [status]=?",
      )).run(now, id, row.status);
      if (Number(changed?.changes ?? 0) === 1) return jobState({ ...row, status: "cancelled", completedAt: now, startedAt: null, leaseExpiresAt: null }, true);
      continue;
    }
    if (row.status === "running") {
      const hasClaimToken = typeof row.claimToken === "string" && row.claimToken.length > 0;
      const changed = await database.adapter.prepare(sql(
        "UPDATE [sporades_jobs] SET [cancelRequestedAt]=? WHERE [id]=? AND [status]='running' AND " +
        (hasClaimToken ? "[claimToken]=?" : "[claimToken] IS NULL"),
      )).run(now, id, ...(hasClaimToken ? [row.claimToken] : []));
      if (Number(changed?.changes ?? 0) !== 1) continue;
      const runtimeDatabase = database.__rootDatabase ?? database;
      if (database.__transactionActive) {
        const pendingContext = context.__jobParentContext ?? context;
        // The context holder belongs to the transaction and survives supported
        // middleware replacement; the current context projection may not.
        const pendingOwner = pendingContext.__sporadesContextHolder ?? pendingContext;
        pendingOwner.__pendingJobCancellationAborts ??= new Map();
        pendingOwner.__pendingJobCancellationAborts.set(id, { runtimeDatabase, claimToken: row.claimToken });
      } else {
        abortRuntimeJobClaim(runtimeDatabase, id, row.claimToken);
      }
      return jobState({ ...row, cancelRequestedAt: now }, true);
    }
    throw jobError("INVALID_JOB_STATE", "Job cannot be cancelled from its current state.", "Only queued, delayed, or running Jobs can be cancelled.");
  }
  throw jobError("JOB_STATE_CHANGED", "Job state changed while cancellation was requested.", "Retry the Job cancellation.");
}

export function commitPendingJobCancellationAborts(context: LooseRecord | undefined) {
  if (!context) return;
  const pendingContext = context.__jobParentContext ?? context;
  const pendingOwner = pendingContext.__sporadesContextHolder ?? pendingContext;
  const pending = pendingOwner.__pendingJobCancellationAborts;
  if (!(pending instanceof Map)) return;
  delete pendingOwner.__pendingJobCancellationAborts;
  for (const [id, claim] of pending) abortRuntimeJobClaim(claim.runtimeDatabase, id, claim.claimToken);
}

export function dropPendingJobCancellationAborts(context: LooseRecord | undefined) {
  if (!context) return;
  const pendingContext = context.__jobParentContext ?? context;
  const pendingOwner = pendingContext.__sporadesContextHolder ?? pendingContext;
  delete pendingOwner.__pendingJobCancellationAborts;
}

function abortRuntimeJobClaim(runtimeDatabase: LooseRecord, id: any, claimToken: any) {
  const activeClaim = runtimeDatabase.__jobAbortControllers?.get(id);
  const controller = activeClaim?.controller ?? activeClaim;
  if (!activeClaim?.claimToken || activeClaim.claimToken === claimToken) controller?.abort?.();
}

export function jobSummary(row: any) { return { id: row.id, handler: row.handler, status: row.status, attempts: Number(row.attempts) }; }

export function encodeJobCursor(row: any) { return Buffer.from(JSON.stringify({ createdAt: row.createdAt, id: row.id })).toString("base64url"); }

export function decodeJobCursor(value: any) {
  if (value === undefined) return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (typeof cursor?.createdAt !== "string" || typeof cursor?.id !== "string") throw new Error("invalid");
    return cursor;
  } catch { throw jobError("INVALID_JOB_OPTIONS", "Invalid Job cursor.", "Pass the nextCursor returned by a previous Job list call."); }
}

export function safeJobFailure(error: any) {
  const knownCodes = new Set([
    "JOB_ACTOR_UNAVAILABLE", "UNKNOWN_JOB_HANDLER", "JOB_RESULT_TOO_LARGE", "INVALID_JOB_PAYLOAD",
    "STRIPE_CHECKOUT_REJECTED", "STRIPE_CHECKOUT_RESPONSE_INVALID",
    "STRIPE_PORTAL_REJECTED", "STRIPE_PORTAL_RESPONSE_INVALID",
    "PAYMENT_PORTAL_UNAVAILABLE",
  ]);
  const code = knownCodes.has(error?.code) ? error.code : "JOB_FAILED";
  const messages: LooseRecord = {
    JOB_ACTOR_UNAVAILABLE: "The captured Job actor is unavailable.",
    UNKNOWN_JOB_HANDLER: "The Job handler is unavailable.",
    JOB_RESULT_TOO_LARGE: "The Job result exceeded its safe size limit.",
    INVALID_JOB_PAYLOAD: "The Job produced an unsupported result.",
    STRIPE_CHECKOUT_REJECTED: "Stripe rejected the Checkout request.",
    STRIPE_CHECKOUT_RESPONSE_INVALID: "Stripe returned an invalid Checkout Session.",
    STRIPE_PORTAL_REJECTED: "Stripe rejected the Customer Portal request.",
    STRIPE_PORTAL_RESPONSE_INVALID: "Stripe returned an invalid Customer Portal Session.",
    PAYMENT_PORTAL_UNAVAILABLE: "Customer Portal is not available for this billing holder.",
    JOB_FAILED: "Job handler failed.",
  };
  return { code, message: messages[code] };
}
