import { commandError } from "./runtime-errors.js";

type LooseRecord = Record<string, any>;

export const AUTH_REQUIREMENTS = Symbol.for("sporades.auth.requirements");
export const ACCESS_KEY_SCOPE_LIMIT = 1024;
export const ACCESS_KEY_SCOPE_BYTE_LIMIT = 256;

export type CredentialKind = "session" | "access-key";
export type AuthRequirements = Readonly<{
  linked: boolean;
  credentials: readonly CredentialKind[];
  scopes: readonly string[];
  reauthentication: string | null;
}>;

export function invalidAuthRequirements(hint: string) {
  return commandError("Invalid Auth requirements.", hint, "INVALID_AUTH_REQUIREMENTS");
}

export function normalizeRequireUserAuthOptions(options: unknown = {}) {
  if (!isPlainObject(options) || Object.keys(options).some((key) => key !== "linked") || ("linked" in options && typeof options.linked !== "boolean")) {
    throw invalidAuthRequirements("Use only an optional boolean linked requirement for an inline user check.");
  }
  return Object.freeze({ linked: options.linked === true });
}

export function decorateRequireAuth(options: unknown, handler: unknown) {
  if (typeof handler !== "function") {
    throw invalidAuthRequirements("Pass a handler, or an Auth requirements object followed by a handler.");
  }
  if (readAuthRequirements(handler)) {
    throw invalidAuthRequirements("Declare exactly one requireAuth wrapper around a handler.");
  }
  const requirements = normalizeAuthRequirements(options);
  const wrapped = function (this: unknown, ...args: unknown[]) {
    return handler.apply(this, args);
  };
  Object.defineProperty(wrapped, AUTH_REQUIREMENTS, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: requirements,
  });
  return wrapped;
}

export function readAuthRequirements(handler: unknown): AuthRequirements | null {
  return typeof handler === "function" ? (handler as any)[AUTH_REQUIREMENTS] ?? null : null;
}

export function normalizeAuthRequirements(options: unknown = {}): AuthRequirements {
  if (!isPlainObject(options) || Object.keys(options).some((key) => !["linked", "credentials", "scopes", "reauthentication"].includes(key))) {
    throw invalidAuthRequirements("Use only linked, credentials, scopes, and reauthentication in a declarative Auth requirement.");
  }
  if ("linked" in options && typeof options.linked !== "boolean") {
    throw invalidAuthRequirements("linked must be a boolean when supplied.");
  }
  const credentials = normalizeCredentialKinds(options.credentials);
  const scopes = normalizeConcreteScopes(options.scopes, {
    allowOmission: true,
    code: "INVALID_AUTH_REQUIREMENTS",
    hint: "Required scopes must be unique concrete strings declared by the Capsule.",
  });
  const reauthentication = options.reauthentication;
  if (reauthentication !== undefined && (typeof reauthentication !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(reauthentication))) throw invalidAuthRequirements("reauthentication must be a declared concrete purpose.");
  return Object.freeze({
    linked: options.linked === true,
    credentials: Object.freeze(credentials),
    scopes: Object.freeze(scopes),
    reauthentication: reauthentication ?? null,
  });
}

