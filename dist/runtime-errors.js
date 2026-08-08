// The Capsule runtime's error constructor, the shape every runtime helper attaches its extra fields
// to, and the JSON-compatibility check that only ever throws one.
//
// This is not a domain. It is here because these are the things every domain needs and no domain
// owns: `commandError` has 153 call sites — 76 in the auth domain and 77 still spread across jobs,
// storage, ACL, HTTP and the adapters — and a migrated module may not import from the monolith.
//
// Batch 3 hit that first. Closing the auth domain's reference graph leaves exactly four things
// outside it: the HTTP layer, `enqueueRuntimeJob`, `migrateAnonymousPreferences`, and this. The
// first three are later batches and the fourteen auth functions that reach them stayed behind for
// that reason. This one is not a later batch and never will be, and with it left behind the auth
// module would have been 73 functions instead of 104, 64 of them exported, with the domain cut down
// the middle — so it is a module of its own rather than a guest of the first domain that needed it.
// Batches 4 to 8 will each reach it in turn.
//
// Nothing is redesigned here. `commandError` is byte-identical to the declaration that stood at
// `server-runtime-source.ts:5038`, and `HelperError` to the type at line 86; the monolith imports
// both back and every call site in the repository is untouched.
export function commandError(message, hint, code = null) {
    const error = new Error(message);
    error.hint = hint;
    if (code) {
        error.code = code;
    }
    return error;
}
// The JSON-compatibility check, here for the same reason `commandError` is and found the same way.
//
// Batch 4 closed the jobs and schedules domain's reference graph and this was one of three things
// left outside it. The other two are `createMutationContext` and `hasPrivilegedDbAccess`, which are
// the composition core and batch 6's ACL — later work, and the seventeen job and schedule functions
// that reach them stayed behind for that reason. This one is not later work. It has thirteen call
// sites and exactly one of them is a Job: the rest are schema field defaults, field serialization,
// user preferences, queries, mutations and app messages. It belongs to no domain, so leaving it in
// the monolith would have kept `boundedJobJson` — the function that bounds every Job payload,
// result and failure — out of the module that owns Jobs, which is the domain cut down the middle
// that this module exists to prevent.
//
// `assertJsonCompatible` does nothing but throw `invalidJsonFieldValueError`, and that is a
// `commandError` factory, so the pair is cohesive with what is already here rather than a second
// concern smuggled in. Both are byte-identical to the declarations that stood at
// `server-runtime-source.ts:7084` and `:7100`, and both were entries in
// `SERVER_RUNTIME_SOURCE_FUNCTIONS` that left it in the same commit — a name carried as module text
// *and* listed there is declared twice at the top level of an ES module, which is a load-time
// `SyntaxError` in a deployed Capsule.
export function assertJsonCompatible(value) {
    let context;
    try {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
            throw invalidJsonFieldValueError();
        }
        JSON.parse(serialized);
    }
    catch (error) {
        if (error?.hint) {
            throw error;
        }
        throw invalidJsonFieldValueError();
    }
}
// Private, and this is the first name in this module that gets to be. Nothing outside
// `assertJsonCompatible` has ever called it, but under the emitted list it was an entry in
// `SERVER_RUNTIME_SOURCE_FUNCTIONS` all the same — a helper of a registered function had to be
// registered too or it was a `ReferenceError` in a deployed Capsule. Carried as module text it is
// simply in the file, so the registration goes away and so does the reachability it bought
// five hundred unrelated runtime functions. It is still a census subject in
// `test/database-adapter-engine-seam.test.js`, which reads declarations rather than exports for
// exactly this reason.
function invalidJsonFieldValueError() {
    return commandError("Invalid JSON field value.", "Use only JSON-compatible values: objects, arrays, strings, numbers, booleans, or null.");
}
//# sourceMappingURL=runtime-errors.js.map