import { createHash } from "node:crypto";

type RecordValue = Record<string, any>;

const resourceAbort = Symbol("resourceAbort");
function resourceAbortError() {
  return Object.assign(new Error("Job aborted."), { name: "AbortError", code: "ABORTED", [resourceAbort]: true });
}
/** Internal signal: settlement must also verify the exact claim's durable cancellation marker. */
export function isResourceAbortError(error: any): boolean {
  return error?.[resourceAbort] === true;
}


/** Public errors never include caller data or engine diagnostics. */
export function resourceError(code: string) {
  return Object.assign(new Error(code === "RESOURCE_BUSY"
    ? "Resource transaction is busy." : "Resource operation could not complete."), {
    code,
    ...(code === "RESOURCE_BUSY" ? { retryable: true } : {}),
  });
}

export function resourceCanonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const visit = (input: any, depth: number): any => {
    if (depth > 64) throw resourceError("RESOURCE_INVALID_INPUT");
    if (input === null || typeof input === "boolean" || typeof input === "string") return input;
    if (typeof input === "number" && Number.isFinite(input)) return input === 0 ? 0 : input;
    if (typeof input !== "object" || ancestors.has(input)) throw resourceError("RESOURCE_INVALID_INPUT");
    const prototype = Object.getPrototypeOf(input);
    if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null) throw resourceError("RESOURCE_INVALID_INPUT");
    if (Object.getOwnPropertySymbols(input).length) throw resourceError("RESOURCE_INVALID_INPUT");
    ancestors.add(input);
    const output: any = Array.isArray(input) ? [] : Object.create(null);
    const keys = Array.isArray(input) ? Array.from({ length: input.length }, (_, i) => String(i)) : Object.keys(input).sort();
    if (Array.isArray(input) && Object.keys(input).length !== input.length) throw resourceError("RESOURCE_INVALID_INPUT");
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw resourceError("RESOURCE_INVALID_INPUT");
      output[key] = visit(descriptor.value, depth + 1);
    }
    ancestors.delete(input);
    return output;
  };
  const json = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(json, "utf8") > 65_536) throw resourceError("RESOURCE_INVALID_INPUT");
  return json;
}

function boundedIdentity(value: any) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 128
    || Buffer.from(value, "utf8").toString("utf8") !== value) throw resourceError("RESOURCE_INVALID_INPUT");
  return value;
}

function optionsSnapshot(options: any, status: boolean) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype
    || Object.getOwnPropertySymbols(options).length
    || Object.values(Object.getOwnPropertyDescriptors(options)).some(descriptor => !Object.hasOwn(descriptor, "value"))
    || Object.keys(options).sort().join(",") !== (status ? "operationId,resource" : "input,operationId,resource")
    || !options.resource || Object.getPrototypeOf(options.resource) !== Object.prototype
    || Object.getOwnPropertySymbols(options.resource).length
    || Object.values(Object.getOwnPropertyDescriptors(options.resource)).some(descriptor => !Object.hasOwn(descriptor, "value"))
    || Object.keys(options.resource).sort().join(",") !== "id,table") throw resourceError("RESOURCE_INVALID_INPUT");
  const table = boundedIdentity(options.resource.table);
  const id = boundedIdentity(options.resource.id);
  const operationId = boundedIdentity(options.operationId);
  return { table, id, operationId, digest: status ? null : createHash("sha256").update(resourceCanonicalJson(options.input)).digest("hex") };
}

export const unsupportedResources = Object.freeze({
  async run(): Promise<never> { throw resourceError("RESOURCE_CONTEXT_UNSUPPORTED"); },
  async status(): Promise<never> { throw resourceError("RESOURCE_CONTEXT_UNSUPPORTED"); },
});

/**
 * Binds the same receipt protocol to a transaction which was opened by a
 * mutation or Custom endpoint.  It deliberately does not open another writer:
 * the enclosing handler owns commit/rollback, so a returned value is provisional
 * until that handler's transaction commits.
 */