export function normalizeCapsuleAuthDefinition<Definition extends LooseRecord>(definition: Definition): Definition {
  let normalized: LooseRecord = definition;
  if (("accessKeys" in definition) && definition.accessKeys !== undefined) {
    const accessKeys = definition.accessKeys;
    if (!isPlainObject(accessKeys) || Object.keys(accessKeys).some((key) => key !== "scopes") || !("scopes" in accessKeys)) {
      throw commandError(
        "Invalid Capsule Access-key declaration.",
        "Declare accessKeys as { scopes: readonly string[] } with no additional fields.",
        "INVALID_ACCESS_KEY_DECLARATION",
      );
    }
    const scopes = normalizeConcreteScopes(accessKeys.scopes, {
      allowOmission: false,
      code: "INVALID_ACCESS_KEY_SCOPE",
      hint: "Declare up to 1,024 unique concrete scope strings of at most 256 UTF-8 bytes.",
    });
    normalized = {
      ...definition,
      accessKeys: Object.freeze({ scopes: Object.freeze(scopes) }),
    };
  }
  if (Object.hasOwn(normalized, "auth") && normalized.auth !== undefined) {
    const registration = normalized.auth?.registration;
    const reauthentication = normalized.auth?.reauthentication;
    if (!isPlainObject(normalized.auth) || Object.keys(normalized.auth).some((key) => !["registration", "reauthentication"].includes(key)) || (registration !== undefined && (!isPlainObject(registration)
      || typeof registration.admit !== "function" || typeof registration.finalize !== "function"
      || Object.keys(registration).some((key) => key !== "admit" && key !== "finalize")))) {
      throw commandError("Invalid Capsule Registration Admission declaration.", "Declare auth.registration with both admit and finalize server functions.", "INVALID_REGISTRATION_ADMISSION");
    }
    if (reauthentication !== undefined && (!isPlainObject(reauthentication) || Object.keys(reauthentication).some((key) => !["purposes", "authorize"].includes(key)) || (reauthentication.authorize !== undefined && typeof reauthentication.authorize !== "function") || !isPlainObject(reauthentication.purposes) || Object.keys(reauthentication.purposes).length < 1 || Object.entries(reauthentication.purposes).some(([purpose, policy]: [string, any]) => !/^[a-z][a-z0-9-]{0,63}$/.test(purpose) || !isPlainObject(policy) || Object.keys(policy).some((key) => key !== "maxAgeSeconds") || !Number.isInteger(policy.maxAgeSeconds) || policy.maxAgeSeconds < 1 || policy.maxAgeSeconds > 900))) throw commandError("Invalid Reauthentication declaration.", "Declare concrete purposes with maxAgeSeconds from 1 through 900 and an optional authorize callback.", "INVALID_REAUTHENTICATION_DECLARATION");
    normalized = { ...normalized, auth: Object.freeze({ ...(registration ? { registration: Object.freeze(registration) } : {}), ...(reauthentication ? { reauthentication: Object.freeze({ purposes: Object.freeze(Object.fromEntries(Object.entries(reauthentication.purposes).map(([purpose, policy]: [string, any]) => [purpose, Object.freeze({ maxAgeSeconds: policy.maxAgeSeconds })]))), ...(reauthentication.authorize ? { authorize: reauthentication.authorize } : {}) }) } : {}) }) };
  }
  const declaredPurposes = new Set(Object.keys(normalized.auth?.reauthentication?.purposes ?? {}));
  for (const item of Object.values(normalized.mutations ?? {}) as any[]) { const purpose = readAuthRequirements(item?.handler)?.reauthentication; if (purpose && !declaredPurposes.has(purpose)) throw invalidAuthRequirements("Every reauthentication purpose must be declared by the Capsule."); }
  return normalizeFileAccessKeyPolicy(normalized) as Definition;
}

function normalizeFileAccessKeyPolicy<Definition extends LooseRecord>(definition: Definition): Definition {
  if (definition.files?.accessKeys === undefined) return definition;
  const policy = definition.files.accessKeys;
  if (!isPlainObject(policy) || Object.keys(policy).some((key) => key !== "read") || !("read" in policy)) {
    throw commandError(
      "Invalid private File Access-key policy.",
      "Declare files.accessKeys as { read: { scopes?: readonly string[] } }.",
      "INVALID_FILE_ACCESS_KEY_POLICY",
    );
  }
  const read = policy.read;
  if (!isPlainObject(read) || Object.keys(read).some((key) => key !== "scopes")) {
    throw commandError(
      "Invalid private File Access-key read policy.",
      "Declare files.accessKeys.read as { scopes?: readonly string[] }.",
      "INVALID_FILE_ACCESS_KEY_POLICY",
    );
  }
  const scopes = normalizeConcreteScopes(read.scopes, {
    allowOmission: true,
    code: "INVALID_FILE_ACCESS_KEY_POLICY",
    hint: "File read scopes must be omitted or be a non-empty list of unique concrete Capsule scopes.",
  });
  const declaredScopes = new Set<string>(definition.accessKeys?.scopes ?? []);
  if (scopes.some((scope) => !declaredScopes.has(scope))) {
    throw commandError(
      "Invalid private File Access-key read policy.",
      "Every File read scope must be declared in capsule({ accessKeys: { scopes } }).",
      "INVALID_FILE_ACCESS_KEY_POLICY",
    );
  }
  return {
    ...definition,
    files: {
      ...definition.files,
      accessKeys: Object.freeze({
        read: Object.freeze(read.scopes === undefined ? {} : { scopes: Object.freeze(scopes) }),
      }),
    },
  };
}

