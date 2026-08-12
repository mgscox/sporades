export function invalidMailConfig(message, hint) {
    const error = new Error(message);
    error.code = "INVALID_MAIL_CONFIG";
    error.hint = hint;
    throw error;
}
export function captureMailConfigData(value, allowed, message, hint) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        invalidMailConfig(message, hint);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        invalidMailConfig(message, hint);
    const entries = [];
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string")
            invalidMailConfig(message, hint);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
            invalidMailConfig(message, hint);
        }
        if (!allowed.includes(key))
            invalidMailConfig(message, hint);
        entries.push([key, descriptor.value]);
    }
    return new Map(entries);
}
export function isServerEnvReference(value) {
    return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value) && !value.startsWith("SPORADES_");
}
//# sourceMappingURL=mail-config-validation.js.map