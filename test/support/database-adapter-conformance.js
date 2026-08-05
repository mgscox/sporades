import { readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DATABASE_ADAPTER_ENGINES } from "./database-adapter-engines.js";

// The one execution path for the Database adapter conformance specification (ADR-0035).
//
// ADR-0035 requires one behavioural specification executed once per engine. The specification's
// cases are grouped into per-surface modules under `conformance-surfaces/` so that separate
// coverage can be added to separate surfaces without two authors editing the same list, but every
// one of those modules runs its cases through this function. Engine iteration and the Postgres
// gate therefore exist in exactly one place: a surface cannot choose its engines, cannot skip one,
// and cannot reach a case that runs on some adapters and not others. Sibling modules that iterated
// engines themselves would be precisely the per-engine drift ADR-0035 exists to prevent.
//
// A surface is a module, not a test file, because the method coverage check in
// `test/database-adapter-conformance-coverage.test.js` has to replay every surface's cases against
// an instrumented adapter to see which Database adapter methods the specification actually
// exercises. Importing a test file to do that would register its tests a second time, so the cases
// live in plain modules that both the per-surface test entry points and the coverage check import.
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

const SURFACES_DIRECTORY = new URL("./conformance-surfaces/", import.meta.url);

// Every surface module in `conformance-surfaces/`, discovered rather than listed, so adding a
// surface stays an additive change to a directory instead of an edit to a shared array that two
// authors would collide on. The coverage check reads the same list, which is what makes "every
// method has a conformance case" a question about the whole specification rather than about
// whichever surfaces someone remembered to name.
export async function loadDatabaseAdapterConformanceSurfaces() {
  const fileNames = (await readdir(fileURLToPath(SURFACES_DIRECTORY))).filter((name) => name.endsWith(".js")).sort();
  const surfaces = [];
  for (const fileName of fileNames) {
    const module = await import(new URL(fileName, SURFACES_DIRECTORY).href);
    const surface = module.CONFORMANCE_SURFACE;
    if (!surface) {
      throw new Error(`Conformance surface ${fileName} does not export CONFORMANCE_SURFACE.`);
    }
    surfaces.push({ fileName, ...surface });
  }
  return surfaces;
}
