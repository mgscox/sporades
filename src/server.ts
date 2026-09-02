export type FieldKind = "String" | "Boolean" | "Number" | "Date" | "Json" | "Reference";
export type UnknownRecord = Record<string, unknown>;
export type Handler<Args extends unknown[] = unknown[], Result = unknown> = (...args: Args) => Result | Promise<Result>;

const atomicStripeEventDefinitionBrand = Symbol.for("sporades.stripeEvent.atomicDefinition");

export type CapsuleDefinition = UnknownRecord & {
  name: string;
  accessKeys?: { scopes: readonly string[] };
};

export type Capsule<Definition extends CapsuleDefinition = CapsuleDefinition> = Definition & {
  kind: "capsule";
};

export type EndpointOptions = {
  method: string;
  path: string;
  /** Explicitly delegates exact-version attachment authorization to this trusted endpoint handler. */
  response?: { fileAttachment: true };
  /** Runtime-owned bounded multipart ingress for a trusted Custom endpoint. */
  body?: { multipart: {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalFileBytes: number;
    maxFieldCount: number;
    maxFieldBytes: number;
    maxTotalFieldBytes: number;
    allowedMimeTypes?: readonly string[];
    allowedPathPrefixes: readonly string[];
    requestKeyHeader: string;
    partKeyHeader: string;
    requireStablePartKeys?: boolean;
    claimAuthorities?: readonly ["actor" | "capsule-principal"];
  } };
};

export type EndpointDefinition<HandlerType extends Handler = Handler> = {
  kind: "endpoint";
  options: EndpointOptions;
  handler: HandlerType;
};

export type HandlerDefinition<Kind extends "query" | "mutation" | "message", HandlerType extends Handler = Handler> = {
  kind: Kind;
  handler: HandlerType;
};

export type JobDefinition<HandlerType extends Handler = Handler> = {
  kind: "job";
  handler: HandlerType;
};

export type EmailEventDefinition<HandlerType extends Handler = Handler> = {
  kind: "emailEvent";
  handler: HandlerType;
};

export type StripeEventDefinition<HandlerType extends Handler = Handler> = {
  kind: "stripeEvent";
  options?: undefined;
  handler: HandlerType;
};

export type AtomicStripeEventDefinition<HandlerType extends Handler = Handler> = {
  kind: "stripeEvent";
  options: Readonly<{ consequence: "atomic" }>;
  handler: HandlerType;
};

/**
 * A server-only recurring Job declaration using numeric five-field cron.
 * Payloads must be JSON-safe; retry is the ordinary Job Queue retry policy.
 */
type ScheduleJsonValue = null | boolean | number | string | ScheduleJsonValue[] | { [key: string]: ScheduleJsonValue };
export type ScheduleDefinition = {
  expression: string;
  timezone?: string;
  job: string;
  retry?: { maxAttempts: number; delayMs?: number };
  missedRun?: "skip" | "latest";
  enabled?: boolean;
} & (
  | { payload?: ScheduleJsonValue; payloadVersion?: never }
  | {
    payload: SchedulePayloadFactory;
    /** Stable identity for the factory source and every captured/configured input. Change it when any of those inputs change. */
    payloadVersion?: string;
  }
);

export type ScheduleOccurrence = Readonly<{ scheduleName: string; scheduledFor: string }>;
/**
 * Calculates ordinary Job input for one occurrence. Factories are for dynamic
 * data population, may run more than once during recovery, and should avoid
 * state mutation. Explicit Privileged side effects must tolerate repetition.
 * Timeout cancellation is cooperative and cannot undo completed side effects.
 */
export type SchedulePayloadFactory = (occurrence: ScheduleOccurrence, ctx: Readonly<{ signal: AbortSignal; privileged: unknown }>) => ScheduleJsonValue | Promise<ScheduleJsonValue>;

export type FieldDefinition<Value = unknown> = {
  kind: FieldKind;
  defaultValue?: Value;
};

