import { AsyncLocalStorage } from "node:async_hooks";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import { runtimeRequestScope } from "./runtime-request-context.js";

// Internal only: an adapter contributes engine identity and declared table names, never
// parameters, results, connection options or exception details to this boundary.
export const databaseTelemetry = Symbol("sporades.database.telemetry");
type Engine = "sqlite" | "postgres" | "libsql";
const operationScope = new AsyncLocalStorage<{ requestId: string; span: Span }>();
const instrumentedPrimitives = new WeakSet<Function>();

export function withDatabaseSpan<T>(engine: Engine, operation: string, table: string | undefined, run: () => T): T {
  const request = runtimeRequestScope.getStore();
  if (!request?.tracer || !request.span || !request.isOpen?.() || !request.span.isRecording()) return run();
  const owner = operationScope.getStore();
  const parent = owner?.requestId === request.requestId ? owner.span : request.span;
  let span: Span;
  try {
    span = request.tracer.startSpan(`db.${operation}`, {
      kind: SpanKind.CLIENT,
      attributes: { "db.system.name": engine, "db.operation.name": operation, ...(table ? { "db.collection.name": table } : {}) },
    }, trace.setSpan(ROOT_CONTEXT, parent));
  } catch { return run(); }
  const end = (failed: boolean) => {
    try {
      span.setAttribute("sporades.db.outcome", failed ? "error" : "success");
      if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    } catch { /* Telemetry cannot replace a database result or failure. */ }
  };
  try {
    const result = operationScope.run({ requestId: request.requestId, span }, run);
    if (result && typeof (result as any).then === "function") {
      return Promise.resolve(result).then(value => { end(false); return value; }, error => { end(true); throw error; }) as T;
    }
    end(false);
    return result;
  } catch (error) { end(true); throw error; }
}

export function createDatabaseTelemetry(engine: Engine) {
  const tables = new Set<string>();
  const metadata = (sql: unknown) => {
    // Label extraction is deliberately conservative. Unknown/complex statements still
    // measure time; no SQL fragment can become a label without the declaration allowlist.
    if (typeof sql !== "string" || sql.length > 8192) return { operation: "OTHER", table: "__other" };
    const operation = /^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|BEGIN|COMMIT|ROLLBACK|PRAGMA)\b/i.exec(sql)?.[1].toUpperCase() ?? "OTHER";
    const match = /\b(?:FROM|INTO|UPDATE|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?)\s+(?:"([a-zA-Z_][a-zA-Z0-9_]{0,63})"|\[([a-zA-Z_][a-zA-Z0-9_]{0,63})\]|([a-zA-Z_][a-zA-Z0-9_]{0,63})\b)/i.exec(sql);
    const name = match?.[1] ?? match?.[2] ?? match?.[3];
    return { operation, table: name && tables.has(name) ? name : name?.startsWith("sporades_") || name === "sporades" ? "__runtime" : "__other" };
  };
  return {
    registerTables(schema: any) {
      for (const table of schema?.tables ?? []) {
        if (tables.size >= 128) break;
        if (typeof table?.name === "string" && /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(table.name)) tables.add(table.name);
      }
    },
    operations(operations: Record<string, any>) {
      // Transaction sessions may copy their operation object. Function identity
      // survives that copy, so an executed statement still gets exactly one span.
      if (instrumentedPrimitives.has(operations.exec) && instrumentedPrimitives.has(operations.prepare)) return operations;
      const exec = operations.exec;
      const prepare = operations.prepare;
      const wrapped = {
        exec(sql: any) {
          const { operation, table } = metadata(sql);
          return withDatabaseSpan(engine, operation, table, () => Reflect.apply(exec, operations, [sql]));
        },
        prepare(sql: any) {
          let statement: any;
          try { statement = Reflect.apply(prepare, operations, [sql]); }
          catch (error) {
            const { operation, table } = metadata(sql);
            return withDatabaseSpan(engine, operation, table, () => { throw error; });
          }
          const wrappedStatement = Object.create(statement);
          for (const method of ["all", "get", "run", "columns"]) {
            if (typeof statement[method] !== "function") continue;
            wrappedStatement[method] = (...params: any[]) => {
              const { operation, table } = metadata(sql);
              return withDatabaseSpan(engine, operation, table, () => Reflect.apply(statement[method], statement, params));
            };
          }
          return wrappedStatement;
        },
      };
      instrumentedPrimitives.add(wrapped.exec);
      instrumentedPrimitives.add(wrapped.prepare);
      return wrapped;
    },
  };
}
