const FORBIDDEN_KEYS = new Set(["selector", "verifier", "verifierDigest", "token", "tokenFragment", "ownerEmail", "ownerDisplayName"]);
export function sanitizeAccessKeyOperatorEnvelope(value, invalid) {
    let encoded;
    try {
        encoded = JSON.stringify(value);
    }
    catch {
        return invalid();
    }
    if (Buffer.byteLength(encoded, "utf8") > 256 * 1024)
        return invalid();
    const visit = (candidate) => {
        if (candidate === null || ["string", "number", "boolean"].includes(typeof candidate))
            return true;
        if (Array.isArray(candidate))
            return candidate.length <= 100 && candidate.every(visit);
        if (!candidate || typeof candidate !== "object")
            return false;
        return Object.entries(candidate).every(([key, child]) => !FORBIDDEN_KEYS.has(key) && visit(child));
    };
    if (!visit(value) || !value || typeof value !== "object" || typeof value.ok !== "boolean")
        return invalid();
    const envelope = value;
    if (envelope.ok) {
        if (!envelope.data || typeof envelope.data !== "object" || envelope.error !== null)
            return invalid();
    }
    else if (!envelope.error || typeof envelope.error.message !== "string" || typeof envelope.error.hint !== "string") {
        return invalid();
    }
    return envelope;
}
//# sourceMappingURL=access-key-operator-envelope.js.map