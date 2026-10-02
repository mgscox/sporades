import { AsyncLocalStorage } from "node:async_hooks";
import type { Span, Tracer } from "@opentelemetry/api";

/** Internal HTTP identity scope shared by instrumentation and runtime scheduling. */
export const runtimeRequestScope = new AsyncLocalStorage<{ requestId: string; span?: Span; tracer?: Tracer; isOpen?: () => boolean }>();

/** Runtime-owned work must not retain the HTTP request which happened to schedule it. */
export function withoutRuntimeRequestIdentity<T>(callback: () => T): T {
  return runtimeRequestScope.exit(callback);
}