export type FieldBuilder<Value = unknown> = {
  kind: FieldKind;
  default(defaultValue: Value): FieldDefinition<Value>;
};

export type ReferenceFieldBuilder = {
  kind: "Reference";
  targetTable: string;
  default(defaultValue: string | null): FieldDefinition<string | null> & { kind: "Reference"; targetTable: string };
};

export type TableDefinition<Fields extends UnknownRecord = UnknownRecord> = {
  kind: "table";
  fields: Fields;
  aclRules?: unknown;
  uniqueConstraints?: readonly (readonly string[])[];
  acl(rules: unknown): TableDefinition<Fields>;
  unique(...fields: [keyof Fields & string, ...(keyof Fields & string)[]]): TableDefinition<Fields>;
};

export type CapsuleTableDefinition<Fields extends UnknownRecord> = Omit<TableDefinition<Fields>, "acl" | "unique"> & {
  acl(rules: unknown): CapsuleTableDefinition<Fields>;
  unique(...fields: [keyof Fields & string, ...(keyof Fields & string)[]]): CapsuleTableDefinition<Fields>;
};

export type AuthContext = {
  userId: string;
  /** Present only for non-human Service Users; absence preserves the legacy human/Anonymous shape. */
  userKind?: "service";
  displayName: string;
  email: string | null;
  picture: string | null;
  isAuthenticated: boolean;
  isGuest: boolean;
  provider: string;
};

export type RequireAuthOptions = {
  linked?: boolean;
};

export type CredentialKind = "session" | "access-key";
export type SessionCredentialProvenance = Readonly<{ kind: "session" }>;
export type AccessKeyCredentialProvenance = Readonly<{ kind: "access-key"; id: string; name: string }>;
export type CredentialProvenance = SessionCredentialProvenance | AccessKeyCredentialProvenance;
export type DeclarativeRequireAuthOptions = {
  linked?: boolean;
  credentials?: readonly CredentialKind[];
  scopes?: readonly string[];
  reauthentication?: string;
};

export type RequireAuthContext = {
  auth: AuthContext;
  [key: string]: unknown;
};

type AuthDenialError = Error & {
  code?: string;
  hint?: string;
  sporadesAuthDenialLogData?: unknown;
};

export function requireUserAuth(context: RequireAuthContext, options: RequireAuthOptions = {}): AuthContext {
  const linked = normalizeRequireUserAuthOptions(options).linked;
  const auth = context?.auth;
  if (auth?.isAuthenticated === true && (!linked || auth.isGuest !== true)) {
    return auth;
  }
  const error: AuthDenialError = new Error("Unauthenticated.");
  error.hint = "Sign in and retry the request.";
  error.code = "UNAUTHENTICATED";
  error.sporadesAuthDenialLogData = {
    requirement: linked ? "linked" : "authenticated",
    handler: {
      kind: (context as Record<string, unknown>)?.kind ?? null,
    },
    actor: {
      userId: auth?.userId ?? null,
      provider: auth?.provider ?? null,
      isAuthenticated: auth?.isAuthenticated ?? null,
      isGuest: auth?.isGuest ?? null,
    },
  };
  throw error;
}

/** @deprecated Use requireUserAuth for the synchronous inline Session check. */
export function requireAuth(context: RequireAuthContext, options?: RequireAuthOptions): AuthContext;
export function requireAuth<HandlerType extends Handler>(handler: HandlerType): HandlerType;
export function requireAuth<HandlerType extends Handler>(options: DeclarativeRequireAuthOptions, handler: HandlerType): HandlerType;
export function requireAuth(first: RequireAuthContext | Handler | UnknownRecord, second?: RequireAuthOptions | Handler): AuthContext | Handler {
  if (typeof first === "function") {
    return decorateRequireAuth({}, first) as Handler;
  }
  if (typeof second === "function") {
    return decorateRequireAuth(first, second) as Handler;
  }
  return requireUserAuth(first as RequireAuthContext, second as RequireAuthOptions | undefined);
}

