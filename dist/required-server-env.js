import { validateMailConfig } from "./mail-config.js";
import { validatePaymentsConfig } from "./stripe-payment-config.js";
/** Validate names before using them in operator diagnostics. Never echo invalid input. */
export function validateRequiredServerEnvConfig(env) {
    if (env === undefined)
        return;
    if (!env || typeof env !== "object" || Array.isArray(env)
        || Object.keys(env).some((key) => key !== "required" && key !== "failClosed")
        || ("failClosed" in env && typeof env.failClosed !== "boolean")
        || ("required" in env && (!Array.isArray(env.required) || env.required.length > 64
            || !env.required.every((key) => typeof key === "string"
                && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && key !== "__proto__" && !key.startsWith("SPORADES_"))))) {
        throw Object.assign(new Error("Invalid required Server env configuration."), {
            code: "INVALID_ENV_CONFIG",
            hint: "Set env.required to at most 64 Server env key names and env.failClosed to a boolean; SPORADES_ names are reserved.",
        });
    }
}
export function requiredServerEnvKeys(config) {
    validateRequiredServerEnvConfig(config.env);
    const keys = new Set(config.env?.required ?? []);
    const mail = validateMailConfig(config.mail);
    if (mail?.smtp?.auth.method !== "none") {
        for (const key of [mail?.smtp?.auth.usernameEnv, mail?.smtp?.auth.passwordEnv])
            if (key)
                keys.add(key);
    }
    for (const webhook of Object.values(mail?.webhooks ?? {})) {
        if (webhook.enabled)
            keys.add(webhook.secretEnv);
    }
    const payments = validatePaymentsConfig(config.payments);
    if (payments?.stripe.enabled) {
        keys.add(payments.stripe.secretKeyEnv);
        keys.add(payments.stripe.webhookSecretEnv);
    }
    return [...keys].sort();
}
export function missingRequiredServerEnv(config, values) {
    return requiredServerEnvKeys(config).filter((key) => !Object.hasOwn(values, key)
        || typeof values[key] !== "string" || !values[key].trim());
}
//# sourceMappingURL=required-server-env.js.map