/** Self-contained so the public helper and generated Capsule helper use identical validation. */
export function endpointError(headers) {
    const invalid = () => new Error("Invalid endpoint error headers.");
    if (!headers || typeof headers !== "object" || Array.isArray(headers)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(headers)))
        throw invalid();
    const result = {};
    let size = 0;
    for (const key of Reflect.ownKeys(headers)) {
        if (typeof key !== "string")
            throw invalid();
        const name = key.toLowerCase();
        if (!["cache-control", "pragma", "x-robots-tag", "content-security-policy", "referrer-policy"].includes(name) || Object.hasOwn(result, name))
            throw invalid();
        const property = Object.getOwnPropertyDescriptor(headers, key);
        const value = property?.value;
        // ASCII only, with a total 8 KiB budget; never invoke accessors or coerce values.
        if (!property || !Object.hasOwn(property, "value") || typeof value !== "string" || !value.trim() || /[^\x20-\x7e]/.test(value))
            throw invalid();
        size += name.length + value.length;
        if (size > 8192)
            throw invalid();
        result[name] = value;
    }
    const error = new Error("Endpoint handler failed.");
    Object.defineProperty(error, Symbol.for("sporades.endpoint.errorHeaders"), { value: Object.freeze(result) });
    return error;
}
/** Revalidate the public helper's snapshot at the response boundary, including forged errors. */
export function endpointErrorResponseHeaders(error) {
    try {
        const descriptor = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, Symbol.for("sporades.endpoint.errorHeaders")) : undefined;
        if (!descriptor || !Object.hasOwn(descriptor, "value"))
            return {};
        const checked = endpointError(descriptor.value);
        return checked[Symbol.for("sporades.endpoint.errorHeaders")];
    }
    catch {
        return {};
    }
}
//# sourceMappingURL=endpoint-error.js.map