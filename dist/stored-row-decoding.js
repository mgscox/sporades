// How a value read back out of a Database engine becomes the value a Capsule author sees: the
// Boolean, Json and Number columns that are stored as something else and have to be turned back.
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
// named for errors and `maybe-promise.ts` for the sync/async bridge; nothing about decoding a
// stored column is cohesive with either, and a file whose name stops describing its contents is a
// cost paid by every later reader.
//
// **Nothing is redesigned.** Both bodies are byte-identical to the declarations that stood at
// `server-runtime-source.ts:5646` and `:5683`, and every call site in the repository is untouched.
//
// Both are exported, because the monolith resolves both, so this module has no private function and
// its census sentinel in `test/database-adapter-engine-seam.test.js` is `deserializeRow` — an
// exported one, as `mail-config.js`'s and `maybe-promise.js`'s are. It is the right choice for the
// reason those are: it is the function this module exists for and the one the ACL helpers reach, so
// no honest edit to this file removes it.
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
//# sourceMappingURL=stored-row-decoding.js.map