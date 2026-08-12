export function invalidMailConfig(message: string, hint: string): never {
  const error: Error & { code?: string; hint?: string } = new Error(message);
  error.code = "INVALID_MAIL_CONFIG";
  error.hint = hint;
  throw error;
}

export function captureMailConfigData(
  value: unknown,
  allowed: string[],
  message: string,
  hint: string,
): Map<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidMailConfig(message, hint);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidMailConfig(message, hint);
  const entries: [string, any][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalidMailConfig(message, hint);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      invalidMailConfig(message, hint);
    }
    if (!allowed.includes(key)) invalidMailConfig(message, hint);
    entries.push([key, descriptor.value]);
  }
  return new Map(entries);
}

export function isServerEnvReference(value: unknown) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value) && !value.startsWith("SPORADES_");
}
