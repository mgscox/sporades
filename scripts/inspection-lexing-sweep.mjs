// Differential sweep for the read-only inspection gate (ADR-0038).
//
// Not part of `npm test`: it needs a live Postgres and takes minutes. It exists because the figures
// quoted in ADR-0038 have to be reproducible by someone who does not trust them, and because three
// separate rounds of this work reported "zero findings" from a generator that could not emit the
// shape it was reporting zero about.
//
// What it does, in the order that matters:
//
//   1. Builds a corpus of comment- and whitespace-shaped prefixes over a piece alphabet, and
//      **asserts the corpus can emit each shape that has previously defeated this gate** before any
//      result is read. A sweep that cannot produce the dangerous input answers clean for the wrong
//      reason.
//   2. Takes every candidate the gate ADMITS and executes it raw against Postgres, past the
//      `columns()` wrap — which is what happens the moment `columns()` and `all()` are reordered,
//      `columns()` stops wrapping, or an engine with a native `columns()` arrives. The wrap is not
//      the boundary and must not be what a clean result depends on.
//   3. Watches two things per payload, so that any non-`SELECT` first token is observable and not
//      only a destructive one: a canary table that must keep its row, and a probe table that must
//      never come into existence.
//   4. Does all of that on **every engine**, which is a correction rather than a flourish. An
//      earlier version of this script executed on Postgres alone and reported zero for the
//      line-comment class — a class that is dangerous precisely because SQLite and libSQL run the
//      second statement while Postgres answers a syntax error. An oracle that cannot observe the
//      defect is the same failure as a generator that cannot emit it.
//
// Usage:
//   export SPORADES_POSTGRES_TEST_URL="postgres://sporades:sporades@127.0.0.1:55432/sporades_w17"
//   node scripts/inspection-lexing-sweep.mjs
//
// Optional: SPORADES_SWEEP_BASELINE=/abs/path/to/another/server-runtime-source.js compares verdicts
// against a second build and executes what only the baseline admitted, which is how a fix is shown
// to close a class rather than merely to refuse the one payload in the bug report.

import { pathToFileURL } from "node:url";

const HERE = new URL(".", import.meta.url);
const CURRENT = new URL("../dist/server-runtime-source.js", HERE);
const ENGINES = new URL("../test/support/database-adapter-engines.js", HERE);

const { validateReadOnlyInspectionSql } = await import(CURRENT.href);
const { withSqliteAdapter, withLibsqlAdapter, withPostgresAdapter } = await import(ENGINES.href);
const baseline = process.env.SPORADES_SWEEP_BASELINE
  ? await import(pathToFileURL(process.env.SPORADES_SWEEP_BASELINE).href)
  : null;

const PIECES = ["/*", "*/", "/*/", "**/", "--", "\r", "\n", " ", " SELECT 1 "];
const MAX_DEPTH = Number(process.env.SPORADES_SWEEP_DEPTH ?? 5);
const TAILS = [
  " TRUNCATE TABLE sporades_sweep_canary",
  " DO $z$ BEGIN EXECUTE 'DELETE FROM sporades_sweep_canary'; END $z$",
  " CREATE TABLE sporades_sweep_probe (id int)",
  "; DROP TABLE sporades_sweep_canary",
];

const corpus = [];
const build = (depth, acc) => {
  if (depth === 0) {
    for (const tail of TAILS) corpus.push(acc + tail);
    return;
  }
  for (const piece of PIECES) build(depth - 1, acc + piece);
};
for (let depth = 1; depth <= MAX_DEPTH; depth += 1) build(depth, "");

// Adequacy, before anything is believed. Each entry is the shape of a defect this gate has actually
// shipped; if the generator stops being able to express one, that is a broken sweep, not a pass.
const MUST_EMIT = [
  ["a nesting shape", (sql) => sql.startsWith("/*/* SELECT 1 */*/")],
  ["a `/*/` straddle shape", (sql) => sql.startsWith("/*/*/ SELECT 1 */*/")],
  ["a line comment closed by a bare CR", (sql) => /--[^\n]*\r/.test(sql)],
  ["a line comment composed with a block comment", (sql) => sql.includes("--") && sql.includes("\r") && sql.includes("/*")],
];
for (const [description, matches] of MUST_EMIT) {
  const found = corpus.find(matches);
  if (!found) throw new Error(`corpus cannot emit ${description} — the sweep would report clean for the wrong reason`);
  console.log(`corpus emits ${description}: ${JSON.stringify(found)}`);
}

