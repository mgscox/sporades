import { AsyncLocalStorage } from "node:async_hooks";
export const runtimeRequestScope = new AsyncLocalStorage();
/** Internal runtime boundary: no request/exporter means the original callback alone runs. */
export function traceRuntimeOperation(operation, callback, outcome) {
    const run = runtimeRequestScope.getStore()?.operation;
    return run ? run(operation, callback, outcome) : callback();
}
/** Runtime-owned work must not retain the HTTP request which happened to schedule it. */
export function withoutRuntimeRequestIdentity(callback) {
    return runtimeRequestScope.exit(callback);
}
//# sourceMappingURL=runtime-request-context.js.map