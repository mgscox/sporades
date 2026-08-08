// How a Capsule value and a stored column convert into each other, in both directions: the Boolean,
// Json, Number and Date columns that are stored as something else and have to be turned back.
//
// **This file was `stored-row-decoding.ts` and held only the reading half.** Batch 9 brought the
// writing half to sit beside it and renamed the file, because a module named for decoding that also
// encodes is exactly the "file whose name stops describing its contents" the paragraph below refuses
// to create. One subject, both directions, one name that says so. See "Why the encoding half is
// here" below for what made the question live.
//
// **This is not a domain, and it is here for the reason `runtime-errors.ts` and `maybe-promise.ts`
// are.** These are things several domains need and none owns. Closing the ACL and privileged-audit
// domain's reference graph (batch 7 of the migration ADR-0041 records) leaves five things outside
// it, and three of them belong to no batch on that ticket's list. This is one: `deserializeRow` is
// what `ctx.acl.db.get()` answers with, and its other three callers — `createEndpointTableApi`,
// `runInsertMutation` and `runUpdateMutation` — are the endpoint and mutation layers.
//
// A migrated module may not import from the monolith, so leaving it behind would have kept
// `createAclDbHelpers` out of the module that owns ACL, and with it `createAclHelpers`,
// `createTableAclContext`, `runTableWriteWithAcl`, `applyReadAcl` and `filterRowsByReadAcl` — the
// whole enforcement path, and `ACL_HELPER_STATE` with it, because `createAclHelpers` is the only
// writer of that key. That is the domain cut down the middle which batch 3 made `runtime-errors.ts`
// to prevent and batch 6 made `maybe-promise.ts` to prevent, so batch 7 does the same rather than
// accepting it.
//
// **Why `deserializeFieldValue` travels with `deserializeRow` when only the second is a blocker.**
// They are one rule written at two granularities: `deserializeRow` inlines exactly the Boolean,
// Json and Number branches `deserializeFieldValue` spells out, because under the emitted list a
// function reached the bundle as its own source text and a helper it called had to be registered
// too — the constraint ADR-0038 records as having produced five copies of one set of rules in the
// inspection gate. Splitting the pair across a module boundary would leave the two copies further
// apart than the single file already had them, which is the opposite of what this migration is for.
// Together in one file a reader sees both, and the next edit to the decoding rules has one place to
// look. Their callers are untouched: the monolith imports both back.
//
// Named for what it holds rather than folded into an existing shared module. `runtime-errors.ts` is
// named for errors and `maybe-promise.ts` for the sync/async bridge; nothing about converting a
// stored column is cohesive with either, and a file whose name stops describing its contents is a
// cost paid by every later reader.
//
// **Why the encoding half is here, and what made the question live.** Batch 9 moves the Database
// adapters and dialect, and `toSqlLiteral` — which renders a JavaScript value as SQL literal text
// for `postgresInterpolate` and for a column's DDL default — reaches `normalizeDateValue` for its
// Date branch. So `normalizeDateValue` and `dateValueError` had to leave the monolith or the whole
// adapter domain stayed in it. The minimum move was those two.
//
// Taking two would have split the writing rule across a module boundary: `serializeFieldValue` is
// the one place a Capsule value becomes a stored column, and its Date branch *is* `normalizeDateValue`.
// That is the same split the paragraph above refuses for `deserializeRow`/`deserializeFieldValue`,
// so the whole writing half came instead — `serializeFieldValue` with `toSqlNumber` and
// `normalizeDateValue` with `dateValueError`. What arrives is the mirror of what was already here:
// Boolean to 1/0 against `Boolean()`, `JSON.stringify` against `JSON.parse`, `toSqlNumber` against
// `Number()`. Reading one branch now means reading its opposite on the same screen.
//
// `toSqlLiteral` itself did *not* come. It renders statement *text* rather than a bound value —
// quoting, escaping, `NULL` — and all three of its callers are the adapter and dialect module, so it
// travels with them and imports `normalizeDateValue` from here.
//
// **Nothing is redesigned.** Every body is byte-identical to the declaration it moved from, and
// every call site in the repository is untouched: the monolith imports back the two names it still
// resolves.
//
// Two of the six are private — `toSqlNumber`, which nothing but `serializeFieldValue` has ever
// called, and `dateValueError`, which nothing but `normalizeDateValue` has. Both were entries in
// `SERVER_RUNTIME_SOURCE_FUNCTIONS` all the same, because under the emitted list a helper of a
// registered function had to be registered too or it was a `ReferenceError` in a deployed Capsule.
// The census sentinel in `test/database-adapter-engine-seam.test.js` stays `deserializeRow` rather
// than moving to one of the two new private names: it is the function this module exists for and the
// one the ACL helpers reach, so no honest edit removes it, and the entry's floor rose with the file.
import { assertJsonCompatible, commandError } from "./runtime-errors.js";
export function deserializeFieldValue(field, value) {
    if (field.kind === "Boolean") {
        return value === null ? null : Boolean(value);
    }
    if (field.kind === "Json") {
        return value === null ? null : JSON.parse(value);
    }
    if (field.kind === "Number") {
        return value === null ? null : Number(value);
    }
    return value;
}
export function deserializeRow(table, row) {
    const output = { ...row };
    for (const field of table.fields) {
        if (field.kind === "Boolean") {
            output[field.name] = output[field.name] === null ? null : Boolean(output[field.name]);
        }
        else if (field.kind === "Json") {
            output[field.name] = output[field.name] === null ? null : JSON.parse(output[field.name]);
        }
        if (field.kind === "Number") {
            output[field.name] = output[field.name] === null ? null : Number(output[field.name]);
        }
    }
    return output;
}
// The writing half, arriving in batch 9. The mirror of the two above: where `deserializeFieldValue`
// turns a stored column into the value a Capsule author sees, this turns that value into what the
// column holds. `undefined` becomes `null` before the Json branch runs, so a field that was never
// supplied is stored as SQL NULL rather than refused as unserializable.
export function serializeFieldValue(field, value) {
    if (value === undefined) {
        return null;
    }
    if (field?.kind === "Json") {
        assertJsonCompatible(value);
        return JSON.stringify(value);
    }
    if (value === null) {
        return null;
    }
    if (field?.kind === "Boolean") {
        return value ? 1 : 0;
    }
    if (field?.kind === "Number") {
        return toSqlNumber(value, field.name);
    }
    if (field?.kind === "Date") {
        return normalizeDateValue(value, field.name);
    }
    if (field?.kind === "Reference") {
        return String(value);
    }
    return String(value ?? "");
}
// Every Date column is stored as an ISO 8601 string on every engine, so the two accepted input
// shapes are collapsed here rather than at each call site. Exported because it has four callers:
// `serializeFieldValue` above, the schema extractor's date default and the parsed field default
// still in the monolith, and `toSqlLiteral` in `database-runtime.ts` — the fourth being the one that
// made this function's location a question worth answering.
export function normalizeDateValue(value, fieldName) {
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
            throw dateValueError(fieldName);
        }
        return value.toISOString();
    }
    if (typeof value !== "string") {
        throw dateValueError(fieldName);
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw dateValueError(fieldName);
    }
    return parsed.toISOString();
}
// Private. Nothing but `serializeFieldValue` has ever called it, and under the emitted list it was
// an entry all the same — the thing that list could not express.
function toSqlNumber(value, fieldName) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw commandError(`Invalid number for field: ${fieldName}`, "Pass a finite JavaScript number for Number() fields.");
    }
    return value;
}
// Private, for the same reason: `normalizeDateValue` is its only caller, in all three of that
// function's rejection branches.
function dateValueError(fieldName) {
    return commandError(`Invalid date value for field: ${fieldName}`, "Pass an ISO 8601 date string or JavaScript Date value.");
}
//# sourceMappingURL=stored-value-coding.js.map