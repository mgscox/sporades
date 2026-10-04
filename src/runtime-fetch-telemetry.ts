import { ROOT_CONTEXT, SpanKind, SpanStatusCode, TraceFlags, trace } from "@opentelemetry/api";
import type { Span, Tracer } from "@opentelemetry/api";
import { types as utilTypes } from "node:util";
import { runtimeRequestScope } from "./runtime-request-context.js";

type FetchCall = (original: typeof fetch, input: Parameters<typeof fetch>[0], init?: RequestInit) => ReturnType<typeof fetch>;
type FetchState = { original: typeof fetch; wrapper: typeof fetch; owners: Set<() => FetchCall | undefined> };
const fetchStateKey = Symbol.for("sporades.runtime.fetch-telemetry.v1");
const dictionaryFields = ["body", "cache", "credentials", "dispatcher", "duplex", "headers", "integrity", "keepalive", "method", "mode", "priority", "redirect", "referrer", "referrerPolicy", "signal", "window"];
const stringFields = ["cache", "credentials", "duplex", "integrity", "method", "mode", "priority", "redirect", "referrer", "referrerPolicy"];
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const nativeReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason")!.get!;
const nativeExceptionName = Object.getOwnPropertyDescriptor(DOMException.prototype, "name")!.get!;

function stableSignal(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== AbortSignal.prototype) return false;
  // Node's native signal getters read internal symbol properties. Do not evaluate
  // an accessor substituted for any of those properties, including during branding.
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) return false;
    // On supported Node versions, composite getters can refresh their state by
    // reading caller-owned source signals. Delegate AbortSignal.any unchanged.
    if (typeof key === "symbol" && key.description === "kComposite" && descriptor.value) return false;
  }
  try { nativeAborted.call(value); return true; } catch { return false; }
}

// Reading a WebIDL accessor ahead of fetch can change what fetch will do, including
// turning manual redirects into follow. Select ordinary data dictionaries only.
function stableDictionary(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object") return false;
  for (let current = value; current; current = Object.getPrototypeOf(current)) {
    if (utilTypes.isProxy(current)) return false;
    for (const field of dictionaryFields) {
      const descriptor = Object.getOwnPropertyDescriptor(current, field);
      if (descriptor && !("value" in descriptor)) return false;
    }
  }
  return true;
}

function stableHeaders(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || utilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Headers.prototype) return !Object.hasOwn(value, Symbol.iterator);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype || Object.hasOwn(value, Symbol.iterator)) return false;
    return Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => "value" in descriptor)
      && Array.prototype.every.call(value, (pair: unknown) => Array.isArray(pair) && !utilTypes.isProxy(pair) && Object.getPrototypeOf(pair) === Array.prototype
        && !Object.hasOwn(pair, Symbol.iterator) && Object.values(Object.getOwnPropertyDescriptors(pair)).every(descriptor => "value" in descriptor)
        && pair.length === 2 && Array.prototype.every.call(pair, (entry: unknown) => typeof entry === "string"));
  }
  if ((prototype !== Object.prototype && prototype !== null) || Object.hasOwn(value, Symbol.iterator)) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => "value" in descriptor && typeof descriptor.value === "string");
}

