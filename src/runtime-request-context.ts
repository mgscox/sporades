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
  return runtimeRequestScope.exit(callback);
}