export function capsule<const Definition extends CapsuleDefinition>(definition: Definition): Capsule<Definition> {
  const normalized = normalizeCapsuleAuthDefinition(definition);
  validateCapsuleAuthRequirements(normalized);
  validateEndpointResponseDeclarations(normalized);
  return {
    kind: "capsule",
    ...normalized,
  };
}

function validateEndpointResponseDeclarations(definition: UnknownRecord) {
  for (const endpointDefinition of Object.values((definition.endpoints as UnknownRecord | undefined) ?? {})) {
    const response = (endpointDefinition as any)?.options?.response;
    if (response === undefined) continue;
    if (!response || typeof response !== "object" || Array.isArray(response) || Object.keys(response).length !== 1 || response.fileAttachment !== true) {
      const error: any = new Error("Invalid endpoint response declaration.");
      error.code = "INVALID_ENDPOINT_RESPONSE_DECLARATION";
      throw error;
    }
  }
}

export function endpoint<const HandlerType extends Handler>(
  options: EndpointOptions,
  handler: HandlerType,
): EndpointDefinition<HandlerType> {
  return {
    kind: "endpoint",
    options,
    handler,
  };
}

/** Declare the single provider-neutral email-event subscription for a Capsule. */
export function emailEvent<const HandlerType extends Handler>(handler: HandlerType): EmailEventDefinition<HandlerType> {
  return { kind: "emailEvent", handler };
}

/** Declare the single verified Stripe-event subscription for a Capsule. A declared Team Billing platform consequence commits before this compatible legacy handler runs. */
export function stripeEvent<const HandlerType extends Handler>(handler: HandlerType): StripeEventDefinition<HandlerType>;
/** Share one runtime-serialized transaction with any declared Team Billing platform consequence for the verified Event. */
export function stripeEvent<const HandlerType extends Handler>(options: { consequence: "atomic" }, handler: HandlerType): AtomicStripeEventDefinition<HandlerType>;
export function stripeEvent<const HandlerType extends Handler>(first: HandlerType | { consequence: "atomic" }, second?: HandlerType): StripeEventDefinition<HandlerType> | AtomicStripeEventDefinition<HandlerType> {
  if (typeof first === "function" && second === undefined) return { kind: "stripeEvent", handler: first };
  if (first !== null && typeof first === "object" && !Array.isArray(first) && Object.keys(first).length === 1 && first.consequence === "atomic" && typeof second === "function") {
    const definition = { kind: "stripeEvent" as const, options: Object.freeze({ consequence: "atomic" as const }), handler: second };
    Object.defineProperty(definition, atomicStripeEventDefinitionBrand, { value: true });
    return Object.freeze(definition);
  }
  const error = new Error("Invalid Stripe-event declaration.");
  Object.assign(error, { code: "INVALID_STRIPE_EVENT_DECLARATION" });
  throw error;
}

export function query<const HandlerType extends Handler>(handler: HandlerType): HandlerDefinition<"query", HandlerType> {
  return {
    kind: "query",
    handler,
  };
}

export function mutation<const HandlerType extends Handler>(
  handler: HandlerType,
): HandlerDefinition<"mutation", HandlerType> {
  return {
    kind: "mutation",
    handler,
  };
}

export function message<const HandlerType extends Handler>(
  handler: HandlerType,
): HandlerDefinition<"message", HandlerType> {
  return {
    kind: "message",
    handler,
  };
}

/** Declare a named, server-only durable Job handler in `capsule({ jobs })`. */
export function job<const HandlerType extends Handler>(handler: HandlerType): JobDefinition<HandlerType> {
  return { kind: "job", handler };
}

/**
 * Declare a named, server-only recurring Privileged Job in
 * `capsule({ schedules })`. The map key is its durable identity. Expressions use
 * numeric five-field cron; `missedRun` defaults to `skip` and `latest` catches
 * up at most one occurrence. Dynamic payload factories may supply a stable
 * `payloadVersion` that changes with their code or captured configuration;
 * omission preserves the weaker v0.8.5 source-text identity.
 * Scheduled Jobs retain Job Queue at-least-once attempt semantics.
 */
