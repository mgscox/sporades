import { createInterface } from "node:readline/promises";
import { ACCESS_KEY_SCOPE_BYTE_LIMIT, ACCESS_KEY_SCOPE_LIMIT } from "../auth-admission.js";
import { ACCESS_KEY_GRANT_BYTE_LIMIT, ACCESS_KEY_GRANT_LIMIT } from "../access-key-contract.js";
export const ACCESS_KEY_OPERATOR_ACTIONS = [
    "access-keys.list", "access-keys.inspect", "access-keys.revoke", "access-keys.revoke-all", "access-keys.delete",
];
const ACTIONS = new Set(ACCESS_KEY_OPERATOR_ACTIONS);
const STATUSES = new Set(["active", "expired", "revoked"]);
const REVOCATION_CAUSES = new Set([
    "owner", "operator", "password-reset", "owner-unlinked", "owner-deleted",
    "service-user-administrator", "service-user-disabled",
]);
const ACCESS_KEY_OPERATOR_LIST_PAGE_LIMIT = 100;
const JSON_STRING_MAX_BYTE_EXPANSION = 6;
const ACCESS_KEY_OPERATOR_ENVELOPE_STRUCTURAL_HEADROOM = 8 * 1024 * 1024;
// JSON escapes a one-byte control character as six ASCII bytes (for example NUL as \u0000).
// Bound the maximum list page using the public scope/grant cardinalities and byte limits: every
// key can repeat the full effective-scope vocabulary and grants, and declaredScopes repeats the
// vocabulary once more. The fixed headroom covers every other bounded field and JSON structure.
export const ACCESS_KEY_OPERATOR_ENVELOPE_BYTE_LIMIT = JSON_STRING_MAX_BYTE_EXPANSION * (((ACCESS_KEY_OPERATOR_LIST_PAGE_LIMIT + 1) * ACCESS_KEY_SCOPE_LIMIT * ACCESS_KEY_SCOPE_BYTE_LIMIT)
    + (ACCESS_KEY_OPERATOR_LIST_PAGE_LIMIT * ACCESS_KEY_GRANT_LIMIT * ACCESS_KEY_GRANT_BYTE_LIMIT)) + ACCESS_KEY_OPERATOR_ENVELOPE_STRUCTURAL_HEADROOM;
