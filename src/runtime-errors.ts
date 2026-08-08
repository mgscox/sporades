// The Capsule runtime's error constructor, and the shape every runtime helper attaches its extra
// fields to.
//
// This is not a domain. It is here because it is the one thing every domain needs and no domain
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

export type HelperError = Error & {
  code?: string;
  hint?: string;
  sporadesAclDenialLogData?: any;
  sporadesAuthDenialLogData?: any;
  sporadesEndpointResponse?: boolean;
};

export function commandError(message: string | undefined, hint: string, code: string | null = null) {
  const error: HelperError = new Error(message);
  error.hint = hint;
  if (code) {
    error.code = code;
  }
  return error;
}