export function bindOuterResources(database: RecordValue, context: RecordValue, hooks: RecordValue) {
  let invocationActive = true;
  let used = false;
  let scopeActive = false;
  let admission = false;
  let touched = false;
  let terminalError: any;
  let outerDeadline = 0;
  let watchdog: any;
  let rejectOuterAbort: (error: any) => void = () => {};
  const outerAborted = new Promise<never>((_, reject) => { rejectOuterAbort = reject; });
  void outerAborted.catch(() => {});
  const parentDb = context.db;
  const parentJobs = context.jobs;
  const pending = new Set<Promise<any>>();
  const executions = new Set<Promise<any>>();
  const normalizeStorageError = (error: any) => error?.code === "RESOURCE_BUSY" || error?.code === "SQLITE_BUSY" || error?.errcode === 5 || error?.errcode === 6
    ? resourceError("RESOURCE_BUSY")
    : error?.code === "ERR_SQLITE_ERROR" || error?.errcode !== undefined
      ? resourceError("RESOURCE_STORAGE_ERROR")
      : error;
  const track = (operation: () => any) => {
    let value: any;
    try { value = operation(); }
    catch (error) { terminalError ??= normalizeStorageError(error); throw error; }
    if (!value || typeof value.then !== "function") return value;
    const promise = Promise.resolve(value);
    pending.add(promise);
    void promise.catch((error) => { terminalError ??= normalizeStorageError(error); });
    return promise;
  };
  const trackExecution = (operation: () => any, poison = true) => {
    let value: any;
    try { value = operation(); }
    catch (error) { if (poison) terminalError ??= error; throw error; }
    const promise = Promise.resolve(value);
    executions.add(promise);
    // `run` and `status` cover acquisition, authorization, replay, callback,
    // canonicalization, receipt, log staging and cleanup. Once entry has been
    // admitted, every rejected execution must poison outer settlement even if
    // its caller catches it or never awaits it.
    void promise.catch(() => {});
    return promise;
  };
  const actorDigest = createHash("sha256").update(resourceCanonicalJson({ auth: context.auth, credential: context.credential ?? null, privileged: false })).digest("hex");
  const guardCapability = (name: string, value: any) => wrapCapability(value, (path) => {
      if (used) throw resourceError(!invocationActive || !scopeActive || !admission ? "RESOURCE_SCOPE_INACTIVE" : ["db", "privileged", "jobs"].includes(name) ? "RESOURCE_CONTEXT_UNSUPPORTED" : "RESOURCE_EFFECT_UNSUPPORTED");
      if (!["where", "orderBy", "limit"].includes(path.at(-1)!)) touched = true;
    });
  for (const name of ["db", "log", "files", "mail", "payments", "messages", "privileged", "jobs", "schedules", "teams", "teamBilling", "accessKeys", "serviceUsers", "serverAuth", "lifecycle"]) {
    if (!context[name]) continue;
    context[name] = guardCapability(name, context[name]);
  }
  const execute = async (options: any, callback: any, status: boolean) => {
    if (!invocationActive) throw resourceError("RESOURCE_SCOPE_INACTIVE");
    if (used || touched) throw resourceError("RESOURCE_CONTEXT_UNSUPPORTED");
    if (!(["sqlite", "postgres"].includes(database.adapter.engine)) || database.adapter[Symbol.for("sporades.database.resourceTransactionEligible")] !== true) throw resourceError("RESOURCE_ADAPTER_UNSUPPORTED");
    const identity = optionsSnapshot(options, status);
    if (!status && typeof callback !== "function") throw resourceError("RESOURCE_INVALID_INPUT");
    if (!database.schema.tables.some((table: any) => table.name === identity.table)) throw resourceError("RESOURCE_INVALID_INPUT");
    used = true; scopeActive = true; admission = true;
    hooks.resourceEntered?.();
    // Mark only this opt-in outer transaction for resource-aware COMMIT outcome
    // handling. Ordinary mutations retain their historical transaction semantics.
    ((database as any)[Symbol.for("sporades.database.outerTransactionAdapter")] ?? database.adapter as any)[Symbol.for("sporades.database.resourceOuterTransaction")] = true;
    const deadline = hooks.startedAt + 30_000;
    outerDeadline = deadline;
    // The outer lifecycle tears down its watchdog during async cleanup, before
    // the database adapter reaches COMMIT. Keep the resource deadline as an
    // adapter-owned pre-commit check so that gap cannot admit stale writes.
    const beforeCommitChecks = Symbol.for("sporades.database.transactionBeforeCommitChecks");
    const checks = (database.adapter as any)[beforeCommitChecks] ?? ((database.adapter as any)[beforeCommitChecks] = []);
    checks.push(() => {
      if (terminalError) throw terminalError;
      if (database.clock.now().getTime() >= deadline) throw resourceError("RESOURCE_DEADLINE_EXCEEDED");
    });
    const controller = new AbortController();
    const revoke = (error: any) => {
      terminalError ??= error;
      scopeActive = false; admission = false;
      controller.abort(); rejectOuterAbort(terminalError);
    };
    const assertLive = (requireAdmission = false) => {
      if (!invocationActive || !scopeActive || requireAdmission && !admission) throw resourceError("RESOURCE_SCOPE_INACTIVE");
      if (terminalError) throw terminalError;
      if (database.clock.now().getTime() >= deadline - (admission ? 1000 : 0)) throw resourceError("RESOURCE_DEADLINE_EXCEEDED");
    };
    watchdog ??= database.clock.setTimer(() => revoke(resourceError("RESOURCE_DEADLINE_EXCEEDED")), Math.max(0, deadline - database.clock.now().getTime()));
    let acquired = false;
    try {
      assertLive(true);
      // The surrounding mutation/endpoint starts deferred. Promote it to an
      // actual SQLite writer before reading authorization so Grant, ACL and Team
      // transitions cannot slip between the recheck and the outer commit.
      try {
        await database.adapter.exec("CREATE TABLE IF NOT EXISTS sporades_resource_outer_fence (id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL)");
        await database.adapter.prepare("INSERT OR IGNORE INTO sporades_resource_outer_fence (id, epoch) VALUES (1, 0)").run();
        await database.adapter.prepare("UPDATE sporades_resource_outer_fence SET epoch=epoch+1 WHERE id=1").run();
      } catch (error: any) {
        if (error?.errcode === 5 || error?.errcode === 6 || error?.code === "SQLITE_BUSY") throw resourceError("RESOURCE_BUSY");
        throw resourceError("RESOURCE_STORAGE_ERROR");
      }
      acquired = true;
      assertLive(true);
      await hooks.authorize(context, parentDb, identity);
      assertLive(true);
      let receipt: any;
      try {
        await database.adapter.exec("CREATE TABLE IF NOT EXISTS sporades_resource_receipts (resourceTable TEXT NOT NULL, resourceId TEXT NOT NULL, operationId TEXT NOT NULL, inputDigest TEXT NOT NULL, actorDigest TEXT NOT NULL, resultJson TEXT NOT NULL, intentIdsJson TEXT NOT NULL, committedAt TEXT NOT NULL, PRIMARY KEY (resourceTable, resourceId, operationId))");
        receipt = await database.adapter.prepare("SELECT * FROM sporades_resource_receipts WHERE resourceTable=? AND resourceId=? AND operationId=?").get(identity.table, identity.id, identity.operationId);
      } catch (error: any) {
        if (error?.code === "ERR_SQLITE_ERROR" || error?.errcode !== undefined) throw resourceError("RESOURCE_STORAGE_ERROR");
        throw error;
      }
      if (receipt) {
        if (receipt.actorDigest !== actorDigest || !status && receipt.inputDigest !== identity.digest) throw resourceError("RESOURCE_OPERATION_CONFLICT");
        return status ? { state: "committed", result: JSON.parse(receipt.resultJson), intentIds: JSON.parse(receipt.intentIdsJson) } : JSON.parse(receipt.resultJson);
      }
      if (status) return { state: "absent" };
      const scopeDb = wrapCapability(parentDb, () => assertLive(true), [], new WeakMap<object, any>(), track);
      const logs: string[] = [];
      const scope = Object.freeze({
        db: scopeDb,
        jobs: Object.freeze({ enqueue: (...args: any[]) => track(() => { assertLive(true); return parentJobs.enqueue(...args); }) }),
        log: Object.freeze(Object.fromEntries(["info", "warn", "error"].map((level) => [level, () => {
          assertLive(true); if (logs.length >= 100) throw resourceError("RESOURCE_INVALID_INPUT"); logs.push(level);
        }]))),
        signal: controller.signal,
        notifications: Object.freeze({ accept: () => {
          assertLive(true);
          return track(() => Promise.resolve().then(() => {
          terminalError ??= resourceError("RESOURCE_EFFECT_UNSUPPORTED");
          throw terminalError;
          }));
        } }),
      });
      let result: any;
      try { result = await Promise.race([Promise.resolve().then(() => callback(scope)), outerAborted]); }
      catch (error) { terminalError ??= error; throw error; }
      if (terminalError) throw terminalError;
      admission = false;
      let resultJson: string;
      try {
        resultJson = resourceCanonicalJson(result);
        await Promise.all([...pending]);
        if (terminalError) throw terminalError;
        await hooks.drain(context);
        await hooks.stageLogs?.(logs);
      } catch (error) { terminalError ??= error; throw error; }
      assertLive();
      try {
        await database.adapter.prepare("INSERT INTO sporades_resource_receipts VALUES (?,?,?,?,?,?,?,?)").run(identity.table, identity.id, identity.operationId, identity.digest, actorDigest, resultJson, "[]", database.clock.now().toISOString());
      } catch (error: any) {
        if (error?.code === "ERR_SQLITE_ERROR" || error?.errcode !== undefined) throw resourceError("RESOURCE_STORAGE_ERROR");
        throw error;
      }
      assertLive();
      return JSON.parse(resultJson);
    } catch (error) {
      const normalized = normalizeStorageError(error);
      // Pre-entry deadline and contract errors retain their existing catchable
      // outer semantics. Once SQLite work has begun, or setup itself failed as
      // storage, an unawaited execution must still poison settlement.
      if (acquired || normalized?.code === "RESOURCE_STORAGE_ERROR") terminalError ??= normalized;
      throw normalized;
    } finally {
      scopeActive = false; admission = false; controller.abort();
    }
  };
  context.resources = Object.freeze({ run: (options: any, callback: any) => trackExecution(() => execute(options, callback, false)), status: (options: any) => trackExecution(() => execute(options, undefined, true), false) });
  const release: any = () => { invocationActive = false; if (watchdog !== undefined) database.clock.clearTimer(watchdog); };
  release.assertOuterLive = () => {
    if (terminalError) throw terminalError;
    if (outerDeadline && database.clock.now().getTime() >= outerDeadline) throw resourceError("RESOURCE_DEADLINE_EXCEEDED");
  };
  release.aborted = () => outerAborted;
  release.drain = async () => {
    await Promise.allSettled([...executions]);
    if (terminalError) throw terminalError;
  };
  release.race = <Value>(operation: Promise<Value>) => Promise.race([operation, outerAborted]);
  release.guardCapability = guardCapability;
  return release;
}

