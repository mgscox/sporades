import { AsyncLocalStorage } from "node:async_hooks";
import type { Span, Tracer } from "@opentelemetry/api";

/** Internal HTTP identity scope shared by instrumentation and runtime scheduling. */
export type RuntimeOperation =
  | "sporades.auth.session.resolve" | "sporades.auth.access_key.resolve" | "sporades.auth.admit"
  | "sporades.file.authorize" | "sporades.file.upload.prepare" | "sporades.file.upload"
  | "sporades.file.private_url" | "sporades.file.public_url.create" | "sporades.file.public_url.revoke"
  | "sporades.file.delete" | "sporades.file.read" | "sporades.file.bytes.write"
  | "sporades.file.bytes.delete" | "sporades.file.stream" | "sporades.file.ingress.stage";
export type RuntimeOperationOutcome = "success" | "denied" | "error" | "cancelled";
export type RuntimeOperationRunner = <T>(operation: RuntimeOperation, callback: () => T, outcome?: (result: Awaited<T>) => RuntimeOperationOutcome) => T;

export const runtimeRequestScope = new AsyncLocalStorage<{ requestId: string; span?: Span; operation?: RuntimeOperationRunner; tracer?: Tracer; isOpen?: () => boolean }>();

/** Internal runtime boundary: no request/exporter means the original callback alone runs. */
export function traceRuntimeOperation<T>(operation: RuntimeOperation, callback: () => T, outcome?: (result: Awaited<T>) => RuntimeOperationOutcome): T {
  const run = runtimeRequestScope.getStore()?.operation;
  return run ? run(operation, callback, outcome) : callback();
}

/** Runtime-owned work must not retain the HTTP request which happened to schedule it. */
export function withoutRuntimeRequestIdentity<T>(callback: () => T): T {
  return runtimeRequestScope.exit(() => runtimeJobScope.exit(callback));
}

/** Attempt context is separate from HTTP identity; Job logs never inherit a request. */
export const runtimeJobScope = new AsyncLocalStorage<{ span: Span; isOpen: () => boolean }>();

/** Persist only W3C v00 IDs and one sampling bit, never tracestate or baggage. */
export function captureJobTraceContext(): string | null {
  try {
    const job = runtimeJobScope.getStore();
    const request = runtimeRequestScope.getStore();
    const span = job?.isOpen() ? job.span : request?.isOpen?.() ? request.span : undefined;
    const context = span?.spanContext();
    if (!context || !/^[0-9a-f]{32}$/.test(context.traceId) || /^0+$/.test(context.traceId)
      || !/^[0-9a-f]{16}$/.test(context.spanId) || /^0+$/.test(context.spanId)) return null;
    return `00-${context.traceId}-${context.spanId}-${context.traceFlags & 1 ? "01" : "00"}`;
  } catch { return null; }
}