export const ACCESS_KEY_OPERATOR_PROCESS_MAX_BUFFER = ACCESS_KEY_OPERATOR_ENVELOPE_BYTE_LIMIT + 1024 * 1024;
const SAFE_ERRORS = {
    UNAUTHENTICATED: { message: "Authentication is required.", hint: "Use an authorized Session and retry the operation." },
    FORBIDDEN: { message: "Access-key operation is forbidden.", hint: "Use an authorized operator context." },
    ACCESS_KEY_DELETE_REQUIRES_REVOKED: { message: "Access key must be revoked before deletion.", hint: "Revoke the key, then delete its history." },
    ACCESS_KEY_LIMIT_REACHED: { message: "Access-key limit reached.", hint: "Retire an existing key before retrying." },
    ACCESS_KEY_NAME_CONFLICT: { message: "Access-key name is already in use.", hint: "Choose a unique name." },
    ACCESS_KEY_NOT_ACTIVE: { message: "Access key is not active.", hint: "Inspect current metadata before retrying." },
    ACCESS_KEY_NOT_FOUND: { message: "Access key was not found.", hint: "Refresh metadata and use an exact immutable key ID." },
    ACCESS_KEY_REVISION_CONFLICT: { message: "Access-key revision changed.", hint: "Refresh metadata and retry." },
    ACCESS_KEY_SECRET_CONFLICT: { message: "Access-key generation conflicted.", hint: "Retry the operation." },
    INVALID_ACCESS_KEY_EXPIRY: { message: "Access-key expiry is invalid.", hint: "Use a valid future expiry." },
    INVALID_ACCESS_KEY_GRANTS: { message: "Access-key grants are invalid.", hint: "Use the Capsule's declared scope vocabulary." },
    INVALID_ACCESS_KEY_LIST_OPTIONS: { message: "Access-key list options are invalid.", hint: "Use supported cursor, limit, and status filters." },
    INVALID_ACCESS_KEY_NAME: { message: "Access-key name is invalid.", hint: "Use a valid unique name." },
    INVALID_ACCESS_KEY_ACTION_INPUT: { message: "Invalid Access-key operator action input.", hint: "Upgrade the Sporades CLI and generated Bundle together." },
    ACCESS_KEY_ACTION_UNSUPPORTED: { message: "Unsupported Access-key operator action.", hint: "Upgrade the Sporades CLI and generated Bundle together." },
    ACCESS_KEY_ACTION_FAILED: { message: "Access-key operator action failed.", hint: "Check the Privileged audit events and retry the operation." },
    HOST_HELPER_UPGRADE_REQUIRED: { message: "The Host helper does not support this Access-key action.", hint: "Upgrade the Host helper, redeploy the Capsule, and retry." },
    HOSTED_CAPSULE_NOT_RUNNING: { message: "The Hosted Capsule is not running.", hint: "Start the Hosted Capsule, then retry the operation." },
    HOSTED_ACCESS_KEY_RESPONSE_INVALID: { message: "Hosted Access-key action returned an invalid response.", hint: "Upgrade the Host helper, redeploy the Capsule, and retry." },
};
export async function confirmAccessKeyOperatorAction(options, io = { input: process.stdin, output: process.stdout }) {
    if (options.yes || ["list", "inspect"].includes(options.subcommand))
        return;
    if (!io.input?.isTTY || !io.output?.isTTY) {
        throw Object.assign(new Error("Destructive Access-key operation requires confirmation."), {
            hint: "Retry with `--yes` in non-interactive use.",
        });
    }
    const expected = options.subcommand === "revoke-all" ? options.userId : "yes";
    const prompt = options.subcommand === "revoke-all"
        ? `Type the owner ID ${options.userId} to revoke all current Access keys: `
        : `Type yes to ${options.subcommand} Access key ${options.keyId}: `;
    const readline = createInterface({ input: io.input, output: io.output });
    try {
        const answer = await readline.question(prompt);
        if (answer !== expected)
            throw Object.assign(new Error("Access-key operation cancelled."), {
                hint: "No Access-key state was changed.",
            });
    }
    finally {
        readline.close();
    }
}
function plain(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function exactKeys(value, required, optional = []) {
    const keys = Object.keys(value);
    return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}
function boundedString(value, maximum = 256) {
    return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum;
}
function optionalString(value, maximum = 512) {
    return value === null || boundedString(value, maximum);
}
function stringList(value, maximumItems, maximumItemBytes) {
    return Array.isArray(value) && value.length <= maximumItems
        && value.every((item) => boundedString(item, maximumItemBytes));
}
function optionalRevocationCause(value) {
    return value === null || (typeof value === "string" && REVOCATION_CAUSES.has(value));
}
function encodedWithinLimit(value, maximum) {
    try {
        return Buffer.byteLength(JSON.stringify(value), "utf8") <= maximum;
    }
    catch {
        return false;
    }
}
export function validateAccessKeyOperatorActionInput(action, value, invalid) {
    if (typeof action !== "string" || !ACTIONS.has(action) || !plain(value) || !encodedWithinLimit(value, 16 * 1024))
        return invalid();
    if (action === "access-keys.list") {
        if (!exactKeys(value, ["userId", "options"]) || !boundedString(value.userId) || !plain(value.options)
            || !exactKeys(value.options, [], ["cursor", "limit", "status"]))
            return invalid();
        const options = {};
        if (value.options.cursor !== undefined) {
            if (!boundedString(value.options.cursor, 512))
                return invalid();
            options.cursor = value.options.cursor;
        }
        if (value.options.limit !== undefined) {
            if (!Number.isInteger(value.options.limit) || value.options.limit < 1 || value.options.limit > 100)
                return invalid();
            options.limit = value.options.limit;
        }
        if (value.options.status !== undefined) {
            if (typeof value.options.status !== "string" || !STATUSES.has(value.options.status))
                return invalid();
            options.status = value.options.status;
        }
        return { userId: value.userId, options };
    }
    if (action === "access-keys.revoke-all") {
        if (!exactKeys(value, ["userId"]) || !boundedString(value.userId))
            return invalid();
        return { userId: value.userId };
    }
    if (!exactKeys(value, ["keyId"]) || !boundedString(value.keyId))
        return invalid();
    return { keyId: value.keyId };
}
function canonicalCapsule(value, invalid) {
    if (!plain(value) || !exactKeys(value, ["name"]) || !boundedString(value.name))
        return invalid();
    return { name: value.name };
}
function canonicalSummary(value, invalid) {
    const fields = ["id", "ownerUserId", "name", "grants", "effectiveScopes", "status", "createdAt", "expiresAt",
        "rotatedAt", "revokedAt", "revocationCause", "lastUsedAt", "lifecycleRevision"];
    if (!plain(value) || !exactKeys(value, fields) || !boundedString(value.id) || !boundedString(value.ownerUserId)
        || !boundedString(value.name, 512)
        || !stringList(value.grants, ACCESS_KEY_GRANT_LIMIT, ACCESS_KEY_GRANT_BYTE_LIMIT)
        || !stringList(value.effectiveScopes, ACCESS_KEY_SCOPE_LIMIT, ACCESS_KEY_SCOPE_BYTE_LIMIT)
        || typeof value.status !== "string" || !STATUSES.has(value.status) || !boundedString(value.createdAt, 64)
        || !optionalString(value.expiresAt, 64) || !optionalString(value.rotatedAt, 64) || !optionalString(value.revokedAt, 64)
        || !optionalRevocationCause(value.revocationCause) || !optionalString(value.lastUsedAt, 64)
        || !Number.isSafeInteger(value.lifecycleRevision) || value.lifecycleRevision < 1)
        return invalid();
    return Object.fromEntries(fields.map((field) => [field, value[field]]));
}
function canonicalSuccessData(action, value, input, invalid) {
    if (!plain(value))
        return invalid();
    const capsule = canonicalCapsule(value.capsule, invalid);
    if (action === "access-keys.list") {
        if (!exactKeys(value, ["capsule", "accessKeys", "declaredScopes", "nextCursor", "totalCount"])
            || !Array.isArray(value.accessKeys) || value.accessKeys.length > 100
            || !stringList(value.declaredScopes, ACCESS_KEY_SCOPE_LIMIT, ACCESS_KEY_SCOPE_BYTE_LIMIT)
            || !optionalString(value.nextCursor, 512) || !Number.isSafeInteger(value.totalCount) || value.totalCount < 0)
            return invalid();
        const accessKeys = value.accessKeys.map((item) => canonicalSummary(item, invalid));
        if (accessKeys.some((item) => item.ownerUserId !== input.userId))
            return invalid();
        return { capsule, accessKeys, declaredScopes: [...value.declaredScopes], nextCursor: value.nextCursor, totalCount: value.totalCount };
    }
    if (["access-keys.inspect", "access-keys.revoke"].includes(action)) {
        if (!exactKeys(value, ["capsule", "accessKey"]))
            return invalid();
        const accessKey = canonicalSummary(value.accessKey, invalid);
        if (accessKey.id !== input.keyId || (action === "access-keys.revoke" && accessKey.status !== "revoked"))
            return invalid();
        return { capsule, accessKey };
    }
    if (action === "access-keys.revoke-all") {
        if (!exactKeys(value, ["capsule", "ownerUserId", "revokedCount", "accessKeys"]) || value.ownerUserId !== input.userId
            || !Number.isSafeInteger(value.revokedCount) || value.revokedCount < 0 || !Array.isArray(value.accessKeys)
            || value.accessKeys.length > 100)
            return invalid();
        const accessKeys = value.accessKeys.map((item) => canonicalSummary(item, invalid));
        if (accessKeys.some((item) => item.ownerUserId !== input.userId || item.status !== "revoked"
            || item.revocationCause !== "operator") || accessKeys.length !== value.revokedCount)
            return invalid();
        return { capsule, ownerUserId: value.ownerUserId, revokedCount: value.revokedCount, accessKeys };
    }
    if (!exactKeys(value, ["capsule", "id", "ownerUserId", "deleted"]) || value.id !== input.keyId
        || !boundedString(value.ownerUserId) || value.deleted !== true)
        return invalid();
    return { capsule, id: value.id, ownerUserId: value.ownerUserId, deleted: true };
}
function canonicalError(value, invalid) {
    if (!plain(value) || !exactKeys(value, ["code", "message", "hint"]) || typeof value.code !== "string"
        || !SAFE_ERRORS[value.code] || !boundedString(value.message, 1024) || !boundedString(value.hint, 1024))
        return invalid();
    return { code: value.code, ...SAFE_ERRORS[value.code] };
}
export function sanitizeAccessKeyOperatorEnvelope(value, action, input, invalid) {
    // Names, IDs, and declared scopes are metadata vocabularies and may legitimately resemble a token.
    // Rebuild the envelope from action-specific allowlists instead of guessing provenance from string shape.
    if (!plain(value) || !encodedWithinLimit(value, ACCESS_KEY_OPERATOR_ENVELOPE_BYTE_LIMIT) || typeof value.ok !== "boolean")
        return invalid();
    const boundedInput = validateAccessKeyOperatorActionInput(action, input, invalid);
    if (value.ok) {
        if (!exactKeys(value, ["ok", "data", "error"]) || value.error !== null)
            return invalid();
        return { ok: true, data: canonicalSuccessData(String(action), value.data, boundedInput, invalid), error: null };
    }
    if (!exactKeys(value, ["ok", "data", "error"]) || value.data !== null)
        return invalid();
    return { ok: false, data: null, error: canonicalError(value.error, invalid) };
}
//# sourceMappingURL=access-key-operator-envelope.js.map