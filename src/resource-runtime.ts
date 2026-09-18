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

// An invocation owns its eligibility in a closure; public context fields cannot
// forge a Job claim. Proxies preserve synchronous non-opt-in DB return values.
function wrapCapability(value: any, before: (path: string[]) => void, path: string[] = [], cache = new WeakMap<object, any>()): any {
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
        const result = Reflect.apply(member, value, args);
        return ["where", "orderBy", "limit"].includes(key) ? wrapCapability(result, before, path, cache) : result;
        };
        functions.set(key, wrapped);
        return wrapped;
      }
      return wrapCapability(member, before, [...path, key], cache);
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
    if (database.adapter.engine !== "sqlite" || typeof database.adapter.withResourceTransaction !== "function") throw resourceError("RESOURCE_ADAPTER_UNSUPPORTED");
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
      const row = await adapter.prepare("SELECT status, claimToken, leaseExpiresAt, cancelRequestedAt FROM sporades_jobs WHERE id=?").get(claim.id);
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
      }, (adapter: RecordValue) => {
        // SQLite statements and COMMIT are synchronous on this connection: this
        // final check and the commit decision have no JavaScript await gap.
        if (context.signal?.aborted || database.__jobStopped) throw resourceAbortError();
        if (database.clock.now().getTime() >= deadline) throw resourceError("RESOURCE_DEADLINE_EXCEEDED");
        const row = adapter.prepare("SELECT status, claimToken, leaseExpiresAt, cancelRequestedAt FROM sporades_jobs WHERE id=?").get(claim.id);
        if (!row || row.status !== "running" || row.claimToken !== claim.claimToken || row.leaseExpiresAt !== claim.leaseExpiresAt) throw resourceError("RESOURCE_CLAIM_LOST");
        if (row.cancelRequestedAt) throw resourceAbortError();
      });
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
