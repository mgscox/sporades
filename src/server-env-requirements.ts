import { commandError } from "./runtime-errors.js";

/** Opt-in sporades.json Server env enforcement. Omission preserves 0.9.x behavior. */
export type ServerEnvConfig = Readonly<{ required?: readonly string[]; failClosed?: boolean }>;
type Config = Record<string, any>;

export function validateServerEnvConfig(value: unknown): ServerEnvConfig | undefined {
  if (value === undefined) return undefined;
  const fail = (): never => {
    throw commandError(
      "Invalid Server env requirements.",
      "Set `env.required` to at most 64 Server env key names (1-128 characters, no reserved SPORADES_ prefix) and optional `env.failClosed` to a boolean.",
      "INVALID_SERVER_ENV_CONFIG",
    );
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const entries = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "required" && key !== "failClosed") return fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return fail();
    entries.set(key, descriptor.value);
  }
  const required = entries.get("required");
  const failClosed = entries.get("failClosed");
  if (entries.has("required") && (!Array.isArray(required) || required.length > 64)) fail();
  const keys: string[] = [];
  if (Array.isArray(required)) {
    for (let index = 0; index < required.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(required, String(index));
      const key = descriptor?.value;
      if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof key !== "string"
        || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || key === "__proto__" || key.startsWith("SPORADES_")) fail();
      keys.push(key);
    }
  }
  if (entries.has("failClosed") && typeof failClosed !== "boolean") fail();
  return { required: [...new Set(keys)].sort(), failClosed: failClosed === true };
}

/** Call with validated mail/payment config. Never resolve values from process.env. */
export function requiredServerEnvKeys(config: Config): string[] {
  const env = validateServerEnvConfig(config.env);
  const keys = new Set<string>(env?.required ?? []);
  const auth = config.mail?.smtp?.auth;
  if (auth && auth.method !== "none") {
    if (auth.usernameEnv) keys.add(auth.usernameEnv);
    if (auth.passwordEnv) keys.add(auth.passwordEnv);
  }
  for (const webhook of Object.values(config.mail?.webhooks ?? {}) as Config[]) {
    if (webhook?.enabled && webhook.secretEnv) keys.add(webhook.secretEnv);
  }
  const stripe = config.payments?.stripe;
  if (stripe?.enabled === true) {
    keys.add(stripe.secretKeyEnv);
    keys.add(stripe.webhookSecretEnv);
  }
  for (const service of Object.values(config.services ?? {}) as Config[]) {
    if (service?.kind !== "container") continue;
    for (const value of Object.values(service.env ?? {}) as any[]) {
      if (value && typeof value === "object" && typeof value.sealed === "string") keys.add(value.sealed);
    }
  }
  return [...keys].sort();
}

export function missingServerEnvKeys(config: Config, values: Record<string, unknown>): string[] {
  return requiredServerEnvKeys(config).filter(key => {
    const value = Object.getOwnPropertyDescriptor(values, key)?.value;
    return typeof value !== "string" || value.trim().length === 0;
  });
}

export function missingServerEnvError(keys: readonly string[]) {
  return commandError(
    `Missing required Server env keys: ${keys.join(", ")}`,
    "Set the named keys with `sporades env set <name> --stdin`, then retry. Host push may explicitly bypass this check with `--allow-missing-env`; runtime env.failClosed still applies.",
    "MISSING_REQUIRED_SERVER_ENV",
  );
}
