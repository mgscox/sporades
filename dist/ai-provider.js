// Provider-neutral AI boundary. Only adapter modules know a provider's wire format; the runtime
// core, Capsule context and public types use these shapes exclusively.
export function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
export const tokenCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
//# sourceMappingURL=ai-provider.js.map