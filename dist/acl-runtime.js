// The ACL and privileged-audit domain: table ACL policy as ADR-0022 defines it, the privileged
// server role's `ctx.privileged` surface as ADR-0027 separates it from Capsule roles, and the audit
// event every privileged run emits.
//
// Batch 7 of the migration ADR-0041 records. Fifty-nine declarations — fifty-five functions and
// four constants — of which twenty-eight are exported and thirty-one are private to this file. All
// fifty-nine were entries in `SERVER_RUNTIME_SOURCE_FUNCTIONS` or serialized into the generated
// bundle's constant preamble, because under the emitted list a runtime function reached a deployed
// Capsule as its own source text and anything it called or closed over had to be registered
// alongside it. The thirty-one private ones are the measure of what that cost.
//
// ## What is in this file and what is not
//
// A name sweep for `acl`, `privileged` and `audit` over the monolith collects sixty-three
// declarations. The reference graph disagrees with that number in both directions, which is the
// case ADR-0041 records batch 6 finding first, so both directions are written out here rather than
// left for the next reader to recompute.
//
// **One of the sixty-three is not this domain's**, and only the reverse graph says so.
// `runMutationHookAndDrainPendingAclWrites` sits at the mutation layer, immediately below
// `runMutationHook`, and its whole body is `runMutationHook` in a `try` with `drainPendingAclWrites`
// in the `finally`. No function in this domain calls it; its one caller is `runMutation`. It is a
// mutation-hook runner that happens to close an ACL lane, the sweep takes it for the name, and it
// stayed in the monolith and imports `drainPendingAclWrites` from here. Layout is not membership,
// and neither is spelling.
//
// **Three of the sixty-three could not travel**, and the reference graph names what holds each:
//
//   createPrivilegedHandlerContext   createContextHolder, createEndpointDatabaseApi
//   createContextPrivilegedApi       createPrivilegedHandlerContext (they are mutually recursive)
//   createPrivilegedJobApi           createCurrentUserJobApi
//
// All three are held by the composition core rather than by a domain. `createContextHolder` and
// `createEndpointDatabaseApi` are what `createEndpointContext` and `createMutationContext` build a
// handler context out of, and `createPrivilegedHandlerContext` is the same composition for a
// privileged run — it is the point where this domain's API, the Database API, the Job API, the
// Schedule API, the File API and the mail runtime are assembled onto one object. `createCurrentUserJobApi`
// is the jobs domain's and is itself held by `createMutationContext`, which is why batch 4 left it.
//
// So this is batch 4's case rather than batch 5's: **the chain has to be closed at the end that
// holds it, and that end is ticket 05.** No later batch on ticket 04's list clears these three.
// Everything the three *call* is in this file, so the monolith imports twenty-one names back and
// the three functions are the only part of the domain still there. Twenty-eight names are exported;
// the other seven are for consumers outside the monolith — the constant probe, `src/cli`'s privileged
// audit event, `test/mail.test.js` and `test/database-adapter.test.js` — which reach them through
// `server-runtime-source.js`'s `export * from "./acl-runtime.js"`.
//
// **Two blockers were owned by no batch at all**, which is the third case batch 6 added, and both
// became modules of their own rather than riders here: `runtime-log-policy.js` holds
// `isSensitiveLogKey` and `logIndexLimit`, and `stored-value-coding.js` holds `deserializeRow`.
// Their headers record what each was holding. Naming them here rather than only there, because
// which module a helper landed in is exactly the decision a reader of *this* file will want to
// check.
//
// ## The four constants
//
// `PRIVILEGED_AUDIT_SCHEMA`, `PRIVILEGED_AUDIT_ACTOR_KINDS`, `PRIVILEGED_AUDIT_OUTCOMES` and
// `ACL_HELPER_STATE` were the last four entries in the generated bundle's constant preamble, and
// they left it in the same commit that moved them. They had to: they are declarations inside this
// module's carried text now, and serializing them into the preamble as well would declare each name
// twice at the top level of an ES module — a load-time `SyntaxError` in a deployed Capsule rather
// than a drift, which is the hazard ADR-0041 records batch 3 hitting with `commandError`. The
// preamble now serializes nothing at all.
//
// All four stay exported, because the constant probe in `test/server-bundle-module-graph.test.js`
// derives what it compares from `server-runtime-source.js`'s own SCREAMING_CASE exports and reaches
// them through that module's `export * from "./acl-runtime.js"`.
//
// ## How this file reaches a deployed Capsule
//
// Both bundlers carry it whole (ADR-0041): the module-graph bundle imports it, and the emitted-list
// bundle builds it into the one IIFE `MIGRATED_RUNTIME_MODULES` names, together with the six other
// migrated modules it imports from. A name that fails to travel out of this file is a compile error
// rather than a `ReferenceError` in a deployed Capsule — which this domain paid for twice already:
// `markAsyncAclHelperRead` and `resolveAclStorageFileReference` are two of the four production
// `ReferenceError`s that `test/server-bundle-free-bindings.test.js` exists because of, and both are
// private declarations in this file now, registered in nothing.
//
// This module reaches no Node builtin, so ADR-0042's accessor does not appear here.
//
// ## Nothing is redesigned
//
// Every body is byte-identical to the declaration it moved from, every call site in the repository
// is untouched, and the monolith imports back exactly what its remaining functions resolve.
import { createPublicFileUrl, createStructuredFileError, deletePrivateFile, fileMetadataFromRow, isAbsoluteFilePath, normalizeAbsoluteFilePath, resolvePrivilegedLiveFileReference } from "./file-storage-runtime.js";
import { jobError, scheduleSummary } from "./jobs-runtime.js";
import { isPromiseLike } from "./maybe-promise.js";
import { commandError } from "./runtime-errors.js";
import { isSensitiveLogKey, logIndexLimit } from "./runtime-log-policy.js";
import { deserializeRow } from "./stored-value-coding.js";
// The privileged audit event's contract. All three were serialized into the generated bundle's
// constant preamble until batch 7; they are declarations inside this module's carried text now, and
// the preamble no longer writes them. They stay exported because the constant probe in
// `test/server-bundle-module-graph.test.js` derives what it compares from the runtime module's own
// SCREAMING_CASE exports, which reach these through `export * from "./acl-runtime.js"`.
export const PRIVILEGED_AUDIT_SCHEMA = "sporades.privileged-audit.v1";
export const PRIVILEGED_AUDIT_ACTOR_KINDS = new Set(["privileged-server-role", "captured-user", "platform", "unknown"]);
export const PRIVILEGED_AUDIT_OUTCOMES = new Set(["started", "completed", "errored", "finished"]);
export function createPrivilegedAuditEmitter(log) {
    return {
        emit(details) {
            return emitPrivilegedAuditEvent(log, details);
        },
    };
}
export function emitPrivilegedAuditEvent(target, details = {}) {
    const log = target?.log?.emit ? target.log : target;
    if (!log?.emit) {
        throw new Error("Privileged audit events require a runtime log sink.");
    }
    return log.emit(createPrivilegedAuditLogInput(details));
}
export async function emitPrivilegedRunAudit(database, context, details) {
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
export async function reindexPrivilegedAuditEventsAfterRollback(database, context) {
    const events = context?.__privilegedAuditEvents;
    if (!Array.isArray(events) || events.length === 0) {
        return;
    }
    for (const event of events) {
        try {
            if (await privilegedAuditEventAlreadyIndexed(database, event)) {
                continue;
            }
            await database.adapter.insertLogIndexEvent(event);
        }
        catch {
            return;
        }
    }
    try {
        await database.adapter.pruneLogIndex(logIndexLimit(database.config ?? {}));
    }
    catch {
    }
}
async function privilegedAuditEventAlreadyIndexed(database, event) {
    const recent = await database.adapter.readRecentLogEvents(logIndexLimit(database.config ?? {}));
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
export function normalizePrivilegedRunSignal(value) {
    if (value && typeof value === "object" && typeof value.aborted === "boolean") {
        return value;
    }
    return new AbortController().signal;
}
export function createPrivilegedRunAbortError() {
    return commandError("Privileged run aborted.", "Retry the privileged operation if cancellation was not intended.", "ABORTED");
}
export function createPrivilegedRunAuditDetails(context, options) {
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
export function createPrivilegedRunPublicError(cause) {
    const error = commandError("Privileged run failed.", "Check the privileged audit events and server logs before exposing a safe response.", "PRIVILEGED_RUN_FAILED");
    error.cause = cause;
    return error;
}
export function createPrivilegedAuditEmissionPublicError(cause, context = undefined) {
    const error = commandError("Privileged audit emission failed.", "Check the server audit log configuration before retrying the privileged operation.", "PRIVILEGED_AUDIT_EMISSION_FAILED");
    error.cause = cause;
    if (context) {
        error.privilegedAuditContext = context;
    }
    return error;
}
export function isPrivilegedAuditEmissionPublicError(error) {
    return error?.code === "PRIVILEGED_AUDIT_EMISSION_FAILED";
}
export function createPrivilegedScheduleApi(database, contextGetter) {
    const sqlite = () => (database.__rootDatabase ?? database).adapter;
    return {
        async get(name) {
            assertActivePrivilegedJobAccess(contextGetter);
            if (typeof name !== "string" || !name)
                throw jobError("INVALID_SCHEDULE_NAME", "Invalid Schedule name.", "Pass a non-empty declared Schedule name.");
            const row = await sqlite().prepare(sqlite().dialect.sql("SELECT * FROM [sporades_schedules] WHERE [name]=?")).get(name);
            return row ? await scheduleSummary(sqlite(), row) : null;
        },
        async list() {
            assertActivePrivilegedJobAccess(contextGetter);
            const rows = await sqlite().prepare(sqlite().dialect.sql("SELECT * FROM [sporades_schedules] ORDER BY [name] ASC")).all();
            const summaries = [];
            for (const row of rows)
                summaries.push(await scheduleSummary(sqlite(), row));
            return summaries;
        },
    };
}
export function createPrivilegedFileApi(database, contextGetter) {
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
                    file: {
                        ...fileMetadataFromRow(row),
                        ownerId: row.ownerId,
                    },
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
export function safePrivilegedAuditErrorCode(value, outcome = "started") {
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
export function normalizeTableAcl(tableName, aclRules) {
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
export function normalizeFileAcl(aclRules) {
    const supportedOperations = new Set(["read", "publicUrl", "delete"]);
    if (aclRules === undefined) {
        return {
            resolve() {
                return undefined;
            },
        };
    }
    if (!aclRules || typeof aclRules !== "object" || Array.isArray(aclRules)) {
        throw commandError("Invalid Capsule File ACL.", "Declare files as { acl: { read?, publicUrl?, delete? } }.", "INVALID_FILE_ACL");
    }
    const normalized = {};
    for (const [operation, rule] of Object.entries(aclRules)) {
        if (!supportedOperations.has(operation)) {
            throw commandError(`Unsupported Capsule File ACL operation: ${operation}.`, "Supported File ACL operations are read, publicUrl, and delete.", "INVALID_FILE_ACL");
        }
        if (typeof rule !== "function") {
            throw commandError(`Invalid Capsule File ACL: ${operation}.`, "File ACL rules must be functions.", "INVALID_FILE_ACL");
        }
        normalized[operation] = rule;
    }
    normalized.resolve = function resolve(operation) {
        return this[operation];
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
export function createTableAclContext(context, database) {
    // ACL evaluation is deliberately read-only. Current-user Teams can lazily
    // bootstrap durable state, so policy callbacks receive only constrained
    // membership decisions rather than the normal Team management API.
    const { db, privileged, jobs, mail, request, teams, __pendingAclWrites, __sporadesContextHolder, ...aclContext } = context ?? {};
    return {
        ...aclContext,
        acl: createAclHelpers(database, context),
    };
}
export function createFileAclContext(auth, database) {
    // A File request has no trusted Capsule handler context. Its policy gets the
    // same constrained, read-only ACL decisions as a table rule, but only the
    // authenticated actor: no db API, mutable Teams API, request, or privileged
    // capability can cross this boundary.
    const context = { auth: Object.freeze({ ...auth }) };
    return Object.freeze({
        auth: context.auth,
        acl: createAclHelpers(database, context),
    });
}
export function applyFileAcl(database, operation, row, auth) {
    const rule = database.fileAcl?.resolve?.(operation);
    if (!rule)
        return false;
    const context = createFileAclContext(auth, database);
    const input = Object.freeze({
        ctx: context,
        operation,
        file: Object.freeze(aclStorageMetadataFromFileRow(row)),
    });
    const deny = () => {
        emitFileAclDeniedLog(database, { context, operation, row });
        return false;
    };
    const result = rule(input);
    if (!isPromiseLike(result)) {
        return result && !aclRuleTouchedAsyncHelperRead(context) ? true : deny();
    }
    return Promise.resolve(result).then((allowed) => (allowed && !aclRuleTouchedAsyncHelperRead(context) ? true : deny()));
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
export function grantPrivilegedDbAccess(context) {
    if (context && typeof context === "object") {
        privilegedDbAccessContextSet().add(context);
    }
    return context;
}
export function revokePrivilegedDbAccess(context) {
    if (context && typeof context === "object") {
        privilegedDbAccessContextSet().delete(context);
    }
    return context;
}
function hasPrivilegedDbAccess(context) {
    return Boolean(context && typeof context === "object" && privilegedDbAccessContextSet().has(context));
}
export function runTableWriteWithAcl(database, table, operation, previous, next, contextGetter, write) {
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
export function applyReadAcl(database, table, row, context) {
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
export function filterRowsByReadAcl(database, table, rows, context) {
    const decisions = rows.map((row) => applyReadAcl(database, table, row, context));
    if (decisions.some(isPromiseLike)) {
        return Promise.all(decisions).then((resolved) => rows.filter((_, index) => resolved[index]));
    }
    return rows.filter((_, index) => decisions[index]);
}
// The key the ACL helper objects hang their per-rule read state on, and the one constant in this
// runtime whose identity had to be reasoned about rather than compared.
//
// **What changed in batch 7, and why it is strictly an improvement.** A `Symbol` has no
// serialization, so while this name was in the emitted bundle's constant preamble the bundle
// rebuilt it from this declaration's description — `Symbol("sporades.aclHelperState")` written out
// again — and a deployed Capsule therefore held a *different* Symbol than this module's. That was
// safe, and issue 16 recorded the argument: this key has exactly one writer (`createAclHelpers`)
// and exactly one reader (`aclRuleTouchedAsyncHelperRead`), both of which travelled into the bundle
// and both of which resolved the name to the preamble's single declaration, and the frozen helper
// objects it keys never cross between a bundled Capsule and this process.
//
// It is now a declaration inside this module, carried into the emitted-list bundle as part of the
// module's own text, so the preamble does not write it and **there is exactly one
// `Symbol("sporades.aclHelperState")` expression in each bundle** rather than a declaration and a
// reconstruction of it. The module-graph bundle already had that property — ticket 02's review
// recorded it as the one place the new bundle is deliberately not a copy of the old one — and the
// emitted-list bundle has it now too. The writer and the reader are still the only two, they are
// still in one scope together, and that scope is now this file rather than a bundle's top level.
//
// The property is executed rather than asserted, on every bundle build. The ACL enforcement limb in
// `describeMigratedModuleAnswers` drives a synchronous rule whose helper read returns a thenable:
// `markAsyncAclHelperRead` writes `touchedAsyncRead` through this key and
// `aclRuleTouchedAsyncHelperRead` reads it back through this key, and the write is denied. Two
// Symbols would make that read `undefined` and the write would be **allowed** — so a copy in which
// the two had come apart is a disagreement in that limb rather than a silent fail-open.
export const ACL_HELPER_STATE = Symbol("sporades.aclHelperState");
function createAclHelpers(database, context) {
    const state = { readCount: 0, maxReads: 32, touchedAsyncRead: false };
    const helpers = {
        db: createAclDbHelpers(database, state),
        storage: createAclStorageHelpers(database, state),
        teams: createAclTeamHelpers(database, context, state),
    };
    Object.defineProperty(helpers, ACL_HELPER_STATE, {
        value: state,
        enumerable: false,
    });
    return Object.freeze(helpers);
}
function createAclTeamHelpers(database, context, state) {
    return Object.freeze({
        isMember(teamId) {
            const membership = readAclTeamMembership(database, context, state, teamId);
            return membership?.role === "admin" || membership?.role === "member";
        },
        isAdmin(teamId) {
            return readAclTeamMembership(database, context, state, teamId)?.role === "admin";
        },
        hasRole(teamId, role) {
            assertAclHelperReadAllowed(state);
            if (!isActiveAclTeamApplicationRole(database, role))
                return false;
            const actorUserId = aclTeamActorUserId(context);
            if (!actorUserId || !isAclTeamId(teamId))
                return false;
            const selected = database.adapter.prepare(database.adapter.dialect.sql("SELECT [r].[role] FROM [sporades_team_memberships] [m] " +
                "JOIN [sporades_team_membership_application_roles] [r] ON [r].[teamId] = [m].[teamId] AND [r].[userId] = [m].[userId] " +
                "WHERE [m].[teamId] = ? AND [m].[userId] = ? AND [r].[role] = ?")).get(teamId, actorUserId, role);
            if (markAsyncAclHelperRead(state, selected))
                return false;
            return selected?.role === role;
        },
        hasAnyRole(teamId, roles) {
            assertAclHelperReadAllowed(state);
            if (!Array.isArray(roles) || roles.length === 0 || roles.length > 32 || new Set(roles).size !== roles.length)
                return false;
            const activeRoles = roles.filter((role) => isActiveAclTeamApplicationRole(database, role));
            if (activeRoles.length !== roles.length)
                return false;
            const actorUserId = aclTeamActorUserId(context);
            if (!actorUserId || !isAclTeamId(teamId))
                return false;
            const placeholders = activeRoles.map(() => "?").join(", ");
            const selected = database.adapter.prepare(database.adapter.dialect.sql("SELECT [r].[role] FROM [sporades_team_memberships] [m] " +
                "JOIN [sporades_team_membership_application_roles] [r] ON [r].[teamId] = [m].[teamId] AND [r].[userId] = [m].[userId] " +
                `WHERE [m].[teamId] = ? AND [m].[userId] = ? AND [r].[role] IN (${placeholders})`)).all(teamId, actorUserId, ...activeRoles);
            if (markAsyncAclHelperRead(state, selected))
                return false;
            return Array.isArray(selected) && selected.some((row) => activeRoles.includes(row?.role));
        },
    });
}
function readAclTeamMembership(database, context, state, teamId) {
    assertAclHelperReadAllowed(state);
    const actorUserId = aclTeamActorUserId(context);
    if (!actorUserId || !isAclTeamId(teamId))
        return null;
    const selected = database.adapter.prepare(database.adapter.dialect.sql("SELECT [role] FROM [sporades_team_memberships] WHERE [teamId] = ? AND [userId] = ?")).get(teamId, actorUserId);
    if (markAsyncAclHelperRead(state, selected))
        return null;
    return selected ?? null;
}
function aclTeamActorUserId(context) {
    const auth = context?.auth;
    if (!auth?.isAuthenticated || auth?.isGuest || typeof auth?.userId !== "string" || auth.userId.length === 0)
        return null;
    return auth.userId;
}
function isAclTeamId(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 128;
}
function isActiveAclTeamApplicationRole(database, role) {
    return typeof role === "string" && Array.isArray(database.teamApplicationRoles) && database.teamApplicationRoles.includes(role);
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
            const selected = database.adapter.selectAppRowById(table, id);
            if (markAsyncAclHelperRead(state, selected)) {
                return null;
            }
            return selected ? deserializeRow(table, selected) : null;
        },
        exists(tableName, id) {
            assertAclHelperReadAllowed(state);
            const table = resolveAclAppTable(database, tableName);
            const selected = database.adapter.selectAppRowById(table, id);
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
        const selected = database.adapter.selectLiveFileByPath(path);
        if (markAsyncAclHelperRead(state, selected)) {
            return null;
        }
        const resolved = selected.length > 1 ? { ambiguous: true } : (selected[0] ?? null);
        return resolved?.ambiguous ? null : resolved;
    }
    const selected = database.adapter.selectFileById(value);
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
export function emitAclDeniedLog(database, details) {
    database.log?.emit?.({
        category: "platform",
        event: "acl.denied",
        level: "warn",
        message: "ACL denied table operation.",
        data: details.data ?? createAclDenialLogData(details),
    });
}
function emitFileAclDeniedLog(database, { context, operation, row }) {
    database.log?.emit?.({
        category: "platform",
        event: "acl.denied",
        level: "warn",
        message: "ACL denied File operation.",
        data: {
            resource: { kind: "file", id: row?.id ?? null },
            operation,
            rule: { category: "file", declaredOperation: operation },
            actor: {
                userId: context?.auth?.userId ?? null,
                provider: context?.auth?.provider ?? null,
                isAuthenticated: context?.auth?.isAuthenticated ?? null,
                isGuest: context?.auth?.isGuest ?? null,
            },
        },
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
export function assertActivePrivilegedJobAccess(contextGetter) {
    if (hasPrivilegedDbAccess(contextGetter?.()))
        return;
    throw jobError("PRIVILEGED_JOB_ACCESS_INACTIVE", "Privileged Job access is no longer active.", "Start a new ctx.privileged.run callback before using privileged Job operations.");
}
export async function drainPendingAclWrites(context) {
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
//# sourceMappingURL=acl-runtime.js.map