function stableBody(value: unknown): boolean {
  if (value === undefined || value === null || typeof value === "string") return true;
  if (typeof value !== "object" || utilTypes.isProxy(value)) return false;
  if (utilTypes.isArrayBuffer(value) || ArrayBuffer.isView(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return [Blob.prototype, FormData.prototype, URLSearchParams.prototype, ReadableStream.prototype].includes(prototype)
    && Object.getOwnPropertyNames(value).length === 0
    && ![Symbol.iterator, Symbol.toPrimitive].some(key => Object.hasOwn(value, key));
}

/** Shared across generated Bundles: dispatch to exactly one active request owner. */
export function installRuntimeFetchTelemetry(): () => void {
  const globals = globalThis as typeof globalThis & { [fetchStateKey]?: FetchState };
  let state = globals[fetchStateKey];
  if (!state) {
    const original = globalThis.fetch;
    state = { original, wrapper: original, owners: new Set() };
    const current = state;
    const invoke: typeof fetch = (input, init) => current.original.call(globalThis, input, init);
    state.wrapper = function (input, init) {
      for (const owner of current.owners) {
        const call = owner();
        if (call) return call(invoke, input, init);
      }
      return invoke(input, init);
    };
    globals[fetchStateKey] = state;
    globalThis.fetch = state.wrapper;
  }
  const owner = () => runtimeRequestScope.getStore()?.outboundFetch;
  state.owners.add(owner);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.owners.delete(owner);
    if (state.owners.size === 0) {
      if (globalThis.fetch === state.wrapper) globalThis.fetch = state.original;
      delete globals[fetchStateKey];
    }
  };
}

/** Native fetch latency ends at response headers; response body ownership stays with callers. */
export function outboundFetchTelemetry(tracer: Tracer, parent: Span, origins: ReadonlySet<string>, active: () => boolean): FetchCall {
  return async (original, input, init) => {
    if (!active()) return original(input, init);
    let url: URL;
    let request: Request | undefined;
    let method: string;
    let signal: AbortSignal | null | undefined;
    let redirect: string;
    try {
      if (utilTypes.isProxy(input) || !stableDictionary(init)) return original(input, init);
      if ((init as RequestInit & { dispatcher?: unknown } | undefined)?.dispatcher !== undefined) return original(input, init);
      if (init && (!stringFields.every(key => (init as Record<string, unknown>)[key] === undefined || (init as Record<string, unknown>)[key] === null || typeof (init as Record<string, unknown>)[key] === "string")
        || !stableHeaders(init.headers) || !stableBody(init.body))) return original(input, init);
      request = input instanceof Request ? input : undefined;
      if (request && (Object.getPrototypeOf(request) !== Request.prototype || Object.getOwnPropertyNames(request).length > 0)) return original(input, init);
      if (input instanceof URL && (Object.getPrototypeOf(input) !== URL.prototype || Object.getOwnPropertyNames(input).length > 0 || Object.hasOwn(input, Symbol.toPrimitive))) return original(input, init);
      if (!request && typeof input !== "string" && !(input instanceof URL)) return original(input, init);
      url = new URL(request ? request.url : String(input));
      if (!["http:", "https:"].includes(url.protocol)) return original(input, init);
      const rawMethod = init?.method === undefined ? request?.method ?? "GET" : String(init.method);
      method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE"].includes(rawMethod.toUpperCase()) ? rawMethod.toUpperCase() : "_OTHER";
      signal = init?.signal === undefined ? request?.signal : init.signal;
      if (!stableSignal(signal)) return original(input, init);
      redirect = init?.redirect ?? request?.redirect ?? "follow";
    } catch { return original(input, init); }
    const span = tracer.startSpan(`HTTP ${method}`, {
      kind: SpanKind.CLIENT, attributes: { "http.request.method": method },
    }, trace.setSpan(ROOT_CONTEXT, parent));
    let forwarded = init;
    // Following redirects can carry a custom traceparent across origins. Only propagate
    // when the caller already chose manual/error; never change its redirect semantics.
    if (origins.has(url.origin) && (redirect === "manual" || redirect === "error")) {
      const context = span.spanContext();
      if (/^[0-9a-f]{32}$/.test(context.traceId) && !/^0+$/.test(context.traceId) && /^[0-9a-f]{16}$/.test(context.spanId) && !/^0+$/.test(context.spanId)) {
        try {
          const headers = new Headers(init?.headers === undefined ? request?.headers : init.headers);
          headers.set("traceparent", `00-${context.traceId}-${context.spanId}-${context.traceFlags & TraceFlags.SAMPLED ? "01" : "00"}`);
          // RequestInit is a WebIDL dictionary: inherited fields and accessor receivers
          // matter. A spread can drop manual/error redirect mode and leak the carrier.
          // Use a fresh target so frozen caller properties impose no Proxy invariants.
          const options = init ?? {};
          forwarded = new Proxy({}, {
            get: (_target, key) => key === "headers" ? headers : Reflect.get(options, key, options),
            has: (_target, key) => key === "headers" || Reflect.has(options, key),
          });
        } catch { /* Invalid caller input must retain native fetch's rejection. */ }
      }
    }
    try {
      const response = await original(input, forwarded);
      span.setAttribute("http.response.status_code", response.status);
      span.setAttribute("sporades.http.outcome", response.status >= 400 ? "failure" : "success");
      if (response.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
      return response;
    } catch (error) {
      let outcome = "network_error";
      try {
        // Caller-owned signals can change while fetch is pending. Recheck their
        // descriptors before invoking any native getter at the rejection boundary.
        if (signal && stableSignal(signal) && nativeAborted.call(signal)) {
          outcome = "cancelled";
          const reason: unknown = nativeReason.call(signal);
          // DOMException's intrinsic getter validates its native brand and bypasses
          // a caller's own name getter. Other reasons remain opaque cancellation.
          if (typeof reason === "object" && reason !== null && !utilTypes.isProxy(reason)
            && nativeExceptionName.call(reason) === "TimeoutError") outcome = "timeout";
        }
      } catch { /* Invalid signals and caller-owned abort reasons are opaque. */ }
      span.setAttribute("sporades.http.outcome", outcome);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally { span.end(); }
  };
}
