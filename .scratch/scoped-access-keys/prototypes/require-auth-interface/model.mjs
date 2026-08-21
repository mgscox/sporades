// PROTOTYPE — pure interface-behaviour model, not production authentication.

export const scenarios = [
  {
    name: "Unguarded endpoint receives an Access-key header",
    wrapper: null,
    presented: { kind: "access-key", valid: true, grants: ["requests:read"] },
    userCheck: null,
  },
  {
    name: "Wrapper admits any valid credential",
    wrapper: {},
    presented: { kind: "session", valid: true, linked: true },
    userCheck: null,
  },
  {
    name: "Wrapper admits a matching Access key",
    wrapper: { credentials: ["access-key"], scopes: ["requests:read"] },
    presented: { kind: "access-key", valid: true, linked: true, name: "chaser-bot", grants: ["requests:*"] },
    userCheck: null,
  },
  {
    name: "Wrapper rejects a missing Access-key scope",
    wrapper: { credentials: ["access-key"], scopes: ["requests:write"] },
    presented: { kind: "access-key", valid: true, linked: true, name: "report-reader", grants: ["requests:read"] },
    userCheck: null,
  },
  {
    name: "requireUserAuth linked check follows wrapper admission",
    wrapper: { scopes: ["requests:read"] },
    presented: { kind: "access-key", valid: true, linked: true, name: "chaser-bot", grants: ["requests:read"] },
    userCheck: { linked: true },
  },
  {
    name: "Access-key-only wrapper rejects a Session",
    wrapper: { credentials: ["access-key"] },
    presented: { kind: "session", valid: true, linked: true },
    userCheck: null,
  },
];

function wildcardMatches(pattern, scope) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(scope);
}

function satisfies(requirements, credential) {
  const credentials = requirements.credentials ?? ["session", "access-key"];
  if (!credentials.includes(credential.kind)) return { ok: false, reason: "credential-kind" };
  if (requirements.linked === true && credential.linked !== true) return { ok: false, reason: "linked-user" };
  if (credential.kind === "access-key") {
    const grants = credential.grants ?? [];
    const missing = (requirements.scopes ?? []).filter(
      (scope) => !grants.some((grant) => wildcardMatches(grant, scope)),
    );
    if (missing.length > 0) return { ok: false, reason: "scope", missing };
  }
  return { ok: true };
}

export function evaluate(scenario) {
  if (!scenario.wrapper) {
    return {
      accessKeyActivated: false,
      phases: [
        "route selected with no declarative guard",
        "Authorization header remains Capsule-owned and uninterpreted by Sporades",
        "existing Session/Anonymous context enters Capsule middleware",
        "handler runs without Access-key authority",
      ],
      outcome: { kind: "existing-handler-behaviour" },
      context: { credential: "session-or-anonymous" },
    };
  }

  const credential = scenario.presented;
  const wrapper = credential.valid ? satisfies(scenario.wrapper, credential) : { ok: false, reason: "invalid-credential" };
  if (!wrapper.ok) {
    return {
      accessKeyActivated: credential.kind === "access-key",
      phases: ["route selected with declarative guard", "credential admission rejected", "middleware and handler not run"],
      outcome: {
        kind: "pre-handler-denial",
        code: wrapper.reason === "invalid-credential" ? "UNAUTHENTICATED" : "FORBIDDEN",
        ...wrapper,
      },
      context: null,
    };
  }

  const context = {
    auth: "owning-user",
    credential: credential.kind === "access-key"
      ? { kind: "access-key", name: credential.name, grants: credential.grants }
      : { kind: "session" },
  };
  const phases = [
    "route selected with declarative guard",
    "credential admitted and context snapshotted",
    "Capsule middleware sees admitted auth and Credential provenance",
  ];
  if (scenario.userCheck) {
    const userCheck = scenario.userCheck.linked !== true || credential.linked === true
      ? { ok: true }
      : { ok: false, reason: "linked-user" };
    phases.push(userCheck.ok ? "requireUserAuth check passes" : "requireUserAuth check rejects during handler");
    return {
      accessKeyActivated: credential.kind === "access-key",
      phases,
      outcome: userCheck.ok
        ? { kind: "handler-result" }
        : { kind: "user-auth-denial", code: "UNAUTHENTICATED", ...userCheck },
      context,
    };
  }
  phases.push("handler runs");
  return {
    accessKeyActivated: credential.kind === "access-key",
    phases,
    outcome: { kind: "handler-result" },
    context,
  };
}