export function schedule<const Definition extends ScheduleDefinition>(definition: Definition): Definition & { kind: "schedule" } {
  return { kind: "schedule", ...definition };
}

export function table<const Fields extends UnknownRecord>(fields: Fields): CapsuleTableDefinition<Fields> {
  return tableDefinition(fields);
}

function tableDefinition<const Fields extends UnknownRecord>(fields: Fields, aclRules?: unknown, uniqueConstraints: readonly (readonly (keyof Fields & string)[])[] = []): CapsuleTableDefinition<Fields> {
  return {
    kind: "table",
    fields,
    acl(rules: unknown) {
      return tableDefinition(fields, rules, uniqueConstraints);
    },
    unique(...fieldNames: readonly (keyof Fields & string)[]) {
      return tableDefinition(fields, aclRules, [...uniqueConstraints, fieldNames]);
    },
    ...(aclRules === undefined ? {} : { aclRules }),
    ...(uniqueConstraints.length === 0 ? {} : { uniqueConstraints }),
  };
}

export function String() {
  return field("String");
}

export function Boolean() {
  return field("Boolean");
}

export function Number() {
  return field("Number");
}

export function Date() {
  return field("Date");
}

export function Json() {
  return field("Json");
}

export function Reference(targetTable: string): ReferenceFieldBuilder {
  return {
    kind: "Reference",
    targetTable,
    default(defaultValue: string | null) {
      return {
        kind: "Reference",
        targetTable,
        defaultValue,
      };
    },
  };
}

function field<Value = unknown>(kind: FieldKind): FieldBuilder<Value> {
  return {
    kind,
    default(defaultValue: Value) {
      return {
        kind,
        defaultValue,
      };
    },
  };
}

