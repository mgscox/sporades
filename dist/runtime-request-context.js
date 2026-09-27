import { AsyncLocalStorage } from "node:async_hooks";
/** Internal HTTP identity scope shared by instrumentation and runtime scheduling. */
export const runtimeRequestScope = new AsyncLocalStorage();
/** Runtime-owned work must not retain the HTTP request which happened to schedule it. */
export function withoutRuntimeRequestIdentity(callback) {
    return runtimeRequestScope.exit(callback);
}
//# sourceMappingURL=runtime-request-context.js.map