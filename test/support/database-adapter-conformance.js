import test from "node:test";

import { DATABASE_ADAPTER_ENGINES } from "./database-adapter-engines.js";

// The one execution path for the Database adapter conformance specification (ADR-0035).
//
// ADR-0035 requires one behavioural specification executed once per engine. The specification's
// cases are grouped into per-surface modules so that separate coverage can be added to separate
// surfaces without two authors editing the same list, but every one of those modules runs its
// cases through this function. Engine iteration and the Postgres gate therefore exist in exactly
// one place: a surface cannot choose its engines, cannot skip one, and cannot reach a case that
// runs on some adapters and not others. Sibling modules that iterated engines themselves would be
// precisely the per-engine drift ADR-0035 exists to prevent.
//
// Each surface is run with its own adapter instance and its own prepared storage, so a case added
// to one surface cannot perturb a case on another through rows left behind.
//
// - `title` names the run; the engine name is appended to it, so a surface reads as
//   `<title>: SQLite`. Surfaces added later distinguish themselves here.
// - `appTableNames` declares the app tables the surface migrates, so the Postgres schema reset
//   drops them before the run.
// - `prepareStorage` seeds the storage state the surface's cases read, once per engine.
// - `cases` are `{ name, run(adapter) }` entries, each executed as a subtest of the engine's test.
export function runDatabaseAdapterConformance({ title, appTableNames = [], prepareStorage, cases }) {
  for (const engine of DATABASE_ADAPTER_ENGINES) {
    test(`${title}: ${engine.name}`, { skip: engine.skip }, async (t) => {
      await engine.withAdapter(
        async (adapter) => {
          if (prepareStorage) {
            await prepareStorage(adapter);
          }
          for (const conformanceCase of cases) {
            await t.test(conformanceCase.name, async () => {
              await conformanceCase.run(adapter);
            });
          }
        },
        { appTableNames },
      );
    });
  }
}
