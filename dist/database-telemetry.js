import { AsyncLocalStorage } from "node:async_hooks";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { runtimeRequestScope } from "./runtime-request-context.js";
// Internal only: an adapter contributes engine identity and declared table names, never
// parameters, results, connection options or exception details to this boundary.
export const databaseTelemetry = Symbol("sporades.database.telemetry");
const operationScope = new AsyncLocalStorage();
const instrumentedOperations = new WeakSet();
export function withDatabaseSpan(engine, operation, table, run) {
    const request = runtimeRequestScope.getStore();
    if (!request?.tracer || !request.span || !request.isOpen?.() || !request.span.isRecording())
        return run();
    const owner = operationScope.getStore();
    const parent = owner?.requestId === request.requestId ? owner.span : request.span;
    let span;
    try {
        span = request.tracer.startSpan(`db.${operation}`, {
            kind: SpanKind.CLIENT,
            attributes: { "db.system.name": engine, "db.operation.name": operation, ...(table ? { "db.collection.name": table } : {}) },
        }, trace.setSpan(ROOT_CONTEXT, parent));
    }
    catch {
        return run();
    }
    const end = (failed) => {
        try {
            span.setAttribute("sporades.db.outcome", failed ? "error" : "success");
            if (failed)
                span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
        }
        catch { /* Telemetry cannot replace a database result or failure. */ }
    };
    try {
        const result = operationScope.run({ requestId: request.requestId, span }, run);
        if (result && typeof result.then === "function") {
            return Promise.resolve(result).then(value => { end(false); return value; }, error => { end(true); throw error; });
        }
        end(false);
        return result;
    }
    catch (error) {
        end(true);
        throw error;
    }
}
export function createDatabaseTelemetry(engine) {
    const tables = new Set();
    const metadata = (sql) => {
        // Label extraction is deliberately conservative. Unknown/complex statements still
        // measure time; no SQL fragment can become a label without the declaration allowlist.
        if (typeof sql !== "string" || sql.length > 8192)
            return { operation: "OTHER", table: "__other" };
        const operation = /^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|BEGIN|COMMIT|ROLLBACK|PRAGMA)\b/i.exec(sql)?.[1].toUpperCase() ?? "OTHER";
        const match = /\b(?:FROM|INTO|UPDATE|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?)\s+(?:"([a-zA-Z_][a-zA-Z0-9_]{0,63})"|\[([a-zA-Z_][a-zA-Z0-9_]{0,63})\]|([a-zA-Z_][a-zA-Z0-9_]{0,63})\b)/i.exec(sql);
        const name = match?.[1] ?? match?.[2] ?? match?.[3];
        return { operation, table: name && tables.has(name) ? name : name?.startsWith("sporades_") || name === "sporades" ? "__runtime" : "__other" };
    };
    return {
        registerTables(schema) {
            for (const table of schema?.tables ?? []) {
                if (tables.size >= 128)
                    break;
                if (typeof table?.name === "string" && /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(table.name))
                    tables.add(table.name);
            }
        },
        operations(operations) {
            if (instrumentedOperations.has(operations))
                return operations;
            const exec = operations.exec;
            const prepare = operations.prepare;
            const wrapped = {
                exec(sql) {
                    const { operation, table } = metadata(sql);
                    return withDatabaseSpan(engine, operation, table, () => Reflect.apply(exec, operations, [sql]));
                },
                prepare(sql) {
                    let statement;
                    try {
                        statement = Reflect.apply(prepare, operations, [sql]);
                    }
                    catch (error) {
                        const { operation, table } = metadata(sql);
                        return withDatabaseSpan(engine, operation, table, () => { throw error; });
                    }
                    const wrappedStatement = Object.create(statement);
                    for (const method of ["all", "get", "run", "columns"]) {
                        if (typeof statement[method] !== "function")
                            continue;
                        wrappedStatement[method] = (...params) => {
                            const { operation, table } = metadata(sql);
                            return withDatabaseSpan(engine, operation, table, () => Reflect.apply(statement[method], statement, params));
                        };
                    }
                    return wrappedStatement;
                },
            };
            instrumentedOperations.add(wrapped);
            return wrapped;
        },
    };
}
//# sourceMappingURL=database-telemetry.js.map