export function validateCapsuleAuthRequirements(definition: LooseRecord) {
  const declaredScopes = new Set<string>(definition.accessKeys?.scopes ?? []);
  for (const [kind, collection] of [["query", definition.queries], ["mutation", definition.mutations], ["endpoint", definition.endpoints], ["message", definition.messages]] as const) {
    for (const item of Object.values(collection ?? {}) as LooseRecord[]) {
      const requirements = readAuthRequirements(item?.handler);
      if (!requirements) {
        continue;
      }
      if (requirements.reauthentication && kind !== "mutation") {
        throw invalidAuthRequirements("Reauthentication proofs may only guard mutations.");
      }
      for (const scope of requirements.scopes) {
        if (!declaredScopes.has(scope)) {
          throw invalidAuthRequirements("Every required scope must be declared in capsule({ accessKeys: { scopes } }).");
        }
      }
    }
  }
  return definition;
}

export function scopeGrantMatches(grant: string, requiredScope: string) {
  const parts = grant.split("*");
  if (parts.length === 1) return grant === requiredScope;
  let offset = grant.startsWith("*") ? 0 : parts[0].length;
  if (!grant.startsWith("*") && !requiredScope.startsWith(parts[0])) return false;
  const suffix = grant.endsWith("*") ? "" : parts.at(-1) ?? "";
  const limit = requiredScope.length - suffix.length;
  if (limit < offset || (suffix && !requiredScope.endsWith(suffix))) return false;
  const firstInterior = grant.startsWith("*") ? 0 : 1;
  const lastInterior = grant.endsWith("*") ? parts.length : parts.length - 1;
  for (const part of parts.slice(firstInterior, lastInterior)) {
    if (!part) continue;
    const foundAt = requiredScope.indexOf(part, offset);
    if (foundAt === -1 || foundAt + part.length > limit) return false;
    offset = foundAt + part.length;
  }
  return true;
}

export function accessKeyGrantsSatisfyScopes(grants: readonly string[], requiredScopes: readonly string[]) {
  return requiredScopes.every((requiredScope) => grants.some((grant) => scopeGrantMatches(grant, requiredScope)));
}

function normalizeCredentialKinds(value: unknown): CredentialKind[] {
  if (value === undefined) {
    return ["session", "access-key"];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidAuthRequirements("credentials must be a non-empty array when supplied.");
  }
  const result: CredentialKind[] = [];
  for (const credential of value) {
    if (credential !== "session" && credential !== "access-key") {
      throw invalidAuthRequirements("credentials may contain only session and access-key.");
    }
    if (result.includes(credential)) {
      throw invalidAuthRequirements("credentials must not contain duplicates.");
    }
    result.push(credential);
  }
  return result;
}

function normalizeConcreteScopes(
  value: unknown,
  options: { allowOmission: boolean; code: "INVALID_AUTH_REQUIREMENTS" | "INVALID_ACCESS_KEY_SCOPE" | "INVALID_FILE_ACCESS_KEY_POLICY"; hint: string },
) {
  if (value === undefined && options.allowOmission) {
    return [];
  }
  if (!Array.isArray(value) || (options.allowOmission && value.length === 0) || value.length > ACCESS_KEY_SCOPE_LIMIT) {
    throw commandError("Invalid Access-key scope declaration.", options.hint, options.code);
  }
  const scopes: string[] = [];
  for (const scope of value) {
    if (typeof scope !== "string" || scope.length === 0 || scope.includes("*") || Buffer.byteLength(scope, "utf8") > ACCESS_KEY_SCOPE_BYTE_LIMIT || scopes.includes(scope)) {
      throw commandError("Invalid Access-key scope declaration.", options.hint, options.code);
    }
    scopes.push(scope);
  }
  return scopes;
}

function isPlainObject(value: unknown): value is LooseRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