// An invocation owns its eligibility in a closure; public context fields cannot
// forge a Job claim. Proxies preserve synchronous non-opt-in DB return values.
function wrapCapability(value: any, before: (path: string[]) => void, path: string[] = [], cache = new WeakMap<object, any>(), afterCall?: (operation: () => any) => any): any {
  if (!value || typeof value !== "object") return value;
  if (cache.has(value)) return cache.get(value);
  const functions = new Map<string, Function>();
  const proxy = new Proxy({}, {
    ownKeys: () => Reflect.ownKeys(value),
    set: (_target, key, member) => Reflect.set(value, key, member),
    has: (_target, key) => Reflect.has(value, key),
    getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
    get(_target, key) {
      const member = Reflect.get(value, key);
      if (typeof key !== "string") return member;
      if (typeof member === "function") {
        if (functions.has(key)) return functions.get(key);
        const wrapped = (...args: any[]) => {
        const next = [...path, key];
        before(next);
        const invoke = () => Reflect.apply(member, value, args);
        const result = afterCall && !["where", "orderBy", "limit"].includes(key) ? afterCall(invoke) : invoke();
        return ["where", "orderBy", "limit"].includes(key) ? wrapCapability(result, before, path, cache, afterCall) : result;
        };
        functions.set(key, wrapped);
        return wrapped;
      }
      return wrapCapability(member, before, [...path, key], cache, afterCall);
    },
  });
  cache.set(value, proxy);
  return proxy;
}