const admitted = corpus.filter((sql) => validateReadOnlyInspectionSql(sql).ok);
const baselineAdmitted = baseline ? corpus.filter((sql) => baseline.validateReadOnlyInspectionSql(sql).ok) : [];
const newlyAdmitted = baseline ? admitted.filter((sql) => !baseline.validateReadOnlyInspectionSql(sql).ok) : [];

console.log(`\ncandidates:          ${corpus.length}`);
console.log(`admitted:            ${admitted.length}`);
if (baseline) {
  console.log(`admitted (baseline): ${baselineAdmitted.length}`);
  console.log(`newly admitted:      ${newlyAdmitted.length}`);
}

const PROBE_EXISTS = {
  Postgres: "SELECT to_regclass('sporades_sweep_probe') AS t",
  SQLite: "SELECT name AS t FROM sqlite_schema WHERE name = 'sporades_sweep_probe'",
  libSQL: "SELECT name AS t FROM sqlite_schema WHERE name = 'sporades_sweep_probe'",
};

const SWEEP_ENGINES = [
  ["SQLite", withSqliteAdapter],
  ["libSQL", withLibsqlAdapter],
  ["Postgres", withPostgresAdapter],
];

// SQLite's statement primitives answer values and the service engines' answer Promises — ADR-0034's
// dual-mode convention — so a bare `.catch()` is a TypeError on one engine and works on the others.
const quietly = async (fn) => {
  try {
    return await fn();
  } catch {
    return null;
  }
};

async function executeOn(engine, withAdapter, label, payloads) {
  let offending = 0;
  const examples = [];
  await withAdapter(
    async (adapter) => {
      await adapter.exec("CREATE TABLE sporades_sweep_canary (id TEXT PRIMARY KEY)");
      try {
        for (const sql of payloads) {
          await quietly(() => adapter.exec("DELETE FROM sporades_sweep_canary"));
          await quietly(() => adapter.exec("INSERT INTO sporades_sweep_canary (id) VALUES ('alive')"));
          await quietly(() => adapter.exec(sql));
          const probed = (await quietly(() => adapter.prepare(PROBE_EXISTS[engine]).all())) ?? [];
          if (probed[0]?.t) await quietly(() => adapter.exec("DROP TABLE sporades_sweep_probe"));
          const rows = (await quietly(() => adapter.prepare("SELECT id FROM sporades_sweep_canary").all())) ?? [];
          if (rows.length !== 1 || probed[0]?.t) {
            offending += 1;
            if (examples.length < 5) examples.push(sql);
            // The canary may be gone; rebuild so the next payload is measured against a clean state.
            await quietly(() => adapter.exec("CREATE TABLE IF NOT EXISTS sporades_sweep_canary (id TEXT PRIMARY KEY)"));
          }
        }
      } finally {
        await quietly(() => adapter.exec("DROP TABLE IF EXISTS sporades_sweep_canary"));
        await quietly(() => adapter.exec("DROP TABLE IF EXISTS sporades_sweep_probe"));
      }
    },
    { appTableNames: ["sporades_sweep_canary", "sporades_sweep_probe"] },
  );
  console.log(`  ${engine.padEnd(9)} ${payloads.length} executed, ${offending} with an effect a SELECT cannot have`);
  for (const sql of examples) console.log("    OFFENDING:", JSON.stringify(sql));
  return offending;
}

async function execute(label, payloads) {
  console.log(`\n${label}:`);
  let offending = 0;
  for (const [engine, withAdapter] of SWEEP_ENGINES) {
    offending += await executeOn(engine, withAdapter, label, payloads);
  }
  return offending;
}

const offending = await execute("admitted by this build", admitted);
if (baseline) {
  await execute("admitted only by the baseline", baselineAdmitted.filter((sql) => !validateReadOnlyInspectionSql(sql).ok));
  await execute("newly admitted by this build", newlyAdmitted);
}

process.exitCode = offending === 0 ? 0 : 1;