export function serverRuntimeModuleSource() {
  return `const AUTH_REQUIREMENTS = Symbol.for("sporades.auth.requirements");
const ATOMIC_STRIPE_EVENT_DEFINITION = Symbol.for("sporades.stripeEvent.atomicDefinition");

function authRequirementsError(hint) {
  const error = new Error("Invalid Auth requirements.");
  error.hint = hint;
  error.code = "INVALID_AUTH_REQUIREMENTS";
  return error;
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeUserAuthOptions(options = {}) {
  if (!plainObject(options) || Object.keys(options).some((key) => key !== "linked") || ("linked" in options && typeof options.linked !== "boolean")) {
    throw authRequirementsError("Use only an optional boolean linked requirement for an inline user check.");
  }
  return Object.freeze({ linked: options.linked === true });
}

function normalizeGuardOptions(options = {}) {
  if (!plainObject(options) || Object.keys(options).some((key) => !["linked", "credentials", "scopes", "reauthentication"].includes(key))) {
    throw authRequirementsError("Use only linked, credentials, scopes, and reauthentication in a declarative Auth requirement.");
  }
  if ("linked" in options && typeof options.linked !== "boolean") throw authRequirementsError("linked must be a boolean when supplied.");
  const credentials = options.credentials === undefined ? ["session", "access-key"] : options.credentials;
  if (!Array.isArray(credentials) || credentials.length === 0 || credentials.some((kind) => kind !== "session" && kind !== "access-key") || new Set(credentials).size !== credentials.length) {
    throw authRequirementsError("credentials must be a non-empty unique array of session and access-key.");
  }
  const scopes = options.scopes === undefined ? [] : options.scopes;
  if (!Array.isArray(scopes) || (options.scopes !== undefined && scopes.length === 0) || scopes.length > 1024 || scopes.some((scope) => typeof scope !== "string" || scope.length === 0 || scope.includes("*") || new TextEncoder().encode(scope).byteLength > 256) || new Set(scopes).size !== scopes.length) {
    throw authRequirementsError("Required scopes must be unique concrete strings declared by the Capsule.");
  }
  const reauthentication = options.reauthentication;
  if (reauthentication !== undefined && (typeof reauthentication !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(reauthentication))) throw authRequirementsError("reauthentication must be a declared concrete purpose.");
  return Object.freeze({ linked: options.linked === true, credentials: Object.freeze([...credentials]), scopes: Object.freeze([...scopes]), reauthentication: reauthentication ?? null });
}

function decorateAuth(options, handler) {
  if (typeof handler !== "function") throw authRequirementsError("Pass a handler, or an Auth requirements object followed by a handler.");
  if (handler[AUTH_REQUIREMENTS]) throw authRequirementsError("Declare exactly one requireAuth wrapper around a handler.");
  const wrapped = function (...args) { return handler.apply(this, args); };
  Object.defineProperty(wrapped, AUTH_REQUIREMENTS, { value: normalizeGuardOptions(options) });
  return wrapped;
}

export function requireUserAuth(context, options = {}) {
  const linked = normalizeUserAuthOptions(options).linked;
  const auth = context?.auth;
  if (auth?.isAuthenticated === true && (!linked || auth.isGuest !== true)) {
    return auth;
  }
  const error = new Error("Unauthenticated.");
  error.hint = "Sign in and retry the request.";
  error.code = "UNAUTHENTICATED";
  error.sporadesAuthDenialLogData = {
    requirement: linked ? "linked" : "authenticated",
    handler: {
      kind: context?.kind ?? null,
    },
    actor: {
      userId: auth?.userId ?? null,
      provider: auth?.provider ?? null,
      isAuthenticated: auth?.isAuthenticated ?? null,
      isGuest: auth?.isGuest ?? null,
    },
  };
  throw error;
}

export function requireAuth(first, second) {
  if (typeof first === "function") return decorateAuth({}, first);
  if (typeof second === "function") return decorateAuth(first, second);
  return requireUserAuth(first, second);
}

export function capsule(definition) {
  let normalized = definition;
  if (definition.accessKeys !== undefined) {
    const accessKeys = definition.accessKeys;
    if (!plainObject(accessKeys) || Object.keys(accessKeys).some((key) => key !== "scopes") || !("scopes" in accessKeys)) {
      const error = new Error("Invalid Capsule Access-key declaration.");
      error.code = "INVALID_ACCESS_KEY_DECLARATION";
      throw error;
    }
    const scopes = accessKeys.scopes;
    if (!Array.isArray(scopes) || scopes.length > 1024 || scopes.some((scope) => typeof scope !== "string" || scope.length === 0 || scope.includes("*") || new TextEncoder().encode(scope).byteLength > 256) || new Set(scopes).size !== scopes.length) {
      const error = new Error("Invalid Access-key scope declaration.");
      error.code = "INVALID_ACCESS_KEY_SCOPE";
      throw error;
    }
    normalized = { ...definition, accessKeys: Object.freeze({ scopes: Object.freeze([...scopes]) }) };
  }
  if (normalized.files?.accessKeys !== undefined) {
    const policy = normalized.files.accessKeys;
    if (!plainObject(policy) || Object.keys(policy).some((key) => key !== "read") || !("read" in policy)) {
      const error = new Error("Invalid private File Access-key policy.");
      error.code = "INVALID_FILE_ACCESS_KEY_POLICY";
      throw error;
    }
    const read = policy.read;
    if (!plainObject(read) || Object.keys(read).some((key) => key !== "scopes")) {
      const error = new Error("Invalid private File Access-key read policy.");
      error.code = "INVALID_FILE_ACCESS_KEY_POLICY";
      throw error;
    }
    const scopes = read.scopes ?? [];
    const malformedScopes = read.scopes !== undefined && (
      !Array.isArray(scopes) || scopes.length === 0 || scopes.length > 1024 ||
      scopes.some((scope) => typeof scope !== "string" || scope.length === 0 || scope.includes("*") || new TextEncoder().encode(scope).byteLength > 256) ||
      new Set(scopes).size !== scopes.length
    );
    const declaredScopes = new Set(normalized.accessKeys?.scopes ?? []);
    if (malformedScopes || scopes.some((scope) => !declaredScopes.has(scope))) {
      const error = new Error("Invalid private File Access-key read policy.");
      error.code = "INVALID_FILE_ACCESS_KEY_POLICY";
      throw error;
    }
    normalized = {
      ...normalized,
      files: {
        ...normalized.files,
        accessKeys: Object.freeze({
          read: Object.freeze(read.scopes === undefined ? {} : { scopes: Object.freeze([...scopes]) }),
        }),
      },
    };
  }
  const declaredScopes = new Set(normalized.accessKeys?.scopes ?? []);
  for (const collection of [normalized.queries, normalized.mutations, normalized.endpoints, normalized.messages]) {
    for (const item of Object.values(collection ?? {})) {
      for (const scope of item?.handler?.[AUTH_REQUIREMENTS]?.scopes ?? []) {
        if (!declaredScopes.has(scope)) throw authRequirementsError("Every required scope must be declared in capsule({ accessKeys: { scopes } }).");
      }
    }
  }
  return {
    kind: "capsule",
    ...normalized,
  };
}

export function endpoint(options, handler) {
  return {
    kind: "endpoint",
    options,
    handler,
  };
}

export function emailEvent(handler) {
  return {
    kind: "emailEvent",
    handler,
  };
}

export function stripeEvent(first, second) {
  if (typeof first === "function" && second === undefined) return { kind: "stripeEvent", handler: first };
  if (plainObject(first) && Object.keys(first).length === 1 && first.consequence === "atomic" && typeof second === "function") {
    const definition = { kind: "stripeEvent", options: Object.freeze({ consequence: "atomic" }), handler: second };
    Object.defineProperty(definition, ATOMIC_STRIPE_EVENT_DEFINITION, { value: true });
    return Object.freeze(definition);
  }
  const error = new Error("Invalid Stripe-event declaration.");
  error.code = "INVALID_STRIPE_EVENT_DECLARATION";
  throw error;
}

export function query(handler) {
  return {
    kind: "query",
    handler,
  };
}

export function mutation(handler) {
  return {
    kind: "mutation",
    handler,
  };
}

export function message(handler) {
  return {
    kind: "message",
    handler,
  };
}

export function job(handler) {
  return {
    kind: "job",
    handler,
  };
}

export function schedule(definition) {
  return { kind: "schedule", ...definition };
}

export function table(fields) {
  return tableDefinition(fields);
}

function tableDefinition(fields, aclRules, uniqueConstraints = []) {
  return {
    kind: "table",
    fields,
    acl(rules) {
      return tableDefinition(fields, rules, uniqueConstraints);
    },
    unique(...fieldNames) {
      return tableDefinition(fields, aclRules, [...uniqueConstraints, fieldNames]);
    },
    ...(aclRules === undefined ? {} : { aclRules }),
    ...(uniqueConstraints.length === 0 ? {} : { uniqueConstraints }),
  };
}

export function String() {
  return field("String");
}

export function Boolean() {
  return field("Boolean");
}

export function Number() {
  return field("Number");
}

export function Date() {
  return field("Date");
}

export function Json() {
  return field("Json");
}

export function Reference(targetTable) {
  return {
    kind: "Reference",
    targetTable,
    default(defaultValue) {
      return {
        kind: "Reference",
        targetTable,
        defaultValue,
      };
    },
  };
}

function field(kind) {
  return {
    kind,
    default(defaultValue) {
      return {
        kind,
        defaultValue,
      };
    },
  };
}
`;
}
import {
  decorateRequireAuth,
  normalizeCapsuleAuthDefinition,
  normalizeRequireUserAuthOptions,
  validateCapsuleAuthRequirements,
} from "./auth-admission.js";