export function bindJobResources(database: RecordValue, context: RecordValue, claim: RecordValue, hooks: RecordValue) {
  let invocationActive = true;
  let used = false;
  let scopeRunning = false;
  let touched = false;
  const privileged = hooks.privileged === true;
  const actorBinding = resourceCanonicalJson({ auth: context.auth, credential: context.credential ?? null, privileged });
  const actorDigest = createHash("sha256").update(actorBinding).digest("hex");
  for (const name of ["db", "log", "files", "mail", "payments", "messages", "privileged", "jobs", "schedules", "teams", "teamBilling", "accessKeys", "serviceUsers", "serverAuth", "lifecycle"]) {
    if (!context[name]) continue;
    context[name] = wrapCapability(context[name], (path) => {
      if (used && (name !== "log" || scopeRunning || !invocationActive)) throw resourceError(!invocationActive ? "RESOURCE_SCOPE_INACTIVE" : ["db", "privileged", "jobs"].includes(name) ? "RESOURCE_CONTEXT_UNSUPPORTED" : "RESOURCE_EFFECT_UNSUPPORTED");
      if (name !== "log" && !["where", "orderBy", "limit"].includes(path.at(-1)!)) touched = true;
    });
  }

  const execute = async (options: any, callback: any, status: boolean) => {
    if (!invocationActive || used || touched) throw resourceError("RESOURCE_CONTEXT_UNSUPPORTED");
    if (!(["sqlite", "postgres"].includes(database.adapter.engine)) || (database.adapter.engine === "postgres" && database.adapter[Symbol.for("sporades.database.resourceTransactionEligible")] !== true) || typeof database.adapter.withResourceTransaction !== "function") throw resourceError("RESOURCE_ADAPTER_UNSUPPORTED");
    const identity = optionsSnapshot(options, status);
    if (!status && typeof callback !== "function") throw resourceError("RESOURCE_INVALID_INPUT");
    if (!database.schema.tables.some((table: any) => table.name === identity.table)) throw resourceError("RESOURCE_INVALID_INPUT");
    used = true;
    scopeRunning = true;
    let scopeContext: RecordValue | undefined;
    let engineCommitted = false;
    let active = true;
    let admission = true;
    let terminalError: any;
    const controller = new AbortController();
    const deadline = Date.parse(claim.leaseExpiresAt);
    const pending = new Set<Promise<any>>();
    const logs: string[] = [];
    let rejectAbort: (error: any) => void = () => {};
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    // Attach before any asynchronous acquisition to avoid an unhandled rejection.
    void aborted.catch(() => {});
    const revoke = (error: any) => {
      terminalError ??= error;
      active = false; admission = false;
      controller.abort(); rejectAbort(error);
    };
    const assertLive = (admit = false) => {
      if (!active || admit && !admission) throw resourceError("RESOURCE_SCOPE_INACTIVE");
      if (terminalError) throw terminalError;
      if (context.signal?.aborted || database.__jobStopped) throw resourceAbortError();
      if (database.clock.now().getTime() >= deadline - (admit ? 1000 : 0)) throw resourceError("RESOURCE_DEADLINE_EXCEEDED");
    };
    const abort = () => revoke(resourceAbortError());
    context.signal?.addEventListener("abort", abort, { once: true });
    const watchdog = database.clock.setTimer(() => revoke(resourceError("RESOURCE_DEADLINE_EXCEEDED")), Math.max(0, deadline - database.clock.now().getTime()));
    const checkClaim = async (adapter: RecordValue, entry = false) => {
      assertLive(entry);
      const row = await adapter.prepare(database.adapter.engine === "postgres"
        ? "SELECT status, \"claimToken\", \"leaseExpiresAt\", \"cancelRequestedAt\" FROM sporades_jobs WHERE id=? FOR UPDATE"
        : "SELECT status, claimToken, leaseExpiresAt, cancelRequestedAt FROM sporades_jobs WHERE id=?").get(claim.id);
      if (!row || row.status !== "running" || row.claimToken !== claim.claimToken || row.leaseExpiresAt !== claim.leaseExpiresAt) throw resourceError("RESOURCE_CLAIM_LOST");
      if (row.cancelRequestedAt) throw resourceAbortError();
      assertLive(entry);
    };
    const track = (operation: () => any) => {
      assertLive(true);
      const promise = Promise.resolve().then(() => { assertLive(); return operation(); });
      pending.add(promise);
      void promise.catch((error) => { terminalError ??= error; });
      return promise;
    };
    try {
      assertLive(true);
      const result = await database.adapter.withResourceTransaction(async (adapter: RecordValue) => {
        // Every subsequent SQL statement, including delayed ACL continuations,
        // checks revocation. No stale work can reconnect after watchdog rollback.
        const guarded = Object.create(adapter);
        guarded.prepare = (sql: string) => {
          assertLive();
          const statement = adapter.prepare(sql);
          return Object.fromEntries(["get", "all", "run", "columns"].map((method) => [method, (...args: any[]) => {
            assertLive(); return statement[method](...args);
          }]));
        };
        guarded.exec = (sql: string) => { assertLive(); return adapter.exec(sql); };
        await checkClaim(guarded, true);
        scopeContext = hooks.createContext(guarded, controller.signal, privileged);
        await Promise.race([hooks.authorize(scopeContext, identity), aborted]);
        assertLive(true);
        await guarded.exec("CREATE TABLE IF NOT EXISTS sporades_resource_receipts (resourceTable TEXT NOT NULL, resourceId TEXT NOT NULL, operationId TEXT NOT NULL, inputDigest TEXT NOT NULL, actorDigest TEXT NOT NULL, resultJson TEXT NOT NULL, intentIdsJson TEXT NOT NULL, committedAt TEXT NOT NULL, PRIMARY KEY (resourceTable, resourceId, operationId))");
        const receipt = await guarded.prepare("SELECT * FROM sporades_resource_receipts WHERE resourceTable=? AND resourceId=? AND operationId=?").get(identity.table, identity.id, identity.operationId);
        if (receipt) {
          if (receipt.actorDigest !== actorDigest || !status && receipt.inputDigest !== identity.digest) throw resourceError("RESOURCE_OPERATION_CONFLICT");
          await checkClaim(guarded);
          return status ? { state: "committed", result: JSON.parse(receipt.resultJson), intentIds: JSON.parse(receipt.intentIdsJson) } : JSON.parse(receipt.resultJson);
        }
        if (status) { await checkClaim(guarded); return { state: "absent" }; }
        const db = Object.fromEntries(Object.entries(scopeContext!.db).map(([name, table]) => {
          const wrapTable = (api: any): any => Object.fromEntries(Object.keys(api).map((method) => [method, (...args: any[]) => {
            assertLive(true);
            if (["where", "orderBy", "limit"].includes(method)) return wrapTable(api[method](...args));
            return track(() => api[method](...args));
          }]));
          return [name, wrapTable(table)];
        }));
        const rejectEffect = () => { assertLive(true); throw resourceError("RESOURCE_EFFECT_UNSUPPORTED"); };
        const scope = Object.freeze({
          db: Object.freeze(db), signal: controller.signal,
          jobs: Object.freeze({ enqueue: (...args: any[]) => track(() => scopeContext!.jobs.enqueue(...args)) }),
          log: Object.freeze(Object.fromEntries(["info", "warn", "error"].map((level) => [level, () => {
            assertLive(true); if (logs.length >= 100) throw resourceError("RESOURCE_INVALID_INPUT"); logs.push(level);
          }]))),
          notifications: Object.freeze({ accept: () => track(rejectEffect) }),
        });
        const value = await Promise.race([Promise.resolve().then(() => callback(scope)), aborted]);
        admission = false;
        await Promise.race([Promise.all([...pending]), aborted]);
        await Promise.race([hooks.drain(scopeContext), aborted]);
        const resultJson = resourceCanonicalJson(value);
        await hooks.stageLogs(scopeContext, logs);
        await checkClaim(guarded);
        await guarded.prepare("INSERT INTO sporades_resource_receipts VALUES (?,?,?,?,?,?,?,?)").run(identity.table, identity.id, identity.operationId, identity.digest, actorDigest, resultJson, "[]", database.clock.now().toISOString());
        await checkClaim(guarded);
        active = false;
        return JSON.parse(resultJson);
      }, database.adapter.engine === "postgres" ? async (adapter: RecordValue) => {
        if (context.signal?.aborted || database.__jobStopped) throw resourceAbortError();
        if (database.clock.now().getTime() >= deadline) throw resourceError("RESOURCE_DEADLINE_EXCEEDED");
        const row = await adapter.prepare("SELECT status, \"claimToken\", \"leaseExpiresAt\", \"cancelRequestedAt\" FROM sporades_jobs WHERE id=? FOR UPDATE").get(claim.id);
        if (!row || row.status !== "running" || row.claimToken !== claim.claimToken || row.leaseExpiresAt !== claim.leaseExpiresAt) throw resourceError("RESOURCE_CLAIM_LOST");
        if (row.cancelRequestedAt) throw resourceAbortError();
      } : (adapter: RecordValue) => {
        // SQLite statements and COMMIT are synchronous on this connection: this
        // final check and the commit decision have no JavaScript await gap.
        if (context.signal?.aborted || database.__jobStopped) throw resourceAbortError();
        if (database.clock.now().getTime() >= deadline) throw resourceError("RESOURCE_DEADLINE_EXCEEDED");
        const row = adapter.prepare("SELECT status, claimToken, leaseExpiresAt, cancelRequestedAt FROM sporades_jobs WHERE id=?").get(claim.id);
        if (!row || row.status !== "running" || row.claimToken !== claim.claimToken || row.leaseExpiresAt !== claim.leaseExpiresAt) throw resourceError("RESOURCE_CLAIM_LOST");
        if (row.cancelRequestedAt) throw resourceAbortError();
      }, { table: identity.table, id: identity.id });
      engineCommitted = true;
      active = false;
      await hooks.committed(scopeContext, logs);
      return result;
    } catch (error) {
      active = false;
      if (engineCommitted) throw resourceError("RESOURCE_STORAGE_ERROR");
      hooks.rolledBack(scopeContext);
      throw error;
    } finally {
      scopeRunning = false;
      active = false; admission = false; controller.abort();
      database.clock.clearTimer(watchdog);
      context.signal?.removeEventListener("abort", abort);
      hooks.release(scopeContext);
    }
  };
  context.resources = Object.freeze({
    run: (options: any, callback: any) => execute(options, callback, false),
    status: (options: any) => execute(options, undefined, true),
  });
  return () => { invocationActive = false; };
}
