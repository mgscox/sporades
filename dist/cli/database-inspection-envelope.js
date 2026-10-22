export const DATABASE_INSPECTION_ACTIONS = ["db.list", "db.dump", "db.query"];
// The Bundle refuses `--sporades-action-input` over 24 KiB of base64url, so SQL whose encoded
// input is larger could not reach the read-only gate in one piece. Measuring the encoded form, not
// the raw SQL, keeps heavily escaped SQL from passing here and failing as malformed input there.
const DATABASE_INSPECTION_INPUT_BYTE_LIMIT = 24 * 1024;
export function encodeDatabaseInspectionInput(sql) {
    const encoded = Buffer.from(JSON.stringify({ sql }), "utf8").toString("base64url");
    return encoded.length <= DATABASE_INSPECTION_INPUT_BYTE_LIMIT ? encoded : null;
}
// A dump answers with every inspectable row, so its frame is bounded by the Capsule's data rather
// than by Sporades. This is the ceiling on what one SSH or `docker exec` hop will buffer.
export const DATABASE_INSPECTION_MAX_BUFFER = 128 * 1024 * 1024;
export function isDatabaseInspectionAction(action) {
    return DATABASE_INSPECTION_ACTIONS.includes(action);
}
export function sanitizeDatabaseInspectionEnvelope(action, envelope, invalid) {
    const data = envelope?.data;
    if (envelope?.ok === true && data && typeof data === "object" && !Array.isArray(data)) {
        if (action === "db.query" && Array.isArray(data.columns) && Array.isArray(data.rows)) {
            return { ok: true, data: { columns: data.columns, rows: data.rows }, error: null };
        }
        if (action !== "db.query" && Array.isArray(data.tables)) {
            return { ok: true, data: { tables: data.tables }, error: null };
        }
    }
    if (envelope?.ok === false && typeof envelope.error?.message === "string") {
        return {
            ok: false,
            data: null,
            error: {
                message: envelope.error.message,
                hint: typeof envelope.error.hint === "string" ? envelope.error.hint : "Check the SQL and retry the command.",
            },
        };
    }
    return invalid();
}
//# sourceMappingURL=database-inspection-envelope.js.map