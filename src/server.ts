export type FieldKind = "String" | "Boolean" | "Number" | "Date" | "Json" | "Reference";
export type UnknownRecord = Record<string, unknown>;
export type Handler<Args extends unknown[] = unknown[], Result = unknown> = (...args: Args) => Result | Promise<Result>;

export type CapsuleDefinition = UnknownRecord & {
  name: string;
};

export type Capsule<Definition extends CapsuleDefinition = CapsuleDefinition> = Definition & {
  kind: "capsule";
};

export type EndpointOptions = {
  method: string;
  path: string;
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

export type ScheduleDefinition = {
  expression: string;
  job: string;
  payload?: unknown | SchedulePayloadFactory;
  retry?: { maxAttempts: number; delayMs?: number };
  enabled?: boolean;
};

export type ScheduleOccurrence = Readonly<{ scheduleName: string; scheduledFor: string }>;
/**
 * Calculates ordinary Job input for one occurrence. Factories are for dynamic
 * data population, may run more than once during recovery, and should avoid
 * state mutation. Explicit Privileged side effects must tolerate repetition.
 * Timeout cancellation is cooperative and cannot undo completed side effects.
 */
export type SchedulePayloadFactory = (occurrence: ScheduleOccurrence, ctx: Readonly<{ signal: AbortSignal; privileged: unknown }>) => unknown | Promise<unknown>;

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
  acl(rules: unknown): TableDefinition<Fields>;
};

export type AuthContext = {
  userId: string;
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

export type RequireAuthContext = {
  auth: AuthContext;
  [key: string]: unknown;
};

type AuthDenialError = Error & {
  code?: string;
  hint?: string;
  sporadesAuthDenialLogData?: unknown;
};

export function requireAuth(context: RequireAuthContext, options: RequireAuthOptions = {}): AuthContext {
  const linked = options?.linked === true;
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

export function capsule<const Definition extends CapsuleDefinition>(definition: Definition): Capsule<Definition> {
  return {
    kind: "capsule",
    ...definition,
  };
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

/** Declare a named, server-only recurring Privileged Job in `capsule({ schedules })`. */
export function schedule<const Definition extends ScheduleDefinition>(definition: Definition): Definition & { kind: "schedule" } {
  return { kind: "schedule", ...definition };
}

export function table<const Fields extends UnknownRecord>(fields: Fields): TableDefinition<Fields> {
  return tableDefinition(fields);
}

function tableDefinition<const Fields extends UnknownRecord>(fields: Fields, aclRules?: unknown): TableDefinition<Fields> {
  return {
    kind: "table",
    fields,
    acl(rules: unknown) {
      return tableDefinition(fields, rules);
    },
    ...(aclRules === undefined ? {} : { aclRules }),
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
  return `export function requireAuth(context, options = {}) {
  const linked = options?.linked === true;
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

export function capsule(definition) {
  return {
    kind: "capsule",
    ...definition,
  };
}

export function endpoint(options, handler) {
  return {
    kind: "endpoint",
    options,
    handler,
  };
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

function tableDefinition(fields, aclRules) {
  return {
    kind: "table",
    fields,
    acl(rules) {
      return tableDefinition(fields, rules);
    },
    ...(aclRules === undefined ? {} : { aclRules }),
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
