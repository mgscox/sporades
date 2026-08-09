// The runtime's sync/async bridge: the three helpers that let one method body serve a synchronous
// SQLite engine and an asynchronous Postgres or libSQL one without being written twice.
//
// **This is not a domain, and it is here for the reason `runtime-errors.ts` is.** These are things
// several domains need and none owns. Closing the file and object storage domain's reference graph
// (batch 6 of the migration ADR-0041 records) leaves exactly four things outside it: the HTTP
// response writers, `createSharedDatabaseAdapterMethods`, the dialect's `addMissingColumn`, and
// this. The first three belong to batches 8 and 9 and the storage functions that reach them stayed
// behind for that reason. This one belongs to no batch:
//
//   isPromiseLike      the adapters, the log sink, four ACL paths, the SQLite dialect
//   thenIfPromise      the adapters, the log index, schema migration, the table API, storage
//   chainMaybePromise  the adapters, schema migration, the auth tables, storage
//
// Six domains between them — adapters, ACL, logging, schema, auth and storage — which is
// `commandError`'s shape at a smaller scale. A migrated module may not import from the monolith, so
// leaving these behind would have kept `singleLiveFileRowByPath` and `createFileStorageTables` out
// of the module that owns files, and through them `resolveLiveFileReference`, `createPendingFileUpload`
// and both URL paths: the whole upload lifecycle on the wrong side of the boundary. That is the
// domain cut down the middle which `runtime-errors.ts` exists to prevent, so batch 6 does what
// batch 3 did rather than accepting it.
//
// A separate module rather than three more functions in `runtime-errors.ts`, because that module is
// named for errors and `assertJsonCompatible` was admitted to it on an argument about cohesion —
// it does nothing but throw an error factory that already lived there. Nothing about chaining a
// maybe-promise is cohesive with that, and a file whose name stops describing its contents is a
// cost paid by every later reader.
//
// **Nothing is redesigned.** All three bodies are byte-identical to the declarations that stood at
// `server-runtime-source.ts:6362`, `:6366` and `:6370`, every call site in the repository is
// untouched, and the monolith imports all three back.
//
// All three are exported, so this module has no private function and its census sentinel in
// `test/database-adapter-engine-seam.test.js` is `isPromiseLike` — an exported one, as
// `mail-config.js`'s is. It is the right choice for the same reason that one is: both other
// functions here are defined in terms of it, so no honest edit to this module removes it.

export function isPromiseLike(value: any) {
  return value && typeof value === "object" && typeof value.then === "function";
}

export function thenIfPromise(value: any, onResolved: (value: any) => any) {
  return isPromiseLike(value) ? value.then(onResolved) : onResolved(value);
}

export function chainMaybePromise(steps: any[]) {
  let pending = null;
  for (const step of steps) {
    if (pending) {
      pending = pending.then(step);
      continue;
    }
    const result = step();
    if (isPromiseLike(result)) {
      pending = result;
    }
  }
  return pending ?? undefined;
}
