import { commandError } from "./runtime-errors.js";

/** Shared startup/CLI validation for opt-in HTTP hardening. Never echo configured values. */
export function validateHttpHardening(security: Record<string, any> = {}) {
  const fail = (hint: string): never => {
    throw commandError("Invalid HTTP security configuration.", hint, "INVALID_SECURITY_CONFIG");
  };
  const csp = security.csp ?? {};
  if (csp.nonce !== undefined && typeof csp.nonce !== "boolean") {
    fail("Set security.csp.nonce to a boolean.");
  }
  if (csp.nonce === true) {
    for (const name of ["script-src", "script-src-elem"]) {
      const value = csp.directives?.[name];
      if (value !== undefined && typeof value !== "string" && !(Array.isArray(value) && value.every(item => typeof item === "string"))) {
        fail("Set CSP script directives to a string or an array of strings.");
      }
    }
  }
  if (csp.reportTo !== undefined) {
    const value = csp.reportTo;
    let valid = typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[^\x21-\x7e]|[;#\\]/.test(value);
    if (valid) {
      try {
        const url = new URL(value, "https://sporades.invalid");
        valid = (value.startsWith("/") && !value.startsWith("//") || value.startsWith("https://"))
          && url.protocol === "https:" && !url.username && !url.password;
      } catch { valid = false; }
    }
    if (!valid) fail("Set security.csp.reportTo to a same-origin absolute path or an HTTPS URL without credentials, fragments, whitespace or semicolons.");
  }
  const hsts = security.hsts;
  if (hsts !== undefined) {
    if (!hsts || typeof hsts !== "object" || Array.isArray(hsts)
      || !Number.isSafeInteger(hsts.maxAgeSeconds) || hsts.maxAgeSeconds < 0
      || hsts.includeSubDomains !== undefined && typeof hsts.includeSubDomains !== "boolean"
      || hsts.preload !== undefined && typeof hsts.preload !== "boolean") {
      fail("Set security.hsts to an object with a non-negative safe integer maxAgeSeconds and optional boolean includeSubDomains and preload.");
    }
  }
}

export function hstsHeader(hsts: Record<string, any>) {
  return `max-age=${hsts.maxAgeSeconds}${hsts.includeSubDomains ? "; includeSubDomains" : ""}${hsts.preload ? "; preload" : ""}`;
}
