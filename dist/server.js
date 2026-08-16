export function requireAuth(context, options = {}) {
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
/** Declare the single provider-neutral email-event subscription for a Capsule. */
export function emailEvent(handler) {
    return { kind: "emailEvent", handler };
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
/** Declare a named, server-only durable Job handler in `capsule({ jobs })`. */
export function job(handler) {
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

export function emailEvent(handler) {
  return {
    kind: "emailEvent",
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
//# sourceMappingURL=server.js.map