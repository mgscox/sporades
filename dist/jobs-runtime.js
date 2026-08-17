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
// **What moved and what did not.** The domain is 51 declarations by inspection — 50 functions and
// `RESERVED_JOB_NAME_PREFIX`. Thirty-four are here; seventeen stayed behind, and the reference
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
// **What is exported and what is not.** Twenty-nine of the thirty-four are exported and five are
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
export function scheduleDefinitionsFromCapsule(capsuleDefinition, jobs) {
    const schedules = [];
    for (const [name, definition] of Object.entries(capsuleDefinition?.schedules ?? {})) {
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name))
            throw commandError(`Invalid Schedule name: ${name}`, "Begin Schedule names with a letter and use only letters, numbers, underscores, or hyphens.");
        if (!definition || definition.kind !== "schedule" || Object.keys(definition).some((key) => !["kind", "expression", "timezone", "job", "payload", "payloadVersion", "retry", "missedRun", "enabled"].includes(key)))
            throw commandError(`Invalid Schedule declaration: ${name}`, "Declare each Schedule with schedule({ expression, timezone?, job, payload?, payloadVersion?, retry?, missedRun?, enabled? }).");
        if (schedules.some((candidate) => candidate.name === name))
            throw commandError(`Duplicate Schedule declaration: ${name}`, "Use one unique Schedule name per Capsule.");
        if (typeof definition.job !== "string" || !jobs.some((candidate) => candidate.name === definition.job))
            throw commandError(`Unknown Job handler for Schedule: ${name}`, "Reference a Job declared in the Capsule jobs map.");
        const expression = parseScheduleExpression(definition.expression);
        const effectiveTimezone = resolveScheduleTimezone(definition.timezone);
        const payload = definition.payload === undefined ? null : definition.payload;
        let payloadFingerprint;
        let payloadVersion;
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
        }
        else {
            if (definition.payloadVersion !== undefined) {
                throw commandError(`Invalid Schedule payloadVersion: ${name}`, "Use payloadVersion only with a Schedule payload factory; static payload values are fingerprinted directly.");
            }
            boundedJobJson(payload, 64 * 1024, "JOB_PAYLOAD_TOO_LARGE", "Schedule payload");
            payloadFingerprint = payload;
        }
        const retry = normalizeJobRetry(definition.retry);
        const missedRun = definition.missedRun ?? "skip";
        if (missedRun !== "skip" && missedRun !== "latest")
            throw commandError(`Invalid missed-run policy for Schedule: ${name}`, "Use `skip` or `latest`.");
        if (definition.enabled !== undefined && typeof definition.enabled !== "boolean")
            throw commandError(`Invalid enabled value for Schedule: ${name}`, "Pass true or false for enabled.");
        const normalizedExpression = definition.expression.trim().replace(/\s+/g, " ");
        const enabled = definition.enabled ?? true;
        const fingerprint = JSON.stringify({ expression: normalizedExpression, timezone: effectiveTimezone, job: definition.job, payload: payloadFingerprint, retry, missedRun, ...(payloadVersion === undefined ? {} : { payloadVersion }) });
        schedules.push({ name, expression: normalizedExpression, fields: expression, effectiveTimezone, job: definition.job, payload, payloadVersion: definition.payloadVersion, retry, missedRun, enabled, fingerprint });
    }
    return schedules;
}
export function resolveSchedulePayloadFactoryTimeoutMs(config = {}) {
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
export function parseScheduleExpression(value) {
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
function scheduleWallClockParts(formatter, instant) {
    const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
    const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { minute: Number(parts.minute), hour: Number(parts.hour), day: Number(parts.day), month: Number(parts.month), weekday: weekdays[parts.weekday] };
}
export function nextScheduleOccurrence(fields, after, timezone) {
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
export async function ensureScheduleStorage(sqlite, scheduleStorageFault) {
    const sql = sqlite.dialect.sql;
    await sqlite.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_schedules] ([name] TEXT PRIMARY KEY, [definitionFingerprint] TEXT NOT NULL, [generationToken] TEXT NOT NULL, " +
        "[expression] TEXT NOT NULL, [effectiveTimezone] TEXT NOT NULL, [missedRunPolicy] TEXT NOT NULL, " +
        "[enabled] INTEGER NOT NULL, [nextOccurrence] TEXT, [latestScheduledFor] TEXT, [latestOutcome] TEXT, " +
        "[latestJobId] TEXT, [latestErrorCode] TEXT)"));
    await sqlite.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_schedule_occurrences] ([id] TEXT PRIMARY KEY, [scheduleName] TEXT NOT NULL, " +
        "[definitionFingerprint] TEXT, [generationToken] TEXT, [scheduledFor] TEXT NOT NULL, [status] TEXT NOT NULL, [claimToken] TEXT, [claimExpiresAt] TEXT, [jobId] TEXT, " +
        "[errorCode] TEXT, [createdAt] TEXT NOT NULL, [updatedAt] TEXT NOT NULL)"));
    await sqlite.dialect.addMissingColumn(sqlite, "sporades_schedules", "generationToken", "TEXT");
    await sqlite.dialect.addMissingColumn(sqlite, "sporades_schedule_occurrences", "definitionFingerprint", "TEXT");
    await sqlite.dialect.addMissingColumn(sqlite, "sporades_schedule_occurrences", "generationToken", "TEXT");
    await sqlite.prepare(sql("INSERT INTO [sporades] ([key], [value]) VALUES ('schedule-reconciliation-lock', 'v1') ON CONFLICT ([key]) DO NOTHING")).run();
    const migrateLegacyScheduleIdentity = async (adapter) => {
        const migrationSql = adapter.dialect.sql;
        await adapter.prepare(migrationSql("UPDATE [sporades] SET [value]=[value] WHERE [key]='schedule-reconciliation-lock'")).run();
        const schedules = await adapter.prepare(migrationSql("SELECT [name], [definitionFingerprint], [generationToken] FROM [sporades_schedules] ORDER BY [name] ASC")).all();
        const scheduleByName = new Map();
        for (const row of schedules) {
            let generationToken = row.generationToken;
            if (typeof generationToken !== "string" || generationToken.length === 0) {
                const proposed = nodeCryptoModule.randomUUID();
                await adapter.prepare(migrationSql("UPDATE [sporades_schedules] SET [generationToken]=? WHERE [name]=? AND ([generationToken] IS NULL OR [generationToken]='')")).run(proposed, row.name);
                const current = await adapter.prepare(migrationSql("SELECT [definitionFingerprint], [generationToken] FROM [sporades_schedules] WHERE [name]=?")).get(row.name);
                generationToken = current?.generationToken ?? proposed;
                row.definitionFingerprint = current?.definitionFingerprint ?? row.definitionFingerprint;
            }
            scheduleByName.set(String(row.name), { definitionFingerprint: row.definitionFingerprint, generationToken });
        }
        const pending = await adapter.prepare(migrationSql("SELECT [id], [scheduleName], [definitionFingerprint], [generationToken] FROM [sporades_schedule_occurrences] WHERE [status]='pending' AND ([definitionFingerprint] IS NULL OR [generationToken] IS NULL OR [generationToken]='') ORDER BY [scheduledFor] ASC, [id] ASC")).all();
        await scheduleStorageFault?.("after-legacy-pending-scan", { adapter });
        for (const row of pending) {
            const schedule = scheduleByName.get(String(row.scheduleName));
            if (!schedule)
                continue;
            if (row.definitionFingerprint !== null && row.definitionFingerprint !== undefined
                && row.definitionFingerprint !== schedule.definitionFingerprint)
                continue;
            await adapter.prepare(migrationSql("UPDATE [sporades_schedule_occurrences] SET [definitionFingerprint]=?, [generationToken]=? WHERE [id]=? AND [status]='pending' AND ([definitionFingerprint] IS NULL OR [definitionFingerprint]=?) AND ([generationToken] IS NULL OR [generationToken]='')")).run(schedule.definitionFingerprint, schedule.generationToken, row.id, schedule.definitionFingerprint);
        }
    };
    if (typeof sqlite.withTransaction === "function") {
        for (let attempt = 0;; attempt += 1) {
            try {
                await sqlite.withTransaction(migrateLegacyScheduleIdentity);
                break;
            }
            catch (error) {
                if (sqlite.engine !== "sqlite" || attempt >= 100 || String(error?.message ?? "") !== "database is locked")
                    throw error;
                await new Promise((resolve) => setTimeout(resolve, Math.min(25, attempt + 1)));
            }
        }
    }
    else
        await migrateLegacyScheduleIdentity(sqlite);
    await sqlite.exec(sql("CREATE UNIQUE INDEX IF NOT EXISTS [sporades_schedule_occurrence_identity] " +
        "ON [sporades_schedule_occurrences]([scheduleName], [scheduledFor])"));
}
export async function finishFailedScheduledOccurrence(database, definition, occurrence, error, claimToken) {
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
    if (Number(terminal.changes) !== 1)
        return { finished: false, nextOccurrence: null };
    const next = nextScheduleOccurrence(definition.fields, occurrence, definition.effectiveTimezone).toISOString();
    const summary = await database.adapter.prepare(sql("UPDATE [sporades_schedules] SET [nextOccurrence]=?, [latestScheduledFor]=?, [latestOutcome]='payload-failed', [latestJobId]=NULL, [latestErrorCode]=? WHERE [name]=? AND [enabled]=1 AND [definitionFingerprint]=? AND [generationToken]=?")).run(next, scheduledFor, code, definition.name, definition.fingerprint, definition.generationToken);
    if (Number(summary.changes) !== 1)
        throw new Error("Schedule definition changed during occurrence failure finalization.");
    return { finished: true, nextOccurrence: next };
}
export function scheduledOccurrenceIdentity(database, scheduleName, scheduledFor) {
    return nodeCryptoModule.createHash("sha256").update(JSON.stringify([database.capsuleIdentity, scheduleName, scheduledFor])).digest("hex");
}
function schedulePayloadFactoryAbortError() {
    const error = new Error("Schedule payload factory aborted.");
    error.code = "SCHEDULE_PAYLOAD_FACTORY_ABORTED";
    return error;
}
async function acquireSchedulePayloadFactorySlot(database, signal) {
    if (signal.aborted || database.__scheduleStopped)
        throw schedulePayloadFactoryAbortError();
    if (database.schedulePayloadFactoryActive < 4 && database.schedulePayloadFactoryWaiters.length === 0) {
        database.schedulePayloadFactoryActive += 1;
    }
    else {
        await new Promise((resolve, reject) => {
            const waiter = {};
            const remove = () => {
                const index = database.schedulePayloadFactoryWaiters.indexOf(waiter);
                if (index >= 0)
                    database.schedulePayloadFactoryWaiters.splice(index, 1);
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
            if (signal.aborted || database.__scheduleStopped)
                onAbort();
        });
    }
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        const waiter = database.schedulePayloadFactoryWaiters.shift();
        if (waiter)
            waiter.grant();
        else
            database.schedulePayloadFactoryActive -= 1;
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
export async function resolveSchedulePayload(database, definition, scheduledFor, context) {
    if (typeof definition.payload !== "function")
        return { ok: true, value: definition.payload };
    let releaseLane;
    let releaseSlot;
    const controller = new AbortController();
    const controllers = database.schedulePayloadFactoryControllers.get(definition.name) ?? new Set();
    controllers.add(controller);
    database.schedulePayloadFactoryControllers.set(definition.name, controllers);
    const occurrence = Object.freeze({ scheduleName: definition.name, scheduledFor });
    const factoryContext = Object.freeze({ signal: controller.signal, privileged: context.privileged });
    let timeout;
    let removeAbortListener;
    try {
        releaseLane = await acquireSchedulePayloadFactoryLane(database, definition.name);
        if (controller.signal.aborted || database.__scheduleStopped)
            throw schedulePayloadFactoryAbortError();
        releaseSlot = await acquireSchedulePayloadFactorySlot(database, controller.signal);
        if (controller.signal.aborted || database.__scheduleStopped)
            throw schedulePayloadFactoryAbortError();
        const timeoutFailure = new Promise((_resolve, reject) => {
            timeout = database.clock.setTimer(() => {
                controller.abort();
                const error = new Error("Schedule payload factory timed out.");
                error.code = "SCHEDULE_PAYLOAD_FACTORY_TIMEOUT";
                reject(error);
            }, database.schedulePayloadFactoryTimeoutMs);
        });
        const aborted = new Promise((_resolve, reject) => {
            const onAbort = () => reject(schedulePayloadFactoryAbortError());
            removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
            if (controller.signal.aborted)
                onAbort();
            else
                controller.signal.addEventListener("abort", onAbort, { once: true });
        });
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
        removeAbortListener?.();
        controllers.delete(controller);
        if (controllers.size === 0)
            database.schedulePayloadFactoryControllers.delete(definition.name);
        releaseSlot?.();
        releaseLane?.();
    }
}
export function abortSchedulePayloadFactories(database) {
    for (const controllers of database.schedulePayloadFactoryControllers?.values?.() ?? [])
        for (const controller of controllers)
            controller.abort();
}
export function createRuntimeClock(clock) {
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
// Jobs the runtime enqueues for itself. They live in the reserved `_sporades`
// namespace, which Capsule definitions cannot claim.
export function runtimeOwnedJobHandlers(runtime) {
    return [
        {
            name: PASSWORD_RESET_MAIL_JOB,
            handler: async (ctx, payload) => {
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
            handler: async (ctx, payload) => {
                const delivery = await runtime.prepareEmailPasswordResetDelivery(ctx, payload);
                if (!delivery)
                    return;
                return await ctx.mail.send(delivery);
            },
        },
    ];
}
function isReservedJobName(name) {
    return name.toLowerCase().startsWith(RESERVED_JOB_NAME_PREFIX);
}
export function jobHandlersFromCapsuleDefinition(capsuleDefinition) {
    const handlers = [];
    for (const [name, definition] of Object.entries(capsuleDefinition?.jobs ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) || definition?.kind !== "job" || typeof definition.handler !== "function") {
            throw commandError("Invalid Job handler.", "Declare jobs as named job(...) handlers using letters, numbers, underscores, or hyphens.");
        }
        // The runtime enqueues its own Jobs, such as password reset delivery. A
        // Capsule handler with the same name would capture that work, so the whole
        // prefix is reserved rather than any single name.
        if (isReservedJobName(name)) {
            throw commandError(`Reserved Job handler name: ${name}`, "Job names beginning with `_sporades` are reserved for the Sporades runtime. Rename this Job.", "RESERVED_JOB_NAME");
        }
        if (handlers.some((handler) => handler.name === name)) {
            throw commandError(`Duplicate Job handler: ${name}`, "Use one unique Job handler name per Capsule.");
        }
        handlers.push({ name, handler: definition.handler });
    }
    return handlers;
}
export async function ensureJobStorage(sqlite) {
    const sql = sqlite.dialect.sql;
    await sqlite.exec(sql("CREATE TABLE IF NOT EXISTS [sporades_jobs] (" +
        "[id] TEXT PRIMARY KEY, [handler] TEXT NOT NULL, [enqueuedByUserId] TEXT NOT NULL, [actorUserId] TEXT NOT NULL, " +
        "[actorProvider] TEXT, [payload] TEXT NOT NULL, [status] TEXT NOT NULL, [availableAt] TEXT NOT NULL, " +
        "[attempts] INTEGER NOT NULL, [idempotencyKey] TEXT, [result] TEXT, [failure] TEXT, [createdAt] TEXT NOT NULL, " +
        "[startedAt] TEXT, [completedAt] TEXT, [failedAt] TEXT)"));
    await sqlite.exec(sql("CREATE UNIQUE INDEX IF NOT EXISTS [sporades_jobs_idempotency] " +
        "ON [sporades_jobs]([handler], [actorUserId], [idempotencyKey]) WHERE [idempotencyKey] IS NOT NULL"));
    await sqlite.exec(sql("CREATE INDEX IF NOT EXISTS [sporades_jobs_runnable] ON [sporades_jobs]([status], [availableAt], [id])"));
    // The columns added to the Job queue after its first release are declared through the dialect's
    // add-missing-column strategy rather than probed for first. `PRAGMA table_info` is SQLite's
    // alone, and this definition is sent verbatim to whichever engine is configured, so the probe
    // made every Capsule boot on a Postgres Capsule service fail with `syntax error at or near
    // "PRAGMA"` before the Job queue existed.
    for (const [name, type] of [["retryJson", "TEXT"], ["attemptHistory", "TEXT"], ["cancelRequestedAt", "TEXT"], ["leaseExpiresAt", "TEXT"], ["claimToken", "TEXT"], ["scheduleName", "TEXT"], ["scheduledFor", "TEXT"], ["actorProvider", "TEXT"]])
        await sqlite.dialect.addMissingColumn(sqlite, "sporades_jobs", name, type);
    await sqlite.exec(sql("UPDATE [sporades_jobs] SET [actorProvider] = 'anonymous' WHERE [actorProvider] IS NULL OR [actorProvider] = ''"));
}
export async function scheduleSummary(sqlite, row) {
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
    const canonicalInstant = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
    if (row.nextOccurrence != null && !canonicalInstant(row.nextOccurrence))
        throw invalid("nextOccurrence");
    const latestOutcome = row.latestOutcome == null ? null : String(row.latestOutcome);
    let latestOccurrence = null;
    if (latestOutcome === null && [row.latestScheduledFor, row.latestJobId, row.latestErrorCode].some((value) => value != null))
        throw invalid("latestOccurrence");
    if (latestOutcome !== null && !canonicalInstant(row.latestScheduledFor))
        throw invalid("latestOccurrence.scheduledFor");
    if (latestOutcome === "enqueued") {
        if (typeof row.latestJobId !== "string" || !row.latestJobId)
            throw invalid("latestOccurrence.jobId");
        if (row.latestErrorCode != null)
            throw invalid("latestOccurrence.errorCode");
        const job = await sqlite.prepare(sqlite.dialect.sql("SELECT [id] FROM [sporades_jobs] WHERE [id]=? AND [scheduleName]=? AND [scheduledFor]=?")).get(row.latestJobId, row.name, row.latestScheduledFor);
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
export function assertJobScheduleProvenance(row, expected) {
    if (!expected)
        return;
    if (row?.scheduleName !== expected.scheduleName || row?.scheduledFor !== expected.scheduledFor) {
        throw jobError("JOB_IDEMPOTENCY_CONFLICT", "Scheduled occurrence idempotency conflicts with existing Job provenance.", "Inspect the existing Job and retry after resolving the conflicting internal idempotency key.");
    }
}
export function jobError(code, message, hint) {
    const error = new Error(message);
    error.code = code;
    error.hint = hint;
    return error;
}
export function boundedJobJson(value, limit, code, label) {
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
export function jobState(row, includeDetail) {
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
export function jobActorProvider(auth) {
    const provider = auth?.provider;
    if (typeof provider === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(provider))
        return provider;
    return auth?.isGuest ? "anonymous" : "authenticated";
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
            rows = await tx.prepare(tx.dialect.sql("SELECT * FROM [sporades_jobs] ORDER BY [createdAt] DESC, [id] DESC")).all();
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
/** Read the bounded operator view of every Schedule in one adapter snapshot. */
export async function inspectRuntimeSchedules(adapter) {
    const read = async (tx) => {
        let rows;
        try {
            rows = await tx.prepare(tx.dialect.sql("SELECT * FROM [sporades_schedules] ORDER BY [name] ASC")).all();
        }
        catch (error) {
            const message = String(error?.message ?? error);
            if (/no such table|does not exist|unknown table/i.test(message))
                return [];
            throw error;
        }
        const summaries = [];
        for (const row of rows)
            summaries.push(await scheduleSummary(tx, row));
        return summaries;
    };
    if (!adapter?.withReadOnlySnapshot)
        throw jobError("SCHEDULE_INSPECTION_READ_ONLY_UNAVAILABLE", "Database adapter does not support read-only Schedule inspection.", "Upgrade the Sporades runtime and retry inspection.");
    return await adapter.withReadOnlySnapshot(read);
}
export const MAX_JOB_TIMESTAMP_MS = Date.parse("9999-12-31T23:59:59.999Z");
export const MIN_JOB_TIMESTAMP_MS = Date.parse("0000-01-01T00:00:00.000Z");
export function normalizeJobAvailableAt(value) {
    let milliseconds = Number.NaN;
    try {
        if (typeof value === "string") {
            if (/^[+-]?\d+(?:\.\d+)?$/.test(value.trim()))
                throw new TypeError("Unsupported Job availability value.");
            milliseconds = new Date(value).getTime();
        }
        else {
            milliseconds = Date.prototype.getTime.call(value);
        }
    }
    catch { }
    if (!Number.isFinite(milliseconds) || milliseconds < MIN_JOB_TIMESTAMP_MS || milliseconds > MAX_JOB_TIMESTAMP_MS) {
        throw jobError("INVALID_JOB_OPTIONS", "Invalid Job availability time.", "Pass an availableAt value in the supported four-digit UTC timestamp range.");
    }
    return new Date(milliseconds).toISOString();
}
export function isCanonicalJobTimestamp(value) {
    if (typeof value !== "string")
        return false;
    try {
        return normalizeJobAvailableAt(value) === value;
    }
    catch {
        return false;
    }
}
export function normalizeJobRetry(value) {
    if (value === undefined)
        return { maxAttempts: 1, delayMs: 0 };
    let maxAttempts;
    let delayMs;
    let hasMaxAttempts = false;
    let keys = [];
    try {
        if (!value || typeof value !== "object" || Array.isArray(value))
            throw new TypeError("Invalid Job retry policy.");
        keys = Reflect.ownKeys(value);
        hasMaxAttempts = Object.prototype.hasOwnProperty.call(value, "maxAttempts");
        maxAttempts = value.maxAttempts;
        delayMs = Object.prototype.hasOwnProperty.call(value, "delayMs") ? value.delayMs : 0;
    }
    catch { }
    if (!hasMaxAttempts || keys.some((key) => typeof key !== "string" || !["maxAttempts", "delayMs"].includes(key))
        || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20
        || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_JOB_TIMESTAMP_MS) {
        throw jobError("INVALID_JOB_OPTIONS", "Invalid Job retry policy.", "Pass retry.maxAttempts (1-20) and retry.delayMs within the supported Job timestamp range.");
    }
    return { maxAttempts, delayMs };
}
export function parsePersistedJobRetry(value) {
    try {
        return normalizeJobRetry(value ? JSON.parse(value) : undefined);
    }
    catch {
        return null;
    }
}
export function jobTimestampAfter(instant, delayMs) {
    const milliseconds = instant.getTime() + delayMs;
    if (!Number.isFinite(milliseconds) || milliseconds < MIN_JOB_TIMESTAMP_MS || milliseconds > MAX_JOB_TIMESTAMP_MS)
        return null;
    return new Date(milliseconds).toISOString();
}
export function invalidJobRetryPolicyFailure() {
    return { code: "JOB_RETRY_POLICY_INVALID", message: "The stored Job retry policy is invalid." };
}
export async function cancelJob(database, context, id) {
    const sql = database.adapter.dialect.sql;
    const read = () => context.__privilegedJobAccess
        ? database.adapter.prepare(sql("SELECT * FROM [sporades_jobs] WHERE [id] = ?")).get(id)
        : database.adapter.prepare(sql("SELECT * FROM [sporades_jobs] WHERE [id] = ? AND [actorUserId] = ?")).get(id, context.auth.userId);
    // Cancellation is a state transition, not a stale projection update. Retry
    // when another runtime wins between the authorized read and the guarded
    // write so a queued cancellation cannot overwrite a newly running claim.
    for (let transition = 0; transition < 8; transition += 1) {
        const row = await read();
        if (!row)
            return null;
        const now = database.clock.now().toISOString();
        if (["queued", "delayed"].includes(row.status)) {
            const changed = await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [status]='cancelled', [completedAt]=?, [startedAt]=NULL, " +
                "[leaseExpiresAt]=NULL, [claimToken]=NULL WHERE [id]=? AND [status]=?")).run(now, id, row.status);
            if (Number(changed?.changes ?? 0) === 1)
                return jobState({ ...row, status: "cancelled", completedAt: now, startedAt: null, leaseExpiresAt: null }, true);
            continue;
        }
        if (row.status === "running") {
            const hasClaimToken = typeof row.claimToken === "string" && row.claimToken.length > 0;
            const changed = await database.adapter.prepare(sql("UPDATE [sporades_jobs] SET [cancelRequestedAt]=? WHERE [id]=? AND [status]='running' AND " +
                (hasClaimToken ? "[claimToken]=?" : "[claimToken] IS NULL"))).run(now, id, ...(hasClaimToken ? [row.claimToken] : []));
            if (Number(changed?.changes ?? 0) !== 1)
                continue;
            const runtimeDatabase = database.__rootDatabase ?? database;
            if (database.__transactionActive) {
                const pendingContext = context.__jobParentContext ?? context;
                // The context holder belongs to the transaction and survives supported
                // middleware replacement; the current context projection may not.
                const pendingOwner = pendingContext.__sporadesContextHolder ?? pendingContext;
                pendingOwner.__pendingJobCancellationAborts ??= new Map();
                pendingOwner.__pendingJobCancellationAborts.set(id, { runtimeDatabase, claimToken: row.claimToken });
            }
            else {
                abortRuntimeJobClaim(runtimeDatabase, id, row.claimToken);
            }
            return jobState({ ...row, cancelRequestedAt: now }, true);
        }
        throw jobError("INVALID_JOB_STATE", "Job cannot be cancelled from its current state.", "Only queued, delayed, or running Jobs can be cancelled.");
    }
    throw jobError("JOB_STATE_CHANGED", "Job state changed while cancellation was requested.", "Retry the Job cancellation.");
}
export function commitPendingJobCancellationAborts(context) {
    if (!context)
        return;
    const pendingContext = context.__jobParentContext ?? context;
    const pendingOwner = pendingContext.__sporadesContextHolder ?? pendingContext;
    const pending = pendingOwner.__pendingJobCancellationAborts;
    if (!(pending instanceof Map))
        return;
    delete pendingOwner.__pendingJobCancellationAborts;
    for (const [id, claim] of pending)
        abortRuntimeJobClaim(claim.runtimeDatabase, id, claim.claimToken);
}
export function dropPendingJobCancellationAborts(context) {
    if (!context)
        return;
    const pendingContext = context.__jobParentContext ?? context;
    const pendingOwner = pendingContext.__sporadesContextHolder ?? pendingContext;
    delete pendingOwner.__pendingJobCancellationAborts;
}
function abortRuntimeJobClaim(runtimeDatabase, id, claimToken) {
    const activeClaim = runtimeDatabase.__jobAbortControllers?.get(id);
    const controller = activeClaim?.controller ?? activeClaim;
    if (!activeClaim?.claimToken || activeClaim.claimToken === claimToken)
        controller?.abort?.();
}
export function jobSummary(row) { return { id: row.id, handler: row.handler, status: row.status, attempts: Number(row.attempts) }; }
export function encodeJobCursor(row) { return Buffer.from(JSON.stringify({ createdAt: row.createdAt, id: row.id })).toString("base64url"); }
export function decodeJobCursor(value) {
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
export function safeJobFailure(error) {
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
//# sourceMappingURL=jobs-runtime.js.map